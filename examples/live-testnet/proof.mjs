import { z } from "zod";
import { CheckFailure, ensure } from "./balance.mjs";

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const nonzeroHash = hash.refine((value) => value !== `0x${"0".repeat(64)}`);
const receiptSchema = z
  .object({
    transactionHash: hash,
    blockHash: nonzeroHash,
    blockNumber: z.bigint().nonnegative(),
    status: z.literal("success"),
  })
  .passthrough();
const blockSchema = z.object({
  hash: nonzeroHash,
  number: z.bigint().nonnegative(),
  transactions: z.array(hash),
});
const logSchema = z.object({
  blockHash: nonzeroHash,
  blockNumber: z.bigint().nonnegative(),
  transactionHash: hash,
  removed: z.boolean().optional(),
});
const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/** Read-only verification: a preconfirmation receipt is never sufficient proof. */
export async function canonicalReceipt(client, transactionHash, options = {}) {
  hash.parse(transactionHash);
  const timeoutMs = options.timeoutMs ?? 120000;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  const bounded = async (operation) => {
    const remaining = deadline - Date.now();
    ensure(remaining > 0, "Canonical receipt verification timed out.");
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new CheckFailure("Canonical receipt verification timed out.")),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const initial = await bounded(() =>
    client.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: 2,
      timeout: timeoutMs,
    }),
  );
  const first = z.object({ blockHash: hash }).safeParse(initial);
  const initialReportedBlockHash = first.success ? first.data.blockHash : null;
  let candidate = initial;
  let receiptReadAttempts = 0;
  while (Date.now() < deadline) {
    receiptReadAttempts += 1;
    if (z.object({ status: z.literal("reverted") }).safeParse(candidate).success) {
      throw new CheckFailure("Testnet transaction reverted; no further payment attempted.");
    }
    const parsed = receiptSchema.safeParse(candidate);
    if (parsed.success) {
      const receipt = parsed.data;
      ensure(
        receipt.transactionHash.toLowerCase() === transactionHash.toLowerCase(),
        "Receipt transaction hash changed.",
      );
      try {
        const [blockInput, heightInput] = await bounded(() =>
          Promise.all([
            client.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: false }),
            client.getBlockNumber({ cacheTime: 0 }),
          ]),
        );
        const block = blockSchema.parse(blockInput);
        const height = z.bigint().nonnegative().parse(heightInput);
        if (
          block.number === receipt.blockNumber &&
          block.hash.toLowerCase() === receipt.blockHash.toLowerCase() &&
          height >= receipt.blockNumber + 1n &&
          block.transactions.some((value) => value.toLowerCase() === transactionHash.toLowerCase())
        ) {
          return {
            receipt,
            initialReportedBlockHash,
            canonicalBlockHash: block.hash,
            observedChainHeight: height,
            receiptReadAttempts,
          };
        }
      } catch (error) {
        if (error instanceof CheckFailure) throw error;
        // Public RPC nodes can temporarily disagree or lag. Poll reads only.
      }
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    try {
      candidate = await bounded(() => client.getTransactionReceipt({ hash: transactionHash }));
    } catch (error) {
      if (error instanceof CheckFailure) throw error;
      candidate = undefined;
    }
  }
  throw new CheckFailure(
    "Canonical receipt and two confirmations were not verified within the read-only timeout.",
  );
}

export function requireCanonicalLog(receipt, input) {
  const log = logSchema.parse(input);
  ensure(
    log.removed !== true &&
      log.blockHash.toLowerCase() === receipt.blockHash.toLowerCase() &&
      log.blockNumber === receipt.blockNumber &&
      log.transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase(),
    "Transfer log does not belong to the verified canonical transaction and block.",
  );
}
