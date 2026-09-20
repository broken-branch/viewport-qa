import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { launchSandboxedChromium } from "./browser-launch.js";
import { isLinkFreeExistingPath, linkFreeDirectoryIdentity, sameDirectoryIdentity } from "./path-safety.js";
import type { DirectoryIdentity } from "./path-safety.js";

const require = createRequire(import.meta.url);
const CACHE_MARKER = ".viewport-qa-browser-cache-v1";
const REVISION_MARKER = ".viewport-qa-revision.json";
const STAGING_MARKER = ".viewport-qa-staging.json";
const LOCK_NAME = ".install.lock";
const MANAGED_BY = "viewport-qa-browser-manager-v1";
const LOCK_WAIT_MS = 30_000;
const WINDOWS_PROBE_LAUNCH_TIMEOUT_MS = 10_000;
const WINDOWS_PROBE_OUTER_TIMEOUT_MS = 12_000;
const WINDOWS_PROBE_CLOSE_TIMEOUT_MS = 5_000;
const STAGING_REMOVE_RETRIES = 8;
const STAGING_REMOVE_RETRY_DELAY_MS = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let windowsRuntimeProbeGeneration = 0;
let successfulWindowsRuntimeProbe: { key: string; result: BrowserProbeResult } | undefined;
let inFlightWindowsRuntimeProbe: {
  generation: number;
  key: string;
  promise: Promise<BrowserProbeResult>;
} | undefined;

export const BROWSER_STATUS_SCHEMA_VERSION = 1 as const;
export const BROWSER_RECOVERY_COMMAND = "vqa browser install" as const;

interface PlaywrightBrowserEntry {
  name: string;
  revision: string;
  browserVersion: string;
  installByDefault: boolean;
}

interface PlaywrightBrowserRegistry {
  browsers: PlaywrightBrowserEntry[];
}

export interface BrowserCompatibility {
  playwrightVersion: string;
  browser: "chromium";
  browserRevision: string;
  browserVersion: string;
  payload: "full-chromium";
}

export type BrowserHealth = "installed" | "missing" | "corrupt";

export interface BrowserDiagnostic {
  code:
    | "browser-missing"
    | "browser-corrupt"
    | "cache-unavailable"
    | "missing-native-libraries";
  message: string;
  remediation: string[];
}

export interface BrowserStatus {
  schemaVersion: typeof BROWSER_STATUS_SCHEMA_VERSION;
  ok: boolean;
  health: BrowserHealth;
  compatibility: BrowserCompatibility;
  cacheRoot: string;
  revisionRoot: string;
  executablePath: string;
  cacheOverride: boolean;
  configuration: {
    proxy: boolean;
    customCertificateAuthority: boolean;
    mirror: boolean;
    offline: boolean;
  };
  diagnostics: BrowserDiagnostic[];
  recoveryCommand?: typeof BROWSER_RECOVERY_COMMAND;
}

interface RevisionMarker {
  managedBy: typeof MANAGED_BY;
  state: "complete";
  compatibility: BrowserCompatibility;
  installedAt: string;
  payloadManifest: PayloadManifest;
}

interface PayloadManifest {
  algorithm: "sha256";
  files: Array<{ path: string; size: number; sha256: string } | { path: string; link: string }>;
}

interface StagingMarker {
  managedBy: typeof MANAGED_BY;
  state: "staging";
  revision: string;
  nonce: string;
  createdAt: string;
}

interface InstallLockOwner {
  managedBy: typeof MANAGED_BY;
  state: "locked";
  pid: number;
  nonce: string;
  createdAt: string;
}

export interface BrowserManagerEnvironment {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppData?: string;
  now?: () => Date;
  installer?: (request: BrowserInstallerRequest) => Promise<void>;
  probe?: (executablePath: string) => Promise<BrowserProbeResult>;
  probeLauncher?: typeof launchSandboxedChromium;
  configureWindowsSandbox?: (executablePath: string) => Promise<void>;
  /** @internal Test seam invoked before identity-fenced staging removal. */
  beforeStagingRemove?: (attempt: number) => Promise<void>;
  /** @internal Test seam invoked after the complete revision marker writes and before promotion. */
  afterRevisionMarkerWrite?: () => Promise<void> | void;
  afterInstallLockObserved?: () => Promise<void> | void;
  beforeInstallLockCreate?: () => Promise<void> | void;
  processAlive?: (pid: number) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  pid?: number;
}

export interface BrowserInstallerRequest {
  stagingRoot: string;
  executablePath: string;
  cliPath: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface BrowserProbeResult {
  ok: boolean;
  detail?: string;
  version?: string;
}

interface BrowserPaths {
  cacheRoot: string;
  revisionRoot: string;
  executablePath: string;
  executableRelativePath: string;
  cacheOverride: boolean;
}

function playwrightFiles(): {
  compatibility: BrowserCompatibility;
  cliPath: string;
  defaultExecutablePath: string;
} {
  const packagePath = require.resolve("playwright/package.json");
  const packageJson = require(packagePath) as { version: string };
  const dependencyRoot = dirname(dirname(packagePath));
  const coreRoot = join(dependencyRoot, "playwright-core");
  const registry = require(join(coreRoot, "browsers.json")) as PlaywrightBrowserRegistry;
  const browser = registry.browsers.find((entry) => entry.name === "chromium");
  if (!browser) throw new Error("Pinned Playwright metadata does not declare Chromium");
  return {
    compatibility: {
      playwrightVersion: packageJson.version,
      browser: "chromium",
      browserRevision: browser.revision,
      browserVersion: browser.browserVersion,
      payload: "full-chromium",
    },
    cliPath: join(coreRoot, "cli.js"),
    defaultExecutablePath: chromium.executablePath(),
  };
}

export function browserCompatibility(): BrowserCompatibility {
  return playwrightFiles().compatibility;
}

function defaultCacheRoot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
  localAppData?: string,
): string {
  if (environment.VQA_BROWSER_CACHE) {
    if (!isAbsolute(environment.VQA_BROWSER_CACHE)) throw new Error("VQA_BROWSER_CACHE must be an absolute path");
    return resolve(environment.VQA_BROWSER_CACHE);
  }
  if (platform === "win32") {
    const base = localAppData ?? environment.LOCALAPPDATA;
    if (!base) throw new Error("LOCALAPPDATA is unavailable; set VQA_BROWSER_CACHE to an absolute writable path");
    return resolve(base, "Viewport QA", "browser-cache");
  }
  if (!homeDirectory) throw new Error("Home directory is unavailable; set VQA_BROWSER_CACHE to an absolute writable path");
  if (platform === "darwin") {
    return resolve(homeDirectory, "Library", "Caches", "Viewport QA", "browser-cache");
  }
  return resolve(environment.XDG_CACHE_HOME ?? join(homeDirectory, ".cache"), "viewport-qa", "browser-cache");
}

