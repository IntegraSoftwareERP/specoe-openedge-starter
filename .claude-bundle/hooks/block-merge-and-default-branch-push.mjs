#!/usr/bin/env node
/**
 * block-merge-and-default-branch-push.mjs — SPEC-0223 P7
 *
 * PreToolUse hook (matcher: Bash) que ABORTA dos órdenes: el **merge de un PR**
 * y el **push cuyo destino resuelve a la rama por defecto**.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * SPEC-0223 automatiza la ejecución de tasks: una fase programada abre una
 * sesión de agente **sin nadie presente** y le encadena una task tras otra. El
 * objetivo O8 de esa SPEC da por puesto que, en esas condiciones, un agente no
 * puede mergear su propio PR ni pushear a la rama por defecto — la regla del
 * equipo es *rama siempre, merge del Operador*.
 *
 * El finding F1 del ENGINEERING_PLAN (ronda 2) midió que **esa contención no
 * existía**: O8 medía un freno inexistente. Lo único que había era la regla
 * escrita, y la regla escrita no frena a un proceso que corre solo a las tres
 * de la mañana. `branch protection` —que sería la contención del lado del
 * servidor, la única que sí es garantía— **no está disponible en el plan de
 * GitHub de la cuenta**, y reducir el scope del token quedó descartado por
 * decisión del Operador. Dentro del alcance de esta SPEC, un hook local es la
 * única contención posible. ADR-011.
 *
 * ── Qué bloquea ─────────────────────────────────────────────────────────────
 *
 *  1. `gh pr merge` en cualquiera de sus formas (`--merge`, `--squash`,
 *     `--rebase`, `--admin`, con número de PR o sin él).
 *  2. La llamada equivalente por API: `gh api` con method **PUT** sobre una
 *     ruta que termina en `/merge` (`repos/OWNER/REPO/pulls/N/merge`), en sus
 *     formas `--method PUT`, `--method=PUT`, `-X PUT` y `-XPUT`.
 *  3. `git push` cuyo destino resuelve a la rama por defecto:
 *     - con refspec explícito — `origin master`, `HEAD:main`, `+master`,
 *       `feat/x:master`, `:master` (borrado);
 *     - **sin** refspec (`git push` pelado, `git push origin`), resolviendo la
 *       rama actual del repo del `cwd` del payload.
 *
 * ── Qué NO bloquea, a propósito ─────────────────────────────────────────────
 *
 *  - `git push origin feat/loquesea` — **la regla del equipo es rama siempre**.
 *    Si esto se bloqueara, el PR no se podría ni abrir y el hook se sacaría del
 *    `settings.json` el primer día. Es la mitad que decide si sobrevive.
 *  - `gh pr create`, `gh pr view`, `gh pr list`, `gh pr checkout` — abrir y
 *    leer un PR es exactamente lo que el agente TIENE que poder hacer.
 *  - `gh api` de lectura (sin method, o con GET) sobre `.../merge`.
 *  - `git merge origin/master` — el merge LOCAL de la base hacia la rama de
 *    trabajo es legítimo y frecuente. Lo que se frena es el merge del PR.
 *  - El cuerpo de un heredoc y el valor de `-m` / `--body`: son el MENSAJE, no
 *    argumentos. El commit de esta misma fase nombra `gh pr merge` en su texto;
 *    si el cuerpo contara como argumentos, el hook se bloquearía a sí mismo al
 *    nacer (mismo criterio que `block-no-verify.mjs`).
 *
 * ── Cómo se decide cuál es "la rama por defecto" ────────────────────────────
 *
 * Por **conjunto literal**: `master` y `main`. No se le pregunta a git.
 *
 * Es una decisión, no una omisión. Preguntar (`git symbolic-ref
 * refs/remotes/origin/HEAD`) falla hoy mismo en `integra-hub` —el ref no está
 * seteado en el clone del Operador— y la respuesta dependería del estado local
 * de cada máquina: el mismo comando quedaría frenado en una y libre en otra,
 * que es justo lo que un freno no puede hacer. Los tres repos de Integra usan
 * `master` o `main`. Un repo cuya rama por defecto se llame de otra forma NO
 * queda cubierto: está declarado acá y es el precio de que el criterio sea el
 * mismo en todas partes.
 *
 * ── Límites conocidos (declarados, no tapados) ──────────────────────────────
 *
 * Igual que `block-no-verify.mjs`, detecta por **token literal**:
 *
 *  - `gh pr $(echo merge)` no se caza: el token no está escrito. Un
 *    fail-closed ante todo `$(...)` frenaría media sesión legítima para tapar
 *    un hueco que nadie pisa por accidente.
 *  - Un merge por `curl -X PUT` con el token a mano tampoco: el contrato de
 *    esta fase nombra `gh` como la vía de API, y `gh` es lo que hay instalado.
 *  - `git push` pelado cuando la rama actual **no se puede resolver** (el `cwd`
 *    no es un work tree, git no está en el PATH): **falla-ABIERTO**. Bloquear
 *    ahí frenaría cualquier push desde un directorio que el hook no entiende.
 *
 * Y el límite que ninguno de estos tapa: esto es contención **LOCAL**, en la
 * misma máquina donde corre el agente. Fuerte, pero **no garantía** — tal como
 * la restricción 21 del discovery-report ya lo asume. La garantía sería del
 * lado del servidor, y en esta cuenta no está disponible.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// I/O (mismo patrón que block-no-verify.mjs)
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
    `BLOQUEADO: mergear el PR y pushear a la rama por defecto son actos del Operador.\n` +
      `\n` +
      `Razon: ${razon}\n` +
      `Comando: ${cmd}\n` +
      (detalle ? `${detalle}\n` : '') +
      `\n` +
      `Que significa este bloqueo y que NO significa:\n` +
      `esto es contencion LOCAL, en la misma maquina donde corres. Es fuerte\n` +
      `pero NO es garantia: branch protection —que si lo seria— no esta\n` +
      `disponible en el plan de GitHub de la cuenta. No leas el verde de este\n` +
      `hook como "no hay forma de mergear sin permiso" (SPEC-0223 P7, ADR-011).\n` +
      `\n` +
      `Que hacer en cambio: pushea tu rama de trabajo y abri el PR con\n` +
      `\`gh pr create\` — eso NO esta bloqueado. El merge lo hace el Operador.\n` +
      `Si de verdad hace falta mergear desde aca, pediselo y declaralo como\n` +
      `desviacion, sin afirmar despues que el freno se respeto.\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Tokenizer: lee lo mismo que ejecutaria bash.
// Copiado de block-destructive-outside-worktree.mjs, con el fix de TKT-0327
// (el backslash dentro de comillas dobles NO es escape universal). Se duplica a
// proposito: `install.mjs` copia UN archivo por hook, asi que un hook que
// importara de otro llegaria roto a `~/.claude/hooks/` — y un fallo de import
// es fail-OPEN silencioso.
// ---------------------------------------------------------------------------

const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);

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

// ---------------------------------------------------------------------------
// Heredocs: el cuerpo es DATO (el mensaje del commit / el body del PR), no
// argumentos. Mismo criterio y misma implementacion que block-no-verify.mjs.
// ---------------------------------------------------------------------------

const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

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

// ---------------------------------------------------------------------------
// La rama por defecto — ver la seccion del encabezado. Conjunto literal.
// ---------------------------------------------------------------------------

export const RAMAS_POR_DEFECTO = new Set(['master', 'main']);

/** Normaliza `refs/heads/master`, `+master`, `origin/master` → `master`. */
function nombreDeRama(ref) {
  let r = String(ref);
  if (r.startsWith('+')) r = r.slice(1);
  r = r.replace(/^refs\/heads\//, '');
  return r;
}

function esRamaPorDefecto(ref) {
  return RAMAS_POR_DEFECTO.has(nombreDeRama(ref));
}

/**
 * Destino de un refspec de push. `origen:destino` → destino; un refspec pelado
 * empuja a la rama del mismo nombre. `:destino` es un borrado, y su destino
 * sigue siendo el destino.
 */
function destinoDeRefspec(refspec) {
  const idx = refspec.indexOf(':');
  return idx === -1 ? refspec : refspec.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Analisis
// ---------------------------------------------------------------------------

/** Flags de `git push` que consumen un valor aparte. */
const PUSH_VALUE_FLAGS = new Set([
  '--repo',
  '--receive-pack',
  '--exec',
  '--push-option',
  '-o',
  '--force-with-lease',
  '--recurse-submodules',
  '--signed',
]);

/** Flags de `git` ANTES del subcomando que consumen un valor aparte. */
const GIT_PRE_VALUE_FLAGS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '-c', '--config-env']);

