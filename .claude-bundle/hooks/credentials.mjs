// SPEC-0005 F3 — credentials module (F5 cleanup 2026-05-01: legacy .env fallback removido)
// Provides getCredentials({ email?, password?, url? }) resolved through a cascade:
//   1. env vars INTEGRA_HUB_EMAIL/PASSWORD/URL (dev shell / CI — precedencia absoluta)
//   2. keyring nativo del SO (via @napi-rs/keyring — Win Credential Manager / macOS Keychain / Linux Secret Service)
//   3. fallback dotenv cifrado AES-256-GCM con clave derivada de machine-id + user (Linux headless / CI)
//
// Retorna siempre { email, password, url } explicito — sin side-effects en process.env.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { loadKeyring as loadVendoredKeyring } from './vendor-deps.mjs';

const SERVICE = 'integra-hub-claude-code';
const URL_SUFFIX = ':url';
const CIPHER_FILE = path.join(os.homedir(), '.claude', 'integra-hub.enc');
const ACCOUNT_FILE = path.join(os.homedir(), '.claude', 'integra-hub-account.json');
const DEFAULT_URL = 'http://localhost:3000/api/v1';

// ----- account hint (plaintext, email-only, sin password) -----
// El keyring se consulta con (service, account). Necesitamos saber que account buscar
// cuando no hay env var ni .env. Este archivo guarda solo el email — no es secreto.

