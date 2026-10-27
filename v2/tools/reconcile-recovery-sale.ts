/** Verify a separately approved recovery sale and record its settlement. Never signs or sends. */
import { readFileSync, copyFileSync } from 'node:fs'
import { deserialize } from 'node:v8'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { createPublicClient, http, decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, erc20Abi, type Hex } from 'viem'
import { BoundedMap, BoundedSet, Ring } from '../core/contracts.js'
import { canonical } from '../core/identity.js'
import { decide } from '../core/decide.js'
import { emptyState, type State } from '../core/state.js'
import type { Event, RecoverySale } from '../core/events.js'
import { History } from '../projections/history.js'
import { readSnapshot, shapeOf, writeSnapshot, type Registry } from '../io/snapshot.js'
import { snapshotPathFor } from '../io/codeid.js'
import { curveAbi, EVENT_TOPICS } from '../io/abi.js'
import { tryWord } from '../core/chain.js'
import { Tape } from '../io/tape.js'

type Evidence = {
  oldSignedSeq: number; oldHash: Hex; hash: Hex; raw: Hex; wallet: Hex; token: Hex; curve: Hex
}
const registry: Registry = new Map([['Ring', Ring as never], ['BoundedMap', BoundedMap as never], ['BoundedSet', BoundedSet as never], ['History', History as never]])

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, 'source-snapshot': { type: 'string' }, evidence: { type: 'string' },
    tape: { type: 'string', default: 'data/tape.db' }, apply: { type: 'boolean', default: false },
  } })
  if (!values.source || !values['source-snapshot'] || !values.evidence) throw new Error('--source, --source-snapshot and --evidence are required')
  if (values.apply) {
    const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' })) as Array<{ name: string; pm2_env: { status: string } }>
    if (processes.find(p => p.name === 'snipe-v2-live')?.pm2_env.status !== 'stopped') throw new Error('Stop the live process only after the recovery receipt proves a flat wallet')
  }
  const sourceRoot = resolve(values.source)
  const sourceBuild = await import(pathToFileURL(join(sourceRoot, 'io/codeid.ts')).href)
  const previous = await import(pathToFileURL(join(sourceRoot, 'core/decide.ts')).href)
  const raw = deserialize(readFileSync(values['source-snapshot']))
  const shape = shapeOf({ state: emptyState(raw.payload.state.config, raw.payload.state.switches), history: new History() })
  const load = () => {
    const s = readSnapshot(values['source-snapshot']!, registry, shape, sourceBuild.codeId())
    if (!s) throw new Error('Actual source snapshot failed build or shape verification')
    return s
  }
  const one = load(), two = load()
  let state = one.payload.state as State, baseline = two.payload.state as State
  const history = one.payload.history as History, baselineHistory = two.payload.history as History
  const evidence = JSON.parse(readFileSync(values.evidence, 'utf8')) as Evidence
  const db = new Database(values.tape, { readonly: true, fileMustExist: true })
  const tip = db.prepare('SELECT seq,at FROM events ORDER BY seq DESC LIMIT 1').get() as { seq: number; at: number }
  const anchor = db.prepare('SELECT at FROM events WHERE seq=?').get(one.seq) as { at: number } | undefined
  if (anchor?.at !== one.at || two.seq !== one.seq) throw new Error('Source snapshot does not belong to the current tape')
  let cursor = one.seq + 1
  while (cursor <= tip.seq) {
    const rows = db.prepare('SELECT * FROM events WHERE seq>=? AND seq<=? ORDER BY seq LIMIT 1000').all(cursor, tip.seq) as Array<{ seq: number; at: number; kind: string; body: string; run: string }>
    if (!rows.length) throw new Error('Tape coverage missing')
    for (const row of rows) {
      if (row.seq !== cursor) throw new Error(`Tape sequence missing at ${cursor}`)
      const e = { ...JSON.parse(row.body), seq: row.seq, at: row.at, kind: row.kind, run: row.run } as Event
      const a = decide(state, e), b = previous.decide(baseline, e)
      if (canonical([a.intents, a.refusals]) !== canonical([b.intents, b.refusals])) throw new Error(`Historical decisions changed at ${row.seq}`)
      state = a.state; baseline = b.state
      history.observe(e, state, a.intents, a.refusals)
      baselineHistory.observe(e, baseline, b.intents, b.refusals)
      cursor++
    }
  }
  if (canonical(state) !== canonical(baseline) || canonical(history) !== canonical(baselineHistory)) throw new Error('Actual wallet fold or history changed before recovery')
  const signedRow = db.prepare("SELECT body FROM events WHERE seq=? AND kind='tx-signed'").get(evidence.oldSignedSeq) as { body: string } | undefined
  if (!signedRow) throw new Error('Original signed sale is absent from the tape')
  const signed = JSON.parse(signedRow.body)
  const old = parseTransaction(signed.raw as Hex)
  const tx = parseTransaction(evidence.raw)
  type Serialized = Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction']
  const wallet = await recoverTransactionAddress({ serializedTransaction: signed.raw as Serialized })
  const replacementWallet = await recoverTransactionAddress({ serializedTransaction: evidence.raw as Serialized })
  const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()
  const call = tx.data ? decodeFunctionData({ abi: curveAbi, data: tx.data }) : null
  const oldCall = old.data ? decodeFunctionData({ abi: curveAbi, data: old.data }) : null
  if (signed.txKind !== 'sell' || !same(keccak256(signed.raw), evidence.oldHash) || !same(signed.hash, evidence.oldHash)
    || !same(wallet, evidence.wallet) || !same(replacementWallet, wallet) || !same(keccak256(evidence.raw), evidence.hash)
    || !same(old.to, evidence.curve) || !same(tx.to, evidence.curve) || tx.chainId !== 4663 || old.chainId !== 4663
    || (tx.value ?? 0n) !== 0n || tx.gas !== 400_000n || (tx.maxFeePerGas ?? 0n) > 500_000_000n
    || call?.functionName !== 'sell' || oldCall?.functionName !== 'sell'
    || call.args[0] !== oldCall.args[0] || call.args[1] !== 1n || !same(call.args[2], wallet)) throw new Error('Recovery transaction does not match the approved original holding and gas cap')
  const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com', { timeout: 2_000, retryCount: 0 }) })
  const [chain, receipt, chainTx, head, currentBalance, confirmedNonce] = await Promise.all([
    client.getChainId(), client.getTransactionReceipt({ hash: evidence.hash }), client.getTransaction({ hash: evidence.hash }),
    client.getBlock(), client.readContract({ address: evidence.token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    client.getTransactionCount({ address: wallet, blockTag: 'latest' }),
  ])
  const receiptBalance = await client.readContract({ address: evidence.token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet], blockNumber: receipt.blockNumber })
  const fills = receipt.logs.filter(l => same(l.address, evidence.curve) && l.topics[0]?.toLowerCase() === EVENT_TOPICS.CurveSell)
  const gas = receipt.gasUsed * receipt.effectiveGasPrice
  if (chain !== 4663 || Date.now() / 1000 - Number(head.timestamp) > 30 || receipt.status !== 'success'
    || !same(receipt.transactionHash, evidence.hash) || !same(chainTx.from, wallet) || !same(chainTx.to, evidence.curve)
    || chainTx.input !== tx.data || chainTx.nonce !== tx.nonce || chainTx.blockNumber !== receipt.blockNumber
    || receiptBalance !== 0n || currentBalance !== 0n || fills.length !== 1 || gas > 200_000_000_000_000n
    || tryWord(fills[0]!.data, 0) !== call.args[0] || tryWord(fills[0]!.data, 1) === null) throw new Error('Receipt, ownership, complete sale or current flat balance was not proved')
  const positions = [...state.positions.values()].filter(p => !p.closed)
  if (positions.length !== 1 || !same(positions[0]!.token, evidence.token) || !same(positions[0]!.curve, evidence.curve)) throw new Error('Recovery must settle the only open position')
  const proof: RecoverySale = {
    token: evidence.token, curve: evidence.curve, oldHash: evidence.oldHash, hash: evidence.hash,
    oldNonce: old.nonce!, nonce: tx.nonce!, confirmedNonce, tokensSoldWei: String(call.args[0]),
    receipt: { ok: true, gasWei: String(gas), proceedsWei: String(tryWord(fills[0]!.data, 1)), remainingWei: '0', error: null },
  }
  const e: Event = { kind: 'operator', action: 'reconcile-sale', positionId: positions[0]!.id,
    recoverySale: proof, why: `User-approved recovery of obsolete sale ${evidence.oldHash}; verified transaction and receipt ${evidence.hash}`,
    seq: tip.seq + 1, at: Math.max(tip.at + 1, Date.now()), run: 'operator-recovery' }
  const beforeHalts = canonical(state.risk.halts), beforeSwitches = canonical(state.switches), beforeConfig = canonical(state.config)
  const out = decide(state, e)
  if (out.intents.length || out.refusals.length || [...out.state.positions.values()].some(p => !p.closed)
    || canonical(out.state.risk.halts) !== beforeHalts || canonical(out.state.switches) !== beforeSwitches
    || canonical(out.state.config) !== beforeConfig) throw new Error('Reconciliation refused or changed unrelated controls')
  state = out.state
  history.observe(e, state, out.intents, out.refusals)
  history.catchUp(state)
  db.close()
  const destination = snapshotPathFor(values.tape)
  if (values.apply) {
    copyFileSync(values['source-snapshot'], `${values['source-snapshot']}.before-recovery-${Date.now()}`)
    const tape = new Tape(values.tape)
    try {
      if (tape.nextSeq() !== e.seq) throw new Error('Tape advanced during verification')
      tape.append([e])
    } finally { tape.close() }
    writeSnapshot(destination, { seq: e.seq, at: e.at, shape, payload: { state, history } }, registry)
    const checked = readSnapshot(destination, registry, shape)
    if (!checked || canonical(checked.payload.state) !== canonical(state)) throw new Error('Recovered snapshot failed readback')
  }
  console.log(JSON.stringify({ applied: values.apply, through: e.seq, destination, positionId: e.positionId,
    hash: evidence.hash, proceedsWei: proof.receipt.proceedsWei, gasWei: proof.receipt.gasWei,
    open: 0, controls: 'preserved', suffixDecisions: 'identical', sourceSeq: one.seq, comparedEvents: tip.seq - one.seq }))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(e => { console.error(String(e instanceof Error ? e.message : e).replace(/(?:https?|wss?):\/\/\S+/g, '[RPC]')); process.exitCode = 1 })
}
