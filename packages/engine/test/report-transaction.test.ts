import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "@vqa/contract";
import {
  reportFileSyncOpenFlag,
  unsupportedDirectorySyncError,
  withNewReportTransaction,
} from "../src/report-transaction.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vqa-transaction-test-"));
  roots.push(root);
  return root;
}

function writeValidReport(root: string, marker: string): void {
  mkdirSync(root, { recursive: true });
  const report = {
    formatVersion: "3",
    tool: "viewport-qa",
    toolVersion: PRODUCT_VERSION,
    url: `file:///${marker}.html`,
    createdAt: "2026-08-23T00:00:00.000Z",
    adapter: { impl: "stub", wired: false },
    viewports: [],
    issues: [],
  };
  const manifest = {
    artifact_type: "vq-review-manifest",
    schema_version: 1,
    manifest_id: `manifest-${marker}`,
    run_id: `run-${marker}`,
    source_report: { tool: "viewport-qa", tool_version: PRODUCT_VERSION, format_version: "3", source_sha: marker },
    pages: [], states: [], assets: [], issues: [], captures: [],
    audit_verdict: { value: "PASS", policy_id: "vq-detected-issues-v1", reason_codes: ["NO_DETECTED_ISSUES"] },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const state = {
    artifact_type: "vq-review-state",
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    captures: {},
  };
  writeFileSync(join(root, "issues.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(root, "review-manifest.json"), manifestBytes);
  writeFileSync(join(root, "review-state.json"), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(root, "report.html"), '<script id="vqa-manifest"></script>');
}

function markerAt(root: string): string {
  return (JSON.parse(readFileSync(join(root, "issues.json"), "utf8")) as { url: string }).url;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("report publication transaction", () => {
  it("uses a write-capable Windows file handle while narrowly classifying unsupported directory sync", () => {
    expect(reportFileSyncOpenFlag("win32")).toBe("r+");
    expect(reportFileSyncOpenFlag("linux")).toBe("r");
    expect(unsupportedDirectorySyncError("EPERM", "win32")).toBe(true);
    expect(unsupportedDirectorySyncError("EPERM", "linux")).toBe(false);
    expect(unsupportedDirectorySyncError("EIO", "win32")).toBe(false);
  });

  it("leaves no destination or sibling transaction debris after producer failure", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    await expect(withNewReportTransaction(destination, async (staging) => {
      writeFileSync(join(staging, "partial.txt"), "not a report");
      throw new Error("simulated scan failure");
    })).rejects.toThrow("simulated scan failure");
    expect(existsSync(destination)).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses and preserves a non-empty destination before calling the producer", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    writeFileSync(destination, "operator-owned file");
    let called = false;
    await expect(withNewReportTransaction(destination, async () => {
      called = true;
    })).rejects.toThrow(/not a real directory/u);
    expect(called).toBe(false);
    expect(existsSync(destination)).toBe(true);
  });

  it("rejects a symlinked destination parent", async () => {
    const root = temporaryRoot();
    const real = join(root, "real");
    const alias = join(root, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, "dir");
    await expect(withNewReportTransaction(join(alias, "report"), async () => {}))
      .rejects.toThrow(/must not resolve through a symlink|must be a real directory/u);
  });

  it("allows only one writer for a destination", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    let unblock!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const first = withNewReportTransaction(destination, async () => {
      entered();
      await new Promise<void>((resolve) => { unblock = resolve; });
      throw new Error("stop first writer");
    });
    await ready;
    await expect(withNewReportTransaction(destination, async () => {}))
      .rejects.toThrow(/another report writer/u);
    unblock();
    await expect(first).rejects.toThrow("stop first writer");
  });

  it("recovers a stale-owner lock explicitly", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const lockPath = join(root, ".report.vqa-transaction.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner-stale.json"), JSON.stringify({ pid: 2_147_483_647, lock_id: "stale" }));
    await expect(withNewReportTransaction(destination, async () => {
      throw new Error("stale lock recovered");
    })).rejects.toThrow("stale lock recovered");
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps the last good destination when interrupted before backup rename", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const staging = join(root, ".report.vqa-staging-crash");
    const backup = join(root, ".report.vqa-backup");
    writeValidReport(destination, "old");
    writeValidReport(staging, "new");
    writeFileSync(join(root, ".report.vqa-transaction.json"), JSON.stringify({
      schema_version: 1, destination, staging, backup, phase: "staging-valid",
    }));
    await expect(withNewReportTransaction(destination, async () => {})).rejects.toThrow(/not empty/u);
    expect(markerAt(destination)).toBe("file:///old.html");
    expect(existsSync(staging)).toBe(false);
  });

  it("restores the last-good backup when interrupted after backup rename", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const staging = join(root, ".report.vqa-staging-crash");
    const backup = join(root, ".report.vqa-backup");
    writeValidReport(staging, "new");
    writeValidReport(backup, "old");
    writeFileSync(join(root, ".report.vqa-transaction.json"), JSON.stringify({
      schema_version: 1, destination, staging, backup, phase: "destination-backed-up",
    }));
    await expect(withNewReportTransaction(destination, async () => {})).rejects.toThrow(/not empty/u);
    expect(markerAt(destination)).toBe("file:///old.html");
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  it("keeps the committed destination when interrupted before backup cleanup", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const staging = join(root, ".report.vqa-staging-crash");
    const backup = join(root, ".report.vqa-backup");
    writeValidReport(destination, "new");
    writeValidReport(backup, "old");
    writeFileSync(join(root, ".report.vqa-transaction.json"), JSON.stringify({
      schema_version: 1, destination, staging, backup, phase: "committed",
    }));
    await expect(withNewReportTransaction(destination, async () => {})).rejects.toThrow(/not empty/u);
    expect(markerAt(destination)).toBe("file:///new.html");
    expect(existsSync(backup)).toBe(false);
  });

  it("preserves an unrelated sibling named by an invalid transaction journal", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const unrelated = join(root, "operator-data");
    const backup = join(root, ".report.vqa-backup");
    writeValidReport(destination, "old");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "keep.txt"), "operator-owned");
    writeFileSync(join(root, ".report.vqa-transaction.json"), JSON.stringify({
      schema_version: 1,
      destination,
      staging: unrelated,
      backup,
      phase: "committed",
    }));

    await expect(withNewReportTransaction(destination, async () => {}))
      .rejects.toThrow(/invalid report transaction journal requires operator inspection/u);
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("operator-owned");
    expect(markerAt(destination)).toBe("file:///old.html");
  });

  it("refuses a canonical staging name that resolves through a symlink", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const unrelated = join(root, "operator-data");
    const staging = join(root, ".report.vqa-staging-abc123");
    const backup = join(root, ".report.vqa-backup");
    writeValidReport(destination, "old");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "keep.txt"), "operator-owned");
    symlinkSync(unrelated, staging, "dir");
    writeFileSync(join(root, ".report.vqa-transaction.json"), JSON.stringify({
      schema_version: 1,
      destination,
      staging,
      backup,
      phase: "committed",
    }));

    await expect(withNewReportTransaction(destination, async () => {}))
      .rejects.toThrow(/invalid report transaction journal requires operator inspection/u);
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("operator-owned");
    expect(markerAt(destination)).toBe("file:///old.html");
  });

  it("refuses an external journal symlink without consuming its authority or sibling data", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const staging = join(root, ".report.vqa-staging-abc123");
    const backup = join(root, ".report.vqa-backup");
    const externalJournal = join(root, "operator-journal.json");
    const journal = join(root, ".report.vqa-transaction.json");
    writeValidReport(destination, "old");
    writeValidReport(staging, "new");
    mkdirSync(backup);
    writeFileSync(join(backup, "keep.txt"), "operator-owned backup data");
    const externalBytes = JSON.stringify({
      schema_version: 1,
      destination,
      staging,
      backup,
      phase: "committed",
    });
    writeFileSync(externalJournal, externalBytes);
    symlinkSync(externalJournal, journal);

    await expect(withNewReportTransaction(destination, async () => {}))
      .rejects.toThrow(/invalid report transaction journal requires operator inspection/u);
    expect(readFileSync(externalJournal, "utf8")).toBe(externalBytes);
    expect(readFileSync(join(backup, "keep.txt"), "utf8")).toBe("operator-owned backup data");
    expect(markerAt(staging)).toBe("file:///new.html");
    expect(markerAt(destination)).toBe("file:///old.html");
  });

  it("refuses a symlinked reserved backup immediately before recovery mutation", async () => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const staging = join(root, ".report.vqa-staging-abc123");
    const unrelated = join(root, "operator-data");
    const backup = join(root, ".report.vqa-backup");
    writeValidReport(destination, "old");
    writeValidReport(staging, "new");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "keep.txt"), "operator-owned");
    symlinkSync(unrelated, backup, "dir");
    writeFileSync(join(root, ".report.vqa-transaction.json"), JSON.stringify({
      schema_version: 1,
      destination,
      staging,
      backup,
      phase: "committed",
    }));

    await expect(withNewReportTransaction(destination, async () => {}))
      .rejects.toThrow(/invalid report transaction journal requires operator inspection/u);
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("operator-owned");
    expect(markerAt(staging)).toBe("file:///new.html");
    expect(markerAt(destination)).toBe("file:///old.html");
  });

  it.each([
    { field: "schema", patch: { schema_version: 2 } },
    { field: "phase", patch: { phase: "unknown" } },
  ])("requires operator inspection for an unsupported journal $field", async ({ patch }) => {
    const root = temporaryRoot();
    const destination = join(root, "report");
    const staging = join(root, ".report.vqa-staging-abc123");
    const backup = join(root, ".report.vqa-backup");
    writeValidReport(destination, "old");
    writeValidReport(staging, "new");
    writeFileSync(join(root, ".report.vqa-transaction.json"), JSON.stringify({
      schema_version: 1,
      destination,
      staging,
      backup,
      phase: "committed",
      ...patch,
    }));

    await expect(withNewReportTransaction(destination, async () => {}))
      .rejects.toThrow(/invalid report transaction journal requires operator inspection/u);
    expect(markerAt(destination)).toBe("file:///old.html");
    expect(markerAt(staging)).toBe("file:///new.html");
  });

});
