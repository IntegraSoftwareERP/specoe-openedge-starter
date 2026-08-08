// SPEC-0187 P4 — el arranque del room propaga el diagnostico del servidor. `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// El caso integra-erp: un equipo enrolado PENDIENTE de aprobacion. El backend lo sabia — el
// guard compuesto tiraba MACHINE_PENDING_APPROVAL en cada pedido — pero el arranque del room no
// tenia como decirlo: el JWT salia sin claim, el catalogo no venia, y lo unico que el dev leia
// era un generico "sin rol". Con ese mensaje el dev iba a pedirle a un admin un rol que
// probablemente ya tenia; el admin lo veia otorgado, y nadie sabia para donde seguir.
// Diagnostico correcto server-side, propagacion rota client-side (ADR-002).
//
// LO QUE ESTA SUITE FIJA
//
//   (a) machineAuthorization=PENDING -> el aviso nombra la APROBACION del equipo y NUNCA manda
//       a declarar ni a pedir un rol. Es el caso que origino la SPEC.
//   (b) roleResolution=NOT_DECLARED con identidad SDD presente -> el aviso dice que falta
//       DECLARAR EL ROL y nombra los dos caminos (plugin o launcher), sin hablar de aprobacion.
//   (c) roleResolution=ROLE_NOT_GRANTED -> conserva el aviso vigente con prefijo
//       SPECOE-ROL-RECHAZADO y su discriminacion por seatUserResolved, sin cambio de contrato.
//       (TC-F3 — remediacion del finding F3 LOW del verdict r2: la verification de O3 no
//       ejercitaba este caso, asi que una regresion del aviso vigente pasaba sin ruido.)
//   (d) respuesta SIN machineAuthorization (Hub anterior a P3, o Hub nuevo en USER-mode sin
//       userContext) -> output byte-igual al vigente. No se inventa diagnostico con un dato que
//       no vino: mismo patron honesto que seatUserResolved === false (TKT-0248).
//   (e) control negativo de producto: sin identidad SDD en el canal y sin rol declarado, el
//       output completo del hook no contiene NINGUN aviso. Es la failure_condition literal de
//       O3 — el dia que el caso normal ve diagnosticos, el aviso deja de leerse.
//
// Y la propiedad que sostiene a las cuatro causas: EXCLUSION MUTUA. Si el texto de PENDING y el
// de NOT_DECLARED se pisan, el diagnostico vuelve a apuntar al lado equivocado, que es
// exactamente el defecto que la SPEC vino a cerrar.
//
// Los E2E corren el hook en un subproceso contra un Hub falso de loopback, con
// CLAUDE_PROJECT_DIR y CLAUDE_HOME en temporales: ninguna corrida toca la instalacion real del
// dev ni su keyring (INTEGRA_SECRETS_NO_KEYRING=1 fuerza el cipher-file del home temp).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildStartupDiagnosis,
  buildRoleNotice,
  buildRoleResolutionLog,
  STARTUP_DIAG_PREFIX,
  CAUSE_EQUIPO_PENDIENTE,
  CAUSE_EQUIPO_REVOCADO,
  CAUSE_LOGIN_SDD_INCOMPLETO,
  CAUSE_ROL_NO_DECLARADO,
  MACHINE_AUTH_ACTIVE,
  MACHINE_AUTH_PENDING,
  MACHINE_AUTH_REVOKED,
  MACHINE_AUTH_NOT_ENROLLED,
  OUTCOME_ROLE_NOT_DECLARED,
  OUTCOME_ROLE_NOT_GRANTED,
  ROLE_REJECTED_PREFIX,
  DIAG_PREFIX,
} from '../specoe-license-check.mjs';
import { SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME } from '../sdd-identity.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');
const SECRETS = path.join(HERE, '..', 'secrets.mjs');

// Mismo criterio que rol-declarado-license-validate.test.mjs: en Windows el fingerprint se lleva
// casi todo el presupuesto real con wmic, y aca no medimos presupuesto sino el mensaje de salida.
const TEST_BUDGET_MS = '30000';

