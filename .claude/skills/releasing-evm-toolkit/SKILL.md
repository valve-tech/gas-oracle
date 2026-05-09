---
name: releasing-evm-toolkit
description: Use when cutting a release of the `valve-tech/evm-toolkit` monorepo to npm — bumping every workspace package's version in lockstep, updating per-package CHANGELOGs and the root CHANGELOG, committing on main, tagging with `vX.Y.Z`, and verifying the OIDC publish landed for all six packages (`@valve-tech/chain-source`, `@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`, `@valve-tech/viem-errors`, `@valve-tech/wallet-adapter`, `@valve-tech/tx-flight-react`). Trigger on phrases like "release v0.X.Y", "publish to npm", "ship a release", "cut a release", "bump the toolkit version", "tag this", or when the user has just merged consumer-visible changes and is asking how to get them onto npm. Covers synchronized versioning (all packages move together), the commit message format, the signed-tag requirement, the OIDC publish workflow trigger, the pre-flight `verify:clean` + `verify:release-coverage` gates, the manual-first-publish dance for any new package being added (including adding a Publish step to release.yml), and the common failure modes.
---

# Releasing `valve-tech/evm-toolkit`

The toolkit uses **synchronized versioning** — every release is a
single `vX.Y.Z` tag that bumps **all** publishable workspace packages
in lockstep, and the OIDC publish workflow publishes them all from the
same tag.

There is **no `NPM_TOKEN` secret** — the workflow mints an OIDC JWT
that npm validates against per-package trusted-publisher records. The
publish flow is entirely **tag-driven**.

Every release is one commit on main (no PR — sole maintainer
practice), one signed tag, one workflow run, six `npm publish` calls
(one per package, all from the same workflow execution).

## The end-to-end flow

```
1. Run pre-flight checks: yarn verify:clean && yarn verify:release-coverage
2. Bump every packages/*/package.json to the new version
3. Update every packages/*/CHANGELOG.md and root CHANGELOG.md
4. Commit directly on main:
       git commit -m "chore(release): vX.Y.Z — <short summary>"
5. Sign-tag the release commit:
       git tag -s vX.Y.Z -m "vX.Y.Z — <short summary>"
6. Push commit + tag:
       git push origin main && git push origin vX.Y.Z
       (pre-push hook re-runs verify:release-coverage as belt-and-suspenders)
7. Watch the Release workflow; verify npm shows the new version on
   every package
```

The tag is the publish trigger. Nothing else triggers a publish — not
pushing main, not editing any `package.json`. If the tag isn't pushed,
the version sits in main but is invisible on npm.

## Step-by-step

### 0. Pre-flight: run the gates locally

Two checks mirror what CI enforces:

```bash
# True clean rebuild — the v0.9.1 lesson. Stale dist/ + tsbuildinfo
# can mask topological-build bugs locally even though CI fails. The
# script wipes both, then runs the full lint/typecheck/test/build chain.
yarn verify:clean

# Catches missing publish steps in .github/workflows/release.yml —
# the v0.9.2 lesson. Walks every non-private packages/*/package.json
# and asserts each name has a "Publish <name>" step in release.yml.
# Auto-runs as a pre-push hook too (.githooks/pre-push), but verify
# explicitly here so you don't burn a tag on a missing step.
yarn verify:release-coverage
```

Both also run on every CI build via `.github/workflows/ci.yml`. Skip
this section only if you've run them as part of an immediately prior
verification cycle.

### 1. Bump every package in lockstep

Synced versioning: **every publishable workspace package must be at
the same version**. The release workflow refuses to publish if any
package's version doesn't match the tag.

```bash
# Bump all six in lockstep:
sed -i.bak 's/"version": "0\.X\.Y"/"version": "0.X.Z"/' \
  packages/chain-source/package.json \
  packages/gas-oracle/package.json \
  packages/tx-tracker/package.json \
  packages/viem-errors/package.json \
  packages/wallet-adapter/package.json \
  packages/tx-flight-react/package.json
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

### 3. Commit message — exact format

```
chore(release): v0.3.0 — short summary
chore(release): v0.3.1 — fix idle-traffic bug in chain-source
chore(release): v0.9.3 — add tx-flight-react publish step
```

The release commit goes directly on `main` (sole-maintainer
practice — no PR). Body explains the why; subject stays under 70
chars.

```bash
git add CHANGELOG.md packages/*/CHANGELOG.md packages/*/package.json yarn.lock
git commit -m "$(cat <<'EOF'
chore(release): vX.Y.Z — short summary

