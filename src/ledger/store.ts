import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { v7 } from "uuid";
import { z } from "zod";
import migration from "../../migrations/001.sql";
import cacheMigration from "../../migrations/002.sql";
import countMigration from "../../migrations/003.sql";
import type { TaximeterConfig } from "../config";
import {
  type Diagnostic,
  diagnosticSchema,
  outcomeSchema,
  type PaymentEvent,
  paymentEventSchema,
} from "../model";
import type { PolicyState } from "../policy";
import { backupLedger } from "./backup";
import { LedgerCache } from "./cache";
import { deriveEvents } from "./derive";

const rowSchema = z.object({ payload: z.string() });
const countRowSchema = z.object({ count: z.number().int().nonnegative() });

/** Synchronous storage edge; money derivations remain pure in derive.ts. */
export class Ledger {
  private readonly database: Database.Database;
  private readonly cache: LedgerCache;

  constructor(input: string) {
    const path = z.string().min(1).parse(input);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    try {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      this.cache = this.database
        .transaction(() => {
          const table = this.database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
            )
            .get();
          if (!table) this.database.exec(migration);
          const version = z
            .object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]) })
            .parse(
              this.database.prepare("SELECT MAX(version) AS version FROM schema_version").get(),
            );
          if (version.version !== 3) {
            if (table && path !== ":memory:") {
              process.stderr.write("Migrating ledger…\n");
              const backup = backupLedger(path, version.version);
              process.stderr.write(`Ledger backup saved: ${backup}\n`);
            }
            if (version.version === 1) this.database.exec(cacheMigration);
            this.database.exec(countMigration);
          }
          const cache = new LedgerCache(this.database);
          if (version.version === 2) cache.rebuild();
          else cache.synchronize();
          return cache;
        })
        .immediate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  append(input: unknown): boolean {
    const event = paymentEventSchema.parse(input);
    return this.transaction(() => {
      const inserted =
        this.database
          .prepare(
            "INSERT OR IGNORE INTO events (id, ts, taskId, agentId, host, status, paymentKey, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            event.id,
            event.ts,
            event.taskId ?? null,
            event.agentId ?? null,
            event.host,
            event.status,
            event.paymentKey,
            JSON.stringify(event),
          ).changes > 0;
      this.cache.synchronize();
      return inserted;
    });
  }

  appendOutcome(input: unknown): boolean {
    const outcome = outcomeSchema.parse(input);
    return this.transaction(() => {
      const inserted =
        this.database
          .prepare(
            "INSERT OR IGNORE INTO outcomes (id, ts, paymentId, payload) VALUES (?, ?, ?, ?)",
          )
          .run(outcome.id, outcome.ts, outcome.paymentId, JSON.stringify(outcome)).changes > 0;
      this.cache.synchronize();
      return inserted;
    });
  }

  policyState(
    proposed: PaymentEvent,
    budgets: TaximeterConfig["budgets"],
    now: number,
  ): PolicyState {
    return this.transaction(() => {
      this.cache.synchronize();
      const totals = {
        perTask: budgets.perTask
          ? this.cache.totals(proposed, "perTask", budgets.perTask.window, now)
          : { amount: "0", count: "0" },
        perAgent: budgets.perAgent
          ? this.cache.totals(proposed, "perAgent", budgets.perAgent.window, now)
          : { amount: "0", count: "0" },
        global: budgets.global
          ? this.cache.totals(proposed, "global", budgets.global.window, now)
          : { amount: "0", count: "0" },
      };
      return {
        reserved: this.cache.reservation(proposed.paymentKey),
        spent: {
          perTask: totals.perTask.amount,
          perAgent: totals.perAgent.amount,
          global: totals.global.amount,
        },
        counts: {
          perTask: totals.perTask.count,
          perAgent: totals.perAgent.count,
          global: totals.global.count,
        },
      };
    });
  }

  /** Rebuild disposable projections without modifying the append-only audit log. */
  rebuildCache(): void {
    this.transaction(() => this.cache.rebuild());
  }

  eventCount(): number {
    return countRowSchema.parse(this.database.prepare("SELECT COUNT(*) AS count FROM events").get())
      .count;
  }

  events() {
    return this.database
      .prepare("SELECT payload FROM events ORDER BY ts, id")
      .all()
      .map((row) => paymentEventSchema.parse(JSON.parse(rowSchema.parse(row).payload)));
  }

  outcomes() {
    return this.database
      .prepare("SELECT payload FROM outcomes ORDER BY ts, id")
      .all()
      .map((row) => outcomeSchema.parse(JSON.parse(rowSchema.parse(row).payload)));
  }

  view() {
    return deriveEvents(this.events(), this.outcomes());
  }

  diagnose(code: Diagnostic["code"], resource: string, message: string): void {
    const diagnostic = diagnosticSchema.parse({
      id: v7(),
      ts: new Date().toISOString(),
      code,
      resource,
      message,
    });
    this.database
      .prepare("INSERT INTO diagnostics (id, ts, payload) VALUES (?, ?, ?)")
      .run(diagnostic.id, diagnostic.ts, JSON.stringify(diagnostic));
  }

  diagnostics() {
    return this.database
      .prepare("SELECT payload FROM diagnostics ORDER BY ts, id")
      .all()
      .map((row) => diagnosticSchema.parse(JSON.parse(rowSchema.parse(row).payload)));
  }

  close(): void {
    this.database.close();
  }
}
