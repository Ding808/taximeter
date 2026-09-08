import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { v7 } from "uuid";
import { z } from "zod";
import migration from "../../migrations/001.sql";
import { type Diagnostic, diagnosticSchema, outcomeSchema, paymentEventSchema } from "../model";
import { deriveEvents } from "./derive";

const rowSchema = z.object({ payload: z.string() });

/** Synchronous storage edge; money derivations remain pure in derive.ts. */
export class Ledger {
  private readonly database: Database.Database;

  constructor(input: string) {
    const path = z.string().min(1).parse(input);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    try {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      this.database
        .transaction(() => {
          const table = this.database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
            )
            .get();
          if (!table) this.database.exec(migration);
          const version = z
            .object({ version: z.literal(1) })
            .parse(
              this.database.prepare("SELECT MAX(version) AS version FROM schema_version").get(),
            );
          return version.version;
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
    return (
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
        ).changes > 0
    );
  }

  appendOutcome(input: unknown): boolean {
    const outcome = outcomeSchema.parse(input);
    return (
      this.database
        .prepare("INSERT OR IGNORE INTO outcomes (id, ts, paymentId, payload) VALUES (?, ?, ?, ?)")
        .run(outcome.id, outcome.ts, outcome.paymentId, JSON.stringify(outcome)).changes > 0
    );
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
