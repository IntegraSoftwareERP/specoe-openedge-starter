// specoe-room-ledger.mjs — registro por room de las llamadas a /license/validate y de las
// aperturas de /sse, y los topes que se deciden sobre el (SPEC-0237 P2, ADR-003).
//
// QUE PROBLEMA CIERRA: un proceso de larga vida (el proxy de P3) renueva el JWT y reabre /sse
// solo, sin reiniciar Claude Code. Sin topes, un JWT rechazado o un Hub caido se convierten en un
// bucle de llamadas. Y los topes NO pueden ser por proceso: cada sesion levanta su propio proxy,
// asi que con dos sesiones abiertas en el mismo room un tope por proceso se duplica. Tampoco se
// puede delegar al rate limit del skill-server (con JWT del Hub no cuenta ninguna apertura) ni al
// throttler del Hub (cuenta tambien los 429, y es un cubo compartido). El unico lugar comun a
// todas las sesiones de un room es la carpeta del room: el registro vive ahi.
//
// LOS TOPES (ADR-003):
//   - validate: a lo sumo una llamada por 60 s, contando la del hook de SessionStart. Tras un
//     rechazo (403, 404) la siguiente recien a los 10 min, asi que con rechazos seguidos toda
//     ventana de 30 min tiene 3 o menos. 429, 5xx, red caida y timeout son TRANSITORIOS: la
//     siguiente a los 60 s, sin el backoff de rechazo. Un 200 limpia todo.
//   - /sse: 12 aperturas por ventana DESLIZANTE de 60 min, contando proxy y bootstrap.
//
// COMO SE GARANTIZA ENTRE PROCESOS: toda decision se toma bajo un lock de archivo exclusivo
// (creado con O_EXCL). Chequear y anotar la reserva es UNA operacion bajo ese lock, asi que dos
// procesos que piden a la vez no pueden pasar los dos. Un lock de mas de 10 s es de un proceso
// muerto y se rompe. El lock se toma solo para leer, decidir y reescribir: NUNCA mientras dura el
// request al Hub.
//
// QUE GUARDA: una linea JSON por llamada o apertura, con lo necesario para decidir y para
// contar (O2, O12): kind, ts, source, desenlace, httpStatus y, en las aperturas, los claims del
// JWT (tenantId, sddRole, iat, exp). NUNCA el token. Las lineas de mas de 2 h se podan: ningun
// tope mira mas atras que 60 min.
//
// ESCRITURA: el archivo se reescribe entero (temporal + rename) en cada operacion. Un lector sin
// lock —el verificador, un humano con `cat`— ve siempre un archivo completo, nunca uno a medias.
// Es chico por construccion: la poda lo acota a lo que entra en 2 h.
//
// RELOJ: `now` se inyecta en cada funcion publica para que la suite simule horas en milisegundos.
// El lock usa el reloj real porque su vencimiento se mide contra el mtime del archivo, que pone
// el sistema de archivos.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LEDGER_FILE_NAME = 'specoe-room-ledger.jsonl';
export const LOCK_FILE_NAME = 'specoe-room-ledger.lock';

export const VALIDATE_MIN_INTERVAL_MS = 60 * 1000;
export const VALIDATE_REJECTED_BACKOFF_MS = 10 * 60 * 1000;
export const SSE_WINDOW_MS = 60 * 60 * 1000;
export const SSE_MAX_PER_WINDOW = 12;
export const RETENTION_MS = 2 * 60 * 60 * 1000;
export const LOCK_STALE_MS = 10 * 1000;
export const DEFAULT_LOCK_WAIT_MS = 5 * 1000;

export const KIND_VALIDATE = 'validate';
export const KIND_SSE_OPEN = 'sse_open';

export const SOURCE_HOOK = 'hook';
export const SOURCE_PROXY = 'proxy';
export const SOURCE_BOOTSTRAP = 'bootstrap';
const SOURCES = new Set([SOURCE_HOOK, SOURCE_PROXY, SOURCE_BOOTSTRAP]);

// Desenlaces de una llamada a validate. Una reserva sin desenlace todavia (el request esta en
// vuelo, o el proceso murio antes de anotarlo) se trata como TRANSITORIA: cuenta para el tope de
// 60 s y no dispara el backoff de rechazo, que es lo unico que se puede afirmar de ella.
export const VALIDATE_OK = 'OK';
export const VALIDATE_REJECTED = 'REJECTED';
export const VALIDATE_TRANSIENT = 'TRANSIENT';

