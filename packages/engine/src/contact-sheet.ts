import type { Report } from "@vqa/contract";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a script-free index of the report's full-page captures. */
export function renderContactSheetHtml(report: Report): string {
  const grouped = new Map<string, typeof report.viewports>();
  for (const capture of report.viewports) {
    const label = capture.scenarioLabel ?? capture.pageUrl ?? report.url;
    const captures = grouped.get(label) ?? [];
    captures.push(capture);
    grouped.set(label, captures);
  }
  const groups = [...grouped.entries()].map(([groupLabel, groupCaptures]) => {
    const captures = groupCaptures.map((capture) => {
      const page = capture.pageUrl ?? report.url;
      const label = capture.viewport.label;
      const state = capture.scenarioLabel ? ` in the ${capture.scenarioLabel} state` : "";
      return `<figure>
      <img src="${escapeHtml(capture.screenshot)}" alt="Full-page screenshot of ${escapeHtml(page)}${escapeHtml(state)} at ${escapeHtml(label)}" loading="lazy">
      <figcaption><strong>${escapeHtml(label)}</strong><span>${escapeHtml(page)}</span></figcaption>
    </figure>`;
    }).join("\n");
    return `<section class="capture-group"><h2>${escapeHtml(groupLabel)}</h2><div class="capture-grid">${captures}</div></section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Viewport QA contact sheet</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 1.5rem; background: Canvas; color: CanvasText; }
    h1 { margin: 0 0 1rem; font-size: 1.4rem; }
    .capture-group + .capture-group { margin-top: 2rem; }
    h2 { font-size: 1.1rem; }
    .capture-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr)); gap: 1rem; align-items: start; }
    figure { margin: 0; padding: 0.75rem; border: 1px solid ButtonBorder; border-radius: 0.5rem; background: Canvas; }
    img { display: block; width: 100%; height: auto; border: 1px solid ButtonBorder; background: white; }
    figcaption { display: grid; gap: 0.2rem; margin-top: 0.6rem; overflow-wrap: anywhere; }
    figcaption span { color: GrayText; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Full-page screenshots</h1>
  <main>${groups}</main>
</body>
</html>
`;
}