async function readKnownEmail() {
  try {
    const raw = await fs.readFile(ACCOUNT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.email === 'string' && parsed.email ? parsed.email : null;
  } catch {
    return null;
  }
}

async function writeKnownEmail(email) {
  if (!email) return;
  await fs.mkdir(path.dirname(ACCOUNT_FILE), { recursive: true });
  await fs.writeFile(
    ACCOUNT_FILE,
    JSON.stringify({ email, service: SERVICE, updatedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
}

async function deleteKnownEmail() {
  try {
    await fs.unlink(ACCOUNT_FILE);
  } catch {
    /* ignore */
  }
}

// ----- keyring (primary) -----

let keyringModule; // null=sin cargar, false=no disponible, {Entry}=cargado

async function loadKeyring() {
  if (keyringModule !== undefined) return keyringModule;
  try {
    // TKT-0314 — vendor primero, node_modules despues. Ver vendor-deps.mjs.
    keyringModule = await loadVendoredKeyring();
  } catch {
    keyringModule = false;
  }
  return keyringModule;
}

export async function getFromKeyring(email) {
  if (!email) return null;
  const mod = await loadKeyring();
  if (!mod) return null;
  try {
    const { Entry } = mod;
    const passwordEntry = new Entry(SERVICE, email);
    const urlEntry = new Entry(`${SERVICE}${URL_SUFFIX}`, email);
    const password = passwordEntry.getPassword();
    if (!password) return null;
    const url = urlEntry.getPassword() || DEFAULT_URL;
    return { email, password, url };
  } catch {
    // keyring disponible pero sin permiso o sin D-Bus -> caller decide fallback
    return null;
  }
}

export async function setToKeyring({ email, password, url }) {
  if (!email || !password) throw new Error('setToKeyring requires email + password');
  const mod = await loadKeyring();
  if (!mod) throw new Error('@napi-rs/keyring no instalado');
  const { Entry } = mod;
  new Entry(SERVICE, email).setPassword(password);
  if (url) new Entry(`${SERVICE}${URL_SUFFIX}`, email).setPassword(url);
  // Persist email hint para que getCredentials() pueda hacer lookup sin env var ni .env.
  await writeKnownEmail(email);
}

export async function deleteFromKeyring(email) {
  if (!email) return false;
  const mod = await loadKeyring();
  if (!mod) return false;
  const { Entry } = mod;
  let deleted = false;
  try {
    deleted = new Entry(SERVICE, email).deletePassword() || deleted;
  } catch {
    /* ignore */
  }
  try {
    deleted = new Entry(`${SERVICE}${URL_SUFFIX}`, email).deletePassword() || deleted;
  } catch {
    /* ignore */
  }
  // Limpiar el hint si lo borramos todo para no quedar con referencias stale.
  await deleteKnownEmail();
  return deleted;
}

// ----- fallback dotenv cifrado (Linux headless / CI) -----

function deriveKey() {
  let machineId = os.hostname();
  try {
    const idPath = process.platform === 'linux' ? '/etc/machine-id' : null;
    if (idPath) {
      const id = require('node:fs').readFileSync(idPath, 'utf8').trim();
      if (id) machineId = id;
    }
  } catch {
    /* ignore */
  }
  const user = os.userInfo().username || 'default';
  const material = `${machineId}:${user}:${SERVICE}`;
  return crypto.scryptSync(material, 'spec-0005-salt-v1', 32);
}

export function encryptBlob(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptBlob(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function parseDotenvString(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(INTEGRA_HUB_EMAIL|INTEGRA_HUB_PASSWORD|INTEGRA_HUB_URL)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    out[key] = value.replace(/^['"]|['"]$/g, '');
  }
  if (!out.INTEGRA_HUB_EMAIL || !out.INTEGRA_HUB_PASSWORD) return null;
  return {
    email: out.INTEGRA_HUB_EMAIL,
    password: out.INTEGRA_HUB_PASSWORD,
    url: out.INTEGRA_HUB_URL || DEFAULT_URL,
  };
}

async function getFromCipherFile() {
  try {
    const raw = await fs.readFile(CIPHER_FILE, 'utf8');
    const plaintext = decryptBlob(raw.trim());
    return parseDotenvString(plaintext);
  } catch {
    return null;
  }
}

export async function setToCipherFile({ email, password, url }) {
  if (!email || !password) throw new Error('setToCipherFile requires email + password');
  const lines = [`INTEGRA_HUB_EMAIL=${email}`, `INTEGRA_HUB_PASSWORD=${password}`];
  if (url) lines.push(`INTEGRA_HUB_URL=${url}`);
  const encrypted = encryptBlob(lines.join('\n'));
  await fs.mkdir(path.dirname(CIPHER_FILE), { recursive: true });
  await fs.writeFile(CIPHER_FILE, encrypted, { mode: 0o600 });
  // Consistencia: el hint de email tambien cuando caemos al cipher file.
  await writeKnownEmail(email);
}

// ----- env vars (dev shell / CI) -----

function getFromEnvVars() {
  const email = process.env.INTEGRA_HUB_EMAIL;
  const password = process.env.INTEGRA_HUB_PASSWORD;
  const url = process.env.INTEGRA_HUB_URL || process.env.INTEGRA_HUB_API_URL;
  if (!email || !password) return null;
  return { email, password, url: url || DEFAULT_URL };
}

// ----- cascade principal -----

let cachedCreds = null;

export async function getCredentials({ force = false } = {}) {
  if (cachedCreds && !force) return cachedCreds;

  // 1. Env vars completas (email + password) — precedencia absoluta para dev shell/CI.
  const envCreds = getFromEnvVars();
  if (envCreds) {
    cachedCreds = envCreds;
    return cachedCreds;
  }

  // 2. Keyring — necesita un email como hint. Busca candidatos en este orden:
  //    a) env var INTEGRA_HUB_EMAIL
  //    b) ~/.claude/integra-hub-account.json (hint persistido al escribir al keyring)
  const candidateEmails = [];
  const envEmail = process.env.INTEGRA_HUB_EMAIL;
  if (envEmail) candidateEmails.push(envEmail);
  const knownEmail = await readKnownEmail();
  if (knownEmail && !candidateEmails.includes(knownEmail)) candidateEmails.push(knownEmail);

  for (const email of candidateEmails) {
    const fromKeyring = await getFromKeyring(email);
    if (fromKeyring) {
      cachedCreds = fromKeyring;
      return cachedCreds;
    }
  }

  // 3. Cipher file (Linux headless sin Secret Service).
  const fromCipher = await getFromCipherFile();
  if (fromCipher) {
    cachedCreds = fromCipher;
    return cachedCreds;
  }

  throw new Error(
    'Credenciales del Hub no configuradas. Opciones:\n' +
      `  1. Keyring del SO (recomendado): node ${path.join(os.homedir(), '.claude', 'scripts', 'migrate-hub-credentials.mjs')}\n` +
      '  2. Env vars: setear INTEGRA_HUB_EMAIL + INTEGRA_HUB_PASSWORD',
  );
}
// ----- helpers para tests / debug -----

export function _resetCache() {
  cachedCreds = null;
}

export function _getCacheSnapshot() {
  return cachedCreds ? { ...cachedCreds, password: '***' } : null;
}

// Para el script de migracion: funcion que elige el mejor backend disponible y graba.
export async function writeCredentialsToBestBackend({ email, password, url }) {
  const mod = await loadKeyring();
  if (mod) {
    try {
      await setToKeyring({ email, password, url });
      return { backend: 'keyring', ok: true };
    } catch (err) {
      // keyring fallo — caer a cipher file (Linux headless sin Secret Service)
    }
  }
  await setToCipherFile({ email, password, url });
  return { backend: 'cipher-file', ok: true };
}
