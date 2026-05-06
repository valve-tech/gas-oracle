import { test, expect, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { probeCapabilities } from './capabilities.js'

interface StubTransport {
  type: string
  subscribe?: unknown
}

interface StubResponses {
  txpool_content?: () => unknown
  eth_getTransactionReceipt?: () => unknown
}

const stubClient = (
  transport: StubTransport,
  responses: StubResponses = {},
): PublicClient => {
  return {
    transport,
    request: vi.fn(async ({ method }: { method: string; params: unknown[] }) => {
      const responder = responses[method as keyof StubResponses]
      if (!responder) return null
      return responder()
    }),
  } as unknown as PublicClient
}

test('http-only transport reports newHeads + newPendingTransactions as unavailable', async () => {
  // No transport.subscribe → no push capability for either signal.
  const client = stubClient({ type: 'http' })
  const caps = await probeCapabilities(client)
  expect(caps.newHeads).toBe('unavailable')
  expect(caps.newPendingTransactions).toBe('unavailable')
})

test('http-only transport reports reprobeOnReconnect as false', async () => {
  // Reconnection re-probing only matters for transports that actually
  // reconnect (WS). HTTP has no persistent connection.
  const client = stubClient({ type: 'http' })
  const caps = await probeCapabilities(client)
  expect(caps.reprobeOnReconnect).toBe(false)
})

test('webSocket transport with subscribe support reports newHeads + newPendingTransactions as subscription', async () => {
  const client = stubClient({ type: 'webSocket', subscribe: () => {} })
  const caps = await probeCapabilities(client)
  expect(caps.newHeads).toBe('subscription')
  expect(caps.newPendingTransactions).toBe('subscription')
})

test('webSocket transport reports reprobeOnReconnect as true', async () => {
  const client = stubClient({ type: 'webSocket', subscribe: () => {} })
  const caps = await probeCapabilities(client)
  expect(caps.reprobeOnReconnect).toBe(true)
})

test('txpoolContent is available when the upstream returns a snapshot', async () => {
  const client = stubClient(
    { type: 'http' },
    { txpool_content: () => ({ pending: {}, queued: {} }) },
  )
  const caps = await probeCapabilities(client)
  expect(caps.txpoolContent).toBe('available')
})

test('txpoolContent is gated when the upstream throws', async () => {
  const client = stubClient(
    { type: 'http' },
    {
      txpool_content: () => {
        throw new Error('Method txpool_content not available')
      },
    },
  )
  const caps = await probeCapabilities(client)
  expect(caps.txpoolContent).toBe('gated')
})

test('txpoolContent is gated when the upstream returns null', async () => {
  // Some providers return null instead of throwing for unsupported methods.
  const client = stubClient({ type: 'http' }, { txpool_content: () => null })
  const caps = await probeCapabilities(client)
  expect(caps.txpoolContent).toBe('gated')
})

test('receiptByHash is available when the upstream returns null for the zero hash', async () => {
  // The standard "no such tx" response shape — null. Method exists.
  const client = stubClient(
    { type: 'http' },
    { eth_getTransactionReceipt: () => null },
  )
  const caps = await probeCapabilities(client)
  expect(caps.receiptByHash).toBe('available')
})

test('receiptByHash is unavailable when the upstream throws', async () => {
  const client = stubClient(
    { type: 'http' },
    {
      eth_getTransactionReceipt: () => {
        throw new Error('method not supported')
      },
    },
  )
  const caps = await probeCapabilities(client)
  expect(caps.receiptByHash).toBe('unavailable')
})

test('probeCapabilities routes upstream errors to onError when provided', async () => {
  const onError = vi.fn<(method: string, err: unknown) => void>()
  const client = stubClient(
    { type: 'http' },
    {
      txpool_content: () => {
        throw new Error('gated')
      },
    },
  )
  await probeCapabilities(client, { onError })
  expect(onError).toHaveBeenCalled()
  expect(onError.mock.calls.some(([method]) => method === 'txpool_content')).toBe(true)
})

test('probeCapabilities routes receipt-probe failures to onError', async () => {
  const onError = vi.fn<(method: string, err: unknown) => void>()
  const client = stubClient(
    { type: 'http' },
    {
      eth_getTransactionReceipt: () => {
        throw new Error('method unavailable')
      },
    },
  )
  const caps = await probeCapabilities(client, { onError })
  expect(caps.receiptByHash).toBe('unavailable')
  expect(
    onError.mock.calls.some(
      ([method]) => method === 'eth_getTransactionReceipt',
    ),
  ).toBe(true)
})
