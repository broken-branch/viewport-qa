import type {
  DetectedIssue,
  ElementMetric,
  Rect,
  RgbaColor,
  Snapshot,
} from "@vqa/contract";

export type Detector = (snapshot: Snapshot) => DetectedIssue[];

const heuristic = (text: string) => ({ kind: "heuristic" as const, text });

function round(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function isAncestor(
  elements: ElementMetric[],
  maybeAncestor: number,
  index: number,
): boolean {
  let cursor = elements[index]?.parent ?? -1;
  while (cursor !== -1) {
    if (cursor === maybeAncestor) return true;
    cursor = elements[cursor]?.parent ?? -1;
  }
  return false;
}

function subtreeHasText(
  byParent: Map<number, ElementMetric[]>,
  element: ElementMetric,
): boolean {
  if (element.hasDirectText) return true;
  const children = byParent.get(element.index) ?? [];
  return children.some((child) => subtreeHasText(byParent, child));
}

function childrenByParent(
  elements: ElementMetric[],
): Map<number, ElementMetric[]> {
  const map = new Map<number, ElementMetric[]>();
  for (const element of elements) {
    const list = map.get(element.parent);
    if (list) list.push(element);
    else map.set(element.parent, [element]);
  }
  return map;
}

const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);

// ---------------------------------------------------------------------------
// page-overflow: the document is wider than the viewport (horizontal scroll)
// ---------------------------------------------------------------------------

export const detectPageOverflow: Detector = ({ page, elements }) => {
  if (page.scrollWidth <= page.viewportWidth + 1) return [];
  let culprit: ElementMetric | undefined;
  for (const element of elements) {
    if (!element.visible) continue;
    const right = element.rect.x + element.rect.width;
    if (right <= page.viewportWidth + 8) continue;
    if (!culprit || right > culprit.rect.x + culprit.rect.width)
      culprit = element;
  }
  const overflowPx = page.scrollWidth - page.viewportWidth;
  return [
    {
      type: "page-overflow",
      severity: "high",
      confidence: "high",
      confidenceReasons: ["Visible page content extends beyond the viewport and widens the document."],
      selector: culprit?.selector ?? "html",
      description:
        `Page scrolls horizontally: document is ${page.scrollWidth}px wide in a ${page.viewportWidth}px viewport ` +
        `(${overflowPx}px overflow)` +
        (culprit ? `; widest offender: ${culprit.selector}` : ""),
      rect: culprit
        ? round(culprit.rect)
        : {
            x: 0,
            y: 0,
            width: page.viewportWidth,
            height: page.viewportHeight,
          },
      heuristicSuggestion: heuristic(
        "Constrain the offending element (max-width: 100%, min-width: 0 on flex children, or overflow-x: hidden on a deliberate bleed) so the document fits the viewport width.",
      ),
    },
  ];
};

// ---------------------------------------------------------------------------
// element-overflow: content wider than its container (non-scrollable)
// ---------------------------------------------------------------------------

const OVERFLOW_PAINT_TOLERANCE = 5;

export const detectElementOverflow: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  for (const element of elements) {
    if (!element.visible || element.srOnly) continue;
    if (element.tag === "html" || element.tag === "body") continue; // covered by page-overflow
    if (element.clientWidth <= 0) continue;
    if (SCROLLABLE.has(element.overflowX)) continue; // intentionally scrollable
    if (element.scrollWidth <= element.clientWidth + OVERFLOW_PAINT_TOLERANCE) continue;
    const left = element.rect.x;
    const right = left + element.clientWidth;
    const descendants = elements.filter(
      (candidate) => candidate.visible && isAncestor(elements, element.index, candidate.index),
    );
    const paintedCulprit = descendants
      .filter((candidate) =>
        candidate.rect.x < left - OVERFLOW_PAINT_TOLERANCE ||
        candidate.rect.x + candidate.rect.width > right + OVERFLOW_PAINT_TOLERANCE,
      )
      .sort((a, b) =>
        (b.rect.x + b.rect.width - right) - (a.rect.x + a.rect.width - right),
      )[0];
    const directTextSpills = element.textRects.some(
      (rect) => rect.x < left - 1 || rect.x + rect.width > right + 1,
    );
    if (!paintedCulprit && !directTextSpills) continue;
    const source = paintedCulprit ?? element;
    issues.push({
      type: "element-overflow",
      severity: "medium",
      confidence: "high",
      confidenceReasons: ["Rendered content crosses the container boundary by more than the layout-noise tolerance."],
      selector: element.selector,
      semanticName: source.semanticName,
      elementFingerprint: `visible-spill:${source.elementFingerprint}`,
      description:
        `Content overflows its container horizontally: ${element.selector} has ` +
        `scrollWidth ${element.scrollWidth}px > clientWidth ${element.clientWidth}px ` +
        `(overflow-x: ${element.overflowX}).`,
      rect: round(element.rect),
      heuristicSuggestion: heuristic(
        "Let the content shrink (max-width: 100%; overflow-wrap: break-word; min-width: 0 for flex/grid children) or make the container scrollable on purpose (overflow-x: auto).",
      ),
    });
  }
  return issues;
};

