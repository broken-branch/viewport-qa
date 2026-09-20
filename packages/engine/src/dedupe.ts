import type {
  DetectedIssue,
  DetectedIssueOccurrence,
  Issue,
  IssueConfidence,
  IssueGroup,
  Severity,
  ViewportResult,
  ViewportSpec,
} from "@vqa/contract";
import { createHash } from "node:crypto";
import { semanticFingerprintIsAmbiguous } from "./collector.js";

/** A detected issue plus the number of raw hits collapsed into it. */
export interface DedupedIssue extends DetectedIssue {
  instanceCount: number;
  occurrences: DetectedIssueOccurrence[];
}

const SEVERITY_RANK: Record<Severity, number> = { high: 2, medium: 1, low: 0 };

/** Legacy diagnostic helper. It is no longer used as an identity key. */
export function selectorPattern(selector: string): string {
  return selector.replace(/:nth-child\(\d+\)/g, "");
}

function pairKey(issue: DetectedIssue): string {
  const primary = issue.elementFingerprint ?? `locator:${issue.selector}`;
  const secondary = issue.otherElementFingerprint ??
    (issue.otherSelector ? `locator:${issue.otherSelector}` : "");
  // Unordered: (a,b) and (b,a) are the same finding.
  const [first, second] =
    primary <= secondary ? [primary, secondary] : [secondary, primary];
  return `${issue.type}|${first}|${second}`;
}

function occurrence(issue: DetectedIssue): DetectedIssueOccurrence {
  return {
    semanticName: issue.semanticName ?? "page content",
    elementFingerprint: issue.elementFingerprint ?? `locator:${issue.selector}`,
    technicalLocator: issue.technicalLocator ?? issue.selector,
    ...(issue.otherSelector
      ? {
          otherSemanticName: issue.otherSemanticName ?? "related content",
          otherElementFingerprint: issue.otherElementFingerprint ?? `locator:${issue.otherSelector}`,
          otherTechnicalLocator: issue.otherTechnicalLocator ?? issue.otherSelector,
        }
      : {}),
    rect: issue.rect,
    ...(issue.behaviour ? { behaviour: issue.behaviour } : {}),
  };
}

const CONFIDENCE_RANK: Record<IssueConfidence, number> = {
  high: 2,
  "needs-confirmation": 1,
  "likely-noise": 0,
};

/**
 * Collapses only exact semantic element identities within one capture. Every
 * occurrence remains available for evidence and shallow nth-child paths are
 * deliberately distinct unless the collector supplied the same fingerprint.
 */
export function dedupeIssues(detected: DetectedIssue[]): {
  issues: DedupedIssue[];
  rawCount: number;
} {
  const byKey = new Map<string, DedupedIssue>();
  for (const issue of detected) {
    const key = pairKey(issue);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...issue, instanceCount: 1, occurrences: [occurrence(issue)] });
    } else {
      existing.instanceCount += 1;
      existing.occurrences.push(occurrence(issue));
      if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[existing.severity]) {
        existing.severity = issue.severity;
      }
      if (
        issue.confidence &&
        (!existing.confidence || CONFIDENCE_RANK[issue.confidence] > CONFIDENCE_RANK[existing.confidence])
      ) {
        existing.confidence = issue.confidence;
      }
      existing.confidenceReasons = [
        ...new Set([...(existing.confidenceReasons ?? []), ...(issue.confidenceReasons ?? [])]),
      ];
    }
  }
  return { issues: [...byKey.values()], rawCount: detected.length };
}

function groupId(parts: readonly unknown[]): string {
  return `group-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20)}`;
}

function describeWidthRuns(widths: readonly number[], allWidths: readonly number[]): string {
  const positions = widths
    .map((width) => allWidths.indexOf(width))
    .filter((position) => position >= 0)
    .sort((left, right) => left - right);
  const runs: Array<[number, number]> = [];
  for (const position of positions) {
    const current = runs.at(-1);
    if (current && position === current[1] + 1) current[1] = position;
    else runs.push([position, position]);
  }
  return runs.map(([start, end]) => {
    const first = allWidths[start]!;
    const last = allWidths[end]!;
    if (end === allWidths.length - 1 && allWidths.length > 1) {
      return `${first}px and above`;
    }
    return start === end ? `${first}px` : `${first}px through ${last}px`;
  }).join(" and at ");
}

function canonicalViewportLabel(viewport: ViewportSpec): string {
  return `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}`;
}

