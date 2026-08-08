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

// ----- SPEC-0187 P7 — la dimension tenant del canal -----
//
// El backend ya tiene la dimension (AuthorizedMachine es unico por (tenantId, fingerprintHash));
// el canal del cliente no la tenia, asi que dos tenants en la misma maquina se pisaban las
// mismas tres entradas. Aca vive la resolucion, UNA sola vez, porque los tres consumidores
// (login, hook de licencia, CLI de identidad) tienen que coincidir byte a byte en QUE clave
// leen: dos criterios que se separen es exactamente el pisado que la fase viene a cerrar.
//
// LA ENV DEL SELECTOR ES `INTEGRA_SDD_TENANT`, NO `INTEGRA_ACT_AS_TENANT`. El plan proponia
// reusar la del contrato scoped; el Step 0 (AP8) lo verifico y la descarto: el valor de
// INTEGRA_ACT_AS_TENANT es el `Tenant.id` —el backend rebota 403 ACT_AS_TENANT_MISMATCH si no
// coincide con el tenantId del JWT del firmante— mientras que la dimension de estas claves es
// el `tenantSlug`. `Tenant.id` y `Tenant.slug` son campos distintos: coinciden por accidente
// historico en integra-piloto y NO en un tenant nuevo. Veredicto en el comment de la fase P7.
export const SDD_TENANT_ENV = 'INTEGRA_SDD_TENANT';

// Indice de tenants con identidad en ESTA maquina. Existe porque el canal no se puede
// enumerar (ni el keyring del SO ni el cipher-file exponen un listado por service): sin este
// dato, una sesion que no declara tenant no podria saber si hay una sola identidad guardada o
// tres, y elegir a ciegas entre dos tenants es el pisado en su version silenciosa.
// El nombre no colisiona: los tenants viven en '<slug>:<algo>' y los legacy no tienen ':'.
export const SDD_IDENTITY_TENANTS_NAME = 'tenants';

/** El tenant que declara ESTA sesion, o null. Trim + vacio = no declarado. */
export function resolveSessionTenant(env = process.env) {
  const raw = (env[SDD_TENANT_ENV] ?? '').trim();
  return raw || null;
}

/** Account del canal para (tenant, entrada). Sin tenant devuelve la clave legacy sin prefijo. */
export function scopedName(tenantSlug, name) {
  return tenantSlug ? `${tenantSlug}:${name}` : name;
}

/**
 * El aviso que reemplaza al fallback silencioso. Nombra el tenant y los DOS caminos que lo
 * resuelven, porque son distintos: `login` sirve para un equipo que nunca se autentico contra
 * ese tenant, `migrate` para el que tiene identidad guardada de antes del esquema por tenant.
 */
export function missingIdentityNotice(tenantSlug) {
  return (
    `no hay identidad SDD para el tenant '${tenantSlug}' en este equipo. ` +
    `Accion: \`specoe-identity.mjs login --tenant ${tenantSlug}\` si nunca te autenticaste con ese tenant, ` +
    `o \`specoe-identity.mjs migrate --tenant ${tenantSlug}\` si tu identidad es anterior al esquema por tenant. ` +
    `NO se usa la identidad guardada de otro tenant: operar con la credencial equivocada es peor que no operar.`
  );
}

/** Los slugs con identidad en el canal, en orden de alta. Nunca tira: sin indice devuelve []. */
export async function readTenantIndex({ getSecretImpl = getSecret } = {}) {
  try {
    const raw = await getSecretImpl(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TENANTS_NAME);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s) : [];
  } catch {
    return [];
  }
}

/** Suma un slug al indice (idempotente). Devuelve la lista resultante. */
export async function addTenantToIndex(
  tenantSlug,
  { getSecretImpl = getSecret, setSecretImpl = setSecret } = {},
) {
  const current = await readTenantIndex({ getSecretImpl });
  if (!tenantSlug || current.includes(tenantSlug)) return current;
  const next = [...current, tenantSlug];
  await setSecretImpl(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TENANTS_NAME, JSON.stringify(next));
  return next;
}

