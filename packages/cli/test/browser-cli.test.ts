import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_NAME, PRODUCT_VERSION, PROTOCOL_IDENTITY } from "@vqa/contract";
import { assertBuilt, runBin } from "./helpers.js";

describe("browser and doctor CLI", () => {
  beforeAll(assertBuilt);

  it("emits stable JSON and deterministic missing-browser exits", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "vqa-cli-json-")), "cache with spaces-é");
    const env = { ...process.env, VQA_BROWSER_CACHE: cache };
    const status = await runBin(["browser", "status", "--json"], { env });
    expect(status.code).toBe(1);
    expect(status.stderr).toBe("");
    const statusJson = JSON.parse(status.stdout) as {
      schemaVersion: number;
      ok: boolean;
      action: string;
      browser: { recoveryCommand: string; compatibility: { browserRevision: string } };
    };
    expect(statusJson).toMatchObject({ schemaVersion: 1, ok: false, action: "status" });
    expect(statusJson.browser.recoveryCommand).toBe("vqa browser install");
    expect(statusJson.browser.compatibility.browserRevision).toMatch(/^\d+$/u);
    expect(status.stdout).not.toContain("executableRelativePath");

    const doctor = await runBin(["doctor", "--json"], { env });
    expect(doctor.code).toBe(1);
    const doctorJson = JSON.parse(doctor.stdout) as { schemaVersion: number; ok: boolean; product: { name: string; version: string }; protocolIdentity: string; runtime: { nodeSupported: boolean } };
    expect(doctorJson).toMatchObject({ schemaVersion: 1, ok: false });
    expect(doctorJson.product).toEqual({ name: PRODUCT_NAME, version: PRODUCT_VERSION });
    expect(doctorJson.protocolIdentity).toBe(PROTOCOL_IDENTITY);
    expect(doctorJson.runtime.nodeSupported).toBe(true);
  });

  it("returns a JSON failure offline without attempting a download", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "vqa-cli-offline-")), "cache");
    const result = await runBin(["browser", "install", "--json"], {
      env: { ...process.env, VQA_BROWSER_CACHE: cache, VQA_BROWSER_OFFLINE: "1" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      action: "install",
      error: { code: "browser-operation-failed" },
    });
  });

  it("keeps human diagnostics concise", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "vqa-cli-human-")), "cache");
    const result = await runBin(["doctor"], { env: { ...process.env, VQA_BROWSER_CACHE: cache } });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`${PRODUCT_NAME} ${PRODUCT_VERSION} doctor`);
    expect(result.stdout).toContain("Browser: missing");
    expect(result.stdout).toContain("Run: vqa browser install");
  });

  it("uses exit 2 for browser/doctor usage errors", async () => {
    expect((await runBin(["browser", "unknown"])).code).toBe(2);
    expect((await runBin(["doctor", "--unknown"])).code).toBe(2);
  });

  it("keeps doctor JSON stable when cache sizing is denied", async () => {
    if (process.platform === "win32") return;
    const cache = join(mkdtempSync(join(tmpdir(), "vqa-cli-denied-")), "cache");
    const env = { ...process.env, VQA_BROWSER_CACHE: cache };
    const initial = await runBin(["browser", "status", "--json"], { env });
    const revisionRoot = (JSON.parse(initial.stdout) as { browser: { revisionRoot: string } }).browser.revisionRoot;
    mkdirSync(revisionRoot, { recursive: true, mode: 0o700 });
    chmodSync(revisionRoot, 0o000);
    try {
      const result = await runBin(["doctor", "--json"], { env });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        action: "doctor",
        error: { code: "doctor-failed" },
      });
    } finally {
      chmodSync(revisionRoot, 0o700);
    }
  });
});
