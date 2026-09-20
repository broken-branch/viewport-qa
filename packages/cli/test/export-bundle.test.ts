import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReviewManifest, ReviewState } from "@vqa/contract";
import {
  createHumanHandoffContent,
  createPortableBundleContent,
  EXPORT_POLICY_ID,
  reviewStateSha256,
} from "../src/export-bundle.js";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../engine/test/fixtures/review-journey/review-manifest.json", import.meta.url),
    "utf8",
  ),
) as ReviewManifest;

const CLIPPED = "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED";
const CONTRAST = "VQ-ISSUE-HOME-LOW-CONTRAST-CTA";

function reviewState(exported: string[], notes: Record<string, string> = {}, dismissed: string[] = []): ReviewState {
  return {
    artifact_type: "vq-review-state",
    schema_version: 2,
    manifest_id: manifest.manifest_id,
    manifest_sha256: "fixture-manifest",
    issues: {
      ...Object.fromEntries(exported.map((issueId) => [issueId, {
        status: "export" as const,
        ...(notes[issueId] ? { note: notes[issueId] } : {}),
        updated_at: "2026-08-23T12:00:00.000Z",
      }])),
      ...Object.fromEntries(dismissed.map((issueId) => [issueId, {
        status: "dismissed" as const,
        updated_at: "2026-08-23T12:00:00.000Z",
      }])),
    },
    highlights: {},
  };
}

describe("createHumanHandoffContent", () => {
  it("formats deterministic plain text with one numbered entry per exported issue", () => {
    const state = reviewState([CONTRAST, CLIPPED], { [CLIPPED]: "Give the total enough room." });
    const first = createHumanHandoffContent({ manifest, reviewState: state });
    const second = createHumanHandoffContent({ manifest, reviewState: state });
    expect(second).toBe(first);
    expect(first).toContain("VIEWPORT QA HANDOFF");
    expect(first).toContain("2 issues selected by the reviewer.");
    // Severity leads: the high-severity clipped total comes before the contrast concern.
    expect(first.indexOf("1. Checkout total is clipped")).toBeGreaterThan(0);
    expect(first.indexOf("1. Checkout total is clipped")).toBeLessThan(first.indexOf("2. Primary action is hard to read"));
    expect(first).toContain("What was found: The order total does not fit in its available space.");
    expect(first).toContain("Where: Checkout at 390 × 844; Checkout at 1280 × 800");
    expect(first).toContain("Reviewer note: Give the total enough room.");
    expect(first).toContain("Suggested fix:");
    expect(first).toContain("Screenshots: 390 × 844:");
    expect(first.match(/Source: https:\/\/northstar\.example\/checkout/gu)).toHaveLength(1);
    expect(first).toContain("Issues the reviewer dismissed or did not select are not included.");
    expect(first).not.toMatch(/VQ-|audit|hash|policy|reason code|schema|format|version/iu);
  });

  it("leaves out dismissed and undecided issues", () => {
    const content = createHumanHandoffContent({ manifest, reviewState: reviewState([CLIPPED], {}, [CONTRAST]) });
    expect(content).toContain("1 issue selected by the reviewer.");
    expect(content).toContain("Checkout total is clipped");
    expect(content).not.toContain("Primary action is hard to read");
  });

  it("refuses to export an empty list", () => {
    expect(() => createHumanHandoffContent({ manifest, reviewState: reviewState([]) })).toThrow(/nothing is in the export yet/u);
    expect(() => createHumanHandoffContent({ manifest, reviewState: reviewState([], {}, [CLIPPED, CONTRAST]) })).toThrow(/nothing is in the export yet/u);
  });

  it("leads titles with the concern and keeps selectors to the Element line", () => {
    const candidate = structuredClone(manifest);
    const issue = candidate.issues.find((entry) => entry.id === CLIPPED)!;
    issue.title = "main > footer:nth-child(4): text is clipped";
    issue.description = "main > footer:nth-child(4)";
    issue.selector = "main > footer:nth-child(4)";
    issue.technical_locator = "main > footer:nth-child(4)";
    issue.semantic_name = "footer navigation";
    issue.observed_outcome = "Footer navigation content extends beyond its intended boundary.";
    for (const occurrence of issue.occurrences ?? []) {
      delete occurrence.message;
      occurrence.technical_locator = "main > footer:nth-child(4)";
    }
    const content = createHumanHandoffContent({ manifest: candidate, reviewState: reviewState([issue.id]) });
    expect(content).toContain("1. Text is clipped — footer navigation");
    expect(content).toContain("What was found: Footer navigation content extends beyond its intended boundary.");
    expect(content).toContain("Element: main > footer:nth-child(4)");
    expect(content.split("nth-child").length - 1).toBe(1);
  });
});

