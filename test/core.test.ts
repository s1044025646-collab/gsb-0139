import { test } from "node:test";
import assert from "node:assert/strict";
import { arrayFactorAt, scaleWeights, steeringWeights, uniformPositions } from "../src/core/array.ts";
import { analyzePattern } from "../src/core/pattern.ts";
import { cabs } from "../src/core/complex.ts";
import { quantizeWeights } from "../src/core/array.ts";
import {
  allZeroFixture,
  edgeSteeredFixture,
  gratingLobeFixture,
  halfWaveUlaFixture,
  singleElementFixture,
  twoElementFixture,
  windowedUlaFixture,
} from "../fixtures/fixtures.ts";

const FINE = { start_deg: -90, stop_deg: 90, step_deg: 0.1 };

test("single element: omni directional field, no sidelobes, no HPBW", () => {
  const f = singleElementFixture();
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  assert.equal(r.all_zero_weights, false);
  assert.ok(r.samples.every((s) => Math.abs(s.field - 1) < 1e-12));
  assert.equal(r.hpbw_deg, null);
  assert.equal(r.sidelobe_level_db, null);
  assert.equal(r.main_lobe_incomplete, false);
});

test("two in-phase half-wave-spaced elements: analytic phase addition at broadside", () => {
  const f = twoElementFixture(0.5, 0);
  const af0 = arrayFactorAt(f.elements, f.weights, f.wavelength, 0);
  // At broadside both phasors are 1: AF = 2 + j0.
  assert.ok(Math.abs(af0.re - 2) < 1e-12);
  assert.ok(Math.abs(af0.im) < 1e-12);
  // At endfire the path difference is lambda/2 -> phasors cancel: AF = 0.
  const af90 = arrayFactorAt(f.elements, f.weights, f.wavelength, 90);
  assert.ok(cabs(af90) < 1e-12);
  // Closed form: |AF(theta)|^2 = 4 cos^2(pi/2 sin theta). HPBW: sin(theta3)=1/2 -> 30 deg.
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  assert.ok(Math.abs(r.main_peak!.angle_deg) < 1e-9);
  assert.ok(Math.abs(r.hpbw_deg! - 60) < 0.05, `hpbw ${r.hpbw_deg}`);
  assert.ok(Math.abs(r.hpbw_left_deg! - -30) < 0.05);
  assert.ok(Math.abs(r.hpbw_right_deg! - 30) < 0.05);
});

test("symmetry: broadside pattern is even in theta", () => {
  const f = halfWaveUlaFixture(8, 0);
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  for (const sp of r.samples) {
    if (sp.angle_deg < 0) continue;
    const partner = r.samples.find((q) => Math.abs(q.angle_deg + sp.angle_deg) < 1e-9);
    assert.ok(partner, `missing mirror for ${sp.angle_deg}`);
    assert.ok(Math.abs(sp.power_norm - partner!.power_norm) < 1e-10);
  }
  assert.ok(Math.abs(r.main_peak!.angle_deg) < 1e-9);
});

test("steering peak lands at the commanded scan angle", () => {
  for (const target of [-40, -15, 25, 45]) {
    const f = halfWaveUlaFixture(16, target);
    const r = analyzePattern(f.elements, f.weights, f.wavelength, {
      start_deg: -90,
      stop_deg: 90,
      step_deg: 0.05,
    });
    assert.ok(r.unique_peak, `expected unique peak at ${target}`);
    assert.ok(Math.abs(r.main_peak!.angle_deg - target) < 0.1, `${target} vs ${r.main_peak!.angle_deg}`);
  }
});

test("scale invariance: multiplying all weights leaves normalized pattern unchanged", () => {
  const f = halfWaveUlaFixture(8, 20);
  const scaled = { ...f, weights: scaleWeights(f.weights, 7.31) };
  const r1 = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  const r2 = analyzePattern(scaled.elements, scaled.weights, scaled.wavelength, FINE);
  assert.equal(r1.samples.length, r2.samples.length);
  for (let i = 0; i < r1.samples.length; i++) {
    assert.ok(Math.abs(r1.samples[i]!.power_norm - r2.samples[i]!.power_norm) < 1e-12);
    assert.ok(Math.abs(r1.samples[i]!.power_db - r2.samples[i]!.power_db) < 1e-9);
  }
  assert.ok(Math.abs(r1.hpbw_deg! - r2.hpbw_deg!) < 1e-9);
  assert.ok(Math.abs(r1.sidelobe_level_db! - r2.sidelobe_level_db!) < 1e-9);
  // But raw field scales linearly.
  assert.ok(Math.abs(r2.max_field - 7.31 * r1.max_field) < 1e-9 * r2.max_field);
});

