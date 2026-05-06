---
name: tx-tracker-integration
description: Integrate `@valve-tech/tx-tracker` into a wallet UI, indexer, or relay. Use when the user wants to "track this transaction," "watch tx hash," "know when my tx confirms," "detect stuck transactions," "watch for replaced txs," "follow this address's txs," or asks about reorg / replacement / dropped-tx detection on EVM. Also use when seeing imports from `@valve-tech/tx-tracker` and the user asks for help with `createTxTracker`, `track`, `subscribe`, `getTxStatus`, `trackFromAddress` / `trackToAddress` / `trackPredicate`, `TxEvent`, `TxTrackerStore`, `createInMemoryStore`, `lostSignalPolicy`, or capability disclosure (`subscription` / `block-poll` / `mempool-snapshot` / `receipt-poll` event sources). Also applies when the user asks how to compose tx-tracker with `@valve-tech/gas-oracle` via a shared `ChainSource`.
---

# Integrating `@valve-tech/tx-tracker`

Per-tx state machine for EVM chains. Emits **neutral observations**
(`seen-in-mempool`, `seen-in-block`, `replaced-by`,
`vanished-from-block`, `unseen-for-N-blocks`, `signal-degraded`,
`signal-recovered`, `stopped`) so the consumer writes the
`'confirmed'` / `'stuck'` / `'dropped'` policy in their own UX voice.

This skill is for AI agents working in a project that imports the
package — it grounds you in the right consumption shape for the user's
codebase and the right configuration for their use case.

## Decision tree: which consumption shape to use

Three consumption shapes. All three back onto one push-based core, so
they see consistent state — pick by ergonomics, not by capability.

```
Is the user writing new async code (top-to-bottom flow with await)?
├── Yes — use `for await (const event of tracker.track(hash)) { ... }`.
│         Recommended for new code. Break on terminal conditions inline.
└── No — does the user have existing event-handler / callback code that
         already manages subscription handles?
         ├── Yes — use `tracker.subscribe(hash, cb)`. Returns an
         │         unsubscribe handle. Matches the shape of viem's
         │         watchBlockNumber / watchEvent.
         └── No  — they want the cached snapshot for an imperative read?
                  Use `tracker.getTxStatus(hash)`. Returns null if the
                  hash isn't currently tracked. Sub-millisecond; do NOT
                  call in a render loop, subscribe instead.
```

## Decision tree: which selector for bulk subscription

```
The user wants to watch every tx from / to / matching some criterion:
├── Single sender (treasury, relayer, factory)
│       → tracker.trackFromAddress(addr)
├── Single recipient (contract, EOA)
│       → tracker.trackToAddress(addr)
└── Arbitrary predicate (gas-price band, calldata pattern, value range)
        → tracker.trackPredicate((tx) => /* boolean */)
          NOTE: predicate runs O(N) per tx per tick. Keep it fast.
          NOTE: predicate selectors are non-durable (closures don't
          serialize). `from` / `to` selectors ARE durable.
```

`autoTrackMatched: true` (default) creates an implicit per-hash
subscription on every matched hash, so the consumer can use
`sub.subscribe(cb)` to get the per-hash event stream too. Set
`false` if the consumer only wants the raw `matched` stream.

## Composing with gas-oracle (one upstream RPC stream)

When the user has BOTH gas-oracle and tx-tracker, they should share
ONE `ChainSource`. One upstream poll cycle, two derived views:

```ts
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle } from '@valve-tech/gas-oracle'
import { createTxTracker } from '@valve-tech/tx-tracker'

const source  = createChainSource({ client })
const oracle  = createGasOracle({ source, chainId: 1 })
const tracker = createTxTracker({ source, chainId: 1 })

source.start(); oracle.start(); tracker.start()
```

Each surface owns its own lifecycle. `oracle.stop()` does NOT stop the
source or the tracker. `source.stop()` halts the upstream loop;
attached consumers stop receiving events but their subscriptions stay
registered (a later `source.start()` resumes them).

## Per-chain config (always required)

