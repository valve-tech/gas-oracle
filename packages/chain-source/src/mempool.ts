/**
 * Mempool normalization. The single transformation pass that takes a
 * `txpool_content` response into a canonical `NormalizedMempool` whose
 * outer keys (sender address, nonce) are predictable.
 *
 * Why normalize once at ingest, not on every lookup?
 *
 *   - Upstream clients are inconsistent about address case (geth /
 *     reth use EIP-55 mixed case, others lowercase, some checksum
 *     only some hex chars).
 *   - Nonce is also inconsistent — some clients hex-encode (`'0x5'`),
 *     some decimal-encode (`'5'`).
 *   - A consumer doing direct `pool.pending[address][nonce]` lookups
 *     would need a case-fold + format-fold fallback walk on every
 *     access. That's both slow and a class of latent bugs (forget
 *     the fallback, miss a hit).
 *
 * Normalize once at the source's ingest point, then every lookup is
 * an O(1) two-key access against keys whose form is known. The
 * `NormalizedMempool` type alias signals the invariant.
 */

import type { NormalizedMempool, RawTx, TxPoolContent } from './types.js'

const normalizeSubpool = (
  sub: Record<string, Record<string, RawTx>> | undefined,
): Record<string, Record<string, RawTx>> => {
  if (!sub) return {}
  const out: Record<string, Record<string, RawTx>> = {}
  for (const [address, byNonce] of Object.entries(sub)) {
    const normalizedByNonce: Record<string, RawTx> = {}
    for (const [nonce, tx] of Object.entries(byNonce)) {
      // BigInt() accepts both '5' and '0x5'; .toString() gives the
      // canonical decimal form. Idempotent on already-decimal keys.
      normalizedByNonce[BigInt(nonce).toString()] = tx
    }
    out[address.toLowerCase()] = normalizedByNonce
  }
  return out
}

/**
 * Run the upstream `txpool_content` payload through one normalization
 * pass: every sender address key is lowercased, every nonce key is
 * coerced to its canonical decimal form. The inner `RawTx` values
 * are passed through by reference unchanged — pool normalization is
 * for the OUTER keys only; downstream tx-field comparisons (hash,
 * from, nonce) do their own case-folding.
 *
 * Idempotent — re-normalizing a `NormalizedMempool` returns an
 * equivalent `NormalizedMempool`. Pass `null` / `undefined` to get
 * empty subpools back; this lets callers store the result without
 * `null`-checking on every lookup.
 */
export const normalizeMempool = (
  pool: TxPoolContent | null | undefined,
): NormalizedMempool => ({
  pending: normalizeSubpool(pool?.pending),
  queued: normalizeSubpool(pool?.queued),
})
