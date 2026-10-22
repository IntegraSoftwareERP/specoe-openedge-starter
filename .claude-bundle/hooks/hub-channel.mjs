// TKT-0321 — canal UNICO de los hooks del Hub hacia el Hub.
// TKT-0498 — el canal habla con la identidad y el tenant que DECLARA EL ROOM, o no habla.
//
// ----- POR QUE EXISTE -----
//
// Los dos hooks de ack-task nacieron en SPEC-0080 S6 sobre el modelo de identidad de
// SPEC-0005: `integra-hub-auth.mjs` + email/password en el keyring. Ese modelo vive en las
// maquinas del equipo Integra y NO existe en la maquina de un dev de un tenant, que entra por
// el login SDD del starter (`sdd-login.mjs` guarda user-token + machine-id en el servicio
// `integra-sdd-identity` y nunca escribe email/password).
//
// Medido el 2026-08-11 en un HOME limpio, con el enforcer tal cual estaba:
//
//   sin integra-hub-auth.mjs  -> exit 2  "integra-hub-auth.mjs missing"
//   con el, sin credenciales  -> exit 2  "Hub unreachable / timeout ... Conservative block."
//
// El segundo es el peligroso: bajo `ackTaskMode = HARD_BLOCK` bloquea TODO Edit/Write/Bash de
// esa maquina y el mensaje manda a mirar la red cuando lo que falta es la identidad. Cualquier
// excepcion de `hubFetch` —incluida "credenciales no configuradas"— caia en el `catch` que
// clasifica 'network'.
//
// Este modulo resuelve el canal UNA vez por proceso y devuelve un `fetch` ya firmado, o una
// falla TIPADA que el hook puede convertir en un mensaje accionable. La distincion entre "no
// hay identidad" y "el Hub no responde" es el punto entero del modulo: son dos problemas con
// dos acciones distintas y hasta hoy se reportaban con el mismo texto.
//
// ----- TKT-0498: POR QUE EL ROOM DECLARA LA IDENTIDAD -----
//
// Los hooks de `~/.claude/settings.json` corren en TODA sesion de la maquina, sea cual sea el
// room. Hasta TKT-0498 el canal probaba "legacy primero": la cuenta de `integra-hub-auth.mjs`
// (una sola por maquina, la del hint `integra-hub-account.json`) logueada SIN `tenantId`, o sea
// con el JWT del primer binding de esa cuenta. Medido el 2026-10-16 en el room OPERATOR de Integra
// ERP: el MCP del room estaba aislado en ERP y los hooks hablaban con integra-piloto — inyectaban
// su INFRA_CONTEXT, listaban sus tasks y le escribian la telemetria de la sesion de ERP.
//
// La identidad no se puede inferir de la maquina: en una maquina con rooms de dos tenants, "la
// cuenta del keyring" es la de uno de los dos. La declara el room, en su config propia
// (`project.config.local.yaml`, o el versionado si el local no la declara — la misma regla de
// TKT-0448), seccion `hub:`:
//
//   hub:
//     api-url: 'https://hub.integra.local/api/v1'
//     tenant-id: 'cmrt8oahx000wc1fm5jtvhxpc'          # Tenant.id, el que va al login y al JWT
//     account: 'pmoyano@integraerp.com'               # cuenta personal (equipo Integra)
//     keyring-service: 'integra-hub-arquitecto-integraerp'   # opcional
//
// y, para la identidad SDD del starter, la clave que el starter YA escribe al loguear:
//
//   specoe:
//     tenant: 'integra-erp'                           # tenantSlug del login SDD
//
// El room es `CLAUDE_PROJECT_DIR` (la carpeta donde arranco la sesion) y recien si no esta, el
// `cwd` del hook: el `cwd` cambia con cada `cd` de la sesion, y un hook que lee la identidad de
// ahi la pierde apenas el agente entra al checkout de un repo.
//
// ----- LOS DOS CANALES — EXCLUYENTES POR DECLARACION, NO POR ORDEN -----
//
//   1. Personal (SPEC-0005) — el room declara `hub.account`. Login con `{email, password,
//      tenantId}`; el password sale del keyring (`<keyring-service>` / `<account>`, default
//      `integra-hub-claude-code`) o de INTEGRA_HUB_EMAIL/PASSWORD SOLO si el email del env es la
//      cuenta declarada. Exige `hub.tenant-id`.
//   2. SDD (modo USER de SPEC-0157) — el room NO declara cuenta y SI `specoe.tenant`. El material
//      se lee scoped a ESE slug (`readIdentityMaterialScoped({ tenantSlug })`): el material legacy
//      sin scope y el de otro tenant no se leen nunca. Derivacion con POST /auth/sdd/session.
//
// Ya no hay "legacy primero" ni reintento cruzado: el canal lo elige la declaracion, y si el
// declarado no resuelve se falla CERRADO. Caer a otra cuenta es exactamente el defecto.
//
// ----- LA VERIFICACION: EL CLAIM DEL JWT, NO LA BUENA FE -----
//
// El backend firma `tenantId` en todo JWT (auth.service.ts, `generateTokens`). Toda sesion
// —login, refresh, la cacheada en disco y la SDD derivada cuando el room declara `tenant-id`—
// se acepta solo si ese claim es el tenant del room. Si no, se descarta y no sale ningun request
// con ella. Un login con `tenantId` que el usuario no tiene ya rebota 403 TENANT_NOT_ASSIGNED;
// el chequeo del claim es el cinturon para el refresh y para la sesion cacheada.
//
// La sesion personal se cachea POR (url, cuenta, tenant) en `~/.claude/integra-hub-sessions/`,
// no en el `integra-hub-session.json` unico de `integra-hub-auth.mjs` (que sigue siendo el del
// MCP por `INTEGRA_HUB_AUTH_HOOK`, y que este modulo no lee ni escribe).
//
// ----- POR QUE EL CANAL TLS SE APLICA ACA -----
//
// `applyCaChannel()` muta el store de CA DEL PROCESO QUE LA LLAMA (`tls.setDefaultCACertificates`)
// y su propio encabezado exige aplicarlo ANTES DEL PRIMER REQUEST. Un hook es un proceso aparte:
// que `ca-channel.mjs` este instalado en la maquina no le sirve a un proceso que no lo invoca.
// Ninguno de los hooks del Hub lo invocaba (`grep -c ca-channel` daba 0 en los tres), asi que
// contra un Hub servido por el root local el fetch moria con `unable to get local issuer
// certificate` — otra vez, reportado como 'network'.
//
// Se aplica una sola vez, al resolver el canal, y su fracaso NO es fatal: en una maquina sin
// certificado local (Hub con cert publico) el store default alcanza y el modulo no tiene por que
// tener opinion.

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Todos los modulos vecinos se importan DINAMICAMENTE y con catch: este archivo viaja al
// `~/.claude/hooks/` de maquinas con distinta composicion (equipo Integra vs dev de tenant) y un
// import estatico de algo ausente falla en la RESOLUCION, o sea antes de cualquier catch del
// hook y sin mensaje. Es el mismo modo de falla que TKT-0232 dejo documentado para el allowlist
// del instalador.
async function importSibling(name) {
  try {
    return await import(`./${name}`);
  } catch {
    return null;
  }
}

