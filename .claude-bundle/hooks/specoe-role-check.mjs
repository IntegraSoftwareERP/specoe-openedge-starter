#!/usr/bin/env node
// SPEC-0113 P4 (TSK-0405) — SessionStart hook: fail-fast de UX si falta lo que la sesión
// SDD necesita para operar contra el Hub.
//
// SPEC-0148 P5 — reescrito al contrato del thin-client SCOPED (act-as / MACHINE-mode). El
// MCP YA NO lee INTEGRA_ACT_AS_SECRET (SPEC-0134 P7, eliminada del guard): resuelve el
// secreto act-as del canal local (secrets.mjs, getSecret) firmado per-(tenant,rol). Lo que
// hace falta ahí: INTEGRA_SDD_ROLE + INTEGRA_ACT_AS_TENANT en el entorno, y el secreto de
// ESE rol grabado en el canal (provision-secrets.mjs act-as <ROL>, SPEC-0148 P7).
//
// TKT-0320 — ese contrato es el de UN modo, no el de los dos. Desde SPEC-0157 existe el
// modo USER (INTEGRA_SDD_IDENTITY_MODE=USER) y desde SPEC-0187 P1 es el camino por defecto
// del thin-client: la identidad viaja por el JWT de sesión SDD derivado del canal
// (x-sdd-role + x-sdd-machine) y act-as NO participa — INTEGRA_ACT_AS_TENANT no se lee.
// Mientras este hook exigió esa variable siempre, TODA sesión de room en modo USER emitía
// una falsa alarma; y como el aviso viaja por `hookSpecificOutput.additionalContext`, el
// agente lo adoptaba como contexto propio y se plantaba pidiendo un prerequisito
// inexistente, con una remediación imposible de seguir (el launcher de modo USER no exporta
// esa variable POR DISEÑO: exporta INTEGRA_SDD_TENANT, que es el tenantSlug, otro campo).
//
// Por eso el hook ramifica por modo, con el MISMO criterio que el MCP (startup.ts,
// requiredEnvFor):
//   - USER    → INTEGRA_SDD_ROLE + material de identidad SDD en el canal. Ni act-as ni su
//               tenant se chequean, y su ausencia NO se reporta.
//   - MACHINE → el chequeo scoped vigente, tal cual (env + secreto act-as del rol).
// La remediación de cada rama nombra la variable que el launcher de ESE modo exporta.
//
// Defensa en profundidad: el BORDE de enforcement es el 401/403 del backend (modo USER:
// derivación de sesión SDD; modo MACHINE: resolveScopedRole -> verifyScopedSignature); este
// hook es solo UX. NUNCA bloquea el arranque (exit 0) — el dev puede tener trabajo no-SDD
// legítimo — pero cuando avisa, el mensaje es imposible de no ver.

import { pathToFileURL } from 'node:url';

export const IDENTITY_MODE_ENV = 'INTEGRA_SDD_IDENTITY_MODE';

// Modo MACHINE (act-as scoped) y modo USER. Las listas son las mismas dos del MCP: si acá
// se pidiera algo que el MCP no pide, el hook volvería a inventar un prerequisito.
export const REQUIRED_ROLE_ENV = ['INTEGRA_SDD_ROLE', 'INTEGRA_ACT_AS_TENANT'];
export const REQUIRED_ROLE_ENV_USER_MODE = ['INTEGRA_SDD_ROLE'];

/** Réplica exacta del criterio del MCP (isUserIdentityMode): trim + uppercase === 'USER'. */
export function isUserIdentityMode(env = process.env) {
  return (env[IDENTITY_MODE_ENV] ?? '').trim().toUpperCase() === 'USER';
}

/** Qué env vars son obligatorias en ESTA sesión. Sin modo declarado: el contrato scoped. */
export function requiredEnvFor(env = process.env) {
  return isUserIdentityMode(env) ? REQUIRED_ROLE_ENV_USER_MODE : REQUIRED_ROLE_ENV;
}

