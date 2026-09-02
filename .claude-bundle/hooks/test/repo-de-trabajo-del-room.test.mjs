// TKT-0317 — el room declara cual es su repo de trabajo. `node --test`.
//
// El hueco: el room sabe su rol y su tenant, pero no sabia donde vive el CODIGO. La carpeta del
// room ES un repo git —un clon shallow del starter con sparse-checkout— y las herramientas de
// aislamiento del harness operan sobre el repo del cwd, asi que apuntan a ese clon. Un dev que
// sigue el QUICKSTART al pie se choca con eso la primera vez que pide aislar trabajo de codigo.
//
// SPEC-0208 P5 — la declaracion paso de UNA ruta a N, bajo la MISMA clave y aceptando las dos
// formas del valor (escalar o lista). Lo que esta suite suma por eso:
//
//   4. El escalar sigue leyendose. NO es back-compat opcional: toda carpeta de room ya instalada
//      lo tiene asi y vive en la maquina de un dev, fuera de este repo. Por eso el texto del caso
//      de UNA ruta se compara contra el literal completo de antes del cambio: si alguien lo
//      reescribe, esta suite lo dice.
//   5. Con varias rutas, cada una tiene su propio veredicto y ninguna tapa a otra.
//
// Lo que esta suite fija:
//   1. El aviso discrimina los TRES estados (declarado / declarado-pero-no-esta / sin declarar) y
//      no pisa las otras anclas del hook. Un aviso que dice lo mismo siempre no informa nada.
//   2. La lectura del yaml esta ANCLADA a la seccion `specoe:` — `paths.repos` existe en el mismo
//      archivo y una lectura global lo agarraria (el defecto que cerro TKT-0256).
//   3. E2E: los tres estados salen del hook de verdad, y la env del launcher le gana al yaml.
//
// Los E2E corren el hook en un subproceso con CLAUDE_PROJECT_DIR en un temporal (ninguna corrida
// toca la instalacion real del dev) y con un JWT SIN claim sddRole a proposito: el hook corta en
// el camino `no-role` antes de tocar la red, asi que el escenario mide el aviso del repo de
// trabajo y no un timeout contra un server que no existe. Que salga por ESE camino ademas prueba
// lo que importa: el aviso viaja tambien cuando el room arranca sin contrato.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildAdditionalContext,
  buildWorkRepoNotice,
  parseWorkRepoValue,
  readSpecoeScalar,
  readSpecoeWorkRepos,
  WORK_REPO_PREFIX,
  WORK_REPO_SEPARATOR,
} from '../specoe-room-bootstrap.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOM_BOOTSTRAP = path.join(HERE, '..', 'specoe-room-bootstrap.mjs');
// Literales a proposito: si alguien renombra una de las anclas del hook, estos tests dejan de
// medir lo que dicen medir y hay que enterarse aca.
const SENTINEL = 'SPECOE-ROOM-CONTRACT';
const UNGOVERNED = 'SPECOE-ROOM-UNGOVERNED';

/** Azucar: la forma en que el hook arma las entradas que le pasa al aviso. */
const uno = (p, isRepo) => [{ path: p, isRepo }];

