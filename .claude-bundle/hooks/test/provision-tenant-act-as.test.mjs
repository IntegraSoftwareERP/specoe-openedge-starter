import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SDD_ROLES,
  decodeJwtSub,
  login,
  robotEmailFor,
  ensureRobotUser,
  createActAsCredential,
  loadSecretToChannel,
  mintServiceAccountToken,
  loadRobotTokenToChannel,
  loginAsTenantRobot,
  rotateRobotToken,
} from '../provision-tenant-act-as.mjs';
import { ROBOT_LOGIN_SERVICE } from '../secrets.mjs';

const TENANT = 'cmtenanttargetaaaaaaaaaa';
const HUB_URL = 'https://hub.test/api/v1';

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('SDD_ROLES matches el contrato canonico de act-as.service.ts', () => {
  assert.deepEqual(SDD_ROLES, [
    'ENGINEERING',
    'ADVERSARIAL',
    'CC_DEV',
    'DISCOVERY',
    'TESTER',
    'OPERATOR',
  ]);
});

test('decodeJwtSub extrae el claim sub sin verificar firma', () => {
  const jwt = fakeJwt({ sub: 'cmuserxxxxxxxxxxxxxxxxxx', tenantId: TENANT });
  assert.equal(decodeJwtSub(jwt), 'cmuserxxxxxxxxxxxxxxxxxx');
});

test('decodeJwtSub retorna null ante un JWT invalido', () => {
  assert.equal(decodeJwtSub('no-es-un-jwt'), null);
});

test('login postea a /auth/login y devuelve accessToken', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return jsonResponse(200, { accessToken: 'token-abc' });
  };
  const token = await login(HUB_URL, 'op@integra.com', 'secret', fetchImpl);
  assert.equal(token, 'token-abc');
  assert.deepEqual(calls, [
    [`${HUB_URL}/auth/login`, { email: 'op@integra.com', password: 'secret' }],
  ]);
});

test('login lanza si el Hub responde sin accessToken', async () => {
  const fetchImpl = async () => jsonResponse(200, {});
  await assert.rejects(() => login(HUB_URL, 'a@a.com', 'x', fetchImpl), /sin accessToken/);
});

test('robotEmailFor es deterministico por tenant', () => {
  assert.equal(robotEmailFor(TENANT), `sdd-robot@${TENANT}.integra-sdd.local`);
});

// TSK-0793
test('ensureRobotUser envia el DTO esperado a POST /users', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method, JSON.parse(init.body), init.headers.Authorization]);
    return jsonResponse(201, { id: 'robot-1', email: robotEmailFor(TENANT) });
  };
  const result = await ensureRobotUser(HUB_URL, 'tok', TENANT, 'owner-1', fetchImpl);

  assert.equal(result.created, true);
  assert.equal(result.id, 'robot-1');
  assert.equal(calls.length, 1);
  const [url, method, dto, auth] = calls[0];
  assert.equal(url, `${HUB_URL}/users`);
  assert.equal(method, 'POST');
  assert.equal(auth, 'Bearer tok');
  assert.equal(dto.email, robotEmailFor(TENANT));
  assert.equal(dto.tenantId, TENANT);
  assert.equal(dto.roleId, 'rbac_role_sdd_discovery');
  assert.equal(dto.isServiceAccount, true);
  assert.equal(dto.ownerUserId, 'owner-1');
  assert.match(dto.password, /^Rb.{20,}9$/);
});

test('ensureRobotUser es idempotente: 409 -> created:false, no lanza', async () => {
  const fetchImpl = async () => jsonResponse(409, { message: 'Email already registered' });
  const result = await ensureRobotUser(HUB_URL, 'tok', TENANT, 'owner-1', fetchImpl);
  assert.equal(result.created, false);
  assert.equal(result.email, robotEmailFor(TENANT));
});

test('ensureRobotUser lanza ante un error que no sea 409', async () => {
  const fetchImpl = async () => jsonResponse(403, { message: 'PERMISSION_DENIED' });
  await assert.rejects(
    () => ensureRobotUser(HUB_URL, 'tok', TENANT, 'owner-1', fetchImpl),
    /POST \/users fallo 403/,
  );
});

// TSK-0794
test('createActAsCredential envia {tenantId, role} y captura el secreto en memoria', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return jsonResponse(201, { credentialId: 'cred-1', secret: 'super-secreto' });
  };
  const result = await createActAsCredential(HUB_URL, 'tok', TENANT, 'CC_DEV', fetchImpl);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    `${HUB_URL}/rbac/act-as-credential`,
    { tenantId: TENANT, role: 'CC_DEV' },
  ]);
  assert.equal(result.alreadyExists, false);
  assert.equal(result.credentialId, 'cred-1');
  assert.equal(result.secret, 'super-secreto');
});

