import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { assertBuilt, runBin } from "./helpers.js";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind TCP");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) =>
    server.close((error) =>
      error ? rejectPromise(error) : resolvePromise(),
    ),
  );
}

function tempReportDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function findPngs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return findPngs(path);
    return entry.endsWith(".png") ? [path] : [];
  });
}

function readPngWidth(path: string): number {
  const png = readFileSync(path);
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return png.readUInt32BE(16);
}

describe("crawl corrective behavior (local servers, real binary)", () => {
  it("rejects off-origin finals, resolves against final URLs, and scans redirect aliases once", async () => {
    assertBuilt();
    const outsideRequests: string[] = [];
    const outsideServer = createServer((request, response) => {
      outsideRequests.push(request.url ?? "/");
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<div style="width: 1200px">outside overflow</div>' +
          '<a href="/secret-from-evil-page">secret</a>' +
          '<a href="/another-evil-rel">another</a>',
      );
    });
    const outsideOrigin = await listen(outsideServer);

    const sourceRequests: string[] = [];
    const sourceServer = createServer((request, response) => {
      const path = request.url ?? "/";
      sourceRequests.push(path);
      if (path === "/off-hop") {
        response.writeHead(302, { location: `${outsideOrigin}/evil` });
        response.end();
        return;
      }
      if (path === "/base-hop") {
        response.writeHead(302, { location: "/nested/final" });
        response.end();
        return;
      }
      if (path === "/alias-one" || path === "/alias-two") {
        response.writeHead(301, { location: "/canonical" });
        response.end();
        return;
      }

      const content = path === "/"
        ? '<a href="/off-hop">outside</a>' +
          '<a href="/base-hop">base</a>' +
          '<a href="/alias-one">alias one</a>' +
          '<a href="/alias-two">alias two</a>' +
          '<a href="/canonical">canonical</a>'
        : path === "/nested/final"
          ? '<a href="child">relative child</a>'
          : path === "/canonical"
            ? '<div style="width: 900px">canonical overflow</div>'
            : "ok";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><main>${content}</main>`);
    });
    const sourceOrigin = await listen(sourceServer);
    const outDir = tempReportDir("vqa-crawl-corrective-");

    try {
      const result = await runBin(
        [
          "scan",
          `${sourceOrigin}/`,
          "--crawl",
          "--max-pages",
          "10",
          "--max-depth",
          "2",
          "--viewports",
          "320x240",
          "--out",
          outDir,
        ],
        { timeoutMs: 180_000 },
      );
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(
        readFileSync(join(outDir, "issues.json"), "utf8"),
      ) as Report;

      const offOrigin = report.pages?.find((page) => page.url === `${sourceOrigin}/off-hop`);
      expect(offOrigin).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/ERR_FAILED|blocked/iu),
      });
      expect(report.issues.some((issue) => issue.pageUrl?.startsWith(outsideOrigin))).toBe(false);
      expect(outsideRequests).toEqual([]);

      expect(sourceRequests).toContain("/nested/child");
      expect(sourceRequests).not.toContain("/child");
      expect(
        report.pages?.some(
          (page) => page.status === "success" && page.url === `${sourceOrigin}/nested/child`,
        ),
      ).toBe(true);

      const canonicalPages = report.pages?.filter(
        (page) => page.status === "success" && page.url === `${sourceOrigin}/canonical`,
      );
      expect(canonicalPages).toHaveLength(1);
      expect(report.viewports.filter((viewport) => viewport.pageUrl === `${sourceOrigin}/canonical`)).toHaveLength(1);
      expect(sourceRequests.filter((path) => path === "/canonical")).toHaveLength(2);
    } finally {
      await Promise.all([close(sourceServer), close(outsideServer)]);
    }
  }, 180_000);

  it("rejects off-origin client hops around DOM collection and re-keys an on-origin hop", async () => {
    assertBuilt();
    let sourceOrigin = "";
    const outsideRequests: string[] = [];
    const outsideServer = createServer((request, response) => {
      const path = request.url ?? "/";
      outsideRequests.push(path);
      const inventedPath = path === "/meta-evil"
        ? "/pwned-by-meta-refresh"
        : path === "/js-evil"
          ? "/pwned-by-location-href"
          : path === "/capture-evil"
            ? "/pwned-by-capture-hop"
            : "/pwned-by-delayed-hop";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        path === "/capture-evil"
          ? `<!doctype html><style>body{margin:0;background:red}</style><div style="width:1608px;height:1600px;background:red">outside overflow</div><script>location.replace("${sourceOrigin}/capture-landing")</script>`
          : `<!doctype html><style>body{margin:0;background:red}</style><div style="width: 1600px;height:1600px;background:red">outside overflow</div><a href="${inventedPath}">invented</a>`,
      );
    });
    const outsideOrigin = await listen(outsideServer);

    const sourceRequests: string[] = [];
    const sourceServer = createServer((request, response) => {
      const path = request.url ?? "/";
      sourceRequests.push(path);
      const content = path === "/"
        ? '<a href="/meta">meta</a><a href="/js">js</a><a href="/delayed">delayed</a><a href="/spa">spa</a><a href="/capture-bounce">capture bounce</a>'
        : path === "/meta"
          ? `<meta http-equiv="refresh" content="0;url=${outsideOrigin}/meta-evil">`
          : path === "/js"
            ? `<script>addEventListener("load", () => { location.href = "${outsideOrigin}/js-evil"; });</script>`
            : path === "/delayed"
              ? `${Array.from(
                  { length: 3_000 },
                  (_, index) => `<div data-row="${index}">row</div>`,
                ).join("")}<script>setTimeout(() => { location.href = "${outsideOrigin}/delayed-evil"; }, 10);</script>`
              : path === "/spa"
                ? '<script>addEventListener("load", () => { location.href = "/spa-final"; });</script>'
                : path === "/capture-bounce"
                  ? `<script>location.href = "${outsideOrigin}/capture-evil";</script>`
                  : path === "/capture-landing"
                    ? "capture landing"
                  : "source only";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><main>${content}</main>`);
    });
    sourceOrigin = await listen(sourceServer);
    const outDir = tempReportDir("vqa-crawl-client-navigation-");

    try {
      const result = await runBin(
        [
          "scan",
          `${sourceOrigin}/`,
          "--crawl",
          "--max-pages",
          "6",
          "--max-depth",
          "2",
          "--viewports",
          "320x240",
          "--out",
          outDir,
        ],
        { timeoutMs: 180_000 },
      );
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(
        readFileSync(join(outDir, "issues.json"), "utf8"),
      ) as Report;

      for (const path of ["/meta", "/js", "/delayed", "/capture-bounce"]) {
        expect(
          report.pages?.find((page) => page.url === `${sourceOrigin}${path}`),
          path,
        ).toMatchObject({
          status: "failed",
          error: expect.stringMatching(/ERR_FAILED|blocked|Execution context was destroyed/iu),
        });
      }
      expect(
        report.issues.some((issue) => issue.pageUrl?.startsWith(outsideOrigin)),
      ).toBe(false);
      expect(
        report.issues.some((issue) => issue.rect.width === 1600),
      ).toBe(false);
      expect(sourceRequests).not.toContain("/pwned-by-meta-refresh");
      expect(sourceRequests).not.toContain("/pwned-by-location-href");
      expect(sourceRequests).not.toContain("/pwned-by-delayed-hop");
      expect(sourceRequests).not.toContain("/pwned-by-capture-hop");
      expect(outsideRequests).toEqual([]);
      const pngs = findPngs(outDir);
      expect(pngs.length).toBeGreaterThan(0);
      for (const png of pngs) {
        expect(readPngWidth(png), png).toBeLessThanOrEqual(320);
      }
      expect(report.pages?.find((page) => page.url === `${sourceOrigin}/spa-final`)).toMatchObject({
        status: "success",
        viewports: [
          expect.objectContaining({ pageUrl: `${sourceOrigin}/spa-final` }),
        ],
      });
    } finally {
      await Promise.all([close(sourceServer), close(outsideServer)]);
    }
  }, 180_000);

  it("keeps a rendered HTTP 404 scannable without --crawl", async () => {
    assertBuilt();
    const server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><div id="wide-404" style="width: 900px">not found</div>',
      );
    });
    const origin = await listen(server);
    const outDir = tempReportDir("vqa-404-");

    try {
      const result = await runBin([
        "scan",
        `${origin}/missing`,
        "--viewports",
        "320x240",
        "--out",
        outDir,
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(existsSync(join(outDir, "report.html"))).toBe(true);
      const report = JSON.parse(
        readFileSync(join(outDir, "issues.json"), "utf8"),
      ) as Report;
      expect(report.issues.some((issue) => issue.type === "page-overflow")).toBe(true);
    } finally {
      await close(server);
    }
  }, 180_000);

  it.each(["--max-pages", "--max-depth"])(
    "requires --crawl when %s is provided",
    async (flag) => {
      assertBuilt();
      const server = createServer((_request, response) => response.end("ok"));
      const origin = await listen(server);
      const outDir = tempReportDir("vqa-crawl-usage-");
      try {
        const result = await runBin([
          "scan",
          origin,
          flag,
          "1",
          "--out",
          outDir,
        ]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(`${flag} requires --crawl`);
        expect(existsSync(join(outDir, "issues.json"))).toBe(false);
      } finally {
        await close(server);
      }
    },
  );

  it("exits non-zero when the crawl start page is unreachable", async () => {
    assertBuilt();
    const server = createServer();
    const origin = await listen(server);
    await close(server);
    const outDir = tempReportDir("vqa-crawl-unreachable-");

    const result = await runBin([
      "scan",
      origin,
      "--crawl",
      "--timeout",
      "2000",
      "--viewports",
      "320x240",
      "--out",
      outDir,
    ]);

    expect(result.code).not.toBe(0);
    expect(existsSync(join(outDir, "issues.json"))).toBe(false);
    expect(existsSync(join(outDir, "report.html"))).toBe(false);
  }, 30_000);
});
