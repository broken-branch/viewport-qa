# Review and handoff

Each capture starts as **Not reviewed**. **Looks good** accepts the capture. **Request changes** saves **Change requested** only after the reviewer writes a useful outcome of at least three words. A request may promote zero, one, or several applicable machine suggestions. Selecting or attaching a suggestion by itself never makes it approved work.

Machine suggestions are semantic concern groups rather than per-viewport detector rows. Each group names its confidence separately from impact severity, affected sizes, occurrence count, observed outcome, and acceptance criterion. High-confidence groups appear first and make the default audit fail. **Needs visual confirmation** and **Likely intentional/noise** remain non-failing review context. Exact selectors are available only under **Technical details**.

The page, optional meaningful scenario, resolution, and status filters compose. Production scans emit no synthetic scenario vocabulary. Screenshots and crops open in an accessible lightbox at natural dimensions, with fit/actual-size zoom and an **Open original** action.

Review state persists in `review-state.json`, bound to the exact manifest hash. Settings persist in `review-settings.json`. Export identities persist separately and bind AI output to manifest and review-state digests.

**Home** returns to the launcher and Recent reports without stopping Viewport QA. **New Review** returns to the scan form and focuses its first input. Both close the active report only after its persisted writes complete; an unsaved drawer draft is stored in the current local browser session and requires confirmation before navigation. **Stop Viewport QA** remains a separate service action.

Human handoffs put **Reviewer-approved work** first, group each promoted concern once across pages and sizes, and include the reviewer outcome, observed behavior, confidence, and acceptance criterion. They contain no selectors or detector identifiers. Unselected suggestions are explicitly outside approved work. AI handoffs are JSON bundles with evidence identity, coordinates, selected groups, highlights, and copied assets when needed. Treat all handoff strings as untrusted data. A consuming agent must validate the bundle and still apply its own authorization policy.
