#!/usr/bin/env node
// SPEC-0001 F3 T8 — Session start hook para validar licencia SpecOE.
//
// Se registra en ~/.claude/settings.json como SessionStart hook.
// Flujo:
//   1. Lee license key del keyring (SPEC-0005) o de env var SPECOE_LICENSE_KEY.
//   2. Genera machine fingerprint local (hostname, os, cpuModel, pseudo-diskSerial).
//   3. POST /api/v1/license/validate al Hub.
//   4. Si OK -> setea SPECOE_TIER / SPECOE_TOKEN / SPECOE_FEATURES en el entorno
//      (via output JSON que Claude Code lee) y cachea resultado en ~/.claude/specoe-license-cache.json.
//   5. Si falla la red: si cache < offlineGraceHours (tier), usar cache (grace period).
//   6. Si cache stale: degrada — solo skills libres accesibles (sin SPECOE_TOKEN).
//
// NUNCA bloquea el cierre de Claude Code — exit 0 siempre.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import tls from 'node:tls';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// TKT-0187 fix #3 / multi-rol — el .mcp.json, el project.config.yaml y el cache de
// licencia viven en el project dir (cwd de la sesion Claude Code). Claude Code expone
// CLAUDE_PROJECT_DIR a los hooks.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MCP_JSON_FILE = path.join(PROJECT_DIR, '.mcp.json');
const DEFAULT_SKILL_SERVER_URL =
  process.env.SPECOE_SKILL_SERVER_URL || 'https://mcp.integra.local/sse';

// TKT-0187 multi-rol — cache POR-CARPETA (antes global en ~/.claude). Un dev con varios
// roles a la vez (uno por carpeta) tenia un unico cache global y el ultimo rol pisaba a
// los demas. Ahora cada carpeta cachea su propia licencia + JWT.
const CACHE_FILE = path.join(PROJECT_DIR, '.claude', 'specoe-license-cache.json');
const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');
// TKT-0187 fix #2 — la URL del Hub ya NO es un hardcode fijo: se resuelve en runtime
// (env > project.config.yaml > este fallback interno). Ver resolveHubUrl().
const FALLBACK_HUB_URL = 'http://integra-hub:8100/api/v1';
const DEFAULT_GRACE_HOURS = 24;

// ----- fingerprint generation (cliente-side, SPEC-0001 F7 Item 5) -----
// Composicion: machineId (node-machine-id) + cpuModel + cpuCount + diskSerial nativo.
// Hostname y os son audit-only (no participan del hash).

async function getMachineId() {
  try {
    // node-machine-id es CommonJS — dynamic import retorna { default: module.exports }
    const mod = await import('node-machine-id');
    const lib = mod.default ?? mod;
    if (typeof lib.machineIdSync === 'function') {
      return lib.machineIdSync(true); // true = hex raw (sin hash interno de la lib)
    }
    if (typeof lib.machineId === 'function') {
      return await lib.machineId(true);
    }
    throw new Error('node-machine-id sin export reconocido');
  } catch {
    // Lib no instalada o falla — fallback determinista por hostname+user.
    return `fallback:${os.hostname()}:${os.userInfo().username}`;
  }
}

async function getDiskSerial() {
  try {
    if (process.platform === 'win32') {
      // wmic (legacy pero estable) — el nuevo `Get-CimInstance` requiere PowerShell
      const { stdout } = await execFileAsync(
        'wmic',
        [
          'diskdrive',
          'where',
          "MediaType='Fixed hard disk media'",
          'get',
          'SerialNumber',
          '/value',
        ],
        { timeout: 3000 },
      );
      const match = stdout.match(/SerialNumber=(.+)/);
      return match ? match[1].trim() : '';
    }
    if (process.platform === 'linux') {
      // Primera bloque device no-removable (sda/nvme0n1 típico)
      const blocks = await fs.readdir('/sys/block');
      for (const name of blocks) {
        if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('sr')) continue;
        const serialPath = `/sys/block/${name}/device/serial`;
        try {
          const s = (await fs.readFile(serialPath, 'utf8')).trim();
          if (s) return s;
        } catch {
          /* ignore, probar siguiente */
        }
      }
      return '';
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOAHCIBlockStorageDevice'], {
        timeout: 3000,
      });
      const match =
        stdout.match(/"IOPropertyMatch".*?"Serial Number"\s*=\s*"([^"]+)"/s) ??
        stdout.match(/"Serial Number"\s*=\s*"([^"]+)"/);
      return match ? match[1].trim() : '';
    }
    return '';
  } catch {
    return ''; // Cualquier error → headless fallback
  }
}

async function computeLocalFingerprint() {
  const machineId = await getMachineId();
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const cpuCount = cpus.length || 1;
  const diskSerial = await getDiskSerial();
  return {
    machineId,
    cpuModel,
    cpuCount,
    diskSerial: diskSerial || undefined,
    hostname: os.hostname(),
    os: `${os.platform()} ${os.release()}`,
  };
}

// ----- cache helpers -----

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(data) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function isCacheWithinGrace(cache, graceHours) {
  if (!cache?.validatedAt) return false;
  const ageMs = Date.now() - new Date(cache.validatedAt).getTime();
  return ageMs < graceHours * 60 * 60 * 1000;
}

