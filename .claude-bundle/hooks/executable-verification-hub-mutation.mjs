#!/usr/bin/env node
/**
 * executable-verification-hub-mutation.mjs
 * SPEC-0089 S2 (SPEC-C-v3) — Hook PreToolUse executable verification LOCAL.
 *
 * Parsea tokens SPEC-B-v3 en body de mutaciones Hub. Fail-CLOSED si gaps.
 * NO valida URLs externas — pass-through a SPEC-D-v3 vía tag [verify-external].
 *
 * Skill: c:\Integra\engineering-room\.claude\skills\staff-verification-protocol\SKILL.md
 * Design canonical Hub: spec_log_decision cuid cmpmxm2pc00gat02hupxwsa4l (v1.1 APPROVED Adversarial R2)
 * Predecessor: SPEC-0089 S1 LIVE main fa9b34a (skill staff-verification-protocol)
 *
 * v1.3 (TKT-0045) — dos fixes:
 *   P1: lee el param estructurado `verification_tokens` (precedencia sobre inline;
 *       inline = fallback). Resuelve el bug de timing donde el MCP renderiza la
 *       tabla ## Verification en el content DESPUÉS del PreToolUse, dejando el
 *       body sustantivo sin tokens parseables = BLOCK espurio.
 *   P2: resuelve el repo donde corre `git show`/confirmed-by en orden
 *       INTEGRA_REPO_PATH env → ~/.claude/hooks/integra-repos.json → cwd (solo si
 *       es git work tree). Tokens presence pueden prefijar `<alias>:<path>:N-M`
 *       para citar otros repos del config. Antes corría en el cwd de sesión
 *       (ej. cc-dev-room), que no es el repo de los archivos citados.
 *
 * v1.4 (TKT-0269) — el mapper del token `external` leía `e.url`; la tool MCP emite
 *       `e.src` (`externalTokenSchema`, `{claim, src, quote}` con `.strict()`). El
 *       token mapeaba a null SIEMPRE, la lista quedaba vacía y el hook bloqueaba con
 *       "requires tokens": el tipo `external` era inutilizable desde cualquier room,
 *       para cualquier SPEC. Cubierto por `hooks/test/verification-token-mapping.test.mjs`,
 *       que cruza los nombres de campo contra el schema de la tool — los otros cuatro
 *       tipos (presence/absence/operator_decision/gate_required) ya coincidían.
 *
 * v1.5 (TKT-0312) — tipo NUEVO `absence-at`: una afirmación de ausencia ANCLADA A UN
 *       COMMIT. Cierra el defecto de modelo que TKT-0283 describió y TKT-0312 decidió.
 *
 *       El síntoma: el token `absence` del `content` de una fase deja de ser cierto
 *       cuando mergea el PR de esa misma fase. La afirmación NUNCA fue falsa —cuando se
 *       escribió, la fase todavía no había construido nada—; lo que falla es CUÁNDO se
 *       la evalúa, porque `absence` re-corre su `confirmed-by` contra el árbol de la
 *       LECTURA. Una afirmación verdadera y respaldada empieza a leerse como falsa por
 *       el solo hecho de que el trabajo que describía se hizo. Medido en SPEC-0181:
 *       tres ocurrencias consecutivas (P5, P6, P7).
 *
 *       La decisión del Operador (2026-08-10) descartó las salidas de convivencia:
 *       «la afirmación era cierta!!! ¿cómo vas a reescribir después?? es una pelotudez».
 *       O sea que la solución NO puede ser un paso de proceso que obligue a reescribir
 *       el `content` — eso pierde el enunciado original, que es el que da sentido al
 *       contrato ("esto no existe y lo voy a construir" pasa a decir "esto ya existe").
 *
 *       El anclaje: `[absence-at: <path>] [as-of: <rev>]` afirma que `<path>` NO existía
 *       en el árbol de `<rev>`. Se verifica con `git cat-file -e <rev>:<path>`.
 *
 *       Por qué un commit y no una fecha declarada por el agente: el ticket pide anclar
 *       al dato que escribe el SISTEMA, no al que declara quien afirma. Un `as-of` con
 *       fecha libre sería exactamente el token que aprueba cualquier cosa que el ticket
 *       teme — "esto todavía no existe" sin nada que lo falsee. Un commit es inmutable,
 *       es compartido (no un registro local de una máquina) y hace que la afirmación
 *       siga siendo FALSABLE para siempre: cualquiera, en cualquier máquina, en cualquier
 *       momento, corre el mismo comando y obtiene la misma respuesta.
 *
 *       Los tres puntos que el ticket manda resolver quedan resueltos por construcción:
 *         (1) el anclaje lo escribe git, no el agente;
 *         (2) la verificación corre en la escritura Y sigue corriendo después, con el
 *             mismo resultado — que es lo que hace que el token no caduque;
 *         (3) la re-aplicación del `content` deja de ser un problema: no hay nada que
 *             distinguir, porque el resultado es determinístico en el rev. Un token
 *             nuevo tampoco puede colarse "con fecha vieja": el rev se resuelve contra
 *             el repo, y si en ese commit la cosa existía, el token FALLA.
 *
 *       ALCANCE HONESTO: cubre afirmaciones sobre ARCHIVOS de un repo git. Una ausencia
 *       que no viva en git (una fila de una base, un endpoint) no puede usar este tipo —
 *       para eso sigue estando `absence`, con su caducidad y todo.
 */

