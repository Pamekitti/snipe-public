/** ABI fragments, from the factory's verified source bundle (solc 0.8.35). */

export const curveAbi = [
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ name: 'tokensOut', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'tokensIn', type: 'uint256' }, { name: 'minQuoteOut', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ name: 'quoteOut', type: 'uint256' }] },
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ name: 'quoteReserve_', type: 'uint256' }, { name: 'tokenReserve_', type: 'uint256' }] },
  { type: 'function', name: 'phantomQuote', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'reservedTokens', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'trackedQuote', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'trackedTokens', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'quoteFeeBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'creatorTaxBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'feeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'creatorTaxBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'snipeTaxStartBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'snipeTaxSeconds', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'launchedAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'launchSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'graduated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'pairToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'snipeTaxExempt', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'sellableTokens', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'readyToGraduate', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const

export const erc20Abi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

/** Reserve-mutating events. All seven, not just the obvious three. */
export const EVENT_TOPICS = {
  TokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  CurveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  CurveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  BuybackLocked: '0x5feba9b0d52c92ada4b9c571c2bee52390c54f2947208ab250221e6ee32f12ff',
  FeesSwept: '0x9f4cd7c4ed99d08a797804560c9c5d71d2cf7e101f2e3b5e7d1ca8a24c370e4f',
  FeesRescued: '0x6460dc5c867a0678a8bcc5e64f629fae539901c53a4a8b42fe21d7a6c5e6437d',
  CurveCompleted: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',
} as const

export const SELECTORS = { buy: '0x59a87bc1', sell: '0xd04c6983', launchAndBuy: '0xf85f8e41' } as const

/**
 * Word n of an event's data field, as a bigint. Every hand-rolled
 * `BigInt('0x' + data.slice(2 + n*64, 66 + n*64))` was one more chance to shift an
 * offset by a word, and this codebase has already shipped one units bug of exactly that
 * shape. CurveBuy data = (quoteIn, tokensOut, fee, snipeTax); CurveSell data =
 * (tokensIn, quoteOut, fee, tax) -- so word 1 is the fill on both.
 */
export const logWord = (data: string, n: number): bigint =>
  BigInt('0x' + data.slice(2 + n * 64, 66 + n * 64))

/** The launcher's launchAndBuy(params, launchConfigId, pairToken, quoteIn, minTokensOut, recipient, snipeTaxExemptions). */
export const launcherAbi = [
  {
    type: 'function', name: 'launchAndBuy', stateMutability: 'payable',
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'logo', type: 'string' },
        { name: 'description', type: 'string' },
        { name: 'socials', type: 'tuple', components: [
          { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' }, { name: 'discord', type: 'string' },
          { name: 'website', type: 'string' }, { name: 'farcaster', type: 'string' },
        ] },
        { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' },
        { name: 'buybackEnabled', type: 'bool' }, { name: 'expectedEconomics', type: 'bytes32' }, { name: 'salt', type: 'bytes32' },
      ] },
      { name: 'launchConfigId', type: 'uint256' }, { name: 'pairToken', type: 'address' },
      { name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' },
      { name: 'recipient', type: 'address' }, { name: 'snipeTaxExemptions', type: 'address[]' },
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }],
  },
] as const
