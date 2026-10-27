import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Telemetry } from '../src/telemetry/db.js'
import { recoverOpenPositions } from '../src/recovery.js'
import { settle } from './helpers/settle.js'

const WALLET = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as const
const HASH = '0x' + 'ab'.repeat(32)

/** multicall returns [balance, allowance, graduated] per row, in row order */
const chain = (rows: Array<[bigint | undefined, bigint, boolean?]>) => ({
  multicall: async () => rows.flatMap(([bal, allow, graduated]) => [
    bal === undefined ? { status: 'failure' as const } : { status: 'success' as const, result: bal },
    { status: 'success' as const, result: allow },
    { status: 'success' as const, result: graduated ?? false },
  ]),
}) as any

describe('recoverOpenPositions', () => {
  let dir: string
  let tel: Telemetry
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rec-'))
    tel = new Telemetry(join(dir, 'bot.db'))
  })
  afterEach(() => { tel.close(); rmSync(dir, { recursive: true, force: true }) })

  const open = (over: Record<string, unknown> = {}) => tel.openPosition({
    token: '0xtoken', curve: '0xcurve', live: 1,
    t_detect: 1, t_decide: 2, t_signed: 3, t_sent: 4,
    entry_block: 1000, spend_wei: '7500000000000000', min_tokens_out: '1',
    tokens_held: '0', entry_mark_wei: '0', buy_hash: HASH, buy_ok: 1, buy_error: null,
    take_profit: 1.25, ...over,
  })

  const rowOf = (id: number) => tel.raw()
    .prepare('SELECT closed, exit_reason, buy_error FROM positions WHERE id=?').get(id) as any

  it('adopts a position we still hold', async () => {
    const id = open()
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[500n, 9n]]))
    expect(out).toHaveLength(1)
    expect(out[0]!.tokens).toBe(500n)
    expect(out[0]!.positionId).toBe(id)
  })

  /**
   * THE ONE THAT MATTERS. buy_ok records what the SENDER thought, and sender.ts is explicit
   * that a transport failure "tells us nothing about whether it landed". The old query
   * filtered buy_ok = 1, so a buy that landed behind a failed-looking send was invisible to
   * recovery forever, and nothing else looks at closed = 0 rows. The tokens would sit in the
   * wallet with no owner and no exit manager.
   */
  it('adopts a landed buy even though the send reported failure', async () => {
    const id = open({ buy_ok: 0 })
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[500n, 0n]]))
    expect(out).toHaveLength(1)
    expect(out[0]!.positionId).toBe(id)
    expect(out[0]!.tokens).toBe(500n)
    expect(rowOf(id).closed).toBe(0) // still open, because we are holding it
  })

  it('closes a failed send that never landed, without claiming a sell happened', async () => {
    const id = open({ buy_ok: 0 })
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[0n, 0n]]))
    await settle()
    expect(out).toHaveLength(0)
    const r = rowOf(id)
    expect(r.closed).toBe(1)
    // NOT 'recovered-flat': that sends truth.ts hunting for a CurveSell that cannot exist
    expect(r.exit_reason).toBe('buy-never-mined')
    expect(r.buy_error).toContain('no tokens ever arrived')
  })

  it('still calls a flat buy_ok=1 row recovered-flat, so its sell gets priced', async () => {
    const id = open()
    await recoverOpenPositions(tel, WALLET, 1, chain([[0n, 0n]]))
    await settle()
    expect(rowOf(id).exit_reason).toBe('recovered-flat')
  })

  it('leaves a row open when the balance read fails, rather than abandoning a bag', async () => {
    const id = open()
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[undefined, 0n]]))
    await settle()
    expect(out[0]!.unknown).toBe(true)
    expect(rowOf(id).closed).toBe(0)
  })

  it('never touches rows from the other mode', async () => {
    open({ live: 0 })
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([]))
    expect(out).toEqual([])
  })

  it('ignores a row that never got as far as a hash', async () => {
    // nothing was ever signed or sent, so there is nothing on chain to reconcile against
    open({ buy_ok: 0, buy_hash: null })
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([]))
    expect(out).toEqual([])
  })

  it('keeps a graduated holding open and resumes it through the swap route', async () => {
    const id = open()
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[500n, 9n, true]]))
    await settle()
    expect(out[0]).toMatchObject({ positionId: id, graduated: true, tokens: 500n })
    expect(rowOf(id).closed).toBe(0)
    expect(tel.truthGet('stranded_bags')).toBeNull()
    expect(await recoverOpenPositions(tel, WALLET, 1, chain([[500n, 9n, true]]))).toHaveLength(1)
  })

  it('keeps a zero balance open when a durable swap receipt still needs reconciliation', async () => {
    const id = open()
    tel.raw().prepare('INSERT INTO graduation_exits(position_id,detected_at) VALUES (?,?)').run(id, 1)
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[0n, 9n, true]]))
    await settle()
    expect(out[0]).toMatchObject({ positionId: id, graduated: true })
    expect(rowOf(id).closed).toBe(0)
  })

  it('resumes a durable swap even when the boot balance read fails', async () => {
    const id = open()
    tel.raw().prepare('INSERT INTO graduation_exits(position_id,detected_at) VALUES (?,?)').run(id, 1)
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[undefined, 9n, true]]))
    expect(out[0]).toMatchObject({ positionId: id, graduated: true })
    expect(out[0]!.unknown).toBeUndefined()
  })

  it('a graduated curve we hold nothing of is simply flat', async () => {
    const id = open()
    await recoverOpenPositions(tel, WALLET, 1, chain([[0n, 0n, true]]))
    await settle()
    expect(rowOf(id).exit_reason).toBe('recovered-flat')
    expect(tel.truthGet('stranded_bags')).toBeNull()
  })

  it('a healthy curve still adopts, with no stranded flag', async () => {
    open()
    const out = await recoverOpenPositions(tel, WALLET, 1, chain([[500n, 9n, false]]))
    expect(out).toHaveLength(1)
    expect(out[0]!.graduated).toBeUndefined()
  })
})

