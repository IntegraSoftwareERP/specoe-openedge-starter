// TKT-0321 — canal UNICO de los hooks del Hub hacia el Hub.
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
// ----- LOS DOS CANALES, EN ESTE ORDEN -----
//
//   1. Legacy (SPEC-0005) — `integra-hub-auth.mjs` con email/password. Se declara presente solo
//      si `getCredentials()` RESUELVE, no si el archivo existe.
//   2. SDD (modo USER de SPEC-0157) — material del keyring via `sdd-identity.mjs`, derivacion con
//      POST /auth/sdd/session. Es el unico canal vivo en la maquina de un dev de tenant.
//
// ----- POR QUE LEGACY PRIMERO, SI EL SDD ES EL CANAL DEL FUTURO -----
//
// Porque este ticket es de DISTRIBUCION y no de migracion, y el orden inverso cambiaria el
// comportamiento de las maquinas donde el gate hoy funciona. En una maquina del equipo parada en
// un room conviven las dos identidades (los launchers exportan `INTEGRA_SDD_ROLE`), asi que
// preferir SDD movería a la sesion SDD llamadas que hoy salen con el Bearer humano — entre ellas
// `/tenants/me/policy`, `/task-ack-session/active` y `/telemetry/event`, que SPEC-0166 P4b dejo
// deliberadamente FUERA del canal de identidad y cuya suite lo verifica request por request.
//
// Con legacy primero: la maquina que hoy anda no cambia en nada, y la que no tenia canal —la del
// dev del tenant, que no tiene credenciales legacy y nunca las va a tener— pasa a tener uno.
// Migrar el resto al canal SDD es una decision aparte, con su propia medicion.
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
import { readFile } from 'node:fs/promises';

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

// ----- URL del Hub -----

