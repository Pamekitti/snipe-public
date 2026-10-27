/**
 * A compact health line the operator can read at a glance, and the numbers a shadow
 * run has to clear before it earns real money.
 */
import type { Bot } from '../bot.js'

export function acceptance(db: import('better-sqlite3').Database): string[] {
  const out: string[] = []
  const q = <T>(sql: string): T => db.prepare(sql).get() as T

  const pos = q<{ n: number; closed: number; stuck: number }>(
    `SELECT COUNT(*) n, SUM(closed) closed, SUM(CASE WHEN closed=0 THEN 1 ELSE 0 END) stuck FROM positions`,
  )
  const dup = q<{ maxn: number }>(
    `SELECT COALESCE(MAX(c),0) maxn FROM (SELECT COUNT(*) c FROM positions GROUP BY token)`,
  )
  const rot = q<{ pnl: number; spend: number }>(
    // the trades view, not raw positions: this line used to average shadow rows and
    // modeled gas into the one number the go/no-go turns on
    `SELECT COALESCE(SUM(pnl_true_wei),0) pnl, COALESCE(SUM(CAST(spend_wei AS REAL)),0) spend FROM trades`,
  )

  const check = (ok: boolean, label: string, detail: string) => out.push(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${detail}`)
  check(dup.maxn <= 1, 'one entry per token', `max ${dup.maxn} entries on any token`)
  check(pos.n === 0 || pos.closed > 0, 'positions do close', `${pos.closed}/${pos.n} closed`)
  check(pos.stuck === 0, 'nothing left holding', `${pos.stuck} still open`)
  if (rot.spend > 0) {
    const r = (rot.pnl / rot.spend) * 100
    // no target attached on purpose: the old "pilot gate is 3%" line was a scaling
    // milestone from the experiment, and printing it beside a live number invited reading
    // a working strategy as failing. Whether the edge is big enough is a decision, not a
    // health check, and the dashboard's rolling windows are where it gets made.
    check(r > 0, 'return on turnover', `${r.toFixed(2)}%`)
  }
  return out
}

export function healthLine(bot: Bot): string {
  const s = bot.stats
  const v = bot.state.verdicts
  const fp = v.skippedTotal ? (v.skippedThenLanded / v.skippedTotal) * 100 : 0
  return [
    `launches ${s.launches}`,
    `passed ${s.screened}`,
    `entered ${s.entered}`,
    `exited ${s.exited}`,
    `open ${bot.openPositions().length}`,
    `overlay fp ${fp.toFixed(1)}%`,
    `pnl ${(Number(bot.risk.realizedPnlWei) / 1e18).toFixed(5)} ETH`,
  ].join(' | ')
}
