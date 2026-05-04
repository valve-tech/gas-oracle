/**
 * 03 — Block-position queries.
 *
 * `tipForBlockPosition(samples, query)` answers "what tip do I need to
 * pay to land at <position> given this sample distribution?" The query
 * is a discriminated union with five mutually-exclusive shapes —
 * TypeScript narrows the rest of the fields per `kind`.
 *
 * Pure function — pass any TipSample[] you have. Typically this is
 * `state.ring.flatMap(b => b.tips)` for ring-only, or the union with
 * `mempoolToSamples(...)` for ring+mempool.
 *
 * Run with: yarn tsx examples/03-block-position.ts
 */

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { createGasOracle, tipForBlockPosition } from '../src/index.js'

const client = createPublicClient({ chain: mainnet, transport: http() })

const oracle = createGasOracle({
  client,
  chainId: 1,
  keepMempoolSnapshot: true,
})

oracle.start()
const state = await oracle.pollOnce()

if (!state) {
  console.error('Oracle could not produce state.')
  process.exit(1)
}

// Use the ring samples as our distribution. To include mempool, union
// these with `mempoolToSamples(txPool, baseFee)` from the same package.
const samples = state.ring.flatMap((b) => b.tips)

// rank — "tip needed to land in the top 50"
const rank50 = tipForBlockPosition(samples, { kind: 'rank', rank: 50 })
console.log(`top-50    requiredTip=${rank50.requiredTip} wei  rank=${rank50.rank}`)

// percentile — "tip needed to land at p10 (top 10%)"
const p10 = tipForBlockPosition(samples, { kind: 'percentile', percentile: 10 })
console.log(`p10       requiredTip=${p10.requiredTip} wei  rank=${p10.rank}`)

// gasFromTop — "tip needed to land within 1M gas of the leader"
const oneMGas = tipForBlockPosition(samples, {
  kind: 'gasFromTop',
  gas: 1_000_000n,
})
console.log(`<1M gas   requiredTip=${oneMGas.requiredTip} wei`)

// aheadOf — "tip needed to leapfrog this specific tx"
// (placeholder hash that won't match — illustrates the API shape)
const aheadOf = tipForBlockPosition(samples, {
  kind: 'aheadOf',
  tx: {
    hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  },
})
console.log(
  `aheadOf   requiredTip=${aheadOf.requiredTip} wei  pivot=${aheadOf.pivot ? 'found' : 'null'}`,
)

oracle.stop()
