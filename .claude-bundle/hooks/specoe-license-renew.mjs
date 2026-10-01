#!/usr/bin/env node
// specoe-license-renew.mjs — renueva el JWT de licencia de UN room, a pedido de un proceso de
// larga vida (el proxy de SPEC-0237 P3). SPEC-0237 P2, ADR-002 y ADR-003.
//
// POR QUE UN CLI APARTE: el JWT de licencia vive 1 h y hasta ahora solo lo conseguia el hook de
// SessionStart, una vez por sesion. Renovarlo a mitad de sesion exige los mismos insumos (license
// key del keyring, fingerprint, userContext, rol declarado) y el MISMO corte: sin licencia valida,
// sin gracia o con deriva de hooks no se consigue un JWT nuevo. Esa logica estaba tejida en main()
// del hook, y las tres alternativas se descartaron en el plan: que el proxy llame a validate por su
// cuenta abre un segundo criterio de JWT usable; invocar el hook entero reescribe el .mcp.json y
// emite contexto a mitad de sesion; importarlo en el proceso del proxy hereda un presupuesto
// pensado para vivir 5 s.
//
// CONTRATO (lo que el proxy puede asumir):
//   - Corre con CLAUDE_PROJECT_DIR = la carpeta del room. Una corrida corta: deadline total de
//     10 s, fetch a validate de 8 s.
//   - stdout: UNA sola linea JSON `{v:1, outcome, httpStatus?, exp?, retryAfterMs?}`. Nunca el
//     JWT: el proxy lo lee del cache del room, que es el unico lugar donde vive.
//   - exit 0 siempre. El desenlace va en `outcome`, no en el exit code.
//   - NUNCA toca el .mcp.json, nunca escribe CLAUDE_ENV_FILE, nunca emite contexto. Retirar o
//     restituir la entrada `specoe` sigue siendo decision del hook de la sesion siguiente.
//   - Con 200 escribe el cache del room (temporal + rename, la misma writeCache del hook). Con
//     cualquier otro desenlace el cache no se toca.
//
// DESENLACES:
//   OK          validate respondio 200 con token; el cache quedo con el JWT nuevo. Trae `exp`.
//   REJECTED    el Hub contesto y rechazo (403, 404, otro 4xx). La proxima, a los 10 min.
//   TRANSIENT   429, 5xx, red caida, timeout. La proxima, a los 60 s.
//   THROTTLED   el registro del room no concedio la llamada (tope de ADR-003). Sin request.
//   DRIFT       los hooks del Hub de esta maquina estan atras del room. Sin request.
//   NO_LICENSE  no hay license key para este room. Sin request.
//
// La via de escape (SPECOE_ALLOW_DEGRADED_START o el archivo del room) se respeta igual que en el
// hook: con la via activa la deriva no corta. Es el mismo criterio de JWT usable, no uno nuevo.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyCaChannel, describeNetworkError } from './ca-channel.mjs';
import { resolveUserContext } from './sdd-identity.mjs';
import {
  getLicenseKey,
  computeLocalFingerprint,
  resolveHubUrl,
  resolveTenant,
  writeCache,
  escapeHatchReason,
  checkHubHooksDrift,
  resolveDeclaredRole,
  decodeJwtExp,
  computeRoomAttribution,
  attributionHeaders,
  CALLER_PROXY,
} from './specoe-license-check.mjs';
import {
  reserveValidate,
  recordValidateOutcome,
  classifyValidateStatus,
  SOURCE_PROXY,
  VALIDATE_OK,
  VALIDATE_REJECTED,
} from './specoe-room-ledger.mjs';

export const OUTCOME_OK = 'OK';
export const OUTCOME_REJECTED = 'REJECTED';
export const OUTCOME_TRANSIENT = 'TRANSIENT';
export const OUTCOME_THROTTLED = 'THROTTLED';
export const OUTCOME_DRIFT = 'DRIFT';
export const OUTCOME_NO_LICENSE = 'NO_LICENSE';