function getPaths(manager: BrowserManagerEnvironment = {}): BrowserPaths {
  const environment = manager.environment ?? process.env;
  const platform = manager.platform ?? hostPlatform();
  const files = playwrightFiles();
  const cacheRoot = defaultCacheRoot(
    environment,
    platform,
    manager.homeDirectory ?? homedir(),
    manager.localAppData,
  );
  const executableSegments = files.defaultExecutablePath.split(sep);
  const browserDirectoryIndex = executableSegments.findIndex(
    (segment) => segment === `chromium-${files.compatibility.browserRevision}`,
  );
  if (browserDirectoryIndex < 0) {
    throw new Error("Pinned Playwright Chromium executable layout is unsupported");
  }
  const executableRelativePath = executableSegments
    .slice(browserDirectoryIndex)
    .join(sep);
  const revisionRoot = join(
    cacheRoot,
    `pw-${files.compatibility.playwrightVersion}-chromium-${files.compatibility.browserRevision}`,
  );
  return {
    cacheRoot,
    revisionRoot,
    executablePath: join(revisionRoot, executableRelativePath),
    executableRelativePath,
    cacheOverride: Boolean(environment.VQA_BROWSER_CACHE),
  };
}

function configuration(environment: NodeJS.ProcessEnv): BrowserStatus["configuration"] {
  return {
    proxy: Boolean(environment.HTTPS_PROXY ?? environment.HTTP_PROXY),
    customCertificateAuthority: Boolean(environment.NODE_EXTRA_CA_CERTS),
    mirror: Boolean(environment.VQA_BROWSER_MIRROR),
    offline: environment.VQA_BROWSER_OFFLINE === "1",
  };
}

function browserStatusPaths(paths: BrowserPaths): Pick<BrowserStatus, "cacheRoot" | "revisionRoot" | "executablePath" | "cacheOverride"> {
  return {
    cacheRoot: paths.cacheRoot,
    revisionRoot: paths.revisionRoot,
    executablePath: paths.executablePath,
    cacheOverride: paths.cacheOverride,
  };
}

