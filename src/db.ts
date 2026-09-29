import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config, Element, Page, Quantization } from "./types.ts";

export interface CreateConfigInput {
  name: string;
  wavelength: number;
  elements: Element[];
  steerAngleDeg: number | null;
  quantization: Quantization | null;
  parentId: number | null;
  note: string | null;
}

export interface CreateOptions {
  idempotencyKey?: string | null;
  now?: string;
}

export interface ListOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  search?: string | undefined;
}

interface ConfigRow {
  id: number;
  idempotency_key: string | null;
  name: string;
  wavelength: number;
  elements: string;
  steer_angle_deg: number | null;
  quantization: string | null;
  parent_id: number | null;
  note: string | null;
  created_at: string;
  version: number;
}

function rowToConfig(r: ConfigRow): Config {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    name: r.name,
    wavelength: r.wavelength,
    elements: JSON.parse(r.elements) as Element[],
    steerAngleDeg: r.steer_angle_deg,
    quantization: r.quantization === null ? null : (JSON.parse(r.quantization) as Quantization),
    parentId: r.parent_id,
    note: r.note,
    createdAt: r.created_at,
    version: r.version,
  };
}

export class AppDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  }

  /**
   * Idempotent migrations. Guarded by user_version so repeated execution is a
   * no-op; safe to call on every startup.
   */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        name TEXT NOT NULL,
        wavelength REAL NOT NULL CHECK (wavelength > 0),
        elements TEXT NOT NULL,
        steer_angle_deg REAL,
        quantization TEXT,
        parent_id INTEGER REFERENCES configs(id),
        note TEXT,
        created_at TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_configs_parent ON configs(parent_id);
      CREATE INDEX IF NOT EXISTS idx_configs_name ON configs(name);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Create a config version. Idempotent: submitting the same non-null
   * idempotencyKey returns the previously stored row without creating a copy.
   */
  createConfig(input: CreateConfigInput, opts: CreateOptions = {}): Config {
    const now = opts.now ?? new Date().toISOString();
    if (opts.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM configs WHERE idempotency_key = ?")
        .get(opts.idempotencyKey) as ConfigRow | undefined;
      if (existing) return rowToConfig(existing);
    }
    const result = this.db
      .prepare(
        `INSERT INTO configs
          (idempotency_key, name, wavelength, elements, steer_angle_deg, quantization, parent_id, note, created_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT MAX(version) FROM configs), 0) + 1)`,
      )
      .run(
        opts.idempotencyKey ?? null,
        input.name,
        input.wavelength,
        JSON.stringify(input.elements),
        input.steerAngleDeg,
        input.quantization === null ? null : JSON.stringify(input.quantization),
        input.parentId,
        input.note,
        now,
      );
    return this.getConfig(Number(result.lastInsertRowid))!;
  }

  /**
   * Transactional multi-step write. On thrown error the transaction is rolled
   * back and the error propagates.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getConfig(id: number): Config | null {
    const row = this.db.prepare("SELECT * FROM configs WHERE id = ?").get(id) as ConfigRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  listConfigs(opts: ListOptions = {}): Page<Config> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = Math.max(0, opts.offset ?? 0);
    const search = opts.search?.trim();
    const where = search ? "WHERE name LIKE ?" : "";
    const params = search ? [`%${search.replace(/[%_]/g, (m) => "\\" + m)}%`] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM configs ${where}`).get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM configs ${where} ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as ConfigRow[];
    return { items: rows.map(rowToConfig), total, limit, offset };
  }

  /** Versions of one configuration lineage (root + descendants via parent_id). */
  lineage(rootId: number): Config[] {
    const rows: ConfigRow[] = [];
    const visit = (id: number): void => {
      const row = this.db.prepare("SELECT * FROM configs WHERE id = ?").get(id) as ConfigRow | undefined;
      if (!row) return;
      rows.push(row);
      const kids = this.db
        .prepare("SELECT id FROM configs WHERE parent_id = ? ORDER BY id ASC")
        .all(id) as { id: number }[];
      for (const kid of kids) visit(kid.id);
    };
    visit(rootId);
    return rows.map(rowToConfig);
  }

  countConfigs(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM configs").get() as { n: number }).n;
  }
}
