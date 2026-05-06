# AGENTS.md

Terse reference for AI agents (Claude Code, Cursor, Aider, etc.) integrating
`@valve-tech/tx-tracker`. The full README is for humans; this file is for
agents that need to ground their work in the package's actual surface
quickly.

## What this package does

Per-tx state machine for EVM chains. Consumes a `ChainSource`'s block +
mempool stream and emits **neutral observations** (`seen-in-mempool`,
`seen-in-block`, `replaced-by`, `vanished-from-block`,
`unseen-for-N-blocks`, `signal-degraded`, `signal-recovered`,
`stopped`). Three consumption shapes (callback / async iterator /
snapshot) over one push-based core. Per-method capability disclosure
keeps the no-silent-downgrade rule.

Sibling to `@valve-tech/gas-oracle` — both consume the same
`ChainSource`, neither depends on the other. One upstream RPC poll
cycle can feed both.

`viem ^2.0.0` is the only external peer. `@valve-tech/chain-source`
is a runtime dependency.

## Public API

All exports live under `src/index.ts` (single subpath; no sub-exports).

```ts
import {
  createTxTracker,                   // primary constructor
  createInMemoryStore,               // default TxTrackerStore impl
  computeRetentionExpiry,            // pure helper
  defaultRetentionBlocks,            // 64
  defaultReorgDepthBlocks,           // 12
  defaultMaxBulkSubscriptions,       // 16
  // pure detectors / matchers
  appendBlock,
  detectDivergences,
  compileSelector,
  matchAll,
  // event builders (mostly internal — exported for store implementers)
  buildStarted, buildSeenInMempool, buildLeftMempool,
  buildSeenInBlock, buildVanishedFromBlock, buildReplacedBy,
  buildUnseenForNBlocks, buildSignalDegraded, buildSignalRecovered,
  buildStopped, buildInitialStatus,
  // types
  type TxTracker,
  type CreateTxTrackerOptions,
  type TrackOptions,
  type BulkTrackOptions,
  type TxMatchEvent,
  type TxSubscription,
  type LostSignalPolicy,
  type TxEvent,
  type TxEventStarted, type TxEventSeenInMempool, type TxEventLeftMempool,
  type TxEventSeenInBlock, type TxEventVanishedFromBlock,
  type TxEventReplacedBy, type TxEventUnseenForNBlocks,
  type TxEventSignalDegraded, type TxEventSignalRecovered,
  type TxEventStopped,
  type TxStatus,
  type Address, type Hash, type At, type Envelope,
  // store types
  type TxTrackerStore,
  type TrackedTxRecord,
  type PersistedSubscription,
  type HashSelector,
  type BulkSelector,
  type InMemoryStoreOptions,
  // reorg
  type BlockSample,
  type BlockDivergence,
  // selectors
  type CompiledSelector,
  type BulkMatchPayload,
} from '@valve-tech/tx-tracker'
```

## Five types you must know

| Type | What it is |
|---|---|
| `CreateTxTrackerOptions` | Constructor config. Required: `source`, `chainId`. Tuneables: `store`, `lostSignalPolicy`, `reorgDepthBlocks`, `unseenThresholdBlocks`, `maxBulkSubscriptions`, `onError`, `lifecycle`. |
| `TxEvent` | Discriminated union of 10 variants (see below). Every variant carries `{ hash, chainId, source, at: { blockNumber, timestamp } }`. |
| `TxStatus` | Cached snapshot returned by `getTxStatus(hash)`. Carries the **last observation** (`lastSeenInBlock`, `lastSeenInMempool`, `replacedBy`, `vanishedAt`) plus housekeeping (`unseenStreak`, `firstObservedAtBlock`, `lastObservedAtBlock`, `capabilities`). |
| `TxTrackerStore` | Persistence surface. `put` / `get` / `delete` / `listDurable` / `appendEvent` / `readEventLog?`. Default: `createInMemoryStore`. |
| `BulkSelector` | `{ kind: 'from' \| 'to' \| 'predicate', address?, match? }`. From / to lowercase the address once at compile time. Predicate runs O(N) per tx per tick. |

## The discriminated `TxEvent`

Every event carries the same envelope; the `kind` field discriminates
the variant-specific payload.

```ts
type TxEvent =
  | { kind: 'started';              capabilities: Capabilities }
  | { kind: 'seen-in-mempool';      bucket: 'pending' | 'queued'; tx: RawTx }
  | { kind: 'left-mempool' }
  | { kind: 'seen-in-block';        blockHash; blockNumber; transactionIndex; confirmations }
  | { kind: 'vanished-from-block';  previousBlockHash; canonicalBlockHash; blockNumber }
  | { kind: 'replaced-by';          replacementHash; replacementBlockNumber: bigint | null }
  | { kind: 'unseen-for-N-blocks';  blocks: number }
  | { kind: 'signal-degraded';      capabilityLost: keyof Capabilities; fallbackSource }
  | { kind: 'signal-recovered';     capabilityRestored: keyof Capabilities }
  | { kind: 'stopped';              reason: 'unsubscribed' | 'retention-expired' | 'tracker-stopped' }
```

