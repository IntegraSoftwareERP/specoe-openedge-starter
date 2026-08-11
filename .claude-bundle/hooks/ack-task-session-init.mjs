#!/usr/bin/env node
// SPEC-0080 S6 Sprint B — SessionStart hook ack-task-session-init.
//
// Contracts canonical:
// - IC-01 SessionStart stdin: session_id, cwd, hook_event_name, source, model, ...
// - IC-02 stdout/JSON output: SessionStart additionalContext supported.
// - IC-06 hubFetch direct (NO MCP — "not connected" expected first run per docs L408).
// - IC-09 SessionStart fires once per session before per-turn loop.
// - IC-11 error handling fail-open for telemetry, fail-closed for enforcement integrity.
//
// Behavior per stdin `source` field (IC-01):
//   "startup"  → check Hub pending tasks + display prompt via additionalContext.
//   "resume"   → silent (session already in progress).
//   "clear"    → reset state + re-check Hub.
//   "compact"  → silent (preserve state).
//
// Sprint B/C boundary (IC-05 Sprint B/C): Hub endpoints `/tasks/pending`,
// `/task-ack-session/active`, `/tenants/me/policy`, `/telemetry/event` are
// Sprint C scope. While Sprint C NO LIVE, 404 responses → fail-open silent
// (NO block functional path on infrastructure-not-ready).

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// F-PR-1 Adversarial Round 6 fix: dynamic import + fail-closed visible cuando falta la
// dependencia. NO fail-open silencioso.
//
// TKT-0321 — la dependencia pasa a ser `hub-channel.mjs`. Antes era `integra-hub-auth.mjs`
// directo, que en la maquina de un dev de tenant NO existe (lo saco del bundle del starter el
// commit 9e5d2f9, TKT-0190) y, cuando existe como residuo de un starter viejo, no tiene
// credenciales que resolver. El canal prueba legacy y despues SDD, y distingue "no hay identidad"
// de "el Hub no responde" — que es lo que este hook confundia.
let resolveHubChannel;
let resolveHubUrl;
let noChannelMessage;
try {
  const mod = await import('./hub-channel.mjs');
  resolveHubChannel = mod.resolveHubChannel;
  resolveHubUrl = mod.resolveHubUrl;
  noChannelMessage = mod.noChannelMessage;
  if (typeof resolveHubChannel !== 'function' || typeof noChannelMessage !== 'function') {
    process.stderr.write(
      'ack-task-session-init: hub-channel.mjs no exporta resolveHubChannel/noChannelMessage — la instalacion del bundle quedo a medias. Corre ./specoe-setup-host.sh. Blocking until resolved.\n',
    );
    process.exit(2);
  }
} catch {
  process.stderr.write(
    'ack-task-session-init: falta hub-channel.mjs en ~/.claude/hooks/ — la instalacion del bundle quedo a medias. Corre ./specoe-setup-host.sh. Blocking until resolved.\n',
  );
  process.exit(2);
}

// Resuelto UNA vez en main(), antes del primer request.
let channel = null;

const CACHE_FILE = path.join(os.homedir(), '.claude', 'ack-task-cache.json');
const POLICY_TTL_MS = 24 * 60 * 60 * 1000; // 24h grace window per IC-03 contract
const HOOK_TIMEOUT_BUDGET_MS = 4500; // settings.json timeout: 5 — leave 500ms slack
// TKT-0290 — colchon reservado al GET del fallback. El camino con identidad
// (POST de derivacion + GET con sesion) corre contra deadline − reserva: aunque
// lo consuma entero, el fallback arranca con esta ventana y el listado sale
// igual. La reserva se RESTA del techo y no se suma: un presupuesto aditivo
// para el fallback podia pisar los 5000 ms del timeout de settings.json y
// Claude Code mataria el hook — arranque sin listado por el otro camino.
const FALLBACK_RESERVE_MS = 1000;

