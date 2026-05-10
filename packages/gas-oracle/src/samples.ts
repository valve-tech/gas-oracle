/**
 * Adapters from upstream RPC result shapes to the gas-oracle sample
 * model. Pure functions: take a typed RPC payload and emit either a
 * `BlockSample` (one block of state for the ring buffer) or an array
 * of `{ tip, gas }` mempool samples.
 *
 * Kept separate from `math.ts` (which stays numeric) and from
 * `transport.ts` (which stays I/O) so tests can fixture the RPC
 * shapes without touching either neighbor.
 */

import type {
  BlockResult,
  RawTx,
  TxPoolContent,
} from '@valve-tech/chain-source'

import { effectiveTip } from './math.js'
import type { BlockSample, TipSample } from './types.js'

/**
 * Decode the EIP-2718 type byte from its hex-string wire form.
 * Returns `undefined` for missing or malformed inputs so the
 * `priorityModel: 'eip1559'` filter under-counts rather than mis-buckets
 * a malformed tx into the priority lane. `Number()` correctly handles
 * the `0x`-prefixed forms most clients emit (`'0x'`, `'0x0'`, `'0x2'`).
 */
const decodeTxType = (raw: RawTx['type']): number | undefined => {
  if (raw === undefined) return undefined
  // Empty string and `'0x'` both coerce to 0 via Number — that's the
  // legacy/type-0 case and the right answer.
  const n = raw === '0x' || raw === '' ? 0 : Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Decimalize a hex-or-decimal nonce, when present. Returns undefined
 * for missing input so the field stays optional through to consumers.
 */
const decodeNonce = (raw: RawTx['nonce']): string | undefined => {
  if (raw === undefined) return undefined
  try {
    return BigInt(raw).toString()
  } catch {
    return undefined
  }
}

/**
 * Convert a full block (from `eth_getBlockByNumber(_, true)`) into a
 * `BlockSample`. Per-tx tips + gas are computed once at ingest and
 * never re-derived. Identifier fields (hash/from/nonce) ride along so
 * the block-position helpers can locate a specific tx in the
 * distribution. Txs missing the `gas` field are filtered out — we
 * can't gas-weight a sample without the weight.
 */
export const blockToSample = (block: BlockResult): BlockSample => {
  const baseFee = BigInt(block.baseFeePerGas)
  const tips: TipSample[] = []
  for (const tx of block.transactions) {
    if (tx.gas === undefined) continue
    tips.push({
      tip: effectiveTip(tx, baseFee),
      gas: BigInt(tx.gas),
      txType: decodeTxType(tx.type),
      hash: tx.hash,
      address: tx.from?.toLowerCase(),
      nonce: decodeNonce(tx.nonce),
    })
  }
  return {
    number: BigInt(block.number),
    hash: block.hash ?? '',
    parentHash: block.parentHash ?? '',
    baseFee,
    gasUsed: BigInt(block.gasUsed),
    tips,
  }
}

/**
 * Flatten the `pending` half of a `txpool_content` payload into the
 * sample shape. Queued txs are excluded (consistent with existing
 * behavior — they can't be mined at current nonce).
 *
 * The pool's outer key is the canonical sender address (lowercased
 * here, since the pool may not yet be normalized). Outer key is
 * preferred over `tx.from` because some upstream serializers omit
 * the per-tx `from` for mempool entries to save bytes.
 *
 * Txs missing `gas` are filtered out for the same reason as in
 * `blockToSample`: gas-weighting requires the weight.
 */
export const mempoolToSamples = (
  pool: TxPoolContent | null | undefined,
  currentBaseFee: bigint,
): TipSample[] => {
  if (!pool) return []
  const samples: TipSample[] = []
  for (const [address, byNonce] of Object.entries(pool.pending ?? {})) {
    const lowerAddr = address.toLowerCase()
    for (const [nonce, tx] of Object.entries(byNonce)) {
      if (tx.gas === undefined) continue
      samples.push({
        tip: effectiveTip(tx, currentBaseFee),
        gas: BigInt(tx.gas),
        txType: decodeTxType(tx.type),
        hash: tx.hash,
        address: lowerAddr,
        nonce: decodeNonce(nonce) ?? decodeNonce(tx.nonce),
      })
    }
  }
  return samples
}
