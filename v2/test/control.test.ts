import { describe, expect, it } from 'vitest'
import { bookSizeAction, controlAction, operatorHaltKind } from '../io/control.js'
import type { FrozenConfig, Switches } from '../core/config.js'

const st = (over: Partial<{
  stopped: boolean; haltKind: string | null; open: number; drawdownWei: bigint; broken: boolean
  book: string | null; bookStopped: boolean
}> = {}) => ({
  stopped: false, haltKind: null as string | null, open: 0, drawdownWei: 0n, broken: false, ...over,
})

describe('controlAction', () => {
  it('stops a running bot and is a no-op when already stopped', () => {
    expect(controlAction('stop', st())).toMatchObject({ do: 'stop', code: 200 })
    expect(controlAction('stop', st({ stopped: true, haltKind: 'stopped' }))).toMatchObject({ do: 'nothing', code: 200 })
  })

  it('starts only an operator stop, and names the stickier halt that is holding', () => {
    expect(controlAction('start', st({ stopped: true, haltKind: 'stopped' }))).toMatchObject({ do: 'start', code: 200 })
    expect(controlAction('start', st())).toMatchObject({ do: 'nothing', code: 200 })
    expect(controlAction('start', st({ stopped: true, haltKind: 'broken' }))).toMatchObject({ do: 'nothing', code: 409 })
  })

  it('resets drawdown only while flat, and not over a halt the operator does not own', () => {
    expect(controlAction('reset', st({ drawdownWei: 1n }))).toMatchObject({ do: 'reset', code: 200 })
    expect(controlAction('reset', st({ open: 2, drawdownWei: 1n }))).toMatchObject({ do: 'nothing', code: 409 })
    expect(controlAction('reset', st({ haltKind: 'broken', drawdownWei: 1n }))).toMatchObject({ do: 'nothing', code: 409 })
    expect(controlAction('wipe', st())).toMatchObject({ do: 'nothing', code: 400 })
  })

  it('stops, starts and resets one book without touching STOP ALL', () => {
    const taxed = { book: 'taxed', bookStopped: false, drawdownWei: 1n }
    expect(controlAction('stop', st(taxed))).toMatchObject({ do: 'stop', code: 200 })
    expect(controlAction('stop', st({ ...taxed, bookStopped: true }))).toMatchObject({ do: 'nothing', code: 200 })
    expect(controlAction('start', st({ ...taxed, bookStopped: true }))).toMatchObject({ do: 'start', code: 200 })
    expect(controlAction('start', st({ ...taxed, bookStopped: true, stopped: true, haltKind: 'stopped' })))
      .toMatchObject({ do: 'nothing', code: 409 })
    expect(controlAction('reset', st({ ...taxed, open: 1 }))).toMatchObject({ do: 'nothing', code: 409 })
    expect(controlAction('reset', st(taxed))).toMatchObject({ do: 'reset', code: 200 })
  })

  it('clears the broken halt only when there is one, and only stopped and flat', () => {
    /**
     * THE ONLY WAY THAT HALT EVER COMES OFF, and it is harder than `start` on purpose. The
     * venue pause and the cash-drawdown halt share one reopen (8 fresh above +1), because
     * both answer a market that reverses on its own. This one answers us, and a bug does
     * not reverse: lifting it is a claim that somebody found it.
     */
    const halted = { stopped: true, haltKind: 'broken', broken: true }
    expect(controlAction('clear-broken', st(halted))).toMatchObject({ do: 'clear-broken', code: 200 })
    expect(controlAction('clear-broken', st({ ...halted, open: 1 }))).toMatchObject({ do: 'nothing', code: 409 })
    expect(controlAction('clear-broken', st({ broken: true }))).toMatchObject({ do: 'nothing', code: 409 })
    expect(controlAction('clear-broken', st({ stopped: true, haltKind: 'stopped' }))).toMatchObject({ do: 'nothing', code: 200 })
  })

  it('does not let START lift a broken halt, however stopped the bot is', () => {
    // The regression this pair of actions exists to prevent: one button that turns entries back on
    // must not also forgive the measurement that says the bot is mispricing.
    expect(controlAction('start', st({ stopped: true, haltKind: 'broken', broken: true })))
      .toMatchObject({ do: 'nothing', code: 409 })
  })

  it('reconciles exhausted positions only while operator-stopped', () => {
    expect(controlAction('reconcile-empty', st({ open: 5 }))).toMatchObject({ do: 'nothing', code: 409 })
    expect(controlAction('reconcile-empty', st({ stopped: true, haltKind: 'stopped', open: 5 })))
      .toMatchObject({ do: 'reconcile-empty', code: 202 })
    expect(controlAction('reconcile-empty', st({ stopped: true, haltKind: 'stopped', open: 0 })))
      .toMatchObject({ do: 'nothing', code: 200 })
  })
})

