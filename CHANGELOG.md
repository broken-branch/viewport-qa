# Changelog

## 0.5.0 — 2026-09-20

First public release, published to npm as `viewport-qa`.

- Review one issue at a time: numbered highlights and a per-screenshot issue list open a panel with that issue's close-up, the detector's exact finding, the sizes it appears at, a suggested fix, and an optional note. **Add to export** and **Dismiss** replace the per-screenshot "Looks good" / change-request flow. `Export (N)` lists what will be handed off. Human TXT/PDF and AI JSON handoffs are built from that list; `review-state.json` is schema 2 and the AI bundle is schema 2.
- Detector false positives found on a real site: fonts checked against the whole stack (every element on a Next.js page), overlaps measured on unclipped boxes, skip links reported as unreachable controls, zero-margin text stacks reported as cramped, and lines estimated from box height.
- `vqa scan example.com` and the launch page accept a bare address; `https://` is inferred (`http://` for loopback).

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