const SSE_STATUS_RE = /^[a-z_]{1,24}$/;
// Forma de un JWT: tres segmentos base64url. Ningun campo del registro puede tener esa forma —
// es la ultima barrera contra un llamador que pase el token donde iba un claim.
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

/**
 * Clasifica el status HTTP de /license/validate. `null` = no hubo respuesta (red caida, TLS,
 * timeout). Lo comparten el hook y el CLI de renovacion: dos clasificaciones distintas del mismo
 * status serian dos topes distintos.
 *
 * 403 y 404 son rechazo (ADR-003 fija el 404, que el report no anclaba). 429 y 5xx, transitorios.
 * El resto de los 4xx tambien cuenta como rechazo: es un pedido que el Hub no va a aceptar por
 * repetirlo, y tratarlo como transitorio seria una llamada por minuto contra un error fijo.
 */
export function classifyValidateStatus(httpStatus) {
  if (httpStatus === null || httpStatus === undefined) return VALIDATE_TRANSIENT;
  if (httpStatus >= 200 && httpStatus < 300) return VALIDATE_OK;
  if (httpStatus === 429 || httpStatus >= 500) return VALIDATE_TRANSIENT;
  return VALIDATE_REJECTED;
}

export function ledgerPaths(projectDir) {
  const dir = path.join(projectDir, '.claude');
  return {
    dir,
    ledger: path.join(dir, LEDGER_FILE_NAME),
    lock: path.join(dir, LOCK_FILE_NAME),
  };
}

const tsMs = (entry) => Date.parse(entry?.ts);

// ----- decisiones (puras) -----

/**
 * Se puede reservar una llamada a validate en `now`? Mira solo la ultima llamada del room, de
 * cualquier source: tras un rechazo la siguiente va a los 10 min de ella; tras cualquier otra
 * cosa (OK, transitorio, en vuelo), a los 60 s. Como cada reserva concedida pasa a ser la ultima,
 * esto alcanza para que el tope valga en cualquier ventana.
 */
export function decideValidate(entries, now) {
  let last = null;
  for (const e of entries) {
    if (e?.kind !== KIND_VALIDATE || !Number.isFinite(tsMs(e))) continue;
    if (!last || tsMs(e) >= tsMs(last)) last = e;
  }
  if (!last) return { granted: true, retryAfterMs: 0, reason: null };
  const rejected = last.outcome === VALIDATE_REJECTED;
  const wait = rejected ? VALIDATE_REJECTED_BACKOFF_MS : VALIDATE_MIN_INTERVAL_MS;
  const nextAt = tsMs(last) + wait;
  if (now >= nextAt) return { granted: true, retryAfterMs: 0, reason: null };
  return {
    granted: false,
    retryAfterMs: nextAt - now,
    reason: rejected ? 'rejected-backoff' : 'interval',
  };
}

/**
 * Se puede reservar una apertura de /sse en `now`? Ventana deslizante de 60 min: una apertura
 * cuenta mientras `now - ts < 60 min`. Si ya hay 12, la espera es hasta que venza la que deja
 * lugar.
 */
export function decideSseOpen(entries, now) {
  const inWindow = entries
    .filter((e) => e?.kind === KIND_SSE_OPEN && Number.isFinite(tsMs(e)))
    .map(tsMs)
    .filter((t) => now - t < SSE_WINDOW_MS)
    .sort((a, b) => a - b);
  if (inWindow.length < SSE_MAX_PER_WINDOW) return { granted: true, retryAfterMs: 0, reason: null };
  const freesAt = inWindow[inWindow.length - SSE_MAX_PER_WINDOW] + SSE_WINDOW_MS;
  return { granted: false, retryAfterMs: Math.max(1, freesAt - now), reason: 'sse-window' };
}

/** Las entradas que siguen vivas en `now`: fuera todo lo de mas de 2 h. */
export function pruneEntries(entries, now) {
  return entries.filter((e) => Number.isFinite(tsMs(e)) && now - tsMs(e) <= RETENTION_MS);
}

// ----- archivo -----

function parseLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      /* linea rota (un editor, un disco lleno): se descarta, no se tira el registro entero */
    }
  }
  return out;
}

