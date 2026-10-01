// SPEC-0237 P4 — fixtures compartidas de las suites de la entrada del proxy: un room con el proxy
// REAL vendorizado y su MANIFEST, un HOME de prueba con los modulos de maquina que el proxy usa, un
// skill-server falso que habla MCP sobre SSE y un Hub falso. `node --test` (no es una suite: no
// termina en .test.mjs).
//
// Nada toca la instalacion del dev: room y HOME son temporales, y cada corrida va con un entorno
// limpio de las variables que cambiarian el escenario (rol declarado, CLAUDE_ENV_FILE, CA, URLs).
//
// El proxy es el archivo de vendor/ del starter, el mismo que llega a cada room: los escritores y
// los lectores se miden contra el producto, no contra una copia de su forma.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOKS_DIR = path.resolve(HERE, '..', '..');
export const BUNDLE_DIR = path.resolve(HOOKS_DIR, '..');
export const STARTER_DIR = path.resolve(BUNDLE_DIR, '..');
export const VENDOR_PROXY = path.join(STARTER_DIR, 'vendor', 'specoe-mcp-proxy.mjs');
export const LICENSE_CHECK = path.join(HOOKS_DIR, 'specoe-license-check.mjs');
export const ROOM_BOOTSTRAP = path.join(HOOKS_DIR, 'specoe-room-bootstrap.mjs');
export const VERIFIER = path.join(BUNDLE_DIR, 'scripts', 'verify-room-serving.mjs');

/** Cualquier string con forma de JWT (tres segmentos base64url). */
export const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;

/**
 * La entrada lanza el proxy con `node --use-system-ca` (ADR-001), un flag que Node 20 no conoce: el
 * CI del monorepo corre tambien Node 20. Las suites que lanzan el proxy se saltean ahi con este
 * motivo VISIBLE en vez de dar un rojo que no es del starter. Se mide el flag, no la version.
 */
export const USE_SYSTEM_CA_SKIP =
  spawnSync(process.execPath, ['--use-system-ca', '-e', '0']).status === 0
    ? false
    : `este Node (${process.version}) no acepta --use-system-ca, que la entrada del proxy exige`;

/** JWT sin firmar con forma de JWT real. `exp` por defecto: dentro de una hora. */
export function jwt(payload = {}, { expInSec = 3600 } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iat: now, exp: now + expInSec, ...payload })}.firmafalsa0123456789`;
}

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Room y HOME temporales, con su .claude/. */
export function makeFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-p4-${name}-`));
  const room = path.join(root, 'room');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(room, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { root, room, home };
}

/**
 * Pone el proxy en el vendor/ del room y lo declara en su MANIFEST, como lo deja el starter.
 * `estado`: 'ok' | 'sin-archivo' (declarado pero ausente) | 'sha-distinto' | 'sin-componente'
 * (room anterior al proxy: MANIFEST sin el componente y sin el archivo).
 */
export function installProxy(room, estado = 'ok') {
  const vendor = path.join(room, 'vendor');
  fs.mkdirSync(vendor, { recursive: true });
  const components = [];
  if (estado !== 'sin-componente') {
    components.push({
      name: 'specoe-mcp-proxy',
      file: 'specoe-mcp-proxy.mjs',
      artifactKind: 'file',
      packageSha256: estado === 'sha-distinto' ? '0'.repeat(64) : sha256(VENDOR_PROXY),
    });
  }
  if (estado === 'ok' || estado === 'sha-distinto')
    fs.copyFileSync(VENDOR_PROXY, path.join(vendor, 'specoe-mcp-proxy.mjs'));
  fs.writeFileSync(
    path.join(vendor, 'MANIFEST.json'),
    JSON.stringify({ schemaVersion: 2, components }, null, 2) + '\n',
  );
}

/**
 * Los modulos de maquina que el proxy busca en ~/.claude/hooks: el registro y el canal de CA REALES
 * del bundle, y un CLI de renovacion que contesta NO_LICENSE (con un JWT fresco en el cache, el
 * proxy no lo llama).
 */
export function installMachineHooks(home) {
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of ['specoe-room-ledger.mjs', 'ca-channel.mjs'])
    fs.copyFileSync(path.join(HOOKS_DIR, f), path.join(hooks, f));
  fs.writeFileSync(
    path.join(hooks, 'specoe-license-renew.mjs'),
    "process.stdout.write(JSON.stringify({ v: 1, outcome: 'NO_LICENSE' }) + '\\n');\n",
  );
}

export function writeCache(room, token) {
  fs.writeFileSync(
    path.join(room, '.claude', 'specoe-license-cache.json'),
    JSON.stringify({
      licenseKey: 'LIC-P4',
      validatedAt: new Date().toISOString(),
      token,
      tier: 'PRO',
    }),
  );
}

export function writeMcp(room, doc) {
  fs.writeFileSync(path.join(room, '.mcp.json'), JSON.stringify(doc, null, 2) + '\n');
}

export function readMcp(room) {
  return JSON.parse(fs.readFileSync(path.join(room, '.mcp.json'), 'utf8'));
}

export function readLedger(room) {
  try {
    return fs.readFileSync(path.join(room, '.claude', 'specoe-room-ledger.jsonl'), 'utf8');
  } catch {
    return '';
  }
}

