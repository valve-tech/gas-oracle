---
name: releasing-evm-toolkit
description: Use when cutting a release of the `valve-tech/evm-toolkit` monorepo to npm — bumping every workspace package's version in lockstep, updating per-package CHANGELOGs and the root CHANGELOG, opening the release PR, tagging with `vX.Y.Z`, and verifying the OIDC publish landed for all three packages (`@valve-tech/chain-source`, `@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`). Trigger on phrases like "release v0.X.Y", "publish to npm", "ship a release", "cut a release", "bump the toolkit version", "tag this", or when the user has just merged consumer-visible changes and is asking how to get them onto npm. Covers synchronized versioning (all packages move together), the exact PR-title format, the signed-tag requirement, the OIDC publish workflow trigger, the manual-first-publish dance for any new package being added, and the common failure modes.
---

# Releasing `valve-tech/evm-toolkit`

The toolkit uses **synchronized versioning** — every release is a
single `vX.Y.Z` tag that bumps **all** publishable workspace packages
in lockstep, and the OIDC publish workflow publishes them all from the
same tag.

There is **no `NPM_TOKEN` secret** — the workflow mints an OIDC JWT
that npm validates against per-package trusted-publisher records. The
publish flow is entirely **tag-driven**.

Every release is one PR, one squash-commit on main, one signed tag,
one workflow run, multiple `npm publish` calls (one per package, all
from the same workflow execution).

## The end-to-end flow

```
1. Branch off main
2. Bump every packages/*/package.json to the new version
3. Update every packages/*/CHANGELOG.md with the new entry
4. PR title: chore(release): vX.Y.Z — <short summary>
5. Squash-merge to main
6. Sign-tag the merged release commit:
       git tag -s vX.Y.Z -m "..."
7. Push the tag:  git push origin vX.Y.Z
8. Watch the Release workflow; verify npm shows the new version on
   every package
```

The tag is the publish trigger. Nothing else triggers a publish — not
merging the PR, not pushing main, not editing any `package.json`. If
the tag isn't pushed, the version sits in main but is invisible on npm.

## Step-by-step

### 1. Bump every package in lockstep

Synced versioning: **every publishable workspace package must be at
the same version**. The release workflow refuses to publish if any
package's version doesn't match the tag.

```bash
# In your release branch — bump all three:
sed -i.bak 's/"version": "0\.X\.Y"/"version": "0.X.Z"/' \
  packages/chain-source/package.json \
  packages/gas-oracle/package.json \
  packages/tx-tracker/package.json
rm packages/*/package.json.bak

# Verify:
for pkg in packages/*/; do
  echo "$pkg → $(node -p "require('./$pkg/package.json').version")"
done
```

### 2. Update per-package CHANGELOGs

Each package has its own `CHANGELOG.md` that ships in its npm tarball
(in the `files` allowlist). Add the new release entry at the top of
each, following the existing Keep-a-Changelog format. **Sections are
`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Notes`.**
Use absolute dates (`2026-05-04`), never relative.

If a package has no changes for a release, still add a stub entry
noting the synchronized release:

```markdown
## [0.3.1] — 2026-05-10

### Notes
- Synchronized release — no changes to this package. Bumped in
  lockstep with the rest of the toolkit.
```

This keeps consumers' `npm view @valve-tech/<name> versions` honest.

### 3. PR title — exact format

```
chore(release): v0.3.0 — short summary
chore(release): v0.3.1 — fix idle-traffic bug in chain-source
chore(release): v0.4.0 — chain-source implementation lands
```

The squash-merge subject takes the PR title verbatim, producing a
clean release log on main:

```
b63264f chore(release): v0.3.0 — synchronized release; idle-traffic controls (#9)
```

**Do not** use `feat:`, `fix:`, etc. for release PRs — those types
are for in-PR commits within the branch, not the squash-merge subject.
The release commit is always `chore(release): vX.Y.Z — <summary>`.

To retitle a PR after opening:

```bash
gh pr edit <PR#> --title "chore(release): vX.Y.Z — short summary"
```

### 4. Squash-merge

```bash
gh pr merge <PR#> --squash --auto --delete-branch
```

`--auto` queues the merge until CI passes. After merge, sync local:

```bash
git checkout main && git pull --ff-only
```

### 5. Sign and push the synchronized tag

Tags are SSH-signed in this repo (the `valvecitydev` 1Password key).
If the 1Password SSH agent is locked, tag creation fails with
`failed to fill whole buffer` — see Failure modes below.

```bash
git tag -s vX.Y.Z -m "vX.Y.Z — short summary"
git push origin vX.Y.Z
```

The tag points at the squash-merge commit on main.

### 6. Verify the publish

