import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTargetPolicy, denyDownloads, installRedirectGuard, isPrivateNetworkAddress } from "../src/target-policy.js";
import type { TargetPolicy } from "../src/target-policy.js";
import { scan } from "../src/scan.js";

const servers: Server[] = [];

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))));
});

describe("restricted scan target policy", () => {
  async function redirectGuardHarness(
    sendOverride: (method: string) => Promise<unknown> = async () => ({}),
    releaseTimeoutMs = 500,
  ) {
    let onPaused: ((event: {
      requestId: string;
      request: { url: string };
      responseStatusCode: number;
      responseHeaders: Array<{ name: string; value: string }>;
    }) => void) | undefined;
    const calls: string[] = [];
    const session = {
      send: vi.fn(async (method: string) => {
        calls.push(method);
        return sendOverride(method);
      }),
      on: vi.fn((name: string, listener: typeof onPaused) => {
        if (name === "Fetch.requestPaused") onPaused = listener;
      }),
      off: vi.fn(() => {}),
      detach: vi.fn(async () => { calls.push("detach"); }),
    };
    const page = {
      context: () => ({ newCDPSession: async () => session }),
    } as unknown as Page;
    const policy = {
      assertUrl: vi.fn(async () => {}),
      recordViolation: vi.fn(),
    } as unknown as TargetPolicy;
    const release = await installRedirectGuard(page, policy, { releaseTimeoutMs });
    return {
      calls,
      policy,
      release,
      emit: (responseHeaders: Array<{ name: string; value: string }> = []) => onPaused?.({
        requestId: "request-1",
        request: { url: "https://example.test/download" },
        responseStatusCode: 200,
        responseHeaders,
      }),
    };
  }

  it("drains the redirect guard and its failure fallback before detaching", async () => {
    let rejectContinuation!: (error: Error) => void;
    let finishFallback!: () => void;
    const continuation = new Promise<never>((_resolvePromise, rejectPromise) => { rejectContinuation = rejectPromise; });
    const fallback = new Promise<void>((resolvePromise) => { finishFallback = resolvePromise; });
    const harness = await redirectGuardHarness(async (method) => {
      if (method === "Fetch.continueResponse") return continuation;
      if (method === "Fetch.failRequest") return fallback;
      return {};
    });
    harness.emit();
    const releasing = harness.release();
    rejectContinuation(new Error("unexpected transport fault"));
    await expect.poll(() => harness.calls).toContain("Fetch.failRequest");
    expect(harness.calls).not.toContain("Fetch.disable");
    finishFallback();
    await releasing;
    expect(harness.policy.recordViolation).toHaveBeenCalledWith(
      "redirect guard failed closed: unexpected transport fault",
    );
    expect(harness.calls.at(-1)).toBe("detach");
  });

  it("records a pre-release handler failure even when its rejection microtask runs during release", async () => {
    const harness = await redirectGuardHarness(async (method) => {
      if (method === "Fetch.continueResponse") throw new Error("Session closed");
      return {};
    });
    harness.emit();
    await harness.release();
    expect(harness.calls).toContain("Fetch.failRequest");
    expect(harness.policy.recordViolation).toHaveBeenCalledWith(
      "redirect guard failed closed: Session closed",
    );
  });

  it("drains a normal HTTP error response before disabling interception", async () => {
    let finishContinuation!: () => void;
    const continuation = new Promise<void>((resolvePromise) => { finishContinuation = resolvePromise; });
    const harness = await redirectGuardHarness(async (method) =>
      method === "Fetch.continueResponse" ? continuation : {});
    harness.emit();
    const releasing = harness.release();
    await Promise.resolve();
    expect(harness.calls).not.toContain("Fetch.disable");
    finishContinuation();
    await releasing;
    expect(harness.calls).toEqual(["Fetch.enable", "Fetch.continueResponse", "Fetch.disable", "detach"]);
    expect(harness.policy.recordViolation).not.toHaveBeenCalled();
  });

  it("blocks a contacted attachment at the response boundary before publication can race", async () => {
    const harness = await redirectGuardHarness();
    harness.emit([{ name: "Content-Disposition", value: 'attachment; filename="payload.bin"' }]);
    await harness.release();
    expect(harness.calls).toContain("Fetch.failRequest");
    expect(harness.calls).not.toContain("Fetch.continueResponse");
    expect(harness.policy.recordViolation).toHaveBeenCalledWith(
      "download response blocked by restricted target policy: https://example.test/download",
    );
  });

  it("suppresses recognized closed-session errors only in teardown commands", async () => {
    const harness = await redirectGuardHarness(async (method) => {
      if (method === "Fetch.disable") throw new Error("Session closed");
      return {};
    });
    await harness.release();
    expect(harness.policy.recordViolation).not.toHaveBeenCalled();
    expect(harness.calls.at(-1)).toBe("detach");
  });

  it("bounds a stalled redirect drain and continues cleanup fail closed", async () => {
    const stalled = new Promise<never>(() => {});
    const harness = await redirectGuardHarness(async (method) =>
      method === "Fetch.continueResponse" ? stalled : {}, 20);
    harness.emit();
    const started = Date.now();
    await harness.release();
    expect(Date.now() - started).toBeLessThan(500);
    expect(harness.calls.at(-1)).toBe("detach");
    expect(harness.policy.recordViolation).toHaveBeenCalledWith(
      "redirect guard drain failed closed: redirect guard drain timed out after 20ms",
    );
  });

  it("admits loopback, local files, and the named public target origin without a flag", async () => {
    await expect(createTargetPolicy({ targetUrl: "http://127.0.0.1:43210/" })).resolves.toBeDefined();
    await expect(createTargetPolicy({ targetUrl: new URL("../../../fixtures/realworld.html", import.meta.url).href })).resolves.toBeDefined();
    const named = await createTargetPolicy({ targetUrl: "https://8.8.8.8/" });
    expect([...named.allowedOrigins]).toEqual(["https://8.8.8.8"]);
    await expect(createTargetPolicy({ targetUrl: "https://8.8.8.8/", allowedOrigins: ["https://8.8.8.8"] })).resolves.toBeDefined();
    await expect(createTargetPolicy({ targetUrl: "https://8.8.8.8/", allowedOrigins: ["https://8.8.8.8", "http://127.0.0.1:9000"] })).rejects.toThrow(/cannot admit a loopback\/private origin/u);
    await expect(createTargetPolicy({ targetUrl: "https://8.8.8.8/", allowedOrigins: ["https://8.8.8.8/path"] })).rejects.toThrow(/exact HTTP\(S\) origin/u);
    for (const address of [
      "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.31.255.255",
      "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
      "::", "::1", "64:ff9b::1", "64:ff9b:1::1", "100::1", "100:0:0:1::1",
      "2001::1", "2001:1::1", "2001:1::2", "2001:1::3", "2001:2::1", "2001:3::1", "2001:4:112::1",
      "2001:10::1", "2001:20::1", "2001:30::1", "2001:db8::1", "2002::1", "2620:4f:8000::1",
      "3fff::1", "5f00::1", "fc00::1", "fe80::1", "ff00::1",
      "::192.168.1.1", "::ffff:0:8.8.8.8", "::ffff:0:192.168.1.1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "::ffff:172.16.0.1", "::ffff:192.168.1.1", "::ffff:169.254.1.1", "::ffff:100.127.255.255", "::ffff:0.1.2.3",
    ]) {
      expect(isPrivateNetworkAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isPrivateNetworkAddress(address), address).toBe(false);
    }
    for (const address of ["64:ff9b:1::1", "100:0:0:1::1", "2001:2::1", "2001:db8::1", "3fff::1", "5f00::1", "::ffff:0:8.8.8.8", "::ffff:0:192.168.1.1", "::ffff:192.168.1.1"]) {
      const target = `http://[${address}]/`;
      await expect(createTargetPolicy({ targetUrl: target, allowedOrigins: [new URL(target).origin] }), address)
        .rejects.toThrow(/private or reserved/u);
    }
  });

  it("blocks cross-origin redirects and subresources unless each origin is explicitly admitted", async () => {
    const outsideRequests: string[] = [];
    const outside = await listen((request, response) => { outsideRequests.push(request.url ?? ""); response.end("outside"); });
    const outsideServer = servers[0]!;
    let outsideUpgrades = 0;
    outsideServer.on("upgrade", (_request, socket) => { outsideUpgrades += 1; socket.destroy(); });
    const source = await listen((request, response) => {
      if (request.url === "/redirect") { response.writeHead(302, { location: `${outside}/landing` }); response.end(); return; }
      if (request.url === "/safe") { response.setHeader("content-type", "text/html"); response.end("<p>safe</p>"); return; }
      response.setHeader("content-type", "text/html");
      response.end(`<img src="${outside}/pixel.png"><p>source</p>`);
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const blockedContext = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const blockedPolicy = await createTargetPolicy({ targetUrl: `${source}/` });
      await blockedPolicy.install(blockedContext);
      await (await blockedContext.newPage()).goto(`${source}/`);
      const blockedPage = blockedContext.pages()[0]!;
      await blockedPage.evaluate((socketUrl) => { const socket = new WebSocket(socketUrl);socket.addEventListener("error",()=>{}); }, outside.replace(/^http/u, "ws"));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(outsideRequests).toEqual([]);
      expect(outsideUpgrades).toBe(0);
      expect(() => blockedPolicy.assertNoViolations()).toThrow(/outside the explicit origin allowlist/u);
      await blockedContext.close();

      const allowedContext = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      await (await createTargetPolicy({ targetUrl: `${source}/`, allowedOrigins: [outside] })).install(allowedContext);
      await (await allowedContext.newPage()).goto(`${source}/`);
      await expect.poll(() => outsideRequests).toEqual(["/pixel.png"]);
      await allowedContext.close();

      const redirectContext = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const redirectPolicy = await createTargetPolicy({ targetUrl: `${source}/redirect` });
      await redirectPolicy.install(redirectContext);
      const redirectPage = await redirectContext.newPage();
      await installRedirectGuard(redirectPage, redirectPolicy);
      await expect(redirectPage.goto(`${source}/redirect`)).rejects.toThrow();
      expect(outsideRequests).not.toContain("/landing");
      expect(() => redirectPolicy.assertNoViolations()).toThrow(/outside the explicit origin allowlist/u);
      await redirectContext.close();

      const allowedRedirectContext = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const allowedRedirectPolicy = await createTargetPolicy({ targetUrl: `${source}/redirect`, allowedOrigins: [outside] });
      await allowedRedirectPolicy.install(allowedRedirectContext);
      const allowedRedirectPage = await allowedRedirectContext.newPage();
      await installRedirectGuard(allowedRedirectPage, allowedRedirectPolicy);
      await allowedRedirectPage.goto(`${source}/redirect`);
      expect(outsideRequests).toContain("/landing");
      expect(() => allowedRedirectPolicy.assertNoViolations()).not.toThrow();
      await allowedRedirectContext.close();

      const laterContext = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const laterPolicy = redirectPolicy.fork();
      await laterPolicy.install(laterContext);
      const laterPage = await laterContext.newPage();
      await installRedirectGuard(laterPage, laterPolicy);
      await laterPage.goto(`${source}/safe`);
      expect(await laterPage.textContent("body")).toContain("safe");
      expect(() => laterPolicy.assertNoViolations()).not.toThrow();
      await laterContext.close();
    } finally { await browser.close(); }
  });

  it("aborts transactional publication when a subresource redirect is forbidden", async () => {
    const outsideRequests: string[] = [];
    const outside = await listen((request, response) => { outsideRequests.push(request.url ?? ""); response.end("pixel"); });
    const source = await listen((request, response) => {
      if (request.url === "/asset") { response.writeHead(302, { location: `${outside}/pixel.png` }); response.end(); return; }
      response.setHeader("content-type", "text/html");
      response.end('<main>source<img src="/asset"></main>');
    });
    const parent = mkdtempSync(join(tmpdir(), "vqa-redirect-policy-scan-"));
    const outDir = join(parent, "report");
    try {
      await expect(scan({
        url: `${source}/`, outDir,
        viewports: [{ width: 320, height: 240, deviceScaleFactor: 1, label: "320x240@1" }],
      })).rejects.toThrow(/restricted target policy blocked the scan.*redirect/iu);
      expect(outsideRequests).toEqual([]);
      expect(existsSync(outDir)).toBe(false);
      expect(existsSync(join(outDir, "issues.json"))).toBe(false);
      expect(existsSync(join(outDir, "review-manifest.json"))).toBe(false);
      expect(existsSync(join(outDir, "screenshots"))).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 30_000);

  it("isolates fail-closed violation ledgers between crawl capture contexts", async () => {
    const policy = await createTargetPolicy({ targetUrl: "http://127.0.0.1:43210/" });
    const blockedCapture = policy.fork();
    blockedCapture.recordViolation("first crawl page blocked");
    expect(() => blockedCapture.assertNoViolations()).toThrow(/first crawl page blocked/u);
    const nextCapture = policy.fork();
    expect(() => nextCapture.assertNoViolations()).not.toThrow();
    expect(nextCapture.allowedOrigins).toBe(policy.allowedOrigins);
    expect(nextCapture.chromiumArgs).toEqual(policy.chromiumArgs);
  });

  it("refuses automatic downloads and pins admitted hostname resolution before launch", async () => {
    const source = await listen((request, response) => {
      if (request.url === "/download") response.writeHead(200, { "content-disposition": "attachment; filename=payload.bin", "content-type": "application/octet-stream" });
      response.end("payload");
    });
    const localhostUrl = source.replace("127.0.0.1", "localhost");
    const policy = await createTargetPolicy({ targetUrl: `${localhostUrl}/download` });
    expect(policy.chromiumArgs.join(" ")).toContain("--host-resolver-rules=MAP localhost");
    const browser = await chromium.launch({ headless: true, args: [...policy.chromiumArgs] });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    await policy.install(context);
    const page = await context.newPage();
    denyDownloads(page, policy);
    let downloads = 0;
    page.on("download", () => { downloads += 1; });
    try {
      void page.goto(`${localhostUrl}/download`).catch(() => {});
      await expect.poll(() => downloads).toBe(1);
      expect(() => policy.assertNoViolations()).toThrow(/download blocked/u);
    } finally { await browser.close(); }
  }, 30_000);

  it.each(["immediate", "delayed"])("handles a platform-suppressed or emitted %s scripted download safely", async (mode) => {
    let downloadContacts = 0;
    const source = await listen((request, response) => {
      if (request.url === "/download") {
        downloadContacts += 1;
        response.writeHead(200, { "content-disposition": "attachment; filename=payload.bin", "content-type": "application/octet-stream" });
        response.end("payload");
        return;
      }
      response.setHeader("content-type", "text/html");
      const action = 'document.getElementById("download").click()';
      response.end(`<a id="download" download href="/download">download</a><script>${mode === "delayed" ? `setTimeout(()=>{${action}},75)` : action}</script>`);
    });
    const parent = mkdtempSync(join(tmpdir(), `vqa-scripted-download-${mode}-`));
    const outDir = join(parent, "report");
    try {
      const outcome = await scan({
        url: `${source}/`, outDir,
        viewports: [{ width: 320, height: 240, deviceScaleFactor: 1, label: "320x240@1" }],
      }).then(
        (report) => ({ report, error: undefined }),
        (error: unknown) => ({ report: undefined, error }),
      );
      if (downloadContacts === 0) {
        // Chromium may suppress a script-created download without user
        // activation. In that case no payload was requested and publishing the
        // otherwise safe page is truthful.
        expect(outcome.error).toBeUndefined();
        expect(outcome.report).toBeDefined();
        expect(existsSync(outDir)).toBe(true);
      } else {
        // Once the browser contacts the attachment endpoint, a missed download
        // violation must never result in a published report.
        expect(outcome.report).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(Error);
        expect(String(outcome.error)).toMatch(/download|navigation|page|net::ERR_ABORTED/iu);
        expect(existsSync(outDir)).toBe(false);
      }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 30_000);

  it.each(["immediate", "delayed"])("aborts transactional publication for %s download navigations", async (mode) => {
    const source = await listen((request, response) => {
      if (request.url === "/download") {
        response.writeHead(200, { "content-disposition": "attachment; filename=payload.bin", "content-type": "application/octet-stream" });
        response.end("payload");
        return;
      }
      response.setHeader("content-type", "text/html");
      const action = 'location.href="/download"';
      response.end(`<a id="download" download href="/download">download</a><script>${mode === "delayed" ? `setTimeout(()=>{${action}},75)` : action}</script>`);
    });
    const parent = mkdtempSync(join(tmpdir(), `vqa-download-${mode}-`));
    const outDir = join(parent, "report");
    try {
      await expect(scan({
        url: `${source}/`, outDir,
        viewports: [{ width: 320, height: 240, deviceScaleFactor: 1, label: "320x240@1" }],
      })).rejects.toThrow(/download|navigation|page|net::ERR_ABORTED/iu);
      expect(existsSync(outDir)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 30_000);

  it.each(["download", "redirect"])(
    "blocks a same-origin popup before it contacts the %s endpoint or publishes a report",
    async (mode) => {
      let forbiddenContacts = 0;
      let redirectDestinationContacts = 0;
      const redirectDestination = await listen((_request, response) => {
        redirectDestinationContacts += 1;
        response.end("outside");
      });
      const source = await listen((request, response) => {
        if (request.url === `/${mode}`) {
          forbiddenContacts += 1;
          if (mode === "redirect") {
            response.writeHead(302, { location: `${redirectDestination}/landing` });
            response.end();
          } else {
            response.writeHead(200, {
              "content-disposition": "attachment; filename=payload.bin",
              "content-type": "application/octet-stream",
            });
            response.end("payload");
          }
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end(mode === "redirect"
          ? '<base target="_blank"><main>trusted page</main><a id="popup" href="/redirect">open</a><script>document.getElementById("popup").click()</script>'
          : '<main>trusted page</main><script>window.open("/download", "_blank")</script>');
      });
      const parent = mkdtempSync(join(tmpdir(), `vqa-popup-${mode}-`));
      const outDir = join(parent, "report");
      try {
        await expect(scan({
          url: `${source}/`,
          outDir,
          viewports: [{ width: 320, height: 240, deviceScaleFactor: 1, label: "320x240@1" }],
        })).rejects.toThrow(/child page blocked|child page request blocked/iu);
        expect(forbiddenContacts).toBe(0);
        expect(redirectDestinationContacts).toBe(0);
        expect(existsSync(outDir)).toBe(false);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("fails the whole transactional scan when a subresource origin is not admitted", async () => {
    const outside = await listen((_request, response) => response.end("pixel"));
    const source = await listen((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<main>trusted page<img src="${outside}/blocked.png"></main>`);
    });
    const parent = mkdtempSync(join(tmpdir(), "vqa-target-policy-scan-"));
    const outDir = join(parent, "report");
    try {
      await expect(scan({
        url: `${source}/`, outDir,
        viewports: [{ width: 320, height: 240, deviceScaleFactor: 1, label: "320x240@1" }],
      })).rejects.toThrow(/restricted target policy blocked the scan/u);
      expect(existsSync(outDir)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 30_000);
});
