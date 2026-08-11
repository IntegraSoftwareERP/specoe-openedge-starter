#!/usr/bin/env node
// Session start hook para validar licencia SpecOE.
//
// Se registra en ~/.claude/settings.json como SessionStart hook.
// Flujo:
//   1. Lee license key del keyring o de env var SPECOE_LICENSE_KEY.
//   2. Genera machine fingerprint local (hostname, os, cpuModel, pseudo-diskSerial).
//   2b. Resuelve el userId del seat del canal de secretos (sdd-identity.mjs) y lo manda
//      como `userContext` en el validate. TKT-0232: en USER-mode el claim `sddRole` del
//      JWT deriva de los UserSddRole de ESE usuario y la derivacion es fail-closed —
//      mandar el body sin ese campo emite un JWT SIN claim, y el skill-server sirve el
//      bundle PRODUCTO. En MACHINE-mode el Hub lo ignora: no hay que decidir el modo aca.
//   2c. Lee el rol que la carpeta DECLARA de INTEGRA_SDD_ROLE y lo manda como
//      `declaredRole` en el MISMO validate. SPEC-0176 P2: el Hub lo AUTORIZA contra los
//      UserSddRole del usuario (nunca lo acepta), y devuelve `roleResolution` con el
//      veredicto. Un rol no concedido ya no es silencio: sale por mensaje de sesion.
//   3. POST /api/v1/license/validate al Hub.
//   4. Si OK -> setea SPECOE_TIER / SPECOE_TOKEN / SPECOE_FEATURES en el entorno
//      (via output JSON que Claude Code lee) y cachea resultado en ~/.claude/specoe-license-cache.json.
//   5. Si falla la red: si cache < offlineGraceHours (tier), usar cache (grace period).
//   6. Si cache stale: degrada — solo skills libres accesibles (sin SPECOE_TOKEN).
//
// CONTRATO DE SALIDA (SPEC-0164 P2 / ADR-002 — decision del Operador sobre Q8):
// el hook YA NO sale 0 siempre. Bloquea el arranque UNICAMENTE cuando no hay cache de
// grace: cache dentro de las 24 h => arranca con mensaje visible; cache ausente o stale =>
// corta con exit 2. Distingue el corte de red pasajero de la instalacion que nunca
// funciono. El bloqueo lleva SIEMPRE los cuatro datos (errno real, URL resuelta con su
// fuente, fuente de CA que gano, accion concreta) mas la via de escape ejecutable:
// bloquear sin decir por que no es el fix, y un bloqueo mudo aborta el bloqueo
// (blockSession() vuelve a exit 0 antes que cortar sin diagnostico).
// Un error no manejado sigue saliendo 0: nunca bloqueamos por un bug nuestro.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyCaChannel, describeNetworkError, DEFAULT_CA_PATH } from './ca-channel.mjs';
import {
  resolveUserContext,
  resolveSessionTenant,
  readIdentityMaterialScoped,
  scopedName,
} from './sdd-identity.mjs';
import { loadKeyring, loadMachineId } from './vendor-deps.mjs';

const execFileAsync = promisify(execFile);

// Presupuesto del hook: settings.json le da 5s (SessionStart). Los dos fetch al Hub
// llevan deadline propio calculado sobre lo que queda de ese presupuesto — sin esto
// quedaban a merced del connectTimeout de undici (10s), el doble del presupuesto, y el
// harness mataba el proceso antes de que llegara a loguear por que fallo.
const HOOK_BUDGET_MS = Number.parseInt(process.env.SPECOE_LICENSE_TIMEOUT_MS || '4500', 10);
const STARTED_AT = Date.now();
const MIN_FETCH_MS = 500;
const MAX_FETCH_MS = 2000;

function fetchDeadlineMs() {
  const left = HOOK_BUDGET_MS - (Date.now() - STARTED_AT);
  return Math.max(MIN_FETCH_MS, Math.min(MAX_FETCH_MS, left));
}

// TKT-0232 — presupuesto MINIMO que tiene que quedar para intentar DERIVAR el userContext
// (el canje /auth/sdd/session). Leerlo del canal no cuesta red y no pasa por aca; derivarlo
// es un tercer request, y gastarlo cuando ya no queda presupuesto se lleva puesto el
// validate — o sea cambiaria un room sin rol por un room sin licencia. Si no entra, se
// saltea: el proximo arranque lo intenta con el presupuesto entero, y el login normal ya
// deja el dato guardado (esta rama es solo para instalaciones anteriores al fix).
const MIN_DERIVE_BUDGET_MS = 2500;

// multi-rol — el .mcp.json, el project.config.yaml y el cache de
// licencia viven en el project dir (cwd de la sesion Claude Code). Claude Code expone
// CLAUDE_PROJECT_DIR a los hooks.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MCP_JSON_FILE = path.join(PROJECT_DIR, '.mcp.json');
const DEFAULT_SKILL_SERVER_URL =
  process.env.SPECOE_SKILL_SERVER_URL || 'https://mcp.integra.local/sse';

// multi-rol — cache POR-CARPETA (antes global en ~/.claude). Un dev con varios
// roles a la vez (uno por carpeta) tenia un unico cache global y el ultimo rol pisaba a
// los demas. Ahora cada carpeta cachea su propia licencia + JWT.
const CACHE_FILE = path.join(PROJECT_DIR, '.claude', 'specoe-license-cache.json');
const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');
// la URL del Hub ya NO es un hardcode fijo: se resuelve en runtime
// (env > project.config.yaml > este fallback interno). Ver resolveHubUrl().
const FALLBACK_HUB_URL = 'http://integra-hub:8100/api/v1';
const DEFAULT_GRACE_HOURS = 24;

// Via de escape del bloqueo (ADR-002). Dos formas porque el dev que la necesita puede
// estar en PowerShell, en cmd o en bash, y el mensaje tiene que funcionar en la misma
// corrida siguiendo SOLO lo que dice — sin doc y sin abrir el log.
export const ESCAPE_HATCH_ENV = 'SPECOE_ALLOW_DEGRADED_START';
const ESCAPE_HATCH_FILE = path.join(PROJECT_DIR, '.claude', 'specoe-allow-degraded-start');

// Mismo umbral que usa specoe-room-bootstrap.mjs para descartar el token del cache: el JWT
// de licencia vive 1 h (ACCESS_TOKEN_TTL_SECONDS) y a los 55 min ya no sirve para el
// skill-server. Un .mcp.json declarando `specoe` con un token de esa edad es la misma
// mentira que el placeholder sin expandir.
const SKILL_JWT_MAX_AGE_MS = 55 * 60 * 1000;

// ----- fingerprint generation (cliente-side) -----
// Composicion: machineId (node-machine-id) + cpuModel + cpuCount + diskSerial nativo.
// Hostname y os son audit-only (no participan del hash).

async function getMachineId() {
  try {
    // node-machine-id es CommonJS — dynamic import retorna { default: module.exports }.
    // TKT-0314 — sale del vendor del bundle; node_modules es solo el fallback.
    const mod = await loadMachineId();
    const lib = mod.default ?? mod;
    if (typeof lib.machineIdSync === 'function') {
      return lib.machineIdSync(true); // true = hex raw (sin hash interno de la lib)
    }
    if (typeof lib.machineId === 'function') {
      return await lib.machineId(true);
    }
    throw new Error('node-machine-id sin export reconocido');
  } catch {
    // Lib no instalada o falla — fallback determinista por hostname+user.
    return `fallback:${os.hostname()}:${os.userInfo().username}`;
  }
}

async function getDiskSerial() {
  try {
    if (process.platform === 'win32') {
      // wmic (legacy pero estable) — el nuevo `Get-CimInstance` requiere PowerShell
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
      // Primera bloque device no-removable (sda/nvme0n1 típico)
      const blocks = await fs.readdir('/sys/block');
      for (const name of blocks) {
        if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('sr')) continue;
        const serialPath = `/sys/block/${name}/device/serial`;
        try {
          const s = (await fs.readFile(serialPath, 'utf8')).trim();
          if (s) return s;
        } catch {
          /* ignore, probar siguiente */
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
    return ''; // Cualquier error → headless fallback
  }
}

async function computeLocalFingerprint() {
  const machineId = await getMachineId();
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const cpuCount = cpus.length || 1;
  const diskSerial = await getDiskSerial();
  return {
    machineId,
    cpuModel,
    cpuCount,
    diskSerial: diskSerial || undefined,
    hostname: os.hostname(),
    os: `${os.platform()} ${os.release()}`,
  };
}

// ----- cache helpers -----

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(data) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function isCacheWithinGrace(cache, graceHours) {
  if (!cache?.validatedAt) return false;
  const ageMs = Date.now() - new Date(cache.validatedAt).getTime();
  return ageMs < graceHours * 60 * 60 * 1000;
}

// ----- logging -----

async function logLine(obj) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `specoe-license-${today}.log`);
    await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    /* no romper por log */
  }
}

// ----- license key lookup -----