/** Servicio del keyring donde SPEC-0005 guarda el password de una cuenta (account = email). */
export const DEFAULT_KEYRING_SERVICE = 'integra-hub-claude-code';

// ----- URL del Hub -----

// Misma precedencia que `specoe-license-check.mjs` (env > config del room), mas las dos
// fuentes que existen del lado del equipo. No se inventa configuracion nueva: cada eslabon es
// una fuente que YA usa alguien.
//
//   1. INTEGRA_HUB_URL      — la que documenta el gate de licencia del starter.
//   2. INTEGRA_HUB_API_URL  — la que el .mcp.json del room le pasa al MCP.
//   3. hub.api-url del room del cwd — `project.config.local.yaml` si la DECLARA, si no
//      `project.config.yaml` (TKT-0448, ver `pickRoomScalar` abajo).
//   4. credentials.mjs      — la del modelo legacy (maquinas del equipo).
//
// Una clave declarada VACIA en el local gana igual (tapa la del versionado) y, como no es una URL,
// se sigue al eslabon 4: es lo mismo que hace el hook de licencia, que en ese caso cae a su fallback.
//
// TKT-0498: el canal ya NO usa el eslabon 4 (es la URL de la cuenta por defecto de la maquina,
// no la del room); resuelve la URL con `resolveRoomIdentity`. Esta funcion queda con su
// contrato para quien solo necesita "la URL del Hub de este room".
export async function resolveHubUrl(cwd) {
  const fromEnv = process.env.INTEGRA_HUB_URL || process.env.INTEGRA_HUB_API_URL;
  if (fromEnv) return { url: stripTrailingSlash(fromEnv), source: 'env' };

  const fromRoom = await readHubUrlFromRoom(cwd);
  if (fromRoom.value && fromRoom.value.trim()) {
    return { url: stripTrailingSlash(fromRoom.value), source: fromRoom.source };
  }

  const creds = await importSibling('credentials.mjs');
  if (creds && typeof creds.getCredentials === 'function') {
    try {
      const c = await creds.getCredentials();
      if (c && c.url) return { url: stripTrailingSlash(c.url), source: 'credentials.mjs' };
    } catch {
      // Sin credenciales legacy no hay URL por este camino. No es un error del canal SDD.
    }
  }
  return { url: null, source: null };
}

function stripTrailingSlash(value) {
  return String(value).trim().replace(/\/+$/, '');
}