function privateCacheDirectory(value: Awaited<ReturnType<typeof lstat>>, platform: NodeJS.Platform): boolean {
  if (!value.isDirectory() || value.isSymbolicLink()) return false;
  if (platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && Number(value.uid) === uid && (Number(value.mode) & 0o077) === 0;
}

function bundledReadOnlyCacheDirectory(
  value: Awaited<ReturnType<typeof lstat>>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (environment.VQA_BROWSER_OFFLINE !== "1" || environment.VQA_BROWSER_BUNDLED_READONLY !== "1") return false;
  if (!value.isDirectory() || value.isSymbolicLink() || platform === "win32") return false;
  return (Number(value.mode) & 0o777) === 0o555;
}

/** @internal Exported for platform-classifier mutation discrimination. */
export function nativeLibraryDiagnostic(detail: string, platform: NodeJS.Platform): BrowserDiagnostic | undefined {
  if (!/shared librar|cannot open shared object|dll|dyld|library not loaded/iu.test(detail)) return undefined;
  const remediation = platform === "linux"
    ? [
        "Ask an administrator to install the Chromium system libraries for the pinned Playwright release.",
        "On supported Debian/Ubuntu development hosts, an administrator may run: pnpm --filter @vqa/engine exec playwright install-deps chromium",
      ]
    : platform === "win32"
      ? ["Ask an administrator to install current Windows updates and the supported Microsoft Visual C++ runtime; Viewport QA never elevates or installs it."]
      : ["Ask an administrator to update macOS to a version supported by the pinned Playwright release; Viewport QA never elevates or changes system libraries."];
  return {
    code: "missing-native-libraries",
    message: `Chromium is present but cannot start because an operating-system library is missing: ${detail.trim()}`,
    remediation,
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeProbeBrowser(browser: Awaited<ReturnType<typeof launchSandboxedChromium>>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Chromium probe cleanup timed out after ${WINDOWS_PROBE_CLOSE_TIMEOUT_MS}ms`)), WINDOWS_PROBE_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function windowsProbe(
  executablePath: string,
  launcher: typeof launchSandboxedChromium = launchSandboxedChromium,
): Promise<BrowserProbeResult> {
  let browser: Awaited<ReturnType<typeof launchSandboxedChromium>> | undefined;
  let outerTimer: NodeJS.Timeout | undefined;
  let expired = false;
  let result: BrowserProbeResult;
  const launch = launcher({
    executablePath,
    headless: true,
    timeout: WINDOWS_PROBE_LAUNCH_TIMEOUT_MS,
  });
  try {
    browser = await Promise.race([
      launch,
      new Promise<never>((_resolve, reject) => {
        outerTimer = setTimeout(() => {
          expired = true;
          reject(new Error(`Chromium sandboxed probe timed out after ${WINDOWS_PROBE_OUTER_TIMEOUT_MS}ms`));
        }, WINDOWS_PROBE_OUTER_TIMEOUT_MS);
      }),
    ]);
    const detail = browser.version().trim();
    const version = /(\d+\.\d+\.\d+\.\d+)/u.exec(detail)?.[1];
    result = version
      ? { ok: true, detail, version }
      : { ok: false, detail: `Chromium version is unrecognized: ${detail}` };
  } catch (error) {
    result = { ok: false, detail: errorDetail(error) };
  } finally {
    if (outerTimer) clearTimeout(outerTimer);
  }
  if (browser) {
    try {
      await closeProbeBrowser(browser);
    } catch (error) {
      if (!expired) result = { ok: false, detail: errorDetail(error) };
    }
  } else if (expired) {
    void launch.then((lateBrowser) => closeProbeBrowser(lateBrowser)).catch(() => {});
  }
  return result;
}

async function defaultProbe(
  executablePath: string,
  platform: NodeJS.Platform,
  probeLauncher?: typeof launchSandboxedChromium,
): Promise<BrowserProbeResult> {
  if (platform === "win32") return windowsProbe(executablePath, probeLauncher);
  return new Promise((resolvePromise) => {
    execFile(executablePath, ["--version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        resolvePromise({ ok: false, detail: `${stderr || stdout || error.message}`.trim() });
        return;
      }
      const detail = stdout.trim();
      const version = /(\d+\.\d+\.\d+\.\d+)/u.exec(detail)?.[1];
      if (!version) {
        resolvePromise({ ok: false, detail: `Chromium version output is unrecognized: ${detail}` });
        return;
      }
      resolvePromise({ ok: true, detail, version });
    });
  });
}

function resolveProbe(manager: BrowserManagerEnvironment, platform: NodeJS.Platform): (path: string) => Promise<BrowserProbeResult> {
  return manager.probe ?? ((path) => defaultProbe(path, platform, manager.probeLauncher));
}

function invalidateWindowsRuntimeProbe(): void {
  windowsRuntimeProbeGeneration += 1;
  successfulWindowsRuntimeProbe = undefined;
  inFlightWindowsRuntimeProbe = undefined;
}

async function windowsRuntimeProbeKey(
  root: string,
  executablePath: string,
  marker: RevisionMarker,
  compatibility: BrowserCompatibility,
): Promise<string | undefined> {
  const rootIdentity = await linkFreeDirectoryIdentity(root, "win32");
  if (!rootIdentity) return undefined;
  const executable = await lstat(executablePath);
  if (!executable.isFile() || executable.isSymbolicLink()) return undefined;
  const manifestIdentity = createHash("sha256").update(JSON.stringify(marker.payloadManifest)).digest("hex");
  return [
    resolve(root).toLowerCase(),
    resolve(executablePath).toLowerCase(),
    rootIdentity.dev,
    rootIdentity.ino,
    compatibility.playwrightVersion,
    compatibility.browserRevision,
    compatibility.browserVersion,
    marker.installedAt,
    manifestIdentity,
    executable.dev,
    executable.ino,
    executable.size,
    executable.mode,
    executable.mtimeMs,
    executable.ctimeMs,
    executable.birthtimeMs,
  ].join("\0");
}

async function cachedWindowsRuntimeProbe(
  key: string,
  expectedVersion: string,
  probe: () => Promise<BrowserProbeResult>,
): Promise<BrowserProbeResult> {
  if (successfulWindowsRuntimeProbe?.key === key) return successfulWindowsRuntimeProbe.result;
  const generation = windowsRuntimeProbeGeneration;
  if (inFlightWindowsRuntimeProbe?.key === key && inFlightWindowsRuntimeProbe.generation === generation) {
    return inFlightWindowsRuntimeProbe.promise;
  }
  const promise = (async () => {
    const observed = await probe();
    if (!observed.ok || observed.version !== expectedVersion) return observed;
    if (windowsRuntimeProbeGeneration === generation) {
      successfulWindowsRuntimeProbe = { key, result: observed };
    }
    return observed;
  })();
  inFlightWindowsRuntimeProbe = { generation, key, promise };
  try {
    return await promise;
  } finally {
    if (inFlightWindowsRuntimeProbe?.promise === promise) inFlightWindowsRuntimeProbe = undefined;
  }
}

async function configureWindowsSandbox(executablePath: string, revisionRoot: string): Promise<void> {
  const browserDirectory = dirname(executablePath);
  const setupPath = join(browserDirectory, "setup.exe");
  if (!await regularExecutable(setupPath, revisionRoot, "win32")) {
    throw new Error("Downloaded Chrome for Testing is missing its Windows sandbox permission configurator");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      setupPath,
      [`--configure-browser-in-directory=${browserDirectory}`],
      { timeout: 30_000, windowsHide: true },
      (error) => {
        const exitCode = error ? (error as unknown as { code?: string | number }).code : 0;
        if (exitCode === 78) {
          resolvePromise();
          return;
        }
        if (error && (exitCode === "ENOENT" || error.killed)) {
          rejectPromise(new Error("Chrome for Testing could not configure its Windows sandbox permissions"));
          return;
        }
        rejectPromise(new Error(`Chrome for Testing sandbox permission setup returned ${String(exitCode)}; expected documented success code 78`));
      },
    );
  });
}

async function regularExecutable(path: string, revisionRoot: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!await isLinkFreeExistingPath(revisionRoot, platform) || !await isLinkFreeExistingPath(path, platform)) return false;
    assertInside(revisionRoot, path);
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) return false;
    if (platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", rejectPromise);
  });
  return hash.digest("hex");
}

function comparePayloadPaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function payloadManifest(root: string): Promise<PayloadManifest> {
  const files: PayloadManifest["files"] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory)).sort(comparePayloadPaths)) {
      if (!prefix && (entry === REVISION_MARKER || entry === STAGING_MARKER)) continue;
      const path = join(directory, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const value = await lstat(path);
      if (value.isSymbolicLink()) {
        const link = await readlink(path);
        if (isAbsolute(link)) throw new Error(`Browser payload contains an absolute symlink: ${relativePath}`);
        const target = await realpath(path);
        assertInside(root, target);
        files.push({ path: relativePath, link });
        continue;
      }
      if (value.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!value.isFile()) throw new Error(`Browser payload contains a non-file entry: ${relativePath}`);
      files.push({ path: relativePath, size: value.size, sha256: await sha256File(path) });
    }
  }
  await visit(root, "");
  return { algorithm: "sha256", files: files.sort((left, right) => comparePayloadPaths(left.path, right.path)) };
}

async function payloadMatchesManifest(root: string, expected: PayloadManifest): Promise<boolean> {
  try {
    const actual = await payloadManifest(root);
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function compatibleMarker(marker: RevisionMarker | undefined, compatibility: BrowserCompatibility): marker is RevisionMarker {
  return marker?.managedBy === MANAGED_BY &&
    marker.state === "complete" &&
    marker.compatibility?.browser === compatibility.browser &&
    marker.compatibility.playwrightVersion === compatibility.playwrightVersion &&
    marker.compatibility.browserRevision === compatibility.browserRevision &&
    marker.compatibility.browserVersion === compatibility.browserVersion &&
    marker.compatibility.payload === compatibility.payload &&
    validTimestamp(marker.installedAt) &&
    validPayloadManifest(marker.payloadManifest);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function structurallyCompleteRevisionMarker(marker: RevisionMarker | undefined): marker is RevisionMarker {
  return marker?.managedBy === MANAGED_BY &&
    marker.state === "complete" &&
    marker.compatibility?.browser === "chromium" &&
    typeof marker.compatibility.playwrightVersion === "string" && marker.compatibility.playwrightVersion.length > 0 &&
    /^\d+$/u.test(marker.compatibility.browserRevision) &&
    typeof marker.compatibility.browserVersion === "string" && marker.compatibility.browserVersion.length > 0 &&
    marker.compatibility.payload === "full-chromium" &&
    validTimestamp(marker.installedAt) &&
    validPayloadManifest(marker.payloadManifest);
}

function validPayloadManifest(value: PayloadManifest | undefined): value is PayloadManifest {
  if (value?.algorithm !== "sha256" || !Array.isArray(value.files) || value.files.length === 0) return false;
  let previous = "";
  for (const file of value.files) {
    if (
      typeof file.path !== "string" || file.path.length === 0 || file.path.includes("\\") ||
      file.path.startsWith("/") || file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      comparePayloadPaths(file.path, previous) <= 0
    ) return false;
    if ("link" in file) {
      if (typeof file.link !== "string" || file.link.length === 0 || isAbsolute(file.link)) return false;
    } else if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/u.test(file.sha256)) return false;
    previous = file.path;
  }
  return true;
}

async function revisionHealthy(
  root: string,
  executablePath: string,
  compatibility: BrowserCompatibility,
  platform: NodeJS.Platform,
  probe: (path: string) => Promise<BrowserProbeResult>,
  cacheDefaultWindowsProbe = false,
): Promise<BrowserProbeResult> {
  const marker = await readJson<RevisionMarker>(join(root, REVISION_MARKER));
  if (!compatibleMarker(marker, compatibility)) {
    if (cacheDefaultWindowsProbe) invalidateWindowsRuntimeProbe();
    return { ok: false, detail: "managed revision metadata is missing or incompatible" };
  }
  if (!await payloadMatchesManifest(root, marker.payloadManifest)) {
    if (cacheDefaultWindowsProbe) invalidateWindowsRuntimeProbe();
    return { ok: false, detail: "the managed browser payload no longer matches its installed integrity manifest" };
  }
  if (!await regularExecutable(executablePath, root, platform)) {
    if (cacheDefaultWindowsProbe) invalidateWindowsRuntimeProbe();
    return { ok: false, detail: "the compatible Chromium executable is missing, linked, outside the revision root, or not executable" };
  }
  const runtimeProbeKey = cacheDefaultWindowsProbe
    ? await windowsRuntimeProbeKey(root, executablePath, marker, compatibility)
    : undefined;
  if (cacheDefaultWindowsProbe && !runtimeProbeKey) {
    invalidateWindowsRuntimeProbe();
    return { ok: false, detail: "the compatible Chromium runtime identity could not be verified" };
  }
  const observed = runtimeProbeKey
    ? await cachedWindowsRuntimeProbe(runtimeProbeKey, compatibility.browserVersion, () => probe(executablePath))
    : await probe(executablePath);
  if (!observed.ok) {
    if (cacheDefaultWindowsProbe) invalidateWindowsRuntimeProbe();
    return observed;
  }
  if (observed.version !== compatibility.browserVersion) {
    if (cacheDefaultWindowsProbe) invalidateWindowsRuntimeProbe();
    return {
      ok: false,
      detail: `Chromium version mismatch: expected ${compatibility.browserVersion}, observed ${observed.version ?? "unknown"}`,
      ...(observed.version ? { version: observed.version } : {}),
    };
  }
  return observed;
}

async function browserStatusInternal(
  manager: BrowserManagerEnvironment,
  cacheDefaultWindowsProbe: boolean,
): Promise<BrowserStatus> {
  const environment = manager.environment ?? process.env;
  const platform = manager.platform ?? hostPlatform();
  const compatibility = browserCompatibility();
  let paths: BrowserPaths;
  try {
    paths = getPaths(manager);
  } catch (error) {
    const cacheRoot = environment.VQA_BROWSER_CACHE ?? "(unavailable)";
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: BROWSER_STATUS_SCHEMA_VERSION,
      ok: false,
      health: "missing",
      compatibility,
      cacheRoot,
      revisionRoot: "",
      executablePath: "",
      cacheOverride: Boolean(environment.VQA_BROWSER_CACHE),
      configuration: configuration(environment),
      diagnostics: [{ code: "cache-unavailable", message, remediation: ["Set VQA_BROWSER_CACHE to an absolute writable path and retry."] }],
      recoveryCommand: BROWSER_RECOVERY_COMMAND,
    };
  }
  const cacheStat = await lstat(paths.cacheRoot).catch(() => undefined);
  if (cacheStat && !privateCacheDirectory(cacheStat, platform) && !bundledReadOnlyCacheDirectory(cacheStat, environment, platform)) {
    return {
      schemaVersion: BROWSER_STATUS_SCHEMA_VERSION,
      ok: false,
      health: "corrupt",
      compatibility,
      ...browserStatusPaths(paths),
      configuration: configuration(environment),
      diagnostics: [{
        code: "cache-unavailable",
        message: "The Viewport QA browser cache root is neither a private current-user cache nor an explicitly bundled read-only offline cache.",
        remediation: ["Set VQA_BROWSER_CACHE to a different absolute writable path, or use the offline bundle launcher."],
      }],
      recoveryCommand: BROWSER_RECOVERY_COMMAND,
    };
  }
  const rootStat = await lstat(paths.revisionRoot).catch(() => undefined);
  if (!rootStat) {
    return {
      schemaVersion: BROWSER_STATUS_SCHEMA_VERSION,
      ok: false,
      health: "missing",
      compatibility,
      ...browserStatusPaths(paths),
      configuration: configuration(environment),
      diagnostics: [{
        code: "browser-missing",
        message: `The compatible Chromium revision ${compatibility.browserRevision} is not installed in the Viewport QA cache.`,
        remediation: [`Run: ${BROWSER_RECOVERY_COMMAND}`],
      }],
      recoveryCommand: BROWSER_RECOVERY_COMMAND,
    };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return {
      schemaVersion: BROWSER_STATUS_SCHEMA_VERSION,
      ok: false,
      health: "corrupt",
      compatibility,
      ...browserStatusPaths(paths),
      configuration: configuration(environment),
      diagnostics: [{ code: "browser-corrupt", message: "The managed revision path is not a private directory.", remediation: ["Run: vqa browser repair"] }],
      recoveryCommand: BROWSER_RECOVERY_COMMAND,
    };
  }
  const probe = await revisionHealthy(
    paths.revisionRoot,
    paths.executablePath,
    compatibility,
    platform,
    resolveProbe(manager, platform),
    cacheDefaultWindowsProbe && platform === "win32" && manager.probe === undefined && manager.probeLauncher === undefined,
  );
  if (probe.ok) {
    return {
      schemaVersion: BROWSER_STATUS_SCHEMA_VERSION,
      ok: true,
      health: "installed",
      compatibility,
      ...browserStatusPaths(paths),
      configuration: configuration(environment),
      diagnostics: [],
    };
  }
  const native = nativeLibraryDiagnostic(probe.detail ?? "", platform);
  return {
    schemaVersion: BROWSER_STATUS_SCHEMA_VERSION,
    ok: false,
    health: "corrupt",
    compatibility,
    ...browserStatusPaths(paths),
    configuration: configuration(environment),
    diagnostics: native ? [native] : [{
      code: "browser-corrupt",
      message: `The compatible browser cache is incomplete or unhealthy${probe.detail ? `: ${probe.detail}` : "."}`,
      remediation: ["Run: vqa browser repair"],
    }],
    recoveryCommand: BROWSER_RECOVERY_COMMAND,
  };
}

export async function browserStatus(manager: BrowserManagerEnvironment = {}): Promise<BrowserStatus> {
  return browserStatusInternal(manager, false);
}

function assertInside(parent: string, child: string): void {
  const path = relative(parent, child);
  if (!path || path.startsWith(`..${sep}`) || path === ".." || resolve(parent, path) !== resolve(child)) {
    throw new Error(`managed browser path escapes its cache root: ${child}`);
  }
}

async function ensureCacheOwnership(cacheRoot: string, platform: NodeJS.Platform): Promise<void> {
  await assertNoSymlinkComponents(cacheRoot);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(cacheRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Browser cache root must be a private non-symlink directory");
  if (platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || rootStat.uid !== uid) throw new Error("Browser cache root must be owned by the current user");
    if ((rootStat.mode & 0o077) !== 0) await chmod(cacheRoot, 0o700);
    if (!privateCacheDirectory(await lstat(cacheRoot), platform)) throw new Error("Browser cache root permissions could not be made private");
  }
  const markerPath = join(cacheRoot, CACHE_MARKER);
  const marker = await readFile(markerPath, "utf8").catch(() => undefined);
  if (marker === `${MANAGED_BY}\n`) return;
  const entries = (await readdir(cacheRoot)).filter((entry) => entry !== CACHE_MARKER);
  if (entries.length > 0) {
    throw new Error("Browser cache override contains data not owned by Viewport QA; choose an empty VQA_BROWSER_CACHE path");
  }
  try {
    await writeFile(markerPath, `${MANAGED_BY}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(markerPath, "utf8").catch(() => undefined) !== `${MANAGED_BY}\n`) {
      throw error;
    }
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const components: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    components.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of components.reverse()) {
    const value = await lstat(component).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (value?.isSymbolicLink()) throw new Error(`Browser cache path contains a symlink component: ${component}`);
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function exactInstallLockOwner(value: InstallLockOwner | undefined, nonce: string): value is InstallLockOwner {
  return value?.managedBy === MANAGED_BY &&
    value.state === "locked" &&
    Number.isInteger(value.pid) && value.pid > 0 &&
    value.nonce === nonce && UUID_PATTERN.test(value.nonce) &&
    validTimestamp(value.createdAt);
}

async function createInstallLockDirectory(
  path: string,
  owner: InstallLockOwner,
  cacheIdentity: DirectoryIdentity,
  manager: BrowserManagerEnvironment,
): Promise<string> {
  await manager.beforeInstallLockCreate?.();
  await mkdir(path, { mode: 0o700 });
  const cacheStillBound = sameDirectoryIdentity(
    cacheIdentity,
    await linkFreeDirectoryIdentity(dirname(path), manager.platform ?? hostPlatform()),
  );
  const createdItem = await lstat(path).catch(() => undefined);
  if (!cacheStillBound || !createdItem?.isDirectory() || createdItem.isSymbolicLink() || !await isLinkFreeExistingPath(path, manager.platform ?? hostPlatform())) {
    await rmdir(path).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
    });
    throw new Error(`Browser install lock parent identity changed; refusing ${path}`);
  }
  const ownerPath = join(path, `owner-${owner.nonce}.json`);
  try {
    const handle = await open(ownerPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return ownerPath;
  } catch (error) {
    await rm(ownerPath, { force: true }).catch(() => {});
    await rmdir(path).catch(() => {});
    throw error;
  }
}

type InstallLockState = "absent" | "live" | "recovered";

async function assertInstallLockParentUnchanged(
  path: string,
  manager: BrowserManagerEnvironment,
  cacheIdentity: DirectoryIdentity,
): Promise<void> {
  const parent = dirname(path);
  if (!sameDirectoryIdentity(cacheIdentity, await linkFreeDirectoryIdentity(parent, manager.platform ?? hostPlatform()))) {
    throw new Error(`Unsafe browser install lock parent changed: ${parent}`);
  }
}

async function assertInstallLockGenerationUnchanged(
  path: string,
  manager: BrowserManagerEnvironment,
  cacheIdentity: DirectoryIdentity,
  lockIdentity: DirectoryIdentity,
): Promise<void> {
  await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
  if (!sameDirectoryIdentity(lockIdentity, await linkFreeDirectoryIdentity(path, manager.platform ?? hostPlatform()))) {
    throw new Error(`Unsafe browser install lock generation changed: ${path}`);
  }
}

async function recoverInstallLockDirectory(
  path: string,
  manager: BrowserManagerEnvironment,
  cacheIdentity: DirectoryIdentity,
): Promise<InstallLockState> {
  const item = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!item) {
    await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
    return "absent";
  }
  await manager.afterInstallLockObserved?.();
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new Error(`Unsafe or legacy browser install lock requires manual inspection: ${path}`);
  }
  const lockIdentity: DirectoryIdentity = { dev: item.dev, ino: item.ino };
  if (!await isLinkFreeExistingPath(path, manager.platform ?? hostPlatform())) {
    const replacement = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!replacement) {
      await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
      return "absent";
    }
    throw new Error(`Unsafe or legacy browser install lock requires manual inspection: ${path}`);
  }
  const entries = await readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!entries) {
    await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
    return "absent";
  }
  const now = (manager.now ?? (() => new Date()))().getTime();
  if (entries.length === 0) {
    if (now - Number(item.mtimeMs) <= 30_000) return "live";
    await assertInstallLockGenerationUnchanged(path, manager, cacheIdentity, lockIdentity);
    try {
      await rmdir(path);
      return "recovered";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
        return "absent";
      }
      if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return "absent";
      throw error;
    }
  }
  if (entries.length !== 1) throw new Error(`Unsafe browser install lock contents require manual inspection: ${path}`);
  const match = /^owner-([0-9a-f-]+)\.json$/u.exec(entries[0]!);
  if (!match || !UUID_PATTERN.test(match[1]!)) {
    throw new Error(`Unsafe browser install lock owner requires manual inspection: ${path}`);
  }
  const nonce = match[1]!;
  const ownerPath = join(path, entries[0]!);
  const ownerItem = await lstat(ownerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!ownerItem) {
    await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
    return "absent";
  }
  if (!ownerItem.isFile() || ownerItem.isSymbolicLink()) {
    throw new Error(`Unsafe browser install lock owner requires manual inspection: ${ownerPath}`);
  }
  if (!await isLinkFreeExistingPath(ownerPath, manager.platform ?? hostPlatform())) {
    const replacement = await lstat(ownerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!replacement) {
      await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
      return "absent";
    }
    throw new Error(`Unsafe browser install lock owner requires manual inspection: ${ownerPath}`);
  }
  const owner = await readJson<InstallLockOwner>(ownerPath);
  const exact = exactInstallLockOwner(owner, nonce);
  if (exact && (manager.processAlive ?? defaultProcessAlive)(owner.pid)) return "live";
  if (!exact && now - ownerItem.mtimeMs <= 30_000) {
    throw new Error(`Incomplete browser install lock is recent and requires retry or inspection: ${ownerPath}`);
  }
  await assertInstallLockGenerationUnchanged(path, manager, cacheIdentity, lockIdentity);
  try {
    await rm(ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
      return "absent";
    }
    throw error;
  }
  await assertInstallLockGenerationUnchanged(path, manager, cacheIdentity, lockIdentity);
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertInstallLockParentUnchanged(path, manager, cacheIdentity);
    } else if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
  return "recovered";
}

