import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  browserStatus,
  installBrowser,
  isLinkFreeExistingPath,
  normalizeTargetAddress,
  parseViewportList,
  scan,
  type BrowserMutationResult,
  type BrowserStatus,
} from "@vqa/engine";
import { browserDownloadDisclosure } from "./browser-download.js";
import { renderLauncherApp } from "./launcher-ui.js";
import { resolveProductPaths } from "./product-paths.js";
import { applyBaseHeaders, BodyTooLargeError, bootstrapHtml, CONTENT_TYPES, jsonResponse, readBody, safeEqual, serveReport, withNonce } from "./serve.js";

const MAX_LOCAL_FILE_BYTES = 8_000_000;
// JSON can encode each one-byte control character as six ASCII bytes. This
// admits every valid 8 MB UTF-8 file plus the small, bounded request metadata.
const MAX_LAUNCH_BODY = MAX_LOCAL_FILE_BYTES * 6 + 100_000;
const REPORT_INDEX_VERSION = 1;
type JobStatus = "idle" | "running" | "approval-required" | "cancelled" | "failed" | "complete";
interface RecentReport { id: string; name: string; path: string; createdAt: string }
interface JobState { status: JobStatus; progress: string; reportPath?: string; defaultReportRoot: string; requiredOrigins: string[]; error?: string; warning?: string; focusTarget?: "url" | "recent" }
interface ScanRequest { kind?: unknown; url?: unknown; localFile?: { name?: unknown; content?: unknown }; viewports?: unknown }
interface JobSpec { target: string; localTemporary?: string; viewports: string[]; reportPath: string; allowedOrigins: Set<string> }
interface ActiveJob { id: string; controller: AbortController; spec: JobSpec; promise: Promise<void> }
type BrowserSetupPhase = "missing" | "installing" | "failed" | "ready";

export interface LauncherBrowserManager {
  status: () => Promise<BrowserStatus>;
  install: (repair: boolean, signal: AbortSignal) => Promise<BrowserMutationResult>;
}

export interface LauncherOptions {
  port?: number;
  stateRoot?: string;
  reportsRoot?: string;
  cacheRoot?: string;
  browserManager?: LauncherBrowserManager;
  idleTimeoutMs?: number;
  log?: (line: string) => void;
  testHooks?: { beforeIndexWrite?: () => void | Promise<void>; beforeShutdownCleanup?: () => void | Promise<void> };
}

function exactBlockedOrigins(message: string): string[] {
  return [...new Set([...message.matchAll(/outside the explicit origin allowlist: (https?:\/\/[^;\s]+)/gu)].map((match) => match[1]!))].sort();
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink() || !await isLinkFreeExistingPath(path)) throw new Error(`unsafe launcher directory: ${path}`);
  return resolve(path);
}

