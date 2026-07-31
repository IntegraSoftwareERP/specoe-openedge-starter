// SPEC-0176 P2 — el arranque DECLARA el rol de la carpeta y traduce el rechazo. `node --test`.
//
// EL DEFECTO QUE FIJA ESTA SUITE
//
// Hasta esta fase el rol de un room no viajaba en el validate: el Hub lo resolvia por
// UNICIDAD (un usuario con dos roles activos no desempataba) y un rol NEGADO era
// indistinguible de una carpeta legitimamente sin rol. Los dos casos emitian el mismo JWT
// sin claim `sddRole`, los tools MCP servian el bundle producto en los dos, y la sesion
// arrancaba en silencio. El dev veia "no tengo skills" sin forma de saber si nunca pidio un
// rol o si se lo negaron.
//
// LO QUE ESTA SUITE FIJA
//
//   1. Con INTEGRA_SDD_ROLE seteada, el body del validate LLEVA `declaredRole` con ese
//      valor, al lado del `userContext` de TKT-0232 y en el MISMO request.
//   2. Sin la env, el body NO lleva la clave: byte-a-byte el de antes de esta fase. Sin
//      este control, el test 1 pasaria con un hook que manda cualquier cosa siempre — y una
//      instalacion que no setea la env no se puede romper.
//   3. El valor se normaliza trim+upper: viene de un launcher escrito a mano.
//   4. ADR-001 — `project.config.yaml` NO es fuente de rol. Con `role:` en el yaml y sin la
//      env, el body no lleva `declaredRole`. Una segunda fuente reabre el defecto que esta
//      SPEC cierra, y la unica forma de fijarlo es medir el comportamiento, no leer el codigo.
//   5. Los TRES mensajes de sesion son textos DISTINTOS entre si — sin licencia, producto
//      legitimo, autorizacion de rol rechazada — y los TRES salen con exit 0: el fallo de
//      autorizacion NO bloquea el arranque (contrato de salida de ADR-002, SPEC-0164 P2).
//   6. El rechazo nombra el rol declarado, y los otros cuatro outcomes conservan el mensaje
//      vigente: inventarles aviso convertiria el caso normal en ruido.
//   7. La linea de log estructurada lleva los tres datos (outcome, declaredRole, servedRole)
//      tambien en MACHINE-mode, donde no hay veredicto pero si hay rol declarado.
//
// Los E2E corren el hook en un subproceso contra un Hub falso de loopback, con
// CLAUDE_PROJECT_DIR y CLAUDE_HOME en temporales: ninguna corrida toca la instalacion real
// del dev ni su keyring (INTEGRA_SECRETS_NO_KEYRING=1 fuerza el cipher-file del home temp).

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
  resolveDeclaredRole,
  buildRoleNotice,
  buildRoleResolutionLog,
  ROLE_REJECTED_PREFIX,
  OUTCOME_ROLE_NOT_GRANTED,
  DIAG_PREFIX,
} from '../specoe-license-check.mjs';
import { SDD_IDENTITY_SERVICE, SDD_IDENTITY_USER_NAME } from '../sdd-identity.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_CHECK = path.join(HERE, '..', 'specoe-license-check.mjs');
const SECRETS = path.join(HERE, '..', 'secrets.mjs');

// Mismo criterio que usercontext-license-validate.test.mjs: en Windows el fingerprint se
// lleva casi todo el presupuesto real con wmic, y aca no medimos presupuesto sino el
// contenido del body y el mensaje de salida.
const TEST_BUDGET_MS = '30000';

const USER_ID = 'usr-cuid-del-seat';
const LICENSE_KEY = 'LIC-TEST-0176-P2';

// Los cinco valores del enum SddRoleResolutionOutcome que P1 dejo LIVE. No hay un sexto:
// si aparece uno, este arreglo lo tiene que nombrar antes de que el hook lo vea.
const OUTCOMES = [
  'GRANTED',
  'ROLE_NOT_GRANTED',
  'NO_ROLES_ACTIVE',
  'NOT_DECLARED',
  'AMBIGUOUS_LEGACY',
];

