/**
 * Risk limits and kill switches.
 *
 * The capacity ceiling is not a preference. Simulated daily P&L peaks around 0.02 ETH a
 * trade and goes negative by 0.05, because the size that moves the curve on the way in
 * is the same size you have to sell back out. So the cap is enforced here rather than
 * left to judgement.
 */
import { STRATEGY, RISK } from '../config.js'

export type Gate = { allow: boolean; reason?: string }

/**
 * The kill switch as wei, read fresh because MAX_DRAWDOWN_ETH is hot: a value captured at
 * construction would leave the stop on whatever the file said at boot.
 */
const limitWei = (): bigint => BigInt(Math.round(RISK.maxDrawdownEth * 1e18))
const fmtEth = (wei: bigint): string => (Number(wei) / 1e18).toFixed(4)
/** display only, and only ever in a message a person reads. No stop compares dollars. */
const usd = (wei: bigint): string => `$${((Number(wei) / 1e18) * RISK.ethUsd).toFixed(0)}`

export type HaltPhase = 'running' | 'flattening' | 'idle'

/**
 * Why entries are off, because it decides whether they can come back on by themselves.
 *
 * 'gate' is the venue going quiet, measured as a touch rate. It is a statement about the
 * world, it reverses on its own, and waiting for a human to notice at 3am costs a night of
 * trading for nothing. It auto-resumes.
 *
 * 'venue' is the same claim measured in money rather than touches: the trailing window of
 * scored launches (what the bot's own exit rule WOULD have made on coins it did not have
 * to hold) has gone negative. Kept separate from 'gate' on purpose, so a touch rate
 * recovering can never lift a pause the P&L sensor placed, and the reverse.
 *
 * 'drawdown' is us losing money. SINCE 2026-09-07 it lifts itself, but on evidence and
 * under conditions nothing else has: the bot must be flat, the loss must be paid for by an
 * epoch reset (so the stop cannot re-fire on the same peak), the venue must have paid on
 * launches scored AFTER the halt (never the coins we just lost on), and at most twice in a
 * UTC day. The third one in a day is a human's decision, which is what it always was. See
 * liftOnSignal.
 *
 * 'broken' is us losing money WHILE the venue pays: the last trades' real returns sit far
 * below what the same coins replayed at. That is a bot fault, not a market, and no market
 * reading may argue with it. It never lifts itself, and a restart is the human's lift.
 * This is the guard that makes the drawdown's self-lift safe: a drawdown caused by a bug
 * trips this first, and 'broken' outranks it.
 *
 * 'stopped' is the operator pressing stop on the dashboard. It is liftable by the operator
 * pressing start, and by nobody and nothing else: no venue reading, no rollover, no file
 * edit. It is deliberately a separate kind from 'manual' so that HALT=1 in the file keeps
 * being the one-way switch it has always been, while the page gets a two-way control. It
 * ranks BELOW 'drawdown' and 'broken', so pressing start cannot argue with a real stop.
 * It survives a restart, because a stop the operator has to remember to re-apply after
 * every reboot is not a stop (chain_truth.operator_stop).
 *
 * 'manual' is HALT=1 in the file. Only a human, and only by editing the file back.
 */
export type HaltKind = 'gate' | 'venue' | 'stopped' | 'drawdown' | 'broken' | 'manual'

/**
 * Stickiest first. The ONE ordering: it decides what canEnter names, what the page shows,
 * and which kind a caller may lift.
 *
 * 'broken' sits directly under 'manual' and above 'drawdown' deliberately: when the bot is
 * mispricing, the drawdown that follows is a symptom, and its self-lift must not run while
 * the cause is still true.
 */
const HALT_RANK: readonly HaltKind[] = ['manual', 'broken', 'drawdown', 'stopped', 'gate', 'venue']

/**
 * kinds that come back without a human. 'drawdown' via liftOnSignal, which is far narrower
 * than resume(); the two venue kinds via resume(). 'stopped' is NOT here: the operator
 * lifts it, which is a person, just not a person editing a file.
 */
const SELF_LIFTING: ReadonlySet<HaltKind> = new Set<HaltKind>(['gate', 'venue', 'drawdown'])