/**
 * Analiza un argv que empieza con `git`.
 * `ramaActual` es una funcion perezosa: solo se invoca si el push no trae
 * refspec, para no pagar un spawn en cada `git push` de la sesion.
 */
export function analizarGit(argv, ramaActual) {
  let i = 1;
  let sub = null;
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (GIT_PRE_VALUE_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    sub = t;
    break;
  }
  if (sub !== 'push') return null;

  const rest = argv.slice(i + 1);

  // Operandos posicionales del push: el primero es el remoto, los siguientes
  // son refspecs. `--` corta: lo que sigue no son opciones, pero si operandos.
  const operandos = [];
  let soloOperandos = false;
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (!soloOperandos) {
      if (t === '--') {
        soloOperandos = true;
        continue;
      }
      if (PUSH_VALUE_FLAGS.has(t)) {
        j++; // el valor no es un refspec
        continue;
      }
      if (t.startsWith('-')) continue; // flag suelto (--force, --delete, -f, --tags…)
    }
    operandos.push(t);
  }

  const refspecs = operandos.slice(1); // el primero es el remoto

  if (refspecs.length > 0) {
    for (const spec of refspecs) {
      const destino = destinoDeRefspec(spec);
      if (esRamaPorDefecto(destino)) {
        return {
          razon: `push cuyo destino resuelve a la rama por defecto (${nombreDeRama(destino)})`,
          detalle:
            spec === destino
              ? null
              : `El refspec \`${spec}\` empuja a \`${nombreDeRama(destino)}\`.`,
        };
      }
    }
    return null;
  }

  // Sin refspec: el destino es la rama actual (push.default = simple/current).
  const rama = ramaActual ? ramaActual() : null;
  if (rama === null) {
    // Falla-ABIERTO declarado: no se pudo resolver la rama del cwd.
    return null;
  }
  if (esRamaPorDefecto(rama)) {
    return {
      razon: `push sin refspec parado en la rama por defecto (${rama})`,
      detalle: `\`git push\` sin refspec empuja la rama actual, que es \`${rama}\`.`,
    };
  }
  return null;
}

