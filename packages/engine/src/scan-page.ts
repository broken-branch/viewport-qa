import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Frame, Page } from "playwright";
import type {
  DetectedIssue,
  Issue,
  Rect,
  Scenario,
  Snapshot,
  ViewportResult,
  ViewportSpec,
} from "@vqa/contract";
import { runDetectors } from "@vqa/detectors";
import type { ModelAdapter } from "@vqa/model-adapter";
import {
  collectSnapshot,
  resolveSnapshotSemanticFingerprints,
} from "./collector.js";
import type { ClaimCrawlFinalUrl } from "./crawl.js";
import { dedupeIssues } from "./dedupe.js";
import { decorateDetectedIssue } from "./issue-semantics.js";
import { recommendFix } from "./recommend.js";
import { stableId } from "./review-manifest.js";
import {
  denyChildPages,
  denyDownloads,
  installChildPageTargetGuard,
  installRedirectGuard,
} from "./target-policy.js";
import type { TargetPolicy } from "./target-policy.js";
import {
  attemptedScenarioSteps,
  installScenarioRoutes,
  runScenarioSteps,
  scenarioArtifactName,
} from "./scenarios.js";
import type { ScenarioStepFailure } from "./scenarios.js";
import { capturePageBehaviour } from "./behaviour.js";

const CROP_PADDING = 12;
const MAX_CROP_DIM = 1600;

function clampCrop(
  rect: Rect,
  page: { scrollWidth: number; scrollHeight: number },
): Rect | undefined {
  const x = Math.max(0, rect.x - CROP_PADDING);
  const y = Math.max(0, rect.y - CROP_PADDING);
  const width = Math.min(
    rect.width + CROP_PADDING * 2,
    page.scrollWidth - x,
    MAX_CROP_DIM,
  );
  const height = Math.min(
    rect.height + CROP_PADDING * 2,
    page.scrollHeight - y,
    MAX_CROP_DIM,
  );
  if (width < 1 || height < 1) return undefined;
  return { x, y, width, height };
}

function scenarioStepFinding(
  scenario: Scenario,
  failure: ScenarioStepFailure,
  snapshot: Snapshot,
): DetectedIssue {
  const target = `${failure.role} named ${JSON.stringify(failure.name)}`;
  const missing = failure.reason === "target-not-found";
  const failureOutcome = missing
    ? `could not find ${target}`
    : `could not complete ${failure.kind} on ${target}`;
  return {
    type: "scenario-step",
    severity: "high",
    selector: `role=${failure.role}[name=${JSON.stringify(failure.name)}]`,
    semanticName: `${scenario.label} step ${failure.index + 1}`,
    elementFingerprint: `scenario-step:${failure.index}:${failure.kind}:${failure.role}:${failure.name}`,
    technicalLocator: `getByRole(${JSON.stringify(failure.role)}, { name: ${JSON.stringify(failure.name)} })`,
    confidence: "high",
    confidenceReasons: [missing
      ? "No element matched the named role and accessible name after one bounded attempt."
      : "The named element matched, but the requested action did not complete after one bounded attempt."],
    observedOutcome: `Scenario ${JSON.stringify(scenario.label)} stopped at step ${failure.index + 1} because it ${failureOutcome}.`,
    acceptanceCriterion: `The scenario can complete step ${failure.index + 1} using a visible, operable element with the named role and accessible name.`,
    description: `Scenario step ${failure.index + 1} (${failure.kind}) ${failureOutcome}.`,
    rect: {
      x: 0,
      y: 0,
      width: snapshot.page.viewportWidth,
      height: snapshot.page.viewportHeight,
    },
    heuristicSuggestion: {
      kind: "heuristic",
      text: "Update the recipe target or make the named control visible before this step.",
    },
  };
}

