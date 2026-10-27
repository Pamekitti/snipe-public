import { expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ScenarioController, loadScenarioRelease, type ScenarioRelease } from '../src/simulation/scenario-controller.js'
import { MODEL_HASH } from '../src/simulation/identity.js'
import { CONSERVATIVE_GUARD } from '../src/strategy/scenario-guard.js'
import { SCENARIO_IDS } from '../src/strategy/execution-scenarios.js'

const release = { modelHash: MODEL_HASH, configId: 'a', policy: CONSERVATIVE_GUARD } as ScenarioRelease
const load = () => ({ release, reason: null })
const observer = (at: number, published: number): any => ({ at, policy:CONSERVATIVE_GUARD, modelHash: MODEL_HASH, configId: 'a', complete: true, failure: null, publicationAt: published,
  tapes: SCENARIO_IDS.map(id => ({ id, complete: true, outcomes: Array.from({ length: 10 }, (_, i) => ({ token: String(i), block: i, launched: 100 + i, available: published, value: .3 })) })) })
it('persists operator recovery consumption through a restart', () => {
  const db = new Database(':memory:')
  try {
    const controller = new ScenarioController(db, '', 1000, load)
    expect(controller.check(observer(1001, 1001), 'a', 1001).state).toBe('open')
    controller.pause(1002)
    const restored = new ScenarioController(db, '', 1003, load)
    expect(restored.check(observer(1003, 1001), 'a', 1003).state).toBe('shut')
    expect(restored.check(observer(1004, 1004), 'a', 1004).state).toBe('open')
    expect(restored.check(observer(1004, 1004), 'a', 17000).state).toBe('shut')
  } finally { db.close() }
})
it('blocks unverified releases, missing workers and changed configuration', () => {
  expect(loadScenarioRelease('/nonexistent/scenario-release.json').release).toBeNull()
  const db = new Database(':memory:')
  try {
    const controller = new ScenarioController(db, '', 1000, load)
    expect(controller.check(null, 'a', 1001).observerError).toBe('paper_worker_missing_or_stale')
    expect(controller.check(observer(1002, 1002), 'b', 1002).state).toBe('shut')
  } finally { db.close() }
})

it('trusts a quiet observer while the worker keeps reporting in', () => {
  const db = new Database(':memory:')
  try {
    const controller = new ScenarioController(db, '', 1000, load)
    // The observer was built a minute ago because nothing has been captured since. That is
    // the normal case now that the rebuild follows the data, and it is not a dead worker.
    expect(controller.check(observer(1001, 1001), 'a', 61_000, 60_500).observerError).toBeNull()
    // The worker itself going quiet still shuts the guard within 15s.
    expect(controller.check(observer(61_000, 1001), 'a', 61_000, 40_000).observerError).toBe('paper_worker_missing_or_stale')
    // And with no heartbeat given, the observer's own age is the fallback, as before.
    expect(controller.check(observer(1001, 1001), 'a', 61_000).observerError).toBe('paper_worker_missing_or_stale')
  } finally { db.close() }
})

/**
 * The guard decision log was the second largest writer on the box: 2,542 rows holding 42.8 MB
 * of checkpoints in 7.96 hours on 2026-09-15, 140 MB a day. 74,473 of each 76,268 byte snapshot
 * was `fingerprint`, JSON.stringify(tapes), and only the newest row's snapshot is ever read.
 */
it('keeps one guard checkpoint and still restores from it after a restart', () => {
  const db = new Database(':memory:')
  try {
    const controller = new ScenarioController(db, '', 1000, load)
    for (let i = 0; i < 5; i++) controller.check(observer(1001 + i, 1001 + i), 'a', 1001 + i)
    controller.pause(1010)
    const rows = db.prepare("SELECT id,reading,checkpoint FROM execution_guard_decisions ORDER BY id").all() as any[]
    expect(rows).toHaveLength(6)
    // Every decision is still in the history; only the last one carries the snapshot.
    expect(rows.filter(r => r.checkpoint !== '')).toHaveLength(1)
    expect(rows.at(-1)!.checkpoint).not.toBe('')
    expect(rows.map(r => r.reading === 'null')).toEqual([false, false, false, false, false, true])
    // The restore path reads the one row that has it.
    const restored = new ScenarioController(db, '', 1011, load)
    expect(restored.check(observer(1011, 1001), 'a', 1011).state).toBe('shut')
  } finally { db.close() }
})

