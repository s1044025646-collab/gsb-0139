import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Db } from "../db/database.ts";
import { ConfigRepository } from "../db/repo.ts";
import { AppError, errorStatus, parsePageParams } from "../core/errors.ts";
import { ArrayService, summary } from "../core/service.ts";
import {
  buildElements,
  parseWeights,
  requireFinitePositive,
  requireString,
  resolvePositions,
  validateBitDepth,
  validateGrid,
  validateSteerAngle,
} from "../core/validation.ts";
import { CONVENTIONS } from "../core/types.ts";

type Json = Record<string, unknown>;

export interface AppContext {
  service: ArrayService;
  repo: ConfigRepository;
}

export function createApp(db: Db): Server {
  const repo = new ConfigRepository(db);
  const service = new ArrayService(repo);
  const ctx: AppContext = { service, repo };

  return createServer((req, res) => {
    handle(req, res, ctx).catch((err: unknown) => sendError(res, err));
  });
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.");
    }
    return parsed as Json;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("VALIDATION_ERROR", "Malformed JSON body.");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    sendJson(res, err.status, {
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  sendJson(res, errorStatus("INTERNAL"), { error: { code: "INTERNAL", message } });
}

function idParam(pathname: string, prefix: string): number {
  const raw = pathname.slice(prefix.length).split("/")[0];
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError("VALIDATION_ERROR", "Resource id must be a positive integer.", { raw });
  }
  return id;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, { status: "ok", model: "isotropic 1-D linear array, far field" });
    return;
  }
  if (method === "GET" && pathname === "/conventions") {
    sendJson(res, 200, { conventions: CONVENTIONS });
    return;
  }

  if (pathname === "/arrays" && method === "POST") {
    const body = await readJson(req);
    const name = requireString(body.name as string, "name");
    const wavelength = requireFinitePositive(body.wavelength, "wavelength");
    const positions = resolvePositions(body as never);
    const elements = buildElements(positions);
    const weights = parseWeights(body.weights, elements.length);
    const config = ctx.service.create({
      name,
      wavelength,
      elements,
      weights,
      steer_angle_deg: 0,
      taper: "uniform",
      note: typeof body.note === "string" ? body.note : null,
      idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
    });
    sendJson(res, 201, { config });
    return;
  }

  if (pathname === "/arrays" && method === "GET") {
    const page = parsePageParams({
      limit: url.searchParams.get("limit") ?? 50,
      offset: url.searchParams.get("offset") ?? 0,
    });
    const { items, total } = ctx.repo.list(page.limit, page.offset);
    sendJson(res, 200, paginate("/arrays", items, total, page.limit, page.offset));
    return;
  }

  if (/^\/arrays\/\d+$/.test(pathname) && method === "GET") {
    sendJson(res, 200, { config: ctx.service.get(idParam(pathname, "/arrays/")) });
    return;
  }

  const steerMatch = pathname.match(/^\/arrays\/(\d+)\/steer$/);
  if (steerMatch && method === "POST") {
    const body = await readJson(req);
    const angle = validateSteerAngle(body.steer_angle_deg);
    const taper = body.taper === undefined ? "uniform" : body.taper;
    if (!["uniform", "hann", "hamming"].includes(String(taper))) {
      throw new AppError("VALIDATION_ERROR", 'taper must be "uniform", "hann" or "hamming".');
    }
    const config = ctx.service.steer(
      Number(steerMatch[1]),
      angle,
      taper as "uniform" | "hann" | "hamming",
      typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
    );
    sendJson(res, 201, { config });
    return;
  }

  const quantMatch = pathname.match(/^\/arrays\/(\d+)\/quantize$/);
  if (quantMatch && method === "POST") {
    const body = await readJson(req);
    const ampBits = validateBitDepth(body.amp_bits, "amp_bits");
    const phaseBits = validateBitDepth(body.phase_bits, "phase_bits");
    if (ampBits === null && phaseBits === null) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Provide at least one of amp_bits / phase_bits.",
      );
    }
    const result = ctx.service.quantize(
      Number(quantMatch[1]),
      ampBits,
      phaseBits,
      typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
    );
    sendJson(res, 201, result);
    return;
  }

  const failMatch = pathname.match(/^\/arrays\/(\d+)\/disable$/);
  if (failMatch && method === "POST") {
    const body = await readJson(req);
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new AppError("VALIDATION_ERROR", "index must be a non-negative integer.");
    }
    const config = ctx.service.disableElement(
      Number(failMatch[1]),
      index,
      typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
    );
    sendJson(res, 201, { config });
    return;
  }

  const scanMatch = pathname.match(/^\/arrays\/(\d+)\/scan$/);
  if (scanMatch && (method === "POST" || method === "GET")) {
    const configId = Number(scanMatch[1]);
    const source =
      method === "POST" ? await readJson(req) : ({
        start_deg: url.searchParams.get("start_deg") ?? -90,
        stop_deg: url.searchParams.get("stop_deg") ?? 90,
        step_deg: url.searchParams.get("step_deg") ?? 1,
      } as Json);
    const grid = validateGrid(source.start_deg, source.stop_deg, source.step_deg);
    const key =
      typeof source.idempotency_key === "string" ? (source.idempotency_key as string) : undefined;
    const { report, persisted } = ctx.service.scan(configId, grid, key);
    const includeSamples =
      method === "POST"
        ? source.include_samples !== false
        : url.searchParams.get("samples") === "1";
    sendJson(res, 200, {
      config_id: configId,
      cached: persisted,
      summary: summary(report),
      conventions: report.conventions,
      samples: includeSamples ? report.samples : undefined,
    });
    return;
  }

  // Per-angle data export (paginated) for a config.
  const dataMatch = pathname.match(/^\/arrays\/(\d+)\/data$/);
  if (dataMatch && method === "GET") {
    const configId = Number(dataMatch[1]);
    const grid = validateGrid(
      url.searchParams.get("start_deg") ?? -90,
      url.searchParams.get("stop_deg") ?? 90,
      url.searchParams.get("step_deg") ?? 1,
    );
    const { report } = ctx.service.scan(configId, grid);
    const page = parsePageParams({
      limit: url.searchParams.get("limit") ?? 200,
      offset: url.searchParams.get("offset") ?? 0,
    });
    const slice = report.samples.slice(page.offset, page.offset + page.limit);
    sendJson(res, 200, paginate(pathname, slice, report.samples.length, page.limit, page.offset, () => {
      const q = url.searchParams;
      const next = new URLSearchParams({
        start_deg: String(grid.start_deg),
        stop_deg: String(grid.stop_deg),
        step_deg: String(grid.step_deg),
        limit: String(page.limit),
        offset: String(page.offset + page.limit),
      });
      void q;
      return `${pathname}?${next.toString()}`;
    }));
    return;
  }

  const reportsMatch = pathname.match(/^\/arrays\/(\d+)\/reports$/);
  if (reportsMatch && method === "GET") {
    const configId = Number(reportsMatch[1]);
    const page = parsePageParams({
      limit: url.searchParams.get("limit") ?? 50,
      offset: url.searchParams.get("offset") ?? 0,
    });
    const { items, total } = ctx.repo.listReports(configId, page.limit, page.offset);
    sendJson(res, 200, {
      items: items.map((r) => ({ id: r.id, grid: r.grid, summary: summary(r.report), created_at: r.created_at })),
      ...pageInfo(pathname, total, page.limit, page.offset),
    });
    return;
  }

  if (pathname === "/compare" && method === "POST") {
    const body = await readJson(req);
    const a = Number(body.config_a);
    const b = Number(body.config_b);
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      throw new AppError("VALIDATION_ERROR", "config_a and config_b must be integer ids.");
    }
    const grid = validateGrid(body.start_deg ?? -90, body.stop_deg ?? 90, body.step_deg ?? 1);
    sendJson(res, 200, ctx.service.compare(a, b, grid));
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${method} ${pathname}` } });
}

function pageInfo(base: string, total: number, limit: number, offset: number) {
  return {
    total,
    limit,
    offset,
    next: offset + limit < total ? `${base}?limit=${limit}&offset=${offset + limit}` : null,
  };
}

function paginate(
  base: string,
  items: unknown[],
  total: number,
  limit: number,
  offset: number,
  nextBuilder?: () => string,
) {
  return {
    items,
    total,
    limit,
    offset,
    next:
      offset + limit < total ? (nextBuilder ? nextBuilder() : `${base}?limit=${limit}&offset=${offset + limit}`) : null,
  };
}

export function startBoundToLocalhost(server: Server): Promise<{ port: number; host: string }> {
  return new Promise((resolve) => {
    // Port 0 = OS assigns an ephemeral port; bind loopback only.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, host: "127.0.0.1" });
    });
  });
}
