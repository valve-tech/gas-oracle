---
name: contributing-to-evm-toolkit
description: Use when modifying any file under `packages/`, `examples/`, `scripts/`, top-level config, or the `.github/` workflows in the `valve-tech/evm-toolkit` monorepo, when adding a feature or fixing a bug in any of its six packages (`@valve-tech/chain-source`, `@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`, `@valve-tech/viem-errors`, `@valve-tech/wallet-adapter`, `@valve-tech/tx-flight-react`), when reviewing a change, or when an AI agent first opens any file in this codebase to understand it before changing anything. Covers the monorepo layout, the architectural invariants shared across packages (primitive layer, ChainSource as shared foundation, no silent downgrade, browser/mobile safety, bigint wire format, workspace devDeps + topological-dev build), per-package responsibilities and what does NOT belong in each, the verification checks every change must pass (including verify:clean and verify:release-coverage), and the per-package release coupling. Read this BEFORE writing code in the repo, not after.
---

# Contributing to `valve-tech/evm-toolkit`

This skill grounds AI agents working **inside** this monorepo —
making changes, adding features, fixing bugs, reviewing changes across
the six published packages: `@valve-tech/chain-source`,
`@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`,
`@valve-tech/viem-errors`, `@valve-tech/wallet-adapter`, and
`@valve-tech/tx-flight-react`. For agents working in a **downstream
project** that imports any of those packages, see the per-package
skill that ships in the npm tarball
(e.g. `node_modules/@valve-tech/gas-oracle/skills/gas-oracle-integration/SKILL.md`).

## Architectural invariants — do not break these

These are load-bearing design rules. They apply across every package
in the workspace.

### 1. Layered composition — `ChainSource` is the foundation for chain-watching

The chain-observation half of the toolkit layers like this:

```
PublicClient (viem) → ChainSource → { GasOracle, TxTracker }
```

`@valve-tech/gas-oracle` and `@valve-tech/tx-tracker` are **siblings**
on top of `ChainSource`. Neither depends on the other; both consume
the same `ChainSource` interface. Multiple subscribers per
`ChainSource` stream are first-class — one upstream RPC poll cycle
feeds every consumer attached.

The other three packages are independent of `ChainSource`:

- `@valve-tech/viem-errors` — pure cause-chain utilities. No I/O, no
  upstream signal at all.
- `@valve-tech/wallet-adapter` — framework-agnostic vocabulary +
  helpers for dapp wallet integration. Uses viem directly; doesn't
  consume `ChainSource`.
- `@valve-tech/tx-flight-react` — React UI primitives. Composes
  `tx-tracker` + `wallet-adapter` via dynamic import (so consumers
  paying for tree-shaking don't pull either in unless they use the
  matching add path).

When adding a new derived view of chain state, follow the same
shape: consume `ChainSource`, don't piggyback on either of the
existing siblings.

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
│   ├── tx-tracker/             @valve-tech/tx-tracker — per-tx state machine
│   │   └── (same shape as gas-oracle, plus skills/ subdirectory)
│   ├── viem-errors/            @valve-tech/viem-errors — cause-chain utilities
│   │   └── (same shape as chain-source — pure, no chain interaction)
│   ├── wallet-adapter/         @valve-tech/wallet-adapter — wallet vocabulary
│   │   └── (same shape as chain-source)
│   └── tx-flight-react/        @valve-tech/tx-flight-react — React UI primitives
│       └── (same shape, plus storage/ subpath at @valve-tech/tx-flight-react/storage)
├── docs/                       cross-cutting design docs (tx-tracker-spec.md, etc.)
├── .claude/skills/             project-local AI skills — does NOT ship to npm
│   ├── contributing-to-evm-toolkit/    this file
│   ├── extending-tx-tracker/           tx-tracker internals (project-local)
│   └── releasing-evm-toolkit/          synced release flow (single vX.Y.Z tag)
├── .githooks/                  versioned git hooks (NOT shipped)
│   └── pre-push                runs verify:release-coverage before push
├── scripts/                    project tooling (NOT shipped)
│   └── verify-release-coverage.mjs   asserts release.yml has Publish step per pkg
├── examples/                   future cross-package examples (currently empty)
├── .github/workflows/
│   ├── ci.yml                  runs lint/typecheck/test/build + verify:release-coverage
│   └── release.yml             tag-driven; six Publish steps, OIDC trusted-publisher
├── package.json                root: "private": true, workspaces, prepare = hooks-path wiring
├── tsconfig.base.json          shared compiler options; per-package extends (composite: true)
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

