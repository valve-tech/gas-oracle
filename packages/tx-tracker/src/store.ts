/**
 * `TxTrackerStore` — persistence surface for the tracker, plus the
 * default `createInMemoryStore` implementation.
 *
 * Per `docs/tx-tracker-spec.md` §9 + §10. Indexers and relays cannot
 * lose tracked hashes across a process restart; wallets are fine
 * in-memory. The store interface lets either case plug in.
 *
 * Two responsibilities:
 *
 *   - **Record store** — `put` / `get` / `delete` / `listDurable`
 *     for `TrackedTxRecord` (one per `(chainId, hash)`).
 *   - **Per-hash audit log** — `appendEvent` / `readEventLog?` over
 *     `TxEvent[]`. Default implementation is a bounded ring keyed
 *     by `(chainId, hash)`.
 *
 * The interface is **async-shaped** so durable stores (Redis, SQLite,
 * JSON-on-disk) can implement it directly. The in-memory default
 * resolves synchronously under the hood — `Promise.resolve` wrappers
 * are cheap.
 *
 * **Wire format** (§9.1, §2.5): `TrackedTxRecord` carries `bigint`
 * fields (`firstSeenBlockNumber`, `lastObservedBlockNumber`,
 * `retentionExpiresAtBlockNumber`) and `TxStatus` carries `bigint`
 * inside its nested `at` / `lastSeenIn*` shapes. The in-memory store
 * keeps them as `bigint` end-to-end. Durable store implementers MUST
 * hex-encode (`'0x' + n.toString(16)`) on write and decode on read;
 * the package never calls `JSON.stringify` on a record itself.
 */

import type { TxEvent, TxStatus, Hash, Address } from './events.js'

/**
 * One persisted record per tracked `(chainId, hash)`. `subscriptions`
 * carries every persisted (durable) subscription that referenced this
 * hash so `listDurable` can rehydrate them after restart.
 */
export interface TrackedTxRecord {
  chainId: number
  hash: Hash
  /** Cached current status, kept in sync with every emit. */
  status: TxStatus
  /** Block number of the very first observation. */
  firstSeenBlockNumber: bigint
  /** Block number of the most recent observation (any kind). */
  lastObservedBlockNumber: bigint
  /**
   * Block number after which the record is GC-eligible. Set when the
   * record reaches a terminal observation (`seen-in-block` reaching
   * the consumer's confirmation threshold, `unseen-for-N-blocks`,
   * `replaced-by`, etc.) plus `retentionBlocks`.
   */
  retentionExpiresAtBlockNumber: bigint
  /** Persisted subscriptions referencing this hash. */
  subscriptions: PersistedSubscription[]
}

/**
 * Per-hash and per-bulk subscription metadata. Predicate selectors
 * are non-serializable (closures cannot survive a process boundary)
 * — the tracker silently demotes them to non-durable and surfaces a
 * warning at registration. Per spec §13.2 only `'from'` / `'to'`
 * bulk selectors and per-hash selectors persist meaningfully.
 */
export interface PersistedSubscription {
  /** Stable identifier. The tracker assigns this on registration. */
  id: string
  /** Whether the consumer asked for durable persistence. */
  durable: boolean
  selector: HashSelector | BulkSelector
}

/**
 * Per-hash selector — one tracked hash, ergonomic for wallet UIs.
 */
export interface HashSelector {
  kind: 'hash'
  hash: Hash
}

/**
 * Bulk selector — `'from' | 'to' | 'predicate'`. `predicate`
 * carries a non-serializable function reference; durable persistence
 * records `kind: 'predicate'` without the function and the tracker
 * cannot rehydrate it on restart.
 */
export interface BulkSelector {
  kind: 'from' | 'to' | 'predicate'
  /** For 'from' / 'to'. */
  address?: Address
  /** For 'predicate'. Function references do not persist meaningfully. */
  match?: (tx: import('@valve-tech/chain-source').RawTx) => boolean
}

/**
 * Persistence surface. Indexers and relays cannot lose tracked hashes
 * across restart; wallets are fine in-memory. `readEventLog` is
 * optional — durable stores that don't keep a log can omit it.
 */
export interface TxTrackerStore {
  /**
   * Persist (or update) a tracked-tx record. Idempotent on
   * `(chainId, hash)`.
   */
  put(record: TrackedTxRecord): Promise<void>

  /** Read the latest record for a hash. Returns null if absent. */
  get(chainId: number, hash: Hash): Promise<TrackedTxRecord | null>

  /**
   * Remove a hash. Called when the retention window expires.
   *
   * **Contract: implementations must clear ALL state associated with
   * the hash** — the record itself, the event log (if any), and any
   * other per-hash keys the implementation maintains. A common bug in
   * custom stores is forgetting to delete the event log alongside the
   * record, leaving orphaned log entries that never expire. The
   * first-party `createInMemoryStore` and
   * `createLocalStorageTrackerStore` already enforce this; consumer
   * implementations must do the same.
   */
  delete(chainId: number, hash: Hash): Promise<void>

