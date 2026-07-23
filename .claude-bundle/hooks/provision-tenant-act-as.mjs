#!/usr/bin/env node
// SPEC-0155 P2 (TSK-0793/0794/0795) — provisioning de un tenant target: robot user
// + credencial act-as por rol SDD + carga del secreto al canal LOCAL.
//
// Requiere P1 (SPEC-0155) deployado: el keying del canal ya es tenantId:rol.
// Requiere credenciales del Hub (via credentials.mjs) con rbac.act_as_credential.manage
// + user.manage + user.assign_role — las 3 bindeadas a PLATFORM_ADMIN
// (migration 20260718130000) para poder provisionar CROSS-TENANT.
//
// Uso:
//   node provision-tenant-act-as.mjs <tenantId> <ROL1,ROL2,...>
//   node provision-tenant-act-as.mjs cmtenantxxxx ENGINEERING,CC_DEV,OPERATOR

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCredentials } from './credentials.mjs';
import {
  setSecret as realSetSecret,
  getSecret as realGetSecret,
  ACT_AS_SERVICE,
  ROBOT_LOGIN_SERVICE,
} from './secrets.mjs';

export const SDD_ROLES = [
  'ENGINEERING',
  'ADVERSARIAL',
  'CC_DEV',
  'DISCOVERY',
  'TESTER',
  'OPERATOR',
];

function err(m) {
  process.stderr.write(`[ERROR] ${m}\n`);
}

/** Decodifica el claim `sub` (userId) de un JWT, sin verificar firma (mismo patron que integra-hub-auth.mjs). */
export function decodeJwtSub(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export async function login(hubUrl, email, password, fetchImpl = fetch) {
  const res = await fetchImpl(`${hubUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Hub login fallo ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!body.accessToken) throw new Error('Hub login response sin accessToken');
  return body.accessToken;
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// El password nunca se usa para login humano (el robot autentica via act-as
// headers) — random fuerte solo para satisfacer el DTO (12+, mayus/minus/digito).
function randomPassword() {
  return `Rb${crypto.randomBytes(16).toString('base64url')}9`;
}

/** Email deterministico por tenant — permite idempotencia via 409 en vez de un GET previo (findAll excluye service accounts). */
export function robotEmailFor(tenantId) {
  return `sdd-robot@${tenantId}.integra-sdd.local`;
}

/**
 * TSK-0793 — crea el robot user del tenant target si no existe. Idempotente:
 * el email es deterministico por tenant y User.email es @unique — un 409 en
 * el POST significa "ya provisionado en una corrida anterior", no un error.
 */
export async function ensureRobotUser(hubUrl, token, tenantId, ownerUserId, fetchImpl = fetch) {
  const email = robotEmailFor(tenantId);
  const res = await fetchImpl(`${hubUrl}/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      email,
      name: `SDD Robot (${tenantId})`,
      tenantId,
      roleId: 'rbac_role_sdd_discovery',
      password: randomPassword(),
      isServiceAccount: true,
      ownerUserId,
    }),
  });
  if (res.status === 409) {
    return { email, created: false };
  }
  if (!res.ok) {
    throw new Error(`POST /users fallo ${res.status}: ${await res.text()}`);
  }
  const created = await res.json();
  return { email: created.email, id: created.id, created: true };
}

/**
 * TSK-0794 — crea la credencial act-as de (tenantId, role) y captura el secreto
 * UNA vez (no se puede recuperar despues). Si ya existe (409
 * ACT_AS_CREDENTIAL_EXISTS) se reporta como tal — no aborta la corrida completa,
 * los demas roles de la lista se procesan igual.
 */
export async function createActAsCredential(hubUrl, token, tenantId, role, fetchImpl = fetch) {
  const res = await fetchImpl(`${hubUrl}/rbac/act-as-credential`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ tenantId, role }),
  });
  if (res.status === 409) {
    return { role, alreadyExists: true };
  }
  if (!res.ok) {
    throw new Error(
      `POST /rbac/act-as-credential (${role}) fallo ${res.status}: ${await res.text()}`,
    );
  }
  const body = await res.json();
  return { role, alreadyExists: false, credentialId: body.credentialId, secret: body.secret };
}

/** TSK-0795 — carga el secreto al canal LOCAL con el keying nuevo de P1 (`${tenantId}:${role}`). */
export async function loadSecretToChannel(tenantId, role, secret, setSecretImpl = realSetSecret) {
  const name = `${tenantId}:${role}`;
  const { backend } = await setSecretImpl(ACT_AS_SERVICE, name, secret);
  return { name, backend };
}

/**
 * TSK-0811 (SPEC-0155 P5, ADR-003 v4) — mintea el ServiceAccountToken del
 * robot recien creado (identidad base recuperable, sin password). Se llama
 * SOLO cuando `ensureRobotUser` creo el robot en esta corrida
 * (robot.created===true) — si ya existia, el token ya deberia estar en el
 * canal de una corrida anterior.
 */
