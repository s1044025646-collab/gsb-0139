import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AppDatabase } from "./db.ts";
import { ArrayService } from "./service.ts";
import {
  ConflictError,
  int,
  NotFoundError,
  num,
  numberList,
  parseGrid,
  parseQuantization,
  str,
  ValidationError,
} from "./validation.ts";

export interface AppContext {
  db: AppDatabase;
  service: ArrayService;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > 2_000_000) throw new ValidationError("request body too large (max 2 MB)");
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("invalid JSON body");
  }
}

function errorBody(code: string, message: string, field?: string | null) {
  return { error: { code, message, ...(field ? { field } : {}) } };
}

/** Query-string integers come as strings; parse them explicitly. */
function qint(value: string | null, fallback: number, field: string, { min, max }: { min?: number; max?: number } = {}): number {
  if (value === null) return fallback;
  const n = Number(value);
  return int(n, field, { min, max });
}

/** Strip the potentially huge per-angle sample array for list-style responses. */
function summarizeReport(r: Awaited<ReturnType<ArrayService["scan"]>>) {
  const { samples, ...rest } = r;
  void samples;
  return rest;
}

export function createApp(ctx: AppContext) {
  const { db, service } = ctx;

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const idemKey = req.headers["idempotency-key"];

    const handle = async (): Promise<{ status: number; body: unknown }> => {
      // health
      if (req.method === "GET" && path === "/health") {
        return { status: 200, body: { ok: true, configs: db.countConfigs() } };
      }

      // list / create configs
      if (path === "/api/configs" && req.method === "GET") {
        const limit = qint(url.searchParams.get("limit"), 20, "limit", { min: 1, max: 100 });
        const offset = qint(url.searchParams.get("offset"), 0, "offset", { min: 0 });
        const search = url.searchParams.get("search") ?? undefined;
        return { status: 200, body: db.listConfigs({ limit, offset, search }) };
      }
      if (path === "/api/configs" && req.method === "POST") {
        const body = await readJson(req);
        const name = str(body.name, "name")!;
        const wavelength = num(body.wavelength, "wavelength", { min: 1e-9 })!;
        const positions = numberList(body.positions, "positions");
        const steerAngleDeg = num(body.steerAngleDeg, "steerAngleDeg", { min: -90, max: 90, optional: true });
        const taper = body.taper === undefined || body.taper === null ? null : numberList(body.taper, "taper");
        if (taper && taper.length !== positions.length) {
          throw new ValidationError("taper length must match positions length", "taper");
        }
        const note = str(body.note, "note", { optional: true });
        const cfg = service.createArray(
          { name, wavelength, positions, steerAngleDeg, taper, note },
          { idempotencyKey: Array.isArray(idemKey) ? idemKey[0]! : (idemKey ?? null) },
        );
        return { status: 201, body: cfg };
      }

      const m = path.match(/^\/api\/configs\/(\d+)(\/(steer|quantize|disable|scan|lineage|export|compare))?$/);
      if (m) {
        const id = Number(m[1]!);
        const action = m[3];

        if (!action && req.method === "GET") {
          const cfg = db.getConfig(id);
          if (!cfg) throw new NotFoundError(`config ${id} not found`);
          return { status: 200, body: cfg };
        }
        if (action === "lineage" && req.method === "GET") {
          if (!db.getConfig(id)) throw new NotFoundError(`config ${id} not found`);
          return { status: 200, body: { items: db.lineage(id) } };
        }
        if (action === "steer" && req.method === "POST") {
          const body = await readJson(req);
          const angle = num(body.steerAngleDeg, "steerAngleDeg", { min: -90, max: 90 })!;
          const cfg = service.steer(id, angle, {
            idempotencyKey: Array.isArray(idemKey) ? idemKey[0]! : (idemKey ?? null),
          });
          return { status: 201, body: cfg };
        }
        if (action === "quantize" && req.method === "POST") {
          const body = await readJson(req);
          const q = parseQuantization(body.quantization ?? body, "quantization");
          if (!q || (q.amplitudeLevels === null && q.phaseStates === null)) {
            throw new ValidationError("quantization requires amplitudeLevels and/or phaseStates", "quantization");
          }
          const cfg = service.quantize(id, q, {
            idempotencyKey: Array.isArray(idemKey) ? idemKey[0]! : (idemKey ?? null),
          });
          return { status: 201, body: cfg };
        }
        if (action === "disable" && req.method === "POST") {
          const body = await readJson(req);
          const elementIndex = int(body.elementIndex, "elementIndex", { min: 0 });
          const cfg = service.disable(id, elementIndex, {
            idempotencyKey: Array.isArray(idemKey) ? idemKey[0]! : (idemKey ?? null),
          });
          return { status: 201, body: cfg };
        }
        if (action === "scan" && (req.method === "POST" || req.method === "GET")) {
          const grid =
            req.method === "POST"
              ? parseGrid((await readJson(req)).grid ?? {})
              : parseGrid({
                  startDeg: url.searchParams.get("startDeg") ?? undefined,
                  stopDeg: url.searchParams.get("stopDeg") ?? undefined,
                  stepDeg: url.searchParams.get("stepDeg") ?? undefined,
                });
          const report = service.scan(id, grid);
          const full = url.searchParams.get("full") === "1" || req.method === "POST";
          return { status: 200, body: full ? report : summarizeReport(report) };
        }
        if (action === "export" && req.method === "GET") {
          const grid = parseGrid({
            startDeg: url.searchParams.get("startDeg") ?? undefined,
            stopDeg: url.searchParams.get("stopDeg") ?? undefined,
            stepDeg: url.searchParams.get("stepDeg") ?? undefined,
          });
          const report = service.scan(id, grid);
          const cfg = db.getConfig(id)!;
          const header =
            `# config_id=${cfg.id} version=${cfg.version} wavelength=${cfg.wavelength}\n` +
            `# angle_ref=broadside theta_deg; AF=sum w_n exp(+j k x_n sin theta); power=|AF|^2/peak; dB=10log10(power)\n` +
            "theta_deg,af_re,af_im,power_linear,power_db\n";
          const rows = (report.samples ?? [])
            .map((s) => `${s.thetaDeg},${s.af.re},${s.af.im},${s.powerLinear},${s.powerDb}`)
            .join("\n");
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
          res.end(header + rows + "\n");
          return { status: 0, body: null };
        }
      }

      // compare two configs
      const cm = path.match(/^\/api\/compare\/(\d+)\/(\d+)$/);
      if (cm && req.method === "POST") {
        const baseId = Number(cm[1]!);
        const candId = Number(cm[2]!);
        const body = await readJson(req);
        const grid = parseGrid(body.grid ?? {});
        return { status: 200, body: service.compare(baseId, candId, grid) };
      }
      if (cm && req.method === "GET") {
        const baseId = Number(cm[1]!);
        const candId = Number(cm[2]!);
        const grid = parseGrid({
          startDeg: url.searchParams.get("startDeg") ?? undefined,
          stopDeg: url.searchParams.get("stopDeg") ?? undefined,
          stepDeg: url.searchParams.get("stepDeg") ?? undefined,
        });
        return { status: 200, body: service.compare(baseId, candId, grid) };
      }

      throw new NotFoundError(`route not found: ${req.method} ${path}`);
    };

    handle()
      .then(({ status, body }) => {
        if (status === 0) return; // already replied (CSV)
        send(res, status, body);
      })
      .catch((err: unknown) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (err instanceof ValidationError) {
          send(res, 400, errorBody(err.code, err.message, err.field));
        } else if (err instanceof NotFoundError) {
          send(res, 404, errorBody(err.code, err.message));
        } else if (err instanceof ConflictError) {
          send(res, 409, errorBody(err.code, err.message));
        } else if ((err as { code?: string })?.code === "SQLITE_CONSTRAINT_UNIQUE") {
          send(res, 409, errorBody("CONFLICT", "idempotency key collides with different input"));
        } else {
          send(res, 500, errorBody("INTERNAL", (err as Error).message ?? "internal error"));
        }
      });
  });
}

export interface StartResult {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Bind only to loopback; port 0 -> OS-assigned free port. */
export async function startServer(dbPath: string, host = "127.0.0.1", port = 0): Promise<StartResult> {
  const db = new AppDatabase(dbPath);
  db.migrate();
  const server = createApp({ db, service: new ArrayService(db) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const assigned = (server.address() as AddressInfo).port;
  return {
    server,
    port: assigned,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

if (import.meta.dirname && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const dbPath = process.env.ARRAY_DB_PATH ?? "data/app.sqlite";
  startServer(dbPath).then(({ port }) => {
    console.log(`[server] listening on http://127.0.0.1:${port} (db: ${dbPath})`);
  });
}
