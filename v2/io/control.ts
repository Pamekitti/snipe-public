/**
 * The operator's stop, start and drawdown reset, decided in one pure function so it can be
 * tested alone. PORTED from v1/src/telemetry/dashboard.ts controlAction.
 *
 * The reason this exists: an operator who wants to stop NOW should not be waiting on ssh,
 * and the alternative people actually reach for is `pm2 stop`, which kills the exit
 * managers and strands every open bag.
 *
 * TWO SCOPES. No book is STOP ALL / START / RESET DD on every policy. A book is that
 * policy only: stop taxed, leave untaxed on Auto. Global START lifts only STOP ALL;
 * a per-book AUTO does not lift STOP ALL. Drawdown and broken are still not start's
 * to lift.
 */
import { checkBookSize, effectiveBookSizeWei, type FrozenConfig, type Switches } from '../core/config.js'
import { ethToWei } from './env-file.js'
import type { Position } from '../core/state.js'

export type ControlAction = 'stop' | 'start' | 'reset' | 'reconcile-empty' | 'clear-broken'

export type ControlState = {
  readonly stopped: boolean
  readonly haltKind: string | null
  readonly open: number
  readonly drawdownWei: bigint
  /** whether the bot-broken halt is up. Its own field, because it has its own lift. */
  readonly broken: boolean
  /** when set, stop / start / reset apply to this book only */
  readonly book?: string | null
  /** this book's own operator stop, ignored when `book` is absent */
  readonly bookStopped?: boolean
}

export type ControlResult = {
  readonly do: ControlAction | 'retry-exit' | 'preview-size' | 'set-size' | 'clear-size' | 'set-api-mode' | 'nothing'
  readonly apiMode?: 'economy' | 'paid'
  readonly code: number
  readonly why: string
  readonly book?: string
  readonly positionId?: string
  readonly sizeWei?: string
  readonly drawdownWei?: string
  readonly sizeEth?: string
  readonly drawdownEth?: string
  readonly adaptiveMinEth?: string
  readonly adaptiveMaxEth?: string
}

export function exitRetryAction(positionId: unknown, s: {
  stopped: boolean; broken: boolean; positions: ReadonlyMap<string, Position>
}): ControlResult {
  if (!s.stopped && !s.broken) return {do:'nothing',code:409,why:'stop new entries before retrying an exhausted exit'}
  const p = typeof positionId === 'string' ? s.positions.get(positionId) : undefined
  if (!p || p.closed || !p.filled || p.venue !== 'curve') return {do:'nothing',code:400,why:'an open curve position is required'}
  if (p.inflightIntentId !== null || (p.sellReceipts?.size ?? 0) > 0 || p.exitRecovery) {
    return {do:'nothing',code:409,why:'the position already has a pending sale or recovery read'}
  }
  if (p.attempts < p.rules.maxSellAttempts && !p.approval?.gaveUp) return {do:'nothing',code:409,why:'automatic exit recovery is still active'}
  return {do:'retry-exit',code:202,positionId:p.id,why:`operator requested exit recovery for ${p.token}`}
}

export type OperatorControlResult = Omit<ControlResult, 'do'> & {
  readonly do: ControlAction | 'nothing'
}

export type SizeControlState = {
  readonly at: number
  readonly config: FrozenConfig
  readonly switches: Switches
}

