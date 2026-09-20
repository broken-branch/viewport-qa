import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PageScanResult,
  Report,
  Scenario,
  ViewportSpec,
} from "@vqa/contract";
import {
  PRODUCT_VERSION,
  PROTOCOL_IDENTITY,
  REPORT_FORMAT_VERSION,
  REVIEW_MANIFEST_SCHEMA_VERSION,
  REVIEW_STATE_SCHEMA_VERSION,
} from "@vqa/contract";
import type { ModelAdapter } from "@vqa/model-adapter";
import { StubModelAdapter } from "@vqa/model-adapter";
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PAGES,
  HARD_MAX_DEPTH,
  HARD_MAX_PAGES,
  crawlSameOrigin,
} from "./crawl.js";
import { groupIssuesAcrossViewports } from "./dedupe.js";
import { compareRunCaptures } from "./diff.js";
import { renderReportHtml } from "./report-html.js";
import { writeReviewArtifacts } from "./review-manifest.js";
import { withNewReportTransaction } from "./report-transaction.js";
import { createTargetPolicy } from "./target-policy.js";
import { compatibleBrowserExecutablePath } from "./browser-manager.js";
import { launchSandboxedChromium } from "./browser-launch.js";
import { buildAgentSummary } from "./agent-summary.js";
import { renderContactSheetHtml } from "./contact-sheet.js";
import { scanPage } from "./scan-page.js";
import { prepareScenarios } from "./scenarios.js";

export const TOOL_NAME = PROTOCOL_IDENTITY;
export const TOOL_VERSION = PRODUCT_VERSION;

