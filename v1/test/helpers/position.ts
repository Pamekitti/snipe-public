/**
 * The standard open position used by the exit-rule suites.
 *
 * entryMarkWei is 100 so a mark reads directly as a percentage of entry: 125 is the take
 * profit at 1.25, 103 is the dead-coin bar at 1.03, 50 is the hard stop. That is the whole
 * reason the number is 100 rather than something realistic, and it is why every assertion
 * in those files is readable without arithmetic.
 *
 * Shared because strategy.test.ts and deadcoin.test.ts had byte-identical copies of it, and
 * they exercise the SAME function (`evaluate`) against the same rule set — so a change to
 * the position shape has to reach both or one suite quietly tests a stale fixture.
 *
 * Overridable per test: pass a partial to vary one field without restating the rest.
 */
import { newPosition } from '../../src/strategy/exit.js'

type Args = Parameters<typeof newPosition>[0]

export const mkPosition = (over: Partial<Args> = {}) =>
  newPosition({
    id: 1,
    token: '0xt',
    curve: '0xc',
    tokens: 1000n,
    spendWei: 100n,
    entryMarkWei: 100n,
    openedAt: 0,
    takeProfitMultiple: 1.25,
    buyHash: '0xbuy',
    filled: true,
    ...over,
  })
