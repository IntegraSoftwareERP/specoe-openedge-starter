/**
 * TKT-0448 — la config PROPIA del room vive en project.config.local.yaml y gana sobre el versionado.
 *
 * La regla es la misma en los tres lectores de este yaml (specoe_room_get del bundle de bash, este
 * lado de los hooks y el plugin de VSCode): si el local DECLARA la clave, gana —aunque este vacia,
 * que es una declaracion—; si no la declara, vale la de project.config.yaml. Un room que todavia no
 * se migro no tiene local y se lee exactamente como antes.
 *
 * Los E2E corren el hook de arranque de verdad, con CLAUDE_PROJECT_DIR en un temporal y un cache
 * de licencia sin claim de rol, asi el hook corta antes de la red (mismo arnes que
 * repo-de-trabajo-del-room.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ROOM_LOCAL_CONFIG,
  WORK_REPO_PREFIX,
  pickRoomScalar,
  readRoomScalar,
  readRoomScalarWithSource,
} from '../specoe-room-bootstrap.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOM_BOOTSTRAP = path.join(HERE, '..', 'specoe-room-bootstrap.mjs');

const VERSIONADO = [
  "schema-version: '0.1.0'",
  'paths:',
  "  workspace-root: 'CAMBIAR-ME'",
  '  repos:',
  "    webservices: 'Webservices'",
  'hub:',
  "  api-url: 'https://hub.integra.local/api/v1'",
  'specoe:',
  "  role: '' # DISCOVERY | ENGINEERING | ADVERSARIAL | CC_DEV",
  "  work-repo: ''",
  '',
].join('\n');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt448-${name}-`));
}

// ---------- 1. la precedencia, pura ----------

test('1. el local DECLARA la clave: gana, y se nombra de donde salio', () => {
  const local = ['specoe:', "  role: 'CC_DEV'", ''].join('\n');
  assert.deepEqual(pickRoomScalar(local, VERSIONADO, 'specoe', 'role'), {
    value: 'CC_DEV',
    source: ROOM_LOCAL_CONFIG,
  });
});

test('2. declarada VACIA en el local tambien gana: es una declaracion, no una ausencia', () => {
  const local = ['specoe:', "  tenant: ''", ''].join('\n');
  const versionado = VERSIONADO.replace(
    "  work-repo: ''",
    "  work-repo: ''\n  tenant: 'alpha-corp'",
  );
  assert.deepEqual(pickRoomScalar(local, versionado, 'specoe', 'tenant'), {
    value: '',
    source: ROOM_LOCAL_CONFIG,
  });
});

test('3. el local NO la declara: vale el versionado', () => {
  const local = ['specoe:', "  role: 'CC_DEV'", ''].join('\n');
  assert.deepEqual(pickRoomScalar(local, VERSIONADO, 'hub', 'api-url'), {
    value: 'https://hub.integra.local/api/v1',
    source: 'project.config.yaml',
  });
});

test('4. transicion: sin local, el room se lee exactamente como antes', () => {
  assert.deepEqual(pickRoomScalar(undefined, VERSIONADO, 'paths', 'workspace-root'), {
    value: 'CAMBIAR-ME',
    source: 'project.config.yaml',
  });
});

test('5. nadie la declara: undefined, sin fuente', () => {
  assert.deepEqual(pickRoomScalar(undefined, VERSIONADO, 'specoe', 'tenant'), {
    value: undefined,
    source: null,
  });
});

test('6. la lectura sigue ANCLADA a la seccion: una clave homonima de otra seccion no gana', () => {
  const local = ['paths:', "  work-repo: 'C:/no/es/de/specoe'", ''].join('\n');
  assert.equal(
    pickRoomScalar(local, VERSIONADO, 'specoe', 'work-repo').source,
    'project.config.yaml',
  );
});

// ---------- 2. desde disco ----------

test('7. readRoomScalar lee los dos archivos del room y aplica la precedencia', async () => {
  const room = tmpDir('disco');
  fs.writeFileSync(path.join(room, 'project.config.yaml'), VERSIONADO);
  fs.writeFileSync(
    path.join(room, ROOM_LOCAL_CONFIG),
    ['hub:', "  api-url: 'https://hub.cliente.example/api/v1'", ''].join('\n'),
  );
  assert.equal(await readRoomScalar(room, 'hub', 'api-url'), 'https://hub.cliente.example/api/v1');
  assert.equal(await readRoomScalar(room, 'paths', 'workspace-root'), 'CAMBIAR-ME');
  assert.equal((await readRoomScalarWithSource(room, 'hub', 'api-url')).source, ROOM_LOCAL_CONFIG);
});

test('8. readRoomScalar nunca tira: carpeta sin ninguno de los dos archivos', async () => {
  assert.equal(await readRoomScalar(tmpDir('vacia'), 'specoe', 'role'), undefined);
});

// ---------- 3. E2E: el hook de arranque de verdad ----------

function tmpProject(name) {
  const dir = tmpDir(name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
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

async function runBootstrap(projectDir) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.INTEGRA_SDD_WORK_REPO;
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
    stdout = err.stdout ?? '';
  }
  // Mismo criterio que repo-de-trabajo-del-room.test.mjs: el JSON del hook es la ULTIMA linea.
  const last = String(stdout).trim().split('\n').filter(Boolean).pop();
  let json = null;
  try {
    json = last ? JSON.parse(last) : null;
  } catch {
    /* sin JSON: el assert de abajo lo dice */
  }
  return { context: json?.hookSpecificOutput?.additionalContext ?? '' };
}

test('9. E2E — room migrado: el repo de trabajo esta SOLO en el local y el hook lo declara', async () => {
  const repo = tmpDir('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  const project = tmpProject('migrado');
  fs.writeFileSync(path.join(project, 'project.config.yaml'), VERSIONADO);
  fs.writeFileSync(
    path.join(project, ROOM_LOCAL_CONFIG),
    ['specoe:', "  role: 'CC_DEV'", `  work-repo: '${repo.replace(/\\/g, '/')}'`, ''].join('\n'),
  );

  const { context } = await runBootstrap(project);
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:declarado`));
  assert.ok(context.includes(repo.replace(/\\/g, '/')), 'tiene que nombrar la ruta del local');
});

test('10. E2E — el local declara work-repo VACIO: gana sobre un residuo del versionado', async () => {
  const project = tmpProject('residuo');
  fs.writeFileSync(
    path.join(project, 'project.config.yaml'),
    VERSIONADO.replace("  work-repo: ''", "  work-repo: 'C:/residuo/viejo'"),
  );
  fs.writeFileSync(
    path.join(project, ROOM_LOCAL_CONFIG),
    ['specoe:', "  work-repo: ''", ''].join('\n'),
  );

  const { context } = await runBootstrap(project);
  assert.match(context, new RegExp(`${WORK_REPO_PREFIX}:sin-declarar`));
  assert.ok(
    !context.includes('C:/residuo/viejo'),
    'el residuo del versionado no tiene que aparecer',
  );
});