/** Lee el registro tal como esta, sin lock. Para observadores y para la suite. */
export async function readLedger({ projectDir }) {
  try {
    return parseLines(await fs.readFile(ledgerPaths(projectDir).ledger, 'utf8'));
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// En Windows un rename sobre un archivo que otro proceso tiene abierto puede rebotar un instante
// (antivirus, indexador). Se reintenta un rato corto antes de rendirse.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Escribe `content` en `file` con temporal + rename: un lector ve el archivo viejo o el nuevo. */
export async function writeFileAtomic(file, content, { mode } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, content, mode === undefined ? undefined : { mode });
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err?.code) || attempt >= 20) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await sleep(25);
    }
  }
}

function serialize(entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

// ----- lock -----

/**
 * Toma el lock del registro. Devuelve `release()` o null si no lo consiguio en `waitMs`.
 *
 * Un lock mas viejo que LOCK_STALE_MS es de un proceso que murio con el tomado: se rompe. Antes
 * de borrarlo se vuelve a mirar que sea el MISMO archivo que se juzgo viejo (mismo mtime), para no
 * borrar el lock recien creado por otro proceso que rompio el viejo primero. Queda una ventana
 * minima entre ese segundo stat y el borrado; solo existe cuando un proceso murio con el lock
 * tomado, y el peor caso es una reserva de mas en esa ronda.
 */
async function acquireLock(lockPath, { waitMs, staleMs = LOCK_STALE_MS }) {
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      return {
        release: async () => {
          try {
            if ((await fs.readFile(lockPath, 'utf8')) === token) await fs.unlink(lockPath);
          } catch {
            /* ya no esta, o ya no es nuestro: nada que liberar */
          }
        },
      };
    } catch (err) {
      if (err?.code === 'ENOENT') {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        continue;
      }
      // EPERM/EACCES: en Windows es el lock de otro proceso en pleno borrado. Es contencion.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(err?.code)) throw err;
    }
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        const again = await fs.stat(lockPath);
        if (again.mtimeMs === st.mtimeMs) await fs.unlink(lockPath);
        continue;
      }
    } catch {
      continue; // se libero entre el open y el stat: reintentar ya
    }
    if (Date.now() >= deadline) return null;
    await sleep(5 + Math.floor(Math.random() * 20));
  }
}

/**
 * Lee, deja que `mutate` decida sobre las entradas vivas y reescribe — todo bajo el lock.
 * `mutate` devuelve `{ entries, result }`. Si no hay lock en `lockWaitMs`, devuelve null.
 */
async function withLedger(projectDir, now, lockWaitMs, mutate) {
  const { ledger, lock } = ledgerPaths(projectDir);
  const held = await acquireLock(lock, { waitMs: lockWaitMs });
  if (!held) return null;
  try {
    let current = [];
    try {
      current = parseLines(await fs.readFile(ledger, 'utf8'));
    } catch {
      /* no existe todavia */
    }
    const { entries, result } = mutate(pruneEntries(current, now));
    await writeFileAtomic(ledger, serialize(entries));
    return result;
  } finally {
    await held.release();
  }
}

// ----- saneamiento -----

function checkSource(source) {
  if (!SOURCES.has(source)) throw new Error(`source invalido para el registro: ${source}`);
}

/** Copia solo los valores escalares que no tengan forma de JWT. */
function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) continue;
    if (typeof v === 'string' && JWT_SHAPE_RE.test(v)) continue;
    out[k] = v;
  }
  return out;
}

// ----- validate -----

/**
 * Reserva una llamada a /license/validate. Devuelve `{ granted, id, retryAfterMs, reason }`.
 *
 * `force` es para el hook de SessionStart: su llamada NO se frena (frenarla cambiaria sus
 * decisiones de retiro y de gracia), pero se anota igual para que cuente en el tope de los demas.
 * Sin lock en `lockWaitMs` no se concede nada (`reason: 'lock-busy'`), salvo con `force`, que
 * sigue sin registro (`id: null`).
 */
