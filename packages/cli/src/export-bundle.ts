import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { isLinkFreeExistingPath, renderHumanHandoffPdf } from "@vqa/engine";
import type {
  CaptureReview,
  ExportIdentity,
  PortableBundleAsset,
  PortableBundleCoordinate,
  PortableReviewBundle,
  ReviewAsset,
  ReviewManifest,
  ReviewState,
} from "@vqa/contract";

export const EXPORT_POLICY_ID = "vq-export-identity-v1" as const;

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortedValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedValue(value))}\n`;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function reviewProjection(
  manifest: ReviewManifest,
  manifestSha256: string,
  state: ReviewState,
): unknown {
  const captures = Object.values(state.captures)
    .map((capture) => ({
      coordinate_id: capture.coordinate_id,
      classification: capture.classification,
      ...(capture.updated_at ? { updated_at: capture.updated_at } : {}),
      ...(capture.issue_highlights ? { issue_highlights: capture.issue_highlights } : {}),
      ...(capture.requested_change
        ? {
            requested_change: {
              ...capture.requested_change,
              affected_coordinate_ids: [
                ...capture.requested_change.affected_coordinate_ids,
              ].sort(),
              selected_issue_ids: [...capture.requested_change.selected_issue_ids].sort(),
            },
          }
        : {}),
    }))
    .sort((left, right) => left.coordinate_id.localeCompare(right.coordinate_id));
  const referenced = new Set<string>();
  for (const capture of captures) {
    if (!capture.requested_change) continue;
    for (const coordinateId of capture.requested_change.affected_coordinate_ids) {
      const coordinate = manifest.captures.find(
        (candidate) => candidate.coordinate_id === coordinateId,
      );
      if (!coordinate) continue;
      referenced.add(coordinate.full_asset_id);
      for (const issueId of coordinate.issue_ids) {
        const issue = manifest.issues.find((candidate) => candidate.id === issueId);
        if (issue?.crop_asset_id) referenced.add(issue.crop_asset_id);
      }
    }
  }
  const assets = manifest.assets
    .filter((asset) => referenced.has(asset.id))
    .map(({ sha256: digest, media_type, byte_length }) => ({
      sha256: digest,
      media_type,
      byte_length,
    }))
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  return {
    export_policy_id: EXPORT_POLICY_ID,
    export_schema_version: 1,
    manifest_id: manifest.manifest_id,
    manifest_sha256: manifestSha256,
    source_report: manifest.source_report,
    audit_verdict: manifest.audit_verdict,
    captures,
    assets,
  };
}

export function reviewStateSha256(
  manifest: ReviewManifest,
  manifestSha256: string,
  state: ReviewState,
): string {
  return sha256(canonicalJson(reviewProjection(manifest, manifestSha256, state)));
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    /%2f|%5c/i.test(relativePath) ||
    /^[a-z][a-z0-9+.-]*:/i.test(relativePath)
  ) {
    throw new Error(`unsafe asset path: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe asset path: ${relativePath}`);
  }
}

function uniqueIds<T extends { id: string }>(kind: string, values: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (!value.id || result.has(value.id)) throw new Error(`duplicate or empty ${kind} id: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

