import { c } from "../src/core/complex.ts";
import { windows } from "../src/core/windows.ts";
import type { Complex, Element } from "../src/types.ts";

export interface Fixture {
  name: string;
  wavelength: number;
  positions: number[];
  weights: Complex[];
  /** Analytical expectation markers (used by tests). */
  expect?: {
    peakDeg?: number;
    grating?: boolean;
  };
}

/** Uniform positions with spacing d, optionally centered around 0. */
export function uniformPositions(n: number, d: number, centered = false): number[] {
  const shift = centered ? -((n - 1) * d) / 2 : 0;
  return Array.from({ length: n }, (_, i) => shift + i * d);
}

export function uniformWeights(n: number): Complex[] {
  return Array.from({ length: n }, () => c(1));
}

export function toElements(positions: number[], weights: Complex[], disabled: number[] = []): Element[] {
  return positions.map((position, index) => ({
    index,
    position,
    weight: disabled.includes(index) ? c(0) : weights[index]!,
    enabled: !disabled.includes(index),
  }));
}

/** The required synthetic fixture set. */
export function fixtures(): {
  single: Fixture;
  two: Fixture;
  halfWaveULA: Fixture;
  hanned: Fixture;
  grating: Fixture;
  edgeSteered: Fixture;
} {
  const wavelength = 1;

  // 1) Single element: flat 0 dB pattern, no unique pointing / HPBW.
  const single: Fixture = { name: "single", wavelength, positions: [0], weights: [c(1)] };

  // 2) Two half-wave spaced elements broadside: analytic AF = 2 cos(pi/2 sin theta).
  const two: Fixture = {
    name: "two",
    wavelength,
    positions: uniformPositions(2, 0.5, true),
    weights: uniformWeights(2),
    expect: { peakDeg: 0 },
  };

  // 3) N=8 half-wave ULA broadside.
  const n8 = 8;
  const halfWaveULA: Fixture = {
    name: "halfWaveULA",
    wavelength,
    positions: uniformPositions(n8, 0.5, true),
    weights: uniformWeights(n8),
    expect: { peakDeg: 0, grating: false },
  };

  // 4) Same ULA with Hann taper: lower sidelobes, wider beam.
  const hanned: Fixture = {
    name: "hanned",
    wavelength,
    positions: uniformPositions(n8, 0.5, true),
    weights: windows.hann(n8).map((a) => c(a)),
    expect: { peakDeg: 0, grating: false },
  };

  // 5) d = 0.9 wavelength: grating lobes enter visible space when steered.
  const grating: Fixture = {
    name: "grating-d0.9-steered30",
    wavelength,
    positions: uniformPositions(n8, 0.9, true),
    weights: uniformWeights(n8), // weights are replaced with steered weights in tests
    expect: { peakDeg: 30, grating: true },
  };

  // 6) Half-wave ULA steered to the edge (60 deg): main lobe meets the
  // endfire boundary and may be incomplete on that side.
  const edgeSteered: Fixture = {
    name: "edge-steered60",
    wavelength,
    positions: uniformPositions(n8, 0.5, true),
    weights: uniformWeights(n8),
    expect: { peakDeg: 60 },
  };

  return { single, two, halfWaveULA, hanned, grating, edgeSteered };
}
