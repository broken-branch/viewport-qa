import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Report } from "@vqa/contract";
import { compareRunCaptures, markRunAsBaseline, renderReportHtml } from "../src/index.js";
import { writeReviewArtifacts } from "../src/review-manifest.js";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function report(viewports: string[]): Report {
  return {
    formatVersion: "2",
    tool: "viewport-qa",
    toolVersion: "0.1.0",
    url: "https://example.test",
    createdAt: "2026-07-30T00:00:00.000Z",
    adapter: { impl: "stub", wired: false },
    viewports: viewports.map((label) => ({
      viewport: { width: 4, height: 4, deviceScaleFactor: 1, label },
      page: { scrollWidth: 4, scrollHeight: 4, viewportWidth: 4, viewportHeight: 4 },
      screenshot: `screenshots/${label}/full.png`,
      issueCount: 0,
      rawIssueCount: 0,
    })),
    issues: [],
  };
}

async function writeFixtureImage(
  dir: string,
  label: string,
  changedPixels: Array<[number, number]> = [],
): Promise<void> {
  const image = new PNG({ width: 4, height: 4 });
  image.data.fill(255);
  for (const [x, y] of changedPixels) {
    const offset = (y * image.width + x) * 4;
    image.data[offset] = 0;
    image.data[offset + 1] = 0;
    image.data[offset + 2] = 0;
  }
  const path = join(dir, "screenshots", label, "full.png");
  await mkdir(join(dir, "screenshots", label), { recursive: true });
  await writeFile(path, PNG.sync.write(image));
}

async function writeReport(dir: string, value: Report): Promise<void> {
  await writeFile(join(dir, "issues.json"), JSON.stringify(value));
}

async function fixtureRun(
  viewports: string[],
  changes: Record<string, Array<[number, number]>> = {},
): Promise<{ dir: string; report: Report }> {
  const dir = mkdtempSync(join(tmpdir(), "vqa-diff-"));
  createdDirs.push(dir);
  const value = report(viewports);
  await Promise.all([
    writeReport(dir, value),
    ...viewports.map((label) => writeFixtureImage(dir, label, changes[label])),
  ]);
  return { dir, report: value };
}

async function multiPageFixtureRun(): Promise<{ dir: string; report: Report }> {
  const dir = mkdtempSync(join(tmpdir(), "vqa-diff-crawl-"));
  createdDirs.push(dir);
  const value = report(["small"]);
  const first = value.viewports[0]!;
  value.viewports = [
    {
      ...first,
      pageUrl: "https://example.test/",
      screenshot: "pages/001/screenshots/small/full.png",
    },
    {
      ...first,
      pageUrl: "https://example.test/about",
      screenshot: "pages/002/screenshots/small/full.png",
    },
  ];
  await Promise.all([
    writeReport(dir, value),
    ...value.viewports.map(async (viewport) => {
      const image = new PNG({ width: 4, height: 4 });
      image.data.fill(255);
      const path = join(dir, viewport.screenshot);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, PNG.sync.write(image));
    }),
  ]);
  return { dir, report: value };
}