const USER_ID = 'usr-cuid-del-seat';
const LICENSE_KEY = 'LIC-TEST-0187-P4';

// El mensaje vigente, el de antes de esta fase. Es la linea contra la que se mide el
// byte-a-byte de (d) y el silencio de (e): un literal, no una construccion del propio hook.
const MENSAJE_VIGENTE = 'SpecOE license: tier=team, features=1';

// Los cuatro status que P3 puede devolver. No hay un quinto: si aparece, este arreglo lo tiene
// que nombrar antes de que el hook lo vea.
const MACHINE_STATUSES = [
  MACHINE_AUTH_ACTIVE,
  MACHINE_AUTH_PENDING,
  MACHINE_AUTH_REVOKED,
  MACHINE_AUTH_NOT_ENROLLED,
];

// ---------- helpers ----------

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-0187p4-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** JWT sin firma valida: solo tiene que ser decodificable. */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

/**
 * Siembra el userId del seat en el canal del home temporal. Va por subproceso a proposito:
 * secrets.mjs congela CLAUDE_HOME al importarse, asi que setearlo desde este proceso despues del
 * import sembraria en el home REAL del dev.
 */
async function seedUserId(home, userId) {
  const code =
    `import(${JSON.stringify(pathToFileURL(SECRETS).href)})` +
    `.then((m) => m.setSecret(${JSON.stringify(SDD_IDENTITY_SERVICE)}, ${JSON.stringify(
      SDD_IDENTITY_USER_NAME,
    )}, ${JSON.stringify(userId)}))`;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_HOME: home, INTEGRA_SECRETS_NO_KEYRING: '1' },
    timeout: 30000,
  });
}

/**
 * Hub falso: activate + validate. `machineAuth` decide el bloque `machineAuthorization` de la
 * respuesta a partir del body recibido, y por default replica la regla del Hub real
 * (license.service.ts resolveMachineAuthorization): el bloque SOLO viaja con userContext. Asi
 * ningun escenario de esta suite es una respuesta de fantasia.
 */
