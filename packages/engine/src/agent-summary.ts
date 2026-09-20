import {
  AGENT_SUMMARY_SCHEMA_VERSION,
  ISSUE_TYPES,
  PROTOCOL_IDENTITY,
  REPORT_FORMAT_VERSIONS,
  type AgentSummary,
  type AgentSummaryDefect,
  type BehaviourFinding,
  type Issue,
  type IssueConfidence,
  type Report,
  type Severity,
} from "@vqa/contract";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { groupIssuesAcrossViewports } from "./dedupe.js";
import { defaultConfidence } from "./issue-semantics.js";
import { isLinkFreeExistingPath } from "./path-safety.js";

const SEVERITY_RANK: Record<Severity, number> = {
  high: 2,
  medium: 1,
  low: 0,
};

const CONFIDENCE_RANK: Record<IssueConfidence, number> = {
  high: 2,
  "needs-confirmation": 1,
  "likely-noise": 0,
};

function strongest<T extends string>(
  values: readonly T[],
  rank: Record<T, number>,
): T {
  return values.reduce((current, value) =>
    rank[value] > rank[current] ? value : current
  );
}

function issueConfidence(issue: Issue): IssueConfidence {
  return issue.confidence ?? defaultConfidence(issue.type, issue.severity);
}

function elementLocator(issue: Issue): string {
  const primary = issue.technicalLocator ?? issue.selector;
  if (!issue.otherSelector) return primary;
  return `${primary} and ${issue.otherTechnicalLocator ?? issue.otherSelector}`;
}

function behaviourEvidence(item: BehaviourFinding): string {
  if (item.kind === "console-message") {
    return `${item.level} at ${item.sourceUrl}:${item.line}: ${item.text}`;
  }
  if (item.kind === "failed-request") {
    return `${item.method} ${item.url} ${item.status === undefined
      ? `failed: ${item.failureReason ?? "unknown failure"}`
      : `answered ${item.status}`}`;
  }
  if (item.storage === "cookie") {
    const attributes = item.attributes;
    return `cookie ${item.name} for ${attributes.domain}${attributes.path} ` +
      `(SameSite=${attributes.sameSite}, Secure=${attributes.secure}, ` +
      `HttpOnly=${attributes.httpOnly}, Expires=${attributes.expires})`;
  }
  return `${item.storage} key ${item.key}`;
}

function groupMessage(groupMessage: string, issues: readonly Issue[]): string {
  const observations = issues.flatMap((issue) =>
    (issue.occurrences ?? []).flatMap((occurrence) =>
      occurrence.behaviour ? [behaviourEvidence(occurrence.behaviour)] : []
    )
  );
  return observations.length === 0 ? groupMessage : [...new Set(observations)].join("; ");
}

function defectSort(left: AgentSummaryDefect, right: AgentSummaryDefect): number {
  const kindRank = { "likely-defect": 0, "detector-finding": 1 } as const;
  return kindRank[left.kind] - kindRank[right.kind] ||
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    left.id.localeCompare(right.id);
}