// ---------------------------------------------------------------------------
// overlap: two content-bearing elements whose boxes intersect
// ---------------------------------------------------------------------------

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height
  );
}

const OVERLAP_MIN_DIM = 8;
const OVERLAP_MIN_AREA = 100;
const OVERLAP_CANDIDATE_CAP = 1500;
/** Intersection >= this share of the smaller box counts as containment. */
const OVERLAP_CONTAINMENT_RATIO = 0.9;

/**
 * True when `maybeStretched` is a stretched-link (whole-card hit target) and
 * `other` is the covered card itself or content inside it: an intentional
 * overlap, not a defect.
 */
function stretchedLinkCovers(
  elements: ElementMetric[],
  maybeStretched: ElementMetric,
  other: ElementMetric,
): boolean {
  if (maybeStretched.stretchedTarget < 0) return false;
  return (
    other.index === maybeStretched.stretchedTarget ||
    isAncestor(elements, maybeStretched.stretchedTarget, other.index)
  );
}

export const detectOverlap: Detector = ({ elements }) => {
  const candidates = elements
    .filter(
      (element) =>
        element.visible &&
        element.position !== "fixed" &&
        element.position !== "sticky" &&
        (element.hasDirectText || element.interactive || element.tag === "img"),
    )
    .slice(0, OVERLAP_CANDIDATE_CAP);
  const issues: DetectedIssue[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (
        isAncestor(elements, a.index, b.index) ||
        isAncestor(elements, b.index, a.index)
      )
        continue;
      if (
        stretchedLinkCovers(elements, a, b) ||
        stretchedLinkCovers(elements, b, a)
      )
        continue;
      // Cheap pass on raw boxes; a pair that does not even touch there is
      // done. Pairs that do are judged on what is actually painted: the boxes
      // clipped by ancestor overflow (image wrappers, carousels, scrollers).
      if (!rectsIntersect(a.rect, b.rect)) continue;
      const av = a.visibleRect;
      const bv = b.visibleRect;
      const left = Math.max(av.x, bv.x);
      const right = Math.min(av.x + av.width, bv.x + bv.width);
      const top = Math.max(av.y, bv.y);
      const bottom = Math.min(av.y + av.height, bv.y + bv.height);
      const width = right - left;
      const height = bottom - top;
      if (width < OVERLAP_MIN_DIM || height < OVERLAP_MIN_DIM) continue;
      if (width * height < OVERLAP_MIN_AREA) continue;
      // Severity calibration: one box sitting almost entirely inside/over the
      // other is usually an intentional overlay/badge -> medium; a partial
      // collision of two content boxes is the genuinely broken case -> high.
      const smallerArea = Math.min(av.width * av.height, bv.width * bv.height);
      const contained =
        smallerArea > 0 &&
        width * height >= smallerArea * OVERLAP_CONTAINMENT_RATIO;
      const positionedComposition =
        a.position === "absolute" ||
        b.position === "absolute" ||
        a.transformed ||
        b.transformed;
      const obstructsControl = a.interactive || b.interactive;
      const confidence = !obstructsControl && (positionedComposition || contained)
        ? "needs-confirmation" as const
        : "high" as const;
      issues.push({
        type: "overlap",
        severity: contained ? "medium" : "high",
        confidence,
        confidenceReasons: confidence === "high"
          ? ["Independent text or control regions visibly intersect without an intentional composition signal."]
          : ["Positioning, transforms, or near-containment can indicate intentional layering; confirm visually."],
        selector: a.selector,
        otherSelector: b.selector,
        description:
          `${a.selector} and ${b.selector} overlap by ${Math.round(width)}x${Math.round(height)}px; ` +
          (contained
            ? `one sits almost entirely over the other (possibly an intentional overlay -- verify visually).`
            : `neither is an ancestor of the other, so they likely collide unintentionally.`),
        rect: round({
          x: Math.min(av.x, bv.x),
          y: Math.min(av.y, bv.y),
          width: Math.max(av.x + av.width, bv.x + bv.width) - Math.min(av.x, bv.x),
          height: Math.max(av.y + av.height, bv.y + bv.height) - Math.min(av.y, bv.y),
        }),
        heuristicSuggestion: heuristic(
          "Check absolute/negative-margin positioning and fixed sizes at this viewport; give the elements flow layout (flex/grid with gap) or enough room so their boxes no longer intersect.",
        ),
      });
    }
  }
  return issues;
};

