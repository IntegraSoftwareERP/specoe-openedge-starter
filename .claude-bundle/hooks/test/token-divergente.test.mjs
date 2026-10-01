// TKT-0225 — el room declara cuando sus DOS tokens no son el mismo. `node --test`.
//
// El hook baja el contrato con el JWT del cache por-carpeta; los tools MCP de la misma
// sesion corren con el JWT escrito en el .mcp.json. specoe-license-check.mjs los escribe
// juntos y con el mismo valor, pero una edicion a mano del .mcp.json los separa — y hasta
// este fix la sesion arrancaba sin decirlo: contrato de un rol arriba, bundle de otro (o el
// de producto) en los tools. Eso es lo que se vio en SPEC-0164 P6.
//
// Lo que esta suite fija:
//   1. La advertencia nombra los claims de los DOS tokens y no pisa el sentinel (puro).
//   2. Tokens distintos en la misma carpeta => la advertencia sale (E2E).
//   3. Los tres casos que NO son divergencia no la emiten: mismo token, placeholder sin
//      expandir y .mcp.json ausente. Sin estos, el test 2 pasaria con un hook que grita
//      siempre — y un verificador que grita siempre no discrimina nada.
//
// Los E2E corren el hook en un subproceso con CLAUDE_PROJECT_DIR en un temporal, asi que
// ninguna corrida toca la instalacion real del dev. Se usan tokens SIN claim sddRole a
// proposito: el hook corta en el camino `no-role` antes de tocar la red, de modo que el
// escenario mide la deteccion de divergencia y no un timeout contra un server que no existe.

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
  buildTokenDivergenceWarning,
  DIVERGENCE_PREFIX,
  UNGOVERNED_PREFIX,
  detectRoleDivergence,
} from '../specoe-room-bootstrap.mjs';
import {
  ROOM_BOOTSTRAP as BOOTSTRAP,
  JWT_SHAPE,
  jwt as jwtReal,
  makeFixture,
  writeCache as writeCacheP4,
  writeMcp as writeMcpP4,
  ledgerEntries,
  readLedger,
  canonicalEntry,
  cleanEnv,
  runNode,
  hookContext,
  startSkillServer,
} from './helpers/proxy-room.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOM_BOOTSTRAP = path.join(HERE, '..', 'specoe-room-bootstrap.mjs');
// Literales a proposito: si alguien renombra el sentinel o el prefijo en el hook, estos
// tests dejan de medir lo que dicen medir y hay que enterarse aca.
const SENTINEL = 'SPECOE-ROOM-CONTRACT';

// ---------- helpers ----------

function tmpProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt225-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** JWT sin firmar con el payload pedido — el hook solo decodifica, nunca verifica. */
function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `h.${body}.s`;
}

function writeCache(projectDir, token) {
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'specoe-license-cache.json'),
    JSON.stringify(
      { licenseKey: 'test-key', validatedAt: new Date().toISOString(), token, tier: 'PRO' },
      null,
      2,
    ),
  );
}

