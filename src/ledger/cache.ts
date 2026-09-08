import type Database from "better-sqlite3";
import { z } from "zod";
import {
  integerStringSchema,
  type Outcome,
  outcomeSchema,
  type PaymentEvent,
  paymentEventSchema,
} from "../model";
import { countsAsSpend } from "./derive";

const cursorSchema = z.object({
  eventRowid: z.number().int().nonnegative(),
  outcomeRowid: z.number().int().nonnegative(),
});
const sourceSchema = z.object({
  sourceRowid: z.number().int().positive(),
  id: z.string(),
  payload: z.string(),
});
const payloadSchema = z.object({ payload: z.string() });
const paymentRowSchema = z.object({
  payload: z.string(),
  originalPayload: z.string(),
  maxAttemptedAt: z.iso.datetime().nullable(),
});
const attemptRowSchema = z.object({
  firstTs: z.iso.datetime(),
  firstId: z.uuidv7(),
  winnerTs: z.iso.datetime(),
  winnerId: z.uuidv7(),
  status: z.enum(["unknown", "confirmed", "failed"]),
});
const prefixRowSchema = z.object({
  prefix: z.string().regex(/^[0-9a-f]{0,16}$/),
  amount: integerStringSchema,
});
const scopeSchema = z.enum(["perTask", "perAgent", "global"]);
const windowSchema = z.enum(["1h", "24h", "7d", "30d"]);
const timeSchema = z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000);
type Scope = z.infer<typeof scopeSchema>;
type Window = z.infer<typeof windowSchema>;
const windows: Readonly<Record<Window, number>> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};
const digits = "0123456789abcdef";
const bias = 1n << 63n;

function timeKey(milliseconds: number): string {
  const value = z.number().int().parse(milliseconds);
  const encoded = bias + BigInt(value);
  if (encoded < 0n || encoded >= 1n << 64n) throw new Error("Timestamp outside cache index range");
  return encoded.toString(16).padStart(16, "0");
}

function partition(payment: PaymentEvent, scope: Scope): string {
  const attribution =
    scope === "perTask" ? payment.taskId : scope === "perAgent" ? payment.agentId : null;
  return JSON.stringify([scope, attribution ?? null, payment.network, payment.asset.toLowerCase()]);
}

function order(left: { ts: string; id: string }, right: { ts: string; id: string }): number {
  return left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id);
}

/** Rebuildable indexes. Source events and outcomes remain the authoritative append-only log. */
export class LedgerCache {
  private readonly statements = new Map<string, Database.Statement>();

  constructor(private readonly database: Database.Database) {}

  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** The caller holds an immediate transaction throughout synchronization and budget gating. */
  synchronize(): void {
    const cursor = cursorSchema.parse(
      this.statement("SELECT eventRowid, outcomeRowid FROM cache_cursors WHERE id = 1").get(),
    );
    let eventRowid = cursor.eventRowid;
    let outcomeRowid = cursor.outcomeRowid;
    const eventQuery = this.statement(
      "SELECT rowid AS sourceRowid, id, payload FROM events WHERE rowid > ? ORDER BY rowid LIMIT 256",
    );
    for (
      let batch = eventQuery.all(eventRowid);
      batch.length > 0;
      batch = eventQuery.all(eventRowid)
    ) {
      for (const input of batch) {
        const row = sourceSchema.parse(input);
        const payment = paymentEventSchema.parse(JSON.parse(row.payload));
        if (payment.id !== row.id)
          throw new Error("Payment row identity does not match its payload");
        if (payment.status === "observed") {
          const derived = paymentEventSchema.parse({
            ...payment,
            settlement_unknown: payment.settlementStatus === "unknown",
          });
          const inserted = this.statement(
            "INSERT OR IGNORE INTO cache_payments (paymentId, paymentKey, payload, maxAttemptedAt) VALUES (?, ?, ?, NULL)",
          ).run(payment.id, payment.paymentKey, JSON.stringify(derived));
          if (inserted.changes > 0) this.changeContribution(undefined, derived);
        }
        eventRowid = row.sourceRowid;
      }
    }
    const outcomeQuery = this.statement(
      "SELECT rowid AS sourceRowid, id, payload FROM outcomes WHERE rowid > ? ORDER BY rowid LIMIT 256",
    );
    for (
      let batch = outcomeQuery.all(outcomeRowid);
      batch.length > 0;
      batch = outcomeQuery.all(outcomeRowid)
    ) {
      for (const input of batch) {
        const row = sourceSchema.parse(input);
        const outcome = outcomeSchema.parse(JSON.parse(row.payload));
        if (outcome.id !== row.id)
          throw new Error("Outcome row identity does not match its payload");
        this.applyOutcome(outcome);
        outcomeRowid = row.sourceRowid;
      }
    }
    if (eventRowid !== cursor.eventRowid || outcomeRowid !== cursor.outcomeRowid) {
      this.statement("UPDATE cache_cursors SET eventRowid = ?, outcomeRowid = ? WHERE id = 1").run(
        eventRowid,
        outcomeRowid,
      );
    }
  }

