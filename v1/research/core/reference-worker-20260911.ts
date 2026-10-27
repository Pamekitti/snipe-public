/** Offline JSONL adapter. Network and live configuration belong outside this process. */
import readline from "node:readline";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { curveAbi, EVENT_TOPICS, logWord } from "../../src/abi.js";
import {
  freshCurve,
  simBuy,
  simSell,
  markToExit,
  graduationProgress,
  type CurveParams,
  type CurveState,
} from "../../src/state/curve.js";

// evaluate imports config for unrelated default helpers. Never allow the live env file.
if (process.env.ENV_FILE !== "/dev/null")
  throw new Error("worker requires isolated ENV_FILE=/dev/null");
console.log = (...args: unknown[]) => console.error(...args);
const { evaluate, newPosition } = await import("../../src/strategy/exit.js");
const { adaptiveTakeProfit } = await import("../../src/strategy/takeprofit.js");
const { V4, graduatedProceeds } = await import("../../src/tx/graduated.js");
const fields = [
  "phantomQuote",
  "reservedTokens",
  "launchSupply",
  "feeBps",
  "creatorTaxBps",
  "snipeTaxStartBps",
  "snipeTaxSeconds",
  "launchedAt",
] as const;
const multicall = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)",
]);
const poolAbi = parseAbi([
  "struct PoolKey {address currency0;address currency1;uint24 fee;int24 tickSpacing;address hooks;}",
  "struct Params {PoolKey poolKey;bool zeroForOne;uint128 exactAmount;bytes hookData;}",
  "function quoteExactInputSingle(Params params) returns(uint256 amountOut,uint256 gasEstimate)",
]);
type Raw = {
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  topics: string[];
  data: string;
  address: string;
  at?: number;
};
const params = (r: any): CurveParams =>
  Object.fromEntries(fields.map((k) => [k, BigInt(r[k])])) as CurveParams;
const ordered = (logs: Raw[]) =>
  [
    ...new Map(
      logs.map((l) => [`${l.transactionHash}:${l.logIndex}`, l]),
    ).values(),
  ].sort(
    (a, b) =>
      Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
  );
function apply(s: CurveState, l: Raw): CurveState {
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
function benchmark(r: any) {
  const p = params(r.params);
  let s = freshCurve(p);
  const checks: any[] = [];
  for (const l of ordered(r.logs)) {
    const w = (n: number) => logWord(l.data, n);
    if (
      l.topics[0] === EVENT_TOPICS.CurveBuy ||
      l.topics[0] === EVENT_TOPICS.CurveSell
    ) {
      try {
        let predicted: bigint;
        let taxVerified = false;
        if (l.topics[0] === EVENT_TOPICS.CurveSell) {
          const z = simSell(p, s, w(0));
          predicted = z.quoteOut;
          taxVerified = z.fee === w(2) && z.tax === w(3);
        } else {
          // Validate integer AMM independently using emitted fee amounts. Full tax
          // checks require timestamp plus an explicit historical exemption value.
          const net = w(0) - w(2) - w(3);
          const Q =
            p.phantomQuote +
            s.trackedQuote -
            s.quoteFeeBalance -
            s.creatorTaxBalance;
          predicted = (net * s.trackedTokens) / (Q + net);
          const left = s.trackedTokens - p.reservedTokens;
          if (predicted > left) predicted = left;
          const b = r.blocks?.[l.blockNumber];
          const knownEx =
            r.exemptions?.[`${l.blockNumber}:${l.topics[2]?.slice(-40)}`];
          const ex =
            typeof knownEx === "boolean"
              ? knownEx
              : b && BigInt(b.timestamp) >= p.launchedAt + p.snipeTaxSeconds
                ? false
                : undefined;
          if (b && typeof ex === "boolean") {
            const z = simBuy(p, s, w(0), BigInt(b.timestamp), { exempt: ex });
            taxVerified = z.fee + z.snipeTax === w(2) && z.tax === w(3);
          }
        }
        checks.push({
          tx: l.transactionHash,
          index: l.logIndex,
          side: l.topics[0] === EVENT_TOPICS.CurveBuy ? "buy" : "sell",
          actual: w(1),
          predicted,
          match: predicted === w(1),
          taxVerified,
        });
      } catch (e) {
        checks.push({
          tx: l.transactionHash,
          index: l.logIndex,
          match: false,
          error: String(e),
        });
      }
    }
    s = apply(s, l);
  }
  return { checks, state: s };
}
function replay(r: any) {
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
  const pos = newPosition({
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
  });
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
export async function dispatch(r: any): Promise<any> {
  switch (r.op) {
    case "metadata":
      return { fields, topics: EVENT_TOPICS, v4: V4 };
    case "encode_params":
      return encodeFunctionData({
        abi: multicall,
        functionName: "aggregate3",
        args: [
          r.curves.flatMap((target: string) =>
            fields.map((functionName) => ({
              target,
              allowFailure: true,
              callData: encodeFunctionData({ abi: curveAbi, functionName }),
            })),
          ),
        ],
      });
    case "decode_params": {
      const values = decodeFunctionResult({
        abi: multicall,
        functionName: "aggregate3",
        data: r.data,
      });
      return r.curves.map((curve: string, i: number) => ({
        curve,
        params: Object.fromEntries(
          fields.map((k, j) => {
            const v = values[i * fields.length + j]!;
            return [k, v.success ? BigInt(v.returnData) : null];
          }),
        ),
      }));
    }
    case "encode_pool":
      return encodeFunctionData({
        abi: poolAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: r.key,
            zeroForOne: false,
            exactAmount: BigInt(r.tokens),
            hookData: "0x",
          },
        ],
      });
    case "decode_pool":
      return decodeFunctionResult({
        abi: poolAbi,
        functionName: "quoteExactInputSingle",
        data: r.data,
      });
    case "pool_receipt":
      return graduatedProceeds(r.logs, r.key, r.wallet);
    case "math": {
      const p = params(r.params);
      const s = r.state
        ? (Object.fromEntries(
            Object.entries(r.state).map(([k, v]) => [
              k,
              k === "graduated" ? v : BigInt(String(v)),
            ]),
          ) as CurveState)
        : freshCurve(p);
      return r.side === "sell"
        ? simSell(p, s, BigInt(r.amount))
        : simBuy(p, s, BigInt(r.amount), BigInt(r.at), {
            exempt: r.exempt ?? false,
          });
    }
    case "benchmark":
      return benchmark(r);
    case "replay":
      return replay(r);
    case "replay_many":
      return r.variants.map((variant: any) => replay({ ...r.request, ...variant }));
    case "adaptive":
      return adaptiveTakeProfit(r.rows, r.window, r.bars, r.fallback);
    default:
      throw new Error("unknown worker operation");
  }
}
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  try {
    const req = JSON.parse(line);
    const value = await dispatch(req);
    process.stdout.write(
      JSON.stringify({ ok: true, value }, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ) + "\n",
    );
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: String(e) }) + "\n",
    );
  }
}
