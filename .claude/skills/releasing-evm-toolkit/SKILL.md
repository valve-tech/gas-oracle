---
name: releasing-evm-toolkit
description: Use when cutting a release of any package in the `valve-tech/evm-toolkit` monorepo (`@valve-tech/chain-source`, `@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`) to npm — bumping that one package's version, updating its CHANGELOG, opening the release PR, tagging with the per-package format, and verifying the OIDC publish landed. Trigger on phrases like "release gas-oracle v0.X.Y", "publish chain-source to npm", "ship a tx-tracker release", "cut a release", "bump the version of <package>", "tag this", or when the user has just merged consumer-visible changes to one package and is asking how to get them onto npm. Covers the exact PR-title format, the signed per-package tag requirement, the OIDC publish workflow trigger, the manual-first-publish dance for any new package being added, and the common failure modes (1Password agent locked for tag signing, unbumped version, missing CHANGELOG, wrong tag pattern, OIDC trusted-publisher record not yet configured).
---

# Releasing `valve-tech/evm-toolkit` packages

The toolkit publishes each package to npm independently via GitHub
Actions OIDC trusted publishing. There is **no `NPM_TOKEN` secret** —
the workflow mints an OIDC JWT that npm validates against per-package
trusted-publisher records. The publish flow is entirely **tag-driven
and per-package**.

Every release is one PR, one squash-commit, one signed per-package
tag, one workflow run, one published version on npm.

## The end-to-end flow

```
1. Branch off main
2. Bump packages/<name>/package.json + add CHANGELOG entry IN the PR
3. PR title: chore(release): <package>/vX.Y.Z — <short summary>
4. Squash-merge to main
5. Sign-tag the merged release commit:
       git tag -s <package>/vX.Y.Z -m "..."
6. Push the tag:  git push origin <package>/vX.Y.Z
7. Watch the Release workflow; verify npm shows the new version
```

The tag prefix selects the package. **Nothing else triggers a
publish** — not merging, not pushing main, not editing
`packages/<name>/package.json`. If the tag isn't pushed, the version
sits in main but is invisible on npm.

Examples of valid tags:
- `gas-oracle/v0.3.0`
- `chain-source/v0.1.0`
- `tx-tracker/v0.1.0`

The workflow rejects tags that don't match `<package>/v<semver>` and
also rejects tags whose `<package>` doesn't have a corresponding
`packages/<package>/` directory.

## Step-by-step

### 1. Bundle the version bump into the change PR

```bash
# In the same branch as your changes:
# - Edit packages/<name>/package.json: "version": "X.Y.Z"
# - Edit packages/<name>/CHANGELOG.md: prepend a new section
git add packages/<name>/package.json packages/<name>/CHANGELOG.md
git commit -m "chore(release): <name>/vX.Y.Z"
git push
```

CHANGELOG entry goes at the **top** (after the file header), in
Keep-a-Changelog format. Sections are `### Added`, `### Changed`,
`### Fixed`, `### Removed`, `### Notes`. Use absolute dates
(`2026-05-03`), never relative.

### 2. PR title — the exact format matters

```
chore(release): gas-oracle/v0.3.0 — ChainSource layering + tx-tracker spec
chore(release): chain-source/v0.1.0 — initial implementation
chore(release): tx-tracker/v0.1.0 — initial implementation
```

The squash-merge subject takes the PR title verbatim, producing a
clean per-package release log on main. **Do not** use `feat:`,
`fix:`, etc. for release PRs — those types are for in-PR commits
within the branch, not the squash-merge subject.

To retitle a PR after opening it:

```bash
gh pr edit <PR#> --title "chore(release): <name>/vX.Y.Z — short summary"
```

### 3. Squash-merge

```bash
gh pr merge <PR#> --squash --auto --delete-branch
```

`--auto` queues the merge until CI passes. `--delete-branch` cleans
up the feature branch on origin.

After merge, sync local:

```bash
git checkout main && git pull --ff-only
```

### 4. Sign and push the per-package tag

