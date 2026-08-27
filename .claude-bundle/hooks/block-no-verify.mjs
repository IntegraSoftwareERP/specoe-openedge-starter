#!/usr/bin/env node
/**
 * block-no-verify.mjs — TKT-0325
 *
 * PreToolUse hook (matcher: Bash) que ABORTA los comandos que saltean los hooks
 * de git: `--no-verify`, el `-n` de `git commit`, y toda escritura o override de
 * `core.hooksPath`.
 *
 * ── Por qué existe, y qué previene REALMENTE ────────────────────────────────
 *
 * `integra-hub` no tiene NINGÚN hook de git instalado: `.git/hooks/` sólo tiene
 * los 14 `.sample` (que git ignora por el sufijo), `core.hooksPath` no tiene
 * valor en ninguno de los tres scopes, no hay `.husky/`, y ninguno de los tres
 * `package.json` declara husky/lefthook/simple-git-hooks/lint-staged/prepare.
 * O sea: un `git commit` acá no ejecuta nada local, y saltear los hooks NO
 * saltea ninguna verificación. Toda la verificación vive en `pr-checks.yml`.
 *
 * Entonces este hook NO protege una verificación — protege el TRAIL.
 *
 * El defecto medido (SPEC-0196 P1, handoff `cmspbm7g00027jzoobw1w0dgy` y
 * closeout `cmspepf1g000f11qjb2lifeyz`): un agente commiteó con `core.hooksPath`
 * neutralizado, lo declaró como desviación —bien hecho—, rehízo el commit con
 * `--amend` y escribió *"lo rehice dejando correr los hooks; el commit que quedó
 * pasó por ellos"*. Esa segunda mitad es falsa y **nadie podía notarlo**: git no
 * dice nada cuando corre un hook ni cuando no hay ninguno, así que neutralizar
 * `core.hooksPath` y restaurarlo produce exactamente el mismo silencio que no
 * haberlo tocado. Quedó un verde-falso escrito en el cierre de una fase, que es
 * el documento que se lee después.
 *
 * Quien no puede neutralizar los hooks tampoco escribe después que los rehizo.
 * Ese es el efecto, y es el único que este hook puede reclamar.
 *
 * El segundo dato que lo justifica: la forma prohibida **no se emite por
 * decisión, se emite por hábito de plantilla**. El 2026-08-12, veinte minutos
 * después de leer TKT-0325 entero, la misma sesión que lo estaba trabajando
 * emitió `git -c core.hooksPath= commit` cerrando TKT-0324. Leer la regla no lo
 * evita. Mismo diagnóstico que TKT-0120 hizo con los destructivos fuera del
 * worktree: la regla escrita necesitaba un diente, y el diente en este entorno
 * es el interceptor de la herramienta, no un hook de git.
 *
 * ── Qué bloquea ─────────────────────────────────────────────────────────────
 *
 *  1. El token `--no-verify` en cualquier subcomando de git (commit, push, ...).
 *  2. El `-n` de `git commit` / `git merge`, incluso pegado (`-nm "msg"`).
 *     OJO: `-n` en `git push` es `--dry-run`, no `--no-verify` — no se bloquea.
 *  3. `git -c core.hooksPath=<lo que sea> ...` — el override por invocación.
 *  4. `git config [--scope] core.hooksPath <valor>` — la escritura persistente.
 *
 * ── Qué NO bloquea, a propósito ─────────────────────────────────────────────
 *
 *  - Las LECTURAS de la clave: `git config --get/--get-all/--get-regexp/--list`.
 *    Verificar en qué estado está la config es justamente lo que queremos que
 *    alguien pueda hacer.
 *  - `git config --unset core.hooksPath`: des-setear RESTAURA el default
 *    (`.git/hooks`). No desactiva nada; es la limpieza de una máquina donde la
 *    clave quedó puesta de antes.
 *  - El cuerpo de un heredoc. `git commit -F - <<'EOF' ... EOF` lleva el MENSAJE
 *    del commit, no argumentos: un mensaje que nombre `--no-verify` —como el de
 *    este mismo ticket— es texto, no un salteo. Se saltean las líneas hasta el
 *    delimitador.
 *  - El valor de `-m` / `--message` / `-F` / `--file`, por lo mismo.
 *
 * ── Límite conocido (falla-ABIERTO, declarado) ──────────────────────────────
 *
 * Detecta por token literal. `git commit $(echo --no-verify)` no lo caza, porque
 * el flag no está escrito. Es un límite aceptado: este hook existe contra el
 * hábito, no contra alguien decidido a rodearlo — y quien arma esa línea sabe
 * perfectamente lo que hace y no va a escribir después que los hooks corrieron.
 * Un fail-closed ante todo `$(...)` bloquearía media sesión de trabajo legítimo
 * para tapar un hueco que nadie usa por accidente. Se declara y no se tapa.
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// I/O (mismo patrón que block-destructive-outside-worktree.mjs)
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function block(razon, cmd, detalle) {
  process.stderr.write(
    `BLOQUEADO: este comando saltea los hooks de git.\n` +
      `\n` +
      `Razon: ${razon}\n` +
      `Comando: ${cmd}\n` +
      (detalle ? `${detalle}\n` : '') +
      `\n` +
      `Ojo con lo que este bloqueo significa y con lo que NO significa:\n` +
      `integra-hub hoy no tiene NINGUN hook de git, asi que saltearlos no\n` +
      `saltea ninguna verificacion. Lo que se evita es el paso siguiente:\n` +
      `declarar despues que "lo rehice dejando correr los hooks", que es\n` +
      `falso y no hay forma de notarlo (git calla en los dos casos). Eso ya\n` +
      `quedo escrito una vez en el cierre de SPEC-0196 P1 — TKT-0325.\n` +
      `\n` +
      `Corre el comando sin el flag. El commit sale igual: no hay nada que\n` +
      `los hooks fueran a ejecutar. Si de verdad necesitas saltearlos,\n` +
      `pediselo al Operador y declaralo como desviacion — sin afirmar que\n` +
      `una segunda corrida los hizo correr.\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Tokenizer: respeta comillas simples/dobles y el escape con backslash.
// ---------------------------------------------------------------------------

function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < segment.length && segment[i] !== quote) {
        cur += segment[i];
        i++;
      }
      i++; // cierre
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      cur += segment[i + 1];
      started = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      i++;
      continue;
    }
    cur += ch;
    started = true;
    i++;
  }
  if (started) tokens.push(cur);
  return tokens;
}

// ---------------------------------------------------------------------------
// Heredocs: el cuerpo es DATO (el mensaje del commit), no argumentos.
// Devuelve solo las lineas que son comandos.
// ---------------------------------------------------------------------------

const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

export function stripHeredocBodies(cmd) {
  const out = [];
  const lines = String(cmd).split('\n');
  let delim = null;
  for (const line of lines) {
    if (delim !== null) {
      // Dentro del cuerpo: se descarta hasta el delimitador.
      if (line.trim() === delim) delim = null;
      continue;
    }
    const m = line.match(HEREDOC_OPEN);
    if (m) delim = m[2];
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Analisis de una invocacion de git
// ---------------------------------------------------------------------------

const HOOKS_PATH_KEY = /^core\.hookspath$/i;
const CONFIG_READ_FLAGS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--list',
  '-l',
]);
const CONFIG_UNSET_FLAGS = new Set(['--unset', '--unset-all']);
/** Flags cuyo VALOR es texto libre (mensaje/archivo), no argumentos a inspeccionar. */
const VALUE_FLAGS = new Set(['-m', '--message', '-F', '--file', '-c', '--reedit-message']);
/** Subcomandos donde `-n` significa --no-verify (en `push` significa --dry-run). */
const DASH_N_IS_NO_VERIFY = new Set(['commit', 'merge']);

