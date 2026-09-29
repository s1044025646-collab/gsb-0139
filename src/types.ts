/**
 * Domain types for the 1-D isotropic linear-array evaluation backend.
 *
 * Angle convention (documented everywhere reports are produced):
 *  - theta is the angle from the array BROADSIDE axis (the axis normal to the
 *    line of elements). Elements lie on the x-axis; broadside is theta = 0.
 *  - theta domain is [-90, +90] degrees. Endfire corresponds to +/- 90.
 *  - Element positions x_n are given in the SAME length unit as wavelength.
 *
 * Phase/sign convention:
 *  - Time dependence exp(+j omega t). A far-field plane wave arriving from
 *    direction theta travels an extra distance x_n sin(theta) to element n,
 *    i.e. its phase at element n is +k x_n sin(theta).
 *  - The weight that STEERS the beam toward theta0 is therefore
 *        w_n = a_n exp(-j k x_n sin(theta0))
 *    so that weight phase cancels the incoming phase at theta0 and all
 *    contributions add in phase.
 *  - Array factor: AF(theta) = sum_n w_n exp(+j k x_n sin(theta)).
 */

export interface Complex {
  re: number;
  im: number;
}

/** Position and (optional) current complex weight of one element. */
export interface Element {
  /** Index in the array, 0-based. */
  index: number;
  /** Position along the line, in the same unit as wavelength. */
  position: number;
  /** Complex weight. Absent/zero means the element contributes nothing. */
  weight: Complex;
  /** A disabled element is kept in the layout but forced to zero weight. */
  enabled: boolean;
}

/** Amplitude/phase quantization specification. */
export interface Quantization {
  /** Number of amplitude steps including zero; e.g. 4 => 0, 1/3, 2/3, 1. null/undefined = no amplitude quantization. */
  amplitudeLevels: number | null;
  /** Number of phase states around the circle; e.g. 2 => 0/180, 4 => 4-bit? no: 4 => 0/90/180/270. null = none. */
  phaseStates: number | null;
}

/** Angular sampling specification. */
export interface AngleGrid {
  /** Start angle in degrees (inclusive), typically -90. */
  startDeg: number;
  /** End angle in degrees (inclusive), typically 90. */
  stopDeg: number;
  /** Step in degrees. Must be positive. */
  stepDeg: number;
}

/** A stored array configuration (one version). */
export interface Config {
  id: number;
  /** Client-supplied idempotency key; unique. */
  idempotencyKey: string | null;
  name: string;
  wavelength: number;
  /** Freeze of the element layout+weights at creation time, as JSON. */
  elements: Element[];
  /** Steered target angle in degrees (broadside = 0). */
  steerAngleDeg: number | null;
  quantization: Quantization | null;
  /** Id of the config this one was derived from. */
  parentId: number | null;
  note: string | null;
  createdAt: string;
  version: number;
}

export interface PatternSample {
  thetaDeg: number;
  /** Complex array factor at this angle. */
  af: Complex;
  /** |AF|^2 normalized to the pattern peak (linear power). */
  powerLinear: number;
  /** 10 log10(powerLinear), dB. -Infinity for zero. */
  powerDb: number;
}

export interface Peak {
  thetaDeg: number;
  powerDb: number;
  /** Index into the sample list. */
  sampleIndex: number;
}

export interface MainLobeResult {
  /** True when the -3 dB boundary exists on both sides of the peak. */
  complete: boolean;
  leftHalfPowerDeg: number | null;
  rightHalfPowerDeg: number | null;
  /** Half-power beam width in degrees; null when not fully formed. */
  hpbwDeg: number | null;
}

export interface PatternReport {
  configId: number;
  configVersion: number;
  grid: AngleGrid;
  generatedAt: string;
  convention: {
    angleReference: string;
    phaseSign: string;
    powerDefinition: string;
  };
  /** True when every weight is zero (or no enabled elements). */
  allZeroWeights: boolean;
  /** Global maximum samples; more than one indicates grating/ambiguous lobes. */
  globalPeaks: Peak[];
  /** True when multiple samples attain (within tolerance) the global maximum. */
  multipleEqualPeaks: boolean;
  /** True when a full-strength lobe other than the main lobe is detected. */
  gratingLobe: boolean;
  peakDirectionDeg: number | null;
  mainLobe: MainLobeResult;
  /** Highest sidelobe level relative to the peak, in dB (negative or null). */
  sidelobeLevelDb: number | null;
  sidelobePeak: Peak | null;
  /** Secondary lobes that are NOT at full strength (informational). */
  sidelobePeaks: Peak[];
  /** The full per-angle data (omitted from list responses; present on scan/export). */
  samples?: PatternSample[];
  modelLimitations: string[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Quantitative comparison of two config versions scanned on a shared grid. */
export interface ComparisonResult {
  baseConfigId: number;
  candidateConfigId: number;
  grid: AngleGrid;
  /** max |P_a(theta) - P_b(theta)| over the common grid, linear power. */
  maxAbsPowerDifference: number;
  /** Mean absolute difference of normalized linear power. */
  meanAbsPowerDifference: number;
  /** max |dB_a - dB_b| ignoring angles where either is -Inf. */
  maxAbsPowerDbDifference: number | null;
  /** Angle (deg) of the maximum linear-power difference. */
  angleOfMaxDifferenceDeg: number;
  peakDirectionShiftDeg: number | null;
  hpbwBaseDeg: number | null;
  hpbwDifferenceDeg: number | null;
  sidelobeLevelDifferenceDb: number | null;
}
