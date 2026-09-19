/**
 * Kugou account session.
 *
 * Searching is public, but the canonical recording of a popular song is usually
 * paywalled: without an account the resolve endpoint answers
 * `fail_process: ["pkg","buy"]` and offers a 60-second excerpt. Carrying a
 * logged-in session is what makes the original playable, and it is the one real
 * difference between this plugin and a third-party client that plays VIP songs.
 *
 * The session lives in a small JSON file rather than in the profile config so
 * that re-logging in does not mean hand-editing YAML. It is re-read when its
 * mtime changes, so a fresh login takes effect without restarting the host.
 *
 * @module dsh-music-player/session
 */
import { readFile, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A session with no usable token is treated as "not logged in". */
function normalize(raw) {
  const token = raw?.token ? String(raw.token) : '';
  if (!token) return null;
  return {
    token,
    userid: Number(raw?.userid) || 0,
    dfid: raw?.dfid ? String(raw.dfid) : '',
    mid: raw?.mid ? String(raw.mid) : '',
    vipType: Number(raw?.vipType) || 0,
    savedAt: raw?.savedAt ?? null,
  };
}

/**
 * Reader for the session file, cached and invalidated on mtime change.
 *
 * A missing file is not an error: the plugin works without an account, it just
 * cannot play paywalled originals, and the tool reports that plainly.
 */
export class SessionStore {
  constructor(file) {
    this.file = file;
    this.cached = null;
    this.mtimeMs = -1;
    // Serializes every read-modify-write so concurrent save/saveDevice/clear
    // calls cannot interleave and let a stale snapshot overwrite newer data.
    this._writeQueue = Promise.resolve();
  }

  /**
   * The raw file contents, regardless of whether a token is present.
   *
   * The device identity lives in the same file and must survive a session that
   * is missing or expired: reusing the same device across logins is what keeps
   * an account from looking compromised to Kugou.
   */
  async readRaw() {
    if (!this.file) return {};
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) ?? {};
    } catch (error) {
      // A missing file is the normal "never logged in" case. Anything else —
      // permission denied, truncated/corrupt JSON — must not silently degrade
      // to "no device": surface it so the caller can decide, instead of letting
      // newDevice() happily mint a brand-new device identity on top of it.
      if (error?.code === 'ENOENT') return {};
      console.warn('[session] readRaw failed (not a missing file):', error);
      throw error;
    }
  }

  /**
   * Serialize a read-modify-write onto a single promise chain.
   *
   * The task does its own readRaw() + atomic write while it holds the chain,
   * so two writers can no longer both read the same snapshot and then clobber
   * each other. The queue itself always recovers: a failing task rejects the
   * promise handed to its caller without poisoning every later write.
   */
  _enqueueWrite(task) {
    const done = this._writeQueue.then(() => task());
    this._writeQueue = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  /**
   * Atomically replace the session file with `text`.
   *
   * Write to a sibling `.tmp` first, then rename over the target. On the same
   * volume a rename is atomic, so a crash mid-write leaves either the old file
   * or the new one intact — never a half-written .session.json.
   */
  async _atomicWrite(text) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmpPath = `${this.file}.tmp`;
    await writeFile(tmpPath, text, 'utf8');
    await rename(tmpPath, this.file);
  }

  /** @returns the session, or null when not logged in / file unreadable. */
  async get() {
    if (!this.file) return null;
    try {
      const info = await stat(this.file);
      if (info.mtimeMs === this.mtimeMs) return this.cached;
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      this.cached = normalize(raw);
      this.mtimeMs = info.mtimeMs;
      return this.cached;
    } catch {
      // Missing, unreadable or malformed — behave as "not logged in" rather
      // than failing playback outright.
      this.cached = null;
      this.mtimeMs = -1;
      return null;
    }
  }

  /**
   * Persist a session and make it visible to the next request immediately.
   *
   * Any previously stored device identity is carried over rather than replaced.
   */
  async save(raw) {
    if (!this.file) throw new Error('没有配置 sessionFile，无法保存会话');
    const session = normalize({ savedAt: new Date().toISOString(), ...raw });
    if (!session) throw new Error('登录结果里没有 token，无法保存会话');
    const incomingDevice = raw?.device;
    await this._enqueueWrite(async () => {
      const previous = await this.readRaw();
      const text = `${JSON.stringify(
        { savedAt: session.savedAt, ...session, device: incomingDevice ?? previous.device },
        null,
        2,
      )}\n`;
      await this._atomicWrite(text);
    });
    // Invalidate the cache so the very next tool call sees the new session.
    this.cached = session;
    try {
      this.mtimeMs = (await stat(this.file)).mtimeMs;
    } catch {
      this.mtimeMs = -1;
    }
    return session;
  }

  /** Store just the device identity, before any token exists. */
  async saveDevice(device) {
    if (!this.file) return device;
    await this._enqueueWrite(async () => {
      const previous = await this.readRaw();
      await this._atomicWrite(`${JSON.stringify({ ...previous, device }, null, 2)}\n`);
    });
    this.mtimeMs = -1;
    return device;
  }

  /** Forget the stored session (sign out), but keep the device identity. */
  async clear() {
    if (!this.file) return;
    try {
      await this._enqueueWrite(async () => {
        const raw = await this.readRaw();
        // Do not wipe `device` (and the dfid/mid that ride alongside it): the
        // same device must survive a logout so Kugou does not see a brand-new
        // identity on the next QR login. An empty read simply means "no file",
        // in which case there is nothing worth preserving either.
        const next = Object.keys(raw).length
          ? { ...raw, token: '', userid: 0, vipType: 0, savedAt: new Date().toISOString() }
          : {};
        await this._atomicWrite(`${JSON.stringify(next, null, 2)}\n`);
      });
    } catch {
      // Nothing to clear.
    }
    this.cached = null;
    this.mtimeMs = -1;
  }
}

/**
 * Auth material for one request: query params plus a Cookie header.
 *
 * Kugou accepts the account through either channel depending on the endpoint,
 * so both are sent.
 */
export function sessionAuth(session) {
  if (!session?.token) return { params: {}, cookie: '' };
  const params = { token: session.token };
  if (session.userid) params.userid = session.userid;
  const jar = [`token=${session.token}`];
  if (session.userid) jar.push(`userid=${session.userid}`);
  if (session.dfid) jar.push(`dfid=${session.dfid}`);
  if (session.mid) jar.push(`mid=${session.mid}`);
  return { params, cookie: jar.join('; ') };
}
