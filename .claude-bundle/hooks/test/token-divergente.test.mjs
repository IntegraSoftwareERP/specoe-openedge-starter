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
} from '../specoe-room-bootstrap.mjs';

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
