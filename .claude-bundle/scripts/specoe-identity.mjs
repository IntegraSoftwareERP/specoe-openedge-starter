#!/usr/bin/env node
// SPEC-0187 P5 (TSK-1104) — canal de identidad SDD invocable: el entrypoint estable del
// keyring del SO para consumidores externos (ADR-003).
//
// POR QUE EXISTE
//
// La identidad SDD ya vive en el canal de secretos del bundle (secrets.mjs: keyring del SO
// con fallback cifrado), pero solo se podia tocar desde adentro del bundle: cada consumidor
// nuevo tenia que importar modulos internos o repetir el canje. El plugin VSCode (P6) queda
// afuera de eso — corre en otro proceso y en otro repo — asi que hoy mantiene su PROPIO
// almacen y la misma persona se autentica dos veces contra el mismo Hub (O4).
//
// Este CLI publica ese canal con un contrato estable e invocable por child_process: JSON
// versionado por stdout, errores por stderr, exit codes documentados. El keyring del SO
// queda como almacen canonico UNICO; el plugin lo consume, no lo duplica.
//
// SUBCOMANDOS
//
//   status          presencia y datos NO secretos de la identidad (usuario, machineId,
//                   tenants con identidad). NUNCA imprime el token.
//   login           captura credenciales por stdin/prompt y delega en sdd-login.mjs
//                   (mismo fingerprint, mismo canal de CA, misma escritura al canal).
//                   El password NUNCA se acepta por argv: en la linea de comando queda en
//                   el history del shell y en la lista de procesos de la maquina.
//   logout          borra el material de identidad de este equipo (los 3 secretos de
//                   integra-sdd-identity) en ambos backends del canal.
//   session-token   material para canjear un JWT de sesion contra POST /auth/sdd/session.
//                   Imprime el token SOLO con --print-token explicito: un token impreso por
//                   default termina en los logs de quien orqueste el CLI.
//   migrate         re-escribe la identidad legacy (claves sin tenant) al esquema por tenant.
//                   Exige --tenant: el slug no se puede adivinar de una clave que no lo tiene.
//
// FLAGS
//
//   --tenant <slug>  el tenant sobre el que opera el comando. Desde P7 NO es pass-through:
//                    selecciona que claves se leen ('<slug>:user-token', ...) y es obligatorio
//                    en migrate. Sin el flag, cada comando cae a la resolucion por defecto del
//                    canal (INTEGRA_SDD_TENANT > unica identidad guardada > claves legacy).
//   --print-token    solo valido en session-token. En cualquier otro subcomando es error de
//                    uso — la unica via de imprimir el token es pedirlo en el subcomando
//                    que lo tiene por objeto.
//
// POR QUE migrate BORRA LAS CLAVES VIEJAS RECIEN AL FINAL
//
// El borrado es lo unico irreversible del comando (el UserSddToken es opaco y no se puede
// re-derivar sin re-login), asi que ocurre SOLO despues de leer de vuelta las tres claves
// nuevas y comprobar que tienen el mismo valor — el patron de verificacion post-escritura de
// TKT-0200, donde el fallo mudo del keyring era el bug. Si la verificacion no da, no se borra
// nada y el comando sale con `ok:false`: la identidad vieja sigue ahi y el dev puede reintentar.
//
// CONTRATO DE SALIDA (schemaVersion 1)
//
// TODA invocacion emite exactamente UN objeto JSON con `schemaVersion: 1` y `command`:
// exito por stdout, fallo por stderr (con `ok:false` + `code` estable). Un consumidor
// parsea siempre, gane o pierda, y decide por `ok` — no por el texto.
//
//   status         → { schemaVersion, command, ok, tenant, tenantScoping, identity:{...},
//                      tenants:[...] }
//   login          → { schemaVersion, command, ok, machineId, machineStatus, tenantId,
//                      tenantSlug, roles, userIdStored, robot:{...} }   (SIN token)
//   logout         → { schemaVersion, command, ok, removed:[...] }
//   session-token  → { schemaVersion, command, ok, token, machineId, fingerprint, tenant }
//   migrate        → { schemaVersion, command, ok, tenant, migrated:[...], removedLegacy:[...] }
//
// EXIT CODES
//
//   0  el subcomando hizo lo suyo. `status` sale 0 aunque no haya identidad: pudo leer el
//      canal y la ausencia se lee en `identity.present` (es una consulta, no un chequeo).
//   1  error operativo: no hay identidad, el Hub rechazo el login, el canal fallo.
//   2  error de uso: subcomando desconocido, flag invalido, credenciales por argv,
//      session-token sin --print-token.
//
// HUB
//
// La URL del Hub para el login sale de SDD_LOGIN_HUB_URL (o INTEGRA_HUB_API_URL) y cae al
// default del bundle. No hay flag: una URL por argv es la clase de dato que se copia mal
// una vez y queda mal para siempre en el history.
//
// Los imports son relativos (../hooks/, ./sdd-login.mjs): resuelven igual en el repo
// (.claude-bundle/scripts → .claude-bundle/hooks) y deployado (~/.claude/scripts →
// ~/.claude/hooks).

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { deleteSecret, getSecret, setSecret } from '../hooks/secrets.mjs';
import {
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
  addTenantToIndex,
  collectSddFingerprint,
  readTenantIndex,
  removeTenantFromIndex,
  scopedName,
} from '../hooks/sdd-identity.mjs';
import { loginWithCredentials, readIdentityMaterial, DEFAULT_HUB_URL } from './sdd-login.mjs';