function startFakeHub({ resolver = () => null, machineAuth = () => null } = {}) {
  const recibido = { activate: [], validate: [], session: [], otras: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* body no-JSON: queda {} */
      }
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.endsWith('/license/activate')) {
        recibido.activate.push(body);
        return json(200, { activated: true });
      }
      if (req.url.endsWith('/license/validate')) {
        recibido.validate.push(body);
        const roleResolution = resolver(body);
        const machineAuthorization = body.userContext ? machineAuth(body) : null;
        const payload = { sub: 'lic-1', tier: 'team' };
        if (roleResolution?.servedRole) payload.sddRole = roleResolution.servedRole;
        if (roleResolution?.outcome === OUTCOME_ROLE_NOT_GRANTED) payload.sddRoleDenied = true;
        return json(200, {
          token: fakeJwt(payload),
          tenantId: 'tenant-1',
          tier: 'team',
          features: ['skills'],
          ...(roleResolution ? { roleResolution } : {}),
          ...(machineAuthorization ? { machineAuthorization } : {}),
        });
      }
      if (req.url.endsWith('/auth/sdd/session')) {
        recibido.session.push(body);
        return json(200, { accessToken: fakeJwt({ sub: USER_ID }), expiresIn: 900 });
      }
      recibido.otras.push(req.url);
      return json(404, { message: 'ruta no esperada por el Hub falso' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/v1`,
        recibido,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Corre el hook como lo spawnea Claude Code. Devuelve exit code + el JSON de la ultima linea. */
async function runHook({ projectDir, home, hubUrl, licenseKey = LICENSE_KEY, env = {} }) {
  const childEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_HOME: home,
    INTEGRA_SECRETS_NO_KEYRING: '1',
    INTEGRA_HUB_URL: hubUrl,
    SPECOE_LICENSE_TIMEOUT_MS: TEST_BUDGET_MS,
  };
  if (licenseKey) childEnv.SPECOE_LICENSE_KEY = licenseKey;
  else delete childEnv.SPECOE_LICENSE_KEY;
  // El entorno del dev no debe contaminar el escenario.
  delete childEnv.NODE_EXTRA_CA_CERTS;
  delete childEnv.CLAUDE_ENV_FILE;
  delete childEnv.SPECOE_ALLOW_DEGRADED_START;
  delete childEnv.INTEGRA_SDD_ROLE;
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete childEnv[k];
    else childEnv[k] = v;
  }
  let stdout = '';
  let code = 0;
  try {
    const r = await execFileAsync(process.execPath, [LICENSE_CHECK], {
      encoding: 'utf8',
      timeout: 60000,
      env: childEnv,
    });
    stdout = r.stdout;
  } catch (err) {
    code = err?.code ?? 1;
    stdout = String(err?.stdout ?? '');
  }
  const last = stdout.trim().split('\n').filter(Boolean).pop();
  let json = null;
  try {
    json = last ? JSON.parse(last) : null;
  } catch {
    /* salida no-JSON: los asserts lo nombran */
  }
  return { code, stdout, json, contexto: json?.hookSpecificOutput?.additionalContext ?? null };
}

/** Los cuatro avisos de causa, cada uno con la entrada minima que lo dispara. */
function avisosDeCausa() {
  return {
    [CAUSE_EQUIPO_PENDIENTE]: buildStartupDiagnosis({
      machineAuthorization: { status: MACHINE_AUTH_PENDING },
      sddIdentityPresent: true,
    }),
    [CAUSE_EQUIPO_REVOCADO]: buildStartupDiagnosis({
      machineAuthorization: { status: MACHINE_AUTH_REVOKED },
      sddIdentityPresent: true,
    }),
    [CAUSE_LOGIN_SDD_INCOMPLETO]: buildStartupDiagnosis({
      machineAuthorization: { status: MACHINE_AUTH_NOT_ENROLLED },
      sddIdentityPresent: true,
    }),
    [CAUSE_ROL_NO_DECLARADO]: buildStartupDiagnosis({
      roleResolution: { outcome: OUTCOME_ROLE_NOT_DECLARED, declaredRole: null },
      sddIdentityPresent: true,
    }),
  };
}

// ---------- (a) PENDING: la aprobacion del equipo, nunca el rol ----------

test('(a) PENDING nombra la aprobacion del equipo y NUNCA manda a declarar ni a pedir un rol', () => {
  const aviso = buildStartupDiagnosis({
    machineAuthorization: { status: MACHINE_AUTH_PENDING },
    sddIdentityPresent: true,
  });

  assert.ok(aviso, 'un equipo pendiente tiene que producir aviso: es el caso que origino la SPEC');
  assert.ok(aviso.includes(`${STARTUP_DIAG_PREFIX}:${CAUSE_EQUIPO_PENDIENTE}`), 'falta la causa');
  assert.match(aviso, /aprobacion/i, 'el aviso tiene que nombrar la aprobacion del equipo');
  assert.match(aviso, /ADMIN/, 'y quien la resuelve');

  // Lo que NO puede decir: el diagnostico errado que la SPEC vino a matar.
  assert.ok(
    !/declarar el rol/i.test(aviso),
    'mandar a declarar un rol con el equipo pendiente es trabajo tirado: no se destraba asi',
  );
  assert.ok(
    !/sin rol/i.test(aviso),
    'el generico "sin rol" ES el defecto: el equipo esta pendiente, no falta un rol',
  );
});

test('(a) E2E: con el Hub devolviendo PENDING, el mensaje de sesion lleva el aviso y exit 0', async () => {
  const hub = await startFakeHub({
    resolver: (b) => ({
      outcome: 'GRANTED',
      declaredRole: b.declaredRole ?? null,
      servedRole: b.declaredRole ?? null,
    }),
    machineAuth: () => ({ status: MACHINE_AUTH_PENDING }),
  });
  const home = tmpDir('home-a');
  const project = tmpDir('proj-a');
  try {
    await seedUserId(home, USER_ID);
    const r = await runHook({
      projectDir: project,
      home,
      hubUrl: hub.url,
      env: { INTEGRA_SDD_ROLE: 'CC_DEV' },
    });

    assert.equal(r.code, 0, `un equipo pendiente NO puede cortar el arranque; stdout: ${r.stdout}`);
    assert.equal(r.json?.specoeStatus, 'ok');
    assert.equal(hub.recibido.validate[0].userContext, USER_ID, 'el bloque exige userContext');
    assert.ok(
      r.contexto?.includes(`${STARTUP_DIAG_PREFIX}:${CAUSE_EQUIPO_PENDIENTE}`),
      `el mensaje de sesion tiene que llevar el aviso de equipo pendiente; fue: ${r.contexto}`,
    );
    // El aviso se SUMA al mensaje vigente, no lo reemplaza: el dato de la licencia no se pierde.
    assert.ok(r.contexto.startsWith(MENSAJE_VIGENTE), 'el aviso reemplazo el mensaje vigente');
    // Y el rol estaba GRANTED: el unico problema es el equipo. No puede aparecer el otro canal.
    assert.ok(!r.contexto.includes(ROLE_REJECTED_PREFIX), 'no hubo rechazo de rol que informar');
  } finally {
    await hub.close();
  }
});

// ---------- (b) NOT_DECLARED con identidad: falta declarar el rol ----------

test('(b) NOT_DECLARED con identidad nombra declarar el rol, los dos caminos, y NO la aprobacion', () => {
  const aviso = buildStartupDiagnosis({
    roleResolution: { outcome: OUTCOME_ROLE_NOT_DECLARED, declaredRole: null },
    sddIdentityPresent: true,
  });

  assert.ok(aviso, 'una instalacion SDD sin rol declarado tiene que saber que le falta declararlo');
  assert.ok(aviso.includes(`${STARTUP_DIAG_PREFIX}:${CAUSE_ROL_NO_DECLARADO}`), 'falta la causa');
  assert.match(aviso, /declarar el rol/i, 'tiene que decir que falta declarar el rol');
  // Los DOS caminos: el plugin y el launcher. Nombrar uno solo deja al dev del otro camino sin
  // instruccion, y los dos son igual de validos (ADR-001: el plugin es un launcher mas).
  assert.match(aviso, /plugin/i, 'nombra el camino del plugin');
  assert.match(aviso, /specoe-launch-thinclient\.sh/, 'nombra el camino del launcher CLI');

  assert.ok(
    !/aprobacion/i.test(aviso),
    'no hay nada que aprobar aca: cruzar el texto con el de PENDING es el defecto de la SPEC',
  );
});

test('(b) sin identidad SDD, NOT_DECLARED NO produce aviso — eso es producto legitimo', () => {
  const aviso = buildStartupDiagnosis({
    roleResolution: { outcome: OUTCOME_ROLE_NOT_DECLARED, declaredRole: null },
    sddIdentityPresent: false,
  });
  assert.equal(aviso, null, 'una instalacion de producto no declara rol y esta perfecta asi');
});

// ---------- (c) ROLE_NOT_GRANTED: el aviso vigente, intacto (TC-F3) ----------
//
// F3 LOW del verdict r2: la verification de O3 no ejercitaba este caso. Sin esta prueba, una
// regresion sobre el aviso vigente —el que TKT-0248 y TKT-0263 dejaron como esta— pasaria sin
// ruido justo en la fase que reescribe la seccion de al lado.

test('(c) ROLE_NOT_GRANTED conserva el aviso vigente con su prefijo y su discriminacion', () => {
  const base = { outcome: OUTCOME_ROLE_NOT_GRANTED, declaredRole: 'ENGINEERING', servedRole: null };

  const conSeat = buildRoleNotice({ ...base, seatUserResolved: true });
  const sinSeat = buildRoleNotice({ ...base, seatUserResolved: false });

  for (const aviso of [conSeat, sinSeat]) {
    assert.ok(aviso?.includes(ROLE_REJECTED_PREFIX), 'el prefijo estable del rechazo de rol');
    assert.match(aviso, /ENGINEERING/, 'nombra el rol declarado');
    assert.match(aviso, /AUTORIZACION DE ROL fallo/);
    assert.ok(!aviso.includes(DIAG_PREFIX), 'no es un diagnostico de licencia');
    // El canal nuevo de esta fase NO puede haberse colado en el aviso vigente.
    assert.ok(
      !aviso.includes(STARTUP_DIAG_PREFIX),
      'el aviso de rol rechazado no lleva el prefijo del canal de arranque',
    );
  }

  // TKT-0248 sigue en pie: los dos caminos diagnostican distinto.
  assert.notEqual(conSeat, sinSeat, 'mismo outcome y mismo rol, pero el dev lee cosas distintas');
  assert.match(conSeat, /pedi a un ADMIN/i, 'con usuario del seat, pedir el rol SI corresponde');
  assert.ok(!/pedi a un ADMIN/i.test(sinSeat), 'sin usuario del seat, ese diagnostico es ERRADO');
  assert.match(sinSeat, /login SDD/i, 'y ahi se mira el login SDD');
});

test('(c) el rechazo de rol NO se duplica por el canal nuevo: sin causa de equipo, el aviso es uno solo', () => {
  for (const seatUserResolved of [true, false, undefined]) {
    const aviso = buildStartupDiagnosis({
      roleResolution: {
        outcome: OUTCOME_ROLE_NOT_GRANTED,
        declaredRole: 'CC_DEV',
        seatUserResolved,
      },
      machineAuthorization: { status: MACHINE_AUTH_ACTIVE },
      sddIdentityPresent: true,
    });
    assert.equal(
      aviso,
      null,
      `ROLE_NOT_GRANTED lo sirve buildRoleNotice: el canal nuevo no puede hablar tambien (seatUserResolved=${String(seatUserResolved)})`,
    );
  }
});

test('(c) equipo pendiente Y rol rechazado: el aviso del equipo NO se calla', () => {
  // Los dos hechos son verdaderos y distintos. Callar el del equipo por el del rol reintroduce
  // el "sin rol" enganoso del caso integra-erp: el dev iria a pedir un rol con el equipo sin
  // aprobar, y seguiria sin catalogo despues de que se lo concedan.
  const aviso = buildStartupDiagnosis({
    roleResolution: { outcome: OUTCOME_ROLE_NOT_GRANTED, declaredRole: 'CC_DEV' },
    machineAuthorization: { status: MACHINE_AUTH_PENDING },
    sddIdentityPresent: true,
  });
  assert.ok(aviso?.includes(`${STARTUP_DIAG_PREFIX}:${CAUSE_EQUIPO_PENDIENTE}`));
  assert.match(aviso, /aprobacion/i);
});

// ---------- (d) sin machineAuthorization: byte-igual al vigente ----------

test('(d) sin el bloque machineAuthorization no se inventa diagnostico (Hub viejo o sin userContext)', () => {
  // Las DOS causas de ausencia producen lo mismo, que es el punto: el hook no distingue "Hub
  // anterior a P3" de "USER-mode sin userContext", y no tiene por que — en las dos el dato no
  // vino. Inventarlo seria el error que TKT-0248 ya pago con seatUserResolved.
  assert.equal(buildStartupDiagnosis({ sddIdentityPresent: true }), null);
  assert.equal(
    buildStartupDiagnosis({ machineAuthorization: null, sddIdentityPresent: true }),
    null,
  );
  assert.equal(buildStartupDiagnosis({ machineAuthorization: {}, sddIdentityPresent: true }), null);
  assert.equal(buildStartupDiagnosis(), null, 'sin argumentos tampoco puede romperse');

  // Y con GRANTED del lado del rol, que es el camino feliz completo.
  assert.equal(
    buildStartupDiagnosis({
      roleResolution: { outcome: 'GRANTED', declaredRole: 'CC_DEV', servedRole: 'CC_DEV' },
      sddIdentityPresent: true,
    }),
    null,
  );
});

test('(d) E2E: respuesta sin machineAuthorization deja el mensaje de sesion byte-igual al vigente', async () => {
  const hub = await startFakeHub({
    resolver: (b) => ({
      outcome: 'GRANTED',
      declaredRole: b.declaredRole ?? null,
      servedRole: b.declaredRole ?? null,
    }),
    machineAuth: () => null, // Hub anterior a P3: la clave no existe en la respuesta.
  });
  const home = tmpDir('home-d');
  const project = tmpDir('proj-d');
  try {
    await seedUserId(home, USER_ID);
    const r = await runHook({
      projectDir: project,
      home,
      hubUrl: hub.url,
      env: { INTEGRA_SDD_ROLE: 'CC_DEV' },
    });

    assert.equal(r.code, 0);
    assert.equal(
      r.contexto,
      MENSAJE_VIGENTE,
      'con identidad, rol concedido y un Hub que no manda el bloque, el output es el de antes',
    );
    assert.ok(
      !('machineAuthorization' in (hub.recibido.validate[0] ?? {})),
      'el hook no manda el bloque: lo recibe',
    );
  } finally {
    await hub.close();
  }
});

// ---------- (e) control negativo: producto en silencio ----------

test('(e) sin identidad SDD y sin rol declarado, el output completo del hook no tiene NINGUN aviso', async () => {
  // La failure_condition literal de O3. Sin canal sembrado no hay userContext, asi que el Hub
  // real tampoco mandaria el bloque; el Hub falso replica esa regla. Lo que se afirma es sobre
  // el OUTPUT COMPLETO, no sobre una funcion: es la unica forma de que el assert cubra tambien
  // cualquier aviso que se agregue por otro camino.
  const hub = await startFakeHub({
    resolver: () => ({ outcome: OUTCOME_ROLE_NOT_DECLARED, declaredRole: null, servedRole: null }),
    machineAuth: () => ({ status: MACHINE_AUTH_NOT_ENROLLED }),
  });
  const home = tmpDir('home-e');
  const project = tmpDir('proj-e');
  try {
    const r = await runHook({ projectDir: project, home, hubUrl: hub.url });

    assert.equal(r.code, 0);
    assert.equal(r.json?.specoeStatus, 'ok');
    assert.equal(
      hub.recibido.validate[0].userContext,
      undefined,
      'precondicion del escenario: sin identidad sembrada no viaja userContext',
    );
    assert.equal(
      r.contexto,
      MENSAJE_VIGENTE,
      'una instalacion de producto no puede ganar ni una linea de diagnostico',
    );
    for (const prefijo of [STARTUP_DIAG_PREFIX, ROLE_REJECTED_PREFIX, DIAG_PREFIX]) {
      assert.ok(!r.stdout.includes(prefijo), `apareció ${prefijo} en una instalacion de producto`);
    }
  } finally {
    await hub.close();
  }
});

test('(e) NINGUN status de equipo produce aviso sin identidad SDD local', () => {
  // El discriminador de ruido es la identidad LOCAL, no el status del servidor. Hoy el bloque
  // solo llega con userContext (o sea con identidad), asi que esta guarda no cambia ningun caso
  // real: existe para que un cambio server-side no pueda convertir el caso normal en ruido sin
  // pasar por aca. La cobertura es de los CUATRO status, no de una muestra.
  assert.equal(MACHINE_STATUSES.length, 4, 'aparecio un status nuevo que este test no cubre');
  for (const status of MACHINE_STATUSES) {
    assert.equal(
      buildStartupDiagnosis({ machineAuthorization: { status }, sddIdentityPresent: false }),
      null,
      `status ${status} sin identidad local tiene que quedarse callado`,
    );
    // Control del propio control: con identidad, tres de los cuatro SI hablan. Sin esta mitad,
    // el test de arriba pasaria igual con una funcion que devuelve null siempre.
    const conIdentidad = buildStartupDiagnosis({
      machineAuthorization: { status },
      sddIdentityPresent: true,
    });
    if (status === MACHINE_AUTH_ACTIVE) {
      assert.equal(conIdentidad, null, 'un equipo aprobado no tiene nada que avisar');
    } else {
      assert.ok(conIdentidad, `${status} con identidad tiene que producir aviso`);
    }
  }
});

// ---------- exclusion mutua entre las cuatro causas ----------

test('las cuatro causas producen textos distintos y no cruzan su vocabulario', () => {
  const avisos = avisosDeCausa();
  const textos = Object.values(avisos);

  for (const [causa, texto] of Object.entries(avisos)) {
    assert.ok(texto, `la causa ${causa} no produjo aviso`);
    assert.ok(texto.includes(`${STARTUP_DIAG_PREFIX}:${causa}`), `${causa} no lleva su etiqueta`);
  }
  assert.equal(new Set(textos).size, textos.length, 'dos causas comparten el mismo texto');

  // Cada causa se queda con SU palabra. Es lo que hace que el dev sepa de un vistazo cual es su
  // problema, y lo que impide que PENDING vuelva a leerse como "sin rol".
  const exclusivo = {
    [CAUSE_EQUIPO_PENDIENTE]: /aprobacion/i,
    [CAUSE_EQUIPO_REVOCADO]: /revocad/i,
    [CAUSE_LOGIN_SDD_INCOMPLETO]: /enrolado/i,
    [CAUSE_ROL_NO_DECLARADO]: /declarar el rol/i,
  };
  for (const [duena, patron] of Object.entries(exclusivo)) {
    assert.match(avisos[duena], patron, `${duena} perdio su propia palabra`);
    for (const [otra, texto] of Object.entries(avisos)) {
      if (otra === duena) continue;
      assert.ok(
        !patron.test(texto),
        `el aviso de ${otra} usa el vocabulario de ${duena} (${patron}): los textos se cruzan`,
      );
    }
  }

  // Y ninguno reintroduce el generico que origino la SPEC.
  for (const [causa, texto] of Object.entries(avisos)) {
    assert.ok(!/sin rol/i.test(texto), `${causa} volvio al generico "sin rol"`);
  }
});

test('ningun aviso de causa corta el arranque ni se disfraza de diagnostico de licencia', () => {
  for (const [causa, texto] of Object.entries(avisosDeCausa())) {
    assert.match(texto, /no corta el arranque/i, `${causa} tiene que decir que la sesion arranca`);
    assert.ok(!texto.includes(DIAG_PREFIX), `${causa} no es un diagnostico de licencia`);
    assert.ok(!texto.includes(ROLE_REJECTED_PREFIX), `${causa} no es el aviso de rol rechazado`);
  }
});

// ---------- log estructurado ----------

test('el log estructurado suma el status del equipo, y registra la ausencia como ausencia', () => {
  const conBloque = buildRoleResolutionLog({
    roleResolution: { outcome: 'GRANTED', declaredRole: 'CC_DEV', servedRole: 'CC_DEV' },
    declaredRole: 'CC_DEV',
    machineAuthorization: { status: MACHINE_AUTH_PENDING },
  });
  assert.equal(conBloque.machineAuthStatus, MACHINE_AUTH_PENDING);
  // Los tres datos de SPEC-0176 P2 siguen en la misma linea: contar poblaciones exige cruzarlos.
  assert.equal(conBloque.outcome, 'GRANTED');
  assert.equal(conBloque.declaredRole, 'CC_DEV');
  assert.equal(conBloque.servedRole, 'CC_DEV');

  // Hub viejo / MACHINE-mode: null, no un estado inventado.
  const sinBloque = buildRoleResolutionLog({ roleResolution: null, declaredRole: 'DISCOVERY' });
  assert.equal(sinBloque.machineAuthStatus, null);
  assert.equal(
    buildRoleResolutionLog({ roleResolution: null, declaredRole: null, machineAuthorization: {} })
      .machineAuthStatus,
    null,
    'un bloque sin status es tan ausente como no tener bloque',
  );
});