async function scanViewport(
  browser: Browser,
  options: {
    url: string;
    outDir: string;
    timeoutMs: number;
    maxCropsPerViewport: number;
    maxElements: number;
    artifactPrefix: string;
    discoverLinks: boolean;
    crawling: boolean;
    claimFinalUrl?: ClaimCrawlFinalUrl;
    targetPolicy: TargetPolicy;
    scenario?: Scenario;
    signal?: AbortSignal;
  },
  viewport: ViewportSpec,
  adapter: ModelAdapter,
  log: (line: string) => void,
): Promise<{
  result: ViewportResult;
  issues: Issue[];
  hrefs: string[];
  finalUrl: string;
}> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    acceptDownloads: false,
    serviceWorkers: "block",
    // A capture is one moment; ask the page for its settled state rather than
    // a frame of its entrance animation.
    reducedMotion: "reduce",
  });
  let page: Page | undefined;
  const offOriginNavigations: string[] = [];
  let offOriginUrl: (frame: Frame) => string | undefined = () => undefined;
  let assertNavigationHistory = (): void => {};
  let releaseChildPageTargetGuard = async (): Promise<void> => {};
  let releaseRedirectGuard = async (): Promise<void> => {};
  try {
    await options.targetPolicy.install(context);
    await denyChildPages(context, options.targetPolicy);
    page = await context.newPage();
    const behaviourCapture = await capturePageBehaviour(page, context);
    denyDownloads(page, options.targetPolicy);
    releaseChildPageTargetGuard = await installChildPageTargetGuard(page, options.targetPolicy);
    releaseRedirectGuard = await installRedirectGuard(page, options.targetPolicy);
    if (options.scenario) {
      await installScenarioRoutes(page, options.scenario, (message) => {
        options.targetPolicy.recordViolation(message);
      });
    }
    const originGuard = new URL(options.url).origin;
    offOriginUrl = (frame: Frame): string | undefined => {
      if (frame !== page?.mainFrame()) return undefined;
      const url = frame.url();
      if (!/^https?:/.test(url)) return undefined;
      try {
        return new URL(url).origin === originGuard ? undefined : url;
      } catch {
        return undefined;
      }
    };
    page.on("framenavigated", (frame) => {
      const url = offOriginUrl(frame);
      if (url !== undefined) offOriginNavigations.push(url);
    });
    assertNavigationHistory = () => {
      if (options.claimFinalUrl && offOriginNavigations.length > 0) {
        options.claimFinalUrl(offOriginNavigations[0]!);
      }
      if (options.scenario && offOriginNavigations.length > 0) {
        throw new Error(`scenario navigation left its origin: ${offOriginNavigations[0]}`);
      }
    };
    const response = await Promise.race([
      page.goto(options.url, { waitUntil: "load", timeout: options.timeoutMs }),
      options.targetPolicy.waitForViolation().then(() => options.targetPolicy.assertNoViolations()),
    ]);
    await options.targetPolicy.assertUrl(page.url(), "final navigation");
    let finalUrl = options.claimFinalUrl
      ? options.claimFinalUrl(page.url())
      : page.url();
    if (options.crawling && response && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    }
    const contentType = response?.headers()["content-type"]?.toLowerCase();
    if (
      options.crawling &&
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      throw new Error(`Non-HTML content type: ${contentType}`);
    }
    await page.waitForTimeout(250); // small settle for fonts/late layout
    await page.evaluate(async () => {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        }),
      ]);
    });
    await options.targetPolicy.assertUrl(page.url(), "client navigation");
    await settleForCapture(page, viewport.height);
    // Give immediate and timer-triggered download events a bounded chance to
    // surface before committing the transactional report. Arbitrarily late
    // page activity cannot be observed after the isolated context is closed.
    await page.waitForTimeout(250);
    options.targetPolicy.assertNoViolations();

    const scenarioFailure = options.scenario
      ? await runScenarioSteps(page, options.scenario, options.timeoutMs, async () => {
          await options.targetPolicy.assertUrl(page!.url(), "scenario navigation");
          assertNavigationHistory();
          options.targetPolicy.assertNoViolations();
        })
      : undefined;
    if (scenarioFailure) {
      log(
        `[vqa] scenario ${JSON.stringify(options.scenario!.label)} step ${scenarioFailure.index + 1} failed: ${scenarioFailure.detail}`,
      );
    }
    await options.targetPolicy.assertUrl(page.url(), "scenario navigation");
    const currentOrigin = new URL(page.url()).origin;
    if (options.scenario && currentOrigin !== new URL(options.scenario.url).origin) {
      throw new Error(`scenario navigation left its origin: ${page.url()}`);
    }
    options.targetPolicy.assertNoViolations();
    if (options.scenario) {
      // Scenario actions commonly schedule their observable effect on a short
      // timer. Bound the capture window while allowing that activity to land.
      await page.waitForTimeout(250);
      await options.targetPolicy.assertUrl(page.url(), "scenario navigation");
      if (new URL(page.url()).origin !== new URL(options.scenario.url).origin) {
        throw new Error(`scenario navigation left its origin: ${page.url()}`);
      }
      options.targetPolicy.assertNoViolations();
    }

    if (options.claimFinalUrl) finalUrl = options.claimFinalUrl(page.url());
    options.targetPolicy.assertNoViolations();
    const behaviourResult = await behaviourCapture.finish(finalUrl, {
      scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
      scrollHeight: await page.evaluate(() => document.documentElement.scrollHeight),
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
    const behaviourFindings = behaviourResult.issues;
    const snapshot: Snapshot = resolveSnapshotSemanticFingerprints(
      await page.evaluate(
        collectSnapshot,
        options.maxElements,
      ),
    );
    const hrefs = options.discoverLinks
      ? await page.locator("a[href]").evaluateAll((anchors) =>
          anchors
            .map((anchor) => anchor.getAttribute("href"))
            .filter((href): href is string => href !== null),
        )
      : [];
    if (options.claimFinalUrl) finalUrl = options.claimFinalUrl(page.url());
    const decorated = runDetectors(snapshot).map((issue) => decorateDetectedIssue(snapshot, issue));
    decorated.push(...behaviourFindings);
    if (options.scenario && scenarioFailure) {
      decorated.push(scenarioStepFinding(options.scenario, scenarioFailure, snapshot));
    }
    const { issues: detected, rawCount } = dedupeIssues(
      decorated,
    );
    log(
      `[vqa] ${options.scenario ? `${options.scenario.label} @ ` : ""}${viewport.label}: ${detected.length} unique issue(s) (${rawCount} raw hit(s))`,
    );

    assertNavigationHistory();
    const shotsDir = join(
      options.outDir,
      options.artifactPrefix,
      "screenshots",
      viewport.label,
    );
    await mkdir(shotsDir, { recursive: true });
    const viewportShotRel = `${options.artifactPrefix}screenshots/${viewport.label}/full.png`;
    await page.screenshot({
      path: join(options.outDir, viewportShotRel),
      fullPage: true,
    });

    const issues: Issue[] = [];
    let crops = 0;
    for (const issue of detected) {
      options.signal?.throwIfAborted();
      const id = stableId("issue", [
        finalUrl,
        viewport.width,
        viewport.height,
        viewport.deviceScaleFactor,
        options.scenario?.label ?? "",
        issue.type,
        issue.selector,
        issue.otherSelector ?? "",
        issue.rect,
        ...(issue.behaviour ? [issue.elementFingerprint ?? issue.description] : []),
      ]);
      let cropRel: string | undefined;
      if (crops < options.maxCropsPerViewport) {
        const clip = clampCrop(issue.rect, snapshot.page);
        if (clip) {
          cropRel = `${options.artifactPrefix}screenshots/${viewport.label}/${id}.png`;
          try {
            await page.screenshot({
              path: join(options.outDir, cropRel),
              clip,
              fullPage: true,
            });
            crops += 1;
          } catch (error) {
            log(
              `[vqa] crop failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            cropRel = undefined;
          }
        }
      }
      options.signal?.throwIfAborted();
      const aiRecommendation = issue.behaviour
        ? {
            status: "unavailable" as const,
            reason: "Browser behaviour findings are rule-based and are not sent to model adapters.",
          }
        : await recommendFix(adapter, issue, {
            url: finalUrl,
            viewport: viewport.label,
          });
      issues.push({
        ...issue,
        id,
        viewport: viewport.label,
        pageUrl: finalUrl,
        ...(options.scenario ? { scenarioLabel: options.scenario.label } : {}),
        screenshots: cropRel
          ? { viewport: viewportShotRel, crop: cropRel }
          : { viewport: viewportShotRel },
        aiRecommendation,
      });
    }

    if (options.claimFinalUrl) finalUrl = options.claimFinalUrl(page.url());
    assertNavigationHistory();
    options.targetPolicy.assertNoViolations();
    return {
      result: {
        pageUrl: finalUrl,
        ...(options.scenario ? { scenarioLabel: options.scenario.label } : {}),
        ...(options.scenario
          ? {
              scenarioSteps: attemptedScenarioSteps(options.scenario, scenarioFailure),
            }
          : {}),
        viewport,
        page: snapshot.page,
        screenshot: viewportShotRel,
        issueCount: issues.length,
        rawIssueCount: rawCount,
        behaviourCapture: behaviourResult.summary,
      },
      issues,
      hrefs,
      finalUrl,
    };
  } catch (error) {
    if (
      page &&
      options.claimFinalUrl &&
      offOriginNavigations.length === 0 &&
      error instanceof Error &&
      error.message.includes("Execution context was destroyed")
    ) {
      await page.waitForEvent("framenavigated", {
        predicate: (frame) => offOriginUrl(frame) !== undefined,
        timeout: 250,
      }).catch(() => {});
    }
    assertNavigationHistory();
    throw error;
  } finally {
    try {
      await releaseRedirectGuard();
    } finally {
      try {
        await context.close();
      } finally {
        await releaseChildPageTargetGuard();
      }
    }
    options.targetPolicy.assertNoViolations();
  }
}

/**
 * Bring the page to the state a person scrolling it would see: transitions
 * and animations land on their final frame, and one pass down the page fires
 * lazy images and scroll-triggered reveals. Bounded so a very long page still
 * captures in reasonable time.
 */
async function settleForCapture(page: Page, viewportHeight: number): Promise<void> {
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;transition-duration:1ms!important;transition-delay:0s!important;scroll-behavior:auto!important}",
  }).catch(() => {});
  const documentHeight = (): Promise<number> => page.evaluate(() => document.documentElement.scrollHeight);
  // A preloader or entrance sequence can hold the document at viewport height
  // for a moment after load. Wait for the height to stop changing, briefly.
  let height = await documentHeight();
  for (let stable = 0, polls = 0; stable < 2 && polls < 15; polls += 1) {
    await page.waitForTimeout(200);
    const next = await documentHeight();
    stable = next === height ? stable + 1 : 0;
    height = next;
  }
  const step = Math.max(200, Math.floor(viewportHeight * 0.8));
  const maxSteps = 40;
  // Two passes at most: the first can reveal lazy content that makes the page taller.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let offset = step, count = 0; offset < height && count < maxSteps; offset += step, count += 1) {
      await page.evaluate((y) => window.scrollTo(0, y), offset);
      await page.waitForTimeout(80);
    }
    const grown = await documentHeight();
    if (grown <= height * 1.1) break;
    height = grown;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

export async function scanPage(
  browser: Browser,
  options: {
    url: string;
    outDir: string;
    timeoutMs: number;
    maxCropsPerViewport: number;
    maxElements: number;
    viewports: ViewportSpec[];
    adapter: ModelAdapter;
    log: (line: string) => void;
    pageIndex: number;
    crawling: boolean;
    claimFinalUrl?: ClaimCrawlFinalUrl;
    targetPolicy: TargetPolicy;
    scenario?: Scenario;
    signal?: AbortSignal;
  },
): Promise<{
  viewports: ViewportResult[];
  issues: Issue[];
  hrefs: string[];
  finalUrl: string;
}> {
  const viewports: ViewportResult[] = [];
  const issues: Issue[] = [];
  let hrefs: string[] = [];
  let finalUrl = options.url;
  const pageNumber = String(options.pageIndex + 1).padStart(3, "0");
  const artifactPrefix = options.scenario
    ? `scenarios/${scenarioArtifactName(options.scenario.label)}/`
    : options.crawling ? `pages/${pageNumber}/` : "";
  for (let index = 0; index < options.viewports.length; index += 1) {
    options.log(`[vqa] capture ${index + 1}/${options.viewports.length}: ${options.viewports[index]!.label}`);
    const outcome = await scanViewport(
      browser,
      {
        url: options.url,
        outDir: options.outDir,
        timeoutMs: options.timeoutMs,
        maxCropsPerViewport: options.maxCropsPerViewport,
        maxElements: options.maxElements,
        artifactPrefix,
        discoverLinks: options.crawling && index === 0,
        crawling: options.crawling,
        ...(options.claimFinalUrl
          ? { claimFinalUrl: options.claimFinalUrl }
          : {}),
        targetPolicy: options.targetPolicy.fork(),
        ...(options.scenario ? { scenario: options.scenario } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.viewports[index]!,
      options.adapter,
      options.log,
    );
    viewports.push(outcome.result);
    issues.push(...outcome.issues);
    if (index === 0) {
      hrefs = outcome.hrefs;
      finalUrl = outcome.finalUrl;
    }
  }
  return { viewports, issues, hrefs, finalUrl };
}
