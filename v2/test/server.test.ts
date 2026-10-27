/**
 * The listener, which had no tests at all and carries the only button that stops a wallet.
 *
 * Everything here is a defect that was in the shipped code on 2026-09-16:
 *
 *   POST /api/control took no interest in who was calling, so any page the operator had open
 *   could fire a `stop` or a `reset` at a fixed tailnet address with a no-cors fetch.
 *
 *   An oversize body was destroyed with no reply, so the browser hung on a request that would
 *   never finish, on the stop path.
 *
 *   `error` could reply after `end` already had, which throws ERR_HTTP_HEADERS_SENT inside the
 *   request handler of the trading process.
 *
 * The server binds a real port on loopback, on 0 so the OS picks a free one. No fake http.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { serve } from '../projections/server.js'
import { History } from '../projections/history.js'
import { emptyState } from '../core/state.js'
import type { BookSpec, FrozenConfig, Switches } from '../core/config.js'
import type { ControlResult } from '../io/control.js'
import type { RpcRoutingStatus } from '../io/routing.js'
import { RpcRouteLedger } from '../io/routing.js'

const book: BookSpec = {
  id: 'alpha', minCreatorTaxBps: 0, maxCreatorTaxBps: 0, minExemptions: 3, templateLossBlockMs: 3_600_000,
  sizeWei: '5000000000000000', maxDrawdownWei: '15000000000000000',
  entry: { entryDelayMs: 2_000, entryFallbackLateMs: 600, maxEntryPriceMultiple: 4.5, buySlippageBps: 5_000 },
  exit: { maxHoldMs: 45_000, hardStopMultiple: 0.5, deadCoinAfterMs: 20_000, deadCoinBelowMultiple: 1.03, graduationExitAt: 0.12, maxSellAttempts: 20, exitRetryDelayMs: 300, sellFinalMinQuoteOutWei: '1' },
  takeProfit: { otherwise: 1.75, adaptiveWindow: 20, adaptiveBars: [1.25, 1.75] },
  guard: { window: 20, recoveryWindow: 8, openAt: 1, shutAt: -1, settleMs: 52_000, freshMs: 10_800_000, pnlBar: 1.75, maxReadingAgeMs: 10_800_000 },
}

const cfg: FrozenConfig = {
  specVersion: 1, books: [book],
  risk: {
    maxConcurrent: 14, maxTradeSizeWei: '20000000000000000', bankrollWei: '80000000000000000', drawdownStakes: 3,
    maxWalletDrawdownWei: '60000000000000000',
    brokenWindow: 20, brokenFactor: 0.78, brokenGapPp: 15, maxLogsStalenessMs: 3000, maxOverlayAgeMs: 1500,
  },
  clock: { periodMs: 250 },
}

const SW: Switches = { sizeWei: 5_000_000_000_000_000n, mode: 'live', at: 0, by: 'test' }

const OK: ControlResult = { code: 200, do: 'stop', why: 'test', said: 'stopped' } as ControlResult

let servers: Server[] = []

afterEach(() => {
  for (const s of servers) s.close()
  servers = []
})

async function start(
  onControl?: (action: unknown, book?: unknown, sizeEth?: unknown, positionId?: unknown, apiMode?: unknown) => ControlResult | Promise<ControlResult>,
  rpcRouting?: RpcRoutingStatus,
): Promise<string> {
  const state = { ...emptyState(cfg, SW), at: 1_000_000 }
  const history = new History()
  const server = serve({
    port: 0, host: '127.0.0.1',
    current: () => state,
    history: () => history,
    options: { unavailable: {}, ethUsd: null, ...(rpcRouting ? { rpcRouting } : {}) },
    ...(onControl ? { onControl } : {}),
  })
  servers.push(server)
  // `listen` is asynchronous, so the port is not assigned until the socket is actually bound.
  if (server.address() === null) await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('the control endpoint', () => {
  it('shows the rescue exception and Paid recommendation while keeping monitor controls unavailable', async () => {
    const routing: RpcRoutingStatus = { ...new RpcRouteLedger(null).status(true, true),
      api: { selected: 'economy', effective: 'economy', preparing: false, changedAt: null, error: null,
        paidExitRescue: 'uncapped', publicCoverageAgeMs: 4_000, failures1h: 1,
        recommendPaid: true, reason: 'public data <unavailable>' } }
    const live = await start(() => OK, routing)
    const html = await (await fetch(live)).text()
    expect(html).toContain('data-api-mode="economy"')
    expect(html).toContain('paid exit rescue enabled · no rescue cap')
    expect(html).toContain('Paid recommended: public data &lt;unavailable&gt;')
    const monitor = await start(undefined, routing)
    expect(await (await fetch(monitor)).text()).not.toContain('data-action="set-api-mode"')
  })
  it('passes the API selection without changing existing control arguments', async () => {
    let seen: readonly unknown[] = []
    const base = await start((action, book, size, position, mode) => {
      seen = [action, book, size, position, mode]
      return { do: 'set-api-mode', code: 200, why: 'ready', apiMode: 'economy' }
    })
    const result = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ action: 'set-api-mode', apiMode: 'economy' }) })
    expect(result.status).toBe(200)
    expect(seen).toEqual(['set-api-mode', undefined, undefined, undefined, 'economy'])
  })
  it('accepts a POST with no Origin, which is how curl and the report skill reach it', async () => {
    let seen: unknown = null
    const base = await start((action) => { seen = action; return OK })
    const r = await fetch(`${base}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { kind: 'stop' } }),
    })
    expect(r.status).toBe(200)
    expect(seen).toEqual({ kind: 'stop' })
  })

  it('accepts a POST whose Origin is this server', async () => {
    const base = await start(() => OK)
    const r = await fetch(`${base}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ action: { kind: 'stop' } }),
    })
    expect(r.status).toBe(200)
  })

  it('passes a per-book decimal size through without converting it to float64', async () => {
    let seen: readonly unknown[] = []
    const base = await start((action, book, sizeEth) => {
      seen = [action, book, sizeEth]
      return { do: 'set-size', code: 200, why: 'test' }
    })
    const r = await fetch(`${base}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ action: 'set-size', book: 'alpha', sizeEth: '0.0025' }),
    })
    expect(r.status).toBe(200)
    expect(seen).toEqual(['set-size', 'alpha', '0.0025'])
  })

  it('waits for asynchronous START preparation and preserves the response shape', async () => {
    const base = await start(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { do: 'start', code: 200, why: 'resumed after paid catch-up' }
    })
    const r = await fetch(`${base}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ do: 'start', code: 200, why: 'resumed after paid catch-up' })
  })

  it('refuses a POST from another page, without asking the fold anything', async () => {
    // The attack needs no reply and no permission: a no-cors fetch from any site the operator
    // visits, at an address that is a fixed tailnet IP and a fixed port. `onControl` must never
    // be reached, because reaching it is the whole cost.
    let called = false
    const base = await start(() => { called = true; return OK })
    const r = await fetch(`${base}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://not-the-dashboard.example' },
      body: JSON.stringify({ action: { kind: 'stop' } }),
    })
    expect(r.status).toBe(403)
    expect(called).toBe(false)
  })

  it('404s on a process that cannot control anything, so the monitor cannot pretend', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/control`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(404)
  })

  it('answers 413 on an oversize body instead of hanging the browser', async () => {
    const base = await start(() => OK)
    const r = await fetch(`${base}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'x'.repeat(200_000) }),
    })
    expect(r.status).toBe(413)
  })

  it('answers 400 once on a body that is not JSON', async () => {
    const base = await start(() => OK)
    const r = await fetch(`${base}/api/control`, { method: 'POST', body: 'not json at all' })
    expect(r.status).toBe(400)
  })
})

describe('the read-only endpoints', () => {
  it('serves the page', async () => {
    const r = await fetch(`${await start()}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(await r.text()).toContain('TOTAL REAL WALLET')
  })

  it('serves the machine contract with its schema, which pull.sh checks', async () => {
    const r = await fetch(`${await start()}/api/state`)
    const body = await r.json() as { schema: number; mode: string }
    expect(body.schema).toBe(2)
    expect(body.mode).toBe('live')
  })

  it('serves economy route status and counters in the machine contract', async () => {
    const routing: RpcRoutingStatus = {
      enabled: true, eligible: true, eligibilityReason: 'quiet STOP ALL', mode: 'public',
      consecutivePublicFailures: 0, cooldownUntil: 0,
      public: { requests: 4, failures: 1, fallbacks: 0, estimatedComputeUnits: 140 },
      paid: { requests: 2, failures: 0, fallbacks: 1, estimatedComputeUnits: 70 },
      recentMinutes: [],
    }
    const body = await (await fetch(`${await start(undefined, routing)}/api/state`)).json() as { rpcRouting: RpcRoutingStatus }
    expect(body.rpcRouting).toEqual(routing)
  })

  it('shows economy status on the dashboard', async () => {
    const routing: RpcRoutingStatus = {
      enabled: true, eligible: false, eligibilityReason: 'STOP ALL is not set', mode: 'ineligible',
      consecutivePublicFailures: 0, cooldownUntil: 0,
      public: { requests: 0, failures: 0, fallbacks: 0, estimatedComputeUnits: 0 },
      paid: { requests: 2, failures: 0, fallbacks: 0, estimatedComputeUnits: 70 }, recentMinutes: [],
    }
    const html = await (await fetch(`${await start(undefined, routing)}/`)).text()
    expect(html).toContain('RPC economy ineligible')
    expect(html).toContain('STOP ALL is not set')
  })

  it('treats exits=all as every book', async () => {
    const r = await fetch(`${await start()}/api/regions?exits=all`)
    expect(r.status).toBe(200)
    const body = await r.json() as { exits: string }
    expect(body.exits).toContain('data-exits-book="all"')
    expect(body.exits).toContain('class="tab on"')
  })

  it('uses one lookback, and a leftover ?wh= still selects it', async () => {
    const base = await start()
    expect(await (await fetch(`${base}/?h=1h`)).text()).toContain('data-window="1h"')
    const fromWh = await (await fetch(`${base}/?wh=7d`)).text()
    expect(fromWh).toContain('data-window="7d"')
    expect(fromWh).not.toContain('data-wallet-window')
  })

  it('serves every region the client knows how to patch', async () => {
    const r = await fetch(`${await start()}/api/regions`)
    const body = await r.json() as Record<string, string>
    for (const id of ['hdr', 'alerts', 'wallet', 'walletchart', 'walletpayload', 'books', 'kpis', 'charts', 'chartpayload', 'open', 'exits']) {
      expect(typeof body[id]).toBe('string')
    }
  })

  it('serves a PNG at the path iOS asks for when pinning to the home screen', async () => {
    // The catch-all used to return the HTML page here. Safari discarded it and drew "P".
    const r = await fetch(`${await start()}/apple-touch-icon.png`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    const buf = Buffer.from(await r.arrayBuffer())
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(buf.readUInt32BE(16)).toBe(180)
    expect(buf.readUInt32BE(20)).toBe(180)
  })

  it('serves the tab mark and the Android manifest from the same origin', async () => {
    const base = await start()
    const svg = await fetch(`${base}/favicon.svg`)
    expect(svg.headers.get('content-type')).toContain('image/svg+xml')
    expect(await svg.text()).toContain('viewBox="0 0 32 32"')
    const manifest = await fetch(`${base}/manifest.webmanifest`)
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json')
    const body = await manifest.json() as { short_name: string; icons: { src: string }[] }
    expect(body.short_name).toBe('PONS')
    expect(body.icons.some((i) => i.src === '/icon-192.png')).toBe(true)
  })

  it('does not take control instructions over GET', async () => {
    let called = false
    const base = await start(() => { called = true; return OK })
    // A GET is reachable from an <img> tag and from a link. It must fall through to the page.
    const r = await fetch(`${base}/api/control?action=stop`)
    expect(called).toBe(false)
    expect(r.headers.get('content-type')).toContain('text/html')
  })
})