// multi-rol — rol SDD de la carpeta, leido del project.config.yaml del cwd. Es el
// account del keyring donde vive la licencia de ESTE rol (Entry specoe-license/<rol>).
// Vacio/ausente => modo 1-rol legacy (account 'default'). Parser minimo: la unica clave
// `role:` del yaml vive bajo `specoe:` y el rol es mayusculas.
async function resolveRole() {
  try {
    const yaml = await fs.readFile(path.join(PROJECT_DIR, 'project.config.yaml'), 'utf8');
    // Tolera comentario inline (el template trae `role: '' # DISCOVERY | ...`).
    const m = yaml.match(/^\s*role:\s*['"]?([A-Z_]+)['"]?\s*(#.*)?$/m);
    return m && m[1] ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// SPEC-0187 P7 — el tenant de ESTA carpeta. Precedencia: la env del selector (que exportan los
// launchers) > la clave `specoe.tenant` del yaml del room. Se lee tambien del yaml a proposito:
// una carpeta abierta a mano (doble click, `code .`) no tiene la env, y ahi el room igual sabe
// de que tenant es — sin esto, abrir sin launcher caeria al fallback legacy en una maquina
// multi-tenant, que es exactamente el pisado silencioso que la fase cierra.
// Parser minimo con el mismo criterio que `role:` y `api-url:`: la unica clave `tenant:` del
// yaml vive bajo `specoe:`.
async function resolveTenant() {
  const fromEnv = resolveSessionTenant();
  if (fromEnv) return fromEnv;
  try {
    const yaml = await fs.readFile(path.join(PROJECT_DIR, 'project.config.yaml'), 'utf8');
    const m = yaml.match(/^\s*tenant:\s*['"]?([^'"\n#]*?)['"]?\s*(#.*)?$/m);
    const value = m && m[1] ? m[1].trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Los accounts del keyring donde puede vivir la licencia de este room, en orden de prueba.
 *
 * SPEC-0187 P7 — con tenant declarado la lista NO contiene ningun account legacy: una licencia
 * guardada sin tenant pertenece a la instalacion anterior y puede ser de OTRO tenant. Caer a
 * ella seria el fallback silencioso que la fase cierra. Es funcion aparte y exportada porque el
 * criterio se verifica en la suite sin depender del keyring del SO.
 */
export function licenseAccountsFor(tenantSlug, role) {
  const accounts = tenantSlug
    ? [scopedName(tenantSlug, role), scopedName(tenantSlug, 'default')]
    : [role, 'default'];
  return accounts.filter(Boolean);
}

async function getLicenseKey(tenantSlug = null) {
  // 1. Env var
  if (process.env.SPECOE_LICENSE_KEY) return process.env.SPECOE_LICENSE_KEY;

  // 2. Keyring — multi-rol: account = rol de la carpeta; fallback 'default'
  //    (retrocompat 1-rol). getPassword tira si el account no existe → probamos uno a uno.
  //    SPEC-0187 P7 — con tenant declarado, los accounts son '<slug>:<ROL>' / '<slug>:default'
  //    y NO se prueban los legacy: una licencia de otro tenant no es una licencia de este.
  try {
    const kr = await loadKeyring().catch(() => null);
    if (kr) {
      const { Entry } = kr;
      const role = await resolveRole();
      for (const account of licenseAccountsFor(tenantSlug, role)) {
        try {
          const key = new Entry('specoe-license', account).getPassword();
          if (key) return key;
        } catch {
          /* account inexistente — probar el siguiente */
        }
      }
    }
  } catch {
    /* keyring no disponible */
  }

  // 3. Cache file de ultima validacion (retiene key para offline grace)
  //    SPEC-0187 P7 — el cache es POR CARPETA, pero una carpeta puede cambiar de tenant: si el
  //    room declara uno distinto del que valido esa key, el cache es de OTRO tenant y usarlo
  //    seria el fallback silencioso por la puerta de atras. Se descarta (el `tenantSlug` lo
  //    escribe el camino de validacion de mas abajo; un cache anterior a esta fase no lo tiene
  //    y sigue sirviendo para el room que nunca declaro tenant).
  const cache = await readCache();
  if (cache?.licenseKey) {
    if (!tenantSlug || !cache.tenantSlug || cache.tenantSlug === tenantSlug) {
      return cache.licenseKey;
    }
  }

  return null;
}

// ----- helpers: canal de CA + hub url + activate + skill jwt -----

// El canal de CA es UNO SOLO y vive en ca-channel.mjs. Aca solo se aplica y se loguea
// QUE hizo con el store del proceso — numeros verificables, no un veredicto.
// La linea de exito del canal se emite mas abajo, y solo cuando un request al Hub
// efectivamente llego: el mecanismo aplicado no prueba que el canal sirva.
// Fail-open: sin CA en disco seguimos con el trust default y queda registrado por que.
async function openCaChannel() {
  const r = applyCaChannel();
  if (r.ok) {
    await logLine({
      level: 'info',
      msg: 'canal de CA aplicado — store del proceso ampliado',
      caPath: r.caPath,
      subject: r.subject,
      storeBefore: r.storeBefore,
      storeAfter: r.storeAfter,
      system: r.system,
      bundled: r.bundled,
    });
  } else {
    await logLine({
      level: 'warn',
      msg: 'canal de CA NO aplicado',
      reason: r.reason,
      caPath: r.caPath ?? DEFAULT_CA_PATH,
      subject: r.subject,
      error: r.error,
    });
  }
  return r;
}

// fix #2 — resuelve la URL del Hub. Precedencia: env INTEGRA_HUB_URL >
// hub.api-url de project.config.yaml (del project dir) > fallback interno.
// Parser minimo sin dep: la unica clave `api-url:` del yaml vive bajo `hub:`.
// Devuelve tambien QUE fuente gano: `fetch failed` no distinguia "no llegue al Hub" de
// "le pegue al host equivocado", y reconstruirlo costo una corrida manual.
async function resolveHubUrl() {
  if (process.env.INTEGRA_HUB_URL) {
    return { url: process.env.INTEGRA_HUB_URL, source: 'env INTEGRA_HUB_URL' };
  }
  try {
    const yaml = await fs.readFile(path.join(PROJECT_DIR, 'project.config.yaml'), 'utf8');
    const m = yaml.match(/^\s*api-url:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    if (m && m[1]) return { url: m[1].trim(), source: 'project.config.yaml' };
  } catch {
    /* sin yaml en el project dir — cae al fallback */
  }
  return { url: FALLBACK_HUB_URL, source: 'fallback interno' };
}

// Contexto del proceso, una vez por corrida. Es el dato que hubiera cerrado el incidente
// de SPEC-0164 en la primera corrida en vez de en la decima: la version de Node nombra la
// causa (el fetch global de Node 26 ignora el dispatcher de undici) y el valor efectivo de
// NODE_EXTRA_CA_CERTS delata un path sin expandir o pisado por un tercero.
// El starter ya NO setea esa variable: lo que aparezca aca viene del sistema o del usuario.
async function logProcessContext() {
  await logLine({
    level: 'info',
    msg: 'contexto de proceso',
    nodeVersion: process.version,
    execPath: process.execPath,
    pid: process.pid,
    ppid: process.ppid,
    platform: `${process.platform} ${process.arch}`,
    nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS ?? null,
    nodeExtraCaCertsSetBy: process.env.NODE_EXTRA_CA_CERTS ? 'entorno externo al starter' : null,
    claudeProjectDir: process.env.CLAUDE_PROJECT_DIR ?? null,
    cwd: process.cwd(),
  });
}

// fix #1 — activa el fingerprint antes de validar. Idempotente por (licenseId,
// fingerprintHash): reusar la misma maquina NO consume seat nuevo (license.service.ts
// activate()). validate() exige el fingerprint ya activado, asi que un dev nuevo lo
// necesita en el primer arranque. Nunca bloquea: si falla, seguimos a validate/grace.
async function activateFingerprint(hubUrl, licenseKey, fingerprint) {
  const url = `${hubUrl}/license/activate`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, fingerprint }),
      signal: AbortSignal.timeout(fetchDeadlineMs()),
    });
    if (res.ok) {
      await logLine({ level: 'info', msg: 'fingerprint activado' });
      return true;
    }
    await logLine({ level: 'warn', msg: 'activate fallo', status: res.status, url });
  } catch (err) {
    // el errno real (UNABLE_TO_GET_ISSUER_CERT_LOCALLY, UNABLE_TO_VERIFY_LEAF_SIGNATURE,
    // ENOTFOUND, TimeoutError...) viaja en err.cause; err.message es siempre 'fetch failed'.
    const net = describeNetworkError(err);
    await logLine({
      level: 'warn',
      msg: 'activate network error',
      code: net.code,
      cause: net.cause,
      error: net.message,
      url,
    });
  }
  return false;
}

// fix #3 — el MCP server `specoe` de .mcp.json necesita el JWT de licencia en el header
// Authorization. Dos mecanismos combinados porque el timing SessionStart-vs-lectura-de-
// .mcp.json de Claude Code no esta garantizado por doc:
//   (B) escribe `export SPECOE_SKILL_JWT=<jwt>` a $CLAUDE_ENV_FILE — el placeholder
//       ${SPECOE_SKILL_JWT} del .mcp.json se expande con la var fresca de este arranque.
//   (A) reescribe .mcp.json con el JWT inline — garantiza header no vacio aunque (B) no
//       cargue a tiempo. Refresca en cada arranque (el JWT de licencia vive 1h).
async function populateSkillJwt(token) {
  // (B) $CLAUDE_ENV_FILE — mecanismo soportado para que un hook inyecte env a la sesion.
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    try {
      await fs.appendFile(envFile, `export SPECOE_SKILL_JWT=${token}\n`);
    } catch (err) {
      await logLine({
        level: 'warn',
        msg: 'no se pudo escribir CLAUDE_ENV_FILE',
        error: err?.message,
      });
    }
  }
  // (A) .mcp.json con JWT inline — fallback. Preserva otros mcpServers si el archivo existe;
  // resuelve la url del server `specoe` inline (nunca deja un ${...} sin expandir).
  try {
    let doc = { mcpServers: {} };
    try {
      doc = JSON.parse(await fs.readFile(MCP_JSON_FILE, 'utf8'));
      if (!doc || typeof doc !== 'object') doc = { mcpServers: {} };
      if (!doc.mcpServers) doc.mcpServers = {};
    } catch {
      /* no existe o corrupto — se genera desde cero */
    }
    const prev = doc.mcpServers.specoe || {};
    const url =
      typeof prev.url === 'string' && !prev.url.includes('${')
        ? prev.url
        : DEFAULT_SKILL_SERVER_URL;
    doc.mcpServers.specoe = {
      type: 'sse',
      url,
      headers: { Authorization: `Bearer ${token}` },
    };
    await fs.writeFile(MCP_JSON_FILE, JSON.stringify(doc, null, 2) + '\n');
  } catch (err) {
    await logLine({ level: 'warn', msg: 'no se pudo actualizar .mcp.json', error: err?.message });
  }
}

// T2.3 — camino SIMETRICO de populateSkillJwt(). Hasta ahora el .mcp.json solo se tocaba
// en el camino feliz: sin token quedaba como lo dejo el instalador, con
// `Authorization: Bearer ${SPECOE_SKILL_JWT}` sin expandir, y el error emergia tres capas
// abajo como un 401 del skill-server sin rastro del fetch que lo origino.
// Sin JWT usable retiramos el server `specoe` del archivo: /mcp no lo va a mostrar como
// 401 — no lo va a mostrar, que es coherente con el mensaje de arranque que ya explico
// por que. Los demas mcpServers se preservan, igual que en el camino feliz, y
// populateSkillJwt() reconstruye el entry completo en la primera corrida que valide.
async function withdrawSkillServer() {
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(MCP_JSON_FILE, 'utf8'));
  } catch {
    return; // no existe o corrupto: no hay nada que retirar
  }
  if (!doc?.mcpServers?.specoe) return;
  const removedUrl = doc.mcpServers.specoe.url ?? null;
  delete doc.mcpServers.specoe;
  try {
    await fs.writeFile(MCP_JSON_FILE, JSON.stringify(doc, null, 2) + '\n');
    await logLine({
      level: 'warn',
      msg: '.mcp.json — server specoe retirado: esta corrida no tiene JWT usable',
      removedUrl,
      file: MCP_JSON_FILE,
    });
  } catch (err) {
    await logLine({
      level: 'warn',
      msg: 'no se pudo retirar specoe del .mcp.json',
      error: err?.message,
    });
  }
}

// Regla unica del archivo: el .mcp.json declara `specoe` si y solo si ESTA corrida tiene
// un JWT usable. Cualquier otro estado es fingir que el room esta servido.
async function syncSkillServerEntry(token) {
  if (token) await populateSkillJwt(token);
  else await withdrawSkillServer();
}

function usableCachedToken(cache) {
  if (!cache?.token) return null;
  if (!cache.validatedAt) return null;
  const ageMs = Date.now() - new Date(cache.validatedAt).getTime();
  return ageMs < SKILL_JWT_MAX_AGE_MS ? cache.token : null;
}

// ----- diagnostico compartido (T2.1 + T2.2) -----
//
// Los TRES mensajes de la rama degradada y el mensaje de bloqueo salen de aca. Se escribe
// una vez y se reusa: dos formatos distintos para el mismo fallo es como el dato se pierde
// en el camino. Todo lo de esta seccion es puro y exportado — la suite lo ejercita sin red.
//
// El mensaje viejo (`SpecOE license invalida y cache expirado`) era FALSO en el incidente
// que origino esta SPEC: la licencia no era invalida, los dos fetch murieron en el
// handshake TLS y nunca hubo respuesta del Hub. Mando a buscar el problema donde no estaba.

export const SCENARIO_NO_HUB_RESPONSE = 'no-hub-response';
export const SCENARIO_LICENSE_REJECTED = 'license-rejected';
export const SCENARIO_NO_LICENSE_KEY = 'no-license-key';

// Prefijo estable de cada dato del diagnostico: ancla determinista para la suite, para el
// verificador de P4 y para el dev que hace grep. Mismo criterio que el SENTINEL_PREFIX
// de specoe-room-bootstrap.mjs.
export const DIAG_PREFIX = 'SPECOE-DIAG';
// Los CUATRO datos obligatorios por instruccion del Operador (ADR-002).
export const REQUIRED_DIAG_KEYS = ['errno', 'url', 'ca', 'accion'];

function diagLine(key, text) {
  return `${DIAG_PREFIX} ${key}: ${text}`;
}

/** true solo si el texto trae los cuatro datos obligatorios. */
export function hasAllRequiredDiagnostics(text) {
  return REQUIRED_DIAG_KEYS.every((k) => String(text ?? '').includes(`${DIAG_PREFIX} ${k}:`));
}

/** Titular por escenario. Es lo que hace los tres mensajes distinguibles de un vistazo. */
export function buildHeadline({ scenario, httpStatus }) {
  switch (scenario) {
    case SCENARIO_LICENSE_REJECTED:
      return (
        `SpecOE: el Hub RESPONDIO y rechazo la licencia (HTTP ${httpStatus}). ` +
        `El canal funciono — el problema esta en la licencia.`
      );
    case SCENARIO_NO_LICENSE_KEY:
      return (
        'SpecOE: no hay license key en env, keyring ni cache. ' +
        'No se intento ningun request: no habia nada que validar.'
      );
    case SCENARIO_NO_HUB_RESPONSE:
    default:
      return (
        'SpecOE: NO hubo respuesta del Hub. El fallo es de red/TLS, ' +
        'NO de la licencia: nunca se la pudo preguntar.'
      );
  }
}

/** Dato 1 — el errno real, el de err.cause, no la string `fetch failed`. */
export function describeErrno({ scenario, net, httpStatus }) {
  if (scenario === SCENARIO_LICENSE_REJECTED) {
    return `sin error de red — el Hub contesto HTTP ${httpStatus}`;
  }
  if (scenario === SCENARIO_NO_LICENSE_KEY) {
    return 'sin error de red — no se hizo ningun request';
  }
  const code = net?.code ?? 'desconocido';
  const cause = net?.cause ?? net?.message ?? 'sin detalle';
  return `${code} — ${cause} (sale de err.cause; el 'fetch failed' pelado no nombra nada)`;
}

/** Dato 2 — la URL resuelta y CUAL de las tres fuentes de resolveHubUrl() gano. */
export function describeHubUrl({ hub }) {
  return `${hub?.url ?? 'sin resolver'} (fuente: ${hub?.source ?? 'desconocida'})`;
}

/**
 * Dato 3 — la fuente de CA que gano. Con el mecanismo unico de ADR-001 hay un solo camino,
 * asi que el dato concreto es: path del .crt leido, si parseo como X509, y si el root de
 * Caddy quedo EFECTIVAMENTE en el store del proceso. Es la diferencia entre "no llegue" y
 * "no llegue porque el CA no esta en el trust".
 */
export function describeCaSource({ ca }) {
  const at = `${ca?.caPath ?? DEFAULT_CA_PATH}`;
  switch (ca?.reason) {
    case 'ok':
      return (
        `${at} — leido y parseado como X509 (subject ${ca.subject}); ` +
        `el root SI quedo en el store efectivo del proceso (${ca.storeBefore} -> ${ca.storeAfter} certs, ` +
        `system=${ca.system} bundled=${ca.bundled})`
      );
    case 'ca-missing':
      return `${at} — el archivo NO existe: no se leyo ningun .crt, no parseo, y el root NO quedo en el store del proceso`;
    case 'ca-unparsable':
      return `${at} — el archivo se leyo pero NO parseo como X509 (${ca.error ?? 'sin detalle'}): el root NO quedo en el store del proceso`;
    case 'api-missing':
      return `${at} — parseo como X509 (subject ${ca.subject}) pero ${process.version} no expone tls.setDefaultCACertificates: el root NO quedo en el store del proceso`;
    case 'apply-failed':
      return `${at} — parseo como X509 (subject ${ca.subject}) pero escribir el store fallo (${ca.error ?? 'sin detalle'}): el root NO quedo adentro`;
    case 'not-in-effective-store':
      return `${at} — parseo como X509 (subject ${ca.subject}) pero al releer el store el root NO aparece adentro`;
    default:
      return `${at} — el canal de CA no se abrio en esta corrida (no hubo request al Hub que lo necesitara)`;
  }
}

/** Dato 4 — que hacer, en imperativo, sin mandar a leer el log. */
export function buildAction({ scenario, ca, hub }) {
  if (scenario === SCENARIO_NO_LICENSE_KEY) {
    return (
      'Guarda la license key de este rol en el keyring: corre ' +
      './specoe-add-room.sh <ROL> <LICENSE_KEY> desde el starter, ' +
      'o exporta SPECOE_LICENSE_KEY=<key> en el entorno. Despues volve a abrir la sesion.'
    );
  }
  if (scenario === SCENARIO_LICENSE_REJECTED) {
    return (
      'La licencia llego al Hub y fue rechazada: pedi a un ADMIN del tenant que la revise ' +
      'en el Hub (Administracion -> Licencias: vigencia, seats y fingerprint de esta maquina). ' +
      'No toques el CA ni la red: el canal funciono.'
    );
  }
  if (ca?.ok !== true) {
    return (
      'Instala el root de Caddy en esta maquina: corre ./specoe-setup-host.sh desde el ' +
      `starter, o copia certs/caddy-root-ca.crt a ${ca?.caPath ?? DEFAULT_CA_PATH}. ` +
      'Despues volve a abrir la sesion.'
    );
  }
  return (
    `El CA esta en el store y el Hub igual no contesto: verifica desde ESTA maquina que ` +
    `${hub?.url ?? 'la URL del Hub'} resuelva y este arriba (curl -I ${hub?.url ?? '<url>'}), ` +
    'y revisa proxy/firewall. Si la URL no es la que esperabas, corregi INTEGRA_HUB_URL o ' +
    'hub.api-url en project.config.yaml.'
  );
}

/** Via de escape del bloqueo: explicita y ejecutable en la misma corrida. */
export function buildEscapeHatch({ escapeFile = ESCAPE_HATCH_FILE } = {}) {
  return (
    'para arrancar igual, degradado a proposito (sin skills SpecOE y sin contrato de rol), ' +
    `corre UNA de estas dos y volve a abrir la sesion — PowerShell: New-Item -ItemType File -Force "${escapeFile}" — ` +
    `bash: touch "${escapeFile}" — o exporta ${ESCAPE_HATCH_ENV}=1.`
  );
}

/**
 * El mensaje completo. Lo comparten los tres escenarios degradados y el bloqueo: la unica
 * diferencia es la linea `escape`, que solo aparece cuando efectivamente se corta.
 */
export function buildFailureContext(diag) {
  const lines = [
    buildHeadline(diag),
    diagLine('errno', describeErrno(diag)),
    diagLine('url', describeHubUrl(diag)),
    diagLine('ca', describeCaSource(diag)),
    diagLine('accion', buildAction(diag)),
  ];
  if (diag?.blocked) lines.push(diagLine('escape', buildEscapeHatch(diag)));
  if (diag?.escapeUsed) {
    lines.push(
      diagLine(
        'escape-activo',
        `arrancando degradado a proposito por ${diag.escapeUsed}: la sesion sigue sin skills SpecOE y sin contrato de rol.`,
      ),
    );
  }
  return lines.join('\n');
}

// ----- rol declarado + veredicto del Hub (SPEC-0176 P2) -----
//
// El room DECLARA su rol y el Hub lo AUTORIZA: `declaredRole` es INPUT, nunca un claim
// firmado. Hasta esta fase el rechazo de autorizacion no tenia forma de verse — el JWT
// salia sin claim `sddRole`, los tools MCP servian el bundle producto, y la sesion
// arrancaba en el mismo silencio que una carpeta legitimamente sin rol. Los dos casos se
// veian igual, asi que el dev no tenia como distinguir "no tengo rol" de "pedi un rol y me
// lo negaron". Todo lo de esta seccion es puro y exportado: la suite lo ejercita sin red.

/**
 * El rol que la carpeta declara. FUENTE UNICA: la env `INTEGRA_SDD_ROLE` — la misma que ya
 * consumen specoe-role-check.mjs (:19, :29) y el cliente MCP para el header `x-sdd-role`.
 *
 * NO se lee de project.config.yaml ni del .mcp.json: ADR-001 los declara inertes por
 * diseno como fuente de rol, y una segunda fuente reabre exactamente el defecto que
 * SPEC-0176 cierra (dos lugares que pueden discrepar y nadie sabe cual gana). Cuesta cero:
 * es una lectura de memoria, sin request ni I/O, asi que el presupuesto del hook
 * (HOOK_BUDGET_MS) no se toca.
 *
 * Normaliza trim+upper porque el valor viene de un launcher escrito a mano. Sin la env
 * devuelve null, y el body del validate queda byte-a-byte como antes de esta fase.
 */
export function resolveDeclaredRole(env = process.env) {
  return env.INTEGRA_SDD_ROLE?.trim().toUpperCase() || null;
}

/** Unico outcome de `roleResolution` que produce mensaje propio: el rechazo. */
export const OUTCOME_ROLE_NOT_GRANTED = 'ROLE_NOT_GRANTED';

// Prefijo estable del aviso, para grep y para la suite. Es OTRO a proposito, igual que el
// DIVERGENCE_PREFIX de specoe-room-bootstrap.mjs: no contiene `SPECOE-DIAG` como subcadena,
// asi que un probe puede afirmar la presencia de este aviso y la del diagnostico de forma
// independiente sobre el mismo texto.
export const ROLE_REJECTED_PREFIX = 'SPECOE-ROL-RECHAZADO';

/**
 * TKT-0263 — LA consecuencia del rechazo, en las mismas palabras que la sirve el otro lado.
 *
 * P2 escribio este aviso contra el comportamiento vigente en ese momento: sin claim `sddRole`
 * los tools MCP servian el bundle producto, y eso era lo que el aviso prometia. P3 —de la
 * MISMA SPEC— cambio el comportamiento: el guard de `packages/skill-server/src/tools/index.ts`
 * corta las siete tools al tope del dispatcher cuando `authContext.roleDenied`, con un mensaje
 * que dice lo contrario ("este canal no sirve catalogo — ni el del room ni el de producto").
 * El texto de aca quedo describiendo un comportamiento que ya no existia.
 *
 * El costo no era cosmetico: el dev leia "voy a tener producto", invocaba una tool, no recibia
 * nada, y concluia que el skill-server estaba caido — el mismo sintoma que SPEC-0176 vino a
 * volver legible, reintroducido por la otra punta.
 *
 * POR QUE UN LITERAL COMPARTIDO Y NO UN MODULO COMPARTIDO: este hook es un artefacto
 * VENDORIZADO — se copia tal cual dentro del proyecto del cliente y corre sin build ni
 * dependencias, asi que no puede importar del paquete `skill-server`. Lo que SI se puede es
 * fijar la coincidencia con un test que lee los DOS archivos y falla si divergen (suite
 * `rol-declarado-license-validate.test.mjs`, seccion 6c). Nada obliga a que dos literales en
 * dos paquetes digan lo mismo; el test es lo que lo obliga.
 */
export const ROLE_DENIED_CONSEQUENCE = 'no sirve catalogo — ni el del room ni el de producto';

/**
 * El aviso de autorizacion rechazada, o null cuando no hay nada que avisar.
 *
 * Solo `ROLE_NOT_GRANTED` produce texto. Los otros cuatro outcomes son estados legitimos y
 * conservan el mensaje vigente: GRANTED sirve el rol pedido; NO_ROLES_ACTIVE es producto
 * legitimo (el usuario no tiene ningun rol, no le negaron ninguno); NOT_DECLARED y
 * AMBIGUOUS_LEGACY son el camino legacy de una instalacion que todavia no declara rol.
 * Inventarles un aviso convertiria el caso normal en ruido y el aviso dejaria de leerse.
 *
 * NO bloquea el arranque: hereda el contrato de salida de ADR-002 (SPEC-0164 P2). La
 * licencia es valida — lo que fallo es la autorizacion del rol, y cortar la sesion por eso
 * seria cambiar un room sin rol por un room sin sesion.
 */
export function buildRoleNotice(roleResolution) {
  if (roleResolution?.outcome !== OUTCOME_ROLE_NOT_GRANTED) return null;
  const declarado = roleResolution.declaredRole ?? 'sin rol declarado';

  // TKT-0263 — la consecuencia se NOMBRA como la aplica el skill-server: el canal no sirve
  // NADA hasta que el rol este concedido y el token de licencia se renueve. Decir "vas a
  // tener producto" era falso desde P3 y mandaba al dev a diagnosticar una caida del
  // servicio. El plazo (TTL del token) es el mismo que nombra el mensaje del otro lado.
  const cabecera =
    `\n\n[[${ROLE_REJECTED_PREFIX}]] ATENCION: la licencia es valida, pero la AUTORIZACION ` +
    `DE ROL fallo. Este room declaro el rol ${declarado} (env INTEGRA_SDD_ROLE) y el Hub NO ` +
    `firmo el claim sddRole: los tools MCP de esta sesion ${ROLE_DENIED_CONSEQUENCE}. NO es ` +
    `que el skill-server este caido: es este rechazo. Una vez concedido el rol, el canal ` +
    `vuelve a servir cuando se renueve el token de licencia (plazo maximo 1 h). La sesion ` +
    `arranca igual — esto no corta el arranque.`;

  // TKT-0248 — el Hub llega a ROLE_NOT_GRANTED por DOS caminos con diagnosticos OPUESTOS, y
  // hasta ahora este aviso mostraba siempre el de uno solo. Cuando el rechazo venia de no
  // haber usuario del seat, mandaba al dev a pedir un rol que probablemente YA tiene: el
  // admin miraba y lo veia otorgado, y nadie sabia para donde seguir.
  //
  // `seatUserResolved` es el discriminador que el Hub expone desde TKT-0248. Se ramifica
  // sobre ESE boolean y no sobre el texto de `reason` — el reason es para que el humano lea
  // el detalle, no para que un cliente lo matchee.
  //
  // `=== false` y no `!seatUserResolved`: contra un Hub ANTERIOR a TKT-0248 el campo llega
  // `undefined`, y ahi la unica respuesta honesta es el mensaje generico de abajo. Tratar el
  // undefined como "no hubo usuario" seria inventar un diagnostico con un dato que no vino.
  if (roleResolution.seatUserResolved === false) {
    return (
      `${cabecera} Causa: el Hub NO pudo resolver el usuario del seat contra quien autorizar ` +
      `el rol (no llego userContext en el validate). OJO: esto NO significa que te falte el ` +
      `rol — lo mas probable es que ${declarado} ya lo tengas concedido. Pedirle el rol a un ` +
      `admin no va a arreglar nada: lo va a ver otorgado. Accion: revisa el login SDD de esta ` +
      `maquina (que la sesion tenga usuario resuelto) y volve a arrancar el room; si persiste, ` +
      `reportalo con este aviso — el problema es de resolucion de identidad, no de permisos.`
    );
  }

  if (roleResolution.seatUserResolved === true) {
    return (
      `${cabecera} Causa: tu usuario existe y tiene otros roles activos, pero ${declarado} no ` +
      `esta entre ellos. Accion: pedi a un ADMIN del tenant que te conceda ${declarado} en ` +
      `Administracion -> Identidad SDD, o corregi INTEGRA_SDD_ROLE en el launcher de esta ` +
      `carpeta si el rol que declaraste no es el que te toca.`
    );
  }

  // Hub anterior a TKT-0248: sin el discriminador no se puede diagnosticar, asi que se
  // nombran las DOS causas en vez de elegir una a la suerte. Es peor que los mensajes de
  // arriba —le pasa el diagnostico al dev— pero no miente.
  return (
    `${cabecera} Causa: puede ser (a) que ${declarado} no este concedido a tu usuario ` +
    `— pedilo a un ADMIN en Administracion -> Identidad SDD, o corregi INTEGRA_SDD_ROLE — o ` +
    `(b) que el Hub no haya podido resolver el usuario del seat, en cuyo caso el rol ya lo ` +
    `tenes y lo que falla es el login SDD de esta maquina. Este Hub no informa cual de las ` +
    `dos: si mirando Identidad SDD el rol figura otorgado, es (b).`
  );
}

/**
 * La linea de log estructurada del veredicto. Los tres datos que hacen falta para contar
 * poblaciones sin ir maquina por maquina: que pidio el room, que le sirvio el Hub, y con
 * que outcome. `declaredRole` cae al valor que ESTE hook mando cuando la respuesta no trae
 * `roleResolution` (MACHINE-mode, ADR-006): ahi no hay veredicto que registrar, pero lo que
 * el room declaro sigue siendo el dato util.
 */
export function buildRoleResolutionLog({ roleResolution, declaredRole, machineAuthorization }) {
  const outcome = roleResolution?.outcome ?? null;
  // SPEC-0187 P4 — el status de autorizacion del equipo entra en la MISMA linea que el
  // veredicto de rol: las dos cosas explican por que una sesion opera sin catalogo, y
  // separarlas en dos lineas obligaria a cruzarlas por timestamp para contar poblaciones.
  // `null` cuando el bloque no vino (Hub viejo, o USER-mode sin userContext): la ausencia se
  // registra como ausencia, no como un estado inventado.
  const machineAuthStatus = machineAuthorization?.status ?? null;
  return {
    level: outcome === OUTCOME_ROLE_NOT_GRANTED ? 'warn' : 'info',
    msg: 'resolucion de rol del Hub',
    outcome,
    declaredRole: roleResolution?.declaredRole ?? declaredRole ?? null,
    servedRole: roleResolution?.servedRole ?? null,
    machineAuthStatus,
  };
}

// ----- diagnostico de arranque por causa server-side (SPEC-0187 P4) -----
//
// EL DEFECTO QUE CIERRA ESTA SECCION. El caso integra-erp: un equipo enrolado PENDIENTE de
// aprobacion. El backend lo sabia —el guard compuesto tiraba MACHINE_PENDING_APPROVAL en cada
// pedido— pero el arranque del room no tenia como decirlo: el JWT salia sin claim, el catalogo
// no venia, y lo unico que el dev leia era un generico "sin rol" que lo mandaba a pedirle a un
// admin un rol que probablemente ya tenia. Diagnostico correcto server-side, propagacion rota
// client-side (ADR-002).
//
// P3 puso el dato en la respuesta del validate (`machineAuthorization.status`, aditivo, solo
// USER-mode con userContext). Aca se lo cruza con el estado LOCAL de identidad SDD y se nombra
// la causa exacta. Todo lo de esta seccion es puro y exportado: la suite lo ejercita sin red.
//
// EL CRITERIO DE RUIDO ES CLIENT-SIDE. Una instalacion de producto —sin identidad SDD en el
// canal y sin rol declarado— NO gana ningun aviso. Es la failure_condition literal de O3: el
// dia que el caso normal empieza a ver diagnosticos, el aviso deja de leerse y el mecanismo
// entero se vuelve ruido.

export const MACHINE_AUTH_ACTIVE = 'ACTIVE';
export const MACHINE_AUTH_PENDING = 'PENDING';
export const MACHINE_AUTH_REVOKED = 'REVOKED';
export const MACHINE_AUTH_NOT_ENROLLED = 'NOT_ENROLLED';

/** Outcome de `roleResolution` que significa "esta sesion no declaro ningun rol". */
export const OUTCOME_ROLE_NOT_DECLARED = 'NOT_DECLARED';

// Prefijo estable del aviso de arranque, para grep y para la suite. Es OTRO a proposito, y no
// contiene `SPECOE-DIAG` ni `SPECOE-ROL-RECHAZADO` como subcadena: un test puede afirmar la
// presencia (o la AUSENCIA) de este canal sin que se la conteste otro.
export const STARTUP_DIAG_PREFIX = 'SPECOE-ARRANQUE';

// Etiqueta de causa. Cada aviso lleva UNA y son mutuamente excluyentes: es lo que permite que
// el dev —y el test— sepan de un vistazo cual de las cuatro causas se disparo.
export const CAUSE_EQUIPO_PENDIENTE = 'EQUIPO-PENDIENTE';
export const CAUSE_EQUIPO_REVOCADO = 'EQUIPO-REVOCADO';
export const CAUSE_LOGIN_SDD_INCOMPLETO = 'LOGIN-SDD-INCOMPLETO';
export const CAUSE_ROL_NO_DECLARADO = 'ROL-NO-DECLARADO';
// SPEC-0187 P7 — el room declara un tenant del que este equipo no tiene material, o tiene
// identidad de varios y no declara ninguno. Es la causa que reemplaza al fallback silencioso.
export const CAUSE_TENANT_SIN_IDENTIDAD = 'TENANT-SIN-IDENTIDAD';

function startupNotice(causa, cuerpo) {
  return `\n\n[[${STARTUP_DIAG_PREFIX}:${causa}]] ${cuerpo}`;
}

/**
 * El aviso del aislamiento por tenant, o null.
 *
 * SALE SIEMPRE QUE HAYA UN MOTIVO, y a proposito NO pasa por el discriminador de ruido de
 * `buildStartupDiagnosis`: ese discriminador es "esta maquina tiene identidad SDD resuelta", y
 * este caso es justamente el de la maquina que NO la tiene PARA ESTE TENANT. Silenciarlo con la
 * misma guarda dejaria al dev con un room que no opera y sin ninguna linea que lo explique.
 *
 * El ruido igual queda acotado por otro lado: sin tenant declarado y sin identidad scoped, el
 * `scope.notice` es null y esta funcion devuelve null — o sea la instalacion de producto y el
 * piloto single-tenant no ven nada nuevo.
 *
 * `scopeNotice` es el aviso que ya construyo la resolucion del canal (sdd-identity.mjs): se
 * reusa el texto en vez de reescribirlo para que el dev lea la MISMA instruccion la vea donde
 * la vea (log del hook, CLI de identidad, arranque).
 */
export function buildTenantScopeNotice({ scopeNotice = null, licensePresent = true } = {}) {
  const partes = [];
  if (scopeNotice) partes.push(scopeNotice);
  if (!licensePresent) {
    partes.push(
      'Tampoco hay licencia guardada para (tenant, rol) de este room: si la licencia de esta maquina es anterior al esquema por tenant, ' +
        'volvé a correr specoe-add-room.sh con el tenant del room para regrabarla.',
    );
  }
  if (partes.length === 0) return null;
  return startupNotice(
    CAUSE_TENANT_SIN_IDENTIDAD,
    `ATENCION: ${partes.join(' ')} La sesion arranca igual — esto no corta el arranque.`,
  );
}

/**
 * El aviso de arranque con la causa exacta, o null cuando no hay nada que avisar.
 *
 * Entradas: el bloque `machineAuthorization` de la respuesta del validate (P3), el
 * `roleResolution` del mismo validate (SPEC-0176 P2), y si esta maquina tiene identidad SDD
 * resuelta — el discriminador de ruido.
 *
 * PRECEDENCIA. Devuelve UN solo aviso, y el orden no es arbitrario: el estado del equipo va
 * primero porque es el unico que el dev NO puede resolver solo (depende de un admin) y porque
 * mientras el equipo no este habilitado, declarar un rol no cambia nada. Nombrar dos causas a
 * la vez es como el aviso deja de leerse.
 *
 * ROLE_NOT_GRANTED NO SE TOCA. Ese caso lo sigue sirviendo `buildRoleNotice` con el texto
 * vigente (TKT-0248/TKT-0263) y esta funcion devuelve null para el, salvo que ADEMAS haya una
 * causa de equipo: ahi los dos avisos salen, porque son dos hechos distintos y verdaderos, y
 * callar el del equipo reintroduce exactamente el "sin rol" enganoso que origino la SPEC.
 *
 * COMPATIBILIDAD. Sin el bloque `machineAuthorization` (Hub anterior a P3, o Hub nuevo en
 * USER-mode sin userContext) no se inventa nada: la rama nueva devuelve null y el output del
 * hook queda byte-igual al vigente. Mismo patron honesto que `seatUserResolved === false`.
 *
 * NO bloquea el arranque: hereda el contrato de salida de ADR-002 (SPEC-0164 P2).
 */
export function buildStartupDiagnosis({
  machineAuthorization,
  roleResolution,
  sddIdentityPresent = false,
} = {}) {
  // EL DISCRIMINADOR DE RUIDO, UNO SOLO Y ARRIBA DE TODO. Ninguna de las cuatro causas habla si
  // esta maquina no tiene identidad SDD: sin ella la instalacion es de PRODUCTO y cualquier
  // aviso es ruido (failure_condition de O3). Vale incluso para los status de equipo, que hoy
  // solo pueden llegar CON userContext —o sea con identidad— y por eso la guarda no les cambia
  // el comportamiento: esta para que un cambio server-side no pueda convertir el caso normal en
  // ruido sin pasar por aca.
  if (!sddIdentityPresent) return null;

  const status = machineAuthorization?.status ?? null;

  // (1) El caso que origino la SPEC. Nunca dice "sin rol" ni manda a declarar ninguno: pedir
  // o corregir un rol con el equipo pendiente es trabajo tirado.
  if (status === MACHINE_AUTH_PENDING) {
    return startupNotice(
      CAUSE_EQUIPO_PENDIENTE,
      'ATENCION: la licencia es valida y tu usuario esta resuelto, pero ESTE EQUIPO figura ' +
        'PENDIENTE DE APROBACION en el Hub. Mientras siga pendiente, el canal SDD rechaza los ' +
        'pedidos de esta maquina (MACHINE_PENDING_APPROVAL) y la sesion opera sin catalogo del ' +
        'room. Esto NO se destraba pidiendo un rol: mientras el equipo no este aprobado, el ' +
        'canal rechaza igual, tengas el rol que tengas. ' +
        'Accion: pedi a un ADMIN del tenant que apruebe este equipo en Administracion -> ' +
        'Identidad SDD -> Equipos, y volve a abrir la sesion. La sesion arranca igual — esto no ' +
        'corta el arranque.',
    );
  }

  // (2) Revocado: mismo canal, consecuencia opuesta — aca no hay nada que esperar.
  if (status === MACHINE_AUTH_REVOKED) {
    return startupNotice(
      CAUSE_EQUIPO_REVOCADO,
      'ATENCION: la licencia es valida, pero la autorizacion de ESTE EQUIPO fue REVOCADA en el ' +
        'Hub. El canal SDD no va a servir catalogo desde esta maquina hasta que se reactive, ' +
        'tengas el rol que tengas: no es una caida del skill-server. Accion: si la ' +
        'revocacion no fue intencional, pedi a un ADMIN del tenant que reactive el equipo en ' +
        'Administracion -> Identidad SDD -> Equipos; si fue intencional, esta maquina ya no ' +
        'opera rooms SDD. La sesion arranca igual — esto no corta el arranque.',
    );
  }

  // (3) El Hub no encuentra NINGUN equipo enrolado por tu usuario en este tenant, pero la
  // maquina tiene identidad SDD guardada (garantizado por la guarda de arriba): el login SDD
  // quedo a medias.
  if (status === MACHINE_AUTH_NOT_ENROLLED) {
    return startupNotice(
      CAUSE_LOGIN_SDD_INCOMPLETO,
      'ATENCION: esta maquina tiene identidad SDD guardada, pero el Hub no encuentra NINGUN ' +
        'equipo enrolado para tu usuario en este tenant. El login SDD de esta maquina quedo a ' +
        'medias: la credencial local existe y el enrolamiento del equipo no. Esto tampoco se ' +
        'destraba pidiendo un rol. Accion: volve a correr el login SDD desde el starter ' +
        '(./setup.sh --login), que enrola el equipo, y volve a abrir la sesion. La sesion ' +
        'arranca igual — esto no corta el arranque.',
    );
  }

  // (4) El equipo esta bien (o el Hub no opino) y esta sesion no declaro ningun rol: es una
  // instalacion SDD abierta por fuera de los dos launchers (doble click, `code .`).
  // Se nombran los DOS caminos porque los dos son validos y el dev elige.
  if (roleResolution?.outcome === OUTCOME_ROLE_NOT_DECLARED) {
    return startupNotice(
      CAUSE_ROL_NO_DECLARADO,
      'ATENCION: esta maquina tiene identidad SDD, pero esta sesion no declaro el rol del room, ' +
        'asi que el Hub no firmo ningun claim y los tools MCP no sirven el catalogo del room. ' +
        'Te falta declarar el rol, y hay dos caminos: abri el room desde el plugin de VSCode ' +
        '(cada solapa declara su rol) o arrancalo con ./specoe-launch-thinclient.sh <ROL> desde ' +
        'el starter. Abrir la carpeta a mano (doble click, o `code .`) no declara nada. La ' +
        'sesion arranca igual — esto no corta el arranque.',
    );
  }

  // Producto en silencio, equipo ACTIVE, y Hub viejo sin el campo: los tres sin aviso.
  return null;
}

/** La via de escape esta activa? Devuelve por que, o null. */
async function escapeHatchReason(escapeFile = ESCAPE_HATCH_FILE) {
  if (process.env[ESCAPE_HATCH_ENV]) return `la variable ${ESCAPE_HATCH_ENV}`;
  try {
    await fs.access(escapeFile);
    return `el archivo ${escapeFile}`;
  } catch {
    return null;
  }
}

// =====================================================================
// TKT-0321 — deriva de los hooks del Hub instalados en esta maquina
// =====================================================================
//
// QUE PROBLEMA CIERRA: los cuatro artefactos del Hub (los dos hooks de ack-task, su canal y el
// verificador de claims) viajan vendorizados en el bundle y los instala la parte de MAQUINA
// (`specoe-setup-host.sh`). La carpeta del room se actualiza por su lado
// (`specoe-add-room.sh`). Son dos canales con dos disparadores, asi que una maquina puede
// quedarse con hooks de una version anterior por tiempo indefinido — y un hook viejo no se cae
// ni avisa: sigue corriendo, degradado. Ya paso y esta medido (2026-08-04, SPEC-0166 P4b): el
// enforcer desplegado era de mayo mas un parche local y le faltaba entero el commit de
// TKT-0233, o sea que el gate corria CIEGO a los tickets standalone. Nadie lo noto porque el
// hook seguia funcionando para el caso que si cubria.
//
// COMO SE DETECTA: el `vendor/MANIFEST.json` que viaja EN LA CARPETA DEL ROOM declara el
// packageSha256 de cada artefacto. Se compara contra la copia instalada en ~/.claude/. Si
// difieren, la maquina esta atras de la carpeta.
//
// POR QUE BLOQUEA (decision del Operador, 2026-08-11): porque el aviso que no bloquea es el que
// ya tuvimos — la deriva de agosto vivio meses a la vista de todos. Un gate desactualizado es
// peor que ninguno: da la sensacion de cobertura que no tiene.
//
// LO QUE ESTE CHEQUEO NO PUEDE HACER, y conviene no fingirlo: no alcanza a las maquinas que
// tienen un bundle ANTERIOR a este ticket. Ahi corre el license-check viejo, que no tiene este
// codigo. El chequeo protege de la deriva FUTURA, a partir de la primera actualizacion. La
// primera sigue siendo un acto del Operador avisando.
//
// ALCANCE: solo en una carpeta que sea un room (tiene vendor/MANIFEST.json). Este hook corre en
// TODA sesion de Claude Code de la maquina; una carpeta cualquiera no tiene por que saber nada
// de esto y no gana ni un aviso.
const HUB_ARTIFACT_BASES = {
  '.claude-bundle/hooks': 'hooks',
  '.claude-bundle/commands': 'commands',
};

/**
 * Compara lo instalado contra lo que declara el MANIFEST del room.
 * Devuelve `{ checked, drifted: [{ name, file, destino, motivo }] }`.
 * `checked: false` = no habia con que comparar; NUNCA se bloquea con eso.
 */
export async function checkHubHooksDrift({
  projectDir = PROJECT_DIR,
  claudeHome = path.join(os.homedir(), '.claude'),
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(projectDir, 'vendor', 'MANIFEST.json'), 'utf8'),
    );
  } catch {
    // No es un room, o es un room recortado sin vendor/. Nada que comparar.
    return { checked: false, drifted: [] };
  }

  const componentes = (manifest.components ?? []).filter((c) => HUB_ARTIFACT_BASES[c.basePath]);
  if (componentes.length === 0) {
    // MANIFEST anterior a este ticket: no declara los artefactos del Hub. No hay deriva que
    // medir — y confundir "no declarado" con "al dia" seria un verde falso.
    return { checked: false, drifted: [] };
  }

  const drifted = [];
  for (const c of componentes) {
    const destino = path.join(claudeHome, HUB_ARTIFACT_BASES[c.basePath], c.file);
    let instalado;
    try {
      instalado = await fs.readFile(destino);
    } catch {
      drifted.push({ name: c.name, file: c.file, destino, motivo: 'no esta instalado' });
      continue;
    }
    const sha = createHash('sha256').update(instalado).digest('hex');
    if (sha !== c.packageSha256) {
      drifted.push({
        name: c.name,
        file: c.file,
        destino,
        motivo: `sha256 instalado ${sha.slice(0, 12)} != declarado ${String(c.packageSha256).slice(0, 12)}`,
      });
    }
  }
  return { checked: true, drifted };
}

