import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PNG } from "pngjs";
import { PROTOCOL_IDENTITY, REPORT_FORMAT_VERSION, type Report, type ReviewManifest, type ReviewState } from "@vqa/contract";
import { acquireReportWriterLock } from "./report-lock.js";
import { isLinkFreeExistingPath } from "./path-safety.js";

interface TransactionPaths {
  destination: string;
  parent: string;
  staging: string;
  lock: string;
  journal: string;
  backup: string;
}

interface Journal {
  schema_version: 1;
  destination: string;
  staging: string;
  backup: string;
  phase: "staging-valid" | "destination-backed-up" | "committed" | "validated";
}

const JOURNAL_KEYS = ["backup", "destination", "phase", "schema_version", "staging"] as const;
const JOURNAL_PHASES = new Set<Journal["phase"]>([
  "staging-valid",
  "destination-backed-up",
  "committed",
  "validated",
]);

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function durableWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!unsupportedDirectorySyncError((error as NodeJS.ErrnoException).code)) throw error;
  }
}

/** @internal Exported for platform-contract discrimination tests. */
export function unsupportedDirectorySyncError(
  code: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Windows does not provide POSIX directory fsync through Node. File handles
  // are still flushed; only the unsupported directory barrier is omitted.
  return ["EINVAL", "ENOTSUP", "EISDIR"].includes(code ?? "") || (platform === "win32" && code === "EPERM");
}

/** @internal Exported for platform-contract discrimination tests. */
export function reportFileSyncOpenFlag(platform: NodeJS.Platform = process.platform): "r" | "r+" {
  // FlushFileBuffers requires a write-capable handle on Windows even though
  // syncTree never changes the file bytes.
  return platform === "win32" ? "r+" : "r";
}

async function syncTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) {
      const handle = await open(path, reportFileSyncOpenFlag());
      try { await handle.sync(); } finally { await handle.close(); }
    } else {
      throw new Error(`report staging contains unsupported filesystem entry: ${path}`);
    }
  }
  await syncDirectory(root);
}

async function resolvedParent(destination: string): Promise<{ destination: string; parent: string }> {
  const absolute = resolve(destination);
  const parentPath = dirname(absolute);
  await mkdir(parentPath, { recursive: true });
  const parentStat = await lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`report destination parent must be a real directory: ${parentPath}`);
  }
  if (!await isLinkFreeExistingPath(parentPath)) {
    throw new Error(`report destination parent must not resolve through a symlink: ${parentPath}`);
  }
  const parent = parentPath;
  return { destination: join(parent, basename(absolute)), parent };
}

