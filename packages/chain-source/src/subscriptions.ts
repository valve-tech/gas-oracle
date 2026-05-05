/**
 * Hand-rolled typed pub/sub primitive. Browser/mobile-safe — does **not**
 * import Node's `events` module, which would tie this package to a Node
 * runtime and break browser / React Native / edge bundles. The primitive
 * is small enough that the size cost is negligible compared to the
 * portability win.
 *
 * Posture matches `oracle.subscribe` in `@valve-tech/gas-oracle`:
 *
 * - Per-subscriber throws are **swallowed**. A bad consumer cannot take
 *   down the others — emit always reaches every subscriber that was
 *   registered when the emit started.
 * - The set fanned out for an `emit` call is the snapshot taken at the
 *   start of the call. Subscribers added during the in-flight emit are
 *   ignored for that emit and join the set for the next one. This is
 *   the only safe iteration order — mutating the underlying set
 *   mid-iteration would require defensive cloning that is more
 *   expensive than always cloning once.
 * - Unsubscribe handles are idempotent: calling the returned unsub
 *   function twice is a no-op the second time.
 * - Re-subscribing the same callback reference is a no-op (the backing
 *   set deduplicates by reference). Callers that want "deliver twice"
 *   register two distinct closures.
 */
export class Subscriptions<E> {
  private subscribers = new Set<(event: E) => void>()

  /**
   * Deliver `event` to every subscriber registered at the moment this
   * call started. Per-subscriber throws are swallowed; a single bad
   * consumer cannot affect delivery to the others.
   */
  emit(event: E): void {
    // Snapshot before iteration so a subscriber can't mutate the
    // delivery set mid-fanout (e.g. by subscribing a new callback or
    // unsubscribing a later one). The cost is one Set copy per emit;
    // the alternative (iterating the live set) silently changes
    // delivery semantics in subtle ways.
    const snapshot = Array.from(this.subscribers)
    for (const cb of snapshot) {
      try {
        cb(event)
      } catch {
        /* swallow per-subscriber errors */
      }
    }
  }

  /**
   * Register `cb` for future emits. Returns an idempotent unsubscribe
   * function — calling it once removes the callback; calling it again
   * is a no-op.
   */
  subscribe(cb: (event: E) => void): () => void {
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }

  /** Number of currently-registered subscribers. */
  size(): number {
    return this.subscribers.size
  }
}
