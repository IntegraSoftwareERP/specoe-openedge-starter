// SPEC-0237 P2 (T2.1) — el registro por room y sus topes (ADR-003). `node --test`.
//
// QUE FIJA ESTA SUITE
//
//   1. Rechazo permanente (403) durante 2 h simuladas, pidiendo cada 60 s: toda ventana deslizante
//      de 30 min tiene 3 o menos reservas concedidas, y el backoff sigue indefinidamente.
//   2. 429 permanente y 500 permanente: toda ventana de 60 s tiene 1 o menos reservas y la
//      siguiente se concede a los 60 s — un transitorio NO se cuenta como rechazo. Un 200 despues
//      de un 403 deja la siguiente a los 60 s.
//   3. /sse con aperturas de proxy y bootstrap mezcladas: toda ventana deslizante de 60 min tiene
//      12 o menos.
//   4. Dos procesos node que reservan a la vez sobre el mismo archivo, 20 rondas: en cada una
//      exactamente uno obtiene la reserva.
//   5. Ninguna linea tiene un JWT; un lock de mas de 10 s se rompe; las lineas de mas de 2 h se
//      podan.
//
// CADA "SE CUMPLE EL TOPE" TIENE SU CONTROL: un tope se verifica tambien en que CONCEDE lo que
// tiene que conceder. Un registro que no concede nunca pasaria todos los "3 o menos" de abajo.
//
// Reloj inyectado: `now` es tiempo simulado. Dos horas se recorren en milisegundos reales.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  reserveValidate,
  recordValidateOutcome,
  reserveSseOpen,
  recordSseOpen,
  prune,
  readLedger,
  classifyValidateStatus,
  ledgerPaths,
  VALIDATE_OK,
  VALIDATE_REJECTED,
  VALIDATE_TRANSIENT,
  SOURCE_PROXY,
  SOURCE_BOOTSTRAP,
  SOURCE_HOOK,
} from '../specoe-room-ledger.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_MODULE = pathToFileURL(path.join(HERE, '..', 'specoe-room-ledger.mjs')).href;

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-30T12:00:00.000Z');