const STARTED_AT = Date.now();
// Los dos topes de tiempo del contrato. Las env existen para que la suite ejercite el timeout sin
// esperar 8 s reales; nunca pueden estirar el fetch mas alla del deadline total.
const DEADLINE_MS = Number.parseInt(process.env.SPECOE_RENEW_DEADLINE_MS || '10000', 10);
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.SPECOE_RENEW_FETCH_TIMEOUT_MS || '8000', 10);
// Lo que tiene que quedar de presupuesto para intentar DERIVAR el userContext (un request extra a
// /auth/sdd/session, solo en instalaciones anteriores a TKT-0232). Mismo criterio que el hook.
const MIN_DERIVE_BUDGET_MS = 2500;
// Margen para escribir el cache y la salida despues del fetch.
const WRITE_MARGIN_MS = 500;

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');

const remainingMs = () => STARTED_AT + DEADLINE_MS - Date.now();

async function logLine(obj) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const file = path.join(
      LOG_DIR,
      `specoe-license-renew-${new Date().toISOString().slice(0, 10)}.log`,
    );
    await fs.appendFile(
      file,
      JSON.stringify({ ts: new Date().toISOString(), projectDir: PROJECT_DIR, ...obj }) + '\n',
    );
  } catch {
    /* no romper por log */
  }
}

/** La unica linea que sale por stdout. Solo campos del contrato v1. */
function result(outcome, { httpStatus, exp, retryAfterMs } = {}) {
  const out = { v: 1, outcome };
  if (Number.isInteger(httpStatus)) out.httpStatus = httpStatus;
  if (Number.isFinite(exp)) out.exp = exp;
  if (Number.isFinite(retryAfterMs)) out.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  return out;
}

