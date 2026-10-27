import { afterEach, expect, it, vi } from 'vitest'
import { Bot } from '../src/bot.js'
import * as store from '../src/config/store.js'

const bots: any[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const b of bots.splice(0)) { b.gate.close(); b.tel.close() }
})

it('keeps the paper collector when fresh recovery is switched off and back on', () => {
  const b: any = new Bot({ mode: 'live', dbFile: ':memory:' })
  bots.push(b)
  const cfg = { ...store.config(), venueFreshRecovery: false }
  vi.spyOn(store, 'config').mockImplementation(() => cfg)
  const collector = { configure: vi.fn(), stop: vi.fn() }
  b.shadow = collector
  b.ensureShadow()
  expect(b.shadow).toBe(collector)
  expect(collector.stop).not.toHaveBeenCalled()
  cfg.venueFreshRecovery = true
  b.ensureShadow()
  expect(b.shadow).toBe(collector)
  expect(collector.configure).toHaveBeenCalledTimes(2)
})