// ---------- helpers ----------

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt317-${name}-`));
}

function tmpProject(name) {
  const dir = tmpDir(name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  // JWT sin claim sddRole: el hook corta en `no-role` sin tocar la red.
  const body = Buffer.from(JSON.stringify({ tier: 'PRO' })).toString('base64url');
  fs.writeFileSync(
    path.join(dir, '.claude', 'specoe-license-cache.json'),
    JSON.stringify({
      licenseKey: 'k',
      validatedAt: new Date().toISOString(),
      token: `h.${body}.s`,
    }),
  );
  return dir;
}

/** Carpeta que parece un repo git para el chequeo del hook (existe `.git`). */
function tmpRepo(name) {
  const dir = tmpDir(name);
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

/** yaml minimo con la forma real del template: `paths.repos` ANTES de la seccion `specoe`. */
function writeYaml(projectDir, specoeBlock) {
  fs.writeFileSync(
    path.join(projectDir, 'project.config.yaml'),
    [
      "schema-version: '0.1.0'",
      'paths:',
      "  workspace-root: 'C:/Cliente/VSCode'",
      '  repos:',
      "    webservices: 'Webservices'",
      "    data: 'Integra.Data'",
      'specoe:',
      ...specoeBlock,
      'frontend:',
      '  enabled: false',
      '',
    ].join('\n'),
  );
}

async function runBootstrap(projectDir, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv };
  delete env.NODE_EXTRA_CA_CERTS;
  // El entorno del dev que corre la suite puede tener el room de SU maquina declarado: eso
  // convertiria el caso "sin declarar" en otro escenario. Se limpia salvo que el test la declare.
  if (!('INTEGRA_SDD_WORK_REPO' in extraEnv)) delete env.INTEGRA_SDD_WORK_REPO;
  let stdout = '';
  try {
    stdout = (
      await execFileAsync(process.execPath, [ROOM_BOOTSTRAP], {
        encoding: 'utf8',
        timeout: 60000,
        env,
      })
    ).stdout;
  } catch (err) {
    stdout = String(err?.stdout ?? '');
  }
  const last = stdout.trim().split('\n').filter(Boolean).pop();
  let json = null;
  try {
    json = last ? JSON.parse(last) : null;
  } catch {
    /* el assert de abajo lo nombra */
  }
  return { json, context: json?.hookSpecificOutput?.additionalContext ?? '', stdout };
}

// ---------- 1. el aviso, puro ----------

test('1. el aviso discrimina los tres estados y ninguno se confunde con el otro', () => {
  const declarado = buildWorkRepoNotice(uno('C:/Integra/VSCode/Webservices', true));
  const noExiste = buildWorkRepoNotice(uno('C:/Integra/VSCode/Webservices', false));
  const sinDeclarar = buildWorkRepoNotice([]);

  assert.match(declarado, new RegExp(`${WORK_REPO_PREFIX}:declarado`));
  assert.match(noExiste, new RegExp(`${WORK_REPO_PREFIX}:no-existe`));
  assert.match(sinDeclarar, new RegExp(`${WORK_REPO_PREFIX}:sin-declarar`));

  // Los marcadores son mutuamente excluyentes: sin esto, un probe que afirma ':declarado' pasaria
  // tambien sobre el texto de ':sin-declarar' y la suite no estaria midiendo nada.
  assert.ok(!noExiste.includes(`${WORK_REPO_PREFIX}:declarado`));
  assert.ok(!sinDeclarar.includes(`${WORK_REPO_PREFIX}:declarado`));
  assert.ok(!declarado.includes(`${WORK_REPO_PREFIX}:no-existe`));
});

test('2. el aviso del repo declarado dice la ruta Y como usarla', () => {
  const t = buildWorkRepoNotice(uno('C:/Integra/VSCode/Webservices', true));
  assert.match(t, /C:\/Integra\/VSCode\/Webservices/);
  // El punto del ticket: el agente tiene que saber que el cwd NO es el repo, o vuelve a mandar
  // el worktree al clon del starter aunque la ruta este declarada arriba.
  assert.match(t, /clon shallow del starter/);
  assert.match(t, /git -C 'C:\/Integra\/VSCode\/Webservices' worktree add/);
});

test('3. una declaracion que apunta a la nada NO se reporta como si estuviera', () => {
  // Un dato escrito y falso es peor que la ausencia: la ausencia al menos se nota.
  const t = buildWorkRepoNotice(uno('C:/no/existe', false));
  assert.match(t, /C:\/no\/existe/);
  assert.match(t, /NO hay un repo git/);
  assert.ok(!t.includes('worktree add'), 'no puede sugerir operar sobre una ruta que no esta');
});

test('4. el aviso no pisa las otras anclas del hook', () => {
  // Se CONCATENA al additionalContext: el sentinel y el ungoverned siguen siendo afirmables por
  // separado en el mismo texto, que es lo que miden los probes de T5.3 y de TKT-0225.
  const texto = buildAdditionalContext('CC_DEV', '# contrato') + buildWorkRepoNotice([]);
  assert.match(texto, new RegExp(`\\[\\[${SENTINEL}:CC_DEV\\]\\]`));
  assert.match(texto, new RegExp(`${WORK_REPO_PREFIX}:sin-declarar`));
  assert.ok(!WORK_REPO_PREFIX.includes(SENTINEL) && !SENTINEL.includes(WORK_REPO_PREFIX));
  assert.ok(!WORK_REPO_PREFIX.includes(UNGOVERNED) && !UNGOVERNED.includes(WORK_REPO_PREFIX));
});

// ---------- 2. la lectura del yaml, anclada ----------

test('5. readSpecoeScalar lee specoe.work-repo y no se come `paths.repos`', () => {
  const yaml = [
    'paths:',
    '  repos:',
    "    webservices: 'Webservices'",
    'specoe:',
    "  role: 'CC_DEV'",
    "  work-repo: 'C:/Integra/VSCode/Webservices' # comentario inline",
    '',
  ].join('\n');
  assert.equal(readSpecoeScalar(yaml, 'specoe', 'work-repo'), 'C:/Integra/VSCode/Webservices');
  assert.equal(readSpecoeScalar(yaml, 'specoe', 'role'), 'CC_DEV');
  // La clave vive bajo `specoe:`, no bajo `paths:`: pedirla ahi tiene que dar ausencia.
  assert.equal(readSpecoeScalar(yaml, 'paths', 'work-repo'), undefined);
});

test('6. clave ausente o vacia son ausencia, no un valor raro', () => {
  const sinClave = ['specoe:', "  role: 'CC_DEV'", ''].join('\n');
  assert.equal(readSpecoeScalar(sinClave, 'specoe', 'work-repo'), undefined);
  const vacia = ['specoe:', "  role: 'CC_DEV'", "  work-repo: ''", ''].join('\n');
  assert.equal(readSpecoeScalar(vacia, 'specoe', 'work-repo'), '');
});

// ---------- 3. E2E: el hook de verdad ----------

test('7. E2E — con specoe.work-repo apuntando a un repo real, el hook lo declara', async () => {
  const repo = tmpRepo('repo');
  const project = tmpProject('declarado');
  writeYaml(project, ["  role: 'CC_DEV'", `  work-repo: '${repo.replace(/\\/g, '/')}'`]);

  const { json, context } = await runBootstrap(project);
  assert.equal(json?.specoeRoomContractStatus, 'ungoverned', 'el escenario corta antes de la red');
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:declarado`));
  assert.ok(context.includes(repo.replace(/\\/g, '/')), 'tiene que nombrar la ruta declarada');
});

