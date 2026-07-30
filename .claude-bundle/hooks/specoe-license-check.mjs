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
import { pathToFileURL } from 'node:url';
import { applyCaChannel, describeNetworkError, DEFAULT_CA_PATH } from './ca-channel.mjs';
import { resolveUserContext } from './sdd-identity.mjs';

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
    // node-machine-id es CommonJS — dynamic import retorna { default: module.exports }
    const mod = await import('node-machine-id');
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

async function getLicenseKey() {
  // 1. Env var
  if (process.env.SPECOE_LICENSE_KEY) return process.env.SPECOE_LICENSE_KEY;

  // 2. Keyring — multi-rol: account = rol de la carpeta; fallback 'default'
  //    (retrocompat 1-rol). getPassword tira si el account no existe → probamos uno a uno.
  try {
    const kr = await import('@napi-rs/keyring').catch(() => null);
    if (kr) {
      const { Entry } = kr;
      const role = await resolveRole();
      for (const account of [role, 'default'].filter(Boolean)) {
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
  const cache = await readCache();
  if (cache?.licenseKey) return cache.licenseKey;

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
  return (
    `\n\n[[${ROLE_REJECTED_PREFIX}]] ATENCION: la licencia es valida, pero la AUTORIZACION ` +
    `DE ROL fallo. Este room declaro el rol ${declarado} (env INTEGRA_SDD_ROLE) y el Hub NO ` +
    `lo tiene concedido a tu usuario: el JWT sale SIN claim sddRole, asi que los tools MCP ` +
    `de esta sesion van a servir el bundle PRODUCTO, no el de ${declarado}. La sesion ` +
    `arranca igual — esto no corta el arranque. Accion: pedi a un ADMIN del tenant que te ` +
    `conceda ${declarado} en Administracion -> Identidad SDD, o corregi INTEGRA_SDD_ROLE en ` +
    `el launcher de esta carpeta si el rol que declaraste no es el que te toca.`
  );
}

/**
 * La linea de log estructurada del veredicto. Los tres datos que hacen falta para contar
 * poblaciones sin ir maquina por maquina: que pidio el room, que le sirvio el Hub, y con
 * que outcome. `declaredRole` cae al valor que ESTE hook mando cuando la respuesta no trae
 * `roleResolution` (MACHINE-mode, ADR-006): ahi no hay veredicto que registrar, pero lo que
 * el room declaro sigue siendo el dato util.
 */
export function buildRoleResolutionLog({ roleResolution, declaredRole }) {
  const outcome = roleResolution?.outcome ?? null;
  return {
    level: outcome === OUTCOME_ROLE_NOT_GRANTED ? 'warn' : 'info',
    msg: 'resolucion de rol del Hub',
    outcome,
    declaredRole: roleResolution?.declaredRole ?? declaredRole ?? null,
    servedRole: roleResolution?.servedRole ?? null,
  };
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
  const licenseKey = await getLicenseKey();
  if (!licenseKey) {
    // Escenario 3. NO bloquea: este hook se registra global (~/.claude/settings.json) y
    // corre en toda sesion de Claude Code de la maquina. Una carpeta sin licencia no es un
    // room de SpecOE roto — es una sesion sin SpecOE, y cortarla seria bloquear al dev en
    // trabajo que nada tiene que ver. Q8 acota el bloqueo a "no hay cache de grace"
    // DESPUES de haber intentado validar, que es el caso que origino la SPEC.
    const hub = await resolveHubUrl();
    const context = buildFailureContext({ scenario: SCENARIO_NO_LICENSE_KEY, hub, ca: null });
    await syncSkillServerEntry(null);
    await logLine({ level: 'warn', msg: 'no license key encontrada — skills libres solamente' });
    emitContext('no-license', context);
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
  });
  await logLine({
    level: userCtx.userId ? 'info' : 'warn',
    msg: userCtx.userId
      ? 'userContext resuelto — el validate puede derivar el rol en USER-mode'
      : 'sin userContext — en USER-mode el JWT sale SIN claim sddRole (bundle producto)',
    source: userCtx.source,
    reason: userCtx.reason,
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
      await logLine(buildRoleResolutionLog({ roleResolution, declaredRole }));
      const roleNotice = buildRoleNotice(roleResolution);
      // Output JSON para el harness (puede usar hookSpecificOutput para env vars).
      console.log(
        JSON.stringify({
          specoeStatus: 'ok',
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext:
              `SpecOE license: tier=${body.tier}, features=${body.features.length}` +
              (roleNotice ?? ''),
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