describe("AI bundle", () => {
  const coordinateId = "page-checkout--state-alternate--390x844";
  const bundleFor = (state: ReviewState, targetManifest = manifest) => {
    const digest = reviewStateSha256(targetManifest, state.manifest_sha256, state);
    return createPortableBundleContent({
      manifest: targetManifest,
      manifestSha256: state.manifest_sha256,
      reviewState: state,
      identity: {
        export_id: `vqexp-v1-${digest}`,
        exported_at: "2026-08-23T12:00:00.000Z",
        policy_id: EXPORT_POLICY_ID,
        schema_version: 1,
        manifest_sha256: state.manifest_sha256,
        review_state_sha256: digest,
      },
    }).bundle;
  };
  const occurrenceFor = (state: ReviewState, targetManifest = manifest) =>
    bundleFor(state, targetManifest).items.find((item) => item.issue_id === CLIPPED)!.occurrences
      .find((occurrence) => occurrence.coordinate_id === coordinateId)!;

  it("carries one item per exported issue with its note, occurrences, and hash-bound assets", () => {
    const bundle = bundleFor(reviewState([CLIPPED, CONTRAST], { [CLIPPED]: "Give the total enough room." }));
    expect(bundle.schema_version).toBe(2);
    expect(bundle.items.map((item) => item.issue_id)).toEqual([CLIPPED, CONTRAST]);
    const clipped = bundle.items[0]!;
    expect(clipped.reviewer_note).toBe("Give the total enough room.");
    expect(clipped.selected_at).toBe("2026-08-23T12:00:00.000Z");
    expect(clipped.occurrences.map((occurrence) => occurrence.resolution.label)).toEqual(["390 × 844", "1280 × 800"]);
    for (const occurrence of clipped.occurrences) {
      expect(bundle.assets.some((asset) => asset.sha256 === occurrence.full_screenshot_asset_sha256)).toBe(true);
      expect(occurrence.technical_locator).toBeTruthy();
      expect(occurrence.rect.width).toBeGreaterThan(0);
    }
    expect(bundle.assets.every((asset) => /^assets\/[0-9a-f]{64}\.(png|jpg)$/u.test(asset.path))).toBe(true);
  });

  it("changes its review-state digest when a decision or note changes", () => {
    const base = reviewState([CLIPPED]);
    const digests = [
      reviewState([CLIPPED]),
      reviewState([CLIPPED], { [CLIPPED]: "note" }),
      reviewState([CLIPPED, CONTRAST]),
      reviewState([CLIPPED], {}, [CONTRAST]),
    ].map((state) => reviewStateSha256(manifest, state.manifest_sha256, state));
    expect(digests[0]).toBe(reviewStateSha256(manifest, base.manifest_sha256, base));
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("projects padded, adjusted, and removed highlights without mutating detector geometry", () => {
    const original = structuredClone(manifest.issues.find((issue) => issue.id === CLIPPED)!.rects![coordinateId]!);
    const state = reviewState([CLIPPED]);
    expect(occurrenceFor(state).highlight_rect).toEqual({ x: 20, y: 532, width: 350, height: 70 });
    state.highlights[coordinateId] = { [CLIPPED]: { x: 24, y: 528, width: 340, height: 80 } };
    expect(occurrenceFor(state).highlight_rect).toEqual({ x: 24, y: 528, width: 340, height: 80 });
    state.highlights[coordinateId] = { [CLIPPED]: null };
    expect(occurrenceFor(state)).toMatchObject({ highlight_removed: true });
    expect(occurrenceFor(state).highlight_rect).toBeUndefined();
    expect(manifest.issues.find((issue) => issue.id === CLIPPED)!.rects![coordinateId]).toEqual(original);
  });

  it("rejects invalid persisted highlight geometry", () => {
    const state = reviewState([CLIPPED]);
    state.highlights[coordinateId] = { [CLIPPED]: { x: 380, y: 530, width: 40, height: 40 } };
    expect(() => occurrenceFor(state)).toThrow(/invalid issue highlight/u);
  });

  it("clips default visual padding to screenshot bounds", () => {
    const candidate = structuredClone(manifest);
    const issue = candidate.issues.find((entry) => entry.id === CLIPPED)!;
    issue.rects![coordinateId] = { x: 2, y: 3, width: 20, height: 20 };
    const occurrence = issue.occurrences?.find((entry) => entry.capture_coordinate_id === coordinateId);
    if (occurrence) occurrence.rect = { x: 2, y: 3, width: 20, height: 20 };
    expect(occurrenceFor(reviewState([CLIPPED]), candidate).highlight_rect).toEqual({ x: 0, y: 0, width: 30, height: 31 });
  });

  it("refuses an empty export at the same boundary as the human handoff", () => {
    expect(() => bundleFor(reviewState([]))).toThrow(/nothing is in the export yet/u);
  });
});
