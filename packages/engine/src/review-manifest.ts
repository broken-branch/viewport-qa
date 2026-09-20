import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  BEHAVIOUR_ISSUE_TYPES,
  REPORT_FORMAT_VERSION,
  REVIEW_MANIFEST_SCHEMA_VERSION,
  REVIEW_STATE_SCHEMA_VERSION,
} from "@vqa/contract";
import type {
  Issue,
  AuditVerdictValue,
  IssueConfidence,
  Report,
  ReviewAsset,
  ReviewManifest,
  ReviewManifestCapture,
  ReviewManifestIssue,
  ReviewManifestPage,
  ReviewState,
  ViewportResult,
} from "@vqa/contract";
import {
  acceptanceCriterion,
  defaultConfidence,
  observedOutcome,
  semanticTitle,
} from "./issue-semantics.js";
import {
  semanticFingerprintBase,
  semanticFingerprintIsAmbiguous,
} from "./collector.js";

const AMBIGUOUS_IDENTITY_REASON =
  "Semantic identity is ambiguous across captures because repeated peers lack stable distinguishing attributes; this occurrence was not grouped across sizes.";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}-${sha256(JSON.stringify(parts)).slice(0, 20)}`;
}

function pageLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "Local page");
    }
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

async function imageAsset(
  reportDir: string,
  input: Omit<ReviewAsset, "byte_length" | "sha256" | "width" | "height">,
): Promise<ReviewAsset> {
  const bytes = await readFile(join(reportDir, input.source_relative_path));
  const image = PNG.sync.read(bytes);
  return {
    ...input,
    byte_length: bytes.byteLength,
    sha256: sha256(bytes),
    width: image.width,
    height: image.height,
  };
}

function successfulPages(report: Report): Array<{
  url: string;
  scenarioLabel?: string;
  viewports: ViewportResult[];
  issues: Issue[];
}> {
  if (report.pages) {
    return report.pages
      .filter((page) => page.status === "success")
      .map((page) => ({
        url: page.url,
        ...(page.scenarioLabel ? { scenarioLabel: page.scenarioLabel } : {}),
        viewports: page.viewports,
        issues: page.issues,
      }));
  }
  return [{ url: report.url, viewports: report.viewports, issues: report.issues }];
}

export async function buildReviewManifest(
  report: Report,
  reportDir: string,
): Promise<ReviewManifest> {
  const pages: ReviewManifestPage[] = [];
  const assets: ReviewAsset[] = [];
  const issues: ReviewManifestIssue[] = [];
  const captures: ReviewManifestCapture[] = [];
  const states = new Map<string, ReviewManifest["states"][number]>();
  const groupIdByIssueId = new Map(
    (report.groups ?? []).flatMap((group) =>
      group.issueIds.map((issueId) => [issueId, group.id] as const),
    ),
  );

  const familyByKey = new Map<string, ReviewManifestIssue>();
  const captureByPageViewport = new Map<string, ReviewManifestCapture>();
  const severityRank = { high: 2, medium: 1, low: 0 } as const;
  const confidenceRank: Record<IssueConfidence, number> = {
    high: 2,
    "needs-confirmation": 1,
    "likely-noise": 0,
  };

  for (const page of successfulPages(report)) {
    const pageId = stableId("page", [page.url]);
    const stateId = page.scenarioLabel
      ? stableId("state", [page.scenarioLabel])
      : "state-captured";
    states.set(stateId, {
      id: stateId,
      label: page.scenarioLabel ?? "",
      arrangement_provenance: page.scenarioLabel ? "scenario-recipe" : "production-scan",
    });
    const ambiguousFingerprintBases = new Set<string>();
    for (const issue of page.issues) {
      const fingerprints = [
        issue.elementFingerprint,
        issue.otherElementFingerprint,
        ...(issue.occurrences ?? []).flatMap((occurrence) => [
          occurrence.elementFingerprint,
          occurrence.otherElementFingerprint,
        ]),
      ].filter((fingerprint): fingerprint is string => Boolean(fingerprint));
      for (const fingerprint of fingerprints) {
        if (semanticFingerprintIsAmbiguous(fingerprint)) {
          ambiguousFingerprintBases.add(semanticFingerprintBase(fingerprint));
        }
      }
    }
    if (!pages.some((entry) => entry.id === pageId)) {
      pages.push({ id: pageId, label: pageLabel(page.url), url: page.url });
    }
    for (const viewport of page.viewports) {
      const coordinateId = stableId("capture", [
        page.url,
        page.scenarioLabel ?? "",
        viewport.viewport.width,
        viewport.viewport.height,
        viewport.viewport.deviceScaleFactor,
      ]);
      const fullAssetId = `asset-${coordinateId}-full`;
      assets.push(await imageAsset(reportDir, {
        id: fullAssetId,
        kind: "full-screenshot",
        coordinate_id: coordinateId,
        source_relative_path: viewport.screenshot,
        media_type: "image/png",
      }));

      const capture: ReviewManifestCapture = {
        coordinate_id: coordinateId,
        page_id: pageId,
        state_id: stateId,
        resolution: {
          label: viewport.viewport.label,
          width: viewport.viewport.width,
          height: viewport.viewport.height,
          device_scale_factor: viewport.viewport.deviceScaleFactor,
        },
        full_asset_id: fullAssetId,
        issue_ids: [],
        expected_verdict: "PASS",
        reason_codes: ["NO_HIGH_CONFIDENCE_CONCERNS"],
      };
      captures.push(capture);
      captureByPageViewport.set(
        `${page.url}\u0000${page.scenarioLabel ?? ""}\u0000${viewport.viewport.label}`,
        capture,
      );
    }

    for (const issue of page.issues) {
      const capture = captureByPageViewport.get(
        `${page.url}\u0000${page.scenarioLabel ?? ""}\u0000${issue.viewport}`,
      );
      if (!capture) continue;
      const primaryFingerprint = issue.elementFingerprint ?? `locator:${issue.selector}`;
      const secondaryFingerprint = issue.otherElementFingerprint ??
        (issue.otherSelector ? `locator:${issue.otherSelector}` : "");
      const primaryBase = semanticFingerprintBase(primaryFingerprint);
      const secondaryBase = semanticFingerprintBase(secondaryFingerprint);
      const identityAmbiguous = ambiguousFingerprintBases.has(primaryBase) ||
        (Boolean(secondaryFingerprint) && ambiguousFingerprintBases.has(secondaryBase));
      const identityParts = identityAmbiguous
        ? [capture.coordinate_id, primaryFingerprint, secondaryFingerprint]
        : primaryBase <= secondaryBase
          ? [primaryBase, secondaryBase]
          : [secondaryBase, primaryBase];
      const familyKey = JSON.stringify([page.url, page.scenarioLabel ?? "", issue.type, ...identityParts]);
      const familyId = stableId("concern", [page.url, page.scenarioLabel ?? "", issue.type, ...identityParts]);
      const detectorConfidence = issue.confidence ?? defaultConfidence(issue.type, issue.severity);
      const confidence = identityAmbiguous && confidenceRank[detectorConfidence] > confidenceRank["needs-confirmation"]
        ? "needs-confirmation"
        : detectorConfidence;
      const confidenceReasons = [
        ...(issue.confidenceReasons ?? []),
        ...(identityAmbiguous ? [AMBIGUOUS_IDENTITY_REASON] : []),
      ];
      const title = semanticTitle(issue);
      const description = observedOutcome(issue);
      const presentationGroupId = groupIdByIssueId.get(issue.id);
      let family = familyByKey.get(familyKey);
      if (!family) {
        family = {
          id: familyId,
          title,
          type: issue.type,
          finding_kind: BEHAVIOUR_ISSUE_TYPES.includes(issue.type as (typeof BEHAVIOUR_ISSUE_TYPES)[number])
            ? "behaviour"
            : "visual",
          severity: issue.severity,
          description: description === title ? `${description} Review the affected sizes below.` : description,
          semantic_name: issue.semanticName ?? "page content",
          element_fingerprint: primaryBase,
          technical_locator: issue.technicalLocator ?? issue.selector,
          confidence,
          confidence_reasons: [...new Set(confidenceReasons)],
          observed_outcome: description,
          acceptance_criterion: acceptanceCriterion(issue),
          occurrence_count: 0,
          ...(presentationGroupId ? { group_ids: [presentationGroupId] } : {}),
          occurrences: [],
          selector: issue.selector,
          ...(issue.otherSelector ? { other_selector: issue.otherSelector } : {}),
          capture_coordinate_ids: [],
          rects: {},
          heuristic_suggestion: issue.heuristicSuggestion.text,
          ai_recommendation_status: issue.aiRecommendation.status === "ok"
            ? { status: "ok", text: issue.aiRecommendation.text, model: issue.aiRecommendation.model }
            : { status: "unavailable", reason: issue.aiRecommendation.reason },
        };
        familyByKey.set(familyKey, family);
      } else {
        if (severityRank[issue.severity] > severityRank[family.severity]) family.severity = issue.severity;
        if (confidenceRank[confidence] > confidenceRank[family.confidence ?? "likely-noise"]) family.confidence = confidence;
        family.confidence_reasons = [
          ...new Set([...(family.confidence_reasons ?? []), ...confidenceReasons]),
        ];
        if (issue.aiRecommendation.status === "ok" && family.ai_recommendation_status.status !== "ok") {
          family.ai_recommendation_status = {
            status: "ok",
            text: issue.aiRecommendation.text,
            model: issue.aiRecommendation.model,
          };
        }
        if (
          presentationGroupId &&
          !family.group_ids?.includes(presentationGroupId)
        ) {
          family.group_ids = [...(family.group_ids ?? []), presentationGroupId];
        }
      }

      let cropAssetId: string | undefined;
      if (issue.screenshots.crop) {
        cropAssetId = stableId("asset", [family.id, capture.coordinate_id, issue.id, "crop"]);
        assets.push(await imageAsset(reportDir, {
          id: cropAssetId,
          kind: "issue-crop",
          coordinate_id: capture.coordinate_id,
          issue_id: family.id,
          source_relative_path: issue.screenshots.crop,
          media_type: "image/png",
        }));
        family.crop_asset_id ??= cropAssetId;
      }
      if (!family.capture_coordinate_ids.includes(capture.coordinate_id)) {
        family.capture_coordinate_ids.push(capture.coordinate_id);
      }
      family.rects![capture.coordinate_id] ??= issue.rect;
      const occurrenceSource = issue.occurrences?.length
        ? issue.occurrences
        : [{
            semanticName: issue.semanticName ?? "page content",
            elementFingerprint: primaryFingerprint,
            technicalLocator: issue.technicalLocator ?? issue.selector,
            ...(issue.otherSelector
              ? {
                  otherSemanticName: issue.otherSemanticName ?? "related content",
                  otherElementFingerprint: secondaryFingerprint,
                  otherTechnicalLocator: issue.otherTechnicalLocator ?? issue.otherSelector,
                }
              : {}),
            rect: issue.rect,
          }];
      occurrenceSource.forEach((occurrence, index) => {
        family!.occurrences!.push({
          capture_coordinate_id: capture.coordinate_id,
          rect: occurrence.rect,
          message: issue.description,
          semantic_name: occurrence.semanticName,
          technical_locator: occurrence.technicalLocator,
          ...(occurrence.behaviour ? { behaviour: occurrence.behaviour } : {}),
          ...(index === 0 && cropAssetId ? { crop_asset_id: cropAssetId } : {}),
          ...(occurrence.otherSemanticName ? { other_semantic_name: occurrence.otherSemanticName } : {}),
          ...(occurrence.otherTechnicalLocator ? { other_technical_locator: occurrence.otherTechnicalLocator } : {}),
        });
      });
      family.occurrence_count = family.occurrences!.length;
      if (!capture.issue_ids.includes(family.id)) capture.issue_ids.push(family.id);
    }
  }

  issues.push(...familyByKey.values());
  const confidenceSort: Record<IssueConfidence, number> = {
    high: 0,
    "needs-confirmation": 1,
    "likely-noise": 2,
  };
  issues.sort((left, right) =>
    confidenceSort[left.confidence ?? "needs-confirmation"] - confidenceSort[right.confidence ?? "needs-confirmation"] ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id));
  for (const capture of captures) {
    capture.issue_ids.sort((left, right) => {
      const a = issues.find((issue) => issue.id === left)!;
      const b = issues.find((issue) => issue.id === right)!;
      return confidenceSort[a.confidence ?? "needs-confirmation"] - confidenceSort[b.confidence ?? "needs-confirmation"] ||
        a.title.localeCompare(b.title);
    });
    const highConfidence = capture.issue_ids.some(
      (id) => issues.find((issue) => issue.id === id)?.confidence === "high",
    );
    capture.expected_verdict = highConfidence ? "FAIL" : "PASS";
    capture.reason_codes = highConfidence
      ? ["HIGH_CONFIDENCE_CONCERNS_PRESENT"]
      : capture.issue_ids.length > 0
        ? ["MACHINE_SUGGESTIONS_REQUIRE_CONFIRMATION"]
        : ["NO_DETECTED_ISSUES"];
  }

  const runId = stableId("run", [report.url, report.createdAt]);
  const failedPages = report.pages?.filter((page) => page.status === "failed").length ?? 0;
  const highConfidenceIssues = issues.filter((issue) => issue.confidence === "high");
  const verdict: AuditVerdictValue = failedPages > 0 ? "INCOMPLETE" : highConfidenceIssues.length > 0 ? "FAIL" : "PASS";
  const reasonCodes = failedPages > 0
    ? ["PAGE_SCAN_INCOMPLETE"]
    : highConfidenceIssues.length > 0
      ? ["HIGH_CONFIDENCE_CONCERNS_PRESENT"]
      : issues.length > 0
        ? ["MACHINE_SUGGESTIONS_REQUIRE_CONFIRMATION"]
        : ["NO_DETECTED_ISSUES"];
  const configuredSourceSha = process.env.VQA_SOURCE_SHA?.trim();
  const sourceSha = configuredSourceSha && /^[0-9a-f]{40,64}$/iu.test(configuredSourceSha)
    ? configuredSourceSha.toLowerCase()
    : "source-checkout";
  const manifestCore = {
    artifact_type: "vq-review-manifest" as const,
    schema_version: REVIEW_MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    source_report: {
      tool: report.tool,
      tool_version: report.toolVersion,
      format_version: report.formatVersion,
      source_sha: sourceSha,
      report_schema_version: REPORT_FORMAT_VERSION,
      manifest_schema_version: REVIEW_MANIFEST_SCHEMA_VERSION,
      review_state_schema_version: REVIEW_STATE_SCHEMA_VERSION,
    },
    pages,
    states: [...states.values()],
    assets,
    issues,
    captures,
    audit_verdict: { value: verdict, policy_id: "vq-high-confidence-issues-v2", reason_codes: reasonCodes },
  };
  return {
    ...manifestCore,
    manifest_id: stableId("manifest", [manifestCore]),
  };
}

export async function writeReviewArtifacts(
  report: Report,
  reportDir: string,
  renderHtml: (report: Report, manifest: ReviewManifest) => string,
): Promise<{ manifest: ReviewManifest; manifestSha256: string; state: ReviewState }> {
  const manifest = await buildReviewManifest(report, reportDir);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = sha256(manifestBytes);
  const emptyState: ReviewState = {
    artifact_type: "vq-review-state",
    schema_version: REVIEW_STATE_SCHEMA_VERSION,
    manifest_id: manifest.manifest_id,
    manifest_sha256: manifestSha256,
    issues: {},
    highlights: {},
  };
  let state = emptyState;
  try {
    const existing = JSON.parse(await readFile(join(reportDir, "review-state.json"), "utf8")) as ReviewState;
    if (
      existing.artifact_type === "vq-review-state" &&
      existing.schema_version === REVIEW_STATE_SCHEMA_VERSION &&
      existing.manifest_id === manifest.manifest_id &&
      existing.manifest_sha256 === manifestSha256 &&
      existing.issues && typeof existing.issues === "object" &&
      existing.highlights && typeof existing.highlights === "object"
    ) state = existing;
  } catch {
    // Fresh scans have no state; malformed copied state is replaced fail-closed.
  }
  await writeFile(join(reportDir, "review-manifest.json"), manifestBytes);
  await writeFile(join(reportDir, "review-state.json"), `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(join(reportDir, "report.html"), renderHtml(report, manifest));
  return { manifest, manifestSha256, state };
}
