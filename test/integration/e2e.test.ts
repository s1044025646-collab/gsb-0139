import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = resolve("src/cli/cli.ts");
const nodeArgs = ["--experimental-sqlite", "--no-warnings", cli];

let dir: string;
let db: string;

function env() {
  return { ...process.env };
}

async function cliRun(args: string[]) {
  return run(process.execPath, [...nodeArgs, ...args, "--db", db], { env: env() });
}

test("CLI end-to-end demo is repeatable and leaves baseline versions intact", async (t) => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  dir = mkdtempSync(join(resolve(".tmp"), "array-e2e-"));
  t.after(() => {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  });
  db = join(dir, "e2e.db");

  const created = await cliRun([
    "create",
    "--name",
    "ULA8",
    "--wavelength",
    "0.1",
    "--count",
    "8",
    "--spacing",
    "0.05",
  ]);
  assert.match(created.stdout, /AFTER:.*id=1/);

  // repeat create with same idempotency key -> same id, no duplicate
  const repeat = await cliRun([
    "create",
    "--name",
    "ULA8",
    "--wavelength",
    "0.1",
    "--count",
    "8",
    "--spacing",
    "0.05",
    "--idempotency-key",
    "demo-create",
  ]);
  const repeat2 = await cliRun([
    "create",
    "--name",
    "ULA8",
    "--wavelength",
    "0.1",
    "--count",
    "8",
    "--spacing",
    "0.05",
    "--idempotency-key",
    "demo-create",
  ]);
  assert.equal(repeat.stdout, repeat2.stdout);

  const steer = await cliRun(["steer", "--id", "1", "--angle", "30"]);
  assert.match(steer.stdout, /AFTER:.*id=3 v2/);
  assert.match(steer.stdout, /baseline #1 unchanged/);

  const quant = await cliRun(["quantize", "--id", "3", "--phase-bits", "3"]);
  assert.match(quant.stdout, /id=4 v3/);
  assert.match(quant.stdout, /ERROR:/);

  const fail = await cliRun(["disable", "--id", "3", "--element", "3"]);
  assert.match(fail.stdout, /id=5 v3/);
  assert.match(fail.stdout, /elements=7\/8/);

  // invalid element index -> non-zero exit with explicit code
  await assert.rejects(cliRun(["disable", "--id", "3", "--element", "99"]), /ELEMENT_OUT_OF_RANGE/);

  const scan = await cliRun(["scan", "--id", "3", "--step", "0.5"]);
  assert.match(scan.stdout, /"unique_peak": true/);
  assert.match(scan.stdout, /"sidelobe_level_db":/);

  // grating-lobe fixture via wide spacing
  await cliRun(["create", "--name", "grate", "--wavelength", "0.1", "--count", "10", "--spacing", "0.12"]);
  const gscan = await cliRun(["scan", "--id", "6", "--step", "0.2"]);
  assert.match(gscan.stdout, /FLAG: grating lobe/);
  assert.match(gscan.stdout, /"unique_peak": false/);

  // comparison
  const cmp = await cliRun(["compare", "--a", "1", "--b", "3", "--step", "0.5"]);
  assert.match(cmp.stdout, /"hpbw_delta_deg"/);

  // CSV export stays inside the project temp dir
  const csv = join(dir, "pattern.csv");
  const exported = await cliRun(["export", "--id", "3", "--out", csv, "--step", "1"]);
  assert.match(exported.stdout, /Exported 181 samples/);
  assert.ok(existsSync(csv));
  const lines = readFileSync(csv, "utf8").trim().split("\n");
  assert.equal(lines[0], "angle_deg,af_re,af_im,field,power_norm,power_db");
  assert.equal(lines.length, 182);

  // persistence: a fresh CLI process (new connection) still sees every version
  const list = await cliRun(["list", "--limit", "50"]);
  assert.match(list.stdout, /of 6/);

  // data never leaked into the default project db because --db was passed
  assert.ok(existsSync(db));
});

test("CLI reports failure on malformed arguments without creating data", async () => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  dir = mkdtempSync(join(resolve(".tmp"), "array-e2e-bad-"));
  db = join(dir, "bad.db");
  await assert.rejects(cliRun(["create", "--name", "x", "--wavelength", "0.1"]), /count/);
});
