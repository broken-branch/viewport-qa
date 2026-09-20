import { createServer } from "node:http";
import type { Server } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Page } from "playwright";
import { PRODUCT_VERSION } from "@vqa/contract";
import type { BrowserStatus } from "@vqa/engine";
import { launchStudio } from "../src/launcher.js";
import type { LauncherOptions } from "../src/launcher.js";
import { assertPortClosed } from "./helpers.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); return { server, origin: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
}

/** Leave only the given catalogue sizes checked on the start page; the defaults are the whole catalogue. */
async function chooseSizes(page: Page, sizes: string[]): Promise<void> {
  await page.locator("#devices").waitFor();
  await page.evaluate((keep) => {
    document.querySelectorAll<HTMLInputElement>(".device-toggle").forEach((toggle) => { toggle.checked = true; });
    document.querySelectorAll<HTMLInputElement>(".vp").forEach((input) => { input.checked = keep.includes(input.value); });
    document.querySelector<HTMLInputElement>(".vp")!.dispatchEvent(new Event("change", { bubbles: true }));
  }, sizes);
}

function readyBrowserManager(root: string): NonNullable<LauncherOptions["browserManager"]> {
  const cacheRoot = join(root, "browser-cache");
  const status: BrowserStatus = {
    schemaVersion: 1,
    ok: true,
    health: "installed",
    compatibility: { playwrightVersion: "1.61.0", browser: "chromium", browserRevision: "1228", browserVersion: "149.0.7827.55", payload: "full-chromium" },
    cacheRoot,
    revisionRoot: join(cacheRoot, "pw-1.61.0-chromium-1228"),
    executablePath: chromium.executablePath(),
    cacheOverride: true,
    configuration: { proxy: false, customCertificateAuthority: false, mirror: false, offline: false },
    diagnostics: [],
  };
  return {
    status: async () => status,
    install: async () => ({ status, changed: false, removedRevisionRoots: [] }),
  };
}

async function setup(options: Omit<LauncherOptions, "stateRoot" | "reportsRoot" | "cacheRoot"> = {}) {
  const root = mkdtempSync(join(tmpdir(), "vqa-launcher-")); roots.push(root);
  const studio = await launchStudio({ idleTimeoutMs: 0, browserManager: readyBrowserManager(root), ...options, stateRoot: join(root, "state"), reportsRoot: join(root, "reports"), cacheRoot: join(root, "cache") });
  servers.push(studio.server);
  const launch = new URL(studio.url); const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set("authorization", `VQA ${capability}`);
    const method = init.method ?? "GET"; if (!["GET", "HEAD"].includes(method)) { headers.set("origin", launch.origin); headers.set("content-type", "application/json"); }
    return fetch(new URL(path, launch.origin), { ...init, headers });
  };
  return { root, launch, capability, call };
}

async function waitFor(call: ReturnType<typeof setup> extends Promise<infer T> ? T["call"] : never, wanted: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await (await call("/api/job")).json() as Record<string, unknown>;
    if (state.status === wanted) return state;
    if (["failed", "cancelled"].includes(String(state.status)) && state.status !== wanted) throw new Error(JSON.stringify(state));
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`timed out waiting for ${wanted}`);
}

