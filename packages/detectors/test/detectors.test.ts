import { describe, expect, it } from "vitest";
import type { ElementMetric, PageMetrics, Snapshot } from "@vqa/contract";
import {
  detectClippedText,
  detectColor,
  detectContrast,
  detectCrampedSpacing,
  detectElementOverflow,
  detectExcessiveGap,
  detectFontRendering,
  detectOffscreenInteractive,
  detectOverlap,
  detectPageOverflow,
  detectWrapping,
  runDetectors,
} from "../src/index.js";

const basePage: PageMetrics = {
  scrollWidth: 390,
  scrollHeight: 2000,
  viewportWidth: 390,
  viewportHeight: 844,
};

let counter = 0;

function el(overrides: Partial<ElementMetric>): ElementMetric {
  counter += 1;
  const element: ElementMetric = {
    index: overrides.index ?? counter,
    parent: -1,
    tag: "div",
    selector: overrides.selector ?? `div:nth-child(${counter})`,
    semanticName: "synthetic content",
    elementFingerprint: overrides.selector ?? `synthetic:${counter}`,
    rect: { x: 0, y: 0, width: 100, height: 20 },
    visibleRect: overrides.rect ?? { x: 0, y: 0, width: 100, height: 20 },
    clipRect: null,
    clientWidth: 100,
    clientHeight: 20,
    scrollWidth: 100,
    scrollHeight: 20,
    position: "static",
    transformed: false,
    display: "block",
    overflowX: "visible",
    overflowY: "visible",
    visible: true,
    interactive: false,
    inPageLink: false,
    inFixedLayer: false,
    srOnly: false,
    hasScrollableAncestor: false,
    stretchedTarget: -1,
    hasDirectText: true,
    textRects: [{ x: 0, y: 0, width: 100, height: 20 }],
    hasVisibleBorder: false,
    hasVisibleBackground: false,
    textExpectedVisible: true,
    wordCount: 5,
    longestWordWidth: 40,
    fontSizePx: 16,
    fontWeight: 400,
    lineHeightPx: 24,
    fontFamily: "sans-serif",
    requestedFontFamily: "sans-serif",
    fontFaceStatus: "untracked",
    textColor: { red: 0, green: 0, blue: 0, alpha: 1 },
    renderedTextColor: { red: 0, green: 0, blue: 0, alpha: 1 },
    effectiveBackgroundColor: {
      red: 255,
      green: 255,
      blue: 255,
      alpha: 1,
    },
    hasBackgroundImage: false,
    wordBreakRisky: false,
    ...overrides,
  };
  if (overrides.textColor && !overrides.renderedTextColor) {
    element.renderedTextColor = overrides.textColor;
  }
  return element;
}

function snap(
  elements: ElementMetric[],
  page: Partial<PageMetrics> = {},
): Snapshot {
  return { page: { ...basePage, ...page }, elements };
}