test('8. E2E — declarado pero sin repo ahi: lo dice, no lo tapa', async () => {
  const project = tmpProject('no-existe');
  const fantasma = path.join(os.tmpdir(), 'specoe-tkt317-no-existe-jamas').replace(/\\/g, '/');
  writeYaml(project, ["  role: 'CC_DEV'", `  work-repo: '${fantasma}'`]);

  const { context } = await runBootstrap(project);
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:no-existe`));
  assert.ok(context.includes(fantasma));
});

test('9. E2E — sin declarar (clave vacia y sin env), el room lo declara al arrancar', async () => {
  const project = tmpProject('sin-declarar');
  writeYaml(project, ["  role: 'CC_DEV'", "  work-repo: ''"]);

  const { context } = await runBootstrap(project);
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:sin-declarar`));
  // Y el arranque sigue siendo fail-open: esto es contexto, no un gate.
  assert.match(context, new RegExp(UNGOVERNED));
});

test('10. E2E — sin project.config.yaml tampoco se inventa un repo', async () => {
  const project = tmpProject('sin-yaml');
  const { context } = await runBootstrap(project);
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:sin-declarar`));
});

test('11. E2E — la env del launcher le gana al yaml', async () => {
  // INTEGRA_SDD_WORK_REPO es lo que exporta specoe-launch-thinclient.sh. Que gane importa: es el
  // unico canal que tiene una sesion abierta desde el launcher cuando el yaml quedo viejo.
  const repo = tmpRepo('env');
  const project = tmpProject('env-gana');
  writeYaml(project, ["  role: 'CC_DEV'", "  work-repo: 'C:/ruta/del/yaml'"]);

  const { context } = await runBootstrap(project, {
    INTEGRA_SDD_WORK_REPO: repo.replace(/\\/g, '/'),
  });
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:declarado`));
  assert.ok(context.includes(repo.replace(/\\/g, '/')));
  assert.ok(!context.includes('C:/ruta/del/yaml'), 'el yaml no puede ganarle a la env');
});

// ---------- 4. SPEC-0208 P5 — el escalar sigue valiendo ----------

test('12. parseWorkRepoValue acepta las DOS formas bajo la misma clave', () => {
  // Escalar: la forma que tiene HOY toda carpeta de room instalada.
  assert.deepEqual(parseWorkRepoValue('C:/Integra/VSCode/Webservices'), [
    'C:/Integra/VSCode/Webservices',
  ]);
  // Lista en flow, con y sin espacios, con comillas simples o dobles.
  assert.deepEqual(parseWorkRepoValue("['C:/a', 'C:/b']"), ['C:/a', 'C:/b']);
  assert.deepEqual(parseWorkRepoValue('["C:/a","C:/b"]'), ['C:/a', 'C:/b']);
  assert.deepEqual(parseWorkRepoValue('[C:/a, C:/b]'), ['C:/a', 'C:/b']);
  // Una sola ruta escrita como lista tambien vale: el lector no obliga a ninguna de las dos.
  assert.deepEqual(parseWorkRepoValue("['C:/a']"), ['C:/a']);
  // Ausencia en todas sus formas -> lista vacia, que es el caso `sin-declarar`.
  assert.deepEqual(parseWorkRepoValue(''), []);
  assert.deepEqual(parseWorkRepoValue('   '), []);
  assert.deepEqual(parseWorkRepoValue(null), []);
  assert.deepEqual(parseWorkRepoValue(undefined), []);
  assert.deepEqual(parseWorkRepoValue('[]'), []);
  // Una ruta con coma ADENTRO de las comillas no se parte: es legal en Windows.
  assert.deepEqual(parseWorkRepoValue("['C:/con,coma', 'C:/otro']"), ['C:/con,coma', 'C:/otro']);
});

