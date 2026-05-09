import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from '../client.js'
import { makeBlocksVerb } from './blocks.js'

describe('makeBlocksVerb', () => {
  it('base call forwards the polymorphic /blocks request unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const blocks = makeBlocksVerb(request as unknown as RequestFn)

    await blocks({ blocks: ['18000000'] })

    expect(request).toHaveBeenCalledWith('/blocks', { blocks: ['18000000'] })
  })

  // Each variant maps a flag → a narrowed return type. The runtime
  // assertion is that the variant adds the correct flag to the
  // outgoing query; the type assertion is enforced at compile time.
  const variantCases: Array<
    [keyof ReturnType<typeof makeBlocksVerb>, string]
  > = [
    ['hashes', 'hashes'],
    ['uncles', 'uncles'],
    ['traces', 'traces'],
    ['uniq', 'uniq'],
    ['logs', 'logs'],
    ['withdrawals', 'withdrawals'],
    ['count', 'count'],
  ]

  it.each(variantCases)(
    '%s variant sets %s=true on the outgoing request',
    async (variantName, expectedFlag) => {
      const request = vi.fn().mockResolvedValue({ data: [] })
      const blocks = makeBlocksVerb(request as unknown as RequestFn)

      const fn = blocks[variantName] as (q: {
        blocks: string[]
      }) => Promise<unknown>
      await fn({ blocks: ['18000000'] })

      expect(request).toHaveBeenCalledWith('/blocks', {
        blocks: ['18000000'],
        [expectedFlag]: true,
      })
    },
  )

  it('variants merge caller-supplied flags alongside the variant flag', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const blocks = makeBlocksVerb(request as unknown as RequestFn)

    await blocks.logs({ blocks: ['18000000'], chain: 'mainnet' })

    expect(request).toHaveBeenCalledWith('/blocks', {
      blocks: ['18000000'],
      chain: 'mainnet',
      logs: true,
    })
  })

  it('exposes exactly the seven Go-SDK-aligned variants', () => {
    const blocks = makeBlocksVerb(
      vi.fn().mockResolvedValue({}) as unknown as RequestFn,
    )
    const ownVariants = Object.keys(blocks).sort()
    expect(ownVariants).toEqual(
      ['count', 'hashes', 'logs', 'traces', 'uncles', 'uniq', 'withdrawals'],
    )
  })
})