// SPEC-0166 P4b — convencion del keyring de la identidad SDD modo USER. La fija
// el cliente MCP (mcp-server/src/sdd-identity.ts:30-32) y aca se replica, no se
// inventa: el material lo provisiona el login del starter, no este hook.
const SDD_IDENTITY_SERVICE = 'integra-sdd-identity';
const SDD_IDENTITY_TOKEN_NAME = 'user-token';
const SDD_IDENTITY_MACHINE_NAME = 'machine-id';

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    setTimeout(() => resolve(data), 1000); // safety timeout if stdin hangs
  });
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { policy: null, activeSession: null };
  }
}

async function saveCache(cache) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

// Wraps hubFetch with a deadline + classifies result.
//   { ok: true, data }       — 200 OK
//   { ok: false, kind: 'sprint-c-not-live' } — 404 (graceful)
//   { ok: false, kind: 'auth' }       — 401/403
//   { ok: false, kind: 'server' }     — 5xx
//   { ok: false, kind: 'network' }    — fetch threw
//   { ok: false, kind: 'timeout' }    — deadline exceeded
//
// SPEC-0166 P4: `init` es opcional y se reenvia tal cual a hubFetch (headers
// incluidos). Sin `init` el comportamiento es identico al previo. safeHubFetch
// es el wrapper LOCAL de este hook: extenderlo NO es tocar hubFetch, que es el
// modulo compartido por ack-task-enforcer, telemetry-session y los demas.
//
// SPEC-0166 P4b: la clasificacion se extrae a `runWithDeadline` para que el
// camino de identidad SDD —que sale por fetch directo, fuera de hubFetch— la
// reuse tal cual. safeHubFetch conserva su firma y su comportamiento EXACTO:
// /tenants/me/policy, /task-ack-session/active y /telemetry/event no cambian.
async function runWithDeadline(deadline, run) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, kind: 'timeout' };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), remaining);
    let res;
    try {
      res = await run(controller.signal);
    } finally {
      clearTimeout(t);
    }
    if (res.status === 404) return { ok: false, kind: 'sprint-c-not-live' };
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth' };
    if (res.status >= 500) return { ok: false, kind: 'server' };
    if (!res.ok) return { ok: false, kind: 'http-' + res.status };
    const data = await res.json().catch(() => null);
    return { ok: true, data };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'network', message: String(err && err.message) };
  }
}

async function safeHubFetch(url, deadline, init) {
  return runWithDeadline(deadline, (signal) =>
    channel.fetch(url, { ...(init || {}), signal }),
  );
}

// POST helper variant (graceful, never throws).
async function postTelemetryEvent(payload, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), remaining);
    let res;
    try {
      res = await channel.fetch('/telemetry/event', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (res.status === 404) {
      // Sprint C endpoint NO LIVE yet — fallback local JSONL.
      await appendLocalTelemetryLog(payload);
      return;
    }
    // 200/2xx silent; non-2xx silent (Sprint B telemetry should not block path).
  } catch {
    // Network/abort error: try local fallback, ignore failures.
    try {
      await appendLocalTelemetryLog(payload);
    } catch {
      /* swallow */
    }
  }
}

async function appendLocalTelemetryLog(payload) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(os.homedir(), '.claude', 'logs', `ack-task-${day}.log`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify({ ...payload, ts: new Date().toISOString() }) + '\n');
}

async function refreshPolicy(deadline) {
  // GET /api/v1/tenants/me/policy → { ackTaskMode: "HARD_BLOCK" | "WARNING" }
  const result = await safeHubFetch('/tenants/me/policy', deadline);
  if (!result.ok) return null;
  const mode = result.data && result.data.ackTaskMode;
  if (mode !== 'HARD_BLOCK' && mode !== 'WARNING') return null;
  return {
    ackTaskMode: mode,
    validatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + POLICY_TTL_MS).toISOString(),
  };
}

async function fetchActiveSession(sessionId, deadline) {
  if (!sessionId) return { state: 'unknown' };
  const url = `/task-ack-session/active?sessionId=${encodeURIComponent(sessionId)}`;
  const result = await safeHubFetch(url, deadline);
  if (result.ok) {
    return { state: 'fetched', row: result.data || null };
  }
  if (result.kind === 'sprint-c-not-live') {
    return { state: 'sprint-c-not-live' };
  }
  return { state: 'error', kind: result.kind };
}

