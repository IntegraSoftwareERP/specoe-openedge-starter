#!/usr/bin/env node
// SPEC-0113 P4 (TSK-0405) — SessionStart hook: fail-fast de UX si faltan las
// env vars de rol de la sesión SDD.
//
// SPEC-0148 P5 — reescrito al contrato real del thin-client scoped. El MCP YA NO
// lee INTEGRA_ACT_AS_SECRET (SPEC-0134 P7, eliminada del guard): resuelve el
// secreto act-as del canal local (secrets.mjs, getSecret) firmado per-(tenant,rol).
// Lo que hace falta para operar: INTEGRA_SDD_ROLE + INTEGRA_ACT_AS_TENANT en el
// entorno, y que el secreto de ESE rol esté grabado en el canal
// (provision-secrets.mjs act-as <ROL>, SPEC-0148 P7). Este hook chequea las 3
// cosas — NUNCA el secret global, que ni siquiera existe para el thin-client
// externo.
//
// Defensa en profundidad: el BORDE de enforcement es el 403 del backend
// (resolveScopedRole -> verifyScopedSignature); este hook es solo UX. NUNCA
// bloquea el arranque (exit 0) — el dev puede tener trabajo no-SDD legítimo —
// pero el mensaje es imposible de no ver.

const REQUIRED_ROLE_ENV = ['INTEGRA_SDD_ROLE', 'INTEGRA_ACT_AS_TENANT'];

function checkRoleEnv(env = process.env) {
  const missing = REQUIRED_ROLE_ENV.filter((k) => {
    const v = env[k];
    return v === undefined || v === '';
  });
  return {
    ok: missing.length === 0,
    missing,
    role: env.INTEGRA_SDD_ROLE,
    tenant: env.INTEGRA_ACT_AS_TENANT,
  };
}

// Chequea si el secreto act-as del rol está grabado en el canal local. Import
// dinámico (no estático): si secrets.mjs faltara o no cargara, degrada a
// "no resoluble" en vez de tirar abajo el hook entero. Falla silenciosamente
// ante cualquier error — este hook nunca lanza ni bloquea.
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

async function main() {
  const { ok: envOk, missing, role, tenant } = checkRoleEnv();
  const secretResolvable = envOk ? await checkChannelSecret(role) : false;

  if (envOk && secretResolvable) {
    console.log(
      JSON.stringify({
        specoeRoleStatus: 'ok',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `SpecOE: sesión con rol ${role}, tenant ${tenant}, secreto act-as resuelto del canal.`,
        },
      }),
    );
    return 0;
  }

  const problems = [];
  if (missing.length > 0) problems.push(`faltan ${missing.join(' y ')} en el entorno`);
  if (envOk && !secretResolvable) {
    problems.push(
      `el secreto act-as de '${role}' no está grabado en el canal local (node ~/.claude/scripts/provision-secrets.mjs act-as ${role})`,
    );
  }

  const msg =
    `⚠️ SpecOE — SESIÓN SIN ROL SCOPED: ${problems.join('; ')}. ` +
    `El MCP no puede firmar el header x-act-as-role, así que el Hub responde 403 ` +
    `en lecturas y escrituras. Configurá INTEGRA_SDD_ROLE + INTEGRA_ACT_AS_TENANT ` +
    `(specoe-launch-thinclient.sh <ROL> <TENANT_ID>) y provisioná el secreto del rol ` +
    `en el canal ANTES de operar contra el Hub.`;

  // stderr → visibilidad inmediata en la terminal del dev.
  console.error(`[specoe-role-check] ${msg}`);
  // stdout JSON → additionalContext lo surfacea Claude Code dentro de la sesión.
  console.log(
    JSON.stringify({
      specoeRoleStatus: 'no-role',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: msg,
      },
    }),
  );
  return 0;
}

// NUNCA bloquear la sesión: exit 0 incluso ante un error inesperado.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[specoe-role-check] error inesperado: ${err?.message ?? err}`);
    process.exit(0);
  });
