import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AgentSummary, Issue, IssueType, Report, ReviewManifest, ReviewState } from "@vqa/contract";
import { formatAgentSummaryHuman } from "@vqa/engine";
import { assertBuilt, FIXTURES, runBin } from "./helpers.js";

/**
 * Gate-integrity canary for the `vqa scan` entry point.
 *
 * Runs the real shipped binary as a subprocess against a fixture page with
 * SEEDED defects. Every seeded defect must be detected with the correct issue
 * type. By construction this makes the suite revert-sensitive: disabling or
 * breaking any detector makes its seeded assertion below fail.
 */

let outDir: string;
let report: Report;
let manifest: ReviewManifest;
let reviewState: ReviewState;
let agentSummary: AgentSummary;
let scanStdout: string;

beforeAll(async () => {
  assertBuilt();
  outDir = mkdtempSync(join(tmpdir(), "vqa-scan-"));
  const result = await runBin([
    "scan",
    join(FIXTURES, "seeded-defects.html"),
    "--viewports",
    "390x844,1280x800",
    "--out",
    outDir,
  ]);
  expect(result.code).toBe(0);
  scanStdout = result.stdout;
  report = JSON.parse(
    readFileSync(join(outDir, "issues.json"), "utf8"),
  ) as Report;
  manifest = JSON.parse(readFileSync(join(outDir, "review-manifest.json"), "utf8")) as ReviewManifest;
  reviewState = JSON.parse(readFileSync(join(outDir, "review-state.json"), "utf8")) as ReviewState;
  agentSummary = JSON.parse(readFileSync(join(outDir, "agent-summary.json"), "utf8")) as AgentSummary;
}, 180_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function issuesOf(type: IssueType): Issue[] {
  return report.issues.filter((issue) => issue.type === type);
}

function hasIssueOn(type: IssueType, seedId: string): boolean {
  return issuesOf(type).some(
    (issue) =>
      issue.selector.includes(seedId) ||
      (issue.otherSelector ?? "").includes(seedId),
  );
}

describe("vqa scan (seeded-defects fixture, real binary)", () => {
  it("writes a well-formed report directory", () => {
    expect(report.formatVersion).toBe("3");
    expect(report.viewports).toHaveLength(2);
    expect(existsSync(join(outDir, "report.html"))).toBe(true);
    expect(report.schemaVersions).toEqual({ report: "3", manifest: 1, reviewState: 1 });
    for (const viewport of report.viewports) {
      expect(existsSync(join(outDir, viewport.screenshot))).toBe(true);
    }
  });

  it("writes a static contact sheet that references only report screenshots", () => {
    const html = readFileSync(join(outDir, "contact-sheet.html"), "utf8");
    expect(html).not.toMatch(/<script\b/iu);
    expect(html).not.toMatch(/<(?:link|iframe)\b/iu);
    expect(html).not.toMatch(/<base\b/iu);
    expect(html).not.toMatch(/\burl\s*\(/iu);
    const sources = [...html.matchAll(/<img\s+src="([^"]+)"/gu)].map((match) => match[1]!);
    const resourceReferences = [...html.matchAll(/\b(?:src|href|poster|data)="([^"]+)"/gu)]
      .map((match) => match[1]!);
    expect(resourceReferences).toEqual(sources);
    expect(sources).toEqual(report.viewports.map((capture) => capture.screenshot));
    for (const source of sources) {
      expect(source).not.toMatch(/^(?:[a-z]+:|\/|\\)/iu);
      expect(existsSync(join(outDir, source))).toBe(true);
    }
    for (const capture of report.viewports) {
      expect(html).toContain(`<strong>${capture.viewport.label}</strong>`);
    }
  });

  it("writes one compact agent record per grouped fixture defect", () => {
    expect(agentSummary).toMatchObject({
      artifactType: "vqa-agent-summary",
      schemaVersion: 1,
      sourceReport: "issues.json",
    });
    expect(agentSummary.defects).toHaveLength(report.groups?.length ?? 0);
    expect(agentSummary.defects.map((defect) => defect.id).sort()).toEqual(
      (report.groups ?? []).map((group) => group.id).sort(),
    );
    expect(agentSummary.defects.some((defect) => defect.kind === "likely-defect")).toBe(true);
    expect(agentSummary.defects.some((defect) => defect.kind === "detector-finding")).toBe(true);
    expect(agentSummary.defects.map((defect) => defect.kind)).toEqual([
      ...agentSummary.defects.filter((defect) => defect.kind === "likely-defect").map((defect) => defect.kind),
      ...agentSummary.defects.filter((defect) => defect.kind === "detector-finding").map((defect) => defect.kind),
    ]);
    for (const defect of agentSummary.defects) {
      expect(defect.viewportRange).toMatch(/^fails at /u);
      expect(defect.evidence.length).toBeGreaterThan(0);
      for (const evidence of defect.evidence) {
        expect(evidence.screenshot.startsWith("screenshots/")).toBe(true);
        expect(existsSync(join(outDir, evidence.screenshot))).toBe(true);
        if (evidence.crop) expect(existsSync(join(outDir, evidence.crop))).toBe(true);
        expect(evidence.reproduction.url).toMatch(/^file:/u);
        expect(evidence.reproduction.viewport).toMatch(/^\d+x\d+/u);
        expect(evidence.reproduction.element.length).toBeGreaterThan(0);
      }
    }
  });

  it("prints a kind-labelled summary with likely defects first", () => {
    const stdoutLines = scanStdout.trimEnd().split("\n");
    const doneIndex = stdoutLines.findIndex((line) => line.startsWith("[vqa] done:"));
    const reviewIndex = stdoutLines.findIndex((line) => line.startsWith("[vqa] review with:"));
    const lines = stdoutLines.slice(doneIndex + 1, reviewIndex);
    const expectedLines = formatAgentSummaryHuman(agentSummary);
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(reviewIndex).toBeGreaterThan(doneIndex);
    expect(lines).toEqual(expectedLines);
    expect(lines.every((line) => /^\[(?:likely-defect|detector-finding)\]/u.test(line))).toBe(true);
    const firstDetector = lines.findIndex((line) => line.startsWith("[detector-finding]"));
    const lastLikely = lines.findLastIndex((line) => line.startsWith("[likely-defect]"));
    expect(firstDetector).toBeGreaterThan(lastLikely);
  });

  it("publishes the manifest-backed approved GUI with stable relationships", () => {
    expect(manifest.artifact_type).toBe("vq-review-manifest");
    expect(manifest.captures).toHaveLength(2);
    expect(manifest.states).toEqual([
      expect.objectContaining({ id: "state-captured", label: "" }),
    ]);
    expect(manifest.pages.every((page) => /^page-[0-9a-f]{20}$/u.test(page.id))).toBe(true);
    expect(manifest.captures.every((capture) => /^capture-[0-9a-f]{20}$/u.test(capture.coordinate_id))).toBe(true);
    expect(manifest.issues.every((issue) => /^concern-[0-9a-f]{20}$/u.test(issue.id))).toBe(true);
    const html = readFileSync(join(outDir, "report.html"), "utf8");
    expect(html).toContain('id="vqa-manifest"');
    expect(html).toContain("Not reviewed");
    expect(html).not.toContain("Approve fix");
    expect(html).not.toContain("Audit FAIL");
  });

  it("binds initial review state and every asset's bytes, hash, and natural dimensions", () => {
    const manifestBytes = readFileSync(join(outDir, "review-manifest.json"));
    expect(reviewState.manifest_id).toBe(manifest.manifest_id);
    expect(reviewState.manifest_sha256).toBe(createHash("sha256").update(manifestBytes).digest("hex"));
    expect(Object.keys(reviewState.captures).sort()).toEqual(
      manifest.captures.map((capture) => capture.coordinate_id).sort(),
    );
    for (const asset of manifest.assets) {
      const bytes = readFileSync(join(outDir, asset.source_relative_path));
      expect(bytes.byteLength).toBe(asset.byte_length);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
      expect(bytes.readUInt32BE(16)).toBe(asset.width);
      expect(bytes.readUInt32BE(20)).toBe(asset.height);
    }
  });

  it("refuses a non-empty destination without changing the completed report", async () => {
    const before = createHash("sha256").update(readFileSync(join(outDir, "issues.json"))).digest("hex");
    const result = await runBin([
      "scan",
      join(FIXTURES, "seeded-defects.html"),
      "--viewports",
      "390x844",
      "--out",
      outDir,
    ]);
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("report destination is not empty");
    expect(createHash("sha256").update(readFileSync(join(outDir, "issues.json"))).digest("hex")).toBe(before);
  });

  it("detects the seeded page overflow (SEED 1)", () => {
    expect(hasIssueOn("page-overflow", "seed-overflow")).toBe(true);
  });

  it("detects the seeded element overflow (SEED 2)", () => {
    expect(hasIssueOn("element-overflow", "seed-eloverflow")).toBe(true);
  });

  it("detects the seeded overlap (SEED 3)", () => {
    expect(hasIssueOn("overlap", "seed-overlap-a")).toBe(true);
  });

  it("detects the seeded one-word-per-line wrapping (SEED 4)", () => {
    expect(hasIssueOn("wrapping", "seed-wrap-column")).toBe(true);
  });

  it("detects the seeded mid-word break (SEED 5)", () => {
    expect(hasIssueOn("wrapping", "seed-wrap-midword")).toBe(true);
  });

  it("detects the seeded cramped spacing (SEED 6)", () => {
    expect(hasIssueOn("cramped-spacing", "seed-cramped-1")).toBe(true);
  });

  it("detects the seeded excessive gap (SEED 7)", () => {
    expect(hasIssueOn("excessive-gap", "seed-gap-before")).toBe(true);
  });

  it("detects the seeded clipped text (SEED 8)", () => {
    expect(hasIssueOn("clipped-text", "seed-clipped")).toBe(true);
  });

  it("detects the seeded offscreen interactive element (SEED 9)", () => {
    expect(hasIssueOn("offscreen-interactive", "seed-offscreen")).toBe(true);
  });

  it("detects the seeded WCAG AA contrast failure (SEED 10)", () => {
    expect(hasIssueOn("contrast", "seed-contrast")).toBe(true);
  });

  it("detects the seeded missing font face (SEED 11)", () => {
    expect(hasIssueOn("font-rendering", "seed-font-missing")).toBe(true);
  });

  it("detects the seeded zero-dimension text (SEED 12)", () => {
    expect(hasIssueOn("font-rendering", "seed-font-zero")).toBe(true);
  });

  it("detects the seeded overflowing rendered text (SEED 13)", () => {
    expect(hasIssueOn("font-rendering", "seed-font-overflow")).toBe(true);
  });

  it("detects the seeded near-invisible color collision (SEED 14)", () => {
    expect(hasIssueOn("color", "seed-color")).toBe(true);
  });

  it("captures an element crop screenshot for issues", () => {
    const withCrop = report.issues.filter((issue) => issue.screenshots.crop);
    expect(withCrop.length).toBeGreaterThan(0);
    for (const issue of withCrop.slice(0, 5)) {
      expect(existsSync(join(outDir, issue.screenshots.crop!))).toBe(true);
    }
  });

  it("reports honest raw vs deduplicated counts", () => {
    for (const viewport of report.viewports) {
      expect(viewport.issueCount).toBeLessThanOrEqual(viewport.rawIssueCount);
    }
    for (const issue of report.issues) {
      expect(issue.instanceCount).toBeGreaterThanOrEqual(1);
    }
    const raw = report.issues.reduce(
      (sum, issue) => sum + issue.instanceCount,
      0,
    );
    expect(raw).toBe(
      report.viewports.reduce(
        (sum, viewport) => sum + viewport.rawIssueCount,
        0,
      ),
    );
  });

  it("labels heuristic suggestions as heuristic on every issue", () => {
    expect(report.issues.length).toBeGreaterThan(0);
    for (const issue of report.issues) {
      expect(issue.heuristicSuggestion.kind).toBe("heuristic");
      expect(issue.heuristicSuggestion.text.length).toBeGreaterThan(0);
    }
  });

  it("reports AI recommendations as honestly unavailable when no adapter is wired", () => {
    expect(report.adapter).toEqual({ impl: "stub", wired: false });
    for (const issue of report.issues) {
      expect(issue.aiRecommendation.status).toBe("unavailable");
      if (issue.aiRecommendation.status === "unavailable") {
        expect(issue.aiRecommendation.reason).toContain(issue.behaviour
          ? "not sent to model adapters"
          : "no model adapter wired");
      }
    }
  });
});
