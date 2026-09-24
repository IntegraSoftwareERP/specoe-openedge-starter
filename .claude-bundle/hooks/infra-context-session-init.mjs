#!/usr/bin/env node
/**
 * infra-context-session-init.mjs — TKT-0389
 *
 * Hook `SessionStart`. Sirve el INFRA_CONTEXT del tenant al arrancar la sesion: como se
 * OPERA cada proyecto (deployar, rebuildear, publicar), con los comandos exactos, donde
 * hay que parar, y que se mira despues para saber que quedo bien.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────────────
 *
 * No habia ningun lugar donde una sesion encontrara como se opera la infraestructura de un
 * proyecto. Cada vez que habia que republicar el plugin, actualizar un hook o deployar,
 * el agente buscaba en varios lados, no sabia si hacia falta reiniciar el MCP, y cuando no
 * encontraba, INVENTABA. En septiembre de 2026 se dio por deployado un cambio tres veces
 * sin que la tool apareciera, porque el proceso del MCP habia quedado viejo — y nadie lo
 * verifico, porque no habia donde estuviera escrito que hay que verificarlo.
 *
 * Servirlo a demanda no alcanzaba: quien no sabe que la fuente existe no la consulta. Por
 * eso va en el arranque, sin que nadie lo pida.
 *
 * ── Por que un hook NUEVO y no una extension de ack-task-session-init ───────────────
 *
 * TKT-0389 dejo la eleccion abierta entre (a) extender `ack-task-session-init.mjs` y
 * meterlo al manifiesto canonico en el mismo trabajo, o (b) un hook nuevo que NAZCA
 * canonico. Se eligio (b), con tres razones medidas el 2026-09-09:
 *
 *  1. `ack-task-session-init.mjs` NO vive suelto: su fuente canonica esta en
 *     `integra-hub/.claude-bundle/hooks/`, que es el CANAL B (el vendorizado del starter de
 *     SPECOE, con su propio `vendor/MANIFEST.json` y su propio job de CI). Moverlo al canal
 *     A —este directorio— no seria "sumarlo al manifiesto": seria cambiarlo de canal de
 *     distribucion, y romperle el vendorizado al dev de tenant que lo recibe por `setup.sh`.
 *     El planteo del ticket describia el hook como fuera de todo manifiesto; la medicion
 *     dice que esta en el OTRO.
 *  2. Son dos responsabilidades distintas. Una es el ack del work item de la sesion; la otra
 *     es como se opera un proyecto. Un solo hook con las dos tiene dos motivos para cambiar
 *     y dos presupuestos de timeout compitiendo por los mismos 5 segundos.
 *  3. Naciendo en `hooks/` y en el array `HOOKS` de `install.mjs`, entra al manifiesto del
 *     canal A por construccion y `hooks-audit.mjs` lo cuenta — que es la condicion de cierre
 *     del ticket, satisfecha sin trabajo extra sobre un hook ajeno.
 *
 * ── LIMITACION CONOCIDA, declarada y no tapada ──────────────────────────────────────
 *
 * Este hook necesita hablar con el Hub, y la unica autenticacion sancionada es `hubFetch`
 * de `integra-hub-auth.mjs` (SPEC-0005: keyring → env → cipher file). Ese modulo NO tiene
 * fuente canonica en NINGUN repo: existe solo como archivo instalado en `~/.claude/hooks/`
 * de la maquina del Operador. Medido el 2026-09-09 — no esta en `integra-hub/hooks/`, no
 * esta en `.claude-bundle/hooks/`, y `install.mjs` no lo copia.
 *
 * Consecuencia real: en una maquina que recibio los hooks del canal A pero no tiene ese
 * archivo, este hook no puede autenticar. Por eso el import es DINAMICO y su ausencia es
 * FAIL-OPEN SILENCIOSO — a diferencia de `ack-task-session-init`, que sale con exit 2
 * porque el ack es enforcement y sin el se pierde una garantia. Aca no hay garantia que
 * perder: no sirvo el contexto y la sesion arranca igual. Un hook informativo que impide
 * arrancar una sesion es peor que el problema que reporta.
 *
 * Traer `integra-hub-auth.mjs` a una fuente versionada es trabajo aparte y toca el canal de
 * SPEC-0005: NO entra en TKT-0389, y queda nombrado acá para que no se pierda.
 *
 * ── TKT-0453: el canal de la maquina del dev ────────────────────────────────────────
 *
 * La limitacion de arriba dejaba afuera, entera, a la maquina de un dev de tenant: recibe los
 * hooks por el starter de SPECOE (`setup.sh --host-only`) y ahi `integra-hub-auth.mjs` no
 * existe desde TKT-0190. Copiado tal cual, este hook quedaba instalado, al dia y cableado
 * —`hooks-audit` en verde— y no servia nada, en cada arranque.
 *
 * El starter si trae un canal: `hub-channel.mjs` (fuente en `.claude-bundle/hooks/`, TKT-0321),
 * el mismo que usan los dos hooks de ack-task. Por eso el canal se resuelve en este orden:
 *
 *  1. `hub-channel.mjs`. Adentro prueba el legacy (SPEC-0005) PRIMERO y despues la identidad
 *     SDD, y aplica `ca-channel.mjs` antes del primer request — que es lo que en la maquina
 *     del Operador hace el `NODE_EXTRA_CA_CERTS` de su settings.json.
 *  2. Si `hub-channel.mjs` NO ESTA, `integra-hub-auth.mjs`: la maquina que recibe los hooks
 *     por `install.mjs` y no tiene el bundle del starter. Ahi nada cambia.
 *
 * Que `hub-channel.mjs` este y no resuelva canal NO cae a `integra-hub-auth.mjs`: el canal ya
 * pregunto por el legacy con una condicion que contiene la de `hubFetch` (el modulo presente
 * Y `getCredentials()` resolviendo, que es lo que `integra-hub-auth.mjs` importa). Caer seria
 * repetir la misma pregunta con menos presupuesto.
 *
 * Con este orden el archivo es EL MISMO en los dos canales de distribucion, y el starter lo
 * vendoriza sin adaptarlo: una copia adaptada es la que se queda atras sin que nadie lo vea.
 *
 * ── Dos cosas que este hook NO hace, a proposito ────────────────────────────────────
 *
 *  - **No bloquea nunca.** Sale 0 siempre, incluso si algo revienta.
 *  - **No adivina el proyecto.** Corre en el cwd de un ROOM, no en el checkout del repo de
 *    producto: el `git remote` de ahi no dice de que proyecto se va a hablar en la sesion
 *    que recien empieza. Sirve TODO el contexto del tenant y deja elegir. Servir de mas es
 *    ruido; servir el proyecto equivocado es peor, porque parece la respuesta.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const CACHE_FILE = join(homedir(), '.claude', 'infra-context-cache.json');

/**
 * TTL del cache. 24h, igual que el `POLICY_TTL_MS` de `ack-task-session-init`: el contexto
 * de infraestructura cambia en dias o semanas, no en minutos, y una sesion que arranca sin
 * red igual tiene que recibir algo util.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Presupuesto de tiempo. El `timeout: 5` del settings.json mata el proceso a los 5000 ms;
 * se deja medio segundo de colchon para escribir el cache y emitir la salida. Mismo criterio
 * y mismo numero que el molde.
 */
