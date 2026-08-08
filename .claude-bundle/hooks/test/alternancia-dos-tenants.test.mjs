// SPEC-0187 P7 (TSK-1111) — TC-O6 client-side: dos tenants en la misma maquina, alternados.
// `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// La failure_condition literal del outcome O6: un dev que opera dos tenants desde el mismo
// equipo hacia login del segundo y el material del primero desaparecia — las tres claves del
// canal no tenian dimension tenant, asi que la segunda escritura pisaba a la primera. El
// sintoma no era un error: la sesion seguia arrancando, con la credencial del otro tenant.
//
// LO QUE ESTA SUITE FIJA
//
//   1. Login A, login B, y despues operar A / B / A — DOS alternancias consecutivas — sin
//      re-login: cada lectura devuelve la identidad de SU tenant.
//   2. Ninguna escritura del tenant B toca ninguna clave del tenant A: se compara el SET
//      COMPLETO de claves del canal antes y despues del login de B, no solo las que el test
//      espera. Una escritura de mas aparece igual.
//   3. La licencia sigue el mismo aislamiento: los accounts de (tenant, rol) son distintos para
//      el MISMO rol en dos tenants.
//   4. `migrate --tenant` sube la identidad legacy al esquema nuevo y recien despues borra la
//      vieja; y con identidad ya guardada de ESE tenant no pisa nada.
//   5. Control negativo del mecanismo: con las claves SIN dimension tenant (el esquema viejo,
//      reproducido a mano en el mismo canal) el segundo login SI pisa al primero. Sin esto, la
//      suite no demuestra que lo de arriba se deba al aislamiento.
//
// Todo corre en subproceso contra un CLAUDE_HOME temporal con INTEGRA_SECRETS_NO_KEYRING=1: el
// canal es el cipher-file del home temporal y ninguna corrida toca el keyring real del dev.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
  SDD_IDENTITY_TENANTS_NAME,
  SDD_TENANT_ENV,
  scopedName,
} from '../sdd-identity.mjs';
import { licenseAccountsFor } from '../specoe-license-check.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = path.join(HERE, '..', 'secrets.mjs');
const SDD_LOGIN = path.join(HERE, '..', '..', 'scripts', 'sdd-login.mjs');
const IDENTITY_CLI = path.join(HERE, '..', '..', 'scripts', 'specoe-identity.mjs');

const TIMEOUT_MS = 60000;

const A = {
  slug: 'alpha-corp',
  email: 'dev@alpha.test',
  token: 'isdd_' + 'a'.repeat(64),
  machineId: 'mach-alpha',
  userId: 'usr-alpha',
};
const B = {
  slug: 'beta-corp',
  email: 'dev@beta.test',
  token: 'isdd_' + 'b'.repeat(64),
  machineId: 'mach-beta',
  userId: 'usr-beta',
};

// ---------- helpers ----------

function tmpHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-0187p7-alt-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

/** Hub falso con dos usuarios, cada uno de su tenant. */
function startFakeHub(perfiles) {
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
        const p = perfiles.find((x) => x.email === body.email);
        if (!p) return json(401, { code: 'INVALID_CREDENTIALS', message: 'sin perfil' });
        return json(200, {
          token: p.token,
          machineId: p.machineId,
          machineStatus: 'ACTIVE',
          tenantId: `id-de-${p.slug}`,
          tenantSlug: p.slug,
          roles: ['CC_DEV'],
          robot: { configured: false, provisioned: false },
        });
      }
      if (req.url.endsWith('/auth/sdd/session')) {
        const p = perfiles.find((x) => x.token === body.token);
        return json(200, { accessToken: fakeJwt({ sub: p?.userId ?? 'usr-desconocido' }) });
      }
      return json(404, { message: 'ruta no esperada por el Hub falso' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

function run(script, args, { home, env = {} } = {}) {
  return execFileAsync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      CLAUDE_HOME: home,
      INTEGRA_SECRETS_NO_KEYRING: '1',
      SDD_LOGIN_EMAIL: '',
      SDD_LOGIN_PASSWORD: '',
      SDD_LOGIN_HUB_URL: '',
      [SDD_TENANT_ENV]: '',
      ...env,
    },
  })
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch((e) => ({
      code: e.code ?? 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    }));
}

function soleJson(raw, contexto) {
  const linea = raw.trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    return JSON.parse(linea);
  } catch {
    assert.fail(`${contexto}: la salida no es JSON — recibido: ${JSON.stringify(raw)}`);
  }
}

async function login(home, hubUrl, perfil) {
  const r = await run(SDD_LOGIN, ['login'], {
    home,
    env: {
      SDD_LOGIN_EMAIL: perfil.email,
      SDD_LOGIN_PASSWORD: 'un-password',
      SDD_LOGIN_HUB_URL: hubUrl,
    },
  });
  const out = soleJson(r.stdout, `login ${perfil.slug}`);
  assert.equal(out.ok, true, `login de ${perfil.slug} fallo: ${r.stdout}${r.stderr}`);
  return out;
}

