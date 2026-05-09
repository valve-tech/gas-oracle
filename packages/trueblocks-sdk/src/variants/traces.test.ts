import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from '../client.js'
import { makeTracesVerb } from './traces.js'

describe('makeTracesVerb', () => {
  it('base call forwards /traces request unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const traces = makeTracesVerb(request as unknown as RequestFn)

    await traces({ transactions: ['18000000.1'] })

    expect(request).toHaveBeenCalledWith('/traces', {
      transactions: ['18000000.1'],
    })
  })

  it('count variant sets count=true', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const traces = makeTracesVerb(request as unknown as RequestFn)

    await traces.count({ transactions: ['18000000.1'] })

    expect(request).toHaveBeenCalledWith('/traces', {
      transactions: ['18000000.1'],
      count: true,
    })
  })
})