export async function mintServiceAccountToken(hubUrl, token, userId, tenantId, fetchImpl = fetch) {
  const res = await fetchImpl(`${hubUrl}/service-account-tokens`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ userId, tenantId }),
  });
  if (!res.ok) {
    throw new Error(`POST /service-account-tokens fallo ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return { id: body.id, token: body.token };
}

/** TSK-0811 — persiste el service token del robot en el canal LOCAL, namespace DISTINTO del canal act-as (`ROBOT_LOGIN_SERVICE`, name=tenantId). */
export async function loadRobotTokenToChannel(tenantId, robotToken, setSecretImpl = realSetSecret) {
  const { backend } = await setSecretImpl(ROBOT_LOGIN_SERVICE, tenantId, robotToken);
  return { name: tenantId, backend };
}

/**
 * TSK-0811 — login como el robot de `tenantId` via el ServiceAccountToken
 * persistido en el canal local: sin password, JWT resultante con
 * tenantId=target por single-binding del robot (auth.service.ts serviceLogin).
 */
export async function loginAsTenantRobot(
  hubUrl,
  tenantId,
  getSecretImpl = realGetSecret,
  fetchImpl = fetch,
) {
  const robotToken = await getSecretImpl(ROBOT_LOGIN_SERVICE, tenantId);
  if (!robotToken) {
    throw new Error(
      `Sin service token del robot para el tenant "${tenantId}" en el canal local (${ROBOT_LOGIN_SERVICE}). Correr provision-tenant-act-as.mjs primero.`,
    );
  }
  const res = await fetchImpl(`${hubUrl}/auth/service-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: robotToken }),
  });
  if (!res.ok) {
    throw new Error(`POST /auth/service-login fallo ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.accessToken) throw new Error('service-login response sin accessToken');
  return body.accessToken;
}

/**
 * TSK-0811 — rota el service token del robot de `tenantId`: pide un token
 * nuevo a `/:id/rotate` (admin, mismo `token` de sesion humana que provisiona)
 * y recarga el canal local con el valor nuevo. El viejo queda invalidado en
 * el Hub (ServiceAccountTokenService.rotateToken, in-place).
 */
export async function rotateRobotToken(
  hubUrl,
  token,
  serviceAccountTokenId,
  tenantId,
  fetchImpl = fetch,
  setSecretImpl = realSetSecret,
) {
  const res = await fetchImpl(`${hubUrl}/service-account-tokens/${serviceAccountTokenId}/rotate`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(
      `POST /service-account-tokens/${serviceAccountTokenId}/rotate fallo ${res.status}: ${await res.text()}`,
    );
  }
  const body = await res.json();
  const { backend } = await loadRobotTokenToChannel(tenantId, body.token, setSecretImpl);
  return { id: body.id, backend };
}

async function main() {
  const [tenantId, rolesArg] = process.argv.slice(2);
  if (!tenantId || !rolesArg) {
    process.stderr.write(
      'Uso: node provision-tenant-act-as.mjs <tenantId> <ROL1,ROL2,...>\n' +
        `Roles validos: ${SDD_ROLES.join(', ')}\n`,
    );
    process.exit(1);
    return;
  }
  const roles = rolesArg
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  const invalid = roles.filter((r) => !SDD_ROLES.includes(r));
  if (invalid.length) {
    err(`roles invalidos: ${invalid.join(', ')} — validos: ${SDD_ROLES.join(', ')}`);
    process.exit(1);
    return;
  }

  const { email, password, url: hubUrl } = await getCredentials();
  const token = await login(hubUrl, email, password);
  const ownerUserId = decodeJwtSub(token);
  if (!ownerUserId) throw new Error('no se pudo derivar el userId (sub) del JWT de login');

  const robot = await ensureRobotUser(hubUrl, token, tenantId, ownerUserId);
  console.log(
    robot.created
      ? `Robot user creado: ${robot.email} (${robot.id})`
      : `Robot user ya existia: ${robot.email}`,
  );

  if (robot.created) {
    const sat = await mintServiceAccountToken(hubUrl, token, robot.id, tenantId);
    const { backend } = await loadRobotTokenToChannel(tenantId, sat.token);
    console.log(
      `OK — service token del robot (${sat.id}) cargado al canal (${backend}) bajo (${ROBOT_LOGIN_SERVICE}, ${tenantId}).`,
    );
  } else {
    err(
      `robot ya existia — si necesitas un service token nuevo, usa rotateRobotToken (no se puede recuperar el original via API).`,
    );
  }

  for (const role of roles) {
    const cred = await createActAsCredential(hubUrl, token, tenantId, role);
    if (cred.alreadyExists) {
      err(
        `credencial act-as (${tenantId}, ${role}) ya existe — el secreto no se puede recuperar via API (revelado una sola vez). Usar rotate si hace falta un valor nuevo. Salteando.`,
      );
      continue;
    }
    const { name, backend } = await loadSecretToChannel(tenantId, role, cred.secret);
    console.log(
      `OK — credencial ${cred.credentialId} (${role}) cargada al canal (${backend}) bajo (${ACT_AS_SERVICE}, ${name}).`,
    );
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch((e) => {
    err(e.message);
    process.exit(1);
  });
}
