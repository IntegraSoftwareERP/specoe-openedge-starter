// SPEC-0187 P7 (TSK-1110) — aislamiento multi-tenant del canal del cliente. `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// El backend ya aisla por tenant (AuthorizedMachine es unico por (tenantId, fingerprintHash));
// el canal del cliente guardaba UNA sola identidad en tres claves sin dimension tenant
// (`user-token`, `machine-id`, `user-id`) y la licencia bajo el rol pelado. Con dos tenants en
// la misma maquina, el segundo login pisaba al primero: nada fallaba en el momento — el room
// seguia arrancando — y la sesion pasaba a operar con la credencial del OTRO tenant.
//
// LO QUE ESTA SUITE FIJA
//
//   1. El login escribe SOLO claves tenant-scoped, con el slug que devuelve el HUB (no el que
//      declare el entorno), y NINGUNA clave legacy. Con el control negativo correspondiente:
//      las tres claves sin tenant siguen ausentes despues del login.
//   2. Una sesion que declara tenant lee las claves de ESE tenant.
//   3. Una sesion que declara un tenant SIN identidad de ese tenant NO cae al legacy aunque el
//      legacy exista: devuelve un aviso accionable que nombra el tenant, `login` y `migrate`.
//      Es el corazon del riesgo declarado de la fase, y va tambien end-to-end sobre el hook.
//   4. El fallback legacy sigue vivo, pero ACOTADO: sesion sin tenant declarado y canal sin
//      ninguna identidad scoped — o sea la instalacion del piloto, que no se rompe.
//   5. Sin declarar tenant y con UNA sola identidad scoped, se resuelve esa (el canal no se
//      puede enumerar: para eso esta el indice). Con DOS, no se elige ninguna: aviso.
//   6. La licencia sigue el mismo criterio: con tenant declarado, los accounts del keyring son
//      '<slug>:<ROL>' / '<slug>:default' y NINGUNO legacy.
//
// Los unitarios inyectan el canal (getSecretImpl); los E2E corren login y hook en subproceso
// contra un CLAUDE_HOME temporal con INTEGRA_SECRETS_NO_KEYRING=1: ninguna corrida toca el
// keyring real del dev.

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
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
  SDD_IDENTITY_TENANTS_NAME,
  SDD_TENANT_ENV,
  SCOPE_DECLARED,
  SCOPE_SINGLE,
  SCOPE_LEGACY,
  SCOPE_AMBIGUOUS,
  readIdentityMaterialScoped,
  resolveIdentityScope,
  resolveSessionTenant,
  scopedName,
} from '../sdd-identity.mjs';
import {
  licenseAccountsFor,
  buildTenantScopeNotice,
  STARTUP_DIAG_PREFIX,
  CAUSE_TENANT_SIN_IDENTIDAD,
} from '../specoe-license-check.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');
const SECRETS = path.join(HERE, '..', 'secrets.mjs');
const SDD_LOGIN = path.join(HERE, '..', '..', 'scripts', 'sdd-login.mjs');

// Mismo criterio que las suites vecinas: en Windows el fingerprint se lleva casi todo el
// presupuesto real con wmic, y aca no medimos presupuesto sino resolucion de claves.
const TEST_BUDGET_MS = '30000';

const TOKEN_A = 'isdd_' + 'a'.repeat(64);
const TOKEN_B = 'isdd_' + 'b'.repeat(64);
const MACHINE_A = 'mach-cuid-alpha';
const MACHINE_B = 'mach-cuid-beta';
const USER_A = 'usr-cuid-alpha';
const SLUG_A = 'alpha-corp';
const SLUG_B = 'beta-corp';

// ---------- helpers ----------

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-0187p7-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** Canal falso en memoria para los unitarios: mismo contrato que getSecret (null si no esta). */
function fakeChannel(entries = {}) {
  const map = new Map(Object.entries(entries));
  const getSecretImpl = async (service, name) => {
    assert.equal(service, SDD_IDENTITY_SERVICE);
    return map.has(name) ? map.get(name) : null;
  };
  return { map, getSecretImpl };
}