/**
 * kinds a caller may lift by asking. Deliberately smaller than SELF_LIFTING: 'drawdown'
 * is self-lifting but NOT resume()-able, because its lift has preconditions (flat, an
 * epoch reset, post-halt evidence, a daily budget) that live in liftOnSignal and must not
 * be reachable from a venue reading alone.
 *
 * 'stopped' is here and 'manual' is not, which is the whole difference between the two:
 * the rank check in resume() still refuses while anything stickier holds, so a start press
 * cannot lift a drawdown stop, a broken halt or a file HALT=1.
 */
const CALLER_LIFTABLE: ReadonlySet<HaltKind> = new Set<HaltKind>(['gate', 'venue', 'stopped'])

/**
 * Does this kind survive a restart?
 *
 * A `Record<HaltKind, ...>` deliberately, not a Set: adding a kind without answering this
 * question is a compile error, and the question is worth a compile error. Nothing persisted
 * the halt set until 2026-09-16, so every restart silently un-halted the bot and the only
 * thing that hid it was that most kinds re-fire within 30 seconds. `drawdown` and `broken`
 * do not: they are the two that can leave a known-bad bot trading at full size in the gap.
 *
 * 'manual' is the one false. HALT=1 in .env is its own durable record, re-read on every
 * boot, and a stored copy could only disagree with it: an operator who sets HALT=0 and
 * restarts would come back halted by a row they cannot see or edit.
 */
const DURABILITY: Record<HaltKind, boolean> = {
  manual: false,
  broken: true,
  drawdown: true,
  stopped: true,
  gate: true,
  venue: true,
}

/** whether a halt of this kind is written down and re-placed at the next boot */
export const isDurable = (kind: HaltKind): boolean => DURABILITY[kind]

/** One halt, flat enough to store and compare. `at` is when it was FIRST placed. */
export type HaltRecord = { readonly kind: HaltKind; readonly reason: string; readonly at: number }

/** the drawdown stop may lift itself at most this many times in one UTC day */
const MAX_DD_LIFTS_PER_DAY = 2

const UTC_DAY_MS = 86_400_000

/** Unix time is UTC and has no leap seconds, so a UTC day is exactly 86.4e6 ms. */
export const utcDay = (ms: number): number => Math.floor(ms / UTC_DAY_MS)

/**
 * What a halted bot should be doing. Halting already blocks new entries (canEnter), so
 * the only work left is selling what we still hold.
 *
 * This used to shut the process down instead, which stranded exactly those positions:
 * the exit managers die with the process and the tokens sit in the wallet with nobody
 * selling them. The kill switch fires when nobody is watching, by definition, so the
 * bags sat until someone looked. A stranded bag costs the whole position rather than a
 * trade, so we stay up until the book is flat and then idle. (fixed 2026-08-18)
 */
export function haltPhase(halted: boolean, openPositions: number): HaltPhase {
  if (!halted) return 'running'
  return openPositions > 0 ? 'flattening' : 'idle'
}

export class RiskManager {
  openCount = 0
  deployedWei = 0n
  realizedPnlWei = 0n
  peakPnlWei = 0n
  /** TODAY's realized P&L (UTC). Separate from realizedPnlWei, which is since-epoch. */
  dayRealizedPnlWei = 0n
  private dayKey: number
  /**
   * Every halt currently placed, keyed by kind. Value is the first reason that kind gave.
   *
   * A set rather than the single slot this used to be, because two halts can be true at
   * once and the old shape forced a choice between two wrong answers. A gate shut landing
   * on top of a daily cap either RELABELLED the halt, and then the gate happily resumed us
   * into the day we had already stopped for, or was DROPPED, and then the cap lifted at
   * 00:00 UTC into a venue that had been shut for hours with nothing in the process
   * remembering it. Recording each kind independently makes neither possible: `halts` is
   * what is true, and the ranked getters below decide what is displayed.
   */
  private readonly halts = new Map<HaltKind, string>()
  /**
   * When each active kind was placed. The drawdown self-lift needs it: the evidence it
   * accepts is launches scored AFTER the stop fired, never the ones we just lost on.
   */
  private readonly haltedAt = new Map<HaltKind, number>()
  /**
   * Told whenever the halt set changes, so persistence happens in ONE place.
   *
   * There are eighteen sites in bot.ts that halt or lift, and a truthSet beside each is how
   * the four faults this rewrite exists to kill get written. The object that owns the map
   * announces the change; the caller decides what to do with it.
   */
  private onHaltsChanged: ((halts: HaltRecord[]) => void) | null = null
  /** drawdown self-lifts used today, reset by rollDay with the day's ledger */
  private ddLiftsToday = 0
  /** every token we have ever opened; one entry per token, forever */
  private everEntered = new Set<string>()