  rebuild(): void {
    this.database.exec(
      "DELETE FROM cache_prefix; DELETE FROM cache_attempts; DELETE FROM cache_payments; UPDATE cache_cursors SET eventRowid = 0, outcomeRowid = 0 WHERE id = 1",
    );
    this.synchronize();
  }

  reservation(paymentKey: string): PaymentEvent | undefined {
    const key = z.string().min(1).parse(paymentKey);
    const row = payloadSchema
      .optional()
      .parse(this.statement("SELECT payload FROM cache_payments WHERE paymentKey = ?").get(key));
    return row ? paymentEventSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  spent(
    proposed: PaymentEvent,
    inputScope: Scope,
    inputWindow: Window | undefined,
    now: number,
  ): string {
    const payment = paymentEventSchema.parse(proposed);
    const scope = scopeSchema.parse(inputScope);
    const window = windowSchema.optional().parse(inputWindow);
    const end = timeSchema.parse(now);
    const key = partition(payment, scope);
    const upper = this.prefixTotal(key, end);
    const lower = window ? this.prefixTotal(key, end - windows[window] - 1) : 0n;
    const result = upper - lower;
    if (result < 0n) throw new Error("Cached budget total is inconsistent");
    return result.toString();
  }

  private applyOutcome(outcome: Outcome): void {
    const row = paymentRowSchema
      .optional()
      .parse(
        this.statement(
          "SELECT c.payload, c.maxAttemptedAt, e.payload AS originalPayload FROM cache_payments c JOIN events e ON e.id = c.paymentId WHERE c.paymentId = ?",
        ).get(outcome.paymentId),
      );
    // Blocked events never contribute to budgets or become reusable reservations.
    if (!row) return;
    const previous = paymentEventSchema.parse(JSON.parse(row.payload));
    const original = paymentEventSchema.parse(JSON.parse(row.originalPayload));
    const attemptId = outcome.attemptId ?? outcome.paymentId;
    const attempt = attemptRowSchema
      .optional()
      .parse(
        this.statement(
          "SELECT firstTs, firstId, winnerTs, winnerId, status FROM cache_attempts WHERE paymentId = ? AND attemptId = ?",
        ).get(outcome.paymentId, attemptId),
      );
    if (!attempt) {
      this.statement(
        "INSERT INTO cache_attempts (paymentId, attemptId, firstTs, firstId, winnerTs, winnerId, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        outcome.paymentId,
        attemptId,
        outcome.ts,
        outcome.id,
        outcome.ts,
        outcome.id,
        outcome.status,
        JSON.stringify(outcome),
      );
    } else {
      if (order(outcome, { ts: attempt.firstTs, id: attempt.firstId }) < 0) {
        this.statement(
          "UPDATE cache_attempts SET firstTs = ?, firstId = ? WHERE paymentId = ? AND attemptId = ?",
        ).run(outcome.ts, outcome.id, outcome.paymentId, attemptId);
      }
      const newer = order(outcome, { ts: attempt.winnerTs, id: attempt.winnerId }) > 0;
      const wins =
        attempt.status === "confirmed"
          ? outcome.status === "confirmed" && newer
          : outcome.status === "confirmed" || newer;
      if (wins) {
        this.statement(
          "UPDATE cache_attempts SET winnerTs = ?, winnerId = ?, status = ?, payload = ? WHERE paymentId = ? AND attemptId = ?",
        ).run(
          outcome.ts,
          outcome.id,
          outcome.status,
          JSON.stringify(outcome),
          outcome.paymentId,
          attemptId,
        );
      }
    }
    const maxAttemptedAt =
      outcome.attemptedAt && (!row.maxAttemptedAt || outcome.attemptedAt > row.maxAttemptedAt)
        ? outcome.attemptedAt
        : row.maxAttemptedAt;
    const selected = this.selectedOutcome(outcome.paymentId);
    const status =
      original.settlementStatus === "confirmed"
        ? "confirmed"
        : (selected?.status ?? original.settlementStatus);
    const current = paymentEventSchema.parse({
      ...original,
      ...(maxAttemptedAt ? { attemptedAt: maxAttemptedAt } : {}),
      settlementStatus: status,
      settlement_unknown: status === "unknown",
      ...(selected?.txHash ? { txHash: selected.txHash } : {}),
    });
    this.changeContribution(previous, current);
    this.statement(
      "UPDATE cache_payments SET payload = ?, maxAttemptedAt = ? WHERE paymentId = ?",
    ).run(JSON.stringify(current), maxAttemptedAt, outcome.paymentId);
  }

  private selectedOutcome(paymentId: string): Outcome | undefined {
    for (const status of ["confirmed", "unknown"] as const) {
      const row = payloadSchema
        .optional()
        .parse(
          this.statement(
            "SELECT payload FROM cache_attempts WHERE paymentId = ? AND status = ? ORDER BY firstTs, firstId COLLATE NOCASE, firstId DESC LIMIT 1",
          ).get(paymentId, status),
        );
      if (row) return outcomeSchema.parse(JSON.parse(row.payload));
    }
    const row = payloadSchema
      .optional()
      .parse(
        this.statement(
          "SELECT payload FROM cache_attempts WHERE paymentId = ? AND status = 'failed' ORDER BY firstTs DESC, firstId COLLATE NOCASE DESC, firstId ASC LIMIT 1",
        ).get(paymentId),
      );
    return row ? outcomeSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  private changeContribution(previous: PaymentEvent | undefined, current: PaymentEvent): void {
    const changes = new Map<string, Map<string, bigint>>();
    const add = (payment: PaymentEvent, sign: bigint) => {
      if (!countsAsSpend(payment)) return;
      const amount = BigInt(payment.amount) * sign;
      if (amount === 0n) return;
      const timestamp = timeKey(Date.parse(payment.attemptedAt ?? payment.ts));
      for (const scope of ["perTask", "perAgent", "global"] as const) {
        const key = partition(payment, scope);
        const nodes = changes.get(key) ?? new Map<string, bigint>();
        for (let length = 0; length <= timestamp.length; length += 1) {
          const prefix = timestamp.slice(0, length);
          nodes.set(prefix, (nodes.get(prefix) ?? 0n) + amount);
        }
        changes.set(key, nodes);
      }
    };
    if (previous) add(previous, -1n);
    add(current, 1n);
    for (const [key, nodes] of changes) {
      const pending = [...nodes].filter(([, amount]) => amount !== 0n);
      if (pending.length === 0) continue;
      const existing = new Map<string, bigint>();
      for (const input of this.statement(
        "SELECT prefix, amount FROM cache_prefix WHERE partitionKey = ? AND prefix IN (SELECT value FROM json_each(?))",
      ).iterate(key, JSON.stringify(pending.map(([prefix]) => prefix)))) {
        const row = prefixRowSchema.parse(input);
        existing.set(row.prefix, BigInt(row.amount));
      }
      for (const [prefix, delta] of pending) {
        const next = (existing.get(prefix) ?? 0n) + delta;
        if (next < 0n) throw new Error("Cached monetary contribution underflow");
        if (next === 0n) {
          this.statement("DELETE FROM cache_prefix WHERE partitionKey = ? AND prefix = ?").run(
            key,
            prefix,
          );
        } else {
          this.statement(
            "INSERT INTO cache_prefix (partitionKey, prefix, amount) VALUES (?, ?, ?) ON CONFLICT(partitionKey, prefix) DO UPDATE SET amount = excluded.amount",
          ).run(key, prefix, next.toString());
        }
      }
    }
  }

  private prefixTotal(key: string, time: number): bigint {
    const timestamp = timeKey(time);
    const prefixes: string[] = [];
    for (let index = 0; index < timestamp.length; index += 1) {
      const digit = timestamp[index];
      if (digit === undefined) throw new Error("Missing timestamp digit");
      const limit = digits.indexOf(digit);
      for (let child = 0; child < limit; child += 1) {
        prefixes.push(`${timestamp.slice(0, index)}${digits[child]}`);
      }
    }
    prefixes.push(timestamp);
    let sum = 0n;
    for (const input of this.statement(
      "SELECT prefix, amount FROM cache_prefix WHERE partitionKey = ? AND prefix IN (SELECT value FROM json_each(?))",
    ).iterate(key, JSON.stringify(prefixes))) {
      sum += BigInt(prefixRowSchema.parse(input).amount);
    }
    return sum;
  }
}