async function withInstallLock<T>(
  cacheRoot: string,
  manager: BrowserManagerEnvironment,
  action: () => Promise<T>,
): Promise<T> {
  const path = join(cacheRoot, LOCK_NAME);
  const cacheIdentity = await linkFreeDirectoryIdentity(cacheRoot, manager.platform ?? hostPlatform());
  if (!cacheIdentity) throw new Error(`Browser install lock parent is unsafe: ${cacheRoot}`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const sleep = manager.sleep ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  let ownerPath = "";
  let owner: InstallLockOwner | undefined;
  for (;;) {
    const nonce = randomUUID();
    const candidate: InstallLockOwner = {
      managedBy: MANAGED_BY,
      state: "locked",
      pid: manager.pid ?? process.pid,
      nonce,
      createdAt: (manager.now ?? (() => new Date()))().toISOString(),
    };
    try {
      ownerPath = await createInstallLockDirectory(path, candidate, cacheIdentity, manager);
      owner = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverInstallLockDirectory(path, manager, cacheIdentity);
      if (Date.now() >= deadline) throw new Error("Another Viewport QA browser operation still owns the cache; retry after it finishes");
      await sleep(50);
    }
  }
  let result: T | undefined;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }
  try {
    const current = await readJson<InstallLockOwner>(ownerPath);
    if (!owner || !exactInstallLockOwner(current, owner.nonce) || current.pid !== owner.pid || current.createdAt !== owner.createdAt) {
      throw new Error(`Browser install lock ownership changed; preserving ${path}`);
    }
    await rm(ownerPath);
    try {
      await rmdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (releaseError) {
    if (actionError !== undefined) throw new AggregateError([actionError, releaseError], "Browser operation and lock release both failed");
    throw releaseError;
  }
  if (actionError !== undefined) throw actionError;
  return result!;
}

async function defaultInstaller(request: BrowserInstallerRequest): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [request.cliPath, "install", "chromium", "--no-shell"],
      { env: request.environment, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024, signal: request.signal },
      (error, _stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(`Chromium download failed${stderr.trim() ? `: ${stderr.trim()}` : ". Check network, proxy, custom CA, mirror, or offline settings."}`));
          return;
        }
        resolvePromise();
      },
    );
  });
}

