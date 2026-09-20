import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { launchSandboxedChromium } from "../src/browser-launch.js";

const roots: string[] = [];
const previousCapture = process.env.VQA_FAKE_CHROMIUM_ARGV;

afterEach(async () => {
  if (previousCapture === undefined) delete process.env.VQA_FAKE_CHROMIUM_ARGV;
  else process.env.VQA_FAKE_CHROMIUM_ARGV = previousCapture;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("sandboxed Chromium launch boundary", () => {
  it("makes Playwright enable the sandbox and never append --no-sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-fake-chromium-"));
    roots.push(root);
    const executable = join(root, "fake-chromium");
    const capture = join(root, "argv.txt");
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$VQA_FAKE_CHROMIUM_ARGV\"\nexit 1\n");
    await chmod(executable, 0o700);
    process.env.VQA_FAKE_CHROMIUM_ARGV = capture;

    await expect(launchSandboxedChromium({ executablePath: executable, headless: true })).rejects.toThrow();
    const argv = (await readFile(capture, "utf8")).trim().split("\n");
    expect(argv).not.toContain("--no-sandbox");

    const unsafeCapture = join(root, "unsafe-argv.txt");
    process.env.VQA_FAKE_CHROMIUM_ARGV = unsafeCapture;
    await expect(chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: false })).rejects.toThrow();
    const unsafeArgv = (await readFile(unsafeCapture, "utf8")).trim().split("\n");
    expect(unsafeArgv).toContain("--no-sandbox");
  });
});
