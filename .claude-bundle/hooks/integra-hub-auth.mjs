// Auth helper para Integra Hub — JWT con refresh + cache local.
// SPEC-0005 F3: delegacion de credenciales al modulo credentials.mjs (keyring + fallbacks).
// Export publicos: getAccessToken(), hubFetch().

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getCredentials } from './credentials.mjs';

const SESSION_FILE = path.join(os.homedir(), '.claude', 'integra-hub-session.json');
const REFRESH_SLACK_MS = 60_000; // refrescar 1 minuto antes de expirar

async function loadSession() {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSession(session) {
  await fs.mkdir(path.dirname(SESSION_FILE), { recursive: true });
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

async function login() {
  const { email, password, url } = await getCredentials();
  const res = await fetch(`${url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Hub login fallo ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.accessToken) {
    throw new Error(`Hub login response sin accessToken: ${JSON.stringify(body)}`);
  }
  return normalizeSession(body);
}

async function refresh(session) {
  if (!session.refreshToken) throw new Error('No refreshToken en cache, relogin');
  const { url } = await getCredentials();
  const res = await fetch(`${url}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Refresh fallo ${res.status}`);
  }
  const body = await res.json();
  return normalizeSession(body);
}

// Normaliza la respuesta del Hub. El backend devuelve { accessToken, refreshToken }
// y los tokens son JWT con exp en segundos (epoch). Extraemos exp sin verificar firma.
function normalizeSession(body) {
  const accessExpMs = decodeExpMs(body.accessToken);
  const refreshExpMs = body.refreshToken ? decodeExpMs(body.refreshToken) : null;
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken ?? null,
    accessExpMs,
    refreshExpMs,
  };
}

function decodeExpMs(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(ts) {
  if (!ts) return true;
  return Date.now() + REFRESH_SLACK_MS >= ts;
}

export async function getAccessToken() {
  let session = await loadSession();

  if (!session) {
    session = await login();
    await saveSession(session);
    return session.accessToken;
  }

  if (!isExpired(session.accessExpMs)) {
    return session.accessToken;
  }

  if (session.refreshToken && !isExpired(session.refreshExpMs)) {
    try {
      session = await refresh(session);
      await saveSession(session);
      return session.accessToken;
    } catch {
      // refresh fallo -> caer a login
    }
  }

  session = await login();
  await saveSession(session);
  return session.accessToken;
}

// Wrapper de fetch que retry una vez en 401 (token pudo haber sido revocado)
export async function hubFetch(url, init = {}) {
  const { url: hubUrl } = await getCredentials();
  const fullUrl = url.startsWith('http') ? url : `${hubUrl}${url}`;
  let token = await getAccessToken();
  let res = await fetch(fullUrl, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status !== 401) return res;

  // 401 -> invalidar cache y retry
  try {
    await fs.unlink(SESSION_FILE);
  } catch {
    /* ignore */
  }
  token = await getAccessToken();
  return fetch(fullUrl, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}
