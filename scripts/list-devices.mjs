/**
 * Enumerate audio output devices so the player can target the right one.
 *
 * This machine carries several virtual endpoints (VB-Audio Virtual Cable,
 * NetEase's virtual device, WO Mic). If Windows' default playback device is one
 * of those, audio renders perfectly into a sink nobody can hear — the context
 * reports "running" and the clock advances while the room stays silent. Listing
 * the endpoints is how we tell those two situations apart.
 */
import { mediaDevices, AudioContext } from 'node-web-audio-api';
import { isVirtualSink } from '../lib/sink.js';

const devices = await mediaDevices.enumerateDevices();
console.log(`[enumerate] ${devices.length} device(s)\n`);
for (const d of devices) {
  const tag = d.kind === 'audiooutput' ? (isVirtualSink(d.label) ? ' [virtual]' : ' [real]') : '';
  console.log(`  kind=${String(d.kind).padEnd(12)} label="${d.label ?? ''}"  id=${String(d.deviceId).slice(0, 40)}${tag}`);
}

const outputs = devices.filter((d) => d.kind === 'audiooutput');
console.log(`\n[enumerate] ${outputs.length} audio output(s)`);

// Which sink does a plain `new AudioContext()` actually land on?
const ctx = new AudioContext();
console.log(`[enumerate] default context: sinkId=${JSON.stringify(ctx.sinkId ?? '(not exposed)')} state=${ctx.state}`);
await ctx.close();

// Can we select a sink explicitly? Report per-device, without emitting sound.
for (const d of outputs) {
  try {
    const c = new AudioContext({ sinkId: d.deviceId });
    console.log(`  sinkId=${String(d.deviceId).slice(0, 24)}… -> OK (state=${c.state}) label="${d.label ?? ''}"${isVirtualSink(d.label) ? ' [virtual]' : ' [real]'}`);
    await c.close();
  } catch (error) {
    console.log(`  sinkId=${String(d.deviceId).slice(0, 24)}… -> FAILED: ${error?.message ?? error}`);
  }
}
