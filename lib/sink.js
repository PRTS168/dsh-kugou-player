/**
 * Output device selection.
 *
 * A machine with virtual audio drivers installed (VB-Audio Cable, voice-changer
 * and streaming-tool devices) will happily let Windows' default playback device
 * point at a virtual sink. Audio then renders perfectly — the context reports
 * "running" and the clock advances — while the room stays silent, because the
 * samples go into a cable nobody is listening to. That failure looks exactly
 * like a broken player, so it is worth handling explicitly rather than leaving
 * to the user to diagnose.
 *
 * Selection is a preference, never a hard requirement: if nothing matches, the
 * system default is used.
 *
 * @module dsh-music-player/sink
 */

/**
 * Labels that identify a virtual/loopback endpoint rather than a speaker.
 *
 * Matched case-insensitively against the device label. Chinese labels are
 * included because localized drivers name themselves locally
 * ("网易虚拟音频设备" = NetEase virtual audio device).
 */
const VIRTUAL_PATTERNS = [
  /vb-audio/i,
  /virtual\s*cable/i,
  /cable\s+(in|out)\b/i,
  /voicemeeter/i,
  /虚拟音频/,
  /虚拟声卡/,
  /loopback/i,
  /wo\s*mic/i,
  /\bnull\b/i,
  /blackhole/i,
  /soundflower/i,
];

/** Labels that identify genuine hardware, in rough order of trustworthiness. */
const REAL_PATTERNS = [
  /realtek/i,
  /high definition audio/i,
  /扬声器/,
  /\bspeaker\b/i,
  /\bhdmi\b/i,
];

/** Is this endpoint a virtual sink rather than a speaker? */
export function isVirtualSink(label) {
  const text = String(label ?? '');
  return VIRTUAL_PATTERNS.some((re) => re.test(text));
}

/** Does this endpoint look like real output hardware? */
export function isRealSink(label) {
  const text = String(label ?? '');
  return REAL_PATTERNS.some((re) => re.test(text));
}

/**
 * Enumerate audio outputs via the library's mediaDevices shim.
 *
 * Returns [] rather than throwing when enumeration is unavailable, so a host
 * without it simply falls back to the default device.
 */
export async function listOutputs() {
  try {
    const { mediaDevices } = await import('node-web-audio-api');
    if (!mediaDevices?.enumerateDevices) return [];
    const devices = await mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({ deviceId: String(d.deviceId ?? ''), label: String(d.label ?? '') }));
  } catch {
    return [];
  }
}

/**
 * Choose which device to render to.
 *
 * @param preference
 *   - `'default'`: let the system decide.
 *   - `'auto'`: first real (non-virtual) output, preferring recognisable hardware.
 *   - any other string: matched against the device label first, then treated as
 *     a literal deviceId.
 * @returns { deviceId, label, reason } — deviceId is '' to mean "system default".
 */
export async function selectSink(preference = 'auto') {
  const wanted = String(preference ?? 'auto').trim();
  if (wanted === '' || wanted.toLowerCase() === 'default') {
    return { deviceId: '', label: '', reason: 'system default (configured)' };
  }

  const outputs = await listOutputs();
  if (outputs.length === 0) {
    return { deviceId: '', label: '', reason: 'system default (no device list available)' };
  }

  // An explicit choice wins, whether given as a label fragment or a raw id.
  if (wanted.toLowerCase() !== 'auto') {
    const needle = wanted.toLowerCase();
    const byId = outputs.find((d) => d.deviceId.trim() === wanted.trim());
    const byLabel = outputs.find((d) => d.label.toLowerCase().includes(needle));
    const hit = byId ?? byLabel;
    if (hit) return { deviceId: hit.deviceId, label: hit.label, reason: 'configured match' };
    return { deviceId: '', label: '', reason: `system default (no device matched "${wanted}")` };
  }

  const real = outputs.filter((d) => !isVirtualSink(d.label));
  if (real.length === 0) {
    const first = outputs[0];
    return {
      deviceId: '',
      label: first.label,
      reason: 'system default (every output looks virtual)',
    };
  }

  // Recognisable hardware first, then whatever is left in enumeration order.
  const ranked = [...real].sort((a, b) => Number(isRealSink(b.label)) - Number(isRealSink(a.label)));
  const chosen = ranked[0];
  const skipped = outputs.filter((d) => isVirtualSink(d.label)).map((d) => d.label);
  return {
    deviceId: chosen.deviceId,
    label: chosen.label,
    reason: skipped.length > 0 ? `auto (skipped ${skipped.length} virtual output(s))` : 'auto',
  };
}
