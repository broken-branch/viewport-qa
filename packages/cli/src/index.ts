import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  buildAgentSummary,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PAGES,
  DEVICE_CLASS_IDS,
  formatAgentSummaryHuman,
  HARD_MAX_DEPTH,
  HARD_MAX_PAGES,
  markRunAsBaseline,
  normalizeTargetAddress,
  parseDeviceList,
  parseViewportList,
  prepareScenarios,
  readAgentSummary,
  readScenarioRecipe,
  scan,
  TOOL_VERSION,
  viewportsForDevices,
} from "@vqa/engine";
import {
  CliSubprocessModelAdapter,
  shutdownActiveModelCliProcesses,
  type CliModelAdapterLogEvent,
  type ModelAdapter,
  type SubscriptionCliProvider,
} from "@vqa/model-adapter";
import { PRODUCT_NAME } from "@vqa/contract";
import { runBrowser, runDoctor } from "./browser-command.js";
import { serveReport } from "./serve.js";
import { launchStudio, openLauncherBrowser } from "./launcher.js";

const USAGE = `${PRODUCT_NAME} ${TOOL_VERSION}

Usage:
  vqa doctor [--json]
  vqa browser status|install|repair|remove [--json]
  vqa scan <url-or-file> [--devices mobile,tablet,desktop | --viewports WxH[@DPR],...] [--out <dir>] [--timeout <ms>] [--baseline <report-dir>] [--scenarios <file>] [--crawl] [--max-pages <n>] [--max-depth <n>] [--strict] [--allow-origin <origin>] [--model-cli codex|claude]
  vqa summarize <report-dir> [--json]
  vqa baseline <report-dir>
  vqa serve <report-dir> [--port <port>] [--read-only] [--idle-timeout <ms>]
  vqa open <report-dir> [--read-only] [--idle-timeout <ms>]
  vqa launch [--port <port>] [--idle-timeout <ms>]

Commands:
  doctor Diagnose Node, platform, cache, and the exact compatible browser.
  browser Explicitly inspect, install, repair, or remove Viewport QA's browser.
  scan   Render the target at each viewport, detect visual issues, and write a
         transactional report directory (including issues.json,
         agent-summary.json, contact-sheet.html, screenshots/, and review files).
  summarize  Print the compact grouped-defect summary without changing the report.
  baseline  Transactionally mark a manifest-backed report as a comparison baseline.
  serve  Serve a report directory with the screenshot review GUI. Classifications,
         issue highlights, and change requests persist to review-state.json.
  open   Securely serve a report on a free loopback port and open the system browser.
  launch Open the local start page and scan without a terminal.

Options:
  --devices    Device classes to capture, any of ${DEVICE_CLASS_IDS.join(", ")};
               each contributes its common sizes (default: all three, see README)
  --viewports  Explicit comma-separated sizes instead of device classes,
               e.g. 360x800,390x844@3,1920x1080
  --out        Output directory for scan (default: ./vqa-report)
  --timeout    Navigation timeout in ms (default: 30000)
  --baseline   Report directory whose matching viewport captures are compared
               against this scan
  --scenarios  JSON recipe of labelled same-origin page states to capture
  --crawl      Crawl same-origin links breadth-first (disabled by default)
  --max-pages  Crawl page limit (default: ${DEFAULT_MAX_PAGES}; hard cap: ${HARD_MAX_PAGES})
  --max-depth  Crawl link depth from the start page (default: ${DEFAULT_MAX_DEPTH}; hard cap: ${HARD_MAX_DEPTH})
  --strict     Contact only the target origin (plus any --allow-origin). By
               default a page may load from any public origin, as in a browser;
               private and loopback addresses, downloads, and popups are always
               blocked for a public target.
  --allow-origin  Exact HTTP(S) origin to admit in strict mode. Repeat as needed;
               listing any origin implies --strict.
  --model-cli  Opt in to AI fixes through an already subscription-authenticated
               local CLI: codex or claude (also VQA_MODEL_CLI)
  --model-cli-bin  Executable name/path override (also VQA_MODEL_CLI_BIN)
  --model-cli-timeout  Per-recommendation CLI timeout in ms (default: 60000;
               also VQA_MODEL_CLI_TIMEOUT_MS)
  --port       Port for serve (default: 0, which picks a free port)
  --read-only  Open without taking the report writer lock or allowing changes
  --idle-timeout  Stop after this many milliseconds without an authorized request
               (default: 1800000; 0 disables idle shutdown)
  --json       Stable machine-readable output for doctor, browser, and summarize
`;

