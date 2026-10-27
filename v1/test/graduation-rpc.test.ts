import {createServer} from 'node:http'
import {describe,it,expect} from 'vitest'
import {graduationClient} from '../src/graduation.js'
describe('graduation RPC failover',()=>{
 it('abandons an unresponsive endpoint and reads from the next provider without retries',async()=>{
  let hung=0,healthy=0
  const first=createServer(()=>{hung++})
  const second=createServer((req,res)=>{
   healthy++;let body='';req.on('data',b=>body+=b);req.on('end',()=>{
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(body).id,result:'0x1237'}))
   })
  })
  const listen=(s:typeof first)=>new Promise<string>(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${(s.address() as any).port}`)))
  try{
   const urls=await Promise.all([listen(first),listen(second)])
   expect(await graduationClient(urls).getChainId()).toBe(4663)
   expect(hung).toBe(1);expect(healthy).toBe(1)
  }finally{
   first.closeAllConnections();second.closeAllConnections();first.close();second.close()
  }
 },5000)
})
