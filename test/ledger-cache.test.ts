import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { type Budget, budgetSchema, parseConfig, type TaximeterConfig } from "../src/config";
import { deriveEvents } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { type Outcome, outcomeSchema, type PaymentEvent } from "../src/model";
import {
  countForBudget,
  evaluate,
  evaluateWithState,
  type Scope,
  spentForBudget,
} from "../src/policy";
import { event } from "./helpers";

const now = Date.parse("2026-09-08T12:00:00.000Z");
const scopes: Scope[] = ["perTask", "perAgent", "global"];
const ledgers: Ledger[] = [];
const databases: Database.Database[] = [];
const directories: string[] = [];
const temporaryParent = realpathSync(tmpdir());

function id(sequence: number): string {
  return `01900000-0000-7000-8000-${sequence.toString().padStart(12, "0")}`;
}

function payment(sequence: number, overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return event({ id: id(sequence), paymentKey: `cache-payment-${sequence}`, ...overrides });
}

function observation(
  sequence: number,
  paymentId: string,
  status: Outcome["status"],
  overrides: Partial<Outcome> = {},
): Outcome {
  return outcomeSchema.parse({
    id: id(sequence),
    paymentId,
    ts: new Date(now).toISOString(),
    status,
    ...overrides,
  });
}

function budgets(window?: Budget["window"]): TaximeterConfig["budgets"] {
  const rule = budgetSchema.parse({ amount: "9".repeat(78), asset: "USDC", window });
  return { perTask: rule, perAgent: rule, global: rule };
}

function open(path = ":memory:"): Ledger {
  const ledger = new Ledger(path);
  ledgers.push(ledger);
  return ledger;
}

function database(path: string): Database.Database {
  const connection = new Database(path);
  connection.pragma("foreign_keys = ON");
  databases.push(connection);
  return connection;
}

function diskPath(): string {
  const directory = realpathSync(mkdtempSync(join(temporaryParent, "taximeter-cache-test-")));
  directories.push(directory);
  return join(directory, "ledger.db");
}

function legacy(path: string): Database.Database {
  const connection = database(path);
  connection.pragma("journal_mode = WAL");
  connection.exec(readFileSync(new URL("../migrations/001.sql", import.meta.url), "utf8"));
  return connection;
}

function rawPayment(connection: Database.Database, value: PaymentEvent): void {
  connection
    .prepare(
      "INSERT INTO events (id, ts, taskId, agentId, host, status, paymentKey, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      value.id,
      value.ts,
      value.taskId ?? null,
      value.agentId ?? null,
      value.host,
      value.status,
      value.paymentKey,
      JSON.stringify(value),
    );
}

function rawOutcome(connection: Database.Database, value: Outcome): void {
  connection
    .prepare("INSERT INTO outcomes (id, ts, paymentId, payload) VALUES (?, ?, ?, ?)")
    .run(value.id, value.ts, value.paymentId, JSON.stringify(value));
}

function assertParity(ledger: Ledger, proposed: PaymentEvent, rules = budgets(), at = now) {
  // Rebuild the oracle from immutable records, independently of every cache table.
  const reference = deriveEvents(ledger.events(), ledger.outcomes());
  expect(ledger.view()).toEqual(reference);
  const expected = { perTask: "0", perAgent: "0", global: "0" };
  const expectedCounts = { perTask: "0", perAgent: "0", global: "0" };
  for (const scope of scopes) {
    const rule = rules[scope];
    if (rule) {
      expected[scope] = spentForBudget(proposed, reference, rule, scope, at);
      expectedCounts[scope] = countForBudget(proposed, reference, rule, scope, at);
    }
  }
  const state = ledger.policyState(proposed, rules, at);
  expect(state.spent).toEqual(expected);
  expect(state.counts).toEqual(expectedCounts);
  expect(state.reserved).toEqual(
    reference.find(
      (entry) => entry.status === "observed" && entry.paymentKey === proposed.paymentKey,
    ),
  );
  return state;
}

