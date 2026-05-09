# AGENTS.md

Terse reference for AI agents (Claude Code, Cursor, Aider, etc.) integrating
`@valve-tech/chain-source`. The full README is for humans; this file is for
agents that need to ground their work in the package's actual surface
quickly.

## What this package does

Canonical EVM chain-observation primitive. Owns the upstream poll cycle,
the per-method capability probe, and a typed multi-subscriber pub/sub
for new blocks and mempool snapshots. Plus on-demand RPC passthroughs
(block, fee history, receipt, tx by hash, fresh mempool snapshot).

Designed as the **shared foundation** for derived views of chain state.
Both `@valve-tech/gas-oracle` (gas-tier reducer) and
`@valve-tech/tx-tracker` (per-tx state machine) consume a `ChainSource`
rather than re-implementing their own poll loops — one upstream RPC
stream feeds every consumer that attaches.

Browser/mobile-safe: no Node-only imports (`events`, `fs`, etc.).
`viem ^2.0.0` is the only peer dependency.

See `docs/tx-tracker-spec.md` §3 for the full design contract.

## Public API

All exports live under `src/index.ts`. Single subpath; no sub-exports.

```ts
import {
  createChainSource,                 // primary constructor
  Subscriptions,                     // typed pub/sub primitive (browser-safe)
  normalizeMempool,                  // pure helper — txpool_content → NormalizedMempool
  probeCapabilities,                 // standalone capability probe (used internally)
  // low-level transport helpers (also used internally)
  safeRequest,
  fetchBlock,
  fetchHeadBlockNumber,
  fetchFeeHistory,
  fetchTxPool,
  fetchReceipt,
  fetchTransaction,
  zeroHash,
  // types
  type ChainSource,
  type CreateChainSourceOptions,
  type BlockResult,
  type Capabilities,
  type EventSource,
  type FeeHistoryResult,
  type NormalizedMempool,
  type PollOptions,
  type RawTx,
  type TransactionReceipt,
} from '@valve-tech/chain-source'
```

## Five types you must know

| Type | What it is |
|---|---|
| `CreateChainSourceOptions` | Constructor config. Required: `client` (a viem `PublicClient`). Tuneables: `pollIntervalMs` (default `10_000`), `poll: { mempool?, feeHistory? }`, `onError`. |
| `ChainSource` | The instance. Lifecycle (`start` / `stop` / `pollOnce` / `ready`), two subscribe streams, five on-demand fetchers, plus `capabilities()`. |
| `BlockResult` | Wire-shape block: hex-encoded numbers (`number`, `timestamp`, `baseFeePerGas`, `gasLimit`, `gasUsed`, optional blob fields), full `transactions: RawTx[]`. Consumers decode the fields they need. |
| `NormalizedMempool` | `{ pending, queued }` two-level map: `sender (lowercase) → nonce (decimal string) → RawTx`. Always pre-normalized; consumers do O(1) two-key lookups, no case/format folding needed. |
| `Capabilities` | The probe result. Per-method, not per-transport — see the matrix below. |

## The capability matrix

Probed eagerly at construction, cached on the source, exposed via
`source.capabilities()`. The toolkit's "no silent downgrade" rule (spec
§2.2) is enforced *here* — every event a downstream emits carries an
`EventSource` discriminator chosen against this matrix.

```ts
interface Capabilities {
  newHeads:                 'subscription' | 'poll-only' | 'unavailable'
  newPendingTransactions:   'subscription' | 'poll-only' | 'unavailable'
  txpoolContent:            'available' | 'gated'
  receiptByHash:            'available' | 'unavailable'
  reprobeOnReconnect:       boolean
}
```

Read `'subscription'` as "push path is live", `'poll-only'` as
"falling back to the interval timer", `'unavailable'` as "no path —
this signal is silent on this RPC". The probe runs one opportunistic
`eth_subscribe('newHeads')` round-trip to distinguish "subscribe is on
the transport" from "subscribe actually works on this provider" — some
viem transports wrap-but-can't-subscribe and the structural-only check
would lie.

`reprobeOnReconnect` is `true` for WS transports that signal reconnect.
HTTP has no persistent connection so it's always `false`.

## The conservative probing window

For a brief window between `createChainSource()` and the eager probe
landing, `capabilities()` returns a `PROBING_DEFAULT` snapshot with
every signal set to the most defensive value (`unavailable` / `gated`).
This is intentional: a consumer that reads capabilities in this window
gets the safest answer (no path, fall back to the most defensive flow).

Callers that need a guaranteed-completed probe:

```ts
await source.ready()
const caps = source.capabilities()  // real values, not the defensive default
```

## `EventSource` discriminator

Reserved vocabulary for downstream events. The source itself doesn't
author editorial events (no `confirmed` / `failed` / `dropped` here —
those live in `@valve-tech/tx-tracker`); but events that downstreams
build from chain-source observations carry a `source` discriminator
chosen from this union:

```ts
type EventSource =
  | 'subscription'        // arrived via eth_subscribe (push)
  | 'block-poll'          // arrived via the source's eth_getBlockByNumber tick
  | 'mempool-snapshot'    // arrived via the source's txpool_content tick
  | 'receipt-poll'        // tx-tracker fallback per-hash receipt poll
```

