// TKT-0314 — las dependencias de los hooks viajan vendorizadas y el chequeo del instalador
// puede dar ROJO. `node --test`.
//
// Que cubre, y por que cada cosa:
//   1. Las tres dependencias resuelven POR EL VENDOR en esta plataforma. Es la afirmacion que
//      sostiene todo el ticket: si resolvieran por node_modules, el `npm install` en la maquina
//      del cliente seguiria siendo necesario y el defecto seguiria vivo con otra cara.
//   2. Cada loader devuelve lo que su hook consume (Entry, machineIdSync, Client +
//      SSEClientTransport). Que el import no tire no alcanza: un bundle mal armado importa bien
//      y no exporta nada.
//   3. El keyring hace un roundtrip real contra el keyring del SO. Es lo unico que prueba que el
//      binding NATIVO cargo — que es exactamente lo que se rompia en la VM del piloto.
//   4. CONTROL NEGATIVO: con el vendor ausente y sin node_modules, `--check` sale 1 y nombra las
//      que faltan. Sin esto, el gate terminal del instalador no seria falsable: un chequeo que
//      no puede dar rojo no es un chequeo (SPEC-0165 P5, mismo verde-falso del .vsix).
//   5. El manifiesto del vendor declara los archivos que estan y sus sha256 coinciden.
//
// El control negativo corre en un CLAUDE_HOME temporal con una copia de vendor-deps.mjs sola:
// ninguna corrida toca la instalacion real del dev.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { checkDeps, loadKeyring, loadMachineId, loadMcpClient } from '../vendor-deps.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.join(HERE, '..');
const VENDOR_DIR = path.join(HOOKS_DIR, 'vendor');
const VENDOR_DEPS = path.join(HOOKS_DIR, 'vendor-deps.mjs');

// El keyring del SO no esta disponible en un runner headless de Linux (no hay Secret Service):
// ahi el roundtrip nativo se saltea, pero el resto —incluido que el bundle EXPORTA Entry— se
// mide igual. En Windows y macOS corre completo.
const KEYRING_ROUNDTRIP_DISPONIBLE = process.platform === 'win32' || process.platform === 'darwin';

// TKT-0321 — la cuenta esperada sale de `dependencies` del package.json del bundle y no de un
// numero escrito a mano. Ese numero era 3 y la dep nueva (fastest-levenshtein) lo puso rojo por
// la CUENTA, o sea por el lugar donde no estaba el defecto. Derivarlo mantiene vivo lo que el
// caso mide de verdad —que el probe cubra TODAS las dependencias declaradas— sin pedir que
// alguien se acuerde de sumar uno.
const DEPS_DECLARADAS = Object.keys(
  JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'package.json'), 'utf8')).dependencies ?? {},
);

test('todas las dependencias declaradas resuelven por el vendor del bundle, no por node_modules', async () => {
  const results = await checkDeps();
  assert.deepEqual(
    results.map((r) => r.name).sort(),
    [...DEPS_DECLARADAS].sort(),
    'el probe y package.json declaran dependencias distintas: una dep sin probe se instala sin verificarse',
  );
  for (const r of results) {
    assert.equal(r.ok, true, `${r.name} no resuelve por ningun camino: ${r.error}`);
    assert.equal(
      r.via,
      'vendor',
      `${r.name} resolvio por ${r.via}: el vendor no cubre ${process.platform}/${process.arch} y el instalador va a depender del npm install del cliente`,
    );
  }
});

test('cada loader devuelve lo que su hook consume', async () => {
  const keyring = await loadKeyring();
  assert.equal(typeof keyring.Entry, 'function', 'el keyring vendorizado no exporta Entry');

  const machineId = await loadMachineId();
  const lib = machineId.default ?? machineId;
  assert.equal(
    typeof lib.machineIdSync,
    'function',
    'node-machine-id vendorizado no exporta machineIdSync',
  );
  assert.ok(String(lib.machineIdSync(true)).length > 0, 'machineIdSync devolvio vacio');

  const mcp = await loadMcpClient();
  assert.equal(typeof mcp.Client, 'function', 'el cliente MCP vendorizado no exporta Client');
  assert.equal(
    typeof mcp.SSEClientTransport,
    'function',
    'el cliente MCP vendorizado no exporta SSEClientTransport',
  );
});

test(
  'el binding NATIVO del keyring carga: roundtrip real contra el keyring del SO',
  { skip: !KEYRING_ROUNDTRIP_DISPONIBLE },
  async () => {
    const { Entry } = await loadKeyring();
    // Nombre unico por corrida: dos suites en paralelo no se pisan, y si el borrado fallara no
    // queda basura reutilizada en el keyring del dev.
    const account = `tkt-0314-${crypto.randomUUID()}`;
    const entry = new Entry('specoe-test', account);
    entry.setPassword('valor-de-prueba');
    try {
      assert.equal(entry.getPassword(), 'valor-de-prueba');
    } finally {
      entry.deleteCredential();
    }
  },
);

