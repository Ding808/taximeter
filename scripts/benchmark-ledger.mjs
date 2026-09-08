import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

// Developer-only, offline benchmark. Build the entry before running this file.
// Example: node scripts/benchmark-ledger.mjs --counts 1000,10000,50000 --payments 100
// Baseline: add --entry E:\Taximeter-Benchmarks\baseline\dist\index.js
// Every batch seeds a fresh database, closes/reopens it, and measures real intake
// plus recognized settlement. Request construction and final checks are untimed.
const root = fileURLToPath(new URL("../", import.meta.url));
const integerOption = (minimum, maximum) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform((value) => parseInt(value, 10))
    .pipe(z.number().int().min(minimum).max(maximum));
const optionsSchema = z.strictObject({
  entry: z.string().refine(isAbsolute, "--entry must be an absolute file path"),
  counts: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(integerOption(0, 1_000_000)).min(1).max(20)),
  payments: integerOption(1, 10_000),
  batches: integerOption(1, 20),
  "temp-root": z.string().refine(isAbsolute, "--temp-root must be an absolute directory path"),
});
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const payer = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
const network = "eip155:8453";
const resource = "https://benchmark.example.test/data";
const amount = "7";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

// Same synthetic v2 exact EVM wire structure as test/fixtures/upstream.ts.
// These signatures are fixture bytes; no server, signer, or network is used.
function exchange(index) {
  const nonce = `0x${BigInt(index).toString(16).padStart(64, "0")}`;
  return {
    request: {
      url: resource,
      method: "GET",
      headers: {
        "taximeter-task": "benchmark-task",
        "taximeter-agent": "benchmark-agent",
        "payment-signature": encode({
          x402Version: 2,
          accepted: {
            scheme: "exact",
            network,
            asset,
            payTo,
            amount,
            maxTimeoutSeconds: 60,
            extra: { name: "USD Coin", version: "2" },
          },
          resource: { url: resource },
          payload: {
            signature: `0x${"12".repeat(65)}`,
            authorization: {
              from: payer,
              to: payTo,
              value: amount,
              validAfter: "0",
              validBefore: "9999999999",
              nonce,
            },
          },
        }),
      },
    },
    response: {
      status: 200,
      headers: {
        "payment-response": encode({ success: true, network, payer, transaction: nonce }),
      },
    },
  };
}

function milliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function bytes(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function removeOwned(owned, parent) {
  const target = realpathSync(owned);
  assert.ok(
    isAbsolute(target) &&
      target === owned &&
      dirname(target) === parent &&
      basename(target).startsWith("taximeter-ledger-benchmark-"),
    "Refusing to remove a directory outside the owned benchmark workspace",
  );
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function benchmarkBatch(api, parent, historyPayments, measuredPayments, batch) {
  const owned = realpathSync(mkdtempSync(join(parent, "taximeter-ledger-benchmark-")));
  const database = join(owned, "ledger.db");
  const expectedAmount = (
    (BigInt(historyPayments) + BigInt(measuredPayments)) *
    BigInt(amount)
  ).toString();
  // Exercise every budget scope while making the global cap the first to reject.
  const scopeBudget = {
    amount: (BigInt(expectedAmount) + BigInt(amount)).toString(),
    asset: "USDC",
    network,
    window: "24h",
  };
  const config = api.parseConfig({
    db: database,
    budgets: {
      perTask: scopeBudget,
      perAgent: scopeBudget,
      global: { ...scopeBudget, amount: expectedAmount },
    },
  });
  let ledger;
  try {
    ledger = new api.Ledger(database);
    const rail = new api.X402Rail();
    const historicalStart = Date.now() - 23 * 3_600_000;
    const seedStarted = performance.now();
    ledger.transaction(() => {
      for (let index = 0; index < historyPayments; index += 1) {
        const event = rail.parse(exchange(index).request);
        assert.ok(event, `Historical payment ${index} was not recognized`);
        assert.equal(event.amount, amount);
        assert.equal(event.asset, asset);
        assert.equal(
          ledger.append({
            ...event,
            ts: new Date(
              historicalStart + Math.floor((index * 22 * 3_600_000) / Math.max(1, historyPayments)),
            ).toISOString(),
            settlementStatus: "confirmed",
            settlement_unknown: false,
          }),
          true,
          `Historical payment ${index} was not inserted`,
        );
      }
    });
    const seedMs = performance.now() - seedStarted;
    ledger.close();
    ledger = undefined;
    const seedDatabaseBytes = bytes(database);

    const openStarted = performance.now();
    ledger = new api.Ledger(database);
    const meter = new api.Meter(ledger, config);
    const openMs = performance.now() - openStarted;
    const durations = [];
    for (let index = 0; index < measuredPayments; index += 1) {
      const { request, response } = exchange(historyPayments + index);
      const started = performance.now();
      const intake = meter.begin(request);
      meter.complete(intake, response);
      durations.push(performance.now() - started);
      // A swallowed storage error returns {}; it must never look like a speedup.
      assert.ok(intake.payment, `Measured payment ${index} was not metered`);
      assert.ok(intake.attempt, `Measured payment ${index} had no reserved attempt`);
      assert.equal(intake.body, undefined, `Measured payment ${index} was blocked early`);
      assert.equal(intake.payment.amount, amount);
      assert.equal(intake.payment.asset, asset);
    }

    const rejected = meter.begin(exchange(historyPayments + measuredPayments).request);
    assert.equal(rejected.payment, undefined);
    assert.deepEqual(rejected.body, {
      error: "blocked_by_taximeter",
      reason: "global_budget",
      budget: expectedAmount,
      spent: expectedAmount,
      remaining: "0",
    });
    const events = ledger.view();
    assert.equal(
      events.filter((event) => event.status === "observed").length,
      historyPayments + measuredPayments,
    );
    assert.equal(events.filter((event) => event.status === "blocked").length, 1);
    assert.ok(
      events
        .filter((event) => event.status === "observed")
        .every((event) => event.settlementStatus === "confirmed" && !event.settlement_unknown),
    );
    const totals = api.totals(events);
    assert.equal(totals.length, 1);
    assert.equal(totals[0].amount, expectedAmount);
    assert.equal(totals[0].confirmedAmount, expectedAmount);
    assert.equal(totals[0].unknownAmount, "0");
    assert.deepEqual(ledger.diagnostics(), []);
    const walBytesBeforeClose = bytes(`${database}-wal`);
    ledger.close();
    ledger = undefined;
    const sorted = [...durations].sort((left, right) => left - right);
    return {
      historyPayments,
      measuredPayments,
      batch,
      seedMs: milliseconds(seedMs),
      openMs: milliseconds(openMs),
      firstPaymentMs: milliseconds(durations[0]),
      medianMs: milliseconds(median(sorted)),
      p95Ms: milliseconds(sorted[Math.ceil(sorted.length * 0.95) - 1]),
      minMs: milliseconds(sorted[0]),
      maxMs: milliseconds(sorted.at(-1)),
      seedDatabaseBytes,
      databaseBytes: bytes(database),
      walBytesBeforeClose,
      expectedAmount,
      correctness: "confirmed totals, payment count, exact budget rejection, no diagnostics",
    };
  } finally {
    ledger?.close();
    removeOwned(owned, parent);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      entry: { type: "string", default: resolve(root, "dist/index.js") },
      counts: { type: "string", default: "1000,10000,50000" },
      payments: { type: "string", default: "100" },
      batches: { type: "string", default: "1" },
      "temp-root": { type: "string", default: resolve(root, "../Taximeter-Benchmarks") },
    },
    strict: true,
    allowPositionals: false,
  });
  const options = optionsSchema.parse(values);
  const entry = realpathSync(options.entry);
  assert.ok(statSync(entry).isFile(), "The built ESM entry must be a file");
  const api = await import(pathToFileURL(entry).href);
  for (const name of ["Ledger", "Meter", "X402Rail", "parseConfig", "totals"])
    assert.equal(typeof api[name], "function", `Missing required package export: ${name}`);
  mkdirSync(options["temp-root"], { recursive: true });
  const parent = realpathSync(options["temp-root"]);
  console.log(
    JSON.stringify({
      benchmark: "Meter.begin + Meter.complete",
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      entry,
      packageVersion: z.string().parse(api.version),
      historyCounts: options.counts,
      paymentsPerBatch: options.payments,
      batchesPerCount: options.batches,
      tempRoot: parent,
      notes:
        "Offline synthetic x402 v2 USDC; history spread across 22 hours; all three budgets active; reopened after one-transaction seed; no warmup; median/p95 include first payment; p95 nearest-rank; DB sizes after close; seedMs includes fixture parsing and inserts; openMs excludes measured intake.",
    }),
  );
  for (const historyPayments of options.counts) {
    for (let batch = 1; batch <= options.batches; batch += 1) {
      console.log(
        JSON.stringify(benchmarkBatch(api, parent, historyPayments, options.payments, batch)),
      );
    }
  }
}

try {
  await main();
} catch (error) {
  const parsed = z.object({ message: z.string() }).safeParse(error);
  console.error(
    `Ledger benchmark failed: ${parsed.success ? parsed.data.message : "Unknown error"}`,
  );
  process.exitCode = 1;
}
