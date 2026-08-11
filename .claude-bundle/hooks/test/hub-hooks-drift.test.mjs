/**
 * TKT-0321 — el chequeo de deriva de los hooks del Hub instalados en la máquina.
 *
 * ── Qué defecto congela ──────────────────────────────────────────────────────
 *
 * Los cuatro artefactos del Hub los instala la parte de MÁQUINA
 * (`specoe-setup-host.sh`) y la carpeta del room se actualiza por su lado
 * (`specoe-add-room.sh`). Dos canales, dos disparadores: una máquina puede
 * quedarse con hooks viejos por tiempo indefinido. Y un hook viejo no se cae ni
 * avisa — sigue corriendo, degradado.
 *
 * Ya pasó y está medido (2026-08-04, SPEC-0166 P4b): el `ack-task-enforcer.mjs`
 * desplegado era el de mayo más un parche local, sin el commit de TKT-0233, o
 * sea que el gate corría CIEGO a los tickets standalone. Nadie lo notó porque
 * el hook seguía funcionando para el caso que sí cubría. La única forma de
 * detectarlo fue comparar shas a mano, por máquina.
 *
 * ── Por qué el control negativo importa acá más que en otras suites ──────────
 *
 * Lo que se mide es una AUSENCIA de deriva. Un chequeo roto —que no encuentre
 * el MANIFEST, que lea mal el `basePath`, que compare contra la carpeta
 * equivocada— devuelve "todo al día" y se lee EXACTAMENTE igual que un estado
 * sano. Por eso cada caso que espera "sin deriva" tiene su gemelo que la
 * introduce y exige que el chequeo la vea.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const { checkHubHooksDrift } = await import('../specoe-license-check.mjs');

const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Arma un room (con su vendor/MANIFEST.json) y un ~/.claude con los artefactos instalados.
 * `instalado` mapea nombre de archivo → contenido en disco; `undefined` = no instalado.
 */
function armar({ contenidos, instalado, declararHubArtifacts = true }) {
  const root = mkdtempSync(join(tmpdir(), 'drift-'));
  const projectDir = join(root, 'room');
  const claudeHome = join(root, 'home', '.claude');
  mkdirSync(join(projectDir, 'vendor'), { recursive: true });
  mkdirSync(join(claudeHome, 'hooks'), { recursive: true });
  mkdirSync(join(claudeHome, 'commands'), { recursive: true });

  const components = [
    // El componente que YA existía: no tiene basePath y vive en vendor/. Tiene que quedar
    // afuera del chequeo — si entrara, buscaría el .vsix adentro de ~/.claude/hooks/ y
    // reportaría una deriva que no existe.
    {
      name: 'integra-hub-vscode',
      file: 'integra-hub-vscode.vsix',
      artifactKind: 'zip',
      packageSha256: sha('otra cosa'),
    },
  ];
  if (declararHubArtifacts) {
    for (const [file, contenido] of Object.entries(contenidos)) {
      components.push({
        name: file.replace(/\.\w+$/, ''),
        file,
        basePath: file.endsWith('.md') ? '.claude-bundle/commands' : '.claude-bundle/hooks',
        artifactKind: 'file',
        packageSha256: sha(contenido),
      });
    }
  }
  writeFileSync(
    join(projectDir, 'vendor', 'MANIFEST.json'),
    JSON.stringify({ components }, null, 2),
  );

  for (const [file, contenido] of Object.entries(instalado)) {
    const dir = file.endsWith('.md') ? 'commands' : 'hooks';
    writeFileSync(join(claudeHome, dir, file), contenido);
  }
  return { projectDir, claudeHome };
}

const CONTENIDOS = {
  'hub-channel.mjs': '// canal v2\n',
  'ack-task-enforcer.mjs': '// enforcer v2\n',
  'ack-task.md': '# /ack-task v2\n',
};

