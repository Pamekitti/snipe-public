/**
 * What is wrong, said once, in a sentence that names the action.
 *
 * AN ALERT NAMES WHAT TO DO, NOT WHAT IT SAW. "logs 8s stale, entries are refusing" is
 * actionable; "logs unhealthy" is a shrug. Severity is about what the operator should do now,
 * not about how alarming the number looks.
 *
 * IT READS THE STATE, NOT THE PAGE'S MODEL. The view model turns numbers into strings and
 * tones for a renderer; an alert needs the numbers. Feeding alerts from the rendered model
 * would mean parsing "35.0%" back into 0.35, which is how a display bug becomes an alerting
 * bug.
 *
 * EVERY THRESHOLD IS EITHER THE BOT'S OR DECLARED. The bot's come from `state.config`, so the
 * alert fires at exactly the number entries start refusing at. The rest come from `LEVELS`.
 * There is no third place, and `rings.test.ts` fails on a numeric literal in a comparison
 * anywhere under projections/.
 *
 * TWO DEFECTS ARE CARRIED FORWARD as fixes rather than re-derived. It used to hand-copy
 * `3_000`, `1_500` and `10_800_000` out of the spec, so tuning the spec moved the refusal
 * without moving the warning; those three now come from `config.risk.maxLogsStalenessMs`,
 * `config.risk.maxOverlayAgeMs` and each book's `guard.maxReadingAgeMs`. And it measured
 * stream liveness from the last `logs-status` CHANGE, which on a healthy stream that reported
 * once at boot read as "2105s stale" forever; `decide.ts:239` re-stamps `logsHealthy` on every
 * batch, so `logsHealthy.at` is the last batch and that is what is read here.
 *
 * NOTHING HERE DECIDES ANYTHING. An alert is a description of folded state. It cannot halt,
 * resume, size or send, and it has no access to the functions that can.
 */
import { bookLedger, haltedBy, ledgerNetWei, walletNetWei } from '../core/state.js'
import { LEVELS } from './levels.js'
import type { History } from './history.js'
import type { RefusalBucket } from '../core/contracts.js'
import type { State } from '../core/state.js'
import { effectiveBookDrawdownWei, effectiveBookSizeWei, effectiveWalletDrawdownWei, SELL_SETTLE_GIVEUP_MS } from '../core/config.js'

export type Severity = 'info' | 'warn' | 'crit'

/** `id`, `sev` and `msg` are the names the report skill reads. They do not change. */
export type Alert = { readonly id: string; readonly sev: Severity; readonly msg: string }

