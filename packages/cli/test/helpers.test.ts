import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { assertPortClosed, captureBrowserLaunch } from "./helpers.js";

function listen(): Promise<Server> {
  const server = createServer(() => {});
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function urlOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("assertPortClosed", () => {
  it("fails while something is still accepting connections", async () => {
    const server = await listen();
    try {
      await expect(assertPortClosed(urlOf(server))).rejects.toThrow(
        /still listening/,
      );
    } finally {
      await close(server);
    }
  });

  it("passes once nothing accepts connections", async () => {
    const server = await listen();
    const url = urlOf(server);
    await close(server);
    await expect(assertPortClosed(url)).resolves.toBeUndefined();
  });

  it("passes after a bounded sequence of no-answer probes", async () => {
    const probe = vi.fn(async () => "no-answer" as const);
    await expect(
      assertPortClosed("http://127.0.0.1:1", probe),
    ).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(8);
  });
});

describe("browser launch capture", () => {
  it("reports an early child exit and its stderr without waiting for the outer timeout", async () => {
    const capture = captureBrowserLaunch();
    const child = spawn(process.execPath, ["-e", "process.stderr.write('diagnostic sentinel'); process.exit(7)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = Date.now();
    try {
      await expect(capture.waitForUrl(child)).rejects.toThrow(/code 7[\s\S]*diagnostic sentinel/u);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      capture.cleanup();
    }
  });

  it("ignores partial writes, validates the capability URL, and removes its listeners after success", async () => {
    const capture = captureBrowserLaunch();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: ["ignore", "pipe", "pipe"] });
    const capturePath = capture.env.VQA_TEST_BROWSER_CAPTURE!;
    const before = {
      error: child.listenerCount("error"),
      close: child.listenerCount("close"),
      stderr: child.stderr!.listenerCount("data"),
    };
    let resolved = false;
    const validUrl = `http://127.0.0.1:43123/#cap=${"a".repeat(43)}`;
    try {
      const waiting = capture.waitForUrl(child).then((value) => { resolved = true; return value; });
      writeFileSync(capturePath, `http://127.0.0.1:43123/#cap=${"a".repeat(10)}`);
      await new Promise((done) => setTimeout(done, 75));
      expect(resolved).toBe(false);
      writeFileSync(capturePath, validUrl);
      await expect(waiting).resolves.toBe(validUrl);
      expect(child.listenerCount("error")).toBe(before.error);
      expect(child.listenerCount("close")).toBe(before.close);
      expect(child.stderr!.listenerCount("data")).toBe(before.stderr);
    } finally {
      child.kill("SIGKILL");
      await once(child, "close");
      capture.cleanup();
    }
  });

  it("diagnoses a child that already exited before capture begins", async () => {
    const capture = captureBrowserLaunch();
    const child = spawn(process.execPath, ["-e", "process.stderr.write('already gone'); process.exit(9)"], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child, "close");
    try {
      await expect(capture.waitForUrl(child)).rejects.toThrow(/code 9/u);
    } finally {
      capture.cleanup();
    }
  });
});
