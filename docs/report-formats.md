# Report formats

## Current inventory

| Artifact | Role | Mutability |
| --- | --- | --- |
| `issues.json` | Viewport-specific visual and behaviour records, scenario recipes and attempted steps, cross-viewport presentation groups, page outcomes, screenshot paths, and product/schema versions | Immutable source evidence after publication |
| `agent-summary.json` | Compact, ordered grouped-defect records with urgency kind, viewport range, evidence paths, and reproduction coordinates | Immutable generated navigation aid |
| `review-manifest.json` | Semantic concern families, confidence, occurrences, affected coordinates, and asset identity | Immutable source evidence |
| `screenshots/**` | Full-page PNGs and issue crops | Immutable source evidence |
| `contact-sheet.html` | Script-free grid of report-local full-page screenshots and viewport labels | Immutable generated evidence index |
| `report.html` | Self-contained approved GUI generated from report and manifest | Immutable generated evidence |
| `review-state.json` | Per-issue decisions (in export or dismissed), optional notes, and adjusted highlights, bound to manifest SHA-256 | Mutable review state |
| `review-settings.json` | Report-service handoff preference | Mutable local setting |
| `review-export-identities.json` | Stable export identity records | Mutable append-like state |
| `handoffs/**` or chosen TXT/PDF/JSON | Human or AI handoff output | Derived export |

New reports record the current product version from `version.json`, report format `3`, manifest schema `1`, and review-state schema `2` separately. The compatibility tool identifier remains `viewport-qa`. Format 3 adds structured browser-behaviour findings to the existing `issues` array. Manifest-backed format-2 reports remain openable with their existing review and export behavior, and pre-manifest 0.2-era format-2 reports remain read-only. Reports are not rewritten or migrated when opened.

Format 3 adds these `Issue.type` and matching `Issue.behaviour.kind` values:

- `console-message`: an `error` or `warning`, with its text, source URL, and line number.
- `failed-request`: a request that failed or returned HTTP 4xx/5xx, with method, URL, and either status or failure reason.
- `storage-change`: a cookie name and attributes, or a `localStorage`/`sessionStorage` key observed when it was written, removed, or cleared. Storage values are never present. Cookie attributes are domain, path, expiry, `HttpOnly`, `Secure`, `SameSite`, and the optional partition key supplied by the browser.

These records retain the same deterministic capture ID, viewport, scenario label, screenshot evidence, confidence, and recommendation fields as visual findings. Repeated observations retain their structured behaviour evidence in `occurrences`. Behaviour findings are rule-based and are never sent to a configured model adapter, so their AI recommendation is always unavailable. The static HTML and review GUI separate them under a **Behaviour** heading beside **Visual** findings. Behaviour findings have no editable screenshot highlight. The optional review-manifest `finding_kind` field is `behaviour` or `visual`; schema-1 manifests that predate the field remain readable because the issue type provides the compatibility fallback.

Each `issues` entry remains the authoritative capture record, with its existing deterministic ID, viewport, rectangle, and screenshot paths. A `groups` entry combines records only when page, optional scenario, issue type, identity fingerprint, and message are identical. Visual identity is the semantic element or unordered element-pair fingerprint. Console identity is the distinct message text, failed-request identity is the recorded URL, local/session storage identity is the storage area/key, and cookie identity is its name plus domain, path, and optional partition key. Thus repeated instances within one capture deduplicate and equal findings across viewport captures present as one group, while equal findings on different pages or scenarios remain separate. A group has a deterministic `group-*` ID, the source `issueIds`, and a plain-language `viewportRange`, such as `fails at 768px, clean at 390px and at 1440px and above`. Clean widths come from the complete viewport matrix for that page. Static HTML presents one card per group while retaining the source records in its embedded report data.

For a named-state scan, optional top-level `scenarios` contains the normalized recipe (label, absolute scenario URL, and steps). Every `viewports` capture, source `issues` record, presentation `groups` record, and successful `pages` entry carries `scenarioLabel`. Each viewport also records `scenarioSteps` in execution order: every route fixture installed before navigation, followed by the click/fill/wait prefix attempted in the page. After a failed interaction it does not claim later page interactions ran. A missing role/name target or an actionability failure produces an accurately worded `scenario-step` issue for that viewport and stops only that scenario attempt. The issue, concern, group, capture, and comparison identities include the label, so equal findings from two states of one URL remain distinct. The review manifest maps labels to states, the HTML review groups and filters captures by those state labels, and `contact-sheet.html` renders one labelled section per state.

## `review-state.json`

Schema 2. `artifact_type` is `vq-review-state`; `manifest_id` and `manifest_sha256` bind the file to the exact manifest bytes. `issues` maps a manifest issue id to `{ status, note?, updated_at }` where `status` is `export` or `dismissed`; an issue absent from the map has no decision yet. `highlights` maps a capture coordinate id to a map of issue id to an adjusted rectangle, or `null` for a removed highlight. Detector rectangles in the manifest are never rewritten.

