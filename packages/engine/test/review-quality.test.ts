import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import type { Issue, IssueType, Report, ViewportResult } from "@vqa/contract";
import { disambiguateSemanticFingerprints } from "../src/collector.js";
import { buildReviewManifest } from "../src/review-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function issue(viewport: string, id: string, overrides: Partial<Issue> = {}): Issue {
  const selector = "main#synthetic > p:nth-child(2)";
  return {
    id,
    viewport,
    pageUrl: "https://review-quality.example/sample",
    type: "contrast",
    severity: "high",
    selector,
    semanticName: "account status label",
    elementFingerprint: "scope:main|role:text|name:account status label|path:main#synthetic>p:nth-child(2)",
    technicalLocator: selector,
    confidence: "high",
    confidenceReasons: ["Synthetic flat-color measurement is below the expected threshold."],
    observedOutcome: "Account status label measures 4.10:1 contrast; the expected minimum is 4.5:1.",
    acceptanceCriterion: "Account status label meets WCAG AA at every affected size.",
    description: "Text contrast is 4.10:1; WCAG AA requires 4.5:1 for normal text.",
    rect: { x: 20, y: 30, width: 120, height: 20 },
    heuristicSuggestion: { kind: "heuristic", text: "Increase the measured contrast." },
    instanceCount: 1,
    occurrences: [{
      semanticName: "account status label",
      elementFingerprint: "scope:main|role:text|name:account status label|path:main#synthetic>p:nth-child(2)",
      technicalLocator: selector,
      rect: { x: 20, y: 30, width: 120, height: 20 },
    }],
    screenshots: { viewport: `screenshots/${viewport}.png` },
    aiRecommendation: { status: "unavailable", reason: "synthetic fixture" },
    ...overrides,
  };
}

