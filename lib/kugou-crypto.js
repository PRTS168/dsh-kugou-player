/**
 * Kugou request signing, device identity and the login handshake — implemented
 * with Node's built-in `crypto`, so the plugin needs no companion service.
 *
 * The algorithms here are ported from KuGouMusicApi (MIT, © MakcRe and
 * contributors), which reverse-engineered them:
 *   util/helper.js   signatureAndroidParams, signParamsKey
 *   util/crypto.js   cryptoAesEncrypt, cryptoAesDecrypt, cryptoRSAEncrypt
 *   util/util.js     randomString, calculateMid, getGuid
 *   module/*.js      the request/params shape per endpoint
 * Attribution matters: these are constants and constructions extracted from
 * someone else's work, not inventions of this plugin.
 *
 * Two details are easy to get wrong and are called out where they matter:
 *   1. AES keys are the *characters* of a hex digest used as UTF-8 bytes, not
 *      the decoded bytes — a 32-character string is a 32-byte AES-256 key.
 *   2. `cryptoRSAEncrypt` is raw modular exponentiation with NO padding
 *      (`RSA_NO_PADDING` in Node), left-zero-padded to the modulus length.
 *
 * @module dsh-music-player/kugou-crypto
 */
import { createHash, createCipheriv, createDecipheriv, createPublicKey, publicEncrypt, constants, randomUUID, randomBytes } from 'node:crypto';

/** Concept-version (lite) client identity — the flavour that unlocks VIP access. */
export const LITE_APPID = 3116;
export const LITE_CLIENTVER = 11440;

/** Salt used for the `signature` parameter on android-style requests. */
const SIGN_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';

/** Salt used for the `signature` parameter on web/H5-style requests. */
const WEB_SIGN_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';

/** Kugou's shared web `srcappid`. */
export const SRCA_APPID = 2919;

/** The standard (non-lite) appid, used in QR login query strings. */
export const STD_APPID = 1005;

/** Public key for the `pk` field of the login body (concept version). */
const LITE_RSA_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB\n' +
  '-----END PUBLIC KEY-----';

/** Fixed AES keys used for the t1/t2 anti-fraud fields. */
const T1_KEY = '5e4ef500e9597fe004bd09a46d8add98';
const T1_IV = '04bd09a46d8add98';
const T2_KEY = 'fd14b35e3f81af3817a20ae7adae7020';
const T2_IV = '17a20ae7adae7020';

/** Client version string the login endpoint expects. */
export const ANDROID_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
export const LOGIN_UA = 'Android16-1070-11440-130-0-LOGIN-wifi';

export const md5 = (text) => createHash('md5').update(String(text), 'utf8').digest('hex');

/** The alphabet Kugou's own client uses for random device strings. */
const RANDOM_ALPHABET = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Random uppercase alphanumeric string, matching the client's generator. */
export function randomString(length = 16) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += RANDOM_ALPHABET[bytes[i] % RANDOM_ALPHABET.length];
  return out;
}

/**
 * Derive the device `mid` from a GUID.
 *
 * The value is MD5(guid) read as a base-16 integer and printed in decimal — a
 * 39-digit string. It is what ties every request to one device identity.
 */
export function calculateMid(guid) {
  const digest = md5(guid);
  return BigInt(`0x${digest}`).toString();
}

/**
 * A fresh device identity.
 *
 * Persisted by the caller: Kugou expects the same device across requests, and
 * changing it mid-session looks like an account compromise.
 */
export function newDevice() {
  const guid = md5(randomUUID());
  return {
    guid,
    mid: calculateMid(guid),
    mac: '02:00:00:00:00:00',
    dev: randomString(10).toUpperCase(),
    dfid: randomString(24),
    webgl: String(Math.floor(Math.random() * 9e18)),
  };
}

// ---------------------------------------------------------------------------
// AES
// ---------------------------------------------------------------------------

/**
 * AES-CBC/PKCS7 encrypt to hex.
 *
 * Both key and IV are used as UTF-8 *characters*, so a 32-character string is a
 * 32-byte key. Passing decoded bytes here would silently produce garbage the
 * server rejects.
 */
