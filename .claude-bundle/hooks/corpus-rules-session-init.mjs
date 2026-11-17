#!/usr/bin/env node
/**
 * corpus-rules-session-init.mjs — TKT-0526
 *
 * Hook `SessionStart`. Sirve, al arrancar la sesion, las REGLAS vigentes del proyecto del room:
 * el titulo y el resumen de cada una. Solo las reglas, no el resto del Corpus. El texto completo
 * se pide cuando hace falta (`get_kb_article(slug)`).
 *
 * ── Por que existe ──────────────────────────────────────────────────────────────────
 *
 * En Integra ERP trabaja mas de un dev. La migracion a React + PASOE (SPEC-0265) fijo una forma de
 * trabajar con mensajes, servicios y parametros, y el otro dev no se entero: la regla estaba en la
 * carpeta de la migracion. Una regla puede estar vigente en el Corpus y no llegarle a nadie, porque
 * quien no sabe que existe no la pide. Por eso va en el arranque, sin que nadie la pida — el mismo
 * motivo que `infra-context-session-init.mjs`.
 *
 * ── Que es una regla: lo decide el Hub, no este hook ────────────────────────────────
 *
 * Este hook NO conoce la etiqueta `regla` ni el scope: pide `GET /corpus/projects/:id/rules` y
 * muestra lo que vuelve. La definicion vive en UN solo lugar, `CorpusRetrievalService.rules` del
 * backend (hoy: documento PROJECT de ese proyecto, ACTIVE y en su ventana, con la etiqueta `regla`).
 * Si las reglas pasan a ser un ambito propio del Corpus, cambia el backend y este archivo —que vive
 * copiado en la maquina de cada dev— no se toca.
 *
 * ── El proyecto de la sesion lo declara el room ─────────────────────────────────────
 *
 * Una regla es de UN proyecto: "como se trabaja con mensajes" rige para Integra ERP y otro proyecto
 * puede resolverlo distinto. El hook corre en el cwd de un ROOM, no en el checkout del repo de
 * producto (ver el encabezado de infra-context: el `git remote` de ahi no dice de que proyecto se va
 * a hablar). Por eso el proyecto lo DECLARA el room, en el mismo archivo y con la misma precedencia
 * que su identidad Hub (TKT-0498):
 *
 *     # project.config.local.yaml (o project.config.yaml si el local no declara la clave)
 *     hub:
 *       project-id: <cuid del Project del Hub>
 *
 * Un room que no lo declara no recibe reglas, en silencio: no se sabe de que proyecto es, y servir
 * las de otro es el defecto.
 *
 * ── Red primero, cache solo si el Hub no contesta ───────────────────────────────────
 *
 * Al reves que infra-context (cache de 24h primero): una regla nueva tiene que llegarle al dev en el
 * PROXIMO arranque, no al dia siguiente. El cache es por tenant + proyecto y solo se sirve si el Hub
 * no responde, con su fecha a la vista. Un 404 (el proyecto no existe en el tenant del room) no cae
 * al cache: es una declaracion rota, no un Hub caido.
 *
 * ── Lo que este hook NO hace, a proposito ───────────────────────────────────────────
 *
 *  - **No bloquea nunca.** Sale 0 siempre, incluso si algo revienta. Un hook informativo que impide
 *    arrancar una sesion es peor que el problema que reporta.
 *  - **No habla con otra identidad que la del room.** El unico canal es `hub-channel.mjs` (TKT-0498).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const CACHE_FILE = join(homedir(), '.claude', 'corpus-rules-cache.json');

/** Mismo presupuesto que infra-context: `timeout: 5` en el settings.json, medio segundo de colchon. */
const HOOK_TIMEOUT_BUDGET_MS = 4500;

/**
 * Techo del bloque con titulo + resumen. Por encima se sirve solo el indice de titulos, con el slug
 * para leer cada una: que el agente SEPA que la regla existe es la mitad del problema.
 */