async function nonSymlinkDirectory(path: string): Promise<boolean> {
  const value = await lstat(path).catch(() => undefined);
  if (value?.isDirectory() !== true || value.isSymbolicLink()) return false;
  return isLinkFreeExistingPath(path);
}

async function exactRevisionDirectory(path: string, compatibility: BrowserCompatibility): Promise<boolean> {
  if (!await nonSymlinkDirectory(path)) return false;
  return compatibleMarker(
    await readJson<RevisionMarker>(join(path, REVISION_MARKER)),
    compatibility,
  );
}

async function exactBackupDirectory(
  path: string,
  revisionRoot: string,
  compatibility: BrowserCompatibility,
): Promise<boolean> {
  const prefix = `${basename(revisionRoot)}.backup-`;
  const name = basename(path);
  if (!name.startsWith(prefix) || !UUID_PATTERN.test(name.slice(prefix.length))) return false;
  return exactRevisionDirectory(path, compatibility);
}

async function exactStagingDirectory(
  path: string,
  revisionRoot: string,
  compatibility: BrowserCompatibility,
  expectedNonce?: string,
): Promise<boolean> {
  if (!await exactStagingMarker(path, compatibility, expectedNonce)) return false;
  const marker = await readJson<StagingMarker>(join(path, STAGING_MARKER));
  return basename(path) === `${basename(revisionRoot)}.staging-${marker!.nonce}`;
}