export interface ScanOptions {
  url: string;
  outDir: string;
  viewports: ViewportSpec[];
  adapter?: ModelAdapter;
  /** Per-page navigation timeout. */
  timeoutMs?: number;
  /** Cap on per-issue crop screenshots per viewport. */
  maxCropsPerViewport?: number;
  /** Cap on collected elements per page. */
  maxElements?: number;
  /** Existing report directory whose captures should be compared to this run. */
  baselineDir?: string;
  /** Enable bounded same-origin crawling. Disabled by default. */
  crawl?: boolean;
  /** Maximum pages visited when crawling (default 10, hard cap 50). */
  maxPages?: number;
  /** Maximum link depth from the start page when crawling (default 2, hard cap 10). */
  maxDepth?: number;
  /** Exact public origins admitted for navigation and page resources. */
  allowedOrigins?: readonly string[];
  /** Validated named page states to capture instead of the initial target state. */
  scenarios?: readonly Scenario[];
  /** Cancels an in-flight scan while preserving transactional cleanup. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

function assertIntegerLimit(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

async function scanInto(options: ScanOptions): Promise<Report> {
  const adapter = options.adapter ?? new StubModelAdapter();
  const log = options.log ?? (() => {});
  const resolved = {
    url: options.url,
    outDir: options.outDir,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxCropsPerViewport: options.maxCropsPerViewport ?? 40,
    maxElements: options.maxElements ?? 5000,
  };
  const crawling = options.crawl ?? false;
  if (crawling && options.scenarios !== undefined) {
    throw new Error("named scenarios cannot be combined with crawling");
  }
  const scenarios = options.scenarios === undefined
    ? undefined
    : prepareScenarios(options.url, options.scenarios);
  const maxPages = crawling ? (options.maxPages ?? DEFAULT_MAX_PAGES) : 1;
  const maxDepth = crawling ? (options.maxDepth ?? DEFAULT_MAX_DEPTH) : 0;
  assertIntegerLimit("maxPages", maxPages, 1, HARD_MAX_PAGES);
  assertIntegerLimit("maxDepth", maxDepth, 0, HARD_MAX_DEPTH);

  const targetPolicy = await createTargetPolicy({
    targetUrl: options.url,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  if (scenarios) {
    for (const scenario of scenarios) {
      await targetPolicy.assertUrl(scenario.url, "scenario URL");
      for (const step of scenario.steps) {
        if ("route" in step) await targetPolicy.assertUrl(step.route.url, "scenario route fixture");
      }
    }
  }

  options.signal?.throwIfAborted();
  const executablePath = await compatibleBrowserExecutablePath();
  const browser = await launchSandboxedChromium({
    executablePath,
    args: [...targetPolicy.chromiumArgs],
  });
  const cancel = (): void => { void browser.close().catch(() => {}); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  let pages: PageScanResult[] = [];
  try {
    if (scenarios) {
      for (let index = 0; index < scenarios.length; index += 1) {
        const scenario = scenarios[index]!;
        options.signal?.throwIfAborted();
        log(`[vqa] scenario ${index + 1}/${scenarios.length}: ${scenario.label}`);
        const page = await scanPage(browser, {
          ...resolved,
          url: scenario.url,
          viewports: options.viewports,
          adapter,
          log,
          pageIndex: index,
          crawling: false,
          scenario,
          targetPolicy,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        pages.push({
          url: page.finalUrl,
          depth: 0,
          status: "success",
          scenarioLabel: scenario.label,
          viewports: page.viewports,
          issues: page.issues,
        });
      }
    } else if (crawling) {
      const crawled = await crawlSameOrigin(
        options.url,
        { maxPages, maxDepth },
        async (url, depth, index, claimFinalUrl) => {
          options.signal?.throwIfAborted();
          log(`[vqa] page ${index + 1}/${maxPages} depth ${depth}: ${url}`);
          const value = await scanPage(browser, {
            ...resolved,
            url,
            viewports: options.viewports,
            adapter,
            log,
            pageIndex: index,
            crawling: true,
            claimFinalUrl,
            targetPolicy,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          return { value, hrefs: value.hrefs, finalUrl: value.finalUrl };
        },
      );
      pages = crawled.map((page) => {
        if (page.status === "failed") {
          log(`[vqa] page failed: ${page.url}: ${page.error}`);
          return page;
        }
        return {
          url: page.url,
          depth: page.depth,
          status: "success" as const,
          viewports: page.value.viewports,
          issues: page.value.issues,
        };
      });
    } else {
      options.signal?.throwIfAborted();
      log(`[vqa] page 1/1: ${options.url}`);
      const page = await scanPage(browser, {
        ...resolved,
        viewports: options.viewports,
        adapter,
        log,
        pageIndex: 0,
        crawling: false,
        targetPolicy,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      pages = [{
        url: page.finalUrl,
        depth: 0,
        status: "success",
        viewports: page.viewports,
        issues: page.issues,
      }];
    }
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await browser.close().catch(() => {});
  }

  options.signal?.throwIfAborted();

  const successfulPages = pages.filter((page) => page.status === "success");
  const viewports = successfulPages.flatMap((page) => page.viewports);
  const issues = successfulPages.flatMap((page) => page.issues);
  const groups = groupIssuesAcrossViewports(issues, viewports, options.url);

  const description = adapter.describe();
  const report: Report = {
    formatVersion: REPORT_FORMAT_VERSION,
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    schemaVersions: {
      report: REPORT_FORMAT_VERSION,
      manifest: REVIEW_MANIFEST_SCHEMA_VERSION,
      reviewState: REVIEW_STATE_SCHEMA_VERSION,
    },
    url: options.url,
    createdAt: new Date().toISOString(),
    adapter: { impl: description.impl, wired: description.wired },
    viewports,
    issues,
    groups,
    ...(scenarios ? { scenarios } : {}),
    pages,
  };

  if (options.baselineDir) {
    report.comparison = await compareRunCaptures(
      report,
      options.outDir,
      options.baselineDir,
    );
  }

  await writeFile(
    join(options.outDir, "issues.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    join(options.outDir, "agent-summary.json"),
    `${JSON.stringify(buildAgentSummary(report), null, 2)}\n`,
  );
  await writeFile(
    join(options.outDir, "contact-sheet.html"),
    renderContactSheetHtml(report),
  );
  await writeReviewArtifacts(report, options.outDir, renderReportHtml);
  return report;
}

export async function scan(options: ScanOptions): Promise<Report> {
  return withNewReportTransaction(options.outDir, (staging) =>
    scanInto({ ...options, outDir: staging }), options.signal ? { assertActive: () => options.signal!.throwIfAborted() } : undefined);
}
