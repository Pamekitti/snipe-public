import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiModeController, apiModeFrom, recoveryOwner } from '../io/api-mode.js'
import type { State } from '../core/state.js'

const dirs: string[] = []
function fixture(mode = 'paid') {
  const dir = mkdtempSync(join(tmpdir(), 'snipe-api-')); dirs.push(dir)
  const path = join(dir, '.env'); writeFileSync(path, `MODE=live\nTRADE_SIZE_ETH=0.001\nAPI_MODE=${mode}\n`)
  return { path, controller: new ApiModeController(path, new Map([['API_MODE', mode]])),
    hooks: { eligibility: () => ({ eligible: true, reason: 'clear' }), hold: vi.fn(async (_held: boolean) => {}),
      prepare: vi.fn(async () => {}), routingChanged: vi.fn() } }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('manual API routing', () => {
  it('defaults to Paid but refuses invalid persisted selections', () => {
    expect(apiModeFrom(new Map())).toBe('paid')
    expect(() => apiModeFrom(new Map([['API_MODE', 'free']]))).toThrow('API_MODE')
  })
  it('never rescues monitoring or new entries with paid requests', async () => {
    const f = fixture('economy'), publicRead = vi.fn(async () => { throw new Error('429') }), paid = vi.fn(async () => 1)
    await expect(f.controller.request(publicRead, paid)).rejects.toThrow('429')
    expect(paid).not.toHaveBeenCalled()
  })
  it('rescues only a still-owned obligation and preserves Paid fallback', async () => {
    const f = fixture('economy'), paid = vi.fn(async () => 7)
    const failed = async () => { throw new Error('timeout') }
    expect(await f.controller.request(failed, paid, { id: 'p', valid: () => true })).toBe(7)
    await expect(f.controller.request(failed, paid, { id: 'p', valid: () => false })).rejects.toThrow('timeout')
    expect(paid).toHaveBeenCalledTimes(1)
    const p = fixture()
    expect(await p.controller.request(async () => 8, failed)).toBe(8)
  })
  it('holds entries, prepares, persists only API_MODE, then releases', async () => {
    const f = fixture()
    expect((await f.controller.change('economy', f.hooks)).code).toBe(200)
    expect(f.hooks.hold.mock.calls).toEqual([[true], [false]])
    expect(readFileSync(f.path, 'utf8')).toBe('MODE=live\nTRADE_SIZE_ETH=0.001\nAPI_MODE=economy\n')
    expect(new ApiModeController(f.path, new Map([['API_MODE', 'economy']])).mode()).toBe('economy')
  })
  it('refuses an unsafe downgrade without changing routing or holding entries', async () => {
    const f = fixture()
    f.hooks.eligibility = () => ({ eligible: false, reason: '1 open position' })
    expect((await f.controller.change('economy', f.hooks)).code).toBe(409)
    expect(f.hooks.hold).not.toHaveBeenCalled()
    expect(f.controller.mode()).toBe('paid')
  })
  it('serializes controls and STOP cancels persistence and release', async () => {
    const f = fixture(); let release!: () => void
    f.hooks.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const change = f.controller.change('economy', f.hooks)
    await vi.waitFor(() => expect(f.hooks.prepare).toHaveBeenCalled())
    expect((await f.controller.change('paid', f.hooks)).code).toBe(409)
    f.controller.cancel(); release()
    expect((await change).code).toBe(409)
    expect(f.hooks.hold.mock.calls).toEqual([[true]])
    expect(f.controller.mode()).toBe('paid')
    expect(readFileSync(f.path, 'utf8')).toContain('API_MODE=paid')
  })
  it('keeps entries held after preparation or persistence failure', async () => {
    const f = fixture()
    f.hooks.prepare.mockRejectedValueOnce(new Error('head behind'))
    expect((await f.controller.change('economy', f.hooks)).why).toContain('head behind')
    expect(f.controller.status().error).toContain('head behind')
    rmSync(f.path)
    expect((await f.controller.change('economy', f.hooks)).code).toBe(409)
    expect(f.controller.mode()).toBe('paid')
    expect(f.hooks.hold.mock.calls.every(([held]) => held)).toBe(true)
  })
  it('keeps controls serialized until the readiness release is processed', async () => {
    const f = fixture(); let release!: () => void
    f.hooks.hold.mockImplementation(async held => {
      if (!held) await new Promise<void>(resolve => { release = resolve })
    })
    const change = f.controller.change('economy', f.hooks)
    await vi.waitFor(() => expect(f.hooks.hold).toHaveBeenCalledWith(false))
    expect(f.controller.preparing()).toBe(true)
    expect((await f.controller.change('paid', f.hooks)).code).toBe(409)
    release(); expect((await change).code).toBe(200)
    expect(f.controller.preparing()).toBe(false)
  })
  it('never treats unsigned buys or arbitrary receipt hashes as rescue owners', () => {
    const s = { positions: new Map(), pendingLaunches: new Map(), inflight: new Map([
      ['b', { kind: 'buy', intentId: 'b', curve: 'c', hash: '', signedAt: 0 }],
    ]) } as unknown as State
    expect(recoveryOwner(s, 'nonce', [])).toBeNull()
    expect(recoveryOwner(s, 'curve', ['c'])).toBeNull()
    s.inflight.set('b', { kind: 'buy', intentId: 'b', curve: 'c', hash: '0xabc', signedAt: 1 } as never)
    expect(recoveryOwner(s, 'receipt', ['0xabc'])).toBe('b')
    expect(recoveryOwner(s, 'receipt', ['0xdef'])).toBeNull()
    expect(recoveryOwner(s, 'meta', ['other'])).toBeNull()
  })
})
