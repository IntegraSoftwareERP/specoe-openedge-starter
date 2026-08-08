#!/usr/bin/env node
// SPEC-0157 P6 (TSK-0837) — login SDD por USUARIO del starter SPECOE.
//
// Hace el canje credenciales → material de identidad del modelo por usuario:
//   POST {hub}/auth/sdd/login { email, password, fingerprint }
//     → guarda el UserSddToken (isdd_...) y el machineId en el canal de
//       secretos (secrets.mjs: keyring del SO → cipher-file fallback), bajo la
//       convención que consume el cliente MCP dual-modo (sdd-identity.ts P2):
//         (integra-sdd-identity, <tenantSlug>:user-token)  → UserSddToken
//         (integra-sdd-identity, <tenantSlug>:machine-id)  → AuthorizedMachine.id
//     → si el login trajo token de robot (P5, display-once), lo guarda bajo
//         (integra-sdd-robot-login, <tenantId>)
//
// SPEC-0187 P7 — el login escribe SOLO claves tenant-scoped, con el `tenantSlug`
// que devuelve el Hub (nunca uno declarado por el entorno: el tenant efectivo lo
// decide el server a partir del token). Las claves legacy sin tenant NO se
// escriben mas; sobreviven como fallback de LECTURA para la instalacion que ya
// existia, hasta que `specoe-identity.mjs migrate` las re-escriba.
//
// TKT-0232 — el login deja además el userId del seat en el canal:
//         (integra-sdd-identity, user-id)      → User.id
// El Hub NO lo devuelve en el login y el UserSddToken es opaco, así que se lee
// del `sub` del JWT que emite /auth/sdd/session. Sin ese dato, el hook de
// licencia no puede mandar `userContext` al /license/validate y en USER-mode el
// JWT sale SIN el claim sddRole: el room arranca como producto. Es fail-open —
// el login NO se cae si la derivación falla (el hook la reintenta).
//
// El fingerprint es la MISMA derivación que el cliente MCP recomputa en runtime
// (mcp-server/src/sdd-identity.ts, ADR-004) — si difiere, el enrolamiento y la
// derivación de sesión no coinciden y el Hub rechaza MACHINE_FINGERPRINT_MISMATCH.
// Vive en ../hooks/sdd-identity.mjs, compartido con el hook de licencia: una
// segunda copia que se separe es exactamente ese rechazo.
//
// Credenciales SIEMPRE por ENV (nunca argv: no quedan en history ni en la
// lista de procesos). Lo invoca setup.sh / specoe-setup-host.sh.
//
// Uso:
//   SDD_LOGIN_EMAIL=... SDD_LOGIN_PASSWORD=... SDD_LOGIN_HUB_URL=... node sdd-login.mjs login
//   node sdd-login.mjs status
//
// Salida: UNA línea JSON en stdout, SIN tokens (los tokens van solo al canal).
//   login ok  → { ok:true, machineId, machineStatus, tenantId, tenantSlug, roles,
//                 userIdStored:bool, robot:{ configured, provisioned, tokenStored,
//                 seatPoolExhausted } }
//   login err → { ok:false, statusCode?, code?, message, missing? }   (exit 1)
//   status    → { userToken:bool, machineId:bool, userId:bool }
//
// El import de secrets.mjs es relativo (../hooks/): resuelve igual en el repo
// (.claude-bundle/scripts → .claude-bundle/hooks) y deployado
// (~/.claude/scripts → ~/.claude/hooks).
//
// SPEC-0187 P5 (TSK-1104) — este modulo ademas EXPORTA su motor
// (`loginWithCredentials`, `readIdentityMaterial`) para que specoe-identity.mjs lo reuse en
// vez de duplicar el canje contra el Hub. El CLI de aca NO cambia de contrato: mismos
// subcomandos, mismas credenciales por ENV, mismo JSON de stdout, mismos exit codes — el
// dispatch por argv corre SOLO si el modulo se invoca directo (mismo patron que
// secrets.mjs), asi que importarlo no ejecuta nada.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setSecret, getSecret, ROBOT_LOGIN_SERVICE } from '../hooks/secrets.mjs';
import { applyCaChannel, describeNetworkError, DEFAULT_CA_PATH } from '../hooks/ca-channel.mjs';
import {
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
  addTenantToIndex,
  collectSddFingerprint,
  deriveUserId,
  readIdentityMaterialScoped,
  scopedName,
} from '../hooks/sdd-identity.mjs';

export const DEFAULT_HUB_URL = 'https://hub.integra.local/api/v1';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Material de identidad del canal, con VALORES (no booleanos). Una sola fuente para el
 * `status` de este CLI (que solo publica presencia) y para specoe-identity.mjs (que
 * necesita el machineId y el userId para su propio contrato). El userToken sale de acá
 * pero NO se imprime en ningún camino que no lo pida explícitamente.
 */
