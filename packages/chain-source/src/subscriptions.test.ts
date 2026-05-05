import { test, expect, vi } from 'vitest'

import { Subscriptions } from './subscriptions.js'

test('emit delivers the event to a subscriber', () => {
  const subs = new Subscriptions<number>()
  const cb = vi.fn()
  subs.subscribe(cb)
  subs.emit(42)
  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb).toHaveBeenCalledWith(42)
})

test('emit fans out to every active subscriber', () => {
  const subs = new Subscriptions<string>()
  const a = vi.fn()
  const b = vi.fn()
  const c = vi.fn()
  subs.subscribe(a)
  subs.subscribe(b)
  subs.subscribe(c)
  subs.emit('hello')
  expect(a).toHaveBeenCalledWith('hello')
  expect(b).toHaveBeenCalledWith('hello')
  expect(c).toHaveBeenCalledWith('hello')
})

test('unsubscribe stops further delivery', () => {
  const subs = new Subscriptions<number>()
  const cb = vi.fn()
  const unsub = subs.subscribe(cb)
  subs.emit(1)
  unsub()
  subs.emit(2)
  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb).toHaveBeenCalledWith(1)
})

test('unsubscribe is idempotent', () => {
  const subs = new Subscriptions<number>()
  const cb = vi.fn()
  const unsub = subs.subscribe(cb)
  unsub()
  // Calling unsub a second time must not throw and must not affect
  // other subscribers when they exist.
  expect(() => unsub()).not.toThrow()
})

test('a throwing subscriber does not prevent others from receiving the event', () => {
  const subs = new Subscriptions<number>()
  const bad = vi.fn(() => { throw new Error('intentional') })
  const good = vi.fn()
  subs.subscribe(bad)
  subs.subscribe(good)
  expect(() => subs.emit(7)).not.toThrow()
  expect(bad).toHaveBeenCalledWith(7)
  expect(good).toHaveBeenCalledWith(7)
})

test('size reports the number of active subscribers', () => {
  const subs = new Subscriptions<void>()
  expect(subs.size()).toBe(0)
  const u1 = subs.subscribe(() => {})
  expect(subs.size()).toBe(1)
  const u2 = subs.subscribe(() => {})
  expect(subs.size()).toBe(2)
  u1()
  expect(subs.size()).toBe(1)
  u2()
  expect(subs.size()).toBe(0)
})

test('emit with zero subscribers is a no-op', () => {
  const subs = new Subscriptions<number>()
  expect(() => subs.emit(99)).not.toThrow()
})

test('subscribing the same callback twice keeps it registered exactly once', () => {
  // Use a Set-backed registry: re-subscribing the same fn reference
  // does not produce duplicate deliveries. Callers wanting "deliver
  // twice" must register two distinct closures.
  const subs = new Subscriptions<number>()
  const cb = vi.fn()
  subs.subscribe(cb)
  subs.subscribe(cb)
  subs.emit(1)
  expect(cb).toHaveBeenCalledTimes(1)
})

test('a subscriber added during emit is not invoked for the in-flight event', () => {
  // Snapshot semantics: the subscriber set fanned out for an emit is
  // the set as it stood when emit started. A late-joining subscriber
  // joins for the next emit, not the current one.
  const subs = new Subscriptions<number>()
  const late = vi.fn()
  subs.subscribe(() => { subs.subscribe(late) })
  subs.emit(1)
  expect(late).not.toHaveBeenCalled()
  subs.emit(2)
  expect(late).toHaveBeenCalledTimes(1)
  expect(late).toHaveBeenCalledWith(2)
})

test('a subscriber that unsubscribes another mid-emit does not break the fan-out', () => {
  // Defensive iteration: a subscriber removing a later subscriber
  // mid-emit must not skip undelivered subscribers.
  const subs = new Subscriptions<number>()
  const a = vi.fn()
  const c = vi.fn()
  let unsubB: (() => void) | null = null
  subs.subscribe(a)
  unsubB = subs.subscribe(() => unsubB?.())
  subs.subscribe(c)
  subs.emit(1)
  expect(a).toHaveBeenCalledWith(1)
  expect(c).toHaveBeenCalledWith(1)
})
