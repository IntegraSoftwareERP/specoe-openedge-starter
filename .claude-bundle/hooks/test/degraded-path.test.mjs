// SPEC-0164 P2 / T2.5 — suite del camino degradado. `node --test`. Node 22 y Node 26.
//
// Cubre lo que P2 contrata:
//   1. Los TRES mensajes de fallo son distinguibles y ninguno culpa a la licencia cuando
//      no hubo respuesta HTTP (T2.1).
//   2. Las dos ramas del bloqueo: con cache de grace fresco arranca, sin cache corta (T2.2).
//   3. El mensaje de bloqueo trae los CUATRO datos obligatorios y la via de escape, y la
//      via FUNCIONA en la misma corrida (T2.2 + riesgo declarado 1 de la fase).
//   4. El .mcp.json sin JWT no declara `specoe` y preserva los demas servers (T2.3).
//   5. El arranque sin contrato NO trae el sentinel SPECOE-ROOM-CONTRACT y SI trae la
//      declaracion de degradacion (T2.4 / O6).
//
// Los escenarios end-to-end corren el hook en un subproceso con CLAUDE_PROJECT_DIR
// apuntando a un directorio temporal: el cache de licencia y el .mcp.json viven ahi, asi
// que ninguna corrida toca la instalacion real del dev.
//
// El Hub "caido" es un puerto efimero de loopback reservado y liberado — ECONNREFUSED
// inmediato, sin DNS y sin depender de que la maquina no tenga red. El Hub que "rechaza"
// es un http.Server local que contesta 403.

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

const execFileAsync = promisify(execFile);

import {
  buildFailureContext,
  buildHeadline,
  hasAllRequiredDiagnostics,
  DIAG_PREFIX,
  REQUIRED_DIAG_KEYS,
  ESCAPE_HATCH_ENV,
  SCENARIO_NO_HUB_RESPONSE,
  SCENARIO_LICENSE_REJECTED,
  SCENARIO_NO_LICENSE_KEY,
} from '../specoe-license-check.mjs';
import { buildAdditionalContext, buildUngovernedContext } from '../specoe-room-bootstrap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');
const ROOM_BOOTSTRAP = path.join(HERE, '..', 'specoe-room-bootstrap.mjs');
// Puerto efimero reservado y liberado: ECONNREFUSED garantizado, sin DNS y sin depender de
// que la maquina no tenga red. Un puerto fijo bajo (1, 7, 9...) NO sirve: undici los
// rechaza por la lista de bad ports y el errno que sale es 'bad port', no el de conexion.
const DEAD_PORT = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const DEAD_HUB = `http://127.0.0.1:${DEAD_PORT}/api/v1`;
// El presupuesto real del hook son 4,5 s (settings.json le da 5 s de timeout) y en Windows
// el fingerprint se lleva casi todo con wmic. En los tests no medimos el presupuesto:
// medimos el camino degradado, asi que le damos aire para que el timeout no enmascare el
// escenario que si estamos midiendo.
const TEST_BUDGET_MS = '30000';
// El sentinel se escribe literal a proposito: si alguien lo renombra en el hook, el test 12
// deja de estar midiendo lo que dice medir y hay que enterarse aca.
const SENTINEL = 'SPECOE-ROOM-CONTRACT';

// ---------- helpers ----------

function tmpProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-p2-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

// Corre un hook como proceso, igual que lo spawnea Claude Code. Devuelve el exit code, el
// stdout crudo y el JSON de la ultima linea (que es lo que el harness lee).
//
// ASINCRONO a proposito: con execFileSync el event loop de ESTE proceso queda bloqueado
// mientras el hook corre, asi que el Hub falso del escenario 9 nunca llega a contestar y el
// test mide un timeout en vez del 403 que dice medir.
async function runHook(hookPath, { projectDir, env = {} } = {}) {
  const childEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    SPECOE_LICENSE_TIMEOUT_MS: TEST_BUDGET_MS,
  };
  // El entorno del dev no debe contaminar el escenario.
  delete childEnv.NODE_EXTRA_CA_CERTS;
  delete childEnv.SPECOE_LICENSE_KEY;
  delete childEnv[ESCAPE_HATCH_ENV];
  delete childEnv.CLAUDE_ENV_FILE;
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete childEnv[k];
    else childEnv[k] = v;
  }
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync(process.execPath, [hookPath], {
      encoding: 'utf8',
      timeout: 60000,
      env: childEnv,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    code = err?.code ?? 1;
    stdout = String(err?.stdout ?? '');
    stderr = String(err?.stderr ?? '');
  }
  let json = null;
  const last = stdout.trim().split('\n').filter(Boolean).pop();
  if (last) {
    try {
      json = JSON.parse(last);
    } catch {
      /* no era JSON — el test que lo necesite fallara con el crudo a la vista */
    }
  }
  return { code, stdout, stderr, json };
}

