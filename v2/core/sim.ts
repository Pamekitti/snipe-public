/**
 * The simulator. One engine, and the only one.
 *
 * WHAT THIS ANSWERS. Given a launch's chain logs, what would a trade in it have been worth,
 * under a given exit policy? Everything that needs that answer calls this: the market
 * indicator that halts the wallet, the paper book, research, and the exits table's peak
 * column. There is no second implementation and there must never be one.
 *
 * WHY THAT RULE IS NOT TIDINESS. On 2026-08-27 the box had grown 33 scripts that each
 * replayed the curve their own way, 26 of them predating the execution calibration. One
 * reported +$0.72 a trade for buying everything, in a 24-hour window where the live bot lost
 * money, and it looked exactly as authoritative as the correct answer. A wrong simulator is
 * worse than none, because it is believed.
 *
 * PORTED FROM `v1/scripts/engine.py` (2026-09-16), function by function, expression by
 * expression. That file is what decided real money: `gatewatch.py` calls it on every screened
 * launch, writes the per-bar outcome to `gate.db obs.bars`, and `gate.ts` sums the live bar's
 * column into the venue sensor that halts the wallet. The port is checked against 21,880
 * independently scored rows rather than against a reading of the source.
 *
 * FLOAT64, NOT BIGINT, AND THE ARITHMETIC IS NOT REFACTORED. The reference rows were produced
 * by IEEE-754 doubles in a specific order. `a * b / c` and `a / c * b` are different numbers
 * here. Every expression below is in the order the Python had it, including the ones that
 * look like they could be simplified. This is the one file in `core/` where that is true, and
 * it is why the parity harness exists.
 *
 * PURE. No clock, no I/O, no randomness. The caller supplies the decoded log sequence.
 */

// ---------------------------------------------------------------------------
// The venue
// ---------------------------------------------------------------------------

/** Phantom quote reserve, ETH. The curve opens here rather than at zero. */
export const PH = 1.68
/** Total token supply. */
export const SUP = 1e9
/** Quote raised at which the curve graduates to the DEX. */
export const THR = 4.2
/** The flat curve fee, bps. Charged on the way in and on the way out. */
export const FEE = 100
/** Tokens that can never be sold into the curve, held back for the DEX pool. */
export const RES = (SUP * PH) / (PH + THR)

/**
 * Exit a graduating curve on APPROACH, not on arrival.
 *
 * Once sellable supply reaches zero the curve stops accepting sells at all and the bag is
 * stranded, so the live bot leaves at 12% of sellable supply remaining. A simulator that
 * waits for full graduation holds its winners ~12% of supply longer than the bot ever could
 * and prices an exit nobody can make, which flatters exactly the high-bar, long-clock
 * configurations it is supposed to be judging.
 */
export const GRAD_EXIT_AT = 0.12

/**
 * Gas actually burned, ETH, from 40 live receipts on 2026-08-18.
 *
 * Buy p50 100,161 gas, sell p50 77,276, at an effective gas price of 0.0200 gwei. These
 * reach `pnl` and deliberately never reach `mult`: the stored bar values are gross of gas,
 * so a recorded trade has to pay it to be comparable with a replayed one.
 */
export const GAS_BUY = 2.0e-6
export const GAS_SELL = 1.6e-6

/**
 * The snipe tax as the chain charges it: three plateaus, never a decay.
 *
 * Measured 2026-08-18 over every Buy in 1,742 launches, bucketing the fee above the flat
 * 100 bps curve fee by block offset from launch:
 *
 *   blk  0-4    ~9700 bps   rare, almost everyone here is a tax-exempt bundled wallet
 *   blk  5-10     618 bps   36-83% at 618, the rest exempt or still at 9700
 *   blk 11-19      19 bps   71-98% at 19, with a 2-26% tail still paying 618
 *   blk 20-23      19 bps   98% at 19, and max = 19: the band with no tail risk
 *   blk 24+         0 bps   crossing into whole-second 3
 *
 * The contract keys on whole elapsed SECONDS and a launch block sits at an unknown phase
 * inside its second, which is why the bands overlap at all. The old smooth formula
 * (9900 >> (elapsed*14//3)) read 309 bps at 1.2s and 154 at 1.4s against a true 19. It
 * happened to be right at exactly block 20, which is where every backtest ran, so those
 * headline numbers survive. Any result that VARIED entry timing does not.
 */
