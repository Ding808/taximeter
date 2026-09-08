import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { z } from "zod";

// Developer-only, offline benchmark. Build the entry before running this file.
// Example: node scripts/benchmark-ledger.mjs --counts 1000,10000,50000 --payments 100
// Baseline: add --entry E:\Taximeter-Benchmarks\baseline\dist\index.js
// Scale: --counts 50000,500000 --task-partitions 1000 --agent-partitions 100
// Attribution cycles independently through each requested count, starting at zero;
// these are task/agent groups, not a Cartesian product of task-agent combinations.
// Repeat with counts of 1 for the single-partition comparison. Use identical flags,
// Node runtime, and disk for baseline/candidate runs, sequentially rather than in parallel.
// Every batch seeds a fresh database, closes/reopens it, and measures real intake
// plus recognized settlement. Request construction and final checks are untimed.
// JSON results go to stdout; progress goes to stderr. --help lists all flags.
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
  "task-partitions": integerOption(1, 1_000_000),
  "agent-partitions": integerOption(1, 1_000_000),
  "progress-every": integerOption(0, 1_000_000),
  "temp-root": z.string().refine(isAbsolute, "--temp-root must be an absolute directory path"),
  help: z.boolean(),
});
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const payer = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
const network = "eip155:8453";
const resource = "https://benchmark.example.test/data";
const amount = "7";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const countSchema = z.object({ count: z.number().int().nonnegative() });
const sourceRowSchema = z.object({
  eventRowid: z.number().int().positive(),
  eventId: z.uuidv7(),
  eventPayload: z.string(),
  outcomeId: z.uuidv7().nullable(),
  outcomePayload: z.string().nullable(),
});
const outcomeSchema = z.object({
  id: z.uuidv7(),
  ts: z.iso.datetime(),
  paymentId: z.uuidv7(),
  attemptId: z.uuidv7().optional(),
  attemptedAt: z.iso.datetime().optional(),
  status: z.enum(["unknown", "confirmed", "failed"]),
  txHash: z.string().optional(),
  reason: z.string().optional(),
});
const prefixRootSchema = z.object({
  partitionKey: z.string(),
  amount: z.string().regex(/^(0|[1-9][0-9]*)$/),
});
const partitionKeySchema = z.tuple([
  z.enum(["perTask", "perAgent", "global"]),
  z.string().nullable(),
  z.literal(network),
  z.literal(asset),
]);

function attribution(kind, index, partitions) {
  return partitions === 1 ? `benchmark-${kind}` : `benchmark-${kind}-${index % partitions}`;
}

