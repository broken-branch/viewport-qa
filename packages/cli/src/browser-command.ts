import { parseArgs } from "node:util";
import { PRODUCT_NAME, PROTOCOL_IDENTITY } from "@vqa/contract";
import {
  TOOL_VERSION,
  browserCacheSize,
  browserStatus,
  installBrowser,
  removeBrowser,
} from "@vqa/engine";

interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  product: { name: string; version: string };
  protocolIdentity: string;
  runtime: {
    nodeVersion: string;
    nodeSupported: boolean;
    platform: NodeJS.Platform;
    architecture: string;
  };
  browser: Awaited<ReturnType<typeof browserStatus>> & { sizeBytes: number };
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

async function doctorReport(): Promise<DoctorReport> {
  const status = await browserStatus();
  const nodeSupported = nodeMajor() >= 22;
  return {
    schemaVersion: 1,
    ok: nodeSupported && status.ok,
    product: { name: PRODUCT_NAME, version: TOOL_VERSION },
    protocolIdentity: PROTOCOL_IDENTITY,
    runtime: {
      nodeVersion: process.versions.node,
      nodeSupported,
      platform: process.platform,
      architecture: process.arch,
    },
    browser: {
      ...status,
      sizeBytes: await browserCacheSize(status.revisionRoot),
    },
  };
}

function printDoctorHuman(report: DoctorReport): void {
  console.log(`${PRODUCT_NAME} ${report.product.version} doctor`);
  console.log(`Node ${report.runtime.nodeVersion}: ${report.runtime.nodeSupported ? "ok" : "unsupported (requires Node 22 or newer)"}`);
  console.log(`Platform ${report.runtime.platform}/${report.runtime.architecture}`);
  console.log(`Playwright ${report.browser.compatibility.playwrightVersion}, Chromium ${report.browser.compatibility.browserVersion} (revision ${report.browser.compatibility.browserRevision}, full Chromium)`);
  console.log(`Browser cache: ${report.browser.cacheRoot}`);
  console.log(`Browser: ${report.browser.health}${report.browser.ok ? ` (${report.browser.sizeBytes} bytes)` : ""}`);
  for (const diagnostic of report.browser.diagnostics) {
    console.log(`- ${diagnostic.message}`);
    for (const remediation of diagnostic.remediation) console.log(`  ${remediation}`);
  }
}

function browserOperationError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EROFS") {
    return "The Viewport QA browser cache is not writable. Set VQA_BROWSER_CACHE to an absolute writable local path and retry.";
  }
  if (code === "ENOSPC") {
    return "The Viewport QA browser cache filesystem is out of space. Free space or choose a larger absolute VQA_BROWSER_CACHE path and retry.";
  }
  return error instanceof Error ? error.message : String(error);
}

function browserFailureJson(action: string, error: unknown): unknown {
  return {
    schemaVersion: 1,
    ok: false,
    action,
    error: {
      code: "browser-operation-failed",
      message: browserOperationError(error),
    },
  };
}

export async function runDoctor(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
  } catch (error) {
    console.error(`vqa doctor: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (positionals.length > 0) {
    console.error(`vqa doctor: unexpected argument "${positionals[0]}"`);
    return 2;
  }
  try {
    const report = await doctorReport();
    if (values.json) console.log(JSON.stringify(report));
    else printDoctorHuman(report);
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = browserOperationError(error);
    if (values.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        ok: false,
        action: "doctor",
        error: { code: "doctor-failed", message },
      }));
    } else {
      console.error(`vqa doctor: ${message}`);
    }
    return 1;
  }
}

export async function runBrowser(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
  } catch (error) {
    console.error(`vqa browser: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const action = positionals[0];
  if (!action || !["status", "install", "repair", "remove"].includes(action) || positionals.length > 1) {
    console.error("vqa browser: expected exactly one of status|install|repair|remove");
    return 2;
  }
  try {
    const result = action === "status"
      ? { status: await browserStatus(), changed: false, removedRevisionRoots: [] }
      : action === "install"
        ? await installBrowser()
        : action === "repair"
          ? await installBrowser({}, { repair: true })
          : await removeBrowser();
    const output = {
      schemaVersion: 1,
      ok: action === "remove" ? true : result.status.ok,
      action,
      changed: result.changed,
      removedRevisionRoots: result.removedRevisionRoots,
      browser: result.status,
    };
    if (values.json) console.log(JSON.stringify(output));
    else {
      console.log(`Browser ${action}: ${output.ok ? "ok" : result.status.health}`);
      console.log(`Playwright ${result.status.compatibility.playwrightVersion}; Chromium ${result.status.compatibility.browserVersion} revision ${result.status.compatibility.browserRevision} (full Chromium)`);
      console.log(`Cache: ${result.status.cacheRoot}`);
      for (const diagnostic of result.status.diagnostics) {
        console.log(`- ${diagnostic.message}`);
        for (const remediation of diagnostic.remediation) console.log(`  ${remediation}`);
      }
    }
    return output.ok ? 0 : 1;
  } catch (error) {
    if (values.json) console.log(JSON.stringify(browserFailureJson(action, error)));
    else console.error(`vqa browser ${action}: ${browserOperationError(error)}`);
    return 1;
  }
}
