import type { FontFaceStatus, Snapshot } from "@vqa/contract";

export interface SemanticFingerprintCandidate {
  baseFingerprint: string;
  structuralPath: string;
}

const AMBIGUOUS_IDENTITY_SEPARATOR = "|identity-ambiguous:";

export function semanticFingerprintBase(fingerprint: string): string {
  const separator = fingerprint.indexOf(AMBIGUOUS_IDENTITY_SEPARATOR);
  return separator === -1 ? fingerprint : fingerprint.slice(0, separator);
}

export function semanticFingerprintIsAmbiguous(fingerprint: string): boolean {
  return fingerprint.includes(AMBIGUOUS_IDENTITY_SEPARATOR);
}

/**
 * Keeps unique semantic identities independent of DOM position. Repeated peers
 * receive capture-local occurrence keys, explicitly marked ambiguous so no
 * consumer can mistake structural position for cross-capture identity.
 */
export function disambiguateSemanticFingerprints(
  candidates: readonly SemanticFingerprintCandidate[],
): string[] {
  const baseCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  for (const candidate of candidates) {
    baseCounts.set(
      candidate.baseFingerprint,
      (baseCounts.get(candidate.baseFingerprint) ?? 0) + 1,
    );
    const pathKey = JSON.stringify([
      candidate.baseFingerprint,
      candidate.structuralPath,
    ]);
    pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
  }
  const pathOrdinals = new Map<string, number>();
  return candidates.map((candidate) => {
    if (baseCounts.get(candidate.baseFingerprint) === 1) return candidate.baseFingerprint;
    const pathKey = JSON.stringify([
      candidate.baseFingerprint,
      candidate.structuralPath,
    ]);
    const ordinal = (pathOrdinals.get(pathKey) ?? 0) + 1;
    pathOrdinals.set(pathKey, ordinal);
    return `${candidate.baseFingerprint}${AMBIGUOUS_IDENTITY_SEPARATOR}${encodeURIComponent(candidate.structuralPath)}${
      (pathCounts.get(pathKey) ?? 0) > 1 ? `|ordinal:${ordinal}` : ""
    }`;
  });
}

export function resolveSnapshotSemanticFingerprints(
  snapshot: Snapshot,
): Snapshot {
  const fingerprints = disambiguateSemanticFingerprints(
    snapshot.elements.map((element) => ({
      baseFingerprint: element.elementFingerprint,
      structuralPath: element.selector,
    })),
  );
  snapshot.elements.forEach((element, index) => {
    element.elementFingerprint = fingerprints[index]!;
  });
  return snapshot;
}

/**
 * Runs inside the page via page.evaluate. Must stay self-contained (no outer
 * closures) so Playwright can serialize it.
 */
