import type { Complex } from "../types.ts";

export const c = (re: number, im = 0): Complex => ({ re, im });

export const add = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });

export const scale = (a: Complex, k: number): Complex => ({ re: a.re * k, im: a.im * k });

export const mul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});

export const abs2 = (a: Complex): number => a.re * a.re + a.im * a.im;

export const abs = (a: Complex): number => Math.hypot(a.re, a.im);

export const phase = (a: Complex): number => Math.atan2(a.im, a.re);

/** exp(j*phi) */
export const expj = (phi: number): Complex => ({ re: Math.cos(phi), im: Math.sin(phi) });

export const isZero = (a: Complex, eps = 1e-12): boolean => abs2(a) <= eps * eps;

/**
 * Quantize an amplitude (magnitude) to `levels` equally spaced levels in [0, 1].
 * levels = 4 -> {0, 1/3, 2/3, 1}. Nearest-level rounding (ties to nearest via round()).
 */
export function quantizeAmplitude(amplitude: number, levels: number): number {
  if (!Number.isFinite(amplitude) || amplitude < 0) {
    throw new RangeError("amplitude must be a finite non-negative number");
  }
  if (!Number.isInteger(levels) || levels < 2) {
    throw new RangeError("amplitudeLevels must be an integer >= 2");
  }
  const norm = Math.min(1, amplitude);
  const step = 1 / (levels - 1);
  const index = Math.round(norm / step);
  return Math.min(1, index * step);
}

/**
 * Quantize a phase to the nearest of `states` equally spaced states:
 * states = 4 -> {0, 90, 180, 270} deg. Output wrapped to (-pi, pi].
 */
export function quantizePhase(phi: number, states: number): number {
  if (!Number.isFinite(phi)) {
    throw new RangeError("phase must be finite");
  }
  if (!Number.isInteger(states) || states < 2) {
    throw new RangeError("phaseStates must be an integer >= 2");
  }
  const step = (2 * Math.PI) / states;
  const index = Math.round(phi / step);
  let q = index * step;
  q = ((q + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return q;
}
