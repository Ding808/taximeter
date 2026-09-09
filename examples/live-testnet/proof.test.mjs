import assert from "node:assert/strict";
import test from "node:test";
import { canonicalReceipt, requireCanonicalLog } from "./proof.mjs";

const transactionHash = `0x${"1".repeat(64)}`;
const canonicalHash = `0x${"2".repeat(64)}`;
const otherHash = `0x${"3".repeat(64)}`;
const zeroHash = `0x${"0".repeat(64)}`;
const receipt = {
  transactionHash,
  blockHash: canonicalHash,
  blockNumber: 100n,
  status: "success",
  logs: [],
};
const options = { timeoutMs: 1000, pollIntervalMs: 1 };

test("waits past a zero-hash preconfirmation and insufficient chain height", async () => {
  let receiptReads = 0;
  let heightReads = 0;
  const proof = await canonicalReceipt(
    {
      waitForTransactionReceipt: async () => ({ ...receipt, blockHash: zeroHash }),
      getTransactionReceipt: async () => {
        receiptReads += 1;
        return receipt;
      },
      getBlock: async ({ blockNumber }) => {
        assert.equal(blockNumber, 100n);
        return { hash: canonicalHash, number: 100n, transactions: [transactionHash] };
      },
      getBlockNumber: async ({ cacheTime }) => {
        assert.equal(cacheTime, 0);
        heightReads += 1;
        return heightReads === 1 ? 100n : 101n;
      },
    },
    transactionHash,
    options,
  );
  assert.equal(receiptReads, 2);
  assert.equal(proof.initialReportedBlockHash, zeroHash);
  assert.equal(proof.canonicalBlockHash, canonicalHash);
  assert.equal(proof.observedChainHeight, 101n);
});

test("rejects a stale receipt/block pairing until their hashes agree", async () => {
  let reads = 0;
  const proof = await canonicalReceipt(
    {
      waitForTransactionReceipt: async () => ({ ...receipt, blockHash: otherHash }),
      getTransactionReceipt: async () => {
        reads += 1;
        return receipt;
      },
      getBlock: async () => ({
        hash: canonicalHash,
        number: 100n,
        transactions: [transactionHash],
      }),
      getBlockNumber: async () => 103n,
    },
    transactionHash,
    options,
  );
  assert.equal(reads, 1);
  assert.equal(proof.initialReportedBlockHash, otherHash);
  assert.equal(proof.receipt.blockHash, canonicalHash);
});

test("never accepts a canonical block with the wrong number", async () => {
  await assert.rejects(
    canonicalReceipt(
      {
        waitForTransactionReceipt: async () => receipt,
        getTransactionReceipt: async () => receipt,
        getBlock: async () => ({
          hash: canonicalHash,
          number: 99n,
          transactions: [transactionHash],
        }),
        getBlockNumber: async () => 105n,
      },
      transactionHash,
      { timeoutMs: 25, pollIntervalMs: 1 },
    ),
    /timed out|timeout/,
  );
});

test("fails immediately on a reverted receipt without further reads", async () => {
  await assert.rejects(
    canonicalReceipt(
      {
        waitForTransactionReceipt: async () => ({ ...receipt, status: "reverted" }),
        getTransactionReceipt: async () => {
          assert.fail("Unexpected read after definitive revert");
        },
      },
      transactionHash,
      options,
    ),
    /reverted/,
  );
});

test("bounds a stalled RPC request", async () => {
  await assert.rejects(
    canonicalReceipt(
      {
        waitForTransactionReceipt: async () => receipt,
        getBlock: async () => new Promise(() => {}),
        getBlockNumber: async () => 102n,
      },
      transactionHash,
      { timeoutMs: 25, pollIntervalMs: 1 },
    ),
    /timed out/,
  );
});

test("rejects a different transaction hash even in a canonical block", async () => {
  await assert.rejects(
    canonicalReceipt(
      {
        waitForTransactionReceipt: async () => ({ ...receipt, transactionHash: otherHash }),
      },
      transactionHash,
      options,
    ),
    /transaction hash changed/,
  );
});

test("requires the transaction to occur in the canonical block", async () => {
  let blocks = 0;
  const proof = await canonicalReceipt(
    {
      waitForTransactionReceipt: async () => receipt,
      getTransactionReceipt: async () => receipt,
      getBlock: async () => {
        blocks += 1;
        return {
          hash: canonicalHash,
          number: 100n,
          transactions: blocks === 1 ? [otherHash] : [transactionHash],
        };
      },
      getBlockNumber: async () => 102n,
    },
    transactionHash,
    options,
  );
  assert.equal(blocks, 2);
  assert.equal(proof.receiptReadAttempts, 2);
});

test("rejects removed logs and mismatched transaction/block metadata", () => {
  const log = { blockHash: canonicalHash, blockNumber: 100n, transactionHash, removed: false };
  assert.doesNotThrow(() => requireCanonicalLog(receipt, log));
  for (const change of [
    { removed: true },
    { blockHash: otherHash },
    { blockNumber: 99n },
    { transactionHash: otherHash },
  ]) {
    assert.throws(() => requireCanonicalLog(receipt, { ...log, ...change }), /does not belong/);
  }
});
