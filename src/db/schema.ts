export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE,
  name TEXT NOT NULL,
  wavelength REAL NOT NULL CHECK (wavelength > 0),
  elements_json TEXT NOT NULL,
  weights_json TEXT NOT NULL,
  steer_angle_deg REAL NOT NULL,
  taper TEXT,
  amp_bits INTEGER,
  phase_bits INTEGER,
  parent_config_id INTEGER REFERENCES configs(id),
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_configs_created ON configs(created_at);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE,
  grid_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_config ON reports(config_id);
CREATE TABLE IF NOT EXISTS quant_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  quantized_config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  error_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quant_quantized ON quant_errors(quantized_config_id);
`,
  },
];
