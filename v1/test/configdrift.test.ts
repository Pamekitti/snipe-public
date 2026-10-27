/**
 * Nothing that DISPLAYS or POLICES a strategy number may keep its own copy of it.
 *
 * This is the most expensive recurring bug in this project and it has now happened four
 * times. Each one was silent, because a stale literal never throws:
 *
 *   - recon.py kept its own exit rule, the bot grew a take profit, and recon reported
 *     5-25pp of imaginary sim-vs-live gap for a day.
 *   - livewatch.cjs hardcoded "no repeat deployers" while the live book allowed 3, so
 *     legitimate trades read as filter leaks.
 *   - gatewatch.py derived its observation window from maxHoldMs, which let an exit-clock
 *     change silently resize the regime detector's own ruler.
 *   - 2026-08-27, the one this file was written for: the exit clock moved 45s -> 90s and
 *     livewatch.cjs still alarmed on `hold > 70_000`, so every healthy 90s trade counted
 *     as "held too long" and the monitor screamed on a correctly working bot. The same
 *     commit left the dashboard printing a "Max 45s" column and a drawdown alarm quoting
 *     "the -$75 stop" when the real kill switch had been $100 since 2026-08-19.
 *
 * A monitor quoting a bound the bot is not running is worse than no monitor: it trains
 * the operator to ignore it. So the rule is mechanical rather than a matter of judgement,
 * and it is enforced here.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { STRATEGY, RISK } from '../src/config.js'
import { ALL_ENV, HOT, HOT_KEYS, RESTART } from '../src/config/schema.js'
import { dashboardHtml, dashboardShell } from '../src/telemetry/dashboard-page.js'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('the dashboard renders strategy numbers from config', () => {
  it('leaves no placeholder unspliced', () => {
    // a typo'd placeholder renders as literal __FOO__ on the page and looks like a glitch
    // nobody files, so assert on the rendered output rather than the template
    const html = dashboardHtml()
    const left = html.match(/__[A-Z][A-Z0-9_]*__/g)
    expect(left, `unspliced placeholders: ${left?.join(', ')}`).toBeNull()
  })

  it('splices the gate window, and the template never hardcodes it', () => {
    const secs = Math.round(STRATEGY.gate.holdMs / 1000)
    expect(dashboardHtml()).toContain(`Max ${secs}s`)
    // the shell is the template as authored: it must carry the placeholder, not a number
    expect(dashboardShell()).toContain('Max __GATE_HOLD_S__s')
  })

  it('shows the GATE window in that column, not the exit clock', () => {
    // truePeak comes from gate.db, which gatewatch fills at gateHoldMs. Splicing maxHoldMs
    // would swap one wrong number for a differently wrong one, so this asserts the source.
    const dash = src('../src/telemetry/dashboard-page.ts')
    expect(dash).toMatch(/__GATE_HOLD_S__.*STRATEGY\.gate\.holdMs|STRATEGY\.gate\.holdMs/s)
    expect(dash).not.toMatch(/__GATE_HOLD_S__'.*STRATEGY\.maxHoldMs/s)
  })

  it('carries no stale hold literal anywhere in the rendered page', () => {
    // 45 and 90 both appear legitimately (colours, pixel sizes), so this looks only for the
    // shape that actually went stale: a seconds-suffixed hold in prose or a column head.
    const html = dashboardHtml()
    const gate = Math.round(STRATEGY.gate.holdMs / 1000)
    const hold = Math.round(STRATEGY.maxHoldMs / 1000)
    for (const m of html.matchAll(/(?:max|inside the|hold of)\s+(\d{2,3})s/gi)) {
      expect([gate, hold]).toContain(Number(m[1]))
    }
  })
})

describe('livewatch polices the bounds the bot actually published', () => {
  const lw = src('../scripts/livewatch.cjs')

  it('derives the long-hold alarm from the clock instead of a literal', () => {
    // the exact regression: `h > 70_000` fires on every healthy trade at a 90s clock
    expect(lw).not.toMatch(/>\s*70_000/)
    expect(lw).toMatch(/LONG_HOLD\s*=\s*MAX_HOLD\s*\+/)
    expect(lw).toMatch(/holds\.filter\(\(h\) => h > LONG_HOLD\)/)
  })

  it('derives the drawdown alarm from the published kill switch, in ETH', () => {
    expect(lw).not.toMatch(/-\$75/)
    expect(lw).not.toMatch(/pnl <= -45\b/)
    expect(lw).toMatch(/strat\.maxDrawdownEth/)
    expect(lw).toMatch(/DD_WARN_ETH/)
    // and it compares ETH to ETH. While the P&L was multiplied by a price to meet a dollar
    // bound, a stale price moved the alarm without anyone touching a threshold.
    expect(lw).toMatch(/pnlEth <= -DD_WARN_ETH/)
  })

  it('reads the ETH price the bot published rather than keeping its own', () => {
    // the price is fetched hourly since 2026-09-07, so a monitor holding a copy reports
    // different dollars for the same trade than the page does
    expect(lw).toMatch(/truthGet\('eth_usd'\)/)
  })

  it('reads the clock and the book bound from strategy_json, not from constants', () => {
    expect(lw).toMatch(/strat\.maxHoldMs/)
    expect(lw).toMatch(/strat\.maxPriorLaunches/)
  })
})

describe('the bot publishes everything a monitor is expected to read', () => {
  const bot = src('../src/bot.ts')

  it('publishes the exit clock, the gate window and the kill switch', () => {
    for (const k of ['maxHoldMs', 'gateHoldMs', 'gateTouchMultiple', 'maxDrawdownEth', 'ethUsd']) {
      expect(bot, `publishStrategy is missing ${k}`).toMatch(new RegExp(`${k}:`))
    }
  })

  it('publishes the dead-coin rule even while it is switched off', () => {
    // afterMs is 0 today. A monitor that inferred "no bailout" from a missing key could not
    // tell that apart from an older bot that never had one.
    expect(bot).toMatch(/deadCoinAfterMs:\s*STRATEGY\.deadCoin\.afterMs/)
    // 0 -> 20_000 on 2026-08-27. The disable was measured with the sim's broken mark
    // scale, which turned the 1.03 bar into an effective 1.0373 and made the replay bail
    // on coins that were never flat. See config.ts deadCoin for the full argument.
    expect(STRATEGY.deadCoin.afterMs).toBe(20_000)
  })

  it('the published kill switch is the one RISK actually enforces', () => {
    expect(bot).toMatch(/maxDrawdownEth:\s*RISK\.maxDrawdownEth/)
    expect(RISK.maxDrawdownEth).toBeGreaterThan(0)
    // and the price, which the monitors must not keep their own copy of now that it moves
    expect(bot).toMatch(/ethUsd:\s*RISK\.ethUsd/)
  })

  it('publishes the creator-tax band, because the floor is now the load-bearing filter', () => {
    // A replay that does not know the floor is scoring a different book than the one
    // running, which is the same failure the kill-switch line above exists to prevent.
    expect(bot).toMatch(/minCreatorTaxBps:\s*STRATEGY\.minCreatorTaxBps/)
    expect(bot).toMatch(/maxCreatorTaxBps:\s*STRATEGY\.maxCreatorTaxBps/)
    // The ENTRY ceiling, which is a different number from the screen bound above it. Without
    // it a reader cannot tell an untaxed-only book from one that buys every band from 0 up.
    expect(bot).toMatch(/maxEntryTaxBps:\s*STRATEGY\.maxEntryTaxBps/)
  })
})

describe('the entry filters decline trades without shrinking the observation universe', () => {
  // 2026-08-28: the creator-tax floor is the strongest filter we have. 2026-09-06: the
  // exempt-wallet floor and the entry window joined it, and all three moved into
  // strategy/entry.ts as one decision. The ONLY way to know any of them still works is to
  // keep observing the coins we no longer buy.
  //
  // screenCurve sets launches.passed, and gatewatch.py scores WHERE passed = 1. So a
  // trading filter in the screen would silently delete the control group and make the
  // filter unfalsifiable. This is the 08-27 gate-starvation scar generalized: a TRADING
  // filter must never shrink the OBSERVATION universe.
  const bot = src('../src/bot.ts')
  const launch = src('../src/strategy/launch.ts')
  const entry = src('../src/strategy/entry.ts')

  it('every filter lives in entry.ts and is applied from enter(), never from screenCurve', () => {
    for (const k of ['minCreatorTaxBps', 'minExemptionsToEnter']) {
      expect(entry, `entry.ts does not read ${k}`).toMatch(new RegExp(k))
      expect(launch, `screenCurve must not screen on ${k}`).not.toMatch(new RegExp(`STRATEGY\\.${k}`))
    }
    expect(bot).toMatch(/pickEntry\(/)
  })

  it('is decided AFTER startObservation, so a declined launch still teaches us', () => {
    const enter = bot.slice(bot.indexOf('private async enter('))
    const obs = enter.indexOf('this.startObservation(')
    const pick = enter.indexOf('pickEntry(')
    expect(obs, 'startObservation not found in enter()').toBeGreaterThan(-1)
    expect(pick, 'pickEntry not found in enter()').toBeGreaterThan(-1)
    expect(pick, 'the filters must come after startObservation').toBeGreaterThan(obs)
  })

  it('releases the curve rather than untracking it, like every other decline in enter()', () => {
    // untrack stops applyLog feeding the open observation, which is exactly how a halted
    // bot went blind before. The gate rejection right below it makes the same choice.
    const enter = bot.slice(bot.indexOf('private async enter('))
    const block = enter.slice(enter.indexOf('pickEntry('), enter.indexOf('const gate ='))
    expect(block).toMatch(/this\.releaseCurve\(/)
    expect(block, 'untrack would kill the observation this filter depends on').not.toMatch(/untrack/)
    // the reason reaches launches.entry_reject: bumpReject is called WITH the token
    expect(block).toMatch(/bumpReject\(pick\.reject, l\.token\)/)
  })

  it('the floors are non-zero and ordered against the observation universe', () => {
    expect(STRATEGY.minCreatorTaxBps).toBeGreaterThan(0)
    expect(STRATEGY.minCreatorTaxBps).toBeLessThan(STRATEGY.maxCreatorTaxBps)
    expect(STRATEGY.minExemptionsToEnter).toBeGreaterThan(0)
    // the book screen's floor sets launches.passed; the entry floor must not be BELOW it
    // or the two would disagree about which is the observation universe
    expect(STRATEGY.minExemptionsToEnter).toBeGreaterThanOrEqual(STRATEGY.book.minExemptions)
  })

  it('publishes the entry filters, so a replay scores the book actually running', () => {
    for (const k of ['minExemptionsToEnter', 'maxEntryPriceMultiple']) {
      expect(bot, `publishStrategy is missing ${k}`).toMatch(new RegExp(`${k}:`))
    }
  })

  it('the graduation guard sits after the slot is reserved and gives it back, and stays under any dev buy', () => {
    // fresh-curve scale: normal trades p99 5.41 / max 6.52, the bundle bags 8.6-10.4x and
    // the slow one 5.24x at decision; graduation itself is ~12.5x. The band is 4.5-5.5:
    // below 4 it starts blocking the slow-fill 'graduating' winners, above 6 a p99
    // in-flight move (x1.79) could carry a coin into graduation. 3 was shipped once and
    // would have blocked 44% of the book.
    expect(STRATEGY.maxEntryPriceMultiple).toBeGreaterThanOrEqual(4.5)
    expect(STRATEGY.maxEntryPriceMultiple).toBeLessThanOrEqual(5.5)
    const enter = bot.slice(bot.indexOf('private async enter('))
    const reserve = enter.indexOf('this.risk.reserve(')
    const guard = enter.indexOf('STRATEGY.maxEntryPriceMultiple')
    expect(guard).toBeGreaterThan(reserve)
    const block = enter.slice(guard, enter.indexOf('const minTokensOut'))
    expect(block).toMatch(/bumpReject\(`pumped /)
    expect(block).toMatch(/this\.risk\.unreserve\(sizeWei\)/)
    expect(block).toMatch(/this\.releaseCurve\(/)
    expect(block).not.toMatch(/untrack/)
  })
})

describe('boot order', () => {
  it('asks the gate and refreshes the template list BEFORE the streams start', () => {
    // a restart used to trade the first launches blind: the gate check sat after
    // logs.start() and feed.start(), so the first launch could arrive before it ran
    const bot = src('../src/bot.ts')
    const start = bot.slice(bot.indexOf('async start(): Promise<void> {'), bot.indexOf('async stop(): Promise<void> {'))
    const gate = start.indexOf('this.checkRegimeGate()')
    const tmpl = start.indexOf('this.refreshTemplateBlocklist()')
    const logs = start.indexOf('await this.logs.start()')
    expect(gate).toBeGreaterThan(-1)
    expect(logs).toBeGreaterThan(-1)
    expect(gate, 'checkRegimeGate must run before logs.start()').toBeLessThan(logs)
    expect(tmpl, 'refreshTemplateBlocklist must run before logs.start()').toBeLessThan(logs)
  })
})

describe('recon replays the clock the bot is running', () => {
  it('reads the clock from strategy_json rather than carrying a literal', () => {
    // The first version of this test only pinned the literal, which is a test-time check
    // on a runtime duplication: it catches the drift in CI but the deployed script is
    // still wrong until someone edits it. recon.py now reads maxHoldMs the same way
    // gatewatch.py reads gateHoldMs.
    const rp = src('../scripts/recon.py')
    expect(rp).toMatch(/def load_hold\(\)/)
    expect(rp).toMatch(/strategy_json/)
    expect(rp).toMatch(/\.get\("maxHoldMs"\)/)
    expect(rp).toMatch(/if not load_hold\(\)/)   // and it is actually called
  })

  it('reads the EXIT clock, not the gate window: they are decoupled', () => {
    const rp = src('../scripts/recon.py')
    expect(rp).not.toMatch(/get\("gateHoldMs"\)/)
  })

  it('its fallback still matches the shipped clock', () => {
    // the fallback only applies when strategy_json is unreadable, but a stale one would
    // silently grade a fresh database against the wrong clock
    const rp = src('../scripts/recon.py')
    const m = rp.match(/^HOLD_BLOCKS = (\d+)/m)
    expect(m, 'HOLD_BLOCKS fallback not found in recon.py').not.toBeNull()
    expect(Number(m![1])).toBe(STRATEGY.maxHoldMs / 100)
  })
})

describe('the simulator stays the only simulator', () => {
  // 2026-08-27: the box had grown 33 scripts that each replayed the curve their own way,
  // and 26 of them predated the execution calibration. One of those produced +$0.72/trade
  // for buying everything, in a 24h window where the live bot lost money, and it looked
  // exactly as authoritative as the correct answer. They were archived and replaced by
  // scripts/sim.py. This file is what stops the pile rebuilding itself.
  // scripts/ ONLY, and that boundary is the rule rather than an oversight. scripts/ is
  // what the bot and its monitors depend on, so a replay living there is production and
  // has to justify itself here. research/ is one-off analysis that imports sim.py and
  // engine.py rather than reimplementing them, which is the behaviour this guard wants.
  // A research script that grew its own curve maths belongs in scripts/ or nowhere.
  const dir = new URL('../scripts/', import.meta.url)
  const py = readdirSync(dir).filter((f) => f.endsWith('.py') && !f.startsWith('test_'))

  it('routes every replay through sim.py, with recon.py and gatewatch.py the deliberate exceptions', () => {
    // recon.py replays SINGLE booked trades against the chain to grade execution, on a box
    // where the sim's cache may not exist. It is a grader, not a strategy sweep.
    //
    // gatewatch.py (2026-09-05) replays each scored launch at every bar the bot trades,
    // under the bot's own exit rule, to feed STRATEGY.takeProfit.adaptive. It is a scorer
    // producing a policy INPUT, not a sweep producing a policy: it does not choose the bar
    // set (the bot publishes it), does not choose the exit rule (read from strategy_json),
    // and cannot run at any other configuration. The adaptive bar is meaningless unless it
    // replays exactly what the bot would do, which is why it must call engine.evaluate.
    //
    // Both are named here so a FOURTH replay has to be argued for rather than merely added.
    const replays = py.filter((f) => /engine\.evaluate/.test(readFileSync(new URL(f, dir), 'utf8')))
    expect(replays.sort()).toEqual(['gatewatch.py', 'recon.py', 'sim.py'])
  })

  it('carries the three execution corrections, all overridable for re-measurement', () => {
    const sim = readFileSync(new URL('sim.py', dir), 'utf8')
    for (const [k, v] of [['SIM_LATENCY', 12], ['SIM_XLAG', 6], ['SIM_POLL', 12]] as const) {
      expect(sim, `${k} missing or changed`).toMatch(
        new RegExp(`os\\.environ\\.get\\("${k}", ${v}\\)`),
      )
    }
    // the poll model is the one that is easiest to drop by accident, because without it the
    // engine still runs and simply returns better numbers than the bot can achieve
    expect(sim).toMatch(/def polled\(/)
    expect(sim).toMatch(/engine\.evaluate\(P, mk_rule\(c\), exit_lag=XLAG/)
  })

  it('reads the live strategy rather than keeping its own copy of it', () => {
    const sim = readFileSync(new URL('sim.py', dir), 'utf8')
    expect(sim).toMatch(/WHERE key='strategy_json'/)
    for (const k of ['maxHoldMs', 'takeProfitOtherwise', 'hardStopMultiple', 'deadCoinAfterMs']) {
      expect(sim, `live_config does not read ${k}`).toMatch(new RegExp(k))
    }
  })

  it('ends both standard windows at now, and derives their length from the bins', () => {
    const sim = readFileSync(new URL('sim.py', dir), 'utf8')
    // 24h in 8 bins of 3h, 7d in 7 bins of 24h. The window length is the product, so a bin
    // change cannot leave a stale total behind.
    expect(sim).toMatch(/BINS = \{"24h": \(8, 3\.0\), "7d": \(7, 24\.0\)\}/)
    expect(sim).toMatch(/end = int\(time\.time\(\) \* 1000\) if now is None else int\(now\)/)
    // an anchored epoch would make the window age out from under the label
    expect(sim).not.toMatch(/EPOCH_MS/)
  })
})

/**
 * A citation is a promise that a number can be re-derived. Both assertions below exist
 * because that promise was already broken the day the policy was written down.
 *
 * v1/research/README.md says a one-off analysis script is deleted once its question is
 * answered, and the answer moves into a config comment WITH THE SCRIPT NAME so the number
 * can be re-derived. On 2026-09-06 five comments in config.ts named scripts that live in
 * the ROOT research pass, which from bot/ reads as v1/research/, where they have never
 * existed; recon.py pointed at research/engine.py for a file that is scripts/engine.py.
 * Nothing failed, because a dead path in a comment throws nothing, ever.
 *
 * So the delete-a-one-off policy is only real if deleting a cited script breaks the suite.
 */
