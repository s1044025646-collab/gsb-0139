import type { AngleGrid, ComparisonResult, Element, PatternReport } from "../types.ts";
import { analyzePattern } from "./analyze.ts";

export interface CompareInputs {
  base: { configId: number; configVersion: number; elements: Element[]; wavelength: number };
  candidate: { configId: number; configVersion: number; elements: Element[]; wavelength: number };
  grid: AngleGrid;
  generatedAt?: string | undefined;
}

function samplesByAngle(r: PatternReport): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of r.samples ?? []) m.set(s.thetaDeg, s.powerLinear);
  return m;
}

/**
 * Compare two configurations on a COMMON angle grid so angles pair exactly.
 * Metrics are computed on normalized linear power and on dB where defined.
 */
export function comparePatterns(input: CompareInputs): ComparisonResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const ra = analyzePattern({ ...input.base, grid: input.grid, generatedAt });
  const rb = analyzePattern({ ...input.candidate, grid: input.grid, generatedAt });
  const ma = samplesByAngle(ra);
  const mb = samplesByAngle(rb);
  const dba = new Map((ra.samples ?? []).map((s) => [s.thetaDeg, s.powerDb] as const));
  const dbb = new Map((rb.samples ?? []).map((s) => [s.thetaDeg, s.powerDb] as const));

  let maxAbs = 0;
  let sumAbs = 0;
  let n = 0;
  let angleMax = input.grid.startDeg;
  let maxDb: number | null = null;
  for (const [theta, pa] of ma) {
    const pb = mb.get(theta);
    if (pb === undefined) continue;
    const d = Math.abs(pa - pb);
    if (d > maxAbs) {
      maxAbs = d;
      angleMax = theta;
    }
    sumAbs += d;
    n++;
    const dA = dba.get(theta)!;
    const dB = dbb.get(theta)!;
    if (pa > 0 && pb > 0) {
      const dd = Math.abs(dA - dB);
      maxDb = maxDb === null ? dd : Math.max(maxDb, dd);
    }
  }

  const peakShift =
    ra.peakDirectionDeg !== null && rb.peakDirectionDeg !== null
      ? rb.peakDirectionDeg - ra.peakDirectionDeg
      : null;

  return {
    baseConfigId: input.base.configId,
    candidateConfigId: input.candidate.configId,
    grid: input.grid,
    maxAbsPowerDifference: maxAbs,
    meanAbsPowerDifference: n > 0 ? sumAbs / n : 0,
    maxAbsPowerDbDifference: maxDb,
    angleOfMaxDifferenceDeg: angleMax,
    peakDirectionShiftDeg: peakShift,
    hpbwBaseDeg: ra.mainLobe.hpbwDeg,
    hpbwDifferenceDeg:
      ra.mainLobe.hpbwDeg !== null && rb.mainLobe.hpbwDeg !== null
        ? rb.mainLobe.hpbwDeg - ra.mainLobe.hpbwDeg
        : null,
    sidelobeLevelDifferenceDb:
      ra.sidelobeLevelDb !== null && rb.sidelobeLevelDb !== null
        ? rb.sidelobeLevelDb - ra.sidelobeLevelDb
        : null,
  };
}
