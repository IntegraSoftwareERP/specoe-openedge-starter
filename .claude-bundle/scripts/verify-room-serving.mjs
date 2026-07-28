#!/usr/bin/env node
// SPEC-0164 P4 / T4.1 — verificador del arranque servido de un room SPECOE.
//
// Dictamina POR SI MISMO si el room quedo servido. Corre sin pasos manuales, sin monorepo
// y sin devDependencies: solo builtins de Node y el canal de CA del propio bundle.
// Lo invoca specoe-verify-room.sh, que vive en la raiz del starter.
//
// ----- LOS CINCO CHEQUEOS -----
//
//   1. canal-tls-hub       el canal TLS al Hub ABRE (no: "se aplico el mecanismo")
//   2. jwt-licencia        el JWT de licencia esta en el cache POR-CARPETA y no vencio
//   3. mcp-json-jwt        el .mcp.json declara `specoe` con un JWT real, no el placeholder
//   4. contrato-room       el contrato del room BAJA del skill-server en ESTA corrida
//   5. specoe-conectable   el skill-server ACEPTA la sesion con la url y el header que el
//                          .mcp.json tiene efectivamente escritos
//
// Exit 0 SOLO si los cinco dan verde.
//
// ----- POR QUE CADA CHEQUEO MIDE EL EFECTO Y NO LA EJECUCION -----
//
// El defecto que origino esta SPEC fue una linea de log que declaraba exito sin comprobar
// nada: `installCaDispatcher` anunciaba "CA dispatcher instalado" cuando en Node 26 el
// fetch global ignora ese dispatcher, y esa linea desvio el diagnostico durante todo el
// incidente. Un verificador que repita ese patron es peor que no tenerlo: certifica el
// verde falso. Por eso ningun chequeo de aca se conforma con que un archivo exista, con
// que una funcion no haya tirado, ni con que un log diga que algo salio bien:
//   - el 1 abre una conexion real contra el Hub (un CA valido pero de OTRO emisor pasa el
//     mecanismo y muere aca, que es exactamente la diferencia);
//   - el 2 mira el `exp` del JWT, no la existencia del archivo de cache;
//   - el 3 exige que el header sea un JWT parseable, no que la clave este presente;
//   - el 4 baja el contrato del server ahora, no lee el log de un arranque anterior;
//   - el 5 abre el SSE y espera que el server acepte la sesion.
//
// ----- POR QUE NO IMPORTA specoe-license-check.mjs -----
//
// El canal de CA se toma de ca-channel.mjs, que es el punto UNICO de definicion del
// mecanismo y cuya importacion no tiene efectos. specoe-license-check.mjs NO se importa
// nunca: es un hook con entry point, y aunque hoy tiene guarda de `isMain`, importarlo
// para conseguir el canal ataria este verificador al riesgo de terminar en un
// `process.exit()` ajeno antes de emitir veredicto — exit 0 sin haber chequeado nada, o
// sea el verde falso que esta SPEC existe para matar, reintroducido en la herramienta que
// lo tiene que detectar. La resolucion de la URL del Hub se reimplementa abajo por la
// misma razon, con la misma precedencia que usa el hook.
//
// ----- EXCLUSION EXPLICITA: EL MCP integra-hub NO SE CHEQUEA -----
//
// Este verificador NO exige en ningun caso que el server MCP `integra-hub` conecte, ni
// mira su entry del .mcp.json. Razon: ese server hoy no viaja al room del cliente (corre
// por `node node_modules/integra-hub-mcp/...`, que el starter publico no instala) y su
// bloqueante es hermano de esta SPEC, fuera de su alcance. Exigirlo daria rojo permanente
// por algo que esta fase no repara, y meterlo en el veredicto cerraria la SPEC en falso.
// La exclusion va escrita aca, en el codigo, y no solo en la documentacion.

