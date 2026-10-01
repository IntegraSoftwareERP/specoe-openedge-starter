// TKT-0454 — license-check y room-bootstrap corren EN PARALELO. `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// Los dos hooks estan en el mismo array de SessionStart y Claude Code corre en paralelo todos los
// hooks de un evento. specoe-room-bootstrap.mjs leia el cache de licencia apenas arrancaba,
// asumiendo que specoe-license-check.mjs ya lo habia refrescado ("corre antes que este"). Con la
// sesion anterior a mas de 55 min, el room arrancaba ungoverned (no-token) aunque la licencia
// validara un instante despues.
//
// Y la otra mitad: el license-check reescribe el .mcp.json con el JWT nuevo, pero Claude Code
// conecta los servers del .mcp.json ANTES de que corran los hooks de SessionStart (medido con
// 2.1.280, ver el comentario de describeLaunchSkillEntry). El MCP specoe de esa sesion conecta con
// el JWT viejo y responde 401. No se arregla desde el hook: se avisa, con la salida (reiniciar).
//
// LO QUE ESTA SUITE FIJA
//
//   1. waitForUsableToken espera lo justo: nada si el primer cache sirve, hasta que aparezca un
//      token usable, o hasta el plazo — con reloj inyectado, sin tiempo real.
//   2. E2E con los DOS hooks reales corriendo a la vez contra un Hub falso que tarda en validar:
//      el bootstrap agarra el JWT que el license-check deja, y no declara divergencia de tokens.
//   3. Control que reproduce el bug: la MISMA corrida con la espera en 0 da `no-token`. Sin este
//      control, el test 2 pasaria igual con un bootstrap que no espera y una maquina rapida.
//   4. Sin nadie que refresque el cache, el bootstrap espera el plazo y el motivo ya no afirma un
//      orden que no existe.
//   5. El aviso de reinicio del MCP: cuando sale, cuando NO sale, y el caso real del .mcp.json
//      versionado del starter (primera sesion tras instalar).
//   6. El orden de escritura del license-check: .mcp.json primero, cache al final.
//
// Los E2E corren los hooks en subprocesos con CLAUDE_PROJECT_DIR y CLAUDE_HOME en temporales:
// ninguna corrida toca la carpeta ni el keyring reales del dev.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  waitForUsableToken,
  usableCacheToken,
  buildNoTokenDetail,
  UNGOVERNED_PREFIX,
  DIVERGENCE_PREFIX,
} from '../specoe-room-bootstrap.mjs';
import {
  describeLaunchSkillEntry,
  buildMcpRestartNotice,
  persistValidatedLicense,
  decodeJwtExp,
  MCP_RESTART_PREFIX,
  DIAG_PREFIX,
  ROLE_REJECTED_PREFIX,
  STARTUP_DIAG_PREFIX,
} from '../specoe-license-check.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');
const ROOM_BOOTSTRAP = path.join(HERE, '..', 'specoe-room-bootstrap.mjs');
const STARTER_MCP_JSON = path.join(HERE, '..', '..', '..', '.mcp.json');

// Lo que tarda el Hub falso en contestar el validate. Es lo que vuelve DETERMINISTA el control
// del test 3: el license-check no puede escribir el cache antes de este plazo, y el bootstrap
// sin espera lee el cache mucho antes. Sin demora, en una maquina rapida el license-check podria
// ganar la carrera y el control dejaria de reproducir el bug.
const VALIDATE_DELAY_MS = 1500;
// Presupuesto generoso para el license-check: aca no se mide su presupuesto (en Windows el
// fingerprint con wmic se lleva casi todo el real), se mide la carrera.
const LICENSE_BUDGET_MS = '30000';
const MIN = 60 * 1000;

// ---------- helpers ----------

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt0454-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** JWT sin firma valida: los hooks solo lo decodifican. */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const expEn = (ms) => Math.floor((Date.now() + ms) / 1000);

