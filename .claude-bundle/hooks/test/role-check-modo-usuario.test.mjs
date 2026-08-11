// TKT-0320 — el hook de arranque ramifica por modo de identidad. `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// `specoe-role-check.mjs` validaba SIEMPRE el contrato act-as de SPEC-0148 P5
// (INTEGRA_SDD_ROLE + INTEGRA_ACT_AS_TENANT + secreto act-as del rol en el canal). Desde
// SPEC-0157 existe el modo USER y desde SPEC-0187 P1 es el camino por defecto del
// thin-client: ahí la identidad viaja por el JWT de sesión SDD derivado del canal y act-as
// no participa. Resultado: TODA sesión de room en modo USER emitía una alarma falsa — y no
// solo por stderr, sino por `hookSpecificOutput.additionalContext`, o sea inyectada al
// agente como contexto de la sesión, que la adoptaba y se plantaba pidiendo un prerequisito
// inexistente. La remediación del aviso era además imposible de seguir: mandaba a exportar
// una variable que el launcher de ese modo NO exporta por diseño.
//
// LO QUE ESTA SUITE FIJA
//
//   1. Modo USER con identidad válida: `specoeRoleStatus: 'ok'`, stderr limpio y CERO
//      alarma en el additionalContext. Es la verificación que pide el ticket.
//   2. Control negativo: en modo scoped (sin declarar modo) y sin INTEGRA_ACT_AS_TENANT, el
//      aviso vigente se conserva palabra por palabra. El fix no afloja el otro modo.
//   3. Modo USER sin INTEGRA_SDD_ROLE: sí avisa (es el único prerequisito de entorno del
//      modo), y la remediación nombra las variables que el launcher de ESE modo exporta —
//      nunca `<TENANT_ID>`.
//   4. Modo USER sin material de identidad en el canal: avisa con la vía de login. El fix
//      no vuelve mudo al hook.
//   5. Modo USER con identidad de dos tenants y ninguno declarado: el aviso es el de
//      ambigüedad de SPEC-0187 P7, que nombra INTEGRA_SDD_TENANT — no se elige uno.
//   6. El canal no resoluble (módulo caído) NO se reporta como identidad ausente: sería la
//      misma falsa alarma entrando por otra puerta.
//
// Los E2E corren el hook en subproceso contra un CLAUDE_HOME temporal con
// INTEGRA_SECRETS_NO_KEYRING=1: ninguna corrida toca el keyring real del dev.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  REQUIRED_ROLE_ENV,
  REQUIRED_ROLE_ENV_USER_MODE,
  IDENTITY_PRESENT,
  IDENTITY_MISSING,
  IDENTITY_UNKNOWN,
  NO_IDENTITY_NOTICE,
  isUserIdentityMode,
  requiredEnvFor,
  checkRoleEnv,
  checkSddIdentity,
  evaluateSession,
} from '../specoe-role-check.mjs';
import {
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_TENANTS_NAME,
  scopedName,
} from '../sdd-identity.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLE_CHECK = path.join(HERE, '..', 'specoe-role-check.mjs');
const SECRETS = path.join(HERE, '..', 'secrets.mjs');

// Mismo criterio que las suites vecinas: acá no medimos presupuesto de arranque sino
// resolución de modo, y en Windows el arranque de node se lleva lo suyo.
const TEST_TIMEOUT_MS = 30000;

const TOKEN = 'isdd_' + 'c'.repeat(64);
const MACHINE_ID = 'mach-cuid-tkt0320';
const SLUG_A = 'alpha-corp';
const SLUG_B = 'beta-corp';

// ---------- helpers ----------

function tmpHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt0320-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** Entorno del subproceso SIN ninguna INTEGRA_* heredada: la sesión que corre esta suite
 * puede tener rol y tenant exportados, y heredarlos haría que el test mida el entorno del
 * dev en vez del escenario. */
function cleanEnv(extra = {}) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('INTEGRA_')) base[k] = v;
  }
  return { ...base, INTEGRA_SECRETS_NO_KEYRING: '1', ...extra };
}

