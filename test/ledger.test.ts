import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deriveEvents, formatAmount, totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { type Outcome, outcomeSchema, type PaymentEvent, paymentEventSchema } from "../src/model";

function id(sequence: number): string {
  return `01900000-0000-7000-8000-${sequence.toString().padStart(12, "0")}`;
}

function payment(sequence: number, overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return paymentEventSchema.parse({
    id: id(sequence),
    ts: "2026-09-08T12:00:00.000Z",
    rail: "x402",
    status: "observed",
    amount: "1000000",
    decimals: 6,
    decimalsKnown: true,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    assetSymbol: "USDC",
    network: "eip155:8453",
    payTo: "0x1111111111111111111111111111111111111111",
    payer: "0x2222222222222222222222222222222222222222",
    resource: "https://api.example.test/data",
    host: "api.example.test",
    taskId: "task-1",
    agentId: "agent-1",
    raw: '{"fixture":true}',
    paymentKey: `payment-${sequence}`,
    ...overrides,
  });
}

function outcome(
  sequence: number,
  paymentId: string,
  status: Outcome["status"],
  overrides: Partial<Outcome> = {},
): Outcome {
  return outcomeSchema.parse({
    id: id(sequence),
    ts: "2026-09-08T12:01:00.000Z",
    paymentId,
    status,
    ...overrides,
  });
}

