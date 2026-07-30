// TKT-0234 — el deadline del verificador es un CORTE, no una declaracion. `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// verify-room-serving.mjs abria cada corrida anunciando "deadlines: 8000 ms por chequeo,
// 40000 ms total" y no cumplia ninguno de los dos. Los numeros solo viajaban como argumento
// a `withTimeout`, que corre contra las esperas del stream SSE; los `fetch` — el GET que
// abre el SSE y los POST de cada mensaje JSON-RPC — no tenian corte de ninguna clase. Un
// server que acepta la conexion y NUNCA manda cabeceras de respuesta dejaba ese await
// pendiente para siempre. Observado en la re-corrida limpia de SPEC-0164 P6: chequeos 1-3
// en OK y el 4 colgado mas alla de los 40 s del total, cortado a mano.
//
// POR QUE NO ALCANZABA LA SUITE DE TKT-0225
//
// Aquella suite (verificador-discrimina-rol.test.mjs) SI ejercita el camino feliz del
// chequeo 4 — su escenario A lo deja en OK. Lo que ningun test cubria es el server que
// ACEPTA y no contesta: los tres escenarios de TKT-0225 corren contra un server que siempre
// responde, y contra un server asi el bug es invisible. El agujero no estaba en el camino
// feliz: estaba en la espera sin corte.
//
// LO QUE ESTA SUITE FIJA
//
//   1. Control POSITIVO — server sano: los chequeos 4 y 5 en OK. Sin este caso, un
//      verificador que corte SIEMPRE pasaria todos los demas, y "todo rojo" no es un gate.
//   2. GET /sse aceptado y sin cabeceras nunca -> el chequeo 4 sale ROJO nombrando el corte,
//      el verificador EMITE veredicto y TERMINA SOLO. Es el cuelgue reproducido.
//   3. POST /messages aceptado y sin cabeceras nunca -> idem. Es el segundo agujero: aunque
//      el GET conteste, el POST tampoco tenia corte.
//   4. SSE abierto, POST 202 y la respuesta JSON-RPC que no llega nunca -> rojo y termina.
//      Este caso YA pasaba antes del fix (esa espera si estaba acotada por `withTimeout`):
//      queda fijado a proposito para que la unica espera del chequeo 4 que tenia corte no
//      lo pierda en un refactor futuro. Los que estaban rojos antes del fix son el 2, 3, 5
//      y 6 — medido corriendo esta suite contra el verificador de origin/main.
//   5. Aislamiento: con el chequeo 4 contra un server sano y el 5 contra el agujero negro,
//      el 4 queda en OK y solo el 5 se corta. El corte discrimina; no es un rojo global.
//   6. Reproducibilidad (O5): dos corridas seguidas contra el agujero negro dan EL MISMO
//      veredicto. Un cuelgue que se corta a mano no da el mismo resultado dos veces.
//
// El corte se mide por el EFECTO, no por el mensaje: cada caso asserta que el proceso
// termino por su cuenta (nunca matado por el timeout del test) y dentro del deadline TOTAL
// que el propio verificador declara. Un assert que solo mirara el texto del FAIL pasaria
// con un verificador que igual se cuelga treinta segundos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(HERE, '..', '..', 'scripts', 'verify-room-serving.mjs');

// Deadlines cortos: la suite mide el CORTE, y con los defaults (8 s / 40 s) cada caso
// tardaria lo mismo que el bug que repara. La relacion se conserva (5 chequeos x CHECK).
const CHECK_MS = 1500;
const TOTAL_MS = CHECK_MS * 5;
// Techo del test: bien por encima del total declarado, para que matar el proceso sea
// SIEMPRE un fallo del verificador y nunca un test apretado.
const TIMEOUT_TEST_MS = TOTAL_MS * 4;

const CONTRATO_CC_DEV = '# Contrato del room CC_DEV\n\nSos el rol CC-Dev.\n';
const ERROR_PRODUCTO =
  'Error: room_contract_get: el bundle producto (role=null) no tiene contrato de room';

// ---------- skill-server falso, con modos de silencio ----------
//
// `modo`:
//   'sano'                -> habla MCP sobre SSE y contesta todo
//   'sin-cabeceras-sse'   -> acepta el GET /sse y no manda cabeceras NUNCA
//   'sin-cabeceras-post'  -> el SSE abre (evento endpoint incluido); el POST /messages se
//                            acepta y no manda cabeceras NUNCA
//   'sin-respuesta-rpc'   -> SSE abierto y POST 202, pero la respuesta JSON-RPC no sale

