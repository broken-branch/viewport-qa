import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLinkFreeExistingPath } from "../src/path-safety.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("link-free path identity", () => {
  it("accepts a real Windows path even when realpath expands its spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-path-identity-"));
    roots.push(root);
    await mkdir(join(root, "child"));
    expect(await isLinkFreeExistingPath(join(root, "child"), "win32")).toBe(true);
    if (process.platform === "win32" && await realpath(root) !== resolve(root)) {
      expect(await isLinkFreeExistingPath(root)).toBe(true);
    }
  });

  it("rejects an actual symbolic-link or Windows junction component", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-path-link-"));
    roots.push(root);
    const target = join(root, "target");
    const link = join(root, "link");
    await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(await isLinkFreeExistingPath(link, "win32")).toBe(false);
    expect(await isLinkFreeExistingPath(join(link, "missing"), "win32")).toBe(false);
  });
});