export async function renew() {
  // 1. Deriva de los hooks del Hub: sin red, igual que el hook, y antes que nada.
  if (!(await escapeHatchReason())) {
    const deriva = await checkHubHooksDrift();
    if (deriva.checked && deriva.drifted.length > 0) {
      await logLine({
        level: 'warn',
        msg: 'renovacion cortada — hooks del Hub desactualizados en esta maquina',
        drifted: deriva.drifted.map((d) => `${d.file}: ${d.motivo}`),
      });
      return result(OUTCOME_DRIFT);
    }
  }

  // 2. Licencia de este room, con la misma resolucion por (tenant, rol) que el hook.
  const tenantSlug = await resolveTenant();
  const licenseKey = await getLicenseKey(tenantSlug);
  if (!licenseKey) {
    await logLine({ level: 'warn', msg: 'renovacion sin license key', tenantSlug });
    return result(OUTCOME_NO_LICENSE);
  }

  // 3. Reserva en el registro del room ANTES de cualquier request. Si no se concede, no sale nada
  //    a la red: ni validate ni la derivacion del userContext.
  const fingerprint = await computeLocalFingerprint();
  const room = await computeRoomAttribution({
    projectDir: PROJECT_DIR,
    machineId: fingerprint.machineId,
  });
  const reserva = await reserveValidate({
    projectDir: PROJECT_DIR,
    source: SOURCE_PROXY,
    room,
    // El lock se toma por milisegundos; 2 s alcanza para cualquier contencion real y el fetch
    // igual queda acotado por lo que reste del deadline.
    lockWaitMs: Math.max(500, Math.min(2000, remainingMs() - WRITE_MARGIN_MS)),
  });
  if (!reserva.granted) {
    await logLine({
      level: 'info',
      msg: 'renovacion no concedida por el registro del room',
      reason: reserva.reason,
      retryAfterMs: reserva.retryAfterMs,
      room,
    });
    return result(OUTCOME_THROTTLED, { retryAfterMs: reserva.retryAfterMs });
  }

  // 4. Canal de CA, URL del Hub, userContext y rol declarado: los insumos del hook.
  const ca = applyCaChannel();
  if (!ca.ok)
    await logLine({
      level: 'warn',
      msg: 'canal de CA NO aplicado',
      reason: ca.reason,
      caPath: ca.caPath,
    });
  const { url: hubUrl, source: hubUrlSource } = await resolveHubUrl();
  const userCtx = await resolveUserContext({
    hubUrl,
    timeoutMs: Math.max(500, Math.min(4000, remainingMs() - FETCH_TIMEOUT_MS)),
    allowDerive: remainingMs() - FETCH_TIMEOUT_MS >= MIN_DERIVE_BUDGET_MS,
    tenantSlug,
  });
  const declaredRole = resolveDeclaredRole();

  // 5. validate.
  const validateUrl = `${hubUrl}/license/validate`;
  let httpStatus = null;
  let body = null;
  let net = null;
  try {
    const res = await fetch(validateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...attributionHeaders({ room, caller: CALLER_PROXY }),
      },
      body: JSON.stringify({
        licenseKey,
        fingerprint,
        ...(userCtx.userId ? { userContext: userCtx.userId } : {}),
        ...(declaredRole ? { declaredRole } : {}),
      }),
      signal: AbortSignal.timeout(
        Math.max(100, Math.min(FETCH_TIMEOUT_MS, remainingMs() - WRITE_MARGIN_MS)),
      ),
    });
    httpStatus = res.status;
    // El Hub respondio: un body ilegible no es falta de respuesta, es un 200 sin token (abajo).
    if (res.ok) body = await res.json().catch(() => null);
  } catch (err) {
    net = describeNetworkError(err);
  }

  // Un 200 sin token no es un JWT nuevo: se trata como transitorio y el cache no se toca.
  let outcome = classifyValidateStatus(net ? null : httpStatus);
  if (outcome === VALIDATE_OK && typeof body?.token !== 'string') outcome = OUTCOME_TRANSIENT;
  const anotado = await recordValidateOutcome({
    projectDir: PROJECT_DIR,
    id: reserva.id,
    httpStatus: net ? null : httpStatus,
    outcome,
    source: SOURCE_PROXY,
    room,
    lockWaitMs: Math.max(0, Math.min(2000, remainingMs() - WRITE_MARGIN_MS)),
  });
  await logLine({
    level: outcome === VALIDATE_OK ? 'info' : 'warn',
    msg: 'renovacion — desenlace de validate',
    outcome,
    httpStatus: net ? null : httpStatus,
    net: net ? { code: net.code, cause: net.cause } : null,
    hubUrl,
    hubUrlSource,
    room,
    userContext: userCtx.userId ? 'presente' : 'ausente',
  });

  if (outcome !== VALIDATE_OK) {
    return result(outcome === VALIDATE_REJECTED ? OUTCOME_REJECTED : OUTCOME_TRANSIENT, {
      httpStatus: net ? undefined : httpStatus,
      retryAfterMs: anotado?.retryAfterMs,
    });
  }

  // 6. Cache del room, con la misma forma que escribe el hook.
  await writeCache({
    licenseKey,
    validatedAt: new Date().toISOString(),
    token: body.token,
    tenantId: body.tenantId,
    ...(tenantSlug ? { tenantSlug } : {}),
    tier: body.tier,
    features: body.features,
  });
  return result(OUTCOME_OK, { httpStatus, exp: decodeJwtExp(body.token) ?? undefined });
}

// Guarda de entry point: la suite importa el modulo sin correr la renovacion.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let emitted = false;
  const emit = (out) => {
    if (emitted) return;
    emitted = true;
    process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(0));
  };
  // El deadline total. Si se cumple con el trabajo en vuelo, el desenlace es transitorio: una
  // reserva sin desenlace anotado ya cuenta como transitoria en el registro.
  const watchdog = setTimeout(
    () => {
      logLine({
        level: 'warn',
        msg: 'renovacion cortada por el deadline total',
        deadlineMs: DEADLINE_MS,
      }).finally(() => emit(result(OUTCOME_TRANSIENT)));
    },
    Math.max(0, remainingMs()),
  );
  renew()
    .then((out) => {
      clearTimeout(watchdog);
      emit(out);
    })
    .catch(async (err) => {
      clearTimeout(watchdog);
      await logLine({
        level: 'error',
        msg: 'renovacion — error no manejado',
        error: err?.message,
        stack: err?.stack,
      });
      emit(result(OUTCOME_TRANSIENT));
    });
}
