/**
 * Matching regression: the chosen track must be the right SONG by the right
 * artist — not a different song by the right artist, and not a cover by a
 * stranger. Both halves have failed during development, so both are pinned.
 *
 * The last section pins one more trap: when the catalogue's only clean-titled
 * entry is a 试听 stub, the picker must prefer a full-length variant rather
 * than hand the user two minutes of a four-minute song.
 */
import { searchTracks, pickTrack, looksTruncated } from '../lib/kugou.js';

const cases = [
  ['晴天 周杰伦', /晴天/, /周杰伦/],
  ['七里香 周杰伦', /七里香/, /周杰伦/],
  ['稻香 周杰伦', /稻香/, /周杰伦/],
  ['突然好想你 五月天', /突然好想你/, /五月天/],
  ['孤勇者 陈奕迅', /孤勇者/, /陈奕迅/],
  ['起风了 林俊杰', /起风了/, /林俊杰/],
  ['Shape of You Ed Sheeran', /shape of you/i, /Ed Sheeran/i],
  ['Love Story Taylor Swift', /love story/i, /Taylor Swift/i],
];

let pass = 0;
let total = 0;
for (const [query, wantTitle, wantArtist] of cases) {
  total += 1;
  try {
    const tracks = await searchTracks(query, { limit: 8 });
    const best = pickTrack(tracks, query);
    const titleOk = Boolean(best) && wantTitle.test(best.name);
    const artistOk = Boolean(best) && wantArtist.test(best.singer);
    const ok = titleOk && artistOk;
    if (ok) pass += 1;
    const why = ok ? '' : `   期望 歌名${wantTitle} 歌手${wantArtist}`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  「${query}」 -> ${best?.name ?? '(none)'} — ${best?.singer ?? ''}${why}`);
  } catch (error) {
    console.log(`FAIL  「${query}」 -> ${error.message}`);
  }
}

// --- truncation: a 试听 stub must not win over a full performance ----------
console.log('\n--- 试听片段防护 ---');
const truncationCases = [
  // 《水手》's only clean-titled 郑智化 entry is a 120s stub; every full
  // performance is parenthesised. The picker must not take the stub.
  ['水手 郑智化', 0.6],
  ['水手', 0.6],
];
for (const [query, ratio] of truncationCases) {
  total += 1;
  try {
    const tracks = await searchTracks(query, { limit: 20 });
    const best = pickTrack(tracks, query);
    const longest = tracks.reduce((max, t) => Math.max(max, t.durationSec || 0), 0);
    const ok = Boolean(best) && !looksTruncated(best, tracks) && best.durationSec >= longest * ratio;
    if (ok) pass += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  「${query}」 -> ${best?.name ?? '(none)'} — ${best?.singer ?? ''}` +
        `  ${best?.durationSec ?? 0}s（同曲最长 ${longest}s）${ok ? '' : '   选中了明显偏短的版本'}`,
    );
  } catch (error) {
    console.log(`FAIL  「${query}」 -> ${error.message}`);
  }
}

console.log(`\n${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;
