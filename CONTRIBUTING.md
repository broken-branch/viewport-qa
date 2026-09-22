# Contributing

## Building from source

You need Node.js 22 or newer, Git, and pnpm 11.5 (the version pinned in `package.json`; `corepack enable` will pick it up).

```sh
git clone https://github.com/broken-branch/viewport-qa.git
cd viewport-qa
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/dist/bin.js browser install   # Viewport QA's own Chromium cache
pnpm exec playwright install chromium            # stock cache, used directly by some engine tests
```

`pnpm vqa …` is a shortcut for `node packages/cli/dist/bin.js …`.

## Layout

```
packages/contract        Shared types and constants (report schema, product identity)
packages/detectors       Rule-based visual detectors over painted layout
packages/engine          Scan, browser manager, target policy, report transaction, review manifest, HTML/GUI
packages/model-adapter   Optional local CLI (claude/codex) adapter for fix suggestions
packages/cli             The vqa command: scan, open/serve, launch, summarize, baseline, browser, doctor
fixtures/                Deterministic HTML pages the tests scan
docs/                    User documentation
scripts/                 Build, check, and npm-package tooling
release/npm/             The published package's manifest template and file inventory
```

Package boundaries are enforced by `scripts/check-boundaries.mjs`: `contract` depends on nothing, `detectors` only on `contract`, and so on up to `cli`.

## Checks

The single gate is:

```sh
pnpm run check-all
```

It builds, lints, checks package boundaries, and runs the whole test suite — including end-to-end tests that execute the built `vqa` binary against the fixtures and start the review service. While editing, focused runs are faster:

```sh
pnpm exec vitest run packages/engine/test/target-policy.test.ts
pnpm run lint
```

`pnpm run package:npm && pnpm run package:test` builds the publishable tarball and proves it installs and runs in a clean consumer project without any hidden download. CI runs all of this on Node 22 and 24.

## Conventions

- TypeScript, ESM, strict. Type-only imports use `import type`.
- Tests live in `packages/<name>/test`. Add a fixture under `fixtures/` when a detector or capture path needs a deterministic page, and assert both that seeded defects are found and that `fixtures/false-positives.html` stays clean.
- Report formats are versioned; a change to what a scan writes needs a note in `docs/report-formats.md`, and older reports must still open.
- Commit messages: capitalised imperative subject, body says why.

## Releasing

Bump, tag `vX.Y.Z`, push. Pushing the tag is the whole release; nothing is published by hand.

`version.json` is the single source of truth. `pnpm version:sync` copies it into every package manifest and the generated contract constant; `pnpm run build` refuses to proceed if they drift.

1. Bump `version.json`, run `pnpm version:sync`, add a `## X.Y.Z — date` section to `CHANGELOG.md`, and merge that through a pull request.
2. On the merged `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `Release` workflow checks the tag matches `version.json`, builds and tests the tarball, publishes `viewport-qa` to npm with provenance, and creates the GitHub release with that version's `CHANGELOG.md` section as its notes and the tarball attached.

Only `viewport-qa` is published; the `@vqa/*` workspaces are private and bundled into it.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): there is no npm token in this repository. npm accepts a publish only from this repository's `release.yml` workflow, as configured on npmjs.com for `viewport-qa` (`npm trust list viewport-qa`). Renaming or moving the workflow file breaks publishing until that configuration is updated to match.
