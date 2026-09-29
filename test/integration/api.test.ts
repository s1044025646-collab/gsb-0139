import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { openDatabase } from "../../src/db/database.ts";
import { createApp, startBoundToLocalhost } from "../../src/api/app.ts";

let base: string;
let server: Server;
let dir: string;

function removeTemp(target: string, attempts = 5): void {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      const waitUntil = Date.now() + 50 * (i + 1);
      while (Date.now() < waitUntil) {}
    }
  }
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

before(async () => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  dir = mkdtempSync(join(resolve(".tmp"), "array-api-"));
  const db = openDatabase(join(dir, "api.db"));
  server = createApp(db);
  const { port, host } = await startBoundToLocalhost(server);
  base = `http://${host}:${port}`;
});

after(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        removeTemp(dir);
        resolve();
      });
    }),
);

test("health and conventions endpoints", async () => {
  const h = await api("/health");
  assert.equal(h.status, 200);
  const c = await api("/conventions");
  assert.match(JSON.stringify(c.body.conventions), /broadside/);
});

test("create -> steer -> quantize -> disable -> scan full lifecycle", async () => {
  const created = await api("/arrays", {
    method: "POST",
    body: JSON.stringify({ name: "ula", wavelength: 0.1, count: 8, spacing: 0.05 }),
  });
  assert.equal(created.status, 201);
  const id = (created.body.config as { id: number }).id;

  const steered = await api(`/arrays/${id}/steer`, {
    method: "POST",
    body: JSON.stringify({ steer_angle_deg: 25 }),
  });
  assert.equal(steered.status, 201);
  const sid = (steered.body.config as { id: number }).id;
  assert.notEqual(sid, id);

  const q = await api(`/arrays/${sid}/quantize`, {
    method: "POST",
    body: JSON.stringify({ phase_bits: 3 }),
  });
  assert.equal(q.status, 201);
  assert.ok((q.body.error as { normalized_mse: number }).normalized_mse > 0);

  const disabled = await api(`/arrays/${sid}/disable`, {
    method: "POST",
    body: JSON.stringify({ index: 2 }),
  });
  assert.equal(disabled.status, 201);
  const did = (disabled.body.config as { id: number }).id;
  const weights = (disabled.body.config as { weights: { re: number; im: number }[] }).weights;
  assert.deepEqual({ re: weights[2]!.re, im: weights[2]!.im }, { re: 0, im: 0 });
  // baseline config is untouched
  const baseline = await api(`/arrays/${sid}`);
  const bw = (baseline.body.config as { weights: { re: number }[] }).weights;
  assert.notEqual(bw[2]!.re, 0);

  const scan = await api(`/arrays/${did}/scan?step=0.5&samples=1`, {});
  assert.equal(scan.status, 200);
  const s = scan.body.summary as { unique_peak: boolean; hpbw_deg: number | null };
  assert.equal(s.unique_peak, true);
  assert.ok(typeof s.hpbw_deg === "number");
});

test("validation failures carry explicit error codes", async () => {
  const badWavelength = await api("/arrays", {
    method: "POST",
    body: JSON.stringify({ name: "x", wavelength: 0, count: 2, spacing: 0.05 }),
  });
  assert.equal(badWavelength.status, 400);
  assert.equal((badWavelength.body.error as { code: string }).code, "VALIDATION_ERROR");

  const badGrid = await api("/arrays/1/scan?start_deg=-100&stop_deg=90&step_deg=1");
  assert.equal(badGrid.status, 400);
  assert.equal((badGrid.body.error as { code: string }).code, "BAD_GRID");

  const missing = await api("/arrays/99999");
  assert.equal(missing.status, 404);
  assert.equal((missing.body.error as { code: string }).code, "NOT_FOUND");

  const badElement = await api("/arrays/1/disable", {
    method: "POST",
    body: JSON.stringify({ index: 999 }),
  });
  assert.equal(badElement.status, 400);
  assert.equal((badElement.body.error as { code: string }).code, "ELEMENT_OUT_OF_RANGE");
});

test("pagination metadata and bounds", async () => {
  for (let i = 0; i < 3; i++) {
    await api("/arrays", {
      method: "POST",
      body: JSON.stringify({ name: `p${i}`, wavelength: 0.1, count: 2, spacing: 0.05 }),
    });
  }
  const page = await api("/arrays?limit=2&offset=0");
  assert.equal(page.status, 200);
  assert.equal((page.body.items as unknown[]).length, 2);
  assert.ok((page.body.total as number) >= 5);
  assert.match(String(page.body.next), /offset=2/);

  const bad = await api("/arrays?limit=0");
  assert.equal(bad.status, 400);
  assert.equal((bad.body.error as { code: string }).code, "INVALID_PAGINATION");
});

test("idempotent steering does not create duplicate versions", async () => {
  const created = await api("/arrays", {
    method: "POST",
    body: JSON.stringify({ name: "idem", wavelength: 0.1, count: 4, spacing: 0.05 }),
  });
  const id = (created.body.config as { id: number }).id;
  const payload = { method: "POST" as const, body: JSON.stringify({ steer_angle_deg: 15, idempotency_key: "steer-15" }) };
  const a = await api(`/arrays/${id}/steer`, payload);
  const b = await api(`/arrays/${id}/steer`, payload);
  assert.equal((a.body.config as { id: number }).id, (b.body.config as { id: number }).id);
});

test("compare endpoint reports metric deltas", async () => {
  const a = await api("/arrays", {
    method: "POST",
    body: JSON.stringify({ name: "ca", wavelength: 0.1, count: 8, spacing: 0.05 }),
  });
  const b = await api(`/arrays/${(a.body.config as { id: number }).id}/steer`, {
    method: "POST",
    body: JSON.stringify({ steer_angle_deg: 20, taper: "hann" }),
  });
  const cmp = await api("/compare", {
    method: "POST",
    body: JSON.stringify({
      config_a: (a.body.config as { id: number }).id,
      config_b: (b.body.config as { id: number }).id,
      step: 0.5,
    }),
  });
  assert.equal(cmp.status, 200);
  assert.ok(typeof (cmp.body as { peak_angle_delta_deg: number }).peak_angle_delta_deg === "number");
});