export function checkRoleEnv(env = process.env) {
  const required = requiredEnvFor(env);
  const missing = required.filter((k) => {
    const v = env[k];
    return v === undefined || v === '';
  });
  return {
    ok: missing.length === 0,
    missing,
    required,
    userMode: isUserIdentityMode(env),
    role: env.INTEGRA_SDD_ROLE,
    tenant: env.INTEGRA_ACT_AS_TENANT,
  };
}

// ----- modo MACHINE: el secreto act-as del rol en el canal -----

// Chequea si el secreto act-as del rol está grabado en el canal local. Import dinámico (no
// estático): si secrets.mjs faltara o no cargara, degrada a "no resoluble" en vez de tirar
// abajo el hook entero. Falla silenciosamente ante cualquier error — este hook nunca lanza
// ni bloquea.
async function checkChannelSecret(role) {
  if (!role) return false;
  try {
    const mod = await import('./secrets.mjs');
    const v = await mod.getSecret(mod.ACT_AS_SERVICE, role);
    return v != null;
  } catch {
    return false;
  }
}

// ----- modo USER: el material de identidad del canal -----

// Tri-estado a propósito. 'unknown' NO es 'missing': si el módulo del canal no se puede
// cargar o la lectura tira, el hook no sabe nada de la identidad de esta máquina, y afirmar
// que falta sería reintroducir la falsa alarma que TKT-0320 viene a cerrar por otra puerta.
// Ante 'unknown' no se avisa nada: el borde real sigue siendo el 401 del Hub.
export const IDENTITY_PRESENT = 'present';
export const IDENTITY_MISSING = 'missing';
export const IDENTITY_UNKNOWN = 'unknown';

export const NO_IDENTITY_NOTICE =
  'no hay material de identidad SDD en el canal de este equipo (falta el UserSddToken y/o el machineId). ' +
  'Acción: hacé el login desde la carpeta del room (`./setup.sh --login`), o ' +
  '`node ~/.claude/scripts/specoe-identity.mjs login` si esta máquina ya está enrolada en otro tenant';

/**
 * Estado del material de identidad SDD para el scope de ESTA sesión. La resolución de QUÉ
 * claves se leen (tenant declarado / única / legacy / ambiguo) vive en sdd-identity.mjs y no
 * se duplica acá: dos criterios que se separen es el pisado entre tenants que SPEC-0187 P7
 * cerró. Cuando esa resolución ya trae un aviso accionable, se usa ESE texto tal cual.
 */
export async function checkSddIdentity({ loader = () => import('./sdd-identity.mjs') } = {}) {
  try {
    const mod = await loader();
    const material = await mod.readIdentityMaterialScoped();
    const scope = { tenantSlug: material.tenantSlug ?? null, outcome: material.outcome ?? null };
    if (material.notice) return { status: IDENTITY_MISSING, notice: material.notice, ...scope };
    if (!material.present)
      return { status: IDENTITY_MISSING, notice: NO_IDENTITY_NOTICE, ...scope };
    return { status: IDENTITY_PRESENT, notice: null, ...scope };
  } catch (err) {
    return {
      status: IDENTITY_UNKNOWN,
      notice: null,
      tenantSlug: null,
      outcome: null,
      reason: err?.message ?? String(err),
    };
  }
}

// ----- mensajes -----

/**
 * El aviso del modo USER. Nombra SOLO lo que este modo usa, y la remediación apunta a lo que
 * el launcher de este modo realmente exporta: el rol por `specoe-launch-thinclient.sh <ROL>`
 * y el tenant por `specoe.tenant` del project.config.yaml (que el launcher exporta como
 * INTEGRA_SDD_TENANT — el tenantSlug, NO el Tenant.id de act-as).
 */
export function buildUserModeMessage(problems) {
  return (
    `⚠️ SpecOE — SESIÓN SDD INCOMPLETA (modo USER): ${problems.join('; ')}. ` +
    `En modo USER la identidad viaja por el JWT de sesión SDD derivado del canal ` +
    `(x-sdd-role + x-sdd-machine): act-as no participa y INTEGRA_ACT_AS_TENANT no se usa. ` +
    `El rol lo exporta el launcher (specoe-launch-thinclient.sh <ROL>) y el tenant sale de ` +
    `specoe.tenant del project.config.yaml del room, que el mismo launcher exporta como ` +
    `INTEGRA_SDD_TENANT.`
  );
}

