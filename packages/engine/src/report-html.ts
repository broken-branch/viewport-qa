import type { Report, ReviewManifest } from "@vqa/contract";
import { REVIEW_JS } from "./review-report-script.js";
import { REVIEW_CSS } from "./review-report-style.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON embedded in a <script> must not be able to close the tag. */
function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u{2028}/gu, "\\u2028")
    .replace(/\u{2029}/gu, "\\u2029");
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --text: #1a1d23; --muted: #5b6472;
  --border: #d8dde4; --accent: #4c5fd5;
  --high: #c0392b; --medium: #b9770e; --low: #5b6472;
  --ok: #1e7e46; --rej: #a13333;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --panel: #1d2026; --text: #e6e8ec; --muted: #9aa3af;
    --border: #32363e; --accent: #8d9bff;
    --high: #ff7b6b; --medium: #e0a94f; --low: #9aa3af;
    --ok: #5fca8e; --rej: #ff8f8f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); background: var(--panel); }
header h1 { margin: 0 0 0.25rem; font-size: 1.2rem; }
header .meta { color: var(--muted); font-size: 0.85rem; }
.banner { margin: 0.75rem 1.5rem 0; padding: 0.5rem 0.75rem; border: 1px solid var(--border);
  border-radius: 6px; background: var(--panel); color: var(--muted); font-size: 0.85rem; }
main { max-width: 70rem; margin: 0 auto; padding: 1rem 1.5rem 4rem; }
.filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0; }
.filters button { border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 999px; padding: 0.25rem 0.75rem; cursor: pointer; font-size: 0.8rem; }
.filters button.active { border-color: var(--accent); color: var(--accent); }
.issue { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  margin-bottom: 1rem; padding: 1rem; }
.issue h3 { margin: 0 0 0.25rem; font-size: 1rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.badge { font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid currentColor; }
.sev-high { color: var(--high); } .sev-medium { color: var(--medium); } .sev-low { color: var(--low); }
.vp { color: var(--muted); font-size: 0.8rem; }
.sel { font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--muted); word-break: break-all; }
.shots { display: flex; gap: 0.75rem; margin: 0.75rem 0; flex-wrap: wrap; }
.shots figure { margin: 0; }
.shots figcaption { font-size: 0.75rem; color: var(--muted); }
.shots img { max-width: 320px; max-height: 240px; border: 1px solid var(--border); border-radius: 4px;
  background: #fff; object-fit: contain; }
.rec { border-left: 3px solid var(--border); padding: 0.25rem 0.75rem; margin: 0.5rem 0; }
.rec .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.rec.ai { border-left-color: var(--accent); }
.rec.unavailable { color: var(--muted); font-style: italic; }
.actions { display: flex; gap: 0.5rem; align-items: flex-start; margin-top: 0.75rem; flex-wrap: wrap; }
.actions button { border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 6px; padding: 0.35rem 0.9rem; cursor: pointer; }
.actions button:hover { border-color: var(--accent); }
.actions textarea { flex: 1 1 16rem; min-height: 2.4rem; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg); color: var(--text); padding: 0.35rem 0.5rem; font: inherit; }
.state { font-size: 0.8rem; margin-top: 0.5rem; }
.state.approve { color: var(--ok); } .state.reject { color: var(--rej); } .state.message { color: var(--accent); }
.empty { color: var(--muted); text-align: center; padding: 3rem 0; }
.comparison { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin: 1rem 0; padding: 1rem; }
.comparison h2 { margin: 0 0 0.35rem; font-size: 1rem; }
.comparison p { margin: 0.25rem 0 0.75rem; color: var(--muted); }
.comparison ul { margin: 0; padding-left: 1.25rem; }
.comparison .score { font-variant-numeric: tabular-nums; }
.pages { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin: 1rem 0; padding: 1rem; }
.pages h2 { margin: 0 0 0.35rem; font-size: 1rem; }
.pages ul { margin: 0; padding-left: 1.25rem; }
.pages .failed { color: var(--high); }
.finding-section > h2 { margin: 1.5rem 0 0.75rem; font-size: 1.1rem; }
`;

const JS = `
const data = JSON.parse(document.getElementById("vqa-data").textContent);
const vqaCapability = (()=>{try{return sessionStorage.getItem("vqa.launch.capability");}catch{return null;}})();
function authorizedFetch(input,init) { const target=new URL(typeof input==="string"||input instanceof URL?input:input.url,location.href);if(target.origin!==location.origin)throw new Error("Viewport QA private fetch refused a different origin");const options=Object.assign({},init||{}),headers=new Headers(options.headers||{});if(vqaCapability)headers.set("authorization","VQA "+vqaCapability);options.headers=headers;return fetch(target,options); }
window.vqaAuthorizedFetch=authorizedFetch;
async function setSecureImage(image,path) { try { const response=await authorizedFetch(path,{cache:"no-store"});if(!response.ok)throw new Error();const url=URL.createObjectURL(await response.blob());image.src=url;image.addEventListener("load",function(){URL.revokeObjectURL(url);},{once:true}); } catch { image.alt=(image.alt||"Screenshot")+" (unavailable)"; } }
let decisions = {};
let serveMode = false;
let filter = "all";
const behaviourTypes = new Set(["console-message","failed-request","storage-change"]);

