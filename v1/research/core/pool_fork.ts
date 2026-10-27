/** Independent contract replay on a fixed localhost fork. Never signs for a live RPC. */
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeAbiParameters, parseAbiParameters, keccak256, zeroAddress, type Hex } from 'viem'
import { MODEL_HASH } from '../../src/simulation/identity.js'
import { curveAbi, erc20Abi, EVENT_TOPICS, logWord } from '../../src/abi.js'
import { ADDRESSES, robinhoodChain } from '../../src/config.js'
import factoryAbi from '../../src/factory.abi.json' with { type: 'json' }
import { V4, permitAbi, swapData, graduatedProceeds, type PoolKey } from '../../src/tx/graduated.js'
import { apply, predictExecution, params } from '../../src/strategy/counterfactual.js'
import { compareOrder, type ExecutionRequest, type ExecutionLog } from '../../src/strategy/execution-model.js'
import { freshCurve, simBuy, simSell, type CurveState } from '../../src/state/curve.js'

const [source, output, ordersPath] = process.argv.slice(2)
const externalOrders=ordersPath?JSON.parse(fs.readFileSync(ordersPath,'utf8')):null
if(externalOrders)assert(externalOrders.complete,'external pool inputs are incomplete')
const consumedPoolTransactions=new Set<string>()
const externalReverts:any[]=[]
if(externalOrders?.allowSelectedTokenBalanceReverts)assert(externalOrders.includesRawCurveTransactions&&externalOrders.selectedTokenCoverage?.complete&&externalOrders.approvals?.length,'revert classification requires complete selected-token flow')
if (process.env.ENV_FILE !== '/dev/null' || process.env.LIVE !== '0') throw new Error('isolated research environment required')
const request = JSON.parse(fs.readFileSync(source!, 'utf8')) as ExecutionRequest
const result = predictExecution(request), handoff = result.poolReplay
assert(handoff, 'request does not have a valid pool handoff')
const endpoint = 'http://127.0.0.1:18546'
const client = createPublicClient({ chain: robinhoodChain, transport: http(endpoint, { timeout: 120000, retryCount: 0 }) })
const wallet = createWalletClient({ chain: robinhoodChain, transport: http(endpoint, { timeout: 120000, retryCount: 0 }) })
const rpc = (method: string, args: unknown[]) => client.request({ method, params: args } as any)
assert.match(await client.request({ method: 'web3_clientVersion' }), /^anvil\//)
await rpc('anvil_reset',[{forking:{jsonRpcUrl:'http://127.0.0.1:16876',blockNumber:Math.min(...request.logs.map(l=>l.order.block))}}])
await rpc('evm_setAutomine',[false])
const block = await client.getBlock()
const p = params(request.params), owner = request.wallet as Hex, curve = request.curve as Hex, token = request.token as Hex
const originalLogs = [...new Map(request.logs.map(l => [`${l.transactionHash}:${l.logIndex}`,l])).values()].sort((a,b) => compareOrder(a.order,b.order))
const ours = (l: ExecutionLog) => l.topics.slice(1,3).some(t => t.slice(-40).toLowerCase() === owner.slice(2).toLowerCase())
assert(!originalLogs.some(l => ours(l) && l.order.block <= Number(block.number)), 'fork seed already contains our excluded orders')
assert(Number(block.timestamp) * 1000 <= handoff.buyAt, 'fork starts after virtual entry')
assert(Number(block.number) <= handoff.entryAfter.block, 'fork includes orders after virtual entry')
const logs = originalLogs.filter(l => !ours(l) && compareOrder(l.order,handoff.exitAfter) <= 0)
let state: CurveState = freshCurve(p)
for (const l of logs.filter(l => l.order.block <= Number(block.number))) state = apply(state,l)
const json = (v: unknown) => JSON.stringify(v,(_,x) => typeof x === 'bigint' ? String(x) : x)
const readState = async (): Promise<CurveState> => {
  const s: any = {}
  for (const fn of ['trackedQuote','trackedTokens','quoteFeeBalance','creatorTaxBalance','graduated'] as const)
    s[fn] = await client.readContract({address:curve,abi:curveAbi,functionName:fn})
  return s
}
const equal = (a: any,b: any) => Object.keys(a).every(k => String(a[k]) === String(b[k]))
assert(equal(await readState(),state),'historical seed does not match ordered logs')
const pinnedGasPrice = block.baseFeePerGas ?? 1_000_000_000n
const prepared = new Set<string>(), transactions: any[] = [], checks: any[] = []
const send = async (from: Hex,to: Hex,data: Hex,at: number,kind: string,value=0n,gasLimit=6_000_000n) => {
  if (!prepared.has(from.toLowerCase())) {
    await rpc('anvil_impersonateAccount',[from]); await rpc('anvil_setBalance',[from,'0x3635c9adc5dea00000']); prepared.add(from.toLowerCase())
  }
  await rpc('evm_setNextBlockTimestamp',[Math.floor(at/1000)])
  await rpc('anvil_setNextBlockBaseFeePerGas',['0x'+pinnedGasPrice.toString(16)])
  const hash = await wallet.sendTransaction({account:from,to,data,value,gas:gasLimit,gasPrice:pinnedGasPrice})
  await rpc('evm_mine',[])
  const receipt = await client.waitForTransactionReceipt({hash,pollingInterval:20,timeout:120000})
  transactions.push({kind,hash,at,status:receipt.status,gasUsed:String(receipt.gasUsed),gasWei:String(receipt.gasUsed*pinnedGasPrice),logs:receipt.logs})
  fs.writeFileSync(output!+'.progress.json',json({at:Date.now(),transactions,checks,complete:false}))
  return receipt
}
const buy = async (from:Hex,recipient:Hex,size:bigint,at:number,kind:string,minimum=1n) => send(from,curve,
  encodeFunctionData({abi:curveAbi,functionName:'buy',args:[size,minimum,recipient]}),at,kind,size)
let nextApproval=0
const approvalOrders=externalOrders?.approvals??[]
const advanceApprovals=async(at:number,boundary?:{block:number;transaction:number;log:number})=>{
  while(nextApproval<approvalOrders.length) {
    const a=approvalOrders[nextApproval],tx=a.transaction
    const order={block:Number(BigInt(tx.blockNumber)),transaction:Number(BigInt(tx.transactionIndex)),log:0}
    if(boundary?compareOrder(order,boundary)>0:!(a.at+1000<=at||a.at<=at&&request.timing.sameTimeOrder==='after'))break
    nextApproval++
    if(tx.from.toLowerCase()===owner.toLowerCase())continue
    assert.equal((await send(tx.from,tx.to,tx.input,a.at,'external-token-approval',BigInt(tx.value),BigInt(tx.gas))).status,'success','external token approval reverted')
  }
}
let inserted = false, ownTokens = 0n
const firstExcluded=originalLogs.find(ours)?.order
const enter = async () => {
  await advanceApprovals(handoff.buyAt,handoff.entryAfter)
  const before = await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[owner]})
  const fill = simBuy(p,state,BigInt(request.sizeWei),BigInt(Math.floor(handoff.buyAt/1000)))
  const receipt = await buy(owner,owner,BigInt(request.sizeWei),handoff.buyAt,'virtual-buy')
  assert.equal(receipt.status,'success','virtual buy reverted')
  const after = await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[owner]})
  ownTokens=after-before; assert.equal(String(ownTokens),handoff.tokens,'independent entry quantity differs')
  state=fill.next; inserted=true;assert(equal(await readState(),state),'independent entry reserves differ')
}
const remaining=logs.filter(l => l.order.block>Number(block.number))
for(let i=0;i<remaining.length;i++) {
  const l=remaining[i]!
  if(!inserted && compareOrder(l.order,handoff.entryAfter)>0) await enter()
  await advanceApprovals(l.at,l.order)
  // Graduation emits FeesSwept and CurveCompleted in one atomic factory call.
  const group=remaining.filter(x=>x.transactionHash===l.transactionHash)
  if(l.topics[0]!==EVENT_TOPICS.CurveBuy && group.some(x=>x.topics[0]===EVENT_TOPICS.CurveCompleted)) {
    const tail=group.filter(x=>compareOrder(x.order,l.order)>=0)
    assert(tail.every(x=>x.topics[0]===EVENT_TOPICS.FeesSwept||x.topics[0]===EVENT_TOPICS.CurveCompleted),'unsupported atomic graduation transaction')
    const receipt=await send(owner,ADDRESSES.factory as Hex,encodeFunctionData({abi:factoryAbi,functionName:'graduate',args:[token]}),l.at,'external-graduate')
    assert.equal(receipt.status,'success','permissionless graduation reverted')
    for(const x of tail)state=apply(state,x)
    i+=tail.length-1
  } else if(l.topics[0]===EVENT_TOPICS.CurveBuy) {
    const from=('0x'+l.topics[1]!.slice(-40)) as Hex,recipient=('0x'+l.topics[2]!.slice(-40)) as Hex
    const size=l.externalBuy?BigInt(l.externalBuy.quoteInWei):logWord(l.data,0)
    const minimum=l.externalBuy?BigInt(l.externalBuy.minTokensOut):1n
    const raw=externalOrders?.orders.find((x:any)=>x.transaction.hash.toLowerCase()===l.transactionHash.toLowerCase())
    const receipt=raw?await send(raw.transaction.from,raw.transaction.to,raw.transaction.input,l.at,'external-atomic-router-buy',BigInt(raw.transaction.value),BigInt(raw.transaction.gas)):await buy(from,recipient,size,l.at,'external-buy',minimum)
    if(raw)consumedPoolTransactions.add(l.transactionHash.toLowerCase())
    assert.equal(receipt.status,'success','external buy reverted')
    const fill=simBuy(p,state,size,BigInt(Math.floor(l.at/1000)),{minTokensOut:minimum,exempt:logWord(l.data,2)===(logWord(l.data,0)*p.feeBps)/10000n})
    const emitted=receipt.logs.find(x=>x.address.toLowerCase()===curve.toLowerCase()&&x.topics[0]===EVENT_TOPICS.CurveBuy)
    assert(emitted,'successful buy has no curve fill')
    assert.deepEqual([0,1,2,3].map(n=>logWord(emitted.data,n)),[fill.spent,fill.tokensOut,fill.fee+fill.snipeTax,fill.tax],'independent buy fill differs')
    state=inserted || firstExcluded && compareOrder(l.order,firstExcluded)>0?fill.next:apply(state,l)
    const completed=receipt.logs.find(x=>x.address.toLowerCase()===curve.toLowerCase()&&x.topics[0]===EVENT_TOPICS.CurveCompleted)
    if(completed) {
      const tail=group.filter(x=>compareOrder(x.order,l.order)>0)
      assert(tail.some(x=>x.topics[0]===EVENT_TOPICS.CurveCompleted),'virtual trade changed graduation ordering; pool path requires reconstruction')
      assert(tail.every(x=>x.topics[0]===EVENT_TOPICS.FeesSwept||x.topics[0]===EVENT_TOPICS.CurveCompleted),'unsupported atomic buy graduation')
      assert.equal(logWord(completed.data,2),state.trackedTokens,'independent graduation token liquidity differs')
      for(const x of tail)state=apply(state,x)
      i+=tail.length
    }
  } else if(l.topics[0]===EVENT_TOPICS.CurveSell) {
    const from=('0x'+l.topics[1]!.slice(-40)) as Hex,recipient=('0x'+l.topics[2]!.slice(-40)) as Hex,amount=logWord(l.data,0)
    const raw=externalOrders?.orders.find((x:any)=>x.transaction.hash.toLowerCase()===l.transactionHash.toLowerCase())
    if(raw) {
      assert.equal((await send(raw.transaction.from,raw.transaction.to,raw.transaction.input,l.at,'external-atomic-router-sell',BigInt(raw.transaction.value),BigInt(raw.transaction.gas))).status,'success','external sell reverted')
      consumedPoolTransactions.add(l.transactionHash.toLowerCase())
    } else {
      assert.equal((await send(from,token,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[curve,amount]}),l.at,'external-approval')).status,'success')
      assert.equal((await send(from,curve,encodeFunctionData({abi:curveAbi,functionName:'sell',args:[amount,1n,recipient]}),l.at,'external-sell')).status,'success','external sell reverted')
    }
    state=inserted || firstExcluded && compareOrder(l.order,firstExcluded)>0?simSell(p,state,amount).next:apply(state,l)
  } else throw new Error('unsupported external contract action: '+l.topics[0])
  const actual=await readState();checks.push({order:l.order,matched:equal(actual,state),...(!equal(actual,state)?{actual,expected:state}:{})})
  fs.writeFileSync(output!+'.progress.json',json({at:Date.now(),transactions,checks,complete:false}))
  assert(equal(actual,state),'contract/model reserves diverged at '+json(l.order))
}
if(!inserted)await enter()
assert(equal(await readState(),handoff.curveState),'pool handoff reserves differ')
const advancePool=async(at:number)=>{
  for(const order of externalOrders?.orders??[]) {
    const tx=order.transaction,hash=tx.hash.toLowerCase()
    if(consumedPoolTransactions.has(hash))continue
    if(!(order.at+1000<=at || order.at<=at&&request.timing.sameTimeOrder==='after'))break
    await advanceApprovals(order.at,{block:Number(BigInt(tx.blockNumber)),transaction:Number(BigInt(tx.transactionIndex)),log:0})
    consumedPoolTransactions.add(hash)
    if(tx.from.toLowerCase()===owner.toLowerCase())continue
    for(const [address,evidence] of Object.entries(externalOrders?.externalFundingWitnesses?.[hash]??{}) as Array<[Hex,any]>) {
      assert.equal(address.toLowerCase(),'0x5fc5360d0400a0fd4f2af552add042d716f1d168','unsupported exogenous funding asset')
      assert.notEqual(address.toLowerCase(),token.toLowerCase(),'cannot overwrite selected-token balances')
      const code=await client.getCode({address})
      assert(code&&keccak256(code)===evidence.codeHash,'external funding contract code differs')
      for(const [slot,value] of Object.entries(evidence.storage))await rpc('anvil_setStorageAt',[address,slot,value])
    }
    const receipt=await send(tx.from,tx.to,tx.input,order.at,'external-pool-transaction',BigInt(tx.value),BigInt(tx.gas))
    if(receipt.status==='reverted' && externalOrders?.allowSelectedTokenBalanceReverts) {
      const trace:any=await rpc('debug_traceTransaction',[receipt.transactionHash,{tracer:'callTracer'}])
      const leaves:any[]=[]
      const walk=(n:any)=>{if(n.error&&!(n.calls??[]).some((c:any)=>c.error))leaves.push(n);for(const c of n.calls??[])walk(c)}
      walk(trace)
      const recognized=leaves.length>0&&leaves.every(n=>{
        if(n.to?.toLowerCase()===token.toLowerCase()&&['0xe450d38c','0xfb8f41b2'].some(s=>n.output?.startsWith(s)))return true
        if(!n.output?.startsWith('0x08c379a0'))return false
        let reason;try{[reason]=decodeAbiParameters(parseAbiParameters('string'),('0x'+n.output.slice(10)) as Hex)}catch{return false}
        const calls=(n.calls??[]).filter((c:any)=>c.input?.startsWith('0x70a08231'))
        return reason==='insufficient balance'&&calls.length>0&&calls.every((c:any)=>c.to?.toLowerCase()===token.toLowerCase())
      })
      assert(recognized,'unresolved external pool revert: '+hash)
      externalReverts.push({sourceHash:hash,localHash:receipt.transactionHash,reason:'selected-token balance or allowance under fixed external inputs',trace})
    } else assert.equal(receipt.status,'success','external pool transaction reverted under counterfactual reserves: '+hash)
  }
  await advanceApprovals(at)
}
// Extra pool costs start with the modeled curve sell that cannot execute.
await advancePool(handoff.attemptedAt)
assert.equal((await send(owner,token,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[curve,ownTokens]}),handoff.attemptedAt,'curve-approval-already-modeled')).status,'success')
const cashBeforePool=await client.getBalance({address:owner})
const failed=await send(owner,curve,encodeFunctionData({abi:curveAbi,functionName:'sell',args:[ownTokens,1n,owner]}),handoff.attemptedAt,'failed-curve-sell')
assert.equal(failed.status,'reverted','curve sell unexpectedly succeeded')
let executionAt=handoff.attemptedAt
for(let tries=0;tries<3;tries++) {
  const info:any=await client.readContract({address:ADDRESSES.factory as Hex,abi:factoryAbi,functionName:'getLaunchedToken',args:[token]})
  if(info.phase===2)break
  assert(info.phase===0||info.phase===1,'unsupported graduation phase')
  executionAt+=1000
  await advancePool(executionAt)
  const fn=info.phase===0?'graduate':'createGraduatedPool'
  assert.equal((await send(owner,ADDRESSES.factory as Hex,encodeFunctionData({abi:factoryAbi,functionName:fn,args:[token]}),executionAt,'pool-'+fn)).status,'success')
}
const info:any=await client.readContract({address:ADDRESSES.factory as Hex,abi:factoryAbi,functionName:'getLaunchedToken',args:[token]})
assert.equal(info.phase,2,'pool not created')
const key:PoolKey={currency0:zeroAddress,currency1:token,fee:info.poolFee,tickSpacing:info.tickSpacing,hooks:V4.hook}
executionAt+=1000
await advancePool(executionAt)
assert.equal((await send(owner,token,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[V4.permit2,ownTokens]}),executionAt,'pool-token-approval')).status,'success')
executionAt+=1000
await advancePool(executionAt)
assert.equal((await send(owner,V4.permit2,encodeFunctionData({abi:permitAbi,functionName:'approve',args:[token,V4.router,ownTokens,Math.floor(executionAt/1000)+600]}),executionAt,'pool-permit-approval')).status,'success')
executionAt+=1000
await advancePool(executionAt)
const receipt=await send(owner,V4.router,swapData(key,ownTokens,1n,BigInt(Math.floor(executionAt/1000)+180)),executionAt,'pool-swap')
assert.equal(receipt.status,'success','pool swap reverted')
const proceeds=graduatedProceeds(receipt.logs,key,owner)
const gas=transactions.filter(t=>t.kind==='failed-curve-sell'||t.kind.startsWith('pool-')).reduce((s,t)=>s+BigInt(t.gasWei),0n)
const cashAfterPool=await client.getBalance({address:owner})
assert.equal(cashAfterPool-cashBeforePool+gas,proceeds,'independent pool wallet cash differs')
assert.equal(await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[owner]}),0n,'tokens remain after pool exit')
fs.writeFileSync(output!,json({modelHash:MODEL_HASH,walletAccountingExact:true,externalPoolOrdersReplayed:!!externalOrders,externalOrdersSource:ordersPath??null,externalFundingAssumption:externalOrders?.externalFundingAssumption??null,externalReverts,selectedTokenCoverage:externalOrders?.selectedTokenCoverage??null,consumedPoolTransactions:[...consumedPoolTransactions],poolKey:key,inputHash:handoff.inputHash,handoff,transactions,checks,proceedsWei:String(proceeds),gasWei:String(gas),executionAt,
  contractCalculationParity:true,rankingEligible:false,limitations:['Pool timing uses one second per preparation transaction and is not calibrated.',...(externalOrders?['Pool orders use recorded calldata and submitted gas limits; external reactions to our order remain counterfactual assumptions.']:['External pool orders after the curve handoff are not replayed.']),'Local EVM gas excludes unproved chain-specific L1 fee overhead.','Historical block numbers are not reproduced by the transaction-per-block validation fork.']}))
console.log(json({contractCalculationParity:true,proceedsWei:String(proceeds),gasWei:String(gas),checks:checks.length,rankingEligible:false}))