describe("pure ledger derivation", () => {
  test("an empty log derives an empty view and no totals", () => {
    expect(deriveEvents([])).toEqual([]);
    expect(totals([])).toEqual([]);
  });

  test("large monetary amounts and settlement subtotals remain exact integer strings", () => {
    const events = deriveEvents([
      payment(1, {
        amount: "900719925474099312345678901234567890",
        settlementStatus: "confirmed",
        settlement_unknown: false,
      }),
      payment(2, { amount: "10" }),
    ]);
    expect(totals(events)).toEqual([
      expect.objectContaining({
        network: "eip155:8453",
        asset: events[0]?.asset.toLowerCase(),
        assetSymbol: "USDC",
        decimals: 6,
        decimalsKnown: true,
        amount: "900719925474099312345678901234567900",
        confirmedAmount: "900719925474099312345678901234567890",
        unknownAmount: "10",
      }),
    ]);
  });

  test("blocked and failed payments never contribute to totals", () => {
    const events = deriveEvents([
      payment(1, { status: "blocked", reason: "Budget exceeded", amount: "999999999" }),
      payment(2, { settlementStatus: "failed", settlement_unknown: false }),
      payment(3, { amount: "7" }),
    ]);
    expect(events).toHaveLength(3);
    expect(totals(events)).toEqual([
      expect.objectContaining({ amount: "7", confirmedAmount: "0", unknownAmount: "7" }),
    ]);
    expect(totals(events.filter((event) => event.status === "blocked"))).toEqual([]);
  });

  test("contracts and networks remain separate even when symbols match", () => {
    const events = deriveEvents([
      payment(1, { amount: "11" }),
      payment(2, { amount: "13", network: "eip155:1" }),
      payment(3, {
        amount: "17",
        asset: "0x3333333333333333333333333333333333333333",
      }),
      payment(4, {
        amount: "19",
        asset: "custom-asset",
        assetSymbol: undefined,
        decimals: 0,
        decimalsKnown: false,
      }),
    ]);
    const result = totals(events);
    expect(result).toHaveLength(4);
    expect(result.map((total) => total.amount).sort()).toEqual(["11", "13", "17", "19"]);
    expect(result.find((total) => total.asset === "custom-asset")).toMatchObject({
      decimals: 0,
      decimalsKnown: false,
      amount: "19",
    });
  });

  test("repeated IDs and observed payment keys count once while blocked attempts survive", () => {
    const first = payment(1);
    const retry = payment(2, {
      paymentKey: first.paymentKey,
      ts: "2026-09-08T12:00:01.000Z",
    });
    const blocked = payment(3, {
      status: "blocked",
      paymentKey: first.paymentKey,
      reason: "Budget exceeded",
    });
    const result = deriveEvents([retry, blocked, first, { ...first }, { ...blocked }]);
    expect(result).toHaveLength(2);
    expect(result.filter((event) => event.status === "observed")).toEqual([first]);
    expect(result.filter((event) => event.status === "blocked")).toEqual([
      { ...blocked, settlement_unknown: false },
    ]);
    expect(totals(result)).toEqual([expect.objectContaining({ amount: "1000000" })]);
  });

  test("confirmation remains authoritative after a later failed or unknown retry", () => {
    const event = payment(1);
    const observations = [
      outcome(11, event.id, "confirmed", { txHash: "0xconfirmed" }),
      outcome(12, event.id, "failed", { ts: "2026-09-08T12:02:00.000Z" }),
      outcome(13, event.id, "unknown", { ts: "2026-09-08T12:03:00.000Z" }),
    ];
    const result = deriveEvents([event], observations);
    expect(result[0]).toMatchObject({
      settlementStatus: "confirmed",
      settlement_unknown: false,
      txHash: "0xconfirmed",
    });
    expect(totals(result)).toEqual([
      expect.objectContaining({
        amount: "1000000",
        confirmedAmount: "1000000",
        unknownAmount: "0",
      }),
    ]);
  });

  test("a confirmed input event cannot be downgraded by a later failed outcome", () => {
    const event = payment(1, {
      settlementStatus: "confirmed",
      settlement_unknown: false,
      txHash: "0xoriginal-confirmation",
    });
    const result = deriveEvents([event], [outcome(11, event.id, "failed")]);
    expect(result[0]).toMatchObject({
      settlementStatus: "confirmed",
      settlement_unknown: false,
      txHash: "0xoriginal-confirmation",
    });
    expect(totals(result)).toEqual([
      expect.objectContaining({
        amount: "1000000",
        confirmedAmount: "1000000",
        unknownAmount: "0",
      }),
    ]);
  });

  test("without confirmation, the latest failure or uncertainty determines exposure", () => {
    const event = payment(1);
    const failure = outcome(11, event.id, "failed", { reason: "Rejected by upstream" });
    const uncertainty = outcome(12, event.id, "unknown", {
      ts: "2026-09-08T12:02:00.000Z",
      reason: "Upstream disconnected",
    });
    const failed = deriveEvents([event], [failure]);
    expect(failed[0]).toMatchObject({ settlementStatus: "failed", settlement_unknown: false });
    expect(totals(failed)).toEqual([]);
    const uncertain = deriveEvents([event], [uncertainty, failure]);
    expect(uncertain[0]).toMatchObject({ settlementStatus: "unknown", settlement_unknown: true });
    expect(totals(uncertain)).toEqual([
      expect.objectContaining({ amount: "1000000", unknownAmount: "1000000" }),
    ]);
  });

  test("unrelated outcomes cannot change another payment", () => {
    const event = payment(1);
    expect(deriveEvents([event], [outcome(11, id(99), "confirmed")])).toEqual([event]);
  });

  test("timestamp ties are deterministic and derivation does not mutate its inputs", () => {
    const events = [
      payment(3, { ts: "2026-09-08T11:59:00.000Z", amount: "3" }),
      payment(2, { amount: "2" }),
      payment(1, { amount: "1" }),
    ];
    const observations = [outcome(12, id(1), "failed"), outcome(13, id(1), "unknown")];
    const before = JSON.stringify({ events, observations });
    const first = deriveEvents(events, observations);
    const second = deriveEvents([...events].reverse(), [...observations].reverse());
    expect(first).toEqual(second);
    expect(totals(first)).toEqual(totals(second));
    expect(JSON.stringify({ events, observations })).toBe(before);
  });

  test("replaying an entire event log twice produces identical derived totals", () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      payment(index + 1, { amount: "10001" }),
    );
    const first = deriveEvents(events);
    const replayed = deriveEvents([...events, ...events.map((event) => ({ ...event }))]);
    expect(replayed).toEqual(first);
    expect(totals(replayed)).toEqual(totals(first));
    expect(totals(replayed)).toEqual([expect.objectContaining({ amount: "1000100" })]);
  });

  test.each([
    ["0", 0, "0"],
    ["123456789012345678901234567890", 0, "123456789012345678901234567890"],
    ["0", 6, "0.000000"],
    ["1", 6, "0.000001"],
    ["1000000", 6, "1.000000"],
    ["900719925474099312345678901234567890", 6, "900719925474099312345678901234.567890"],
  ])(
    "formats integer amount %s at %i decimals as an exact display string",
    (amount, decimals, expected) => {
      expect(formatAmount(amount, decimals)).toBe(expected);
    },
  );
});

