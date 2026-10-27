/** Offline JSONL adapter. Network and live configuration belong outside this process. */
import readline from "node:readline";
import factoryAbi from "../../src/factory.abi.json" with { type: "json" };
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
const { currentExitRules } = await import("../../src/strategy/exit.js");
const { replay: pureReplay, fields, params, ordered, apply } = await import("../../src/strategy/counterfactual.js");
const replay = (r: any) => pureReplay({ ...r, rules: r.rules ?? currentExitRules() });
const { adaptiveTakeProfit } = await import("../../src/strategy/takeprofit.js");
const { V4, graduatedProceeds } = await import("../../src/tx/graduated.js");
const multicall = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)",
]);
const poolAbi = parseAbi([
  "struct PoolKey {address currency0;address currency1;uint24 fee;int24 tickSpacing;address hooks;}",
  "struct Params {PoolKey poolKey;bool zeroForOne;uint128 exactAmount;bytes hookData;}",
  "function quoteExactInputSingle(Params params) returns(uint256 amountOut,uint256 gasEstimate)",
]);
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
    case "encode_pool_context":
      return encodeFunctionData({abi:factoryAbi,functionName:"getLaunchedToken",args:[r.token]});
    case "decode_pool_context":
      return decodeFunctionResult({abi:factoryAbi,functionName:"getLaunchedToken",data:r.data});
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