import fs from 'node:fs/promises';
import path from 'node:path';
import { applyCaChannel, probeCaChannel, describeNetworkError } from '../hooks/ca-channel.mjs';
import { buildAdditionalContext } from '../hooks/specoe-room-bootstrap.mjs';

// ----- parametros de corrida -----
//
// Deadline PROPIO por chequeo y deadline TOTAL. Sin esto, dos corridas seguidas dependen
// de cuanto tarde la red y el requisito de reproducibilidad de O5 (mismo veredicto en dos
// corridas sin tocar nada) no se puede cumplir: un chequeo que a veces espera 3 s y a
// veces 40 s no da el mismo resultado dos veces.
const CHECK_DEADLINE_MS = Number.parseInt(process.env.SPECOE_VERIFY_CHECK_TIMEOUT_MS || '8000', 10);
const TOTAL_DEADLINE_MS = Number.parseInt(
  process.env.SPECOE_VERIFY_TOTAL_TIMEOUT_MS || '40000',
  10,
);
const STARTED_AT = Date.now();

// La carpeta del room: argumento explicito > CLAUDE_PROJECT_DIR > cwd. El .mcp.json, el
// project.config.yaml y el cache de licencia son POR-CARPETA (multi-rol).
const ROOM_DIR = path.resolve(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const MCP_JSON_FILE = path.join(ROOM_DIR, '.mcp.json');
const CACHE_FILE = path.join(ROOM_DIR, '.claude', 'specoe-license-cache.json');
const CONFIG_FILE = path.join(ROOM_DIR, 'project.config.yaml');

// Mismos defaults y misma precedencia que los hooks del bundle.
const FALLBACK_HUB_URL = 'http://integra-hub:8100/api/v1';
const DEFAULT_SKILL_SERVER_URL =
  process.env.SPECOE_SKILL_SERVER_URL || 'https://mcp.integra.local/sse';
const SKILL_JWT_PLACEHOLDER = '${SPECOE_SKILL_JWT}';

// Prefijo estable de cada linea: ancla para el dev que hace grep y para los tests de
// sabotaje de T4.3. Mismo criterio que el SENTINEL de specoe-room-bootstrap.mjs y que el
// DIAG_PREFIX del hook de licencia.
const PREFIX = 'SPECOE-VERIFY';

const CHECKS = [
  { n: 1, id: 'canal-tls-hub', titulo: 'canal TLS al Hub' },
  { n: 2, id: 'jwt-licencia', titulo: 'JWT de licencia en el cache del room' },
  { n: 3, id: 'mcp-json-jwt', titulo: '.mcp.json con JWT real' },
  { n: 4, id: 'contrato-room', titulo: 'contrato del room bajado del skill-server' },
  { n: 5, id: 'specoe-conectable', titulo: 'server specoe efectivamente conectable' },
];

function say(text) {
  process.stdout.write(text + '\n');
}

function emitCheck(check, res) {
  const estado = res.ok ? 'OK' : 'FAIL';
  say(`${PREFIX} ${check.n}/5 ${check.id} [${check.titulo}]: ${estado} — ${res.detalle}`);
  if (!res.ok && res.accion) say(`${PREFIX} ${check.n}/5 ${check.id} accion: ${res.accion}`);
}

function msLeft() {
  return TOTAL_DEADLINE_MS - (Date.now() - STARTED_AT);
}

/** Deadline efectivo de un chequeo: el propio, acotado por lo que queda del total. */
function deadlineMs() {
  return Math.max(0, Math.min(CHECK_DEADLINE_MS, msLeft()));
}

// ----- helpers -----

/** Payload de un JWT sin verificar firma. Solo para leer `exp` y `sddRole`. */
function decodeJwtPayload(token) {
  try {
    const [, payloadB64] = String(token).split('.');
    if (!payloadB64) return null;
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * URL del Hub con la MISMA precedencia que specoe-license-check.mjs:
 * env INTEGRA_HUB_URL > hub.api-url del project.config.yaml del room > fallback interno.
 * Reimplementada a proposito (ver cabecera): el hook no se importa.
 */
async function resolveHubUrl() {
  if (process.env.INTEGRA_HUB_URL) {
    return { url: process.env.INTEGRA_HUB_URL, source: 'env INTEGRA_HUB_URL' };
  }
  try {
    const yaml = await fs.readFile(CONFIG_FILE, 'utf8');
    const m = yaml.match(/^\s*api-url:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    if (m && m[1]) return { url: m[1].trim(), source: `${CONFIG_FILE} (hub.api-url)` };
  } catch {
    /* sin yaml en la carpeta — cae al fallback */
  }
  return { url: FALLBACK_HUB_URL, source: 'fallback interno del bundle' };
}

/**
 * Expande `${VAR}` y `${VAR:-default}` como lo hace el cliente MCP al leer el .mcp.json.
 * Devuelve tambien si quedo algun placeholder SIN resolver: una url con `${...}` viva es
 * una url que el server nunca va a recibir.
 */
function expandEnvPlaceholders(raw) {
  const text = String(raw ?? '');
  const value = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_all, name, def) =>
    process.env[name] !== undefined && process.env[name] !== ''
      ? process.env[name]
      : (def ?? `\${${name}}`),
  );
  return { value, unresolved: value.includes('${') };
}

async function readMcpJson() {
  const raw = await fs.readFile(MCP_JSON_FILE, 'utf8');
  return JSON.parse(raw);
}

// ----- cliente MCP/SSE minimo -----
//
// El transporte SSE del protocolo MCP, implementado con `fetch` y nada mas. El SDK oficial
// (@modelcontextprotocol/sdk) es lo que usa el hook del room, pero vive en las deps del
// bundle instalado en ~/.claude/hooks: en la VM del dev, que corre este verificador desde
// el clon del espejo publico, ese paquete NO existe. Importarlo seria el "error de modulo
// no encontrado" que el criterio de esta fase prohibe explicitamente.
//
// Handshake: GET url (Authorization) -> el server responde `event: endpoint` con la ruta
// de POST de la sesion; los mensajes JSON-RPC se mandan por POST y las respuestas llegan
// por el stream abierto.

class SseSession {
  constructor(url, authorization) {
    this.url = url;
    this.authorization = authorization;
    this.controller = new AbortController();
    this.pending = new Map();
    this.endpoint = null;
    this.nextId = 1;
    this.closed = false;
    this.streamError = null;
  }

  async connect(timeoutMs) {
    const res = await fetch(this.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: this.authorization },
      signal: this.controller.signal,
    });
    if (!res.ok) {
      this.close();
      return { ok: false, status: res.status, reason: 'http-status' };
    }
    if (!res.body) {
      this.close();
      return { ok: false, status: res.status, reason: 'sin-body' };
    }
    const endpointPromise = new Promise((resolve) => {
      this.onEndpoint = resolve;
    });
    this.pump(res.body).catch((err) => {
      this.streamError = err;
    });
    const endpoint = await this.withTimeout(endpointPromise, timeoutMs);
    if (!endpoint) {
      this.close();
      return { ok: false, status: res.status, reason: 'sin-evento-endpoint' };
    }
    return { ok: true, status: res.status, endpoint };
  }

  async pump(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        this.handleEvent(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
  }

  handleEvent(block) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    const payload = data.join('\n');
    if (event === 'endpoint') {
      this.endpoint = new URL(payload, this.url).href;
      this.onEndpoint?.(this.endpoint);
      return;
    }
    try {
      const msg = JSON.parse(payload);
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      /* keep-alive o evento que no es JSON-RPC */
    }
  }

  withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, timeoutMs)).unref?.()),
    ]);
  }

  async post(body) {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.authorization },
      body: JSON.stringify(body),
      signal: this.controller.signal,
    });
  }

  /** JSON-RPC request: POST + espera la respuesta por el stream. null si no llego a tiempo. */
  async request(method, params, timeoutMs) {
    const id = this.nextId++;
    const waiter = new Promise((resolve) => this.pending.set(id, resolve));
    const res = await this.post({ jsonrpc: '2.0', id, method, params });
    if (!res.ok && res.status !== 202) {
      this.pending.delete(id);
      return { error: { message: `POST ${method} -> HTTP ${res.status}` } };
    }
    const msg = await this.withTimeout(waiter, timeoutMs);
    if (!msg) {
      this.pending.delete(id);
      return { error: { message: `sin respuesta a ${method} dentro del deadline` } };
    }
    return msg;
  }

  async notify(method, params) {
    await this.post({ jsonrpc: '2.0', method, params });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.abort();
    } catch {
      /* ya cerrado */
    }
  }
}

