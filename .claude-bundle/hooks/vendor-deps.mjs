// vendor-deps.mjs — resuelve las dependencias de los hooks (TKT-0314).
//
// POR QUE EXISTE: hasta TKT-0314 cada hook importaba su dependencia por el nombre pelado
// (`import('@napi-rs/keyring')`), lo que obligaba a que hubiera un node_modules poblado al lado.
// Ese node_modules lo armaba un `npm install` EN LA MAQUINA DEL CLIENTE, y en una VM Windows del
// piloto ese npm aborta con una assertion del event loop de libuv
// (`Assertion failed: new_time >= loop->time, file src\win\core.c, line 327`) sin camino de
// recuperacion desde la maquina del dev. Sin dependencias no carga el binding nativo del
// keyring: la license key no se persiste y el MCP devuelve 401, diez minutos y varios pasos
// despues del `npm install` que fallo.
//
// QUE HACE: prueba primero la copia VENDORIZADA que viaja en el bundle (./vendor/) y recien
// despues el nombre pelado. El orden importa: el vendor es lo que el equipo construyo, hasheo y
// versiono (vendor/MANIFEST.json); node_modules es lo que la maquina del cliente haya podido
// armar. Si el vendor cubre la plataforma, el instalador no corre npm y no hay nada que fallar.
//
// EL FALLBACK NO ES DECORATIVO: el vendor trae el .node del keyring solo para las plataformas
// que el starter documenta (windows x64/arm64, macos arm64/x64, linux x64 gnu). En una
// plataforma fuera de esa lista el import del vendor falla y el nombre pelado es el unico
// camino — por eso el instalador conserva el `npm install` como fallback, ahora TERMINAL si
// tampoco deja las dependencias resueltas.
//
// Los tres loaders LANZAN si ningun camino resuelve, con las dos causas adentro de `cause`. Eso
// preserva la semantica que cada hook ya tenia: los que quieren degradar ya envuelven su import
// en try/catch (secrets.mjs, credentials.mjs) o en `.catch(() => null)` (specoe-license-check).

import { fileURLToPath } from 'node:url';

const VENDOR = new URL('./vendor/', import.meta.url);

// Cache por modulo: los hooks de SessionStart pueden pedir el mismo dep varias veces en una
// corrida y el import dinamico ya cachea, pero el fallback no debe re-intentarse en cada
// llamada cuando el primer camino fallo.
const cache = new Map();

async function load(key, vendorRelative, bareSpecifier) {
  if (cache.has(key)) return cache.get(key);

  let vendorError;
  try {
    const mod = await import(new URL(vendorRelative, VENDOR).href);
    cache.set(key, mod);
    return mod;
  } catch (err) {
    vendorError = err;
  }

  try {
    const mod = await import(bareSpecifier);
    cache.set(key, mod);
    return mod;
  } catch (bareError) {
    const error = new Error(
      `no se pudo cargar ${key}: ni la copia vendorizada (vendor/${vendorRelative}) ni ${bareSpecifier} desde node_modules.`,
      { cause: { vendorError, bareError } },
    );
    // El error NO se cachea: un `npm install` posterior en la misma maquina puede resolverlo, y
    // cachear el fallo dejaria al proceso largo (una sesion de Claude Code) sin volver a probar.
    throw error;
  }
}

/** @napi-rs/keyring — binding NATIVO. Lo unico vendorizable es el .node por plataforma. */
export const loadKeyring = () => load('@napi-rs/keyring', './keyring/index.js', '@napi-rs/keyring');

/** node-machine-id — id estable de la maquina, lo usa el chequeo de licencia. */
export const loadMachineId = () => load('node-machine-id', './machine-id.mjs', 'node-machine-id');

/**
 * Cliente MCP (Client + SSEClientTransport). El bundle del vendor reexporta las dos entradas
 * desde un solo archivo; el fallback las trae de los dos subpaths del SDK.
 */
export async function loadMcpClient() {
  if (cache.has('mcp-client')) return cache.get('mcp-client');

  let vendorError;
  try {
    const mod = await import(new URL('./mcp-client.mjs', VENDOR).href);
    cache.set('mcp-client', mod);
    return mod;
  } catch (err) {
    vendorError = err;
  }

  try {
    const [{ Client }, { SSEClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/sse.js'),
    ]);
    const mod = { Client, SSEClientTransport };
    cache.set('mcp-client', mod);
    return mod;
  } catch (bareError) {
    throw new Error(
      'no se pudo cargar el cliente MCP: ni la copia vendorizada (vendor/mcp-client.mjs) ni @modelcontextprotocol/sdk desde node_modules.',
      { cause: { vendorError, bareError } },
    );
  }
}

/**
 * Reporte por dependencia: `{ ok, via: 'vendor'|'node_modules'|null, error }`.
 * Lo consume el instalador (`node vendor-deps.mjs --check`) para decidir si hace falta el
 * fallback de npm y para cortar con diagnostico si despues del fallback sigue sin resolver.
 * Mide POR EL MISMO CAMINO que usan los hooks: un probe que importara distinto no probaria nada.
 */
export async function checkDeps() {
  const probes = [
    { name: '@napi-rs/keyring', vendor: './keyring/index.js', bare: '@napi-rs/keyring' },
    { name: 'node-machine-id', vendor: './machine-id.mjs', bare: 'node-machine-id' },
    {
      name: '@modelcontextprotocol/sdk',
      vendor: './mcp-client.mjs',
      bare: '@modelcontextprotocol/sdk/client/index.js',
    },
  ];

  const results = [];
  for (const probe of probes) {
    let via = null;
    let error = null;
    try {
      await import(new URL(probe.vendor, VENDOR).href);
      via = 'vendor';
    } catch (vendorError) {
      try {
        await import(probe.bare);
        via = 'node_modules';
      } catch (bareError) {
        error = `vendor: ${vendorError.message} | node_modules: ${bareError.message}`;
      }
    }
    results.push({ name: probe.name, ok: via !== null, via, error });
  }
  return results;
}

// CLI: `node vendor-deps.mjs --check`. Exit 0 = las tres resuelven; 1 = falta alguna.
// Una linea por dependencia en stdout (`<nombre> <vendor|node_modules|FALTA>`) para que el
// instalador pueda nombrar cual falto sin re-parsear nada.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = await checkDeps();
  for (const r of results) {
    console.log(`${r.name} ${r.via ?? 'FALTA'}${r.error ? ` — ${r.error}` : ''}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
