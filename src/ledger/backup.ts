import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

/** Call while the source holds BEGIN IMMEDIATE, before any migration writes. */
export function backupLedger(path: string): string {
  const directory = mkdtempSync(`${resolve(path)}.backup-v1-`);
  const partial = join(directory, "ledger.partial.db");
  const destination = join(directory, "ledger.db");
  writeFileSync(partial, "", { flag: "wx", mode: 0o600 });

  // A separate reader can include committed WAL pages while the source's writer
  // lock keeps the snapshot stable until migration commits. VACUUM INTO streams
  // a standalone database; serializing the source would require its size in RAM.
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  try {
    reader.pragma("synchronous = FULL");
    reader.prepare("VACUUM INTO ?").run(partial);
  } finally {
    reader.close();
  }
  // SQLite syncs the completed output before returning. Interrupted/failed
  // copies retain the partial name and can never replace an earlier backup.
  renameSync(partial, destination);
  return destination;
}
