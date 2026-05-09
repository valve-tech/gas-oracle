---
name: chain-source-integration
description: Integrate `@valve-tech/chain-source` — the canonical EVM chain-observation primitive — into a dapp, indexer, watcher, or backend. Use when the user is wiring up a multi-subscriber poll/push source for new blocks or mempool snapshots, deciding whether to subscribe vs poll, asking about RPC capability disclosure (HTTP-only vs WS, `txpool_content` gating, `eth_getTransactionReceipt` fallback), sharing one upstream RPC stream between `@valve-tech/gas-oracle` and `@valve-tech/tx-tracker`, or sees imports from `@valve-tech/chain-source`. Also fires for questions about `subscribeBlocks` / `subscribeMempool`, the conservative probing-window default, the `EventSource` discriminator (`'subscription'` vs `'block-poll'` vs `'mempool-snapshot'` vs `'receipt-poll'`), or "why am I getting null from `getMempoolSnapshot()`?". Skip when the user only wants per-tx state (delegate to tx-tracker skill) or only wants gas-tier recommendations (delegate to gas-oracle skill); both are derived views built on top of this package and have their own integration skills.
---

# Integrating `@valve-tech/chain-source`

Canonical EVM chain-observation primitive: a unified push-or-poll
source for new blocks, mempool snapshots, on-demand receipt + tx
lookups, and explicit per-method capability disclosure. This skill is
for AI agents working in a project that imports the package — it
grounds you in the right integration shape and the per-RPC capability
realities you'll hit in production.

## Decision tree: which integration to use

```
Is the user composing this WITH @valve-tech/gas-oracle or
@valve-tech/tx-tracker (or both)?
├── Yes — construct ONE shared ChainSource, pass `source` (not `client`)
│         to each sibling. One upstream RPC poll cycle, multiple
│         derived views. Module-scope the source.
└── No — does the user need their own derived view of chain state
         (custom indexer, alerting, analytics, anything that needs
         the block + mempool stream)?
         ├── Yes — use `createChainSource` directly. Subscribe via
         │         `subscribeBlocks` / `subscribeMempool`.
         └── No  — they probably want one of the sibling packages
                  instead. Don't ship chain-source as a dependency just
                  to call `getReceipt` once — viem's `client.getTransactionReceipt`
                  already does that.
```

## How to recognize this package in the user's code

```ts
import {
  createChainSource,                 // primary constructor
  Subscriptions,                     // pub/sub primitive (rare to import)
  normalizeMempool,                  // pure helper
} from '@valve-tech/chain-source'
```

`package.json` will show `"@valve-tech/chain-source": "^0.10.x"` — and
typically also one or both of `@valve-tech/gas-oracle` /
`@valve-tech/tx-tracker` if they're using the shared-source shape.

## The capability matrix — what each state means for your code

`source.capabilities()` returns this snapshot. Branch on it for any
code path whose correctness depends on the underlying RPC's surface.

| Field | States | What to do |
|---|---|---|
| `newHeads` | `subscription` / `poll-only` / `unavailable` | If `subscription`, you'll get push events. If `poll-only`, you're on the interval timer (default 10s). `unavailable` means the transport has no `subscribe` at all (HTTP-only). |
| `newPendingTransactions` | `subscription` / `poll-only` / `unavailable` | Same shape. `poll-only` here means mempool falls back to the `txpool_content` tick. `unavailable` means there's no mempool path at all on this provider — `subscribeMempool` will never fire and `getMempoolSnapshot()` returns `null`. |
| `txpoolContent` | `available` / `gated` | Most public RPCs gate this. If `gated`, mempool is silent unless WS push is available. |
| `receiptByHash` | `available` / `unavailable` | `unavailable` is rare but real on some L2s/sidechains. tx-tracker's receipt-poll fallback path becomes a no-op. |
| `reprobeOnReconnect` | boolean | `true` for WS transports that signal reconnect; `false` for HTTP. Informational. |

