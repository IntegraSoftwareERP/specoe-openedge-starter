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
//   4. contrato-room       el contrato del room BAJA del skill-server en ESTA corrida, con el
//                          token del CACHE (el que usa el hook que inyecta el contrato)
//   5. specoe-conectable   el skill-server acepta la sesion con la url y el header que el
//                          .mcp.json tiene efectivamente escritos Y le sirve EL MISMO
//                          contrato de rol que al chequeo 4 (no producto, no otro rol)
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
//   - el 5 abre el SSE con el token del .mcp.json y le PIDE el contrato del room: que el
//     server acepte la sesion no alcanza (ver abajo).
//
// ----- TKT-0225: POR QUE EL 5 NO SE CONFORMA CON QUE LA SESION ABRA -----
//
// El room usa DOS tokens: el hook que inyecta el contrato lee el del cache por-carpeta, y
// el cliente MCP de Claude Code usa el escrito en el .mcp.json. specoe-license-check.mjs
// los escribe juntos, pero nada impide que se separen despues (una edicion a mano del
// .mcp.json alcanza), y hasta TKT-0225 NADIE comparaba sus claims.
//
// Con esa divergencia, el 4 bajaba el contrato del rol con el token del cache y el 5 daba
// verde porque el server ACEPTABA la sesion con el otro token — y un token de producto la
// abre igual. Los cinco podian dar SERVIDO con la sesion real corriendo como producto: el
// verde falso, dentro de la herramienta que existe para detectarlo. Fue exactamente lo
// observado en SPEC-0164 P6.
//
// El 5 ahora discrimina el rol POR EFECTO: pide `room_contract_get` con el token del
// .mcp.json y exige que devuelva EL MISMO contrato que bajo el 4. Producto no tiene
// contrato de room (el tool responde isError) y otro rol devuelve otro texto: las dos
// divergencias mueren aca. Se discrimina por el contrato SERVIDO y no solo por el claim
// `sddRole` porque el contrato es el efecto y el claim es el medio: dos tokens con el mismo
// claim pero distinto contrato servido serian un verde falso igual.
//
// TKT-0232 — correccion de esta nota. Decia que "en USER-mode el rol lo resuelve el server
// desde el UserSddRole y el claim puede faltar legitimamente (TKT-0227)". Es FALSO, y era
// la hipotesis equivocada de aquel ticket: el skill-server resuelve
// `role = payload.sddRole ?? null` (auth.ts) y NO consulta UserSddRole en ningun momento.
// Lo que pasa en USER-mode es que el Hub DERIVA el claim del userId que el arranque manda
// en `userContext` — el claim DEBE estar, y si falta el room corre como producto. Un claim
// ausente nunca fue "una instalacion sana": era el bug que este ticket repara en
// specoe-license-check.mjs.
//
// ----- TKT-0234: POR QUE EL DEADLINE ES UN CORTE Y NO UNA DECLARACION -----
//
// El verificador anunciaba "deadlines: 8000 ms por chequeo, 40000 ms total" y NO los
// cumplia. Los dos numeros solo viajaban como argumento a `withTimeout`, que corre contra
// las esperas del stream SSE; los `fetch` de este archivo — el GET que abre el SSE y los
// POST de cada mensaje JSON-RPC — no tenian corte de ninguna clase. Un server que acepta la
// conexion y NUNCA manda cabeceras de respuesta (upstream caido detras del proxy, por
// ejemplo) dejaba ese `await fetch` pendiente para siempre: reproducido con un server de
// agujero negro, el chequeo 4 se colgo mas alla de los 40 s del deadline TOTAL y hubo que
// matar el proceso a mano. Es exactamente lo observado en la re-corrida de SPEC-0164 P6.
//
// El agujero no era del chequeo 4: era de la clase entera de esperas. Por eso el fix NO es
// ponerle timeout a la llamada que se colgo — es hacer estructural lo que estaba declarado:
//
//   1. cada `fetch` (GET del SSE y POST de mensajes) corre bajo `withDeadline`, que al
//      vencer ABORTA la sesion en vuelo en vez de esperarla;
//   2. cada CHEQUEO corre bajo su propio deadline como carrera: lo que no termine a tiempo
//      se corta y sale ROJO nombrando el corte. Vale para cualquier cuelgue, incluso uno
//      que no sea de red y que este codigo no anticipe — que es la unica forma honesta de
//      cerrar una clase de defecto en vez de su instancia;
//   3. el deadline TOTAL se respeta como reloj: un chequeo que arranca sin presupuesto no
//      corre, y lo dice.
//
// Un chequeo cortado NUNCA sale verde: cortarse es no haber podido observar el efecto, y
// este archivo entero existe para no dar verde sin observarlo. El corte tampoco puede ser
// un rojo comodo — la suite de esta correccion lleva control positivo (server sano => los
// chequeos 4 y 5 en OK) justamente para que un verificador que corte SIEMPRE no pase.
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
// ----- SPEC-0237 P4: LA ENTRADA DEL PROXY (ADR-007) -----
//
// Desde SPEC-0237 la entrada `specoe` del .mcp.json de un room al dia es la del PROXY local:
// `node --use-system-ca vendor/specoe-mcp-proxy.mjs`, por stdio, SIN JWT. El proxy toma el JWT del
// cache del room —el mismo con el que el hook baja el contrato— y lo renueva solo. Con esa entrada
// no hay "token del .mcp.json" que comparar, y la divergencia que queda es otra: que el room sirva
// un rol distinto del que DECLARA. Rol declarado: INTEGRA_SDD_ROLE, y si no esta, specoe.role del
// room (project.config.local.yaml gana sobre project.config.yaml). Con la entrada del proxy:
//   3. exige que el room traiga el proxy de su MANIFEST, que la entrada sea la CANONICA —se le
//      pregunta al propio proxy, corriendo su --install-entry sobre una copia del .mcp.json: si no
//      la cambiaria, es la suya— y un JWT vigente en el cache, del rol declarado;
//   4. baja el contrato con ese JWT solo si su rol es el declarado;
//   5. lanza el proxy COMO LO DECLARA la entrada, le habla MCP por stdio y exige el mismo contrato
//      que el 4: es lo que hace Claude Code al arrancar.
// Con la entrada SSE (room atrasado), los cinco chequeos son los de siempre. Sin rol declarado,
// 3 y 5 no comparan rol: se cruzan contra el contrato del cache, como con la SSE.
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
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { applyCaChannel, probeCaChannel, describeNetworkError } from '../hooks/ca-channel.mjs';
import {
  buildAdditionalContext,
  readRoomScalarWithSource,
  // SPEC-0237 P4 — la entrada del proxy: se reconoce, se juzga y se lanza con lo mismo que usan
  // los hooks, no con una copia de su forma.
  isProxyEntry,
  roomProxyStatus,
  runProxyInstallEntry,
  declaredRoleFromEnv,
  PROXY_VENDOR_PATH,
} from '../hooks/specoe-room-bootstrap.mjs';