function siblingPaths(destination: string, parent: string): Omit<TransactionPaths, "staging"> {
  const name = basename(destination);
  return {
    destination,
    parent,
    lock: join(parent, `.${name}.vqa-transaction.lock`),
    journal: join(parent, `.${name}.vqa-transaction.json`),
    backup: join(parent, `.${name}.vqa-backup`),
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function validateCompletedReport(root: string): Promise<void> {
  const rootReal = resolve(root);
  if (!await isLinkFreeExistingPath(rootReal)) throw new Error("report root must not be a symlink");
  const report = JSON.parse(await readFile(join(root, "issues.json"), "utf8")) as Report;
  if (report.formatVersion !== REPORT_FORMAT_VERSION || report.tool !== PROTOCOL_IDENTITY) throw new Error("unsupported report metadata");
  const manifestBytes = await readFile(join(root, "review-manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReviewManifest;
  if (manifest.artifact_type !== "vq-review-manifest" || manifest.schema_version !== 1) throw new Error("unsupported review manifest");
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    if (ids.has(asset.id)) throw new Error(`duplicate asset id: ${asset.id}`);
    ids.add(asset.id);
    const path = resolve(root, asset.source_relative_path);
    if (!path.startsWith(`${rootReal}${sep}`)) throw new Error(`asset escapes report root: ${asset.id}`);
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink()) throw new Error(`asset is not a regular file: ${asset.id}`);
    const bytes = await readFile(path);
    const image = PNG.sync.read(bytes);
    if (bytes.byteLength !== asset.byte_length || sha256(bytes) !== asset.sha256 || image.width !== asset.width || image.height !== asset.height) {
      throw new Error(`asset integrity mismatch: ${asset.id}`);
    }
  }
  const state = JSON.parse(await readFile(join(root, "review-state.json"), "utf8")) as ReviewState;
  const manifestDigest = sha256(manifestBytes);
  if (state.artifact_type !== "vq-review-state" || state.schema_version !== 1 || state.manifest_id !== manifest.manifest_id || state.manifest_sha256 !== manifestDigest) {
    throw new Error("review state is not bound to the manifest");
  }
  if (Object.keys(state.captures).length !== manifest.captures.length || manifest.captures.some((capture) => !state.captures[capture.coordinate_id])) {
    throw new Error("review state capture inventory mismatch");
  }
  const html = await readFile(join(root, "report.html"), "utf8");
  if (!html.includes('id="vqa-manifest"') || html.includes("Approve fix")) throw new Error("report.html is not the approved manifest-backed GUI");
}

async function writeJournal(paths: TransactionPaths, phase: Journal["phase"]): Promise<void> {
  const journal: Journal = {
    schema_version: 1,
    destination: paths.destination,
    staging: paths.staging,
    backup: paths.backup,
    phase,
  };
  await durableWrite(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
}

async function validReport(path: string): Promise<boolean> {
  try { await validateCompletedReport(path); return true; } catch { return false; }
}

function invalidJournal(paths: Omit<TransactionPaths, "staging">, detail: string): Error {
  return new Error(
    `invalid report transaction journal requires operator inspection: ${paths.journal} (${detail})`,
  );
}

async function validateOwnedStaging(
  paths: Omit<TransactionPaths, "staging">,
  staging: string,
  mustExist: boolean,
): Promise<boolean> {
  const prefix = `.${basename(paths.destination)}.vqa-staging-`;
  const name = basename(staging);
  const suffix = name.slice(prefix.length);
  if (
    staging !== join(paths.parent, name) ||
    !name.startsWith(prefix) ||
    !/^[A-Za-z0-9]+$/u.test(suffix)
  ) {
    throw invalidJournal(paths, "staging path is not an owned canonical sibling");
  }
  if (!await exists(staging)) {
    if (mustExist) throw invalidJournal(paths, "owned staging directory is missing");
    return false;
  }
  const item = await lstat(staging);
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw invalidJournal(paths, "staging path is not a real directory");
  }
  if (!await isLinkFreeExistingPath(staging) || dirname(staging) !== paths.parent) {
    throw invalidJournal(paths, "staging realpath escapes the transaction parent");
  }
  return true;
}

async function readJournal(
  paths: Omit<TransactionPaths, "staging">,
): Promise<Journal> {
  const journalItem = await lstat(paths.journal);
  if (!journalItem.isFile() || journalItem.isSymbolicLink()) {
    throw invalidJournal(paths, "journal path is not a regular non-symlink file");
  }
  if (!await isLinkFreeExistingPath(paths.journal) || dirname(paths.journal) !== paths.parent) {
    throw invalidJournal(paths, "journal realpath escapes the transaction parent");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(paths.journal, "utf8"));
  } catch (error) {
    throw invalidJournal(paths, error instanceof Error ? error.message : String(error));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidJournal(paths, "journal must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\n") !== [...JOURNAL_KEYS].sort().join("\n")) {
    throw invalidJournal(paths, "journal fields do not match schema version 1");
  }
  if (
    record.schema_version !== 1 ||
    typeof record.destination !== "string" ||
    typeof record.staging !== "string" ||
    typeof record.backup !== "string" ||
    typeof record.phase !== "string" ||
    !JOURNAL_PHASES.has(record.phase as Journal["phase"])
  ) {
    throw invalidJournal(paths, "unsupported schema version or phase");
  }
  const journal = record as unknown as Journal;
  if (journal.destination !== paths.destination || journal.backup !== paths.backup) {
    throw invalidJournal(paths, `journal is not bound to ${paths.destination}`);
  }
  await validateOwnedStaging(paths, journal.staging, false);
  return journal;
}

async function validateOwnedBackup(
  paths: Omit<TransactionPaths, "staging">,
  mustExist: boolean,
): Promise<boolean> {
  const expected = join(paths.parent, `.${basename(paths.destination)}.vqa-backup`);
  if (paths.backup !== expected) {
    throw invalidJournal(paths, "backup path is not the reserved canonical sibling");
  }
  if (!await exists(paths.backup)) {
    if (mustExist) throw invalidJournal(paths, "owned backup directory is missing");
    return false;
  }
  const item = await lstat(paths.backup);
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw invalidJournal(paths, "backup path is not a real directory");
  }
  if (!await isLinkFreeExistingPath(paths.backup) || dirname(paths.backup) !== paths.parent) {
    throw invalidJournal(paths, "backup realpath escapes the transaction parent");
  }
  return true;
}

