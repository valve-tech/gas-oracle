---
name: contributing-to-gas-oracle
description: Use when modifying any file under `src/`, `examples/`, `skills/`, or top-level config in the `@valve-tech/gas-oracle` repo, when adding a feature or fixing a bug in the package, when reviewing a PR against this repo, or when an AI agent first opens any file in this codebase to understand it before changing anything. Covers the codebase's architectural invariants (primitive layer, I/O / pure split, no silent downgrade), where every file lives and what it owns, the anti-patterns that have been deliberately rejected, and the verification checks every change must pass before opening a PR. Read this BEFORE writing code in the repo, not after.
---

# Contributing to `@valve-tech/gas-oracle`

This skill grounds AI agents working **inside** this repo — making changes,
adding features, fixing bugs, reviewing PRs. For agents working in a
**downstream project** that imports the package, see
`skills/gas-oracle-integration/SKILL.md` instead (that one ships in the
npm tarball).

## Architectural invariants — do not break these

These are load-bearing design rules. Violating them silently in a PR is
the most common way to introduce regressions that don't surface until
months later. Memory at `~/.claude/projects/.../memory/` has the long
form; this is the operating summary.

### 1. Primitive layer — pure functions over snapshots

`src/mempool.ts`, `src/block-position.ts`, `src/math.ts`, `src/samples.ts`
are **pure**. No I/O, no wall-clock, no per-tx state, no long-lived
listeners. Tests fixture them with literal inputs.

`src/oracle.ts` is the *only* stateful surface in v0.2.x: it owns one
poll-interval timer per chain, retains the latest `GasOracleState`, and
exposes a subscriber list. State is **singular** (one per chain, predictable
shape) — not unbounded.

Any feature request that adds **per-tx state** (tx-tracker, TxStatus
subscriptions, "watch this hash") is a step up from this model and
must be scoped explicitly — see `docs/tx-tracker-spec.md` (when written)
or the project memory note `architecture-primitive-layer.md`. It does
**not** go into `oracle.ts`; it goes into a new sub-export.

### 2. I/O and math are exported separately

`fetchOracleInputs` (in `src/transport.ts`, the I/O surface) and
`reducePollInputs` (in `src/oracle.ts`, pure) are **both** top-level
exports from `src/index.ts`. This split is what enables the offline
path — serverless / backtest / fixture-driven callers run the reducer
without ever holding a `PublicClient`.

Do **not** collapse these into one `start()`-only surface. Do not
hide `reducePollInputs` behind the factory. The split is the
contract for the "no live RPC" use case documented in the README.

### 3. No silent downgrade — surface capability in the result

When upstream RPC capability varies (gated `txpool_content`, missing
`excessBlobGas`, no WS subscription, etc.), the package **never picks
a default that silently makes the answer different across providers**.

The canonical example: `eth_gasPrice` and `eth_maxPriorityFeePerGas`
in `viem-transport.ts` reject a boolean intercept opt-in — they require
an explicit tier name, because a default tier choice would silently
make the method's number depend on the package version.

Apply this rule to **any** new feature that consumes a capability that
might be missing. Surface the capability in the result type
(`source: 'mempool' | 'receipt-poll-only'`, `txType: 0 | 2 | undefined`),
never in a default that hides it.

### 4. Browser/mobile safe — no Node-only imports in `src/`

`src/` must build cleanly for browser/edge runtimes. No `events`,
no `fs`, no `path`, no `process` (except for `process.env` if absolutely
necessary, and even that is suspect). The only runtime dep is the
viem peer.

