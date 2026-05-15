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

## Overriding RPC dispatch

`createChainSource` does not wrap or replace your viem client — it
calls `client.request(...)` (and the higher-level viem methods built
on it) directly. **All RPC dispatch goes through your viem
`PublicClient`**, so the override seam is the viem `Transport` you
construct, not a chain-source-level option.

Common things consumers want here, and how to do them via viem:

```ts
import { createPublicClient, http, webSocket, fallback } from 'viem'

// 1. Log every RPC request/response.
const client = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl, {
    onFetchRequest: (req) => logger.debug('rpc request', { url: req.url }),
    onFetchResponse: (res) => logger.debug('rpc response', { status: res.status }),
  }),
})

// 2. Retry + timeout policy at the transport layer.
const client = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl, {
    retryCount: 3,
    retryDelay: 250, // ms
    timeout: 8_000,
  }),
})

// 3. Multi-RPC fan-out (try primary, fall back to backups).
const client = createPublicClient({
  chain: mainnet,
  transport: fallback([
    http(primaryUrl),
    http(backupUrl1),
    http(backupUrl2),
  ]),
})

// 4. Custom auth headers / cookies.
const client = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl, {
    fetchOptions: {
      headers: { authorization: `Bearer ${token}` },
    },
  }),
})

// 5. Mixed WS + HTTP (WS preferred, HTTP fallback). chain-source
//    auto-detects WS capability and opens a `newHeads` subscription
//    when available; `fallback` keeps the source running on HTTP if
//    the WS connection drops.
const client = createPublicClient({
  chain: mainnet,
  transport: fallback([
    webSocket(wsUrl),
    http(httpUrl),
  ]),
})
```

The chain-source surface above this (block subscription, mempool
snapshot, on-demand RPCs) is consistent regardless of which transport
you choose — the source picks WS-vs-HTTP behavior based on the
capability probe (`source.capabilities()`), not on what kind of
transport you constructed.

For toolkit-level events that don't correspond to individual RPC calls
(capability probe outcomes, adaptive scheduler decisions, subscription
lifecycle), pass a `logger` to `createChainSource` directly — see the
"Logger" section below.

## Logger

Optional `logger` callback for observability above the RPC layer:

```ts
const source = createChainSource({
  client,
  logger: (level, message, meta) => {
    console.log(`[chain-source ${level}]`, message, meta)
  },
})
```

Signature: `(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void`.

The toolkit calls this at narrowly-chosen decision points — capability
probe completion, block-time estimation, adaptive scheduler intervals,
WS subscription open/close, head-probe gate skips. RPC-call-level
logging belongs on your viem transport (see above); the chain-source
logger covers the "what is the source deciding right now" question.

## Adaptive polling

When push subscriptions aren't available (RPC doesn't expose
`eth_subscribe('newHeads')`), the source falls back to a poll loop.
Since v0.16 this loop is adaptive: at construction the source samples
`latest` + `latest - 256` to estimate the chain's block time, then
schedules each subsequent poll around the expected next-block moment.
If the head doesn't move on schedule, exponential backoff kicks in
(2s → 4s → 8s → … capped at 30s) until a new block lands, then resets.

Tune via `adaptivePolling`:

```ts
createChainSource({
  client,
  adaptivePolling: {
    estimationLookbackBlocks: 512,  // larger sample, smoother estimate
    retryInitialMs: 1_000,           // tighter initial retry
    retryMaxMs: 15_000,              // shorter cap
  },
})
```

Set `adaptivePolling: { enabled: false }` to revert to the v0.15
dumb-interval behavior (one tick per `pollIntervalMs` regardless of
chain state).

## License

MIT
