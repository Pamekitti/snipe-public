// does readCurve's block now match this chain's height, through Multicall3 on the key?
import { createPublicClient, custom } from 'viem'
process.env.ENV_FILE = '/dev/null'
const { robinhoodChain } = await import('../src/config.js')
const { readCurve } = await import('../src/recovery.js')
const { ResearchRpc } = await import('./core/acquisition-policy.mjs')
const research = new ResearchRpc()
const c = createPublicClient({ chain: robinhoodChain, transport: custom({ request: ({ method, params }) => research.request(method, params ?? []) }) })
const curve = process.argv[2] as `0x${string}`
const head = Number(await c.getBlockNumber())
const r = await readCurve(curve, c)
console.log(`eth_blockNumber ${head} | readCurve.block ${r.block} | diff ${r.block - head} | graduated ${r.state.graduated}`)
console.error(JSON.stringify({ acquisition: research.summary() })); research.close()
process.exit(0)