describe("append-only SQLite ledger", () => {
  const openLedgers: Ledger[] = [];
  const directories: string[] = [];

  function open(path = ":memory:"): Ledger {
    const ledger = new Ledger(path);
    openLedgers.push(ledger);
    return ledger;
  }

  afterEach(() => {
    for (const ledger of openLedgers.splice(0)) ledger.close();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test("stores validated events and suppresses duplicate event IDs", () => {
    const ledger = open();
    const event = payment(1);
    expect(ledger.append(event)).toBe(true);
    expect(ledger.append({ ...event })).toBe(false);
    expect(ledger.events()).toEqual([event]);
    expect(ledger.outcomes()).toEqual([]);
    expect(ledger.view()).toEqual([event]);
    expect(ledger.diagnostics()).toEqual([]);
  });

  test("counts observed and blocked rows without loading event payloads", () => {
    const ledger = open();
    const fullHistory = vi.spyOn(ledger, "events").mockImplementation(() => {
      throw new Error("Event counting must not hydrate the ledger");
    });
    try {
      expect(ledger.eventCount()).toBe(0);
      const original = payment(1);
      expect(ledger.append(original)).toBe(true);
      expect(ledger.append(original)).toBe(false);
      expect(ledger.eventCount()).toBe(1);
      ledger.append(payment(2, { status: "blocked", reason: "global_payment_count" }));
      ledger.appendOutcome(outcome(11, original.id, "confirmed"));
      ledger.diagnose("parse_failed", "fixture", "A diagnostic is not a payment event");
      expect(ledger.eventCount()).toBe(2);
      expect(fullHistory).not.toHaveBeenCalled();
    } finally {
      fullHistory.mockRestore();
    }
  });

  test("deduplicates observed payment keys while accepting unattributed events", () => {
    const ledger = open();
    const original = payment(1, { taskId: undefined, agentId: undefined });
    expect(ledger.append(original)).toBe(true);
    expect(ledger.append(payment(2, { paymentKey: original.paymentKey }))).toBe(false);
    expect(ledger.events()).toEqual([original]);
  });

  test("rejects invalid amounts and malformed external objects before storing them", () => {
    const ledger = open();
    for (const amount of [1.5, "1.5", "-1", "1e6", "01", "", null]) {
      expect(() => ledger.append({ ...payment(1), amount })).toThrow();
    }
    expect(() => ledger.append({ id: "not-a-uuid" })).toThrow();
    expect(() => ledger.appendOutcome({ status: "confirmed" })).toThrow();
    expect(ledger.events()).toEqual([]);
    expect(ledger.outcomes()).toEqual([]);
  });

  test("appends settlement observations without overwriting original payment records", () => {
    const ledger = open();
    const event = payment(1);
    const confirmed = outcome(11, event.id, "confirmed", { txHash: "0xsettlement" });
    ledger.append(event);
    expect(ledger.appendOutcome(confirmed)).toBe(true);
    expect(ledger.appendOutcome({ ...confirmed })).toBe(false);
    ledger.appendOutcome(outcome(12, event.id, "failed", { ts: "2026-09-08T12:02:00.000Z" }));
    expect(ledger.events()).toEqual([event]);
    expect(ledger.outcomes()).toHaveLength(2);
    expect(ledger.view()[0]).toMatchObject({
      settlementStatus: "confirmed",
      settlement_unknown: false,
      txHash: "0xsettlement",
    });
  });

  test("keeps blocked attempts auditable without adding them to spend", () => {
    const ledger = open();
    const event = payment(1);
    ledger.append(event);
    ledger.append(payment(2, { status: "blocked", paymentKey: event.paymentKey, reason: "Cap" }));
    ledger.append(payment(3, { status: "blocked", paymentKey: event.paymentKey, reason: "Cap" }));
    expect(ledger.events()).toHaveLength(3);
    expect(ledger.view().filter((entry) => entry.status === "blocked")).toHaveLength(2);
    expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "1000000" })]);
  });

  test("records useful parser and settlement diagnostics", () => {
    const ledger = open();
    ledger.diagnose("parse_failed", "https://api.example.test/data", "Unknown x402 version");
    ledger.diagnose("settlement_unknown", "https://api.example.test/data", "Upstream reset");
    expect(ledger.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "parse_failed", message: "Unknown x402 version" }),
        expect.objectContaining({ code: "settlement_unknown", message: "Upstream reset" }),
      ]),
    );
    expect(ledger.diagnostics()).toHaveLength(2);
  });

  test("commits successful transactions and returns the callback result", () => {
    const ledger = open();
    const result = ledger.transaction(() => {
      ledger.append(payment(1));
      ledger.append(payment(2));
      return "committed";
    });
    expect(result).toBe("committed");
    expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "2000000" })]);
  });

  test("rolls back all ledger writes when a transaction fails", () => {
    const ledger = open();
    ledger.append(payment(1));
    expect(() =>
      ledger.transaction(() => {
        ledger.append(payment(2));
        ledger.appendOutcome(outcome(12, id(1), "confirmed"));
        ledger.diagnose("parse_failed", "fixture", "temporary diagnostic");
        throw new Error("Abort reservation");
      }),
    ).toThrow("Abort reservation");
    expect(ledger.events()).toEqual([payment(1)]);
    expect(ledger.outcomes()).toEqual([]);
    expect(ledger.diagnostics()).toEqual([]);
  });

  test("migrations and exact monetary records survive reopening a file database", () => {
    const directory = mkdtempSync(join(tmpdir(), "taximeter-ledger-test-"));
    directories.push(directory);
    const path = join(directory, "ledger.db");
    const first = new Ledger(path);
    const event = payment(1, { amount: "999999999999999999999999999999999999" });
    try {
      first.append(event);
      first.appendOutcome(outcome(11, event.id, "confirmed", { txHash: "0xpersisted" }));
      first.diagnose("parse_failed", "fixture", "Persisted diagnostic");
    } finally {
      first.close();
    }
    const reopened = open(path);
    expect(reopened.events()).toEqual([event]);
    expect(reopened.view()[0]).toMatchObject({
      settlementStatus: "confirmed",
      txHash: "0xpersisted",
    });
    expect(reopened.diagnostics()[0]?.message).toBe("Persisted diagnostic");
    expect(totals(reopened.view())).toEqual([
      expect.objectContaining({ amount: "999999999999999999999999999999999999" }),
    ]);
    const inspector = new Database(path, { readonly: true });
    try {
      expect(inspector.prepare("SELECT * FROM schema_version").all()).not.toHaveLength(0);
    } finally {
      inspector.close();
    }
  });

  test("independent connections observe committed writes without a stale running counter", () => {
    const directory = mkdtempSync(join(tmpdir(), "taximeter-ledger-shared-"));
    directories.push(directory);
    const path = join(directory, "ledger.db");
    const first = open(path);
    const second = open(path);
    first.transaction(() => first.append(payment(1, { amount: "11" })));
    expect(totals(second.view())).toEqual([expect.objectContaining({ amount: "11" })]);
    second.transaction(() => second.append(payment(2, { amount: "13" })));
    expect(totals(first.view())).toEqual([expect.objectContaining({ amount: "24" })]);
  });

  test("rejects a database created by an unsupported future schema version", () => {
    const directory = mkdtempSync(join(tmpdir(), "taximeter-ledger-future-"));
    directories.push(directory);
    const path = join(directory, "ledger.db");
    const future = new Database(path);
    try {
      future.exec(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (4)",
      );
    } finally {
      future.close();
    }
    expect(() => new Ledger(path)).toThrow();
    const inspector = new Database(path);
    try {
      expect(inspector.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 4 });
    } finally {
      inspector.close();
    }
  });

  test("SQLite rejects modifications and deletions of the original audit records", () => {
    const directory = mkdtempSync(join(tmpdir(), "taximeter-ledger-immutable-"));
    directories.push(directory);
    const path = join(directory, "ledger.db");
    const ledger = open(path);
    ledger.append(payment(1));
    ledger.appendOutcome(outcome(11, id(1), "confirmed"));
    ledger.diagnose("parse_failed", "fixture", "Audit record");
    const inspector = new Database(path);
    try {
      for (const table of ["events", "outcomes", "diagnostics"]) {
        expect(() => inspector.prepare(`UPDATE ${table} SET payload = '{}'`).run()).toThrow();
        expect(() => inspector.prepare(`DELETE FROM ${table}`).run()).toThrow();
      }
    } finally {
      inspector.close();
    }
    expect(ledger.events()).toEqual([payment(1)]);
    expect(ledger.outcomes()).toHaveLength(1);
    expect(ledger.diagnostics()).toHaveLength(1);
  });
});
