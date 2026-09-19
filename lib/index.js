/**
 * dsh-music-player — a self-contained network music player for DeepSeek
 * Harness.
 *
 * The plugin registers five model-facing tools and owns the whole path from a
 * spoken song name to sound leaving this machine's speakers:
 *
 *   play_music     search a song by name and play it (optionally on repeat)
 *   music_control  pause / resume / stop / set volume / toggle single-track loop
 *   music_status   what is playing, how far in, at what volume
 *   search_music   the candidates behind a name, so the model can offer a choice
 *   music_login    scan a QR code to log into Kugou for original/VIP playback
 *
 * There is no companion application and no external player binary: the track is
 * fetched from Kugou's public CDN and rendered in-process by node-web-audio-api.
 * See README.md for the catalogue limits that follow from playing without an
 * account.
 *
 * Tool definitions are passed as plain objects with compiled JSON Schema rather
 * than through `defineTool`, so the plugin's only runtime dependency stays the
 * audio engine itself.
 *
 * @module dsh-music-player
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findAndResolve, searchTracks, availableTiers, matchConfidence, looksTruncated } from './kugou.js';
import { MusicPlayer, formatTime } from './player.js';
import { SessionStore } from './session.js';
import { registerDevice, createQrSession, checkQrSession, renderQrPng } from './login.js';
import { newDevice } from './kugou-crypto.js';
import { startEngine, stopEngine } from './engine.js';

/** Where the account session lives when the profile config does not say. */
const DEFAULT_SESSION_FILE = join(dirname(dirname(fileURLToPath(import.meta.url))), '.session.json');

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-music-player';

/**
 * The tool registry is the only hard requirement.
 *
 * `systemPrompt` is read through `ctx.get()` instead of being injected: cordis
 * treats `inject` as a wait gate, so listing a service this host happens not to
 * mount would leave the whole plugin silently inactive — and losing playback
 * entirely is a far worse outcome than losing the prompt hint.
 */
export const inject = ['tools'];

/** Defaults applied when the profile config omits a field. */
const DEFAULTS = {
  volume: 60,
  quality: 'auto',
  searchLimit: 8,
  timeoutMs: 20000,
  maxTrackMinutes: 12,
  sink: 'auto',
};

/** Resolve profile config against the defaults, ignoring unusable values. */
function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) };
  const quality = ['auto', '128', '320', 'flac'].includes(String(config.quality)) ? String(config.quality) : 'auto';
  return {
    volume: Number.isFinite(Number(config.volume)) ? Number(config.volume) : DEFAULTS.volume,
    quality,
    searchLimit: Number.isInteger(config.searchLimit) && config.searchLimit > 0 ? config.searchLimit : DEFAULTS.searchLimit,
    timeoutMs: Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs,
    maxTrackMinutes:
      Number.isFinite(Number(config.maxTrackMinutes)) && Number(config.maxTrackMinutes) > 0
        ? Number(config.maxTrackMinutes)
        : DEFAULTS.maxTrackMinutes,
    sink: typeof config.sink === 'string' && config.sink.trim() ? config.sink.trim() : DEFAULTS.sink,
    sessionFile: typeof config.sessionFile === 'string' && config.sessionFile.trim() ? config.sessionFile.trim() : DEFAULT_SESSION_FILE,
  };
}

/** One display line for a finished or playing track. */
function describeTrack(track, stream, extra = '') {
  const singer = track.singer ? ` — ${track.singer}` : '';
  const quality = stream?.qualityLabel ? ` [${stream.qualityLabel}]` : '';
  return `${track.name}${singer}${quality}${extra}`;
}

