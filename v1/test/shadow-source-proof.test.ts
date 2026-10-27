import { describe, expect, it } from 'vitest'
import { proveExecutionSource } from '../scripts/lib/shadow-source-proof.js'
const headers = new Map([[1,{hash:'one',timestamp:1}],[2,{hash:'two',timestamp:2}]])
const first={address:'0xab',blockNumber:'0x1',logIndex:'0x0',blockHash:'one',transactionHash:'tx',topics:['0xaa'],data:'0x00'}
const late={...first,blockNumber:'0x2',blockHash:'two',transactionHash:'late'}
describe('prospective execution source coverage', () => {
  it('ignores transport metadata but requires exact execution data', () => {
    expect(proveExecutionSource([first],[{...first,transactionIndex:'0x1',removed:false}],headers,1500).executionLogs).toBe(1)
    expect(()=>proveExecutionSource([first],[{...first,data:'0x01'}],headers,1500)).toThrow('before closure')
  })
  it('allows later events only after modeled closure', () => {
    expect(proveExecutionSource([first],[first,late],headers,1500).fetchedLogs).toBe(2)
    expect(()=>proveExecutionSource([first],[first,late],headers,2000)).toThrow('before closure')
  })
  it('rejects missing execution events and unverified headers', () => {
    expect(()=>proveExecutionSource([first],[],headers,1500)).toThrow('before closure')
    expect(()=>proveExecutionSource([first],[first],new Map(),1500)).toThrow('header')
    expect(()=>proveExecutionSource([first],[{...first,blockHash:'fork'}],headers,1500)).toThrow('header')
  })
})