function subscriptionCliProvider(value: string): SubscriptionCliProvider {
  if (value === "codex" || value === "claude") return value;
  throw new Error(
    `Invalid model CLI: ${value} (must be "codex" or "claude")`,
  );
}

export interface ModelCliConfiguration {
  cliFlag?: string;
  binaryFlag?: string;
  timeoutFlag?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (event: CliModelAdapterLogEvent) => void;
}

/** Resolve only the named VQA settings; unrelated environment values are ignored. */
export function modelAdapterFromConfiguration(
  configuration: ModelCliConfiguration,
): ModelAdapter | undefined {
  const environment = configuration.environment ?? process.env;
  const modelCliValue =
    configuration.cliFlag ?? environment.VQA_MODEL_CLI;
  const modelCliBinary =
    configuration.binaryFlag ?? environment.VQA_MODEL_CLI_BIN;
  const modelCliTimeoutValue =
    configuration.timeoutFlag ?? environment.VQA_MODEL_CLI_TIMEOUT_MS;
  if (
    modelCliValue === undefined &&
    (modelCliBinary !== undefined || modelCliTimeoutValue !== undefined)
  ) {
    throw new Error(
      "Model CLI binary/timeout configuration requires explicit --model-cli or VQA_MODEL_CLI opt-in",
    );
  }
  const modelCliTimeoutMs = modelCliTimeoutValue !== undefined
    ? Number(modelCliTimeoutValue)
    : undefined;
  if (
    modelCliTimeoutMs !== undefined &&
    (!Number.isInteger(modelCliTimeoutMs) || modelCliTimeoutMs <= 0)
  ) {
    throw new Error(`Invalid --model-cli-timeout: ${modelCliTimeoutValue}`);
  }
  if (modelCliValue === undefined) return undefined;
  if (modelCliBinary !== undefined && modelCliBinary.length === 0) {
    throw new Error("Invalid --model-cli-bin: executable path cannot be empty");
  }
  return new CliSubprocessModelAdapter({
    provider: subscriptionCliProvider(modelCliValue),
    ...(modelCliBinary ? { binary: modelCliBinary } : {}),
    ...(modelCliTimeoutMs !== undefined
      ? { timeoutMs: modelCliTimeoutMs }
      : {}),
    ...(configuration.log ? { log: configuration.log } : {}),
  });
}