function viewportRange(
  failingLabels: readonly string[],
  concernFailingLabels: readonly string[],
  viewports: ReadonlyMap<string, ViewportSpec>,
  includeClean: boolean,
): string {
  const captures = [...viewports.entries()];
  const failing = new Set(failingLabels);
  const concernFailing = new Set(concernFailingLabels);
  const outcomesByWidth = new Map<number, Set<boolean>>();
  for (const [label, viewport] of captures) {
    const outcomes = outcomesByWidth.get(viewport.width) ?? new Set<boolean>();
    outcomes.add(failing.has(label));
    outcomesByWidth.set(viewport.width, outcomes);
  }
  if ([...outcomesByWidth.values()].some((outcomes) => outcomes.size > 1)) {
    const describeCaptures = (labels: ReadonlySet<string>): string => captures
      .filter(([label]) => labels.has(label))
      .map(([, viewport]) => canonicalViewportLabel(viewport))
      .join(" and at ");
    const failureText = `fails at ${describeCaptures(failing)}`;
    const clean = new Set(captures
      .map(([label]) => label)
      .filter((label) => !concernFailing.has(label)));
    return includeClean && clean.size > 0
      ? `${failureText}, clean at ${describeCaptures(clean)}`
      : failureText;
  }

  const all = [...new Set(captures.map(([, viewport]) => viewport.width))]
    .sort((left, right) => left - right);
  const failed = [...new Set(captures
    .filter(([label]) => failing.has(label))
    .map(([, viewport]) => viewport.width))]
    .sort((left, right) => left - right);
  const concernFailed = new Set(captures
    .filter(([label]) => concernFailing.has(label))
    .map(([, viewport]) => viewport.width));
  const clean = all.filter((width) => !concernFailed.has(width));
  const failureText = `fails at ${describeWidthRuns(failed, all)}`;
  return includeClean && clean.length > 0
    ? `${failureText}, clean at ${describeWidthRuns(clean, all)}`
    : failureText;
}

function issueIdentity(issue: Issue, pageUrl: string): {
  keyParts: string[];
  primary: string;
  secondary: string;
  ambiguous: boolean;
} {
  const primary = issue.elementFingerprint ?? `locator:${issue.selector}`;
  const secondary = issue.otherElementFingerprint ??
    (issue.otherSelector ? `locator:${issue.otherSelector}` : "");
  const identityParts = secondary
    ? primary <= secondary ? [primary, secondary] : [secondary, primary]
    : [primary, ""];
  const ambiguous = semanticFingerprintIsAmbiguous(primary) ||
    (Boolean(secondary) && semanticFingerprintIsAmbiguous(secondary));
  return {
    keyParts: [pageUrl, issue.scenarioLabel ?? "", issue.type, ...identityParts, ...(ambiguous ? [issue.viewport] : [])],
    primary,
    secondary,
    ambiguous,
  };
}

/**
 * Groups equal detector messages for one semantic element across viewport
 * captures without replacing the manifest-bound source issue records.
 */
export function groupIssuesAcrossViewports(
  issues: readonly Issue[],
  viewports: readonly ViewportResult[],
  reportUrl: string,
): IssueGroup[] {
  const viewportsByPage = new Map<string, Map<string, ViewportSpec>>();
  const scopeKey = (pageUrl: string, scenarioLabel?: string): string =>
    JSON.stringify([pageUrl, scenarioLabel ?? ""]);
  for (const viewport of viewports) {
    const pageUrl = viewport.pageUrl ?? reportUrl;
    const scope = scopeKey(pageUrl, viewport.scenarioLabel);
    const pageViewports = viewportsByPage.get(scope) ?? new Map<string, ViewportSpec>();
    pageViewports.set(viewport.viewport.label, viewport.viewport);
    viewportsByPage.set(scope, pageViewports);
  }

  const concernFailures = new Map<string, string[]>();
  for (const issue of issues) {
    const pageUrl = issue.pageUrl ?? reportUrl;
    const scope = scopeKey(pageUrl, issue.scenarioLabel);
    const identityKey = JSON.stringify(issueIdentity(issue, pageUrl).keyParts);
    const labels = concernFailures.get(identityKey) ?? [];
    if (viewportsByPage.get(scope)?.has(issue.viewport)) labels.push(issue.viewport);
    concernFailures.set(identityKey, labels);
  }

  const groups = new Map<string, {
    group: IssueGroup;
    failingLabels: string[];
    identityKey: string;
    ambiguous: boolean;
  }>();
  for (const issue of issues) {
    const pageUrl = issue.pageUrl ?? reportUrl;
    const scope = scopeKey(pageUrl, issue.scenarioLabel);
    const identity = issueIdentity(issue, pageUrl);
    const identityKey = JSON.stringify(identity.keyParts);
    const keyParts = issue.behaviour
      ? identity.keyParts
      : [...identity.keyParts, issue.description];
    const key = JSON.stringify(keyParts);
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        group: {
          id: groupId(keyParts),
          type: issue.type,
          ...(issue.pageUrl ? { pageUrl } : {}),
          ...(issue.scenarioLabel ? { scenarioLabel: issue.scenarioLabel } : {}),
          elementFingerprint: identity.primary,
          ...(identity.secondary ? { otherElementFingerprint: identity.secondary } : {}),
          message: issue.description,
          issueIds: [],
          viewportRange: "",
        },
        failingLabels: [],
        identityKey,
        ambiguous: identity.ambiguous,
      };
      groups.set(key, entry);
    }
    entry.group.issueIds.push(issue.id);
    if (viewportsByPage.get(scope)?.has(issue.viewport)) {
      entry.failingLabels.push(issue.viewport);
    }
  }

  return [...groups.values()].map(({ group, failingLabels, identityKey, ambiguous }) => {
    const pageViewports = viewportsByPage.get(
      scopeKey(group.pageUrl ?? reportUrl, group.scenarioLabel),
    ) ?? new Map();
    return {
      ...group,
      viewportRange: viewportRange(
        failingLabels,
        concernFailures.get(identityKey) ?? failingLabels,
        pageViewports,
        !ambiguous,
      ),
    };
  });
}
