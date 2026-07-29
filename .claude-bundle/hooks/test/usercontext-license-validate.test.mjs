// TKT-0232 — el arranque declara el usuario del seat al validar la licencia. `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// En USER-mode el claim `sddRole` del JWT de licencia lo DERIVA el Hub de los UserSddRole
// del usuario que el caller declara en `userContext` (license.service.ts resolveBundleRole,
// fail-closed). specoe-license-check.mjs mandaba el body del /license/validate con
// licenseKey + fingerprint y NADA mas: el Hub emitia el JWT sin claim, el skill-server
// resolvia `role = payload.sddRole ?? null` y TODO room recien onboardeado corria como
// producto. No fallaba nada de forma visible — de ahi que sobreviviera a dos tickets.
//
// LO QUE ESTA SUITE FIJA
//
//   1. Con el userId en el canal, el body del validate LLEVA `userContext` con ese valor.
//   2. Sin material en el canal, el body NO lleva la clave y el arranque valida igual. Sin
//      este control, el test 1 pasaria con un hook que manda cualquier cosa siempre —
//      y en MACHINE-mode mandar basura es peor que no mandar nada.
//   3. Instalacion anterior al fix (token + machineId en el canal, SIN userId): el hook lo
//      DERIVA contra /auth/sdd/session, lo manda, y lo deja guardado. El segundo arranque
//      ya no toca /auth/sdd/session: es one-shot, no un request por sesion.
//   4. deriveUserId es fail-open y el motivo viaja: rechazo del Hub -> null + reason con el
//      code, material incompleto -> null SIN request.
//   5. El verificador ya no atribuye el claim ausente a "licencia de producto" a secas: el
//      mensaje del chequeo 4 nombra tambien la causa de USER-mode. Se mira el CODIGO, no
//      los comentarios — una correccion escrita solo en un comentario no la lee ningun dev
//      parado frente al FAIL.
//
// Los E2E corren el hook en un subproceso contra un Hub falso de loopback, con
// CLAUDE_PROJECT_DIR y CLAUDE_HOME en temporales: ninguna corrida toca la instalacion real
// del dev ni su keyring (INTEGRA_SECRETS_NO_KEYRING=1 fuerza el cipher-file del home temp).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  deriveUserId,
  decodeJwtPayload,
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
} from '../sdd-identity.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');
const SECRETS = path.join(HERE, '..', 'secrets.mjs');
const VERIFIER = path.join(HERE, '..', '..', 'scripts', 'verify-room-serving.mjs');
const SDD_LOGIN = path.join(HERE, '..', '..', 'scripts', 'sdd-login.mjs');

// Mismo criterio que degraded-path.test.mjs: en Windows el fingerprint se lleva casi todo
// el presupuesto real con wmic, y aca no medimos presupuesto sino el contenido del body.
const TEST_BUDGET_MS = '30000';

const USER_ID = 'usr-cuid-del-seat';
const SDD_TOKEN = 'isdd_' + 'a'.repeat(64);
const MACHINE_ID = 'mach-cuid-1';

// ---------- helpers ----------

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt0232-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** JWT sin firma valida: solo tiene que ser decodificable para leer `sub`. */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

/**
 * Escribe un secreto en el canal del home temporal. Va por subproceso a proposito:
 * secrets.mjs congela CLAUDE_HOME al importarse, asi que setearlo desde este proceso
 * despues del import no tendria efecto y el test sembraria en el home REAL del dev.
 */
async function seedSecret(home, service, name, value) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.setSecret(${JSON.stringify(service)}, ${JSON.stringify(name)}, ${JSON.stringify(value)}))`;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_HOME: home, INTEGRA_SECRETS_NO_KEYRING: '1' },
    timeout: 30000,
  });
}

/** Lee un secreto del canal del home temporal. null si no esta. */
async function readSecret(home, service, name) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.getSecret(${JSON.stringify(service)}, ${JSON.stringify(name)}))` +
    `.then((v) => process.stdout.write(JSON.stringify(v ?? null)))`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_HOME: home, INTEGRA_SECRETS_NO_KEYRING: '1' },
    timeout: 30000,
  });
  return JSON.parse(stdout || 'null');
}

/**
 * Hub falso: activate + validate + auth/sdd/session. Registra el body de cada request para
 * que el test afirme sobre lo que el hook MANDO, no sobre lo que el hook loguea.
 */