function contextOf(res) {
  return res.json?.hookSpecificOutput?.additionalContext ?? '';
}

function writeCache(projectDir, { ageMinutes = 0, token = null, tier = 'PRO' } = {}) {
  const validatedAt = new Date(Date.now() - ageMinutes * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'specoe-license-cache.json'),
    JSON.stringify({ licenseKey: 'test-key', validatedAt, token, tier, features: [] }, null, 2),
  );
}

const MCP_TEMPLATE = {
  mcpServers: {
    specoe: {
      type: 'sse',
      url: '${SPECOE_SKILL_SERVER_URL:-https://mcp.integra.local/sse}',
      headers: { Authorization: 'Bearer ${SPECOE_SKILL_JWT}' },
    },
    'integra-hub': {
      command: 'node',
      args: ['node_modules/integra-hub-mcp/dist/index.js'],
      env: { INTEGRA_SDD_IDENTITY_MODE: 'USER' },
    },
  },
};

function writeMcpTemplate(projectDir) {
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify(MCP_TEMPLATE, null, 2) + '\n',
  );
}

function readMcp(projectDir) {
  return JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
}

// Diagnosticos de referencia para los tests puros. `ca` con reason 'ca-missing' es el caso
// del dev nuevo: sin root de Caddy instalado.
const CA_MISSING = { ok: false, caPath: '/tmp/caddy-local-root.crt', reason: 'ca-missing' };
const CA_OK = {
  ok: true,
  caPath: '/tmp/caddy-local-root.crt',
  reason: 'ok',
  subject: 'CN=Caddy Local Authority',
  storeBefore: 140,
  storeAfter: 141,
  system: 60,
  bundled: 140,
};
const HUB = { url: 'https://hub.integra.local/api/v1', source: 'env INTEGRA_HUB_URL' };

const DIAG_NO_HUB = {
  scenario: SCENARIO_NO_HUB_RESPONSE,
  net: {
    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    cause: 'unable to get local issuer certificate',
  },
  hub: HUB,
  ca: CA_MISSING,
};
const DIAG_REJECTED = { scenario: SCENARIO_LICENSE_REJECTED, httpStatus: 403, hub: HUB, ca: CA_OK };
const DIAG_NO_KEY = { scenario: SCENARIO_NO_LICENSE_KEY, hub: HUB, ca: null };

// ---------- 1. los tres mensajes son distinguibles ----------

test('1. tres escenarios, tres mensajes distintos y auto-identificables', () => {
  const a = buildFailureContext(DIAG_NO_HUB);
  const b = buildFailureContext(DIAG_REJECTED);
  const c = buildFailureContext(DIAG_NO_KEY);

  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
  // El titular es lo que lee primero el dev: tiene que bastar para saber cual ocurrio.
  const heads = [a, b, c].map((t) => t.split('\n')[0]);
  assert.equal(new Set(heads).size, 3, 'dos escenarios comparten titular');

  assert.match(a, /NO hubo respuesta del Hub/);
  assert.match(b, /rechazo la licencia \(HTTP 403\)/);
  assert.match(c, /no hay license key/i);
});

// ---------- 2. el mensaje sin respuesta del Hub NO culpa a la licencia ----------