// ----- chequeo 1 — canal TLS al Hub -----

async function checkCanalTlsHub() {
  const hub = await resolveHubUrl();
  const ca = applyCaChannel();

  if (!hub.url.startsWith('https://')) {
    return {
      ok: false,
      detalle:
        `la URL del Hub resuelta es ${hub.url} (fuente: ${hub.source}) y NO es https, ` +
        'asi que el canal TLS no se puede comprobar contra ella. Un chequeo que no puede ' +
        'observar el efecto NO da verde.',
      accion:
        'corregi la URL del Hub: INTEGRA_HUB_URL en el entorno, o hub.api-url en ' +
        `${CONFIG_FILE}. En la instalacion del piloto es https://hub.integra.local/api/v1.`,
    };
  }

  if (!ca.ok) {
    return {
      ok: false,
      detalle:
        `el root de Caddy NO quedo en el store del proceso (${ca.reason}` +
        `${ca.error ? `: ${ca.error}` : ''}), archivo ${ca.caPath}. Sin el, el handshake ` +
        `contra ${hub.url} no valida.`,
      accion:
        'corre ./specoe-setup-host.sh desde el starter para instalar el root de Caddy en ' +
        `${ca.caPath}, y volve a correr este verificador.`,
    };
  }

  const probe = await probeCaChannel(hub.url, { timeoutMs: deadlineMs() });
  if (!probe.ok) {
    return {
      ok: false,
      detalle:
        `el .crt del archivo SI quedo en el store del proceso (subject ${ca.subject}, ` +
        `${ca.storeBefore} -> ${ca.storeAfter} certs) pero la conexion a ${hub.url} fallo: ` +
        `${probe.code ?? 'sin codigo'} — ${probe.error ?? 'sin detalle'} (fuente de la URL: ` +
        `${hub.source}). Un .crt valido PERO DE OTRO EMISOR pasa el mecanismo y muere aca: ` +
        'esa es la diferencia entre comprobar que el archivo existe y comprobar el efecto.',
      accion:
        `verifica desde ESTA maquina que ${hub.url} resuelva y este arriba, y revisa ` +
        'proxy/firewall. Si el CA del archivo es de otro emisor que el del Hub, corre ' +
        './specoe-setup-host.sh para reemplazarlo por el del starter.',
    };
  }

  return {
    ok: true,
    detalle:
      `handshake OK contra ${hub.url} (HTTP ${probe.status}, fuente de la URL: ${hub.source}); ` +
      `root ${ca.subject} en el store del proceso (${ca.storeBefore} -> ${ca.storeAfter} certs).`,
  };
}

