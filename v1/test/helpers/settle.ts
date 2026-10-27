/**
 * Drain Telemetry's queued writes before reading them back.
 *
 * `Telemetry` batches its inserts onto a `setImmediate` rather than writing inline, so a
 * test that opens a position and immediately SELECTs it back reads the state from before
 * the write. Awaiting one macrotask lets that queue flush.
 *
 * Lives here rather than in each suite because the batching mechanism belongs to
 * src/telemetry/db.ts, not to any one test: if it ever moves to a timer or a longer
 * interval, this is the single place that has to change. Two suites had already written
 * their own identical copy, which is how the gatedb helper next door started too.
 */
export const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
