import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_VERSION, type Report } from "@vqa/contract";
import { markRunAsBaseline } from "../src/index.js";
import { serveReport } from "../../cli/src/serve.js";

const roots: string[] = [];
let browser: Browser;

function makeReport(): string {
  const root = mkdtempSync(join(tmpdir(), "vqa-secure-serve-"));
  roots.push(root);
  cpSync(new URL("../../engine/test/fixtures/review-journey/", import.meta.url), root, { recursive: true });
  const report: Report = {
    formatVersion: "2",
    tool: "viewport-qa",
    toolVersion: PRODUCT_VERSION,
    schemaVersions: { report: "2", manifest: 1, reviewState: 2 },
    url: "http://127.0.0.1/fixture",
    createdAt: "2026-08-23T00:00:00.000Z",
    adapter: { impl: "stub", wired: false },
    viewports: [],
    issues: [],
  };
  writeFileSync(join(root, "issues.json"), `${JSON.stringify(report)}\n`);
  return root;
}

function launchParts(url: string): { origin: string; capability: string } {
  const parsed = new URL(url);
  return { origin: parsed.origin, capability: new URLSearchParams(parsed.hash.slice(1)).get("cap")! };
}

function authenticated(parts: ReturnType<typeof launchParts>, method = "GET"): Headers {
  const headers = new Headers({ authorization: `VQA ${parts.capability}` });
  if (!["GET", "HEAD"].includes(method)) {
    headers.set("origin", parts.origin);
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections();
  });
}

async function rawHostProbe(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const target = new URL(url);
    const request = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", rejectPromise);
    request.end(body);
  });
}

beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
afterAll(async () => {
  await browser?.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("secure loopback launch session", () => {
  it("boots the real GUI, removes the fragment, loads private Blob images, and enforces CSP", async () => {
    const root = makeReport();
    const { server, url } = await serveReport({ reportDir: root, port: 0 });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    try {
      await page.goto(url);
      await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
      expect(page.url()).toBe(`${new URL(url).origin}/`);
      expect(await page.evaluate(() => history.state)).toBeNull();
      await expect.poll(() => page.locator(".capture img").first().getAttribute("src")).toMatch(/^blob:/u);
      expect(errors).toEqual([]);
    } finally { await page.close(); await close(server); }
  });

  it("rejects public-origin fetch/form shapes, text/plain JSON, null Origin, and Host rebinding", async () => {
    const root = makeReport();
    const reviewPath = join(root, "review-state.json");
    const { server, url } = await serveReport({ reportDir: root, port: 0 });
    const parts = launchParts(url);
    const endpoint = `${parts.origin}/api/review`;
    const body = JSON.stringify({ issueId: "VQ-ISSUE-HOME-LOW-CONTRAST-CTA", status: "export" });
    try {
      const probes = [
        await fetch(endpoint, { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json", authorization: `VQA ${parts.capability}` }, body }),
        await fetch(endpoint, { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" }, body: `payload=${encodeURIComponent(body)}` }),
        await fetch(endpoint, { method: "POST", headers: { origin: "https://attacker.example", "content-type": "text/plain" }, body }),
        await fetch(endpoint, { method: "POST", headers: { origin: "null", "content-type": "application/json", authorization: `VQA ${parts.capability}` }, body }),
        await fetch(endpoint, { method: "POST", headers: { origin: parts.origin, "content-type": "text/plain", authorization: `VQA ${parts.capability}` }, body }),
        { status: await rawHostProbe(endpoint, { host: "attacker.example", origin: parts.origin, "content-type": "application/json", authorization: `VQA ${parts.capability}` }, body) } as Response,
      ];
      expect(probes.map((response) => response.status)).toEqual([403, 401, 401, 403, 415, 421]);
      expect(() => readFileSync(reviewPath)).toThrow();
    } finally { await close(server); }
  });

  it("rejects guessed, stale, unauthenticated, and cross-instance capabilities for GET, HEAD, and writes", async () => {
    const firstRoot = makeReport();
    const secondRoot = makeReport();
    const replacementRoot = makeReport();
    const first = await serveReport({ reportDir: firstRoot, port: 0 });
    const second = await serveReport({ reportDir: secondRoot, port: 0 });
    let replacement: Awaited<ReturnType<typeof serveReport>> | undefined;
    const one = launchParts(first.url);
    const two = launchParts(second.url);
    try {
      for (const method of ["GET", "HEAD"] as const) {
        expect((await fetch(`${one.origin}/app`, { method })).status).toBe(401);
        expect((await fetch(`${one.origin}/page-home--state-default--390x844.png`, { method })).status).toBe(401);
        expect((await fetch(`${one.origin}/api/review`, { method, headers: { authorization: `VQA ${two.capability}` } })).status).toBe(401);
      }
      expect((await fetch(`${one.origin}/api/review`, { headers: { authorization: "VQA guessed" } })).status).toBe(401);
      const crossWrite = await fetch(`${one.origin}/api/review`, {
        method: "POST",
        headers: { authorization: `VQA ${two.capability}`, origin: one.origin, "content-type": "application/json" },
        body: "{}",
      });
      expect(crossWrite.status).toBe(401);
      await close(first.server);
      replacement = await serveReport({ reportDir: replacementRoot, port: Number(new URL(one.origin).port) });
      expect((await fetch(`${one.origin}/app`, { headers: authenticated(one) })).status).toBe(401);
    } finally {
      if (first.server.listening) await close(first.server);
      if (replacement?.server.listening) await close(replacement.server);
      await close(second.server);
    }
  });

  it("does not send credentials to a hostile loopback listener and replay cannot authorize", async () => {
    const observed: Array<Record<string, string | string[] | undefined>> = [];
    const hostile = createHttpServer((request, response) => { observed.push(request.headers); response.end("ok"); });
    await new Promise<void>((resolvePromise) => hostile.listen(0, "127.0.0.1", resolvePromise));
    const hostileAddress = hostile.address();
    const hostileOrigin = `http://127.0.0.1:${typeof hostileAddress === "object" && hostileAddress ? hostileAddress.port : 0}`;
    const root = makeReport();
    const { server, url } = await serveReport({ reportDir: root, port: 0 });
    const parts = launchParts(url);
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
      expect(await page.evaluate(async (target) => {
        try { await window.vqaAuthorizedFetch(target); return "leaked"; } catch { return "blocked"; }
      }, hostileOrigin)).toBe("blocked");
      await page.evaluate((target) => { void fetch(target).catch(() => {}); }, hostileOrigin);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(observed.every((headers) => !headers.authorization && !headers.cookie && !headers.referer)).toBe(true);
      expect((await fetch(`${parts.origin}/app`, { headers: { authorization: "VQA replay" } })).status).toBe(401);
    } finally { await page.close(); await close(server); await close(hostile); }
  });

  it("keeps capabilities out of report files, service logs, history, and referrers", async () => {
    const root = makeReport();
    const logs: string[] = [];
    const { server, url } = await serveReport({ reportDir: root, port: 0, log: (line) => logs.push(line) });
    const { capability } = launchParts(url);
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
      expect(page.url()).not.toContain(capability);
      expect(logs.join("\n")).not.toContain(capability);
      for (const name of readdirSync(root)) {
        const path = join(root, name);
        if (["issues.json", "review-manifest.json", "review-state.json", "report.html"].includes(name)) {
          expect(readFileSync(path, "utf8")).not.toContain(capability);
        }
      }
      expect(await page.evaluate(() => document.referrer)).toBe("");
    } finally { await page.close(); await close(server); }
  });

  it("confines the manifest asset allowlist, refuses symlinks/traversal, bounds bodies, and gates methods", async () => {
    const root = makeReport();
    writeFileSync(join(root, "private-settings.json"), "secret");
    symlinkSync("/etc/passwd", join(root, "page-home--state-default--390x844-link.png"));
    const { server, url } = await serveReport({ reportDir: root, port: 0 });
    const parts = launchParts(url);
    try {
      for (const path of ["issues.json", "review-manifest.json", "review-state.json", "private-settings.json", "../etc/passwd", "page-home--state-default--390x844-link.png"]) {
        expect((await fetch(new URL(path, `${parts.origin}/`), { headers: authenticated(parts) })).status).toBe(404);
      }
      const oversized = await fetch(`${parts.origin}/api/review`, {
        method: "POST", headers: authenticated(parts, "POST"), body: `{"padding":"${"x".repeat(1_000_100)}"}`,
      });
      expect(oversized.status).toBe(413);
      const wrongMethod = await fetch(`${parts.origin}/api/review`, { method: "PUT", headers: authenticated(parts, "PUT"), body: "{}" });
      expect(wrongMethod.status).toBe(405);
      const head = await fetch(`${parts.origin}/app`, { method: "HEAD", headers: authenticated(parts, "HEAD") });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    } finally { await close(server); }
  });

  it("refuses symlinked internal state before starting a service", async () => {
    const root = makeReport();
    const outside = join(root, "..", `${basename(root)}-outside-settings.json`);
    writeFileSync(outside, JSON.stringify({ default_handoff_path: "/tmp/stolen.json" }));
    symlinkSync(outside, join(root, "review-settings.json"));
    try { await expect(serveReport({ reportDir: root, port: 0 })).rejects.toThrow(/unsafe report file/u); }
    finally { rmSync(outside, { force: true }); }
  });

  it("allows only one report writer, supports explicit read-only inspection, and releases the lock", async () => {
    const root = makeReport();
    const first = await serveReport({ reportDir: root, port: 0 });
    try {
      await expect(serveReport({ reportDir: root, port: 0 })).rejects.toThrow(/already open for writing/u);
      await expect(markRunAsBaseline(root)).rejects.toThrow(/another report writer/u);
      const readOnly = await serveReport({ reportDir: root, port: 0, readOnly: true });
      const parts = launchParts(readOnly.url);
      try {
        const response = await fetch(`${parts.origin}/api/review`, { method: "POST", headers: authenticated(parts, "POST"), body: "{}" });
        expect(response.status).toBe(409);
      } finally { await close(readOnly.server); }
    } finally { await close(first.server); }
    const lockPath = join(root, "..", `.${basename(root)}.vqa-transaction.lock`);
    await expect.poll(() => existsSync(lockPath)).toBe(false);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner-stale.json"), JSON.stringify({ pid: 2_147_483_647, lock_id: "stale" }));
    const logs: string[] = [];
    const reopened = await serveReport({ reportDir: root, port: 0, log: (line) => logs.push(line) });
    expect(logs.join("\n")).toContain("recovered stale review lock");
    await close(reopened.server);
  });

  it("fences the stale-lock ABA race across review and baseline writers", async () => {
    const root = makeReport();
    const lockPath = join(root, "..", `.${basename(root)}.vqa-transaction.lock`);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner-stale.json"), JSON.stringify({ pid: 2_147_483_647, lock_id: "stale" }));
    let observed!: () => void;
    let resume!: () => void;
    const staleObserved = new Promise<void>((resolvePromise) => { observed = resolvePromise; });
    const recoveryMayContinue = new Promise<void>((resolvePromise) => { resume = resolvePromise; });
    const recoveringReview = serveReport({
      reportDir: root,
      port: 0,
      lockHooks: { afterStaleOwnerObserved: async () => { observed(); await recoveryMayContinue; } },
    });
    await staleObserved;
    const competingReview = await serveReport({ reportDir: root, port: 0 });
    await expect(markRunAsBaseline(root)).rejects.toThrow(/another report writer/u);
    resume();
    // Some filesystems immediately reuse the removed directory inode. In that
    // case the late recoverer safely loses on the replacement's live owner
    // instead of observing a different generation number.
    await expect(recoveringReview).rejects.toThrow(/lock generation changed|already open for writing/u);
    await close(competingReview.server);
    const nextReview = await serveReport({ reportDir: root, port: 0 });
    await close(nextReview.server);
  });

  it("never mutates or bypasses a day-old dead legacy recovery artifact", async () => {
    const root = makeReport();
    const lockPath = join(root, "..", `.${basename(root)}.vqa-transaction.lock`);
    const recoveryPath = `${lockPath}.recovery`;
    writeFileSync(recoveryPath, JSON.stringify({ pid: 2_147_483_647, lock_id: "orphaned-recovery" }));
    const dayOld = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(recoveryPath, dayOld, dayOld);
    const original = readFileSync(recoveryPath, "utf8");
    const contenders = await Promise.allSettled([
      serveReport({ reportDir: root, port: 0 }),
      serveReport({ reportDir: root, port: 0 }),
    ]);
    expect(contenders.every((result) => result.status === "rejected")).toBe(true);
    expect(readFileSync(recoveryPath, "utf8")).toBe(original);
    await expect(markRunAsBaseline(root)).rejects.toThrow(/legacy Viewport QA recovery artifact/u);
    rmSync(recoveryPath);
    const nextReview = await serveReport({ reportDir: root, port: 0 });
    await close(nextReview.server);
  });

  it("does not remove an old-version replacement during a legacy lock race", async () => {
    const root = makeReport();
    const lockPath = join(root, "..", `.${basename(root)}.vqa-transaction.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, lock_id: "legacy-old" }));
    let observed!: () => void;
    let resume!: () => void;
    const legacyObserved = new Promise<void>((resolvePromise) => { observed = resolvePromise; });
    const mayRefuse = new Promise<void>((resolvePromise) => { resume = resolvePromise; });
    const contender = serveReport({
      reportDir: root,
      port: 0,
      lockHooks: { afterLegacyArtifactObserved: async () => { observed(); await mayRefuse; } },
    });
    await legacyObserved;
    rmSync(lockPath);
    const replacement = JSON.stringify({ pid: process.pid, lock_id: "legacy-replacement" });
    writeFileSync(lockPath, replacement);
    resume();
    await expect(contender).rejects.toThrow(/manually inspect and remove/u);
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    await expect(markRunAsBaseline(root)).rejects.toThrow(/manually inspect and remove/u);
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    rmSync(lockPath);
    const review = await serveReport({ reportDir: root, port: 0 });
    await close(review.server);
  });

  it("stops from the authenticated UI control", async () => {
    const root = makeReport();
    const { server, url } = await serveReport({ reportDir: root, port: 0 });
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.getByRole("button", { name: "Stop Viewport QA" }).click();
      await expect.poll(() => server.listening).toBe(false);
      await expect.poll(() => page.getByRole("heading", { name: "Viewport QA stopped" }).count()).toBe(1);
    } finally { await page.close(); if (server.listening) await close(server); }
  });

  it("stops after the configured authorized-idle interval", async () => {
    const root = makeReport();
    const { server } = await serveReport({ reportDir: root, port: 0, idleTimeoutMs: 30 });
    await expect.poll(() => server.listening, { timeout: 2_000 }).toBe(false);
  });
});
