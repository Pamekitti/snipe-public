/**
 * Signing, and the one gate that separates shadow from live.
 *
 * Shadow mode runs the entire production path: same decisions, same construction, same
 * signature, same timestamps. The only thing it skips is the socket write. That is
 * deliberate, because a paper trader that short-circuits earlier than this stops
 * measuring the thing you actually want measured.
 */
import { privateKeyToAccount } from 'viem/accounts'
import { serializeTransaction, keccak256 } from 'viem'
import type { Hex } from 'viem'
import type { UnsignedTx } from './builder.js'
import { PRIVATE_KEY } from '../config.js'

export type SignedTx = { raw: Hex; hash: Hex; tx: UnsignedTx; signedAt: number }

export class Signer {
  readonly account

  constructor(key?: string) {
    const pk = key ?? PRIVATE_KEY
    if (!pk || !pk.startsWith('0x') || pk.length !== 66) {
      throw new Error('PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (see .env.example)')
    }
    this.account = privateKeyToAccount(pk as Hex)
  }

  get address(): Hex {
    return this.account.address
  }

  async sign(tx: UnsignedTx): Promise<SignedTx> {
    const signature = await this.account.signTransaction({
      to: tx.to, data: tx.data, value: tx.value, gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce, chainId: tx.chainId, type: 'eip1559',
    })
    return { raw: signature, hash: keccak256(signature), tx, signedAt: Date.now() }
  }
}