export function collectSnapshot(maxElements: number): Snapshot {
  const doc = document;
  const win = window;
  const root = doc.documentElement;

  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");

  function parseColor(value: string): Snapshot["elements"][number]["textColor"] {
    if (!ctx) return { red: 0, green: 0, blue: 0, alpha: 1 };
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    return {
      red: pixel[0]!,
      green: pixel[1]!,
      blue: pixel[2]!,
      alpha: pixel[3]! / 255,
    };
  }

  function composite(
    foreground: Snapshot["elements"][number]["textColor"],
    background: Snapshot["elements"][number]["textColor"],
    opacity = 1,
  ): Snapshot["elements"][number]["textColor"] {
    const foregroundAlpha = foreground.alpha * opacity;
    const alpha = foregroundAlpha + background.alpha * (1 - foregroundAlpha);
    if (alpha <= 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
    return {
      red:
        (foreground.red * foregroundAlpha +
          background.red * background.alpha * (1 - foregroundAlpha)) /
        alpha,
      green:
        (foreground.green * foregroundAlpha +
          background.green * background.alpha * (1 - foregroundAlpha)) /
        alpha,
      blue:
        (foreground.blue * foregroundAlpha +
          background.blue * background.alpha * (1 - foregroundAlpha)) /
        alpha,
      alpha,
    };
  }

  function applyOpacity(
    color: Snapshot["elements"][number]["textColor"],
    opacity: number,
  ): Snapshot["elements"][number]["textColor"] {
    return { ...color, alpha: color.alpha * opacity };
  }

  function normalizeFontFamily(value: string): string {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

  function firstFontFamily(value: string): string {
    let quote = "";
    for (let i = 0; i < value.length; i++) {
      const character = value[i]!;
      if ((character === '"' || character === "'") && quote === "") {
        quote = character;
      } else if (character === quote) {
        quote = "";
      } else if (character === "," && quote === "") {
        return normalizeFontFamily(value.slice(0, i));
      }
    }
    return normalizeFontFamily(value);
  }

  const declaredFontFamilies = new Set<string>();
  doc.fonts.forEach((face) => {
    declaredFontFamilies.add(
      normalizeFontFamily(face.family).toLowerCase(),
    );
  });

  function cssEscapeIdent(value: string): string {
    return win.CSS && win.CSS.escape
      ? win.CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function selectorFor(element: Element): string {
    const parts: string[] = [];
    let cursor: Element | null = element;
    let depth = 0;
    while (cursor && cursor !== doc.documentElement && depth < 4) {
      const tag = cursor.tagName.toLowerCase();
      if (cursor.id) {
        parts.unshift(`${tag}#${cssEscapeIdent(cursor.id)}`);
        return parts.join(" > ");
      }
      const parent: Element | null = cursor.parentElement;
      if (parent) {
        const index = Array.prototype.indexOf.call(parent.children, cursor) + 1;
        parts.unshift(`${tag}:nth-child(${index})`);
      } else {
        parts.unshift(tag);
      }
      cursor = parent;
      depth += 1;
    }
    return (
      (cursor === doc.documentElement ? "html > " : "") + parts.join(" > ")
    );
  }

  function boundedText(value: string | null | undefined, maximum = 72): string {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maximum) return normalized;
    return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
  }

  function implicitRole(element: Element): string {
    const explicit = boundedText(element.getAttribute("role"), 32).toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    const roles: Record<string, string> = {
      a: "link",
      button: "button",
      footer: "footer",
      form: "form",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      header: "header",
      img: "image",
      input: "field",
      main: "main content",
      nav: "navigation",
      select: "field",
      textarea: "field",
    };
    return roles[tag] ?? (tag === "p" || tag === "span" ? "text" : "content");
  }

  function labelledText(element: Element): string {
    const ariaLabel = boundedText(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = boundedText(element.getAttribute("aria-labelledby"), 256);
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (boundedText(text)) return boundedText(text);
    }
    const alt = boundedText(element.getAttribute("alt"));
    if (alt) return alt;
    const title = boundedText(element.getAttribute("title"));
    if (title) return title;
    if (element instanceof HTMLInputElement && element.labels?.length) {
      const label = boundedText(element.labels[0]?.textContent);
      if (label) return label;
    }
    return "";
  }

  function semanticIdentity(element: Element, directText: string): {
    name: string;
    fingerprint: string;
  } {
    const role = implicitRole(element);
    const accessibleName = labelledText(element);
    const ownText = boundedText(directText);
    const landmark = element.closest(
      "main,nav,header,footer,aside,section,article,form,[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=region]",
    );
    const landmarkRole = landmark ? implicitRole(landmark) : "page";
    const landmarkHeading = landmark && landmark !== element
      ? boundedText(landmark.querySelector("h1,h2,h3,h4,h5,h6")?.textContent)
      : "";
    const landmarkName = landmark
      ? labelledText(landmark) || landmarkHeading || landmarkRole
      : "page";
    const name = accessibleName || ownText || boundedText(
      landmark === element
        ? landmarkName
        : `${landmarkName} — ${role}`,
    ) || `${role} element`;
    const stableAttributes = [
      "name",
      "type",
      "href",
      "for",
      "data-testid",
      "data-test",
      "itemprop",
    ]
      .map(
        (attribute) =>
          [
            attribute,
            boundedText(element.getAttribute(attribute), 64),
          ] as const,
      )
      .filter((entry) => entry[1])
      .map(
        (entry) =>
          `${entry[0]}=${encodeURIComponent(entry[1].toLowerCase())}`,
      )
      .join(",");
    const fingerprint = element.id
      ? `id:${encodeURIComponent(element.id)}`
      : `scope:${encodeURIComponent(boundedText(landmarkName, 48).toLowerCase())}` +
        `|role:${encodeURIComponent(role)}` +
        `|kind:${element.tagName.toLowerCase()}` +
        `|name:${encodeURIComponent(boundedText(accessibleName || ownText, 48).toLowerCase())}` +
        (stableAttributes ? `|attrs:${stableAttributes}` : "");
    return { name: boundedText(name), fingerprint };
  }

  const interactiveTags = new Set([
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
  ]);

  function isInteractive(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (interactiveTags.has(tag)) return true;
    const role = element.getAttribute("role");
    if (
      role === "button" ||
      role === "link" ||
      role === "checkbox" ||
      role === "tab"
    )
      return true;
    const tabIndex = element.getAttribute("tabindex");
    return tabIndex !== null && Number(tabIndex) >= 0;
  }

  /** aria-hidden or the hidden attribute on the element itself. */
  function isOwnHidden(element: Element): boolean {
    return (
      element.getAttribute("aria-hidden") === "true" ||
      element.hasAttribute("hidden")
    );
  }

  const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);
  type Rect = Snapshot["elements"][number]["rect"];
  function intersectRects(a: Rect, b: Rect): Rect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y
      ? { x, y, width: right - x, height: bottom - y }
      : { x, y, width: 0, height: 0 };
  }

  const all = doc.querySelectorAll("*");
  const elements: Snapshot["elements"] = [];
  const indexOf = new Map<Element, number>();
  const limit = Math.min(all.length, maxElements);
  // Per collected element, derived tree state (parents precede children in
  // document order, so each entry only needs its parent's entry).
  const treeHidden: boolean[] = [];
  const treeStyleHidden: boolean[] = [];
  const treeOpacityHidden: boolean[] = [];
  const treeFixed: boolean[] = [];
  const treeScrollable: boolean[] = [];
  const treeClip: (Rect | null)[] = [];
  const treeOwnOpacity: number[] = [];
  const treeOwnBackground: Snapshot["elements"][number]["effectiveBackgroundColor"][] =
    [];
  const treeHasBackgroundImage: boolean[] = [];
  const positionedAncestor: number[] = [];

  for (let i = 0; i < limit; i++) {
    const element = all[i] as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "link" ||
      tag === "meta" ||
      tag === "head" ||
      tag === "title"
    ) {
      continue;
    }
    const style = win.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const participatesInRenderedBoxTree = element.getClientRects().length > 0;
    const ownOpacity = Math.min(
      1,
      Math.max(0, Number.parseFloat(style.opacity) || 0),
    );
    const pageRect = {
      x: rect.left + win.scrollX,
      y: rect.top + win.scrollY,
      width: rect.width,
      height: rect.height,
    };
    const renderedVisible =
      participatesInRenderedBoxTree &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      ownOpacity > 0.01 &&
      rect.width > 0 &&
      rect.height > 0;

    let hasDirectText = false;
    let wordCount = 0;
    let longestWordWidth = 0;
    let directText = "";
    const textRects: Snapshot["elements"][number]["textRects"] = [];
    for (const node of Array.prototype.slice.call(
      element.childNodes,
    ) as ChildNode[]) {
      if (
        node.nodeType === 3 &&
        node.textContent &&
        node.textContent.trim().length > 0
      ) {
        hasDirectText = true;
        directText += ` ${node.textContent}`;
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const textRect of Array.from(range.getClientRects())) {
          if (textRect.width <= 0 || textRect.height <= 0) continue;
          textRects.push({
            x: textRect.left + win.scrollX,
            y: textRect.top + win.scrollY,
            width: textRect.width,
            height: textRect.height,
          });
        }
      }
    }
    if (hasDirectText) {
      const words = directText.trim().split(/\s+/).filter(Boolean);
      wordCount = words.length;
      if (ctx) {
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        for (const word of words) {
          const width = ctx.measureText(word).width;
          if (width > longestWordWidth) longestWordWidth = width;
        }
      }
    }

    const fontSizePx = Number.parseFloat(style.fontSize) || 16;
    const rawLineHeight = style.lineHeight;
    const lineHeightPx =
      rawLineHeight === "normal"
        ? fontSizePx * 1.2
        : Number.parseFloat(rawLineHeight) || fontSizePx * 1.2;

    const parentElement = element.parentElement;
    const parentIndex =
      parentElement && indexOf.has(parentElement)
        ? indexOf.get(parentElement)!
        : -1;
    const index = elements.length;
    indexOf.set(element, index);

    // Collapsed-state / hidden-tree awareness: children of a closed <details>
    // (except its summary), aria-hidden / [hidden] elements and their
    // descendants must not participate in visual detection.
    const insideClosedDetails =
      parentElement !== null &&
      parentElement.tagName.toLowerCase() === "details" &&
      !(parentElement as HTMLDetailsElement).open &&
      tag !== "summary";
    const hiddenInTree =
      (parentIndex >= 0 && treeHidden[parentIndex]!) ||
      isOwnHidden(element) ||
      insideClosedDetails;
    treeHidden.push(hiddenInTree);
    const styleHiddenInTree =
      (parentIndex >= 0 && treeStyleHidden[parentIndex]!) ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      ownOpacity <= 0;
    treeStyleHidden.push(styleHiddenInTree);
    // Opacity composes down the tree: a child of an opacity:0 slide paints
    // nothing even though its own opacity is 1.
    const opacityHiddenInTree =
      (parentIndex >= 0 && treeOpacityHidden[parentIndex]!) || ownOpacity <= 0.01;
    treeOpacityHidden.push(opacityHiddenInTree);
    const inFixedLayer =
      (parentIndex >= 0 && treeFixed[parentIndex]!) || style.position === "fixed";
    treeFixed.push(inFixedLayer);

    const ownBackgroundColor = parseColor(style.backgroundColor);
    treeOwnOpacity.push(ownOpacity);
    treeOwnBackground.push(ownBackgroundColor);
    const textColor = parseColor(style.color);
    let backgroundLayer = applyOpacity(ownBackgroundColor, ownOpacity);
    let textLayer = applyOpacity(
      composite(textColor, ownBackgroundColor),
      ownOpacity,
    );
    let backgroundCursor = parentIndex;
    while (backgroundCursor >= 0) {
      const ancestorBackground = treeOwnBackground[backgroundCursor]!;
      const ancestorOpacity = treeOwnOpacity[backgroundCursor]!;
      backgroundLayer = applyOpacity(
        composite(backgroundLayer, ancestorBackground),
        ancestorOpacity,
      );
      textLayer = applyOpacity(
        composite(textLayer, ancestorBackground),
        ancestorOpacity,
      );
      backgroundCursor = elements[backgroundCursor]!.parent;
    }
    const canvasBackground = {
      red: 255,
      green: 255,
      blue: 255,
      alpha: 1,
    };
    const effectiveBackgroundColor = composite(
      backgroundLayer,
      canvasBackground,
    );
    const renderedTextColor = composite(textLayer, canvasBackground);
    const hasBackgroundImage =
      style.backgroundImage !== "none" ||
      (ownBackgroundColor.alpha * ownOpacity < 0.999 &&
        parentIndex >= 0 &&
        treeHasBackgroundImage[parentIndex]!);
    treeHasBackgroundImage.push(hasBackgroundImage);

    // Scrollable-ancestor awareness (excluding the document scroller itself):
    // content below the fold of an inner scroll container is reachable.
    let parentIsScroller = false;
    if (parentIndex >= 0) {
      const parentMetric = elements[parentIndex]!;
      parentIsScroller =
        (SCROLLABLE_OVERFLOW.has(parentMetric.overflowY) &&
          parentMetric.scrollHeight > parentMetric.clientHeight + 1) ||
        (SCROLLABLE_OVERFLOW.has(parentMetric.overflowX) &&
          parentMetric.scrollWidth > parentMetric.clientWidth + 1);
    }
    const hasScrollableAncestor =
      (parentIndex >= 0 && treeScrollable[parentIndex]!) || parentIsScroller;
    treeScrollable.push(hasScrollableAncestor);

    // Visible box: the border box clipped by every ancestor whose overflow is
    // not visible. Ancestors' clips accumulate down the tree, so each element
    // only intersects with its parent's accumulated clip.
    const inheritedClip = parentIndex >= 0 ? treeClip[parentIndex]! : null;
    const visibleRect = inheritedClip ? intersectRects(pageRect, inheritedClip) : pageRect;
    const clipsChildren = style.overflowX !== "visible" || style.overflowY !== "visible";
    treeClip.push(clipsChildren ? visibleRect : inheritedClip);

    // Nearest positioned ancestor (for the stretched-link heuristic).
    const nearestPositioned =
      parentIndex >= 0
        ? elements[parentIndex]!.position !== "static"
          ? parentIndex
          : positionedAncestor[parentIndex]!
        : -1;
    positionedAncestor.push(nearestPositioned);

    // sr-only / a11y clamp signature: ~1px box clamped via clip, clip-path or
    // hidden overflow. Intentional accessibility pattern, not a defect.
    const srOnly =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.width <= 1.5 &&
      rect.height <= 1.5 &&
      (style.clip !== "auto" ||
        style.clipPath !== "none" ||
        style.overflowX === "hidden" ||
        style.overflowX === "clip" ||
        style.overflowY === "hidden" ||
        style.overflowY === "clip");

    const interactive = isInteractive(element);

    // Stretched-link heuristic: an anchor/button whose box essentially covers
    // its nearest positioned ancestor (card pattern) is an intentional
    // whole-card hit target, not an accidental overlap.
    let stretchedTarget = -1;
    const role = element.getAttribute("role");
    const stretchCapable =
      tag === "a" || tag === "button" || role === "link" || role === "button";
    if (interactive && stretchCapable && nearestPositioned >= 0) {
      const ancestorRect = elements[nearestPositioned]!.rect;
      const interWidth =
        Math.min(
          pageRect.x + pageRect.width,
          ancestorRect.x + ancestorRect.width,
        ) - Math.max(pageRect.x, ancestorRect.x);
      const interHeight =
        Math.min(
          pageRect.y + pageRect.height,
          ancestorRect.y + ancestorRect.height,
        ) - Math.max(pageRect.y, ancestorRect.y);
      const interArea = Math.max(0, interWidth) * Math.max(0, interHeight);
      const ancestorArea = ancestorRect.width * ancestorRect.height;
      const selfArea = pageRect.width * pageRect.height;
      if (
        ancestorArea > 0 &&
        selfArea > 0 &&
        interArea >= ancestorArea * 0.9 &&
        interArea >= selfArea * 0.75
      ) {
        stretchedTarget = nearestPositioned;
      }
    }

    const visible = renderedVisible && !hiddenInTree && !opacityHiddenInTree && !srOnly;
    const semantic = semanticIdentity(element, directText);
    const borderWidths = [
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
    ].map((value) => Number.parseFloat(value) || 0);
    const hasVisibleBorder =
      borderWidths.some((value) => value >= 1) &&
      [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle]
        .some((value) => value !== "none" && value !== "hidden");
    const hasVisibleBackground =
      ownBackgroundColor.alpha * ownOpacity > 0.05 || style.backgroundImage !== "none";
    const requestedFontFamily = firstFontFamily(style.fontFamily);
    let fontFaceStatus: FontFaceStatus = "untracked";
    if (
      declaredFontFamilies.has(requestedFontFamily.toLowerCase()) &&
      hasDirectText
    ) {
      // Check only the requested family. Checking the whole stack fails
      // whenever a later declared family (for example a metric-matched
      // "X Fallback" face) is not loaded, even though the requested font is.
      const fontShorthand = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${JSON.stringify(requestedFontFamily)}`;
      fontFaceStatus = doc.fonts.check(fontShorthand, directText)
        ? "loaded"
        : "missing";
    }

    elements.push({
      index,
      parent: parentIndex,
      tag,
      selector: selectorFor(element),
      semanticName: semantic.name,
      elementFingerprint: semantic.fingerprint,
      rect: pageRect,
      visibleRect,
      clipRect: inheritedClip,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      position: style.position,
      transformed: style.transform !== "none",
      display: style.display,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      visible,
      interactive,
      inPageLink: tag === "a" && (element.getAttribute("href") ?? "").startsWith("#"),
      inFixedLayer,
      srOnly,
      hasScrollableAncestor,
      stretchedTarget,
      hasDirectText,
      textRects,
      hasVisibleBorder,
      hasVisibleBackground,
      textExpectedVisible:
        hasDirectText &&
        participatesInRenderedBoxTree &&
        !hiddenInTree &&
        !styleHiddenInTree &&
        !srOnly,
      wordCount,
      longestWordWidth,
      fontSizePx,
      fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
      lineHeightPx,
      fontFamily: style.fontFamily,
      requestedFontFamily,
      fontFaceStatus,
      textColor,
      renderedTextColor,
      effectiveBackgroundColor,
      hasBackgroundImage,
      wordBreakRisky:
        style.wordBreak === "break-all" ||
        style.overflowWrap === "anywhere" ||
        style.overflowWrap === "break-word",
    });
  }

  return {
    page: {
      scrollWidth: Math.max(
        root.scrollWidth,
        doc.body ? doc.body.scrollWidth : 0,
      ),
      scrollHeight: Math.max(
        root.scrollHeight,
        doc.body ? doc.body.scrollHeight : 0,
      ),
      viewportWidth: win.innerWidth,
      viewportHeight: win.innerHeight,
    },
    elements,
  };
}