```bash
gh run watch $(gh run list --workflow=release.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId') --exit-status
```

Blocks until the workflow finishes; non-zero exit = at least one
publish failed. After success:

```bash
for pkg in chain-source gas-oracle tx-tracker; do
  echo -n "@valve-tech/$pkg "
  npm view "@valve-tech/$pkg@latest" version
done
```

All three should show the new version.

## Adding a NEW package to the monorepo (first publish)

When a brand-new package lands (chain-source@0.3.0 and
tx-tracker@0.3.0 were the first two, jumping straight to the synced
0.3.0 line), you cannot publish via the workflow until the
trusted-publisher record exists at npm. The record requires the
package to already exist on npm. Chicken-and-egg. Solution: **manual
first publish from a maintainer's machine**, then configure the
trusted publisher, then subsequent publishes go through the workflow.

### One-time first-publish dance

```bash
# 1. Make sure the package builds locally and dist/ is fresh.
yarn workspace @valve-tech/<name> build

# 2. Sanity-check the tarball contents BEFORE publishing.
cd packages/<name>
npm pack --dry-run
# Verify only the files in package.json#files are listed:
# dist/, README.md, LICENSE, CHANGELOG.md (and AGENTS.md / skills/
# for gas-oracle).

# 3. Make sure you're logged into npm as a maintainer with rights to
# the @valve-tech scope. The npm credential is separate from the
# OIDC publish in CI.
npm whoami            # should print your username
npm access list packages @valve-tech | head    # should show existing pkgs

# 4. Publish. --access public is required for scoped packages on
# first publish.
npm publish --access public

cd ../..
```

After the manual first publish lands, configure the trusted publisher
at https://www.npmjs.com/settings/valve-tech/publishing:

| Field | Value |
| --- | --- |
| Package | `@valve-tech/<name>` |
| Publisher | GitHub Actions |
| Repository owner | `valve-tech` |
| Repository name | `evm-toolkit` |
| Workflow filename | `release.yml` |
| Environment | *(blank — see CHANGELOG v0.2.3 for why)* |

Save. Subsequent publishes for that package go through the workflow.

### Repeat per package

Each package needs its own trusted-publisher record. They all point
at the same repo + the same workflow file — npm matches per-package.

## Version-bump rules (SemVer, applied uniformly across all packages)

Because versioning is synced, **all three packages bump together** —
even if a release only meaningfully changes one of them. The bump
size is determined by the largest change across the toolkit:

- **Patch** (`0.3.0 → 0.3.1`): bug fixes in any package, internal
  refactors, docs that ship in any tarball, new examples.
- **Minor** (`0.3.0 → 0.4.0`): new exports in any package, new
  options on existing exports that have a working default, new
  sub-export paths. Anything consumers can adopt without changing
  existing call sites.
- **Major** (`0.x.y → 1.0.0` or `1.x.y → 2.0.0`): renamed exports,
  removed options, changed default values that change behavior,
  changed type shapes that aren't pure additions, in any package.

Packages without changes for a release still bump (synced) and get a
short CHANGELOG entry noting "Synchronized release — no changes to
this package."

The toolkit is at `0.3.x` — pre-1.0 SemVer applies, but the project
practices it strictly anyway. Treat a public-API rename as breaking
even in 0.x.

## When NOT to release

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

If you only edit those, no version bump. The CI workflow runs and
verifies the change but doesn't publish.

## Failure modes

### `failed to fill whole buffer` during `git tag -s`

The 1Password SSH agent is locked. The user must unlock 1Password
(Touch ID or 1Password app unlock) before tag signing can complete.
**Don't bypass with `--no-gpg-sign`** — every tag in this repo's
history is signed and the chain of provenance breaks if one isn't.

### Workflow fails with "401 Unauthorized" or "tenant not found"

OIDC trusted-publisher record on npm is misconfigured for one or more
packages.

1. Check `https://www.npmjs.com/settings/valve-tech/publishing` —
   verify each of the three packages has a record matching:
   - Repository: `valve-tech/evm-toolkit`
   - Workflow filename: `release.yml`
   - Environment: blank
2. If any is wrong: delete and recreate the record per the table
   above.
3. The workflow file (`.github/workflows/release.yml`) deliberately
   has **no** `environment:` block — adding one breaks OIDC matching.

### Workflow fails with `npm error 404 - PUT @valve-tech/<name>` after a repo move/restructure

The error text says "could not be found or you do not have permission",
but the package exists. This is the trusted-publisher record being
bound to a *different* GitHub repo than the one currently running the
workflow — most commonly leftover from before a monorepo restructure.

**Smoking-gun diagnosis (no auth needed):**

