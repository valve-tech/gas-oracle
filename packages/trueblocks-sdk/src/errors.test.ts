import { describe, expect, it } from 'vitest'

import { TrueblocksError } from './errors.js'

describe('TrueblocksError', () => {
  it('captures path and status', () => {
    const err = new TrueblocksError('boom', { path: '/status', status: 500 })
    expect(err.message).toBe('boom')
    expect(err.path).toBe('/status')
    expect(err.status).toBe(500)
    expect(err.name).toBe('TrueblocksError')
  })

  it('omits status when not given (transport-layer failure)', () => {
    const err = new TrueblocksError('boom', { path: '/blocks' })
    expect(err.status).toBeUndefined()
  })

  it('chains cause when provided', () => {
    const root = new Error('connection refused')
    const err = new TrueblocksError('wrapped', { path: '/x', cause: root })
    expect(err.cause).toBe(root)
  })

  it('does not set cause when not given', () => {
    const err = new TrueblocksError('boom', { path: '/x' })
    expect(err.cause).toBeUndefined()
  })
})