const HOOK_TIMEOUT_BUDGET_MS = 4500;

/**
 * Techo de caracteres del bloque COMPLETO (con comandos). Por encima, se sirve solo el
 * INDICE y se nombra la tool con la que se lee la entrada entera.
 *
 * Por que un techo y no siempre completo: con dos o tres operaciones el cuerpo entero es lo
 * util —el agente no tiene que ir a buscar nada—, pero el contexto de arranque es un recurso
 * compartido y treinta operaciones lo desbordarian. Por que un techo y no siempre indice: un
 * indice obliga a una llamada mas ANTES de saber si hacia falta, y el modo de falla que este
 * hook ataca es justamente que nadie va a buscar lo que no sabe que existe.
 */
const FULL_BODY_BUDGET_CHARS = 6000;

/** Dias despues de los cuales una entrada se marca como posiblemente vencida. */
const STALE_AFTER_DAYS = 180;

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

async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function saveCache(entries) {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(
      CACHE_FILE,
      JSON.stringify({ fetchedAt: new Date().toISOString(), entries }, null, 2),
      { mode: 0o600 },
    );
  } catch {
    // El cache es una comodidad: no poder escribirlo no cambia lo que ya se sirvio.
  }
}

function cacheVigente(cache) {
  if (!cache || !Array.isArray(cache.entries) || !cache.fetchedAt) return false;
  const edad = Date.now() - Date.parse(cache.fetchedAt);
  return Number.isFinite(edad) && edad >= 0 && edad < CACHE_TTL_MS;
}