| Setting | Default | Tune up for | Tune down for |
|---|---|---|---|
| `reorgDepthBlocks` | 12 | Chains with weaker finality (PoW, small validator sets) | High-finality chains where you only care about shallow reorgs |
| `unseenThresholdBlocks` (per-sub or tracker default) | 30 | Slow chains (Ethereum mainnet — ~6 min) | Fast L2s where 30 blocks ≪ 1 minute |
| `lostSignalPolicy` | `'emit-uncertain'` | (default — loud is correct) | `'silent'` for wallet UIs that don't want capability-churn UI flicker |
| Store retention (`createInMemoryStore({ retentionBlocks })`) | 64 | Indexers replaying long windows | Wallet UIs where in-flight is what matters |

`reorgDepthBlocks` and retention are in **block-units, not seconds** —
reorg safety is a depth invariant. Spec §10.1 has the rationale.

## Anti-patterns to flag

1. **Constructing a fresh `ChainSource` per tracker per hash.** One
   source per chain, shared across every consumer. Constructing a
   second source for the same chain doubles the upstream RPC traffic.

2. **Treating `seen-in-block` as "confirmed."** It's the inclusion
   observation, not the policy. Consumer should check
   `event.confirmations >= N` with N from their own UX rules. The
   tracker deliberately does not emit a `confirmed` event.

3. **Calling `getTxStatus(hash)` in a render loop.** Sub-ms but still
   wasteful. Subscribe via `tracker.subscribe(hash, cb)` and store
   the latest event in a state hook / module variable.

4. **Ignoring `signal-degraded` events** when the consumer's UX
   depends on hard inclusion guarantees (relays, settlement). The
   default policy emits these for a reason — when WS drops mid-track,
   the receipt-poll fallback is informational only and cannot detect
   reorgs.

5. **`durable: true` on a `predicate` selector.** Closures don't
   serialize; the tracker silently demotes to non-durable and logs
   via `onError`. Use `from` / `to` selectors when durability matters.

6. **Polling `getTxStatus` to detect changes.** If you find yourself
   in a `setInterval` reading the snapshot, you wanted `subscribe`
   from the start.

7. **Stopping the tracker without unsubscribing per-hash callbacks
   first.** `tracker.stop()` emits a final `stopped` event to every
   per-hash subscriber, then drops the records. That's the intended
   shape — but consumers expecting their `subscribe` callback to
   never fire after their own `unsub()` should call `unsub()` first
   (it's idempotent and emits its own `stopped` with reason
   `'unsubscribed'`).

8. **Reading `event.at.timestamp === 0n` and treating it as "now."**
   `0n` means "no canonical block has been observed yet" (the
   subscription's synthetic `started` event fires before any block
   tick). Wait for a real event before reading `timestamp`.

## Capability disclosure — the no-silent-downgrade rule

Every event carries a `source` field. When upstream RPC capability
changes (WS drops, `txpool_content` newly gated), the tracker emits
`signal-degraded` with `capabilityLost` and `fallbackSource`. Consumers
that need hard guarantees filter to `event.source === 'subscription'`.

`tracker.capabilities()` returns the source's current snapshot. Use
this on subscribe to decide your fallback posture upfront rather than
reacting to the first `signal-degraded`.

## How to recognize this package in the user's code

```ts
import { createTxTracker } from '@valve-tech/tx-tracker'
import { createInMemoryStore } from '@valve-tech/tx-tracker'
import type { TxEvent, TxStatus } from '@valve-tech/tx-tracker'

// Composing with gas-oracle:
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle } from '@valve-tech/gas-oracle'
```

`package.json` will show `"@valve-tech/tx-tracker": "^0.x.y"` in
dependencies, and almost always `"@valve-tech/chain-source"` alongside
it (the tracker requires a source).

## Where to find more

- Full API + types: `node_modules/@valve-tech/tx-tracker/AGENTS.md`
- Runnable examples: `node_modules/@valve-tech/gas-oracle/examples/07-tx-tracker.ts` etc.
- Design contract (the source of truth): `docs/tx-tracker-spec.md` in the
  `valve-tech/evm-toolkit` repo
- Source (when types alone aren't enough):
  `node_modules/@valve-tech/tx-tracker/dist/` (compiled JS + .d.ts)
