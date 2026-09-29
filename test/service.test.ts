import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/db.ts";
import { ArrayService } from "../src/service.ts";
import { defaultGrid } from "../src/core/grid.ts";
import { uniformPositions } from "./fixtures.ts";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "array-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function pathFor(name: string): string {
  return join(dir, `${name}.sqlite`);
}

test("migrations are repeatable and safe on an existing db", () => {
  const p = pathFor("migrate");
  const db1 = new AppDatabase(p);
  db1.migrate();
  db1.migrate();
  db1.close();
  const db2 = new AppDatabase(p);
  db2.migrate(); // restart + re-migrate
  assert.equal(db2.countConfigs(), 0);
  db2.close();
});

test("idempotent create: same key submitted twice returns the same row", () => {
  const db = new AppDatabase(pathFor("idem"));
  db.migrate();
  const svc = new ArrayService(db);
  const input = { name: "a", wavelength: 1, positions: uniformPositions(4, 0.5) };
  const a = svc.createArray(input, { idempotencyKey: "k-1" });
  const b = svc.createArray(input, { idempotencyKey: "k-1" });
  assert.equal(a.id, b.id);
  assert.equal(db.countConfigs(), 1);
  db.close();
});

test("transaction rolls back on thrown error", () => {
  const db = new AppDatabase(pathFor("rollback"));
  db.migrate();
  const svc = new ArrayService(db);
  const before = db.countConfigs();
  assert.throws(() =>
    db.transaction(() => {
      svc.createArray({ name: "ok", wavelength: 1, positions: [0, 0.5] });
      throw new Error("boom");
    }),
  );
  assert.equal(db.countConfigs(), before);
  db.close();
});

test("persistence across restart", () => {
  const p = pathFor("persist");
  const db1 = new AppDatabase(p);
  db1.migrate();
  const svc1 = new ArrayService(db1);
  const cfg = svc1.createArray(
    { name: "persisted", wavelength: 0.3, positions: uniformPositions(6, 0.15), steerAngleDeg: 10 },
    { now: "2026-01-01T00:00:00.000Z" },
  );
  const steered = svc1.steer(cfg.id, 20, { now: "2026-01-02T00:00:00.000Z" });
  db1.close();

  assert.ok(existsSync(p));
  const db2 = new AppDatabase(p);
  db2.migrate();
  const loaded = db2.getConfig(steered.id)!;
  assert.equal(loaded.name, "persisted");
  assert.equal(loaded.parentId, cfg.id);
  assert.equal(loaded.steerAngleDeg, 20);
  assert.equal(loaded.createdAt, "2026-01-02T00:00:00.000Z");
  // version reproduction: scanning the stored version gives identical report
  const svc2 = new ArrayService(db2);
  const r1 = svc2.scan(steered.id, defaultGrid(0.1), { now: "x" });
  const r2 = svc2.scan(steered.id, defaultGrid(0.1), { now: "y" });
  assert.deepEqual(r1.samples, r2.samples);
  assert.equal(db2.lineage(cfg.id).length, 2);
  db2.close();
});

test("disable element creates new version and does NOT rewrite baseline weights", () => {
  const db = new AppDatabase(pathFor("disable"));
  db.migrate();
  const svc = new ArrayService(db);
  const base = svc.createArray({ name: "d", wavelength: 1, positions: uniformPositions(4, 0.5) });
  const snapshot = JSON.stringify(base.elements);
  const v2 = svc.disable(base.id, 2);
  const baseReloaded = db.getConfig(base.id)!;
  assert.equal(JSON.stringify(baseReloaded.elements), snapshot);
  assert.equal(v2.parentId, base.id);
  assert.equal(v2.elements[2]!.enabled, false);
  assert.deepEqual(v2.elements[2]!.weight, { re: 0, im: 0 });
  // other weights untouched
  for (const i of [0, 1, 3]) {
    assert.deepEqual(v2.elements[i]!.weight, base.elements[i]!.weight);
    assert.equal(v2.elements[i]!.enabled, true);
  }
  db.close();
});

test("quantization produces measurable pattern error vs the unquantized version", () => {
  const db = new AppDatabase(pathFor("quant"));
  db.migrate();
  const svc = new ArrayService(db);
  const positions = uniformPositions(16, 0.5);
  const base = svc.createArray({ name: "q", wavelength: 1, positions, steerAngleDeg: 18 });
  const coarse = svc.quantize(base.id, { amplitudeLevels: null, phaseStates: 2 });
  const cmp = svc.compare(base.id, coarse.id, defaultGrid(0.05));
  assert.ok(cmp.maxAbsPowerDifference > 1e-4, "1-bit phase quantization must perturb the pattern");
  assert.ok(cmp.maxAbsPowerDbDifference! > 0.5);
  const fine = svc.quantize(base.id, { amplitudeLevels: 16, phaseStates: 64 });
  const cmpFine = svc.compare(base.id, fine.id, defaultGrid(0.05));
  assert.ok(
    cmpFine.maxAbsPowerDifference < cmp.maxAbsPowerDifference,
    "fine quantization error must be smaller than coarse",
  );
  db.close();
});

test("pagination + search", () => {
  const db = new AppDatabase(pathFor("page"));
  db.migrate();
  const svc = new ArrayService(db);
  for (let i = 0; i < 5; i++) {
    svc.createArray({ name: `ula-${i}`, wavelength: 1, positions: [0, 0.5] });
  }
  svc.createArray({ name: "other", wavelength: 1, positions: [0] });
  const p1 = db.listConfigs({ limit: 2, offset: 0 });
  assert.equal(p1.items.length, 2);
  assert.equal(p1.total, 6);
  const found = db.listConfigs({ search: "ula" });
  assert.equal(found.total, 5);
  db.close();
});

test("operating on a missing config raises NOT_FOUND", () => {
  const db = new AppDatabase(pathFor("nf"));
  db.migrate();
  const svc = new ArrayService(db);
  assert.throws(() => svc.scan(999, defaultGrid(0.1)), /not found/);
  assert.throws(() => svc.disable(999, 0), /not found/);
  db.close();
});

test("invalid element index on disable rejected, no row created", () => {
  const db = new AppDatabase(pathFor("baddisable"));
  db.migrate();
  const svc = new ArrayService(db);
  const base = svc.createArray({ name: "b", wavelength: 1, positions: [0, 0.5] });
  const before = db.countConfigs();
  assert.throws(() => svc.disable(base.id, 5));
  assert.equal(db.countConfigs(), before);
  db.close();
});
