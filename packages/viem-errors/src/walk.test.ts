import { describe, it, expect } from 'vitest'
import { walkErrorCause } from './walk.js'

const withCause = (message: string, cause: unknown): Error => {
  const e = new Error(message) as Error & { cause?: unknown }
  e.cause = cause
  return e
}

describe('walkErrorCause', () => {
  it('yields the error itself first, then each cause in order', () => {
    const inner = new Error('inner')
    const middle = withCause('middle', inner)
    const outer = withCause('outer', middle)

    expect([...walkErrorCause(outer)]).toEqual([outer, middle, inner])
  })

  it('stops cleanly when the cause chain ends', () => {
    const e = new Error('lonely')
    expect([...walkErrorCause(e)]).toEqual([e])
  })

  it('yields nothing for null', () => {
    expect([...walkErrorCause(null)]).toEqual([])
  })

  it('yields nothing for undefined', () => {
    expect([...walkErrorCause(undefined)]).toEqual([])
  })

  it('yields a primitive thrown value once and stops (no cause to walk)', () => {
    expect([...walkErrorCause('a string was thrown')]).toEqual(['a string was thrown'])
    expect([...walkErrorCause(42)]).toEqual([42])
  })

  it('yields plain objects with .cause (not just Error subclasses)', () => {
    const inner = { code: 'INNER' }
    const outer = { code: 'OUTER', cause: inner }
    expect([...walkErrorCause(outer)]).toEqual([outer, inner])
  })

  it('respects maxDepth, halting before chasing further causes', () => {
    const a = new Error('a')
    const b = withCause('b', a)
    const c = withCause('c', b)
    const d = withCause('d', c)

    expect([...walkErrorCause(d, { maxDepth: 2 })]).toEqual([d, c])
  })

  it('defaults maxDepth to 8 — caps a circular chain instead of looping forever', () => {
    type Loop = Error & { cause?: unknown }
    const a = new Error('cycle') as Loop
    a.cause = a // self-cycle

    const yielded = [...walkErrorCause(a)]
    expect(yielded).toHaveLength(8)
    expect(yielded.every(link => link === a)).toBe(true)
  })
})
