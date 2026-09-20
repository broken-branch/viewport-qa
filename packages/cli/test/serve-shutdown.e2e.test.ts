import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_VERSION, type Report } from "@vqa/contract";
import {
  assertBuilt,
  assertPortClosed,
  BIN,
  captureBrowserLaunch,
  waitForExit,
} from "./helpers.js";

describe("vqa serve shutdown (real built binary)", () => {
  (process.platform === "win32" ? it.skip : it)("answers HTTP and exits cleanly and promptly on SIGTERM", async () => {
    assertBuilt();
    const reportDir = mkdtempSync(join(tmpdir(), "vqa-serve-shutdown-"));
    const report: Report = {
      formatVersion: "2",
      tool: "viewport-qa",
      toolVersion: "0.2.0",
      url: "file:///shutdown-regression.html",
      createdAt: "2026-08-23T00:00:00.000Z",
      adapter: { impl: "stub", wired: false },
      viewports: [],
      issues: [],
    };
    writeFileSync(join(reportDir, "issues.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(
      join(reportDir, "report.html"),
      "<!doctype html><title>shutdown regression</title>ready",
    );
    const browserLaunch = captureBrowserLaunch();
    const child = spawn(BIN, ["serve", reportDir, "--port", "0"], {
      env: browserLaunch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });

    try {
      const url = await browserLaunch.waitForUrl(child);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(output).not.toContain("#cap=");
      expect(output).toContain(new URL(url).origin);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Opening Viewport QA");
      const launch = new URL(url);
      const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
      const app = await fetch(new URL("app", url), { headers: { authorization: `VQA ${capability}` } });
      expect(await app.text()).toContain("Legacy format-v2 report: read-only access");

      const exitPromise = waitForExit(child, 3_000);
      expect(child.kill("SIGTERM")).toBe(true);
      await expect(exitPromise).resolves.toEqual({ code: 0, signal: null });
      await assertPortClosed(url);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      browserLaunch.cleanup();
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it("stops and releases the writer lock when vqa open cannot launch a browser", async () => {
    assertBuilt();
    const reportDir = mkdtempSync(join(tmpdir(), "vqa-open-failure-"));
    cpSync(new URL("../../engine/test/fixtures/review-journey/", import.meta.url), reportDir, { recursive: true });
    const report: Report = {
      formatVersion: "2", tool: "viewport-qa", toolVersion: PRODUCT_VERSION,
      schemaVersions: { report: "2", manifest: 1, reviewState: 1 },
      url: "file:///open-failure.html", createdAt: "2026-08-23T00:00:00.000Z",
      adapter: { impl: "stub", wired: false }, viewports: [], issues: [],
    };
    writeFileSync(join(reportDir, "issues.json"), `${JSON.stringify(report)}\n`);
    const missingOpener = join(reportDir, "nonexistent-desktop-opener");
    expect(existsSync(missingOpener)).toBe(false);
    const child = spawn(process.execPath, [BIN, "open", reportDir], {
      env: { ...process.env, VQA_DESKTOP_OPEN: missingOpener }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    try {
      await expect(waitForExit(child, 5_000)).resolves.toEqual({ code: 1, signal: null });
      expect(output).toContain("could not launch the system browser");
      expect(output).toContain("VQA_DESKTOP_OPEN does not exist");
      expect(existsSync(join(reportDir, "..", `.${basename(reportDir)}.vqa-transaction.lock`))).toBe(false);
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); rmSync(reportDir, { recursive: true, force: true }); }
  });
});