/**
 * Segundo punto del archivo que devuelve un exit distinto de 0 (el otro es `blockSession`, por
 * licencia). Mantiene su misma disciplina: si no puede componer el diagnostico completo, NO
 * bloquea — un bloqueo mudo deja al dev sin sesion y sin dato.
 */
function blockOnHubHooksDrift(drifted) {
  const detalle = drifted.map((d) => `  - ${d.file} → ${d.motivo}`).join('\n');
  const context = [
    'SpecOE — los hooks del Hub de esta MAQUINA estan atras de esta CARPETA.',
    '',
    'Que se detecto (comparado contra vendor/MANIFEST.json de este room):',
    detalle,
    '',
    'Por que se corta: dos de esos archivos son gates — el de ack-task bloquea las mutaciones sin',
    'work item y el de verificacion bloquea los claims sin respaldo. Un gate desactualizado no se',
    'cae ni avisa: sigue corriendo degradado, y eso ya paso (el enforcer estuvo tres meses ciego a',
    'los tickets standalone sin que nadie lo notara).',
    '',
    'Como salir — actualiza la parte de MAQUINA con el starter con el que la preparaste:',
    '  ./specoe-setup-host.sh',
    'El instalador pisa siempre (install_force), asi que alcanza con volver a correrlo.',
    '',
    `Via de escape, si necesitas trabajar ya: ${ESCAPE_HATCH_ENV}=1`,
  ].join('\n');

  console.log(
    JSON.stringify({
      specoeStatus: 'blocked',
      continue: false,
      stopReason: 'Los hooks del Hub instalados no corresponden a los que declara este room.',
      systemMessage: context,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }),
  );
  process.stderr.write(context + '\n');
  return 2;
}