test('createActAsCredential reporta 409 (ya existe) sin lanzar ni exponer un secreto', async () => {
  const fetchImpl = async () => jsonResponse(409, { code: 'ACT_AS_CREDENTIAL_EXISTS' });
  const result = await createActAsCredential(HUB_URL, 'tok', TENANT, 'CC_DEV', fetchImpl);
  assert.equal(result.alreadyExists, true);
  assert.equal(result.secret, undefined);
});

// TSK-0795
test('loadSecretToChannel invoca setSecret con name = tenantId:role (keying de P1)', async () => {
  const calls = [];
  const setSecretImpl = async (service, name, value) => {
    calls.push([service, name, value]);
    return { backend: 'keyring' };
  };
  const result = await loadSecretToChannel(TENANT, 'OPERATOR', 'sec-value', setSecretImpl);
  assert.deepEqual(calls, [['integra-sdd-act-as', `${TENANT}:OPERATOR`, 'sec-value']]);
  assert.equal(result.name, `${TENANT}:OPERATOR`);
  assert.equal(result.backend, 'keyring');
});

// TSK-0811 (SPEC-0155 P5, ADR-003 v4) — service token del robot (sin password).
test('mintServiceAccountToken envia {userId, tenantId} y captura el token en memoria', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, JSON.parse(init.body), init.headers.Authorization]);
    return jsonResponse(201, { id: 'sat-1', token: 'plaintext-token' });
  };
  const result = await mintServiceAccountToken(HUB_URL, 'tok', 'robot-1', TENANT, fetchImpl);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    `${HUB_URL}/service-account-tokens`,
    { userId: 'robot-1', tenantId: TENANT },
    'Bearer tok',
  ]);
  assert.equal(result.id, 'sat-1');
  assert.equal(result.token, 'plaintext-token');
});

test('mintServiceAccountToken lanza ante un error del Hub', async () => {
  const fetchImpl = async () => jsonResponse(400, { code: 'NOT_SERVICE_ACCOUNT' });
  await assert.rejects(
    () => mintServiceAccountToken(HUB_URL, 'tok', 'robot-1', TENANT, fetchImpl),
    /POST \/service-account-tokens fallo 400/,
  );
});

test('loadRobotTokenToChannel invoca setSecret bajo ROBOT_LOGIN_SERVICE, name=tenantId (namespace distinto del canal act-as)', async () => {
  const calls = [];
  const setSecretImpl = async (service, name, value) => {
    calls.push([service, name, value]);
    return { backend: 'keyring' };
  };
  const result = await loadRobotTokenToChannel(TENANT, 'plaintext-token', setSecretImpl);
  assert.deepEqual(calls, [[ROBOT_LOGIN_SERVICE, TENANT, 'plaintext-token']]);
  assert.notEqual(ROBOT_LOGIN_SERVICE, 'integra-sdd-act-as');
  assert.equal(result.name, TENANT);
  assert.equal(result.backend, 'keyring');
});

test('loginAsTenantRobot lee el token del canal y llama POST /auth/service-login (no /auth/login)', async () => {
  const getSecretImpl = async (service, name) => {
    assert.equal(service, ROBOT_LOGIN_SERVICE);
    assert.equal(name, TENANT);
    return 'stored-robot-token';
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return jsonResponse(201, { accessToken: 'jwt-target-tenant' });
  };
  const accessToken = await loginAsTenantRobot(HUB_URL, TENANT, getSecretImpl, fetchImpl);

  assert.equal(accessToken, 'jwt-target-tenant');
  assert.deepEqual(calls, [[`${HUB_URL}/auth/service-login`, { token: 'stored-robot-token' }]]);
});

test('loginAsTenantRobot lanza si no hay service token en el canal para ese tenant', async () => {
  const getSecretImpl = async () => null;
  await assert.rejects(
    () => loginAsTenantRobot(HUB_URL, TENANT, getSecretImpl, async () => jsonResponse(201, {})),
    /Sin service token del robot/,
  );
});

test('rotateRobotToken pide /:id/rotate y recarga el canal con el token nuevo', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push([url, init.method]);
    return jsonResponse(200, { id: 'sat-1', token: 'rotated-token' });
  };
  const setSecretCalls = [];
  const setSecretImpl = async (service, name, value) => {
    setSecretCalls.push([service, name, value]);
    return { backend: 'keyring' };
  };
  const result = await rotateRobotToken(HUB_URL, 'tok', 'sat-1', TENANT, fetchImpl, setSecretImpl);

  assert.deepEqual(fetchCalls, [[`${HUB_URL}/service-account-tokens/sat-1/rotate`, 'POST']]);
  assert.deepEqual(setSecretCalls, [[ROBOT_LOGIN_SERVICE, TENANT, 'rotated-token']]);
  assert.equal(result.id, 'sat-1');
  assert.equal(result.backend, 'keyring');
});
