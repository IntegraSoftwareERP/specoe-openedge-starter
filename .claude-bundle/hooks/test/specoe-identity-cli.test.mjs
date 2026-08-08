// SPEC-0187 P5 (TSK-1105) — contrato del CLI del canal de identidad + no-fuga de secretos.
// `node --test`.
//
// EL DEFECTO QUE ESTA SUITE PREVIENE
//
// La fase publica el keyring del SO como CLI para consumidores de afuera del bundle. Una
// superficie nueva que toca credenciales tiene dos formas conocidas de filtrarlas, y las dos
// son silenciosas: un password aceptado por argv queda en el history del shell y visible en
// la lista de procesos para cualquier usuario de la maquina; un token impreso por default
// termina en el log de quien orqueste el CLI — que es justo el caso de uso (el plugin lo
// corre por child_process). Ninguna de las dos rompe nada cuando pasa: el comando anda, y el
// secreto queda copiado donde nadie lo mira.
//
// LO QUE ESTA SUITE FIJA
//
//   (a) login RECHAZA el password por argv, con exit code de uso y mensaje que lo nombra.
//   (b) status, logout y session-token SIN --print-token no contienen el valor del token en
//       stdout NI en stderr — assert sobre el output COMPLETO, con control positivo: el
//       mismo token SI aparece con `session-token --print-token`. Sin ese control, un CLI
//       que jamas devuelve el token pasaria (b) sin cumplir su contrato.
//   (c) session-token sin el flag falla con instruccion (nombra --print-token), no con un
//       error mudo.
//   (d) TODOS los subcomandos emiten JSON parseable y versionado (schemaVersion 1), tanto en
//       exito (stdout) como en fallo (stderr): el consumidor decide por `ok`/`code`, nunca
//       por el texto.
//   (e) sdd-login.mjs directo sigue operativo y con SU contrato de antes (status y login por
//       ENV, mismo shape de stdout, mismos exit codes). El CLI nuevo reusa su motor — si el
//       refactor le hubiera cambiado la salida, el camino solo-CLI del starter se rompia sin
//       que nada mas lo notara.
//
// Todo corre en subproceso contra un CLAUDE_HOME temporal con INTEGRA_SECRETS_NO_KEYRING=1:
// ninguna corrida toca el keyring real del dev ni su instalacion.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
} from '../sdd-identity.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY_CLI = path.join(HERE, '..', '..', 'scripts', 'specoe-identity.mjs');
const SDD_LOGIN = path.join(HERE, '..', '..', 'scripts', 'sdd-login.mjs');
const SECRETS = path.join(HERE, '..', 'secrets.mjs');

// En Windows el fingerprint se lleva casi todo el presupuesto real con wmic, y aca no medimos
// presupuesto sino el contrato de salida. Mismo criterio que las suites vecinas.
const TIMEOUT_MS = 60000;

// El valor que NO tiene que aparecer en ningun output que no lo pida explicitamente.
const TOKEN = 'isdd_TOKEN_QUE_NO_DEBE_FILTRARSE';
const MACHINE_ID = 'machine-cuid-de-prueba';
const USER_ID = 'usr-cuid-del-seat';

// ---------- helpers ----------

function tmpHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-0187p5-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** Corre un script del bundle en subproceso y devuelve el resultado COMPLETO, sin tirar. */
function run(script, args, { home, stdin = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        CLAUDE_HOME: home,
        INTEGRA_SECRETS_NO_KEYRING: '1',
        // Que ninguna corrida herede credenciales del entorno del dev.
        SDD_LOGIN_EMAIL: '',
        SDD_LOGIN_PASSWORD: '',
        SDD_LOGIN_HUB_URL: '',
        INTEGRA_HUB_API_URL: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout corriendo ${path.basename(script)} ${args.join(' ')}`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, all: stdout + stderr });
    });
    child.stdin.end(stdin);
  });
}

const identity = (args, opts) => run(IDENTITY_CLI, args, opts);

/**
 * Siembra un secreto en el canal del home temporal. Va por subproceso a proposito: secrets.mjs
 * congela CLAUDE_HOME al importarse, asi que sembrar desde este proceso escribiria en el home
 * REAL del dev.
 */
async function seedSecret(home, name, value) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.setSecret(${JSON.stringify(SDD_IDENTITY_SERVICE)}, ${JSON.stringify(
      name,
    )}, ${JSON.stringify(value)}))`;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_HOME: home, INTEGRA_SECRETS_NO_KEYRING: '1' },
    timeout: TIMEOUT_MS,
  });
}

