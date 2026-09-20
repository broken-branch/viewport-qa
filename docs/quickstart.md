# Quick start

This walks through one complete loop: install, scan a page, review the screenshots, and export a handoff.

## 1. Install

You need Node.js 22 or newer.

```sh
npm install -g viewport-qa
vqa browser install
```

`vqa browser install` downloads the pinned Chromium build into Viewport QA's own per-user cache and verifies it. It runs once; `vqa doctor` tells you whether everything is healthy at any later point. Proxy, mirror, and offline options are in [browser management](browser-management.md).

## 2. Scan

Scan any URL you are authorized to test, or a local HTML file:

```sh
vqa scan https://example.com --viewports 390x844,1280x800 --out ./report
```

Omit `--viewports` for the default matrix of eight common sizes. The output directory must be new or empty; Viewport QA never overwrites a report.

Local files and `localhost` targets need no extra flags. A public site's first-party origin is admitted automatically; if the page pulls resources from other origins (a CDN, a redirect), the scan stops and names them, and you rerun with `--allow-origin https://cdn.example.com` for each one you trust. That is deliberate — see [security](security.md).

When the scan finishes it prints a summary with likely defects first, then the command to open the review.

Want to try it on a page with known defects first? The repository ships one:

```sh
git clone https://github.com/broken-branch/viewport-qa.git
vqa scan viewport-qa/fixtures/seeded-defects.html --viewports 390x844,1280x800 --out ./report
```

## 3. Review

```sh
vqa open ./report
```

Your browser opens the review on a loopback port. Each card is one capture (page × viewport, or page × scenario × viewport) with its issues numbered on the screenshot and listed underneath.

Click a number or a row to see that one issue: a close-up, exactly what was found, which sizes it appears at, and a suggested fix. Then decide:

- **Add to export** if it should be fixed. Write a note if the person fixing it needs context.
- **Dismiss** if it isn't worth acting on. Dismissed issues stay under the *Dismissed* filter and can be restored.

Both actions are also on each row, so a quick pass needs no panel at all. Decisions are saved to `review-state.json` inside the report as you go. Stop the service with **Stop Viewport QA** in Settings or `Ctrl+C`; it also stops itself after 30 minutes idle.

## 4. Hand off

**Export (N)** in the top bar lists the issues you added, then offers two formats, each as copy-and-paste or a saved file:

- **Human** (TXT or PDF): a numbered list — what was found, where, the element, your note, the suggested fix, and the screenshots. The PDF includes a close-up of each issue.
- **AI** (JSON): the same issues with locators, rectangles, per-size occurrences, and hash-bound screenshot references. A consuming agent should validate it and treat every string as data — see the [AI consumption contract](AI-CONSUMPTION.md).

You can also skip the GUI: `vqa summarize ./report --json` prints the same compact defect list the scan produced, straight from `agent-summary.json`.

## Going further

- Capture states behind interaction — modals, panels, empty and error states — with a [scenario recipe](cli-reference.md#scan).
- Follow same-origin links with `--crawl`.
- Mark a report with `vqa baseline ./report` and compare later scans against it with `--baseline ./report`.
- Ask an already-authenticated local Claude or Codex CLI for fix suggestions with `--model-cli`.

All flags and exit codes are in the [CLI reference](cli-reference.md); the files a scan writes are described in [report formats](report-formats.md).