function timestampName(now = new Date()): string {
  return `Viewport-QA-${now.toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
}

function openWithDesktop(path: string): Promise<void> {
  const configured = process.env.VQA_DESKTOP_OPEN;
  if (configured && !isAbsolute(configured)) return Promise.reject(new Error("VQA_DESKTOP_OPEN must be an absolute executable path"));
  if (configured && !existsSync(configured)) return Promise.reject(new Error("VQA_DESKTOP_OPEN does not exist"));
  const linuxCommand = ["/usr/bin/xdg-open", "/bin/xdg-open"].find(existsSync);
  const command = configured && existsSync(configured)
    ? configured
    : process.platform === "win32"
      ? join(process.env.WINDIR ?? "C:\\Windows", "explorer.exe")
      : process.platform === "darwin"
        ? "/usr/bin/open"
        : linuxCommand;
  if (!command) return Promise.reject(new Error("No supported system browser/folder opener was found."));
  const args = [path];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
      env: process.platform === "win32" ? process.env : { ...process.env, PATH: "/usr/bin:/bin" },
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`desktop opener exited with code ${String(code)}`)));
  });
}

export async function launchStudio(options: LauncherOptions = {}): Promise<{ server: Server; url: string; shutdown: () => Promise<void> }> {
  const log = options.log ?? (() => {});
  const productPaths = resolveProductPaths();
  const stateRoot = await ensurePrivateDirectory(options.stateRoot ?? productPaths.stateRoot);
  const reportsRoot = await ensurePrivateDirectory(options.reportsRoot ?? productPaths.reportsRoot);
  const cacheRoot = await ensurePrivateDirectory(options.cacheRoot ?? productPaths.cacheRoot);
  const browserManager = options.browserManager ?? {
    status: () => browserStatus(),
    install: (repair: boolean, signal: AbortSignal) => installBrowser({}, { repair, signal, garbageCollect: false }),
  };
  const download = browserDownloadDisclosure();
  let setupStatus = await browserManager.status();
  let setupPhase: BrowserSetupPhase = setupStatus.ok ? "ready" : "missing";
  let setupError: string | undefined;
  let setupInstallPromise: Promise<void> | undefined;
  let setupInstallController: AbortController | undefined;
  const indexPath = join(stateRoot, "launcher-reports.json");
  const capability = randomBytes(32).toString("base64url");
  const nonce = randomBytes(18).toString("base64url");
  let expectedHost = "";
  let expectedOrigin = "";
  let idleTimer: NodeJS.Timeout | undefined;
  let activeJob: ActiveJob | undefined;
  let jobSpec: JobSpec | undefined;
  let internal: { server: Server; origin: string; capability: string } | undefined;
  let stopping = false;
  let cleanupPreparationPromise: Promise<ActiveJob | undefined> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let state: JobState = { status: "idle", progress: "Choose a page or local HTML file.", defaultReportRoot: reportsRoot, requiredOrigins: [] };

  function browserSetupResponse(): unknown {
    const canInstall = !setupStatus.configuration.offline && download.supported;
    return {
      phase: setupPhase,
      browser: setupStatus,
      disclosure: {
        browserVersion: setupStatus.compatibility.browserVersion,
        browserRevision: setupStatus.compatibility.browserRevision,
        downloadBytes: download.bytes,
        downloadUrl: download.url,
        networkOrigin: download.networkOrigin,
        destination: setupStatus.cacheRoot,
        configuration: setupStatus.configuration,
        privacy: "After approval, Playwright downloads the compatible browser over HTTPS. Viewport QA checks the installed file inventory and browser version before use. Scans contact only targets you request.",
      },
      actions: {
        canInstall: setupPhase !== "ready" && setupPhase !== "installing" && canInstall,
        canRetry: setupPhase === "failed" && canInstall,
        canQuit: true,
      },
      ...(setupError ? { error: setupError } : {}),
    };
  }

  function startBrowserInstall(): void {
    if (setupInstallPromise) return;
    const repair = setupStatus.health === "corrupt";
    const controller = new AbortController();
    setupInstallController = controller;
    setupPhase = "installing";
    setupError = undefined;
    setupInstallPromise = (async () => {
      try {
        const result = await browserManager.install(repair, controller.signal);
        if (controller.signal.aborted || stopping) return;
        setupStatus = result.status;
        if (!setupStatus.ok) throw new Error("The managed browser did not pass its launch validation.");
        setupPhase = "ready";
      } catch (error) {
        if (controller.signal.aborted || stopping) return;
        setupStatus = await browserManager.status().catch(() => setupStatus);
        setupPhase = "failed";
        setupError = error instanceof Error ? error.message : String(error);
        log(`[vqa launcher] browser setup failed: ${setupError}`);
      } finally {
        if (setupInstallController === controller) setupInstallController = undefined;
        setupInstallPromise = undefined;
      }
    })();
    void setupInstallPromise;
  }

  async function readIndex(): Promise<RecentReport[]> {
    let parsed: { version?: unknown; reports?: unknown } = {};
    try { parsed = JSON.parse(await readFile(indexPath, "utf8")) as typeof parsed; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (parsed.version !== REPORT_INDEX_VERSION || !Array.isArray(parsed.reports)) return [];
    const valid: RecentReport[] = [];
    for (const entry of parsed.reports) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<RecentReport>;
      if (![candidate.id, candidate.name, candidate.path, candidate.createdAt].every((value) => typeof value === "string")) continue;
      const path = resolve(candidate.path!);
      if (path === reportsRoot || !path.startsWith(reportsRoot + sep)) continue;
      try {
        const item = await lstat(path);
        if (!item.isDirectory() || item.isSymbolicLink() || !await isLinkFreeExistingPath(path) || !existsSync(join(path, "review-manifest.json"))) continue;
      } catch { continue; }
      valid.push(candidate as RecentReport);
    }
    return valid.slice(0, 12);
  }

  async function writeIndex(report: RecentReport): Promise<void> {
    const reports = [report, ...(await readIndex()).filter((item) => item.id !== report.id)].slice(0, 12);
    const temporary = `${indexPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await options.testHooks?.beforeIndexWrite?.();
    try {
      await writeFile(temporary, `${JSON.stringify({ version: REPORT_INDEX_VERSION, reports }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, indexPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function closeInternal(): Promise<void> {
    if (!internal) return;
    const current = internal;
    internal = undefined;
    await new Promise<void>((done) => current.server.close(() => done()));
    current.server.closeAllConnections();
  }

  async function activateReport(reportPath: string): Promise<void> {
    await closeInternal();
    const opened = await serveReport({ reportDir: reportPath, port: 0, idleTimeoutMs: 0, log });
    const launch = new URL(opened.url);
    internal = { server: opened.server, origin: launch.origin, capability: new URLSearchParams(launch.hash.slice(1)).get("cap")! };
  }

  async function disposeSpec(spec: JobSpec | undefined): Promise<void> {
    if (spec?.localTemporary) await rm(resolve(spec.localTemporary, ".."), { recursive: true, force: true });
  }

  async function runJob(job: ActiveJob): Promise<void> {
    const { spec } = job;
    let keepForApproval = false;
    let published = false;
    let finalState: JobState | undefined;
    state = { status: "running", progress: "Launching the isolated browser…", reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: [] };
    try {
      const report = await scan({
        url: spec.target,
        outDir: spec.reportPath,
        viewports: parseViewportList(spec.viewports.join(",")),
        allowedOrigins: [...spec.allowedOrigins],
        signal: job.controller.signal,
        log: (line) => { if (activeJob === job) state.progress = line.replace(/^\[vqa\]\s*/u, ""); log(line); },
      });
      published = true;
      if (activeJob !== job) return;
      try {
        await activateReport(spec.reportPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finalState = { status: "failed", progress: `The report was published at ${spec.reportPath}, but its review could not open.`, reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: [], error: message };
        return;
      }
      const completed: JobState = { status: "complete", progress: `${report.viewports.length} capture(s) ready for review.`, reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: [] };
      try {
        await writeIndex({ id: basename(spec.reportPath), name: new URL(report.url).protocol === "file:" ? basename(new URL(report.url).pathname) : new URL(report.url).hostname, path: spec.reportPath, createdAt: report.createdAt });
        if (activeJob === job) finalState = completed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[vqa launcher] report published but recent index update failed: ${message}`);
        if (activeJob === job) finalState = { ...completed, progress: `${report.viewports.length} capture(s) ready at ${spec.reportPath}.`, warning: `The report is open, but it could not be added to Recent Reports: ${message}` };
      }
    } catch (error) {
      if (activeJob !== job) return;
      const message = error instanceof Error ? error.message : String(error);
      const origins = exactBlockedOrigins(message);
      keepForApproval = !published && !job.controller.signal.aborted && origins.length > 0;
      finalState = job.controller.signal.aborted
        ? { status: "cancelled", progress: "No report was published.", reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: [] }
        : keepForApproval
          ? { status: "approval-required", progress: "The attempted report was discarded safely.", reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: origins }
          : published
            ? { status: "failed", progress: `The report was published at ${spec.reportPath}, but setup did not finish.`, reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: [], error: message }
            : { status: "failed", progress: "No report was published.", reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: [], error: message };
    } finally {
      try {
        if (!keepForApproval) {
          try {
            await disposeSpec(spec);
            if (jobSpec === spec) jobSpec = undefined;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finalState = { status: "failed", progress: "The scan ended, but its temporary upload could not be removed. Stop Viewport QA and inspect the cache directory.", reportPath: spec.reportPath, defaultReportRoot: reportsRoot, requiredOrigins: [], error: message };
            log(`[vqa launcher] temporary upload cleanup failed: ${message}`);
          }
        }
      } finally {
        if (activeJob === job) activeJob = undefined;
        if (finalState) state = finalState;
      }
    }
  }

  function startJob(spec: JobSpec): void {
    if (activeJob) throw new Error("a scan is already running");
    const job = { id: randomBytes(12).toString("hex"), controller: new AbortController(), spec, promise: Promise.resolve() } satisfies ActiveJob;
    activeJob = job;
    job.promise = runJob(job);
    void job.promise.catch((error: unknown) => log(`[vqa launcher] job ${job.id} cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  function prepareCleanupResources(): Promise<ActiveJob | undefined> {
    if (cleanupPreparationPromise) return cleanupPreparationPromise;
    stopping = true;
    setupInstallController?.abort(new Error("Viewport QA stopped"));
    const job = activeJob;
    job?.controller.abort(new Error("Viewport QA stopped"));
    cleanupPreparationPromise = (async () => {
      await disposeSpec(jobSpec).catch((error: unknown) => log(`[vqa launcher] shutdown upload cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
      jobSpec = undefined;
      await closeInternal().catch((error: unknown) => log(`[vqa launcher] shutdown report close failed: ${error instanceof Error ? error.message : String(error)}`));
      return job;
    })();
    return cleanupPreparationPromise;
  }

  function cleanupResources(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const job = await prepareCleanupResources();
      await options.testHooks?.beforeShutdownCleanup?.();
      if (job) {
        await job.promise.catch(() => {});
      }
      await setupInstallPromise?.catch(() => {});
      // A job already between publication and activation can recreate the
      // internal report server after the preparation pass.
      await closeInternal().catch((error: unknown) => log(`[vqa launcher] shutdown report close failed: ${error instanceof Error ? error.message : String(error)}`));
    })();
    return cleanupPromise;
  }

  function shutdownService(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      await prepareCleanupResources();
      const closed = server.listening
        ? new Promise<void>((done) => { server.close(() => done()); })
        : Promise.resolve();
      server.closeIdleConnections();
      await cleanupResources();
      server.closeIdleConnections();
      await closed;
    })();
    return shutdownPromise;
  }

  async function parseJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    try { return JSON.parse(await readBody(request, MAX_LAUNCH_BODY)) as Record<string, unknown>; }
    catch (error) { throw error instanceof BodyTooLargeError ? error : new Error("invalid JSON body"); }
  }

  async function proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!internal) { jsonResponse(response, 404, { error: "no report is open" }); return; }
    const incoming = new URL(request.url ?? "/", expectedOrigin);
    const target = new URL(`${incoming.pathname}${incoming.search}`, internal.origin);
    const headers: Record<string, string> = { authorization: `VQA ${internal.capability}` };
    const method = request.method ?? "GET";
    let body: string | undefined;
    if (!["GET", "HEAD"].includes(method)) {
      headers.origin = internal.origin;
      headers["content-type"] = "application/json";
      body = await readBody(request);
    }
    const upstream = await fetch(target, { method, headers, redirect: "error", ...(body !== undefined ? { body } : {}) });
    const contentType = upstream.headers.get("content-type");
    let contentSecurityPolicy = upstream.headers.get("content-security-policy");
    let outgoing = method === "HEAD" ? undefined : Buffer.from(await upstream.arrayBuffer());
    if (target.pathname === "/app" && upstream.ok) {
      const internalNonce = /script-src[^;]*'nonce-([^']+)'/u.exec(contentSecurityPolicy ?? "")?.[1];
      if (!internalNonce) { jsonResponse(response, 502, { error: "report application CSP is invalid" }); return; }
      contentSecurityPolicy = contentSecurityPolicy!.replaceAll(`nonce-${internalNonce}`, `nonce-${nonce}`);
      if (outgoing) outgoing = Buffer.from(outgoing.toString("utf8").replaceAll(`nonce="${internalNonce}"`, `nonce="${nonce}"`));
    }
    if (contentType) response.setHeader("content-type", contentType);
    if (contentSecurityPolicy) response.setHeader("content-security-policy", contentSecurityPolicy);
    response.setHeader("content-length", outgoing?.length ?? Number(upstream.headers.get("content-length") ?? 0));
    response.statusCode = upstream.status;
    response.end(outgoing);
  }

  const server = createServer((request, response) => { void (async () => {
    applyBaseHeaders(response);
    if (request.headers.host !== expectedHost) { jsonResponse(response, 421, { error: "invalid loopback Host" }); return; }
    const url = new URL(request.url ?? "/", expectedOrigin);
    let path: string; try { path = decodeURIComponent(url.pathname); } catch { jsonResponse(response, 400, { error: "invalid request path" }); return; }
    if (path === "/" && ["GET", "HEAD"].includes(request.method ?? "")) {
      const html = Buffer.from(withNonce(bootstrapHtml(), nonce));
      response.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; img-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"]!, "content-length": html.length }); response.end(request.method === "HEAD" ? undefined : html); return;
    }
    if (path === "/") { response.setHeader("allow", "GET, HEAD"); jsonResponse(response, 405, { error: "method not allowed" }); request.resume(); return; }
    if (!safeEqual(request.headers.authorization, `VQA ${capability}`)) { jsonResponse(response, 401, { error: "launch authorization required" }); return; }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== expectedOrigin) { jsonResponse(response, 403, { error: "invalid Origin" }); return; }
    if (!["GET", "HEAD"].includes(request.method ?? "") && origin !== expectedOrigin) { jsonResponse(response, 403, { error: "exact Origin required" }); return; }
    if (idleTimer) idleTimer.refresh();
    if (stopping) { jsonResponse(response, 503, { error: "Viewport QA is stopping" }); request.resume(); return; }
    const ownMethods: Record<string, readonly string[]> = { "/app": ["GET", "HEAD"], "/api/browser-setup": ["GET"], "/api/browser-setup/install": ["POST"], "/api/job": ["GET"], "/api/scan": ["POST"], "/api/cancel": ["POST"], "/api/approve-origins": ["POST"], "/api/recent": ["GET"], "/api/open-report": ["POST"], "/api/open-folder": ["POST"], "/api/navigation/home": ["POST"], "/api/navigation/new-review": ["POST"], "/api/stop": ["POST"] };
    const own = ownMethods[path];
    if (own && !own.includes(request.method ?? "")) { response.setHeader("allow", own.join(", ")); jsonResponse(response, 405, { error: "method not allowed" }); request.resume(); return; }
    if ((request.method === "POST") && request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { jsonResponse(response, 415, { error: "application/json required" }); request.resume(); return; }
    const declared = Number(request.headers["content-length"] ?? 0); if (Number.isFinite(declared) && declared > MAX_LAUNCH_BODY) { jsonResponse(response, 413, { error: "request body too large" }); request.resume(); return; }
    if (path === "/app" && ["GET", "HEAD"].includes(request.method ?? "")) {
      if (internal) { await proxy(request, response); return; }
      const html = Buffer.from(withNonce(renderLauncherApp(), nonce)); response.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`); response.writeHead(200, { "content-type": CONTENT_TYPES[".html"]!, "content-length": html.length }); response.end(request.method === "HEAD" ? undefined : html); return;
    }
    if (path === "/api/browser-setup" && request.method === "GET") { jsonResponse(response, 200, browserSetupResponse()); return; }
    if (path === "/api/browser-setup/install" && request.method === "POST") {
      const body = await parseJson(request);
      if (body.consent !== true) { jsonResponse(response, 400, { error: "explicit browser download consent is required" }); return; }
      if (setupPhase === "ready") { jsonResponse(response, 200, browserSetupResponse()); return; }
      if (setupPhase === "installing") { jsonResponse(response, 409, { error: "browser setup is already running" }); return; }
      if (setupStatus.configuration.offline) { jsonResponse(response, 409, { error: "automatic browser setup is disabled in offline mode; use a complete offline Viewport QA artifact" }); return; }
      if (!download.supported) { jsonResponse(response, 409, { error: `automatic browser setup is unavailable for ${process.platform}/${process.arch}` }); return; }
      startBrowserInstall();
      jsonResponse(response, 202, browserSetupResponse());
      return;
    }
    if (path === "/api/job" && request.method === "GET") { jsonResponse(response, 200, state); return; }
    if (path === "/api/recent" && request.method === "GET") { jsonResponse(response, 200, { reports: (await readIndex()).map(({ id, name, createdAt }) => ({ id, name, createdAt })) }); return; }
    if ((path === "/api/navigation/home" || path === "/api/navigation/new-review") && request.method === "POST") {
      request.resume();
      if (activeJob) { jsonResponse(response, 409, { error: "finish or cancel the active scan before leaving it" }); return; }
      await closeInternal();
      const newReview = path.endsWith("/new-review");
      state = {
        status: "idle",
        progress: newReview
          ? "Current review saved locally. Ready to start a new review."
          : "Current review saved locally. Recent reports are ready.",
        defaultReportRoot: reportsRoot,
        requiredOrigins: [],
        focusTarget: newReview ? "url" : "recent",
      };
      jsonResponse(response, 200, { navigated: true, destination: newReview ? "new-review" : "home" });
      return;
    }
    if (path === "/api/scan" && request.method === "POST") {
      if (setupPhase !== "ready") { jsonResponse(response, 409, { error: "finish browser setup before starting a scan" }); request.resume(); return; }
      if (activeJob) { jsonResponse(response, 409, { error: "a scan is already running" }); request.resume(); return; }
      await closeInternal();
      await disposeSpec(jobSpec);
      jobSpec = undefined;
      const body = await parseJson(request) as ScanRequest;
      if (!Array.isArray(body.viewports) || body.viewports.length < 1 || body.viewports.length > 5 || body.viewports.some((item) => typeof item !== "string")) { jsonResponse(response, 400, { error: "choose one to five valid capture sizes" }); return; }
      parseViewportList(body.viewports.join(","));
      const reportPath = join(reportsRoot, timestampName());
      let target: string; let localTemporary: string | undefined; const allowedOrigins = new Set<string>();
      if (body.kind === "url") {
        if (typeof body.url !== "string") { jsonResponse(response, 400, { error: "enter a web address" }); return; }
        const address = normalizeTargetAddress(body.url);
        let parsed: URL; try { parsed = new URL(address ?? ""); } catch { jsonResponse(response, 400, { error: "enter a web address such as example.com or https://example.com/page" }); return; }
        if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) { jsonResponse(response, 400, { error: "only credential-free HTTP(S) addresses can be scanned; use the local file option for a page on disk" }); return; }
        target = parsed.href; allowedOrigins.add(parsed.origin);
      } else if (body.kind === "file") {
        if (!body.localFile || typeof body.localFile.name !== "string" || typeof body.localFile.content !== "string" || ![".html", ".htm"].includes(extname(body.localFile.name).toLowerCase()) || Buffer.byteLength(body.localFile.content) > MAX_LOCAL_FILE_BYTES) { jsonResponse(response, 400, { error: "choose a self-contained UTF-8 HTML file no larger than 8 MB" }); return; }
        const localRoot = await mkdtemp(join(cacheRoot, "local-page-")); localTemporary = join(localRoot, "selected.html"); await writeFile(localTemporary, body.localFile.content, { flag: "wx", mode: 0o600 }); target = pathToFileURL(localTemporary).href;
      } else { jsonResponse(response, 400, { error: "choose a web address or local HTML file" }); return; }
      jobSpec = { target, ...(localTemporary ? { localTemporary } : {}), viewports: body.viewports as string[], reportPath, allowedOrigins };
      startJob(jobSpec); jsonResponse(response, 202, state); return;
    }
    if (path === "/api/cancel" && request.method === "POST") {
      request.resume();
      if (activeJob) { activeJob.controller.abort(new Error("Scan cancelled")); jsonResponse(response, 202, { ...state, progress: "Cancelling safely…" }); return; }
      if (state.status === "approval-required" && jobSpec) { const reportPath = state.reportPath; await disposeSpec(jobSpec); jobSpec = undefined; state = { status: "cancelled", progress: "The pending upload was removed. No report was published.", ...(reportPath ? { reportPath } : {}), defaultReportRoot: reportsRoot, requiredOrigins: [] }; jsonResponse(response, 200, state); return; }
      jsonResponse(response, 409, { error: "no scan is running or awaiting approval" }); return;
    }
    if (path === "/api/approve-origins" && request.method === "POST") {
      if (activeJob) { jsonResponse(response, 409, { error: "a scan is already running" }); request.resume(); return; }
      const body = await parseJson(request); if (state.status !== "approval-required" || !jobSpec || !Array.isArray(body.origins) || body.origins.length !== state.requiredOrigins.length || body.origins.some((item, index) => item !== state.requiredOrigins[index])) { jsonResponse(response, 400, { error: "approve the exact origins identified for this job" }); return; }
      for (const originValue of state.requiredOrigins) jobSpec.allowedOrigins.add(originValue); startJob(jobSpec); jsonResponse(response, 202, state); return;
    }
    if (path === "/api/open-report" && request.method === "POST") { if (activeJob) { jsonResponse(response, 409, { error: "finish or cancel the active scan before opening a report" }); request.resume(); return; } const body = await parseJson(request); const report = (await readIndex()).find((item) => item.id === body.id); if (!report) { jsonResponse(response, 404, { error: "report is not in this launcher's recent list" }); return; } await disposeSpec(jobSpec); jobSpec = undefined; await activateReport(report.path); state = { status: "complete", progress: "Report opened.", reportPath: report.path, defaultReportRoot: reportsRoot, requiredOrigins: [] }; jsonResponse(response, 200, state); return; }
    if (path === "/api/open-folder" && request.method === "POST") { request.resume(); await openWithDesktop(reportsRoot); jsonResponse(response, 202, { opened: true }); return; }
    if (path === "/api/stop" && request.method === "POST") { request.resume(); stopping = true; jsonResponse(response, 202, { stopping: true }); setImmediate(() => { void shutdownService(); }); return; }
    if (internal && (path.startsWith("/api/") || path !== "/")) { await proxy(request, response); return; }
    jsonResponse(response, 404, { error: "not found" });
  })().catch((error: unknown) => { log(`[vqa launcher] ${error instanceof Error ? error.message : String(error)}`); if (!response.headersSent) jsonResponse(response, error instanceof BodyTooLargeError ? 413 : 400, { error: error instanceof Error ? error.message : String(error) }); else response.end(); }); });

  server.once("close", () => { if (idleTimer) clearTimeout(idleTimer); void cleanupResources(); });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", done); });
  const address = server.address(); const port = typeof address === "object" && address ? address.port : options.port ?? 0; expectedHost = `127.0.0.1:${port}`; expectedOrigin = `http://${expectedHost}`;
  const idle = options.idleTimeoutMs ?? 30 * 60_000; if (idle > 0) { idleTimer = setTimeout(() => { log("[vqa launcher] idle timeout reached; stopping"); void shutdownService(); }, idle); idleTimer.unref(); }
  return { server, url: `${expectedOrigin}/#cap=${capability}`, shutdown: shutdownService };
}

export async function openLauncherBrowser(url: string): Promise<void> { await openWithDesktop(url); }