  /**
   * List records that carry at least one durable subscription. Called
   * once at `tracker.start()` so durable per-hash subscriptions can
   * be re-registered against the source after a restart.
   */
  listDurable(chainId: number): Promise<TrackedTxRecord[]>

  /**
   * Append an event to the per-hash audit log. Indexers replay this
   * log on restart; wallets can wrap a no-op store implementation.
   * Failures here are routed through the tracker's `onError` and
   * never block live emit (per spec Appendix A).
   */
  appendEvent(chainId: number, hash: Hash, event: TxEvent): Promise<void>

  /**
   * Read the per-hash audit log, optionally constrained to events
   * with `at.blockNumber >= since`. Optional — implementations
   * without a log return `undefined` on the type and get pruned
   * from the catch-up code path.
   */
  readEventLog?(
    chainId: number,
    hash: Hash,
    since?: bigint,
  ): Promise<TxEvent[]>
}

/**
 * Tunable knobs for the default in-memory store.
 *
 * - `retentionBlocks` (default 64): how many blocks past the last
 *   terminal observation a record stays in the store. After this
 *   window passes, the record is GC'd. Block-units, not seconds —
 *   reorg safety is a block-depth invariant, not a time invariant
 *   (spec §10.1).
 *
 * - `eventLogCapacity` (default 256): bounded ring buffer cap on
 *   the per-hash audit log. Older events are dropped when the cap
 *   is exceeded; the latest status is always retained.
 */
export interface InMemoryStoreOptions {
  retentionBlocks?: number
  eventLogCapacity?: number
}

const DEFAULT_RETENTION_BLOCKS = 64
const DEFAULT_EVENT_LOG_CAPACITY = 256

/**
 * Composite key for the in-memory map. Keying by `(chainId, hash)`
 * lets a single store back multi-chain trackers if a future caller
 * wants that — today the tracker is single-chain, but the store
 * type is already chain-aware so no migration is needed later.
 */
const recordKey = (chainId: number, hash: Hash): string =>
  `${chainId}:${hash}`

/**
 * Default in-memory store. Synchronous internals wrapped in
 * `Promise.resolve`; safe for any consumer that doesn't need
 * cross-process durability.
 *
 * @example
 *   import { createInMemoryStore } from '@valve-tech/tx-tracker'
 *
 *   const store = createInMemoryStore({ retentionBlocks: 32 })
 *   const tracker = createTxTracker({ source, chainId: 1, store })
 */
export const createInMemoryStore = (
  options: InMemoryStoreOptions = {},
): TxTrackerStore => {
  const eventLogCapacity =
    options.eventLogCapacity ?? DEFAULT_EVENT_LOG_CAPACITY

  const records = new Map<string, TrackedTxRecord>()
  const eventLogs = new Map<string, TxEvent[]>()

  return {
    put: (record) => {
      records.set(recordKey(record.chainId, record.hash), record)
      return Promise.resolve()
    },

    get: (chainId, hash) =>
      Promise.resolve(records.get(recordKey(chainId, hash)) ?? null),

    delete: (chainId, hash) => {
      const key = recordKey(chainId, hash)
      records.delete(key)
      eventLogs.delete(key)
      return Promise.resolve()
    },

    listDurable: (chainId) => {
      const result: TrackedTxRecord[] = []
      for (const record of records.values()) {
        if (record.chainId !== chainId) continue
        if (record.subscriptions.some((sub) => sub.durable)) {
          result.push(record)
        }
      }
      return Promise.resolve(result)
    },

    appendEvent: (chainId, hash, event) => {
      const key = recordKey(chainId, hash)
      const log = eventLogs.get(key) ?? []
      log.push(event)
      // Drop oldest when capacity exceeded. Latest entries are the
      // ones consumers care about for catch-up; keeping a strict
      // ring rather than unbounded growth caps memory.
      if (log.length > eventLogCapacity) {
        log.splice(0, log.length - eventLogCapacity)
      }
      eventLogs.set(key, log)
      return Promise.resolve()
    },

    readEventLog: (chainId, hash, since) => {
      const log = eventLogs.get(recordKey(chainId, hash)) ?? []
      if (since === undefined) return Promise.resolve([...log])
      return Promise.resolve(log.filter((e) => e.at.blockNumber >= since))
    },
  }
}

/**
 * Compute the retention-expiry block for a terminal observation.
 * Pure helper exposed so the tracker (which decides when to call
 * `store.put` with an updated `retentionExpiresAtBlockNumber`) and
 * the store implementations stay in sync on the calculation.
 */
export const computeRetentionExpiry = (
  terminalBlockNumber: bigint,
  retentionBlocks: number = DEFAULT_RETENTION_BLOCKS,
): bigint => terminalBlockNumber + BigInt(retentionBlocks)

/**
 * Default retention window in blocks — exposed so the tracker can
 * use the same default if no store-level override is present.
 */
export const defaultRetentionBlocks = DEFAULT_RETENTION_BLOCKS