// ----- parametros de corrida -----
//
// Deadline PROPIO por chequeo y deadline TOTAL. Sin esto, dos corridas seguidas dependen
// de cuanto tarde la red y el requisito de reproducibilidad de O5 (mismo veredicto en dos
// corridas sin tocar nada) no se puede cumplir: un chequeo que a veces espera 3 s y a
// veces 40 s no da el mismo resultado dos veces.
//
// TKT-0234 — el CHECK_DEADLINE_MS acota el chequeo ENTERO, no cada await por separado. El
// chequeo 4 encadena tres esperas de red (abrir el SSE, initialize, tools/call) y con el
// deadline por-espera podia tardar el triple de lo que el encabezado de la corrida declara.
// Ahora los 8000 ms son el techo del chequeo completo, que es lo que siempre dijo la linea
// de deadlines. Ambos numeros siguen siendo ajustables por entorno para instalaciones
// lentas, y los defaults dan 5 x 8000 = 40000, o sea el total exacto.
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
  // SPEC-0237 P4 — mismo id (ancla de grep); el titulo cubre las dos formas de la entrada: la SSE
  // lleva su JWT en el header y la del proxy lo toma del cache.
  { n: 3, id: 'mcp-json-jwt', titulo: '.mcp.json: entrada specoe con JWT usable' },
  { n: 4, id: 'contrato-room', titulo: 'contrato del room bajado del skill-server' },
  // TKT-0225 — el id no se renombra (es ancla de grep documentada en el QUICKSTART); lo que
  // cambio es la vara: conectable Y sirviendo el rol del room.
  { n: 5, id: 'specoe-conectable', titulo: 'server specoe conectable y sirviendo el rol' },
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

// ----- TKT-0234 — el corte de deadline -----

/** Vencimiento. Es un Symbol para que no pueda colisionar con ningun valor de retorno. */
const DEADLINE = Symbol('deadline vencido');

/**
 * Espera `promise` hasta `timeoutMs`. Si vence, corre `onTimeout` (para abortar lo que
 * quedo en vuelo) y devuelve DEADLINE; el llamador decide que rojo emitir.
 *
 * Detalle que importa: `promise` se envuelve en una que NUNCA se rechaza. Un `fetch`
 * abortado por `onTimeout` se rechaza DESPUES de que la carrera ya quedo resuelta, y ese
 * rechazo suelto voltearia el proceso entero con un unhandled rejection — o sea, cambiar
 * un cuelgue por una caida. El error real, cuando llega a tiempo, se relanza tal cual: los
 * chequeos lo traducen con describeNetworkError y el errno es la mitad del diagnostico.
 */
function withDeadline(promise, timeoutMs, onTimeout) {
  let timer = null;
  const corte = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        try {
          onTimeout?.();
        } catch {
          /* abortar lo que quedo en vuelo no puede impedir el corte */
        }
        resolve(DEADLINE);
      },
      Math.max(0, timeoutMs),
    );
  });
  const atrapada = Promise.resolve(promise).then(
    (valor) => ({ valor }),
    (error) => ({ error }),
  );
  return Promise.race([atrapada, corte]).then((r) => {
    clearTimeout(timer);
    if (r === DEADLINE) return DEADLINE;
    if (r.error) throw r.error;
    return r.valor;
  });
}

/**
 * Sesiones SSE vivas. Un chequeo cortado por su deadline deja el socket en vuelo y el
 * proceso no tiene por que quedarse esperandolo: el corte las cierra a todas.
 */
const SESIONES_ABIERTAS = new Set();

