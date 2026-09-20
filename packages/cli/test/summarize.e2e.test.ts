import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSummary, Report } from "@vqa/contract";
import { assertBuilt, runBin } from "./helpers.js";

const roots: string[] = [];

const summary: AgentSummary = {
  artifactType: "vqa-agent-summary",
  schemaVersion: 1,
  sourceReport: "issues.json",
  defects: [
    {
      id: "group-likely",
      kind: "likely-defect",
      type: "clipped-text",
      severity: "high",
      confidence: "high",
      message: "Checkout text is clipped.",
      viewportRange: "fails at 390px, clean at 1280px and above",
      evidence: [{
        screenshot: "screenshots/390x844/full.png",
        crop: "screenshots/390x844/issue-likely.png",
        reproduction: {
          url: "https://example.test/checkout",
          viewport: "390x844",
          element: "main#checkout > p#total",
        },
      }],
    },
    {
      id: "group-detector",
      kind: "detector-finding",
      type: "cramped-spacing",
      severity: "low",
      confidence: "likely-noise",
      message: "Controls may be too close.",
      viewportRange: "fails at 390px",
      evidence: [{
        screenshot: "screenshots/390x844/full.png",
        reproduction: {
          url: "https://example.test/checkout",
          viewport: "390x844",
          element: "button#cancel and button#submit",
        },
      }],
    },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reportDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "vqa-summarize-"));
  roots.push(root);
  writeFileSync(join(root, "agent-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return root;
}

function groupedReportDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "vqa-summarize-grouped-"));
  roots.push(root);
  const report = {
    formatVersion: "2",
    tool: "viewport-qa",
    toolVersion: "0.4.0-rc.1",
    url: "https://example.test/checkout",
    createdAt: "2026-09-05T00:00:00.000Z",
    adapter: { impl: "stub", wired: false },
    viewports: [{
      pageUrl: "https://example.test/checkout",
      viewport: {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        label: "390x844",
      },
      page: {
        scrollWidth: 390,
        scrollHeight: 844,
        viewportWidth: 390,
        viewportHeight: 844,
      },
      screenshot: "screenshots/390x844/full.png",
      issueCount: 1,
      rawIssueCount: 1,
    }],
    issues: [{
      id: "issue-legacy",
      type: "clipped-text",
      severity: "high",
      selector: "main#checkout > p#total",
      technicalLocator: "main#checkout > p#total",
      confidence: "high",
      description: "Checkout text is clipped.",
      rect: { x: 0, y: 0, width: 100, height: 20 },
      heuristicSuggestion: { kind: "heuristic", text: "Allow the text to fit." },
      viewport: "390x844",
      pageUrl: "https://example.test/checkout",
      instanceCount: 1,
      screenshots: {
        viewport: "screenshots/390x844/full.png",
        crop: "screenshots/390x844/issue-legacy.png",
      },
      aiRecommendation: { status: "unavailable", reason: "no model adapter wired" },
    }],
    groups: [{
      id: "group-legacy",
      type: "clipped-text",
      pageUrl: "https://example.test/checkout",
      elementFingerprint: "id:total",
      message: "Checkout text is clipped.",
      issueIds: ["issue-legacy"],
      viewportRange: "fails at 390px",
    }],
  } satisfies Report;
  writeFileSync(join(root, "issues.json"), `${JSON.stringify(report, null, 2)}\n`);
  return root;
}

function ungroupedReportDirectory(): string {
  const root = groupedReportDirectory();
  const report = JSON.parse(readFileSync(join(root, "issues.json"), "utf8")) as Report;
  delete report.groups;
  writeFileSync(join(root, "issues.json"), `${JSON.stringify(report, null, 2)}\n`);
  return root;
}

describe("vqa summarize (real shipped binary)", () => {
  it("prints the exact JSON document and writes nothing", async () => {
    assertBuilt();
    const root = reportDirectory();
    const beforeNames = readdirSync(root);
    const beforeBytes = readFileSync(join(root, "agent-summary.json"));
    const result = await runBin(["summarize", root, "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(summary);
    expect(readdirSync(root)).toEqual(beforeNames);
    expect(readFileSync(join(root, "agent-summary.json"))).toEqual(beforeBytes);
  });

  it("prints likely defects first and labels every human line by kind", async () => {
    assertBuilt();
    const result = await runBin(["summarize", reportDirectory()]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const lines = result.stdout.trim().split("\n");
    expect(lines.every((line) => /^\[(?:likely-defect|detector-finding)\]/u.test(line))).toBe(true);
    expect(lines.findIndex((line) => line.startsWith("[likely-defect]"))).toBeLessThan(
      lines.findIndex((line) => line.startsWith("[detector-finding]")),
    );
    expect(result.stdout).toContain("https://example.test/checkout | 390x844 | main#checkout > p#total");
    expect(result.stdout).toContain("crop screenshots/390x844/issue-likely.png");
  });

  it("derives a summary from a grouped format-2 report without writing it", async () => {
    assertBuilt();
    const root = groupedReportDirectory();
    const beforeNames = readdirSync(root);
    const beforeBytes = readFileSync(join(root, "issues.json"));
    const result = await runBin(["summarize", root, "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      artifactType: "vqa-agent-summary",
      schemaVersion: 1,
      sourceReport: "issues.json",
      defects: [{ id: "group-legacy", kind: "likely-defect", confidence: "high" }],
    });
    expect(readdirSync(root)).toEqual(beforeNames);
    expect(readFileSync(join(root, "issues.json"))).toEqual(beforeBytes);
  });

  it("derives groups for a pre-grouping format-2 report without writing it", async () => {
    assertBuilt();
    const root = ungroupedReportDirectory();
    const beforeNames = readdirSync(root);
    const beforeBytes = readFileSync(join(root, "issues.json"));
    const result = await runBin(["summarize", root, "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      artifactType: "vqa-agent-summary",
      schemaVersion: 1,
      sourceReport: "issues.json",
      defects: [{ kind: "likely-defect", confidence: "high" }],
    });
    expect(readdirSync(root)).toEqual(beforeNames);
    expect(readFileSync(join(root, "issues.json"))).toEqual(beforeBytes);
  });

  it("rejects invalid evidence derived from issues.json", async () => {
    assertBuilt();
    const root = groupedReportDirectory();
    const report = JSON.parse(readFileSync(join(root, "issues.json"), "utf8")) as Report;
    report.issues[0]!.screenshots.viewport = "../../outside.png";
    writeFileSync(join(root, "issues.json"), `${JSON.stringify(report, null, 2)}\n`);
    const result = await runBin(["summarize", root, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid evidence");
  });

  it("rejects a summary whose kind contradicts its confidence", async () => {
    assertBuilt();
    const root = reportDirectory();
    const inconsistent = structuredClone(summary);
    inconsistent.defects[0]!.kind = "detector-finding";
    writeFileSync(join(root, "agent-summary.json"), `${JSON.stringify(inconsistent, null, 2)}\n`);
    const result = await runBin(["summarize", root, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("inconsistent kind and confidence");
  });

  it("uses exit 2 for usage errors and exit 1 for report failures", async () => {
    assertBuilt();
    const missing = await runBin(["summarize"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing <report-dir>");
    const invalidOption = await runBin(["summarize", "--unknown"]);
    expect(invalidOption.code).toBe(2);
    const unreadable = await runBin(["summarize", join(reportDirectory(), "missing")]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("report directory");
  });
});
