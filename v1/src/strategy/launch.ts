/**
 * Launch detection and filtering.
 *
 * The filters are the ones that survived the research pass. Creator tax above 1% is an
 * immediate no: a quarter of launches set 10% and they are unwinnable. The dev-buy floor
 * is the one filter known to be regime-specific (worth +4.8pp in the V2 era but slightly
 * negative in V1), so it is configurable and re-tested rather than baked in.
 */
import { decodeFunctionData, type Hex } from 'viem'
import { ADDRESSES, STRATEGY } from '../config.js'
import { EVENT_TOPICS, SELECTORS, launcherAbi } from '../abi.js'
import type { RawLog } from '../logs/subscriber.js'

export type LaunchInfo = {
  token: string
  curve: string
  deployer: string
  pairToken: string
  block: number
  detectedAt: number
  source: 'feed' | 'logs'
  /** the creator's bundled buy, wei; set by bot.onLaunch, read by the template key */
  devBuyWei?: bigint
  /**
   * How many snipe-tax-exempt wallets the creator registered, from the launch calldata.
   * Filled in by bot.onLaunch once the calldata is parsed, so it rides the LaunchInfo into
   * enter() where strategy/entry.ts reads it. null when the calldata never arrived.
   */
  exemptions?: number | null
}

export type Verdict = { pass: boolean; reason?: string }

/**
 * When our entry lands, in chain seconds: launch + the tax-decay wait. Derived in one
 * place because the flooring is load-bearing twice over -- the snipe tax reads whole
 * seconds (150ms early is a whole tax bracket, not a 150ms mistake), and gatewatch
 * prices its notional entry at the same +2s, which is what makes the bot's series and
 * the gate's comparable at all.
 */
export const entryArmTs = (launchedAt: bigint): bigint =>
  launchedAt + BigInt(Math.floor(STRATEGY.entryDelayMs / 1000))

/**
 * Is this timestamp inside a UTC hour window? Half-open [from, to); a window that wraps
 * midnight (22-04) is the union of [22, 24) and [0, 4). A null window is always open.
 *
 * These were the entry clock's helpers and are now the provider socket's (config.ts
 * wsHours, env WS_HOURS): they decide which endpoint a launch is READ from, never whether
 * it is traded. The entry clock they were written for was deleted on 2026-09-07.
 *
 * Still decided on the CHAIN's timestamp where a launch is involved, never the wall clock,
 * so a replay and the bot answer identically for the same launch.
 */
/** hours a day the window is open: 24 when off, wrap-around handled */
export function entryWindowHours(w: { from: number; to: number } | null): number {
  if (!w) return 24
  const h = w.from < w.to ? w.to - w.from : 24 - w.from + w.to
  return Math.max(1, Math.min(24, h))
}

export function inEntryWindow(launchedAtSec: bigint | number, w: { from: number; to: number } | null): boolean {
  if (!w) return true
  const h = new Date(Number(launchedAtSec) * 1000).getUTCHours()
  return w.from < w.to ? h >= w.from && h < w.to : h >= w.from || h < w.to
}

/** the UTC hour of a chain timestamp, for logs */
export const utcHour = (sec: bigint | number): number => new Date(Number(sec) * 1000).getUTCHours()

const addrFromTopic = (t: string): string => '0x' + t.slice(26).toLowerCase()

export function parseTokenLaunched(log: RawLog, source: 'feed' | 'logs' = 'logs'): LaunchInfo | null {
  if (log.topics[0] !== EVENT_TOPICS.TokenLaunched) return null
  if (log.address.toLowerCase() !== ADDRESSES.factory.toLowerCase()) return null
  const d = log.data.slice(2)
  const word = (n: number) => d.slice(n * 64, (n + 1) * 64)
  return {
    token: addrFromTopic(log.topics[1]!),
    curve: addrFromTopic(log.topics[2]!),
    deployer: addrFromTopic(log.topics[3]!),
    pairToken: '0x' + word(0).slice(24),
    block: log.blockNumber,
    detectedAt: Date.now(),
    source,
  }
}

/** Cheap checks, run the instant we see the launch. */
export function screenLaunch(l: LaunchInfo): Verdict {
  if (l.pairToken.toLowerCase() !== ADDRESSES.ethPair) {
    return { pass: false, reason: `non-eth pair ${l.pairToken.slice(0, 10)}` }
  }
  return { pass: true }
}

/**
 * Checks that need curve params, the creator's own buy and the launch calldata, run
 * before entry fires. One book for live and shadow, as of the 2026-08-19 widening: creator
 * tax <= 200bps, dev buy >= 0.01 ETH, deployer with <= 3 prior launches, >= 1 exempt wallet.
 * The constants live in STRATEGY.book with the measurement behind each one.
 */