export function validateReviewManifest(manifest: ReviewManifest): void {
  if (manifest.artifact_type !== "vq-review-manifest" || manifest.schema_version !== 1) {
    throw new Error("unsupported review manifest");
  }
  const pages = uniqueIds("page", manifest.pages);
  const states = uniqueIds("state", manifest.states);
  const assets = uniqueIds("asset", manifest.assets);
  const issues = uniqueIds("issue", manifest.issues);
  const coordinates = new Map(manifest.captures.map((capture) => [capture.coordinate_id, capture]));
  if (coordinates.size !== manifest.captures.length || manifest.captures.some((capture) => !capture.coordinate_id)) {
    throw new Error("duplicate or empty review coordinate");
  }
  for (const asset of manifest.assets) {
    assertSafeRelativePath(asset.source_relative_path);
    if (
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byte_length) || asset.byte_length < 1 ||
      !Number.isSafeInteger(asset.width) || asset.width < 1 ||
      !Number.isSafeInteger(asset.height) || asset.height < 1
    ) {
      throw new Error(`invalid asset identity: ${asset.id}`);
    }
    if (asset.kind === "full-screenshot" && asset.issue_id !== undefined) {
      throw new Error(`full screenshot cannot name an issue: ${asset.id}`);
    }
    if (asset.kind === "issue-crop" && (!asset.issue_id || !issues.has(asset.issue_id))) {
      throw new Error(`crop has unknown issue: ${asset.id}`);
    }
  }
  for (const capture of manifest.captures) {
    if (!pages.has(capture.page_id) || !states.has(capture.state_id)) {
      throw new Error(`capture has unknown page or state: ${capture.coordinate_id}`);
    }
    const full = assets.get(capture.full_asset_id);
    if (!full || full.kind !== "full-screenshot" || full.coordinate_id !== capture.coordinate_id) {
      throw new Error(`capture has misbound full screenshot: ${capture.coordinate_id}`);
    }
    if (new Set(capture.issue_ids).size !== capture.issue_ids.length) {
      throw new Error(`capture has duplicate issues: ${capture.coordinate_id}`);
    }
    for (const issueId of capture.issue_ids) {
      const issue = issues.get(issueId);
      if (!issue || !issue.capture_coordinate_ids.includes(capture.coordinate_id)) {
        throw new Error(`capture has misbound issue: ${capture.coordinate_id}/${issueId}`);
      }
    }
  }
  for (const issue of manifest.issues) {
    if (issue.confidence && !["high", "needs-confirmation", "likely-noise"].includes(issue.confidence)) {
      throw new Error(`issue has invalid confidence: ${issue.id}`);
    }
    if (new Set(issue.capture_coordinate_ids).size !== issue.capture_coordinate_ids.length) {
      throw new Error(`issue has duplicate captures: ${issue.id}`);
    }
    for (const coordinateId of issue.capture_coordinate_ids) {
      const capture = coordinates.get(coordinateId);
      if (!capture || !capture.issue_ids.includes(issue.id)) {
        throw new Error(`issue has asymmetric capture binding: ${issue.id}/${coordinateId}`);
      }
    }
    if (issue.crop_asset_id) {
      const crop = assets.get(issue.crop_asset_id);
      if (!crop || crop.kind !== "issue-crop" || crop.issue_id !== issue.id || !issue.capture_coordinate_ids.includes(crop.coordinate_id)) {
        throw new Error(`issue has misbound crop: ${issue.id}`);
      }
    }
    if (issue.occurrences) {
      if (issue.occurrence_count !== undefined && issue.occurrence_count !== issue.occurrences.length) {
        throw new Error(`issue occurrence count does not match evidence: ${issue.id}`);
      }
      for (const occurrence of issue.occurrences) {
        if (!issue.capture_coordinate_ids.includes(occurrence.capture_coordinate_id)) {
          throw new Error(`issue occurrence has unknown capture: ${issue.id}`);
        }
        if (!occurrence.technical_locator || !occurrence.semantic_name) {
          throw new Error(`issue occurrence is missing identity: ${issue.id}`);
        }
        if (occurrence.crop_asset_id) {
          const crop = assets.get(occurrence.crop_asset_id);
          if (!crop || crop.kind !== "issue-crop" || crop.issue_id !== issue.id || crop.coordinate_id !== occurrence.capture_coordinate_id) {
            throw new Error(`issue occurrence has misbound crop: ${issue.id}`);
          }
        }
      }
    }
  }
}

async function digestFile(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      byteLength += chunk.length;
      hash.update(chunk);
    });
    stream.on("end", resolvePromise);
    stream.on("error", rejectPromise);
  });
  return { sha256: hash.digest("hex"), byteLength };
}

function extensionFor(asset: ReviewAsset): "png" | "jpg" {
  if (asset.media_type === "image/png") return "png";
  if (asset.media_type === "image/jpeg") return "jpg";
  throw new Error(`unsupported asset media type: ${String(asset.media_type)}`);
}