function identityEntries(slug, { token, machineId, userId }) {
  return {
    [scopedName(slug, SDD_IDENTITY_TOKEN_NAME)]: token,
    [scopedName(slug, SDD_IDENTITY_MACHINE_NAME)]: machineId,
    ...(userId ? { [scopedName(slug, SDD_IDENTITY_USER_NAME)]: userId } : {}),
  };
}

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

async function seedSecret(home, service, name, value) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.setSecret(${JSON.stringify(service)}, ${JSON.stringify(name)}, ${JSON.stringify(value)}))`;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_HOME: home, INTEGRA_SECRETS_NO_KEYRING: '1' },
    timeout: 30000,
  });
}

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

/** Hub falso: login SDD + activate/validate + canje de sesion. */
function startFakeHub({ tenants = {} } = {}) {
  const recibido = { login: [], validate: [], session: [], activate: [] };
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
        // El tenant sale del USUARIO que se autentica — como en el Hub real, donde lo resuelve
        // el server a partir de la credencial y no de nada que mande el cliente.
        const perfil = tenants[body.email];
        if (!perfil) return json(401, { code: 'INVALID_CREDENTIALS', message: 'sin perfil' });
        return json(200, {
          token: perfil.token,
          machineId: perfil.machineId,
          machineStatus: 'ACTIVE',
          tenantId: `id-de-${perfil.slug}`,
          tenantSlug: perfil.slug,
          roles: ['CC_DEV'],
          robot: { configured: false, provisioned: false },
        });
      }
      if (req.url.endsWith('/auth/sdd/session')) {
        recibido.session.push(body);
        const perfil = Object.values(tenants).find((p) => p.token === body.token);
        return json(200, { accessToken: fakeJwt({ sub: perfil?.userId ?? 'usr-desconocido' }) });
      }
      if (req.url.endsWith('/license/activate')) {
        recibido.activate.push(body);
        return json(200, { activated: true });
      }
      if (req.url.endsWith('/license/validate')) {
        recibido.validate.push(body);
        const payload = { sub: 'lic-1', tier: 'team' };
        if (body.userContext) payload.sddRole = 'CC_DEV';
        return json(200, {
          token: fakeJwt(payload),
          tenantId: 'tenant-1',
          tier: 'team',
          features: ['skills'],
        });
      }
      return json(404, { message: 'ruta no esperada por el Hub falso' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/v1`,
        recibido,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

async function runLogin({ home, hubUrl, email, password = 'un-password' }) {
  const { stdout } = await execFileAsync(process.execPath, [SDD_LOGIN, 'login'], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      CLAUDE_HOME: home,
      INTEGRA_SECRETS_NO_KEYRING: '1',
      SDD_LOGIN_EMAIL: email,
      SDD_LOGIN_PASSWORD: password,
      SDD_LOGIN_HUB_URL: hubUrl,
    },
  });
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
}

/** Corre el hook como lo spawnea Claude Code. */
async function runHook({ projectDir, home, hubUrl, env = {} }) {
  const childEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_HOME: home,
    INTEGRA_SECRETS_NO_KEYRING: '1',
    INTEGRA_HUB_URL: hubUrl,
    SPECOE_LICENSE_KEY: 'LIC-TEST-0187-P7',
    SPECOE_LICENSE_TIMEOUT_MS: TEST_BUDGET_MS,
  };
  delete childEnv.NODE_EXTRA_CA_CERTS;
  delete childEnv.CLAUDE_ENV_FILE;
  delete childEnv.SPECOE_ALLOW_DEGRADED_START;
  delete childEnv[SDD_TENANT_ENV];
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

// ---------- 1. el login escribe SOLO claves tenant-scoped ----------