[1–3 paragraph body explaining the why, what changed, and any
migration notes for consumers]
EOF
)"
```

**Do not** use `feat:`, `fix:`, etc. for release commits. The release
commit is always `chore(release): vX.Y.Z — <summary>`.

### 4. Sign and push the tag (and the commit)

Tags are SSH-signed in this repo (the `valvecitydev` 1Password key).
If the 1Password SSH agent is locked, tag creation fails with
`failed to fill whole buffer` — see Failure modes below.

```bash
git tag -s vX.Y.Z -m "vX.Y.Z — short summary"
git push origin main          # pushes the release commit
git push origin vX.Y.Z         # the tag is what triggers OIDC publish
```

The pre-push hook (`.githooks/pre-push`) re-runs
`yarn verify:release-coverage` here as a final safety net — a missing
publish step in `release.yml` would reject the push before it lands.

### 5. Verify the publish

```bash
gh run watch $(gh run list --workflow=release.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId') --exit-status
```

Blocks until the workflow finishes; non-zero exit = at least one
publish failed. After success:

```bash
for pkg in chain-source gas-oracle tx-tracker viem-errors wallet-adapter tx-flight-react; do
  printf '%-30s ' "@valve-tech/$pkg"
  npm view "@valve-tech/$pkg@latest" version
done
```

All six should show the new version.

## Adding a NEW package to the monorepo (first publish)

When a brand-new package lands, you cannot publish via the workflow
until the trusted-publisher record exists at npm. The record requires
the package to already exist on npm. Chicken-and-egg. Solution:
**manual first publish from a maintainer's machine**, then configure
the trusted publisher, then add the publish step to release.yml, then
subsequent publishes go through the workflow.

### Pre-flight: package.json metadata that the OIDC publish needs

Before either the manual name-claim or the OIDC publish, copy a
sibling package's full metadata block into the new package's
`package.json`. The OIDC workflow runs `npm publish --provenance`,
which validates the published `package.json#repository.url` against
the GitHub repo URL in the sigstore attestation — a missing or
empty `repository` field fails the publish with HTTP 422 (see
"Workflow fails at npm publish with HTTP 422 — provenance / repo
mismatch" below).

Required fields (mirror `chain-source/package.json` shape):

```jsonc
{
  "homepage": "https://github.com/valve-tech/evm-toolkit/tree/main/packages/<name>#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/valve-tech/evm-toolkit.git",
    "directory": "packages/<name>"
  },
  "bugs": {
    "url": "https://github.com/valve-tech/evm-toolkit/issues"
  },
  "keywords": ["..."]
}
```

**The manual name-claim publish does NOT enforce this** — `npm
publish --access public` (no `--provenance`) accepts a package.json
with no `repository`. So the failure shows up only on the first
OIDC publish, mid-release, after six other packages already shipped
at the new version. Add the metadata before the manual publish to
avoid the recovery dance.

The `private: true` flag (if present in scaffolding) also blocks
`npm publish` outright, even with explicit args. Remove it before
the manual name-claim publish.

### One-time first-publish dance

```bash
# 1. Make sure the package builds locally and dist/ is fresh.
yarn workspace @valve-tech/<name> build

# 2. Sanity-check the tarball contents BEFORE publishing.
cd packages/<name>
npm pack --dry-run
# Verify only the files in package.json#files are listed:
# dist/, README.md, LICENSE, CHANGELOG.md (and AGENTS.md / skills/
# for packages that ship them).

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
| Environment | *(blank — adding one breaks OIDC matching)* |

### Then: add a Publish step to release.yml

**The v0.9.2 lesson** — without this, the workflow runs green and
silently skips the new package on every release.

```yaml
      - name: Publish @valve-tech/<name>
        run: |
          cd packages/<name>
          yarn pack --out=/tmp/<name>.tgz
          npm publish /tmp/<name>.tgz --access public --provenance
```

Order matters: insert it **after** packages it depends on (so
ordering-sensitive consumers see deps publish first). Example —
`tx-flight-react` depends on `chain-source`, `tx-tracker`,
`wallet-adapter`, so its step is last in `release.yml`.

`scripts/verify-release-coverage.mjs` (run via
`yarn verify:release-coverage` in CI and the pre-push hook) will fail
the build if you forget — push is rejected locally, and PRs/main CI
go red.

### Repeat per package

Each package needs its own trusted-publisher record AND its own
Publish step in `release.yml`. TP records all point at the same repo
+ the same workflow file — npm matches per-package.

## Version-bump rules (SemVer, applied uniformly across all packages)

Because versioning is synced, **all six packages bump together** —
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

The toolkit is currently in the `0.9.x` line — pre-1.0 SemVer
applies, but the project practices it strictly anyway. Treat a
public-API rename as breaking even in 0.x.

## When NOT to release

A change that does not touch any path in any package's `files`
allowlist (`dist`, `skills`, `README.md`, `AGENTS.md`, `CHANGELOG.md`,
`LICENSE`) does not change what's on npm and does not need a release.
Examples:

- `.github/workflows/*` edits (CI tweaks)
- `docs/*` edits at root (cross-cutting design notes that aren't shipped)
- `.claude/skills/*` edits (project-local AI skills, not shipped)
- `.githooks/*` edits (git hooks, not shipped)
- `scripts/*` edits (project tooling, not shipped)
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
   verify each published package (`chain-source`, `gas-oracle`,
   `tx-tracker`, `viem-errors`, `wallet-adapter`, `tx-flight-react`)
   has a record matching:
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
for pkg in chain-source gas-oracle tx-tracker viem-errors wallet-adapter tx-flight-react; do
  printf "@valve-tech/%-16s " "$pkg"
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

1. Make a new release commit on main bumping every package to the
   next version.
2. Tag with the new version and push.
3. Mark the broken intermediate version as `*unpublished*` in the
   per-package CHANGELOGs (see `packages/gas-oracle/CHANGELOG.md`'s
   v0.2.2 entry for the existing precedent).

Do **not** delete the existing tag.

### Workflow fails at Build with `TS2307: Cannot find module '@valve-tech/<sibling>'`

**The v0.9.0–v0.9.1 lesson.** A workspace package imports types from
a sibling and the build runs before the sibling's `dist/*.d.ts` is
emitted. Two compounding causes:

1. The importing package declares the sibling only in
   `peerDependencies` (with `peerDependenciesMeta.optional: true`),
   not in `devDependencies` — so Yarn's workspace topo sort doesn't
   know to build the sibling first.
2. The root `build` script uses `--topological` instead of
   `--topological-dev`. `--topological` follows only `dependencies`
   entries; `--topological-dev` also follows `devDependencies`.

Fix: declare the sibling in `devDependencies: workspace:^` (in
addition to `peerDependencies` if consumer-facing) AND keep the root
build at `--topological-dev`. Verify locally with `yarn verify:clean`
(which deletes `dist/` AND `tsconfig.tsbuildinfo` files — `composite:
true` makes tsc incremental, so deleting only dist isn't enough to
force a true rebuild).

### Workflow fails at `npm publish` with HTTP 422 — provenance / repo mismatch

```
npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@valve-tech%2f<name>
  - Error verifying sigstore provenance bundle:
    Failed to validate repository information:
    package.json: "repository.url" is "",
    expected to match "https://github.com/valve-tech/evm-toolkit"
    from provenance
```

**The v0.10.0 lesson.** The package's `package.json` has no
`repository` field (or has one that doesn't match). The OIDC
workflow runs `npm publish --provenance`, which validates
`package.json#repository.url` against the sigstore attestation's
GitHub repo URL — empty / missing / mismatched fails the publish
with HTTP 422.

This bites only the OIDC publish. The manual name-claim publish
(`npm publish --access public` from a maintainer's machine, no
`--provenance`) succeeds even with no `repository` field — so the
package can sit on npm at the 0.0.1 name-claim, the trusted
publisher record can be configured, and the failure only surfaces
mid-release after the workflow has published six other packages.

Fix:
1. Add the missing metadata to the new package's `package.json`
   (see "Pre-flight: package.json metadata that the OIDC publish
   needs" in the "Adding a NEW package" section). At minimum,
   `repository.url` must point at
   `git+https://github.com/valve-tech/evm-toolkit.git`. Mirror a
   sibling's full block (`homepage`, `repository`, `bugs`,
   `keywords`) for consistency.
2. Sync-bump every package to `vX.Y.Z+1` in a follow-up release
   commit. **Don't try to republish the same version** — npm
   rejects it for the packages that already succeeded.
3. Mark the partially-published version as `*partial publish —
   `<name>` missing, see vX.Y.Z+1*` in the affected CHANGELOGs and
   the root CHANGELOG.
4. Push the new tag — OIDC re-publishes the whole line, including
   the previously-failed package.

Prevention: when scaffolding a new package, copy the metadata block
from `chain-source/package.json` (the canonical shape) before the
first manual publish. The `verify:release-coverage` script catches
missing Publish steps in `release.yml` but doesn't catch missing
`repository` fields — that gap is what caused v0.10.0.

### Workflow ran green but a package didn't reach npm

**The v0.9.2 lesson.** The workflow file
`.github/workflows/release.yml` has no `Publish @valve-tech/<name>`
step for the package. The workflow ran end-to-end, all visible steps
green, but the publish was simply never invoked.

Fix: add the Publish step (see "Adding a NEW package" above for the
exact YAML), then bump every package to `vX.Y.Z+1` for a synced
republish — npm rejects same-version republishes. Mark the
incomplete version as `*partial publish — `<name>` missing, see
vX.Y.Z+1*` in affected CHANGELOGs.

The pre-push hook (`.githooks/pre-push`) and ci.yml's "Verify release
coverage" step both run `yarn verify:release-coverage`, which catches
this before any tag is pushed. If you've reached this failure, those
checks were bypassed (e.g., `git push --no-verify`).

### Partial publish — some packages succeed, others fail

Possible causes: per-package npm permission issues, npm registry
flake, trusted-publisher record drift. The workflow stops on the
first failure; subsequent publishes won't fire.

Recovery:
1. **Don't try to republish the same version.** npm rejects it. The
   packages that succeeded are now at `vX.Y.Z` on npm.
2. Diagnose the failure (typically npm permissions or trusted
   publisher).
3. Bump every package to `vX.Y.Z+1` in a follow-up release commit.
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

1. `actions/checkout@v5` — pulls the tagged commit (or the input ref
   for `workflow_dispatch`).
2. **Parse the tag** into `version` via a strict regex. Fails fast
   on malformed tags.
3. `corepack enable` then `setup-node@v5` with
   `registry-url: 'https://registry.npmjs.org'` (required for OIDC
   negotiation).
4. Upgrades npm to 11.5.1+ (Node 22's default npm 10 has matcher
   quirks against trusted-publisher claims).
5. `yarn install --immutable` — frozen lockfile.
6. **Workspace-wide gate**, in this order:
   `yarn build` (topological-dev — emits dist for every package) →
   `yarn lint` → `yarn typecheck` → `yarn typecheck:examples` →
   `yarn test`. Every package must be clean for any publish to fire.
7. **Verify all packages are at tag version**: walks `packages/*/`
   and confirms every `package.json#version` matches.
8. Publishes packages in dependency order:
   `chain-source` → `viem-errors` → `wallet-adapter` → `gas-oracle`
   → `tx-tracker` → `tx-flight-react`. Each runs `yarn pack` (which
   rewrites `workspace:^` to real semver in the tarball's
   package.json) followed by `npm publish --access public
   --provenance`. `--provenance` attaches the SLSA attestation;
   `--access public` is required for scoped packages.

If any step before publish fails, no publishes run. If a publish step
fails, subsequent publish steps don't run — recover per the partial-
publish guidance above.

## What the CI workflow actually does

`.github/workflows/ci.yml` runs on every push to `main` and on PRs
targeting main. Same gate as the Release workflow, plus one extra
check:

- `yarn build` → `yarn lint` → `yarn typecheck` →
  `yarn typecheck:examples` → `yarn test` (matches Release).
- `yarn verify:release-coverage` — fails the build if a non-private
  workspace package lacks a `Publish` step in `release.yml`. Catches
  the v0.9.2 class of bug at PR/main-push time, before any tag is
  cut.

The pre-push hook (`.githooks/pre-push`, wired automatically via the
root `prepare` script's `git config core.hooksPath .githooks`) also
runs `yarn verify:release-coverage` locally, rejecting the push
before it leaves the machine.
