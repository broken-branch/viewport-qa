import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWindowsTestExecutable } from "../../../scripts/windows-test-powershell.mjs";

export const REPO_ROOT = resolve(
  fileURLToPath(new URL("./", import.meta.url)),
  "../../..",
);
export const BIN = join(REPO_ROOT, "packages/cli/dist/bin.js");
export const FIXTURES = join(REPO_ROOT, "fixtures");

function validCapturedLaunchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const capability = new URLSearchParams(url.hash.slice(1)).get("cap");
    return ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "::1", "localhost"].includes(url.hostname) &&
      capability !== null && /^[A-Za-z0-9_-]{43}$/u.test(capability);
  } catch {
    return false;
  }
}

export function captureBrowserLaunch(): {
  env: NodeJS.ProcessEnv;
  waitForUrl(child?: ChildProcess): Promise<string>;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "vqa-browser-launch-"));
  const capturePath = join(root, "url");
  const launcherPath = join(root, process.platform === "win32" ? "trusted-opener.exe" : "trusted-opener");
  if (process.platform === "win32") {
    const source = join(root, "trusted-opener.cs");
    writeFileSync(source, 'using System; using System.IO; public static class TrustedOpener { public static int Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable("VQA_TEST_BROWSER_CAPTURE"), args[0]); return 0; } }');
    compileWindowsTestExecutable(launcherPath, source);
  } else {
    writeFileSync(launcherPath, '#!/bin/sh\numask 077\nprintf "%s" "$1" > "$VQA_TEST_BROWSER_CAPTURE"\n');
    chmodSync(launcherPath, 0o700);
  }
  return {
    env: { ...process.env, VQA_DESKTOP_OPEN: launcherPath, VQA_TEST_BROWSER_CAPTURE: capturePath },
    waitForUrl(child?: ChildProcess): Promise<string> {
      return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        let stderr = "";
        let lastCandidate = "";
        const timers: { poll?: NodeJS.Timeout; timeout?: NodeJS.Timeout } = {};
        const onStderr = (chunk: Buffer | string) => {
          stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
        };
        const onError = (error: Error) => finish(new Error(`Viewport QA serve failed before browser launch: ${error.message}`));
        const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(
          `Viewport QA serve exited before browser launch (code ${String(code)}, signal ${String(signal)}): ${stderr.trim() || "no stderr"}`,
        ));
        const removeListeners = () => {
          child?.stderr?.removeListener("data", onStderr);
          child?.removeListener("error", onError);
          child?.removeListener("close", onClose);
        };
        const finish = (error?: Error, url?: string) => {
          if (settled) return;
          settled = true;
          if (timers.poll) clearInterval(timers.poll);
          if (timers.timeout) clearTimeout(timers.timeout);
          removeListeners();
          if (error) rejectPromise(error);
          else resolvePromise(url!);
        };
        child?.stderr?.on("data", onStderr);
        child?.on("error", onError);
        child?.on("close", onClose);
        const readCapturedUrl = () => {
          if (!existsSync(capturePath)) return;
          const value = readFileSync(capturePath, "utf8").trim();
          if (!validCapturedLaunchUrl(value)) { lastCandidate = ""; return; }
          if (value === lastCandidate) finish(undefined, value);
          else lastCandidate = value;
        };
        timers.poll = setInterval(readCapturedUrl, 20);
        timers.timeout = setTimeout(() => finish(new Error(
          `browser launch URL was not captured within 20 seconds${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        )), 20_000);
        const buffered = child?.stderr?.read() as Buffer | string | null | undefined;
        if (buffered) onStderr(buffered);
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
          queueMicrotask(() => onClose(child.exitCode, child.signalCode));
          return;
        }
        readCapturedUrl();
      });
    },
    cleanup(): void { rmSync(root, { recursive: true, force: true }); },
  };
}

export function assertBuilt(): void {
  if (!existsSync(BIN)) {
    throw new Error(
      `Built CLI not found at ${BIN}; run "pnpm run build" first (check-all does this).`,
    );
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<ExitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(
          new Error(`child did not exit within ${timeoutMs}ms after SIGTERM`),
        );
        return;
      }
      resolvePromise({ code, signal });
    });
  });
}

type PortProbe = "listening" | "refused" | "no-answer";
type ProbePort = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<PortProbe>;

function probePort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<PortProbe> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise("no-answer");
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise("listening");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
        resolvePromise("refused");
      } else {
        rejectPromise(error);
      }
    });
  });
}

/**
 * Fails on any completed connection. Refusal/reset proves closure immediately;
 * otherwise a bounded series of unanswered probes also proves no listener was
 * reachable without depending on an immediate loopback ECONNREFUSED.
 */
export async function assertPortClosed(
  url: string,
  probe: ProbePort = probePort,
): Promise<void> {
  const { hostname, port } = new URL(url);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await probe(hostname, Number(port), 250);
    if (result === "listening") {
      throw new Error(`port ${hostname}:${port} is still listening`);
    }
    if (result === "refused") return;
  }
}

/** Runs the real shipped binary directly (shebang + exec bit), as a user would. */
export function runBin(
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.platform === "win32" ? process.execPath : BIN, process.platform === "win32" ? [BIN, ...args] : args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(
        new Error(
          `vqa ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, options.timeoutMs ?? 150_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}