export function ledgerEntries(room) {
  return readLedger(room)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Lo que escribio el hook de licencia en su log del dia, en el HOME de prueba. */
export function licenseLog(home) {
  const dir = path.join(home, '.claude', 'logs');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('specoe-license-'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('');
  } catch {
    return '';
  }
}

/** La entrada canonica, segun el PROPIO proxy: su --install-entry sobre una carpeta vacia. */
let canonical = null;
export async function canonicalEntry() {
  if (canonical) return canonical;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specoe-p4-canonica-'));
  await runNode(VENDOR_PROXY, ['--install-entry', '--room', dir], { env: cleanEnv() });
  canonical = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.specoe;
  return canonical;
}

/** process.env sin lo que cambiaria el escenario, mas `extra`. El node del test va primero en PATH. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of [
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_ENV_FILE',
    'NODE_EXTRA_CA_CERTS',
    'SPECOE_SKILL_JWT',
    'SPECOE_SKILL_SERVER_URL',
    'SPECOE_ALLOW_DEGRADED_START',
    'INTEGRA_SDD_ROLE',
    'INTEGRA_SDD_TENANT',
    'INTEGRA_HUB_URL',
  ])
    delete env[k];
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [path.dirname(process.execPath), env[pathKey] ?? ''].join(path.delimiter);
  return { ...env, ...extra };
}

/** Corre un .mjs con el node del test. Nunca tira: devuelve code, stdout y stderr. */
export function runNode(file, args = [], { env, cwd, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [file, ...args],
      { env, cwd, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 22 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });
}

/** El additionalContext de la ultima linea JSON de un hook. */
export function hookContext(stdout) {
  const last = String(stdout).trim().split('\n').filter(Boolean).pop();
  try {
    const json = JSON.parse(last);
    return { json, context: json?.hookSpecificOutput?.additionalContext ?? '' };
  } catch {
    return { json: null, context: '' };
  }
}

// ---------- skill-server falso: MCP sobre SSE, contrato POR TOKEN ----------

export const ERROR_PRODUCTO =
  'Error: room_contract_get: el bundle producto (role=null) no tiene contrato de room';

/**
 * `contratos`: token -> markdown del contrato (un token ausente es producto). `rechazar`: tokens a
 * los que el GET de /sse responde 401. `gets` registra cada apertura con su token.
 */
export async function startSkillServer({ contratos = {}, rechazar = [] } = {}) {
  const sesiones = new Map();
  const gets = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = String(req.headers.authorization ?? '')
      .replace(/^Bearer\s+/i, '')
      .trim();
    if (req.method === 'GET') {
      gets.push({ token });
      if (rechazar.includes(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'AUTH_HEADER_REJECTED' }));
        return;
      }
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
      if (msg.id === undefined) return; // notificacion
      const efectivo = token || ses.token;
      let result;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'skill-server-falso', version: '1.0.0' },
        };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'room_contract_get') {
        const contrato = contratos[efectivo];
        result = contrato
          ? { content: [{ type: 'text', text: contrato }] }
          : { isError: true, content: [{ type: 'text', text: ERROR_PRODUCTO }] };
      } else if (msg.method === 'tools/list') {
        result = { tools: [] };
      } else {
        result = {};
      }
      ses.res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/sse`,
    gets,
    async close() {
      for (const { res } of sesiones.values()) res.end();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------- Hub falso ----------

/**
 * Hub falso de /license/activate y /license/validate. `statuses` es la cola de status del validate
 * (el ultimo se repite). Con 200 devuelve `token` (o uno nuevo con `sddRole`).
 */
export async function startHub({ statuses = [200], token = null, sddRole = 'CC_DEV' } = {}) {
  const validate = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/license/activate')) return json(200, { activated: true });
      if (req.url.endsWith('/license/validate')) {
        const status = statuses[Math.min(i++, statuses.length - 1)];
        const t = token ?? jwt({ sub: 'lic-p4', sddRole });
        validate.push({ status, token: status === 200 ? t : null });
        if (status !== 200) return json(status, { message: 'rechazado por el Hub falso' });
        return json(200, { token: t, tenantId: 'tenant-p4', tier: 'team', features: ['skills'] });
      }
      return json(404, { message: 'ruta no esperada' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/v1`,
    validate,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------- TLS de prueba para el chequeo 1 del verificador ----------

/**
 * Certificado autofirmado para 127.0.0.1, generado con openssl en `dir`. Es su propio emisor: puesto
 * como ~/.claude/caddy-local-root.crt del HOME de prueba, el canal de CA del verificador lo carga y
 * el handshake contra un Hub https falso valida. null si no hay openssl (el llamador lo declara).
 */
export function selfSignedCert(dir) {
  const cfg = path.join(dir, 'openssl.cnf');
  const key = path.join(dir, 'hub.key');
  const cert = path.join(dir, 'hub.crt');
  fs.writeFileSync(
    cfg,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      'CN = 127.0.0.1',
      '[ext]',
      'subjectAltName = IP:127.0.0.1',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,digitalSignature,keyCertSign',
      'extendedKeyUsage = serverAuth',
      '',
    ].join('\n'),
  );
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      cfg,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.error || r.status !== 0 || !fs.existsSync(cert)) return null;
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/** Hub https falso: cualquier ruta contesta 200. Solo sirve para que el handshake del chequeo 1 se mida. */
export async function startHttpsHub(tls) {
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `https://127.0.0.1:${server.address().port}/api/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