it('drops guard decisions past eight days, a day past the dashboard lookback', () => {
  const db = new Database(':memory:')
  try {
    const now = 20 * 86_400_000
    const controller = new ScenarioController(db, '', now, load)
    controller.check(observer(now, now), 'a', now)
    db.prepare('INSERT INTO execution_guard_decisions(model,policy,at,reading,checkpoint) VALUES (?,?,?,?,?)')
      .run(MODEL_HASH, CONSERVATIVE_GUARD.id, now - 9 * 86_400_000, 'null', '')
    // The prune is hourly-gated, so it fires on the next write an hour on.
    controller.check(observer(now + 3_700_000, now), 'a', now + 3_700_000)
    const ats = (db.prepare('SELECT at FROM execution_guard_decisions ORDER BY at').all() as any[]).map(r => r.at)
    expect(ats).toEqual([now, now + 3_700_000])
  } finally { db.close() }
})

/**
 * TWO BOOKS, TWO GUARDS, ONE TABLE.
 *
 * `execution_guard_decisions` is keyed on (model, policy), and both of those are identical for
 * every book: the model hash does not depend on the band and both books run the same release
 * policy. So without the book, two controllers restore from each other's newest checkpoint,
 * and worse, each one's `trim` blanks the other's, which is the single row the constructor
 * reads. The result is a restart where neither book recovers its own guard state and both
 * silently start from scratch, which on a live wallet means a paused book reopening itself.
 */
it('keeps each book guard state separate across a restart', () => {
  const db = new Database(':memory:')
  try {
    const untaxed = new ScenarioController(db, '', 1000, load, 'untaxed')
    const taxed = new ScenarioController(db, '', 1000, load, 'taxed')
    // both open, then pause ONE of them
    expect(untaxed.check(observer(1001, 1001), 'a', 1001).state).toBe('open')
    expect(taxed.check(observer(1001, 1001), 'a', 1001).state).toBe('open')
    untaxed.pause(1002)
    // taxed writes after the pause, which is what used to blank untaxed's checkpoint
    expect(taxed.check(observer(1003, 1003), 'a', 1003).state).toBe('open')

    const untaxedAgain = new ScenarioController(db, '', 1004, load, 'untaxed')
    const taxedAgain = new ScenarioController(db, '', 1004, load, 'taxed')
    // the paused book is STILL paused after a restart
    expect(untaxedAgain.check(observer(1004, 1001), 'a', 1004).state).toBe('shut')
    // and the other book is unaffected by its neighbour's pause
    expect(taxedAgain.check(observer(1004, 1004), 'a', 1004).state).toBe('open')

    // each book kept a live checkpoint of its own, rather than one surviving between them
    const live = db.prepare("SELECT COALESCE(book,'main') book, count(*) n FROM execution_guard_decisions WHERE checkpoint<>'' GROUP BY 1 ORDER BY 1").all()
    expect(live).toEqual([{ book: 'taxed', n: 1 }, { book: 'untaxed', n: 1 }])
  } finally { db.close() }
})

it('an existing single-book table keeps working, with old rows reading as main', () => {
  const db = new Database(':memory:')
  try {
    // rows written before the column existed
    db.exec('CREATE TABLE execution_guard_decisions(id INTEGER PRIMARY KEY AUTOINCREMENT,model TEXT,policy TEXT,at INTEGER,reading TEXT,checkpoint TEXT)')
    const before = new ScenarioController(db, '', 1000, load)
    expect(before.check(observer(1001, 1001), 'a', 1001).state).toBe('open')
    before.pause(1002)
    // the default book is 'main', so an unnamed controller recovers exactly as it always did
    const after = new ScenarioController(db, '', 1003, load)
    expect(after.check(observer(1003, 1001), 'a', 1003).state).toBe('shut')
  } finally { db.close() }
})
