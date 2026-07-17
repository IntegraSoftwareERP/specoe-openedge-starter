#!/usr/bin/env node
// SPEC-0133 P5 (TSK-0554 / T5.3) — Probe OBJETIVO determinista del room diskless.
//
// Verifica, sin depender de arrancar una sesion real de Claude Code, las tres
// propiedades client-side del "thin client" que entrega P5:
//
//   1. NO-IP-EN-DISCO  — el starter pelado no lleva CLAUDE.md ni skills/commands/
//      agents/standards en el working dir (la IP baja del server, no vive local).
//   2. SENTINEL + REGLA — el additionalContext que el hook inyecta lleva el sentinel
//      estable [[SPECOE-ROOM-CONTRACT:<rol>]] y CITA una regla concreta del contrato
//      del rol (aca: Engineering). Es el assert (a)+(b) que pide el contrato de T5.3.
//   3. FAIL-OPEN       — el hook real, ante el skill-server caido, sale 0 y NO inyecta
//      (nunca bloquea el arranque de la sesion).
//
// Deterministico y sin red viva: (2) ejercita la funcion pura buildAdditionalContext
// del hook contra el contrato de engineering REAL del content-source; (3) corre el hook
// real como subproceso apuntando a un puerto muerto. El canal SSE vivo con JWT firmado
// se cubre en el e2e de P6 (O3b), no aca.
//
// Uso: node scripts/probe-diskless-contract.mjs   (desde packages/starter-template)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STARTER = path.resolve(HERE, '..');
const HOOK = path.join(STARTER, '.claude-bundle', 'hooks', 'specoe-room-bootstrap.mjs');
// El contrato de Engineering vive server-side (content-source del skill-server).
const ENGINEERING_CONTRACT = path.resolve(
  STARTER,
  '..',
  'skill-server',
  'src',
  'content-source',
  'contracts',
  'engineering.md',
);
const SKILL_SERVER_DIR = path.resolve(STARTER, '..', 'skill-server');

let pass = 0;
let fail = 0;
function check(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    pass += 1;
  } catch (err) {
    console.log(`  ✗ ${desc}\n      ${err?.message ?? err}`);
    fail += 1;
  }
}

// --- 1. NO-IP-EN-DISCO ---------------------------------------------------------
console.log('== 1. Room pelado: sin IP en disco ==');
for (const rel of [
  '.claude/CLAUDE.md',
  '.claude/skills',
  '.claude/commands',
  '.claude/agents',
  '.claude/standards',
]) {
  check(`${rel} ausente`, () =>
    assert.ok(!fs.existsSync(path.join(STARTER, rel)), `${rel} todavia existe en disco`),
  );
}
check('.claude/settings.json conservado (infra)', () =>
  assert.ok(fs.existsSync(path.join(STARTER, '.claude', 'settings.json'))),
);
check('.mcp.json presente con wiring sse al skill-server', () => {
  const mcp = fs.readFileSync(path.join(STARTER, '.mcp.json'), 'utf8');
  assert.match(mcp, /"type"\s*:\s*"sse"/, 'sin transporte sse');
  assert.match(mcp, /"specoe"/, 'sin server specoe');
});

// --- 2. SENTINEL + REGLA -------------------------------------------------------
console.log('\n== 2. additionalContext: sentinel + regla concreta del contrato ==');
const { buildAdditionalContext, decodeRole } = await import(pathToFileURL(HOOK).href);
const engineeringContract = fs.readFileSync(ENGINEERING_CONTRACT, 'utf8');
// Regla concreta y estable del contrato de Engineering (restriccion absoluta).
const CONCRETE_RULE = 'No modifiques el discovery-report';
assert.ok(
  engineeringContract.includes(CONCRETE_RULE),
  `fixture de engineering cambio: ya no contiene "${CONCRETE_RULE}"`,
);
const ctx = buildAdditionalContext('ENGINEERING', engineeringContract);
check('(a) additionalContext lleva el sentinel del rol', () =>
  assert.match(ctx, /\[\[SPECOE-ROOM-CONTRACT:ENGINEERING\]\]/),
);
check('(b) additionalContext cita una regla concreta del contrato', () =>
  assert.ok(ctx.includes(CONCRETE_RULE), 'no cita la regla del contrato'),
);
check('additionalContext incluye el contrato completo del room', () =>
  assert.ok(ctx.includes('# Engineering Room')),
);

// --- 3. decodeRole: rol vs producto -------------------------------------------
console.log('\n== 3. decodeRole: rol del claim vs producto (sin claim) ==');
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}
check('JWT con sddRole=ENGINEERING => ENGINEERING', () =>
  assert.equal(decodeRole(fakeJwt({ sub: 'lic', sddRole: 'ENGINEERING' })), 'ENGINEERING'),
);
check('JWT de producto (sin sddRole) => null', () =>
  assert.equal(decodeRole(fakeJwt({ sub: 'lic' })), null),
);

// --- 4. FAIL-OPEN: hook real, server caido ------------------------------------
console.log('\n== 4. Fail-open: server caido => exit 0, sin inyectar ==');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specoe-probe-'));
fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, '.claude', 'specoe-license-cache.json'),
  JSON.stringify({
    token: fakeJwt({ sub: 'lic', sddRole: 'ENGINEERING' }),
    validatedAt: new Date().toISOString(),
  }),
);
const failOpen = await new Promise((resolve) => {
  const child = spawn(process.execPath, [HOOK], {
    // cwd en el skill-server: el import dinamico del SDK resuelve, asi el test prueba
    // que el hook falla por el SERVER caido, no por el SDK ausente.
    cwd: SKILL_SERVER_DIR,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      SPECOE_SKILL_SERVER_URL: 'http://127.0.0.1:1/sse', // puerto muerto
      SPECOE_BOOTSTRAP_TIMEOUT_MS: '2000',
    },
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.on('close', (code) => resolve({ code, stdout }));
});
fs.rmSync(tmpHome, { recursive: true, force: true });
check('hook sale con exit 0 aunque el server este caido', () =>
  assert.equal(failOpen.code, 0, `exit code ${failOpen.code}`),
);
check('hook NO inyecta additionalContext con el server caido', () =>
  assert.ok(
    !failOpen.stdout.includes('additionalContext'),
    `inyecto pese al server caido: ${failOpen.stdout.slice(0, 200)}`,
  ),
);

// --- resultado ----------------------------------------------------------------
console.log(`\n== RESULTADO: ${pass} pasaron, ${fail} fallaron ==`);
process.exit(fail === 0 ? 0 : 1);
