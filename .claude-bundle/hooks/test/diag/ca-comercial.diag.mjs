// TKT-0303 — DIAGNOSTICO DE MAQUINA, NO CASO DE SUITE.
//
// Ejercita el trust store del SO contra una CA comercial REAL: mide un host publico ANTES y
// DESPUES de aplicar el canal de CA, en procesos frescos. Es la mitad del viejo escenario 6
// de `ca-channel.test.mjs` que dependia de la red.
//
// POR QUE VIVE ACA Y NO EN LA SUITE. Salir a internet dentro de `node --test` le daba al caso
// TRES desenlaces posibles —`pass`, `SKIP` y `fail`— sobre el mismo arbol y sin ningun cambio
// de codigo. Un rojo intermitente que nadie declaro como flake entrena al equipo a ignorar el
// rojo, que es exactamente lo que vuelve inutil un gate. La propiedad que la suite necesita
// ("el store se amplia, no se reemplaza") se mide ahora offline y contra el store, que es
// donde vive. Esto queda para cuando lo que se quiere saber es si ESTA MAQUINA, con SU
// antivirus y SU red, llega a un host publico con el canal puesto.
//
// El nombre NO termina en `.test.mjs` y el directorio no lo alcanza el glob del CI
// (`test/*.test.mjs`, no recursivo): este archivo no corre solo, nunca.
//
// USO:
//   node packages/starter-template/.claude-bundle/hooks/test/diag/ca-comercial.diag.mjs
//   SPECOE_TEST_PUBLIC_URL=https://otro.host node .../ca-comercial.diag.mjs
//
// SALIDA: exit 0 si el canal NO rompio el trust preexistente (o si no habia red para medir,
// que se dice explicito); exit 1 si el control positivo estaba en pie y el canal lo rompio.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA_CHANNEL = pathToFileURL(path.join(HERE, '..', '..', 'ca-channel.mjs')).href;
const PUBLIC_URL = process.env.SPECOE_TEST_PUBLIC_URL || 'https://example.com';

const { DEFAULT_CA_PATH } = await import(CA_CHANNEL);

function runIsolated(body) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_EXTRA_CA_CERTS; // el CA de la maquina del dev no debe contaminar
  const src = `const CA_CHANNEL = ${JSON.stringify(CA_CHANNEL)};\n${body}\n`;
  const tmp = path.join(
    os.tmpdir(),
    `ca-comercial-diag-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  fs.writeFileSync(tmp, src, 'utf8');
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [tmp], {
        encoding: 'utf8',
        timeout: 30000,
        env: childEnv,
      }),
      stderr: '',
    };
  } catch (err) {
    return {
      code: err?.status ?? 1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? ''),
    };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

// Un probe por proceso, SIEMPRE: undici reusa el socket TLS del pool y una segunda request
// en el mismo proceso no vuelve a mirar el store — daria un verde que no midio nada.
function probeInFreshProcess(setupBody) {
  const r = runIsolated(`
    ${setupBody}
    const { probeCaChannel } = await import(CA_CHANNEL);
    console.log(JSON.stringify(await probeCaChannel(${JSON.stringify(PUBLIC_URL)}, { timeoutMs: 8000 })));
  `);
  if (r.code !== 0) return { ok: false, code: `subproceso exit ${r.code}`, error: r.stderr };
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

console.log(`[diag] host publico: ${PUBLIC_URL}`);
console.log(`[diag] CA del canal: ${DEFAULT_CA_PATH}`);

if (!fs.existsSync(DEFAULT_CA_PATH)) {
  console.log('[diag] SIN MEDICION — no hay CA en ese path, no hay canal que aplicar.');
  process.exit(0);
}

const antes = probeInFreshProcess('');
console.log(`[diag] antes del canal: ok=${antes.ok} code=${antes.code ?? '-'}`);
if (!antes.ok) {
  // Sin control positivo no hay experimento. Decirlo es la unica lectura honesta.
  console.log('[diag] SIN MEDICION — el control positivo esta caido (sin red, o un interceptor');
  console.log('       TLS en el medio). El diagnostico no discrimina; no dice nada del canal.');
  process.exit(0);
}

const despues = probeInFreshProcess(`
  const { applyCaChannel } = await import(CA_CHANNEL);
  const applied = applyCaChannel();
  if (!applied.ok) { console.error('el canal no se aplico: ' + applied.reason); process.exit(4); }
`);
console.log(`[diag] con el canal:    ok=${despues.ok} code=${despues.code ?? '-'}`);

if (despues.ok) {
  console.log('[diag] OK — el canal no se llevo puesto el trust preexistente de esta maquina.');
  process.exit(0);
}
console.error('[diag] ROJO — el control positivo estaba en pie y el canal lo rompio.');
console.error(`       code=${despues.code} error=${despues.error ?? '-'}`);
process.exit(1);
