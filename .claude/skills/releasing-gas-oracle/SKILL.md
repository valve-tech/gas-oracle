---
name: releasing-gas-oracle
description: Use when cutting a release of `@valve-tech/gas-oracle` to npm — bumping the version, updating CHANGELOG, opening the release PR, tagging, and verifying the OIDC publish landed. Trigger on phrases like "release v0.X.Y", "publish to npm", "ship a release", "cut a release", "bump the version", "tag this", or when the user has just merged consumer-visible changes and is asking how to get them onto npm. Covers the exact PR-title format, the signed-tag requirement, the OIDC publish workflow trigger, and the common failure modes (1Password agent locked for tag signing, unbumped version, missing CHANGELOG, wrong PR title format).
---

# Releasing `@valve-tech/gas-oracle`

The package publishes to npm via GitHub Actions OIDC trusted publishing.
There is **no `NPM_TOKEN` secret** — the workflow mints an OIDC JWT that
npm validates against a trusted-publisher record. This means the publish
flow is entirely tag-driven and tightly coupled to specific commit shapes.

## The end-to-end flow

```
1. (on a feature branch) Bump package.json + add CHANGELOG entry IN the PR
2. PR title: chore(release): vX.Y.Z — <short summary>
3. Squash-merge to main
4. Sign-tag the merged release commit:  git tag -s vX.Y.Z -m "..."
5. Push the tag:  git push origin vX.Y.Z
6. Watch the Release workflow run; verify npm shows the new version
```

Tag push is the publish trigger. **Nothing else triggers a publish** —
not merging the PR, not pushing main, not editing package.json. If the
tag isn't pushed, the version sits in main but is invisible on npm.

## Step-by-step

### 1. Bundle the version bump into the change PR

A release is one PR, one squash-commit on main. The PR contains both
the changes AND the version bump AND the CHANGELOG entry. Do not split
"bump version" into a separate PR — that fragments the release record.

```bash
# In the same branch as your changes:
# - Edit package.json: "version": "0.2.5"
# - Edit CHANGELOG.md: prepend a new section
git add package.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git push
```

CHANGELOG entry goes at the **top** (after the file header), and follows
the Keep-a-Changelog format already used in the file. Sections are
`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Notes`. Use
absolute dates (`2026-05-03`), never relative ones.

### 2. PR title — the exact format matters

```
chore(release): v0.2.5 — RPC transport modes docs
```

The subject of the squash-merge commit is the PR title. The git history
on main reads as a clean release log:

```
873fd91 chore(release): v0.2.5 — RPC transport modes docs (#5)
7b84ed8 chore(release): v0.2.4 — docs, examples, skills, eslint (#4)
```

**Do not** use `feat:`, `fix:`, etc. for release commits — those types
are for in-PR commits *within* the branch, not the squash-merge subject.
The release commit is always `chore(release): vX.Y.Z — <summary>`.

To retitle a PR after opening it:

```bash
gh pr edit <PR#> --title "chore(release): vX.Y.Z — short summary"
```

### 3. Squash-merge

```bash
gh pr merge <PR#> --squash --auto --delete-branch
```

`--auto` queues the merge until CI passes. `--delete-branch` cleans up
the feature branch on origin.

After merge, sync local:

```bash
git checkout main && git pull --ff-only
```

### 4. Sign and push the tag

Tags are GPG-style **signed** in this repo (the existing tags v0.2.1
through current all are). The user's signing config uses an SSH key
through 1Password. If the 1Password SSH agent is locked, tag creation
will fail with `failed to fill whole buffer` — see Failure modes below.

```bash
git tag -s vX.Y.Z -m "vX.Y.Z — short summary"
git push origin vX.Y.Z
```

The tag points at the squash-merge commit on main.

### 5. Verify the publish

The Release workflow fires on the tag push:

