#!/usr/bin/env node
// SPEC-0005 F4 — Script CLI de migracion de credenciales del Hub.
//
// Uso:
//   node ~/.claude/scripts/migrate-hub-credentials.mjs              # migra + valida + renombra
//   node ~/.claude/scripts/migrate-hub-credentials.mjs --dry-run    # solo muestra qué haría
//   node ~/.claude/scripts/migrate-hub-credentials.mjs --force      # sobreescribe keyring si ya hay entry
//   node ~/.claude/scripts/migrate-hub-credentials.mjs --rollback   # restaura .env desde el backup
//
// Flujo:
//   1. Lee ~/.claude/integra-hub.env (el legacy plaintext).
//   2. Si no existe, error con instrucciones.
//   3. Si el keyring ya tiene entry para ese email y no se pasa --force, aborta con warning.
//   4. Escribe en el mejor backend disponible (keyring > cipher file).
//   5. Valida: purga session cache, pide getAccessToken() — si OK, confirma.
//   6. Si OK: renombra .env a .env.migrated-YYYYMMDD_HHMMSS.
//   7. Si falla: NO toca el .env, reporta el error, deja todo como estaba.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import process from 'node:process';

const HOOKS_DIR = path.join(os.homedir(), '.claude', 'hooks');
const LEGACY_ENV_FILE = path.join(os.homedir(), '.claude', 'integra-hub.env');
const SESSION_FILE = path.join(os.homedir(), '.claude', 'integra-hub-session.json');

const args = new Set(process.argv.slice(2));
const isDryRun = args.has('--dry-run');
const isForce = args.has('--force');
const isRollback = args.has('--rollback');
const showHelp = args.has('--help') || args.has('-h');

if (showHelp) {
  console.log(`Migration de credenciales del Hub -> keyring del SO.

Opciones:
  --dry-run   Solo mostrar qué haría, sin cambiar nada.
  --force     Sobreescribir keyring si ya existe una entry para ese email.
  --rollback  Restaurar .env desde el backup mas reciente (.env.migrated-*).
  --help      Mostrar esta ayuda.

Flujo:
  1. Lee ~/.claude/integra-hub.env (legacy plaintext).
  2. Detecta backend disponible (keyring nativo o cipher file fallback).
  3. Inserta credenciales.
  4. Valida con getAccessToken() contra el Hub.
  5. Si OK -> renombra .env a .env.migrated-<timestamp>.
  6. Si falla -> rollback automatico, .env intacto.
`);
  process.exit(0);
}

function log(msg) {
  console.log(msg);
}
function warn(msg) {
  process.stderr.write(`[WARN] ${msg}\n`);
}
function err(msg) {
  process.stderr.write(`[ERROR] ${msg}\n`);
}

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(INTEGRA_HUB_EMAIL|INTEGRA_HUB_PASSWORD|INTEGRA_HUB_URL)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    out[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function readLegacyEnv() {
  try {
    const raw = await fs.readFile(LEGACY_ENV_FILE, 'utf8');
    const parsed = parseDotenv(raw);
    if (!parsed.INTEGRA_HUB_EMAIL || !parsed.INTEGRA_HUB_PASSWORD) {
      throw new Error(`${LEGACY_ENV_FILE} no tiene INTEGRA_HUB_EMAIL + INTEGRA_HUB_PASSWORD requeridos`);
    }
    return {
      email: parsed.INTEGRA_HUB_EMAIL,
      password: parsed.INTEGRA_HUB_PASSWORD,
      url: parsed.INTEGRA_HUB_URL || 'http://localhost:3000/api/v1',
    };
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`No existe ${LEGACY_ENV_FILE}. No hay nada que migrar. Para crear credenciales nuevas directamente en el keyring, este script no cubre ese caso — documentado en CLAUDE.md.`);
    }
    throw e;
  }
}

async function findLatestBackup() {
  const dir = path.dirname(LEGACY_ENV_FILE);
  const base = path.basename(LEGACY_ENV_FILE);
  try {
    const files = await fs.readdir(dir);
    const backups = files
      .filter((f) => f.startsWith(`${base}.migrated-`))
      .sort()
      .reverse();
    return backups[0] ? path.join(dir, backups[0]) : null;
  } catch {
    return null;
  }
}

async function cmdRollback() {
  const backup = await findLatestBackup();
  if (!backup) {
    err(`No se encontro backup .env.migrated-*. Nada que rollback.`);
    process.exit(1);
  }
  log(`Rollback: ${backup} -> ${LEGACY_ENV_FILE}`);
  if (isDryRun) {
    log('[dry-run] — no se toca nada.');
    return;
  }
  // Verificar que no haya un .env actual que piseariamos
  try {
    await fs.access(LEGACY_ENV_FILE);
    err(`Ya existe ${LEGACY_ENV_FILE}. Borralo manualmente antes del rollback o movelo a otro lugar.`);
    process.exit(1);
  } catch {
    // OK, no existe
  }
  await fs.rename(backup, LEGACY_ENV_FILE);
  log(`OK — .env restaurado desde ${path.basename(backup)}`);
}

