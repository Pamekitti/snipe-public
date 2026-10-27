/** Deterministic identity for independently replayed pool exits. No RPC or execution. */
import { createHash } from 'node:crypto'
import type { ExecutionRequest, ChainOrder } from './execution-model.js'

function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]),
  )
  return value
}

/** Bind the whole curve path, wallet exclusion, costs, clocks and pinned exit rules.
 * Zero reserves after graduation alone do not establish pool-state compatibility. */
export function poolReplayHash(request: ExecutionRequest): string {
  const { graduation: _evidence, researchPoolQuote: _scenario, ...inputs } = request
  return createHash('sha256').update(JSON.stringify(canonical(inputs))).digest('hex')
}

export type PoolReplayRequest = {
  version: 'pool-replay-v1'
  inputHash: string
  token: string
  curve: string
  wallet: string
  tokens: string
  attemptedAt: number
  buyAt: number
  entryAfter: ChainOrder
  exitAfter: ChainOrder
  decisionAt: number
  costsAlreadyChargedWei: string
  curveState: Record<string, string | boolean>
}