Tags are GPG-style signed in this repo (existing tags use the
maintainer's SSH key via 1Password). If the 1Password SSH agent is
locked, tag creation fails with `failed to fill whole buffer` — see
Failure modes below.

```bash
git tag -s <package>/vX.Y.Z -m "<package>/vX.Y.Z — short summary"
git push origin <package>/vX.Y.Z
```

The tag points at the squash-merge commit on main.

### 5. Verify the publish

```bash
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Blocks until the workflow finishes; non-zero exit = publish failed.
After success:

```bash
npm view @valve-tech/<name>@latest version          # the new version
npm view @valve-tech/<name>@latest --json | jq .dist.attestations
```

## Adding a NEW package to the monorepo (first publish)

When a brand-new package lands (chain-source@0.0.1 and tx-tracker@0.0.1
were the first two), you cannot publish via the workflow until the
trusted-publisher record exists at npm. The record requires the
package to already exist on npm. Chicken-and-egg. Solution: **manual
first publish from a maintainer's machine**, then configure the
trusted publisher, then subsequent publishes go through the workflow.

### One-time first-publish dance

```bash
# 1. Make sure the package builds locally and the dist/ is fresh.
yarn workspace @valve-tech/<name> build

# 2. Sanity-check the tarball contents BEFORE publishing.
cd packages/<name>
npm pack --dry-run
# Verify only the files in package.json#files are listed:
# dist/, README.md, LICENSE — and for gas-oracle, also AGENTS.md,
# CHANGELOG.md, skills/.

# 3. Publish. --access public is required for scoped packages on
#    first publish.
npm publish --access public
```

### Configure the trusted publisher (one-time per package)

After the manual first publish lands, go to:

```
https://www.npmjs.com/settings/valve-tech/publishing
```

Click **"Add trusted publisher"** and enter:

| Field | Value |
| --- | --- |
| Package | `@valve-tech/<name>` |
| Publisher | GitHub Actions |
| Repository owner | `valve-tech` |
| Repository name | `evm-toolkit` |
| Workflow filename | `release.yml` |
| Environment | (leave blank — see CHANGELOG v0.2.3 for why) |

Save. The record is now active. **All subsequent publishes for that
package go through the workflow** — push a `<package>/vX.Y.Z` tag
and the OIDC publish runs automatically.

### Repeat per package

Each package needs its own trusted-publisher record. They all point
at the same repo + the same workflow file — npm matches per-package.

## When the gas-oracle package's trusted publisher needs updating

The renamed repo (`gas-oracle` → `evm-toolkit`) **does not** require
the existing `@valve-tech/gas-oracle` trusted-publisher record to be
torn down and recreated. GitHub auto-redirects the old repo URL to
the new one, but **npm caches the repo identity by GitHub repo ID**,
not by the URL string, so the existing trusted-publisher record
continues to match.

What DOES need updating: the **publishing flow itself**. The package
lives at `packages/gas-oracle/` now and the tag pattern is
`gas-oracle/vX.Y.Z`. The next gas-oracle release uses the new
pattern; old `v*` tags are historical-only.

To verify the existing record still works, **trigger a manual
workflow_dispatch** with the `tag` input set to a freshly-tagged
version (e.g. `gas-oracle/v0.3.0`). If the OIDC publish succeeds,
the record migrated cleanly. If it fails with "tenant not found" /
"401 Unauthorized", the npm side did not auto-track the GitHub
rename — recreate the record per the table above.

## Version-bump rules (SemVer)

- **Patch** (`0.2.4 → 0.2.5`): bug fixes, internal refactors, docs
  that ship in the tarball, new examples, new shipped skills.
- **Minor** (`0.2.5 → 0.3.0`): new exports, new options on existing
  exports that have a working default, new sub-export paths. Anything
  consumers can adopt without changing existing call sites.
- **Major** (`0.x.y → 1.0.0` or `1.x.y → 2.0.0`): renamed exports,
  removed options, changed default values that change behavior,
  changed type shapes that aren't pure additions.

Each package versions independently. A change to gas-oracle does not
bump tx-tracker, and vice versa.

## When NOT to bump any package

A change that does not touch any path in any package's `files`
allowlist (`dist`, `skills`, `README.md`, `AGENTS.md`, `CHANGELOG.md`,
`LICENSE`) does not change what's on npm and does not need a release.
Examples:

- `.github/workflows/*` edits (CI tweaks)
- `docs/*` edits at root (cross-cutting design notes that aren't shipped)
- `.claude/skills/*` edits (project-local AI skills, not shipped)
- `eslint.config.js` / `tsconfig.base.json` (build-only)
- Root `package.json` (private — never published)
- `examples/` at root (cross-package, not in any package's files allowlist)

A `packages/<name>/examples/` edit is also not in `files` for that
package — does not need a release on its own. But if you also edit the
package's `README.md` to reference the new example, the README ships
and that triggers a release.

When in doubt: `cat packages/<name>/package.json | jq .files` and check
whether your change's path is included.

## Failure modes

### `failed to fill whole buffer` during `git tag -s`

The 1Password SSH agent is locked. The user must unlock 1Password
(Touch ID or 1Password app unlock) before tag signing can complete.
**Don't bypass with `--no-gpg-sign`** — every tag in this repo's
history is signed and the chain of provenance breaks if one suddenly
isn't.

### Workflow fails with "401 Unauthorized" or "tenant not found"

OIDC trusted-publisher record on npm is misconfigured or out of sync.

1. Check `https://www.npmjs.com/settings/valve-tech/publishing` —
   record for the affected package matches:
   - Repository: `valve-tech/evm-toolkit`
   - Workflow filename: `release.yml`
   - Environment: blank
2. If wrong: delete and recreate the record.
3. The workflow file (`.github/workflows/release.yml`) deliberately
   has **no** `environment:` block — adding one breaks OIDC matching.
   See CHANGELOG v0.2.3 notes.

### Workflow fails at "Verify package version matches tag" step

The `package.json` `version` field doesn't match the tag's version.
Either:
- You forgot to bump (most common). Recovery: open a new release PR
  bumping again, merge, retag with the next version. Do **not**
  delete the existing tag.
- The tag is correct but the wrong commit was tagged. Recovery: same
  — bump again, retag.

Mark broken intermediate versions as `*unpublished*` in the
CHANGELOG (see `packages/gas-oracle/CHANGELOG.md`'s v0.2.2 entry for
the existing precedent).

### Tag pushed but no workflow ran

Possible causes:

1. Tag pattern doesn't match `<package>/v*` — e.g., you typed
   `gas-oracle/0.3.0` (no `v`) or `v0.3.0` (no package prefix).
   Delete and retag with the right name.
2. `<package>` directory doesn't exist — the workflow fails the
   parse step with a non-zero exit. Check `gh run list --workflow=release.yml`.
3. Workflow is disabled — check `gh workflow list`.

### Publish succeeded but consumer can't see new version

Wait 30–60s — npm's CDN is occasionally slow to propagate. If still
missing after a minute:

```bash
npm view @valve-tech/<name> versions --json | jq -r '.[-3:]'
```

If the version is in npm's view but a consumer's lockfile pins to an
older one, that's a consumer-side issue (`yarn up`, `npm update`).

## Stale-branch hygiene after release

After the release PR is merged with `--delete-branch`, the feature
branch is gone from origin but other release branches from prior
versions may linger. Periodically prune:

```bash
git fetch --prune
gh pr list --state merged --limit 20
git push origin --delete <branch> [<branch> ...]
```

Don't bulk-delete without listing first — branches that look stale
may have been left for forensic reasons (e.g. an `*unpublished*`
release where the branch is the only on-disk evidence of what failed).

## What the Release workflow actually does

For full reference, `.github/workflows/release.yml` does, in order:

1. `actions/checkout@v4` — pulls the tagged commit (or the input ref
   for `workflow_dispatch`).
2. **Parse the tag** into `package` + `version` via a strict regex.
   Fails fast on malformed tags.
3. `setup-node@v4` with `registry-url: 'https://registry.npmjs.org'`
   (required for OIDC negotiation).
4. Upgrades npm to 11.5.1+ (Node 22's default npm 10 has matcher
   quirks against trusted-publisher claims).
5. `corepack enable && yarn install --immutable` — frozen lockfile.
6. **Workspace-wide gate**: `yarn lint && yarn typecheck &&
   yarn typecheck:examples && yarn test && yarn build` — every
   package must be clean for any one of them to publish.
7. **Verify package version matches tag**: `node -p "require(...).version"`
   against the parsed version. Catches "I forgot to bump" before
   npm rejects.
8. `cd packages/<package> && npm publish --access public --provenance`
   — `--provenance` attaches the SLSA attestation; `--access public`
   is required for scoped packages on first publish.

If any step before publish fails, the publish does not run. The
version sits at the tagged ref in git but isn't on npm — recover by
fixing the issue and **bumping again** (do not retry the same
version).
