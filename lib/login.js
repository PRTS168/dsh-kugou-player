/**
 * Account login for Kugou — implemented entirely inside the plugin.
 *
 * Why login is needed at all: searching is anonymous, but resolving the
 * original studio recording of a popular song answers with
 * `fail_process: ["pkg","buy"]` and a 60-second excerpt unless the request
 * carries an account session.
 *
 * Device registration + QR scan login, both spoken directly to Kugou:
 *   1. POST https://userservice.kugou.com/risk/v2/r_register_dev   device identity
 *   2. GET  https://login-user.kugou.com/v2/qrcode                 ask for a QR key
 *   3. GET  https://login-user.kugou.com/v2/get_userinfo_qrcode   poll scan result
 *
 * There is no companion service. Signing and encryption live in
 * ./kugou-crypto.js, ported from KuGouMusicApi (MIT).
 *
 * @module dsh-music-player/login
 */
import {
  ANDROID_UA,
  SRCA_APPID,
  STD_APPID,
  androidSignature,
  defaultParams,
  deviceOpen,
  deviceSeal,
  rsaPkcs1Encrypt,
  signedHeaders,
  webSignature,
} from './kugou-crypto.js';

const REGISTER_URL = 'https://userservice.kugou.com/risk/v2/r_register_dev';

/**
 * One signed POST to Kugou.
 *
 * Query parameters carry the device identity plus a `signature` computed over
 * the body, which is why the body is serialised before the URL is built.
 *
 * `rawBody` lets a caller send a pre-encoded string (device registration sends
 * a base64 ciphertext, not JSON); `extraParams` carries endpoint-specific query
 * fields; `raw` returns the bytes instead of parsed JSON, which that same
 * endpoint needs because its response is an encrypted envelope.
 */