const { readCurveRetry } = await import('../src/recovery.js')

describe('readCurveRetry (2026-09-06)', () => {
  const thirteen = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, false]

  it('retries the public rpc rate limit and returns the read once it answers', async () => {
    let calls = 0
    const via = { multicall: async () => { calls++; if (calls < 3) throw new Error('ContractFunctionExecutionError: An unknown RPC error occurred.'); return thirteen } }
    const slept: number[] = []
    const r = await readCurveRetry('0x' + '11'.repeat(20) as any, via as any, { sleep: async (ms) => { slept.push(ms) } })
    expect(calls).toBe(3)
    expect(slept).toEqual([250, 250])
    expect(r.params.creatorTaxBps).toBe(5n)
    expect(r.state.graduated).toBe(false)
  })

  it('gives up after the last try with the original error', async () => {
    let calls = 0
    const via = { multicall: async () => { calls++; throw new Error('HTTP request failed. Status: 429') } }
    await expect(readCurveRetry('0x' + '11'.repeat(20) as any, via as any, { sleep: async () => {} })).rejects.toThrow('429')
    expect(calls).toBe(3)
  })

  it('does not retry an error that is not the rpc being busy', async () => {
    let calls = 0
    const via = { multicall: async () => { calls++; throw new Error('execution reverted') } }
    await expect(readCurveRetry('0x' + '11'.repeat(20) as any, via as any, { sleep: async () => {} })).rejects.toThrow('reverted')
    expect(calls).toBe(1)
  })
})

describe('readCurve carries the block it read at (2026-09-06)', () => {
  it('returns THIS chain\'s block (ArbSys, never Multicall3.getBlockNumber) as the 14th value, and 0 when a fake omits it', async () => {
    const { readCurve, readCurveRetry, ARBSYS } = await import('../src/recovery.js')
    const fourteen = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, false, 555n]
    let asked: any[] = []
    const r = await readCurve('0x' + '11'.repeat(20) as any, { multicall: async (a: any) => { asked = a.contracts; return fourteen } } as any)
    expect(r.block).toBe(555)
    // block.number in the EVM is the parent chain's on an Arbitrum-family chain (25.9M vs
    // 56.0M on 2026-09-06); only the precompile answers with the L2 height
    expect(asked).toHaveLength(14)
    expect(asked[13]).toMatchObject({ address: ARBSYS, functionName: 'arbBlockNumber' })
    const r0 = await readCurve('0x' + '11'.repeat(20) as any, { multicall: async () => fourteen.slice(0, 13) } as any)
    expect(r0.block).toBe(0)
    // the socket path retries ANY error: the public rpc simply does not have the block yet
    let calls = 0
    const via = { multicall: async () => { calls++; if (calls < 3) throw new Error('returned no data ("0x")'); return fourteen } }
    const got = await readCurveRetry('0x' + '11'.repeat(20) as any, via as any, { any: true, sleep: async () => {} })
    expect(calls).toBe(3)
    expect(got.block).toBe(555)
  })
})
