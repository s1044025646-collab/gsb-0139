import type { AngleGrid, Complex, Element, PatternReport, PatternSample, Peak } from "../types.ts";
import { abs2 } from "./complex.ts";
import { angleList, DEG2RAD } from "./grid.ts";
import { arrayFactorAt } from "./array.ts";

const DB_FLOOR = -120;
/** A lobe within this many dB of the global peak is treated as a full-strength lobe. */
const FULL_STRENGTH_DB = -0.5;
/** Local maxima shallower than this are treated as ripple, not lobes. */
const SIDELOBE_FLOOR_DB = -60;

export interface AnalyzeOptions {
  configId: number;
  configVersion: number;
  elements: Element[];
  wavelength: number;
  grid: AngleGrid;
  generatedAt?: string | undefined;
}

/**
 * Compute complex AF, normalized power pattern (linear + dB) on the grid.
 * Normalization is to the pattern's OWN global maximum |AF|^2, so a uniform
 * rescaling of every weight leaves powerLinear and powerDb unchanged.
 */
export function samplePattern(elements: Element[], wavelength: number, grid: AngleGrid): PatternSample[] {
  const angles = angleList(grid);
  const afs: Complex[] = angles.map((t) => arrayFactorAt(elements, wavelength, t));
  let maxPower = 0;
  for (const af of afs) maxPower = Math.max(maxPower, abs2(af));
  return angles.map((thetaDeg, i) => {
    const af = afs[i]!;
    const p = maxPower > 0 ? abs2(af) / maxPower : 0;
    return {
      thetaDeg,
      af,
      powerLinear: p,
      powerDb: p > 0 ? 10 * Math.log10(p) : DB_FLOOR,
    };
  });
}

function isLocalMax(samples: PatternSample[], i: number): boolean {
  const p = samples[i]!.powerDb;
  if (p <= SIDELOBE_FLOOR_DB) return false;
  const left = i > 0 ? samples[i - 1]!.powerDb : -Infinity;
  const right = i < samples.length - 1 ? samples[i + 1]!.powerDb : -Infinity;
  return p >= left && p >= right && (p > left || p > right);
}

/**
 * Find the first local MINIMUM of the pattern moving outward from the peak
 * index, used as the main-lobe / sidelobe separator. Falls back to the -3 dB
 * crossing if no null exists (e.g. lobe cut off at a scan boundary).
 */
function firstNull(samples: PatternSample[], peak: number, dir: -1 | 1): number | null {
  let i = peak;
  let prev = samples[peak]!.powerDb;
  let crossed3 = false;
  let cross3 = peak;
  while (true) {
    i += dir;
    if (i < 0 || i >= samples.length) return null;
    const cur = samples[i]!.powerDb;
    if (!crossed3 && cur <= -3) {
      crossed3 = true;
      cross3 = i;
    }
    if (cur > prev) {
      // local minimum found at i - dir
      return i - dir;
    }
    prev = cur;
    void cross3;
  }
}

function halfPowerCrossing(samples: PatternSample[], peak: number, dir: -1 | 1): number | null {
  let i = peak;
  let prevI = peak;
  while (true) {
    prevI = i;
    i += dir;
    if (i < 0 || i >= samples.length) return null;
    if (samples[i]!.powerDb <= -3 && samples[prevI]!.powerDb >= -3) {
      const a = samples[prevI]!;
      const b = samples[i]!;
      const frac = (-3 - a.powerDb) / (b.powerDb - a.powerDb);
      return a.thetaDeg + frac * (b.thetaDeg - a.thetaDeg);
    }
  }
}

