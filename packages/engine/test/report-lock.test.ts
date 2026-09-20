import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireReportWriterLock } from "../src/report-lock.js";

describe("report writer lock observation races", () => {
  it("retries when the observed lock vanishes before component verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-lock-vanish-"));
    const lockPath = join(root, "writer.lock");
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    let raced = false;
    const release = await acquireReportWriterLock({
      lockPath,
      conflictMessage: "busy",
      hooks: { afterLockObserved: async () => { if (!raced) { raced = true; await rm(lockPath, { recursive: true }); } } },
    });
    expect(raced).toBe(true);
    await release();
    await rm(root, { recursive: true, force: true });
  });

  it("fails closed when an observed lock is replaced by a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-lock-replace-"));
    const lockPath = join(root, "writer.lock");
    const outside = join(root, "outside");
    await mkdir(lockPath);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    let raced = false;
    await expect(acquireReportWriterLock({
      lockPath,
      conflictMessage: "busy",
      hooks: { afterLockObserved: async () => {
        if (raced) return;
        raced = true;
        await rm(lockPath, { recursive: true });
        await symlink(outside, lockPath, process.platform === "win32" ? "junction" : "dir");
      } },
    })).rejects.toThrow("legacy or unsafe");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
    await rm(root, { recursive: true, force: true });
  });

  it("fails closed when the observed lock parent is replaced before retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-lock-parent-replace-"));
    const parent = join(root, "authority");
    const lockPath = join(parent, "writer.lock");
    const outside = join(root, "outside");
    await mkdir(lockPath, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    await expect(acquireReportWriterLock({
      lockPath,
      conflictMessage: "busy",
      hooks: { afterLockObserved: async () => {
        await rm(parent, { recursive: true });
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      } },
    })).rejects.toThrow("lock parent changed");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
    await expect(lstat(join(outside, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  });

  it("removes only its empty lock when the parent is replaced during creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-lock-create-parent-replace-"));
    const parent = join(root, "authority");
    const lockPath = join(parent, "writer.lock");
    const outside = join(root, "outside");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve");
    await expect(acquireReportWriterLock({
      lockPath,
      conflictMessage: "busy",
      hooks: { beforeLockCreate: async () => {
        await rm(parent, { recursive: true });
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      } },
    })).rejects.toThrow("lock parent identity changed");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
    await expect(lstat(join(outside, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  });

  it("preserves a regular-directory replacement generation before stale-owner cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-lock-stale-parent-replace-"));
    const parent = join(root, "authority");
    const lockPath = join(parent, "writer.lock");
    const ownerName = "owner-known.json";
    const ownerPath = join(lockPath, ownerName);
    const replacement = join(root, "replacement");
    const replacementLock = join(replacement, "writer.lock");
    const replacementOwner = join(replacementLock, ownerName);
    await mkdir(lockPath, { recursive: true });
    await writeFile(ownerPath, "{}\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(ownerPath, old, old);
    await mkdir(replacementLock, { recursive: true });
    await writeFile(replacementOwner, "replacement owner\n");
    await writeFile(join(replacementLock, "sentinel"), "preserve");
    await expect(acquireReportWriterLock({
      lockPath,
      conflictMessage: "busy",
      hooks: { afterStaleOwnerObserved: async () => {
        await rm(parent, { recursive: true });
        await rename(replacement, parent);
      } },
    })).rejects.toThrow("lock parent changed");
    expect(await readFile(join(lockPath, ownerName), "utf8")).toBe("replacement owner\n");
    expect(await readFile(join(lockPath, "sentinel"), "utf8")).toBe("preserve");
    await rm(root, { recursive: true, force: true });
  });
});