## Project style — no magic strings

Every string-union type lands as a const-namespace pair: the value object (`as const`) and the derived type alias share the identifier. Call sites reference the const, never the bare literal.

```ts
export const PriorityModel = {
  flat: 'flat',
  eip1559: 'eip1559',
} as const
export type PriorityModel = (typeof PriorityModel)[keyof typeof PriorityModel]

// At call sites:
if (model === PriorityModel.flat) { ... }     // ✓
if (model === 'flat') { ... }                  // ✗ — magic string
```

Examples in the codebase: `PriorityModel`, `TierName`, `Trend`, `TxType` (gas-oracle), more emerging across other packages over time. When you add a new string-union type, this is the shape.

## Project style — bigint discipline

Numeric values that participate in math are `bigint`. Convert to `number` only at JS-platform-API boundaries:

- `arr[Number(i)]` for array indexing where `i: bigint`
- `setInterval(_, Number(ms))` for timers
- `BigInt(arr.length)` to lift array length into bigint math

```ts
// ✓ — math in bigint, conversion only at array access
const samplesLen = BigInt(sorted.length)
let gasFromTop = 0n
for (let i = 0n; i < rank; i += 1n) {
  gasFromTop += sorted[Number(i)].gas
}

// ✗ — number propagates through arithmetic
let gasFromTop = 0
for (let i = 0; i < rank; i += 1) {
  gasFromTop += Number(sorted[i].gas)
}
```

**Carve-out**: identifier-like fields that never participate in math stay `number`: `chainId`, EIP-2718 type bytes (`TxType` values, `RawTx.type`).

## Pre-commit checks — run all of these from the workspace root

```bash
yarn build                # tsc -p . per package via foreach --topological-dev.
                          # Produces dist/ in each. Workspace devDeps drive
                          # build ordering; --topological alone misses them
                          # (the v0.9.1 lesson).
yarn lint                 # eslint across packages. Pre-existing
                          # warnings in oracle.test.ts and transport.test.ts
                          # are known; new warnings are not OK.
yarn typecheck            # tsc --noEmit on every package's src/. Silent.
yarn typecheck:examples   # tsc on packages/gas-oracle/examples/.
yarn test                 # Vitest across every package. All tests pass.
```

Two extra gates exist for release-adjacent work:

