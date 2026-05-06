import { test, expect, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { probeCapabilities } from './capabilities.js'

interface StubTransport {
  type: string
  subscribe?: (...args: unknown[]) => Promise<{ unsubscribe: () => void }>
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
  const client = stubClient({
    type: 'webSocket',
    subscribe: async () => ({ unsubscribe: () => {} }),
  })
  const caps = await probeCapabilities(client)
  expect(caps.newHeads).toBe('subscription')
  expect(caps.newPendingTransactions).toBe('subscription')
})

test('webSocket transport reports reprobeOnReconnect as true', async () => {
  const client = stubClient({
    type: 'webSocket',
    subscribe: async () => ({ unsubscribe: () => {} }),
  })
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

test('probeCapabilities — WS subscribe live-probe success', async () => {
  let subscribeCalls = 0
  const fakeUnsub = vi.fn()
  // Some viem transports invoke onData / onError synchronously during
  // subscribe (queued head event or setup error). The probe must treat
  // both as safe no-ops; this mock exercises both callback paths.
  const client = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      throw new Error(`unexpected ${method}`)
    }),
    transport: {
      type: 'webSocket',
      subscribe: vi.fn(
        async (arg: {
          params: unknown[]
          onData: (data: unknown) => void
          onError: (err: unknown) => void
        }) => {
          subscribeCalls++
          arg.onData('synthetic-head')
          arg.onError(new Error('synthetic-setup-error'))
          return { unsubscribe: fakeUnsub }
        },
      ),
    },
  } as unknown as PublicClient

  const caps = await probeCapabilities(client)

  expect(caps.newHeads).toBe('subscription')
  expect(subscribeCalls).toBe(1)
  expect(fakeUnsub).toHaveBeenCalledOnce()
})

test('probeCapabilities — WS subscribe live-probe failure downgrades to poll-only', async () => {
  const onError = vi.fn()
  const client = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      throw new Error(`unexpected ${method}`)
    }),
    transport: {
      type: 'webSocket',
      subscribe: vi.fn(async () => {
        throw new Error('eth_subscribe rejected')
      }),
    },
  } as unknown as PublicClient

  const caps = await probeCapabilities(client, { onError })

  expect(caps.newHeads).toBe('poll-only')
  expect(onError).toHaveBeenCalledWith('eth_subscribe', expect.any(Error))
  expect(caps.newPendingTransactions).toBe('poll-only')
  expect(caps.reprobeOnReconnect).toBe(false)
})

test('probeCapabilities — WS subscribe failure without onError downgrades silently', async () => {
  const client = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'txpool_content') return { pending: {}, queued: {} }
      if (method === 'eth_getTransactionReceipt') return null
      throw new Error(`unexpected ${method}`)
    }),
    transport: {
      type: 'webSocket',
      subscribe: vi.fn(async () => {
        throw new Error('eth_subscribe rejected')
      }),
    },
  } as unknown as PublicClient

  await expect(probeCapabilities(client)).resolves.toMatchObject({
    newHeads: 'poll-only',
  })
})
