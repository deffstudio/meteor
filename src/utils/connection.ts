/**
 * Solana RPC connection and wallet helpers.
 *
 * The wallet is decoded lazily: the scanner never needs a key, so a missing
 * `PRIVATE_KEY` is only an error when a signing operation actually requests it.
 */
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { BotConfig } from "../types/index.js";

let connection: Connection | undefined;

/** Get (and memoize) the RPC connection. */
export function getConnection(config: BotConfig): Connection {
  if (!connection) {
    connection = new Connection(config.rpcUrl, "confirmed");
  }
  return connection;
}

/**
 * Decode the wallet Keypair from the base58 `PRIVATE_KEY`.
 * Throws if no key is configured — call only on signing paths.
 */
export function getWallet(config: BotConfig): Keypair {
  if (!config.privateKey) {
    throw new Error(
      "PRIVATE_KEY is not set. A wallet is required for swaps/deposits but not for scanning.",
    );
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(config.privateKey));
  } catch {
    throw new Error("PRIVATE_KEY is not a valid base58-encoded secret key.");
  }
}
