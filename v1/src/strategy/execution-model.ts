import type { ExitRules } from './exit.js'
import type { CurveState } from '../state/curve.js'
import type { Raw } from './counterfactual.js'
import type { PoolReplayRequest } from './pool-evidence.js'

export const EXECUTION_VERSION = 'execution-account-v3'
export const EVIDENCE_VERSION = 'capture-v3'
export type ChainOrder = { block: number; transaction: number; log: number }
export type ExecutionLog = Raw & { at: number; observedAt: number; order: ChainOrder; timeResolutionMs?: number; observationSource?: 'recorded' | 'modeled'; externalBuy?: { quoteInWei: string; minTokensOut: string; traceHash: string } }
export type TimingModel = {
  kind: 'observed' | 'scenario'; label: string; frozenAt: number; fitThrough: number
  n: number; sendMs: number; confirmationMs: number; sellMs: number; observationMs: number
  /** Send-to-inclusion delay. Omitted preserves the historical send-time fill model.
   * confirmationMs remains send-to-adoption, rather than inclusion-to-adoption. */
  buyInclusionMs?: number
  /** Modeled rank among external transactions in the unresolved inclusion second. */
  buyOrderFraction?: number
  sameTimeOrder: 'unavailable' | 'before' | 'after'
}
export type ExecutionCosts = {
  buyWei: string; approvalWei: string; sellWei: string; failedSellWei: string
  approvalDelayMs: number; retryMs: number; maxSellAttempts: number
  /** Precommitted scenario, never populated from this attempt's receipts. */
  failedSellAttempts: number
}
/** Research sensitivity evidence. Never an independent execution certificate. */
export type ResearchPoolQuote = {
  kind: 'historical-pool-quote-scenario'; inputHash: string; scenarioId: string
  attemptedAt: number; executionAt: number; tokens: string; proceedsWei: string; gasWei: string
  block: number; blockAt: number; nextBlockAt: number; evidenceHash: string
  extraDelayMs: number; haircutBps: number; preparationTransactions: number
}
export type ExecutionRequest = {
  modelVersion: typeof EXECUTION_VERSION; evidenceVersion: typeof EVIDENCE_VERSION
  strategyVersion: string; id: string; token: string; curve: string; wallet: string
  params: Record<string, string>; sizeWei: string; entryQuoteTokens: string; minTokens: string
  maxEntryMultiple: number; takeProfit: number; rules: ExitRules
  progressHold?: { initialMs: number; stepMs: number; lookbackMs: number; maximumMs: number }
  entryAt: number; endAt: number; pollMs: number
  /** The position timer starts after send, independently of fill adoption. */
  openedAt?: number
  seed: { state: CurveState; order: ChainOrder; at: number; observedAt: number }
  logs: ExecutionLog[]; timing: TimingModel; costs: ExecutionCosts
  coverage: { complete: boolean; from: number; through: number; independentlyChecked: boolean; gaps: string[] }
  graduation?: { kind:'independent-contract-replay'; inputHash:string; attemptedAt:number; tokens:string; executionAt:number; proceedsWei:string; gasWei:string; curveState:Record<string,string|boolean>; evidenceHash:string; source:string }
  researchPoolQuote?: ResearchPoolQuote
  provenance: { kind: 'prospective' | 'reconstruction'; source: string; capturedAt: number }
}
export type ExecutionResult = {
  modelVersion: typeof EXECUTION_VERSION; evidenceVersion: typeof EVIDENCE_VERSION
  status: 'closed' | 'buy_reverted' | 'rejected' | 'unavailable'
  reason: string; entryAt: number; exitAt: number | null; decisionAt: number | null
  tokens: string | null; spentWei: string | null; proceedsWei: string | null; pnlWei: string | null
  costsWei: string; scenario: string | null; trace: Array<{ at: number; markWei: string; reason: string | null }>
  assumption: 'External traders retain historical order quantities'
  /** Unavailable until an independent contract replay resolves this exact request. */
  poolReplay?: PoolReplayRequest
  approximation?: ResearchPoolQuote
  replayFailure?: { order: ChainOrder; transactionHash: string; error: string; state: Record<string, string | boolean> }
}
export type DelaySample = { completedAt: number; availableAt: number; sendMs: number; confirmationMs: number; sellMs: number; observationMs: number }
export function calibrateTiming(samples: readonly DelaySample[], frozenAt: number, evaluationEnd: number): TimingModel[] {
  const fitThrough = Math.min(frozenAt, evaluationEnd - 6 * 3600_000)
  const fit = samples.filter(s => s.completedAt < fitThrough && s.availableAt < fitThrough
    && [s.sendMs,s.confirmationMs,s.sellMs,s.observationMs].every(v => Number.isFinite(v) && v >= 0))
  if (!fit.length) return []
  return [0.1,0.5,0.9].map(p => {
    const q = (k: 'sendMs' | 'confirmationMs' | 'sellMs' | 'observationMs') => {
      const a = fit.map(s=>s[k]).sort((a,b)=>a-b)
      return a[Math.floor((a.length-1)*p)]!
    }
    return { kind:'scenario', label:`preceding-p${p*100}`, frozenAt, fitThrough, n:fit.length,
      sendMs:q('sendMs'), confirmationMs:q('confirmationMs'), sellMs:q('sellMs'), observationMs:q('observationMs'), sameTimeOrder:'unavailable' }
  })
}
export const compareOrder = (a: ChainOrder,b: ChainOrder) => a.block-b.block || a.transaction-b.transaction || a.log-b.log