// ----- config del room (TKT-0448) -----
//
// La config PROPIA del room vive en `project.config.local.yaml` (no versionado), al lado del
// `project.config.yaml` que publica el starter y con su misma forma. Escribir la config del room en
// el versionado lo dejaba modificado y hacia chocar el `pull --ff-only` de cada release (decision
// del Operador 2026-09-23, comment Hub cmueglfsr01gdny8myu61lp5d).
//
// La regla es la MISMA que la de los otros tres lectores —`specoe_room_get` (specoe-yaml.sh),
// `pickRoomScalar` (specoe-room-bootstrap.mjs del starter) y `pickRoomScalar` del plugin—: si el
// local DECLARA la clave gana, aunque este vacia; si no la declara, vale la del versionado. Los
// cuatro tienen que coincidir o un room se leeria distinto segun quien pregunte.
//
// Es una COPIA y no un import de specoe-room-bootstrap.mjs a proposito: este archivo viaja a
// `~/.claude/hooks/` de maquinas del equipo Integra que no tienen el bundle del starter (ver
// `importSibling`), y la resolucion de la URL no puede depender de un vecino que puede faltar.
// Sin dep de YAML: un hook con 5 segundos de presupuesto.

export const ROOM_LOCAL_CONFIG = 'project.config.local.yaml';
const ROOM_CONFIG = 'project.config.yaml';

/**
 * Escalar ANCLADO a su seccion. Byte a byte el criterio de `readSpecoeScalar` del starter: toda
 * linea sin indentar abre un bloque top-level (y cierra el anterior); comillas simples o dobles
 * hasta la de cierre; sin comillas, se corta el comentario. `undefined` = no declarada.
 *
 * Hasta TKT-0448 este hook leia `api-url:` con una regex GLOBAL sobre el archivo entero: andaba
 * porque la unica `api-url:` del yaml vive bajo `hub:`, no por construccion, y con un comentario al
 * final de la linea no leia nada.
 */
export function readSpecoeScalar(content, section, key) {
  let inBlock = false;
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    if (/^\S/.test(rawLine)) {
      inBlock = rawLine.startsWith(`${section}:`);
      continue;
    }
    if (!inBlock) continue;
    const match = rawLine.match(new RegExp(`^\\s+${key}:\\s*(.*)$`));
    if (!match) continue;
    const value = match[1];
    if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      return end === -1 ? value.slice(1) : value.slice(1, end);
    }
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      return end === -1 ? value.slice(1) : value.slice(1, end);
    }
    return value.replace(/\s*#.*$/, '').trim();
  }
  return undefined;
}

/** La precedencia, pura. Devuelve de QUE archivo salio el valor, para que el diagnostico lo nombre. */
export function pickRoomScalar(localContent, sharedContent, section, key) {
  const fromLocal = localContent == null ? undefined : readSpecoeScalar(localContent, section, key);
  if (fromLocal !== undefined) return { value: fromLocal, source: ROOM_LOCAL_CONFIG };
  const fromShared =
    sharedContent == null ? undefined : readSpecoeScalar(sharedContent, section, key);
  if (fromShared !== undefined) return { value: fromShared, source: ROOM_CONFIG };
  return { value: undefined, source: null };
}

async function readRoomConfigs(dir) {
  if (!dir) return { local: undefined, shared: undefined };
  const leer = async (nombre) => {
    try {
      return await readFile(path.join(dir, nombre), 'utf8');
    } catch {
      return undefined;
    }
  };
  const [local, shared] = await Promise.all([leer(ROOM_LOCAL_CONFIG), leer(ROOM_CONFIG)]);
  return { local, shared };
}

async function readHubUrlFromRoom(cwd) {
  const { local, shared } = await readRoomConfigs(cwd);
  return pickRoomScalar(local, shared, 'hub', 'api-url');
}

// ----- identidad del room (TKT-0498) -----

/**
 * La carpeta del room: `CLAUDE_PROJECT_DIR` primero (fija durante toda la sesion) y el `cwd` del
 * hook solo si no esta. Ver "POR QUE EL ROOM DECLARA LA IDENTIDAD" en el encabezado.
 */
export function roomDirOf(cwd) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return cwd || null;
}

/** Valor declarado y no vacio, o `null`. Una clave declarada vacia cuenta como NO declarada. */
function declared(pick) {
  return typeof pick.value === 'string' && pick.value.trim() ? pick.value.trim() : null;
}

