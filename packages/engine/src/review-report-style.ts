export const REVIEW_CSS = `
:root { color-scheme:dark; --paper:#222831; --paper-raised:#29313c; --canvas:#171c22; --ink:#f3f5f7; --muted:#aeb8c4;
  --line:#3c4653; --strong:#647183; --action:#3474c4; --action-dark:#2b62a7;
  --issue:#ef7d73; --good:#69c493; --focus:#8ab4f8; --sidebar:248px; }
* { box-sizing:border-box; }
html, body { margin:0; background:var(--canvas); color:var(--ink); }
body { font:16px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
button,input,textarea,a { font:inherit; }
button { min-height:44px; border:1px solid var(--strong); border-radius:6px; background:var(--paper);
  color:var(--ink); padding:8px 14px; cursor:pointer; }
button:hover { border-color:#aab6c4; background:var(--paper-raised); }
button:disabled { cursor:not-allowed; opacity:.5; }
button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible,a:focus-visible {
  outline:3px solid var(--focus); outline-offset:2px; }
.primary { border-color:var(--action); background:var(--action); color:#fff; font-weight:700; }
.primary:hover { background:var(--action-dark); }
button[aria-pressed="true"] { box-shadow:inset 0 0 0 2px currentColor; font-weight:700; }
.skip { position:fixed; left:12px; top:-80px; z-index:50; background:var(--ink); color:#fff; padding:10px 14px; }
.skip:focus { top:12px; }
.topbar { min-height:64px; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center;
  gap:24px; padding:10px 20px; border-bottom:1px solid var(--line); background:var(--paper); position:sticky; top:0; z-index:20; }
.brand { font-weight:800; letter-spacing:-.02em; }
.run-title { min-width:0; display:flex; align-items:baseline; gap:12px; }
.run-title strong { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.progress,.muted { color:var(--muted); font-size:14px; }
.top-actions { display:flex; gap:8px; }
.top-actions .nav-action { white-space:nowrap; }
.icon-button { width:44px; height:44px; min-height:44px; padding:0; display:inline-flex; align-items:center; justify-content:center; flex:0 0 44px; }
.icon-button svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.layout { display:grid; grid-template-columns:var(--sidebar) minmax(0,1fr); max-width:1680px; margin:0 auto; }
.filters { padding:24px 20px 48px; border-right:1px solid var(--line); background:#1d232b;
  min-height:calc(100vh - 64px); position:sticky; top:64px; align-self:start; max-height:calc(100vh - 64px); overflow:auto; }
.filters h2 { margin:0 0 18px; font-size:20px; }
fieldset { border:0; border-top:1px solid var(--line); padding:18px 0 8px; margin:0; }
legend { font-weight:750; padding:0 0 9px; }
.check { display:grid; grid-template-columns:22px 1fr auto; align-items:center; gap:8px; min-height:44px; cursor:pointer; }
.check input { width:20px; height:20px; margin:0; accent-color:var(--action); }
.check span,.check div { min-width:0; overflow-wrap:anywhere; }
.count { color:var(--muted); font-variant-numeric:tabular-nums; font-size:14px; }
.clear { width:100%; margin-top:12px; }
.mobile-filter { display:none; }
main { min-width:0; padding:30px clamp(16px,3vw,48px) 80px; }
.main-head { display:flex; justify-content:space-between; align-items:end; gap:16px; max-width:1320px; margin:0 auto 22px; }
.main-head h1 { font-size:clamp(27px,3vw,38px); line-height:1.1; letter-spacing:-.035em; margin:0 0 8px; }
.zoom { display:flex; flex-wrap:wrap; gap:6px; align-items:center; white-space:nowrap; }
.zoom button { min-width:44px; padding:6px 10px; }
.zoom-label { min-width:48px; text-align:center; font-variant-numeric:tabular-nums; }
.results-summary { max-width:1320px; margin:0 auto 12px; color:var(--muted); font-weight:700; }
.capture-list { display:grid; gap:28px; max-width:1320px; min-width:0; margin:0 auto; }
.scenario-group { display:grid; gap:20px; min-width:0; }
.scenario-group-title { margin:0; padding-bottom:8px; border-bottom:1px solid var(--line); font-size:24px; }
.capture { min-width:0; background:var(--paper); border:1px solid var(--line); }
.capture-head { display:flex; justify-content:space-between; gap:16px; padding:16px 18px; border-bottom:1px solid var(--line); }
.capture-title { margin:0; font-size:18px; }
.capture-path { color:var(--muted); font-size:14px; margin-top:3px; }
.capture-summary { white-space:nowrap; font-size:14px; font-weight:700; color:var(--muted); }
.issue-list { list-style:none; margin:0; padding:0; border-top:1px solid var(--line); }
.issue-row { display:grid; grid-template-columns:auto 1fr auto; gap:0 14px; align-items:center; padding:12px 18px; border-bottom:1px solid var(--line); border-left:5px solid var(--issue); }
.issue-row.needs-confirmation { border-left-color:#d7a928; } .issue-row.likely-noise { border-left-color:var(--muted); }
.issue-row.dismissed { opacity:.6; } .issue-row.export { background:rgba(52,116,196,.1); }
.issue-number { display:inline-grid; place-items:center; min-width:26px; height:26px; padding:0 6px; border-radius:4px; background:var(--issue); color:#fff; font-size:13px; font-weight:800; }
.issue-row.export .issue-number { background:var(--action); } .issue-row.dismissed .issue-number { background:var(--strong); }
.issue-row-main { min-width:0; }
.issue-open { display:block; width:100%; min-height:0; padding:0; border:0; background:none; color:var(--ink); font-size:16px; font-weight:700; text-align:left; line-height:1.35; }
.issue-open:hover { color:var(--focus); background:none; text-decoration:underline; }
.issue-row .issue-meta { margin:4px 0 0; font-weight:600; }
.issue-row-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
.issue-list-empty { padding:12px 18px; margin:0; border-top:1px solid var(--line); }
.quick { min-height:36px; padding:6px 12px; font-size:14px; }
.export-choice { color:var(--action); border-color:var(--action); } .export-choice.primary { color:#fff; }
.dismiss-choice { color:var(--muted); border-color:var(--strong); }
.pill { display:inline-block; padding:3px 9px; border-radius:999px; font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.03em; border:1px solid var(--strong); color:var(--muted); }
.pill.export { color:#fff; background:var(--action); border-color:var(--action); }
.pill.dismissed { color:var(--muted); border-style:dashed; }
.issue-badges { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:0 0 6px; }
.badge { display:inline-block; padding:3px 9px; border-radius:4px; font-size:13px; font-weight:700; background:var(--paper-raised); color:var(--ink); border:1px solid var(--line); }
.badge.severity-high { border-color:var(--issue); color:var(--issue); } .badge.severity-medium { border-color:#d7a928; color:#e6c25a; } .badge.severity-low { border-color:var(--strong); color:var(--muted); }
.badge.high { border-color:var(--issue); } .badge.needs-confirmation { border-color:#d7a928; } .badge.likely-noise { border-color:var(--muted); }
.issue-crop { margin:8px 0 4px; } .issue-crop .crop-open { margin-top:0; }
.issue-subject { margin:0 0 4px; font-size:16px; font-weight:700; color:var(--muted); }
.issue-finding { font-size:17px; line-height:1.5; }
.issue-range { color:var(--muted); font-weight:700; }
.issue-highlight > summary { cursor:pointer; font-weight:700; margin:12px 0 6px; }
.reasons, .evidence { margin:6px 0 0; padding-left:20px; color:var(--muted); }
.export-list { list-style:none; margin:0 0 12px; padding:0; }
.export-list .export-item { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
.export-list .export-item p { margin:4px 0 0; }
#issueNote { width:100%; min-height:72px; }
.canvas { width:100%; max-width:100%; overflow:auto; min-height:360px; max-height:min(72vh,900px); padding:18px; background:#151a20; }
.image-stage { position:relative; width:max-content; line-height:0; transform-origin:top left; }
.image-open { position:relative; display:block; min-height:0; padding:0; border:1px solid #566171; border-radius:3px; line-height:0; background:#fff; cursor:zoom-in; }
.image-open:hover { border-color:var(--focus); background:#fff; }
.image-open img { display:block; max-width:none; height:auto; background:#fff; }
.issue-marker { position:absolute; min-height:0; padding:0; border:4px solid var(--issue); border-radius:4px;
  background:rgba(180,35,24,.07); box-shadow:0 0 0 2px #fff; }
.issue-marker::after { content:attr(data-number); position:absolute; left:-4px; top:-32px; min-width:14px; line-height:22px; padding:2px 8px; text-align:center;
  color:#fff; background:var(--issue); font-size:13px; font-weight:800; border-radius:3px 3px 0 0; }
.issue-marker.export { border-color:var(--action); } .issue-marker.export::after { background:var(--action); }
.issue-marker.dismissed { border-color:var(--strong); background:transparent; opacity:.7; } .issue-marker.dismissed::after { background:var(--strong); }
.issue-marker.raised { z-index:2; box-shadow:0 0 0 2px #fff, 0 0 0 6px var(--focus); }
.highlight-stage { position:relative; width:max-content; line-height:0; }
.highlight-editor { position:absolute; border:4px solid var(--issue); background:rgba(180,35,24,.08); cursor:grab; touch-action:none; }
.highlight-editor:active { cursor:grabbing; }
.highlight-editor::before { content:"Move"; position:absolute; left:4px; top:4px; padding:3px 6px; border-radius:3px; background:var(--issue); color:#fff; font:700 12px/1.2 system-ui,sans-serif; pointer-events:none; }
.highlight-editor:focus-visible { outline:3px solid var(--focus); outline-offset:3px; }
.highlight-resize { position:absolute; right:-22px; bottom:-22px; width:44px; min-width:44px; height:44px; min-height:44px; padding:0; border:2px solid #fff; border-radius:50%; background:var(--issue); pointer-events:auto; cursor:nwse-resize; touch-action:none; }
.highlight-resize::before { content:""; display:block; width:12px; height:12px; margin:auto; border-right:3px solid #fff; border-bottom:3px solid #fff; }
.highlight-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:10px 0 18px; }
.capture-actions { display:flex; gap:8px; align-items:center; padding:14px 18px; border-top:1px solid var(--line); }
.spacer { flex:1; }
.details-button { color:var(--action); border-color:transparent; }
.empty { padding:70px 20px; text-align:center; background:var(--paper); border:1px solid var(--line); }
dialog { width:min(560px,100vw); height:100vh; max-height:100vh; margin:0 0 0 auto; padding:0; border:0;
  border-left:1px solid var(--line); background:var(--paper); color:var(--ink); }
dialog::backdrop { background:rgba(8,11,15,.76); }
.drawer-dialog { opacity:1; transform:translateX(0); transition:opacity 150ms ease-out,transform 150ms ease-out; }
.drawer-dialog::backdrop { opacity:1; transition:opacity 150ms ease-out; }
.drawer-dialog.opening,.drawer-dialog.closing { opacity:0; transform:translateX(14px); }
.drawer-dialog.opening::backdrop,.drawer-dialog.closing::backdrop { opacity:0; }
.drawer { height:100%; min-height:0; display:flex; flex-direction:column; }
.drawer-head { min-height:64px; display:flex; justify-content:space-between; align-items:center; gap:16px; padding:10px 20px; border-bottom:1px solid var(--line); }
.drawer-head h2 { margin:0; font-size:23px; flex:1 1 auto; min-width:0; }
.drawer-nav { display:flex; gap:6px; margin-left:auto; }
.drawer-nav button { min-height:40px; padding:8px 10px; white-space:nowrap; }
.drawer-body { flex:1 1 auto; min-height:0; padding:22px 20px 36px; overflow:auto; }
.drawer-body h3 { margin:24px 0 8px; font-size:18px; }
.drawer-body p { margin:5px 0 13px; }
.text-label { display:block; font-weight:750; margin:18px 0 7px; }
textarea { width:100%; min-height:128px; resize:vertical; border:1px solid var(--strong); border-radius:4px; padding:10px 12px; background:#171c22; color:var(--ink); }
.path-input { width:100%; min-height:44px; border:1px solid var(--strong); border-radius:4px; padding:8px 10px; background:#171c22; color:var(--ink); }
.help { color:var(--muted); font-size:14px; }
.request-guidance.invalid { color:#ffd2cf; font-weight:700; }
.issue-box { border-left:5px solid var(--issue); padding:2px 0 2px 14px; }
.issue-box.high { border-left-color:var(--issue); }
.issue-box.needs-confirmation { border-left-color:#d7a928; }
.issue-box.likely-noise { border-left-color:var(--muted); }
.issue-meta { color:var(--muted); font-size:14px; font-weight:700; }
.drawer-image { width:100%; max-height:320px; overflow:auto; margin-top:12px; border:1px solid var(--line); background:#151a20; padding:8px; }
.drawer-image .image-open img { display:block; max-width:none; height:auto; }
.crop-open { max-width:100%; margin-top:12px; }
.crop-open::after { content:"Open Image"; position:absolute; top:8px; right:8px; padding:5px 7px; border:1px solid #697586; border-radius:4px; background:#202832; color:#f3f5f7; font-size:12px; font-weight:700; line-height:1.2; }
.crop-open img { display:block; max-width:100%; height:auto; }
details { border-top:1px solid var(--line); padding:14px 0; }
summary { cursor:pointer; font-weight:700; }
.selection-list { border:1px solid var(--line); max-height:260px; overflow:auto; padding:8px 12px; }
.drawer-actions { margin-top:auto; padding:16px 20px; border-top:1px solid var(--line); display:flex; justify-content:flex-end; gap:8px; background:#1d232b; }
.error-summary { border-left:5px solid var(--issue); background:#3a2425; color:#ffd2cf; padding:12px 14px; margin-bottom:14px; }
.error-summary button { display:block; margin-top:10px; }
.success { border-left:5px solid var(--good); background:#1f352b; padding:14px 16px; }
.storage-error { max-width:1320px; margin:0 auto 20px; display:flex; align-items:center; gap:12px; border:1px solid #8f4d49; border-left:5px solid var(--issue); border-radius:6px; background:#3a2425; color:#ffd2cf; padding:12px 14px; }
.storage-error[hidden] { display:none; }
.storage-error p { margin:0; flex:1; }
.storage-error button { flex:0 0 auto; }
.export-item { border-bottom:1px solid var(--line); padding:16px 0; }
.mode-options { margin-top:18px; }
.mode-choice { display:grid; grid-template-columns:22px 1fr; gap:4px 10px; align-items:start; min-height:64px; padding:10px 12px; border:1px solid var(--line); border-radius:7px; margin-top:8px; cursor:pointer; }
.mode-choice:has(input:checked) { border-color:var(--action); background:#202b38; }
.mode-choice input { width:20px; height:20px; margin:2px 0 0; accent-color:var(--action); }
.mode-choice strong,.mode-choice .help { grid-column:2; }
.mode-choice strong { grid-row:1; }
.mode-choice .help { grid-row:2; }
.handoff-path { margin-top:16px; }
.handoff-output { min-height:240px; margin-top:12px; font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
.result-actions { display:flex; justify-content:flex-end; margin-top:10px; }
.info-section { margin-bottom:18px; }
.info-section h3 { margin:0 0 10px; }
.info-card { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#1d232b; }
.info-row { display:grid; grid-template-columns:minmax(112px,.8fr) minmax(0,1.4fr); gap:12px; align-items:center; padding:11px 13px; border-top:1px solid var(--line); }
.info-row:first-child { border-top:0; }
.info-label { color:var(--muted); font-size:14px; }
.info-value { min-width:0; overflow-wrap:anywhere; }
.info-value-actions { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.info-value-actions .info-value { flex:1; }
.copy-info { min-height:36px; flex:0 0 auto; padding:5px 9px; }
.info-field { display:block; padding:12px 13px; border-top:1px solid var(--line); }
.info-field .text-label { margin:0 0 7px; }
.info-field .help { margin-bottom:0; }
.settings-technical { margin-top:4px; border:1px solid var(--line); border-radius:8px; padding:0; overflow:hidden; background:#1d232b; }
.settings-technical summary { min-height:48px; display:flex; align-items:center; padding:10px 13px; }
.settings-technical[open] summary { border-bottom:1px solid var(--line); }
.settings-technical .info-card { border:0; border-radius:0; }
.lightbox { width:calc(100vw - 16px); max-width:calc(100vw - 16px); height:calc(100vh - 16px); max-height:calc(100vh - 16px); margin:auto; border:0; overflow:hidden; background:#11161c; }
.lightbox-shell { width:100%; max-width:100%; min-width:0; height:100%; display:grid; grid-template-rows:auto minmax(0,1fr); }
.lightbox-head { width:100%; max-width:100%; min-width:0; display:flex; align-items:center; gap:12px; padding:10px 14px; border-bottom:1px solid var(--line); background:var(--paper); }
.lightbox-head h2 { min-width:0; margin:0; font-size:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lightbox-tools { min-width:0; margin-left:auto; display:flex; align-items:center; gap:7px; }
.lightbox-tools button { min-width:44px; padding:6px 10px; }
.lightbox-tools a { min-height:44px; display:inline-flex; align-items:center; color:#a9ccff; padding:6px 8px; }
.lightbox-viewport { width:100%; max-width:100%; min-width:0; min-height:0; overflow:auto; padding:20px; background:#11161c; }
.lightbox-viewport img { display:block; max-width:none; height:auto; margin:0 auto; background:#fff; box-shadow:0 0 0 1px #4b5664; }
.live { position:fixed; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@media (max-width:799px) {
  .topbar { grid-template-columns:1fr; gap:6px; padding:8px 12px; }
  .brand { display:none; } .run-title { grid-column:1; grid-row:2; flex-wrap:wrap; gap:4px 10px; }
  .top-actions { grid-column:1; grid-row:1; width:100%; display:grid; grid-template-columns:auto auto 1fr 44px; gap:4px; }
  .top-actions .nav-action,.top-actions .primary { min-width:0; padding-inline:8px; font-size:14px; }
  .layout { display:block; } .filters { display:none; }
  main { padding:20px 12px 60px; } .main-head { display:block; } .main-head h1 { font-size:28px; }
  .zoom { margin-top:16px; } .mobile-filter { display:inline-block; margin-top:16px; }
  .capture-head { display:block; padding:14px; } .capture-summary { display:inline-block; margin-top:8px; white-space:normal; }
  .issue-row { grid-template-columns:auto 1fr; padding:12px 14px; } .issue-row-actions { grid-column:1 / -1; justify-content:flex-start; margin-top:8px; }
  .canvas { min-height:320px; padding:10px; max-height:68vh; } .capture-actions { padding:12px; flex-wrap:wrap; }
  .capture-actions .spacer { display:none; } .capture-actions button { flex:1 1 130px; } .drawer-dialog { width:calc(100vw - 16px); }
  .drawer-head { min-height:60px; padding:8px 12px; flex-wrap:wrap; }
  .drawer-head h2 { flex:1 1 0; }
  .drawer-nav { order:3; flex:1 0 100%; margin-left:0; }
  .drawer-nav button { flex:1; }
  .lightbox-head { display:grid; grid-template-columns:minmax(0,1fr) 44px; align-items:start; padding:8px; }
  .lightbox-head h2 { max-width:100%; padding-top:10px; } .lightbox-head > .icon-button { grid-column:2; grid-row:1; }
  .lightbox-tools { grid-column:1/-1; grid-row:2; width:100%; max-width:100%; margin:0; flex-wrap:wrap; overflow:visible; } .lightbox-tools button { flex:0 0 auto; }
  .lightbox-viewport { padding:10px; } .info-row { grid-template-columns:1fr auto; gap:4px 10px; }
  .info-label { grid-column:1/-1; } .info-value { grid-column:1; }
}
@media (max-width:420px) {
  .info-row { grid-template-columns:1fr; gap:4px; }
  .info-value-actions { align-items:flex-start; flex-wrap:wrap; }
}
@media (max-width:359px) { .topbar,.drawer-head { padding-inline:8px; } .top-actions { gap:4px; } .primary { padding-inline:10px; } main { padding-inline:8px; } }
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } .drawer-dialog { transform:none!important; opacity:1!important; } .drawer-dialog::backdrop { opacity:1!important; } }
`;