// ----- chequeo 2 — JWT de licencia en el cache por-carpeta -----

async function checkJwtLicencia() {
  let cache;
  try {
    cache = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      detalle: `no se pudo leer el cache de licencia de este room (${CACHE_FILE}): ${err?.message}.`,
      accion:
        'abri una sesion de Claude Code en esta carpeta: el SessionStart hook valida la ' +
        'licencia y escribe el cache. Si el arranque falla, el mensaje del hook dice por que.',
    };
  }
  if (!cache?.token) {
    return {
      ok: false,
      detalle: `${CACHE_FILE} existe pero NO tiene token: la ultima corrida no obtuvo JWT del Hub.`,
      accion:
        'reabri la sesion de Claude Code en esta carpeta y segui el mensaje del hook de ' +
        'licencia (trae errno, URL, fuente de CA y accion).',
    };
  }
  const payload = decodeJwtPayload(cache.token);
  if (!payload) {
    return {
      ok: false,
      detalle: `el token del cache no es un JWT decodificable (${CACHE_FILE}).`,
      accion: `borra ${CACHE_FILE} y reabri la sesion de Claude Code en esta carpeta.`,
    };
  }
  if (typeof payload.exp !== 'number') {
    return {
      ok: false,
      detalle: 'el JWT del cache no declara `exp`: no se puede afirmar que siga vigente.',
      accion: `borra ${CACHE_FILE} y reabri la sesion de Claude Code en esta carpeta.`,
    };
  }
  const expMs = payload.exp * 1000;
  const restanteMin = Math.round((expMs - Date.now()) / 60000);
  if (expMs <= Date.now()) {
    return {
      ok: false,
      detalle:
        `el JWT de licencia VENCIO hace ${Math.abs(restanteMin)} min ` +
        `(exp ${new Date(expMs).toISOString()}, cache ${CACHE_FILE}). El skill-server lo ` +
        'va a rechazar con 401.',
      accion:
        'reabri la sesion de Claude Code en esta carpeta: el hook de licencia renueva el ' +
        'JWT en cada arranque.',
    };
  }
  return {
    ok: true,
    detalle:
      `JWT presente y vigente ${restanteMin} min mas (exp ${new Date(expMs).toISOString()}, ` +
      `rol ${payload.sddRole ?? 'sin claim sddRole'}, cache ${CACHE_FILE}).`,
  };
}