function cerrarSesionesAbiertas() {
  for (const s of [...SESIONES_ABIERTAS]) s.close();
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
 * env INTEGRA_HUB_URL > hub.api-url del room > fallback interno.
 * Reimplementada a proposito (ver cabecera): el hook de licencia no se importa. La lectura del yaml
 * SI sale del hook de arranque, que este script ya importa: TKT-0448 — project.config.local.yaml
 * gana sobre el versionado, y la regla vive una sola vez del lado de los hooks.
 */
async function resolveHubUrl() {
  if (process.env.INTEGRA_HUB_URL) {
    return { url: process.env.INTEGRA_HUB_URL, source: 'env INTEGRA_HUB_URL' };
  }
  const { value, source } = await readRoomScalarWithSource(ROOM_DIR, 'hub', 'api-url');
  if (value && value.trim()) {
    return { url: value.trim(), source: `${path.join(ROOM_DIR, source)} (hub.api-url)` };
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

/** La entrada `specoe` del .mcp.json, o null si no se puede leer (los chequeos 3 y 5 lo nombran). */
async function readSpecoeEntry() {
  try {
    return (await readMcpJson())?.mcpServers?.specoe ?? null;
  } catch {
    return null;
  }
}

/** El JWT del cache de licencia del room, o null. */
async function readCacheToken() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'))?.token ?? null;
  } catch {
    return null;
  }
}

/** El claim sddRole de un JWT, normalizado como el rol declarado. null si no lo trae. */
function rolDelToken(token) {
  const r = decodeJwtPayload(token)?.sddRole;
  return typeof r === 'string' && r.trim() ? r.trim().toUpperCase() : null;
}

/**
 * SPEC-0237 P4 (ADR-007) — el rol que el room DECLARA: INTEGRA_SDD_ROLE (la del launcher o el plugin,
 * normalizada como la del hook de licencia) y, si no esta, specoe.role del room con su precedencia
 * (project.config.local.yaml gana). `{ rol, fuente }` o null si no declara ninguno.
 */
async function resolveRolDeclarado() {
  const env = declaredRoleFromEnv();
  if (env) return { rol: env, fuente: 'env INTEGRA_SDD_ROLE' };
  try {
    const { value, source } = await readRoomScalarWithSource(ROOM_DIR, 'specoe', 'role');
    const rol = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (rol) return { rol, fuente: `${path.join(ROOM_DIR, source)} (specoe.role)` };
  } catch {
    /* sin yaml legible: no hay rol declarado */
  }
  return null;
}

const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;

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
    SESIONES_ABIERTAS.add(this);
  }

  async connect(timeoutMs) {
    const t0 = Date.now();
    // TKT-0234 — `fetch` sin corte propio era el cuelgue: un server que acepta el TCP y no
    // manda cabeceras deja este await pendiente para siempre, y el deadline del chequeo
    // (que solo acotaba las esperas del stream, mas abajo) nunca lo alcanzaba.
    const res = await withDeadline(
      fetch(this.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: this.authorization },
        signal: this.controller.signal,
      }),
      timeoutMs,
      () => this.close(),
    );
    if (res === DEADLINE) {
      this.close();
      return { ok: false, reason: `sin-respuesta-al-GET-en-${timeoutMs}ms` };
    }
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
    // Lo que queda del deadline, no el deadline entero: abrir el socket ya consumio parte.
    const endpoint = await this.withTimeout(endpointPromise, timeoutMs - (Date.now() - t0));
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

  /**
   * POST de un mensaje JSON-RPC. `{ timeout:true }` si el server no contesto cabeceras
   * dentro del deadline — el segundo agujero de TKT-0234: el POST no tenia corte tampoco,
   * asi que un /messages que acepta y se calla colgaba igual que el GET.
   */
  async post(body, timeoutMs) {
    const res = await withDeadline(
      fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.authorization },
        body: JSON.stringify(body),
        signal: this.controller.signal,
      }),
      timeoutMs,
      () => this.close(),
    );
    if (res === DEADLINE) return { timeout: true };
    // El cuerpo de la respuesta se descarta SIEMPRE y sin esperarlo: undici no devuelve el
    // socket al pool mientras una respuesta siga sin consumir, y el 202 del transporte MCP
    // no trae nada que este verificador tenga que leer. La respuesta viene por el stream.
    res.body?.cancel?.().catch(() => {});
    return { ok: res.ok, status: res.status };
  }

  /** JSON-RPC request: POST + espera la respuesta por el stream. null si no llego a tiempo. */
  async request(method, params, timeoutMs) {
    const t0 = Date.now();
    const id = this.nextId++;
    const waiter = new Promise((resolve) => this.pending.set(id, resolve));
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    if (res.timeout) {
      this.pending.delete(id);
      return { error: { message: `el POST de ${method} no respondio en ${timeoutMs} ms` } };
    }
    if (!res.ok && res.status !== 202) {
      this.pending.delete(id);
      return { error: { message: `POST ${method} -> HTTP ${res.status}` } };
    }
    const msg = await this.withTimeout(waiter, timeoutMs - (Date.now() - t0));
    if (!msg) {
      this.pending.delete(id);
      return { error: { message: `sin respuesta a ${method} dentro del deadline` } };
    }
    return msg;
  }

  async notify(method, params, timeoutMs) {
    await this.post({ jsonrpc: '2.0', method, params }, timeoutMs);
  }

  close() {
    SESIONES_ABIERTAS.delete(this);
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.abort();
    } catch {
      /* ya cerrado */
    }
  }
}

// ----- SPEC-0237 P4 — cliente MCP minimo por stdio, para hablarle al proxy -----
//
// Con la entrada del proxy el chequeo 5 lanza el proceso COMO LO DECLARA el .mcp.json (command y
// args, con el room como cwd: el path del proxy es relativo) y le habla MCP por stdio, un mensaje
// JSON-RPC por linea. Es lo que hace Claude Code al arrancar. Misma interfaz que SseSession
// (request/notify/close) para que el handshake y el pedido del contrato sean el MISMO codigo que en
// los chequeos por SSE. Sin SDK, por la misma razon que SseSession. Cerrar la sesion cierra el
// stdin y mata el proceso: el proxy termina cuando se le cierra el stdin, pero el corte de un
// deadline no puede depender de eso.
class StdioSession {
  constructor(command, args, { cwd, env }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.child = null;
    this.finished = null;
    this.stderrTail = '';
    SESIONES_ABIERTAS.add(this);
  }

