export const REVIEW_JS = `
const manifest = JSON.parse(document.getElementById("vqa-manifest").textContent);
const report = JSON.parse(document.getElementById("vqa-data").textContent);
const vqaCapability = (()=>{try{return sessionStorage.getItem("vqa.launch.capability");}catch{return null;}})();
function authorizedFetch(input,init) { const target=new URL(typeof input==="string"||input instanceof URL?input:input.url,location.href);if(target.origin!==location.origin)throw new Error("Viewport QA private fetch refused a different origin");const options=Object.assign({},init||{}),headers=new Headers(options.headers||{});if(vqaCapability)headers.set("authorization","VQA "+vqaCapability);options.headers=headers;return fetch(target,options); }
window.vqaAuthorizedFetch=authorizedFetch;
async function secureBlobUrl(path) { const response=await authorizedFetch(path,{cache:"no-store"});if(!response.ok)throw new Error("Private asset unavailable");return URL.createObjectURL(await response.blob()); }
async function setSecureImage(image,path) { try { const url=await secureBlobUrl(path);image.src=url;image.addEventListener("load",function(){URL.revokeObjectURL(url);},{once:true}); } catch { image.alt=(image.alt||"Screenshot")+" (unavailable)"; } }
const pageById = new Map(manifest.pages.map(function(item) { return [item.id, item]; }));
const stateById = new Map(manifest.states.map(function(item) { return [item.id, item]; }));
const assetById = new Map(manifest.assets.map(function(item) { return [item.id, item]; }));
const issueById = new Map(manifest.issues.map(function(item) { return [item.id, item]; }));
const presentationGroupById = new Map((report.groups||[]).map(function(item) { return [item.id, item]; }));
const behaviourTypes = new Set(["console-message","failed-request","storage-change"]);
const reviewDraftKey = "vqa.review.drafts."+manifest.manifest_id;
const genericScenarios = new Set(["default","alternate","baseline","issue scenario"]);
const recipeScenarioEnabled = manifest.states.length>0 && manifest.states.every(function(item){return item.arrangement_provenance==="scenario-recipe"&&item.label.trim();});
const concreteScenarioEnabled = manifest.pages.some(function(page) {
  const labels = new Set(manifest.captures.filter(function(capture){return capture.page_id===page.id;}).map(function(capture){const item=stateById.get(capture.state_id);return item&&item.label.trim();}).filter(function(label){return label&&!genericScenarios.has(label.toLowerCase());}));
  return labels.size>1;
}) && manifest.states.every(function(item){return item.label.trim()&&!genericScenarios.has(item.label.trim().toLowerCase());});
const scenarioEnabled = recipeScenarioEnabled || concreteScenarioEnabled;
let review = { issues: {}, highlights: {} };
let settings = { default_handoff_path:"" };
let zoom = 1;
let fit = false;
let activeIssueId = null;
let activeCoordinateId = null;
let noteDirty = false;
const highlightSaveQueues = new Map();
let returnFocus = null;
let drawerMode = null;
let drawerClosing = false;
let drawerCloseTimer = null;
let drawerCloseHandler = null;
let handoffAttempt = 0;
let handoffPathEdited = false;
let storageAvailable = false;
let lightboxReturnFocus = null;
let lightboxAsset = null;
let lightboxZoom = 1;
let lightboxFit = false;
const STATUSES = ["unreviewed","export","dismissed"];
const selected = { page:new Set(manifest.pages.map(function(item){return item.id;})), scenario:new Set(manifest.states.map(function(item){return item.id;})), status:new Set(STATUSES) };
/* Sizes are alternative views of one page, looked at one at a time: a single choice, narrowest first, with "all" as the way out. */
const sizeLabels = (function(){ const seen=new Map(); manifest.captures.forEach(function(capture){ if(!seen.has(capture.resolution.label)) seen.set(capture.resolution.label, capture.resolution); }); return Array.from(seen.values()).sort(function(a,b){ return a.width-b.width || a.height-b.height || (a.device_scale_factor||1)-(b.device_scale_factor||1); }).map(function(resolution){ return resolution.label; }); })();
let sizeChoice = sizeLabels.length > 1 ? sizeLabels[0] : null;
function sizeMatches(capture) { return sizeChoice === null || capture.resolution.label === sizeChoice; }
function screenKey(capture) { return capture.page_id + "\u0000" + capture.state_id; }
function screenCount(captures) { return new Set(captures.map(screenKey)).size; }
function screenUnit(count) { return count === 1 ? (scenarioEnabled ? "page state" : "page") : (scenarioEnabled ? "page states" : "pages"); }

function node(tag, attributes, children) {
  const element = document.createElement(tag);
  Object.entries(attributes || {}).forEach(function(entry) {
    const key = entry[0], value = entry[1];
    if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "src" && tag === "img" && value !== undefined) void setSecureImage(element,String(value));
    else if (value !== undefined) element.setAttribute(key, String(value));
  });
  (children || []).forEach(function(child) { element.appendChild(child); });
  return element;
}
function issueStatus(id) { return review.issues[id] ? review.issues[id].status : "unreviewed"; }
function issueNote(id) { return review.issues[id] && review.issues[id].note ? review.issues[id].note : ""; }
function statusLabel(value) { return value === "export" ? "In export" : value === "dismissed" ? "Dismissed" : "To review"; }
function pageFor(capture) { return pageById.get(capture.page_id); }
function stateFor(capture) { return stateById.get(capture.state_id); }
function captureIssues(capture) { return capture.issue_ids.map(function(id){return issueById.get(id);}).filter(Boolean); }
function issuesShownOn(capture) { return captureIssues(capture).filter(function(issue){return selected.status.has(issueStatus(issue.id));}); }
function statusMatches(capture) { return capture.issue_ids.length===0 ? selected.status.has("unreviewed") : issuesShownOn(capture).length>0; }
function matches(capture) { return selected.page.has(capture.page_id) && (!scenarioEnabled || selected.scenario.has(capture.state_id)) && sizeMatches(capture) && statusMatches(capture); }
function announce(text) { document.getElementById("liveRegion").textContent = text; }
/* Human name for a capture size: device class plus pixels, matching describeViewport() in the engine. Manifests written before device classes carry no device, so the class is read from the width. */
function deviceName(resolution) { const device = resolution.device || (resolution.width < 600 ? "mobile" : resolution.width < 1200 ? "tablet" : "desktop"); return device.charAt(0).toUpperCase() + device.slice(1); }
function sizeName(resolution) { const scale = resolution.device_scale_factor || 1; return deviceName(resolution) + " " + resolution.width + "\u00d7" + resolution.height + (scale === 1 ? "" : " @" + scale + "x"); }
function captureName(capture) { return pageFor(capture).label + (scenarioEnabled ? " / " + stateFor(capture).label : "") + " / " + sizeName(capture.resolution); }
function confidenceFor(issue) { return issue.confidence || (issue.severity==="high"?"high":"needs-confirmation"); }
function isBehaviourIssue(issue) { return issue.finding_kind==="behaviour" || behaviourTypes.has(issue.type); }
function confidenceLabel(issue) { return ({high:"High confidence","needs-confirmation":"Needs visual confirmation","likely-noise":"Likely intentional/noise"})[confidenceFor(issue)]; }
function affectedSizeLabel(issue) { const labels=issue.capture_coordinate_ids.map(function(id){return manifest.captures.find(function(capture){return capture.coordinate_id===id;});}).filter(Boolean).map(function(capture){return sizeName(capture.resolution);});return Array.from(new Set(labels)).join(", "); }
function presentationGroupsFor(issue) { return (issue.group_ids||[]).map(function(id){return presentationGroupById.get(id);}).filter(Boolean); }
function issueRange(issue){const affectedCaptures=issue.capture_coordinate_ids.map(function(id){return manifest.captures.find(function(item){return item.coordinate_id===id;});}).filter(Boolean);if(!affectedCaptures.length)return "";const scope=affectedCaptures[0];const scopeCaptures=manifest.captures.filter(function(item){return item.page_id===scope.page_id&&item.state_id===scope.state_id;});const byWidth=function(a,b){return a.resolution.width-b.resolution.width;};const affected=affectedCaptures.slice().sort(byWidth).map(function(item){return sizeName(item.resolution);}),all=scopeCaptures.slice().sort(byWidth).map(function(item){return sizeName(item.resolution);});const affectedSet=new Set(affected),clean=all.filter(function(label){return !affectedSet.has(label);});if(!clean.length)return all.length===1?"at "+all[0]:"at every size scanned ("+all.join(", ")+")";return "at "+affected.join(", ")+"; fine at "+clean.join(", ");}
const concernLabels={"page-overflow":"page content spills horizontally","element-overflow":"content spills outside its container",overlap:"visible content overlaps",wrapping:"text wraps poorly","cramped-spacing":"content may be too close together","excessive-gap":"spacing may be unexpectedly large","clipped-text":"text is clipped","offscreen-interactive":"control is outside the reachable area",contrast:"text contrast is too low","font-rendering":"text rendering is broken",color:"text is indistinguishable from its background","scenario-step":"scenario step could not be completed","console-message":"browser console message","failed-request":"failed browser request","storage-change":"browser storage write"};
function containsTechnicalLocator(value,issue){const text=String(value||"");return text.includes(":nth-child(")||text.includes(" > ")||[issue.selector,issue.other_selector,issue.technical_locator].filter(Boolean).some(function(locator){return locator.length>2&&text.includes(locator);});}
function boundedDisplay(value,maximum){const normalized=String(value||"").replace(/\\s+/g," ").trim();return normalized.length<=maximum?normalized:normalized.slice(0,maximum-1).trimEnd()+"…";}
function capitalize(text){return text.charAt(0).toUpperCase()+text.slice(1);}
function issueSubject(issue){const name=String(issue.semantic_name||"").trim();return name&&!containsTechnicalLocator(name,issue)?boundedDisplay(name,70):"";}
function issueTitle(issue){const title=String(issue.title||"").trim(),name=String(issue.semantic_name||"").trim();if(isBehaviourIssue(issue))return boundedDisplay(title||name||concernLabels[issue.type],110);const separator=title.lastIndexOf(": ");const generated=separator>0&&(containsTechnicalLocator(title.slice(0,separator),issue)||(name&&name.startsWith(title.slice(0,separator).replace(/…$/,""))));if(generated)return capitalize(title.slice(separator+2));if(title&&!containsTechnicalLocator(title,issue))return boundedDisplay(title,110);return capitalize(concernLabels[issue.type]||issue.type.replace(/-/g," "));}
function occurrenceOn(issue,capture){return issue.occurrences&&issue.occurrences.find(function(item){return item.capture_coordinate_id===capture.coordinate_id;});}
function issueFinding(issue,capture){const occurrence=capture?occurrenceOn(issue,capture):null;if(occurrence&&occurrence.message)return occurrence.message;const title=issueTitle(issue),rawTitle=String(issue.title||"").trim(),candidates=[issue.observed_outcome,issue.description];for(const candidate of candidates){const text=String(candidate||"").trim();if(text&&text!==title&&text!==rawTitle)return boundedDisplay(text,400);}return "Machine evidence suggests "+(concernLabels[issue.type]||(isBehaviourIssue(issue)?"browser behaviour":"a visual concern"))+".";}
function behaviourEvidence(item){if(item.kind==="console-message")return item.level+" at "+item.sourceUrl+":"+item.line+": "+item.text;if(item.kind==="failed-request")return item.method+" "+item.url+" "+(item.status===undefined?"failed: "+item.failureReason:"answered "+item.status);if(item.storage==="cookie")return "cookie "+item.name+" for "+item.attributes.domain+item.attributes.path+" (SameSite="+item.attributes.sameSite+", Secure="+item.attributes.secure+", HttpOnly="+item.attributes.httpOnly+", Expires="+item.attributes.expires+")";return item.storage+" key "+item.key;}
function occurrenceLabel(occurrence,issue){const capture=manifest.captures.find(function(item){return item.coordinate_id===occurrence.capture_coordinate_id;}),size=capture?sizeName(capture.resolution):"affected size";if(occurrence.behaviour)return size+": "+boundedDisplay(behaviourEvidence(occurrence.behaviour),240);const primary=isBehaviourIssue(issue)?boundedDisplay(occurrence.semantic_name,72):containsTechnicalLocator(occurrence.semantic_name,issue)?"page content":boundedDisplay(occurrence.semantic_name,72),secondary=occurrence.other_semantic_name&&!containsTechnicalLocator(occurrence.other_semantic_name,issue)?" and "+boundedDisplay(occurrence.other_semantic_name,72):"";return size+": "+primary+secondary;}
function typeLabel(issue) { return concernLabels[issue.type] || issue.type.replace(/-/g," "); }
async function navigateToLauncher(destination) { if(noteDirty&&!confirm("Your unsaved note will be lost. Leave the review now?"))return;try{await postJson("/api/navigation/"+destination,{});location.reload();}catch(error){announce("Could not return to the launcher");} }

function facetMarkup(facet, label, options) {
  const fieldset = node("fieldset", {}, [node("legend", {text:label})]);
  options.forEach(function(option) {
    const value = option[0], text = option[1];
    const input = node("input", {type:"checkbox", value:value, "data-facet":facet});
    input.checked = selected[facet].has(value);
    input.addEventListener("change", function() {
      if (input.checked) selected[facet].add(value); else selected[facet].delete(value);
      render();
      const scope = drawerMode === "filters" ? document.getElementById("drawerBody") : document;
      const replacement = scope.querySelector('input[data-facet="' + facet + '"][value="' + CSS.escape(value) + '"]');
      if (replacement) replacement.focus();
    });
    let count;
    if (facet === "status") {
      // Issue counts cover every size the issue appears at, whichever size is on show.
      const seen = new Set();
      manifest.captures.filter(function(capture){return otherFacetsMatch(facet, capture);}).forEach(function(capture){capture.issue_ids.forEach(function(id){if(issueStatus(id)===value)seen.add(id);});});
      count = seen.size;
    } else {
      count = manifest.captures.filter(function(capture) {
        if (facet === "page" && capture.page_id !== value) return false;
        if (facet === "scenario" && capture.state_id !== value) return false;
        return otherFacetsMatch(facet, capture) && sizeMatches(capture) && statusMatches(capture);
      }).length;
    }
    fieldset.appendChild(node("label", {class:"check"}, [input,node("span",{text:text}),node("span",{class:"count","aria-hidden":"true",text:String(count)})]));
  });
  return fieldset;
}
function otherFacetsMatch(facet, capture) {
  return (facet === "page" || selected.page.has(capture.page_id)) && (facet === "scenario" || !scenarioEnabled || selected.scenario.has(capture.state_id));
}
function sizeMarkup(scope) {
  const fieldset = node("fieldset", {}, [node("legend", {text:"Screen size"})]);
  const options = [[null, "All sizes"]].concat(sizeLabels.map(function(label){ return [label, sizeName(manifest.captures.find(function(capture){return capture.resolution.label===label;}).resolution)]; }));
  options.forEach(function(option) {
    const value = option[0], text = option[1];
    const input = node("input", {type:"radio", name:"size-"+scope, value:value===null?"":value, "data-facet":"resolution"});
    input.checked = sizeChoice === value;
    input.addEventListener("change", function() {
      if (!input.checked) return;
      sizeChoice = value;
      render();
      const container = drawerMode === "filters" ? document.getElementById("drawerBody") : document;
      const replacement = container.querySelector('input[data-facet="resolution"][value="' + CSS.escape(input.value) + '"]');
      if (replacement) replacement.focus();
      announce(value === null ? "Showing every size" : "Showing " + text);
    });
    const children = [input, node("span",{text:text})];
    // Each size is annotated with how many of the issues in view appear at it.
    if (value !== null) { const seen = new Set(); manifest.captures.filter(function(capture){ return capture.resolution.label === value && otherFacetsMatch("", capture); }).forEach(function(capture){ issuesShownOn(capture).forEach(function(issue){ seen.add(issue.id); }); }); children.push(node("span",{class:"count","aria-hidden":"true",text:String(seen.size)})); }
    fieldset.appendChild(node("label", {class:"check"}, children));
  });
  return fieldset;
}
function filterControls(scope) {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(sizeMarkup(scope));
  fragment.appendChild(facetMarkup("status","Issues",[["unreviewed","To review"],["export","In export"],["dismissed","Dismissed"]]));
  fragment.appendChild(facetMarkup("page","Page",manifest.pages.map(function(item){return [item.id,item.label];})));
  if(scenarioEnabled) fragment.appendChild(facetMarkup("scenario","Scenario",manifest.states.map(function(item){return [item.id,item.label];})));
  return fragment;
}
function clearFilters() {
  selected.page = new Set(manifest.pages.map(function(item){return item.id;}));
  selected.scenario = new Set(manifest.states.map(function(item){return item.id;}));
  sizeChoice = null;
  selected.status = new Set(STATUSES);
  render(); announce("Showing all screenshots");
}
function detectedRect(capture,issue) {
  const occurrence=issue.occurrences&&issue.occurrences.find(function(item){return item.capture_coordinate_id===capture.coordinate_id;});
  return (occurrence&&occurrence.rect)||(issue.rects&&issue.rects[capture.coordinate_id])||null;
}
function paddedHighlight(capture,issue) {
  const detected=detectedRect(capture,issue);if(!detected)return null;
  const x=Math.max(0,detected.x-8),y=Math.max(0,detected.y-8),right=Math.min(capture.resolution.width,detected.x+detected.width+8),bottom=Math.min(capture.resolution.height,detected.y+detected.height+8);
  return {x:x,y:y,width:right-x,height:bottom-y};
}
function effectiveHighlight(capture,issue) {
  const overrides=review.highlights[capture.coordinate_id];
  return overrides&&Object.prototype.hasOwnProperty.call(overrides,issue.id)?overrides[issue.id]:paddedHighlight(capture,issue);
}
function cropFor(capture,issue) {
  const occurrence=issue.occurrences&&issue.occurrences.find(function(item){return item.capture_coordinate_id===capture.coordinate_id;});
  const cropId=occurrence&&occurrence.crop_asset_id?occurrence.crop_asset_id:issue.crop_asset_id;
  const crop=cropId?assetById.get(cropId):undefined;
  return crop&&crop.coordinate_id===capture.coordinate_id?crop:undefined;
}
function markerFor(capture,issue,number) {
  if (isBehaviourIssue(issue)) return undefined;
  const rect = effectiveHighlight(capture,issue);
  if (!rect) return undefined;
  const status=issueStatus(issue.id);
  return node("button", {class:"issue-marker "+status,"data-issue-marker":issue.id,"data-number":String(number),style:"left:"+rect.x+"px;top:"+rect.y+"px;width:"+rect.width+"px;height:"+rect.height+"px","aria-label":"Issue "+number+": "+issueTitle(issue)+" ("+statusLabel(status)+")",onclick:function(event){openIssue(issue.id,capture.coordinate_id,event.currentTarget);}});
}
function imageButton(asset, alt, label, width, height, className) {
  const imageAttributes={src:asset.source_relative_path,alt:alt,loading:"lazy"};
  if(width) imageAttributes.width=String(width); if(height) imageAttributes.height=String(height);
  const button=node("button",{class:"image-open"+(className?" "+className:""),"aria-label":label},[node("img",imageAttributes)]);
  button.addEventListener("click",function(){openLightbox(asset,alt,label,button,width,height);});
  return button;
}
function statusPill(issue) { const status=issueStatus(issue.id);return node("span",{class:"pill "+status,"data-issue-status":issue.id,text:statusLabel(status)}); }
function quickActions(issue,capture) {
  const status=issueStatus(issue.id);
  const add=node("button",{class:"quick export-choice","data-storage-action":"",text:status==="export"?"Remove from export":"Add to export","aria-label":(status==="export"?"Remove from export: ":"Add to export: ")+issueTitle(issue),onclick:function(event){setIssueStatus(issue,status==="export"?null:"export",undefined,event.currentTarget);}});
  const dismiss=node("button",{class:"quick dismiss-choice","data-storage-action":"",text:status==="dismissed"?"Restore":"Dismiss","aria-label":(status==="dismissed"?"Restore: ":"Dismiss: ")+issueTitle(issue),onclick:function(event){setIssueStatus(issue,status==="dismissed"?null:"dismissed",undefined,event.currentTarget);}});
  add.disabled=!storageAvailable;dismiss.disabled=!storageAvailable;
  return [add,dismiss];
}
function issueRow(issue,capture,number) {
  const confidence=confidenceFor(issue);
  const open=node("button",{class:"issue-open",text:issueTitle(issue),"aria-label":"Open issue "+number+": "+issueTitle(issue),onclick:function(event){openIssue(issue.id,capture.coordinate_id,event.currentTarget);}});
  const meta=[];const subject=issueSubject(issue);if(subject&&!isBehaviourIssue(issue))meta.push("in \u201c"+subject+"\u201d");meta.push(issue.severity+" severity",confidenceLabel(issue).toLowerCase());const range=issueRange(issue);if(range)meta.push(range);
  const row=node("li",{class:"issue-row "+confidence+" "+issueStatus(issue.id),"data-issue-row":issue.id},[
    node("span",{class:"issue-number","aria-hidden":"true",text:String(number)}),
    node("div",{class:"issue-row-main"},[open,node("p",{class:"issue-meta",text:meta.join(" · ")})]),
    node("div",{class:"issue-row-actions"},[statusPill(issue)].concat(quickActions(issue,capture)))
  ]);
  // Highlights on one screenshot can stack; pointing at a row lifts its marker to the top.
  const raise=function(on){const marker=row.closest(".capture")?.querySelector('[data-issue-marker="'+CSS.escape(issue.id)+'"]');if(marker)marker.classList.toggle("raised",on);};
  row.addEventListener("mouseenter",function(){raise(true);});row.addEventListener("mouseleave",function(){raise(false);});row.addEventListener("focusin",function(){raise(true);});row.addEventListener("focusout",function(){raise(false);});
  return row;
}
function captureCard(capture, grouped) {
  const page = pageFor(capture), state = stateFor(capture), asset = assetById.get(capture.full_asset_id);
  const shown=issuesShownOn(capture);
  const condition = scenarioEnabled ? ", "+state.label+" scenario" : "";
  const alt=page.label+" page"+condition+", "+sizeName(capture.resolution)+" screenshot";
  const imageControl=imageButton(asset,alt,"Open "+captureName(capture)+" screenshot",capture.resolution.width,capture.resolution.height);
  const stage = node("div", {class:"image-stage","data-width":String(capture.resolution.width),"data-height":String(capture.resolution.height)}, [imageControl]);
  shown.forEach(function(issue,index){const marker=markerFor(capture,issue,index+1);if(marker)stage.appendChild(marker);});
  const counts=STATUSES.map(function(status){const n=captureIssues(capture).filter(function(issue){return issueStatus(issue.id)===status;}).length;return n?n+" "+statusLabel(status).toLowerCase():null;}).filter(Boolean);
  const summary=capture.issue_ids.length?counts.join(" · "):"No issues found";
  const openImage=node("button",{class:"details-button",text:"Open Image",onclick:function(){openLightbox(asset,alt,"Open "+captureName(capture)+" screenshot",imageControl,capture.resolution.width,capture.resolution.height);}});
  const list=node("ol",{class:"issue-list","aria-label":"Issues on "+captureName(capture)});
  shown.forEach(function(issue,index){list.appendChild(issueRow(issue,capture,index+1));});
  const children=[
    node("header",{class:"capture-head"},[node("div",{},[node(grouped?"h3":"h2",{class:"capture-title",text:page.label+(scenarioEnabled?" / "+state.label:"")}),node("div",{class:"capture-path",text:sizeName(capture.resolution)})]),node("span",{class:"capture-summary",text:summary})]),
    node("div",{class:"canvas",tabindex:"0","data-label":captureName(capture)+" screenshot canvas","aria-label":captureName(capture)+" screenshot canvas — Actual size at 100%"},[stage])
  ];
  if(shown.length)children.push(list);
  else if(capture.issue_ids.length)children.push(node("p",{class:"help issue-list-empty",text:"Issues on this screenshot are hidden by the current filters."}));
  children.push(node("footer",{class:"capture-actions"},[openImage]));
  return node("article", {class:"capture","data-capture":capture.coordinate_id}, children);
}
function applyZoom() {
  document.querySelectorAll(".capture").forEach(function(card) {
    const canvas = card.querySelector(".canvas"), stage = card.querySelector(".image-stage"), nativeWidth = Number(stage.dataset.width),nativeHeight=Number(stage.dataset.height),style=getComputedStyle(canvas);
    const availableWidth=canvas.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    // Fit means fit the width: a phone capture on a wide screen grows to fill
    // the canvas (up to 3x, past which pixels stop meaning anything), and a
    // desktop capture on a narrow screen shrinks. Height scrolls either way.
    const scale = fit ? Math.max(.05,Math.min(3,availableWidth/nativeWidth)) : zoom;
    stage.style.transform = "scale("+scale+")";
    stage.style.marginRight = String(nativeWidth*scale-nativeWidth)+"px";
    stage.style.marginBottom = String(nativeHeight*scale-nativeHeight)+"px";
    stage.dataset.zoomScale=String(scale);
    canvas.setAttribute("aria-label",canvas.dataset.label+" — "+(fit?"Fit to view at "+Math.round(scale*100)+"%":zoom===1?"Actual size at 100%":"Zoomed to "+Math.round(zoom*100)+"%"));
  });
  document.getElementById("zoomLabel").textContent = fit ? "Fit mode" : String(Math.round(zoom*100))+"%";
  document.getElementById("zoomFit").setAttribute("aria-pressed",String(fit));
  document.getElementById("zoomActual").setAttribute("aria-pressed",String(!fit&&zoom===1));
}
function lightboxFitScale() {
  const viewport=document.getElementById("lightboxViewport"),style=getComputedStyle(viewport);
  return Math.min(1,(viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight))/lightboxAsset.width,(viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom))/lightboxAsset.height);
}
function updateLightboxZoom() {
  if(!lightboxAsset) return;
  const image=document.getElementById("lightboxImage");
  image.style.width=String(Math.max(1,lightboxAsset.width*lightboxZoom))+"px";
  const fitScale=lightboxFitScale(),fitsAtActual=fitScale>=.999;
  document.getElementById("lightboxZoomLabel").textContent=lightboxFit?"Fit to view · "+Math.round(lightboxZoom*100)+"%":fitsAtActual&&lightboxZoom===1?"Fits at actual size · 100%":lightboxZoom===1?"Actual size · 100%":String(Math.round(lightboxZoom*100))+"%";
  const fitButton=document.getElementById("lightboxFit");fitButton.disabled=fitsAtActual;fitButton.title=fitsAtActual?"Image already fits at actual size":"Fit the image within the visible viewport";fitButton.setAttribute("aria-pressed",String(lightboxFit));
  document.getElementById("lightboxActual").setAttribute("aria-pressed",String(!lightboxFit&&lightboxZoom===1));
}
function fitLightbox() {
  if(!lightboxAsset) return;
  const scale=lightboxFitScale();lightboxFit=scale<.999;lightboxZoom=lightboxFit?scale:1;
  updateLightboxZoom();
}
function openLightbox(asset, alt, label, trigger, width, height) {
  lightboxReturnFocus=trigger; lightboxAsset={width:width||1,height:height||1};
  document.getElementById("lightboxTitle").textContent=label;
  const image=document.getElementById("lightboxImage"); void setSecureImage(image,asset.source_relative_path); image.alt=alt;
  document.getElementById("openOriginal").dataset.assetPath=asset.source_relative_path;
  const dialog=document.getElementById("lightbox"); dialog.showModal();
  const ready=function(){lightboxAsset={width:width||image.naturalWidth,height:height||image.naturalHeight};fitLightbox();document.getElementById("closeLightbox").focus();};
  if(image.complete&&image.naturalWidth) requestAnimationFrame(ready); else image.addEventListener("load",ready,{once:true});
}
function closeLightbox(){document.getElementById("lightbox").close();}
function trapLightboxFocus(event) {
  if(event.key!=="Tab") return;
  const items=Array.from(document.getElementById("lightbox").querySelectorAll('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'));
  if(!items.length) return;
  const first=items[0],last=items[items.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}
function statusCounts() { const counts={unreviewed:0,export:0,dismissed:0};manifest.issues.forEach(function(issue){counts[issueStatus(issue.id)]++;});return counts; }
function updateProgress() {
  const counts=statusCounts();
  document.getElementById("progress").textContent = counts.unreviewed+" to review · "+counts.export+" in export · "+counts.dismissed+" dismissed";
  document.getElementById("exportCount").textContent = "("+counts.export+")";
  const button=document.getElementById("exportButton");
  button.setAttribute("aria-label","Export, "+counts.export+" "+(counts.export===1?"issue":"issues"));
  button.disabled=!storageAvailable||counts.export===0;
}
function updateStorageControls() { document.querySelectorAll("[data-storage-action]").forEach(function(control){control.disabled=!storageAvailable;}); }
function showStorageError(message) { storageAvailable=false;const error=document.getElementById("storageError");document.getElementById("storageErrorText").textContent=message;error.hidden=false;updateStorageControls();announce(message); }
function clearStorageError(announceRecovery) { storageAvailable=true;document.getElementById("storageError").hidden=true;updateStorageControls();if(announceRecovery)announce("Review storage connected. Saving and export are available."); }
function render() {
  const filters = document.getElementById("desktopFilters"); filters.replaceChildren(filterControls("desktop"));
  if (drawerMode === "filters" && document.getElementById("drawer").open) renderMobileFilters();
  const visible = manifest.captures.filter(matches), list = document.getElementById("captureList"); list.replaceChildren();
  // The summary counts pages (and scenario states), never the size variants of one page.
  const shownScreens = screenCount(visible), totalScreens = screenCount(manifest.captures);
  document.getElementById("filterSummary").textContent = shownScreens===totalScreens ? "Showing all "+totalScreens+" "+screenUnit(totalScreens) : "Showing "+shownScreens+" of "+totalScreens+" "+screenUnit(totalScreens);
  const high=manifest.issues.filter(function(issue){return confidenceFor(issue)==="high";}).length,confirmation=manifest.issues.filter(function(issue){return confidenceFor(issue)==="needs-confirmation";}).length,noise=manifest.issues.filter(function(issue){return confidenceFor(issue)==="likely-noise";}).length;
  document.getElementById("resultsSummary").textContent = manifest.issues.length+" "+(manifest.issues.length===1?"issue":"issues")+": "+high+" likely "+(high===1?"defect":"defects")+", "+confirmation+" to confirm, "+noise+" likely noise. "+shownScreens+" "+screenUnit(shownScreens)+(shownScreens===1?" matches":" match")+" your filters.";
  if (visible.length && scenarioEnabled) manifest.states.forEach(function(state,index){const captures=visible.filter(function(capture){return capture.state_id===state.id;});if(!captures.length)return;const headingId="scenario-group-"+index,section=node("section",{class:"scenario-group","aria-labelledby":headingId},[node("h2",{class:"scenario-group-title",id:headingId,text:state.label})]);captures.forEach(function(capture){section.appendChild(captureCard(capture,true));});list.appendChild(section);});
  else if (visible.length) visible.forEach(function(capture){list.appendChild(captureCard(capture,false));});
  else list.appendChild(node("section",{class:"empty"},[node("h2",{text:"No screenshots match these filters"}),node("p",{text:"Change a filter or show all screenshots."}),node("button",{text:"Show All Screenshots",onclick:clearFilters})]));
  applyZoom(); updateProgress(); updateStorageControls();
}
async function postJson(path, body) {
  const response = await authorizedFetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}
async function setIssueStatus(issue, status, note, trigger) {
  const body={issueId:issue.id,status:status};if(note!==undefined)body.note=note;
  try {
    review = await postJson("api/review",body);
    noteDirty=false;
    const drawerOpen=document.getElementById("drawer").open&&drawerMode==="issue"&&activeIssueId===issue.id;
    render();
    if(drawerOpen){renderIssueDrawer();}
    else requestAnimationFrame(function(){const replacement=document.querySelector('[data-issue-row="'+CSS.escape(issue.id)+'"] .issue-open');(replacement||document.getElementById("resultsSummary")).focus();});
    announce(status===null?"Cleared: "+issueTitle(issue):statusLabel(status)+": "+issueTitle(issue));
  } catch (error) { if(trigger&&trigger.isConnected)trigger.focus(); if(document.getElementById("drawer").open)appendError("Could not save. "+error.message,true); showStorageError("Review storage unavailable. Decisions and exports cannot be saved."); }
}
function openDrawer(title, mode, trigger) {
  if(drawerMode==="export")handoffAttempt++;
  drawerMode=mode; returnFocus=trigger||document.activeElement;
  document.getElementById("drawerTitle").textContent=title;
  document.getElementById("drawerBody").replaceChildren(); document.getElementById("drawerActions").replaceChildren();
  const drawer=document.getElementById("drawer");
  if(drawerCloseTimer){clearTimeout(drawerCloseTimer);drawerCloseTimer=null;}if(drawerCloseHandler){drawer.removeEventListener("transitionend",drawerCloseHandler);drawerCloseHandler=null;}drawerClosing=false;drawer.classList.remove("closing");drawer.classList.add("opening");
  if(!drawer.open)drawer.showModal();
  requestAnimationFrame(function(){document.getElementById("drawerTitle").focus();requestAnimationFrame(function(){if(!drawerClosing)drawer.classList.remove("opening");});});
}
function finishDrawerClose() { const drawer=document.getElementById("drawer");if(drawerCloseTimer){clearTimeout(drawerCloseTimer);drawerCloseTimer=null;}if(drawerCloseHandler){drawer.removeEventListener("transitionend",drawerCloseHandler);drawerCloseHandler=null;}drawerClosing=false;drawer.classList.remove("opening","closing");if(drawer.open)drawer.close(); }
function closeDrawer() { const drawer=document.getElementById("drawer");if(!drawer.open||drawerClosing)return;if(drawerMode==="export")handoffAttempt++;if(matchMedia("(prefers-reduced-motion: reduce)").matches){finishDrawerClose();return;}drawerClosing=true;drawer.classList.remove("opening");drawer.classList.add("closing");drawerCloseHandler=function(event){if(event.target===drawer&&(event.propertyName==="opacity"||event.propertyName==="transform"))finishDrawerClose();};drawer.addEventListener("transitionend",drawerCloseHandler);drawerCloseTimer=setTimeout(finishDrawerClose,190); }
function appendError(message, allowRetry) {
  const existing=document.getElementById("saveError"); if(existing) existing.remove();
  const children=[node("span",{text:message})];if(allowRetry)children.push(node("button",{text:"Retry Connection",onclick:function(){loadReview(true);}}));
  const error=node("div",{class:"error-summary",id:"saveError",role:"alert",tabindex:"-1"},children);
  document.getElementById("drawerBody").prepend(error); error.focus();
}
function highlightStyle(rect) { return "left:"+rect.x+"px;top:"+rect.y+"px;width:"+rect.width+"px;height:"+rect.height+"px"; }
function addHighlightEditor(stage,capture,issue) {
  const rect=effectiveHighlight(capture,issue);if(!rect)return;
  let current={x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  const marker=node("div",{class:"highlight-editor","data-highlight-editor":issue.id,style:highlightStyle(current),role:"button",tabindex:"0","aria-label":"Move highlight for "+issueTitle(issue)+". Use arrow keys to reposition it. Press Enter to open the image."});
  const handle=node("button",{class:"highlight-resize",type:"button","aria-label":"Resize highlight for "+issueTitle(issue),title:"Drag to resize. Use arrow keys for precise changes."});
  function show(){marker.setAttribute("style",highlightStyle(current));}
  function constrain(width,height){current.width=Math.max(16,Math.min(capture.resolution.width-current.x,width));current.height=Math.max(16,Math.min(capture.resolution.height-current.y,height));show();}
  function moveTo(x,y){current.x=Math.max(0,Math.min(capture.resolution.width-current.width,x));current.y=Math.max(0,Math.min(capture.resolution.height-current.height,y));show();}
  marker.addEventListener("pointerdown",function(event){if(event.target!==marker)return;event.preventDefault();const startX=event.clientX,startY=event.clientY,startLeft=current.x,startTop=current.y,image=stage.querySelector("img"),scale=image.getBoundingClientRect().width/capture.resolution.width;let moved=false;try{marker.setPointerCapture(event.pointerId);}catch{}const move=function(next){const dx=(next.clientX-startX)/scale,dy=(next.clientY-startY)/scale;if(Math.abs(dx)>2||Math.abs(dy)>2)moved=true;moveTo(Math.round(startLeft+dx),Math.round(startTop+dy));};const cleanup=function(){marker.removeEventListener("pointermove",move);marker.removeEventListener("pointerup",finish);marker.removeEventListener("pointercancel",cancel);};const finish=function(next){move(next);cleanup();if(moved)saveIssueHighlight(capture,issue,current);else stage.querySelector(".image-open").click();};const cancel=function(){cleanup();current.x=startLeft;current.y=startTop;show();};marker.addEventListener("pointermove",move);marker.addEventListener("pointerup",finish);marker.addEventListener("pointercancel",cancel);});
  marker.addEventListener("keydown",function(event){if(event.target!==marker)return;const delta=event.shiftKey?16:4;if(event.key==="ArrowRight")moveTo(current.x+delta,current.y);else if(event.key==="ArrowLeft")moveTo(current.x-delta,current.y);else if(event.key==="ArrowDown")moveTo(current.x,current.y+delta);else if(event.key==="ArrowUp")moveTo(current.x,current.y-delta);else if(event.key==="Enter"||event.key===" "){event.preventDefault();stage.querySelector(".image-open").click();return;}else return;event.preventDefault();saveIssueHighlight(capture,issue,current,"move");});
  handle.addEventListener("pointerdown",function(event){event.preventDefault();event.stopPropagation();const startX=event.clientX,startY=event.clientY,startWidth=current.width,startHeight=current.height;try{handle.setPointerCapture(event.pointerId);}catch{}const move=function(next){constrain(startWidth+next.clientX-startX,startHeight+next.clientY-startY);};const finish=function(next){move(next);handle.removeEventListener("pointermove",move);handle.removeEventListener("pointerup",finish);handle.removeEventListener("pointercancel",finish);saveIssueHighlight(capture,issue,current);};handle.addEventListener("pointermove",move);handle.addEventListener("pointerup",finish);handle.addEventListener("pointercancel",finish);});
  handle.addEventListener("keydown",function(event){const delta=event.shiftKey?16:4;if(event.key==="ArrowRight")constrain(current.width+delta,current.height);else if(event.key==="ArrowLeft")constrain(current.width-delta,current.height);else if(event.key==="ArrowDown")constrain(current.width,current.height+delta);else if(event.key==="ArrowUp")constrain(current.width,current.height-delta);else return;event.preventDefault();saveIssueHighlight(capture,issue,current,"resize");});
  marker.appendChild(handle);stage.appendChild(marker);
}
function refreshHighlight(capture,issue) {
  const stage=document.querySelector('[data-highlight-stage="'+CSS.escape(capture.coordinate_id)+'"]');if(stage){stage.querySelector('[data-highlight-editor="'+CSS.escape(issue.id)+'"]')?.remove();addHighlightEditor(stage,capture,issue);}
  const control=document.querySelector('[data-highlight-control="'+CSS.escape(issue.id)+'"]');if(control){const removed=effectiveHighlight(capture,issue)===null;control.textContent=removed?"Restore Highlight":"Remove Highlight";control.setAttribute("aria-label",(removed?"Restore":"Remove")+" highlight for "+issueTitle(issue));}
  const card=document.querySelector('[data-capture="'+CSS.escape(capture.coordinate_id)+'"]');if(card){const existing=card.querySelector('[data-issue-marker="'+CSS.escape(issue.id)+'"]'),number=existing?Number(existing.dataset.number):issuesShownOn(capture).indexOf(issue)+1;existing?.remove();const marker=markerFor(capture,issue,number);if(marker)card.querySelector(".image-stage").appendChild(marker);}
}
async function persistIssueHighlight(intent,queue) { const capture=intent.capture,issue=intent.issue,rect=intent.rect,scrollState=intent.scrollState,drawerBody=document.getElementById("drawerBody"),imageViewport=drawerBody&&drawerBody.querySelector(".drawer-image");try { review=await postJson("api/review",{coordinateId:capture.coordinate_id,highlightIssueId:issue.id,highlightRect:rect});if(queue.pending)return;refreshHighlight(capture,issue);if(scrollState&&document.getElementById("drawer").open&&drawerMode==="issue"){const editor=document.querySelector('[data-highlight-editor="'+CSS.escape(issue.id)+'"]'),next=intent.focusTarget==="resize"&&editor?editor.querySelector(".highlight-resize"):editor;if(next){next.focus({preventScroll:true});drawerBody.scrollTop=scrollState.body;if(imageViewport){imageViewport.scrollTop=scrollState.imageTop;imageViewport.scrollLeft=scrollState.imageLeft;}window.scrollTo(scrollState.windowX,scrollState.windowY);}}announce(rect?"Highlight updated for "+issueTitle(issue):"Highlight removed for "+issueTitle(issue));}catch(error){appendError("Could not save highlight. "+error.message,false);announce("Could not save highlight");} }
function saveIssueHighlight(capture,issue,rect,focusTarget) { const key=capture.coordinate_id+"\u0000"+issue.id,drawerBody=document.getElementById("drawerBody"),imageViewport=drawerBody&&drawerBody.querySelector(".drawer-image"),intent={capture:capture,issue:issue,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,focusTarget:focusTarget,scrollState:focusTarget?{body:drawerBody.scrollTop,imageTop:imageViewport?imageViewport.scrollTop:0,imageLeft:imageViewport?imageViewport.scrollLeft:0,windowX:window.scrollX,windowY:window.scrollY}:null};let queue=highlightSaveQueues.get(key);if(!queue){queue={running:false,pending:null};highlightSaveQueues.set(key,queue);}queue.pending=intent;if(queue.running)return;queue.running=true;(async function(){while(queue.pending){const next=queue.pending;queue.pending=null;await persistIssueHighlight(next,queue);}queue.running=false;highlightSaveQueues.delete(key);})(); }
function openIssue(issueId, coordinateId, trigger) {
  activeIssueId=issueId; activeCoordinateId=coordinateId; noteDirty=false;
  openDrawer("Issue","issue",trigger);
  renderIssueDrawer();
}
function renderIssueDrawer() {
  const issue=issueById.get(activeIssueId),capture=manifest.captures.find(function(item){return item.coordinate_id===activeCoordinateId;});
  const page=pageFor(capture),state=stateFor(capture),asset=assetById.get(capture.full_asset_id),status=issueStatus(issue.id),behaviour=isBehaviourIssue(issue);
  const body=document.getElementById("drawerBody"),actions=document.getElementById("drawerActions");
  const pendingNote=document.getElementById("issueNote")?document.getElementById("issueNote").value:null;
  body.replaceChildren(); actions.replaceChildren();
  document.getElementById("drawerTitle").textContent=issueTitle(issue);
  body.appendChild(node("p",{class:"issue-badges"},[node("span",{class:"badge severity-"+issue.severity,text:issue.severity+" severity"}),node("span",{class:"badge "+confidenceFor(issue),text:confidenceLabel(issue)})].concat(behaviour?[node("span",{class:"badge type",text:typeLabel(issue)})]:[]).concat([statusPill(issue)])));
  const subject=issueSubject(issue);if(subject&&!behaviour)body.appendChild(node("p",{class:"issue-subject",text:"In \u201c"+subject+"\u201d"}));
  body.appendChild(node("p",{class:"help",text:captureName(capture)}));
  const crop=behaviour?undefined:cropFor(capture,issue);
  if(crop){body.appendChild(node("h3",{text:"Close-up"}));body.appendChild(node("div",{class:"issue-crop"},[imageButton(crop,"Close-up of "+issueTitle(issue)+" at "+sizeName(capture.resolution),"Open close-up of "+issueTitle(issue),crop.width,crop.height,"crop-open")]));}
  body.appendChild(node("h3",{text:"What was found"}));
  body.appendChild(node("p",{class:"issue-finding",text:issueFinding(issue,capture)}));
  const range=issueRange(issue);if(range)body.appendChild(node("p",{class:"issue-range",text:capitalize(range)+"."}));
  const elsewhere=issue.capture_coordinate_ids.filter(function(id){return id!==capture.coordinate_id;}).map(function(id){return manifest.captures.find(function(item){return item.coordinate_id===id;});}).filter(Boolean);
  if(elsewhere.length)body.appendChild(node("p",{class:"help",text:"Also on: "+elsewhere.map(captureName).join("; ")}));
  if(issue.confidence_reasons&&issue.confidence_reasons.length){const reasons=node("ul",{class:"reasons"});issue.confidence_reasons.forEach(function(reason){reasons.appendChild(node("li",{text:reason}));});body.appendChild(reasons);}
  if(behaviour&&issue.occurrences&&issue.occurrences.length){body.appendChild(node("h3",{text:"Evidence"}));const list=node("ul",{class:"evidence"});issue.occurrences.forEach(function(occurrence){list.appendChild(node("li",{text:occurrenceLabel(occurrence,issue)}));});body.appendChild(list);}
  if(issue.heuristic_suggestion||issue.ai_recommendation_status.status==="ok"){body.appendChild(node("h3",{text:"Suggested fix"}));if(issue.heuristic_suggestion)body.appendChild(node("p",{text:issue.heuristic_suggestion}));if(issue.ai_recommendation_status.status==="ok")body.appendChild(node("p",{text:"AI ("+issue.ai_recommendation_status.model+"): "+issue.ai_recommendation_status.text}));}
  body.appendChild(node("label",{class:"text-label",for:"issueNote",text:"Note for the handoff (optional)"}));
  const textarea=node("textarea",{id:"issueNote",rows:"3",placeholder:"Anything the person or agent fixing this should know."});textarea.value=pendingNote!==null?pendingNote:issueNote(issue.id);textarea.addEventListener("input",function(){noteDirty=textarea.value.trim()!==issueNote(issue.id);const save=document.getElementById("saveNote");if(save)save.hidden=!noteDirty||status==="unreviewed";});body.appendChild(textarea);
  if(!behaviour){
    const highlightDetails=node("details",{class:"issue-highlight"},[node("summary",{text:"Adjust the highlight"})]);
    const fullAlt="Full "+page.label+(scenarioEnabled?", "+state.label+" scenario":"")+" screenshot at "+sizeName(capture.resolution);
    const highlightStage=node("div",{class:"highlight-stage","data-highlight-stage":capture.coordinate_id},[imageButton(asset,fullAlt,"Open full "+captureName(capture)+" screenshot",capture.resolution.width,capture.resolution.height)]);addHighlightEditor(highlightStage,capture,issue);
    highlightDetails.appendChild(node("div",{class:"drawer-image"},[highlightStage]));
    const removed=effectiveHighlight(capture,issue)===null;const control=node("button",{type:"button","data-highlight-control":issue.id,text:removed?"Restore Highlight":"Remove Highlight","aria-label":(removed?"Restore":"Remove")+" highlight for "+issueTitle(issue),onclick:function(){saveIssueHighlight(capture,issue,effectiveHighlight(capture,issue)===null?paddedHighlight(capture,issue):null);}});
    highlightDetails.appendChild(node("div",{class:"highlight-controls"},[control,node("span",{class:"help",text:"Drag the highlight to move it. Drag the corner handle to resize. Focus either control and use the arrow keys for precise changes."})]));
    body.appendChild(highlightDetails);
  }
  const details=node("details",{},[node("summary",{text:"Technical details"})]);
  const occurrence=issue.occurrences&&issue.occurrences.find(function(item){return item.capture_coordinate_id===capture.coordinate_id;});
  details.appendChild(node("p",{text:"Type "+issue.type+", severity "+issue.severity+", confidence "+confidenceFor(issue)+"."}));
  details.appendChild(node("p",{text:"Element: "+((occurrence&&occurrence.technical_locator)||issue.technical_locator||issue.selector)+((occurrence&&occurrence.other_technical_locator)||issue.other_selector?" and "+((occurrence&&occurrence.other_technical_locator)||issue.other_selector):"")}));
  details.appendChild(node("p",{text:"Summary: "+issue.description}));
  if(issue.occurrences&&issue.occurrences.length>1){const list=node("ul");issue.occurrences.forEach(function(item){list.appendChild(node("li",{text:occurrenceLabel(item,issue)}));});details.appendChild(node("p",{text:"Occurrences ("+issue.occurrences.length+")"}));details.appendChild(list);}
  details.appendChild(node("p",{text:"Full screenshot: "+asset.media_type+", "+asset.byte_length+" bytes, SHA-256 "+asset.sha256}));
  if(crop)details.appendChild(node("p",{text:"Close-up: "+crop.media_type+", "+crop.byte_length+" bytes, SHA-256 "+crop.sha256}));
  body.appendChild(details);
  actions.appendChild(node("button",{text:"Close",onclick:closeDrawer}));
  const saveNote=node("button",{id:"saveNote","data-storage-action":"",text:"Save note",onclick:function(event){setIssueStatus(issue,status,document.getElementById("issueNote").value,event.currentTarget);}});saveNote.hidden=true;saveNote.disabled=!storageAvailable;actions.appendChild(saveNote);
  const dismiss=node("button",{class:"dismiss-choice","data-storage-action":"",id:"dismissIssue",text:status==="dismissed"?"Restore":"Dismiss",onclick:function(event){setIssueStatus(issue,status==="dismissed"?null:"dismissed",document.getElementById("issueNote").value,event.currentTarget);}});dismiss.disabled=!storageAvailable;actions.appendChild(dismiss);
  const add=node("button",{class:"primary export-choice","data-storage-action":"",id:"addToExport",text:status==="export"?"Remove from export":"Add to export",onclick:function(event){setIssueStatus(issue,status==="export"?null:"export",document.getElementById("issueNote").value,event.currentTarget);}});add.disabled=!storageAvailable;actions.appendChild(add);
}
function openExport(trigger) {
  openDrawer("Export","export",trigger);const body=document.getElementById("drawerBody");
  const exported=manifest.issues.filter(function(issue){return issueStatus(issue.id)==="export";});const valid=exported.length>0;
  body.appendChild(node("p",{text:exported.length+" "+(exported.length===1?"issue":"issues")+" in the export."}));
  if(!valid)body.appendChild(node("p",{class:"help",text:"Nothing is in the export yet. Open an issue and choose Add to export."}));
  const list=node("ul",{class:"export-list"});
  exported.forEach(function(issue){const where=issue.capture_coordinate_ids.map(function(id){return manifest.captures.find(function(item){return item.coordinate_id===id;});}).filter(Boolean).map(captureName);const remove=node("button",{class:"quick","data-storage-action":"",text:"Remove","aria-label":"Remove from export: "+issueTitle(issue),onclick:function(event){setIssueStatus(issue,null,undefined,event.currentTarget).then(function(){if(document.getElementById("drawer").open&&drawerMode==="export")openExport(trigger);});}});remove.disabled=!storageAvailable;list.appendChild(node("li",{class:"export-item"},[node("div",{},[node("strong",{text:issueTitle(issue)}),node("p",{class:"help",text:where.join("; ")+(issueNote(issue.id)?" — Note: "+issueNote(issue.id):"")})]),remove]));});
  if(valid)body.appendChild(list);
  const audiences=node("fieldset",{class:"mode-options"},[node("legend",{text:"Who will use this handoff?"})]);
  [["human","Human","Readable list of the selected issues, what was found, and where."],["ai","AI","Structured JSON with locators, rectangles, and screenshot hashes."]].forEach(function(option){const input=node("input",{type:"radio",name:"handoffAudience",value:option[0]});input.checked=option[0]==="human";input.addEventListener("change",updateHandoffAudience);audiences.appendChild(node("label",{class:"mode-choice"},[input,node("strong",{text:option[1]}),node("span",{class:"help",text:option[2]})]));});body.appendChild(audiences);
  const deliveries=node("fieldset",{class:"mode-options"},[node("legend",{text:"How should it be delivered?"})]);
  [["generate","Copy and paste","Generate the handoff here with a Copy action."],["save","Save to file","Write the handoff to the destination path below."]].forEach(function(option){const input=node("input",{type:"radio",name:"handoffMode",value:option[0]});input.checked=option[0]==="generate";input.addEventListener("change",updateHandoffDelivery);deliveries.appendChild(node("label",{class:"mode-choice"},[input,node("strong",{text:option[1]}),node("span",{class:"help",text:option[2]})]));});body.appendChild(deliveries);
  const formats=node("fieldset",{class:"mode-options",id:"handoffFormatChoices",hidden:""},[node("legend",{text:"File format"})]);
  [["txt","TXT","Plain text, the same as copy and paste."],["pdf","PDF","A document with a close-up of every selected issue."]].forEach(function(option){const input=node("input",{type:"radio",name:"handoffFileFormat",value:option[0]});input.checked=option[0]==="txt";input.addEventListener("change",updateHandoffFileFormat);formats.appendChild(node("label",{class:"mode-choice"},[input,node("strong",{text:option[1]}),node("span",{class:"help",text:option[2]})]));});body.appendChild(formats);
  handoffPathEdited=false;const initialPath=adaptHandoffPath(settings.default_handoff_path,"human","txt");const pathInput=node("input",{class:"path-input",id:"handoffPath",type:"text",value:initialPath});pathInput.addEventListener("input",function(){handoffPathEdited=true;});
  const pathWrap=node("div",{class:"handoff-path",id:"handoffPathWrap",hidden:""},[node("label",{class:"text-label",for:"handoffPath",text:"Destination path"}),pathInput,node("p",{class:"help",text:"Use an absolute path. Human TXT uses .txt, Human PDF uses .pdf, and AI uses .json. Until you edit this path, its extension adapts to the selected choices. Existing different content will not be overwritten."})]);body.appendChild(pathWrap);
  body.appendChild(node("div",{id:"exportResult","aria-live":"polite"}));
  const actions=document.getElementById("drawerActions");actions.appendChild(node("button",{text:"Cancel",onclick:closeDrawer}));const create=node("button",{class:"primary","data-storage-action":"",id:"handoffAction",text:"Prepare Human Handoff to Copy and Paste",onclick:runHandoff});create.disabled=!valid||!storageAvailable;actions.appendChild(create);
}
function clearHandoffError() { const existing=document.getElementById("saveError");if(existing)existing.remove(); }
function adaptHandoffPath(path,audience,format) { const extension=audience==="ai"?"json":format;return path.replace(/\\.(json|txt|pdf)$/i,"."+extension); }
function handoffLabel(audience) { return audience==="human"?"Human":"AI"; }
function handoffOutputLabel(audience,mode,format) { if(mode!=="save")return handoffLabel(audience);return audience==="ai"?"AI JSON":"Human "+format.toUpperCase(); }
function handoffActionText(mode,audience,format) { const label=handoffOutputLabel(audience,mode,format);return mode==="save"?"Save "+label+" Handoff to File":"Prepare "+label+" Handoff to Copy and Paste"; }
function updateHandoffChoice() { const mode=document.querySelector('input[name="handoffMode"]:checked').value,audience=document.querySelector('input[name="handoffAudience"]:checked').value,format=document.querySelector('input[name="handoffFileFormat"]:checked').value;clearHandoffError();document.getElementById("handoffPathWrap").hidden=mode!=="save";document.getElementById("handoffFormatChoices").hidden=audience!=="human"||mode!=="save";document.getElementById("handoffAction").textContent=handoffActionText(mode,audience,format);document.getElementById("exportResult").replaceChildren(); }
function updateHandoffAudience() { const audience=document.querySelector('input[name="handoffAudience"]:checked').value,format=document.querySelector('input[name="handoffFileFormat"]:checked').value;if(!handoffPathEdited)document.getElementById("handoffPath").value=adaptHandoffPath(settings.default_handoff_path,audience,format);updateHandoffChoice(); }
function updateHandoffDelivery() { updateHandoffChoice(); }
function updateHandoffFileFormat() { const audience=document.querySelector('input[name="handoffAudience"]:checked').value,format=document.querySelector('input[name="handoffFileFormat"]:checked').value;if(!handoffPathEdited)document.getElementById("handoffPath").value=adaptHandoffPath(settings.default_handoff_path,audience,format);updateHandoffChoice(); }
function setHandoffWorking(working,mode,audience,format) { document.querySelectorAll('input[name="handoffMode"],input[name="handoffAudience"],input[name="handoffFileFormat"]').forEach(function(input){input.disabled=working;});document.getElementById("handoffPath").disabled=working;const button=document.getElementById("handoffAction"),label=handoffOutputLabel(audience,mode,format);button.disabled=working||!storageAvailable;button.textContent=working?(mode==="save"?"Saving "+label+" handoff to file…":"Preparing "+label+" handoff to copy and paste…"):handoffActionText(mode,audience,format);const result=document.getElementById("exportResult");if(working)result.setAttribute("aria-busy","true");else result.removeAttribute("aria-busy"); }
async function copyHandoffContent() { const output=document.getElementById("handoffOutput"),label=handoffLabel(output.dataset.audience);if(!navigator.clipboard){announce("Could not copy "+label+" handoff content");return;}try{await navigator.clipboard.writeText(output.value);const message=label+" handoff copied for copy and paste. No file was saved.";document.getElementById("handoffResultMessage").textContent=message;announce(message);}catch(error){document.getElementById("handoffResultMessage").textContent="Could not copy "+label+" handoff content.";announce("Could not copy "+label+" handoff content");} }
async function runHandoff() { const mode=document.querySelector('input[name="handoffMode"]:checked').value,audience=document.querySelector('input[name="handoffAudience"]:checked').value,format=document.querySelector('input[name="handoffFileFormat"]:checked').value,label=handoffOutputLabel(audience,mode,format),attempt=++handoffAttempt;clearHandoffError();document.getElementById("exportResult").replaceChildren();setHandoffWorking(true,mode,audience,format);announce(mode==="save"?"Saving "+label+" handoff to file":"Preparing "+label+" handoff to copy and paste");const body=mode==="save"?{mode:"save",audience:audience,fileFormat:audience==="human"?format:"json",destinationPath:document.getElementById("handoffPath").value}:{mode:"generate",audience:audience};try{const result=await postJson("api/export",body);if(attempt!==handoffAttempt||drawerMode!=="export"||!document.getElementById("drawer").open)return;if(mode==="generate"){const output=node("textarea",{class:"handoff-output",id:"handoffOutput",readonly:"",wrap:"soft","data-audience":audience,"aria-label":label+" handoff content for copy and paste"});output.value=result.content;const message=label+" handoff generated for copy and paste. No file was saved.";const box=node("div",{class:"success"},[node("strong",{id:"handoffResultMessage",text:message}),output,node("div",{class:"result-actions"},[node("button",{class:"primary",text:"Copy "+label+" Handoff",onclick:copyHandoffContent})])]);document.getElementById("exportResult").replaceChildren(box);announce(message);}else{const message=label+" handoff saved to file.";document.getElementById("exportResult").replaceChildren(node("div",{class:"success"},[node("strong",{text:message}),node("p",{text:result.saved_path})]));announce(label+" handoff saved to "+result.saved_path);} }catch(error){if(attempt!==handoffAttempt||drawerMode!=="export"||!document.getElementById("drawer").open)return;appendError("Could not "+(mode==="save"?"save "+label+" handoff to file. ":"prepare "+label+" handoff to copy and paste. ")+error.message,false);announce("Could not "+(mode==="save"?"save "+label+" handoff to file":"prepare "+label+" handoff to copy and paste"));}finally{if(attempt===handoffAttempt&&drawerMode==="export"&&document.getElementById("drawer").open)setHandoffWorking(false,mode,audience,format);} }
function infoRow(label,value) { return node("div",{class:"info-row"},[node("span",{class:"info-label",text:label}),node("span",{class:"info-value",text:value})]); }
function copyInfoRow(label,value,copyLabel) { const copy=node("button",{class:"copy-info",type:"button",text:"Copy","aria-label":"Copy "+copyLabel});copy.addEventListener("click",async function(){try{if(!navigator.clipboard)throw new Error("Clipboard unavailable");await navigator.clipboard.writeText(value);copy.textContent="Copied";announce(copyLabel+" copied");setTimeout(function(){if(copy.isConnected)copy.textContent="Copy";},1200);}catch(error){announce("Could not copy "+copyLabel);}});return node("div",{class:"info-row"},[node("span",{class:"info-label",text:label}),node("div",{class:"info-value-actions"},[node("span",{class:"info-value",text:value}),copy])]); }
function sourceIdentityRow() { const identity=manifest.source_report.source_sha;if(/^[0-9a-f]{40,64}$/i.test(identity))return copyInfoRow("Source commit",identity,"source commit");return infoRow("Source build",identity==="source-checkout"?"Source checkout (commit unavailable)":"Source identity unavailable"); }
function infoSection(title,rows) { return node("section",{class:"info-section"},[node("h3",{text:title}),node("div",{class:"info-card"},rows)]); }
function openSettings(trigger) {
  openDrawer("Settings","settings",trigger);const body=document.getElementById("drawerBody");
  const counts=statusCounts();
  const captured=new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(report.createdAt));
  body.appendChild(infoSection("Review run",[
    copyInfoRow("Source",report.url,"source URL"),infoRow("Captured",captured),infoRow("Pages",String(manifest.pages.length)),infoRow("Screenshots",String(manifest.captures.length)),infoRow("Issues",manifest.issues.length+" found: "+counts.export+" in export, "+counts.dismissed+" dismissed, "+counts.unreviewed+" to review")
  ]));
  const input=node("input",{class:"path-input",id:"defaultHandoffPath",type:"text",value:settings.default_handoff_path});
  const files=infoSection("Files and storage",[
    infoRow("Decisions","review-state.json in this report directory"),
    infoRow("Exports","Saved only to a destination you choose"),
    node("div",{class:"info-field"},[node("label",{class:"text-label",for:"defaultHandoffPath",text:"Default handoff path"}),input,node("p",{class:"help",text:"Prefills Save to file. Its .txt, .pdf, or .json extension adapts to the selected handoff choices until you edit the destination."})]),
    node("div",{class:"info-field"},[node("strong",{text:"Local-only review"}),node("p",{class:"help",text:"Decisions and exports stay on this machine unless you explicitly copy or save them elsewhere."})])
  ]);body.appendChild(files);
  body.appendChild(node("details",{class:"settings-technical"},[
    node("summary",{text:"Technical details"}),
    node("div",{class:"info-card"},[
      infoRow("Tool",manifest.source_report.tool+" "+manifest.source_report.tool_version),
      infoRow("Report format",manifest.source_report.format_version),
      sourceIdentityRow(),
      copyInfoRow("Exact capture time",report.createdAt,"exact capture time")
    ])
  ]));
  const stop=node("button",{text:"Stop Viewport QA",onclick:stopLocalService});
  const done=node("button",{class:"primary","data-storage-action":"",text:"Done",onclick:saveSettingsAndClose});done.disabled=!storageAvailable;document.getElementById("drawerActions").append(stop,done);
}
async function stopLocalService(){try{await postJson("api/stop",{});document.body.replaceChildren(node("main",{},[node("h1",{text:"Viewport QA stopped"}),node("p",{text:"You can close this tab."})]));}catch(error){appendError("Could not stop Viewport QA. "+error.message,false);}}
async function saveSettingsAndClose() { const input=document.getElementById("defaultHandoffPath");try{settings=await postJson("api/settings",{defaultHandoffPath:input.value});closeDrawer();announce("Settings saved");}catch(error){appendError("Could not save settings. "+error.message,false);input.focus();announce("Could not save settings");} }
function renderMobileFilters(){const body=document.getElementById("drawerBody");body.replaceChildren(filterControls("drawer"));body.appendChild(node("button",{class:"clear",text:"Show All Screenshots",onclick:function(){clearFilters();closeDrawer();}}));}
function openMobileFilters(trigger){openDrawer("Filter screenshots","filters",trigger);renderMobileFilters();document.getElementById("drawerActions").appendChild(node("button",{class:"primary",text:"Show Screenshots",onclick:closeDrawer}));}

document.getElementById("closeDrawer").addEventListener("click",closeDrawer);
document.getElementById("drawer").addEventListener("cancel",function(event){event.preventDefault();closeDrawer();});
document.getElementById("drawer").addEventListener("click",function(event){
  if(drawerClosing||event.target!==this)return;
  const bounds=this.getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeDrawer();
});
document.getElementById("drawer").addEventListener("close",function(){drawerClosing=false;this.classList.remove("opening","closing");if(returnFocus&&returnFocus.isConnected)returnFocus.focus();});
document.getElementById("exportButton").addEventListener("click",function(event){openExport(event.currentTarget);});
document.getElementById("homeButton").addEventListener("click",function(){void navigateToLauncher("home");});
document.getElementById("newReviewButton").addEventListener("click",function(){void navigateToLauncher("new-review");});
document.getElementById("drawerHomeButton").addEventListener("click",function(){void navigateToLauncher("home");});
document.getElementById("drawerNewReviewButton").addEventListener("click",function(){void navigateToLauncher("new-review");});
document.getElementById("settingsButton").addEventListener("click",function(event){openSettings(event.currentTarget);});
document.getElementById("mobileFilterButton").addEventListener("click",function(event){openMobileFilters(event.currentTarget);});
document.getElementById("clearFilters").addEventListener("click",clearFilters);
document.getElementById("zoomFit").addEventListener("click",function(){fit=true;applyZoom();});
document.getElementById("zoomActual").addEventListener("click",function(){fit=false;zoom=1;applyZoom();});
document.getElementById("zoomIn").addEventListener("click",function(){fit=false;zoom=Math.min(1.5,zoom+.25);applyZoom();});
document.getElementById("zoomOut").addEventListener("click",function(){fit=false;zoom=Math.max(.5,zoom-.25);applyZoom();});
document.getElementById("closeLightbox").addEventListener("click",closeLightbox);
document.getElementById("lightboxZoomIn").addEventListener("click",function(){lightboxFit=false;lightboxZoom=Math.min(4,lightboxZoom+.25);updateLightboxZoom();});
document.getElementById("lightboxZoomOut").addEventListener("click",function(){lightboxFit=false;lightboxZoom=Math.max(.1,lightboxZoom-.25);updateLightboxZoom();});
document.getElementById("lightboxActual").addEventListener("click",function(){lightboxFit=false;lightboxZoom=1;updateLightboxZoom();});
document.getElementById("lightboxFit").addEventListener("click",fitLightbox);
document.getElementById("lightbox").addEventListener("keydown",trapLightboxFocus);
document.getElementById("lightbox").addEventListener("click",function(event){if(event.target!==this)return;const bounds=this.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeLightbox();});
document.getElementById("lightbox").addEventListener("close",function(){lightboxAsset=null;if(lightboxReturnFocus&&lightboxReturnFocus.isConnected)lightboxReturnFocus.focus();});
document.getElementById("retryStorage").addEventListener("click",function(){loadReview(true);});
window.addEventListener("resize",function(){if(fit)applyZoom();const dialog=document.getElementById("lightbox");if(dialog.open&&lightboxAsset){if(lightboxFit)fitLightbox();else updateLightboxZoom();}});
async function openOriginalAsset(event){event.preventDefault();const path=event.currentTarget.dataset.assetPath;if(!path)return;try{const url=await secureBlobUrl(path),link=document.createElement("a");link.href=url;link.target="_blank";link.rel="noopener noreferrer";link.click();setTimeout(function(){URL.revokeObjectURL(url);},30000);}catch{announce("Could not open original screenshot");}}
async function loadReview(announceRecovery) { try { const responses=await Promise.all([authorizedFetch("api/review",{cache:"no-store"}),authorizedFetch("api/settings",{cache:"no-store"})]);if(!responses[0].ok||!responses[1].ok)throw new Error("Review storage unavailable");review=await responses[0].json();settings=await responses[1].json();clearStorageError(announceRecovery);render(); } catch(error) { render();showStorageError("Review storage unavailable. Decisions and exports cannot be saved."); } }
document.getElementById("openOriginal").addEventListener("click",openOriginalAsset);
loadReview(false);
`;
