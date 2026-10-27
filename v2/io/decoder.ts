/**
 * Nitro sequencer feed decoder. PORTED from v1/src/feed/decoder.ts.
 *
 * Frame shapes seen live (400-frame capture in bot/test/fixtures):
 *   {version, messages:[{sequenceNumber, message:{message:{header,l2Msg}}, blockHash, ...}]}
 *   {version, confirmedSequenceNumberMessage:{sequenceNumber}}   <- no messages array
 *
 * sequenceNumber == L2 block number. header.timestamp == L2 block timestamp, and it
 * reaches us ~100-200ms before RPC, which is what the +2s entry clock runs on.
 *
 * l2Msg is base64. byte 0 is the kind: 3 = batch (repeat [u64be length, submessage]),
 * 4 = signed tx (rest is a raw signed ethereum tx). Every frame in the capture was
 * batch-of-signed-tx; the other kinds are handled defensively but never observed.
 */
import { parseTransaction, keccak256 } from 'viem'
import type { Hex } from 'viem'

export const L2_MESSAGE_KIND = { UnsignedUserTx: 0, ContractTx: 1, NonmutatingCall: 2, Batch: 3, SignedTx: 4, Heartbeat: 6, SignedCompressedTx: 7 } as const
const HEADER_KIND_L2_MESSAGE = 3
const MAX_BATCH_DEPTH = 16

export type FeedTx = {
  hash: Hex
  to: Hex | null
  value: bigint
  data: Hex
  nonce: number
  raw: Hex
}

export type FeedBlock = {
  block: number
  /** L2 block timestamp in unix seconds */
  timestamp: number
  blockHash: string | null
  txs: FeedTx[]
}

export type DecodeResult =
  | { kind: 'block'; block: FeedBlock }
  | { kind: 'confirmed'; sequenceNumber: number }
  /**
   * A message that is not an L2 transaction batch. It still CONSUMES its sequence number
   * (one message is one L2 block, with no user transactions in it): header kinds 13
   * (batch posting report), 9 and 12 arrived ~40 times an hour on 2026-09-06 and every
   * one read as a lost block, which dropped the optimistic overlay for the coins being
   * exited. `sequenceNumber` is set when the frame carried one, so the client can advance
   * past it; without one (bad json, no messages) the client cannot know what it missed.
   */
  | { kind: 'ignored'; reason: string; sequenceNumber?: number }

/** Walk a batch l2Msg, returning the raw signed-tx payloads inside it. */
function extractRawTxs(buf: Buffer, depth = 0): Buffer[] {
  if (depth > MAX_BATCH_DEPTH || buf.length === 0) return []
  const kind = buf[0]
  if (kind === L2_MESSAGE_KIND.SignedTx) return [buf.subarray(1)]
  if (kind !== L2_MESSAGE_KIND.Batch) return []

  const out: Buffer[] = []
  let off = 1
  while (off + 8 <= buf.length) {
    const len = Number(buf.readBigUInt64BE(off))
    off += 8
    // a length that overruns the buffer means we mis-parsed; stop rather than throw
    if (len <= 0 || off + len > buf.length) break
    out.push(...extractRawTxs(buf.subarray(off, off + len), depth + 1))
    off += len
  }
  return out
}

export function decodeFrame(raw: string): DecodeResult[] {
  let frame: any
  try {
    frame = JSON.parse(raw)
  } catch {
    return [{ kind: 'ignored', reason: 'bad json' }]
  }

  if (frame.confirmedSequenceNumberMessage) {
    return [{ kind: 'confirmed', sequenceNumber: Number(frame.confirmedSequenceNumberMessage.sequenceNumber) }]
  }
  if (!Array.isArray(frame.messages)) return [{ kind: 'ignored', reason: 'no messages' }]

  const out: DecodeResult[] = []
  for (const m of frame.messages) {
    const inner = m?.message?.message
    // `Number()` alone is not a check: it turns null into 0 and an empty string into 0, both
    // of which are real-looking sequence numbers that no feed ever sent.
    const rawSeq: unknown = m?.sequenceNumber
    const seq = (typeof rawSeq === 'number' || (typeof rawSeq === 'string' && rawSeq.trim() !== '')) && Number.isFinite(Number(rawSeq))
      ? Number(rawSeq)
      : undefined
    if (!inner?.header) {
      out.push(seq === undefined
        ? { kind: 'ignored', reason: 'no header' }
        : { kind: 'ignored', reason: 'no header', sequenceNumber: seq })
      continue
    }
    if (inner.header.kind !== HEADER_KIND_L2_MESSAGE) {
      out.push(seq === undefined
        ? { kind: 'ignored', reason: `header kind ${inner.header.kind}` }
        : { kind: 'ignored', reason: `header kind ${inner.header.kind}`, sequenceNumber: seq })
      continue
    }

    const txs: FeedTx[] = []
    if (typeof inner.l2Msg === 'string') {
      for (const rawTx of extractRawTxs(Buffer.from(inner.l2Msg, 'base64'))) {
        const hex = `0x${rawTx.toString('hex')}` as Hex
        try {
          const tx = parseTransaction(hex)
          txs.push({
            hash: keccak256(hex),
            to: (tx.to ?? null) as Hex | null,
            value: tx.value ?? 0n,
            data: (tx.data ?? '0x') as Hex,
            nonce: tx.nonce ?? 0,
            raw: hex,
          })
        } catch {
          // a tx we cannot parse is one we cannot act on; the logs stream still sees it
        }
      }
    }

    /**
     * A block with no usable sequence number is ignored, not emitted with `NaN` in it.
     *
     * The `ignored` branches above already check `Number.isFinite`; this one did not, so a
     * frame with a missing or malformed `sequenceNumber` produced `block: NaN`. That poisons
     * the gap detector (every comparison against NaN is false, so the hole is never seen), and
     * it lands on the tape, where JSON turns it into `null` and a replay reads a different
     * number than the live run did. Dropping the block loses one block and keeps both honest.
     */
    if (seq === undefined) {
      out.push({ kind: 'ignored', reason: 'no usable sequence number' })
      continue
    }

    out.push({
      kind: 'block',
      block: {
        block: seq,
        timestamp: Number(inner.header.timestamp),
        blockHash: m.blockHash ?? null,
        txs,
      },
    })
  }
  return out
}
