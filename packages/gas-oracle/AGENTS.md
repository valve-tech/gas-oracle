# AGENTS.md

Terse reference for AI agents (Claude Code, Cursor, Aider, etc.) integrating
`@valve-tech/gas-oracle`. The full README is for humans; this file is for
agents that need to ground their work in the package's actual surface
quickly.

## What this package does

Multi-tier gas-fee oracle for EVM chains. Polls block + mempool data,
computes `slow` / `standard` / `fast` / `instant` priority-fee
recommendations from a gas-weighted percentile distribution, and serves
them via an in-memory cache. Pass it a viem `PublicClient` and call
`oracle.getState()` for sub-millisecond reads.

Zero runtime dependencies. `viem ^2.0.0` is the only peer dependency.

## Public API

All exports live under `src/index.ts`. Default subpath is the canonical
oracle constructor; two named subpaths add viem integration.

```ts
import {
  createGasOracle,                   // primary constructor
  normalizeMempool,                  // pure helper
  findByHash, findByAddressNonce, findInMempool,  // mempool lookups
  tipForBlockPosition,               // discriminated block-position query
  // types
  type GasOracle,
  type CreateCreateGasOracleOptions,
  type GasGasOracleState,
  type TierRecommendation,
  type RawTx,
  type NormalizedMempool,
  type MempoolHit,
  type TxIdentifier,
  type BlockPositionQuery,
  type BlockPositionResult,
} from '@valve-tech/gas-oracle'
```

```ts
import { gasOracleActions } from '@valve-tech/gas-oracle/viem-actions'
// client.extend(gasOracleActions({ oracle }))
```

```ts
import { withGasOracle } from '@valve-tech/gas-oracle/viem-transport'
// withGasOracle(transport, { oracle, intercept: ['eth_gasFeeEstimate', ...] })
```

## Five types you must know

| Type | What it is |
|---|---|
| `CreateGasOracleOptions` | Constructor config. Required: `client`, `chainId`. Tuneables: `priorityFeeDecayCap`, `priorityModel`, `baseFeeLivenessBlocks`, `poll`, `keepMempoolSnapshot`, `ringWindowBlocks` (default 20n). |
| `GasOracleState` | What `oracle.getState()` returns. Holds the four-tier `tiers` map plus latest `baseFee`, `bufferedBaseFee`, mempool snapshot if enabled, the rolling block `ring`, and `lastReorg` (a `ReorgEvent \| null` describing the most recent ring trim, if any). |
| `TierRecommendation` | Per-tier struct: `{ maxPriorityFeePerGas, maxFeePerGas, gasPrice, maxFeePerBlobGas }`. All `bigint`. |
| `RawTx` | One mempool entry: `{ hash, from, to, nonce, value, maxPriorityFeePerGas, maxFeePerGas, gas, ... }`. Nullable fields for fields the chain may not expose. |
| `BlockPositionQuery` | Discriminated union — five mutually-exclusive shapes (see below). |

## The discriminated `BlockPositionQuery`

This is the API surface most likely to confuse — it's deliberately shaped
to make impossible queries unrepresentable. The `kind` field discriminates;
TypeScript will narrow the rest of the fields per branch.

```ts
type BlockPositionQuery =
  | { kind: 'rank'; rank: number }              // "tip to land in top N"
  | { kind: 'percentile'; percentile: number }  // "tip to land at p_X"
  | { kind: 'gasFromTop'; gas: bigint }         // "tip to land within G gas of leader"
  | { kind: 'aheadOf'; tx: TxIdentifier }       // "tip to leapfrog this tx"
  | { kind: 'behind'; tx: TxIdentifier }        // "tip to slip in just behind this tx"
```

`TxIdentifier` is `{ hash: string } | { address: string; nonce: number | bigint | string }`.
Both forms resolve against the latest mempool snapshot. The result is a
`BlockPositionResult`:

```ts
{
  requiredTip: bigint        // min tip-per-gas to land at the position
  pivot: TipSample | null    // the boundary sample, or null if out of range
  rank: number               // approximate 0-indexed rank from top
  gasFromTop: bigint         // approximate gas-from-top
}
```

## Configuration patterns by chain class

| Chain class | `priorityModel` | `baseFeeLivenessBlocks` | Notes |
|---|---|---|---|
| Ethereum mainnet, Base, Arbitrum, OP | `'eip1559'` | 6 | Validators burn base fee; tip is the only revenue. |
| PulseChain (mainnet + testnet) | `'flat'` | 6 | Validators charge tips instead of burning. Type-2 vs legacy distinction is meaningless on flat-fee chains. |
| Anything where you're unsure | `'flat'` | 6 | More conservative — never under-counts spam. |

`priorityFeeDecayCap`: default is `WAD / 8` (12.5%/block) which matches
EIP-1559's natural decay. Tighten to `WAD / 20` for very low-volatility
chains; loosen to `null` for chains where you want the published tip to
free-fall during quiet windows.

## Three integration shapes (pick one)

