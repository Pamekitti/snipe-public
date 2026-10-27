/** Behavioural constants owned by the fresh-recovery policy, not dashboard settings. */
export const FRESH_POLICY = Object.freeze({
  id: 'fresh_s1_w8_b1', source: 'adaptive-shadow', window: 20, recoveryWindow: 8,
  pauseBelow: -1, recoverAbove: 1, freshMs: 10_800_000,
  pauseOperator: '<', recoveryOperator: '>', requiresNewPublication: true,
} as const)
