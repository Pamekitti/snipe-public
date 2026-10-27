import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SimulationStore } from '../src/simulation/store.js'
import { Telemetry } from '../src/telemetry/db.js'

/**
 * Every query a timer issues must name the index that serves it.
 *
 * On 2026-09-13 the paper report ran `WHERE kind='opportunity' AND at<=? ORDER BY at` on a
 * five-second timer. SQLite picked `capture_chronology(at,session,sequence)`, which carries
 * neither `kind` nor `payload`, and walked all 417,464 rows fetching each one to test a
 * column the index did not hold. It took 43,668 ms to return 785 rows, ran back to back for
 * seven hours, and starved the trading process until the dashboard stopped answering.
 *
 * The plan for that query read `SEARCH captures USING INDEX capture_chronology (at<?)`. It
 * was a SEARCH, not a SCAN. So asserting "no SCAN" would have passed: these assertions name
 * the index AND the leading equality column, because the leading column is the whole
 * difference between a lookup and a table walk wearing a lookup's name.
 *
 * Fixtures are empty on purpose. The planner chooses from the schema, and an empty table is
 * the worst case for a wrong choice, not the best.
 */
const plan = (db: any, sql: string, params: unknown[] = []) =>
  db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((r: any) => r.detail).join(' | ')

/** The SQL must still be the SQL the source runs; otherwise this file pins a museum piece. */
const inSource = (file: string, fragment: string) =>
  expect(readFileSync(file, 'utf8').includes(fragment), `${file} no longer contains: ${fragment}`).toBe(true)

it('serves every capture query the workers run from an index that carries its filter', () => {
  const store = new SimulationStore(':memory:')
  try {
    const db = store.db

    const opportunities = "SELECT session,sequence,at,key,payload FROM captures WHERE kind='opportunity' AND at<=? ORDER BY at,session,sequence"
    inSource('src/simulation/reporting.ts', opportunities)
    expect(plan(db, opportunities, [1])).toMatch(/SEARCH captures USING INDEX capture_kind \(kind=\? AND at<\?\)/)

    const controls = "SELECT session,sequence,at,payload FROM captures WHERE kind='control' AND at>=? AND at<=? ORDER BY at,session,sequence"
    inSource('src/simulation/reporting.ts', controls)
    expect(plan(db, controls, [1, 2])).toMatch(/SEARCH captures USING INDEX capture_kind \(kind=\? AND at>\? AND at<\?\)/)

    const arrivals = "SELECT payload FROM captures WHERE kind='curve-arrivals' AND key=? AND at>=? AND at<=? ORDER BY at LIMIT 1"
    inSource('src/simulation/processor.ts', arrivals)
    expect(plan(db, arrivals, ['0xcurve', 1, 2])).toMatch(/SEARCH captures USING INDEX capture_key \(key=\? AND kind=\? AND at>\? AND at<\?\)/)

    const job = `SELECT c.session,c.sequence,c.at,c.key,c.payload,j.attempts FROM processing_jobs j
      JOIN captures c ON c.session=j.session AND c.sequence=j.sequence
      WHERE j.model=? AND j.status IN ('pending','retry') AND j.retry_at<=? AND c.at<?
      ORDER BY CASE WHEN c.at>=? THEN 0 ELSE 1 END,CASE WHEN j.status='pending' THEN 0 ELSE 1 END,j.retry_at,c.at,j.id LIMIT 1`
    inSource('src/simulation/store.ts', job)
    const jobPlan = plan(db, job, ['h', 1, 2, 3])
    expect(jobPlan).toMatch(/SEARCH j USING INDEX processing_ready/)
    expect(jobPlan).toMatch(/SEARCH c USING INDEX sqlite_autoindex_captures_1/)
    expect(jobPlan).not.toMatch(/SCAN c\b/)

    // The index that caused the outage must not come back, under any name.
    const plans = [plan(db, opportunities, [1]), plan(db, controls, [1, 2]), plan(db, arrivals, ['0xcurve', 1, 2])]
    for (const p of plans) expect(p).not.toMatch(/capture_chronology/)
    for (const p of plans) expect(p).not.toMatch(/SCAN captures/)
  } finally { store.close() }
})

it('serves the dashboard aggregates that run on every poll', () => {
  const tel = new Telemetry(':memory:')
  try {
    const db = tel.raw()

    const exits = "SELECT COUNT(*) n FROM health WHERE component='exit' AND ok=0 AND at >= ?"
    inSource('src/telemetry/dashboard.ts', exits)
    expect(plan(db, exits, [1])).toMatch(/SEARCH health USING (COVERING )?INDEX idx_health_component \(component=\? AND at>\?\)/)

    // Repointed 2026-09-15 from reporting.ts, whose copy fed `intervalOutcomes`, a report field
    // with no reader anywhere. This one runs on every dashboard poll.
    const launches = `SELECT CAST(detected_at / ? AS INTEGER) * ? AS t, COUNT(*) total, COALESCE(SUM(passed),0) passed
    FROM launches WHERE detected_at>=? AND detected_at<=? GROUP BY t ORDER BY t`
    inSource('src/telemetry/dashboard-policy.ts', launches)
    const launchPlan = plan(db, launches, [1, 1, 1, 2])
    expect(launchPlan).toMatch(/SEARCH launches USING INDEX idx_launches_detected \(detected_at>\? AND detected_at<\?\)/)
    expect(launchPlan).not.toMatch(/SCAN launches/)
  } finally { tel.raw().close() }
})
