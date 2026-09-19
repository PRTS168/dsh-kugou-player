/**
 * Audio engine: decode a network track and render it to this machine's
 * speakers, entirely inside the plugin process.
 *
 * Why not shell out to ffplay/mpv: none of them can do the two things this
 * plugin exists for. `AudioBufferSourceNode.loop` gives a seamless single-track
 * repeat with no re-download, and `AudioContext.suspend()/resume()` gives an
 * exact pause/resume with no process juggling. Web Audio also means there is no
 * external binary to install — the only dependency is a prebuilt native module.
 *
 * Model: exactly one track is loaded at a time. Starting a new track tears the
 * previous one down, so two songs can never play over each other.
 *
 * @module dsh-music-player/player
 */
import { selectSink } from './sink.js';

/** Playback states a caller can observe. */
export const STATES = ['idle', 'loading', 'playing', 'paused'];

/**
 * Load node-web-audio-api on first use rather than at plugin load.
 *
 * If the prebuilt binary is missing for this platform the plugin must still
 * mount: a tool call should report "音频引擎不可用", not take the whole profile
 * down with it. The promise is cached so a failure is not retried per call.
 */
let audioApiPromise = null;
function loadAudioApi() {
  if (!audioApiPromise) {
    audioApiPromise = import('node-web-audio-api').catch((error) => {
      audioApiPromise = null; // allow a later retry after a transient failure
      throw new Error(
        `音频引擎加载失败（node-web-audio-api）：${error?.message ?? error}。` +
          '请在插件目录执行 npm install 确认预编译二进制已就位。',
      );
    });
  }
  return audioApiPromise;
}

/**
 * One-track audio player.
 *
 * All public methods are safe to call in any state: asking to pause while idle
 * is a no-op rather than an error, because a language model will occasionally
 * issue a redundant call and that should not read as a failure.
 */
export class MusicPlayer {
  /**
   * @param options.volume       initial master volume, percent (0-100)
   * @param options.maxTrackMinutes  refuse anything longer than this
   * @param options.maxBytes     refuse a download larger than this
   * @param options.userAgent    UA used for the CDN fetch
   * @param options.onEnded      called with the finished track when it ends naturally
   * @param options.onProblem    called with (kind, error) for background failures
   */
  constructor(options = {}) {
    this.volume = clampVolume(options.volume ?? 60);
    this.maxTrackMinutes = options.maxTrackMinutes ?? 12;
    this.maxBytes = options.maxBytes ?? 120 * 1024 * 1024;
    this.userAgent = options.userAgent ?? 'Mozilla/5.0';
    this.onEnded = options.onEnded ?? (() => {});
    this.onProblem = options.onProblem ?? (() => {});
    /** Which output to render to: 'auto' | 'default' | label fragment | deviceId. */
    this.sinkPreference = options.sink ?? 'auto';
    /** Resolved output device, filled in when the context is created. */
    this.sink = null;

    /** @type {'idle'|'loading'|'playing'|'paused'} */
    this.state = 'idle';
    this.track = null;
    this.loop = false;

    this.ctx = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    /** Context time at which the current source was started. */
    this.startedAt = 0;
    /**
     * Bumped every time the source is replaced or torn down. An `onended` that
     * does not match the live generation is a consequence of our own stop()
     * after all, not a track finishing.
     */
    this.generation = 0;
    /**
     * Monotonic token for the *async* arm of playback (the in-flight download
     * and the suspend/resume awaits). Captured as `myId = ++this.playSeq` at
     * the start of play()/pause()/resume(); any await that resolves after a
     * superseding call (a newer play(), stop(), or dispose()) sees a mismatch
     * and bails instead of mutating state or starting a stale source.
     */
    this.playSeq = 0;
    /**
     * AbortController for the in-flight fetch/download. Aborted whenever a newer
     * play() enters, or stop()/dispose() runs, so a replaced track's HTTP
     * download does not keep running in the background.
     */
    this._abort = null;
  }

  /**
   * Lazily create the AudioContext and its single gain stage.
   *
   * The sink is resolved before the context is built, because a context cannot
   * be re-pointed at another device afterwards. Falling back to the system
   * default keeps a bad preference from costing playback entirely.
   */
  async ensureContext() {
    if (this.ctx) return this.ctx;
    const { AudioContext } = await loadAudioApi();

    let sink = await selectSink(this.sinkPreference);
    let ctx;
    try {
      ctx = sink.deviceId ? new AudioContext({ sinkId: sink.deviceId }) : new AudioContext();
    } catch (error) {
      this.onProblem('player/sink', error);
      sink = { deviceId: '', label: '', reason: `system default (requested sink rejected: ${error?.message ?? error})` };
      ctx = new AudioContext();
    }

    this.sink = sink;
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume / 100;
    this.gain.connect(ctx.destination);
    return this.ctx;
  }

