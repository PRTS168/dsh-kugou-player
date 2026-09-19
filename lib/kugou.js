/**
 * Kugou source: search a song by name, then turn it into a directly playable
 * audio URL.
 *
 * Both endpoints are Kugou's own public web endpoints and neither needs an
 * account, a cookie, or a signature:
 *
 *   search  songsearch.kugou.com/song_search_v2   (keyword -> hash list)
 *   resolve trackercdn.kugou.com/i/v2             (hash -> CDN stream URL)
 *
 * The resolve step is gated only by `md5(hash + 'kgcloudv2')` — a fixed,
 * publicly documented constant. It is NOT gated on login or on VIP, which is
 * why 128 / 320 / lossless all resolve without any account. What an account
 * buys is a *wider catalogue*, not a stronger key: rights-holders keep some
 * original studio recordings out of these responses entirely, and the search
 * below will simply return the live or remix versions instead. See README.md.
 *
 * @module dsh-music-player/kugou
 */
import { createHash } from 'node:crypto';
import { sessionAuth } from './session.js';
import { resolveViaEngine, engineAvailable } from './engine.js';

/** Endpoint that answers a spoken song name with candidate tracks. */
const SEARCH_ENDPOINT = 'https://songsearch.kugou.com/song_search_v2';

/** Endpoint that turns a track hash into a playable CDN URL. */
const RESOLVE_ENDPOINT = 'https://trackercdn.kugou.com/i/v2/';

/**
 * The salt Kugou's CDN gate expects. Public and constant, not a secret we
 * obtained: it appears verbatim in every open-source Kugou client.
 */
const CLOUD_KEY_SALT = 'kgcloudv2';

/** Kugou answers a browser-ish UA; the bare Node UA is refused. */
const DEFAULT_UA = 'Mozilla/5.0';

/** Quality tiers in descending preference, with the hash field each one uses. */
const QUALITY_TIERS = [
  { id: 'flac', label: '无损', hashField: 'sqHash', bitrate: 0 },
  { id: '320', label: '320kbps', hashField: 'hqHash', bitrate: 320 },
  { id: '128', label: '128kbps', hashField: 'fileHash', bitrate: 128 },
];

const md5 = (text) => createHash('md5').update(text).digest('hex');

// Scoring weights and thresholds used by rankScore / rankCandidates.
const TITLE_RELEVANCE_WEIGHT = 50;
const ARTIST_MATCH_WEIGHT = 60;
const CLEAN_TITLE_BONUS = 15;
const REMIX_PENALTY = 25;
const LIVE_PENALTY = 10;
const STUDIO_ALBUM_BONUS = 6;
const DURATION_BONUS = 3;
// 足额时长阈值：达到同曲最长 85% 视为完整版，+8 分
const FULL_DURATION_THRESHOLD = 0.85;
const FULL_DURATION_BONUS = 8;
const TRUNCATED_PENALTY = 40;
const TITLE_THRESHOLD_RATIO = 0.6;

/**
 * Fold a title to a comparison key: lowercased, stripped of punctuation and
 * spacing, so that "晴天 (Live)" and "晴天live" both reduce predictably.
 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\-_（）()[\]【】·、,，.。!！?？'"“”~～]/g, '');
}

/**
 * One JSON request with a hard deadline.
 *
 * Every failure is re-thrown as-is; callers decide whether it becomes a tool
 * error or a fallback attempt. Timeouts are named because "fetch failed" tells
 * a model nothing about what to try next.
 */
async function fetchJson(url, { timeoutMs, userAgent, label, cookie }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': userAgent ?? DEFAULT_UA, Referer: 'https://www.kugou.com/' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, { signal: controller.signal, headers });
    // 内层不带 label：否则会被下方 catch 再次包装成 "酷狗解析 失败：酷狗解析 HTTP 500"。
    // 抛出后由 catch 统一包装一次，得到 "酷狗解析 失败：HTTP 500"。
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label} 请求超时（${timeoutMs}ms）`);
    throw new Error(`${label} 失败：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip the `<em>` highlighting the search endpoint wraps around matched terms
 * when a `tag` is requested. Left in place it would end up in titles shown to
 * the user and compared against their query.
 */