const SNIPE_BY_BLK = new Map<number, number>()
for (let b = 0; b < 5; b++) SNIPE_BY_BLK.set(b, 9700)
for (let b = 5; b < 11; b++) SNIPE_BY_BLK.set(b, 618)
for (let b = 11; b < 24; b++) SNIPE_BY_BLK.set(b, 19)

/**
 * Python's `round()` is half-to-even; JavaScript's `Math.round` is half-up.
 *
 * No input this function sees today lands on a half, because `elapsed_s` is always an
 * integer block count divided by ten. Implemented faithfully anyway: a silent divergence in
 * a rounding mode is exactly the kind of thing that shows up two eras later as an
 * unexplained parity failure on three rows out of twenty thousand.
 */
function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** The snipe tax in bps at `elapsedS` seconds after launch, capped so the fees can be paid. */
export function snipeBps(elapsedS: number, ctax: number): number {
  const blk = roundHalfEven(elapsedS * 10)
  const raw = SNIPE_BY_BLK.get(blk) ?? (blk < 0 ? 9690 : 0)
  return Math.min(raw, 10000 - FEE - ctax - 100)
}

// ---------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------

/**
 * The bonding curve as a constant product `q * t`, mutated in place.
 *
 * Mutable, unlike everything else in `core/`, because the reference implementation is and
 * because the mutation order is part of the arithmetic. It never escapes this module.
 */
type Curve = { q: number; t: number; ff: number }

function newCurve(ctax: number): Curve {
  return { q: PH, t: SUP, ff: (FEE + ctax) / 10000 }
}

/** Buy `spent` ETH into the curve. Returns the tokens out and whether it graduated. */
function buy(s: Curve, spent: number, snipe: number): { out: number; graduated: boolean } {
  const net = spent * (1 - s.ff - snipe / 10000)
  const sellable = s.t - RES
  if (sellable <= 1e-9) return { out: 0.0, graduated: true }
  let out = (s.t * net) / (s.q + net)
  let n = net
  if (out > sellable) {
    out = sellable
    n = (s.q * out) / (s.t - out)
  }
  s.q += n
  s.t -= out
  return { out, graduated: s.t - RES <= 1e-9 }
}

/**
 * ETH out for selling `tok` into `(q, t)`, with `comp` rivals selling `rtok` alongside.
 *
 * THE MARK AND THE SELL GO THROUGH THIS SAME FUNCTION. They did not always, and that was the
 * most expensive modelling bug this code has had. The mark used to be a raw spot ratio
 * `price / entryPrice`, which buries the curve fee, the creator tax, the snipe tax and our
 * own slippage in the denominator only, so it started at a median of 0.9930 instead of
 * 1.0000.
 *
 * A fixed 0.7pp offset is 0.35% of the distance to a 2.00 take profit and does not matter.
 * It is 23% of the distance to a 1.03 dead-coin bar, and 63% of bailed coins go on to print
 * 1.03x, so the old mark declared dead every coin whose real peak landed between 1.030 and
 * 1.037. Measured 2026-08-27: the simulator ranked the only live-profitable configuration
 * (+$0.351 a trade over 564 real trades) at -$0.004, below one that actually lost money.
 */