test('13. readSpecoeWorkRepos lee escalar y lista del yaml, anclado a `specoe:`', () => {
  const conEscalar = [
    'paths:',
    '  repos:',
    "    webservices: 'Webservices'",
    'specoe:',
    "  work-repo: 'C:/Integra/VSCode/Webservices' # comentario inline",
    '',
  ].join('\n');
  assert.deepEqual(readSpecoeWorkRepos(conEscalar), ['C:/Integra/VSCode/Webservices']);

  const conLista = [
    'paths:',
    '  repos:',
    "    webservices: 'Webservices'",
    'specoe:',
    "  work-repo: ['C:/Integra/VSCode/Webservices', 'C:/Integra/integra-hub'] # inline",
    '',
  ].join('\n');
  assert.deepEqual(readSpecoeWorkRepos(conLista), [
    'C:/Integra/VSCode/Webservices',
    'C:/Integra/integra-hub',
  ]);

  const vacia = ['specoe:', "  work-repo: ''", ''].join('\n');
  assert.deepEqual(readSpecoeWorkRepos(vacia), []);
});

test('14. con UNA ruta el aviso es identico, byte a byte, al de antes de SPEC-0208 P5', () => {
  // Este literal es el texto que emitia el hook ANTES del cambio. No se genera con las mismas
  // piezas a proposito: si se armara desde el codigo nuevo, el test pasaria aunque el texto
  // cambiara y no probaria nada. Es la garantia de que un room ya instalado —clave escalar— no
  // note el cambio en su proximo arranque.
  const comun =
    'La carpeta de este room ES un repo git, pero NO es donde vive el codigo: es un clon shallow ' +
    'del starter. Las herramientas de aislamiento del harness (EnterWorktree y equivalentes) ' +
    'operan sobre el repo del cwd, asi que desde aca apuntan a ese clon.';
  const ruta = 'C:/Integra/VSCode/Webservices';

  const esperadoDeclarado =
    `\n\n[[${WORK_REPO_PREFIX}:declarado]] El repo de trabajo de este room es '${ruta}'. ${comun} ` +
    `Todo lo que sea codigo va contra ese repo, con git apuntado explicitamente: ` +
    `git -C '${ruta}' worktree add ... (y los commits/PR salen de ahi, no del cwd).`;
  assert.equal(buildWorkRepoNotice(uno(ruta, true)), esperadoDeclarado);

  const esperadoNoExiste =
    `\n\n[[${WORK_REPO_PREFIX}:no-existe]] Este room declara su repo de trabajo en '${ruta}' ` +
    `y ahi NO hay un repo git ahora mismo (no existe la ruta, o existe y no tiene .git). ${comun} ` +
    `No uses esa ruta a ciegas: verificala con el operador —puede faltar el clone, o la ` +
    `declaracion puede estar mal— y corregí 'specoe.work-repo' en el project.config.yaml.`;
  assert.equal(buildWorkRepoNotice(uno(ruta, false)), esperadoNoExiste);

  const esperadoSinDeclarar =
    `\n\n[[${WORK_REPO_PREFIX}:sin-declarar]] Este room NO declara su repo de trabajo. ${comun} ` +
    `Antes de tocar codigo, preguntá al operador cual es el repo y en que ruta local esta. ` +
    `Para que el room deje de preguntarlo en cada sesion: declaralo en 'specoe.work-repo' del ` +
    `project.config.yaml de esta carpeta (o reinstalá con ./specoe-add-room.sh <ROL> --work-repo <ruta>).`;
  assert.equal(buildWorkRepoNotice([]), esperadoSinDeclarar);
});

// ---------- 5. SPEC-0208 P5 — un veredicto por ruta, sin tapar ninguna ----------