// SPEC-0166 P4b — serial del disco fijo, best-effort per plataforma con timeout
// de 3000 ms y cadena vacia ante cualquier fallo. Replica getDiskSerial
// (mcp-server/src/sdd-identity.ts:72-125): el fingerprint del enrolamiento y el
// de la derivacion tienen que salir de la MISMA fuente o el hash no coincide.
async function getDiskSerial() {
  try {
    if (process.platform === 'win32') {
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
      const blocks = await fs.readdir('/sys/block');
      for (const name of blocks) {
        if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('sr')) continue;
        try {
          const s = (await fs.readFile(`/sys/block/${name}/device/serial`, 'utf8')).trim();
          if (s) return s;
        } catch {
          /* siguiente block device */
        }
      }
      return '';
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(
        'ioreg',
        ['-rd1', '-c', 'IOAHCIBlockStorageDevice'],
        { timeout: 3000 },
      );
      const match =
        stdout.match(/"IOPropertyMatch".*?"Serial Number"\s*=\s*"([^"]+)"/s) ??
        stdout.match(/"Serial Number"\s*=\s*"([^"]+)"/);
      return match ? match[1].trim() : '';
    }
    return '';
  } catch {
    return '';
  }
}

// Los CUATRO campos exactos que consume el backend, con la misma derivacion que
// collectSddFingerprint (mcp-server/src/sdd-identity.ts:131-141) y hashDiskSerial
// (:61-65). El backend hashea campo por campo y despues la concatenacion con '|'
// (backend/src/modules/sdd-auth/sdd-machine-fingerprint.ts:40-43), asi que UN
// solo campo distinto cambia el hash entero y el Hub responde
// MACHINE_FINGERPRINT_MISMATCH. Se manda el HASH del serial, nunca el serial.
async function collectSddFingerprint() {
  const diskSerial = await getDiskSerial();
  return {
    hostname: os.hostname(),
    os: process.platform,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    diskSerialHash: createHash('sha256')
      .update((diskSerial ?? '').trim().toLowerCase(), 'utf8')
      .digest('hex'),
  };
}

// SPEC-0166 P4b — el arranque declara el rol del room por SESION SDD (modo USER
// de SPEC-0157), que es el unico canal de identidad vivo: SPEC-0157 P8 revoco
// las ActAsTenantCredential de integra-piloto el 2026-08-01 y el par act-as
// scoped que firmaba P4 responde 403. Con un JWT de sesion SDD el rol efectivo
// lo aporta el stamp de SddIdentityGuard y permission.guard.ts (:162-170) ni
// mira los headers act-as.
//
// FAIL-OPEN MITAD (1) — por AUSENCIA, resoluble antes de mandar: sin
// INTEGRA_SDD_ROLE, sin secrets.mjs, sin user-token o sin machine-id devuelve
// null y la llamada sale por safeHubFetch igual que antes de esta fase. Es una
// diferencia deliberada con el import de integra-hub-auth.mjs (:34-47), que es
// fail-CLOSED: sin auth el hook no puede hacer nada, pero un arranque que se
// bloquea por no poder declarar su rol seria peor que uno que lista de mas.
//
// NADA de esto se persiste: el UserSddToken y el machineId salen del keyring en
// cada arranque y el JWT derivado vive 15 minutos en una variable local que
// muere con el proceso. Cachearlo no ahorraria un request —llegaria vencido al
// arranque siguiente— y dejaria en disco el material con el que se deriva
// cualquier sesion del usuario.
async function resolveSddIdentity() {
  try {
    const role = process.env.INTEGRA_SDD_ROLE;
    if (!role) return null;
    // Canal seguro de SPEC-0137, mismo servicio y mismos names que el cliente MCP.
    const mod = await import('./secrets.mjs');
    if (typeof mod.getSecret !== 'function') return null;
    const token = await mod.getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_TOKEN_NAME);
    const machineId = await mod.getSecret(SDD_IDENTITY_SERVICE, SDD_IDENTITY_MACHINE_NAME);
    if (!token || !machineId) return null;
    return { role, token, machineId, fingerprint: await collectSddFingerprint() };
  } catch {
    // Canal ausente o ilegible → se llama sin identidad (fail-open mitad 1).
    return null;
  }
}

