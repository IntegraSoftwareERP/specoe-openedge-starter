// SPEC-0137 P3 (TSK-0581) — canal de secretos generalizado.
//
// Generaliza el mecanismo de SPEC-0005 (credentials.mjs, cableado SOLO a hub-auth,
// RE-007) a secretos ARBITRARIOS identificados por (service, name): act-as per-rol,
// SPECOE_JWT, licencias .pem, etc. Mismo backend que 0005 y en el MISMO orden:
//   1. keyring nativo del SO (@napi-rs/keyring — Win Credential Manager / macOS
//      Keychain / Linux Secret Service)
//   2. fallback dotenv cifrado AES-256-GCM por (service, name) en ~/.claude/secrets/
//
// Reusa encryptBlob/decryptBlob de credentials.mjs (ADR-004) — NO duplica cripto y
// NO toca la API de credentials (getCredentials sigue igual, RE-007).

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { encryptBlob, decryptBlob } from './credentials.mjs';
import { loadKeyring as loadVendoredKeyring } from './vendor-deps.mjs';
import { fileURLToPath } from 'node:url';

// HOME override (CLAUDE_HOME) para portabilidad + testing aislado, igual que deploy-hooks.mjs.
const HOME = process.env.CLAUDE_HOME || os.homedir();
const SECRETS_DIR = path.join(HOME, '.claude', 'secrets');

// ----- keyring (primary) -----

let keyringModule; // undefined=sin cargar, false=no disponible, {Entry}=cargado

async function loadKeyring() {
  // Modo cipher-only explicito (CI headless / testing): salta el keyring del SO.
  if (process.env.INTEGRA_SECRETS_NO_KEYRING === '1') return false;
  if (keyringModule !== undefined) return keyringModule;
  try {
    // TKT-0314 — el binding sale del vendor del bundle y solo cae a node_modules si el vendor
    // no cubre esta plataforma. El try/catch de aca no cambia: sin keyring se degrada al
    // cipher file, que es el contrato que este modulo ya tenia.
    keyringModule = await loadVendoredKeyring();
  } catch {
    keyringModule = false;
  }
  return keyringModule;
}

function assertKey(service, name) {
  if (!service || !name) throw new Error('secrets: se requieren (service, name) no vacios');
}

// Ruta del cipher file por (service, name). Sanitiza para nombre de archivo seguro.
function cipherPath(service, name) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(SECRETS_DIR, `${safe(service)}__${safe(name)}.enc`);
}

// ----- API publica -----

/**
 * Graba un secreto por (service, name). Intenta keyring; si no hay, cae al cipher
 * file cifrado. Devuelve { backend }. El valor NO queda en claro en ningun archivo.
 */
export async function setSecret(service, name, value) {
  assertKey(service, name);
  if (value === undefined || value === null || value === '') {
    throw new Error('secrets.setSecret: value vacio');
  }
  const mod = await loadKeyring();
  if (mod) {
    try {
      const { Entry } = mod;
      new Entry(service, name).setPassword(String(value));
      return { backend: 'keyring' };
    } catch {
      // keyring presente pero sin permiso / sin D-Bus -> cae al cipher file
    }
  }
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  await fs.writeFile(cipherPath(service, name), encryptBlob(String(value)), { mode: 0o600 });
  return { backend: 'cipher-file' };
}

/**
 * Lee un secreto por (service, name). Keyring primero, cipher file despues.
 * Devuelve el string, o null si no existe en ningun backend.
 */
export async function getSecret(service, name) {
  assertKey(service, name);
  const mod = await loadKeyring();
  if (mod) {
    try {
      const { Entry } = mod;
      const v = new Entry(service, name).getPassword();
      if (v) return v;
    } catch {
      // sin permiso -> intenta cipher file
    }
  }
  try {
    const raw = await fs.readFile(cipherPath(service, name), 'utf8');
    return decryptBlob(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Borra un secreto por (service, name) de ambos backends. Devuelve true si borro algo.
 */
export async function deleteSecret(service, name) {
  assertKey(service, name);
  let deleted = false;
  const mod = await loadKeyring();
  if (mod) {
    try {
      const { Entry } = mod;
      deleted = new Entry(service, name).deletePassword() || deleted;
    } catch {
      /* ignore */
    }
  }
  try {
    await fs.unlink(cipherPath(service, name));
    deleted = true;
  } catch {
    /* no cipher file */
  }
  return deleted;
}

/**
 * getSecret que tira si falta — para consumidores que no pueden operar sin el secreto
 * (p.ej. un launcher que necesita el act-as). Mensaje claro con la via de grabado.
 */
export async function requireSecret(service, name) {
  const v = await getSecret(service, name);
  if (!v) {
    throw new Error(
      `Secreto ausente: (${service}, ${name}). Grabalo por el canal:\n` +
        `  node ${path.join(os.homedir(), '.claude', 'scripts', 'provision-secrets.mjs')} ${service} ${name}`,
    );
  }
  return v;
}

// ----- convencion de nombres del canal (una sola fuente de verdad) -----
// service para los act-as per-rol del SDD; name = `${tenantId}:${role}` (P1).
export const ACT_AS_SERVICE = 'integra-sdd-act-as';

// SPEC-0155 P5 (ADR-003 v4) — service DISTINTO del anterior para no mezclar el
// ServiceAccountToken (identidad base recuperable del robot) con los secretos
// act-as per-rol; name = tenantId.
export const ROBOT_LOGIN_SERVICE = 'integra-sdd-robot-login';

// ---- CLI minimo para consumidores (p.ej. los launchers) ----
// `node secrets.mjs get <service> <name>` imprime el valor a stdout (para capturar
// en una env efimera) o sale con codigo 1 si el secreto no esta en el canal. No
// escribe nada; solo lee. Se activa unicamente si el modulo se invoca directo.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const [cmd, service, name] = process.argv.slice(2);
  if (cmd === 'get' && service && name) {
    const v = await getSecret(service, name);
    if (v == null) {
      process.stderr.write(`secrets: secreto ausente (${service}, ${name})\n`);
      process.exit(1);
    }
    process.stdout.write(v);
    process.exit(0);
  }
  process.stderr.write('uso: node secrets.mjs get <service> <name>\n');
  process.exit(2);
}
