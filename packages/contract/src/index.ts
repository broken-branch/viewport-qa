export const REPORT_FORMAT_VERSION = "3" as const;
export const REPORT_FORMAT_VERSIONS = ["2", REPORT_FORMAT_VERSION] as const;
export type ReportFormatVersion = (typeof REPORT_FORMAT_VERSIONS)[number];
export const AGENT_SUMMARY_SCHEMA_VERSION = 1 as const;
export const REVIEW_MANIFEST_SCHEMA_VERSION = 1 as const;
export const REVIEW_STATE_SCHEMA_VERSION = 2 as const;
export { PRODUCT_VERSION } from "./version.js";
export {
  PRODUCT_CLI_COMMAND,
  PRODUCT_NAME,
  PROTOCOL_IDENTITY,
} from "./product.js";

export interface ViewportSpec { width: number; height: number; deviceScaleFactor: number; label: string }
export interface ScenarioTarget { role: string; name: string }

export type ScenarioStep =
  | { click: ScenarioTarget }
  | { fill: ScenarioTarget & { value: string } }
  | { waitFor: ScenarioTarget }
  | { route: { url: string; status: number; body: string } };

export interface Scenario { label: string; url: string; steps: ScenarioStep[] }
export interface Rect { x: number; y: number; width: number; height: number }

/** Normalized sRGB color collected from the rendered page state. */
export interface RgbaColor { red: number; green: number; blue: number; alpha: number }

export type FontFaceStatus = "loaded" | "missing" | "untracked";

export interface ElementMetric {
  /** Index into the snapshot's elements array. */
  index: number;
  /** Parent's index, or -1 for the root element. */
  parent: number;
  tag: string;
  selector: string;
  /** Bounded human-facing identity; never contains selector syntax. */
  semanticName: string;
  /** Deterministic element identity that is stable across viewport captures. */
  elementFingerprint: string;
  rect: Rect;
  /**
   * `rect` intersected with the clip box of every ancestor whose overflow is
   * not visible. A zero-size rectangle means nothing of the element can be
   * seen at once (fully clipped, or beyond a scroll container's box).
   */
  visibleRect: Rect;
  /** The accumulated clip box of the element's ancestors, or null when nothing above it clips. */
  clipRect: Rect | null;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  position: string;
  transformed: boolean;
  display: string;
  overflowX: string;
  overflowY: string;
  /**
   * Participates in visual detection. False for elements with zero rendered
   * size, display:none / visibility:hidden (self or inherited), aria-hidden or
   * [hidden] self/ancestors, children of a closed <details> (outside its
   * summary), and sr-only-clamped elements.
   */
  visible: boolean;
  interactive: boolean;
  /** An <a> whose href targets a fragment of the current page (skip link, table of contents). */
  inPageLink: boolean;
  /** The element or an ancestor is position: fixed — a layer over the page (modal, banner, sticky header). */
  inFixedLayer: boolean;
  /**
   * Matches the standard visually-hidden/sr-only signature: ~1px box clamped
   * via clip/clip-path/hidden overflow. Intentional a11y pattern, never a
   * clipping or overflow defect.
   */
  srOnly: boolean;
  /**
   * Some ancestor (excluding the document itself) is a scroll container whose
   * content exceeds its client box, so coordinates beyond page scroll bounds
   * can still be reached by scrolling that ancestor.
   */
  hasScrollableAncestor: boolean;
  /**
   * Index of the positioned ancestor this interactive element intentionally
   * covers (stretched-link card pattern), or -1. Overlaps between this element
   * and that ancestor's content are by design.
   */
  stretchedTarget: number;
  /** Element has a non-whitespace direct text node child. */
  hasDirectText: boolean;
  /** Page-coordinate rectangles for rendered direct-text nodes. */
  textRects: Rect[];
  /** Visible box separation evidence used by the spacing detector. */
  hasVisibleBorder: boolean;
  hasVisibleBackground: boolean;
  /**
   * Direct text is intended to render (not display/visibility/hidden-tree
   * suppressed), even if its resulting box has zero dimensions.
   */
  textExpectedVisible: boolean;
  wordCount: number;
  /** Measured pixel width of the longest single word of direct text (0 if none). */
  longestWordWidth: number;
  fontSizePx: number;
  fontWeight: number;
  lineHeightPx: number;
  /** Computed CSS font-family stack. */
  fontFamily: string;
  /** First family in the computed stack, normalized without quotes. */
  requestedFontFamily: string;
  /** Status of a matching declared @font-face, when one exists. */
  fontFaceStatus: FontFaceStatus;
  /** Computed text color before alpha compositing. */
  textColor: RgbaColor;
  /** Text color after alpha/opacity compositing through its ancestor chain. */
  renderedTextColor: RgbaColor;
  /** Background composited through the element's ancestor chain. */
  effectiveBackgroundColor: RgbaColor;
  /**
   * True when an image/gradient participates in the background chain. CSS
   * colors alone cannot establish a trustworthy contrast ratio in that case.
   */
  hasBackgroundImage: boolean;
  /** word-break: break-all, or overflow-wrap: anywhere/break-word. */
  wordBreakRisky: boolean;
}