async function removeOwnedBackup(paths: Omit<TransactionPaths, "staging">): Promise<void> {
  if (await validateOwnedBackup(paths, false)) {
    if (!await validReport(paths.backup)) {
      throw invalidJournal(paths, "reserved backup is not a valid owned report");
    }
    await rm(paths.backup, { recursive: true });
  }
}

async function moveDestinationToBackup(
  paths: Omit<TransactionPaths, "staging">,
): Promise<void> {
  await validateCompletedReport(paths.destination);
  if (await validateOwnedBackup(paths, false)) {
    throw invalidJournal(paths, "reserved backup already exists");
  }
  await rename(paths.destination, paths.backup);
}

async function restoreOwnedBackup(
  paths: Omit<TransactionPaths, "staging">,
): Promise<void> {
  await validateOwnedBackup(paths, true);
  if (!await validReport(paths.backup)) {
    throw invalidJournal(paths, "reserved backup is not a valid owned report");
  }
  await rename(paths.backup, paths.destination);
}

async function removeOwnedJournal(paths: Omit<TransactionPaths, "staging">): Promise<void> {
  const item = await lstat(paths.journal);
  if (!item.isFile() || item.isSymbolicLink() || !await isLinkFreeExistingPath(paths.journal)) {
    throw invalidJournal(paths, "journal changed before cleanup");
  }
  await rm(paths.journal);
}

async function removeOwnedStaging(
  paths: Omit<TransactionPaths, "staging">,
  staging: string,
  requireValidReport = false,
): Promise<void> {
  if (await validateOwnedStaging(paths, staging, false)) {
    if (requireValidReport && !await validReport(staging)) {
      throw invalidJournal(paths, "reserved staging directory is not a valid owned report");
    }
    await rm(staging, { recursive: true });
  }
}

async function promoteOwnedStaging(
  paths: Omit<TransactionPaths, "staging">,
  staging: string,
): Promise<void> {
  await validateOwnedStaging(paths, staging, true);
  if (!await validReport(staging)) {
    throw invalidJournal(paths, "reserved staging directory is not a valid owned report");
  }
  await rename(staging, paths.destination);
}

async function recover(paths: Omit<TransactionPaths, "staging">): Promise<void> {
  if (!await exists(paths.journal)) return;
  const journal = await readJournal(paths);
  await validateOwnedBackup(paths, false);
  if (await exists(paths.destination) && await validReport(paths.destination)) {
    await removeOwnedStaging(paths, journal.staging, true);
    await removeOwnedBackup(paths);
    await removeOwnedJournal(paths);
    await syncDirectory(paths.parent);
    return;
  }
  if (await exists(paths.destination)) await rm(paths.destination, { recursive: true, force: true });
  if (await exists(paths.backup) && await validReport(paths.backup)) {
    await restoreOwnedBackup(paths);
  } else if (await exists(journal.staging) && await validReport(journal.staging)) {
    await promoteOwnedStaging(paths, journal.staging);
  } else {
    throw new Error(`cannot recover report transaction for ${paths.destination}`);
  }
  await validateCompletedReport(paths.destination);
  await removeOwnedStaging(paths, journal.staging, true);
  await removeOwnedBackup(paths);
  await removeOwnedJournal(paths);
  await syncDirectory(paths.parent);
}

