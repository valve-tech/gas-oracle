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
