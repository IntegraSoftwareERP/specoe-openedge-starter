#!/usr/bin/env node
// SessionStart hook: baja el contrato del room
// del rol autenticado desde el MCP Skill Server y lo inyecta por additionalContext.
//
// Es la pieza del "thin client diskless": el room del cliente NO lleva su CLAUDE.md
// ni sus skills en disco (los peló T5.3). El contrato de gobierno del rol vive
// server-side y baja en cada arranque de sesion, autenticado con el JWT de licencia.
//
// Relacion con specoe-license-check.mjs: ese hook valida la licencia y deja el JWT fresco en
// <carpeta>/.claude/specoe-license-cache.json. Este hook REUSA ese token (no re-valida): el
// rol sale del claim `sddRole` del JWT (lo mismo que verifica el authMiddleware del
// skill-server).
//
// TKT-0454 — los dos corren EN PARALELO, no uno despues del otro. Estar antes en el array de
// SessionStart de settings.json no ordena nada: Claude Code corre en paralelo todos los hooks
// que matchean un evento ("All matching hooks run in parallel", code.claude.com/docs/en/hooks).
// Este archivo afirmaba lo contrario y leia el cache apenas arrancaba: si la sesion anterior
// habia sido hace mas de 55 min, declaraba el room ungoverned (no-token) aunque la licencia
// validara un instante despues. Ahora, si el cache no trae un token usable, lo ESPERA: relee
// el cache hasta que el hook de licencia lo refresque o se venza el plazo (waitForUsableToken).
//
// Canal (verificado en el skill-server):
//   1. GET  {SKILL_SERVER_URL}         -> abre SSE, Authorization: Bearer <jwt>
//   2. tool room_contract_get {}       -> el rol sale del AuthContext (claim), paramless
//   -> { content: [{ type:'text', text: <markdown del contrato del room> }] }
//   Producto (sddRole ausente => role=null) => el tool responde isError; no inyectamos.
//
// Defensa/UX: este hook NUNCA bloquea el arranque (exit 0 SIEMPRE). Fallo de red, server
// caido, licencia sin rol o timeout => sesion arranca igual, sin contrato inyectado. El
// enforcement real del rol vive en el backend (403 del Hub), no en este hook.
// Lo que si cambio (SPEC-0164 P2 / T2.4): arrancar sin contrato ya no es MUDO. Los cuatro
// caminos de fallo emiten un additionalContext que declara que el room opera SIN su
// contrato de gobierno y por que. El bloqueo por licencia, cuando corresponde, lo decide
// specoe-license-check.mjs; este hook solo declara.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyCaChannel, describeNetworkError, DEFAULT_CA_PATH } from './ca-channel.mjs';
import { loadMcpClient } from './vendor-deps.mjs';

// multi-rol — el cache de licencia vive POR-CARPETA (cwd de la sesion), igual que
// en specoe-license-check.mjs. Antes era global (~/.claude): con varios roles a la vez el
// ultimo pisaba a los demas y el bootstrap bajaba el contrato del rol equivocado.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CACHE_FILE = path.join(PROJECT_DIR, '.claude', 'specoe-license-cache.json');
// TKT-0225 — el .mcp.json de la MISMA carpeta: es de donde el cliente MCP de Claude Code
// saca el token con el que corren los tools, y no tiene por que ser el del cache.
const MCP_JSON_FILE = path.join(PROJECT_DIR, '.mcp.json');
const DEFAULT_SKILL_SERVER_URL =
  process.env.SPECOE_SKILL_SERVER_URL || 'https://mcp.integra.local/sse';
// Margen del timeout del hook (settings.json le da 15s). Cortamos la red antes para
// garantizar exit 0 limpio aunque el server no responda.
const NETWORK_DEADLINE_MS = Number.parseInt(process.env.SPECOE_BOOTSTRAP_TIMEOUT_MS || '10000', 10);
// TKT-0454 — la espera al hook de licencia sale del MISMO presupuesto de 15 s, asi que la red ya
// no tiene 10 s garantizados: tiene lo que queda hasta HOOK_BUDGET_MS (1 s de margen para el log
// y el emit), con MIN_NETWORK_MS de piso para no intentar un fetch que no puede terminar.
const HOOK_BUDGET_MS = Number.parseInt(process.env.SPECOE_BOOTSTRAP_BUDGET_MS || '14000', 10);
const MIN_NETWORK_MS = 1000;
const STARTED_AT = Date.now();
// Cuanto se espera a que el hook de licencia refresque el cache. Su timeout en settings.json es
// 5 s (el harness lo mata ahi) y escribe el cache al final de su camino feliz: si a los 6 s no
// hay token usable, no lo va a haber en esta sesion. El margen cubre que los dos procesos no
// arrancan en el mismo milisegundo.
const LICENSE_WAIT_MS = Number.parseInt(process.env.SPECOE_BOOTSTRAP_LICENSE_WAIT_MS || '6000', 10);
const LICENSE_POLL_MS = 200;
// El JWT de licencia vive 1h (ACCESS_TOKEN_TTL_SECONDS). Pasados ~55 min esta por expirar o
// expiro: el skill-server daria 401. Mismo umbral que SKILL_JWT_MAX_AGE_MS del license-check.
const CACHE_TOKEN_MAX_AGE_MS = 55 * 60 * 1000;
// Sentinel estable para el probe determinista (T5.3): marca inequivoca de que el
// contrato bajo del server y se inyecto (no vino de un CLAUDE.md en disco).
const SENTINEL_PREFIX = 'SPECOE-ROOM-CONTRACT';
const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');

// Este hook era MUDO: fail-open silencioso en el canal de CA (catch vacio) y en la red.
// Un arranque sin contrato del room no dejaba rastro de por que. Ahora deja linea.
// No rompe por log ni cambia el fail-open: sigue siendo exit 0 pase lo que pase.
async function logLine(obj) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `specoe-room-bootstrap-${today}.log`);
    await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    /* no romper por log */
  }
}

/**
 * El token usable de un cache ya leido, o null. Pura: la suite la ejercita sin disco.
 * Si el cache no trae token o tiene mas de CACHE_TOKEN_MAX_AGE_MS, no sirve.
 */
export function usableCacheToken(cache, now = Date.now()) {
  if (!cache?.token) return null;
  if (cache.validatedAt) {
    const ageMs = now - new Date(cache.validatedAt).getTime();
    if (ageMs > CACHE_TOKEN_MAX_AGE_MS) return null;
  }
  return cache.token;
}

