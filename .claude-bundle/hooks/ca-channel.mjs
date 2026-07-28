// SPEC-0164 P1 / T1.2 — canal TLS del bundle: mecanismo UNICO de CA del starter.
//
// Punto unico de definicion. Lo importan specoe-license-check.mjs, specoe-room-bootstrap.mjs
// y scripts/sdd-login.mjs. NINGUNO de ellos importa a otro hook para conseguir el canal.
//
// IMPORTAR ESTE MODULO NO TIENE EFECTOS: no aplica nada, no lee disco, no llama a
// process.exit. Todo pasa cuando se invoca una funcion. Esa propiedad esta cubierta por
// el escenario 7 de test/ca-channel.test.mjs y de ella dependen las herramientas que
// verifican el canal sin arrancar un hook.
//
// ----- POR QUE ESTE MECANISMO -----
//
// Antes el canal se armaba instalando un dispatcher global de undici. Medido en la VM con
// Node v26.5.0: el `fetch` global NO honra el dispatcher de undici userland — con un
// Agent restringido al solo root de Caddy, https://example.com igual devuelve HTTP 200,
// y el Hub igual falla. La funcion era un no-op que ademas logueaba exito.
// Se muta el default CA store del proceso, que es lo que el `fetch` global si consulta —
// y con el los fetch internos del SDK MCP, que el bootstrap del room no controla.
//
// ----- POR QUE EL STORE SE ARMA DESDE 'system' + 'bundled' -----
//
// En Node 26 `getCACertificates('default')` es identico a `getCACertificates('bundled')`:
// el trust de Windows queda AFUERA. En una maquina con SSL scanning del antivirus
// (medido: Norton, root `CN=Norton Web/Mail Shield Root`, presente en 'system' y ausente
// de 'bundled') todo el trafico llega reemitido por ese root, asi que un store armado
// desde 'default' descarta al emisor real y rompe TODAS las conexiones — Hub incluido.
// Medido en contexto A: `default` + Caddy da rojo contra el Hub y contra un host publico;
// `system` + `bundled` + Caddy da HTTP 400 del Hub y HTTP 200 del host publico.
// Es lo mismo que hace `node --use-system-ca`, que no podemos usar porque a los hooks
// los spawnea Claude Code y no controlamos su argv (y meterlo por NODE_OPTIONS seria
// reintroducir el mecanismo por variable de entorno que este fix elimina).
//
// ----- QUE SIGNIFICA EL RESULTADO -----
//
// APLICARLO ANTES DEL PRIMER REQUEST. El cambio de store no re-valida conexiones ya
// abiertas: undici guarda el socket TLS en su pool y lo reusa sin volver a mirar el trust.
// Un canal aplicado despues del primer fetch parece funcionar contra ese host y falla
// contra el siguiente — medido armando la suite de T1.6.
//
// applyCaChannel() responde por el MECANISMO: el CA quedo o no quedo dentro del store
// efectivo del proceso, verificado leyendo el store despues de escribirlo. NO declara que
// el canal sirva — eso es el EFECTO, y lo responde probeCaChannel() o, en los hooks, el
// propio request al Hub. Ninguna linea de log de exito del canal se emite sin haber
// comprobado el efecto que declara.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

export const DEFAULT_CA_PATH = path.join(os.homedir(), '.claude', 'caddy-local-root.crt');