Consumers that need hard guarantees on the freshness/authority of an
observation filter to `'subscription'`.

## Two integration shapes (pick one)

### 1. Standalone (you're building your own derived view)

```ts
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { createChainSource } from '@valve-tech/chain-source'

const client = createPublicClient({ chain: mainnet, transport: http() })
const source = createChainSource({ client })

const unsubBlocks = source.subscribeBlocks((block) => {
  // BlockResult — hex strings; decode the fields you care about
  console.log('block', BigInt(block.number), block.transactions.length, 'txs')
})

const unsubMempool = source.subscribeMempool((snapshot) => {
  // NormalizedMempool — pre-lowercased addresses, pre-decimalized nonces
  console.log('senders', Object.keys(snapshot.pending).length)
})

source.start()

// On-demand:
const receipt = await source.getReceipt('0xabc...')
const tx      = await source.getTransaction('0xabc...')
const fees    = await source.getFeeHistory(20, [25, 50, 75])

// Teardown — preserves the subscriber registry across restarts.
source.stop()
unsubBlocks()
unsubMempool()
```

### 2. Shared with sibling derived views (multi-subscriber)

```ts
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle }   from '@valve-tech/gas-oracle'
import { createTxTracker }   from '@valve-tech/tx-tracker'

const source  = createChainSource({ client })
const oracle  = createGasOracle({ source, chainId: 1 })
const tracker = createTxTracker({ source, chainId: 1 })

source.start(); oracle.start(); tracker.start()
// ↑ ONE shared poll cycle. Two derived views. No double-polling.
```

Each lifecycle is independent — `oracle.stop()` stops the oracle, not
the source. The owner of the source (whoever called
`createChainSource`) calls `source.stop()`.

## Pitfalls (read these)

1. **Don't call `source.start()` per request.** Module-scope the
   source so it starts once at process boot. A hot-path
   `createChainSource() → start() → subscribe → wait → stop` cycle
   pays the capability probe cost on every request and wastes the
   shared-fan-out design.

2. **`subscribeBlocks` / `subscribeMempool` callbacks must be cheap.**
   The fan-out runs synchronously over a snapshot of the subscriber
   set. Per-subscriber throws are swallowed (see `Subscriptions`),
   but a subscriber that blocks (synchronous heavy work) blocks every
   subscriber registered after it for that emit. Push expensive work
   into a microtask / worker if needed.

3. **Re-subscribing the same callback reference is a no-op.** The
   backing set deduplicates by reference. If you really want
   "deliver twice", register two distinct closures.

4. **`subscribeMempool` snapshots are NOT deduped.** Mempool entries
   come and go between blocks even on a static head — every
   successful tick emits. Block events ARE deduped (by hash, not
   number; same-height reorgs surface as fresh observations).

5. **`getMempoolSnapshot()` returns `null` when `txpool_content` is
   gated.** Most public RPCs gate this method. Check
   `source.capabilities().txpoolContent` before assuming a snapshot
   exists. For continuous mempool access, prefer `subscribeMempool` —
   that path reuses the source's poll cycle rather than firing a
   fresh RPC per call.

6. **`capabilities()` returns the defensive default before
   `await source.ready()`.** If your code branches on capabilities at
   construction time, await ready first or you'll always take the
   most-defensive branch.

7. **Stopping the source resets dedup state.** A start → stop → start
   pattern re-emits the current head + a fresh mempool snapshot on
   first re-tick (deliberate — a paused-then-resumed consumer should
   see a current snapshot, not wait for the next chain block). It does
   NOT clear the subscriber registry.

8. **Wire-format note.** Numeric fields on `BlockResult` /
   `FeeHistoryResult` / `TxPoolContent` arrive as **hex strings** —
   that's what the upstream JSON-RPC returns. The source decodes only
   the bits IT needs (block number for the head-probe gate); your
   consumer code decodes the rest at the point of use. `JSON.stringify`
   on a state object containing decoded `bigint` values will throw —
   hex-encode at the wire boundary if you persist.

## On-demand RPC helpers — source vs. transport

The package exports both `source.getBlock(...)` (instance method) and
`fetchBlock(client, ...)` (free function). Same underlying call.

- Use the instance methods (`source.getBlock`, `source.getReceipt`,
  etc.) when you have a source and want errors to flow through its
  `onError` sink.
- Use the free functions (`fetchBlock`, `fetchReceipt`, etc.) when
  you need a one-shot RPC without spinning up a source — e.g. inside
  a script, a test, or a function that already has a `PublicClient`
  in scope.

`safeRequest(client, method, params, onError?)` is the underlying
"never throws, returns null on error" wrapper used everywhere in the
package — use it directly for any custom RPC method that should follow
the same posture.

## Skills (for AI agents)

`skills/` ships in the npm tarball. If you're an AI agent working in a
project that has installed this package, look in
`node_modules/@valve-tech/chain-source/skills/chain-source-integration/SKILL.md`
for trigger conditions, anti-pattern flags, and recipes for picking
the right integration shape.

## Verifying provenance

Every published version ships with SLSA provenance attestation:

```bash
npm view @valve-tech/chain-source@latest --json | jq .dist.attestations
npm audit signatures
```

The attestation links the published tarball to the GitHub Actions
workflow run that built it.
