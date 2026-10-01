// TKT-0225 — el chequeo 5 del verificador discrimina el ROL, no solo que la sesion abra.
// `node --test`.
//
// El defecto: el chequeo 4 bajaba el contrato con el token del CACHE y el 5 se conformaba
// con que el skill-server ACEPTARA la sesion con el token del .mcp.json. Un JWT de producto
// abre la sesion igual, asi que los cinco chequeos podian dictaminar SERVIDO con la sesion
// real de Claude Code corriendo como producto — el verde falso, dentro de la herramienta
// que existe para detectarlo (SPEC-0164 P6).
//
// Los tres escenarios de aca son el mismo room con el MISMO cache y el .mcp.json cambiado:
//   A. los dos tokens resuelven al mismo rol  -> 5 en OK
//   B. el token del .mcp.json es de producto  -> 5 en FAIL  (el verde falso historico)
//   C. el token del .mcp.json es de otro rol  -> 5 en FAIL
//
// El skill-server es un http.Server local que habla MCP sobre SSE y decide que contrato
// sirve SEGUN EL TOKEN de la sesion — que es exactamente la variable del defecto. No se
// levanta Hub ni TLS: los chequeos 1-3 no son el objeto de esta suite y se asserta la LINEA
// del chequeo bajo prueba, no el exit code del verificador.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  USE_SYSTEM_CA_SKIP,
  jwt as jwtReal,
  makeFixture,
  installProxy,
  installMachineHooks,
  writeCache as writeCacheP4,
  writeMcp as writeMcpP4,
  canonicalEntry,
  cleanEnv,
  runNode,
  startSkillServer,
  selfSignedCert,
  startHttpsHub,
} from './helpers/proxy-room.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(HERE, '..', '..', 'scripts', 'verify-room-serving.mjs');

const CONTRATO_CC_DEV = '# Contrato del room CC_DEV\n\nSos el rol CC-Dev.\n';
const CONTRATO_ENGINEERING = '# Contrato del room ENGINEERING\n\nSos el rol Engineering.\n';
// El texto que el skill-server real devuelve para role=null (content-source.ts).
const ERROR_PRODUCTO =
  'Error: room_contract_get: el bundle producto (role=null) no tiene contrato de room';

// ---------- skill-server falso: MCP sobre SSE, contrato POR TOKEN ----------

/**
 * `contratosPorToken`: token -> markdown del contrato. Un token ausente del mapa es
 * producto: el tool responde isError, igual que el server real.
 */