function sha16(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Lee la identidad Hub que declara el room. NO toca la red: lo usan tambien los caches que se
 * consultan antes de resolver el canal (`cacheKey`).
 *
 * Devuelve:
 *   { ok: true, mode: 'personal'|'sdd', roomDir, tenantId, tenantSlug, tenantLabel, account,
 *     keyringService, hubUrl, hubUrlSource, cacheKey, sources }
 *   { ok: false, kind: 'no-room-identity', roomDir, tenantLabel, reason }
 *
 * `tenantLabel` es el tenant que se nombra en los mensajes: el `tenant-id` si esta, si no el slug.
 */
export async function resolveRoomIdentity({ cwd } = {}) {
  const roomDir = roomDirOf(cwd);
  const { local, shared } = await readRoomConfigs(roomDir);
  const pick = (section, key) => pickRoomScalar(local, shared, section, key);

  const tenantIdPick = pick('hub', 'tenant-id');
  const accountPick = pick('hub', 'account');
  const servicePick = pick('hub', 'keyring-service');
  const slugPick = pick('specoe', 'tenant');

  const tenantId = declared(tenantIdPick);
  const account = declared(accountPick);
  const keyringService = declared(servicePick) || DEFAULT_KEYRING_SERVICE;
  const tenantSlug = declared(slugPick);
  const tenantLabel = tenantId || tenantSlug || null;
  const sources = {
    'hub.tenant-id': tenantIdPick.source,
    'hub.account': accountPick.source,
    'specoe.tenant': slugPick.source,
  };

  const fail = (reason) => ({ ok: false, kind: 'no-room-identity', roomDir, tenantLabel, reason });

  if (!roomDir) return fail('la sesion no informa la carpeta del room (ni CLAUDE_PROJECT_DIR ni cwd)');

  let mode;
  if (account) {
    if (!tenantId) {
      return fail(`el room declara hub.account (${account}) pero no hub.tenant-id`);
    }
    mode = 'personal';
  } else if (tenantSlug) {
    mode = 'sdd';
  } else if (tenantId) {
    return fail(
      `el room declara hub.tenant-id (${tenantId}) pero ninguna identidad: falta hub.account ` +
        '(cuenta personal) o specoe.tenant (identidad SDD)',
    );
  } else {
    return fail(`el room ${roomDir} no declara su identidad Hub`);
  }

  // URL: env > room > (solo canal personal) la URL que el keyring guarda para ESA cuenta.
  let hubUrl = null;
  let hubUrlSource = null;
  const fromEnv = process.env.INTEGRA_HUB_URL || process.env.INTEGRA_HUB_API_URL;
  const urlPick = pick('hub', 'api-url');
  if (fromEnv && fromEnv.trim()) {
    hubUrl = stripTrailingSlash(fromEnv);
    hubUrlSource = 'env';
  } else if (declared(urlPick)) {
    hubUrl = stripTrailingSlash(urlPick.value);
    hubUrlSource = urlPick.source;
  } else if (mode === 'personal') {
    const fromKeyring = await readSecret(`${keyringService}:url`, account);
    if (fromKeyring) {
      hubUrl = stripTrailingSlash(fromKeyring);
      hubUrlSource = `keyring ${keyringService}:url`;
    }
  }

  const cacheKey = hubUrl ? sha16(`${hubUrl}|${mode}|${tenantLabel}`) : null;

  return {
    ok: true,
    mode,
    roomDir,
    tenantId,
    tenantSlug,
    tenantLabel,
    account,
    keyringService,
    hubUrl,
    hubUrlSource,
    cacheKey,
    sources,
  };
}

async function readSecret(service, name) {
  const secrets = await importSibling('secrets.mjs');
  if (!secrets || typeof secrets.getSecret !== 'function') return null;
  try {
    return (await secrets.getSecret(service, name)) || null;
  } catch {
    return null;
  }
}

// ----- JWT -----

/** Payload de un JWT SIN verificar la firma: solo se lee el claim `tenantId` y el `exp`. */
export function decodeJwtPayload(jwt) {
  const parts = String(jwt ?? '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function expMsOf(jwt) {
  const payload = decodeJwtPayload(jwt);
  return payload && typeof payload.exp === 'number' ? payload.exp * 1000 : null;
}

const REFRESH_SLACK_MS = 60_000;

function vigente(expMs) {
  return typeof expMs === 'number' && Date.now() + REFRESH_SLACK_MS < expMs;
}

// ----- canal personal (SPEC-0005, con tenant) -----

function sessionsDir() {
  return path.join(os.homedir(), '.claude', 'integra-hub-sessions');
}

function sessionFileOf(identity) {
  return path.join(
    sessionsDir(),
    `${sha16(`${identity.hubUrl}|${identity.account}|${identity.tenantId}`)}.json`,
  );
}

async function readPassword(identity) {
  // El env solo cuenta si es de ESTA cuenta: un INTEGRA_HUB_EMAIL heredado de otra sesion no
  // puede volverse la identidad del room.
  const envEmail = process.env.INTEGRA_HUB_EMAIL;
  const envPassword = process.env.INTEGRA_HUB_PASSWORD;
  if (envEmail && envPassword && envEmail.trim().toLowerCase() === identity.account.toLowerCase()) {
    return { password: envPassword, source: 'env INTEGRA_HUB_PASSWORD' };
  }
  const fromKeyring = await readSecret(identity.keyringService, identity.account);
  if (fromKeyring) return { password: fromKeyring, source: `keyring ${identity.keyringService}` };
  return null;
}

/** Acepta una respuesta de login/refresh SOLO si el JWT es del tenant del room. */
function acceptSession(body, tenantId, origen) {
  if (!body || !body.accessToken) return { ok: false, reason: `${origen} no devolvio accessToken` };
  const claim = decodeJwtPayload(body.accessToken)?.tenantId;
  if (claim !== tenantId || (body.tenantId !== undefined && body.tenantId !== tenantId)) {
    return {
      ok: false,
      kind: 'tenant-mismatch',
      reason: `${origen} devolvio una sesion del tenant '${claim ?? body.tenantId ?? '?'}' y el room declara '${tenantId}' — se descarto sin usarla`,
    };
  }
  return {
    ok: true,
    session: {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken ?? null,
      accessExpMs: expMsOf(body.accessToken),
      refreshExpMs: body.refreshToken ? expMsOf(body.refreshToken) : null,
    },
  };
}

async function errorCode(res) {
  try {
    const body = await res.json();
    return body && (body.code || body.message) ? ` (${body.code || body.message})` : '';
  } catch {
    return '';
  }
}

async function postAuth(identity, ruta, payload, signal) {
  const res = await fetch(`${identity.hubUrl}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    return { ok: false, reason: `POST ${ruta} respondio ${res.status}${await errorCode(res)}` };
  }
  return acceptSession(await res.json().catch(() => null), identity.tenantId, `POST ${ruta}`);
}

async function loadCachedSession(identity) {
  try {
    const raw = JSON.parse(await readFile(sessionFileOf(identity), 'utf8'));
    // El archivo se nombra por hash; se re-verifica el contenido igual. Una sesion cacheada que
    // no es de (url, cuenta, tenant) —o cuyo JWT no es del tenant— no se usa.
    if (
      raw.hubUrl !== identity.hubUrl ||
      raw.account !== identity.account ||
      raw.tenantId !== identity.tenantId ||
      decodeJwtPayload(raw.accessToken)?.tenantId !== identity.tenantId
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

async function saveCachedSession(identity, session) {
  try {
    await mkdir(sessionsDir(), { recursive: true });
    await writeFile(
      sessionFileOf(identity),
      JSON.stringify(
        {
          hubUrl: identity.hubUrl,
          account: identity.account,
          tenantId: identity.tenantId,
          ...session,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    // El cache es una comodidad: sin el, cada proceso loguea.
  }
}

async function dropCachedSession(identity) {
  try {
    await unlink(sessionFileOf(identity));
  } catch {
    /* no estaba */
  }
}

/** Token del tenant del room: cache vigente → refresh → login. Nunca devuelve otro tenant. */
async function acquirePersonalToken(identity, password, signal, { force = false } = {}) {
  if (!force) {
    const cached = await loadCachedSession(identity);
    if (cached && vigente(cached.accessExpMs)) return { ok: true, token: cached.accessToken };
    if (cached && cached.refreshToken && vigente(cached.refreshExpMs)) {
      const refreshed = await postAuth(
        identity,
        '/auth/refresh',
        { refreshToken: cached.refreshToken },
        signal,
      );
      if (refreshed.ok) {
        await saveCachedSession(identity, refreshed.session);
        return { ok: true, token: refreshed.session.accessToken };
      }
      if (refreshed.kind === 'tenant-mismatch') {
        await dropCachedSession(identity);
        return refreshed;
      }
      // Refresh vencido o revocado: se cae al login, que es la misma cuenta y el mismo tenant.
    }
  }
  const logged = await postAuth(
    identity,
    '/auth/login',
    { email: identity.account, password, tenantId: identity.tenantId },
    signal,
  );
  if (!logged.ok) return logged;
  await saveCachedSession(identity, logged.session);
  return { ok: true, token: logged.session.accessToken };
}

async function openPersonalChannel(identity, signal) {
  const channelLabel = `canal personal (cuenta ${identity.account})`;
  const base = { channelLabel, tenantLabel: identity.tenantLabel, roomDir: identity.roomDir };

  // La credencial se lee ANTES de cualquier request: sin el password de ESTA cuenta no se llama
  // al Hub con nada.
  const cred = await readPassword(identity);
  if (!cred) {
    return {
      ok: false,
      kind: 'no-identity',
      ...base,
      hubUrl: identity.hubUrl,
      reason: `no hay password de ${identity.account} en el keyring (${identity.keyringService}) ni en INTEGRA_HUB_EMAIL/PASSWORD`,
    };
  }

  let token;
  try {
    const got = await acquirePersonalToken(identity, cred.password, signal);
    if (!got.ok) {
      return { ok: false, kind: got.kind || 'no-identity', ...base, hubUrl: identity.hubUrl, reason: got.reason };
    }
    token = got.token;
  } catch (err) {
    // Red caida o abort durante el login: se devuelve tipado para que el hook no lo confunda con
    // "no hay identidad" —ni al reves—. El llamador decide como lo reporta.
    return {
      ok: false,
      kind: err && err.name === 'AbortError' ? 'timeout' : 'network',
      ...base,
      hubUrl: identity.hubUrl,
      reason: `no se pudo abrir la sesion contra ${identity.hubUrl} (${err && err.message})`,
    };
  }

  const send = (p, init, bearer) =>
    fetch(`${identity.hubUrl}${p}`, {
      ...(init || {}),
      headers: {
        'Content-Type': 'application/json',
        ...((init && init.headers) || {}),
        Authorization: `Bearer ${bearer}`,
      },
    });

  return {
    ok: true,
    kind: 'personal',
    ...base,
    tenantId: identity.tenantId,
    hubUrl: identity.hubUrl,
    cacheKey: identity.cacheKey,
    describe: () => `${channelLabel}, tenant ${identity.tenantId}`,
    fetch: async (p, init) => {
      const res = await send(p, init, token);
      if (res.status !== 401) return res;
      // 401 → la sesion cacheada pudo haber sido revocada: UN relogin, con la misma cuenta y el
      // mismo tenant, y un solo reintento.
      await dropCachedSession(identity);
      const again = await acquirePersonalToken(identity, cred.password, init && init.signal, {
        force: true,
      });
      if (!again.ok) return res;
      token = again.token;
      return send(p, init, token);
    },
  };
}

// ----- canal SDD -----

// El material NO se lee con `getSecret` y nombres pelados: se lee con
// `readIdentityMaterialScoped()`, que es el punto unico del starter y el unico que resuelve el
// scope por tenant. TKT-0498: el slug se le pasa EXPLICITO, el que declara el room
// (`specoe.tenant`), y no el que resuelva el entorno (`INTEGRA_SDD_TENANT` de otra ventana, o "la
// unica identidad del equipo"): asi el material de otro tenant, o el legacy sin scope, no se lee.
async function resolveSddIdentity(identity) {
  const role = process.env.INTEGRA_SDD_ROLE;
  if (!role) return { ok: false, reason: 'sin INTEGRA_SDD_ROLE en el entorno de la sesion' };

  const sdd = await importSibling('sdd-identity.mjs');
  if (!sdd || typeof sdd.readIdentityMaterialScoped !== 'function') {
    return { ok: false, reason: 'falta sdd-identity.mjs en ~/.claude/hooks/' };
  }

  let material;
  try {
    material = await sdd.readIdentityMaterialScoped({ tenantSlug: identity.tenantSlug });
  } catch (err) {
    return { ok: false, reason: `no se pudo leer el canal de identidad (${err && err.message})` };
  }

  // `notice` no-null significa que hay algo que decirle al dev y NADA que leer. Se propaga
  // textual: el aviso ya esta redactado como accion.
  if (material.notice) return { ok: false, reason: material.notice };
  if (!material.present) {
    return {
      ok: false,
      reason: `no hay login SDD en este equipo para el tenant ${identity.tenantSlug} (falta user-token o machine-id)`,
    };
  }
  if (material.tenantSlug && material.tenantSlug !== identity.tenantSlug) {
    return {
      ok: false,
      kind: 'tenant-mismatch',
      reason: `el material SDD leido es del tenant '${material.tenantSlug}' y el room declara '${identity.tenantSlug}'`,
    };
  }

  // El fingerprint sale del colector canonico del starter, no de una copia local: el backend lo
  // hashea campo por campo y UN solo campo distinto da MACHINE_FINGERPRINT_MISMATCH.
  const fingerprint = await sdd.collectSddFingerprint();
  return {
    ok: true,
    role,
    token: material.userToken,
    machineId: material.machineId,
    tenantSlug: identity.tenantSlug,
    fingerprint,
  };
}

// Los DOS headers van en CADA request autenticado, y tambien en el reintento posterior a un
// re-canje: `SddIdentityGuard` compone tres condiciones AND por request y es fail-closed. Firmar
// solo con `Authorization` es el defecto de TKT-0308, donde todas las llamadas del plugin
// rebotaban con 403 MACHINE_NOT_AUTHORIZED contra un canje que habia salido bien.
function buildSddHeaders(session) {
  const machineHeader = `${session.machineId}.${Buffer.from(
    JSON.stringify(session.fingerprint),
    'utf8',
  ).toString('base64url')}`;
  return {
    Authorization: `Bearer ${session.accessToken}`,
    'x-sdd-role': session.role,
    'x-sdd-machine': machineHeader,
  };
}

// El POST de derivacion NO lleva los headers de identidad: es pre-auth y el guard es
// transparente ahi. Mandarlos no rompe, pero declararlo evita que alguien los "arregle".
async function deriveSddSession(hubUrl, sdd, signal) {
  const res = await fetch(`${hubUrl}/auth/sdd/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: sdd.token,
      machineId: sdd.machineId,
      fingerprint: sdd.fingerprint,
    }),
    signal,
  });
  if (!res.ok) {
    return { ok: false, reason: `POST /auth/sdd/session respondio ${res.status}${await errorCode(res)}` };
  }
  const body = await res.json().catch(() => null);
  const accessToken = body && body.accessToken;
  if (!accessToken) return { ok: false, reason: 'POST /auth/sdd/session no devolvio accessToken' };
  return { ok: true, accessToken };
}