// ----- chequeo 3 — .mcp.json con JWT real, no el placeholder -----

async function checkMcpJsonJwt() {
  let doc;
  try {
    doc = await readMcpJson();
  } catch (err) {
    return {
      ok: false,
      detalle: `no se pudo leer ${MCP_JSON_FILE}: ${err?.message}.`,
      accion: 'corre ./setup.sh --room-only en esta carpeta para generar el .mcp.json.',
    };
  }
  const entry = doc?.mcpServers?.specoe;
  if (!entry) {
    return {
      ok: false,
      detalle:
        `${MCP_JSON_FILE} NO declara el server specoe. El hook lo retira cuando la corrida ` +
        'no tiene JWT usable: el room esta declarando, correctamente, que no esta servido.',
      accion:
        'reabri la sesion de Claude Code en esta carpeta y segui el mensaje del hook de ' +
        'licencia. El entry se reescribe solo en la primera corrida que valide.',
    };
  }
  const auth = entry?.headers?.Authorization;
  if (typeof auth !== 'string' || !auth.trim()) {
    return {
      ok: false,
      detalle: `el server specoe de ${MCP_JSON_FILE} no tiene header Authorization.`,
      accion: 'reabri la sesion de Claude Code en esta carpeta para que el hook lo escriba.',
    };
  }
  if (auth.includes(SKILL_JWT_PLACEHOLDER) || auth.includes('${')) {
    return {
      ok: false,
      detalle:
        `el header Authorization quedo con el placeholder sin expandir (${auth.trim()}) en ` +
        `${MCP_JSON_FILE}: el skill-server lo recibe literal y responde 401.`,
      accion:
        'reabri la sesion de Claude Code en esta carpeta: el hook de licencia escribe el ' +
        'JWT inline. Si sigue igual, el arranque no esta validando la licencia — mira su mensaje.',
    };
  }
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return {
      ok: false,
      detalle: `el header Authorization de ${MCP_JSON_FILE} no lleva un JWT decodificable.`,
      accion: 'reabri la sesion de Claude Code en esta carpeta para que el hook lo reescriba.',
    };
  }
  const expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  if (expMs !== null && expMs <= Date.now()) {
    return {
      ok: false,
      detalle:
        `el JWT escrito en ${MCP_JSON_FILE} VENCIO ` +
        `(exp ${new Date(expMs).toISOString()}): el server lo rechaza con 401.`,
      accion: 'reabri la sesion de Claude Code en esta carpeta para refrescarlo.',
    };
  }
  return {
    ok: true,
    detalle:
      `el server specoe declara un JWT real (rol ${payload.sddRole ?? 'sin claim sddRole'}` +
      `${expMs ? `, exp ${new Date(expMs).toISOString()}` : ''}), no el placeholder.`,
  };
}

