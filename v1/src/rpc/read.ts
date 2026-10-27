import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { ENDPOINTS, RPC_URLS, robinhoodChain } from '../config.js'

export const READ_TIMEOUT_MS = 750
export type ReadOptions = {
  batchWait?: number
  /** Wide historical log queries remain on endpoints that support their range. */
  publicLogs?: boolean
  /** Background acquisition may wait for history; real execution keeps its short timeout. */
  background?: boolean
  onProviderRequest?: (method: string) => void
  onSharedReceipt?: () => void
}

/** No quota routing and no hidden retry waits. Callers own operation-level retries. */
export function readClient(
  urls: readonly string[] = [ENDPOINTS.rpcKey, ...RPC_URLS],
  options: ReadOptions = {},
): PublicClient {
  const unique = [...new Set(urls.filter(Boolean))]
  const transports = unique.map(url => http(url, {
      timeout: options.background ? 5000 : READ_TIMEOUT_MS, retryCount: 0,
      batch: options.batchWait === undefined ? false : { wait: options.batchWait },
      onFetchRequest: url === ENDPOINTS.rpcKey && options.onProviderRequest
        ? (_request, init) => {
          // Accounting must never refuse or delay a trading request.
          try {
            const body = JSON.parse(String(init.body))
            for (const call of Array.isArray(body) ? body : [body]) options.onProviderRequest!(call.method)
          } catch { /* a meter is not an execution dependency */ }
        } : undefined,
    }))
  const ordinary=fallback(transports,{retryCount:0})
  const publicUrl=unique.filter(url=>url!==ENDPOINTS.rpcKey).at(-1)??ENDPOINTS.rpcPublic
  const publicHistory=http(publicUrl,{timeout:30_000,retryCount:0})
  const boundedHistory=fallback([
    ...(ENDPOINTS.rpcKey&&unique.includes(ENDPOINTS.rpcKey)?[http(ENDPOINTS.rpcKey,{timeout:5000,retryCount:0})]:[]),
    publicHistory,
  ],{retryCount:0})
  const client = createPublicClient({ chain: robinhoodChain,
    transport: args=>{
      const normal=ordinary(args),wide=publicHistory(args),bounded=boundedHistory(args)
      return {...normal,request:((request,requestOptions)=>{
        if(!options.publicLogs||request.method!=='eth_getLogs')return normal.request(request,requestOptions)
        const filter=(request.params as any)?.[0],from=filter?.fromBlock,to=filter?.toBlock
        // Only the worker's explicit, bounded slices may use the provider. Wide
        // accounting scans retain their public route. Route methods directly so
        // an excluded-method error cannot mask a real timeout or quota response.
        const small=options.background&&/^0x[0-9a-f]+$/i.test(from??'')&&/^0x[0-9a-f]+$/i.test(to??'')
          &&BigInt(to)>=BigInt(from)&&BigInt(to)-BigInt(from)<2000n
        return (small?bounded:wide).request(request,requestOptions)
      }) as typeof normal.request}
    },
  }) as PublicClient
  const pending = new Map<string, ReturnType<PublicClient['getTransactionReceipt']>>()
  return client.extend(() => ({
    getTransactionReceipt: (args: Parameters<PublicClient['getTransactionReceipt']>[0]) => {
      const key = args.hash.toLowerCase()
      const existing = pending.get(key)
      if (existing) {
        try { options.onSharedReceipt?.() } catch { /* telemetry cannot block a receipt */ }
        return existing
      }
      // Share only overlapping reads on this client. Never cache a missing or mined
      // receipt: the next poll must be able to see mining or a changed canonical chain.
      const request = client.getTransactionReceipt(args).finally(() => { pending.delete(key) })
      pending.set(key, request)
      return request
    },
  })) as PublicClient
}