describe("semantic review-quality regression", () => {
  it("groups causal concerns across captures and retains every technical occurrence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-semantic-review-"));
    roots.push(root);
    const labels = ["390x844@1", "1280x800@1", "1920x1080@1"];
    const dimensions = [[390, 844], [1280, 800], [1920, 1080]] as const;
    const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    const viewports: ViewportResult[] = [];
    await mkdir(join(root, "screenshots"));
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index]!;
      await writeFile(join(root, `screenshots/${label}.png`), png);
      const [width, height] = dimensions[index]!;
      viewports.push({
        viewport: { width, height, deviceScaleFactor: 1, label },
        page: { scrollWidth: width, scrollHeight: height, viewportWidth: width, viewportHeight: height },
        screenshot: `screenshots/${label}.png`,
        issueCount: 1,
        rawIssueCount: 1,
      });
    }
    const issues = labels.map((label, index) => issue(label, `contrast-${index}`));
    for (const [index, label] of labels.slice(1).entries()) {
      const base = issue(label, `overflow-${index}`, {
        type: "element-overflow",
        severity: "medium",
        semanticName: "footer navigation",
        elementFingerprint: "visible-spill:footer-navigation-source",
        confidence: "likely-noise",
        confidenceReasons: ["The synthetic delta has no painted spill."],
        observedOutcome: "No painted footer content crosses the visible boundary.",
        acceptanceCriterion: "Footer navigation remains contained and readable.",
        selector: `footer#fixture > nav:nth-child(${index + 1})`,
        technicalLocator: `footer#fixture > nav:nth-child(${index + 1})`,
        description: "Synthetic nested overflow diagnostic.",
        instanceCount: 3,
        occurrences: [1, 2, 3].map((depth) => ({
          semanticName: "footer navigation",
          elementFingerprint: "visible-spill:footer-navigation-source",
          technicalLocator: `footer#fixture > div:nth-child(${depth})`,
          rect: { x: 0, y: 700, width: 200, height: 40 },
        })),
      });
      issues.push(base);
    }
    const report: Report = {
      formatVersion: "2",
      tool: "viewport-qa",
      toolVersion: "0.3.0",
      url: "https://review-quality.example/sample",
      createdAt: "2026-08-24T12:00:00.000Z",
      adapter: { impl: "stub", wired: false },
      viewports,
      issues,
    };

    const manifest = await buildReviewManifest(report, root);
    const contrast = manifest.issues.find((entry) => entry.type === "contrast")!;
    const overflow = manifest.issues.find((entry) => entry.type === "element-overflow")!;
    expect(manifest.issues).toHaveLength(2);
    expect(manifest.issues.every((entry) => /^concern-[0-9a-f]{20}$/u.test(entry.id))).toBe(true);
    expect(contrast.capture_coordinate_ids).toHaveLength(3);
    expect(contrast.occurrence_count).toBe(3);
    expect(contrast.title).not.toContain("nth-child");
    expect(contrast.title).not.toBe(contrast.description);
    expect(contrast.technical_locator).toContain("nth-child");
    expect(overflow.capture_coordinate_ids).toHaveLength(2);
    expect(overflow.occurrence_count).toBe(6);
    expect(overflow.confidence).toBe("likely-noise");
    expect(manifest.audit_verdict.value).toBe("FAIL");
  });

  it("groups stable semantic signatures across reorder and keeps ambiguous peers capture-local", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-responsive-identity-"));
    roots.push(root);
    await mkdir(join(root, "screenshots"));
    const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    const captures = [
      { label: "390x844@1", width: 390, height: 844 },
      { label: "1280x800@1", width: 1280, height: 800 },
    ];
    const viewports: ViewportResult[] = [];
    for (const capture of captures) {
      await writeFile(join(root, `screenshots/${capture.label}.png`), png);
      viewports.push({
        viewport: { ...capture, deviceScaleFactor: 1 },
        page: {
          scrollWidth: capture.width,
          scrollHeight: capture.height,
          viewportWidth: capture.width,
          viewportHeight: capture.height,
        },
        screenshot: `screenshots/${capture.label}.png`,
        issueCount: 5,
        rawIssueCount: 5,
      });
    }

    const accountBase = "scope:checkout|role:status|kind:p|name:account%20status";
    const accountMobile = disambiguateSemanticFingerprints([{
      baseFingerprint: accountBase,
      structuralPath: "main#fixture > p:nth-child(1)",
    }])[0]!;
    const accountDesktop = disambiguateSemanticFingerprints([{
      baseFingerprint: accountBase,
      structuralPath: "main#fixture > p:nth-child(2)",
    }])[0]!;
    expect(accountDesktop).toBe(accountMobile);

    const stablePeerBases = [
      "scope:checkout|role:status|kind:p|name:shipping%20status|attrs:data-testid=primary",
      "scope:checkout|role:status|kind:p|name:shipping%20status|attrs:data-testid=secondary",
    ];
    const repeatedBase = "scope:checkout|role:status|kind:p|name:delivery%20status";
    const mobilePaths = [
      "main#fixture > p:nth-child(3)",
      "main#fixture > p:nth-child(4)",
    ];
    const desktopPaths = [...mobilePaths].reverse();
    const repeatedMobile = disambiguateSemanticFingerprints(
      mobilePaths.map((structuralPath) => ({ baseFingerprint: repeatedBase, structuralPath })),
    );
    const repeatedDesktop = disambiguateSemanticFingerprints(
      desktopPaths.map((structuralPath) => ({ baseFingerprint: repeatedBase, structuralPath })),
    );
    expect(new Set(repeatedMobile)).toHaveLength(2);
    expect(repeatedMobile.every((fingerprint) => fingerprint.includes("|identity-ambiguous:"))).toBe(true);

    const responsiveIssue = (
      viewport: string,
      id: string,
      type: IssueType,
      selector: string,
      semanticName: string,
      elementFingerprint: string,
      ratio = "4.10",
    ): Issue => issue(viewport, id, {
      type,
      selector,
      semanticName,
      elementFingerprint,
      technicalLocator: selector,
      observedOutcome: `${semanticName} measures ${ratio}:1 contrast; the expected minimum is 4.5:1.`,
      description: `Text contrast is ${ratio}:1; WCAG AA requires 4.5:1 for normal text.`,
      occurrences: [{
        semanticName,
        elementFingerprint,
        technicalLocator: selector,
        rect: { x: 20, y: 30, width: 120, height: 20 },
      }],
    });
    const issues: Issue[] = [
      responsiveIssue(captures[0]!.label, "account-contrast-phone", "contrast", "main#fixture > p:nth-child(1)", "account status", accountMobile),
      responsiveIssue(captures[1]!.label, "account-contrast-desktop", "contrast", "main#fixture > p:nth-child(2)", "account status", accountDesktop),
      responsiveIssue(captures[0]!.label, "account-color-phone", "color", "main#fixture > p:nth-child(1)", "account status", accountMobile),
      responsiveIssue(captures[1]!.label, "account-color-desktop", "color", "main#fixture > p:nth-child(2)", "account status", accountDesktop),
      ...captures.flatMap((capture, captureIndex) => stablePeerBases.map((fingerprint, peerIndex) =>
        responsiveIssue(
          capture.label,
          `stable-${captureIndex}-${peerIndex}`,
          "contrast",
          (captureIndex === 0 ? mobilePaths : desktopPaths)[peerIndex]!,
          "shipping status",
          fingerprint,
          peerIndex === 0 ? "3.10" : "3.20",
        ))),
      ...captures.flatMap((capture, captureIndex) => mobilePaths.map((_unused, peerIndex) =>
        responsiveIssue(
          capture.label,
          `ambiguous-${captureIndex}-${peerIndex}`,
          "contrast",
          (captureIndex === 0 ? mobilePaths : desktopPaths)[peerIndex]!,
          "delivery status",
          (captureIndex === 0 ? repeatedMobile : repeatedDesktop)[peerIndex]!,
          (captureIndex === 0 ? ["1.15", "1.24"][peerIndex] : ["1.33", "1.42"][peerIndex])!,
        ))),
    ];
    const report: Report = {
      formatVersion: "2",
      tool: "viewport-qa",
      toolVersion: "0.3.0",
      url: "https://responsive-identity.example/sample",
      createdAt: "2026-08-24T18:00:00.000Z",
      adapter: { impl: "stub", wired: false },
      viewports,
      issues,
    };

    const manifest = await buildReviewManifest(report, root);
    const accountFamilies = manifest.issues.filter((entry) => entry.semantic_name === "account status");
    expect(accountFamilies).toHaveLength(2);
    expect(accountFamilies.map((entry) => entry.type).sort()).toEqual(["color", "contrast"]);
    expect(accountFamilies.every((entry) => entry.capture_coordinate_ids.length === 2)).toBe(true);
    const stableFamilies = manifest.issues.filter((entry) => entry.semantic_name === "shipping status");
    expect(stableFamilies).toHaveLength(2);
    expect(stableFamilies.every((entry) => entry.capture_coordinate_ids.length === 2)).toBe(true);
    const repeatedFamilies = manifest.issues.filter((entry) => entry.semantic_name === "delivery status");
    expect(repeatedFamilies).toHaveLength(4);
    expect(repeatedFamilies.every((entry) => entry.capture_coordinate_ids.length === 1)).toBe(true);
    expect(repeatedFamilies.every((entry) => entry.confidence === "needs-confirmation")).toBe(true);
    expect(repeatedFamilies.every((entry) =>
      entry.confidence_reasons?.some((reason) => reason.includes("identity is ambiguous across captures"))
    )).toBe(true);
    const evidence = repeatedFamilies.map((entry) => ({
      locator: entry.occurrences?.[0]?.technical_locator,
      outcome: entry.observed_outcome,
      capture: entry.occurrences?.[0]?.capture_coordinate_id,
    }));
    expect(evidence).toHaveLength(4);
    expect(new Set(evidence.map((entry) => entry.capture))).toHaveLength(2);
    expect(evidence.map((entry) => entry.outcome).sort()).toEqual([
      "delivery status measures 1.15:1 contrast; the expected minimum is 4.5:1.",
      "delivery status measures 1.24:1 contrast; the expected minimum is 4.5:1.",
      "delivery status measures 1.33:1 contrast; the expected minimum is 4.5:1.",
      "delivery status measures 1.42:1 contrast; the expected minimum is 4.5:1.",
    ]);
    expect(evidence.every((entry) => entry.locator?.includes("nth-child"))).toBe(true);
  });

  it("propagates peer-cardinality ambiguity across the complete capture set", async () => {
    const root = await mkdtemp(join(tmpdir(), "vqa-responsive-cardinality-"));
    roots.push(root);
    await mkdir(join(root, "screenshots"));
    const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    const captures = [
      { label: "390x844@1", width: 390, height: 844 },
      { label: "1280x800@1", width: 1280, height: 800 },
    ];
    for (const capture of captures) {
      await writeFile(join(root, `screenshots/${capture.label}.png`), png);
    }
    const base = "scope:summary|role:status|kind:p|name:order%20status";
    const mobileFingerprint = disambiguateSemanticFingerprints([{
      baseFingerprint: base,
      structuralPath: "main#fixture > p:nth-child(1)",
    }])[0]!;
    const desktopFingerprints = disambiguateSemanticFingerprints([
      { baseFingerprint: base, structuralPath: "main#fixture > p:nth-child(2)" },
      { baseFingerprint: base, structuralPath: "main#fixture > p:nth-child(3)" },
    ]);
    expect(mobileFingerprint).toBe(base);
    const makeIssue = (viewport: string, id: string, selector: string, fingerprint: string, ratio: string) =>
      issue(viewport, id, {
        selector,
        semanticName: "order status",
        elementFingerprint: fingerprint,
        technicalLocator: selector,
        observedOutcome: `order status measures ${ratio}:1 contrast; the expected minimum is 4.5:1.`,
        occurrences: [{
          semanticName: "order status",
          elementFingerprint: fingerprint,
          technicalLocator: selector,
          rect: { x: Number.parseInt(ratio.replace(".", ""), 10), y: 30, width: 120, height: 20 },
        }],
      });
    const report: Report = {
      formatVersion: "2",
      tool: "viewport-qa",
      toolVersion: "0.3.0",
      url: "https://responsive-cardinality.example/sample",
      createdAt: "2026-08-24T19:00:00.000Z",
      adapter: { impl: "stub", wired: false },
      viewports: captures.map((capture) => ({
        viewport: { ...capture, deviceScaleFactor: 1 },
        page: {
          scrollWidth: capture.width,
          scrollHeight: capture.height,
          viewportWidth: capture.width,
          viewportHeight: capture.height,
        },
        screenshot: `screenshots/${capture.label}.png`,
        issueCount: capture.label === captures[0]!.label ? 1 : 2,
        rawIssueCount: capture.label === captures[0]!.label ? 1 : 2,
      })),
      issues: [
        makeIssue(captures[0]!.label, "mobile-persistent", "main#fixture > p:nth-child(1)", mobileFingerprint, "2.10"),
        makeIssue(captures[1]!.label, "desktop-peer-a", "main#fixture > p:nth-child(2)", desktopFingerprints[0]!, "2.20"),
        makeIssue(captures[1]!.label, "desktop-peer-b", "main#fixture > p:nth-child(3)", desktopFingerprints[1]!, "2.30"),
      ],
    };

    const manifest = await buildReviewManifest(report, root);
    const repeatedFamilies = manifest.issues.filter((entry) => entry.semantic_name === "order status");
    expect(repeatedFamilies).toHaveLength(3);
    expect(repeatedFamilies.every((entry) => entry.capture_coordinate_ids.length === 1)).toBe(true);
    expect(repeatedFamilies.every((entry) => entry.confidence === "needs-confirmation")).toBe(true);
    expect(repeatedFamilies.map((entry) => entry.observed_outcome).sort()).toEqual([
      "order status measures 2.10:1 contrast; the expected minimum is 4.5:1.",
      "order status measures 2.20:1 contrast; the expected minimum is 4.5:1.",
      "order status measures 2.30:1 contrast; the expected minimum is 4.5:1.",
    ]);
    expect(repeatedFamilies.map((entry) => entry.occurrences?.[0]?.rect.x).sort()).toEqual([210, 220, 230]);
    expect(manifest.audit_verdict.value).toBe("PASS");
  });

  it("keeps the derived shape explicitly synthetic and asset-free", async () => {
    const path = new URL("fixtures/review-quality/synthetic-review-shape.json", import.meta.url);
    const raw = await readFile(path, "utf8");
    const fixture = JSON.parse(raw) as {
      provenance: string;
      source_material: string;
      page: string;
      copied_assets: unknown[];
    };
    expect(fixture.provenance).toBe("locally-authored-synthetic");
    expect(fixture.source_material).toBe("none");
    expect(new URL(fixture.page).hostname.endsWith(".example")).toBe(true);
    expect(fixture.copied_assets).toEqual([]);
    expect(raw).not.toMatch(/<html|sha256|image\/png/iu);
  });
});
