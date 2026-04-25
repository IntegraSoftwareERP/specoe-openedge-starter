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
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const CACHE_FILE = path.join(os.homedir(), '.claude', 'specoe-license-cache.json');
const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');
const DEFAULT_HUB_URL = process.env.INTEGRA_HUB_URL || 'http://integra-hub:8100/api/v1';
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
      const { stdout } = await execFileAsync('wmic', [
        'diskdrive', 'where', "MediaType='Fixed hard disk media'",
        'get', 'SerialNumber', '/value',
      ], { timeout: 3000 });
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
        } catch { /* ignore, probar siguiente */ }
      }
      return '';
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', [
        '-rd1', '-c', 'IOAHCIBlockStorageDevice',
      ], { timeout: 3000 });
      const match = stdout.match(/"IOPropertyMatch".*?"Serial Number"\s*=\s*"([^"]+)"/s)
        ?? stdout.match(/"Serial Number"\s*=\s*"([^"]+)"/);
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

async function getLicenseKey() {
  // 1. Env var
  if (process.env.SPECOE_LICENSE_KEY) return process.env.SPECOE_LICENSE_KEY;

  // 2. Keyring (SPEC-0005)
  try {
    const kr = await import('@napi-rs/keyring').catch(() => null);
    if (kr) {
      const { Entry } = kr;
      const entry = new Entry('specoe-license', 'default');
      const key = entry.getPassword();
      if (key) return key;
    }
  } catch {
    /* keyring no disponible */
  }

  // 3. Cache file de ultima validacion (retiene key para offline grace)
  const cache = await readCache();
  if (cache?.licenseKey) return cache.licenseKey;

  return null;
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

  try {
    const res = await fetch(`${DEFAULT_HUB_URL}/license/validate`, {
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
      await logLine({ level: 'info', msg: 'license validated', tier: body.tier });
      // Output JSON para el harness (puede usar hookSpecificOutput para env vars).
      console.log(JSON.stringify({
        specoeStatus: 'ok',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `SpecOE license: tier=${body.tier}, features=${body.features.length}`,
        },
      }));
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
    console.log(JSON.stringify({
      specoeStatus: 'cached',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `SpecOE license (offline, cache fresco): tier=${cache.tier}`,
      },
    }));
    return 0;
  }

  // Degradacion: sin token, solo skills libres
  await logLine({ level: 'warn', msg: 'degraded — no valid license + cache stale' });
  console.log(JSON.stringify({
    specoeStatus: 'degraded',
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'SpecOE license invalida y cache expirado — solo skills libres disponibles',
    },
  }));
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch(async (err) => {
    await logLine({ level: 'error', msg: 'unhandled', error: err?.message, stack: err?.stack });
    // NUNCA bloquear sesion.
    process.exit(0);
  });