export function analyzePattern(opts: AnalyzeOptions): PatternReport {
  const { configId, configVersion, elements, wavelength, grid } = opts;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const samples = samplePattern(elements, wavelength, grid);

  const allZero = samples.every((s) => s.powerLinear === 0);
  const report: PatternReport = {
    configId,
    configVersion,
    grid,
    generatedAt,
    convention: {
      angleReference:
        "theta measured from array broadside (normal to the element line); endfire = +/-90 deg",
      phaseSign:
        "time convention exp(+jwt); steering weights w_n = exp(-j k x_n sin theta0); AF = sum w_n exp(+j k x_n sin theta)",
      powerDefinition:
        "field amplitude = |AF|; power = |AF|^2 normalized to the pattern peak; dB = 10 log10(power) (power ratio, not amplitude)",
    },
    allZeroWeights: allZero,
    globalPeaks: [],
    multipleEqualPeaks: false,
    gratingLobe: false,
    peakDirectionDeg: null,
    mainLobe: { complete: false, leftHalfPowerDeg: null, rightHalfPowerDeg: null, hpbwDeg: null },
    sidelobeLevelDb: null,
    sidelobePeak: null,
    sidelobePeaks: [],
    modelLimitations: [
      "isolated isotropic element element pattern is assumed; no embedded element pattern",
      "mutual coupling between elements is not modelled",
      "far-field only; no near-field or range dependence",
      "1-D linear array; no 2-D/polarization effects",
    ],
  };

  if (allZero) {
    report.samples = samples;
    return report;
  }

  // Global maximum power (linear) and all samples attaining it.
  let maxPower = 0;
  for (const s of samples) maxPower = Math.max(maxPower, s.powerLinear);
  const peakIdx: number[] = [];
  samples.forEach((s, i) => {
    if (s.powerLinear >= maxPower * (1 - 1e-9)) peakIdx.push(i);
  });
  report.multipleEqualPeaks = peakIdx.length > 1;

  // Main lobe: choose the global maximum closest to broadside (theta 0) when
  // several are equal, otherwise the single global max.
  let mainIdx = peakIdx[0]!;
  if (peakIdx.length > 1) {
    mainIdx = peakIdx.reduce((best, i) => (Math.abs(samples[i]!.thetaDeg) < Math.abs(samples[best]!.thetaDeg) ? i : best), peakIdx[0]!);
  }
  const mainSample = samples[mainIdx]!;
  // Multiple equal-height maxima => ambiguous pointing; do NOT force a unique
  // direction (flat single-element pattern, grating lobes, etc.).
  report.peakDirectionDeg = report.multipleEqualPeaks ? null : mainSample.thetaDeg;

  // Main-lobe boundaries: first null each side; if the lobe is cut at the
  // grid edge there is no null -> main lobe incomplete.
  const leftNull = firstNull(samples, mainIdx, -1);
  const rightNull = firstNull(samples, mainIdx, +1);
  const mainComplete = leftNull !== null && rightNull !== null;

  // Half-power (-3 dB) crossings with interpolation.
  const hpLeft = halfPowerCrossing(samples, mainIdx, -1);
  const hpRight = halfPowerCrossing(samples, mainIdx, +1);
  const hpbw = hpLeft !== null && hpRight !== null ? hpRight - hpLeft : null;

  report.mainLobe = {
    complete: mainComplete,
    leftHalfPowerDeg: hpLeft,
    rightHalfPowerDeg: hpRight,
    hpbwDeg: hpbw,
  };

  // Sidelobe search region: everything strictly outside [leftNull, rightNull].
  // Adjacent main-lobe samples are excluded by construction (nulls are minima).
  const region = (i: number): boolean => {
    if (leftNull !== null && i <= leftNull) return false;
    if (rightNull !== null && i >= rightNull) return false;
    return true;
  };
  const sideCandidates: Peak[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (region(i)) continue;
    if (i === mainIdx) continue;
    if (!isLocalMax(samples, i)) continue;
    sideCandidates.push({ thetaDeg: samples[i]!.thetaDeg, powerDb: samples[i]!.powerDb, sampleIndex: i });
  }

  // Grating lobes: sidelobes at essentially the same level as the main lobe.
  const grating = sideCandidates.filter((p) => p.powerDb >= FULL_STRENGTH_DB);
  report.gratingLobe = grating.length > 0 || report.multipleEqualPeaks;
  report.globalPeaks = peakIdx.map((i) => ({ thetaDeg: samples[i]!.thetaDeg, powerDb: samples[i]!.powerDb, sampleIndex: i }));

  const realSidelobes = sideCandidates.filter((p) => p.powerDb < FULL_STRENGTH_DB);
  realSidelobes.sort((a, b) => b.powerDb - a.powerDb);
  report.sidelobePeaks = realSidelobes;
  if (realSidelobes.length > 0) {
    report.sidelobePeak = realSidelobes[0]!;
    report.sidelobeLevelDb = realSidelobes[0]!.powerDb;
  }

  report.samples = samples;
  return report;
}

/** Convenience: phase of the array factor in degrees at the peak (debugging). */
export function peakPhaseDeg(elements: Element[], wavelength: number, thetaDeg: number): number {
  const af = arrayFactorAt(elements, wavelength, thetaDeg);
  return (Math.atan2(af.im, af.re) / DEG2RAD) % 360;
}
