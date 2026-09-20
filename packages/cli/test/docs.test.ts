import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PortableReviewBundle, ReviewManifest, ReviewState } from "@vqa/contract";
import { PRODUCT_VERSION } from "@vqa/contract";
import { browserCompatibility } from "@vqa/engine";
import { validateReviewManifest } from "../src/export-bundle.js";
import { assertBuilt, REPO_ROOT, runBin } from "./helpers.js";

const markdown = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/AI-CONSUMPTION.md",
  "docs/browser-management.md",
  "docs/cli-reference.md",
  "docs/privacy-and-data.md",
  "docs/quickstart.md",
  "docs/report-formats.md",
  "docs/review-and-handoff.md",
  "docs/security.md",
  "docs/troubleshooting.md",
];

describe("public documentation", () => {
  it("keeps local Markdown links resolvable", () => {
    for (const relative of markdown) {
      const path = join(REPO_ROOT, relative);
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const target = match[1]!;
        if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
        const file = target.split("#", 1)[0]!;
        expect(existsSync(resolve(dirname(path), file)), `${relative} -> ${target}`).toBe(true);
      }
    }
  });

  it("keeps source version metadata generated from one authority", () => {
    const source = JSON.parse(readFileSync(join(REPO_ROOT, "version.json"), "utf8")) as { version: string };
    expect(PRODUCT_VERSION).toBe(source.version);
    for (const workspace of ["cli", "contract", "detectors", "engine", "model-adapter"]) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages", workspace, "package.json"), "utf8")) as { version: string };
      expect(pkg.version).toBe(source.version);
    }
    expect(readFileSync(join(REPO_ROOT, "README.md"), "utf8")).toContain(`**${source.version}**`);
  });


  it("validates the minimal machine-readable examples and exact manifest binding", () => {
    const manifestBytes = readFileSync(join(REPO_ROOT, "docs/examples/minimal-review-manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReviewManifest;
    const state = JSON.parse(readFileSync(join(REPO_ROOT, "docs/examples/minimal-review-state.json"), "utf8")) as ReviewState;
    const handoff = JSON.parse(readFileSync(join(REPO_ROOT, "docs/examples/minimal-ai-handoff.json"), "utf8")) as PortableReviewBundle;
    expect(() => validateReviewManifest(manifest)).not.toThrow();
    expect(manifest.source_report.tool_version).toBe(PRODUCT_VERSION);
    expect(state).toMatchObject({ artifact_type: "vq-review-state", schema_version: 2, manifest_id: manifest.manifest_id, issues: {}, highlights: {} });
    expect(state.manifest_sha256).toBe(createHash("sha256").update(manifestBytes).digest("hex"));
    expect(handoff).toMatchObject({
      artifact_type: "viewport-qa-change-request-bundle",
      schema_version: 2,
      export_policy_id: "vq-export-identity-v1",
      items: [],
    });
    expect(handoff.source_report.tool_version).toBe(PRODUCT_VERSION);
  });

  it("keeps documented command names aligned with CLI help", async () => {
    assertBuilt();
    const result = await runBin(["--help"]);
    expect(result.code).toBe(0);
    for (const command of ["doctor", "browser", "scan", "baseline", "serve"]) expect(result.stdout).toContain(command);
    const compatibility = browserCompatibility();
    const browserGuide = readFileSync(join(REPO_ROOT, "docs/browser-management.md"), "utf8");
    expect(browserGuide).toContain(`Playwright ${compatibility.playwrightVersion}`);
    expect(browserGuide).toContain(`Chromium revision ${compatibility.browserRevision}`);
    expect(browserGuide).toContain(compatibility.browserVersion);
  });

  it("writes omitted-command usage to stderr with exit code 2", async () => {
    assertBuilt();
    const result = await runBin([]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("vqa scan");
  });
});
