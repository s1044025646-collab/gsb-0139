import { cabs, cabs2 } from "./complex.ts";
import { allWeightsZero, arrayFactorAt, buildGrid } from "./array.ts";
import {
  CONVENTIONS,
  EQUAL_PEAK_TOLERANCE,
  GRATING_LOBE_THRESHOLD,
  HALF_POWER,
  type AngleGrid,
  type ElementSpec,
  type PatternReport,
  type PatternSample,
  type PeakInfo,
  type WeightSpec,
} from "./types.ts";

/**
 * Evaluate the full normalized power pattern and derive pattern metrics.
 *
 * @param steerHintDeg intended steering angle; used only to pick which full-scale
 *        lobe the HPBW/sidelobe metrics refer to when several lobes share the peak.
 *        It never overrides unique_peak / grating-lobe flags.
 */
export function analyzePattern(
  elements: readonly ElementSpec[],
  weights: readonly WeightSpec[],
  wavelength: number,
  grid: AngleGrid,
  steerHintDeg = 0,
): PatternReport {
  const angles = buildGrid(grid);
  const raw = angles.map((theta): PatternSample => {
    const af = arrayFactorAt(elements, weights, wavelength, theta);
    const field = cabs(af);
    return { angle_deg: theta, af, field, power_norm: 0, power_db: 0 };
  });
  const maxField = raw.reduce((m, s) => Math.max(m, s.field), 0);
  const maxPower = maxField * maxField;
  const allZero = allWeightsZero(weights, elements) || maxPower === 0;

  for (const s of raw) {
    s.power_norm = maxPower > 0 ? (s.field * s.field) / maxPower : 0;
    s.power_db = s.power_norm > 0 ? 10 * Math.log10(s.power_norm) : Number.NEGATIVE_INFINITY;
  }

  const base: PatternReport = {
    grid,
    sample_count: raw.length,
    all_zero_weights: allZero,
    max_field: maxField,
    peaks: [],
    multiple_equal_peaks: false,
    grating_lobe: false,
    grating_lobe_angles_deg: [],
    main_peak: null,
    unique_peak: false,
    hpbw_deg: null,
    hpbw_left_deg: null,
    hpbw_right_deg: null,
    main_lobe_incomplete: false,
    sidelobe_level_db: null,
    sidelobe_peak: null,
    samples: raw,
    conventions: { ...CONVENTIONS },
  };
  if (allZero) return base;

  const n = raw.length;
  const power = raw.map((s) => s.power_norm);
  const isBoundary = (i: number) => i === 0 || i === n - 1;

  // Global-maximum samples (equal-height tolerance). Equal maxima at different
  // angles mean pointing is ambiguous; never collapse them into one peak.
  const peakIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (power[i]! >= 1 - EQUAL_PEAK_TOLERANCE) peakIdx.push(i);
  }
  // A flat-topped region (e.g. a single isotropic element) contains no local
  // maximum at all: every peak sample has an equal-strength neighbour. Treat it
  // as having no selectable pointing rather than thousands of "peaks".
  const nearOne = (p: number) => p >= 1 - EQUAL_PEAK_TOLERANCE;
  const atLeftEdge = peakIdx.includes(0);
  const atRightEdge = peakIdx.includes(n - 1);

  // Interior samples that are global max but whose inward neighbour drops below
  // the peak: the inward "lip" of a boundary plateau (endfire steering).
  const rightLip =
    atRightEdge &&
    peakIdx.some((i) => i < n - 1 && !nearOne(power[i + 1]!));
  const leftLip =
    atLeftEdge &&
    peakIdx.some((i) => i > 0 && !nearOne(power[i - 1]!));

  // Genuine flat top (e.g. one isotropic element): no inward drop anywhere.
  const flatTop =
    peakIdx.length > 1 && !rightLip && !leftLip;

  const distinctPeakIdx: number[] = flatTop
    ? []
    : (() => {
        // Boundary plateau -> anchor at the boundary; otherwise keep isolated peaks.
        if (atRightEdge && rightLip && !(atLeftEdge && leftLip)) return [n - 1];
        if (atLeftEdge && leftLip && !(atRightEdge && rightLip)) return [0];
        if (atRightEdge && rightLip && atLeftEdge && leftLip) return [0, n - 1];
        return peakIdx.filter((i) => {
          const leftMax = i > 0 && nearOne(power[i - 1]!);
          const rightMax = i < n - 1 && nearOne(power[i + 1]!);
          return !(leftMax && rightMax);
        });
      })();
  const peaks: PeakInfo[] = distinctPeakIdx.map((i) => ({
    angle_deg: raw[i]!.angle_deg,
    power_norm: 1,
    at_boundary: isBoundary(i),
  }));
  if (flatTop) {
    return {
      ...base,
      peaks: [],
      multiple_equal_peaks: true,
      unique_peak: false,
      main_peak: null,
      main_lobe_incomplete: false,
    };
  }
  base.peaks = peaks;

  // Fully-formed interior local maxima: strictly above both immediate neighbours,
  // so a sample adjacent to the main peak can never be misread as a lobe.
  const interiorMax: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (power[i]! > power[i - 1]! && power[i]! > power[i + 1]!) interiorMax.push(i);
  }

  // A grating-lobe maximum need not sit exactly on a sample, so refine each
  // interior maximum with a 3-point quadratic fit (offset in *samples*, delta),
  // giving both its true angle and its height without changing the grid.
  const refine = (i: number): { angle: number; p: number } => {
    const ym = power[i - 1]!;
    const y0 = power[i]!;
    const yp = power[i + 1]!;
    const denom = ym - 2 * y0 + yp;
    let delta = 0;
    if (denom !== 0) delta = -0.5 * (yp - ym) / denom;
    delta = Math.max(-1, Math.min(1, delta));
    const p = y0 - 0.25 * (yp - ym) * delta;
    return { angle: raw[i]!.angle_deg + delta * grid.step_deg, p };
  };
  const globalSet = new Set(peakIdx);
  const refined = interiorMax
    .filter((i) => !globalSet.has(i))
    .map((i) => ({ i, ...refine(i) }));

  // Grating lobes: additional INTERIOR maxima essentially as strong as the peak.
  // Equal-height maxima that only occur on the +/-90 boundaries are endfire
  // aliases of the (incomplete) main lobe, not in-visible-region grating lobes.
  const grating = refined.filter((m) => m.p >= GRATING_LOBE_THRESHOLD);
  const gratingPeaks: PeakInfo[] = grating.map((m) => ({
    angle_deg: m.angle,
    power_norm: Math.min(1, m.p),
    at_boundary: false,
  }));
  if (gratingPeaks.length > 0) base.peaks = [...peaks, ...gratingPeaks];
  const interiorEqualPeaks = peaks.filter((p) => !p.at_boundary);
  base.grating_lobe = grating.length > 0 || interiorEqualPeaks.length > 1;
  base.grating_lobe_angles_deg = gratingPeaks.map((p) => p.angle_deg);
  base.multiple_equal_peaks = base.peaks.length > 1;

  // Main lobe anchor: the global peak nearest the intended steering angle.
  let mainIdx = distinctPeakIdx[0]!;
  let best = Math.abs(raw[mainIdx]!.angle_deg - steerHintDeg);
  for (const i of distinctPeakIdx) {
    const d = Math.abs(raw[i]!.angle_deg - steerHintDeg);
    if (d < best) {
      best = d;
      mainIdx = i;
    }
  }
  base.main_peak = peaks[distinctPeakIdx.indexOf(mainIdx)]!;
  base.unique_peak = peaks.length === 1 && !base.grating_lobe;

  // A peak sitting on the visible-region/grid edge cannot show a full main lobe.
  if (isBoundary(mainIdx)) {
    base.main_lobe_incomplete = true;
    return base;
  }

  // Half-power crossings, linearly interpolated between the bracketing samples.
  const crossing = (lo: number, hi: number): number => {
    const pLo = power[lo]!;
    const pHi = power[hi]!;
    const t = (HALF_POWER - pLo) / (pHi - pLo);
    return raw[lo]!.angle_deg + t * (raw[hi]!.angle_deg - raw[lo]!.angle_deg);
  };

  let leftDeg: number | null = null;
  let leftSpanIdx = -1;
  for (let i = mainIdx; i > 0; i--) {
    if (power[i - 1]! <= HALF_POWER) {
      if (power[i - 1]! === HALF_POWER) leftDeg = raw[i - 1]!.angle_deg;
      else leftDeg = crossing(i - 1, i);
      leftSpanIdx = i - 1;
      break;
    }
  }
  let rightDeg: number | null = null;
  let rightSpanIdx = -1;
  for (let i = mainIdx; i < n - 1; i++) {
    if (power[i + 1]! <= HALF_POWER) {
      if (power[i + 1]! === HALF_POWER) rightDeg = raw[i + 1]!.angle_deg;
      else rightDeg = crossing(i, i + 1);
      rightSpanIdx = i + 1;
      break;
    }
  }

  if (leftDeg === null || rightDeg === null) {
    // The -3 dB contour runs into the grid/visible-region edge: incomplete main lobe.
    base.main_lobe_incomplete = true;
    return base;
  }

  base.hpbw_left_deg = leftDeg;
  base.hpbw_right_deg = rightDeg;
  base.hpbw_deg = rightDeg - leftDeg;

  // Sidelobe search: strict interior local maxima strictly OUTSIDE the closed
  // main-lobe span [leftCross, rightCross]. This excludes the peak's neighbours.
  let sideIdx = -1;
  let sidePower = -1;
  for (const i of interiorMax) {
    if (i === mainIdx) continue;
    const angle = raw[i]!.angle_deg;
    const inside =
      (i < mainIdx && i > leftSpanIdx) || (i > mainIdx && i < rightSpanIdx);
    if (inside) continue;
    if (angle > leftDeg && angle < rightDeg) continue;
    if (power[i]! > sidePower) {
      sidePower = power[i]!;
      sideIdx = i;
    }
  }
  if (sideIdx >= 0) {
    const p = power[sideIdx]!;
    base.sidelobe_peak = {
      angle_deg: raw[sideIdx]!.angle_deg,
      power_norm: p,
      power_db: 10 * Math.log10(p),
    };
    base.sidelobe_level_db = 10 * Math.log10(p);
  }
  return base;
}

/** Complex-weight quantization error of wq relative to reference w. */
export function quantizationError(
  w: readonly WeightSpec[],
  wq: readonly WeightSpec[],
  ampBits: number | null,
  phaseBits: number | null,
) {
  let num = 0;
  let den = 0;
  let maxAbs = 0;
  for (let i = 0; i < w.length; i++) {
    const dr = wq[i]!.re - w[i]!.re;
    const di = wq[i]!.im - w[i]!.im;
    num += dr * dr + di * di;
    den += cabs2({ re: w[i]!.re, im: w[i]!.im });
    maxAbs = Math.max(maxAbs, Math.hypot(dr, di));
  }
  return {
    amp_bits: ampBits,
    phase_bits: phaseBits,
    normalized_mse: den > 0 ? num / den : 0,
    rms_error: Math.sqrt(num / Math.max(1, w.length)),
    max_abs_error: maxAbs,
  };
}
