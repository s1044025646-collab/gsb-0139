/**
 * Repeatable end-to-end demo. Uses an in-project data directory and injected
 * timestamps; no network beyond the loopback HTTP server is involved.
 * Run: npm run demo
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { AppDatabase } from "../src/db.ts";
import { ArrayService } from "../src/service.ts";
import { defaultGrid } from "../src/core/grid.ts";
import { uniformPositions } from "../test/fixtures.ts";

const dbPath = resolve("data/demo.sqlite");
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const db = new AppDatabase(dbPath);
db.migrate();
const svc = new ArrayService(db);
let tick = 0;
const now = () => `2026-09-29T00:00:${String(tick++).padStart(2, "0")}.000Z`;

const positions = uniformPositions(8, 0.5, true);

console.log("== 1. create 8-element half-wave ULA (broadside) ==");
const v1 = svc.createArray({ name: "demo-ula8", wavelength: 1, positions }, { idempotencyKey: "demo-v1", now: now() });
console.log(`config #${v1.id} version=${v1.version}`);

console.log("\n== 2. resubmit with same idempotency key (must not duplicate) ==");
const v1again = svc.createArray({ name: "demo-ula8", wavelength: 1, positions }, { idempotencyKey: "demo-v1", now: now() });
console.log(`returned config #${v1again.id} (same: ${v1again.id === v1.id}); total configs=${db.countConfigs()}`);

console.log("\n== 3. steer to 30 deg ==");
const v2 = svc.steer(v1.id, 30, { idempotencyKey: "demo-v2", now: now() });
const r2 = svc.scan(v2.id, defaultGrid(0.1));
console.log(`peak=${r2.peakDirectionDeg} deg HPBW=${r2.mainLobe.hpbwDeg?.toFixed(2)} SLL=${r2.sidelobeLevelDb?.toFixed(2)} dB grating=${r2.gratingLobe}`);

console.log("\n== 4. apply 2-bit phase quantization ==");
const v3 = svc.quantize(v2.id, { amplitudeLevels: null, phaseStates: 4 }, { idempotencyKey: "demo-v3", now: now() });
const cmp = svc.compare(v2.id, v3.id, defaultGrid(0.1));
console.log(`max |dP|=${cmp.maxAbsPowerDifference.toExponential(3)} max |d dB|=${cmp.maxAbsPowerDbDifference?.toFixed(3)} peak shift=${cmp.peakDirectionShiftDeg}`);

console.log("\n== 5. simulate single failed element (#3), baseline untouched ==");
const v4 = svc.disable(v3.id, 3, { idempotencyKey: "demo-v4", now: now() });
console.log(`enabled=${v4.elements.filter((e) => e.enabled).length}/8; parent chain #${v1.id}->#${v2.id}->#${v3.id}->#${v4.id}`);

console.log("\n== 6. grating lobe demonstration: d = 0.9 lambda steered to 30 ==");
const g = svc.createArray({ name: "demo-grating", wavelength: 1, positions: uniformPositions(8, 0.9, true), steerAngleDeg: 30 }, { idempotencyKey: "demo-g", now: now() });
const rg = svc.scan(g.id, defaultGrid(0.05));
console.log(`grating=${rg.gratingLobe} peaks=${rg.globalPeaks.map((p) => p.thetaDeg).join(", ")} deg`);

console.log("\n== lineage of demo-ula8 ==");
for (const c of db.lineage(v1.id)) console.log(`  #${c.id} v${c.version} ${c.note ?? ""}`);

db.close();
console.log(`\ndemo database left at ${dbPath} (delete data/ to reset).`);