const GH_API_PUT = /^(--method=|-X)?PUT$/i;

/** Analiza un argv que empieza con `gh`. */
export function analizarGh(argv) {
  // Primer operando no-flag despues de `gh`: el grupo de comandos.
  let i = 1;
  for (; i < argv.length; i++) {
    if (!argv[i].startsWith('-')) break;
  }
  const grupo = argv[i];

  if (grupo === 'pr') {
    // Primer operando no-flag despues de `pr`: el subcomando.
    let j = i + 1;
    for (; j < argv.length; j++) {
      if (!argv[j].startsWith('-')) break;
    }
    if (argv[j] === 'merge') {
      return {
        razon: 'merge de PR con `gh pr merge`',
        detalle: 'El merge del PR lo hace el Operador, no el agente que lo abrio.',
      };
    }
    return null;
  }

  if (grupo === 'api') {
    const rest = argv.slice(i + 1);
    let esPut = false;
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j];
      if (t === '--method' || t === '-X') {
        if (/^PUT$/i.test(rest[j + 1] || '')) esPut = true;
        j++;
        continue;
      }
      if (GH_API_PUT.test(t)) esPut = true; // --method=PUT, -XPUT
    }
    if (!esPut) return null;

    // Ruta que termina en /merge (con o sin query).
    const esRutaDeMerge = rest.some(
      (t) => !t.startsWith('-') && /\/merge(\?|$)/.test(t),
    );
    if (esRutaDeMerge) {
      return {
        razon: 'merge de PR por API (`gh api` con method PUT sobre .../merge)',
        detalle: 'Es la forma equivalente a `gh pr merge`, y vale lo mismo.',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Resuelve la rama actual del repo del cwd. `null` si no se puede (fail-OPEN). */
function resolverRamaActual(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    const rama = (r.stdout || '').trim();
    return rama && rama !== 'HEAD' ? rama : null;
  } catch {
    return null;
  }
}

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

  // Fast path: sin `git` ni `gh` no hay nada que mirar.
  if (!/\b(git|gh)\b/.test(cmd)) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const ramaActual = () => resolverRamaActual(cwd);

  const comandos = stripHeredocBodies(cmd);
  const segments = comandos.split(/&&|\|\||;|\n|\|/);

  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (tokens.length === 0) continue;

    // saltear asignaciones de env al inicio (VAR=val)
    let k = 0;
    while (k < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k])) k++;
    const argv = tokens.slice(k);
    if (argv.length === 0) continue;

    const hallazgo =
      argv[0] === 'git'
        ? analizarGit(argv, ramaActual)
        : argv[0] === 'gh'
          ? analizarGh(argv)
          : null;

    if (hallazgo) block(hallazgo.razon, cmd, hallazgo.detalle);
  }

  process.exit(0);
}

// El archivo se importa desde los tests para probar las funciones puras;
// `main()` solo corre como proceso.
if (process.argv[1] && process.argv[1].endsWith('block-merge-and-default-branch-push.mjs')) {
  main();
}