// Misma precedencia que `specoe-license-check.mjs` (env > project.config.yaml), mas las dos
// fuentes que existen del lado del equipo. No se inventa configuracion nueva: cada eslabon es
// una fuente que YA usa alguien.
//
//   1. INTEGRA_HUB_URL      — la que documenta el gate de licencia del starter.
//   2. INTEGRA_HUB_API_URL  — la que el .mcp.json del room le pasa al MCP.
//   3. hub.api-url del project.config.yaml del cwd — la del room, cuando el hook corre adentro.
//   4. credentials.mjs      — la del modelo legacy (maquinas del equipo).
export async function resolveHubUrl(cwd) {
  const fromEnv = process.env.INTEGRA_HUB_URL || process.env.INTEGRA_HUB_API_URL;
  if (fromEnv) return { url: stripTrailingSlash(fromEnv), source: 'env' };

  const fromYaml = await readHubUrlFromYaml(cwd);
  if (fromYaml) return { url: stripTrailingSlash(fromYaml), source: 'project.config.yaml' };

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

// Parser minimo, mismo criterio que el del hook de licencia: la unica clave `api-url:` del yaml
// vive bajo `hub:`. No se agrega dep de YAML a un hook que corre con 5 segundos de presupuesto.
async function readHubUrlFromYaml(cwd) {
  if (!cwd) return null;
  try {
    const yaml = await readFile(path.join(cwd, 'project.config.yaml'), 'utf8');
    const m = yaml.match(/^\s*api-url:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ----- canal SDD -----

// El material NO se lee con `getSecret` y nombres pelados: se lee con
// `readIdentityMaterialScoped()`, que es el punto unico del starter y el unico que resuelve el
// scope por tenant (`INTEGRA_SDD_TENANT` declarado / una sola identidad / legacy sin scope /
// ambiguo). Leer los nombres pelados es el camino LEGACY solamente: en un equipo con identidad
// scoped devuelve null y el canal se declararia ausente teniendo material.
async function resolveSddIdentity() {
  const role = process.env.INTEGRA_SDD_ROLE;
  if (!role) return { ok: false, reason: 'sin INTEGRA_SDD_ROLE en el entorno de la sesion' };

  const identity = await importSibling('sdd-identity.mjs');
  if (!identity || typeof identity.readIdentityMaterialScoped !== 'function') {
    return { ok: false, reason: 'falta sdd-identity.mjs en ~/.claude/hooks/' };
  }

  let material;
  try {
    material = await identity.readIdentityMaterialScoped();
  } catch (err) {
    return { ok: false, reason: `no se pudo leer el canal de identidad (${err && err.message})` };
  }

  // `notice` no-null significa que hay algo que decirle al dev y NADA que leer — el caso
  // tipico es el equipo con identidad de varios tenants y la sesion sin declarar cual. Se
  // propaga textual: el aviso ya esta redactado como accion.
  if (material.notice) return { ok: false, reason: material.notice };
  if (!material.present) {
    return { ok: false, reason: 'no hay login SDD en este equipo (falta user-token o machine-id)' };
  }

  // El fingerprint sale del colector canonico del starter, no de una copia local: el backend lo
  // hashea campo por campo y UN solo campo distinto da MACHINE_FINGERPRINT_MISMATCH.
  const fingerprint = await identity.collectSddFingerprint();
  return {
    ok: true,
    role,
    token: material.userToken,
    machineId: material.machineId,
    tenantSlug: material.tenantSlug,
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
async function deriveSddSession(hubUrl, identity, signal) {
  const res = await fetch(`${hubUrl}/auth/sdd/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: identity.token,
      machineId: identity.machineId,
      fingerprint: identity.fingerprint,
    }),
    signal,
  });
  if (!res.ok) {
    let code = '';
    try {
      const body = await res.json();
      code = body && (body.code || body.message) ? ` (${body.code || body.message})` : '';
    } catch {
      /* cuerpo ilegible: alcanza con el status */
    }
    return { ok: false, reason: `POST /auth/sdd/session respondio ${res.status}${code}` };
  }
  const body = await res.json().catch(() => null);
  const accessToken = body && body.accessToken;
  if (!accessToken) return { ok: false, reason: 'POST /auth/sdd/session no devolvio accessToken' };
  return { ok: true, accessToken };
}

// ----- resolucion del canal -----

let cachedChannel = null;

/**
 * Resuelve el canal una vez por proceso.
 *
 * Devuelve:
 *   { ok: true, kind: 'legacy'|'sdd', fetch(path, init), describe() }
 *   { ok: false, kind: 'no-identity', reason, hubUrl }
 *
 * `fetch` recibe el path relativo del Hub (`/tasks/pending?...`), igual que `hubFetch`, asi que
 * los llamadores no cambian sus URLs. Nunca tira: los errores de red los ve el llamador como
 * excepcion de `fetch`, que es lo que su wrapper con deadline ya clasifica.
 *
 * Los dos canales son EXCLUYENTES por resolucion: se devuelve el primero que resuelve y no hay
 * reintento cruzado. El "UN solo fallback" de SPEC-0166 P4b sigue viviendo adentro del hook de
 * arranque, que es donde tiene sentido — ahi el fallback es entre DOS FORMAS DE PEDIR LO MISMO
 * (con y sin identidad declarada), no entre dos canales de autenticacion.
 */
export async function resolveHubChannel({ cwd = process.cwd(), signal } = {}) {
  if (cachedChannel) return cachedChannel;
  cachedChannel = await resolveHubChannelUncached({ cwd, signal });
  return cachedChannel;
}

async function resolveHubChannelUncached({ cwd, signal }) {
  await applyCaChannelOnce();

  const { url: hubUrl } = await resolveHubUrl(cwd);

  // Legacy primero: ver el bloque "POR QUE LEGACY PRIMERO" del encabezado.
  const legacyFirst = await resolveLegacyChannel();
  if (legacyFirst) return legacyFirst;

  const sdd = await resolveSddIdentity();

  if (sdd.ok) {
    if (!hubUrl) {
      return {
        ok: false,
        kind: 'no-identity',
        hubUrl: null,
        reason: 'hay identidad SDD pero no se pudo resolver la URL del Hub',
      };
    }
    const derived = await deriveSddSession(hubUrl, sdd, signal);
    if (derived.ok) {
      const session = { ...sdd, accessToken: derived.accessToken };
      return {
        ok: true,
        kind: 'sdd',
        describe: () =>
          `sesion SDD (rol ${sdd.role}${sdd.tenantSlug ? `, tenant ${sdd.tenantSlug}` : ''})`,
        // Los headers de identidad van DESPUES del spread de `init.headers`, a proposito: son
        // los que no se pueden pisar. Es la simetria inversa de `hubFetch`, cuyo Authorization
        // tambien va ultimo y por eso no se puede transportar una sesion SDD por adentro suyo.
        fetch: (p, init) =>
          fetch(`${hubUrl}${p}`, {
            ...(init || {}),
            headers: {
              'Content-Type': 'application/json',
              ...((init && init.headers) || {}),
              ...buildSddHeaders(session),
            },
          }),
      };
    }
    // La derivacion puede fallar sola —token revocado, equipo no aprobado, fingerprint
    // corrido— y en ese momento todavia no se mando ningun request al endpoint real. No hay a
    // quien caerle: el legacy ya se probo arriba y no resolvio.
    return { ok: false, kind: 'no-identity', hubUrl, reason: derived.reason };
  }

  return { ok: false, kind: 'no-identity', hubUrl, reason: sdd.reason };
}

// Canal legacy: se declara presente solo si `getCredentials()` RESUELVE. Preguntar unicamente si
// el modulo existe es lo que producia el exit 2 con mensaje de red — el archivo estaba y las
// credenciales no.
async function resolveLegacyChannel() {
  const auth = await importSibling('integra-hub-auth.mjs');
  if (!auth || typeof auth.hubFetch !== 'function') return null;

  const creds = await importSibling('credentials.mjs');
  if (!creds || typeof creds.getCredentials !== 'function') return null;
  try {
    const c = await creds.getCredentials();
    if (!c || !c.url) return null;
  } catch {
    return null;
  }

  return {
    ok: true,
    kind: 'legacy',
    describe: () => 'credenciales SPEC-0005 (email/password)',
    fetch: (p, init) => auth.hubFetch(p, init),
  };
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
 * Mensaje accionable para el dev cuando NO hay canal. Se centraliza aca para que los dos hooks
 * digan lo mismo: el modo de falla que TKT-0321 vino a cerrar fue justamente un hook culpando a
 * la red por una identidad ausente.
 */
export function noChannelMessage(hookName, channel) {
  return [
    `${hookName}: no hay canal de identidad hacia el Hub — ${channel.reason}.`,
    'Esto NO es un problema de red: el hook no tiene con que autenticarse.',
    'Como salir, en la maquina del dev:',
    '  1. Identidad SDD (dev de un tenant):  ./setup.sh --login   (desde la carpeta del room)',
    '  2. Si la instalacion quedo vieja:     ./specoe-setup-host.sh   (parte de maquina, pisa el bundle)',
    '  3. Equipo Integra (modelo SPEC-0005): node ~/.claude/scripts/migrate-hub-credentials.mjs',
  ].join('\n');
}

/** Solo para la suite: descarta el canal resuelto de este proceso. */
export function _resetChannelCache() {
  cachedChannel = null;
  caApplied = false;
}

/** Solo para la suite: la resolucion de URL sin efectos, para poder medirla sola. */
export const _internals = { resolveHubUrl, readHubUrlFromYaml, buildSddHeaders, homedir: os.homedir };
