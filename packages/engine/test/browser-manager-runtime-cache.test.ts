import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";

const { defaultLauncher } = vi.hoisted(() => ({ defaultLauncher: vi.fn() }));

vi.mock("../src/browser-launch.js", () => ({ launchSandboxedChromium: defaultLauncher }));

import {
  browserCompatibility,
  browserStatus,
  compatibleBrowserExecutablePath,
  installBrowser,
} from "../src/browser-manager.js";
import type { BrowserInstallerRequest, BrowserManagerEnvironment } from "../src/browser-manager.js";

function cacheRoot(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `vqa-runtime-cache-${label}-`)), "cache");
}

async function fakePayload(request: BrowserInstallerRequest): Promise<void> {
  await mkdir(dirname(request.executablePath), { recursive: true });
  await writeFile(request.executablePath, "fake chromium");
}

function successfulBrowser(): Browser {
  return {
    version: () => browserCompatibility().browserVersion,
    close: async () => {},
  } as unknown as Browser;
}

function manager(root: string): BrowserManagerEnvironment {
  return {
    environment: { VQA_BROWSER_CACHE: root },
    platform: "win32",
    installer: fakePayload,
    configureWindowsSandbox: async () => {},
  };
}

async function installedManager(label: string): Promise<{
  executablePath: string;
  manager: BrowserManagerEnvironment;
  markerPath: string;
}> {
  const scope = manager(cacheRoot(label));
  defaultLauncher.mockImplementation(async () => successfulBrowser());
  const installed = await installBrowser(scope);
  defaultLauncher.mockClear();
  return {
    executablePath: installed.status.executablePath,
    manager: scope,
    markerPath: join(installed.status.revisionRoot, ".viewport-qa-revision.json"),
  };
}

describe("default Windows runtime probe cache", () => {
  it("coalesces and reuses only a settled successful compatible-path probe", async () => {
    const installed = await installedManager("coalesce");
    const marker = JSON.parse(await readFile(installed.markerPath, "utf8")) as { installedAt: string };
    marker.installedAt = "2030-01-01T00:00:00.000Z";
    await writeFile(installed.markerPath, `${JSON.stringify(marker, null, 2)}\n`);

    let resolveLaunch!: (browser: Browser) => void;
    defaultLauncher.mockImplementation(() => new Promise<Browser>((resolvePromise) => { resolveLaunch = resolvePromise; }));
    const first = compatibleBrowserExecutablePath(installed.manager);
    const second = compatibleBrowserExecutablePath(installed.manager);
    await vi.waitFor(() => expect(defaultLauncher).toHaveBeenCalledOnce());
    resolveLaunch(successfulBrowser());
    await expect(Promise.all([first, second])).resolves.toEqual([installed.executablePath, installed.executablePath]);
    await compatibleBrowserExecutablePath(installed.manager);
    expect(defaultLauncher).toHaveBeenCalledOnce();
  });

  it("rehashes payload bytes before reuse and generation-fences a late success", async () => {
    const installed = await installedManager("mutation");
    let resolveLaunch!: (browser: Browser) => void;
    defaultLauncher.mockImplementation(() => new Promise<Browser>((resolvePromise) => { resolveLaunch = resolvePromise; }));
    const pending = compatibleBrowserExecutablePath(installed.manager);
    await vi.waitFor(() => expect(defaultLauncher).toHaveBeenCalledOnce());

    await writeFile(installed.executablePath, "mutated chromium");
    await expect(compatibleBrowserExecutablePath(installed.manager)).rejects.toThrow("integrity manifest");
    resolveLaunch(successfulBrowser());
    await expect(pending).resolves.toBe(installed.executablePath);

    await writeFile(installed.executablePath, "fake chromium");
    defaultLauncher.mockImplementation(async () => successfulBrowser());
    await compatibleBrowserExecutablePath(installed.manager);
    expect(defaultLauncher).toHaveBeenCalledTimes(2);
  });

  it("does not reuse failures and invalidates on marker version or install generation changes", async () => {
    const installed = await installedManager("invalidation");
    defaultLauncher.mockImplementationOnce(async () => ({
      version: () => "0.0.0.0",
      close: async () => {},
    }) as unknown as Browser);
    await expect(compatibleBrowserExecutablePath(installed.manager)).rejects.toThrow("version mismatch");
    defaultLauncher.mockImplementation(async () => successfulBrowser());
    await compatibleBrowserExecutablePath(installed.manager);
    expect(defaultLauncher).toHaveBeenCalledTimes(2);

    const markerText = await readFile(installed.markerPath, "utf8");
    const marker = JSON.parse(markerText) as { compatibility: { browserVersion: string } };
    marker.compatibility.browserVersion = "0.0.0.0";
    await writeFile(installed.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    await expect(compatibleBrowserExecutablePath(installed.manager)).rejects.toThrow("metadata is missing or incompatible");
    await writeFile(installed.markerPath, markerText);
    await compatibleBrowserExecutablePath(installed.manager);
    expect(defaultLauncher).toHaveBeenCalledTimes(3);

    await installBrowser(installed.manager);
    const callsAfterInstall = defaultLauncher.mock.calls.length;
    await compatibleBrowserExecutablePath(installed.manager);
    expect(defaultLauncher.mock.calls.length).toBe(callsAfterInstall + 1);
    await compatibleBrowserExecutablePath(installed.manager);
    expect(defaultLauncher.mock.calls.length).toBe(callsAfterInstall + 1);
  });

  it("keeps ordinary BrowserStatus checks uncached", async () => {
    const installed = await installedManager("status");
    defaultLauncher.mockImplementation(async () => successfulBrowser());
    expect((await browserStatus(installed.manager)).ok).toBe(true);
    expect((await browserStatus(installed.manager)).ok).toBe(true);
    expect(defaultLauncher).toHaveBeenCalledTimes(2);
  });
});