export const SCHEMA_VERSION = 1;

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const COMMANDS = ['status', 'login', 'logout', 'session-token', 'migrate'];

const USAGE =
  'uso: node specoe-identity.mjs <status|login|logout|session-token|migrate> [--tenant <slug>] [--print-token]\n' +
  '     credenciales SOLO por stdin/prompt (nunca por argv); el token se imprime SOLO con session-token --print-token\n';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(obj) {
  process.stderr.write(JSON.stringify(obj) + '\n');
}

/** Error de uso con `code` estable: el consumidor discrimina sin leer el texto. */
class UsageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ----- argv -----

/**
 * Parsea argv con allowlist estricta. Cualquier cosa que no sea un flag conocido es error
 * de uso — es lo que atrapa `login <password>` posicional, que es justo la fuga que la
 * fase viene a cerrar.
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError('COMMAND_REQUIRED', `falta el subcomando.\n${USAGE}`);
  if (!COMMANDS.includes(command)) {
    throw new UsageError('UNKNOWN_COMMAND', `subcomando desconocido: ${command}.\n${USAGE}`);
  }

  let tenant = null;
  let printToken = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    // Password por argv: se rechaza ANTES que cualquier otra cosa y con su propio code. En
    // la linea de comando el secreto queda en el history del shell y visible en la lista de
    // procesos para cualquier usuario de la maquina — no hay forma seguida de aceptarlo.
    if (/^--?(password|pass|pwd|p|secret|token)(=|$)/i.test(arg)) {
      throw new UsageError(
        'CREDENTIALS_BY_ARGV',
        `las credenciales NO se pasan por argumento (${arg.split('=')[0]}): quedan en el history del shell y en la lista de procesos. ` +
          'Pasalas por stdin (email y password, una por linea) o dejá que el prompt las pida.',
      );
    }
    if (arg === '--tenant' || arg.startsWith('--tenant=')) {
      const value = arg.startsWith('--tenant=') ? arg.slice('--tenant='.length) : rest[++i];
      if (!value) throw new UsageError('TENANT_VALUE_REQUIRED', '--tenant necesita un slug.');
      tenant = value;
      continue;
    }
    if (arg === '--print-token') {
      printToken = true;
      continue;
    }
    // Un valor suelto (sin guion) en login es un intento de password posicional: mismo rechazo
    // que el flag, y sin eco — el mensaje de error tambien se loguea, asi que repetir el valor
    // seria filtrarlo por la puerta de al lado.
    if (!arg.startsWith('-')) {
      if (command === 'login') {
        throw new UsageError(
          'CREDENTIALS_BY_ARGV',
          'las credenciales NO se pasan por argumento: quedan en el history del shell y en la lista de procesos. ' +
            'Pasalas por stdin (email y password, una por linea) o dejá que el prompt las pida.',
        );
      }
      throw new UsageError(
        'UNKNOWN_ARG',
        `argumento posicional no reconocido en ${command} (valor omitido a proposito).\n${USAGE}`,
      );
    }
    throw new UsageError('UNKNOWN_ARG', `argumento no reconocido: ${arg.split('=')[0]}.\n${USAGE}`);
  }

  if (printToken && command !== 'session-token') {
    throw new UsageError(
      'PRINT_TOKEN_NOT_APPLICABLE',
      `--print-token solo aplica a session-token (recibido en ${command}).`,
    );
  }

  return { command, tenant, printToken };
}

// ----- credenciales -----

/** Prompt por stderr (stdout es SOLO el JSON del contrato), con eco apagado en el password. */
function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    if (hidden) {
      rl._writeToOutput = (chunk) => {
        // Deja pasar el texto de la pregunta; traga lo que el usuario tipea.
        if (chunk.includes(question)) process.stderr.write(chunk);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Credenciales por stdin (email y password, una por linea — el camino de los orquestadores)
 * o por prompt interactivo. Nunca por argv, nunca por env: el env se hereda a los hijos y
 * es exactamente como se filtra un password a un proceso que no lo necesitaba.
 */
async function readCredentials() {
  if (!process.stdin.isTTY) {
    const raw = await readAllStdin();
    const [email = '', password = ''] = raw.split(/\r?\n/);
    return { email: email.trim(), password };
  }
  const email = await prompt('email: ');
  const password = await prompt('password: ', { hidden: true });
  return { email, password };
}

// ----- subcomandos -----

async function cmdStatus({ tenant }) {
  // La identidad que ESTA invocacion resolveria: con --tenant, la de ese tenant; sin el, lo que
  // decida el canal (env del selector > unica identidad scoped > claves legacy).
  const material = await readIdentityMaterial(tenant ? { tenantSlug: tenant } : {});
  const { userToken, machineId, userId } = material;
  const present = userToken != null && machineId != null;

  // El inventario COMPLETO del equipo, que es otra pregunta: cuantos tenants tienen identidad
  // guardada aca. Sale del indice (el canal no se puede enumerar) mas la identidad legacy si
  // todavia existe — es lo que le dice al consumidor si hay algo para migrar.
  const slugs = await readTenantIndex();
  const tenants = [];
  for (const slug of slugs) {
    const [t, m, u] = await Promise.all([
      getSecret(SDD_IDENTITY_SERVICE, scopedName(slug, SDD_IDENTITY_TOKEN_NAME)),
      getSecret(SDD_IDENTITY_SERVICE, scopedName(slug, SDD_IDENTITY_MACHINE_NAME)),
      getSecret(SDD_IDENTITY_SERVICE, scopedName(slug, SDD_IDENTITY_USER_NAME)),
    ]);
    tenants.push({
      slug,
      scoped: true,
      userToken: t != null,
      machineId: m != null,
      userId: u != null,
    });
  }
  const legacy = await readLegacyMaterial();
  if (legacy.userToken != null || legacy.machineId != null || legacy.userId != null) {
    tenants.push({
      slug: null,
      scoped: false,
      userToken: legacy.userToken != null,
      machineId: legacy.machineId != null,
      userId: legacy.userId != null,
    });
  }

  emit({
    schemaVersion: SCHEMA_VERSION,
    command: 'status',
    ok: true,
    tenant,
    // SPEC-0187 P7 — el canal ya guarda identidad por tenant. Queda 'legacy' mientras lo unico
    // que hay en este equipo sea la identidad sin dimension tenant: asi el consumidor sabe que
    // `slug: null` no es un bug, y que ahi hay algo para `migrate`.
    tenantScoping: slugs.length > 0 ? 'scoped' : 'legacy',
    identity: {
      present,
      userId: userId ?? null,
      machineId: machineId ?? null,
      // Presencia, NO el valor: el token sale unicamente por session-token --print-token.
      userToken: userToken != null,
      // De QUE tenant es la identidad que se resolvio, y por que criterio. Sin esto, un
      // consumidor no puede distinguir "la del tenant que pedi" de "la unica que habia".
      tenant: material.tenantSlug ?? null,
      scope: material.outcome,
      ...(material.notice ? { notice: material.notice } : {}),
    },
    tenants,
  });
  return EXIT_OK;
}

async function cmdLogin({ tenant }) {
  const { email, password } = await readCredentials();
  if (!email || !password) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'login',
      ok: false,
      code: 'CREDENTIALS_MISSING',
      message:
        'faltan credenciales: pasá email y password por stdin (una por linea) o corré el comando en una terminal para que las pida.',
    });
    return EXIT_ERROR;
  }

  const hubUrl = (
    process.env.SDD_LOGIN_HUB_URL ??
    process.env.INTEGRA_HUB_API_URL ??
    DEFAULT_HUB_URL
  ).trim();
  const result = await loginWithCredentials({ email, password, hubUrl });

  if (!result.ok) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'login',
      ok: false,
      code: result.code ?? 'LOGIN_REJECTED',
      ...(result.statusCode ? { statusCode: result.statusCode } : {}),
      message: result.message,
      ...(result.missing ? { missing: result.missing } : {}),
    });
    return EXIT_ERROR;
  }

  // El resultado de sdd-login.mjs no trae token — el material va al canal, no al stdout.
  // SPEC-0187 P7 — el tenant efectivo lo decide el Hub a partir de la credencial, no el flag: si
  // el consumidor pidio uno y se autentico con el usuario de otro, el login ES valido (y quedo
  // guardado bajo el tenant real), pero el JSON lo declara para que nadie lo lea como el pedido.
  const tenantMismatch =
    tenant && result.tenantSlug && tenant !== result.tenantSlug
      ? { requested: tenant, actual: result.tenantSlug }
      : null;
  emit({
    schemaVersion: SCHEMA_VERSION,
    command: 'login',
    tenant,
    ...result,
    ...(tenantMismatch ? { tenantMismatch } : {}),
  });
  return EXIT_OK;
}