/** El aviso del modo scoped, sin cambios desde SPEC-0148 P5. */
export function buildScopedModeMessage(problems) {
  return (
    `⚠️ SpecOE — SESIÓN SIN ROL SCOPED: ${problems.join('; ')}. ` +
    `El MCP no puede firmar el header x-act-as-role, así que el Hub responde 403 ` +
    `en lecturas y escrituras. Configurá INTEGRA_SDD_ROLE + INTEGRA_ACT_AS_TENANT ` +
    `(specoe-launch-thinclient.sh <ROL> <TENANT_ID>) y provisioná el secreto del rol ` +
    `en el canal ANTES de operar contra el Hub.`
  );
}

/**
 * El veredicto del arranque: { status, message }. `status` es el `specoeRoleStatus` que sale
 * en el JSON — 'ok' no emite alarma, 'no-role' la emite por los dos canales.
 */
export async function evaluateSession({ env = process.env, deps = {} } = {}) {
  const { ok: envOk, missing, userMode, role, tenant } = checkRoleEnv(env);

  if (userMode) {
    const identity = envOk
      ? await (deps.checkSddIdentity ?? checkSddIdentity)()
      : { status: IDENTITY_UNKNOWN, notice: null, tenantSlug: null, outcome: null };

    const problems = [];
    if (missing.length > 0) problems.push(`falta ${missing.join(' y ')} en el entorno`);
    if (identity.status === IDENTITY_MISSING) problems.push(identity.notice);

    if (problems.length === 0) {
      const scope = identity.tenantSlug
        ? `tenant ${identity.tenantSlug}`
        : 'canal single-tenant (claves sin tenant declarado)';
      const material =
        identity.status === IDENTITY_PRESENT
          ? 'identidad SDD por usuario resuelta del canal'
          : 'material de identidad no verificable en este arranque (el borde sigue siendo el Hub)';
      return {
        status: 'ok',
        message: `SpecOE: sesión con rol ${role}, modo USER, ${scope}, ${material}.`,
      };
    }
    return { status: 'no-role', message: buildUserModeMessage(problems) };
  }

  const secretResolvable = envOk
    ? await (deps.checkChannelSecret ?? checkChannelSecret)(role)
    : false;
  if (envOk && secretResolvable) {
    return {
      status: 'ok',
      message: `SpecOE: sesión con rol ${role}, tenant ${tenant}, secreto act-as resuelto del canal.`,
    };
  }

  const problems = [];
  if (missing.length > 0) problems.push(`faltan ${missing.join(' y ')} en el entorno`);
  if (envOk && !secretResolvable) {
    problems.push(
      `el secreto act-as de '${role}' no está grabado en el canal local (node ~/.claude/scripts/provision-secrets.mjs act-as ${role})`,
    );
  }
  return { status: 'no-role', message: buildScopedModeMessage(problems) };
}

async function main() {
  const { status, message } = await evaluateSession();

  // stderr → visibilidad inmediata en la terminal del dev. Solo cuando hay algo que avisar:
  // en el camino sano el arranque no ensucia la terminal.
  if (status !== 'ok') console.error(`[specoe-role-check] ${message}`);

  // stdout JSON → additionalContext lo surfacea Claude Code dentro de la sesión.
  console.log(
    JSON.stringify({
      specoeRoleStatus: status,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }),
  );
  return 0;
}

// Guarda de entry point — main() corre solo cuando el archivo ES el proceso, nunca al
// importarlo: la suite importa los helpers de arriba y sin esto moriría en el process.exit().
// Mismo mecanismo que specoe-license-check.mjs y specoe-room-bootstrap.mjs.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // NUNCA bloquear la sesión: exit 0 incluso ante un error inesperado.
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[specoe-role-check] error inesperado: ${err?.message ?? err}`);
      process.exit(0);
    });
}
