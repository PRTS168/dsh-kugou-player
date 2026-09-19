/**
 * Local Kugou engine manager — the same `app_win.exe` that ships with MoeKoe Music,
 * bundled inside this plugin so playback needs nothing else installed.
 *
 * Why this exists: the public trackercdn endpoint this plugin used to call only knows
 * the *logged-in personal account*, so a non-member gets `status=2` on original studio
 * recordings and only the 60-second preview / live / remix covers remain. The bundled
 * engine talks to Kugou's "concept" (lite) client identity, whose device-level rights
 * cover the original recording with no personal membership. It exposes a tiny local
 * HTTP API. The call we need:
 *
 *   GET {base}/song/url?hash=<sqHash>&quality=flac&ppage_id=356753938
 *     -> { status:1, extName:"flac", bitRate:925000, url:["http://.../file.flac"] }
 *
 * Operational facts, measured 2026-09-19:
 *   - Spawn once on a free port and reuse it. The engine warms its device as it runs;
 *     do not spawn a new one per request.
 *   - Kugou rate-limits `/song/url` after a burst of probes (HTTP 502). Playback calls
 *     are naturally seconds-to-minutes apart, so one short retry suffices; never fan
 *     out many resolve calls in parallel against this path.
 *   - `quality=flac` with the SQ hash returns the original; `high` falls onto a
 *     risk-controlled path and 502s even when flac is fine.
 *
 * The module never spawns on import: tests and the CDN-only fallback must not touch a
 * 34 MB binary. index.js calls startEngine() once when the plugin mounts.
 *
 * @module dsh-music-player/engine
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Bundled engine, resolved relative to lib/. */
const BUNDLED_ENGINE = join(__dirname, '..', 'bin', process.platform === 'win32' ? 'app_win.exe' : 'app_linux');

/** ppage_id the lite client sends; fixed, not secret. */
const PPAGE_ID = '356753938';

let child = null;
/** Active engine base, or null when none is running. */
let base = null;
/**
 * Device identity returned by GET /register/dev. Cached for the lifetime of the
 * engine process; used to build the Authorization header on every upstream call.
 * MoeKoe fetches this once at startup and persists it in localStorage.
 */
let device = null;

/** Pick a TCP port the OS says is free. */
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

/** Poll the engine until it answers, or time out. */
async function waitReady(url, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${url}/everyday/recommend`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('本地引擎启动超时');
}

/**
 * Register this client with the engine and cache the device identity.
 *
 * MoeKoe calls GET /register/dev once at app startup (via a bare axios instance,
 * no Authorization) and stores the result in localStorage. The returned fields
 * (dfid, mid, guid, serverDev, mac) are what the engine forwards to Kugou's
 * upstream as part of the lite-client fingerprint. Without them the upstream is
 * more likely to answer 20028 ("本次请求需要验证").
 *
 * Best-effort: a failure here must not prevent the engine from being used.
 */
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
  } catch {
    // non-fatal
  }
  device = null;
  return null;
}

/**
 * Build the Authorization header value from cached device info.
 *
 * MoeKoe's request interceptor (dist/assets/index-C-amb29U.js, offset 334981)
 * joins truthy fields with `;`:
 *   dfid=<dfid>;KUGOU_API_MID=<mid>;KUGOU_API_GUID=<guid>;
 *   KUGOU_API_DEV=<serverDev>;KUGOU_API_MAC=<mac>
 * (token/userid/t1 are appended only when logged in.)
 * Returns null when there is no device info (caller then omits the header).
 */
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

/** Standard headers for every engine request. */
function engineHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const auth = buildAuthHeader();
  if (auth) h.Authorization = auth;
  return h;
}

/**
 * Parse a /privilege/lite response and return the hash for `targetQuality`,
 * or null when the response does not list that quality.
 *
 * MoeKoe's parser (uA/lA, offset 383000) flattens `data[]` and each item's
 * `relate_goods[]`, deduplicates by quality, and picks the hash for the
 * requested tier. song/url then uses THAT hash — not the one passed to
 * privilege/lite.
 */
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
  for (const e of entries) {
    if (!byQuality.has(e.quality)) byQuality.set(e.quality, e.hash);
  }
  return byQuality.get(String(targetQuality)) ?? null;
}

/**
 * Start the bundled engine (if not already running) and remember its base URL.
 * Safe to call repeatedly. Throws only when no engine binary can be found or it never
 * comes up; callers treat that as "engine unavailable" and fall back to the CDN.
 */
export async function startEngine({ timeoutMs = 15000 } = {}) {
  if (base) return base;
  // An explicit base wins (e.g. use the user's already-running MoeKoe engine).
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
  child.on('error', () => {
    // surfaced through waitReady timeout; nothing to do here
  });
  base = `http://127.0.0.1:${port}`;
  await waitReady(base, { timeoutMs });
  // Best-effort device registration; never blocks engine availability.
  await registerDevice();
  return base;
}

/** Stop the engine this plugin started. No-op if it never started. */
export function stopEngine() {
  if (child) {
    try { child.kill(); } catch { /* already gone */ }
    child = null;
  }
  base = null;
  device = null;
}

/** Is a local engine reachable right now? Never throws, never spawns. */
export async function engineAvailable({ timeoutMs = 2500 } = {}) {
  if (!base) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base}/everyday/recommend`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve a track hash to a playable stream via the local engine.
 *
 * @param {string} hash          Hash for the target quality (sqHash for flac, hqHash
 *                                for 320, fileHash for 128). Used for /song/url.
 * @param {string} quality        One of `flac` | `320` | `128` | `high`.
 * @param {object} options
 * @param {string} [options.privilegeHash]  The "identity" hash to send to
 *   /privilege/lite — MUST be a lower-quality hash (hqHash 320kbps or fileHash
 *   128kbps), NOT the sqHash. MoeKoe always uses the song's main hash here; passing
 *   sqHash makes the privilege response omit the flac mapping and /song/url then
 *   triggers errcode 20028. Defaults to `hash` when omitted (back-compat).
 * @returns {Promise<{url:string, ext:(string|null), bitrateKbps:number}>}
 */
export async function resolveViaEngine(hash, quality = 'flac', { timeoutMs = 12000, retries = 1, privilegeHash } = {}) {
  if (!base || !hash) throw new Error('本地引擎未运行');

  // /privilege/lite must be called with the song's identity hash (320 / 128 kbps),
  // never the sqHash. Its response lists every quality with its own hash; we pick
  // the one for `quality` and feed that to /song/url. This is exactly MoeKoe's
  // flow (addSongToQueue → Qe("/privilege/lite",{hash:c}) → uA() → cA() →
  // Qe("/song/url",{hash:U.hash, quality:U.quality, ppage_id:"356753938"})).
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
    // non-fatal: fall back to the caller-supplied hash for /song/url
  } finally {
    clearTimeout(timer0);
  }

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
        return {
          url: streamUrl,
          ext: j.extName ?? null,
          bitrateKbps: j.bitRate ? Math.round(j.bitRate / 1000) : 0,
        };
      }
      lastError = new Error(`status=${j?.status ?? '?'} ${j?.error ?? ''}`.trim());
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastError ?? new Error('引擎解析失败');
}
