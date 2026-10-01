// SPEC-0237 P2 (T2.3) — el CLI de renovacion specoe-license-renew.mjs. `node --test`.
//
// EL RIESGO QUE FIJA ESTA SUITE (risk_flag 1 de P2): un CLI que renueve como el main() del hook
// escribiria el .mcp.json, emitiria contexto o bloquearia, y retiraria specoe a mitad de sesion —
// el corte inmediato que el scope de la SPEC prohibe. Por eso cada desenlace se corre sobre un room
// de fixture con un .mcp.json y un cache conocidos, y en TODOS se exige:
//   - el .mcp.json byte a byte igual, y CLAUDE_ENV_FILE sin escribir;
//   - stdout = UNA linea JSON con v 1, solo con los campos del contrato, sin el JWT;
//   - exit 0.
// Y ademas: con 200 el cache queda con el token nuevo y validatedAt actual; con cualquier otro
// desenlace el cache no cambia.
//
// DESENLACES: OK (200), REJECTED (403 y 404), TRANSIENT (429, 500, red caida y timeout), THROTTLED
// (reserva de hace menos de 60 s en el registro), DRIFT (hook del Hub instalado distinto del que
// declara el room) y NO_LICENSE. En los tres ultimos el Hub falso no recibe NINGUN request.
//
// ATRIBUCION (risk_flag 4, la punta del CLI): X-Specoe-Caller vale `proxy` y X-Specoe-Room es el
// MISMO que manda el hook para ese room, distinto para otro.
//
// Cada corrida es un subproceso con CLAUDE_PROJECT_DIR, CLAUDE_HOME, HOME y USERPROFILE en
// temporales: nada toca la instalacion real del dev.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readLedger } from '../specoe-room-ledger.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENEW = path.join(HERE, '..', 'specoe-license-renew.mjs');
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');

const CONTRACT_KEYS = new Set(['v', 'outcome', 'httpStatus', 'exp', 'retryAfterMs']);
const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;
const MIN = 60 * 1000;

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.firmafalsa`;
}

const OLD_TOKEN = fakeJwt({ sub: 'lic-1', iat: 1, exp: 3601, marca: 'viejo' });

/** Room de fixture: .mcp.json con specoe + otro server, y un cache viejo conocido. */
function fixtureRoom(name, { withCache = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-renew-${name}-`));
  const room = path.join(root, 'room');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(room, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  const mcp = path.join(room, '.mcp.json');
  fs.writeFileSync(
    mcp,
    JSON.stringify(
      {
        mcpServers: {
          specoe: {
            type: 'sse',
            url: 'https://mcp.integra.local/sse',
            headers: { Authorization: `Bearer ${OLD_TOKEN}` },
          },
          'integra-hub': { command: 'node', args: ['vendor/integra-hub-mcp.mjs'] },
        },
      },
      null,
      2,
    ) + '\n',
  );
  const cache = path.join(room, '.claude', 'specoe-license-cache.json');
  if (withCache) {
    fs.writeFileSync(
      cache,
      JSON.stringify(
        {
          licenseKey: 'LIC-TEST-0237',
          validatedAt: '2026-01-01T00:00:00.000Z',
          token: OLD_TOKEN,
          tier: 'team',
          features: [],
        },
        null,
        2,
      ),
    );
  }
  return {
    root,
    room,
    home,
    mcp,
    cache,
    envFile: path.join(root, 'claude-env-file'),
    mcpBytes: fs.readFileSync(mcp),
    cacheBytes: withCache ? fs.readFileSync(cache) : null,
  };
}

/** Hub falso. `mode`: un status HTTP, o 'hang' (acepta y no responde nunca). */
function startFakeHub(mode = 200) {
  const requests = [];
  const sockets = new Set();
  let issued = null;
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
      requests.push({ url: req.url, headers: req.headers, body });
      if (mode === 'hang') return;
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/license/activate')) return json(200, { activated: true });
      if (!req.url.endsWith('/license/validate')) return json(404, { message: 'ruta no esperada' });
      if (mode !== 200) return json(mode, { message: `status ${mode} del Hub falso` });
      const now = Math.floor(Date.now() / 1000);
      issued = fakeJwt({ sub: 'lic-1', iat: now, exp: now + 3600, marca: 'nuevo' });
      return json(200, { token: issued, tenantId: 'tenant-1', tier: 'team', features: ['skills'] });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/v1`,
        requests,
        issued: () => issued,
        validate: () => requests.filter((r) => r.url.endsWith('/license/validate')),
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

/** Un puerto de loopback sin nadie escuchando: "red caida" determinista (ECONNREFUSED). */
async function deadHubUrl() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return `http://127.0.0.1:${port}/api/v1`;
}

