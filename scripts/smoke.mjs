/**
 * Smoke test for dsh-music-player — exercises the real chain without DSH.
 *
 *   node scripts/smoke.mjs            # silent: search, resolve, decode, control
 *   node scripts/smoke.mjs --audible  # additionally plays ~3s so you can hear it
 *
 * The silent path is the default on purpose: this script is safe to run on a
 * machine somebody is using. It still proves the parts that usually break —
 * the native audio device opening, the CDN URL being decodable, and the
 * loop/pause state machine — because none of them require emitting sound.
 */
import { findAndResolve, searchTracks, pickTrack, availableTiers } from '../lib/kugou.js';
import { MusicPlayer, formatTime } from '../lib/player.js';

const audible = process.argv.includes('--audible');
const query = process.argv.find((a) => a.startsWith('--query='))?.slice(8) ?? '晴天 周杰伦';
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log(`\n=== dsh-music-player smoke test (${audible ? 'audible' : 'silent'}) ===\n`);

// ---- 1. search ------------------------------------------------------------
let candidates = [];
try {
  candidates = await searchTracks(query, { limit: 8 });
  check('搜索返回候选', candidates.length > 0, `${candidates.length} 条`);
} catch (error) {
  check('搜索返回候选', false, error.message);
}

if (candidates.length > 0) {
  const best = pickTrack(candidates, query);
  check('最优匹配命中', Boolean(best), `${best.name} — ${best.singer}`);
  // The match must be scoped to what search actually returned.
  check('匹配来自候选集', candidates.includes(best));
  const tiers = availableTiers(best);
  check('存在可用音质', tiers.length > 0, tiers.map((t) => t.label).join('/'));
}

// ---- 2. resolve -----------------------------------------------------------
let resolved = null;
try {
  resolved = await findAndResolve(query, { limit: 8 });
  const { track, stream } = resolved;
  check('解析出直链', Boolean(stream?.url), `${stream.qualityLabel} ${stream.bitrateKbps}kbps .${stream.ext}`);
  check('直链是 http(s)', /^https?:\/\//.test(stream.url), stream.url.slice(0, 60) + '…');
  console.log(`      → ${track.name} — ${track.singer}（${formatTime(track.durationSec)}）`);
} catch (error) {
  check('解析出直链', false, error.message);
}

// ---- 3. player: device + decode + state machine ---------------------------
const player = new MusicPlayer({ volume: 55, onProblem: (k, e) => console.log(`      [problem] ${k}: ${e.message}`) });
try {
  const ctx = await player.ensureContext();
  check('打开系统音频设备', ctx.state === 'running' || ctx.state === 'suspended', `state=${ctx.state} rate=${ctx.sampleRate}`);
} catch (error) {
  check('打开系统音频设备', false, error.message);
}

if (resolved) {
  try {
    const buffer = await player.downloadAndDecode(resolved.stream.url);
    check('下载并解码音频', buffer.duration > 0, `${buffer.duration.toFixed(1)}s @${buffer.sampleRate}Hz ${buffer.numberOfChannels}ch`);
  } catch (error) {
    check('下载并解码音频', false, error.message);
  }
}

// Volume / loop / status must behave before any playback exists.
check('设置音量', player.setVolume(42) === 42 && player.status().volume === 42);
check('开启单曲循环', player.setLoop(true) === true && player.status().loop === true, 'loop=true');
check('关闭单曲循环', player.setLoop(false) === false && player.status().loop === false, 'loop=false');
check('空闲状态可读', player.status().state === 'idle');

// Redundant control calls must be no-ops, not errors — a model will repeat itself.
try {
  await player.pause();
  await player.resume();
  await player.toggle();
  player.stop();
  check('空闲时控制调用不报错', true);
} catch (error) {
  check('空闲时控制调用不报错', false, error.message);
}

// ---- 4. optional audible pass --------------------------------------------
if (audible && resolved) {
  console.log('\n--- 有声测试：播放约 3 秒 ---');
  try {
    player.setVolume(35);
    player.setLoop(true);
    await player.play(resolved.track, resolved.stream, { loop: true });
    const s1 = player.status();
    check('开始播放', s1.state === 'playing', `${s1.name} [${s1.quality}]`);
    check('循环已生效', s1.loop === true);

    await new Promise((r) => setTimeout(r, 1500));
    await player.pause();
    const paused = player.status();
    check('暂停生效', paused.state === 'paused', `pos=${paused.elapsedSec}s`);
    const frozen = paused.elapsedSec;
    await new Promise((r) => setTimeout(r, 1200));
    check('暂停后进度停住', player.status().elapsedSec === frozen, `${frozen}s -> ${player.status().elapsedSec}s`);

    await player.resume();
    check('继续生效', player.status().state === 'playing');
    const stopped = player.stop();
    check('停止后回到 idle', stopped.state === 'idle');
  } catch (error) {
    check('有声播放', false, error.message);
  }
}

await player.dispose();
check('释放音频设备', true);

// ---- summary --------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  process.exitCode = 1;
}