// ----- chequeo 4 — el contrato del room BAJA del skill-server -----

async function checkContratoRoom() {
  let token = null;
  try {
    token = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))?.token ?? null;
  } catch {
    /* el chequeo 2 ya lo nombro */
  }
  if (!token) {
    return {
      ok: false,
      detalle:
        `sin JWT en ${CACHE_FILE} no hay con que pedir el contrato: el room arranca SIN su ` +
        'contrato de gobierno (el hook lo declara como SPECOE-ROOM-UNGOVERNED).',
      accion: 'resolve primero el chequeo 2 (JWT de licencia) y volve a correr el verificador.',
    };
  }
  const role = decodeJwtPayload(token)?.sddRole ?? null;
  if (!role) {
    return {
      ok: false,
      detalle:
        'el JWT de licencia no trae el claim sddRole: es una licencia de producto, no de un ' +
        'rol SDD, y el skill-server no tiene contrato de room para ella.',
      accion: 'instala esta carpeta como room con ./specoe-add-room.sh <ROL> <LICENSE_KEY>.',
    };
  }

  const session = new SseSession(DEFAULT_SKILL_SERVER_URL, `Bearer ${token}`);
  try {
    const conn = await session.connect(deadlineMs());
    if (!conn.ok) {
      return {
        ok: false,
        detalle:
          `el skill-server (${DEFAULT_SKILL_SERVER_URL}) no abrio la sesion para bajar el ` +
          `contrato: ${conn.reason}${conn.status ? ` (HTTP ${conn.status})` : ''}.`,
        accion:
          conn.status === 401
            ? 'el JWT del cache no fue aceptado: reabri la sesion de Claude Code en esta carpeta para renovarlo.'
            : `verifica que ${DEFAULT_SKILL_SERVER_URL} este arriba y alcanzable desde esta maquina.`,
      };
    }
    const init = await session.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'specoe-verify-room', version: '1.0.0' },
      },
      deadlineMs(),
    );
    if (init?.error) {
      return {
        ok: false,
        detalle: `el skill-server rechazo el initialize: ${init.error.message ?? 'sin detalle'}.`,
        accion: `verifica que ${DEFAULT_SKILL_SERVER_URL} sea un endpoint MCP/SSE valido.`,
      };
    }
    await session.notify('notifications/initialized', {});
    const res = await session.request(
      'tools/call',
      { name: 'room_contract_get', arguments: {} },
      deadlineMs(),
    );
    if (res?.error) {
      return {
        ok: false,
        detalle: `room_contract_get fallo: ${res.error.message ?? 'sin detalle'} (rol ${role}).`,
        accion:
          'pedi a un ADMIN del tenant que verifique que el rol tiene contrato de room ' +
          'publicado en el skill-server.',
      };
    }
    if (res?.result?.isError) {
      return {
        ok: false,
        detalle:
          `el skill-server respondio pero NO devolvio contrato para el rol ${role}: el room ` +
          'arrancaria sin gobierno.',
        accion:
          'pedi a un ADMIN del tenant que publique el contrato del room para este rol en el ' +
          'skill-server.',
      };
    }
    const contract = Array.isArray(res?.result?.content)
      ? res.result.content
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
      : '';
    if (!contract.trim()) {
      return {
        ok: false,
        detalle: `room_contract_get devolvio contenido VACIO para el rol ${role}.`,
        accion: 'pedi a un ADMIN del tenant que revise el contrato publicado para este rol.',
      };
    }
    // El sentinel no se escribe a mano aca: se arma con la MISMA funcion del hook que
    // inyecta el contrato en la sesion (buildAdditionalContext de specoe-room-bootstrap.mjs).
    // Verificar contra una copia de la string seria verificar mi copia, no el producto.
    const inyectable = buildAdditionalContext(role, contract);
    if (!inyectable.includes(`SPECOE-ROOM-CONTRACT:${role}`)) {
      return {
        ok: false,
        detalle:
          'el contrato bajo pero el texto que el hook inyectaria NO lleva el sentinel ' +
          `SPECOE-ROOM-CONTRACT del rol ${role}: el room no podria demostrar que su gobierno ` +
          'vino del server.',
        accion:
          'reporta esto a Integra Software: es una incoherencia del bundle, no de tu instalacion.',
      };
    }
    return {
      ok: true,
      detalle:
        `contrato del rol ${role} bajado del skill-server en esta corrida ` +
        `(${contract.length} chars) y con el sentinel SPECOE-ROOM-CONTRACT:${role} en el ` +
        'texto inyectable.',
    };
  } catch (err) {
    const net = describeNetworkError(err);
    return {
      ok: false,
      detalle:
        `no se pudo bajar el contrato del room desde ${DEFAULT_SKILL_SERVER_URL}: ` +
        `${net.code ?? 'sin codigo'} — ${net.cause ?? net.message}.`,
      accion:
        `verifica que ${DEFAULT_SKILL_SERVER_URL} este arriba y alcanzable desde esta ` +
        'maquina, y revisa el chequeo 1 (canal TLS).',
    };
  } finally {
    session.close();
  }
}