Each manifest occurrence also carries `message`: the detector's exact finding for that capture, with its measurements. Older manifests without it still open; the review falls back to the issue's summary.

## Handoffs

A Human handoff (TXT or PDF) is a numbered list of the issues in the export, most severe first, each with what was found, where it appears, the element, the reviewer note, the suggested fix, and the report-relative screenshot paths. The PDF embeds a close-up per issue and size.

An AI handoff is a `viewport-qa-change-request-bundle`, schema 2: export identity, source report identity, `assets` (hash-named copies referenced by SHA-256), and `items` — one per exported issue with type, severity, confidence, title, description, suggested fix, `reviewer_note`, `selected_at`, and `occurrences` (per capture: page, state, resolution, detected `rect`, `highlight_rect` or `highlight_removed`, `message`, locators, and the full and crop asset hashes). See the [AI consumption contract](AI-CONSUMPTION.md).

## `agent-summary.json`

Every new scan writes schema version 1 beside `issues.json`. The top-level object is:

- `artifactType`: `vqa-agent-summary`
- `schemaVersion`: `1`
- `sourceReport`: `issues.json`
- `defects`: one record per `issues.json.groups` entry, ordered with every `likely-defect` before every `detector-finding`, then by severity and stable group ID

Each defect has `id`, `kind`, finding `type`, `severity`, `confidence`, `message`, optional `scenarioLabel`, the group's plain-language `viewportRange`, and a non-empty `evidence` array. Behaviour groups are included alongside visual groups. Each evidence item has report-relative `screenshot`, optional report-relative `crop`, and `reproduction` containing the captured `url`, optional matching `scenarioLabel`, viewport label, and exact technical locator. Pair findings name both elements; behaviour findings use their source, request, cookie, or storage-key locator. `kind` is derived from the existing confidence semantics: `high` confidence is a `likely-defect`; `needs-confirmation` and `likely-noise` remain `detector-finding` records. This artifact does not replace the capture records or integrity-bearing review manifest.

This is an actual seeded-fixture record; the local checkout prefix in the file URL is shortened to `/workspace/viewport-qa` for portability:

```json
{
  "artifactType": "vqa-agent-summary",
  "schemaVersion": 1,
  "sourceReport": "issues.json",
  "defects": [
    {
      "id": "group-22883f80574f3768b4ef",
      "kind": "likely-defect",
      "type": "clipped-text",
      "severity": "high",
      "confidence": "high",
      "message": "Text is cut off: div#seed-clipped needs 120px but is clipped at 28px (overflow-y: hidden).",
      "viewportRange": "fails at 390px",
      "evidence": [
        {
          "screenshot": "screenshots/390x844@1/full.png",
          "crop": "screenshots/390x844@1/issue-7005d670c8e6bae658f2.png",
          "reproduction": {
            "url": "file:///workspace/viewport-qa/fixtures/seeded-defects.html",
            "viewport": "390x844@1",
            "element": "div#seed-clipped"
          }
        }
      ]
    }
  ]
}
```

`contact-sheet.html` is also produced by every new scan. It has inline CSS, no scripts or external resources, groups captures by scenario label (or page for a plain scan), and references each full-page screenshot by its report-relative path. The browser displays the original images at CSS grid width; no resized image or thumbnail is generated.

`vqa summarize` reads `agent-summary.json` when it is present. For supported grouped reports created before that artifact was introduced, it derives the same schema-1 summary from `issues.json.groups` in memory and does not modify the report.

Stable page IDs derive from final page URL. Capture coordinates derive from page URL, optional scenario label, and viewport dimensions/device scale. Concern-family IDs derive from page, optional scenario label, detector type, and stable semantic element or pair fingerprints; viewport dimensions and rectangles are occurrences, not identity. Presentation grouping does not replace or re-key these manifest concerns. The optional manifest `group_ids` field links a stable concern to the report groups that the review GUI renders, so existing manifest-bound review identity continues to work. The manifest keeps exact technical locators and rectangles while human-facing titles use bounded semantic names. Existing schema-1 manifests without the optional semantic or grouping fields remain readable.

`severity` records impact if a concern is real. `confidence` records how strongly the collected evidence establishes that it is real: `high`, `needs-confirmation`, or `likely-noise`. Only high-confidence concern families cause default capture/run `FAIL`; the other states remain machine suggestions for review.

Unknown report, manifest, or review-state schema versions fail closed. Missing, symlinked, malformed, truncated, re-dimensioned, or hash-mismatched assets are refused. A mismatched review-state manifest ID/hash is not edited.

Manifest-backed format-v2 reports retain their existing supported review behavior. Pre-manifest 0.2-era format-v2 reports remain openable read-only. Neither is converted, edited as a migration, or removed. Any future editable migration must produce a separately validated copy and requires an operator compatibility decision.