export async function withNewReportTransaction<T>(
  requestedDestination: string,
  producer: (staging: string) => Promise<T>,
  lifecycle?: { assertActive(): void },
): Promise<T> {
  const base = await resolvedParent(requestedDestination);
  const siblings = siblingPaths(base.destination, base.parent);
  const release = await acquireReportWriterLock({
    lockPath: siblings.lock,
    conflictMessage: `another report writer holds ${siblings.lock}`,
  });
  let staging = "";
  try {
    await recover(siblings);
    if (await exists(base.destination)) {
      const item = await lstat(base.destination);
      if (!item.isDirectory() || item.isSymbolicLink()) throw new Error(`report destination already exists and is not a real directory: ${base.destination}`);
      const entries = await readdir(base.destination);
      if (entries.length > 0) throw new Error(`report destination is not empty: ${base.destination}`);
      await rmdir(base.destination);
    }
    staging = await mkdtemp(join(base.parent, `.${basename(base.destination)}.vqa-staging-`));
    const result = await producer(staging);
    await validateCompletedReport(staging);
    await syncTree(staging);
    lifecycle?.assertActive();
    await promoteOwnedStaging(siblings, staging);
    staging = "";
    await syncDirectory(base.parent);
    await validateCompletedReport(base.destination);
    try {
      lifecycle?.assertActive();
    } catch (error) {
      await rm(base.destination, { recursive: true, force: true });
      await syncDirectory(base.parent);
      throw error;
    }
    return result;
  } finally {
    if (staging) await removeOwnedStaging(siblings, staging);
    await release();
  }
}

export async function replaceReportTransaction<T>(
  requestedDestination: string,
  producer: (staging: string) => Promise<T>,
): Promise<T> {
  const base = await resolvedParent(requestedDestination);
  const siblings = siblingPaths(base.destination, base.parent);
  const release = await acquireReportWriterLock({
    lockPath: siblings.lock,
    conflictMessage: `another report writer holds ${siblings.lock}`,
  });
  let staging = "";
  let transactionPaths: TransactionPaths | undefined;
  let journalStarted = false;
  try {
    await recover(siblings);
    if (!await validReport(base.destination)) throw new Error(`cannot replace an invalid report: ${base.destination}`);
    if (await exists(siblings.backup)) throw new Error(`unexpected report backup requires operator inspection: ${siblings.backup}`);
    staging = await mkdtemp(join(base.parent, `.${basename(base.destination)}.vqa-staging-`));
    const result = await producer(staging);
    await validateCompletedReport(staging);
    await syncTree(staging);
    transactionPaths = { ...siblings, staging };
    await writeJournal(transactionPaths, "staging-valid");
    journalStarted = true;
    await moveDestinationToBackup(siblings);
    await syncDirectory(base.parent);
    await writeJournal(transactionPaths, "destination-backed-up");
    await promoteOwnedStaging(siblings, staging);
    await syncDirectory(base.parent);
    await writeJournal(transactionPaths, "committed");
    await validateCompletedReport(base.destination);
    await writeJournal(transactionPaths, "validated");
    await removeOwnedBackup(siblings);
    await removeOwnedJournal(siblings);
    await syncDirectory(base.parent);
    staging = "";
    return result;
  } catch (error) {
    if (journalStarted && transactionPaths) {
      try {
        await recover(siblings);
        await validateCompletedReport(base.destination);
        staging = "";
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          `report transaction failed and recovery could not validate ${base.destination}`,
        );
      }
    }
    throw error;
  } finally {
    if (staging && !journalStarted) await removeOwnedStaging(siblings, staging);
    await release();
  }
}