export async function readIdentityMaterial({ tenantSlug } = {}) {
  // SPEC-0187 P7 — la resolucion de QUE claves se leen vive en sdd-identity.mjs (tenant
  // declarado > unica identidad scoped > claves legacy) y devuelve ademas el scope efectivo y
  // el aviso accionable cuando no hay nada legitimo que leer. Los tres campos historicos
  // (userToken/machineId/userId) siguen saliendo con la misma forma: el `status` de este CLI y
  // specoe-identity.mjs no cambian de contrato.
  // TKT-0232 — el userId es parte del material: sin él, el arranque no puede mandar
  // `userContext` y el room corre como producto. Un `status` que no lo mire diría "listo"
  // sobre una instalación que no sirve el rol.
  return readIdentityMaterialScoped(tenantSlug === undefined ? {} : { tenantSlug });
}

// ----- subcomandos -----

async function doStatus() {
  const m = await readIdentityMaterial();
  const userToken = m.userToken != null;
  const machineId = m.machineId != null;
  const userId = m.userId != null;
  out({ userToken, machineId, userId });
  return userToken && machineId ? 0 : 1;
}

/**
 * El canje credenciales → material de identidad, SIN tocar stdout ni el proceso: devuelve el
 * mismo objeto que este CLI imprime (`{ ok:true, ... }` / `{ ok:false, message, ... }`).
 * specoe-identity.mjs lo reusa para no duplicar ni el fingerprint ni el canal de CA — una
 * segunda copia que se separe es exactamente el MACHINE_FINGERPRINT_MISMATCH del header.
 */
export async function loginWithCredentials({ email, password, hubUrl } = {}) {
  const mail = String(email ?? '').trim();
  const pass = String(password ?? '');
  const hub = String(hubUrl ?? DEFAULT_HUB_URL)
    .trim()
    .replace(/\/+$/, '');
  if (!mail || !pass) {
    return { ok: false, message: 'faltan email y/o password' };
  }
  return doLoginWithCredentials(mail, pass, hub);
}

async function doLogin() {
  const email = (process.env.SDD_LOGIN_EMAIL ?? '').trim();
  const password = process.env.SDD_LOGIN_PASSWORD ?? '';
  const hubUrl = (process.env.SDD_LOGIN_HUB_URL ?? DEFAULT_HUB_URL).trim().replace(/\/+$/, '');
  if (!email || !password) {
    out({ ok: false, message: 'faltan SDD_LOGIN_EMAIL / SDD_LOGIN_PASSWORD en el entorno' });
    return 1;
  }
  const result = await doLoginWithCredentials(email, password, hubUrl);
  out(result);
  return result.ok ? 0 : 1;
}

