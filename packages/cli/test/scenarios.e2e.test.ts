import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { assertBuilt, REPO_ROOT, runBin } from "./helpers.js";

let server: Server;
let root: string;
let reportDir: string;
let report: Report;

beforeAll(async () => {
  assertBuilt();
  const fixture = readFileSync(join(REPO_ROOT, "fixtures/scenario-states.html"));
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scenario CLI server did not bind");
  root = mkdtempSync(join(tmpdir(), "vqa-scenario-cli-"));
  reportDir = join(root, "report");
  const result = await runBin([
    "scan",
    `http://127.0.0.1:${address.port}/`,
    "--scenarios",
    join(REPO_ROOT, "docs/examples/scenarios.json"),
    "--viewports",
    "390x844",
    "--out",
    reportDir,
  ]);
  expect(result.code, result.stderr).toBe(0);
  report = JSON.parse(readFileSync(join(reportDir, "issues.json"), "utf8")) as Report;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("vqa scan --scenarios", () => {
  it("loads the recipe and captures each named state", () => {
    expect(report.scenarios?.map((scenario) => scenario.label)).toEqual([
      "Toolbar panel",
      "Settings modal",
      "Empty records",
    ]);
    expect(report.viewports.map((capture) => capture.scenarioLabel)).toEqual([
      "Toolbar panel",
      "Settings modal",
      "Empty records",
    ]);
  });

  it("returns exit 2 on the first recipe error before creating a report", async () => {
    const badRecipe = join(root, "bad-scenarios.json");
    const badReport = join(root, "bad-report");
    writeFileSync(badRecipe, JSON.stringify([
      { label: "Duplicate", url: "/", steps: [] },
      { label: "Duplicate", url: "/other", steps: [{ unsupported: {} }] },
    ]));
    const result = await runBin([
      "scan",
      "http://127.0.0.1:1/",
      "--scenarios",
      badRecipe,
      "--out",
      badReport,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('scenarios[1].label duplicates "Duplicate"');
    expect(result.stderr).not.toContain("supported step");
    expect(existsSync(badReport)).toBe(false);
  });

  it("returns exit 2 before launch when a recipe URL widens origin", async () => {
    const badRecipe = join(root, "off-origin-scenarios.json");
    const badReport = join(root, "off-origin-report");
    writeFileSync(badRecipe, JSON.stringify([{
      label: "Off origin fixture",
      url: "/",
      steps: [{ route: { url: "https://other.example/api", status: 200, body: "[]" } }],
    }]));
    const result = await runBin([
      "scan",
      "http://127.0.0.1:1/",
      "--scenarios",
      badRecipe,
      "--out",
      badReport,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("route.url must stay on the scenario origin");
    expect(existsSync(badReport)).toBe(false);
  });
});