function childEnv(fx, hubUrl, extra = {}) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: fx.room,
    CLAUDE_HOME: fx.home,
    HOME: fx.home,
    USERPROFILE: fx.home,
    CLAUDE_ENV_FILE: fx.envFile,
    INTEGRA_SECRETS_NO_KEYRING: '1',
    INTEGRA_HUB_URL: hubUrl,
    SPECOE_LICENSE_KEY: 'LIC-TEST-0237',
    SPECOE_LICENSE_TIMEOUT_MS: '30000',
  };
  for (const k of [
    'NODE_EXTRA_CA_CERTS',
    'SPECOE_ALLOW_DEGRADED_START',
    'INTEGRA_SDD_ROLE',
    'INTEGRA_SDD_TENANT',
    'SPECOE_RENEW_DEADLINE_MS',
    'SPECOE_RENEW_FETCH_TIMEOUT_MS',
  ]) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

async function runRenew(fx, hubUrl, extra = {}) {
  const started = Date.now();
  let stdout = '';
  let code = 0;
  try {
    stdout = (
      await execFileAsync(process.execPath, [RENEW], {
        encoding: 'utf8',
        timeout: 60000,
        env: childEnv(fx, hubUrl, extra),
      })
    ).stdout;
  } catch (err) {
    code = err?.code ?? 1;
    stdout = String(err?.stdout ?? '');
  }
  return { code, stdout, elapsedMs: Date.now() - started };
}

/** Lo que vale para TODOS los desenlaces. Devuelve la salida parseada. */
function assertContract(r, fx, hub) {
  assert.equal(r.code, 0, `exit ${r.code}; stdout: ${r.stdout}`);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `stdout tiene que ser UNA linea: ${JSON.stringify(r.stdout)}`);
  const out = JSON.parse(lines[0]);
  assert.equal(out.v, 1);
  for (const k of Object.keys(out))
    assert.ok(CONTRACT_KEYS.has(k), `campo fuera del contrato v1: ${k}`);
  assert.doesNotMatch(r.stdout, JWT_SHAPE, 'el stdout no puede llevar un JWT');
  if (hub?.issued()) assert.ok(!r.stdout.includes(hub.issued()), 'el stdout lleva el JWT emitido');
  assert.ok(fs.readFileSync(fx.mcp).equals(fx.mcpBytes), 'el CLI modifico el .mcp.json');
  assert.equal(fs.existsSync(fx.envFile), false, 'el CLI escribio CLAUDE_ENV_FILE');
  return out;
}

function assertCacheUnchanged(fx) {
  assert.ok(
    fs.readFileSync(fx.cache).equals(fx.cacheBytes),
    'el cache cambio en un desenlace sin 200',
  );
}

function lastProxyEntry(entries) {
  return entries.filter((e) => e.kind === 'validate' && e.source === 'proxy').pop();
}

// ---------- OK ----------

test('200 -> OK: cache con el token nuevo y validatedAt actual, .mcp.json intacto, exp en la salida', async () => {
  const fx = fixtureRoom('ok');
  const hub = await startFakeHub(200);
  try {
    const r = await runRenew(fx, hub.url);
    const out = assertContract(r, fx, hub);

    assert.equal(out.outcome, 'OK');
    assert.equal(out.httpStatus, 200);
    const cache = JSON.parse(fs.readFileSync(fx.cache, 'utf8'));
    assert.equal(cache.token, hub.issued(), 'el cache tiene que quedar con el token nuevo');
    assert.ok(
      Date.now() - Date.parse(cache.validatedAt) < MIN,
      'validatedAt tiene que ser de esta corrida',
    );
    assert.equal(out.exp, JSON.parse(Buffer.from(hub.issued().split('.')[1], 'base64url')).exp);

    const entry = lastProxyEntry(await readLedger({ projectDir: fx.room }));
    assert.equal(entry?.outcome, 'OK');
    assert.equal(entry?.httpStatus, 200);
    assert.doesNotMatch(
      fs.readFileSync(path.join(fx.room, '.claude', 'specoe-room-ledger.jsonl'), 'utf8'),
      JWT_SHAPE,
    );
  } finally {
    await hub.close();
  }
});