/**
 * Analiza un argv que empieza con `git`. Devuelve {razon, detalle} si hay que
 * bloquear, o null si pasa.
 */
export function analizarGit(argv) {
  // --- 1. Opciones ANTES del subcomando: `git -c core.hooksPath=... commit`
  let i = 1;
  let sub = null;
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-c' || t === '--config-env') {
      const par = argv[i + 1] || '';
      const clave = par.split('=')[0];
      if (HOOKS_PATH_KEY.test(clave)) {
        return {
          razon: 'override de core.hooksPath por invocacion (-c core.hooksPath=...)',
          detalle: `Neutraliza los hooks para ESE comando y no deja rastro en la config.`,
        };
      }
      i++; // consume el par clave=valor
      continue;
    }
    if (t.startsWith('-c') && t.length > 2) {
      const clave = t.slice(2).split('=')[0];
      if (HOOKS_PATH_KEY.test(clave)) {
        return {
          razon: 'override de core.hooksPath por invocacion (-ccore.hooksPath=...)',
          detalle: `Neutraliza los hooks para ESE comando y no deja rastro en la config.`,
        };
      }
      continue;
    }
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      i++; // consume el valor
      continue;
    }
    if (t.startsWith('-')) continue;
    sub = t;
    break;
  }
  if (sub === null) return null;

  const rest = argv.slice(i + 1);

  // --- 2. `git config ... core.hooksPath <valor>`
  if (sub === 'config') {
    const idxClave = rest.findIndex((t) => HOOKS_PATH_KEY.test(t));
    if (idxClave >= 0) {
      const esLectura = rest.some((t) => CONFIG_READ_FLAGS.has(t));
      const esUnset = rest.some((t) => CONFIG_UNSET_FLAGS.has(t));
      // `git config core.hooksPath` PELADO es una lectura (git imprime el valor).
      // Es escritura sólo si viene un operando después de la clave.
      const tieneValor = rest.slice(idxClave + 1).some((t) => !t.startsWith('-'));
      if (!esLectura && !esUnset && tieneValor) {
        return {
          razon: 'escritura de core.hooksPath en la config de git',
          detalle: `Apuntar la clave a otro lado (o a la nada) desactiva los hooks de forma persistente.`,
        };
      }
    }
  }

  // --- 3. `--no-verify` y el `-n` de commit/merge, en los argumentos del subcomando.
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (t === '--') break; // lo que sigue son paths
    if (VALUE_FLAGS.has(t)) {
      j++; // el valor es texto libre: no se inspecciona
      continue;
    }
    if (t === '--no-verify') {
      return {
        razon: `--no-verify en \`git ${sub}\``,
        detalle: null,
      };
    }
    if (
      DASH_N_IS_NO_VERIFY.has(sub) &&
      /^-[A-Za-z]*n/.test(t) &&
      !t.startsWith('--')
    ) {
      return {
        razon: `el flag -n de \`git ${sub}\` es --no-verify`,
        detalle: t === '-n' ? null : `Viene pegado a otros flags cortos: ${t}`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const raw = readStdin();
  if (!raw) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  if (payload.tool_name !== 'Bash') process.exit(0);

  const cmd = payload.tool_input?.command || '';
  if (!cmd) process.exit(0);

  // Fast path: sin `git` no hay nada que mirar.
  if (!/\bgit\b/.test(cmd)) process.exit(0);

  const comandos = stripHeredocBodies(cmd);
  const segments = comandos.split(/&&|\|\||;|\n|\|/);

  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (tokens.length === 0) continue;

    // saltear asignaciones de env al inicio (VAR=val)
    let k = 0;
    while (k < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k])) k++;
    const argv = tokens.slice(k);
    if (argv.length === 0 || argv[0] !== 'git') continue;

    const hallazgo = analizarGit(argv);
    if (hallazgo) block(hallazgo.razon, cmd, hallazgo.detalle);
  }

  process.exit(0);
}

// El archivo se importa desde los tests para probar `analizarGit` y
// `stripHeredocBodies` como funciones puras; `main()` sólo corre como proceso.
if (process.argv[1] && process.argv[1].endsWith('block-no-verify.mjs')) {
  main();
}
