/** Research-only frozen kernel extension. Default replay requires exact fixture parity. */
import { EVENT_TOPICS, logWord } from '../../src/abi.js'
import { freshCurve, simBuy, simSell, markToExit, graduationProgress, type CurveParams, type CurveState } from '../../src/state/curve.js'
import { evaluate } from '../../src/strategy/exit-evaluation.js'

export const fields = [
  "phantomQuote",
  "reservedTokens",
  "launchSupply",
  "feeBps",
  "creatorTaxBps",
  "snipeTaxStartBps",
  "snipeTaxSeconds",
  "launchedAt",
] as const;
export type Raw = {
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  topics: string[];
  data: string;
  address: string;
  at?: number;
};
export const params = (r: any): CurveParams =>
  Object.fromEntries(fields.map((k) => [k, BigInt(r[k])])) as CurveParams;
export const ordered = (logs: Raw[]) =>
  [
    ...new Map(
      logs.map((l) => [`${l.transactionHash}:${l.logIndex}`, l]),
    ).values(),
  ].sort(
    (a, b) =>
      Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
  );
export function apply(s: CurveState, l: Raw): CurveState {
  const w = (n: number) => logWord(l.data, n);
  switch (l.topics[0]) {
    case EVENT_TOPICS.CurveBuy:
      return {
        ...s,
        trackedQuote: s.trackedQuote + w(0),
        trackedTokens: s.trackedTokens - w(1),
        quoteFeeBalance: s.quoteFeeBalance + w(2),
        creatorTaxBalance: s.creatorTaxBalance + w(3),
      };
    case EVENT_TOPICS.CurveSell:
      return {
        ...s,
        trackedQuote: s.trackedQuote - w(1),
        trackedTokens: s.trackedTokens + w(0),
        quoteFeeBalance: s.quoteFeeBalance + w(2),
        creatorTaxBalance: s.creatorTaxBalance + w(3),
      };
    case EVENT_TOPICS.BuybackLocked:
      return { ...s, trackedTokens: s.trackedTokens - w(1) };
    case EVENT_TOPICS.FeesSwept:
      return {
        ...s,
        trackedQuote: s.trackedQuote - w(0) - w(2),
        quoteFeeBalance: 0n,
        creatorTaxBalance: 0n,
      };
    case EVENT_TOPICS.FeesRescued:
      return {
        ...s,
        trackedQuote: s.trackedQuote - w(0) - w(1),
        quoteFeeBalance: 0n,
        creatorTaxBalance: 0n,
      };
    case EVENT_TOPICS.CurveCompleted:
      return { ...s, trackedQuote: 0n, trackedTokens: 0n, graduated: true };
    default:
      return s;
  }
}
// Frozen research copy: default behavior is checked against the shared kernel.
// Dynamic deadlines never enter the deployed worker.
export function replay(r: any) {
  r = {...r, rules: {...r.rules}};
  let deadline = r.exitPolicy?.initialMs ?? r.rules.maxHoldMs;
  let checkpointMark: bigint | null = null;
  let lastImproved = r.openedAt ?? r.entryAt;
  let improvementMark: bigint | null = null;

  const p = params(r.params);
  let s = freshCurve(p);
  const wallet = (r.wallet ?? "").toLowerCase().replace("0x", "");
  const recorded = r.mode === "recorded_fill";
  const all = ordered(r.logs).map((l) => ({
    ...l,
    at: l.at ?? Number(r.blocks?.[l.blockNumber]?.timestamp) * 1000,
  }));
  const ours = (l: Raw) =>
    Boolean(wallet) &&
    l.topics.slice(1, 3).some((t) => t.slice(-40).toLowerCase() === wallet);
  const logs = recorded ? all : all.filter((l) => !ours(l));
  if (logs.some((l) => !Number.isFinite(l.at)))
    return { status: "missing_block_time" };
  const size = BigInt(r.sizeWei),
    entry = r.entryAt,
    buyAt = r.buyAt ?? entry,
    openedAt = r.openedAt ?? entry,
    lag = r.sellDelayMs ?? 600;
  let i = 0,
    firstTick = entry;
  let tokens: bigint;
  let spent: bigint;
  if (recorded) {
    const boundary = logs.findIndex(
      (l) =>
        l.transactionHash.toLowerCase() === String(r.buyHash).toLowerCase() &&
        l.topics[0] === EVENT_TOPICS.CurveBuy,
    );
    if (boundary < 0) return { status: "missing_actual_buy_event" };
    while (i <= boundary) s = apply(s, logs[i++]!);
    const fill = logs[boundary]!;
    tokens = logWord(fill.data, 1);
    spent = logWord(fill.data, 0);
    firstTick = Math.max(entry, fill.at);
  } else {
    firstTick = Math.max(buyAt, openedAt);
    while (i < logs.length && logs[i]!.at < entry) s = apply(s, logs[i++]!);
    try {
      if (r.maxEntryMultiple) {
        const decision = simBuy(p, s, size, BigInt(Math.floor(buyAt / 1000)), {
          exempt: r.exempt ?? false,
        });
        const fresh = simBuy(
          p,
          freshCurve(p),
          size,
          BigInt(Math.floor(buyAt / 1000)),
          { exempt: r.exempt ?? false },
        );
        if (Number(fresh.tokensOut) / Number(decision.tokensOut) > r.maxEntryMultiple)
          return { status: "entry_price_rejected" };
      }
      while (i < logs.length && logs[i]!.at < buyAt) s = apply(s, logs[i++]!);
      const z = simBuy(p, s, size, BigInt(Math.floor(buyAt / 1000)), {
        exempt: r.exempt ?? false,
      });
      s = z.next;
      tokens = z.tokensOut;
      spent = z.spent;
    } catch (e) {
      return {
        status: "buy_reverted",
        error: String(e),
        pnlWei: -BigInt(r.buyGasWei ?? 0),
        exitAt: buyAt,
      };
    }
  }
  const pos = {
    exiting: false,
    peakMarkWei: recorded ? BigInt(r.entryMarkWei) : markToExit(p, s, tokens),
    id: 1,
    token: r.token,
    curve: r.curve,
    tokens,
    spendWei: spent,
    entryMarkWei: recorded ? BigInt(r.entryMarkWei) : markToExit(p, s, tokens),
    openedAt,
    buyHash: r.buyHash ?? "",
    filled: true,
    takeProfitMultiple: r.takeProfit,
    rules: r.rules,
  };
  const end = r.endAt ?? entry + 180000;
  let pending: number | null = null;
  let reason: string | null = null;
  const trace: any[] = [];
  const interval = r.pollMs ?? 500;
  for (let at = firstTick; at <= end; at += interval) {
    while (i < logs.length && logs[i]!.at <= at) {
      const l = logs[i++]!;
      const ours = (r.wallet ?? "").toLowerCase().replace("0x", "");
      if (
        ours &&
        l.topics.slice(1, 3).some((t) => t.slice(-40).toLowerCase() === ours)
      )
        continue;
      // Fixed external order quantities, recomputed against candidate reserves.
      try {
        if (recorded) s = apply(s, l);
        else if (
          l.topics[0] === EVENT_TOPICS.CurveCompleted &&
          !s.graduated &&
          s.trackedTokens > p.reservedTokens
        )
          return { status: "graduation_path_diverged", at, trace };
        else if (l.topics[0] === EVENT_TOPICS.CurveBuy)
          s = simBuy(
            p,
            s,
            logWord(l.data, 0),
            BigInt(Math.floor(l.at / 1000)),
            {
              exempt:
                logWord(l.data, 2) === (logWord(l.data, 0) * p.feeBps) / 10000n,
            },
          ).next;
        else if (l.topics[0] === EVENT_TOPICS.CurveSell)
          s = simSell(p, s, logWord(l.data, 0)).next;
        else s = apply(s, l);
      } catch {
        return {
          status: "external_order_unresolved",
          at,
          token: r.token,
          trace,
        };
      }
    }
    if (pending !== null && at >= pending) {
      try {
        const z = simSell(p, s, tokens);
        return {
          status: "closed",
          entryAt: entry,
          exitAt: at,
          tokens,
          spent,
          pnlWei: z.quoteOut - spent - BigInt(r.gasWei ?? 0),
          proceedsWei: z.quoteOut,
          reason,
          trace,
        };
      } catch {
        return {
          status: "pool_required",
          entryAt: entry,
          at,
          tokens,
          spent,
          reason,
          trace,
          assumption:
            "candidate curve state requires historical-pool compatibility check",
        };
      }
    }
    if (pending === null) {
      const mark = markToExit(p, s, tokens);
      const h = r.exitPolicy;
      if (h) {
        const age = at - pos.openedAt;
        checkpointMark ??= pos.entryMarkWei;
        improvementMark ??= pos.entryMarkWei;
        if (h.kind === 'progress' && age >= deadline && deadline < h.capMs) {
          if (mark * 10000n >= checkpointMark * BigInt(10000 + h.improvementBps)) {
            deadline = Math.min(h.capMs, deadline + h.stepMs);
            checkpointMark = mark;
          }
        }
        if (h.kind === 'inactivity') {
          if (mark * 10000n >= improvementMark * BigInt(10000 + h.improvementBps)) {
            lastImproved = at; improvementMark = mark;
          }
          deadline = Math.min(h.capMs, lastImproved - pos.openedAt + h.idleMs);
        }
        pos.rules.maxHoldMs = deadline;
      }
      reason = evaluate(
        pos,
        mark,
        at,
        s.graduated || graduationProgress(p, s) <= 0.12,
      );
      if (reason) {
        trace.push({ at, reason, mark });
        if (recorded)
          return {
            status: "decision",
            decisionAt: at,
            reason,
            mark,
            tokens,
            spent,
            trace,
          };
        pending = at + lag;
      }
    }
  }
  return { status: "incomplete_path", tokens, spent, trace };
}
