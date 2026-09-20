import { chmod, lstat, mkdir, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_RECOVERY_COMMAND,
  browserCacheSize,
  browserCompatibility,
  browserStatus,
  compatibleBrowserExecutablePath,
  installBrowser,
  nativeLibraryDiagnostic,
  removeBrowser,
  removeOwnedStagingDirectory,
} from "../src/browser-manager.js";
import type {
  BrowserInstallerRequest,
  BrowserManagerEnvironment,
} from "../src/browser-manager.js";
import { compileWindowsTestExecutable } from "../../../scripts/windows-test-powershell.mjs";

const NONCE_A = "11111111-1111-4111-8111-111111111111";
const NONCE_B = "22222222-2222-4222-8222-222222222222";

function testRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `vqa-browser-${label}-`));
}

async function fakePayload(request: BrowserInstallerRequest): Promise<void> {
  await mkdir(dirname(request.executablePath), { recursive: true });
  await writeFile(request.executablePath, "fake chromium");
  if (process.platform !== "win32") await chmod(request.executablePath, 0o700);
}

async function fakeWindowsSandboxPayload(
  request: BrowserInstallerRequest,
  root: string,
  setupCapture: string,
  exitCode: number,
): Promise<void> {
  await fakePayload(request);
  const setupPath = join(dirname(request.executablePath), "setup.exe");
  if (process.platform === "win32") {
    const source = join(root, `setup-${exitCode}.cs`);
    const captureLiteral = setupCapture.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await writeFile(source, `using System.IO; public static class Setup { public static int Main(string[] args) { File.WriteAllText("${captureLiteral}", args[0]); return ${exitCode}; } }`);
    compileWindowsTestExecutable(setupPath, source);
  } else {
    await writeFile(setupPath, `#!/bin/sh\nprintf '%s' "$1" > '${setupCapture}'\nexit ${exitCode}\n`);
    await chmod(setupPath, 0o700);
  }
}

async function makeBundledReadOnly(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeBundledReadOnly(child);
    const executable = ((await lstat(child)).mode & 0o111) !== 0;
    await chmod(child, entry.isDirectory() || executable ? 0o555 : 0o444);
  }
  await chmod(path, 0o555);
}

function manager(cacheRoot: string, extra: Partial<BrowserManagerEnvironment> = {}): BrowserManagerEnvironment {
  const compatibility = browserCompatibility();
  return {
    environment: { VQA_BROWSER_CACHE: cacheRoot },
    installer: fakePayload,
    probe: async () => ({ ok: true, detail: `Chromium ${compatibility.browserVersion}`, version: compatibility.browserVersion }),
    ...(process.platform === "win32" ? { configureWindowsSandbox: async () => {} } : {}),
    ...extra,
  };
}

async function ownedStagingFixture(label: string): Promise<{
  cacheRoot: string;
  compatibility: ReturnType<typeof browserCompatibility>;
  revisionRoot: string;
  stagingRoot: string;
  sentinel: string;
}> {
  const compatibility = browserCompatibility();
  const cacheRoot = testRoot(`staging-cleanup-${label}`);
  const revisionRoot = join(cacheRoot, `pw-${compatibility.playwrightVersion}-chromium-${compatibility.browserRevision}`);
  const stagingRoot = `${revisionRoot}.staging-${NONCE_A}`;
  const sentinel = join(stagingRoot, "payload", "sentinel.txt");
  await mkdir(dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "preserve until owned cleanup succeeds");
  await writeFile(join(stagingRoot, ".viewport-qa-staging.json"), `${JSON.stringify({
    managedBy: "viewport-qa-browser-manager-v1",
    state: "staging",
    revision: compatibility.browserRevision,
    nonce: NONCE_A,
    createdAt: "2026-08-25T00:00:00.000Z",
  })}\n`);
  return { cacheRoot, compatibility, revisionRoot, stagingRoot, sentinel };
}