async function openSddChannel(identity, signal) {
  const channelLabel = `canal SDD (tenant ${identity.tenantSlug})`;
  const base = { channelLabel, tenantLabel: identity.tenantLabel, roomDir: identity.roomDir };

  const sdd = await resolveSddIdentity(identity);
  if (!sdd.ok) {
    return { ok: false, kind: sdd.kind || 'no-identity', ...base, hubUrl: identity.hubUrl, reason: sdd.reason };
  }

  let derived;
  try {
    derived = await deriveSddSession(identity.hubUrl, sdd, signal);
  } catch (err) {
    return {
      ok: false,
      kind: err && err.name === 'AbortError' ? 'timeout' : 'network',
      ...base,
      hubUrl: identity.hubUrl,
      reason: `no se pudo derivar la sesion SDD contra ${identity.hubUrl} (${err && err.message})`,
    };
  }
  // La derivacion puede fallar sola —token revocado, equipo no aprobado, fingerprint corrido— y
  // en ese momento todavia no se mando ningun request al endpoint real. No hay a quien caerle.
  if (!derived.ok) {
    return { ok: false, kind: 'no-identity', ...base, hubUrl: identity.hubUrl, reason: derived.reason };
  }

  // Si el room declara ademas el Tenant.id, el claim del JWT derivado tiene que ser ese.
  const claim = decodeJwtPayload(derived.accessToken)?.tenantId ?? null;
  if (identity.tenantId && claim !== identity.tenantId) {
    return {
      ok: false,
      kind: 'tenant-mismatch',
      ...base,
      hubUrl: identity.hubUrl,
      reason: `la sesion SDD derivada es del tenant '${claim ?? '?'}' y el room declara '${identity.tenantId}' — se descarto sin usarla`,
    };
  }

  const session = { ...sdd, accessToken: derived.accessToken };
  return {
    ok: true,
    kind: 'sdd',
    ...base,
    tenantId: claim,
    hubUrl: identity.hubUrl,
    cacheKey: identity.cacheKey,
    describe: () => `sesion SDD (rol ${sdd.role}, tenant ${identity.tenantSlug})`,
    // Los headers de identidad van DESPUES del spread de `init.headers`, a proposito: son los que
    // no se pueden pisar.
    fetch: (p, init) =>
      fetch(`${identity.hubUrl}${p}`, {
        ...(init || {}),
        headers: {
          'Content-Type': 'application/json',
          ...((init && init.headers) || {}),
          ...buildSddHeaders(session),
        },
      }),
  };
}