describe('la máquina al día', () => {
  test('todo instalado y con el sha declarado → sin deriva', async () => {
    const { projectDir, claudeHome } = armar({ contenidos: CONTENIDOS, instalado: CONTENIDOS });

    const r = await checkHubHooksDrift({ projectDir, claudeHome });

    assert.equal(r.checked, true, 'tiene que haber comparado: si no, el "sin deriva" no vale nada');
    assert.deepEqual(r.drifted, []);
  });

  test('el .vsix de vendor/ no entra al chequeo', async () => {
    // Sin este corte, un componente sin basePath se buscaría en ~/.claude/hooks/ y daría una
    // deriva permanente — un rojo permanente se apaga, y con él se apaga el chequeo entero.
    const { projectDir, claudeHome } = armar({ contenidos: CONTENIDOS, instalado: CONTENIDOS });

    const r = await checkHubHooksDrift({ projectDir, claudeHome });

    assert.equal(
      r.drifted.find((d) => d.file.endsWith('.vsix')),
      undefined,
    );
  });
});

describe('la máquina atrás — control negativo del chequeo', () => {
  test('un hook con contenido viejo se detecta y se nombra', async () => {
    const { projectDir, claudeHome } = armar({
      contenidos: CONTENIDOS,
      instalado: { ...CONTENIDOS, 'ack-task-enforcer.mjs': '// enforcer v1 (el de mayo)\n' },
    });

    const r = await checkHubHooksDrift({ projectDir, claudeHome });

    assert.equal(r.checked, true);
    assert.equal(r.drifted.length, 1);
    assert.equal(r.drifted[0].file, 'ack-task-enforcer.mjs');
    assert.match(r.drifted[0].motivo, /sha256 instalado \w+ != declarado \w+/);
  });

  test('un hook que NO está instalado se detecta como deriva, no como "al día"', async () => {
    // Es el estado de la máquina medida el 2026-08-11: los archivos no estaban. Confundirlo
    // con "al día" sería el verde falso exacto que este ticket persigue.
    const { 'hub-channel.mjs': _, ...sinCanal } = CONTENIDOS;
    const { projectDir, claudeHome } = armar({ contenidos: CONTENIDOS, instalado: sinCanal });

    const r = await checkHubHooksDrift({ projectDir, claudeHome });

    assert.equal(r.drifted.length, 1);
    assert.equal(r.drifted[0].file, 'hub-channel.mjs');
    assert.equal(r.drifted[0].motivo, 'no esta instalado');
  });

  test('el command también se compara, y contra ~/.claude/commands/', async () => {
    const { projectDir, claudeHome } = armar({
      contenidos: CONTENIDOS,
      instalado: { ...CONTENIDOS, 'ack-task.md': '# /ack-task v1\n' },
    });

    const r = await checkHubHooksDrift({ projectDir, claudeHome });

    assert.deepEqual(
      r.drifted.map((d) => d.file),
      ['ack-task.md'],
    );
  });
});

describe('cuándo NO hay con qué comparar (y por eso no se bloquea)', () => {
  test('carpeta que no es un room → checked:false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-'));

    const r = await checkHubHooksDrift({ projectDir: root, claudeHome: join(root, '.claude') });

    // Este hook corre en TODA sesión de la máquina: una carpeta cualquiera no puede quedar
    // bloqueada por un MANIFEST que nunca tuvo.
    assert.equal(r.checked, false);
    assert.deepEqual(r.drifted, []);
  });

  test('MANIFEST anterior al ticket (sin artefactos del Hub) → checked:false, NO "al día"', async () => {
    const { projectDir, claudeHome } = armar({
      contenidos: CONTENIDOS,
      instalado: {},
      declararHubArtifacts: false,
    });

    const r = await checkHubHooksDrift({ projectDir, claudeHome });

    // La distinción importa: con `checked:true` y cero derivas, un room viejo declararía
    // "máquina al día" sin haber mirado nada.
    assert.equal(r.checked, false);
  });
});
