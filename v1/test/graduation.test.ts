import {describe,it,expect,vi} from 'vitest'
import Database from 'better-sqlite3'
import {decodeFunctionData,decodeAbiParameters,parseAbiParameters,zeroAddress,type Hex} from 'viem'
import {GraduationExit, GRADUATION_TIMING, graduationError} from '../src/graduation.js'
import {ensureApprovalSchema} from '../src/telemetry/approvals.js'
import {V4,graduatedProceeds,swapData,routerAbi,graduatedTx,poolType,type PoolKey} from '../src/tx/graduated.js'
import fixture from './fixtures/husdp-swap.json'
const token='0x753b0f74502d3d66c278a563cb04503154e6eb0d',curve='0xb82a38eda8f475d1a01f301dd3e7fc4c7235cb78'
const wallet='0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',tokens=1806744472837777553324081n
const key:PoolKey={currency0:zeroAddress,currency1:token,fee:0,tickSpacing:200,hooks:V4.hook}
const receipt={...fixture,gasUsed:BigInt(fixture.gasUsed),effectiveGasPrice:BigInt(fixture.effectiveGasPrice),blockNumber:BigInt(fixture.blockNumber)}
function harness(){
 const db=new Database(':memory:');db.exec("CREATE TABLE positions(id INTEGER PRIMARY KEY,spend_wei TEXT,closed INTEGER,onchain_pnl_wei TEXT); INSERT INTO positions VALUES(1,'20000000000000000',0,NULL)");ensureApprovalSchema(db)
 let now=1800000000000,nonce=0,allow=0n,permit=0n,balance=tokens,unknown=false,status='success',phase=2
 const client={
  readContract:vi.fn(async(p:any)=>{
   if(p.functionName==='getLaunchedToken')return {exists:true,token,curve,pairToken:zeroAddress,poolFee:0,tickSpacing:200,phase}
   if(p.functionName==='memeHook')return V4.hook
   if(p.functionName==='readyToGraduate')return true
   if(p.functionName==='balanceOf')return balance
   if(p.address===V4.permit2)return [permit,Math.floor(now/1000)+600,0]
   return allow
  }),
  multicall:vi.fn(async(p:any):Promise<any[]>=>Promise.all(p.contracts.map((q:any)=>client.readContract({...q,blockNumber:p.blockNumber})))),
  simulateContract:vi.fn(async()=>({result:[80000000000000000n,200000n]})),
  call:vi.fn(async()=>({data:'0x'})),
  getTransactionReceipt:vi.fn(async({hash}:any)=>{
   if(unknown)throw Error('receipt unavailable')
   const tx=db.prepare('SELECT kind FROM graduation_transactions WHERE hash=?').get(hash) as any
   if(status==='success'){
    if(tx.kind==='token-approval')allow=tokens
    if(tx.kind==='permit-approval')permit=tokens
    if(tx.kind==='swap')balance=0n
    if(tx.kind==='graduate')phase=1
    if(tx.kind==='create-pool')phase=2
   }
   return {...receipt,transactionHash:hash,status,logs:tx.kind==='swap'?receipt.logs:[]}
  }),
 }
 const sign=vi.fn(async(to:Hex,data:Hex)=>{
  const hash=('0x'+(++nonce).toString(16).padStart(64,'0')) as Hex
  return {hash,raw:hash,tx:graduatedTx(to,data,nonce),signedAt:now}
 })
 const send=vi.fn(async(s:any)=>({ok:true as const,hash:s.hash,ms:1,via:'test'})),burned=vi.fn(),prepared=vi.fn(),health=vi.fn()
 const deps={db,client:client as any,wallet:wallet as Hex,sign,send,burned,prepared,health,now:()=>now}
 return {db,client,sign,send,burned,prepared,health,deps,manager:new GraduationExit(deps),advance:(n=1000)=>now+=n,setUnknown:(b:boolean)=>unknown=b,setStatus:(s:string)=>status=s,setPhase:(n:number)=>phase=n}
}
describe('graduated ETH exit',()=>{
 it('keeps provider URLs out of persisted error messages',()=>{
  expect(graduationError(new Error('failed https://provider.invalid/private-key'))).toBe('failed [RPC]')
  expect(graduationError({shortMessage:'read failed',message:'URL: https://provider.invalid/private-key'})).toBe('read failed')
 })
 it('deducts both verified hook fees from the real HUSDP receipt',()=>{
  expect(graduatedProceeds(receipt.logs,key,wallet)).toBe(80013752899899322n)
  expect(()=>graduatedProceeds(receipt.logs.slice(0,1),key,wallet)).toThrow()
  expect(()=>graduatedProceeds(receipt.logs,key,'0x0000000000000000000000000000000000000001')).toThrow()
 })
 it('encodes the official V4 command with a positive minimum and deadline',()=>{
  const decoded=decodeFunctionData({abi:routerAbi,data:swapData(key,tokens,700n,100n)})
  expect(decoded.args[0]).toBe('0x10');expect(decoded.args[2]).toBe(100n)
  expect(()=>swapData({...key,hooks:zeroAddress},tokens,1n,100n)).toThrow()
 })
 it('confirms two exact approvals then the sale, and returns only receipt proceeds',async()=>{
  const h=harness()
  for(let i=0;i<3;i++){expect(await h.manager.step(1,token,curve)).toBeNull();h.advance()}
  expect(await h.manager.step(1,token,curve)).toMatchObject({proceeds:80013752899899322n})
  expect(h.sign).toHaveBeenCalledTimes(3)
  expect(h.db.prepare('SELECT COUNT(*) n FROM approval_transactions WHERE gas_wei IS NULL').get()).toEqual({n:0})
  expect(h.db.prepare('SELECT COUNT(*) n FROM approval_transactions').get()).toEqual({n:2})
  await h.manager.step(1,token,curve);expect(h.sign).toHaveBeenCalledTimes(3)
  h.db.close()
 })
 it('retains an uncertain send across restart and rebroadcasts identical bytes without another nonce',async()=>{
  const h=harness();h.setUnknown(true)
  await h.manager.step(1,token,curve);h.advance(1100)
  const resumed=new GraduationExit(h.deps)
  await resumed.step(1,token,curve)
  expect(h.sign).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledTimes(2)
  expect(h.send.mock.calls[1]![0].raw).toBe(h.send.mock.calls[0]![0].raw)
  h.setUnknown(false);h.advance();await resumed.step(1,token,curve)
  expect(h.sign).toHaveBeenCalledTimes(2)
  h.db.close()
 })
 it('does not broadcast unexecutable pool creation, and retries within a second',async()=>{
  const h=harness();h.setPhase(1);h.client.call.mockRejectedValueOnce(Error('pool not initialized'))
  await h.manager.step(1,token,curve);expect(h.sign).not.toHaveBeenCalled()
  await h.manager.step(1,token,curve);expect(h.sign).not.toHaveBeenCalled()
  h.advance(3000);await h.manager.step(1,token,curve);expect(h.sign).toHaveBeenCalledTimes(1)
  h.db.close()
 })
 it('serializes overlapping ticks for one holding',async()=>{
  const h=harness();await Promise.all([h.manager.step(1,token,curve),h.manager.step(1,token,curve)])
  expect(h.sign).toHaveBeenCalledTimes(1);h.db.close()
 })
 it('counts reverted approval costs, persists the gas cap, and keeps exposure open',async()=>{
  const h=harness();h.setStatus('reverted')
  for(let i=0;i<30;i++){await h.manager.step(1,token,curve);h.advance(31000)}
  expect(h.db.prepare("SELECT COUNT(*) n FROM graduation_transactions WHERE status='reverted'").get()).toEqual({n:6})
  expect(h.db.prepare('SELECT closed FROM positions').get()).toEqual({closed:0})
  const n=h.sign.mock.calls.length;await new GraduationExit(h.deps).step(1,token,curve);expect(h.sign).toHaveBeenCalledTimes(n)
  expect(h.burned).not.toHaveBeenCalled() // approval table owns those costs
  h.db.close()
 })
 it('accounts a reverted swap once and recovers on a later quote',async()=>{
  const h=harness()
  for(let i=0;i<3;i++){await h.manager.step(1,token,curve);h.advance()}
  h.setStatus('reverted');await h.manager.step(1,token,curve);expect(h.burned).toHaveBeenCalledTimes(1)
  h.setStatus('success');h.advance(3000);await h.manager.step(1,token,curve);h.advance()
  expect(await h.manager.step(1,token,curve)).toMatchObject({proceeds:80013752899899322n})
  expect(h.burned).toHaveBeenCalledTimes(1);h.db.close()
 })
 it('completes both permissionless graduation phases before approving and selling',async()=>{
  const h=harness();h.setPhase(0)
  for(let i=0;i<5;i++){await h.manager.step(1,token,curve);h.advance(200)}
  expect(await h.manager.step(1,token,curve)).toMatchObject({proceeds:80013752899899322n})
  expect(h.db.prepare('SELECT kind FROM graduation_transactions ORDER BY at').all()).toEqual([
   {kind:'graduate'},{kind:'create-pool'},{kind:'token-approval'},{kind:'permit-approval'},{kind:'swap'},
  ])
  expect(h.prepared).toHaveBeenCalledTimes(2)
  expect(h.db.prepare('SELECT COUNT(*) n FROM approval_transactions').get()).toEqual({n:2})
  h.db.close()
 })
 it('uses receipt-block allowances and never waits for a quote service',async()=>{
  const h=harness();h.client.simulateContract.mockRejectedValue(Error('quoter unavailable'))
  for(let i=0;i<3;i++){await h.manager.step(1,token,curve);h.advance(200)}
  expect(await h.manager.step(1,token,curve)).toMatchObject({proceeds:80013752899899322n})
  expect(h.client.simulateContract).not.toHaveBeenCalled()
  expect(h.client.multicall.mock.calls.filter(([p])=>p.blockNumber===receipt.blockNumber)).toHaveLength(2)
  h.db.close()
 })
 it('sends the emergency minimum so an older quote cannot block a falling-price exit',async()=>{
  const h=harness()
  for(let i=0;i<3;i++){await h.manager.step(1,token,curve);h.advance(200)}
  const call=h.sign.mock.calls[2]!
  const {args}=decodeFunctionData({abi:routerAbi,data:call[1]})
  const [actions,inputs]=decodeAbiParameters(parseAbiParameters('bytes,bytes[]'),args[1][0]!)
  expect(actions).toBe('0x060c0f')
  const [swap]=decodeAbiParameters(parseAbiParameters(`(${poolType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`),inputs[0]!)
  expect(swap.amountOutMinimum).toBe(1n)
  const [,minimum]=decodeAbiParameters(parseAbiParameters('address,uint256'),inputs[2]!)
  expect(minimum).toBe(1n)
  h.db.close()
 })
 it('caps transient retry delay at one second and keeps the holding open',async()=>{
  const h=harness();h.client.call.mockRejectedValue(Error('RPC temporarily unavailable'))
  for(let i=0;i<12;i++){
   await h.manager.step(1,token,curve)
   const row=h.db.prepare('SELECT retry_at FROM graduation_exits').get() as any
   expect(row.retry_at-h.deps.now()).toBeLessThanOrEqual(GRADUATION_TIMING.maxRetryMs)
   h.advance(1100)
  }
  expect(h.sign).not.toHaveBeenCalled()
  expect(h.db.prepare('SELECT closed FROM positions').get()).toEqual({closed:0})
  h.db.close()
 })

})
