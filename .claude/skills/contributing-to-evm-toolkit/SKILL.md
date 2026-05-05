---
name: contributing-to-evm-toolkit
description: Use when modifying any file under `packages/`, `examples/`, top-level config, or the `.github/` workflows in the `valve-tech/evm-toolkit` monorepo, when adding a feature or fixing a bug in any of its three packages (`@valve-tech/chain-source`, `@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`), when reviewing a PR, or when an AI agent first opens any file in this codebase to understand it before changing anything. Covers the monorepo layout, the architectural invariants shared across packages (primitive layer, ChainSource as shared foundation, no silent downgrade, browser/mobile safety, bigint wire format), per-package responsibilities and what does NOT belong in each, the verification checks every change must pass, and the per-package release coupling. Read this BEFORE writing code in the repo, not after.
---

# Contributing to `valve-tech/evm-toolkit`

This skill grounds AI agents working **inside** this monorepo —
making changes, adding features, fixing bugs, reviewing PRs across
`@valve-tech/chain-source`, `@valve-tech/gas-oracle`, and
`@valve-tech/tx-tracker`. For agents working in a **downstream
project** that imports any of those packages, see the per-package
skill that ships in the npm tarball
(e.g. `node_modules/@valve-tech/gas-oracle/skills/gas-oracle-integration/SKILL.md`).

## Architectural invariants — do not break these

These are load-bearing design rules. They apply across every package
in the workspace.

### 1. Three-layer composition — `ChainSource` is the foundation

The clean layering for the toolkit is **three layers**, each
consuming only the layer below:

```
PublicClient (viem) → ChainSource → { GasOracle, TxTracker }
```

`@valve-tech/gas-oracle` and `@valve-tech/tx-tracker` are **siblings**.
Neither depends on the other; both consume the same `ChainSource`
interface. Multiple subscribers per `ChainSource` stream are
first-class — one upstream RPC poll cycle feeds every consumer
attached.

When adding a new derived view of chain state (a future fourth
package?), follow the same shape: consume `ChainSource`, don't
piggyback on either of the existing siblings.

### 2. Primitive layer — pure functions over snapshots

The math layer in each package (`packages/gas-oracle/src/math.ts`,
`packages/gas-oracle/src/samples.ts`, `packages/gas-oracle/src/mempool.ts`,
`packages/gas-oracle/src/block-position.ts`, and the equivalents to
come in chain-source / tx-tracker) is **pure**. No I/O, no
wall-clock, no per-tx state, no long-lived listeners. Tests fixture
them with literal inputs.

Stateful surfaces (the oracle's poll cycle in `packages/gas-oracle/src/oracle.ts`,
the source's poll cycle in `packages/chain-source/src/`, the tracker's
per-tx state machine in `packages/tx-tracker/src/`) own their state
explicitly and isolate it from the math.

### 3. No silent downgrade — surface capability in the result

When upstream RPC capability varies (gated `txpool_content`, missing
`excessBlobGas`, no WS subscription support, `eth_getTransactionReceipt`
unavailable, etc.), the toolkit **never picks a default that silently
makes the answer different across providers**.

The canonical example: `eth_gasPrice` and `eth_maxPriorityFeePerGas`
in `packages/gas-oracle/src/viem-transport.ts` reject a boolean
intercept opt-in — they require an explicit tier name, because a
default tier choice would silently make the method's number depend
on the package version.

In `chain-source` and `tx-tracker`: every emitted event carries a
`source` discriminator (`'subscription' | 'block-poll' |
'mempool-snapshot' | 'receipt-poll'`) so consumers know how
authoritative the observation is.

Apply this rule to **any** new feature that consumes a capability
that might be missing.

### 4. Browser/mobile safe — no Node-only imports in `packages/*/src/`

