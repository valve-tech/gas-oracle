import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from '../client.js'
import { makeSlurpVerb } from './slurp.js'

describe('makeSlurpVerb', () => {
  it('base call forwards /slurp request unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const slurp = makeSlurpVerb(request as unknown as RequestFn)

    await slurp({ addrs: ['0xabc'] })

    expect(request).toHaveBeenCalledWith('/slurp', { addrs: ['0xabc'] })
  })

  it('appearances variant sets appearances=true', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const slurp = makeSlurpVerb(request as unknown as RequestFn)

    await slurp.appearances({ addrs: ['0xabc'] })

    expect(request).toHaveBeenCalledWith('/slurp', {
      addrs: ['0xabc'],
      appearances: true,
    })
  })

  it('count variant sets appearances=true AND count=true', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const slurp = makeSlurpVerb(request as unknown as RequestFn)

    await slurp.count({ addrs: ['0xabc'] })

    expect(request).toHaveBeenCalledWith('/slurp', {
      addrs: ['0xabc'],
      appearances: true,
      count: true,
    })
  })
})