function targetToUrl(target: string): string {
  if (/^https?:\/\//i.test(target) || target.startsWith("file://"))
    return target;
  const asPath = resolve(target);
  if (existsSync(asPath)) return pathToFileURL(asPath).href;
  const address = normalizeTargetAddress(target);
  if (address && /^https?:/iu.test(address)) return address;
  throw new Error(
    `Target "${target}" is neither an existing file nor a web address. ` +
    "Give a URL such as https://example.com/page (the https:// part is optional), or a path to a local HTML file.",
  );
}

async function runScan(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      devices: { type: "string" },
      viewports: { type: "string" },
      out: { type: "string" },
      timeout: { type: "string" },
      baseline: { type: "string" },
      scenarios: { type: "string" },
      crawl: { type: "boolean" },
      "max-pages": { type: "string" },
      "max-depth": { type: "string" },
      "model-cli": { type: "string" },
      "model-cli-bin": { type: "string" },
      "model-cli-timeout": { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      strict: { type: "boolean" },
    },
  });
  const target = positionals[0];
  if (!target) {
    console.error("vqa scan: missing <url-or-file>\n");
    console.error(USAGE);
    return 2;
  }
  const crawl = values.crawl === true;
  if (crawl && values.scenarios !== undefined) {
    console.error("vqa scan: --scenarios cannot be combined with --crawl");
    return 2;
  }
  if (values["max-pages"] !== undefined && !crawl) {
    console.error("vqa scan: --max-pages requires --crawl");
    return 2;
  }
  if (values["max-depth"] !== undefined && !crawl) {
    console.error("vqa scan: --max-depth requires --crawl");
    return 2;
  }
  if (values.devices !== undefined && values.viewports !== undefined) {
    console.error("vqa scan: give either --devices or --viewports, not both");
    return 2;
  }
  const url = targetToUrl(target);
  const outDir = resolve(values.out ?? "vqa-report");
  let viewports;
  try {
    viewports = values.devices !== undefined
      ? viewportsForDevices(parseDeviceList(values.devices))
      : parseViewportList(values.viewports);
  } catch (error) {
    console.error(`vqa scan: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const timeoutMs = values.timeout ? Number(values.timeout) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(`Invalid --timeout: ${values.timeout}`);
  const maxPages = values["max-pages"] === undefined
    ? DEFAULT_MAX_PAGES
    : Number(values["max-pages"]);
  const maxDepth = values["max-depth"] === undefined
    ? DEFAULT_MAX_DEPTH
    : Number(values["max-depth"]);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > HARD_MAX_PAGES) {
    throw new Error(`Invalid --max-pages: ${values["max-pages"] ?? maxPages} (must be 1-${HARD_MAX_PAGES})`);
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > HARD_MAX_DEPTH) {
    throw new Error(`Invalid --max-depth: ${values["max-depth"] ?? maxDepth} (must be 0-${HARD_MAX_DEPTH})`);
  }
  const adapter = modelAdapterFromConfiguration({
    ...(values["model-cli"] !== undefined
      ? { cliFlag: values["model-cli"] }
      : {}),
    ...(values["model-cli-bin"] !== undefined
      ? { binaryFlag: values["model-cli-bin"] }
      : {}),
    ...(values["model-cli-timeout"] !== undefined
      ? { timeoutFlag: values["model-cli-timeout"] }
      : {}),
    log: (line) => console.log(line),
  });
  let scenarios;
  if (values.scenarios !== undefined) {
    try {
      scenarios = prepareScenarios(
        url,
        await readScenarioRecipe(resolve(values.scenarios)),
      );
    } catch (error) {
      console.error(`vqa scan: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  console.log(
    `[vqa] scanning ${url} at ${viewports.length} viewport(s) -> ${outDir}`,
  );
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    controller.abort(new Error("Scan interrupted"));
    void shutdownActiveModelCliProcesses().catch(() => {});
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let report: Awaited<ReturnType<typeof scan>>;
  try {
    report = await scan({
      url,
      outDir,
      viewports,
      timeoutMs,
      crawl,
      maxPages,
      maxDepth,
      allowedOrigins: values["allow-origin"] ?? [],
      ...(values.strict ? { strict: true } : {}),
      ...(scenarios ? { scenarios } : {}),
      signal: controller.signal,
      ...(adapter ? { adapter } : {}),
      ...(values.baseline ? { baselineDir: resolve(values.baseline) } : {}),
      log: (line) => console.log(line),
    });
  } catch (error) {
    if (!interrupted) throw error;
    await shutdownActiveModelCliProcesses();
    return 130;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (interrupted) {
    await shutdownActiveModelCliProcesses();
    return 130;
  }
  console.log(
    `[vqa] done: ${report.pages?.filter((page) => page.status === "success").length ?? 1} page(s), ${report.pages?.filter((page) => page.status === "failed").length ?? 0} failed; ${report.issues.length} unique issue(s) (${report.issues.reduce((sum, issue) => sum + issue.instanceCount, 0)} raw hit(s)); report at ${outDir}/report.html`,
  );
  for (const line of formatAgentSummaryHuman(buildAgentSummary(report))) {
    console.log(line);
  }
  if (report.comparison) {
    const changed = report.comparison.results.filter(
      (result) => result.status !== "identical",
    );
    console.log(
      `[vqa] visual diff: ${changed.length} changed target(s) against baseline from ${report.comparison.baseline.createdAt}`,
    );
    for (const result of changed) {
      console.log(
        `[vqa] diff ${result.target}: ${(result.score * 100).toFixed(2)}% (${result.status})`,
      );
    }
  }
  console.log(`[vqa] review with: vqa open ${outDir}`);
  return 0;
}

async function runSummarize(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
  } catch (error) {
    console.error(`vqa summarize: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) {
    console.error(positionals.length === 0
      ? "vqa summarize: missing <report-dir>"
      : `vqa summarize: unexpected argument "${positionals[1]}"`);
    return 2;
  }
  try {
    const summary = await readAgentSummary(resolve(positionals[0]!));
    if (values.json) console.log(JSON.stringify(summary));
    else for (const line of formatAgentSummaryHuman(summary)) console.log(line);
    return 0;
  } catch (error) {
    console.error(`vqa summarize: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runBaseline(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const reportDir = positionals[0];
  if (!reportDir) {
    console.error("vqa baseline: missing <report-dir>\n");
    console.error(USAGE);
    return 2;
  }
  const marked = await markRunAsBaseline(resolve(reportDir));
  console.log(`[vqa] marked baseline: ${resolve(reportDir)} (${marked.createdAt})`);
  return 0;
}

async function openSystemBrowser(url: string): Promise<void> {
  const configured = process.env.VQA_DESKTOP_OPEN;
  if (configured && !isAbsolute(configured)) throw new Error("VQA_DESKTOP_OPEN must be an absolute executable path");
  if (configured && !existsSync(configured)) throw new Error("VQA_DESKTOP_OPEN does not exist");
  const command = configured ?? (process.platform === "darwin"
    ? "/usr/bin/open"
    : process.platform === "win32"
      ? join(process.env.WINDIR ?? "C:\\Windows", "explorer.exe")
      : (["/usr/bin/xdg-open", "/bin/xdg-open"].find(existsSync) ?? "xdg-open"));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [url], { stdio: "ignore", windowsHide: true });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited with code ${String(code)}`)));
  });
}

async function runServe(argv: string[], commandName: "serve" | "open"): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      "read-only": { type: "boolean" },
      "idle-timeout": { type: "string" },
    },
  });
  const reportDir = positionals[0];
  if (!reportDir) {
    console.error(`vqa ${commandName}: missing <report-dir>\n`);
    console.error(USAGE);
    return 2;
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`Invalid --port: ${values.port}`);
  const idleTimeoutMs = values["idle-timeout"] === undefined ? 30 * 60_000 : Number(values["idle-timeout"]);
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0) throw new Error(`Invalid --idle-timeout: ${values["idle-timeout"]}`);
  const { server, url } = await serveReport({
    reportDir,
    port,
    readOnly: values["read-only"] === true,
    idleTimeoutMs,
    log: (line) => console.log(line),
  });
  try { await openSystemBrowser(url); }
  catch (error) {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error(`could not launch the system browser: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`[vqa] ${commandName === "open" ? "opened" : "serving"} secure review at ${new URL(url).origin}/`);
  console.log(`[vqa] review state is stored in ${resolve(reportDir)}/review-state.json when a manifest is present; legacy format-v2 reports open read-only`);
  console.log("[vqa] stop with Ctrl+C or the Stop Viewport QA action in Settings");

  return new Promise<number>((resolvePromise) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);

      const forceTimer = setTimeout(() => {
        console.error(
          "[vqa] graceful shutdown timed out; force-closing active connections",
        );
        server.closeAllConnections();
      }, 5_000);
      forceTimer.unref();

      server.close((error) => {
        clearTimeout(forceTimer);
        if (error) {
          console.error(`[vqa] server shutdown failed: ${error.message}`);
          resolvePromise(1);
          return;
        }
        resolvePromise(0);
      });
      server.closeIdleConnections();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function runLaunch(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string" }, "idle-timeout": { type: "string" } } });
  const port = values.port === undefined ? 0 : Number(values.port);
  const idleTimeoutMs = values["idle-timeout"] === undefined ? 30 * 60_000 : Number(values["idle-timeout"]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${values.port}`);
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0) throw new Error(`Invalid --idle-timeout: ${values["idle-timeout"]}`);
  const { server, url, shutdown: shutdownLauncher } = await launchStudio({ port, idleTimeoutMs, log: (line) => console.log(line) });
  try { await openLauncherBrowser(url); }
  catch (error) {
    await shutdownLauncher();
    throw new Error(`could not launch the system browser: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`[vqa] ${PRODUCT_NAME} started at ${new URL(url).origin}/`);
  return new Promise<number>((done) => {
    let closing = false;
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
      done(code);
    };
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
      void shutdownLauncher().then(() => finish(0), (error: unknown) => {
        console.error(`[vqa] launcher shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        finish(1);
      });
    };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    server.once("close", () => {
      void shutdownLauncher().then(() => finish(0), (error: unknown) => {
        console.error(`[vqa] launcher shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        finish(1);
      });
    });
  });
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || ["--help", "-h", "help"].includes(command)) {
    if (command) console.log(USAGE);
    else console.error(USAGE);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-V") {
    console.log(TOOL_VERSION);
    return 0;
  }
  if (command === "doctor") return runDoctor(rest);
  if (command === "browser") return runBrowser(rest);
  if (command === "scan") return runScan(rest);
  if (command === "summarize") return runSummarize(rest);
  if (command === "baseline") return runBaseline(rest);
  if (command === "serve") return runServe(rest, "serve");
  if (command === "open") return runServe(rest, "open");
  if (command === "launch") return runLaunch(rest);
  console.error(`vqa: unknown command "${command}"\n`);
  console.error(USAGE);
  return 2;
}