async function doLoginWithCredentials(email, password, hubUrl) {
  const fingerprint = await collectSddFingerprint();

  // Canal TLS por el MISMO modulo que los hooks (ca-channel.mjs). Antes este fetch salia
  // con el trust pelado y funcionaba solo porque setup.sh le inyectaba NODE_EXTRA_CA_CERTS
  // en la linea de comando — el segundo mecanismo que SPEC-0164 elimina. Fail-open: si el
  // CA no esta, seguimos y el error de TLS se reporta abajo con su errno real.
  const ca = applyCaChannel();

  let res;
  try {
    res = await fetch(`${hubUrl}/auth/sdd/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fingerprint }),
    });
  } catch (e) {
    const net = describeNetworkError(e);
    // El path efectivo del CA va en el mensaje: cuando el TLS no valida, saber contra que
    // archivo se armo el trust es la mitad del diagnostico. setup.sh matchea el code para
    // sugerir specoe-setup-host.sh, asi que el errno tiene que seguir viajando en `message`.
    return {
      ok: false,
      message:
        `no se pudo conectar al Hub (${hubUrl}): ${net.code ?? net.cause ?? net.message}` +
        ` — canal de CA: ${ca.ok ? 'aplicado' : `NO aplicado (${ca.reason})`}` +
        ` desde ${ca.caPath ?? DEFAULT_CA_PATH}`,
    };
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    /* body no-JSON: se reporta por status */
  }

  if (!res.ok) {
    return {
      ok: false,
      statusCode: res.status,
      code: body?.code,
      message: body?.message ?? `el Hub respondió HTTP ${res.status}`,
      ...(body?.missing ? { missing: body.missing } : {}),
    };
  }

  // SPEC-0187 P7 — la dimension de las claves sale de la RESPUESTA, no del entorno: el tenant
  // efectivo lo decide el Hub a partir del token, y escribir bajo un slug que el dev declaro
  // (y que podria no ser el suyo) es como se guarda una identidad en el cajon equivocado. Se
  // valida ANTES de tocar el canal: a mitad de escritura no hay estado bueno.
  const tenantSlug = String(body.tenantSlug ?? '').trim();
  if (!tenantSlug) {
    return {
      ok: false,
      code: 'TENANT_SLUG_MISSING',
      message:
        'el Hub no devolvió tenantSlug en el login SDD: sin esa dimension no se puede guardar la identidad aislada por tenant, ' +
        'y escribir las claves sin tenant reintroduce el pisado entre tenants. Actualizá el Hub (POST /auth/sdd/login devuelve tenantSlug desde SPEC-0157).',
    };
  }
  const tokenName = scopedName(tenantSlug, SDD_IDENTITY_TOKEN_NAME);
  const machineName = scopedName(tenantSlug, SDD_IDENTITY_MACHINE_NAME);

  // Material de identidad al canal — NUNCA a stdout ni a archivos en claro, y SOLO bajo claves
  // tenant-scoped: este login no escribe ninguna clave legacy (las viejas quedan como fallback
  // de lectura hasta que `specoe-identity.mjs migrate` las re-escriba).
  await setSecret(SDD_IDENTITY_SERVICE, tokenName, body.token);
  await setSecret(SDD_IDENTITY_SERVICE, machineName, body.machineId);
  // Verificación post-escritura (patrón TKT-0200: el fallo mudo del keyring era el bug).
  const tokenBack = await getSecret(SDD_IDENTITY_SERVICE, tokenName);
  const machineBack = await getSecret(SDD_IDENTITY_SERVICE, machineName);
  if (tokenBack !== body.token || machineBack !== body.machineId) {
    return {
      ok: false,
      message: 'el canal de secretos no persistió el material (verificación post-escritura falló)',
    };
  }
  // El indice es lo que permite que una sesion sin tenant declarado sepa que hay UNA sola
  // identidad (y cual) sin adivinar: el canal no se puede enumerar.
  await addTenantToIndex(tenantSlug);

  // TKT-0232 — userId del seat al canal. El login NO lo devuelve y el UserSddToken es
  // opaco, así que se canjea el material recién guardado por un JWT de sesión y se lee su
  // `sub`. Se hace ACÁ, una vez, porque acá ya hay red, CA aplicado y fingerprint
  // computado: el hook de arranque lo lee del canal y no gasta un request por sesión.
  // Fail-open a propósito — el material principal YA está persistido y verificado, y el
  // hook re-intenta esta misma derivación cuando encuentra el canal sin userId. Cortar el
  // login acá dejaría al dev sin identidad por un dato que se puede recuperar solo.
  const derived = await deriveUserId({
    hubUrl,
    token: body.token,
    machineId: body.machineId,
    fingerprint,
  });
  let userIdStored = false;
  if (derived.userId) {
    const userName = scopedName(tenantSlug, SDD_IDENTITY_USER_NAME);
    await setSecret(SDD_IDENTITY_SERVICE, userName, derived.userId);
    userIdStored = (await getSecret(SDD_IDENTITY_SERVICE, userName)) === derived.userId;
  }

  // Robot (P5): token display-once → canal (integra-sdd-robot-login, tenantId).
  let robotTokenStored = false;
  if (body.robot?.token) {
    await setSecret(ROBOT_LOGIN_SERVICE, body.tenantId, body.robot.token);
    robotTokenStored = (await getSecret(ROBOT_LOGIN_SERVICE, body.tenantId)) === body.robot.token;
  }

  return {
    ok: true,
    machineId: body.machineId,
    machineStatus: body.machineStatus,
    tenantId: body.tenantId,
    tenantSlug,
    roles: body.roles ?? [],
    // El motivo viaja SOLO cuando no se pudo: un `userIdStored:false` mudo manda a
    // diagnosticar el arranque cuando el dato está acá.
    userIdStored,
    ...(userIdStored ? {} : { userIdReason: derived.reason ?? 'no se pudo persistir en el canal' }),
    robot: {
      configured: body.robot?.configured ?? false,
      provisioned: body.robot?.provisioned ?? false,
      tokenStored: robotTokenStored,
      ...(body.robot?.seatPoolExhausted ? { seatPoolExhausted: true } : {}),
    },
  };
}

// ----- CLI -----
// El dispatch corre SOLO si el modulo se invoca directo: specoe-identity.mjs lo importa por
// su motor y un import que ejecutara el CLI le comeria el argv y el exit code (SPEC-0187 P5).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const cmd = process.argv[2];
  let rc = 2;
  if (cmd === 'login') rc = await doLogin();
  else if (cmd === 'status') rc = await doStatus();
  else {
    process.stderr.write(
      'uso: node sdd-login.mjs <login|status>  (credenciales por ENV, ver header)\n',
    );
  }
  process.exit(rc);
}
