/**
 * Pure mempool-inspection helpers.
 *
 * `txpool_content` returns a two-level map: sender → nonce → RawTx,
 * split into `pending` (next-in-line for inclusion) and `queued` (gap
 * txs that can't mine yet). These helpers find a specific tx in either
 * sub-pool.
 *
 * **Normalize once.** Upstream clients serialize sender addresses
 * inconsistently — geth/reth use EIP-55 checksum, others lowercase,
 * some checksum a few hex chars and not others. Doing the case-fold
 * (and the hex/decimal nonce coercion) on every lookup wastes work
 * and invites case-mismatch bugs. Instead, callers run
 * `normalizeMempool(pool)` ONCE at ingest, then pass the normalized
 * form to every subsequent lookup. Lookups then become direct O(1)
 * map accesses with no string-case fallback walks.
 *
 * The `NormalizedMempool` type signals that contract structurally —
 * functionally identical to `TxPoolContent`, but the type alias names
 * the invariant.
 */

import type { TxPoolContent } from './transport.js'
import type { RawTx } from './types.js'

/**
 * `TxPoolContent` after a single normalization pass — every sender
 * address key is lowercase ASCII, every nonce key is a decimal string.
 * All lookup helpers expect this form; pass raw `TxPoolContent` through
 * `normalizeMempool` first.
 */
export type NormalizedMempool = TxPoolContent

/**
 * Discriminated identifier for a single tx — either by its hash, or by
 * sender + nonce. Re-used across mempool lookups (`findInMempool`) and
 * block-position queries (`tipForBlockPosition`) so callers think in
 * one consistent shape.
 */
export type TxIdentifier =
  | { hash: string }
  | { address: string; nonce: number | bigint | string }

/** Which sub-pool a hit was found in. */
export type MempoolBucket = 'pending' | 'queued'

export interface MempoolHit {
  /** The tx as returned by `txpool_content`. */
  tx: RawTx
  /** Which sub-pool the tx was found in. */
  bucket: MempoolBucket
  /** Sender address, lowercased. */
  address: string
  /** Tx nonce as a decimal string. */
  nonce: string
}

const normalizeSubpool = (
  sub: Record<string, Record<string, RawTx>> | undefined,
): Record<string, Record<string, RawTx>> => {
  if (!sub) return {}
  const out: Record<string, Record<string, RawTx>> = {}
  for (const [address, byNonce] of Object.entries(sub)) {
    const normalizedByNonce: Record<string, RawTx> = {}
    for (const [nonce, tx] of Object.entries(byNonce)) {
      normalizedByNonce[BigInt(nonce).toString()] = tx
    }
    out[address.toLowerCase()] = normalizedByNonce
  }
  return out
}

/**
 * Run the upstream `txpool_content` payload through one normalization
 * pass: lowercase every sender address, decimal-ify every nonce key.
 * Idempotent — re-normalizing a NormalizedMempool returns an
 * equivalent NormalizedMempool. Pass `null`/`undefined` to get an
 * empty NormalizedMempool back (lookup helpers handle null too, but
 * always-having-a-shape simplifies callers that store the snapshot).
 */
export const normalizeMempool = (
  pool: TxPoolContent | null | undefined,
): NormalizedMempool => ({
  pending: normalizeSubpool(pool?.pending),
  queued: normalizeSubpool(pool?.queued),
})

const searchSubpool = (
  subpool: Record<string, Record<string, RawTx>> | undefined,
  bucket: MempoolBucket,
  predicate: (tx: RawTx) => boolean,
): MempoolHit | null => {
  if (!subpool) return null
  for (const [address, byNonce] of Object.entries(subpool)) {
    for (const [nonce, tx] of Object.entries(byNonce)) {
      if (predicate(tx)) {
        return { tx, bucket, address, nonce }
      }
    }
  }
  return null
}

const eq = (a: string | undefined, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/**
 * Find a tx in `pending` or `queued` by hash. Searches `pending` first
 * — the common "is my tx going to mine?" question is most often
 * answered there. Hash comparison is case-insensitive (tx.hash on the
 * stored RawTx may still be checksum-mixed-case from upstream; we
 * don't rewrite per-tx fields during pool normalization, only the
 * outer keys).
 */
export const findByHash = (
  pool: NormalizedMempool | null | undefined,
  hash: string,
): MempoolHit | null => {
  if (!pool || !hash) return null
  const pending = searchSubpool(pool.pending, 'pending', (tx) => eq(tx.hash, hash))
  if (pending) return pending
  return searchSubpool(pool.queued, 'queued', (tx) => eq(tx.hash, hash))
}

/**
 * Find a tx by sender address + nonce. Direct two-key lookup — no
 * scan, no case-walk, because the pool is normalized at ingest.
 * `nonce` accepts a number, a decimal string (`'5'`), a hex string
 * (`'0x5'`), or a bigint. Returns `null` when the pool is null/empty,
 * the address has no entries, or the address is present but the nonce
 * isn't.
 */
export const findByAddressNonce = (
  pool: NormalizedMempool | null | undefined,
  address: string,
  nonce: number | bigint | string,
): MempoolHit | null => {
  if (!pool || !address) return null

  const lowerAddr = address.toLowerCase()
  // BigInt() handles every accepted form: 5, 5n, '5', '0x5'. The .toString()
  // is the canonical decimal form the normalized pool keys are written in.
  const decimalNonce = BigInt(nonce).toString()

  const probe = (
    subpool: Record<string, Record<string, RawTx>> | undefined,
    bucket: MempoolBucket,
  ): MempoolHit | null => {
    const tx = subpool?.[lowerAddr]?.[decimalNonce]
    return tx ? { tx, bucket, address: lowerAddr, nonce: decimalNonce } : null
  }

  return probe(pool.pending, 'pending') ?? probe(pool.queued, 'queued')
}

/**
 * Single-call lookup that takes a discriminated `TxIdentifier`. Use
 * when you don't statically know which dimension you're querying on
 * (e.g. wiring up a UI that lets the user paste either a hash or an
 * address + nonce).
 */
export const findInMempool = (
  pool: NormalizedMempool | null | undefined,
  id: TxIdentifier,
): MempoolHit | null => {
  if ('hash' in id) return findByHash(pool, id.hash)
  return findByAddressNonce(pool, id.address, id.nonce)
}
