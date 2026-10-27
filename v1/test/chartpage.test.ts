import { describe, expect, it, vi } from 'vitest'
import { makeGateDb } from './helpers/gatedb.js'
import Database from 'better-sqlite3'

/**
 * The chart runs inside the trading process, and dashboard-page.ts is imported during bot
 * startup. So the failures worth testing here are not "the chart looks wrong", they are
 * "the page took the bot down with it" and "the page rendered a lie".
 */


describe('paper wallet pane', () => {
  it('declares the pane, its title slot and its legend toggle', async () => {
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const page = dashboardShell()
    expect(page).toContain('id="panePaper"')
    expect(page).toContain('id="paperValue"')
    expect(page).toContain('data-line="dark"')
    // it must sit directly under the account pane, which is the whole point of the layout
    expect(page.indexOf('id="paneWallet"')).toBeLessThan(page.indexOf('id="panePaper"'))
    expect(page.indexOf('id="panePaper"')).toBeLessThan(page.indexOf('id="paneVenue"'))
  })

  it('registers the pane for zoom sync and resizing', async () => {
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const page = dashboardShell()
    expect(page).toContain("const PANE_KEYS = ['wallet','paper','venue','volume']")
    // a key in PANE_KEYS with no height gives setSize({height:undefined})
    expect(page).toMatch(/const PANE_H = \{[^}]*paper:\s*\d+/)
  })

  it('keeps the ids alphanumeric so the smoke harness discovers them', () => {
    // scripts/chart-smoke.mjs finds elements with /\bid="([a-zA-Z0-9]+)"/g
    for (const id of ['panePaper', 'paperValue']) expect(id).toMatch(/^[a-zA-Z0-9]+$/)
  })
})

describe('vendored uPlot', () => {
  it('is actually inlined, because a silent miss still returns HTTP 200', async () => {
    const { dashboardHtml, vendorLoaded } = await import('../src/telemetry/dashboard-page.js')
    expect(vendorLoaded()).toBe(true)
    const h = dashboardHtml()
    expect(h).toContain('uPlot')
    // the bundle is ~51 KB; anything near the bare page means the splice quietly no-opped
    expect(h.length).toBeGreaterThan(45_000)
    expect(h).not.toContain('__UPLOT_JS__')
    expect(h).not.toContain('__UPLOT_CSS__')
  })

  it('survives the bundle going missing instead of throwing', async () => {
    // this is the whole reason loadVendor is exported. An unguarded readFileSync at module
    // scope turns a deleted asset into a bot that will not boot, which is a far worse
    // outcome than a page with no chart on it.
    const { loadVendor } = await import('../src/telemetry/dashboard-page.js')
    expect(() => loadVendor('/nope/not/here')).not.toThrow()
    expect(loadVendor('/nope/not/here')).toEqual({ js: '', css: '' })
  })

  it('leaves valid CSS and JS behind when the bundle is empty', async () => {
    // the placeholders are comments in both languages on purpose, so a failed splice
    // degrades to a no-op rather than a syntax error that blanks the whole page
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const shell = dashboardShell()
    expect(shell).toContain('<style>/*__UPLOT_CSS__*/</style>')
    expect(shell).toContain('<script>/*__UPLOT_JS__*/</script>')
  })

  it('does not let the bundle interfere with String.replace substitution patterns', async () => {
    // $&, $` and $1 inside a replacement STRING are substitution patterns. The current
    // build has none, so this guards the next version bump rather than today.
    const { readFileSync } = await import('node:fs')
    const js = readFileSync('src/telemetry/vendor/uPlot.iife.min.js', 'utf8')
    for (const pat of ['$&', '$`', "$'"]) expect(js).not.toContain(pat)
  })
})