function stripTags(text) {
  return String(text ?? '').replace(/<[^>]*>/g, '');
}

/** Shape one raw search hit into the fields this plugin actually uses. */
function toTrack(raw) {
  return {
    name: stripTags(raw?.SongName).trim(),
    singer: stripTags(raw?.SingerName).trim(),
    fileHash: raw?.FileHash ?? null,
    hqHash: raw?.HQFileHash ?? null,
    sqHash: raw?.SQFileHash ?? null,
    durationSec: Number(raw?.Duration) || 0,
    albumId: raw?.AlbumID ?? null,
    audioId: raw?.Audioid ?? null,
    // Album metadata is the cheapest way to tell a licensed recording from a
    // placeholder entry: real album tracks carry a name, stubs carry nothing.
    album: stripTags(raw?.AlbumName).trim(),
  };
}

/**
 * Search Kugou by free text (song name, or "name artist").
 *
 * @returns candidate tracks, best-guess first is NOT guaranteed — see pickTrack.
 */
export async function searchTracks(keyword, options = {}) {
  const { limit = 8, timeoutMs = 20000, userAgent } = options;
  const query = String(keyword ?? '').trim();
  if (query.length === 0) throw new Error('搜索关键词不能为空');

  // `platform` is REQUIRED for a complete catalogue, and this is not cosmetic.
  // Omitting it returns a degraded result set: searching 水手 郑智化 answers
  // with a 120-second placeholder stub carrying no album metadata, while the
  // real 292-second album recording (私房歌) is absent entirely. With
  // WebFilter — or AndroidFilter — the album version is the first hit.
  // Measured 2026-09-19; this single parameter was the whole difference.
  const params = new URLSearchParams({
    keyword: query,
    page: '1',
    pagesize: String(Math.max(1, Math.min(limit, 30))),
    platform: 'WebFilter',
  });
  const json = await fetchJson(`${SEARCH_ENDPOINT}?${params}`, { timeoutMs, userAgent, label: '酷狗搜索' });
  const lists = json?.data?.lists;
  if (!Array.isArray(lists)) throw new Error('酷狗搜索返回了无法识别的结构（接口可能已变更）');
  return lists.map(toTrack).filter((t) => t.name && t.fileHash);
}

/** Separators Kugou uses between collaborating artists. */
const ARTIST_SEPARATORS = /[、,&＆/]|\bfeat\.?\b|\bwith\b/i;

/** Trailing/embedded annotations that are not part of the song's title. */
const TITLE_ANNOTATION = /[（(【[][^）)】\]]*[）)】\]]/g;

/**
 * Variants that are audibly not the recording a listener asked for, in two
 * tiers. A remix or a rearrangement is a different production, while a live
 * performance is still the song being played — so when the studio cut is
 * unavailable, live should beat remix rather than both being rejected equally.
 */
const REMIX_MARKER = /dj|remix|伴奏|纯音乐|cover|翻自|改编|片段|试听|铃声/i;
const LIVE_MARKER = /live|现场|演唱会/i;

/** Strip "(Live)" / "【伴奏】" style annotations down to the plain title. */
function baseTitle(name) {
  return normalize(String(name ?? '').replace(TITLE_ANNOTATION, ''));
}

/**
 * How much of the query is actually this track's title, from 0 to 1.
 *
 * Computed against the annotation-stripped title so that "晴天 (Live)" still
 * scores as 晴天 — the annotation is a variant marker, not evidence of a
 * different song.
 */
export function titleRelevance(name, query) {
  const n = baseTitle(name);
  const q = normalize(query);
  if (!n || !q) return 0;
  if (n === q) return 1;
  if (q.includes(n)) return 0.9;
  if (n.includes(q)) return 0.95;
  return overlapRatio(q, n);
}

/**
 * Did the query actually name this artist?
 *
 * A credit line can be long ("周杰伦、新乐府民乐气氛组"), so a full-string
 * comparison misses the artist the user asked for. Any single credit matching
 * counts.
 */
export function artistMatches(query, singer) {
  const q = normalize(query);
  const full = normalize(singer);
  if (!full) return false;
  if (q.includes(full)) return true;
  return String(singer ?? '')
    .split(ARTIST_SEPARATORS)
    .map(normalize)
    .some((part) => part.length > 1 && q.includes(part));
}

