# Changelog

## 0.5.0 — 2026-09-20

First public release, published to npm as `viewport-qa`.

- Review one issue at a time: numbered highlights and a per-screenshot issue list open a panel with that issue's close-up, the detector's exact finding, the sizes it appears at, a suggested fix, and an optional note. **Add to export** and **Dismiss** replace the per-screenshot "Looks good" / change-request flow. `Export (N)` lists what will be handed off. Human TXT/PDF and AI JSON handoffs are built from that list; `review-state.json` is schema 2 and the AI bundle is schema 2.
- Detector false positives found on a real site: fonts checked against the whole stack (every element on a Next.js page), overlaps measured on unclipped boxes, skip links reported as unreachable controls, zero-margin text stacks reported as cramped, and lines estimated from box height.
- `vqa scan example.com` and the launch page accept a bare address; `https://` is inferred (`http://` for loopback).
- Scans ordinary live sites: a page loads from any public origin as it would in a browser, redirects are followed, unsupported schemes are dropped quietly, and a request the page itself cancelled no longer fails the scan. `--strict` keeps the allowlist behaviour. The launch page no longer stops to approve origins.
- Before capture, the page is scrolled once to trigger lazy loads and scroll-reveal animations, with reduced motion and instant transitions so captures show the settled page.
- Captures are chosen by device: mobile, tablet, and desktop, each with its common sizes (ten in all, replacing the flat list of eight, which included a `390x844@3` DPR variant). `vqa scan --devices mobile,desktop` picks classes; the launch page picks devices first, then the sizes within each. Every capture is labelled with its class, in the review, the contact sheet, and handoffs ("Mobile 390×844"), and reports record it as `viewport.device`.
- Layered-for-effect compositions are not defects: text or a control over a photo (no overlap, no contrast check), a modal's scroll lock, and controls parked far off-canvas.
- More detector noise removed on real pages: elements under an opacity-0 ancestor are not visible, a fixed overlay never "overlaps" the page beneath it, overflow only counts when it is painted outside the box, and requests the browser aborted are not failed requests.

- Renamed from the private "Visual QA Review" project. Reports now record `tool: "viewport-qa"`; the per-user cache moved to `~/.cache/viewport-qa` (Linux), `~/Library/Caches/Viewport QA` (macOS), and `%LOCALAPPDATA%\Viewport QA` (Windows). The `vqa` command and every `VQA_*` environment variable are unchanged.
- The origin named in the target URL is admitted automatically; `--allow-origin` is needed only for redirect and third-party resource origins. Every other restricted-mode guard is unchanged.
- Removed the private desktop packaging (RPM, DEB, DMG, Inno Setup), portable-bundle builders, and private-release workflows. Distribution is the npm package.
- MIT license.

## Before 0.5.0

Developed privately between July and September 2026 as "Visual QA Review" (versions 0.2 to 0.4.0-rc.1). In rough order:

- Rule-based detectors over painted layout: overflow, clipped text, wrapping, overlap, offscreen controls, spacing; then contrast, colour, and font rendering.
- Manifest-backed reports with hash-bound review state, the loopback review GUI, and human TXT/PDF and AI JSON handoffs.
- Baselines and diffs; same-origin crawl; optional `--model-cli` fix suggestions through a local Claude or Codex CLI.
- Managed Chromium cache with atomic install, repair, and remove; `vqa doctor`.
- Restricted target policy: loopback and local files by default, exact-origin admission, private-address rejection, download and redirect guards.
- `vqa launch` start page for scanning without a terminal.
- Paint-visibility filter so unpainted DOM never produces findings; cross-viewport grouping with a plain-language viewport range.
- `agent-summary.json`, `vqa summarize`, and `contact-sheet.html`.
- Named scenario recipes (`--scenarios`) with click, fill, waitFor, and route steps.
- Behaviour capture: console errors and warnings, failed requests, cookie and storage key names (never values).
