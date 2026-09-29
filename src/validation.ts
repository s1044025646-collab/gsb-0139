import type { AngleGrid, Complex, Quantization } from "./types.ts";
import { validateGrid } from "./core/grid.ts";
import { validatePositions, validateSteerAngle, validateWavelength } from "./core/array.ts";

export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly field: string | null;
  constructor(message: string, field: string | null = null) {
    super(message);
    this.field = field;
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown, field: string, { max = 200, optional = false }: { max?: number; optional?: boolean } = {}): string | null {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`, field);
  if (v.length === 0) throw new ValidationError(`${field} must not be empty`, field);
  if (v.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  return v;
}

export function num(v: unknown, field: string, { min, max, optional = false }: { min?: number | undefined; max?: number | undefined; optional?: boolean } = {}): number | null {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(`${field} must be a finite number`, field);
  }
  if (min !== undefined && v < min) throw new ValidationError(`${field} must be >= ${min}`, field);
  if (max !== undefined && v > max) throw new ValidationError(`${field} must be <= ${max}`, field);
  return v;
}

export function int(v: unknown, field: string, { min, max }: { min?: number | undefined; max?: number | undefined } = {}): number {
  const n = num(v, field);
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be an integer`, field);
  if (min !== undefined && n! < min) throw new ValidationError(`${field} must be >= ${min}`, field);
  if (max !== undefined && n! > max) throw new ValidationError(`${field} must be <= ${max}`, field);
  return n!;
}

export function complexList(v: unknown, field: string): Complex[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ValidationError(`${field} must be a non-empty array`, field);
  }
  return v.map((item, i) => {
    if (!isObject(item) || typeof item.re !== "number" || typeof item.im !== "number") {
      throw new ValidationError(`${field}[${i}] must be {re:number, im:number}`, `${field}[${i}]`);
    }
    if (!Number.isFinite(item.re) || !Number.isFinite(item.im)) {
      throw new ValidationError(`${field}[${i}] components must be finite`, `${field}[${i}]`);
    }
    return { re: item.re, im: item.im };
  });
}

export function numberList(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ValidationError(`${field} must be a non-empty array of numbers`, field);
  }
  const out = v.map((x, i) => {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new ValidationError(`${field}[${i}] must be a finite number`, `${field}[${i}]`);
    }
    return x;
  });
  validatePositions(out);
  return out;
}

export function parseQuantization(v: unknown, field: string): Quantization | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) throw new ValidationError(`${field} must be an object`, field);
  const amplitudeLevels =
    v.amplitudeLevels === undefined || v.amplitudeLevels === null
      ? null
      : int(v.amplitudeLevels, `${field}.amplitudeLevels`, { min: 2, max: 65536 });
  const phaseStates =
    v.phaseStates === undefined || v.phaseStates === null
      ? null
      : int(v.phaseStates, `${field}.phaseStates`, { min: 2, max: 65536 });
  return { amplitudeLevels, phaseStates };
}

export function parseGrid(v: unknown): AngleGrid {
  const g = isObject(v)
    ? {
        startDeg: v.startDeg === undefined ? -90 : v.startDeg,
        stopDeg: v.stopDeg === undefined ? 90 : v.stopDeg,
        stepDeg: v.stepDeg === undefined ? 0.1 : v.stepDeg,
      }
    : { startDeg: -90, stopDeg: 90, stepDeg: typeof v === "number" ? v : 0.1 };
  const coerce = (x: unknown): number => (typeof x === "string" ? Number(x) : (x as number));
  const grid: AngleGrid = {
    startDeg: num(coerce(g.startDeg), "startDeg")!,
    stopDeg: num(coerce(g.stopDeg), "stopDeg")!,
    stepDeg: num(coerce(g.stepDeg), "stepDeg", { min: 1e-6, max: 90 })!,
  };
  validateGrid(grid);
  return grid;
}

export { validateWavelength, validateSteerAngle };
