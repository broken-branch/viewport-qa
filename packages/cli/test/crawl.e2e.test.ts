import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { assertBuilt, runBin } from "./helpers.js";

let server: Server;
let origin: string;
let outDir: string;
let report: Report;
const requests: string[] = [];

beforeAll(async () => {
  assertBuilt();
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    if (path === "/broken") {
      response.writeHead(503, { "content-type": "text/html" });
      response.end("<h1>temporarily unavailable</h1>");
      return;
    }
    if (path === "/plain") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("not html");
      return;
    }
    const links = path === "/"
      ? '<a href="/a#one">A</a><a href="/a#two">duplicate</a><a href="/broken">broken</a><a href="/plain">plain</a><a href="/b">B</a><a href="/asset.pdf">pdf</a><a href="https://example.invalid/offsite">offsite</a>'
      : path === "/a"
        ? '<a href="/too-deep">deep</a>'
        : "";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${path}</title><main>${path}${links}</main>`);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  origin = `http://127.0.0.1:${address.port}`;
  outDir = mkdtempSync(join(tmpdir(), "vqa-crawl-"));

  const result = await runBin(
    [
      "scan",
      `${origin}/`,
      "--crawl",
      "--max-pages",
      "5",
      "--max-depth",
      "1",
      "--viewports",
      "320x240",
      "--out",
      outDir,
    ],
    { timeoutMs: 180_000 },
  );
  expect(result.code, result.stderr).toBe(0);
  report = JSON.parse(readFileSync(join(outDir, "issues.json"), "utf8")) as Report;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("vqa scan bounded crawl (local server, real binary)", () => {
  it("records the breadth-first page breakdown and isolates failures", () => {
    expect(report.pages).toHaveLength(5);
    expect(report.pages?.map((page) => [new URL(page.url).pathname, page.depth, page.status])).toEqual([
      ["/", 0, "success"],
      ["/a", 1, "success"],
      ["/broken", 1, "failed"],
      ["/plain", 1, "failed"],
      ["/b", 1, "success"],
    ]);
    expect(report.pages?.[2]).toMatchObject({ error: expect.stringContaining("HTTP 503") });
    expect(report.pages?.[3]).toMatchObject({ error: expect.stringContaining("Non-HTML") });
    expect(requests).not.toContain("/too-deep");
    expect(requests).not.toContain("/asset.pdf");
  });

  it("keeps aggregate results aligned with successful per-page results", () => {
    const successful = report.pages?.filter((page) => page.status === "success") ?? [];
    expect(report.viewports).toHaveLength(3);
    expect(report.viewports).toEqual(successful.flatMap((page) => page.viewports));
    expect(report.issues).toEqual(successful.flatMap((page) => page.issues));
    for (const viewport of report.viewports) {
      expect(viewport.pageUrl).toBeTruthy();
      expect(existsSync(join(outDir, viewport.screenshot))).toBe(true);
    }
    for (const issue of report.issues) {
      expect(issue.id).toMatch(/^issue-[0-9a-f]{20}$/u);
      expect(issue.pageUrl).toBeTruthy();
    }
    expect(new Set(report.issues.map((issue) => issue.id)).size).toBe(report.issues.length);
  });
});