// ---------- REJECTED / TRANSIENT por status ----------

for (const [status, outcome, espera] of [
  [403, 'REJECTED', 10 * MIN],
  [404, 'REJECTED', 10 * MIN],
  [429, 'TRANSIENT', MIN],
  [500, 'TRANSIENT', MIN],
]) {
  test(`${status} -> ${outcome}: cache y .mcp.json intactos, la proxima a los ${espera / MIN} min`, async () => {
    const fx = fixtureRoom(`s${status}`);
    const hub = await startFakeHub(status);
    try {
      const r = await runRenew(fx, hub.url);
      const out = assertContract(r, fx, hub);

      assert.equal(out.outcome, outcome);
      assert.equal(out.httpStatus, status);
      assertCacheUnchanged(fx);
      assert.ok(
        out.retryAfterMs > espera - 30 * 1000 && out.retryAfterMs <= espera,
        `retryAfterMs ${out.retryAfterMs}`,
      );
      assert.equal(hub.validate().length, 1);
      const entry = lastProxyEntry(await readLedger({ projectDir: fx.room }));
      assert.equal(entry?.outcome, outcome);
      assert.equal(entry?.httpStatus, status);
    } finally {
      await hub.close();
    }
  });
}

test('red caida -> TRANSIENT sin httpStatus, cache y .mcp.json intactos', async () => {
  const fx = fixtureRoom('red');
  const r = await runRenew(fx, await deadHubUrl());
  const out = assertContract(r, fx, null);

  assert.equal(out.outcome, 'TRANSIENT');
  assert.equal('httpStatus' in out, false, 'sin respuesta no hay status que informar');
  assertCacheUnchanged(fx);
  const entry = lastProxyEntry(await readLedger({ projectDir: fx.room }));
  assert.equal(entry?.outcome, 'TRANSIENT');
  assert.equal(entry?.httpStatus, null);
});

test('timeout -> TRANSIENT: el fetch se corta en su deadline y la corrida termina', async () => {
  const fx = fixtureRoom('timeout');
  const hub = await startFakeHub('hang');
  try {
    const r = await runRenew(fx, hub.url, { SPECOE_RENEW_FETCH_TIMEOUT_MS: '1500' });
    const out = assertContract(r, fx, hub);

    assert.equal(out.outcome, 'TRANSIENT');
    assert.equal(hub.validate().length, 1, 'el request tuvo que salir y quedar colgado');
    assertCacheUnchanged(fx);
    assert.ok(r.elapsedMs < 10 * 1000, `la corrida tardo ${r.elapsedMs} ms`);
  } finally {
    await hub.close();
  }
});

// ---------- sin request: THROTTLED, DRIFT, NO_LICENSE ----------

test('reserva de hace menos de 60 s -> THROTTLED con retryAfterMs, sin request al Hub', async () => {
  const fx = fixtureRoom('throttled');
  const hub = await startFakeHub(200);
  try {
    fs.writeFileSync(
      path.join(fx.room, '.claude', 'specoe-room-ledger.jsonl'),
      JSON.stringify({
        kind: 'validate',
        id: 'previa',
        ts: new Date(Date.now() - 10 * 1000).toISOString(),
        source: 'hook',
        outcome: 'OK',
        httpStatus: 200,
      }) + '\n',
    );
    const r = await runRenew(fx, hub.url);
    const out = assertContract(r, fx, hub);

    assert.equal(out.outcome, 'THROTTLED');
    assert.ok(
      out.retryAfterMs > 0 && out.retryAfterMs <= 50 * 1000,
      `retryAfterMs ${out.retryAfterMs}`,
    );
    assert.equal(hub.requests.length, 0, 'THROTTLED no puede tocar la red');
    assertCacheUnchanged(fx);
  } finally {
    await hub.close();
  }
});

