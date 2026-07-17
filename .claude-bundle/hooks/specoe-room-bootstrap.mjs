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
// Defensa/UX: NUNCA bloquea el arranque (exit 0 SIEMPRE). Fallo de red, server caido,
// licencia sin rol o timeout => sesion arranca igual, sin contrato inyectado. El
// enforcement real del rol vive en el backend (403 del Hub), no en este hook.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

// multi-rol — el cache de licencia vive POR-CARPETA (cwd de la sesion), igual que
// en specoe-license-check.mjs. Antes era global (~/.claude): con varios roles a la vez el
// ultimo pisaba a los demas y el bootstrap bajaba el contrato del rol equivocado.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CACHE_FILE = path.join(PROJECT_DIR, '.claude', 'specoe-license-cache.json');
const DEFAULT_SKILL_SERVER_URL =
  process.env.SPECOE_SKILL_SERVER_URL || 'https://mcp.integra.local/sse';
// Margen del timeout del hook (settings.json le da 15s). Cortamos la red antes para
// garantizar exit 0 limpio aunque el server no responda.
const NETWORK_DEADLINE_MS = Number.parseInt(process.env.SPECOE_BOOTSTRAP_TIMEOUT_MS || '10000', 10);
// Sentinel estable para el probe determinista (T5.3): marca inequivoca de que el
// contrato bajo del server y se inyecto (no vino de un CLAUDE.md en disco).
const SENTINEL_PREFIX = 'SPECOE-ROOM-CONTRACT';

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

function emit(role, contract) {
  console.log(
    JSON.stringify({
      specoeRoomContractStatus: 'injected',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildAdditionalContext(role, contract),
      },
    }),
  );
}

// carga el CA de Caddy en el fetch (mismo patrón que specoe-license-check).
// El SDK MCP corre sobre el fetch global; sin el CA, el SSE a mcp.integra.local (cert
// `tls internal` de Caddy) falla en la extensión VSCode (NODE_EXTRA_CA_CERTS no llega al
// hook) y el contrato del room no baja. setGlobalDispatcher afecta también al fetch del SDK.
// Fail-open silencioso: sin CA en disco o sin undici, seguimos con el trust default.
async function installCaDispatcher() {
  try {
    const caPath = path.join(os.homedir(), '.claude', 'caddy-local-root.crt');
    const ca = await fs.readFile(caPath, 'utf8');
    const { Agent, setGlobalDispatcher } = await import('undici');
    // Sumamos el CA de Caddy a los root certs del sistema (no reemplazarlos).
    setGlobalDispatcher(new Agent({ connect: { ca: [...tls.rootCertificates, ca] } }));
  } catch {
    /* fail-open: trust default (CLI/NODE_EXTRA_CA_CERTS o CA en el trust del sistema) */
  }
}

async function main() {
  const token = await readCachedToken();
  // Sin token fresco no podemos autenticar: fail-open silencioso (el license-check ya
  // avisa por su cuenta si la licencia falta o expiro).
  if (!token) return 0;

  const role = decodeRole(token);
  // Producto (sin rol): el skill-server no tiene contrato de room para role=null.
  // Evitamos la llamada de red y arrancamos sin inyectar.
  if (!role) return 0;

  // instalar el CA de Caddy en el fetch antes del SSE al skill-server.
  await installCaDispatcher();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_DEADLINE_MS);
  try {
    const contract = await fetchRoomContract(DEFAULT_SKILL_SERVER_URL, token, controller.signal);
    if (contract) emit(role, contract);
  } catch {
    // Red caida, server abajo, SDK ausente, timeout: fail-open, sin inyectar.
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
