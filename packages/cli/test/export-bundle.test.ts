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

function reviewState(selectedIssueIds: string[], requestedChange = "Give the total enough room and make the primary action readable."): ReviewState {
  const origin = "page-checkout--state-alternate--390x844";
  return {
    artifact_type: "vq-review-state",
    schema_version: 1,
    manifest_id: manifest.manifest_id,
    manifest_sha256: "fixture-manifest",
    captures: Object.fromEntries(
      manifest.captures.map((capture) => [
        capture.coordinate_id,
        {
          coordinate_id: capture.coordinate_id,
          classification: capture.coordinate_id === origin ? "bad" : "unreviewed",
          ...(capture.coordinate_id === origin
            ? {
                requested_change: {
                  request_id: "internal-request-id",
                  requested_change: requestedChange,
                  authorship: "visual-reviewer",
                  origin_coordinate_id: origin,
                  affected_coordinate_ids: [
                    origin,
                    "page-home--state-alternate--390x844",
                  ],
                  selected_issue_ids: selectedIssueIds,
                  created_at: "2026-08-23T12:00:00.000Z",
                  updated_at: "2026-08-23T12:00:00.000Z",
                },
              }
            : {}),
        },
      ]),
    ),
  };
}

describe("createHumanHandoffContent", () => {
  it("formats deterministic human-only plain text with useful screenshot and issue context", () => {
    const state = reviewState([
      "VQ-ISSUE-HOME-LOW-CONTRAST-CTA",
      "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED",
    ]);
    const first = createHumanHandoffContent({ manifest, reviewState: state });
    const second = createHumanHandoffContent({ manifest, reviewState: state });
    expect(second).toBe(first);
    expect(first).toContain("REVIEWER-APPROVED WORK");
    expect(first).toContain("Requested outcome\nGive the total enough room and make the primary action readable.");
    expect(first).toContain("Affected pages and sizes");
    expect(first).toContain("Approved concerns");
    expect(first).toContain("Checkout total is clipped\nObserved: The order total does not fit in its available space.");
    expect(first).toContain("Acceptance criterion:");
    expect(first).toContain("MACHINE SUGGESTIONS — NOT APPROVED WORK");
    expect(first.match(/Source: https:\/\/northstar\.example\/checkout/gu)).toHaveLength(1);
    expect(first).not.toMatch(
      /VQ-|audit|hash|policy|reason code|selector|schema|format|version|internal-request-id/iu,
    );
  });

  it("plainly states when no detected issues were attached", () => {
    const content = createHumanHandoffContent({ manifest, reviewState: reviewState([]) });
    expect(content).toContain("No machine suggestion was promoted");
    expect(content).not.toContain("VQ-ISSUE");
  });

  it("rejects issue-only work until a reviewer confirms a useful outcome", () => {
    expect(() => createHumanHandoffContent({
      manifest,
      reviewState: reviewState(["VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED"], ""),
    })).toThrow(/reviewer-authored outcome/u);
  });

  it("fails closed when both reviewer text and attached issues are empty", () => {
    expect(() => createHumanHandoffContent({ manifest, reviewState: reviewState([], "") })).toThrow(
      /reviewer-authored outcome/u,
    );
  });

  it("keeps technical locators out of the Human handoff", () => {
    const candidate = structuredClone(manifest);
    const issue = candidate.issues.find((entry) => entry.id === "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED")!;
    issue.title = "main > footer:nth-child(4)";
    issue.description = issue.title;
    issue.selector = issue.title;
    issue.technical_locator = issue.title;
    issue.semantic_name = "footer navigation";
    issue.observed_outcome = "Footer navigation content extends beyond its intended boundary.";
    issue.acceptance_criterion = issue.title;
    const content = createHumanHandoffContent({
      manifest: candidate,
      reviewState: reviewState([issue.id], "Keep the footer navigation fully contained."),
    });
    expect(content).toContain("footer navigation: visual concern");
    expect(content).toContain("The approved outcome is visibly satisfied at every affected size.");
    expect(content).not.toContain("nth-child");
    expect(content).not.toContain("main > footer");
  });
});

describe("issue highlight projection", () => {
  const issueId = "VQ-ISSUE-CHECKOUT-TOTAL-CLIPPED";
  const coordinateId = "page-checkout--state-alternate--390x844";
  const contentFor = (state: ReviewState, targetManifest = manifest) => {
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
    }).bundle.requests[0]!.affected_coordinates
      .find((coordinate) => coordinate.coordinate_id === coordinateId)!.issues
      .find((issue) => issue.id === issueId)!;
  };

  it("projects padded, adjusted, and removed highlights without mutating detector geometry", () => {
    const original = structuredClone(manifest.issues.find((issue) => issue.id === issueId)!.rects![coordinateId]!);
    const state = reviewState([issueId]);
    expect(contentFor(state).highlight_rect).toEqual({ x: 20, y: 532, width: 350, height: 70 });
    state.captures[coordinateId]!.issue_highlights = {
      [issueId]: { x: 24, y: 528, width: 340, height: 80 },
    };
    expect(contentFor(state).highlight_rect).toEqual({ x: 24, y: 528, width: 340, height: 80 });
    state.captures[coordinateId]!.issue_highlights = { [issueId]: null };
    expect(contentFor(state)).toMatchObject({ highlight_removed: true });
    expect(contentFor(state).highlight_rect).toBeUndefined();
    expect(manifest.issues.find((issue) => issue.id === issueId)!.rects![coordinateId]).toEqual(original);
  });

  it("rejects invalid persisted highlight geometry", () => {
    const state = reviewState([issueId]);
    state.captures[coordinateId]!.issue_highlights = {
      [issueId]: { x: 380, y: 530, width: 40, height: 40 },
    };
    expect(() => contentFor(state)).toThrow(/invalid issue highlight/u);
  });

  it("clips default visual padding to screenshot bounds", () => {
    const candidate = structuredClone(manifest);
    candidate.issues.find((issue) => issue.id === issueId)!.rects![coordinateId] = {
      x: 2,
      y: 3,
      width: 20,
      height: 20,
    };
    expect(contentFor(reviewState([issueId]), candidate).highlight_rect).toEqual({
      x: 0,
      y: 0,
      width: 30,
      height: 31,
    });
  });

  it("rejects an issue-only AI request at the same approval boundary", () => {
    const state = reviewState([issueId], "");
    const digest = reviewStateSha256(manifest, state.manifest_sha256, state);
    expect(() => createPortableBundleContent({
      manifest,
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
    })).toThrow(/reviewer-authored outcome/u);
  });
});