/**
 * Fraction of the shorter string's characters that appear in the longer one.
 *
 * 无序字符子集匹配，重复字符会重复命中；中文场景够用，英文/拼音可能虚高。
 */
function overlapRatio(a, b) {
  if (!a || !b) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let hit = 0;
  for (const ch of short) if (long.includes(ch)) hit += 1;
  return hit / short.length;
}

/**
 * Rank the candidates that already passed the title gate.
 *
 * Title relevance still leads, but only within the pool: two versions of the
 * right song are then separated by whether the user named their artist, by how
 * close to the studio cut the variant is, and by length.
 *
 * Length is judged *relative to the longest title-matching candidate*, not
 * against an absolute threshold. That matters because the catalogue's only
 * clean-titled entry for a song is often a 试听 excerpt: 《水手》by 郑智化 exists
 * as a 120-second stub carrying no album metadata, while every full performance
 * is a parenthesised variant. Without this rule the plain title wins on
 * tidiness alone and the user silently gets two minutes of a four-minute song.
 */
function rankScore(track, relevance, query, longestDurationSec) {
  let score = relevance * TITLE_RELEVANCE_WEIGHT;
  if (artistMatches(query, track.singer)) score += ARTIST_MATCH_WEIGHT;
  if (!/[（(]/.test(track.name)) score += CLEAN_TITLE_BONUS;
  if (REMIX_MARKER.test(track.name)) score -= REMIX_PENALTY;
  else if (LIVE_MARKER.test(track.name)) score -= LIVE_PENALTY;
  if (track.sqHash) score += STUDIO_ALBUM_BONUS;
  else if (track.hqHash) score += DURATION_BONUS;

  if (longestDurationSec > 0) {
    if (track.durationSec >= longestDurationSec * FULL_DURATION_THRESHOLD) score += FULL_DURATION_BONUS;
    else if (track.durationSec < longestDurationSec * TITLE_THRESHOLD_RATIO) score -= TRUNCATED_PENALTY;
  }
  return score;
}

/** Longest duration among candidates sharing a title-relevant pool. */
function longestOf(pool) {
  return pool.reduce((max, entry) => Math.max(max, entry.track.durationSec || 0), 0);
}

/**
 * Rank every plausible candidate, best first.
 *
 * The title gate is deliberate. Ranking on a single additive score lets a
 * famous artist outvote the song: searching "晴天 周杰伦" selected 简单爱, a
 * different song by the right singer, purely because an artist bonus outweighed
 * a title that was not present in the results at all. Candidates whose title
 * has nothing to do with the query are a different song and are dropped before
 * ranking, so the artist can only choose *between* plausible versions.
 */
export function rankCandidates(tracks, query) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];
  const scored = tracks.map((track) => ({ track, relevance: titleRelevance(track.name, query) }));
  const best = Math.max(...scored.map((s) => s.relevance));
  // Keep every near-best title. When nothing is relevant at all (best === 0)
  // the pool stays complete and the caller is expected to report low confidence
  // rather than let the tool silently play an unrelated track.
  const pool = best > 0 ? scored.filter((s) => s.relevance >= best * TITLE_THRESHOLD_RATIO) : scored;
  const longest = longestOf(pool);
  return pool
    .map((entry) => ({ track: entry.track, score: rankScore(entry.track, entry.relevance, query, longest) }))
    .sort((a, b) => b.score - a.score);
}

/** Best candidate for a query, or null when the search found nothing. */
export function pickTrack(tracks, query) {
  const ranked = rankCandidates(tracks, query);
  return ranked.length > 0 ? ranked[0].track : null;
}

/**
 * Is the chosen track much shorter than the best full-length version on offer?
 *
 * Such an entry is almost always a 试听 excerpt rather than a short song, and a
 * caller should say so instead of presenting two minutes as the whole track.
 */
export function looksTruncated(track, candidates) {
  if (!track || !Array.isArray(candidates) || candidates.length === 0) return false;
  const longest = candidates.reduce((max, c) => Math.max(max, c.durationSec || 0), 0);
  if (longest <= 0 || !track.durationSec) return false;
  return track.durationSec < longest * 0.6;
}

