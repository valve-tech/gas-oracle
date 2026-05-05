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
 * **What this probe deliberately does NOT do:** issue a real
 * `eth_subscribe` against the upstream. The viem transport's
 * `subscribe` API surface varies across versions and engaging it just
 * to immediately tear it down is wasteful + can leak handles on
 * misbehaving providers. We detect WS-subscribe capability
 * structurally (`typeof transport.subscribe === 'function'`) and let
 * the actual subscribe attempt happen lazily when a consumer calls
 * `source.subscribeBlocks` / `subscribeMempool`. If the runtime
 * subscribe fails, the source emits a `signal-degraded`-shaped fact
 * (or downstream consumers do — chain-source itself doesn't author
 * editorial events). This is the v0.3.x posture; future revisions
 * may upgrade to live-probing if a provider is found that lies
 * structurally.
 */

import type { PublicClient } from 'viem'

import { safeRequest, zeroHash } from './transport.js'
import type { Capabilities } from './types.js'

interface ProbeOptions {
  /** Same role as on `createChainSource` — sub-RPC failure sink. */
  onError?: (method: string, err: unknown) => void
}

/**
 * Inspect the client's transport surface to decide whether push
 * subscriptions are possible. The capability is structural — the
 * subscribe attempt itself is deferred to the actual subscribeBlocks /
 * subscribeMempool call so we don't pay an early eth_subscribe just
 * to learn the answer.
 *
 * Returns `'subscription'` when the transport exposes a `subscribe`
 * function (canonical viem WS shape), `'unavailable'` otherwise.
 * `'poll-only'` is reserved for the future live-probe variant where
 * we can distinguish "transport supports subscribe but upstream
 * rejected this method" from "transport doesn't subscribe at all."
 */
const probeSubscribeShape = (
  client: PublicClient,
): 'subscription' | 'unavailable' => {
  const transport = client.transport as { subscribe?: unknown }
  return typeof transport.subscribe === 'function' ? 'subscription' : 'unavailable'
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
  const subscribeShape = probeSubscribeShape(client)

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