function writeMcp(projectDir, authorization) {
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          specoe: {
            type: 'sse',
            url: 'https://mcp.integra.local/sse',
            headers: { Authorization: authorization },
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
}

async function runBootstrap(projectDir) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  // El entorno del dev no debe contaminar el escenario: SPECOE_SKILL_JWT expandiria el
  // placeholder del caso 3 y lo convertiria en otro escenario.
  delete env.SPECOE_SKILL_JWT;
  delete env.NODE_EXTRA_CA_CERTS;
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

// ---------- 1. la advertencia, pura ----------

test('1. buildTokenDivergenceWarning nombra los claims de los dos tokens', () => {
  const t = buildTokenDivergenceWarning('CC_DEV', null);
  assert.match(t, new RegExp(DIVERGENCE_PREFIX));
  assert.match(t, /CC_DEV/, 'tiene que decir con que claim se bajo el contrato');
  assert.match(t, /sin claim sddRole/, 'y con cual corren los tools MCP');
  assert.match(t, /\.mcp\.json/);
  assert.ok(
    !t.includes(SENTINEL),
    'la advertencia no puede traer el sentinel: el probe lo asserta por separado',
  );
});

test('2. el contrato inyectado conserva el sentinel con la advertencia pegada', () => {
  // La advertencia se CONCATENA y nunca reemplaza: el sentinel sigue siendo afirmable en el
  // mismo texto, que es lo que el probe de T5.3 mide.
  const texto =
    buildAdditionalContext('CC_DEV', '# contrato') + buildTokenDivergenceWarning('CC_DEV', null);
  assert.ok(texto.includes(`${SENTINEL}:CC_DEV`));
  assert.ok(texto.includes(DIVERGENCE_PREFIX));
});

// ---------- 3. E2E: la divergencia se detecta ----------

test('3. E2E dos tokens distintos en la carpeta — el hook lo declara', async () => {
  const dir = tmpProject('divergente');
  writeCache(dir, jwt({ sub: 'cache' }));
  writeMcp(dir, `Bearer ${jwt({ sub: 'mcp-json' })}`);
  const res = await runBootstrap(dir);
  assert.equal(res.json?.specoeRoomContractStatus, 'ungoverned', 'el cache no trae rol');
  assert.ok(
    res.context.includes(DIVERGENCE_PREFIX),
    `la divergencia tiene que salir en el additionalContext. Salida: ${res.stdout}`,
  );
});

// ---------- 4-6. los casos que NO son divergencia ----------

test('4. E2E mismo token en el cache y en el .mcp.json — sin advertencia', async () => {
  const dir = tmpProject('mismo-token');
  const token = jwt({ sub: 'unico' });
  writeCache(dir, token);
  writeMcp(dir, `Bearer ${token}`);
  const res = await runBootstrap(dir);
  assert.ok(
    !res.context.includes(DIVERGENCE_PREFIX),
    'el camino sano no puede gritar divergencia — seria el ruido que este ticket combate',
  );
});

test('5. E2E .mcp.json con el placeholder sin expandir — sin advertencia', async () => {
  // No es divergencia: es el entry que dejo el instalador antes de la primera corrida que
  // valida. Lo nombra el chequeo 3 del verificador, no este hook.
  const dir = tmpProject('placeholder');
  writeCache(dir, jwt({ sub: 'cache' }));
  writeMcp(dir, 'Bearer ${SPECOE_SKILL_JWT}');
  const res = await runBootstrap(dir);
  assert.ok(!res.context.includes(DIVERGENCE_PREFIX));
});

test('6. E2E sin .mcp.json — sin advertencia', async () => {
  // Sin entry no hay tools MCP corriendo con otro token: es ausencia declarada (el hook de
  // licencia retira el server cuando la corrida no tiene JWT usable), no divergencia.
  const dir = tmpProject('sin-mcp');
  writeCache(dir, jwt({ sub: 'cache' }));
  const res = await runBootstrap(dir);
  assert.ok(!res.context.includes(DIVERGENCE_PREFIX));
});

// ---------- SPEC-0237 P4 (T4.3, ADR-007) — la entrada del PROXY ----------
//
// Con la entrada del proxy el .mcp.json no lleva JWT: los tools MCP corren con el del cache, el
// mismo con el que el hook baja el contrato. La divergencia que queda es de ROL: el claim sddRole
// del cache contra el rol que la sesion declara (INTEGRA_SDD_ROLE). Tres filas —sano, divergente y
// la SSE de siempre—, cada una contra un skill-server falso que sirve el contrato POR TOKEN, asi
// que el hook recorre su camino real hasta inyectar.

const CONTRATO_CC_DEV = '# Contrato del room CC_DEV\n';
const CONTRATO_ENGINEERING = '# Contrato del room ENGINEERING\n';

async function bootstrapP4(fx, { skillUrl, rol = null }) {
  const r = await runNode(BOOTSTRAP, [], {
    env: cleanEnv({
      CLAUDE_PROJECT_DIR: fx.room,
      HOME: fx.home,
      USERPROFILE: fx.home,
      SPECOE_SKILL_SERVER_URL: skillUrl,
      ...(rol ? { INTEGRA_SDD_ROLE: rol } : {}),
    }),
  });
  return { ...hookContext(r.stdout), stdout: r.stdout };
}

test('7. puro: detectRoleDivergence compara el claim del cache contra el rol declarado', () => {
  assert.equal(
    detectRoleDivergence({ cacheToken: jwt({ sddRole: 'CC_DEV' }), declaredRole: 'CC_DEV' }),
    null,
  );
  assert.deepEqual(
    detectRoleDivergence({ cacheToken: jwt({ sddRole: 'ENGINEERING' }), declaredRole: 'CC_DEV' }),
    { servido: 'ENGINEERING', declarado: 'CC_DEV' },
  );
  assert.deepEqual(
    detectRoleDivergence({ cacheToken: jwt({ sub: 'producto' }), declaredRole: 'CC_DEV' }),
    {
      servido: null,
      declarado: 'CC_DEV',
    },
  );
  // Sin rol declarado o sin token no hay con que comparar: no es divergencia.
  assert.equal(
    detectRoleDivergence({ cacheToken: jwt({ sddRole: 'CC_DEV' }), declaredRole: null }),
    null,
  );
  assert.equal(detectRoleDivergence({ cacheToken: null, declaredRole: 'CC_DEV' }), null);
});

test('8. E2E entrada del proxy y cache del rol declarado — sin SPECOE-ROOM-TOKEN-DIVERGENTE', async () => {
  const cache = jwtReal({ sddRole: 'CC_DEV' });
  const server = await startSkillServer({ contratos: { [cache]: CONTRATO_CC_DEV } });
  const fx = makeFixture('div-sano');
  writeCacheP4(fx.room, cache);
  writeMcpP4(fx.room, { mcpServers: { specoe: await canonicalEntry() } });
  try {
    // El rol declarado viaja como lo exporta un launcher escrito a mano: se normaliza.
    const res = await bootstrapP4(fx, { skillUrl: server.url, rol: ' cc_dev ' });
    assert.equal(res.json?.specoeRoomContractStatus, 'injected', res.stdout);
    assert.ok(
      !res.context.includes(DIVERGENCE_PREFIX),
      `el room sano no puede avisar:\n${res.context}`,
    );
    assert.equal(res.json?.specoeTokenDivergence, undefined);
  } finally {
    await server.close();
  }
});

test('9. E2E entrada del proxy y cache con JWT vigente de OTRO rol — el aviso nombra los dos roles', async () => {
  const cache = jwtReal({ sddRole: 'ENGINEERING' });
  const server = await startSkillServer({ contratos: { [cache]: CONTRATO_ENGINEERING } });
  const fx = makeFixture('div-otro-rol');
  writeCacheP4(fx.room, cache);
  writeMcpP4(fx.room, { mcpServers: { specoe: await canonicalEntry() } });
  try {
    const res = await bootstrapP4(fx, { skillUrl: server.url, rol: 'CC_DEV' });
    assert.equal(res.json?.specoeRoomContractStatus, 'injected', res.stdout);
    assert.ok(
      res.context.includes(`[[${DIVERGENCE_PREFIX}]]`),
      `faltaba el aviso:\n${res.context}`,
    );
    assert.match(res.context, /declara el rol CC_DEV/);
    assert.match(res.context, /es de ENGINEERING/);
    assert.equal(res.json?.specoeTokenDivergence, true);
  } finally {
    await server.close();
  }
});

test('10. E2E entrada del proxy sin rol declarado — no hay con que comparar, sin aviso', async () => {
  const cache = jwtReal({ sddRole: 'ENGINEERING' });
  const server = await startSkillServer({ contratos: { [cache]: CONTRATO_ENGINEERING } });
  const fx = makeFixture('div-sin-rol');
  writeCacheP4(fx.room, cache);
  writeMcpP4(fx.room, { mcpServers: { specoe: await canonicalEntry() } });
  try {
    const res = await bootstrapP4(fx, { skillUrl: server.url });
    assert.ok(!res.context.includes(DIVERGENCE_PREFIX), res.context);
  } finally {
    await server.close();
  }
});

test('11. E2E entrada SSE con token distinto al del cache — el aviso de siempre, sin cambios', async () => {
  const cache = jwtReal({ sddRole: 'CC_DEV', jti: 'cache' });
  const mcp = jwtReal({ sddRole: 'ENGINEERING', jti: 'mcp' });
  const server = await startSkillServer({ contratos: { [cache]: CONTRATO_CC_DEV } });
  const fx = makeFixture('div-sse');
  writeCacheP4(fx.room, cache);
  writeMcpP4(fx.room, {
    mcpServers: {
      specoe: { type: 'sse', url: server.url, headers: { Authorization: `Bearer ${mcp}` } },
    },
  });
  try {
    // Con la SSE el rol declarado no entra: se comparan tokens, como desde TKT-0225.
    const res = await bootstrapP4(fx, { skillUrl: server.url, rol: 'CC_DEV' });
    // El texto lleva la ruta del .mcp.json del proceso que lo arma: se compara sin ella.
    const sinRuta = (t) => t.replace(/de \S+\.mcp\.json declara/, 'de <.mcp.json> declara');
    assert.ok(
      sinRuta(res.context).includes(sinRuta(buildTokenDivergenceWarning('CC_DEV', 'ENGINEERING'))),
      `tenia que salir el aviso de tokens de siempre:\n${res.context}`,
    );
  } finally {
    await server.close();
  }
});

// ---------- SPEC-0237 P4 (T4.3, ADR-003) — la apertura de /sse del hook en el registro ----------

test('12. cada apertura de /sse del hook deja una linea sse_open source bootstrap, con claims y sin el JWT', async () => {
  const cache = jwtReal({ sddRole: 'CC_DEV', tenantId: 'tenant-p4' });
  const server = await startSkillServer({ contratos: { [cache]: CONTRATO_CC_DEV } });
  const fx = makeFixture('ledger-open');
  writeCacheP4(fx.room, cache);
  try {
    const res = await bootstrapP4(fx, { skillUrl: server.url });
    assert.equal(res.json?.specoeRoomContractStatus, 'injected', res.stdout);
    assert.equal(server.gets.length, 1);
    const opens = ledgerEntries(fx.room).filter((e) => e.kind === 'sse_open');
    assert.equal(opens.length, 1, readLedger(fx.room));
    const [e] = opens;
    assert.equal(e.source, 'bootstrap');
    assert.equal(e.status, 'open');
    assert.equal(e.httpStatus, 200);
    assert.equal(e.sddRole, 'CC_DEV');
    assert.equal(e.tenantId, 'tenant-p4');
    assert.equal(typeof e.iat, 'number');
    assert.equal(typeof e.exp, 'number');
    assert.ok(!readLedger(fx.room).includes(cache), 'el registro no puede guardar el token');
    assert.doesNotMatch(readLedger(fx.room), JWT_SHAPE);
  } finally {
    await server.close();
  }
});

test('13. una apertura rechazada (401) queda anotada como rejected', async () => {
  const cache = jwtReal({ sddRole: 'CC_DEV' });
  const server = await startSkillServer({ rechazar: [cache] });
  const fx = makeFixture('ledger-401');
  writeCacheP4(fx.room, cache);
  try {
    const res = await bootstrapP4(fx, { skillUrl: server.url });
    assert.equal(res.json?.specoeRoomContractStatus, 'ungoverned', res.stdout);
    const [e] = ledgerEntries(fx.room).filter((x) => x.kind === 'sse_open');
    assert.equal(e?.source, 'bootstrap');
    assert.equal(e?.status, 'rejected');
    assert.equal(e?.httpStatus, 401);
  } finally {
    await server.close();
  }
});

test('14. con 12 aperturas en la ultima hora el hook NO abre: el tope del room cuenta tambien al bootstrap', async () => {
  const cache = jwtReal({ sddRole: 'CC_DEV' });
  const server = await startSkillServer({ contratos: { [cache]: CONTRATO_CC_DEV } });
  const fx = makeFixture('ledger-tope');
  writeCacheP4(fx.room, cache);
  const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
  const previas = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({
      kind: 'sse_open',
      id: `p${i}`,
      ts: hace(50 - i),
      source: 'proxy',
      status: 'open',
    }),
  );
  fs.writeFileSync(
    path.join(fx.room, '.claude', 'specoe-room-ledger.jsonl'),
    previas.join('\n') + '\n',
  );
  try {
    const res = await bootstrapP4(fx, { skillUrl: server.url });
    assert.equal(server.gets.length, 0, 'abrio /sse con el tope agotado');
    assert.equal(res.json?.specoeRoomContractStatus, 'ungoverned');
    assert.ok(res.context.includes(`[[${UNGOVERNED_PREFIX}:sse-tope]]`), res.context);
    assert.equal(ledgerEntries(fx.room).filter((x) => x.kind === 'sse_open').length, 12);
  } finally {
    await server.close();
  }
});
