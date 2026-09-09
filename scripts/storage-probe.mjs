import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import Database from "better-sqlite3";
import { z } from "zod";

// Developer-only storage-layout investigation, never a migration or pruning tool.
// Build first, then: node scripts/storage-probe.mjs --output tmp/storage-current.json
// Uses two fixed 1,000-payment datasets; all databases are created in an owned temp
// directory and removed after verification. JSON report is stdout or --output.
const root = fileURLToPath(new URL("../", import.meta.url));
const optionsSchema = z.strictObject({
  output: z
    .string()
    .min(1)
    .regex(/\.json$/i)
    .optional(),
  "temp-root": z.string().min(1),
  help: z.boolean(),
});
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "temp-root": { type: "string", default: resolve(root, "tmp") },
    help: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});
const options = optionsSchema.parse(values);
if (options.help) {
  console.log(`Usage: node scripts/storage-probe.mjs [--output FILE.json] [--temp-root DIRECTORY]

Build the checkout first. Two fixed 1,000-payment synthetic x402 v2 datasets use
1 task/1 agent and 100 tasks/10 agents. No keys, signatures, or network calls are
made. Each dataset includes real Meter.begin/complete writes and outcome rows.
Storage variants are experimental copies, not supported runtime formats.
All owned databases are cleaned up; the optional JSON report is retained.
The default temp parent is the checkout's ignored tmp/ directory.
Counts are intentionally fixed: this is a small storage probe, not a scale test.`);
  process.exit(0);
}
const api = await import(pathToFileURL(resolve(root, "dist/index.js")).href);
const manifest = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
assert.equal(api.version, manifest.version, "The built entry is stale; run npm run build first");
const parent = resolve(options["temp-root"]);
mkdirSync(parent, { recursive: true });
const temporaryParent = realpathSync(parent);
const owned = realpathSync(mkdtempSync(join(temporaryParent, "taximeter-storage-probe-")));
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const payer = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const payloadRow = z.object({ payload: z.string() });
const bytes = (value) => Buffer.byteLength(value, "utf8");
const ms = (value) => Math.round(value * 1000) / 1000;

