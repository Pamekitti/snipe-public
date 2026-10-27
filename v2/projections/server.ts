/**
 * The listener: one page, one stream, one machine endpoint, one control.
 *
 * THE PAGE IS SENT ONCE AND PATCHED THEREAFTER. `/api/stream` is server-sent events carrying
 * only the regions whose HTML changed since that connection's last push. The old page reloaded
 * itself whole every two seconds, which destroyed the selected book, the scroll position and
 * any expanded row twice a second, and on a phone it meant re-parsing a document 1,800 times an
 * hour to watch a clock tick. A quiet minute here is a few hundred bytes.
 *
 * THE PROJECTION RUNS PER PUSH, so the page is never staler than the last folded event and
 * there is no cache to invalidate. Both folds are cheap: the view model is a walk over state
 * that is already in memory, and the history fold has already done its counting.
 *
 * `/api/state` IS A SEPARATE CONTRACT. It serves `report.ts`, which is flat, numeric and pinned
 * by a test, and it is the only thing the report skill reads. Keeping it apart from the view
 * model is what stops a column rename on the page from breaking the phone report, which is
 * exactly what happened at the v2 cutover.
 *
 * CONTROL IS OPTIONAL. The monitor omits `onControl`, so POST /api/control 404s and the page
 * shows "read only": that process cannot stop the bot that is actually trading. The live
 * process passes `onControl`, which is the only path that can halt entries without ssh.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { buildAlerts } from './alerts.js'
import { LEVELS } from './levels.js'
import { buildReport } from './report.js'
import { project, type ProjectOptions, type ViewModel } from './viewmodel.js'
import { iconResponse } from './app-icon.js'
import { REGIONS, renderPage, renderRegions, type Regions } from './render/page.js'
import { loadVendor } from './vendor.js'
import type { History } from './history.js'
import type { State } from '../core/state.js'
import type { ControlResult } from '../io/control.js'

export type ServeOptions = {
  readonly port: number
  /** bound to loopback by default: the box is reached over the tailnet, never the internet */
  readonly host?: string
  readonly current: () => State
  readonly history: () => History
  readonly options: ProjectOptions
  /**
   * Present only on the live process. The monitor omits it, so a STOP button there would
   * be a button that lies: that process cannot stop the bot that is actually trading.
   */
  readonly onControl?: (action: unknown, book?: unknown, sizeEth?: unknown, positionId?: unknown, apiMode?: unknown) => ControlResult | Promise<ControlResult>
}

const VENDOR = loadVendor()

export function serve(opts: ServeOptions): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    try {
      if (url.pathname === '/api/control' && req.method === 'POST') {
        if (!opts.onControl) {
          json(res, 404, { error: 'this process cannot halt, size or send' })
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'cross-origin control is refused: this button stops a wallet' })
          return
        }
        readJson(req, res, (body) => {
          void Promise.resolve(opts.onControl!(body.action, body.book, body.sizeEth, body.positionId, body.apiMode)).then((r) => {
            json(res, r.code, r)
          }).catch((error) => {
            json(res, 500, { error: `control failed: ${String((error as Error).message ?? error)}` })
          })
        })
        return
      }

      if (url.pathname === '/api/health') {
        const s = opts.current()
        json(res, 200, { ok: true, seq: s.seq, at: s.at })
        return
      }

      if (url.pathname === '/api/state') {
        const s = opts.current()
        json(res, 200, buildReport(s, opts.history(), opts.options.ethUsd, opts.options.providerCu ?? null, opts.options.rpcRouting ?? null))
        return
      }

      if (url.pathname === '/api/regions') {
        json(res, 200, regionsFor(opts, url))
        return
      }

      if (url.pathname === '/api/stream') {
        stream(opts, url, req, res)
        return
      }

      // iOS Add to Home Screen requests these by name. Serving the page here is how the
      // pinned icon became the letter P: Safari got HTML, discarded it, and used the title.
      const icon = iconResponse(url.pathname)
      if (icon) {
        res.writeHead(200, { 'content-type': icon.type, 'cache-control': 'public, max-age=86400' })
        res.end(icon.body)
        return
      }

      const { vm, alerts } = modelFor(opts, url)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderPage(vm, alerts, VENDOR))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`the projection failed to render: ${String((e as Error).message ?? e)}\nthe bot is unaffected; this endpoint is read-only.`)
    }
  })
  const host = opts.host ?? '127.0.0.1'
  server.on('error', (e) => {
    console.error(`v2: dashboard bind ${host}:${opts.port} failed: ${e instanceof Error ? e.message : String(e)}`)
  })
  server.listen(opts.port, host, () => {
    console.log(`v2: dashboard bound ${host}:${opts.port}`)
  })
  return server
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/**
 * One connection, one interval, one memory of what it was last sent.
 *
 * The diff is per connection rather than global because two viewers can be on different books,
 * so "what changed" is a different answer for each of them. At one or two operators the cost of
 * rendering per connection is a few milliseconds a second, and the alternative (a shared render
 * keyed by every combination of book, set and window) is a cache to invalidate in exchange for
 * nothing measurable.
 */
