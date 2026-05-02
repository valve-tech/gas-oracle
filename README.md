# @valve-tech/gas-oracle

[![npm version](https://img.shields.io/npm/v/@valve-tech/gas-oracle)](https://www.npmjs.com/package/@valve-tech/gas-oracle)
[![Types Included](https://img.shields.io/npm/types/@valve-tech/gas-oracle)](https://www.npmjs.com/package/@valve-tech/gas-oracle)
[![SLSA Provenance](https://img.shields.io/badge/SLSA-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Multi-tier gas-fee oracle for EVM chains. Pass it a viem `PublicClient`
and it polls block + mempool data, computes `slow` / `standard` /
`fast` / `instant` tier recommendations, and serves them via an
in-memory cache. Includes a configurable downside-decay cap, a chain-
aware EIP-1559 priority cutoff, and EIP-4844 blob-fee handling.

Zero runtime dependencies. `viem` is the only peer dependency.

> **AI agents:** see [`AGENTS.md`](AGENTS.md) for a terse, AI-first reference,
> and [`skills/`](skills/) for Claude Code / Cursor skill files shipped in
> `node_modules/`.

## Install

```bash
yarn add @valve-tech/gas-oracle viem
```

## Quick start

```ts
import { createPublicClient, http, parseEther } from 'viem'
import { mainnet } from 'viem/chains'
import { createGasOracle } from '@valve-tech/gas-oracle'

const client = createPublicClient({ chain: mainnet, transport: http() })

const oracle = createGasOracle({
  client,
  chainId: 1,
  priorityFeeDecayCap: parseEther('0.125'), // 12.5%/block, EIP-1559 parity
  priorityModel: 'eip1559',                 // 'flat' for chains whose validators charge tips instead of burning them
})

oracle.subscribe((state) => {
  console.log('fast tier:', state.tiers.fast.maxPriorityFeePerGas)
})

oracle.start()

// Sub-millisecond read, no RPC roundtrip:
const tier = oracle.getState()?.tiers.standard
```

## Tier semantics

Each tier is one `TierRecommendation`:

```ts
interface TierRecommendation {
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint        // bufferedBaseFee + maxPriorityFeePerGas
  gasPrice: bigint            // baseFee + maxPriorityFeePerGas (legacy)
  maxFeePerBlobGas: bigint | null   // null on chains without EIP-4844
}
```

Tier mapping in the gas-weighted percentile distribution:

| Tier       | Percentile | Use for                                                      |
|------------|------------|--------------------------------------------------------------|
| `slow`     | p10        | Background / non-time-sensitive ops (claims, batched writes) |
| `standard` | p50        | Default for most user actions                                |
| `fast`     | p75        | Trades, swaps, anything competing with bots                  |
| `instant`  | p90        | Auctions, MEV-adjacent, opt-out-of-mempool deals             |

`slow` always reads from the full distribution (legacy + 1559) so legacy
senders can still find the lane they actually live in. Under
`priorityModel: 'eip1559'`, the paying-lane tiers (`standard`/`fast`/
`instant`) draw from type-2+ samples only — legacy spam can't suppress
them.

## Configuration

### `priorityFeeDecayCap`

How fast the published priority-fee tip is allowed to drop, expressed
wad (1e18 = 100%). Use `parseEther` for the human-readable form:

```ts
priorityFeeDecayCap: parseEther('0.125')   // 12.5%/block (EIP-1559 parity)
priorityFeeDecayCap: parseEther('0.05')    // 5%/block (smoother)
priorityFeeDecayCap: parseEther('0')       // no decay allowed (sticky floor)
priorityFeeDecayCap: parseEther('1')       // full collapse after one block
priorityFeeDecayCap: null                  // uncapped — track raw mempool
```

Validated at construction; out-of-range values throw. Upside is always
unclamped — real spikes propagate immediately.

### `priorityModel`

Where the chain's inclusion logic draws its priority cutoff in the
EIP-2718 type space:

- `'flat'` — every tx contributes equally to the gas-weighted
  distribution. Right for extractive validators (PulseChain, etc.)
  that ignore the type byte and just maximize fee per gas.
- `'eip1559'` — type 2+ samples drive the paying-lane tiers (standard/
  fast/instant); `slow` still draws from the full distribution. Right
  for chains that honor EIP-1559 ordering (Ethereum, most L2s).

Default `'flat'` (most conservative — never under-counts spam).

### `baseFeeLivenessBlocks`

How many blocks the published recommendation should survive in the
worst case. The buffered base fee underpinning `maxFeePerGas` becomes
`baseFee × (9/8)^N` (the EIP-1559 worst-case rise compounded over N
blocks), so a tx submitted with the snapshot still lands within `N`
blocks even if every intervening block is full.

```ts
baseFeeLivenessBlocks: 1   // default; one block of headroom (= old behavior)
baseFeeLivenessBlocks: 6   // ~1.5 minutes on Ethereum, ~2 minutes on PulseChain
baseFeeLivenessBlocks: 30  // generous cushion for slow human approvals
```

`falling` markets stay at 1× regardless of N (base fee will continue
to drop, headroom is wasted).

### `poll`

Producer-side toggles for upstream RPC calls:

```ts
poll: {
  feeHistory: true,   // eth_feeHistory; powers trend detection
  mempool: true,      // txpool_content; powers pending-pressure signal
}
```

Both default `true`. Setting either to `false` skips that RPC entirely
each cycle. Useful when the upstream provider gates the method (many
public RPCs return 405 on `txpool_content`) or when you want a
minimum-RPC-budget oracle. `eth_getBlockByNumber` is not toggleable.

### `keepMempoolSnapshot`

When `true`, the oracle retains the latest normalized mempool snapshot
and exposes it via `oracle.getMempoolSnapshot()`. The snapshot powers
`findInMempool` / `tipForBlockPosition({ kind: 'aheadOf' })`-style
lookups without a second RPC roundtrip. Memory cost is the size of one
`txpool_content` payload (5–15MB on busy ETH mainnet); leave off in
browser/mobile contexts. Default `false`.

## Mempool inspection

Two ways into the same data: pure helpers that take a normalized pool
(if you already have one) or oracle-backed actions (if you're already
running a `GasOracle`).

```ts
import {
  normalizeMempool,
  findByHash,
  findByAddressNonce,
  findInMempool,
} from '@valve-tech/gas-oracle'

// Normalize once at ingest — case-folds sender addresses and
// decimalizes nonce keys. All lookups expect the normalized form.
const pool = normalizeMempool(rawPoolFromTxpoolContent)

findByHash(pool, '0xdeadbeef…')                    // MempoolHit | null
findByAddressNonce(pool, '0xabc…', 5)              // MempoolHit | null
findInMempool(pool, { hash: '0xdeadbeef…' })       // discriminated form
findInMempool(pool, { address: '0xabc…', nonce: 5n })
```

`MempoolHit` carries the matched `tx`, the `bucket` (`'pending'` /
`'queued'`), and the canonicalized `address` + `nonce`.

## Block-position calculations

Compute the priority fee required to land at a target position in the
next block. The query is a discriminated union — each `kind` carries
exactly the fields it needs:

```ts
import { tipForBlockPosition } from '@valve-tech/gas-oracle'

// Absolute targeting
tipForBlockPosition(samples, { kind: 'rank', rank: 0 })          // top of block
tipForBlockPosition(samples, { kind: 'percentile', percentile: 5 }) // top 5%
tipForBlockPosition(samples, { kind: 'gasFromTop', gas: 1_000_000n }) // first 1M gas

// Relative targeting — beat or undercut a specific tx
tipForBlockPosition(samples, { kind: 'aheadOf', tx: { hash: '0xabc…' } })
tipForBlockPosition(samples, { kind: 'behind', tx: { address: '0xabc…', nonce: 5 } })
```

Returns `{ requiredTip, pivot, rank, gasFromTop }`. `requiredTip` is
the *minimum* tip — pivot.tip + 1 wei to outbid, or pivot.tip - 1 wei
to undercut. Add your own buffer for finality.

`samples` is typically the merged ring + mempool tip distribution —
the same union `computeTiers` reads. The viem-actions extension
exposes `client.tipForBlockPosition(query)` which assembles this
distribution for you from the oracle's state.

## viem integration

### Subpath: `@valve-tech/gas-oracle/viem-actions`

Extension surface for callers who want explicit access to tier shapes:

```ts
import { gasOracleActions } from '@valve-tech/gas-oracle/viem-actions'

const client = createPublicClient({ chain: mainnet, transport: http() })
  .extend(gasOracleActions({
    chainId: 1,
    priorityFeeDecayCap: parseEther('0.125'),
    priorityModel: 'eip1559',
  }))

await client.getGasTiers()                            // full snapshot
await client.getGasTier('fast')                       // one tier
await client.findTxInMempool({ hash: '0xabc…' })       // mempool lookup
await client.tipForBlockPosition({                    // position targeting
  kind: 'aheadOf',
  tx: { address: '0xabc…', nonce: 5 },
})
client.stopGasOracle()                                 // shutdown hook
```

### Subpath: `@valve-tech/gas-oracle/viem-transport`

Drop-in replacement for callers who want viem's existing API to *just
work better* — `useFeeData`, `walletClient.sendTransaction({...})`,
`estimateMaxPriorityFeePerGas`, and so on:

```ts
import { withGasOracle } from '@valve-tech/gas-oracle/viem-transport'

const transport = withGasOracle(http(rpcUrl), {
  chainId: 1,
  priorityFeeDecayCap: parseEther('0.125'),
  priorityModel: 'eip1559',
  intercept: {
    eth_gasFeeEstimate: true,           // additive (default on)
    eth_maxPriorityFeePerGas: 'fast',   // tier required for standard methods
  },
})

const client = createPublicClient({ chain: mainnet, transport })
```

Default `intercept` is `{ eth_gasFeeEstimate: true }` only — the
additive method that returns multi-tier shape. Standard methods
(`eth_gasPrice`, `eth_maxPriorityFeePerGas`) pass through to upstream
unless explicitly opted in **with a tier name**. Boolean opt-in on the
standard methods is intentionally not accepted: a default tier choice
would silently make the method's number depend on the package version,
and that's the silently-pick-a-percentile foot-gun this design is
careful to avoid.

`eth_feeHistory` is intentionally NOT in the intercept config —
synthesizing a historical-percentile array from oracle state is its
own design problem. Always passes through to upstream.

## Wire format

Every fee field is a `bigint`. Callers serializing across HTTP / Redis
/ WebSocket should hex-encode (`'0x' + n.toString(16)`) since JSON has
no native bigint and `JSON.stringify` will throw on raw bigint values.
The package keeps the canonical numeric form internally.

## License

MIT