  start() {
    try {
      this.child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.finished = `no se pudo lanzar: ${err?.message}`;
      return { ok: false, reason: this.finished };
    }
    this.child.on('error', (err) => this.fail(`no se pudo lanzar: ${err?.message}`));
    this.child.on('exit', (code, signal) => this.fail(`el proceso termino (${code ?? signal})`));
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c.toString('utf8')).slice(-600);
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // una linea que no es JSON-RPC no es respuesta de nadie
      }
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    return { ok: true };
  }

  fail(reason) {
    if (!this.finished) this.finished = reason;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ error: { message: this.describe(reason) } });
    }
  }

  describe(reason) {
    const tail = this.stderrTail.trim();
    return tail ? `${reason}; stderr: ${tail}` : reason;
  }

  write(obj) {
    if (this.closed || this.finished || !this.child?.stdin?.writable) return false;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          resolve({ error: { message: `sin respuesta a ${method} por stdio en ${timeoutMs} ms` } });
        },
        Math.max(0, timeoutMs),
      );
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          error: {
            message: this.describe(this.finished ?? 'el stdin del proceso no esta abierto'),
          },
        });
      }
    });
  }

  async notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close() {
    SESIONES_ABIERTAS.delete(this);
    if (this.closed) return;
    this.closed = true;
    this.fail('sesion cerrada por el verificador');
    try {
      this.child?.stdin?.end();
    } catch {
      /* ya cerrado */
    }
    try {
      this.child?.kill();
    } catch {
      /* ya termino */
    }
  }
}

// ----- handshake MCP + pedido del contrato (compartido por los chequeos 4 y 5) -----
//
// TKT-0225 — los chequeos 4 y 5 hacen la MISMA pregunta al server con tokens DISTINTOS a
// proposito (el 4 con el del cache, el 5 con el del .mcp.json) y despues comparan las dos
// respuestas. Para que la comparacion signifique algo, la pregunta tiene que ser
// literalmente el mismo codigo: dos copias que se separen convierten la diferencia de
// implementacion en una divergencia de rol falsa.
//
// `session` ya tiene que estar conectada (SSE abierto y evento `endpoint` recibido).

/** Concatena el texto de un `content[]` MCP. '' si no hay partes de texto. */
function textoDeContent(content) {
  return Array.isArray(content)
    ? content
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
    : '';
}

async function handshakeYContrato(session) {
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
    return { ok: false, etapa: 'initialize', detalle: init.error.message ?? 'sin detalle' };
  }
  const serverInfo = init?.result?.serverInfo ?? null;
  await session.notify('notifications/initialized', {}, deadlineMs());

  const res = await session.request(
    'tools/call',
    { name: 'room_contract_get', arguments: {} },
    deadlineMs(),
  );
  if (res?.error) {
    return { ok: false, etapa: 'rpc', serverInfo, detalle: res.error.message ?? 'sin detalle' };
  }
  // El server responde isError cuando el rol del AuthContext es null (producto) o cuando el
  // rol no tiene contrato publicado. El texto del error distingue los dos casos y se propaga
  // tal cual: es el dato que le dice al dev cual de los dos le toco.
  if (res?.result?.isError) {
    return {
      ok: false,
      etapa: 'sin-contrato',
      serverInfo,
      detalle: textoDeContent(res.result.content).trim() || 'el tool respondio isError sin texto',
    };
  }
  const contrato = textoDeContent(res?.result?.content);
  if (!contrato.trim()) {
    return { ok: false, etapa: 'vacio', serverInfo, detalle: 'room_contract_get devolvio vacio' };
  }
  return { ok: true, serverInfo, contrato };
}

// TKT-0225 — lo que el chequeo 4 bajo con el token del CACHE, para que el 5 lo cruce contra
// lo que baja con el token del .mcp.json. `texto` queda en null si el 4 no llego a bajarlo:
// sin el, el 5 no puede completar su comprobacion y no da verde por omision.
const CONTRATO_DEL_CACHE = { rol: null, texto: null };

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
  if (isProxyEntry(entry)) return checkMcpJsonProxy(entry);
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

// ----- chequeo 3 con la entrada del proxy (SPEC-0237 P4, ADR-007) -----
//
// Tres cosas, y ninguna se conforma con que la entrada "se parezca":
//   - el room trae el proxy que declara su MANIFEST (el archivo con ese sha): Claude Code lanza
//     ESE archivo;
//   - la entrada es la canonica. No se compara contra una copia de la forma: se le pregunta al
//     PROPIO proxy, corriendo su --install-entry sobre una copia del .mcp.json en un temporal. Si
//     no la cambiaria, es la suya; si la reescribiria, alguien le agrego algo (url, headers, env,
//     un JWT) o le saco algo;
//   - hay en el cache un JWT vigente, y es del rol que el room declara: es el que el proxy va a
//     presentar.