// ----- resolucion del canal -----

let cachedChannel = null;

/**
 * Resuelve el canal una vez por proceso.
 *
 * Devuelve:
 *   { ok: true, kind: 'personal'|'sdd', tenantId, tenantLabel, hubUrl, cacheKey, channelLabel,
 *     fetch(path, init), describe() }
 *   { ok: false, kind: 'no-room-identity'|'no-identity'|'tenant-mismatch'|'network'|'timeout',
 *     reason, tenantLabel, channelLabel, roomDir, hubUrl }
 *
 * `only: 'personal'` exige la credencial personal (responder-consulta: una respuesta firmada
 * por un rol de maquina es lo que el backend rechaza) y nunca resuelve SDD.
 *
 * Sin `ok` NO salio ningun request con otra identidad: o no salio ninguno, o salio el login/
 * derivacion de la identidad declarada y su sesion se descarto.
 */
export async function resolveHubChannel({ cwd = process.cwd(), signal, only } = {}) {
  if (cachedChannel) return cachedChannel;
  cachedChannel = await resolveHubChannelUncached({ cwd, signal, only });
  return cachedChannel;
}

async function resolveHubChannelUncached({ cwd, signal, only }) {
  const identity = await resolveRoomIdentity({ cwd });
  if (!identity.ok) return { ...identity, channelLabel: null, hubUrl: null };

  if (only === 'personal' && identity.mode !== 'personal') {
    return {
      ok: false,
      kind: 'no-identity',
      roomDir: identity.roomDir,
      tenantLabel: identity.tenantLabel,
      channelLabel: null,
      hubUrl: identity.hubUrl,
      reason: `el room no declara una cuenta personal (hub.account) y este hook no admite la identidad SDD`,
    };
  }

  if (!identity.hubUrl) {
    return {
      ok: false,
      kind: 'no-identity',
      roomDir: identity.roomDir,
      tenantLabel: identity.tenantLabel,
      channelLabel: null,
      hubUrl: null,
      reason: 'no se pudo resolver la URL del Hub (ni INTEGRA_HUB_URL, ni hub.api-url del room, ni la del keyring de la cuenta)',
    };
  }

  // El CA recien cuando va a haber red: un room sin identidad no paga ni eso.
  await applyCaChannelOnce();

  return identity.mode === 'personal'
    ? openPersonalChannel(identity, signal)
    : openSddChannel(identity, signal);
}

