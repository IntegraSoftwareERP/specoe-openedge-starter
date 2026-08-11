#!/usr/bin/env node
// SPEC-0080 S6 Sprint B — PreToolUse hook ack-task-enforcer.
//
// Contracts canonical:
// - IC-01 PreToolUse stdin: tool_name, tool_input, tool_use_id, session_id, cwd, ...
// - IC-02 PreToolUse JSON output:
//     hookSpecificOutput.permissionDecision ∈ {allow, deny, ask, defer}
//     hookSpecificOutput.permissionDecisionReason (Claude sees on deny)
//     systemMessage (USER sees, NOT Claude — IC-02 fix MEDIUM)
//   `defer` requires Claude Code v2.1.89+ (IC-02 F-R4-2). For ack-task scope: NOT needed.
//   Deprecated top-level decision: "approve|block" — DO NOT use PreToolUse (IC-02 F-R4-3).
// - IC-08 Matcher (settings.json): "Edit|Write|Bash|NotebookEdit" — exact list, NO regex.
// - IC-10 Hook chaining precedence (raw L1286 verbatim): deny > defer > ask > allow.
//   If ack-task-enforcer emits `deny` and block-code-from-engineering-room emits `allow`,
//   docs guarantee `deny` wins canonical.
// - IC-11 Error handling table (fail-closed enforcement integrity vs fail-open advisory):
//     Network/timeout/4xx/5xx Hub errors during enforcement → exit 2 (block).
//     Sprint C 404 (endpoint NO LIVE) → fail-open silent (Sprint B/C boundary).
//     JSON parse stdin invalid → exit 0 fail-open.
//     Local cache corrupt → exit 0 fail-open + re-fetch attempt.
//     JWT refresh fail → exit 2 (block — auth roto, no audit garantizado).
//     Unhandled exception → exit 0 fail-open (catch-all never break Claude Code).
//
// Sprint B/C boundary: while Hub Sprint C endpoints NO LIVE, ALL Sprint C
// endpoint 404s degrade gracefully → fail-open. Post-Sprint C deploy, 200 responses
// activate enforcement automáticamente sin code change.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// F-PR-1 Adversarial Round 6 fix: dynamic import + fail-closed visible cuando falta la
// dependencia. NO fail-open silencioso.
//
// TKT-0321 — la dependencia ya no es `integra-hub-auth.mjs` sino `hub-channel.mjs`, que resuelve
// el canal por identidad SDD (el unico vivo en la maquina de un dev de tenant) y deja la legacy
// de SPEC-0005 como respaldo. El import sigue siendo dinamico por la misma razon de siempre: un
// import estatico de un modulo ausente falla en la RESOLUCION, antes de este catch y sin mensaje.
let resolveHubChannel;
let noChannelMessage;
try {
  const mod = await import('./hub-channel.mjs');
  resolveHubChannel = mod.resolveHubChannel;
  noChannelMessage = mod.noChannelMessage;
  if (typeof resolveHubChannel !== 'function' || typeof noChannelMessage !== 'function') {
    process.stderr.write(
      'ack-task-enforcer: hub-channel.mjs no exporta resolveHubChannel/noChannelMessage — la instalacion del bundle quedo a medias. Corre ./specoe-setup-host.sh. Blocking until resolved.\n',
    );
    process.exit(2);
  }
} catch {
  process.stderr.write(
    'ack-task-enforcer: falta hub-channel.mjs en ~/.claude/hooks/ — la instalacion del bundle quedo a medias. Corre ./specoe-setup-host.sh. Blocking until resolved.\n',
  );
  process.exit(2);
}

// El canal se resuelve UNA vez en main() (hace un POST de derivacion) y despues lo usan todos
// los `safeHubFetch` de este proceso.
let channel = null;

const CACHE_FILE = path.join(os.homedir(), '.claude', 'ack-task-cache.json');
const POLICY_TTL_MS = 24 * 60 * 60 * 1000; // 24h grace window per IC-03
const HOOK_TIMEOUT_BUDGET_MS = 4500; // settings.json timeout: 5 — leave 500ms slack
const MUTATIVE_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(data), 1000);
  });
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    // IC-11: missing/corrupt → return null shape, fall through to re-fetch.
    return { policy: null, activeSession: null };
  }
}

async function saveCache(cache) {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    /* IC-11 swallow */
  }
}

// Returns one of: { ok: true, data } | { ok: false, kind: 'sprint-c-not-live'|'auth'|'server'|'network'|'timeout'|'http-NNN' }
async function safeHubFetch(url, init, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, kind: 'timeout' };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), remaining);
    let res;
    try {
      res = await channel.fetch(url, { ...(init || {}), signal: controller.signal });
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
    return { ok: false, kind: 'network' };
  }
}

