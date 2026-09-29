import { uniformPositions, steeringWeights, quantizeWeights } from "../src/core/array.ts";
import type { ElementSpec, WeightSpec } from "../src/core/types.ts";

export interface Fixture {
  name: string;
  description: string;
  wavelength: number;
  elements: ElementSpec[];
  weights: WeightSpec[];
  steer_angle_deg: number;
}

const elementsOf = (positions: number[]): ElementSpec[] =>
  positions.map((x, i) => ({ index: i, x, enabled: true }));

const WAVELENGTH = 0.1;

export function singleElementFixture(): Fixture {
  return {
    name: "single",
    description: "One isotropic element: omni pattern, no beamwidth/sidelobes.",
    wavelength: WAVELENGTH,
    elements: elementsOf([0]),
    weights: [{ index: 0, re: 1, im: 0 }],
    steer_angle_deg: 0,
  };
}

export function twoElementFixture(spacingWavelengths = 0.5, steerDeg = 0): Fixture {
  const d = spacingWavelengths * WAVELENGTH;
  const positions = uniformPositions(2, d);
  return {
    name: "dual",
    description: `Two elements spaced ${spacingWavelengths} lambda, steered ${steerDeg} deg.`,
    wavelength: WAVELENGTH,
    elements: elementsOf(positions),
    weights: steeringWeights(positions, WAVELENGTH, steerDeg),
    steer_angle_deg: steerDeg,
  };
}

export function halfWaveUlaFixture(count = 8, steerDeg = 0): Fixture {
  const d = 0.5 * WAVELENGTH;
  const positions = uniformPositions(count, d);
  return {
    name: "ula-halfwave",
    description: `${count}-element uniform linear array, d = lambda/2, steer ${steerDeg} deg.`,
    wavelength: WAVELENGTH,
    elements: elementsOf(positions),
    weights: steeringWeights(positions, WAVELENGTH, steerDeg),
    steer_angle_deg: steerDeg,
  };
}

export function windowedUlaFixture(
  count = 8,
  taper: "hann" | "hamming" = "hann",
  steerDeg = 0,
): Fixture {
  const d = 0.5 * WAVELENGTH;
  const positions = uniformPositions(count, d);
  return {
    name: `ula-${taper}`,
    description: `${count}-element lambda/2 ULA with ${taper} amplitude taper.`,
    wavelength: WAVELENGTH,
    elements: elementsOf(positions),
    weights: steeringWeights(positions, WAVELENGTH, steerDeg, taper),
    steer_angle_deg: steerDeg,
  };
}

export function gratingLobeFixture(
 spacingWavelengths = 1.2,
  steerDeg = 0,
): Fixture {
  // d > lambda puts aliases of the broadside peak inside the visible region:
  // sin(theta_g) = +/- lambda/d. At 1.2 lambda -> +/-56.4 deg.
  const d = spacingWavelengths * WAVELENGTH;
  const positions = uniformPositions(10, d);
  return {
    name: "grating",
    description: `10-element ULA at d = ${spacingWavelengths} lambda: grating lobes in visible region.`,
    wavelength: WAVELENGTH,
    elements: elementsOf(positions),
    weights: steeringWeights(positions, WAVELENGTH, steerDeg),
    steer_angle_deg: steerDeg,
  };
}

export function edgeSteeredFixture(count = 8): Fixture {
  // Steering exactly to endfire (+90): main-peak sample lies on the visible edge,
  // so the half-power main lobe cannot be fully enclosed.
  return halfWaveUlaFixture(count, 90);
}

export function quantizedFixture(
  count = 8,
  phaseBits = 2,
  ampBits: number | null = null,
  steerDeg = 30,
): Fixture & { reference_weights: WeightSpec[] } {
  const base = halfWaveUlaFixture(count, steerDeg);
  const reference = base.weights;
  return {
    ...base,
    name: "quantized",
    description: `${count}-element ULA steered ${steerDeg} deg with ${phaseBits}-bit phase quantization.`,
    weights: quantizeWeights(reference, base.elements, ampBits, phaseBits),
    reference_weights: reference,
  };
}

export function allZeroFixture(count = 4): Fixture {
  const base = halfWaveUlaFixture(count, 0);
  return {
    ...base,
    name: "all-zero",
    description: "Uniform weights all forced to zero: no radiation.",
    weights: base.weights.map((w) => ({ ...w, re: 0, im: 0 })),
  };
}

export function allFixtures(): Fixture[] {
  return [
    singleElementFixture(),
    twoElementFixture(),
    halfWaveUlaFixture(),
    windowedUlaFixture(),
    gratingLobeFixture(),
    edgeSteeredFixture(),
    allZeroFixture(),
  ];
}