async function loadDecisions() {
  try {
    const res = await authorizedFetch("api/decisions", { cache: "no-store" });
    if (res.ok) { decisions = await res.json(); serveMode = true; }
  } catch { /* file:// or static hosting: decisions are read-only */ }
  render();
}

async function saveDecision(issueId, action, message) {
  const body = { issueId, action };
  if (message) body.message = message;
  const res = await authorizedFetch("api/decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { alert("Failed to save decision: " + res.status); return; }
  decisions = await res.json();
  render();
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "src" && tag === "img") void setSecureImage(node,v);
    else node.setAttribute(k, v);
  }
  for (const child of children || []) node.appendChild(child);
  return node;
}

function issueCard(issue) {
  const decision = decisions[issue.id];
  const rec = issue.aiRecommendation;
  const shots = [];
  if (issue.screenshots.crop) {
    shots.push(el("figure", {}, [
      el("img", { src: issue.screenshots.crop, alt: "element crop", loading: "lazy" }),
      el("figcaption", { text: "element crop" }),
    ]));
  }
  shots.push(el("figure", {}, [
    el("img", { src: issue.screenshots.viewport, alt: "full page at " + issue.viewport, loading: "lazy" }),
    el("figcaption", { text: "full page @ " + issue.viewport }),
  ]));

  const recs = [
    el("div", { class: "rec heuristic" }, [
      el("div", { class: "label", text: "Heuristic suggestion (rule-based, not AI)" }),
      el("div", { text: issue.heuristicSuggestion.text }),
    ]),
    rec.status === "ok"
      ? el("div", { class: "rec ai" }, [
          el("div", { class: "label", text: "AI recommendation (" + rec.model + ")" }),
          el("div", { text: rec.text }),
        ])
      : el("div", { class: "rec unavailable" }, [
          el("div", { class: "label", text: "AI recommendation" }),
          el("div", { text: "Unavailable: " + rec.reason }),
        ]),
  ];

  const textarea = el("textarea", { placeholder: "Tell the AI what to do instead..." });
  if (decision && decision.action === "message" && decision.message) textarea.value = decision.message;
  const actions = serveMode
    ? el("div", { class: "actions" }, [
        el("button", { text: "Approve fix", onclick: () => saveDecision(issue.id, "approve") }),
        el("button", { text: "Reject", onclick: () => saveDecision(issue.id, "reject") }),
        textarea,
        el("button", { text: "Send instruction", onclick: () => {
          if (textarea.value.trim()) saveDecision(issue.id, "message", textarea.value.trim());
        } }),
      ])
    : el("div", { class: "actions" }, [
        el("span", { class: "vp", text: "Legacy format-v2 report: read-only access; the original is not converted or modified." }),
      ]);

  const children = [
    el("h3", {}, [
      el("span", { class: "badge sev-" + issue.severity, text: issue.severity }),
      el("span", { text: issue.type }),
      el("span", { class: "vp", text: issue.viewport }),
      ...(issue.scenarioLabel ? [el("span", { class: "vp", text: issue.scenarioLabel })] : []),
      ...(issue.pageUrl ? [el("span", { class: "vp", text: issue.pageUrl })] : []),
      ...(issue.instanceCount > 1
        ? [el("span", { class: "badge", text: "x" + issue.instanceCount + " instances" })]
        : []),
    ]),
    el("div", { class: "sel", text: issue.selector + (issue.otherSelector ? "  +  " + issue.otherSelector : "") }),
    el("p", { text: issue.description }),
    ...(issue.occurrences && issue.occurrences.some((entry) => entry.behaviour)
      ? [el("ul", { class: "behaviour-occurrences" }, issue.occurrences.filter((entry) => entry.behaviour).map((entry) =>
          el("li", { text: behaviourEvidence(entry.behaviour) })))]
      : []),
    el("div", { class: "shots" }, shots),
    ...recs,
    actions,
  ];
  if (decision) {
    children.push(el("div", { class: "state " + decision.action,
      text: "Decision: " + decision.action + (decision.message ? ' - "' + decision.message + '"' : "") +
        " (" + decision.updatedAt + ")" }));
  }
  return el("section", { class: "issue", id: issue.id }, children);
}

