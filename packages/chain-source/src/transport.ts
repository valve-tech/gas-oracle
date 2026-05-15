/**
 * Low-level RPC fan-out for `@valve-tech/chain-source`. One thin
 * wrapper per JSON-RPC method the source needs:
 *
 *   - `eth_blockNumber`        — cheap head probe (block-gating).
 *   - `eth_getBlockByNumber`   — full block (header + txs).
 *   - `eth_feeHistory`         — base-fee history + percentile rewards.
 *   - `txpool_content`         — pending + queued mempool snapshot.
 *   - `eth_getTransactionReceipt` — inclusion-watch fallback.
 *   - `eth_getTransactionByHash`  — replacement detection (from, nonce).
 *
 * Each wrapper uses the same `safeRequest` posture: turn errors,
 * `null`, and `undefined` upstream responses into a `null` return —
 * never throw across this layer. The higher-level source module
 * decides what each `null` means (capability gated, transient
 * upstream failure, no such tx).
 *
 * Why not viem's typed methods? Two reasons:
 *
 *   1. `txpool_content` is non-standard, so we'd be reaching for
 *      `client.request` for it anyway. Doing every method through
 *      the same shape keeps call sites symmetric.
 *   2. Some fields of interest (`excessBlobGas`, `blobGasUsed`,
 *      `parentHash`) are surfaced inconsistently across viem versions
 *      in the typed `getBlock` shape. Going straight through
 *      `client.request` gives us the wire response untouched and the
 *      types we declare here describe exactly what we actually use.
 */

import type { PublicClient } from 'viem'

import type {
  BlockResult,
  FeeHistoryResult,
  RawTx,
  TransactionReceipt,
  TxPoolContent,
} from './types.js'

/** Canonical 32-byte zero hash. Used for the receipt-by-hash probe. */
export const zeroHash = `0x${'00'.repeat(32)}`

/**
 * Issue an arbitrary JSON-RPC method through the client. A single
 * failure (method-not-found, transport error, malformed response)
 * becomes `null` rather than a thrown exception — the caller decides
 * what each missing-data case means. This is the load-bearing
 * convention for capability-gated methods like `txpool_content`.
 */
export const safeRequest = async <T>(
  client: PublicClient,
  method: string,
  params: unknown[],
  onError?: (err: unknown) => void,
): Promise<T | null> => {
  try {
    // viem's `request` typing is parameterized over a known method
    // union; for non-standard methods (txpool_content, et al.) we
    // cast through `as never` to bypass the union narrowing.
    const result = (await client.request({ method, params } as never)) as T
    return result ?? null
  } catch (err) {
    if (onError) onError(err)
    return null
  }
}

const blockTagOf = (tag: 'latest' | bigint): string =>
  tag === 'latest' ? 'latest' : `0x${tag.toString(16)}`

/**
 * Fetch the latest head block number as a `bigint`. Used by the
 * source's block-gating optimization: when the head hasn't moved
 * since the previous tick, the expensive cycle (full block + fee
 * history + mempool) is skipped because no fee landscape change is
 * possible without a new block.
 *
 * Returns `null` if the upstream `eth_blockNumber` fails or returns
 * something that won't decode as a bigint.
 */
export const fetchHeadBlockNumber = async (
  client: PublicClient,
  onError?: (err: unknown) => void,
): Promise<bigint | null> => {
  const head = await safeRequest<string>(client, 'eth_blockNumber', [], onError)
  if (head === null) return null
  try {
    return BigInt(head)
  } catch {
    return null
  }
}

/**
 * Fetch a block (full transactions). `tag` may be `'latest'` or an
 * absolute block number as a `bigint`; the bigint is hex-encoded
 * before the RPC call. Returns the raw `BlockResult` (hex-encoded
 * numeric fields untouched) or `null` if the upstream failed.
 */
export const fetchBlock = async (
  client: PublicClient,
  tag: 'latest' | bigint,
  onError?: (err: unknown) => void,
): Promise<BlockResult | null> =>
  safeRequest<BlockResult>(
    client,
    'eth_getBlockByNumber',
    [blockTagOf(tag), true],
    onError,
  )

/**
 * Fetch a block by its hash (full transactions). Companion to
 * `fetchBlock(tag)` — the by-hash variant is needed when walking
 * a reorged-away branch (`parentHash` → `parentHash`) past blocks
 * that have been replaced at their canonical heights. `eth_get-
 * BlockByHash` returns the block at the hash even if it's no
 * longer canonical; the by-number lookup at the same height would
 * instead return whatever canonical block lives there now, which
 * is the wrong answer for ring backfill.
 *
 * Returns `null` on RPC failure (transport error, gated method,
 * not-found). `safeRequest`-shaped — never throws.
 */
export const fetchBlockByHash = async (
  client: PublicClient,
  hash: string,
  onError?: (err: unknown) => void,
): Promise<BlockResult | null> =>
  safeRequest<BlockResult>(
    client,
    'eth_getBlockByHash',
    [hash, true],
    onError,
  )

/**
 * Fetch fee history. `blockCount` is hex-encoded per the spec; the
 * latest block is the implicit upper bound. `percentiles` is passed
 * through unchanged (RPC accepts a JSON number array).
 */
