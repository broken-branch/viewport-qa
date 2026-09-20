# CLI reference

Run `vqa --help` for the mechanically current summary.

## `doctor`

```text
vqa doctor [--json]
```

Reports product/Node identity, OS/architecture, cache path, pinned Playwright version, exact Chromium version/revision, payload choice, health, size, and safe remediation. It never installs packages or elevates.

## `browser`

```text
vqa browser status|install|repair|remove [--json]
```

`install` is explicit and atomic; an already healthy revision is reused. `repair` stages and validates a replacement before promotion. `remove` is confined to the current Viewport-QA-owned revision. Upgrade/downgrade installation garbage-collects only inactive complete managed revisions. See [browser management](browser-management.md).

## `scan`

```text
vqa scan <url-or-file> [--viewports WxH[@DPR],...] [--out <dir>]
  [--timeout <ms>] [--baseline <report-dir>] [--scenarios <file>] [--crawl]
  [--max-pages <n>] [--max-depth <n>]
  [--strict] [--allow-origin <exact-http-origin>]...
  [--model-cli codex|claude] [--model-cli-bin <path>]
  [--model-cli-timeout <ms>]
```

The default output is `./vqa-report`. The destination must be absent or empty. Crawling is off by default; when enabled it is same-origin breadth-first with default limits of 10 pages and depth 2, hard limits 50 and 10. A page may load from any public origin and follow redirects, as in a browser; a public page cannot reach loopback, private, or reserved addresses, and downloads, popups, and service workers are always blocked. `--strict` limits the scan to the target origin plus each exact `--allow-origin`; listing any origin implies `--strict`. `--model-cli` is explicit opt-in and never implies API-key billing.

Every successful scan writes `agent-summary.json` and `contact-sheet.html` beside `issues.json`. Its stdout summary labels every grouped-defect line as `[likely-defect]` or `[detector-finding]` and lists likely defects first.

`--scenarios <file>` captures named page states instead of only the initial state. The file is JSON containing an array of unique labels:

```json
[
  {
    "label": "Settings modal",
    "url": "/account",
    "steps": [
      { "route": { "url": "/api/preferences", "status": 200, "body": "{}" } },
      { "click": { "role": "button", "name": "Open settings" } },
      { "fill": { "role": "textbox", "name": "Display name", "value": "Ada" } },
      { "waitFor": { "role": "dialog", "name": "Settings" } }
    ]
  }
]
```

The complete shape is an array of `{ "label": string, "url": string, "steps": [...] }`. Each step contains exactly one of `click`, `fill`, `waitFor`, or `route`, with the fields shown above. See the checked-in [fixture recipe](examples/scenarios.json) for panel, modal, and empty-list states.

The recipe is parsed and validated before Chromium starts. Malformed JSON, a duplicate/empty label, an invalid field, or an unsupported step reports the first error and exits 2. Scenario URLs resolve against the scan target and must keep its origin. Route URLs resolve against their scenario, are installed before page navigation so they can replace initial API loads, and can fulfill only same-origin requests; they do not expand `--allow-origin`. Clicks, fills, and waits locate page elements by accessible role and name. Each step gets one bounded attempt, and main-frame navigation away from the scenario origin is blocked before network contact. A missing, hidden, disabled, or otherwise unusable element stops that scenario at the current viewport, captures the reached state, and adds a high-confidence `scenario-step` finding that distinguishes a missing target from an action that could not complete; remaining scenarios continue. `--scenarios` and `--crawl` cannot be combined.

## `summarize`

```text
vqa summarize <report-dir> [--json]
```

Prints the report's compact grouped-defect summary without changing any file. Human output is kind-labelled and puts likely defects before detector findings. `--json` prints the exact one-line `agent-summary.json` document when present. For grouped format-2 reports created before that artifact was introduced, the command derives the same schema-1 document from `issues.json.groups` in memory and writes nothing. The command confines its read to the supplied link-free report directory. It returns 0 on success, 1 when the directory or summary source cannot be read or validated, and 2 for missing arguments, extra arguments, or invalid options.

## `baseline`

```text
vqa baseline <manifest-backed-report-dir>
```

Marks the report transactionally. Pre-manifest format-v2 reports are read-only and cannot be marked in place.

## `serve`

```text
vqa serve <report-dir> [--port <0-65535>] [--read-only] [--idle-timeout <ms>]
```

The default port is `0`, which chooses a free port. The service binds to `127.0.0.1`, passes the one-launch fragment URL directly to the system browser, and prints only the non-secret loopback origin. It stops after 30 minutes without an authorized request by default, and also stops with `Ctrl+C` or the Settings action. `--idle-timeout 0` disables idle shutdown. `--read-only` does not acquire the writer lock and refuses changes. Supported pre-manifest 0.2-era reports always open read-only.

## `open`

```text
vqa open <report-dir> [--read-only] [--idle-timeout <ms>]
```

User-facing alias for the same secure serve-and-open behavior. A browser-launch failure stops the service and returns a runtime failure.

## `launch`

```text
vqa launch [--port <0-65535>] [--idle-timeout <ms>]
```

Starts the authenticated browser start page for scanning without a terminal. The UI accepts an authorized HTTP(S) address or an uploaded self-contained local HTML file, viewport choices, cancellation, exact-origin approval/retry, and launcher-owned recent reports. A completed scan transitions to the manifest-backed review GUI through the same authenticated loopback origin.

## Exit and streams

| Code | Meaning |
| --- | --- |
| 0 | Command completed, server stopped cleanly, or doctor/browser status is healthy |
| 1 | Runtime, scan, integrity, filesystem, model, server, doctor, or browser-health failure |
| 2 | Missing command/argument or invalid CLI usage handled by the command |

Normal progress and results go to stdout. Usage errors and uncaught error messages go to stderr. Most commands are line-oriented human text. `doctor --json`, `browser ... --json`, and `summarize ... --json` are stable one-line JSON protocols. Doctor and browser use `schemaVersion: 1` and keep operational failure JSON on stdout; summarize prints the schema-1 agent-summary document on success and uses stderr for failure. All return deterministic status codes.