const FULL_BODY_BUDGET_CHARS = 6000;

/** Un resumen es un resumen: si alguien pego el texto entero ahi, se corta. */
const SUMMARY_MAX_CHARS = 400;

/** Una pagina. Mas de 100 reglas vigentes en un proyecto no es un caso que este hook tenga que cubrir entero. */
const PAGE_LIMIT = 100;

/** El Project del Hub es un cuid: lo mismo que exige el CuidPipe de la ruta, chequeado antes de gastar un request. */
const CUID_RE = /^c[a-z0-9]{20,31}$/;

const ROOM_SHARED_CONFIG = 'project.config.yaml';

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    // Red de seguridad: si stdin nunca cierra, no colgamos el arranque.
    setTimeout(() => resolve(data), 1000);
  });
}

const cargarCanalPorDefecto = () => import('./hub-channel.mjs');

/**
 * La identidad Hub que declara el room, SIN red (`resolveRoomIdentity` de hub-channel.mjs). `null`
 * si el canal no esta o el room no declara identidad con URL: en ese caso no se sirve nada.
 */
export async function identidadDelRoom(cwd, { cargarCanal = cargarCanalPorDefecto } = {}) {
  try {
    const canal = await cargarCanal();
    if (!canal || typeof canal.resolveRoomIdentity !== 'function') return null;
    const identidad = await canal.resolveRoomIdentity({ cwd });
    return identidad && identidad.ok && identidad.cacheKey ? identidad : null;
  } catch {
    return null;
  }
}

/**
 * El proyecto que declara el room: `hub.project-id` de `project.config.local.yaml` o, si el local no
 * declara la clave, de `project.config.yaml`. Misma carpeta y misma precedencia que la identidad
 * (`roomDirOf` + `pickRoomScalar` de hub-channel.mjs): si el proyecto y la identidad se leyeran de
 * lugares distintos, un room podria pedir las reglas de un proyecto con la cuenta de otro tenant.
 *
 * Devuelve `{ projectId }`, `{ invalido: <valor> }` si la clave esta pero no es un cuid, o `null` si
 * el room no la declara (o no hay canal).
 */
export async function proyectoDelRoom(cwd, { cargarCanal = cargarCanalPorDefecto } = {}) {
  try {
    const canal = await cargarCanal();
    if (!canal || typeof canal.roomDirOf !== 'function' || typeof canal.pickRoomScalar !== 'function') return null;
    const dir = canal.roomDirOf(cwd);
    if (!dir) return null;
    const leer = async (nombre) => {
      try {
        return await readFile(join(dir, nombre), 'utf8');
      } catch {
        return undefined;
      }
    };
    const local = await leer(canal.ROOM_LOCAL_CONFIG || 'project.config.local.yaml');
    const shared = await leer(ROOM_SHARED_CONFIG);
    const pick = canal.pickRoomScalar(local, shared, 'hub', 'project-id');
    const valor = typeof pick?.value === 'string' ? pick.value.trim() : '';
    if (!valor) return null;
    return CUID_RE.test(valor) ? { projectId: valor } : { invalido: valor };
  } catch {
    return null;
  }
}

/**
 * Trae las reglas del Hub. Devuelve:
 *   - el resultado de la ruta (`{ project, data, total, ... }`) si contesto bien;
 *   - `{ notFound: true }` si el proyecto no existe en el tenant del room (404 con
 *     `CORPUS_PROJECT_NOT_FOUND`): declaracion rota;
 *   - `null` si no se pudo hablar con el Hub, o si el Hub no tiene la ruta (hay que caer al cache).
 *
 * El cargador del canal es parametro por lo mismo que en infra-context: la conversacion real con el
 * Hub no se mide en CI y el seam deja medir cada rama sin inventar credenciales.
 */