/** Le pregunta al proxy del room si la entrada es la suya, sin tocar la carpeta. */
async function juzgarFormaDelProxy(entry) {
  const extras = Object.keys(entry).filter((k) => !['type', 'command', 'args'].includes(k));
  const conJwt = JWT_SHAPE.test(JSON.stringify(entry));
  const pistas =
    (extras.length ? `; trae claves que la entrada del proxy no lleva: ${extras.join(', ')}` : '') +
    (conJwt ? '; lleva un string con forma de JWT, y la entrada del proxy no lleva ninguno' : '');
  let tmp = null;
  try {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'specoe-verify-entrada-'));
    await fs.copyFile(MCP_JSON_FILE, path.join(tmp, '.mcp.json'));
    const r = await runProxyInstallEntry({
      roomDir: ROOM_DIR,
      targetDir: tmp,
      timeoutMs: Math.max(1000, Math.min(5000, deadlineMs())),
    });
    if (r.outcome === 'UNCHANGED') return { ok: true };
    if (r.outcome === 'WRITTEN') {
      return {
        ok: false,
        detalle: `el propio proxy la reescribiria (su --install-entry sobre una copia del .mcp.json no la deja igual)${pistas}`,
      };
    }
    return {
      ok: false,
      detalle: `el proxy no pudo juzgarla: ${r.error ?? 'sin detalle'}${pistas}`,
    };
  } catch (err) {
    return { ok: false, detalle: `no se pudo preparar la copia para juzgarla: ${err?.message}` };
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkMcpJsonProxy(entry) {
  const proxy = await roomProxyStatus(ROOM_DIR);
  if (!proxy.ok) {
    return {
      ok: false,
      detalle:
        `${MCP_JSON_FILE} declara specoe con la entrada del proxy (${PROXY_VENDOR_PATH}), pero ` +
        `${proxy.detalle}. Claude Code lanzaria un proxy que no es el que declara el room, o ninguno.`,
      accion:
        'actualiza la carpeta del room (el Actualizar del plugin de VSCode, o git pull --ff-only en ' +
        'la carpeta): vendor/ trae el proxy y su MANIFEST juntos. Si el archivo se toco a mano, el ' +
        'pull lo restituye.',
    };
  }
  const forma = await juzgarFormaDelProxy(entry);
  if (!forma.ok) {
    return {
      ok: false,
      detalle: `la entrada specoe de ${MCP_JSON_FILE} lanza el proxy pero NO es la canonica: ${forma.detalle}.`,
      accion:
        `en la carpeta del room corre: node --use-system-ca ${PROXY_VENDOR_PATH} --install-entry ` +
        '(o reabri la sesion: el hook de licencia la reescribe). No le agregues url, headers, env ' +
        'ni JWT a mano: el proxy toma el JWT del cache del room y lo renueva solo.',
    };
  }
  const token = await readCacheToken();
  const payload = token ? decodeJwtPayload(token) : null;
  const expMs = typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  if (!payload || expMs === null || expMs <= Date.now()) {
    return {
      ok: false,
      detalle:
        `la entrada del proxy es la canonica, pero en ${CACHE_FILE} no hay un JWT vigente ` +
        `(${!token ? 'no hay token' : !payload ? 'el token no se puede decodificar' : expMs === null ? 'el JWT no declara exp' : `vencio ${new Date(expMs).toISOString()}`}). ` +
        'El proxy no tiene con que abrir la sesion hasta que lo renueve.',
      accion:
        'reabri la sesion de Claude Code en esta carpeta: el hook de licencia deja un JWT nuevo en ' +
        'el cache. Si no lo deja, su mensaje de arranque dice por que.',
    };
  }
  const servido = rolDelToken(token);
  const declarado = await resolveRolDeclarado();
  if (declarado && servido !== declarado.rol) {
    return {
      ok: false,
      detalle:
        `la entrada del proxy es la canonica y el JWT del cache esta vigente, pero es del rol ` +
        `${servido ?? 'sin claim sddRole (bundle producto)'} y el room declara ${declarado.rol} ` +
        `(${declarado.fuente}). El proxy presenta el JWT del cache: los tools MCP servirian el rol ` +
        `${servido ?? 'producto'}, no el declarado.`,
      accion:
        'abri la carpeta con el rol que le corresponde (el plugin de VSCode o ' +
        './specoe-launch-thinclient.sh <ROL>) y mira el aviso de rol del arranque: el hook de ' +
        'licencia pide el rol declarado y el Hub decide cual concede.',
    };
  }
  return {
    ok: true,
    detalle:
      `entrada del proxy canonica (${PROXY_VENDOR_PATH}, sha ${proxy.sha256.slice(0, 12)} del ` +
      `MANIFEST, sin JWT en el .mcp.json) y JWT vigente en el cache hasta ` +
      `${new Date(expMs).toISOString()}, rol ${servido ?? 'sin claim sddRole'}` +
      `${declarado ? ` = declarado (${declarado.fuente})` : ' — el room no declara rol: no se compara'}.`,
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
    // TKT-0232 — el mensaje viejo atribuia esto SIEMPRE a "licencia de producto, instala con
    // una licencia con rol". Ese razonamiento es de MACHINE-mode, donde el claim sale de
    // License.sddRole. En USER-mode el claim se DERIVA del userId del seat que el arranque
    // manda como `userContext`, y falta por cualquiera de tres motivos que se reparan
    // distinto. Mandar a cambiar la licencia cuando lo que falta es el login SDD es mandar a
    // arreglar lo que no esta roto: el room se queda igual de producto y el dev pierde la
    // corrida. Las dos causas se nombran, sin fingir que este proceso sabe el modo del
    // tenant (no lo puede leer: vive en Tenant.sddIdentityMode, server-side).
    return {
      ok: false,
      detalle:
        'el JWT de licencia no trae el claim sddRole, asi que el skill-server le sirve el ' +
        'bundle PRODUCTO y no tiene contrato de room que darle. El claim falta por una de ' +
        'dos razones segun el modo de identidad del tenant: en MACHINE-mode, porque la ' +
        'licencia no tiene rol SDD; en USER-mode, porque el arranque no pudo declarar el ' +
        'usuario del seat (sin login SDD en esta maquina, o el usuario no tiene exactamente ' +
        'UN rol SDD activo — con cero o con mas de uno el Hub emite el JWT sin claim).',
      accion:
        'en USER-mode: corre ./setup.sh --login en esta maquina y volve a abrir la sesion ' +
        '(el login deja el userId del seat en el keyring y el arranque lo manda como ' +
        'userContext); si el login ya esta hecho, pedi a un ADMIN del tenant que verifique ' +
        'que tu usuario tenga UN solo rol SDD activo. En MACHINE-mode: instala esta carpeta ' +
        'como room con ./specoe-add-room.sh <ROL> <LICENSE_KEY>.',
    };
  }

  // SPEC-0237 P4 (ADR-007) — con la entrada del proxy, el JWT del cache es el que sirve los tools
  // MCP de la sesion. Si es de otro rol que el declarado, bajar el contrato con el certificaria el
  // gobierno del rol equivocado: no se baja.
  if (isProxyEntry(await readSpecoeEntry())) {
    const declarado = await resolveRolDeclarado();
    const servido = rolDelToken(token);
    if (declarado && servido !== declarado.rol) {
      return {
        ok: false,
        detalle:
          `el JWT del cache es del rol ${servido} y el room declara ${declarado.rol} ` +
          `(${declarado.fuente}). Con la entrada del proxy ese JWT es el que sirve los tools MCP, ` +
          'asi que bajar el contrato con el daria el gobierno del rol equivocado: no se baja.',
        accion:
          'abri la carpeta con el rol que le corresponde (el plugin de VSCode o ' +
          './specoe-launch-thinclient.sh <ROL>) y volve a correr el verificador.',
      };
    }
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
    const pedido = await handshakeYContrato(session);
    if (!pedido.ok) {
      if (pedido.etapa === 'initialize') {
        return {
          ok: false,
          detalle: `el skill-server rechazo el initialize: ${pedido.detalle}.`,
          accion: `verifica que ${DEFAULT_SKILL_SERVER_URL} sea un endpoint MCP/SSE valido.`,
        };
      }
      if (pedido.etapa === 'rpc') {
        return {
          ok: false,
          detalle: `room_contract_get fallo: ${pedido.detalle} (rol ${role}).`,
          accion:
            'pedi a un ADMIN del tenant que verifique que el rol tiene contrato de room ' +
            'publicado en el skill-server.',
        };
      }
      if (pedido.etapa === 'vacio') {
        return {
          ok: false,
          detalle: `room_contract_get devolvio contenido VACIO para el rol ${role}.`,
          accion: 'pedi a un ADMIN del tenant que revise el contrato publicado para este rol.',
        };
      }
      return {
        ok: false,
        detalle:
          `el skill-server respondio pero NO devolvio contrato para el rol ${role} ` +
          `("${pedido.detalle}"): el room arrancaria sin gobierno.`,
        accion:
          'pedi a un ADMIN del tenant que publique el contrato del room para este rol en el ' +
          'skill-server.',
      };
    }
    const contract = pedido.contrato;
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
    // TKT-0225 — lo que bajo con el token del CACHE queda disponible para el chequeo 5, que
    // baja lo mismo con el token del .mcp.json y los cruza.
    CONTRATO_DEL_CACHE.rol = role;
    CONTRATO_DEL_CACHE.texto = contract;
    return {
      ok: true,
      detalle:
        `contrato del rol ${role} bajado del skill-server en esta corrida ` +
        `(${contract.length} chars, token del cache) y con el sentinel ` +
        `SPECOE-ROOM-CONTRACT:${role} en el texto inyectable.`,
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

// ----- chequeo 5 — el server specoe es conectable Y le sirve el rol del room -----
//
// O5 exige que el veredicto cubra "el MCP specoe figura connected". Ese estado lo resuelve
// el cliente MCP de Claude Code y no es observable desde un proceso externo, asi que se
// cubre POR EFECTO en vez de bajar la vara: se abre el SSE contra la url declarada en el
// .mcp.json del room, con el header Authorization que ESE archivo tiene efectivamente
// escrito — no con el token del cache ni con una url propia — y se confirma que el
// skill-server acepta la sesion. Es lo mismo que hace el cliente al arrancar.
//
// TKT-0225 — aceptar la sesion NO alcanza: un JWT de producto tambien la abre. Sobre la
// sesion abierta se pide `room_contract_get` y se exige que devuelva EL MISMO contrato que
// bajo el chequeo 4 con el token del cache. Es el unico modo de afirmar que la sesion real
// corre con el rol del room y no como producto (ver la cabecera del archivo).

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
  if (isProxyEntry(entry)) return checkSpecoeProxy(entry);
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
    const pedido = await handshakeYContrato(session);
    if (!pedido.ok && pedido.etapa === 'initialize') {
      return {
        ok: false,
        detalle: `la sesion abrio contra ${url.value} pero el initialize fallo: ${pedido.detalle}.`,
        accion: `verifica que ${url.value} sea un endpoint MCP/SSE valido.`,
      };
    }
    const server = pedido.serverInfo;
    const sesion =
      `la sesion abrio contra ${url.value} con el Authorization de ${MCP_JSON_FILE} ` +
      `(HTTP ${conn.status}, initialize OK` +
      `${server?.name ? `, server ${server.name} ${server.version ?? ''}`.trimEnd() : ''})`;

    // TKT-0225 — el caso del verde falso: el server ACEPTA la sesion pero no le sirve
    // bundle de rol. Con el token de producto `room_contract_get` responde isError, y hasta
    // este fix eso pasaba desapercibido porque el chequeo terminaba en el initialize.
    if (!pedido.ok) {
      return {
        ok: false,
        detalle:
          `${sesion}, PERO el server NO le sirve el contrato del room a ese token: ` +
          `${pedido.detalle}. La sesion de Claude Code corre con el JWT del .mcp.json, no ` +
          `con el del cache: si ese token es de producto (sin rol SDD), los tools MCP ` +
          `sirven el bundle producto aunque el hook haya inyectado el contrato del rol ` +
          `${CONTRATO_DEL_CACHE.rol ?? 'del cache'}. El room NO esta servido.`,
        accion:
          'el JWT del .mcp.json y el del cache del room divergieron (una edicion a mano del ' +
          '.mcp.json alcanza). Reabri la sesion de Claude Code en esta carpeta sin editar el ' +
          '.mcp.json: specoe-license-check.mjs reescribe el entry con el MISMO token que deja ' +
          'en el cache. Si persiste, reinstala el room con ./specoe-add-room.sh <ROL> <LICENSE_KEY>.',
      };
    }

    // Sin el contrato del chequeo 4 no hay contra que cruzar. Un chequeo que no puede
    // observar su efecto NO da verde (mismo criterio que el resto del archivo).
    if (!CONTRATO_DEL_CACHE.texto) {
      return {
        ok: false,
        detalle:
          `${sesion} y el server le sirvio un contrato de room (${pedido.contrato.length} ` +
          'chars), pero el chequeo 4 no dejo el contrato del token del cache: sin el no se ' +
          'puede afirmar que los dos tokens sirvan el MISMO rol.',
        accion: 'resolve primero el chequeo 4 (contrato del room) y volve a correr el verificador.',
      };
    }

    // Dos tokens, dos roles: el hook inyecta el contrato de uno y los tools MCP sirven el
    // bundle del otro. La sesion queda incoherente aunque los dos extremos anden.
    if (pedido.contrato !== CONTRATO_DEL_CACHE.texto) {
      return {
        ok: false,
        detalle:
          `${sesion} y el server le sirvio contrato de room, pero es OTRO contrato que el ` +
          `del token del cache (${pedido.contrato.length} vs ` +
          `${CONTRATO_DEL_CACHE.texto.length} chars, rol del cache ` +
          `${CONTRATO_DEL_CACHE.rol}): los dos tokens del room resuelven a roles DISTINTOS. ` +
          'El hook inyectaria el contrato de un rol y los tools MCP servirian el bundle de otro.',
        accion:
          'reabri la sesion de Claude Code en esta carpeta sin editar el .mcp.json a mano: ' +
          'specoe-license-check.mjs escribe el mismo token en el cache y en el .mcp.json. Si ' +
          'la carpeta tiene que ser otro rol, reinstalala con ./specoe-add-room.sh <ROL> <LICENSE_KEY>.',
      };
    }

    return {
      ok: true,
      detalle:
        `${sesion} y el server le sirvio al token del .mcp.json EL MISMO contrato de room ` +
        `que al token del cache (rol ${CONTRATO_DEL_CACHE.rol}, ${pedido.contrato.length} ` +
        'chars): la sesion corre con el rol del room, no como producto.',
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

// ----- chequeo 5 con la entrada del proxy (SPEC-0237 P4, ADR-007) -----
//
// Se lanza el proxy COMO LO DECLARA la entrada (command, args, el room como cwd) y se le habla MCP
// por stdio: lo mismo que hace Claude Code. Se le pide `room_contract_get` y se exige el MISMO
// contrato que bajo el 4. El rol servido es el del JWT del cache, que es el unico que el proxy
// presenta; si el room declara otro, el 5 da rojo nombrando los dos.

async function checkSpecoeProxy(entry) {
  const declarado = await resolveRolDeclarado();
  const servido = rolDelToken(await readCacheToken());
  const lanzado = [entry.command, ...entry.args].join(' ');
  const env = {
    ...process.env,
    ...(entry.env && typeof entry.env === 'object' ? entry.env : {}),
    CLAUDE_PROJECT_DIR: ROOM_DIR,
  };
  const session = new StdioSession(entry.command, entry.args, { cwd: ROOM_DIR, env });
  try {
    const st = session.start();
    if (!st.ok) {
      return {
        ok: false,
        detalle: `no se pudo lanzar el proxy como lo declara ${MCP_JSON_FILE} (${lanzado}): ${st.reason}. El MCP specoe NO figuraria connected.`,
        accion: `verifica que '${entry.command}' este en el PATH de esta maquina y que ${PROXY_VENDOR_PATH} este en el room (chequeo 3).`,
      };
    }
    const pedido = await handshakeYContrato(session);
    if (!pedido.ok && pedido.etapa === 'initialize') {
      return {
        ok: false,
        detalle: `el proxy (${lanzado}, cwd ${ROOM_DIR}) no completo el initialize por stdio: ${pedido.detalle}. El MCP specoe NO figuraria connected.`,
        accion: 'mira el log del proxy: ~/.claude/logs/specoe-mcp-proxy-<fecha>.log.',
      };
    }
    const server = pedido.serverInfo;
    const sesion =
      `el proxy arranco como lo declara ${MCP_JSON_FILE} (${lanzado}) y completo el initialize ` +
      `por stdio${server?.name ? ` (server ${server.name} ${server.version ?? ''}`.trimEnd() + ')' : ''}`;
    const roles =
      `rol del JWT del cache ${servido ?? 'sin claim sddRole'}` +
      `${declarado ? `, rol declarado ${declarado.rol} (${declarado.fuente})` : ', el room no declara rol'}`;

    if (!pedido.ok) {
      return {
        ok: false,
        detalle: `${sesion}, PERO no le sirvio el contrato del room: ${pedido.detalle} (${roles}). El room NO esta servido.`,
        accion: pedido.detalle.includes('SPECOE-PROXY-SIN-CREDENCIAL')
          ? 'el proxy no tiene un JWT usable: reabri la sesion de Claude Code en esta carpeta (el hook de licencia lo deja en el cache) y mira el log del proxy (~/.claude/logs/specoe-mcp-proxy-<fecha>.log).'
          : 'si el JWT del cache no trae rol, el room corre como producto: mira el chequeo 4 y el mensaje de arranque del hook de licencia.',
      };
    }

    if (declarado && servido !== declarado.rol) {
      return {
        ok: false,
        detalle:
          `${sesion} y le sirvio el contrato del rol ${servido ?? 'sin claim sddRole (producto)'} —el ` +
          `del JWT del cache, que es el que presenta el proxy—, pero el room declara ${declarado.rol} ` +
          `(${declarado.fuente}). Los tools MCP de la sesion servirian el rol ${servido ?? 'producto'}.`,
        accion:
          'abri la carpeta con el rol que le corresponde (el plugin de VSCode o ' +
          './specoe-launch-thinclient.sh <ROL>) y volve a correr el verificador.',
      };
    }

    if (!CONTRATO_DEL_CACHE.texto) {
      return {
        ok: false,
        detalle:
          `${sesion} y le sirvio un contrato de room (${pedido.contrato.length} chars), pero el ` +
          'chequeo 4 no dejo el contrato del cache: sin el no se puede afirmar que sea el mismo.',
        accion: 'resolve primero el chequeo 4 (contrato del room) y volve a correr el verificador.',
      };
    }

    if (pedido.contrato !== CONTRATO_DEL_CACHE.texto) {
      return {
        ok: false,
        detalle:
          `${sesion} y le sirvio contrato de room, pero es OTRO que el que bajo el chequeo 4 ` +
          `(${pedido.contrato.length} vs ${CONTRATO_DEL_CACHE.texto.length} chars, ${roles}): el ` +
          'proxy y el hook resuelven a roles DISTINTOS.',
        accion:
          'reabri la sesion de Claude Code en esta carpeta; si persiste, mira el log del proxy ' +
          '(~/.claude/logs/specoe-mcp-proxy-<fecha>.log): con un JWT renovado a otro rol, el proxy ' +
          'y el cache divergieron.',
      };
    }

    return {
      ok: true,
      detalle:
        `${sesion} y le sirvio EL MISMO contrato de room que bajo el chequeo 4 ` +
        `(${pedido.contrato.length} chars, ${roles}): la sesion corre con el rol del room, no como producto.`,
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

/**
 * TKT-0234 — corre un chequeo CON su deadline como corte duro.
 *
 * El corte va aca, envolviendo al chequeo entero, y no solo dentro de cada llamada de red:
 * asi cubre tambien un cuelgue que este archivo no anticipe (parseo, disco, una espera
 * futura que alguien agregue sin timeout). Un chequeo cortado sale ROJO — cortarse es no
 * haber podido observar el efecto, y este verificador no da verde sin observarlo.
 */
async function runCheck(check) {
  const ms = deadlineMs();
  if (ms <= 0) {
    return {
      ok: false,
      detalle:
        `no se corrio: el deadline TOTAL (${TOTAL_DEADLINE_MS} ms) ya estaba agotado al ` +
        'llegar a este chequeo, asi que su efecto no se pudo observar.',
      accion:
        'resolve primero los chequeos anteriores que se comieron el tiempo, o subi ' +
        'SPECOE_VERIFY_TOTAL_TIMEOUT_MS si esta instalacion es legitimamente lenta.',
    };
  }
  const res = await withDeadline(RUNNERS[check.id](), ms, cerrarSesionesAbiertas);
  if (res === DEADLINE) {
    return {
      ok: false,
      detalle:
        `el chequeo NO termino dentro de su deadline de ${ms} ms y se corto. Lo tipico es ` +
        'un server que acepta la conexion y no responde (upstream caido detras del proxy, ' +
        'red que traga los paquetes): la sesion de Claude Code se colgaria igual.',
      accion:
        'verifica que el skill-server y el Hub esten arriba y respondan desde ESTA maquina. ' +
        'Si la instalacion es lenta pero sana, subi SPECOE_VERIFY_CHECK_TIMEOUT_MS (y ' +
        'SPECOE_VERIFY_TOTAL_TIMEOUT_MS con el) y volve a correr el verificador.',
    };
  }
  return res;
}

async function main() {
  say(`${PREFIX} room: ${ROOM_DIR}`);
  say(
    `${PREFIX} deadlines: ${CHECK_DEADLINE_MS} ms por chequeo, ${TOTAL_DEADLINE_MS} ms total ` +
      '(fijos y con corte: dos corridas seguidas sin tocar nada dan el mismo veredicto).',
  );

  const fallaron = [];
  for (const check of CHECKS) {
    let res;
    try {
      res = await runCheck(check);
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
