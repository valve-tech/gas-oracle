import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from './client.js'
import { createVerbs, makeVerb, type Verbs } from './verbs.js'

describe('makeVerb', () => {
  it('forwards path and query through to request', async () => {
    const request = vi.fn().mockResolvedValue({ data: ['ok'] })
    const verb = makeVerb(request as unknown as RequestFn, '/blocks')

    await verb({ blocks: ['18000000'] })

    expect(request).toHaveBeenCalledWith('/blocks', { blocks: ['18000000'] })
  })

  it('passes undefined for query when caller omits it', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const verb = makeVerb(request as unknown as RequestFn, '/status')

    await verb()

    expect(request).toHaveBeenCalledWith('/status', undefined)
  })

  it('returns the request response verbatim', async () => {
    const payload = { data: [{ ok: true }] }
    const request = vi.fn().mockResolvedValue(payload)
    const verb = makeVerb(request as unknown as RequestFn, '/abis')

    const result = await verb()

    expect(result).toBe(payload)
  })
})

describe('createVerbs — coverage of every chifra endpoint', () => {
  // Each entry: [method name on the verb surface, expected path, sample query].
  // The sample query exercises each verb with at least one parameter so the
  // request-forwarding path is hit for every endpoint.
  const verbCases: Array<[keyof Verbs, string, Record<string, unknown>]> = [
    ['list', '/list', { addrs: ['0x1234567890123456789012345678901234567890'] }],
    ['export', '/export', { addrs: ['0x1234567890123456789012345678901234567890'] }],
    ['monitors', '/monitors', { addrs: ['0x1234567890123456789012345678901234567890'] }],
    ['names', '/names', { terms: ['vitalik'] }],
    ['abis', '/abis', { addrs: ['0x1234567890123456789012345678901234567890'] }],
    ['blocks', '/blocks', { blocks: ['18000000'] }],
    ['transactions', '/transactions', { transactions: ['18000000.1'] }],
    ['receipts', '/receipts', { transactions: ['18000000.1'] }],
    ['logs', '/logs', { transactions: ['18000000.1'] }],
    ['traces', '/traces', { transactions: ['18000000.1'] }],
    ['when', '/when', { blocks: ['london'] }],
    ['state', '/state', { addrs: ['0x1234567890123456789012345678901234567890'] }],
    ['tokens', '/tokens', { addrs: ['0x1234567890123456789012345678901234567890'], blocks: ['18000000'] }],
    ['config', '/config', { mode: 'show' }],
    ['status', '/status', { modes: ['index'] }],
    ['chunks', '/chunks', { mode: 'manifest' }],
    ['init', '/init', { all: true }],
    ['slurp', '/slurp', { addrs: ['0x1234567890123456789012345678901234567890'] }],
  ]

  it.each(verbCases)(
    '%s → %s forwards path and query',
    async (verbName, expectedPath, sampleQuery) => {
      const request = vi.fn().mockResolvedValue({ data: [] })
      const verbs = createVerbs(request as unknown as RequestFn)

      const fn = verbs[verbName] as (q: unknown) => Promise<unknown>
      await fn(sampleQuery)

      expect(request).toHaveBeenCalledWith(expectedPath, sampleQuery)
    },
  )

  it('exposes exactly 18 verbs (one per OpenAPI endpoint)', () => {
    const verbs = createVerbs(
      vi.fn().mockResolvedValue({}) as unknown as RequestFn,
    )
    expect(Object.keys(verbs).sort()).toEqual(
      verbCases.map(([name]) => name).sort(),
    )
  })
})
