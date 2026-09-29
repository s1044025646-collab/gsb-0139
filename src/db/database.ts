import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.ts";

export type Db = DatabaseSync;

export type Clock = () => Date;

/**
 * Open the database and run every not-yet-applied migration inside one transaction.
 * Migrations are idempotent (IF NOT EXISTS) and tracked in schema_migrations, so
 * repeated startup calls and restarts are safe.
 */
export function openDatabase(path: string, clock: Clock = () => new Date()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, clock);
  return db;
}

export function migrate(db: Db, clock: Clock): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const apply = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      apply.run(m.id, clock().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Run a unit of work in a transaction with full rollback on any thrown error. */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
