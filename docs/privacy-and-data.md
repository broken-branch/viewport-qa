# Privacy and data

A scan loads the page and the resources it references from public origins, as a browser would; a public page cannot reach private or local addresses. It collects DOM-derived geometry, computed styles, selectors, URLs, detected issue descriptions, and screenshots. During each capture it also records this browser behaviour from the existing Playwright page and context:

- Console messages whose level is `error` or `warning`: message text, source URL, and line number.
- Requests that fail or return HTTP 4xx/5xx: method, URL, and either HTTP status or browser failure reason.
- Cookies written during page activity, plus cookies present in the fresh browser context after activity settles: name, domain, path, expiry, `HttpOnly`, `Secure`, `SameSite`, and optional browser-supplied partition key. This includes writes later removed by the page.
- `localStorage` and `sessionStorage` writes, removals, and clears in the page or its child frames, plus entries present after activity settles: key names only. This includes keys later removed by the page.

Request URLs and console source URLs retain their query string only when they resolve to the same non-opaque origin as the captured page. Opaque, cross-origin, and unparseable recorded URLs have their query string removed or redacted. URL fragments are not sent in requests. Request bodies and response bodies are never accessed. Web-storage values are discarded in the page before an observation reaches the engine. Cookie values from page setters or response headers are discarded immediately; neither kind of value is retained in memory collections or written to a report. Viewport QA does not produce a HAR.

These records and screenshots are stored in the selected report directory. Console text, storage key names, same-origin URLs, and visible page content may themselves contain personal, confidential, authenticated-session, or proprietary information. Viewport QA creates a fresh ephemeral browser context per capture and does not inject host credentials into the page. Behaviour capture uses no extension or proxy.

No model adapter is enabled by default. With `--model-cli codex|claude`, Viewport QA sends bounded visual-issue context to that local executable; any onward network transfer and retention follow the selected tool and account configuration. Browser-behaviour findings are never sent to a model adapter. If the executable is missing, fails, times out, or returns invalid output, Viewport QA records an unavailable result and never invents AI findings.

The report service is authenticated per launch and keeps review state and handoffs on local storage. Private screenshots are fetched with the launch authorization and rendered from short-lived Blob URLs. Delete a report by removing its directory; delete separately saved handoffs at their chosen paths.

The compatible browser is stored in Viewport QA's documented per-user cache, separate from reports and global Playwright caches. `vqa browser remove` removes only the active compatible Viewport QA revision; version movement reclaims only inactive complete managed revisions. Proxy/CA/mirror values are used by the explicit downloader and status output reveals only whether they are configured. Viewport QA has no telemetry.
