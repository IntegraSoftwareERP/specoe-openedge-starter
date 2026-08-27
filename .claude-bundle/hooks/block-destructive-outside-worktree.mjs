#!/usr/bin/env node
/**
 * block-destructive-outside-worktree.mjs
 *
 * PreToolUse hook (matcher: Bash) que ABORTA comandos destructivos cuyo PATH
 * RESUELTO cae FUERA del working dir del propio worktree, y `git stash`
 * mutador desde un worktree LINKED.
 *
 * Discriminador = PATH RESUELTO (realpath siguiendo junctions/symlinks), NO el
 * nombre del comando. Regla firmada por el Arquitecto (TKT-0120,
 * comment cmr0si9gh00191257kd4x0qij).
 *
 * Incidente origen: worktrees de C:\Integra\integra-hub comparten .git comun.
 *  - refs/stash es GLOBAL -> `git stash pop` desde un linked agarro el WIP del
 *    principal y lo aplico por error.
 *  - node_modules del backend es junction -> principal -> `rm -rf node_modules`
 *    desde un worktree borro el .bin del principal (153 shims).
 *
 * Reglas implementadas:
 *  1. git stash MUTADOR (push/save/pop/apply/drop/clear/store/branch/create o
 *     pelado): BLOQUEA si worktree LINKED (git-dir != git-common-dir).
 *     READ-ONLY (list/show): SIEMPRE PERMITE. En el principal: PERMITE todo.
 *  2. rm recursivo (-r/-R/--recursive, incl -rf) y git clean: resuelve cada
 *     path objetivo con realpath; si ALGUNO escapa del worktree root -> BLOQUEA.
 *  3. Cualquier otra cosa -> passthrough (exit 0).
 *
 * Tratamiento de paths inexistentes: fs.realpathSync tira ENOENT en un path que
 * no existe (ej. `rm -rf no-existe`). Se resuelve el ANCESTRO EXISTENTE mas
 * cercano (subiendo dirname) y se evalua ESE contra el worktree root. Asi un rm
 * de un path inexistente que apunta afuera igual se bloquea, y uno que apunta
 * adentro pasa. Nunca crashea ni falla-abierto por el throw.
 *
 * TKT-0327 — dos correcciones al tokenizer, las dos medidas al escribirle la
 * primera suite a este archivo (TKT-0325):
 *  a. FAIL-OPEN cerrado: el backslash dentro de comillas dobles se trataba como
 *     escape ante cualquier caracter, y bash solo lo hace ante $ ` " \ y
 *     newline. `rm -rf "C:\Integra\x"` llegaba como `C:Integrax`, dejaba de ser
 *     absoluto, se resolvia relativo al worktree y PASABA. En Windows, que es
 *     el unico SO donde este hook corre.
 *  b. Falso positivo cerrado: el cuerpo de un heredoc se tokenizaba como si
 *     fueran argumentos, asi que un MENSAJE de commit que nombraba un
 *     destructivo disparaba el falla-cerrado. Ahora se descarta antes de
 *     segmentar.
 *
 * HEURISTIC, NOT a security firewall. Limites conocidos (falla-CERRADO):
 *  - Subshells / command substitution ($(...), backticks, grouping con
 *    parentesis) que envuelvan un destructivo -> BLOQUEA (no se parsean
 *    confiablemente). Ojo: sigue valiendo para el cuerpo de un heredoc que NO
 *    cierra con su delimitador — ahi no hay forma de saber donde termina el dato.
 *  - `git -C <path>` / `--git-dir` (apunta a otro repo) en stash/clean -> BLOQUEA.
 *  - git clean sin paths explicitos: heuristica ACOTADA -> escaneo bounded
 *    (depth<=2) buscando un junction/symlink que escape; si lo hay -> BLOQUEA.
 *  - Si un check destructivo lanza error inesperado -> BLOQUEA (falla-cerrado).
 * En todos los casos el bloqueo trae mensaje claro: correr standalone o desde
 * el principal. Mejor falla-cerrado avisando que romper el flujo normal.
 */

