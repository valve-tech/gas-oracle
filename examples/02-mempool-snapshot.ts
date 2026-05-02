/**
 * 02 — Mempool snapshot lookups.
 *
 * Enable mempool retention, poll once, and look up a tx by hash + by
 * sender address + nonce.
 *
 * Note: requires an RPC endpoint that exposes `txpool_content`. Most
 * public RPCs gate this; you'll need a node you operate (reth/erigon
 * exposed via Caddy, etc.). On gated endpoints, getMempoolSnapshot()
 * returns null.
 *
 * Run with: yarn tsx examples/02-mempool-snapshot.ts
 */

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import {
  createGasOracle,
  findByHash,
  findByAddressNonce,
} from '../src/index.js'

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.RPC_URL ?? undefined),
})

const oracle = createGasOracle({
  client,
  chainId: 1,
  keepMempoolSnapshot: true,
})

oracle.start()
await oracle.pollOnce()

const mempool = oracle.getMempoolSnapshot()
if (!mempool) {
  console.error('Mempool snapshot is null — upstream gates `txpool_content`.')
  process.exit(1)
}

console.log(
  `Mempool: ${mempool.pending.length} pending buckets, ${mempool.queued.length} queued buckets`,
)

// Find by hash — will be null if no such tx is in our snapshot.
const someHash = '0x0000000000000000000000000000000000000000000000000000000000000000'
const byHash = findByHash(mempool, someHash)
console.log(`findByHash(${someHash}) => ${byHash ? 'found' : 'null'}`)

// Find by sender + nonce — useful for tracking your own txs.
const someAddress = '0x0000000000000000000000000000000000000000'
const byAddrNonce = findByAddressNonce(mempool, someAddress, 0n)
console.log(
  `findByAddressNonce(${someAddress}, 0) => ${byAddrNonce ? 'found' : 'null'}`,
)

oracle.stop()
