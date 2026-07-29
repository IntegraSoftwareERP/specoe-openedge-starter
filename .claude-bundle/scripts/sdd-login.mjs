#!/usr/bin/env node
// SPEC-0157 P6 (TSK-0837) — login SDD por USUARIO del starter SPECOE.
//
// Hace el canje credenciales → material de identidad del modelo por usuario:
//   POST {hub}/auth/sdd/login { email, password, fingerprint }
//     → guarda el UserSddToken (isdd_...) y el machineId en el canal de
//       secretos (secrets.mjs: keyring del SO → cipher-file fallback), bajo la
//       convención que consume el cliente MCP dual-modo (sdd-identity.ts P2):
//         (integra-sdd-identity, user-token)  → UserSddToken
//         (integra-sdd-identity, machine-id)  → AuthorizedMachine.id
//     → si el login trajo token de robot (P5, display-once), lo guarda bajo
//         (integra-sdd-robot-login, <tenantId>)
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

import { setSecret, getSecret, ROBOT_LOGIN_SERVICE } from '../hooks/secrets.mjs';
import { applyCaChannel, describeNetworkError, DEFAULT_CA_PATH } from '../hooks/ca-channel.mjs';
import {
  SDD_IDENTITY_SERVICE,
  SDD_IDENTITY_TOKEN_NAME,
  SDD_IDENTITY_MACHINE_NAME,
  SDD_IDENTITY_USER_NAME,
  collectSddFingerprint,
  deriveUserId,
} from '../hooks/sdd-identity.mjs';

const DEFAULT_HUB_URL = 'https://hub.integra.local/api/v1';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ----- subcomandos -----

async function doStatus() {
  const userToken = (await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME)) != null;
  const machineId = (await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME)) != null;
  // TKT-0232 — el userId es parte del material: sin él, el arranque no puede mandar
  // `userContext` y el room corre como producto. Un `status` que no lo mire diría "listo"
  // sobre una instalación que no sirve el rol.
  const userId = (await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME)) != null;
  out({ userToken, machineId, userId });
  return userToken && machineId ? 0 : 1;
}

async function doLogin() {
  const email = (process.env.SDD_LOGIN_EMAIL ?? '').trim();
  const password = process.env.SDD_LOGIN_PASSWORD ?? '';
  const hubUrl = (process.env.SDD_LOGIN_HUB_URL ?? DEFAULT_HUB_URL).trim().replace(/\/+$/, '');
  if (!email || !password) {
    out({ ok: false, message: 'faltan SDD_LOGIN_EMAIL / SDD_LOGIN_PASSWORD en el entorno' });
    return 1;
  }

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
    out({
      ok: false,
      message:
        `no se pudo conectar al Hub (${hubUrl}): ${net.code ?? net.cause ?? net.message}` +
        ` — canal de CA: ${ca.ok ? 'aplicado' : `NO aplicado (${ca.reason})`}` +
        ` desde ${ca.caPath ?? DEFAULT_CA_PATH}`,
    });
    return 1;
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    /* body no-JSON: se reporta por status */
  }

  if (!res.ok) {
    out({
      ok: false,
      statusCode: res.status,
      code: body?.code,
      message: body?.message ?? `el Hub respondió HTTP ${res.status}`,
      ...(body?.missing ? { missing: body.missing } : {}),
    });
    return 1;
  }

  // Material de identidad al canal — NUNCA a stdout ni a archivos en claro.
  await setSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME, body.token);
  await setSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME, body.machineId);
  // Verificación post-escritura (patrón TKT-0200: el fallo mudo del keyring era el bug).
  const tokenBack = await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME);
  const machineBack = await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME);
  if (tokenBack !== body.token || machineBack !== body.machineId) {
    out({
      ok: false,
      message: 'el canal de secretos no persistió el material (verificación post-escritura falló)',
    });
    return 1;
  }

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
    await setSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME, derived.userId);
    userIdStored =
      (await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME)) === derived.userId;
  }

  // Robot (P5): token display-once → canal (integra-sdd-robot-login, tenantId).
  let robotTokenStored = false;
  if (body.robot?.token) {
    await setSecret(ROBOT_LOGIN_SERVICE, body.tenantId, body.robot.token);
    robotTokenStored = (await getSecret(ROBOT_LOGIN_SERVICE, body.tenantId)) === body.robot.token;
  }

  out({
    ok: true,
    machineId: body.machineId,
    machineStatus: body.machineStatus,
    tenantId: body.tenantId,
    tenantSlug: body.tenantSlug,
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
  });
  return 0;
}

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
