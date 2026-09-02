#!/usr/bin/env node
/**
 * hooks-audit.mjs — TKT-0325, traído a la fuente canónica por TKT-0362
 *
 * Hook `SessionStart`. Al arrancar una sesión compara los hooks que DEBERÍAN
 * estar corriendo en esta máquina contra los que efectivamente están, y avisa
 * cuál de las tres formas de fantasma aplica.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * Un hook de Claude Code puede no correr por tres motivos distintos, y los tres
 * se ven exactamente igual desde adentro de una sesión: no pasa nada.
 *
 *   1. Está versionado en `integra-hub/hooks/` y NUNCA se instaló acá.
 *   2. Está instalado pero quedó VIEJO respecto de lo declarado.
 *   3. Está instalado y al día pero NO está cableado en ningún `settings.json`.
 *
 * En los tres casos el hook figura en un PR, se lo cita en el trail como si
 * fuera un freno, y no frena nada. Es la misma enfermedad que TKT-0325 vino a
 * curar —una regla escrita sin nada que la haga cumplir— un piso más abajo: un
 * freno escrito, mergeado, y sin correr. El Operador lo puso como condición del
 * entregable: *"sin eso son dos hooks fantasma en vez de uno"*.
 *
 * Y no es hipotético. El 2026-09-01, TKT-0362 midió esta máquina: `block-no-verify.mjs`
 * llevaba 19 días versionado y nunca instalado (forma 1), y los otros dos estaban
 * instalados pero VIEJOS (forma 2) — uno anterior a TKT-0321 y el otro anterior a los
 * dos defectos que arregló TKT-0327, incluido un fail-OPEN. O sea: tres de tres,
 * corriendo o no corriendo sin que nada lo dijera.
 *
 * ── Contra qué compara: DOS canales, porque hay dos formas de recibir un hook ──
 *
 * Los hooks de `integra-hub/hooks/` llegan a una máquina por dos caminos que no
 * se cruzan, y auditar uno solo deja ciego al otro:
 *
 *   A. **Canal del Operador** — `node hooks/install.mjs` desde un clon de
 *      integra-hub, que copia a `~/.claude/hooks/` y escribe
 *      `~/.claude/hooks/integra-hooks-manifest.json` con `sha256`, `event` y
 *      `matcher` de cada hook.
 *
 *   B. **Canal del dev de un tenant** — `setup.sh` del starter de SPECOE, que
 *      copia los hooks vendorizados de `.claude-bundle/hooks/` al mismo
 *      `~/.claude/hooks/` y declara su procedencia en `<room>/vendor/MANIFEST.json`
 *      (entradas con `basePath: ".claude-bundle/hooks"`). El dev **no clona
 *      integra-hub**, así que nunca corre `install.mjs` y nunca tiene el
 *      manifiesto del canal A (TKT-0321).
 *
 * Auditar sólo el canal A —como hacía la primera versión de este hook, escrita
 * para el cc-dev-room— le diría a todo dev de tenant *"no hay manifiesto"* en
 * cada arranque, para siempre: un falso positivo permanente sobre una máquina
 * que puede tener los hooks perfectamente instalados.
 *
 * Si están los dos manifiestos, se auditan los dos y el canal A tiene
 * precedencia sobre el B para un mismo archivo: es el que declara `event` y
 * `matcher`, así que su diagnóstico de "no cableado" es más preciso.
 *
 * ── Dos cosas que este hook NO hace, a propósito ────────────────────────────
 *
 *  - **No bloquea nunca.** Es `SessionStart`: sale 0 siempre, incluso si algo
 *    revienta. Un auditor que impide arrancar una sesión por un problema de
 *    instalación es peor que el problema que reporta.
 *  - **No instala ni cablea nada.** Instalar es `node hooks/install.mjs` (canal A)
 *    o `setup.sh` (canal B); cablear el `settings.json` es del Operador desde
 *    TKT-0045. Un hook que se auto-instala al arrancar cambia la máquina sin que
 *    nadie lo haya pedido, y encima taparía el síntoma que tiene que reportar.
 *
 * ── Por qué NO está en el array `HOOKS` de install.mjs ──────────────────────
 *
 * Porque se auditaría a sí mismo. Si dependiera de estar instalado en
 * `~/.claude/hooks/` para correr, **el detector de fantasmas podría ser el primer
 * fantasma** — y no habría nadie un piso más arriba para decirlo. El criterio es
 * del autor original de TKT-0325 y se conserva entero: este archivo se invoca por
 * path del repo/room (`$CLAUDE_PROJECT_DIR`), no desde `~/.claude/hooks/`. Que su
 * fuente viva acá es lo que le da CI, review y una sola copia; de dónde se ejecuta
 * es otra decisión, y sigue siendo el checkout.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HOOKS_HOME = join(homedir(), '.claude', 'hooks');
const MANIFEST = join(HOOKS_HOME, 'integra-hooks-manifest.json');

/** Raíz del room/proyecto: la del env de Claude Code, o dos niveles arriba de este archivo. */
function roomRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Manifiesto del canal B (starter de SPECOE), hermano de `.claude-bundle/` en la raíz del room. */
export function vendorManifestPath(room) {
  return join(room, 'vendor', 'MANIFEST.json');
}

