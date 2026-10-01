// SPEC-0237 P2 (T2.2) — el license-check atribuye su validate al room, lo anota en el registro
// del room y escribe el cache en forma atomica. `node --test`.
//
// QUE FIJA ESTA SUITE
//
//   1. X-Specoe-Room son 16 hex derivados del machine-id y la ruta REAL del room: iguales entre dos
//      corridas del mismo room (tambien escrito con otra forma de la ruta), distintos para otro
//      room, y sin la ruta ni el machine-id en claro. X-Specoe-Caller vale `hook`.
//   2. El registro del room tiene UNA entrada validate source hook por corrida, con el desenlace
//      (200 -> OK, 403 -> REJECTED), sin el JWT.
//   3. El registro NO frena al hook: con una llamada del proxy de hace 10 s, el hook valida igual.
//      Es la garantia de que sus decisiones de retiro y de gracia no cambiaron.
//   4. writeCache escribe a un temporal y renombra: un lector concurrente nunca ve un JSON parcial.
//
// La punta del CLI de renovacion (mismo X-Specoe-Room que el hook, caller `proxy`) la fija
// license-renew.test.mjs. Las suites previas (carrera-license-bootstrap, token-divergente,
// hub-hooks-drift, rol-declarado-license-validate, usercontext-license-validate) no se tocan: son
// el control de que el hook sigue haciendo lo mismo.
//
// Los E2E corren el hook en un subproceso contra un Hub falso de loopback, con CLAUDE_PROJECT_DIR,
// CLAUDE_HOME, HOME y USERPROFILE en temporales.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { writeCache, computeRoomAttribution } from '../specoe-license-check.mjs';
import { readLedger, SOURCE_PROXY } from '../specoe-room-ledger.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');

// En Windows el fingerprint se lleva casi todo el presupuesto real con wmic; aca no se mide
// presupuesto sino lo que el hook manda y anota.
const TEST_BUDGET_MS = '30000';
const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-atrib-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.firmafalsa`;
}

/** Hub falso: registra headers y body de cada validate; `status` decide la respuesta. */
function startFakeHub({ status = 200 } = {}) {
  const validate = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* body no-JSON */
      }
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/license/activate')) return json(200, { activated: true });
      if (req.url.endsWith('/license/validate')) {
        validate.push({ headers: req.headers, body });
        if (status !== 200) return json(status, { message: 'rechazado por el Hub falso' });
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          token: fakeJwt({ sub: 'lic-1', iat: now, exp: now + 3600 }),
          tenantId: 'tenant-1',
          tier: 'team',
          features: ['skills'],
        });
      }
      return json(404, { message: 'ruta no esperada por el Hub falso' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/v1`,
        validate,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function runHook({ projectDir, home, hubUrl }) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_HOME: home,
    HOME: home,
    USERPROFILE: home,
    INTEGRA_SECRETS_NO_KEYRING: '1',
    INTEGRA_HUB_URL: hubUrl,
    SPECOE_LICENSE_KEY: 'LIC-TEST-0237',
    SPECOE_LICENSE_TIMEOUT_MS: TEST_BUDGET_MS,
  };
  for (const k of [
    'NODE_EXTRA_CA_CERTS',
    'CLAUDE_ENV_FILE',
    'SPECOE_ALLOW_DEGRADED_START',
    'INTEGRA_SDD_ROLE',
    'INTEGRA_SDD_TENANT',
  ]) {
    delete env[k];
  }
  let stdout = '';
  let code = 0;
  try {
    stdout = (
      await execFileAsync(process.execPath, [LICENSE_CHECK], {
        encoding: 'utf8',
        timeout: 60000,
        env,
      })
    ).stdout;
  } catch (err) {
    code = err?.code ?? 1;
    stdout = String(err?.stdout ?? '');
  }
  const last = stdout.trim().split('\n').filter(Boolean).pop();
  let json = null;
  try {
    json = last ? JSON.parse(last) : null;
  } catch {
    /* los asserts lo nombran */
  }
  return { code, stdout, json };
}

// ---------- 1. el header de atribucion ----------

test('1. X-Specoe-Room: 16 hex, estable por room, distinto entre rooms, sin ruta ni machine-id', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home1');
  const roomA = tmpDir('roomA');
  const roomB = tmpDir('roomB');
  try {
    await runHook({ projectDir: roomA, home, hubUrl: hub.url });
    // Mismo room escrito con separador final: la ruta REAL es la misma, el room tambien.
    await runHook({ projectDir: roomA + path.sep, home, hubUrl: hub.url });
    await runHook({ projectDir: roomB, home, hubUrl: hub.url });
    assert.equal(hub.validate.length, 3, 'las tres corridas tenian que validar');

    const [a1, a2, b] = hub.validate;
    const roomHeader = (v) => v.headers['x-specoe-room'];
    for (const v of hub.validate) {
      assert.match(roomHeader(v), /^[0-9a-f]{16}$/, 'X-Specoe-Room tiene que ser 16 hex');
      assert.equal(v.headers['x-specoe-caller'], 'hook');
    }
    assert.equal(
      roomHeader(a1),
      roomHeader(a2),
      'el mismo room tiene que atribuirse igual en cada corrida',
    );
    assert.notEqual(roomHeader(a1), roomHeader(b), 'dos rooms no pueden compartir atribucion');

    // Nada en claro: ni la ruta ni el machine-id (el que viaja en el fingerprint del body).
    const machineId = String(a1.body.fingerprint?.machineId ?? '');
    assert.ok(
      machineId.length > 0,
      'el fingerprint trae el machine-id: sin el, el control de abajo no mide',
    );
    for (const v of hub.validate) {
      const h = roomHeader(v);
      assert.ok(
        !machineId.includes(h) && !h.includes(machineId),
        'el header deja ver el machine-id',
      );
      assert.ok(
        !h.includes(path.basename(roomA)) && !h.includes(path.basename(roomB)),
        'el header deja ver la ruta',
      );
    }
    // Y es la funcion exportada la que lo calcula: el CLI de renovacion usa la misma.
    assert.equal(roomHeader(a1), await computeRoomAttribution({ projectDir: roomA, machineId }));
  } finally {
    await hub.close();
  }
});