Always read capabilities AFTER `await source.ready()` if you're
branching at construction time — before that, you get a defensive
default with everything `unavailable` / `gated`.

## Per-RPC capability profiles (what to expect)

| RPC class | `newHeads` | `newPendingTxs` | `txpool_content` | Notes |
|---|---|---|---|---|
| Self-hosted geth/reth (HTTP+WS) | `subscription` | `subscription` | `available` | Full surface; the default-everything-works case. |
| Self-hosted geth/reth (HTTP only) | `unavailable` | `poll-only` | `available` | No push; poll cycle drives everything. |
| Alchemy / Infura / QuickNode (WS) | `subscription` | `subscription` (Alchemy) / `unavailable` (some) | `gated` | Push-based blocks; mempool depends on plan tier. |
| Public RPC aggregators (LlamaNodes, Ankr, etc., HTTP) | `unavailable` | `unavailable` | `gated` | Block-poll only; mempool is silent. Set `poll: { mempool: false }` to skip the doomed RPC. |
| PulseChain RPCs (typical) | varies by node | varies | often `gated` | Verify `txpool_content` per node — public PulseChain RPCs frequently gate it. |

If `txpoolContent === 'gated'` AND `newPendingTransactions === 'unavailable'`,
mempool data is structurally unobtainable on this RPC. Flag that to the
user — don't write code that silently does nothing.

## Anti-patterns to flag

When reviewing user code, watch for these and suggest fixes:

1. **Constructing a `ChainSource` per request / per render.** The
   capability probe runs eagerly at construction; the poll loop runs
   on a timer. Both are wasted if you tear it down 100ms later.
   Module-scope it.

2. **Constructing a separate `ChainSource` for the gas-oracle AND
   for the tx-tracker.** That's two independent poll cycles for the
   same chain — double the RPC traffic for no benefit. Construct one
   source, pass it to both:
   ```ts
   const source = createChainSource({ client })
   const oracle = createGasOracle({ source, chainId: 1 })
   const tracker = createTxTracker({ source, chainId: 1 })
   ```

3. **Reading `source.capabilities()` without `await source.ready()`
   first** — getting the defensive default and branching on it. Code
   ends up perma-stuck on the most-defensive path even on a fully-
   capable provider. Either `await ready()` or wait for the first
   subscribe event before branching.

4. **Ignoring `source.capabilities().txpoolContent === 'gated'`** then
   wiring up `subscribeMempool` and being confused about why nothing
   fires. If the upstream gates the method AND there's no WS push
   path for `newPendingTransactions`, the mempool stream will never
   emit — either set `poll: { mempool: false }` to skip the doomed
   RPC or surface the gap to the user.

5. **Calling `source.start()` but never `subscribeBlocks` / never
   `subscribeMempool`.** The poll cycle runs, the RPCs fire, but
   nothing is consuming the events — pure waste. Either subscribe or
   use the on-demand methods (`getBlock`, `getReceipt`, etc.) which
   don't need `start()`.

6. **Calling `source.subscribeMempool` and treating the snapshots as
   diffs.** They're not — every successful mempool tick emits the
   FULL pending+queued snapshot. If you need diffs, hold the previous
   snapshot in your subscriber and compute the delta yourself.

7. **Persisting `BlockResult` / `NormalizedMempool` via
   `JSON.stringify`** without hex-encoding bigints first. The
   wire-shape types are hex strings already, but anything you
   decoded to bigint will throw. The toolkit deliberately keeps
   bigint as the canonical numeric form internally; encoding at the
   wire boundary is the consumer's job.

8. **Subscribing the same callback reference twice expecting two
   deliveries.** The backing set deduplicates by reference. If you
   really want two deliveries, register two distinct closures.

## Standalone usage — minimal

