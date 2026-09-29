import { AppError } from "./errors.ts";
import type { AngleGrid, ElementSpec, WeightSpec } from "./types.ts";

export interface CreateArrayInput {
  name?: unknown;
  wavelength?: unknown;
  positions?: unknown;
  spacing?: unknown;
  count?: unknown;
  weights?: unknown;
  idempotency_key?: unknown;
  note?: unknown;
}

export function requireFinitePositive(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a finite positive number.`, { field, value });
  }
  return n;
}

export function requireString(value: unknown, field: string, maxLen = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a non-empty string up to ${maxLen} chars.`, { field });
  }
  return value;
}

/** Resolve positions either explicitly or from count + uniform spacing. */
export function resolvePositions(input: CreateArrayInput): number[] {
  if (input.positions !== undefined) {
    if (!Array.isArray(input.positions) || input.positions.length === 0) {
      throw new AppError("VALIDATION_ERROR", "positions must be a non-empty number array.");
    }
    return input.positions.map((p, i) => {
      const x = Number(p);
      if (!Number.isFinite(x)) {
        throw new AppError("VALIDATION_ERROR", `positions[${i}] must be finite.`);
      }
      return x;
    });
  }
  const count = Number(input.count);
  const spacing = Number(input.spacing);
  if (!Number.isInteger(count) || count < 1) {
    throw new AppError("VALIDATION_ERROR", "count must be a positive integer (or supply positions).");
  }
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw new AppError("VALIDATION_ERROR", "spacing must be a finite positive number (or supply positions).");
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((i - (count - 1) / 2) * spacing);
  return out;
}

export function buildElements(positions: readonly number[]): ElementSpec[] {
  const seen = new Set<number>();
  return positions.map((x, i) => {
    const key = Math.round(x * 1e12);
    if (seen.has(key)) {
      throw new AppError("DUPLICATE_POSITION", `Duplicate element position at index ${i} (x=${x}).`, {
        index: i,
        x,
      });
    }
    seen.add(key);
    return { index: i, x, enabled: true };
  });
}

export function defaultWeights(count: number): WeightSpec[] {
  return Array.from({ length: count }, (_, i) => ({ index: i, re: 1, im: 0 }));
}

export function parseWeights(value: unknown, count: number): WeightSpec[] {
  if (value === undefined || value === null) return defaultWeights(count);
  if (!Array.isArray(value) || value.length !== count) {
    throw new AppError("VALIDATION_ERROR", `weights must be an array of length ${count}.`, {
      expected: count,
    });
  }
  return value.map((w, i) => {
    const re = Number((w as { re?: unknown })?.re);
    const im = Number((w as { im?: unknown })?.im ?? 0);
    if (!Number.isFinite(re) || !Number.isFinite(im)) {
      throw new AppError("VALIDATION_ERROR", `weights[${i}] must have finite numeric re/im.`);
    }
    return { index: i, re, im };
  });
}

export function validateGrid(start: unknown, stop: unknown, step: unknown): AngleGrid {
  const s = Number(start);
  const e = Number(stop);
  const d = Number(step);
  if (![-90, 90].includes(s) || ![-90, 90].includes(e)) {
    throw new AppError("BAD_GRID", "start/stop must each be -90 or 90.", { start: s, stop: e });
  }
  if (!(e > s)) {
    throw new AppError("BAD_GRID", "stop must be greater than start.", { start: s, stop: e });
  }
  if (!Number.isFinite(d) || d <= 0 || d > e - s) {
    throw new AppError("BAD_GRID", "step must be finite, positive and no larger than the span.", { step: d });
  }
  return { start_deg: s, stop_deg: e, step_deg: d };
}

export function validateSteerAngle(value: unknown): number {
  const a = Number(value);
  if (!Number.isFinite(a) || a < -90 || a > 90) {
    throw new AppError("VALIDATION_ERROR", "steer_angle_deg must be in [-90, 90].", { value });
  }
  return a;
}

export function validateBitDepth(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const b = Number(value);
  if (!Number.isInteger(b) || b < 1 || b > 32) {
    throw new AppError("VALIDATION_ERROR", `${field} must be an integer 1..32 or null.`, { value });
  }
  return b;
}