/** Build the compact, group-centric document written beside issues.json. */
export function buildAgentSummary(report: Report): AgentSummary {
  const issuesById = new Map(report.issues.map((issue) => [issue.id, issue]));
  const defects = (report.groups ?? []).map((group): AgentSummaryDefect => {
    const issues = group.issueIds.map((issueId) => {
      const issue = issuesById.get(issueId);
      if (!issue) {
        throw new Error(`agent summary group ${group.id} references unknown issue ${issueId}`);
      }
      return issue;
    });
    if (issues.length === 0) {
      throw new Error(`agent summary group ${group.id} has no source issues`);
    }
    const severity = strongest(issues.map((issue) => issue.severity), SEVERITY_RANK);
    const confidence = strongest(issues.map(issueConfidence), CONFIDENCE_RANK);
    return {
      id: group.id,
      kind: confidence === "high" ? "likely-defect" : "detector-finding",
      type: group.type,
      severity,
      confidence,
      message: groupMessage(group.message, issues),
      ...(group.scenarioLabel ? { scenarioLabel: group.scenarioLabel } : {}),
      viewportRange: group.viewportRange,
      evidence: issues.map((issue) => ({
        screenshot: issue.screenshots.viewport,
        ...(issue.screenshots.crop ? { crop: issue.screenshots.crop } : {}),
        reproduction: {
          url: issue.pageUrl ?? group.pageUrl ?? report.url,
          viewport: issue.viewport,
          ...(issue.scenarioLabel ? { scenarioLabel: issue.scenarioLabel } : {}),
          element: elementLocator(issue),
        },
      })),
    };
  });
  defects.sort(defectSort);
  return {
    artifactType: "vqa-agent-summary",
    schemaVersion: AGENT_SUMMARY_SCHEMA_VERSION,
    sourceReport: "issues.json",
    defects,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function relativeReportPath(value: unknown): value is string {
  if (!nonEmptyString(value) || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  if (value.includes("\\") || /%(?:2f|5c)/iu.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validateAgentSummary(value: unknown): AgentSummary {
  if (!value || typeof value !== "object") throw new Error("agent-summary.json must contain an object");
  const summary = value as Partial<AgentSummary>;
  if (
    summary.artifactType !== "vqa-agent-summary" ||
    summary.schemaVersion !== AGENT_SUMMARY_SCHEMA_VERSION ||
    summary.sourceReport !== "issues.json" ||
    !Array.isArray(summary.defects)
  ) {
    throw new Error("agent-summary.json has unsupported metadata or schema");
  }
  const ids = new Set<string>();
  let sawDetectorFinding = false;
  for (const defect of summary.defects) {
    if (!defect || typeof defect !== "object" || !nonEmptyString(defect.id) || ids.has(defect.id)) {
      throw new Error("agent-summary.json has an invalid or duplicate defect id");
    }
    ids.add(defect.id);
    if (defect.kind === "detector-finding") sawDetectorFinding = true;
    else if (defect.kind !== "likely-defect" || sawDetectorFinding) {
      throw new Error("agent-summary.json has invalid kind ordering");
    }
    if (
      !ISSUE_TYPES.includes(defect.type) ||
      !(["high", "medium", "low"] as const).includes(defect.severity) ||
      !(["high", "needs-confirmation", "likely-noise"] as const).includes(defect.confidence) ||
      !nonEmptyString(defect.message) ||
      (defect.scenarioLabel !== undefined && !nonEmptyString(defect.scenarioLabel)) ||
      !nonEmptyString(defect.viewportRange) ||
      !Array.isArray(defect.evidence) ||
      defect.evidence.length === 0
    ) {
      throw new Error(`agent-summary.json has an invalid defect record: ${defect.id}`);
    }
    const expectedKind = defect.confidence === "high" ? "likely-defect" : "detector-finding";
    if (defect.kind !== expectedKind) {
      throw new Error(`agent-summary.json has inconsistent kind and confidence for defect ${defect.id}`);
    }
    for (const evidence of defect.evidence) {
      if (
        !evidence ||
        typeof evidence !== "object" ||
        !relativeReportPath(evidence.screenshot) ||
        (evidence.crop !== undefined && !relativeReportPath(evidence.crop)) ||
        !evidence.reproduction ||
        !nonEmptyString(evidence.reproduction.url) ||
        !nonEmptyString(evidence.reproduction.viewport) ||
        !nonEmptyString(evidence.reproduction.element)
      ) {
        throw new Error(`agent-summary.json has invalid evidence for defect ${defect.id}`);
      }
      if (evidence.reproduction.scenarioLabel !== defect.scenarioLabel) {
        throw new Error(`agent-summary.json has inconsistent scenario labels for defect ${defect.id}`);
      }
    }
  }
  return summary as AgentSummary;
}

async function readSupportedReport(path: string): Promise<Report> {
  const item = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!item?.isFile() || item.isSymbolicLink()) {
    throw new Error("missing regular agent-summary.json and issues.json");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`could not parse issues.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = value as Partial<Report>;
  if (
    !REPORT_FORMAT_VERSIONS.includes(report.formatVersion!) ||
    report.tool !== PROTOCOL_IDENTITY ||
    !Array.isArray(report.issues) ||
    !Array.isArray(report.viewports) ||
    (report.groups !== undefined && !Array.isArray(report.groups))
  ) {
    throw new Error("issues.json is not a supported report");
  }
  return report as Report;
}

/** Read a summary, or derive it from a supported grouped report without writing. */
export async function readAgentSummary(reportDir: string): Promise<AgentSummary> {
  const root = resolve(reportDir);
  const path = join(root, "agent-summary.json");
  if (!await isLinkFreeExistingPath(root)) {
    throw new Error("report directory must be an existing link-free path");
  }
  const item = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!item) {
    const report = await readSupportedReport(join(root, "issues.json"));
    const groupedReport = report.groups === undefined
      ? {
          ...report,
          groups: groupIssuesAcrossViewports(
            report.issues,
            report.viewports,
            report.url,
          ),
        }
      : report;
    return validateAgentSummary(buildAgentSummary(groupedReport));
  }
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error(`agent-summary.json is not a regular file in ${root}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`could not parse agent-summary.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateAgentSummary(value);
}

/** Format every summary record and evidence item as explicitly kind-labelled lines. */
export function formatAgentSummaryHuman(summary: AgentSummary): string[] {
  if (summary.defects.length === 0) return ["No grouped defects."];
  return summary.defects.flatMap((defect) => {
    const label = `[${defect.kind}]`;
    return [
      `${label} ${defect.id} | ${defect.severity} severity | ${defect.confidence} confidence${defect.scenarioLabel ? ` | scenario ${defect.scenarioLabel}` : ""} | ${defect.viewportRange} | ${defect.message}`,
      ...defect.evidence.map((evidence) =>
        `${label} reproduce | ${evidence.reproduction.url}${evidence.reproduction.scenarioLabel ? ` | scenario ${evidence.reproduction.scenarioLabel}` : ""} | ${evidence.reproduction.viewport} | ${evidence.reproduction.element} | screenshot ${evidence.screenshot}${evidence.crop ? ` | crop ${evidence.crop}` : ""}`
      ),
    ];
  });
}
