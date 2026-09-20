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

`version.json` is the single source of truth. `pnpm version:sync` copies it into every package manifest and the generated contract constant; `pnpm run build` refuses to proceed if they drift.

1. Bump `version.json`, run `pnpm version:sync`, update `CHANGELOG.md`, and commit.
2. Tag `vX.Y.Z` and push the tag.
3. The `Release` workflow verifies the tag matches `version.json`, builds and tests the tarball, publishes `viewport-qa` to npm with provenance, and creates a GitHub release with the tarball attached.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no long-lived token): the package on npmjs.com must have this repository's `release.yml` workflow configured as a trusted publisher.
