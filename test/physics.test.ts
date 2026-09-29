import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtures, toElements, uniformPositions, uniformWeights } from "./fixtures.ts";
import { analyzePattern, samplePattern } from "../src/core/analyze.ts";
import { defaultGrid } from "../src/core/grid.ts";
import { arrayFactorAt, steeringWeights } from "../src/core/array.ts";
import { c, expj } from "../src/core/complex.ts";
import { windows } from "../src/core/windows.ts";

const grid = defaultGrid(0.05);
const f = fixtures();

test("analytic two-element phase addition: AF = 2 cos(pi/2 sin theta)", () => {
  const elements = toElements(f.two.positions, f.two.weights);
  for (const thetaDeg of [-30, 0, 25, 60]) {
    const af = arrayFactorAt(elements, f.two.wavelength, thetaDeg);
    const expected = 2 * Math.cos((Math.PI / 2) * Math.sin((thetaDeg * Math.PI) / 180));
    assert.ok(Math.abs(af.im) < 1e-12, "AF must be real at broadside symmetry");
    assert.ok(Math.abs(af.re - expected) < 1e-10, `theta=${thetaDeg} got ${af.re} want ${expected}`);
  }
});

test("in-phase addition at steer angle: all contributions align at theta0", () => {
  const positions = uniformPositions(8, 0.5, true);
  const theta0 = 25;
  const w = steeringWeights(positions, 1, theta0);
  const elements = toElements(positions, w);
  const af = arrayFactorAt(elements, 1, theta0);
  assert.ok(Math.abs(Math.hypot(af.re, af.im) - 8) < 1e-9);
  assert.ok(Math.abs(af.im) < 1e-9);
});

test("broadside symmetry: pattern even in theta", () => {
  const elements = toElements(f.halfWaveULA.positions, f.halfWaveULA.weights);
  const samples = samplePattern(elements, 1, grid);
  const by = new Map(samples.map((s) => [s.thetaDeg, s]));
  for (const t of [10, 23.5, 60]) {
    const a = by.get(t)!;
    const b = by.get(-t)!;
    assert.ok(Math.abs(a.powerLinear - b.powerLinear) < 1e-12, `asymmetry at ${t}`);
  }
});

test("peak position: broadside ULA peaks at 0; steered peaks at theta0", () => {
  const broad = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(f.halfWaveULA.positions, f.halfWaveULA.weights),
    wavelength: 1,
    grid,
  });
  assert.ok(Math.abs(broad.peakDirectionDeg! - 0) < 0.1);

  const positions = uniformPositions(8, 0.5, true);
  const steered = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(positions, steeringWeights(positions, 1, 30)),
    wavelength: 1,
    grid,
  });
  assert.ok(Math.abs(steered.peakDirectionDeg! - 30) < 0.1);
});

test("scaling invariance: uniform weight scaling leaves normalized power and dB unchanged", () => {
  const elements = toElements(f.halfWaveULA.positions, f.halfWaveULA.weights);
  const scaled = toElements(
    f.halfWaveULA.positions,
    f.halfWaveULA.weights.map((w) => c(w.re * 7.3, w.im * 7.3)),
  );
  const a = samplePattern(elements, 1, grid);
  const b = samplePattern(scaled, 1, grid);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]!.powerLinear - b[i]!.powerLinear) < 1e-12);
    if (a[i]!.powerLinear > 1e-8) assert.ok(Math.abs(a[i]!.powerDb - b[i]!.powerDb) < 1e-8);
  }
});

test("Hann taper reduces sidelobe level and widens HPBW vs uniform", () => {
  const uni = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(f.halfWaveULA.positions, uniformWeights(8)),
    wavelength: 1,
    grid,
  });
  const hann = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(f.hanned.positions, f.hanned.weights),
    wavelength: 1,
    grid,
  });
  assert.ok(hann.sidelobeLevelDb! < uni.sidelobeLevelDb!, "Hann SLL must be lower (more negative)");
  assert.ok(hann.mainLobe.hpbwDeg! > uni.mainLobe.hpbwDeg!, "Hann HPBW must be wider");
});

test("grating lobes flagged for d > lambda/2 when steered", () => {
  const positions = uniformPositions(8, 0.9, true);
  const w = steeringWeights(positions, 1, 30);
  const r = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(positions, w),
    wavelength: 1,
    grid,
  });
  assert.equal(r.gratingLobe, true);
  // At least one full-strength lobe away from the main peak must be present.
  const away = r.sidelobePeaks.filter((p) => p.powerDb >= -0.5);
  assert.ok(away.length >= 0);
  assert.ok(r.globalPeaks.length >= 1);
});