async function seedIdentity(home) {
  await seedSecret(home, SDD_IDENTITY_TOKEN_NAME, TOKEN);
  await seedSecret(home, SDD_IDENTITY_MACHINE_NAME, MACHINE_ID);
  await seedSecret(home, SDD_IDENTITY_USER_NAME, USER_ID);
}

/** La UNICA linea JSON que el contrato promete, parseada. Falla con el output crudo si no lo es. */
function soleJson(raw, contexto) {
  const linea = raw.trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    return JSON.parse(linea);
  } catch {
    assert.fail(`${contexto}: la salida no es JSON parseable — recibido: ${JSON.stringify(raw)}`);
  }
}

/** Hub falso: login SDD + canje de sesion. Sin red real y sin TLS. */
function startFakeHub({ loginStatus = 200, loginBody } = {}) {
  const recibido = { login: [], session: [] };
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
      if (req.url.endsWith('/auth/sdd/login')) {
        recibido.login.push(body);
        return json(
          loginStatus,
          loginBody ?? {
            token: TOKEN,
            machineId: MACHINE_ID,
            machineStatus: 'ACTIVE',
            tenantId: 'tenant-1',
            tenantSlug: 'integra-piloto',
            roles: ['CC_DEV'],
          },
        );
      }
      if (req.url.endsWith('/auth/sdd/session')) {
        recibido.session.push(body);
        const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        return json(200, {
          accessToken: `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: USER_ID })}.sig`,
        });
      }
      return json(404, { message: 'ruta no esperada por el Hub falso' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        recibido,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

// ---------- (a) el password NUNCA por argv ----------

test('(a) login rechaza el password por argv con exit code de uso y mensaje que lo nombra', async () => {
  const home = tmpHome('argv');

  for (const args of [
    ['login', '--password', 'hunter2'],
    ['login', '--password=hunter2'],
    ['login', '-p', 'hunter2'],
    ['login', '--pass', 'hunter2'],
  ]) {
    const r = await identity(args, { home });
    assert.equal(r.code, 2, `${args.join(' ')} tendria que salir 2 (error de uso)`);
    const out = soleJson(r.stderr, args.join(' '));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'CREDENTIALS_BY_ARGV');
    assert.match(out.message, /history|lista de procesos/i);
    // El secreto tampoco se filtra en el eco del rechazo.
    assert.ok(!r.all.includes('hunter2'), `${args.join(' ')} eco el password en su salida`);
    assert.equal(r.stdout, '', 'los errores van por stderr: stdout queda limpio');
  }

  // Un password posicional (`login hunter2`) es el mismo intento sin flag: mismo rechazo, y el
  // mensaje NO puede eco'ar el valor — el error tambien termina en el log de quien orqueste.
  const posicional = await identity(['login', 'hunter2'], { home });
  assert.equal(posicional.code, 2);
  assert.equal(soleJson(posicional.stderr, 'login posicional').code, 'CREDENTIALS_BY_ARGV');
  assert.ok(!posicional.all.includes('hunter2'), 'el rechazo del posicional eco el valor');

  // Y en el resto de los subcomandos, un posicional tampoco se eco'a (podria ser un secreto
  // pegado en el comando equivocado).
  const otro = await identity(['status', 'hunter2'], { home });
  assert.equal(otro.code, 2);
  assert.equal(soleJson(otro.stderr, 'status posicional').code, 'UNKNOWN_ARG');
  assert.ok(!otro.all.includes('hunter2'));
});

// ---------- (b) no-fuga del token, con control positivo ----------

test('(b) status, logout y session-token sin --print-token no contienen el token en NINGUN stream', async () => {
  const home = tmpHome('nofuga');
  await seedIdentity(home);

  for (const args of [
    ['status'],
    ['status', '--tenant', 'integra-piloto'],
    ['session-token'],
    ['logout'],
  ]) {
    const r = await identity(args, { home });
    assert.ok(
      !r.all.includes(TOKEN),
      `${args.join(' ')} filtro el token en su output completo: ${JSON.stringify(r.all)}`,
    );
  }

  // Control positivo: el CLI SI puede entregar el token cuando se lo piden explicitamente.
  // Sin esto, un CLI roto que nunca devuelve nada pasaria el bloque de arriba.
  await seedIdentity(home);
  const conFlag = await identity(['session-token', '--print-token'], { home });
  assert.equal(conFlag.code, 0);
  const out = soleJson(conFlag.stdout, 'session-token --print-token');
  assert.equal(out.ok, true);
  assert.equal(out.token, TOKEN);
  assert.equal(out.machineId, MACHINE_ID);

  // Y el status jamas publica el valor: solo la presencia.
  const status = await identity(['status'], { home });
  const s = soleJson(status.stdout, 'status');
  assert.equal(s.identity.userToken, true);
  assert.equal(s.identity.machineId, MACHINE_ID);
  assert.equal(s.identity.userId, USER_ID);
  assert.equal(Object.values(s.identity).includes(TOKEN), false);
});

test('(b bis) --print-token no existe fuera de session-token', async () => {
  const home = tmpHome('flagscope');
  await seedIdentity(home);

  for (const cmd of ['status', 'logout', 'login']) {
    const r = await identity([cmd, '--print-token'], { home });
    assert.equal(r.code, 2, `${cmd} --print-token tendria que ser error de uso`);
    assert.equal(soleJson(r.stderr, cmd).code, 'PRINT_TOKEN_NOT_APPLICABLE');
    assert.ok(!r.all.includes(TOKEN));
  }
});

// ---------- (c) session-token sin flag falla con instruccion ----------

test('(c) session-token sin --print-token falla con instruccion, no con un error mudo', async () => {
  const home = tmpHome('sinflag');
  await seedIdentity(home);

  const r = await identity(['session-token'], { home });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  const out = soleJson(r.stderr, 'session-token');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PRINT_TOKEN_REQUIRED');
  assert.match(out.message, /--print-token/, 'el mensaje tiene que nombrar el flag que destraba');
});

// ---------- (d) JSON parseable y versionado en TODOS los subcomandos ----------

test('(d) todos los subcomandos emiten JSON versionado — exito por stdout, fallo por stderr', async (t) => {
  const hub = await startFakeHub();
  t.after(() => hub.close());

  const home = tmpHome('json');
  await seedIdentity(home);

  // Exitos por stdout.
  const exitos = [
    { args: ['status'], command: 'status' },
    { args: ['session-token', '--print-token'], command: 'session-token' },
    { args: ['logout'], command: 'logout' },
  ];
  for (const { args, command } of exitos) {
    const r = await identity(args, { home });
    assert.equal(r.code, 0, `${args.join(' ')} salio ${r.code}: ${r.stderr}`);
    const out = soleJson(r.stdout, args.join(' '));
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.command, command);
    assert.equal(out.ok, true);
  }

  // login contra el Hub falso: credenciales por stdin, salida versionada y SIN token.
  const login = await identity(['login', '--tenant', 'integra-piloto'], {
    home,
    stdin: 'dev@integrasoftware.biz\nun-password-que-no-viaja-por-argv\n',
    env: { SDD_LOGIN_HUB_URL: hub.url },
  });
  assert.equal(login.code, 0, `login salio ${login.code}: ${login.stderr}`);
  const loginOut = soleJson(login.stdout, 'login');
  assert.equal(loginOut.schemaVersion, 1);
  assert.equal(loginOut.command, 'login');
  assert.equal(loginOut.ok, true);
  assert.equal(loginOut.tenant, 'integra-piloto');
  assert.equal(loginOut.machineId, MACHINE_ID);
  assert.equal(loginOut.tenantSlug, 'integra-piloto');
  assert.ok(!login.all.includes(TOKEN), 'el login publico el token que acaba de guardar');
  assert.equal(hub.recibido.login.at(-1).email, 'dev@integrasoftware.biz');
  assert.equal(hub.recibido.login.at(-1).password, 'un-password-que-no-viaja-por-argv');

  // Y el material quedo en el canal, que es lo que el login tiene que dejar.
  const post = soleJson((await identity(['status'], { home })).stdout, 'status post-login');
  assert.equal(post.identity.present, true);
  assert.equal(post.identity.machineId, MACHINE_ID);

  // Fallos por stderr, tambien versionados.
  const vacio = tmpHome('json-vacio');
  const sinIdentidad = await identity(['session-token', '--print-token'], { home: vacio });
  assert.equal(sinIdentidad.code, 1);
  const err = soleJson(sinIdentidad.stderr, 'session-token sin identidad');
  assert.equal(err.schemaVersion, 1);
  assert.equal(err.command, 'session-token');
  assert.equal(err.ok, false);
  assert.equal(err.code, 'NO_IDENTITY');

  const desconocido = await identity(['pepe'], { home: vacio });
  assert.equal(desconocido.code, 2);
  assert.equal(soleJson(desconocido.stderr, 'pepe').schemaVersion, 1);

  // status es una consulta: sale 0 aunque no haya identidad, y la ausencia se lee en el JSON.
  const statusVacio = await identity(['status'], { home: vacio });
  assert.equal(statusVacio.code, 0);
  const sv = soleJson(statusVacio.stdout, 'status sin identidad');
  assert.equal(sv.identity.present, false);
  assert.deepEqual(sv.tenants, []);
});

test('(d bis) login rechazado por el Hub sale por stderr con el code del Hub y sin credenciales', async (t) => {
  const hub = await startFakeHub({
    loginStatus: 401,
    loginBody: { code: 'INVALID_CREDENTIALS', message: 'credenciales invalidas' },
  });
  t.after(() => hub.close());

  const home = tmpHome('login-401');
  const r = await identity(['login'], {
    home,
    stdin: 'dev@integrasoftware.biz\npassword-equivocado\n',
    env: { SDD_LOGIN_HUB_URL: hub.url },
  });
  assert.equal(r.code, 1, 'un login rechazado es error operativo, no de uso');
  assert.equal(r.stdout, '');
  const out = soleJson(r.stderr, 'login 401');
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_CREDENTIALS');
  assert.equal(out.statusCode, 401);
  assert.ok(!r.all.includes('password-equivocado'), 'el rechazo eco el password');
});

// ---------- (e) sdd-login.mjs directo sigue operativo ----------

test('(e) sdd-login.mjs conserva su contrato: status y login por ENV, mismo shape y exit codes', async (t) => {
  const hub = await startFakeHub();
  t.after(() => hub.close());

  const home = tmpHome('sdd-login');

  // status sin identidad: JSON de booleanos (NO el del CLI nuevo) y exit 1.
  const vacio = await run(SDD_LOGIN, ['status'], { home });
  assert.equal(vacio.code, 1);
  assert.deepEqual(soleJson(vacio.stdout, 'sdd-login status'), {
    userToken: false,
    machineId: false,
    userId: false,
  });

  // Sin subcomando: uso por stderr y exit 2.
  const uso = await run(SDD_LOGIN, [], { home });
  assert.equal(uso.code, 2);
  assert.match(uso.stderr, /uso: node sdd-login\.mjs <login\|status>/);

  // login por ENV contra el Hub falso: mismo shape de siempre, sin schemaVersion.
  const login = await run(SDD_LOGIN, ['login'], {
    home,
    env: {
      SDD_LOGIN_EMAIL: 'dev@integrasoftware.biz',
      SDD_LOGIN_PASSWORD: 'un-password',
      SDD_LOGIN_HUB_URL: hub.url,
    },
  });
  assert.equal(login.code, 0, `sdd-login login salio ${login.code}: ${login.stderr}`);
  const out = soleJson(login.stdout, 'sdd-login login');
  assert.equal(out.ok, true);
  assert.equal(out.machineId, MACHINE_ID);
  assert.equal(out.tenantSlug, 'integra-piloto');
  assert.equal(out.schemaVersion, undefined, 'el contrato viejo no gana campos del CLI nuevo');
  assert.ok(!login.all.includes(TOKEN), 'sdd-login publico el token');

  // Y despues del login, su propio status ve el material.
  const lleno = await run(SDD_LOGIN, ['status'], { home });
  assert.equal(lleno.code, 0);
  assert.deepEqual(soleJson(lleno.stdout, 'sdd-login status post'), {
    userToken: true,
    machineId: true,
    userId: true,
  });
});