```bash
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

This blocks until the workflow finishes; non-zero exit = publish failed.
Run in the foreground (or `run_in_background` and check later) — do not
move on to other release work while a publish is in flight.

After success, sanity-check:

```bash
npm view @valve-tech/gas-oracle@latest version          # should be the new version
npm view @valve-tech/gas-oracle@latest --json | jq .dist.attestations  # SLSA attestation present
```

## Version-bump rules (SemVer)

- **Patch** (`0.2.4 → 0.2.5`): bug fixes, internal refactors, docs that
  ship in the tarball, new examples, new skills under `skills/`.
- **Minor** (`0.2.5 → 0.3.0`): new exports, new options on existing
  exports that have a working default, new sub-export paths. Anything
  consumers can adopt without changing existing call sites.
- **Major** (`0.x.y → 1.0.0` or `1.x.y → 2.0.0`): renamed exports,
  removed options, changed default values that change behavior, changed
  type shapes that aren't pure additions.

The package is at `0.2.x` — pre-1.0 SemVer applies, but the project
practices it strictly anyway. Treat a public-API rename as breaking even
in 0.x. Bump-minor on additive changes; reserve major for actual cuts.

## When NOT to bump

A change that does not touch any path in the `package.json` `files`
allowlist (`dist`, `skills`, `README.md`, `AGENTS.md`, `CHANGELOG.md`,
`LICENSE`) does not change what's on npm and does not need a release.
Examples:

- `.github/workflows/*` edits (CI tweaks)
- `docs/*` edits (long-form notes that aren't shipped)
- `.claude/skills/*` edits (project-local AI skills, not shipped)
- `eslint.config.js` / `tsconfig.json` (build-only)
- `examples/*` edits (not in the files allowlist — they live in the
  repo for reference only)

Wait — examples are **not** in the `files` allowlist. They don't ship.
If you only edit examples, no release is needed. If you edit examples
*and* the docs that reference them in README.md, you do release because
the README change ships.

When in doubt: `cat package.json | jq .files` and check whether your
change's path is included.

## Failure modes

### `failed to fill whole buffer` during `git tag -s`

The 1Password SSH agent is locked. The user must unlock 1Password
(Touch ID or 1Password app unlock) before tag signing can complete.
**Don't bypass with `--no-gpg-sign`** — the existing tags are all signed
and the chain of provenance breaks if v0.2.X is suddenly unsigned.

Wait for the user to unlock, then retry:

```bash
git tag -s vX.Y.Z -m "vX.Y.Z — ..."
```

### Workflow fails with "401 Unauthorized" or "tenant not found"

OIDC trusted-publisher record on npm is misconfigured or out of sync.
This shouldn't happen on patch/minor releases — the v0.2.3 commit fixed
the OIDC config. If it does fail this way:

1. Check `https://npmjs.com/settings/valve-tech/publishing` matches
   the workflow's `repo` + `workflow_path` + (no environment).
2. The workflow file (`.github/workflows/release.yml`) deliberately has
   **no** `environment:` block — adding one breaks OIDC matching against
   the npm trusted-publisher record. See CHANGELOG v0.2.3 notes.

### Forgot to bump the version

If `package.json` still shows the previous version when you push the
tag, the publish will reject with `cannot publish over existing version`.

Recovery:

1. Do **not** delete the existing tag.
2. Bump in a new follow-up PR (`chore(release): vX.Y.Z+1`), merge,
   tag the new version, push.
3. Mark the broken intermediate version in CHANGELOG as `*unpublished*`
   (see v0.2.2 entry for the existing precedent).

### Tag pushed but no workflow ran

Possible causes:

1. Tag pattern doesn't match `v*` — e.g., you typed `0.2.5` without
   the leading `v`. Delete and retag with the right name.
2. Workflow is disabled — check `gh workflow list`.
3. Default branch protection forbids the tagger — unlikely for the
   repo owner; check `gh api /repos/valve-tech/gas-oracle/branches/main/protection`.

### Publish succeeded but consumer can't see new version

Wait 30–60s — npm's CDN is occasionally slow to propagate. If still
missing after a minute:

```bash
npm view @valve-tech/gas-oracle versions --json | jq -r '.[-3:]'
```

If the version is in npm's view but a consumer's lockfile pins to an
older one, that's a consumer-side issue (`yarn up`, `npm update`).

## Stale-branch hygiene after release

After the release PR is merged with `--delete-branch`, the feature
branch is gone from origin but other release branches from prior
versions (`chore/v0.2.X-...`) may linger. Periodically prune:

```bash
git fetch --prune                            # sync local view of remote
gh pr list --state merged --limit 20         # find merged PRs whose branches remain
git push origin --delete <branch> [<branch> ...]
```

Don't bulk-delete without listing first — branches that look stale may
have been left for forensic reasons (the `unpublished` v0.2.2 release
is documented in CHANGELOG specifically because the branch / tag
remained as evidence of the failed publish).

## What the Release workflow actually does

For full reference, `.github/workflows/release.yml` does, in order:

1. `actions/checkout@v4` — pulls the tagged commit.
2. `setup-node@v4` with `registry-url: 'https://registry.npmjs.org'`
   (required for OIDC negotiation).
3. Upgrades npm to 11.5.1+ (default npm 10 shipping with Node 22 has
   matcher quirks against the trusted-publisher claim).
4. `corepack enable && yarn install --immutable` — frozen lockfile.
5. `yarn lint && yarn typecheck && yarn typecheck:examples && yarn test`
   — same checks as CI; the publish workflow does not skip them.
6. `yarn build` — produces `dist/`.
7. `npm publish --access public --provenance` — `--provenance` attaches
   the SLSA build attestation signed via the OIDC token; `--access public`
   is required on first publish for scoped packages.

If any step before publish fails, the publish does not run. The version
sits at the new tag in git but isn't on npm — recover by fixing the
issue and **bumping again** (do not retry the same version).
