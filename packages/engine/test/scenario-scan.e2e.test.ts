import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSummary, Report, ReviewManifest, Scenario } from "@vqa/contract";
import { scan } from "../src/scan.js";

let server: Server;
let escapeServer: Server;
let report: Report;
let reportDir: string;
let root: string;
let apiRequests = 0;
let externalTouches = 0;
let origin: string;
let escapeOrigin: string;

const scenarios: Scenario[] = [
  {
    label: "Toolbar panel",
    url: "/",
    steps: [
      { click: { role: "button", name: "Open toolbar" } },
      { fill: { role: "textbox", name: "Search records", value: "Ada" } },
      { waitFor: { role: "region", name: "Toolbar panel" } },
    ],
  },
  {
    label: "Settings modal",
    url: "/",
    steps: [
      { click: { role: "button", name: "Open settings" } },
      { waitFor: { role: "dialog", name: "Settings" } },
    ],
  },
  {
    label: "Empty records",
    url: "/",
    steps: [
      { route: { url: "/api/records", status: 200, body: "[]" } },
      { click: { role: "button", name: "Load records" } },
      { waitFor: { role: "status", name: "No records" } },
    ],
  },
  {
    label: "Initial empty records",
    url: "/initial",
    steps: [
      { route: { url: "/api/initial-records", status: 200, body: "[]" } },
      { waitFor: { role: "status", name: "No initial records" } },
    ],
  },
  {
    label: "Missing control",
    url: "/",
    steps: [
      { click: { role: "button", name: "Does not exist" } },
      { waitFor: { role: "dialog", name: "Never reached" } },
      { route: { url: "/api/late-fixture", status: 503, body: "unavailable" } },
    ],
  },
  {
    label: "Disabled control",
    url: "/",
    steps: [
      { click: { role: "button", name: "Disabled action" } },
    ],
  },
];