async function cmdMigrate() {
  // Importamos desde el hook — ruta absoluta via file:// para que funcione en Windows.
  const credentialsUrl = 'file:///' + path.join(HOOKS_DIR, 'credentials.mjs').replace(/\\/g, '/');
  const authUrl = 'file:///' + path.join(HOOKS_DIR, 'integra-hub-auth.mjs').replace(/\\/g, '/');
  const credsMod = await import(credentialsUrl);

  log(`== Migracion de credenciales del Hub (SPEC-0005 F4) ==`);
  log('');

  // Paso 1: leer el legacy .env
  const legacy = await readLegacyEnv();
  log(`1. Legacy .env detectado:`);
  log(`   email: ${legacy.email}`);
  log(`   password: ${'*'.repeat(legacy.password.length)}`);
  log(`   url:   ${legacy.url}`);
  log('');

  // Paso 2: ¿ya hay entry en keyring?
  const existing = await credsMod.getFromKeyring(legacy.email);
  if (existing && !isForce) {
    warn(`Ya existe entry en keyring para ${legacy.email}.`);
    warn('Usa --force para sobreescribir, o --rollback si queres volver al estado previo.');
    process.exit(2);
  }
  if (existing && isForce) {
    log(`2. Keyring ya tiene entry para ${legacy.email} -> sobreescribiendo (--force).`);
  } else {
    log(`2. Keyring sin entry previa -> crear nueva.`);
  }
  log('');

  // Paso 3: decidir backend
  log(`3. Probando backends disponibles...`);
  if (isDryRun) {
    log(`   [dry-run] — se intentaria keyring nativo; fallback cipher file si Secret Service indisponible.`);
    log(`   [dry-run] — ejecucion cancelada (no se modifican credenciales ni .env).`);
    return;
  }
  const result = await credsMod.writeCredentialsToBestBackend(legacy);
  log(`   backend usado: ${result.backend}`);
  log('');

  // Paso 4: validacion — borrar cache session, forzar re-cache credenciales, pedir accessToken
  log(`4. Validando contra Hub...`);
  try { await fs.unlink(SESSION_FILE); } catch { /* ignore */ }
  credsMod._resetCache();

  // Temporalmente ocultar el .env para probar que la nueva fuente funciona sola.
  const HIDE_SUFFIX = '.migration-hidden';
  let hiddenLegacy = false;
  try {
    await fs.rename(LEGACY_ENV_FILE, LEGACY_ENV_FILE + HIDE_SUFFIX);
    hiddenLegacy = true;
  } catch { /* no existe, raro pero ok */ }

  let validationOk = false;
  let validationError = null;
  try {
    const authMod = await import(authUrl);
    const token = await authMod.getAccessToken();
    if (token && token.length > 10) validationOk = true;
    else validationError = `token invalido (len=${token?.length})`;
  } catch (e) {
    validationError = e.message;
  }

  if (!validationOk) {
    err(`Validacion fallo: ${validationError}`);
    err('Rollback: borrando entry del keyring/cipher y restaurando .env.');
    try { await credsMod.deleteFromKeyring(legacy.email); } catch { /* ignore */ }
    if (hiddenLegacy) {
      try { await fs.rename(LEGACY_ENV_FILE + HIDE_SUFFIX, LEGACY_ENV_FILE); } catch { /* ignore */ }
    }
    process.exit(1);
  }

  log(`   OK — getAccessToken() retorno token valido.`);
  log('');

  // Paso 5: renombrar .env legacy como backup
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15); // YYYYMMDDHHMMSS
  const backupPath = `${LEGACY_ENV_FILE}.migrated-${stamp}`;
  log(`5. Renombrando .env -> ${path.basename(backupPath)}`);
  // Recordar: lo habiamos escondido con .migration-hidden
  await fs.rename(LEGACY_ENV_FILE + HIDE_SUFFIX, backupPath);
  log(`   OK — legacy backup en ${backupPath}`);
  log('');

  log(`== Migracion completada OK ==`);
  log('');
  log(`Siguiente paso manual: despues de 1 semana sin problemas, borrar el backup:`);
  log(`  rm ${backupPath}`);
  log('');
  log(`Si ves problemas, ejecuta:`);
  log(`  node ~/.claude/scripts/migrate-hub-credentials.mjs --rollback`);
}

try {
  if (isRollback) {
    await cmdRollback();
  } else {
    await cmdMigrate();
  }
} catch (e) {
  err(e.message);
  process.exit(1);
}
