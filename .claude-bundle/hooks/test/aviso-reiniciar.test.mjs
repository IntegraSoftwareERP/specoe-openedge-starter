// SPEC-0237 P4 (T4.1, ADR-008) — SPECOE-MCP-REINICIAR sale cuando hace falta reiniciar y no cuando la
// sesion arranco con la entrada del proxy. `node --test`.
//
// QUE FIJA ESTA SUITE
//
//   El aviso (TKT-0454) juzga la entrada `specoe` con la que ARRANCO la sesion, porque Claude Code
//   conecta los MCP antes de que corran los hooks. Con la entrada del proxy no hay nada que
//   reiniciar: el proxy toma el JWT del cache, lo renueva y reabre /sse solo, este como este el cache
//   al arrancar. Pedir un reinicio ahi es lo que la SPEC prohibe (O5). Con la SSE vencida, o sin
//   entrada (room atrasado, sesion siguiente a un retiro), el reinicio sigue haciendo falta.
//
//   1-3. describeLaunchSkillEntry / buildMcpRestartNotice, puros: proxy => null y sin aviso; SSE
//        vencida => `vencido` y aviso; sin entrada => `sin-server` y aviso. Las tres exactas.
//   4-5. E2E con el hook de licencia: con la entrada del proxy y el cache vencido el arranque no
//        avisa; con la SSE vencida en un room que ya trae el proxy —la sesion de la migracion— avisa,
//        y la entrada queda migrada para la siguiente.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeLaunchSkillEntry,
  buildMcpRestartNotice,
  MCP_RESTART_PREFIX,
} from '../specoe-license-check.mjs';
import {
  LICENSE_CHECK,
  USE_SYSTEM_CA_SKIP,
  jwt,
  makeFixture,
  installProxy,
  writeCache,
  writeMcp,
  readMcp,
  canonicalEntry,
  cleanEnv,
  runNode,
  hookContext,
  startHub,
} from './helpers/proxy-room.mjs';

const VENCIDO = jwt({ sddRole: 'CC_DEV' }, { expInSec: -600 });

function sse(token) {
  return {
    type: 'sse',
    url: 'https://mcp.integra.local/sse',
    headers: { Authorization: `Bearer ${token}` },
  };
}

// ---------- puros ----------

test('1. entrada del proxy (con el cache vencido o sin el): null y sin aviso', async () => {
  const doc = { mcpServers: { specoe: await canonicalEntry() } };
  const launch = describeLaunchSkillEntry(doc, { env: {} });
  assert.equal(launch, null);
  assert.equal(buildMcpRestartNotice(launch), null);
});

test('2. entrada SSE con el JWT vencido: motivo vencido y aviso', () => {
  const launch = describeLaunchSkillEntry({ mcpServers: { specoe: sse(VENCIDO) } }, { env: {} });
  assert.equal(launch?.motivo, 'vencido');
  const aviso = buildMcpRestartNotice(launch);
  assert.ok(aviso.includes(`[[${MCP_RESTART_PREFIX}:vencido]]`), aviso);
});

test('3. sin entrada specoe: motivo sin-server y aviso', () => {
  const launch = describeLaunchSkillEntry({ mcpServers: {} }, { env: {} });
  assert.equal(launch?.motivo, 'sin-server');
  assert.ok(buildMcpRestartNotice(launch).includes(`[[${MCP_RESTART_PREFIX}:sin-server]]`));
});

// ---------- E2E con el hook de licencia ----------

async function arrancar(fx, hubUrl) {
  const r = await runNode(LICENSE_CHECK, [], {
    env: cleanEnv({
      CLAUDE_PROJECT_DIR: fx.room,
      CLAUDE_HOME: fx.home,
      HOME: fx.home,
      USERPROFILE: fx.home,
      INTEGRA_SECRETS_NO_KEYRING: '1',
      INTEGRA_HUB_URL: hubUrl,
      SPECOE_LICENSE_KEY: 'LIC-TEST-0237',
      SPECOE_LICENSE_TIMEOUT_MS: '30000',
    }),
  });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  return hookContext(r.stdout).context;
}

test(
  '4. E2E: sesion lanzada con la entrada del proxy y el cache vencido — el arranque NO pide reiniciar',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const hub = await startHub();
    const fx = makeFixture('aviso-proxy');
    installProxy(fx.room, 'ok');
    writeMcp(fx.room, { mcpServers: { specoe: await canonicalEntry() } });
    writeCache(fx.room, VENCIDO);
    try {
      const context = await arrancar(fx, hub.url);
      assert.match(context, /SpecOE license: tier=/, 'el arranque tenia que validar');
      assert.ok(!context.includes(MCP_RESTART_PREFIX), `pidio reiniciar con el proxy:\n${context}`);
    } finally {
      await hub.close();
    }
  },
);

test(
  '5. E2E: sesion lanzada con la SSE vencida en un room con el proxy — avisa, y la siguiente arranca con el proxy',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const hub = await startHub();
    const fx = makeFixture('aviso-sse');
    installProxy(fx.room, 'ok');
    writeMcp(fx.room, { mcpServers: { specoe: sse(VENCIDO) } });
    writeCache(fx.room, VENCIDO);
    try {
      const context = await arrancar(fx, hub.url);
      assert.ok(
        context.includes(`[[${MCP_RESTART_PREFIX}:vencido]]`),
        `faltaba el aviso:\n${context}`,
      );
      assert.deepEqual(readMcp(fx.room).mcpServers.specoe, await canonicalEntry());
    } finally {
      await hub.close();
    }
  },
);