export const fetchFeeHistory = async (
  client: PublicClient,
  blockCount: number,
  percentiles: number[],
  onError?: (err: unknown) => void,
): Promise<FeeHistoryResult | null> =>
  safeRequest<FeeHistoryResult>(
    client,
    'eth_feeHistory',
    [`0x${blockCount.toString(16)}`, 'latest', percentiles],
    onError,
  )

/**
 * Fetch a `txpool_content` snapshot. `null` is the expected return
 * when the provider gates the method (most public RPCs do). The
 * source surfaces this via `capabilities().txpoolContent === 'gated'`
 * so consumers can react.
 */
export const fetchTxPool = async (
  client: PublicClient,
  onError?: (err: unknown) => void,
): Promise<TxPoolContent | null> =>
  safeRequest<TxPoolContent>(client, 'txpool_content', [], onError)

/**
 * Fetch a transaction receipt by hash. `null` covers both "no such
 * tx" and "method not available." Distinguish the two via
 * `capabilities().receiptByHash`.
 */
export const fetchReceipt = async (
  client: PublicClient,
  hash: string,
  onError?: (err: unknown) => void,
): Promise<TransactionReceipt | null> =>
  safeRequest<TransactionReceipt>(
    client,
    'eth_getTransactionReceipt',
    [hash],
    onError,
  )

/**
 * Fetch a transaction by hash. Used by downstream tx-tracker for
 * replacement detection (looks up the (from, nonce) pair so the
 * tracker can detect a different hash with the same nonce mining).
 */
export const fetchTransaction = async (
  client: PublicClient,
  hash: string,
  onError?: (err: unknown) => void,
): Promise<RawTx | null> =>
  safeRequest<RawTx>(client, 'eth_getTransactionByHash', [hash], onError)

/**
 * Estimate the average block time (ms/block) by sampling `latest` and
 * `latest - lookback`. Returns null when either fetch fails, the
 * sampled blocks don't decode, or the computed interval is non-positive
 * (consumer is responsible for falling back to a static interval).
 *
 * Why this exists: the v0.15 source polled on a fixed `pollIntervalMs`,
 * which is wasteful on chains where the actual block time is known —
 * a tick that fires during the expected gap between blocks just hits
 * `eth_blockNumber` to learn nothing has changed. The v0.16 adaptive
 * scheduler uses this estimate to time the next tick around the
 * expected next-block moment, with backoff retries when the head
 * doesn't move on schedule.
 *
 * Implementation notes:
 *
 * - Both blocks fetched with `fullTransactions: false` (false because
 *   we only need `number` + `timestamp`; the full tx list would be
 *   wasted bytes). The shape we deserialize keeps only those two
 *   fields rather than the full BlockResult.
 * - 256 is the default lookback. Larger samples smooth out short-term
 *   variance (mempool turmoil, validator outages) but stretch farther
 *   back where average block time may have actually changed. For
 *   chains with sub-block-second cadence (some L2s), the caller may
 *   want a larger lookback; for chains with very slow blocks
 *   (Bitcoin-style), smaller.
 * - The same `onError` sink the consumer wires for other RPC calls
 *   gets invoked here, tagged with the appropriate method name.
 */
export const estimateBlockTimeMs = async (
  client: PublicClient,
  lookback: number = 256,
  onError?: (method: string, err: unknown) => void,
): Promise<number | null> => {
  // Validate the caller's lookback up front — a zero or negative value
  // would divide-by-zero or invert the math below. Better to fail
  // cheaply here than mint Infinity / negative durations downstream.
  if (!Number.isInteger(lookback) || lookback <= 0) return null
  type ThinBlock = { number?: string; timestamp?: string }
  const sinkLatest = onError
    ? (err: unknown) => onError('eth_getBlockByNumber:latest', err)
    : undefined
  const latest = await safeRequest<ThinBlock>(
    client,
    'eth_getBlockByNumber',
    ['latest', false],
    sinkLatest,
  )
  if (!latest || !latest.number || !latest.timestamp) return null

  let latestNumber: bigint
  let latestTs: bigint
  try {
    latestNumber = BigInt(latest.number)
    latestTs = BigInt(latest.timestamp)
  } catch {
    return null
  }

  // The target block must exist. If lookback overshoots genesis,
  // clamp to a positive height; if that's still 0 we can't sample.
  const targetHeight = latestNumber - BigInt(lookback)
  if (targetHeight <= 0n) return null

  const sinkOld = onError
    ? (err: unknown) => onError('eth_getBlockByNumber:lookback', err)
    : undefined
  const old = await safeRequest<ThinBlock>(
    client,
    'eth_getBlockByNumber',
    [`0x${targetHeight.toString(16)}`, false],
    sinkOld,
  )
  if (!old || !old.number || !old.timestamp) return null

  let oldTs: bigint
  try {
    oldTs = BigInt(old.timestamp)
  } catch {
    return null
  }

  if (latestTs <= oldTs) return null

  // Both block timestamps are in seconds; convert to ms and divide by
  // the lookback span (always `lookback` blocks since we asked by
  // height — no gaps possible). Earlier guards ensure deltaSeconds > 0
  // and lookback > 0, so `ms` is always a finite positive number.
  const deltaSeconds = Number(latestTs - oldTs)
  return (deltaSeconds * 1000) / lookback
}