describe('coins and outcomes buckets', () => {
  /** a bot.db with just what chartSnapshot touches, plus the shadow account's table */
  const botDb = () => {
    const d = new Database(':memory:')
    d.exec(`CREATE TABLE launches (token TEXT PRIMARY KEY, detected_at INTEGER,
            passed INTEGER, reject_reason TEXT)`)
    d.exec(`CREATE TABLE positions (id INTEGER PRIMARY KEY, live INTEGER, spend_wei TEXT,
            pnl_wei TEXT, onchain_pnl_wei TEXT, exit_reason TEXT, exit_at INTEGER,
            closed INTEGER, token TEXT, hold_ms INTEGER)`)
    d.exec(`CREATE TABLE balance (at INTEGER PRIMARY KEY, wei TEXT, open_n INTEGER, deployed_wei TEXT)`)
    d.exec(`CREATE TABLE health (id INTEGER PRIMARY KEY, at INTEGER, component TEXT, ok INTEGER, detail TEXT)`)
    d.exec(`CREATE TABLE shadow_jobs (id INTEGER PRIMARY KEY, token TEXT, config TEXT, entry INTEGER,
            status TEXT, published_at INTEGER, available INTEGER, pnl TEXT, size TEXT)`)
    return d
  }

  it('sizes a bucket per lookback so no view is a smear or a forest', async () => {
    const { LOOKBACKS, BUCKET_MS } = await import('../src/telemetry/dashboard.js')
    expect(Object.keys(BUCKET_MS).sort()).toEqual(Object.keys(LOOKBACKS).sort())
    for (const k of Object.keys(LOOKBACKS)) {
      const bars = LOOKBACKS[k]! / BUCKET_MS[k]!
      expect(bars).toBeGreaterThanOrEqual(24)
      expect(bars).toBeLessThanOrEqual(64)
    }
  })

  it('does not import pre-epoch launches when the forward ledger is empty', async () => {
    const { chartSnapshot } = await import('../src/telemetry/dashboard.js')
    const d = botDb()
    const now = Date.now()
    const ins = d.prepare('INSERT INTO launches (token,detected_at,passed,reject_reason) VALUES (?,?,?,?)')
    for (let i = 0; i < 10; i++) ins.run(`0x${i}`, now - 60_000, i < 3 ? 1 : 0, i < 3 ? null : 'dev buy 1')

    const cd: any = chartSnapshot({ tel: { raw: () => d } } as any, '1h')
    expect(cd.outcomes.buckets).toEqual([])
  })

  it('splits the passed segment by simulated outcome once the shadow account publishes', async () => {
    const { outcomeBuckets } = await import('../src/telemetry/dashboard-policy.js')
    const d = botDb()
    const now = Date.now()
    const ins = d.prepare('INSERT INTO launches (token,detected_at,passed,reject_reason) VALUES (?,?,?,?)')
    // 6 passes and 4 filtered out
    for (let i = 0; i < 6; i++) ins.run(`0x${i}`, now - 60_000, 1, null)
    for (let i = 6; i < 10; i++) ins.run(`0x${i}`, now - 60_000, 0, 'dev buy 1')
    const job = d.prepare('INSERT INTO shadow_jobs (id,token,config,entry,status,published_at,available,pnl,size) VALUES (?,?,?,?,?,?,?,?,?)')
    // two winners, one loser, one still modeled, and one the source could not serve
    job.run(1, '0x0', 'a', now - 60_000, 'published', now - 30_000, now - 30_000, '500', '1000')
    job.run(2, '0x1', 'a', now - 60_000, 'published', now - 30_000, now - 30_000, '250', '1000')
    job.run(3, '0x2', 'a', now - 60_000, 'published', now - 30_000, now - 30_000, '-100', '1000')
    job.run(4, '0x3', 'a', now - 60_000, 'modeled', null, null, null, null)
    job.run(5, '0x4', 'a', now - 60_000, 'unavailable', null, null, null, null)

    const cd: any = { outcomes: outcomeBuckets(d,now-3600000,now,120000) }
    const b = cd.outcomes.buckets.find((x: any) => x.total === 10)
    expect(b.passed).toBe(6)
    expect(b.win).toBe(2)
    expect(b.loss).toBe(1)
    expect(b.pending).toBe(1)
    // the unavailable job and the pass with no job at all are both "not simulated"
    expect(b.notSimulated).toBe(2)
    expect(b.filtered).toBe(4)
    expect(b.win + b.loss + b.flat + b.pending + b.notSimulated + b.filtered).toBe(b.total)
    expect(b.pos).toBeCloseTo(0.75, 9)
    expect(b.neg).toBeCloseTo(-0.1, 9)
    expect(b.net).toBeNull() // pending and unavailable results prevent a complete bucket return
  })

  it('keeps one outcome per coin when several policy versions simulated it', async () => {
    // shadow_jobs is UNIQUE(token,config), so a policy change leaves two rows for one coin.
    // Counting both would double the bar and double-count the stakes.
    const { outcomeBuckets } = await import('../src/telemetry/dashboard-policy.js')
    const d = botDb()
    const now = Date.now()
    d.prepare('INSERT INTO launches (token,detected_at,passed,reject_reason) VALUES (?,?,?,?)')
      .run('0xa', now - 60_000, 1, null)
    const job = d.prepare('INSERT INTO shadow_jobs (id,token,config,entry,status,published_at,available,pnl,size) VALUES (?,?,?,?,?,?,?,?,?)')
    job.run(1, '0xa', 'old', now - 60_000, 'published', now - 40_000, now - 40_000, '500', '1000')
    job.run(2, '0xa', 'new', now - 60_000, 'published', now - 20_000, now - 20_000, '-250', '1000')

    const cd: any = { outcomes: outcomeBuckets(d,now-3600000,now,120000) }
    const b = cd.outcomes.buckets.find((x: any) => x.total === 1)
    expect(b.win).toBe(0)
    expect(b.loss).toBe(1)          // the latest publication wins
    expect(b.net).toBeCloseTo(-0.25, 9)
    expect(b.configs).toEqual(['new'])
  })

  it('invalidates a bucket rather than reading a missing stake as a flat trade', async () => {
    const { outcomeBuckets } = await import('../src/telemetry/dashboard-policy.js')
    const d = botDb()
    const now = Date.now()
    const ins = d.prepare('INSERT INTO launches (token,detected_at,passed,reject_reason) VALUES (?,?,?,?)')
    ins.run('0xa', now - 60_000, 1, null)
    ins.run('0xb', now - 60_000, 1, null)
    const job = d.prepare('INSERT INTO shadow_jobs (id,token,config,entry,status,published_at,available,pnl,size) VALUES (?,?,?,?,?,?,?,?,?)')
    job.run(1, '0xa', 'a', now - 60_000, 'published', now - 30_000, now - 30_000, '500', '1000')
    job.run(2, '0xb', 'a', now - 60_000, 'published', now - 30_000, now - 30_000, null, '1000')

    const cd: any = { outcomes: outcomeBuckets(d,now-3600000,now,120000) }
    const b = cd.outcomes.buckets.find((x: any) => x.total === 2)
    expect(b.win).toBe(1)
    expect(b.missing).toBe(1)
    expect(b.net).toBeNull()
  })

  it('keys a coin to the bucket it launched in, not the one it published in', async () => {
    // publication happens after the modeled close and the watcher's pass, minutes later. A
    // bar must describe the coins that launched in it, or volume and outcome disagree.
    const { BUCKET_MS } = await import('../src/telemetry/dashboard.js')
    const { outcomeBuckets } = await import('../src/telemetry/dashboard-policy.js')
    const d = botDb()
    const now = Date.now()
    const bucket = BUCKET_MS['1h']!
    const at = now - 3 * bucket
    d.prepare('INSERT INTO launches (token,detected_at,passed,reject_reason) VALUES (?,?,?,?)')
      .run('0xa', at, 1, null)
    d.prepare('INSERT INTO shadow_jobs (id,token,config,entry,status,published_at,available,pnl,size) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(1, '0xa', 'a', at, 'published', at + 2 * bucket, at + 2 * bucket, '500', '1000')

    const cd: any = { outcomes: outcomeBuckets(d,now-3600000,now,120000) }
    const launched = cd.outcomes.buckets.find((x: any) => x.t === Math.floor(at / bucket) * bucket)
    expect(launched.total).toBe(1)
    expect(launched.win).toBe(1)
    // and the publication bucket holds nothing: a bar describes the coins that launched in it
    const published = cd.outcomes.buckets.find((x: any) => x.t === Math.floor((at + 2 * bucket) / bucket) * bucket)
    expect(published?.win ?? 0).toBe(0)
    expect(cd.outcomes.buckets.filter((x: any) => x.win > 0)).toHaveLength(1)
  })
})

describe('market return reconstruction', () => {
  it('keeps missing certified history separate from venue estimates', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Telemetry } = await import('../src/telemetry/db.js')
    const dir = mkdtempSync(join(tmpdir(), 'market-history-'))
    const now = Date.now()
    const tel = new Telemetry(':memory:')
    try {
      const gate = makeGateDb(join(dir, 'gate.db'))
      const launch = tel.raw().prepare(`INSERT INTO launches
        (token,block,launched_at,detected_at,creator_tax_bps,exemptions,passed) VALUES (?,?,?,?,?,?,1)`)
      for (let i = 0; i < 24; i++) {
        const token = `0xmarket${i}`
        const at = now - (24 - i) * 60_000
        launch.run(token, 1_000 + i, Math.floor(at / 1000), at, 100, 3)
        gate.obs({ token, block: 1_000 + i, launched_at: Math.floor(at / 1000), at: at + 60_000,
          bars: JSON.stringify({ '1.75': i % 2 ? 0.2 : -0.1 }) })
      }
      gate.close()
      process.env.GATE_DB = join(dir, 'gate.db')
      vi.resetModules()
      const { chartSnapshot } = await import('../src/telemetry/dashboard.js')
      const cd: any = chartSnapshot({ tel: { raw: () => tel.raw() } } as any, '1h', now)
      expect(cd.market.some((point: any) => point.source === 'reconstructed')).toBe(false)
      // The recorder has nothing, so coverage is empty and the whole drawn line is rebuilt.
      // How much was rebuilt now rides on `marketRebuilt`, not on the recorder's coverage.
      expect(cd.marketCoverage).toMatchObject({ recorded: 0 })
      expect(cd.marketRebuilt.points).toBe(0)
      expect(cd.marketRebuilt.spans).toEqual([])
    } finally {
      tel.raw().close()
      delete process.env.GATE_DB
      vi.resetModules()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bucket arithmetic', () => {
  it('collapses many launches into few buckets', async () => {
    // The regression this exists for: a bound divisor binds as REAL, so (t / ?) * ? is
    // float division and hands back t, giving one bucket per launch. Every bucket still
    // reads correctly on its own, so only the COUNT catches it. A fixture whose rows share
    // a timestamp cannot see this at all - these must be spread across the window.
    const { BUCKET_MS } = await import('../src/telemetry/dashboard.js')
    const { scenarioOutcomeBuckets } = await import('../src/telemetry/dashboard-paper.js')
    const d = new Database(':memory:')
    d.exec(`CREATE TABLE launches (token TEXT PRIMARY KEY, detected_at INTEGER,
            passed INTEGER, reject_reason TEXT)`)
    d.exec(`CREATE TABLE positions (id INTEGER PRIMARY KEY, live INTEGER, spend_wei TEXT,
            pnl_wei TEXT, onchain_pnl_wei TEXT, exit_reason TEXT, exit_at INTEGER,
            closed INTEGER, token TEXT, hold_ms INTEGER)`)
    d.exec(`CREATE TABLE balance (at INTEGER PRIMARY KEY, wei TEXT, open_n INTEGER, deployed_wei TEXT)`)
    d.exec(`CREATE TABLE health (id INTEGER PRIMARY KEY, at INTEGER, component TEXT, ok INTEGER, detail TEXT)`)
    const ins = d.prepare('INSERT INTO launches (token,detected_at,passed,reject_reason) VALUES (?,?,?,?)')
    const now = Date.now()
    // 600 launches, one every 6s, across the last hour
    for (let i = 0; i < 600; i++) ins.run(`0x${i}`, now - i * 6_000, i % 5 === 0 ? 1 : 0, i % 5 === 0 ? null : 'dev buy 1')

    const coins:any[]=[]
    for(let i=0;i<600;i++)coins.push({token:`0x${i}`,at:now-i*6_000,availableAt:now,pnlWei:'1',sizeWei:'1',status:'closed',reason:'time',value:1,indicatorEvidence:true,admission:{status:'admitted',reason:'admitted'},actual:{status:'no_attempt_recorded',reason:null}})
    const bars = 3600_000 / BUCKET_MS['1h']!
    const bs = scenarioOutcomeBuckets(d,null,now-3600_000,now,BUCKET_MS['1h']!,coins,true).buckets
    expect(bs.length).toBeLessThanOrEqual(bars + 1)
    expect(bs.length).toBeGreaterThan(5)
    // every bucket boundary must be a clean multiple of the bucket width
    for (const b of bs) expect(b.t % BUCKET_MS['1h']!).toBe(0)
    // and nothing may be lost or double counted
    const tot = bs.reduce((a: number, b: any) => a + b.total, 0)
    expect(tot).toBe(bs.reduce((a: number, b: any) => a + b.win + b.loss + b.flat + b.pending + b.notSimulated + b.filtered, 0))
  })
})

describe('the page template itself', () => {
  it('contains no backtick or ${ inside the String.raw body', async () => {
    // Three separate times a comment written with `backticks` around an identifier ended
    // the template literal mid-file and broke the build. The template is ~800 lines of
    // HTML/CSS/JS, so it is not something to keep catching by eye.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/telemetry/dashboard-page.ts', 'utf8')
    const open = src.indexOf('String.raw`')
    expect(open).toBeGreaterThan(0)
    const body = src.slice(open + 'String.raw`'.length, src.lastIndexOf('`'))
    const ticks = [...body.matchAll(/`/g)]
    const interps = [...body.matchAll(/\$\{/g)]
    const lineOf = (i: number) => body.slice(0, i).split('\n').length
    expect({ backticks: ticks.map((m) => lineOf(m.index!)) })
      .toEqual({ backticks: [] })
    // ${ would interpolate even under String.raw, which is how the vendor bundle had to be
    // spliced in by replace() rather than inline
    expect({ interpolations: interps.map((m) => lineOf(m.index!)) })
      .toEqual({ interpolations: [] })
  })
})

describe('recent exits', () => {
  it('neutralises markup in a creator-supplied name', async () => {
    // Coin name and symbol come from launch calldata, i.e. from whoever deployed the
    // token, and they go into innerHTML. A coin called <img src=x onerror=...> would
    // otherwise run script in the dashboard, which shares a process with the trading loop.
    // Testing the behaviour rather than grepping the source: call sites move, the
    // guarantee should not.
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const src = dashboardShell()
    const map = src.match(/const ESCMAP=\{[^\n]*\}/)
    const body = src.match(/function esc\(v\)\{[^\n]*\}/)
    expect(map).not.toBeNull()
    expect(body).not.toBeNull()
    const esc = new Function(map![0] + '; return (' + body![0] + ')')() as (v: unknown) => string

    const out = esc('<img src=x onerror="alert(1)">')
    expect(out).not.toContain('<')
    expect(out).not.toContain('>')
    expect(out).not.toContain('"')
    expect(esc("it's")).toBe('it&#39;s')
    expect(esc('a & b')).toBe('a &amp; b')
    expect(esc(null)).toBe('')

    // and the render path actually routes both fields through it
    const fn = src.slice(src.indexOf('function renderRecent'), src.indexOf('// ---------- chart'))
    expect(fn).toContain('esc(x.symbol || x.name)')
    expect(fn).toContain('esc(x.name)')
  })


  it('drops the funnel cards it replaced, markup and renderers both', async () => {
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const src = dashboardShell()
    for (const gone of ['fLaunch', 'fPass', 'fEnter', 'fExit', 'fPerDay', 'fPassDay', 'rejects']) {
      expect(src).not.toContain("$('" + gone + "')")
      expect(src).not.toContain('id="' + gone + '"')
    }
    expect(src).not.toContain('Why launches were rejected')
  })
})

describe('the strip replaces the cards it repeated', () => {
  it('removes obsolete diagnostic sections and their DOM writes', async () => {
    const { dashboardShell } = await import('../src/telemetry/dashboard-page.js')
    const page=dashboardShell()
    // the 2026-09-07 funnel cards, and the 2026-09-12 market card whose readings now sit
    // beside their own plots and in the strip's one sentence
    for(const id of ['gateState','vvVenue','feedRate','polState','prState','edState','dlP50','cumTrades','exitCheck',
                     'marketValue','marketVerdict','marketWindow','marketOff','marketOn','marketMeaning','recentMarket',
                     'marketCoverage','marketLineLabels','sizeCard','paneFlow','toggleFlow','ddPercent','ddLimit','nwRecon']) {
      expect(page).not.toContain('id="'+id+'"')
      expect(page).not.toContain("$('"+id+"')")
    }
    expect(page).toContain('id="volumeTotal"')
    expect(page).toContain('id="posBody"')
    expect(page).toContain('id="recBody"')
  })
})

/**
 * THE OPERATOR STRIP AND THE STATE HEADLINE (2026-09-13).
 *
 * dashboard-page.ts is one large template literal imported during bot startup, so a stray
 * backtick in a comment is not a cosmetic bug: it is a syntax error inside the trading
 * process. That is exactly what happened while writing this change. These checks are cheap
 * insurance that the page still parses and still carries the controls it claims to.
 */
describe('the page an operator actually reads', () => {
  it('renders, and carries the state headline, the strip and the reset control', async () => {
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const h = dashboardHtml()
    for (const needle of [
      'id="outcomeCard"', 'id="oStrip"', 'id="oSum"',        // the outcome strip
      'id="btnReset"', 'RESET DRAWDOWN', 'Confirm reset',    // the drawdown reset, two taps
      'function renderOutcomes', "'TRADING'", "'HALTED",     // the headline says the state
    ]) expect(h, needle).toContain(needle)
  })

  it('wires the strip into the state tick, not just into the markup', async () => {
    // a card that exists and is never painted is worse than no card: it reads as "no
    // outcomes" rather than "nobody told it"
    const { dashboardHtml } = await import('../src/telemetry/dashboard-page.js')
    const h = dashboardHtml()
    expect(h).toContain('renderOutcomes(s,mp)')
    // and the sum it prints must come from the rows it draws, never a second field
    expect(h).toContain("all.reduce(function (a, o) { return a + o.value; }, 0)")
  })
})
