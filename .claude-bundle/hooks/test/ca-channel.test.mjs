// SPEC-0164 P1 / T1.6 — suite del canal de CA. `node --test`.
//
// Siete escenarios. Los cinco primeros prueban el MECANISMO y el EFECTO del canal; el 6
// prueba que el store se AMPLIA y no se reemplaza; el 7 prueba la propiedad de la que
// dependen todas las herramientas que inspeccionan el canal: importar no ejecuta nada.
//
// Los escenarios que mutan el default CA store del proceso corren AISLADOS en un
// subproceso: `tls.setDefaultCACertificates` es global y un test que lo pise le arruina
// el trust a los demas.
//
// Los que necesitan red se saltean solos si no hay (SPECOE_TEST_HUB_URL / red publica
// caida): un skip declarado es honesto, un verde sin haber medido no.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { applyCaChannel, readCaPem, probeCaChannel, DEFAULT_CA_PATH } from '../ca-channel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA_CHANNEL = pathToFileURL(path.join(HERE, '..', 'ca-channel.mjs')).href;
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');
const HUB_URL = process.env.SPECOE_TEST_HUB_URL || 'https://hub.integra.local/api/v1';
const PUBLIC_URL = process.env.SPECOE_TEST_PUBLIC_URL || 'https://example.com';

// ---------- helpers ----------