```bash
for pkg in chain-source gas-oracle tx-tracker; do
  printf "@valve-tech/%-14s " "$pkg"
  curl -s "https://registry.npmjs.org/@valve-tech/$pkg" \
    | jq -r '."dist-tags".latest as $v
             | $v + "  repo=" + .versions[$v].repository.url
             + "  dir=" + (.versions[$v].repository.directory // "—")'
done
```

If any package's last successful publish shows `repository.url` from a
*different* repo than `evm-toolkit.git` (e.g.
`git+https://github.com/valve-tech/gas-oracle.git`), that package's
trusted-publisher record is still bound to the old repo. Fix the
record per the table above (Repository: `valve-tech/evm-toolkit`,
Workflow: `release.yml`, Environment: blank), then push the next
synchronized tag — no need for a manual republish.

**This is what bit v0.3.0** (chain-source published; gas-oracle 404'd
because its TP record still pointed at the pre-restructure
`valve-tech/gas-oracle` single-repo). The recovery was a v0.3.1 sync
release after fixing the TP record — first time around, not multiple
attempts. Reading the published `repository.url` is enough; don't
guess at the config from the workflow side.

**Don't conflate with `npm whoami` 401.** A 401 on the local CLI is a
stale `_authToken` in `~/.npmrc` — completely unrelated to the OIDC
publish path. The Release workflow doesn't touch your local token,
and re-logging-in locally won't fix an OIDC 404.

### Workflow fails at "Verify all packages are at tag version"

One of the `package.json` `version` fields doesn't match the tag's
version. Recovery:

1. Open a new release PR bumping every package to the next version.
2. Merge, retag with the new version, push.
3. Mark the broken intermediate version as `*unpublished*` in the
   per-package CHANGELOGs (see `packages/gas-oracle/CHANGELOG.md`'s
   v0.2.2 entry for the existing precedent).

Do **not** delete the existing tag.

### Partial publish — some packages succeed, others fail

Possible causes: per-package npm permission issues, npm registry
flake, trusted-publisher record drift. The workflow stops on the
first failure; subsequent publishes won't fire.

Recovery:
1. **Don't try to republish the same version.** npm rejects it. The
   packages that succeeded are now at `vX.Y.Z` on npm.
2. Diagnose the failure (typically npm permissions or trusted
   publisher).
3. Bump every package to `vX.Y.Z+1` in a follow-up release PR.
4. Mark the partially-published version as `*partially published, see
   v0.X.Y+1*` in the affected CHANGELOGs.

For the very rare case where a partial publish needs to be fixed
without a version bump: `npm unpublish` is allowed within 72 hours of
publish for newly-introduced versions. Use only when truly necessary;
unpublishing is generally discouraged.

### Tag pushed but no workflow ran

Possible causes:

1. Tag pattern doesn't match `v*` — e.g., you typed `0.3.0` (no `v`)
   or `gas-oracle/v0.3.0` (legacy per-package format, no longer
   supported). Delete and retag with `vX.Y.Z`.
2. Workflow is disabled — check `gh workflow list`.

### Publish succeeded but consumer can't see new version

Wait 30–60s — npm's CDN is occasionally slow to propagate. If still
missing after a minute:

```bash
npm view @valve-tech/<name> versions --json | jq -r '.[-3:]'
```

If the version is in npm's view but a consumer's lockfile pins to an
older one, that's a consumer-side issue (`yarn up`, `npm update`).

## What the Release workflow actually does

For full reference, `.github/workflows/release.yml` does, in order:

1. `actions/checkout@v4` — pulls the tagged commit (or the input ref
   for `workflow_dispatch`).
2. **Parse the tag** into `version` via a strict regex. Fails fast
   on malformed tags.
3. `setup-node@v4` with `registry-url: 'https://registry.npmjs.org'`
   (required for OIDC negotiation).
4. Upgrades npm to 11.5.1+ (Node 22's default npm 10 has matcher
   quirks against trusted-publisher claims).
5. `corepack enable && yarn install --immutable` — frozen lockfile.
6. **Workspace-wide gate**: `yarn lint && yarn typecheck &&
   yarn typecheck:examples && yarn test && yarn build` — every
   package must be clean for any publish to fire.
7. **Verify all packages are at tag version**: walks `packages/*/`
   and confirms every `package.json#version` matches.
8. Publishes packages in topological order:
   `chain-source` → `gas-oracle` → `tx-tracker`. Each runs
   `npm publish --access public --provenance` — `--provenance`
   attaches the SLSA attestation; `--access public` is required for
   scoped packages.

If any step before publish fails, no publishes run. If a publish step
fails, subsequent publish steps don't run — recover per the partial-
publish guidance above.