function proceeds(q: number, t: number, tok: number, rtok: number, comp: number, slotOut: number, ff: number): number {
  let out = 0
  let qq = q
  let tt = t
  for (let i = 0; i <= comp; i++) {
    const tk = i === slotOut ? tok : rtok
    const gross = (qq * tk) / (tt + tk)
    qq -= gross
    tt += tk
    if (i === slotOut) out = gross * (1 - ff)
  }
  return out
}

// ---------------------------------------------------------------------------
// The price path
// ---------------------------------------------------------------------------

/** One decoded curve log, in the order the chain emitted it. Amounts are hex words. */
export type SimEvent = {
  /** block number */
  readonly b: number
  /** 'B' buy, 'S' sell, anything else is a buyback */
  readonly s: string
  /** recipient, lower case, for the creator and early-wallet annotations */
  readonly r?: string
  /** primary amount: ETH in on a buy, tokens in on a sell, quote on a buyback */
  readonly q: string
  /** tokens, used on sells and buybacks */
  readonly t?: string
  /** the fee word, on buys */
  readonly f?: string
  /** the creator tax word, on buys */
  readonly x?: string
  readonly tx?: string
}

/** What a rule is told about one sampled moment. */
export type SimPoint = {
  /** blocks since entry */
  readonly off: number
  /** the proceeds ratio. Exactly 1.0 at entry by construction. */
  readonly m: number
  readonly q: number
  readonly t: number
  /** graduated, or inside `GRAD_EXIT_AT` of graduating */
  readonly grad: boolean
  readonly ev: SimEventNote | null
}

export type SimEventNote = {
  readonly s: 'B' | 'S'
  readonly eth?: number
  readonly tok?: number
  readonly creator: boolean
  readonly early: boolean
  readonly nEarly: number
}

export type SimPath = {
  readonly token: string
  /** the stake the path was priced at, ETH */
  readonly X: number
  /** tokens we hold after the entry buy */
  readonly tok: number
  readonly ctax: number
  readonly comp: number
  readonly slotOut: number
  readonly rivalX: number
  readonly pts: readonly SimPoint[]
}

export type PathOptions = {
  /** blocks after the launch block at which we buy. 20 is the live bot's decision block. */
  readonly entryBlk: number
  /** rival buyers entering alongside us. 0 on every live path. */
  readonly comp: number
  /** shrink applied to post-entry buy flow. 0 on every live path. */
  readonly haircut: number
  /** how many blocks past entry to walk */
  readonly horizon: number
  /** synthetic sampling interval, blocks, so time-based rules see flat stretches */
  readonly tick: number
  /** rival stake, ETH. Defaults to our own. */
  readonly rivalX?: number
  /**
   * Which slot in the rival pack is ours, going in and coming out.
   *
   * The Python seeded these from `random.Random(hash(token))`, and CPython randomises string
   * hashing per process, so a `comp > 0` run was never reproducible across two invocations.
   * With `comp = 0` both are forced to 0 and the question does not arise, which is every
   * live path. Declared explicitly here rather than drawn, so a future rival model has to
   * say what it means instead of inheriting a bug.
   */
  readonly slotIn?: number
  readonly slotOut?: number
}

/** The live replay's options, which is the only combination any stored row was produced under. */
export const LIVE_PATH: PathOptions = { entryBlk: 20, comp: 0, haircut: 0.0, horizon: 500, tick: 5 }

/**
 * Blocks per second on this chain, which is the only unit conversion in the file.
 *
 * `snipeBps` already divides by ten to reach whole seconds, so this constant is not a new
 * assumption, it is the one already baked into `path()` given a name. Every caller that
 * holds a policy in milliseconds converts through `blocksFromMs` rather than writing `/ 100`,
 * because the repo has already shipped one units bug of exactly that shape.
 */
export const BLOCKS_PER_S = 10

/** Milliseconds to blocks, rounded. The only bridge between a spec in ms and a walk in blocks. */
export function blocksFromMs(ms: number): number {
  return Math.round((ms * BLOCKS_PER_S) / 1000)
}

