# @valve-tech/chain-source

> **Status: stub (v0.0.1).** This package is a name reservation. The
> implementation lands in v0.1.0. See
> [`docs/tx-tracker-spec.md`](https://github.com/valve-tech/evm-toolkit/blob/main/docs/tx-tracker-spec.md)
> §3 for the design contract.

Canonical EVM chain-observation primitive. Provides a unified push-or-poll
source for new blocks, mempool snapshots, on-demand receipt and tx
lookups, and explicit capability disclosure (HTTP / WS / per-method
gating). Designed to be consumed by multiple downstream views of chain
state — `@valve-tech/gas-oracle` and `@valve-tech/tx-tracker` are the
first two.

```ts
// v0.1.0+ shape (not yet implemented):
import { createChainSource } from '@valve-tech/chain-source'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

const client = createPublicClient({ chain: mainnet, transport: http() })
const source = createChainSource({ client })
source.start()

source.subscribeBlocks((block) => { /* ... */ })
source.subscribeMempool((snapshot) => { /* ... */ })
const receipt = await source.getReceipt('0xabc...')
```

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

## License

MIT