### 1. Direct (no viem wrapper)

```ts
const oracle = createGasOracle({ client, chainId: 1, priorityModel: 'eip1559' })
oracle.start()
const tier = oracle.getState()?.tiers.fast
```

### 2. viem-actions extension (recommended for app code)

```ts
const client = createPublicClient({ chain: mainnet, transport: http() })
  .extend(gasOracleActions({ chainId: 1, priorityModel: 'eip1559' }))

await client.getGasTiers()                       // GasOracleState
await client.getGasTier('fast')                  // TierRecommendation
await client.findTxInMempool({ hash: '0x...' })  // MempoolHit | null
await client.tipForBlockPosition({ kind: 'rank', rank: 50 })  // BlockPositionResult
client.stopGasOracle()                           // teardown
```

`gasOracleActions(options)` accepts the same options as `createGasOracle`
(minus `client`, which it gets from the viem client at extension time)
plus `lifecycle: 'eager' | 'lazy'`. Default `'eager'` starts polling on
extension; `'lazy'` defers until the first read.

### 3. viem-transport interception (drop-in for existing wagmi/viem code)

Default intercepts only `eth_gasFeeEstimate` (a Valve-specific multi-tier
RPC extension). Standard methods stay unintercepted unless opted in:

```ts
const transport = withGasOracle(http(), {
  chainId: 1,
  priorityModel: 'eip1559',
  intercept: {
    eth_gasFeeEstimate: true,        // default
    eth_gasPrice: 'standard',        // tier-required opt-in (no boolean default)
    eth_maxPriorityFeePerGas: 'fast',
  },
  lifecycle: 'lazy',                 // optional: defer poll until first intercept
})

// Tearing down (e.g. test/HMR): cast back to GasOracleTransport
;(transport as GasOracleTransport).stopGasOracle()
```

`eth_gasPrice` and `eth_maxPriorityFeePerGas` reject a boolean for the
intercept config — a tier choice is required so that the returned number
doesn't silently depend on the package version's default.

## Pitfalls (read these)

1. **Don't poll `oracle.getState()` in a tight loop.** It's O(1) but you're
   wasting CPU. Subscribe via `oracle.subscribe(callback)` for change
   notifications and read state inside the callback.

2. **One oracle per chain, ever.** Module-scope the oracle in your code so
   it's started once. Construct + `start()` per request and you're paying
   the warmup cost (~3-5 blocks of `eth_feeHistory` polling) every time.

3. **`oracle.start()` returns immediately but tiers aren't populated until
   the first poll completes.** `oracle.getState()` returns `null` during
   warmup. Either handle the null case at the call site, or call
   `await oracle.pollOnce()` once after `start()` to force a synchronous
   first poll.

   **v0.2.6+**: with `pauseWhenIdle: true` (now the default), the loop
   only fires when at least one subscriber is attached. Calling
   `oracle.start()` without subscribing means `getState()` returns
   `null` indefinitely. For ad-hoc reads, use the `sampleGasFees(...)`
   one-shot helper or pass `pauseWhenIdle: false` to restore the
   v0.2.5 always-poll-after-start behavior.

4. **Mempool snapshot is opt-in.** `keepMempoolSnapshot: false` (the
   default) means `findByHash`/`findInMempool`/`tipForBlockPosition` queries
   that take a `TxIdentifier` will throw. Set `true` if you need them.

5. **`findInMempool({ hash })` resolution costs a snapshot scan.** Cache
   the result if you're calling it repeatedly for the same hash —
   memoize or use a local map.

6. **PulseChain RPCs may not honor `txpool_content`.** If
   `oracle.getMempoolSnapshot()` returns `[]` consistently on a chain you
   know has live txs, the upstream RPC is rejecting the namespace.
   Verify with `curl -X POST <rpc> -H 'content-type: application/json' \
   --data '{"jsonrpc":"2.0","method":"txpool_content","params":[],"id":1}'`.

## Examples

Runnable scripts in `examples/`:

- `examples/01-basic-tiers.ts` — minimal `createGasOracle` + read tier
- `examples/02-mempool-snapshot.ts` — `keepMempoolSnapshot: true` + `findByHash`
- `examples/03-block-position.ts` — all five `tipForBlockPosition` query forms
- `examples/04-viem-actions.ts` — `client.extend(gasOracleActions(...))`
- `examples/05-viem-transport.ts` — `withGasOracle(transport, ...)` interception

Run any of them with `yarn tsx examples/01-basic-tiers.ts`.

## Skills (for AI agents)

`skills/` directory ships in the npm tarball. If you're an AI agent working
in a project that has installed this package, look in
`node_modules/@valve-tech/gas-oracle/skills/SKILL.md` for trigger conditions
and integration recipes that go deeper than this file.

## Verifying provenance

v0.2.3+ ships with SLSA provenance attestation:

```bash
npm view @valve-tech/gas-oracle@latest --json | jq .dist.attestations
npm audit signatures
```

The attestation links the published tarball to the GitHub Actions workflow
run that built it.