Every package must build cleanly for browser / edge / React Native
runtimes. No `events` (Node's EventEmitter), no `fs`, no `path`, no
`setImmediate`, no Node-only Buffer manipulation. The internal
pub/sub primitive in tx-tracker / chain-source is hand-rolled for
this reason — see `docs/tx-tracker-spec.md` §5.1.

Holding a WS socket is expensive on mobile — the package is designed
to be safe to import there. Any subscription-using feature must keep
this true.

### 5. Wire format — bigints internally, hex at boundaries

Every fee field, block number, gas value, and timestamp in the
toolkit is `bigint`. `JSON.stringify(state)` will throw without
hex-encoding at the wire boundary. Persistence stores
(`@valve-tech/tx-tracker`'s `TxTrackerStore` implementations) are
the boundary — they hex-encode on write, decode on read.

Don't add `toJSON` methods or `Number()` casts in `packages/*/src/`
to "make it serializable" — that's the consumer's boundary problem
and the toolkit deliberately keeps the canonical numeric form.

## Repo layout

```
evm-toolkit/                    repo root, package name @valve-tech/evm-toolkit (private)
├── packages/
│   ├── chain-source/           @valve-tech/chain-source — shared foundation
│   │   ├── src/                pure code + tests colocated as *.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.json       extends ../../tsconfig.base.json
│   │   ├── README.md
│   │   └── LICENSE
│   ├── gas-oracle/             @valve-tech/gas-oracle — gas-tier reducer
│   │   ├── src/                same shape as chain-source
│   │   ├── examples/           runnable .ts samples (numbered)
│   │   │   └── tsconfig.json   own tsconfig (typecheck:examples target)
│   │   ├── skills/             SHIPS in npm tarball — for downstream
│   │   │   gas-oracle-integration/  consumers' AI agents
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── README.md
│   │   ├── AGENTS.md           consumer-facing AI ref (ships in tarball)
│   │   ├── CHANGELOG.md        per-package, Keep-a-Changelog format
│   │   ├── LICENSE
│   │   └── .npmignore
│   └── tx-tracker/             @valve-tech/tx-tracker — per-tx state machine
│       └── (same shape as chain-source)
├── docs/                       cross-cutting design docs (tx-tracker-spec.md)
├── .claude/skills/             project-local AI skills — does NOT ship to npm
│   ├── contributing-to-evm-toolkit/    this file
│   └── releasing-evm-toolkit/          synced release flow (single vX.Y.Z tag)
├── examples/                   future cross-package examples (currently empty)
├── .github/workflows/
│   ├── ci.yml                  runs lint/typecheck/test/build at workspace root
│   └── release.yml             tag-driven, synced via single `v*` pattern
├── package.json                root: "private": true, workspaces, hoisted dev-deps
├── tsconfig.base.json          shared compiler options; per-package extends
├── eslint.config.js            workspace-wide
├── .gitignore
└── README.md                   umbrella overview pointing at each package
```

## Code style — the parts that matter most here

The repo follows the user's global standards (see
`~/.claude/CLAUDE.md` "Code Style"). The deltas / emphases that
matter most for this codebase:

- **No nested conditionals.** Early-return guard clauses. The reducer
  in `packages/gas-oracle/src/oracle.ts:reducePollInputs` is the
  model — every shape conversion is its own block, and the function
  returns null early when block input is missing.
- **No `any`.** Lint enforces it as an error in `src/`. Tests are
  allowed the occasional `as never` for unsupported viem method
  strings, used exactly once in
  `packages/gas-oracle/src/transport.ts:83` and called out by comment.
- **Imports use `.js` extensions** (e.g. `from './math.js'`). This is
  TypeScript's NodeNext ESM convention — the source is `.ts` but the
  emitted module specifier is `.js`. Don't drop the extension, the
  build will break.
- **Cross-package imports use the package name**
  (`from '@valve-tech/chain-source'`), never relative paths
  (`from '../../chain-source/src/index.js'`). Yarn workspaces
  symlink-resolves the package name to the workspace; relative paths
  break the moment the package gets published.
- **JSDoc on every export.** Intellisense surfaces these in
  consumers' editors. The existing files are the standard to match.
- **One responsibility per file.** Math stays in `math.ts`. Adapters
  in `samples.ts`. I/O in `transport.ts` / `chain-source/source.ts`.
  Tests don't mix layers.
- **Test the behavior, not the implementation.** Every `*.test.ts`
  is fixture-driven. New behavior = new tests, not just regression
  coverage.

## Pre-PR checks — run all of these from the workspace root

```bash
yarn typecheck            # tsc --noEmit on every package's src/. Silent.
yarn typecheck:examples   # tsc on packages/gas-oracle/examples/.
yarn lint                 # eslint across packages. Pre-existing
                          # warnings in oracle.test.ts and transport.test.ts
                          # are known; new warnings are not OK.
yarn test                 # Vitest across every package. All tests pass.
yarn build                # tsc -p . per package. Produces dist/ in each.
```

If your change touches an example or its supporting code, also
actually **run** it end-to-end:

```bash
cd packages/gas-oracle && yarn dlx tsx examples/0N-thing-you-changed.ts
```

Don't claim "the example still works" without doing this — typecheck
is necessary but not sufficient.

## Per-package responsibilities

### `@valve-tech/chain-source`

Owns: the upstream poll cycle, the capability probe, the multi-subscriber
fan-out for blocks + mempool. **Stateless about per-tx anything.**
Knows nothing about gas tiers. Exposes `subscribeBlocks`,
`subscribeMempool`, `getBlock`, `getReceipt`, `getTransaction`,
`getMempoolSnapshot`, `getFeeHistory`, `capabilities`.

Does NOT belong here:
- gas-tier math
- per-tx state machines
- store interfaces
- editorial event names

### `@valve-tech/gas-oracle`

Owns: the gas-tier reducer (slow / standard / fast / instant), the
downside-decay cap, EIP-1559 priority cutoff, EIP-4844 blob fee,
viem-actions / viem-transport extension surfaces.

Consumes (in v0.3.0+): `ChainSource` for upstream signals.

Does NOT belong here:
- per-tx state
- subscription-using features
- arbitrary RPC fan-out (that's chain-source's job)

### `@valve-tech/tx-tracker`

Owns: the per-tx state machine, the `TxEvent` discriminated union,
`TxTrackerStore` interface + in-memory default, bulk subscriptions,
reorg detection.

Consumes: `ChainSource` for upstream signals.

Does NOT belong here:
- gas tier computation
- editorial verbs (`confirmed`, `failed`, `stuck` — see
  `docs/tx-tracker-spec.md` §2.1)
- retry / replacement / cancellation logic (that's a downstream
  library that USES tx-tracker)

## Anti-patterns specific to this codebase

These have all been considered and rejected. Don't reintroduce them:

1. **A default tier choice on standard-method intercepts.**
2. **Silently degrading to block-only when mempool is gated.** Make
   the degradation observable.
3. **Adding per-tx state to the gas-oracle package.** Wrong layer.
4. **A runtime dependency** beyond viem peer.
5. **Holding a WS socket in the primitive layer.**
6. **Synthesizing `eth_feeHistory` from oracle state** — passthrough
   is the only honest answer until that's its own design problem.
7. **`JSON.stringify` on a state with bigints.** Hex-encode at the
   wire boundary.
8. **Adding behavior to `index.ts` or `types.ts`.** Re-exports / type
   declarations only.
9. **Editorial event names in tx-tracker** (`confirmed`, `failed`,
   `dropped`, `stuck`). Neutral observations only.
10. **Re-implementing the poll loop in oracle or tracker.** That's
    chain-source's responsibility.
11. **Cross-package imports via relative paths.** Use the package
    name.

## When you're stuck — escalation order

1. Read the file's top-of-file comment block. Most "why" questions
   are answered there.
2. Read the colocated `*.test.ts`. The fixtures show intended
   inputs.
3. Read `packages/gas-oracle/AGENTS.md` (consumer reference) and
   `packages/gas-oracle/README.md` (human docs).
4. Read `docs/tx-tracker-spec.md` for the v0.3.0 design contract.
5. Read the project memory at
   `~/.claude/projects/.../memory/MEMORY.md` and the linked files —
   they capture "why is this shaped this way" decisions that the
   code alone doesn't explain.
6. If still stuck: surface the question in your response. Do not
   pattern-match a fix that you don't fully understand the
   trade-offs of.

## Version / release coupling

**Versioning is synced across all packages.** A change to any
package that touches consumer-visible behavior (its `dist/`,
`README.md`, `AGENTS.md`, `examples/` referenced from its README, or
`skills/`) bumps **every** package in the workspace to the same new
version, even ones with no functional changes. Per-package CHANGELOG
entries note "Synchronized release — no changes to this package" for
the no-op case.

The repo's release pattern: PR title is
`chore(release): vX.Y.Z — short summary`, squash-merged, then a
signed tag `vX.Y.Z` push fires the publish workflow which publishes
all three packages in topological order.

A change that only touches `.claude/`, `docs/`, `.github/`, root
configs, or other non-published files does **not** need any version
bump in any package. Each package's `package.json` `files` allowlist
is the source of truth for "is this consumer-visible" — if the path
isn't listed there for any package, nothing ships.

For the full release workflow, see
`.claude/skills/releasing-evm-toolkit/SKILL.md`.

## Rebasing a feature branch over a synced-bump release

A predictable conflict shape arises when a feature PR sits open
across one or more synchronized version bumps merging into `main`.
The collision is always in `packages/<your-package>/CHANGELOG.md`,
and it's mechanical, not semantic:

- **Branch side:** added an `[Unreleased]` section between the file
  header and the previous `[X.Y.Z]` section.
- **Main side:** added one (or more) new `[A.B.C]` synced-bump
  sections in the **same slot** between the header and that same
  previous `[X.Y.Z]`.

Resolution is always "keep both, in order": `[Unreleased]` first
(top of the still-in-flight changes), then every newer
`[A.B.C]` section main introduced, then the existing tail. No
content needs to be merged inside any single section — the
synced-bump entries are independent of whatever the feature branch
changed.

Two more notes about this pattern:

- **No version bump in your CHANGELOG.** The feature branch keeps
  its `[Unreleased]` section as-is — it'll get promoted to a real
  version number whenever the next synced release PR lands, not as
  part of the rebase.
- **Cross-references are already written.** When a synced-bump
  release lands while a feature PR is in flight, that release's
  CHANGELOG entry typically calls out the in-flight PR by number
  (e.g. *"the v0.3.x ChainSource implementation track is unaffected
  by this release and remains in flight under PR #12"*). You don't
  need to add a back-pointer from `[Unreleased]` to the synced
  bumps — the synced bumps already point forward at you.

If the feature branch touches files **outside** `CHANGELOG.md` that
collide with a synced-bump's edits, that's a different problem
(usually the synced bump touched `package.json` versions, root
`package.json`, or the release workflow). Resolve those on a
case-by-case basis — they're not mechanical the way the CHANGELOG
collision is.
