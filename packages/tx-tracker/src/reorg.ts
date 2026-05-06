/**
 * Reorg detector — pure function over a recent-block ring.
 *
 * Per `docs/tx-tracker-spec.md` §12. The tracker keeps a small ring
 * of recently-observed canonical blocks (`BlockSample` below). On
 * every new tip, it walks the ring backward up to `reorgDepthBlocks`
 * (default 12) and asks: "is the canonical chain at any of those
 * heights different from what we recorded?" Any divergence becomes
 * a `vanished-from-block` candidate the tracker translates per
 * affected hash.
 *
 * Bounded depth (§12.2): a fixed 12-block window keeps the per-tick
 * work O(depth) regardless of how anomalous the upstream's history
 * is. Deeper reorgs are vanishingly rare on chains the package
 * targets; "find the common ancestor" would let one bad reorg make
 * a tick arbitrarily long.
 *
 * Pure: no I/O, no clock, no mutation of input. The tracker (in
 * `tracker.ts`) calls `appendBlock` to fold each newly-observed
 * canonical block into the ring, and `detectDivergences` against
 * a candidate canonical sequence (typically the source's most
 * recent emit + the on-demand block fetches the tracker did to
 * walk the chain backward).
 */

import type { Hash } from './events.js'

/**
 * One canonical-block coordinate the tracker has observed. The
 * tracker also records the `transactions` it saw on that block
 * (just the hashes, not the full RawTx) so it can quickly answer
 * "was tx X in block N?" without a fresh RPC.
 */
export interface BlockSample {
  number: bigint
  hash: Hash
  parentHash: Hash | null
  /** Tx hashes observed in this block at the time it was canonical. */
  transactionHashes: ReadonlySet<Hash>
}

/**
 * One divergence the detector found between the tracker's recorded
 * ring and a freshly-observed canonical chain. The tracker
 * translates this into per-hash `vanished-from-block` events for
 * every tracked hash whose `seen-in-block` referenced the previous
 * (now-stale) hash at this height.
 */
export interface BlockDivergence {
  blockNumber: bigint
  /** Hash the ring previously had at this height. */
  previousBlockHash: Hash
  /**
   * Hash the canonical chain has at this height now. The detector
   * only emits divergences for heights where the caller passed an
   * explicit canonical block, so this is always a real hash.
   */
  canonicalBlockHash: Hash
  /**
   * Tx hashes the ring saw on the previously-canonical block at
   * this height. Tracker uses this to scope which tracked hashes
   * are affected.
   */
  vanishedTransactionHashes: ReadonlySet<Hash>
}

/**
 * Append a freshly-observed canonical block into a bounded ring
 * keyed by block number, capped at `capacityBlocks` entries. Returns
 * a new ring (input is not mutated). The newest entry overwrites
 * any previous entry at the same number — a same-height reorg
 * replaces the stale block with the new canonical one.
 */
export const appendBlock = (
  ring: ReadonlyArray<BlockSample>,
  block: BlockSample,
  capacityBlocks: number,
): BlockSample[] => {
  const next = ring.filter((b) => b.number !== block.number)
  next.push(block)
  // Sort ascending by block number. The ring is small (~depth + a
  // few) so the cost is negligible. The same-number case is
  // unreachable here — `filter` above strips any prior entry at
  // `block.number` before we push, so the comparator never sees
  // equal keys; we return -1 in that arm only to satisfy bigint
  // sort's contract.
  /* c8 ignore next */
  next.sort((a, b) => (a.number < b.number ? -1 : 1))
  if (next.length > capacityBlocks) {
    next.splice(0, next.length - capacityBlocks)
  }
  return next
}

/**
 * Compare the tracker's `ring` (already-recorded canonical blocks)
 * against a freshly-observed `canonical` sequence (the tracker's
 * latest observation, plus any walk-back probes it performed). At
 * each height present in BOTH sides, if the hashes disagree the
 * detector returns a `BlockDivergence`.
 *
 * **Heights present only in `ring` are skipped** — the detector
 * treats "no canonical entry at this height" as "no information,"
 * not "vanished." A real same-height reorg requires the caller to
 * explicitly pass the new canonical block at that height; gapping
 * (e.g. caller skipped a height) is not a divergence signal.
 *
 * If you need to detect "ring's tip is no longer in canonical" you
 * pass the canonical chain that explicitly covers that height; with
 * a partial canonical sequence the detector stays conservative.
 *
 * `depthBlocks` caps how far back the comparison runs. The tracker
 * rarely cares about divergences beyond `reorgDepthBlocks` because
 * any tracked tx that deep would already be considered finalized by
 * downstream consumer policy.
 *
 * Returns an empty array on a clean chain extension (no divergences).
 */
export const detectDivergences = (input: {
  ring: ReadonlyArray<BlockSample>
  canonical: ReadonlyArray<BlockSample>
  depthBlocks: number
}): BlockDivergence[] => {
  const { ring, canonical, depthBlocks } = input
  if (ring.length === 0 || canonical.length === 0) return []

  // Index the canonical sequence by number for O(1) lookup. The
  // canonical sequence is small (≤ depthBlocks), so map construction
  // is cheap.
  const canonicalByNumber = new Map<bigint, BlockSample>()
  for (const block of canonical) {
    canonicalByNumber.set(block.number, block)
  }

  // The "tip" is the highest-numbered block in either side. Compare
  // back from there for `depthBlocks` heights (inclusive of the tip).
  // The early `length === 0` guard above means `ring[length-1]` and
  // `canonical[length-1]` are always defined here — the `!` reflects
  // that invariant rather than papering over a real nullable.
  const ringTip = ring[ring.length - 1]!.number
  const canonicalTip = canonical[canonical.length - 1]!.number
  const tip = ringTip > canonicalTip ? ringTip : canonicalTip
  const lowestComparedNumber = tip - BigInt(depthBlocks - 1)

  const divergences: BlockDivergence[] = []
  for (const sampled of ring) {
    if (sampled.number < lowestComparedNumber) continue
    const canonicalAtHeight = canonicalByNumber.get(sampled.number) ?? null
    if (!canonicalAtHeight) continue // no canonical info at this height
    if (canonicalAtHeight.hash === sampled.hash) continue // unchanged
    divergences.push({
      blockNumber: sampled.number,
      previousBlockHash: sampled.hash,
      canonicalBlockHash: canonicalAtHeight.hash,
      vanishedTransactionHashes: sampled.transactionHashes,
    })
  }

  // Sort ascending by number so the tracker emits vanished events
  // in chain order — easier on consumers piping to a single sink.
  // Divergences are unique by `blockNumber` (one entry per ring
  // height), so the comparator never sees equal keys; we return -1
  // in that arm only to satisfy the sort contract.
  /* c8 ignore next */
  divergences.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1))
  return divergences
}

/**
 * Default reorg-detection depth in blocks. Conservative — even
 * Ethereum's worst recent reorgs are under 7 blocks, and unbounded
 * walks would let a single anomalous reorg make the tick arbitrarily
 * long (§12.2). Tunable per-tracker via
 * `CreateTxTrackerOptions.reorgDepthBlocks`.
 */
export const defaultReorgDepthBlocks = 12
