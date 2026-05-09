import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from '../client.js'
import { makeStateVerb } from './state.js'

describe('makeStateVerb', () => {
  it('base call forwards /state request unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const state = makeStateVerb(request as unknown as RequestFn)

    await state({ addrs: ['0xabc'] })

    expect(request).toHaveBeenCalledWith('/state', { addrs: ['0xabc'] })
  })

  it('call variant sets call=true', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const state = makeStateVerb(request as unknown as RequestFn)

    await state.call({ addrs: ['0xabc'], calldata: '0x6d4ce63c' })

    expect(request).toHaveBeenCalledWith('/state', {
      addrs: ['0xabc'],
      calldata: '0x6d4ce63c',
      call: true,
    })
  })
})