function writeCache(projectDir, { token, ageMs }) {
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'specoe-license-cache.json'),
    JSON.stringify(
      {
        licenseKey: 'LIC-TEST-0454',
        validatedAt: new Date(Date.now() - ageMs).toISOString(),
        token,
        tier: 'team',
        features: ['skills'],
      },
      null,
      2,
    ),
  );
}

function readCache(projectDir) {
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, '.claude', 'specoe-license-cache.json'), 'utf8'),
  );
}

function specoeEntry(token) {
  return {
    type: 'sse',
    url: 'https://mcp.integra.local/sse',
    headers: { Authorization: `Bearer ${token}` },
  };
}

function writeMcp(projectDir, token) {
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { specoe: specoeEntry(token) } }, null, 2) + '\n',
  );
}

function mcpToken(projectDir) {
  const doc = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  return doc.mcpServers.specoe.headers.Authorization.replace(/^Bearer\s+/, '');
}

/**
 * Hub falso: activate + validate. El validate tarda VALIDATE_DELAY_MS y devuelve un JWT SIN claim
 * sddRole a proposito: asi el bootstrap que lo agarra corta en `no-role` sin tocar la red, y
 * `no-role` vs `no-token` es exactamente lo que discrimina si espero o no.
 */
function startFakeHub() {
  const emitidos = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/license/activate')) return json(200, { activated: true });
      if (req.url.endsWith('/license/validate')) {
        const token = fakeJwt({ sub: 'lic-0454', tier: 'team', exp: expEn(60 * MIN) });
        emitidos.push(token);
        setTimeout(
          () => json(200, { token, tenantId: 'tenant-1', tier: 'team', features: ['skills'] }),
          VALIDATE_DELAY_MS,
        );
        return undefined;
      }
      return json(404, { message: 'ruta no esperada por el Hub falso' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/v1`,
        emitidos,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function baseEnv(projectDir, home) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_HOME: home,
    INTEGRA_SECRETS_NO_KEYRING: '1',
  };
  // El entorno del dev no debe contaminar el escenario.
  for (const k of [
    'NODE_EXTRA_CA_CERTS',
    'CLAUDE_ENV_FILE',
    'SPECOE_SKILL_JWT',
    'SPECOE_ALLOW_DEGRADED_START',
    'SPECOE_LICENSE_KEY',
    'INTEGRA_SDD_ROLE',
    'INTEGRA_SDD_WORK_REPO',
    'SPECOE_BOOTSTRAP_LICENSE_WAIT_MS',
  ]) {
    delete env[k];
  }
  return env;
}

async function runNode(script, env) {
  const started = Date.now();
  let stdout = '';
  let code = 0;
  try {
    stdout = (
      await execFileAsync(process.execPath, [script], { encoding: 'utf8', timeout: 90000, env })
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
  return {
    code,
    stdout,
    json,
    context: json?.hookSpecificOutput?.additionalContext ?? '',
    elapsedMs: Date.now() - started,
  };
}

function runLicenseCheck({ projectDir, home, hubUrl }) {
  return runNode(LICENSE_CHECK, {
    ...baseEnv(projectDir, home),
    INTEGRA_HUB_URL: hubUrl,
    SPECOE_LICENSE_KEY: 'LIC-TEST-0454',
    SPECOE_LICENSE_TIMEOUT_MS: LICENSE_BUDGET_MS,
  });
}

function runBootstrap({ projectDir, home, waitMs }) {
  return runNode(ROOM_BOOTSTRAP, {
    ...baseEnv(projectDir, home),
    SPECOE_BOOTSTRAP_LICENSE_WAIT_MS: String(waitMs),
  });
}

/** El room de la sesion anterior, hace 2 h: cache vencido y .mcp.json con el JWT vencido. */
function roomDeHace2Horas(name) {
  const dir = tmpDir(name);
  const viejo = fakeJwt({ sub: 'lic-0454', sddRole: 'CC_DEV', exp: expEn(-60 * MIN) });
  writeCache(dir, { token: viejo, ageMs: 120 * MIN });
  writeMcp(dir, viejo);
  return { dir, viejo };
}

/** Reloj falso: el sleep avanza el reloj en vez de esperar. */
function relojFalso() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

// ---------- 1. la espera, pura ----------

test('1a. con un token usable en la primera lectura NO espera nada', async () => {
  const reloj = relojFalso();
  let lecturas = 0;
  const r = await waitForUsableToken({
    readToken: async () => {
      lecturas += 1;
      return 'tok';
    },
    waitMs: 6000,
    pollMs: 200,
    sleep: reloj.sleep,
    now: reloj.now,
  });
  assert.equal(r.token, 'tok');
  assert.equal(r.polls, 0);
  assert.equal(lecturas, 1);
  assert.deepEqual(reloj.sleeps, [], 'la sesion dentro de los 55 min no puede pagar espera');
});

test('1b. espera hasta que el cache trae un token usable y lo devuelve', async () => {
  const reloj = relojFalso();
  // El token aparece en la CUARTA lectura: las tres primeras ven el cache viejo.
  let lecturas = 0;
  const r = await waitForUsableToken({
    readToken: async () => (++lecturas >= 4 ? 'fresco' : null),
    waitMs: 6000,
    pollMs: 200,
    sleep: reloj.sleep,
    now: reloj.now,
  });
  assert.equal(r.token, 'fresco');
  assert.equal(r.polls, 3);
  assert.equal(r.waitedMs, 600);
});

test('1c. si nadie refresca el cache, corta en el plazo y devuelve null', async () => {
  const reloj = relojFalso();
  const r = await waitForUsableToken({
    readToken: async () => null,
    waitMs: 1000,
    pollMs: 300,
    sleep: reloj.sleep,
    now: reloj.now,
  });
  assert.equal(r.token, null);
  assert.equal(r.waitedMs, 1000, 'ni un ms mas que el plazo');
  // 300 + 300 + 300 + 100: el ultimo sleep se recorta al plazo, no lo pasa.
  assert.deepEqual(reloj.sleeps, [300, 300, 300, 100]);
});

test('1d. con la espera en 0 hace UNA lectura y vuelve: es el comportamiento anterior', async () => {
  const reloj = relojFalso();
  let lecturas = 0;
  const r = await waitForUsableToken({
    readToken: async () => {
      lecturas += 1;
      return null;
    },
    waitMs: 0,
    sleep: reloj.sleep,
    now: reloj.now,
  });
  assert.equal(r.token, null);
  assert.equal(lecturas, 1);
  assert.deepEqual(reloj.sleeps, []);
});

test('1e. usableCacheToken: fresco sirve, 56 min no, sin token no, sin validatedAt sirve (legacy)', () => {
  const ahora = Date.now();
  const iso = (ms) => new Date(ahora - ms).toISOString();
  assert.equal(usableCacheToken({ token: 't', validatedAt: iso(10 * MIN) }, ahora), 't');
  assert.equal(usableCacheToken({ token: 't', validatedAt: iso(56 * MIN) }, ahora), null);
  assert.equal(usableCacheToken({ validatedAt: iso(1 * MIN) }, ahora), null);
  assert.equal(usableCacheToken(null, ahora), null);
  assert.equal(usableCacheToken({ token: 't' }, ahora), 't');
});

// ---------- 2 y 3. los dos hooks reales, en paralelo ----------

test('2. E2E: en paralelo, el bootstrap espera y agarra el JWT que deja el license-check', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home2');
  const { dir, viejo } = roomDeHace2Horas('room2');
  try {
    const [lic, boot] = await Promise.all([
      runLicenseCheck({ projectDir: dir, home, hubUrl: hub.url }),
      runBootstrap({ projectDir: dir, home, waitMs: 60000 }),
    ]);

    assert.equal(lic.code, 0, `el license-check no debia bloquear; stdout: ${lic.stdout}`);
    assert.equal(lic.json?.specoeStatus, 'ok');
    assert.equal(hub.emitidos.length, 1, 'el license-check tiene que haber validado una vez');
    const nuevo = hub.emitidos[0];
    assert.notEqual(nuevo, viejo);

    // El bootstrap uso el JWT NUEVO: sin claim sddRole corta en `no-role`. Con el viejo del cache
    // hubiera cortado en `no-token` — que es el defecto del ticket.
    assert.equal(boot.code, 0, 'el bootstrap nunca bloquea');
    assert.match(
      boot.context,
      new RegExp(`\\[\\[${UNGOVERNED_PREFIX}:no-role\\]\\]`),
      `el bootstrap no agarro el JWT fresco; contexto: ${boot.context.slice(0, 300)}`,
    );
    assert.ok(!boot.context.includes(`${UNGOVERNED_PREFIX}:no-token`));
    assert.ok(
      boot.elapsedMs >= VALIDATE_DELAY_MS,
      `el bootstrap termino en ${boot.elapsedMs} ms: no pudo haber esperado al validate`,
    );

    // El cache es el punto de commit: cuando el bootstrap lo vio fresco, el .mcp.json ya tenia el
    // mismo JWT, asi que no hay divergencia que declarar.
    assert.ok(
      !boot.context.includes(DIVERGENCE_PREFIX),
      'el bootstrap vio media escritura del license-check y declaro una divergencia que no existe',
    );
    assert.equal(readCache(dir).token, nuevo);
    assert.equal(mcpToken(dir), nuevo);

    // El MCP specoe de esta sesion conecto con el .mcp.json de hace 2 h: el license-check lo dice.
    assert.ok(
      lic.context.includes(`[[${MCP_RESTART_PREFIX}:vencido]]`),
      `falta el aviso de reinicio; contexto: ${lic.context.slice(0, 300)}`,
    );
  } finally {
    await hub.close();
  }
});

test('3. control: la MISMA corrida sin espera reproduce el bug (no-token con licencia valida)', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home3');
  const { dir } = roomDeHace2Horas('room3');
  try {
    const [lic, boot] = await Promise.all([
      runLicenseCheck({ projectDir: dir, home, hubUrl: hub.url }),
      runBootstrap({ projectDir: dir, home, waitMs: 0 }),
    ]);

    assert.equal(lic.json?.specoeStatus, 'ok', 'la licencia valido: el escenario es el del ticket');
    assert.match(
      boot.context,
      new RegExp(`\\[\\[${UNGOVERNED_PREFIX}:no-token\\]\\]`),
      'sin espera el bootstrap tiene que leer el cache viejo — si no, el test 2 no mide la espera',
    );
  } finally {
    await hub.close();
  }
});

// ---------- 4. nadie refresca el cache ----------

test('4. sin license-check, espera el plazo y el motivo no afirma un orden que no existe', async () => {
  const home = tmpDir('home4');
  const { dir } = roomDeHace2Horas('room4');
  const boot = await runBootstrap({ projectDir: dir, home, waitMs: 1200 });

  assert.equal(boot.code, 0);
  assert.equal(boot.json?.specoeRoomContractStatus, 'ungoverned');
  assert.match(boot.context, new RegExp(`\\[\\[${UNGOVERNED_PREFIX}:no-token\\]\\]`));
  assert.ok(boot.elapsedMs >= 1200, `volvio en ${boot.elapsedMs} ms: no espero el plazo`);
  assert.match(boot.context, /EN PARALELO/);
  assert.match(boot.context, /specoe-license-<fecha>\.log/);
  assert.ok(
    !/corre antes que este/i.test(boot.context),
    'el motivo sigue afirmando que el hook de licencia corre antes',
  );
});

test('4b. buildNoTokenDetail nombra la espera en segundos y el cache', () => {
  const t = buildNoTokenDetail('/x/.claude/specoe-license-cache.json', 6000);
  assert.match(t, /6\.0 s/);
  assert.match(t, /specoe-license-cache\.json/);
  assert.match(t, /EN PARALELO/);
  assert.ok(!/corre antes que este/i.test(t));
});

// ---------- 5. el aviso de reinicio del MCP ----------

test('5a. describeLaunchSkillEntry: cada entry que no servia al lanzar tiene su motivo', () => {
  const ahora = Date.now();
  const doc = (entry) => ({ mcpServers: entry ? { specoe: entry } : {} });
  const opts = { now: ahora, env: {} };
  const jwt = (msHastaExp) => fakeJwt({ sub: 'x', exp: Math.floor((ahora + msHastaExp) / 1000) });

  assert.equal(describeLaunchSkillEntry(null, opts)?.motivo, 'sin-archivo');
  assert.equal(describeLaunchSkillEntry(doc(null), opts)?.motivo, 'sin-server');
  assert.equal(
    describeLaunchSkillEntry(doc({ type: 'sse', url: 'u', headers: {} }), opts)?.motivo,
    'sin-token',
  );
  assert.equal(
    describeLaunchSkillEntry(doc(specoeEntry('${SPECOE_SKILL_JWT}')), opts)?.motivo,
    'placeholder',
  );
  assert.equal(describeLaunchSkillEntry(doc(specoeEntry(jwt(-5 * MIN))), opts)?.motivo, 'vencido');
  assert.equal(
    describeLaunchSkillEntry(doc(specoeEntry(jwt(2 * MIN))), opts)?.motivo,
    'por-vencer',
  );
});

test('5b. control negativo: un entry que servia NO produce aviso', () => {
  const ahora = Date.now();
  const doc = (token) => ({ mcpServers: { specoe: specoeEntry(token) } });
  const vivo = fakeJwt({ sub: 'x', exp: Math.floor((ahora + 50 * MIN) / 1000) });

  assert.equal(describeLaunchSkillEntry(doc(vivo), { now: ahora, env: {} }), null);
  // El placeholder expandido con un JWT vivo en el entorno de lanzamiento tambien servia.
  assert.equal(
    describeLaunchSkillEntry(doc('${SPECOE_SKILL_JWT}'), {
      now: ahora,
      env: { SPECOE_SKILL_JWT: vivo },
    }),
    null,
  );
  // Sin `exp` no hay como juzgarlo: no se inventa un aviso.
  assert.equal(describeLaunchSkillEntry(doc(fakeJwt({ sub: 'x' })), { now: ahora, env: {} }), null);
  assert.equal(buildMcpRestartNotice(null), null);
});

test('5c. el .mcp.json versionado del starter (primera sesion tras instalar) da `placeholder`', () => {
  // Es el caso real mas comun: el starter publica el header con ${SPECOE_SKILL_JWT}, y el MCP de la
  // primera sesion conecta con eso sin expandir. Se lee el ARCHIVO del starter, no una copia.
  const starter = JSON.parse(fs.readFileSync(STARTER_MCP_JSON, 'utf8'));
  assert.equal(describeLaunchSkillEntry(starter, { env: {} })?.motivo, 'placeholder');
});

test('5d. el aviso da la salida, acota el alcance y no se pisa con los otros canales', () => {
  const t = buildMcpRestartNotice({
    motivo: 'vencido',
    detalle: 'el JWT habia vencido hace 60 min',
  });
  assert.ok(t.includes(`[[${MCP_RESTART_PREFIX}:vencido]]`));
  assert.match(t, /401/);
  assert.match(t, /cerra esta sesion y abri otra/);
  assert.match(
    t,
    /integra-hub no usa este JWT/,
    'tiene que decir que integra-hub no esta afectado',
  );
  assert.match(t, /no corta el arranque/);
  for (const otro of [DIAG_PREFIX, ROLE_REJECTED_PREFIX, STARTUP_DIAG_PREFIX, 'SPECOE-ROOM-']) {
    assert.ok(!t.includes(otro), `el aviso trae ${otro}: se confundiria con otro canal`);
    assert.ok(!otro.includes(MCP_RESTART_PREFIX));
  }
});

test('5e. decodeJwtExp lee el exp y devuelve null ante basura', () => {
  assert.equal(decodeJwtExp(fakeJwt({ exp: 1234 })), 1234);
  assert.equal(decodeJwtExp(fakeJwt({ sub: 'x' })), null);
  assert.equal(decodeJwtExp('no-es-un-jwt'), null);
  assert.equal(decodeJwtExp(undefined), null);
});

// ---------- 6. el orden de escritura ----------

test('6. persistValidatedLicense escribe el .mcp.json ANTES que el cache', async () => {
  const orden = [];
  const veredicto = { motivo: 'vencido', detalle: 'x' };
  const r = await persistValidatedLicense(
    { token: 'nuevo', validatedAt: new Date().toISOString() },
    {
      syncMcp: async (token) => {
        orden.push(`mcp:${token}`);
        return veredicto;
      },
      saveCache: async (cached) => {
        orden.push(`cache:${cached.token}`);
      },
    },
  );
  assert.deepEqual(
    orden,
    ['mcp:nuevo', 'cache:nuevo'],
    'el cache es el punto de commit que espera el bootstrap: va ULTIMO',
  );
  assert.equal(r, veredicto, 'devuelve el veredicto del entry con el que arranco la sesion');
});

// ---------- 7. el camino de deriva de hooks retira el entry specoe ----------

test('7. deriva de hooks: bloquea y retira `specoe` del .mcp.json, sin tocar los otros servers', async () => {
  // El incidente de SPEC-0236: el license-check bloqueaba por deriva (TKT-0321) y salia ANTES de
  // syncSkillServerEntry, asi que el .mcp.json seguia declarando `specoe` con el JWT de la ultima
  // corrida buena. La regla del archivo es "specoe si y solo si ESTA corrida tiene JWT usable".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specoe-tkt0454-deriva-'));
  const dir = path.join(root, 'room');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  // El room declara un hook del Hub que esta maquina NO tiene instalado: deriva.
  fs.writeFileSync(
    path.join(dir, 'vendor', 'MANIFEST.json'),
    JSON.stringify({
      components: [
        {
          name: 'ack-task-enforcer',
          file: 'ack-task-enforcer.mjs',
          basePath: '.claude-bundle/hooks',
          packageSha256: 'a'.repeat(64),
        },
      ],
    }),
  );
  const viejo = fakeJwt({ sub: 'lic-0454', sddRole: 'CC_DEV', exp: expEn(-60 * MIN) });
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          specoe: specoeEntry(viejo),
          'integra-hub': { command: 'node', args: ['x.js'] },
        },
      },
      null,
      2,
    ) + '\n',
  );

  // HOME y USERPROFILE al temporal: os.homedir() sale de ahi (HOME en POSIX, USERPROFILE en
  // Windows), y es donde el chequeo de deriva busca ~/.claude/hooks.
  const r = await runNode(LICENSE_CHECK, {
    ...baseEnv(dir, path.join(home, '.claude')),
    HOME: home,
    USERPROFILE: home,
  });

  assert.equal(r.code, 2, `tenia que bloquear por deriva; stdout: ${r.stdout.slice(0, 300)}`);
  assert.equal(r.json?.specoeStatus, 'blocked');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.equal(
    doc.mcpServers.specoe,
    undefined,
    'el camino de deriva dejo `specoe` declarado con un JWT que esta corrida no tiene',
  );
  assert.ok(doc.mcpServers['integra-hub'], 'retirar specoe no puede llevarse los otros servers');
});