/**
 * The replay's stake, ETH, fixed and deliberately not the live trade size.
 *
 * It affects one thing: our own price impact on the way in and out. Every stored row in
 * `gate.db` was produced at 0.010, and the venue thresholds were fitted against those sums,
 * so moving it moves the indicator without moving the market. When the live size changes the
 * comparison has to stay still, which is exactly what this constant is for.
 */
export const REPLAY_STAKE_ETH = 0.010

/**
 * Poll blindness and exit latency, blocks. Execution model, never strategy.
 *
 * These are not tunables: they are measurements of what the bot's own loop can do, and they
 * belong beside the simulator rather than in a spec an operator edits. `POLL = 12` (1.2s)
 * calibrated over 768 booked trades: total error -3.0% at poll 1, -1.2% at 12, +10.8% at 25.
 * `XLAG = 6` (0.6s) over 481 booked trades: +8.1% at lag 2, +3.6% at 6, +14.2% at 12.
 */
export const LIVE_POLL_BLK = 12
export const LIVE_EXIT_LAG_BLK = 6

/**
 * How long a launch has to be watched before it can be scored, ms.
 *
 * The walk buys at `entryBlk` and runs `horizon` blocks past that, so a launch settled any
 * earlier is scored on a path whose tail never arrived. Settling early does not produce a
 * noisy number, it produces a systematically low one: the missing tail is where the winners
 * are, and the indicator would read the market as worse than it is exactly when it is good.
 */
export const SIM_WINDOW_MS = ((LIVE_PATH.entryBlk + LIVE_PATH.horizon) * 1000) / BLOCKS_PER_S

function hexToEth(x: string): number {
  return Number(BigInt(x)) / 1e18
}

/**
 * Walk the curve from the launch block, buy at `entryBlk`, and sample the mark.
 *
 * Returns null when entry is impossible, which is the curve having no sellable supply left
 * by the time we arrive. The caller records that as a scoring error rather than as a zero:
 * a launch we could not have entered is missing data, not a flat outcome.
 */
