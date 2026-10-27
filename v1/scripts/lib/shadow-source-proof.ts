import { createHash } from 'node:crypto'

type Header = { hash: string; timestamp: number }
/** Extra events after closure cannot alter a finished execution. Its entire prefix must match. */
export function proveExecutionSource(frozen: any[], fetched: any[], headers: Map<number, Header>, closedAt: number) {
  if (!Number.isFinite(closedAt)) throw new Error('missing modeled closure')
  const project = (logs: any[]) => logs.map(log => {
    const block = Number(log.blockNumber), index = Number(log.logIndex), h = headers.get(block)
    if (!h || !Number.isFinite(h.timestamp) || h.hash !== log.blockHash || log.removed) throw new Error('unverified source header')
    return { block, index, at: h.timestamp*1000, address: log.address.toLowerCase(), hash: log.transactionHash.toLowerCase(),
      blockHash: log.blockHash, topics: log.topics.map((t: string) => t.toLowerCase()), data: log.data.toLowerCase() }
  }).sort((a,b) => a.block-b.block || a.index-b.index)
  const before = project(frozen), after = project(fetched)
  const prefix = JSON.stringify(before.filter(l => l.at <= closedAt))
  if (prefix !== JSON.stringify(after.filter(l => l.at <= closedAt))) throw new Error('execution source changed before closure')
  return { scope: 'launch-through-modeled-closure', prefixHash: createHash('sha256').update(prefix).digest('hex'),
    fetchedHash: createHash('sha256').update(JSON.stringify(after)).digest('hex'),
    frozenLogs: before.length, fetchedLogs: after.length, executionLogs: before.filter(l => l.at <= closedAt).length }
}
