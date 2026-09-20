import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_VERSION, type Report, type ReviewManifest } from "@vqa/contract";
import { serveReport, validateReportCompatibility } from "../src/serve.js";

const roots: string[] = [];
const manifest = JSON.parse(readFileSync(
  new URL("../../../docs/examples/minimal-review-manifest.json", import.meta.url),
  "utf8",
)) as ReviewManifest;
manifest.source_report.format_version = "3";
manifest.source_report.report_schema_version = "3";
const report: Report = {
  formatVersion: "3",
  tool: "viewport-qa",
  toolVersion: PRODUCT_VERSION,
  schemaVersions: { report: "3", manifest: 1, reviewState: 2 },
  url: "file:///supported.html",
  createdAt: "2026-08-23T00:00:00.000Z",
  adapter: { impl: "stub", wired: false },
  viewports: [],
  issues: [],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("report compatibility admission", () => {
  it("accepts current manifest-backed reports and supported 0.2 legacy reports", () => {
    expect(() => validateReportCompatibility(report, manifest)).not.toThrow();
    const legacy = structuredClone(report);
    legacy.formatVersion = "2";
    delete legacy.schemaVersions;
    legacy.toolVersion = "0.2.0";
    expect(() => validateReportCompatibility(legacy)).not.toThrow();

    const previous = structuredClone(report);
    previous.formatVersion = "2";
    previous.schemaVersions = { report: "2", manifest: 1, reviewState: 2 };
    const previousManifest = structuredClone(manifest);
    previousManifest.source_report.format_version = "2";
    previousManifest.source_report.report_schema_version = "2";
    expect(() => validateReportCompatibility(previous, previousManifest)).not.toThrow();
  });

  it("rejects unknown tool, report format, and product versions on every path", () => {
    for (const mutation of [
      { tool: "not-viewport-qa" },
      { formatVersion: "999" },
      { toolVersion: "99.0.0" },
    ]) {
      const candidate = { ...report, ...mutation } as Report;
      expect(() => validateReportCompatibility(candidate, manifest)).toThrow(/unsupported/u);
      expect(() => validateReportCompatibility(candidate)).toThrow(/unsupported/u);
    }
  });

  it("rejects missing, unknown, or mismatched manifest source/schema metadata", () => {
    const noSchemas = structuredClone(report);
    delete noSchemas.schemaVersions;
    expect(() => validateReportCompatibility(noSchemas, manifest)).toThrow(/schema metadata/u);

    const mismatches: ReviewManifest[] = [];
    for (const [field, value] of [
      ["tool", "different-tool"],
      ["tool_version", "0.2.1"],
      ["format_version", "999"],
      ["report_schema_version", "999"],
      ["manifest_schema_version", 99],
      ["review_state_schema_version", 99],
    ] as const) {
      const candidate = structuredClone(manifest);
      (candidate.source_report as unknown as Record<string, unknown>)[field] = value;
      mismatches.push(candidate);
    }
    for (const candidate of mismatches) {
      expect(() => validateReportCompatibility(report, candidate)).toThrow(/source metadata/u);
    }
    for (const field of [
      "report_schema_version",
      "manifest_schema_version",
      "review_state_schema_version",
    ] as const) {
      const candidate = structuredClone(manifest);
      delete (candidate.source_report as unknown as Record<string, unknown>)[field];
      expect(() => validateReportCompatibility(report, candidate)).toThrow(/source metadata/u);
    }
  });

  it("refuses an unknown manifest-backed report before starting a server", async () => {
    const root = mkdtempSync(join(tmpdir(), "vqa-incompatible-manifest-"));
    roots.push(root);
    const unknown = { ...report, tool: "not-viewport-qa", toolVersion: "99.0.0" } as Report;
    const unknownManifest = structuredClone(manifest);
    unknownManifest.source_report.tool = unknown.tool;
    unknownManifest.source_report.tool_version = unknown.toolVersion;
    writeFileSync(join(root, "issues.json"), JSON.stringify(unknown));
    writeFileSync(join(root, "review-manifest.json"), JSON.stringify(unknownManifest));
    await expect(serveReport({ reportDir: root, port: 0 })).rejects.toThrow(/unsupported report identity/u);
  });
});