test('1. el login escribe las claves del tenant que devolvio el Hub y NINGUNA legacy', async (t) => {
  const hub = await startFakeHub({
    tenants: {
      'dev@alpha.test': { slug: SLUG_A, token: TOKEN_A, machineId: MACHINE_A, userId: USER_A },
    },
  });
  t.after(() => hub.close());
  const home = tmpDir('login-scoped');

  const out = await runLogin({ home, hubUrl: hub.url, email: 'dev@alpha.test' });
  assert.equal(out.ok, true, `el login fallo: ${JSON.stringify(out)}`);
  assert.equal(out.tenantSlug, SLUG_A);

  // Lo que tiene que estar: las tres entradas bajo el slug del Hub.
  assert.equal(
    await readSecret(home, SDD_IDENTITY_SERVICE, scopedName(SLUG_A, SDD_IDENTITY_TOKEN_NAME)),
    TOKEN_A,
  );
  assert.equal(
    await readSecret(home, SDD_IDENTITY_SERVICE, scopedName(SLUG_A, SDD_IDENTITY_MACHINE_NAME)),
    MACHINE_A,
  );
  assert.equal(
    await readSecret(home, SDD_IDENTITY_SERVICE, scopedName(SLUG_A, SDD_IDENTITY_USER_NAME)),
    USER_A,
  );
  // Y el indice, que es lo que permite resolver sin declarar tenant.
  assert.deepEqual(
    JSON.parse(await readSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_TENANTS_NAME)),
    [SLUG_A],
  );

  // CONTROL NEGATIVO: ninguna clave legacy. Sin esto, un login que escribiera en los dos
  // esquemas pasaria los asserts de arriba y seguiria pisando entre tenants.
  for (const name of [SDD_IDENTITY_TOKEN_NAME, SDD_IDENTITY_MACHINE_NAME, SDD_IDENTITY_USER_NAME]) {
    assert.equal(
      await readSecret(home, SDD_IDENTITY_SERVICE, name),
      null,
      `el login escribio la clave legacy '${name}'`,
    );
  }
});

test('1 bis. sin tenantSlug en la respuesta, el login NO escribe nada y lo dice', async (t) => {
  const hub = await startFakeHub({
    tenants: {
      // Hub anterior a SPEC-0157: responde sin tenantSlug.
      'viejo@alpha.test': { slug: '', token: TOKEN_A, machineId: MACHINE_A, userId: USER_A },
    },
  });
  t.after(() => hub.close());
  const home = tmpDir('login-sin-slug');

  let salida;
  try {
    await runLogin({ home, hubUrl: hub.url, email: 'viejo@alpha.test' });
    assert.fail('el login tendria que salir 1 sin tenantSlug');
  } catch (err) {
    salida = JSON.parse(String(err.stdout).trim().split('\n').filter(Boolean).pop());
  }
  assert.equal(salida.ok, false);
  assert.equal(salida.code, 'TENANT_SLUG_MISSING');
  // Ni scoped ni legacy: a mitad de escritura no hay estado bueno.
  assert.equal(await readSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME), null);
  assert.equal(await readSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_TENANTS_NAME), null);
});

// ---------- 2 y 3. la sesion que declara tenant ----------

test('2. con tenant declarado se leen las claves de ESE tenant', async () => {
  const { getSecretImpl } = fakeChannel({
    ...identityEntries(SLUG_A, { token: TOKEN_A, machineId: MACHINE_A, userId: USER_A }),
    ...identityEntries(SLUG_B, { token: TOKEN_B, machineId: MACHINE_B }),
    [SDD_IDENTITY_TENANTS_NAME]: JSON.stringify([SLUG_A, SLUG_B]),
  });

  const a = await readIdentityMaterialScoped({ tenantSlug: SLUG_A, getSecretImpl });
  assert.equal(a.outcome, SCOPE_DECLARED);
  assert.equal(a.notice, null);
  assert.equal(a.userToken, TOKEN_A);
  assert.equal(a.machineId, MACHINE_A);
  assert.equal(a.userId, USER_A);

  const b = await readIdentityMaterialScoped({ tenantSlug: SLUG_B, getSecretImpl });
  assert.equal(b.userToken, TOKEN_B);
  assert.equal(b.machineId, MACHINE_B);
  assert.equal(b.userId, null, 'el userId de A no puede aparecer en la lectura de B');
});

