import { cabs, cadd, cexp, cscale } from "./complex.ts";
import type { AngleGrid, ElementSpec, WeightSpec } from "./types.ts";
import type { Complex } from "./types.ts";

export const DEG2RAD = Math.PI / 180;

/** Uniform linear array positions: N elements spaced d metres, centred on x=0. */
export function uniformPositions(count: number, spacing: number): number[] {
  const positions: number[] = [];
  for (let n = 0; n < count; n++) positions.push((n - (count - 1) / 2) * spacing);
  return positions;
}

/**
 * Steering weights for a scan angle theta0 (degrees, broadside convention):
 *   w_n = taper_n * exp(-j*k*x_n*sin(theta0))
 * Tapers: "uniform" | "hann" | "hamming" (amplitude weights, applied across the aperture).
 */
export function steeringWeights(
  positions: readonly number[],
  wavelength: number,
  steerAngleDeg: number,
  taper: "uniform" | "hann" | "hamming" = "uniform",
): WeightSpec[] {
  const k = (2 * Math.PI) / wavelength;
  const phase0 = k * Math.sin(steerAngleDeg * DEG2RAD);
  const n = positions.length;
  return positions.map((x, i) => {
    let a = 1;
    if (taper === "hann") a = n === 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    else if (taper === "hamming")
      a = n === 1 ? 1 : 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    const p = cexp(-phase0 * x);
    return { index: i, re: a * p.re, im: a * p.im };
  });
}

/**
 * Quantize complex weights.
 *  - amp_bits: amplitude normalized to the max enabled weight magnitude,
 *    rounded to the nearest of 2^amp_bits levels in [0,1] (mid-tread, includes 0).
 *  - phase_bits: phase rounded to the nearest of 2^phase_bits equally spaced steps.
 * Disabled elements are not quantized (they stay exactly zero).
 */
export function quantizeWeights(
  weights: readonly WeightSpec[],
  elements: readonly ElementSpec[],
  ampBits: number | null,
  phaseBits: number | null,
): WeightSpec[] {
  const mags = weights.map((w) => Math.hypot(w.re, w.im));
  const maxMag = Math.max(0, ...mags);
  const ampLevels = ampBits === null ? null : 2 ** ampBits - 1;
  const phaseSteps = phaseBits === null ? null : 2 ** phaseBits;

  return weights.map((w, i) => {
    const enabled = elements[i]?.enabled ?? true;
    if (!enabled || (w.re === 0 && w.im === 0)) return { index: w.index, re: 0, im: 0 };
    let mag = mags[i]!;
    let phase = Math.atan2(w.im, w.re);
    if (ampLevels !== null && maxMag > 0) {
      const q = Math.round((mag / maxMag) * ampLevels) / ampLevels;
      mag = q * maxMag;
    }
    if (phaseSteps !== null) {
      const step = (2 * Math.PI) / phaseSteps;
      phase = Math.round(phase / step) * step;
    }
    return { index: w.index, re: mag * Math.cos(phase), im: mag * Math.sin(phase) };
  });
}

/** Return a new weight set with the given element index disabled (weight forced to 0). */
export function disableElement(weights: readonly WeightSpec[], index: number): WeightSpec[] {
  return weights.map((w) => (w.index === index ? { index: w.index, re: 0, im: 0 } : { ...w }));
}

/** Build angle samples [start..stop] with a constant positive step. */
export function buildGrid(grid: AngleGrid): number[] {
  const { start_deg: start, stop_deg: stop, step_deg: step } = grid;
  const out: number[] = [];
  const count = Math.round((stop - start) / step);
  for (let i = 0; i <= count; i++) {
    out.push(i === count ? stop : start + i * step);
  }
  return out;
}

/**
 * Complex array factor at one angle:
 *   AF(theta) = SUM_enabled w_n exp(+j k x_n sin theta)
 */
export function arrayFactorAt(
  elements: readonly ElementSpec[],
  weights: readonly WeightSpec[],
  wavelength: number,
  thetaDeg: number,
): Complex {
  const k = (2 * Math.PI) / wavelength;
  const psi = k * Math.sin(thetaDeg * DEG2RAD);
  let sum: Complex = { re: 0, im: 0 };
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    const w = weights[i]!;
    if (!el.enabled) continue;
    const p = cexp(psi * el.x);
    sum = cadd(sum, { re: w.re * p.re - w.im * p.im, im: w.re * p.im + w.im * p.re });
  }
  return sum;
}

/** Global complex-weight scaling check helper: scales every weight by s. */
export function scaleWeights(weights: readonly WeightSpec[], s: number): WeightSpec[] {
  return weights.map((w) => ({ index: w.index, ...cscale({ re: w.re, im: w.im }, s) }));
}

export function allWeightsZero(weights: readonly WeightSpec[], elements: readonly ElementSpec[]): boolean {
  for (let i = 0; i < elements.length; i++) {
    if (!elements[i]!.enabled) continue;
    if (cabs({ re: weights[i]!.re, im: weights[i]!.im }) > 0) return false;
  }
  return true;
}