Holding a WS socket is expensive on mobile — the package is designed
to be safe to import there. Any subscription-using feature must keep
this true (sub-export it, don't pollute the primitive layer).

### 5. Wire format — bigints internally, hex at boundaries

Every fee field in this package is `bigint`. JSON has no native bigint
and `JSON.stringify(state)` will throw. Callers serializing to HTTP /
Redis / WebSocket hex-encode (`'0x' + n.toString(16)`).

Don't add `toJSON` methods or `Number()` casts in `src/` to "make it
serializable" — that's the consumer's boundary problem and the package
deliberately keeps the canonical numeric form.

## File map — where everything lives

```
src/
├── index.ts            Public API surface. Re-exports only — NO LOGIC.
│                       Adding a new export means adding one line here.
├── oracle.ts           createGasOracle factory + reducePollInputs reducer.
│                       The only stateful file in the package.
├── transport.ts        fetchOracleInputs + safeRequest pattern.
│                       Wraps client.request, turns "method not supported"
│                       into null. Adds a new RPC = a new safeRequest call.
├── math.ts             Pure numeric primitives: effectiveTip,
│                       computePercentiles, computeTiers, detectTrend,
│                       cappedTip, computeBlobBaseFee, etc.
├── samples.ts          Adapters from RPC shapes to TipSample/BlockSample.
│                       blockToSample(block), mempoolToSamples(pool, baseFee).
├── mempool.ts          normalizeMempool + findByHash / findByAddressNonce /
│                       findInMempool. Lookups are O(1) — pre-build the index
│                       at normalize time, don't scan in the lookup.
├── block-position.ts   tipForBlockPosition + the discriminated query union.
├── types.ts            Shared types only. NO LOGIC.
├── viem-actions.ts     gasOracleActions(opts) — viem client.extend() entry.
├── viem-transport.ts   withGasOracle(transport, opts) — Transport wrapper
│                       with intercept config.
└── *.test.ts           Vitest specs colocated with their subject file.

examples/
├── 0N-*.ts             Numbered runnable scripts. Each opens with a
│                       comment block + `Run with: yarn tsx examples/0N-*.ts`.
└── tsconfig.json       Examples have their own tsconfig (typecheck:examples).

docs/
└── *.md                Long-form docs (specs, design notes). Lowercase-kebab.

skills/
└── gas-oracle-integration/SKILL.md
                        SHIPS in npm tarball. For AI agents in DOWNSTREAM
                        consumers' projects. Don't put repo-internal advice
                        here — it ends up in everyone's node_modules.

.claude/
└── skills/             Project-local AI skills. Does NOT ship.
                        This file is one of them. New contributor-facing
                        skills go here.

.github/workflows/
├── ci.yml              Runs on every PR: lint, typecheck, typecheck:examples,
│                       test, build.
└── release.yml         Fires on tag push v*. Lints, typechecks, tests, builds,
│                       publishes to npm via OIDC trusted publisher.
                        No NPM_TOKEN secret involved.

AGENTS.md               Top-level. AI-first reference for CONSUMERS.
README.md               Top-level. Human-facing.
CHANGELOG.md            Keep-a-Changelog format. Updated for every release.
package.json            version, exports map, peerDependencies (viem ^2),
                        files allowlist (controls what ships to npm).
```

## Code style — the parts that matter most here

The repo follows the user's global standards (see `~/.claude/CLAUDE.md`
"Code Style"). The deltas / emphases that matter most for this codebase:

- **No nested conditionals.** Early-return guard clauses. The reducer
  in `oracle.ts:reducePollInputs` is the model — every shape conversion
  is its own block, and the function returns null early when block input
  is missing.
- **No `any`.** Lint enforces it as an error in `src/`. Tests are allowed
  the occasional `as never` for unsupported viem method strings, used
  exactly once in `transport.ts:83` and called out by comment.
- **Imports use `.js` extensions** (e.g. `from './math.js'`). This is
  TypeScript's NodeNext ESM convention — the source is `.ts` but the
  emitted module specifier is `.js`. Don't drop the extension, the
  build will break.
- **JSDoc on every export.** Intellisense surfaces these in consumers'
  editors. The existing files are the standard to match. Long comment
  blocks at the top of each file describe the file's role and
  rationale — keep them when refactoring.
- **One responsibility per file.** Math stays in `math.ts`. Adapters
  in `samples.ts`. I/O in `transport.ts`. Tests don't mix layers.
