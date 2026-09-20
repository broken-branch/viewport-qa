import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { link, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type {
  CaptureClassification,
  Decision,
  DecisionAction,
  DecisionsFile,
  ExportIdentity,
  Report,
  Rect,
  ReviewManifest,
  ReviewState,
} from "@vqa/contract";
import {
  PRODUCT_VERSION,
  REPORT_FORMAT_VERSIONS,
  REVIEW_MANIFEST_SCHEMA_VERSION,
  REVIEW_STATE_SCHEMA_VERSION,
} from "@vqa/contract";
import { acquireReportWriterLock, isLinkFreeExistingPath, renderReportHtml, TOOL_NAME } from "@vqa/engine";
import type { ReportWriterLockHooks } from "@vqa/engine";
import {
  createPortableBundle,
  createPortableBundleContent,
  createHumanHandoffContent,
  createHumanHandoffPdf,
  EXPORT_POLICY_ID,
  isUsefulReviewerOutcome,
  reviewStateSha256,
  validateCaptureAsset,
  validatedSource,
  validateReviewManifest,
} from "./export-bundle.js";

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const ACTIONS: readonly DecisionAction[] = ["approve", "reject", "message"];
const CLASSIFICATIONS: readonly CaptureClassification[] = ["unreviewed", "good", "bad"];

export function validateReportCompatibility(
  report: Report,
  manifest?: ReviewManifest,
): void {
  if (report.tool !== TOOL_NAME || !REPORT_FORMAT_VERSIONS.includes(report.formatVersion)) {
    throw new Error(`unsupported report identity: ${report.tool}/${report.formatVersion}`);
  }
  if (!manifest) {
    if (
      report.formatVersion !== "2" ||
      !/^0\.2\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(report.toolVersion)
    ) {
      throw new Error(`unsupported pre-manifest report version: ${report.toolVersion}/${report.formatVersion}`);
    }
    return;
  }
  if (report.toolVersion !== PRODUCT_VERSION) {
    throw new Error(`unsupported manifest-backed product version: ${report.toolVersion}`);
  }
  if (
    report.schemaVersions?.report !== report.formatVersion ||
    report.schemaVersions.manifest !== REVIEW_MANIFEST_SCHEMA_VERSION ||
    report.schemaVersions.reviewState !== REVIEW_STATE_SCHEMA_VERSION
  ) {
    throw new Error("manifest-backed report schema metadata is missing or unsupported");
  }
  const source = manifest.source_report;
  if (
    source.tool !== report.tool ||
    source.tool_version !== report.toolVersion ||
    source.format_version !== report.formatVersion ||
    source.report_schema_version !== report.formatVersion ||
    source.manifest_schema_version !== REVIEW_MANIFEST_SCHEMA_VERSION ||
    source.review_state_schema_version !== REVIEW_STATE_SCHEMA_VERSION
  ) {
    throw new Error("review manifest source metadata does not match issues.json or supported schemas");
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export const MAX_BODY_BYTES = 1_000_000;

export class BodyTooLargeError extends Error {}

export function readBody(request: NodeJS.ReadableStream, maximum = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      if (length > maximum) {
        settled = true;
        rejectPromise(new BodyTooLargeError("body too large"));
        request.removeAllListeners("data");
        request.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => { if (!settled) resolvePromise(Buffer.concat(chunks, length).toString("utf8")); });
    request.on("error", (error) => { if (!settled) rejectPromise(error); });
  });
}

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
} as const;

export function applyBaseHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(BASE_HEADERS)) response.setHeader(name, value);
}

export function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function withNonce(html: string, nonce: string): string {
  return html.replaceAll("<script", `<script nonce="${nonce}"`).replaceAll("<style", `<style nonce="${nonce}"`);
}