The envelope on every variant:

```ts
{
  hash: Hash
  chainId: number
  source: 'subscription' | 'block-poll' | 'mempool-snapshot' | 'receipt-poll'
  at: { blockNumber: bigint; timestamp: bigint }
}
```

## Three consumption shapes (consistent across all three)

```ts
// 1. Snapshot — sub-millisecond, returns null if not tracked
const status = tracker.getTxStatus(hash)

// 2. Callback — returns an unsubscribe handle
const unsub = tracker.subscribe(hash, (event) => { /* ... */ })

// 3. Async iterator — recommended for new code
for await (const event of tracker.track(hash)) {
  if (event.kind === 'seen-in-block' && event.confirmations >= 6) break
}
```

All three back onto the same internal `Subscriptions<TxEvent>` per
hash, so they see consistent state.

## Bulk subscriptions (indexer-style)

```ts
const sub = tracker.trackFromAddress(treasuryAddress, { durable: true })
// raw match stream:
for await (const m of sub.events()) { /* m: TxMatchEvent */ }
// per-hash event stream (auto-tracked by default):
sub.subscribe((event) => { /* TxEvent */ })
sub.stop()  // does NOT stop already-auto-tracked per-hash subs
```

`trackFromAddress` / `trackToAddress` / `trackPredicate`. Capped at
`maxBulkSubscriptions: 16` by default.

## Composing with gas-oracle

One `ChainSource` shared across both — one upstream RPC poll cycle:

```ts
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle }   from '@valve-tech/gas-oracle'
import { createTxTracker }   from '@valve-tech/tx-tracker'

const source  = createChainSource({ client })
const oracle  = createGasOracle({ source, chainId: 1 })
const tracker = createTxTracker({ source, chainId: 1 })

source.start(); oracle.start(); tracker.start()
```

Each surface owns its own lifecycle — `oracle.stop()` does not stop
the source or the tracker.

## Configuration patterns

| Setting | Default | Tune up for | Tune down for |
|---|---|---|---|
| `reorgDepthBlocks` | 12 | Weak-finality chains (PoW, small validator sets) | High-finality chains; only care about shallow reorgs |
| `unseenThresholdBlocks` | 30 | Slow chains (Ethereum: ~6 min) | Fast L2s |
| `lostSignalPolicy` | `'emit-uncertain'` | (default — loud is correct) | `'silent'` for wallets that don't want capability-churn UI flicker |
| `createInMemoryStore({ retentionBlocks })` | 64 | Indexers replaying long windows | Wallet UIs |
| `createInMemoryStore({ eventLogCapacity })` | 256 | Heavy catch-up on restart | Memory-constrained mobile / edge |

`reorgDepthBlocks` and retention are in **block-units, not seconds** —
reorg safety is a depth invariant. Spec §10.1.

## Wire format

All numeric fields are `bigint` (block numbers, fees, timestamps).
`JSON.stringify(event)` will throw without hex-encoding at the wire
boundary. Durable store implementers MUST hex-encode (`'0x' + n.toString(16)`)
on write and decode on read. The default in-memory store keeps `bigint`
end-to-end.

## Capability disclosure

`tracker.capabilities()` forwards the source's snapshot:

```ts
{
  newHeads:                'subscription' | 'poll-only' | 'unavailable'
  newPendingTransactions:  'subscription' | 'poll-only' | 'unavailable'
  txpoolContent:           'available' | 'gated'
  receiptByHash:           'available' | 'unavailable'
  reprobeOnReconnect:      boolean
}
```

When capabilities change mid-tracking, the tracker emits
`signal-degraded` / `signal-recovered` per affected key. Consumers that
need hard inclusion guarantees filter to `event.source === 'subscription'`.

## Examples

- `examples/07-tx-tracker.ts` — minimal tracker, no oracle (async iterator)
- `examples/08-tx-tracker-with-oracle.ts` — shared `ChainSource` between gas-oracle + tracker
- `examples/09-bulk-from-address.ts` — indexer-style bulk subscription

(Examples live under `node_modules/@valve-tech/gas-oracle/examples/` —
the toolkit's examples directory is hosted by gas-oracle.) Run with
`yarn tsx examples/07-tx-tracker.ts`.

## Skills (for AI agents)

`skills/` directory ships in the npm tarball. If you're an AI agent
working in a project that has installed this package, look in
`node_modules/@valve-tech/tx-tracker/skills/tx-tracker-integration/SKILL.md`
for trigger conditions and integration recipes that go deeper than this
file.

## Verifying provenance

v0.6.0+ ships with SLSA provenance attestation:

```bash
npm view @valve-tech/tx-tracker@latest --json | jq .dist.attestations
npm audit signatures
```

The attestation links the published tarball to the GitHub Actions
workflow run that built it.
