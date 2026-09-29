import type { AngleGrid, Complex, Config, Element, PatternReport, Quantization } from "./types.ts";
import { AppDatabase } from "./db.ts";
import { analyzePattern } from "./core/analyze.ts";
import { comparePatterns } from "./core/compare.ts";
import {
  applyQuantization,
  applyTaper,
  buildElements,
  disableElement,
  steeringWeights,
} from "./core/array.ts";
import { c } from "./core/complex.ts";
import { NotFoundError } from "./validation.ts";

export interface CreateArrayInput {
  name: string;
  wavelength: number;
  positions: number[];
  steerAngleDeg?: number | null;
  taper?: number[] | null;
  note?: string | null;
}

export interface DeriveOptions {
  idempotencyKey?: string | null;
  now?: string;
}

export class ArrayService {
  readonly db: AppDatabase;
  constructor(db: AppDatabase) {
    this.db = db;
  }

/**
 * Create an initial array: positions + wavelength + optional steering and
 * taper. Weights are unit-amplitude phased weights (or explicit taper).
 */
  createArray(input: CreateArrayInput, opts: DeriveOptions = {}): Config {
    const steer = input.steerAngleDeg ?? null;
    const weights: Complex[] =
      steer === null
        ? input.positions.map(() => c(1))
        : steeringWeights(input.positions, input.wavelength, steer);
    const finalWeights = input.taper ? applyTaper(weights, input.taper) : weights;
    const elements = buildElements(input.positions, finalWeights);
    return this.db.createConfig(
      {
        name: input.name,
        wavelength: input.wavelength,
        elements,
        steerAngleDeg: steer,
        quantization: null,
        parentId: null,
        note: input.note ?? null,
      },
      opts,
    );
  }

  private require(id: number): Config {
    const cfg = this.db.getConfig(id);
    if (!cfg) throw new NotFoundError(`config ${id} not found`);
    return cfg;
  }

  /** Derive a new version with steering weights regenerated for theta0. */
  steer(id: number, steerAngleDeg: number, opts: DeriveOptions = {}): Config {
    const base = this.require(id);
    const positions = base.elements.map((e) => e.position);
    // Preserve each element's amplitude (taper / disabled state), replace phase.
    const baseMag = base.elements.map((e) => Math.hypot(e.weight.re, e.weight.im));
    const phases = steeringWeights(positions, base.wavelength, steerAngleDeg);
    const elements = buildElements(
      positions,
      phases.map((p, i) => ({ re: p.re * baseMag[i]!, im: p.im * baseMag[i]! })),
    ).map((e, i) => (base.elements[i]!.enabled ? e : { ...e, enabled: false, weight: c(0) }));
    return this.db.createConfig(
      {
        name: base.name,
        wavelength: base.wavelength,
        elements,
        steerAngleDeg,
        quantization: base.quantization,
        parentId: base.id,
        note: `steered to ${steerAngleDeg} deg`,
      },
      opts,
    );
  }

  /**
   * Apply amplitude/phase quantization. Produces a NEW version; baseline
   * weights remain untouched in the parent config.
   */
  quantize(id: number, q: Quantization, opts: DeriveOptions = {}): Config {
    const base = this.require(id);
    const weights = base.elements.map((e) => e.weight);
    const { weights: qw } = applyQuantization(weights, q);
    const elements: Element[] = base.elements.map((e, i) => ({
      ...e,
      weight: base.elements[i]!.enabled ? qw[i]! : c(0),
    }));
    return this.db.createConfig(
      {
        name: base.name,
        wavelength: base.wavelength,
        elements,
        steerAngleDeg: base.steerAngleDeg,
        quantization: q,
        parentId: base.id,
        note: `quantized A=${q.amplitudeLevels ?? "-"} levels / P=${q.phaseStates ?? "-"} states`,
      },
      opts,
    );
  }

  /**
   * Disable a single failed element. Baseline weights of every OTHER element
   * are kept exactly as-is (no renormalization). New version only.
   */
  disable(id: number, elementIndex: number, opts: DeriveOptions = {}): Config {
    const base = this.require(id);
    const elements = disableElement(base.elements, elementIndex);
    return this.db.createConfig(
      {
        name: base.name,
        wavelength: base.wavelength,
        elements,
        steerAngleDeg: base.steerAngleDeg,
        quantization: base.quantization,
        parentId: base.id,
        note: `element ${elementIndex} disabled`,
      },
      opts,
    );
  }

  scan(id: number, grid: AngleGrid, opts: { now?: string } = {}): PatternReport {
    const cfg = this.require(id);
    return analyzePattern({
      configId: cfg.id,
      configVersion: cfg.version,
      elements: cfg.elements,
      wavelength: cfg.wavelength,
      grid,
      generatedAt: opts.now,
    });
  }

  compare(baseId: number, candidateId: number, grid: AngleGrid, opts: { now?: string } = {}) {
    const base = this.require(baseId);
    const cand = this.require(candidateId);
    return comparePatterns({
      base: { configId: base.id, configVersion: base.version, elements: base.elements, wavelength: base.wavelength },
      candidate: { configId: cand.id, configVersion: cand.version, elements: cand.elements, wavelength: cand.wavelength },
      grid,
      generatedAt: opts.now,
    });
  }
}
