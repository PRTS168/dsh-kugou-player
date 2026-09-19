/**
 * Single-shot end-to-end verification of the engine fix.
 *
 * Uses MoeKoe's already-running engine at 127.0.0.1:6521 (set via
 * MUSIC_ENGINE_BASE) so we don't spawn a second binary. Tests exactly ONE
 * song with the corrected privilege hash.
 *
 * Usage:  MUSIC_ENGINE_BASE=http://127.0.0.1:6521 node scripts/verify-engine-fix.mjs
 */
import { startEngine, resolveViaEngine, stopEngine } from '../lib/engine.js';

console.log('--- 引擎修复端到端验证 ---');
try {
  const base = await startEngine({ timeoutMs: 10000 });
  console.log(`[OK] 引擎就绪: ${base}`);
  console.log('');
  const result = await resolveViaEngine(process.argv[2] || '', process.argv[3] || 'flac', {
    timeoutMs: 15000,
    retries: 0,
  });
  console.log('=== 结果 ===');
  console.log(`  URL:     ${result.url}`);
  console.log(`  格式:    ${result.ext}`);
  console.log(`  码率:    ${result.bitrateKbps} kbps`);
  console.log('');
  if (result.url) console.log('✅ 验证通过: 成功获取流地址');
} catch (error) {
  console.error('');
  console.error('❌ 验证失败:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await stopEngine();
}
