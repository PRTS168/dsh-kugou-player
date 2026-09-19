/**
 * Local Kugou engine manager — the same `app_win.exe` that ships with MoeKoe Music,
 * bundled inside this plugin so playback needs nothing else installed.
 *
 * The engine talks to Kugou's "concept" (lite) client identity and exposes a
 * tiny local HTTP API. The flow that works:
 *
 *   GET /privilege/lite?hash=<identityHash>  (authorise the device for this track)
 *   GET /song/url?hash=<resolvedHash>&quality=flac&ppage_id=356753938
 *
 * @module dsh-music-player/engine
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ENGINE = join(__dirname, '..', 'bin', process.platform === 'win32' ? 'app_win.exe' : 'app_linux');

const PPAGE_ID = '356753938';

let child = null;
let base = null;
let device = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(url, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${url}/everyday/recommend`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('本地引擎启动超时');
}

async function registerDevice({ timeoutMs = 5000 } = {}) {
  if (!base) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base}/register/dev`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      device = j?.data ?? null;
      return device;
    }
  } catch {}
  device = null;
  return null;
}

function buildAuthHeader() {
  if (!device) return null;
  const parts = [];
  if (device.dfid) parts.push(`dfid=${device.dfid}`);
  if (device.mid) parts.push(`KUGOU_API_MID=${device.mid}`);
  if (device.guid) parts.push(`KUGOU_API_GUID=${device.guid}`);
  if (device.serverDev) parts.push(`KUGOU_API_DEV=${device.serverDev}`);
  if (device.mac) parts.push(`KUGOU_API_MAC=${device.mac}`);
  return parts.length > 0 ? parts.join(';') : null;
}

function engineHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const auth = buildAuthHeader();
  if (auth) h.Authorization = auth;
  return h;
}

function parsePrivilegeHash(resp, targetQuality) {
  const entries = [];
  for (const item of resp?.data ?? []) {
    for (const variant of [item, ...(item?.relate_goods ?? [])]) {
      if (variant?.hash && variant?.level !== 0 && variant?.quality) {
        entries.push({ hash: String(variant.hash), quality: String(variant.quality) });
      }
    }
  }
  const byQuality = new Map();
  for (const e of entries) if (!byQuality.has(e.quality)) byQuality.set(e.quality, e.hash);
  return byQuality.get(String(targetQuality)) ?? null;
}

export async function startEngine({ timeoutMs = 15000 } = {}) {
  if (base) return base;
  if (process.env.MUSIC_ENGINE_BASE) {
    base = process.env.MUSIC_ENGINE_BASE.replace(/\/+$/, '');
    await registerDevice();
    return base;
  }
  if (!existsSync(BUNDLED_ENGINE)) throw new Error('未找到打包的引擎 app_win.exe');
  const port = await freePort();
  child = spawn(BUNDLED_ENGINE, ['--platform=lite', `--port=${port}`], {
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  base = `http://127.0.0.1:${port}`;
  await waitReady(base, { timeoutMs });
  await registerDevice();
  return base;
}

export function stopEngine() {
  if (child) { try { child.kill(); } catch {} child = null; }
  base = null;
  device = null;
}

export async function engineAvailable({ timeoutMs = 2500 } = {}) {
  if (!base) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base}/everyday/recommend`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

export async function resolveViaEngine(hash, quality = 'flac', { timeoutMs = 12000, retries = 1, privilegeHash } = {}) {
  if (!base || !hash) throw new Error('本地引擎未运行');
  const privHash = privilegeHash || hash;
  let urlHash = hash;

  const controller0 = new AbortController();
  const timer0 = setTimeout(() => controller0.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/privilege/lite?hash=${encodeURIComponent(privHash)}`, {
      signal: controller0.signal,
      headers: engineHeaders(),
    });
    if (res.ok) {
      const j = await res.json();
      const resolved = parsePrivilegeHash(j, quality);
      if (resolved) urlHash = resolved;
    }
  } catch {
  } finally { clearTimeout(timer0); }

  const path = `/song/url?hash=${encodeURIComponent(urlHash)}&quality=${encodeURIComponent(quality)}&ppage_id=${PPAGE_ID}`;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { signal: controller.signal, headers: engineHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const streamUrl = Array.isArray(j?.url) && j.url[0]
        ? j.url[0]
        : Array.isArray(j?.backupUrl) && j.backupUrl[0]
          ? j.backupUrl[0]
          : null;
      if (j?.status === 1 && streamUrl) {
        return { url: streamUrl, ext: j.extName ?? null, bitrateKbps: j.bitRate ? Math.round(j.bitRate / 1000) : 0 };
      }
      lastError = new Error(`status=${j?.status ?? '?'} ${j?.error ?? ''}`.trim());
    } catch (error) {
      lastError = error;
    } finally { clearTimeout(timer); }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastError ?? new Error('引擎解析失败');
}
