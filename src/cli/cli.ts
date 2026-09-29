#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../db/database.ts";
import { ConfigRepository } from "../db/repo.ts";
import { ArrayService, summary } from "../core/service.ts";
import {
  buildElements,
  parseWeights,
  resolvePositions,
  validateGrid,
} from "../core/validation.ts";
import type { ArrayConfig } from "../core/types.ts";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  // First non-flag token is the subcommand; scan the full argv so flags work in
  // any position, including a trailing `--db <path>`.
  let command: string | undefined;
  const booleanFlags = new Set(["help"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (booleanFlags.has(key) || next === undefined || next.startsWith("--")) {
        flags.set(key, "true");
      } else {
        flags.set(key, next);
        i++;
      }
    } else if (command === undefined) {
      command = token;
    } else {
      positional.push(token);
    }
  }
  return { command: command ?? "help", positional, flags };
}

function flag(flags: Map<string, string>, key: string, fallback?: string): string {
  const v = flags.get(key);
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required flag --${key}`);
  }
  return v;
}

function brief(c: ArrayConfig): string {
  const active = c.elements.filter((e) => e.enabled).length;
  return (
    `id=${c.id} v${c.version} "${c.name}" lambda=${c.wavelength} ` +
    `elements=${active}/${c.elements.length} steer=${c.steer_angle_deg}deg ` +
    `taper=${c.taper ?? "-"} amp=${c.amp_bits ?? "-"} phase=${c.phase_bits ?? "-"} ` +
    `parent=${c.parent_config_id ?? "-"}`
  );
}

const USAGE = [
  "Antenna array pattern evaluator — CLI (local only, no RF/device control)",
  "",
  "Usage:",
  "  npm run cli -- create --name ULA8 --wavelength 0.1 --count 8 --spacing 0.05",
  "  npm run cli -- list [--limit N --offset M]",
  "  npm run cli -- show --id 1",
  "  npm run cli -- steer --id 1 --angle 30 [--taper uniform|hann|hamming]",
  "  npm run cli -- quantize --id 2 --phase-bits 3 [--amp-bits 4]",
  "  npm run cli -- disable --id 2 --element 3",
  "  npm run cli -- scan --id 2 [--start -90 --stop 90 --step 0.5]",
  "  npm run cli -- compare --a 1 --b 4 [--step 0.5]",
  "  npm run cli -- export --id 2 --out data/pattern.csv [--step 0.5]",
  "",
  "All data is stored under ./data (override with --db path).",
  "Conventions: theta=0 broadside, AF = SUM w_n exp(+j k x_n sin theta),",
  "normalized POWER in dB = 10 log10(P/Pmax). Isotropic elements only;",
  "no mutual coupling and no real element pattern are modeled.",
].join("\n");

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.flags.get("db") ?? "data", "array.db");
  mkdirSync(resolve(dbPath, ".."), { recursive: true });
  const db = openDatabase(dbPath);
  const repo = new ConfigRepository(db);
  const service = new ArrayService(repo);

  try {
    switch (args.command) {
      case "create": {
        const name = flag(args.flags, "name");
        const wavelength = Number(flag(args.flags, "wavelength"));
        const positions = resolvePositions({
          count: args.flags.get("count"),
          spacing: args.flags.get("spacing"),
          positions: args.flags.get("positions")?.split(",").map(Number),
        });
        const elements = buildElements(positions);
        const weights = parseWeights(undefined, elements.length);
        const created = service.create({
          name,
          wavelength,
          elements,
          weights,
          steer_angle_deg: 0,
          taper: "uniform",
          idempotency_key: args.flags.get("idempotency-key") ?? null,
        });
        console.log("BEFORE: (no config)");
        console.log(`AFTER:  ${brief(created)}`);
        break;
      }
      case "show": {
        const id = Number(flag(args.flags, "id"));
        console.log(brief(service.get(id)));
        console.log(JSON.stringify(service.get(id), null, 2));
        break;
      }
      case "list": {
        const limit = Number(args.flags.get("limit") ?? 20);
        const offset = Number(args.flags.get("offset") ?? 0);
        const { items, total } = repo.list(limit, offset);
        console.log(`Configs ${offset + 1}..${offset + items.length} of ${total}:`);
        items.forEach((c) => console.log(`  ${brief(c)}`));
        break;
      }
      case "steer": {
        const id = Number(flag(args.flags, "id"));
        const angle = Number(flag(args.flags, "angle"));
        const taper = (args.flags.get("taper") ?? "uniform") as
          | "uniform"
          | "hann"
          | "hamming";
        const before = service.get(id);
        const after = service.steer(id, angle, taper, args.flags.get("idempotency-key"));
        console.log(`BEFORE: ${brief(before)}`);
        console.log(`AFTER:  ${brief(after)} (new version, baseline #${before.id} unchanged)`);
        break;
      }
      case "quantize": {
        const id = Number(flag(args.flags, "id"));
        const amp = args.flags.has("amp-bits") ? Number(args.flags.get("amp-bits")) : null;
        const phase = args.flags.has("phase-bits") ? Number(args.flags.get("phase-bits")) : null;
        const before = service.get(id);
        const { config, error } = service.quantize(
          id,
          amp,
          phase,
          args.flags.get("idempotency-key"),
        );
        console.log(`BEFORE: ${brief(before)}`);
        console.log(`AFTER:  ${brief(config)}`);
        console.log(
          `ERROR:  normalized_mse=${error.normalized_mse.toExponential(3)} ` +
            `rms=${error.rms_error.toExponential(3)} max_abs=${error.max_abs_error.toExponential(3)}`,
        );
        break;
      }
      case "disable": {
        const id = Number(flag(args.flags, "id"));
        const index = Number(flag(args.flags, "element"));
        const before = service.get(id);
        const after = service.disableElement(id, index, args.flags.get("idempotency-key"));
        console.log(`BEFORE: ${brief(before)}`);
        console.log(`AFTER:  ${brief(after)} (baseline #${before.id} untouched)`);
        break;
      }
      case "scan": {
        const id = Number(flag(args.flags, "id"));
        const grid = validateGrid(
          args.flags.get("start") ?? -90,
          args.flags.get("stop") ?? 90,
          args.flags.get("step") ?? 1,
        );
        const before = service.get(id);
        const { report, persisted } = service.scan(id, grid, args.flags.get("idempotency-key"));
        console.log(`CONFIG: ${brief(before)}  (${persisted ? "cached report" : "new report"})`);
        console.log(JSON.stringify(summary(report), null, 2));
        if (report.all_zero_weights) console.log("FLAG: all weights are zero — no pattern.");
        if (report.multiple_equal_peaks)
          console.log("FLAG: multiple equal-height peaks — pointing ambiguous.");
        if (report.grating_lobe)
          console.log(`FLAG: grating lobe(s) at ${report.grating_lobe_angles_deg.join(", ")} deg.`);
        if (report.main_lobe_incomplete)
          console.log("FLAG: main lobe incomplete at grid/visible boundary.");
        break;
      }
      case "compare": {
        const a = Number(flag(args.flags, "a"));
        const b = Number(flag(args.flags, "b"));
        const grid = validateGrid(
          args.flags.get("start") ?? -90,
          args.flags.get("stop") ?? 90,
          args.flags.get("step") ?? 1,
        );
        console.log(JSON.stringify(service.compare(a, b, grid), null, 2));
        break;
      }
      case "export": {
        const id = Number(flag(args.flags, "id"));
        const outPath = resolve(flag(args.flags, "out"));
        const grid = validateGrid(
          args.flags.get("start") ?? -90,
          args.flags.get("stop") ?? 90,
          args.flags.get("step") ?? 0.5,
        );
        const { report } = service.scan(id, grid);
        const header = "angle_deg,af_re,af_im,field,power_norm,power_db";
        const lines = report.samples.map((s) =>
          [
            s.angle_deg.toFixed(6),
            s.af.re.toExponential(8),
            s.af.im.toExponential(8),
            s.field.toExponential(8),
            s.power_norm.toExponential(8),
            Number.isFinite(s.power_db) ? s.power_db.toFixed(6) : "-inf",
          ].join(","),
        );
        writeFileSync(outPath, [header, ...lines].join("\n") + "\n", "utf8");
        console.log(`Exported ${report.samples.length} samples for config ${id} to ${outPath}`);
        break;
      }
      default:
        console.log(USAGE);
    }
  } catch (err) {
    console.error(
      `ERROR [${(err as { code?: string }).code ?? "CLI"}]: ${(err as Error).message}`,
    );
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