describe('a cited script and a documented switch both have to exist', () => {
  const files = (d: string, ext: RegExp) =>
    readdirSync(new URL(d, import.meta.url)).filter((f) => ext.test(f)).map((f) => `${d}${f}`)

  it('every research script a comment cites is where the comment says it is', () => {
    // ../research/x = the root research pass; research/x = v1/research/; scripts/x = here.
    // deploy.sh ships bot/ alone, so on the box the root pass is absent and only the
    // bot-local half of this can be checked. Skipping it there beats a deploy that fails
    // for a directory the box is never meant to have.
    const hasRoot = existsSync(new URL('../../research/', import.meta.url))
    const sources = ['../src/config.ts', ...files('../scripts/', /\.(py|cjs|ts)$/)]
    const missing: string[] = []
    for (const f of sources) {
      for (const [cite] of src(f).matchAll(/(?:\.\.\/)?research\/[a-z0-9_]+\.(?:py|ts|mjs|cjs)/g)) {
        const root = cite.startsWith('../')
        if (root && !hasRoot) continue
        const rel = root ? `../../${cite.slice(3)}` : `../${cite}`
        if (!existsSync(new URL(rel, import.meta.url))) missing.push(`${f} cites ${cite}`)
      }
    }
    expect(missing).toEqual([])
  })

  const envKeysReadBySrc = (): Set<string> => {
    const walk = (d: URL): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : e.name.endsWith('.ts') ? [new URL(e.name, d).pathname] : [])
    return new Set(
      walk(new URL('../src/', import.meta.url))
        .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]!)))
  }

  it('.env.example names every environment variable src reads', () => {
    // The file opens by claiming it lists every key the code reads, and CLAUDE.md sends the
    // reader there to find out what is live. It was one key short (PONS_TERMINAL_URL) on the
    // day it was written. Commented-out lines count: the point is that the key is documented,
    // not that it is set.
    const example = src('../.env.example')
    for (const k of [...envKeysReadBySrc()].sort()) expect(example, `.env.example does not mention ${k}`).toContain(k)
  })

  it('.env.example names every environment variable the SCHEMA declares', () => {
    // config/store.ts reads its fields as process.env[f.env], which the dot-access scan
    // above cannot see. Without this line every hot setting would quietly stop being
    // policed the day the store started reading them dynamically.
    const example = src('../.env.example')
    for (const k of ALL_ENV) expect(example, `.env.example does not mention ${k}`).toContain(k)
  })

  it('every environment variable src reads is declared in config/schema.ts', () => {
    // The other direction, and the one that matters most. The schema decides what is hot,
    // what needs a restart, what the bounds are and what the audit trail says; a key read
    // straight out of process.env somewhere in src/ has none of that and would be invisible
    // to the reload. Adding a setting means adding a row.
    const declared = new Set<string>(ALL_ENV)
    for (const k of [...envKeysReadBySrc()].sort()) {
      expect(declared, `${k} is read in src/ but not declared in config/schema.ts`).toContain(k)
    }
  })

  it('the money switches are hot, and the ones captured at boot are not', () => {
    // The classification is the safety property, not a label. TRADE_SIZE_ETH hot is the
    // whole feature; MODE hot would let a file edit switch a bot holding tokens into
    // shadow, where sells are signed and never sent and the position strands.
    for (const k of ['tradeSizeEth', 'bankrollEth', 'maxDrawdownEth', 'ethUsd', 'halt'] as const) {
      expect(HOT[k].scope, `${HOT[k].env} must be hot`).toBe('hot')
    }
    for (const k of ['MODE', 'LIVE', 'PRIVATE_KEY', 'DB_FILE', 'GATE_LIVE']) {
      expect(Object.keys(RESTART), `${k} must need a restart`).toContain(k)
      expect(Object.keys(HOT).map((h) => HOT[h as keyof typeof HOT].env)).not.toContain(k)
    }
  })

  it('every hot number has a floor and a ceiling', () => {
    // An unbounded number is how TRADE_SIZE_ETH=0.1 used to be accepted: canEnter then
    // refused every launch for 'above size ceiling' and the bot looked dead rather than
    // misconfigured. A refused value keeps the previous one instead.
    for (const k of HOT_KEYS) {
      const f = HOT[k]
      if (f.kind !== 'number') continue
      expect(f.min, `${f.env} has no floor`).toBeTypeOf('number')
      expect(f.max, `${f.env} has no ceiling`).toBeTypeOf('number')
      expect(f.min!).toBeLessThan(f.max!)
    }
    // and the trade size can never be configured above the hard capacity ceiling
    expect(HOT.tradeSizeEth.max).toBeLessThanOrEqual(STRATEGY.maxTradeSizeEth)
  })
})