export function screenCurve(args: {
  /**
   * null = not read yet. bot.onLaunch screens on the free calldata BEFORE the paid curve
   * read, and only the creator tax lives on the curve; null skips that one check and the
   * full screen runs again with the tax once the read is back.
   */
  creatorTaxBps: bigint | null
  devBuyWei: bigint
  meta: LaunchMeta | null
  /** how many coins this deployer already launched; see strategy/deployers.ts */
  priorLaunches: number
  /** REQUIRE_DEV_BUY=0: observe everything with an acceptable creator tax */
  requireDevBuy: boolean
  /**
   * Exact dev-buy wei values (decimal strings) currently blocked by the template gate:
   * the seed plus whatever gatewatch published. See STRATEGY.book.templateGate. Optional
   * so shadow/observe callers and old tests screen without it; absent means seed-less,
   * not "gate off" -- the caller owns merging the seed in.
   */
  blockedDev?: ReadonlySet<string>
}): Verdict {
  if (args.creatorTaxBps !== null && args.creatorTaxBps > BigInt(STRATEGY.maxCreatorTaxBps)) {
    return { pass: false, reason: `creator tax ${args.creatorTaxBps}bps` }
  }
  if (!args.requireDevBuy) return { pass: true }
  if (args.devBuyWei < STRATEGY.book.minDevBuyWei) {
    return { pass: false, reason: `dev buy ${args.devBuyWei}` }
  }
  // the template gate: this exact dev-buy value has been stamped onto enough scored
  // launches recently, and they did not pay. First word 'template' is the reject bucket.
  if (args.blockedDev?.has(args.devBuyWei.toString())) {
    return { pass: false, reason: `template dev ${args.devBuyWei}` }
  }
  if (args.priorLaunches > STRATEGY.book.maxPriorLaunches) {
    return { pass: false, reason: `repeat deployer (${args.priorLaunches} prior launches)` }
  }
  // A creator who pre-approved nobody is not running a coordinated launch, and it shows:
  // see STRATEGY.book.minExemptions for the measurement. meta is never null on a launch
  // that gets this far (devBuyWei comes from the same calldata parse, so a failed parse
  // already fails the dev-buy floor), but reject explicitly rather than pass on unknown.
  const ex = args.meta?.exemptions ?? null
  if (ex === null) return { pass: false, reason: 'no launch metadata' }
  if (ex < STRATEGY.book.minExemptions) {
    return { pass: false, reason: `no exempt wallets (${ex})` }
  }
  return { pass: true }
}

/**
 * The trading book. Kept as a pure function so stats and the dashboard score the same set.
 * Three conditions as of 2026-08-18: a big dev buy, a deployer who has never launched
 * before, and at least one pre-approved exempt wallet. Serial launchers are negative in
 * every era measured; zero-exemption launches are the dead half of the book.
 */
export function inBook(devBuyWei: bigint, priorLaunches: number, exemptions: number | null): boolean {
  return devBuyWei >= STRATEGY.book.minDevBuyWei
    && priorLaunches <= STRATEGY.book.maxPriorLaunches
    && exemptions !== null && exemptions >= STRATEGY.book.minExemptions
}

/**
 * What the creator told the launcher, decoded from the launch transaction's calldata.
 * The feed carries this at +0s, so it is fair game as a filter, and it is what a human
 * browsing the launchpad actually sees.
 */
export type LaunchMeta = {
  name: string
  symbol: string
  logo: string
  hasTwitter: boolean
  hasWebsite: boolean
  hasTelegram: boolean
  descriptionLen: number
  /** number of snipe-tax-exempt wallets the creator registered: a bundle */
  exemptions: number
  buybackEnabled: boolean
  quoteInWei: bigint
}

export function parseLaunchCalldata(data: Hex): LaunchMeta | null {
  if (!data || data.slice(0, 10) !== SELECTORS.launchAndBuy) return null
  try {
    const d = decodeFunctionData({ abi: launcherAbi, data })
    const [p, , , quoteIn, , , exemptions] = d.args as unknown as any[]
    return {
      name: String(p.name ?? ''),
      symbol: String(p.symbol ?? ''),
      logo: String(p.logo ?? ''),
      hasTwitter: !!p.socials?.twitter,
      hasWebsite: !!p.socials?.website,
      hasTelegram: !!p.socials?.telegram,
      descriptionLen: String(p.description ?? '').length,
      exemptions: (exemptions ?? []).length,
      buybackEnabled: !!p.buybackEnabled,
      quoteInWei: BigInt(quoteIn ?? 0),
    }
  } catch {
    return null
  }
}