async function postTelemetryEvent(payload, deadline) {
  // Telemetry NEVER blocks functional path (IC-05 Sprint B/C boundary verbatim).
  try {
    const result = await safeHubFetch(
      '/telemetry/event',
      { method: 'POST', body: JSON.stringify(payload) },
      deadline,
    );
    if (!result.ok && result.kind === 'sprint-c-not-live') {
      await appendLocalTelemetryLog(payload);
    }
  } catch {
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
  const result = await safeHubFetch('/tenants/me/policy', null, deadline);
  if (!result.ok) return { policy: null, kind: result.kind };
  const mode = result.data && result.data.ackTaskMode;
  if (mode !== 'HARD_BLOCK' && mode !== 'WARNING') return { policy: null, kind: 'invalid-response' };
  return {
    policy: {
      ackTaskMode: mode,
      validatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + POLICY_TTL_MS).toISOString(),
    },
    kind: 'ok',
  };
}

async function fetchActiveSession(sessionId, deadline) {
  if (!sessionId) return { state: 'unknown' };
  const url = `/task-ack-session/active?sessionId=${encodeURIComponent(sessionId)}`;
  const result = await safeHubFetch(url, null, deadline);
  if (result.ok) return { state: 'fetched', row: result.data || null };
  return { state: 'error', kind: result.kind };
}

