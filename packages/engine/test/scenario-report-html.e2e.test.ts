import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import type { Report, ReviewManifest } from "@vqa/contract";
import { renderReportHtml } from "../src/report-html.js";

const fixtures = new URL("fixtures/review-journey/", import.meta.url);
const report: Report = {
  formatVersion: "2",
  tool: "viewport-qa",
  toolVersion: "0.4.0-rc.1",
  url: "https://northstar.example/",
  createdAt: "2026-09-05T00:00:00.000Z",
  adapter: { impl: "stub", wired: false },
  viewports: [],
  issues: [],
};

describe("scenario report HTML", () => {
  it("shows the state label for one named recipe scenario", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("review-manifest.json", fixtures), "utf8"),
    ) as ReviewManifest;
    const state = manifest.states[0]!;
    state.label = "Default";
    state.arrangement_provenance = "scenario-recipe";
    manifest.states = [state];
    manifest.captures = manifest.captures.filter((capture) => capture.state_id === state.id);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.setContent(renderReportHtml(report, manifest));
      await expect.poll(() =>
        page.locator(".filters legend", { hasText: "Scenario" }).count()
      ).toBe(1);
      expect(await page.getByText("Default", { exact: true }).first().isVisible()).toBe(true);
      expect(await page.locator(".scenario-group-title").textContent()).toBe("Default");
      expect(await page.locator(".capture-title").first().textContent()).toContain("Default");
    } finally {
      await browser.close();
    }
  });

  it("groups recipe captures under labelled state sections", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("review-manifest.json", fixtures), "utf8"),
    ) as ReviewManifest;
    manifest.states[0]!.label = "Empty cart";
    manifest.states[0]!.arrangement_provenance = "scenario-recipe";
    manifest.states[1]!.label = "With items";
    manifest.states[1]!.arrangement_provenance = "scenario-recipe";
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.setContent(renderReportHtml(report, manifest));
      const groups = page.locator(".scenario-group");
      await expect.poll(() => groups.count()).toBe(2);
      expect(await groups.nth(0).locator(":scope > .scenario-group-title").textContent())
        .toBe("Empty cart");
      expect(await groups.nth(1).locator(":scope > .scenario-group-title").textContent())
        .toBe("With items");
      expect(await groups.nth(0).locator(".capture").count()).toBeGreaterThan(0);
      expect(await groups.nth(1).locator(".capture").count()).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});