```bash
yarn verify:clean         # Wipes packages/*/dist + packages/*/tsconfig.tsbuildinfo
                          # before running the full chain above. Mirrors what CI
                          # actually does on a fresh checkout. Catches
                          # incremental-rebuild bugs that pass against stale
                          # state but fail in CI.
yarn verify:release-coverage   # Asserts every non-private workspace package has
                                # a `Publish <name>` step in .github/workflows/release.yml.
                                # Also runs as a pre-push hook (.githooks/pre-push).
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
reorg detection, the Provex upstream verbs (`watchTransaction`,
`replaceTransaction`) and the Promise-based companions
(`waitForTransaction`, `waitForPending`).

Consumes: `ChainSource` for upstream signals.

Does NOT belong here:
- gas tier computation
- editorial verbs (`confirmed`, `failed`, `stuck` — see
  `docs/tx-tracker-spec.md` §2.1)
- retry / cancellation logic (that's a downstream library that USES
  tx-tracker)
- React-specific concerns (that's `tx-flight-react`'s job)

### `@valve-tech/viem-errors`

Owns: cause-chain-aware error utilities for viem-based dapps —
`isUserRejectionError`, decoded custom-error name extraction,
`mapErrorToFriendlyMessage`, wagmi-style onError sink helpers.

Consumes: viem (peer dep). Pure functions, no I/O, no state.

Does NOT belong here:
- chain interaction (it's a pure cause-chain walker)
- React/UI concerns
- gas / tx-tracking primitives

### `@valve-tech/wallet-adapter`

Owns: framework-agnostic vocabulary and helpers for EVM dapp wallet
integration — the `WalletAdapter` interface, `WriteHookParams`
lifecycle (`onAwaitingSignature`, `onTransactionHash`, `onConfirmed`,
`onFailed`, `onDropped`, `onReplaced`), `onPhase` discriminated-union
shape, `sendTransactionWithHooks` /  `awaitReceiptWithHooks` helpers,
typed `WalletRejectedError` / `ContractRevertedError`, and
`TX_STATUS` / `TX_FLOW` / `TrackedTx` for tx-state UI.

Consumes: `viem-errors` (for typed error classification) + viem.

Does NOT belong here:
- chain-watching subscriptions (use `chain-source` directly if you
  need them)
- per-tx state machines (use `tx-tracker` if you need them)
- React-specific concerns (that's `tx-flight-react`'s job)

### `@valve-tech/tx-flight-react`

Owns: React UI primitives for an in-flight transaction strip —
`<TxFlightProvider>`, `useTxFlight()` with three add shapes
(`addWithWalletAdapter`, `addByHash`, `addManual`), atomic + layout
components, pluggable storage adapters (localStorage / IndexedDB /
memory) at the `/storage` subpath.

Consumes: `wallet-adapter` (types-only static import) + `tx-tracker`
+ `chain-source` (dynamic-imported only when `addByHash` is used).

The dynamic-import shape is **deliberate** — consumers using only
`addWithWalletAdapter` don't pay the bundle cost of pulling
`tx-tracker` + `chain-source`. The three siblings are declared as
optional `peerDependencies` AND as `devDependencies` (the v0.9.0
lesson — `peerDependencies` alone don't drive workspace topo
ordering in CI).

Does NOT belong here:
- non-React UI primitives
- new lifecycle vocabulary (extend `wallet-adapter`'s vocabulary
  rather than inventing a parallel one here)

## Anti-patterns specific to this codebase

These have all been considered and rejected. Don't reintroduce them:

1. **A default tier choice on standard-method intercepts.**
2. **Silently degrading to block-only when mempool is gated.** Make
   the degradation observable.
3. **Adding per-tx state to the gas-oracle package.** Wrong layer.
4. **A runtime dependency** beyond viem peer (and same-toolkit
   workspace siblings declared explicitly).
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
12. **Workspace siblings declared only in `peerDependencies` when
    `tsc -p .` imports their types.** Yarn's `--topological-dev`
    follows `dependencies` AND `devDependencies` for build ordering;
    `peerDependencies` (especially `optional: true`) don't
    participate. Add the sibling to `devDependencies: workspace:^`
    too (the v0.9.0 lesson).
13. **Bypassing `yarn verify:release-coverage`.** A new package that
    isn't wired into `release.yml` will publish nothing on the next
    release. The pre-push hook + ci.yml step both run this — use
    `git push --no-verify` only if you genuinely need a transient WIP
    push, never on a release commit.

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

The repo's release pattern (sole-maintainer, no PR): commit subject
is `chore(release): vX.Y.Z — short summary` directly on `main`, then
a signed tag `vX.Y.Z` push fires the publish workflow which publishes
all six packages in dependency order.

A change that only touches `.claude/`, `.githooks/`, `scripts/`,
`docs/`, `.github/`, root configs, or other non-published files does
**not** need any version bump in any package. Each package's
`package.json` `files` allowlist is the source of truth for "is this
consumer-visible" — if the path isn't listed there for any package,
nothing ships.

For the full release workflow, see
`.claude/skills/releasing-evm-toolkit/SKILL.md`.

## Rebasing a feature branch over a synced-bump release

A predictable conflict shape arises when a feature branch sits open
locally across one or more synchronized version bumps merging into
`main`. The collision is always in
`packages/<your-package>/CHANGELOG.md`, and it's mechanical, not
semantic:

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
  version number whenever the next synced release commit lands, not
  as part of the rebase.
- **Cross-references are already written.** When a synced-bump
  release lands while a feature branch is in flight, that release's
  CHANGELOG entry typically calls out the in-flight track in prose
  (e.g. *"the v0.3.x ChainSource implementation track is unaffected
  by this release and remains in flight"*). You don't need to add a
  back-pointer from `[Unreleased]` to the synced bumps — the synced
  bumps already point forward at you.

If the feature branch touches files **outside** `CHANGELOG.md` that
collide with a synced-bump's edits, that's a different problem
(usually the synced bump touched `package.json` versions, root
`package.json`, or the release workflow). Resolve those on a
case-by-case basis — they're not mechanical the way the CHANGELOG
collision is.