function emitDeny(reason, sessionId, cwd, toolName, filePath, policyMode, deadline) {
  postTelemetryEvent(
    {
      sessionId: sessionId || '',
      eventType: 'ACK_TASK_BLOCKED_PRETOOLUSE',
      cwd: cwd || '',
      toolName: toolName || '',
      filePath: filePath || null,
      exitCode: 0, // exit 0 + JSON deny (IC-02 modern API, not deprecated exit 2)
      policyMode,
      reason,
    },
    deadline,
  ).catch(() => {});
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: `🛑 ACK-TASK GATE: ${reason}`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function emitWarning(reason, sessionId, cwd, toolName, filePath, policyMode, deadline) {
  postTelemetryEvent(
    {
      sessionId: sessionId || '',
      eventType: 'ACK_TASK_SKIP',
      cwd: cwd || '',
      toolName: toolName || '',
      filePath: filePath || null,
      exitCode: 0,
      policyMode,
      reason,
    },
    deadline,
  ).catch(() => {});
  const out = {
    systemMessage: `⚠️  ack-task WARNING: ${reason}`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function emitBlockExit2(reason) {
  // IC-11 hard-block path for enforcement-integrity errors (network/timeout/auth/5xx).
  // exit 2 + stderr → Claude sees stderr as error message (IC-02 exit 2 semantics).
  process.stderr.write(`ack-task-enforcer: ${reason}\n`);
  process.exit(2);
}

function emitAllowSilent() {
  process.exit(0);
}

function extractFilePath(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    return toolInput.file_path || toolInput.notebook_path || null;
  }
  return null;
}

async function main() {
  const deadline = Date.now() + HOOK_TIMEOUT_BUDGET_MS;

  let stdinJson;
  try {
    const raw = await readStdin();
    stdinJson = raw ? JSON.parse(raw) : {};
  } catch {
    // IC-11: JSON parse stdin invalid → fail-open silent.
    return emitAllowSilent();
  }

  const toolName = stdinJson.tool_name || '';
  const toolInput = stdinJson.tool_input || {};
  const sessionId = stdinJson.session_id || '';
  const cwd = stdinJson.cwd || '';
  const filePath = extractFilePath(toolName, toolInput);

  // Defensive double-check matcher (settings.json should filter, but safety belt).
  if (!MUTATIVE_TOOLS.has(toolName)) {
    return emitAllowSilent();
  }

  // Load cache (IC-11: corrupt → fail-open + re-fetch).
  const cache = await loadCache();

  // Active ack-task session shortcut: if cached + sessionId match → exit 0 silent.
  // TKT-0233: el work item de la sesión es una task de fase O un ticket standalone
  // (el ack por ticket registra `ticketId` y deja `taskId` en null). Mirar solo
  // `taskId` dejaba al gate ciego a las sesiones ackeadas contra un ticket, que es
  // exactamente lo que bloqueaba a cualquiera que trabajara deuda bajo HARD_BLOCK.
  if (
    cache.activeSession &&
    cache.activeSession.sessionId === sessionId &&
    (cache.activeSession.taskId || cache.activeSession.ticketId)
  ) {
    return emitAllowSilent();
  }

  // TKT-0321 — recien ACA se necesita el Hub, y por lo tanto el canal. Resolverlo antes del
  // atajo por cache le costaria un POST de derivacion a toda sesion ya ackeada, que es el
  // camino sano y el mas frecuente.
  //
  // Si no hay canal, el bloqueo se mantiene —sin poder consultar el Hub no hay audit
  // garantizado— pero el mensaje dice la verdad. El texto viejo era "Hub unreachable /
  // timeout", que mandaba a mirar la red cuando lo que faltaba era la identidad: el dev
  // revisaba firewall y proxy mientras el gate le bloqueaba todo Edit/Write/Bash.
  channel = await resolveHubChannel({ cwd });
  if (!channel.ok) {
    process.stderr.write(noChannelMessage('ack-task-enforcer', channel) + '\n');
    process.exit(2);
  }

  // No cached active session — try Hub fetch (graceful 404 = Sprint C not LIVE).
  const activeResult = await fetchActiveSession(sessionId, deadline);
  if (
    activeResult.state === 'fetched' &&
    activeResult.row &&
    (activeResult.row.taskId || activeResult.row.ticketId)
  ) {
    // Update cache + allow.
    cache.activeSession = {
      sessionId,
      taskId: activeResult.row.taskId || null,
      ticketId: activeResult.row.ticketId || null,
      ackedAt: activeResult.row.ackedAt,
      ackMode: activeResult.row.ackMode,
    };
    await saveCache(cache);
    return emitAllowSilent();
  }
  if (activeResult.state === 'error') {
    // IC-11: Hub enforcement integrity errors during ack lookup → block.
    if (activeResult.kind === 'auth') {
      return emitBlockExit2('Hub auth failure (JWT roto). No audit guaranteed — conservative block.');
    }
    if (activeResult.kind === 'server') {
      return emitBlockExit2('Hub 5xx during active-session lookup. Conservative block.');
    }
    if (activeResult.kind === 'network' || activeResult.kind === 'timeout') {
      return emitBlockExit2('Hub unreachable / timeout during active-session lookup. Conservative block.');
    }
    if (activeResult.kind !== 'sprint-c-not-live') {
      // Unknown HTTP error → block (conservative).
      return emitBlockExit2(`Hub error (${activeResult.kind}) during active-session lookup. Conservative block.`);
    }
    // sprint-c-not-live falls through to policy path per IC-11 Sprint B/C boundary.
    // Backend retorna 404 NotFoundException cuando no hay row (semantic). El hook
    // trata 404 como "no active session" + falls through al policy check.
    // (Sync del bundle con la copia instalada — la corrección estaba solo en ~/.claude/hooks.)
  }
  // activeResult.state === 'sprint-c-not-live' OR 'unknown' OR 'fetched-null' falls through.

  // Determine policy. Refresh if expired or missing.
  let policyMode = cache.policy && cache.policy.ackTaskMode;
  const policyExpired =
    !cache.policy ||
    !cache.policy.expiresAt ||
    new Date(cache.policy.expiresAt).getTime() <= Date.now();
  if (policyExpired) {
    const refresh = await refreshPolicy(deadline);
    if (refresh.policy) {
      cache.policy = refresh.policy;
      policyMode = refresh.policy.ackTaskMode;
      await saveCache(cache);
    } else if (refresh.kind === 'sprint-c-not-live') {
      // Policy endpoint NO LIVE pre-Sprint C → fail-open silent.
      // After Sprint C deploys, this branch stops triggering.
      return emitAllowSilent();
    } else {
      // IC-11: other policy fetch errors → block per enforcement integrity.
      if (refresh.kind === 'auth') {
        return emitBlockExit2('Hub auth failure during policy fetch. Conservative block.');
      }
      if (refresh.kind === 'server') {
        return emitBlockExit2('Hub 5xx during policy fetch. Conservative block.');
      }
      if (refresh.kind === 'network' || refresh.kind === 'timeout') {
        return emitBlockExit2('Hub unreachable / timeout during policy fetch. Conservative block.');
      }
      return emitBlockExit2(`Hub error (${refresh.kind}) during policy fetch. Conservative block.`);
    }
  }

  if (!policyMode) {
    // No policy known + Sprint C endpoint NO LIVE (active session also 404) → fail-open.
    return emitAllowSilent();
  }

  // Sprint C endpoints LIVE branch: NO active ack-task session detected for sessionId.
  const reason = `No active ack-task session for sessionId=${sessionId || '<unknown>'}. Run \`/ack-task <taskId|ticketId>\` first.`;

  if (policyMode === 'HARD_BLOCK') {
    return emitDeny(reason, sessionId, cwd, toolName, filePath, policyMode, deadline);
  }
  if (policyMode === 'WARNING') {
    return emitWarning(reason, sessionId, cwd, toolName, filePath, policyMode, deadline);
  }

  // Unknown policy value (defensive) → conservative block.
  return emitBlockExit2(`Unknown policyMode "${policyMode}" — conservative block.`);
}

main().catch((err) => {
  // IC-11 unhandled exception → fail-open silent (catch-all never break Claude Code).
  try {
    process.stderr.write(`ack-task-enforcer unhandled: ${String(err && err.message)}\n`);
  } catch {
    /* swallow */
  }
  process.exit(0);
});