import { createWriteStream, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// TKT-0321 — `import { distance } from 'fastest-levenshtein'` era ESTATICO y por nombre pelado,
// o sea que exigia un `node_modules` poblado al lado del hook. En la maquina de un dev de un
// tenant ese arbol no existe: el bundle del starter vendoriza las dependencias en
// `hooks/vendor/` y NO corre npm en la maquina del cliente (TKT-0314). Un import estatico que no
// resuelve falla ANTES del catch de este archivo, o sea sin mensaje y en cada mutacion.
//
// El orden es el mismo que usa `vendor-deps.mjs` para las otras tres deps: la copia vendorizada
// primero —es la que el equipo construyo, hasheo y versiono— y el nombre pelado despues, que es
// el camino de este repo (`hooks/package.json` + `npm ci`) y el del `npm install` de fallback
// del instalador. Los dos caminos tienen que existir: el CI de `hooks/` corre con node_modules y
// sin `vendor-deps.mjs` al lado; la maquina del cliente, al reves.
const distance = await (async () => {
  try {
    const { loadLevenshtein } = await import('./vendor-deps.mjs');
    const mod = await loadLevenshtein();
    if (typeof mod.distance === 'function') return mod.distance;
  } catch {
    /* sin vendor-deps al lado: queda el nombre pelado */
  }
  const mod = await import('fastest-levenshtein');
  return mod.distance;
})();

// =====================================================================
// Paths (LOW #5 fix v1.1 — os.homedir cross-platform)
// =====================================================================
const CLAUDE_HOME = join(homedir(), '.claude');
const LOG_DIR = join(CLAUDE_HOME, 'logs');
const HOOK_LOG_PATH = join(LOG_DIR, 'executable-verification.jsonl');
const BYPASSES_PENDING_PATH = join(LOG_DIR, 'bypasses-pending-hub-post.jsonl'); // NEW v1.1 MEDIUM #4

// =====================================================================
// mkdir recursive con guard existsSync (LOW #6 fix v1.1)
// =====================================================================
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

// =====================================================================
// Persistent write streams (MEDIUM #3 fix v1.1 — race condition Windows)
// OS-level append lock más robusto que appendFileSync per-call.
// =====================================================================
const logStream = createWriteStream(HOOK_LOG_PATH, { flags: 'a' });
const bypassesPendingStream = createWriteStream(BYPASSES_PENDING_PATH, { flags: 'a' });

// =====================================================================
// Constantes runtime
// =====================================================================
const FUZZY_THRESHOLD = Number(process.env.INTEGRA_HOOK_FUZZY_THRESHOLD || 0.95);
const SANDBOX_TIMEOUT_MS = 10000;
const SUBSTANTIVE_MIN_LENGTH = 500;
const TRUNC_QUOTE_EXCERPT = 80;
const TRUNC_FAIL_REASON = 200;

const CONFIRMED_BY_WHITELIST = new Set([
  'grep', 'cat', 'head', 'tail', 'wc', 'ls', 'test', 'find',
]);
const FIND_FLAGS_ALLOWED = new Set([
  '-name', '-type', '-maxdepth', '-mindepth', '-path', '-iname', '-not',
]);
const FIND_FLAGS_FORBIDDEN = new Set([
  '-delete', '-exec', '-execdir', '-fprint', '-printf', '-ok',
]);
const SHELL_METACHARS = /[><|;&`$()\\]/; // defense in depth — no shell interpolation

// =====================================================================
// Tools Hub mutations matcheadas — 7 entries (6 LIVE + 1 RESERVED).
// HIGH #1 disclosure: decision_supersede RESERVED future-proof — NO MCP tool HOY.
// Verificado ToolSearch 2026-05-26: tool no callable from Claude.
// =====================================================================
const HUB_MUTATION_MATCHERS = new Set([
  'mcp__integra-hub__spec_log_decision',      // LIVE
  'mcp__integra-hub__spec_log_bugfix',        // LIVE
  'mcp__integra-hub__spec_comment',           // LIVE (filter por category=decision|bugfix en extractBody)
  'mcp__integra-hub__spec_create',            // LIVE
  'mcp__integra-hub__spec_update_phase',      // LIVE
  'mcp__integra-hub__decision_create',        // LIVE
  'mcp__integra-hub__decision_supersede',     // ⚠️ RESERVED — sin efecto operacional HOY (HIGH #1)
]);

// =====================================================================
// Regex parsers per SKILL.md sec 5 canonical (verificado en commit fa9b34a)
// Nota: regex de presence path soporta `:N` (single line) o `:N-M` (rango)
// per S1 bugfix cmpmur30200f2t02hjl8kbbqe.
// =====================================================================
const REGEX_PRESENCE = /\[src:\s+([^\]]+?)\]\s*\[quote:\s+"((?:[^"\\]|\\.)*)"\]/g;
const REGEX_ABSENCE = /\[absence:\s+([^\]]+?)\]\s*\[confirmed-by:\s+"((?:[^"\\]|\\.)*)"\]/g;
// TKT-0312 — `absence-at` es un tipo aparte, no una variante de `absence`: el literal
// de apertura es distinto (`[absence-at:` vs `[absence:`), asi que los dos regex no se
// pisan. El anclaje es un rev de git, no una fecha libre.
const REGEX_ABSENCE_AT = /\[absence-at:\s+([^\]]+?)\]\s*\[as-of:\s+([^\]\s]+)\]/g;
const REGEX_EXTERNAL = /\[src:\s+(https?:\/\/[^\]]+?)\]\s*\[verify-external\]/g;
const REGEX_GATE_REQUIRED = /\[gate-required:\s+([^\]]+?)\]/g;
const REGEX_OPERATOR_DECISION = /\[operator-decision:\s+(\d{4}-\d{2}-\d{2})\s+"((?:[^"\\]|\\.)*)"\]/g;

const REGEX_PATH_LINES = /^(.+?):(\d+)(?:-(\d+))?$/;
const REGEX_URL = /^https?:\/\//;

// =====================================================================
// Helpers — utility
// =====================================================================
function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function nowIso() {
  return new Date().toISOString();
}

// =====================================================================
// isSubstantiveClaim (LOW #7 aceptada Adversarial sin cambio)
// =====================================================================
function isSubstantiveClaim(body) {
  if (!body || body.length < SUBSTANTIVE_MIN_LENGTH) return false;
  const claimPatterns = [
    /\b\d+\s+(violations|reviews|tokens|files|cases|errors|tests|commits|rows|specs|phases)\b/i,
    /(según|per|de acuerdo a)\s+\w+/i,
    /\b(VERIFIED|FAILED|APPROVED|REJECTED|BLOCKED|MERGED|DEPRECATED)\b/,
    /verbatim/i,
    /\b(latency|throughput|p95|p99|ms\b)\b/i,
    /\b(commit|cuid|branch)\s+[a-z0-9]{6,}/i,
  ];
  return claimPatterns.some((p) => p.test(body));
}

// =====================================================================
// extractBody — per tool, devuelve el field correcto del payload
// =====================================================================
function extractBody(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';

  // spec_comment: solo aplica para category decision|bugfix
  // (comments simples no requieren tokens — bypass natural)
  if (toolName === 'mcp__integra-hub__spec_comment') {
    const cat = toolInput.category || 'comment';
    if (cat === 'comment') return '';
    return toolInput.content || '';
  }

  // spec_create / spec_update_phase: description
  if (
    toolName === 'mcp__integra-hub__spec_create' ||
    toolName === 'mcp__integra-hub__spec_update_phase'
  ) {
    return toolInput.description || toolInput.content || '';
  }

  // decision_supersede: RESERVED, sin efecto HOY — devolver vacío
  if (toolName === 'mcp__integra-hub__decision_supersede') {
    return '';
  }

  // Default: spec_log_decision, spec_log_bugfix, decision_create → content
  return toolInput.content || toolInput.description || '';
}

// =====================================================================
// extractIds — spec_id + phase_id del payload para telemetry
// =====================================================================
function extractIds(toolName, toolInput) {
  if (!toolInput) return { spec_id: null, phase_id: null };

  if (toolName === 'mcp__integra-hub__spec_create') {
    return { spec_id: null, phase_id: null };
  }
  if (
    toolName === 'mcp__integra-hub__spec_log_decision' ||
    toolName === 'mcp__integra-hub__spec_log_bugfix'
  ) {
    return { spec_id: toolInput.specId || null, phase_id: toolInput.phaseId || null };
  }
  if (toolName === 'mcp__integra-hub__spec_comment') {
    return { spec_id: toolInput.id || null, phase_id: toolInput.phaseId || null };
  }
  if (toolName === 'mcp__integra-hub__spec_update_phase') {
    return { spec_id: toolInput.specId || null, phase_id: toolInput.phaseId || toolInput.id || null };
  }
  return { spec_id: null, phase_id: null };
}

// =====================================================================
// parseTokens — extrae los 5 tipos del body
// =====================================================================
function parseTokens(body) {
  const tokens = [];
  if (!body) return tokens;

  // External primero (URL con verify-external tag) — para detectar antes de presence URL
  for (const m of body.matchAll(REGEX_EXTERNAL)) {
    tokens.push({ type: 'external', url: m[1], raw: m[0], index: m.index });
  }

  // Presence: path local con quote, o URL sin verify-external (caso A — V4 drift)
  for (const m of body.matchAll(REGEX_PRESENCE)) {
    const src = m[1];
    const quote = m[2];
    // Si src es URL → verificar si tag verify-external está dentro de los 50 chars siguientes
    if (REGEX_URL.test(src)) {
      const tail = body.slice(m.index, m.index + m[0].length + 50);
      const hasVerifyExt = /\[verify-external\]/.test(tail);
      if (!hasVerifyExt) {
        tokens.push({ type: 'presence-url-no-tag', src, quote, raw: m[0], index: m.index });
        continue;
      }
      // Si tiene verify-external → es external+quote combo, ya capturado arriba (skip dup)
      continue;
    }
    tokens.push({ type: 'presence', src, quote, raw: m[0], index: m.index });
  }

  for (const m of body.matchAll(REGEX_ABSENCE)) {
    tokens.push({ type: 'absence', target: m[1], confirmedBy: m[2], raw: m[0], index: m.index });
  }

  // TKT-0312 — absence anclada a un commit: no caduca porque el arbol de ese commit no
  // cambia. `matchAll` como los otros cinco y NO un `while (m = re.exec(...))`: en un
  // modulo ESM (strict mode) asignarle a una variable no declarada tira ReferenceError, y
  // el catch final del hook sale con 0 — o sea que el bug no se veria como un rojo sino
  // como un hook que deja pasar TODO por la via inline. Lo cazo el control negativo de
  // `absence-at-token.test.mjs`, que es exactamente para lo que ese caso existe.
  for (const m of body.matchAll(REGEX_ABSENCE_AT)) {
    tokens.push({ type: 'absence-at', target: m[1], asOf: m[2], raw: m[0], index: m.index });
  }

  for (const m of body.matchAll(REGEX_GATE_REQUIRED)) {
    tokens.push({ type: 'gate-required', reason: m[1], raw: m[0], index: m.index });
  }

  for (const m of body.matchAll(REGEX_OPERATOR_DECISION)) {
    tokens.push({ type: 'operator-decision', date: m[1], quote: m[2], raw: m[0], index: m.index });
  }

  return tokens.sort((a, b) => a.index - b.index);
}

// =====================================================================
// mapStructuredTokens — TKT-0045 P1
// Mapea el param estructurado `verification_tokens` a la misma lista interna
// que produce parseTokens, para que Paso 5 los valide sin distinguir origen.
// Tolera dos shapes:
//   Forma A (array): [{ type: 'presence', src, quote }, ...]
//   Forma B (objeto keyed): { presence: [...]|{...}, absence: [...], external,
//                             gate_required, operator_decision }
// Los tipos internos quedan hyphenated ('gate-required', 'operator-decision')
// para matchear el switch de Paso 5 y parseTokens. Entries inválidas se
// descartan (no rompen el fail-close: si NINGUNA mapea, queda fallback inline).
// =====================================================================
function mapOneStructured(type, e) {
  if (e === null || e === undefined) return null;
  switch (type) {
    case 'presence':
      if (e.src && e.quote) return { type: 'presence', src: String(e.src), quote: String(e.quote) };
      return null;
    case 'absence': {
      const target = e.target;
      const confirmedBy = e.confirmedBy ?? e.confirmed_by;
      if (target && confirmedBy) {
        return { type: 'absence', target: String(target), confirmedBy: String(confirmedBy) };
      }
      return null;
    }
    case 'absence-at': {
      // TKT-0312 — el nombre canonico del campo lo fija `absenceAtTokenSchema` en
      // mcp-server/src/verification.ts (`{claim, target, asOf}` con `.strict()`), que es
      // el unico emisor posible del param estructurado. Se acepta tambien `as_of` por el
      // mismo criterio que `confirmed_by` y `gate_required`.
      const target = e.target;
      const asOf = e.asOf ?? e.as_of;
      if (target && asOf) {
        return { type: 'absence-at', target: String(target), asOf: String(asOf) };
      }
      return null;
    }
    case 'external': {
      // TKT-0269 — el nombre canónico del campo es `src`, no `url`: lo fija el schema
      // de las tools MCP (`externalTokenSchema` en mcp-server/src/verification.ts,
      // `{claim, src, quote}` con `.strict()`), que es el único emisor posible del
      // param estructurado. Mientras acá se leía `e.url`, TODO token external mapeaba
      // a null, la lista quedaba vacía y el hook bloqueaba fail-closed con "requires
      // tokens" — sin nombrar el token, así que parecía que la mutación no llevaba
      // ninguno. El tipo `external` era inutilizable desde cualquier room.
      // NO se acepta `url` como alias: el `.strict()` de la tool lo rechaza antes de
      // llegar acá, así que tolerarlo sólo arrastraría el nombre equivocado.
      const src = typeof e === 'string' ? e : e.src;
      if (src) return { type: 'external', url: String(src) };
      return null;
    }
    case 'gate-required': {
      const reason = typeof e === 'string' ? e : (e.reason ?? e.gate_required);
      if (reason) return { type: 'gate-required', reason: String(reason) };
      return null;
    }
    case 'operator-decision':
      if (e.date && e.quote) return { type: 'operator-decision', date: String(e.date), quote: String(e.quote) };
      return null;
    default:
      return null;
  }
}

function mapStructuredTokens(vt) {
  if (!vt) return [];
  const out = [];
  let idx = 0;
  const push = (t) => {
    if (!t) return;
    t.raw = `[structured:${t.type}]`;
    t.index = idx++;
    out.push(t);
  };

  // Forma A — array de objetos {type, ...}
  if (Array.isArray(vt)) {
    for (const e of vt) {
      if (!e || typeof e !== 'object') continue;
      push(mapOneStructured(e.type, e));
    }
    return out;
  }
  if (typeof vt !== 'object') return [];

  // Forma B — objeto keyed por tipo; value puede ser objeto único o array
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const keyToType = {
    presence: 'presence',
    absence: 'absence',
    absence_at: 'absence-at',
    external: 'external',
    gate_required: 'gate-required',
    operator_decision: 'operator-decision',
  };
  for (const [key, type] of Object.entries(keyToType)) {
    for (const e of arr(vt[key])) push(mapOneStructured(type, e));
  }
  return out;
}

// =====================================================================
// Repo resolution — TKT-0045 P2
// El hook corre en el cwd de la sesión Claude Code (ej. cc-dev-room), que NO
// es el repo donde viven los archivos citados por los tokens. Resolvemos el
// repo real. Precedencia para tokens SIN alias explícito:
//   (1) env INTEGRA_REPO_PATH → (2) integra-repos.json `default` → (3) cwd de
//   sesión SOLO si es git work tree → si nada resuelve, FAILED claro.
// Tokens presence pueden prefijar `<alias>:<path>:N-M`; el alias se resuelve
// SIEMPRE contra integra-repos.json (alias desconocido = FAILED claro), lo que
// permite que un mismo artefacto cite varios repos (integra-hub, Webservices,
// Integra.Web). El alias explícito tiene precedencia sobre el default chain.
// =====================================================================
const REPO_ALIASES_PATH = join(CLAUDE_HOME, 'hooks', 'integra-repos.json');

function isGitWorkTree(dir) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      shell: false,
      encoding: 'utf8',
      timeout: SANDBOX_TIMEOUT_MS,
    });
    return r.status === 0 && (r.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
}

function loadRepoAliases() {
  if (!existsSync(REPO_ALIASES_PATH)) return { default: null, aliases: {} };
  try {
    const cfg = JSON.parse(readFileSync(REPO_ALIASES_PATH, 'utf8'));
    const aliases = cfg && typeof cfg.aliases === 'object' && cfg.aliases ? cfg.aliases : {};
    const def = typeof cfg?.default === 'string' ? cfg.default : null;
    return { default: def, aliases };
  } catch {
    return { default: null, aliases: {} };
  }
}

// Resuelve el repoRoot por defecto (tokens sin alias). Se computa UNA vez por
// invocación. Devuelve { root, source } o { root: null, fail_reason }.
function resolveDefaultRepoRoot(sessionCwd, repoCfg) {
  const envPath = process.env.INTEGRA_REPO_PATH;
  if (envPath) {
    if (isGitWorkTree(envPath)) return { root: envPath, source: 'env:INTEGRA_REPO_PATH' };
    return {
      root: null,
      fail_reason: `INTEGRA_REPO_PATH="${truncate(envPath, 80)}" is not a git work tree`,
    };
  }
  if (repoCfg.default) {
    const p = repoCfg.aliases[repoCfg.default];
    if (p && isGitWorkTree(p)) return { root: p, source: `config:default(${repoCfg.default})` };
    if (p) {
      return {
        root: null,
        fail_reason: `integra-repos.json default alias "${repoCfg.default}" → "${truncate(p, 80)}" is not a git work tree`,
      };
    }
    return {
      root: null,
      fail_reason: `integra-repos.json default alias "${repoCfg.default}" missing from aliases map`,
    };
  }
  if (isGitWorkTree(sessionCwd)) return { root: sessionCwd, source: 'cwd' };
  return {
    root: null,
    fail_reason: `no repo resolved: set INTEGRA_REPO_PATH, configure ~/.claude/hooks/integra-repos.json, or run from a git work tree (cwd "${truncate(sessionCwd, 80)}" is not one)`,
  };
}

// Extrae alias opcional de un path de token presence.
// `<alias>:<path>` → { alias, path } si <alias> existe en config; sino el path
// se devuelve intacto (back-compat con paths que no usan alias).
function splitAlias(rawPath, repoCfg) {
  const colonIdx = rawPath.indexOf(':');
  if (colonIdx <= 0) return { alias: null, path: rawPath };
  const candidate = rawPath.slice(0, colonIdx);
  if (Object.prototype.hasOwnProperty.call(repoCfg.aliases, candidate)) {
    return { alias: candidate, path: rawPath.slice(colonIdx + 1) };
  }
  return { alias: null, path: rawPath };
}

// =====================================================================
// validateConfirmedByCommand — sandbox + whitelist (sec 6 design v1.1)
// =====================================================================
function validateConfirmedByCommand(cmdString) {
  if (!cmdString || typeof cmdString !== 'string') {
    return { ok: false, reason: 'confirmed-by command empty' };
  }

  // Detect shell metachars (no redirects, no chains)
  if (SHELL_METACHARS.test(cmdString)) {
    return { ok: false, reason: 'shell metachars detected (no interpolation allowed)' };
  }

  // Split: comando + args (basic whitespace split — sin shell quoting)
  // El cmdString puede tener "→ N" output indicator al final; lo separamos.
  const arrowIdx = cmdString.indexOf('→');
  const cmdPart = (arrowIdx >= 0 ? cmdString.slice(0, arrowIdx) : cmdString).trim();
  const parts = cmdPart.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, reason: 'confirmed-by command empty after parse' };
  }

  const binary = parts[0];
  const args = parts.slice(1);

  if (!CONFIRMED_BY_WHITELIST.has(binary)) {
    return { ok: false, reason: `command not in whitelist: ${binary}` };
  }

  if (binary === 'find') {
    for (const arg of args) {
      if (arg.startsWith('-')) {
        if (FIND_FLAGS_FORBIDDEN.has(arg)) {
          return { ok: false, reason: `find flag forbidden: ${arg}` };
        }
        if (!FIND_FLAGS_ALLOWED.has(arg)) {
          return { ok: false, reason: `find flag not in allowed set: ${arg}` };
        }
      }
    }
  }

  // Detectar output indicator esperado ("→ <expected>")
  const expectedOutput = arrowIdx >= 0 ? cmdString.slice(arrowIdx + 1).trim() : null;

  return { ok: true, binary, args, expectedOutput };
}

// =====================================================================
// executeConfirmedBy — spawnSync con timeout/cwd restricted/no shell
// =====================================================================
function executeConfirmedBy(binary, args, cwd) {
  let cmdToRun = binary;
  let argsToRun = args;

  // Linux: unshare -n para network deny
  if (platform() === 'linux') {
    cmdToRun = 'unshare';
    argsToRun = ['-n', binary, ...args];
  }
  // Windows: best-effort whitelist (D4 limitation declarada)

  try {
    const r = spawnSync(cmdToRun, argsToRun, {
      timeout: SANDBOX_TIMEOUT_MS,
      cwd: cwd || process.cwd(),
      shell: false,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });

    const timedOut = r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT';

    return {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      timedOut,
      exitCode: r.status,
      error: r.error?.message || null,
    };
  } catch (e) {
    return { stdout: '', stderr: e.message, timedOut: false, exitCode: -1, error: e.message };
  }
}

// =====================================================================
// normalizeMarkdownEscapes — v1.2 D2 BK6 fix
// Symmetric normalization en quote y slice antes de diff. Engineering
// suele escapar pipes `\|` en tokens citando markdown tables; el slice
// del source los tiene literales. Sin normalization → fuzzy < 0.95 por
// 3 chars distance espurios. Aplicado en ambos lados antes de Pass 1/1.5/2.
// =====================================================================
function normalizeMarkdownEscapes(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\\\|/g, '|')
    .replace(/\\\*/g, '*')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']');
}

// =====================================================================
// validatePresence — git show HEAD:<path> + 3-pass diff (v1.2 D1 BK4+BK7 fix)
// Pass 1: substring exact (rápido, cubre quotes citados textuales).
// Pass 1.5: fuzzy full-slice Levenshtein normalized (preserva v1.1 fallback
//           para multi-line quotes con typos minor — whitespace/CRLF).
// Pass 2: fuzzy line-aware (mejor match line-by-line, cubre quotes
//          substring de líneas largas como plan v3.1 línea 244 ~3000 chars).
// =====================================================================
function validatePresence(src, quote, repoResolution, repoCfg) {
  const pathMatch = src.match(REGEX_PATH_LINES);
  if (!pathMatch) {
    return {
      type: 'presence',
      src: truncate(src, TRUNC_QUOTE_EXCERPT),
      result: 'FAILED',
      fail_reason: truncate(`presence src missing line range (:N or :N-M): ${src}`, TRUNC_FAIL_REASON),
    };
  }
  const rawPath = pathMatch[1];
  const lineN = parseInt(pathMatch[2], 10);
  const lineM = pathMatch[3] ? parseInt(pathMatch[3], 10) : lineN;

  // TKT-0045 P2 — alias opcional + resolución de repo.
  const { alias, path } = splitAlias(rawPath, repoCfg);
  let repoRoot;
  if (alias) {
    const aliasPath = repoCfg.aliases[alias];
    if (!aliasPath || !isGitWorkTree(aliasPath)) {
      return {
        type: 'presence',
        src: truncate(src, TRUNC_QUOTE_EXCERPT),
        result: 'FAILED',
        fail_reason: truncate(`repo alias "${alias}" → "${aliasPath || '(unset)'}" is not a valid git work tree (check ~/.claude/hooks/integra-repos.json)`, TRUNC_FAIL_REASON),
      };
    }
    repoRoot = aliasPath;
  } else {
    if (!repoResolution.root) {
      return {
        type: 'presence',
        src: truncate(src, TRUNC_QUOTE_EXCERPT),
        result: 'FAILED',
        fail_reason: truncate(`repo resolution failed: ${repoResolution.fail_reason}`, TRUNC_FAIL_REASON),
      };
    }
    repoRoot = repoResolution.root;
  }

  // git show HEAD:<path> — read file at HEAD (en el repo resuelto, no el cwd de sesión)
  const r = spawnSync('git', ['show', `HEAD:${path}`], {
    cwd: repoRoot,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // hasta 10MB
    timeout: SANDBOX_TIMEOUT_MS,
  });

  if (r.status !== 0) {
    return {
      type: 'presence',
      src: truncate(src, TRUNC_QUOTE_EXCERPT),
      result: 'FAILED',
      fail_reason: truncate(`git show HEAD:${path} failed (file not tracked or HEAD mismatch): ${(r.stderr || '').slice(0, 100)}`, TRUNC_FAIL_REASON),
    };
  }

  const lines = (r.stdout || '').split('\n');
  if (lineN < 1 || lineN > lines.length) {
    return {
      type: 'presence',
      src: truncate(src, TRUNC_QUOTE_EXCERPT),
      result: 'FAILED',
      fail_reason: truncate(`line range out of bounds: ${path} has ${lines.length} lines, requested ${lineN}-${lineM}`, TRUNC_FAIL_REASON),
    };
  }
  const sliceEnd = Math.min(lineM, lines.length);
  const sliceRaw = lines.slice(lineN - 1, sliceEnd).join('\n');

  // v1.2 D2 — normalize markdown escapes symmetric en quote y slice
  const normalizedSlice = normalizeMarkdownEscapes(sliceRaw);
  const normalizedQuote = normalizeMarkdownEscapes(quote);

  // Pass 1 — substring exact (más rápido, cubre quotes citados textuales)
  if (normalizedSlice.includes(normalizedQuote)) {
    return {
      type: 'presence',
      src: truncate(src, TRUNC_QUOTE_EXCERPT),
      quote_excerpt: truncate(quote, TRUNC_QUOTE_EXCERPT),
      match_score: 1.0,
      pass: 1,
      result: 'VERIFIED',
    };
  }

  // Pass 1.5 — fuzzy full-slice Levenshtein normalized
  // Preserva v1.1 hook behavior como fallback para multi-line quotes con
  // typos minor (whitespace, encoding, line endings CRLF/LF) que Pass 1
  // substring exact no captura pero el slice completo todavía matchea.
  const fullDist = distance(normalizedSlice, normalizedQuote);
  const fullMaxLen = Math.max(normalizedSlice.length, normalizedQuote.length);
  const fullScore = fullMaxLen === 0 ? 1 : 1 - fullDist / fullMaxLen;
  if (fullScore >= FUZZY_THRESHOLD) {
    return {
      type: 'presence',
      src: truncate(src, TRUNC_QUOTE_EXCERPT),
      quote_excerpt: truncate(quote, TRUNC_QUOTE_EXCERPT),
      match_score: Number(fullScore.toFixed(3)),
      pass: 1.5,
      result: 'VERIFIED',
    };
  }

  // Pass 2 — fuzzy line-aware (BK4: quotes substring de líneas largas)
  // Itera cada línea del slice individualmente. Si la línea matchea ≥ threshold
  // contra el quote, VERIFIED (e.g. quote cita línea entera o casi entera).
  // Quotes substring corto contra línea muy larga van a fallar acá legítimamente
  // — usar Pass 1 substring exact path como primary, Pass 2 como secondary line-match.
  const sliceLines = normalizedSlice.split('\n');
  let bestLineScore = 0;
  for (const line of sliceLines) {
    const lineDist = distance(line, normalizedQuote);
    const lineMaxLen = Math.max(line.length, normalizedQuote.length);
    const lineScore = lineMaxLen === 0 ? 1 : 1 - lineDist / lineMaxLen;
    if (lineScore > bestLineScore) bestLineScore = lineScore;
  }
  const bestLineRounded = Number(bestLineScore.toFixed(3));

  if (bestLineScore >= FUZZY_THRESHOLD) {
    return {
      type: 'presence',
      src: truncate(src, TRUNC_QUOTE_EXCERPT),
      quote_excerpt: truncate(quote, TRUNC_QUOTE_EXCERPT),
      match_score: bestLineRounded,
      pass: 2,
      result: 'VERIFIED',
    };
  }

  return {
    type: 'presence',
    src: truncate(src, TRUNC_QUOTE_EXCERPT),
    quote_excerpt: truncate(quote, TRUNC_QUOTE_EXCERPT),
    match_score: bestLineRounded,
    pass: 2,
    result: 'FAILED',
    fail_reason: truncate(`3-pass fail: substring no match + fuzzy full-slice ${Number(fullScore.toFixed(3))} + best line ${bestLineRounded} < threshold ${FUZZY_THRESHOLD} for ${src}`, TRUNC_FAIL_REASON),
  };
}

// =====================================================================
// validateAbsence — confirmed-by command sandbox + output check
// =====================================================================
function validateAbsence(target, confirmedBy, repoResolution) {
  const validation = validateConfirmedByCommand(confirmedBy);
  if (!validation.ok) {
    return {
      type: 'absence',
      target: truncate(target, TRUNC_QUOTE_EXCERPT),
      confirmed_by: truncate(confirmedBy, TRUNC_QUOTE_EXCERPT),
      result: 'FAILED',
      fail_reason: truncate(`confirmed-by validation: ${validation.reason}`, TRUNC_FAIL_REASON),
    };
  }

  // TKT-0045 P2 — confirmed-by corre en el repo resuelto (default chain),
  // no en el cwd de sesión. absence no soporta alias por-token (el param
  // estructurado es {target, confirmedBy}); usa el default repoRoot.
  if (!repoResolution.root) {
    return {
      type: 'absence',
      target: truncate(target, TRUNC_QUOTE_EXCERPT),
      confirmed_by: truncate(confirmedBy, TRUNC_QUOTE_EXCERPT),
      result: 'FAILED',
      fail_reason: truncate(`repo resolution failed: ${repoResolution.fail_reason}`, TRUNC_FAIL_REASON),
    };
  }

  const exec = executeConfirmedBy(validation.binary, validation.args, repoResolution.root);

  if (exec.timedOut) {
    return {
      type: 'absence',
      target: truncate(target, TRUNC_QUOTE_EXCERPT),
      confirmed_by: truncate(confirmedBy, TRUNC_QUOTE_EXCERPT),
      result: 'FAILED',
      fail_reason: `confirmed-by timeout ${SANDBOX_TIMEOUT_MS}ms exceeded`,
    };
  }

  const stdout = (exec.stdout || '').trim();

  // Si el confirmed-by tiene "→ <expected>" → exact match contra eso
  if (validation.expectedOutput !== null && validation.expectedOutput !== undefined) {
    if (stdout === validation.expectedOutput) {
      return {
        type: 'absence',
        target: truncate(target, TRUNC_QUOTE_EXCERPT),
        confirmed_by: truncate(confirmedBy, TRUNC_QUOTE_EXCERPT),
        result: 'VERIFIED',
      };
    }
    return {
      type: 'absence',
      target: truncate(target, TRUNC_QUOTE_EXCERPT),
      confirmed_by: truncate(confirmedBy, TRUNC_QUOTE_EXCERPT),
      result: 'FAILED',
      fail_reason: truncate(`expected "${validation.expectedOutput}" got "${stdout.slice(0, 80)}"`, TRUNC_FAIL_REASON),
    };
  }

  // Sin output indicator explícito → heurística.
  //
  // TKT-0312 (bugfix encontrado al construir `absence-at`) — la heurística era
  // `['0','not found',''].some(ind => stdout === ind || stdout.includes(ind))`, y
  // `stdout.includes('')` es SIEMPRE true: cualquier salida satisfacía la condición. O
  // sea que un `absence` sin el indicador explícito `→ <esperado>` VERIFICABA siempre,
  // dijera lo que dijera el comando. El tipo entero era decorativo por esa vía. Lo cazó
  // el caso discriminador de `absence-at-token.test.mjs`, que existe justamente para
  // demostrar que el tipo nuevo aporta algo que el viejo no: fallaba porque el viejo
  // pasaba donde no debía.
  //
  // La heurística queda igual de generosa en lo que acepta —salida vacía, un `0` pelado,
  // o un "not found"— pero por COINCIDENCIA EXACTA (o de línea completa para el
  // "not found"), no por substring: con substring, `10 matches` "contiene" un `0` y
  // `archivo not found en la copia vieja` cuenta como ausencia.
  const lineas = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const ausencia =
    stdout === '' ||
    stdout === '0' ||
    (lineas.length === 1 && /not found/i.test(lineas[0]));
  if (ausencia) {
    return {
      type: 'absence',
      target: truncate(target, TRUNC_QUOTE_EXCERPT),
      confirmed_by: truncate(confirmedBy, TRUNC_QUOTE_EXCERPT),
      result: 'VERIFIED',
    };
  }

  return {
    type: 'absence',
    target: truncate(target, TRUNC_QUOTE_EXCERPT),
    confirmed_by: truncate(confirmedBy, TRUNC_QUOTE_EXCERPT),
    result: 'FAILED',
    fail_reason: truncate(`absence not confirmed, stdout: "${stdout.slice(0, 80)}"`, TRUNC_FAIL_REASON),
  };
}

// =====================================================================
// validateAbsenceAt — ausencia ANCLADA A UN COMMIT (TKT-0312)
// =====================================================================
//
// El punto entero del tipo: la respuesta NO depende de cuando se la pregunte. El arbol
// de un commit no cambia, asi que este check da lo mismo en la escritura, en la
// re-aplicacion del `content` seis meses despues, y en la maquina de otra persona.
//
// Se resuelve con `git cat-file -e <rev>:<path>`:
//   exit != 0 -> el path NO existia en ese arbol  -> VERIFIED-AT (pasa)
//   exit == 0 -> existia                          -> FAILED
//
// `cat-file -e` es la forma barata de preguntar "existe este objeto": no materializa el
// blob ni toca el working tree, asi que no puede pisar nada de la sesion.
//
// El rev se valida ANTES, con `rev-parse --verify <rev>^{commit}`. Un anclaje que no se
// puede resolver no es un anclaje: si se dejara pasar, el token diria "no existia en
// algo que nadie puede mirar", que es justo el token-que-aprueba-cualquier-cosa que el
// ticket queria evitar. Por eso es FAILED y no un warning.
function validateAbsenceAt(target, asOf, repoResolution) {
  const base = {
    type: 'absence-at',
    target: truncate(target, TRUNC_QUOTE_EXCERPT),
    as_of: truncate(asOf, TRUNC_QUOTE_EXCERPT),
  };

  if (!repoResolution.root) {
    return {
      ...base,
      result: 'FAILED',
      fail_reason: truncate(`repo resolution failed: ${repoResolution.fail_reason}`, TRUNC_FAIL_REASON),
    };
  }

  // Defensa en profundidad, igual que confirmed-by: nada de estos dos valores llega a un
  // shell (spawnSync sin shell), pero un metachar en el rev o en el path es senal de que
  // el token esta mal escrito, no de un uso legitimo.
  if (SHELL_METACHARS.test(asOf) || SHELL_METACHARS.test(target)) {
    return { ...base, result: 'FAILED', fail_reason: 'absence-at: target/as-of con metacaracteres de shell' };
  }

  const revOk = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${asOf}^{commit}`], {
    cwd: repoResolution.root,
    encoding: 'utf8',
    timeout: SANDBOX_TIMEOUT_MS,
    shell: false,
  });
  if (revOk.status !== 0) {
    return {
      ...base,
      result: 'FAILED',
      fail_reason: truncate(`absence-at: el rev "${asOf}" no se resuelve en ${repoResolution.root}`, TRUNC_FAIL_REASON),
    };
  }

  const exists = spawnSync('git', ['cat-file', '-e', `${asOf}:${target}`], {
    cwd: repoResolution.root,
    encoding: 'utf8',
    timeout: SANDBOX_TIMEOUT_MS,
    shell: false,
  });

  if (exists.status === 0) {
    return {
      ...base,
      result: 'FAILED',
      fail_reason: truncate(`absence-at: "${target}" SI existia en ${asOf} — la afirmacion es falsa sobre el pasado`, TRUNC_FAIL_REASON),
    };
  }

  // VERIFIED-AT y no VERIFIED a secas: el nombre del resultado dice que lo verificado es
  // una afirmacion sobre un momento, no sobre el presente. Quien lea el log despues tiene
  // que poder distinguir las dos cosas sin ir al tipo del token.
  return { ...base, result: 'VERIFIED-AT' };
}

// =====================================================================
// validateExternal — URL con verify-external tag → DEFERRED-EXTERNAL
// =====================================================================
function validateExternal(url) {
  return {
    type: 'external',
    src: truncate(url, TRUNC_QUOTE_EXCERPT),
    result: 'DEFERRED-EXTERNAL',
  };
}

// =====================================================================
// validateGateRequired → DEFERRED-GATE pero hook fail-CLOSED
// =====================================================================
function validateGateRequired(reason) {
  return {
    type: 'gate-required',
    reason,
    result: 'DEFERRED-GATE',
    fail_reason: `claim requires Adversarial gate review: ${reason}`,
  };
}

// =====================================================================
// validateOperatorDecision → VERIFIED-FORMAT (regex passed)
// =====================================================================
function validateOperatorDecision(date, quote) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      type: 'operator-decision',
      date,
      result: 'FAILED',
      fail_reason: 'operator-decision date format invalid (expected YYYY-MM-DD)',
    };
  }
  if (!quote || quote.length === 0) {
    return {
      type: 'operator-decision',
      date,
      result: 'FAILED',
      fail_reason: 'operator-decision quote empty',
    };
  }
  return {
    type: 'operator-decision',
    date,
    quote_excerpt: truncate(quote, TRUNC_QUOTE_EXCERPT),
    result: 'VERIFIED-FORMAT',
  };
}