function emitContext(status, additionalContext) {
  console.log(
    JSON.stringify({
      specoeStatus: status,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }),
  );
}

/**
 * UNICO punto del archivo que devuelve un exit distinto de 0, y arma el mensaje el mismo:
 * asi no existe un camino que corte sin pasar por el diagnostico (riesgo declarado 3 de la
 * fase). Si aun asi el mensaje sale incompleto, NO bloquea — un bloqueo mudo deja al dev
 * sin sesion y sin dato, que es peor que no bloquear.
 */
async function blockSession(diag) {
  const context = buildFailureContext({ ...diag, blocked: true });
  if (!hasAllRequiredDiagnostics(context)) {
    await logLine({ level: 'error', msg: 'bloqueo abortado — diagnostico incompleto', context });
    emitContext('degraded', context);
    return 0;
  }
  await logLine({
    level: 'warn',
    msg: 'arranque BLOQUEADO — sin licencia validada y sin cache de grace',
    scenario: diag.scenario,
    context,
  });
  console.log(
    JSON.stringify({
      specoeStatus: 'blocked',
      // `continue: false` es lo que corta el arranque del lado del harness; el exit 2 y el
      // stderr son la segunda via, para el caso en que el harness no lea el JSON.
      continue: false,
      stopReason: 'SpecOE no pudo validar la licencia y no hay cache de grace.',
      systemMessage: context,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }),
  );
  process.stderr.write(context + '\n');
  return 2;
}