export function path(
  launch: { readonly token: string; readonly block: number; readonly deployer: string; readonly tx: string },
  X: number,
  seq: readonly SimEvent[],
  ctax: number,
  opts: PathOptions,
): SimPath | null {
  const lb = launch.block
  const entryAbs = lb + opts.entryBlk
  const comp = opts.comp
  const slotIn = opts.slotIn ?? 0
  const slotOut = opts.slotOut ?? 0
  const rivalX = opts.rivalX ?? X
  const tick = opts.tick
  const horizon = opts.horizon
  const c = newCurve(ctax)
  const ff = (FEE + ctax) / 10000

  let myTok: number | null = null
  let graduated = false
  const pts: SimPoint[] = []
  let base: number | null = null
  let curEv: SimEventNote | null = null

  const enter = (): boolean => {
    const el = (entryAbs - lb) / 10.0
    const sb = snipeBps(el, ctax)
    let got: number | null = null
    for (let i = 0; i <= comp; i++) {
      const r = buy(c, i === slotIn ? X : rivalX, sb)
      if (r.graduated) graduated = true
      if (i === slotIn) got = r.out
    }
    if (!got) return false
    myTok = got
    return true
  }

  const snap = (off: number): void => {
    const tok = myTok as number
    const pv = proceeds(c.q, c.t, tok, tok * (rivalX / X), comp, slotOut, ff)
    if (base === null) base = pv
    const going = graduated || (c.t - RES) / (SUP - RES) < GRAD_EXIT_AT
    pts.push({ off, m: pv / base, q: c.q, t: c.t, grad: going, ev: curEv })
    curEv = null
  }

  const dep = launch.deployer.toLowerCase()
  const early = new Set<string>()
  let lastOff = 0

  for (const e of seq) {
    const blk = e.b
    if (myTok === null && blk >= entryAbs) {
      if (!enter()) return null
      snap(0)
      lastOff = 0
    }
    if (myTok !== null) {
      const off = blk - entryAbs
      if (off > horizon) break
      // synthetic ticks between events so time-based rules see the flat stretches
      let k = Math.floor(lastOff / tick) + 1
      while (k * tick < off) {
        snap(k * tick)
        k += 1
      }
    }
    const w = e.s === 'B' || e.s === 'S' ? (e.r ?? '').toLowerCase() : ''
    if (myTok !== null) {
      if (e.s === 'B') {
        curEv = { s: 'B', eth: hexToEth(e.q), creator: w === dep, early: early.has(w), nEarly: early.size }
      } else if (e.s === 'S') {
        curEv = { s: 'S', tok: hexToEth(e.q), creator: w === dep, early: early.has(w), nEarly: early.size }
      }
    }
    if (e.s === 'B' && blk <= lb + 30 && e.tx !== launch.tx && w) early.add(w)
    if (e.s === 'B') {
      const spent = hexToEth(e.q)
      const fee = hexToEth(e.f ?? '0x0')
      const tax = hexToEth(e.x ?? '0x0')
      let net = spent - fee - tax
      if (myTok !== null && opts.haircut) net *= 1 - opts.haircut
      const sellable = c.t - RES
      if (sellable <= 1e-9) {
        graduated = true
      } else {
        let out = (c.t * net) / (c.q + net)
        if (out >= sellable) {
          out = sellable
          net = (c.q * out) / (c.t - out)
          graduated = true
        }
        c.q += net
        c.t -= out
      }
    } else if (e.s === 'S') {
      const tok = hexToEth(e.q)
      const gross = (c.q * tok) / (c.t + tok)
      c.q -= gross
      c.t += tok
    } else {
      c.q += hexToEth(e.q)
      c.t -= hexToEth(e.t ?? '0x0')
    }
    if (myTok !== null) {
      const off = blk - entryAbs
      snap(off)
      lastOff = off
    }
  }

  if (myTok === null) {
    // no event at or after entry: enter into the final state, nothing follows
    if (!enter()) return null
    snap(0)
  }

  // pad ticks to the horizon
  let k = Math.floor(lastOff / tick) + 1
  while (k * tick <= horizon) {
    snap(k * tick)
    k += 1
  }

  // `enter()` assigns through a closure, so the narrowing above is not visible here. The
  // guard is real rather than a cast: a path with no entry has nothing to score.
  const entered: number | null = myTok
  if (entered === null) return null
  return { token: launch.token, X, tok: entered, ctax, comp, slotOut, rivalX, pts }
}

/** Proceeds for selling `frac` of our bag into `(q, t)`. */
function sellValue(P: SimPath, q: number, t: number, frac: number): number {
  const tok = P.tok * frac
  const rtok = tok * (P.rivalX / P.X)
  return proceeds(q, t, tok, rtok, P.comp, P.slotOut, (FEE + P.ctax) / 10000)
}

// ---------------------------------------------------------------------------
// The exit walk
// ---------------------------------------------------------------------------

export type RuleContext = {
  readonly off: number
  readonly m: number
  readonly peak: number
  readonly held: number
  readonly ev: SimEventNote | null
}

/** A rule returns the fraction to sell and why, or null to hold. */
export type SimRule = (c: RuleContext) => readonly [number, string] | null

export type SimResult = {
  /** net of gas */
  readonly pnl: number
  /** proceeds over stake. This minus one is what `obs.bars` stores. */
  readonly mult: number
  readonly off: number
  readonly reason: string
  readonly exits: readonly { readonly off: number; readonly frac: number; readonly why: string }[]
}

