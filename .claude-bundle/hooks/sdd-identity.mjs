// TKT-0232 — material de identidad SDD por usuario: convencion del canal, fingerprint y
// resolucion del userId. UNICO punto de definicion, compartido por los dos consumidores:
//
//   - scripts/sdd-login.mjs      graba el material en el canal al hacer el login SDD.
//   - hooks/specoe-license-check.mjs  lo lee para mandar `userContext` al /license/validate.
//
// POR QUE ESTE MODULO EXISTE
//
// En USER-mode (Tenant.sddIdentityMode='USER') el claim `sddRole` del JWT de licencia NO
// sale de License.sddRole: el Hub lo deriva de los UserSddRole activos del usuario que el
// caller declara en `userContext` (license.service.ts resolveBundleRole). La derivacion es
// fail-closed — sin userContext no hay claim, y sin claim el skill-server resuelve
// `role = payload.sddRole ?? null` (auth.ts), o sea BUNDLE PRODUCTO. Un room recien
// onboardeado corria como producto por no mandar un campo.
//
// El userId no se puede sacar del material guardado: el UserSddToken es OPACO (prefijo
// `isdd_` + 32 bytes random, sdd-auth.service.ts) y /auth/sdd/login no devuelve el userId.
// La UNICA fuente es el JWT de sesion derivada (/auth/sdd/session), cuyo `sub` ES el userId.
// Por eso el login lo deriva UNA vez y lo deja en el canal: el hook de arranque lee del
// canal y no gasta un request por sesion.
//
// El fingerprint SDD (el de /auth/sdd/*) NO es el fingerprint de licencia (el de
// /license/*): distinta composicion y distinto hash. Vive aca una sola vez a proposito —
// dos copias que se separen hacen que el Hub rechace la derivacion con
// MACHINE_FINGERPRINT_MISMATCH, que es el fallo mas caro de diagnosticar de este canal.
// Es replica exacta de mcp-server/src/sdd-identity.ts (ADR-004).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { getSecret, setSecret } from './secrets.mjs';

const execFileAsync = promisify(execFile);

// Convencion keyring del modo USER (mcp-server/src/sdd-identity.ts — SPEC-0157 P2).
export const SDD_IDENTITY_SERVICE = 'integra-sdd-identity';
export const SDD_IDENTITY_TOKEN_NAME = 'user-token';
export const SDD_IDENTITY_MACHINE_NAME = 'machine-id';
// TKT-0232 — entrada NUEVA: el userId del seat, para `userContext`. El cliente MCP no la
// lee (deriva su sesion con el token opaco); la agrega este bundle para el hook de licencia.
export const SDD_IDENTITY_USER_NAME = 'user-id';

// ----- fingerprint SDD — replica exacta de mcp-server/src/sdd-identity.ts -----

export function hashDiskSerial(serial) {
  return createHash('sha256')
    .update((serial ?? '').trim().toLowerCase(), 'utf8')
    .digest('hex');
}

