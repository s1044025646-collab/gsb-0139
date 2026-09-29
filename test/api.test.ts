import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartResult } from "../src/server.ts";
import type { Config } from "../src/types.ts";

let dir: string;
let app: StartResult;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "array-api-"));
  app = await startServer(join(dir, "api.sqlite"));
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function req(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function j(res: Response): Promise<any> {
  return res.json();
}

test("health", async () => {
  const res = await req("/health");
  assert.equal(res.status, 200);
  assert.equal((await j(res)).ok, true);
});

test("create + get config; validation errors carry code and field", async () => {
  const bad = await req("/api/configs", { method: "POST", body: JSON.stringify({ name: "x" }) });
  assert.equal(bad.status, 400);
  const body = await j(bad);
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.ok(body.error.field);

  const ok = await req("/api/configs", {
    method: "POST",
    body: JSON.stringify({ name: "ula8", wavelength: 1, positions: [-1.75, -1.25, -0.75, -0.25, 0.25, 0.75, 1.25, 1.75] }),
  });
  assert.equal(ok.status, 201);
  const cfg = (await j(ok)) as Config;
  assert.equal(cfg.version, 1);
  assert.equal(cfg.elements.length, 8);
});

test("idempotency key makes duplicate POST identical", async () => {
  const payload = JSON.stringify({ name: "idem", wavelength: 1, positions: [0, 0.5, 1] });
  const r1 = await req("/api/configs", { method: "POST", body: payload, idempotencyKey: "abc-123" });
  const r2 = await req("/api/configs", { method: "POST", body: payload, idempotencyKey: "abc-123" });
  const a = await j(r1);
  const b = await j(r2);
  assert.equal(a.id, b.id);
});

test("full workflow: steer -> quantize -> disable -> scan -> compare", async () => {
  const created = await req("/api/configs", {
    method: "POST",
    body: JSON.stringify({ name: "wf", wavelength: 1, positions: Array.from({ length: 8 }, (_, i) => (i - 3.5) * 0.5) }),
  });
  const c0 = (await j(created)) as Config;

  const steered = await req(`/api/configs/${c0.id}/steer`, {
    method: "POST",
    body: JSON.stringify({ steerAngleDeg: 30 }),
  });
  assert.equal(steered.status, 201);
  const c1 = (await j(steered)) as Config;
  assert.equal(c1.parentId, c0.id);

  const quant = await req(`/api/configs/${c1.id}/quantize`, {
    method: "POST",
    body: JSON.stringify({ phaseStates: 4 }),
  });
  assert.equal(quant.status, 201);
  const c2 = (await j(quant)) as Config;
  assert.deepEqual(c2.quantization, { amplitudeLevels: null, phaseStates: 4 });

  const dis = await req(`/api/configs/${c2.id}/disable`, {
    method: "POST",
    body: JSON.stringify({ elementIndex: 0 }),
  });
  assert.equal(dis.status, 201);

  const scan = await req(`/api/configs/${c1.id}/scan`, {
    method: "POST",
    body: JSON.stringify({ grid: { stepDeg: 0.2 } }),
  });
  assert.equal(scan.status, 200);
  const report = await j(scan);
  assert.ok(Array.isArray(report.samples));
  assert.ok(Math.abs(report.peakDirectionDeg - 30) < 0.25);
  assert.ok(report.convention.angleReference.includes("broadside"));

  const summary = await req(`/api/configs/${c1.id}/scan?stepDeg=0.2`);
  const s = await j(summary);
  assert.equal(s.samples, undefined);

  const cmp = await req(`/api/compare/${c1.id}/${c2.id}`, {
    method: "POST",
    body: JSON.stringify({ grid: { stepDeg: 0.2 } }),
  });
  assert.equal(cmp.status, 200);
  const comparison = await j(cmp);
  assert.ok(comparison.maxAbsPowerDifference >= 0);
});

test("pagination query parameters enforced (limit cap and bad values)", async () => {
  const ok = await req("/api/configs?limit=2&offset=0");
  const page = await j(ok);
  assert.equal(page.limit, 2);
  assert.ok(page.items.length <= 2);

  const bad = await req("/api/configs?limit=-5");
  assert.equal(bad.status, 400);
  assert.equal((await j(bad)).error.code, "VALIDATION_ERROR");
});

test("404 for missing config and unknown route", async () => {
  const a = await req("/api/configs/9999");
  assert.equal(a.status, 404);
  const b = await req("/nope");
  assert.equal(b.status, 404);
});

test("export CSV with documented convention header", async () => {
  const created = await req("/api/configs", {
    method: "POST",
    body: JSON.stringify({ name: "csv", wavelength: 1, positions: [0, 0.5] }),
  });
  const cfg = (await j(created)) as Config;
  const res = await req(`/api/configs/${cfg.id}/export?stepDeg=5`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("text/csv"));
  const text = await res.text();
  assert.ok(text.includes("angle_ref=broadside"));
  assert.ok(text.includes("theta_deg,af_re,af_im,power_linear,power_db"));
  const dataLines = text.trim().split("\n").filter((l) => !l.startsWith("#") && !l.startsWith("theta"));
  assert.equal(dataLines.length, 37); // -90..90 step 5 inclusive
});

test("invalid JSON body rejected", async () => {
  const res = await req("/api/configs", { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
});
