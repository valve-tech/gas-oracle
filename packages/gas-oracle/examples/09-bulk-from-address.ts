/**
 * 09 — Bulk subscription by sender address (indexer-style).
 *
 * `tracker.trackFromAddress(addr)` watches every tx the source
 * observes whose `from === addr` (case-insensitive — the matcher
 * lowercases targets at compile time). Per spec §11, a bulk
 * subscription auto-tracks each matched hash by default, so the
 * consumer can iterate the raw `matched` stream AND/OR subscribe
 * to per-hash event streams on the matched hashes.
 *
 * Indexer pattern: drive the bulk subscription with `durable: true`
 * so the tracker's store persists matched hashes across process
 * restarts. The default in-memory store survives only the current
 * process — for a real indexer plug a Redis / SQLite / disk-backed
 * `TxTrackerStore` implementation in via the `store` option on
 * `createTxTracker`.
 *
 * Run with: yarn tsx examples/09-bulk-from-address.ts
 */

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

import { createChainSource } from '@valve-tech/chain-source'
import { createTxTracker } from '@valve-tech/tx-tracker'

const client = createPublicClient({
  chain: mainnet,
  transport: http(),
})

const source = createChainSource({ client })
const tracker = createTxTracker({ source, chainId: 1 })

source.start()
tracker.start()

// Replace with a real address you want to follow — a treasury, a
// known relayer, a contract factory, etc. The bulk match runs every
// source tick (mempool snapshot + new block), and each matched tx
// becomes its own auto-tracked per-hash subscription.
const treasuryAddress =
  '0x0000000000000000000000000000000000000000'

const sub = tracker.trackFromAddress(treasuryAddress, {
  durable: true,
  // autoTrackMatched: true is the default — set false here only if
  // you want the raw match stream without per-hash tracking.
})

// Stream A: the raw matched events — one per (tx, source-tick) hit.
;(async () => {
  for await (const match of sub.events()) {
    console.log(
      `match: ${match.hash} from=${match.tx.from} (${match.source})`,
    )
  }
})()

// Stream B: per-hash events on every auto-tracked hash. Indexers
// pipe this to their downstream sink (Postgres, Kafka, etc.).
sub.subscribe((event) => {
  if (event.kind === 'seen-in-block') {
    console.log(
      `included: ${event.hash} block ${event.blockNumber} idx ${event.transactionIndex}`,
    )
  }
})

// Stop the bulk subscription after a window. Already-auto-tracked
// per-hash subscriptions continue under their own retention rules
// per spec §11.1 — stopping the bulk sub does NOT stop the per-hash
// subs it spawned.
setTimeout(() => {
  sub.stop()
  tracker.stop()
  source.stop()
}, 60_000)
