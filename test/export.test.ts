import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/program";
import { toCsv, toInvoice, toJson } from "../src/export/index";
import { deriveEvents, totalSchema, totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { type PaymentEvent, paymentEventSchema } from "../src/model";
import { event } from "./helpers";

const columns = [
  "id",
  "ts",
  "rail",
  "status",
  "settlementStatus",
  "amount",
  "authorizedAmount",
  "asset",
  "network",
  "decimals",
  "decimalsKnown",
  "assetSymbol",
  "payTo",
  "payer",
  "resource",
  "host",
  "taskId",
  "agentId",
  "txHash",
  "reason",
];

function fixed(sequence: number, overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return event({
    id: `01900000-0000-7000-8000-${sequence.toString().padStart(12, "0")}`,
    paymentKey: `export-payment-${sequence}`,
    ts: "2026-09-08T12:00:00.000Z",
    ...overrides,
  });
}

function sample(): PaymentEvent[] {
  return [
    fixed(1, {
      amount: "900719925474099312345678901234567890",
      settlementStatus: "confirmed",
      settlement_unknown: false,
      txHash: "0xconfirmed",
    }),
    fixed(2, { amount: "10", taskId: 'task, "quoted"\nsecond line' }),
    fixed(3, { amount: "900", status: "blocked", reason: "global_budget" }),
    fixed(4, { amount: "5", settlementStatus: "failed", settlement_unknown: false }),
    fixed(5, {
      amount: "23",
      asset: "0x3333333333333333333333333333333333333333",
      network: "eip155:1",
      decimals: 0,
      decimalsKnown: false,
      assetSymbol: undefined,
      taskId: undefined,
      agentId: undefined,
    }),
  ];
}

/** Independent CSV reader: quoted fields may contain commas, CRLF, or doubled quotes. */
function csvRows(csv: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let consumed = 0;
  for (const match of csv.matchAll(/"((?:[^"]|"")*)"(,|\r\n|$)/g)) {
    if (match.index !== consumed) throw new Error("Malformed or unquoted CSV field");
    consumed += match[0].length;
    record.push((match[1] ?? "").replaceAll('""', '"'));
    if (match[2] !== ",") {
      records.push(record);
      record = [];
    }
  }
  if (consumed !== csv.length || record.length > 0) throw new Error("Incomplete CSV record");
  const headers = records.shift();
  expect(headers).toEqual(columns);
  return records.map((values) => {
    expect(values).toHaveLength(columns.length);
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
  });
}

function csvTotals(csv: string): Record<string, string> {
  const sum = new Map<string, bigint>();
  for (const row of csvRows(csv)) {
    const value = z
      .object({
        network: z.string(),
        asset: z.string(),
        amount: z.string().regex(/^(0|[1-9][0-9]*)$/),
      })
      .parse(row);
    if (value.amount === "0") continue;
    const key = `${value.network}/${value.asset.toLowerCase()}`;
    sum.set(key, (sum.get(key) ?? 0n) + BigInt(value.amount));
  }
  return Object.fromEntries([...sum].map(([key, amount]) => [key, amount.toString()]));
}

function derivedTotals(events: PaymentEvent[]): Record<string, string> {
  return Object.fromEntries(
    totals(events).map((total) => [`${total.network}/${total.asset}`, total.amount]),
  );
}

