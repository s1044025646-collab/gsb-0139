#!/usr/bin/env node
import { resolve } from "node:path";
import { AppDatabase } from "./db.ts";
import { ArrayService } from "./service.ts";
import { defaultGrid } from "./core/grid.ts";
import { windows } from "./core/windows.ts";
import { writeFileSync } from "node:fs";

const dbPath = process.env.ARRAY_DB_PATH ?? "data/app.sqlite";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  cli init-db",
      "  cli create-array --name N --wavelength W --positions x0,x1,... [--steer deg] [--taper uniform|hann|hamming|triangular]",
      "  cli steer --id ID --angle deg",
      "  cli quantize --id ID [--amplitude-levels N] [--phase-states N]",
      "  cli disable --id ID --element INDEX",
      "  cli scan --id ID [--step deg] [--full]",
      "  cli compare --base ID --candidate ID [--step deg]",
      "  cli export --id ID [--step deg] [--out file.csv]",
      "  cli list [--limit N] [--offset O] [--search S]",
      "  cli show --id ID",
      "  cli lineage --id ID",
      "",
      "Environment: ARRAY_DB_PATH (default data/app.sqlite)",
    ].join("\n"),
  );
  process.exit(2);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function mustArg(name: string): string {
  const v = arg(name);
  if (v === undefined) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return v;
}

function numList(s: string): number[] {
  return s.split(",").map((x) => Number(x.trim()));
}

function briefConfig(c: { id: number; version: number; name: string; wavelength: number; steerAngleDeg: number | null; parentId: number | null; note: string | null; elements: { enabled: boolean }[] }) {
  return `#${c.id} v${c.version} "${c.name}" lambda=${c.wavelength} steer=${c.steerAngleDeg === null ? "-" : c.steerAngleDeg} parent=${c.parentId === null ? "-" : c.parentId} enabled=${c.elements.filter((e) => e.enabled).length}/${c.elements.length} note="${c.note ?? ""}"`;
}

function main(): void {
  const cmd = process.argv[2];
  if (!cmd) usage();
  const db = new AppDatabase(resolve(dbPath));
  db.migrate();
  const service = new ArrayService(db);

  try {
    switch (cmd) {
      case "init-db": {
        console.log(`[before] database ready at ${resolve(dbPath)}`);
        console.log(`[after]  migrations applied; configs=${db.countConfigs()}`);
        break;
      }
      case "create-array": {
        const name = mustArg("name");
        const wavelength = Number(mustArg("wavelength"));
        const positions = numList(mustArg("positions"));
        const steer = arg("steer") !== undefined ? Number(arg("steer")) : null;
        const taperName = arg("taper");
        const taper = taperName ? (windows as Record<string, (n: number) => number[]>)[taperName]!(positions.length) : null;
        const before = db.countConfigs();
        const cfg = service.createArray({ name, wavelength, positions, steerAngleDeg: steer, taper });
        console.log(`[before] configs=${before}`);
        console.log(`[after]  created ${briefConfig(cfg)}`);
        break;
      }
      case "steer": {
        const id = Number(mustArg("id"));
        const angle = Number(mustArg("angle"));
        const base = db.getConfig(id)!;
        const cfg = service.steer(id, angle);
        console.log(`[before] ${briefConfig(base)}`);
        console.log(`[after]  ${briefConfig(cfg)}`);
        break;
      }
      case "quantize": {
        const id = Number(mustArg("id"));
        const amp = arg("amplitude-levels") !== undefined ? Number(arg("amplitude-levels")) : null;
        const phs = arg("phase-states") !== undefined ? Number(arg("phase-states")) : null;
        if (amp === null && phs === null) {
          console.error("provide at least one of --amplitude-levels / --phase-states");
          process.exit(2);
        }
        const base = db.getConfig(id)!;
        const cfg = service.quantize(id, { amplitudeLevels: amp, phaseStates: phs });
        console.log(`[before] ${briefConfig(base)} quantization=${JSON.stringify(base.quantization)}`);
        console.log(`[after]  ${briefConfig(cfg)} quantization=${JSON.stringify(cfg.quantization)}`);
        break;
      }
      case "disable": {
        const id = Number(mustArg("id"));
        const element = Number(mustArg("element"));
        const base = db.getConfig(id)!;
        const cfg = service.disable(id, element);
        console.log(`[before] ${briefConfig(base)}`);
        console.log(`[after]  ${briefConfig(cfg)}`);
        break;
      }
      case "scan": {
        const id = Number(mustArg("id"));
        const step = Number(arg("step", "0.1"));
        const r = service.scan(id, defaultGrid(step));
        console.log(
          `config #${r.configId} v${r.configVersion}: peak=${r.peakDirectionDeg ?? "UNDEFINED"} deg ` +
            `HPBW=${r.mainLobe.hpbwDeg === null ? "N/A" : r.mainLobe.hpbwDeg.toFixed(2) + " deg"} ` +
            `SLL=${r.sidelobeLevelDb === null ? "N/A" : r.sidelobeLevelDb.toFixed(2) + " dB"} ` +
            `grating=${r.gratingLobe} multiPeak=${r.multipleEqualPeaks} allZero=${r.allZeroWeights} ` +
            `mainLobeComplete=${r.mainLobe.complete}`,
        );
        if (arg("full")) {
          for (const s of r.samples ?? []) {
            console.log(`${s.thetaDeg.toFixed(3)},${s.powerLinear.toExponential(6)},${s.powerDb.toFixed(3)}`);
          }
        }
        break;
      }
      case "compare": {
        const base = Number(mustArg("base"));
        const cand = Number(mustArg("candidate"));
        const step = Number(arg("step", "0.1"));
        const cmp = service.compare(base, cand, defaultGrid(step));
        console.log(JSON.stringify(cmp, null, 2));
        break;
      }
      case "export": {
        const id = Number(mustArg("id"));
        const step = Number(arg("step", "0.1"));
        const out = arg("out", `data/config-${id}-step${step}.csv`);
        const r = service.scan(id, defaultGrid(step));
        const lines = [
          `# config_id=${r.configId} version=${r.configVersion} angle_ref=broadside power=|AF|^2/peak dB=10log10(power)`,
          "theta_deg,af_re,af_im,power_linear,power_db",
          ...(r.samples ?? []).map((s) => `${s.thetaDeg},${s.af.re},${s.af.im},${s.powerLinear},${s.powerDb}`),
        ];
        writeFileSync(resolve(out!), lines.join("\n") + "\n", "utf8");
        console.log(`exported ${(r.samples ?? []).length} samples to ${resolve(out!)}`);
        break;
      }
      case "list": {
        const limit = Number(arg("limit", "20"));
        const offset = Number(arg("offset", "0"));
        const search = arg("search");
        const page = db.listConfigs({ limit, offset, search });
        console.log(`total=${page.total} limit=${page.limit} offset=${page.offset}`);
        for (const c of page.items) console.log(briefConfig(c));
        break;
      }
      case "show": {
        const id = Number(mustArg("id"));
        const cfg = db.getConfig(id);
        if (!cfg) {
          console.error(`config ${id} not found`);
          process.exit(1);
        }
        console.log(JSON.stringify(cfg, null, 2));
        break;
      }
      case "lineage": {
        const id = Number(mustArg("id"));
        for (const c of db.lineage(id)) console.log(briefConfig(c));
        break;
      }
      default:
        usage();
    }
  } finally {
    db.close();
  }
}

main();