// ----- logging -----

async function logLine(obj) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `specoe-license-${today}.log`);
    await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    /* no romper por log */
  }
}

// ----- license key lookup -----

// TKT-0187 multi-rol — rol SDD de la carpeta, leido del project.config.yaml del cwd. Es el
// account del keyring donde vive la licencia de ESTE rol (Entry specoe-license/<rol>).
// Vacio/ausente => modo 1-rol legacy (account 'default'). Parser minimo: la unica clave
// `role:` del yaml vive bajo `specoe:` y el rol es mayusculas.
async function resolveRole() {
  try {
    const yaml = await fs.readFile(path.join(PROJECT_DIR, 'project.config.yaml'), 'utf8');
    // Tolera comentario inline (el template trae `role: '' # DISCOVERY | ...`).
    const m = yaml.match(/^\s*role:\s*['"]?([A-Z_]+)['"]?\s*(#.*)?$/m);
    return m && m[1] ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function getLicenseKey() {
  // 1. Env var
  if (process.env.SPECOE_LICENSE_KEY) return process.env.SPECOE_LICENSE_KEY;

  // 2. Keyring (SPEC-0005) — multi-rol: account = rol de la carpeta; fallback 'default'
  //    (retrocompat 1-rol). getPassword tira si el account no existe → probamos uno a uno.
  try {
    const kr = await import('@napi-rs/keyring').catch(() => null);
    if (kr) {
      const { Entry } = kr;
      const role = await resolveRole();
      for (const account of [role, 'default'].filter(Boolean)) {
        try {
          const key = new Entry('specoe-license', account).getPassword();
          if (key) return key;
        } catch {
          /* account inexistente — probar el siguiente */
        }
      }
    }
  } catch {
    /* keyring no disponible */
  }

  // 3. Cache file de ultima validacion (retiene key para offline grace)
  const cache = await readCache();
  if (cache?.licenseKey) return cache.licenseKey;

  return null;
}

// ----- TKT-0187 helpers: ca dispatcher + hub url + activate + skill jwt -----

// bug#2 — carga el CA de Caddy explícito para el fetch. NODE_EXTRA_CA_CERTS NO llega al
// hook cuando corre en la extensión VSCode (sí en el CLI `claude`); sin el CA, el fetch
// al Hub (cert `tls internal` de Caddy) falla ("fetch failed") y el hook degrada sin
// poblar el JWT. Leemos el CA de ~/.claude/caddy-local-root.crt y lo instalamos como
// dispatcher global de undici → TODO fetch confía en el cert, sin depender de la env.
// Fail-open: sin CA en disco o sin undici, seguimos con el trust default.
async function installCaDispatcher() {
  try {
    const caPath = path.join(os.homedir(), '.claude', 'caddy-local-root.crt');
    const ca = await fs.readFile(caPath, 'utf8');
    const { Agent, setGlobalDispatcher } = await import('undici');
    // Combinamos con los root certs del sistema (no reemplazarlos): así el CA de Caddy
    // suma al trust default, sin romper conexiones a CAs públicos.
    setGlobalDispatcher(new Agent({ connect: { ca: [...tls.rootCertificates, ca] } }));
    await logLine({ level: 'info', msg: 'CA dispatcher instalado (undici)' });
  } catch (err) {
    await logLine({ level: 'warn', msg: 'no se pudo instalar CA dispatcher', error: err?.message });
  }
}

// fix #2 — resuelve la URL del Hub. Precedencia: env INTEGRA_HUB_URL >
// hub.api-url de project.config.yaml (del project dir) > fallback interno.
// Parser minimo sin dep: la unica clave `api-url:` del yaml vive bajo `hub:`.
async function resolveHubUrl() {
  if (process.env.INTEGRA_HUB_URL) return process.env.INTEGRA_HUB_URL;
  try {
    const yaml = await fs.readFile(path.join(PROJECT_DIR, 'project.config.yaml'), 'utf8');
    const m = yaml.match(/^\s*api-url:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    if (m && m[1]) return m[1].trim();
  } catch {
    /* sin yaml en el project dir — cae al fallback */
  }
  return FALLBACK_HUB_URL;
}

// fix #1 — activa el fingerprint antes de validar. Idempotente por (licenseId,
// fingerprintHash): reusar la misma maquina NO consume seat nuevo (license.service.ts
// activate()). validate() exige el fingerprint ya activado, asi que un dev nuevo lo
// necesita en el primer arranque. Nunca bloquea: si falla, seguimos a validate/grace.
async function activateFingerprint(hubUrl, licenseKey, fingerprint) {
  try {
    const res = await fetch(`${hubUrl}/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, fingerprint }),
    });
    if (res.ok) {
      await logLine({ level: 'info', msg: 'fingerprint activado' });
      return true;
    }
    await logLine({ level: 'warn', msg: 'activate fallo', status: res.status });
  } catch (err) {
    await logLine({ level: 'warn', msg: 'activate network error', error: err?.message });
  }
  return false;
}

// fix #3 — el MCP server `specoe` de .mcp.json necesita el JWT de licencia en el header
// Authorization. Dos mecanismos combinados porque el timing SessionStart-vs-lectura-de-
// .mcp.json de Claude Code no esta garantizado por doc:
//   (B) escribe `export SPECOE_SKILL_JWT=<jwt>` a $CLAUDE_ENV_FILE — el placeholder
//       ${SPECOE_SKILL_JWT} del .mcp.json se expande con la var fresca de este arranque.
//   (A) reescribe .mcp.json con el JWT inline — garantiza header no vacio aunque (B) no
//       cargue a tiempo. Refresca en cada arranque (el JWT de licencia vive 1h).
async function populateSkillJwt(token) {
  // (B) $CLAUDE_ENV_FILE — mecanismo soportado para que un hook inyecte env a la sesion.
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    try {
      await fs.appendFile(envFile, `export SPECOE_SKILL_JWT=${token}\n`);
    } catch (err) {
      await logLine({
        level: 'warn',
        msg: 'no se pudo escribir CLAUDE_ENV_FILE',
        error: err?.message,
      });
    }
  }
  // (A) .mcp.json con JWT inline — fallback. Preserva otros mcpServers si el archivo existe;
  // resuelve la url del server `specoe` inline (nunca deja un ${...} sin expandir).
  try {
    let doc = { mcpServers: {} };
    try {
      doc = JSON.parse(await fs.readFile(MCP_JSON_FILE, 'utf8'));
      if (!doc || typeof doc !== 'object') doc = { mcpServers: {} };
      if (!doc.mcpServers) doc.mcpServers = {};
    } catch {
      /* no existe o corrupto — se genera desde cero */
    }
    const prev = doc.mcpServers.specoe || {};
    const url =
      typeof prev.url === 'string' && !prev.url.includes('${')
        ? prev.url
        : DEFAULT_SKILL_SERVER_URL;
    doc.mcpServers.specoe = {
      type: 'sse',
      url,
      headers: { Authorization: `Bearer ${token}` },
    };
    await fs.writeFile(MCP_JSON_FILE, JSON.stringify(doc, null, 2) + '\n');
  } catch (err) {
    await logLine({ level: 'warn', msg: 'no se pudo actualizar .mcp.json', error: err?.message });
  }
}

// ----- main -----

async function main() {
  const licenseKey = await getLicenseKey();
  if (!licenseKey) {
    await logLine({ level: 'warn', msg: 'no license key encontrada — skills libres solamente' });
    console.log(JSON.stringify({ specoeStatus: 'no-license' }));
    return 0;
  }

  const fingerprint = await computeLocalFingerprint();
  const hubUrl = await resolveHubUrl(); // TKT-0187 fix #2

  // TKT-0187 bug#2 — instalar el CA de Caddy en el fetch ANTES de cualquier request al Hub.
  await installCaDispatcher();

  // TKT-0187 fix #1 — activar el fingerprint (idempotente) antes de validar.
  await activateFingerprint(hubUrl, licenseKey, fingerprint);

  try {
    const res = await fetch(`${hubUrl}/license/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, fingerprint }),
    });
    if (res.ok) {
      const body = await res.json();
      const cached = {
        licenseKey,
        validatedAt: new Date().toISOString(),
        token: body.token,
        tenantId: body.tenantId,
        tier: body.tier,
        features: body.features,
      };
      await writeCache(cached);
      // TKT-0187 fix #3 — poblar el JWT del skill-server para el MCP `specoe`.
      await populateSkillJwt(body.token);
      await logLine({ level: 'info', msg: 'license validated', tier: body.tier });
      // Output JSON para el harness (puede usar hookSpecificOutput para env vars).
      console.log(
        JSON.stringify({
          specoeStatus: 'ok',
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: `SpecOE license: tier=${body.tier}, features=${body.features.length}`,
          },
        }),
      );
      return 0;
    }
    await logLine({ level: 'warn', msg: 'validate failed', status: res.status });
    // Fallthrough al grace period
  } catch (err) {
    await logLine({ level: 'warn', msg: 'validate network error', error: err?.message });
  }

  // Grace period: usar cache si esta fresco
  const cache = await readCache();
  const graceHours = DEFAULT_GRACE_HOURS; // TODO: leer de tier-specific config
  if (cache && isCacheWithinGrace(cache, graceHours)) {
    await logLine({ level: 'info', msg: 'using cached license (offline grace)', tier: cache.tier });
    console.log(
      JSON.stringify({
        specoeStatus: 'cached',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `SpecOE license (offline, cache fresco): tier=${cache.tier}`,
        },
      }),
    );
    return 0;
  }

  // Degradacion: sin token, solo skills libres
  await logLine({ level: 'warn', msg: 'degraded — no valid license + cache stale' });
  console.log(
    JSON.stringify({
      specoeStatus: 'degraded',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'SpecOE license invalida y cache expirado — solo skills libres disponibles',
      },
    }),
  );
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch(async (err) => {
    await logLine({ level: 'error', msg: 'unhandled', error: err?.message, stack: err?.stack });
    // NUNCA bloquear sesion.
    process.exit(0);
  });