  // the clock is injected the same way RegimeGate takes one, so the UTC rollover is
  // testable without touching the system clock
  //
  // The bankroll is a FUNCTION in production, because BANKROLL_ETH is hot: config/store.ts
  // swaps the snapshot under a running bot and a value captured here would leave canEnter
  // enforcing a ceiling the dashboard had stopped displaying. That was the one field where
  // a hot reload would have failed in complete silence. Tests pass a fixed bigint, which is
  // the same thing held still.
  constructor(
    private readonly bankroll: bigint | (() => bigint),
    private readonly now: () => number = Date.now,
  ) {
    this.dayKey = utcDay(this.now())
  }

  /** the capital ceiling as it stands right now, read through on every check */
  get bankrollWei(): bigint {
    return typeof this.bankroll === 'function' ? this.bankroll() : this.bankroll
  }

  get halted(): boolean { return this.halts.size > 0 }

  get haltKind(): HaltKind | null {
    for (const k of HALT_RANK) if (this.halts.has(k)) return k
    return null
  }

  get haltReason(): string {
    const k = this.haltKind
    return k === null ? '' : this.halts.get(k)!
  }

  /** every active kind, stickiest first: for the health row and the alert line */
  get haltKinds(): HaltKind[] { return HALT_RANK.filter((k) => this.halts.has(k)) }

  haltReasonFor(kind: HaltKind): string { return this.halts.get(kind) ?? '' }

  isHalted(kind: HaltKind): boolean { return this.halts.has(kind) }

  /** when this kind was placed, or null if it is not; ms epoch */
  haltAt(kind: HaltKind): number | null { return this.haltedAt.get(kind) ?? null }

  /** every active halt, stickiest first, flat enough to store */
  haltRecords(): HaltRecord[] {
    return this.haltKinds.map((kind) => ({ kind, reason: this.halts.get(kind)!, at: this.haltedAt.get(kind)! }))
  }

  /** Subscribe to halt-set changes. One subscriber; the last one wins. */
  watchHalts(fn: (halts: HaltRecord[]) => void): void { this.onHaltsChanged = fn }

  private announce(): void { this.onHaltsChanged?.(this.haltRecords()) }

  /**
   * Re-place halts that were in force when the process last went down.
   *
   * Boot only, and it does not announce: re-writing what we just read would turn a restart
   * into an edit, and the assertion the caller makes afterwards compares the two.
   *
   * The ORIGINAL `at` is restored, not now(). The drawdown self-lift accepts only launches
   * scored after haltAt('drawdown'), so stamping the restart time would silently demand a
   * fresh window of evidence that the halt had already earned.
   *
   * Returns what it placed, so the caller can compare rather than trust.
   */
  restoreHalts(records: readonly HaltRecord[]): HaltKind[] {
    const placed: HaltKind[] = []
    for (const r of records) {
      if (!isDurable(r.kind)) continue
      if (this.halts.has(r.kind)) continue
      this.halts.set(r.kind, r.reason)
      this.haltedAt.set(r.kind, r.at)
      placed.push(r.kind)
    }
    return HALT_RANK.filter((k) => placed.includes(k))
  }

  /** drawdown self-lifts already spent today, against MAX_DD_LIFTS_PER_DAY */
  get ddLiftsUsed(): number { return this.ddLiftsToday }
  get ddLiftsLimit(): number { return MAX_DD_LIFTS_PER_DAY }

  /** Restore the durable daily budget before any stream or recovery check starts. */
  restoreDdLifts(used: number, nowMs: number = this.now()): void {
    if (!Number.isInteger(used) || used < 0 || used > MAX_DD_LIFTS_PER_DAY) {
      throw new Error('invalid persisted drawdown restart budget')
    }
    this.dayKey = utcDay(nowMs)
    this.ddLiftsToday = used
  }