// ----- main -----

async function main() {
  // TKT-0321 — la deriva de los hooks del Hub se mira ANTES que la licencia, y no por
  // importancia sino porque no cuesta red: son cuatro sha256 sobre ~90 KB de disco. Ponerlo
  // despues lo dejaria compitiendo por el presupuesto del hook con los requests que si lo
  // necesitan, y la deriva quedaria sin mirar justo en el arranque lento — que es el que mas
  // se parece a una instalacion en mal estado.
  //
  // Respeta la MISMA via de escape que el bloqueo por licencia: un dev que ya declaro que
  // quiere arrancar degradado no tiene que descubrir una segunda valvula.
  if (!(await escapeHatchReason())) {
    const deriva = await checkHubHooksDrift();
    if (deriva.checked && deriva.drifted.length > 0) {
      await logLine({
        level: 'warn',
        msg: 'arranque BLOQUEADO — hooks del Hub desactualizados en esta maquina',
        drifted: deriva.drifted.map((d) => `${d.file}: ${d.motivo}`),
      });
      return blockOnHubHooksDrift(deriva.drifted);
    }
  }

  // SPEC-0187 P7 — el tenant del room decide QUE claves se leen (licencia e identidad). Va
  // primero porque la licencia es lo primero que se resuelve.
  const tenantSlug = await resolveTenant();
  const licenseKey = await getLicenseKey(tenantSlug);
  if (!licenseKey) {
    // Escenario 3. NO bloquea: este hook se registra global (~/.claude/settings.json) y
    // corre en toda sesion de Claude Code de la maquina. Una carpeta sin licencia no es un
    // room de SpecOE roto — es una sesion sin SpecOE, y cortarla seria bloquear al dev en
    // trabajo que nada tiene que ver. Q8 acota el bloqueo a "no hay cache de grace"
    // DESPUES de haber intentado validar, que es el caso que origino la SPEC.
    const hub = await resolveHubUrl();
    const context = buildFailureContext({ scenario: SCENARIO_NO_LICENSE_KEY, hub, ca: null });
    await syncSkillServerEntry(null);
    await logLine({
      level: 'warn',
      msg: 'no license key encontrada — skills libres solamente',
      tenantSlug,
    });
    // SPEC-0187 P7 — con tenant declarado, "no hay licencia" puede ser "la licencia esta
    // guardada bajo las claves viejas": el aviso lo nombra en vez de dejar el room mudo. Sin
    // tenant declarado no se agrega nada — una sesion sin SpecOE no gana avisos nuevos.
    let tenantNotice = null;
    if (tenantSlug) {
      const material = await readIdentityMaterialScoped({ tenantSlug });
      tenantNotice = buildTenantScopeNotice({
        scopeNotice: material.notice,
        licensePresent: false,
      });
    }
    emitContext('no-license', context + (tenantNotice ?? ''));
    return 0;
  }

  await logProcessContext();

  const fingerprint = await computeLocalFingerprint();
  const hub = await resolveHubUrl();
  const { url: hubUrl, source: hubUrlSource } = hub;
  await logLine({ level: 'info', msg: 'hub url resuelta', hubUrl, source: hubUrlSource });

  // aplicar el canal de CA ANTES de cualquier request al Hub. El resultado se retiene:
  // es el dato 3 del diagnostico, y sin el "no llegue" no se distingue de "no llegue
  // porque el CA no esta en el trust".
  const ca = await openCaChannel();

  // activar el fingerprint (idempotente) antes de validar.
  await activateFingerprint(hubUrl, licenseKey, fingerprint);

  // TKT-0232 — el userId del seat. En USER-mode el claim `sddRole` del JWT deriva de los
  // UserSddRole de ESTE usuario y la derivacion es fail-closed: sin `userContext` el Hub
  // emite el JWT SIN claim, el skill-server resuelve rol null y el room corre como
  // producto. Mandarlo NO es condicional al modo: en MACHINE-mode el Hub lo ignora, asi
  // que el hook no tiene que adivinar en que modo esta el tenant. `null` reproduce
  // exactamente el body anterior.
  const userCtx = await resolveUserContext({
    hubUrl,
    timeoutMs: fetchDeadlineMs(),
    allowDerive: HOOK_BUDGET_MS - (Date.now() - STARTED_AT) >= MIN_DERIVE_BUDGET_MS,
    tenantSlug,
  });
  await logLine({
    level: userCtx.userId ? 'info' : 'warn',
    msg: userCtx.userId
      ? 'userContext resuelto — el validate puede derivar el rol en USER-mode'
      : 'sin userContext — en USER-mode el JWT sale SIN claim sddRole (bundle producto)',
    source: userCtx.source,
    reason: userCtx.reason,
    // SPEC-0187 P7 — de QUE tenant salio el material, y por que criterio se eligio. Sin este
    // dato, un room que opera con la identidad de otro tenant no se distingue en el log.
    tenantSlug: userCtx.scope?.tenantSlug ?? null,
    tenantScope: userCtx.scope?.outcome ?? null,
  });

  // SPEC-0176 P2 — el rol que esta carpeta declara. Viaja en el MISMO validate: cero
  // requests nuevos, cero lecturas de disco. Sin la env queda null y el body es el de antes.
  const declaredRole = resolveDeclaredRole();

  const validateUrl = `${hubUrl}/license/validate`;
  // Que fallo exactamente: `net` => no hubo respuesta (red/TLS); `httpStatus` => el Hub
  // contesto y rechazo. Son excluyentes y son los que eligen el escenario del mensaje.
  let net = null;
  let httpStatus = null;
  try {
    const res = await fetch(validateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey,
        fingerprint,
        ...(userCtx.userId ? { userContext: userCtx.userId } : {}),
        ...(declaredRole ? { declaredRole } : {}),
      }),
      signal: AbortSignal.timeout(fetchDeadlineMs()),
    });
    // El request llego: el TLS valido. ESTA es la linea de exito del canal, y sale
    // recien aca porque es el unico punto donde el efecto quedo comprobado.
    await logLine({ level: 'info', msg: 'canal TLS verificado contra el Hub', hubUrl });
    if (res.ok) {
      const body = await res.json();
      const cached = {
        licenseKey,
        validatedAt: new Date().toISOString(),
        token: body.token,
        tenantId: body.tenantId,
        // SPEC-0187 P7 — de que tenant es esta licencia, con el mismo slug que declara el room:
        // es lo que permite descartar el cache cuando la carpeta cambia de tenant.
        ...(tenantSlug ? { tenantSlug } : {}),
        tier: body.tier,
        features: body.features,
      };
      await writeCache(cached);
      // poblar el JWT del skill-server para el MCP `specoe`.
      await populateSkillJwt(body.token);
      await logLine({ level: 'info', msg: 'license validated', tier: body.tier });
      // SPEC-0176 P2 — el veredicto de rol del Hub. La linea de log va SIEMPRE (es como se
      // cuentan las poblaciones); el aviso al dev sale solo cuando le negaron un rol que
      // pidio. AUSENTE en MACHINE-mode (ADR-006): ahi `roleResolution` no viene y no hay
      // veredicto, solo queda registrado lo que el room declaro.
      const roleResolution = body.roleResolution ?? null;
      // SPEC-0187 P4 — el diagnostico de autorizacion del equipo. ADITIVO y solo presente en
      // USER-mode con userContext: sin el campo (Hub anterior a P3) todo lo de abajo es null y
      // el output queda byte-igual al vigente.
      const machineAuthorization = body.machineAuthorization ?? null;
      await logLine(buildRoleResolutionLog({ roleResolution, declaredRole, machineAuthorization }));
      const roleNotice = buildRoleNotice(roleResolution);
      // El discriminador de ruido (ADR-002): identidad SDD resuelta = instalacion SDD. Se lee
      // del userContext que YA se resolvio arriba — cero requests y cero lecturas nuevas. Una
      // maquina con material en el canal pero sin userId resuelto (derivacion sin presupuesto,
      // canje rechazado) cuenta como AUSENTE y no recibe aviso: degrada al comportamiento de
      // hoy, que es el error barato. El caro es avisarle a una instalacion de producto.
      const startupNotice = buildStartupDiagnosis({
        machineAuthorization,
        roleResolution,
        sddIdentityPresent: Boolean(userCtx.userId),
      });
      // SPEC-0187 P7 — el aviso del aislamiento por tenant es OTRO canal y sale ademas del de
      // arriba: son hechos distintos (uno habla del equipo en el Hub, este de que identidad
      // local se pudo resolver) y callar este deja al dev con un room mudo.
      const tenantNotice = buildTenantScopeNotice({ scopeNotice: userCtx.scope?.notice ?? null });
      // Output JSON para el harness (puede usar hookSpecificOutput para env vars).
      console.log(
        JSON.stringify({
          specoeStatus: 'ok',
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext:
              `SpecOE license: tier=${body.tier}, features=${body.features.length}` +
              (roleNotice ?? '') +
              (startupNotice ?? '') +
              (tenantNotice ?? ''),
          },
        }),
      );
      return 0;
    }
    httpStatus = res.status;
    await logLine({ level: 'warn', msg: 'validate failed', status: res.status, url: validateUrl });
    // Fallthrough al grace period
  } catch (err) {
    net = describeNetworkError(err);
    await logLine({
      level: 'warn',
      msg: 'validate network error',
      code: net.code,
      cause: net.cause,
      error: net.message,
      url: validateUrl,
    });
  }

  const diag = {
    scenario: net ? SCENARIO_NO_HUB_RESPONSE : SCENARIO_LICENSE_REJECTED,
    net,
    httpStatus,
    hub,
    ca,
  };

  // Grace period: usar cache si esta fresco. ADR-002 — con cache dentro de las 24 h la
  // sesion ARRANCA, pero ya no en silencio: el mensaje visible lleva el mismo cuerpo de
  // datos que el bloqueo. Es la diferencia entre el corte de red pasajero y la instalacion
  // que nunca funciono, y el dev tiene que poder verla sin abrir el log.
  const cache = await readCache();
  const graceHours = DEFAULT_GRACE_HOURS; // TODO: leer de tier-specific config
  if (cache && isCacheWithinGrace(cache, graceHours)) {
    await logLine({ level: 'info', msg: 'using cached license (offline grace)', tier: cache.tier });
    await syncSkillServerEntry(usableCachedToken(cache));
    emitContext(
      'cached',
      // El titular del diagnostico dice si el Hub no contesto o si contesto rechazando;
      // esta linea no lo adelanta, para no volver a poner una causa falsa arriba de todo.
      `SpecOE license (offline, cache fresco): tier=${cache.tier}. La sesion arranca por el grace period de ${graceHours} h, pero la validacion contra el Hub NO paso en esta corrida:\n` +
        buildFailureContext(diag),
    );
    return 0;
  }

  // Sin cache de grace. Aca es donde ADR-002 corta.
  await syncSkillServerEntry(null);
  const escapeUsed = await escapeHatchReason();
  if (escapeUsed) {
    await logLine({
      level: 'warn',
      msg: 'degradado a proposito — via de escape activa, no se bloquea',
      escapeUsed,
    });
    emitContext('degraded', buildFailureContext({ ...diag, escapeUsed }));
    return 0;
  }
  return blockSession(diag);
}

// Guarda de entry point — solo corre main() cuando el archivo ES el proceso, nunca al
// importarlo. Sin esto, cualquier herramienta que importe este hook para inspeccionarlo
// (el verificador del canal, la suite de tests) moria en el process.exit() de abajo
// ANTES de emitir su veredicto: exit 0 sin haber chequeado nada, o sea el verde falso
// que esta SPEC existe para matar, reintroducido en la herramienta que lo detecta.
// Mismo mecanismo que specoe-room-bootstrap.mjs.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => process.exit(code || 0))
    .catch(async (err) => {
      await logLine({ level: 'error', msg: 'unhandled', error: err?.message, stack: err?.stack });
      // NUNCA bloquear sesion.
      process.exit(0);
    });
}
