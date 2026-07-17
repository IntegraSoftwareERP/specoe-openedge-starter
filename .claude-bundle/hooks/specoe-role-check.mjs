#!/usr/bin/env node
// SPEC-0113 P4 (TSK-0405) — SessionStart hook: fail-fast de UX si faltan las
// env vars de rol de la sesión SDD.
//
// El rol de la sesión (INTEGRA_SDD_ROLE + su INTEGRA_ACT_AS_SECRET) es lo que el
// MCP firma en el header x-act-as-role para actuar-como ese rol contra el Hub.
// Sin esas env vars, antes la sesión corría en silencio sin rol y el dev se
// enteraba recién con un 403 enterrado (o, pre-SPEC-0113, operaba con permisos
// del usuario base por el fail-open que esta SPEC cierra). Este hook avisa AL
// INSTANTE, al abrir la sesión, con un mensaje explícito.
//
// Defensa en profundidad: el BORDE de enforcement es el 403 del backend (P2);
// este hook es solo UX. NUNCA bloquea el arranque (exit 0) — el dev puede tener
// trabajo no-SDD legítimo — pero el mensaje es imposible de no ver.

const REQUIRED_ROLE_ENV = ['INTEGRA_SDD_ROLE', 'INTEGRA_ACT_AS_SECRET'];

function checkRoleEnv(env = process.env) {
  const missing = REQUIRED_ROLE_ENV.filter((k) => {
    const v = env[k];
    return v === undefined || v === '';
  });
  return { ok: missing.length === 0, missing, role: env.INTEGRA_SDD_ROLE };
}

function main() {
  const { ok, missing, role } = checkRoleEnv();

  if (ok) {
    console.log(
      JSON.stringify({
        specoeRoleStatus: 'ok',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `SpecOE: sesión con rol ${role}.`,
        },
      }),
    );
    return 0;
  }

  const msg =
    `⚠️ SpecOE — SESIÓN SIN ROL: faltan ${missing.join(' y ')}. ` +
    `El MCP no puede declarar su rol (x-act-as-role), así que el Hub responde 403 ` +
    `en lecturas y escrituras (SPEC-0113 fail-CLOSED). Configurá el rol de tu room ` +
    `(INTEGRA_SDD_ROLE + INTEGRA_ACT_AS_SECRET) ANTES de operar contra el Hub.`;

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
try {
  main();
  process.exit(0);
} catch (err) {
  console.error(`[specoe-role-check] error inesperado: ${err?.message ?? err}`);
  process.exit(0);
}