test('2. sin respuesta HTTP, el mensaje no atribuye el fallo a la licencia', () => {
  const t = buildFailureContext(DIAG_NO_HUB);
  // El defecto exacto de RE-006: `SpecOE license invalida y cache expirado`.
  assert.doesNotMatch(t, /licencia\s+(invalida|expirada|vencida|rechazada)/i);
  assert.doesNotMatch(t, /license\s+invalida/i);
  // Y lo dice de frente, que es lo unico que corta la confusion heredada.
  assert.match(t, /NO de la licencia/);
  // El unico escenario que SI puede hablar de la licencia es el rechazo con 4xx.
  assert.match(buildFailureContext(DIAG_REJECTED), /licencia/i);
});

// ---------- 3. los cuatro datos obligatorios ----------

test('3. los cuatro datos estan en los tres mensajes y en el bloqueo', () => {
  for (const diag of [DIAG_NO_HUB, DIAG_REJECTED, DIAG_NO_KEY]) {
    const t = buildFailureContext(diag);
    for (const k of REQUIRED_DIAG_KEYS) {
      assert.ok(t.includes(`${DIAG_PREFIX} ${k}:`), `falta el dato ${k} en ${diag.scenario}`);
    }
    assert.equal(hasAllRequiredDiagnostics(t), true);
  }
  const blocked = buildFailureContext({ ...DIAG_NO_HUB, blocked: true });
  assert.equal(hasAllRequiredDiagnostics(blocked), true);
  assert.ok(blocked.includes(`${DIAG_PREFIX} escape:`), 'el bloqueo no trae la via de escape');
});

test('3b. control negativo — hasAllRequiredDiagnostics rechaza un mensaje incompleto', () => {
  // Un gate que no puede dar rojo no es un gate: si esto pasara, el test 3 seria decorativo.
  assert.equal(hasAllRequiredDiagnostics('SpecOE: algo salio mal'), false);
  assert.equal(hasAllRequiredDiagnostics(''), false);
  assert.equal(hasAllRequiredDiagnostics(null), false);
  const casiCompleto = buildFailureContext(DIAG_NO_HUB)
    .split('\n')
    .filter((l) => !l.startsWith(`${DIAG_PREFIX} ca:`))
    .join('\n');
  assert.equal(
    hasAllRequiredDiagnostics(casiCompleto),
    false,
    'sin el dato de CA tiene que dar rojo',
  );
});

test('4. el dato de CA distingue "no llegue" de "no llegue porque el CA no esta en el trust"', () => {
  const sinCa = buildFailureContext(DIAG_NO_HUB);
  const conCa = buildFailureContext({ ...DIAG_NO_HUB, ca: CA_OK });
  assert.match(sinCa, /el archivo NO existe/);
  assert.match(sinCa, /NO quedo en el store del proceso/);
  assert.match(conCa, /SI quedo en el store efectivo del proceso/);
  // Y la accion cambia con el dato: no tiene sentido mandar a instalar el CA si ya esta.
  assert.match(sinCa, /specoe-setup-host\.sh/);
  assert.doesNotMatch(conCa, /specoe-setup-host\.sh/);
  assert.match(conCa, /proxy\/firewall/);
});

test('5. el titular por si solo identifica el escenario', () => {
  assert.notEqual(buildHeadline(DIAG_NO_HUB), buildHeadline(DIAG_REJECTED));
  assert.notEqual(buildHeadline(DIAG_REJECTED), buildHeadline(DIAG_NO_KEY));
});

// ---------- 6. E2E: sin cache de grace, el arranque se BLOQUEA ----------

test('6. E2E sin cache de grace — corta con exit != 0 y con los cuatro datos', async () => {
  const dir = tmpProject('block');
  const res = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });

  assert.notEqual(res.code, 0, `el arranque no se bloqueo (stdout=${res.stdout})`);
  assert.equal(res.json?.specoeStatus, 'blocked');
  assert.equal(res.json?.continue, false, 'sin continue:false el harness no corta');
  const ctx = contextOf(res);
  assert.equal(hasAllRequiredDiagnostics(ctx), true, `bloqueo mudo: ${ctx}`);
  assert.ok(ctx.includes(`${DIAG_PREFIX} escape:`), 'bloqueo sin via de escape');
  // El errno REAL, no el `fetch failed` pelado.
  assert.match(ctx, /ECONNREFUSED/);
  assert.doesNotMatch(ctx.split('\n')[1], /^\S+ errno: fetch failed/);
  // El mismo cuerpo tiene que estar en stderr: es lo que ve el dev si el harness no lee el JSON.
  assert.equal(
    hasAllRequiredDiagnostics(res.stderr),
    true,
    'el stderr del bloqueo no trae el diagnostico',
  );
});