// ----- chequeo 5 — el server specoe es efectivamente conectable -----
//
// O5 exige que el veredicto cubra "el MCP specoe figura connected". Ese estado lo resuelve
// el cliente MCP de Claude Code y no es observable desde un proceso externo, asi que se
// cubre POR EFECTO en vez de bajar la vara: se abre el SSE contra la url declarada en el
// .mcp.json del room, con el header Authorization que ESE archivo tiene efectivamente
// escrito — no con el token del cache ni con una url propia — y se confirma que el
// skill-server acepta la sesion. Es lo mismo que hace el cliente al arrancar.

async function checkSpecoeConectable() {
  let entry;
  try {
    entry = (await readMcpJson())?.mcpServers?.specoe;
  } catch (err) {
    return {
      ok: false,
      detalle: `no se pudo leer ${MCP_JSON_FILE}: ${err?.message}.`,
      accion: 'corre ./setup.sh --room-only en esta carpeta para generar el .mcp.json.',
    };
  }
  if (!entry) {
    return {
      ok: false,
      detalle: `${MCP_JSON_FILE} no declara el server specoe: no hay nada que conectar.`,
      accion: 'reabri la sesion de Claude Code en esta carpeta (ver chequeo 3).',
    };
  }
  const url = expandEnvPlaceholders(entry.url);
  const auth = expandEnvPlaceholders(entry?.headers?.Authorization ?? '');
  if (!url.value || url.unresolved) {
    return {
      ok: false,
      detalle: `la url del server specoe quedo sin resolver en ${MCP_JSON_FILE}: ${url.value || '(vacia)'}.`,
      accion: 'reabri la sesion de Claude Code en esta carpeta para que el hook la escriba inline.',
    };
  }
  if (!auth.value || auth.unresolved) {
    return {
      ok: false,
      detalle:
        `el header Authorization del server specoe quedo sin resolver en ${MCP_JSON_FILE} ` +
        `(${auth.value || '(vacio)'}): el skill-server lo recibe literal y rechaza la sesion.`,
      accion: 'reabri la sesion de Claude Code en esta carpeta (ver chequeo 3).',
    };
  }

  const session = new SseSession(url.value, auth.value);
  try {
    const conn = await session.connect(deadlineMs());
    if (!conn.ok) {
      return {
        ok: false,
        detalle:
          `el skill-server NO acepto la sesion contra ${url.value} con el Authorization ` +
          `escrito en ${MCP_JSON_FILE}: ${conn.reason}` +
          `${conn.status ? ` (HTTP ${conn.status})` : ''}. El MCP specoe NO figuraria connected.`,
        accion:
          conn.status === 401
            ? 'el JWT del .mcp.json fue rechazado: reabri la sesion de Claude Code en esta carpeta para renovarlo.'
            : `verifica que ${url.value} este arriba y alcanzable desde esta maquina, y revisa el chequeo 1.`,
      };
    }
    const init = await session.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'specoe-verify-room', version: '1.0.0' },
      },
      deadlineMs(),
    );
    if (init?.error) {
      return {
        ok: false,
        detalle:
          `la sesion abrio contra ${url.value} pero el initialize fallo: ` +
          `${init.error.message ?? 'sin detalle'}.`,
        accion: `verifica que ${url.value} sea un endpoint MCP/SSE valido.`,
      };
    }
    const server = init?.result?.serverInfo;
    return {
      ok: true,
      detalle:
        `el skill-server acepto la sesion contra ${url.value} con el Authorization de ` +
        `${MCP_JSON_FILE} (HTTP ${conn.status}, initialize OK` +
        `${server?.name ? `, server ${server.name} ${server.version ?? ''}`.trimEnd() : ''}).`,
    };
  } catch (err) {
    const net = describeNetworkError(err);
    return {
      ok: false,
      detalle:
        `no se pudo abrir la sesion contra ${url.value}: ${net.code ?? 'sin codigo'} — ` +
        `${net.cause ?? net.message}. El MCP specoe NO figuraria connected.`,
      accion: `verifica que ${url.value} este arriba y revisa el chequeo 1 (canal TLS).`,
    };
  } finally {
    session.close();
  }
}

