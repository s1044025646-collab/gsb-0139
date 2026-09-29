/**
 * Repeatable end-to-end demo against a project-local throwaway database.
 * Uses deterministic ids and fixed grids; safe to run repeatedly.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { ConfigRepository } from "../src/db/repo.ts";
import { ArrayService } from "../src/core/service.ts";
import { buildElements } from "../src/core/validation.ts";
import { uniformPositions } from "../src/core/array.ts";
import { allFixtures } from "../fixtures/fixtures.ts";

const dbPath = resolve("data", "demo.db");
rmSync(dbPath, { force: true });

const db = openDatabase(dbPath);
const repo = new ConfigRepository(db, () => new Date("2030-01-01T00:00:00.000Z"));
const service = new ArrayService(repo);

const grid = { start_deg: -90, stop_deg: 90, step_deg: 0.2 };

console.log("== Synthetic fixture sweep ==");
for (const f of allFixtures()) {
  const cfg = service.create({
    name: f.name,
    wavelength: f.wavelength,
    elements: f.elements,
    weights: f.weights,
    steer_angle_deg: f.steer_angle_deg,
    note: f.description,
  });
  const { report } = service.scan(cfg.id, grid);
  const flags = [
    report.all_zero_weights ? "ALL_ZERO" : null,
    report.multiple_equal_peaks ? "MULTIPLE_PEAKS" : null,
    report.grating_lobe ? "GRATING_LOBE" : null,
    report.main_lobe_incomplete ? "INCOMPLETE_MAIN_LOBE" : null,
  ]
    .filter(Boolean)
    .join(",");
  console.log(
    `${f.name.padEnd(12)} peak=${report.main_peak ? report.main_peak.angle_deg.toFixed(1) : "n/a"} ` +
      `HPBW=${report.hpbw_deg ? report.hpbw_deg.toFixed(2) : "n/a"} ` +
      `SLL=${report.sidelobe_level_db !== null ? report.sidelobe_level_db.toFixed(2) : "n/a"} ` +
      `flags=[${flags || "none"}]`,
  );
}

console.log("\n== Version workflow on an 8-element lambda/2 ULA ==");
const elements = buildElements(uniformPositions(8, 0.05));
const base = service.create({
  name: "ULA8",
  wavelength: 0.1,
  elements,
  weights: elements.map((_, i) => ({ index: i, re: 1, im: 0 })),
  steer_angle_deg: 0,
});
const steered = service.steer(base.id, 30, "uniform", "demo-steer");
const { config: quantized, error } = service.quantize(steered.id, null, 2, "demo-quant");
const failed = service.disableElement(steered.id, 2, "demo-fail");

console.log(`baseline   v${base.version} id=${base.id}`);
console.log(`steered    v${steered.version} id=${steered.id} angle=${steered.steer_angle_deg}`);
console.log(
  `quantized  v${quantized.version} id=${quantized.id} phase_bits=2 normalized_mse=${error.normalized_mse.toExponential(3)}`,
);
console.log(`failed el  v${failed.version} id=${failed.id} active=${failed.elements.filter((e) => e.enabled).length}/8`);

// Idempotency: same key returns the identical config id.
const again = service.steer(base.id, 30, "uniform", "demo-steer");
console.log(`idempotent steer returns id=${again.id} (same as ${steered.id}: ${again.id === steered.id})`);

const comparison = service.compare(base.id, quantized.id, grid);
console.log(
  `\ncompare baseline vs quantized: dHPBW=${comparison.hpbw_delta_deg?.toFixed(3)}deg ` +
    `dPeak=${comparison.peak_angle_delta_deg?.toFixed(3)}deg`,
);

console.log("\nModel limits: isotropic elements, far field, 1-D linear array.");
console.log("No mutual coupling and no real element radiation pattern are included.");
db.close();