// ---------- helpers ----------

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-0176p2-${name}-`));
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
 * secrets.mjs congela CLAUDE_HOME al importarse, asi que setearlo desde este proceso
 * despues del import sembraria en el home REAL del dev.
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
 * Hub falso: activate + validate. Registra el body de cada request para que el test afirme
 * sobre lo que el hook MANDO, no sobre lo que loguea. `resolver` decide el `roleResolution`
 * de la respuesta a partir del body recibido — asi cada escenario es uno que el Hub real
 * puede producir (license.service.ts resolveBundleRole), no una respuesta de fantasia.
 */
function startFakeHub({ resolver = () => null } = {}) {
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
        const payload = { sub: 'lic-1', tier: 'team' };
        if (roleResolution?.servedRole) payload.sddRole = roleResolution.servedRole;
        if (roleResolution?.outcome === OUTCOME_ROLE_NOT_GRANTED) payload.sddRoleDenied = true;
        return json(200, {
          token: fakeJwt(payload),
          tenantId: 'tenant-1',
          tier: 'team',
          features: ['skills'],
          ...(roleResolution ? { roleResolution } : {}),
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

// ---------- 1. el rol de la env viaja como declaredRole ----------

test('1. con INTEGRA_SDD_ROLE seteada, el validate lleva declaredRole y no gasta requests nuevos', async () => {
  const hub = await startFakeHub({
    resolver: (b) => ({
      outcome: 'GRANTED',
      declaredRole: b.declaredRole ?? null,
      servedRole: b.declaredRole ?? null,
    }),
  });
  const home = tmpDir('home1');
  const project = tmpDir('proj1');
  try {
    await seedUserId(home, USER_ID);
    const r = await runHook({
      projectDir: project,
      home,
      hubUrl: hub.url,
      env: { INTEGRA_SDD_ROLE: 'ENGINEERING' },
    });

    assert.equal(r.code, 0, `el hook no debia bloquear; stdout: ${r.stdout}`);
    assert.equal(r.json?.specoeStatus, 'ok');
    assert.equal(hub.recibido.validate.length, 1, 'el hook tiene que haber validado');
    assert.equal(
      hub.recibido.validate[0].declaredRole,
      'ENGINEERING',
      'el body del validate tiene que declarar el rol de la carpeta',
    );
    // Va AL LADO del userContext, en el MISMO request: TKT-0232 no se pisa.
    assert.equal(hub.recibido.validate[0].userContext, USER_ID);
    assert.equal(hub.recibido.validate[0].licenseKey, LICENSE_KEY);
    assert.ok(hub.recibido.validate[0].fingerprint?.machineId, 'el fingerprint sigue en el body');
    // Cero requests nuevos: el presupuesto del hook (HOOK_BUDGET_MS) no se toca. El rol sale
    // de una env leida en memoria, no de un request ni de un archivo.
    assert.equal(hub.recibido.activate.length, 1, 'un solo activate, como antes');
    assert.equal(hub.recibido.session.length, 0, 'el userId ya estaba: no se deriva');
    assert.deepEqual(hub.recibido.otras, [], 'ninguna ruta nueva del Hub');
  } finally {
    await hub.close();
  }
});

// ---------- 2. control negativo: sin la env, el body es el de antes ----------

test('2. sin INTEGRA_SDD_ROLE, el body NO lleva la clave y el arranque valida igual', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home2');
  const project = tmpDir('proj2');
  try {
    const r = await runHook({ projectDir: project, home, hubUrl: hub.url });

    assert.equal(r.code, 0);
    assert.equal(r.json?.specoeStatus, 'ok');
    assert.equal(hub.recibido.validate.length, 1);
    assert.ok(
      !('declaredRole' in hub.recibido.validate[0]),
      'sin la env la clave no va: el body tiene que ser el de antes de esta fase',
    );
    // Byte-a-byte el de hoy: sin material en el canal tampoco hay userContext, asi que el
    // body es exactamente el par que mandaba el hook antes de TKT-0232 y de esta fase.
    assert.deepEqual(
      Object.keys(hub.recibido.validate[0]).sort(),
      ['fingerprint', 'licenseKey'],
      'el body sumo alguna clave que no estaba',
    );
  } finally {
    await hub.close();
  }
});

// ---------- 3. normalizacion trim+upper ----------

test('3. el rol se normaliza trim+upper — el valor viene de un launcher a mano', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home3');
  const project = tmpDir('proj3');
  try {
    const r = await runHook({
      projectDir: project,
      home,
      hubUrl: hub.url,
      env: { INTEGRA_SDD_ROLE: '  engineering  ' },
    });

    assert.equal(r.code, 0);
    assert.equal(hub.recibido.validate[0].declaredRole, 'ENGINEERING');
  } finally {
    await hub.close();
  }

  // Y el blanco NO es una declaracion: cae a null, no a un rol vacio que el Hub tendria que
  // rechazar. Mismo criterio que license.service.ts resolveBundleRole (`|| null`).
  assert.equal(resolveDeclaredRole({ INTEGRA_SDD_ROLE: '   ' }), null);
  assert.equal(resolveDeclaredRole({ INTEGRA_SDD_ROLE: '' }), null);
  assert.equal(resolveDeclaredRole({}), null);
});

// ---------- 4. ADR-001: el project.config.yaml NO es fuente de rol ----------

test('4. con role: en project.config.yaml y sin la env, el body NO lleva declaredRole', async () => {
  const hub = await startFakeHub();
  const home = tmpDir('home4');
  const project = tmpDir('proj4');
  // El yaml que el starter deja en la carpeta. El hook lo lee para OTRAS cosas (la cuenta
  // del keyring, la url del Hub), y ese es justamente el riesgo: que alguien lo tome como
  // fuente de rol. ADR-001 lo declara inerte y esta prueba lo mide por comportamiento.
  fs.writeFileSync(
    path.join(project, 'project.config.yaml'),
    'specoe:\n  role: DISCOVERY\nhub:\n  api-url: http://no-usar.invalid/api/v1\n',
    'utf8',
  );
  try {
    const r = await runHook({ projectDir: project, home, hubUrl: hub.url });

    assert.equal(r.code, 0);
    assert.equal(hub.recibido.validate.length, 1);
    assert.ok(
      !('declaredRole' in hub.recibido.validate[0]),
      'el yaml declaraba DISCOVERY y el rol NO puede salir de ahi (ADR-001)',
    );
  } finally {
    await hub.close();
  }
});

// ---------- 5. los tres mensajes de sesion son distintos y los tres salen 0 ----------

test('5. sin licencia / producto legitimo / rol rechazado: tres mensajes distintos, exit 0 los tres', async () => {
  const home = tmpDir('home5');

  // (a) SIN LICENCIA — el vigente. PRECONDICION del escenario: no hay key en env, ni en el
  // keyring, ni en el cache de la carpeta. La env se borra, el cache es un temporal vacio y
  // `@napi-rs/keyring` no resuelve desde el repo (se instala en ~/.claude/hooks). Si algun
  // dia resolviera, el assert de abajo lo dice con todas las letras en vez de fallar raro.
  const hubA = await startFakeHub();
  const rA = await runHook({
    projectDir: tmpDir('proj5a'),
    home,
    hubUrl: hubA.url,
    licenseKey: null,
  });
  await hubA.close();
  assert.equal(
    rA.json?.specoeStatus,
    'no-license',
    'el escenario sin licencia no se reprodujo (hay una key alcanzable desde el entorno del test)',
  );

  // (b) PRODUCTO LEGITIMO — el vigente. El usuario no tiene ningun rol activo: no le negaron
  // nada, y por eso el mensaje NO cambia respecto de antes de esta fase.
  const hubB = await startFakeHub({
    resolver: (b) => ({
      outcome: 'NO_ROLES_ACTIVE',
      declaredRole: b.declaredRole ?? null,
      servedRole: null,
    }),
  });
  await seedUserId(home, USER_ID);
  const rB = await runHook({
    projectDir: tmpDir('proj5b'),
    home,
    hubUrl: hubB.url,
    env: { INTEGRA_SDD_ROLE: 'ENGINEERING' },
  });
  await hubB.close();

  // (c) ROL RECHAZADO — el nuevo. Mismo declaredRole que (b): lo unico que cambia es el
  // veredicto del Hub, asi que la diferencia de mensaje no puede venir de otra cosa.
  const hubC = await startFakeHub({
    resolver: (b) => ({
      outcome: OUTCOME_ROLE_NOT_GRANTED,
      declaredRole: b.declaredRole ?? null,
      servedRole: null,
    }),
  });
  const rC = await runHook({
    projectDir: tmpDir('proj5c'),
    home,
    hubUrl: hubC.url,
    env: { INTEGRA_SDD_ROLE: 'ENGINEERING' },
  });
  await hubC.close();

  // Los tres arrancan la sesion: el fallo de autorizacion de rol NO bloquea (ADR-002).
  assert.equal(rA.code, 0, 'sin licencia no puede cortar el arranque');
  assert.equal(rB.code, 0, 'producto legitimo no puede cortar el arranque');
  assert.equal(rC.code, 0, 'un rol no concedido NO puede cortar el arranque');

  // Y los tres dicen cosas distintas: que exista un mensaje no alcanza — hasta esta fase los
  // tres colapsaban en el mismo silencio.
  const [a, b, c] = [rA.contexto, rB.contexto, rC.contexto];
  for (const [nombre, t] of [
    ['sin licencia', a],
    ['producto legitimo', b],
    ['rol rechazado', c],
  ]) {
    assert.ok(t, `el escenario "${nombre}" no emitio ningun mensaje de sesion`);
  }
  assert.equal(new Set([a, b, c]).size, 3, 'dos escenarios comparten el mismo texto');

  // El rechazo nombra el rol declarado y dice que lo que fallo es la AUTORIZACION, no la
  // licencia: atribuirlo a la licencia es el error que ADR-002 ya pago una vez.
  assert.ok(c.includes(ROLE_REJECTED_PREFIX), 'el rechazo tiene que llevar su prefijo estable');
  assert.match(c, /ENGINEERING/, 'el rechazo tiene que nombrar el rol declarado');
  assert.match(c, /AUTORIZACION DE ROL fallo/);
  assert.ok(
    !c.includes(DIAG_PREFIX),
    'el rechazo de rol no es un diagnostico de licencia: no puede llevar el prefijo del otro canal',
  );

  // Producto legitimo conserva el mensaje vigente, sin ruido de rol: si le agregaramos aviso,
  // el caso normal se volveria ruido y el aviso del rechazo dejaria de leerse.
  assert.equal(b, 'SpecOE license: tier=team, features=1');
  assert.ok(!b.includes(ROLE_REJECTED_PREFIX));
  // Y el rechazo es el mensaje vigente MAS el aviso: no se pierde el dato de la licencia.
  assert.ok(c.startsWith(b), 'el aviso se suma al mensaje vigente, no lo reemplaza');
});

// ---------- 6. buildRoleNotice: solo el rechazo habla ----------

test('6. solo ROLE_NOT_GRANTED produce aviso; los otros cuatro outcomes conservan el vigente', () => {
  for (const outcome of OUTCOMES) {
    const notice = buildRoleNotice({ outcome, declaredRole: 'ENGINEERING', servedRole: null });
    if (outcome === OUTCOME_ROLE_NOT_GRANTED) {
      assert.ok(notice, 'el rechazo tiene que producir aviso');
      assert.match(notice, /ENGINEERING/);
    } else {
      assert.equal(notice, null, `${outcome} no puede inventar un aviso: es un estado legitimo`);
    }
  }
  // MACHINE-mode (ADR-006): la respuesta no trae roleResolution y no hay nada que avisar.
  assert.equal(buildRoleNotice(null), null);
  assert.equal(buildRoleNotice(undefined), null);
  // Rechazo sin rol declarado en la respuesta: el aviso sigue saliendo, sin romperse.
  const sinRol = buildRoleNotice({ outcome: OUTCOME_ROLE_NOT_GRANTED, declaredRole: null });
  assert.ok(sinRol?.includes(ROLE_REJECTED_PREFIX));
});

// ---------- 6b. TKT-0248: el aviso diagnostica el camino correcto ----------
//
// El Hub llega a ROLE_NOT_GRANTED por dos caminos con diagnosticos OPUESTOS. Hasta TKT-0248
// el aviso mostraba siempre el de uno solo: cuando el rechazo venia de no haber usuario del
// seat, mandaba al dev a pedir un rol que probablemente YA tenia concedido — el admin miraba,
// lo veia otorgado, y nadie sabia para donde seguir.

test('6b. seatUserResolved=false NO manda a pedir el rol (el rol probablemente ya esta)', () => {
  const notice = buildRoleNotice({
    outcome: OUTCOME_ROLE_NOT_GRANTED,
    declaredRole: 'ENGINEERING',
    servedRole: null,
    seatUserResolved: false,
    reason: 'rol declarado sin userContext: no hay usuario del seat contra quien autorizarlo',
  });

  assert.ok(notice?.includes(ROLE_REJECTED_PREFIX), 'sigue siendo el mismo canal de aviso');
  assert.match(notice, /ENGINEERING/, 'nombra el rol declarado');
  // Lo que NO puede decir: el diagnostico errado que el ticket vino a matar.
  assert.ok(
    !/pedi a un ADMIN/i.test(notice),
    'sin usuario del seat, pedirle el rol a un admin es un diagnostico ERRADO: lo va a ver otorgado',
  );
  // Lo que SI tiene que decir: donde mirar de verdad.
  assert.match(notice, /usuario del seat/i, 'nombra la causa real');
  assert.match(notice, /login SDD/i, 'dice donde mirar');
});

test('6b. seatUserResolved=true SI manda a pedir el rol (ahi el diagnostico es correcto)', () => {
  const notice = buildRoleNotice({
    outcome: OUTCOME_ROLE_NOT_GRANTED,
    declaredRole: 'ENGINEERING',
    servedRole: null,
    seatUserResolved: true,
    reason: "el rol declarado 'ENGINEERING' no esta concedido y activo para el usuario",
  });

  assert.match(notice, /pedi a un ADMIN/i, 'con usuario del seat, pedir el rol SI corresponde');
  assert.match(notice, /Identidad SDD/);
  assert.ok(
    !/login SDD/i.test(notice),
    'no puede mandar a revisar el login: el usuario se resolvio bien',
  );
});

test('6b. los dos caminos producen textos DISTINTOS — es todo el punto del ticket', () => {
  const base = { outcome: OUTCOME_ROLE_NOT_GRANTED, declaredRole: 'CC_DEV', servedRole: null };
  const sinSeat = buildRoleNotice({ ...base, seatUserResolved: false });
  const conSeat = buildRoleNotice({ ...base, seatUserResolved: true });

  assert.notEqual(
    sinSeat,
    conSeat,
    'mismo outcome y mismo rol declarado, pero el dev tiene que leer cosas distintas',
  );
});

test('6b. Hub viejo (sin el campo) nombra las DOS causas en vez de elegir una a la suerte', () => {
  // Un Hub anterior a TKT-0248 no manda `seatUserResolved`. Elegir un diagnostico con un dato
  // que no vino seria inventar; el aviso pasa a describir las dos posibilidades y como
  // distinguirlas. Peor que los otros dos mensajes, pero honesto.
  const notice = buildRoleNotice({
    outcome: OUTCOME_ROLE_NOT_GRANTED,
    declaredRole: 'CC_DEV',
    servedRole: null,
  });

  assert.ok(notice?.includes(ROLE_REJECTED_PREFIX));
  assert.match(notice, /\(a\)/, 'nombra la primera causa posible');
  assert.match(notice, /\(b\)/, 'nombra la segunda');
  assert.match(
    notice,
    /si mirando Identidad SDD el rol figura otorgado, es \(b\)/i,
    'le da al dev como distinguirlas sin el campo',
  );
});

test('6b. `reason` es para leer, no para ramificar: el aviso no lo matchea', () => {
  // Si el aviso dependiera del texto del reason, un cambio de redaccion server-side lo
  // romperia en silencio. Con reason contradictorio y seatUserResolved=true, gana el boolean.
  const notice = buildRoleNotice({
    outcome: OUTCOME_ROLE_NOT_GRANTED,
    declaredRole: 'CC_DEV',
    servedRole: null,
    seatUserResolved: true,
    reason: 'sin userContext: no hay usuario del seat contra quien autorizarlo',
  });

  assert.match(notice, /pedi a un ADMIN/i, 'ramifica por el boolean, no por la prosa del reason');
});

// ---------- 7. la linea de log lleva los tres datos, tambien sin veredicto ----------

test('7. el log estructurado lleva outcome, declaredRole y servedRole en todos los caminos', () => {
  const rechazo = buildRoleResolutionLog({
    roleResolution: {
      outcome: OUTCOME_ROLE_NOT_GRANTED,
      declaredRole: 'ENGINEERING',
      servedRole: null,
    },
    declaredRole: 'ENGINEERING',
  });
  assert.equal(rechazo.outcome, OUTCOME_ROLE_NOT_GRANTED);
  assert.equal(rechazo.declaredRole, 'ENGINEERING');
  assert.equal(rechazo.servedRole, null);
  assert.equal(rechazo.level, 'warn', 'un rol negado no es una linea informativa mas');

  const concedido = buildRoleResolutionLog({
    roleResolution: { outcome: 'GRANTED', declaredRole: 'CC_DEV', servedRole: 'CC_DEV' },
    declaredRole: 'CC_DEV',
  });
  assert.equal(concedido.servedRole, 'CC_DEV');
  assert.equal(concedido.level, 'info');

  // MACHINE-mode: sin veredicto que registrar, pero lo que el room declaro sigue siendo el
  // dato util — es como se cuentan las instalaciones sin ir maquina por maquina.
  const machine = buildRoleResolutionLog({ roleResolution: null, declaredRole: 'DISCOVERY' });
  assert.equal(machine.outcome, null);
  assert.equal(machine.declaredRole, 'DISCOVERY');
  assert.equal(machine.servedRole, null);
  assert.equal(machine.level, 'info');

  // Instalacion anterior a esta fase: ni declara ni recibe veredicto. Los tres en null.
  const legacy = buildRoleResolutionLog({ roleResolution: null, declaredRole: null });
  assert.equal(legacy.outcome, null);
  assert.equal(legacy.declaredRole, null);
  assert.equal(legacy.servedRole, null);
});
