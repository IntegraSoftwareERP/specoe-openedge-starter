#!/usr/bin/env node
// SPEC-0137 P3 (TSK-0582) — CLI de grabado de secretos por maquina.
//
// Graba un secreto en el canal (secrets.mjs: keyring nativo del SO -> cipher
// fallback). El VALOR se lee por stdin (prompt oculto en TTY, o por pipe) — NUNCA
// por argv, para que no quede en el history del shell ni en la lista de procesos.
// Tras grabar, verifica que getSecret lo lee. No escribe el valor en ningun
// archivo en claro.
//
// El import de secrets.mjs es relativo (../hooks/): resuelve igual en el repo
// (env/scripts -> env/hooks) y deployado (~/.claude/scripts -> ~/.claude/hooks).
//
// Uso:
//   node provision-secrets.mjs act-as <ROLE>        # act-as per-rol (service=integra-sdd-act-as)
//   node provision-secrets.mjs <service> <name>     # secreto arbitrario (p.ej. integra-specoe SPECOE_JWT)
//   echo "<valor>" | node provision-secrets.mjs act-as ENGINEERING   # no interactivo (CI/test)
//   node provision-secrets.mjs --help

import readline from 'node:readline';
import { setSecret, getSecret, ACT_AS_SERVICE } from '../hooks/secrets.mjs';

function err(m) {
  process.stderr.write(`[ERROR] ${m}\n`);
}

const argv = process.argv.slice(2);
const wantsHelp = argv.includes('--help') || argv.includes('-h');

if (wantsHelp || argv.length < 2) {
  const out = wantsHelp ? console.log : (m) => process.stderr.write(m + '\n');
  out(`provision-secrets — graba un secreto en el canal por maquina.

Uso:
  node provision-secrets.mjs act-as <ROLE>       Graba el act-as de un rol SDD.
  node provision-secrets.mjs <service> <name>    Graba un secreto arbitrario.

El valor se lee por stdin (prompt oculto o pipe), NUNCA por argumento.
Ejemplos:
  node provision-secrets.mjs act-as ENGINEERING
  echo "$SECRETO" | node provision-secrets.mjs integra-specoe SPECOE_JWT`);
  process.exit(wantsHelp ? 0 : 1);
}

// (service, name): 'act-as <ROLE>' es un atajo; si no, se toman literales.
let service, name;
if (argv[0] === 'act-as') {
  service = ACT_AS_SERVICE;
  name = String(argv[1]).toUpperCase();
} else {
  service = argv[0];
  name = argv[1];
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl._writeToOutput = () => {}; // silencia el echo del valor tipeado
    process.stdout.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readValue() {
  if (!process.stdin.isTTY) {
    // pipe (CI / test): primera linea de stdin
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0].trim();
  }
  return (await promptHidden(`Valor para (${service}, ${name}) — no se muestra: `)).trim();
}

try {
  const value = await readValue();
  if (!value) {
    err('valor vacio — nada grabado.');
    process.exit(1);
  }
  const { backend } = await setSecret(service, name, value);
  const check = await getSecret(service, name);
  if (check !== value) {
    err('verificacion post-grabado fallo (getSecret no coincide con lo grabado).');
    process.exit(1);
  }
  console.log(
    `OK — (${service}, ${name}) grabado en backend '${backend}'. ` +
      `Verificado por getSecret. El valor no quedo en ningun archivo en claro.`,
  );
} catch (e) {
  err(e.message);
  process.exit(1);
}