export function bootstrapHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening Viewport QA</title></head><body><main><h1>Opening Viewport QA</h1><p id="status">Authorizing this private local session…</p></main><script>(async()=>{const raw=location.hash.startsWith("#cap=")?location.hash.slice(5):"";if(raw){sessionStorage.setItem("vqa.launch.capability",raw);history.replaceState(null,"",location.pathname);}const cap=sessionStorage.getItem("vqa.launch.capability");if(!cap){document.getElementById("status").textContent="This copied or expired URL is not authorized. Reopen Viewport QA.";return;}const response=await fetch("/app",{headers:{authorization:"VQA "+cap},cache:"no-store"});if(!response.ok){sessionStorage.removeItem("vqa.launch.capability");document.getElementById("status").textContent="This Viewport QA session expired or is not authorized.";return;}const html=await response.text();document.open();document.write(html);document.close();})().catch(()=>{document.getElementById("status").textContent="Viewport QA could not open this session.";});</script></body></html>`;
}

export function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": CONTENT_TYPES[".json"]! });
  response.end(JSON.stringify(value, null, 2));
}

function emptyReviewState(manifest: ReviewManifest, manifestSha256: string): ReviewState {
  return {
    artifact_type: "vq-review-state",
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    manifest_sha256: manifestSha256,
    captures: Object.fromEntries(
      manifest.captures.map((capture) => [
        capture.coordinate_id,
        { coordinate_id: capture.coordinate_id, classification: "unreviewed" },
      ]),
    ),
  };
}

function validReviewState(
  value: ReviewState,
  manifest: ReviewManifest,
  manifestSha256: string,
): boolean {
  if (
    value.artifact_type !== "vq-review-state" ||
    value.schema_version !== 1 ||
    value.manifest_id !== manifest.manifest_id ||
    value.manifest_sha256 !== manifestSha256
  ) {
    return false;
  }
  const known = new Set(manifest.captures.map((capture) => capture.coordinate_id));
  const validHighlights = (id: string, capture: ReviewState["captures"][string]): boolean => {
    const manifestCapture = manifest.captures.find((candidate) => candidate.coordinate_id === id)!;
    return !capture.issue_highlights || Object.entries(capture.issue_highlights).every(([issueId, rect]) =>
      manifestCapture.issue_ids.includes(issueId) && (rect === null || validHighlightRect(rect, manifestCapture.resolution.width, manifestCapture.resolution.height)));
  };
  const validRequest = (id: string, capture: ReviewState["captures"][string]): boolean => {
    const request = capture.requested_change;if(!request)return true;
    if(capture.classification!=="bad"||request.origin_coordinate_id!==id||typeof request.requested_change!=="string"||!Array.isArray(request.affected_coordinate_ids)||!Array.isArray(request.selected_issue_ids))return false;
    if(new Set(request.affected_coordinate_ids).size!==request.affected_coordinate_ids.length||new Set(request.selected_issue_ids).size!==request.selected_issue_ids.length||!request.affected_coordinate_ids.includes(id)||request.affected_coordinate_ids.some((coordinateId)=>!known.has(coordinateId)))return false;
    const selectable=new Set(request.affected_coordinate_ids.flatMap((coordinateId)=>manifest.captures.find((candidate)=>candidate.coordinate_id===coordinateId)!.issue_ids));
    return request.selected_issue_ids.every((issueId)=>typeof issueId==="string"&&selectable.has(issueId))&&(request.requested_change.trim().length>0||request.selected_issue_ids.length>0);
  };
  return (
    Object.keys(value.captures).length === known.size &&
    Object.entries(value.captures).every(
      ([id, capture]) =>
        known.has(id) &&
        capture.coordinate_id === id &&
        CLASSIFICATIONS.includes(capture.classification) &&
        validHighlights(id, capture) &&
        validRequest(id, capture),
    )
  );
}

async function loadReviewState(
  path: string,
  manifest: ReviewManifest,
  manifestSha256: string,
): Promise<ReviewState> {
  if (!existsSync(path)) return emptyReviewState(manifest, manifestSha256);
  const state = await readJson<ReviewState | null>(path, null);
  if (!state || !validReviewState(state, manifest, manifestSha256)) {
    throw new Error("review-state.json does not match the immutable manifest");
  }
  return state;
}

interface ReviewUpdateBody {
  coordinateId?: unknown;
  classification?: unknown;
  requestedChange?: unknown;
  affectedCoordinateIds?: unknown;
  selectedIssueIds?: unknown;
  highlightIssueId?: unknown;
  highlightRect?: unknown;
}

function validHighlightRect(value: unknown, width: number, height: number): value is Rect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return [rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part)) &&
    (rect.x as number) >= 0 && (rect.y as number) >= 0 && (rect.width as number) >= 16 && (rect.height as number) >= 16 &&
    (rect.x as number) + (rect.width as number) <= width && (rect.y as number) + (rect.height as number) <= height;
}

function applyReviewUpdate(
  state: ReviewState,
  manifest: ReviewManifest,
  body: ReviewUpdateBody,
  now: string,
): { state: ReviewState; changed: boolean } {
  const { coordinateId, classification, requestedChange, affectedCoordinateIds, selectedIssueIds, highlightIssueId, highlightRect } = body;
  const manifestCapture = typeof coordinateId === "string" ? manifest.captures.find((capture) => capture.coordinate_id === coordinateId) : undefined;
  if (highlightIssueId !== undefined) {
    if (!manifestCapture || typeof highlightIssueId !== "string" || !manifestCapture.issue_ids.includes(highlightIssueId) ||
      (highlightRect !== null && !validHighlightRect(highlightRect, manifestCapture.resolution.width, manifestCapture.resolution.height))) {
      throw new Error("unknown issue highlight or invalid highlight geometry");
    }
    const prior = state.captures[coordinateId as string]!;
    if (JSON.stringify(prior.issue_highlights?.[highlightIssueId]) === JSON.stringify(highlightRect)) return { state, changed: false };
    const next = structuredClone(state);
    next.captures[coordinateId as string] = {
      ...prior,
      updated_at: now,
      issue_highlights: { ...prior.issue_highlights, [highlightIssueId]: highlightRect as Rect | null },
    };
    return { state: next, changed: true };
  }
  if (
    typeof coordinateId !== "string" ||
    !manifest.captures.some((capture) => capture.coordinate_id === coordinateId) ||
    typeof classification !== "string" ||
    !CLASSIFICATIONS.includes(classification as CaptureClassification)
  ) {
    throw new Error("unknown coordinate or invalid classification");
  }
  if (requestedChange !== undefined && typeof requestedChange !== "string") throw new Error("requested change must be reviewer-authored text");
  if (requestedChange !== undefined && classification !== "bad") {
    throw new Error("only a Needs changes review can contain a requested change");
  }
  let affected: string[] | undefined;
  if (affectedCoordinateIds !== undefined) {
    if (
      !Array.isArray(affectedCoordinateIds) ||
      !affectedCoordinateIds.every((value) => typeof value === "string") ||
      new Set(affectedCoordinateIds).size !== affectedCoordinateIds.length
    ) {
      throw new Error("affected screenshots must be unique manifest coordinates");
    }
    affected = [...affectedCoordinateIds].sort();
    if (!affected.includes(coordinateId)) affected.unshift(coordinateId);
    const known = new Set(manifest.captures.map((capture) => capture.coordinate_id));
    if (affected.some((id) => !known.has(id))) throw new Error("unknown affected screenshot");
  }
  if (requestedChange !== undefined && (!affected || affected.length === 0)) {
    affected = [coordinateId];
  }
  let selectedIssues: string[] | undefined;
  if (requestedChange !== undefined) {
    if (
      !Array.isArray(selectedIssueIds) ||
      !selectedIssueIds.every((value) => typeof value === "string") ||
      new Set(selectedIssueIds).size !== selectedIssueIds.length
    ) {
      throw new Error("selected issues must be unique manifest issue IDs");
    }
    selectedIssues = [...selectedIssueIds].sort();
    const affectedCaptures = affected!.map((id) => manifest.captures.find((capture) => capture.coordinate_id === id)!);
    const selectable = new Set(affectedCaptures.flatMap((capture) => capture.issue_ids));
    if (selectedIssues.some((id) => !selectable.has(id))) throw new Error("selected issue is not part of an affected screenshot");
    if (!isUsefulReviewerOutcome(requestedChange)) {
      throw new Error("describe a useful reviewer-approved outcome in at least three words");
    }
  }

  const prior = state.captures[coordinateId]!;
  const priorRequest = prior.requested_change;
  const trimmed = typeof requestedChange === "string" ? requestedChange.trim() : undefined;
  const requestUnchanged =
    trimmed !== undefined &&
    priorRequest?.requested_change === trimmed &&
    JSON.stringify(priorRequest.affected_coordinate_ids) === JSON.stringify(affected) &&
    JSON.stringify(priorRequest.selected_issue_ids) === JSON.stringify(selectedIssues);
  const noRequestChange = trimmed === undefined && classification === "bad";
  if (
    prior.classification === classification &&
    (requestUnchanged || noRequestChange || (classification !== "bad" && !priorRequest))
  ) {
    return { state, changed: false };
  }

  const next = structuredClone(state);
  const nextCapture = {
    coordinate_id: coordinateId,
    classification: classification as CaptureClassification,
    updated_at: now,
    ...(classification === "bad" && trimmed !== undefined
      ? {
          requested_change: {
            request_id: priorRequest?.request_id ?? `vqreq-v1-${coordinateId}`,
            requested_change: trimmed,
            authorship: "visual-reviewer" as const,
            origin_coordinate_id: coordinateId,
            affected_coordinate_ids: affected!,
            selected_issue_ids: selectedIssues!,
            created_at: priorRequest?.created_at ?? now,
            updated_at: requestUnchanged ? priorRequest!.updated_at : now,
          },
        }
      : classification === "bad" && priorRequest
        ? { requested_change: priorRequest }
        : {}),
  };
  next.captures[coordinateId] = nextCapture;
  return { state: next, changed: true };
}

type IdentityStore = Record<string, ExportIdentity>;

interface ReviewSettings {
  default_handoff_path: string;
}

type HandoffAudience = "human" | "ai";
type HandoffFileFormat = "txt" | "pdf" | "json";

function validIdentityStore(value: IdentityStore): boolean {
  return Object.entries(value).every(([key, identity]) =>
    key === `VQ-JOURNEY-EXPORT:v1:${identity.manifest_sha256}:${identity.review_state_sha256}` &&
    identity.schema_version === 1 && identity.policy_id === EXPORT_POLICY_ID &&
    identity.export_id === `vqexp-v1-${identity.review_state_sha256}` &&
    /^[0-9a-f]{64}$/.test(identity.manifest_sha256) && /^[0-9a-f]{64}$/.test(identity.review_state_sha256) &&
    !Number.isNaN(Date.parse(identity.exported_at)));
}

async function validatedHandoffPath(value: unknown, format?: HandoffFileFormat): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new Error("handoff destination must be a non-empty path");
  }
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) throw new Error("handoff destination must be an absolute path");
  const destination = resolve(trimmed);
  const extension = extname(destination).toLowerCase();
  const expected = format ? `.${format}` : undefined;
  if (expected ? extension !== expected : ![".txt", ".pdf", ".json"].includes(extension)) {
    throw new Error(
      expected
        ? `handoff destination must be a ${expected} file`
        : "default handoff path must end in .txt, .pdf, or .json",
    );
  }
  const parent = dirname(destination);
  if (parent === parse(parent).root) throw new Error("handoff destination cannot be written directly to a filesystem root");
  const parentStats = await lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("handoff destination directory is unsafe");
  }
  if (!await isLinkFreeExistingPath(parent)) throw new Error("handoff destination directory must not resolve through a symlink");
  try {
    const targetStats = await lstat(destination);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new Error("handoff destination is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return destination;
}

async function writeHandoffFile(destination: string, content: string | Buffer): Promise<void> {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    const existing = await readFile(destination);
    if (existing.equals(bytes)) return;
    throw new Error("handoff destination already exists with different content");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await readFile(destination);
      if (existing.equals(bytes)) return;
      throw new Error("handoff destination already exists with different content");
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface ServeOptions {
  reportDir: string;
  port: number;
  host?: string;
  log?: (line: string) => void;
  readOnly?: boolean;
  idleTimeoutMs?: number;
  /** Deterministic concurrency hooks for lock protocol verification. */
  lockHooks?: ReportWriterLockHooks;
}

export async function serveReport(
  options: ServeOptions,
): Promise<{ server: Server; url: string }> {
  const root = resolve(options.reportDir);
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("Viewport QA review service binds only to 127.0.0.1");
  const log = options.log ?? (() => {});
  const rootItem = await lstat(root);
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink() || !await isLinkFreeExistingPath(root)) {
    throw new Error("report directory must be a real, non-symlink directory");
  }
  const issuesPath = join(root, "issues.json");
  if (!existsSync(issuesPath)) {
    throw new Error(`${root} does not look like a vqa report directory (missing issues.json)`);
  }
  async function assertExistingInternalPath(path: string, expected: "file" | "directory"): Promise<void> {
    if (!existsSync(path)) return;
    const item = await lstat(path);
    const correctType = expected === "file" ? item.isFile() : item.isDirectory();
    if (!correctType || item.isSymbolicLink() || !await isLinkFreeExistingPath(path)) {
      throw new Error(`unsafe report ${expected}: ${path}`);
    }
  }
  await assertExistingInternalPath(issuesPath, "file");
  const report = await readJson<Report | null>(issuesPath, null);
  if (!report) throw new Error("issues.json is not valid JSON");

  const manifestPath = join(root, "review-manifest.json");
  await assertExistingInternalPath(manifestPath, "file");
  const manifestBytes = existsSync(manifestPath) ? await readFile(manifestPath) : undefined;
  const manifest = manifestBytes
    ? (JSON.parse(manifestBytes.toString("utf8")) as ReviewManifest)
    : undefined;
  if (manifest) validateReviewManifest(manifest);
  validateReportCompatibility(report, manifest);
  const manifestSha256 = manifestBytes
    ? createHash("sha256").update(manifestBytes).digest("hex")
    : undefined;
  const reviewPath = join(root, "review-state.json");
  const settingsPath = join(root, "review-settings.json");
  const decisionsPath = join(root, "decisions.json");
  const identitiesPath = join(root, "review-export-identities.json");
  const handoffsPath = join(root, "handoffs");
  await Promise.all([
    assertExistingInternalPath(reviewPath, "file"),
    assertExistingInternalPath(settingsPath, "file"),
    assertExistingInternalPath(decisionsPath, "file"),
    assertExistingInternalPath(identitiesPath, "file"),
    assertExistingInternalPath(handoffsPath, "directory"),
  ]);
  const assetByRelativePath = new Map<string, ReviewManifest["assets"][number] | undefined>(
    manifest?.assets.map((asset) => [asset.source_relative_path, asset]) ?? [],
  );
  if (!manifest) {
    for (const result of report.viewports) if (result.screenshot) assetByRelativePath.set(result.screenshot, undefined);
    for (const issue of report.issues) {
      assetByRelativePath.set(issue.screenshots.viewport, undefined);
      if (issue.screenshots.crop) assetByRelativePath.set(issue.screenshots.crop, undefined);
    }
  }
  async function validatedLegacyAsset(relative: string): Promise<string> {
    const path = resolve(root, relative);
    if (path === root || !path.startsWith(root + sep)) throw new Error("asset path escapes report root");
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink() || !await isLinkFreeExistingPath(path)) throw new Error("asset is not a confined regular file");
    return path;
  }
  async function validateAllAssets(): Promise<void> {
    if (!manifest) return;
    const captureByAsset = new Map(manifest.captures.map((capture) => [capture.full_asset_id, capture]));
    await Promise.all(manifest.assets.map((asset) => {
      const capture = captureByAsset.get(asset.id);
      return capture ? validateCaptureAsset(root, asset, capture.resolution) : validatedSource(root, asset);
    }));
  }
  await validateAllAssets();
  const readOnly = options.readOnly === true || !manifest;
  const lockPath = join(dirname(root), `.${basename(root)}.vqa-transaction.lock`);
  const releaseReviewLock = readOnly ? async (): Promise<void> => {} : await acquireReportWriterLock({
    lockPath,
    conflictMessage: `report is already open for writing; use --read-only to inspect it without edits (${lockPath})`,
    recoveredMessage: `[vqa serve] recovered stale review lock at ${lockPath}`,
    log,
    ...(options.lockHooks ? { hooks: options.lockHooks } : {}),
  });
  const capability = randomBytes(32).toString("base64url");
  const launchNonce = randomBytes(18).toString("base64url");
  let expectedHost = "";
  let expectedOrigin = "";
  let idleTimer: NodeJS.Timeout | undefined;
  let writeChain: Promise<unknown> = Promise.resolve();

  function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeChain.then(operation);
    writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const defaultSettings = (): ReviewSettings => ({
    default_handoff_path: join(root, "change-request-export.json"),
  });

  async function loadSettings(): Promise<ReviewSettings> {
    const settings = await readJson<ReviewSettings>(settingsPath, defaultSettings());
    return { default_handoff_path: await validatedHandoffPath(settings.default_handoff_path) };
  }

  async function prepareExportContent(): Promise<{
    state: ReviewState;
    identity: ExportIdentity;
    reviewDigest: string;
    content: string;
    humanContent: string;
  }> {
    const state = await loadReviewState(reviewPath, manifest!, manifestSha256!);
    const reviewDigest = reviewStateSha256(manifest!, manifestSha256!, state);
    const key = `VQ-JOURNEY-EXPORT:v1:${manifestSha256}:${reviewDigest}`;
    const identities = await readJson<IdentityStore>(identitiesPath, {});
    if (!validIdentityStore(identities)) throw new Error("review export identity store is malformed");
    let identity = identities[key];
    if (!identity) {
      if (existsSync(join(handoffsPath, `vqexp-v1-${reviewDigest}`))) {
        throw new Error("export identity record is missing for an existing bundle");
      }
      identity = {
        export_id: `vqexp-v1-${reviewDigest}`,
        exported_at: new Date().toISOString(),
        policy_id: EXPORT_POLICY_ID,
        schema_version: 1,
        manifest_sha256: manifestSha256!,
        review_state_sha256: reviewDigest,
      };
      identities[key] = identity;
      await writeJsonAtomic(identitiesPath, identities);
    }
    await validateAllAssets();
    const content = createPortableBundleContent({
      manifest: manifest!,
      manifestSha256: manifestSha256!,
      reviewState: state,
      identity,
    }).json;
    const humanContent = createHumanHandoffContent({ manifest: manifest!, reviewState: state });
    return { state, identity, reviewDigest, content, humanContent };
  }

  const server = createServer((request, response) => {
    void (async () => {
      applyBaseHeaders(response);
      if (request.headers.host !== expectedHost) {
        jsonResponse(response, 421, { error: "invalid loopback Host" });
        return;
      }
      const url = new URL(request.url ?? "/", expectedOrigin);
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        jsonResponse(response, 400, { error: "invalid request path" });
        return;
      }

      if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
        const html = Buffer.from(withNonce(bootstrapHtml(), launchNonce));
        response.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${launchNonce}'; connect-src 'self'; style-src 'unsafe-inline'; img-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        response.writeHead(200, { "content-type": CONTENT_TYPES[".html"]!, "content-length": html.length });
        response.end(request.method === "HEAD" ? undefined : html);
        return;
      }
      if (pathname === "/") {
        response.setHeader("allow", "GET, HEAD");
        jsonResponse(response, 405, { error: "method not allowed" });
        request.resume();
        return;
      }

      const authorization = request.headers.authorization;
      if (!safeEqual(authorization, `VQA ${capability}`)) {
        jsonResponse(response, 401, { error: "launch authorization required" });
        return;
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== expectedOrigin) {
        jsonResponse(response, 403, { error: "invalid Origin" });
        return;
      }
      if (!["GET", "HEAD"].includes(request.method ?? "") && origin !== expectedOrigin) {
        jsonResponse(response, 403, { error: "exact Origin required" });
        return;
      }
      if (idleTimer) idleTimer.refresh();
      if (request.method === "POST" && request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        jsonResponse(response, 415, { error: "application/json required" });
        request.resume();
        return;
      }
      const declaredLength = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        jsonResponse(response, 413, { error: "request body too large" });
        request.resume();
        return;
      }

      const routeMethods: Record<string, readonly string[]> = {
        "/app": ["GET", "HEAD"],
        "/api/decisions": ["GET", "POST"],
        "/api/review": ["GET", "POST"],
        "/api/settings": ["GET", "POST"],
        "/api/export": ["POST"],
        "/api/stop": ["POST"],
      };
      const permitted = routeMethods[pathname] ?? (assetByRelativePath.has(pathname.slice(1)) ? ["GET", "HEAD"] : undefined);
      if (permitted && !permitted.includes(request.method ?? "")) {
        response.setHeader("allow", permitted.join(", "));
        jsonResponse(response, 405, { error: "method not allowed" });
        request.resume();
        return;
      }

      if (pathname === "/app" && (request.method === "GET" || request.method === "HEAD")) {
        if (manifest) await validateAllAssets();
        const html = Buffer.from(withNonce(renderReportHtml(report, manifest), launchNonce));
        response.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${launchNonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        response.writeHead(200, { "content-type": CONTENT_TYPES[".html"]!, "content-length": html.length });
        response.end(request.method === "HEAD" ? undefined : html);
        return;
      }

      if (pathname === "/api/stop" && request.method === "POST") {
        jsonResponse(response, 202, { stopping: true });
        setImmediate(() => { server.close(); server.closeIdleConnections(); });
        return;
      }

      if (readOnly && request.method === "POST") {
        jsonResponse(response, 409, { error: "report is open read-only" });
        request.resume();
        return;
      }

      if (pathname === "/api/decisions" && request.method === "GET") {
        if (!manifest) {
          jsonResponse(response, 409, { error: "legacy format-v2 reports are read-only" });
          return;
        }
        jsonResponse(response, 200, await readJson<DecisionsFile>(decisionsPath, {}));
        return;
      }

      if (pathname === "/api/decisions" && request.method === "POST") {
        if (!manifest) {
          jsonResponse(response, 409, { error: "legacy format-v2 reports are read-only" });
          return;
        }
        let parsed: { issueId?: unknown; action?: unknown; message?: unknown };
        try {
          parsed = JSON.parse(await readBody(request)) as typeof parsed;
        } catch (error) {
          jsonResponse(response, error instanceof BodyTooLargeError ? 413 : 400, { error: error instanceof BodyTooLargeError ? "request body too large" : "invalid JSON body" });
          return;
        }
        const { issueId, action, message } = parsed;
        if (
          typeof issueId !== "string" ||
          !report.issues.some((issue) => issue.id === issueId) ||
          typeof action !== "string" ||
          !ACTIONS.includes(action as DecisionAction) ||
          (action === "message" && (typeof message !== "string" || message.trim().length === 0)) ||
          (message !== undefined && typeof message !== "string")
        ) {
          jsonResponse(response, 400, {
            error: "expected a known { issueId, action: approve|reject|message, message? }",
          });
          return;
        }
        const updated = await enqueueWrite(async () => {
          const decisions = await readJson<DecisionsFile>(decisionsPath, {});
          const prior = decisions[issueId];
          const trimmed = typeof message === "string" ? message.trim() : undefined;
          if (prior?.action === action && prior.message === trimmed) return decisions;
          const decision: Decision = {
            issueId,
            action: action as DecisionAction,
            updatedAt: new Date().toISOString(),
            ...(trimmed ? { message: trimmed } : {}),
          };
          decisions[issueId] = decision;
          await writeJsonAtomic(decisionsPath, decisions);
          return decisions;
        });
        jsonResponse(response, 200, updated);
        return;
      }

      if (pathname === "/api/review" && request.method === "GET") {
        if (!manifest || !manifestSha256) {
          jsonResponse(response, 404, { error: "review manifest unavailable" });
          return;
        }
        jsonResponse(response, 200, await loadReviewState(reviewPath, manifest, manifestSha256));
        return;
      }

      if (pathname === "/api/review" && request.method === "POST") {
        if (!manifest || !manifestSha256) {
          jsonResponse(response, 404, { error: "review manifest unavailable" });
          return;
        }
        let parsed: ReviewUpdateBody;
        try {
          parsed = JSON.parse(await readBody(request)) as ReviewUpdateBody;
        } catch (error) {
          jsonResponse(response, error instanceof BodyTooLargeError ? 413 : 400, { error: error instanceof BodyTooLargeError ? "request body too large" : "invalid JSON body" });
          return;
        }
        try {
          const updated = await enqueueWrite(async () => {
            await validateAllAssets();
            const current = await loadReviewState(reviewPath, manifest, manifestSha256);
            const result = applyReviewUpdate(current, manifest, parsed, new Date().toISOString());
            if (result.changed) await writeJsonAtomic(reviewPath, result.state);
            return result.state;
          });
          jsonResponse(response, 200, updated);
        } catch (error) {
          jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (pathname === "/api/settings" && request.method === "GET") {
        if (!manifest) {
          jsonResponse(response, 404, { error: "review manifest unavailable" });
          return;
        }
        try {
          jsonResponse(response, 200, await loadSettings());
        } catch (error) {
          jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (pathname === "/api/settings" && request.method === "POST") {
        if (!manifest) {
          jsonResponse(response, 404, { error: "review manifest unavailable" });
          return;
        }
        let parsed: { defaultHandoffPath?: unknown };
        try {
          parsed = JSON.parse(await readBody(request)) as typeof parsed;
        } catch (error) {
          jsonResponse(response, error instanceof BodyTooLargeError ? 413 : 400, { error: error instanceof BodyTooLargeError ? "request body too large" : "invalid JSON body" });
          return;
        }
        try {
          const settings = await enqueueWrite(async () => {
            const default_handoff_path = await validatedHandoffPath(parsed.defaultHandoffPath);
            const next = { default_handoff_path };
            await writeJsonAtomic(settingsPath, next);
            return next;
          });
          jsonResponse(response, 200, settings);
        } catch (error) {
          jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (pathname === "/api/export" && request.method === "POST") {
        if (!manifest || !manifestSha256) {
          jsonResponse(response, 404, { error: "review manifest unavailable" });
          return;
        }
        let parsed: { mode?: unknown; audience?: unknown; fileFormat?: unknown; destinationPath?: unknown } = {};
        try {
          const body = await readBody(request);
          if (body.trim()) parsed = JSON.parse(body) as typeof parsed;
        } catch (error) {
          jsonResponse(response, error instanceof BodyTooLargeError ? 413 : 400, { error: error instanceof BodyTooLargeError ? "request body too large" : "invalid JSON body" });
          return;
        }
        if (parsed.mode !== undefined && parsed.mode !== "generate" && parsed.mode !== "save") {
          jsonResponse(response, 400, { error: "export mode must be generate or save" });
          return;
        }
        if (parsed.audience !== undefined && parsed.audience !== "human" && parsed.audience !== "ai") {
          jsonResponse(response, 400, { error: "handoff audience must be human or ai" });
          return;
        }
        if (
          parsed.fileFormat !== undefined &&
          parsed.fileFormat !== "txt" &&
          parsed.fileFormat !== "pdf" &&
          parsed.fileFormat !== "json"
        ) {
          jsonResponse(response, 400, { error: "handoff file format must be txt, pdf, or json" });
          return;
        }
        try {
          const exported = await enqueueWrite(async () => {
            const prepared = await prepareExportContent();
            const audience = (parsed.audience ?? "ai") as HandoffAudience;
            const content = audience === "human" ? prepared.humanContent : prepared.content;
            if (parsed.mode === "generate") {
              return {
                mode: "generate",
                audience,
                ...(audience === "ai" ? {
                  export_id: prepared.identity.export_id,
                  exported_at: prepared.identity.exported_at,
                  review_state_sha256: prepared.reviewDigest,
                } : {}),
                content,
              };
            }
            if (parsed.mode === "save") {
              const format = audience === "ai" ? "json" : (parsed.fileFormat ?? "txt") as HandoffFileFormat;
              if (audience === "ai" && parsed.fileFormat !== undefined && parsed.fileFormat !== "json") {
                throw new Error("AI handoffs save as JSON");
              }
              if (audience === "human" && format !== "txt" && format !== "pdf") {
                throw new Error("Human handoffs save as TXT or PDF");
              }
              const savedPath = await validatedHandoffPath(parsed.destinationPath, format);
              const savedContent = audience === "human" && format === "pdf"
                ? await createHumanHandoffPdf({
                    manifest: manifest!,
                    reviewState: prepared.state,
                    reportRoot: root,
                    content: prepared.humanContent,
                  })
                : content;
              await writeHandoffFile(savedPath, savedContent);
              return {
                mode: "save",
                audience,
                file_format: format,
                ...(audience === "ai" ? {
                  export_id: prepared.identity.export_id,
                  exported_at: prepared.identity.exported_at,
                  review_state_sha256: prepared.reviewDigest,
                } : {}),
                saved_path: savedPath,
              };
            }
            const result = await createPortableBundle({
              reportRoot: root,
              bundleParent: handoffsPath,
              manifest,
              manifestSha256,
              reviewState: prepared.state,
              identity: prepared.identity,
            });
            return {
              export_id: prepared.identity.export_id,
              exported_at: prepared.identity.exported_at,
              review_state_sha256: prepared.reviewDigest,
              bundle_path: result.bundleRoot,
              json_path: join(result.bundleRoot, "change-request-export.json"),
            };
          });
          jsonResponse(response, 200, exported);
        } catch (error) {
          jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        jsonResponse(response, 405, { error: "method not allowed" });
        request.resume();
        return;
      }

      const relative = pathname.slice(1);
      if (!assetByRelativePath.has(relative)) {
        jsonResponse(response, 404, { error: "not found" });
        return;
      }
      try {
        const boundAsset = assetByRelativePath.get(relative);
        const filePath = boundAsset ? await validatedSource(root, boundAsset) : await validatedLegacyAsset(relative);
        const stats = await stat(filePath);
        if (!stats.isFile()) throw new Error("not a file");
        const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
        response.writeHead(200, { "content-type": type, "content-length": stats.size });
        if (request.method === "HEAD") response.end();
        else response.end(await readFile(filePath));
      } catch (error) {
        log(`[vqa serve] refused private asset ${relative}: ${error instanceof Error ? error.message : String(error)}`);
        jsonResponse(response, 404, { error: "not found" });
      }
    })().catch((error: unknown) => {
      log(`[vqa serve] error: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) jsonResponse(response, 500, { error: "local review service error" });
      else response.end();
    });
  });

  server.once("close", () => {
    if (idleTimer) clearTimeout(idleTimer);
    void releaseReviewLock().catch((error: unknown) => log(`[vqa serve] lock release failed: ${error instanceof Error ? error.message : String(error)}`));
  });
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(options.port, host, () => resolvePromise());
    });
  } catch (error) {
    await releaseReviewLock();
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  expectedHost = `${host}:${port}`;
  expectedOrigin = `http://${expectedHost}`;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  if (idleTimeoutMs > 0) {
    idleTimer = setTimeout(() => {
      log("[vqa serve] idle timeout reached; stopping local review service");
      server.close();
      server.closeIdleConnections();
    }, idleTimeoutMs);
    idleTimer.unref();
  }
  return { server, url: `${expectedOrigin}/#cap=${capability}` };
}
