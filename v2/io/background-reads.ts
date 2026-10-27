/** Cancels optional public work as soon as execution needs the paid route. */
export class BackgroundReads {
  private readonly active = new Set<AbortController>()
  private generation = 0
  constructor(private readonly eligible: () => boolean) {}
  preempt(): void { this.generation++; for (const c of this.active) c.abort(); this.active.clear() }
  async read<T>(publicRead: (signal: AbortSignal) => Promise<T>, paidRead: () => Promise<T>, onFallback?: () => void): Promise<T> {
    if (!this.eligible()) return paidRead()
    const controller = new AbortController(), generation = this.generation
    this.active.add(controller)
    const rescue = () => { try { onFallback?.() } catch {} return paidRead() }
    let cancel!: () => void
    try {
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('public observation preempted'))
        controller.signal.addEventListener('abort', cancel, { once: true })
      })
      const result = await Promise.race([publicRead(controller.signal), cancelled])
      if (generation !== this.generation || !this.eligible()) return rescue()
      return result
    } catch { return rescue() }
    finally { controller.signal.removeEventListener('abort', cancel); this.active.delete(controller) }
  }
}