// ----- main -----

const RUNNERS = {
  'canal-tls-hub': checkCanalTlsHub,
  'jwt-licencia': checkJwtLicencia,
  'mcp-json-jwt': checkMcpJsonJwt,
  'contrato-room': checkContratoRoom,
  'specoe-conectable': checkSpecoeConectable,
};

async function main() {
  say(`${PREFIX} room: ${ROOM_DIR}`);
  say(
    `${PREFIX} deadlines: ${CHECK_DEADLINE_MS} ms por chequeo, ${TOTAL_DEADLINE_MS} ms total ` +
      '(fijos: dos corridas seguidas sin tocar nada dan el mismo veredicto).',
  );

  const fallaron = [];
  for (const check of CHECKS) {
    let res;
    try {
      res = await RUNNERS[check.id]();
    } catch (err) {
      // Un chequeo que revienta es un chequeo que NO pudo comprobar su efecto: es rojo,
      // nunca verde por omision.
      res = {
        ok: false,
        detalle: `el chequeo aborto con un error inesperado: ${err?.message ?? String(err)}.`,
        accion: 'reporta la salida completa a Integra Software (soporte@integrasoftware.biz).',
      };
    }
    emitCheck(check, res);
    if (!res.ok) fallaron.push(`${check.n} ${check.id}`);
  }

  if (fallaron.length === 0) {
    say(`${PREFIX} veredicto: SERVIDO — los 5 chequeos en verde.`);
    return 0;
  }
  say(
    `${PREFIX} veredicto: NO SERVIDO — fallaron ${fallaron.length} de 5: ${fallaron.join(', ')}.`,
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Nunca salir 0 por un error nuestro: el exit 0 es la afirmacion "el room esta servido"
    // y no se puede emitir sin haber corrido los cinco chequeos.
    say(`${PREFIX} veredicto: NO SERVIDO — el verificador aborto: ${err?.message ?? String(err)}`);
    process.exit(2);
  });