// ---------- 7. E2E: la via de escape funciona en la misma corrida ----------

test('7. E2E via de escape por variable — arranca degradado, sin bloquear', async () => {
  const dir = tmpProject('escape-env');
  const res = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB, [ESCAPE_HATCH_ENV]: '1' },
  });
  assert.equal(res.code, 0, `la via de escape no destrabo el arranque: ${res.stderr}`);
  assert.equal(res.json?.specoeStatus, 'degraded');
  assert.notEqual(res.json?.continue, false);
  assert.match(contextOf(res), /escape-activo/);
});

test('7b. E2E via de escape por archivo — la que el mensaje manda crear', async () => {
  const dir = tmpProject('escape-file');
  // Primero el bloqueo, para sacar la ruta del propio mensaje: el criterio de la fase es
  // que el dev arranque siguiendo UNICAMENTE lo que dice el mensaje.
  const blocked = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });
  assert.notEqual(blocked.code, 0);
  const escapeLine = contextOf(blocked)
    .split('\n')
    .find((l) => l.startsWith(`${DIAG_PREFIX} escape:`));
  assert.ok(escapeLine, 'el bloqueo no dijo como escaparse');
  const m = escapeLine.match(/touch "([^"]+)"/);
  assert.ok(m, `el mensaje no trae un comando ejecutable: ${escapeLine}`);

  // Se ejecuta exactamente lo que el mensaje dice.
  await fsp.writeFile(m[1], '');
  const after = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });
  assert.equal(after.code, 0, 'la via de escape que publica el mensaje no funciona');
  assert.equal(after.json?.specoeStatus, 'degraded');
});

// ---------- 8. E2E: con cache de grace fresco, arranca ----------

test('8. E2E cache de grace fresco — arranca, y el contexto igual trae los cuatro datos', async () => {
  const dir = tmpProject('grace');
  writeCache(dir, { ageMinutes: 5, token: null });
  const res = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });
  assert.equal(res.code, 0, `el grace period no evito el bloqueo: ${res.stderr}`);
  assert.equal(res.json?.specoeStatus, 'cached');
  const ctx = contextOf(res);
  assert.match(ctx, /grace period/);
  assert.equal(hasAllRequiredDiagnostics(ctx), true, 'el arranque con cache degrado en silencio');
  // Y NO trae via de escape: no hay nada de que escaparse, la sesion arranco.
  assert.ok(!ctx.includes(`${DIAG_PREFIX} escape:`));
});

test('8b. E2E cache stale (25 h) — vuelve a la rama que bloquea', async () => {
  const dir = tmpProject('stale');
  writeCache(dir, { ageMinutes: 25 * 60, token: null });
  const res = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });
  assert.notEqual(res.code, 0, 'un cache de 25 h no puede contar como grace');
  assert.equal(res.json?.specoeStatus, 'blocked');
});

// ---------- 9. E2E: el Hub responde y rechaza (4xx) ----------