  /** Tear down the current source without touching the context. */
  detachSource() {
    this.generation += 1;
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
        this.source.disconnect();
      } catch {
        // Already stopped or never started; nothing to undo.
      }
      this.source = null;
    }
    this.buffer = null;
  }

  /**
   * Fetch and decode a stream URL.
   *
   * The whole track is downloaded before playback because single-track repeat
   * is a first-class requirement: holding the decoded buffer means a loop never
   * touches the network again. The cost is memory — a 4-minute stereo track is
   * roughly 100 MB of PCM — which is what maxTrackMinutes bounds.
   */
  async downloadAndDecode(url, { signal } = {}) {
    const ctx = await this.ensureContext();

    const res = await fetch(url, {
      signal,
      headers: { 'User-Agent': this.userAgent, Referer: 'https://www.kugou.com/' },
    });
    if (!res.ok) throw new Error(`下载音源失败 HTTP ${res.status}`);

    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > this.maxBytes) {
      throw new Error(`音源体积过大（${Math.round(declared / 1048576)}MB），已拒绝下载`);
    }

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(`音源体积过大（${Math.round(bytes.byteLength / 1048576)}MB），已拒绝下载`);
    }
    if (bytes.byteLength === 0) throw new Error('音源为空，可能是版权受限曲目');

    const buffer = await ctx.decodeAudioData(bytes);
    const minutes = buffer.duration / 60;
    if (minutes > this.maxTrackMinutes) {
      throw new Error(`曲目时长 ${minutes.toFixed(1)} 分钟，超过 ${this.maxTrackMinutes} 分钟上限`);
    }
    return buffer;
  }

  /**
   * Play one resolved track, replacing whatever was playing.
   *
   * @param track  { name, singer, durationSec } for display only
   * @param stream { url, qualityLabel, bitrateKbps, ext } from kugou.resolveTrack
   */
  async play(track, stream, { loop = false, signal } = {}) {
    await this.ensureContext();
    // Tear down whatever was playing/loading. This also bumps playSeq and
    // aborts the previous download so a superseded track cannot finish and
    // start() over the new one.
    this.stop({ silent: true });
    const myId = ++this.playSeq;
    // Fresh abort for this download; abort anything still in flight.
    this._abort?.abort();
    this._abort = new AbortController();

    this.state = 'loading';
    this.track = { ...track, qualityLabel: stream?.qualityLabel ?? null, bitrateKbps: stream?.bitrateKbps ?? null };
    this.loop = Boolean(loop);

    try {
      // Combine the caller's signal with our internal one so stop()/dispose()
      // (which abort the internal controller) also cancels the HTTP fetch.
      const downloadSignal = signal
        ? AbortSignal.any([signal, this._abort.signal])
        : this._abort.signal;
      const buffer = await this.downloadAndDecode(stream.url, { signal: downloadSignal });
      const ctx = await this.ensureContext();
      // A newer play() (or stop()/dispose()) won while we were downloading:
      // drop the decoded buffer and never wire a source up.
      if (myId !== this.playSeq) return;

      this.source = ctx.createBufferSource();
      this.source.buffer = buffer;
      this.source.loop = this.loop;
      this.source.connect(this.gain);

      const generation = (this.generation += 1);
      this.source.onended = () => {
        if (generation !== this.generation) return; // superseded by a newer track
        this.state = 'idle';
        const finished = this.track;
        // Detach the finished node and release the audio device while idle,
        // instead of holding the context open.
        try { this.source?.disconnect(); } catch { /* already disconnected */ }
        this.source = null;
        this.buffer = null;
        void this.ctx.suspend().catch(() => {});
        try {
          this.onEnded(finished);
        } catch (error) {
          this.onProblem('player/onEnded', error);
        }
      };

      // A context suspended by an earlier pause() must be running to start.
      if (ctx.state === 'suspended') await ctx.resume();
      // Another await point: stop()/play() may have torn the source down while
      // resume() was pending. Don't start a null/abandoned source.
      if (myId !== this.playSeq) return;
      this.buffer = buffer;
      this.startedAt = ctx.currentTime;
      this.source.start(0);
      this.state = 'playing';
      return this.status();
    } catch (error) {
      // If we were superseded, the newer owner has already reset state/track —
      // leave them alone and don't surface the abort as a failure.
      if (myId !== this.playSeq) return;
      // resume() may have thrown after the source was already connected to the
      // gain stage: detach it so nothing is left audible/leaking.
      try { this.detachSource(); } catch { /* already torn down */ }
      this.state = 'idle';
      this.track = null;
      throw error;
    }
  }

  /**
   * Pause by suspending the context.
   *
   * Suspending freezes the audio clock, so the source keeps its position and
   * resume() is sample-exact — no re-download, no re-seek.
   */
  async pause() {
    if (this.state !== 'playing') return this.status();
    // Capture the token before any await so a stop()/play() interleaved while
    // suspended() is pending invalidates us.
    const myId = this.playSeq;
    await this.ensureContext();
    await this.ctx.suspend();
    if (myId !== this.playSeq) return this.status(); // superseded; don't clobber state
    this.state = 'paused';
    return this.status();
  }

  /** Resume a paused track from exactly where it stopped. */
  async resume() {
    if (this.state !== 'paused') return this.status();
    const myId = this.playSeq;
    await this.ensureContext();
    await this.ctx.resume();
    if (myId !== this.playSeq) return this.status(); // superseded; don't clobber state
    this.state = 'playing';
    return this.status();
  }

  /** Pause if playing, resume if paused. */
  async toggle() {
    if (this.state === 'playing') return this.pause();
    if (this.state === 'paused') return this.resume();
    return this.status();
  }

  /**
   * Stop and unload the current track.
   *
   * `silent` skips the generation bump bookkeeping used by play(); the source
   * is always stopped so that nothing is left audible.
   */
  stop({ silent = false } = {}) {
    const wasActive = this.state === 'playing' || this.state === 'paused' || this.state === 'loading';
    this.detachSource();
    // Invalidate any in-flight play()/pause()/resume() and cancel its download.
    this.playSeq += 1;
    this._abort?.abort();
    this.state = 'idle';
    this.track = null;
    if (!silent && wasActive && this.ctx) {
      // Release the device while idle instead of holding it open.
      void this.ctx.suspend().catch(() => {});
    }
    return this.status();
  }

  /** Set master volume, percent. Returns the applied value. */
  setVolume(percent) {
    this.volume = clampVolume(percent);
    if (this.gain) this.gain.gain.value = this.volume / 100;
    return this.volume;
  }

  /**
   * Turn single-track repeat on or off for the playing track.
   *
   * Takes effect without restarting: the audio clock keeps its position, so
   * toggling mid-song does not glitch or rewind.
   */
  setLoop(enabled) {
    this.loop = Boolean(enabled);
    if (this.source) this.source.loop = this.loop;
    if (this.track) this.track = { ...this.track };
    return this.loop;
  }

  /** Seconds played, and the total, for a status line. */
  position() {
    if (!this.buffer || !this.ctx) return { elapsed: 0, duration: 0 };
    const duration = this.buffer.duration;
    if (this.state === 'loading') return { elapsed: 0, duration: 0 };
    const raw = Math.max(0, this.ctx.currentTime - this.startedAt);
    return { elapsed: this.loop ? raw % duration : Math.min(raw, duration), duration };
  }

  /** A snapshot safe to render and to hand back to the model. */
  status() {
    const { elapsed, duration } = this.position();
    return {
      state: this.state,
      name: this.track?.name ?? null,
      singer: this.track?.singer ?? null,
      quality: this.track?.qualityLabel ?? null,
      bitrateKbps: this.track?.bitrateKbps ?? null,
      loop: this.loop,
      volume: this.volume,
      elapsedSec: Math.round(elapsed),
      durationSec: Math.round(duration || this.track?.durationSec || 0),
      // Surfaced because "playing but silent" is almost always a wrong output
      // device, and naming the device makes that diagnosable from one call.
      outputDevice: this.sink?.label || null,
      outputReason: this.sink?.reason ?? null,
    };
  }

  /** Close the device. Called on plugin unload so no audio outlives the row. */
  async dispose() {
    this.detachSource();
    // Invalidate any in-flight async work and cancel the download.
    this.playSeq += 1;
    this._abort?.abort();
    this.state = 'idle';
    this.track = null;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch (error) {
        this.onProblem('player/dispose', error);
      }
      this.ctx = null;
      this.gain = null;
    }
  }
}

/** Keep a spoken or mis-typed volume inside the range the device accepts. */
export function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Format seconds as m:ss for human-facing lines. */
export function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
