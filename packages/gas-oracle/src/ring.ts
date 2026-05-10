/**
 * Pure ring-buffer maintenance for the gas oracle's block-history window.
 *
 * The ring holds the most recent N `BlockSample`s (oldest → newest).
 * Tier computation samples `state.ring[*].tips` so the percentile
 * distribution reflects multi-block inclusion rather than a single
 * block's accident. The ring also gives tx-tracker its reorg-walk
 * substrate (see `docs/tx-tracker-spec.md` §12.1) when the consumer
 * shares one source between both packages.
 *
 * **Stateful surface, pure module.** The reducer (`oracle.ts`'s
 * `reducePollInputs`) is the only caller that builds the ring across
 * cycles; this module just classifies one transition at a time and
 * returns a new ring shape. No I/O, no closures over time, no mutation
 * of the input ring.
 *
 * **Lifecycle the ring covers:**
 *
 * - **append** — new block continues the chain
 *   (`newBlock.parentHash === ring.tip.hash`). Push to tail; trim
 *   head if length would exceed `maxWindow`.
 * - **duplicate** — new block already present at the same height with
 *   the same hash. No-op; ring returned unchanged.
 * - **reorg** — new block conflicts with a block already in the ring,
 *   either by replacing an existing height (same number, different
 *   hash) or by extending from a height deeper than the current tip
 *   (parentHash matches a non-tip hash). Trim everything from the
 *   divergence point forward, append the new block, and emit a
 *   `ReorgEvent` describing the dropped tail.
 * - **restart** — no relationship with the prev ring (gap larger
 *   than what backfill caught, or completely unrelated chain). Drop
 *   the prev ring and return `[newBlock]`.
 *
 * The I/O-driven `bridgeGap` and `clearAndBackfill` behaviors live in
 * `oracle.ts`'s `handleBlock` — they pre-fetch missing blocks via the
 * `ChainSource` and feed them into this module as `historicalBlocks`
 * before the current block. This module never fetches anything.
 */

import type { BlockSample } from './types.js'

/**
 * Description of a tail-trim caused by reorg detection. Consumers
 * surface this on `GasOracleState.lastReorg` so observers know when
 * the oracle dropped historical samples (and at what depth) without
 * subscribing to a separate reorg channel.
 */
export interface ReorgEvent {
  /** Block number at which divergence was detected (= `newBlock.number`). */
  blockNumber: bigint
  /** Number of tail blocks trimmed from the previous ring. */
  depth: bigint
  /** Hash of the new canonical tip after the trim + append. */
  newTipHash: string
  /**
   * Hashes of the dropped tail blocks, ordered oldest → newest. Empty
   * tuple is impossible — `depth >= 1` for every reorg event.
   */
  droppedHashes: readonly string[]
}

/**
 * Result of classifying + applying one ring transition. Pure data.
 *
 * - `ring` — the new ring (always non-empty).
 * - `reorg` — populated iff a tail-trim happened. `null` for clean
 *   appends, restarts, and duplicates.
 * - `duplicate` — `true` when the new block was already in the ring at
 *   its height with the same hash. The reducer may short-circuit
 *   subscriber notification on this signal.
 */
export interface RingMutation {
  ring: BlockSample[]
  reorg: ReorgEvent | null
  duplicate: boolean
}

/**
 * Decide what `prevRing` becomes after observing `newBlock`. Pure: the
 * input ring is never mutated.
 *
 * `maxWindow` caps the ring length — the head (oldest entry) is dropped
 * to make room when an append would exceed it. Callers pass the
 * configured `ringWindowBlocks` (default 20n).
 *
 * Implementation walks the prev ring once from newest → oldest, looking
 * for the first block whose number ≤ `newBlock.number`:
 *
 * 1. If no such block exists (prev ring is empty, or every entry is
 *    newer than `newBlock`): restart with `[newBlock]`.
 * 2. If the matched block has the same number and same hash as
 *    `newBlock`: duplicate. Return `prevRing` unchanged.
 * 3. If the matched block has the same number but a different hash:
 *    reorg at this height. Trim from the matched index forward,
 *    append `newBlock`.
 * 4. If the matched block has a smaller number AND its hash matches
 *    `newBlock.parentHash`: append after this block (trimming any
 *    blocks tail-ward of the matched block — those are now-stale
 *    branches if the matched block isn't the tip).
 * 5. Otherwise: gap (parent isn't anywhere in the ring) → restart
 *    with `[newBlock]`. The I/O-driven backfill in `oracle.ts` is
 *    expected to have filled small gaps before reaching here, so
 *    arriving in case 5 means the gap exceeded the window or the
 *    backfill was disabled.
 */