function tmpRoom(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specoe-ledger-${name}-`));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/**
 * Pide una renovacion cada `stepMs` durante `durationMs` simulados, contestando `statusAt(t)` a
 * cada reserva concedida. Devuelve los instantes concedidos.
 */
async function simulateValidate({ projectDir, stepMs, durationMs, statusAt }) {
  const granted = [];
  for (let t = T0; t <= T0 + durationMs; t += stepMs) {
    const r = await reserveValidate({ projectDir, source: SOURCE_PROXY, now: t });
    if (!r.granted) continue;
    granted.push(t);
    await recordValidateOutcome({ projectDir, id: r.id, httpStatus: statusAt(t), now: t });
  }
  return granted;
}

/** Maximo de concedidas en cualquier ventana [s, s + windowMs), probando todo s del rango. */
function maxInAnyWindow(times, windowMs, fromMs, toMs, stepMs) {
  let max = 0;
  for (let s = fromMs - windowMs; s <= toMs; s += stepMs) {
    const n = times.filter((t) => t >= s && t < s + windowMs).length;
    if (n > max) max = n;
  }
  return max;
}

// ---------- 0. clasificacion compartida ----------

test('0. clasificacion de status: 403/404 rechazo; 429, 5xx y sin respuesta transitorios', () => {
  assert.equal(classifyValidateStatus(200), VALIDATE_OK);
  assert.equal(classifyValidateStatus(403), VALIDATE_REJECTED);
  assert.equal(classifyValidateStatus(404), VALIDATE_REJECTED);
  assert.equal(classifyValidateStatus(429), VALIDATE_TRANSIENT);
  assert.equal(classifyValidateStatus(500), VALIDATE_TRANSIENT);
  assert.equal(classifyValidateStatus(503), VALIDATE_TRANSIENT);
  assert.equal(classifyValidateStatus(null), VALIDATE_TRANSIENT);
});

// ---------- 1. rechazo permanente ----------

test('1. 403 permanente durante 2 h: toda ventana de 30 min tiene 3 o menos concedidas', async () => {
  const projectDir = tmpRoom('403');
  const granted = await simulateValidate({
    projectDir,
    stepMs: MIN,
    durationMs: 120 * MIN,
    statusAt: () => 403,
  });

  const max = maxInAnyWindow(granted, 30 * MIN, T0, T0 + 120 * MIN, 1000);
  assert.ok(max <= 3, `una ventana de 30 min tuvo ${max} llamadas con rechazo permanente`);
  // Control: el backoff no es "no conceder nunca". Sigue concediendo cada 10 min durante las 2 h
  // enteras (la observacion del verdict r7: el tope no puede vencerse a los 30 min).
  assert.equal(granted.length, 13, `concedidas: ${granted.map((t) => (t - T0) / MIN).join(',')}`);
  for (let i = 1; i < granted.length; i++) {
    assert.equal(
      granted[i] - granted[i - 1],
      10 * MIN,
      'tras un rechazo la siguiente va a los 10 min',
    );
  }
});

// ---------- 2. transitorios ----------

for (const status of [429, 500, null]) {
  test(`2. ${status ?? 'sin respuesta'} permanente: 1 o menos por ventana de 60 s y la siguiente a los 60 s`, async () => {
    const projectDir = tmpRoom(`t${status}`);
    // Se pide cada 20 s: el doble de apurado que el tope, para que el tope tenga algo que frenar.
    const granted = await simulateValidate({
      projectDir,
      stepMs: 20 * 1000,
      durationMs: 120 * MIN,
      statusAt: () => status,
    });

    const max = maxInAnyWindow(granted, MIN, T0, T0 + 120 * MIN, 1000);
    assert.ok(max <= 1, `una ventana de 60 s tuvo ${max} llamadas`);
    // Control: un transitorio NO dispara el backoff de rechazo. Si se contara como rechazo, las
    // concedidas serian 13 (cada 10 min) en vez de 121.
    assert.equal(granted.length, 121);
    for (let i = 1; i < granted.length; i++) {
      assert.equal(granted[i] - granted[i - 1], MIN, 'la siguiente se concede a los 60 s');
    }
  });
}

test('2b. un 200 despues de un 403 deja la siguiente a los 60 s', async () => {
  const projectDir = tmpRoom('403-200');
  const granted = await simulateValidate({
    projectDir,
    stepMs: MIN,
    durationMs: 20 * MIN,
    statusAt: (t) => (t === T0 ? 403 : 200),
  });
  // 403 en 0 -> la siguiente a los 10 min -> 200 -> la siguiente a los 60 s, y asi.
  assert.deepEqual(
    granted.slice(0, 4).map((t) => (t - T0) / MIN),
    [0, 10, 11, 12],
  );
});

test('2c. la llamada del hook cuenta en el tope y no se frena (force)', async () => {
  const projectDir = tmpRoom('hook');
  const proxy = await reserveValidate({ projectDir, source: SOURCE_PROXY, now: T0 });
  assert.equal(proxy.granted, true);
  // 10 s despues el hook llama igual: su llamada no se frena...
  const hook = await reserveValidate({
    projectDir,
    source: SOURCE_HOOK,
    now: T0 + 10000,
    force: true,
  });
  assert.equal(hook.granted, true);
  assert.ok(hook.id, 'la llamada del hook tiene que quedar anotada');
  // ...y cuenta: el proxy recien puede a los 60 s de la del hook, no de la suya.
  const early = await reserveValidate({ projectDir, source: SOURCE_PROXY, now: T0 + 60000 });
  assert.equal(early.granted, false);
  assert.equal(early.retryAfterMs, 10000);
  const onTime = await reserveValidate({ projectDir, source: SOURCE_PROXY, now: T0 + 70000 });
  assert.equal(onTime.granted, true);
});

// ---------- 3. /sse ----------

test('3. /sse con proxy y bootstrap mezclados: 12 o menos por ventana deslizante de 60 min', async () => {
  const projectDir = tmpRoom('sse');
  const granted = [];
  let i = 0;
  // Se pide cada 2 min durante 3 h, alternando source: 90 pedidos contra un tope de 12 por hora.
  for (let t = T0; t <= T0 + 180 * MIN; t += 2 * MIN, i++) {
    const source = i % 2 ? SOURCE_BOOTSTRAP : SOURCE_PROXY;
    const r = await reserveSseOpen({ projectDir, source, now: t });
    if (r.granted) {
      granted.push({ t, source });
      await recordSseOpen({ projectDir, id: r.id, status: 'open', httpStatus: 200, now: t });
    } else {
      assert.ok(
        r.retryAfterMs > 0 && r.retryAfterMs <= 60 * MIN,
        `retryAfterMs fuera de rango: ${r.retryAfterMs}`,
      );
    }
  }
  const times = granted.map((g) => g.t);
  const max = maxInAnyWindow(times, 60 * MIN, T0, T0 + 180 * MIN, 30 * 1000);
  assert.ok(max <= 12, `una ventana de 60 min tuvo ${max} aperturas`);
  // Control: concede hasta el tope, y lo cuenta sobre las dos fuentes juntas.
  assert.equal(max, 12);
  assert.ok(
    granted.some((g) => g.source === SOURCE_PROXY) &&
      granted.some((g) => g.source === SOURCE_BOOTSTRAP),
  );
});

test('3b. la ventana de /sse es deslizante: el lugar se libera cuando vence la apertura mas vieja', async () => {
  const projectDir = tmpRoom('sse-slide');
  for (let k = 0; k < 12; k++) {
    const r = await reserveSseOpen({ projectDir, source: SOURCE_PROXY, now: T0 + k * MIN });
    assert.equal(r.granted, true);
  }
  const lleno = await reserveSseOpen({ projectDir, source: SOURCE_BOOTSTRAP, now: T0 + 30 * MIN });
  assert.equal(lleno.granted, false);
  assert.equal(lleno.retryAfterMs, 30 * MIN, 'la primera vence a los 60 min de abrirse');
  const libre = await reserveSseOpen({ projectDir, source: SOURCE_BOOTSTRAP, now: T0 + 60 * MIN });
  assert.equal(libre.granted, true);
});

// ---------- 4. carrera entre procesos ----------

test('4. dos procesos reservan a la vez sobre el mismo archivo: en cada ronda gana exactamente uno', async () => {
  const projectDir = tmpRoom('race');
  const ROUNDS = 20;
  const child = (simNow, startAt) => {
    const code =
      `const m = await import(${JSON.stringify(LEDGER_MODULE)});` +
      `while (Date.now() < ${startAt}) {}` +
      `const r = await m.reserveValidate({ projectDir: ${JSON.stringify(projectDir)}, source: 'proxy', now: ${simNow} });` +
      `process.stdout.write(JSON.stringify({ granted: r.granted, reason: r.reason }));`;
    return execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
      timeout: 30000,
    }).then((r) => JSON.parse(r.stdout));
  };

  for (let round = 0; round < ROUNDS; round++) {
    const simNow = T0 + round * MIN;
    // Los dos arrancan a esperar un instante comun: el pedido sale en el mismo milisegundo.
    const startAt = Date.now() + 1500;
    const [a, b] = await Promise.all([child(simNow, startAt), child(simNow, startAt)]);
    const ganadores = [a, b].filter((r) => r.granted).length;
    assert.equal(ganadores, 1, `ronda ${round}: ${JSON.stringify([a, b])}`);
  }

  const entries = (await readLedger({ projectDir })).filter((e) => e.kind === 'validate');
  assert.equal(
    entries.length,
    ROUNDS,
    'el registro tiene que tener exactamente una reserva por ronda',
  );
  const ts = entries.map((e) => Date.parse(e.ts)).sort((x, y) => x - y);
  for (let i = 1; i < ts.length; i++) {
    assert.ok(
      ts[i] - ts[i - 1] >= MIN,
      `dos reservas a ${ts[i] - ts[i - 1]} ms en tiempo simulado`,
    );
  }
});

// ---------- 5. sin JWT, lock vencido, poda ----------

test('5a. ninguna linea del registro contiene un JWT', async () => {
  const projectDir = tmpRoom('nojwt');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 'lic', sddRole: 'CC_DEV', exp: 1 })}.firmaFirmaFirma`;

  const v = await reserveValidate({
    projectDir,
    source: SOURCE_PROXY,
    room: 'abcdef0123456789',
    now: T0,
  });
  await recordValidateOutcome({ projectDir, id: v.id, httpStatus: 200, now: T0 });
  const s = await reserveSseOpen({ projectDir, source: SOURCE_PROXY, now: T0 });
  // Un llamador que pasa el token donde iba un claim: el registro lo descarta.
  await recordSseOpen({
    projectDir,
    id: s.id,
    status: 'open',
    httpStatus: 200,
    tenantId: jwt,
    sddRole: 'CC_DEV',
    iat: 100,
    exp: 3700,
    now: T0,
  });

  const raw = fs.readFileSync(ledgerPaths(projectDir).ledger, 'utf8');
  assert.ok(!raw.includes(jwt), 'el registro guardo el JWT');
  assert.doesNotMatch(raw, /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/);
  // Control: los claims que si van, estan.
  const sse = (await readLedger({ projectDir })).find((e) => e.kind === 'sse_open');
  assert.equal(sse.sddRole, 'CC_DEV');
  assert.equal(sse.iat, 100);
  assert.equal(sse.exp, 3700);
  assert.equal(sse.status, 'open');
});