// Deriva la sesion SDD y pide los pendientes con ella. Las dos llamadas van por
// fetch DIRECTO y no por hubFetch: hubFetch arma
// `{ 'Content-Type', ...(init.headers || {}), Authorization: Bearer <token> }`
// en sus DOS ramas —la primera y la del retry por 401—, o sea su Authorization
// va despues del spread y pisa cualquiera que se le pase. Un intento de
// transportar la sesion por ahi saldria con el Bearer humano: sin sddSession,
// con SddIdentityGuard inactivo y el listado SIN filtrar, con 200 y sin error.
//
// Devuelve el mismo shape que safeHubFetch, mas `fallback: true` cuando el
// llamador tiene que caer al camino sin identidad.
async function fetchPendingAsSddSession(identity, url, deadline, cwd) {
  const { role, token, machineId, fingerprint } = identity;
  // TKT-0321 — la base salia de `credentials.mjs::getCredentials()`, que en la maquina de un dev
  // de tenant TIRA: ese modulo lee el email/password de SPEC-0005 y el login SDD del starter
  // nunca los escribe. O sea que el camino de identidad SDD moria por falta de la URL
  // justamente en la unica maquina que solo tiene identidad SDD, y caia al fallback sin decir
  // por que. Ahora la URL la resuelve el canal, con la misma precedencia que el hook de licencia
  // del starter: env > hub.api-url del room > credentials.mjs.
  const { url: hubUrl } = await resolveHubUrl(cwd);
  if (!hubUrl) return { ok: false, kind: 'no-hub-url', fallback: true };

  const derived = await runWithDeadline(deadline, (signal) =>
    fetch(`${hubUrl}/auth/sdd/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, machineId, fingerprint }),
      signal,
    }),
  );
  // PUNTO DE RECHAZO NUEVO, el que P4 no tenia: la derivacion puede fallar sola
  // —SDD_TOKEN_INVALID, SDD_TOKEN_REVOKED, MACHINE_UNKNOWN, MACHINE_REVOKED,
  // MACHINE_FINGERPRINT_MISMATCH, 422 FINGERPRINT_INCOMPLETE— y en ese momento
  // todavia NO hay ningun GET que reintentar, asi que el reintento que P4 dejo
  // escrito no alcanzaria. Cualquier derivacion que no entregue accessToken cae
  // al camino sin identidad: incluido el presupuesto agotado en el POST, donde
  // el GET tiene que salir igual para que el arranque no quede sin listado.
  // TKT-0290: eso solo es cierto porque el deadline que llega aca ya viene
  // recortado en FALLBACK_RESERVE_MS por el llamador — el fallback corre contra
  // el deadline completo y siempre le queda esa ventana.
  const accessToken = derived.ok && derived.data ? derived.data.accessToken : null;
  if (!accessToken) {
    return { ok: false, kind: derived.kind || 'no-access-token', fallback: true };
  }

  const machineHeader = `${machineId}.${Buffer.from(
    JSON.stringify(fingerprint),
    'utf8',
  ).toString('base64url')}`;
  const result = await runWithDeadline(deadline, (signal) =>
    fetch(`${hubUrl}${url}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-sdd-role': role,
        'x-sdd-machine': machineHeader,
      },
      signal,
    }),
  );
  if (result.ok) return result;
  // Rechazo del GET con identidad —MACHINE_NOT_AUTHORIZED, MACHINE_PENDING_APPROVAL,
  // SDD_ROLE_NOT_GRANTED, SEAT_INVALID, o 401 por JWT vencido—: un fallback y
  // solo ante 401/403/422. Timeout, 5xx, 404 y error de red se comportan como
  // antes de esta fase: sin reintento.
  if (result.kind === 'auth' || result.kind === 'http-422') {
    return { ...result, fallback: true };
  }
  return result;
}