afterEach(() => {
  for (const connection of databases.splice(0)) connection.close();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory);
    expect(isAbsolute(target) && target === directory && dirname(target) === temporaryParent).toBe(
      true,
    );
    expect(basename(target).startsWith("taximeter-cache-test-")).toBe(true);
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("exact cached budget state", () => {
  test("legacy migration and rebuild process more than one batch of both source logs", () => {
    const path = diskPath();
    const source = legacy(path);
    source.transaction(() => {
      for (let sequence = 1; sequence <= 520; sequence++) {
        const value = payment(sequence);
        rawPayment(source, value);
        rawOutcome(
          source,
          observation(10_000 + sequence, value.id, sequence % 2 === 0 ? "confirmed" : "failed"),
        );
      }
    })();
    const ledger = open(path);
    expect(assertParity(ledger, payment(1)).spent.global).toBe((260n * 7n).toString());
    expect(assertParity(ledger, payment(520)).reserved?.settlementStatus).toBe("confirmed");
    ledger.rebuildCache();
    expect(assertParity(ledger, payment(519)).reserved?.settlementStatus).toBe("failed");
    expect(ledger.events()).toHaveLength(520);
    expect(ledger.outcomes()).toHaveLength(520);
  });

  test("an empty cache returns zero in every scope and no reservation", () => {
    const ledger = open();
    expect(assertParity(ledger, payment(1))).toEqual({
      reserved: undefined,
      spent: { perTask: "0", perAgent: "0", global: "0" },
      counts: { perTask: "0", perAgent: "0", global: "0" },
    });
  });

  const windows: { name: string; window?: Budget["window"]; duration: number }[] = [
    { name: "one hour", window: "1h", duration: 3_600_000 },
    { name: "24 hours", window: "24h", duration: 86_400_000 },
    { name: "seven days", window: "7d", duration: 604_800_000 },
    { name: "30 days", window: "30d", duration: 2_592_000_000 },
    { name: "all time", duration: 3_600_000 },
  ];

  test.each(windows)("$name includes both boundaries and excludes future spend", (sample) => {
    const ledger = open();
    const start = now - sample.duration;
    const entries: { at: number; amount: string }[] = [
      { at: start - 1, amount: "1" },
      { at: start, amount: "2" },
      { at: start + 1, amount: "4" },
      { at: now - 1, amount: "8" },
      { at: now, amount: "16" },
      { at: now + 1, amount: "32" },
    ];
    for (const [index, entry] of entries.entries())
      ledger.append(
        payment(index + 1, { ts: new Date(entry.at).toISOString(), amount: entry.amount }),
      );
    const state = assertParity(ledger, payment(99), budgets(sample.window));
    const expected = sample.window ? "30" : "31";
    expect(state.spent).toEqual({ perTask: expected, perAgent: expected, global: expected });
    const count = sample.window ? "4" : "5";
    expect(state.counts).toEqual({ perTask: count, perAgent: count, global: count });
    ledger.rebuildCache();
    expect(assertParity(ledger, payment(99), budgets(sample.window))).toEqual(state);
  });

  test("negative epochs and backward clock queries do not require monotonically advancing time", () => {
    const ledger = open();
    const entries = [
      { at: -3_600_001, amount: "1" },
      { at: -3_600_000, amount: "2" },
      { at: -1, amount: "4" },
      { at: 0, amount: "8" },
      { at: 1, amount: "16" },
    ];
    for (const [index, entry] of entries.entries())
      ledger.append(
        payment(index + 1, { ts: new Date(entry.at).toISOString(), amount: entry.amount }),
      );
    const queries = [
      { at: 0, expected: "14" },
      { at: 1, expected: "28" },
      { at: -1, expected: "7" },
      { at: 0, expected: "14" },
    ];
    for (const query of queries)
      expect(assertParity(ledger, payment(99), budgets("1h"), query.at).spent.global).toBe(
        query.expected,
      );
  });

  test("scope labels and their null-like encodings never share an attribution bucket", () => {
    const ledger = open();
    const labels = [undefined, "null", '"null"', "[null]", "__null__", "\u0000", "s:null", "u:"];
    const entries = labels.map((label, index) =>
      payment(index + 1, {
        taskId: label,
        agentId: label,
        amount: (1n << BigInt(index)).toString(),
      }),
    );
    for (const entry of entries) ledger.append(entry);
    for (const entry of entries) {
      const state = assertParity(ledger, entry);
      expect(state.spent.perTask).toBe(entry.amount);
      expect(state.spent.perAgent).toBe(entry.amount);
      expect(state.spent.global).toBe("255");
    }
  });

  test("network, contract, task, and agent partitions remain independent", () => {
    const ledger = open();
    const proposed = payment(99);
    const entries = [
      payment(1, { amount: "1" }),
      payment(2, { amount: "2", taskId: "other-task" }),
      payment(3, { amount: "4", agentId: "other-agent" }),
      payment(4, { amount: "8", taskId: "other-task", agentId: "other-agent" }),
      payment(5, { amount: "16", network: "eip155:84532" }),
      payment(6, {
        amount: "32",
        asset: "unknown-contract",
        assetSymbol: undefined,
        decimalsKnown: false,
        decimals: 0,
      }),
      payment(7, { amount: "64", asset: proposed.asset.toUpperCase() }),
      payment(8, {
        amount: "128",
        status: "blocked",
        reason: "global_budget",
        settlement_unknown: false,
      }),
    ];
    for (const entry of entries) ledger.append(entry);
    expect(assertParity(ledger, proposed).spent).toEqual({
      perTask: "69",
      perAgent: "67",
      global: "79",
    });
    for (const entry of entries) assertParity(ledger, entry, budgets("24h"));
    const selectorMismatch = budgetSchema.parse({
      amount: "1",
      asset: "unrelated",
      network: "eip155:1",
    });
    expect(
      assertParity(ledger, proposed, { perTask: selectorMismatch, perAgent: null, global: null })
        .spent,
    ).toEqual({ perTask: "69", perAgent: "0", global: "0" });
  });

  test("two maximum individual amounts produce an exact aggregate longer than 78 digits", () => {
    const ledger = open();
    const maximum = "9".repeat(78);
    ledger.append(payment(1, { amount: maximum }));
    ledger.append(payment(2, { amount: maximum }));
    const expected = (BigInt(maximum) * 2n).toString();
    expect(expected).toHaveLength(79);
    const state = assertParity(ledger, payment(99), budgets("24h"));
    expect(state.spent).toEqual({ perTask: expected, perAgent: expected, global: expected });
    ledger.rebuildCache();
    expect(assertParity(ledger, payment(99), budgets("24h"))).toEqual(state);
  });

  test("zero-value authorizations consume one payment count without creating spend", () => {
    const ledger = open();
    const original = payment(1, { amount: "0" });
    ledger.append(original);
    ledger.appendOutcome(observation(101, original.id, "confirmed", { txHash: "zero-value" }));
    const state = assertParity(ledger, original, budgets("1h"));
    expect(state.spent).toEqual({ perTask: "0", perAgent: "0", global: "0" });
    expect(state.counts).toEqual({ perTask: "1", perAgent: "1", global: "1" });
    expect(state.reserved).toMatchObject({ amount: "0", txHash: "zero-value" });
    ledger.rebuildCache();
    expect(assertParity(ledger, original, budgets("1h"))).toEqual(state);
  });
});

describe("cached authorization and attempt semantics", () => {
  test("confirmed retries outside the count window retain parity without consuming a new slot", () => {
    const ledger = open();
    const original = payment(1, {
      ts: new Date(now - 3_600_001).toISOString(),
      settlementStatus: "confirmed",
      settlement_unknown: false,
    });
    ledger.append(original);
    ledger.append(payment(2));
    const config = parseConfig({
      budgets: { perTask: null, perAgent: null, global: { maxPayments: 1, window: "1h" } },
    });
    const retry = payment(3, { paymentKey: original.paymentKey });
    const state = assertParity(ledger, retry, config.budgets);
    expect(state.counts.global).toBe("1");
    expect(evaluateWithState(retry, state, config, now)).toEqual({ allowed: true });
    expect(evaluateWithState(retry, state, config, now)).toEqual(
      evaluate(retry, ledger.view(), config, now),
    );
    expect(
      evaluateWithState(payment(4), assertParity(ledger, payment(4), config.budgets), config, now),
    ).toMatchObject({
      body: { reason: "global_payment_count", spent: "1" },
    });
    ledger.appendOutcome(observation(101, original.id, "unknown", { attemptedAt: original.ts }));
    const afterRetry = assertParity(ledger, retry, config.budgets);
    expect(afterRetry.counts).toEqual(state.counts);
    ledger.rebuildCache();
    expect(assertParity(ledger, retry, config.budgets)).toEqual(afterRetry);
  });

  test("settlement observations for a blocked row cannot create a reusable reservation", () => {
    const ledger = open();
    const blocked = payment(1, {
      status: "blocked",
      reason: "global_budget",
      settlement_unknown: false,
    });
    ledger.append(blocked);
    ledger.appendOutcome(observation(101, blocked.id, "confirmed", { txHash: "blocked-report" }));
    const state = assertParity(ledger, blocked);
    expect(state.reserved).toBeUndefined();
    expect(state.spent.global).toBe("0");
    const allowed = payment(2, { paymentKey: blocked.paymentKey });
    ledger.append(allowed);
    expect(assertParity(ledger, allowed).reserved).toEqual(allowed);
    expect(assertParity(ledger, allowed).spent.global).toBe("7");
    ledger.rebuildCache();
    expect(assertParity(ledger, allowed).reserved).toEqual(allowed);
  });

  test("duplicate IDs and payment keys do not add spend or replace the original attribution", () => {
    const ledger = open();
    const original = payment(1);
    const retry = payment(2, {
      paymentKey: original.paymentKey,
      taskId: "another-task",
      amount: "999",
    });
    expect(ledger.append(original)).toBe(true);
    expect(ledger.append(original)).toBe(false);
    expect(ledger.append(retry)).toBe(false);
    ledger.append(
      payment(3, { status: "blocked", paymentKey: original.paymentKey, settlement_unknown: false }),
    );
    const attempt = observation(101, original.id, "unknown", {
      attemptId: id(501),
      attemptedAt: original.ts,
    });
    expect(ledger.appendOutcome(attempt)).toBe(true);
    expect(ledger.appendOutcome(attempt)).toBe(false);
    const state = assertParity(ledger, retry);
    expect(state.spent).toEqual({ perTask: "0", perAgent: "7", global: "7" });
    expect(state.reserved).toMatchObject({ id: original.id, amount: "7", taskId: original.taskId });
    expect(ledger.events()).toHaveLength(2);
    expect(ledger.outcomes()).toHaveLength(1);
  });

  test("a wholly failed reservation remains available by key while its spend is zero", () => {
    const ledger = open();
    const original = payment(1);
    ledger.append(original);
    ledger.appendOutcome(observation(101, original.id, "failed"));
    const state = assertParity(ledger, original);
    expect(state.reserved).toMatchObject({
      id: original.id,
      settlementStatus: "failed",
      settlement_unknown: false,
    });
    expect(state.spent.global).toBe("0");
    expect(
      assertParity(ledger, original, { perTask: null, perAgent: null, global: null }).reserved,
    ).toEqual(state.reserved);
  });

  test("out-of-order timestamps and tied IDs preserve latest status and sticky confirmation", () => {
    const ledger = open();
    const original = payment(1);
    ledger.append(original);
    ledger.appendOutcome(observation(103, original.id, "failed"));
    ledger.appendOutcome(observation(102, original.id, "unknown"));
    expect(assertParity(ledger, original).spent.global).toBe("0");
    ledger.appendOutcome(
      observation(101, original.id, "confirmed", {
        ts: new Date(now - 1).toISOString(),
        txHash: "older-confirmation",
      }),
    );
    expect(assertParity(ledger, original).reserved).toMatchObject({
      settlementStatus: "confirmed",
      txHash: "older-confirmation",
    });
    ledger.appendOutcome(
      observation(105, original.id, "failed", { ts: new Date(now + 1).toISOString() }),
    );
    ledger.appendOutcome(
      observation(104, original.id, "confirmed", { txHash: "newer-confirmation" }),
    );
    expect(assertParity(ledger, original).reserved).toMatchObject({
      settlementStatus: "confirmed",
      txHash: "newer-confirmation",
    });
    expect(assertParity(ledger, original).spent.global).toBe("7");
  });

  test("one failed retry cannot release another unresolved attempt", () => {
    const ledger = open();
    const original = payment(1);
    ledger.append(original);
    ledger.appendOutcome(observation(101, original.id, "unknown", { attemptId: id(501) }));
    ledger.appendOutcome(observation(102, original.id, "failed", { attemptId: id(502) }));
    expect(assertParity(ledger, original).spent.global).toBe("7");
    ledger.appendOutcome(observation(103, original.id, "failed", { attemptId: id(501) }));
    expect(assertParity(ledger, original).spent.global).toBe("0");
    ledger.appendOutcome(
      observation(104, original.id, "confirmed", { attemptId: id(502), txHash: "confirmed-retry" }),
    );
    ledger.appendOutcome(observation(105, original.id, "unknown", { attemptId: id(501) }));
    expect(assertParity(ledger, original).reserved).toMatchObject({
      settlementStatus: "confirmed",
      txHash: "confirmed-retry",
    });
  });

  test("an originally confirmed event cannot be downgraded by attempt outcomes", () => {
    const ledger = open();
    const original = payment(1, {
      settlementStatus: "confirmed",
      settlement_unknown: false,
      txHash: "original-confirmation",
    });
    ledger.append(original);
    ledger.appendOutcome(observation(101, original.id, "failed"));
    expect(assertParity(ledger, original).reserved).toMatchObject({
      settlementStatus: "confirmed",
      txHash: "original-confirmation",
    });
    expect(assertParity(ledger, original).spent.global).toBe("7");
  });

  test("out-of-order first observations preserve which confirmed attempt supplies the transaction", () => {
    const ledger = open();
    const original = payment(1);
    ledger.append(original);
    ledger.appendOutcome(
      observation(103, original.id, "confirmed", {
        attemptId: id(501),
        ts: new Date(now + 3).toISOString(),
        txHash: "attempt-a",
      }),
    );
    ledger.appendOutcome(
      observation(104, original.id, "confirmed", {
        attemptId: id(502),
        ts: new Date(now + 4).toISOString(),
        txHash: "attempt-b",
      }),
    );
    expect(assertParity(ledger, original).reserved?.txHash).toBe("attempt-a");
    ledger.appendOutcome(
      observation(101, original.id, "unknown", {
        attemptId: id(502),
        ts: new Date(now + 1).toISOString(),
      }),
    );
    expect(assertParity(ledger, original).reserved?.txHash).toBe("attempt-b");
  });

  test.each([false, true])(
    "mixed-case UUID timestamp ties preserve locale ordering, reverse insertion: %s",
    (reverse) => {
      const ledger = open();
      const original = payment(1);
      ledger.append(original);
      const lowerId = "019aaaaa-abcd-7abc-8abc-abcdef123456";
      const upperId = lowerId.toUpperCase();
      const lower = observation(101, original.id, "confirmed", {
        id: lowerId,
        attemptId: id(501),
        txHash: "lowercase-uuid",
      });
      const upper = observation(102, original.id, "confirmed", {
        id: upperId,
        attemptId: id(502),
        txHash: "uppercase-uuid",
      });
      expect(lower.id).toBe(lowerId);
      expect(upper.id).toBe(upperId);
      expect(lower.id).not.toBe(upper.id);
      for (const result of reverse ? [upper, lower] : [lower, upper]) ledger.appendOutcome(result);
      const expected = lower.id.localeCompare(upper.id) < 0 ? lower.txHash : upper.txHash;
      expect(assertParity(ledger, original).reserved?.txHash).toBe(expected);
      ledger.rebuildCache();
      expect(assertParity(ledger, original).reserved?.txHash).toBe(expected);
    },
  );

  test("attemptedAt moves old exposure and uses the maximum across losing or failed outcomes", () => {
    const ledger = open();
    const original = payment(1, { ts: new Date(now - 8 * 86_400_000).toISOString() });
    ledger.append(original);
    expect(assertParity(ledger, original, budgets("24h")).spent.global).toBe("0");
    ledger.appendOutcome(
      observation(103, original.id, "unknown", {
        attemptId: id(501),
        attemptedAt: new Date(now).toISOString(),
      }),
    );
    expect(assertParity(ledger, original, budgets("24h")).spent.global).toBe("7");
    ledger.appendOutcome(
      observation(101, original.id, "failed", {
        attemptId: id(502),
        ts: new Date(now - 1).toISOString(),
        attemptedAt: new Date(now + 1).toISOString(),
      }),
    );
    const future = assertParity(ledger, original, budgets("24h"));
    expect(future.reserved).toMatchObject({
      ts: original.ts,
      attemptedAt: new Date(now + 1).toISOString(),
      settlementStatus: "unknown",
    });
    expect(future.spent.global).toBe("0");
    expect(assertParity(ledger, original, budgets("24h"), now + 1).spent.global).toBe("7");
    expect(assertParity(ledger, original, budgets("24h"), now - 1).spent.global).toBe("0");
    ledger.rebuildCache();
    expect(assertParity(ledger, original, budgets("24h"))).toEqual(future);
  });
});

describe("cache persistence and transaction safety", () => {
  test.each(["amount", "count"])(
    "a corrupted %s cache cannot commit an outcome or a negative contribution",
    (field) => {
      const path = diskPath();
      const ledger = open(path);
      const source = database(path);
      const original = payment(1, { amount: field === "count" ? "0" : "7" });
      ledger.append(original);
      const expected = assertParity(ledger, original);
      source.exec(`UPDATE cache_prefix SET ${field} = '0'`);
      expect(() => ledger.appendOutcome(observation(101, original.id, "failed"))).toThrow(
        "Cached contribution underflow",
      );
      expect(ledger.outcomes()).toEqual([]);
      ledger.rebuildCache();
      expect(assertParity(ledger, original)).toEqual(expected);
      expect(ledger.appendOutcome(observation(101, original.id, "failed"))).toBe(true);
      expect(assertParity(ledger, original).counts.global).toBe("0");
    },
  );

  test("rebuilds are repeatable and preserve all immutable records and policy states", () => {
    const ledger = open();
    const values = [
      payment(1),
      payment(2, { taskId: undefined, agentId: "null" }),
      payment(3, { status: "blocked", settlement_unknown: false }),
    ];
    for (const value of values) ledger.append(value);
    ledger.appendOutcome(observation(101, id(1), "confirmed", { txHash: "settled" }));
    ledger.appendOutcome(observation(102, id(2), "failed"));
    const records = { events: ledger.events(), outcomes: ledger.outcomes() };
    const before = values.map((value) => assertParity(ledger, value, budgets("7d")));
    for (const _pass of [1, 2]) {
      ledger.rebuildCache();
      expect(values.map((value) => assertParity(ledger, value, budgets("7d")))).toEqual(before);
      expect({ events: ledger.events(), outcomes: ledger.outcomes() }).toEqual(records);
    }
  });

  test("v1 migration preserves events, outcomes, and exact state when another connection opens", () => {
    const path = diskPath();
    const old = legacy(path);
    const original = payment(1, { amount: "9".repeat(78) });
    const result = observation(101, original.id, "confirmed", {
      txHash: "legacy-confirmed",
      attemptedAt: original.ts,
    });
    rawPayment(old, original);
    rawOutcome(old, result);
    const first = open(path);
    const second = open(path);
    expect(first.events()).toEqual([original]);
    expect(first.outcomes()).toEqual([result]);
    expect(assertParity(first, original)).toEqual(assertParity(second, original));
    expect(
      z
        .object({ version: z.literal(3) })
        .parse(old.prepare("SELECT MAX(version) AS version FROM schema_version").get()).version,
    ).toBe(3);
  });

  test("already-open v1 writers are caught up before cached reads and across new connections", () => {
    const path = diskPath();
    const old = legacy(path);
    const initial = payment(1, { amount: "11" });
    rawPayment(old, initial);
    const first = open(path);
    const second = open(path);
    expect(assertParity(first, payment(99)).spent.global).toBe("11");
    const external = payment(2, { amount: "13" });
    old
      .transaction(() => {
        rawPayment(old, external);
        rawOutcome(old, observation(101, initial.id, "failed"));
      })
      .immediate();
    expect(assertParity(second, payment(99)).spent.global).toBe("13");
    expect(assertParity(first, initial).reserved?.settlementStatus).toBe("failed");
    second.appendOutcome(observation(102, external.id, "confirmed", { txHash: "new-connection" }));
    expect(assertParity(first, external).reserved?.txHash).toBe("new-connection");
    first.append(payment(3, { amount: "17" }));
    expect(assertParity(second, payment(99)).spent.global).toBe("30");
    second.rebuildCache();
    expect(assertParity(first, payment(99)).spent.global).toBe("30");
  });

  test("failed outer transactions roll back events, attempt changes, and cached sums together", () => {
    const path = diskPath();
    const first = open(path);
    const second = open(path);
    const original = payment(1);
    first.append(original);
    const before = assertParity(first, original);
    expect(() =>
      first.transaction(() => {
        first.append(payment(2, { amount: "11" }));
        first.appendOutcome(observation(101, original.id, "failed"));
        expect(assertParity(first, original).spent.global).toBe("11");
        throw new Error("Rollback the entire reservation");
      }),
    ).toThrow("Rollback the entire reservation");
    expect(first.events()).toEqual([original]);
    expect(first.outcomes()).toEqual([]);
    expect(assertParity(first, original)).toEqual(before);
    expect(assertParity(second, original)).toEqual(before);
    expect(() => first.appendOutcome(observation(102, id(999), "confirmed"))).toThrow();
    expect(assertParity(second, original)).toEqual(before);
    first.append(payment(2, { amount: "11" }));
    expect(assertParity(second, payment(99)).spent.global).toBe("18");
  });

  test("a failed legacy backfill leaves the v1 schema and audit records intact", () => {
    const path = diskPath();
    const old = legacy(path);
    const original = payment(1);
    old
      .prepare(
        "INSERT INTO events (id, ts, host, status, paymentKey, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        original.id,
        original.ts,
        original.host,
        original.status,
        original.paymentKey,
        JSON.stringify({ ...original, amount: "1.5" }),
      );
    const before = old
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    expect(() => new Ledger(path)).toThrow();
    expect(
      old.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
    ).toEqual(before);
    expect(old.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({
      version: 1,
    });
    expect(old.prepare("SELECT payload FROM events").get()).toEqual({
      payload: JSON.stringify({ ...original, amount: "1.5" }),
    });
  });
});
