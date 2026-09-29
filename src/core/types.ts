/**
 * Domain types for the 1-D linear array evaluation backend.
 *
 * Angle convention (documented everywhere a report is produced):
 *  - theta is measured from the array NORMAL (broadside axis): theta = 0 at broadside,
 *    theta = +/-90 deg along the array axis (endfire). Visible region: [-90, 90].
 *  - Elements lie on the x axis at positions x_n (metres); wave number k = 2*pi/lambda.
 *  - Far-field array factor (isotropic elements, NO mutual coupling, NO element pattern):
 *        AF(theta) = SUM_n w_n * exp(+j * k * x_n * sin(theta))
 *    where w_n = a_n * exp(-j phi_n). The "+j" spatial phase sign means the phase
 *    progression that steers the beam to theta0 is phi_n = k*x_n*sin(theta0), i.e.
 *    w_n = a_n * exp(-j*k*x_n*sin(theta0)).
 *  - Field amplitude: |AF| (linear, volts-like). Power pattern: |AF|^2.
 *  - dB for POWER pattern: 10*log10(P/Pmax). Field-to-dB would use 20*log10;
 *    this project always quotes normalized POWER in dB, so the factor is 10.
 */

export interface Complex {
  re: number;
  im: number;
}

export interface ElementSpec {
  /** Element index in the geometry (0-based). */
  index: number;
  /** Position along the array axis in metres. */
  x: number;
  /** True when enabled; false = failed element, its weight is forced to 0. */
  enabled: boolean;
}

export interface WeightSpec {
  index: number;
  /** Complex weight w_n (arbitrary complex value; tapers typically use re >= 0, im = 0). */
  re: number;
  im: number;
}

export interface ArrayConfig {
  id: number;
  /** Stable client-supplied idempotency key for repeated submissions. */
  idempotency_key: string | null;
  name: string;
  wavelength: number;
  elements: ElementSpec[];
  weights: WeightSpec[];
  /** Intended scan/steering angle in degrees (informational; steering encoded in weights). */
  steer_angle_deg: number;
  /** Taper label used when weights were generated ("uniform", "hann", ...). */
  taper: string | null;
  /** Amplitude quantization bits (null = unquantized). */
  amp_bits: number | null;
  /** Phase quantization bits (null = unquantized). */
  phase_bits: number | null;
  parent_config_id: number | null;
  note: string | null;
  version: number;
  created_at: string;
}

export interface AngleGrid {
  /** Inclusive start angle, degrees. */
  start_deg: number;
  /** Inclusive end angle, degrees. */
  stop_deg: number;
  /** Constant step, degrees. Must be > 0. */
  step_deg: number;
}

export interface PatternSample {
  angle_deg: number;
  /** Complex array factor value. */
  af: Complex;
  /** Linear field magnitude |AF|. */
  field: number;
  /** Linear normalized power |AF|^2 / max|AF|^2 in [0,1]. */
  power_norm: number;
  /** Normalized power in dB (10 log10), -Infinity for exact zeros. */
  power_db: number;
}

export interface PeakInfo {
  angle_deg: number;
  power_norm: number;
  /** True when the peak sits on a visible-region boundary sample at +/-90 deg. */
  at_boundary: boolean;
}

export interface SidelobeInfo {
  angle_deg: number;
  power_db: number;
  power_norm: number;
}

export interface PatternReport {
  grid: AngleGrid;
  sample_count: number;
  /** Sum of |w_n|^2 == 0: the array radiates nothing; other metrics are not meaningful. */
  all_zero_weights: boolean;
  /** Max linear field across the grid, before normalization. */
  max_field: number;
  /** All distinct global-maximum sample locations. Equal-height peaks mean no unique pointing. */
  peaks: PeakInfo[];
  /** True when more than one distinct sample reaches the global maximum. */
  multiple_equal_peaks: boolean;
  /**
   * True when the visible region contains a grating lobe: a second fully-formed
   * interior local maximum (strictly higher than both neighbors) whose normalized
   * power is within GRATING_LOBE_THRESHOLD of the main peak.
   */
  grating_lobe: boolean;
  grating_lobe_angles_deg: number[];
  /**
   * Main/steering peak. Null for all-zero weights or when pointing is ambiguous;
   * never claim a unique direction unless unique_peak is true.
   */
  main_peak: PeakInfo | null;
  unique_peak: boolean;
  /**
   * Half-power beam width in degrees; null when the -3 dB contour is not fully
   * enclosed inside the grid (clipped beam / endfire) or weights are all zero.
   * Crossings use linear interpolation between adjacent samples.
   */
  hpbw_deg: number | null;
  hpbw_left_deg: number | null;
  hpbw_right_deg: number | null;
  /** True when a main-lobe half-power contour runs into a grid/visible-region edge. */
  main_lobe_incomplete: boolean;
  /**
   * Sidelobe level: highest local-maximum normalized power OUTSIDE the closed
   * main-lobe interval [hpbw_left, hpbw_right], in dB relative to the main peak.
   * Neighbors of the main peak can never be counted: the entire main-lobe span is
   * excluded, and a local maximum must be strictly higher than both neighbors.
   * Null when HPBW is unresolved or no qualifying sidelobe exists.
   */
  sidelobe_level_db: number | null;
  sidelobe_peak: SidelobeInfo | null;
  samples: PatternSample[];
  conventions: {
    angle_axis: string;
    phase_sign: string;
    power_db: string;
    model_limits: string;
  };
}

export interface QuantizationError {
  amp_bits: number | null;
  phase_bits: number | null;
  /** Sum |wq-w|^2 / Sum |w|^2, scale-invariant complex weight error. */
  normalized_mse: number;
  /** RMS magnitude of the complex weight error. */
  rms_error: number;
  /** Maximum per-element complex error magnitude. */
  max_abs_error: number;
}

export const CONVENTIONS = {
  angle_axis:
    "theta=0 is broadside (array normal); theta=+/-90 is endfire along the array axis.",
  phase_sign:
    "AF = SUM w_n exp(+j k x_n sin theta); steering weight w_n = a_n exp(-j k x_n sin theta0).",
  power_db: "Normalized POWER pattern |AF|^2/max|AF|^2; dB = 10*log10(power).",
  model_limits:
    "Isotropic point elements, far field, 1-D linear geometry. No mutual coupling and no real element radiation pattern are included.",
} as const;

/** A second full-scale interior local maximum within this linear-power ratio flags a grating lobe. */
export const GRATING_LOBE_THRESHOLD = 0.999;
/** Peak power ratio below which differences are treated as equal height. */
export const EQUAL_PEAK_TOLERANCE = 1e-9;
/** Half-power level (-3.0103 dB) on the normalized power scale. */
export const HALF_POWER = 0.5;