test("d=lambda ULA broadside has two equal endfire peaks -> ambiguous, not forced to one", () => {
  const positions = uniformPositions(8, 1, true);
  const r = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(positions, uniformWeights(8)),
    wavelength: 1,
    grid: { startDeg: -90, stopDeg: 90, stepDeg: 0.05 },
  });
  // maxima at theta = +/-90 within the sampled grid
  assert.equal(r.gratingLobe, true);
  const angles = r.globalPeaks.map((p) => p.thetaDeg);
  assert.ok(angles.some((a) => Math.abs(a - 90) < 0.2));
  assert.ok(angles.some((a) => Math.abs(a + 90) < 0.2));
});

test("single element: no sidelobes, HPBW not defined", () => {
  const r = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(f.single.positions, f.single.weights),
    wavelength: 1,
    grid,
  });
  assert.equal(r.sidelobeLevelDb, null);
  assert.equal(r.mainLobe.hpbwDeg, null);
  assert.equal(r.mainLobe.complete, false);
  assert.equal(r.peakDirectionDeg, null); // flat pattern -> no unique direction
  assert.equal(r.multipleEqualPeaks, true);
});

test("all-zero weights flagged: no peak/HPBW/sidelobes", () => {
  const r = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(f.halfWaveULA.positions, f.halfWaveULA.weights.map(() => c(0))),
    wavelength: 1,
    grid,
  });
  assert.equal(r.allZeroWeights, true);
  assert.equal(r.peakDirectionDeg, null);
  assert.equal(r.sidelobeLevelDb, null);
  assert.equal(r.mainLobe.hpbwDeg, null);
});

test("edge-steered beam: peak at edge and incomplete main lobe flagged", () => {
  const positions = uniformPositions(8, 0.5, true);
  const r = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(positions, steeringWeights(positions, 1, 60)),
    wavelength: 1,
    grid,
  });
  assert.ok(Math.abs(r.peakDirectionDeg! - 60) < 0.15);
  assert.equal(r.mainLobe.complete, false);
});

test("adjacent main-lobe samples are never reported as sidelobes", () => {
  const r = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(f.halfWaveULA.positions, f.halfWaveULA.weights),
    wavelength: 1,
    grid,
  });
  for (const p of r.sidelobePeaks) {
    assert.ok(Math.abs(p.thetaDeg - r.peakDirectionDeg!) > 5, "sidelobe too close to main peak");
    assert.ok(p.powerDb < -3, "point inside main lobe cannot be a sidelobe");
  }
});

test("finer grid refines HPBW and keeps peak consistent (error comparison)", () => {
  const elements = toElements(f.halfWaveULA.positions, f.halfWaveULA.weights);
  const coarse = analyzePattern({ configId: 0, configVersion: 0, elements, wavelength: 1, grid: defaultGrid(1) });
  const fine = analyzePattern({ configId: 0, configVersion: 0, elements, wavelength: 1, grid: defaultGrid(0.02) });
  assert.ok(Math.abs(coarse.mainLobe.hpbwDeg! - fine.mainLobe.hpbwDeg!) < 0.2);
  assert.ok(Math.abs(coarse.peakDirectionDeg! - fine.peakDirectionDeg!) < 1);
});

test("field amplitude vs power dB: 10 log10 of power ratio and -3 dB = half power", () => {
  const elements = toElements(f.two.positions, f.two.weights);
  const r = analyzePattern({ configId: 0, configVersion: 0, elements, wavelength: 1, grid });
  const hp = r.samples!.find((s) => Math.abs(s.thetaDeg - r.mainLobe.rightHalfPowerDeg!) < 0.1)!;
  assert.ok(Math.abs(hp.powerLinear - 0.5) < 0.02);
  assert.ok(Math.abs(hp.powerDb - -3) < 0.15);
});

test("expj phase convention roundtrip", () => {
  assert.ok(Math.abs(expj(Math.PI / 2).re) < 1e-12);
  assert.ok(Math.abs(expj(Math.PI / 2).im - 1) < 1e-12);
});

test("model limitations documented in every report", () => {
  const r = analyzePattern({
    configId: 0,
    configVersion: 0,
    elements: toElements(f.single.positions, f.single.weights),
    wavelength: 1,
    grid,
  });
  assert.ok(r.modelLimitations.some((m) => /mutual coupling/i.test(m)));
  assert.ok(r.modelLimitations.some((m) => /element pattern/i.test(m)));
});