describe('operatorHaltKind', () => {
  type Entry = readonly [string, { readonly kind: string }]
  const stopped: Entry = ['stopped', { kind: 'stopped' }]
  const venue = (book: string): Entry => [`venue:${book}`, { kind: 'venue' }]

  it('prefers a stickier halt over the operator stop', () => {
    expect(operatorHaltKind(new Map())).toBe(null)
    expect(operatorHaltKind(new Map([stopped]))).toBe('stopped')
    expect(operatorHaltKind(new Map([stopped, ['broken', { kind: 'broken' }]]))).toBe('broken')
  })

  it('does not let one book\'s venue pause veto the start button', () => {
    /**
     * 2026-09-16, and the reason this function was rewritten. `untaxed` was funded, its own
     * guard was open at +1.84, and it could not be started because `taxed` sat at -1.61.
     * `taxed` is declared with size 0: a control group that scores launches it can never buy
     * was holding the funded book out of the market.
     */
    expect(operatorHaltKind(new Map([stopped, venue('taxed')]))).toBe('stopped')
    expect(operatorHaltKind(new Map([venue('taxed'), venue('untaxed')]))).toBe(null)
  })

  it('does not let a scoped book halt veto START ALL, but still refuses a wallet-wide halt', () => {
    // START ALL deletes only `stopped`. Taxed or untaxed remains halted by its own drawdown,
    // so a scoped loss must not prevent the other book from returning to automatic operation.
    expect(operatorHaltKind(new Map([stopped, venue('taxed'), ['drawdown:untaxed', { kind: 'drawdown' }]]))).toBe('stopped')
    expect(operatorHaltKind(new Map([stopped, ['stopped:taxed', { kind: 'stopped' }]]))).toBe('stopped')
    expect(operatorHaltKind(new Map([venue('taxed'), ['manual', { kind: 'manual' }]]))).toBe('manual')
  })

  it('a start over a venue pause lifts the stop and nothing else', () => {
    // The end-to-end point. Lifting 'stopped' deletes 'stopped'; every book still meets its
    // own venue halt at canEnter, so a book whose guard is shut stays shut.
    const halts = new Map([stopped, venue('taxed')])
    expect(controlAction('start', st({ stopped: true, haltKind: operatorHaltKind(halts) })))
      .toMatchObject({ do: 'start', code: 200 })
  })

  it('a start over one book drawdown lifts STOP ALL and leaves that scoped halt to the fold', () => {
    const halts = new Map([stopped, ['drawdown:taxed', { kind: 'drawdown' }]] as const)
    expect(controlAction('start', st({ stopped: true, haltKind: operatorHaltKind(halts) })))
      .toMatchObject({ do: 'start', code: 200 })
  })
})

describe('bookSizeAction', () => {
  const config = {
    books: [
      { id: 'alpha', sizeWei: '10000000000000000' },
      { id: 'paper', sizeWei: '0' },
    ],
    risk: { maxTradeSizeWei: '20000000000000000', drawdownStakes: 2 },
  } as unknown as FrozenConfig
  const switches: Switches = {
    sizeWei: 2_500_000_000_000_000n,
    bookSizes: new Map(),
    mode: 'live', at: 10, by: 'file',
  }
  const state = { at: 20, config, switches }

  it('previews and accepts an exact decimal without using float64', () => {
    expect(bookSizeAction('preview-size', 'alpha', '0.0025', state)).toMatchObject({
      do: 'preview-size', code: 200, sizeWei: '2500000000000000',
      sizeEth: '0.0025', drawdownEth: '0.005',
    })
    expect(bookSizeAction('set-size', 'alpha', '0.001', state)).toMatchObject({
      do: 'set-size', code: 200, sizeWei: '1000000000000000', drawdownWei: '2000000000000000',
    })
  })

  it('refuses bad, tiny, oversized, unknown and unfunded requests', () => {
    expect(bookSizeAction('set-size', 'alpha', 'abc', state)).toMatchObject({ do: 'nothing', code: 400 })
    expect(bookSizeAction('set-size', 'alpha', '0.0004', state)).toMatchObject({ do: 'nothing', code: 400 })
    expect(bookSizeAction('set-size', 'alpha', '0.011', state)).toMatchObject({ do: 'nothing', code: 400 })
    expect(bookSizeAction('set-size', 'ghost', '0.001', state)).toMatchObject({ do: 'nothing', code: 400 })
    expect(bookSizeAction('set-size', 'paper', '0.001', state)).toMatchObject({ do: 'nothing', code: 400 })
  })

  it('clears only a real override and previews the current default', () => {
    expect(bookSizeAction('clear-size', 'alpha', undefined, state)).toMatchObject({ do: 'nothing', code: 200 })
    const overridden = {
      ...state,
      switches: {
        ...switches,
        bookSizes: new Map([['alpha', { sizeWei: 1_000_000_000_000_000n, at: 11, by: 'dashboard' }]]),
      },
    }
    expect(bookSizeAction('preview-default', 'alpha', undefined, overridden)).toMatchObject({
      do: 'preview-size', sizeEth: '0.0025', drawdownEth: '0.005',
    })
    expect(bookSizeAction('clear-size', 'alpha', undefined, overridden)).toMatchObject({
      do: 'clear-size', sizeWei: '2500000000000000',
    })
  })
})
