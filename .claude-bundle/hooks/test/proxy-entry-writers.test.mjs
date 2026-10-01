// SPEC-0237 P4 (T4.1, T4.2) — todo camino que ESCRIBE la entrada `specoe` deja la forma del proxy
// cuando el room lo trae, y la SSE de antes cuando no. `node --test`.
//
// QUE FIJA ESTA SUITE (ADR-005, risk_flags de P4)
//
//   1. Los cuatro caminos —setup.sh --room-only sobre una carpeta sin .mcp.json y sobre una entrada
//      SSE, el hook de licencia con validate 200 (refresco y restitucion) y el --install-entry del
//      propio proxy— dejan la MISMA entrada: la que arma el proxy, sin url, headers, env ni nada con
//      forma de JWT, y con los demas servers intactos.
//   2. En modo proxy el hook NO exporta SPECOE_SKILL_JWT a CLAUDE_ENV_FILE.
//   3. Un room sin el proxy, o con un archivo que no tiene el sha de su MANIFEST, conserva la SSE con
//      el JWT del cache (room atrasado, F20), y el log del hook nombra el motivo.
//   4. Retiro y restitucion: con validate 403 y sin cache de gracia el hook retira specoe; la corrida
//      siguiente con validate 200 lo restituye con la forma del proxy.
//   5. setup.sh corta con err ANTES de escribir el .mcp.json si falta vendor/specoe-mcp-proxy.mjs, y
//      sobre una entrada que ya es la del proxy no cambia el archivo.
//
// La forma canonica NO se copia aca: se le pide al proxy vendorizado (su --install-entry sobre una
// carpeta vacia) y todo camino se compara contra eso. Los E2E corren con room y HOME temporales.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';

import {
  STARTER_DIR,
  VENDOR_PROXY,
  LICENSE_CHECK,
  JWT_SHAPE,
  USE_SYSTEM_CA_SKIP,
  jwt,
  makeFixture,
  installProxy,
  writeCache,
  writeMcp,
  readMcp,
  licenseLog,
  canonicalEntry,
  cleanEnv,
  runNode,
  startHub,
} from './helpers/proxy-room.mjs';

const OTRO_SERVER = { command: 'node', args: ['otro-server.mjs'], env: { OTRO: '1' } };

function sseEntry(token) {
  return {
    type: 'sse',
    url: 'https://mcp.integra.local/sse',
    headers: { Authorization: `Bearer ${token}` },
  };
}

/** La entrada specoe es la canonica y no trae nada que la del proxy no lleve. */
async function assertCanonica(entry, donde) {
  assert.deepEqual(entry, await canonicalEntry(), `${donde}: la entrada no es la del proxy`);
  for (const k of ['url', 'headers', 'env'])
    assert.equal(entry[k], undefined, `${donde}: la entrada del proxy no lleva ${k}`);
  assert.doesNotMatch(JSON.stringify(entry), JWT_SHAPE, `${donde}: hay un JWT en la entrada`);
}

async function runLicenseCheck({ room, home, hubUrl, envFile = null }) {
  return runNode(LICENSE_CHECK, [], {
    env: cleanEnv({
      CLAUDE_PROJECT_DIR: room,
      CLAUDE_HOME: home,
      HOME: home,
      USERPROFILE: home,
      INTEGRA_SECRETS_NO_KEYRING: '1',
      INTEGRA_HUB_URL: hubUrl,
      SPECOE_LICENSE_KEY: 'LIC-TEST-0237',
      // En Windows el fingerprint se lleva casi todo el presupuesto real; aca no se mide presupuesto.
      SPECOE_LICENSE_TIMEOUT_MS: '30000',
      ...(envFile ? { CLAUDE_ENV_FILE: envFile } : {}),
    }),
  });
}

// ---------- setup.sh --room-only ----------

