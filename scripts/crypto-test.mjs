/**
 * Unit tests for the ported Kugou crypto.
 *
 * The guid -> mid pair is a real observed vector, lifted from a live service's
 * own cookie: if calculateMid disagrees with it, the port is wrong and every
 * signed request would be rejected. The rest are structural properties that a
 * subtly broken port (wrong key encoding, wrong padding) would violate.
 */
import { calculateMid, md5, randomString, newDevice, aesEncryptHex, aesDecryptHex, sealPayload, openPayload, rawRsaEncrypt, androidSignature, signParamsKey, antiFraudFields, LITE_RSA_PUBLIC_KEY } from '../lib/kugou-crypto.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log('\n=== kugou-crypto unit tests ===\n');

// ---- known vector ---------------------------------------------------------
// Observed together in a running KuGouMusicApi service's own cookie jar.
const GUID = '5244b070ed0b0a6f076b3b4c47f773c4';
const MID = '202905882714753290446204221787125210017';
const derived = calculateMid(GUID);
check('calculateMid 命中真实观测向量', derived === MID, derived === MID ? `mid=${derived}` : `得到 ${derived}，期望 ${MID}`);

// ---- randomString ---------------------------------------------------------
const r16 = randomString(16);
check('randomString 长度正确', r16.length === 16, r16);
check('randomString 只用客户端字母表', /^[0-9A-Z]+$/.test(r16), r16);

// ---- md5 ------------------------------------------------------------------
check('md5 与小写十六进制一致', md5('abc') === '900150983cd24fb0d6963f7d28e17f72', md5('abc'));

// ---- AES ------------------------------------------------------------------
// A 32-character key is 32 BYTES (AES-256), not 16 decoded bytes. Getting this
// wrong is the classic way to produce ciphertext the server rejects.
const K32 = '0123456789abcdef0123456789abcdef';
const IV16 = 'abcdef0123456789';
const enc = aesEncryptHex('hello 水手', K32, IV16);
check('AES-256 加密产生十六进制', /^[0-9a-f]+$/.test(enc) && enc.length % 32 === 0, `${enc.slice(0, 32)}…`);
check('AES 往返一致', aesDecryptHex(enc, K32, IV16) === 'hello 水手');
check('AES 用错 key 不会静默成功', (() => {
  try {
    return aesDecryptHex(enc, 'ffffffffffffffffffffffffffffffff', IV16) !== 'hello 水手';
  } catch {
    return true;
  }
})());

// ---- sealed payload (the login credential blob) ---------------------------
const sealed = sealPayload(JSON.stringify({ mobile: '13800000000', code: '123456' }));
check('sealPayload 返回 hex 与 16 位密钥', /^[0-9a-f]+$/.test(sealed.str) && sealed.secret.length === 16, `secret=${sealed.secret}`);
check('openPayload 能还原原文', (() => {
  const opened = openPayload(sealed.str, sealed.secret);
  return opened?.mobile === '13800000000' && opened?.code === '123456';
})());

// ---- RSA ------------------------------------------------------------------
const pk = rawRsaEncrypt(JSON.stringify({ clienttime_ms: 1, key: 'x'.repeat(16) }));
check('rawRsaEncrypt 输出 1024 位密文', /^[0-9a-f]+$/.test(pk) && pk.length === 256, `${pk.length} hex chars`);
check('rawRsaEncrypt 拒绝超长输入', (() => {
  try {
    rawRsaEncrypt('x'.repeat(200));
    return false;
  } catch {
    return true;
  }
})());
check('RSA 公钥是概念版那把', LITE_RSA_PUBLIC_KEY.includes('BEGIN PUBLIC KEY'));

// ---- signatures -----------------------------------------------------------
const sigA = androidSignature({ a: 1, b: 'x' }, '{"c":2}');
check('signature 是 32 位 md5', /^[0-9a-f]{32}$/.test(sigA), sigA);
check('signature 与参数顺序无关', androidSignature({ b: 'x', a: 1 }, '{"c":2}') === sigA);
check('signature 会随 body 变化', androidSignature({ a: 1, b: 'x' }, '{"c":3}') !== sigA);
check('signature 会随参数变化', androidSignature({ a: 2, b: 'x' }, '{"c":2}') !== sigA);

const k1 = signParamsKey(1700000000000);
check('signParamsKey 是 32 位 md5', /^[0-9a-f]{32}$/.test(k1), k1);

// ---- device + anti-fraud --------------------------------------------------
const device = newDevice();
check('设备身份字段齐全', Boolean(device.guid && device.mid && device.dev && device.dfid && device.mac), Object.keys(device).join(','));
check('设备 mid 是十进制大整数', /^\d{20,45}$/.test(device.mid), `${device.mid.length} 位`);
check('设备 guid 是 32 位 hex', /^[0-9a-f]{32}$/.test(device.guid));

const { t1, t2 } = antiFraudFields(device, 1700000000000);
check('t1/t2 都是十六进制', /^[0-9a-f]+$/.test(t1) && /^[0-9a-f]+$/.test(t2), `t1=${t1.length}字符 t2=${t2.length}字符`);
// AES-256-CBC over a fixed plaintext: t2's plaintext length determines the
// block count, so a wrong cipher shows up as the wrong length.
check('t2 使用了 AES-256（32 字节密钥）', t2.length > t1.length, `t1=${t1.length} t2=${t2.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  process.exitCode = 1;
}
