/**
 * The exempt-wallet count, which is the number that decides whether this bot trades at all.
 *
 * WHAT WAS WRONG. `io/world.ts` returned `exemptions: null` unconditionally, under a comment
 * claiming it was read from the chain. `launcherAbi` had been ported into `io/abi.ts` complete
 * with `snipeTaxExemptions` and was imported by nothing. `admits` reads a null as zero and
 * refuses, so every launch was refused for as long as the process ran: 927 `entry-exempt`
 * refusals in the three hours after the 2026-09-16 cutover, against v1's 101 buys a day.
 *
 * WHY A REAL MAINNET FIXTURE. A round trip through `encodeFunctionData` and back cannot catch
 * a wrong ABI, because it would be wrong in both directions and agree with itself. The first
 * test below is the calldata of an actual launch, with the count read off the actual chain.
 * `tools/exempt-dryrun.ts` is the wider check: 23 of 40 real launches decoded, 13% of the
 * sample had three or more, against the 16% v1 independently recorded.
 */
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Hex } from 'viem'
import { exemptCount } from '../io/world.js'
import { launcherAbi } from '../io/abi.js'
import { buildGradTx, FACTORY, factoryGraduationAbi } from '../io/graduated.js'

/**
 * Robinhood Chain mainnet, tx 0x04cb68d8ca2e34972fafc73f6985158ee0bdef2709f4f47615855ba35ede0911.
 * A launch of "Fearless Of Missing Out" carrying exactly three snipe-tax-exempt wallets.
 */
const REAL_LAUNCH: Hex = '0xf85f8e4100000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002c68af0bb1400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d9cbc515cbcb8b2f11d7394e0cf67e819f840b4800000000000000000000000000000000000000000000000000000000000004800000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000260000000000000000000000000d9cbc515cbcb8b2f11d7394e0cf67e819f840b4800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca793cd39cdd3db0868fae9afe7487f385902cfbcf6fba239dda32792770227767c0000000000000000000000000000000000000000000000000000000000000017466561726c657373204f66204d697373696e67204f75740000000000000000000000000000000000000000000000000000000000000000000000000000000004464f4d4f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003b6261666b726569687a346e7a346e61743434787a7268376b6b796c64367734713377366b627061777772716d686b34696479686666677169646d3400000000000000000000000000000000000000000000000000000000000000000000000017466561726c657373204f66204d697373696e67204f757400000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000007784e766c1faada15307663a5ac1c50a7616169e000000000000000000000000108bfecaba27d9c483a617c59d92c66b478e9903000000000000000000000000f6e1f5ee7c483de8779b1147723316fca6bda546'

const HASH = '0xdeadbeef' as Hex

/** A client that answers with one transaction, or fails the way a real one fails. */
const clientOf = (input: Hex | Error) => ({
  getTransaction: async () => {
    if (input instanceof Error) throw input
    return { input }
  },
})

const encodeWith = (exempts: readonly string[]): Hex => encodeFunctionData({
  abi: launcherAbi,
  functionName: 'launchAndBuy',
  args: [
    {
      name: 'T', symbol: 'T', logo: '', description: '',
      socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
      creatorFeeRecipient: '0x0000000000000000000000000000000000000001',
      creatorTaxBps: 0, buybackEnabled: false,
      expectedEconomics: `0x${'00'.repeat(32)}`, salt: `0x${'00'.repeat(32)}`,
    },
    0n, '0x0000000000000000000000000000000000000002', 0n, 0n,
    '0x0000000000000000000000000000000000000003',
    exempts,
  ] as never,
})

describe('the graduated transaction the driver signs', () => {
  it('is the factory graduate call, not a curve sell', () => {
    const token = '0x000000000000000000000000000000000000aaaa'
    const tx = buildGradTx({
      step: 'prepare-graduate', token, pool: null, amountWei: 0n, deadline: 0, nonce: 7,
    })
    expect(tx.to.toLowerCase()).toBe(FACTORY)
    expect(tx.data).toBe(encodeFunctionData({ abi: factoryGraduationAbi, functionName: 'graduate', args: [token] }))
    expect(tx.gas).toBe(2_500_000n)
    expect(tx.value).toBe(0n)
  })
})

describe('the exempt-wallet count', () => {
  it('reads three off a real mainnet launch', async () => {
    expect(await exemptCount(clientOf(REAL_LAUNCH) as never, HASH)).toBe(3)
  })

  it('reads zero as zero, because none registered is an answer and not an absence', async () => {
    // This is the distinction the whole fix rests on. Zero means the creator registered
    // nobody, which is a fact about the launch and a reason to refuse it. Null means we could
    // not find out. Both refuse under a floor of three, but only one of them is knowledge.
    expect(await exemptCount(clientOf(encodeWith([])) as never, HASH)).toBe(0)
  })

  it('counts every wallet in the bundle, not just the first', async () => {
    const five = ['0x1', '0x2', '0x3', '0x4', '0x5'].map((s) => `0x${s.slice(2).padStart(40, '0')}`)
    expect(await exemptCount(clientOf(encodeWith(five)) as never, HASH)).toBe(5)
  })

  it('says unknown for a launch that came through some other contract', async () => {
    /**
     * 17 of 40 recent launches did NOT go through `launchAndBuy` on the known launcher: they
     * came via three other routers (`0xa72101af`, `0xf955751f`, `0x725bfe34`). Their exempt
     * list is not in the top-level calldata, so it is genuinely unknown and the launch is
     * refused rather than guessed at. Buying those needs a separate piece of work.
     */
    expect(await exemptCount(clientOf('0xa72101af0000' as Hex) as never, HASH)).toBeNull()
  })

  it('says unknown when the read fails, and never throws', async () => {
    // A throw here would fail the WHOLE meta read, which drops the launch into `screen-meta`
    // and stops it being observed as well as traded. Losing the observation loses the sensor
    // that would tell us the filter had stopped working.
    await expect(exemptCount(clientOf(new Error('http 429')) as never, HASH)).resolves.toBeNull()
  })

  it('does not call the chain at all when there is no launch transaction', async () => {
    let called = false
    const spy = { getTransaction: async () => { called = true; return { input: REAL_LAUNCH } } }
    expect(await exemptCount(spy as never, '' as Hex)).toBeNull()
    expect(called).toBe(false)
  })
})
