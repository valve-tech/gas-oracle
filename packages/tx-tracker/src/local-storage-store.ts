/**
 * `createLocalStorageTrackerStore` — first-party `TxTrackerStore`
 * implementation backed by `localStorage` (or any `Storage`-shaped
 * object). Targeted at browser dApps that need durable per-hash
 * subscriptions surviving page reloads but don't want to maintain
 * their own custom store.
 *
 * Key layout (under the consumer-supplied `keyPrefix`):
 *
 *   {keyPrefix}:{chainId}:{hash}            → the TrackedTxRecord JSON
 *   {keyPrefix}:eventlog:{chainId}:{hash}   → the per-hash event log JSON
 *
 * The eventlog is a separate key from the record so put/get can avoid
 * paying read-and-rewrite for the (potentially-large) log on every
 * status update.
 *
 * **`delete()` clears BOTH keys.** This is the contract the
 * `TxTrackerStore.delete` docstring requires; we lock it in here so
 * consumers don't accumulate orphan eventlogs when records expire
 * (the canonical bug that motivated this first-party store —
 * consumer-implemented localStorage stores routinely forgot to clear
 * the eventlog key).
 *
 * Browser-safety: `localStorage` is browser-only. The factory accepts
 * a `storage` override (defaults to `globalThis.localStorage`) so
 * (a) tests can inject a fake and (b) consumers running in
 * server-rendered contexts can supply a no-op implementation rather
 * than throwing at construction.
 */

import type { Hash, TxEvent } from './events.js'
import type {
  PersistedSubscription,
  TrackedTxRecord,
  TxTrackerStore,
} from './store.js'

/**
 * Storage-shaped interface — the subset of the DOM `Storage` API the
 * store needs. `localStorage` and `sessionStorage` both satisfy this;
 * consumers can supply any object with the same shape (in-memory fake,
 * server-rendered no-op, IndexedDB-backed polyfill, etc.).
 */
export interface LocalStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

export interface LocalStorageTrackerStoreOptions {
  /**
   * Namespace prefix for all keys this store writes. Required. Use
   * a versioned prefix (e.g. `'myapp.tx-tracker.v1'`) and bump the
   * version suffix when the persisted shape changes — the prior-
   * prefix keys can then be cleaned up via `cleanupLegacyPrefixes`.
   */
  keyPrefix: string

  /**
   * Storage backend. Defaults to `globalThis.localStorage` when
   * available; throws at construction otherwise (server-rendered or
   * Node contexts must supply an explicit `storage` parameter, even
   * if it's a no-op).
   */
  storage?: LocalStorageLike

  /**
   * Cap on the per-hash event log. When `appendEvent` would push the
   * log past this length, the oldest entries are dropped. Default 256
   * (matches `InMemoryStoreOptions.eventLogCapacity`).
   */
  eventLogCapacity?: number

  /**
   * On construction, delete every key in `storage` that starts with
   * any of these prefixes followed by `:`. Use to clean up records
   * orphaned by a prior `keyPrefix` bump. Pass the OLD prefix (or
   * prefixes), not the current one — passing the current one would
   * wipe live state.
   */
  cleanupLegacyPrefixes?: string[]
}

const DEFAULT_EVENT_LOG_CAPACITY = 256

const recordKey = (prefix: string, chainId: number, hash: Hash): string =>
  `${prefix}:${chainId}:${hash}`

const eventLogKey = (prefix: string, chainId: number, hash: Hash): string =>
  `${prefix}:eventlog:${chainId}:${hash}`

/**
 * JSON replacer that round-trips `bigint` losslessly. The toolkit's
 * persisted shapes carry block numbers and other on-chain quantities
 * as bigint; native `JSON.stringify` throws on them. We tag with a
 * sentinel discriminator so the reviver can rehydrate to bigint
 * without ambiguity against arbitrary user strings.
 */
const SENTINEL = '$tx-tracker:bigint'

const bigintReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') {
    return { [SENTINEL]: value.toString() }
  }
  return value
}

const bigintReviver = (_key: string, value: unknown): unknown => {
  if (
    value !== null &&
    typeof value === 'object' &&
    SENTINEL in value &&
    typeof (value as Record<string, unknown>)[SENTINEL] === 'string'
  ) {
    try {
      return BigInt((value as Record<string, string>)[SENTINEL])
    } catch {
      // Malformed sentinel — fall back to the raw object; downstream
      // type guards (typeof === 'bigint') will treat as missing.
      return value
    }
  }
  return value
}

const stringifyRecord = (value: unknown): string =>
  JSON.stringify(value, bigintReplacer)

const parseRecord = <T>(raw: string | null): T | null => {
  if (raw === null) return null
  try {
    return JSON.parse(raw, bigintReviver) as T
  } catch {
    return null
  }
}

/**
 * Build a localStorage-backed `TxTrackerStore`. See module docstring
 * for the key layout and serialization details.
 *
 * @example
 *   import {
 *     createTxTracker,
 *     createLocalStorageTrackerStore,
 *   } from '@valve-tech/tx-tracker'
 *
 *   const store = createLocalStorageTrackerStore({
 *     keyPrefix: 'myapp.tx-tracker.v1',
 *     cleanupLegacyPrefixes: ['myapp.tx-tracker.v0'],
 *   })
 *   const tracker = createTxTracker({ source, chainId: 1, store })
 */
