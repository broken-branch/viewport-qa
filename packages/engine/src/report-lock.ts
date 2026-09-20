import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isLinkFreeExistingPath, linkFreeDirectoryIdentity, sameDirectoryIdentity } from "./path-safety.js";
import type { DirectoryIdentity } from "./path-safety.js";

interface LockOwner { pid?: unknown; lock_id?: unknown; created_at?: unknown }

export interface ReportWriterLockHooks {
  afterLockObserved?(): Promise<void> | void;
  beforeLockCreate?(): Promise<void> | void;
  afterStaleOwnerObserved?(): Promise<void> | void;
  afterLegacyArtifactObserved?(): Promise<void> | void;
}

export interface ReportWriterLockOptions {
  lockPath: string;
  conflictMessage: string;
  recoveredMessage?: string;
  log?: (line: string) => void;
  hooks?: ReportWriterLockHooks;
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ownerIsStale(path: string, owner: LockOwner): Promise<boolean> {
  if (Number.isInteger(owner.pid) && (owner.pid as number) > 0) {
    try { process.kill(owner.pid as number, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  return Date.now() - (await stat(path)).mtimeMs > 30_000;
}

async function readOwner(path: string): Promise<LockOwner> {
  return JSON.parse(await readFile(path, "utf8")) as LockOwner;
}

async function refuseLegacyGuard(options: ReportWriterLockOptions): Promise<void> {
  const path = `${options.lockPath}.recovery`;
  if (!await pathExists(path)) return;
  await options.hooks?.afterLegacyArtifactObserved?.();
  throw new Error(`legacy Viewport QA recovery artifact blocks writers: ${path}. Stop all older Viewport QA processes, then manually inspect and remove the artifact before retrying`);
}

async function createOwnerDirectory(
  path: string,
  lockId: string,
  parentIdentity: DirectoryIdentity,
  hooks?: ReportWriterLockHooks,
): Promise<string> {
  await hooks?.beforeLockCreate?.();
  await mkdir(path);
  const parentStillBound = sameDirectoryIdentity(
    parentIdentity,
    await linkFreeDirectoryIdentity(dirname(path)),
  );
  const createdItem = await lstat(path).catch(() => undefined);
  if (!parentStillBound || !createdItem?.isDirectory() || createdItem.isSymbolicLink() || !await isLinkFreeExistingPath(path)) {
    // This exact directory was just created and has no owner yet. rmdir never
    // follows contents and refuses an adversary's non-empty replacement.
    await rmdir(path).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
    });
    throw new Error(`report writer lock parent identity changed; refusing ${path}`);
  }
  const ownerPath = join(path, `owner-${lockId}.json`);
  try {
    const handle = await open(ownerPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, lock_id: lockId, created_at: new Date().toISOString() })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    return ownerPath;
  } catch (error) {
    // A stale empty-directory recoverer can remove the directory between our
    // mkdir and owner creation. This attempt never owns the lock; retry.
    await rm(ownerPath, { force: true }).catch(() => {});
    await rmdir(path).catch(() => {});
    throw error;
  }
}

async function assertLockParentUnchanged(path: string, parentIdentity: DirectoryIdentity): Promise<void> {
  const parent = dirname(path);
  if (!sameDirectoryIdentity(parentIdentity, await linkFreeDirectoryIdentity(parent))) {
    throw new Error(`legacy or unsafe Viewport QA lock parent changed: ${parent}`);
  }
}

async function assertLockGenerationUnchanged(
  path: string,
  parentIdentity: DirectoryIdentity,
  lockIdentity: DirectoryIdentity,
): Promise<void> {
  await assertLockParentUnchanged(path, parentIdentity);
  if (!sameDirectoryIdentity(lockIdentity, await linkFreeDirectoryIdentity(path))) {
    throw new Error(`legacy or unsafe Viewport QA lock generation changed: ${path}`);
  }
}

async function recoverStaleDirectory(
  options: ReportWriterLockOptions,
  parentIdentity: DirectoryIdentity,
): Promise<boolean> {
  let item;
  try { item = await lstat(options.lockPath, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertLockParentUnchanged(options.lockPath, parentIdentity);
      return false;
    }
    throw error;
  }
  await options.hooks?.afterLockObserved?.();
  const confined = await isLinkFreeExistingPath(options.lockPath);
  if (!item.isDirectory() || item.isSymbolicLink()) {
    await options.hooks?.afterLegacyArtifactObserved?.();
    throw new Error(`legacy or unsafe Viewport QA lock blocks writers: ${options.lockPath}. Stop all older Viewport QA processes, then manually inspect and remove the artifact before retrying`);
  }
  const lockIdentity: DirectoryIdentity = { dev: item.dev, ino: item.ino };
  if (!confined) {
    try { await lstat(options.lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await assertLockParentUnchanged(options.lockPath, parentIdentity);
        return false;
      }
      throw error;
    }
    await options.hooks?.afterLegacyArtifactObserved?.();
    throw new Error(`legacy or unsafe Viewport QA lock blocks writers: ${options.lockPath}. Stop all older Viewport QA processes, then manually inspect and remove the artifact before retrying`);
  }

  let entries: string[];
  try { entries = await readdir(options.lockPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertLockParentUnchanged(options.lockPath, parentIdentity);
      return false;
    }
    throw error;
  }
  if (entries.length === 0) {
    if (Date.now() - Number(item.mtimeMs) <= 30_000) throw new Error(options.conflictMessage);
    await options.hooks?.afterStaleOwnerObserved?.();
    await assertLockGenerationUnchanged(options.lockPath, parentIdentity, lockIdentity);
    try { await rmdir(options.lockPath); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await assertLockParentUnchanged(options.lockPath, parentIdentity);
        return false;
      }
      if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }
  if (entries.length !== 1 || !/^owner-[A-Za-z0-9_-]+\.json$/u.test(entries[0]!)) {
    throw new Error(`unsafe report writer lock contents require operator inspection: ${options.lockPath}`);
  }
  const ownerPath = join(options.lockPath, entries[0]!);
  let ownerItem;
  try { ownerItem = await lstat(ownerPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertLockParentUnchanged(options.lockPath, parentIdentity);
      return false;
    }
    throw error;
  }
  if (!ownerItem.isFile() || ownerItem.isSymbolicLink()) {
    throw new Error(`unsafe report writer lock owner requires operator inspection: ${ownerPath}`);
  }
  if (!await isLinkFreeExistingPath(ownerPath)) {
    try { await lstat(ownerPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await assertLockParentUnchanged(options.lockPath, parentIdentity);
        return false;
      }
      throw error;
    }
    throw new Error(`unsafe report writer lock owner requires operator inspection: ${ownerPath}`);
  }
  let owner: LockOwner;
  try { owner = await readOwner(ownerPath); }
  catch (error) {
    if (!(error instanceof SyntaxError) || Date.now() - ownerItem.mtimeMs <= 30_000) throw error;
    owner = {};
  }
  if (!await ownerIsStale(ownerPath, owner)) throw new Error(options.conflictMessage);
  await options.hooks?.afterStaleOwnerObserved?.();
  await assertLockGenerationUnchanged(options.lockPath, parentIdentity, lockIdentity);
  try { await rm(ownerPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertLockParentUnchanged(options.lockPath, parentIdentity);
      return false;
    }
    throw error;
  }
  await assertLockGenerationUnchanged(options.lockPath, parentIdentity, lockIdentity);
  try { await rmdir(options.lockPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertLockParentUnchanged(options.lockPath, parentIdentity);
    } else if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
  return true;
}

/**
 * The canonical lock is one atomic directory containing one random owner
 * filename. Stale recovery removes that exact filename before rmdir. A late
 * recoverer cannot unlink a replacement generation: its old random filename
 * is absent, and rmdir refuses the replacement's non-empty lock.
 */
export async function acquireReportWriterLock(options: ReportWriterLockOptions): Promise<() => Promise<void>> {
  const log = options.log ?? (() => {});
  const parentIdentity = await linkFreeDirectoryIdentity(dirname(options.lockPath));
  if (!parentIdentity) throw new Error(`report writer lock parent is unsafe: ${dirname(options.lockPath)}`);
  await refuseLegacyGuard(options);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const lockId = randomBytes(18).toString("base64url");
    let ownerPath: string;
    try { ownerPath = await createOwnerDirectory(options.lockPath, lockId, parentIdentity, options.hooks); }
    catch (error) {
      if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (await recoverStaleDirectory(options, parentIdentity) && options.recoveredMessage) log(options.recoveredMessage);
      continue;
    }
    return async () => {
      try {
        const owner = await readOwner(ownerPath);
        if (owner.lock_id !== lockId) throw new Error(`report writer lock ownership changed; preserving ${options.lockPath}`);
        await rm(ownerPath);
        await rmdir(options.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
  }
  throw new Error(options.conflictMessage);
}