async function exactStagingMarker(
  path: string,
  compatibility: BrowserCompatibility,
  expectedNonce?: string,
): Promise<boolean> {
  if (!await nonSymlinkDirectory(path)) return false;
  const marker = await readJson<StagingMarker>(join(path, STAGING_MARKER));
  if (
    marker?.managedBy !== MANAGED_BY ||
    marker.state !== "staging" ||
    marker.revision !== compatibility.browserRevision ||
    !UUID_PATTERN.test(marker.nonce) ||
    !validTimestamp(marker.createdAt) ||
    (expectedNonce !== undefined && marker.nonce !== expectedNonce)
  ) return false;
  return true;
}

type RemoveOwnedStagingDependencies = {
  platform?: NodeJS.Platform;
  beforeRemove?: (attempt: number) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** @internal Exported for bounded Windows-lock and replacement-race discrimination. */
export async function removeOwnedStagingDirectory(
  path: string,
  revisionRoot: string,
  compatibility: BrowserCompatibility,
  expectedNonce: string,
  dependencies: RemoveOwnedStagingDependencies = {},
): Promise<void> {
  if (!await exactStagingDirectory(path, revisionRoot, compatibility, expectedNonce)) {
    throw new Error(`Refusing to remove browser staging without exact operation ownership: ${path}`);
  }
  const platform = dependencies.platform ?? hostPlatform();
  const parent = dirname(path);
  const parentIdentity = await linkFreeDirectoryIdentity(parent, platform);
  const stagingIdentity = await linkFreeDirectoryIdentity(path, platform);
  if (!parentIdentity || !stagingIdentity) throw new Error(`Browser staging identity is unavailable: ${path}`);
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));

  for (let attempt = 0; ; attempt += 1) {
    if (!sameDirectoryIdentity(parentIdentity, await linkFreeDirectoryIdentity(parent, platform))) {
      throw new Error(`Browser staging parent identity changed during cleanup: ${parent}`);
    }
    const currentIdentity = await linkFreeDirectoryIdentity(path, platform);
    if (!currentIdentity) return;
    if (!sameDirectoryIdentity(stagingIdentity, currentIdentity)) {
      throw new Error(`Browser staging identity changed during cleanup: ${path}`);
    }
    if (!await exactStagingDirectory(path, revisionRoot, compatibility, expectedNonce)) {
      throw new Error(`Browser staging marker generation changed during cleanup: ${path}`);
    }
    try {
      await dependencies.beforeRemove?.(attempt);
      if (!sameDirectoryIdentity(parentIdentity, await linkFreeDirectoryIdentity(parent, platform))) {
        throw new Error(`Browser staging parent identity changed immediately before cleanup: ${parent}`);
      }
      if (
        !sameDirectoryIdentity(stagingIdentity, await linkFreeDirectoryIdentity(path, platform)) ||
        !await exactStagingDirectory(path, revisionRoot, compatibility, expectedNonce)
      ) {
        throw new Error(`Browser staging generation changed immediately before cleanup: ${path}`);
      }
      await rm(path, { recursive: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has(code ?? "") || attempt >= STAGING_REMOVE_RETRIES) {
          throw error;
        }
        await sleep((attempt + 1) * STAGING_REMOVE_RETRY_DELAY_MS);
        continue;
      }
    }
    if (!sameDirectoryIdentity(parentIdentity, await linkFreeDirectoryIdentity(parent, platform))) {
      throw new Error(`Browser staging parent identity changed after cleanup: ${parent}`);
    }
    const remainingIdentity = await linkFreeDirectoryIdentity(path, platform);
    if (remainingIdentity) {
      throw new Error(
        sameDirectoryIdentity(stagingIdentity, remainingIdentity)
          ? `Browser staging cleanup reported success but the owned generation remains: ${path}`
          : `Browser staging replacement appeared during cleanup: ${path}`,
      );
    }
    return;
  }
}

