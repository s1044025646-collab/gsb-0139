# Antenna Array Pattern & Beam-Weight Evaluation Backend

Local Windows backend for evaluating **1-D linear arrays of isotropic elements in
the far field**. It manages element positions, wavelength, complex weights,
steering angles, angular sampling, amplitude/phase quantization, configuration
versioning and analysis reports.

Scope limits (by design):

* API + CLI + synthetic fixtures + automated tests only. **No web UI.**
* **No RF transmission**, no connection to real communications hardware.
* Isotropic, isolated elements: **no mutual coupling and no embedded element
  pattern**. Every report says so explicitly.

## Physical model and conventions

* Elements lie on the x-axis at positions `x_n` (same length unit as wavelength).
* **Angle reference:** `theta` is measured from **broadside** (the axis normal to
  the element line). `theta = 0` is broadside; +/-90 deg are endfire. Domain `[-90, 90]`.
* **Phase/sign convention:** time dependence `exp(+jwt)`. Steering weight
  `w_n = exp(-j k x_n sin theta0)` with `k = 2*pi/lambda` cancels the incoming
  phase `+k x_n sin theta0`, so contributions add in phase at `theta0`.
* **Array factor:** `AF(theta) = sum_n w_n exp(+j k x_n sin theta)`.
* **Field amplitude** is `|AF|`; **power** is `|AF|^2` normalized to the pattern
  peak; **power dB = 10*log10(power)**. The -3 dB level is half *power*.
* Normalization divides by the pattern's own maximum, so a uniform rescaling of
  every weight leaves `powerLinear`/`powerDb` unchanged (tested).

## Reported quantities and search rules

* **Peak direction:** the unique global maximum. When several samples attain the
  same maximum (grating lobes, a flat single-element pattern) the pattern is
  marked `multipleEqualPeaks` and `peakDirectionDeg` is null; no unique pointing
  is forced.
* **Main-lobe boundary:** moving outward from the peak, the first **local
  minimum** (null) on each side defines the main-lobe region, so samples adjacent
  to the peak can never be counted as sidelobes.
* **HPBW:** linear-interpolated -3 dB crossing angles on each side. If a crossing
  or null does not exist on either side (beam cut off at the scan edge),
  `mainLobe.complete = false` and `hpbwDeg = null`.
* **Sidelobe search:** local maxima **strictly outside the main-lobe null
  region**, above a -60 dB floor. `sidelobeLevelDb` is the highest such lobe in
  dB relative to the peak (negative).
* **Grating lobe:** any sidelobe within 0.5 dB of the main peak, or multiple equal
  global peaks; `gratingLobe = true`.
* **All-zero weights:** `allZeroWeights = true`, no peak/HPBW/SLL reported.
* Angular grids are exact integer-step lists; comparing coarse/fine grids yields
  an error metric (finer grids refine HPBW while keeping the peak consistent).

## Requirements

* Node.js **>= 22.5** (built-in `node:sqlite` and native TypeScript execution;
  developed on Node v25). No runtime npm packages are required.
* Windows PowerShell for the start/stop helpers.

## Install

```powershell
npm install
```

Only TypeScript and its type definitions are installed (dev dependencies).

## Test

```powershell
npm test      # physics + service/db + HTTP API suites (33 tests)
npm run build # type-check (tsc --noEmit); no emit is needed to run
```

Tests cover: analytic two-element phase addition, symmetry, scaling invariance,
peak positions, Hann taper, grating lobes, edge steering, single element,
all-zero weights, main-lobe/sidelobe separation, fine-grid refinement,
quantization error, idempotent submission, transaction rollback, persistence
across restart, pagination, and API failure paths.

## Repeatable end-to-end demo

```powershell
npm run demo
```

Uses injected timestamps and idempotency keys; writes `data/demo.sqlite` only.

## Run / stop the server (loopback only)

```powershell
.\scripts\start.ps1   # binds 127.0.0.1 on an OS-assigned free port; URL in data/server.url
.\scripts\stop.ps1    # stops only the recorded project pid
```

Foreground alternative:

```powershell
npm start             # http://127.0.0.1:<auto port>, db at data/app.sqlite
```

The server never binds a non-loopback interface. Override the DB path with
`$env:ARRAY_DB_PATH="..."`. Migrations run on every start and are idempotent
(`CREATE TABLE IF NOT EXISTS`).

## CLI

`npm run cli -- <command>`. State-changing commands print `[before]`/`[after]`.

```powershell
npm run cli -- init-db
npm run cli -- create-array --name ula8 --wavelength 1 --positions -1.75,-1.25,-0.75,-0.25,0.25,0.75,1.25,1.75 --steer 20 --taper hann
npm run cli -- steer --id 1 --angle 40
npm run cli -- quantize --id 2 --amplitude-levels 16 --phase-states 64
npm run cli -- disable --id 3 --element 2
npm run cli -- scan --id 1 --step 0.1
npm run cli -- compare --base 1 --candidate 2 --step 0.2
npm run cli -- export --id 1 --step 0.5 --out data/ula.csv
npm run cli -- list --limit 20 --offset 0 --search ula
npm run cli -- show --id 1
npm run cli -- lineage --id 1
```

`steer`, `quantize` and `disable` always create a **new version** with
`parentId`; the baseline version is never rewritten. A failed element is forced
to zero and marked disabled; other weights are kept exactly (no renormalization).

## HTTP API

`POST` accepts the `Idempotency-Key` header; repeating a request with the same
key returns the original stored record.

* `GET  /health`
* `GET  /api/configs?limit=&offset=&search=` paginated list
* `POST /api/configs` create array (`name,wavelength,positions,steerAngleDeg?,taper?,note?`)
* `GET  /api/configs/:id`
* `GET  /api/configs/:id/lineage`
* `POST /api/configs/:id/steer` body `{steerAngleDeg}`
* `POST /api/configs/:id/quantize` body `{quantization:{amplitudeLevels?,phaseStates?}}`
* `POST /api/configs/:id/disable` body `{elementIndex}`
* `POST|GET /api/configs/:id/scan` POST / `?full=1` includes per-angle samples
* `GET  /api/configs/:id/export?stepDeg=` CSV with convention header
* `GET|POST /api/compare/:baseId/:candidateId` pattern error metrics on a shared grid

Error body: `{ "error": { "code", "message", "field?" } }` with codes
`VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONFLICT` (409), `INTERNAL` (500).

## Data and cleanup

Everything stays under the project: the SQLite database, WAL files, CSV exports,
demo/CLI databases and server logs live in `data/`. `stop.ps1` kills only the pid
recorded by `start.ps1`. Full reset:

```powershell
.\scripts\stop.ps1
Remove-Item -Recurse -Force data
```