async function fetchPendingTasks(cwd, deadline) {
  if (!cwd) return { state: 'unknown', tasks: [] };
  const url = `/tasks/pending?cwd=${encodeURIComponent(cwd)}`;
  // La identidad SDD va SOLO en esta llamada: ni /tenants/me/policy, ni
  // /task-ack-session/active, ni /telemetry/event la llevan.
  const identity = await resolveSddIdentity();
  // TKT-0290: el camino con identidad corre contra deadline − reserva; el
  // fallback, contra el deadline completo. Los DOS puntos de rechazo (POST de
  // derivacion y GET con sesion) quedan cubiertos porque el recorte abarca a
  // fetchPendingAsSddSession entero. Si al entrar ya queda menos que la
  // reserva, la derivacion devuelve timeout inmediato con fallback:true y el
  // GET sin identidad sale con lo que reste — degrada, no bloquea.
  let result = identity
    ? await fetchPendingAsSddSession(identity, url, deadline - FALLBACK_RESERVE_MS, cwd)
    : null;
  // FAIL-OPEN MITAD (2) — por RECHAZO, no resoluble antes de mandar: el material
  // PRESENTE puede no verificar (token revocado, equipo no re-enrolado, drift
  // del fingerprint) y eso recien se sabe con el rechazo en la mano. UN solo
  // fallback, comun a los dos puntos de rechazo: sin el, el Operador perderia el
  // listado del arranque en CADA room, en silencio, justo en la superficie que
  // O2 y O6 observan. Sin identidad el camino sano sigue siendo un unico request.
  if (!result || result.fallback) {
    result = await safeHubFetch(url, deadline);
  }
  if (result.ok) {
    return { state: 'fetched', tasks: Array.isArray(result.data) ? result.data : [] };
  }
  if (result.kind === 'sprint-c-not-live') {
    return { state: 'sprint-c-not-live', tasks: [] };
  }
  return { state: 'error', kind: result.kind, tasks: [] };
}

function buildPrompt(pendingTasks, policy) {
  const policyLine = policy
    ? `Policy: \`${policy.ackTaskMode}\` (per Tenant.ackTaskMode).`
    : 'Policy: unknown (Hub unreachable — defaulting to HARD_BLOCK safety-first).';
  if (!pendingTasks || pendingTasks.length === 0) {
    return null;
  }
  const list = pendingTasks
    .slice(0, 5)
    .map((t) => `- ${t.id || t.taskId || '<id>'}: ${t.title || t.summary || '<no title>'}`)
    .join('\n');
  const more = pendingTasks.length > 5 ? `\n(+${pendingTasks.length - 5} more)` : '';
  return [
    '🪝 SPEC-0080 S6 — Ack-task gate active for this session.',
    '',
    `Pending tasks detected for this cwd:`,
    list + more,
    '',
    'Run `/ack-task <taskId>` to acknowledge the active work item BEFORE mutations.',
    'Si el work item es un ticket standalone (TKT-XXXX), `/ack-task <ticketId>` también sirve (TKT-0233).',
    policyLine,
  ].join('\n');
}