test('deriva de un hook del Hub instalado -> DRIFT, sin request al Hub', async () => {
  const fx = fixtureRoom('drift');
  const hub = await startFakeHub(200);
  try {
    // El room declara el hook con un sha; la maquina tiene otro contenido instalado.
    const declarado = '// ack-task-enforcer v2\n';
    fs.mkdirSync(path.join(fx.room, 'vendor'), { recursive: true });
    fs.writeFileSync(
      path.join(fx.room, 'vendor', 'MANIFEST.json'),
      JSON.stringify({
        components: [
          {
            name: 'ack-task-enforcer',
            file: 'ack-task-enforcer.mjs',
            basePath: '.claude-bundle/hooks',
            artifactKind: 'file',
            packageSha256: createHash('sha256').update(declarado).digest('hex'),
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(fx.home, '.claude', 'hooks', 'ack-task-enforcer.mjs'),
      '// ack-task-enforcer v1\n',
    );

    const r = await runRenew(fx, hub.url);
    const out = assertContract(r, fx, hub);

    assert.equal(out.outcome, 'DRIFT');
    assert.equal(
      hub.requests.length,
      0,
      'con deriva no se consigue JWT: el Hub no puede recibir nada',
    );
    assertCacheUnchanged(fx);

    // Control: con el hook al dia, el mismo room renueva. Sin esto, DRIFT podria salir siempre.
    fs.writeFileSync(path.join(fx.home, '.claude', 'hooks', 'ack-task-enforcer.mjs'), declarado);
    const ok = await runRenew(fx, hub.url);
    assert.equal(JSON.parse(ok.stdout).outcome, 'OK');
  } finally {
    await hub.close();
  }
});

test('sin license key -> NO_LICENSE, sin request al Hub', async () => {
  // Sin cache (tiene licenseKey) y con un tenant que no existe en el keyring: no hay licencia.
  const fx = fixtureRoom('nolicense', { withCache: false });
  const hub = await startFakeHub(200);
  try {
    const r = await runRenew(fx, hub.url, {
      SPECOE_LICENSE_KEY: null,
      INTEGRA_SDD_TENANT: `tenant-sin-licencia-${process.pid}-${Date.now()}`,
    });
    const out = assertContract(r, fx, hub);

    assert.equal(out.outcome, 'NO_LICENSE');
    assert.equal(hub.requests.length, 0);
    assert.equal(fs.existsSync(fx.cache), false, 'sin licencia no se escribe cache');
  } finally {
    await hub.close();
  }
});

// ---------- atribucion ----------

test('el POST lleva X-Specoe-Caller proxy y el mismo X-Specoe-Room que el hook para ese room', async () => {
  const hub = await startFakeHub(200);
  const fxA = fixtureRoom('atribA');
  const fxB = fixtureRoom('atribB');
  try {
    // El hook, en el mismo room y con la misma maquina (mismo home).
    await execFileAsync(process.execPath, [LICENSE_CHECK], {
      encoding: 'utf8',
      timeout: 60000,
      env: childEnv(fxA, hub.url, { CLAUDE_ENV_FILE: null }),
    }).catch((err) => err);
    const deHook = hub.validate().at(-1);
    assert.equal(deHook?.headers['x-specoe-caller'], 'hook');

    // La llamada del hook deja al CLI frenado 60 s por el registro. Aca se mide la atribucion, no
    // el tope (ese lo fija room-ledger.test.mjs), asi que se limpia el registro antes de renovar.
    fs.rmSync(path.join(fxA.room, '.claude', 'specoe-room-ledger.jsonl'), { force: true });
    fxA.mcpBytes = fs.readFileSync(fxA.mcp); // el hook reescribio el .mcp.json: esa es la base ahora
    const rA = await runRenew(fxA, hub.url);
    assert.equal(assertContract(rA, fxA, hub).outcome, 'OK');
    const deProxyA = hub.validate().at(-1);

    const rB = await runRenew(fxB, hub.url);
    assert.equal(assertContract(rB, fxB, hub).outcome, 'OK');
    const deProxyB = hub.validate().at(-1);

    assert.equal(deProxyA.headers['x-specoe-caller'], 'proxy');
    assert.match(deProxyA.headers['x-specoe-room'], /^[0-9a-f]{16}$/);
    assert.equal(
      deProxyA.headers['x-specoe-room'],
      deHook.headers['x-specoe-room'],
      'hook y CLI del mismo room tienen que atribuirse igual',
    );
    assert.notEqual(
      deProxyB.headers['x-specoe-room'],
      deProxyA.headers['x-specoe-room'],
      'otro room, otra atribucion',
    );
    const machineId = String(deProxyA.body.fingerprint?.machineId ?? '');
    assert.ok(
      machineId && !machineId.includes(deProxyA.headers['x-specoe-room']),
      'el header deja ver el machine-id',
    );
  } finally {
    await hub.close();
  }
});