test('CLI --check: sale 0 y reporta una linea por dependencia', async () => {
  const { stdout } = await execFileAsync(process.execPath, [VENDOR_DEPS, '--check']);
  const lineas = stdout.trim().split(/\r?\n/);
  assert.equal(
    lineas.length,
    DEPS_DECLARADAS.length,
    `se esperaba una linea por dependencia declarada (${DEPS_DECLARADAS.length}), salieron ${lineas.length}: ${stdout}`,
  );
  for (const linea of lineas) {
    assert.match(linea, / vendor$/, `linea sin resolver por vendor: ${linea}`);
  }
});

test('CONTROL NEGATIVO — sin vendor y sin node_modules, --check sale 1 y nombra lo que falta', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tkt0314-sin-vendor-'));
  try {
    // Solo el resolvedor, sin vendor/ al lado y sin node_modules arriba: es el estado exacto de
    // la maquina del piloto despues de que el npm install aborta.
    const destino = path.join(tmp, 'vendor-deps.mjs');
    await fsp.copyFile(VENDOR_DEPS, destino);
    await fsp.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

    const fallo = await execFileAsync(process.execPath, [destino, '--check']).then(
      () => null,
      (err) => err,
    );

    assert.ok(
      fallo,
      'el chequeo salio 0 sin vendor ni node_modules: el gate del instalador no puede dar rojo',
    );
    assert.equal(fallo.code, 1, `exit esperado 1, salio ${fallo.code}`);
    for (const dep of ['@napi-rs/keyring', 'node-machine-id', '@modelcontextprotocol/sdk']) {
      assert.ok(
        fallo.stdout.includes(`${dep} FALTA`),
        `el reporte no nombra ${dep} como faltante:\n${fallo.stdout}`,
      );
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('el MANIFEST del vendor describe los archivos que estan, con sus sha256', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));

  const declarados = Object.keys(manifest.files ?? {});
  assert.ok(declarados.length > 0, 'el MANIFEST no declara archivos');

  for (const [rel, sha] of Object.entries(manifest.files)) {
    const abs = path.join(VENDOR_DIR, rel);
    assert.ok(fs.existsSync(abs), `el MANIFEST declara ${rel} y el archivo no esta`);
    const actual = crypto
      .createHash('sha256')
      .update(await fsp.readFile(abs))
      .digest('hex');
    assert.equal(actual, sha, `sha256 de ${rel} no coincide con el declarado`);
  }

  // Al reves: un archivo en vendor/ que el MANIFEST no declara es material sin procedencia.
  const enDisco = [];
  const recorrer = (dir, prefijo = '') => {
    for (const nombre of fs.readdirSync(dir)) {
      const rel = prefijo ? `${prefijo}/${nombre}` : nombre;
      if (fs.statSync(path.join(dir, nombre)).isDirectory()) recorrer(path.join(dir, nombre), rel);
      else if (rel !== 'MANIFEST.json') enDisco.push(rel);
    }
  };
  recorrer(VENDOR_DIR);
  assert.deepEqual(
    enDisco.sort(),
    declarados.sort(),
    'vendor/ y el MANIFEST no listan el mismo conjunto de archivos',
  );
});

test('TODA dependencia declarada en package.json esta vendorizada, con la version del lock', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));
  const pkg = JSON.parse(await fsp.readFile(path.join(HOOKS_DIR, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fsp.readFile(path.join(HOOKS_DIR, 'package-lock.json'), 'utf8'));

  // Este es el gate que hace que una dep NUEVA no pueda entrar sin vendorizarse: agregarla a
  // package.json sin correr scripts/build-hooks-vendor.mjs pone rojo el CI en el mismo PR, en
  // vez de reponer el `npm install` en la maquina del cliente por la puerta de atras.
  for (const nombre of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(
      manifest.packages?.[nombre],
      `package.json declara ${nombre} y el vendor no lo trae — corre: node packages/starter-template/scripts/build-hooks-vendor.mjs`,
    );
    assert.equal(
      manifest.packages[nombre],
      lock.packages?.[`node_modules/${nombre}`]?.version,
      `el vendor trae ${nombre}@${manifest.packages[nombre]} y el lock fija otra version: el bundle correria un codigo distinto del que declara`,
    );
  }

  // Y al reves: nada vendorizado que package.json ya no declare (quedaria peso muerto viajando
  // al cliente sin que nadie lo pida).
  for (const nombre of Object.keys(manifest.packages ?? {})) {
    assert.ok(
      pkg.dependencies?.[nombre],
      `el vendor trae ${nombre} y package.json ya no lo declara`,
    );
  }
});

