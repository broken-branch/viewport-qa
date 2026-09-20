import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_VERSION } from "@vqa/contract";
import type * as FsPromises from "node:fs/promises";

const fault = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      if (
        fault.enabled &&
        String(source).includes(".vqa-staging-") &&
        basename(String(destination)) === "report"
      ) {
        throw Object.assign(new Error("persistent staging promotion EIO"), { code: "EIO" });
      }
      return actual.rename(source, destination);
    },
  };
});

import {
  replaceReportTransaction,
  validateCompletedReport,
} from "../src/report-transaction.js";

const roots: string[] = [];

function writeValidReport(root: string, marker: string): void {
  mkdirSync(root, { recursive: true });
  const report = {
    formatVersion: "3",
    tool: "viewport-qa",
    toolVersion: PRODUCT_VERSION,
    url: `file:///${marker}.html`,
    createdAt: "2026-08-23T00:00:00.000Z",
    adapter: { impl: "stub", wired: false },
    viewports: [],
    issues: [],
  };
  const manifest = {
    artifact_type: "vq-review-manifest",
    schema_version: 1,
    manifest_id: `manifest-${marker}`,
    run_id: `run-${marker}`,
    source_report: {
      tool: "viewport-qa",
      tool_version: PRODUCT_VERSION,
      format_version: "3",
      source_sha: marker,
      report_schema_version: "3",
      manifest_schema_version: 1,
      review_state_schema_version: 2,
    },
    pages: [],
    states: [],
    assets: [],
    issues: [],
    captures: [],
    audit_verdict: {
      value: "PASS",
      policy_id: "vq-detected-issues-v1",
      reason_codes: ["NO_DETECTED_ISSUES"],
    },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const state = {
    artifact_type: "vq-review-state",
    schema_version: 2,
    manifest_id: manifest.manifest_id,
    manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    issues: {},
    highlights: {},
  };
  writeFileSync(join(root, "issues.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(root, "review-manifest.json"), manifestBytes);
  writeFileSync(join(root, "review-state.json"), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(root, "report.html"), '<script id="vqa-manifest"></script>');
}

afterEach(() => {
  fault.enabled = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent report promotion failure", () => {
  it("restores the valid last-good backup without retrying staging promotion", async () => {
    const root = mkdtempSync(join(tmpdir(), "vqa-persistent-promotion-fault-"));
    roots.push(root);
    const destination = join(root, "report");
    writeValidReport(destination, "old");
    fault.enabled = true;

    await expect(replaceReportTransaction(destination, async (staging) => {
      writeValidReport(staging, "new");
    })).rejects.toThrow("persistent staging promotion EIO");

    await expect(validateCompletedReport(destination)).resolves.toBeUndefined();
    const restored = JSON.parse(readFileSync(join(destination, "issues.json"), "utf8")) as {
      url: string;
    };
    expect(restored.url).toBe("file:///old.html");
    expect(readdirSync(root)).toEqual(["report"]);
  });
});