async function selfDescribingInactiveRevisionDirectory(path: string): Promise<boolean> {
  if (!await nonSymlinkDirectory(path)) return false;
  const marker = await readJson<RevisionMarker>(join(path, REVISION_MARKER));
  if (!structurallyCompleteRevisionMarker(marker)) return false;
  return basename(path) === `pw-${marker.compatibility.playwrightVersion}-chromium-${marker.compatibility.browserRevision}`;
}

async function recoverInterrupted(
  paths: BrowserPaths,
  compatibility: BrowserCompatibility,
  manager: BrowserManagerEnvironment,
): Promise<void> {
  const entries = await readdir(paths.cacheRoot);
  const backupPrefix = `${basename(paths.revisionRoot)}.backup-`;
  const stagingPrefix = `${basename(paths.revisionRoot)}.staging-`;
  const backups = entries.filter((entry) => entry.startsWith(backupPrefix)).sort();
  const stagings = entries.filter((entry) => entry.startsWith(stagingPrefix)).sort();
  const platform = manager.platform ?? hostPlatform();
  const probe = resolveProbe(manager, platform);
  let finalHealthy = await revisionHealthy(
    paths.revisionRoot,
    paths.executablePath,
    compatibility,
    platform,
    probe,
  ).then((result) => result.ok, () => false);
  if (!finalHealthy) {
    for (const entry of backups) {
      const candidate = join(paths.cacheRoot, entry);
      if (!await exactBackupDirectory(candidate, paths.revisionRoot, compatibility)) continue;
      const candidateHealthy = await revisionHealthy(
        candidate,
        join(candidate, paths.executableRelativePath),
        compatibility,
        platform,
        probe,
      ).then((result) => result.ok, () => false);
      if (!candidateHealthy) continue;
      if (await lstat(paths.revisionRoot).then(() => true, () => false)) {
        if (!await exactRevisionDirectory(paths.revisionRoot, compatibility)) break;
        await rm(paths.revisionRoot, { recursive: true });
      }
      await rename(candidate, paths.revisionRoot);
      finalHealthy = true;
      break;
    }
  }
  if (!finalHealthy) {
    for (const entry of stagings) {
      const candidate = join(paths.cacheRoot, entry);
      if (!await exactStagingDirectory(candidate, paths.revisionRoot, compatibility)) continue;
      const candidateHealthy = await revisionHealthy(
        candidate,
        join(candidate, paths.executableRelativePath),
        compatibility,
        platform,
        probe,
      ).then((result) => result.ok, () => false);
      if (!candidateHealthy) continue;
      const finalStat = await lstat(paths.revisionRoot).catch(() => undefined);
      if (finalStat) {
        if (!await exactRevisionDirectory(paths.revisionRoot, compatibility)) break;
        await rm(paths.revisionRoot, { recursive: true });
      }
      await rename(candidate, paths.revisionRoot);
      await rm(join(paths.revisionRoot, STAGING_MARKER), { force: true });
      finalHealthy = true;
      break;
    }
  }
  if (finalHealthy) {
    for (const entry of backups) {
      const candidate = join(paths.cacheRoot, entry);
      if (await exactBackupDirectory(candidate, paths.revisionRoot, compatibility)) await rm(candidate, { recursive: true });
    }
  }
  for (const entry of stagings) {
    const candidate = join(paths.cacheRoot, entry);
    if (await exactStagingDirectory(candidate, paths.revisionRoot, compatibility)) await rm(candidate, { recursive: true });
  }
}

async function garbageCollect(cacheRoot: string, currentRevisionRoot: string): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(cacheRoot)) {
    if (!entry.startsWith("pw-") || entry === basename(currentRevisionRoot)) continue;
    const candidate = join(cacheRoot, entry);
    assertInside(cacheRoot, candidate);
    if (!await selfDescribingInactiveRevisionDirectory(candidate)) continue;
    await rm(candidate, { recursive: true });
    removed.push(candidate);
  }
  return removed;
}

export interface BrowserMutationResult {
  status: BrowserStatus;
  changed: boolean;
  removedRevisionRoots: string[];
}