// ----- canal TLS -----

let caApplied = false;

async function applyCaChannelOnce() {
  if (caApplied) return;
  caApplied = true;
  const ca = await importSibling('ca-channel.mjs');
  if (!ca || typeof ca.applyCaChannel !== 'function') return;
  try {
    ca.applyCaChannel();
  } catch {
    // Una maquina sin root local (Hub con certificado publico) no necesita el canal y el
    // store default alcanza. El fracaso de aplicarlo no es evidencia de nada.
  }
}

/**
 * Mensaje accionable para el dev cuando NO hay canal. Se centraliza aca para que todos los hooks
 * digan lo mismo: el modo de falla que TKT-0321 vino a cerrar fue justamente un hook culpando a
 * la red por una identidad ausente. TKT-0498: nombra el canal y el tenant consultados, y dice que
 * no se llamo con ninguna otra identidad.
 */
export function noChannelMessage(hookName, channel) {
  const tenant = channel.tenantLabel || 'ninguno (el room no lo declara)';
  const canal = channel.channelLabel || 'ninguno';
  const room = channel.roomDir || '<room>';
  if (channel.kind === 'network' || channel.kind === 'timeout') {
    return [
      `${hookName}: el Hub no respondio al abrir la sesion — ${channel.reason}.`,
      `Canal: ${canal} · tenant consultado: ${tenant}.`,
    ].join('\n');
  }
  return [
    `${hookName}: no hay canal de identidad hacia el Hub — ${channel.reason}.`,
    `Canal: ${canal} · tenant consultado: ${tenant} · room: ${room}.`,
    'Esto NO es un problema de red: el hook no tiene con que autenticarse para el tenant del room,',
    'y no llamo al Hub con ninguna otra identidad (TKT-0498).',
    'Como salir:',
    `  1. Dev de un tenant (identidad SDD):  ./setup.sh --login   (desde la carpeta del room; escribe specoe.tenant)`,
    '  2. Si la instalacion quedo vieja:     ./specoe-setup-host.sh   (parte de maquina, pisa el bundle)',
    `  3. Room del equipo Integra: declarar en ${path.join(room, ROOM_LOCAL_CONFIG)}`,
    "       hub:\n         tenant-id: '<Tenant.id>'\n         account: '<email de la cuenta>'",
    '     y el password de esa cuenta: node ~/.claude/scripts/migrate-hub-credentials.mjs',
  ].join('\n');
}