// Same synthetic v2 exact EVM wire structure as test/fixtures/upstream.ts.
// These signatures are fixture bytes; no server, signer, or network is used.
function exchange(index, partitions) {
  const nonce = `0x${BigInt(index).toString(16).padStart(64, "0")}`;
  return {
    request: {
      url: resource,
      method: "GET",
      headers: {
        "taximeter-task": attribution("task", index, partitions.task),
        "taximeter-agent": attribution("agent", index, partitions.agent),
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

function progress(phase, completed, total, started, every) {
  if (completed === 0 || completed === total || (every > 0 && completed % every === 0)) {
    console.error(
      `${phase}: ${completed}/${total} payments; ${milliseconds(performance.now() - started)} ms`,
    );
  }
}

// Read only the disposable index metadata, never use cache amounts to verify the source log.
// A missing cache table in the baseline is reported as null, not as an empty table.
function cacheStatistics(database, observedPayments, partitions) {
  const reader = new Database(database, { readonly: true, fileMustExist: true });
  try {
    const exists = countSchema.parse(
      reader
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'cache_prefix'",
        )
        .get(),
    ).count;
    if (exists === 0) return { rows: null, partitions: null, partitionsByScope: null };
    const rows = countSchema.parse(
      reader.prepare("SELECT COUNT(*) AS count FROM cache_prefix").get(),
    ).count;
    const partitionsByScope = { perTask: 0, perAgent: 0, global: 0 };
    for (const input of reader
      .prepare("SELECT partitionKey, amount FROM cache_prefix WHERE prefix = ''")
      .iterate()) {
      const row = prefixRootSchema.parse(input);
      const [scope, label] = partitionKeySchema.parse(JSON.parse(row.partitionKey));
      let expectedCount = BigInt(observedPayments);
      if (scope === "global") assert.equal(label, null);
      else {
        const kind = scope === "perTask" ? "task" : "agent";
        const count = partitions[kind];
        let index = 0;
        if (count === 1) assert.equal(label, `benchmark-${kind}`);
        else {
          const parsedLabel = z.string().startsWith(`benchmark-${kind}-`).parse(label);
          index = integerOption(0, count - 1).parse(parsedLabel.slice(`benchmark-${kind}-`.length));
        }
        expectedCount =
          BigInt(observedPayments) <= BigInt(index)
            ? 0n
            : (BigInt(observedPayments) - 1n - BigInt(index)) / BigInt(count) + 1n;
      }
      assert.ok(expectedCount > 0n, "Cache has a partition with no source payments");
      assert.equal(
        row.amount,
        (expectedCount * BigInt(amount)).toString(),
        `Incorrect ${scope} root total`,
      );
      partitionsByScope[scope] += 1;
    }
    assert.deepEqual(partitionsByScope, {
      perTask: Math.min(observedPayments, partitions.task),
      perAgent: Math.min(observedPayments, partitions.agent),
      global: observedPayments > 0 ? 1 : 0,
    });
    return {
      rows,
      partitions: partitionsByScope.perTask + partitionsByScope.perAgent + partitionsByScope.global,
      partitionsByScope,
    };
  } finally {
    reader.close();
  }
}

// Stream the authoritative log with its indexed outcomes. Only one payment and its
// two outcomes are retained at a time, including for the pre-cache package baseline.
// SQL counts count rows only; all monetary accumulation and checks use BigInt.
function verifySource(api, database, historyPayments, measuredPayments, partitions, every) {
  const reader = new Database(database, { readonly: true, fileMustExist: true });
  const observedPayments = historyPayments + measuredPayments;
  const expectedAmount = (BigInt(observedPayments) * BigInt(amount)).toString();
  const started = performance.now();
  let observed = 0;
  let blocked = 0;
  let total = 0n;
  let current;
  let currentRowid = 0;
  let outcomes = [];
  const checkPayment = () => {
    if (!current) return;
    const index = currentRowid - 1;
    assert.equal(current.amount, amount);
    assert.equal(current.asset, asset);
    assert.equal(current.network, network);
    assert.equal(current.taskId, attribution("task", index, partitions.task));
    assert.equal(current.agentId, attribution("agent", index, partitions.agent));
    for (const outcome of outcomes) assert.equal(outcome.paymentId, current.id);
    if (index === observedPayments) {
      assert.equal(current.status, "blocked");
      assert.equal(current.reason, "global_budget");
      assert.equal(outcomes.length, 0);
      blocked += 1;
      return;
    }
    assert.ok(index >= 0 && index < observedPayments, "Unexpected payment in source log");
    assert.equal(current.status, "observed");
    if (index < historyPayments) assert.equal(outcomes.length, 0);
    else {
      assert.equal(outcomes.length, 2);
      assert.equal(outcomes.filter((outcome) => outcome.status === "unknown").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "confirmed").length, 1);
      assert.equal(outcomes[0].attemptId, outcomes[1].attemptId);
    }
    const derived = api.deriveEvents([current], outcomes);
    assert.equal(derived.length, 1);
    assert.equal(derived[0].settlementStatus, "confirmed");
    assert.equal(derived[0].settlement_unknown, false);
    total += BigInt(derived[0].amount);
    observed += 1;
    progress("Verify source", observed, observedPayments, started, every);
  };
  try {
    // Events are unique by paymentKey under the source table's observed-only index.
    // ORDER BY rowid permits an event scan with indexed outcome lookups, not a full
    // JavaScript event array or a global sort of parsed payloads.
    const query = reader.prepare(`
      SELECT e.rowid AS eventRowid, e.id AS eventId, e.payload AS eventPayload,
             o.id AS outcomeId, o.payload AS outcomePayload
      FROM events e LEFT JOIN outcomes o ON o.paymentId = e.id ORDER BY e.rowid
    `);
    for (const input of query.iterate()) {
      const row = sourceRowSchema.parse(input);
      if (row.eventRowid !== currentRowid) {
        checkPayment();
        assert.equal(row.eventRowid, currentRowid + 1, "Nonsequential fresh source rows");
        currentRowid = row.eventRowid;
        current = api.paymentEventSchema.parse(JSON.parse(row.eventPayload));
        assert.equal(current.id, row.eventId);
        outcomes = [];
      }
      if (row.outcomePayload !== null) {
        const outcome = outcomeSchema.parse(JSON.parse(row.outcomePayload));
        assert.equal(outcome.id, row.outcomeId);
        outcomes.push(outcome);
        assert.ok(outcomes.length <= 2, "Unexpected additional payment outcomes");
      } else assert.equal(row.outcomeId, null);
    }
    checkPayment();
    assert.equal(observed, observedPayments);
    assert.equal(blocked, 1);
    assert.equal(total.toString(), expectedAmount);
    assert.equal(
      countSchema.parse(reader.prepare("SELECT COUNT(*) AS count FROM outcomes").get()).count,
      measuredPayments * 2,
    );
    assert.equal(
      countSchema.parse(reader.prepare("SELECT COUNT(*) AS count FROM diagnostics").get()).count,
      0,
    );
    return milliseconds(performance.now() - started);
  } finally {
    reader.close();
  }
}

function benchmarkBatch(api, parent, historyPayments, measuredPayments, batch, partitions, every) {
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
    console.error(
      `Batch ${batch}: ${historyPayments} historical payments; ${partitions.task} task / ${partitions.agent} agent partitions`,
    );
    progress("Seed", 0, historyPayments, seedStarted, every);
    ledger.transaction(() => {
      for (let index = 0; index < historyPayments; index += 1) {
        const event = rail.parse(exchange(index, partitions).request);
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
        progress("Seed", index + 1, historyPayments, seedStarted, every);
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
    console.error(
      `Measure: starting ${measuredPayments} timed payments for ${historyPayments} historical payments`,
    );
    for (let index = 0; index < measuredPayments; index += 1) {
      const { request, response } = exchange(historyPayments + index, partitions);
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

    const rejected = meter.begin(exchange(historyPayments + measuredPayments, partitions).request);
    assert.equal(rejected.payment, undefined);
    assert.deepEqual(rejected.body, {
      error: "blocked_by_taximeter",
      reason: "global_budget",
      budget: expectedAmount,
      spent: expectedAmount,
      remaining: "0",
    });
    const walBytesBeforeClose = bytes(`${database}-wal`);
    ledger.close();
    ledger = undefined;
    const verificationMs = verifySource(
      api,
      database,
      historyPayments,
      measuredPayments,
      partitions,
      every,
    );
    const cachePrefix = cacheStatistics(database, historyPayments + measuredPayments, partitions);
    const sorted = [...durations].sort((left, right) => left - right);
    return {
      historyPayments,
      measuredPayments,
      taskPartitions: partitions.task,
      agentPartitions: partitions.agent,
      observedTaskPartitions: Math.min(historyPayments + measuredPayments, partitions.task),
      observedAgentPartitions: Math.min(historyPayments + measuredPayments, partitions.agent),
      batch,
      historicalStart: new Date(historicalStart).toISOString(),
      historicalSpanMs: 22 * 3_600_000,
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
      cachePrefix,
      verificationMs,
      expectedAmount,
      correctness:
        "streamed source replay, confirmed exact total, payment/attribution/outcome counts, exact budget rejection, no diagnostics, cache root totals when present",
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
      "task-partitions": { type: "string", default: "1" },
      "agent-partitions": { type: "string", default: "1" },
      "progress-every": { type: "string", default: "10000" },
      "temp-root": { type: "string", default: resolve(root, "../Taximeter-Benchmarks") },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const options = optionsSchema.parse(values);
  if (options.help) {
    console.log(`Usage: node scripts/benchmark-ledger.mjs [options]

  --entry PATH           Absolute built ESM entry (default: current dist/index.js)
  --counts N,N,...        Historical payments per case (default: 1000,10000,50000)
  --payments N           Timed new payments per batch (default: 100)
  --batches N            Fresh databases per count (default: 1)
  --task-partitions N    Round-robin task labels (default: 1)
  --agent-partitions N   Round-robin agent labels (default: 1)
  --progress-every N     Seed/source-check progress interval; 0 = endpoints only (default: 10000)
  --temp-root PATH       Absolute temporary parent (default: ../Taximeter-Benchmarks)
  --help                 Print this help without importing the benchmark entry

Examples:
  node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100
  node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100 --task-partitions 1000 --agent-partitions 100

Use identical flags, Node runtime, and disk for baseline/candidate runs. Run
sequentially and avoid other heavy work during the timed phase. Each case seeds
history across 22 hours, then closes/reopens before timing begin + complete.
Task and agent counts represent independent round-robin groups; they do not
multiply into task-agent pairs. Counts larger than the payment count create only
as many populated groups as payments. JSON goes to stdout; progress to stderr.
cachePrefix reports rows and populated partitions, or null values when the
baseline has no cache_prefix table. Final checks stream the source log using
bounded JavaScript memory; the selected entry's own intake memory is unchanged.`);
    return;
  }
  const entry = realpathSync(options.entry);
  assert.ok(statSync(entry).isFile(), "The built ESM entry must be a file");
  const api = await import(pathToFileURL(entry).href);
  for (const name of ["Ledger", "Meter", "X402Rail", "parseConfig", "deriveEvents"])
    assert.equal(typeof api[name], "function", `Missing required package export: ${name}`);
  assert.equal(
    typeof api.paymentEventSchema?.parse,
    "function",
    "Missing paymentEventSchema export",
  );
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
      taskPartitions: options["task-partitions"],
      agentPartitions: options["agent-partitions"],
      progressEvery: options["progress-every"],
      tempRoot: parent,
      notes:
        "Offline synthetic x402 v2 USDC; history spread across 22 hours; task and agent labels cycle independently; all three budgets active; reopened after one-transaction seed; no warmup; median/p95 include first payment; p95 nearest-rank; DB sizes after close; seedMs includes fixture parsing, inserts, and progress output; openMs excludes measured intake; verification streams authoritative source rows and checks cache partition roots outside timing.",
    }),
  );
  for (const historyPayments of options.counts) {
    for (let batch = 1; batch <= options.batches; batch += 1) {
      console.log(
        JSON.stringify(
          benchmarkBatch(
            api,
            parent,
            historyPayments,
            options.payments,
            batch,
            {
              task: options["task-partitions"],
              agent: options["agent-partitions"],
            },
            options["progress-every"],
          ),
        ),
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