// Lee el JWT de licencia que dejo specoe-license-check.mjs en el cache. No re-valida:
// si el token no esta o el cache es viejo, devuelve null.
async function readCachedToken() {
  try {
    return usableCacheToken(JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * TKT-0454 — espera a que el cache traiga un token usable, releyendolo cada `pollMs` hasta
 * `waitMs`. Con un token usable en la primera lectura no espera nada: es el caso de la sesion
 * que arranca dentro de los 55 min de la anterior, y ahi el token del cache sirve aunque el hook
 * de licencia lo este renovando en paralelo.
 *
 * Por que esperar y no juntar los dos hooks en uno: asi el arreglo viaja por UN solo canal —los
 * archivos de hooks que instala la parte de maquina (setup.sh --host-only, install_force)— y
 * funciona con cualquier version del .claude/settings.json del room. Juntarlos obligaba a mover
 * dos canales a la vez: el settings.json llega con el pull de la carpeta y el hook nuevo con la
 * parte de maquina. Con uno adelantado y el otro no, o el settings nombra un hook que no esta
 * instalado, o la carrera sigue igual.
 *
 * La lectura, el sleep y el reloj se inyectan para que la suite mida la espera sin disco ni
 * tiempo real. `polls` = cuantas relecturas hubo despues de la primera (0 = no espero).
 */
export async function waitForUsableToken({
  readToken,
  waitMs,
  pollMs = LICENSE_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const start = now();
  let token = await readToken();
  let polls = 0;
  while (!token && now() - start < waitMs) {
    await sleep(Math.max(0, Math.min(pollMs, waitMs - (now() - start))));
    token = await readToken();
    polls += 1;
  }
  return { token, polls, waitedMs: now() - start };
}

/** Lo que le queda a la red del presupuesto del hook, con piso MIN_NETWORK_MS. */
function networkDeadlineMs() {
  const left = HOOK_BUDGET_MS - (Date.now() - STARTED_AT);
  return Math.max(MIN_NETWORK_MS, Math.min(NETWORK_DEADLINE_MS, left));
}

// Decodifica el payload del JWT SIN verificar firma (solo para leer el claim sddRole).
// La verificacion real la hace el skill-server con LICENSE_JWT_SECRET; aca solo
// decidimos si vale la pena la llamada.
export function decodeRole(jwtToken) {
  try {
    const [, payloadB64] = jwtToken.split('.');
    if (!payloadB64) return null;
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    return payload?.sddRole ?? null;
  } catch {
    return null;
  }
}

/**
 * SPEC-0237 P4 — los claims que el registro del room guarda de cada apertura de /sse (ADR-003):
 * tenantId, sddRole, iat y exp. Nunca el token. Sin verificar firma, como decodeRole.
 */
export function decodeClaims(jwtToken) {
  try {
    const [, payloadB64] = String(jwtToken ?? '').split('.');
    if (!payloadB64) return {};
    const p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const num = (v) => (Number.isFinite(v) ? v : undefined);
    const str = (v) => (typeof v === 'string' ? v : undefined);
    return {
      tenantId: str(p?.tenantId),
      sddRole: str(p?.sddRole),
      iat: num(p?.iat),
      exp: num(p?.exp),
    };
  } catch {
    return {};
  }
}

/**
 * El rol que la SESION declara (INTEGRA_SDD_ROLE), normalizado trim+upper porque lo exporta un
 * launcher escrito a mano. null sin la env. Es la misma normalizacion que usa el hook de licencia
 * para el `declaredRole` del validate (resolveDeclaredRole la delega aca): dos normalizaciones del
 * mismo valor podrian discrepar en el caso exacto que este archivo existe para detectar.
 */
export function declaredRoleFromEnv(env = process.env) {
  return env.INTEGRA_SDD_ROLE?.trim().toUpperCase() || null;
}

// ----- TKT-0225 — divergencia de tokens entre este hook y el cliente MCP -----
//
// Este hook baja el contrato con el token del CACHE por-carpeta. Los tools MCP de la misma
// sesion corren con el token escrito en el .mcp.json de la carpeta. specoe-license-check.mjs
// escribe los dos juntos y con el mismo valor en todos sus caminos, pero nada impide que se
// separen despues: una edicion a mano del .mcp.json alcanza. Cuando eso pasa, el contrato
// inyectado es el de un rol y el bundle servido por los tools es el de otro (o el de
// producto) — y hasta este fix la sesion arrancaba sin decirlo. El rotulo del sentinel no
// miente (el contrato SI bajo del server), pero cuenta media historia.
//
// El prefijo es OTRO a proposito, igual que UNGOVERNED: no contiene ni `SPECOE-ROOM-CONTRACT`
// ni `SPECOE-ROOM-UNGOVERNED` como subcadena, asi que un probe puede afirmar la presencia de
// esta advertencia y la del sentinel de forma independiente en el mismo texto.
export const DIVERGENCE_PREFIX = 'SPECOE-ROOM-TOKEN-DIVERGENTE';

export function buildTokenDivergenceWarning(rolDelCache, rolDelMcpJson) {
  const claim = (r) => r ?? 'sin claim sddRole';
  return (
    `\n\n[[${DIVERGENCE_PREFIX}]] ATENCION: el JWT con el que se bajo este contrato NO es el ` +
    `que van a usar los tools MCP de esta sesion. El contrato de arriba se bajo con el token ` +
    `del cache de licencia de esta carpeta (claim: ${claim(rolDelCache)}); el server specoe ` +
    `de ${MCP_JSON_FILE} declara OTRO token (claim: ${claim(rolDelMcpJson)}). Los tools MCP ` +
    `pueden estar sirviendo el bundle de otro rol —o el de producto— mientras esta sesion se ` +
    `gobierna con el contrato de arriba. Reabri la sesion sin editar el .mcp.json a mano: el ` +
    `hook de licencia escribe el mismo token en los dos lados. Corre ./specoe-verify-room.sh ` +
    `para el veredicto (su chequeo 5 cruza los dos tokens).`
  );
}

// ----- SPEC-0237 P4 — la entrada `specoe` del proxy del room (ADR-005, ADR-007) -----
//
// Desde SPEC-0237 la entrada `specoe` del .mcp.json tiene DOS formas posibles:
//   - la del proxy: { type: 'stdio', command: 'node', args: ['--use-system-ca',
//     'vendor/specoe-mcp-proxy.mjs'] }, sin JWT, sin url y sin headers. Claude Code habla con un
//     proceso local que saca el JWT del cache de esta carpeta, lo renueva y reabre /sse solo;
//   - la SSE de antes, con el JWT inline. La conserva el room ATRASADO, el que todavia no trae el
//     proxy en su vendor/ (F20): escribirle la del proxy apuntaria a un archivo que no esta.
// La forma del proxy la fabrica el PROPIO proxy (`--install-entry`, buildSpecoeEntry): nadie la
// copia. Lo que vive aca es lo que necesitan los que leen o deciden: reconocer la entrada
// (isProxyEntry), saber si el room trae el proxy que su MANIFEST declara (roomProxyStatus) y
// pedirle al proxy del room que escriba su entrada (runProxyInstallEntry). Lo usan este hook, el de
// licencia y el verificador del room; vive en este archivo porque los otros dos ya lo importan, y
// importarlo no tiene efectos (guarda de isMain).
export const PROXY_VENDOR_PATH = 'vendor/specoe-mcp-proxy.mjs';
export const PROXY_COMPONENT = 'specoe-mcp-proxy';
const PROXY_FILE_NAME = 'specoe-mcp-proxy.mjs';
const VENDOR_MANIFEST_RELATIVE = path.join('vendor', 'MANIFEST.json');

/**
 * La entrada lanza el proxy del room por stdio? Se reconoce por el ARCHIVO que lanza y no por la
 * forma exacta: lo que decide si la sesion necesita reiniciarse, o si la divergencia se mide por
 * rol, es que Claude Code hable con el proxy. Si la forma es la canonica lo juzga el chequeo 3 del
 * verificador, contra el propio proxy. Pura.
 */
export function isProxyEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.type !== undefined && entry.type !== 'stdio') return false;
  if (typeof entry.command !== 'string' || !Array.isArray(entry.args)) return false;
  return entry.args.some(
    (a) =>
      typeof a === 'string' && a.replace(/\\/g, '/').replace(/^\.\//, '') === PROXY_VENDOR_PATH,
  );
}

/**
 * El proxy que trae ESTE room: `{ ok: true, file, sha256, sourceSha }` si vendor/MANIFEST.json
 * declara el componente specoe-mcp-proxy y vendor/specoe-mcp-proxy.mjs tiene ese packageSha256.
 * Si no, `{ ok: false, motivo, detalle }` con motivo `sin-manifest` (la carpeta no es un room),
 * `manifest-ilegible`, `sin-componente` (room anterior al proxy), `sin-archivo` o `sha-distinto`.
 * Se mira el sha y no solo que el archivo este: un archivo a medio copiar o de otra version es un
 * proxy que nadie declaro.
 */
export async function roomProxyStatus(roomDir) {
  const manifestFile = path.join(roomDir, VENDOR_MANIFEST_RELATIVE);
  const file = path.join(roomDir, PROXY_VENDOR_PATH);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { ok: false, motivo: 'sin-manifest', detalle: `no hay ${manifestFile}` }
      : {
          ok: false,
          motivo: 'manifest-ilegible',
          detalle: `${manifestFile} no se pudo leer como JSON (${err?.message})`,
        };
  }
  const component = (Array.isArray(manifest?.components) ? manifest.components : []).find(
    (c) =>
      c?.name === PROXY_COMPONENT &&
      c?.file === PROXY_FILE_NAME &&
      (c?.basePath === undefined || c?.basePath === 'vendor'),
  );
  if (!component || typeof component.packageSha256 !== 'string') {
    return {
      ok: false,
      motivo: 'sin-componente',
      detalle: `${manifestFile} no declara el componente ${PROXY_COMPONENT} (room anterior al proxy)`,
    };
  }
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch {
    return {
      ok: false,
      motivo: 'sin-archivo',
      detalle: `el MANIFEST declara ${PROXY_COMPONENT} pero ${file} no esta`,
    };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== component.packageSha256.toLowerCase()) {
    return {
      ok: false,
      motivo: 'sha-distinto',
      detalle: `${file} tiene sha256 ${sha256.slice(0, 12)} y el MANIFEST declara ${component.packageSha256.slice(0, 12)}`,
    };
  }
  return { ok: true, file, sha256, sourceSha: component.sourceSha ?? null };
}

/**
 * Corre el proxy del room en modo `--install-entry` sobre el .mcp.json de `targetDir` (por defecto
 * el mismo room). Devuelve `{ ok, outcome: 'WRITTEN' | 'UNCHANGED' | 'ERROR', error? }`. Es el
 * unico camino por el que un escritor de este repo pone la entrada del proxy: la arma el proxy.
 * No abre red. El verificador lo usa sobre una COPIA del .mcp.json para preguntarle al proxy si la
 * entrada ya es la suya (UNCHANGED) sin tocar la carpeta.
 */
export function runProxyInstallEntry({
  roomDir,
  targetDir = roomDir,
  timeoutMs = 3000,
  nodeBin = process.execPath,
}) {
  return new Promise((resolve) => {
    execFile(
      nodeBin,
      [path.join(roomDir, PROXY_VENDOR_PATH), '--install-entry', '--room', targetDir],
      { cwd: roomDir, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 16 },
      (err, stdout) => {
        const line = String(stdout ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        let parsed = null;
        try {
          parsed = line ? JSON.parse(line) : null;
        } catch {
          /* salida ilegible: se nombra abajo */
        }
        if (parsed?.v === 1 && typeof parsed.outcome === 'string') {
          const ok = !err && parsed.outcome !== 'ERROR';
          resolve({
            ok,
            outcome: parsed.outcome,
            error: parsed.error ?? (ok ? null : err?.message),
          });
          return;
        }
        resolve({
          ok: false,
          outcome: 'ERROR',
          error: err?.killed
            ? `el proxy no respondio en ${timeoutMs} ms`
            : (err?.message ?? 'salida ilegible del proxy'),
        });
      },
    );
  });
}

/**
 * ADR-007 — con la entrada del proxy el .mcp.json no lleva JWT: los tools MCP corren con el del
 * cache de esta carpeta, el MISMO con el que este hook baja el contrato. Comparar tokens queda sin
 * objeto, y la divergencia que queda es otra: que la carpeta sirva un rol distinto del que la
 * sesion declara. Devuelve `{ servido, declarado }` cuando el claim sddRole del cache difiere del
 * rol declarado, o null si coinciden o si no hay con que comparar (sin token o sin rol declarado).
 * No se compara el token del proxy contra el del cache: una renovacion legitima los separa sin
 * cambiar de rol. Pura.
 */
export function detectRoleDivergence({ cacheToken, declaredRole }) {
  if (!cacheToken || !declaredRole) return null;
  const claim = decodeRole(cacheToken);
  const servido = typeof claim === 'string' ? claim.trim().toUpperCase() : null;
  if (servido === declaredRole) return null;
  return { servido, declarado: declaredRole };
}

export function buildRoleDivergenceWarning(rolServido, rolDeclarado) {
  const servido = rolServido ?? 'sin claim sddRole (bundle producto)';
  return (
    `\n\n[[${DIVERGENCE_PREFIX}]] ATENCION: esta sesion declara el rol ${rolDeclarado} ` +
    `(INTEGRA_SDD_ROLE), pero el JWT del cache de licencia de esta carpeta es de ${servido}. Con ` +
    `la entrada del proxy (${PROXY_VENDOR_PATH}) los tools MCP de specoe corren con ESE JWT —el ` +
    `proxy lo toma del cache— y el contrato de arriba se bajo con el mismo, asi que la sesion ` +
    `trabaja como ${rolDeclarado} con el gobierno y el bundle de ${servido}. No lo arregla editar ` +
    `el .mcp.json: la entrada del proxy no lleva JWT. Abri la carpeta con el rol que le corresponde ` +
    `(el plugin de VSCode o ./specoe-launch-thinclient.sh <ROL>) y mira el aviso de rol del ` +
    `arranque: el hook de licencia pide el rol declarado y el Hub decide cual concede. Corre ` +
    `./specoe-verify-room.sh para el veredicto (sus chequeos 3 y 5 comparan el rol servido contra ` +
    `el declarado).`
  );
}

// ----- TKT-0317 — el repo de trabajo del room -----
//
// El room sabe cual es su rol y su tenant, pero no sabia cual es su REPO DE TRABAJO. La carpeta
// del room ES un repo git —un clon shallow del starter, con sparse-checkout— y no es donde vive
// el codigo del cliente. Las herramientas de aislamiento del harness operan sobre el repo del
// cwd, asi que apuntan a ese clon: el `git worktree add` cae en el repo equivocado y falla
// (`core.worktree redirect`) o, peor, ensucia el clon del starter.
//
// El agente no puede deducirlo: no hay nada en la carpeta que nombre el repo del codigo. Por eso
// la declaracion (`specoe.work-repo` del yaml, o INTEGRA_SDD_WORK_REPO que exporta el launcher) y
// por eso este aviso, que viaja por el MISMO canal que el contrato del room y por los CUATRO
// caminos de salida — un room que arranca ungoverned igual va a querer aislar trabajo.
//
// El prefijo es OTRO a proposito, como UNGOVERNED y TOKEN-DIVERGENTE: no contiene ni esta
// contenido en ninguno de los otros, asi que un probe puede afirmar cada uno por separado.
//
// SPEC-0208 P5 — la declaracion pasa de UNA ruta a N. Un room puede trabajar contra varios repos
// (el caso que la SPEC modela con ProjectRepo del lado del Hub), asi que la clave acepta escalar
// y lista bajo el MISMO nombre, y el aviso emite un veredicto POR RUTA: una rota no tapa a una
// valida ni al reves. El escalar sigue valiendo por compatibilidad — ver parseWorkRepoValue.
export const WORK_REPO_PREFIX = 'SPECOE-ROOM-WORK-REPO';

/**
 * Escalar del `project.config.yaml` ANCLADO a su seccion — mismo criterio que `specoe_yaml_get`
 * del bundle (specoe-yaml.sh) y que el lector del plugin.
 *
 * Hasta TKT-0448 los lectores de specoe-license-check.mjs (rol, tenant, URL del Hub) eran regex
 * globales sobre el archivo entero, que andaban porque no habia una clave homonima antes y no por
 * construccion (el defecto que cerro TKT-0256). Desde TKT-0448 leen por `readRoomScalar`, o sea
 * por este lector anclado. `repo` NO es un nombre libre en este yaml —`paths.repos` existe—.
 */
export function readSpecoeScalar(content, section, key) {
  let inBlock = false;
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    // Toda linea sin indentar abre un bloque top-level (y cierra el anterior).
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

/**
 * TKT-0448 — la config PROPIA del room vive en `project.config.local.yaml`, al lado del versionado
 * y con su misma forma. El versionado queda como lo publica el starter: escribirle las
 * declaraciones del room lo dejaba modificado y hacia chocar el `pull --ff-only` de cada release.
 * Decision del Operador 2026-09-23 (comment Hub cmueglfsr01gdny8myu61lp5d).
 */
export const ROOM_LOCAL_CONFIG = 'project.config.local.yaml';

/**
 * La precedencia, pura: si el local DECLARA la clave gana —aunque este vacia, que es una
 * declaracion—; si no la declara, vale la del versionado. Un room sin migrar no tiene local y se
 * lee exactamente como antes. Es la MISMA regla que `specoe_room_get` (specoe-yaml.sh) y que el
 * lector del plugin: los tres lados tienen que coincidir o un room se leeria distinto segun quien
 * pregunte.
 *
 * Devuelve tambien de QUE archivo salio el valor: los diagnosticos que dicen "la URL salio de X"
 * tienen que nombrar el archivo que de verdad gano.
 */
export function pickRoomScalar(localContent, sharedContent, section, key) {
  const fromLocal = localContent == null ? undefined : readSpecoeScalar(localContent, section, key);
  if (fromLocal !== undefined) return { value: fromLocal, source: ROOM_LOCAL_CONFIG };
  const fromShared =
    sharedContent == null ? undefined : readSpecoeScalar(sharedContent, section, key);
  if (fromShared !== undefined) return { value: fromShared, source: 'project.config.yaml' };
  return { value: undefined, source: null };
}

/** Lee los dos archivos del room `roomDir` y aplica la precedencia. Nunca tira. */
export async function readRoomScalarWithSource(roomDir, section, key) {
  const leer = async (nombre) => {
    try {
      return await fs.readFile(path.join(roomDir, nombre), 'utf8');
    } catch {
      return undefined;
    }
  };
  const [local, shared] = await Promise.all([leer(ROOM_LOCAL_CONFIG), leer('project.config.yaml')]);
  return pickRoomScalar(local, shared, section, key);
}

/** Idem, sólo el valor (`undefined` si ninguno de los dos archivos declara la clave). */
export async function readRoomScalar(roomDir, section, key) {
  return (await readRoomScalarWithSource(roomDir, section, key)).value;
}

/**
 * Separador con el que el launcher exporta N rutas en INTEGRA_SDD_WORK_REPO, y con el que este
 * lector las parte (P5.T4, SPEC-0208). Es `|` y no `;` ni `,` por una razon concreta: `|` es uno
 * de los caracteres que Windows PROHIBE en un nombre de archivo (junto a \ / : * ? " < >), asi que
 * no puede aparecer dentro de una ruta declarada. `;` y `,` si son legales en Windows y partirian
 * una ruta al medio. Va declarado aca y en el comentario del launcher: los dos lados tienen que
 * usar el MISMO, y que se infiera de la lectura del codigo es exactamente como se desincronizan.
 */
export const WORK_REPO_SEPARATOR = '|';

/**
 * El valor crudo de `specoe.work-repo` normalizado a lista. Acepta las DOS formas bajo la MISMA
 * clave (ADR-009 de SPEC-0208):
 *
 *   - escalar  `work-repo: 'C:/a'`            -> ['C:/a']
 *   - lista    `work-repo: ['C:/a', 'C:/b']`  -> ['C:/a', 'C:/b']
 *   - vacio o ausente                         -> []
 *
 * El escalar NO es back-compat opcional: toda carpeta de room ya instalada lo tiene asi, y viven
 * en maquinas de devs, fuera de este repo. Un lector que solo entienda listas las deja a todas en
 * el caso `sin-declarar` en su proximo arranque, diciendole al agente que pregunte al operador
 * cual es su repo -- dano real y silencioso sobre rooms que estan bien configurados.
 *
 * La lista se escribe en FLOW (una sola linea) y no en bloque: los tres lectores/escritores de
 * este archivo (este, `specoe_yaml_get` y `specoe_yaml_set`) estan anclados a la linea de la
 * clave, y una forma multilinea obligaria a reescribir los tres. Limite conocido y aceptado: una
 * ruta SIN comillas que contenga una coma se parte al medio. El instalador siempre las escribe
 * entre comillas simples, que es la forma que el parseo respeta.
 */
export function parseWorkRepoValue(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  if (!value.startsWith('[')) return [value];

  const close = value.lastIndexOf(']');
  const inner = close === -1 ? value.slice(1) : value.slice(1, close);
  const items = [];
  let buf = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      items.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  items.push(buf);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** Las rutas declaradas en el yaml del room, en cualquiera de las dos formas. */
export function readSpecoeWorkRepos(content) {
  return parseWorkRepoValue(readSpecoeScalar(content, 'specoe', 'work-repo'));
}

/**
 * Los repos de trabajo declarados. Precedencia: la env que exporta el launcher > la clave del
 * yaml. El yaml se lee tambien a proposito: una carpeta abierta a mano (doble click, `code .`) no
 * tiene la env, y ahi el room igual sabe donde vive su codigo -- mismo criterio que el tenant.
 *
 * La env gana ENTERA: si trae rutas, el yaml no se mezcla. Mezclarlas obligaria a definir orden y
 * deduplicacion entre dos fuentes que pueden contradecirse, y la env existe justo para el caso en
 * que el yaml quedo viejo.
 */
async function resolveWorkRepos() {
  const fromEnv = (process.env.INTEGRA_SDD_WORK_REPO ?? '').trim();
  if (fromEnv) {
    return fromEnv
      .split(WORK_REPO_SEPARATOR)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  try {
    // TKT-0448 — con la precedencia del room: project.config.local.yaml gana sobre el versionado.
    return parseWorkRepoValue(await readRoomScalar(PROJECT_DIR, 'specoe', 'work-repo'));
  } catch {
    return [];
  }
}

/**
 * El aviso listo para concatenar. `entries` = la lista de rutas declaradas CON su veredicto:
 * `[{ path, isRepo }]`, donde `isRepo` dice si HOY hay un repo git ahi. Lista vacia = sin declarar.
 *
 * Sigue siendo funcion pura --la suite la ejercita sin disco ni red-- y por eso recibe el veredicto
 * por ruta ya medido en vez de tocar ella el filesystem.
 *
 * Cada ruta tiene su propio veredicto y NINGUNA tapa a otra: una lista con un repo valido y otro
 * roto dice las DOS cosas. Con una sola ruta el texto es IDENTICO al de antes de SPEC-0208 P5, que
 * es lo que garantiza que un room ya instalado (clave escalar) no note el cambio.
 *
 * Los tres casos dicen la misma cosa de fondo --el cwd NO es el repo del codigo-- porque es lo que
 * el agente no puede ver. La declaracion que apunta a la nada NO se calla: un dato escrito y
 * falso es peor que la ausencia, que al menos se nota.
 */
export function buildWorkRepoNotice(entries) {
  const lista = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const comun =
    `La carpeta de este room ES un repo git, pero NO es donde vive el codigo: es un clon shallow ` +
    `del starter. Las herramientas de aislamiento del harness (EnterWorktree y equivalentes) ` +
    `operan sobre el repo del cwd, asi que desde aca apuntan a ese clon.`;

  if (lista.length === 0) {
    return (
      `\n\n[[${WORK_REPO_PREFIX}:sin-declarar]] Este room NO declara su repo de trabajo. ${comun} ` +
      `Antes de tocar codigo, preguntá al operador cual es el repo y en que ruta local esta. ` +
      `Para que el room deje de preguntarlo en cada sesion: declaralo en 'specoe.work-repo' del ` +
      `project.config.yaml de esta carpeta (o reinstalá con ./specoe-add-room.sh <ROL> --work-repo <ruta>).`
    );
  }

  const declarados = lista.filter((e) => e.isRepo).map((e) => e.path);
  const rotos = lista.filter((e) => !e.isRepo).map((e) => e.path);
  const nombrar = (rutas) => rutas.map((r) => `'${r}'`).join(', ');
  let aviso = '';

  if (declarados.length === 1) {
    aviso +=
      `\n\n[[${WORK_REPO_PREFIX}:declarado]] El repo de trabajo de este room es '${declarados[0]}'. ${comun} ` +
      `Todo lo que sea codigo va contra ese repo, con git apuntado explicitamente: ` +
      `git -C '${declarados[0]}' worktree add ... (y los commits/PR salen de ahi, no del cwd).`;
  } else if (declarados.length > 1) {
    aviso +=
      `\n\n[[${WORK_REPO_PREFIX}:declarado]] Este room declara ${declarados.length} repos de trabajo: ` +
      `${nombrar(declarados)}. ${comun} Todo lo que sea codigo va contra ESOS repos, con git ` +
      `apuntado explicitamente al que corresponda: ` +
      `${declarados.map((r) => `git -C '${r}' worktree add ...`).join(' / ')} ` +
      `(y los commits/PR salen de ahi, no del cwd). Si no sabés cual de los ${declarados.length} ` +
      `corresponde al trabajo que te pidieron, preguntá al operador antes de empezar.`;
  }

  if (rotos.length === 1) {
    aviso +=
      `\n\n[[${WORK_REPO_PREFIX}:no-existe]] Este room declara su repo de trabajo en '${rotos[0]}' ` +
      `y ahi NO hay un repo git ahora mismo (no existe la ruta, o existe y no tiene .git). ${comun} ` +
      `No uses esa ruta a ciegas: verificala con el operador —puede faltar el clone, o la ` +
      `declaracion puede estar mal— y corregí 'specoe.work-repo' en el project.config.yaml.`;
  } else if (rotos.length > 1) {
    aviso +=
      `\n\n[[${WORK_REPO_PREFIX}:no-existe]] Este room declara ${rotos.length} repos de trabajo en ` +
      `${nombrar(rotos)} y en NINGUNO de ellos hay un repo git ahora mismo (no existe la ruta, o ` +
      `existe y no tiene .git). ${comun} No uses esas rutas a ciegas: verificalas con el operador ` +
      `—puede faltar el clone, o la declaracion puede estar mal— y corregí 'specoe.work-repo' en ` +
      `el project.config.yaml.`;
  }

  return aviso;
}

/** Resuelve las declaraciones, las mide contra el disco y devuelve el aviso ya armado. */
async function workRepoNotice() {
  const declared = await resolveWorkRepos();
  const entries = [];
  for (const declaredPath of declared) {
    let isRepo = false;
    try {
      await fs.stat(path.join(declaredPath, '.git'));
      isRepo = true;
    } catch {
      isRepo = false;
    }
    entries.push({ path: declaredPath, isRepo });
  }
  await logLine({
    level: entries.length > 0 && entries.every((e) => e.isRepo) ? 'info' : 'warn',
    msg: 'repo de trabajo del room',
    declared,
    entries,
  });
  return buildWorkRepoNotice(entries);
}

// Expande `${VAR}` y `${VAR:-default}` como lo hace el cliente MCP al leer el .mcp.json.
// Exportada desde TKT-0454: specoe-license-check.mjs la usa para juzgar con que header pudo
// haber conectado el server `specoe` al lanzar la sesion.
export function expandEnvPlaceholders(raw, env = process.env) {
  return String(raw ?? '').replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_all, name, def) =>
      env[name] !== undefined && env[name] !== '' ? env[name] : (def ?? `\${${name}}`),
  );
}

/**
 * El token EFECTIVO del server `specoe` en el .mcp.json de esta carpeta, o null si no hay
 * con que comparar: sin archivo, sin entry (el hook de licencia lo retira cuando la corrida
 * no tiene JWT usable — eso es ausencia declarada, no divergencia) o con el placeholder sin
 * expandir (lo nombra el chequeo 3 del verificador). Ninguno de esos casos se reporta como
 * divergencia: un falso positivo aca es exactamente el ruido que TKT-0225 combate.
 */
function mcpJsonTokenOf(entry) {
  const auth = entry?.headers?.Authorization;
  if (typeof auth !== 'string' || !auth.trim()) return null;
  const expandido = expandEnvPlaceholders(auth);
  if (expandido.includes('${')) return null;
  const token = expandido.replace(/^Bearer\s+/i, '').trim();
  return token || null;
}

/** La entrada `specoe` del .mcp.json de esta carpeta, o null (sin archivo, ilegible o sin entry). */
async function readMcpJsonSpecoeEntry() {
  try {
    const doc = JSON.parse(await fs.readFile(MCP_JSON_FILE, 'utf8'));
    return doc?.mcpServers?.specoe ?? null;
  } catch {
    return null;
  }
}

// Cliente MCP/SSE con el SDK oficial. Devuelve el markdown del contrato o null.
// SPEC-0237 P4 — `apertura` recibe como termino el GET de /sse (`httpStatus`, `opened`): es lo que
// se anota en el registro del room.
async function fetchRoomContract(url, token, signal, apertura = {}) {
  // TKT-0314 — el SDK sale del bundle vendorizado (vendor/mcp-client.mjs) y solo cae a
  // node_modules si el vendor no esta. Antes esto dependia de un npm install en la maquina del
  // cliente que en Windows aborta por una assertion de libuv.
  const { Client, SSEClientTransport } = await loadMcpClient();

  // EventSource nativo no permite headers custom: el SDK acepta un fetch propio para
  // la request SSE inicial (eventSourceInit.fetch) y requestInit para los POST /messages.
  // En ambos inyectamos Authorization: Bearer <jwt> — el authMiddleware del skill-server
  // liga el AuthContext (con el rol) a la sesion al abrir el /sse.
  const authFetch = async (input, init = {}) => {
    const res = await fetch(input, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });
    apertura.httpStatus = res.status;
    return res;
  };

  const transport = new SSEClientTransport(new URL(url), {
    eventSourceInit: { fetch: authFetch },
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  const client = new Client(
    { name: 'specoe-room-bootstrap', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    apertura.opened = true;
    const res = await client.callTool({ name: 'room_contract_get', arguments: {} }, undefined, {
      signal,
    });
    // Producto (role=null) o rol sin contrato => el tool responde isError; no es contrato.
    if (res?.isError) return null;
    const text = Array.isArray(res?.content)
      ? res.content
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
      : null;
    return text && text.trim() ? text : null;
  } finally {
    await client.close().catch(() => {});
  }
}

// Construye el additionalContext inyectable: sentinel estable (marca de "bajo del server,
// no de disco", que el probe de T5.3 asserta) + el contrato crudo del room. Funcion pura y
// exportada para que el probe la ejercite de forma determinista sin red.
export function buildAdditionalContext(role, contract) {
  return (
    `[[${SENTINEL_PREFIX}:${role}]] Contrato del room (bajado del SpecOE Skill Server, ` +
    `NO desde disco). Gobierna esta sesion como si fuera el CLAUDE.md del room:\n\n${contract}`
  );
}

// SPEC-0164 P2 / T2.4 — el room que arranca sin contrato lo DECLARA.
//
// main() abandonaba en silencio por cuatro caminos (sin token fresco, JWT sin claim
// sddRole, el server sin contrato para el rol, y el catch de red). Como este room no lleva
// su CLAUDE.md en disco, sin contrato bajado no hay gobierno de rol en ningun lado — y el
// hook estaba diseñado para no decirlo.
//
// El prefijo es OTRO a proposito: `SPECOE-ROOM-UNGOVERNED` no contiene la subcadena
// `SPECOE-ROOM-CONTRACT`, asi que el probe determinista de O6 puede afirmar la AUSENCIA
// del sentinel y la PRESENCIA de esta declaracion en el mismo texto. El sentinel no se
// renombra: es el ancla que ya usa el probe de T5.3.
export const UNGOVERNED_PREFIX = 'SPECOE-ROOM-UNGOVERNED';

export function buildUngovernedContext(reason, detail) {
  return (
    `[[${UNGOVERNED_PREFIX}:${reason}]] Este room esta operando SIN su contrato de gobierno. ` +
    `El room no lleva su CLAUDE.md en disco: el contrato del rol vive en el SpecOE Skill ` +
    `Server y baja en cada arranque de sesion. En esta sesion NO bajo, asi que ninguna ` +
    `regla del rol esta cargada. Motivo: ${detail} ` +
    `El enforcement real del rol sigue estando en el backend (403 del Hub), no aca.`
  );
}

/**
 * TKT-0454 — el motivo del camino `no-token`. Antes decia "el hook de licencia, que corre antes
 * que este, dice por que": un orden que no existe. Ahora nombra lo que paso de verdad —los dos
 * corren en paralelo y este lo espero— y a donde mirar, porque el mensaje de arranque del hook de
 * licencia puede haber salido o no segun por que fallo.
 */
export function buildNoTokenDetail(cacheFile, waitedMs) {
  const segundos = (Math.max(0, Number(waitedMs) || 0) / 1000).toFixed(1);
  return (
    `no hay JWT de licencia fresco en ${cacheFile} (falta, o el cache tiene mas de 55 min y el ` +
    `token ya no sirve). El hook de licencia corre EN PARALELO con este, no antes: este hook lo ` +
    `espero ${segundos} s a que refresque el cache y no lo hizo. El por que lo dice su mensaje de ` +
    `arranque en esta sesion, o ~/.claude/logs/specoe-license-<fecha>.log.`
  );
}

// `extra` (TKT-0225) se CONCATENA al final del additionalContext y nunca lo reemplaza: el
// sentinel y la declaracion de ungoverned son anclas que ya asserta el probe de T5.3, y
// buildAdditionalContext/buildUngovernedContext se quedan puras con su firma original.
// Desde TKT-0317 `extra` lleva DOS avisos independientes (divergencia de tokens + repo de
// trabajo), por eso el flag de divergencia del JSON viaja aparte y no se deduce de `extra`:
// deducirlo marcaria divergencia en toda sesion, que es justo lo contrario de discriminar.
function emitUngoverned(reason, detail, extra = '') {
  console.log(
    JSON.stringify({
      specoeRoomContractStatus: 'ungoverned',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildUngovernedContext(reason, detail) + extra,
      },
    }),
  );
}

function emit(role, contract, extra = '', divergente = false) {
  console.log(
    JSON.stringify({
      specoeRoomContractStatus: 'injected',
      // El status distingue la sesion coherente de la que arranca con los dos tokens
      // separados: 'injected' sigue significando "el contrato bajo del server", y el
      // sufijo dice que los tools MCP corren con otro JWT.
      ...(divergente ? { specoeTokenDivergence: true } : {}),
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildAdditionalContext(role, contract) + extra,
      },
    }),
  );
}

// Aplica el canal de CA del bundle — el MISMO modulo que usa el hook de licencia
// (ca-channel.mjs), que es el unico punto de definicion del mecanismo. Este hook NO
// importa specoe-license-check.mjs.
//
// Por que a nivel proceso y no con un dispatcher explicito: `authFetch` (:87-91) se arma
// sobre el `fetch` global, y el SSEClientTransport del SDK MCP hace sus propios POST
// /messages por dentro, fuera de nuestro control. El unico mecanismo que los alcanza a
// todos es mutar el trust del proceso.
//
// Antes esto instalaba un dispatcher global de undici, con el catch VACIO y sin una sola
// linea de log: en Node 26 el fetch global ignora ese dispatcher, asi que no hacia nada, y
// el fallo del canal aca era completamente invisible. Ahora el resultado se registra.
async function openCaChannel() {
  const r = applyCaChannel();
  await logLine(
    r.ok
      ? {
          level: 'info',
          msg: 'canal de CA aplicado — store del proceso ampliado',
          caPath: r.caPath,
          subject: r.subject,
          storeBefore: r.storeBefore,
          storeAfter: r.storeAfter,
        }
      : {
          level: 'warn',
          msg: 'canal de CA NO aplicado',
          reason: r.reason,
          caPath: r.caPath ?? DEFAULT_CA_PATH,
          error: r.error,
        },
  );
  return r;
}

// TKT-0225 — compara el token del cache contra el efectivo del .mcp.json de la carpeta y
// devuelve la advertencia lista para concatenar ('' si no hay nada que declarar). Se compara
// el TOKEN COMPLETO, no el claim `sddRole`: en USER-mode el rol lo resuelve el server desde
// el UserSddRole y el claim puede faltar legitimamente en los dos lados (TKT-0227), asi que
// comparar claims dejaria pasar justo el caso que importa. Dos tokens distintos en la misma
// carpeta son siempre divergencia: el hook de licencia los escribe juntos y con el mismo
// valor en TODOS sus caminos (camino feliz, grace period y retiro del entry).
//
// SPEC-0237 P4 (ADR-007) — con la entrada del PROXY no hay token en el .mcp.json que comparar: la
// divergencia se mide entre el rol que sirve el cache y el que la sesion declara (ver
// detectRoleDivergence). Con la entrada SSE, la comparacion de tokens de siempre.
async function tokenDivergenceWarning(cacheToken) {
  const entry = await readMcpJsonSpecoeEntry();
  if (isProxyEntry(entry)) {
    const div = detectRoleDivergence({ cacheToken, declaredRole: declaredRoleFromEnv() });
    if (!div) return '';
    await logLine({
      level: 'warn',
      msg: 'entrada del proxy: el JWT del cache es de otro rol que el que declara la sesion',
      file: MCP_JSON_FILE,
      rolServido: div.servido,
      rolDeclarado: div.declarado,
    });
    return buildRoleDivergenceWarning(div.servido, div.declarado);
  }
  const mcpToken = mcpJsonTokenOf(entry);
  if (!mcpToken || !cacheToken || mcpToken === cacheToken) return '';
  const rolCache = decodeRole(cacheToken);
  const rolMcp = decodeRole(mcpToken);
  await logLine({
    level: 'warn',
    msg: 'el JWT del .mcp.json NO es el del cache — los tools MCP corren con otro token',
    file: MCP_JSON_FILE,
    rolDelCache: rolCache,
    rolDelMcpJson: rolMcp,
  });
  return buildTokenDivergenceWarning(rolCache, rolMcp);
}

// ----- SPEC-0237 P4 — la apertura de /sse de este hook en el registro del room (ADR-003) -----
//
// El tope de /sse es POR ROOM: 12 aperturas por ventana deslizante de 60 min, contando las del
// proxy (P3) y las de este hook. Lo pone el registro .claude/specoe-room-ledger.jsonl, que consultan
// los dos: el skill-server no frena un bucle de reaperturas con JWT del Hub. Este hook reserva la
// apertura ANTES de abrir y anota como termino (open, rejected con 401, failed, timeout) con los
// claims del JWT que presento —nunca el token—. Con el tope agotado no abre: el room arranca sin
// contrato y lo dice (`sse-tope`), igual que el proxy, que tampoco abre.
//
// El modulo se importa en caliente y viene en el mismo bundle de maquina que este hook. Si falta
// o no carga, el hook abre igual y lo anota en su log: perder el contrato de la sesion por un
// registro ausente cambiaria lo que el hook hace sin que nadie lo haya pedido. El lock se espera
// poco: el presupuesto es de 15 s y ya lleva la espera al hook de licencia.
const SSE_LEDGER_LOCK_WAIT_MS = 1000;
let ledgerModule;

async function loadLedger() {
  if (ledgerModule === undefined) {
    try {
      ledgerModule = await import('./specoe-room-ledger.mjs');
    } catch (err) {
      ledgerModule = null;
      await logLine({
        level: 'warn',
        msg: 'registro del room no disponible — la apertura de /sse no se anota',
        error: err?.message,
      });
    }
  }
  return ledgerModule;
}

/**
 * `{ ledger, id }` si el registro concedio la apertura; `{ denied: { reason, retryAfterMs } }` si
 * no la concedio (tope de la ventana o lock ocupado); null si no hay registro con que decidir.
 */
async function reserveSseOpen() {
  const ledger = await loadLedger();
  if (!ledger) return null;
  try {
    const r = await ledger.reserveSseOpen({
      projectDir: PROJECT_DIR,
      source: ledger.SOURCE_BOOTSTRAP,
      lockWaitMs: SSE_LEDGER_LOCK_WAIT_MS,
    });
    if (!r.granted) return { denied: { reason: r.reason, retryAfterMs: r.retryAfterMs } };
    return { ledger, id: r.id };
  } catch (err) {
    await logLine({
      level: 'warn',
      msg: 'registro del room: no se pudo reservar la apertura de /sse — se abre igual',
      error: err?.message,
    });
    return null;
  }
}

async function recordSseOpen(reserva, { status, httpStatus, token }) {
  if (!reserva?.ledger) return;
  try {
    await reserva.ledger.recordSseOpen({
      projectDir: PROJECT_DIR,
      id: reserva.id,
      status,
      httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
      ...decodeClaims(token),
      lockWaitMs: SSE_LEDGER_LOCK_WAIT_MS,
    });
  } catch (err) {
    await logLine({
      level: 'warn',
      msg: 'registro del room: no se pudo anotar como termino la apertura de /sse',
      error: err?.message,
    });
  }
}

/** Como termino la apertura, con el vocabulario del proxy (upstream.mjs). */
export function sseOpenStatus({ opened, httpStatus, aborted }) {
  if (opened) return 'open';
  if (httpStatus === 401) return 'rejected';
  if (aborted) return 'timeout';
  return 'failed';
}

export function buildSseCapDetail(denied) {
  const min = Math.max(1, Math.ceil((Number(denied?.retryAfterMs) || 0) / 60000));
  if (denied?.reason === 'lock-busy') {
    return (
      `el registro de aperturas de /sse de esta carpeta (.claude/specoe-room-ledger.jsonl) estuvo ` +
      `tomado por otro proceso mas de ${SSE_LEDGER_LOCK_WAIT_MS} ms, y sin el no se puede decidir si ` +
      `abrir respeta el tope del room. No se abrio. Reabri la sesion; si se repite, mira si quedo ` +
      `un .claude/specoe-room-ledger.lock viejo (se rompe solo a los 10 s).`
    );
  }
  return (
    `esta carpeta ya abrio /sse el maximo de veces de la ultima hora (12, contando el proxy del ` +
    `MCP specoe y este hook). El tope existe para que un bucle de reaperturas no castigue al ` +
    `skill-server, y este arranque no abre otra. Vuelve a haber lugar en ~${min} min. Si el proxy ` +
    `esta reabriendo en bucle, su log lo dice: ~/.claude/logs/specoe-mcp-proxy-<fecha>.log.`
  );
}

async function main() {
  // TKT-0454 — el hook de licencia corre EN PARALELO: si el cache no trae un token usable, se
  // espera a que lo refresque. Todo lo que lee el cache o el .mcp.json va DESPUES de esta espera:
  // el hook de licencia escribe primero el .mcp.json y al final el cache, asi que un cache
  // fresco garantiza un .mcp.json ya al dia y la comparacion de abajo no ve una divergencia que
  // es solo la mitad de una escritura en curso.
  const espera = await waitForUsableToken({ readToken: readCachedToken, waitMs: LICENSE_WAIT_MS });
  const token = espera.token;
  if (espera.polls > 0) {
    await logLine({
      level: token ? 'info' : 'warn',
      msg: token
        ? 'JWT fresco en el cache tras esperar al hook de licencia'
        : 'el hook de licencia no dejo un JWT fresco en el plazo — room sin contrato',
      waitedMs: espera.waitedMs,
      polls: espera.polls,
      file: CACHE_FILE,
    });
  }
  // Se computa una sola vez y viaja por todos los caminos de salida: la divergencia importa
  // igual cuando el room arranca ungoverned — ahi el .mcp.json puede seguir declarando un
  // token vivo con el que los tools MCP corren, y el dev tiene que saberlo.
  const divergencia = await tokenDivergenceWarning(token);
  // TKT-0317 — mismo criterio para el repo de trabajo: viaja por los cuatro caminos, porque un
  // room sin contrato igual va a querer aislar trabajo de codigo. Los dos avisos se concatenan
  // en `avisos`; `divergencia` se conserva aparte porque de EL depende el flag del JSON.
  const avisos = divergencia + (await workRepoNotice());
  // Sin token fresco no podemos autenticar. Fail-open, pero YA NO mudo: el license-check
  // explica por que falta el JWT, y este hook declara la consecuencia — el room queda sin
  // gobierno de rol. Las dos mitades juntas son el mensaje completo.
  if (!token) {
    await logLine({
      level: 'warn',
      msg: 'sin JWT fresco en el cache — room sin contrato',
      file: CACHE_FILE,
      waitedMs: espera.waitedMs,
    });
    emitUngoverned('no-token', buildNoTokenDetail(CACHE_FILE, espera.waitedMs), avisos);
    return 0;
  }

  const role = decodeRole(token);
  // Producto (sin rol): el skill-server no tiene contrato de room para role=null.
  // Evitamos la llamada de red y arrancamos sin inyectar.
  if (!role) {
    await logLine({ level: 'warn', msg: 'JWT sin claim sddRole — room sin contrato' });
    emitUngoverned(
      'no-role',
      'el JWT de licencia no trae el claim sddRole: es una licencia de producto, no de un rol SDD. Si esta carpeta tiene que ser un room, instalala con ./specoe-add-room.sh <ROL> <LICENSE_KEY>.',
      avisos,
    );
    return 0;
  }

  // SPEC-0237 P4 — la apertura se reserva en el registro del room ANTES de abrir (ADR-003).
  const reserva = await reserveSseOpen();
  if (reserva?.denied) {
    await logLine({
      level: 'warn',
      msg: 'el registro del room no concedio la apertura de /sse — room sin contrato',
      reason: reserva.denied.reason,
      retryAfterMs: reserva.denied.retryAfterMs,
      role,
    });
    emitUngoverned('sse-tope', buildSseCapDetail(reserva.denied), avisos);
    return 0;
  }

  // aplicar el canal de CA antes del SSE al skill-server.
  await openCaChannel();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), networkDeadlineMs());
  const apertura = { opened: false, httpStatus: null };
  let contract = null;
  let fallo = null;
  try {
    contract = await fetchRoomContract(
      DEFAULT_SKILL_SERVER_URL,
      token,
      controller.signal,
      apertura,
    );
  } catch (err) {
    fallo = err;
  } finally {
    clearTimeout(timer);
  }
  await recordSseOpen(reserva, {
    status: sseOpenStatus({ ...apertura, aborted: controller.signal.aborted }),
    httpStatus: apertura.httpStatus,
    token,
  });
  try {
    if (fallo) throw fallo;
    if (contract) {
      // El SSE se abrio: el TLS valido. Linea de exito del canal — sale recien aca,
      // con el efecto ya comprobado, nunca por haber aplicado el mecanismo.
      await logLine({
        level: 'info',
        msg: 'canal TLS verificado contra el skill-server — contrato del room inyectado',
        url: DEFAULT_SKILL_SERVER_URL,
        role,
      });
      emit(role, contract, avisos, divergencia !== '');
    } else {
      await logLine({
        level: 'warn',
        msg: 'sin contrato para el rol — no se inyecta',
        url: DEFAULT_SKILL_SERVER_URL,
        role,
      });
      emitUngoverned(
        'no-contract',
        `el skill-server (${DEFAULT_SKILL_SERVER_URL}) respondio, pero no devolvio contrato para el rol ${role}.`,
        avisos,
      );
    }
  } catch (err) {
    // Red caida, server abajo, SDK ausente, timeout: fail-open, sin inyectar. Pero con
    // el errno de err.cause a la vista: 'fetch failed' pelado no distingue un cert que no
    // valida de un host que no resuelve.
    const net = describeNetworkError(err);
    await logLine({
      level: 'warn',
      msg: 'no se pudo bajar el contrato del room',
      code: net.code,
      cause: net.cause,
      error: net.message,
      url: DEFAULT_SKILL_SERVER_URL,
      role,
    });
    emitUngoverned(
      'network',
      `no se pudo hablar con el skill-server (${DEFAULT_SKILL_SERVER_URL}): errno ${net.code ?? 'desconocido'} — ${net.cause ?? net.message}.`,
      avisos,
    );
  }
  return 0;
}

// NUNCA bloquear la sesion: exit 0 pase lo que pase. Solo corre como entry point
// (no cuando el probe de T5.3 importa las funciones puras de este modulo).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => process.exit(code || 0))
    .catch(() => process.exit(0));
}