/** Todos los settings donde puede estar cableado un hook, sin inventar rutas. */
export function settingsCandidates(room) {
  const home = join(homedir(), '.claude');
  return [
    join(home, 'settings.json'),
    join(home, 'settings.local.json'),
    join(room, '.claude', 'settings.json'),
    join(room, '.claude', 'settings.local.json'),
  ];
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Prefijo de `basePath` que identifica una entrada del vendor MANIFEST como hook del bundle. */
const BUNDLE_HOOKS_BASEPATH = '.claude-bundle/hooks';

/**
 * Normaliza el `vendor/MANIFEST.json` del starter a la misma forma que el manifiesto
 * del canal A. Sólo las entradas cuyo `basePath` es la carpeta de hooks del bundle:
 * el mismo archivo declara además el `.vsix` del plugin y el MCP vendorizado, que no
 * son hooks y no se cablean en ningún `settings.json`.
 *
 * `event`/`matcher` quedan `undefined` a propósito: ese manifiesto no los declara, y
 * inventarlos haría que el arreglo sugerido mintiera. Sin ellos el diagnóstico de
 * "no cableado" sigue siendo correcto — sólo es menos específico.
 */
export function hooksDelVendorManifest(vendor) {
  // La clave es `components`. TKT-0362 la escribió primero como `artifacts` —inventada, no
  // leída del archivo— y el fixture del test repetía el mismo invento, así que los dos se
  // confirmaban entre ellos: contra el MANIFEST real la función devolvía [] con seis hooks
  // declarados adentro. El test de abajo se ancla al archivo del starter, no a un fixture.
  const componentes = Array.isArray(vendor && vendor.components) ? vendor.components : [];
  return componentes
    .filter((a) => a && a.basePath === BUNDLE_HOOKS_BASEPATH && a.file)
    .map((a) => ({
      name: a.file,
      sha256: a.packageSha256,
      canal: 'starter',
    }));
}

/**
 * Diagnóstico de un hook del manifiesto. Devuelve `null` si está sano, o
 * `{nombre, problema, arreglo}` con la forma de fantasma que aplica.
 *
 * Nota sobre el cableado: se busca el NOMBRE DE ARCHIVO como substring del
 * settings crudo. Es a propósito más tosco que parsear el JSON y recorrer los
 * matchers — el comando puede venir con `$HOME`, con `cygpath`, envuelto en
 * powershell o con el path absoluto, y todas esas formas son cableados válidos.
 * Lo que no puede pasar es dar por cableado algo que no está: el nombre del
 * archivo tiene que aparecer en alguna parte, sí o sí.
 */
export function diagnosticar(
  hook,
  { hooksHome, settingsTextos, sourceDir, hay = existsSync, shaDe = sha256 },
) {
  const instalado = join(hooksHome, hook.name);
  const instalar =
    hook.canal === 'starter' ? 'volver a correr setup.sh del room' : 'node hooks/install.mjs';

  if (!hay(instalado)) {
    return {
      nombre: hook.name,
      problema: 'declarado en el manifiesto pero NO está instalado',
      arreglo: instalar,
    };
  }

  const shaReal = shaDe(instalado);
  if (hook.sha256 && shaReal !== hook.sha256) {
    return {
      nombre: hook.name,
      problema: `instalado pero NO coincide con el manifiesto (${hook.sha256.slice(0, 8)} vs ${shaReal.slice(0, 8)})`,
      arreglo: instalar,
    };
  }

  // ¿El repo de origen tiene una versión más nueva? Sólo si ese checkout sigue
  // existiendo: es una comodidad, no una condición. El canal B no lo declara —
  // el dev no tiene el repo de origen.
  if (sourceDir) {
    const enRepo = join(sourceDir, hook.name);
    if (hay(enRepo)) {
      const shaRepo = shaDe(enRepo);
      if (shaRepo !== shaReal) {
        return {
          nombre: hook.name,
          problema: `corre una versión VIEJA: el repo tiene otra (${shaReal.slice(0, 8)} vs ${shaRepo.slice(0, 8)})`,
          arreglo: instalar,
        };
      }
    }
  }

  const cableado = settingsTextos.some((txt) => txt.includes(hook.name));
  if (!cableado) {
    return {
      nombre: hook.name,
      problema: `instalado y al día pero NO cableado en ningún settings.json — no corre`,
      // El matcher NO se inventa: `SessionStart` no lleva ninguno, y sugerir
      // "matcher Bash" para un evento que no lo acepta manda a escribir un
      // cableado inválido. Lo midió el e2e de TKT-0362 sobre el propio auditor.
      arreglo: hook.event
        ? `agregar ${hook.event}${hook.matcher ? ` matcher ${hook.matcher}` : ''} en settings.json`
        : `cablearlo en el settings.json del room`,
    };
  }

  return null;
}

/**
 * Une los hooks de los dos canales por nombre de archivo. El canal A (install.mjs)
 * gana sobre el B para un mismo archivo: es el único que declara `event`/`matcher`.
 */
export function unirCanales(hooksInstall, hooksStarter) {
  const porNombre = new Map();
  for (const h of hooksStarter) porNombre.set(h.name, h);
  for (const h of hooksInstall) porNombre.set(h.name, h);
  return [...porNombre.values()];
}

/** Devuelve las líneas del reporte. Vacío nunca: siempre dice algo, aunque sea el OK. */
export function auditar({
  manifestPath,
  vendorPath,
  hooksHome,
  room,
  leer = readFileSync,
  hay = existsSync,
  shaDe = sha256,
}) {
  const leerJson = (p) => {
    try {
      return { ok: true, valor: JSON.parse(leer(p, 'utf8')) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const hayInstall = hay(manifestPath);
  const hayVendor = Boolean(vendorPath) && hay(vendorPath);

  if (!hayInstall && !hayVendor) {
    return [
      '[hooks-audit] NO hay manifiesto de hooks en esta máquina.',
      '  Los hooks de integra-hub (verificación de claims al Hub, destructivos fuera',
      '  del worktree, salteo de hooks de git) no se instalaron nunca, o se instalaron',
      '  con un install.mjs previo a TKT-0325. Ninguno está garantizado corriendo.',
      '  Arreglo: node hooks/install.mjs desde el repo integra-hub, o setup.sh del room.',
    ];
  }

  let hooksInstall = [];
  let source;
  if (hayInstall) {
    const r = leerJson(manifestPath);
    if (!r.ok) return [`[hooks-audit] el manifiesto existe pero no se pudo leer: ${r.error}`];
    hooksInstall = Array.isArray(r.valor.hooks) ? r.valor.hooks : [];
    source = r.valor.source;
  }

  let hooksStarter = [];
  if (hayVendor) {
    const r = leerJson(vendorPath);
    // Un vendor MANIFEST ilegible NO tumba la auditoría del canal A: se reporta y se sigue.
    if (r.ok) hooksStarter = hooksDelVendorManifest(r.valor);
    else if (!hayInstall)
      return [`[hooks-audit] el vendor/MANIFEST.json existe pero no se pudo leer: ${r.error}`];
  }

  const hooks = unirCanales(hooksInstall, hooksStarter);
  if (hooks.length === 0) {
    return ['[hooks-audit] el manifiesto no declara ningún hook — nada garantizado corriendo.'];
  }

  const settingsTextos = settingsCandidates(room)
    .filter((p) => hay(p))
    .map((p) => {
      try {
        return leer(p, 'utf8');
      } catch {
        return '';
      }
    });

  const hallazgos = hooks
    .map((h) =>
      diagnosticar(h, {
        hooksHome,
        settingsTextos,
        sourceDir: source,
        hay,
        shaDe,
      }),
    )
    .filter(Boolean);

  if (hallazgos.length === 0) {
    return [
      `[hooks-audit] ${hooks.length}/${hooks.length} hooks de integra-hub instalados, al día y cableados.`,
    ];
  }

  return [
    `[hooks-audit] ${hallazgos.length} de ${hooks.length} hooks de integra-hub NO están frenando nada:`,
    ...hallazgos.map((h) => `  - ${h.nombre}: ${h.problema}`),
    `  Arreglo: ${[...new Set(hallazgos.map((h) => h.arreglo))].join(' · ')}`,
    '  Hasta entonces, no cites esos hooks como si fueran un freno (TKT-0325).',
  ];
}

function main() {
  try {
    const room = roomRoot();
    const lineas = auditar({
      manifestPath: MANIFEST,
      vendorPath: vendorManifestPath(room),
      hooksHome: HOOKS_HOME,
      room,
    });
    process.stdout.write(lineas.join('\n') + '\n');
  } catch (e) {
    // Fail-safe: el auditor nunca impide arrancar la sesión.
    process.stdout.write(`[hooks-audit] no se pudo auditar: ${e && e.message ? e.message : e}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('hooks-audit.mjs')) {
  main();
}