import { readFileSync, realpathSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// I/O helpers (calcado de pre-mutation-validator.mjs)
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function blockDestructive(reason, cmd, detail) {
  process.stderr.write(
    `BLOQUEADO: comando destructivo apunta FUERA del worktree.\n` +
      `\n` +
      `Razon: ${reason}\n` +
      `Comando: ${cmd}\n` +
      (detail ? `${detail}\n` : '') +
      `\n` +
      `Ningun rm -rf / git clean puede tocar un path cuyo realpath caiga fuera\n` +
      `del working dir del worktree. El junction de node_modules es la trampa:\n` +
      `parece local, su realpath sale al principal.\n` +
      `Si es legitimo: corre el comando desde el repo principal, o apunta a un\n` +
      `path real dentro del worktree.\n`,
  );
  process.exit(2);
}

function blockStash(cmd) {
  process.stderr.write(
    `BLOQUEADO: git stash mutador desde un worktree LINKED.\n` +
      `\n` +
      `Comando: ${cmd}\n` +
      `\n` +
      `Worktree linked: el stash es global y compartido con el principal.\n` +
      `Usa \`git commit\` wip: en tu branch.\n` +
      `(git stash list / git stash show son read-only y estan permitidos.)\n`,
  );
  process.exit(2);
}

function blockFailClosed(reason, cmd) {
  process.stderr.write(
    `BLOQUEADO POR SEGURIDAD (falla-cerrado): no pude verificar con certeza que\n` +
      `este comando destructivo se mantenga dentro del worktree.\n` +
      `\n` +
      `Razon: ${reason}\n` +
      `Comando: ${cmd}\n` +
      `\n` +
      `Corre el comando standalone (sin subshell/encadenamiento ni \`git -C\`),\n` +
      `o desde el repo principal.\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInside(child, root) {
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r + '/');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// realpath del ancestro EXISTENTE mas cercano (sube dirname hasta uno que exista).
// Resuelve junctions/symlinks Windows. Nunca tira por ENOENT.
function realpathNearestExisting(absPath) {
  let cur = absPath;
  // limite defensivo para evitar loop infinito
  for (let i = 0; i < 256; i++) {
    if (existsSync(cur)) {
      try {
        return realpathSync(cur);
      } catch {
        /* sigue subiendo */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return cur; // raiz del filesystem
    cur = parent;
  }
  return cur;
}

// Resuelve un operando (relativo/absoluto/~) contra el cwd virtual y devuelve su
// realpath-de-ancestro-existente. Devuelve null si no se puede determinar.
function resolveOperand(operand, vcwd) {
  if (vcwd === null) return null;
  const expanded = expandHome(operand);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(vcwd, expanded);
  return realpathNearestExisting(abs);
}

// Escaneo bounded buscando un junction/symlink-dir cuyo realpath escape de root.
// Usado por: glob en rm recursivo + git clean sin paths explicitos.
function findEscapingJunction(dir, root, maxDepth) {
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        let real;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        if (!isInside(real, root)) return { link: full, real };
      } else if (lst.isDirectory() && depth < maxDepth) {
        // no recursar dentro de node_modules/.git (acota costo)
        if (e.name !== 'node_modules' && e.name !== '.git') stack.push([full, depth + 1]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizer que respeta comillas simples/dobles + escapes
// ---------------------------------------------------------------------------

/**
 * TKT-0327 — los unicos caracteres que un backslash escapa DENTRO de comillas
 * dobles, segun el shell. Antes de cualquier otro, el backslash es literal.
 */
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);

const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/**
 * TKT-0327 — devuelve solo las lineas que son COMANDOS: descarta el cuerpo de
 * cada heredoc, que es dato (el mensaje del commit), y conserva la linea que lo
 * abre, que si trae argumentos de verdad.
 *
 * Duplicado a proposito de `block-no-verify.mjs` en vez de compartir un modulo:
 * `install.mjs` copia hook por hook a ~/.claude/hooks/ y el instalador del
 * starter tiene un allowlist por archivo, asi que un modulo compartido seria un
 * cuarto archivo que hay que acordarse de distribuir en los dos canales — y el
 * que se olvide deja al hook fallando al importar, que es fail-OPEN. Quince
 * lineas repetidas cuestan menos que eso.
 */
export function stripHeredocBodies(cmd) {
  const out = [];
  const lines = String(cmd).split('\n');
  let delim = null;
  for (const line of lines) {
    if (delim !== null) {
      if (line.trim() === delim) delim = null;
      continue;
    }
    const m = line.match(HEREDOC_OPEN);
    if (m) delim = m[2];
    out.push(line);
  }
  return out.join('\n');
}

export function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let i = 0;
  let inS = false;
  let inD = false;
  let started = false;
  while (i < segment.length) {
    const ch = segment[i];
    if (inS) {
      if (ch === "'") inS = false;
      else cur += ch;
      i++;
      continue;
    }
    if (inD) {
      if (ch === '"') inD = false;
      // TKT-0327 — dentro de comillas dobles el backslash NO es escape universal:
      // bash sólo lo trata como tal antes de $ ` " \ y newline. Ante cualquier
      // otro caracter queda literal. Comerselo siempre convertia
      // `rm -rf "C:\Integra\x"` en `C:Integrax`, que deja de ser un path
      // absoluto, se resolvia RELATIVO al worktree y por lo tanto pasaba: un
      // fail-OPEN en el unico SO donde este hook corre.
      else if (ch === '\\' && i + 1 < segment.length && DQ_ESCAPABLE.has(segment[i + 1])) {
        cur += segment[i + 1];
        i += 2;
        continue;
      } else cur += ch;
      i++;
      continue;
    }
    if (ch === "'") {
      inS = true;
      started = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inD = true;
      started = true;
      i++;
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

const HAS_GLOB = /[*?[\]]/;

// ---------------------------------------------------------------------------
// git context
// ---------------------------------------------------------------------------

function gitContext(cwd) {
  try {
    const out = execSync('git rev-parse --show-toplevel --git-dir --git-common-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) return null;
    const [top, gitDir, commonDir] = lines;
    const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    const absCommon = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
    const linked = norm(absGitDir) !== norm(absCommon);
    return { top, linked };
  } catch {
    return null; // no es repo git
  }
}

// ---------------------------------------------------------------------------
// git subcommand detection
// ---------------------------------------------------------------------------

function gitSubcommand(argv) {
  // argv[0] === 'git'
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree') {
      return { alt: true };
    }
    if (t.startsWith('-')) continue;
    return { sub: t, rest: argv.slice(i + 1) };
  }
  return {};
}

const STASH_READONLY = new Set(['list', 'show']);

// ---------------------------------------------------------------------------
// rm recursivo: detecta flags + operandos
// ---------------------------------------------------------------------------

function rmIsRecursive(argv) {
  for (const t of argv.slice(1)) {
    if (t === '--') break;
    if (t === '--recursive') return true;
    if (/^-[^-]*[rR]/.test(t)) return true;
  }
  return false;
}

function rmOperands(argv) {
  const ops = [];
  let afterDoubleDash = false;
  for (const t of argv.slice(1)) {
    if (afterDoubleDash) {
      ops.push(t);
      continue;
    }
    if (t === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (t.startsWith('-')) continue; // flag
    ops.push(t);
  }
  return ops;
}

function gitCleanOperands(rest) {
  // rest = tokens despues de 'clean'
  const ops = [];
  let afterDoubleDash = false;
  for (const t of rest) {
    if (afterDoubleDash) {
      ops.push(t);
      continue;
    }
    if (t === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (t.startsWith('-')) continue;
    ops.push(t);
  }
  return ops;
}

function gitCleanFlags(rest) {
  // junta las letras de short-flags (-fdx -> f,d,x) + long flags
  const set = new Set();
  for (const t of rest) {
    if (t === '--') break;
    if (t.startsWith('--')) {
      set.add(t.replace(/^--/, ''));
    } else if (t.startsWith('-')) {
      for (const ch of t.slice(1)) set.add(ch);
    }
  }
  return set;
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

  // TKT-0327 — el cuerpo de un heredoc es DATO, no argumentos. `git commit -F -`
  // lleva ahi el MENSAJE del commit, y un mensaje que nombra un destructivo y
  // trae parentesis disparaba el falla-cerrado de mas abajo. Lo sufrio el commit
  // que trajo este archivo al repo (TKT-0325), que hubo que mandar con -F archivo.
  // Empuja a workarounds justo cuando se documenta un trabajo sobre destructivos,
  // que es cuando mas probable es nombrarlos.
  const comandos = stripHeredocBodies(cmd);

  // Fast path: si no hay keyword destructivo, no tocamos nada.
  if (!/\brm\b|\bgit\b[^\n]*\bstash\b|\bgit\b[^\n]*\bclean\b/.test(comandos)) {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();

  // A partir de aca, cualquier error inesperado -> falla-CERRADO.
  try {
    // Falla-cerrado: subshell / command substitution / grouping envolviendo destructivo.
    if (/\$\(|`|\(/.test(comandos)) {
      blockFailClosed(
        'subshell / command substitution / agrupacion con parentesis detectada; no se parsea confiablemente',
        cmd,
      );
    }

    const git = gitContext(cwd);

    // Segmentos secuenciales (&&, ||, ;, |, newline). Tracking de cwd virtual.
    const segments = comandos.split(/&&|\|\||;|\n|\|/);
    let vcwd = realpathNearestExisting(path.resolve(cwd));

    for (const seg of segments) {
      const tokens = tokenize(seg);
      if (tokens.length === 0) continue;

      // saltear asignaciones de env al inicio (VAR=val)
      let k = 0;
      while (k < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k])) k++;
      const argv = tokens.slice(k);
      if (argv.length === 0) continue;
      const cmd0 = argv[0];

      // cd: actualiza cwd virtual
      if (cmd0 === 'cd' || cmd0 === 'pushd') {
        const target = argv[1];
        if (!target || target === '~' || target === '-') {
          vcwd = null; // home / desconocido -> destructivo posterior falla-cerrado
          continue;
        }
        const expanded = expandHome(target);
        const next = path.isAbsolute(expanded)
          ? expanded
          : vcwd === null
            ? null
            : path.resolve(vcwd, expanded);
        vcwd = next === null ? null : realpathNearestExisting(next);
        continue;
      }

      // ---- rm ----
      if (cmd0 === 'rm') {
        if (!rmIsRecursive(argv)) continue; // solo gateamos rm recursivo
        if (vcwd === null) {
          blockFailClosed('no pude determinar el cwd efectivo (cd a destino ambiguo)', cmd);
        }
        for (const op of rmOperands(argv)) {
          if (HAS_GLOB.test(op)) {
            // glob: escaneo del dir base buscando junction que escape
            const base = op.replace(/[*?[].*$/, '');
            const baseDir = base.endsWith('/') || base === '' ? base : path.dirname(base);
            const resolvedBase = resolveOperand(baseDir || '.', vcwd);
            if (resolvedBase === null) {
              blockFailClosed('glob sobre cwd indeterminado', cmd);
            }
            if (!isInside(resolvedBase, git ? git.top : resolvedBase)) {
              blockDestructive(
                'el directorio base del glob resuelve fuera del worktree',
                cmd,
                `Base: ${baseDir} -> ${resolvedBase}\nWorktree root: ${git ? git.top : '(no repo)'}`,
              );
            }
            if (git) {
              const esc = findEscapingJunction(resolvedBase, git.top, 1);
              if (esc) {
                blockDestructive(
                  'el glob alcanza un junction/symlink cuyo realpath escapa del worktree',
                  cmd,
                  `Junction: ${esc.link} -> ${esc.real}\nWorktree root: ${git.top}`,
                );
              }
            }
            continue;
          }
          const resolved = resolveOperand(op, vcwd);
          if (resolved === null) {
            blockFailClosed('cwd efectivo indeterminado para el operando', cmd);
          }
          const root = git ? git.top : null;
          if (root && !isInside(resolved, root)) {
            blockDestructive(
              'un path objetivo resuelve fuera del worktree root',
              cmd,
              `Path: ${op} -> ${resolved}\nWorktree root: ${root}`,
            );
          }
        }
        continue;
      }

      // ---- git ----
      if (cmd0 === 'git') {
        const { alt, sub, rest } = gitSubcommand(argv);
        if (alt) {
          blockFailClosed('git -C / --git-dir apunta a otro repo; no se razona el destino', cmd);
        }

        // git stash
        if (sub === 'stash') {
          const subsub = (rest || []).find((t) => !t.startsWith('-'));
          if (subsub && STASH_READONLY.has(subsub)) continue; // list/show: read-only -> permite
          // mutador (push/save/pop/apply/drop/clear/store/branch/create o pelado)
          if (git && git.linked) {
            blockStash(cmd);
          }
          continue; // principal -> el stash es tuyo, permite
        }

        // git clean
        if (sub === 'clean') {
          if (!git) continue; // git clean fuera de repo falla solo
          const ops = gitCleanOperands(rest || []);
          if (ops.length > 0) {
            for (const op of ops) {
              const resolved = resolveOperand(op, vcwd);
              if (resolved === null) {
                blockFailClosed('cwd efectivo indeterminado para path de git clean', cmd);
              }
              if (!isInside(resolved, git.top)) {
                blockDestructive(
                  'un path de git clean resuelve fuera del worktree root',
                  cmd,
                  `Path: ${op} -> ${resolved}\nWorktree root: ${git.top}`,
                );
              }
            }
            continue;
          }
          // sin paths explicitos: heuristica acotada solo si toca ignorados (-x/-X)
          const flags = gitCleanFlags(rest || []);
          if (flags.has('x') || flags.has('X')) {
            const scanRoot = vcwd && isInside(vcwd, git.top) ? vcwd : git.top;
            const esc = findEscapingJunction(scanRoot, git.top, 2);
            if (esc) {
              blockDestructive(
                'git clean -x/-X alcanzaria un junction/symlink cuyo realpath escapa del worktree',
                cmd,
                `Junction: ${esc.link} -> ${esc.real}\nWorktree root: ${git.top}`,
              );
            }
          }
          continue;
        }
      }
    }
  } catch (e) {
    blockFailClosed(`error inesperado al verificar: ${e && e.message ? e.message : e}`, cmd);
  }

  process.exit(0);
}

// TKT-0327 — `main()` corre solo como PROCESO. Los tests importan `tokenize` y
// `stripHeredocBodies` para medirlas directo: el fail-OPEN del path de Windows
// no se puede probar por exit code en las dos plataformas —en ubuntu un path
// `C:\...` no es absoluto ni antes ni despues del arreglo— y sin esto el CI de
// una sola plataforma no tendria como verlo. El archivo sigue siendo UNO solo:
// `install.mjs` copia lo mismo que antes.
if (process.argv[1] && process.argv[1].endsWith('block-destructive-outside-worktree.mjs')) {
  main();
}