describe("Linux no-terminal launcher controller", () => {
  it("keeps the bootstrap generic and all controller state capability/private-origin protected", async () => {
    const { launch, capability, call } = await setup();
    const bootstrap = await fetch(launch.origin); expect(bootstrap.status).toBe(200); expect(await bootstrap.text()).not.toContain("Viewport QA Reports");
    expect((await fetch(new URL("/app", launch.origin))).status).toBe(401);
    const rebound = new URL("/api/job", launch.origin); rebound.hostname = "localhost";
    expect((await fetch(rebound, { headers: { authorization: `VQA ${capability}` } })).status).toBe(421);
    expect((await fetch(new URL("/api/scan", launch.origin), { method: "POST", headers: { authorization: `VQA ${capability}`, origin: "https://attacker.test", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(new URL("/api/scan", launch.origin), { method: "POST", headers: { authorization: `VQA ${capability}`, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(new URL("/api/scan", launch.origin), { method: "POST", headers: { authorization: `VQA ${capability}`, origin: launch.origin, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await fetch(new URL("/api/job", launch.origin), { headers: { authorization: `VQA ${capability}`, origin: "null" } })).status).toBe(403);
    const other = await setup(); expect((await fetch(new URL("/api/job", other.launch.origin), { headers: { authorization: `VQA ${capability}` } })).status).toBe(401);
    const app = await call("/app"); expect(app.status).toBe(200); expect(await app.text()).toContain("Start a visual review");
  });

  it("returns Home and New Review without stopping the service or losing persisted review state", async () => {
    const launched = await setup();
    const reportId = "synthetic-persisted-review";
    const reportPath = join(launched.root, "reports", reportId);
    cpSync(new URL("../../engine/test/fixtures/review-journey/", import.meta.url), reportPath, { recursive: true });
    writeFileSync(join(reportPath, "issues.json"), `${JSON.stringify({
      formatVersion: "2",
      tool: "viewport-qa",
      toolVersion: PRODUCT_VERSION,
      schemaVersions: { report: "2", manifest: 1, reviewState: 2 },
      url: "https://launcher-navigation.example/",
      createdAt: "2026-08-24T12:00:00.000Z",
      adapter: { impl: "stub", wired: false },
      viewports: [],
      issues: [],
    })}\n`);
    writeFileSync(join(launched.root, "state", "launcher-reports.json"), `${JSON.stringify({
      version: 1,
      reports: [{ id: reportId, name: "Synthetic navigation review", path: reportPath, createdAt: "2026-08-24T12:00:00.000Z" }],
    })}\n`);

    expect((await launched.call("/api/open-report", { method: "POST", body: JSON.stringify({ id: reportId }) })).status).toBe(200);
    const issueId = "VQ-ISSUE-HOME-LOW-CONTRAST-CTA";
    expect((await launched.call("/api/review", { method: "POST", body: JSON.stringify({ issueId, status: "export" }) })).status).toBe(200);
    const home = await launched.call("/api/navigation/home", { method: "POST", body: "{}" });
    expect(home.status).toBe(200);
    const launcherHtml = await (await launched.call("/app")).text();
    expect(launcherHtml).toContain("Start a visual review");
    expect(launcherHtml).toContain('role="status" aria-live="polite"');
    expect(launcherHtml).toContain('id="recentTitle" tabindex="-1"');
    expect(await (await launched.call("/api/job")).json()).toMatchObject({
      progress: "Current review saved locally. Recent reports are ready.",
      focusTarget: "recent",
    });
    const saved = JSON.parse(readFileSync(join(reportPath, "review-state.json"), "utf8")) as { issues: Record<string, { status: string }> };
    expect(saved.issues[issueId]!.status).toBe("export");
    expect((await launched.call("/api/job")).status).toBe(200);

    expect((await launched.call("/api/open-report", { method: "POST", body: JSON.stringify({ id: reportId }) })).status).toBe(200);
    const fresh = await launched.call("/api/navigation/new-review", { method: "POST", body: "{}" });
    expect(fresh.status).toBe(200);
    const state = await (await launched.call("/api/job")).json() as { progress: string; focusTarget: string };
    expect(state).toMatchObject({
      progress: "Current review saved locally. Ready to start a new review.",
      focusTarget: "url",
    });
    expect((await launched.call("/api/job")).status).toBe(200);
  });

  it("scans a selected local self-contained file and transitions to the authenticated manifest GUI", async () => {
    const { root, call } = await setup();
    const response = await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "file", localFile: { name: "My page.html", content: "<!doctype html><title>Local proof</title><main><h1>Hello</h1></main>" }, viewports: ["390x844"] }) });
    expect(response.status).toBe(202);
    const state = await waitFor(call, "complete"); expect(existsSync(String(state.reportPath))).toBe(true);
    const app = await call("/app"); const csp = app.headers.get("content-security-policy")!; const appBody = await app.text();
    expect(appBody).toContain("Review screenshots");
    const nonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1]; expect(nonce).toBeTruthy();
    expect([...appBody.matchAll(/<script nonce="([^"]+)"/gu)].every((match) => match[1] === nonce)).toBe(true);
    expect(Number(app.headers.get("content-length"))).toBe(Buffer.byteLength(appBody));
    const appHead = await call("/app", { method: "HEAD" }); expect(appHead.headers.get("content-security-policy")).toBe(csp); expect(Number(appHead.headers.get("content-length"))).toBe(Buffer.byteLength(appBody)); expect(await appHead.text()).toBe("");
    const recent = await (await call("/api/recent")).json() as { reports: Array<{ id: string }> }; expect(recent.reports).toHaveLength(1);
    expect((await call("/api/open-report", { method: "POST", body: JSON.stringify({ id: recent.reports[0]!.id }) })).status).toBe(200);
    expect(await (await call("/app")).text()).toContain("Review screenshots");
    expect(readdirSync(join(root, "cache"))).toHaveLength(0);
  }, 30_000);

  it("scans a page whose assets come from another origin without asking for anything", async () => {
    const assetRequests: string[] = [];
    const asset = await listen((request, response) => { assetRequests.push(request.url ?? ""); response.writeHead(200, { "content-type": "image/svg+xml" }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'); });
    const page = await listen((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><img src="${asset.origin}/pixel.svg"><h1>Dependency</h1>`); });
    const { call } = await setup();
    await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "url", url: `${page.origin}/`, viewports: ["390x844"] }) });
    const done = await waitFor(call, "complete");
    expect(done.requiredOrigins).toBeUndefined();
    expect(assetRequests).toContain("/pixel.svg");
    expect((await call("/api/approve-origins", { method: "POST", body: "{}" })).status).not.toBe(202);
  }, 30_000);

  it("cancels transactionally and never trusts a forged recent-report index entry", async () => {
    const hanging = await listen(() => {});
    const root = mkdtempSync(join(tmpdir(), "vqa-launcher-forged-")); roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "vqa-launcher-outside-")); roots.push(outside); writeFileSync(join(outside, "review-manifest.json"), "{}");
    const stateRoot = join(root, "state"); await import("node:fs/promises").then(({ mkdir }) => mkdir(stateRoot, { recursive: true }));
    writeFileSync(join(stateRoot, "launcher-reports.json"), JSON.stringify({ version: 1, reports: [{ id: "forged", name: "forged", path: outside, createdAt: new Date().toISOString() }] }));
    const studio = await launchStudio({ stateRoot, reportsRoot: join(root, "reports"), cacheRoot: join(root, "cache"), browserManager: readyBrowserManager(root), idleTimeoutMs: 0 }); servers.push(studio.server);
    const launch = new URL(studio.url); const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
    const call = (path: string, init: RequestInit = {}) => { const headers = new Headers(init.headers); headers.set("authorization", `VQA ${capability}`); if ((init.method ?? "GET") === "POST") { headers.set("origin", launch.origin); headers.set("content-type", "application/json"); } return fetch(new URL(path, launch.origin), { ...init, headers }); };
    expect(((await (await call("/api/recent")).json()) as { reports: unknown[] }).reports).toHaveLength(0);
    await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "url", url: `${hanging.origin}/`, viewports: ["390x844"] }) });
    await new Promise((done) => setTimeout(done, 200)); await call("/api/cancel", { method: "POST", body: "{}" }); await waitFor(call, "cancelled");
    expect(readdirSync(join(root, "reports"))).toHaveLength(0);
  }, 30_000);

  it("keeps one job owner while rejecting report-open and a second scan, then stops cleanly", async () => {
    let firstHits = 0; let secondHits = 0;
    const firstTarget = await listen(() => { firstHits += 1; });
    const secondTarget = await listen(() => { secondHits += 1; });
    const { call, launch } = await setup();
    await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "file", localFile: { name: "recent.html", content: "<!doctype html><h1>Recent</h1>" }, viewports: ["390x844"] }) });
    await waitFor(call, "complete");
    const recent = await (await call("/api/recent")).json() as { reports: Array<{ id: string }> };
    await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "url", url: `${firstTarget.origin}/`, viewports: ["390x844"] }) });
    const deadline = Date.now() + 5_000; while (firstHits === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    expect(firstHits).toBeGreaterThan(0);
    expect((await call("/api/open-report", { method: "POST", body: JSON.stringify({ id: recent.reports[0]!.id }) })).status).toBe(409);
    expect((await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "url", url: `${secondTarget.origin}/`, viewports: ["390x844"] }) })).status).toBe(409);
    expect(secondHits).toBe(0);
    expect((await call("/api/stop", { method: "POST", body: "{}" })).status).toBe(202);
    const closeDeadline = Date.now() + 10_000; while (true) { try { await assertPortClosed(launch.href); break; } catch (error) { if (Date.now() >= closeDeadline) throw error; await new Promise((done) => setTimeout(done, 25)); } }
    expect(secondHits).toBe(0);
  }, 30_000);

  it("stops accepting connections before delayed shutdown cleanup completes", async () => {
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((done) => { releaseCleanup = done; });
    const { call, launch } = await setup({ testHooks: { beforeShutdownCleanup: () => cleanupReleased } });
    try {
      expect((await call("/api/stop", { method: "POST", body: "{}" })).status).toBe(202);
      const closeDeadline = Date.now() + 2_000;
      while (true) {
        try { await assertPortClosed(launch.href); break; }
        catch (error) { if (Date.now() >= closeDeadline) throw error; await new Promise((done) => setTimeout(done, 25)); }
      }
    } finally {
      releaseCleanup();
    }
  });

  it("exposes an awaitable shutdown boundary for signal handlers", async () => {
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((done) => { releaseCleanup = done; });
    const root = mkdtempSync(join(tmpdir(), "vqa-launcher-awaitable-shutdown-")); roots.push(root);
    const studio = await launchStudio({
      stateRoot: join(root, "state"),
      reportsRoot: join(root, "reports"),
      cacheRoot: join(root, "cache"),
      browserManager: readyBrowserManager(root),
      idleTimeoutMs: 0,
      testHooks: { beforeShutdownCleanup: () => cleanupReleased },
    });
    servers.push(studio.server);
    let settled = false;
    const shutdown = studio.shutdown().then(() => { settled = true; });
    await new Promise((done) => setTimeout(done, 50));
    expect(settled).toBe(false);
    releaseCleanup();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("removes a staged local upload after the scan completes, when it is cancelled, and when the service stops mid-scan", async () => {
    const dependency = await listen((_request, response) => { response.end("asset"); });
    const hanging = await listen(() => {});
    const first = await setup();
    const upload = { kind: "file", localFile: { name: "upload.html", content: `<!doctype html><img src="${dependency.origin}/asset"><h1>Upload</h1>` }, viewports: ["390x844"] };
    const stuck = { kind: "file", localFile: { name: "stuck.html", content: `<!doctype html><img src="${hanging.origin}/never"><h1>Stuck</h1>` }, viewports: ["390x844"] };
    await first.call("/api/scan", { method: "POST", body: JSON.stringify(upload) }); await waitFor(first.call, "complete");
    expect(readdirSync(join(first.root, "cache"))).toHaveLength(0);

    await first.call("/api/scan", { method: "POST", body: JSON.stringify(stuck) });
    await new Promise((done) => setTimeout(done, 300));
    expect(readdirSync(join(first.root, "cache"))).toHaveLength(1);
    expect((await first.call("/api/cancel", { method: "POST", body: "{}" })).status).toBe(202);
    await waitFor(first.call, "cancelled");
    expect(readdirSync(join(first.root, "cache"))).toHaveLength(0);

    await first.call("/api/scan", { method: "POST", body: JSON.stringify(stuck) });
    await new Promise((done) => setTimeout(done, 300));
    expect(readdirSync(join(first.root, "cache"))).toHaveLength(1);
    await first.call("/api/stop", { method: "POST", body: "{}" });
    const closeDeadline = Date.now() + 10_000; while (true) { try { await assertPortClosed(first.launch.href); break; } catch (error) { if (Date.now() >= closeDeadline) throw error; await new Promise((done) => setTimeout(done, 100)); } }
    expect(readdirSync(join(first.root, "cache"))).toHaveLength(0);
  }, 45_000);

  it("admits every advertised 8 MB UTF-8 file through the bounded JSON transport", async () => {
    const { call, root } = await setup();
    const admitted = [() => "\"".repeat(4_600_000), () => "\\".repeat(4_600_000), () => "\u0001".repeat(8_000_000), () => "é".repeat(4_000_000)];
    for (const makeContent of admitted) {
      const content = makeContent();
      const response = await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "file", localFile: { name: "boundary.html", content }, viewports: ["390x844"] }) });
      expect(response.status).toBe(202);
      expect((await call("/api/cancel", { method: "POST", body: "{}" })).status).toBe(202);
      await waitFor(call, "cancelled");
      expect(readdirSync(join(root, "cache"))).toHaveLength(0);
    }
    const tooLarge = await call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "file", localFile: { name: "too-large.html", content: "é".repeat(4_000_001) }, viewports: ["390x844"] }) });
    expect(tooLarge.status).toBe(400);
  }, 60_000);

  it("keeps a published report open and reports an honest warning when recent indexing fails", async () => {
    const launched = await setup({ testHooks: { beforeIndexWrite: () => { throw new Error("deterministic recent index failure"); } } });
    await launched.call("/api/scan", { method: "POST", body: JSON.stringify({ kind: "file", localFile: { name: "published.html", content: "<!doctype html><h1>Published</h1>" }, viewports: ["390x844"] }) });
    const deadline = Date.now() + 20_000; let state: Record<string, unknown> = {};
    while (Date.now() < deadline) { state = await (await launched.call("/api/job")).json() as Record<string, unknown>; if (state.warning) break; await new Promise((done) => setTimeout(done, 25)); }
    expect(state.status).toBe("complete"); expect(state.warning).toContain("could not be added to Recent Reports"); expect(state.progress).not.toContain("No report was published");
    expect(existsSync(String(state.reportPath))).toBe(true);
    expect(await (await launched.call("/app")).text()).toContain("Review screenshots");
    expect(((await (await launched.call("/api/recent")).json()) as { reports: unknown[] }).reports).toHaveLength(0);
  }, 30_000);

  it("holds an index-warning interstitial until the human explicitly opens the published report", async () => {
    const launched = await setup({ testHooks: { beforeIndexWrite: () => { throw new Error("deterministic browser index failure"); } } });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(launched.launch.href);
      await page.locator("#fileTab").click();
      await page.locator("#file").setInputFiles({ name: "warning.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><title>Warning proof</title><h1>Published</h1>") });
      await chooseSizes(page, ["390x844", "1366x768"]);
      await page.locator("#scan").click();
      await page.locator("#openCompleted").waitFor({ timeout: 20_000 });
      const state = await (await launched.call("/api/job")).json() as { reportPath: string; warning: string };
      expect(await page.locator("#status").textContent()).toContain("Report saved — action needed.");
      expect(await page.locator("#status").textContent()).toContain("could not be added to Recent Reports");
      expect(await page.locator("#location").textContent()).toBe(state.reportPath);
      expect(await page.locator("article.capture").count()).toBe(0);
      await page.locator("#openCompleted").click();
      await page.locator("article.capture").first().waitFor({ timeout: 10_000 });
      expect(await page.locator("article.capture").count()).toBe(2);
    } finally {
      await browser.close();
    }
  }, 40_000);

  it("boots through the capability fragment, transitions to a working review, persists, and reopens recent", async () => {
    const first = await setup();
    const browser = await chromium.launch({ headless: true });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      await page.goto(first.launch.href);
      await page.locator("h1", { hasText: "Start a visual review" }).waitFor();

      // Devices come first; a device's sizes follow it and start all on.
      expect(await page.locator(".device").count()).toBe(3);
      expect(await page.locator(".device-toggle").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["mobile", "tablet", "desktop"]);
      const catalogue = await page.locator(".vp").count();
      expect(await page.locator(".vp:checked:enabled").count()).toBe(catalogue);
      expect(await page.locator("#captureCount").textContent()).toBe(`${catalogue} captures per page`);
      await page.locator('.device-toggle[value="tablet"]').uncheck();
      expect(await page.locator('.device[aria-label="Tablet sizes"] .vp:disabled').count()).toBeGreaterThan(0);
      expect(await page.locator(".vp:checked:enabled").count()).toBeLessThan(catalogue);
      await page.locator('.device-toggle[value="tablet"]').check();
      expect(await page.locator(".vp:checked:enabled").count()).toBe(catalogue);

      await page.locator("#fileTab").click();
      await page.locator("#file").setInputFiles({ name: "browser-journey.html", mimeType: "text/html", buffer: Buffer.from('<!doctype html><title>Browser journey</title><main><h1>Ready to review</h1><div id="clipped" style="height:28px;overflow:hidden;border:1px solid #999;width:200px">This block contains several lines of text that the fixed height cuts off before the end of the paragraph is reached.</div></main>') });
      await chooseSizes(page, ["390x844", "1366x768"]);
      await page.locator("#scan").click();
      await page.locator("article.capture").first().waitFor({ timeout: 20_000 });
      expect(await page.locator("article.capture").count()).toBe(2);
      expect(await page.locator("#desktopFilters input[data-facet]").count()).toBeGreaterThan(0);
      await page.locator("article.capture img").first().waitFor();
      expect(await page.locator("article.capture img").first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const clippedRow = page.locator("article.capture .issue-row", { hasText: "Text is clipped" }).first();
      await clippedRow.locator(".issue-open").click();
      await page.locator("#drawer[open] #issueNote").waitFor();
      await page.locator("#issueNote").fill("Keep the paragraph readable at phone width.");
      await page.locator("#addToExport").click();
      await page.locator("#progress").filter({ hasText: "1 in export" }).waitFor();
      const reportDir = join(first.root, "reports", readdirSync(join(first.root, "reports")).find((entry) => !entry.startsWith("."))!);
      const review = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(reportDir, "review-state.json"), "utf8"))) as { issues: Record<string, { status: string; note?: string }> };
      expect(Object.values(review.issues).filter((issue) => issue.status === "export")).toHaveLength(1);
      expect(Object.values(review.issues)[0]!.note).toBe("Keep the paragraph readable at phone width.");

      await page.locator("#issueNote").fill("An unsaved edit.");
      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toContain("unsaved note will be lost");
        await dialog.accept();
      });
      await page.locator("#drawer").getByRole("button", { name: "Start New Review" }).click();
      await page.locator("h1", { hasText: "Start a visual review" }).waitFor();
      expect(await page.locator("#status").textContent()).toContain("Current review saved locally. Ready to start a new review.");
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("url");
      await page.locator("#recent button").first().click();
      await page.locator("article.capture").first().waitFor({ timeout: 10_000 });
      await page.locator("#progress").filter({ hasText: "1 in export" }).waitFor();

      await page.locator("article.capture .issue-row", { hasText: "Text is clipped" }).first().locator(".issue-open").click();
      await page.locator("#drawer[open] #issueNote").waitFor();
      expect(await page.locator("#issueNote").inputValue()).toBe("Keep the paragraph readable at phone width.");
      expect(await page.locator("#addToExport").textContent()).toBe("Remove from export");
      await page.locator("#drawer").getByRole("button", { name: "Return Home" }).click();
      await page.locator("h1", { hasText: "Start a visual review" }).waitFor();
      expect(await page.locator("#status").textContent()).toContain("Current review saved locally. Recent reports are ready.");
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("recentTitle");
      await page.locator("#recent button").first().click();
      await page.locator("article.capture").first().waitFor({ timeout: 10_000 });
      await page.locator("#progress").filter({ hasText: "1 in export" }).waitFor();

      await page.evaluate(async () => {
        const authorizedFetch = (window as unknown as { vqaAuthorizedFetch: typeof fetch }).vqaAuthorizedFetch;
        await authorizedFetch("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      });
      await new Promise((done) => setTimeout(done, 100));

      const reopened = await launchStudio({ stateRoot: join(first.root, "state"), reportsRoot: join(first.root, "reports"), cacheRoot: join(first.root, "cache"), browserManager: readyBrowserManager(first.root), idleTimeoutMs: 0 });
      servers.push(reopened.server);
      await page.goto(reopened.url);
      await page.locator("#recent button").waitFor();
      await page.locator("#recent button").first().click();
      await page.locator("article.capture").first().waitFor({ timeout: 10_000 });
      await page.locator("#progress").filter({ hasText: "1 in export" }).waitFor();
      expect(await page.locator("article.capture").count()).toBe(2);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 40_000);
});
