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
let review = { captures: {} };
let settings = { default_handoff_path:"" };
let zoom = 1;
let fit = false;
let activeId = null;
let selectedReviewIssues = new Set();
let requestWasValid = null;
let draftDirty = false;
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
const selected = { page:new Set(manifest.pages.map(function(item){return item.id;})), scenario:new Set(manifest.states.map(function(item){return item.id;})), resolution:new Set(manifest.captures.map(function(item){return item.resolution.label;})), status:new Set(["unreviewed","good","bad"]) };

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
function statusFor(id) { return review.captures[id] ? review.captures[id].classification : "unreviewed"; }
function statusLabel(value) { return value === "good" ? "Looks good" : value === "bad" ? "Change requested" : "Not reviewed"; }
function pageFor(capture) { return pageById.get(capture.page_id); }
function stateFor(capture) { return stateById.get(capture.state_id); }
function matches(capture) { return selected.page.has(capture.page_id) && (!scenarioEnabled || selected.scenario.has(capture.state_id)) && selected.resolution.has(capture.resolution.label) && selected.status.has(statusFor(capture.coordinate_id)); }
function announce(text) { document.getElementById("liveRegion").textContent = text; }
function captureName(capture) { return pageFor(capture).label + (scenarioEnabled ? " / " + stateFor(capture).label : "") + " / " + capture.resolution.label; }
function confidenceFor(issue) { return issue.confidence || (issue.severity==="high"?"high":"needs-confirmation"); }
function isBehaviourIssue(issue) { return issue.finding_kind==="behaviour" || behaviourTypes.has(issue.type); }
function confidenceLabel(issue) { return ({high:"High confidence","needs-confirmation":"Needs visual confirmation","likely-noise":"Likely intentional/noise"})[confidenceFor(issue)]; }
function affectedSizeLabel(issue) { const labels=issue.capture_coordinate_ids.map(function(id){return manifest.captures.find(function(capture){return capture.coordinate_id===id;});}).filter(Boolean).map(function(capture){return capture.resolution.label;});return Array.from(new Set(labels)).join(", "); }
function presentationGroupsFor(issue) { return (issue.group_ids||[]).map(function(id){return presentationGroupById.get(id);}).filter(Boolean); }
function presentationGroupEvidence(group) { return node("section",{"data-presentation-group":group.id,class:"presentation-group"},[node("p",{text:group.message}),node("p",{class:"issue-range",text:group.viewportRange})]); }
const concernLabels={"page-overflow":"page content spills horizontally","element-overflow":"content spills outside its container",overlap:"visible content overlaps",wrapping:"text wraps poorly","cramped-spacing":"content may be too close together","excessive-gap":"spacing may be unexpectedly large","clipped-text":"text is clipped","offscreen-interactive":"control is outside the reachable area",contrast:"text contrast is too low","font-rendering":"text rendering is broken",color:"text is indistinguishable from its background","scenario-step":"scenario step could not be completed","console-message":"browser console message","failed-request":"failed browser request","storage-change":"browser storage write"};
function containsTechnicalLocator(value,issue){const text=String(value||"");return text.includes(":nth-child(")||text.includes(" > ")||[issue.selector,issue.other_selector,issue.technical_locator].filter(Boolean).some(function(locator){return locator.length>2&&text.includes(locator);});}
function boundedDisplay(value,maximum){const normalized=String(value||"").replace(/\\s+/g," ").trim();return normalized.length<=maximum?normalized:normalized.slice(0,maximum-1).trimEnd()+"…";}
function issueTitle(issue){const title=String(issue.title||"").trim(),name=String(issue.semantic_name||"page content").trim();if(isBehaviourIssue(issue))return boundedDisplay(title||name||concernLabels[issue.type],110);if(title&&!containsTechnicalLocator(title,issue))return boundedDisplay(title,110);return boundedDisplay((!containsTechnicalLocator(name,issue)?name:"page content")+": "+(concernLabels[issue.type]||"visual concern"),110);}
function issueOutcome(issue){const title=issueTitle(issue),rawTitle=String(issue.title||"").trim(),candidates=[issue.observed_outcome,issue.description];for(const candidate of candidates){const text=String(candidate||"").trim();if(text&&text!==title&&text!==rawTitle&&(isBehaviourIssue(issue)||!containsTechnicalLocator(text,issue)))return boundedDisplay(text,240);}return "Machine evidence suggests "+(concernLabels[issue.type]||(isBehaviourIssue(issue)?"browser behaviour":"a visual concern"))+".";}
function behaviourEvidence(item){if(item.kind==="console-message")return item.level+" at "+item.sourceUrl+":"+item.line+": "+item.text;if(item.kind==="failed-request")return item.method+" "+item.url+" "+(item.status===undefined?"failed: "+item.failureReason:"answered "+item.status);if(item.storage==="cookie")return "cookie "+item.name+" for "+item.attributes.domain+item.attributes.path+" (SameSite="+item.attributes.sameSite+", Secure="+item.attributes.secure+", HttpOnly="+item.attributes.httpOnly+", Expires="+item.attributes.expires+")";return item.storage+" key "+item.key;}
function occurrenceLabel(occurrence,issue){const capture=manifest.captures.find(function(item){return item.coordinate_id===occurrence.capture_coordinate_id;}),size=capture?capture.resolution.label:"affected size";if(occurrence.behaviour)return size+": "+boundedDisplay(behaviourEvidence(occurrence.behaviour),240);const primary=isBehaviourIssue(issue)?boundedDisplay(occurrence.semantic_name,72):containsTechnicalLocator(occurrence.semantic_name,issue)?"page content":boundedDisplay(occurrence.semantic_name,72),secondary=occurrence.other_semantic_name&&!containsTechnicalLocator(occurrence.other_semantic_name,issue)?" and "+boundedDisplay(occurrence.other_semantic_name,72):"";return size+": "+primary+secondary;}
function readDraft(id) { try { const drafts=JSON.parse(sessionStorage.getItem(reviewDraftKey)||"{}");return drafts[id]||null; } catch { return null; } }
function clearDraft(id) { try { const drafts=JSON.parse(sessionStorage.getItem(reviewDraftKey)||"{}");delete drafts[id];sessionStorage.setItem(reviewDraftKey,JSON.stringify(drafts)); } catch {} draftDirty=false; }
function persistDraft() { const textarea=document.getElementById("changeMessage");if(!activeId||!textarea)return;const draft={text:textarea.value,affected:Array.from(document.querySelectorAll('input[name="affected"]:checked')).map(function(input){return input.value;}),selected:Array.from(selectedReviewIssues)};try{const drafts=JSON.parse(sessionStorage.getItem(reviewDraftKey)||"{}");drafts[activeId]=draft;sessionStorage.setItem(reviewDraftKey,JSON.stringify(drafts));}catch{}draftDirty=true; }
async function navigateToLauncher(destination) { if(draftDirty){persistDraft();if(!confirm("Your unsaved change-request draft is preserved in this local session. Leave the review now?"))return;}try{await postJson("/api/navigation/"+destination,{});location.reload();}catch(error){announce("Could not return to the launcher");} }

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
    const count = manifest.captures.filter(function(capture) {
      if (facet === "page" && capture.page_id !== value) return false;
      if (facet === "scenario" && capture.state_id !== value) return false;
      if (facet === "resolution" && capture.resolution.label !== value) return false;
      if (facet === "status" && statusFor(capture.coordinate_id) !== value) return false;
      return Object.entries(selected).every(function(entry) {
        const name = entry[0], values = entry[1];
        if (name === facet) return true;
        const candidate = name === "page" ? capture.page_id : name === "scenario" ? capture.state_id : name === "resolution" ? capture.resolution.label : statusFor(capture.coordinate_id);
        return values.has(candidate);
      });
    }).length;
    fieldset.appendChild(node("label", {class:"check"}, [input,node("span",{text:text}),node("span",{class:"count","aria-hidden":"true",text:String(count)})]));
  });
  return fieldset;
}
function filterControls() {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(facetMarkup("status","Status",[["unreviewed","Not reviewed"],["good","Looks good"],["bad","Change requested"]]));
  fragment.appendChild(facetMarkup("page","Page",manifest.pages.map(function(item){return [item.id,item.label];})));
  if(scenarioEnabled) fragment.appendChild(facetMarkup("scenario","Scenario",manifest.states.map(function(item){return [item.id,item.label];})));
  const resolutions = Array.from(new Set(manifest.captures.map(function(item){return item.resolution.label;})));
  fragment.appendChild(facetMarkup("resolution","Screen size",resolutions.map(function(item){return [item,item];})));
  return fragment;
}
function clearFilters() {
  selected.page = new Set(manifest.pages.map(function(item){return item.id;}));
  selected.scenario = new Set(manifest.states.map(function(item){return item.id;}));
  selected.resolution = new Set(manifest.captures.map(function(item){return item.resolution.label;}));
  selected.status = new Set(["unreviewed","good","bad"]);
  render(); announce("Showing all screenshots");
}
function paddedHighlight(capture,issue) {
  const detected=issue.rects&&issue.rects[capture.coordinate_id];if(!detected)return null;
  const x=Math.max(0,detected.x-8),y=Math.max(0,detected.y-8),right=Math.min(capture.resolution.width,detected.x+detected.width+8),bottom=Math.min(capture.resolution.height,detected.y+detected.height+8);
  return {x:x,y:y,width:right-x,height:bottom-y};
}
function effectiveHighlight(capture,issue) {
  const overrides=review.captures[capture.coordinate_id]&&review.captures[capture.coordinate_id].issue_highlights;
  return overrides&&Object.prototype.hasOwnProperty.call(overrides,issue.id)?overrides[issue.id]:paddedHighlight(capture,issue);
}
function markerFor(capture,issueId) {
  const issue = issueById.get(issueId||capture.issue_ids[0]);
  if (issue && isBehaviourIssue(issue)) return undefined;
  const rect = issue ? effectiveHighlight(capture,issue) : undefined;
  if (!issue || !rect) return undefined;
  return node("button", {class:"issue-marker","data-issue-marker":issue.id,style:"left:"+rect.x+"px;top:"+rect.y+"px;width:"+rect.width+"px;height:"+rect.height+"px","aria-label":"Open issue: "+issueTitle(issue),onclick:function(event){openReview(capture.coordinate_id,event.currentTarget);}});
}
function imageButton(asset, alt, label, width, height, className) {
  const imageAttributes={src:asset.source_relative_path,alt:alt,loading:"lazy"};
  if(width) imageAttributes.width=String(width); if(height) imageAttributes.height=String(height);
  const button=node("button",{class:"image-open"+(className?" "+className:""),"aria-label":label},[node("img",imageAttributes)]);
  button.addEventListener("click",function(){openLightbox(asset,alt,label,button,width,height);});
  return button;
}
function captureCard(capture, grouped) {
  const page = pageFor(capture), state = stateFor(capture), asset = assetById.get(capture.full_asset_id), status = statusFor(capture.coordinate_id);
  const prominentIssueIds=capture.issue_ids.filter(function(issueId){const issue=issueById.get(issueId);return !isBehaviourIssue(issue)&&confidenceFor(issue)==="high";});
  const condition = scenarioEnabled ? ", "+state.label+" scenario" : "";
  const alt=page.label+" page"+condition+", "+capture.resolution.label+" screenshot";
  const imageControl=imageButton(asset,alt,"Open "+captureName(capture)+" screenshot",capture.resolution.width,capture.resolution.height);
  const stage = node("div", {class:"image-stage","data-width":String(capture.resolution.width),"data-height":String(capture.resolution.height)}, [imageControl]);
  prominentIssueIds.forEach(function(issueId){const marker=markerFor(capture,issueId);if(marker)stage.appendChild(marker);});
  const openImage=node("button",{class:"details-button",text:"Open Image",onclick:function(){openLightbox(asset,alt,"Open "+captureName(capture)+" screenshot",imageControl,capture.resolution.width,capture.resolution.height);}});
  const issueButton = capture.issue_ids.length ? node("button", {class:"details-button",text:prominentIssueIds.length?"View Concern":"Review Suggestions",onclick:function(event){openReview(capture.coordinate_id,event.currentTarget);}}) : null;
  const good = node("button", {class:"good-choice","data-storage-action":"",text:prominentIssueIds.length?"Ignore Concern":"Looks Good","aria-pressed":String(status === "good"),onclick:function(event){saveClassification(capture,"good",event.currentTarget);}});good.disabled=!storageAvailable;
  const bad = node("button", {class:"bad-choice","data-storage-action":"",text:"Request Changes","aria-pressed":String(status === "bad"),onclick:function(event){openReview(capture.coordinate_id,event.currentTarget);}});bad.disabled=!storageAvailable;
  const actions=[openImage];if(issueButton)actions.push(issueButton);actions.push(node("span",{class:"spacer"}),good,bad);
  return node("article", {class:"capture","data-capture":capture.coordinate_id}, [
    node("header",{class:"capture-head"},[node("div",{},[node(grouped?"h3":"h2",{class:"capture-title",text:page.label+(scenarioEnabled?" / "+state.label:"")}),node("div",{class:"capture-path",text:capture.resolution.label})]),node("span",{class:"status "+status,text:statusLabel(status)})]),
    node("div",{class:"canvas",tabindex:"0","data-label":captureName(capture)+" screenshot canvas","aria-label":captureName(capture)+" screenshot canvas — Actual size at 100%"},[stage]),
    node("footer",{class:"capture-actions"},actions)
  ]);
}
function applyZoom() {
  document.querySelectorAll(".capture").forEach(function(card) {
    const canvas = card.querySelector(".canvas"), stage = card.querySelector(".image-stage"), nativeWidth = Number(stage.dataset.width),nativeHeight=Number(stage.dataset.height),style=getComputedStyle(canvas);
    const availableWidth=canvas.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),availableHeight=canvas.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    const scale = fit ? Math.max(.05,Math.min(1,availableWidth/nativeWidth,availableHeight/nativeHeight)) : zoom;
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
function updateProgress() {
  const reviewed = manifest.captures.filter(function(capture){return statusFor(capture.coordinate_id)!=="unreviewed";}).length;
  const requests = Object.values(review.captures).filter(function(item){return item.classification==="bad" && item.requested_change;}).length;
  document.getElementById("progress").textContent = reviewed+" of "+manifest.captures.length+" reviewed";
  document.getElementById("exportCount").textContent = "("+requests+")";
  document.getElementById("exportButton").setAttribute("aria-label","Export changes, "+requests+" "+(requests===1?"request":"requests"));
}
function updateStorageControls() { document.querySelectorAll("[data-storage-action]").forEach(function(control){control.disabled=!storageAvailable;}); }
function showStorageError(message) { storageAvailable=false;const error=document.getElementById("storageError");document.getElementById("storageErrorText").textContent=message;error.hidden=false;updateStorageControls();announce(message); }
function clearStorageError(announceRecovery) { storageAvailable=true;document.getElementById("storageError").hidden=true;updateStorageControls();if(announceRecovery)announce("Review storage connected. Saving and export are available."); }
function render() {
  const filters = document.getElementById("desktopFilters"); filters.replaceChildren(filterControls());
  if (drawerMode === "filters" && document.getElementById("drawer").open) renderMobileFilters();
  const visible = manifest.captures.filter(matches), list = document.getElementById("captureList"); list.replaceChildren();
  document.getElementById("filterSummary").textContent = visible.length===manifest.captures.length ? "Showing all "+manifest.captures.length+" screenshots" : "Showing "+visible.length+" of "+manifest.captures.length+" screenshots";
  const high=manifest.issues.filter(function(issue){return confidenceFor(issue)==="high";}).length,confirmation=manifest.issues.filter(function(issue){return confidenceFor(issue)==="needs-confirmation";}).length,noise=manifest.issues.filter(function(issue){return confidenceFor(issue)==="likely-noise";}).length;
  document.getElementById("resultsSummary").textContent = high+" high-confidence "+(high===1?"concern":"concerns")+", "+confirmation+" to confirm, "+noise+" likely noise. "+visible.length+" "+(visible.length===1?"screenshot":"screenshots")+" match your filters.";
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
async function saveClassification(capture, classification, trigger) {
  try {
    review = await postJson("api/review",{coordinateId:capture.coordinate_id,classification:classification});
    render();
    requestAnimationFrame(function(){const replacement=document.querySelector('[data-capture="'+capture.coordinate_id+'"] [class="'+(classification==="good"?"good-choice":"bad-choice")+'"]');(replacement||document.getElementById("resultsSummary")).focus();});
    announce("Marked "+statusLabel(classification)+". "+captureName(capture)+".");
  } catch (error) { trigger.focus(); showStorageError("Review storage unavailable. Feedback and exports cannot be saved."); }
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
  const card=document.querySelector('[data-capture="'+CSS.escape(capture.coordinate_id)+'"]');if(card){card.querySelector('[data-issue-marker="'+CSS.escape(issue.id)+'"]')?.remove();const marker=markerFor(capture,issue.id);if(marker)card.querySelector(".image-stage").appendChild(marker);}
}
async function persistIssueHighlight(intent,queue) { const capture=intent.capture,issue=intent.issue,rect=intent.rect,scrollState=intent.scrollState,drawerBody=document.getElementById("drawerBody"),imageViewport=drawerBody&&drawerBody.querySelector(".drawer-image");try { review=await postJson("api/review",{coordinateId:capture.coordinate_id,highlightIssueId:issue.id,highlightRect:rect});if(queue.pending)return;refreshHighlight(capture,issue);if(scrollState&&document.getElementById("drawer").open&&drawerMode==="review"){const editor=document.querySelector('[data-highlight-editor="'+CSS.escape(issue.id)+'"]'),next=intent.focusTarget==="resize"&&editor?editor.querySelector(".highlight-resize"):editor;if(next){next.focus({preventScroll:true});drawerBody.scrollTop=scrollState.body;if(imageViewport){imageViewport.scrollTop=scrollState.imageTop;imageViewport.scrollLeft=scrollState.imageLeft;}window.scrollTo(scrollState.windowX,scrollState.windowY);}}announce(rect?"Highlight updated for "+issueTitle(issue):"Highlight removed for "+issueTitle(issue));}catch(error){appendError("Could not save highlight. "+error.message,false);announce("Could not save highlight");} }
function saveIssueHighlight(capture,issue,rect,focusTarget) { const key=capture.coordinate_id+"\u0000"+issue.id,drawerBody=document.getElementById("drawerBody"),imageViewport=drawerBody&&drawerBody.querySelector(".drawer-image"),intent={capture:capture,issue:issue,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,focusTarget:focusTarget,scrollState:focusTarget?{body:drawerBody.scrollTop,imageTop:imageViewport?imageViewport.scrollTop:0,imageLeft:imageViewport?imageViewport.scrollLeft:0,windowX:window.scrollX,windowY:window.scrollY}:null};let queue=highlightSaveQueues.get(key);if(!queue){queue={running:false,pending:null};highlightSaveQueues.set(key,queue);}queue.pending=intent;if(queue.running)return;queue.running=true;(async function(){while(queue.pending){const next=queue.pending;queue.pending=null;await persistIssueHighlight(next,queue);}queue.running=false;highlightSaveQueues.delete(key);})(); }
function appendFindingDetails(body,title,items) {
  body.appendChild(node("h3",{text:title}));
  if(!items.length){body.appendChild(node("p",{class:"help",text:"No "+title.toLowerCase()+" findings for this screenshot."}));return;}
  items.forEach(function(issue){const confidence=confidenceFor(issue),count=issue.occurrence_count||issue.capture_coordinate_ids.length,groups=presentationGroupsFor(issue);const details=node("details",{class:"issue-box "+confidence,...(confidence==="high"?{open:""}:{})},[node("summary",{text:issueTitle(issue)}),node("p",{class:"issue-meta",text:confidenceLabel(issue)+" · 1 concern across "+issue.capture_coordinate_ids.length+" "+(issue.capture_coordinate_ids.length===1?"size":"sizes")+" · "+count+" "+(count===1?"occurrence":"occurrences")}),node("p",{text:issueOutcome(issue)}),...(groups.length?groups.map(presentationGroupEvidence):[node("p",{text:"Affected sizes: "+affectedSizeLabel(issue)})]),node("p",{text:"Impact if confirmed: "+issue.severity+" severity."})]);if(issue.confidence_reasons&&issue.confidence_reasons.length){const reasons=node("ul");issue.confidence_reasons.forEach(function(reason){reasons.appendChild(node("li",{text:reason}));});details.appendChild(reasons);}if(issue.occurrences&&issue.occurrences.length){const occurrenceList=node("ul");issue.occurrences.forEach(function(occurrence){occurrenceList.appendChild(node("li",{text:occurrenceLabel(occurrence,issue)}));});details.appendChild(node("details",{},[node("summary",{text:"Occurrences ("+issue.occurrences.length+")"}),occurrenceList]));}body.appendChild(details);});
}
function openReview(id, trigger) {
  activeId=id; const capture=manifest.captures.find(function(item){return item.coordinate_id===id;});
  const page=pageFor(capture), state=stateFor(capture), asset=assetById.get(capture.full_asset_id), saved=review.captures[id]&&review.captures[id].requested_change,draft=readDraft(id);
  selectedReviewIssues=new Set(draft?draft.selected:(saved?saved.selected_issue_ids||[]:[]));
  draftDirty=Boolean(draft);
  requestWasValid=null;
  openDrawer("Review this screenshot","review",trigger);
  const body=document.getElementById("drawerBody"); body.appendChild(node("p",{},[node("strong",{text:captureName(capture)})]));
  body.appendChild(node("p",{class:"help",text:"These are machine-generated review leads, not approved work. High-confidence concerns appear first; expand any group for evidence."}));
  const captureIssues=capture.issue_ids.map(function(issueId){return issueById.get(issueId);}).filter(Boolean);
  appendFindingDetails(body,"Visual",captureIssues.filter(function(issue){return !isBehaviourIssue(issue);}));
  appendFindingDetails(body,"Behaviour",captureIssues.filter(isBehaviourIssue));
  const fullAlt="Full "+page.label+(scenarioEnabled?", "+state.label+" scenario":"")+" screenshot at "+capture.resolution.label;
  const highlightStage=node("div",{class:"highlight-stage","data-highlight-stage":capture.coordinate_id},[imageButton(asset,fullAlt,"Open full "+captureName(capture)+" screenshot",capture.resolution.width,capture.resolution.height)]);captureIssues.filter(function(issue){return !isBehaviourIssue(issue);}).forEach(function(issue){addHighlightEditor(highlightStage,capture,issue);});body.appendChild(node("div",{class:"drawer-image"},[highlightStage]));
  captureIssues.filter(function(issue){return !isBehaviourIssue(issue);}).forEach(function(issue){const removed=effectiveHighlight(capture,issue)===null;const control=node("button",{type:"button","data-highlight-control":issue.id,text:removed?"Restore Highlight":"Remove Highlight","aria-label":(removed?"Restore":"Remove")+" highlight for "+issueTitle(issue),onclick:function(){saveIssueHighlight(capture,issue,effectiveHighlight(capture,issue)===null?paddedHighlight(capture,issue):null);}});body.appendChild(node("div",{class:"highlight-controls"},[control,node("span",{class:"help",text:"Drag the highlight to move it. Drag the corner handle to resize. Focus either control and use the arrow keys for precise changes."})]));});
  capture.issue_ids.forEach(function(issueId){const issue=issueById.get(issueId),occurrence=issue.occurrences&&issue.occurrences.find(function(item){return item.capture_coordinate_id===capture.coordinate_id;}),cropId=occurrence&&occurrence.crop_asset_id?occurrence.crop_asset_id:issue.crop_asset_id;if(cropId){const crop=assetById.get(cropId);if(crop)body.appendChild(imageButton(crop,"Issue close-up for "+issueTitle(issue),"Open issue close-up for "+issueTitle(issue),undefined,undefined,"crop-open"));}});
  body.appendChild(node("label",{class:"text-label",for:"changeMessage",text:"What useful outcome should change?"}));
  const textarea=node("textarea",{id:"changeMessage"}); textarea.value=draft?draft.text:(saved?saved.requested_change:"");textarea.addEventListener("input",function(){persistDraft();updateRequestValidity(true);}); body.appendChild(textarea);
  body.appendChild(node("p",{class:"help request-guidance",id:"requestGuidance",role:"status","aria-live":"polite",tabindex:"-1",text:"Write a reviewer-approved outcome in at least three words. Attaching a suggestion alone does not approve it."}));
  body.appendChild(node("h3",{text:"Applies to"})); body.appendChild(node("p",{class:"help",text:"The current screenshot is selected. Add screenshots only when the same change applies."}));
  const selection=node("div",{class:"selection-list"});
  manifest.captures.forEach(function(candidate){const input=node("input",{type:"checkbox",name:"affected",value:candidate.coordinate_id});input.checked=candidate.coordinate_id===id || Boolean(draft?draft.affected.includes(candidate.coordinate_id):saved&&saved.affected_coordinate_ids.includes(candidate.coordinate_id));input.disabled=candidate.coordinate_id===id;input.addEventListener("change",function(){renderApplicableIssues();persistDraft();});selection.appendChild(node("label",{class:"check"},[input,node("span",{text:captureName(candidate)+(candidate.coordinate_id===id?" (current)":"")})]));}); body.appendChild(selection);
  body.appendChild(node("h3",{text:"Machine suggestions to promote"}));
  body.appendChild(node("p",{class:"help",text:"Checking a group attaches its evidence. It becomes reviewer-approved work only when you save it with the written outcome above."}));
  const issueSelection=node("div",{class:"selection-list",id:"issueSelection"});
  body.appendChild(issueSelection);renderApplicableIssues();
  const details=node("details",{},[node("summary",{text:"Technical details"})]);
  capture.issue_ids.forEach(function(issueId){const issue=issueById.get(issueId);const occurrence=issue.occurrences&&issue.occurrences.find(function(item){return item.capture_coordinate_id===capture.coordinate_id;});const cropId=occurrence&&occurrence.crop_asset_id?occurrence.crop_asset_id:issue.crop_asset_id;const crop=cropId?assetById.get(cropId):undefined;details.appendChild(node("p",{text:issue.type+", severity "+issue.severity+", confidence "+confidenceFor(issue)+". Technical locator: "+(occurrence&&occurrence.technical_locator||issue.technical_locator||issue.selector)}));details.appendChild(node("p",{text:"Machine suggestion: "+issue.heuristic_suggestion}));details.appendChild(node("p",{text:"Recommendation source: "+(issue.ai_recommendation_status.status==="ok"?"AI recommendation from "+issue.ai_recommendation_status.model:"Rule-based finding; AI unavailable: "+issue.ai_recommendation_status.reason)}));if(crop)details.appendChild(node("p",{text:"Close-up: "+crop.media_type+", "+crop.byte_length+" bytes, SHA-256 "+crop.sha256}));});
  details.appendChild(node("p",{text:"Full screenshot: "+asset.media_type+", "+asset.byte_length+" bytes, SHA-256 "+asset.sha256})); body.appendChild(details);
  const actions=document.getElementById("drawerActions");actions.appendChild(node("button",{text:"Cancel",onclick:closeDrawer}));const save=node("button",{class:"primary","data-storage-action":"",id:"saveRequest",text:"Save Change Request",onclick:saveRequest});save.disabled=!storageAvailable;actions.appendChild(save);updateRequestValidity(false);
}
async function saveRequest() {
  const textarea=document.getElementById("changeMessage"), text=textarea.value.trim();
  const affected=Array.from(document.querySelectorAll('input[name="affected"]:checked')).map(function(input){return input.value;}); if(!affected.includes(activeId)) affected.push(activeId);
  const selectedIssues=Array.from(document.querySelectorAll('input[name="selectedIssue"]:checked:not(:disabled)')).map(function(input){return input.value;});
  if(!usefulOutcome(text)){const guidance=document.getElementById("requestGuidance");guidance.classList.add("invalid");guidance.textContent="Write a useful reviewer-approved outcome in at least three words before saving.";guidance.focus();announce(guidance.textContent);return;}
  try { review=await postJson("api/review",{coordinateId:activeId,classification:"bad",requestedChange:text,affectedCoordinateIds:affected,selectedIssueIds:selectedIssues}); clearDraft(activeId);closeDrawer(); render(); requestAnimationFrame(function(){const target=document.querySelector('[data-capture="'+activeId+'"] .bad-choice')||document.getElementById("resultsSummary");target.focus();}); announce("Reviewer-approved work saved. Marked Change requested."); }
  catch(error){appendError("Could not save. Your text is still here. Retry after reconnecting storage. "+error.message,true);textarea.focus();showStorageError("Review storage unavailable. Feedback and exports cannot be saved.");}
}
function openExport(trigger) {
  openDrawer("Export reviewer-approved work","export",trigger);const body=document.getElementById("drawerBody");const bad=manifest.captures.filter(function(capture){return statusFor(capture.coordinate_id)==="bad";});let valid=true;
  body.appendChild(node("p",{text:bad.length+" reviewer-approved "+(bad.length===1?"change":"changes")}));
  bad.forEach(function(capture){const request=review.captures[capture.coordinate_id].requested_change;const section=node("section",{class:"export-item"},[node("strong",{text:captureName(capture)})]);if(request&&usefulOutcome(request.requested_change)){section.appendChild(node("p",{text:request.requested_change}));const list=node("ul");request.affected_coordinate_ids.forEach(function(id){const item=manifest.captures.find(function(candidate){return candidate.coordinate_id===id;});list.appendChild(node("li",{text:captureName(item)}));});section.appendChild(list);}else{valid=false;section.appendChild(node("p",{class:"error-summary",text:"Add a useful reviewer-authored outcome before export. Machine suggestions alone are not approved work."}));}body.appendChild(section);});
  if(!bad.length) valid=false;
  const audiences=node("fieldset",{class:"mode-options"},[node("legend",{text:"Who will use this handoff?"})]);
  [["human","Human","Useful review context without internal technical evidence."],["ai","AI","Structured JSON with the full technical context."]].forEach(function(option){const input=node("input",{type:"radio",name:"handoffAudience",value:option[0]});input.checked=option[0]==="human";input.addEventListener("change",updateHandoffAudience);audiences.appendChild(node("label",{class:"mode-choice"},[input,node("strong",{text:option[1]}),node("span",{class:"help",text:option[2]})]));});body.appendChild(audiences);
  const deliveries=node("fieldset",{class:"mode-options"},[node("legend",{text:"How should it be delivered?"})]);
  [["generate","Copy and paste","Generate a readable, selectable handoff here with a Copy action."],["save","Save to file","Write the handoff to the destination path below."]].forEach(function(option){const input=node("input",{type:"radio",name:"handoffMode",value:option[0]});input.checked=option[0]==="generate";input.addEventListener("change",updateHandoffDelivery);deliveries.appendChild(node("label",{class:"mode-choice"},[input,node("strong",{text:option[1]}),node("span",{class:"help",text:option[2]})]));});body.appendChild(deliveries);
  const formats=node("fieldset",{class:"mode-options",id:"handoffFormatChoices",hidden:""},[node("legend",{text:"File format"})]);
  [["txt","TXT","Plain text matching Human copy and paste exactly."],["pdf","PDF","A formatted document with the affected screenshots."]].forEach(function(option){const input=node("input",{type:"radio",name:"handoffFileFormat",value:option[0]});input.checked=option[0]==="txt";input.addEventListener("change",updateHandoffFileFormat);formats.appendChild(node("label",{class:"mode-choice"},[input,node("strong",{text:option[1]}),node("span",{class:"help",text:option[2]})]));});body.appendChild(formats);
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
  const reviewed=manifest.captures.filter(function(capture){return statusFor(capture.coordinate_id)!=="unreviewed";}).length;
  const captured=new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(report.createdAt));
  body.appendChild(infoSection("Review run",[
    copyInfoRow("Source",report.url,"source URL"),infoRow("Captured",captured),infoRow("Pages",String(manifest.pages.length)),infoRow("Screenshots",String(manifest.captures.length)),infoRow("Review progress",reviewed+" of "+manifest.captures.length+" reviewed")
  ]));
  const input=node("input",{class:"path-input",id:"defaultHandoffPath",type:"text",value:settings.default_handoff_path});
  const files=infoSection("Files and storage",[
    infoRow("Feedback","review-state.json in this report directory"),
    infoRow("Exports","Saved only to a destination you choose"),
    node("div",{class:"info-field"},[node("label",{class:"text-label",for:"defaultHandoffPath",text:"Default handoff path"}),input,node("p",{class:"help",text:"Prefills Save to file. Its .txt, .pdf, or .json extension adapts to the selected handoff choices until you edit the destination."})]),
    node("div",{class:"info-field"},[node("strong",{text:"Local-only review"}),node("p",{class:"help",text:"Review feedback and exports stay on this machine unless you explicitly copy or save them elsewhere."})])
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
function usefulOutcome(value){const text=value.trim();return text.length>=12&&text.split(/\\s+/).filter(Boolean).length>=3&&/[a-z]/i.test(text);}
function updateRequestValidity(announceChange){const textarea=document.getElementById("changeMessage"),save=document.getElementById("saveRequest"),guidance=document.getElementById("requestGuidance");if(!textarea||!guidance)return;const valid=usefulOutcome(textarea.value);if(save){save.dataset.requestValid=String(valid);save.setAttribute("aria-describedby","requestGuidance");}guidance.classList.toggle("invalid",!valid);guidance.textContent=valid?(selectedReviewIssues.size?"The written outcome and selected groups will become Reviewer-approved work when saved.":"The written outcome will become Reviewer-approved work when saved."):"Write a reviewer-approved outcome in at least three words. Attaching a suggestion alone does not approve it.";if(announceChange&&requestWasValid===true&&!valid)announce(guidance.textContent);requestWasValid=valid;}
function renderApplicableIssues(){const list=document.getElementById("issueSelection");if(!list)return;const affected=new Set(Array.from(document.querySelectorAll('input[name="affected"]:checked')).map(function(input){return input.value;}));const applicableIds=new Set(manifest.captures.filter(function(capture){return affected.has(capture.coordinate_id);}).flatMap(function(capture){return capture.issue_ids;}));selectedReviewIssues.forEach(function(id){if(!applicableIds.has(id))selectedReviewIssues.delete(id);});const applicable=manifest.issues.filter(function(issue){return applicableIds.has(issue.id);}).sort(function(left,right){const rank={high:0,"needs-confirmation":1,"likely-noise":2};return rank[confidenceFor(left)]-rank[confidenceFor(right)]||issueTitle(left).localeCompare(issueTitle(right));});list.replaceChildren();if(!applicable.length){list.appendChild(node("p",{class:"help",text:"No machine suggestions apply to the selected screenshots."}));updateRequestValidity(true);return;}applicable.forEach(function(issue){const input=node("input",{type:"checkbox",name:"selectedIssue",value:issue.id});input.checked=selectedReviewIssues.has(issue.id);input.addEventListener("change",function(){if(input.checked)selectedReviewIssues.add(issue.id);else selectedReviewIssues.delete(issue.id);persistDraft();updateRequestValidity(true);});list.appendChild(node("label",{class:"check"},[input,node("div",{},[node("span",{text:issueTitle(issue)}),node("div",{class:"help",text:confidenceLabel(issue)+" · "+affectedSizeLabel(issue)})]) ]));});updateRequestValidity(true);}
function renderMobileFilters(){const body=document.getElementById("drawerBody");body.replaceChildren(filterControls());body.appendChild(node("button",{class:"clear",text:"Show All Screenshots",onclick:function(){clearFilters();closeDrawer();}}));}
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
async function loadReview(announceRecovery) { try { const responses=await Promise.all([authorizedFetch("api/review",{cache:"no-store"}),authorizedFetch("api/settings",{cache:"no-store"})]);if(!responses[0].ok||!responses[1].ok)throw new Error("Review storage unavailable");review=await responses[0].json();settings=await responses[1].json();clearStorageError(announceRecovery);render(); } catch(error) { render();showStorageError("Review storage unavailable. Feedback and exports cannot be saved."); } }
document.getElementById("openOriginal").addEventListener("click",openOriginalAsset);
loadReview(false);
`;