test('.gitattributes fija el fin de linea de TODO el vendor (o lo marca binario)', async () => {
  // Por que existe este test: los sha256 del MANIFEST estan calculados sobre los bytes con LF.
  // Un archivo del vendor que no matchee ninguna regla de .gitattributes se checkoutea con CRLF
  // en Windows (core.autocrlf=true, el default de Git for Windows) y su hash deja de coincidir
  // con el declarado — en la maquina del cliente, no aca. El CI corre en ubuntu, donde el
  // checkout es LF igual, asi que NINGUNA verificacion de contenido puede cazar esto: lo unico
  // que lo previene es la regla, y esto verifica que la regla cubra todo lo que hay.
  const enGit = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: VENDOR_DIR,
  }).then(
    () => true,
    () => false,
  );
  if (!enGit) return; // fuera de un checkout git (ej. el bundle ya instalado en ~/.claude) no aplica

  const archivos = Object.keys(
    JSON.parse(await fsp.readFile(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8')).files,
  );
  archivos.push('MANIFEST.json');

  for (const rel of archivos) {
    const abs = path.join(VENDOR_DIR, rel);
    const { stdout } = await execFileAsync('git', ['check-attr', 'text', 'eol', '--', abs], {
      cwd: VENDOR_DIR,
    });
    const text = /text: (\S+)/.exec(stdout)?.[1];
    const eol = /eol: (\S+)/.exec(stdout)?.[1];
    const binario = text === 'unset';
    const textoLf = text === 'set' && eol === 'lf';
    assert.ok(
      binario || textoLf,
      `${rel} no esta cubierto por .gitattributes (text=${text}, eol=${eol}): en un checkout Windows queda con CRLF y su sha256 deja de coincidir con el del MANIFEST`,
    );
  }
});

// TKT-0335 — specoe-add-room.sh (specoe_keyring_read/write) es Bash y no puede importar
// vendor-deps.mjs: pide el keyring por `require('@napi-rs/keyring')` PELADO desde
// $CLAUDE_HOME/hooks. Ese es un mecanismo de resolucion de Node DISTINTO al import() por path
// que checkDeps() ejerce arriba — resuelve subiendo directorios desde el cwd hasta encontrar
// node_modules/@napi-rs/keyring. El check del instalador (vendor-deps.mjs --check) reportaba
// "OK" mientras ese segundo camino seguia roto: setup.sh copiaba vendor/ pero nunca armaba ese
// node_modules. Las dos pruebas siguientes verifican el mapeo que setup.sh arma ahora (copia de
// vendor/keyring/ a node_modules/@napi-rs/keyring) y que, sin el, el require() pelado es
// falsable (control negativo).

test('el require() PELADO que usa specoe-add-room.sh resuelve si node_modules/@napi-rs/keyring existe (mapeo que arma setup.sh)', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tkt0335-require-pelado-'));
  try {
    const scopeDir = path.join(tmp, 'node_modules', '@napi-rs', 'keyring');
    await fsp.mkdir(path.dirname(scopeDir), { recursive: true });
    await fsp.cp(path.join(VENDOR_DIR, 'keyring'), scopeDir, { recursive: true });

    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', "process.stdout.write(typeof require('@napi-rs/keyring').Entry)"],
      { cwd: tmp },
    );
    assert.equal(
      stdout.trim(),
      'function',
      'require("@napi-rs/keyring") pelado no resolvio Entry con node_modules armado como lo arma setup.sh',
    );
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('CONTROL NEGATIVO — sin node_modules/@napi-rs/keyring, el require() pelado falla', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tkt0335-require-pelado-sin-mapeo-'));
  try {
    const fallo = await execFileAsync(process.execPath, ['-e', "require('@napi-rs/keyring')"], {
      cwd: tmp,
    }).then(
      () => null,
      (err) => err,
    );
    assert.ok(
      fallo,
      'el require() pelado resolvio sin node_modules/@napi-rs/keyring: el gap de TKT-0335 no seria falsable',
    );
    assert.match(fallo.stderr ?? '', /Cannot find module/);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('el vendor trae un .node por cada plataforma que el manifiesto declara cubrir', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));
  assert.ok(
    manifest.keyringPlatforms?.length > 0,
    'el manifiesto no declara plataformas del keyring',
  );
  // La plataforma del piloto no es negociable: el defecto que TKT-0314 cierra es de npm EN
  // WINDOWS, asi que un vendor sin el .node de win32-x64 no cierra nada.
  assert.ok(
    manifest.keyringPlatforms.includes('win32-x64-msvc'),
    'el vendor no cubre win32-x64-msvc',
  );
  for (const plat of manifest.keyringPlatforms) {
    assert.ok(
      manifest.files?.[`keyring/keyring.${plat}.node`],
      `el manifiesto declara cubrir ${plat} y no hay keyring/keyring.${plat}.node`,
    );
  }
});
