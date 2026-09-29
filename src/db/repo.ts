import type { Db, Clock } from "./database.ts";
import { withTransaction } from "./database.ts";
import { AppError } from "../core/errors.ts";
import type {
  AngleGrid,
  ArrayConfig,
  ElementSpec,
  PatternReport,
  QuantizationError,
  WeightSpec,
} from "../core/types.ts";

interface ConfigRow {
  id: number;
  idempotency_key: string | null;
  name: string;
  wavelength: number;
  elements_json: string;
  weights_json: string;
  steer_angle_deg: number;
  taper: string | null;
  amp_bits: number | null;
  phase_bits: number | null;
  parent_config_id: number | null;
  note: string | null;
  version: number;
  created_at: string;
}

export interface NewConfigInput {
  name: string;
  wavelength: number;
  elements: ElementSpec[];
  weights: WeightSpec[];
  steer_angle_deg: number;
  taper?: string | null;
  amp_bits?: number | null;
  phase_bits?: number | null;
  parent_config_id?: number | null;
  note?: string | null;
  idempotency_key?: string | null;
}

export interface ReportRecord {
  id: number;
  config_id: number;
  grid: AngleGrid;
  report: PatternReport;
  created_at: string;
}

function rowToConfig(row: ConfigRow): ArrayConfig {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    name: row.name,
    wavelength: row.wavelength,
    elements: JSON.parse(row.elements_json) as ElementSpec[],
    weights: JSON.parse(row.weights_json) as WeightSpec[],
    steer_angle_deg: row.steer_angle_deg,
    taper: row.taper,
    amp_bits: row.amp_bits,
    phase_bits: row.phase_bits,
    parent_config_id: row.parent_config_id,
    note: row.note,
    version: row.version,
    created_at: row.created_at,
  };
}

export class ConfigRepository {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * Insert a config version. If idempotency_key already exists, return the
   * previously stored row instead of inserting a duplicate. Version = parent + 1.
   */
  create(input: NewConfigInput): ArrayConfig {
    return withTransaction(this.db, () => {
      if (input.idempotency_key) {
        const existing = this.db
          .prepare("SELECT * FROM configs WHERE idempotency_key = ?")
          .get(input.idempotency_key) as ConfigRow | undefined;
        if (existing) {
          if (existing.name !== input.name) {
            throw new AppError(
              "IDEMPOTENCY_MISMATCH",
              "Idempotency key reused with a different payload (name).",
              { idempotency_key: input.idempotency_key },
            );
          }
          return rowToConfig(existing);
        }
      }
      let version = 1;
      if (input.parent_config_id !== undefined && input.parent_config_id !== null) {
        const parent = this.getById(input.parent_config_id);
        version = parent.version + 1;
      }
      const stmt = this.db.prepare(`
        INSERT INTO configs (
          idempotency_key, name, wavelength, elements_json, weights_json,
          steer_angle_deg, taper, amp_bits, phase_bits, parent_config_id,
          note, version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const res = stmt.run(
        input.idempotency_key ?? null,
        input.name,
        input.wavelength,
        JSON.stringify(input.elements),
        JSON.stringify(input.weights),
        input.steer_angle_deg,
        input.taper ?? null,
        input.amp_bits ?? null,
        input.phase_bits ?? null,
        input.parent_config_id ?? null,
        input.note ?? null,
        version,
        this.clock().toISOString(),
      );
      return this.getById(Number(res.lastInsertRowid));
    });
  }

  getById(id: number): ArrayConfig {
    const row = this.db.prepare("SELECT * FROM configs WHERE id = ?").get(id) as
      | ConfigRow
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `Config ${id} not found.`, { id });
    return rowToConfig(row);
  }

  list(limit: number, offset: number): { items: ArrayConfig[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM configs").get() as { n: number }).n;
    const rows = this.db
      .prepare("SELECT * FROM configs ORDER BY id ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as ConfigRow[];
    return { items: rows.map(rowToConfig), total };
  }

  /** Return the persisted report for a config under a key, or null. */
  findReport(configId: number, idempotencyKey: string): ReportRecord | null {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE config_id = ? AND idempotency_key = ?")
      .get(configId, idempotencyKey) as
      | {
          id: number;
          config_id: number;
          grid_json: string;
          report_json: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      config_id: row.config_id,
      grid: JSON.parse(row.grid_json) as AngleGrid,
      report: JSON.parse(row.report_json) as PatternReport,
      created_at: row.created_at,
    };
  }

  saveReport(
    configId: number,
    grid: AngleGrid,
    report: PatternReport,
    idempotencyKey: string,
  ): ReportRecord {
    return withTransaction(this.db, () => {
      const existing = this.findReport(configId, idempotencyKey);
      if (existing) return existing;
      const res = this.db
        .prepare(
          `INSERT INTO reports (config_id, idempotency_key, grid_json, report_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          configId,
          idempotencyKey,
          JSON.stringify(grid),
          JSON.stringify(report),
          this.clock().toISOString(),
        );
      return {
        id: Number(res.lastInsertRowid),
        config_id: configId,
        grid,
        report,
        created_at: this.clock().toISOString(),
      };
    });
  }

  listReports(
    configId: number,
    limit: number,
    offset: number,
  ): { items: ReportRecord[]; total: number } {
    this.getById(configId);
    const total = (
      this.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE config_id = ?").get(configId) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        "SELECT * FROM reports WHERE config_id = ? ORDER BY id ASC LIMIT ? OFFSET ?",
      )
      .all(configId, limit, offset) as {
      id: number;
      config_id: number;
      grid_json: string;
      report_json: string;
      created_at: string;
    }[];
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        config_id: row.config_id,
        grid: JSON.parse(row.grid_json) as AngleGrid,
        report: JSON.parse(row.report_json) as PatternReport,
        created_at: row.created_at,
      })),
    };
  }

  saveQuantError(
    parentConfigId: number,
    quantizedConfigId: number,
    error: QuantizationError,
  ): void {
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO quant_errors (parent_config_id, quantized_config_id, error_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          parentConfigId,
          quantizedConfigId,
          JSON.stringify(error),
          this.clock().toISOString(),
        );
    });
  }

  getQuantError(quantizedConfigId: number): QuantizationError | null {
    const row = this.db
      .prepare("SELECT error_json FROM quant_errors WHERE quantized_config_id = ?")
      .get(quantizedConfigId) as { error_json: string } | undefined;
    return row ? (JSON.parse(row.error_json) as QuantizationError) : null;
  }
}
