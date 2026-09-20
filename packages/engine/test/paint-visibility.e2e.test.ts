import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { Report, ReviewManifest } from "@vqa/contract";
import { renderReportHtml } from "../src/report-html.js";
import { scan } from "../src/scan.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("paint visibility", () => {
  it("reports no findings from boxless native select options", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-paint-visibility-"));
    temporaryRoots.push(root);
    const report = await scan({
      url: pathToFileURL(join(process.cwd(), "fixtures/false-positives.html")).href,
      outDir: join(root, "report"),
      viewports: [
        { width: 390, height: 844, deviceScaleFactor: 1, label: "390x844" },
      ],
      maxCropsPerViewport: 0,
    });

    expect(
      report.issues.filter(
        (issue) =>
          issue.selector.includes("fp-native-") ||
          (issue.otherSelector ?? "").includes("fp-native-"),
      ),
    ).toEqual([]);
  }, 60_000);

  it("groups identical fixture findings across viewport captures", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-viewport-groups-"));
    temporaryRoots.push(root);
    const outDir = join(root, "report");
    const report = await scan({
      url: pathToFileURL(join(process.cwd(), "fixtures/seeded-defects.html")).href,
      outDir,
      viewports: [
        { width: 390, height: 844, deviceScaleFactor: 1, label: "390x844" },
        { width: 768, height: 1024, deviceScaleFactor: 1, label: "768x1024" },
        { width: 1440, height: 900, deviceScaleFactor: 1, label: "1440x900" },
      ],
      maxCropsPerViewport: 0,
    });
    const colorGroup = report.groups?.find(
      (group) =>
        group.type === "color" && group.elementFingerprint === "id:seed-color",
    );

    expect(colorGroup?.issueIds).toHaveLength(3);
    expect(colorGroup?.viewportRange).toBe("fails at 390px and above");
    expect(report.issues.filter(
      (issue) => issue.type === "color" && issue.selector.includes("seed-color"),
    )).toHaveLength(3);
    const middleOverflow = report.groups?.find(
      (group) =>
        group.type === "page-overflow" &&
        group.issueIds.some(
          (id) => report.issues.find((issue) => issue.id === id)?.viewport === "768x1024",
        ),
    );
    expect(middleOverflow?.viewportRange)
      .toBe("fails at 768px");
    expect(
      report.groups
        ?.filter((group) => group.type === "page-overflow")
        .every((group) => !group.viewportRange.includes("clean")),
    ).toBe(true);

    const stored = JSON.parse(
      await readFile(join(outDir, "issues.json"), "utf8"),
    ) as Report;
    expect(stored.groups?.find(
      (group) => group.type === "color" && group.elementFingerprint === "id:seed-color",
    ))
      .toEqual(colorGroup);
    const manifest = JSON.parse(
      await readFile(join(outDir, "review-manifest.json"), "utf8"),
    ) as ReviewManifest;
    expect(manifest.issues.find(
      (issue) => issue.type === "color" && issue.element_fingerprint === "id:seed-color",
    )?.group_ids).toContain(colorGroup?.id);

    const browser = await chromium.launch({ headless: true });
    try {
      const staticPage = await browser.newPage();
      await staticPage.setContent(renderReportHtml(report));
      expect(await staticPage.locator(".issue").count()).toBe(report.groups?.length);
      expect(await staticPage.getByText("fails at 390px and above", { exact: true }).count())
        .toBeGreaterThan(0);

      const reviewPage = await browser.newPage();
      await reviewPage.goto(pathToFileURL(join(outDir, "report.html")).href);
      await expect.poll(() => reviewPage.locator("[data-capture]").count()).toBe(3);
      await reviewPage.locator("[data-capture]").first()
        .locator(".issue-row .issue-open").first().click();
      await expect.poll(() => reviewPage.locator("#drawer[open]").count()).toBe(1);
      // One concern on every scanned size reads as such, not as three findings.
      expect(await reviewPage.locator("#drawerBody .issue-range").innerText())
        .toMatch(/^At every size scanned \(Mobile 390×844, Tablet 768×1024, Desktop 1440×900\)\.$/u);

      const colorConcern = manifest.issues.find(
        (issue) => issue.type === "color" && issue.element_fingerprint === "id:seed-color",
      )!;
      const colorIssues = stored.issues.filter(
        (issue) => issue.type === "color" && issue.elementFingerprint === "id:seed-color",
      );
      stored.groups = [
        ...(stored.groups ?? []).filter((group) => group.id !== colorGroup?.id),
        {
          id: "group-color-mobile",
          type: "color",
          pageUrl: colorIssues[0]?.pageUrl,
          elementFingerprint: "id:seed-color",
          message: "Mobile color evidence.",
          issueIds: [colorIssues[0]!.id],
          viewportRange: "fails at 390px, clean at 768px and above",
        },
        {
          id: "group-color-wide",
          type: "color",
          pageUrl: colorIssues[1]?.pageUrl,
          elementFingerprint: "id:seed-color",
          message: "Wide color evidence.",
          issueIds: colorIssues.slice(1).map((issue) => issue.id),
          viewportRange: "fails at 768px and above, clean at 390px",
        },
      ];
      colorConcern.group_ids = ["group-color-mobile", "group-color-wide"];
      // The review shows the detector's exact finding for the capture being
      // looked at, so a concern with different evidence per size stays honest.
      const groupedReviewPage = await browser.newPage();
      await groupedReviewPage.setContent(renderReportHtml(stored, manifest));
      const colorRow = groupedReviewPage.locator("[data-capture]").first()
        .locator('[data-issue-row="' + colorConcern.id + '"] .issue-open');
      await colorRow.click();
      await expect.poll(() => groupedReviewPage.locator("#drawer[open]").count()).toBe(1);
      const firstCapture = manifest.captures[0]!;
      const occurrence = colorConcern.occurrences!.find((item) => item.capture_coordinate_id === firstCapture.coordinate_id)!;
      expect(await groupedReviewPage.locator("#drawerBody .issue-finding").innerText()).toBe(occurrence.message);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