// ---------------------------------------------------------------------------
// wrapping: one-word-per-line columns and forced mid-word breaks
// ---------------------------------------------------------------------------

/**
 * Number of rendered text lines. Each text-line box is one row; boxes on the
 * same row (bidi runs, inline children) share a vertical band. Falls back to a
 * box-height estimate when no line boxes were recorded.
 */
function textLineCount(element: ElementMetric): number {
  if (element.textRects.length === 0) {
    return element.lineHeightPx > 0 ? Math.round(element.rect.height / element.lineHeightPx) : 0;
  }
  const rows = [...element.textRects].sort((a, b) => a.y - b.y);
  let count = 0;
  let rowBottom = -Infinity;
  for (const rect of rows) {
    if (rect.y >= rowBottom - rect.height / 2) count += 1;
    rowBottom = Math.max(rowBottom, rect.y + rect.height);
  }
  return count;
}

export const detectWrapping: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  for (const element of elements) {
    if (!element.visible || !element.hasDirectText) continue;
    if (element.lineHeightPx <= 0) continue;
    const lineCount = textLineCount(element);

    // One-word-per-line column.
    if (
      element.wordCount >= 4 &&
      lineCount >= 3 &&
      element.wordCount / Math.max(lineCount, 1) < 1.5
    ) {
      issues.push({
        type: "wrapping",
        severity: "medium",
        selector: element.selector,
        description:
          `Text wraps to roughly one word per line: ${element.selector} shows ` +
          `${element.wordCount} words over ~${lineCount} lines in a ${Math.round(element.rect.width)}px-wide box.`,
        rect: round(element.rect),
        heuristicSuggestion: heuristic(
          "Widen the column at this breakpoint (adjust flex-basis/width or stack the layout) so the text gets a usable measure.",
        ),
      });
      continue;
    }

    // Mid-word break: the longest word is wider than the box, yet nothing
    // overflows horizontally, so the word must have been broken.
    if (
      element.longestWordWidth > element.clientWidth + 2 &&
      element.clientWidth > 0 &&
      (element.wordBreakRisky || element.scrollWidth <= element.clientWidth + 2)
    ) {
      issues.push({
        type: "wrapping",
        severity: "medium",
        selector: element.selector,
        description:
          `Likely mid-word break: the longest word in ${element.selector} measures ` +
          `${Math.round(element.longestWordWidth)}px but the box is ${element.clientWidth}px wide` +
          (element.wordBreakRisky
            ? " (word-break/overflow-wrap forces arbitrary breaks)."
            : "."),
        rect: round(element.rect),
        heuristicSuggestion: heuristic(
          "Give the box room for the longest word, hyphenate (hyphens: auto), or shorten the copy; avoid word-break: break-all on prose.",
        ),
      });
    }
  }
  return issues;
};

