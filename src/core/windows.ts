/**
 * Symmetric amplitude tapers for an N-element array (0-indexed).
 * Every window is normalized so its maximum is 1.
 */

export function uniform(n: number): number[] {
  return Array.from({ length: n }, () => 1);
}

export function hann(n: number): number[] {
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
}

export function hamming(n: number): number[] {
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
}

/** Symmetric triangular (Bartlett) taper. */
export function triangular(n: number): number[] {
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => 1 - Math.abs((2 * i - (n - 1)) / (n - 1)));
}

export const windows = { uniform, hann, hamming, triangular };