function behaviourEvidence(item) {
  if (item.kind === "console-message") return item.level + " at " + item.sourceUrl + ":" + item.line + ": " + item.text;
  if (item.kind === "failed-request") return item.method + " " + item.url + " " + (item.status === undefined ? "failed: " + item.failureReason : "answered " + item.status);
  if (item.storage === "cookie") return "cookie " + item.name + " for " + item.attributes.domain + item.attributes.path + " (SameSite=" + item.attributes.sameSite + ", Secure=" + item.attributes.secure + ", HttpOnly=" + item.attributes.httpOnly + ", Expires=" + item.attributes.expires + ")";
  return item.storage + " key " + item.key;
}

function displayedIssues() {
  if (!data.groups) return data.issues;
  const issueById = new Map(data.issues.map((issue) => [issue.id, issue]));
  return data.groups.flatMap((group) => {
    const members = group.issueIds.map((id) => issueById.get(id)).filter(Boolean);
    if (!members.length) return [];
    return [Object.assign({}, members[0], {
      viewport: group.viewportRange,
      instanceCount: members.reduce((sum, issue) => sum + issue.instanceCount, 0),
      occurrences: members.flatMap((issue) => issue.occurrences || []),
    })];
  });
}

function findingSection(kind, title, issues) {
  const section = el("section", { class: "finding-section", "data-finding-kind": kind }, [
    el("h2", { text: title }),
  ]);
  if (!issues.length) {
    section.appendChild(el("div", { class: "empty", text: "No " + title.toLowerCase() + " findings." }));
  } else {
    for (const issue of issues) section.appendChild(issueCard(issue));
  }
  return section;
}

function pagesPanel() {
  if (!data.pages) return null;
  const failures = data.pages.filter((page) => page.status === "failed").length;
  return el("section", { class: "pages" }, [
    el("h2", { text: "Pages (" + data.pages.length + ", " + failures + " failed)" }),
    el("ul", {}, data.pages.map((page) => el("li", {
      class: page.status === "failed" ? "failed" : "",
      text: "depth " + page.depth + " — " + page.url +
        (page.scenarioLabel ? " / " + page.scenarioLabel : "") +
        (page.status === "failed"
          ? " — failed: " + page.error
          : " — " + page.issues.length + " issue(s)"),
    }))),
  ]);
}

