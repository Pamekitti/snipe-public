import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { LaunchTransactionCache } from '../io/launch-cache.js'
import { launcherAbi } from '../io/abi.js'
import { ADDRESSES } from '../core/chain.js'

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
const input = encodeFunctionData({ abi: launcherAbi, functionName: 'launchAndBuy', args: [
  { name: 'test', symbol: 'T', logo: '', description: '', socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    creatorFeeRecipient: account.address, creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics: `0x${'00'.repeat(32)}`, salt: `0x${'00'.repeat(32)}` },
  0n, ADDRESSES.ethPair, 0n, 0n, account.address, [account.address],
] })
const signed = (nonce = 0, chainId = 4663, data: Hex = input) => account.signTransaction({
  chainId, to: ADDRESSES.launcher, data, nonce, gas: 1_000_000n, gasPrice: 1n, type: 'legacy',
})

describe('launch transaction reuse', () => {
  it('never shares a stalled public lookup with a critical paid lookup', async () => {
    const cache = new LaunchTransactionCache(4663), raw = await signed(), hash = keccak256(raw)
    let finish!: (value: {}) => void
    const pending = cache.exemptions(hash, () => new Promise<{}>(r => { finish = r }), 'public')
    const paid = vi.fn(async () => ({ hash, to: ADDRESSES.launcher, input }))
    expect(await cache.exemptions(hash, paid, 'paid')).toBe(1)
    expect(paid).toHaveBeenCalledTimes(1)
    finish({}); await pending
  })
  it('uses signed feed bytes only when the log hash matches', async () => {
    const cache = new LaunchTransactionCache(4663), raw = await signed(), hash = keccak256(raw)
    cache.remember(raw, hash)
    const fetch = vi.fn()
    expect(await cache.exemptions(hash, fetch)).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(cache.stats.hits).toBe(1)
  })
  it('rejects wrong chain, altered hash and malformed calldata', async () => {
    const cache = new LaunchTransactionCache(4663)
    for (const raw of [await signed(0, 1), await signed(0, 4663, '0xf85f8e41')]) cache.remember(raw, keccak256(raw))
    const raw = await signed(); cache.remember(raw, `0x${'ff'.repeat(32)}`)
    expect(cache.stats.invalid).toBe(3)
    expect(await cache.exemptions(keccak256(raw), async () => ({ hash: keccak256(raw), to: ADDRESSES.launcher, input }))).toBe(1)
    expect(cache.stats.hits).toBe(0)
  })
  it('evicts by age and count', async () => {
    let now = 0
    const cache = new LaunchTransactionCache(4663, () => now, 1, 10)
    const a = await signed(0), b = await signed(1)
    cache.remember(a, keccak256(a)); cache.remember(b, keccak256(b))
    const missing = vi.fn(async () => ({}))
    expect(await cache.exemptions(keccak256(a), missing)).toBeNull()
    now = 10
    expect(await cache.exemptions(keccak256(b), missing)).toBeNull()
    expect(missing).toHaveBeenCalledTimes(2)
  })
  it('shares concurrent misses but never retains failure or missing results', async () => {
    const cache = new LaunchTransactionCache(4663), raw = await signed(), hash = keccak256(raw)
    let finish!: (value: {}) => void
    const fetch = vi.fn(() => new Promise<{}>(resolve => { finish = resolve }))
    const a = cache.exemptions(hash, fetch), b = cache.exemptions(hash, fetch)
    finish({}); expect(await Promise.all([a, b])).toEqual([null, null])
    expect(fetch).toHaveBeenCalledTimes(1)
    const later = vi.fn(async () => ({ hash, to: ADDRESSES.launcher, input }))
    expect(await cache.exemptions(hash, later)).toBe(1)
    cache.remember(raw, hash)
    expect(await cache.exemptions(hash, later)).toBe(1)
    expect(later).toHaveBeenCalledTimes(1)
  })
})
