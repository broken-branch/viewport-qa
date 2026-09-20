import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserMutationResult, BrowserStatus } from "@vqa/engine";
import { launchStudio } from "../src/launcher.js";
import type { LauncherBrowserManager } from "../src/launcher.js";
import { assertPortClosed } from "./helpers.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type BrowserSetup = {
  phase: "missing" | "installing" | "failed" | "ready";
  browser: BrowserStatus;
  disclosure: {
    browserVersion: string;
    browserRevision: string;
    downloadUrl: string;
    downloadBytes: number;
    networkOrigin: string;
    destination: string;
    configuration: BrowserStatus["configuration"];
    privacy: string;
  };
  actions: { canInstall: boolean; canRetry: boolean; canQuit: boolean };
  error?: string;
};

function browserStatus(health: BrowserStatus["health"], cacheRoot: string): BrowserStatus {
  const compatibility = {
    playwrightVersion: "1.61.0",
    browser: "chromium" as const,
    browserVersion: "149.0.7827.55",
    browserRevision: "1228",
    payload: "full-chromium" as const,
  };
  return {
    schemaVersion: 1,
    ok: health === "installed",
    health,
    compatibility,
    cacheRoot,
    revisionRoot: join(cacheRoot, "pw-1.61.0-chromium-1228"),
    executablePath: join(cacheRoot, "pw-1.61.0-chromium-1228", "chromium-1228", "chrome-linux64", "chrome"),
    cacheOverride: true,
    configuration: { offline: false, proxy: true, customCertificateAuthority: true, mirror: false },
    diagnostics: health === "installed" ? [] : [{
      code: "browser-missing",
      message: "The compatible browser is not installed.",
      remediation: ["Run: vqa browser install"],
    }],
    ...(health === "installed" ? {} : { recoveryCommand: "vqa browser install" as const }),
  };
}

async function setup(options: { browserManager?: LauncherBrowserManager } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vqa-launcher-first-run-"));
  roots.push(root);
  const browserCache = join(root, "browser cache");
  let installed = false;
  let installAttempts = 0;
  const studio = await launchStudio({
    idleTimeoutMs: 0,
    stateRoot: join(root, "state"),
    reportsRoot: join(root, "reports"),
    cacheRoot: join(root, "launcher-cache"),
    browserManager: options.browserManager ?? {
      status: async () => browserStatus(installed ? "installed" : "missing", browserCache),
      install: async () => {
        installAttempts += 1;
        if (installAttempts === 1) throw new Error("deterministic browser authentication failure");
        installed = true;
        return { status: browserStatus("installed", browserCache), changed: true, removedRevisionRoots: [] } satisfies BrowserMutationResult;
      },
    },
  });
  servers.push(studio.server);
  const launch = new URL(studio.url);
  const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `VQA ${capability}`);
    if (!["GET", "HEAD"].includes(init.method ?? "GET")) {
      headers.set("origin", launch.origin);
      headers.set("content-type", "application/json");
    }
    return fetch(new URL(path, launch.origin), { ...init, headers });
  };
  return {
    browserCache,
    call,
    get installAttempts() { return installAttempts; },
    launch,
  };
}

async function browserSetup(call: Awaited<ReturnType<typeof setup>>["call"]): Promise<BrowserSetup> {
  const response = await call("/api/browser-setup");
  expect(response.status, "first-run contract requires GET /api/browser-setup").toBe(200);
  return await response.json() as BrowserSetup;
}

async function waitForPhase(
  call: Awaited<ReturnType<typeof setup>>["call"],
  wanted: BrowserSetup["phase"],
): Promise<BrowserSetup> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await browserSetup(call);
    if (state.phase === wanted) return state;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`timed out waiting for browser setup phase ${wanted}`);
}

