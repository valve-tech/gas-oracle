import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from '../client.js'
import { makeChunksVerb } from './chunks.js'

describe('makeChunksVerb', () => {
  it('base call forwards /chunks request unchanged (caller picks mode)', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const chunks = makeChunksVerb(request as unknown as RequestFn)

    await chunks({ mode: 'manifest' })

    expect(request).toHaveBeenCalledWith('/chunks', { mode: 'manifest' })
  })

  // Each mode variant sets `mode: <name>` on the outgoing query.
  const modeCases: Array<[keyof ReturnType<typeof makeChunksVerb>, string]> = [
    ['manifest', 'manifest'],
    ['index', 'index'],
    ['blooms', 'blooms'],
    ['pins', 'pins'],
    ['addresses', 'addresses'],
    ['appearances', 'appearances'],
    ['stats', 'stats'],
  ]

  it.each(modeCases)(
    '%s variant sets mode=%s',
    async (variantName, expectedMode) => {
      const request = vi.fn().mockResolvedValue({ data: [] })
      const chunks = makeChunksVerb(request as unknown as RequestFn)
      const fn = chunks[variantName] as (q: object) => Promise<unknown>

      await fn({})

      expect(request).toHaveBeenCalledWith('/chunks', { mode: expectedMode })
    },
  )

  // count and check are flag-modifier variants — caller still picks
  // the mode, the variant just narrows the return type.
  const flagCases: Array<['count' | 'check', 'count' | 'check']> = [
    ['count', 'count'],
    ['check', 'check'],
  ]

  it.each(flagCases)(
    '%s variant sets %s=true and forwards mode',
    async (variantName, expectedFlag) => {
      const request = vi.fn().mockResolvedValue({ data: [] })
      const chunks = makeChunksVerb(request as unknown as RequestFn)

      await chunks[variantName]({ mode: 'index' })

      expect(request).toHaveBeenCalledWith('/chunks', {
        mode: 'index',
        [expectedFlag]: true,
      })
    },
  )
})