beforeAll(async () => {
  escapeServer = createServer((request, response) => {
    externalTouches += 1;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><a href="/touched">Touch external</a>');
  });
  await new Promise<void>((resolvePromise) => escapeServer.listen(0, "127.0.0.1", resolvePromise));
  const escapeAddress = escapeServer.address();
  if (!escapeAddress || typeof escapeAddress === "string") throw new Error("escape server did not bind");
  escapeOrigin = `http://127.0.0.1:${escapeAddress.port}`;
  const fixture = readFileSync(
    join(import.meta.dirname, "../../../fixtures/scenario-states.html"),
    "utf8",
  ).replace("</header>", `<a href="${escapeOrigin}/external">Leave origin</a></header>`);
  server = createServer((request, response) => {
    if (request.url === "/api/records" || request.url === "/api/initial-records") {
      apiRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('[{"name":"server response"}]');
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/initial"
      ? fixture.replace("</body>", `<script>
        (async () => {
          const target = document.querySelector("#records");
          target.setAttribute("role", "status");
          target.setAttribute("aria-label", "Loading initial records");
          target.textContent = "Loading initial records";
          const response = await fetch("/api/initial-records");
          const items = await response.json();
          target.textContent = items.length ? items[0].name : "No initial records";
          target.setAttribute("aria-label", target.textContent);
        })();
      </script></body>`)
      : fixture);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scenario fixture server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  root = mkdtempSync(join(tmpdir(), "vqa-scenarios-"));
  reportDir = join(root, "report");
  report = await scan({
    url: `${origin}/`,
    outDir: reportDir,
    viewports: [
      { width: 390, height: 844, deviceScaleFactor: 1, label: "390x844@1" },
      { width: 1280, height: 800, deviceScaleFactor: 1, label: "1280x800@1" },
    ],
    scenarios,
    timeoutMs: 1_500,
  });
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (escapeServer) await new Promise<void>((resolvePromise) => escapeServer.close(() => resolvePromise()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("named scenario scans", () => {
  it("captures every scenario at the plain viewport matrix after running its steps", () => {
    expect(report.viewports).toHaveLength(12);
    for (const scenario of scenarios) {
      const captures = report.viewports.filter((capture) => capture.scenarioLabel === scenario.label);
      expect(captures.map((capture) => capture.viewport.label)).toEqual(["390x844@1", "1280x800@1"]);
      expect(captures.every((capture) => existsSync(join(reportDir, capture.screenshot)))).toBe(true);
    }
    const hashesByViewport = new Map<string, Set<string>>();
    for (const capture of report.viewports) {
      const hashes = hashesByViewport.get(capture.viewport.label) ?? new Set<string>();
      hashes.add(createHash("sha256").update(readFileSync(join(reportDir, capture.screenshot))).digest("hex"));
      hashesByViewport.set(capture.viewport.label, hashes);
    }
    expect([...hashesByViewport.values()].every((hashes) => hashes.size >= 3)).toBe(true);
    const issueById = new Map(report.issues.map((issue) => [issue.id, issue]));
    expect((report.groups ?? []).every((group) =>
      new Set(group.issueIds.map((id) => issueById.get(id)?.scenarioLabel)).size === 1
    )).toBe(true);
  });

  it("publishes the labels and exact normalized steps with grouped report views", () => {
    const published = JSON.parse(readFileSync(join(reportDir, "issues.json"), "utf8")) as Report;
    expect(published.scenarios).toEqual(report.scenarios);
    expect(published.scenarios?.map((scenario) => scenario.label)).toEqual(
      scenarios.map((scenario) => scenario.label),
    );
    expect(published.scenarios?.[2]?.steps[0]).toEqual({
      route: {
        url: expect.stringMatching(/\/api\/records$/u),
        status: 200,
        body: "[]",
      },
    });
    const missingSteps = published.viewports
      .filter((capture) => capture.scenarioLabel === "Missing control")
      .map((capture) => capture.scenarioSteps);
    expect(missingSteps).toEqual(Array.from({ length: 2 }, () => [
      { route: { url: `${origin}/api/late-fixture`, status: 503, body: "unavailable" } },
      { click: { role: "button", name: "Does not exist" } },
    ]));
    const emptyRecordSteps = published.viewports
      .filter((capture) => capture.scenarioLabel === "Empty records")
      .map((capture) => capture.scenarioSteps);
    expect(emptyRecordSteps).toEqual(Array.from({ length: 2 }, () => [
      { route: { url: `${origin}/api/records`, status: 200, body: "[]" } },
      { click: { role: "button", name: "Load records" } },
      { waitFor: { role: "status", name: "No records" } },
    ]));

    const contactSheet = readFileSync(join(reportDir, "contact-sheet.html"), "utf8");
    for (const scenario of scenarios) {
      expect(contactSheet).toContain(`<h2>${scenario.label}</h2>`);
    }
    const manifest = JSON.parse(
      readFileSync(join(reportDir, "review-manifest.json"), "utf8"),
    ) as ReviewManifest;
    expect(manifest.states.map((state) => state.label)).toEqual(
      scenarios.map((scenario) => scenario.label),
    );
    expect(manifest.captures.every((capture) =>
      manifest.states.some((state) => state.id === capture.state_id && state.label.length > 0)
    )).toBe(true);
    const summary = JSON.parse(
      readFileSync(join(reportDir, "agent-summary.json"), "utf8"),
    ) as AgentSummary;
    expect(summary.defects.every((defect) => defect.scenarioLabel)).toBe(true);
    expect(summary.defects.every((defect) =>
      defect.evidence.every((item) => item.reproduction.scenarioLabel === defect.scenarioLabel)
    )).toBe(true);
  });

  it("fulfills route fixtures without contacting the real same-origin endpoint", () => {
    expect(apiRequests).toBe(0);
    expect(report.viewports.filter((capture) => capture.scenarioLabel === "Empty records"))
      .toHaveLength(2);
  });

  it("blocks the first navigation that leaves the scenario origin", async () => {
    const escapedReport = join(root, "escaped-report");
    await expect(scan({
      url: `${origin}/`,
      outDir: escapedReport,
      viewports: [{ width: 390, height: 844, deviceScaleFactor: 1, label: "390x844@1" }],
      allowedOrigins: [escapeOrigin],
      scenarios: [{
        label: "Origin escape",
        url: "/",
        steps: [
          { click: { role: "link", name: "Leave origin" } },
          { click: { role: "link", name: "Touch external" } },
        ],
      }],
      timeoutMs: 1_500,
    })).rejects.toThrow("scenario navigation blocked outside its origin");
    expect(externalTouches).toBe(0);
    expect(existsSync(escapedReport)).toBe(false);
  });

  it("turns one missing-element attempt into a labelled finding and continues the scan", () => {
    const failures = report.issues.filter((issue) =>
      issue.type === "scenario-step" && issue.scenarioLabel === "Missing control"
    );
    expect(failures).toHaveLength(2);
    expect(failures.every((issue) => issue.scenarioLabel === "Missing control")).toBe(true);
    expect(failures.every((issue) => issue.description.includes('button named "Does not exist"'))).toBe(true);
    expect(failures.some((issue) => issue.description.includes("Never reached"))).toBe(false);
    expect(new Set(failures.map((issue) => issue.id))).toHaveLength(2);
    const failureGroups = report.groups?.filter((group) =>
      group.type === "scenario-step" && group.scenarioLabel === "Missing control"
    ) ?? [];
    expect(failureGroups).toHaveLength(1);
    expect(failureGroups[0]?.scenarioLabel).toBe("Missing control");
    expect(failureGroups[0]?.issueIds).toHaveLength(2);
  });

  it("distinguishes an actionability failure from a missing target", () => {
    const failures = report.issues.filter((issue) =>
      issue.type === "scenario-step" && issue.scenarioLabel === "Disabled control"
    );
    expect(failures).toHaveLength(2);
    expect(failures.every((issue) =>
      issue.description.includes('could not complete click on button named "Disabled action"')
    )).toBe(true);
    expect(failures.every((issue) => !issue.description.includes("could not find"))).toBe(true);
  });
});