async function seedSecret(home, service, name, value) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.setSecret(${JSON.stringify(service)}, ${JSON.stringify(name)}, ${JSON.stringify(value)}))`;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: cleanEnv({ CLAUDE_HOME: home }),
    timeout: TEST_TIMEOUT_MS,
  });
}

/** Siembra el material de identidad de uno o más tenants, con su índice — el canal no se
 * puede enumerar, así que sin índice una sesión que no declara tenant no resuelve nada. */
async function seedIdentity(home, ...slugs) {
  for (const slug of slugs) {
    await seedSecret(home, SDD_IDENTITY_SERVICE, scopedName(slug, SDD_IDENTITY_TOKEN_NAME), TOKEN);
    await seedSecret(
      home,
      SDD_IDENTITY_SERVICE,
      scopedName(slug, SDD_IDENTITY_MACHINE_NAME),
      MACHINE_ID,
    );
  }
  await seedSecret(home, SDD_IDENTITY_SERVICE, SDD_IDENTITY_TENANTS_NAME, JSON.stringify(slugs));
}

/** Corre el hook como proceso, igual que lo spawnea Claude Code. */
async function runHook({ home, env = {} }) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [ROLE_CHECK], {
    env: cleanEnv({ CLAUDE_HOME: home, ...env }),
    timeout: TEST_TIMEOUT_MS,
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const json = JSON.parse(lines[lines.length - 1]);
  return { stdout, stderr, json, context: json.hookSpecificOutput?.additionalContext ?? '' };
}

// ---------- 1. la resolución del modo (unitarios) ----------

test('isUserIdentityMode usa el mismo criterio que el MCP: trim + uppercase', () => {
  for (const raw of ['USER', 'user', ' User ', 'uSeR']) {
    assert.equal(isUserIdentityMode({ INTEGRA_SDD_IDENTITY_MODE: raw }), true, raw);
  }
  for (const raw of ['MACHINE', 'machine', '', '  ', 'USERX']) {
    assert.equal(isUserIdentityMode({ INTEGRA_SDD_IDENTITY_MODE: raw }), false, raw);
  }
  assert.equal(isUserIdentityMode({}), false);
});

test('requiredEnvFor: USER pide solo el rol; sin declarar conserva el contrato scoped', () => {
  assert.deepEqual(
    requiredEnvFor({ INTEGRA_SDD_IDENTITY_MODE: 'USER' }),
    REQUIRED_ROLE_ENV_USER_MODE,
  );
  assert.deepEqual(requiredEnvFor({}), REQUIRED_ROLE_ENV);
  assert.deepEqual(requiredEnvFor({ INTEGRA_SDD_IDENTITY_MODE: 'MACHINE' }), REQUIRED_ROLE_ENV);
  // El contrato scoped es el que era: si esta lista cambia, cambia el otro modo sin querer.
  assert.deepEqual(REQUIRED_ROLE_ENV, ['INTEGRA_SDD_ROLE', 'INTEGRA_ACT_AS_TENANT']);
  assert.deepEqual(REQUIRED_ROLE_ENV_USER_MODE, ['INTEGRA_SDD_ROLE']);
});

test('checkRoleEnv en modo USER no reporta INTEGRA_ACT_AS_TENANT como faltante', () => {
  const r = checkRoleEnv({ INTEGRA_SDD_IDENTITY_MODE: 'USER', INTEGRA_SDD_ROLE: 'CC_DEV' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.userMode, true);
  // Control negativo: el MISMO entorno sin declarar modo sí lo reporta.
  const scoped = checkRoleEnv({ INTEGRA_SDD_ROLE: 'CC_DEV' });
  assert.equal(scoped.ok, false);
  assert.deepEqual(scoped.missing, ['INTEGRA_ACT_AS_TENANT']);
});

// ---------- 2. el veredicto (unitarios con canal inyectado) ----------

test('modo USER con rol e identidad presente: ok, y el mensaje no alarma', async () => {
  const { status, message } = await evaluateSession({
    env: { INTEGRA_SDD_IDENTITY_MODE: 'USER', INTEGRA_SDD_ROLE: 'CC_DEV' },
    deps: {
      checkSddIdentity: async () => ({
        status: IDENTITY_PRESENT,
        notice: null,
        tenantSlug: SLUG_A,
        outcome: 'declarado',
      }),
    },
  });
  assert.equal(status, 'ok');
  assert.ok(!message.includes('⚠️'), message);
  assert.match(message, /CC_DEV/);
  assert.match(message, new RegExp(SLUG_A));
});

test('canal no resoluble: NO se reporta como identidad ausente (fail-open del aviso)', async () => {
  const identity = await checkSddIdentity({
    loader: async () => {
      throw new Error('modulo caido');
    },
  });
  assert.equal(identity.status, IDENTITY_UNKNOWN);
  assert.equal(identity.notice, null);

  const { status, message } = await evaluateSession({
    env: { INTEGRA_SDD_IDENTITY_MODE: 'USER', INTEGRA_SDD_ROLE: 'CC_DEV' },
    deps: { checkSddIdentity: async () => identity },
  });
  assert.equal(status, 'ok');
  assert.ok(!message.includes('⚠️'), message);
});

test('modo USER sin material: avisa con la vía de login y sin nombrar act-as como faltante', async () => {
  const { status, message } = await evaluateSession({
    env: { INTEGRA_SDD_IDENTITY_MODE: 'USER', INTEGRA_SDD_ROLE: 'CC_DEV' },
    deps: {
      checkSddIdentity: async () => ({
        status: IDENTITY_MISSING,
        notice: NO_IDENTITY_NOTICE,
        tenantSlug: null,
        outcome: 'legacy',
      }),
    },
  });
  assert.equal(status, 'no-role');
  assert.match(message, /setup\.sh --login/);
  assert.ok(!message.includes('<TENANT_ID>'), message);
  assert.ok(!message.includes('falta INTEGRA_ACT_AS_TENANT'), message);
});

test('modo scoped: el veredicto vigente se conserva, secreto del canal incluido', async () => {
  const faltaTenant = await evaluateSession({ env: { INTEGRA_SDD_ROLE: 'CC_DEV' } });
  assert.equal(faltaTenant.status, 'no-role');
  assert.match(faltaTenant.message, /SESIÓN SIN ROL SCOPED/);
  assert.match(faltaTenant.message, /faltan INTEGRA_ACT_AS_TENANT en el entorno/);

  const sinSecreto = await evaluateSession({
    env: { INTEGRA_SDD_ROLE: 'CC_DEV', INTEGRA_ACT_AS_TENANT: 'tenant-cuid' },
    deps: { checkChannelSecret: async () => false },
  });
  assert.equal(sinSecreto.status, 'no-role');
  assert.match(sinSecreto.message, /provision-secrets\.mjs act-as CC_DEV/);

  const conSecreto = await evaluateSession({
    env: { INTEGRA_SDD_ROLE: 'CC_DEV', INTEGRA_ACT_AS_TENANT: 'tenant-cuid' },
    deps: { checkChannelSecret: async () => true },
  });
  assert.equal(conSecreto.status, 'ok');
  assert.match(conSecreto.message, /secreto act-as resuelto del canal/);
});

// ---------- 3. end-to-end sobre el hook ----------

test('E2E — sesión de room en modo USER con identidad válida: ni alarma ni no-role', async () => {
  const home = tmpHome('user-ok');
  await seedIdentity(home, SLUG_A);
  const { json, stderr, context } = await runHook({
    home,
    env: {
      INTEGRA_SDD_IDENTITY_MODE: 'USER',
      INTEGRA_SDD_ROLE: 'CC_DEV',
      INTEGRA_SDD_TENANT: SLUG_A,
    },
  });
  assert.equal(json.specoeRoleStatus, 'ok');
  assert.equal(stderr.trim(), '', `el arranque sano no escribe en stderr: ${stderr}`);
  assert.ok(!context.includes('⚠️'), context);
  assert.ok(!context.includes('INTEGRA_ACT_AS_TENANT'), context);
  assert.match(context, new RegExp(SLUG_A));
});

test('E2E — control negativo: modo scoped sin INTEGRA_ACT_AS_TENANT conserva el aviso', async () => {
  const home = tmpHome('scoped-alarma');
  const { json, stderr, context } = await runHook({
    home,
    env: { INTEGRA_SDD_ROLE: 'CC_DEV' },
  });
  assert.equal(json.specoeRoleStatus, 'no-role');
  assert.match(stderr, /\[specoe-role-check\]/);
  assert.match(context, /SESIÓN SIN ROL SCOPED/);
  assert.match(context, /INTEGRA_ACT_AS_TENANT/);
  assert.match(context, /specoe-launch-thinclient\.sh <ROL> <TENANT_ID>/);
});

test('E2E — modo USER sin rol: avisa, y la remediación es la del modo USER', async () => {
  const home = tmpHome('user-sin-rol');
  await seedIdentity(home, SLUG_A);
  const { json, context } = await runHook({
    home,
    env: { INTEGRA_SDD_IDENTITY_MODE: 'USER', INTEGRA_SDD_TENANT: SLUG_A },
  });
  assert.equal(json.specoeRoleStatus, 'no-role');
  assert.match(context, /falta INTEGRA_SDD_ROLE en el entorno/);
  assert.match(context, /specoe-launch-thinclient\.sh <ROL>\)/);
  assert.match(context, /INTEGRA_SDD_TENANT/);
  // La remediación imposible del defecto: el launcher de modo USER no toma un tenant posicional.
  assert.ok(!context.includes('<TENANT_ID>'), context);
});

test('E2E — modo USER con rol y canal vacío: avisa con la vía de login', async () => {
  const home = tmpHome('user-sin-identidad');
  const { json, context } = await runHook({
    home,
    env: { INTEGRA_SDD_IDENTITY_MODE: 'USER', INTEGRA_SDD_ROLE: 'CC_DEV' },
  });
  assert.equal(json.specoeRoleStatus, 'no-role');
  assert.match(context, /no hay material de identidad SDD en el canal/);
  assert.match(context, /setup\.sh --login/);
});

test('E2E — modo USER con dos tenants y ninguno declarado: aviso de ambigüedad', async () => {
  const home = tmpHome('user-ambiguo');
  await seedIdentity(home, SLUG_A, SLUG_B);
  const { json, context } = await runHook({
    home,
    env: { INTEGRA_SDD_IDENTITY_MODE: 'USER', INTEGRA_SDD_ROLE: 'CC_DEV' },
  });
  assert.equal(json.specoeRoleStatus, 'no-role');
  assert.match(context, /identidad SDD de 2 tenants/);
  assert.match(context, /INTEGRA_SDD_TENANT/);
  assert.match(context, new RegExp(SLUG_B));
});