describe("detectPageOverflow", () => {
  it("flags a document wider than the viewport and names the culprit", () => {
    const culprit = el({
      selector: "div#wide",
      rect: { x: 0, y: 100, width: 3000, height: 40 },
    });
    const issues = detectPageOverflow(snap([culprit], { scrollWidth: 3000 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("page-overflow");
    expect(issues[0]!.severity).toBe("high");
    expect(issues[0]!.selector).toBe("div#wide");
  });

  it("stays silent when the page fits", () => {
    expect(detectPageOverflow(snap([el({})]))).toHaveLength(0);
  });
});

describe("detectElementOverflow", () => {
  it("flags visible painted content outside a non-scrollable container", () => {
    const box = el({ index: 0, selector: "div#box", clientWidth: 200, scrollWidth: 320, hasDirectText: false, textRects: [], rect: { x: 0, y: 0, width: 200, height: 40 } });
    const spill = el({ index: 1, parent: 0, selector: "p#spill", rect: { x: 0, y: 0, width: 320, height: 24 } });
    const issues = detectElementOverflow(
      snap([box, spill]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("element-overflow");
  });

  it("skips intentionally scrollable containers", () => {
    const issues = detectElementOverflow(
      snap([el({ clientWidth: 200, scrollWidth: 320, overflowX: "auto" })]),
    );
    expect(issues).toHaveLength(0);
  });

  it("suppresses a 5px delta and scroll metrics without painted spill", () => {
    const five = el({ index: 0, clientWidth: 200, scrollWidth: 205, rect: { x: 0, y: 0, width: 200, height: 40 } });
    const nested = el({ index: 1, clientWidth: 200, scrollWidth: 280, hasDirectText: false, textRects: [], rect: { x: 0, y: 50, width: 200, height: 40 } });
    expect(detectElementOverflow(snap([five, nested]))).toHaveLength(0);
  });
});

describe("detectOverlap", () => {
  it("flags two colliding text boxes", () => {
    const a = el({
      index: 0,
      selector: "div#a",
      rect: { x: 10, y: 30, width: 160, height: 60 },
    });
    const b = el({
      index: 1,
      selector: "div#b",
      rect: { x: 90, y: 50, width: 160, height: 60 },
    });
    const issues = detectOverlap(snap([a, b]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("overlap");
    expect(issues[0]!.otherSelector).toBe("div#b");
    // Partial content-on-content collision stays high severity.
    expect(issues[0]!.severity).toBe("high");
    expect(issues[0]!.confidence).toBe("high");
  });

  it("downgrades full containment (overlay/badge pattern) to medium", () => {
    const big = el({
      index: 0,
      selector: "div#big",
      rect: { x: 0, y: 0, width: 300, height: 200 },
    });
    const badge = el({
      index: 1,
      selector: "span#badge",
      rect: { x: 10, y: 10, width: 60, height: 24 },
    });
    const issues = detectOverlap(snap([big, badge]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("medium");
    expect(issues[0]!.confidence).toBe("needs-confirmation");
  });

  it("keeps positioned collage layering as a suggestion needing confirmation", () => {
    const a = el({ index: 0, position: "absolute", transformed: true, rect: { x: 0, y: 0, width: 180, height: 80 } });
    const b = el({ index: 1, rect: { x: 60, y: 30, width: 180, height: 80 } });
    expect(detectOverlap(snap([a, b]))[0]!.confidence).toBe("needs-confirmation");
  });

  it("keeps a visibly obstructed control high confidence despite positioning", () => {
    const control = el({ index: 0, tag: "button", interactive: true, position: "absolute", rect: { x: 0, y: 0, width: 180, height: 80 } });
    const obstruction = el({ index: 1, position: "absolute", rect: { x: 20, y: 20, width: 180, height: 80 } });
    expect(detectOverlap(snap([control, obstruction]))[0]!.confidence).toBe("high");
  });

  it("suppresses stretched-link overlaps with the covered card's content", () => {
    const card = el({
      index: 0,
      selector: "div#card",
      position: "relative",
      hasDirectText: false,
      rect: { x: 0, y: 0, width: 300, height: 120 },
    });
    const title = el({
      index: 1,
      parent: 0,
      selector: "h3#title",
      rect: { x: 16, y: 16, width: 268, height: 24 },
    });
    const link = el({
      index: 2,
      parent: 0,
      selector: "a#stretch",
      tag: "a",
      interactive: true,
      hasDirectText: false,
      stretchedTarget: 0,
      rect: { x: 0, y: 0, width: 300, height: 120 },
    });
    expect(detectOverlap(snap([card, title, link]))).toHaveLength(0);
  });

  it("still flags a stretched link colliding with content outside its card", () => {
    const card = el({
      index: 0,
      selector: "div#card",
      position: "relative",
      hasDirectText: false,
      rect: { x: 0, y: 0, width: 300, height: 120 },
    });
    const link = el({
      index: 1,
      parent: 0,
      selector: "a#stretch",
      tag: "a",
      interactive: true,
      hasDirectText: false,
      stretchedTarget: 0,
      rect: { x: 0, y: 0, width: 300, height: 160 },
    });
    const outside = el({
      index: 2,
      selector: "p#outside",
      rect: { x: 0, y: 130, width: 300, height: 24 },
    });
    const issues = detectOverlap(snap([card, link, outside]));
    expect(issues.length).toBeGreaterThan(0);
    expect(
      issues.some(
        (issue) =>
          issue.selector === "a#stretch" || issue.otherSelector === "p#outside",
      ),
    ).toBe(true);
  });

  it("ignores ancestor-descendant pairs", () => {
    const parent = el({
      index: 0,
      selector: "div#p",
      rect: { x: 0, y: 0, width: 300, height: 100 },
    });
    const child = el({
      index: 1,
      parent: 0,
      selector: "a#c",
      rect: { x: 10, y: 10, width: 100, height: 40 },
    });
    expect(detectOverlap(snap([parent, child]))).toHaveLength(0);
  });

  it("ignores tiny intersections", () => {
    const a = el({ index: 0, rect: { x: 0, y: 0, width: 100, height: 20 } });
    const b = el({ index: 1, rect: { x: 98, y: 0, width: 100, height: 20 } });
    expect(detectOverlap(snap([a, b]))).toHaveLength(0);
  });
});

describe("detectWrapping", () => {
  it("flags one-word-per-line columns", () => {
    // 8 words rendered as 8 line boxes in a 44px column.
    const issues = detectWrapping(
      snap([
        el({
          selector: "div#col",
          wordCount: 8,
          rect: { x: 0, y: 0, width: 44, height: 192 },
          textRects: Array.from({ length: 8 }, (_, line) => ({ x: 0, y: line * 24, width: 40, height: 24 })),
        }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("wrapping");
    expect(issues[0]!.description).toContain("one word per line");
  });

  it("flags mid-word breaks when the longest word exceeds the box", () => {
    const issues = detectWrapping(
      snap([
        el({
          selector: "div#narrow",
          wordCount: 1,
          longestWordWidth: 260,
          clientWidth: 80,
          scrollWidth: 80,
          rect: { x: 0, y: 0, width: 80, height: 96 },
          wordBreakRisky: true,
        }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.description).toContain("mid-word");
  });

  it("accepts healthy paragraphs", () => {
    const issues = detectWrapping(
      snap([
        el({
          wordCount: 40,
          rect: { x: 0, y: 0, width: 600, height: 96 },
          longestWordWidth: 80,
          clientWidth: 600,
        }),
      ]),
    );
    expect(issues).toHaveLength(0);
  });
});

describe("detectCrampedSpacing", () => {
  it("flags stacked text siblings whose glyphs touch", () => {
    // line-height equals font size, so a zero-margin stack has no leading.
    const parent = el({ index: 0, hasDirectText: false, selector: "div#wrap" });
    const first = el({
      index: 1,
      parent: 0,
      selector: "p#one",
      rect: { x: 0, y: 0, width: 300, height: 16 },
      lineHeightPx: 16,
    });
    const second = el({
      index: 2,
      parent: 0,
      selector: "p#two",
      rect: { x: 0, y: 16, width: 300, height: 16 },
      lineHeightPx: 16,
    });
    const issues = detectCrampedSpacing(snap([parent, first, second]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("cramped-spacing");
  });

  it("accepts a zero-margin stack whose line-height leaves air between lines", () => {
    // 16px text at line-height 24 keeps ~4px of leading on each side.
    const parent = el({ index: 0, hasDirectText: false, selector: "div#card" });
    const title = el({ index: 1, parent: 0, selector: "p#title", rect: { x: 0, y: 0, width: 300, height: 24 } });
    const subtitle = el({ index: 2, parent: 0, selector: "p#subtitle", rect: { x: 0, y: 24, width: 300, height: 24 } });
    expect(detectCrampedSpacing(snap([parent, title, subtitle]))).toHaveLength(0);
  });

  it("accepts siblings with normal spacing", () => {
    const parent = el({ index: 0, hasDirectText: false });
    const first = el({
      index: 1,
      parent: 0,
      rect: { x: 0, y: 0, width: 300, height: 24 },
    });
    const second = el({
      index: 2,
      parent: 0,
      rect: { x: 0, y: 40, width: 300, height: 24 },
    });
    expect(detectCrampedSpacing(snap([parent, first, second]))).toHaveLength(0);
  });

  it("suppresses bordered cells, painted cards, and segmented controls", () => {
    const parent = el({ index: 0, hasDirectText: false });
    const bordered = [
      el({ index: 1, parent: 0, hasVisibleBorder: true, rect: { x: 0, y: 0, width: 120, height: 40 } }),
      el({ index: 2, parent: 0, hasVisibleBorder: true, rect: { x: 120, y: 0, width: 120, height: 40 } }),
    ];
    const cards = [
      el({ index: 3, parent: 0, hasVisibleBackground: true, rect: { x: 0, y: 60, width: 120, height: 40 } }),
      el({ index: 4, parent: 0, hasVisibleBackground: true, rect: { x: 120, y: 60, width: 120, height: 40 } }),
    ];
    const segments = [
      el({ index: 5, parent: 0, interactive: true, rect: { x: 0, y: 120, width: 120, height: 40 } }),
      el({ index: 6, parent: 0, interactive: true, rect: { x: 120, y: 120, width: 120, height: 40 } }),
    ];
    expect(detectCrampedSpacing(snap([parent, ...bordered, ...cards, ...segments]))).toHaveLength(0);
  });
});

describe("detectExcessiveGap", () => {
  it("flags a gap far above the sibling rhythm", () => {
    const parent = el({ index: 0, hasDirectText: false });
    const children = [0, 1, 2, 3].map((i) =>
      el({
        index: i + 1,
        parent: 0,
        selector: `p#g${i}`,
        rect: { x: 0, y: [0, 40, 80, 520][i]!, width: 300, height: 24 },
      }),
    );
    const issues = detectExcessiveGap(snap([parent, ...children]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("excessive-gap");
    expect(issues[0]!.selector).toBe("p#g2");
  });

  it("accepts uniform rhythm", () => {
    const parent = el({ index: 0, hasDirectText: false });
    const children = [0, 1, 2, 3].map((i) =>
      el({
        index: i + 1,
        parent: 0,
        rect: { x: 0, y: i * 40, width: 300, height: 24 },
      }),
    );
    expect(detectExcessiveGap(snap([parent, ...children]))).toHaveLength(0);
  });
});

describe("detectClippedText", () => {
  it("flags hidden-overflow containers with cut-off text", () => {
    const issues = detectClippedText(
      snap([
        el({
          selector: "div#clip",
          overflowY: "hidden",
          clientHeight: 28,
          scrollHeight: 120,
          textRects: [{ x: 0, y: 0, width: 100, height: 90 }],
        }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("clipped-text");
    expect(issues[0]!.severity).toBe("high");
  });

  it("flags clipping when the text lives in a descendant", () => {
    const clip = el({
      index: 0,
      selector: "div#clip",
      overflowY: "hidden",
      clientHeight: 28,
      scrollHeight: 120,
      hasDirectText: false,
    });
    const inner = el({ index: 1, parent: 0, selector: "p#inner", textRects: [{ x: 0, y: 0, width: 100, height: 90 }] });
    expect(detectClippedText(snap([clip, inner]))).toHaveLength(1);
  });

  it("ignores scroll-height inflation from a positioned collage when text stays inside", () => {
    const clip = el({ index: 0, overflowY: "hidden", clientHeight: 60, scrollHeight: 140, hasDirectText: false, textRects: [], rect: { x: 0, y: 0, width: 200, height: 60 } });
    const collage = el({ index: 1, parent: 0, position: "absolute", transformed: true, textRects: [{ x: 10, y: 10, width: 120, height: 20 }], rect: { x: 0, y: 0, width: 200, height: 140 } });
    expect(detectClippedText(snap([clip, collage]))).toHaveLength(0);
  });

  it("accepts fitting content and textless containers", () => {
    expect(
      detectClippedText(
        snap([
          el({ overflowY: "hidden", clientHeight: 120, scrollHeight: 120 }),
        ]),
      ),
    ).toHaveLength(0);
    expect(
      detectClippedText(
        snap([
          el({
            overflowY: "hidden",
            clientHeight: 28,
            scrollHeight: 120,
            hasDirectText: false,
          }),
        ]),
      ),
    ).toHaveLength(0);
  });
});

describe("detectOffscreenInteractive", () => {
  it("flags a fixed button parked outside the viewport", () => {
    const issues = detectOffscreenInteractive(
      snap([
        el({
          tag: "button",
          selector: "button#gone",
          interactive: true,
          position: "fixed",
          rect: { x: -300, y: 10, width: 120, height: 40 },
        }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("offscreen-interactive");
  });

  it("accepts reachable interactive elements", () => {
    const issues = detectOffscreenInteractive(
      snap([
        el({
          tag: "a",
          interactive: true,
          rect: { x: 10, y: 900, width: 120, height: 40 },
        }),
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("accepts below-the-fold elements inside a scrollable container (app-shell)", () => {
    // Document does not scroll (scrollHeight == viewport) but the element
    // lives in an inner scroller: reachable, not an issue.
    const issues = detectOffscreenInteractive(
      snap(
        [
          el({
            tag: "button",
            interactive: true,
            hasScrollableAncestor: true,
            rect: { x: 33, y: 1500, width: 120, height: 40 },
          }),
        ],
        { scrollHeight: 844 },
      ),
    );
    expect(issues).toHaveLength(0);
  });

  it("still flags elements beyond the document scroll area with no scrollable ancestor", () => {
    const issues = detectOffscreenInteractive(
      snap(
        [
          el({
            tag: "button",
            selector: "button#lost",
            interactive: true,
            rect: { x: 33, y: 1500, width: 120, height: 40 },
          }),
        ],
        { scrollHeight: 844 },
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.selector).toBe("button#lost");
  });
});

describe("detectContrast", () => {
  it("flags normal text below the WCAG AA 4.5:1 threshold", () => {
    const issues = detectContrast(
      snap([
        el({
          selector: "p#low-contrast",
          textColor: { red: 136, green: 136, blue: 136, alpha: 1 },
        }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("contrast");
    expect(issues[0]!.description).toContain("3.54:1");
    expect(issues[0]!.description).toContain("requires 4.5:1");
  });

  it("accepts AA text and applies the 3:1 large-text threshold", () => {
    expect(
      detectContrast(
        snap([
          el({
            selector: "p#healthy",
            textColor: { red: 80, green: 80, blue: 80, alpha: 1 },
          }),
          el({
            selector: "h1#large",
            fontSizePx: 24,
            textColor: { red: 136, green: 136, blue: 136, alpha: 1 },
          }),
        ]),
      ),
    ).toHaveLength(0);
  });

  it("skips text over image backgrounds whose effective color is unknown", () => {
    expect(
      detectContrast(
        snap([
          el({
            textColor: { red: 255, green: 255, blue: 255, alpha: 1 },
            hasBackgroundImage: true,
          }),
        ]),
      ),
    ).toHaveLength(0);
  });
});

describe("detectFontRendering", () => {
  it("flags a failed requested font face with computed-family evidence", () => {
    const issues = detectFontRendering(
      snap([
        el({
          selector: "p#fallback",
          fontFamily: '"Fixture Missing", sans-serif',
          requestedFontFamily: "Fixture Missing",
          fontFaceStatus: "missing",
        }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("font-rendering");
    expect(issues[0]!.severity).toBe("medium");
    expect(issues[0]!.description).toContain("Fixture Missing");
    expect(issues[0]!.description).toContain("fallback");
  });

  it("flags zero-dimension and overflowing rendered text", () => {
    const issues = detectFontRendering(
      snap([
        el({
          selector: "p#zero",
          visible: false,
          rect: { x: 0, y: 0, width: 0, height: 0 },
        }),
        el({
          selector: "p#overflow",
          clientWidth: 100,
          scrollWidth: 240,
        }),
      ]),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]!.description).toContain("zero-dimension");
    expect(issues[1]!.description).toContain("overflows");
  });

  it("accepts loaded, normally sized text that fits its box", () => {
    expect(
      detectFontRendering(
        snap([
          el({
            fontFamily: '"Fixture Loaded", sans-serif',
            requestedFontFamily: "Fixture Loaded",
            fontFaceStatus: "loaded",
          }),
        ]),
      ),
    ).toHaveLength(0);
  });
});

describe("detectColor", () => {
  it("flags foreground and background colors that are nearly identical", () => {
    const issues = detectColor(
      snap([
        el({
          selector: "p#invisible",
          textColor: { red: 249, green: 249, blue: 249, alpha: 1 },
        }),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("color");
    expect(issues[0]!.description).toContain("largest RGB channel difference");
  });

  it("accepts visibly distinct colors", () => {
    expect(
      detectColor(
        snap([
          el({
            textColor: { red: 80, green: 80, blue: 80, alpha: 1 },
          }),
        ]),
      ),
    ).toHaveLength(0);
  });
});

describe("sr-only exclusions", () => {
  const srSpan = () =>
    el({
      selector: "span#sr",
      tag: "span",
      srOnly: true,
      rect: { x: 0, y: 100, width: 1, height: 1 },
      clientWidth: 1,
      clientHeight: 1,
      scrollWidth: 180,
      scrollHeight: 22,
      overflowX: "hidden",
      overflowY: "hidden",
    });

  it("does not report clipped-text for sr-only clamped elements", () => {
    expect(detectClippedText(snap([srSpan()]))).toHaveLength(0);
  });

  it("does not report element-overflow for sr-only clamped elements", () => {
    expect(detectElementOverflow(snap([srSpan()]))).toHaveLength(0);
  });

  it("still reports genuine clipping on non-sr-only elements", () => {
    const clipped = el({
      selector: "div#clip",
      overflowY: "hidden",
      clientHeight: 28,
      scrollHeight: 120,
      textRects: [{ x: 0, y: 0, width: 100, height: 90 }],
    });
    expect(detectClippedText(snap([clipped]))).toHaveLength(1);
  });
});

describe("runDetectors", () => {
  it("aggregates all detectors", () => {
    const wide = el({
      selector: "div#wide",
      rect: { x: 0, y: 0, width: 3000, height: 40 },
    });
    const issues = runDetectors(snap([wide], { scrollWidth: 3000 }));
    expect(issues.some((issue) => issue.type === "page-overflow")).toBe(true);
  });
});

describe("layered-for-effect compositions", () => {
  it("does not report text or a link laid over a photo as an overlap", () => {
    const photo = el({ index: 0, tag: "img", hasDirectText: false, textRects: [], rect: { x: 0, y: 0, width: 800, height: 500 } });
    const caption = el({ index: 1, selector: "p#hero", rect: { x: 40, y: 380, width: 400, height: 60 } });
    const link = el({ index: 2, selector: "a#cta", interactive: true, rect: { x: 40, y: 440, width: 160, height: 40 } });
    expect(detectOverlap(snap([photo, caption, link]))).toHaveLength(0);
    // A photo that only partly covers a paragraph is still a collision.
    const straddling = el({ index: 3, selector: "p#straddle", rect: { x: 700, y: 380, width: 300, height: 60 } });
    expect(detectOverlap(snap([photo, straddling])).map((issue) => issue.type)).toEqual(["overlap"]);
  });

  it("skips contrast and colour checks for text sitting on an image", () => {
    const photo = el({ index: 0, tag: "img", hasDirectText: false, textRects: [], rect: { x: 0, y: 0, width: 800, height: 500 } });
    const white = el({
      index: 1, selector: "h1#hero", rect: { x: 40, y: 200, width: 400, height: 60 },
      renderedTextColor: { red: 255, green: 255, blue: 255, alpha: 1 },
      effectiveBackgroundColor: { red: 250, green: 250, blue: 250, alpha: 1 },
    });
    expect(detectContrast(snap([photo, white]))).toHaveLength(0);
    expect(detectColor(snap([photo, white]))).toHaveLength(0);
    const alone = el({
      index: 1, selector: "h1#alone", rect: { x: 40, y: 900, width: 400, height: 60 },
      renderedTextColor: { red: 255, green: 255, blue: 255, alpha: 1 },
      effectiveBackgroundColor: { red: 250, green: 250, blue: 250, alpha: 1 },
    });
    expect(detectContrast(snap([photo, alone]))).toHaveLength(1);
  });

  it("treats overflow:hidden on the document as a scroll lock, not cut-off text", () => {
    const html = el({ index: 0, tag: "html", hasDirectText: false, textRects: [], overflowY: "hidden", clientHeight: 800, scrollHeight: 4500, rect: { x: 0, y: 0, width: 1280, height: 800 } });
    const text = el({ index: 1, parent: 0, selector: "p#below", rect: { x: 0, y: 1200, width: 400, height: 24 }, textRects: [{ x: 0, y: 1200, width: 400, height: 24 }] });
    expect(detectClippedText(snap([html, text]))).toHaveLength(0);
    const card = el({ ...html, index: 0, tag: "div", selector: "div#card", clientHeight: 28, scrollHeight: 120, rect: { x: 0, y: 0, width: 400, height: 28 } });
    const cardText = el({ ...text, index: 1, parent: 0, selector: "p#in-card", rect: { x: 0, y: 0, width: 400, height: 120 }, textRects: [{ x: 0, y: 0, width: 400, height: 120 }] });
    expect(detectClippedText(snap([card, cardText])).map((issue) => issue.type)).toEqual(["clipped-text"]);
  });

  it("ignores a control parked thousands of pixels off-canvas", () => {
    const parked = el({ index: 0, tag: "button", selector: "button#hidden", interactive: true, rect: { x: -9999, y: 300, width: 100, height: 40 } });
    const nudged = el({ index: 1, tag: "button", selector: "button#lost", interactive: true, rect: { x: -300, y: 300, width: 100, height: 40 } });
    const issues = detectOffscreenInteractive(snap([parked, nudged]));
    expect(issues.map((issue) => issue.selector)).toEqual(["button#lost"]);
  });
});