  seedEntered(tokens: string[]): void {
    for (const t of tokens) this.everEntered.add(t.toLowerCase())
  }

  hasEntered(token: string): boolean {
    return this.everEntered.has(token.toLowerCase())
  }

  canEnter(args: { token: string; sizeWei: bigint; logsHealthy: boolean; logsAgeMs: number; curveDegraded?: boolean }): Gate {
    if (this.halted) return { allow: false, reason: `halted: ${this.haltReason}` }
    // the single cleanest divider between profitable and unprofitable wallets in the
    // data: winners buy a token once, losers average down into it
    if (this.hasEntered(args.token)) return { allow: false, reason: 'already entered this token' }
    if (this.openCount >= STRATEGY.maxConcurrent) return { allow: false, reason: 'concurrency cap' }
    if (args.sizeWei > BigInt(Math.round(STRATEGY.maxTradeSizeEth * 1e18))) return { allow: false, reason: 'above size ceiling' }
    if (this.deployedWei + args.sizeWei > this.bankrollWei) return { allow: false, reason: 'bankroll fully deployed' }
    if (!args.logsHealthy) return { allow: false, reason: 'authoritative stream unhealthy' }
    if (args.logsAgeMs > RISK.maxLogsStalenessMs) return { allow: false, reason: `logs stale ${args.logsAgeMs}ms` }
    if (args.curveDegraded) return { allow: false, reason: 'curve state degraded' }
    return { allow: true }
  }

  /** Reserve capacity synchronously at the gate, before any await can let a peer in. */
  reserve(token: string, sizeWei: bigint): void {
    this.everEntered.add(token.toLowerCase())
    this.openCount++
    this.deployedWei += sizeWei
  }

  /** Give back capacity reserved for an entry that never happened. */
  unreserve(sizeWei: bigint): void {
    this.openCount = Math.max(0, this.openCount - 1)
    this.deployedWei -= sizeWei
    if (this.deployedWei < 0n) this.deployedWei = 0n
  }

  /**
   * Restore the epoch's realized P&L and its running peak from the database at boot.
   * Without this both reset to zero on every restart and the drawdown kill switch
   * silently re-armed after a crash (found 2026-08-18).
   */
  seedRealized(realizedWei: bigint, peakWei: bigint): void {
    this.realizedPnlWei = realizedWei
    this.peakPnlWei = peakWei > realizedWei ? peakWei : realizedWei
    this.checkDrawdown()
  }

  /**
   * Restore TODAY's realized P&L from the database at boot.
   *
   * No stop reads this any more (the daily cap was deleted 2026-09-07: it could not lift
   * before 00:00 UTC and on 2026-09-05 would have sat out $731 of that day). It stays
   * because the dashboard's "today" and the boot log read it, and because rollDay's real
   * job, resetting the drawdown stop's self-lift budget, needs the same day key.
   */
  seedDay(dayRealizedWei: bigint, nowMs: number = this.now()): void {
    this.dayKey = utcDay(nowMs)
    this.dayRealizedPnlWei = dayRealizedWei
  }

  /** Seed both ledgers from one rebuild, so they can never be restored apart. */
  seedLedger(r: { realized: bigint; peak: bigint; day: bigint }, nowMs: number = this.now()): void {
    this.seedRealized(r.realized, r.peak)
    this.seedDay(r.day, nowMs)
  }

  /**
   * Gas paid by a sell that reverted. Charged the moment the receipt says so, not when
   * the position eventually closes, because a stuck position may never close: on
   * 2026-09-04 one burned $101 across 945 reverts while both caps read the book at +$52
   * and saw nothing. No capacity moves here; the tokens are still held.
   */
  burned(gasWei: bigint): void {
    if (gasWei <= 0n) return
    this.rollDay()
    this.realizedPnlWei -= gasWei
    this.dayRealizedPnlWei -= gasWei
    this.checkDrawdown()
  }

  /**
   * A loss that was never reserved in this process: a row recovery closed at boot. closed()
   * would also release capacity nothing had taken, and with another row resumed first that
   * let canEnter admit one position over the bankroll for as long as it was held.
   */
  book(pnlWei: bigint): void {
    this.rollDay()
    this.realizedPnlWei += pnlWei
    this.dayRealizedPnlWei += pnlWei
    this.checkDrawdown()
  }