/**
 * Walk the path under one exit rule.
 *
 * EVERY EXIT REASON PAYS THE LAG, including `time` and `grad`. They used to sell instantly
 * while the take profit, the stop and the dead bail waited `exitLag` blocks, which on a
 * decaying curve handed every clock-exit configuration a free 0.6s head start over every
 * bail configuration. That is a ranking bias, not a rounding error, and it pushed the same
 * direction as the old spot-price mark.
 *
 * THE ORDER IS THE LIVE BOT'S ORDER: graduating, then take profit, then the clock, then the
 * stop and the dead bail. The clock sits BETWEEN the take profit and the two floors, so a
 * coin that clears its bar on the same tick the clock expires exits as `tp`, not `time`.
 * This was the other way round once and it cost the take-profit configurations every
 * boundary case.
 */
export function evaluate(P: SimPath, rule: SimRule, exitLag: number, hold: number): SimResult {
  const pts = P.pts
  const X = P.X
  let peak = 1.0
  let held = 1.0
  let got = 0.0
  let pending: { off: number; frac: number; why: string }[] = []
  const exits: { off: number; frac: number; why: string }[] = []

  const doSell = (off: number, frac: number, why: string, q: number, t: number): void => {
    const f = Math.min(frac, held)
    if (f <= 0) return
    got += sellValue(P, q, t, f)
    held -= f
    exits.push({ off, frac: f, why })
  }

  for (const p of pts) {
    // execute pending sells whose time has come, priced at THIS point's curve state
    while (pending.length && (pending[0] as { off: number }).off <= p.off) {
      const due = pending.shift() as { off: number; frac: number; why: string }
      doSell(p.off, due.frac, due.why, p.q, p.t)
    }
    if (held <= 1e-12) break
    // the live bot updates the peak before testing anything against it
    if (p.m > peak) peak = p.m
    if (p.grad) {
      // graduation preempts whatever is queued and is never poll-gated: the live bot checks
      // it on every 50ms tick, ahead of the take profit
      if (!(pending.length && (pending[0] as { why: string }).why === 'grad')) {
        pending = [{ off: p.off + exitLag, frac: held, why: 'grad' }]
      }
    } else if (!pending.length) {
      const r = rule({ off: p.off, m: p.m, peak, held, ev: p.ev })
      if (r && r[1] === 'tp') {
        pending.push({ off: p.off + exitLag, frac: r[0], why: 'tp' })
      } else if (p.off >= hold) {
        pending.push({ off: p.off + exitLag, frac: held, why: 'time' })
      } else if (r) {
        pending.push({ off: p.off + exitLag, frac: r[0], why: r[1] })
      }
    }
  }

  if (held > 1e-12) {
    const last = pts[pts.length - 1] as SimPoint
    doSell(last.off, held, 'end', last.q, last.t)
  }

  const pnl = got - X - GAS_BUY - GAS_SELL * Math.max(1, exits.length)
  const lastExit = exits.length ? (exits[exits.length - 1] as { off: number; why: string }) : null
  return { pnl, mult: got / X, off: lastExit ? lastExit.off : 0, reason: lastExit ? lastExit.why : '?', exits }
}

// ---------------------------------------------------------------------------
// The policy under test
// ---------------------------------------------------------------------------

/** The exit stack a book trades, in blocks of 100ms and multiples of entry. */
export type SimPolicy = {
  /** take profit multiple, or 0 for none */
  readonly takeProfit: number
  /** hard stop multiple, or 0 for none */
  readonly hardStop: number
  /** blocks after entry at which the dead-coin bail arms, or 0 for off */
  readonly deadAfterBlk: number
  /** the peak the coin must have reached by then to survive the bail */
  readonly deadBelowMultiple: number
  /** the hold clock, blocks */
  readonly holdBlk: number
  /** blocks between rule evaluations. The bot cannot act on a price it never saw. */
  readonly pollBlk: number
  /** blocks between a trigger and its fill */
  readonly exitLagBlk: number
}