function stream(opts: ServeOptions, url: URL, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    /** proxies that buffer would defeat the whole point; nginx reads this one */
    'x-accel-buffering': 'no',
  })
  res.write(`retry: ${LEVELS.streamRetryMs}\n\n`)

  let last: Partial<Regions> = {}
  let lastSent = 0

  const push = (): void => {
    let next: Regions
    try {
      next = regionsFor(opts, url)
    } catch (e) {
      // A projection that throws must not kill the stream: the operator still needs the rest of
      // the page, and the bot is unaffected either way.
      res.write(`event: error\ndata: ${JSON.stringify(String((e as Error).message ?? e))}\n\n`)
      return
    }
    const changed: Partial<Regions> = {}
    let any = false
    for (const id of REGIONS) {
      if (last[id] !== next[id]) { changed[id] = next[id]; any = true }
    }
    last = next
    const now = Date.now()
    if (any) {
      res.write(`data: ${JSON.stringify(changed)}\n\n`)
      lastSent = now
    } else if (now - lastSent >= LEVELS.streamKeepAliveMs) {
      // A comment, not an event: it holds the socket open without the client having to ignore
      // an empty payload.
      res.write(`: keep-alive\n\n`)
      lastSent = now
    }
  }

  push()
  const timer = setInterval(push, LEVELS.streamMinIntervalMs)
  timer.unref?.()

  const close = (): void => { clearInterval(timer) }
  req.on('close', close)
  req.on('error', close)
  res.on('error', close)
}

// ---------------------------------------------------------------------------
// Building the model from a request
// ---------------------------------------------------------------------------

function modelFor(opts: ServeOptions, url: URL): { vm: ViewModel; alerts: ReturnType<typeof buildAlerts> } {
  const state = opts.current()
  const history = opts.history()
  const exits = url.searchParams.get('exits')
  const vm = project(state, history, {
    ...opts.options,
    canControl: Boolean(opts.onControl),
    selectedBook: url.searchParams.get('book'),
    windowLabel: url.searchParams.get('h') ?? url.searchParams.get('wh'),
    // An empty `exits` parameter is the "all books" filter, which is a real choice and not an
    // absent one, so it has to survive the round trip as null rather than as an empty string.
    exitsBook: exits === null || exits === '' || exits === 'all' ? null : exits,
  })
  return { vm, alerts: buildAlerts(state, history) }
}

function regionsFor(opts: ServeOptions, url: URL): Regions {
  const { vm, alerts } = modelFor(opts, url)
  return renderRegions(vm, alerts)
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * Is this POST from this page, or from some other page the operator happens to have open?
 *
 * THE THREAT IS NOT AN ATTACKER ON THE TAILNET. It is any website in the browser that has this
 * dashboard's address, which is a fixed tailnet IP and a fixed port. A form post or a `no-cors`
 * `fetch` needs no permission and no reply to be read: the request lands, the bot stops, and
 * the page that sent it never learns whether it worked. The endpoint took no interest in who
 * was calling, so that was a working stop button for anyone who guessed the address.
 *
 * ABSENT `Origin` IS ALLOWED, DELIBERATELY. curl and the report skill send no `Origin`, and
 * browsers attach one to every cross-site POST. So the rule is: if a browser told us where it
 * came from, it has to be here. This is not authentication and does not pretend to be; it is
 * the check that makes the button unusable from a page that is not this one.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '' || origin === 'null') return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  // bigint has no JSON form and several of these carry wei, so it is stringified rather than
  // thrown on. A consumer that wants to add them up gets a decimal string it can pass to BigInt.
  res.end(JSON.stringify(body, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
}

/**
 * The request body, or one refusal. EXACTLY ONE RESPONSE IS SENT, WHATEVER HAPPENS.
 *
 * Both failures used to be wrong in the same way. An oversize body called `req.destroy()` and
 * answered nothing, so the operator's browser sat on a request that would never complete and
 * the page's STOP button looked like it had hung. And `error` could fire after `end` had
 * already replied, which makes node throw `ERR_HTTP_HEADERS_SENT` inside the request handler,
 * on the stop path, in the trading process. `done` closes both.
 */
function readJson(req: IncomingMessage, res: ServerResponse, then: (body: { action?: unknown; book?: unknown; sizeEth?: unknown; positionId?: unknown; apiMode?: unknown }) => void): void {
  const chunks: Buffer[] = []
  let size = 0
  let done = false
  const finish = (fn: () => void): void => {
    if (done) return
    done = true
    fn()
  }
  req.on('data', (c: Buffer) => {
    if (done) return
    size += c.length
    if (size > LEVELS.controlBodyMaxBytes) {
      finish(() => {
        json(res, 413, { error: `a control body is at most ${LEVELS.controlBodyMaxBytes} bytes` })
        req.destroy()
      })
      return
    }
    chunks.push(c)
  })
  req.on('error', () => { finish(() => { json(res, 400, { error: 'read failed' }) }) })
  req.on('end', () => {
    finish(() => {
      let body: { action?: unknown; book?: unknown }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { action?: unknown; book?: unknown } }
      catch { json(res, 400, { error: 'body must be JSON' }); return }
      then(body)
    })
  })
}