export async function traerDelHub(deadline, projectId, { cwd = process.cwd(), cargarCanal = cargarCanalPorDefecto } = {}) {
  // El deadline se mira ANTES de cargar cualquier modulo: el import dinamico tiene costo.
  if (deadline - Date.now() <= 0) return null;

  // Un solo abort para todo lo que toca la red: con identidad SDD, resolver el canal YA es un request.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), deadline - Date.now());
  try {
    let canal;
    try {
      canal = await cargarCanal();
    } catch {
      return null;
    }
    if (!canal || typeof canal.resolveHubChannel !== 'function') return null;
    const resuelto = await canal.resolveHubChannel({ cwd, signal: controller.signal });
    if (!resuelto || !resuelto.ok || typeof resuelto.fetch !== 'function') return null;

    // Se recalcula: resolver el canal pudo consumir la ventana entera.
    if (deadline - Date.now() <= 0) return null;

    const res = await resuelto.fetch(
      `/corpus/projects/${encodeURIComponent(projectId)}/rules?limit=${PAGE_LIMIT}`,
      { signal: controller.signal },
    );
    if (res && res.status === 404) {
      // Dos 404 distintos: el proyecto no existe en el tenant del room (declaracion rota, con su
      // `code`), o un Hub que todavia no tiene la ruta (no se pudo saber: igual que un 500).
      const cuerpo = await res.json().catch(() => null);
      return cuerpo && cuerpo.code === 'CORPUS_PROJECT_NOT_FOUND' ? { notFound: true } : null;
    }
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && Array.isArray(data.data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ----- cache: { entradas: { "<cacheKey>|<projectId>": { fetchedAt, result } } } -----

export function claveDeCache(identidad, projectId) {
  return `${identidad.cacheKey}|${projectId}`;
}

async function loadCache() {
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    return raw && typeof raw.entradas === 'object' && raw.entradas ? raw : { entradas: {} };
  } catch {
    return { entradas: {} };
  }
}

async function saveCache(cache, clave, result) {
  try {
    const next = { entradas: { ...(cache && cache.entradas) } };
    next.entradas[clave] = { fetchedAt: new Date().toISOString(), result };
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    // El cache es una comodidad: no poder escribirlo no cambia lo que ya se sirvio.
  }
}

// ----- el bloque que recibe la sesion -----

function una(texto) {
  return String(texto ?? '').replace(/\s+/g, ' ').trim();
}

function resumenCorto(summary) {
  const s = una(summary);
  if (!s) return '_(sin resumen: leé el texto completo)_';
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS - 1)}…` : s;
}

const comoLeer = (slug) => `\`get_kb_article(slug: "${slug}")\``;

function lineaCompleta(r) {
  const partes = [`- **${una(r.title)}** — ${resumenCorto(r.summary)}`];
  if (Array.isArray(r.derivedFrom) && r.derivedFrom.length > 0) {
    partes.push(`  Se desprende de: ${r.derivedFrom.map((d) => una(d.title)).join(' · ')}.`);
  }
  partes.push(`  Texto completo: ${comoLeer(r.slug)}`);
  return partes.join('\n');
}

const lineaIndice = (r) => `- **${una(r.title)}** — ${comoLeer(r.slug)}`;

/**
 * Arma el bloque que se le entrega a la sesion: titulo + resumen de cada regla si entra en el
 * presupuesto; si no, el indice de titulos con como leer cada una. `null` si no hay reglas: un
 * proyecto sin reglas no es un error y no se anuncia.
 *
 * `desdeCache` (fecha ISO) marca que el Hub no contesto y lo servido es el ultimo cache.
 *
 * Exportada para el test: es la unica parte con decisiones propias y se mide sin red.
 */
export function construirContexto(result, { desdeCache = null } = {}) {
  const reglas = result && Array.isArray(result.data) ? result.data : [];
  if (reglas.length === 0) return null;

  const proyecto = una(result.project && result.project.name) || 'de este room';
  const encabezado =
    `## Reglas vigentes del proyecto ${proyecto}\n\n` +
    `Estas reglas RIGEN para el proyecto ${proyecto}: aplicalas en todo lo que hagas acá, aunque ` +
    'nadie te las mencione. Salen del Corpus del Hub. Acá va el título y el resumen de cada una; ' +
    '**antes de tocar algo que una regla cubre, leé su texto completo** con la tool que se indica.';

  const notas = [];
  if (desdeCache) {
    notas.push(`_(El Hub no respondió: estas son las reglas del ${String(desdeCache).slice(0, 10)}, la última vez que se pudieron leer.)_`);
  }
  if (typeof result.total === 'number' && result.total > reglas.length) {
    notas.push(`_(Se muestran ${reglas.length} de ${result.total} reglas vigentes.)_`);
  }
  const pie = notas.length > 0 ? `\n\n${notas.join('\n')}` : '';

  const completo = `${encabezado}\n\n${reglas.map(lineaCompleta).join('\n')}${pie}`;
  if (completo.length <= FULL_BODY_BUDGET_CHARS) return completo;

  return (
    `${encabezado}\n\n${reglas.map(lineaIndice).join('\n')}\n\n` +
    `_(${reglas.length} reglas; los resúmenes no entran en el arranque.)_${pie}`
  );
}

async function main() {
  const deadline = Date.now() + HOOK_TIMEOUT_BUDGET_MS;

  let stdinJson;
  try {
    const raw = await readStdin();
    stdinJson = raw ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }

  const source = stdinJson.source || 'startup';
  // `resume` y `compact` continuan una sesion que ya recibio esto. `clear` SI lo vuelve a servir.
  if (source === 'resume' || source === 'compact') process.exit(0);

  const cwd = stdinJson.cwd || process.cwd();

  // Un solo import del canal para todo el arranque.
  let canal = null;
  try {
    canal = await cargarCanalPorDefecto();
  } catch {
    process.exit(0);
  }
  const cargarCanal = async () => canal;

  // Sin identidad del room no se sirve nada, ni el cache: no se sabe de que tenant es (TKT-0498).
  const identidad = await identidadDelRoom(cwd, { cargarCanal });
  if (!identidad) process.exit(0);

  const proyecto = await proyectoDelRoom(cwd, { cargarCanal });
  if (!proyecto) process.exit(0);
  if (proyecto.invalido !== undefined) {
    process.stderr.write(
      `corpus-rules-session-init: hub.project-id del room ("${proyecto.invalido}") no es un id de Project del Hub; no se cargan reglas.\n`,
    );
    process.exit(0);
  }

  const clave = claveDeCache(identidad, proyecto.projectId);
  const cache = await loadCache();
  let result = await traerDelHub(deadline, proyecto.projectId, { cwd, cargarCanal });
  let desdeCache = null;

  if (result && result.notFound) {
    process.stderr.write(
      `corpus-rules-session-init: el Project ${proyecto.projectId} que declara el room no existe en su tenant; no se cargan reglas.\n`,
    );
    process.exit(0);
  }

  if (result) {
    await saveCache(cache, clave, result);
  } else {
    const guardado = cache.entradas[clave];
    if (guardado && guardado.result) {
      result = guardado.result;
      desdeCache = guardado.fetchedAt || 'fecha desconocida';
    }
  }

  const additionalContext = construirContexto(result, { desdeCache });
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
    );
  }
  process.exit(0);
}

// Mismo criterio que infra-context: `import.meta.main` no existe en Node 22, y en Windows la URL se
// arma con `pathToFileURL` o el hook no corre en la unica plataforma donde tiene que correr.
const invocadoDirecto = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invocadoDirecto || process.env.CORPUS_RULES_HOOK_FORCE_MAIN === '1') {
  main().catch((err) => {
    try {
      process.stderr.write(`corpus-rules-session-init: ${String(err && err.message)}\n`);
    } catch {
      /* swallow */
    }
    process.exit(0);
  });
}
