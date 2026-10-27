/**
 * Does the exempt count actually decode, and would it let anything through?
 *
 * WHY THIS EXISTS AND THE REPLAY DOES NOT ANSWER IT. `tools/replay-proof.ts` folds the tape,
 * and every `chain-read` on the tape was recorded by the old `io/world.ts`, which returned
 * `exemptions: null` unconditionally. So a replay can only ever prove that the old answer is
 * still the old answer. The only honest check is to go and read real launches.
 *
 * It reads. It never signs, never sends and never writes to the tape.
 *
 *   npx tsx tools/exempt-dryrun.ts [--blocks 20000] [--sample 50]
 */
import { createPublicClient, custom, type Hex } from 'viem'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { exemptCount } from '../io/world.js'
import { ADDRESSES, EVENT_TOPICS } from '../core/chain.js'
import { HistoricalTransactionCache } from './research-rpc.js'

async function main(): Promise<void> {
  const args = parseArgs({ options: { blocks: { type: 'string' }, sample: { type: 'string' } } })
  const span = Number(args.values.blocks ?? 20_000)
  const sample = Number(args.values.sample ?? 50)

  const acquisition = new HistoricalTransactionCache()
  const client = createPublicClient({ transport: custom({ request: ({ method, params }) => acquisition.request(method, params ?? []) }) })
  console.log('reading through the isolated research route')

  const tip = Number(await client.getBlockNumber())
  const logs = await client.getLogs({
    address: ADDRESSES.factory as Hex,
    event: undefined as never,
    fromBlock: BigInt(tip - span),
    toBlock: BigInt(tip),
  }).catch(() => [] as Array<{ topics: readonly string[]; transactionHash: string }>)

  const launches = logs.filter((l) => l.topics[0] === EVENT_TOPICS.TokenLaunched)
  console.log(`${launches.length} launches in the last ${span} blocks; sampling the newest ${sample}`)

  const picked = launches.slice(-sample)
  const counts: Array<number | null> = []
  let firstDecoded: { tx: string; n: number } | null = null
  for (const l of picked) {
    const n = await exemptCount(client as never, l.transactionHash as Hex)
    counts.push(n)
    if (n !== null && firstDecoded === null) firstDecoded = { tx: l.transactionHash, n }
  }

  const decoded = counts.filter((c): c is number => c !== null)
  const unknown = counts.length - decoded.length
  const atLeast3 = decoded.filter((c) => c >= 3).length
  const hist = new Map<number, number>()
  for (const c of decoded) hist.set(c, (hist.get(c) ?? 0) + 1)

  console.log(`decoded ${decoded.length}/${counts.length}, unknown ${unknown}`)
  console.log(`with 3 or more exempt wallets: ${atLeast3} (${counts.length ? Math.round((atLeast3 / counts.length) * 100) : 0}% of the sample)`)
  console.log('distribution:', [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '))
  if (firstDecoded) console.log(`first that decoded: ${firstDecoded.tx} -> ${firstDecoded.n}`)
  // v1's own launch table, last 24h: 1,758 of 11,270 launches had 3 or more (15.6%), and it
  // could only read 41% of them at all. A sample well under that is a decode that is wrong.
  console.log('v1 for comparison: 1758/11270 = 16% had 3 or more, on the 41% it could read')
  console.log('acquisition', acquisition.summary())
  acquisition.close()
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) void main()
