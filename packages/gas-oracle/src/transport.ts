/**
 * viem-native RPC transport. The oracle needs three calls per cycle:
 *
 *   1. eth_feeHistory(20, 'latest', [10, 25, 50, 75, 90])
 *      — base-fee history + percentile rewards, for trend detection
 *      and as a fallback when a block has zero txs of our own to
 *      percentile.
 *   2. eth_getBlockByNumber('latest', true)
 *      — full block (header + all txs) so we can compute the same
 *      effectiveTip miners themselves maximize.
 *   3. txpool_content
 *      — pending + queued txs by sender. Best-effort: many public
 *      RPC providers gate this method (returns 405/method-not-found),
 *      and a missing mempool just degrades the oracle to block-only
 *      signal — it does NOT fail the cycle.
 *
 * Why not viem's getBlock/getFeeHistory directly? `txpool_content` is
 * a non-standard RPC, so we'd reach for `client.request` for that one
 * anyway. Doing all three through `client.request` keeps the call shapes
 * symmetric and avoids viem's type narrowing where we want raw fields
 * (excessBlobGas, blobGasUsed) that viem currently doesn't surface in
 * its decoded Block type uniformly across versions.
 */

import type {
  BlockResult,
  FeeHistoryResult,
  PollOptions,
  TxPoolContent,
} from '@valve-tech/chain-source'
import type { PublicClient } from 'viem'

/**
 * Combined upstream payload one oracle poll cycle consumes. Each field is
 * `null` when its underlying RPC failed or was disabled by `PollOptions`;
 * `reducePollInputs` handles every shape independently.
 *
 * The wire-shape members (`FeeHistoryResult`, `BlockResult`, `TxPoolContent`)
 * are owned by `@valve-tech/chain-source`; this composite shape stays here
 * because it's gas-oracle's call shape, not chain-source's.
 */
export interface OraclePollInputs {
  feeHistory: FeeHistoryResult | null
  block: BlockResult | null
  txPool: TxPoolContent | null
}

/**
 * Issue an arbitrary JSON-RPC method through the client. Wraps
 * `client.request` so a single failure (method-not-found, transport
 * error, malformed response) becomes `null` rather than a thrown
 * exception — the caller decides how to interpret missing data. This
 * matches the original oracle's behavior where a missing `txpool_content`
 * gracefully falls through to block-only signal.
 */
const safeRequest = async <T>(
  client: PublicClient,
  method: string,
  params: unknown[],
  onError?: (err: unknown) => void,
): Promise<T | null> => {
  try {
    // viem's request typing is parameterized over a known method union;
    // for non-standard methods (txpool_content) we cast through unknown.
    const result = (await client.request({ method, params } as never)) as T
    return result ?? null
  } catch (err) {
    if (onError) onError(err)
    return null
  }
}

/**
 * Cheap head-block probe used by block-gated polling. Returns the
 * latest block number as a `bigint`, or `null` if the RPC failed.
 * Cost: a single `eth_blockNumber` call (no full block payload, no
 * tx list, no receipts). Lets the oracle skip the expensive
 * `fetchOracleInputs` cycle when nothing has moved since last tick.
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
 * One poll cycle's RPC fan-out. Returns whatever could be fetched —
 * `null` for any sub-call that failed OR was disabled by `poll`. The
 * caller (`oracle.ts`) handles the case where `block` is null (cycle
 * aborts) and where `feeHistory`/`txPool` is null (those signals are
 * dropped, see reducePollInputs).
 *
 * `poll.feeHistory` and `poll.mempool` default to `true`. When `false`,
 * the corresponding RPC is skipped entirely (not even attempted) — this
 * is for callers who know upstream gates the method or who want to
 * minimize their RPC budget. `eth_getBlockByNumber` is non-toggleable.
 */
export const fetchOracleInputs = async (
  client: PublicClient,
  options: {
    onError?: (method: string, err: unknown) => void
    poll?: PollOptions
  } = {},
): Promise<OraclePollInputs> => {
  const onErr = (method: string) =>
    options.onError ? (err: unknown) => options.onError!(method, err) : undefined

  const fetchFeeHistory = options.poll?.feeHistory !== false
  const fetchMempool = options.poll?.mempool !== false

  const [feeHistory, block, txPool] = await Promise.all([
    fetchFeeHistory
      ? safeRequest<FeeHistoryResult>(
          client,
          'eth_feeHistory',
          ['0x14', 'latest', [10, 25, 50, 75, 90]],
          onErr('eth_feeHistory'),
        )
      : Promise.resolve(null),
    safeRequest<BlockResult>(
      client,
      'eth_getBlockByNumber',
      ['latest', true],
      onErr('eth_getBlockByNumber'),
    ),
    fetchMempool
      ? safeRequest<TxPoolContent>(
          client,
          'txpool_content',
          [],
          onErr('txpool_content'),
        )
      : Promise.resolve(null),
  ])

  return { feeHistory, block, txPool }
}
