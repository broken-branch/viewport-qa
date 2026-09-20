import { describe, expect, it } from "vitest";
import type { DetectedIssue, Issue, ViewportResult } from "@vqa/contract";
import {
  dedupeIssues,
  groupIssuesAcrossViewports,
  selectorPattern,
} from "../src/dedupe.js";

function issue(overrides: Partial<DetectedIssue>): DetectedIssue {
  return {
    type: "overlap",
    severity: "high",
    selector: "div#a",
    description: "x",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    heuristicSuggestion: { kind: "heuristic", text: "fix it" },
    ...overrides,
  };
}

describe("selectorPattern", () => {
  it("strips nth-child indices so repeated component instances share a key", () => {
    expect(
      selectorPattern("div#cards > div:nth-child(3) > a:nth-child(1)"),
    ).toBe("div#cards > div > a");
  });

  it("leaves id selectors untouched", () => {
    expect(selectorPattern("main#app > p#intro")).toBe("main#app > p#intro");
  });
});

describe("dedupeIssues", () => {
  it("does not overmerge shallow nth-child paths", () => {
    const detected = [1, 2, 3].map((n) =>
      issue({
        selector: `div#cards > div:nth-child(${n}) > h3:nth-child(1)`,
        otherSelector: `div#cards > div:nth-child(${n}) > a:nth-child(2)`,
      }),
    );
    const { issues, rawCount } = dedupeIssues(detected);
    expect(rawCount).toBe(3);
    expect(issues).toHaveLength(3);
    expect(issues.every((entry) => entry.instanceCount === 1)).toBe(true);
  });

  it("collapses a stable semantic fingerprint and retains every occurrence", () => {
    const detected = [1, 2, 3].map((n) =>
      issue({
        selector: `div#shell > div:nth-child(${n})`,
        elementFingerprint: "role:status|name:account total|path:main#app",
        semanticName: "account total",
      }),
    );
    const { issues } = dedupeIssues(detected);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.instanceCount).toBe(3);
    expect(issues[0]!.occurrences.map((entry) => entry.technicalLocator)).toEqual(
      detected.map((entry) => entry.selector),
    );
  });

  it("keeps distinct types and patterns separate", () => {
    const { issues, rawCount } = dedupeIssues([
      issue({ selector: "div#a" }),
      issue({ selector: "div#b" }),
      issue({ type: "clipped-text", selector: "div#a" }),
    ]);
    expect(rawCount).toBe(3);
    expect(issues).toHaveLength(3);
    for (const entry of issues) expect(entry.instanceCount).toBe(1);
  });

  it("treats (a,b) and (b,a) pair orderings as the same finding", () => {
    const { issues } = dedupeIssues([
      issue({ selector: "div#a", otherSelector: "div#b" }),
      issue({ selector: "div#b", otherSelector: "div#a" }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.instanceCount).toBe(2);
  });

  it("keeps the maximum severity across collapsed instances", () => {
    const { issues } = dedupeIssues([
      issue({ severity: "medium", selector: "ul#l > li:nth-child(1)" }),
      issue({ severity: "high", selector: "ul#l > li:nth-child(2)", elementFingerprint: "fixture:item" }),
    ]);
    expect(issues).toHaveLength(2);
  });

  it("keeps maximum severity for the same stable fingerprint", () => {
    const { issues } = dedupeIssues([
      issue({ severity: "medium", selector: "ul#l > li:nth-child(1)", elementFingerprint: "fixture:item" }),
      issue({ severity: "high", selector: "ul#l > li:nth-child(2)", elementFingerprint: "fixture:item" }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("high");
  });
});

describe("groupIssuesAcrossViewports", () => {
  it("groups behaviour by identity when observations differ", () => {
    const viewports = ["small", "large"].map((label) => ({
      viewport: { width: label === "small" ? 390 : 1440, height: 800, deviceScaleFactor: 1, label },
      page: { scrollWidth: 1440, scrollHeight: 800, viewportWidth: 390, viewportHeight: 800 },
      screenshot: `${label}.png`, issueCount: 1, rawIssueCount: 1,
    })) satisfies ViewportResult[];
    const issues = ([404, 503] as const).map((status, index) => ({
      ...issue({
        type: "failed-request",
        selector: "https://example.test/api",
        elementFingerprint: "failed-request:https%3A%2F%2Fexample.test%2Fapi",
        description: `Request GET /api answered ${status}.`,
        behaviour: {
          kind: "failed-request", method: "GET", url: "https://example.test/api", status,
        },
      }),
      id: `request-${status}`, viewport: viewports[index]!.viewport.label,
      instanceCount: 1, screenshots: { viewport: `${index}.png` },
      aiRecommendation: { status: "unavailable", reason: "test" },
    })) satisfies Issue[];

    expect(groupIssuesAcrossViewports(issues, viewports, "https://example.test/"))
      .toHaveLength(1);
  });

  it("distinguishes clean and failing captures that share a CSS width", () => {
    const viewports = [
      {
        viewport: {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          label: "390x844@1",
        },
      },
      {
        viewport: {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          label: "390x844@3",
        },
      },
    ].map((entry) => ({
      ...entry,
      page: {
        scrollWidth: 390,
        scrollHeight: 844,
        viewportWidth: 390,
        viewportHeight: 844,
      },
      screenshot: `${entry.viewport.label}/full.png`,
      issueCount: 0,
      rawIssueCount: 0,
    })) satisfies ViewportResult[];
    const failing = {
      ...issue({
        type: "color",
        selector: "p#status",
        elementFingerprint: "id:status",
        description: "Status text matches its background.",
      }),
      id: "issue-failing",
      viewport: "390x844@1",
      instanceCount: 1,
      screenshots: { viewport: "390x844@1/full.png" },
      aiRecommendation: { status: "unavailable", reason: "test" },
    } satisfies Issue;

    expect(
      groupIssuesAcrossViewports(
        [failing],
        viewports,
        "https://example.test/",
      )[0]?.viewportRange,
    ).toBe("fails at 390x844@1, clean at 390x844@3");
  });

  it("does not call a viewport clean when the same concern has another message there", () => {
    const viewports = [390, 768, 1440].map((width) => ({
      viewport: {
        width,
        height: 800,
        deviceScaleFactor: 1,
        label: `${width}x800`,
      },
      page: {
        scrollWidth: 3000,
        scrollHeight: 800,
        viewportWidth: width,
        viewportHeight: 800,
      },
      screenshot: `${width}x800/full.png`,
      issueCount: 1,
      rawIssueCount: 1,
    })) satisfies ViewportResult[];
    const issues = viewports.map(({ viewport }, index) => ({
      ...issue({
        type: "page-overflow",
        selector: "div#seed-overflow",
        elementFingerprint: "id:seed-overflow",
        description: `Page is 3000px wide in a ${viewport.width}px viewport.`,
      }),
      id: `issue-${index}`,
      viewport: viewport.label,
      instanceCount: 1,
      screenshots: { viewport: `${viewport.label}/full.png` },
      aiRecommendation: { status: "unavailable" as const, reason: "test" },
    }));

    expect(
      groupIssuesAcrossViewports(
        issues,
        viewports,
        "https://example.test/",
      ).map((group) => group.viewportRange),
    ).toEqual(["fails at 390px", "fails at 768px", "fails at 1440px and above"]);
  });

  it("keeps ambiguous semantic identities capture-local", () => {
    const viewports = [390, 768].map((width) => ({
      viewport: {
        width,
        height: 800,
        deviceScaleFactor: 1,
        label: `${width}x800`,
      },
      page: {
        scrollWidth: width,
        scrollHeight: 800,
        viewportWidth: width,
        viewportHeight: 800,
      },
      screenshot: `${width}x800/full.png`,
      issueCount: 1,
      rawIssueCount: 1,
    })) satisfies ViewportResult[];
    const ambiguousFingerprint =
      "scope:main|role:text|kind:p|name:status|identity-ambiguous:main%23app%20%3E%20p%3Anth-child(2)";
    const issues = viewports.map(({ viewport }, index) => ({
      ...issue({
        type: "color",
        selector: "main#app > p:nth-child(2)",
        elementFingerprint: ambiguousFingerprint,
        description: "Status text matches its background.",
      }),
      id: `issue-${index}`,
      viewport: viewport.label,
      instanceCount: 1,
      screenshots: { viewport: `${viewport.label}/full.png` },
      aiRecommendation: { status: "unavailable" as const, reason: "test" },
    }));

    const groups = groupIssuesAcrossViewports(
      issues,
      viewports,
      "https://example.test/",
    );
    expect(groups.map((group) => group.issueIds)).toEqual([
      ["issue-0"],
      ["issue-1"],
    ]);
    expect(groups.map((group) => group.viewportRange)).toEqual([
      "fails at 390px",
      "fails at 768px and above",
    ]);
  });
});
