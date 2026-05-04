# Tx-tracker — design spec

| Field | Value |
| --- | --- |
| Status | Draft (pre-implementation) |
| Repo | `valve-tech/evm-toolkit` (monorepo) |
| Packages affected | `@valve-tech/chain-source` (new, v0.1.0), `@valve-tech/tx-tracker` (new, v0.1.0), `@valve-tech/gas-oracle` (refactored to consume `ChainSource`, v0.3.0) |
| Author | valve-tech |
| Last updated | 2026-05-03 |

This document is the **design contract** for the v0.3.0 generation
of the toolkit — `@valve-tech/chain-source@0.1.0` (new package),
`@valve-tech/tx-tracker@0.1.0` (new package), and the
`@valve-tech/gas-oracle@0.3.0` migration to consume `ChainSource`. It
is the artifact that the implementation, the tests, the AI skills,
and the example code all reconcile against. Iterate on this doc;
don't iterate on the implementation in its absence.

---

## 1. Goals

The tracker turns the question *"what happened to this transaction?"*
into a stream of **neutral observations** that any consumer can build
their own UI / analytics / alerting on top of. It must serve three
consumer shapes simultaneously, with a single set of underlying
mechanics:

1. **Wallet UI** — "is my pending swap going through, and roughly when?"
2. **Indexer** — "durably observe inclusion + reorgs, never miss an
   event across a process restart."
3. **Relay** — "did the bundle's tx land? was it replaced? bumped?"

A consumer's interpretation of the events (the verbs they put in their
UI, the alerts they fire, the depths they wait for) is **out of scope**.
The tracker emits `seen-in-mempool`, `seen-in-block`, `replaced-by`,
`vanished-from-block`, `unseen-for-N-blocks` and lets the consumer say
"likely confirmed" or "stuck" or "rejected" in their own voice.

### Non-goals

- **Editorial verbs in the event taxonomy.** No `confirmed`, `failed`,
  `stuck`. Those are interpretations the consumer applies to events.
- **Built-in retry / replacement / cancellation logic.** The tracker
  observes; it does not act on observations. Building a "stuck-tx
  replacer" is a downstream library that *uses* tx-tracker.
- **Synthesizing event history before the consumer subscribed.** If
  the consumer started tracking at block N+5, events that happened
  at block N are not retroactively emitted. Catch-up on subscribe is
  a v2 feature (see §16).
- **Cross-chain unification.** One tracker instance per chain, same as
  `createGasOracle`. Multi-chain consumers instantiate multi-tracker.

---

## 2. Design principles

Five rules govern every other decision in this spec. They are
inherited from the existing package (per project memory
`architecture-primitive-layer.md`) and extended where the new surface
adds new dimensions.

### 2.1 Neutral surfacing

The tracker emits **observations**, not interpretations. Event names
describe *what was seen*, not *what it means*:

- ✅ `seen-in-mempool` (we saw the tx in `txpool_content` at block N)
- ✅ `seen-in-block` (the tx hash was found in `block.transactions` at
  block N, index I)
- ✅ `vanished-from-block` (the tx was previously at block N, but the
  current canonical block at height N has a different hash)
- ✅ `unseen-for-N-blocks` (the tx is no longer in mempool and has not
  been observed in any block we polled)
- ❌ `confirmed`, `failed`, `dropped`, `stuck` — these are consumer
  interpretations. The tracker provides the data; the consumer writes
  the policy.

Consumer code reads as policy on top of facts:

```ts
for await (const event of tracker.track(hash)) {
  if (event.kind === 'seen-in-block' && event.confirmations >= 3) {
    setUiStatus('Confirmed')
  } else if (event.kind === 'unseen-for-N-blocks' && event.blocks > 30) {
    setUiStatus('Likely dropped — resubmit?')
  }
}
```

The principle has precedent: the gas-oracle today does not say "gas is
high"; it publishes a `baseFeeTrend: 'rising'` enum and four tier
numbers, and lets the consumer's UI / policy interpret. The tracker
follows the same posture.

### 2.2 No silent downgrade — capability disclosure on every event

When upstream RPC capability varies (gated `txpool_content`, no WS
subscription support, missing `eth_getTransactionByHash` due to pruning,
etc.), the tracker **does not silently degrade**. Each emitted event
carries a `source` discriminator so consumers know how authoritative
the observation is:

```ts
type EventSource =
  | 'subscription'      // newHeads / newPendingTransactions push
  | 'block-poll'        // eth_getBlockByNumber polled at the oracle tick
  | 'mempool-snapshot'  // txpool_content polled on the source's tick
  | 'receipt-poll'      // eth_getTransactionReceipt fallback
```

A consumer that needs hard guarantees can filter to
`source === 'subscription'`; one that's fine with eventually-consistent
state can accept any source. Either choice is **explicit**.

This is a generalization of `priorityModel`'s rule in
`viem-transport.ts`: the package never picks a default that silently
makes the answer different across providers.

### 2.3 Capability matrix is probed once, then visible

At tracker construction (or first use under `lifecycle: 'lazy'`), the
tracker probes the underlying transport's capability and exposes the
result as a stable `Capabilities` object:

```ts
interface Capabilities {
  newHeads: 'subscription' | 'poll-only' | 'unavailable'
  newPendingTransactions: 'subscription' | 'poll-only' | 'unavailable'
  txpoolContent: 'available' | 'gated'
  receiptByHash: 'available' | 'unavailable'
  reprobeOnReconnect: boolean
}
```