test("ULA sidelobe level near the textbook -13 dB and neighbours are not counted", () => {
  const f = halfWaveUlaFixture(8, 0);
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  // Uniform 8-element lambda/2 ULA first sidelobe is about -12.8 to -13 dB.
  assert.ok(r.sidelobe_level_db! < -12.5, `got ${r.sidelobe_level_db}`);
  assert.ok(r.sidelobe_level_db! > -13.5);
  // Sidelobe must lie strictly outside the main-lobe -3 dB span.
  assert.ok(r.sidelobe_peak!.angle_deg > r.hpbw_right_deg! + 1);
});

test("Hann taper lowers sidelobes and widens the beam vs uniform", () => {
  const uni = halfWaveUlaFixture(16, 0);
  const win = windowedUlaFixture(16, "hann", 0);
  const ru = analyzePattern(uni.elements, uni.weights, uni.wavelength, FINE);
  const rw = analyzePattern(win.elements, win.weights, win.wavelength, FINE);
  assert.ok(rw.sidelobe_level_db! < ru.sidelobe_level_db! - 15);
  assert.ok(rw.hpbw_deg! > ru.hpbw_deg!);
});

test("grating lobe: d > lambda yields equal-height second peaks and ambiguity flag", () => {
  const f = gratingLobeFixture(1.2, 0);
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  assert.equal(r.grating_lobe, true);
  assert.equal(r.multiple_equal_peaks, true);
  assert.equal(r.unique_peak, false);
  // alias angles asin(+/- lambda/d) = asin(+/- 1/1.2) ~ +/-56.44 deg.
  const angles = r.peaks.map((p) => Math.abs(p.angle_deg)).sort((a, b) => a - b);
  assert.ok(Math.abs(angles[0]! - 0) < 0.1);
  assert.ok(Math.abs(angles[angles.length - 1]! - 56.44) < 0.2);
});

test("endfire steering: peak on boundary marks incomplete main lobe", () => {
  const f = edgeSteeredFixture(8);
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE, 90);
  assert.ok(r.main_peak!.at_boundary);
  assert.equal(r.main_lobe_incomplete, true);
  assert.equal(r.hpbw_deg, null);
});

test("all-zero weights are flagged and no pointing is claimed", () => {
  const f = allZeroFixture();
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  assert.equal(r.all_zero_weights, true);
  assert.equal(r.main_peak, null);
  assert.equal(r.unique_peak, false);
  assert.equal(r.hpbw_deg, null);
  assert.equal(r.sidelobe_level_db, null);
});

test("grid refinement: HPBW estimate converges as step is reduced", () => {
  const f = halfWaveUlaFixture(8, 10);
  const coarse = analyzePattern(f.elements, f.weights, f.wavelength, {
    start_deg: -90,
    stop_deg: 90,
    step_deg: 4,
  });
  const medium = analyzePattern(f.elements, f.weights, f.wavelength, {
    start_deg: -90,
    stop_deg: 90,
    step_deg: 1,
  });
  const fine = analyzePattern(f.elements, f.weights, f.wavelength, {
    start_deg: -90,
    stop_deg: 90,
    step_deg: 0.1,
  });
  assert.ok(Math.abs(fine.hpbw_deg! - medium.hpbw_deg!) < Math.abs(medium.hpbw_deg! - coarse.hpbw_deg!));
  assert.ok(Math.abs(fine.hpbw_deg! - medium.hpbw_deg!) < 0.05);
});

test("phase quantization introduces a bounded error and coarser bits increase it", () => {
  const positions = uniformPositions(12, 0.05);
  const w = steeringWeights(positions, 0.1, 30);
  const elements = positions.map((x, i) => ({ index: i, x, enabled: true }));
  const q2 = quantizeWeights(w, elements, null, 2);
  const q6 = quantizeWeights(w, elements, null, 6);
  const err = (wq: typeof q2) =>
    wq.reduce((s, z, i) => s + (z.re - w[i]!.re) ** 2 + (z.im - w[i]!.im) ** 2, 0) /
    w.reduce((s, z) => s + z.re ** 2 + z.im ** 2, 0);
  assert.ok(err(q2) > err(q6));
  assert.ok(err(q6) < 1e-3);
});

test("power dB uses factor 10 and zeros map to -Infinity", () => {
  const f = halfWaveUlaFixture(4, 0);
  const r = analyzePattern(f.elements, f.weights, f.wavelength, FINE);
  const peak = r.samples.find((s) => s.power_norm === 1)!;
  assert.equal(peak.power_db, 0);
  // An exactly-zero weight vector yields -Infinity dB everywhere.
  const zero = allZeroFixture(2);
  const r2 = analyzePattern(zero.elements, zero.weights, zero.wavelength, FINE);
  assert.ok(r2.samples.every((s) => s.power_db === Number.NEGATIVE_INFINITY));
});
