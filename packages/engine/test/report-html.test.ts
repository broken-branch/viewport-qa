import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import type { Report, ReviewManifest } from "@vqa/contract";
import { renderReportHtml } from "../src/index.js";

const report: Report = {
  formatVersion: "2",
  tool: "viewport-qa",
  toolVersion: "0.1.0",
  url: "http://example.test/<script>",
  createdAt: "2026-07-23T00:00:00.000Z",
  adapter: { impl: "stub", wired: false },
  viewports: [
    {
      viewport: {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        label: "390x844@1",
      },
      page: {
        scrollWidth: 390,
        scrollHeight: 2000,
        viewportWidth: 390,
        viewportHeight: 844,
      },
      screenshot: "screenshots/390x844@1/full.png",
      issueCount: 1,
      rawIssueCount: 3,
    },
  ],
  issues: [
    {
      id: "overlap-390x844@1-01",
      instanceCount: 3,
      type: "overlap",
      severity: "high",
      selector: "div#a</script>",
      description: "boxes collide",
      rect: { x: 0, y: 0, width: 100, height: 50 },
      viewport: "390x844@1",
      screenshots: {
        viewport: "screenshots/390x844@1/full.png",
        crop: "screenshots/390x844@1/overlap-01.png",
      },
      heuristicSuggestion: { kind: "heuristic", text: "give them room" },
      aiRecommendation: {
        status: "unavailable",
        reason: "no model adapter wired (impl: stub)",
      },
    },
  ],
  comparison: {
    baseline: {
      url: "http://example.test",
      createdAt: "2026-07-22T00:00:00.000Z",
      markedAt: "2026-07-22T00:01:00.000Z",
    },
    changedTargetCount: 1,
    results: [
      {
        target: "390x844@1",
        status: "changed",
        score: 0.125,
        changedPixels: 10,
        totalPixels: 80,
        changedRegions: [
          { x: 0, y: 0, width: 10, height: 1, changedPixels: 10 },
        ],
      },
    ],
  },
};

const reviewManifest = JSON.parse(
  readFileSync(
    new URL("fixtures/review-journey/review-manifest.json", import.meta.url),
    "utf8",
  ),
) as ReviewManifest;

describe("renderReportHtml", () => {
  it("embeds the report data without allowing script breakout", () => {
    const html = renderReportHtml(report);
    expect(html).toContain('<script id="vqa-data" type="application/json">');
    // The literal </script> inside issue data must be escaped.
    expect(html).toContain("\\u003c/script>");
    const embedded =
      /<script id="vqa-data" type="application\/json">(.*?)<\/script>/s.exec(
        html,
      );
    expect(embedded).toBeTruthy();
    const parsed = JSON.parse(embedded![1]!) as Report;
    expect(parsed.issues[0]!.id).toBe("overlap-390x844@1-01");
  });

  it("states plainly when the AI adapter is not wired", () => {
    const html = renderReportHtml(report);
    expect(html).toContain(
      "AI adapter: not wired (recommendations unavailable)",
    );
  });

  it("lists changed visual comparison targets and scores", () => {
    const html = renderReportHtml(report);
    expect(html).toContain("Visual comparison");
    expect(html).toContain("result.target + \": \"");
    expect(html).toContain("(result.score * 100).toFixed(2) + \"%\"");
  });

  it("renders the manifest-backed task-first screenshot review workbench", () => {
    const html = renderReportHtml(report, reviewManifest);
    expect(html).toContain("<title>Review screenshots</title>");
    expect(html).toContain("Filter screenshots");
    expect(html).toContain('type:"checkbox"');
    expect(html).toContain("Looks good");
    expect(html).toContain('text:prominentIssueIds.length?"Ignore Concern":"Looks Good"');
    expect(html).toContain('text:prominentIssueIds.length?"View Concern":"Review Suggestions"');
    expect(html).toContain('text:"Open Image"');
    expect(html).toContain("Request Changes");
    expect(html).toContain("Change requested");
    expect(html).toContain("Not reviewed");
    expect(html).toContain("What useful outcome should change?");
    expect(html).toContain("Applies to");
    expect(html).toContain("Who will use this handoff?");
    expect(html).toContain("How should it be delivered?");
    expect(html).toContain("Copy and paste");
    expect(html).toContain("File format");
    expect(html).toContain("Machine suggestions to promote");
    expect(html).toContain("Reviewer-approved work");
    expect(html).toContain('id="homeButton">Home</button>');
    expect(html).toContain('id="newReviewButton">New Review</button>');
    expect(html).toContain('aria-label="Review navigation"');
    expect(html).toContain('id="drawerHomeButton" aria-label="Return Home">Home</button>');
    expect(html).toContain('id="drawerNewReviewButton" aria-label="Start New Review">New Review</button>');
    expect(html).toContain("unsaved change-request draft is preserved in this local session");
    expect(html).toContain("sessionStorage.setItem(reviewDraftKey");
    expect(html).toContain("Attaching a suggestion alone does not approve it.");
    expect(html).toContain('text:"Occurrences ("+issue.occurrences.length+")"');
    expect(html).toContain("containsTechnicalLocator");
    expect(html).not.toContain("Issues to include");
    expect(html).toContain("Default handoff path");
    expect(html).toContain('wrap:"soft"');
    expect(html).toContain("white-space:pre-wrap");
    expect(html).not.toContain("vq-export-identity-v1");
    expect(html).toContain('id="zoomLabel">100%</span>');
    expect(html).toContain('id="lightbox"');
    expect(html).toContain("Open Original");
    expect(html).toContain('id="storageError"');
    expect(html).toContain("Retry Connection");
    expect(html).not.toContain(
      "Check each page at the captured sizes. Mark what looks right and describe what needs to change.",
    );
    expect(html).not.toContain('class="run-alert"');
    expect(html).not.toContain("application developer");
    expect(html).not.toContain("designer");
    const executableScripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/gu)];
    expect(executableScripts).toHaveLength(1);
    expect(() => new Script(executableScripts[0]![1])).not.toThrow();
  });

  it("embeds every frozen capture once and keeps Settings action-focused", () => {
    const html = renderReportHtml(report, reviewManifest);
    const embedded = /<script id="vqa-manifest" type="application\/json">(.*?)<\/script>/s.exec(
      html,
    );
    const parsed = JSON.parse(embedded![1]!) as ReviewManifest;
    expect(new Set(parsed.captures.map((capture) => capture.coordinate_id))).toHaveLength(8);
    expect(parsed.pages.map((page) => page.label)).toEqual(["Home", "Checkout"]);
    expect(html).toContain("Settings");
    expect(html).toContain("Review run");
    expect(html).toContain("Files and storage");
    expect(html).toContain("Technical details");
    expect(html).toContain("Source commit");
    expect(html).toContain("Exact capture time");
    expect(html).toContain("Local-only review");
    expect(html).not.toContain("Manifest ID");
    expect(html).not.toContain("Audit result");
    expect(html).not.toContain("Policy ID");
    expect(html).not.toContain("Reason codes");
    expect(html).not.toContain("raw hit(s)");
    expect(html).not.toContain("decisions.json");
  });
});