/**
 * Restrict a rule to poll boundaries.
 *
 * A spike that opens and closes between two samples never existed as far as the bot is
 * concerned. Left alone the walk evaluates at every curve event and happily sells into
 * exactly those spikes. Calibrated over 768 booked trades: total error -3.0% at poll 1,
 * -1.2% at poll 12, +10.8% at poll 25.
 */
function polled(rule: SimRule, poll: number): SimRule {
  let next = 0.0
  return (c) => {
    if (c.off < next) return null
    next = c.off + poll
    return rule(c)
  }
}

/** The bot's exit stack at one take-profit bar. Same order and same comparisons as `core/exit.ts`. */
export function policyRule(p: SimPolicy): SimRule {
  const rule: SimRule = (x) => {
    if (p.takeProfit && x.m >= p.takeProfit) return [1.0, 'tp']
    if (p.hardStop && x.m <= p.hardStop) return [1.0, 'sl']
    if (x.off >= p.deadAfterBlk && x.peak < p.deadBelowMultiple) return [1.0, 'dead']
    return null
  }
  return polled(rule, p.pollBlk)
}

/**
 * The key a bar is stored under, so 1.5 and 1.50 cannot become two keys.
 *
 * Two decimals, matching the `"%.2f"` the reference wrote into every one of the 21,880 rows
 * the parity harness reads.
 */
export function barKey(b: number): string {
  return b.toFixed(2)
}

export type Scored = {
  /** the best mark reached inside `peakWindowBlk`, ignoring every exit rule */
  readonly peak: number
  /** bar key to calibrated outcome in stakes, which is what paper and the guard read */
  readonly perBar: Readonly<Record<string, number>>
  /** uncalibrated curve replay, retained for the independently calibrated bot-broken detector */
  readonly rawPerBar: Readonly<Record<string, number>>
}

export type SimCalibration = {
  readonly positiveFactor: number
  readonly negativeFactor: number
}

const IDENTITY_CALIBRATION: SimCalibration = { positiveFactor: 1, negativeFactor: 1 }

/** Apply the fitted real-versus-replay residual without changing an outcome's sign. */
export function calibrateReturn(raw: number, calibration: SimCalibration): number {
  if (raw > 0) return raw * calibration.positiveFactor
  if (raw < 0) return raw * calibration.negativeFactor
  return raw
}

/**
 * Score one launch at every bar a book trades. This is what the market indicator reads.
 *
 * ONE PATH, N EVALUATIONS. The price path is built once and each bar re-walks the same
 * points with a fresh rule closure, so the bars are strictly comparable: they differ only in
 * where they sold, never in what they saw.
 *
 * A BAR THAT THROWS IS OMITTED, NEVER ZEROED. A missing key is missing data, and the reader
 * skips it rather than counting it as a flat outcome. Counting it as zero would quietly pull
 * every sum toward the middle.
 *
 * THE PEAK IS A SEPARATE ANSWER, deliberately. It pays no poll, no lag and no exit rule, so
 * it is the best any holder could have had inside the window, and it is NOT a bound on what
 * our own exit could have made.
 */
export function scoreLaunch(
  P: SimPath,
  bars: readonly number[],
  policy: Omit<SimPolicy, 'takeProfit'>,
  peakWindowBlk: number,
  calibration: SimCalibration = IDENTITY_CALIBRATION,
): Scored {
  let peak = 0
  for (const p of P.pts) if (p.off <= peakWindowBlk && p.m > peak) peak = p.m
  const perBar: Record<string, number> = {}
  const rawPerBar: Record<string, number> = {}
  for (const tp of bars) {
    const r = evaluate(P, policyRule({ ...policy, takeProfit: tp }), policy.exitLagBlk, policy.holdBlk)
    if (Number.isFinite(r.mult)) {
      const key = barKey(tp)
      const raw = r.mult - 1.0
      rawPerBar[key] = raw
      perBar[key] = calibrateReturn(raw, calibration)
    }
  }
  return { peak, perBar, rawPerBar }
}