export function buildAlerts(state: State, history: History): readonly Alert[] {
  const out: Alert[] = []
  const now = state.at
  const cfg = state.config

  for (const p of state.positions.values()) {
    if (p.closed || p.filled === false) continue
    if (p.venue === 'curve' && p.approval && !p.approval.ready && (p.approval.lastError || now - p.openedAt > SELL_SETTLE_GIVEUP_MS)) {
      out.push({ id: `approval-${p.id}`, sev: 'crit',
        msg: `${p.book} ${p.token.slice(0, 10)} approval unconfirmed: ${p.approval.lastError ?? 'receipt or allowance evidence is unavailable'}. Sells wait for a confirmed allowance; ${p.attempts} sell attempts used.` })
    } else if (((p.sellReceipts?.size ?? 0) > 0 || p.grad?.awaitingReceipt)
      && now - p.openedAt > p.rules.maxHoldMs + SELL_SETTLE_GIVEUP_MS) {
      out.push({id:`receipt-${p.id}`,sev:'crit',
        msg:`${p.book} ${p.token.slice(0,10)} has an unresolved sale receipt. The position remains open while execution evidence is retried.`})
    } else if (((p.sellReceipts?.size ?? 0) === 0 && p.attempts >= p.rules.maxSellAttempts) || p.grad?.gaveUp) {
      out.push({ id: `stuck-${p.id}`, sev: 'crit',
        msg: `${p.book} ${p.token.slice(0, 10)} still holds tokens after ${p.attempts} sell attempts. Automatic retries stopped; recovery required.` })
    }
  }

  // ---- money, per book, because a blended number hides which policy is paying ----
  for (const spec of cfg.books) {
    const id = spec.id
    /**
     * THIS BOOK'S OWN HALT, not any halt that happens to stop it.
     *
     * `haltedFor` answers "can this book trade", so it matches wallet-wide halts too. Using it
     * here meant one wallet halt printed a crit line for every declared book AND the wallet
     * line below: three identical-sounding alerts for one event, which is how a page teaches an
     * operator to skim past crits. The wallet-wide loop further down is the one that reports
     * those, once.
     */
    const h = haltedBy(state.risk, id)
    if (h) {
      out.push({ id: `halt-${id}`, sev: 'crit', msg: `${id} is halted (${h.kind}): ${h.reason}. It will not enter until this clears.` })
      continue
    }
    const l = bookLedger(state.risk, id)
    const stop = effectiveBookDrawdownWei(cfg, spec, state.switches)
    if (stop <= 0n) continue
    // Net, like the stop itself: an alert measured on booked P&L would stay quiet through exactly
    // the gas bleed the stop was taught to see.
    const frac = Number(((l.peakWei - ledgerNetWei(l)) * 1000n) / stop) / 1000
    if (frac >= LEVELS.drawdownCritFraction) {
      out.push({ id: `drawdown-${id}`, sev: 'crit', msg: `${id} is ${show(frac)} of the way to its own stop. The next few losses halt it.` })
    } else if (frac >= LEVELS.drawdownWarnFraction) {
      out.push({ id: `drawdown-${id}`, sev: 'warn', msg: `${id} is ${show(frac)} of the way to its own stop.` })
    }
  }

  /**
   * Buys that were decided and never landed.
   *
   * `BookBucket` has said since it was written that "the gap between `decided` and `entered` IS
   * the send path's health", and nothing read it. On 2026-09-16 the fold raised eight buys in
   * twenty minutes, the signer signed all eight for the wrong chain, the sequencer rejected all
   * eight, and every projection agreed the bot was healthy and the market was quiet: a rejected
   * send leaves the nonce with us, opens no position and books no loss, so it is invisible in
   * the wallet, the P&L, the halts and the funnel, which counted eight refusals against
   * thousands and never reached its dominance floor.
   *
   * Crit whenever anything was rejected, with no fraction and no minimum count. Unlike a
   * refusal, a failed send is not the policy working: the bot has already decided it wants this
   * trade, so even one is a machine fault and the rate is beside the point.
   */
  const sendWindow = history.window(now - LEVELS.sendFailureWindowMs, now)
  for (const spec of cfg.books) {
    let failed = 0
    let landed = 0
    for (const b of sendWindow) {
      const x = b.books.get(spec.id)
      if (!x) continue
      failed += x.sendFailed
      landed += x.entered
    }
    if (failed === 0) continue
    const mins = Math.round(LEVELS.sendFailureWindowMs / 60_000)
    out.push({
      id: `send-${spec.id}`,
      sev: 'crit',
      msg: landed === 0
        ? `${spec.id} decided ${failed} buys in the last ${mins} minutes and not one of them reached the chain. It is not trading; the send path is broken, not the market.`
        : `${spec.id} had ${failed} buys rejected by the send path in the last ${mins} minutes, against ${landed} that landed.`,
    })
  }

  // ---- the wallet, which is not the books summed ----
  const walletStop = effectiveWalletDrawdownWei(cfg, state.switches)
  if (walletStop > 0n) {
    // NET, the same figure the wallet bar measures. This is an alert, not a halt: the
    // wallet-wide freeze is gone, and per-book drawdown is what pauses a policy.
    const frac = Number(((state.risk.walletPeakWei - walletNetWei(state.risk)) * 1000n) / walletStop) / 1000
    if (frac >= LEVELS.drawdownCritFraction) {
      out.push({ id: 'drawdown-wallet', sev: 'crit', msg: `booked P&L less gas is ${show(frac)} of the way to the wallet-wide stop, across every book.` })
    } else if (frac >= LEVELS.drawdownWarnFraction) {
      out.push({ id: 'drawdown-wallet', sev: 'warn', msg: `booked P&L less gas is ${show(frac)} of the way to the wallet-wide stop.` })
    }
  }

  /**
   * US AGAINST THE VENUE, on the way to the halt rather than at it.
   *
   * The halt is a crit in the loop below and it stops every entry. This is the warning before it,
   * and it is the whole reason the detector is worth having: both of v1's September losses were
   * bugs, not markets, and both were found by a person reading numbers hours in. A gap that has
   * not reached the halt is the cheapest moment to find the bug.
   *
   * Reported only over a full window, because the reading does not exist before then.
   */
  const broken = state.sensors.broken
  if (broken !== null && Number.isFinite(broken.value.gapPp)) {
    const limit = cfg.risk.brokenGapPp
    const { gapPp, n, realPp, replayPp } = broken.value
    const short = (-gapPp).toFixed(1)
    if (gapPp <= -limit) {
      out.push({
        id: 'broken', sev: 'crit',
        msg: `Wallet safety stop: ${n} paired trades averaged ${realPp.toFixed(1)}% actual versus ${replayPp.toFixed(1)}% modeled replay. The adjusted gap is ${short} points, past the ${limit.toFixed(0)}-point limit. This comparison needs diagnosis; it does not identify a specific fault or book.`,
      })
    } else if (gapPp <= -limit * LEVELS.brokenWarnFraction) {
      out.push({
        id: 'broken', sev: 'warn',
        msg: `${n} paired trades are ${short} points below their adjusted replay benchmark; the wallet safety stop is at ${limit.toFixed(0)} points. Check execution and replay assumptions.`,
      })
    }
  }

  /**
   * Every wallet-wide halt, including the ones the old projection could not see.
   *
   * The previous lookup checked `wallet`, `stopped` and `manual` only, so a `broken` halt (the
   * bot disagreeing with its own replay) and a `venue` halt were invisible on the page while
   * stopping every entry. Those are the two halts an operator most needs told about, because
   * neither one is something they did.
   */
  for (const h of state.risk.halts.values()) {
    if (h.book !== null) continue
    if (h.kind === 'broken') {
      out.push({id:'halt-broken',sev:'crit',msg:'New buys are paused across all books by the execution-gap safety check.'})
      continue
    }
    out.push({ id: `halt-${h.kind}`, sev: 'crit', msg: `trading is halted wallet-wide (${h.kind}): ${h.reason}` })
  }

  // ---- capacity ----
  const open = [...state.positions.values()].filter((p) => !p.closed).length
  const cap = cfg.risk.maxConcurrent
  if (cap > 0 && open / cap >= LEVELS.capacityWarnFraction) {
    out.push({ id: 'capacity', sev: 'warn', msg: `${open} of ${cap} slots in use. New launches will start being refused for capacity.` })
  }

  // ---- streams. The thresholds are the bot's own, so the warning and the refusal coincide ----
  const logs = state.sensors.logsHealthy
  if (logs === null) {
    out.push({ id: 'logs', sev: 'warn', msg: 'the log stream has never reported. Entries refuse while its health is unknown.' })
  } else if (!logs.value) {
    out.push({ id: 'logs', sev: 'crit', msg: 'the log stream is unhealthy. Entries are refusing.' })
  } else if (now - logs.at > cfg.risk.maxLogsStalenessMs) {
    out.push({ id: 'logs', sev: 'warn', msg: `the log stream last delivered ${Math.round((now - logs.at) / 1000)}s ago; entries refuse past ${cfg.risk.maxLogsStalenessMs}ms.` })
  }

  if (state.overlayAt === null) {
    out.push({ id: 'overlay', sev: 'warn', msg: 'there is no usable feed overlay. Entries refuse: the entry price is confirmed logs plus overlay, and without it that is a different quantity.' })
  } else if (now - state.overlayAt > cfg.risk.maxOverlayAgeMs) {
    out.push({ id: 'overlay', sev: 'warn', msg: `the feed overlay last moved ${now - state.overlayAt}ms ago; entries refuse past ${cfg.risk.maxOverlayAgeMs}ms.` })
  }

  const feed = state.sensors.feedConnected
  if (feed !== null && !feed.value) {
    out.push({ id: 'feed', sev: 'warn', msg: 'the sequencer feed is disconnected. Entry timing degrades to confirmed logs alone.' })
  }

  // ---- sensors ----
  // Per book, because the readings are per book. A book whose sensor died is a book that is
  // not being guarded, and saying "the venue sensor is stale" without naming which book leaves
  // an operator checking the wrong one.
  for (const book of cfg.books) {
    for (const [name, s] of [['venue', state.sensors.venue.get(book.id)], ['bars', state.sensors.bars.get(book.id)]] as const) {
      const id = `sensor-${name}-${book.id}`
      if (!s) {
        out.push({ id, sev: 'warn', msg: `${name} has never produced a reading for ${book.id}. Decisions that need it take the conservative answer.` })
      } else if (now - s.at > book.guard.maxReadingAgeMs) {
        out.push({ id, sev: 'warn', msg: `${name} on ${book.id} last read ${Math.round((now - s.at) / 1000)}s ago, over the ${Math.round(book.guard.maxReadingAgeMs / 1000)}s ${book.id} calls fresh. It has no opinion, which is not the same as "open".` })
      }
    }
  }

  // ---- the funnel, over the window, not since boot ----
  // The widest window any book calls fresh, so the funnel covers every book's evidence rather
  // than truncating at whichever one forgets soonest.
  const funnelMs = Math.max(...cfg.books.map((b) => b.guard.maxReadingAgeMs))
  const window = history.refusalsIn(now - funnelMs, now)
  if (window.length >= LEVELS.bucketDominanceMinimum) {
    const byBucket = new Map<RefusalBucket, number>()
    for (const r of window) byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + 1)
    for (const [bucket, n] of byBucket) {
      if (n / window.length >= LEVELS.bucketDominanceFraction) {
        const gate = bucket.startsWith('entry-')
        const rest = gate
          ? 'The entry filter is discarding everything in this window; later stages are not being reached.'
          : 'That stage is stopping everything; nothing downstream of it is being exercised.'
        out.push({ id: `funnel-${bucket}`, sev: 'warn', msg: `every one of the last ${window.length} refusals was ${bucket}. ${rest}` })
      }
    }
  }

  /**
   * A declared book that cannot trade, said out loud.
   *
   * A book with size 0 draws an empty chart set and an empty KPI row, which looks identical to
   * a book that is funded and simply has not traded yet. They call for opposite actions, so the
   * page has to be able to tell them apart and so does this.
   */
  for (const spec of cfg.books) {
    if (BigInt(spec.sizeWei) <= 0n) {
      out.push({ id: `unfunded-${spec.id}`, sev: 'info', msg: `${spec.id} is declared with size 0. It observes and scores launches but cannot enter one.` })
    }
  }
  if (cfg.books.every((spec) => effectiveBookSizeWei(spec, state.switches) <= 0n)) {
    out.push({ id: 'size-zero', sev: 'warn', msg: 'every effective live size is 0, so no book can enter.' })
  }

  /**
   * The mode, when it is not the one that moves money.
   *
   * `shadow` signs and never sends. It produces a page full of decisions that look like live
   * trading. This line is what separates it from a wallet that is moving.
   */
  if (state.switches.mode !== 'live') {
    out.push({ id: 'mode', sev: 'info', msg: `mode is ${state.switches.mode}: decisions are real, nothing is sent. No fill on this page is a fill in the wallet.` })
  }

  // ---- reproducibility ----
  if (state.gaps.length > 0) {
    out.push({ id: 'gaps', sev: 'info', msg: `${state.gaps.length} gap${state.gaps.length === 1 ? '' : 's'} in the recorded streams. Decisions inside them cannot be replayed.` })
  }

  return out
}

const show = (fraction: number): string => `${(100 * fraction).toFixed(1)}%`