- **Test the behavior, not the implementation.** Every `*.test.ts` is
  fixture-driven. New numeric primitives need direct percentile-math
  tests in `math.test.ts`; new RPC adapters need shape tests in
  `samples.test.ts`; new oracle behaviors need reducer-tests using
  fixture `OraclePollInputs`. **173 tests today**; that number should
  go up with every behavior-changing PR.

## Pre-PR checks (run all of these)

```bash
yarn typecheck            # tsc --noEmit on src/. Must be silent.
yarn typecheck:examples   # tsc on examples/. Catches when an example
                          # drifts behind a public-API rename.
yarn lint                 # eslint src/. New warnings are not OK; the
                          # two pre-existing warnings in *.test.ts are
                          # known and unrelated to your change.
yarn test                 # Vitest. All 173 tests pass. New behavior
                          # = new tests, not just regression coverage.
yarn build                # tsc -p .. Produces dist/. Smoke-checks that
                          # the exports map resolves and types are emitted.
```

If your change touches an example or its supporting code, also actually
**run** it end-to-end:

```bash
yarn dlx tsx examples/0N-thing-you-changed.ts
```

Don't claim "the example still works" without doing this — typecheck
is necessary but not sufficient.

## Anti-patterns specific to this codebase

These have all been considered and rejected. Don't reintroduce them:

1. **A default tier choice on standard-method intercepts.** `eth_gasPrice`
   / `eth_maxPriorityFeePerGas` require an explicit tier name. The
   silently-pick-a-percentile foot-gun is the design's primary
   anti-pattern.
2. **Silently degrading to block-only when mempool is gated.** It's
   fine to *operate* on partial data (the oracle does), but the
   degradation must be observable — `state.mempool.pendingCount === 0`
   when `txpool_content` was rejected, the snapshot is `null`, not
   stale. Don't paper over it.
3. **Adding per-tx state to `oracle.ts`.** That's a v2-track architectural
   step. New stateful surfaces sub-export from a separate file
   (e.g. `tx-tracker.ts`).
4. **A runtime dependency.** Zero runtime deps is a feature. viem is
   the only peer. Never `yarn add` to `dependencies` without a thread
   with the maintainer.
5. **Holding a WS socket in the primitive layer.** The package is safe
   to import on mobile. New subscription-using features go in their
   own sub-export with their own lifecycle.
6. **Synthesizing `eth_feeHistory` from oracle state.** The viem-transport
   intercept config explicitly does NOT cover `eth_feeHistory` — that's
   its own design problem. Passthrough is the only honest answer. Don't
   "improve" this without scoping it as its own change.
7. **`JSON.stringify` on a `GasOracleState`.** It throws on bigints.
   The oracle keeps numeric form internally; the caller hex-encodes
   at the wire boundary.
8. **Adding behavior to `index.ts` or `types.ts`.** They contain only
   re-exports / type declarations. Logic goes in a topic file.

## When you're stuck — escalation order

1. Read the file's top-of-file comment block. Most "why" questions are
   answered there.
2. Read the colocated `*.test.ts`. The fixtures show intended inputs.
3. Read `AGENTS.md` (consumer reference) and `README.md` (human docs).
4. Read the project memory at
   `~/.claude/projects/.../memory/MEMORY.md` and the linked files —
   they capture "why is this shaped this way" decisions that the code
   alone doesn't explain.
5. If still stuck: surface the question in your response. Do not
   pattern-match a fix that you don't fully understand the trade-offs of.

## Version / release coupling

A change that touches consumer-visible behavior (`src/`, `dist/`,
`README.md`, `AGENTS.md`, `examples/`, `skills/`) needs a version bump
and a CHANGELOG entry **in the same PR**. The repo's release pattern:
PR title is `chore(release): vX.Y.Z — short summary`, squash-merged,
then a signed tag `vX.Y.Z` push fires the publish workflow.

A change that only touches `.claude/`, `docs/`, `.github/`, or other
non-published files does **not** need a version bump. The `package.json`
`files` allowlist is the source of truth for "is this consumer-visible"
— if the path isn't listed there, it doesn't ship.

For the full release workflow, see `releasing-gas-oracle/SKILL.md`.