function comparisonPanel() {
  if (!data.comparison) return null;
  const comparison = data.comparison;
  const changed = comparison.results.filter((result) => result.status !== "identical");
  const children = [
    el("h2", { text: "Visual comparison" }),
    el("p", { text: "Baseline captured " + comparison.baseline.createdAt + ". " +
      changed.length + " changed target(s) out of " + comparison.results.length + "." }),
  ];
  if (changed.length === 0) {
    children.push(el("div", { class: "vp", text: "All matching captures are pixel-identical." }));
  } else {
    children.push(el("ul", {}, changed.map((result) => el("li", {}, [
      el("span", { text: result.target + ": " }),
      el("span", { class: "score", text: (result.score * 100).toFixed(2) + "%" }),
      el("span", { class: "vp", text: " — " + result.status + ", " + result.changedRegions.length + " changed region(s)" }),
    ]))));
  }
  return el("section", { class: "comparison" }, children);
}

function render() {
  document.getElementById("banner").textContent = serveMode
    ? "Connected to vqa serve: decisions are persisted to decisions.json."
    : "Legacy format-v2 report: read-only access. The original report is not converted or modified.";
  const list = document.getElementById("issues");
  list.replaceChildren();
  const presented = displayedIssues();
  const issues = presented.filter((issue) => filter === "all" || issue.type === filter);
  const visual = issues.filter((issue) => !behaviourTypes.has(issue.type));
  const behaviour = issues.filter((issue) => behaviourTypes.has(issue.type));
  list.appendChild(findingSection("visual", "Visual", visual));
  list.appendChild(findingSection("behaviour", "Behaviour", behaviour));

  const comparison = document.getElementById("comparison");
  comparison.replaceChildren();
  const panel = comparisonPanel();
  if (panel) comparison.appendChild(panel);

  const pages = document.getElementById("pages");
  pages.replaceChildren();
  const pagePanel = pagesPanel();
  if (pagePanel) pages.appendChild(pagePanel);

  const filters = document.getElementById("filters");
  filters.replaceChildren();
  const types = ["all", ...new Set(presented.map((issue) => issue.type))];
  for (const type of types) {
    const count = type === "all" ? presented.length
      : presented.filter((issue) => issue.type === type).length;
    filters.appendChild(el("button", {
      class: filter === type ? "active" : "",
      text: type + " (" + count + ")",
      onclick: () => { filter = type; render(); },
    }));
  }
}

