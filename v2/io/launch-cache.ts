import { decodeFunctionData, keccak256, parseTransaction, type Hex } from 'viem'
import { ADDRESSES, SELECTORS } from '../core/chain.js'
import { launcherAbi } from './abi.js'

export function decodeExemptions(input: Hex): number | null {
  try {
    if (input.slice(0, 10).toLowerCase() !== SELECTORS.launchAndBuy) return null
    const decoded = decodeFunctionData({ abi: launcherAbi, data: input })
    const exemptions = (decoded.args as readonly unknown[])[6]
    return Array.isArray(exemptions) ? exemptions.length : null
  } catch { return null }
}

/** Unconfirmed bytes are useful only after an authoritative log names their hash. */
export class LaunchTransactionCache {
  private readonly rows = new Map<string, { input: Hex; at: number }>()
  private readonly pending = new Map<string, Promise<number | null>>()
  readonly stats = { hits: 0, misses: 0, invalid: 0, shared: 0, network: 0, compared: 0, mismatches: 0 }
  constructor(private readonly chain: number, private readonly now = Date.now,
    private readonly capacity = 10_000, private readonly ttlMs = 30 * 60_000) {}

  remember(raw: Hex, claimedHash: string): void {
    try {
      const tx = parseTransaction(raw)
      if (tx.to?.toLowerCase() !== ADDRESSES.launcher) return
      if (Number(tx.chainId) !== this.chain || keccak256(raw).toLowerCase() !== claimedHash.toLowerCase()
        || !tx.r || !tx.s || !tx.data || decodeExemptions(tx.data) === null) {
        this.stats.invalid++; return
      }
      this.prune()
      this.rows.set(this.key(claimedHash), { input: tx.data, at: this.now() })
      while (this.rows.size > this.capacity) this.rows.delete(this.rows.keys().next().value!)
    } catch { this.stats.invalid++ }
  }

  /** Compare without fetching or supplying an answer to trading. */
  compare(hash: string, expected: number | null): void {
    this.prune()
    const row = this.rows.get(this.key(hash))
    if (!row || expected === null) return
    this.stats.compared++
    if (decodeExemptions(row.input) !== expected) this.stats.mismatches++
  }

  async exemptions(hash: string, fetchTransaction: () => Promise<{ hash?: string; to?: string | null; input?: Hex }>, route = 'paid'): Promise<number | null> {
    this.prune()
    const key = this.key(hash), cached = this.rows.get(key)
    if (cached && this.stats.mismatches === 0) { this.stats.hits++; return decodeExemptions(cached.input) }
    this.stats.misses++
    const pendingKey = `${key}:${route}`
    const shared = this.pending.get(pendingKey)
    if (shared) { this.stats.shared++; return shared }
    const work = (async () => {
      this.stats.network++
      try {
        const tx = await fetchTransaction()
        if (tx.hash?.toLowerCase() !== hash.toLowerCase() || tx.to?.toLowerCase() !== ADDRESSES.launcher || !tx.input) return null
        return decodeExemptions(tx.input)
      } catch { return null }
    })()
    this.pending.set(pendingKey, work)
    try { return await work } finally { if (this.pending.get(pendingKey) === work) this.pending.delete(pendingKey) }
  }

  private key(hash: string): string { return `${this.chain}:${hash.toLowerCase()}` }
  private prune(): void {
    for (const [key, row] of this.rows) if (this.now() - row.at >= this.ttlMs) this.rows.delete(key)
  }
}