// ---------------------------------------------------------------------------
// cramped-spacing: sibling content elements touching (< 2px gap)
// ---------------------------------------------------------------------------

const CRAMPED_MAX_GAP = 2;
/** Half the vertical leading of an element's text lines: the visible air above or below its glyphs. */
function halfLeading(element: ElementMetric): number {
  return Math.max(0, element.lineHeightPx - element.fontSizePx) / 2;
}

export const detectCrampedSpacing: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  const byParent = childrenByParent(elements);
  for (const children of byParent.values()) {
    const content = children.filter(
      (child) =>
        child.visible &&
        (child.hasDirectText || child.interactive) &&
        child.position !== "fixed" &&
        // Inline runs (spans in a paragraph) wrap onto consecutive lines;
        // the "gap" between them is line spacing, not block layout.
        child.display !== "inline",
    );
    for (let i = 0; i < content.length; i++) {
      for (let j = i + 1; j < content.length; j++) {
        const a = content[i]!;
        const b = content[j]!;
        // Vertical stack: b below a, columns overlapping.
        const horizontalOverlap =
          Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) -
          Math.max(a.rect.x, b.rect.x);
        const verticalOverlap =
          Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) -
          Math.max(a.rect.y, b.rect.y);
        // Stacked text is judged by the air between glyphs, not boxes: the
        // leading that line-height adds around each line separates a
        // zero-margin title from its subtitle; text at line-height 1 does not.
        const boxGap = b.rect.y - (a.rect.y + a.rect.height);
        const verticalGap = a.hasDirectText && b.hasDirectText
          ? boxGap + halfLeading(a) + halfLeading(b)
          : boxGap;
        const horizontalGap = b.rect.x - (a.rect.x + a.rect.width);
        const stackedTight =
          horizontalOverlap > Math.min(a.rect.width, b.rect.width) * 0.5 &&
          verticalGap >= -1 &&
          verticalGap < CRAMPED_MAX_GAP;
        const rowTight =
          verticalOverlap > Math.min(a.rect.height, b.rect.height) * 0.5 &&
          horizontalGap >= -1 &&
          horizontalGap < CRAMPED_MAX_GAP;
        if (!stackedTight && !rowTight) continue;
        const visuallySeparated =
          a.hasVisibleBorder ||
          b.hasVisibleBorder ||
          (a.hasVisibleBackground && b.hasVisibleBackground) ||
          (a.interactive && b.interactive);
        if (visuallySeparated) continue;
        const gap = stackedTight ? verticalGap : horizontalGap;
        issues.push({
          type: "cramped-spacing",
          severity: "low",
          confidence: "needs-confirmation",
          confidenceReasons: ["Unseparated content boxes are unusually close, but readability still needs visual confirmation."],
          selector: a.selector,
          otherSelector: b.selector,
          description:
            `${a.selector} and ${b.selector} are ${stackedTight ? "stacked" : "side by side"} with a ` +
            `${Math.max(0, Math.round(gap))}px gap; content blocks touching each other read as cramped.`,
          rect: round({
            x: Math.min(a.rect.x, b.rect.x),
            y: Math.min(a.rect.y, b.rect.y),
            width:
              Math.max(a.rect.x + a.rect.width, b.rect.x + b.rect.width) -
              Math.min(a.rect.x, b.rect.x),
            height:
              Math.max(a.rect.y + a.rect.height, b.rect.y + b.rect.height) -
              Math.min(a.rect.y, b.rect.y),
          }),
          heuristicSuggestion: heuristic(
            "Add breathing room between the siblings (margin, or gap on the flex/grid parent) -- 8px or more usually reads as intentional.",
          ),
        });
      }
    }
  }
  return issues;
};

// ---------------------------------------------------------------------------
// excessive-gap: a gap far larger than the surrounding vertical rhythm
// ---------------------------------------------------------------------------

const EXCESSIVE_FLOOR_PX = 64;
const EXCESSIVE_RATIO = 3;