The capability matrix is **per-method**, not per-transport, because the
real world has providers that allow `eth_subscribe('newHeads')` but gate
`txpool_content`, and chains that allow `txpool_content` but never
expose `newPendingTransactions`. A single "ws or http?" knob would
elide cases the spec needs to cover (per user requirement: "even on a
per method basis").

### 2.4 Browser/mobile safe — no Node-only deps in the package

`@valve-tech/tx-tracker` must build cleanly for browser,
React Native, and edge runtimes. No `events` (Node's EventEmitter), no
`fs`, no `setImmediate`, no Node-only Buffer manipulation. The internal
pub/sub primitive is hand-rolled (see §5.1) — small enough that the
size cost is negligible, and the alternative is breaking the existing
"safe to import in browser/mobile contexts" guarantee from the gas
oracle.

### 2.5 Wire format — bigint internally, hex at boundaries

Same rule the rest of the package follows. Block numbers, gas, fee
fields are `bigint`. `JSON.stringify(event)` will throw without
hex-encoding at the wire boundary. The store interface explicitly
documents this so durable-store implementations get it right.

---

## 3. Architecture and package layout

### 3.1 Layering — `ChainSource` is the shared primitive

The clean layering for v0.3.0 is **three layers**, each consuming
only the layer below:

```
                ┌─────────────────────────────────────┐
                │   PublicClient (viem)               │  ← caller-provided
                └──────────────┬──────────────────────┘
                               │
                ┌──────────────▼──────────────────────┐
                │   ChainSource                       │
                │   • capability probe                │
                │   • subscribeBlocks(cb)             │
                │   • subscribeMempool(cb)            │
                │   • getBlock / getReceipt /         │
                │     getTransaction / getFeeHistory  │
                │   • one upstream poll cycle         │
                └──────┬───────────────────────┬──────┘
                       │                       │
                ┌──────▼──────┐         ┌──────▼──────┐
                │  GasOracle  │         │  TxTracker  │
                │  (tier      │         │  (per-tx    │
                │   reducer)  │         │   state     │
                │             │         │   machine)  │
                └─────────────┘         └─────────────┘
                       (siblings — neither depends on the other)
```

`GasOracle` and `TxTracker` are **siblings**, both consume the same
`ChainSource` interface, neither depends on the other. A consumer who
wants both gets one `ChainSource` shared between them (one upstream
RPC stream, two derived views). A consumer who wants only the tracker
constructs a `ChainSource` and a tracker — no oracle in sight, and
vice versa.

This matters because:

1. **Neither feature is more fundamental than the other.** Gas tiers
   are a derived computation on top of chain observation; tx tracking
   is also a derived view on top of chain observation. The underlying
   primitive — observing the chain — is the thing both depend on, and
   that's `ChainSource`. The earlier draft of this spec used a
   "tracker piggybacks on oracle" framing; that was wrong. The oracle
   is not the canonical chain-watch primitive, and forcing tracker
   users to instantiate an unused `GasOracle` to "share its poll cycle"
   is a code smell.
2. **One upstream RPC cycle, multiple consumers.** `ChainSource`
   owns the poll loop and the capability probe. Both oracle and
   tracker subscribe; the source fans the same block / mempool data
   out to each. No double-polling, no asymmetric coupling.
3. **Independent lifecycles.** A consumer can construct `ChainSource`
   and `TxTracker` without `GasOracle`, run only the tracker for a
   while, then `createGasOracle({ source })` and start it later — the
   source is happily shared. Stopping one consumer does not stop the
   other or the source.
4. **Testing surface.** A fixture-driven test injects a stub
   `ChainSource` and asserts on either consumer's behavior in
   isolation. No need to mock a full `GasOracle` to test the tracker.

### 3.2 `ChainSource` interface

```ts
interface ChainSource {
  /** Push-based new-block stream when capability allows; falls back
   *  to interval-poll. Subscribers get a normalized `BlockResult`. */
  subscribeBlocks(cb: (block: BlockResult) => void): Unsubscribe

  /** Push-based mempool delta when capability allows; falls back to
   *  snapshot-diff every cycle. Subscribers get the latest
   *  `NormalizedMempool` snapshot. */
  subscribeMempool(cb: (snapshot: NormalizedMempool) => void): Unsubscribe

  /** On-demand single-block fetch. */
  getBlock(blockTag: 'latest' | bigint): Promise<BlockResult | null>

  /** On-demand fee history (powers the oracle's trend detection). */
  getFeeHistory(blockCount: number, percentiles: number[]): Promise<FeeHistoryResult | null>

  /** On-demand mempool snapshot. */
  getMempoolSnapshot(): Promise<NormalizedMempool | null>

  /** On-demand receipt. */
  getReceipt(hash: Hash): Promise<TransactionReceipt | null>

  /** On-demand tx lookup (powers the tracker's replacement detection). */
  getTransaction(hash: Hash): Promise<RawTx | null>

  /** Stable capability snapshot (§7). */
  capabilities(): Capabilities

  /** Lifecycle. start() begins the poll loop and / or opens
   *  subscriptions. stop() tears down both. Idempotent. */
  start(): void
  stop(): void
}

interface CreateChainSourceOptions {
  /** viem PublicClient pointed at the upstream RPC. */
  client: PublicClient
  /** Polling interval in ms when push subscriptions aren't available
   *  (or aren't preferred). Default 10_000. */
  pollIntervalMs?: number
  /** Producer-side toggles — same role as the existing oracle's
   *  `poll` option. Disabling `mempool` here disables it for every
   *  consumer of this source. */
  poll?: PollOptions
  /** Optional error sink — called per-method when an RPC fails. */
  onError?: (method: string, err: unknown) => void
}

function createChainSource(options: CreateChainSourceOptions): ChainSource
```

`ChainSource` is the canonical chain-observation primitive. Multiple
subscribers per stream are first-class — that's the whole point.

### 3.3 Migration of `createGasOracle`

`createGasOracle` is updated to consume a `ChainSource`. The signature
gains a `source` field; the existing `client` field is preserved as a
backward-compat shorthand that internally creates a private source.

```ts
interface CreateGasOracleOptions {
  // NEW (preferred for v0.3.0+):
  source?: ChainSource

  // EXISTING (still supported — creates a private ChainSource internally):
  client?: PublicClient
  pollIntervalMs?: number
  poll?: PollOptions
  onError?: (method: string, err: unknown) => void

  // Unchanged:
  chainId: number
  priorityFeeDecayCap?: bigint | null
  priorityModel?: PriorityModel
  baseFeeLivenessBlocks?: number
  keepMempoolSnapshot?: boolean
}
```

Validation: exactly one of `source` / `client` must be provided. A
consumer who passes `client` gets the v0.2.x behavior, byte-for-byte
identical. A consumer who passes `source` opts in to the new layering
and can share the source with a tracker.

This is a **soft** breaking change — existing call sites work
unchanged. A future major may remove the `client` shorthand once the
ecosystem has migrated.

### 3.4 New files

```
packages/
├── chain-source/                 NEW package
│   └── src/
│       ├── index.ts              Re-exports.
│       ├── source.ts             createChainSource factory.
│       ├── capabilities.ts       probeCapabilities(client) — used by source
│       │                          at startup and on transport reconnect.
│       ├── poll-loop.ts          Pure tick logic (block + mempool + feeHistory
│       │                          fan-out). Subsumes the existing
│       │                          fetchOracleInputs.
│       ├── subscriptions.ts      The shared pub/sub primitive (§5.1).
│       └── *.test.ts
├── tx-tracker/                   NEW package
│   └── src/
│       ├── index.ts              Re-exports — public surface only.
│       ├── tracker.ts            createTxTracker factory + per-tx state machine.
│       ├── events.ts             TxEvent discriminated-union + payload builders.
│       ├── store.ts              TxTrackerStore interface + createInMemoryStore.
│       ├── reorg.ts              Reorg detector (pure function over block ring).
│       ├── selectors.ts          Bulk-subscription matchers.
│       └── *.test.ts
└── gas-oracle/                   EXISTING package (refactor only)
    └── src/
        ├── oracle.ts             Updated to consume ChainSource via
        │                          options.source; `client` shorthand
        │                          internally constructs a private source.
        └── (other files unchanged)
```

### 3.5 Package imports

```ts
// Existing (continues from v0.2.x):
import { createGasOracle } from '@valve-tech/gas-oracle'

// NEW in v0.3.0 — separate npm packages, all in the same monorepo:
import { createChainSource } from '@valve-tech/chain-source'
import { createTxTracker, createInMemoryStore }
  from '@valve-tech/tx-tracker'
```

Two new packages, each with its own `package.json`, version, and
release cadence. `@valve-tech/gas-oracle` keeps its existing public
surface (and gets the `source?` field on `CreateGasOracleOptions` as
additive).

### 3.6 Inter-package dependency graph

```jsonc
// packages/chain-source/package.json
{
  "name": "@valve-tech/chain-source",
  "peerDependencies": { "viem": "^2.0.0" }
}

// packages/gas-oracle/package.json
{
  "name": "@valve-tech/gas-oracle",
  "dependencies": { "@valve-tech/chain-source": "workspace:^" },
  "peerDependencies": { "viem": "^2.0.0" }
}

// packages/tx-tracker/package.json
{
  "name": "@valve-tech/tx-tracker",
  "dependencies": { "@valve-tech/chain-source": "workspace:^" },
  "peerDependencies": { "viem": "^2.0.0" }
}
```

`workspace:^` is rewritten to a real semver range (`^0.x.y` matching
the chain-source version at publish time) by yarn during
`npm publish`. Consumers see normal semver-resolved deps, not
workspace protocols.

No new runtime dependencies beyond the toolkit's own packages.
`viem ^2.0.0` peer remains the only external peer dep.

---

## 4. Versioning

**Synchronized.** Every published release of the `valve-tech/evm-toolkit`
monorepo bumps all three packages to the same version under a single
`vX.Y.Z` tag. `chain-source`, `gas-oracle`, and `tx-tracker` always
share the same version on npm.

The first synced release was `v0.3.0`, which:

- Initialized `@valve-tech/chain-source@0.3.0` and
  `@valve-tech/tx-tracker@0.3.0` as name-reservation stubs (both
  `export {}` — actual implementation lands in subsequent 0.3.x
  releases per this spec).
- Bumped `@valve-tech/gas-oracle@0.2.5 → 0.3.0` with the idle-traffic
  controls (`pauseWhenIdle`, `staleAfter`, `blockGatedPolling`,
  `pauseWhenHidden`, `sampleGasFees`).

Subsequent 0.3.x releases land the chain-source / tx-tracker
implementation incrementally, with gas-oracle migrating to consume
`ChainSource` (additive — `createGasOracle({ client })` continues to
work byte-for-byte unchanged via an internal compat shim).

The viem-actions and viem-transport sub-exports of
`@valve-tech/gas-oracle` get an internal refactor in due course (they
construct a private `ChainSource` instead of calling the legacy poll
loop directly) but their public surface does not change.

A breaking change (e.g., removing the `client` shorthand on
`createGasOracle`) is reserved for `0.4.0`. Under pre-1.0 SemVer
strictness, this project treats "breaking = bump the second digit."
See `.claude/skills/releasing-evm-toolkit/SKILL.md`.

Because versioning is synced, packages without changes for a release
still bump (in lockstep) and get a short CHANGELOG entry noting
"Synchronized release — no changes to this package." This keeps
consumers' `npm view` honest across the toolkit.

---

## 5. Public API surface

### 5.1 Internal pub/sub primitive

The tracker has one core: a typed pub/sub `Subscriptions<E>` that all
three consumption shapes are built on. **Hand-rolled, browser/mobile
safe, no Node `events` dep:**

```ts
class Subscriptions<E> {
  private subscribers = new Set<(event: E) => void>()
  emit(event: E): void { /* swallow per-subscriber throws */ }
  subscribe(cb: (event: E) => void): () => void { /* returns unsub */ }
  size(): number
}
```

Per-subscriber throws are swallowed (same posture as
`oracle.subscribe`'s subscribers — a bad consumer cannot take down
others). The unsubscribe function is the only teardown path.

### 5.2 Factory

```ts
interface CreateTxTrackerOptions {
  /**
   * The chain-source the tracker reads from. Required. The tracker
   * subscribes to source.subscribeBlocks / subscribeMempool for
   * push-side events and uses source.getReceipt / getTransaction for
   * on-demand lookups. The same source MAY also be passed to a
   * GasOracle — both consume independently, source fans the same
   * upstream stream out to each.
   */
  source: ChainSource

  /** EVM chain ID. Echoed back in events. */
  chainId: number

  /**
   * Persistence backend. Default: in-memory store with `retentionBlocks: 64`.
   * Pass `createInMemoryStore({ retentionBlocks: ... })` to tune retention,
   * or implement TxTrackerStore for Redis / SQLite / etc.
   */
  store?: TxTrackerStore

  /**
   * Lost-signal policy. Default: 'emit-uncertain' — every transition
   * to a degraded source emits a `signal-degraded` event. See §8.
   */
  lostSignalPolicy?: LostSignalPolicy

  /**
   * Reorg detection depth — how many blocks back the tracker re-checks
   * canonical chain on every new block. Default 12. Higher = catches
   * deeper reorgs; lower = less work per tick.
   */
  reorgDepthBlocks?: number

  /**
   * Optional error sink — same role as on createGasOracle.
   */
  onError?: (method: string, err: unknown) => void

  /**
   * When the tracker starts subscribing to the source. 'eager'
   * (default) subscribes on construction; 'lazy' waits for the first
   * track/getStatus call. Capability is read from the source either
   * way (the source itself owns the probe).
   */
  lifecycle?: 'eager' | 'lazy'
}

interface TxTracker {
  start(): void
  stop(): void

  /**
   * Imperative — read the latest cached status of a single tx.
   * Returns null if the hash is not currently tracked. Cache reads
   * are sub-millisecond; do not call in a hot loop, subscribe instead.
   */
  getTxStatus(hash: Hash): TxStatus | null

  /**
   * Async iterator. The most ergonomic shape for modern code:
   *
   *   for await (const event of tracker.track(hash, options?)) { ... }
   *
   * Iteration ends when (a) the tx reaches a terminal-and-finalized
   * state and the retention window expires, OR (b) the consumer
   * breaks out of the loop, OR (c) the tracker stops.
   */
  track(hash: Hash, options?: TrackOptions): AsyncIterable<TxEvent>

  /**
   * Callback. Returns an unsubscribe handle.
   */
  subscribe(hash: Hash, cb: (event: TxEvent) => void, options?: TrackOptions): () => void

  /** Bulk subscriptions — see §11. */
  trackFromAddress(address: Address, options?: BulkTrackOptions): TxSubscription
  trackToAddress(address: Address, options?: BulkTrackOptions): TxSubscription
  trackPredicate(match: (tx: RawTx) => boolean, options?: BulkTrackOptions): TxSubscription

  /** Capability disclosure (§7). */
  capabilities(): Capabilities

  /**
   * Global stream — every event the tracker emits, regardless of which
   * subscription triggered it. Useful for indexers piping to a single
   * sink.
   */
  subscribeAll(cb: (event: TxEvent) => void): () => void
}
```

### 5.3 The three consumption shapes

All three shapes are thin adapters over the same internal pub/sub. The
guarantee is **strict consistency**: a consumer using `track(hash)` as
an async iterator and another using `subscribe(hash, cb)` and a third
calling `getTxStatus(hash)` see the *same* events in the same order;
they are reading the same upstream stream.

```ts
// Snapshot — for legacy code or imperative reads
const status = tracker.getTxStatus('0xabc...')

// Callback — for code that already manages handles
const unsub = tracker.subscribe('0xabc...', (event) => {
  console.log(event.kind, event.source, event)
})
// ... later
unsub()

// Async iterator — recommended for new code
for await (const event of tracker.track('0xabc...')) {
  if (event.kind === 'seen-in-block' && event.confirmations >= 3) break
}
```

The `subscribe`/`track` adapters return immediately even before any
events have been observed; the consumer sees events arrive
asynchronously. `getTxStatus` returns `null` before the first
observation is recorded, mirroring `oracle.getState()` returning null
before the first poll completes.

### 5.4 `TrackOptions`

```ts
interface TrackOptions {
  /**
   * Emit a `started` synthetic event on subscribe even if no real event
   * has fired yet. Default true. Wallet UIs use it to render an
   * "awaiting first observation" state without polling.
   */
  emitInitial?: boolean

  /**
   * Persist this subscription via the store. Default false (the
   * subscription survives only the current process). Set true for
   * indexer/relay use cases that need to resume tracked-set after
   * restart.
   */
  durable?: boolean

  /**
   * Override the tracker-default lostSignalPolicy for this single
   * subscription.
   */
  lostSignalPolicy?: LostSignalPolicy
}
```

---

## 6. Event taxonomy

Every event is a member of the discriminated union `TxEvent`. The
`kind` field discriminates; common envelope fields (`hash`, `source`,
`chainId`, `at`) appear on every variant.

```ts
type TxEvent =
  | TxEvent.Started
  | TxEvent.SeenInMempool
  | TxEvent.LeftMempool
  | TxEvent.SeenInBlock
  | TxEvent.VanishedFromBlock
  | TxEvent.ReplacedBy
  | TxEvent.UnseenForNBlocks
  | TxEvent.SignalDegraded
  | TxEvent.SignalRecovered
  | TxEvent.Stopped

namespace TxEvent {
  interface Envelope {
    hash: Hash
    chainId: number
    source: EventSource
    at: { blockNumber: bigint; timestamp: bigint }
  }

  interface Started extends Envelope {
    kind: 'started'
    /** Capability snapshot at subscribe time. */
    capabilities: Capabilities
  }

  interface SeenInMempool extends Envelope {
    kind: 'seen-in-mempool'
    bucket: 'pending' | 'queued'
    tx: RawTx
  }

  /**
   * Tx is no longer in the mempool snapshot. Could be because it
   * was mined, replaced, or the upstream node dropped it. Consumers
   * correlate with subsequent `seen-in-block` / `replaced-by` events
   * to disambiguate.
   */
  interface LeftMempool extends Envelope {
    kind: 'left-mempool'
  }

  interface SeenInBlock extends Envelope {
    kind: 'seen-in-block'
    blockHash: Hash
    blockNumber: bigint
    transactionIndex: number
    /** How many blocks have been observed since this inclusion. */
    confirmations: number
  }

  /**
   * The tx was previously seen in block N (hash H1), but the current
   * canonical block at height N has a different hash (H2), and the
   * tx is not in H2.transactions. Reorg.
   */
  interface VanishedFromBlock extends Envelope {
    kind: 'vanished-from-block'
    previousBlockHash: Hash
    canonicalBlockHash: Hash
    blockNumber: bigint
  }

  /**
   * A different hash with the same (from, nonce) pair was mined.
   * The tracker discovers this when it polls the receipt by sender
   * + nonce, or when it sees the replacement tx in mempool first.
   */
  interface ReplacedBy extends Envelope {
    kind: 'replaced-by'
    replacementHash: Hash
    replacementBlockNumber: bigint | null  // null if seen only in mempool
  }

  /**
   * Tx has not been in mempool nor in a block for N consecutive polled
   * blocks. Threshold is configurable per subscription
   * (`unseenThresholdBlocks`, default = 30). Consumer interprets as
   * "likely dropped" / "stuck" / "rejected" in their own UX voice.
   */
  interface UnseenForNBlocks extends Envelope {
    kind: 'unseen-for-N-blocks'
    blocks: number
  }

  /**
   * A capability the tracker was relying on for this tx is no longer
   * available — typically: WS subscription dropped, or txpool_content
   * just got gated mid-session. The tracker keeps tracking on whatever
   * fallback exists (block-poll, receipt-poll), but the consumer
   * should know its observation authority just dropped.
   */
  interface SignalDegraded extends Envelope {
    kind: 'signal-degraded'
    capabilityLost: keyof Capabilities
    fallbackSource: EventSource
  }

  interface SignalRecovered extends Envelope {
    kind: 'signal-recovered'
    capabilityRestored: keyof Capabilities
  }

  /**
   * Subscription teardown — emitted when the consumer calls
   * unsubscribe, the retention window expires after a terminal state,
   * or the tracker stops. Final event in the stream.
   */
  interface Stopped extends Envelope {
    kind: 'stopped'
    reason: 'unsubscribed' | 'retention-expired' | 'tracker-stopped'
  }
}
```

### 6.1 Event ordering invariants

Within a single tracked hash:

1. `started` is always the first event of a subscription (when
   `emitInitial: true`).
2. `seen-in-mempool` precedes `left-mempool` (if both occur).
3. `seen-in-block` (first inclusion) precedes any `vanished-from-block`
   for the same `blockNumber`.
4. `replaced-by` and `seen-in-block` are mutually exclusive for the
   *same* hash — but a hash that's `replaced-by`'d may still appear in
   a block later if the original makes it in alongside (rare;
   chain-dependent).
5. `signal-degraded` precedes any subsequent event from the fallback
   source (so the consumer knows the lower authority is now in play).
6. `stopped` is the last event; nothing follows it.

### 6.2 What's deliberately NOT an event

- `pending` (replaced by `seen-in-mempool` + `source` fields)
- `mined` (replaced by `seen-in-block`)
- `confirmed` (consumer policy on `confirmations` field)
- `dropped` (consumer policy on `unseen-for-N-blocks`)
- `failed` (failed-on-chain is a `seen-in-block` event with
  `receipt.status === 'reverted'` available via the consumer's own
  receipt fetch — the tracker doesn't pre-fetch receipts unconditionally
  because it costs an RPC per inclusion event)

The omissions are not oversights; they are the application of §2.1
(neutral surfacing).

---

## 7. Capability matrix and probing

### 7.1 What gets probed

```ts
interface Capabilities {
  /** eth_subscribe('newHeads') — push-based new-block events. */
  newHeads: 'subscription' | 'poll-only' | 'unavailable'

  /** eth_subscribe('newPendingTransactions') — push-based mempool ingress. */
  newPendingTransactions: 'subscription' | 'poll-only' | 'unavailable'

  /** txpool_content support. */
  txpoolContent: 'available' | 'gated'

  /** eth_getTransactionReceipt — fallback path for inclusion watch. */
  receiptByHash: 'available' | 'unavailable'

  /** Whether transport reconnection re-probes (WS reconnect, etc.). */
  reprobeOnReconnect: boolean
}
```

### 7.2 How probing works

Capability is owned by `ChainSource`, not by the tracker. At
`source.start()` (or on first use under a `lazy`-configured source),
the source fires four probes, all wrapped in the existing
`safeRequest` pattern from `packages/gas-oracle/src/transport.ts:74` (turn errors into
`null`, never throw):

1. `client.transport.subscribe?.('newHeads')` — if the transport
   supports the subscribe shape, attempt to subscribe and immediately
   unsubscribe. Success → `'subscription'`, error → `'poll-only'`,
   transport doesn't even expose `subscribe` → `'unavailable'`.
2. Same for `newPendingTransactions`.
3. `client.request({ method: 'txpool_content', params: [] })` — gated
   if the call returns `null` via `safeRequest`.
4. `client.request({ method: 'eth_getTransactionReceipt', params: [zeroHash] })`
   — should return `null` for the zero hash but should not throw. Throw =
   `'unavailable'`.

`source.capabilities()` returns the latest probe result; the tracker
calls this and exposes it through `TxEvent.Started.capabilities`.
On WS reconnect (when supported by the underlying transport), the
source re-probes and notifies its subscribers; the tracker translates
notifications into `signal-recovered` / `signal-degraded` events on
tracked hashes whose authority changed.

### 7.3 How capability shapes which path runs

| Path | Required capability | Fallback if missing |
| --- | --- | --- |
| **Inclusion watch** (tx → block) | `newHeads: 'subscription'` ideal; otherwise `block-poll` via source's tick | `receiptByHash` polling per tracked hash on every tick |
| **Mempool watch** (tx → mempool) | `newPendingTransactions: 'subscription'` ideal; otherwise `mempool-snapshot` via `txpool_content` | If `txpoolContent: 'gated'`, mempool-watch is **disabled** for this tracker; `seen-in-mempool` events never fire and a `signal-degraded` event with `capabilityLost: 'txpoolContent'` is emitted at startup |
| **Reorg detection** | `newHeads: 'subscription'` OR `block-poll` — same ring-walk algorithm in either case (§12) | None needed; reorg detection is pure-function on `BlockSample[]` |
| **Replacement detection** | `eth_getTransactionByHash` to look up the (from, nonce) of the original; then `eth_getTransactionCount` (latest) on the sender to find the canonical-mined nonce | None needed; if both methods are available it works |

The matrix maps cleanly onto the existing `safeRequest`-returns-null
pattern. No new transport-layer abstractions are needed beyond the
probe.

---

## 8. Lost-signal policy

The default behavior when the tracker loses an authoritative source
mid-tracking (WS drop, txpool_content newly gated, etc.):

```ts
type LostSignalPolicy =
  | 'emit-uncertain'   // default — emit signal-degraded event on every transition
  | 'silent'           // don't emit; just degrade quietly
  | {
      strategy: 'receipt-poll-fallback'
      // Force a receipt poll for the tracked hash on every block,
      // independent of any other source. Higher RPC cost; strongest
      // guarantee. Use for relay / settlement contexts.
      pollEveryBlocks: number
    }
```

Default is `'emit-uncertain'` — **loud by default**, per user
requirement. Wallets that prefer to hide UI churn during transient
drops can set `'silent'`. Relays that need a hard guarantee can opt
into the receipt-poll fallback at the cost of one extra RPC per
tracked hash per block.

The policy applies independently per subscription if specified in
`TrackOptions.lostSignalPolicy`; otherwise it inherits from the
tracker's default.

---

## 9. `TxTrackerStore` interface

Persistence surface. Indexers and relays cannot lose tracked hashes
across a process restart; wallets are fine in-memory. The store
interface lets either case plug in.

```ts
interface TxTrackerStore {
  /** Persist a tracked-tx record. Idempotent on (chainId, hash). */
  put(record: TrackedTxRecord): Promise<void>

  /** Read the latest record for a hash. */
  get(chainId: number, hash: Hash): Promise<TrackedTxRecord | null>

  /** Remove a hash (called when retention window expires). */
  delete(chainId: number, hash: Hash): Promise<void>

  /**
   * List durable subscriptions on startup. Returns every record whose
   * `subscriptions[].durable === true` so the tracker can resume
   * tracking after restart. Non-durable subscriptions are never
   * surfaced here.
   */
  listDurable(chainId: number): Promise<TrackedTxRecord[]>

  /**
   * Append an event to the per-hash audit log. Called for every event
   * emitted on tracked hashes. Indexers use this for replay; wallets
   * can no-op via a no-op store wrapper.
   */
  appendEvent(chainId: number, hash: Hash, event: TxEvent): Promise<void>

  /**
   * Read the per-hash audit log. Used on subscribe with a `since`
   * parameter to support catch-up. Optional; default in-memory store
   * implements it as a bounded ring buffer.
   */
  readEventLog?(chainId: number, hash: Hash, since?: number): Promise<TxEvent[]>
}

interface TrackedTxRecord {
  chainId: number
  hash: Hash
  status: TxStatus              // current cached status
  firstSeenBlockNumber: bigint
  lastObservedBlockNumber: bigint
  retentionExpiresAtBlockNumber: bigint
  subscriptions: PersistedSubscription[]
}

interface PersistedSubscription {
  id: string
  durable: boolean
  selector: HashSelector | BulkSelector
}
```

### 9.1 Wire format note

`TrackedTxRecord` carries `bigint` fields. **Store implementers serialize
to hex strings** (`'0x' + n.toString(16)`) — same rule as the rest of
the package. The default in-memory store keeps them as `bigint`
in-process and only converts at boundary if the consumer reads via a
wire shape; durable stores (Redis, SQLite, JSON-on-disk) MUST hex-encode
on write and decode on read.

---

## 10. `createInMemoryStore`

The default implementation. Short retention by default — tracked txs
are kept for `retentionBlocks` after their last terminal observation,
then dropped.

```ts
interface InMemoryStoreOptions {
  /**
   * How many blocks past the last terminal observation
   * (seen-in-block reaching `confirmations >= retentionBlocks`,
   * or unseen-for-N-blocks reaching the threshold) the record is
   * retained. After this window passes, the record is GC'd and
   * `Stopped { reason: 'retention-expired' }` fires.
   *
   * Block-unit because reorg safety is measured in block depth.
   *
   * Default: 64 blocks — enough to outlive any realistic reorg on
   * the chains this package targets. Wall-clock per chain at this
   * default: Ethereum ~13 min (12s blocks), PulseChain ~11 min
   * (10s blocks). Tune up for archival-style use cases or chains
   * with weaker finality guarantees.
   */
  retentionBlocks?: number

  /**
   * Cap on the per-hash event log. Default 256. Older events are
   * dropped from the log when this cap is exceeded; the latest
   * status is always retained.
   */
  eventLogCapacity?: number
}

function createInMemoryStore(options?: InMemoryStoreOptions): TxTrackerStore
```

### 10.1 Why block-units, not seconds

What actually matters for reorg safety is **block depth**, full stop.
Reorgs are measured in blocks; finality is expressed in blocks; a
record retained "long enough that a reorg can't make it suddenly
relevant again" is a statement about block depth, not seconds.
Time-based retention would conflate two unrelated quantities (block
production rate, finality depth) into one knob, and the right answer
to "is this record still possibly affected by a reorg" stays the same
regardless of whether the chain's block time is 12s or 10s or 2s.

For chains the package primarily targets the wall-clock implication
of `retentionBlocks: 64` is roughly comparable (Ethereum ~13 min,
PulseChain ~11 min — within 20%); the block-unit framing only
*matters* when comparing to faster-block chains (Polygon ~2 min,
sub-second L2 rollups well under a minute). Either way the knob is
expressed in the unit the underlying invariant lives in.

### 10.2 Memory profile

In-memory store memory grows with:

- **Tracked-set cardinality** — one `TrackedTxRecord` per hash. ~1KB
  per record without event log.
- **Event log per hash** — up to `eventLogCapacity` events. Each event
  is a few hundred bytes. Default cap = 256, so ~50–100KB per hash
  with full log.

For a wallet tracking <100 simultaneous txs, this is negligible. For
an indexer tracking thousands at once, tune `eventLogCapacity` down or
plug in a durable store.

---

## 11. Bulk subscriptions

Per-hash subscription is ergonomic for wallet + relay. Indexers
typically want "all txs from these senders" or "all txs touching this
contract." The tracker supports both shapes from day one.

### 11.1 API

```ts
interface BulkSelector {
  kind: 'from' | 'to' | 'predicate'
  // for 'from' / 'to':
  address?: Address
  // for 'predicate':
  match?: (tx: RawTx) => boolean
}

interface BulkTrackOptions extends TrackOptions {
  /**
   * Auto-track every tx the selector matches (start a per-hash
   * subscription for it). Default true. Set false to receive the
   * raw "tx matched" stream without per-hash detail.
   */
  autoTrackMatched?: boolean
}

interface TxSubscription {
  /** The raw match-stream — fires on each newly-matched tx. */
  events(): AsyncIterable<TxMatchEvent>

  /** Imperative subscription to per-hash events on matched txs. */
  subscribe(cb: (event: TxEvent) => void): () => void

  /** Stop the bulk subscription. Doesn't stop already-tracked hashes
   *  that were created via auto-tracking — those continue under
   *  per-hash retention rules. */
  stop(): void
}

interface TxMatchEvent {
  kind: 'matched'
  hash: Hash
  matchedBy: 'from' | 'to' | 'predicate'
  selector: BulkSelector
  tx: RawTx
  source: 'mempool-snapshot' | 'block-poll'
  at: { blockNumber: bigint; timestamp: bigint }
}
```

### 11.2 Where the matching runs

When the tracker has an `oracle` reference and `keepMempoolSnapshot:
true` is set on it, the bulk matcher iterates the oracle's mempool
snapshot every poll cycle — zero additional RPCs.

When the tracker is standalone, it polls `txpool_content` directly on
its own tick, falling back to inspecting `block.transactions` only if
`txpool_content` is gated. The `from`/`to` selectors are O(1) in the
mempool's normalized index; the `predicate` selector is O(N) in the
mempool size.

### 11.3 Limits

- A single tracker instance may run **at most 16** bulk subscriptions
  by default (`maxBulkSubscriptions` option). Higher fan-out is
  possible but indicates the consumer should be running an indexer-
  shaped store rather than the in-memory default.
- Predicate functions must be pure and fast (called per-tx per-tick).
  Slow predicates degrade the poll cycle.

---

## 12. Reorg handling

### 12.1 Algorithm

On every new block (subscription or poll), the tracker:

1. Walks `oracle.state.ring` (when oracle is provided) or its own
   block-history ring (standalone) backward from the new tip.
2. For each block in the last `reorgDepthBlocks` (default 12), checks
   whether the canonical hash at that height matches the hash the
   tracker previously recorded.
3. For every divergence found, identifies tracked hashes whose
   `seen-in-block` referenced the old hash, and emits
   `vanished-from-block` for them.
4. Re-checks the new canonical block at the same height; if the tx is
   present there, emits a fresh `seen-in-block`. If not, the tracked
   hash is now in a "gone" state and `unseen-for-N-blocks` will fire
   per its threshold.

### 12.2 Why a fixed depth, not "find the common ancestor"

A bounded depth (default 12 blocks) cap is intentional: deeper reorgs
are vanishingly rare on chains the package targets, and walking
unbounded-deep would let one anomalous reorg make the tick arbitrarily
long. 12 is conservative — even Ethereum's worst recent reorgs are
under 7 blocks. Tunable for chains with weaker finality guarantees.

### 12.3 Source on reorg events

`vanished-from-block` events carry `source: 'block-poll'` (or
`'subscription'` if `newHeads` push triggered the detection). They
never carry `'receipt-poll'` because receipt-poll cannot detect a reorg
— `eth_getTransactionReceipt` happily returns the receipt for a tx in a
no-longer-canonical block on most providers, only failing once the tx
is also gone from the new canonical chain.

This is exactly the "no silent downgrade" rule (§2.2) in action: a
consumer relying on receipt-poll-only sees authoritative-seeming
inclusion events that may turn out to be obsolete; the tracker emits
`signal-degraded { capabilityLost: 'newHeads' }` so the consumer knows.

---

## 13. Persistence + restart semantics

### 13.1 What survives a restart

When a `durable: true` subscription is created:

1. A `TrackedTxRecord` with `subscriptions: [{ id, durable: true, ... }]`
   is `put`-stored.
2. Every subsequent event is `appendEvent`-stored on the per-hash log.
3. On `tracker.start()` next run, `store.listDurable(chainId)` is
   called; for each record found, the tracker re-creates the
   subscription's per-hash watch and emits a `started` event with
   `capabilities: <current>` so consumers know if the authority level
   changed across the restart.

### 13.2 What does NOT survive a restart

- **Active async iterators** — these are tied to the consumer's
  process. After restart, the consumer must re-call `tracker.track(hash)`
  to get a fresh iterator.
- **Per-event callbacks** (`subscribe(hash, cb)`) — the callback is a
  function reference; the new process must re-register.
- **Bulk subscriptions** — `BulkSelector.predicate` is a function and
  cannot be serialized. `from`/`to` selectors are serializable and
  CAN be persisted; v0.3.0 implements that for `from`/`to` only.
  `predicate` selectors are silently non-durable (even if `durable: true`)
  with a warning at registration time.

### 13.3 Catch-up window on resume

`store.readEventLog?(chainId, hash, since)` lets a consumer ask "what
happened to this hash since I last saw block N?" The default in-memory
store implements this with the bounded event-log ring. Durable stores
that implement it MAY surface arbitrary history depth.

`tracker.track(hash, { since: blockNumber })` consumes the catch-up
window — the iterator yields historical events first, then real-time
events.

---

## 14. Composition via `ChainSource`

The tracker and the oracle are **siblings**, both consumers of the
same `ChainSource`. There is no direct dependency between them in
either direction. A consumer who wants both reads from a shared source:

```ts
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle } from '@valve-tech/gas-oracle'
import { createTxTracker } from '@valve-tech/tx-tracker'

const client = createPublicClient({ chain: mainnet, transport: http() })

// One source — owns the upstream poll cycle and capability probe.
const source = createChainSource({ client })
source.start()

// Two siblings — both consume the same source, neither depends
// on the other.
const oracle  = createGasOracle({ source, chainId: 1 })
const tracker = createTxTracker({ source, chainId: 1 })
oracle.start()
tracker.start()
```

The source fans the same upstream block / mempool stream out to both
subscribers; **only one upstream RPC cycle**, regardless of how many
consumers attach. Both can be started, stopped, and reconfigured
independently.

A consumer that only wants tx tracking (no gas tiers) skips the oracle:

```ts
const source  = createChainSource({ client })
const tracker = createTxTracker({ source, chainId: 1 })
source.start(); tracker.start()
```

A consumer that only wants gas tiers — the existing v0.2.x use case —
keeps the v0.2.x shorthand:

```ts
const oracle = createGasOracle({ client, chainId: 1 })  // creates a private source
oracle.start()
```

`createGasOracle({ client })` is preserved for backward compatibility
(see §3.3); internally it constructs and owns a `ChainSource`. The
preferred shape for new code is `createGasOracle({ source })` —
explicit, composable.

### 14.1 Lifecycle composition

Each surface owns its own lifecycle. `source.stop()` tears down the
upstream poll loop and unsubscribes from any `eth_subscribe` channels;
calling it while consumers are still attached is allowed but means
they stop receiving events (their `subscribeBlocks` / `subscribeMempool`
callbacks simply stop firing). `oracle.stop()` and `tracker.stop()`
unsubscribe from the source they were given but do **not** stop the
source itself — the consumer that constructed the source is the one
who calls `source.stop()`.

The "each surface owns its lifecycle" pattern matches
`viem-transport.ts`'s `withGasOracle(...).stopGasOracle()` and is the
existing convention.

### 14.2 Multi-subscriber `ChainSource` is the internal event bus

`ChainSource` is explicitly designed for **multiple subscribers per
stream**. The earlier draft of this spec named `oracle.subscribe` as
"the internal event bus" — that framing is gone. The bus is
`ChainSource`, not `GasOracle.subscribe`. New stateful features in
the package compose on the source the same way the oracle and the
tracker do; the source is the canonical place to add a new derived
view of the chain.

`oracle.subscribe(state => ...)` remains an **egress** hook — for
consumers piping `GasOracleState` to Redis / metrics / a WebSocket
broadcast. It is NOT a primitive other features should layer on.

---

## 15. AI / skill extensions

Two artifacts ship with the tx-tracker landing:

### 15.1 Update `skills/gas-oracle-integration/SKILL.md` (consumer)

Append a "Tx tracking" section. Trigger phrases include "track this
transaction", "watch tx hash", "when does my tx confirm", "stuck
transaction", etc. Decision tree for which consumption shape to use:
async iterator for new code, callback for existing event-handler code,
snapshot for legacy / imperative reads.

### 15.2 Add `.claude/skills/extending-tx-tracker/SKILL.md` (contributor)

Project-local skill (see `contributing-to-gas-oracle/SKILL.md` for
the pattern). Covers the state-machine layout, the
"every event must carry source" invariant, the "reorg events never
come from receipt-poll" rule, and the "predicate selectors are
non-durable" carve-out.

---

## 16. Examples

### 16.1 `examples/07-tx-tracker.ts` — minimal tracker

```ts
// Track a single hash with the async iterator. Tracker only — no oracle.
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { createChainSource } from '@valve-tech/chain-source'
import { createTxTracker } from '@valve-tech/tx-tracker'

const client  = createPublicClient({ chain: mainnet, transport: http() })
const source  = createChainSource({ client })
const tracker = createTxTracker({ source, chainId: 1 })

source.start()
tracker.start()

const hash = '0xabc...'
for await (const event of tracker.track(hash)) {
  console.log(event.kind, event.source, event.at.blockNumber)
  if (event.kind === 'seen-in-block' && event.confirmations >= 6) break
}

tracker.stop()
source.stop()
```

### 16.2 `examples/08-tx-tracker-with-oracle.ts` — shared `ChainSource`

```ts
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle } from '@valve-tech/gas-oracle'
import { createTxTracker } from '@valve-tech/tx-tracker'

const source  = createChainSource({ client })
const oracle  = createGasOracle({ source, chainId: 1, priorityModel: 'eip1559' })
const tracker = createTxTracker({ source, chainId: 1 })

source.start()
oracle.start()
tracker.start()

// Wallet UI — neutral observation, consumer-side interpretation.
tracker.subscribe(hash, (event) => {
  if (event.kind === 'seen-in-mempool') ui.set('Awaiting inclusion...')
  if (event.kind === 'seen-in-block' && event.confirmations >= 1) ui.set('Confirmed')
  if (event.kind === 'replaced-by') ui.set(`Replaced by ${event.replacementHash}`)
  if (event.kind === 'unseen-for-N-blocks' && event.blocks > 30) ui.set('Likely dropped')
  if (event.kind === 'signal-degraded') ui.set('Connection unstable — observation degraded')
})

// One source — one upstream poll cycle — feeding both consumers.
```

### 16.3 `examples/09-bulk-from-address.ts` — indexer-style

```ts
const sub = tracker.trackFromAddress(treasuryAddress, { durable: true })
for await (const match of sub.events()) {
  console.log('treasury sent tx', match.hash)
  // automatically per-hash-tracked under the hood
}
```

---

## 17. Testing strategy

The tracker is a pure state-machine over event streams; testing it is
mostly about driving fixture event sequences and asserting the emitted
events. Layered:

### 17.1 Unit tests (`packages/tx-tracker/src/*.test.ts`)

- `events.test.ts` — event-builder helpers, payload shape correctness,
  envelope completeness.
- `capabilities.test.ts` — probe behavior under each combination of
  available / gated / unavailable upstream methods. Use
  `safeRequest`-injected fakes.
- `reorg.test.ts` — reorg detector as a pure function over
  `BlockSample[]`. Drive with hand-built ring sequences. Assert
  `vanished-from-block` events for every divergence; no events on a
  clean chain extension.
- `store.test.ts` — `createInMemoryStore` retention, eviction, event
  log capacity, durable list.
- `selectors.test.ts` — bulk matchers across `from` / `to` / predicate.

### 17.2 Integration tests (`packages/tx-tracker/src/tracker.test.ts`)

- Drive `createTxTracker` with a stub `ChainSource` — a hand-rolled
  object implementing the §3.2 interface, no live RPC. The
  `ChainSource` interface is the testing seam: tests fixture the
  source's `subscribeBlocks` / `subscribeMempool` callbacks to fire
  on demand and the on-demand methods (`getReceipt`, `getTransaction`)
  to return fixture data.
- Drive synthetic block + mempool snapshots into the source's
  subscribers; assert the events the tracker emits.
- Assert end-to-end event sequences for: simple inclusion, reorg
  before confirmation, replacement-by-bumped-tip, dropped tx,
  WS-drop-mid-tracking (re-probe), durable subscription resume.

A separate suite (`packages/chain-source/src/source.test.ts`) tests
the source itself: probe behavior, push/poll fan-out, multi-subscriber
correctness (N subscribers see identical streams), reconnect re-probe.

### 17.3 Capability-matrix matrix tests

The tracker should produce **identical** observed-state for the same
ground-truth chain history, regardless of which capabilities are
present (modulo `source` field varying). Fixture: a hand-built block
sequence with one tracked hash; run the tracker once with all
capabilities, once with WS only, once with HTTP-poll only, once with
receipt-poll only. Assert the set of `kind` values matches across all
four runs (the `source` field varies, but no events are missed or
duplicated).

This test pins the "no silent downgrade" invariant.

### 17.4 Browser smoke (manual / CI optional)

Build the sub-export with Vite for `target: 'esnext'` and import in a
browser context. Verify no Node-only requires leaked in. Already
covered by typecheck in the existing `examples/tsconfig.json`'s
`module: ESNext` resolution; a follow-up PR can add a real browser
smoke job to CI.

---

## 18. Open questions / deferred to v0.4.0+

### 18.1 Cross-tx correlation (NOT in v0.3.0)

A wallet that submits a "claim + swap" pair wants to see both tracked
txs in one logical group. The tracker today gives one stream per hash;
correlation is the consumer's problem. A v0.4.0 `tracker.group([...hashes])`
that emits aggregated events is on the roadmap; deferred until v0.3.0
ships and consumers tell us they need it.

### 18.2 Receipt enrichment (NOT in v0.3.0)

`seen-in-block` events do not carry the receipt's `status` /
`logs` / `gasUsed`. Fetching the receipt is one extra RPC per
inclusion; doing it unconditionally bloats the tracker's RPC budget.
v0.3.0 leaves receipt fetch to the consumer. v0.4.0 may add an
opt-in `withReceipts: true` that issues the fetch lazily only when
the consumer reads the field.

### 18.3 Multi-chain tracker (NOT in v0.3.0)

`createTxTracker` is one-instance-per-chain, mirroring
`createGasOracle`. A multi-chain registry is a wrapper, not a core
feature. Could ship as `examples/10-multi-chain-tracker.ts` after
v0.3.0 lands.

### 18.4 Predicate-selector durability

Predicate bulk subscriptions are non-durable in v0.3.0 because
serialized closures aren't a thing. A future iteration may support
DSL-described matchers (e.g. JSON-encoded "to-address-in-set" rules)
that ARE durable. Tracking as a v2 nice-to-have.

### 18.5 Replacement detection without `eth_getTransactionByHash`

If both `eth_getTransactionByHash` and the standard `from`-recovery
path are unavailable on the upstream, replacement detection
silently can't run. v0.3.0 surfaces this via `capabilities()` —
consumers see `receiptByHash: 'unavailable'` and know that
`replaced-by` events won't fire. Future versions may attempt
recovery via the mempool snapshot's (from, nonce) collisions, but
that path is unreliable enough that it's deferred until there's a
real consumer driving it.

---

## Appendix A: failure scenarios

| Scenario | What the tracker does | What the consumer sees |
| --- | --- | --- |
| WS drops mid-track, no HTTP fallback | Re-probe on reconnect; emit `signal-degraded` | `signal-degraded { capabilityLost: 'newHeads' }` then events resume from receipt-poll |
| `txpool_content` newly gated | Disable mempool-watch path; emit `signal-degraded` | `signal-degraded { capabilityLost: 'txpoolContent' }`; no further `seen-in-mempool` events |
| Provider returns 200 but stale data | Inclusion-check pass uses the data anyway; trend-detect via consecutive `at.blockNumber` plateau | Consumer sees `at.blockNumber` not advancing; can detect via timestamps |
| Tracked hash disappears + reappears (rare reorg path) | `vanished-from-block` then fresh `seen-in-block` at the new canonical block | Two distinct events; `confirmations` resets |
| Tracker stops while iterator is mid-await | Iterator next-tick yields `Stopped { reason: 'tracker-stopped' }`, then completes | Final event in stream is `Stopped`; loop exits cleanly |
| Store `appendEvent` throws | Error routed through `onError`; tracker continues; event NOT retried | Consumer sees the live event; durable log is missing the entry. Catch-up on next restart MAY skip it |
| Consumer's `subscribe` callback throws | Swallowed (per §5.1) | No effect on other subscribers; the tracker keeps going |

---

## Appendix B: RPC method usage by capability

| Method | Purpose | When called | If `unavailable`/`gated` |
| --- | --- | --- | --- |
| `eth_subscribe('newHeads')` | Push new-block events | Once at start, when capability is `subscription` | Fall back to block-poll on the source's tick |
| `eth_subscribe('newPendingTransactions')` | Push mempool ingress | Once at start, when capability is `subscription` | Fall back to `txpool_content` snapshot on the source's tick |
| `eth_getBlockByNumber('latest', true)` | Block-poll inclusion-check | Every source tick (one cycle, fanned to all subscribers) | Tracker can't operate without this; source throws at construction if it's gated |
| `txpool_content` | Mempool snapshot for `seen-in-mempool` / bulk matching | Every source tick (one fetch, fanned to all subscribers) | Disable mempool path; `signal-degraded { capabilityLost: 'txpoolContent' }` |
| `eth_getTransactionReceipt` | Inclusion-check fallback when block-poll missed | Per-tracked-hash, per-tick when `lostSignalPolicy === 'receipt-poll-fallback'` | Replacement detection can't run; `capabilities().receiptByHash === 'unavailable'` |
| `eth_getTransactionByHash` | Look up (from, nonce) for replacement detection | Once per tracked hash on first observation | Replacement detection can't run; `replaced-by` events never fire |
| `eth_getTransactionCount(latest)` | Find canonical-mined nonce on a sender | When `replaced-by` detection is needed | Same as above |

---

## Sign-off

This spec is the contract for v0.3.0. Implementation, tests, examples,
and skill updates all reconcile against it. Changes to the spec during
implementation are fair game, but they update **this document first**;
the doc is the source of truth.

To raise an issue with the spec, open a PR against
`docs/tx-tracker-spec.md` describing the change, the rationale, and
which sections it affects. Don't push spec drift onto the implementation.
