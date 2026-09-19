/**
 * Single-shot end-to-end verification of the engine fix.
 *
 * Uses MoeKoe's already-running engine at 127.0.0.1:6521 (set via
 * MUSIC_ENGINE_BASE) so we don't spawn a second binary. Tests exactly ONE
 * song (水手 郑智化) with the corrected privilege hash.
 *
 * Usage:  MUSIC_ENGINE_BASE=http://127.0.0.1:6521 node scripts/verify-engine-fix.mjs
 */
import { startEngine, resolveViaEngine, stopEngine } from '../lib/engine.js';

const SQ_HASH = 'a1b9b1e06012f09bda46788162c4d369';   // flac / 原版
const HQ_HASH = '1a96ab15b0904743b1703216ee793fa4';   // 320kbps (identity hash)

console.log('--- 引擎修复端到端验证 ---');
console.log(`目标: 水手 郑智化, quality=flac`);
console.log(`  song/url hash (sqHash):   ${SQ_HASH}`);
console.log(`  privilege/lite hash (hq): ${HQ_HASH}`);
console.log('');

try {
  const base = await startEngine({ timeoutMs: 10000 });
  console.log(`[OK] 引擎就绪: ${base}`);

  console.log('');
  console.log('调用 resolveViaEngine(hash=sqHash, quality=flac, privilegeHash=hqHash) ...');
  const result = await resolveViaEngine(SQ_HASH, 'flac', {
    timeoutMs: 15000,
    retries: 0,
    privilegeHash: HQ_HASH,
  });

  console.log('');
  console.log('=== 结果 ===');
  console.log(`  URL:     ${result.url}`);
  console.log(`  格式:    ${result.ext}`);
  console.log(`  码率:    ${result.bitrateKbps} kbps`);
  console.log('');
  if (result.url && result.ext === 'flac') {
    console.log('✅ 验证通过: 成功获取 FLAC 原版流地址');
  } else {
    console.log('⚠️  部分通过: 拿到 URL 但格式不是 flac');
  }
} catch (error) {
  console.error('');
  console.error('❌ 验证失败:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await stopEngine();
}