describe("launcher first-run managed browser controller", () => {
  it("detects a missing browser, discloses setup before installation, and keeps scan capability/private-origin protected", async () => {
    const firstRun = await setup();
    const unauthorized = await fetch(new URL("/api/browser-setup", firstRun.launch.origin));
    expect(unauthorized.status).toBe(401);
    expect(await fetch(new URL("/api/browser-setup", firstRun.launch.origin), {
      headers: { authorization: `VQA ${new URLSearchParams(firstRun.launch.hash.slice(1)).get("cap")!}`, origin: "https://attacker.invalid" },
    })).toHaveProperty("status", 403);

    const initial = await browserSetup(firstRun.call);
    expect(initial).toMatchObject({
      phase: "missing",
      browser: {
        ok: false,
        health: "missing",
        compatibility: { playwrightVersion: "1.61.0", browserVersion: "149.0.7827.55", browserRevision: "1228" },
      },
      disclosure: {
        browserVersion: "149.0.7827.55",
        browserRevision: "1228",
        downloadUrl: expect.stringMatching(/^https:\/\//u),
        downloadBytes: expect.any(Number),
        networkOrigin: "https://cdn.playwright.dev",
        destination: expect.stringContaining(firstRun.browserCache),
        configuration: { offline: false, proxy: true, customCertificateAuthority: true, mirror: false },
        privacy: expect.any(String),
      },
      actions: { canInstall: true, canRetry: false, canQuit: true },
    });
    expect(initial.disclosure.downloadBytes).toBeGreaterThan(100_000_000);
    expect(firstRun.installAttempts).toBe(0);

    const blockedScan = await firstRun.call("/api/scan", { method: "POST", body: JSON.stringify({}) });
    expect(blockedScan.status, "a browser-missing launcher must not start scan setup before browser setup is ready").toBe(409);
  });

  it("requires consent, leaves a failed setup retryable without a promoted browser, and continues to the scan screen only when ready", async () => {
    const firstRun = await setup();
    await browserSetup(firstRun.call);

    const denied = await firstRun.call("/api/browser-setup/install", { method: "POST", body: JSON.stringify({ consent: false }) });
    expect(denied.status).toBe(400);
    expect(firstRun.installAttempts).toBe(0);

    const firstAttempt = await firstRun.call("/api/browser-setup/install", { method: "POST", body: JSON.stringify({ consent: true }) });
    expect(firstAttempt.status, "first-run contract requires POST /api/browser-setup/install after explicit consent").toBe(202);
    expect((await waitForPhase(firstRun.call, "failed")).actions).toMatchObject({ canInstall: true, canRetry: true, canQuit: true });
    expect(firstRun.installAttempts).toBe(1);
    expect((await firstRun.call("/api/scan", { method: "POST", body: JSON.stringify({}) })).status).toBe(409);

    const retry = await firstRun.call("/api/browser-setup/install", { method: "POST", body: JSON.stringify({ consent: true }) });
    expect(retry.status).toBe(202);
    const ready = await waitForPhase(firstRun.call, "ready");
    expect(ready.browser).toMatchObject({ ok: true, health: "installed" });
    expect(ready.actions).toMatchObject({ canInstall: false, canRetry: false, canQuit: true });
    expect(firstRun.installAttempts).toBe(2);

    const app = await firstRun.call("/app");
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("Start a visual review");
    const admittedScan = await firstRun.call("/api/scan", { method: "POST", body: JSON.stringify({}) });
    expect(admittedScan.status, "ready setup must hand off to the existing scan controller instead of returning browser-setup conflict").toBe(400);
  });

  it("quits from missing setup without invoking the installer", async () => {
    const firstRun = await setup();
    await browserSetup(firstRun.call);
    const stop = await firstRun.call("/api/stop", { method: "POST", body: "{}" });
    expect(stop.status).toBe(202);
    await assertPortClosed(firstRun.launch.href);
    expect(firstRun.installAttempts).toBe(0);
  });

  it("aborts and joins browser setup during Stop, without accepting a late ready result", async () => {
    const root = mkdtempSync(join(tmpdir(), "vqa-launcher-first-run-abort-"));
    roots.push(root);
    const browserCache = join(root, "browser-cache");
    let installed = false;
    let abortObserved = false;
    let statusCalls = 0;
    let completeLate!: () => void;
    const controlledManager: LauncherBrowserManager = {
      status: async () => {
        statusCalls += 1;
        return browserStatus(installed ? "installed" : "missing", browserCache);
      },
      install: (_repair, signal) => new Promise<BrowserMutationResult>((resolvePromise) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          // Simulate an installer reporting a successful result after cancellation.
          queueMicrotask(() => {
            installed = true;
            resolvePromise({ status: browserStatus("installed", browserCache), changed: true, removedRevisionRoots: [] });
          });
        }, { once: true });
        completeLate = () => {
          installed = true;
          resolvePromise({ status: browserStatus("installed", browserCache), changed: true, removedRevisionRoots: [] });
        };
      }),
    };
    const firstRun = await setup({ browserManager: controlledManager });
    await browserSetup(firstRun.call);
    expect((await firstRun.call("/api/browser-setup/install", { method: "POST", body: JSON.stringify({ consent: true }) })).status).toBe(202);

    expect((await firstRun.call("/api/stop", { method: "POST", body: "{}" })).status).toBe(202);
    await assertPortClosed(firstRun.launch.href);
    expect(abortObserved).toBe(true);

    completeLate();
    await new Promise((done) => setImmediate(done));
    expect(installed).toBe(true);
    expect(statusCalls).toBe(1);
  });
});
