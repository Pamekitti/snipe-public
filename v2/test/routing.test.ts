import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcRouteLedger } from '../io/routing.js'

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('RPC route summaries', () => {
  it('persists paid rescue provenance and separates trailing spending windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-rescue-')); dirs.push(root)
    const path = join(root, 'routes.json'); let now = 60_000
    const first = new RpcRouteLedger(path, () => now)
    first.request('paid', 'eth_getLogs', 'logs')
    first.subscription(100, 'critical')
    now += 25 * 3_600_000
    first.request('paid', 'eth_getTransactionReceipt', 'exit-rescue', 'critical', 'position-1'); first.flush()
    const second = new RpcRouteLedger(path, () => now)
    const [day, week] = second.paidUsage(0.525)
    expect(day?.monitoring.cu).toBe(0)
    expect(day?.rescue).toEqual({ cu: 20, requests: 1, estimatedUsd: 20 * .525 / 1_000_000 })
    expect(week?.monitoring.cu).toBe(64)
    expect(second.lastExitRescue?.owner).toBe('position-1')
    expect(second.paidUsage(null)[0]?.rescue.estimatedUsd).toBeNull()
  })
  it('retains the last paid minute when restarting after its boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-boundary-')); dirs.push(root)
    const path = join(root, 'routes.json'); let now = 60_000
    const first = new RpcRouteLedger(path, () => now)
    first.request('paid', 'eth_getTransactionReceipt', 'exit-rescue', 'critical', 'position-1'); first.flush()
    now += 60_001
    const second = new RpcRouteLedger(path, () => now)
    expect(second.paidUsage(.525)[0]?.rescue.cu).toBe(20)
    expect(second.status(true, true).paid.requests).toBe(1)
  })
  it('counts routes and estimates separately from billing', () => {
    let now = 60_000
    const ledger = new RpcRouteLedger(null, () => now)
    ledger.request('public', 'eth_getLogs'); ledger.failure('public')
    ledger.request('paid', 'eth_getLogs'); ledger.fallback('paid')
    const status = ledger.status(true, true)
    expect(status.public).toEqual({ requests: 1, failures: 1, fallbacks: 0, estimatedComputeUnits: 60 })
    expect(status.paid).toEqual({ requests: 1, failures: 0, fallbacks: 1, estimatedComputeUnits: 60 })
  })

  it('persists cooldown and bounded minute summaries across restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-routes-')); dirs.push(root)
    const path = join(root, 'routes.json')
    let now = 60_000
    const first = new RpcRouteLedger(path, () => now, 2)
    first.request('public', 'eth_blockNumber'); first.publicFailure(); first.publicFailure()
    now += 3_000; first.flush()
    const second = new RpcRouteLedger(path, () => now, 2)
    const status = second.status(true, true)
    expect(status.mode).toBe('cooldown')
    expect(status.consecutivePublicFailures).toBe(2)
    now += 58_000; second.request('paid', 'eth_getLogs'); second.flush()
    const third = new RpcRouteLedger(path, () => now, 2)
    expect(third.status(true, true).recentMinutes).toHaveLength(2)
  })

  it('extends repeated outages to at most a minute and resets after public recovery', () => {
    const ledger = new RpcRouteLedger(null, () => 1000)
    ledger.publicFailure(); expect(ledger.cooldownUntil).toBe(0)
    ledger.publicFailure(); expect(ledger.cooldownUntil).toBe(6000)
    ledger.publicFailure(); expect(ledger.cooldownUntil).toBe(11000)
    ledger.publicFailure(); expect(ledger.cooldownUntil).toBe(21000)
    ledger.publicFailure(); expect(ledger.cooldownUntil).toBe(41000)
    ledger.publicFailure(); expect(ledger.cooldownUntil).toBe(61000)
    ledger.publicSuccess(); expect(ledger.cooldownUntil).toBe(0)
    expect(ledger.consecutivePublicFailures).toBe(0)
  })
})
