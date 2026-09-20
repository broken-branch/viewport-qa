import { spawn } from "node:child_process";
import type * as childProcessModule from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CliBinaryNotFoundError,
  CliEmptyOutputError,
  CliExitError,
  CliMalformedOutputError,
  CliOutputLimitError,
  CliSubprocessModelAdapter,
  CliTimeoutError,
  MODEL_CONTRACT_VERSION,
  MockModelAdapter,
  NotWiredError,
  StubModelAdapter,
} from "../src/index.js";
import { compileWindowsTestExecutable } from "../../../scripts/windows-test-powershell.mjs";

let fakeCli = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-model-cli.mjs",
);
const SUCCESS_GRANDCHILD_PROBE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/success-grandchild-probe.mjs",
);

const temporaryDirectories: string[] = [];
let nativeFixtureDirectory: string | undefined;

beforeAll(() => {
  if (process.platform !== "win32") return;
  nativeFixtureDirectory = mkdtempSync(join(tmpdir(), "vqa-model-native-fixture-"));
  fakeCli = join(nativeFixtureDirectory, "fake-model-cli.exe");
  compileWindowsTestExecutable(
    fakeCli,
    join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-model-cli.cs"),
  );
});

afterAll(() => {
  if (nativeFixtureDirectory) rmSync(nativeFixtureDirectory, { recursive: true, force: true });
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeAdapter(
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    log?: (event: unknown) => void;
  } = {},
): CliSubprocessModelAdapter {
  return new CliSubprocessModelAdapter({
    provider: "codex",
    binary: fakeCli,
    ...options,
  });
}

function request(prompt: string): {
  role: "fix-recommender";
  system: string;
  prompt: string;
} {
  return { role: "fix-recommender", system: "system literal", prompt };
}

async function waitForProcessExit(pid: number, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`grandchild process ${pid} survived the group sweep`);
}

describe("StubModelAdapter", () => {
  it("reports itself unwired and rejects completions", async () => {
    const stub = new StubModelAdapter();
    expect(stub.describe().wired).toBe(false);
    await expect(
      stub.complete({ role: "fix-recommender", prompt: "x" }),
    ).rejects.toBeInstanceOf(NotWiredError);
  });
});

describe("MockModelAdapter", () => {
  it("records requests and replays canned replies", async () => {
    const mock = new MockModelAdapter([
      { text: "use min-width: 0", model: "mock-model" },
    ]);
    const result = await mock.complete({
      role: "fix-recommender",
      prompt: "issue",
    });
    expect(result.text).toBe("use min-width: 0");
    expect(mock.requests).toHaveLength(1);
    expect(mock.describe().wired).toBe(true);
  });
});