test('3. tenant declarado SIN identidad de ese tenant: aviso accionable y NUNCA fallback legacy', async () => {
  // El canal tiene identidad legacy (instalacion vieja) y del tenant B. La sesion declara A.
  const { getSecretImpl } = fakeChannel({
    [SDD_IDENTITY_TOKEN_NAME]: TOKEN_B,
    [SDD_IDENTITY_MACHINE_NAME]: MACHINE_B,
    [SDD_IDENTITY_USER_NAME]: 'usr-legacy',
    ...identityEntries(SLUG_B, { token: TOKEN_B, machineId: MACHINE_B }),
    [SDD_IDENTITY_TENANTS_NAME]: JSON.stringify([SLUG_B]),
  });

  const r = await readIdentityMaterialScoped({ tenantSlug: SLUG_A, getSecretImpl });
  assert.equal(r.outcome, SCOPE_DECLARED);
  assert.equal(r.present, false);
  assert.equal(r.userToken, null, 'cayo al fallback legacy con el tenant declarado');
  assert.equal(r.machineId, null);
  assert.equal(r.userId, null);
  assert.ok(r.notice, 'tiene que haber aviso');
  assert.match(r.notice, new RegExp(SLUG_A), 'el aviso nombra el tenant');
  assert.match(r.notice, /login/);
  assert.match(r.notice, /migrate/);
});

test('3 bis. E2E: el hook con tenant declarado y solo identidad legacy avisa y no manda userContext', async (t) => {
  const hub = await startFakeHub();
  t.after(() => hub.close());
  const home = tmpDir('hook-tenant');
  const project = tmpDir('hook-tenant-proj');

  // Instalacion anterior a la fase: identidad legacy completa en el canal.
  await seedSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME, TOKEN_B);
  await seedSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME, MACHINE_B);
  await seedSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME, 'usr-legacy');
  // Y el room declara OTRO tenant en su yaml (sin env: es el caso de abrir la carpeta a mano).
  await fsp.writeFile(
    path.join(project, 'project.config.yaml'),
    `specoe:\n  role: 'CC_DEV'\n  tenant: '${SLUG_A}'\n`,
    'utf8',
  );

  const r = await runHook({ projectDir: project, home, hubUrl: hub.url });
  assert.equal(r.code, 0, `el hook no debia bloquear; stdout: ${r.stdout}`);
  assert.equal(hub.recibido.validate.length, 1);
  assert.equal(
    hub.recibido.validate[0].userContext,
    undefined,
    'mando el userContext de la identidad legacy con OTRO tenant declarado',
  );
  const contexto = r.json?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(contexto, new RegExp(`${STARTUP_DIAG_PREFIX}:${CAUSE_TENANT_SIN_IDENTIDAD}`));
  assert.match(contexto, new RegExp(SLUG_A));
  // Y no se derivo ninguna sesion con el token del tenant equivocado.
  assert.equal(hub.recibido.session.length, 0);
});

// ---------- 4 y 5. la sesion que NO declara tenant ----------

test('4. sin tenant declarado y sin identidad scoped: fallback legacy (el piloto no se rompe)', async () => {
  const { getSecretImpl } = fakeChannel({
    [SDD_IDENTITY_TOKEN_NAME]: TOKEN_A,
    [SDD_IDENTITY_MACHINE_NAME]: MACHINE_A,
    [SDD_IDENTITY_USER_NAME]: USER_A,
  });

  const r = await readIdentityMaterialScoped({ tenantSlug: null, getSecretImpl });
  assert.equal(r.outcome, SCOPE_LEGACY);
  assert.equal(r.tenantSlug, null);
  assert.equal(r.notice, null, 'la instalacion single-tenant no gana avisos nuevos');
  assert.equal(r.userToken, TOKEN_A);
  assert.equal(r.present, true);
});