describe("auditable exports", () => {
  test("CSV golden statement is stable, quoted, and uses CRLF record endings", () => {
    const csv = toCsv(sample());
    expect(csvRows(csv)).toHaveLength(5);
    expect(csv.endsWith("\r\n")).toBe(true);
    const separators = csv.replace(/"(?:[^"]|"")*"/g, "");
    expect(separators.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(csv).toMatchSnapshot();
  });

  test("CSV counted amounts exactly match derived totals without mixing assets", () => {
    const events = sample();
    const result = csvTotals(toCsv(events));
    expect(result).toEqual(derivedTotals(events));
    expect(Object.values(result).sort()).toEqual(["23", "900719925474099312345678901234567900"]);
    const rows = csvRows(toCsv(events));
    expect(rows.find((row) => row.status === "blocked")).toMatchObject({
      amount: "0",
      authorizedAmount: "900",
    });
    expect(rows.find((row) => row.settlementStatus === "failed")).toMatchObject({
      amount: "0",
      authorizedAmount: "5",
    });
  });

  test("CSV preserves comma, quote, and newline content without leaking raw authorizations", () => {
    const input = fixed(1, {
      taskId: 'task, "quoted"\r\nnext line',
      reason: 'a, b and "c"',
      raw: '{"signature":"DO-NOT-INCLUDE-RAW-SIGNATURE"}',
    });
    const csv = toCsv([input]);
    expect(csvRows(csv)[0]).toMatchObject({ taskId: input.taskId, reason: input.reason });
    expect(csv).not.toContain("DO-NOT-INCLUDE-RAW-SIGNATURE");
    expect(csv).not.toContain('"raw"');
  });

  test.each(["=SUM(A1:A9)", "+cmd", "-A1", "@SUM(A1)", "\t=1+1", "\r=1+1"])(
    "CSV neutralizes formula-prone text %j without modifying the original event",
    (label) => {
      const input = fixed(1, { taskId: label, agentId: label });
      const row = csvRows(toCsv([input]))[0];
      expect(row).toMatchObject({ taskId: `'${label}`, agentId: `'${label}`, amount: "7" });
      expect(input.taskId).toBe(label);
      expect(input.agentId).toBe(label);
    },
  );

  test("JSON contains validated derived events and exact integer-string totals", () => {
    const events = sample();
    const result = z
      .object({ events: z.array(paymentEventSchema), totals: z.array(totalSchema) })
      .parse(JSON.parse(toJson([...events, ...events])));
    expect(result.events).toEqual(deriveEvents(events));
    expect(result.totals).toEqual(totals(events));
    expect(result.totals.find((total) => total.network === "eip155:8453")?.amount).toBe(
      "900719925474099312345678901234567900",
    );
  });

  test("standalone HTML escapes untrusted ledger labels and omits raw authorizations", () => {
    const input = fixed(1, {
      taskId: '<script>alert("task")</script>',
      agentId: '<img src=x onerror="alert(1)">',
      reason: "unsafe <tag> & content",
      assetSymbol: '<svg onload="alert(1)">',
      raw: '{"signature":"DO-NOT-INCLUDE-RAW-SIGNATURE"}',
    });
    const html = toInvoice([input]);
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toMatch(/<html[\s>]/i);
    expect(html).toMatch(/<\/html>\s*$/i);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload=");
    expect(html).toContain("&lt;");
    expect(html).not.toContain("DO-NOT-INCLUDE-RAW-SIGNATURE");
  });

  test("invoice displays exact amounts with asset identities and labels uncertain settlement", () => {
    const html = toInvoice(sample());
    expect(html).toContain("900719925474099312345678901234.567900");
    expect(html).toContain("USDC");
    expect(html).toContain("eip155:8453");
    expect(html).toContain("eip155:1");
    expect(html).toContain("0x3333333333333333333333333333333333333333");
    expect(html).toMatch(/unknown|uncertain/i);
    expect(html).toMatch(/atomic units/i);
  });

  test("all export formats are deterministic under repeated event-log replay", () => {
    const events = sample();
    const before = JSON.stringify(events);
    const replay = [...events].reverse().concat(events.map((value) => ({ ...value })));
    for (const serialize of [toCsv, toJson, toInvoice]) {
      expect(serialize(events)).toBe(serialize(events));
      expect(serialize(replay)).toBe(serialize(events));
    }
    expect(JSON.stringify(events)).toBe(before);
  });

  test("empty exports provide valid CSV, JSON, and a readable statement", () => {
    expect(csvRows(toCsv([]))).toEqual([]);
    expect(JSON.parse(toJson([]))).toEqual({ events: [], totals: [] });
    expect(toInvoice([])).toMatch(/no payments|no spend|no events|empty/i);
  });

  test("CLI CSV file exports the same exact per-asset totals as its ledger", async () => {
    const prefix = join(tmpdir(), "taximeter-export-test-");
    const directory = mkdtempSync(prefix);
    if (!resolve(directory).startsWith(resolve(prefix))) throw new Error("Unsafe cleanup path");
    const db = join(directory, "ledger with spaces.db");
    const path = join(directory, "statement with spaces.csv");
    const ledger = new Ledger(db);
    let expected: Record<string, string>;
    try {
      for (const input of sample()) ledger.append(input);
      expected = derivedTotals(ledger.view());
    } finally {
      ledger.close();
    }
    try {
      const output: string[] = [];
      await runCli(["export", "--db", db, "--csv", path], (chunk) => output.push(chunk));
      expect(output.join("")).toContain(path);
      expect(csvTotals(readFileSync(path, "utf8"))).toEqual(expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