/**
 * Mount the player and register its tools.
 *
 * @param ctx    host context whose `tools` registry receives the definitions
 * @param config resolved profile config (front-loaded by the cordis loader)
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const report = (kind, error) => {
    try {
      ctx.get('logger')?.warn?.(`[dsh-music-player] ${kind}: ${error?.message ?? error}`);
    } catch {
      // The context is gone (live patch reload); audio cleanup still runs.
    }
  };

  const player = new MusicPlayer({
    volume: resolved.volume,
    maxTrackMinutes: resolved.maxTrackMinutes,
    sink: resolved.sink,
    onProblem: report,
  });

  // Account session, re-read when the file changes so a fresh `npm run login`
  // takes effect without restarting the host.
  const sessions = new SessionStore(resolved.sessionFile);

  /**
   * Login in progress via QR: the key to poll and where the image was written.
   * Held for the turn sequence between qr_start and qr_poll.
   */
  let pendingQr = null;
  const qrImagePath = join(dirname(resolved.sessionFile), 'kugou-login-qr.png');

  // A reload or restart must never leave a track playing with no owner.
  ctx.effect(() => () => {
    void player.dispose();
    stopEngine();
  });

  // Best-effort: bring up the bundled local engine so original recordings resolve.
  // If it fails (no binary, port busy, Kugou temporarily blocking), playback still
  // works through the public CDN fallback — never block plugin mount on the engine.
  startEngine().catch((error) => {
    report('engine/start', error);
  });

  const timeoutMs = resolved.timeoutMs;

  // ---- search_music ------------------------------------------------------
  ctx.tools.register({
    name: 'search_music',
    description:
      'Search online music by song name or "song artist" and list the candidates. ' +
      'Use it when the user asks what is available, when several recordings share a title, ' +
      'or before play_music when you need to confirm which version to play. ' +
      'Returns each candidate with artist, duration and the audio qualities it offers.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '曲名，或「曲名 歌手」。' },
        limit: { type: 'integer', description: '返回候选数量，默认 8。' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'count', 'candidates', 'message'],
        properties: {
          query: { type: 'string' },
          count: { type: 'integer' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'singer', 'durationSec', 'qualities'],
              properties: {
                name: { type: 'string' },
                singer: { type: 'string' },
                durationSec: { type: 'integer' },
                qualities: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim();
      if (!query) return { query, count: 0, candidates: [], message: '❌ 搜索关键词不能为空' };
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : resolved.searchLimit;
      try {
        const tracks = await searchTracks(query, { limit, timeoutMs, signal: exec?.signal });
        if (tracks.length === 0) {
          return { query, count: 0, candidates: [], message: `❌ 没有搜到《${query}》。换个关键词，或只给歌名试试。` };
        }
        const candidates = tracks.map((t) => ({
          name: t.name,
          singer: t.singer,
          durationSec: Math.round(t.durationSec),
          qualities: availableTiers(t).map((tier) => tier.label),
        }));
        const lines = candidates.map(
          (c, i) => `${i + 1}. ${c.name} — ${c.singer}（${formatTime(c.durationSec)}｜${c.qualities.join('/') || '无可用音质'}）`,
        );
        return {
          query,
          count: candidates.length,
          candidates,
          message: `搜索「${query}」找到 ${candidates.length} 个候选：\n${lines.join('\n')}\n\n想播放哪首，告诉我歌名和歌手。`,
        };
      } catch (error) {
        return { query, count: 0, candidates: [], message: `❌ 搜索失败：${error?.message ?? error}` };
      }
    },
  });

  // ---- play_music --------------------------------------------------------
  ctx.tools.register({
    name: 'play_music',
    description:
      "Search a song by name and play it out loud on this machine's speakers. " +
      'Use it whenever the user asks to play, put on, or listen to a song — no URL needed. ' +
      'Set loop=true for single-track repeat (单曲循环). Starting a new song replaces the current one. ' +
      'Returns what is now playing.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '曲名，或「曲名 歌手」。例如「晴天 周杰伦」。' },
        loop: { type: 'boolean', description: 'true = 单曲循环。默认 false。' },
        quality: {
          type: 'string',
          enum: ['auto', '128', '320', 'flac'],
          description: '音质偏好；auto=取该曲可用的最高音质（默认）。',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'name', 'singer', 'quality', 'loop', 'state', 'needsLogin', 'message'],
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          singer: { type: 'string' },
          quality: { type: 'string' },
          loop: { type: 'boolean' },
          state: { type: 'string' },
          needsLogin: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim();
      const loop = args?.loop === true;
      const quality = ['auto', '128', '320', 'flac'].includes(String(args?.quality))
        ? String(args.quality)
        : resolved.quality;
      const failure = (message) => ({
        ok: false,
        name: '',
        singer: '',
        quality: '',
        loop,
        state: player.state,
        needsLogin: false,
        message,
      });

      if (!query) return failure('❌ 请给出曲名，例如「晴天 周杰伦」。');

      try {
        let needsLogin = false;
        // findAndResolve ranks the candidates and returns the best one that is
        // actually playable, plus whatever it had to skip to get there.
        const session = await sessions.get();
        // A dead/expired token makes Kugou reject every resolve attempt. Clear
        // the login state (keeping the device identity) the moment it is
        // detected, so the next play asks for a fresh QR scan instead of
        // retrying the dead token.
        let sessionInvalidated = false;
        const onInvalidSession = () => {
          sessionInvalidated = true;
          void sessions.clear();
        };
        const { track, stream, candidates, skipped } = await findAndResolve(query, {
          limit: resolved.searchLimit,
          quality,
          timeoutMs,
          session,
          signal: exec?.signal,
          onInvalidSession,
        });

        if (sessionInvalidated) needsLogin = true;

        await player.play(track, stream, { loop, signal: exec?.signal });
        const loopNote = loop ? '，单曲循环' : '';

        const caveats = [];

        // The canonical recording is often in the catalogue but paywalled. Say
        // which version is playing and what was passed over, rather than
        // letting the model present a live cover as the original.
        const paid = (skipped ?? []).filter((s) => s.reason === 'paid');
        if (paid.length > 0) {
          // Even with a token, being skipped means the login lacks rights for
          // these tracks (or the token is weak): always surface needsLogin.
          needsLogin = true;
          caveats.push(
            session?.token
              ? 'ℹ️ 当前登录账号可能不含这些曲目的会员权益，播放的是可免费版本。'
              : 'ℹ️ 此曲原版需要登录才能播放，正在为你准备登录二维码，扫码后即可听原版。当前播放的是可免费版本。',
          );
        }

        // A weak title match means the catalogue had no real version of what was
        // asked for. Say so: the model must not report "正在播放 晴天" when what
        // is playing is a different recording entirely.
        if (matchConfidence(track, query) < 0.6) {
          caveats.push(
            `⚠️ 曲库没有与「${query}」精确匹配的版本，播放的是最接近的结果。` +
              '如需指定版本，请先用 search_music 看候选。',
          );
        }
        // A stub-length entry is a 试听 excerpt, not a short song.
        if (looksTruncated(track, candidates)) {
          caveats.push(
            `⚠️ 该条目标注时长仅 ${formatTime(track.durationSec)}，明显短于同曲其他版本，` +
              '很可能是试听片段。可用 search_music 换其他版本。',
          );
        }
        const caveat = caveats.length > 0 ? `\n${caveats.join('\n')}` : '';

        return {
          ok: true,
          name: track.name,
          singer: track.singer,
          quality: stream.qualityLabel ?? '',
          loop,
          state: player.state,
          needsLogin,
          message: `▶️ 正在播放：${describeTrack(track, stream)}（${formatTime(track.durationSec)}）${loopNote}${caveat}`,
        };
      } catch (error) {
        return failure(`❌ 播放失败：${error?.message ?? error}`);
      }
    },
  });

  // ---- music_control -----------------------------------------------------
  ctx.tools.register({
    name: 'music_control',
    description:
      'Control the music already playing on this machine: pause, resume, toggle play/pause, ' +
      'stop, change volume, or turn single-track repeat on and off. ' +
      'Use it for "暂停/继续/停下/大声点/小声点/单曲循环/取消循环".',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'toggle', 'stop', 'volume', 'loop'],
          description:
            'pause=暂停, resume=继续, toggle=在暂停与播放间切换, stop=停止并卸载, ' +
            'volume=设置音量(需同时给 volume), loop=开关单曲循环(需同时给 loop)',
        },
        // Typed separately rather than as one polymorphic `value`: a
        // number-or-boolean union is awkward for providers to validate, and an
        // invalid schema here is rejected at request time — which fails the
        // whole turn, not just the tool call.
        volume: {
          type: 'number',
          description: '音量百分比 0-100。仅 action=volume 时使用。',
        },
        loop: {
          type: 'boolean',
          description: 'true=开启单曲循环，false=关闭。仅 action=loop 时使用。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'state', 'volume', 'loop', 'name', 'message'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          state: { type: 'string' },
          volume: { type: 'number' },
          loop: { type: 'boolean' },
          name: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs,
    async execute(args) {
      const action = String(args?.action ?? '');
      const snapshot = () => {
        const s = player.status();
        return { action, ok: true, state: s.state, volume: s.volume, loop: s.loop, name: s.name ?? '' };
      };
      const idle = '当前没有播放中的音乐。';

      try {
        switch (action) {
          case 'pause': {
            if (player.state !== 'playing') return { ...snapshot(), ok: false, message: `❌ 无法暂停：${idle}` };
            const s = await player.pause();
            return {
              ...snapshot(),
              message: `⏸️ 已暂停：${s.name}${s.singer ? ` — ${s.singer}` : ''}（${formatTime(s.elapsedSec)}/${formatTime(s.durationSec)}）`,
            };
          }
          case 'resume': {
            if (player.state !== 'paused') return { ...snapshot(), ok: false, message: `❌ 无法继续：${idle}` };
            const s = await player.resume();
            return { ...snapshot(), message: `▶️ 已继续：${s.name}（${formatTime(s.elapsedSec)}/${formatTime(s.durationSec)}）` };
          }
          case 'toggle': {
            if (player.state === 'idle') return { ...snapshot(), ok: false, message: `❌ 无法切换：${idle}` };
            const s = await player.toggle();
            return { ...snapshot(), message: s.state === 'paused' ? `⏸️ 已暂停：${s.name}` : `▶️ 已继续：${s.name}` };
          }
          case 'stop': {
            if (player.state === 'idle') return { ...snapshot(), message: '⏹️ 本来就没有在播放。' };
            const s = player.stop();
            return { ...snapshot(), message: `⏹️ 已停止（${s.name ?? '当前曲目'}）` };
          }
          case 'volume': {
            if (typeof args?.volume !== 'number' || !Number.isFinite(args.volume)) {
              return { ...snapshot(), ok: false, message: '❌ volume 需要同时给出 volume: 0-100 的数字。' };
            }
            const volume = player.setVolume(args.volume);
            return { ...snapshot(), message: `🔊 音量已设为 ${volume}%` };
          }
          case 'loop': {
            if (typeof args?.loop !== 'boolean') {
              return { ...snapshot(), ok: false, message: '❌ loop 需要同时给出 loop: true 或 false。' };
            }
            const loop = player.setLoop(args.loop);
            return { ...snapshot(), message: loop ? '🔁 已开启单曲循环' : '➡️ 已关闭单曲循环（播完即停）' };
          }
          default:
            return { ...snapshot(), ok: false, message: `❌ 未知操作「${action}」。可用：pause/resume/toggle/stop/volume/loop` };
        }
      } catch (error) {
        return { ...snapshot(), ok: false, message: `❌ 操作失败：${error?.message ?? error}` };
      }
    },
  });

  // ---- music_login -------------------------------------------------------
  ctx.tools.register({
    name: 'music_login',
    description:
      'Log in to the Kugou account with one QR scan so original studio recordings and VIP tracks can be played. ' +
      'Searching works without an account, but a popular song\'s original resolves to only a 60-second excerpt ' +
      'until a session exists. Flow: call action="qr_start" (it returns qrImagePath, a local PNG path), then call ' +
      'wechat_send_image(qrImagePath) to send the QR image to the WeChat user — the bridge does NOT forward it ' +
      'automatically. Ask the user to scan it with the Kugou app and confirm, then call action="qr_poll" once ' +
      '— it auto-polls for about 15 seconds. If it returns waiting, tell the user to scan and reply, ' +
      'then call qr_poll again in the next turn. action="status" reports the login state; ' +
      'action="logout" forgets the session. Login is QR-only — do not ask for a phone number or SMS code.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['qr_start', 'qr_poll', 'status', 'logout'],
          description:
            'qr_start=生成登录二维码, qr_poll=轮询扫码结果(用户扫码确认后反复调用直到成功/过期), ' +
            'status=查询登录状态, logout=清除本地会话',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'loggedIn', 'userid', 'message'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          loggedIn: { type: 'boolean' },
          userid: { type: 'integer' },
          // qr_start 成功时给出二维码 PNG 的绝对路径；微信桥接层应读取该文件并作为图片消息发出。
          // 仅 qr_start 填充，其余动作为空串。
          qrImagePath: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs,
    async execute(args) {
      const action = String(args?.action ?? '');

      const state = async () => {
        const session = await sessions.get();
        return { loggedIn: Boolean(session?.token), userid: session?.userid ?? 0 };
      };

      // Kugou ties a session to one device identity, so the same one must be
      // presented across the two login calls and reused on any later re-login.
      const device = async () => {
        const raw = await sessions.readRaw();
        if (raw?.device?.mid && raw?.device?.guid) return raw.device;
        const fresh = newDevice();
        await sessions.saveDevice(fresh);
        return fresh;
      };

      /**
       * Make sure Kugou recognises this device before asking it for anything.
       *
       * A locally invented dfid is not trusted — `send_mobile_code` answers
       * "请先通过验证" until the device has been registered, so this runs once
       * and the server-issued dfid is kept for every later request.
       */
      const registeredDevice = async () => {
        const dev = await device();
        if (dev.registered && dev.dfid) return { ok: true, device: dev };
        const reg = await registerDevice(dev);
        if (!reg.ok) return { ok: false, error: reg.error, device: dev };
        const updated = { ...dev, dfid: reg.dfid, registered: true };
        await sessions.saveDevice(updated);
        return { ok: true, device: updated };
      };

      try {
        switch (action) {
          case 'qr_start': {
            // Already logged in? Don't mint a pointless new QR code.
            const cur = await state();
            if (cur.loggedIn) {
              return {
                ok: true,
                action,
                loggedIn: true,
                userid: cur.userid,
                qrImagePath: '',
                message: '✅ 已登录酷狗账号，无需重复扫码。如需切换账号请先退出登录。',
              };
            }
            // A QR from the last 3 minutes is still valid: reuse it instead of
            // overwriting the image the user may already be pointing a phone at.
            if (pendingQr && Date.now() - pendingQr.createdAt < 180000 && existsSync(qrImagePath)) {
              return {
                ok: true,
                action,
                loggedIn: false,
                userid: 0,
                qrImagePath,
                message: '📷 上一个登录二维码仍有效。请调用 wechat_send_image 把二维码图片发给用户（如尚未发送），让他用酷狗App扫码确认。',
              };
            }
            const ready = await registeredDevice();
            if (!ready.ok) {
              const s = await state();
              return { ok: false, action, ...s, message: `❌ 设备注册失败：${ready.error}` };
            }
            const qr = await createQrSession(ready.device, { timeoutMs });
            if (!qr.ok) {
              const s = await state();
              return { ok: false, action, ...s, message: `❌ 生成二维码失败：${qr.error}` };
            }

            let imagePath = null;
            try {
              await renderQrPng(qr.url, qrImagePath);
              imagePath = qrImagePath;
            } catch (error) {
              report('login/qrImage', error);
            }
            pendingQr = { key: qr.key, device: ready.device, createdAt: Date.now() };

            // Best-effort: show the code immediately, since the whole point is
            // that the user has to point a phone at it.
            if (imagePath && existsSync(imagePath)) {
              try {
                spawn('cmd', ['/c', 'start', '', imagePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
              } catch (error) {
                report('login/qrOpen', error);
              }
            }

            const s = await state();
            return {
              ok: true,
              action,
              ...s,
              qrImagePath: imagePath ?? '',
              message: imagePath
                ? '📷 登录二维码已生成，用酷狗App扫码确认。'
                : `📷 二维码生成失败，请把这个链接发给用户用【酷狗App】扫码：\n${qr.url}`,
            };
          }

          case 'qr_poll': {
            if (!pendingQr) {
              const s = await state();
              return { ok: false, action, ...s, message: '❌ 还没有生成二维码，请先调用 qr_start。' };
            }
            // Auto-poll a bounded window inside this single call: the user does
            // not have to say "扫好了". We stay well under the tool timeout so a
            // successful scan returns within one turn.
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const maxAttempts = 6;
            const gapMs = 2500;
            let chk = null;
            // Single-attempt timeout must stay well under the tool budget:
            // with 6 attempts we still have to finish inside `timeoutMs`.
            const attemptTimeout = Math.min(timeoutMs, 5000);
            for (let i = 0; i < maxAttempts; i += 1) {
              try {
                chk = await checkQrSession(pendingQr.key, pendingQr.device, { timeoutMs: attemptTimeout });
              } catch (error) {
                report('login/qrPoll', error);
                chk = null;
              }
              if (chk && (chk.session || chk.status === 0)) break;
              if (i < maxAttempts - 1) await sleep(gapMs);
            }
            if (chk?.session) {
              const saved = await sessions.save({ ...chk.session, device: pendingQr.device });
              pendingQr = null;
              return {
                ok: true,
                action,
                loggedIn: true,
                userid: saved.userid,
                qrImagePath: '',
                message: '✅ 扫码登录成功，现在可以播放原版了。',
              };
            }
            const s = await state();
            if (!chk) {
              return {
                ok: false,
                action,
                ...s,
                qrImagePath: '',
                message: '❌ 轮询扫码状态失败（网络或超时），请稍后再试。',
              };
            }
            if (chk.status === 0) {
              pendingQr = null;
              return { ok: false, action, ...s, qrImagePath: '', message: '❌ 二维码已过期，请重新生成。' };
            }
            return {
              ok: false,
              action,
              ...s,
              qrImagePath: '',
              message: '⏳ 二维码发给你了，用酷狗App扫码确认后说一声，我继续查结果。',
            };
          }

          case 'status': {
            const s = await state();
            return {
              ok: true,
              action,
              ...s,
              message: s.loggedIn
                ? `✅ 已登录酷狗账号（userid ${s.userid}），原版可以播放。`
                : 'ℹ️ 未登录。搜索可用，但原版只能试听 60 秒；需要播放原版时调用 qr_start 扫码登录。',
            };
          }

          case 'logout': {
            await sessions.clear();
            return { ok: true, action, loggedIn: false, userid: 0, message: '✅ 已清除本地会话，下次播放将回到未登录状态。' };
          }

          default: {
            const s = await state();
            return {
              ok: false,
              action,
              ...s,
              message: `❌ 未知操作「${action}」。可用：qr_start / qr_poll / status / logout`,
            };
          }
        }
      } catch (error) {
        // A thrown error here would fail the whole turn; login problems are
        // ordinary and should read as a sentence the model can relay.
        let s = { loggedIn: false, userid: 0 };
        try {
          s = await state();
        } catch {
          /* session store unavailable; report the original failure */
        }
        return { ok: false, action, ...s, message: `❌ 登录操作失败：${error?.message ?? error}` };
      }
    },
  });

  // ---- music_status ------------------------------------------------------
  ctx.tools.register({
    name: 'music_status',
    description:
      'Report what music is currently playing on this machine: track, artist, quality, playback state, ' +
      'position, volume and whether single-track repeat is on. ' +
      'Use it before answering "在放什么歌" or before issuing a control command you are unsure about.',
    // No arguments. `required: []` is spelled out rather than omitted: a schema
    // with no explicit required list is valid JSON Schema but is handled
    // inconsistently across providers.
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'name', 'singer', 'quality', 'loop', 'volume', 'elapsedSec', 'durationSec', 'outputDevice', 'loggedIn', 'message'],
        properties: {
          state: { type: 'string' },
          name: { type: 'string' },
          singer: { type: 'string' },
          quality: { type: 'string' },
          loop: { type: 'boolean' },
          volume: { type: 'number' },
          elapsedSec: { type: 'integer' },
          durationSec: { type: 'integer' },
          outputDevice: { type: 'string' },
          loggedIn: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs,
    async execute() {
      try {
        const s = player.status();
        const session = await sessions.get();
        const base = {
          state: s.state,
          name: s.name ?? '',
          singer: s.singer ?? '',
          quality: s.quality ?? '',
          loop: s.loop,
          volume: s.volume,
          elapsedSec: s.elapsedSec,
          durationSec: s.durationSec,
          outputDevice: s.outputDevice ?? '',
          loggedIn: Boolean(session?.token),
        };
        const device = s.outputDevice ? `\n输出设备：${s.outputDevice}` : '';
        const account = session?.token
          ? '｜已登录酷狗账号（可播原版）'
          : '｜未登录，原版只能试听60秒，需要时可扫码登录。';
        if (s.state === 'idle') return { ...base, message: `🎵 当前没有在播放音乐。${device}${account}` };
        if (s.state === 'loading') return { ...base, message: `⏳ 正在加载：${s.name}${device}${account}` };
        const icon = s.state === 'paused' ? '⏸️' : '▶️';
        const loopNote = s.loop ? '｜单曲循环' : '';
        return {
          ...base,
          message:
            `${icon} ${s.name}${s.singer ? ` — ${s.singer}` : ''}${s.quality ? ` [${s.quality}]` : ''}\n` +
            `进度 ${formatTime(s.elapsedSec)}/${formatTime(s.durationSec)}｜音量 ${s.volume}%${loopNote}${device}${account}`,
        };
      } catch (error) {
        return {
          state: 'unknown',
          name: '',
          singer: '',
          quality: '',
          loop: false,
          volume: 0,
          elapsedSec: 0,
          durationSec: 0,
          outputDevice: '',
          loggedIn: false,
          message: '❌ 状态读取失败：' + (error?.message ?? error),
        };
      }
    },
  });

  // ---- prompt guidance ---------------------------------------------------
  // Mirrors what browser_search does for its own tool: without a hint the model
  // tends to answer "我无法播放音乐" instead of reaching for the tool.
  try {
    ctx.get('systemPrompt')?.section?.({
      name: 'tool:play_music',
      order: 120,
      text:
        'Use the play_music tool to play a song by name on this machine\'s speakers — it searches and plays in one step, ' +
        'so never claim you cannot play music and never ask for a URL. Use loop=true for 单曲循环. ' +
        'Use music_control to pause/resume/stop/adjust volume/toggle the loop of what is already playing, and ' +
        'music_status to check before answering questions about the current track. ' +
        'Never say a song is playing unless play_music returned ok=true; if it fails, relay the reason as-is. ' +
        'When play_music reports that the original needs an account, or when the user asks to play an original or VIP track, ' +
        'offer one-tap QR login: call music_login action="qr_start", then call wechat_send_image(qrImagePath) to send the QR image to the user, have them ' +
        'scan it with the Kugou app and confirm, then call action="qr_poll" and keep polling until it succeeds. ' +
        'When play_music returns needsLogin=true, immediately call music_login action="qr_start" to generate a login QR code ' +
        '— do NOT tell the user to run any command, do NOT ask for a phone number. ' +
        'This plugin is used inside a WeChat chat bridge. All tool return text is forwarded to WeChat — keep it short, ' +
        'plain-text, no command-line references. After qr_start returns qrImagePath, call wechat_send_image with that path ' +
        'to send the QR image to the WeChat user. The bridge does NOT forward tool results automatically — you must call ' +
        'wechat_send_image explicitly. Do NOT tell the user to open a local file. ' +
        'Do NOT ask for a phone number or SMS code — login is QR-only. All tool message text is forwarded to the WeChat chat as-is, so keep it natural and user-facing — do not put tool names or internal instructions in the message. qr_poll auto-polls for about 15 seconds in one call; if it returns waiting, do NOT keep polling in the same turn — tell the user the QR was sent and ask them to reply after scanning, then poll again next turn.',
    });
  } catch (error) {
    report('systemPrompt/section', error);
  }
}
