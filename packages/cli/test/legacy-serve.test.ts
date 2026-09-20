import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { serveReport } from "../src/serve.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("0.2-era pre-manifest report compatibility", () => {
  it("opens the report read-only without converting or writing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vqa-legacy-report-"));
    roots.push(root);
    const report: Report = {
      formatVersion: "2",
      tool: "viewport-qa",
      toolVersion: "0.2.0",
      url: "file:///trusted/legacy.html",
      createdAt: "2026-08-01T00:00:00.000Z",
      adapter: { impl: "stub", wired: false },
      viewports: [],
      issues: [],
    };
    const original = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(join(root, "issues.json"), original);
    writeFileSync(join(root, "report.html"), "old generated UI");
    const { server, url } = await serveReport({ reportDir: root, port: 0 });
    try {
      const launch = new URL(url);
      const capability = new URLSearchParams(launch.hash.slice(1)).get("cap")!;
      const headers = { authorization: `VQA ${capability}` };
      const html = await (await fetch(new URL("app", url), { headers })).text();
      expect(html).toContain("Legacy format-v2 report: read-only access");
      expect((await fetch(new URL("api/decisions", url), { headers })).status).toBe(409);
      expect((await fetch(new URL("api/decisions", url), {
        method: "POST",
        headers: { ...headers, origin: launch.origin, "content-type": "application/json" },
        body: JSON.stringify({ issueId: "x", action: "approve" }),
      })).status).toBe(409);
      expect(existsSync(join(root, "decisions.json"))).toBe(false);
      expect(existsSync(join(root, "review-manifest.json"))).toBe(false);
      expect(existsSync(join(root, "review-state.json"))).toBe(false);
      expect(readFileSync(join(root, "issues.json"), "utf8")).toBe(original);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed for an unknown pre-manifest product version", async () => {
    const root = mkdtempSync(join(tmpdir(), "vqa-unknown-legacy-report-"));
    roots.push(root);
    writeFileSync(join(root, "issues.json"), JSON.stringify({
      formatVersion: "2",
      tool: "viewport-qa",
      toolVersion: "9.0.0",
      url: "file:///unknown.html",
      createdAt: "2026-08-01T00:00:00.000Z",
      adapter: { impl: "stub", wired: false },
      viewports: [],
      issues: [],
    }));
    await expect(serveReport({ reportDir: root, port: 0 })).rejects.toThrow(/unsupported pre-manifest report version/u);
  });
});