function startFakeHub() {
  const recibido = { activate: [], validate: [], session: [], login: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* body no-JSON: queda {} */
      }
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/license/activate')) {
        recibido.activate.push(body);
        return json(200, { activated: true });
      }
      if (req.url.endsWith('/license/validate')) {
        recibido.validate.push(body);
        // El claim del JWT devuelto refleja lo que el Hub real hace: con userContext hay
        // rol, sin userContext no hay claim. Asi el cache del room queda como quedaria
        // en la instalacion real y el test 2 no depende de un token de fantasia.
        const payload = { sub: 'lic-1', tier: 'team' };
        if (body.userContext) payload.sddRole = 'CC_DEV';
        return json(200, {
          token: fakeJwt(payload),
          tenantId: 'tenant-1',
          tier: 'team',
          features: ['skills'],
        });
      }
      if (req.url.endsWith('/auth/sdd/session')) {
        recibido.session.push(body);
        return json(200, { accessToken: fakeJwt({ sub: USER_ID }), expiresIn: 900 });
      }
      if (req.url.endsWith('/auth/sdd/login')) {
        recibido.login.push(body);
        // Shape de SddLoginResult: NO trae userId — es justamente por eso que hay que
        // derivarlo. Si el Hub algun dia lo devuelve, este test sigue siendo valido.
        return json(200, {
          token: SDD_TOKEN,
          machineId: MACHINE_ID,
          machineStatus: 'PENDING',
          tenantId: 'tenant-1',
          tenantSlug: 'tenant',
          roles: ['CC_DEV'],
          robot: { configured: false, provisioned: false },
        });
      }
      return json(404, { message: 'ruta no esperada por el Hub falso' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/v1`,
        recibido,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Corre el hook como lo spawnea Claude Code. Devuelve exit code + el JSON de la ultima linea. */
async function runHook({ projectDir, home, hubUrl, env = {} }) {
  const childEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_HOME: home,
    INTEGRA_SECRETS_NO_KEYRING: '1',
    INTEGRA_HUB_URL: hubUrl,
    SPECOE_LICENSE_KEY: 'LIC-TEST-0232',
    SPECOE_LICENSE_TIMEOUT_MS: TEST_BUDGET_MS,
  };
  delete childEnv.NODE_EXTRA_CA_CERTS;
  delete childEnv.CLAUDE_ENV_FILE;
  delete childEnv.SPECOE_ALLOW_DEGRADED_START;
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete childEnv[k];
    else childEnv[k] = v;
  }
  let stdout = '';
  let code = 0;
  try {
    const r = await execFileAsync(process.execPath, [LICENSE_CHECK], {
      encoding: 'utf8',
      timeout: 60000,
      env: childEnv,
    });
    stdout = r.stdout;
  } catch (err) {
    code = err?.code ?? 1;
    stdout = String(err?.stdout ?? '');
  }
  const last = stdout.trim().split('\n').filter(Boolean).pop();
  let json = null;
  try {
    json = last ? JSON.parse(last) : null;
  } catch {
    /* salida no-JSON: los asserts lo nombran */
  }
  return { code, stdout, json };
}

// ---------- 1. el userId del canal viaja como userContext ----------

test('1. con el userId en el canal, el validate lleva userContext', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home1');
  const project = tmpDir('proj1');
  try {
    await seedSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME, USER_ID);
    const r = await runHook({ projectDir: project, home, hubUrl: hub.url });

    assert.equal(r.code, 0, `el hook no debia bloquear; stdout: ${r.stdout}`);
    assert.equal(r.json?.specoeStatus, 'ok');
    assert.equal(hub.recibido.validate.length, 1, 'el hook tiene que haber validado');
    assert.equal(
      hub.recibido.validate[0].userContext,
      USER_ID,
      'el body del validate tiene que declarar el usuario del seat',
    );
    // Nada de lo anterior se rompe: la licencia y el fingerprint siguen viajando.
    assert.equal(hub.recibido.validate[0].licenseKey, 'LIC-TEST-0232');
    assert.ok(hub.recibido.validate[0].fingerprint?.machineId, 'el fingerprint sigue en el body');
    // Con userContext el Hub deriva el claim: el room queda con rol, no como producto.
    const cache = JSON.parse(
      await fsp.readFile(path.join(project, '.claude', 'specoe-license-cache.json'), 'utf8'),
    );
    assert.equal(decodeJwtPayload(cache.token)?.sddRole, 'CC_DEV');
    // El userId ya estaba: no se gasta un request de derivacion por sesion.
    assert.equal(hub.recibido.session.length, 0, 'no debia derivar: el canal ya lo tenia');
  } finally {
    await hub.close();
  }
});

// ---------- 2. control negativo: sin material no se inventa el campo ----------

test('2. sin material en el canal, el body NO lleva userContext y el arranque valida igual', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home2');
  const project = tmpDir('proj2');
  try {
    const r = await runHook({ projectDir: project, home, hubUrl: hub.url });

    assert.equal(r.code, 0);
    assert.equal(r.json?.specoeStatus, 'ok');
    assert.equal(hub.recibido.validate.length, 1);
    assert.ok(
      !('userContext' in hub.recibido.validate[0]),
      'sin usuario declarado la clave no va: el body tiene que ser el de antes del fix',
    );
    // Y no se hace ningun request de derivacion: sin material no hay nada que canjear.
    assert.equal(hub.recibido.session.length, 0);
  } finally {
    await hub.close();
  }
});

// ---------- 3. instalacion anterior al fix: deriva una vez y guarda ----------

test('3. con token+machineId pero sin userId, el hook lo deriva, lo manda y lo persiste', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home3');
  const project = tmpDir('proj3');
  try {
    await seedSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME, SDD_TOKEN);
    await seedSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME, MACHINE_ID);

    const r1 = await runHook({ projectDir: project, home, hubUrl: hub.url });
    assert.equal(r1.code, 0);
    assert.equal(hub.recibido.session.length, 1, 'tenia que canjear el token por una sesion');
    assert.equal(hub.recibido.session[0].token, SDD_TOKEN);
    assert.equal(hub.recibido.session[0].machineId, MACHINE_ID);
    assert.ok(
      hub.recibido.session[0].fingerprint?.diskSerialHash,
      'la derivacion manda el fingerprint SDD, no el de licencia',
    );
    assert.equal(hub.recibido.validate[0].userContext, USER_ID);

    // Persistido: el segundo arranque lo lee del canal y NO vuelve a derivar.
    assert.equal(await readSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME), USER_ID);
    const r2 = await runHook({ projectDir: project, home, hubUrl: hub.url });
    assert.equal(r2.code, 0);
    assert.equal(hub.recibido.session.length, 1, 'la derivacion es one-shot, no por sesion');
    assert.equal(hub.recibido.validate[1].userContext, USER_ID);
  } finally {
    await hub.close();
  }
});

// ---------- 4. deriveUserId: fail-open con el motivo adentro ----------

test('4. deriveUserId devuelve null con el code del Hub cuando la derivacion es rechazada', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ code: 'MACHINE_FINGERPRINT_MISMATCH' }),
  });
  const r = await deriveUserId({
    hubUrl: 'https://hub.test/api/v1',
    token: SDD_TOKEN,
    machineId: MACHINE_ID,
    fingerprint: { hostname: 'h', os: 'win32', cpuModel: 'c', diskSerialHash: 'd' },
    fetchImpl,
  });
  assert.equal(r.userId, null);
  assert.match(r.reason, /403/);
  assert.match(
    r.reason,
    /MACHINE_FINGERPRINT_MISMATCH/,
    'el code del Hub tiene que viajar: "HTTP 403" solo no nombra cual binding se rompio',
  );
});

test('5. deriveUserId no hace ningun request si falta material', async () => {
  let llamado = false;
  const fetchImpl = async () => {
    llamado = true;
    throw new Error('no debia salir a la red');
  };
  const sinMachine = await deriveUserId({
    hubUrl: 'https://hub.test/api/v1',
    token: SDD_TOKEN,
    machineId: null,
    fetchImpl,
  });
  const sinToken = await deriveUserId({
    hubUrl: 'https://hub.test/api/v1',
    token: null,
    machineId: MACHINE_ID,
    fetchImpl,
  });
  assert.equal(sinMachine.userId, null);
  assert.equal(sinToken.userId, null);
  assert.equal(llamado, false);
});

// ---------- 6. el login deja el userId en el canal (camino primario) ----------

test('6. el login SDD guarda el userId del seat en el canal', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home6');
  try {
    const { stdout } = await execFileAsync(process.execPath, [SDD_LOGIN, 'login'], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        CLAUDE_HOME: home,
        INTEGRA_SECRETS_NO_KEYRING: '1',
        SDD_LOGIN_EMAIL: 'dev@test.local',
        SDD_LOGIN_PASSWORD: 'secreta',
        SDD_LOGIN_HUB_URL: hub.url,
      },
    });
    const out = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());

    assert.equal(out.ok, true, `el login tenia que salir bien: ${stdout}`);
    assert.equal(out.userIdStored, true, 'el login tiene que dejar el userId en el canal');
    assert.equal(hub.recibido.session.length, 1, 'lo deriva canjeando el token por una sesion');
    // El material principal sigue guardandose igual (no se rompe lo de SPEC-0157 P6).
    assert.equal(await readSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME), SDD_TOKEN);
    assert.equal(
      await readSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME),
      MACHINE_ID,
    );
    assert.equal(await readSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME), USER_ID);
    // Y NUNCA a stdout: el userId no es secreto, pero el token si — el contrato de la
    // salida del login es que no lleva material.
    assert.ok(!stdout.includes(SDD_TOKEN), 'el UserSddToken no puede salir por stdout');
  } finally {
    await hub.close();
  }
});

// ---------- 7. el verificador nombra la causa de USER-mode ----------

test('7. el chequeo 4 del verificador ya no atribuye el claim ausente solo a la licencia', async () => {
  const fuente = await fsp.readFile(VERIFIER, 'utf8');
  // Se mira el CODIGO: un mensaje corregido solo en un comentario no lo lee nadie parado
  // frente al FAIL. Se strippean las lineas que son comentario completo.
  const codigo = fuente
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

  assert.match(codigo, /userContext/, 'el mensaje tiene que nombrar el userContext');
  assert.match(codigo, /USER-mode/, 'el mensaje tiene que nombrar el modo USER');
  assert.match(
    codigo,
    /--login/,
    'la accion tiene que dar la via concreta de USER-mode (setup.sh --login)',
  );
  // La causa de MACHINE-mode no se pierde: el mensaje cubre los DOS modos, no cambia de
  // razonamiento equivocado.
  assert.match(codigo, /specoe-add-room\.sh/, 'la via de MACHINE-mode sigue estando');
});