/** Saca un slug del indice. Devuelve la lista resultante. */
export async function removeTenantFromIndex(
  tenantSlug,
  { getSecretImpl = getSecret, setSecretImpl = setSecret } = {},
) {
  const current = await readTenantIndex({ getSecretImpl });
  if (!current.includes(tenantSlug)) return current;
  const next = current.filter((s) => s !== tenantSlug);
  // setSecret rechaza el valor vacio, y '[]' es un valor legitimo: el indice vacio significa
  // "no queda identidad scoped", que NO es lo mismo que "nunca hubo indice".
  await setSecretImpl(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TENANTS_NAME, JSON.stringify(next));
  return next;
}

/** Outcomes de la resolucion de scope. Estables: la suite y los avisos discriminan por esto. */
export const SCOPE_DECLARED = 'declarado'; // la sesion declaro el tenant
export const SCOPE_SINGLE = 'unico'; // no declaro y hay UNA sola identidad scoped
export const SCOPE_LEGACY = 'legacy'; // no declaro y no hay identidad scoped: claves sin tenant
export const SCOPE_AMBIGUOUS = 'ambiguo'; // no declaro y hay VARIAS: no se adivina

/**
 * Que claves lee esta sesion. Un solo lugar decide, y el fallback legacy queda ACOTADO a la
 * unica situacion donde no puede mentir: la sesion no declaro tenant y el canal no tiene
 * ninguna identidad scoped (o sea, la instalacion del piloto anterior a esta fase).
 *
 * Devuelve { tenantSlug, outcome, notice }: `notice` no-null es un aviso accionable para el
 * dev, y significa que NO hay que leer nada — nunca se cae a otro tenant ni al legacy.
 */
export async function resolveIdentityScope({
  tenantSlug = resolveSessionTenant(),
  getSecretImpl = getSecret,
} = {}) {
  if (tenantSlug) return { tenantSlug, outcome: SCOPE_DECLARED, notice: null };

  const tenants = await readTenantIndex({ getSecretImpl });
  if (tenants.length === 1) {
    return { tenantSlug: tenants[0], outcome: SCOPE_SINGLE, notice: null };
  }
  if (tenants.length > 1) {
    return {
      tenantSlug: null,
      outcome: SCOPE_AMBIGUOUS,
      notice:
        `este equipo tiene identidad SDD de ${tenants.length} tenants (${tenants.join(', ')}) y esta sesion no declara ninguno. ` +
        `Accion: declara \`specoe.tenant\` en el project.config.yaml del room (los launchers lo exportan como ${SDD_TENANT_ENV}). ` +
        `No se elige uno por default: operar con el tenant equivocado es el defecto que este aislamiento viene a evitar.`,
    };
  }
  return { tenantSlug: null, outcome: SCOPE_LEGACY, notice: null };
}

/**
 * El material de identidad del scope vigente, con VALORES. Punto unico de lectura: lo consumen
 * el `status` del CLI, el `session-token` y el hook de licencia.
 *
 * Devuelve { tenantSlug, outcome, notice, present, userToken, machineId, userId }. Con `notice`
 * no-null los tres valores vienen en null a proposito: hay algo que decirle al dev y nada que
 * leer. `present` es la unica lectura de "esta maquina puede operar" (token + machineId).
 */
