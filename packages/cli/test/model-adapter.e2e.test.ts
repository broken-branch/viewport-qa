import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { assertBuilt, FIXTURES, REPO_ROOT, runBin } from "./helpers.js";
import { compileWindowsTestExecutable } from "../../../scripts/windows-test-powershell.mjs";

const FAKE_CLI = join(
  REPO_ROOT,
  "packages/model-adapter/test/fixtures/fake-model-cli.mjs",
);

let outDir: string;
let fixtureDir: string;
let report: Report;

beforeAll(async () => {
  assertBuilt();
  outDir = mkdtempSync(join(tmpdir(), "vqa-model-cli-e2e-"));
  fixtureDir = mkdtempSync(join(tmpdir(), "vqa-model-cli-fixture-"));
  let fakeCli = FAKE_CLI;
  if (process.platform === "win32") {
    const source = join(fixtureDir, "fake-model-cli.cs");
    fakeCli = join(fixtureDir, "fake-model-cli.exe");
    writeFileSync(source, 'using System; public static class FakeModelCli { public static int Main(string[] args) { Console.Write("{\\"text\\":\\"Use min-width: 0.\\"}"); return 0; } }');
    compileWindowsTestExecutable(fakeCli, source);
  }
  const result = await runBin(
    [
      "scan",
      join(FIXTURES, "seeded-defects.html"),
      "--viewports",
      "390x844",
      "--out",
      outDir,
      "--model-cli",
      "codex",
      "--model-cli-bin",
      fakeCli,
      "--model-cli-timeout",
      "2000",
    ],
    { timeoutMs: 150_000 },
  );
  expect(result.code, result.stderr).toBe(0);
  report = JSON.parse(
    readFileSync(join(outDir, "issues.json"), "utf8"),
  ) as Report;
}, 180_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("vqa scan subscription CLI adapter opt-in (fake binary)", () => {
  it("wires the explicit adapter through the shipped CLI without a live model", () => {
    expect(report.adapter).toEqual({
      impl: "cli-subprocess:codex",
      wired: true,
    });
    expect(report.issues.length).toBeGreaterThan(0);
    for (const issue of report.issues) {
      expect(issue.aiRecommendation).toEqual(issue.behaviour
        ? {
            status: "unavailable",
            reason: "Browser behaviour findings are rule-based and are not sent to model adapters.",
          }
        : {
            status: "ok",
            kind: "ai",
            text: "Use min-width: 0.",
            model: "codex:subscription-default",
          });
    }
    expect(report.issues.some((issue) => issue.behaviour)).toBe(true);
    expect(report.issues.some((issue) => !issue.behaviour)).toBe(true);
  });
});
