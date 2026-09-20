# Troubleshooting

## Chromium is missing

Run `vqa doctor`, then the one recovery command it names: `vqa browser install`. `vqa browser status --json` gives the same details in a stable machine-readable form.

If an install is corrupt, run `vqa browser repair`. An interrupted or offline repair preserves the last healthy revision. A concurrent installer owns the cache briefly; wait for it rather than deleting its lock. Dead Viewport QA owners and validated stale staging directories are recovered automatically.

## Proxy, certificate, mirror, or offline failure

Set `HTTPS_PROXY`/`HTTP_PROXY` (and `NO_PROXY` where needed) before running the command. Set `NODE_EXTRA_CA_CERTS` to a custom PEM CA path before Node starts. An approved mirror is `VQA_BROWSER_MIRROR=https://...`; HTTP mirrors are refused. `VQA_BROWSER_OFFLINE=1` guarantees no download is attempted. Viewport QA never prints configured secrets or silently retries another origin. See [browser management](browser-management.md).

## Cache is not writable

Set `VQA_BROWSER_CACHE` to an absolute writable local path. Do not point it at a non-empty global Playwright cache. Paths with spaces and non-ASCII characters work when passed through the environment normally. Read-only homes and network filesystems need a writable local override.

## A native library is missing

`vqa doctor` names this condition separately from a missing download. Viewport QA never elevates. Install the Chromium prerequisites for your platform: on Debian/Ubuntu, `npx playwright install-deps chromium` as an administrator; on Windows, current OS and Microsoft Visual C++ runtime updates; on macOS, a version supported by the pinned Playwright release.

## The output directory is not empty

Choose a new path or move the existing report yourself. Viewport QA intentionally has no overwrite flag. Failed scans clean their staging directory and never leave partial output that looks complete.

## A request was blocked

By default only requests from a public page to loopback, private, or reserved addresses are blocked, along with downloads, popups, and service workers; the scan reports a blocked request as a failure only in those cases. In `--strict` mode every origin beyond the target must be listed with `--allow-origin`; the failure names the origin. A site that rate-limits or challenges automated browsers (HTTP 429, "press and hold" pages) shows up as failed requests and a capture of the challenge page rather than the site; wait and retry, or scan a staging copy.

## The server port is busy

Port `0` (a free port) is already the default. Stop a running review with `Ctrl+C` or **Stop Viewport QA** in Settings. If the system browser cannot be launched, `vqa serve` prints the loopback origin; the capability URL itself is intentionally never printed or logged.

## The report is already open for writing

Stop the other Viewport QA process, or use `--read-only` to inspect without editing. A stale lock whose owner process no longer exists is recovered automatically; ambiguous live locks are preserved. A legacy lock file or `.recovery` artifact is never removed automatically: stop all older Viewport QA processes, inspect it, remove it manually only when safe, and retry.

## A legacy report cannot be edited

Pre-manifest 0.2-era reports are intentionally read-only. Keep the original. There is no in-place migration command.

## Asset or review-state integrity fails

Restore the report from its original copy. Do not edit manifest hashes or review-state binding fields to bypass validation.

## PDF or model CLI fails

PDF export requires the matched Playwright Chromium. Model recommendations require explicit `--model-cli`, a discoverable already-authenticated executable, valid JSON output, and completion within the configured timeout. Failures are recorded as unavailable; they are never replaced with synthetic recommendations.

Quote paths containing spaces.