describe("run capture diffs", () => {
  it("reports identical fixture captures with a zero score", async () => {
    const baseline = await fixtureRun(["small"]);
    const current = await fixtureRun(["small"]);

    const comparison = await compareRunCaptures(
      current.report,
      current.dir,
      baseline.dir,
    );

    expect(comparison.changedTargetCount).toBe(0);
    expect(comparison.results).toEqual([
      expect.objectContaining({
        target: "small",
        status: "identical",
        score: 0,
        changedPixels: 0,
        totalPixels: 16,
        changedRegions: [],
      }),
    ]);
  });

  it("scores changed fixture pixels and records their region", async () => {
    const baseline = await fixtureRun(["small"]);
    const current = await fixtureRun(["small"], {
      small: [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
      ],
    });

    const comparison = await compareRunCaptures(
      current.report,
      current.dir,
      baseline.dir,
    );

    expect(comparison.changedTargetCount).toBe(1);
    expect(comparison.results[0]).toMatchObject({
      target: "small",
      status: "changed",
      score: 0.25,
      changedPixels: 4,
      totalPixels: 16,
      changedRegions: [{ x: 0, y: 0, width: 4, height: 4, changedPixels: 4 }],
    });
  });

  it("keeps missing baseline and current targets as changed results", async () => {
    const baseline = await fixtureRun(["shared", "baseline-only"]);
    const current = await fixtureRun(["shared", "current-only"]);

    const comparison = await compareRunCaptures(
      current.report,
      current.dir,
      baseline.dir,
    );

    expect(comparison.changedTargetCount).toBe(2);
    expect(comparison.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "current-only",
          status: "missing-baseline",
          score: 1,
          changedRegions: [expect.objectContaining({ changedPixels: 16 })],
        }),
        expect.objectContaining({
          target: "baseline-only",
          status: "missing-current",
          score: 1,
          changedRegions: [expect.objectContaining({ changedPixels: 16 })],
        }),
      ]),
    );
  });

  it("keeps repeated viewport labels distinct across crawled pages", async () => {
    const baseline = await multiPageFixtureRun();
    const current = await multiPageFixtureRun();

    const comparison = await compareRunCaptures(
      current.report,
      current.dir,
      baseline.dir,
    );

    expect(comparison.results.map((result) => result.target)).toEqual([
      "https://example.test/ @ small",
      "https://example.test/about @ small",
    ]);
    expect(comparison.changedTargetCount).toBe(0);
  });

  it("keys by page URL when only the baseline contains multiple pages", async () => {
    const baseline = await multiPageFixtureRun();
    const current = await fixtureRun(["small"]);
    current.report.viewports[0]!.pageUrl = "https://example.test/";

    const comparison = await compareRunCaptures(
      current.report,
      current.dir,
      baseline.dir,
    );

    expect(comparison.results).toEqual([
      expect.objectContaining({
        target: "https://example.test/ @ small",
        status: "identical",
        score: 0,
      }),
      expect.objectContaining({
        target: "https://example.test/about @ small",
        status: "missing-current",
        score: 1,
      }),
    ]);
  });

  it("matches different single-page URLs by viewport label", async () => {
    const baseline = await fixtureRun(["small"]);
    const current = await fixtureRun(["small"], { small: [[1, 1]] });
    baseline.report.url = "https://production.example.test/page";
    baseline.report.viewports[0]!.pageUrl = baseline.report.url;
    current.report.url = "https://staging.example.test/page?preview=1";
    current.report.viewports[0]!.pageUrl = current.report.url;
    await writeReport(baseline.dir, baseline.report);

    const comparison = await compareRunCaptures(
      current.report,
      current.dir,
      baseline.dir,
    );

    expect(comparison.results).toEqual([
      expect.objectContaining({
        target: "small",
        status: "changed",
        score: 1 / 16,
      }),
    ]);
  });

  it("marks an existing run as the baseline and refreshes its report", async () => {
    const run = await fixtureRun(["small"]);
    run.report.formatVersion = "3";
    await writeReport(run.dir, run.report);
    await writeReviewArtifacts(run.report, run.dir, renderReportHtml);

    const marked = await markRunAsBaseline(run.dir);

    expect(marked.baseline?.markedAt).toBeTruthy();
    expect(marked.baseline?.markedAt).not.toBe(run.report.createdAt);
    expect(await readFile(join(run.dir, "report.html"), "utf8")).toContain('id="vqa-manifest"');
  });

  it("preserves a pre-manifest format-v2 report as read-only", async () => {
    const run = await fixtureRun(["small"]);
    await expect(markRunAsBaseline(run.dir)).rejects.toThrow(/cannot replace an invalid report/u);
    expect(JSON.parse(await readFile(join(run.dir, "issues.json"), "utf8"))).toEqual(run.report);
  });
});
