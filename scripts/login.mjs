/**
 * Terminal login: obtain a Kugou session without putting anything sensitive
 * into the chat transcript.
 *
 *   npm run login          QR code, drawn in the terminal
 *
 * Why QR is the default: `send_mobile_code` sits behind Kugou's risk service.
 * It answers `error_code 20028` / "请先通过验证" with an `ssa-code` header, and
 * the official clients clear that by showing a Tencent captcha in a browser —
 * something a headless plugin cannot solve. Scanning a code IS the human
 * verification, so the QR path needs no captcha at all.
 *
 * Same code path as the `music_login` tool, just driven from a prompt. Nothing
 * is written to disk except the token and the device identity, in
 * .session.json (listed in .gitignore).
 */
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SessionStore } from '../lib/session.js';
import { newDevice } from '../lib/kugou-crypto.js';
import { createQrSession, checkQrSession } from '../lib/login.js';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const sessions = new SessionStore(join(PLUGIN_DIR, '.session.json'));

/** Reuse the stored device identity; Kugou ties the session to it. */
async function loadDevice() {
  const raw = await sessions.readRaw();
  if (raw?.device?.mid && raw?.device?.guid) return raw.device;
  return sessions.saveDevice(newDevice());
}

function finish(session, device) {
  return sessions.save({ ...session, device }).then(async (saved) => {
    try {
      await chmod(sessions.file, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file is still user-scoped.
    }
    console.log('\n✅ 登录成功，会话已保存。');
    console.log(`   userid   : ${saved.userid}`);
    console.log(`   vip_type : ${saved.vipType}`);
    console.log(`   文件     : ${sessions.file}`);
    console.log('\n插件按文件修改时间自动重读，通常不用重启。现在可以试原版了。\n');
  });
}

const device = await loadDevice();

// ---------------------------------------------------------------------------
// QR flow
// ---------------------------------------------------------------------------
console.log('\n=== Kugou 扫码登录 ===\n');

const qr = await createQrSession(device);
if (!qr.ok) {
  console.error(`生成二维码失败：${qr.error}`);
  process.exit(1);
}

const QRCode = (await import('qrcode')).default;
console.log(await QRCode.toString(qr.url, { type: 'terminal', small: true }));
console.log('请用【酷狗 App】扫描上面的二维码并确认。\n');

const deadline = Date.now() + 3 * 60 * 1000;
let announced = '';
while (Date.now() < deadline) {
  const chk = await checkQrSession(qr.key, device);
  if (chk.session) {
    await finish(chk.session, device);
    process.exit(0);
  }
  if (chk.status === 0) {
    console.error('二维码已过期，请重新运行 npm run login。');
    process.exit(1);
  }
  if (chk.label !== announced) {
    announced = chk.label;
    console.log(`  ${chk.label}…`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error('等待超时（3 分钟），请重新运行。');
process.exit(1);