// Cuerpo base64 del PEM, sin cabeceras ni espacios: identidad estable de un certificado
// para comparar contra el store sin parsear los ~142 certs que devuelve Node.
function pemBody(pem) {
  return String(pem)
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

function getStore(kind) {
  try {
    return typeof tls.getCACertificates === 'function' ? tls.getCACertificates(kind) : [];
  } catch {
    // 'system' no esta disponible en toda plataforma/version — no es fatal.
    return [];
  }
}

/**
 * Lee el CA del disco y lo valida como certificado. No aplica nada.
 * @returns {{ok:boolean, caPath:string, pem?:string, subject?:string, issuer?:string,
 *            selfSigned?:boolean, validTo?:string, reason:string, error?:string}}
 */
export function readCaPem(caPath = DEFAULT_CA_PATH) {
  let pem;
  try {
    pem = fs.readFileSync(caPath, 'utf8');
  } catch (err) {
    return { ok: false, caPath, reason: 'ca-missing', error: err?.message };
  }
  try {
    const x = new X509Certificate(pem);
    const cn = (dn) =>
      (
        String(dn)
          .split('\n')
          .find((l) => l.startsWith('CN=')) ?? String(dn)
      ).trim();
    return {
      ok: true,
      caPath,
      pem,
      subject: cn(x.subject),
      issuer: cn(x.issuer),
      selfSigned: x.subject === x.issuer,
      validTo: x.validTo,
      reason: 'ok',
    };
  } catch (err) {
    return { ok: false, caPath, reason: 'ca-unparsable', error: err?.message };
  }
}

/**
 * Aplica el canal: store efectivo = trust del sistema + bundle de Node + el CA del archivo.
 * Verifica el resultado releyendo el store, no asumiendo que la escritura funciono.
 *
 * @returns {{ok:boolean, caPath:string, reason:string, subject?:string, error?:string,
 *            storeBefore?:number, storeAfter?:number, system?:number, bundled?:number}}
 *   ok=true  => el CA esta en el store efectivo del proceso. Es el MECANISMO, no el canal.
 *   ok=false => reason dice por que: ca-missing | ca-unparsable | api-missing |
 *               not-in-effective-store | apply-failed
 */
export function applyCaChannel({ caPath = DEFAULT_CA_PATH } = {}) {
  const ca = readCaPem(caPath);
  if (!ca.ok) return { ok: false, caPath, reason: ca.reason, error: ca.error };

  if (
    typeof tls.setDefaultCACertificates !== 'function' ||
    typeof tls.getCACertificates !== 'function'
  ) {
    return {
      ok: false,
      caPath,
      reason: 'api-missing',
      subject: ca.subject,
      error: `tls.setDefaultCACertificates/getCACertificates no existen en ${process.version}`,
    };
  }

  const system = getStore('system');
  const bundled = getStore('bundled');
  const storeBefore = getStore('default').length;

  try {
    // Set dedup por si el mismo root vive en los dos stores; Node dedup ademas por su cuenta.
    tls.setDefaultCACertificates([...new Set([...system, ...bundled, ca.pem])]);
  } catch (err) {
    return {
      ok: false,
      caPath,
      reason: 'apply-failed',
      subject: ca.subject,
      error: err?.message,
      storeBefore,
      system: system.length,
      bundled: bundled.length,
    };
  }

  // Verificacion del mecanismo: releer el store y buscar el CA adentro. Sin esto,
  // 'aplicado' seria una declaracion sin comprobar — el defecto que este fix repara.
  const effective = getStore('default');
  const wanted = pemBody(ca.pem);
  const inStore = effective.some((c) => pemBody(c) === wanted);

  return {
    ok: inStore,
    caPath,
    reason: inStore ? 'ok' : 'not-in-effective-store',
    subject: ca.subject,
    storeBefore,
    storeAfter: effective.length,
    system: system.length,
    bundled: bundled.length,
  };
}

/**
 * Prueba el EFECTO contra un host real: si el TLS valida, el canal sirve.
 * Un CA valido pero de otro emisor pasa applyCaChannel() y muere aca — que es
 * exactamente la diferencia entre comprobar el mecanismo y comprobar el efecto.
 *
 * @returns {Promise<{ok:boolean, url:string, status?:number, code?:string, error?:string}>}
 */
export async function probeCaChannel(url, { timeoutMs = 5000, method = 'HEAD' } = {}) {
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
    // Cualquier status HTTP significa que el TLS valido: el canal esta abierto.
    return { ok: true, url, status: res.status };
  } catch (err) {
    return {
      ok: false,
      url,
      code: err?.cause?.code ?? err?.code,
      error: err?.cause?.message ?? err?.message,
    };
  }
}

/**
 * Codigo de error de red desempaquetado. `fetch` envuelve todo en TypeError('fetch failed')
 * y el errno verdadero (UNABLE_TO_GET_ISSUER_CERT_LOCALLY, UNABLE_TO_VERIFY_LEAF_SIGNATURE,
 * ENOTFOUND, ...) viaja en err.cause, que los catch descartaban.
 */
export function describeNetworkError(err) {
  // El `code` numerico de un DOMException (23 = ABORT_ERR) no le dice nada a nadie: en ese
  // caso vale mas el name ('TimeoutError', 'AbortError'), que nombra la causa real.
  const raw = err?.cause?.code ?? err?.code ?? null;
  const code = typeof raw === 'string' ? raw : (err?.cause?.name ?? err?.name ?? null);
  return {
    code,
    cause: err?.cause?.message ?? null,
    message: err?.message ?? String(err),
  };
}