/**
 * The code map states nine live numbers in prose. That is the fifth instance of the class
 * this file was written for: config.ts changed in seven of the last eight commits, and the
 * entry-price guard moved 3 -> 4.5 inside a single day. A doc quoting a bound the bot is
 * not running trains the reader to distrust the doc, exactly as a monitor does.
 *
 * These assert the NUMBER, not the sentence, so the prose can be rewritten freely and only
 * a stale value fails.
 */
describe('v1/README.md quotes the running strategy', () => {
  const readme = src('../README.md')
  const has = (what: string, text: string) => expect(readme, `README is stale on ${what}`).toContain(text)

  it('states the entry filters the bot actually applies', () => {
    // NOT the band's VALUE any more. Both ends became hot on 2026-09-15, so a literal here
    // would make the README stale on every .env edit, which is the opposite of a drift
    // guard. What cannot drift is the pair of key names and the screen bound behind them,
    // so those are what this pins. The values are checked against the running process by
    // `report`, which reads them live.
    has('tax band floor key', 'ENTRY_MIN_TAX_BPS')
    has('tax band ceiling key', 'ENTRY_MAX_TAX_BPS')
    has('screen bound', `${STRATEGY.maxCreatorTaxBps} bps`)
    has('exemption floor', `least ${STRATEGY.minExemptionsToEnter} exempt`)
    has('template block', `${STRATEGY.templateLossBlockMs / 60_000} minutes`)
    has('entry price guard', `${STRATEGY.maxEntryPriceMultiple}x`)
    has('buy slippage fuse', `${STRATEGY.buySlippageBps / 100}% slippage`)
  })

  it('states the exit rule the bot actually runs', () => {
    has('graduation exit', `${STRATEGY.graduationExitAt * 100}% supply`)
    has('adaptive window', `last ${STRATEGY.takeProfit.adaptive.window} scored`)
    has('adaptive fallback', `${STRATEGY.takeProfit.otherwise.toFixed(2)} fallback`)
    has('dead-coin bail', `${STRATEGY.deadCoin.afterMs / 1000} s below ${STRATEGY.deadCoin.belowMult}x`)
    has('hold clock', `${STRATEGY.maxHoldMs / 1000} s clock`)
    has('hard stop', `stop at ${STRATEGY.hardStopMultiple}x`)
    // the sell ladder is empty by measurement, so the doc must not promise rungs
    expect(STRATEGY.sellSlippageLadderBps).toEqual([])
    has('sell bound', `${STRATEGY.sellFinalMinQuoteOut} wei bound`)
  })

  it('lists every operational script, so a new one cannot arrive undocumented', () => {
    // scripts/ is production: the bot and its monitors depend on it, it changes rarely, and
    // an undocumented one is how a script becomes unowned. research/ is deliberately NOT
    // checked: one-offs are created and deleted freely there, and forcing a doc edit per
    // experiment would fight the policy that lets them be deleted.
    const listed = readdirSync(new URL('../scripts/', import.meta.url))
      .filter((f) => /\.(py|ts|cjs|mjs)$/.test(f))
    for (const f of listed) expect(readme, `README does not mention scripts/${f}`).toContain(f)
  })

  it('keeps curve replay out of research/, which the simulator guard already claims', () => {
    // configdrift's simulator guard says research/ imports engine and sim rather than
    // reimplementing them. It only ever scanned scripts/, so the claim was never enforced
    // where it was made. True for all of research/ today, which is why it is cheap now.
    const dir = new URL('../research/', import.meta.url)
    const own = readdirSync(dir)
      .filter((f) => f.endsWith('.py') && !f.startsWith('test_'))
      .filter((f) => /^def (path|evaluate|_proceeds)\(/m.test(readFileSync(new URL(f, dir), 'utf8')))
    expect(own, 'a research script grew its own curve maths; it belongs in scripts/ or nowhere').toEqual([])
  })
})
