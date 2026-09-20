import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.js";

describe("cross-platform CLI executable helper", () => {
  it("adds execute bits on POSIX without changing existing read/write bits", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "vqa-build-helper-"));
    const target = join(root, "CLI with spaces-é.js");
    writeFileSync(target, "#!/usr/bin/env node\n");
    chmodSync(target, 0o640);

    execFileSync(process.execPath, [join(REPO_ROOT, "scripts/set-cli-executable.mjs"), target]);

    expect(statSync(target).mode & 0o777).toBe(0o751);
  });

  it("accepts a Windows platform simulation without chmod", async () => {
    const helper = await import("../../../scripts/set-cli-executable.mjs") as {
      preserveCliExecutableMode(path: string, platform: NodeJS.Platform): Promise<{ changed: boolean }>;
    };
    const root = mkdtempSync(join(tmpdir(), "vqa-build-helper-win-"));
    const target = join(root, "bin.js");
    writeFileSync(target, "content");
    const before = statSync(target).mode;
    const result = await helper.preserveCliExecutableMode(target, "win32");
    expect(result.changed).toBe(false);
    expect(statSync(target).mode).toBe(before);
  });
});
