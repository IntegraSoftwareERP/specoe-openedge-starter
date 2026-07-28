#!/usr/bin/env node
// SessionStart hook: baja el contrato del room
// del rol autenticado desde el MCP Skill Server y lo inyecta por additionalContext.
//
// Es la pieza del "thin client diskless": el room del cliente NO lleva su CLAUDE.md
// ni sus skills en disco (los peló T5.3). El contrato de gobierno del rol vive
// server-side y baja en cada arranque de sesion, autenticado con el JWT de licencia.
//
// Orden en settings.json: este hook corre DESPUES de specoe-license-check.mjs, que
// valida la licencia y deja el JWT fresco en ~/.claude/specoe-license-cache.json.
// Este hook REUSA ese token (no re-valida): el rol sale del claim `sddRole` del JWT
// (lo mismo que verifica el authMiddleware del skill-server).
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
import { pathToFileURL } from 'node:url';
import { applyCaChannel, describeNetworkError, DEFAULT_CA_PATH } from './ca-channel.mjs';

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

// Lee el JWT de licencia que dejo specoe-license-check.mjs en el cache. No re-valida:
// si el token no esta o el cache es viejo, degradamos a fail-open (sin contrato).
async function readCachedToken() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const cache = JSON.parse(raw);
    if (!cache?.token) return null;
    // El JWT de licencia vive 1h (ACCESS_TOKEN_TTL_SECONDS). Si el cache es mas viejo
    // que ~55min, el token esta por expirar/expiro: no lo usamos (el skill-server daria 401).
    if (cache.validatedAt) {
      const ageMs = Date.now() - new Date(cache.validatedAt).getTime();
      if (ageMs > 55 * 60 * 1000) return null;
    }
    return cache.token;
  } catch {
    return null;
  }
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

// Expande `${VAR}` y `${VAR:-default}` como lo hace el cliente MCP al leer el .mcp.json.
function expandEnvPlaceholders(raw) {
  return String(raw ?? '').replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_all, name, def) =>
      process.env[name] !== undefined && process.env[name] !== ''
        ? process.env[name]
        : (def ?? `\${${name}}`),
  );
}

/**
 * El token EFECTIVO del server `specoe` en el .mcp.json de esta carpeta, o null si no hay
 * con que comparar: sin archivo, sin entry (el hook de licencia lo retira cuando la corrida
 * no tiene JWT usable — eso es ausencia declarada, no divergencia) o con el placeholder sin
 * expandir (lo nombra el chequeo 3 del verificador). Ninguno de esos casos se reporta como
 * divergencia: un falso positivo aca es exactamente el ruido que TKT-0225 combate.
 */
async function readMcpJsonToken() {
  try {
    const doc = JSON.parse(await fs.readFile(MCP_JSON_FILE, 'utf8'));
    const auth = doc?.mcpServers?.specoe?.headers?.Authorization;
    if (typeof auth !== 'string' || !auth.trim()) return null;
    const expandido = expandEnvPlaceholders(auth);
    if (expandido.includes('${')) return null;
    const token = expandido.replace(/^Bearer\s+/i, '').trim();
    return token || null;
  } catch {
    return null;
  }
}

// Cliente MCP/SSE con el SDK oficial. Devuelve el markdown del contrato o null.
async function fetchRoomContract(url, token, signal) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

  // EventSource nativo no permite headers custom: el SDK acepta un fetch propio para
  // la request SSE inicial (eventSourceInit.fetch) y requestInit para los POST /messages.
  // En ambos inyectamos Authorization: Bearer <jwt> — el authMiddleware del skill-server
  // liga el AuthContext (con el rol) a la sesion al abrir el /sse.
  const authFetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });

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

// `extra` (TKT-0225) se CONCATENA al final del additionalContext y nunca lo reemplaza: el
// sentinel y la declaracion de ungoverned son anclas que ya asserta el probe de T5.3, y
// buildAdditionalContext/buildUngovernedContext se quedan puras con su firma original.
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

function emit(role, contract, extra = '') {
  console.log(
    JSON.stringify({
      specoeRoomContractStatus: 'injected',
      // El status distingue la sesion coherente de la que arranca con los dos tokens
      // separados: 'injected' sigue significando "el contrato bajo del server", y el
      // sufijo dice que los tools MCP corren con otro JWT.
      ...(extra ? { specoeTokenDivergence: true } : {}),
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
async function tokenDivergenceWarning(cacheToken) {
  const mcpToken = await readMcpJsonToken();
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

async function main() {
  const token = await readCachedToken();
  // Se computa una sola vez y viaja por todos los caminos de salida: la divergencia importa
  // igual cuando el room arranca ungoverned — ahi el .mcp.json puede seguir declarando un
  // token vivo con el que los tools MCP corren, y el dev tiene que saberlo.
  const divergencia = await tokenDivergenceWarning(token);
  // Sin token fresco no podemos autenticar. Fail-open, pero YA NO mudo: el license-check
  // explica por que falta el JWT, y este hook declara la consecuencia — el room queda sin
  // gobierno de rol. Las dos mitades juntas son el mensaje completo.
  if (!token) {
    await logLine({
      level: 'warn',
      msg: 'sin JWT fresco en el cache — room sin contrato',
      file: CACHE_FILE,
    });
    emitUngoverned(
      'no-token',
      `no hay JWT de licencia fresco en ${CACHE_FILE} (falta, o el cache tiene mas de 55 min y el token ya no sirve). El hook de licencia, que corre antes que este, dice por que.`,
      divergencia,
    );
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
      divergencia,
    );
    return 0;
  }

  // aplicar el canal de CA antes del SSE al skill-server.
  await openCaChannel();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_DEADLINE_MS);
  try {
    const contract = await fetchRoomContract(DEFAULT_SKILL_SERVER_URL, token, controller.signal);
    if (contract) {
      // El SSE se abrio: el TLS valido. Linea de exito del canal — sale recien aca,
      // con el efecto ya comprobado, nunca por haber aplicado el mecanismo.
      await logLine({
        level: 'info',
        msg: 'canal TLS verificado contra el skill-server — contrato del room inyectado',
        url: DEFAULT_SKILL_SERVER_URL,
        role,
      });
      emit(role, contract, divergencia);
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
        divergencia,
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
      divergencia,
    );
  } finally {
    clearTimeout(timer);
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
