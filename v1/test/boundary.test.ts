/**
 * The second-boundary predictability meter (bot.noteSecondBoundary). Pure arithmetic on
 * feed frame stamps and wall-clock arrival: the first frame of second N+1 is expected at
 * (first frame of second N) + 1000ms, and the error is what a predictive buy send would
 * carry. Research 2026-09-06, item 3; no policy reads it.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/bot.js'

describe('second boundary prediction', () => {
  it('measures first-frame-to-first-frame error, ignores frames within a second, and skips gaps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bnd-'))
    const bot = new Bot({ mode: 'observe', dbFile: join(dir, 'bot.db') } as any)
    try {
      const note = (sec: number, at: number) => (bot as any).noteSecondBoundary(sec, at)
      // a reconnect replays the backlog in a burst: seconds 90..99 arrive 40ms apart inside
      // the 30s warm-up and must not be counted
      ;(bot as any).feedWarmUntil = 9_500
      for (let i = 0; i < 10; i++) note(90 + i, 9_000 + i * 40)
      expect(bot.boundaryPrediction().n).toBe(0)
      note(100, 10_000)          // first frame of second 100 at t=10.000s
      note(100, 10_120)          // more frames in the same second: ignored
      note(100, 10_870)
      note(101, 11_040)          // second 101 arrives 40ms late against the prediction
      note(101, 11_300)
      note(102, 11_980)          // 60ms early against 11_040 + 1000
      note(104, 14_000)          // a skipped second: no sample, but the clock re-anchors
      note(105, 15_010)          // 10ms late against 14_000 + 1000
      const p = bot.boundaryPrediction()
      expect(p.n).toBe(3)
      expect(p.p50).toBe(10)
      expect(p.absP90).toBe(60)
      expect(bot.boundaryPrediction().p90).toBe(40)
    } finally {
      bot.tel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