test('9. E2E licencia rechazada con 403 — el mensaje habla de la licencia, no de la red', async () => {
  const server = http.createServer((req, res) => {
    // Drenar el body antes de contestar: un server que no lo consume deja el socket a medio
    // camino y el cliente muere por timeout — que es justo el otro escenario.
    req.resume();
    req.on('end', () => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'license revoked' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const dir = tmpProject('rejected');
    const res = await runHook(LICENSE_CHECK, {
      projectDir: dir,
      env: {
        SPECOE_LICENSE_KEY: 'test-key',
        INTEGRA_HUB_URL: `http://127.0.0.1:${port}/api/v1`,
      },
    });
    const ctx = contextOf(res);
    assert.match(ctx, /RESPONDIO y rechazo la licencia \(HTTP 403\)/);
    assert.match(ctx, /El canal funciono/);
    assert.equal(hasAllRequiredDiagnostics(ctx), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------- 10. E2E: el .mcp.json sin JWT ----------

test('10. E2E sin JWT — el .mcp.json no declara specoe y preserva los demas servers', async () => {
  const dir = tmpProject('mcp');
  writeMcpTemplate(dir);
  const res = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });
  assert.notEqual(res.code, 0);
  const doc = readMcp(dir);
  assert.equal(doc.mcpServers.specoe, undefined, 'el room sigue fingiendo que esta servido');
  assert.ok(doc.mcpServers['integra-hub'], 'se llevo puestos los otros mcpServers');
  // El placeholder literal no puede sobrevivir en ninguna parte del archivo.
  assert.doesNotMatch(
    fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'),
    /\$\{SPECOE_SKILL_JWT\}/,
  );
});

test('10b. E2E cache de grace con JWT usable — ahi si el .mcp.json declara specoe', async () => {
  const dir = tmpProject('mcp-grace');
  writeMcpTemplate(dir);
  writeCache(dir, { ageMinutes: 5, token: 'jwt-de-prueba' });
  const res = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });
  assert.equal(res.code, 0);
  const doc = readMcp(dir);
  assert.equal(doc.mcpServers.specoe.headers.Authorization, 'Bearer jwt-de-prueba');
});

test('10c. E2E cache de grace con JWT vencido (56 min) — se retira igual', async () => {
  const dir = tmpProject('mcp-stale-jwt');
  writeMcpTemplate(dir);
  writeCache(dir, { ageMinutes: 56, token: 'jwt-vencido' });
  const res = await runHook(LICENSE_CHECK, {
    projectDir: dir,
    env: { SPECOE_LICENSE_KEY: 'test-key', INTEGRA_HUB_URL: DEAD_HUB },
  });
  assert.equal(res.code, 0, 'el cache de 56 min sigue dentro de las 24 h de grace');
  assert.equal(readMcp(dir).mcpServers.specoe, undefined);
});

// ---------- 11. el room declara que arranca sin contrato (O6) ----------

test('11. buildUngovernedContext declara la degradacion y NO trae el sentinel', () => {
  const t = buildUngovernedContext('no-token', 'no hay JWT fresco.');
  assert.ok(!t.includes(SENTINEL), 'la declaracion de degradacion no puede traer el sentinel');
  assert.match(t, /SIN su contrato de gobierno/);
  assert.match(t, /SPECOE-ROOM-UNGOVERNED/);
});

test('11b. control positivo — el contrato inyectado SI trae el sentinel', () => {
  // Sin esto, el test 11 pasaria aunque el sentinel hubiera desaparecido del hook.
  assert.ok(buildAdditionalContext('CC_DEV', '# contrato').includes(SENTINEL));
});

test('12. E2E room-bootstrap sin cache — declara la degradacion, sin sentinel', async () => {
  const dir = tmpProject('room-no-token');
  const res = await runHook(ROOM_BOOTSTRAP, { projectDir: dir });
  assert.equal(res.code, 0, 'el bootstrap del room nunca bloquea');
  assert.equal(res.json?.specoeRoomContractStatus, 'ungoverned');
  const ctx = contextOf(res);
  assert.ok(!ctx.includes(SENTINEL), 'apareceria como si el contrato hubiera bajado');
  assert.match(ctx, /SIN su contrato de gobierno/);
  assert.match(ctx, /no-token/);
});

test('12b. E2E room-bootstrap con JWT sin claim sddRole — declara el motivo correcto', async () => {
  const dir = tmpProject('room-no-role');
  const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
  writeCache(dir, { ageMinutes: 1, token: `h.${payload}.s` });
  const res = await runHook(ROOM_BOOTSTRAP, { projectDir: dir });
  assert.equal(res.code, 0);
  const ctx = contextOf(res);
  assert.ok(!ctx.includes(SENTINEL));
  assert.match(ctx, /no-role/);
  assert.match(ctx, /sddRole/);
});
