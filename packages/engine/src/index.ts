export { scan, TOOL_NAME, TOOL_VERSION } from "./scan.js";
export type { ScanOptions } from "./scan.js";
export {
  buildAgentSummary,
  formatAgentSummaryHuman,
  readAgentSummary,
} from "./agent-summary.js";
export { renderContactSheetHtml } from "./contact-sheet.js";
export {
  attemptedScenarioSteps,
  parseScenarioRecipe,
  prepareScenarios,
  readScenarioRecipe,
  installScenarioRoutes,
  runScenarioSteps,
  scenarioArtifactName,
  ScenarioRecipeError,
} from "./scenarios.js";
export type { ScenarioStepFailure } from "./scenarios.js";
export {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PAGES,
  HARD_MAX_DEPTH,
  HARD_MAX_PAGES,
  crawlSameOrigin,
  normalizeCrawlLinks,
} from "./crawl.js";
export type { CrawlResult, CrawlVisit } from "./crawl.js";
export {
  collectSnapshot,
  disambiguateSemanticFingerprints,
  resolveSnapshotSemanticFingerprints,
  semanticFingerprintBase,
  semanticFingerprintIsAmbiguous,
} from "./collector.js";
export type { SemanticFingerprintCandidate } from "./collector.js";
export { capturePageBehaviour } from "./behaviour.js";
export { dedupeIssues, groupIssuesAcrossViewports, selectorPattern } from "./dedupe.js";
export type { DedupedIssue } from "./dedupe.js";
export { recommendFix } from "./recommend.js";
export { renderReportHtml } from "./report-html.js";
export { renderHumanHandoffPdf } from "./handoff-pdf.js";
export type {
  HumanHandoffPdfImage,
  RenderHumanHandoffPdfOptions,
} from "./handoff-pdf.js";
export { compareRunCaptures } from "./diff.js";
export { markRunAsBaseline } from "./baseline.js";
export { buildReviewManifest } from "./review-manifest.js";
export { validateCompletedReport } from "./report-transaction.js";
export { acquireReportWriterLock } from "./report-lock.js";
export type { ReportWriterLockHooks, ReportWriterLockOptions } from "./report-lock.js";
export { createTargetPolicy } from "./target-policy.js";
export { normalizeTargetAddress } from "./target-address.js";
export type { TargetPolicy, TargetPolicyOptions } from "./target-policy.js";
export { isLinkFreeExistingPath } from "./path-safety.js";
export {
  BROWSER_RECOVERY_COMMAND,
  BROWSER_STATUS_SCHEMA_VERSION,
  browserCacheSize,
  browserCompatibility,
  browserStatus,
  compatibleBrowserExecutablePath,
  installBrowser,
  removeBrowser,
} from "./browser-manager.js";
export type {
  BrowserCompatibility,
  BrowserDiagnostic,
  BrowserHealth,
  BrowserInstallerRequest,
  BrowserManagerEnvironment,
  BrowserMutationResult,
  BrowserProbeResult,
  BrowserStatus,
} from "./browser-manager.js";
export {
  DEFAULT_VIEWPORT_SPECS,
  parseViewport,
  parseViewportList,
} from "./viewports.js";