describe("Viewport QA browser manager", () => {
  const itWithSymlinks = process.platform === "win32" ? it.skip : it;

  it.each(["EBUSY", "EPERM", "ENOTEMPTY"] as const)("retries transient owned-staging %s locks within a fixed bound", async (code) => {
    const fixture = await ownedStagingFixture(`transient-lock-${code}`);
    const delays: number[] = [];
    let attempts = 0;
    await removeOwnedStagingDirectory(
      fixture.stagingRoot,
      fixture.revisionRoot,
      fixture.compatibility,
      NONCE_A,
      {
        beforeRemove: async () => {
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error(`simulated Windows ${code} lock`), { code });
        },
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      },
    );
    expect(attempts).toBe(3);
    expect(delays).toEqual([200, 400]);
    await expect(lstat(fixture.stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["EBUSY", "EPERM", "ENOTEMPTY"] as const)("fails closed after bounded retries when an owned staging %s lock persists", async (code) => {
    const fixture = await ownedStagingFixture(`persistent-lock-${code}`);
    const delays: number[] = [];
    let attempts = 0;
    await expect(removeOwnedStagingDirectory(
      fixture.stagingRoot,
      fixture.revisionRoot,
      fixture.compatibility,
      NONCE_A,
      {
        beforeRemove: async () => {
          attempts += 1;
          throw Object.assign(new Error(`persistent browser cleanup ${code} lock`), { code });
        },
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      },
    )).rejects.toMatchObject({ code });
    expect(attempts).toBe(9);
    expect(delays).toEqual([200, 400, 600, 800, 1_000, 1_200, 1_400, 1_600]);
    expect(await readFile(fixture.sentinel, "utf8")).toBe("preserve until owned cleanup succeeds");
  });

  it("preserves the primary install failure before a persistent staging cleanup failure", async () => {
    const primary = new Error("primary installer failure");
    const cleanup = Object.assign(new Error("persistent cleanup lock"), { code: "EBUSY" });
    const cacheRoot = join(testRoot("aggregate-cleanup"), "cache");
    let caught: unknown;
    try {
      await installBrowser(manager(cacheRoot, {
        installer: async () => { throw primary; },
        beforeStagingRemove: async () => { throw cleanup; },
        sleep: async () => {},
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).message).toBe("Browser installation failed and its owned staging directory remained locked");
    expect((caught as AggregateError).errors).toEqual([primary, cleanup]);
  });

  it("aborts an in-flight installer and removes only its owned staging", async () => {
    const cacheRoot = join(testRoot("abort-install"), "cache");
    const controller = new AbortController();
    let installerStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { installerStarted = resolvePromise; });
    const installing = installBrowser(manager(cacheRoot, {
      installer: async (request) => {
        installerStarted();
        await new Promise<never>((_resolvePromise, rejectPromise) => {
          const reject = () => rejectPromise(request.signal?.reason ?? new Error("browser setup cancelled"));
          if (request.signal?.aborted) reject();
          else request.signal?.addEventListener("abort", reject, { once: true });
        });
      },
    }), { signal: controller.signal, garbageCollect: false });

    await started;
    controller.abort(new Error("Viewport QA stopped"));
    await expect(installing).rejects.toThrow("Viewport QA stopped");
    expect((await readdir(cacheRoot)).some((entry) => entry.includes(".staging-"))).toBe(false);
  });

  it("removes its exact staging after abort during completed-payload inventory", async () => {
    const cacheRoot = join(testRoot("abort-complete-staging"), "cache");
    const controller = new AbortController();
    const stopped = new Error("Viewport QA stopped during browser inventory");
    let stagingRoot = "";
    let completeMarker: { state?: string } | undefined;
    const scope = manager(cacheRoot, {
      installer: async (request) => {
        stagingRoot = request.stagingRoot;
        await fakePayload(request);
      },
      afterRevisionMarkerWrite: () => controller.abort(stopped),
      beforeStagingRemove: async () => {
        completeMarker = JSON.parse(await readFile(join(stagingRoot, ".viewport-qa-revision.json"), "utf8")) as { state?: string };
      },
    });

    await expect(installBrowser(scope, { signal: controller.signal, garbageCollect: false })).rejects.toBe(stopped);
    expect(completeMarker?.state).toBe("complete");
    await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(cacheRoot)).some((entry) => entry.includes(".staging-"))).toBe(false);

    const installed = await installBrowser(scope, { garbageCollect: false });
    expect(installed.changed).toBe(true);
    expect(installed.status.ok).toBe(true);
    expect(JSON.parse(await readFile(join(installed.status.revisionRoot, ".viewport-qa-revision.json"), "utf8"))).toMatchObject({ state: "complete" });
  });

  it("revalidates a replaced cache parent immediately before trusted removal", async () => {
    const fixture = await ownedStagingFixture("parent-replacement");
    const displacedCache = `${fixture.cacheRoot}.original`;
    const outsideCache = testRoot("staging-cleanup-outside");
    const outsideStaging = join(outsideCache, basename(fixture.stagingRoot));
    const replacementSentinel = join(outsideStaging, "replacement-sentinel.txt");
    let attempts = 0;
    await expect(removeOwnedStagingDirectory(
      fixture.stagingRoot,
      fixture.revisionRoot,
      fixture.compatibility,
      NONCE_A,
      {
        beforeRemove: async () => {
          attempts += 1;
          await rename(fixture.cacheRoot, displacedCache);
          await mkdir(outsideStaging, { recursive: true });
          await writeFile(replacementSentinel, "replacement must survive");
          await symlink(outsideCache, fixture.cacheRoot, process.platform === "win32" ? "junction" : "dir");
        },
      },
    )).rejects.toThrow("parent identity changed immediately before cleanup");
    expect(attempts).toBe(1);
    expect(await readFile(replacementSentinel, "utf8")).toBe("replacement must survive");
    expect(await readFile(join(displacedCache, basename(fixture.stagingRoot), "payload", "sentinel.txt"), "utf8")).toBe("preserve until owned cleanup succeeds");
  });

  it("fails closed when a partial cleanup error removes its generation marker", async () => {
    const fixture = await ownedStagingFixture("partial-error");
    let attempts = 0;
    await expect(removeOwnedStagingDirectory(
      fixture.stagingRoot,
      fixture.revisionRoot,
      fixture.compatibility,
      NONCE_A,
      {
        beforeRemove: async () => {
          attempts += 1;
          await rm(join(fixture.stagingRoot, ".viewport-qa-staging.json"));
          throw Object.assign(new Error("partial Windows removal"), { code: "EBUSY" });
        },
        sleep: async () => {},
      },
    )).rejects.toThrow("marker generation changed");
    expect(attempts).toBe(1);
    expect(await readFile(fixture.sentinel, "utf8")).toBe("preserve until owned cleanup succeeds");
  });

  it("reports a missing exact revision and one recovery command", async () => {
    const status = await browserStatus(manager(join(testRoot("missing"), "cache")));
    expect(status.ok).toBe(false);
    expect(status.health).toBe("missing");
    expect(status.compatibility).toEqual(browserCompatibility());
    expect(status.recoveryCommand).toBe(BROWSER_RECOVERY_COMMAND);
    expect(status.diagnostics[0]?.remediation).toEqual([`Run: ${BROWSER_RECOVERY_COMMAND}`]);
  });

  it("rejects a relative cache override", async () => {
    const scope = manager("relative/cache");
    expect((await browserStatus(scope)).diagnostics[0]?.code).toBe("cache-unavailable");
    await expect(installBrowser(scope)).rejects.toThrow("absolute path");
  });

  it("installs, validates, reuses, and removes only the managed revision", async () => {
    const cacheRoot = join(testRoot("lifecycle"), "with spaces", "café");
    const scope = manager(cacheRoot);
    const installed = await installBrowser(scope);
    expect(installed.changed).toBe(true);
    expect(installed.status.ok).toBe(true);
    expect(await compatibleBrowserExecutablePath(scope)).toBe(installed.status.executablePath);

    const again = await installBrowser(scope);
    expect(again.changed).toBe(false);
    await writeFile(join(cacheRoot, "foreign-user-file"), "preserve");
    const removed = await removeBrowser(scope);
    expect(removed.changed).toBe(true);
    expect(removed.status.health).toBe("missing");
    expect(await readFile(join(cacheRoot, "foreign-user-file"), "utf8")).toBe("preserve");
  });

  it("configures Chrome's Windows sandbox ACL before accepting a staged payload", async () => {
    const root = testRoot("windows-sandbox-acl");
    const cacheRoot = join(root, "cache");
    const setupCapture = join(root, "setup-argument");
    const compatibility = browserCompatibility();
    let stagedBrowserDirectory = "";
    const installed = await installBrowser(manager(cacheRoot, {
      platform: "win32",
      configureWindowsSandbox: undefined,
      installer: async (request) => {
        stagedBrowserDirectory = dirname(request.executablePath);
        await fakeWindowsSandboxPayload(request, root, setupCapture, 78);
      },
      probe: async () => ({ ok: true, detail: `Chromium ${compatibility.browserVersion}`, version: compatibility.browserVersion }),
    }));
    expect(installed.status.ok).toBe(true);
    const setupArgument = await readFile(setupCapture, "utf8");
    expect(setupArgument).toContain(`${basename(installed.status.revisionRoot)}.staging-`);
    expect(setupArgument).toBe(`--configure-browser-in-directory=${stagedBrowserDirectory}`);
  });

  it("rejects Chrome's documented Windows sandbox ACL failure code", async () => {
    const root = testRoot("windows-sandbox-acl-failure");
    const cacheRoot = join(root, "cache");
    const compatibility = browserCompatibility();
    await expect(installBrowser(manager(cacheRoot, {
      platform: "win32",
      configureWindowsSandbox: undefined,
      installer: (request) => fakeWindowsSandboxPayload(request, root, join(root, "setup-argument"), 79),
      probe: async () => ({ ok: true, detail: `Chromium ${compatibility.browserVersion}`, version: compatibility.browserVersion }),
    }))).rejects.toThrow("returned 79; expected documented success code 78");
    expect((await readdir(cacheRoot)).filter((entry) => entry.startsWith("pw-"))).toEqual([]);
  });

  it("validates Windows Chrome with a short sandboxed Playwright launch and closes every probe", async () => {
    const cacheRoot = join(testRoot("windows-playwright-probe"), "cache");
    const compatibility = browserCompatibility();
    const close = vi.fn(async () => {});
    const probeLauncher = vi.fn(async () => ({
      version: () => compatibility.browserVersion,
      close,
    }) as unknown as Browser);
    const installed = await installBrowser(manager(cacheRoot, {
      platform: "win32",
      probe: undefined,
      probeLauncher,
      configureWindowsSandbox: async () => {},
    }));
    expect(installed.status.ok).toBe(true);
    expect(probeLauncher).toHaveBeenCalled();
    for (const [options] of probeLauncher.mock.calls) {
      expect(options).toMatchObject({ headless: true, timeout: 10_000 });
      expect(options.executablePath).toContain("pw-1.61.0-chromium-1228");
    }
    expect(close).toHaveBeenCalledTimes(probeLauncher.mock.calls.length);
  });

  it("never caches injected probes or launchers", async () => {
    const cacheRoot = join(testRoot("windows-runtime-probe-injected"), "cache");
    await installBrowser(manager(cacheRoot));
    const compatibility = browserCompatibility();
    const customProbe = vi.fn(async () => ({
      ok: true,
      detail: `Chromium ${compatibility.browserVersion}`,
      version: compatibility.browserVersion,
    }));
    const customScope = manager(cacheRoot, { platform: "win32", probe: customProbe });
    await browserStatus(customScope);
    await browserStatus(customScope);
    expect(customProbe).toHaveBeenCalledTimes(2);

    const close = vi.fn(async () => {});
    const probeLauncher = vi.fn(async () => ({
      version: () => compatibility.browserVersion,
      close,
    }) as unknown as Browser);
    const defaultScope = manager(cacheRoot, { platform: "win32", probe: undefined, probeLauncher });
    await browserStatus(defaultScope);
    await browserStatus(defaultScope);
    await compatibleBrowserExecutablePath(defaultScope);
    await compatibleBrowserExecutablePath(defaultScope);
    expect(probeLauncher).toHaveBeenCalledTimes(4);
  });

  it("rejects a Windows Playwright probe that reports the wrong browser version", async () => {
    const cacheRoot = join(testRoot("windows-playwright-probe-version"), "cache");
    const close = vi.fn(async () => {});
    await expect(installBrowser(manager(cacheRoot, {
      platform: "win32",
      probe: undefined,
      probeLauncher: async () => ({ version: () => "148.0.0.0", close }) as unknown as Browser,
      configureWindowsSandbox: async () => {},
    }))).rejects.toThrow("version mismatch");
    expect(close).toHaveBeenCalled();
    expect((await readdir(cacheRoot)).filter((entry) => entry.startsWith("pw-"))).toEqual([]);
  });

  it("bounds a stalled Windows Playwright probe and closes a browser that resolves late", async () => {
    vi.useFakeTimers();
    try {
      const cacheRoot = join(testRoot("windows-playwright-probe-timeout"), "cache");
      const close = vi.fn(async () => {});
      let resolveLaunch!: (browser: Browser) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const probeLauncher = vi.fn(() => {
        markStarted();
        return new Promise<Browser>((resolve) => { resolveLaunch = resolve; });
      });
      const installing = installBrowser(manager(cacheRoot, {
        platform: "win32",
        probe: undefined,
        probeLauncher,
        configureWindowsSandbox: async () => {},
      }));
      await started;
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(installing).rejects.toThrow("sandboxed probe timed out after 12000ms");
      resolveLaunch({ version: () => browserCompatibility().browserVersion, close } as unknown as Browser);
      await Promise.resolve();
      await Promise.resolve();
      expect(close).toHaveBeenCalledOnce();
      expect((await readdir(cacheRoot)).filter((entry) => entry.startsWith("pw-"))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  itWithSymlinks("manifests confined relative browser links and detects target mutation", async () => {
    const cacheRoot = join(testRoot("confined-payload-link"), "cache");
    const scope = manager(cacheRoot, {
      installer: async (request) => {
        await fakePayload(request);
        const resources = join(request.stagingRoot, "resources");
        await mkdir(resources);
        await writeFile(join(resources, "target.dat"), "original");
        await symlink("target.dat", join(resources, "Current"));
      },
    });
    const installed = await installBrowser(scope);
    expect(installed.status.ok).toBe(true);
    await writeFile(join(installed.status.revisionRoot, "resources", "target.dat"), "mutated");
    expect((await browserStatus(scope)).health).toBe("corrupt");
  });

  itWithSymlinks("sizes a confined browser link without following or rejecting it", async () => {
    const root = testRoot("confined-link-size");
    const target = join(root, "target.dat");
    const link = join(root, "Current");
    await writeFile(target, "original");
    await symlink("target.dat", link);
    expect(await browserCacheSize(root)).toBe(8 + (await lstat(link)).size);
  });

  itWithSymlinks("refuses a relative browser payload link that escapes staging", async () => {
    const root = testRoot("escaping-payload-link");
    const outside = join(root, "outside.dat");
    await writeFile(outside, "sentinel");
    const scope = manager(join(root, "cache"), {
      installer: async (request) => {
        await fakePayload(request);
        await symlink(relative(request.stagingRoot, outside), join(request.stagingRoot, "escape"));
      },
    });
    await expect(installBrowser(scope)).rejects.toThrow("escapes its cache root");
    expect(await readFile(outside, "utf8")).toBe("sentinel");
  });

  it("validates an explicitly bundled read-only offline cache without weakening mutable caches", async () => {
    const cacheRoot = join(testRoot("bundled-readonly"), "admin-owned-install", "browsers");
    const writable = manager(cacheRoot);
    await installBrowser(writable);
    await makeBundledReadOnly(cacheRoot);
    const bundled = manager(cacheRoot, {
      environment: {
        VQA_BROWSER_CACHE: cacheRoot,
        VQA_BROWSER_OFFLINE: "1",
        VQA_BROWSER_BUNDLED_READONLY: "1",
      },
    });
    expect((await browserStatus(bundled)).ok).toBe(true);
    const unflagged = await browserStatus({ ...bundled, environment: { VQA_BROWSER_CACHE: cacheRoot, VQA_BROWSER_OFFLINE: "1" } });
    if (process.platform === "win32") {
      // chmod does not establish a restrictive Windows ACL. Native packaging
      // tests exercise the separate Windows read-only/ACL contract.
      expect(unflagged.ok).toBe(true);
    } else {
      expect(unflagged.diagnostics[0]?.code).toBe("cache-unavailable");
    }
    await expect(installBrowser(bundled)).rejects.toThrow("disabled by VQA_BROWSER_OFFLINE=1");
  });

  it("keeps the last healthy revision when a repair download is interrupted", async () => {
    const cacheRoot = join(testRoot("interrupt"), "cache");
    const scope = manager(cacheRoot);
    const healthy = await installBrowser(scope);
    const interrupted = manager(cacheRoot, {
      installer: async (request) => {
        await fakePayload(request);
        throw new Error("simulated network interruption");
      },
    });
    await expect(installBrowser(interrupted, { repair: true })).rejects.toThrow("simulated network interruption");
    const after = await browserStatus(scope);
    expect(after.ok).toBe(true);
    expect(after.executablePath).toBe(healthy.status.executablePath);
    expect((await readdir(cacheRoot)).some((entry) => entry.includes(".staging-"))).toBe(false);
  });

  it("does not leave a partially healthy cache when post-promotion validation fails", async () => {
    const cacheRoot = join(testRoot("promotion-validation"), "cache");
    const scope = manager(cacheRoot, {
      probe: async (path) => path.includes(".staging-")
        ? { ok: true, version: browserCompatibility().browserVersion }
        : { ok: false, detail: "simulated post-promotion failure" },
    });
    await expect(installBrowser(scope)).rejects.toThrow("post-promotion failure");
    expect((await browserStatus(manager(cacheRoot))).health).toBe("missing");
  });

  it("rejects an executable whose observed version differs from pinned metadata", async () => {
    const cacheRoot = join(testRoot("wrong-version"), "cache");
    await expect(installBrowser(manager(cacheRoot, {
      probe: async () => ({ ok: true, detail: "Chromium 1.2.3.4", version: "1.2.3.4" }),
    }))).rejects.toThrow("version mismatch");
    expect((await browserStatus(manager(cacheRoot))).health).toBe("missing");
  });

  it("rejects a post-install observed-version mismatch", async () => {
    const cacheRoot = join(testRoot("wrong-version-status"), "cache");
    await installBrowser(manager(cacheRoot));
    const status = await browserStatus(manager(cacheRoot, {
      probe: async () => ({ ok: true, detail: "Chromium 1.2.3.4", version: "1.2.3.4" }),
    }));
    expect(status.ok).toBe(false);
    expect(status.diagnostics[0]?.message).toContain("version mismatch");
  });

  it("detects post-install payload byte modification", async () => {
    const cacheRoot = join(testRoot("payload-integrity"), "cache");
    const scope = manager(cacheRoot, {
      installer: async (request) => {
        await fakePayload(request);
        await writeFile(join(request.stagingRoot, "runtime-resource.pak"), "original bytes");
      },
    });
    const installed = await installBrowser(scope);
    await writeFile(join(installed.status.revisionRoot, "runtime-resource.pak"), "modified bytes");
    const status = await browserStatus(scope);
    expect(status.ok).toBe(false);
    expect(status.diagnostics[0]?.message).toContain("integrity manifest");
  });

  it("keeps mixed-case payload manifests deterministic and healthy", async () => {
    const cacheRoot = join(testRoot("mixed-case-manifest"), "cache");
    const scope = manager(cacheRoot, {
      installer: async (request) => {
        await fakePayload(request);
        await writeFile(join(request.stagingRoot, "ABOUT"), "about");
        await writeFile(join(request.stagingRoot, "LICENSE.headless_shell"), "license");
        await writeFile(join(request.stagingRoot, "chrome-wrapper"), "wrapper");
      },
    });

    const first = await installBrowser(scope);
    expect(first.status.ok).toBe(true);
    const firstMarker = JSON.parse(await readFile(
      join(first.status.revisionRoot, ".viewport-qa-revision.json"),
      "utf8",
    )) as { payloadManifest: { files: Array<{ path: string }> } };
    const paths = firstMarker.payloadManifest.files.map((file) => file.path);
    const binarySorted = [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    expect(paths).toEqual(binarySorted);
    expect(paths.slice(0, 3)).toEqual(["ABOUT", "LICENSE.headless_shell", "chrome-wrapper"]);

    const repaired = await installBrowser(scope, { repair: true });
    expect(repaired.status.ok).toBe(true);
    const repairedMarker = JSON.parse(await readFile(
      join(repaired.status.revisionRoot, ".viewport-qa-revision.json"),
      "utf8",
    )) as { payloadManifest: unknown };
    expect(repairedMarker.payloadManifest).toEqual(firstMarker.payloadManifest);
    expect((await browserStatus(scope)).ok).toBe(true);
  });

  it("repairs a recognized corrupt payload but refuses malformed ownership metadata", async () => {
    const cacheRoot = join(testRoot("corrupt"), "cache");
    const scope = manager(cacheRoot);
    const installed = await installBrowser(scope);
    await writeFile(join(cacheRoot, "unrelated"), "keep");
    await writeFile(installed.status.executablePath, "");
    await chmod(installed.status.executablePath, 0o600);
    expect((await browserStatus(scope)).health).toBe("corrupt");

    const repaired = await installBrowser(scope, { repair: true });
    expect(repaired.status.ok).toBe(true);
    expect(await readFile(join(cacheRoot, "unrelated"), "utf8")).toBe("keep");

    await writeFile(join(repaired.status.revisionRoot, ".viewport-qa-revision.json"), "corrupt metadata");
    const sentinel = join(repaired.status.revisionRoot, "foreign-sentinel");
    await writeFile(sentinel, "preserve");
    expect((await browserStatus(scope)).health).toBe("corrupt");
    await expect(installBrowser(scope, { repair: true })).rejects.toThrow("Refusing to replace");
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
  });

  it("serializes concurrent installs and downloads once", async () => {
    const cacheRoot = join(testRoot("concurrent"), "cache");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const scope = manager(cacheRoot, {
      installer: async (request) => {
        calls += 1;
        await gate;
        await fakePayload(request);
      },
      sleep: async () => new Promise<void>((done) => setTimeout(done, 2)),
    });
    const first = installBrowser(scope);
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = installBrowser(scope);
    release();
    const results = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
  });

  it("retries when an observed install lock vanishes before component verification", async () => {
    const cacheRoot = join(testRoot("install-lock-vanish"), "cache");
    await installBrowser(manager(cacheRoot));
    const lockRoot = join(cacheRoot, ".install.lock");
    await mkdir(lockRoot);
    let raced = false;
    const repaired = await installBrowser(manager(cacheRoot, {
      afterInstallLockObserved: async () => { if (!raced) { raced = true; await rm(lockRoot, { recursive: true }); } },
    }), { repair: true });
    expect(raced).toBe(true);
    expect(repaired.status.ok).toBe(true);
  });

  it("fails closed when an observed install lock is replaced by a link", async () => {
    const root = testRoot("install-lock-replace");
    const cacheRoot = join(root, "cache");
    await installBrowser(manager(cacheRoot));
    const lockRoot = join(cacheRoot, ".install.lock");
    const outside = join(root, "outside");
    await mkdir(lockRoot);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    let raced = false;
    await expect(installBrowser(manager(cacheRoot, {
      afterInstallLockObserved: async () => {
        if (raced) return;
        raced = true;
        await rm(lockRoot, { recursive: true });
        await symlink(outside, lockRoot, process.platform === "win32" ? "junction" : "dir");
      },
    }), { repair: true })).rejects.toThrow("Unsafe or legacy browser install lock");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
  });

  it("fails closed when the observed install-lock parent is replaced before retry", async () => {
    const root = testRoot("install-lock-parent-replace");
    const cacheRoot = join(root, "cache");
    await installBrowser(manager(cacheRoot));
    const lockRoot = join(cacheRoot, ".install.lock");
    const outside = join(root, "outside");
    await mkdir(lockRoot);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    await expect(installBrowser(manager(cacheRoot, {
      afterInstallLockObserved: async () => {
        await rm(cacheRoot, { recursive: true });
        await symlink(outside, cacheRoot, process.platform === "win32" ? "junction" : "dir");
      },
    }), { repair: true })).rejects.toThrow("install lock parent changed");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
    await expect(lstat(join(outside, ".install.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only its empty install lock when the cache parent is replaced during creation", async () => {
    const root = testRoot("install-lock-create-parent-replace");
    const cacheRoot = join(root, "cache");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    await expect(installBrowser(manager(cacheRoot, {
      beforeInstallLockCreate: async () => {
        await rm(cacheRoot, { recursive: true });
        await symlink(outside, cacheRoot, process.platform === "win32" ? "junction" : "dir");
      },
    }))).rejects.toThrow("install lock parent identity changed");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
    await expect(lstat(join(outside, ".install.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a regular-directory replacement generation before stale-owner cleanup", async () => {
    const root = testRoot("install-lock-stale-parent-replace");
    const cacheRoot = join(root, "cache");
    await installBrowser(manager(cacheRoot));
    const lockRoot = join(cacheRoot, ".install.lock");
    const ownerName = `owner-${NONCE_A}.json`;
    await mkdir(lockRoot);
    await writeFile(join(lockRoot, ownerName), `${JSON.stringify({
      managedBy: "viewport-qa-browser-manager-v1",
      state: "locked",
      pid: 424242,
      nonce: NONCE_A,
      createdAt: new Date().toISOString(),
    })}\n`);
    const replacement = join(root, "replacement-cache");
    const replacementLock = join(replacement, ".install.lock");
    const replacementOwner = join(replacementLock, ownerName);
    await mkdir(replacementLock, { recursive: true });
    await writeFile(replacementOwner, "replacement owner\n");
    await writeFile(join(replacementLock, "sentinel"), "preserve");
    let replaced = false;
    await expect(installBrowser(manager(cacheRoot, {
      processAlive: () => {
        if (!replaced) {
          replaced = true;
          rmSync(cacheRoot, { recursive: true });
          renameSync(replacement, cacheRoot);
        }
        return false;
      },
    }), { repair: true })).rejects.toThrow("install lock parent changed");
    expect(await readFile(join(lockRoot, ownerName), "utf8")).toBe("replacement owner\n");
    expect(await readFile(join(lockRoot, "sentinel"), "utf8")).toBe("preserve");
  });

  it("recovers a stale owner lock deterministically", async () => {
    const cacheRoot = join(testRoot("stale-lock"), "cache");
    const scope = manager(cacheRoot);
    await installBrowser(scope);
    const lockRoot = join(cacheRoot, ".install.lock");
    await mkdir(lockRoot);
    await writeFile(join(lockRoot, `owner-${NONCE_A}.json`), `${JSON.stringify({
      managedBy: "viewport-qa-browser-manager-v1",
      state: "locked",
      pid: 424242,
      nonce: NONCE_A,
      createdAt: new Date().toISOString(),
    })}\n`);
    const repaired = await installBrowser(manager(cacheRoot, { processAlive: () => false }), { repair: true });
    expect(repaired.status.ok).toBe(true);
  });

  it("recovers old lock creation remnants but preserves recent malformed ownership", async () => {
    const cacheRoot = join(testRoot("lock-boundaries"), "cache");
    const scope = manager(cacheRoot);
    await installBrowser(scope);
    const lockRoot = join(cacheRoot, ".install.lock");

    await mkdir(lockRoot);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockRoot, old, old);
    expect((await installBrowser(scope, { repair: true })).status.ok).toBe(true);

    await mkdir(lockRoot);
    const malformedOwner = join(lockRoot, `owner-${NONCE_A}.json`);
    await writeFile(malformedOwner, "partial JSON");
    await utimes(malformedOwner, old, old);
    expect((await installBrowser(scope, { repair: true })).status.ok).toBe(true);

    await mkdir(lockRoot);
    await writeFile(join(lockRoot, `owner-${NONCE_B}.json`), "foreign recent content");
    await expect(installBrowser(scope, { repair: true })).rejects.toThrow("Incomplete browser install lock");
    expect(await readFile(join(lockRoot, `owner-${NONCE_B}.json`), "utf8")).toBe("foreign recent content");
  });

  it("generation-fences unlock and preserves a replacement owner", async () => {
    const cacheRoot = join(testRoot("lock-fence"), "cache");
    const scope = manager(cacheRoot);
    await expect(installBrowser(manager(cacheRoot, {
      installer: async (request) => {
        await fakePayload(request);
        const lockRoot = join(cacheRoot, ".install.lock");
        const [owner] = await readdir(lockRoot);
        await writeFile(join(lockRoot, owner!), "replacement generation");
      },
    }))).rejects.toThrow("lock ownership changed");
    const [preserved] = await readdir(join(cacheRoot, ".install.lock"));
    expect(await readFile(join(cacheRoot, ".install.lock", preserved!), "utf8")).toBe("replacement generation");
    expect(scope.environment?.VQA_BROWSER_CACHE).toBe(cacheRoot);
  });

  it("preserves an ambiguous foreign lock artifact", async () => {
    const cacheRoot = join(testRoot("foreign-lock"), "cache");
    const scope = manager(cacheRoot);
    await installBrowser(scope);
    const lockPath = join(cacheRoot, ".install.lock");
    await writeFile(lockPath, "foreign lock sentinel");
    await expect(installBrowser(scope, { repair: true })).rejects.toThrow("manual inspection");
    expect(await readFile(lockPath, "utf8")).toBe("foreign lock sentinel");
  });

  it("recovers a completed backup and removes only validated stale staging", async () => {
    const cacheRoot = join(testRoot("crash-recovery"), "cache");
    const scope = manager(cacheRoot);
    const installed = await installBrowser(scope);
    const backup = `${installed.status.revisionRoot}.backup-${NONCE_A}`;
    const staging = `${installed.status.revisionRoot}.staging-${NONCE_A}`;
    await rename(installed.status.revisionRoot, backup);
    await mkdir(staging);
    await writeFile(join(staging, ".viewport-qa-staging.json"), `${JSON.stringify({ managedBy: "viewport-qa-browser-manager-v1", state: "staging", revision: browserCompatibility().browserRevision, nonce: NONCE_A, createdAt: new Date().toISOString() })}\n`);

    const recovered = await installBrowser(scope);
    expect(recovered.changed).toBe(false);
    expect(recovered.status.ok).toBe(true);
    expect(await lstat(staging).then(() => true, () => false)).toBe(false);
    expect(await lstat(backup).then(() => true, () => false)).toBe(false);

    const completeStaging = `${recovered.status.revisionRoot}.staging-${NONCE_B}`;
    await rename(recovered.status.revisionRoot, completeStaging);
    await writeFile(join(completeStaging, ".viewport-qa-staging.json"), `${JSON.stringify({ managedBy: "viewport-qa-browser-manager-v1", state: "staging", revision: browserCompatibility().browserRevision, nonce: NONCE_B, createdAt: new Date().toISOString() })}\n`);
    const promoted = await installBrowser(scope);
    expect(promoted.changed).toBe(false);
    expect(promoted.status.ok).toBe(true);
    expect(await lstat(completeStaging).then(() => true, () => false)).toBe(false);
  });

  it("passes proxy, custom CA, and HTTPS mirror configuration only to the downloader", async () => {
    const cacheRoot = join(testRoot("network"), "cache");
    let captured: NodeJS.ProcessEnv | undefined;
    const scope = manager(cacheRoot, {
      environment: {
        VQA_BROWSER_CACHE: cacheRoot,
        HTTPS_PROXY: "http://proxy.invalid:8080",
        NODE_EXTRA_CA_CERTS: "/certs/company ca.pem",
        VQA_BROWSER_MIRROR: "https://mirror.example.invalid/playwright",
      },
      installer: async (request) => {
        captured = request.environment;
        await fakePayload(request);
      },
    });
    const result = await installBrowser(scope);
    expect(captured?.HTTPS_PROXY).toBe("http://proxy.invalid:8080");
    expect(captured?.NODE_EXTRA_CA_CERTS).toBe("/certs/company ca.pem");
    expect(captured?.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST).toBe("https://mirror.example.invalid/playwright");
    expect(result.status.configuration).toEqual({ proxy: true, customCertificateAuthority: true, mirror: true, offline: false });
  });

  it("fails offline without changing the cache and rejects non-HTTPS mirrors", async () => {
    const cacheRoot = join(testRoot("offline"), "cache");
    const installer = vi.fn(fakePayload);
    await expect(installBrowser(manager(cacheRoot, {
      environment: { VQA_BROWSER_CACHE: cacheRoot, VQA_BROWSER_OFFLINE: "1" },
      installer,
    }))).rejects.toThrow(BROWSER_RECOVERY_COMMAND);
    expect(installer).not.toHaveBeenCalled();

    await expect(installBrowser(manager(join(testRoot("mirror"), "cache"), {
      environment: { VQA_BROWSER_CACHE: join(testRoot("bad-mirror"), "cache"), VQA_BROWSER_MIRROR: "http://mirror.invalid" },
    }))).rejects.toThrow("HTTPS URL");
  });

  it("reports a read-only home/cache failure without privilege escalation", async () => {
    if (process.platform === "win32") return;
    const root = testRoot("readonly");
    await chmod(root, 0o500);
    try {
      await expect(installBrowser(manager(join(root, "cache")))).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("refuses a cache override containing foreign data and never deletes it", async () => {
    const cacheRoot = join(testRoot("foreign"), "cache");
    await mkdir(cacheRoot);
    await writeFile(join(cacheRoot, "foreign-browser"), "untouched");
    await expect(installBrowser(manager(cacheRoot))).rejects.toThrow("not owned by Viewport QA");
    const removed = await removeBrowser(manager(cacheRoot));
    expect(removed.changed).toBe(false);
    expect(await readFile(join(cacheRoot, "foreign-browser"), "utf8")).toBe("untouched");
  });

  it("refuses a symlink cache root without touching its target", async () => {
    if (process.platform === "win32") return;
    const root = testRoot("symlink");
    const foreign = join(root, "foreign");
    const cacheRoot = join(root, "cache-link");
    await mkdir(foreign);
    await writeFile(join(foreign, "keep"), "foreign");
    await symlink(foreign, cacheRoot, "dir");
    await expect(installBrowser(manager(cacheRoot))).rejects.toThrow("symlink component");
    expect(await readFile(join(foreign, "keep"), "utf8")).toBe("foreign");
  });

  it("rejects an intermediate executable-directory symlink and preserves outside data", async () => {
    if (process.platform === "win32") return;
    const root = testRoot("executable-symlink");
    const cacheRoot = join(root, "cache");
    const scope = manager(cacheRoot);
    const installed = await installBrowser(scope);
    const executableDirectory = dirname(installed.status.executablePath);
    const outside = join(root, "outside-browser");
    await rename(executableDirectory, outside);
    await writeFile(join(outside, "foreign-sentinel"), "preserve");
    await symlink(outside, executableDirectory, "dir");

    await expect(compatibleBrowserExecutablePath(scope)).rejects.toThrow("integrity manifest");
    expect(await readFile(join(outside, "foreign-sentinel"), "utf8")).toBe("preserve");
  });

  it("requires a private current-user cache and safely tightens owned permissions", async () => {
    if (process.platform === "win32") return;
    const cacheRoot = join(testRoot("permissions"), "cache");
    const scope = manager(cacheRoot);
    await installBrowser(scope);
    await chmod(cacheRoot, 0o777);
    const insecure = await browserStatus(scope);
    expect(insecure.ok).toBe(false);
    expect(insecure.diagnostics[0]?.code).toBe("cache-unavailable");

    const repairedPermissions = await installBrowser(scope);
    expect(repairedPermissions.status.ok).toBe(true);
    expect((await lstat(cacheRoot)).mode & 0o077).toBe(0);
  });

  it("garbage-collects only complete inactive Viewport QA revisions during version movement", async () => {
    const cacheRoot = join(testRoot("gc"), "cache");
    const scope = manager(cacheRoot);
    const first = await installBrowser(scope);
    const inactive = join(cacheRoot, "pw-0.0.0-chromium-1");
    await rename(first.status.revisionRoot, inactive);
    const inactiveMarkerPath = join(inactive, ".viewport-qa-revision.json");
    const inactiveMarker = JSON.parse(await readFile(inactiveMarkerPath, "utf8")) as {
      compatibility: { playwrightVersion: string; browserRevision: string; browserVersion: string };
    };
    inactiveMarker.compatibility.playwrightVersion = "0.0.0";
    inactiveMarker.compatibility.browserRevision = "1";
    inactiveMarker.compatibility.browserVersion = "1.0.0.0";
    await writeFile(inactiveMarkerPath, `${JSON.stringify(inactiveMarker)}\n`);
    const foreign = join(cacheRoot, "pw-foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, "keep"), "foreign");

    const preserved = await installBrowser(scope, { garbageCollect: false });
    expect(preserved.removedRevisionRoots).toEqual([]);
    expect(await readFile(inactiveMarkerPath, "utf8")).toContain('"browserRevision":"1"');

    const moved = await installBrowser(scope, { garbageCollect: true });
    expect(moved.removedRevisionRoots).toContain(inactive);
    expect(await readFile(join(foreign, "keep"), "utf8")).toBe("foreign");
  });

  it("preserves an inactive directory with a spoofed incomplete ownership marker", async () => {
    const cacheRoot = join(testRoot("gc-spoof"), "cache");
    const scope = manager(cacheRoot);
    await installBrowser(scope);
    const spoof = join(cacheRoot, "pw-9.9.9-chromium-9999");
    await mkdir(spoof);
    await writeFile(join(spoof, ".viewport-qa-revision.json"), `${JSON.stringify({ managedBy: "viewport-qa-browser-manager-v1" })}\n`);
    await writeFile(join(spoof, "foreign-sentinel"), "preserve");

    await installBrowser(scope);
    expect(await readFile(join(spoof, "foreign-sentinel"), "utf8")).toBe("preserve");
  });

  it("preserves spoofed incomplete staging and backup directories", async () => {
    const cacheRoot = join(testRoot("recovery-spoof"), "cache");
    const scope = manager(cacheRoot);
    const installed = await installBrowser(scope);
    const staging = `${installed.status.revisionRoot}.staging-${NONCE_A}`;
    const backup = `${installed.status.revisionRoot}.backup-${NONCE_B}`;
    for (const candidate of [staging, backup]) {
      await mkdir(candidate);
      await writeFile(join(candidate, ".viewport-qa-staging.json"), `${JSON.stringify({ managedBy: "viewport-qa-browser-manager-v1" })}\n`);
      await writeFile(join(candidate, ".viewport-qa-revision.json"), `${JSON.stringify({ managedBy: "viewport-qa-browser-manager-v1" })}\n`);
      await writeFile(join(candidate, "foreign-sentinel"), "preserve");
    }

    await installBrowser(scope);
    expect(await readFile(join(staging, "foreign-sentinel"), "utf8")).toBe("preserve");
    expect(await readFile(join(backup, "foreign-sentinel"), "utf8")).toBe("preserve");
  });

  it("reports OS-specific native-library diagnostics", async () => {
    const diagnostic = nativeLibraryDiagnostic(
      "libnss3.so: cannot open shared object file",
      "linux",
    );
    expect(diagnostic?.code).toBe("missing-native-libraries");
    expect(diagnostic?.remediation.join(" ")).toContain("administrator");
    expect(nativeLibraryDiagnostic("unrelated launch failure", "linux")).toBeUndefined();
  });
});