/** Validate one dashboard size command. The fold repeats every money check. */
export function bookSizeAction(
  action: unknown,
  bookArg: unknown,
  sizeEthArg: unknown,
  state: SizeControlState,
): ControlResult {
  if (action !== 'preview-size' && action !== 'preview-default' && action !== 'set-size' && action !== 'clear-size') {
    return { do: 'nothing', code: 400, why: 'unknown size action' }
  }
  if (typeof bookArg !== 'string' || bookArg === '') {
    return { do: 'nothing', code: 400, why: 'a book is required for a size change' }
  }
  const book = state.config.books.find((candidate) => candidate.id === bookArg)
  if (!book) return { do: 'nothing', code: 400, why: `no book named ${bookArg}` }

  const existing = state.switches.bookSizes?.get(book.id)
  const preview = action === 'preview-size' || action === 'preview-default'
  const clearing = action === 'clear-size' || action === 'preview-default'
  if (clearing) {
    if (!existing) return { do: 'nothing', code: 200, why: `${book.id} already uses the default size` }
    const fallback = effectiveBookSizeWei(book, state.switches.sizeWei)
    const drawdown = fallback * BigInt(state.config.risk.drawdownStakes)
    const weak = (fallback * BigInt(book.sizing?.enabled ? book.sizing.weakBps : 10_000)) / 10_000n
    const strong = (fallback * BigInt(book.sizing?.enabled ? book.sizing.strongBps : 10_000)) / 10_000n
    return {
      do: preview ? 'preview-size' : 'clear-size', code: 200, book: book.id,
      sizeWei: fallback.toString(),
      drawdownWei: drawdown.toString(),
      sizeEth: weiToEth(fallback),
      drawdownEth: weiToEth(drawdown),
      adaptiveMinEth: weiToEth(weak), adaptiveMaxEth: weiToEth(strong),
      why: `${book.id} will use the ${fallback} wei default`,
    }
  }

  if (typeof sizeEthArg !== 'string') {
    return { do: 'nothing', code: 400, why: 'sizeEth must be a decimal string' }
  }
  const wanted = ethToWei(sizeEthArg)
  if (wanted === null) return { do: 'nothing', code: 400, why: `${JSON.stringify(sizeEthArg)} is not an ETH amount` }
  const checked = checkBookSize(state.at, wanted, state.config, book.id)
  if (!checked.ok) return { do: 'nothing', code: 400, why: checked.refusal.reason }
  if (existing?.sizeWei === checked.value) {
    return { do: 'nothing', code: 200, why: `${book.id} is already set to ${checked.value} wei` }
  }
  const drawdown = checked.value * BigInt(state.config.risk.drawdownStakes)
  const weak = (checked.value * BigInt(book.sizing?.enabled ? book.sizing.weakBps : 10_000)) / 10_000n
  const strong = (checked.value * BigInt(book.sizing?.enabled ? book.sizing.strongBps : 10_000)) / 10_000n
  return {
    do: preview ? 'preview-size' : 'set-size', code: 200, book: book.id,
    sizeWei: checked.value.toString(),
    drawdownWei: drawdown.toString(),
    sizeEth: weiToEth(checked.value),
    drawdownEth: weiToEth(drawdown),
    adaptiveMinEth: weiToEth(weak), adaptiveMaxEth: weiToEth(strong),
    why: `${book.id} size set to ${checked.value} wei for new entries`,
  }
}