function fixture(index, tasks, agents) {
  const resource = `https://storage.example.test/data?item=${index % 17}`;
  const body = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      asset,
      payTo,
      amount: "7",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
    resource: { url: resource },
    payload: {
      // Synthetic high-entropy-looking signature bytes, not a signed payment.
      signature: `0x${hash(`signature-a:${index}`)}${hash(`signature-b:${index}`)}1b`,
      authorization: {
        from: payer,
        to: payTo,
        value: "7",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${hash(`nonce:${index}`)}`,
      },
    },
  };
  return {
    raw: JSON.stringify(body),
    request: {
      url: resource,
      method: "GET",
      headers: {
        "payment-signature": encode(body),
        "taximeter-task": `storage-task-${index % tasks}`,
        "taximeter-agent": `storage-agent-${index % agents}`,
      },
    },
    response: {
      status: 200,
      headers: {
        "payment-response": encode({
          success: true,
          network: "eip155:8453",
          payer,
          transaction: `0x${hash(`transaction:${index}`)}`,
        }),
      },
    },
  };
}

const encodedSchema = z.strictObject({
  codec: z.enum(["gzip-v1", "br-v1"]),
  utf8Bytes: z.number().int().min(1).max(65536),
  data: z
    .string()
    .max(90000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
function compressed(raw, codec) {
  // Only fixture-generated recorded JSON is encoded here. A production codec must
  // also preserve arbitrary SDK raw strings, including lone UTF-16 surrogates.
  const data =
    codec === "gzip"
      ? gzipSync(Buffer.from(raw), { level: 6 })
      : brotliCompressSync(Buffer.from(raw), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  const encoded = { codec: `${codec}-v1`, utf8Bytes: bytes(raw), data: data.toString("base64") };
  assert.equal(decoded(encoded), raw);
  return encoded;
}
function decoded(input) {
  const value = encodedSchema.parse(input);
  const data = Buffer.from(value.data, "base64");
  assert.equal(data.toString("base64"), value.data);
  const output =
    value.codec === "gzip-v1"
      ? gunzipSync(data, { maxOutputLength: value.utf8Bytes })
      : brotliDecompressSync(data, { maxOutputLength: value.utf8Bytes });
  assert.equal(output.length, value.utf8Bytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

function storageStats(path) {
  const database = new Database(path, { readonly: true });
  try {
    const tableSizes = z
      .array(
        z.object({
          name: z.string(),
          pages: z.number().int().nonnegative(),
          allocatedBytes: z.number().int().nonnegative(),
          payloadBytes: z.number().int().nonnegative(),
          unusedBytes: z.number().int().nonnegative(),
        }),
      )
      .parse(
        database
          .prepare(
            "SELECT name, COUNT(*) AS pages, SUM(pgsize) AS allocatedBytes, SUM(payload) AS payloadBytes, SUM(unused) AS unusedBytes FROM dbstat GROUP BY name ORDER BY allocatedBytes DESC",
          )
          .all(),
      );
    const payloads = {};
    for (const table of ["events", "cache_payments", "outcomes", "cache_attempts"]) {
      let rows = 0;
      let jsonBytes = 0;
      let rawBytes = 0;
      let escapedRawBytes = 0;
      for (const row of database.prepare(`SELECT payload FROM ${table}`).iterate()) {
        const value = payloadRow.parse(row).payload;
        const event = z
          .object({ raw: z.unknown().optional() })
          .passthrough()
          .parse(JSON.parse(value));
        rows += 1;
        jsonBytes += bytes(value);
        if (typeof event.raw === "string") {
          rawBytes += bytes(event.raw);
          escapedRawBytes += bytes(JSON.stringify(event.raw)) - 2;
        }
      }
      payloads[table] = { rows, jsonBytes, rawBytes, escapedRawBytes };
    }
    return { databaseBytes: statSync(path).size, payloads, tableSizes };
  } finally {
    database.close();
  }
}

function prototypeClone(sourcePath, name) {
  const source = new Database(sourcePath, { readonly: true });
  const targetPath = join(owned, `${name}.db`);
  const target = new Database(targetPath);
  const quote = (name) =>
    `"${z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
      .parse(name)}"`;
  const definitions = z
    .array(z.object({ type: z.string(), name: z.string(), sql: z.string() }))
    .parse(
      source
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
        .all(),
    );
  const isCompressed = name.includes("gzip") || name.includes("br");
  const codec = name.includes("gzip") ? "gzip" : "br";
  const omitCache = name.includes("omit-cache");
  let codecMs = 0;
  try {
    target.pragma("journal_mode = WAL");
    target.transaction(() => {
      for (const definition of definitions.filter((row) => row.type === "table")) {
        target.exec(definition.sql);
        const withoutRowid = /WITHOUT ROWID\s*$/i.test(definition.sql);
        const rows = source
          .prepare(
            `SELECT ${withoutRowid ? "" : "rowid AS __sourceRowid, "}* FROM ${quote(definition.name)}`,
          )
          .iterate();
        let insertion;
        for (const row of rows) {
          const original = z.record(z.string(), z.unknown()).parse(row);
          const record = { ...original };
          if ("__sourceRowid" in record) {
            record.rowid = record.__sourceRowid;
            delete record.__sourceRowid;
          }
          if (definition.name === "events" || definition.name === "cache_payments") {
            const value = payloadRow.parse(record).payload;
            const payment = api.paymentEventSchema.parse(JSON.parse(value));
            const transformed = { ...payment };
            if (definition.name === "cache_payments" && omitCache) delete transformed.raw;
            else if (isCompressed) {
              const started = performance.now();
              transformed.raw = compressed(payment.raw, codec);
              codecMs += performance.now() - started;
            }
            // Demonstrate exact reconstruction; no candidate is opened by the unmodified runtime.
            const reconstructed = {
              ...transformed,
              raw:
                transformed.raw === undefined
                  ? payment.raw
                  : typeof transformed.raw === "string"
                    ? transformed.raw
                    : decoded(transformed.raw),
            };
            assert.deepEqual(api.paymentEventSchema.parse(reconstructed), payment);
            record.payload = JSON.stringify(transformed);
          }
          const columns = Object.keys(record);
          insertion ??= target.prepare(
            `INSERT INTO ${quote(definition.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          );
          insertion.run(...columns.map((column) => record[column]));
        }
      }
      for (const definition of definitions.filter((row) => row.type !== "table"))
        target.exec(definition.sql);
    })();
  } finally {
    target.close();
    source.close();
  }
  return { encoding: name, codecRoundTripMs: ms(codecMs), ...storageStats(targetPath) };
}

function verifyHydration(sourcePath, prototypePath, count) {
  const source = new Database(sourcePath, { readonly: true });
  const prototype = new Database(prototypePath, { readonly: true });
  const rowSchema = z.object({
    paymentId: z.string(),
    payload: z.string(),
    originalPayload: z.string(),
  });
  const metadataSchema = api.paymentEventSchema.omit({ raw: true });
  let sourceRows = 0;
  let verified = 0;
  try {
    const originalCache = source.prepare("SELECT payload FROM cache_payments WHERE paymentId = ?");
    for (const input of source
      .prepare(
        "SELECT c.paymentId, c.payload, e.payload AS originalPayload FROM cache_payments c JOIN events e ON e.id = c.paymentId",
      )
      .iterate()) {
      const row = rowSchema.parse(input);
      const cached = api.paymentEventSchema.parse(JSON.parse(row.payload));
      const original = api.paymentEventSchema.parse(JSON.parse(row.originalPayload));
      assert.equal(cached.raw, original.raw);
      sourceRows += 1;
    }
    for (const input of prototype
      .prepare(
        "SELECT c.paymentId, c.payload, e.payload AS originalPayload FROM cache_payments c JOIN events e ON e.id = c.paymentId",
      )
      .iterate()) {
      const row = rowSchema.parse(input);
      const stored = JSON.parse(row.payload);
      assert.equal(Object.hasOwn(stored, "raw"), false);
      assert.equal(api.paymentEventSchema.safeParse(stored).success, false);
      const original = api.paymentEventSchema.parse(JSON.parse(row.originalPayload));
      const hydrated = api.paymentEventSchema.parse({
        ...metadataSchema.parse(stored),
        raw: original.raw,
      });
      const reference = api.paymentEventSchema.parse(
        JSON.parse(payloadRow.parse(originalCache.get(row.paymentId)).payload),
      );
      assert.deepEqual(hydrated, reference);
      assert.equal(api.toJson([hydrated]), api.toJson([reference]));
      verified += 1;
    }
    assert.equal(sourceRows, count);
    assert.equal(verified, count);
    return {
      verified,
      identicalSourceAndCacheRaw: true,
      completeHydratedStateParity: true,
      exactJsonExportParity: true,
      oldSchemaRejectsOmittedRaw: true,
    };
  } finally {
    source.close();
    prototype.close();
  }
}

function removeOwned() {
  const target = realpathSync(owned);
  assert.ok(
    isAbsolute(target) &&
      target === owned &&
      dirname(target) === temporaryParent &&
      basename(target).startsWith("taximeter-storage-probe-"),
    "Refusing to remove a directory outside the owned storage probe workspace",
  );
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const results = [];
try {
  for (const [tasks, agents] of [
    [1, 1],
    [100, 10],
  ]) {
    const count = 1000;
    console.error(`Storage probe: ${count} payments, ${tasks} tasks, ${agents} agents`);
    const sourcePath = join(owned, `source-${tasks}-${agents}.db`);
    const ledger = new api.Ledger(sourcePath);
    const budget = { amount: (BigInt(count) * 7n).toString(), asset: "USDC", window: "24h" };
    const meter = new api.Meter(
      ledger,
      api.parseConfig({
        db: sourcePath,
        budgets: { perTask: budget, perAgent: budget, global: budget },
      }),
    );
    const raws = new Map();
    const started = performance.now();
    try {
      for (let index = 0; index < count; index += 1) {
        const item = fixture(index, tasks, agents);
        const intake = meter.begin(item.request);
        assert.ok(intake.payment && intake.attempt && !intake.body);
        assert.equal(intake.payment.raw, item.raw);
        raws.set(intake.payment.id, item.raw);
        meter.complete(intake, item.response);
      }
      const view = ledger.view();
      assert.equal(view.length, count);
      assert.ok(
        view.every((event) => event.settlementStatus === "confirmed" && !event.settlement_unknown),
      );
      const totals = api.totals(view);
      assert.equal(totals.length, 1);
      assert.equal(totals[0].amount, budget.amount);
      assert.equal(totals[0].confirmedAmount, budget.amount);
      assert.equal(totals[0].unknownAmount, "0");
      assert.equal(ledger.outcomes().length, count * 2);
      assert.deepEqual(ledger.diagnostics(), []);
      const exported = z
        .object({ events: z.array(api.paymentEventSchema) })
        .parse(JSON.parse(api.toJson(view)));
      for (const event of exported.events) assert.equal(event.raw, raws.get(event.id));
    } finally {
      ledger.close();
    }
    const fixtureAndValidationMs = ms(performance.now() - started);
    const current = storageStats(sourcePath);
    const variants = [];
    for (const variant of ["identity", "gzip", "br", "omit-cache", "br-omit-cache"]) {
      variants.push(prototypeClone(sourcePath, `${tasks}-${agents}-${variant}`));
    }
    const hydration = verifyHydration(
      sourcePath,
      join(owned, `${tasks}-${agents}-omit-cache.db`),
      count,
    );
    assert.equal(current.payloads.events.rows, count);
    assert.equal(current.payloads.cache_payments.rows, count);
    assert.equal(current.payloads.outcomes.rows, count * 2);
    assert.equal(current.payloads.cache_attempts.rows, count);
    results.push({ count, tasks, agents, fixtureAndValidationMs, current, variants, hydration });
  }
} finally {
  removeOwned();
}
const output = {
  recordedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  version: api.version,
  entrySha256: hash(readFileSync(resolve(root, "dist/index.js"))),
  scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  note: "1000 synthetic v2 recognized payments per dataset through real begin+complete, with two outcome rows per payment; unique deterministic hash-derived signature/nonce/transaction fixture bytes; no keys/signing/network. Candidate clones are storage-layout prototypes, not compatible runtime implementations. Identity clone controls for repacking. Gzip level 6 / Brotli quality 4 encode each recorded raw string as a tagged base64 JSON object. Exact original raw and complete payment round-trips checked for every transformed record; cache-to-source hydration and JSON export checked independently. Counts are fixed; timestamp-dependent index sizes and filesystem page occupancy can vary between runs.",
  temporaryDatabasesRemoved: true,
  results,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (options.output) {
  const destination = resolve(options.output);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, serialized);
  console.error(`Storage probe report: ${destination}`);
} else process.stdout.write(serialized);
