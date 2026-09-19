/**
 * Kugou account session.
 * @module dsh-music-player/session
 */
import { readFile, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export class SessionStore {
  constructor(file) {
    this.file = file;
    this.cached = null;
    this.mtimeMs = -1;
    this._writeQueue = Promise.resolve();
  }
  async readRaw() {
    if (!this.file) return {};
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) ?? {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      console.warn('[session] readRaw failed (not a missing file):', error);
      throw error;
    }
  }
  _enqueueWrite(task) {
    const done = this._writeQueue.then(() => task());
    this._writeQueue = done.then(() => undefined, () => undefined);
    return done;
  }
  async _atomicWrite(text) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmpPath = `${this.file}.tmp`;
    await writeFile(tmpPath, text, 'utf8');
    await rename(tmpPath, this.file);
  }
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
      this.cached = null;
      this.mtimeMs = -1;
      return null;
    }
  }
  async save(raw) {
    if (!this.file) throw new Error('没有配置 sessionFile，无法保存会话');
    const session = normalize({ savedAt: new Date().toISOString(), ...raw });
    if (!session) throw new Error('登录结果里没有 token，无法保存会话');
    const incomingDevice = raw?.device;
    await this._enqueueWrite(async () => {
      const previous = await this.readRaw();
      const text = `${JSON.stringify({ savedAt: session.savedAt, ...session, device: incomingDevice ?? previous.device }, null, 2)}\n`;
      await this._atomicWrite(text);
    });
    this.cached = session;
    try { this.mtimeMs = (await stat(this.file)).mtimeMs; } catch { this.mtimeMs = -1; }
    return session;
  }
  async saveDevice(device) {
    if (!this.file) return device;
    await this._enqueueWrite(async () => {
      const previous = await this.readRaw();
      await this._atomicWrite(`${JSON.stringify({ ...previous, device }, null, 2)}\n`);
    });
    this.mtimeMs = -1;
    return device;
  }
  async clear() {
    if (!this.file) return;
    try {
      await this._enqueueWrite(async () => {
        const raw = await this.readRaw();
        const next = Object.keys(raw).length
          ? { ...raw, token: '', userid: 0, vipType: 0, savedAt: new Date().toISOString() }
          : {};
        await this._atomicWrite(`${JSON.stringify(next, null, 2)}\n`);
      });
    } catch {}
    this.cached = null;
    this.mtimeMs = -1;
  }
}

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
