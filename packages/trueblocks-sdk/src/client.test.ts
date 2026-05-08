import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTrueblocksClient } from './client.js'
import { TrueblocksError } from './errors.js'

const okResponse = (body: unknown = { data: [] }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

describe('createTrueblocksClient', () => {
  it('builds URLs from baseUrl + path', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse())
    const client = createTrueblocksClient({
      baseUrl: 'http://localhost:8080',
      fetch: fetchFn,
    })

    await client.status()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:8080/status')
  })

  it('strips a trailing slash from baseUrl', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse())
    const client = createTrueblocksClient({
      baseUrl: 'http://localhost:8080/',
      fetch: fetchFn,
    })

    await client.status()

    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:8080/status')
  })

  it('encodes scalar query params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse())
    const client = createTrueblocksClient({
      baseUrl: 'http://localhost:8080',
      fetch: fetchFn,
    })

    await client.blocks({ blocks: ['18000000'], hashes: true })

    const url = new URL(fetchFn.mock.calls[0][0] as string)
    expect(url.searchParams.get('hashes')).toBe('true')
    expect(url.searchParams.getAll('blocks')).toEqual(['18000000'])
  })

  it('encodes array query params with repeated keys', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse())
    const client = createTrueblocksClient({
      baseUrl: 'http://localhost:8080',
      fetch: fetchFn,
    })

    await client.blocks({ blocks: ['18000000', '18000001', '18000002'] })

    const url = new URL(fetchFn.mock.calls[0][0] as string)
    expect(url.searchParams.getAll('blocks')).toEqual([
      '18000000',
      '18000001',
      '18000002',
    ])
  })

  it('skips undefined and null query params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse())
    const client = createTrueblocksClient({
      baseUrl: 'http://localhost:8080',
      fetch: fetchFn,
    })

    await client.blocks({
      blocks: ['18000000'],
      hashes: undefined,
      chain: null as unknown as string,
    })

    const url = new URL(fetchFn.mock.calls[0][0] as string)
    expect(url.searchParams.has('hashes')).toBe(false)
    expect(url.searchParams.has('chain')).toBe(false)
  })

  it('throws TrueblocksError with HTTP status on non-OK responses', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('bad', { status: 500, statusText: 'Server Error' }),
    )
    const client = createTrueblocksClient({
      baseUrl: 'http://localhost:8080',
      fetch: fetchFn,
    })

    await expect(client.status()).rejects.toMatchObject({
      name: 'TrueblocksError',
      path: '/status',
      status: 500,
    })
  })

  it('wraps fetch network errors as TrueblocksError with cause', async () => {
    const networkErr = new Error('connection refused')
    const fetchFn = vi.fn().mockRejectedValue(networkErr)
    const client = createTrueblocksClient({
      baseUrl: 'http://localhost:8080',
      fetch: fetchFn,
    })

    const promise = client.status()
    await expect(promise).rejects.toBeInstanceOf(TrueblocksError)
    await expect(promise).rejects.toMatchObject({
      path: '/status',
      cause: networkErr,
    })
  })

  describe('without an explicit fetch', () => {
    let original: typeof globalThis.fetch | undefined
    beforeEach(() => {
      original = globalThis.fetch
    })
    afterEach(() => {
      if (original !== undefined) globalThis.fetch = original
    })

    it('falls back to globalThis.fetch', async () => {
      const stub = vi.fn().mockResolvedValue(okResponse())
      globalThis.fetch = stub as unknown as typeof globalThis.fetch

      const client = createTrueblocksClient({ baseUrl: 'http://localhost:8080' })
      await client.status()

      expect(stub).toHaveBeenCalledTimes(1)
    })
  })
})