function weiToEth(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

export function controlAction(action: unknown, state: ControlState): OperatorControlResult {
  if (action !== 'stop' && action !== 'start' && action !== 'reset' && action !== 'reconcile-empty' && action !== 'clear-broken') {
    return { do: 'nothing', code: 400, why: 'action must be "stop", "start", "reset", "reconcile-empty" or "clear-broken"' }
  }
  const book = state.book ?? null
  if (book) return bookAction(action, book, state)
  if (action === 'stop') {
    if (state.stopped) return { do: 'nothing', code: 200, why: 'already stopped' }
    return { do: 'stop', code: 200, why: 'stopped from the dashboard' }
  }
  if (action === 'reset') {
    if (state.open > 0) {
      return { do: 'nothing', code: 409, why: `${state.open} open position(s): reset while flat` }
    }
    if (state.haltKind && state.haltKind !== 'drawdown' && state.haltKind !== 'stopped' && !state.haltKind.startsWith('drawdown')) {
      return { do: 'nothing', code: 409, why: `${state.haltKind} is holding: reset the drawdown once that clears` }
    }
    if (state.drawdownWei === 0n) return { do: 'nothing', code: 200, why: 'drawdown is already zero' }
    return { do: 'reset', code: 200, why: 'drawdown reset from the dashboard' }
  }
  if (action === 'clear-broken') {
    /**
     * DELIBERATELY NOT PART OF `start`, and deliberately harder than it.
     *
     * The broken halt means the bot is losing money the same coins did not lose, so lifting it is
     * a claim that someone has found the bug. It is the one halt with no automatic path off: the
     * venue pause and the cash-drawdown halt share one reopen: 8 fresh above +1.
     * Both answer a market. This answers us.
     *
     * FLAT AND STOPPED, both. Flat because the fold refuses otherwise, and stopped because
     * lifting the halt on a running bot would have it enter on the next launch, before anybody has
     * confirmed the fix is what is deployed.
     */
    if (!state.broken) return { do: 'nothing', code: 200, why: 'there is no broken halt to clear' }
    if (!state.stopped) return { do: 'nothing', code: 409, why: 'stop the bot before clearing the broken halt' }
    if (state.open > 0) {
      return { do: 'nothing', code: 409, why: `${state.open} open position(s): clear the broken halt while flat` }
    }
    return { do: 'clear-broken', code: 200, why: 'broken halt cleared from the dashboard after diagnosis' }
  }
  if (action === 'reconcile-empty') {
    if (!state.stopped) return { do: 'nothing', code: 409, why: 'stop the bot before reconciling exhausted positions' }
    if (state.open === 0) return { do: 'nothing', code: 200, why: 'there are no open positions to reconcile' }
    return { do: 'reconcile-empty', code: 202, why: 'checking exhausted positions against fresh on-chain token balances' }
  }
  if (!state.stopped) return { do: 'nothing', code: 200, why: 'not stopped' }
  if (state.haltKind !== 'stopped') {
    return { do: 'nothing', code: 409, why: `${state.haltKind} is holding: that one is not yours to lift` }
  }
  return { do: 'start', code: 200, why: 'automatic operation requested from the dashboard' }
}

function bookAction(action: ControlAction, book: string, state: ControlState): OperatorControlResult {
  if (action === 'clear-broken' || action === 'reconcile-empty') {
    return { do: 'nothing', code: 400, why: `${action} is wallet-wide; it has no book` }
  }
  if (action === 'stop') {
    if (state.bookStopped) return { do: 'nothing', code: 200, why: `${book} is already stopped` }
    return { do: 'stop', code: 200, why: `${book} stopped from the dashboard` }
  }
  if (action === 'reset') {
    if (state.open > 0) {
      return { do: 'nothing', code: 409, why: `${book} has ${state.open} open position(s): reset while that book is flat` }
    }
    if (state.drawdownWei === 0n) return { do: 'nothing', code: 200, why: `${book} drawdown is already zero` }
    return { do: 'reset', code: 200, why: `${book} drawdown reset from the dashboard` }
  }
  if (state.stopped) {
    return { do: 'nothing', code: 409, why: 'STOP ALL is holding: start the wallet before starting a book' }
  }
  if (!state.bookStopped) return { do: 'nothing', code: 200, why: `${book} is not stopped` }
  return { do: 'start', code: 200, why: `${book} automatic operation requested from the dashboard` }
}

/**
 * The halt the start button is allowed to lift, or the stickier one that is holding.
 *
 * A VENUE HALT IS NOT STICKY AND IS NOT WALLET-WIDE. This used to return the first key that
 * was not 'stopped', which flattened a map the rest of the system is careful to keep scoped:
 * `stepHalt` keys venue pauses `venue:<book>` precisely so "a venue pause on one policy must
 * not stop the other, which is the entire argument for running two books at all". Flattened,
 * a venue pause on ANY book vetoed the start button for EVERY book.
 *
 * On 2026-09-16 that read: `untaxed`, funded and with its own guard open at +1.84, could not
 * be started because `taxed` sat at -1.61. `taxed` is declared with size 0. It is a control
 * group that scores launches it can never buy, and it was holding the funded book out of the
 * market. There is no safety in that, and no safety is lost by removing it: lifting 'stopped'
 * deletes only 'stopped', so every book still meets its own venue halt at `canEnter`, and a
 * book whose guard is shut stays shut.
 *
 * Per-book operator stops use kind `stopped` with a book, so they are skipped here the same
 * way: START ALL lifts STOP ALL, not a book the operator parked on purpose.
 *
 * A per-book drawdown is scoped for the same reason as a venue halt: START ALL deletes only
 * the wallet-wide operator stop, and that book still meets its own drawdown halt at `canEnter`.
 * Treating `drawdown:taxed` as wallet-wide made it impossible to resume a healthy untaxed book
 * after a controlled STOP ALL deployment. What still holds a start is a genuinely wallet-wide
 * broken or manual halt. Those are not yours to lift.
 */
export function operatorHaltKind(halts: ReadonlyMap<string, { kind: string }>): string | null {
  for (const [key, halt] of halts) {
    if (halt.kind === 'stopped' || halt.kind === 'venue' || (halt.kind === 'drawdown' && key.startsWith('drawdown:'))) continue
    return key
  }
  return halts.has('stopped') ? 'stopped' : null
}