export const detectExcessiveGap: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  const byParent = childrenByParent(elements);
  for (const children of byParent.values()) {
    const flow = children
      .filter(
        (child) =>
          child.visible &&
          child.position !== "fixed" &&
          child.position !== "absolute",
      )
      .sort((a, b) => a.rect.y - b.rect.y);
    if (flow.length < 4) continue;
    const gaps: { gap: number; a: ElementMetric; b: ElementMetric }[] = [];
    for (let i = 0; i < flow.length - 1; i++) {
      const a = flow[i]!;
      const b = flow[i + 1]!;
      const gap = b.rect.y - (a.rect.y + a.rect.height);
      if (gap >= 0) gaps.push({ gap, a, b });
    }
    if (gaps.length < 3) continue;
    const sorted = gaps.map((entry) => entry.gap).sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    for (const { gap, a, b } of gaps) {
      if (
        gap < EXCESSIVE_FLOOR_PX ||
        gap < median * EXCESSIVE_RATIO ||
        median <= 0
      )
        continue;
      issues.push({
        type: "excessive-gap",
        severity: "low",
        selector: a.selector,
        otherSelector: b.selector,
        description:
          `Unusually large vertical gap: ${Math.round(gap)}px between ${a.selector} and ${b.selector}, ` +
          `while the surrounding rhythm is ~${Math.round(median)}px.`,
        rect: round({
          x: Math.min(a.rect.x, b.rect.x),
          y: a.rect.y + a.rect.height,
          width: Math.max(a.rect.width, b.rect.width),
          height: gap,
        }),
        heuristicSuggestion: heuristic(
          "Check for a collapsed/empty element or an oversized margin at this breakpoint; align the gap with the surrounding spacing scale.",
        ),
      });
    }
  }
  return issues;
};

// ---------------------------------------------------------------------------
// clipped-text: text taller than a container that hides vertical overflow
// ---------------------------------------------------------------------------

export const detectClippedText: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  const byParent = childrenByParent(elements);
  for (const element of elements) {
    if (!element.visible || element.srOnly || element.clientHeight <= 0)
      continue;
    if (element.overflowY !== "hidden" && element.overflowY !== "clip")
      continue;
    if (element.scrollHeight <= element.clientHeight + 2) continue;
    if (!subtreeHasText(byParent, element)) continue;
    const clipTop = element.rect.y;
    const clipBottom = clipTop + element.clientHeight;
    const textCandidates = [
      element,
      ...elements.filter((candidate) => isAncestor(elements, element.index, candidate.index)),
    ];
    const crossingText = textCandidates.some((candidate) =>
      candidate.textRects.some(
        (rect) => rect.y < clipTop - 1 || rect.y + rect.height > clipBottom + 1,
      ),
    );
    if (!crossingText) continue;
    issues.push({
      type: "clipped-text",
      severity: "high",
      confidence: "high",
      confidenceReasons: ["A rendered text rectangle crosses an active clipping boundary."],
      selector: element.selector,
      description:
        `Text is cut off: ${element.selector} needs ${element.scrollHeight}px but is clipped at ` +
        `${element.clientHeight}px (overflow-y: ${element.overflowY}).`,
      rect: round(element.rect),
      heuristicSuggestion: heuristic(
        "Let the container grow (min-height/auto height), truncate deliberately with text-overflow or line-clamp, or shorten the content.",
      ),
    });
  }
  return issues;
};

// ---------------------------------------------------------------------------
// offscreen-interactive: interactive elements a user cannot reach
// ---------------------------------------------------------------------------