// =====================================================================
// Telemetry
// =====================================================================
function logEvent(eventObj) {
  try {
    logStream.write(JSON.stringify(eventObj) + '\n');
  } catch (e) {
    process.stderr.write(`[hook] log write failed: ${e.message}\n`);
  }
}

function trackBypassPending(eventObj) {
  try {
    bypassesPendingStream.write(JSON.stringify(eventObj) + '\n');
  } catch (e) {
    process.stderr.write(`[hook] bypasses-pending write failed: ${e.message}\n`);
  }
}

// =====================================================================
// readStdinSync — lee payload JSON desde stdin (Claude Code PreToolUse)
// =====================================================================
function readStdinSync() {
  try {
    const buf = Buffer.alloc(0);
    const chunks = [];
    let bytesRead;
    const buffer = Buffer.alloc(65536);
    const fd = 0; // stdin
    const { readSync } = require('node:fs');
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    return '';
  }
}

// Async stdin reader (ESM-friendly)
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    // Si stdin está cerrado (sin input), resolver vacío después de 100ms
    setTimeout(() => resolve(data), 100);
  });
}

// =====================================================================
// Main workflow (7 pasos per design v1.1 sec 3.2)
// =====================================================================
async function main() {
  const startMs = Date.now();
  let payload;
  let toolName = 'unknown';
  let body = '';
  let cwd = process.cwd();

  try {
    const raw = await readStdin();
    if (!raw) {
      // sin input → allow (no PreToolUse válido)
      process.exit(0);
    }
    payload = JSON.parse(raw);
    toolName = payload.tool_name || 'unknown';
    cwd = payload.cwd || process.cwd();
  } catch (e) {
    logEvent({
      ts: nowIso(),
      tool: toolName,
      verdict: 'ALLOW',
      error: `payload parse error: ${e.message}`.slice(0, TRUNC_FAIL_REASON),
      latency_ms: Date.now() - startMs,
    });
    process.exit(0); // parse error → allow (no bloqueamos por bugs propios)
  }

  // Paso 2: si tool NOT IN matchers → allow
  if (!HUB_MUTATION_MATCHERS.has(toolName)) {
    process.exit(0);
  }

  const toolInput = payload.tool_input || {};
  body = extractBody(toolName, toolInput);
  const ids = extractIds(toolName, toolInput);

  // TKT-0045 P1 — param estructurado verification_tokens (precedencia sobre inline)
  const structuredTokens = mapStructuredTokens(toolInput.verification_tokens);

  // Paso 3: bypass mechanism
  const bypassReason = process.env.INTEGRA_HOOK_VERIFY_BYPASS;
  if (bypassReason) {
    if (bypassReason.length < 10) {
      process.stderr.write(
        `[hook] INTEGRA_HOOK_VERIFY_BYPASS must be >=10 chars (got ${bypassReason.length})\n`,
      );
      process.exit(2);
    }
    const event = {
      ts: nowIso(),
      tool: toolName,
      spec_id: ids.spec_id,
      phase_id: ids.phase_id,
      body_length: body.length,
      tokens_parsed: 0,
      verifications: [],
      latency_ms: Date.now() - startMs,
      verdict: 'ALLOW',
      bypass_reason: truncate(bypassReason, TRUNC_FAIL_REASON),
    };
    logEvent(event);
    trackBypassPending({
      ts: event.ts,
      tool: toolName,
      reason: event.bypass_reason,
      hub_target_spec_id: ids.spec_id,
      hub_target_phase_id: ids.phase_id,
      posted_to_hub: false,
    });
    process.exit(0);
  }

  // Paso 4: parsear tokens. TKT-0045 P1 — el param estructurado tiene
  // precedencia; inline queda como fallback cuando el param no viene o no
  // mapea ningún token válido. El fail-close (4b) no cambia.
  const tokens = structuredTokens.length > 0 ? structuredTokens : parseTokens(body);
  const tokens_source = structuredTokens.length > 0 ? 'structured' : 'inline';

  // Paso 4b: si body vacío o non-substantive sin tokens → allow
  if (tokens.length === 0) {
    if (!body || body.length === 0 || !isSubstantiveClaim(body)) {
      logEvent({
        ts: nowIso(),
        tool: toolName,
        spec_id: ids.spec_id,
        phase_id: ids.phase_id,
        body_length: body.length,
        tokens_parsed: 0,
        tokens_source,
        verifications: [],
        latency_ms: Date.now() - startMs,
        verdict: 'ALLOW',
      });
      process.exit(0);
    }

    // Body sustantivo sin tokens → fail-CLOSED
    logEvent({
      ts: nowIso(),
      tool: toolName,
      spec_id: ids.spec_id,
      phase_id: ids.phase_id,
      body_length: body.length,
      tokens_parsed: 0,
      tokens_source,
      verifications: [],
      latency_ms: Date.now() - startMs,
      verdict: 'BLOCK',
      error: 'substantive claim body without tokens',
    });
    process.stderr.write(
      `[hook BLOCK] Substantive claim mutation requires tokens or ## Verification section. ` +
        `See SKILL.md staff-verification-protocol sec 2-3. Tool: ${toolName}.\n`,
    );
    process.exit(2);
  }

  // Paso 5: validar cada token.
  // TKT-0045 P2 — resolver el repo UNA vez (tokens sin alias usan este default).
  const repoCfg = loadRepoAliases();
  const repoResolution = resolveDefaultRepoRoot(cwd, repoCfg);

  const verifications = [];
  let anyFailed = false;
  let failMessages = [];

  for (const tk of tokens) {
    let v;
    if (tk.type === 'presence-url-no-tag') {
      v = {
        type: 'presence',
        src: truncate(tk.src, TRUNC_QUOTE_EXCERPT),
        result: 'FAILED',
        fail_reason: `URL claims require [verify-external] tag: ${tk.src}`,
      };
    } else if (tk.type === 'presence') {
      v = validatePresence(tk.src, tk.quote, repoResolution, repoCfg);
    } else if (tk.type === 'absence') {
      v = validateAbsence(tk.target, tk.confirmedBy, repoResolution);
    } else if (tk.type === 'absence-at') {
      v = validateAbsenceAt(tk.target, tk.asOf, repoResolution);
    } else if (tk.type === 'external') {
      v = validateExternal(tk.url);
    } else if (tk.type === 'gate-required') {
      v = validateGateRequired(tk.reason);
    } else if (tk.type === 'operator-decision') {
      v = validateOperatorDecision(tk.date, tk.quote);
    } else {
      v = { type: tk.type, result: 'FAILED', fail_reason: 'unknown token type' };
    }
    verifications.push(v);

    // gate-required cuenta como BLOCK (fail-CLOSED per sec 5.4)
    if (
      v.result === 'FAILED' ||
      v.result === 'DEFERRED-GATE'
    ) {
      anyFailed = true;
      if (v.fail_reason) failMessages.push(v.fail_reason);
    }
  }

  // Paso 6/7: verdict final
  const latency_ms = Date.now() - startMs;
  const event = {
    ts: nowIso(),
    tool: toolName,
    spec_id: ids.spec_id,
    phase_id: ids.phase_id,
    body_length: body.length,
    tokens_parsed: tokens.length,
    tokens_source,
    repo_root: repoResolution.root || null,
    repo_source: repoResolution.source || null,
    verifications,
    latency_ms,
    verdict: anyFailed ? 'BLOCK' : 'ALLOW',
  };
  logEvent(event);

  if (anyFailed) {
    process.stderr.write(
      `[hook BLOCK] ${failMessages.length} verification failure(s):\n` +
        failMessages.map((m, i) => `  ${i + 1}. ${m}`).join('\n') +
        '\n',
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[hook] fatal: ${e.message}\n`);
  process.exit(0); // fatal interno → allow (no bloqueamos por bugs propios)
});