  closed(sizeWei: bigint, pnlWei: bigint): void {
    // before the add, so a trade closing at 00:00:01 lands on the new day rather than
    // topping up the day it is no longer in
    this.rollDay()
    this.openCount = Math.max(0, this.openCount - 1)
    this.deployedWei -= sizeWei
    if (this.deployedWei < 0n) this.deployedWei = 0n
    this.realizedPnlWei += pnlWei
    this.dayRealizedPnlWei += pnlWei
    this.checkDrawdown()
  }

  /**
   * THE KILL SWITCH. Wei against wei since 2026-09-07: the limit is ETH now, and the
   * ledger always was, so the old `Number(bigint)/1e18 * ethUsd` hop on both sides is gone
   * along with the stale-price coupling it carried.
   */
  private checkDrawdown(): void {
    if (this.realizedPnlWei > this.peakPnlWei) this.peakPnlWei = this.realizedPnlWei
    const downWei = this.peakPnlWei - this.realizedPnlWei
    if (downWei >= limitWei()) {
      this.halt(`drawdown ${fmtEth(downWei)} ETH from peak (${usd(downWei)})`, 'drawdown')
    }
  }

  halt(reason: string, kind: HaltKind = 'manual'): void {
    // Every kind is recorded independently, and the first reason a kind gives wins.
    //
    // This used to be one slot guarded by a sticky rule for 'drawdown', which was the only
    // way to stop a later gate shut relabelling the kill switch into something the gate
    // could then resume. With several self-lifting kinds in the tree that shape breaks
    // down: an operator stop and a shut venue are independently true, and any single slot
    // has to drop one of them. Nothing is dropped and nothing relabels now. The ranked
    // getters decide what is DISPLAYED; this map is what is TRUE.
    //
    // First-reason-wins matters too: checkDrawdown runs on every close, so re-halting would
    // churn the string and make recordHaltState's edge trigger fire forever.
    if (this.halts.has(kind)) return
    this.halts.set(kind, reason)
    this.haltedAt.set(kind, this.now())
    this.announce()
  }

  /**
   * Lift a halt, but only one the caller placed and only when nothing stickier is holding.
   *
   * The rank check is the safety property that used to live in gateAction: an open venue
   * must not lift a bot whose drawdown stop has fired, not even for a tick. Enforcing it
   * here means it is enforced once, on the object that can see every halt, and not
   * coordinated across two modules that each know about one.
   *
   * It is also what makes the dashboard's start button safe: 'stopped' is caller-liftable,
   * but the rank check refuses the lift while 'drawdown', 'broken' or 'manual' holds, so a
   * person tapping start can only undo their own stop.
   *
   * Returns whether it actually resumed, so the caller logs a transition not a no-op.
   */
  resume(kind: HaltKind): boolean {
    if (!this.halts.has(kind)) return false
    if (!CALLER_LIFTABLE.has(kind)) return false
    if (this.haltKind !== kind) return false
    this.halts.delete(kind)
    this.haltedAt.delete(kind)
    this.announce()
    return true
  }

  /**
   * Lift the drawdown stop on evidence. NOT resume(): the preconditions are the whole
   * safety argument and they are the caller's to prove, so this is deliberately a
   * different door with a different name.
   *
   * What the caller (bot.ts checkDrawdownResume) must have established before calling:
   *   - the book is flat, in memory AND in the database, so the epoch boundary cannot
   *     split a position from its stake;
   *   - the epoch has just been reset, so realized and peak are both zero and this stop
   *     cannot immediately re-fire on the loss it just lifted for;
   *   - the venue paid over a full window of launches scored AFTER haltAt('drawdown').
   *     Post-halt only, because the newest scored launches at the moment a stop fires are
   *     usually the very coins it fired for -- on a bot fault (2026-09-06) they replay
   *     fine and would have lifted the stop straight back into the fault.
   *
   * Enforced HERE, because they are the properties of the object that can see every halt:
   *   - nothing stickier is holding. 'manual' and 'broken' outrank it, and 'broken' is
   *     exactly "we are losing while the venue pays", which is the one state where a good
   *     venue reading must not be allowed to argue;
   *   - at most MAX_DD_LIFTS_PER_DAY in a UTC day. Three stops in a day is not a dip, it
   *     is a state nobody has proven the bot should trade through, so the third behaves
   *     the way every drawdown stop did before today: it waits for a person.
   */
  liftOnSignal(kind: 'drawdown', why: string): boolean {
    if (!this.halts.has(kind)) return false
    if (this.haltKind !== kind) return false
    if (this.ddLiftsToday >= MAX_DD_LIFTS_PER_DAY) return false
    this.halts.delete(kind)
    this.haltedAt.delete(kind)
    this.ddLiftsToday++
    this.announce()
    void why
    return true
  }