export const createLocalStorageTrackerStore = (
  options: LocalStorageTrackerStoreOptions,
): TxTrackerStore => {
  const storage =
    options.storage ??
    (typeof globalThis !== 'undefined' &&
    'localStorage' in globalThis &&
    globalThis.localStorage
      ? (globalThis.localStorage as LocalStorageLike)
      : null)
  if (!storage) {
    throw new Error(
      'createLocalStorageTrackerStore: no `storage` supplied and globalThis.localStorage is unavailable. Pass `storage: ...` explicitly when running in a non-browser environment.',
    )
  }
  if (!options.keyPrefix) {
    throw new Error('createLocalStorageTrackerStore: keyPrefix is required')
  }
  const keyPrefix = options.keyPrefix
  const eventLogCapacity = options.eventLogCapacity ?? DEFAULT_EVENT_LOG_CAPACITY

  // Cleanup pass on construction. Skip the current prefix even if a
  // consumer accidentally lists it — wiping live state mid-session
  // would be the most-surprising-thing possible.
  for (const legacy of options.cleanupLegacyPrefixes ?? []) {
    if (!legacy || legacy === keyPrefix) continue
    deleteKeysStartingWith(storage, `${legacy}:`)
  }

  return {
    put: async (record) => {
      storage.setItem(
        recordKey(keyPrefix, record.chainId, record.hash),
        stringifyRecord(record),
      )
    },

    get: async (chainId, hash) => {
      const raw = storage.getItem(recordKey(keyPrefix, chainId, hash))
      return parseRecord<TrackedTxRecord>(raw)
    },

    delete: async (chainId, hash) => {
      // Critically: clear BOTH the record AND the eventlog. The bug
      // class this fixes is the consumer-side localStorage store that
      // remembered only the record key on delete, leaving the eventlog
      // as a permanent orphan.
      storage.removeItem(recordKey(keyPrefix, chainId, hash))
      storage.removeItem(eventLogKey(keyPrefix, chainId, hash))
    },

    listDurable: async (chainId) => {
      const prefix = `${keyPrefix}:${chainId}:`
      const result: TrackedTxRecord[] = []
      // Snapshot the keys first — mutations during iteration would
      // shift the `key(i)` indexing. Browser localStorage is
      // synchronous, but defensive against any Storage-shaped object
      // that mutates during the iteration.
      //
      // Filter: record keys are `{keyPrefix}:{chainId}:{hash}`, eventlog
      // keys are `{keyPrefix}:eventlog:{chainId}:{hash}`. With a numeric
      // chainId the two prefixes don't overlap (`p:1:` vs `p:eventlog:`),
      // so a single `startsWith(prefix)` check is enough — eventlog keys
      // can never match the record prefix.
      const keys: string[] = []
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        if (k === null) continue
        if (!k.startsWith(prefix)) continue
        keys.push(k)
      }
      for (const k of keys) {
        const record = parseRecord<TrackedTxRecord>(storage.getItem(k))
        if (!record) continue
        if (record.chainId !== chainId) continue
        if (record.subscriptions.some((sub) => sub.durable)) {
          result.push(record)
        }
      }
      return result
    },

    appendEvent: async (chainId, hash, event) => {
      // Async so a `storage.setItem` throw (quota exceeded, browser
      // disabled storage, private-mode constraints) surfaces as a
      // rejected promise rather than a synchronous throw — the tracker
      // routes store errors through `onError` and never lets them
      // halt the live emit fanout (spec Appendix A).
      const key = eventLogKey(keyPrefix, chainId, hash)
      const existing = parseRecord<TxEvent[]>(storage.getItem(key)) ?? []
      existing.push(event)
      // Drop oldest entries when the log exceeds the cap. Slicing
      // from the tail keeps the most-recent window — the audit-trail
      // pattern indexers expect.
      const trimmed =
        existing.length > eventLogCapacity
          ? existing.slice(existing.length - eventLogCapacity)
          : existing
      storage.setItem(key, stringifyRecord(trimmed))
    },

    readEventLog: async (chainId, hash, since) => {
      const key = eventLogKey(keyPrefix, chainId, hash)
      const raw = storage.getItem(key)
      const events = parseRecord<TxEvent[]>(raw) ?? []
      if (since === undefined) return events
      return events.filter((e) => e.at.blockNumber >= since)
    },
  }
}

/**
 * Delete every key in `storage` whose name starts with `prefix`.
 * Exported so consumers can run prefix cleanup without instantiating
 * the full store — e.g., on app boot before constructing the tracker.
 */
export const deleteKeysStartingWith = (
  storage: LocalStorageLike,
  prefix: string,
): void => {
  if (!prefix) return
  // Snapshot keys first; removing during iteration shifts indexing.
  const matched: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k !== null && k.startsWith(prefix)) matched.push(k)
  }
  for (const k of matched) storage.removeItem(k)
}

// PersistedSubscription is imported only for type-narrowing on the
// listDurable iterator above — no runtime use. Re-export under its
// canonical home to keep the type-only import from showing up in the
// emitted JS.
export type { PersistedSubscription }
