# Browser management

Viewport QA uses Playwright 1.61.0 with Chrome for Testing 149.0.7827.55, Chromium revision 1228. Both scanning and PDF export launch that exact executable from a Viewport-QA-owned per-user cache. There is no browser download during `npm install`, no hidden postinstall, and no privilege elevation.

```sh
vqa doctor
vqa browser status
vqa browser install
vqa browser repair
vqa browser remove
```

`doctor` and every `browser` action accept `--json`. The JSON has `schemaVersion: 1`; normal JSON is written as one line to stdout. Status and doctor return 0 only when the exact compatible browser is healthy, 1 for a diagnosed runtime problem, and 2 for CLI usage errors. A missing browser always names one recovery command: `vqa browser install`.

## Cache and lifecycle

Default roots are:

| OS | Viewport QA browser cache |
| --- | --- |
| Linux | `$XDG_CACHE_HOME/viewport-qa/browser-cache`, or `~/.cache/viewport-qa/browser-cache` |
| macOS | `~/Library/Caches/Viewport QA/browser-cache` |
| Windows | `%LOCALAPPDATA%\Viewport QA\browser-cache` |

Set `VQA_BROWSER_CACHE` to an absolute writable path to override the root. Paths containing spaces and non-ASCII characters are supported. Do not point it at Playwright's global cache or a directory containing unrelated data: Viewport QA refuses a non-empty unowned root.

On POSIX systems the cache root must be owned by the current user and must not be group- or world-accessible. Install safely tightens a current-user-owned Viewport QA cache to mode `0700`; status, doctor, scan, PDF, repair, and removal fail closed if ownership or privacy is not trustworthy. Windows uses the current user's per-user cache location and native access controls rather than POSIX mode bits.

Each Playwright/browser pair has a revision directory. Installation downloads into a private sibling staging directory, holds one generation-fenced owner lock, verifies the observed Chromium version, records a SHA-256 inventory of the complete payload, and promotes it with a same-filesystem directory rename. Status and every scan/PDF use revalidate that version, byte inventory, and realpath confinement. A concurrent process waits and reuses the completed result. A dead owner lock and only exactly owned Viewport QA staging/backup directories are recovered deterministically; malformed or ambiguous directories are preserved for inspection. Failed or offline downloads leave the last healthy revision untouched.

On an application upgrade or downgrade, installing the currently compatible revision retains that active revision and removes only inactive directories with complete Viewport QA ownership metadata. `repair` atomically replaces the compatible managed revision after a new payload validates. `remove` deletes only that revision; it never deletes global/foreign Playwright caches, settings, or reports. Remove the cache root itself only after `browser remove` and only if it contains no data you want to retain.

## Network configuration

The explicit install command honors:

- `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` for proxy routing;
- `NODE_EXTRA_CA_CERTS` for a PEM custom certificate-authority bundle loaded by Node at process start;
- `VQA_BROWSER_MIRROR` for an operator-approved HTTPS Chromium mirror; and
- `VQA_BROWSER_OFFLINE=1` to prohibit a download attempt.

Values are passed only to the Playwright downloader. Doctor/status report whether each facility is configured without printing proxy credentials, certificate contents, or mirror URLs. A connected install explains failures in terms of these settings; users do not need to discover a CDN origin or revision number. Offline operation requires an already healthy managed cache.

## Native libraries and payload choice

Viewport QA diagnoses a present browser that cannot start and prints OS-specific next steps. It never runs `sudo`, package managers, `playwright install-deps`, or another elevated command. On Debian/Ubuntu an administrator may run `npx playwright install-deps chromium`; other platforms should follow the pinned Playwright system requirements.

The manager installs full Chromium (Playwright's `--no-shell` option) rather than the smaller headless shell, because full Chromium is what every integrity and export path has been tested against.