export async function getDiskSerial() {
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

export async function collectSddFingerprint() {
  const diskSerial = await getDiskSerial();
  return {
    hostname: os.hostname(),
    os: process.platform,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    diskSerialHash: hashDiskSerial(diskSerial),
  };
}

// ----- derivacion del userId -----

/** Payload de un JWT sin verificar firma. Solo para leer `sub` (mismo criterio que el verificador). */
export function decodeJwtPayload(token) {
  try {
    const [, payloadB64] = String(token).split('.');
    if (!payloadB64) return null;
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Canjea el material del canal por un JWT de sesion de 15 min y devuelve su `sub` — el
 * userId del seat. NO persiste nada: eso lo decide el caller.
 *
 * Devuelve { userId, reason }. `userId` null con `reason` legible en todo fallo: este
 * camino es fail-open en los dos consumidores (el login no se cae por esto, el arranque
 * tampoco), asi que el motivo tiene que viajar para que quede en el log.
 */
export async function deriveUserId({
  hubUrl,
  token,
  machineId,
  fingerprint,
  timeoutMs = 4000,
  fetchImpl = fetch,
}) {
  if (!hubUrl) return { userId: null, reason: 'sin URL del Hub' };
  if (!token) return { userId: null, reason: 'sin UserSddToken en el canal' };
  if (!machineId) return { userId: null, reason: 'sin machineId en el canal' };
  const base = String(hubUrl).replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(`${base}/auth/sdd/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        machineId,
        fingerprint: fingerprint ?? (await collectSddFingerprint()),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { userId: null, reason: `no hubo respuesta del Hub: ${err?.message ?? String(err)}` };
  }
  if (!res.ok) {
    // El code del Hub (SDD_TOKEN_REVOKED, MACHINE_REVOKED, MACHINE_FINGERPRINT_MISMATCH...)
    // dice cual de los tres bindings se rompio; sin el, "HTTP 403" no nombra nada.
    let code;
    try {
      code = (await res.json())?.code;
    } catch {
      /* body no-JSON */
    }
    return {
      userId: null,
      reason: `el Hub rechazo la derivacion de sesion (HTTP ${res.status}${code ? ` ${code}` : ''})`,
    };
  }
  let accessToken;
  try {
    accessToken = (await res.json())?.accessToken;
  } catch {
    return { userId: null, reason: 'la respuesta de /auth/sdd/session no es JSON' };
  }
  const sub = decodeJwtPayload(accessToken)?.sub;
  if (!sub) {
    return { userId: null, reason: 'el JWT de sesion no trae `sub`: no hay userId que leer' };
  }
  return { userId: sub, reason: null };
}

/**
 * El userId del seat para mandar como `userContext`. Canal primero; si no esta, lo deriva
 * UNA vez y lo persiste — asi la instalacion que ya hizo login antes de este fix se repara
 * sola en el primer arranque, sin re-login.
 *
 * Devuelve { userId, source, reason }:
 *   source 'canal'    — estaba guardado (camino normal, sin red).
 *   source 'derivado' — se canjeo el token ahora y quedo guardado.
 *   userId null       — no hay identidad SDD por usuario en esta maquina (modo MACHINE, o
 *                       login no corrido), o la derivacion fallo. `reason` dice cual.
 *
 * NUNCA tira: el caller de arriba es un hook de arranque y un throw aca seria bloquear una
 * sesion por no poder mandar un campo opcional.
 */
export async function resolveUserContext({
  hubUrl,
  timeoutMs = 4000,
  fetchImpl = fetch,
  allowDerive = true,
} = {}) {
  try {
    const stored = await getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME);
    if (stored) return { userId: stored, source: 'canal', reason: null };

    const [token, machineId] = await Promise.all([
      getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME),
      getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME),
    ]);
    // Sin material NO se deriva y NO se hace ningun request: una maquina en modo MACHINE
    // (o sin login SDD) no tiene nada que resolver, y el Hub ignora userContext ahi.
    if (!token || !machineId) {
      return {
        userId: null,
        source: null,
        reason:
          'no hay material de identidad SDD en el canal (login no corrido, o el tenant opera en modo MACHINE)',
      };
    }
    if (!allowDerive) {
      return {
        userId: null,
        source: null,
        reason: 'hay material en el canal pero esta corrida no tenia presupuesto para derivarlo',
      };
    }

    const { userId, reason } = await deriveUserId({
      hubUrl,
      token,
      machineId,
      timeoutMs,
      fetchImpl,
    });
    if (!userId) return { userId: null, source: null, reason };

    // Persistir es lo que hace que este camino sea de UNA sola vez por maquina.
    try {
      await setSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME, userId);
    } catch {
      /* el canal no acepto la escritura: se re-deriva el proximo arranque, no se pierde nada */
    }
    return { userId, source: 'derivado', reason: null };
  } catch (err) {
    return {
      userId: null,
      source: null,
      reason: `error resolviendo el userContext: ${err?.message}`,
    };
  }
}