async function levantarSkillServer({ modo = 'sano', contratosPorToken = {} } = {}) {
  const sesiones = new Map();
  const sockets = new Set();
  let n = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = String(req.headers.authorization ?? '');
    const token = auth.replace(/^Bearer\s+/i, '').trim();

    if (req.method === 'GET') {
      if (modo === 'sin-cabeceras-sse') return; // ni writeHead: el fetch del cliente espera
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
      if (modo === 'sin-cabeceras-post') return; // acepta el cuerpo y se calla
      res.writeHead(202).end();
      if (modo === 'sin-respuesta-rpc') return; // el POST cierra, la respuesta no llega
      const ses = sesiones.get(url.searchParams.get('s'));
      if (!ses) return;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return;
      }
      if (msg.id === undefined) return; // notificacion (notifications/initialized)

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

  // Un request al que nunca se le contesta deja el socket vivo: sin esto server.close()
  // no vuelve y la suite se cuelga en el teardown — el mismo defecto, del otro lado.
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    async close() {
      for (const { res } of sesiones.values()) res.end();
      for (const s of sockets) s.destroy();
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

function tmpRoom(name, { cacheToken, mcpToken, mcpUrl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-tkt234-${name}-`));
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
        specoe: { type: 'sse', url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } },
      },
    }) + '\n',
  );
  return dir;
}

/**
 * Corre el verificador. `matado` es la aserción que importa: true significa que el proceso
 * no termino solo y lo tuvo que matar el test — o sea, el cuelgue de TKT-0234 sigue vivo.
 */
function correrVerificador(roomDir, skillUrl) {
  const env = {
    ...process.env,
    SPECOE_SKILL_SERVER_URL: skillUrl,
    SPECOE_VERIFY_CHECK_TIMEOUT_MS: String(CHECK_MS),
    SPECOE_VERIFY_TOTAL_TIMEOUT_MS: String(TOTAL_MS),
  };
  delete env.NODE_EXTRA_CA_CERTS;
  // Sin INTEGRA_HUB_URL el chequeo 1 resuelve al fallback http:// del bundle y falla al
  // instante por no ser https: no hay red del Hub en esta suite y su objeto es otro.
  delete env.INTEGRA_HUB_URL;

  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [VERIFIER, roomDir],
      { encoding: 'utf8', timeout: TIMEOUT_TEST_MS, env },
      (err, stdout) => {
        const salida = String(stdout ?? err?.stdout ?? '');
        const linea = (id) => salida.split('\n').find((l) => l.includes(` ${id} [`)) ?? '';
        resolve({
          stdout: salida,
          ms: Date.now() - t0,
          matado: Boolean(err?.killed),
          code: err ? (err.code ?? null) : 0,
          veredicto: salida.split('\n').find((l) => l.includes('veredicto:')) ?? '',
          contrato: linea('contrato-room'),
          conectable: linea('specoe-conectable'),
        });
      },
    );
  });
}

/** Lo que TKT-0234 exige de TODA corrida: termina sola y dentro del total que declara. */
function assertTerminaYNoSeCuelga(r) {
  assert.equal(r.matado, false, `el verificador no termino solo — se colgo. ${r.stdout}`);
  assert.match(r.veredicto, /veredicto: (SERVIDO|NO SERVIDO)/, `sin veredicto. ${r.stdout}`);
  assert.ok(
    r.ms < TOTAL_MS * 2,
    `tardo ${r.ms} ms con un deadline TOTAL declarado de ${TOTAL_MS} ms. ${r.stdout}`,
  );
}

// ---------- 1. control positivo ----------

test('1. server sano — los chequeos 4 y 5 dan OK (el corte no rompe el camino feliz)', async () => {
  const token = jwt({ sddRole: 'CC_DEV', jti: 'unico' });
  const server = await levantarSkillServer({
    modo: 'sano',
    contratosPorToken: { [token]: CONTRATO_CC_DEV },
  });
  try {
    const room = tmpRoom('sano', { cacheToken: token, mcpToken: token, mcpUrl: server.url });
    const r = await correrVerificador(room, server.url);
    assertTerminaYNoSeCuelga(r);
    assert.match(r.contrato, /: OK —/, `el chequeo 4 tenia que bajar el contrato. ${r.stdout}`);
    assert.match(r.conectable, /: OK —/, `el chequeo 5 tenia que dar verde. ${r.stdout}`);
    // Y no dio verde por el camino del corte: ninguna de las dos lineas lo nombra.
    assert.doesNotMatch(r.contrato, /deadline/);
    assert.doesNotMatch(r.conectable, /deadline/);
  } finally {
    await server.close();
  }
});

// ---------- 2. el cuelgue reproducido: GET /sse sin cabeceras ----------

test('2. GET /sse aceptado y sin cabeceras — el chequeo 4 se corta en rojo y el proceso termina', async () => {
  const token = jwt({ sddRole: 'CC_DEV', jti: 'unico' });
  const server = await levantarSkillServer({ modo: 'sin-cabeceras-sse' });
  try {
    const room = tmpRoom('sse-mudo', { cacheToken: token, mcpToken: token, mcpUrl: server.url });
    const r = await correrVerificador(room, server.url);
    assertTerminaYNoSeCuelga(r);
    assert.match(r.contrato, /: FAIL —/, `un chequeo cortado nunca puede dar verde. ${r.stdout}`);
    assert.match(
      r.contrato,
      /deadline de \d+ ms y se corto/,
      `el rojo tiene que nombrar el corte. ${r.stdout}`,
    );
    assert.match(r.veredicto, /NO SERVIDO/);
  } finally {
    await server.close();
  }
});

// ---------- 3. el segundo agujero: POST /messages sin cabeceras ----------

test('3. POST /messages aceptado y sin cabeceras — el chequeo 4 se corta en rojo y el proceso termina', async () => {
  const token = jwt({ sddRole: 'CC_DEV', jti: 'unico' });
  const server = await levantarSkillServer({ modo: 'sin-cabeceras-post' });
  try {
    const room = tmpRoom('post-mudo', { cacheToken: token, mcpToken: token, mcpUrl: server.url });
    const r = await correrVerificador(room, server.url);
    assertTerminaYNoSeCuelga(r);
    assert.match(r.contrato, /: FAIL —/, `un chequeo cortado nunca puede dar verde. ${r.stdout}`);
    assert.match(r.veredicto, /NO SERVIDO/);
  } finally {
    await server.close();
  }
});

// ---------- 4. SSE abierto pero la respuesta JSON-RPC no llega ----------

test('4. sin respuesta JSON-RPC — el chequeo 4 sale en rojo y el proceso termina', async () => {
  const token = jwt({ sddRole: 'CC_DEV', jti: 'unico' });
  const server = await levantarSkillServer({ modo: 'sin-respuesta-rpc' });
  try {
    const room = tmpRoom('rpc-mudo', { cacheToken: token, mcpToken: token, mcpUrl: server.url });
    const r = await correrVerificador(room, server.url);
    assertTerminaYNoSeCuelga(r);
    assert.match(r.contrato, /: FAIL —/, `sin respuesta al initialize no hay verde. ${r.stdout}`);
    assert.match(r.veredicto, /NO SERVIDO/);
  } finally {
    await server.close();
  }
});

// ---------- 5. el corte discrimina: 4 verde, 5 cortado ----------

test('5. chequeo 4 contra el server sano y 5 contra el agujero negro — solo el 5 se corta', async () => {
  const token = jwt({ sddRole: 'CC_DEV', jti: 'unico' });
  const sano = await levantarSkillServer({
    modo: 'sano',
    contratosPorToken: { [token]: CONTRATO_CC_DEV },
  });
  const agujero = await levantarSkillServer({ modo: 'sin-cabeceras-sse' });
  try {
    // El chequeo 4 usa SPECOE_SKILL_SERVER_URL; el 5, la url del .mcp.json del room.
    const room = tmpRoom('mixto', {
      cacheToken: token,
      mcpToken: token,
      mcpUrl: agujero.url,
    });
    const r = await correrVerificador(room, sano.url);
    assertTerminaYNoSeCuelga(r);
    assert.match(r.contrato, /: OK —/, `el 4 tenia que seguir verde. ${r.stdout}`);
    assert.match(r.conectable, /: FAIL —/, `el 5 tenia que cortarse. ${r.stdout}`);
    assert.match(r.conectable, /deadline de \d+ ms y se corto/);
  } finally {
    await sano.close();
    await agujero.close();
  }
});

// ---------- 6. reproducibilidad (O5) ----------

test('6. dos corridas contra el agujero negro dan EL MISMO veredicto', async () => {
  const token = jwt({ sddRole: 'CC_DEV', jti: 'unico' });
  const server = await levantarSkillServer({ modo: 'sin-cabeceras-sse' });
  try {
    const room = tmpRoom('repro', { cacheToken: token, mcpToken: token, mcpUrl: server.url });
    const a = await correrVerificador(room, server.url);
    const b = await correrVerificador(room, server.url);
    assertTerminaYNoSeCuelga(a);
    assertTerminaYNoSeCuelga(b);
    assert.equal(a.veredicto, b.veredicto, `dos corridas, dos veredictos. ${a.stdout}${b.stdout}`);
    assert.equal(a.code, b.code, 'el exit code tambien tiene que repetirse');
  } finally {
    await server.close();
  }
});
