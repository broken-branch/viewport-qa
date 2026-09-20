import type {
  DetectedIssue,
  IssueConfidence,
  IssueType,
  Severity,
  Snapshot,
} from "@vqa/contract";

const CONCERN_LABELS: Record<IssueType, string> = {
  "page-overflow": "page content spills horizontally",
  "element-overflow": "content spills outside its container",
  overlap: "visible content overlaps",
  wrapping: "text wraps poorly",
  "cramped-spacing": "content may be too close together",
  "excessive-gap": "spacing may be unexpectedly large",
  "clipped-text": "text is clipped",
  "offscreen-interactive": "control is outside the reachable area",
  contrast: "text contrast is too low",
  "font-rendering": "text rendering is broken",
  color: "text is indistinguishable from its background",
  "scenario-step": "scenario step could not be completed",
  "console-message": "browser console message was emitted",
  "failed-request": "page request did not succeed",
  "storage-change": "page storage was written",
};

function bounded(value: string, maximum = 100): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function fallbackName(issue: DetectedIssue): string {
  const label = issue.type === "page-overflow" ? "page" : "page content";
  return label;
}

export function defaultConfidence(
  type: IssueType,
  severity: Severity,
): IssueConfidence {
  if (type === "cramped-spacing" || type === "excessive-gap") return "likely-noise";
  if (type === "overlap" || type === "wrapping") return "needs-confirmation";
  return severity === "high" ? "high" : "needs-confirmation";
}

export function semanticTitle(issue: DetectedIssue): string {
  const name = bounded(issue.semanticName || fallbackName(issue), 64);
  return bounded(`${name}: ${CONCERN_LABELS[issue.type]}`, 110);
}

export function observedOutcome(issue: DetectedIssue): string {
  if (issue.observedOutcome) return bounded(issue.observedOutcome, 240);
  const name = bounded(issue.semanticName || fallbackName(issue), 72);
  if (issue.type === "contrast") {
    const ratio = /Text contrast is ([\d.]+):1[\s\S]*?requires ([\d.]+):1/u.exec(issue.description);
    return ratio
      ? `${name} measures ${ratio[1]}:1 contrast; the expected minimum is ${ratio[2]}:1.`
      : `${name} does not meet the expected text-contrast threshold.`;
  }
  const outcomes: Record<IssueType, string> = {
    "page-overflow": "The page contains visible content beyond the horizontal viewport boundary.",
    "element-overflow": `Visible content extends beyond the boundary of ${name}.`,
    overlap: `${name}${issue.otherSemanticName ? ` and ${bounded(issue.otherSemanticName, 72)}` : ""} occupy the same visible area.`,
    wrapping: `Text in ${name} wraps in a way that may reduce readability.`,
    "cramped-spacing": `${name}${issue.otherSemanticName ? ` and ${bounded(issue.otherSemanticName, 72)}` : ""} have little unseparated space between them.`,
    "excessive-gap": `${name} is separated from nearby content by an unusually large gap.`,
    "clipped-text": `Rendered text in ${name} crosses a clipped boundary.`,
    "offscreen-interactive": `${name} is outside the area a user can reach.`,
    contrast: `${name} does not meet the expected text-contrast threshold.`,
    "font-rendering": `Text in ${name} does not fit or render with its requested font.`,
    color: `Text in ${name} is visually indistinguishable from its background.`,
    "scenario-step": `The named interaction for ${name} could not be completed.`,
    "console-message": `${name} was emitted while the page was captured.`,
    "failed-request": `${name} did not complete successfully while the page was captured.`,
    "storage-change": `${name} was present after the page activity settled.`,
  };
  return bounded(outcomes[issue.type], 240);
}

export function acceptanceCriterion(issue: DetectedIssue): string {
  if (issue.acceptanceCriterion) return bounded(issue.acceptanceCriterion, 240);
  const criteria: Record<IssueType, string> = {
    "page-overflow": "At every affected size, the page has no unintended horizontal scrolling and all content remains reachable.",
    "element-overflow": "At every affected size, the content stays within its intended container and remains fully readable and operable.",
    overlap: "At every affected size, text and controls remain readable, unobstructed, and operable.",
    wrapping: "At every affected size, the text wraps at readable word boundaries without narrow one-word columns.",
    "cramped-spacing": "Related content remains visually distinct and independent controls have clear separation.",
    "excessive-gap": "The spacing follows the surrounding visual rhythm at every affected size.",
    "clipped-text": "All intended text is fully visible at every affected size.",
    "offscreen-interactive": "The control is visible, reachable, and operable at every affected size.",
    contrast: "Text contrast meets WCAG AA at every affected size.",
    "font-rendering": "The intended font loads and all text fits its box at every affected size.",
    color: "The text remains visibly distinct from its background at every affected size.",
    "scenario-step": "The named role and accessible name identify one visible, operable element.",
    "console-message": "The page emits no unexpected browser console errors or warnings.",
    "failed-request": "Every page request succeeds or has an explicitly accepted error outcome.",
    "storage-change": "The page writes only expected cookies and browser-storage keys.",
  };
  return criteria[issue.type];
}

function reasonFor(confidence: IssueConfidence, issue: DetectedIssue): string[] {
  if (issue.confidenceReasons?.length) return [...new Set(issue.confidenceReasons)];
  if (confidence === "high") return ["Measured visible evidence directly demonstrates the user-facing outcome."];
  if (confidence === "likely-noise") return ["The geometry matches a common intentional layout pattern and does not prove a user-facing failure."];
  return ["Box geometry suggests a concern, but visual intent or obstruction still needs reviewer confirmation."];
}

export function decorateDetectedIssue(
  snapshot: Snapshot,
  issue: DetectedIssue,
): DetectedIssue {
  const bySelector = new Map(snapshot.elements.map((element) => [element.selector, element]));
  const primary = bySelector.get(issue.selector);
  const secondary = issue.otherSelector ? bySelector.get(issue.otherSelector) : undefined;
  const semanticName = issue.semanticName || primary?.semanticName || fallbackName(issue);
  const elementFingerprint = issue.elementFingerprint || primary?.elementFingerprint || `locator:${issue.selector}`;
  const confidence = issue.confidence || defaultConfidence(issue.type, issue.severity);
  const decorated: DetectedIssue = {
    ...issue,
    semanticName,
    elementFingerprint,
    technicalLocator: issue.technicalLocator || issue.selector,
    confidence,
    confidenceReasons: reasonFor(confidence, issue),
    ...(secondary
      ? {
          otherSemanticName: issue.otherSemanticName || secondary.semanticName,
          otherElementFingerprint: issue.otherElementFingerprint || secondary.elementFingerprint,
          otherTechnicalLocator: issue.otherTechnicalLocator || issue.otherSelector,
        }
      : issue.otherSelector
        ? {
            otherSemanticName: issue.otherSemanticName || "related content",
            otherElementFingerprint: issue.otherElementFingerprint || `locator:${issue.otherSelector}`,
            otherTechnicalLocator: issue.otherTechnicalLocator || issue.otherSelector,
          }
        : {}),
  };
  return {
    ...decorated,
    observedOutcome: observedOutcome(decorated),
    acceptanceCriterion: acceptanceCriterion(decorated),
  };
}
