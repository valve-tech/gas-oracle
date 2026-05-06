/**
 * Per-method capability probe. Run once at `source.start()`, exposed
 * via `source.capabilities()`, and re-run on transport reconnect when
 * the underlying transport supports reconnection signalling. The
 * probe is the load-bearing place where the toolkit's "no silent
 * downgrade" rule (spec §2.2) is honored — every event the source
 * emits carries a `source` discriminator chosen against this matrix.
 *
 * The probe uses the existing `safeRequest`-returns-null pattern: a
 * thrown error is treated as "method gated/unavailable", a `null`
 * return is treated the same. The distinction between the four states
 * (`subscription` / `poll-only` / `available` / `gated` /
 * `unavailable`) lives in the per-method spec table (§7).
 *
 * **WS subscribe live-probe (v0.8.0+):** at probe time we issue one
 * opportunistic `eth_subscribe('newHeads')` round-trip and immediately
 * unsubscribe. This upgrades the v0.3.x structural check
 * (`typeof transport.subscribe === 'function'`) to a truthful answer —
 * some transports wrap but can't actually open a subscription, and the
 * downstream wiring added in v0.8.0 needs the probe's answer to be
 * accurate before attempting to wire a live subscription. A failure
 * downgrades to `'poll-only'` and surfaces via `onError`.
 */

import type { PublicClient } from 'viem'

import { safeRequest, zeroHash } from './transport.js'
import type { Capabilities } from './types.js'

interface ProbeOptions {
  /** Same role as on `createChainSource` — sub-RPC failure sink. */
  onError?: (method: string, err: unknown) => void
}

/**
 * Inspect the client's transport surface and perform one opportunistic
 * `newHeads` round-trip to confirm the transport can actually open a
 * subscription. A structural check alone (`typeof subscribe === 'function'`)
 * is insufficient — some transports wrap-but-can't-subscribe.
 *
 * - `'subscription'` — transport exposes `subscribe` **and** the probe call
 *   succeeded; push-based event flow is available.
 * - `'poll-only'` — transport exposes `subscribe` but the probe threw; the
 *   upstream rejected `eth_subscribe`, so we fall back to polling.
 * - `'unavailable'` — transport has no `subscribe` function at all; HTTP-only.
 */
const probeSubscribeShape = async (
  client: PublicClient,
  onError?: (method: string, err: unknown) => void,
): Promise<'subscription' | 'poll-only' | 'unavailable'> => {
  const transport = client.transport as {
    subscribe?: (...args: unknown[]) => Promise<{ unsubscribe: () => void }>
  }
  if (typeof transport.subscribe !== 'function') return 'unavailable'
  // Live probe: open and immediately close a newHeads subscription. Cheap;
  // the upstream sees one eth_subscribe + one eth_unsubscribe and we get a
  // truthful answer to "does this transport.subscribe actually work?"
  try {
    const sub = await transport.subscribe({
      params: ['newHeads'],
      // No-op stubs: the transport.subscribe contract requires both
      // callbacks. The probe unsubscribes immediately, so on most
      // upstreams these never fire — but some viem transports invoke
      // onData / onError synchronously during subscribe (queued head
      // event or setup error). Both paths must be a safe no-op so the
      // probe's only signal is the resolved/rejected outer promise.
      onData: () => {},
      onError: () => {},
    } as unknown as Parameters<typeof transport.subscribe>[0])
    sub.unsubscribe()
    return 'subscription'
  } catch (err) {
    if (onError) onError('eth_subscribe', err)
    return 'poll-only'
  }
}

/**
 * Probe the upstream client's per-method capability. The result is a
 * stable snapshot the source caches and exposes via
 * `source.capabilities()`.
 */
export const probeCapabilities = async (
  client: PublicClient,
  options: ProbeOptions = {},
): Promise<Capabilities> => {
  const subscribeShape = await probeSubscribeShape(client, options.onError)

  // 1. txpool_content — distinguishes 'available' / 'gated'. Many
  // public RPCs return 405 / method-not-found for this method.
  const txpoolResult = await safeRequest(
    client,
    'txpool_content',
    [],
    options.onError ? (err: unknown) => options.onError!('txpool_content', err) : undefined,
  )
  const txpoolContent: 'available' | 'gated' =
    txpoolResult === null ? 'gated' : 'available'

  // 2. eth_getTransactionReceipt against the zero hash. Per spec §7.2,
  // most providers return null for the zero hash but should not throw.
  // A throw is taken as "method unavailable." Use direct request rather
  // than safeRequest so the throw path is observable.
  let receiptByHash: 'available' | 'unavailable' = 'available'
  try {
    await client.request({
      method: 'eth_getTransactionReceipt',
      params: [zeroHash],
    } as never)
  } catch (err) {
    receiptByHash = 'unavailable'
    if (options.onError) options.onError('eth_getTransactionReceipt', err)
  }

  // 3. WS-subscribe capability is the same answer for both newHeads
  // and newPendingTransactions — the discriminator there is whether
  // the upstream supports the *channel*, not the method. Mid-session
  // method-specific failure surfaces via `signal-degraded` events on
  // downstream consumers (the source itself doesn't author editorial
  // events; see §3.2 of the spec).
  return {
    newHeads: subscribeShape,
    newPendingTransactions:
      // If subscribe is unavailable, fall back to whether txpool_content
      // is available (poll fallback for mempool watch). If both are
      // unavailable, mempool watch isn't possible at all.
      subscribeShape === 'subscription'
        ? 'subscription'
        : txpoolContent === 'available'
          ? 'poll-only'
          : 'unavailable',
    txpoolContent,
    receiptByHash,
    // WS transports are the ones that reconnect; HTTP has no persistent
    // connection so reprobe-on-reconnect is meaningless.
    reprobeOnReconnect: subscribeShape === 'subscription',
  }
}