loadDecisions();
`;



function renderReviewHtml(report: Report, manifest: ReviewManifest): string {
  const reportJson = escapeJsonForScript(JSON.stringify(report));
  const manifestJson = escapeJsonForScript(JSON.stringify(manifest));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review screenshots</title><style>${REVIEW_CSS}</style></head><body>
<a class="skip" href="#review">Skip to screenshots</a>
<header class="topbar"><div class="brand">Viewport QA</div><div class="run-title"><strong>Review ${escapeHtml(manifest.pages[0]?.label ?? "screenshots")}</strong><span class="progress" id="progress">${manifest.issues.length} to review</span></div>
<div class="top-actions"><button class="nav-action" id="homeButton">Home</button><button class="nav-action" id="newReviewButton">New Review</button><button class="primary" id="exportButton" data-storage-action aria-label="Export, 0 issues" disabled>Export <span id="exportCount">(0)</span></button><button class="icon-button" id="settingsButton" aria-label="Open settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"></path></svg></button></div></header>
<div class="layout"><aside class="filters" aria-label="Screenshot filters"><h2>Filter screenshots</h2><p class="muted" id="filterSummary"></p><div id="desktopFilters"></div><button class="clear" id="clearFilters">Show All Screenshots</button></aside>
<main id="review" tabindex="-1"><div class="main-head"><div><h1>Review screenshots</h1><button class="mobile-filter" id="mobileFilterButton">Filter Screenshots</button></div>
<div class="zoom" aria-label="Screenshot zoom"><button id="zoomOut" aria-label="Zoom out">&#8722;</button><span class="zoom-label" id="zoomLabel">100%</span><button id="zoomIn" aria-label="Zoom in">+</button><button id="zoomFit" aria-pressed="false">Fit to view</button><button id="zoomActual" aria-pressed="true">Actual size</button></div></div>
<section class="storage-error" id="storageError" role="alert" hidden><p id="storageErrorText">Review storage unavailable. Feedback and exports cannot be saved.</p><button id="retryStorage">Retry Connection</button></section><p class="results-summary" id="resultsSummary" tabindex="-1"></p><div class="capture-list" id="captureList"></div></main></div>
<dialog class="drawer-dialog" id="drawer" aria-labelledby="drawerTitle"><div class="drawer"><header class="drawer-head"><h2 id="drawerTitle" tabindex="-1">Details</h2><nav class="drawer-nav" aria-label="Review navigation"><button id="drawerHomeButton" aria-label="Return Home">Home</button><button id="drawerNewReviewButton" aria-label="Start New Review">New Review</button></nav><button class="icon-button" id="closeDrawer" aria-label="Close panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></header><div class="drawer-body" id="drawerBody"></div><footer class="drawer-actions" id="drawerActions"></footer></div></dialog>
<dialog class="lightbox" id="lightbox" aria-labelledby="lightboxTitle"><div class="lightbox-shell"><header class="lightbox-head"><h2 id="lightboxTitle">Screenshot</h2><div class="lightbox-tools" aria-label="Image zoom"><button id="lightboxZoomOut" aria-label="Zoom image out">&#8722;</button><span class="zoom-label" id="lightboxZoomLabel">Actual size · 100%</span><button id="lightboxZoomIn" aria-label="Zoom image in">+</button><button id="lightboxFit" aria-pressed="false">Fit to view</button><button id="lightboxActual" aria-pressed="true">Actual size</button><a id="openOriginal" target="_blank" rel="noopener">Open Original</a></div><button class="icon-button" id="closeLightbox" aria-label="Close image"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></header><div class="lightbox-viewport" id="lightboxViewport" tabindex="0"><img id="lightboxImage" alt=""></div></div></dialog>
<div class="live" id="liveRegion" aria-live="polite"></div>
<script id="vqa-data" type="application/json">${reportJson}</script><script id="vqa-manifest" type="application/json">${manifestJson}</script><script>${REVIEW_JS}</script></body></html>`;
}

export function renderReportHtml(report: Report, manifest?: ReviewManifest): string {
  if (manifest) return renderReviewHtml(report, manifest);
  const json = escapeJsonForScript(JSON.stringify(report));
  const adapterNote = report.adapter.wired
    ? `AI adapter: ${escapeHtml(report.adapter.impl)}`
    : "AI adapter: not wired (recommendations unavailable)";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viewport QA report - ${escapeHtml(report.url)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Viewport QA report</h1>
  <div class="meta">${escapeHtml(report.url)} - ${escapeHtml(report.createdAt)} - ${report.groups?.length ?? report.issues.length} issue group(s) (${report.issues.reduce((sum, issue) => sum + issue.instanceCount, 0)} raw hit(s)) across ${report.pages?.length ?? 1} page(s) and ${report.viewports.length} viewport capture(s) - ${adapterNote}</div>
</header>
<div class="banner" id="banner"></div>
<main>
  <div id="comparison"></div>
  <div id="pages"></div>
  <div class="filters" id="filters"></div>
  <div id="issues"></div>
</main>
<script id="vqa-data" type="application/json">${json}</script>
<script>${JS}</script>
</body>
</html>
`;
}
