import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.ts";
import { ConfigRepository } from "../src/db/repo.ts";
import { AppError } from "../src/core/errors.ts";
import { buildElements } from "../src/core/validation.ts";
import { uniformPositions } from "../src/core/array.ts";
import { analyzePattern } from "../src/core/pattern.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  dir = mkdtempSync(join(resolve(".tmp"), "array-db-"));
  dbPath = join(dir, "test.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function elements(count: number, d = 0.05) {
  return buildElements(uniformPositions(count, d));
}

function baseInput(overrides: Partial<Parameters<ConfigRepository["create"]>[0]> = {}) {
  const els = elements(4);
  return {
    name: "t",
    wavelength: 0.1,
    elements: els,
    weights: els.map((_, i) => ({ index: i, re: 1, im: 0 })),
    steer_angle_deg: 0,
    ...overrides,
  };
}

test("repeated submissions with the same idempotency key return the same row", () => {
  const db = openDatabase(dbPath);
  const repo = new ConfigRepository(db);
  const a = repo.create(baseInput({ idempotency_key: "k-1" }));
  const b = repo.create(baseInput({ idempotency_key: "k-1" }));
  assert.equal(a.id, b.id);
  assert.equal(repo.list(100, 0).total, 1);
  db.close();
});

test("reusing an idempotency key with another payload is a 409 conflict", () => {
  const db = openDatabase(dbPath);
  const repo = new ConfigRepository(db);
  repo.create(baseInput({ idempotency_key: "k-2", name: "first" }));
  assert.throws(
    () => repo.create(baseInput({ idempotency_key: "k-2", name: "second" })),
    (err: unknown) => err instanceof AppError && err.code === "IDEMPOTENCY_MISMATCH",
  );
  db.close();
});

test("child versions increment from the parent and keep the baseline immutable", () => {
  const db = openDatabase(dbPath);
  const repo = new ConfigRepository(db);
  const root = repo.create(baseInput());
  const child = repo.create(baseInput({ parent_config_id: root.id, steer_angle_deg: 10 }));
  const grand = repo.create(baseInput({ parent_config_id: child.id, steer_angle_deg: 20 }));
  assert.equal(root.version, 1);
  assert.equal(child.version, 2);
  assert.equal(grand.version, 3);
  assert.equal(repo.getById(root.id).steer_angle_deg, 0);
  db.close();
});

test("transaction rolls back when the callback throws", () => {
  const db = openDatabase(dbPath);
  assert.throws(() =>
    withTransaction(db, () => {
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (999, 'x')").run();
      throw new Error("boom");
    }),
  );
  const rows = db.prepare("SELECT id FROM schema_migrations WHERE id = 999").all();
  assert.equal(rows.length, 0);
  db.close();
});

test("failed insert inside repo.create leaves no partial config", () => {
  const db = openDatabase(dbPath);
  const repo = new ConfigRepository(db);
  const totalBefore = repo.list(100, 0).total;
  assert.throws(() =>
    repo.create(
      // Invalid wavelength trips the CHECK constraint after idempotency lookup.
      baseInput({ wavelength: -1 }),
    ),
  );
  assert.equal(repo.list(100, 0).total, totalBefore);
  db.close();
});

test("state persists across a close/reopen cycle and migration is repeatable", () => {
  const db1 = openDatabase(dbPath);
  const repo1 = new ConfigRepository(db1);
  const cfg = repo1.create(baseInput({ idempotency_key: "persist" }));
  const els = cfg.elements;
  const report = analyzePattern(
    els,
    cfg.weights,
    cfg.wavelength,
    { start_deg: -90, stop_deg: 90, step_deg: 1 },
    0,
  );
  repo1.saveReport(cfg.id, { start_deg: -90, stop_deg: 90, step_deg: 1 }, report, "r-1");
  db1.close();

  const db2 = openDatabase(dbPath); // migrations re-run harmlessly
  const repo2 = new ConfigRepository(db2);
  const reloaded = repo2.getById(cfg.id);
  assert.equal(reloaded.name, "t");
  assert.equal(reloaded.idempotency_key, "persist");
  assert.equal(reloaded.elements.length, 4);
  const stored = repo2.findReport(cfg.id, "r-1");
  assert.ok(stored);
  assert.equal(stored!.report.sample_count, report.sample_count);
  db2.close();

  const db3 = openDatabase(dbPath); // third open: migrations still safe
  db3.close();
});

test("injected clock controls timestamps deterministically", () => {
  const fixed = new Date("2030-01-02T03:04:05.000Z");
  const db = openDatabase(dbPath, () => fixed);
  const repo = new ConfigRepository(db, () => fixed);
  const cfg = repo.create(baseInput());
  assert.equal(cfg.created_at, fixed.toISOString());
  db.close();
});