async function levantarSkillServer(contratosPorToken) {
  const sesiones = new Map();
  let n = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = String(req.headers.authorization ?? '');
    const token = auth.replace(/^Bearer\s+/i, '').trim();

    if (req.method === 'GET') {
      const id = String(++n);
      sesiones.set(id, { res, token });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: endpoint\ndata: /messages?s=${id}\n\n`);
      return;
    }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(202).end();
      const ses = sesiones.get(url.searchParams.get('s'));
      if (!ses) return;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return;
      }
      if (msg.id === undefined) return; // notificacion (notifications/initialized)

      // El token de la sesion es el del GET; el del POST tiene que ser el mismo cliente.
      const efectivo = token || ses.token;
      let result;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'skill-server-falso', version: '1.0.0' },
        };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'room_contract_get') {
        const contrato = contratosPorToken[efectivo];
        result = contrato
          ? { content: [{ type: 'text', text: contrato }] }
          : { isError: true, content: [{ type: 'text', text: ERROR_PRODUCTO }] };
      } else {
        result = {};
      }
      ses.res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    async close() {
      for (const { res } of sesiones.values()) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------- room temporal ----------

/** JWT sin firmar con `exp` a una hora: el verificador decodifica, nunca verifica firma. */
function jwt(payload) {
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }),
  ).toString('base64url');
  return `h.${body}.s`;
}

function tmpRoom(name, { cacheToken, mcpToken, skillUrl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt225-verif-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'specoe-license-cache.json'),
    JSON.stringify({
      licenseKey: 'k',
      validatedAt: new Date().toISOString(),
      token: cacheToken,
      tier: 'PRO',
    }),
  );
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        specoe: { type: 'sse', url: skillUrl, headers: { Authorization: `Bearer ${mcpToken}` } },
      },
    }) + '\n',
  );
  return dir;
}

/** Corre el verificador y devuelve las lineas por id de chequeo. */
async function correrVerificador(roomDir, skillUrl) {
  const env = {
    ...process.env,
    SPECOE_SKILL_SERVER_URL: skillUrl,
    SPECOE_VERIFY_CHECK_TIMEOUT_MS: '4000',
    SPECOE_VERIFY_TOTAL_TIMEOUT_MS: '25000',
  };
  delete env.NODE_EXTRA_CA_CERTS;
  let stdout = '';
  try {
    stdout = (
      await execFileAsync(process.execPath, [VERIFIER, roomDir], {
        encoding: 'utf8',
        timeout: 60000,
        env,
      })
    ).stdout;
  } catch (err) {
    // Exit 1 es lo esperado: el chequeo 1 (canal TLS al Hub) no es el objeto de esta suite.
    stdout = String(err?.stdout ?? '');
  }
  const linea = (id) => stdout.split('\n').find((l) => l.includes(` ${id} [`)) ?? '';
  return { stdout, contrato: linea('contrato-room'), conectable: linea('specoe-conectable') };
}

// ---------- A. los dos tokens resuelven al mismo rol ----------

test('A. mismo rol en los dos tokens — el chequeo 5 da OK', async () => {
  const cacheToken = jwt({ sddRole: 'CC_DEV', jti: 'cache' });
  const mcpToken = jwt({ sddRole: 'CC_DEV', jti: 'mcp' });
  const server = await levantarSkillServer({
    [cacheToken]: CONTRATO_CC_DEV,
    [mcpToken]: CONTRATO_CC_DEV,
  });
  try {
    const room = tmpRoom('ok', { cacheToken, mcpToken, skillUrl: server.url });
    const r = await correrVerificador(room, server.url);
    assert.match(r.contrato, /: OK —/, `el chequeo 4 tenia que bajar el contrato. ${r.stdout}`);
    assert.match(r.conectable, /: OK —/, `el chequeo 5 tenia que dar verde. ${r.stdout}`);
    assert.match(r.conectable, /EL MISMO contrato/);
  } finally {
    await server.close();
  }
});

// ---------- B. el verde falso historico ----------

test('B. el token del .mcp.json es de PRODUCTO — el chequeo 5 da FAIL', async () => {
  // Este es el escenario de SPEC-0164 P6: el hook baja el contrato CC_DEV con el token del
  // cache y la sesion de Claude Code corre como producto. Antes de TKT-0225 el chequeo 5
  // daba verde porque el server aceptaba la sesion igual.
  const cacheToken = jwt({ sddRole: 'CC_DEV', jti: 'cache' });
  const mcpToken = jwt({ jti: 'producto' }); // sin sddRole y sin contrato en el server
  const server = await levantarSkillServer({ [cacheToken]: CONTRATO_CC_DEV });
  try {
    const room = tmpRoom('producto', { cacheToken, mcpToken, skillUrl: server.url });
    const r = await correrVerificador(room, server.url);
    // El 4 sigue verde: el contrato SI baja con el token del cache. Sin este control, el
    // test B pasaria por cualquier motivo (server caido, url mala) y no por el que dice.
    assert.match(r.contrato, /: OK —/, `el chequeo 4 tenia que seguir verde. ${r.stdout}`);
    assert.match(r.conectable, /: FAIL —/, `el verde falso sigue vivo. ${r.stdout}`);
    assert.match(r.conectable, /NO le sirve el contrato del room/);
    assert.match(r.conectable, /producto/);
  } finally {
    await server.close();
  }
});

// ---------- C. dos roles distintos ----------

test('C. el token del .mcp.json es de OTRO rol — el chequeo 5 da FAIL', async () => {
  const cacheToken = jwt({ sddRole: 'CC_DEV', jti: 'cache' });
  const mcpToken = jwt({ sddRole: 'ENGINEERING', jti: 'mcp' });
  const server = await levantarSkillServer({
    [cacheToken]: CONTRATO_CC_DEV,
    [mcpToken]: CONTRATO_ENGINEERING,
  });
  try {
    const room = tmpRoom('otro-rol', { cacheToken, mcpToken, skillUrl: server.url });
    const r = await correrVerificador(room, server.url);
    assert.match(r.contrato, /: OK —/, `el chequeo 4 tenia que seguir verde. ${r.stdout}`);
    assert.match(r.conectable, /: FAIL —/, `dos roles distintos no pueden dar verde. ${r.stdout}`);
    assert.match(r.conectable, /roles DISTINTOS/);
  } finally {
    await server.close();
  }
});

// ---------- SPEC-0237 P4 (T4.4, ADR-007) — la entrada del PROXY ----------
//
// Con la entrada del proxy no hay token en el .mcp.json: el proxy toma el del cache. El 3 exige la
// forma canonica (se la juzga el propio proxy) y un JWT vigente del rol declarado; el 4 baja el
// contrato solo si el rol del cache es el declarado; el 5 LANZA el proxy vendorizado como lo
// declara la entrada y le habla MCP por stdio contra el skill-server falso. Las filas: sano (y su
// exit 0, con un Hub https de prueba para el chequeo 1), divergente, entrada tocada a mano y rol
// declarado desde el yaml del room. Las tres filas de arriba son la SSE: siguen como estaban.

/** Room al dia: proxy vendorizado con su MANIFEST, entrada canonica, cache con `cacheToken`. */
async function roomConProxy(name, { cacheToken, entrada = null }) {
  const fx = makeFixture(name);
  installProxy(fx.room, 'ok');
  installMachineHooks(fx.home);
  writeCacheP4(fx.room, cacheToken);
  writeMcpP4(fx.room, { mcpServers: { specoe: entrada ?? (await canonicalEntry()) } });
  return fx;
}

async function verificarP4(fx, { skillUrl, rol = null, hubUrl = null }) {
  const r = await runNode(VERIFIER, [fx.room], {
    env: cleanEnv({
      HOME: fx.home,
      USERPROFILE: fx.home,
      SPECOE_SKILL_SERVER_URL: skillUrl,
      SPECOE_VERIFY_CHECK_TIMEOUT_MS: '8000',
      SPECOE_VERIFY_TOTAL_TIMEOUT_MS: '40000',
      ...(rol ? { INTEGRA_SDD_ROLE: rol } : {}),
      ...(hubUrl ? { INTEGRA_HUB_URL: hubUrl } : {}),
    }),
    timeout: 90000,
  });
  const linea = (id) => r.stdout.split('\n').find((l) => l.includes(` ${id} [`)) ?? '';
  return {
    code: r.code,
    stdout: r.stdout,
    jwt: linea('mcp-json-jwt'),
    contrato: linea('contrato-room'),
    conectable: linea('specoe-conectable'),
  };
}

test(
  'D. entrada del proxy, cache del rol declarado — 3, 4 y 5 OK',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const cache = jwtReal({ sddRole: 'CC_DEV' });
    const server = await startSkillServer({ contratos: { [cache]: CONTRATO_CC_DEV } });
    try {
      const fx = await roomConProxy('p4-sano', { cacheToken: cache });
      const r = await verificarP4(fx, { skillUrl: server.url, rol: 'CC_DEV' });
      assert.match(r.jwt, /: OK —/, `chequeo 3:\n${r.stdout}`);
      assert.match(r.jwt, /entrada del proxy canonica/);
      assert.match(r.contrato, /: OK —/, `chequeo 4:\n${r.stdout}`);
      assert.match(r.conectable, /: OK —/, `chequeo 5:\n${r.stdout}`);
      assert.match(r.conectable, /por stdio/, 'el 5 tenia que hablarle al proxy, no al server');
      assert.match(r.conectable, /EL MISMO contrato/);
      // El 5 paso POR el proxy: la sesion SSE la abrio el proxy (el 4 abre la suya), con el JWT
      // del cache.
      assert.equal(
        server.gets.filter((g) => g.token === cache).length,
        2,
        'el 4 y el proxy abren /sse',
      );
    } finally {
      await server.close();
    }
  },
);

const TLS = USE_SYSTEM_CA_SKIP
  ? null
  : selfSignedCert(fs.mkdtempSync(path.join(os.tmpdir(), 'specoe-p4-tls-')));

test(
  'D2. room sano con la entrada del proxy — los cinco en verde y exit 0',
  {
    skip:
      USE_SYSTEM_CA_SKIP ||
      (!TLS &&
        'sin openssl no hay Hub https de prueba: el chequeo 1 (canal TLS) no se puede poner en verde'),
  },
  async () => {
    const cache = jwtReal({ sddRole: 'CC_DEV' });
    const server = await startSkillServer({ contratos: { [cache]: CONTRATO_CC_DEV } });
    const hub = await startHttpsHub(TLS);
    try {
      const fx = await roomConProxy('p4-exit0', { cacheToken: cache });
      fs.writeFileSync(path.join(fx.home, '.claude', 'caddy-local-root.crt'), TLS.cert);
      const r = await verificarP4(fx, { skillUrl: server.url, rol: 'CC_DEV', hubUrl: hub.url });
      assert.equal(r.code, 0, `el room sano tenia que dar exit 0:\n${r.stdout}`);
      assert.match(r.stdout, /veredicto: SERVIDO/);
    } finally {
      await hub.close();
      await server.close();
    }
  },
);

test(
  'E. entrada del proxy, cache con JWT vigente de OTRO rol — 3, 4 y 5 FAIL con los dos roles',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const cache = jwtReal({ sddRole: 'ENGINEERING' });
    const server = await startSkillServer({ contratos: { [cache]: CONTRATO_ENGINEERING } });
    try {
      const fx = await roomConProxy('p4-divergente', { cacheToken: cache });
      const r = await verificarP4(fx, { skillUrl: server.url, rol: 'CC_DEV' });
      for (const [n, l] of [
        ['3', r.jwt],
        ['4', r.contrato],
        ['5', r.conectable],
      ]) {
        assert.match(l, /: FAIL —/, `chequeo ${n} tenia que dar rojo:\n${r.stdout}`);
        assert.match(l, /ENGINEERING/, `chequeo ${n}: falta el rol servido`);
        assert.match(l, /CC_DEV/, `chequeo ${n}: falta el rol declarado`);
      }
      // El 4 no baja el contrato del rol equivocado: la unica apertura con ese JWT es la del proxy.
      assert.equal(server.gets.length, 1, 'el 4 no tenia que abrir /sse con el JWT de otro rol');
      assert.notEqual(r.code, 0);
    } finally {
      await server.close();
    }
  },
);

for (const [que, agregado] of [
  ['url', { url: 'https://mcp.integra.local/sse' }],
  ['headers con JWT', { headers: { Authorization: `Bearer ${jwtReal({ sddRole: 'CC_DEV' })}` } }],
  ['env con JWT', { env: { SPECOE_SKILL_JWT: jwtReal({ sddRole: 'CC_DEV' }) } }],
]) {
  test(
    `F. entrada del proxy con ${que} agregado a mano — 3 FAIL`,
    { skip: USE_SYSTEM_CA_SKIP },
    async () => {
      const cache = jwtReal({ sddRole: 'CC_DEV' });
      const server = await startSkillServer({ contratos: { [cache]: CONTRATO_CC_DEV } });
      try {
        const entrada = { ...(await canonicalEntry()), ...agregado };
        const fx = await roomConProxy(`p4-tocada-${que.split(' ')[0]}`, {
          cacheToken: cache,
          entrada,
        });
        const r = await verificarP4(fx, { skillUrl: server.url, rol: 'CC_DEV' });
        assert.match(r.jwt, /: FAIL —/, `chequeo 3:\n${r.stdout}`);
        assert.match(r.jwt, /NO es la canonica/);
        assert.match(r.jwt, new RegExp(Object.keys(agregado)[0]), 'tenia que nombrar lo agregado');
        // El .mcp.json del room no se toco: el juicio corre sobre una copia.
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(fx.room, '.mcp.json'), 'utf8')).mcpServers.specoe,
          entrada,
        );
      } finally {
        await server.close();
      }
    },
  );
}

test(
  'G. sin INTEGRA_SDD_ROLE el rol declarado sale de specoe.role del room',
  { skip: USE_SYSTEM_CA_SKIP },
  async () => {
    const cache = jwtReal({ sddRole: 'ENGINEERING' });
    const server = await startSkillServer({ contratos: { [cache]: CONTRATO_ENGINEERING } });
    try {
      const fx = await roomConProxy('p4-rol-yaml', { cacheToken: cache });
      fs.writeFileSync(
        path.join(fx.room, 'project.config.local.yaml'),
        "specoe:\n  role: 'CC_DEV'\n",
      );
      const r = await verificarP4(fx, { skillUrl: server.url });
      assert.match(r.jwt, /: FAIL —/, r.stdout);
      assert.match(r.jwt, /project\.config\.local\.yaml \(specoe\.role\)/);
    } finally {
      await server.close();
    }
  },
);