export async function installBrowser(
  manager: BrowserManagerEnvironment = {},
  options: { repair?: boolean; signal?: AbortSignal; garbageCollect?: boolean } = {},
): Promise<BrowserMutationResult> {
  options.signal?.throwIfAborted();
  invalidateWindowsRuntimeProbe();
  const environment = manager.environment ?? process.env;
  if (environment.VQA_BROWSER_OFFLINE === "1") {
    throw new Error(`Browser installation is disabled by VQA_BROWSER_OFFLINE=1. Supply a populated managed cache or retry online with: ${BROWSER_RECOVERY_COMMAND}`);
  }
  const platform = manager.platform ?? hostPlatform();
  const files = playwrightFiles();
  const paths = getPaths(manager);
  await ensureCacheOwnership(paths.cacheRoot, platform);
  return withInstallLock(paths.cacheRoot, manager, async () => {
    options.signal?.throwIfAborted();
    await recoverInterrupted(paths, files.compatibility, manager);
    options.signal?.throwIfAborted();
    const before = await browserStatus(manager);
    if (before.ok && !options.repair) {
      return {
        status: before,
        changed: false,
        removedRevisionRoots: options.garbageCollect === true
          ? await garbageCollect(paths.cacheRoot, paths.revisionRoot)
          : [],
      };
    }
    const nonce = randomUUID();
    const stagingRoot = `${paths.revisionRoot}.staging-${nonce}`;
    const backupRoot = `${paths.revisionRoot}.backup-${nonce}`;
    assertInside(paths.cacheRoot, stagingRoot);
    assertInside(paths.cacheRoot, backupRoot);
    const mirror = environment.VQA_BROWSER_MIRROR;
    if (mirror) {
      const url = new URL(mirror);
      if (url.protocol !== "https:") throw new Error("VQA_BROWSER_MIRROR must be an HTTPS URL");
      if (url.username || url.password) throw new Error("VQA_BROWSER_MIRROR must not contain credentials; configure authentication outside the URL");
    }
    await mkdir(stagingRoot, { mode: 0o700 });
    const now = manager.now ?? (() => new Date());
    const stagingMarker: StagingMarker = {
      managedBy: MANAGED_BY,
      state: "staging",
      revision: files.compatibility.browserRevision,
      nonce,
      createdAt: now().toISOString(),
    };
    await writeFile(join(stagingRoot, STAGING_MARKER), `${JSON.stringify(stagingMarker, null, 2)}\n`, { mode: 0o600 });
    const installerEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      PLAYWRIGHT_BROWSERS_PATH: stagingRoot,
    };
    delete installerEnvironment.PLAYWRIGHT_DOWNLOAD_HOST;
    delete installerEnvironment.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST;
    if (mirror) installerEnvironment.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST = mirror;
    try {
      await (manager.installer ?? defaultInstaller)({
        stagingRoot,
        executablePath: join(stagingRoot, paths.executableRelativePath),
        cliPath: files.cliPath,
        environment: installerEnvironment,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
      const stagedExecutable = join(stagingRoot, paths.executableRelativePath);
      if (!await regularExecutable(stagedExecutable, stagingRoot, platform)) throw new Error("Downloaded Chromium payload is incomplete, linked, outside staging, or not executable");
      if (platform === "win32") {
        options.signal?.throwIfAborted();
        await (manager.configureWindowsSandbox ?? ((path) => configureWindowsSandbox(path, stagingRoot)))(stagedExecutable);
      }
      options.signal?.throwIfAborted();
      const stagedProbe = await resolveProbe(manager, platform)(stagedExecutable);
      options.signal?.throwIfAborted();
      if (!stagedProbe.ok) {
        const native = nativeLibraryDiagnostic(stagedProbe.detail ?? "", platform);
        throw new Error(native?.message ?? `Downloaded Chromium failed validation${stagedProbe.detail ? `: ${stagedProbe.detail}` : ""}`);
      }
      if (stagedProbe.version !== files.compatibility.browserVersion) {
        throw new Error(`Downloaded Chromium version mismatch: expected ${files.compatibility.browserVersion}, observed ${stagedProbe.version ?? "unknown"}`);
      }
      const revisionMarker: RevisionMarker = {
        managedBy: MANAGED_BY,
        state: "complete",
        compatibility: files.compatibility,
        installedAt: now().toISOString(),
        payloadManifest: await payloadManifest(stagingRoot),
      };
      await writeFile(join(stagingRoot, REVISION_MARKER), `${JSON.stringify(revisionMarker, null, 2)}\n`, { mode: 0o600 });
      await manager.afterRevisionMarkerWrite?.();
      options.signal?.throwIfAborted();
      const existing = await lstat(paths.revisionRoot).catch(() => undefined);
      let backedUp = false;
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error("Refusing to replace an unowned or malformed browser revision directory");
        }
        if (await exactRevisionDirectory(paths.revisionRoot, files.compatibility)) {
          await rename(paths.revisionRoot, backupRoot);
          backedUp = true;
        } else {
          throw new Error("Refusing to replace an unowned or malformed browser revision directory");
        }
      }
      try {
        await rename(stagingRoot, paths.revisionRoot);
      } catch (error) {
        if (backedUp) await rename(backupRoot, paths.revisionRoot).catch(() => {});
        throw error;
      }
      const promoted = await revisionHealthy(
        paths.revisionRoot,
        paths.executablePath,
        files.compatibility,
        platform,
        resolveProbe(manager, platform),
      );
      if (!promoted.ok) {
        if (
          !await exactRevisionDirectory(paths.revisionRoot, files.compatibility) ||
          !await exactStagingMarker(paths.revisionRoot, files.compatibility, nonce)
        ) {
          throw new Error(`Promoted Chromium payload failed validation and no longer has exact operation ownership: ${promoted.detail ?? "unknown error"}`);
        }
        await rm(paths.revisionRoot, { recursive: true });
        if (backedUp) await rename(backupRoot, paths.revisionRoot);
        throw new Error(`Promoted Chromium payload failed validation: ${promoted.detail ?? "unknown error"}`);
      }
      await rm(join(paths.revisionRoot, STAGING_MARKER), { force: true });
      if (backedUp) {
        if (!await exactBackupDirectory(backupRoot, paths.revisionRoot, files.compatibility)) {
          throw new Error("Refusing to remove a backup without exact Viewport QA ownership metadata");
        }
        await rm(backupRoot, { recursive: true });
      }
      const removedRevisionRoots = options.garbageCollect === true
        ? await garbageCollect(paths.cacheRoot, paths.revisionRoot)
        : [];
      return { status: await browserStatus(manager), changed: true, removedRevisionRoots };
    } catch (error) {
      if (await exactStagingDirectory(stagingRoot, paths.revisionRoot, files.compatibility, nonce)) {
        try {
          await removeOwnedStagingDirectory(stagingRoot, paths.revisionRoot, files.compatibility, nonce, {
            platform,
            ...(manager.beforeStagingRemove ? { beforeRemove: manager.beforeStagingRemove } : {}),
            ...(manager.sleep ? { sleep: manager.sleep } : {}),
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Browser installation failed and its owned staging directory remained locked",
          );
        }
      }
      throw error;
    }
  });
}

export async function removeBrowser(manager: BrowserManagerEnvironment = {}): Promise<BrowserMutationResult> {
  invalidateWindowsRuntimeProbe();
  const paths = getPaths(manager);
  const platform = manager.platform ?? hostPlatform();
  const rootStat = await lstat(paths.cacheRoot).catch(() => undefined);
  if (rootStat && !privateCacheDirectory(rootStat, platform)) {
    throw new Error("Refusing to remove from a browser cache root that is not private and current-user-owned");
  }
  const cacheMarker = await readFile(join(paths.cacheRoot, CACHE_MARKER), "utf8").catch(() => undefined);
  if (cacheMarker !== `${MANAGED_BY}\n`) {
    return { status: await browserStatus(manager), changed: false, removedRevisionRoots: [] };
  }
  return withInstallLock(paths.cacheRoot, manager, async () => {
    await recoverInterrupted(paths, browserCompatibility(), manager);
    let changed = false;
    if (await exactRevisionDirectory(paths.revisionRoot, browserCompatibility())) {
      await rm(paths.revisionRoot, { recursive: true });
      changed = true;
    } else if (await lstat(paths.revisionRoot).then(() => true, () => false)) {
      throw new Error("Refusing to remove an unowned or malformed browser revision directory");
    }
    return { status: await browserStatus(manager), changed, removedRevisionRoots: changed ? [paths.revisionRoot] : [] };
  });
}

export async function compatibleBrowserExecutablePath(
  manager: BrowserManagerEnvironment = {},
): Promise<string> {
  const status = await browserStatusInternal(manager, true);
  if (!status.ok) {
    const details = status.diagnostics.map((item) => item.message).join(" ");
    throw new Error(`${details} Recovery: ${BROWSER_RECOVERY_COMMAND}`);
  }
  return status.executablePath;
}

export async function browserCacheSize(root: string): Promise<number> {
  let visited = 0;
  async function measure(path: string, depth: number): Promise<number> {
    if (depth > 64 || visited >= 100_000) throw new Error("Browser cache sizing exceeded its safety limit");
    visited += 1;
    const value = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!value) return 0;
    // Count the link itself without following it. Payload integrity separately
    // validates that managed browser links are relative and remain confined.
    if (value.isSymbolicLink()) return value.size;
    if (value.isFile()) return value.size;
    if (!value.isDirectory()) throw new Error(`Browser cache sizing refused a special file: ${path}`);
    let total = 0;
    for (const entry of await readdir(path)) {
      total += await measure(join(path, entry), depth + 1);
      if (!Number.isSafeInteger(total)) throw new Error("Browser cache size exceeds the safe integer range");
    }
    return total;
  }
  return measure(root, 0);
}