```ts
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { createChainSource } from '@valve-tech/chain-source'

const client = createPublicClient({ chain: mainnet, transport: http() })
const source = createChainSource({
  client,
  pollIntervalMs: 12_000,                         // optional; default 10_000
  poll: { mempool: false },                       // skip doomed txpool_content
  onError: (method, err) => console.warn(method, err),
})

await source.ready()  // wait for capability probe before branching

if (source.capabilities().newHeads === 'unavailable') {
  console.log('poll-only mode — no WS subscribe path')
}

const unsub = source.subscribeBlocks((block) => {
  console.log('new block', BigInt(block.number))
})

source.start()
// ... later
unsub()
source.stop()
```

## Composing with gas-oracle and tx-tracker

When the user is using two or more derived views, the canonical shape
is one shared source:

```ts
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle }   from '@valve-tech/gas-oracle'
import { createTxTracker }   from '@valve-tech/tx-tracker'

const client  = createPublicClient({ chain: mainnet, transport: http() })
const source  = createChainSource({ client })
const oracle  = createGasOracle({ source, chainId: 1 })
const tracker = createTxTracker({ source, chainId: 1 })

source.start(); oracle.start(); tracker.start()
```

`ChainSource` owns the upstream poll cycle. The oracle reads it for
tier reduction; the tracker reads it for per-tx observations. **One
upstream RPC poll cycle, two derived views** (per spec §3.1). Each
surface owns its own lifecycle — `oracle.stop()` does not stop the
source or the tracker. The owner of the source (whoever called
`createChainSource`) calls `source.stop()`.

For per-tx tracking work (subscribe to a hash, watch for replacement,
detect drops), redirect to the tx-tracker integration skill at
`node_modules/@valve-tech/tx-tracker/skills/tx-tracker-integration/SKILL.md` —
chain-source itself is intentionally **stateless about per-tx
anything**.

For gas-tier work (priority-fee tiers, replacement bumps, block
position queries), redirect to
`node_modules/@valve-tech/gas-oracle/skills/gas-oracle-integration/SKILL.md` —
chain-source is intentionally **stateless about gas math**.

## On-demand RPCs without a running source

When you only need a one-shot RPC (a script, a test, a utility
function that already has a `PublicClient`), the package exports
free-function transport helpers — same calls as the source's instance
methods, no construction or lifecycle overhead:

```ts
import {
  fetchBlock,
  fetchReceipt,
  fetchTransaction,
  fetchFeeHistory,
  fetchTxPool,
  safeRequest,
} from '@valve-tech/chain-source'

const block   = await fetchBlock(client, 'latest')
const receipt = await fetchReceipt(client, '0xabc...')
const tx      = await fetchTransaction(client, '0xabc...')

// Custom method with the same "never throws, returns null" posture:
const custom = await safeRequest(client, 'eth_chainId', [])
```

These are the same primitives the source uses internally. Each takes
an optional `onError(err)` sink as the last arg.

## The `EventSource` discriminator

When a downstream view (tx-tracker, your own derived view) emits
events built from chain-source observations, those events should
carry an `EventSource` discriminator chosen against the capability
matrix. This is the toolkit's "no silent downgrade" rule made
observable:

```ts
type EventSource =
  | 'subscription'        // arrived via eth_subscribe (push)
  | 'block-poll'          // arrived via the source's eth_getBlockByNumber tick
  | 'mempool-snapshot'    // arrived via the source's txpool_content tick
  | 'receipt-poll'        // tx-tracker fallback per-hash receipt poll
```

When you build your own derived view, follow the same pattern —
attach a `source` field to your emitted events so consumers can filter
to `'subscription'` for hard-guarantee freshness.

## Where to find more

- Full API + types: `node_modules/@valve-tech/chain-source/AGENTS.md`
- Human-facing docs: `node_modules/@valve-tech/chain-source/README.md`
- Source (when types alone aren't enough): `node_modules/@valve-tech/chain-source/dist/`
  (compiled JS + .d.ts) — sources aren't shipped, only built output.
- Design contract: the published-on-GitHub `docs/tx-tracker-spec.md`
  §3 covers the source's role in the toolkit's broader architecture.
