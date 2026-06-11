/**
 * Transaction send/confirm helpers with basic retries (spec §6).
 *
 * Handles both legacy `Transaction` (returned by the Meteora DLMM SDK) and
 * `VersionedTransaction` (returned base64-encoded by the Jupiter swap API).
 */
import {
  type Connection,
  type Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { log } from "./logger.js";

export interface SendOptions {
  /** Number of send attempts before giving up. */
  maxRetries?: number;
  /** Commitment to confirm at. */
  commitment?: "processed" | "confirmed" | "finalized";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decode a base64 transaction string into a VersionedTransaction. */
export function deserializeVersionedTx(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
}

/**
 * Sign, send, and confirm a transaction with retries.
 *
 * - Legacy `Transaction`: a fresh blockhash + fee payer are applied and it is
 *   signed with all `signers` (first signer must be the fee payer).
 * - `VersionedTransaction`: it is signed with `signers` as-is (the message,
 *   including blockhash, is already built by the producer, e.g. Jupiter).
 *
 * Returns the confirmed transaction signature.
 */
export async function sendAndConfirm(
  connection: Connection,
  tx: Transaction | VersionedTransaction,
  signers: Keypair[],
  options: SendOptions = {},
): Promise<string> {
  const { maxRetries = 3, commitment = "confirmed" } = options;

  let raw: Uint8Array;
  if (tx instanceof VersionedTransaction) {
    tx.sign(signers);
    raw = tx.serialize();
  } else {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash(commitment);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    if (signers.length > 0) tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    raw = tx.serialize();
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 0,
      });
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash(commitment);
      const result = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        commitment,
      );
      if (result.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
      }
      return signature;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sendAndConfirm attempt ${attempt}/${maxRetries} failed: ${msg}`);
      if (attempt < maxRetries) await sleep(1000 * attempt);
    }
  }

  throw new Error(
    `Transaction failed after ${maxRetries} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Send a sequence of transactions in order, confirming each before the next.
 * Used for multi-tx DLMM operations (e.g. removeLiquidity returns several).
 */
export async function sendAllInOrder(
  connection: Connection,
  txs: (Transaction | VersionedTransaction)[],
  signers: Keypair[],
  options: SendOptions = {},
): Promise<string[]> {
  const sigs: string[] = [];
  for (const tx of txs) {
    sigs.push(await sendAndConfirm(connection, tx, signers, options));
  }
  return sigs;
}