export async function reserveValidate({
  projectDir,
  source,
  room = null,
  now = Date.now(),
  force = false,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
}) {
  checkSource(source);
  const id = randomUUID();
  const result = await withLedger(projectDir, now, lockWaitMs, (entries) => {
    const decision = decideValidate(entries, now);
    if (!decision.granted && !force) return { entries, result: { ...decision, id: null } };
    const entry = clean({
      kind: KIND_VALIDATE,
      id,
      ts: new Date(now).toISOString(),
      source,
      room,
      outcome: null,
      httpStatus: null,
    });
    return {
      entries: [...entries, entry],
      result: { granted: true, id, retryAfterMs: 0, reason: null },
    };
  });
  if (result) return result;
  if (force) return { granted: true, id: null, retryAfterMs: 0, reason: 'lock-busy' };
  return { granted: false, id: null, retryAfterMs: LOCK_STALE_MS, reason: 'lock-busy' };
}

/**
 * Anota el desenlace de una llamada reservada. `httpStatus` null = sin respuesta. Devuelve el
 * desenlace clasificado y cuanto falta para la proxima reserva (`retryAfterMs`), o null si no
 * consiguio el lock. Si la reserva ya no esta (podada, registro borrado a mano) anota la llamada
 * completa en `now`: la llamada existio y tiene que contar.
 */
export async function recordValidateOutcome({
  projectDir,
  id,
  httpStatus = null,
  outcome = classifyValidateStatus(httpStatus),
  source = SOURCE_PROXY,
  room = null,
  now = Date.now(),
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
}) {
  return withLedger(projectDir, now, lockWaitMs, (entries) => {
    let found = false;
    const next = entries.map((e) => {
      if (e?.kind !== KIND_VALIDATE || e.id !== id || !id) return e;
      found = true;
      return { ...e, outcome, httpStatus };
    });
    if (!found) {
      checkSource(source);
      next.push(
        clean({
          kind: KIND_VALIDATE,
          id: id ?? randomUUID(),
          ts: new Date(now).toISOString(),
          source,
          room,
          outcome,
          httpStatus,
        }),
      );
    }
    const { retryAfterMs } = decideValidate(next, now);
    return { entries: next, result: { outcome, retryAfterMs } };
  });
}

// ----- /sse -----

/** Reserva una apertura de /sse. Mismo contrato que reserveValidate, sin `force`. */
export async function reserveSseOpen({
  projectDir,
  source,
  now = Date.now(),
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
}) {
  checkSource(source);
  const id = randomUUID();
  const result = await withLedger(projectDir, now, lockWaitMs, (entries) => {
    const decision = decideSseOpen(entries, now);
    if (!decision.granted) return { entries, result: { ...decision, id: null } };
    const entry = {
      kind: KIND_SSE_OPEN,
      id,
      ts: new Date(now).toISOString(),
      source,
      status: 'reserved',
    };
    return {
      entries: [...entries, entry],
      result: { granted: true, id, retryAfterMs: 0, reason: null },
    };
  });
  return result ?? { granted: false, id: null, retryAfterMs: LOCK_STALE_MS, reason: 'lock-busy' };
}

/**
 * Anota como termino una apertura reservada: `status` (open, rejected, failed...), el httpStatus
 * y los claims del JWT con el que se abrio. Nunca el token: un valor con forma de JWT se descarta.
 */
export async function recordSseOpen({
  projectDir,
  id,
  status,
  httpStatus = null,
  tenantId,
  sddRole,
  iat,
  exp,
  now = Date.now(),
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
}) {
  if (!SSE_STATUS_RE.test(String(status)))
    throw new Error(`status invalido para sse_open: ${status}`);
  const claims = clean({ status, httpStatus, tenantId, sddRole, iat, exp });
  return withLedger(projectDir, now, lockWaitMs, (entries) => {
    let found = false;
    const next = entries.map((e) => {
      if (e?.kind !== KIND_SSE_OPEN || e.id !== id || !id) return e;
      found = true;
      return { ...e, ...claims };
    });
    return { entries: next, result: { found } };
  });
}

/** Poda explicita (la hacen tambien todas las operaciones de arriba). Devuelve cuantas saco. */
export async function prune({ projectDir, now = Date.now(), lockWaitMs = DEFAULT_LOCK_WAIT_MS }) {
  const { ledger, lock } = ledgerPaths(projectDir);
  const held = await acquireLock(lock, { waitMs: lockWaitMs });
  if (!held) return null;
  try {
    let current = [];
    try {
      current = parseLines(await fs.readFile(ledger, 'utf8'));
    } catch {
      return { removed: 0 };
    }
    const kept = pruneEntries(current, now);
    await writeFileAtomic(ledger, serialize(kept));
    return { removed: current.length - kept.length };
  } finally {
    await held.release();
  }
}