// ---------- 2. la llamada del hook en el registro ----------

for (const [status, outcome] of [
  [200, 'OK'],
  [403, 'REJECTED'],
]) {
  test(`2. HTTP ${status}: una entrada validate source hook por corrida, con desenlace ${outcome}`, async () => {
    const hub = await startFakeHub({ status });
    const home = tmpDir(`home2-${status}`);
    const room = tmpDir(`room2-${status}`);
    try {
      await runHook({ projectDir: room, home, hubUrl: hub.url });
      await runHook({ projectDir: room, home, hubUrl: hub.url });

      const entries = (await readLedger({ projectDir: room })).filter((e) => e.kind === 'validate');
      assert.equal(entries.length, 2, `una entrada por corrida: ${JSON.stringify(entries)}`);
      for (const e of entries) {
        assert.equal(e.source, 'hook');
        assert.equal(e.outcome, outcome);
        assert.equal(e.httpStatus, status);
        assert.equal(
          e.room,
          hub.validate[0].headers['x-specoe-room'],
          'el registro guarda el mismo room que el header (O12)',
        );
      }
      const raw = fs.readFileSync(path.join(room, '.claude', 'specoe-room-ledger.jsonl'), 'utf8');
      assert.doesNotMatch(raw, JWT_SHAPE, 'el registro no puede tener un JWT');
    } finally {
      await hub.close();
    }
  });
}

// ---------- 3. el registro no frena al hook ----------

test('3. con una llamada del proxy de hace 10 s el hook valida igual (no lo frena el tope)', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home3');
  const room = tmpDir('room3');
  try {
    const hace10s = new Date(Date.now() - 10 * 1000).toISOString();
    fs.writeFileSync(
      path.join(room, '.claude', 'specoe-room-ledger.jsonl'),
      JSON.stringify({
        kind: 'validate',
        id: 'previa',
        ts: hace10s,
        source: SOURCE_PROXY,
        outcome: 'OK',
        httpStatus: 200,
      }) + '\n',
    );
    const r = await runHook({ projectDir: room, home, hubUrl: hub.url });

    assert.equal(hub.validate.length, 1, 'el hook tenia que validar igual');
    assert.equal(r.code, 0);
    assert.equal(
      r.json?.specoeStatus,
      'ok',
      `el hook cambio de decision: ${r.stdout.slice(0, 300)}`,
    );
    const sources = (await readLedger({ projectDir: room })).map((e) => e.source);
    assert.deepEqual(
      sources,
      ['proxy', 'hook'],
      'la llamada del hook se anota detras de la del proxy',
    );
  } finally {
    await hub.close();
  }
});

// ---------- 4. cache atomico ----------

test('4. writeCache escribe a un temporal y renombra: un lector concurrente nunca ve un JSON parcial', async () => {
  const room = tmpDir('cache');
  const file = path.join(room, '.claude', 'specoe-license-cache.json');
  // Un cache grande agranda la ventana de escritura: con el fs.writeFile directo de antes, un
  // lector en paralelo agarra el archivo truncado o a medio escribir.
  const payload = (n) => ({
    licenseKey: 'LIC',
    token: 'x'.repeat(400 * 1024),
    validatedAt: String(n),
    n,
  });
  await writeCache(payload(0), { file });

  let done = false;
  let reads = 0;
  const parciales = [];
  const errores = [];
  const lector = (async () => {
    while (!done) {
      let raw;
      try {
        raw = await fsp.readFile(file, 'utf8');
      } catch (err) {
        errores.push(err.code);
        continue;
      }
      reads++;
      try {
        JSON.parse(raw);
      } catch {
        parciales.push(raw.length);
      }
    }
  })();
  for (let n = 1; n <= 150; n++) await writeCache(payload(n), { file });
  done = true;
  await lector;

  assert.ok(
    reads >= 20,
    `el lector tiene que haber leido en paralelo para que esto mida algo (leyo ${reads})`,
  );
  assert.deepEqual(parciales, [], `el lector vio ${parciales.length} JSON parciales`);
  assert.deepEqual(errores, [], `el lector no pudo abrir el cache: ${errores.join(',')}`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 150);
  // Ningun temporal queda tirado al lado del cache.
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')),
    [],
  );
});