export const detectOffscreenInteractive: Detector = ({ page, elements }) => {
  const issues: DetectedIssue[] = [];
  for (const element of elements) {
    if (!element.visible || !element.interactive) continue;
    const { x, y, width, height } = element.rect;
    const right = x + width;
    const bottom = y + height;
    // A non-fixed element inside a scrollable ancestor is reachable by
    // scrolling that container even when its page coordinates fall outside the
    // document's own scroll bounds (app-shell pages where <main> scrolls, not
    // the document). Below-the-fold on any scrollable surface is NOT an issue.
    const unreachable =
      element.position === "fixed"
        ? right <= 0 ||
          bottom <= 0 ||
          x >= page.viewportWidth ||
          y >= page.viewportHeight
        : !element.hasScrollableAncestor &&
          (right <= 0 ||
            bottom <= 0 ||
            x >= page.scrollWidth - 1 ||
            y >= page.scrollHeight - 1);
    if (!unreachable) continue;
    // A same-page link parked above or left of the page is the standard
    // skip-link pattern (revealed on focus), not a control users lost.
    if (element.inPageLink && (bottom <= 0 || right <= 0)) continue;
    issues.push({
      type: "offscreen-interactive",
      severity: "high",
      selector: element.selector,
      description:
        `Interactive element ${element.selector} (<${element.tag}>) sits at ` +
        `(${Math.round(x)}, ${Math.round(y)}), outside the reachable ` +
        `${element.position === "fixed" ? "viewport" : "page"} area, so users cannot operate it.`,
      rect: round(element.rect),
      heuristicSuggestion: heuristic(
        "If the element should be hidden, hide it accessibly (hidden attribute or display: none); otherwise fix the positioning so it lands inside the page.",
      ),
    });
  }
  return issues;
};

// ---------------------------------------------------------------------------
// contrast: WCAG 2 relative-luminance contrast for rendered direct text
// ---------------------------------------------------------------------------

function linearChannel(channel: number): number {
  const normalized = Math.min(255, Math.max(0, channel)) / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: RgbaColor): number {
  return (
    0.2126 * linearChannel(color.red) +
    0.7152 * linearChannel(color.green) +
    0.0722 * linearChannel(color.blue)
  );
}

export function contrastRatio(foreground: RgbaColor, background: RgbaColor) {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function colorLabel(color: RgbaColor): string {
  return `rgb(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)})`;
}

export const detectContrast: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  for (const element of elements) {
    if (
      !element.visible ||
      !element.hasDirectText ||
      !element.textExpectedVisible ||
      element.srOnly ||
      element.hasBackgroundImage
    ) {
      continue;
    }
    const foreground = element.renderedTextColor;
    const background = element.effectiveBackgroundColor;
    const ratio = contrastRatio(foreground, background);
    const largeText =
      element.fontSizePx >= 24 ||
      (element.fontSizePx >= 18.66 && element.fontWeight >= 700);
    const threshold = largeText ? 3 : 4.5;
    if (ratio + 0.001 >= threshold) continue;
    issues.push({
      type: "contrast",
      severity: "high",
      confidence: "high",
      confidenceReasons: ["The measured flat-color text contrast is below the applicable WCAG AA threshold."],
      selector: element.selector,
      description:
        `Text contrast is ${ratio.toFixed(2)}:1 for ${colorLabel(foreground)} on ` +
        `${colorLabel(background)}; WCAG AA requires ${threshold.toFixed(1)}:1 for ` +
        `${largeText ? "large" : "normal"} text (${element.fontSizePx.toFixed(1)}px, weight ${element.fontWeight}).`,
      rect: round(element.rect),
      heuristicSuggestion: heuristic(
        `Change the text or background color so this ${largeText ? "large-text" : "normal-text"} pairing reaches at least ${threshold.toFixed(1)}:1 contrast.`,
      ),
    });
  }
  return issues;
};

// ---------------------------------------------------------------------------
// font-rendering: unavailable requested faces and broken text geometry
// ---------------------------------------------------------------------------