export function aesEncryptHex(plain, key, iv) {
  const cipher = createCipheriv(`aes-${Buffer.byteLength(key) * 8}-cbc`, Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('hex');
}

/** AES-CBC/PKCS7 decrypt from hex. */
export function aesDecryptHex(hex, key, iv) {
  const decipher = createDecipheriv(`aes-${Buffer.byteLength(key) * 8}-cbc`, Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
}

/**
 * Encrypt a payload under a fresh random key, returning both.
 *
 * The key is not transmitted directly: it is sealed into the RSA `pk` field so
 * the server can decrypt the payload. The caller keeps the raw key to decrypt
 * `secu_params` in the response.
 */
export function sealPayload(payload) {
  const secret = randomString(16).toLowerCase();
  const key = md5(secret).slice(0, 32);
  const iv = key.slice(key.length - 16);
  return { str: aesEncryptHex(payload, key, iv), secret };
}

/** Decrypt a `secu_params` field sealed with `sealPayload`. */
export function openPayload(hex, secret) {
  const key = md5(secret).slice(0, 32);
  const iv = key.slice(key.length - 16);
  const text = aesDecryptHex(hex, key, iv);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// RSA
// ---------------------------------------------------------------------------

/**
 * Raw RSA encryption: m^e mod n, no padding.
 *
 * Node exposes this as RSA_NO_PADDING, but it insists the input already be
 * exactly modulus-sized, so short payloads are left-zero-padded first — which
 * is what the reference implementation does by hand.
 */
export function rawRsaEncrypt(data, pem = LITE_RSA_PUBLIC_KEY) {
  const key = createPublicKey(pem);
  const size = Math.ceil(key.asymmetricKeyDetails.modulusLength / 8);
  const input = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (input.length > size) throw new Error(`RSA payload ${input.length}B exceeds key size ${size}B`);
  const padded = Buffer.alloc(size);
  input.copy(padded, size - input.length);
  return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded).toString('hex');
}

/**
 * RSA with PKCS#1 v1.5 padding.
 *
 * Used for the `p` field of device registration, which seals a short session
 * key rather than raw data — a different construction from the login body's
 * `pk`, and mixing the two up yields a request the server rejects.
 */
export function rsaPkcs1Encrypt(data, pem = LITE_RSA_PUBLIC_KEY) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return publicEncrypt({ key: createPublicKey(pem), padding: constants.RSA_PKCS1_PADDING }, input).toString('hex');
}

/**
 * The AES-128 envelope Kugou uses for device registration.
 *
 * A short random session string is expanded into key and IV via MD5 — the first
 * 16 characters become the key, the last 16 the IV — and the session string
 * travels separately, RSA-sealed in the `p` field.
 */
export function deviceSeal(data) {
  const session = randomString(6).toLowerCase();
  const digest = md5(session);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(digest.slice(0, 16), 'utf8'), Buffer.from(digest.slice(16, 32), 'utf8'));
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  return { session, str: Buffer.concat([cipher.update(body), cipher.final()]).toString('base64') };
}

/** Decrypt a device-registration response sealed with {@link deviceSeal}. */
export function deviceOpen(base64, session) {
  const digest = md5(session);
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(digest.slice(0, 16), 'utf8'), Buffer.from(digest.slice(16, 32), 'utf8'));
  const text = Buffer.concat([decipher.update(Buffer.from(base64, 'base64')), decipher.final()]).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * The `signature` parameter on android-style requests.
 *
 * md5(salt + <keys sorted, "k=v" joined with no separator> + body + salt),
 * where the body is the JSON string for POSTs and empty for GETs.
 */
export function androidSignature(params, body = '') {
  const flat = Object.keys(params)
    .sort()
    .map((k) => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]}`)
    .join('');
  return md5(`${SIGN_SALT}${flat}${body}${SIGN_SALT}`);
}

/** md5(appid + salt + clientver + data) — used for the login body's `key`. */
export function signParamsKey(data) {
  return md5(`${LITE_APPID}${SIGN_SALT}${LITE_CLIENTVER}${data}`);
}

/**
 * The `signature` parameter for web-style (H5) requests.
 *
 * A different salt from the android form, and it is the flavour the QR-login
 * endpoints expect.
 */
export function webSignature(params, body = '') {
  const flat = Object.keys(params)
    .sort()
    .map((k) => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]}`)
    .join('');
  return md5(`${WEB_SIGN_SALT}${flat}${body}${WEB_SIGN_SALT}`);
}

/** Query parameters every signed request carries. */
export function defaultParams(device, extra = {}) {
  const params = {
    dfid: device?.dfid ?? '-',
    mid: device?.mid ?? '',
    uuid: '-',
    appid: LITE_APPID,
    clientver: LITE_CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
    ...extra,
  };
  return params;
}

/** Headers that identify the client on every signed request. */
export function signedHeaders(device, userAgent = ANDROID_UA) {
  return {
    'User-Agent': userAgent,
    dfid: device?.dfid ?? '-',
    mid: device?.mid ?? '',
    clienttime: String(Math.floor(Date.now() / 1000)),
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
  };
}

/** Build the t1/t2 anti-fraud fields. */
export function antiFraudFields(device, dateTime) {
  const t2 = aesEncryptHex(`${device.guid}|0f607264fc6318a92b9e13c65db7cd3c|${device.mac}|${device.dev}|${dateTime}`, T2_KEY, T2_IV);
  const t1 = aesEncryptHex(`|${dateTime}`, T1_KEY, T1_IV);
  return { t1, t2 };
}

export { LITE_RSA_PUBLIC_KEY };