  /**
   * Lift the drawdown stop because a PERSON said so. A third door, and deliberately not
   * liftOnSignal: the daily budget exists to stop the automatic rule from trading through
   * a day nobody has proven, and a budget that also blocked the operator would leave the
   * hand reset in DEPLOY.md ("a third stop in one day") impossible from the dashboard --
   * exactly the case it was written for. So no budget is checked and none is spent.
   *
   * What it still refuses is what an operator must not be able to wave away: the rank
   * check below. 'broken' and 'manual' outrank 'drawdown', and 'broken' is precisely "we
   * are losing where the venue paid", which no button should be able to argue with.
   *
   * The caller must have reset the epoch first, for the same reason liftOnSignal requires
   * it: without it the stop re-fires on the loss it just lifted for, within one trade.
   */
  liftByOperator(kind: 'drawdown', why: string): boolean {
    if (!this.halts.has(kind)) return false
    if (this.haltKind !== kind) return false
    this.halts.delete(kind)
    this.haltedAt.delete(kind)
    this.announce()
    void why
    return true
  }

  /** would liftOnSignal be refused for a reason the caller cannot see? for the log line */
  get ddLiftsExhausted(): boolean { return this.ddLiftsToday >= MAX_DD_LIFTS_PER_DAY }

  /**
   * UTC day rollover: reset the day's ledgers AND the drawdown stop's self-lift budget.
   * Returns whether the budget was actually restored, so the caller can log it.
   *
   * The daily cap used to live here and was deleted on 2026-09-07. The rollover did not go
   * with it: `ddLiftsToday` is what makes the drawdown stop lift itself at most twice a day
   * and then wait for a person, and without a rollover it would spend those two lifts and
   * never get them back for the lifetime of the process.
   *
   * POLLED, not folded into closed() alone. A halted, flat bot never closes anything, so a
   * rollover that only ran on a close would never run at all while it mattered most. It is
   * called from closed() too, so the accumulators are right between housekeeping ticks.
   */
  rollDay(nowMs: number = this.now()): boolean {
    const d = utcDay(nowMs)
    if (d === this.dayKey) return false
    const spent = this.ddLiftsToday > 0
    this.dayKey = d
    this.dayRealizedPnlWei = 0n
    this.ddLiftsToday = 0
    return spent
  }

  /**
   * Does every active halt lift itself, and when does the last one go?
   *
   * Derived here rather than at each display site: the dashboard used to test
   * `haltKind === 'gate'` inline, which silently reads "needs you" for a cap that lifts on
   * its own in four hours, and there are three such sites.
   */
  resumeOutlook(nowMs: number = this.now()): { autoResumes: boolean; when: string | null } {
    const kinds = this.haltKinds
    if (!kinds.length) return { autoResumes: false, when: null }
    if (kinds.some((k) => !SELF_LIFTING.has(k))) return { autoResumes: false, when: null }
    // A drawdown that has spent its daily budget is back to needing a person, and saying
    // "will resume by itself" there would be a lie on the one alert that matters overnight.
    if (kinds.includes('drawdown') && this.ddLiftsExhausted) return { autoResumes: false, when: null }
    // The stickiest kind decides the wording: it is the one holding, and the others lift
    // under it. Ordered by HALT_RANK, so this cannot disagree with haltKind.
    for (const k of kinds) {
      if (k === 'drawdown') {
        return { autoResumes: true, when: 'when the venue pays again on launches scored since the stop' }
      }
      if (k === 'gate') return { autoResumes: true, when: 'when the gate reopens' }
      if (k === 'venue') return { autoResumes: true, when: 'when the venue pays again' }
    }
    return { autoResumes: true, when: null }
  }
}