/** El material que resolveria una sesion que declara `slug`, leido por el CLI de identidad. */
async function sessionToken(home, slug) {
  const r = await run(IDENTITY_CLI, ['session-token', '--print-token'], {
    home,
    env: slug ? { [SDD_TENANT_ENV]: slug } : {},
  });
  return { code: r.code, json: soleJson(r.code === 0 ? r.stdout : r.stderr, 'session-token') };
}

async function readSecret(home, name) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.getSecret(${JSON.stringify(SDD_IDENTITY_SERVICE)}, ${JSON.stringify(name)}))` +
    `.then((v) => process.stdout.write(JSON.stringify(v ?? null)))`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_HOME: home, INTEGRA_SECRETS_NO_KEYRING: '1' },
    timeout: TIMEOUT_MS,
  });
  return JSON.parse(stdout || 'null');
}

async function setSecretIn(home, name, value) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.setSecret(${JSON.stringify(SDD_IDENTITY_SERVICE)}, ${JSON.stringify(name)}, ${JSON.stringify(value)}))`;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_HOME: home, INTEGRA_SECRETS_NO_KEYRING: '1' },
    timeout: TIMEOUT_MS,
  });
}

/**
 * El SET COMPLETO de claves del canal de este home, con su valor. Es lo que permite afirmar
 * "nada de A se toco" sin enumerar de antemano lo que se espera: el cipher-file guarda un
 * archivo por (service, name), asi que el directorio ES el inventario.
 */
function snapshotCanal(home) {
  const dir = path.join(home, '.claude', 'secrets');
  const out = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return out;
}

// ---------- 1 y 2. la alternancia ----------

test('1+2. login A, login B, y A/B/A resuelven cada uno su identidad — sin pisarse', async (t) => {
  const hub = await startFakeHub([A, B]);
  t.after(() => hub.close());
  const home = tmpHome('alternancia');

  await login(home, hub.url, A);
  const trasA = snapshotCanal(home);
  const clavesDeA = Object.keys(trasA);
  assert.ok(clavesDeA.length > 0, 'el login de A no dejo nada en el canal');

  await login(home, hub.url, B);
  const trasB = snapshotCanal(home);

  // (2) Ninguna clave que existia despues de A cambio de valor con el login de B. El assert va
  // sobre el SET COMPLETO: una escritura de mas en una clave que este test no conoce aparece
  // igual, que es justo el modo de falla que hay que atrapar.
  for (const clave of clavesDeA) {
    if (clave.includes(SDD_IDENTITY_TENANTS_NAME)) continue; // el indice SI crece: es su trabajo
    assert.equal(
      trasB[clave],
      trasA[clave],
      `el login de B modifico '${clave}', que era del tenant A`,
    );
  }

  // (1) Dos alternancias consecutivas, sin re-login, resolviendo por el selector de sesion.
  for (const esperado of [A, B, A, B]) {
    const { code, json } = await sessionToken(home, esperado.slug);
    assert.equal(
      code,
      0,
      `session-token de ${esperado.slug} salio ${code}: ${JSON.stringify(json)}`,
    );
    assert.equal(json.token, esperado.token, `la sesion de ${esperado.slug} devolvio otro token`);
    assert.equal(json.machineId, esperado.machineId);
    assert.equal(json.tenant, esperado.slug);
  }

  // Y el material de cada uno esta donde tiene que estar, con el del otro intacto.
  assert.equal(await readSecret(home, scopedName(A.slug, SDD_IDENTITY_TOKEN_NAME)), A.token);
  assert.equal(await readSecret(home, scopedName(B.slug, SDD_IDENTITY_TOKEN_NAME)), B.token);
  assert.equal(await readSecret(home, scopedName(A.slug, SDD_IDENTITY_USER_NAME)), A.userId);
  assert.equal(await readSecret(home, scopedName(B.slug, SDD_IDENTITY_USER_NAME)), B.userId);
  assert.deepEqual(JSON.parse(await readSecret(home, SDD_IDENTITY_TENANTS_NAME)), [A.slug, B.slug]);
  // Y ninguna clave legacy en todo el ejercicio.
  assert.equal(await readSecret(home, SDD_IDENTITY_TOKEN_NAME), null);

  // El status del CLI declara el equipo entero: dos tenants, esquema scoped.
  const status = soleJson((await run(IDENTITY_CLI, ['status'], { home })).stdout, 'status');
  assert.equal(status.tenantScoping, 'scoped');
  assert.deepEqual(
    status.tenants.map((x) => x.slug),
    [A.slug, B.slug],
  );
});

// ---------- 3. la licencia se aisla igual ----------

test('3. el MISMO rol en dos tenants son dos accounts de licencia distintos', () => {
  const enA = licenseAccountsFor(A.slug, 'CC_DEV');
  const enB = licenseAccountsFor(B.slug, 'CC_DEV');
  assert.equal(
    enA.some((a) => enB.includes(a)),
    false,
    'los accounts de A y B se solapan',
  );
  assert.equal(enA[0], `${A.slug}:CC_DEV`);
  assert.equal(enB[0], `${B.slug}:CC_DEV`);
});