async function main() {
  const deadline = Date.now() + HOOK_TIMEOUT_BUDGET_MS;
  let stdinJson;
  try {
    const raw = await readStdin();
    stdinJson = raw ? JSON.parse(raw) : {};
  } catch {
    // IC-11: JSON parse invalid → fail-open silent (Claude Code corrupted input ≠ user fault).
    process.exit(0);
  }

  const source = stdinJson.source || 'startup';
  const sessionId = stdinJson.session_id || null;
  const cwd = stdinJson.cwd || process.cwd();

  // Per-source switch (IC-01):
  //   resume/compact → silent (no prompt, preserve state).
  //   startup/clear  → check Hub + emit prompt si pending tasks detected.
  if (source === 'resume' || source === 'compact') {
    process.exit(0);
  }

  // TKT-0321 — el canal, antes del primer request (aplica el CA del proceso ahi adentro).
  //
  // Sin canal el arranque NO puede consultar nada, y eso se dice con el mensaje que nombra la
  // accion — no con "Hub unreachable". Se mantiene el exit 2 que tenia el camino anterior: en
  // SessionStart no bloquea la sesion, pero deja el error a la vista, que es exactamente lo que
  // corresponde cuando el gate de ack-task de esa maquina NO esta funcionando. Un arranque que
  // callara la ausencia del canal seria el "falla en silencio" que TKT-0321 vino a cerrar.
  channel = await resolveHubChannel({ cwd });
  if (!channel.ok) {
    process.stderr.write(noChannelMessage('ack-task-session-init', channel) + '\n');
    process.exit(2);
  }

  // IC-06 + IC-11: canal directo (NO MCP — "not connected" expected first run).
  // Sprint C endpoints (404) → graceful degradation (fail-open).
  let cache = await loadCache();
  if (source === 'clear') {
    cache = { policy: null, activeSession: null };
  }

  // Refresh policy if missing or expired (24h TTL grace).
  const policyExpired =
    !cache.policy ||
    !cache.policy.expiresAt ||
    new Date(cache.policy.expiresAt).getTime() <= Date.now();
  if (policyExpired) {
    const fresh = await refreshPolicy(deadline);
    if (fresh) cache.policy = fresh;
    // If refresh fails (Sprint C 404 / network / timeout): keep stale cache.
  }

  // Detect active TaskAckSession + pending tasks (best effort, graceful 404).
  const [activeResult, pendingResult] = await Promise.all([
    fetchActiveSession(sessionId, deadline),
    fetchPendingTasks(cwd, deadline),
  ]);

  if (activeResult.state === 'fetched' && activeResult.row) {
    // TKT-0233: el work item puede ser una task de fase o un ticket standalone.
    // Los dos campos viajan al cache — el enforcer acepta cualquiera de los dos.
    cache.activeSession = {
      sessionId,
      taskId: activeResult.row.taskId || null,
      ticketId: activeResult.row.ticketId || null,
      ackedAt: activeResult.row.ackedAt,
      ackMode: activeResult.row.ackMode,
    };
  } else if (activeResult.state === 'fetched' && !activeResult.row) {
    cache.activeSession = null;
  }
  // If sprint-c-not-live or error: preserve previous cache.

  try {
    await saveCache(cache);
  } catch {
    // IC-11: local cache write fail → swallow (fail-open).
  }

  // Telemetry event ACK_TASK_LOAD — graceful 404 fallback to local JSONL.
  const policyMode = (cache.policy && cache.policy.ackTaskMode) || 'HARD_BLOCK';
  postTelemetryEvent(
    {
      sessionId: sessionId || '',
      eventType: 'ACK_TASK_LOAD',
      cwd,
      exitCode: 0,
      policyMode,
      reason: `SessionStart source=${source}`,
    },
    deadline,
  ).catch(() => {});

  // Build additionalContext output (IC-09 SessionStart supports additionalContext).
  // Show prompt only if (a) NO active ack-task session AND (b) pending tasks detected.
  let additionalContext = null;
  if (!cache.activeSession && pendingResult.tasks && pendingResult.tasks.length > 0) {
    additionalContext = buildPrompt(pendingResult.tasks, cache.policy);
  } else if (
    cache.activeSession &&
    (cache.activeSession.taskId || cache.activeSession.ticketId)
  ) {
    // Mismo criterio que el enforcer: sin work item no hay sesión activa que
    // anunciar (un cache viejo sin ninguno de los dos campos no es una ack).
    const workItem = cache.activeSession.taskId
      ? `task \`${cache.activeSession.taskId}\``
      : `ticket \`${cache.activeSession.ticketId}\``;
    additionalContext =
      `🔓 Ack-task active for session: ${workItem} ` +
      `(policy=${cache.activeSession.ackMode || policyMode}).`;
  }

  if (additionalContext) {
    const out = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    };
    process.stdout.write(JSON.stringify(out));
  }
  process.exit(0);
}

main().catch((err) => {
  // IC-11 unhandled exception → fail-open silent (catch-all to never break Claude Code).
  try {
    process.stderr.write(`ack-task-session-init: ${String(err && err.message)}\n`);
  } catch {
    /* swallow */
  }
  process.exit(0);
});
