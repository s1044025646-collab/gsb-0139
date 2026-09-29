import { ConfigRepository, type NewConfigInput } from "../db/repo.ts";
import { disableElement, quantizeWeights, steeringWeights } from "./array.ts";
import { AppError } from "./errors.ts";
import { analyzePattern, quantizationError } from "./pattern.ts";
import type {
  AngleGrid,
  ArrayConfig,
  PatternReport,
  QuantizationError,
  WeightSpec,
} from "./types.ts";

export class ArrayService {
  private readonly repo: ConfigRepository;

  constructor(repo: ConfigRepository) {
    this.repo = repo;
  }

  create(input: NewConfigInput): ArrayConfig {
    return this.repo.create(input);
  }

  get(id: number): ArrayConfig {
    return this.repo.getById(id);
  }

  // Generate a NEW steering-weight config version; baseline config is never rewritten.
  steer(
    parentId: number,
    steerAngleDeg: number,
    taper: "uniform" | "hann" | "hamming" = "uniform",
    idempotencyKey?: string,
  ): ArrayConfig {
    const parent = this.repo.getById(parentId);
    const positions = parent.elements.map((e) => e.x);
    const weights = steeringWeights(positions, parent.wavelength, steerAngleDeg, taper);
    // Disabled elements in the parent geometry must stay silent in the child.
    parent.elements.forEach((e, i) => {
      if (!e.enabled) weights[i] = { index: i, re: 0, im: 0 };
    });
    return this.repo.create({
      name: parent.name,
      wavelength: parent.wavelength,
      elements: parent.elements.map((e) => ({ ...e })),
      weights,
      steer_angle_deg: steerAngleDeg,
      taper,
      amp_bits: null,
      phase_bits: null,
      parent_config_id: parent.id,
      note: `steered to ${steerAngleDeg} deg with ${taper} taper`,
      idempotency_key: idempotencyKey ?? null,
    });
  }

  // Apply amp/phase quantization; stores the complex-weight error against the parent.
  quantize(
    parentId: number,
    ampBits: number | null,
    phaseBits: number | null,
    idempotencyKey?: string,
  ): { config: ArrayConfig; error: QuantizationError } {
    const parent = this.repo.getById(parentId);
    const weights = quantizeWeights(parent.weights, parent.elements, ampBits, phaseBits);
    const config = this.repo.create({
      name: parent.name,
      wavelength: parent.wavelength,
      elements: parent.elements.map((e) => ({ ...e })),
      weights,
      steer_angle_deg: parent.steer_angle_deg,
      taper: parent.taper,
      amp_bits: ampBits,
      phase_bits: phaseBits,
      parent_config_id: parent.id,
      note: `quantized amp=${ampBits ?? "-"}bits phase=${phaseBits ?? "-"}bits`,
      idempotency_key: idempotencyKey ?? null,
    });
    let error = this.repo.getQuantError(config.id);
    if (!error) {
      error = quantizationError(parent.weights, config.weights, ampBits, phaseBits);
      this.repo.saveQuantError(parent.id, config.id, error);
    }
    return { config, error };
  }

  // Fail one element: produce a NEW config; baseline weights are copied, not rewritten.
  disableElement(parentId: number, index: number, idempotencyKey?: string): ArrayConfig {
    const parent = this.repo.getById(parentId);
    if (!Number.isInteger(index) || index < 0 || index >= parent.elements.length) {
      throw new AppError("ELEMENT_OUT_OF_RANGE", `Element index ${index} out of range.`, {
        index,
        count: parent.elements.length,
      });
    }
    if (!parent.elements[index]!.enabled) {
      return this.repo.create({
        ...this.childBase(parent),
        note: `element ${index} was already disabled`,
        idempotency_key: idempotencyKey ?? null,
      });
    }
    const elements = parent.elements.map((e) =>
      e.index === index ? { ...e, enabled: false } : { ...e },
    );
    const weights = disableElement(parent.weights, index);
    return this.repo.create({
      name: parent.name,
      wavelength: parent.wavelength,
      elements,
      weights,
      steer_angle_deg: parent.steer_angle_deg,
      taper: parent.taper,
      amp_bits: parent.amp_bits,
      phase_bits: parent.phase_bits,
      parent_config_id: parent.id,
      note: `element ${index} failed`,
      idempotency_key: idempotencyKey ?? null,
    });
  }

  private childBase(parent: ArrayConfig): NewConfigInput {
    return {
      name: parent.name,
      wavelength: parent.wavelength,
      elements: parent.elements.map((e) => ({ ...e })),
      weights: parent.weights.map((w) => ({ ...w })),
      steer_angle_deg: parent.steer_angle_deg,
      taper: parent.taper,
      amp_bits: parent.amp_bits,
      phase_bits: parent.phase_bits,
      parent_config_id: parent.id,
      note: null,
    };
  }

  scan(configId: number, grid: AngleGrid, idempotencyKey?: string): {
    report: PatternReport;
    persisted: boolean;
  } {
    const config = this.repo.getById(configId);
    const key =
      idempotencyKey ??
      `scan:${configId}:${grid.start_deg}:${grid.stop_deg}:${grid.step_deg}`;
    const existing = this.repo.findReport(configId, key);
    if (existing) return { report: existing.report, persisted: true };
    const report = analyzePattern(
      config.elements,
      config.weights,
      config.wavelength,
      grid,
      config.steer_angle_deg,
    );
    this.repo.saveReport(configId, grid, report, key);
    return { report, persisted: false };
  }

  // Compare two configs over the same grid. Normalized patterns are scale-invariant.
  compare(aId: number, bId: number, grid: AngleGrid) {
    const a = this.repo.getById(aId);
    const b = this.repo.getById(bId);
    const ra = analyzePattern(a.elements, a.weights, a.wavelength, grid, a.steer_angle_deg);
    const rb = analyzePattern(b.elements, b.weights, b.wavelength, grid, b.steer_angle_deg);
    const weightPower = (w: WeightSpec[]) =>
      w.reduce((s, x) => s + x.re * x.re + x.im * x.im, 0);
    return {
      config_a: { id: a.id, version: a.version, weight_power: weightPower(a.weights) },
      config_b: { id: b.id, version: b.version, weight_power: weightPower(b.weights) },
      a: summary(ra),
      b: summary(rb),
      hpbw_delta_deg:
        ra.hpbw_deg !== null && rb.hpbw_deg !== null ? rb.hpbw_deg - ra.hpbw_deg : null,
      sll_delta_db:
        ra.sidelobe_level_db !== null && rb.sidelobe_level_db !== null
          ? rb.sidelobe_level_db - ra.sidelobe_level_db
          : null,
      peak_angle_delta_deg:
        ra.main_peak && rb.main_peak ? rb.main_peak.angle_deg - ra.main_peak.angle_deg : null,
      quant_error_b: this.repo.getQuantError(b.id),
    };
  }
}

export function summary(r: PatternReport) {
  return {
    all_zero_weights: r.all_zero_weights,
    unique_peak: r.unique_peak,
    multiple_equal_peaks: r.multiple_equal_peaks,
    grating_lobe: r.grating_lobe,
    grating_lobe_angles_deg: r.grating_lobe_angles_deg,
    main_peak: r.main_peak,
    hpbw_deg: r.hpbw_deg,
    main_lobe_incomplete: r.main_lobe_incomplete,
    sidelobe_level_db: r.sidelobe_level_db,
    sidelobe_peak: r.sidelobe_peak,
    max_field: r.max_field,
    sample_count: r.sample_count,
  };
}