export const incorporateBlock = (
  prevRing: readonly BlockSample[],
  newBlock: BlockSample,
  maxWindow: bigint,
): RingMutation => {
  if (prevRing.length === 0) {
    return { ring: [newBlock], reorg: null, duplicate: false }
  }

  // Scan from newest → oldest for first entry with number ≤ newBlock.number.
  let matchIndex = -1
  for (let i = prevRing.length - 1; i >= 0; i -= 1) {
    if (prevRing[i].number <= newBlock.number) {
      matchIndex = i
      break
    }
  }

  if (matchIndex === -1) {
    // Every entry is newer than newBlock — newBlock is older than the
    // entire window. Treat as restart so we don't propagate a strictly
    // older reading; this case shouldn't happen in normal operation
    // (the source emits monotonically) but the reducer asks for a
    // defensible answer either way.
    return { ring: [newBlock], reorg: null, duplicate: false }
  }

  const matched = prevRing[matchIndex]

  if (matched.number === newBlock.number) {
    if (matched.hash === newBlock.hash) {
      return { ring: prevRing.slice(), reorg: null, duplicate: true }
    }
    // Same height, different hash → reorg replacing matched (and any
    // blocks tail-ward of it, though by construction matchIndex is the
    // newest index ≤ newBlock.number, so there are no tail-ward
    // entries with smaller-or-equal numbers; entries above matchIndex
    // have strictly larger numbers and are also wrong).
    const droppedHashes = prevRing.slice(matchIndex).map((b) => b.hash)
    const trimmed = prevRing.slice(0, matchIndex)
    return {
      ring: capTail([...trimmed, newBlock], maxWindow),
      reorg: {
        blockNumber: newBlock.number,
        depth: BigInt(droppedHashes.length),
        newTipHash: newBlock.hash,
        droppedHashes,
      },
      duplicate: false,
    }
  }

  // matched.number < newBlock.number — newBlock extends the chain
  // from somewhere in the ring (or arrived with a gap).
  if (matched.hash !== newBlock.parentHash) {
    // Parent isn't where we thought it was. Either a gap (and the
    // canonical chain at newBlock.parentHash isn't in our ring), or a
    // deeper reorg the I/O layer didn't catch. Conservative: restart.
    return { ring: [newBlock], reorg: null, duplicate: false }
  }

  // Append after matched. If matched isn't the tip, the entries above
  // matchIndex were on a now-stale branch — drop them and emit a reorg
  // for the dropped tail. (matched.parentHash by construction was OK
  // earlier, but children we recorded above it have been superseded.)
  if (matchIndex < prevRing.length - 1) {
    const droppedHashes = prevRing.slice(matchIndex + 1).map((b) => b.hash)
    const kept = prevRing.slice(0, matchIndex + 1)
    return {
      ring: capTail([...kept, newBlock], maxWindow),
      reorg: {
        blockNumber: newBlock.number,
        depth: BigInt(droppedHashes.length),
        newTipHash: newBlock.hash,
        droppedHashes,
      },
      duplicate: false,
    }
  }

  // Clean append at the tip.
  return {
    ring: capTail([...prevRing, newBlock], maxWindow),
    reorg: null,
    duplicate: false,
  }
}

/**
 * Trim the head (oldest entries) until length ≤ maxWindow. Internal
 * helper; exported only for testing if needed (currently colocated
 * tests use `incorporateBlock` end-to-end).
 *
 * `maxWindow` ≤ 0n is treated as "no cap" so callers can disable the
 * window by passing 0n; that's an unusual configuration but keeps the
 * pure helper from throwing on bad input.
 */
const capTail = (
  ring: BlockSample[],
  maxWindow: bigint,
): BlockSample[] => {
  if (maxWindow <= 0n) return ring
  const max = Number(maxWindow)
  if (ring.length <= max) return ring
  return ring.slice(ring.length - max)
}