test('5. sin declarar: con UNA identidad scoped se resuelve esa; con DOS no se elige ninguna', async () => {
  const unica = fakeChannel({
    ...identityEntries(SLUG_A, { token: TOKEN_A, machineId: MACHINE_A, userId: USER_A }),
    [SDD_IDENTITY_TENANTS_NAME]: JSON.stringify([SLUG_A]),
  });
  const r1 = await readIdentityMaterialScoped({
    tenantSlug: null,
    getSecretImpl: unica.getSecretImpl,
  });
  assert.equal(r1.outcome, SCOPE_SINGLE);
  assert.equal(r1.tenantSlug, SLUG_A);
  assert.equal(r1.userToken, TOKEN_A);

  const dos = fakeChannel({
    ...identityEntries(SLUG_A, { token: TOKEN_A, machineId: MACHINE_A, userId: USER_A }),
    ...identityEntries(SLUG_B, { token: TOKEN_B, machineId: MACHINE_B }),
    [SDD_IDENTITY_TENANTS_NAME]: JSON.stringify([SLUG_A, SLUG_B]),
  });
  const r2 = await readIdentityMaterialScoped({
    tenantSlug: null,
    getSecretImpl: dos.getSecretImpl,
  });
  assert.equal(r2.outcome, SCOPE_AMBIGUOUS);
  assert.equal(r2.tenantSlug, null);
  assert.equal(r2.userToken, null, 'eligio un tenant por default con dos identidades guardadas');
  assert.ok(r2.notice);
  assert.match(r2.notice, new RegExp(SLUG_A));
  assert.match(r2.notice, new RegExp(SLUG_B));
  assert.match(r2.notice, /specoe\.tenant/);
});

test('5 bis. la resolucion de scope y el selector leen la env del Step 0, no la del act-as', async () => {
  assert.equal(SDD_TENANT_ENV, 'INTEGRA_SDD_TENANT');
  assert.equal(resolveSessionTenant({ [SDD_TENANT_ENV]: `  ${SLUG_A} ` }), SLUG_A);
  assert.equal(resolveSessionTenant({ [SDD_TENANT_ENV]: '   ' }), null);
  assert.equal(resolveSessionTenant({}), null);
  // La env del contrato scoped NO participa: su valor es el Tenant.id y estas claves van por slug.
  assert.equal(resolveSessionTenant({ INTEGRA_ACT_AS_TENANT: SLUG_B }), null);

  const { getSecretImpl } = fakeChannel({});
  const scope = await resolveIdentityScope({ tenantSlug: SLUG_A, getSecretImpl });
  assert.deepEqual(scope, { tenantSlug: SLUG_A, outcome: SCOPE_DECLARED, notice: null });
});

// ---------- 6. la licencia sigue el mismo criterio ----------

test('6. con tenant declarado, los accounts de licencia son scoped y ninguno legacy', () => {
  assert.deepEqual(licenseAccountsFor(SLUG_A, 'CC_DEV'), [`${SLUG_A}:CC_DEV`, `${SLUG_A}:default`]);
  // Control: sin tenant declarado, el comportamiento vigente no cambia.
  assert.deepEqual(licenseAccountsFor(null, 'CC_DEV'), ['CC_DEV', 'default']);
  assert.deepEqual(licenseAccountsFor(null, null), ['default']);
  // Y con tenant declarado NINGUN account legacy entra en la lista.
  assert.equal(
    licenseAccountsFor(SLUG_A, 'CC_DEV').some((a) => !a.startsWith(`${SLUG_A}:`)),
    false,
  );
});

test('6 bis. el aviso de aislamiento nombra lo que falta, y calla cuando no hay motivo', () => {
  assert.equal(buildTenantScopeNotice({}), null);
  assert.equal(buildTenantScopeNotice({ scopeNotice: null, licensePresent: true }), null);

  const soloLicencia = buildTenantScopeNotice({ scopeNotice: null, licensePresent: false });
  assert.match(soloLicencia, new RegExp(`${STARTUP_DIAG_PREFIX}:${CAUSE_TENANT_SIN_IDENTIDAD}`));
  assert.match(soloLicencia, /licencia/i);

  const ambas = buildTenantScopeNotice({
    scopeNotice: `no hay identidad SDD para el tenant '${SLUG_A}'`,
    licensePresent: false,
  });
  assert.match(ambas, new RegExp(SLUG_A));
  assert.match(ambas, /licencia/i);
  assert.match(ambas, /no corta el arranque/);
});
