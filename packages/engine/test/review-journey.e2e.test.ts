import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { PRODUCT_VERSION, type Report, type ReviewManifest, type ReviewState } from "@vqa/contract";
import { renderReportHtml } from "../src/index.js";
import { captureBrowserLaunch } from "../../cli/test/helpers.js";

declare global { interface Window { vqaAuthorizedFetch(input: string, init?: RequestInit): Promise<Response>; } }

const BIN = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("fixtures/review-journey/", import.meta.url));
const REVIEW_WRITE_TIMEOUT = 10_000;
const PDF_WRITE_TIMEOUT = 30_000;

const report: Report = {
  formatVersion: "2",
  tool: "viewport-qa",
  toolVersion: PRODUCT_VERSION,
  schemaVersions: { report: "2", manifest: 1, reviewState: 2 },
  url: "https://northstar.example/",
  createdAt: "2026-08-20T20:14:04.000Z",
  adapter: { impl: "stub", wired: false },
  viewports: [],
  issues: [],
};

let reportDir: string;
let child: ChildProcess;
let baseUrl: string;
let requestHeaders: Record<string, string>;
let browser: Browser;
let browserLaunch: ReturnType<typeof captureBrowserLaunch>;

beforeAll(async () => {
  reportDir = mkdtempSync(join(tmpdir(), "vqa-review-journey-"));
  cpSync(FIXTURES, reportDir, { recursive: true });
  writeFileSync(join(reportDir, "issues.json"), `${JSON.stringify(report)}\n`);
  browserLaunch = captureBrowserLaunch();
  child = spawn(process.execPath, [BIN, "serve", reportDir, "--port", "0"], {
    env: browserLaunch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseUrl = await browserLaunch.waitForUrl(child);
  requestHeaders = { authorization: `VQA ${new URLSearchParams(new URL(baseUrl).hash.slice(1)).get("cap")!}` };
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exit = new Promise<void>((resolve) => { child!.once("close", () => resolve()); });
    const launch = new URL(baseUrl);
    await fetch(new URL("/api/stop", launch.origin), { method: "POST", headers: { ...requestHeaders, origin: launch.origin, "content-type": "application/json" }, body: "{}" });
    await exit;
  }
  browserLaunch?.cleanup();
  if (reportDir) rmSync(reportDir, { recursive: true, force: true });
});

/** Puts one issue in the export through the API so Export is available without driving the panel. */
async function seedExport(page: Page, issueId = "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED"): Promise<void> {
  const launch = new URL(baseUrl);
  const response = await page.request.post(new URL("api/review", launch.origin).href, {
    headers: { ...requestHeaders, origin: launch.origin, "content-type": "application/json" },
    data: { issueId, status: "export" },
  });
  expect(response.status()).toBe(200);
}

/** Opens one issue's panel from its row and expands the highlight editor. */
async function openIssuePanel(page: Page, coordinateId: string, title: string, touch = false): Promise<void> {
  const opener = page.locator(`[data-capture="${coordinateId}"] .issue-row`, { hasText: title }).locator(".issue-open");
  if (touch) await opener.tap(); else await opener.click();
  await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBe("");
  await expect
    .poll(() => page.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")))
    .toBe(false);
  const details = page.locator("#drawerBody details.issue-highlight");
  if (await details.count()) {
    await details.evaluate((element: HTMLDetailsElement) => { element.open = true; });
    await expect.poll(() => page.locator(".highlight-stage img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  }
}

describe("manifest-backed screenshot review journey", () => {
  it("composes presentation filters, hides internal vocabulary, and keeps screenshots color-accurate at 100 percent", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(baseUrl);
    await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
    expect(await page.locator("#zoomLabel").textContent()).toBe("100%");
    expect(await page.locator("header.topbar").textContent()).not.toContain("raw hits");
    expect(await page.locator("header.topbar").textContent()).not.toContain("adapter");
    expect(await page.getByText("Audit FAIL").count()).toBe(0);
    expect(await page.locator(".filters legend", { hasText: "State" }).count()).toBe(0);
    expect(await page.locator(".filters legend", { hasText: "Scenario" }).count()).toBe(0);
    expect(await page.getByText("Default", { exact: true }).count()).toBe(0);
    expect(await page.getByText("Alternate", { exact: true }).count()).toBe(0);
    expect(await page.locator("body").evaluate((body) => getComputedStyle(body).colorScheme)).toBe("dark");

    await page.locator('.filters input[data-facet="page"][value="page-checkout"]').uncheck();
    await page.locator('.filters input[data-facet="resolution"][value="1280 × 800"]').uncheck();
    await expect.poll(() => page.locator("[data-capture]").count()).toBe(2);

    await page.locator("#clearFilters").click();
    const desktopStage = page.locator(
      '[data-capture="page-home--state-default--1280x800"] .image-stage img',
    );
    expect(await desktopStage.evaluate((image) => image.getBoundingClientRect().width)).toBe(1280);
    expect(await desktopStage.evaluate((image) => getComputedStyle(image).filter)).toBe("none");
    const desktopOpen = await page
      .locator('[data-capture="page-home--state-default--1280x800"]')
      .getByRole("button", { name: "Open Image", exact: true })
      .boundingBox();
    expect(desktopOpen?.x).toBeGreaterThanOrEqual(0);
    expect((desktopOpen?.x ?? 0) + (desktopOpen?.width ?? 0)).toBeLessThanOrEqual(1440);
    await page.close();
  });

  it("keeps a decision retryable after a storage failure, persists it, and exports the selected issues", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(baseUrl);
    await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);

    // A quick action on a row decides without opening anything.
    const homeCard = page.locator('[data-capture="page-home--state-alternate--390x844"]');
    const homeRow = homeCard.locator(".issue-row", { hasText: "Primary action is hard to read" });
    await homeRow.getByRole("button", { name: /^Dismiss: / }).click();
    await expect.poll(() => homeRow.locator(".pill").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("Dismissed");

    // Opening a row shows that one issue: its close-up, finding, range, and actions.
    const checkoutCard = page.locator('[data-capture="page-checkout--state-alternate--390x844"]');
    const checkoutRow = checkoutCard.locator(".issue-row", { hasText: "Checkout total is clipped" });
    await checkoutRow.locator(".issue-open").click();
    await expect
      .poll(() => page.locator("#drawerTitle").evaluate((element) => element === document.activeElement))
      .toBe(true);
    expect(await page.locator("#drawerTitle").textContent()).toBe("Checkout total is clipped");
    expect(await page.locator("#drawerBody .issue-crop img").count()).toBe(1);
    expect(await page.locator("#drawerBody .issue-finding").textContent()).toBe("The order total does not fit in its available space.");
    expect(await page.locator("#drawerBody .issue-range").textContent()).toBe("At every size scanned (390 × 844, 1280 × 800).");
    expect(await page.getByRole("heading", { name: "Machine suggestions to promote" }).count()).toBe(0);
    const note = "Give the total enough width to show the full amount at this screen size.";
    await page.locator("#issueNote").fill(note);

    // A failed save keeps the note and offers a retry.
    await page.route("**/api/review", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced save failure" }),
      });
    });
    await page.locator("#addToExport").click();
    await expect.poll(() => page.locator("#saveError").textContent()).toContain("Could not save");
    expect(await page.locator("#issueNote").inputValue()).toBe(note);
    await page.unroute("**/api/review");
    await page.locator("#saveError").getByRole("button", { name: "Retry Connection" }).click();
    await expect.poll(() => page.locator("#storageError").getAttribute("hidden")).toBe("");
    await expect.poll(() => page.locator("#addToExport").isDisabled()).toBe(false);
    await page.locator("#addToExport").click();
    await expect.poll(() => page.locator("#addToExport").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("Remove from export");
    expect(await page.locator("#drawerBody .pill").textContent()).toBe("In export");
    expect(await page.locator("#issueNote").inputValue()).toBe(note);
    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => checkoutRow.locator(".pill").textContent()).toBe("In export");
    expect(await page.locator("#progress").textContent()).toBe("0 to review · 1 in export · 1 dismissed");

    await page.reload();
    await expect
      .poll(() => page.locator('[data-capture="page-checkout--state-alternate--390x844"] .issue-row .pill').first().textContent())
      .toBe("In export");
    const persisted = (await (
      await page.request.get(new URL("api/review", baseUrl).href, { headers: requestHeaders })
    ).json()) as ReviewState;
    expect(persisted.issues).toEqual({
      "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED": { status: "export", note, updated_at: expect.any(String) },
      "VQ-ISSUE-HOME-LOW-CONTRAST-CTA": { status: "dismissed", updated_at: expect.any(String) },
    });
    await checkoutRow.locator(".issue-open").click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBe("");
    expect(await page.locator("#issueNote").inputValue()).toBe(note);
    expect(await page.locator("#addToExport").textContent()).toBe("Remove from export");
    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();

    // Status filters apply to issues; screenshots without a matching issue drop out.
    await page.getByRole("button", { name: "Filter Screenshots" }).click();
    const screenCounts = page.locator("#drawer fieldset").filter({ hasText: "Screen size" }).locator(".count");
    const beforeCounts = await screenCounts.allTextContents();
    await page
      .locator('#drawer input[data-facet="status"][value="unreviewed"]')
      .uncheck();
    expect(await screenCounts.allTextContents()).not.toEqual(beforeCounts);
    await page.locator('#drawer input[data-facet="status"][value="dismissed"]').uncheck();
    await page.getByRole("button", { name: "Show Screenshots" }).click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => page.locator("[data-capture]").count()).toBe(2);

    const destination = join(reportDir, "browser-handoff.json");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator("#defaultHandoffPath").fill(destination);
    await page.getByRole("button", { name: "Done" }).click();
    await expect.poll(
      () => page.locator("#drawer").getAttribute("open"),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toBeNull();
    await page.getByRole("button", { name: "Open settings" }).click();
    expect(await page.locator("#defaultHandoffPath").inputValue()).toBe(destination);
    await page.getByRole("button", { name: "Done" }).click();
    await expect.poll(
      () => page.locator("#drawer").getAttribute("open"),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toBeNull();

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseUrl).origin,
    });
    const humanTextDestination = join(reportDir, "browser-handoff.txt");
    const humanPdfDestination = join(reportDir, "browser-handoff.pdf");
    await page.locator("#exportButton").click();
    expect(await page.locator("#drawer .export-list .export-item").count()).toBe(1);
    expect(await page.getByRole("group", { name: "Who will use this handoff?" }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole("group", { name: "How should it be delivered?" }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole("radio", { name: /Human/ }).isChecked()).toBe(true);
    expect(await page.getByRole("radio", { name: /Copy and paste/ }).isChecked()).toBe(true);
    expect(await page.getByRole("group", { name: "File format" }).isHidden()).toBe(true);
    await page.getByRole("button", { name: "Prepare Human Handoff to Copy and Paste" }).click();
    await expect
      .poll(() => page.locator("#exportResult").textContent(), { timeout: REVIEW_WRITE_TIMEOUT })
      .toContain("Human handoff generated for copy and paste. No file was saved.");
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(reportDir, "handoffs"))).toBe(false);
    const humanContent = await page.locator("#handoffOutput").inputValue();
    expect(humanContent).toContain("VIEWPORT QA HANDOFF");
    expect(humanContent).toContain("1. Checkout total is clipped");
    expect(humanContent).toContain(`Reviewer note: ${note}`);
    expect(humanContent).not.toContain("Primary action is hard to read");
    expect(humanContent).not.toMatch(/VQ-|audit|hash|policy|reason code|schema|format|version/iu);
    expect(humanContent).not.toMatch(/[#*_`]/u);
    expect(
      await page.locator("#handoffOutput").evaluate((output) => ({
        wraps: getComputedStyle(output).whiteSpace === "pre-wrap",
        fits: output.scrollWidth <= output.clientWidth + 1,
      })),
    ).toEqual({ wraps: true, fits: true });
    await page.getByRole("button", { name: "Copy Human Handoff" }).click();
    await expect.poll(() => page.locator("#handoffResultMessage").textContent()).toContain("copied");
    expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")).toBe(humanContent);

    await page.getByRole("radio", { name: /Save to file/ }).check();
    expect(await page.getByRole("group", { name: "File format" }).isVisible()).toBe(true);
    expect(await page.getByRole("radio", { name: /TXT/ }).isChecked()).toBe(true);
    expect(await page.locator("#handoffPath").inputValue()).toBe(humanTextDestination);
    await page.getByRole("button", { name: "Save Human TXT Handoff to File" }).click();
    await expect.poll(
      () => page.locator("#exportResult").textContent(),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toContain(humanTextDestination);
    expect(readFileSync(humanTextDestination, "utf8")).toBe(humanContent);

    await page.getByRole("radio", { name: /PDF/ }).check();
    expect(await page.locator("#handoffPath").inputValue()).toBe(humanPdfDestination);
    await page.getByRole("button", { name: "Save Human PDF Handoff to File" }).click();
    await expect.poll(
      () => page.locator("#exportResult").textContent(),
      { timeout: PDF_WRITE_TIMEOUT },
    ).toContain(humanPdfDestination);
    expect(readFileSync(humanPdfDestination).subarray(0, 5).toString()).toBe("%PDF-");

    await page.getByRole("radio", { name: /^AI/ }).check();
    expect(await page.getByRole("group", { name: "File format" }).isHidden()).toBe(true);
    expect(await page.locator("#handoffPath").inputValue()).toBe(destination);
    await page.getByRole("radio", { name: /Copy and paste/ }).check();
    await page.getByRole("button", { name: "Prepare AI Handoff to Copy and Paste" }).click();
    await expect.poll(
      () => page.locator("#handoffOutput").count(),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toBe(1);
    const canonicalContent = await page.locator("#handoffOutput").inputValue();
    const generated = JSON.parse(canonicalContent) as {
      items: Array<{ issue_id: string; occurrences: unknown[] }>;
    };
    expect(generated.items.map((item) => item.issue_id)).toEqual(["VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED"]);
    expect(generated.items[0]!.occurrences).toHaveLength(2);
    await page.getByRole("button", { name: "Copy AI Handoff" }).click();
    await expect.poll(() => page.locator("#handoffResultMessage").textContent()).toContain("copied");
    expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")).toBe(canonicalContent);

    await page.getByRole("radio", { name: /Save to file/ }).check();
    await page.locator("#handoffPath").fill("relative.json");
    await page.getByRole("radio", { name: /Human/ }).check();
    expect(await page.locator("#handoffPath").inputValue()).toBe("relative.json");
    await page.getByRole("radio", { name: /^AI/ }).check();
    expect(await page.locator("#handoffPath").inputValue()).toBe("relative.json");
    await page.getByRole("button", { name: "Save AI JSON Handoff to File" }).click();
    await expect.poll(
      () => page.locator("#saveError").textContent(),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toContain("absolute path");
    expect(existsSync(destination)).toBe(false);
    await page.getByRole("radio", { name: /Copy and paste/ }).check();
    expect(await page.locator("#saveError").count()).toBe(0);
    expect(await page.locator("#exportResult").textContent()).toBe("");
    await page.getByRole("radio", { name: /Save to file/ }).check();
    await page.getByRole("button", { name: "Save AI JSON Handoff to File" }).click();
    await expect.poll(
      () => page.locator("#saveError").textContent(),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toContain("absolute path");
    await page.locator("#handoffPath").fill(destination);
    await page.getByRole("button", { name: "Save AI JSON Handoff to File" }).click();
    await expect.poll(
      () => page.locator("#exportResult").textContent(),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toContain(destination);
    expect(await page.locator("#saveError").count()).toBe(0);
    expect(JSON.parse(readFileSync(destination, "utf8")).items[0].occurrences).toHaveLength(2);
    expect(readFileSync(destination, "utf8")).toBe(canonicalContent);
    await page.locator("#handoffPath").fill(join(reportDir, "wrong.txt"));
    await page.getByRole("button", { name: "Save AI JSON Handoff to File" }).click();
    await expect.poll(
      () => page.locator("#saveError").count(),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toBe(1);
    expect(await page.locator("#exportResult").textContent()).toBe("");
    await page.close();
  }, 90_000);

  it("supports touch decisions from rows and the panel, and a screenshot with no issues says so", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    const launch = new URL(baseUrl);
    await page.request.post(new URL("api/review", launch.origin).href, {
      headers: { ...requestHeaders, origin: launch.origin, "content-type": "application/json" },
      data: { issueId: "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED", status: "export" },
    });
    await page.goto(baseUrl);
    await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
    const card = page.locator('[data-capture="page-checkout--state-alternate--390x844"]');
    const row = card.locator(".issue-row", { hasText: "Checkout total is clipped" });
    await expect.poll(() => row.locator(".pill").textContent()).toBe("In export");
    await row.getByRole("button", { name: /^Remove from export: / }).tap();
    await expect.poll(() => row.locator(".pill").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("To review");
    await row.getByRole("button", { name: /^Dismiss: / }).tap();
    await expect.poll(() => row.locator(".pill").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("Dismissed");
    await row.getByRole("button", { name: /^Restore: / }).tap();
    await expect.poll(() => row.locator(".pill").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("To review");

    await row.locator(".issue-open").tap();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBe("");
    await page.locator("#addToExport").tap();
    await expect.poll(() => page.locator("#addToExport").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("Remove from export");
    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).tap();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    expect(await row.locator(".pill").textContent()).toBe("In export");

    const noIssueCard = page.locator('[data-capture="page-home--state-default--390x844"]');
    expect(await noIssueCard.locator(".capture-summary").textContent()).toBe("No issues found");
    expect(await noIssueCard.locator(".issue-row").count()).toBe(0);

    await page.locator("#exportButton").tap();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBe("");
    await expect
      .poll(() => page.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")))
      .toBe(false);
    const humanAudience = page.getByRole("radio", { name: /Human/ });
    const aiAudience = page.getByRole("radio", { name: /^AI/ });
    await aiAudience.focus();
    await expect.poll(() => aiAudience.evaluate((element) => element === document.activeElement)).toBe(true);
    await aiAudience.press("Space");
    await expect.poll(() => aiAudience.isChecked()).toBe(true);
    await humanAudience.tap();
    expect(await humanAudience.isChecked()).toBe(true);
    await page.getByRole("radio", { name: /Save to file/ }).tap();
    expect(await page.getByRole("group", { name: "File format" }).isVisible()).toBe(true);
    await page.getByRole("radio", { name: /PDF/ }).tap();
    expect(await page.locator("#handoffPath").inputValue()).toMatch(/\.pdf$/u);
    await context.close();
  }, 60_000);

  it("saves an optional note with a decision and keeps it across reopen", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(baseUrl);
    const issueCard = page.locator('[data-capture="page-home--state-alternate--390x844"]');
    const row = issueCard.locator(".issue-row", { hasText: "Primary action is hard to read" });
    await row.locator(".issue-open").click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBe("");
    expect(await page.getByLabel("Note for the handoff (optional)").count()).toBe(1);
    // No note is needed to decide.
    await page.locator("#addToExport").click();
    await expect.poll(() => page.locator("#addToExport").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("Remove from export");
    expect(await page.locator("#saveNote").isHidden()).toBe(true);
    // Editing the note on a decided issue reveals Save note; saving keeps the decision.
    await page.locator("#issueNote").fill("Make the primary action easier to read.");
    await expect.poll(() => page.locator("#saveNote").isHidden()).toBe(false);
    await page.locator("#saveNote").click();
    await expect.poll(() => page.locator("#saveNote").isHidden(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe(true);
    expect(await page.locator("#addToExport").textContent()).toBe("Remove from export");
    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await row.locator(".issue-open").click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBe("");
    expect(await page.locator("#issueNote").inputValue()).toBe("Make the primary action easier to read.");
    // Clearing the decision keeps nothing behind.
    await page.locator("#addToExport").click();
    await expect.poll(() => page.locator("#addToExport").textContent(), { timeout: REVIEW_WRITE_TIMEOUT }).toBe("Add to export");
    const persisted = (await (
      await page.request.get(new URL("api/review", baseUrl).href, { headers: requestHeaders })
    ).json()) as ReviewState;
    expect(persisted.issues["VQ-ISSUE-HOME-LOW-CONTRAST-CTA"]).toBeUndefined();
    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).click();
    await page.close();
  }, 60_000);

  it("soft-wraps Human copy-and-paste content at every supported width", async () => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      const page = await browser.newPage({ viewport });
      await seedExport(page);
      await page.goto(baseUrl);
      await expect.poll(() => page.locator("#exportButton").isDisabled()).toBe(false);
      await page.locator("#exportButton").click();
      await page.getByRole("button", { name: "Prepare Human Handoff to Copy and Paste" }).click();
      await expect.poll(
        () => page.locator("#handoffOutput").count(),
        { timeout: REVIEW_WRITE_TIMEOUT },
      ).toBe(1);
      expect(
        await page.locator("#handoffOutput").evaluate((output: HTMLTextAreaElement) => ({
          wrap: output.wrap,
          whiteSpace: getComputedStyle(output).whiteSpace,
          clientWidth: output.clientWidth,
          scrollWidth: output.scrollWidth,
          pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        })),
      ).toMatchObject({
        wrap: "soft",
        whiteSpace: "pre-wrap",
        pageFits: true,
      });
      const dimensions = await page
        .locator("#handoffOutput")
        .evaluate((output) => ({ clientWidth: output.clientWidth, scrollWidth: output.scrollWidth }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      await page.close();
    }
  }, 60_000);

  it("keeps a delayed handoff attempt in one mode and discards its response after close", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await seedExport(page);
    await page.goto(baseUrl);
    await expect.poll(() => page.locator("#exportButton").isDisabled()).toBe(false);
    await page.locator("#exportButton").click();

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve));
    await page.route("**/api/export", async (route) => {
      const response = await route.fetch();
      markFirstStarted();
      await firstGate;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Prepare Human Handoff to Copy and Paste" }).click();
    await firstStarted;
    expect(await page.locator("#exportResult").getAttribute("aria-busy")).toBe("true");
    expect(
      await page
        .getByRole("button", { name: "Preparing Human handoff to copy and paste…" })
        .isDisabled(),
    ).toBe(true);
    expect(await page.getByRole("radio", { name: /Copy and paste/ }).isDisabled()).toBe(true);
    expect(await page.getByRole("radio", { name: /Save to file/ }).isDisabled()).toBe(true);
    expect(await page.getByRole("radio", { name: /Human/ }).isDisabled()).toBe(true);
    expect(await page.getByRole("radio", { name: /^AI/ }).isDisabled()).toBe(true);
    expect(await page.locator("#handoffPath").isDisabled()).toBe(true);
    expect(await page.getByRole("radio", { name: /Copy and paste/ }).isChecked()).toBe(true);
    expect(await page.getByRole("radio", { name: /Save to file/ }).isChecked()).toBe(false);
    releaseFirst();
    await expect.poll(
      () => page.locator("#handoffOutput").count(),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toBe(1);
    expect(await page.getByRole("radio", { name: /Copy and paste/ }).isChecked()).toBe(true);
    expect(await page.getByRole("radio", { name: /Save to file/ }).isChecked()).toBe(false);
    expect(await page.locator("#exportResult").getAttribute("aria-busy")).toBeNull();
    await page.unroute("**/api/export");

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await page.locator("#exportButton").click();
    let releaseSecond!: () => void;
    let markSecondStarted!: () => void;
    let markSecondDelivered!: () => void;
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    const secondStarted = new Promise<void>((resolve) => (markSecondStarted = resolve));
    const secondDelivered = new Promise<void>((resolve) => (markSecondDelivered = resolve));
    await page.route("**/api/export", async (route) => {
      const response = await route.fetch();
      markSecondStarted();
      await secondGate;
      await route.fulfill({ response });
      markSecondDelivered();
    });
    await page.getByRole("button", { name: "Prepare Human Handoff to Copy and Paste" }).click();
    await secondStarted;
    expect(await page.locator("#liveRegion").textContent()).toBe(
      "Preparing Human handoff to copy and paste",
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    const announcementAfterClose = await page.locator("#liveRegion").textContent();
    releaseSecond();
    await secondDelivered;
    await page.waitForTimeout(50);
    expect(await page.locator("#handoffOutput").count()).toBe(0);
    expect(await page.locator("#exportResult").textContent()).toBe("");
    expect(await page.locator("#liveRegion").textContent()).toBe(announcementAfterClose);
    await page.unroute("**/api/export");
    await page.close();
  });

  it("supports keyboard drawer focus and a 390px layout without page overflow", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(baseUrl);
    const trigger = page
      .locator('[data-capture="page-home--state-alternate--390x844"]')
      .locator(".issue-row .issue-open").first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.locator("#drawerTitle").evaluate((element) => element === document.activeElement),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect
      .poll(() => trigger.evaluate((element) => element === document.activeElement))
      .toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.close();
  });

  it("opens full screenshots and issue crops in a modal natural-resolution lightbox", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(baseUrl);
    const card = page.locator('[data-capture="page-checkout--state-alternate--390x844"]');
    const opener = card.locator(".image-open");
    await expect.poll(() => page.locator(".capture > .canvas .image-open").count()).toBe(8);
    expect(await card.getByRole("button", { name: "Open Image", exact: true }).isVisible()).toBe(true);
    expect(await opener.getAttribute("aria-label")).toBe("Open Checkout / 390 × 844 screenshot");
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBe("");
    expect(await page.locator("#lightboxImage").getAttribute("alt")).toBe(
      "Checkout page, 390 × 844 screenshot",
    );
    await expect
      .poll(() =>
        page.locator("#lightboxImage").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(390);
    expect(
      await page.locator("#lightboxImage").evaluate((image: HTMLImageElement) => ({
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: image.getBoundingClientRect().width,
        filter: getComputedStyle(image).filter,
      })),
    ).toMatchObject({ naturalWidth: 390, naturalHeight: 844, filter: "none" });
    expect(
      await page.locator("#lightboxImage").evaluate((image) => image.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(390);
    expect(await page.locator("#openOriginal").getAttribute("data-asset-path")).toBe(
      "page-checkout--state-alternate--390x844.png",
    );
    expect(await page.locator("#openOriginal").getAttribute("href")).toBeNull();
    expect(await page.locator("#openOriginal").getAttribute("target")).toBe("_blank");
    expect(
      await page.evaluate(() => {
        document.getElementById("settingsButton")!.focus();
        return document.activeElement?.id;
      }),
    ).not.toBe("settingsButton");
    await page.locator("#lightboxViewport").focus();
    await page.keyboard.press("Tab");
    expect(
      await page.locator("#lightboxZoomOut").evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => opener.evaluate((element) => element === document.activeElement)).toBe(true);

    await card.locator(".issue-row", { hasText: "Checkout total is clipped" }).locator(".issue-open").click();
    const crop = page.getByRole("button", {
      name: "Open close-up of Checkout total is clipped",
    });
    await crop.tap();
    expect(await page.locator("#lightboxImage").getAttribute("alt")).toBe(
      "Close-up of Checkout total is clipped at 390 × 844",
    );
    await expect
      .poll(() =>
        page.locator("#lightboxImage").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => crop.evaluate((element) => element === document.activeElement)).toBe(true);
    await context.close();
  });

  it("shows issue-aware actions and persists padded, resizable, removable highlights", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(baseUrl);
    await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
    const issueCard = page.locator(
      '[data-capture="page-checkout--state-alternate--390x844"]',
    );
    const noIssueCard = page.locator('[data-capture="page-checkout--state-default--390x844"]');
    expect(await issueCard.getByRole("button", { name: "Open Image", exact: true }).count()).toBe(1);
    expect(await issueCard.locator(".issue-row").count()).toBe(1);
    expect(await issueCard.getByRole("button", { name: /^(Add to export|Remove from export): / }).count()).toBe(1);
    expect(await issueCard.getByRole("button", { name: /^(Dismiss|Restore): / }).count()).toBe(1);
    expect(await noIssueCard.getByRole("button", { name: "Open Image", exact: true }).count()).toBe(1);
    expect(await noIssueCard.locator(".issue-row").count()).toBe(0);
    expect(await noIssueCard.locator(".capture-summary").textContent()).toBe("No issues found");
    const marker = issueCard.locator(".issue-marker");
    expect(await marker.getAttribute("style")).toContain("left:20px;top:532px;width:350px;height:70px");
    expect(await marker.getAttribute("data-number")).toBe("1");
    const issueId = "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED";
    const coordinateId = "page-checkout--state-alternate--390x844";
    await openIssuePanel(page, coordinateId, "Checkout total is clipped", true);
    const savedRect = () =>
      page.evaluate(
        async ({ coordinateId, issueId }) =>
          (await (await window.vqaAuthorizedFetch("api/review")).json()).highlights[coordinateId]?.[issueId],
        { coordinateId, issueId },
      );
    const nextHighlightSave = async (expectedRect?: { x: number; y: number; width: number; height: number } | null) => {
      const response = await page.waitForResponse(
        (candidate) => {
          if (candidate.request().method() !== "POST" || new URL(candidate.url()).pathname !== "/api/review") return false;
          const body = candidate.request().postDataJSON() as { coordinateId?: string; highlightIssueId?: string; highlightRect?: unknown };
          return body.coordinateId === coordinateId &&
            body.highlightIssueId === issueId &&
            (expectedRect === undefined || JSON.stringify(body.highlightRect) === JSON.stringify(expectedRect));
        },
        { timeout: REVIEW_WRITE_TIMEOUT },
      );
      expect(await response.finished()).toBeNull();
      expect(response.ok()).toBe(true);
    };
    await expect
      .poll(() => page.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")))
      .toBe(false);
    let handle = page.getByRole("button", { name: "Resize highlight for Checkout total is clipped" });
    await handle.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
    await handle.focus();
    await expect.poll(() => handle.evaluate((element) => element === document.activeElement)).toBe(true);
    const scrollPosition = () =>
      page.evaluate(() => {
        const body = document.getElementById("drawerBody")!;
        const image = body.querySelector(".drawer-image")!;
        return {
          body: body.scrollTop,
          imageTop: image.scrollTop,
          imageLeft: image.scrollLeft,
          windowX: window.scrollX,
          windowY: window.scrollY,
        };
      });
    const stableScroll = await scrollPosition();
    for (const [key, expected] of [
      ["ArrowLeft", { x: 20, y: 532, width: 346, height: 70 }],
      ["ArrowDown", { x: 20, y: 532, width: 346, height: 74 }],
      ["ArrowRight", { x: 20, y: 532, width: 350, height: 74 }],
    ] as const) {
      handle = page.getByRole("button", { name: "Resize highlight for Checkout total is clipped" });
      const priorHandle = await handle.elementHandle();
      const save = nextHighlightSave(expected);
      await page.keyboard.press(key);
      await save;
      await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toMatchObject(expected);
      await expect.poll(() => priorHandle!.evaluate((element) => element.isConnected)).toBe(false);
      await expect
        .poll(() =>
          page
            .getByRole("button", { name: "Resize highlight for Checkout total is clipped" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      expect(await scrollPosition()).toEqual(stableScroll);
    }

    const delayedRequests: number[] = [];
    await page.route("**/api/review", async (route, request) => {
      if (request.method() !== "POST" || !request.postDataJSON().highlightIssueId) {
        await route.continue();
        return;
      }
      const position = delayedRequests.length;
      delayedRequests.push(position);
      await new Promise((resolve) => setTimeout(resolve, position === 0 ? 300 : 20));
      await route.continue();
    });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT })
      .toMatchObject({ x: 20, y: 532, width: 346, height: 78 });
    expect(delayedRequests).toEqual([0, 1]);
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "Resize highlight for Checkout total is clipped" })
          .evaluate((element) => element === document.activeElement),
      )
      .toBe(true);
    expect(await scrollPosition()).toEqual(stableScroll);
    await page.unroute("**/api/review");

    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).tap();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await page.reload();
    await openIssuePanel(page, "page-checkout--state-alternate--390x844", "Checkout total is clipped", true);
    await expect.poll(() => page.locator(".drawer-image img").getAttribute("src")).toMatch(/^blob:/u);
    expect(await page.locator(".highlight-editor").getAttribute("style")).toContain(
      "left:20px;top:532px;width:346px;height:78px",
    );

    handle = page.getByRole("button", { name: "Resize highlight for Checkout total is clipped" });
    await handle.scrollIntoViewIfNeeded();
    const handleBox = await handle.boundingBox();
    const mouseResizeHandle = await handle.elementHandle();
    await page.mouse.move(handleBox!.x + 22, handleBox!.y + 22);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + 34, handleBox!.y + 30);
    const mouseResizeSave = nextHighlightSave({ x: 20, y: 532, width: 358, height: 86 });
    await page.mouse.up();
    await mouseResizeSave;
    await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toMatchObject({ width: 358, height: 86 });
    await expect.poll(() => mouseResizeHandle!.evaluate((element) => element.isConnected)).toBe(false);

    handle = page.getByRole("button", { name: "Resize highlight for Checkout total is clipped" });
    await handle.scrollIntoViewIfNeeded();
    const touchBox = await handle.boundingBox();
    await handle.dispatchEvent("pointerdown", {
      pointerId: 23,
      pointerType: "touch",
      clientX: touchBox!.x + 22,
      clientY: touchBox!.y + 22,
    });
    await handle.dispatchEvent("pointermove", {
      pointerId: 23,
      pointerType: "touch",
      clientX: touchBox!.x + 14,
      clientY: touchBox!.y + 18,
    });
    const touchResizeHandle = await handle.elementHandle();
    const touchResizeSave = nextHighlightSave({ x: 20, y: 532, width: 350, height: 82 });
    await handle.dispatchEvent("pointerup", {
      pointerId: 23,
      pointerType: "touch",
      clientX: touchBox!.x + 14,
      clientY: touchBox!.y + 18,
    });
    await touchResizeSave;
    await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toMatchObject({ width: 350, height: 82 });
    await expect.poll(() => touchResizeHandle!.evaluate((element) => element.isConnected)).toBe(false);

    const removeControl = page.getByRole("button", { name: "Remove highlight for Checkout total is clipped" });
    const highlightControl = await removeControl.elementHandle();
    const removedEditor = await page.locator(".highlight-editor").elementHandle();
    const removeSave = nextHighlightSave(null);
    await removeControl.tap();
    await removeSave;
    await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toBeNull();
    await expect.poll(() => removedEditor!.evaluate((element) => element.isConnected)).toBe(false);
    expect(await page.locator(".highlight-editor").count()).toBe(0);
    await expect.poll(() => highlightControl!.getAttribute("aria-label")).toBe("Restore highlight for Checkout total is clipped");
    const restoredRect = { x: 20, y: 532, width: 350, height: 70 };
    const restoreSave = nextHighlightSave(restoredRect);
    await page.getByRole("button", { name: "Restore highlight for Checkout total is clipped" }).tap();
    await restoreSave;
    await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toEqual(restoredRect);
    await expect.poll(() => page.locator(".highlight-editor").count()).toBe(1);
    await expect.poll(() => highlightControl!.getAttribute("aria-label")).toBe("Remove highlight for Checkout total is clipped");
    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).tap();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await page.reload();
    await openIssuePanel(page, "page-checkout--state-alternate--390x844", "Checkout total is clipped", true);
    expect(await page.locator(".highlight-editor").getAttribute("style")).toContain(
      "left:20px;top:532px;width:350px;height:70px",
    );

    let mover = page.getByRole("button", {
      name: /Move highlight for Checkout total is clipped/u,
    });
    await mover.scrollIntoViewIfNeeded();
    let moverBox = await mover.boundingBox();
    const mouseMarker = await mover.elementHandle();
    await page.mouse.move(moverBox!.x + 40, moverBox!.y + 35);
    await page.mouse.down();
    await page.mouse.move(moverBox!.x + 52, moverBox!.y + 45);
    const mouseSave = nextHighlightSave();
    await page.mouse.up();
    await mouseSave;
    await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toMatchObject({ x: 32, y: 542, width: 350, height: 70 });
    await expect.poll(() => mouseMarker!.evaluate((element) => element.isConnected)).toBe(false);

    mover = page.getByRole("button", { name: /Move highlight for Checkout total is clipped/u });
    moverBox = await mover.boundingBox();
    const touchMarker = await mover.elementHandle();
    await mover.dispatchEvent("pointerdown", {
      pointerId: 31,
      pointerType: "touch",
      clientX: moverBox!.x + 40,
      clientY: moverBox!.y + 35,
    });
    await mover.dispatchEvent("pointermove", {
      pointerId: 31,
      pointerType: "touch",
      clientX: moverBox!.x + 33,
      clientY: moverBox!.y + 43,
    });
    const touchSave = nextHighlightSave();
    await mover.dispatchEvent("pointerup", {
      pointerId: 31,
      pointerType: "touch",
      clientX: moverBox!.x + 33,
      clientY: moverBox!.y + 43,
    });
    await touchSave;
    await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toMatchObject({ x: 25, y: 550, width: 350, height: 70 });
    await expect.poll(() => touchMarker!.evaluate((element) => element.isConnected)).toBe(false);

    mover = page.getByRole("button", { name: /Move highlight for Checkout total is clipped/u });
    await mover.focus();
    const moveScroll = await scrollPosition();
    for (const [key, expected] of [
      ["ArrowLeft", { x: 21, y: 550 }],
      ["ArrowUp", { x: 21, y: 546 }],
      ["Shift+ArrowRight", { x: 37, y: 546 }],
    ] as const) {
      mover = page.getByRole("button", { name: /Move highlight for Checkout total is clipped/u });
      const priorMarker = await mover.elementHandle();
      const save = nextHighlightSave();
      await page.keyboard.press(key);
      await save;
      await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toMatchObject({ ...expected, width: 350, height: 70 });
      await expect.poll(() => priorMarker!.evaluate((element) => element.isConnected)).toBe(false);
      await expect
        .poll(() =>
          page
            .getByRole("button", { name: /Move highlight for Checkout total is clipped/u })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      expect(await scrollPosition()).toEqual(moveScroll);
    }

    mover = page.getByRole("button", { name: /Move highlight for Checkout total is clipped/u });
    moverBox = await mover.boundingBox();
    await mover.dispatchEvent("pointerdown", {
      pointerId: 41,
      pointerType: "mouse",
      clientX: moverBox!.x + 40,
      clientY: moverBox!.y + 35,
    });
    await mover.dispatchEvent("pointermove", {
      pointerId: 41,
      pointerType: "mouse",
      clientX: moverBox!.x + 1040,
      clientY: moverBox!.y + 1035,
    });
    await mover.dispatchEvent("pointerup", {
      pointerId: 41,
      pointerType: "mouse",
      clientX: moverBox!.x + 1040,
      clientY: moverBox!.y + 1035,
    });
    await expect.poll(savedRect, { timeout: REVIEW_WRITE_TIMEOUT }).toEqual({ x: 40, y: 774, width: 350, height: 70 });
    await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).tap();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await page.reload();
    await openIssuePanel(page, "page-checkout--state-alternate--390x844", "Checkout total is clipped", true);
    expect(await page.locator(".highlight-editor").getAttribute("style")).toContain(
      "left:40px;top:774px;width:350px;height:70px",
    );
    mover = page.getByRole("button", { name: /Move highlight for Checkout total is clipped/u });
    await mover.click();
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBe("");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBeNull();
    mover = page.getByRole("button", { name: /Move highlight for Checkout total is clipped/u });
    await mover.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBe("");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBeNull();
    await context.close();
  }, 120_000);

  it("commits real touch highlight drags only on completion and reverts cancellation", async () => {
    const coordinateId = "page-checkout--state-alternate--390x844";
    const issueId = "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED";
    const initial = { x: 20, y: 532, width: 350, height: 70 };
    const moved = { x: 40, y: 548, width: 350, height: 70 };

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      const context = await browser.newContext({ viewport, hasTouch: true });
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      await page.goto(baseUrl);
      await expect.poll(() => page.evaluate(() => typeof window.vqaAuthorizedFetch)).toBe("function");
      await page.evaluate(
        async ({ coordinateId, issueId, initial }) => {
          await window.vqaAuthorizedFetch("api/review", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              coordinateId,
              classification: "bad",
              requestedChange: "Keep the highlighted total fully visible.",
              affectedCoordinateIds: [coordinateId],
              selectedIssueIds: [issueId],
            }),
          });
          await window.vqaAuthorizedFetch("api/review", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              coordinateId,
              highlightIssueId: issueId,
              highlightRect: initial,
            }),
          });
        },
        { coordinateId, issueId, initial },
      );
      await page.reload();
      await openIssuePanel(page, coordinateId, "Checkout total is clipped", true);

      const savedRect = () =>
        page.evaluate(
          async ({ coordinateId, issueId }) =>
            (await (await window.vqaAuthorizedFetch("api/review")).json()).highlights[coordinateId]?.[issueId],
          { coordinateId, issueId },
        );
      const mover = page.getByRole("button", {
        name: /Move highlight for Checkout total is clipped/u,
      });
      await page.locator(".drawer-image").evaluate((element) => {
        element.scrollIntoView({ block: "center" });
        element.scrollTop = 400;
        element.scrollLeft = 0;
      });
      expect(await mover.evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");
      expect(
        await page.locator(".highlight-resize").evaluate((element) => getComputedStyle(element).touchAction),
      ).toBe("none");
      expect(
        await page.locator(".highlight-stage img").evaluate((image: HTMLImageElement) =>
          image.getBoundingClientRect().width / image.naturalWidth,
        ),
      ).toBe(1);

      const scrollPosition = () =>
        page.evaluate(() => {
          const body = document.getElementById("drawerBody")!;
          const image = body.querySelector(".drawer-image")!;
          return {
            bodyTop: body.scrollTop,
            imageTop: image.scrollTop,
            imageLeft: image.scrollLeft,
            windowX: window.scrollX,
            windowY: window.scrollY,
          };
        });
      const dispatchTouch = async (
        type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
        x?: number,
        y?: number,
      ) => {
        await session.send("Input.dispatchTouchEvent", {
          type,
          touchPoints:
            x === undefined || y === undefined
              ? []
              : [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
        });
      };

      let box = await mover.boundingBox();
      const start = { x: box!.x + 40, y: box!.y + 35 };
      expect(
        await page.evaluate(
          ({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.className,
          start,
        ),
        `touch starts on the move surface at ${viewport.width}px (${JSON.stringify(box)})`,
      ).toBe("highlight-editor");
      const beforeMove = await scrollPosition();
      await dispatchTouch("touchStart", start.x, start.y);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", start.x + 20, start.y + 16);
      await page.waitForTimeout(32);
      await dispatchTouch("touchEnd");
      await expect.poll(savedRect, {
        message: `touch drag persists at ${viewport.width}px`,
        timeout: REVIEW_WRITE_TIMEOUT,
      }).toEqual(moved);
      expect(await scrollPosition()).toEqual(beforeMove);

      await expect.poll(() => mover.getAttribute("style")).toContain(
        "left:40px;top:548px;width:350px;height:70px",
      );
      box = await mover.boundingBox();
      const cancelStart = { x: box!.x + 40, y: box!.y + 35 };
      const beforeCancel = await scrollPosition();
      let highlightPosts = 0;
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith("/api/review") &&
          request.postDataJSON()?.highlightIssueId === issueId
        ) {
          highlightPosts += 1;
        }
      });
      await mover.evaluate((element) => {
        (window as typeof window & { highlightCancelCount?: number }).highlightCancelCount = 0;
        element.addEventListener(
          "pointercancel",
          () => {
            (window as typeof window & { highlightCancelCount: number }).highlightCancelCount += 1;
          },
          { once: true },
        );
      });
      await dispatchTouch("touchStart", cancelStart.x, cancelStart.y);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", cancelStart.x - 14, cancelStart.y + 12);
      await page.waitForTimeout(32);
      await dispatchTouch("touchCancel");
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { highlightCancelCount?: number }).highlightCancelCount,
          ),
        )
        .toBe(1);
      await page.waitForTimeout(100);
      expect(highlightPosts).toBe(0);
      expect(await mover.getAttribute("style")).toContain(
        "left:40px;top:548px;width:350px;height:70px",
      );
      expect(await savedRect()).toEqual(moved);
      expect(await scrollPosition()).toEqual(beforeCancel);

      await page.locator("#drawerActions").getByRole("button", { name: "Close", exact: true }).tap();
      await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
      await page.reload();
      await openIssuePanel(page, coordinateId, "Checkout total is clipped", true);
      await expect.poll(() => page.locator(".highlight-editor").getAttribute("style")).toContain(
        "left:40px;top:548px;width:350px;height:70px",
      );

      const exported = await page.evaluate(async (issueId) => {
        await window.vqaAuthorizedFetch("api/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ issueId, status: "export" }),
        });
        const response = await window.vqaAuthorizedFetch("api/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "generate", audience: "ai" }),
        });
        return JSON.parse((await response.json()).content);
      }, issueId);
      const exportedOccurrence = exported.items
        .find((item: { issue_id: string }) => item.issue_id === issueId)
        .occurrences.find((occurrence: { coordinate_id: string }) => occurrence.coordinate_id === coordinateId);
      expect(exportedOccurrence.highlight_rect).toEqual(moved);
      await page.evaluate(async (issueId) => {
        await window.vqaAuthorizedFetch("api/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ issueId, status: null }),
        });
      }, issueId);
      await context.close();
    }
  }, 120_000);

  it("presents focused Settings with aligned SVG controls and a safe animated lifecycle", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseUrl,
    });
    await page.goto(baseUrl);
    expect(
      await page.getByText(
        "Check each page at the captured sizes. Mark what looks right and describe what needs to change.",
        { exact: true },
      ).count(),
    ).toBe(0);
    const settings = page.getByRole("button", { name: "Open settings" });
    const settingsBox = await settings.boundingBox();
    expect(settingsBox).toMatchObject({ width: 44, height: 44 });
    await settings.click();
    await expect
      .poll(() => page.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")))
      .toBe(false);
    expect(await page.locator("#drawerTitle").textContent()).toBe("Settings");
    expect(await page.getByRole("heading", { name: "Review run" }).isVisible()).toBe(true);
    expect(await page.getByRole("heading", { name: "Files and storage" }).isVisible()).toBe(true);
    expect(await page.getByText("review-state.json in this report directory", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText(/Decisions and exports stay on this machine/u).isVisible()).toBe(true);
    const technical = page.locator("details.settings-technical");
    expect(await technical.getAttribute("open")).toBeNull();
    expect(await page.getByText("Technical details", { exact: true }).isVisible()).toBe(true);
    await technical.locator("summary").click();
    expect(await page.getByText("Source commit", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText(report.createdAt, { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Copy source URL" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Copy source commit" }).click();
    const expectedSourceSha = (JSON.parse(
      readFileSync(join(reportDir, "review-manifest.json"), "utf8"),
    ) as ReviewManifest).source_report.source_sha;
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedSourceSha);
    expect(await page.getByRole("button", { name: "Done" }).count()).toBe(1);
    expect(await page.getByText("Audit result", { exact: true }).count()).toBe(0);
    expect(await page.getByText("Policy ID", { exact: true }).count()).toBe(0);
    expect(await page.getByText("Reason codes", { exact: true }).count()).toBe(0);
    const close = page.getByRole("button", { name: "Close panel" });
    await expect
      .poll(async () => {
        const box = await close.boundingBox();
        return 1280 - ((box?.x ?? 0) + (box?.width ?? 0));
      })
      .toBe(20);
    const closeBox = await close.boundingBox();
    expect(closeBox).toMatchObject({ width: 44, height: 44 });
    expect(Math.abs((closeBox?.y ?? 0) - (settingsBox?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(1280 - ((closeBox?.x ?? 0) + (closeBox?.width ?? 0))).toBe(
      1280 - ((settingsBox?.x ?? 0) + (settingsBox?.width ?? 0)),
    );
    expect(await close.locator("svg").boundingBox()).toMatchObject({ width: 20, height: 20 });
    expect(await settings.locator("svg").boundingBox()).toMatchObject({ width: 20, height: 20 });
    expect(await page.locator("#drawer").evaluate((drawer) => getComputedStyle(drawer).transitionDuration)).not.toBe("0s");
    expect(await page.locator("#drawer").evaluate((drawer) => getComputedStyle(drawer, "::backdrop").transitionDuration)).not.toBe("0s");
    expect(
      await page.evaluate(() => {
        document.getElementById("settingsButton")!.focus();
        return document.activeElement?.id;
      }),
    ).not.toBe("settingsButton");
    await close.click();
    expect(await page.locator("#drawer").getAttribute("open")).toBe("");
    expect(await page.locator("#drawer").getAttribute("class")).toContain("closing");
    await expect.poll(() => settings.evaluate((element) => element === document.activeElement)).toBe(true);

    await settings.click();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => settings.evaluate((element) => element === document.activeElement)).toBe(true);

    let releaseSettingsSave!: () => void;
    let markSettingsSaveStarted!: () => void;
    const settingsSaveGate = new Promise<void>((resolvePromise) => { releaseSettingsSave = resolvePromise; });
    const settingsSaveStarted = new Promise<void>((resolvePromise) => { markSettingsSaveStarted = resolvePromise; });
    await page.route("**/api/settings", async (route) => {
      markSettingsSaveStarted();
      await settingsSaveGate;
      await route.continue();
    });
    await settings.click();
    await page.getByRole("button", { name: "Done" }).click();
    await settingsSaveStarted;
    try {
      expect(await page.locator("#drawer").getAttribute("open")).toBe("");
    } finally {
      releaseSettingsSave();
    }
    await expect.poll(
      () => page.locator("#drawer").getAttribute("open"),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toBeNull();
    await page.unroute("**/api/settings");
    await expect.poll(() => settings.evaluate((element) => element === document.activeElement)).toBe(true);

    await settings.click();
    await close.click();
    await page.evaluate(() => {
      const target = document.getElementById("settingsButton")!;
      (window as unknown as { openSettings: (trigger: HTMLElement) => void }).openSettings(target);
    });
    expect(await page.locator("#drawer").getAttribute("open")).toBe("");
    expect(await page.locator("#drawer").getAttribute("class")).not.toContain("closing");
    await page.getByRole("button", { name: "Done" }).click();
    await expect.poll(
      () => page.locator("#drawer").getAttribute("open"),
      { timeout: REVIEW_WRITE_TIMEOUT },
    ).toBeNull();
    await page.close();
  }, 60_000);

  it("dismisses Settings from the backdrop without dismissing panel interactions", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(baseUrl);
    const settings = page.getByRole("button", { name: "Open settings" });
    await settings.click();
    await expect
      .poll(() => page.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")))
      .toBe(false);

    await page.locator(".drawer-head").click({ position: { x: 8, y: 8 } });
    await page.locator("#defaultHandoffPath").click();
    await page.locator("#drawerBody").click({ position: { x: 8, y: 8 } });
    await page.locator("#drawerActions").click({ position: { x: 8, y: 8 } });
    expect(await page.locator("#drawer").getAttribute("open")).toBe("");

    await page.mouse.click(100, 400);
    expect(await page.locator("#drawer").getAttribute("class")).toContain("closing");
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => settings.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  it("dismisses Settings with a touch tap on the backdrop", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
    });
    await page.goto(baseUrl);
    const settings = page.getByRole("button", { name: "Open settings" });
    await settings.tap();
    await expect
      .poll(() => page.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")))
      .toBe(false);
    await page.touchscreen.tap(100, 400);
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => settings.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  it("dismisses every dimming surface from its backdrop without saving inside work", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(baseUrl);
    await expect.poll(() => page.locator("[data-capture]").count()).toBe(8);
    const card = page.locator('[data-capture="page-checkout--state-alternate--390x844"]');
    const reviewTrigger = card.locator(".issue-row", { hasText: "Checkout total is clipped" }).locator(".issue-open");
    const issueId = "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED";
    const before = await page.evaluate(
      async (id) => (await (await window.vqaAuthorizedFetch("api/review")).json()).issues[id],
      issueId,
    );
    await reviewTrigger.click();
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBe("");
    await page.locator("#issueNote").fill("This must remain unsaved.");
    await page.locator(".drawer-head").click({ position: { x: 8, y: 8 } });
    await page.locator("#drawerBody").click({ position: { x: 8, y: 8 } });
    await page.locator("#drawerActions").click({ position: { x: 8, y: 8 } });
    expect(await page.locator("#drawer").getAttribute("open")).toBe("");
    await page.mouse.click(100, 400);
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => reviewTrigger.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(
      await page.evaluate(
        async (id) => (await (await window.vqaAuthorizedFetch("api/review")).json()).issues[id],
        issueId,
      ),
    ).toEqual(before);

    const exportButton = page.locator("#exportButton");
    await exportButton.evaluate((button: HTMLButtonElement) => (button.disabled = false));
    await exportButton.click();
    await page.locator("#drawerBody").click({ position: { x: 8, y: 8 } });
    expect(await page.locator("#drawer").getAttribute("open")).toBe("");
    await page.mouse.click(100, 400);
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => exportButton.evaluate((element) => element === document.activeElement)).toBe(true);

    const imageOpener = card.locator(".canvas .image-open");
    await imageOpener.click();
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBe("");
    await page.locator(".lightbox-head").click({ position: { x: 4, y: 4 } });
    await page.locator("#lightboxViewport").click({ position: { x: 4, y: 4 } });
    expect(await page.locator("#lightbox").getAttribute("open")).toBe("");
    await page.mouse.click(2, 2);
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBeNull();
    await expect.poll(() => imageOpener.evaluate((element) => element === document.activeElement)).toBe(true);

    await openIssuePanel(page, "page-checkout--state-alternate--390x844", "Checkout total is clipped");
    const nestedOpener = page.locator("#drawerBody .drawer-image .image-open").first();
    await nestedOpener.click();
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBe("");
    await page.mouse.click(2, 2);
    await expect.poll(() => page.locator("#lightbox").getAttribute("open")).toBeNull();
    expect(await page.locator("#drawer").getAttribute("open")).toBe("");
    await page.mouse.click(100, 400);
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await page.close();

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      const mobile = await browser.newPage({ viewport, hasTouch: true });
      await mobile.goto(baseUrl);
      const filter = mobile.getByRole("button", { name: "Filter Screenshots" });
      await filter.tap();
      await expect
        .poll(() => mobile.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")))
        .toBe(false);
      await mobile.locator(".drawer-head").tap({ position: { x: 8, y: 8 } });
      expect(await mobile.locator("#drawer").getAttribute("open")).toBe("");
      await mobile.touchscreen.tap(4, Math.round(viewport.height / 2));
      await expect.poll(() => mobile.locator("#drawer").getAttribute("open")).toBeNull();
      await expect.poll(() => filter.evaluate((element) => element === document.activeElement)).toBe(true);

      const mobileImage = mobile.locator('[data-capture="page-home--state-default--390x844"] .canvas .image-open');
      await mobileImage.tap();
      await expect.poll(() => mobile.locator("#lightbox").getAttribute("open")).toBe("");
      await mobile.locator(".lightbox-head").tap({ position: { x: 4, y: 4 } });
      expect(await mobile.locator("#lightbox").getAttribute("open")).toBe("");
      await mobile.touchscreen.tap(2, 2);
      await expect.poll(() => mobile.locator("#lightbox").getAttribute("open")).toBeNull();
      await expect.poll(() => mobileImage.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(
        await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await mobile.close();
    }
  });

  it("distinguishes Fit to view from Actual size with accurate per-image geometry", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
    await page.goto(baseUrl);
    const narrow = page.locator('[data-capture="page-home--state-default--390x844"]');
    const wide = page.locator('[data-capture="page-home--state-default--1280x800"]');
    const narrowStage = narrow.locator(".image-stage");
    const wideStage = wide.locator(".image-stage");

    expect(await page.getByRole("button", { name: "Actual size", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(Number(await narrowStage.getAttribute("data-zoom-scale"))).toBe(1);
    expect(Number(await wideStage.getAttribute("data-zoom-scale"))).toBe(1);
    await page.getByRole("button", { name: "Fit to view", exact: true }).click();
    expect(await page.locator("#zoomLabel").textContent()).toBe("Fit mode");
    expect(await page.locator("#zoomFit").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("#zoomActual").getAttribute("aria-pressed")).toBe("false");
    // Fit fills the width: the phone capture grows on a wide screen, the desktop capture shrinks.
    const narrowFit = Number(await narrowStage.getAttribute("data-zoom-scale"));
    expect(narrowFit).toBeGreaterThan(1);
    expect(narrowFit).toBeLessThanOrEqual(3);
    expect(Math.round((await narrowStage.locator("img").boundingBox())!.width)).toBe(Math.round(390 * narrowFit));
    expect(Number(await wideStage.getAttribute("data-zoom-scale"))).toBeLessThan(1);
    expect(await narrow.locator(".canvas").getAttribute("aria-label")).toContain(
      `Fit to view at ${Math.round(narrowFit * 100)}%`,
    );

    await page.locator("#zoomActual").click();
    expect(await page.locator("#zoomLabel").textContent()).toBe("100%");
    expect(Math.round((await wideStage.locator("img").boundingBox())!.width)).toBe(1280);
    expect(
      await wide.locator(".canvas").evaluate((canvas) => canvas.scrollWidth > canvas.clientWidth),
    ).toBe(true);
    await page.locator("#zoomIn").click();
    expect(await page.locator("#zoomLabel").textContent()).toBe("125%");
    expect(Math.round((await wideStage.locator("img").boundingBox())!.width)).toBe(1600);

    await narrow.getByRole("button", { name: "Open Image", exact: true }).click();
    await expect
      .poll(() => page.locator("#lightboxImage").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(390);
    await expect.poll(() => page.locator("#lightboxZoomLabel").textContent()).toBe(
      "Fits at actual size · 100%",
    );
    expect(await page.locator("#lightboxFit").isDisabled()).toBe(true);
    expect(await page.locator("#lightboxActual").getAttribute("aria-pressed")).toBe("true");
    expect(Math.round((await page.locator("#lightboxImage").boundingBox())!.width)).toBe(390);
    await page.keyboard.press("Escape");
    await page.close();

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      const mobile = await browser.newPage({ viewport });
      await mobile.goto(baseUrl);
      const mobileWide = mobile.locator('[data-capture="page-home--state-default--1280x800"]');
      const mobileNarrow = mobile.locator('[data-capture="page-home--state-default--390x844"]');
      await mobile.locator("#zoomFit").click();
      expect(Number(await mobileWide.locator(".image-stage").getAttribute("data-zoom-scale"))).toBeLessThan(1);
      expect(Number(await mobileNarrow.locator(".image-stage").getAttribute("data-zoom-scale"))).toBeLessThan(1);
      expect((await mobileWide.locator(".image-stage img").boundingBox())!.width).toBeLessThanOrEqual(
        (await mobileWide.locator(".canvas").boundingBox())!.width,
      );
      await mobile.locator("#zoomActual").click();
      expect(Math.round((await mobileWide.locator(".image-stage img").boundingBox())!.width)).toBe(1280);
      expect(
        await mobileWide.locator(".canvas").evaluate((canvas) => canvas.scrollWidth > canvas.clientWidth),
      ).toBe(true);

      await mobileWide.getByRole("button", { name: "Open Image", exact: true }).click();
      await expect
        .poll(() => mobile.locator("#lightboxImage").evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBe(1280);
      await expect.poll(() => mobile.locator("#lightboxFit").getAttribute("aria-pressed")).toBe("true");
      expect(await mobile.locator("#lightboxActual").getAttribute("aria-pressed")).toBe("false");
      expect(await mobile.locator("#lightboxZoomLabel").textContent()).toMatch(/^Fit to view · \d+%$/u);
      const fitImage = await mobile.locator("#lightboxImage").boundingBox();
      const imageViewport = await mobile.locator("#lightboxViewport").boundingBox();
      expect(fitImage!.width).toBeLessThanOrEqual(imageViewport!.width);
      expect(fitImage!.height).toBeLessThanOrEqual(imageViewport!.height);

      await mobile.locator("#lightboxActual").click();
      expect(await mobile.locator("#lightboxZoomLabel").textContent()).toBe("Actual size · 100%");
      expect(Math.round((await mobile.locator("#lightboxImage").boundingBox())!.width)).toBe(1280);
      expect(
        await mobile.locator("#lightboxViewport").evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
      await mobile.locator("#lightboxZoomIn").click();
      expect(Math.round((await mobile.locator("#lightboxImage").boundingBox())!.width)).toBe(1600);
      await mobile.locator("#lightboxFit").click();
      expect(await mobile.locator("#lightboxFit").getAttribute("aria-pressed")).toBe("true");
      expect(
        await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await mobile.keyboard.press("Escape");
      await mobile.close();
    }
  });

  it("effectively disables Settings motion when reduced motion is requested", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(baseUrl);
    const settings = page.getByRole("button", { name: "Open settings" });
    await settings.click();
    expect(
      await page.locator("#drawer").evaluate((drawer) => getComputedStyle(drawer).transitionDuration),
    ).toBe("0s");
    await page.mouse.click(100, 400);
    await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
    await expect.poll(() => settings.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  it("shows Scenario only for multiple concrete user-facing conditions", async () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES, "review-manifest.json"), "utf8"),
    ) as ReviewManifest;
    manifest.states[0]!.label = "Empty cart";
    manifest.states[1]!.label = "With items";
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(renderReportHtml(report, manifest));
    await expect.poll(() => page.locator(".filters legend", { hasText: "Scenario" }).count()).toBe(1);
    expect(await page.getByText("Empty cart", { exact: true }).first().isVisible()).toBe(true);
    expect(await page.getByText("With items", { exact: true }).first().isVisible()).toBe(true);
    expect(await page.locator(".capture-title").first().textContent()).toContain("Empty cart");
    await page.close();
  });

  it("labels a normal source checkout truthfully when no commit identity is available", async () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES, "review-manifest.json"), "utf8"),
    ) as ReviewManifest;
    manifest.source_report.source_sha = "source-checkout";
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(renderReportHtml(report, manifest));
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator("details.settings-technical summary").click();
    expect(await page.getByText("Source build", { exact: true }).isVisible()).toBe(true);
    expect(
      await page.getByText("Source checkout (commit unavailable)", { exact: true }).isVisible(),
    ).toBe(true);
    expect(await page.getByText("Source commit", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Copy source commit" }).count()).toBe(0);
    await page.close();
  });

  it("has no horizontal page overflow or clipped controls at 390px and 320px", async () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.goto(baseUrl);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const settingsControl = page.getByRole("button", { name: "Open settings" });
      const settings = await settingsControl.boundingBox();
      expect(settings?.x).toBeGreaterThanOrEqual(0);
      expect((settings?.x ?? 0) + (settings?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
      await settingsControl.click();
      await expect
        .poll(() =>
          page.locator("#drawer").evaluate((drawer) => drawer.classList.contains("opening")),
        )
        .toBe(false);
      expect(await page.getByRole("heading", { name: "Review run" }).isVisible()).toBe(true);
      expect(await page.getByRole("heading", { name: "Files and storage" }).isVisible()).toBe(true);
      expect(await page.locator("details.settings-technical").getAttribute("open")).toBeNull();
      expect(
        await page.locator("#drawer").evaluate((drawer) => drawer.scrollWidth <= drawer.clientWidth),
      ).toBe(true);
      await expect
        .poll(async () => {
          const box = await page.getByRole("button", { name: "Close panel" }).boundingBox();
          return viewport.width - ((box?.x ?? 0) + (box?.width ?? 0));
        })
        .toBe(viewport.width - ((settings?.x ?? 0) + (settings?.width ?? 0)));
      const settledSettingsClose = await page
        .getByRole("button", { name: "Close panel" })
        .boundingBox();
      expect(settledSettingsClose).toMatchObject({ width: 44, height: 44 });
      expect(
        Math.abs((settledSettingsClose?.y ?? 0) - (settings?.y ?? 0)),
      ).toBeLessThanOrEqual(1);
      expect(
        viewport.width -
          ((settledSettingsClose?.x ?? 0) + (settledSettingsClose?.width ?? 0)),
      ).toBe(viewport.width - ((settings?.x ?? 0) + (settings?.width ?? 0)));
      await page.getByRole("button", { name: "Close panel" }).click();
      await expect.poll(() => page.locator("#drawer").getAttribute("open")).toBeNull();
      await page.getByRole("button", { name: "Filter Screenshots" }).click();
      const close = await page.getByRole("button", { name: "Close panel" }).boundingBox();
      expect(close).toMatchObject({ width: 44, height: 44 });
      expect(await page.getByRole("button", { name: "Close panel" }).locator("svg").boundingBox()).toMatchObject({ width: 20, height: 20 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.keyboard.press("Escape");
      const wideCard = page.locator('[data-capture="page-home--state-default--1280x800"]');
      const visibleOpen = wideCard.getByRole("button", { name: "Open Image", exact: true });
      const openBox = await visibleOpen.boundingBox();
      expect(openBox?.x).toBeGreaterThanOrEqual(0);
      expect((openBox?.x ?? 0) + (openBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
      await wideCard.locator(".image-open").click();
      await expect
        .poll(() =>
          page.locator("#lightboxImage").evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(1280);
      expect(await page.locator("#lightbox").evaluate((dialog) => dialog.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      for (const selector of [
        "#lightboxZoomOut",
        "#lightboxZoomIn",
        "#lightboxFit",
        "#lightboxActual",
        "#openOriginal",
        "#closeLightbox",
      ]) {
        const box = await page.locator(selector).boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
      }
      expect(await page.locator("#closeLightbox").boundingBox()).toMatchObject({ width: 44, height: 44 });
      expect((await page.locator("#lightboxViewport").boundingBox())?.width).toBeLessThanOrEqual(viewport.width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await page.close();
    }
  });

  it("shows a persistent storage outage and fails closed until retry succeeds", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await seedExport(page);
    await page.route("**/api/review", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced storage outage" }),
      });
    });
    await page.goto(baseUrl);
    await expect.poll(() => page.locator("#storageError").isVisible()).toBe(true);
    expect(await page.locator("#storageErrorText").textContent()).toContain(
      "Decisions and exports cannot be saved",
    );
    expect(await page.locator("#liveRegion").textContent()).toContain(
      "Review storage unavailable",
    );
    expect(await page.getByRole("button", { name: /^Add to export: / }).first().isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: /^Dismiss: / }).first().isDisabled()).toBe(true);
    expect(await page.locator("#exportButton").isDisabled()).toBe(true);
    await page.unroute("**/api/review");
    await page.getByRole("button", { name: "Retry Connection" }).click();
    await expect.poll(() => page.locator("#storageError").getAttribute("hidden")).toBe("");
    expect(await page.getByRole("button", { name: /^Add to export: / }).first().isDisabled()).toBe(false);
    expect(await page.getByRole("button", { name: /^Dismiss: / }).first().isDisabled()).toBe(false);
    // Export needs something in the export list, not only working storage.
    await expect.poll(() => page.locator("#exportButton").isDisabled()).toBe(false);
    await page.close();
  });
});
