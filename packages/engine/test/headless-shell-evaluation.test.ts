import { link, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installBrowser } from "../src/browser-manager.js";
import { renderHumanHandoffPdf } from "../src/handoff-pdf.js";
import { scan } from "../src/scan.js";

const shellDirectory = process.env.VQA_HEADLESS_SHELL_EVALUATION_DIR;
const fullChromiumDirectory = process.env.VQA_FULL_CHROMIUM_EVALUATION_DIR;
const previousCache = process.env.VQA_BROWSER_CACHE;
const temporaryRoots: string[] = [];

async function hardlinkTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source)) {
    const from = join(source, entry);
    const to = join(destination, entry === "chrome-headless-shell" ? "chrome" : entry);
    const value = await lstat(from);
    if (value.isDirectory()) await hardlinkTree(from, to);
    else if (value.isFile()) await link(from, to);
  }
}

afterEach(async () => {
  if (previousCache === undefined) delete process.env.VQA_BROWSER_CACHE;
  else process.env.VQA_BROWSER_CACHE = previousCache;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!shellDirectory)("Chromium headless-shell-only evaluation", () => {
  it("runs the real scan and PDF product paths from the exact managed revision", async () => {
    await evaluatePayload(shellDirectory!);
  }, 180_000);
});

describe.skipIf(!fullChromiumDirectory)("full Chromium managed-payload evaluation", () => {
  it("runs the real scan and PDF product paths from the exact managed revision", async () => {
    await evaluatePayload(fullChromiumDirectory!);
  }, 180_000);
});

async function evaluatePayload(payloadDirectory: string): Promise<void> {
    const root = await mkdtemp(join(process.cwd(), ".vqa-headless-eval-"));
    temporaryRoots.push(root);
    process.env.VQA_BROWSER_CACHE = join(root, "managed browser cache-é");
    const installed = await installBrowser({
      installer: async (request) => {
        await hardlinkTree(payloadDirectory, dirname(request.executablePath));
      },
    });
    expect(installed.status.compatibility.payload).toBe("full-chromium");
    expect(installed.status.executablePath).toContain(`chromium-${installed.status.compatibility.browserRevision}`);

    const report = await scan({
      url: pathToFileURL(join(process.cwd(), "fixtures/seeded-defects.html")).href,
      outDir: join(root, "report"),
      viewports: [{ width: 390, height: 844, deviceScaleFactor: 1, label: "390x844" }],
      maxCropsPerViewport: 1,
    });
    expect(report.viewports).toHaveLength(1);
    const pdf = await renderHumanHandoffPdf({ content: "Headless shell evaluation", images: [] });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
}