// ---------- 4. migrate ----------

test('4. migrate --tenant sube la identidad vieja y recien despues borra la legacy', async () => {
  const home = tmpHome('migrate');
  await setSecretIn(home, SDD_IDENTITY_TOKEN_NAME, A.token);
  await setSecretIn(home, SDD_IDENTITY_MACHINE_NAME, A.machineId);
  await setSecretIn(home, SDD_IDENTITY_USER_NAME, A.userId);

  const r = await run(IDENTITY_CLI, ['migrate', '--tenant', A.slug], { home });
  assert.equal(r.code, 0, `migrate salio ${r.code}: ${r.stderr}`);
  const out = soleJson(r.stdout, 'migrate');
  assert.equal(out.ok, true);
  assert.equal(out.tenant, A.slug);
  assert.deepEqual(out.migrated, [
    scopedName(A.slug, SDD_IDENTITY_TOKEN_NAME),
    scopedName(A.slug, SDD_IDENTITY_MACHINE_NAME),
    scopedName(A.slug, SDD_IDENTITY_USER_NAME),
  ]);
  assert.deepEqual(out.removedLegacy, [
    SDD_IDENTITY_TOKEN_NAME,
    SDD_IDENTITY_MACHINE_NAME,
    SDD_IDENTITY_USER_NAME,
  ]);

  // El material quedo bajo el tenant y las claves viejas no estan mas.
  assert.equal(await readSecret(home, scopedName(A.slug, SDD_IDENTITY_TOKEN_NAME)), A.token);
  assert.equal(await readSecret(home, SDD_IDENTITY_TOKEN_NAME), null);
  assert.deepEqual(JSON.parse(await readSecret(home, SDD_IDENTITY_TENANTS_NAME)), [A.slug]);

  // Y la sesion que declara ese tenant ya opera sin re-login.
  const { code, json } = await sessionToken(home, A.slug);
  assert.equal(code, 0);
  assert.equal(json.token, A.token);

  // Sin nada que migrar, el comando lo dice en vez de salir en verde.
  const vacio = await run(IDENTITY_CLI, ['migrate', '--tenant', B.slug], { home });
  assert.equal(vacio.code, 1);
  assert.equal(soleJson(vacio.stderr, 'migrate vacio').code, 'NO_LEGACY_IDENTITY');

  // Y sin --tenant es error de USO: el slug no se puede deducir de una clave que no lo lleva.
  const sinTenant = await run(IDENTITY_CLI, ['migrate'], { home });
  assert.equal(sinTenant.code, 2);
  assert.equal(soleJson(sinTenant.stderr, 'migrate sin tenant').code, 'TENANT_REQUIRED');
});

test('4 bis. migrate NO pisa una identidad ya guardada de ese tenant', async (t) => {
  const hub = await startFakeHub([B]);
  t.after(() => hub.close());
  const home = tmpHome('migrate-choque');

  // El equipo ya tiene la identidad REAL del tenant B (por login) y ademas una legacy vieja.
  await login(home, hub.url, B);
  await setSecretIn(home, SDD_IDENTITY_TOKEN_NAME, A.token);
  await setSecretIn(home, SDD_IDENTITY_MACHINE_NAME, A.machineId);

  const r = await run(IDENTITY_CLI, ['migrate', '--tenant', B.slug], { home });
  assert.equal(r.code, 1);
  assert.equal(soleJson(r.stderr, 'migrate choque').code, 'TENANT_IDENTITY_EXISTS');
  // Ni piso lo de B ni borro lo viejo: el dev decide.
  assert.equal(await readSecret(home, scopedName(B.slug, SDD_IDENTITY_TOKEN_NAME)), B.token);
  assert.equal(await readSecret(home, SDD_IDENTITY_TOKEN_NAME), A.token);
});

// ---------- 5. control negativo del mecanismo ----------

test('5. control negativo: con las claves SIN tenant, el segundo login pisa al primero', async () => {
  const home = tmpHome('control-negativo');

  // Reproduccion del esquema viejo en el MISMO canal: dos "logins" escribiendo las claves sin
  // dimension tenant. Es lo que hacia el bundle antes de esta fase.
  await setSecretIn(home, SDD_IDENTITY_TOKEN_NAME, A.token);
  await setSecretIn(home, SDD_IDENTITY_MACHINE_NAME, A.machineId);
  await setSecretIn(home, SDD_IDENTITY_TOKEN_NAME, B.token);
  await setSecretIn(home, SDD_IDENTITY_MACHINE_NAME, B.machineId);

  assert.equal(
    await readSecret(home, SDD_IDENTITY_TOKEN_NAME),
    B.token,
    'sin dimension tenant, la segunda escritura tiene que pisar a la primera — si no, el test 1 no prueba nada',
  );
  assert.notEqual(await readSecret(home, SDD_IDENTITY_TOKEN_NAME), A.token);
});