/**
 * Trae las entradas del Hub. Devuelve `null` —y NO `[]`— cuando no se pudo hablar con el
 * Hub: la diferencia importa, porque `[]` es un tenant sin nada cargado (estado legitimo,
 * no hay nada que servir) y `null` es "no se pudo saber" (hay que caer al cache).
 *
 * Los dos cargadores son parametro por la misma razon que antes lo era el de auth: la
 * conversacion real con el Hub no se puede medir en CI, y el seam permite medir cada rama del
 * orden de canales (ver TKT-0453 arriba) sin inventar credenciales.
 */
export async function traerDelHub(
  deadline,
  {
    cwd = process.cwd(),
    cargarCanal = () => import('./hub-channel.mjs'),
    cargarAuth = () => import('./integra-hub-auth.mjs'),
  } = {},
) {
  // El deadline se mira ANTES de cargar cualquier modulo: el import dinamico tiene costo
  // (resuelve del disco y evalua el modulo) y gastarlo cuando ya no queda ventana para la
  // request es tiempo restado al resto del arranque, a cambio de nada.
  if (deadline - Date.now() <= 0) return null;

  // Un solo abort para todo lo que toca la red: con identidad SDD, resolver el canal YA es
  // un request (POST /auth/sdd/session) y tiene que entrar en la misma ventana que el GET.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), deadline - Date.now());
  try {
    const pedir = await resolverFetch({ cwd, cargarCanal, cargarAuth, signal: controller.signal });
    if (!pedir) return null;

    // Se recalcula: resolver el canal pudo consumir la ventana entera.
    if (deadline - Date.now() <= 0) return null;

    const res = await pedir('/infra-context', { signal: controller.signal });
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Devuelve la funcion con la que se le habla al Hub (path relativo + init, la forma de
 * `hubFetch`), o `null` si no hay canal. El orden y por que esta en el encabezado (TKT-0453).
 *
 * "No esta" es: el import falla, o el modulo no exporta `resolveHubChannel`. Un
 * `hub-channel.mjs` sin esa funcion no es un canal, es una instalacion a medias, y caer al
 * modulo del Operador no cuesta nada.
 */
async function resolverFetch({ cwd, cargarCanal, cargarAuth, signal }) {
  let canal = null;
  try {
    canal = await cargarCanal();
  } catch {
    canal = null;
  }

  if (canal && typeof canal.resolveHubChannel === 'function') {
    const resuelto = await canal.resolveHubChannel({ cwd, signal });
    return resuelto && resuelto.ok && typeof resuelto.fetch === 'function' ? resuelto.fetch : null;
  }

  try {
    const auth = await cargarAuth();
    return auth && typeof auth.hubFetch === 'function' ? auth.hubFetch : null;
  } catch {
    // Ver "LIMITACION CONOCIDA" arriba: sin ningun canal no hay contexto, y eso NO rompe el
    // arranque.
    return null;
  }
}

/** Dias enteros desde una fecha ISO, o `null` si no se puede leer. */
export function diasDesde(iso, ahora = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((ahora - t) / (24 * 60 * 60 * 1000));
}

/** `2026-09-09T00:00:00.000Z` → `2026-09-09`. Sin la hora, que no aporta nada acá. */
function soloFecha(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : String(iso ?? '');
}

/**
 * Una linea de indice por entrada. Es lo minimo que hace que el agente SEPA que la
 * operacion esta escrita — que es la mitad del problema que el ticket describe.
 */
function lineaIndice(e, ahora) {
  const dias = diasDesde(e.ultimaVerificacion, ahora);
  const vencida = dias !== null && dias > STALE_AFTER_DAYS ? ' ⚠️ SIN VERIFICAR HACE MESES' : '';
  return `- \`${e.operacion}\` (${e.projectName}) — ${e.queHace} · verificada ${soloFecha(e.ultimaVerificacion)}${vencida}`;
}

/** El cuerpo completo de una entrada, con los campos que no son decorativos. */
function bloqueCompleto(e, ahora) {
  const dias = diasDesde(e.ultimaVerificacion, ahora);
  const vencida =
    dias !== null && dias > STALE_AFTER_DAYS
      ? `\n⚠️ SIN VERIFICAR HACE ${dias} DIAS — puede haber dejado de funcionar. Verificar antes de correr a ciegas.`
      : '';
  const partes = [
    `### \`${e.operacion}\` — ${e.projectName}`,
    `${e.queHace}`,
    `**Cuando:** ${e.cuandoUsarlo}`,
    `**Comandos:**\n\`\`\`\n${e.comandos}\n\`\`\``,
  ];
  if (e.decision) partes.push(`**PARAR si:** ${e.decision}`);
  partes.push(`**Verificar despues:** ${e.verificarDespues}`);
  if (e.noIncluye) partes.push(`**NO incluye:** ${e.noIncluye}`);
  partes.push(`**Ultima verificacion:** ${soloFecha(e.ultimaVerificacion)}${vencida}`);
  return partes.join('\n');
}

/**
 * Arma el bloque que se le entrega a la sesion. Completo si entra en el presupuesto; si no,
 * indice + como leer la entrada entera.
 *
 * Exportada para el test: es la unica parte con decisiones propias y se mide sin red.
 */
export function construirContexto(entries, ahora = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const encabezado =
    '## INFRA_CONTEXT — como se opera la infraestructura de estos proyectos\n\n' +
    'Estas operaciones YA estan escritas con sus comandos exactos. Si vas a deployar, ' +
    'rebuildear o publicar algo que este en esta lista, **usa lo que dice acá en vez de ' +
    'improvisar una secuencia**. Prestá atención a `Verificar despues`: un comando que ' +
    'devuelve 0 no prueba que el artefacto haya cambiado.';

  const completo = `${encabezado}\n\n${entries.map((e) => bloqueCompleto(e, ahora)).join('\n\n')}`;
  if (completo.length <= FULL_BODY_BUDGET_CHARS) return completo;

  return (
    `${encabezado}\n\n` +
    `${entries.map((e) => lineaIndice(e, ahora)).join('\n')}\n\n` +
    `_(${entries.length} operaciones; el detalle no entra en el arranque. Leé la que ` +
    'necesites con `infra_context_get(operacion: "<la-que-sea>")` — trae comandos, punto ' +
    'de parada, qué verificar después y qué NO hace.)_'
  );
}

async function main() {
  const deadline = Date.now() + HOOK_TIMEOUT_BUDGET_MS;

  let stdinJson;
  try {
    const raw = await readStdin();
    stdinJson = raw ? JSON.parse(raw) : {};
  } catch {
    // Entrada corrupta de Claude Code no es culpa del usuario: fail-open silencioso.
    process.exit(0);
  }

  const source = stdinJson.source || 'startup';
  // `resume` y `compact` continuan una sesion que ya recibio esto: repetirlo es ruido.
  // `clear` SI lo vuelve a servir — el contexto se limpio y hay que reponerlo.
  if (source === 'resume' || source === 'compact') process.exit(0);

  const cache = await loadCache();
  let entries = null;

  if (source !== 'clear' && cacheVigente(cache)) {
    entries = cache.entries;
  } else {
    // El cwd del stdin y no el del proceso: `hub-channel.mjs` lee la URL del Hub del
    // `project.config.yaml` del room, igual que `ack-task-session-init`.
    entries = await traerDelHub(deadline, { cwd: stdinJson.cwd || process.cwd() });
    if (entries !== null) {
      await saveCache(entries);
    } else if (cache && Array.isArray(cache.entries)) {
      // No se pudo hablar con el Hub: se sirve el cache aunque este vencido. Un contexto
      // viejo con su fecha a la vista es mas util que ninguno — y las fechas de
      // `ultimaVerificacion` viajan en el propio bloque, asi que no miente.
      entries = cache.entries;
    }
  }

  const additionalContext = construirContexto(entries);
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
      }),
    );
  }
  process.exit(0);
}

// `import.meta.main` no existe en Node 22: se compara la URL del modulo contra la del argv
// para distinguir "me corrieron" de "me importaron desde el test". Va por `pathToFileURL`
// porque en Windows un path con backslashes y letra de unidad NO produce la misma URL que
// una concatenacion a mano, y el hook quedaria sin correr en la unica plataforma donde
// tiene que correr.
const invocadoDirecto =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invocadoDirecto || process.env.INFRA_CONTEXT_HOOK_FORCE_MAIN === '1') {
  main().catch((err) => {
    // Catch-all: una excepcion no manejada NUNCA rompe el arranque de la sesion.
    try {
      process.stderr.write(`infra-context-session-init: ${String(err && err.message)}\n`);
    } catch {
      /* swallow */
    }
    process.exit(0);
  });
}
