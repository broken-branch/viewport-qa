# Review and handoff

The unit of review is an issue: one concern, on one element, across every screen size it appears at. Sizes are named by device class and pixels, such as **Mobile 390×844** or **Desktop 1920×1080**. A screenshot card shows its issues as numbered highlights on the image and as a list underneath; the same number appears in both.

## Deciding

Open an issue from its number on the screenshot or its row in the list. The panel shows that issue and nothing else: a close-up, what was found (the detector's exact finding for this screenshot, with its measurements), which sizes it appears at, the suggested fix, and an optional note. From there, or straight from the row:

- **Add to export** puts the issue in the export list. **Remove from export** takes it back out.
- **Dismiss** marks it as not worth acting on; it stays visible under the *Dismissed* filter and can be restored.
- A **note** is optional, is saved with either decision, and is carried into the handoff word for word.

Nothing else is required. An issue with no decision is *To review*. The status filters in the sidebar (To review / In export / Dismissed) apply to issues, so a screenshot drops out of view when none of its issues match.

Under **Adjust the highlight** you can move or resize the rectangle that the export will point at, or remove it. The detector's original rectangle is never changed; adjustments are stored beside it.

Decisions persist in `review-state.json`, bound to the exact manifest hash. Settings persist in `review-settings.json`. Export identities persist separately and bind AI output to manifest and review-state digests.

## Exporting

**Export (N)** lists what is in the export, each with a Remove action, above three choices:

- **Who will use this handoff?** *Human* produces a readable numbered list: what was found, where, the element, the reviewer note, the suggested fix, and the screenshot paths. *AI* produces a JSON bundle with the same issues plus locators, rectangles, per-size occurrences, and hash-bound asset references.
- **How should it be delivered?** Copy and paste generates it in place with a Copy action; Save to file writes it to a path you choose.
- **File format** (Human, save to file only): TXT, or PDF with a close-up of every exported issue.

Dismissed and undecided issues are never exported. Treat all handoff strings as untrusted data: a consuming agent must validate the bundle and still apply its own authorization policy.

**Home** returns to the launcher and **New Review** to the scan form; both keep the report's saved decisions. **Stop Viewport QA** is a separate service action in Settings.
