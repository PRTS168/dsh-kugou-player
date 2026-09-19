/**
 * Audible sink check: play a short tone on every available output in turn, so
 * the right device can be identified by ear when several look plausible.
 *
 *   node scripts/tone-probe.mjs                 # auto-selected device only
 *   node scripts/tone-probe.mjs --all           # every output, one beep each
 *   node scripts/tone-probe.mjs --sink=Realtek  # a label fragment
 *
 * Emits a plain 440Hz tone with no network and no decoding, which isolates the
 * output device from the search/resolve/download path.
 */
import { AudioContext, OscillatorNode, GainNode } from 'node-web-audio-api';
import { listOutputs, selectSink, isVirtualSink } from '../lib/sink.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const sinkArg = args.find((a) => a.startsWith('--sink='))?.slice(7);
const seconds = 1.6;

async function tone(sinkId, label) {
  const ctx = sinkId ? new AudioContext({ sinkId }) : new AudioContext();
  await ctx.resume?.();
  const gain = new GainNode(ctx, { gain: 0.18 });
  gain.connect(ctx.destination);
  const osc = new OscillatorNode(ctx, { frequency: 440 });
  osc.connect(gain);
  const t0 = ctx.currentTime;
  osc.start(t0);
  osc.stop(t0 + seconds);
  console.log(`  >> playing ${seconds}s on: ${label || '(system default)'}  [state=${ctx.state}]`);
  await new Promise((r) => setTimeout(r, (seconds + 0.35) * 1000));
  await ctx.close();
}

const outputs = await listOutputs();
console.log(`[probe] ${outputs.length} output device(s):`);
for (const d of outputs) {
  console.log(`  - ${isVirtualSink(d.label) ? '[virtual]' : '[real   ]'} ${d.label}`);
}

if (all) {
  console.log('\n[probe] beeping each output in turn — note which one you actually hear:\n');
  for (const d of outputs) {
    await tone(d.deviceId, d.label);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\n[probe] done. Whichever label produced sound is the one to configure.');
} else {
  const picked = await selectSink(sinkArg ?? 'auto');
  console.log(`\n[probe] selected: ${picked.label || '(system default)'}  (${picked.reason})`);
  await tone(picked.deviceId, picked.label);
  console.log('[probe] done. If you heard a steady tone, this device works.');
}
