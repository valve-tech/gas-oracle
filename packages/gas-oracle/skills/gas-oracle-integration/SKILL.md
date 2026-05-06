---
name: gas-oracle-integration
description: Integrate `@valve-tech/gas-oracle` into an EVM dapp or backend. Use when the user wants gas-tier recommendations (`slow` / `standard` / `fast` / `instant`), needs to set `maxPriorityFeePerGas` and `maxFeePerGas` for a transaction, or asks "how do I price a transaction" against a viem `PublicClient`. Also use when seeing imports from `@valve-tech/gas-oracle` and the user asks for help configuring it per chain (Ethereum, Base, Arbitrum, OP, PulseChain), or asks about `priorityFeeDecayCap`, `priorityModel`, `tipForBlockPosition`, viem-actions, or viem-transport. Also fires when the user asks about composing the oracle with `@valve-tech/tx-tracker` over a shared `ChainSource` — but actual per-tx tracking work belongs in the tx-tracker skill, not here.
---

# Integrating `@valve-tech/gas-oracle`

Multi-tier gas-fee oracle for EVM chains. This skill is for AI agents
working in a project that imports the package — it grounds you in the
right configuration choices for the user's chain and the right
integration shape for their codebase.

## Decision tree: which integration to use

```
Is the user already passing a viem PublicClient around?
├── Yes — use viem-actions (`client.extend(gasOracleActions(...))` or
│         the direct invocation `gasOracleActions(opts)(client)`).
│         Most ergonomic for app code.
└── No — does the user have wagmi/viem code that already calls
         `client.getGasPrice()` / `eth_maxPriorityFeePerGas`?
         ├── Yes — use viem-transport (`withGasOracle(transport, ...)`)
         │         to intercept those methods at the RPC layer. Drop-in.
         │         No call-site changes.
         └── No — use the direct constructor `createGasOracle(opts)`.
                  Simplest. Read tiers via `oracle.getState()?.tiers`.
```

## Per-chain config (always required)

| Chain | `chainId` | `priorityModel` | `baseFeeLivenessBlocks` | Notes |
|---|---|---|---|---|
| Ethereum mainnet | 1 | `'eip1559'` | 6 | Validators burn base fee. |
| Base | 8453 | `'eip1559'` | 6 | Same as ETH. |
| Arbitrum One | 42161 | `'eip1559'` | 6 | |
| Optimism | 10 | `'eip1559'` | 6 | |
| PulseChain mainnet | 369 | `'flat'` | 6 | Validators charge tips. |
| PulseChain testnet v4 | 943 | `'flat'` | 6 | |
| Unknown / unsure | — | `'flat'` | 6 | Conservative; never under-counts. |

`priorityFeeDecayCap`: leave at default (`WAD/8` = 12.5%/block, EIP-1559
parity) unless you have a specific reason to tighten/loosen.

## Anti-patterns to flag

When reviewing user code, watch for these and suggest fixes:

1. **Multiple oracles per chain in the same process.** Construct once,
   module-scope it. Each oracle runs a poll interval and holds state.
   Two oracles for chain 1 = double the RPC traffic, no benefit.

2. **`oracle.getState()` in a hot path that runs every render / every
   request.** It's O(1) but you're wasting cache lines. Either subscribe
   via `oracle.subscribe(cb)` and store the latest state in a module
   variable, or cache the result yourself with a short TTL.

3. **Reading `oracle.getState()` immediately after `oracle.start()`
   without handling null.** First poll hasn't completed yet; tiers will
   be missing. Fix: `await oracle.pollOnce()` after `start()` to seed
   state synchronously, then it's safe to call `getState()`.

4. **Using `priorityModel: 'eip1559'` on PulseChain or other tip-charging
   chains.** Cuts the distribution to type-2+ samples only, but
   PulseChain validators don't honor the type byte — they sort by tip
   regardless. Result: under-published tier values, your tx loses to
   legacy spam.

5. **`keepMempoolSnapshot: true` on a chain whose RPC gates
   `txpool_content`** (most public RPCs). Wastes a poll cycle's RPC
   budget on a request that always errors. Set `false` until you have
   a node you operate.

6. **Calling `findTxInMempool` with a hash that's been confirmed.**
   Confirmed txs are NOT in the mempool snapshot (it's pending+queued
   only). Check `eth_getTransactionByHash` instead.

## How to recognize this package in the user's code

```ts
// Direct constructor
import { createGasOracle } from '@valve-tech/gas-oracle'

// viem-actions extension
import { gasOracleActions } from '@valve-tech/gas-oracle/viem-actions'

// viem-transport interception
import { withGasOracle } from '@valve-tech/gas-oracle/viem-transport'
```

`package.json` will show `"@valve-tech/gas-oracle": "^0.2.x"` in dependencies.

## Where to find more

- Full API + types: `node_modules/@valve-tech/gas-oracle/AGENTS.md`
- Runnable examples: `node_modules/@valve-tech/gas-oracle/examples/`
- Human-facing docs: `node_modules/@valve-tech/gas-oracle/README.md`
- Source (when types alone aren't enough): `node_modules/@valve-tech/gas-oracle/dist/`
  (compiled JS + .d.ts) — sources aren't shipped, only built output.

## Tx tracking — composing with `@valve-tech/tx-tracker`

When the user asks to "track this transaction," "watch tx hash,"
"know when my tx confirms," or "detect stuck transactions," redirect
them to `@valve-tech/tx-tracker` (sibling package). The gas oracle
does NOT track per-tx state — that's a separate concern with its own
state machine, retention policy, and consumption shapes. See
`node_modules/@valve-tech/tx-tracker/skills/tx-tracker-integration/SKILL.md`
for the full integration recipe.

The two packages are designed to share one upstream RPC stream:

```ts
import { createChainSource } from '@valve-tech/chain-source'
import { createGasOracle }   from '@valve-tech/gas-oracle'
import { createTxTracker }   from '@valve-tech/tx-tracker'

const source  = createChainSource({ client })
const oracle  = createGasOracle({ source, chainId: 1 })
const tracker = createTxTracker({ source, chainId: 1 })

source.start(); oracle.start(); tracker.start()
```

`ChainSource` owns the upstream poll cycle. The oracle reads it for
tier reduction; the tracker reads it for per-tx observations. **One
upstream RPC poll cycle, two derived views** (per spec §3.1). Each
surface owns its own lifecycle — `oracle.stop()` does not stop the
source or the tracker.

### Anti-patterns when both are present

7. **Constructing a private `ChainSource` for the tracker AND passing
   `client` (not `source`) to `createGasOracle`.** That gives you two
   independent sources for the same chain — double the RPC traffic
   for no functional benefit. Either pass `source` to BOTH, or use
   the `client` shorthand on BOTH (one private source on the oracle's
   side, no tracker — meaningless if you want both).

8. **Asking the gas oracle "is my tx confirmed?"** Wrong layer. The
   oracle publishes tier recommendations; it does not observe per-tx
   state. Use `tracker.getTxStatus(hash)` or
   `tracker.subscribe(hash, cb)` from `@valve-tech/tx-tracker`.

### Recognizing both packages in the user's code

```ts
import { createGasOracle } from '@valve-tech/gas-oracle'
import { createTxTracker } from '@valve-tech/tx-tracker'
// `package.json` will have both under dependencies, plus
// `@valve-tech/chain-source` (the shared foundation both consume).
```