export async function readIdentityMaterialScoped({
  tenantSlug = resolveSessionTenant(),
  getSecretImpl = getSecret,
} = {}) {
  const scope = await resolveIdentityScope({ tenantSlug, getSecretImpl });
  if (scope.notice) {
    return { ...scope, present: false, userToken: null, machineId: null, userId: null };
  }
  const [userToken, machineId, userId] = await Promise.all([
    getSecretImpl(SDD_IDENTITY_SERVICE, scopedName(scope.tenantSlug, SDD_IDENTITY_TOKEN_NAME)),
    getSecretImpl(SDD_IDENTITY_SERVICE, scopedName(scope.tenantSlug, SDD_IDENTITY_MACHINE_NAME)),
    getSecretImpl(SDD_IDENTITY_SERVICE, scopedName(scope.tenantSlug, SDD_IDENTITY_USER_NAME)),
  ]);
  const present = userToken != null && machineId != null;
  // El aviso sale SOLO cuando la sesion declaro el tenant: en los otros outcomes la ausencia de
  // material es "no hay login todavia", que ya se comunica por otros canales del arranque.
  const notice =
    !present && scope.outcome === SCOPE_DECLARED ? missingIdentityNotice(scope.tenantSlug) : null;
  return { ...scope, notice, present, userToken, machineId, userId };
}

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
 * Devuelve { userId, source, reason, scope }:
 *   source 'canal'    — estaba guardado (camino normal, sin red).
 *   source 'derivado' — se canjeo el token ahora y quedo guardado.
 *   userId null       — no hay identidad SDD por usuario en esta maquina (modo MACHINE, o
 *                       login no corrido), o la derivacion fallo. `reason` dice cual.
 *   scope             — { tenantSlug, outcome, notice }: QUE claves se leyeron (SPEC-0187 P7).
 *                       `scope.notice` no-null es un aviso accionable para el dev; en ese caso
 *                       no se leyo ninguna clave de otro tenant ni la legacy.
 *
 * NUNCA tira: el caller de arriba es un hook de arranque y un throw aca seria bloquear una
 * sesion por no poder mandar un campo opcional.
 */
export async function resolveUserContext({
  hubUrl,
  timeoutMs = 4000,
  fetchImpl = fetch,
  allowDerive = true,
  tenantSlug = resolveSessionTenant(),
} = {}) {
  let scope = { tenantSlug, outcome: SCOPE_DECLARED, notice: null };
  try {
    const material = await readIdentityMaterialScoped({ tenantSlug });
    scope = { tenantSlug: material.tenantSlug, outcome: material.outcome, notice: material.notice };
    // SPEC-0187 P7 — el room declara un tenant del que este equipo no tiene identidad (o hay
    // varias y ninguna declarada). Se corta ACA con el motivo: caer a las claves de otro tenant
    // seria operar con la credencial equivocada, que es peor que no operar.
    if (material.notice) return { userId: null, source: null, reason: material.notice, scope };

    if (material.userId) return { userId: material.userId, source: 'canal', reason: null, scope };

    // Sin material NO se deriva y NO se hace ningun request: una maquina en modo MACHINE
    // (o sin login SDD) no tiene nada que resolver, y el Hub ignora userContext ahi.
    if (!material.present) {
      return {
        userId: null,
        source: null,
        reason:
          'no hay material de identidad SDD en el canal (login no corrido, o el tenant opera en modo MACHINE)',
        scope,
      };
    }
    if (!allowDerive) {
      return {
        userId: null,
        source: null,
        reason: 'hay material en el canal pero esta corrida no tenia presupuesto para derivarlo',
        scope,
      };
    }

    const { userId, reason } = await deriveUserId({
      hubUrl,
      token: material.userToken,
      machineId: material.machineId,
      timeoutMs,
      fetchImpl,
    });
    if (!userId) return { userId: null, source: null, reason, scope };

    // Persistir es lo que hace que este camino sea de UNA sola vez por maquina — bajo la MISMA
    // clave de la que se leyo el material, nunca la legacy.
    try {
      await setSecret(
        SDD_IDENTITY_SERVICE,
        scopedName(scope.tenantSlug, SDD_IDENTITY_USER_NAME),
        userId,
      );
    } catch {
      /* el canal no acepto la escritura: se re-deriva el proximo arranque, no se pierde nada */
    }
    return { userId, source: 'derivado', reason: null, scope };
  } catch (err) {
    return {
      userId: null,
      source: null,
      reason: `error resolviendo el userContext: ${err?.message}`,
      scope,
    };
  }
}