/** Solo para la suite: descarta el canal resuelto de este proceso. */
export function _resetChannelCache() {
  cachedChannel = null;
  caApplied = false;
}

/** Solo para la suite: la resolucion de URL sin efectos, para poder medirla sola. */
export const _internals = {
  resolveHubUrl,
  readHubUrlFromRoom,
  buildSddHeaders,
  sessionFileOf,
  homedir: os.homedir,
};

// ----- CLI: el tenant del room, para los hooks que no son Node (TKT-0498, Telegram) -----
//
// `node hub-channel.mjs --room-tenant [<dir>]` imprime el tenant que declara el room (el
// `tenant-id` si esta, si no `specoe.tenant`) y sale 0; sin declaracion, no imprime nada y sale 1.
// Sin red. El room es <dir>, o `CLAUDE_PROJECT_DIR`, o el cwd del proceso.
function esEntrypoint() {
  try {
    if (!process.argv[1]) return false;
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (esEntrypoint() && process.argv[2] === '--room-tenant') {
  const dir = process.argv[3] || undefined;
  const identity = dir
    ? await resolveRoomIdentityAt(dir)
    : await resolveRoomIdentity({ cwd: process.cwd() });
  if (identity.ok && identity.tenantLabel) {
    process.stdout.write(identity.tenantLabel);
    process.exit(0);
  }
  process.exit(1);
}

/** El room EXPLICITO, sin mirar CLAUDE_PROJECT_DIR: lo usa el CLI cuando recibe la carpeta. */
async function resolveRoomIdentityAt(dir) {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    return await resolveRoomIdentity({ cwd: dir });
  } finally {
    if (saved !== undefined) process.env.CLAUDE_PROJECT_DIR = saved;
  }
}