test('15. con varias rutas validas el aviso las nombra a TODAS', () => {
  const t = buildWorkRepoNotice([
    { path: 'C:/Integra/VSCode/Webservices', isRepo: true },
    { path: 'C:/Integra/integra-hub', isRepo: true },
  ]);
  assert.match(t, new RegExp(`${WORK_REPO_PREFIX}:declarado`));
  assert.ok(t.includes('C:/Integra/VSCode/Webservices'));
  assert.ok(t.includes('C:/Integra/integra-hub'));
  // Y da el comando por CADA una: nombrarlas sin decir como usarlas deja al agente en la misma.
  assert.match(t, /git -C 'C:\/Integra\/VSCode\/Webservices' worktree add/);
  assert.match(t, /git -C 'C:\/Integra\/integra-hub' worktree add/);
  assert.ok(!t.includes(`${WORK_REPO_PREFIX}:no-existe`), 'ninguna esta rota: no va ese marcador');
});

test('16. lista MIXTA: la rota no tapa a la valida ni al reves', () => {
  // Es el caso que justifica toda la task: con el aviso viejo —un solo veredicto— la segunda
  // ruta decidia el texto entero y la primera desaparecia.
  const t = buildWorkRepoNotice([
    { path: 'C:/Integra/VSCode/Webservices', isRepo: true },
    { path: 'C:/no/existe/jamas', isRepo: false },
  ]);
  assert.match(t, new RegExp(`${WORK_REPO_PREFIX}:declarado`), 'la valida se declara');
  assert.match(t, new RegExp(`${WORK_REPO_PREFIX}:no-existe`), 'la rota se avisa');
  assert.ok(t.includes('C:/Integra/VSCode/Webservices'));
  assert.ok(t.includes('C:/no/existe/jamas'));
  // El comando sale SOLO para la que existe: sugerirlo sobre la rota seria mandar a operar sobre
  // una ruta que no esta.
  assert.match(t, /git -C 'C:\/Integra\/VSCode\/Webservices' worktree add/);
  assert.ok(!t.includes("git -C 'C:/no/existe/jamas'"));
});

test('17. varias rutas y NINGUNA valida: se avisan todas, sin declarar ninguna', () => {
  const t = buildWorkRepoNotice([
    { path: 'C:/no/existe/uno', isRepo: false },
    { path: 'C:/no/existe/dos', isRepo: false },
  ]);
  assert.match(t, new RegExp(`${WORK_REPO_PREFIX}:no-existe`));
  assert.ok(t.includes('C:/no/existe/uno') && t.includes('C:/no/existe/dos'));
  assert.ok(!t.includes(`${WORK_REPO_PREFIX}:declarado`), 'no hay ninguna para declarar');
  assert.ok(!t.includes('worktree add'), 'no puede sugerir operar sobre rutas que no estan');
});

test('18. E2E — el yaml con la clave como LISTA mixta nombra las DOS', async () => {
  const repo = tmpRepo('lista-ok');
  const fantasma = path.join(os.tmpdir(), 'specoe-spec0208-no-existe-jamas').replace(/\\/g, '/');
  const project = tmpProject('lista-mixta');
  writeYaml(project, [
    "  role: 'CC_DEV'",
    `  work-repo: ['${repo.replace(/\\/g, '/')}', '${fantasma}']`,
  ]);

  const { context } = await runBootstrap(project);
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:declarado`));
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:no-existe`));
  assert.ok(context.includes(repo.replace(/\\/g, '/')), 'nombra la valida');
  assert.ok(context.includes(fantasma), 'nombra la rota');
});

test('19. E2E — la env del launcher lleva N rutas con el separador declarado', async () => {
  // El separador es el contrato entre specoe-launch-thinclient.sh y este lector. Si los dos lados
  // no usan el MISMO, el room lee una sola ruta con basura adentro — y el aviso diria `no-existe`
  // sobre una ruta que si esta. Por eso se verifica en una corrida, no leyendo el codigo.
  assert.equal(WORK_REPO_SEPARATOR, '|');
  const repoA = tmpRepo('env-a');
  const repoB = tmpRepo('env-b');
  const project = tmpProject('env-lista');
  writeYaml(project, ["  role: 'CC_DEV'", "  work-repo: 'C:/ruta/del/yaml'"]);

  const { context } = await runBootstrap(project, {
    INTEGRA_SDD_WORK_REPO: [repoA, repoB]
      .map((r) => r.replace(/\\/g, '/'))
      .join(WORK_REPO_SEPARATOR),
  });
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:declarado`));
  assert.ok(context.includes(repoA.replace(/\\/g, '/')));
  assert.ok(context.includes(repoB.replace(/\\/g, '/')));
  assert.ok(!context.includes('C:/ruta/del/yaml'), 'la env sigue ganandole al yaml, entera');
});
