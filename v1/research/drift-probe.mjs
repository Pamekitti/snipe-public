/**
 * WHICH SIDE OF A BOOK-DRIFT CHECK WAS WRONG: the folded book, or the chain read?
 *
 * Run from the LAPTOP against an archival endpoint. The public RPC refuses a pinned
 * historical read ("Missing or invalid parameters"), so pass the provider key:
 *
 *   RESEARCH_RPC_URL=https://... RESEARCH_ALLOW_PAID=1 \
 *     RESEARCH_MAX_PAID_REQUESTS=20 RESEARCH_PAID_BUDGET_PATH=/tmp/drift-budget.sqlite \
 *     node research/drift-probe.mjs
 *
 * Take CURVE/BLOCK/BOOK/READ from a `book drift at block N` row in bot.db `health`
 * (component='book'), which records both sides of every disagreement.
 *
 * 2026-09-13 FINDING. On curve 0x0e4d1e11 at block 61938216 the chain matched the READ
 * exactly at 61938215..61938218 and the BOOK was wrong: 752369618946093712 wei of tracked
 * quote against a true 57440095301029426, a factor of 13. So the re-seed in
 * state/engine.ts resolveCheck is CORRECTING a bad book, not corrupting a good one, and
 * the crit alert is telling the truth.
 *
 * The direction names the mechanism. Book quote too HIGH and book tokens too LOW is what
 * folding the same buy twice does, twice over. Both transports share subscriber.ts
 * normalize() so the dedup key `blockHash:logIndex` is consistently typed, and the engine
 * skips anything at or below seedBlock -- but the seen-set is evicted at 50k entries down
 * to the newest 10k, on the stated assumption that "anything this old cannot still be
 * arriving twice". A poller catch-up spans up to MAX_RANGE = 2000 blocks, and on
 * 2026-09-13 the shadow observer reported a stream gap of exactly 61948276-61950275. Logs
 * re-delivered by that catch-up, already evicted from `seen` and above the curve's
 * seedBlock, fold a second time. NOT YET PROVEN: the next step is to log a fold-count per
 * curve and compare it with eth_getLogs over [seedBlock, checkBlock].
 *
 * Exits were still priced correctly through all of this (markErr p50 1.00 over 5 exits),
 * because a check re-seeds before the sale. The exposure is an exit rule reading a wrong
 * book BETWEEN checks.
 */
import { createPublicClient, custom } from 'viem'
import { ResearchRpc } from './core/acquisition-policy.mjs'
const research = new ResearchRpc()
const c = createPublicClient({ transport: custom({ request: ({ method, params }) => research.request(method, params ?? []) }) })
const abi = ['trackedQuote','trackedTokens','quoteFeeBalance','creatorTaxBalance'].map(n => ({
  type:'function', name:n, stateMutability:'view', inputs:[], outputs:[{ type:'uint256' }],
}))
const CURVE='0x0e4d1e1165d4f13b50f03b0dc8b7a6801192792d'
const BLOCK=61938216n
const BOOK ={trackedQuote:752369618946093712n, trackedTokens:698405591130108960244929751n, quoteFeeBalance:9194864842569560n}
const READ ={trackedQuote:57440095301029426n,  trackedTokens:994637933487256083978913686n, quoteFeeBalance:16359086735817640n}
for (const at of [BLOCK-1n, BLOCK, BLOCK+1n, BLOCK+2n]) {
  try {
    const out={}
    for (const f of ['trackedQuote','trackedTokens','quoteFeeBalance']) {
      out[f] = await c.readContract({ address:CURVE, abi, functionName:f, blockNumber:at })
    }
    const same = o => Object.keys(o).every(k => o[k]===out[k])
    console.log(`block ${at}  quote=${out.trackedQuote}`)
    console.log(`   matches BOOK? ${same(BOOK)}   matches READ? ${same(READ)}`)
  } catch (e) {
    console.log(`block ${at}: ${String(e.shortMessage||e.message).slice(0,110)}`)
  }
}
console.error(JSON.stringify({ acquisition: research.summary() })); research.close()
