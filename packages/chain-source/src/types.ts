/**
 * Canonical wire-shape types for `@valve-tech/chain-source`. Pure data
 * shapes — no deps, no runtime behavior.
 *
 * **Wire format note.** Numeric fields that come from the EVM (block
 * numbers, gas, fees, timestamps) are kept as `bigint` once decoded.
 * The boundary types (`BlockResult`, `TxPoolContent`, `FeeHistoryResult`)
 * keep them as hex strings because that is what `eth_getBlockByNumber`
 * et al. return — the source decodes at the point of use, then returns
 * `bigint`-typed objects to consumers (oracle, tracker). `JSON.stringify`
 * on a state with `bigint` will throw; persistence layers hex-encode
 * at their wire boundary, see `docs/tx-tracker-spec.md` §2.5.
 *
 * This package is the canonical owner of the wire-shape types
 * (`RawTx`, `BlockResult`, `FeeHistoryResult`, `TxPoolContent`,
 * `NormalizedMempool`) and the poll-cycle toggle (`PollOptions`).
 * `@valve-tech/gas-oracle` and `@valve-tech/tx-tracker` import them
 * from here; gas-oracle re-exports them from its own `index.ts` so
 * downstream consumers using the gas-oracle package don't have to
 * add a second import to type a fixture or a stored snapshot.
 */

/**
 * Minimal tx shape extracted from `eth_getBlockByNumber(latest, true)`
 * or `txpool_content`. Hash, sender (`from`), and `nonce` support
 * mempool lookups (`findInMempool`-style helpers downstream); fee
 * fields drive any downstream tip math; other tx fields
 * (to/value/data/etc.) are not required by the source.
 *
 * The three identity fields (`hash`, `from`, `nonce`) are nominally
 * optional because tests may construct fixtures with only the bits
 * they exercise. In practice every modern EVM client populates all
 * three on both `eth_getBlockByNumber(_, true)` and `txpool_content`.
 */
export interface RawTx {
  maxPriorityFeePerGas?: string
  maxFeePerGas?: string
  gasPrice?: string
  gas?: string
  type?: string
  hash?: string
  from?: string
  nonce?: string
}

/**
 * Result shape returned by `eth_feeHistory`. Hex-encoded numbers; the
 * source decodes at the point of use.
 */
export interface FeeHistoryResult {
  baseFeePerGas: string[]
  reward?: string[][]
  gasUsedRatio: number[]
  oldestBlock: string
}

/**
 * Result shape returned by `eth_getBlockByNumber` with
 * `fullTransactions=true`. Hex-encoded numbers; consumers
 * (oracle, tracker) decode the fields they need.
 */
export interface BlockResult {
  number: string
  hash?: string
  parentHash?: string
  timestamp: string
  baseFeePerGas: string
  gasLimit: string
  gasUsed: string
  transactions: RawTx[]
  excessBlobGas?: string
  blobGasUsed?: string
}

/**
 * Result shape returned by `txpool_content`. Two-level map: sender
 * address → nonce → RawTx, split into `pending` (next-in-line) and
 * `queued` (gap txs that can't mine yet).
 *
 * Upstream clients are inconsistent about address case (geth/reth use
 * EIP-55 checksum; some clients lowercase) and nonce encoding (hex vs
 * decimal). Pass through `normalizeMempool` once at ingest to get a
 * canonical `NormalizedMempool` (lowercase addresses, decimal nonces);
 * lookup helpers expect that form.
 */
export interface TxPoolContent {
  pending: Record<string, Record<string, RawTx>>
  queued: Record<string, Record<string, RawTx>>
}

/**
 * `TxPoolContent` after a single normalization pass — every sender
 * address key is lowercase ASCII, every nonce key is a decimal string.
 * Structural alias of `TxPoolContent`; the type name signals the
 * invariant to downstream lookup helpers.
 */
export type NormalizedMempool = TxPoolContent

/**
 * Single full-block fetch shape. viem's `getTransactionReceipt` returns
 * a richer object than this minimal type captures; consumers cast as
 * needed. Source-level shape is loose because `txpool_content` /
 * receipts vary slightly across clients and we don't want a strict
 * shape rejecting a working response.
 */
export interface TransactionReceipt {
  transactionHash: string
  blockHash: string
  blockNumber: string
  status?: string
  [key: string]: unknown
}

/**
 * Producer-side toggles: which RPCs the source's poll loop fans out
 * each cycle. Fields default to `true`. `eth_getBlockByNumber` is
 * intentionally not toggleable — without a block neither downstream
 * consumer can do anything.
 *
 * - `feeHistory: false` — drops `eth_feeHistory`. Downstream consumers
 *                          relying on multi-block trend detection lose
 *                          fidelity (single-element fallback is
 *                          conservative).
 * - `mempool: false`    — drops `txpool_content`. Mempool subscribers
 *                          never receive snapshots; `getMempoolSnapshot`
 *                          returns `null`. Useful when the upstream
 *                          provider gates the method.
 */
export interface PollOptions {
  feeHistory?: boolean
  mempool?: boolean
}

/**
 * How the source observed a particular fact. Discriminates the
 * authority of any downstream-built event. The same chain-state can
 * legitimately be observed via four paths; consumers that need hard
 * guarantees filter to `'subscription'`.
 *
 * `'block-poll'` and `'mempool-snapshot'` indicate the source's
 * own poll cycle pulled the data via `eth_getBlockByNumber` /
 * `txpool_content` respectively. `'receipt-poll'` covers any per-hash
 * status check that isn't the source's own block-poll — typically
 * backed by `eth_getTransactionByHash` or `eth_getTransactionReceipt`,
 * answering either the mined-state or pending-state question for a
 * specific hash. The tx-tracker uses it for: (1) the
 * `receipt-poll-fallback` lost-signal policy, (2) consumer-supplied
 * `probeMined` inclusion probes, and (3) the default
 * `statusPollEveryBlocks` per-hash status poll (and its optional
 * consumer `probeTransaction` fallback). Per-hash checks via this
 * source cannot authoritatively detect reorgs (spec §12.3 —
 * `buildVanishedFromBlock` rejects this source).
 */
export type EventSource =
  | 'subscription'
  | 'block-poll'
  | 'mempool-snapshot'
  | 'receipt-poll'

/**
 * Per-method capability snapshot. Probed once on `source.start()` and
 * re-probed on transport reconnect when the underlying transport
 * supports reconnection signals.
 *
 * Intentionally per-method, not per-transport — real-world providers
 * gate `txpool_content` while allowing `eth_subscribe('newHeads')`,
 * and chains expose `txpool_content` while never offering
 * `newPendingTransactions`. A single "ws-or-http" knob would elide
 * cases the toolkit needs to cover.
 */
export interface Capabilities {
  /** `eth_subscribe('newHeads')` push-based new-block events. */
  newHeads: 'subscription' | 'poll-only' | 'unavailable'
  /** `eth_subscribe('newPendingTransactions')` push-based mempool ingress. */
  newPendingTransactions: 'subscription' | 'poll-only' | 'unavailable'
  /** `txpool_content` support — many public RPCs gate this method. */
  txpoolContent: 'available' | 'gated'
  /** `eth_getTransactionReceipt` fallback path for inclusion watch. */
  receiptByHash: 'available' | 'unavailable'
  /** Whether transport reconnection re-probes (WS reconnect, etc.). */
  reprobeOnReconnect: boolean
}