/** Title relevance of the chosen track, so callers can flag a weak match. */
export function matchConfidence(track, query) {
  return track ? titleRelevance(track.name, query) : 0;
}

/** Which tiers this track actually offers, best first. */
export function availableTiers(track) {
  return QUALITY_TIERS.filter((tier) => Boolean(track?.[tier.hashField]));
}

/**
 * Resolve one track to a CDN stream URL.
 *
 * `quality: 'auto'` takes the best tier the track offers; an explicit tier that
 * the track does not offer falls back to the best available one, and the caller
 * is told which tier it actually got.
 */
export async function resolveTrack(track, options = {}) {
  const { quality = 'auto', timeoutMs = 20000, userAgent, session, onInvalidSession } = options;
  const tiers = availableTiers(track);
  if (tiers.length === 0) throw new Error(`《${track.name}》没有可用的音源哈希`);

  const wanted = quality === 'auto' ? null : tiers.find((t) => t.id === String(quality));
  const ordered = wanted ? [wanted, ...tiers.filter((t) => t !== wanted)] : tiers;

  // Local "concept" engine first: it resolves the original recording with
  // device-level rights, no personal membership needed. The engine must already be
  // running (the user keeps MoeKoe open); when it is down or Kugou has temporarily
  // rate-limited it, we fall through to the public CDN path below.
  if (await engineAvailable({ timeoutMs: 2500 })) {
    for (const tier of ordered) {
      const hash = String(track[tier.hashField] ?? '').toLowerCase();
      if (!hash) continue;
      try {
        // privilege/lite must receive the song's identity hash (320 / 128 kbps),
        // never the sqHash — see engine.js resolveViaEngine for the full rationale.
        const identityHash = (track.hqHash || track.fileHash || hash).toLowerCase();
        const stream = await resolveViaEngine(hash, tier.id, { timeoutMs, privilegeHash: identityHash });
        return {
          url: stream.url,
          tier: tier.id,
          qualityLabel: tier.label,
          bitrateKbps: stream.bitrateKbps || tier.bitrate,
          ext: stream.ext ?? null,
          sizeBytes: 0,
          withAccount: true,
          viaEngine: true,
        };
      } catch {
        // this tier via the engine didn't resolve; try the next tier, then CDN
      }
    }
  }

  // The account, when present, is what turns a 60-second excerpt into the whole
  // recording — the endpoint answers `fail_process:["pkg","buy"]` otherwise.
  const auth = sessionAuth(session);

  const failures = [];
  let paid = false;
  for (const tier of ordered) {
    const hash = String(track[tier.hashField]).toLowerCase();
    const key = md5(hash + CLOUD_KEY_SALT);
    const params = new URLSearchParams({
      key,
      hash,
      appid: '1005',
      pid: '2',
      cmd: '25',
      behavior: 'play',
      ...auth.params,
    });
    const url = `${RESOLVE_ENDPOINT}?${params}`;
    try {
      const json = await fetchJson(url, { timeoutMs, userAgent, label: '酷狗解析', cookie: auth.cookie });
      const streamUrl = Array.isArray(json?.url) ? json.url[0] : null;
      if (json?.status === 1 && streamUrl) {
        return {
          url: streamUrl,
          tier: tier.id,
          qualityLabel: tier.label,
          // Kugou reports 0 for some lossless responses even though the stream
          // is fine, so a missing bitrate must not be treated as a failure.
          bitrateKbps: json.bitRate ? Math.round(json.bitRate / 1000) : tier.bitrate,
          ext: json.extName ?? null,
          sizeBytes: Number(json.fileSize) || 0,
          withAccount: Boolean(session?.token),
        };
      }
      // status 2 is Kugou's "this recording is not freely playable" — a paid or
      // VIP-only track. It is worth distinguishing: the song IS in the
      // catalogue and WILL be found by search, it simply cannot be streamed
      // without an account, which is a different sentence to the user.
      if (json?.status === 2) {
        paid = true;
      } else if (session?.token && !streamUrl) {
        // A token WAS sent, but Kugou answered with neither success (1) nor the
        // normal "needs membership" status (2), and gave no usable URL: the
        // session/token is rejected. Tell the caller so it can clear the dead
        // login state instead of reusing it on every later request.
        onInvalidSession?.();
      }
      failures.push(`${tier.label}: ${json?.error ?? `status=${json?.status}`}`);
    } catch (error) {
      failures.push(`${tier.label}: ${error?.message ?? error}`);
    }
  }
  const reason = paid ? 'paid' : 'unavailable';
  const error = new Error(
    paid
      ? `《${track.name}》需要付费或登录才能播放` +
        (session?.token ? '（当前登录态可能已过期）' : '（登录后可播放原版）')
      : `《${track.name}》解析失败（${failures.join('；')}）`,
  );
  error.reason = reason;
  throw error;
}

