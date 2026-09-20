import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { assertBuilt, FIXTURES, runBin } from "./helpers.js";

/**
 * Noise-regression canary (the mirror image of scan.e2e.test.ts):
 * fixtures/false-positives.html contains ONLY healthy, intentional UI idioms
 * that the first real-world run mis-flagged:
 *
 *   - children of a closed <details> and of an aria-hidden collapsed panel
 *   - a stretched-link card (anchor covering its card)
 *   - a standard sr-only (1px clip) accessibility span
 *   - healthy text contrast, distinct colors, and a fitting generic font
 *   - interactive elements below the fold of a scrollable container on an
 *     app-shell page (document itself does not scroll)
 *
 * A correct scan reports ZERO issues. Removing any suppression makes this
 * suite fail, exactly as removing a detector makes the seeded suite fail.
 */

let outDir: string;
let report: Report;

beforeAll(async () => {
  assertBuilt();
  outDir = mkdtempSync(join(tmpdir(), "vqa-fp-"));
  const result = await runBin([
    "scan",
    join(FIXTURES, "false-positives.html"),
    "--viewports",
    "390x844,1280x800",
    "--out",
    outDir,
  ]);
  expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  report = JSON.parse(
    readFileSync(join(outDir, "issues.json"), "utf8"),
  ) as Report;
}, 180_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function issuesTouching(fragment: string) {
  return report.issues.filter(
    (issue) =>
      issue.selector.includes(fragment) ||
      (issue.otherSelector ?? "").includes(fragment),
  );
}

describe("vqa scan (false-positive fixture, real binary)", () => {
  it("reports zero issues for closed-details content", () => {
    expect(issuesTouching("fp-details")).toEqual([]);
  });

  it("reports zero issues for aria-hidden collapsed-panel content", () => {
    expect(issuesTouching("fp-panel")).toEqual([]);
    expect(issuesTouching("fp-collapsed-panel")).toEqual([]);
  });

  it("reports zero overlap issues for the stretched-link card", () => {
    expect(issuesTouching("fp-card")).toEqual([]);
    expect(issuesTouching("fp-stretched")).toEqual([]);
  });

  it("reports zero issues for the sr-only accessibility span", () => {
    expect(issuesTouching("fp-sr-only")).toEqual([]);
  });

  it("accepts healthy contrast, color, and font-rendering cases", () => {
    expect(issuesTouching("fp-contrast-pass")).toEqual([]);
    expect(issuesTouching("fp-color-pass")).toEqual([]);
    expect(issuesTouching("fp-font-pass")).toEqual([]);
  });

  it("reports zero offscreen issues for below-the-fold content in a scrollable container", () => {
    expect(issuesTouching("fp-below-fold")).toEqual([]);
  });

  it("reports zero issues overall on this all-intentional page", () => {
    expect(
      report.issues.map((issue) => `${issue.type} ${issue.selector}`),
    ).toEqual([]);
    for (const viewport of report.viewports) {
      expect(viewport.issueCount).toBe(0);
      expect(viewport.rawIssueCount).toBe(0);
    }
  });
});