export async function validatedSource(reportRoot: string, asset: ReviewAsset): Promise<string> {
  assertSafeRelativePath(asset.source_relative_path);
  if (!/^[0-9a-f]{64}$/.test(asset.sha256)) {
    throw new Error(`invalid asset digest: ${asset.id}`);
  }
  const rootReal = resolve(reportRoot);
  if (!await isLinkFreeExistingPath(rootReal)) throw new Error("report root must not resolve through a symlink");
  const source = resolve(reportRoot, asset.source_relative_path);
  if (source !== rootReal && !source.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`asset escapes report root: ${asset.id}`);
  }
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`asset is not a regular non-symlink file: ${asset.id}`);
  }
  if (!await isLinkFreeExistingPath(source)) {
    throw new Error(`asset real path escapes report root: ${asset.id}`);
  }
  const actual = await digestFile(source);
  if (actual.byteLength !== asset.byte_length || actual.sha256 !== asset.sha256) {
    throw new Error(`asset hash or length mismatch: ${asset.id}`);
  }
  const header = await readFile(source);
  if (asset.media_type === "image/png" && !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`asset media type mismatch: ${asset.id}`);
  }
  if (asset.media_type === "image/jpeg" && !(header[0] === 0xff && header[1] === 0xd8)) {
    throw new Error(`asset media type mismatch: ${asset.id}`);
  }
  const dimensions = imageDimensions(header, asset.media_type);
  if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
    throw new Error(`asset dimension identity mismatch: ${asset.id}`);
  }
  return source;
}

function imageDimensions(bytes: Buffer, mediaType: ReviewAsset["media_type"]): { width: number; height: number } {
  if (mediaType === "image/png") {
    if (bytes.length < 24) throw new Error("truncated PNG");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG dimensions unavailable");
}

export async function validateCaptureAsset(
  reportRoot: string,
  asset: ReviewAsset,
  expected: { width: number; height: number; device_scale_factor?: number },
): Promise<string> {
  const source = await validatedSource(reportRoot, asset);
  const actual = imageDimensions(await readFile(source), asset.media_type);
  const scale = expected.device_scale_factor ?? 1;
  if (actual.width < expected.width * scale || actual.height < expected.height * scale) {
    throw new Error(`asset dimensions do not match capture: ${asset.id}`);
  }
  return source;
}

function coordinateFor(
  manifest: ReviewManifest,
  reviewState: ReviewState,
  coordinateId: string,
  selectedIssueIds: Set<string>,
): PortableBundleCoordinate {
  const capture = manifest.captures.find(
    (candidate) => candidate.coordinate_id === coordinateId,
  );
  if (!capture) throw new Error(`unknown coordinate: ${coordinateId}`);
  const page = manifest.pages.find((candidate) => candidate.id === capture.page_id);
  const state = manifest.states.find((candidate) => candidate.id === capture.state_id);
  const screenshot = manifest.assets.find(
    (candidate) => candidate.id === capture.full_asset_id,
  );
  if (!page || !state || !screenshot || screenshot.kind !== "full-screenshot") {
    throw new Error(`incomplete coordinate context: ${coordinateId}`);
  }
  const issues = capture.issue_ids.filter((issueId) => selectedIssueIds.has(issueId)).map((issueId) => {
    const issue = manifest.issues.find((candidate) => candidate.id === issueId);
    if (!issue) throw new Error(`unknown issue: ${issueId}`);
    const occurrenceCropId = issue.occurrences?.find(
      (occurrence) => occurrence.capture_coordinate_id === coordinateId && occurrence.crop_asset_id,
    )?.crop_asset_id;
    const fallbackCropId = issue.crop_asset_id && manifest.assets.find(
      (candidate) => candidate.id === issue.crop_asset_id && candidate.coordinate_id === coordinateId,
    ) ? issue.crop_asset_id : undefined;
    const cropId = occurrenceCropId ?? fallbackCropId;
    const crop = cropId
      ? manifest.assets.find((candidate) => candidate.id === cropId)
      : undefined;
    if (cropId && !crop) throw new Error(`unknown crop asset: ${cropId}`);
    const overrides = reviewState.captures[coordinateId]?.issue_highlights;
    const hasOverride = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, issueId));
    const override = hasOverride ? overrides![issueId] : undefined;
    if (override && (!Number.isFinite(override.x) || !Number.isFinite(override.y) || !Number.isFinite(override.width) || !Number.isFinite(override.height) || override.x < 0 || override.y < 0 || override.width < 16 || override.height < 16 || override.x + override.width > capture.resolution.width || override.y + override.height > capture.resolution.height)) {
      throw new Error(`invalid issue highlight: ${issueId} on ${coordinateId}`);
    }
    const detected = issue.rects?.[coordinateId];
    const highlight = override === null ? null : override ?? (detected ? {
      x: Math.max(0, detected.x - 8),
      y: Math.max(0, detected.y - 8),
      width: Math.min(capture.resolution.width, detected.x + detected.width + 8) - Math.max(0, detected.x - 8),
      height: Math.min(capture.resolution.height, detected.y + detected.height + 8) - Math.max(0, detected.y - 8),
    } : undefined);
    return {
      id: issue.id,
      type: issue.type,
      severity: issue.severity,
      title: issue.title,
      ...(issue.semantic_name ? { semantic_name: issue.semantic_name } : {}),
      ...(issue.confidence ? { confidence: issue.confidence } : {}),
      ...(issue.confidence_reasons ? { confidence_reasons: issue.confidence_reasons } : {}),
      ...(issue.observed_outcome ? { observed_outcome: issue.observed_outcome } : {}),
      ...(issue.acceptance_criterion ? { acceptance_criterion: issue.acceptance_criterion } : {}),
      affected_coordinate_ids: issue.capture_coordinate_ids,
      ...(issue.occurrence_count ? { occurrence_count: issue.occurrence_count } : {}),
      description: issue.description,
      selector: issue.selector,
      ...(issue.other_selector ? { other_selector: issue.other_selector } : {}),
      heuristic_suggestion: issue.heuristic_suggestion,
      ai_recommendation_status: issue.ai_recommendation_status,
      ...(crop ? { crop_asset_sha256: crop.sha256 } : {}),
      ...(highlight ? { highlight_rect: highlight } : {}),
      ...(override === null ? { highlight_removed: true as const } : {}),
    };
  });
  return {
    coordinate_id: coordinateId,
    page,
    state,
    resolution: capture.resolution,
    full_screenshot_asset_sha256: screenshot.sha256,
    issues,
  };
}