/** Las tres entradas SIN dimension tenant (la instalacion anterior a P7). */
async function readLegacyMaterial() {
  const [userToken, machineId, userId] = await Promise.all([
    getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME),
    getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME),
    getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME),
  ]);
  return { userToken, machineId, userId };
}

const IDENTITY_ENTRIES = [
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
];

async function cmdLogout({ tenant }) {
  // Con --tenant se borra SOLO la identidad de ese tenant: en un equipo multi-tenant, un logout
  // que se lleve todo es una perdida de identidad que el dev no pidio. Sin el flag se borran las
  // claves legacy, que es el comportamiento que este comando tenia.
  const removed = [];
  for (const name of IDENTITY_ENTRIES) {
    const account = scopedName(tenant, name);
    if (await deleteSecret(SDD_IDENTITY_SERVICE, account)) removed.push(account);
  }
  if (tenant) await removeTenantFromIndex(tenant);
  emit({
    schemaVersion: SCHEMA_VERSION,
    command: 'logout',
    ok: true,
    tenant,
    service: SDD_IDENTITY_SERVICE,
    removed,
  });
  return EXIT_OK;
}

async function cmdMigrate({ tenant }) {
  if (!tenant) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'migrate',
      ok: false,
      code: 'TENANT_REQUIRED',
      message:
        'migrate necesita --tenant <slug>: las claves viejas no llevan el tenant adentro, asi que el slug no se puede deducir de ellas. ' +
        'Es el mismo slug que devuelve el login (`tenantSlug`) y el que declara specoe.tenant en el project.config.yaml del room.',
    });
    return EXIT_USAGE;
  }

  const legacy = await readLegacyMaterial();
  if (legacy.userToken == null || legacy.machineId == null) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'migrate',
      ok: false,
      code: 'NO_LEGACY_IDENTITY',
      message:
        'no hay identidad sin tenant que migrar en este equipo (faltan las claves user-token y/o machine-id sin prefijo). ' +
        'Si lo que falta es la identidad de este tenant, el comando es `login --tenant ' +
        tenant +
        '`.',
    });
    return EXIT_ERROR;
  }

  // No pisar: si ya hay identidad de ese tenant y es OTRA, migrar seria reemplazar una
  // credencial buena por otra sin que nadie lo pida. Idempotente cuando es la misma.
  const yaEsta = await getSecret(SDD_IDENTITY_SERVICE, scopedName(tenant, SDD_IDENTITY_TOKEN_NAME));
  if (yaEsta != null && yaEsta !== legacy.userToken) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'migrate',
      ok: false,
      code: 'TENANT_IDENTITY_EXISTS',
      message:
        `ya hay identidad guardada para el tenant '${tenant}' y es distinta de la identidad sin tenant de este equipo. ` +
        'No la piso: si la que vale es la vieja, borrá la del tenant con `logout --tenant ' +
        tenant +
        '` y volvé a migrar; si la que vale es la del tenant, la vieja se saca con `logout`.',
    });
    return EXIT_ERROR;
  }

  const migrated = [];
  for (const name of IDENTITY_ENTRIES) {
    const value =
      legacy[
        name === SDD_IDENTITY_TOKEN_NAME
          ? 'userToken'
          : name === SDD_IDENTITY_MACHINE_NAME
            ? 'machineId'
            : 'userId'
      ];
    if (value == null) continue;
    await setSecret(SDD_IDENTITY_SERVICE, scopedName(tenant, name), value);
    migrated.push(scopedName(tenant, name));
  }
  await addTenantToIndex(tenant);

  // Verificacion post-escritura ANTES de borrar: el borrado es lo unico irreversible del
  // comando (el UserSddToken es opaco y no se re-deriva sin re-login).
  const copiadoOk = (
    await Promise.all(
      IDENTITY_ENTRIES.map(async (name) => {
        const original =
          name === SDD_IDENTITY_TOKEN_NAME
            ? legacy.userToken
            : name === SDD_IDENTITY_MACHINE_NAME
              ? legacy.machineId
              : legacy.userId;
        if (original == null) return true;
        return (await getSecret(SDD_IDENTITY_SERVICE, scopedName(tenant, name))) === original;
      }),
    )
  ).every(Boolean);

  if (!copiadoOk) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'migrate',
      ok: false,
      code: 'MIGRATION_NOT_PERSISTED',
      message:
        'el canal no persistio alguna de las claves nuevas (verificacion post-escritura fallo). NO se borro nada: la identidad vieja sigue disponible, reintentá el comando.',
      migrated,
    });
    return EXIT_ERROR;
  }

  const removedLegacy = [];
  for (const name of IDENTITY_ENTRIES) {
    if (await deleteSecret(SDD_IDENTITY_SERVICE, name)) removedLegacy.push(name);
  }

  emit({
    schemaVersion: SCHEMA_VERSION,
    command: 'migrate',
    ok: true,
    tenant,
    service: SDD_IDENTITY_SERVICE,
    migrated,
    removedLegacy,
  });
  return EXIT_OK;
}

