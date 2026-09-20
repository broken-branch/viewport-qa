import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { assertBuilt, FIXTURES, runBin } from "./helpers.js";

/**
 * First dogfood: scan a realistic bundled landing page (fixtures/realworld.html)
 * end-to-end with the real binary. The page is mostly healthy but ships a
 * min-width table, a classic mobile horizontal-scroll bug, which must surface
 * at a narrow viewport and must NOT surface at desktop width.
 */

let outDir: string;
let report: Report;

beforeAll(async () => {
  assertBuilt();
  outDir = mkdtempSync(join(tmpdir(), "vqa-dogfood-"));
  const result = await runBin([
    "scan",
    join(FIXTURES, "realworld.html"),
    "--viewports",
    "360x800,1440x900",
    "--out",
    outDir,
  ]);
  expect(result.code).toBe(0);
  report = JSON.parse(
    readFileSync(join(outDir, "issues.json"), "utf8"),
  ) as Report;
}, 180_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("vqa scan dogfood (realworld fixture, real binary)", () => {
  it("produces a complete report with both viewports", () => {
    expect(report.viewports.map((entry) => entry.viewport.label)).toEqual([
      "360x800@1",
      "1440x900@1",
    ]);
    expect(existsSync(join(outDir, "report.html"))).toBe(true);
  });

  it("finds the mobile-only table overflow at 360px but not at 1440px", () => {
    const overflowAt = (label: string) =>
      report.issues.some(
        (issue) => issue.viewport === label && issue.type === "page-overflow",
      );
    expect(overflowAt("360x800@1")).toBe(true);
    expect(overflowAt("1440x900@1")).toBe(false);
  });
});