/** El bash con el que corre setup.sh: el de Git en Windows (el de System32 es el lanzador de WSL). */
function findBash() {
  if (process.platform === 'win32') {
    for (const p of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  return spawnSync('bash', ['-c', 'exit 0']).status === 0 ? 'bash' : null;
}

const BASH = findBash();
const [MAJOR, MINOR] = process.versions.node.split('.').map(Number);
const SETUP_SKIP = !BASH
  ? 'no hay bash para correr setup.sh'
  : MAJOR === 23 || MAJOR > 26 || MAJOR < 22 || (MAJOR === 22 && MINOR < 19)
    ? `setup.sh corta con Node ${process.version}, fuera del rango certificado del starter`
    : USE_SYSTEM_CA_SKIP;

/** Una carpeta de room como la deja specoe-add-room.sh antes del --room-only. */
function setupRoom(name, { proxy = 'ok' } = {}) {
  const fx = makeFixture(name);
  for (const f of ['setup.sh', 'specoe-yaml.sh', 'project.config.yaml'])
    fs.copyFileSync(path.join(STARTER_DIR, f), path.join(fx.room, f));
  fs.writeFileSync(
    path.join(fx.room, 'project.config.local.yaml'),
    [
      'specoe:',
      "  role: 'CC_DEV'",
      'project:',
      "  name: 'Cliente P4'",
      "  vendor: 'ACME SA'",
      'paths:',
      "  workspace-root: '/tmp/ws-p4'",
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(fx.room, 'vendor'), { recursive: true });
  // setup.sh solo verifica que el bundle del MCP del Hub este: no lo ejecuta.
  fs.writeFileSync(path.join(fx.room, 'vendor', 'integra-hub-mcp.mjs'), '// stub\n');
  if (proxy === 'ok') installProxy(fx.room, 'ok');
  return fx;
}

function runSetup({ room, home }) {
  return new Promise((resolve) => {
    execFile(
      BASH,
      ['setup.sh', '--room-only'],
      {
        cwd: room,
        env: cleanEnv({ HOME: home, USERPROFILE: home }),
        timeout: 120000,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });
}

test(
  '1. setup.sh --room-only sin .mcp.json: la entrada del proxy y la de integra-hub de hoy',
  { skip: SETUP_SKIP },
  async () => {
    const fx = setupRoom('alta');
    const r = await runSetup(fx);
    assert.equal(r.code, 0, `setup.sh tenia que terminar bien.\n${r.stdout}\n${r.stderr}`);
    const doc = readMcp(fx.room);
    await assertCanonica(doc.mcpServers.specoe, 'setup.sh (alta)');
    assert.deepEqual(doc.mcpServers['integra-hub'], {
      command: 'node',
      args: ['--use-system-ca', 'vendor/integra-hub-mcp.mjs'],
      env: {
        INTEGRA_HUB_API_URL: 'https://hub.integra.local/api/v1',
        INTEGRA_SDD_IDENTITY_MODE: 'USER',
      },
    });
    assert.match(r.stdout, /\[CREATE\]\s+mcpServers\.specoe/);
  },
);

test(
  '2. setup.sh --room-only sobre specoe SSE: la migra al proxy y no toca los demas servers',
  { skip: SETUP_SKIP },
  async () => {
    const fx = setupRoom('migra');
    writeMcp(fx.room, {
      mcpServers: { specoe: sseEntry(jwt({ sddRole: 'CC_DEV' })), otro: OTRO_SERVER },
    });
    const r = await runSetup(fx);
    assert.equal(r.code, 0, `setup.sh tenia que terminar bien.\n${r.stdout}\n${r.stderr}`);
    const doc = readMcp(fx.room);
    await assertCanonica(doc.mcpServers.specoe, 'setup.sh (migracion)');
    assert.deepEqual(doc.mcpServers.otro, OTRO_SERVER, 'un server ajeno no se toca');
    assert.match(r.stdout, /\[MIGRATE\]\s+mcpServers\.specoe/);
  },
);

test(
  '3. setup.sh --room-only sobre la entrada del proxy: el .mcp.json no cambia',
  { skip: SETUP_SKIP },
  async () => {
    const fx = setupRoom('idempotente');
    assert.equal((await runSetup(fx)).code, 0);
    const antes = fs.readFileSync(path.join(fx.room, '.mcp.json'));
    const r = await runSetup(fx);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(fs.readFileSync(path.join(fx.room, '.mcp.json')).equals(antes), 'el archivo cambio');
    assert.match(r.stdout, /\[SKIP\]\s+mcpServers\.specoe \(ya lanza el proxy\)/);
  },
);

test(
  '4. setup.sh --room-only sin vendor/specoe-mcp-proxy.mjs: corta con err antes de escribir el .mcp.json',
  { skip: SETUP_SKIP },
  async () => {
    const fx = setupRoom('sin-proxy', { proxy: 'none' });
    const r = await runSetup(fx);
    assert.notEqual(r.code, 0, 'sin el proxy setup.sh no puede terminar bien');
    assert.match(r.stderr, /Falta el proxy del MCP specoe/);
    assert.equal(
      fs.existsSync(path.join(fx.room, '.mcp.json')),
      false,
      'escribio el .mcp.json igual',
    );
  },
);

// ---------- el hook de licencia ----------

test(
  '5. hook de licencia, room con el proxy y validate 200: entrada del proxy y SIN SPECOE_SKILL_JWT',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const hub = await startHub();
    const fx = makeFixture('hook-proxy');
    installProxy(fx.room, 'ok');
    writeMcp(fx.room, {
      mcpServers: { specoe: sseEntry(jwt({ sddRole: 'CC_DEV' })), otro: OTRO_SERVER },
    });
    const envFile = path.join(fx.root, 'claude-env');
    fs.writeFileSync(envFile, '');
    try {
      const r = await runLicenseCheck({ ...fx, hubUrl: hub.url, envFile });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(hub.validate.length, 1, 'tenia que validar una vez');
      const doc = readMcp(fx.room);
      await assertCanonica(doc.mcpServers.specoe, 'hook (refresco)');
      assert.deepEqual(doc.mcpServers.otro, OTRO_SERVER);
      assert.doesNotMatch(fs.readFileSync(envFile, 'utf8'), /SPECOE_SKILL_JWT/);
      // El JWT queda en el cache —de ahi lo toma el proxy— y en ningun lado del .mcp.json.
      const cache = JSON.parse(
        fs.readFileSync(path.join(fx.room, '.claude', 'specoe-license-cache.json'), 'utf8'),
      );
      assert.equal(cache.token, hub.validate[0].token);
      assert.ok(!fs.readFileSync(path.join(fx.room, '.mcp.json'), 'utf8').includes(cache.token));
    } finally {
      await hub.close();
    }
  },
);

for (const estado of ['sin-archivo', 'sha-distinto', 'sin-componente']) {
  test(`6. room atrasado (${estado}): la entrada sigue SSE con el JWT del cache y el log nombra el motivo`, async () => {
    const hub = await startHub();
    const fx = makeFixture(`atrasado-${estado}`);
    installProxy(fx.room, estado);
    const envFile = path.join(fx.root, 'claude-env');
    fs.writeFileSync(envFile, '');
    try {
      const r = await runLicenseCheck({ ...fx, hubUrl: hub.url, envFile });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const token = hub.validate[0].token;
      assert.deepEqual(readMcp(fx.room).mcpServers.specoe, sseEntry(token));
      // Como hoy: con la SSE el JWT tambien va a CLAUDE_ENV_FILE.
      assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp(`SPECOE_SKILL_JWT=${token}`));
      const log = licenseLog(fx.home);
      assert.match(log, /el room no trae el proxy que declara su MANIFEST/);
      assert.ok(
        log.includes(`"motivo":"${estado}"`),
        `el log tenia que nombrar ${estado}:\n${log}`,
      );
    } finally {
      await hub.close();
    }
  });
}

test(
  '7. retiro y restitucion: validate 403 sin gracia retira specoe; validate 200 lo restituye con la forma del proxy',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const hub = await startHub({ statuses: [403, 200] });
    const fx = makeFixture('retiro');
    installProxy(fx.room, 'ok');
    writeMcp(fx.room, { mcpServers: { specoe: await canonicalEntry(), otro: OTRO_SERVER } });
    try {
      const r1 = await runLicenseCheck({ ...fx, hubUrl: hub.url });
      assert.notEqual(r1.code, 0, 'sin cache de gracia el arranque se bloquea');
      const retirado = readMcp(fx.room);
      assert.equal(retirado.mcpServers.specoe, undefined, 'sin JWT usable specoe se retira');
      assert.deepEqual(retirado.mcpServers.otro, OTRO_SERVER);

      const r2 = await runLicenseCheck({ ...fx, hubUrl: hub.url });
      assert.equal(r2.code, 0, `${r2.stdout}\n${r2.stderr}`);
      const restituido = readMcp(fx.room);
      await assertCanonica(restituido.mcpServers.specoe, 'hook (restitucion)');
      assert.deepEqual(restituido.mcpServers.otro, OTRO_SERVER);
    } finally {
      await hub.close();
    }
  },
);

// ---------- el --install-entry del proxy ----------

test(
  '8. --install-entry del proxy vendorizado sobre una entrada SSE: la misma entrada que los otros caminos',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const fx = makeFixture('install-entry');
    installProxy(fx.room, 'ok');
    writeMcp(fx.room, {
      mcpServers: { otro: OTRO_SERVER, specoe: sseEntry(jwt({ sddRole: 'CC_DEV' })) },
    });
    const r = await runNode(VENDOR_PROXY, ['--install-entry', '--room', fx.room], {
      env: cleanEnv(),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const doc = readMcp(fx.room);
    await assertCanonica(doc.mcpServers.specoe, '--install-entry');
    assert.deepEqual(doc.mcpServers.otro, OTRO_SERVER);
    // Y la canonica es la que declara el ADR-005: stdio, node, el proxy del room.
    const canonica = await canonicalEntry();
    assert.equal(canonica.type, 'stdio');
    assert.ok(canonica.args.includes('vendor/specoe-mcp-proxy.mjs'));
  },
);
