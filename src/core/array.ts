import type { Complex, Element, Quantization } from "../types.ts";
import { c, expj, mul, phase, abs, quantizeAmplitude, quantizePhase } from "./complex.ts";
import { DEG2RAD } from "./grid.ts";

export function validateWavelength(wavelength: number): void {
  if (typeof wavelength !== "number" || !Number.isFinite(wavelength) || wavelength <= 0) {
    throw new RangeError("wavelength must be a finite positive number");
  }
}

export function validatePositions(positions: number[]): void {
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new RangeError("at least one element position is required");
  }
  for (const p of positions) {
    if (typeof p !== "number" || !Number.isFinite(p)) {
      throw new RangeError("element positions must be finite numbers");
    }
  }
  for (let i = 1; i < positions.length; i++) {
    if (positions[i]! <= positions[i - 1]!) {
      throw new RangeError("element positions must be strictly increasing");
    }
  }
}

export function validateSteerAngle(thetaDeg: number): void {
  if (typeof thetaDeg !== "number" || !Number.isFinite(thetaDeg) || thetaDeg < -90 || thetaDeg > 90) {
    throw new RangeError("steer angle must be a finite number within [-90, 90] degrees");
  }
}

/**
 * Phase-only steering weights for a uniform-magnitude excitation.
 * w_n = exp(-j k x_n sin(theta0)), k = 2 pi / lambda.
 * Magnitudes are 1; normalization of the power pattern is applied at analysis
 * time, so global weight scaling never changes the reported pattern.
 */
export function steeringWeights(positions: number[], wavelength: number, steerAngleDeg: number): Complex[] {
  validatePositions(positions);
  validateWavelength(wavelength);
  validateSteerAngle(steerAngleDeg);
  const k = (2 * Math.PI) / wavelength;
  const phaseSlope = k * Math.sin(steerAngleDeg * DEG2RAD);
  return positions.map((x) => expj(-phaseSlope * x));
}

/** Apply a real amplitude taper/window to existing weights. */
export function applyTaper(weights: Complex[], taper: number[]): Complex[] {
  if (taper.length !== weights.length) {
    throw new RangeError("taper length must match number of elements");
  }
  return weights.map((w, i) => {
    const t = taper[i]!;
    if (!Number.isFinite(t) || t < 0) {
      throw new RangeError("taper values must be finite non-negative numbers");
    }
    return { re: w.re * t, im: w.im * t };
  });
}

/**
 * Apply amplitude/phase quantization to each weight.
 * Amplitude is normalized relative to the largest magnitude in the set so the
 * quantizer always spans [0, 1]; a uniform global scale factor is reported back
 * out via `referenceAmplitude` if callers need it (pattern analysis normalizes
 * anyway). Zero weights stay zero.
 */
export function applyQuantization(weights: Complex[], q: Quantization): { weights: Complex[]; referenceAmplitude: number } {
  let referenceAmplitude = 0;
  for (const w of weights) referenceAmplitude = Math.max(referenceAmplitude, abs(w));
  const out = weights.map((w) => {
    const mag = abs(w);
    if (mag === 0) return c(0);
    const phi = phase(w);
    const qMag = q.amplitudeLevels != null ? quantizeAmplitude(mag / referenceAmplitude, q.amplitudeLevels) * referenceAmplitude : mag;
    const qPhi = q.phaseStates != null ? quantizePhase(phi, q.phaseStates) : phi;
    return mul(c(qMag), expj(qPhi));
  });
  return { weights: out, referenceAmplitude };
}

/**
 * Disable one element: returns a NEW element list with that element's weight
 * forced to zero and enabled=false. Baseline weights of other elements are not
 * rewritten or renormalized.
 */
export function disableElement(elements: Element[], index: number): Element[] {
  if (!Number.isInteger(index) || index < 0 || index >= elements.length) {
    throw new RangeError(`element index ${index} out of range [0, ${elements.length - 1}]`);
  }
  return elements.map((el) =>
    el.index === index ? { ...el, enabled: false, weight: c(0) } : { ...el },
  );
}

/** Array factor at one angle: AF = sum w_n exp(+j k x_n sin theta). */
export function arrayFactorAt(elements: Element[], wavelength: number, thetaDeg: number): Complex {
  const k = (2 * Math.PI) / wavelength;
  const spatial = k * Math.sin(thetaDeg * DEG2RAD);
  let re = 0;
  let im = 0;
  for (const el of elements) {
    if (!el.enabled) continue;
    const ph = spatial * el.position;
    re += el.weight.re * Math.cos(ph) - el.weight.im * Math.sin(ph);
    im += el.weight.re * Math.sin(ph) + el.weight.im * Math.cos(ph);
  }
  return { re, im };
}

export function buildElements(positions: number[], weights: Complex[]): Element[] {
  if (positions.length !== weights.length) {
    throw new RangeError("positions and weights must have equal length");
  }
  return positions.map((position, index) => ({ index, position, weight: weights[index]!, enabled: true }));
}