function requestedReviews(state: ReviewState): CaptureReview[] {
  const requests = Object.values(state.captures)
    .filter((capture) => capture.classification === "bad" && capture.requested_change)
    .sort((left, right) => left.coordinate_id.localeCompare(right.coordinate_id));
  if (requests.length === 0) throw new Error("no complete change requests to export");
  return requests;
}

export function isUsefulReviewerOutcome(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 12 && trimmed.split(/\s+/u).filter(Boolean).length >= 3 && /[a-z]/iu.test(trimmed);
}

function containsTechnicalLocator(value: string, issue: ReviewManifest["issues"][number]): boolean {
  const technical = [issue.selector, issue.other_selector, issue.technical_locator]
    .filter((candidate): candidate is string => Boolean(candidate));
  return /:nth-child\(|(?:^|\s)>\s|#[a-z_-]|\[[^\]]+[=\]]/iu.test(value) ||
    technical.some((candidate) => candidate.length > 2 && value.includes(candidate));
}

function boundedHumanText(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function humanIssueTitle(issue: ReviewManifest["issues"][number]): string {
  if (issue.title.trim() && !containsTechnicalLocator(issue.title, issue)) {
    return boundedHumanText(issue.title, 110);
  }
  if (issue.semantic_name?.trim() && !containsTechnicalLocator(issue.semantic_name, issue)) {
    return boundedHumanText(`${issue.semantic_name.trim()}: visual concern`, 110);
  }
  return `${issue.type.replace(/-/gu, " ")}: visual concern`;
}

function safeHumanIssueText(
  value: string | undefined,
  issue: ReviewManifest["issues"][number],
  fallback: string,
  title: string,
): string {
  const candidate = value?.trim();
  return candidate && candidate !== title && candidate !== issue.title.trim() && !containsTechnicalLocator(candidate, issue)
    ? boundedHumanText(candidate, 240)
    : fallback;
}

export interface HumanHandoffContentOptions {
  manifest: ReviewManifest;
  reviewState: ReviewState;
}

export function createHumanHandoffContent(options: HumanHandoffContentOptions): string {
  const { manifest, reviewState } = options;
  validateReviewManifest(manifest);
  const requests = requestedReviews(reviewState);
  const lines = ["VISUAL QA HANDOFF", "", "REVIEWER-APPROVED WORK", ""];
  requests.forEach((captureReview, index) => {
    const request = captureReview.requested_change!;
    if(!isUsefulReviewerOutcome(request.requested_change)||request.affected_coordinate_ids.length===0)throw new Error(`a useful reviewer-authored outcome is required: ${captureReview.coordinate_id}`);
    const affected = request.affected_coordinate_ids.map((coordinateId) => {
      const capture = manifest.captures.find((candidate) => candidate.coordinate_id === coordinateId);
      if (!capture) throw new Error(`unknown coordinate: ${coordinateId}`);
      return capture;
    });
    const applicable = new Set(affected.flatMap((capture) => capture.issue_ids));
    if (
      new Set(request.selected_issue_ids).size !== request.selected_issue_ids.length ||
      request.selected_issue_ids.some((issueId) => !applicable.has(issueId))
    ) {
      throw new Error("attached detected issue is not part of the affected screenshots");
    }
    lines.push(`CHANGE REQUEST ${index + 1}`, "");
    lines.push("Requested outcome",request.requested_change.trim(),"");
    lines.push("Affected pages and sizes","");
    const pages = new Map<string, { label: string; url: string; sizes: string[] }>();
    affected.forEach((capture) => {
      const page = manifest.pages.find((candidate) => candidate.id === capture.page_id)!;
      const entry = pages.get(page.id) ?? { label: page.label, url: page.url, sizes: [] };
      if (!entry.sizes.includes(capture.resolution.label)) entry.sizes.push(capture.resolution.label);
      pages.set(page.id, entry);
    });
    [...pages.values()]
      .sort((left, right) => left.label.localeCompare(right.label) || left.url.localeCompare(right.url))
      .forEach((page) => {
        lines.push(page.label, `Source: ${page.url}`, `Sizes: ${page.sizes.sort().join(", ")}`, "");
      });
    lines.push("Approved concerns", "");
    const issues = request.selected_issue_ids
      .map((issueId) => manifest.issues.find((issue) => issue.id === issueId)!)
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    if (issues.length === 0) {
      lines.push("No machine suggestion was promoted; the reviewer-authored outcome above is the approved work.");
    } else {
      issues.forEach((issue) => {
        const title = humanIssueTitle(issue);
        const affectedSizes = affected
          .filter((capture) => issue.capture_coordinate_ids.includes(capture.coordinate_id))
          .map((capture) => capture.resolution.label)
          .filter((value, position, values) => values.indexOf(value) === position)
          .sort();
        const observed = safeHumanIssueText(
          issue.observed_outcome ?? issue.description,
          issue,
          "The reviewer confirmed the visible concern in the affected screenshots.",
          title,
        );
        const criterion = safeHumanIssueText(
          issue.acceptance_criterion,
          issue,
          "The approved outcome is visibly satisfied at every affected size.",
          title,
        );
        lines.push(
          title,
          `Observed: ${observed}`,
          `Affected sizes: ${affectedSizes.join(", ") || "reviewer-selected sizes"}`,
          `Confidence: ${(issue.confidence ?? (issue.severity === "high" ? "high" : "needs-confirmation")).replace(/-/gu, " ")}`,
          `Acceptance criterion: ${criterion}`,
          "",
        );
      });
    }
    lines.push("");
  });
  lines.push("MACHINE SUGGESTIONS — NOT APPROVED WORK", "", "Unselected machine suggestions are not included in this handoff.");
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface HumanHandoffPdfOptions extends HumanHandoffContentOptions {
  reportRoot: string;
  content: string;
}

export async function createHumanHandoffPdf(options: HumanHandoffPdfOptions): Promise<Buffer> {
  const { manifest, reviewState, reportRoot, content } = options;
  const captures = new Map<string, ReviewManifest["captures"][number]>();
  for (const review of requestedReviews(reviewState)) {
    for (const coordinateId of review.requested_change!.affected_coordinate_ids) {
      const capture = manifest.captures.find((candidate) => candidate.coordinate_id === coordinateId);
      if (!capture) throw new Error(`unknown coordinate: ${coordinateId}`);
      captures.set(coordinateId, capture);
    }
  }
  const images: Array<{
    label: string;
    mediaType: "image/png" | "image/jpeg";
    base64: string;
  }> = [];
  for (const capture of [...captures.values()].sort((left, right) =>
    left.coordinate_id.localeCompare(right.coordinate_id))) {
    const page = manifest.pages.find((candidate) => candidate.id === capture.page_id)!;
    const asset = manifest.assets.find((candidate) => candidate.id === capture.full_asset_id)!;
    const source = await validatedSource(reportRoot, asset);
    const bytes = await readFile(source);
    images.push({
      label: `${page.label} — ${capture.resolution.label}`,
      mediaType: asset.media_type,
      base64: bytes.toString("base64"),
    });
  }
  return renderHumanHandoffPdf({ content, images });
}

async function validatePublishedBundle(path: string, json: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("bundle target is unsafe");
  const existing = await readFile(join(path, "change-request-export.json"), "utf8");
  if (existing !== json) throw new Error("existing bundle conflicts with reserved identity");
  const parsed = JSON.parse(existing) as PortableReviewBundle;
  for (const asset of parsed.assets) {
    if (!/^assets\/[0-9a-f]{64}\.(png|jpg)$/.test(asset.path)) {
      throw new Error(`unsafe published asset path: ${asset.path}`);
    }
    const actual = await digestFile(join(path, asset.path));
    if (actual.sha256 !== asset.sha256 || actual.byteLength !== asset.byte_length) {
      throw new Error(`published asset mismatch: ${asset.sha256}`);
    }
  }
}

export interface CreatePortableBundleOptions {
  reportRoot: string;
  bundleParent: string;
  manifest: ReviewManifest;
  manifestSha256: string;
  reviewState: ReviewState;
  identity: ExportIdentity;
}

export type PortableBundleContentOptions = Omit<
  CreatePortableBundleOptions,
  "reportRoot" | "bundleParent"
>;

function preparePortableBundleContent(options: PortableBundleContentOptions): {
  json: string;
  bundle: PortableReviewBundle;
  referencedAssets: Map<string, ReviewAsset>;
} {
  const { manifest, manifestSha256, reviewState, identity } = options;
  validateReviewManifest(manifest);
  const digest = reviewStateSha256(manifest, manifestSha256, reviewState);
  if (
    identity.policy_id !== EXPORT_POLICY_ID ||
    identity.manifest_sha256 !== manifestSha256 ||
    identity.review_state_sha256 !== digest ||
    identity.export_id !== `vqexp-v1-${digest}`
  ) {
    throw new Error("export identity does not match review state");
  }

  const requestReviews = requestedReviews(reviewState);
  const referencedAssets = new Map<string, ReviewAsset>();
  const requests = requestReviews.map((captureReview) => {
    const request = captureReview.requested_change!;
    if (!isUsefulReviewerOutcome(request.requested_change) || request.affected_coordinate_ids.length === 0) {
      throw new Error(`a useful reviewer-authored outcome is required: ${captureReview.coordinate_id}`);
    }
    if (new Set(request.selected_issue_ids).size !== request.selected_issue_ids.length) {
      throw new Error(`duplicate selected issue: ${captureReview.coordinate_id}`);
    }
    const affectedCaptures = request.affected_coordinate_ids.map((coordinateId) => {
      const capture = manifest.captures.find((candidate) => candidate.coordinate_id === coordinateId);
      if (!capture) throw new Error(`unknown coordinate: ${coordinateId}`);
      return capture;
    });
    const selectable = new Set(affectedCaptures.flatMap((capture) => capture.issue_ids));
    if (request.selected_issue_ids.some((issueId) => !selectable.has(issueId))) {
      throw new Error(`selected issue is not part of the affected screenshots: ${captureReview.coordinate_id}`);
    }
    const affectedCoordinates = [...new Set(request.affected_coordinate_ids)]
      .sort()
      .map((coordinateId) => coordinateFor(manifest, reviewState, coordinateId, new Set(request.selected_issue_ids)));
    for (const coordinate of affectedCoordinates) {
      const capture = manifest.captures.find(
        (candidate) => candidate.coordinate_id === coordinate.coordinate_id,
      )!;
      const full = manifest.assets.find((candidate) => candidate.id === capture.full_asset_id)!;
      referencedAssets.set(full.sha256, full);
      for (const issue of coordinate.issues) {
        if (!issue.crop_asset_sha256) continue;
        const crop = manifest.assets.find(
          (candidate) => candidate.sha256 === issue.crop_asset_sha256,
        );
        if (!crop) throw new Error(`missing crop asset: ${issue.crop_asset_sha256}`);
        referencedAssets.set(crop.sha256, crop);
      }
    }
    return {
      request_id: request.request_id,
      classification: "bad" as const,
      requested_change: request.requested_change,
      authorship: request.authorship,
      created_at: request.created_at,
      updated_at: request.updated_at,
      origin_coordinate_id: request.origin_coordinate_id,
      affected_coordinates: affectedCoordinates,
    };
  });

  const assets: PortableBundleAsset[] = [...referencedAssets.values()]
    .sort((left, right) => left.sha256.localeCompare(right.sha256))
    .map((asset) => ({
      sha256: asset.sha256,
      path: `assets/${asset.sha256}.${extensionFor(asset)}`,
      media_type: asset.media_type,
      byte_length: asset.byte_length,
    }));
  const bundle: PortableReviewBundle = {
    artifact_type: "viewport-qa-change-request-bundle",
    schema_version: 1,
    export_policy_id: EXPORT_POLICY_ID,
    export_id: identity.export_id,
    exported_at: identity.exported_at,
    review_state_sha256: digest,
    source_report: { ...manifest.source_report, manifest_sha256: manifestSha256, run_id: manifest.run_id },
    audit_verdict: manifest.audit_verdict,
    assets,
    requests,
  };
  const json = canonicalJson(bundle);
  return { json, bundle, referencedAssets };
}

export function createPortableBundleContent(
  options: PortableBundleContentOptions,
): { json: string; bundle: PortableReviewBundle } {
  const { json, bundle } = preparePortableBundleContent(options);
  return { json, bundle };
}

export async function createPortableBundle(
  options: CreatePortableBundleOptions,
): Promise<{ bundleRoot: string; json: string; bundle: PortableReviewBundle }> {
  const { json, bundle, referencedAssets } = preparePortableBundleContent(options);
  const reportRootReal = resolve(options.reportRoot);
  if (!await isLinkFreeExistingPath(reportRootReal)) throw new Error("report root is unsafe");
  const bundleParent = resolve(options.bundleParent);
  if (!bundleParent.startsWith(`${reportRootReal}${sep}`)) throw new Error("bundle parent escapes report root");
  try {
    const parentStats = await lstat(bundleParent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error("bundle parent is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(bundleParent);
  }
  if (!await isLinkFreeExistingPath(bundleParent)) {
    throw new Error("bundle parent real path escapes report root");
  }
  const target = join(bundleParent, options.identity.export_id);
  try {
    await validatePublishedBundle(target, json);
    return { bundleRoot: target, json, bundle };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = await mkdtemp(join(bundleParent, ".vq-export-"));
  try {
    const temporaryAssets = join(temporary, "assets");
    await mkdir(temporaryAssets);
    for (const exported of bundle.assets) {
      const sourceAsset = referencedAssets.get(exported.sha256)!;
      const source = await validatedSource(options.reportRoot, sourceAsset);
      const destination = join(temporary, exported.path);
      if (basename(destination) !== `${exported.sha256}.${extensionFor(sourceAsset)}`) {
        throw new Error(`invalid destination for asset: ${sourceAsset.id}`);
      }
      await copyFile(source, destination);
      const copied = await digestFile(destination);
      if (copied.sha256 !== exported.sha256 || copied.byteLength !== exported.byte_length) {
        throw new Error(`copied asset mismatch: ${sourceAsset.id}`);
      }
    }
    await writeFile(join(temporary, "change-request-export.json"), json, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await validatePublishedBundle(target, json);
      return { bundleRoot: target, json, bundle };
    }
    throw error;
  }
  await validatePublishedBundle(target, json);
  return { bundleRoot: target, json, bundle };
}
