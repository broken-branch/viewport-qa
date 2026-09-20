import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { AgentSummary, Issue, Report } from "@vqa/contract";
import type { ModelAdapter } from "@vqa/model-adapter";
import { renderReportHtml } from "../src/report-html.js";
import { scan } from "../src/scan.js";

const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
    ),
  );
});

async function fixtureServer(): Promise<string> {
  const html = await readFile(join(process.cwd(), "fixtures/behaviour.html"));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (path === "/expected-503") {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("secret response body");
      return;
    }
    if (path === "/delayed-503") {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("secret delayed response body");
      return;
    }
    if (path === "/frame-storage.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><script>
        localStorage.setItem("vqa.fixture.frame", "secret-frame-value");
        localStorage.removeItem("vqa.fixture.frame");
      </script>`);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("secret missing body");
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

type BehaviourDetails =
  | { kind: "console-message"; level: "error" | "warning"; text: string; sourceUrl: string; line: number }
  | { kind: "failed-request"; method: string; url: string; status?: number; failureReason?: string }
  | {
      kind: "storage-change";
      storage: "cookie";
      name: string;
      attributes: {
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: "Strict" | "Lax" | "None";
        partitionKey?: string;
      };
    }
  | { kind: "storage-change"; storage: "localStorage" | "sessionStorage"; key: string };

function behaviour(issue: Issue): BehaviourDetails | undefined {
  return (issue as Issue & { behaviour?: BehaviourDetails }).behaviour;
}
describe("scan behaviour capture", () => {
  it("publishes exact console, failed-request, and value-free storage findings", async () => {
    const origin = await fixtureServer();
    const root = await mkdtemp(join(tmpdir(), "vqa-behaviour-"));
    temporaryRoots.push(root);
    const outDir = join(root, "report");
    let modelCalls = 0;
    const adapter: ModelAdapter = {
      describe: () => ({ impl: "test-wired", wired: true, contractVersion: "1" }),
      complete: async () => {
        modelCalls += 1;
        return { text: "model output must not be used", model: "test-model" };
      },
    };
    const report = await scan({
      url: `${origin}/`,
      outDir,
      adapter,
      viewports: [
        { width: 800, height: 600, deviceScaleFactor: 1, label: "800x600" },
        { width: 1024, height: 768, deviceScaleFactor: 1, label: "1024x768" },
      ],
      maxCropsPerViewport: 0,
    });

    const findings = report.issues
      .filter((issue) => issue.viewport === "800x600")
      .map(behaviour)
      .filter((item): item is BehaviourDetails => Boolean(item));
    expect(findings.filter((item) => item.kind === "console-message")).toEqual([
      {
        kind: "console-message",
        level: "error",
        text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
        sourceUrl: `${origin}/missing-asset.png?fixture=same-origin`,
        line: 0,
      },
      {
        kind: "console-message",
        level: "error",
        text: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
        sourceUrl: `${origin}/expected-503?fixture=same-origin`,
        line: 0,
      },
      {
        kind: "console-message",
        level: "error",
        text: "Fixture console error",
        sourceUrl: `${origin}/`,
        line: 19,
      },
      {
        kind: "console-message",
        level: "warning",
        text: "Fixture console warning",
        sourceUrl: `${origin}/`,
        line: 20,
      },
    ]);
    expect(findings.filter((item) => item.kind === "failed-request")).toEqual([
      {
        kind: "failed-request",
        method: "GET",
        url: `${origin}/expected-503?fixture=same-origin`,
        status: 503,
      },
      {
        kind: "failed-request",
        method: "GET",
        url: `${origin}/missing-asset.png?fixture=same-origin`,
        status: 404,
      },
    ]);
    expect(findings.filter((item) => item.kind === "storage-change")).toEqual([
      {
        kind: "storage-change",
        storage: "cookie",
        name: "vqa_fixture_cookie",
        attributes: {
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Strict",
        },
      },
      { kind: "storage-change", storage: "localStorage", key: "vqa.fixture.local" },
      { kind: "storage-change", storage: "sessionStorage", key: "vqa.fixture.session" },
    ]);
    expect(modelCalls).toBe(0);
    expect(report.issues.every((issue) => issue.aiRecommendation.status === "unavailable"))
      .toBe(true);

    const stored = await readFile(join(outDir, "issues.json"), "utf8");
    expect(JSON.parse(stored)).toEqual(report as Report);
    expect(report.formatVersion).toBe("3");
    expect(stored).not.toContain("secret-cookie-value");
    expect(stored).not.toContain("secret-rejected-value");
    expect(stored).not.toContain("secret-local-value");
    expect(stored).not.toContain("secret-session-value");
    expect(stored).not.toContain("secret response body");
    expect(stored).not.toContain("secret missing body");

    const summary = JSON.parse(
      await readFile(join(outDir, "agent-summary.json"), "utf8"),
    ) as AgentSummary;
    const behaviourGroups = report.groups?.filter((group) =>
      ["console-message", "failed-request", "storage-change"].includes(group.type),
    ) ?? [];
    expect(behaviourGroups).toHaveLength(findings.length);
    expect(behaviourGroups.every((group) => group.issueIds.length === 2)).toBe(true);
    expect(summary.defects.filter((defect) =>
      ["console-message", "failed-request", "storage-change"].includes(defect.type),
    ).map((defect) => defect.id).sort()).toEqual(
      behaviourGroups.map((group) => group.id).sort(),
    );

    const browser = await chromium.launch({ headless: true });
    try {
      const staticPage = await browser.newPage();
      await staticPage.setContent(renderReportHtml(report));
      expect(await staticPage.getByRole("heading", { name: "Visual", exact: true }).count()).toBe(1);
      expect(await staticPage.getByRole("heading", { name: "Behaviour", exact: true }).count()).toBe(1);
      expect(await staticPage.locator('[data-finding-kind="behaviour"] .issue').count())
        .toBe(behaviourGroups.length);

      const reviewPage = await browser.newPage();
      await reviewPage.goto(new URL(`file://${join(outDir, "report.html")}`).href);
      await expect.poll(() => reviewPage.locator("[data-capture]").count()).toBe(1);
      const firstCard = reviewPage.locator("[data-capture]").first();
      const rowTitles = await firstCard.locator(".issue-row .issue-open").allTextContents();
      expect(rowTitles.some((text) => text.includes("Request to") && text.includes("expected-503"))).toBe(true);
      expect(rowTitles.some((text) => text.includes("visual concern"))).toBe(false);
      await firstCard.locator(".issue-row", { hasText: "expected-503" }).locator(".issue-open").click();
      await expect.poll(() => reviewPage.locator("#drawer[open]").count()).toBe(1);
      expect(await reviewPage.locator("#drawerTitle").innerText()).toContain("expected-503");
      expect(await reviewPage.locator("#drawerBody").innerText()).toContain("Evidence");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("captures delayed scenario activity plus transient and child-frame storage writes", async () => {
    const origin = await fixtureServer();
    const root = await mkdtemp(join(tmpdir(), "vqa-behaviour-delayed-"));
    temporaryRoots.push(root);
    const report = await scan({
      url: `${origin}/`,
      outDir: join(root, "report"),
      scenarios: [{
        label: "Delayed behaviour",
        url: `${origin}/`,
        steps: [{ click: { role: "button", name: "Trigger delayed behaviour" } }],
      }],
      viewports: [{ width: 800, height: 600, deviceScaleFactor: 1, label: "800x600" }],
      maxCropsPerViewport: 0,
    });
    const findings = report.issues.map(behaviour).filter((item): item is BehaviourDetails => Boolean(item));

    expect(findings).toContainEqual(expect.objectContaining({
      kind: "console-message",
      text: "Delayed scenario error",
    }));
    expect(findings).toContainEqual({
      kind: "failed-request",
      method: "GET",
      url: `${origin}/delayed-503?fixture=same-origin`,
      status: 503,
    });
    expect(findings).toContainEqual({
      kind: "storage-change",
      storage: "localStorage",
      key: "vqa.fixture.transient",
    });
    expect(findings).toContainEqual({
      kind: "storage-change",
      storage: "localStorage",
      key: "vqa.fixture.frame",
    });
    expect(findings).toContainEqual(expect.objectContaining({
      kind: "storage-change",
      storage: "cookie",
      name: "vqa_transient_cookie",
    }));
    const stored = JSON.stringify(report);
    expect(stored).not.toContain("secret-transient-value");
    expect(stored).not.toContain("secret-transient-cookie");
    expect(stored).not.toContain("secret-frame-value");
    expect(stored).not.toContain("secret delayed response body");
  }, 60_000);

  it("dedupes repeated behaviour while retaining distinct observations and stable ids", async () => {
    const origin = await listen((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
      if (path === "/nested/page") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><script>
          function emit(message) { console.error(message); }
          emit("First same-callsite error");
          emit("Second same-callsite error");
          console.warn("Repeated warning");
          console.warn("Repeated warning");
          void fetch("/same-url", { method: "GET" });
          void fetch("/same-url", { method: "POST" });
          localStorage["vqa.fixture.named"] = "secret-named-value";
          delete localStorage["vqa.fixture.named"];
          void fetch("/transient-server-cookie");
          document.cookie = "shared=first-secret; Path=/a; SameSite=Lax";
          document.cookie = "shared=second-secret; Path=/b; SameSite=Lax";
          document.cookie = "default_path=third-secret; SameSite=Strict";
        </script>`);
        return;
      }
      if (path === "/transient-server-cookie") {
        response.writeHead(204, { "set-cookie": [
          "server_transient=secret-http-only; Path=/; HttpOnly; SameSite=Strict",
          "server_transient=gone; Path=/; HttpOnly; Max-Age=0; SameSite=Strict",
        ] });
        response.end();
        return;
      }
      response.writeHead(request.method === "POST" ? 503 : 404, { "content-type": "text/plain" });
      response.end("secret response");
    });
    const root = await mkdtemp(join(tmpdir(), "vqa-behaviour-identity-"));
    temporaryRoots.push(root);
    const outDir = join(root, "report");
    const report = await scan({
      url: `${origin}/nested/page`,
      outDir,
      viewports: [{ width: 800, height: 600, deviceScaleFactor: 1, label: "800x600" }],
      maxCropsPerViewport: 0,
    });
    const repeatedReport = await scan({
      url: `${origin}/nested/page`,
      outDir: join(root, "report-repeat"),
      viewports: [{ width: 800, height: 600, deviceScaleFactor: 1, label: "800x600" }],
      maxCropsPerViewport: 0,
    });
    const issues = report.issues.filter((issue) => behaviour(issue));

    expect(new Set(issues.map((issue) => issue.id))).toHaveLength(issues.length);
    const identityToId = (items: typeof issues) => Object.fromEntries(items.map((issue) => [
      JSON.stringify(behaviour(issue)),
      issue.id,
    ]));
    expect(identityToId(repeatedReport.issues.filter((issue) => behaviour(issue))))
      .toEqual(identityToId(issues));
    expect(issues.filter((issue) => behaviour(issue)?.kind === "console-message" &&
      behaviour(issue)?.text?.includes("same-callsite"))).toHaveLength(2);
    const repeated = issues.find((issue) => behaviour(issue)?.kind === "console-message" &&
      behaviour(issue)?.text === "Repeated warning");
    expect(repeated?.instanceCount).toBe(2);
    expect(repeated?.occurrences).toHaveLength(2);
    const requestIssue = issues.find((issue) => behaviour(issue)?.kind === "failed-request" &&
      behaviour(issue)?.url === `${origin}/same-url`);
    expect(requestIssue?.instanceCount).toBe(2);
    expect(requestIssue?.occurrences?.map((occurrence) => occurrence.behaviour)).toEqual([
      { kind: "failed-request", method: "GET", url: `${origin}/same-url`, status: 404 },
      { kind: "failed-request", method: "POST", url: `${origin}/same-url`, status: 503 },
    ]);
    expect(issues.map(behaviour)).toContainEqual({
      kind: "storage-change",
      storage: "localStorage",
      key: "vqa.fixture.named",
    });
    expect(issues.map(behaviour)).toContainEqual(expect.objectContaining({
      kind: "storage-change",
      storage: "cookie",
      name: "server_transient",
      attributes: expect.objectContaining({ httpOnly: true }),
    }));
    expect(issues.filter((issue) => {
      const details = behaviour(issue);
      return details?.kind === "storage-change" && details.storage === "cookie" &&
        details.name === "shared";
    })).toHaveLength(2);
    const defaultPathCookies = issues.map(behaviour).filter((details) =>
      details?.kind === "storage-change" && details.storage === "cookie" &&
      details.name === "default_path");
    expect(defaultPathCookies).toEqual([{
      kind: "storage-change",
      storage: "cookie",
      name: "default_path",
      attributes: {
        domain: "127.0.0.1",
        path: "/nested",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Strict",
      },
    }]);
    expect(JSON.stringify(report)).not.toContain("first-secret");
    expect(JSON.stringify(report)).not.toContain("second-secret");
    expect(JSON.stringify(report)).not.toContain("secret response");
    expect(JSON.stringify(report)).not.toContain("secret-named-value");
    expect(JSON.stringify(report)).not.toContain("secret-http-only");
    const manifest = JSON.parse(await readFile(join(outDir, "review-manifest.json"), "utf8")) as {
      issues: Array<{ type: string; occurrences?: Array<{ behaviour?: BehaviourDetails }> }>;
    };
    const manifestRequest = manifest.issues.find((issue) => issue.type === "failed-request");
    expect(manifestRequest?.occurrences?.map((item) => item.behaviour)).toEqual([
      { kind: "failed-request", method: "GET", url: `${origin}/same-url`, status: 404 },
      { kind: "failed-request", method: "POST", url: `${origin}/same-url`, status: 503 },
    ]);
    const summary = JSON.parse(await readFile(join(outDir, "agent-summary.json"), "utf8")) as AgentSummary;
    const summaryMessage = summary.defects.find((item) =>
      item.type === "failed-request" && item.message.includes("same-url"))?.message;
    expect(summaryMessage).toContain(`GET ${origin}/same-url answered 404`);
    expect(summaryMessage).toContain(`POST ${origin}/same-url answered 503`);

    const browser = await chromium.launch({ headless: true });
    try {
      const staticPage = await browser.newPage();
      await staticPage.setContent(renderReportHtml(report));
      expect(await staticPage.locator("body").innerText()).toContain(`POST ${origin}/same-url answered 503`);
      const reviewPage = await browser.newPage();
      await reviewPage.goto(new URL(`file://${join(outDir, "report.html")}`).href);
      await expect.poll(() => reviewPage.locator("[data-capture]").count()).toBe(1);
      await reviewPage.locator("[data-capture]").first()
        .locator(".issue-row", { hasText: "same-url" }).locator(".issue-open").click();
      await expect.poll(() => reviewPage.locator("#drawer[open]").count()).toBe(1);
      expect(await reviewPage.locator("#drawerBody").innerText())
        .toContain(`POST ${origin}/same-url answered 503`);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("publishes no behaviour findings for the false-positive fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-behaviour-clean-"));
    temporaryRoots.push(root);
    await scan({
      url: new URL("../../../fixtures/false-positives.html", import.meta.url).href,
      outDir: join(root, "report"),
      viewports: [{ width: 800, height: 600, deviceScaleFactor: 1, label: "800x600" }],
      maxCropsPerViewport: 0,
    });
    const behaviourTypes = new Set(["console-message", "failed-request", "storage-change"]);
    const stored = JSON.parse(await readFile(join(root, "report", "issues.json"), "utf8")) as Report;
    const manifest = JSON.parse(await readFile(join(root, "report", "review-manifest.json"), "utf8")) as
      { issues: Array<{ type: string; finding_kind?: string }> };
    expect([...stored.issues, ...(stored.groups ?? [])].filter((item) => behaviourTypes.has(item.type))).toEqual([]);
    expect(manifest.issues.filter((item) => item.finding_kind === "behaviour" || behaviourTypes.has(item.type))).toEqual([]);
  }, 60_000);

  it("strips query strings from cross-origin behaviour URLs", async () => {
    const resourceOrigin = await listen((request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      if (new URL(request.url ?? "/", "http://fixture.test").pathname === "/external.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end('console.error("Cross-origin console error");');
        return;
      }
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("secret cross-origin response body");
    });
    const pageOrigin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>URL privacy</title>
        <script src="${resourceOrigin}/external.js?secret=console-query"></script>
        <script>void fetch("${resourceOrigin}/failed?secret=request-query");</script>`);
    });
    const root = await mkdtemp(join(tmpdir(), "vqa-behaviour-url-"));
    temporaryRoots.push(root);
    const report = await scan({
      url: `${pageOrigin}/`,
      outDir: join(root, "report"),
      allowedOrigins: [resourceOrigin],
      viewports: [{ width: 800, height: 600, deviceScaleFactor: 1, label: "800x600" }],
      maxCropsPerViewport: 0,
    });
    const findings = report.issues.map(behaviour).filter((item): item is BehaviourDetails => Boolean(item));

    expect(findings).toEqual([
      {
        kind: "console-message",
        level: "error",
        text: "Cross-origin console error",
        sourceUrl: `${resourceOrigin}/external.js`,
        line: 0,
      },
      {
        kind: "console-message",
        level: "error",
        text: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
        sourceUrl: `${resourceOrigin}/failed`,
        line: 0,
      },
      {
        kind: "failed-request",
        method: "GET",
        url: `${resourceOrigin}/failed`,
        status: 503,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("console-query");
    expect(JSON.stringify(report)).not.toContain("request-query");
    expect(JSON.stringify(report)).not.toContain("secret cross-origin response body");
  }, 60_000);
});