/** How many ranked candidates to try before giving up on a query. */
const RESOLVE_ATTEMPTS = 12;

/**
 * How many candidates to resolve at once.
 *
 * Sequential probing of the full depth would cost a dozen round trips; the
 * playable rendition can sit surprisingly deep (for 晴天 周杰伦 the first
 * streamable version is tenth, behind nine paywalled ones), so depth is
 * required rather than optional. Batching keeps that depth affordable.
 */
const RESOLVE_BATCH = 4;

/**
 * Resolve the best candidate that is actually playable.
 *
 * Trying only the top-ranked track makes the whole call fail when the catalogue
 * holds the canonical recordings behind a paywall — which is the normal case for
 * popular Chinese-language catalogues. 水手 郑智化 ranks the real 292-second
 * album version first and it cannot be streamed at all; 晴天 周杰伦 ranks nine
 * unstreamable versions above the first playable one. Walking down the ranking
 * keeps the user in music, while `skipped` records exactly what was passed over
 * and why, so the caller can say "the original needs an account" instead of
 * quietly presenting a live cover as it.
 */
export async function resolveFirstPlayable(tracks, query, options = {}) {
  const ranked = rankCandidates(tracks, query);
  const depth = Math.min(ranked.length, RESOLVE_ATTEMPTS);
  const failed = [];

  for (let start = 0; start < depth; start += RESOLVE_BATCH) {
    const batch = ranked.slice(start, start + RESOLVE_BATCH);
    const settled = await Promise.all(
      batch.map(async ({ track }) => {
        try {
          return { track, stream: await resolveTrack(track, options) };
        } catch (error) {
          return { track, error };
        }
      }),
    );

    // Rank order decides the winner, not completion order.
    const winner = settled.find((entry) => entry.stream);
    const cutoff = winner ? settled.indexOf(winner) : settled.length;
    for (const entry of settled.slice(0, cutoff)) {
      failed.push({
        track: entry.track,
        reason: entry.error?.reason ?? 'unavailable',
        message: entry.error?.message ?? '',
      });
    }
    if (winner) return { track: winner.track, stream: winner.stream, skipped: failed };
  }

  const reasons = failed.map((s) => `${s.track.name} — ${s.track.singer}`).join('、') || '无候选';
  const anyPaid = failed.some((s) => s.reason === 'paid');
  const error = new Error(
    anyPaid
      ? `《${query}》的正式版需要付费或登录才能播放，其余 ${failed.length} 个版本也都不可用` +
        (options.session?.token ? '（登录态可能已过期）' : '（登录后可播放原版）')
      : `《${query}》没有可播放的版本（试过：${reasons}）`,
  );
  error.reason = anyPaid ? 'paid' : 'unavailable';
  error.skipped = failed;
  throw error;
}

/** Search and resolve in one step. Returns the chosen track plus its stream. */
export async function findAndResolve(keyword, options = {}) {
  const { limit = 8, quality = 'auto', timeoutMs = 20000, userAgent, session, onInvalidSession } = options;
  const tracks = await searchTracks(keyword, { limit, timeoutMs, userAgent });
  if (tracks.length === 0) throw new Error(`没有搜到《${keyword}》`);
  const { track, stream, skipped } = await resolveFirstPlayable(tracks, keyword, {
    quality,
    timeoutMs,
    userAgent,
    session,
    onInvalidSession,
  });
  return { track, stream, candidates: tracks, skipped };
}

export { QUALITY_TIERS };