export interface PageMetrics {
  scrollWidth: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface Snapshot {
  page: PageMetrics;
  elements: ElementMetric[];
}

export const ISSUE_TYPES = [
  "page-overflow",
  "element-overflow",
  "overlap",
  "wrapping",
  "cramped-spacing",
  "excessive-gap",
  "clipped-text",
  "offscreen-interactive",
  "contrast",
  "font-rendering",
  "color",
  "scenario-step",
  "console-message",
  "failed-request",
  "storage-change",
] as const;

export const BEHAVIOUR_ISSUE_TYPES = [
  "console-message",
  "failed-request",
  "storage-change",
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

export type Severity = "high" | "medium" | "low";

/** Likelihood that a machine suggestion represents a real visible defect. */
export type IssueConfidence =
  | "high"
  | "needs-confirmation"
  | "likely-noise";

export type BehaviourFinding =
  | { kind: "console-message"; level: "error" | "warning"; text: string; sourceUrl: string; line: number }
  | { kind: "failed-request"; method: string; url: string; status?: number; failureReason?: string }
  | { kind: "storage-change"; storage: "cookie"; name: string; attributes: {
      domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean;
      sameSite: "Strict" | "Lax" | "None"; partitionKey?: string;
    } }
  | { kind: "storage-change"; storage: "localStorage" | "sessionStorage"; key: string };

export interface BehaviourCaptureSummary {
  truncated: boolean;
  limits: { distinctPerKind: number; occurrencesPerIdentity: number; fieldLength: number };
  omitted: { consoleMessages: number; failedRequests: number; storageChanges: number };
}

export interface DetectedIssueOccurrence {
  semanticName: string;
  elementFingerprint: string;
  technicalLocator: string;
  otherSemanticName?: string;
  otherElementFingerprint?: string;
  otherTechnicalLocator?: string;
  rect: Rect;
  /** Structured value-free evidence for this exact repeated observation. */
  behaviour?: BehaviourFinding;
}

/**
 * Rule-based suggestion produced by a detector. Always labeled "heuristic";
 * never presented as AI output.
 */
export interface HeuristicSuggestion {
  kind: "heuristic";
  text: string;
}

/**
 * AI recommendation. Fail-closed: when no model adapter is wired (or the call
 * fails) the status is "unavailable" with a reason -- never canned text.
 */
export type AiRecommendation =
  | { status: "unavailable"; reason: string }
  | { status: "ok"; kind: "ai"; text: string; model: string };

/** Detector output before screenshots / ids / AI are attached. */
export interface DetectedIssue {
  type: IssueType;
  severity: Severity;
  selector: string;
  /** Secondary element for pair issues (overlap, spacing). */
  otherSelector?: string;
  /** Semantic review fields are optional only for format-v2 compatibility. */
  semanticName?: string;
  elementFingerprint?: string;
  technicalLocator?: string;
  otherSemanticName?: string;
  otherElementFingerprint?: string;
  otherTechnicalLocator?: string;
  confidence?: IssueConfidence;
  confidenceReasons?: string[];
  observedOutcome?: string;
  acceptanceCriterion?: string;
  description: string;
  /** Page-coordinate region the issue concerns (used for the crop). */
  rect: Rect;
  heuristicSuggestion: HeuristicSuggestion;
  /** Structured value-free browser behaviour evidence. */
  behaviour?: BehaviourFinding;
}

export interface Issue extends DetectedIssue {
  id: string;
  viewport: string;
  /** Page URL that produced this issue (present on format-v2 crawler reports). */
  pageUrl?: string;
  /** Human label for the named state that produced this issue. */
  scenarioLabel?: string;
  /**
   * Number of raw detector hits collapsed into this issue: repeats of the same
   * (type, selector-pattern) within one viewport. Always >= 1.
   */
  instanceCount: number;
  /** Every exact occurrence retained by in-capture deduplication. */
  occurrences?: DetectedIssueOccurrence[];
  screenshots: {
    /** Relative path to the full-page screenshot for this viewport. */
    viewport: string;
    /** Relative path to the element crop, when one could be captured. */
    crop?: string;
  };
  aiRecommendation: AiRecommendation;
}

/**
 * Presentation-only grouping of viewport-specific issue records. Raw issues
 * remain authoritative so screenshot and review-manifest identities stay
 * stable.
 */
export interface IssueGroup {
  id: string;
  type: IssueType;
  pageUrl?: string;
  scenarioLabel?: string;
  elementFingerprint: string;
  otherElementFingerprint?: string;
  message: string;
  issueIds: string[];
  /** Plain-language outcome across the page's scanned viewport widths. */
  viewportRange: string;
}

export type AgentSummaryKind = "detector-finding" | "likely-defect";

export interface AgentSummaryEvidence {
  /** Full-page screenshot path, relative to the report directory. */
  screenshot: string;
  /** Issue crop path, relative to the report directory, when captured. */
  crop?: string;
  reproduction: {
    url: string;
    viewport: string;
    scenarioLabel?: string;
    /** Exact technical locator, including both elements for pair findings. */
    element: string;
  };
}

export interface AgentSummaryDefect {
  /** The corresponding IssueGroup id. */
  id: string;
  kind: AgentSummaryKind;
  type: IssueType;
  severity: Severity;
  confidence: IssueConfidence;
  message: string;
  scenarioLabel?: string;
  /** Plain-language failing and clean viewport range. */
  viewportRange: string;
  evidence: AgentSummaryEvidence[];
}

export interface AgentSummary {
  artifactType: "vqa-agent-summary";
  schemaVersion: typeof AGENT_SUMMARY_SCHEMA_VERSION;
  sourceReport: "issues.json";
  defects: AgentSummaryDefect[];
}

export interface ViewportResult {
  /** Page URL captured at this viewport (present on format-v2 crawler reports). */
  pageUrl?: string;
  /** Human label for the named state captured at this viewport. */
  scenarioLabel?: string;
  /** Normalized recipe steps attempted for this capture, in execution order. */
  scenarioSteps?: ScenarioStep[];
  viewport: ViewportSpec;
  page: PageMetrics;
  screenshot: string;
  /** Unique (deduplicated) issue count for this viewport. */
  issueCount: number;
  /** Raw detector hit count before deduplication. */
  rawIssueCount: number;
  /** Explicit accounting when hostile page activity exceeded capture bounds. */
  behaviourCapture?: BehaviourCaptureSummary;
}

export type PageScanResult =
  | {
      url: string;
      depth: number;
      status: "success";
      scenarioLabel?: string;
      viewports: ViewportResult[];
      issues: Issue[];
    }
  | {
      url: string;
      depth: number;
      status: "failed";
      scenarioLabel?: string;
      error: string;
    };

export interface ChangedRegion extends Rect {
  changedPixels: number;
}

export type CaptureDiffStatus =
  | "identical"
  | "changed"
  | "dimension-mismatch"
  | "missing-baseline"
  | "missing-current";

export interface CaptureDiff {
  /** Viewport label, which identifies the capture within a scan run. */
  target: string;
  status: CaptureDiffStatus;
  /** Fraction of pixels that differ, from 0 through 1. */
  score: number;
  changedPixels: number;
  totalPixels: number;
  changedRegions: ChangedRegion[];
}

/** Metadata placed on a run explicitly selected as a comparison baseline. */
export interface BaselineMarker {
  markedAt: string;
}

export interface RunComparison {
  baseline: {
    url: string;
    createdAt: string;
    markedAt?: string;
  };
  results: CaptureDiff[];
  changedTargetCount: number;
}

export interface Report {
  formatVersion: ReportFormatVersion;
  tool: string;
  toolVersion: string;
  /** Explicit schema identities on reports produced after product convergence. */
  schemaVersions?: {
    report: ReportFormatVersion;
    manifest: typeof REVIEW_MANIFEST_SCHEMA_VERSION;
    reviewState: typeof REVIEW_STATE_SCHEMA_VERSION;
  };
  url: string;
  createdAt: string;
  adapter: { impl: string; wired: boolean };
  viewports: ViewportResult[];
  issues: Issue[];
  /** Cross-viewport presentation groups; absent on pre-change format-v2 reports. */
  groups?: IssueGroup[];
  /** Normalized named-state recipe supplied for this scan. */
  scenarios?: Scenario[];
  /** Per-page outcomes. Older format-v2 reports may not contain this field. */
  pages?: PageScanResult[];
  baseline?: BaselineMarker;
  comparison?: RunComparison;
}

export type DecisionAction = "approve" | "reject" | "message";
export interface Decision { issueId: string; action: DecisionAction; message?: string; updatedAt: string }
export type DecisionsFile = Record<string, Decision>;
export type AuditVerdictValue = "PASS" | "FAIL" | "INCOMPLETE";
export type ReviewAssetMediaType = "image/png" | "image/jpeg";
export interface ReviewAsset {
  id: string; kind: "full-screenshot" | "issue-crop"; coordinate_id: string; issue_id?: string;
  source_relative_path: string; media_type: ReviewAssetMediaType; byte_length: number;
  sha256: string; width: number; height: number;
}
export interface ReviewManifestPage { id: string; label: string; url: string }
export interface ReviewManifestState { id: string; label: string; arrangement_provenance: string }
export interface ReviewManifestResolution { label: string; width: number; height: number; device_scale_factor: number }
export interface ReviewManifestOccurrence {
  capture_coordinate_id: string; rect: Rect; semantic_name: string; technical_locator: string;
  /** The detector's exact finding for this capture, with its measurements. Absent in older manifests. */
  message?: string;
  crop_asset_id?: string; other_semantic_name?: string; other_technical_locator?: string;
  behaviour?: BehaviourFinding;
}
export interface ReviewManifestIssue {
  id: string; title: string; type: string; severity: Severity; description: string;
  finding_kind?: "visual" | "behaviour"; semantic_name?: string; element_fingerprint?: string;
  technical_locator?: string; confidence?: IssueConfidence; confidence_reasons?: string[];
  observed_outcome?: string; acceptance_criterion?: string; occurrence_count?: number; group_ids?: string[];
  occurrences?: ReviewManifestOccurrence[]; selector: string; other_selector?: string;
  capture_coordinate_ids: string[]; crop_asset_id?: string; rects?: Record<string, Rect>;
  heuristic_suggestion: string; ai_recommendation_status:
    | { status: "unavailable"; reason: string }
    | { status: "ok"; text: string; model: string };
}
export interface ReviewManifestCapture {
  coordinate_id: string; page_id: string; state_id: string; resolution: ReviewManifestResolution;
  full_asset_id: string; issue_ids: string[]; expected_verdict: AuditVerdictValue; reason_codes: string[];
}
export interface AuditVerdict { value: AuditVerdictValue; policy_id: string; reason_codes: string[] }
export interface ReviewManifest {
  artifact_type: "vq-review-manifest"; schema_version: 1; manifest_id: string; run_id: string;
  source_report: { tool: string; tool_version: string; format_version: string; source_sha: string;
    report_schema_version: ReportFormatVersion; manifest_schema_version: 1; review_state_schema_version: typeof REVIEW_STATE_SCHEMA_VERSION };
  pages: ReviewManifestPage[]; states: ReviewManifestState[]; assets: ReviewAsset[];
  issues: ReviewManifestIssue[]; captures: ReviewManifestCapture[]; audit_verdict: AuditVerdict;
}
/** What the reviewer decided about one manifest issue (a concern across every capture it appears on). */
export type IssueReviewStatus = "export" | "dismissed";
export interface IssueReview {
  status: IssueReviewStatus;
  /** Optional reviewer-written note carried into the handoff. */
  note?: string;
  updated_at: string;
}
export interface ReviewState {
  artifact_type: "vq-review-state"; schema_version: typeof REVIEW_STATE_SCHEMA_VERSION; manifest_id: string;
  manifest_sha256: string;
  /** Issue decisions keyed by manifest issue id; an absent issue is still to review. */
  issues: Record<string, IssueReview>;
  /** Adjusted highlight rectangles keyed by capture coordinate, then issue id; null removes the highlight. */
  highlights: Record<string, Record<string, Rect | null>>;
}
export interface ExportIdentity {
  export_id: string; exported_at: string; policy_id: "vq-export-identity-v1"; schema_version: 1;
  manifest_sha256: string; review_state_sha256: string;
}
export interface PortableBundleAsset { sha256: string; path: string; media_type: ReviewAssetMediaType; byte_length: number }
/** One capture on which an exported issue appears, with its evidence. */
export interface PortableBundleOccurrence {
  coordinate_id: string; page: ReviewManifestPage; state: ReviewManifestState;
  resolution: ReviewManifestResolution; full_screenshot_asset_sha256: string;
  rect: Rect; highlight_rect?: Rect; highlight_removed?: true; crop_asset_sha256?: string;
  /** The detector's exact finding for this capture, with its measurements. */
  message?: string;
  semantic_name: string; technical_locator: string;
  other_semantic_name?: string; other_technical_locator?: string; behaviour?: BehaviourFinding;
}
/** One issue the reviewer put in the export. */
export interface PortableBundleItem {
  issue_id: string; type: string; severity: Severity; confidence?: IssueConfidence;
  confidence_reasons?: string[]; title: string; description: string; observed_outcome?: string;
  acceptance_criterion?: string; heuristic_suggestion: string;
  ai_recommendation_status: ReviewManifestIssue["ai_recommendation_status"];
  reviewer_note?: string; selected_at: string; occurrences: PortableBundleOccurrence[];
}
export interface PortableReviewBundle {
  artifact_type: "viewport-qa-change-request-bundle"; schema_version: 2;
  export_policy_id: "vq-export-identity-v1"; export_id: string; exported_at: string;
  review_state_sha256: string; source_report: ReviewManifest["source_report"] & {
    manifest_sha256: string; run_id: string };
  audit_verdict: AuditVerdict; assets: PortableBundleAsset[]; items: PortableBundleItem[];
}