describe("CliSubprocessModelAdapter", () => {
  it("reports the subprocess implementation, wired state, and contract version honestly", () => {
    expect(fakeAdapter().describe()).toEqual({
      impl: "cli-subprocess:codex",
      wired: true,
      contractVersion: MODEL_CONTRACT_VERSION,
    });
    expect(new StubModelAdapter().describe().wired).toBe(false);
  });

  it("accepts a strict structured recommendation from the fake CLI", async () => {
    await expect(fakeAdapter().complete(request("ordinary input"))).resolves.toEqual(
      {
        text: "Use min-width: 0.",
        model: "codex:subscription-default",
      },
    );
  });

  it("missing binary guard rejects with CliBinaryNotFoundError and actionable text", async () => {
    const adapter = new CliSubprocessModelAdapter({
      provider: "codex",
      binary: join(tmpdir(), `vqa-missing-cli-${process.pid}`),
    });
    await expect(adapter.complete(request("missing"))).rejects.toMatchObject({
      name: "CliBinaryNotFoundError",
      message: expect.stringContaining("Install codex and sign in"),
    });
    await expect(adapter.complete(request("missing"))).rejects.toBeInstanceOf(
      CliBinaryNotFoundError,
    );
  });

  it("non-zero exit guard rejects with CliExitError without stderr", async () => {
    const completion = fakeAdapter().complete(request("__MODE_EXIT__"));
    await expect(completion).rejects.toMatchObject({
      name: "CliExitError",
      exitCode: 1,
      message: expect.stringContaining("exited unsuccessfully (exit code 1)"),
    });
    await expect(
      fakeAdapter().complete(request("__MODE_EXIT__")),
    ).rejects.toBeInstanceOf(CliExitError);
  });

  it.skipIf(process.platform === "win32")(
    "timeout guard kills the entire process group (POSIX group signaling is unavailable on Windows)",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "vqa-model-group-"));
      temporaryDirectories.push(directory);
      const marker = join(directory, "grandchild-survived");
      await expect(
        fakeAdapter({ timeoutMs: 40 }).complete(
          request(`__MODE_HANG__\n__GROUP_MARKER__${marker}`),
        ),
      ).rejects.toBeInstanceOf(CliTimeoutError);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 550));
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "success-path sweep kills a disconnected grandchild and drains (POSIX group signaling is unavailable on Windows)",
    async () => {
      const directory = mkdtempSync(
        join(tmpdir(), "vqa-model-success-group-"),
      );
      temporaryDirectories.push(directory);
      const marker = join(directory, "grandchild-survived");
      const probe = spawn(process.execPath, [SUCCESS_GRANDCHILD_PROBE, marker], {
        stdio: "ignore",
      });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          probe.kill("SIGKILL");
          rejectPromise(new Error("success-path grandchild probe did not drain"));
        }, 1_500);
        probe.once("error", (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        });
        probe.once("close", (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolvePromise();
          else rejectPromise(new Error(`probe exited with ${code ?? signal}`));
        });
      });
      const grandchildPid = Number.parseInt(
        readFileSync(`${marker}.pid`, "utf8"),
        10,
      );
      await waitForProcessExit(grandchildPid);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 550));
      expect(existsSync(`${marker}.ready`)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("maps a synchronous native spawn failure to CliSpawnError", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        spawn: (() => { throw Object.assign(new Error("synchronous spawn failure"), { code: "EFTYPE" }); }) as typeof actual.spawn,
      };
    });
    try {
      const { CliSubprocessModelAdapter: FreshAdapter, CliSpawnError: FreshSpawnError } = await import("../src/index.js");
      const adapter = new FreshAdapter({ provider: "codex", binary: fakeCli });
      await expect(adapter.complete(request("ordinary input"))).rejects.toBeInstanceOf(FreshSpawnError);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("emits a typed note instead of calling taskkill after a mocked Windows leader exit", async () => {
    const spawnCommands: string[] = [];
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        spawn: ((command, ...args) => {
          spawnCommands.push(String(command));
          return actual.spawn(command, ...args);
        }) as typeof actual.spawn,
      };
    });
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      const { CliSubprocessModelAdapter: MockPlatformAdapter } = await import(
        "../src/index.js"
      );
      const events: unknown[] = [];
      const adapter = new MockPlatformAdapter({
        provider: "codex",
        binary: fakeCli,
        log: (event) => events.push(event),
      });

      await expect(adapter.complete(request("ordinary input"))).resolves.toMatchObject({
        text: "Use min-width: 0.",
      });
      expect(spawnCommands).toEqual([fakeCli]);
      expect(events).toContainEqual({
        type: "lifecycle-note",
        code: "windows-post-exit-descendants-may-survive",
        message:
          "Windows process-tree termination was skipped because the CLI leader had already exited; without a job object, its descendants may survive.",
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("empty stdout guard rejects with CliEmptyOutputError", async () => {
    await expect(
      fakeAdapter().complete(request("__MODE_EMPTY__")),
    ).rejects.toBeInstanceOf(CliEmptyOutputError);
  });

  it("malformed stdout guard rejects garbage with CliMalformedOutputError", async () => {
    await expect(
      fakeAdapter().complete(request("__MODE_GARBAGE__")),
    ).rejects.toBeInstanceOf(CliMalformedOutputError);
  });

  it("malformed stdout guard rejects duplicate top-level key tokens", async () => {
    await expect(
      fakeAdapter().complete(request("__MODE_DUPLICATE_KEY__")),
    ).rejects.toBeInstanceOf(CliMalformedOutputError);
  });

  it("accepts a response with exactly one top-level key token", async () => {
    await expect(
      fakeAdapter().complete(request("__MODE_SINGLE_KEY__")),
    ).resolves.toMatchObject({ text: "single key accepted" });
  });

  it("stdout byte-cap guard rejects with CliOutputLimitError", async () => {
    await expect(
      fakeAdapter({ maxOutputBytes: 256 }).complete(
        request("__MODE_OVERSIZED__"),
      ),
    ).rejects.toBeInstanceOf(CliOutputLimitError);
  });

  it("discards stderr noise on successful completion", async () => {
    await expect(
      fakeAdapter().complete(request("__MODE_STDERR_SUCCESS__")),
    ).resolves.toMatchObject({ text: "Use min-width: 0." });
  });

  it("passes shell metacharacters, newlines, semicolons, backticks, and a leading dash as one literal post-separator argv", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vqa-model-literal-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "shell-expanded");
    const literal = `-leading $(touch ${marker}); \`touch ${marker}\`\nsecond line\n__MODE_ECHO_ARGV__`;
    const result = await fakeAdapter().complete(request(literal));
    const received = JSON.parse(result.text) as {
      args: string[];
      prompt: string;
    };
    expect(received.args.at(-2)).toBe("--");
    expect(received.args.at(-1)).toBe(received.prompt);
    expect(received.prompt).toContain(literal);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not inherit API-key billing credentials into the CLI process", async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = ["sk", "live", "must-not-reach-child"].join(
      "-",
    );
    try {
      const result = await fakeAdapter().complete(request("__MODE_ENV__"));
      expect(JSON.parse(result.text)).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it("redaction guard keeps a secret-shaped prompt token out of logs and errors", async () => {
    const secret = ["sk", "live", "REDACTION-PROBE-123456789"].join("-");
    const logs: unknown[] = [];
    let thrown: unknown;
    try {
      await fakeAdapter({ log: (message) => logs.push(message) }).complete(
        request(`__MODE_REDACTION__ ${secret}`),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliExitError);
    const errorText = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    expect([...logs, errorText].join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain("__MODE_REDACTION__");
  });
});