export const detectFontRendering: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  // A font that fails to load fails for every element that requests it. One
  // finding per family, anchored on its first affected element, says that
  // once instead of once per paragraph.
  const missingFamilies = new Map<string, ElementMetric[]>();
  for (const element of elements) {
    if (
      !element.hasDirectText ||
      !element.textExpectedVisible ||
      element.srOnly
    ) {
      continue;
    }
    if (element.rect.width <= 0.5 || element.rect.height <= 0.5) {
      issues.push({
        type: "font-rendering",
        severity: "high",
        selector: element.selector,
        description:
          `Rendered text has a zero-dimension box: ${element.selector} measures ` +
          `${element.rect.width.toFixed(1)}x${element.rect.height.toFixed(1)}px.`,
        rect: round(element.rect),
        heuristicSuggestion: heuristic(
          "Restore a non-zero text box by checking width/height constraints, transforms, and the surrounding layout; hide the content explicitly if it is not meant to render.",
        ),
      });
      continue;
    }
    if (element.fontFaceStatus === "missing") {
      const affected = missingFamilies.get(element.requestedFontFamily) ?? [];
      affected.push(element);
      missingFamilies.set(element.requestedFontFamily, affected);
      continue;
    }
    const horizontalOverflow =
      element.clientWidth > 0 &&
      element.scrollWidth > element.clientWidth + 2;
    const verticalOverflow =
      element.clientHeight > 0 &&
      element.scrollHeight > element.clientHeight + 2;
    if (!horizontalOverflow && !verticalOverflow) continue;
    issues.push({
      type: "font-rendering",
      severity: "high",
      selector: element.selector,
      description:
        `Rendered text overflows its ${element.clientWidth}x${element.clientHeight}px box: ` +
        `text layout needs ${element.scrollWidth}x${element.scrollHeight}px` +
        ` (${[
          horizontalOverflow ? "horizontal" : "",
          verticalOverflow ? "vertical" : "",
        ]
          .filter(Boolean)
          .join(" and ")} overflow).`,
      rect: round(element.rect),
      heuristicSuggestion: heuristic(
        "Let the text container grow or wrap, or use deliberate truncation; verify the loaded font and line-height do not exceed fixed box dimensions.",
      ),
    });
  }
  for (const [family, affected] of missingFamilies) {
    const first = affected[0]!;
    const others = affected.length - 1;
    issues.push({
      type: "font-rendering",
      severity: "medium",
      selector: first.selector,
      description:
        `Font "${family}" failed to load, so text renders in a fallback face from the stack ` +
        `"${first.fontFamily}". First affected: ${first.selector}` +
        (others > 0 ? `; ${others} other text element${others === 1 ? "" : "s"} on this page use the same font.` : "."),
      rect: round(first.rect),
      heuristicSuggestion: heuristic(
        "Fix the @font-face source/CORS path or remove the unavailable family, and keep an intentional fallback stack with compatible metrics.",
      ),
    });
  }
  return issues;
};

// ---------------------------------------------------------------------------
// color: deterministic near-invisible foreground/background collisions
// ---------------------------------------------------------------------------

const NEAR_INVISIBLE_CHANNEL_DELTA = 12;

export const detectColor: Detector = ({ elements }) => {
  const issues: DetectedIssue[] = [];
  for (const element of elements) {
    if (
      !element.visible ||
      !element.hasDirectText ||
      !element.textExpectedVisible ||
      element.srOnly ||
      element.hasBackgroundImage
    ) {
      continue;
    }
    const foreground = element.renderedTextColor;
    const background = element.effectiveBackgroundColor;
    const channelDelta = Math.max(
      Math.abs(foreground.red - background.red),
      Math.abs(foreground.green - background.green),
      Math.abs(foreground.blue - background.blue),
    );
    if (channelDelta > NEAR_INVISIBLE_CHANNEL_DELTA) continue;
    const ratio = contrastRatio(foreground, background);
    issues.push({
      type: "color",
      severity: "high",
      selector: element.selector,
      description:
        `Text is nearly indistinguishable from its background: ${colorLabel(foreground)} on ` +
        `${colorLabel(background)} (largest RGB channel difference ${channelDelta.toFixed(1)}, contrast ${ratio.toFixed(2)}:1).`,
      rect: round(element.rect),
      heuristicSuggestion: heuristic(
        "Choose a visibly distinct foreground/background pair and verify that inherited color, opacity, and background styles are intentional.",
      ),
    });
  }
  return issues;
};

// ---------------------------------------------------------------------------

export const ALL_DETECTORS: readonly Detector[] = [
  detectPageOverflow,
  detectElementOverflow,
  detectOverlap,
  detectWrapping,
  detectCrampedSpacing,
  detectExcessiveGap,
  detectClippedText,
  detectOffscreenInteractive,
  detectContrast,
  detectFontRendering,
  detectColor,
];

export function runDetectors(
  snapshot: Snapshot,
  detectors: readonly Detector[] = ALL_DETECTORS,
): DetectedIssue[] {
  return detectors.flatMap((detector) => detector(snapshot));
}