async function cmdSessionToken({ tenant, printToken }) {
  if (!printToken) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'session-token',
      ok: false,
      code: 'PRINT_TOKEN_REQUIRED',
      message:
        'session-token no imprime el token sin el flag explicito: volvé a correrlo con --print-token si de verdad querés el valor por stdout (queda en el log de quien te ejecute).',
    });
    return EXIT_USAGE;
  }

  const material = await readIdentityMaterial(tenant ? { tenantSlug: tenant } : {});
  const { userToken, machineId } = material;
  if (userToken == null || machineId == null) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: 'session-token',
      ok: false,
      code: 'NO_IDENTITY',
      // Con tenant declarado el motivo es OTRO —hay identidad, pero no la de ese tenant— y el
      // consumidor necesita esa distincion para saber si mandar a `login` o a `migrate`.
      message:
        material.notice ??
        'no hay identidad SDD en el canal de esta maquina: corré `specoe-identity.mjs login` primero.',
    });
    return EXIT_ERROR;
  }

  // El fingerprint viaja con el token porque el canje contra POST /auth/sdd/session lo exige
  // y tiene que ser EL MISMO del enrolamiento: una segunda derivacion del lado del
  // consumidor es un MACHINE_FINGERPRINT_MISMATCH esperando a pasar. No es secreto.
  const fingerprint = await collectSddFingerprint();
  emit({
    schemaVersion: SCHEMA_VERSION,
    command: 'session-token',
    ok: true,
    // El tenant efectivo del material entregado, que puede no ser el pedido cuando no se
    // declara ninguno (ahi lo resuelve el canal). El consumidor canjea con ESTE.
    tenant: material.tenantSlug ?? tenant,
    token: userToken,
    machineId,
    fingerprint,
  });
  return EXIT_OK;
}

// ----- CLI -----

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: argv[0] ?? null,
      ok: false,
      code: err.code,
      message: err.message,
    });
    return EXIT_USAGE;
  }

  try {
    if (parsed.command === 'status') return await cmdStatus(parsed);
    if (parsed.command === 'login') return await cmdLogin(parsed);
    if (parsed.command === 'logout') return await cmdLogout(parsed);
    if (parsed.command === 'migrate') return await cmdMigrate(parsed);
    return await cmdSessionToken(parsed);
  } catch (err) {
    fail({
      schemaVersion: SCHEMA_VERSION,
      command: parsed.command,
      ok: false,
      code: 'CHANNEL_ERROR',
      message: `el canal de identidad fallo: ${err?.message ?? String(err)}`,
    });
    return EXIT_ERROR;
  }
}

// Igual que secrets.mjs y sdd-login.mjs: el dispatch corre SOLO si el modulo se invoca
// directo, asi la suite puede importar parseArgs sin que el proceso se cierre solo.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