async function signedPost(
  url,
  bodyObject,
  device,
  { userAgent = ANDROID_UA, extraHeaders = {}, extraParams = {}, rawBody, raw = false, timeoutMs = 20000 } = {},
) {
  const body = rawBody ?? JSON.stringify(bodyObject ?? {});
  const params = defaultParams(device, extraParams);
  params.signature = androidSignature(params, body);
  const query = new URLSearchParams(params).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}?${query}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { ...signedHeaders(device, userAgent), 'Content-Type': 'application/json', ...extraHeaders },
      body,
    });
    if (raw) return { buffer: Buffer.from(await res.arrayBuffer()), status: res.status };
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`酷狗返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    return { json };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求酷狗超时（${timeoutMs}ms）`);
    if (String(error?.message ?? '').startsWith('酷狗返回')) throw error;
    throw new Error(`请求酷狗失败：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register this device with Kugou's risk service.
 *
 * A locally invented `dfid` is not trusted: `send_mobile_code` answers
 * "请先通过验证" until the device has been introduced. Registration uploads a
 * device profile and returns the `dfid` Kugou will recognise afterwards.
 *
 * @returns { ok, dfid?, error? }
 */
export async function registerDevice(device, { timeoutMs } = {}) {
  const profile = {
    availableRamSize: 4983533568,
    availableRomSize: 48114719,
    availableSDSize: 48114717,
    basebandVer: '',
    batteryLevel: 100,
    batteryStatus: 3,
    brand: 'Redmi',
    buildSerial: 'unknown',
    device: 'marble',
    imei: device.guid,
    imsi: '',
    manufacturer: 'Xiaomi',
    uuid: device.guid,
    accelerometer: false,
    accelerometerValue: '',
    gravity: false,
    gravityValue: '',
    gyroscope: false,
    gyroscopeValue: '',
    light: false,
    lightValue: '',
    magnetic: false,
    magneticValue: '',
    orientation: false,
    orientationValue: '',
    pressure: false,
    pressureValue: '',
    step_counter: false,
    step_counterValue: '',
    temperature: false,
    temperatureValue: '',
  };

  const sealed = deviceSeal(profile);
  const p = rsaPkcs1Encrypt(JSON.stringify({ aes: sealed.session, uid: 0, token: '' }));

  const { buffer } = await signedPost(REGISTER_URL, null, device, {
    rawBody: sealed.str,
    extraParams: { part: 1, platid: 1, p },
    raw: true,
    timeoutMs,
  });

  let body;
  try {
    body = deviceOpen(buffer.toString('base64'), sealed.session);
  } catch (error) {
    return { ok: false, error: `设备注册响应无法解密：${error?.message ?? error}` };
  }

  if (body?.status !== 1 || !body?.data?.dfid) {
    return { ok: false, error: `设备注册失败：${JSON.stringify(body).slice(0, 200)}` };
  }
  return { ok: true, dfid: String(body.data.dfid) };
}

// ---------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------

/**
 * Why QR login exists alongside the SMS flow.
 *
 * `send_mobile_code` is behind Kugou's risk service: it answers
 * `error_code 20028` / "请先通过验证" with an `ssa-code` header, which the
 * official clients resolve by showing a Tencent captcha in a browser. A
 * headless plugin cannot solve a slider captcha.
 *
 * Scanning a code is itself the human verification, so this path needs no
 * captcha at all. The trade-off is that it needs the user's phone and the
 * Kugou app rather than a typed code.
 */
const QR_KEY_URL = 'https://login-user.kugou.com/v2/qrcode';
const QR_CHECK_URL = 'https://login-user.kugou.com/v2/get_userinfo_qrcode';

/** One signed web-style GET. */
async function signedGet(url, extraParams, device, { timeoutMs = 20000 } = {}) {
  const params = defaultParams(device, extraParams);
  params.signature = webSignature(params, '');
  const query = new URLSearchParams(params).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}?${query}`, { signal: controller.signal, headers: signedHeaders(device) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`酷狗返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    return { json, ssaCode: res.headers.get('ssa-code') ?? '' };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求酷狗超时（${timeoutMs}ms）`);
    if (String(error?.message ?? '').startsWith('酷狗返回')) throw error;
    throw new Error(`请求酷狗失败：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for a QR key and the URL the user should scan.
 *
 * @returns { ok, key?, url?, error? }
 */
export async function createQrSession(device, { timeoutMs } = {}) {
  const { json, ssaCode } = await signedGet(
    QR_KEY_URL,
    {
      appid: 1001,
      type: 1,
      plat: 4,
      qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${STD_APPID}`,
      srcappid: SRCA_APPID,
    },
    device,
    { timeoutMs },
  );

  const key = json?.data?.qrcode;
  if (!key) {
    return {
      ok: false,
      error: `${json?.error_msg ?? json?.error ?? JSON.stringify(json).slice(0, 200)}${ssaCode ? '（酷狗要求风控验证）' : ''}`,
    };
  }
  return {
    ok: true,
    key: String(key),
    // What the QR encodes; the Kugou app opens this and authorises the login.
    url: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`,
  };
}

/**
 * Poll the QR session.
 *
 * Kugou's own status codes: 0 = expired, 1 = waiting for a scan, 2 = scanned
 * but not confirmed, 4 = authorised (and only then is a token returned).
 *
 * @returns { ok, status, label, session?, error? }
 */
export async function checkQrSession(key, device, { timeoutMs } = {}) {
  const { json } = await signedGet(
    QR_CHECK_URL,
    { plat: 4, appid: STD_APPID, srcappid: SRCA_APPID, qrcode: key, dev: device.dev },
    device,
    { timeoutMs },
  );

  const status = Number(json?.data?.status ?? -1);
  const labels = {
    0: '二维码已过期',
    1: '等待扫码',
    2: '已扫码，请在手机上确认',
    4: '登录成功',
  };
  const label = labels[status] ?? `未知状态 ${status}`;

  if (status === 4) {
    const data = json.data ?? {};
    if (!data.token) return { ok: false, status, label, error: '授权成功但返回里没有 token' };
    return {
      ok: true,
      status,
      label,
      session: {
        token: String(data.token),
        userid: Number(data.userid) || 0,
        vipType: Number(data.vip_type) || 0,
        dfid: device.dfid,
        mid: device.mid,
      },
    };
  }
  return { ok: status === 1 || status === 2, status, label };
}

/**
 * Render a QR code to a PNG file.
 *
 * The code has to be displayed somewhere the user's phone can point at, and a
 * chat message cannot carry an image — so it goes to a file next to the plugin
 * and the caller reports the path.
 */
export async function renderQrPng(url, outPath) {
  const QRCode = (await import('qrcode')).default;
  await QRCode.toFile(outPath, url, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
  return outPath;
}
