/**
 * Output device selection.
 * @module dsh-music-player/sink
 */
const VIRTUAL_PATTERNS = [
  /vb-audio/i, /virtual\s*cable/i, /cable\s+(in|out)\b/i, /voicemeeter/i,
  /虚拟音频/, /虚拟声卡/, /loopback/i, /wo\s*mic/i, /\bnull\b/i,
  /blackhole/i, /soundflower/i,
];
const REAL_PATTERNS = [
  /realtek/i, /high definition audio/i, /扬声器/, /\bspeaker\b/i, /\bhdmi\b/i,
];

export function isVirtualSink(label) { return VIRTUAL_PATTERNS.some((re) => re.test(String(label ?? ''))); }
export function isRealSink(label) { return REAL_PATTERNS.some((re) => re.test(String(label ?? ''))); }

export async function listOutputs() {
  try {
    const { mediaDevices } = await import('node-web-audio-api');
    if (!mediaDevices?.enumerateDevices) return [];
    const devices = await mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audiooutput')
      .map((d) => ({ deviceId: String(d.deviceId ?? ''), label: String(d.label ?? '') }));
  } catch { return []; }
}

export async function selectSink(preference = 'auto') {
  const wanted = String(preference ?? 'auto').trim();
  if (wanted === '' || wanted.toLowerCase() === 'default') {
    return { deviceId: '', label: '', reason: 'system default (configured)' };
  }
  const outputs = await listOutputs();
  if (outputs.length === 0) return { deviceId: '', label: '', reason: 'system default (no device list available)' };
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
    return { deviceId: '', label: first.label, reason: 'system default (every output looks virtual)' };
  }
  const ranked = [...real].sort((a, b) => Number(isRealSink(b.label)) - Number(isRealSink(a.label)));
  const chosen = ranked[0];
  const skipped = outputs.filter((d) => isVirtualSink(d.label)).map((d) => d.label);
  return {
    deviceId: chosen.deviceId,
    label: chosen.label,
    reason: skipped.length > 0 ? `auto (skipped ${skipped.length} virtual output(s))` : 'auto',
  };
}
