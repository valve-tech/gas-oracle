# @valve-tech/chain-source

Canonical EVM chain-observation primitive. Provides a unified push-or-poll
source for new blocks, mempool snapshots, on-demand receipt and tx
lookups, and explicit capability disclosure (HTTP / WS / per-method
gating). Designed to be consumed by multiple downstream views of chain
state — `@valve-tech/gas-oracle` and `@valve-tech/tx-tracker` are the
first two.

See [`docs/tx-tracker-spec.md`](https://github.com/valve-tech/evm-toolkit/blob/main/docs/tx-tracker-spec.md)
§3 for the full design contract.

## Why this exists

Both gas-oracle and tx-tracker need the same upstream signals — new
blocks, mempool snapshots, capability probing. Re-implementing the
poll loop in each would mean double-polling for consumers who use
both. Sharing a `ChainSource` instance between them gives one upstream
RPC stream feeding multiple derived views.

## Install

```bash
yarn add @valve-tech/chain-source viem
```

## Quick start

```ts
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { createChainSource } from '@valve-tech/chain-source'

const client = createPublicClient({ chain: mainnet, transport: http() })
const source = createChainSource({ client })

source.subscribeBlocks((block) => {
  console.log('new block', block.number)
})

source.subscribeMempool((snapshot) => {
  console.log('pending senders', Object.keys(snapshot.pending).length)
})

source.start()

// On-demand RPCs (don't go through the poll cycle):
const receipt = await source.getReceipt('0xabc...')
const tx      = await source.getTransaction('0xabc...')

// Stop when done — preserves the subscriber registry across restarts.
source.stop()
```

## API surface

```ts
interface ChainSource {
  start(): void
  stop(): void
  pollOnce(): Promise<void>
  ready(): Promise<void>

  subscribeBlocks(cb: (block: BlockResult) => void): () => void
  subscribeMempool(cb: (snapshot: NormalizedMempool) => void): () => void

  getBlock(tag: 'latest' | bigint): Promise<BlockResult | null>
  getFeeHistory(blockCount: number, percentiles: number[]): Promise<FeeHistoryResult | null>
  getMempoolSnapshot(): Promise<NormalizedMempool | null>
  getReceipt(hash: string): Promise<TransactionReceipt | null>
  getTransaction(hash: string): Promise<RawTx | null>

  capabilities(): Capabilities
}
```

The capability probe runs eagerly at construction. `capabilities()`
returns a conservative default (everything `unavailable` / `gated`)
for the brief window before the probe lands; `await source.ready()`
guarantees the real values are cached.

## Multi-subscriber semantics

`subscribeBlocks` and `subscribeMempool` are first-class
multi-subscriber streams. One upstream RPC poll cycle, regardless of
how many derived views attach:

```ts
const source  = createChainSource({ client })
const oracle  = createGasOracle({ source, chainId: 1 })   // v0.3.x+ shape
const tracker = createTxTracker({ source, chainId: 1 })   // v0.3.x+ shape

source.start()
oracle.start()
tracker.start()
// ↑ one shared poll cycle, two derived views, no double-polling.
```

Stopping a derived view does not stop the source — the consumer that
constructed the source is the one who calls `source.stop()`.

## License

MIT