test('5b. un lock de mas de 10 s se rompe; uno fresco no', async () => {
  const projectDir = tmpRoom('lock');
  const { lock } = ledgerPaths(projectDir);

  fs.writeFileSync(lock, 'proceso-que-murio');
  const viejo = new Date(Date.now() - 11 * 1000);
  fs.utimesSync(lock, viejo, viejo);
  const r = await reserveValidate({ projectDir, source: SOURCE_PROXY, now: T0, lockWaitMs: 2000 });
  assert.equal(r.granted, true, `el lock vencido tenia que romperse: ${JSON.stringify(r)}`);
  assert.equal(fs.existsSync(lock), false, 'el lock propio se libera al terminar');

  // Control: un lock de otro proceso vivo (mtime reciente) NO se rompe.
  fs.writeFileSync(lock, 'proceso-vivo');
  const busy = await reserveValidate({
    projectDir,
    source: SOURCE_PROXY,
    now: T0 + 2 * MIN,
    lockWaitMs: 300,
  });
  assert.equal(busy.granted, false);
  assert.equal(busy.reason, 'lock-busy');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'proceso-vivo', 'no se puede borrar el lock de otro');
});

test('5c. las lineas de mas de 2 h se podan', async () => {
  const projectDir = tmpRoom('prune');
  const { ledger } = ledgerPaths(projectDir);
  const line = (ageMs, id) =>
    JSON.stringify({
      kind: 'validate',
      id,
      ts: new Date(T0 - ageMs).toISOString(),
      source: 'proxy',
      outcome: 'OK',
    });
  fs.writeFileSync(
    ledger,
    [line(3 * 60 * MIN, 'vieja'), line(90 * MIN, 'viva'), 'linea rota {'].join('\n') + '\n',
  );

  const r = await prune({ projectDir, now: T0 });
  assert.equal(r.removed, 1, 'la de 3 h');
  const ids = (await readLedger({ projectDir })).map((e) => e.id);
  assert.deepEqual(ids, ['viva']);
  // La linea ilegible tampoco sobrevive a la reescritura.
  assert.ok(!fs.readFileSync(ledger, 'utf8').includes('linea rota'));

  // Tambien poda de paso cualquier operacion de reserva.
  fs.writeFileSync(ledger, line(3 * 60 * MIN, 'vieja') + '\n');
  await reserveSseOpen({ projectDir, source: SOURCE_PROXY, now: T0 });
  assert.ok(!(await readLedger({ projectDir })).some((e) => e.id === 'vieja'));
});
