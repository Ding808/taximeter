import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/program";
import * as backup from "../src/ledger/backup";
import { LedgerCache } from "../src/ledger/cache";
import { totalSchema } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { diagnosticSchema, outcomeSchema, type PaymentEvent } from "../src/model";
import { event } from "./helpers";

const temporaryParent = realpathSync(tmpdir());
const directories: string[] = [];
const connections = new Set<Database.Database>();
const ledgers = new Set<Ledger>();
const stderr: string[] = [];
const stdout: string[] = [];
const outputSchema = z.union([z.string(), z.instanceof(Uint8Array)]);
const sqlRowsSchema = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])));

function outputText(input: unknown): string {
  const parsed = outputSchema.parse(input);
  return typeof parsed === "string" ? parsed : Buffer.from(parsed).toString("utf8");
}

beforeEach(() => {
  stderr.length = 0;
  stdout.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(outputText(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(outputText(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const ledger of ledgers) ledger.close();
  ledgers.clear();
  for (const connection of connections) connection.close();
  connections.clear();
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory);
    expect(isAbsolute(target) && target === directory && dirname(target) === temporaryParent).toBe(
      true,
    );
    expect(basename(target).startsWith("taximeter-migration-test-")).toBe(true);
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function workspace() {
  const directory = realpathSync(mkdtempSync(join(temporaryParent, "taximeter-migration-test-")));
  directories.push(directory);
  return { directory, path: join(directory, "ledger with spaces.db") };
}

function open(path: string): Ledger {
  const ledger = new Ledger(path);
  ledgers.add(ledger);
  return ledger;
}

function close(ledger: Ledger): void {
  ledger.close();
  ledgers.delete(ledger);
}

function legacy(path: string): Database.Database {
  const connection = new Database(path);
  connections.add(connection);
  connection.pragma("journal_mode = WAL");
  connection.pragma("wal_autocheckpoint = 0");
  connection.pragma("foreign_keys = ON");
  connection.exec(readFileSync(new URL("../migrations/001.sql", import.meta.url), "utf8"));
  connection.pragma("wal_checkpoint(TRUNCATE)");
  return connection;
}

function appendRaw(connection: Database.Database, value: PaymentEvent, raw: unknown = value): void {
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
      JSON.stringify(raw),
    );
}

function seed(connection: Database.Database): PaymentEvent {
  const value = event({ amount: "900719925474099312345678901234567890" });
  const outcome = outcomeSchema.parse({
    id: "01900000-0000-7000-8000-000000000101",
    ts: value.ts,
    paymentId: value.id,
    status: "confirmed",
    txHash: "synthetic-committed-wal-settlement",
  });
  const diagnostic = diagnosticSchema.parse({
    id: "01900000-0000-7000-8000-000000000102",
    ts: value.ts,
    code: "parse_failed",
    resource: "https://fixture.example.test/unknown",
    message: "Committed WAL diagnostic",
  });
  connection
    .transaction(() => {
      appendRaw(connection, value);
      connection
        .prepare("INSERT INTO outcomes (id, ts, paymentId, payload) VALUES (?, ?, ?, ?)")
        .run(outcome.id, outcome.ts, outcome.paymentId, JSON.stringify(outcome));
      connection
        .prepare("INSERT INTO diagnostics (id, ts, payload) VALUES (?, ?, ?)")
        .run(diagnostic.id, diagnostic.ts, JSON.stringify(diagnostic));
    })
    .immediate();
  return value;
}

function snapshot(connection: Database.Database) {
  return {
    schema: sqlRowsSchema.parse(
      connection.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
    ),
    version: z
      .object({ version: z.number().int() })
      .parse(connection.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .version,
    events: sqlRowsSchema.parse(connection.prepare("SELECT * FROM events ORDER BY id").all()),
    outcomes: sqlRowsSchema.parse(connection.prepare("SELECT * FROM outcomes ORDER BY id").all()),
    diagnostics: sqlRowsSchema.parse(
      connection.prepare("SELECT * FROM diagnostics ORDER BY id").all(),
    ),
  };
}

function backupDirectories(path: string): string[] {
  return readdirSync(dirname(path), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${basename(path)}.backup-v1-`))
    .map((entry) => join(dirname(path), entry.name));
}

function finalBackups(path: string): string[] {
  return backupDirectories(path)
    .map((directory) => join(directory, "ledger.db"))
    .filter(existsSync);
}

function inspectBackup(path: string) {
  expect(existsSync(path)).toBe(true);
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
  const connection = new Database(path, { readonly: true, fileMustExist: true });
  try {
    expect(connection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    return snapshot(connection);
  } finally {
    connection.close();
  }
}

describe("schema upgrade notice and pre-upgrade backup", () => {
  test("notice appears on stderr before backup or cache migration starts", () => {
    const { path } = workspace();
    const source = legacy(path);
    seed(source);
    const originalBackup = backup.backupLedger;
    let beforeBackup: { notice: string; version: number; directories: number } | undefined;
    vi.spyOn(backup, "backupLedger").mockImplementation((input) => {
      beforeBackup = {
        notice: stderr.join(""),
        version: snapshot(source).version,
        directories: backupDirectories(path).length,
      };
      return originalBackup(input);
    });
    const originalSynchronize = LedgerCache.prototype.synchronize;
    let beforeBackfill: { notice: string; backups: number } | undefined;
    vi.spyOn(LedgerCache.prototype, "synchronize").mockImplementation(function (this: LedgerCache) {
      beforeBackfill = { notice: stderr.join(""), backups: finalBackups(path).length };
      return originalSynchronize.call(this);
    });
    open(path);
    expect(beforeBackup).toEqual({ notice: "Migrating ledger…\n", version: 1, directories: 0 });
    expect(beforeBackfill?.backups).toBe(1);
    expect(beforeBackfill?.notice).toContain("Ledger backup saved:");
    expect(beforeBackfill?.notice).toContain(finalBackups(path)[0]);
    expect(stdout).toEqual([]);
  });

  test("standalone v1 backup includes committed events, outcomes, and diagnostics still in the source WAL", () => {
    const { path, directory } = workspace();
    const source = legacy(path);
    const value = seed(source);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
    const expected = snapshot(source);
    const mainOnly = join(directory, "main-file-without-wal.db");
    copyFileSync(path, mainOnly);
    const main = new Database(mainOnly, { readonly: true, fileMustExist: true });
    try {
      expect(main.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    } finally {
      main.close();
    }
    const ledger = open(path);
    const backups = finalBackups(path);
    expect(backups).toHaveLength(1);
    const saved = z.string().parse(backups[0]);
    expect(inspectBackup(saved)).toEqual(expected);
    expect(readdirSync(dirname(saved))).toEqual(["ledger.db"]);
    expect(snapshot(source).version).toBe(2);
    expect(ledger.events()).toEqual([value]);
    expect(ledger.view()[0]).toMatchObject({
      settlementStatus: "confirmed",
      txHash: "synthetic-committed-wal-settlement",
    });
    expect(ledger.diagnostics()[0]?.message).toBe("Committed WAL diagnostic");
    if (process.platform !== "win32") expect(statSync(saved).mode & 0o777).toBe(0o600);
  });

  test("migration excludes another writer before the backup snapshot is taken", () => {
    const { path } = workspace();
    const source = legacy(path);
    const original = seed(source);
    source.pragma("busy_timeout = 1");
    const before = snapshot(source);
    const raced = event({ amount: "11" });
    const originalBackup = backup.backupLedger;
    let writerFailure: string | undefined;
    vi.spyOn(backup, "backupLedger").mockImplementation((input) => {
      try {
        appendRaw(source, raced);
      } catch (error) {
        writerFailure = z.object({ code: z.string() }).parse(error).code;
      }
      expect(writerFailure).toBe("SQLITE_BUSY");
      return originalBackup(input);
    });
    const migrated = open(path);
    expect(writerFailure).toBe("SQLITE_BUSY");
    expect(migrated.events()).toEqual([original]);
    expect(migrated.view()[0]).toMatchObject({
      id: original.id,
      amount: original.amount,
      settlementStatus: "confirmed",
    });
    expect(migrated.events().some((value) => value.id === raced.id)).toBe(false);
    expect(inspectBackup(z.string().parse(finalBackups(path)[0]))).toEqual(before);
  });

  test("fresh disk and in-memory ledgers start without migration notices or backups", () => {
    const { path } = workspace();
    const backupSpy = vi.spyOn(backup, "backupLedger");
    const disk = open(path);
    const memory = open(":memory:");
    expect(disk.events()).toEqual([]);
    expect(memory.events()).toEqual([]);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(backupDirectories(path)).toEqual([]);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([]);
  });

  test("reopening an already migrated ledger does not repeat its backup or notice", () => {
    const { path } = workspace();
    const source = legacy(path);
    seed(source);
    const migrated = open(path);
    const saved = finalBackups(path);
    expect(saved).toHaveLength(1);
    close(migrated);
    stderr.length = 0;
    stdout.length = 0;
    const backupSpy = vi.spyOn(backup, "backupLedger");
    const reopened = open(path);
    expect(reopened.events()).toHaveLength(1);
    expect(finalBackups(path)).toEqual(saved);
    expect(backupSpy).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([]);
  });

  test("failed backfill rolls schema changes back and retains a valid pre-upgrade backup", () => {
    const { path } = workspace();
    const source = legacy(path);
    seed(source);
    const invalid = event();
    appendRaw(source, invalid, { ...invalid, amount: "1.5" });
    const before = snapshot(source);
    expect(() => new Ledger(path)).toThrow();
    expect(snapshot(source)).toEqual(before);
    const saved = finalBackups(path);
    expect(saved).toHaveLength(1);
    expect(inspectBackup(z.string().parse(saved[0]))).toEqual(before);
    expect(stderr.join("")).toContain("Ledger backup saved:");
    expect(stdout).toEqual([]);
  });

  test("repeated failed upgrades create distinct backups and never overwrite earlier copies", () => {
    const { path } = workspace();
    const source = legacy(path);
    const invalid = event();
    appendRaw(source, invalid, { ...invalid, amount: "1.5" });
    const before = snapshot(source);
    expect(() => new Ledger(path)).toThrow();
    const first = z.string().parse(finalBackups(path)[0]);
    const firstContents = readFileSync(first);
    expect(() => new Ledger(path)).toThrow();
    const saved = finalBackups(path);
    expect(saved).toHaveLength(2);
    expect(new Set(saved).size).toBe(2);
    expect(readFileSync(first).equals(firstContents)).toBe(true);
    for (const file of saved) expect(inspectBackup(file)).toEqual(before);
    expect(snapshot(source)).toEqual(before);
  });

  test("backup failure aborts the upgrade before any cache or schema changes", () => {
    const { path } = workspace();
    const source = legacy(path);
    seed(source);
    const before = snapshot(source);
    const failure = vi.spyOn(backup, "backupLedger").mockImplementation(() => {
      throw new Error("Simulated backup storage failure");
    });
    const backfill = vi.spyOn(LedgerCache.prototype, "synchronize");
    expect(() => new Ledger(path)).toThrow("Simulated backup storage failure");
    expect(failure).toHaveBeenCalledTimes(1);
    expect(backfill).not.toHaveBeenCalled();
    expect(snapshot(source)).toEqual(before);
    expect(backupDirectories(path)).toEqual([]);
    expect(stderr.join("")).toBe("Migrating ledger…\n");
    expect(stdout).toEqual([]);
  });

  test("a failed SQLite copy leaves only a marked partial and closes its reader", () => {
    const { path } = workspace();
    const source = legacy(path);
    seed(source);
    const before = snapshot(source);
    const originalPrepare = Database.prototype.prepare;
    let backupReader: Database.Database | undefined;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (sql === "VACUUM INTO ?") {
        backupReader = this;
        throw new Error("Simulated SQLite copy failure");
      }
      return originalPrepare.call(this, sql);
    });
    expect(() => new Ledger(path)).toThrow("Simulated SQLite copy failure");
    expect(backupReader).toBeDefined();
    expect(backupReader?.open).toBe(false);
    const destinations = backupDirectories(path);
    expect(destinations).toHaveLength(1);
    expect(readdirSync(z.string().parse(destinations[0]))).toEqual(["ledger.partial.db"]);
    expect(finalBackups(path)).toEqual([]);
    expect(snapshot(source)).toEqual(before);
    expect(stderr.join("")).not.toContain("Ledger backup saved:");
    expect(stdout).toEqual([]);
  });

  test("a JSON report remains valid while its migration notice and backup path use stderr", async () => {
    const { path } = workspace();
    const source = legacy(path);
    const value = seed(source);
    await runCli(["report", "--db", path, "--json"]);
    const report = z.array(totalSchema).parse(JSON.parse(stdout.join("")));
    expect(report).toHaveLength(1);
    expect(report[0]?.amount).toBe(value.amount);
    expect(stderr.join("")).toContain("Migrating ledger…\n");
    expect(stderr.join("")).toContain("Ledger backup saved:");
    expect(stdout.join("")).not.toContain("Migrating ledger");
  });
});
