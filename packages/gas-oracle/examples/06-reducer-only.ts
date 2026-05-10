/**
 * 06 — Reducer only: drive the oracle with no live RPC.
 *
 * `fetchOracleInputs` (I/O) and `reducePollInputs` (pure) are exported
 * as separate top-level entries from the package. That split is what
 * makes the package usable in places where you either don't have a
 * live `PublicClient` or don't want one:
 *
 *   - serverless / edge handlers reading inputs from a queue or KV
 *   - backtest harnesses replaying historical RPC payloads
 *   - tests asserting state shape from fixture data
 *
 * This example feeds two synthetic poll cycles into `reducePollInputs`
 * and prints the resulting tiers, never opening a network connection.
 *
 * Run with: yarn tsx examples/06-reducer-only.ts
 */

import type {
  BlockResult,
  FeeHistoryResult,
  TxPoolContent,
} from '@valve-tech/chain-source'

import { reducePollInputs } from '../src/index.js'
import type { OraclePollInputs } from '../src/transport.js'
import type { GasOracleState } from '../src/types.js'

const toHex = (n: bigint): string => '0x' + n.toString(16)

// One block carrying two type-2 txs at different tips. Real callers
// load this from whatever they hydrate from — a snapshot store, a
// Kafka log, a historical archive — but the shape is `BlockResult`.
const buildBlock = (input: {
  number: bigint
  timestamp: bigint
  baseFee: bigint
}): BlockResult => ({
  number: toHex(input.number),
  hash: '0x' + input.number.toString(16).padStart(64, '0'),
  parentHash: '0x' + (input.number - 1n).toString(16).padStart(64, '0'),
  timestamp: toHex(input.timestamp),
  baseFeePerGas: toHex(input.baseFee),
  gasLimit: toHex(30_000_000n),
  gasUsed: toHex(15_000_000n),
  transactions: [
    {
      type: '0x2',
      gas: toHex(21_000n),
      maxFeePerGas: toHex(input.baseFee + 2_000_000_000n),
      maxPriorityFeePerGas: toHex(2_000_000_000n),
      hash: '0xaa',
      from: '0x0000000000000000000000000000000000000001',
      nonce: '0x1',
    },
    {
      type: '0x2',
      gas: toHex(50_000n),
      maxFeePerGas: toHex(input.baseFee + 5_000_000_000n),
      maxPriorityFeePerGas: toHex(5_000_000_000n),
      hash: '0xbb',
      from: '0x0000000000000000000000000000000000000002',
      nonce: '0x2',
    },
  ],
})

// Minimal feeHistory shape with a 5-block base-fee window so the
// trend detector has something other than 'stable' to work with.
const buildFeeHistory = (anchor: bigint): FeeHistoryResult => ({
  baseFeePerGas: [
    toHex(anchor - 4n),
    toHex(anchor - 3n),
    toHex(anchor - 2n),
    toHex(anchor - 1n),
    toHex(anchor),
  ],
  gasUsedRatio: [0.5, 0.5, 0.5, 0.5, 0.5],
  oldestBlock: '0x0',
})

// Two synthetic mempool entries — same address space as block txs so
// the example also exercises the mempool sample path.
const txPool: TxPoolContent = {
  pending: {
    '0x0000000000000000000000000000000000000001': {
      '3': {
        type: '0x2',
        gas: toHex(21_000n),
        maxFeePerGas: toHex(50_000_000_000n),
        maxPriorityFeePerGas: toHex(3_000_000_000n),
        hash: '0xcc',
      },
    },
  },
  queued: {},
}

// Cycle 1 — no prior state. The reducer initializes its rolling
// publish anchor from this snapshot.
const cycle1: OraclePollInputs = {
  block: buildBlock({
    number: 0x1234n,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    baseFee: 5_000_000_000n,
  }),
  feeHistory: buildFeeHistory(5_000_000_000n),
  txPool,
}

const state1: GasOracleState | null = reducePollInputs({
  inputs: cycle1,
  chainId: 1,
  prev: null,
  priorityModel: 'eip1559',
})

if (!state1) {
  console.error('Cycle 1 produced no state — block input was missing.')
  process.exit(1)
}

console.log(`Cycle 1: block=${state1.blockNumber} baseFee=${state1.baseFee} wei`)
for (const tier of ['slow', 'standard', 'fast', 'instant'] as const) {
  const t = state1.tiers[tier]
  console.log(`  ${tier.padEnd(8)}  maxPriorityFee=${t.maxPriorityFeePerGas} wei`)
}

// Cycle 2 — base fee falls. Pass `state1` through as `prev` so the
// downside-decay cap anchors against the previously-published tip
// rather than letting the published number free-fall to the new mempool
// median. This is exactly what the live oracle does between ticks.
const cycle2: OraclePollInputs = {
  block: buildBlock({
    number: 0x1235n,
    timestamp: BigInt(Math.floor(Date.now() / 1000) + 12),
    baseFee: 4_000_000_000n,
  }),
  feeHistory: buildFeeHistory(4_000_000_000n),
  txPool,
}

const state2 = reducePollInputs({
  inputs: cycle2,
  chainId: 1,
  prev: state1,
  priorityModel: 'eip1559',
})

if (!state2) {
  console.error('Cycle 2 produced no state.')
  process.exit(1)
}

console.log(`\nCycle 2: block=${state2.blockNumber} trend=${state2.baseFeeTrend}`)
for (const tier of ['slow', 'standard', 'fast', 'instant'] as const) {
  const t = state2.tiers[tier]
  console.log(`  ${tier.padEnd(8)}  maxPriorityFee=${t.maxPriorityFeePerGas} wei`)
}
