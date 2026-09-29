import type { AngleGrid } from "../types.ts";

export const DEG2RAD = Math.PI / 180;

/**
 * Build the inclusive angle list from the grid specification using integer
 * step counts, avoiding floating-point accumulation error.
 */
export function angleList(grid: AngleGrid): number[] {
  validateGrid(grid);
  const span = grid.stopDeg - grid.startDeg;
  const count = Math.round(span / grid.stepDeg);
  const out: number[] = [];
  for (let i = 0; i <= count; i++) {
    const theta = grid.startDeg + i * grid.stepDeg;
    out.push(Number(theta.toFixed(10)));
  }
  return out;
}

export function validateGrid(grid: AngleGrid): void {
  if (
    typeof grid.startDeg !== "number" ||
    typeof grid.stopDeg !== "number" ||
    typeof grid.stepDeg !== "number" ||
    !Number.isFinite(grid.startDeg) ||
    !Number.isFinite(grid.stopDeg) ||
    !Number.isFinite(grid.stepDeg)
  ) {
    throw new RangeError("grid values must be finite numbers");
  }
  if (grid.startDeg < -90 || grid.stopDeg > 90 || grid.startDeg >= grid.stopDeg) {
    throw new RangeError("require -90 <= startDeg < stopDeg <= 90");
  }
  if (grid.stepDeg <= 0) {
    throw new RangeError("stepDeg must be positive");
  }
  const span = grid.stopDeg - grid.startDeg;
  if (Math.abs(span / grid.stepDeg - Math.round(span / grid.stepDeg)) > 1e-6) {
    throw new RangeError("(stopDeg - startDeg) must be an integer multiple of stepDeg");
  }
}

export const defaultGrid = (stepDeg = 0.1): AngleGrid => ({ startDeg: -90, stopDeg: 90, stepDeg });
