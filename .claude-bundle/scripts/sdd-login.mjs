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
// El fingerprint es la MISMA derivación que el cliente MCP recomputa en runtime
// (mcp-server/src/sdd-identity.ts, ADR-004) — si difiere, el enrolamiento y la
// derivación de sesión no coinciden y el Hub rechaza MACHINE_FINGERPRINT_MISMATCH.
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
//                 robot:{ configured, provisioned, tokenStored, seatPoolExhausted } }
//   login err → { ok:false, statusCode?, code?, message, missing? }   (exit 1)
//   status    → { userToken:bool, machineId:bool }
//
// El import de secrets.mjs es relativo (../hooks/): resuelve igual en el repo
// (.claude-bundle/scripts → .claude-bundle/hooks) y deployado
// (~/.claude/scripts → ~/.claude/hooks).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { setSecret, getSecret, ROBOT_LOGIN_SERVICE } from '../hooks/secrets.mjs';

const execFileAsync = promisify(execFile);

// Convención keyring del modo USER (mcp-server/src/sdd-identity.ts — P2).
const SDD_IDENTITY_SERVICE = 'integra-sdd-identity';
const SDD_IDENTITY_TOKEN_NAME = 'user-token';
const SDD_IDENTITY_MACHINE_NAME = 'machine-id';

const DEFAULT_HUB_URL = 'https://hub.integra.local/api/v1';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ----- fingerprint — réplica exacta de mcp-server/src/sdd-identity.ts -----

function hashDiskSerial(serial) {
  return createHash('sha256')
    .update((serial ?? '').trim().toLowerCase(), 'utf8')
    .digest('hex');
}

async function getDiskSerial() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'wmic',
        [
          'diskdrive',
          'where',
          "MediaType='Fixed hard disk media'",
          'get',
          'SerialNumber',
          '/value',
        ],
        { timeout: 3000 },
      );
      const match = stdout.match(/SerialNumber=(.+)/);
      return match ? match[1].trim() : '';
    }
    if (process.platform === 'linux') {
      const blocks = await fs.readdir('/sys/block');
      for (const name of blocks) {
        if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('sr')) continue;
        try {
          const s = (await fs.readFile(`/sys/block/${name}/device/serial`, 'utf8')).trim();
          if (s) return s;
        } catch {
          /* siguiente block device */
        }
      }
      return '';
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOAHCIBlockStorageDevice'], {
        timeout: 3000,
      });
      const match =
        stdout.match(/"IOPropertyMatch".*?"Serial Number"\s*=\s*"([^"]+)"/s) ??
        stdout.match(/"Serial Number"\s*=\s*"([^"]+)"/);
      return match ? match[1].trim() : '';
    }
    return '';
  } catch {
    return '';
  }
}

async function collectFingerprint() {
  const diskSerial = await getDiskSerial();
  return {
    hostname: os.hostname(),
    os: process.platform,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    diskSerialHash: hashDiskSerial(diskSerial),
  };
}

// ----- subcomandos -----

async function doStatus() {
  const userToken = (await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME)) != null;
  const machineId = (await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME)) != null;
  out({ userToken, machineId });
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

  const fingerprint = await collectFingerprint();

  let res;
  try {
    res = await fetch(`${hubUrl}/auth/sdd/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fingerprint }),
    });
  } catch (e) {
    out({
      ok: false,
      message: `no se pudo conectar al Hub (${hubUrl}): ${e?.cause?.code ?? e?.message ?? e}`,
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