// Corre codigo en un proceso limpio. Devuelve { code, stdout, stderr }.
// `env` se aplica encima del entorno actual; las claves con valor null se BORRAN
// (NODE_EXTRA_CA_CERTS de la maquina del dev no debe contaminar los escenarios).
function runIsolated(body, env = {}) {
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete childEnv[k];
    else childEnv[k] = v;
  }
  const src = `const CA_CHANNEL = ${JSON.stringify(CA_CHANNEL)};\n${body}\n`;
  const tmp = path.join(os.tmpdir(), `ca-channel-test-${process.pid}-${Math.abs(hash(body))}.mjs`);
  fs.writeFileSync(tmp, src, 'utf8');
  try {
    const stdout = execFileSync(process.execPath, [tmp], {
      encoding: 'utf8',
      timeout: 30000,
      env: childEnv,
    });
    return { code: 0, stdout, stderr: '' };
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

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Un probe por proceso, SIEMPRE. Medir "antes" y "despues" dentro del mismo proceso da
// falsos verdes: undici mantiene el socket TLS en su pool y la segunda request reusa la
// conexion YA validada, sin volver a mirar el store. Un proceso nuevo por medicion es la
// unica forma de que el resultado hable del store y no del keep-alive.
// (Es tambien la razon por la que el canal se aplica ANTES del primer request del hook.)
function probeInFreshProcess(setupBody, url) {
  const r = runIsolated(
    `
    ${setupBody}
    const { probeCaChannel } = await import(CA_CHANNEL);
    console.log(JSON.stringify(await probeCaChannel(${JSON.stringify(url)}, { timeoutMs: 8000 })));
  `,
    { NODE_EXTRA_CA_CERTS: null },
  );
  if (r.code !== 0) return { ok: false, code: `subproceso exit ${r.code}`, error: r.stderr };
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function tmpFile(name, content) {
  const p = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// Nota sobre el "CA de otro emisor" del escenario 4: Node no emite certificados desde
// stdlib, asi que se usa un root REAL del bundle de Node — certificado valido, parseable
// y con emisor equivocado, que es exactamente la condicion que el test necesita.

// ---------- 1. canal OK: el root de Caddy queda en el store efectivo ----------

test('1. canal OK — el CA queda dentro del store efectivo del proceso', (t) => {
  if (!fs.existsSync(DEFAULT_CA_PATH)) {
    t.skip(`sin CA en ${DEFAULT_CA_PATH} — nada que aplicar`);
    return;
  }
  const r = runIsolated(
    `
    const { applyCaChannel } = await import(CA_CHANNEL);
    const r = applyCaChannel();
    console.log(JSON.stringify(r));
  `,
    { NODE_EXTRA_CA_CERTS: null },
  );
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true, `reason=${out.reason} error=${out.error}`);
  assert.equal(out.reason, 'ok');
  assert.ok(out.storeAfter > 0);
  // El store efectivo tiene que contener al menos lo que traia el sistema.
  assert.ok(out.storeAfter >= out.system, 'el store efectivo perdio el trust del sistema');
});

// ---------- 2. archivo del CA inexistente ----------

test('2. CA inexistente — negativo con el path a la vista, sin excepcion', () => {
  const r = applyCaChannel({ caPath: path.join(os.tmpdir(), 'no-existe-jamas-0164.crt') });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ca-missing');
  assert.match(r.caPath, /no-existe-jamas-0164\.crt$/);
});

// ---------- 3. archivo que no parsea como X509 ----------

test('3. CA que no parsea — negativo, sin excepcion', () => {
  const p = tmpFile('ca-basura', 'esto no es un certificado\n');
  try {
    const r = applyCaChannel({ caPath: p });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ca-unparsable');
    assert.equal(r.caPath, p);
  } finally {
    fs.unlinkSync(p);
  }
});

// ---------- 4. CA valido pero de OTRO emisor: pasa el mecanismo, muere en el efecto ----------

test('4. CA de otro emisor — aplica, pero el canal al Hub NO valida', async () => {
  const r = runIsolated(
    `
    const fs = await import('node:fs');
    const tls = await import('node:tls');
    const os = await import('node:os');
    const pathm = await import('node:path');
    const { applyCaChannel, probeCaChannel } = await import(CA_CHANNEL);
    const norm = (p) => String(p).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\\s+/g, '');
    const caddyPath = pathm.join(os.homedir(), '.claude', 'caddy-local-root.crt');
    const caddy = fs.existsSync(caddyPath) ? norm(fs.readFileSync(caddyPath, 'utf8')) : '';
    // Un root REAL del bundle de Node: certificado valido, emisor equivocado.
    const foreign = tls.getCACertificates('bundled').find((c) => norm(c) !== caddy);
    const p = pathm.join(os.tmpdir(), 'foreign-ca-' + process.pid + '.crt');
    fs.writeFileSync(p, foreign, 'utf8');
    const applied = applyCaChannel({ caPath: p });
    // Store SOLO con el CA foraneo: sin esto el trust del sistema taparia el experimento.
    tls.setDefaultCACertificates([foreign]);
    const probe = await probeCaChannel(${JSON.stringify(HUB_URL)}, { timeoutMs: 8000 });
    fs.unlinkSync(p);
    console.log(JSON.stringify({ applied: applied.ok, probeOk: probe.ok, code: probe.code }));
  `,
    { NODE_EXTRA_CA_CERTS: null },
  );
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.applied, true, 'un CA valido de otro emisor SI pasa el mecanismo');
  assert.equal(out.probeOk, false, 'y tiene que morir en el efecto — este es el punto del test');
  if (out.code) assert.match(out.code, /CERT|SELF_SIGNED|SIGNATURE|ISSUER/i);
});

// ---------- 5. control negativo del store: reemplazarlo rompe un host publico ----------

test('5. control negativo — store reemplazado por el CA de Caddy: un host publico deja de validar', async (t) => {
  if (!fs.existsSync(DEFAULT_CA_PATH)) {
    t.skip(`sin CA en ${DEFAULT_CA_PATH}`);
    return;
  }
  const before = probeInFreshProcess('', PUBLIC_URL);
  if (!before.ok) {
    // Sin control positivo no hay experimento: la corrida no discrimina y decirlo es la
    // unica lectura honesta. Es la leccion de T1.0 incorporada al test.
    t.skip('control positivo caido (sin red o interceptor TLS): el escenario no discrimina');
    return;
  }
  const after = probeInFreshProcess(
    `
    const fs = await import('node:fs');
    const tls = await import('node:tls');
    const { DEFAULT_CA_PATH } = await import(CA_CHANNEL);
    tls.setDefaultCACertificates([fs.readFileSync(DEFAULT_CA_PATH, 'utf8')]);
  `,
    PUBLIC_URL,
  );
  assert.equal(after.ok, false, 'el store no cambio de verdad: el mecanismo no toma efecto');
});

// ---------- 6. el store se AMPLIA, no se reemplaza ----------

test('6. store ampliado — tras aplicar el canal, un host publico con CA comercial SIGUE validando', async (t) => {
  if (!fs.existsSync(DEFAULT_CA_PATH)) {
    t.skip(`sin CA en ${DEFAULT_CA_PATH}`);
    return;
  }
  const before = probeInFreshProcess('', PUBLIC_URL);
  if (!before.ok) {
    t.skip('control positivo caido (sin red o interceptor TLS): el escenario no discrimina');
    return;
  }
  const after = probeInFreshProcess(
    `
    const { applyCaChannel } = await import(CA_CHANNEL);
    const applied = applyCaChannel();
    if (!applied.ok) { console.error('el canal no se aplico: ' + applied.reason); process.exit(4); }
  `,
    PUBLIC_URL,
  );
  // Este es el escenario que caza la clase de defecto "el fix rompe todo lo demas":
  // un store armado sin el trust del sistema se lleva puesto el trafico interceptado por
  // un antivirus corporativo, y con el la conexion al Hub.
  assert.equal(after.ok, true, `el canal rompio el trust preexistente (code=${after.code})`);
});

// ---------- 7. IMPORT-SAFETY ----------

test('7. import-safety — importar ca-channel.mjs y specoe-license-check.mjs no ejecuta main() ni process.exit', () => {
  const r = runIsolated(`
    const mod = await import(CA_CHANNEL);
    if (typeof mod.applyCaChannel !== 'function') { console.error('export faltante'); process.exit(3); }
    const lic = await import(${JSON.stringify(pathToFileURL(LICENSE_CHECK).href)});
    // Si alguno de los dos corriera su main(), el proceso moriria en su process.exit()
    // ANTES de esta linea — que es justo el verde falso que esta SPEC persigue.
    void lic;
    console.log('ALIVE');
  `);
  assert.equal(r.code, 0, `el import mato al proceso: ${r.stderr}`);
  assert.match(r.stdout, /ALIVE/, 'el proceso no sobrevivio al import');
});

// El modulo se importa tambien en ESTE proceso (arriba) sin efectos: si el import
// aplicara el canal, readCaPem de un path inexistente no seria reproducible.
test('7b. import-safety — importar no aplica el canal por su cuenta', () => {
  const r = readCaPem(path.join(os.tmpdir(), 'no-existe-0164.crt'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ca-missing');
  assert.equal(typeof probeCaChannel, 'function');
});
