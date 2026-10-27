import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readClient } from '../src/rpc/read.js'
import { ENDPOINTS } from '../src/config.js'

const servers: ReturnType<typeof createServer>[] = []
const originalProvider = ENDPOINTS.rpcKey
async function endpoint(reply: (body: any, res: any) => void) {
  const s = createServer((req, res) => {
    let text = ''
    req.on('data', b => { text += b })
    req.on('end', () => reply(JSON.parse(text), res))
  })
  servers.push(s)
  return new Promise<string>(resolve => s.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${(s.address() as any).port}`)
  }))
}
const answer = (body: any, res: any, result: any) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
}
afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() }
  vi.restoreAllMocks()
  Object.assign(ENDPOINTS, { rpcKey: originalProvider })
})

describe('bounded provider reads', () => {
  it('shares overlapping receipt reads, then fetches again after mining and failure', async () => {
    const waiting: Array<{ body: any; res: any }> = []
    let calls = 0, shared = 0
    const url = await endpoint((body, res) => { calls++; waiting.push({ body, res }) })
    const client = readClient([url], { onSharedReceipt: () => { shared++ } })
    const hash = `0x${'ab'.repeat(32)}` as const
    const first = Promise.allSettled([
      client.getTransactionReceipt({ hash }),
      client.getTransactionReceipt({ hash }),
    ])
    await vi.waitFor(() => expect(waiting).toHaveLength(1))
    const missing = waiting.shift()!
    answer(missing.body, missing.res, null)
    expect((await first).map(r => r.status)).toEqual(['rejected', 'rejected'])
    expect([calls, shared]).toEqual([1, 1])

    const mined = client.getTransactionReceipt({ hash })
    await vi.waitFor(() => expect(waiting).toHaveLength(1))
    const receipt = { transactionHash: hash, blockHash: hash, blockNumber: '0x1',
      transactionIndex: '0x0', gasUsed: '0x1', cumulativeGasUsed: '0x1',
      effectiveGasPrice: '0x1', status: '0x1', type: '0x0', logs: [] }
    const ready = waiting.shift()!
    answer(ready.body, ready.res, receipt)
    expect((await mined).status).toBe('success')

    const refreshed = client.getTransactionReceipt({ hash })
    await vi.waitFor(() => expect(waiting).toHaveLength(1))
    const changed = waiting.shift()!
    answer(changed.body, changed.res, { ...receipt, blockNumber: '0x2' })
    expect((await refreshed).blockNumber).toBe(2n)
    expect(calls).toBe(3)
  })

  it('keeps different receipts independent and contains shared-read meter errors', async () => {
    let calls = 0
    const url = await endpoint((body, res) => { calls++; answer(body, res, null) })
    const client = readClient([url], { onSharedReceipt: () => { throw new Error('meter') } })
    const a = `0x${'ab'.repeat(32)}` as const, b = `0x${'cd'.repeat(32)}` as const
    const results = await Promise.allSettled([a, a, b].map(hash => client.getTransactionReceipt({ hash })))
    expect(results.every(r => r.status === 'rejected')).toBe(true)
    expect(calls).toBe(2)
  })

  it.each([429, 403, 500])('falls back once after HTTP %i', async status => {
    let first = 0, second = 0
    const urls = await Promise.all([
      endpoint((_b, r) => { first++; r.writeHead(status); r.end('unavailable') }),
      endpoint((b, r) => { second++; answer(b, r, '0x1237') }),
    ])
    expect(await readClient(urls).getChainId()).toBe(4663)
    expect([first, second]).toEqual([1, 1])
  })

  it('bounds an outage of both endpoints instead of retrying indefinitely', async () => {
    let calls = 0
    const urls = await Promise.all([endpoint(() => { calls++ }), endpoint(() => { calls++ })])
    const start = Date.now()
    await expect(readClient(urls).getChainId()).rejects.toThrow()
    expect(calls).toBe(2)
    expect(Date.now() - start).toBeLessThan(3000)
  }, 5000)

  it('does not replace a successful provider response with a public read', async () => {
    let fallbackCalls = 0
    const urls = await Promise.all([
      endpoint((b, r) => answer(b, r, '0x1237')),
      endpoint((b, r) => { fallbackCalls++; answer(b, r, '0x1') }),
    ])
    expect(await readClient(urls).getChainId()).toBe(4663)
    expect(fallbackCalls).toBe(0)
  })

  it('routes a wide historical log query to the public endpoint without trying the provider', async () => {
    let providerCalls = 0, publicCalls = 0
    const urls = await Promise.all([
      endpoint((_b, r) => { providerCalls++; r.writeHead(500); r.end() }),
      endpoint((b, r) => { publicCalls++; answer(b, r, []) }),
    ])
    Object.assign(ENDPOINTS, { rpcKey: urls[0]! })
    expect(await readClient(urls, { publicLogs: true }).request({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0xffff' }] })).toEqual([])
    expect([providerCalls, publicCalls]).toEqual([0, 1])
  })

  it('gives background reads time to finish without changing the execution timeout',async()=>{
    const url=await endpoint((b,r)=>setTimeout(()=>answer(b,r,'0x1237'),900))
    expect(await readClient([url],{publicLogs:true,background:true}).getChainId()).toBe(4663)
    await expect(readClient([url]).getChainId()).rejects.toThrow()
  })

  it('uses the provider for bounded background logs while wide scans stay public',async()=>{
    const calls:number[]=[]
    const urls=await Promise.all([0,1].map(i=>endpoint((b,r)=>{calls.push(i);answer(b,r,[])})))
    Object.assign(ENDPOINTS,{rpcKey:urls[0]!})
    const client=readClient(urls,{publicLogs:true,background:true})
    await client.request({method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x7d0'}]})
    expect(calls).toEqual([0])
    await client.request({method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x7d1'}]})
    expect(calls).toEqual([0,1])
  })

  it('falls back for bounded history and preserves public failure diagnostics',async()=>{
    const calls:number[]=[]
    const urls=await Promise.all([
      endpoint((_b,r)=>{calls.push(0);r.writeHead(429);r.end('provider capacity')}),
      endpoint((b,r)=>{calls.push(1);answer(b,r,[])}),
    ])
    Object.assign(ENDPOINTS,{rpcKey:urls[0]!})
    expect(await readClient(urls,{publicLogs:true,background:true}).request({method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x2'}]})).toEqual([])
    expect(calls).toEqual([0,1])
    const failed=await endpoint((_b,r)=>{r.writeHead(429);r.end('Too Many Requests')})
    await expect(readClient([failed],{publicLogs:true}).request({method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'latest'}]})).rejects.toThrow(/429/)
  })

  it('retains the actual RPC failure instead of reporting an excluded method',async()=>{
    const url=await endpoint((_b,r)=>{r.writeHead(429);r.end('Too Many Requests')})
    await expect(readClient([url],{publicLogs:true}).getChainId()).rejects.toThrow(/429/)
  })

  it('counts every method in a batch and tolerates a failing meter', async () => {
    const methods: string[] = []
    const url = await endpoint((b, r) => {
      r.setHeader('content-type', 'application/json')
      r.end(JSON.stringify((Array.isArray(b) ? b : [b]).map(x => ({ jsonrpc: '2.0', id: x.id, result: x.method === 'eth_chainId' ? '0x1237' : '0x1' }))))
    })
    Object.assign(ENDPOINTS, { rpcKey: url })
    const client = readClient([url], { batchWait: 4, onProviderRequest: m => { methods.push(m) } })
    expect(await Promise.all([client.getChainId(), client.getBlockNumber()])).toEqual([4663, 1n])
    expect(methods.sort()).toEqual(['eth_blockNumber', 'eth_chainId'])
    const throwing = readClient([url], { batchWait: 4, onProviderRequest: () => { throw new Error('meter unavailable') } })
    expect(await throwing.getChainId()).toBe(4663)
  })
})
