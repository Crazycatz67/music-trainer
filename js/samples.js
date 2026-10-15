// samples.js — real recorded reference notes (FluidR3_GM "Voice Oohs"), played at any pitch.
//
// Why recordings: the owner heard the code-made sung "oo" as robotic (2026-10-15), and only a
// real recording carries a voice's breath, onset and wobble (Ricky's real-samples report).
// The notes ship as 16-bit WAV, every 3rd semitone, so a target is never more than a
// semitone from a real take: resampling that little moves the vowel about 6 %, which keeps it
// a voice, not a chipmunk. Rendering is pure (no browser globals) so the Node checks feed the
// very samples the singer hears to js/pitch.js, as they do for renderTone.
//
// CONTRACT
//   SAMPLE_SETS.oohs     { dir, notes: number[] (midi), steady: [s0, s1], loop: [l0, l1] }
//                        steady = the part of each file used to measure loudness (seconds);
//                        loop = the part repeated (equal-power crossfade) for a note longer
//                        than the file.
//   readWav(bytes)       bytes: ArrayBuffer | Uint8Array of a RIFF/WAVE 16-bit PCM file
//                        -> { rate, data: Float32Array (-1..1; channels averaged) }.
//                        Anything else throws RangeError.
//   writeWav(data, rate) -> Uint8Array, 16-bit PCM mono (clipped to -1..1)
//   resample(src, step, n) -> Float32Array: n cubic reads, `step` source samples apart
//   pickSample(bank, midi) -> { key, data } of the nearest sampled note, or null when the
//                        nearest is more than MAX_SHIFT semitones away or the bank is empty.
//   renderSample(options) -> Float32Array mono at options.sampleRate, or null (no sample near
//                        enough: the caller falls back, synth.js uses 'voice'). Options:
//     bank          { rate, notes: { [midi]: Float32Array } } decoded files (any rate)
//     midi | hz     target pitch; dur = 1 s; sampleRate = 48000
//     gain = 0.3    peak never above PEAK_OF_GAIN x gain (0.99 at most); steady RMS scaled to RMS_OF_GAIN x gain, the
//                   loudness of renderTone's 'voice' (so switching tone is not a jump)
//     attack = 0.06, release = 0.2   seconds of raised-cosine fade in / out (no click)
//     set = SAMPLE_SETS.oohs         for the steady and loop times
//   loadSampleBank({ urlFor, notes, decode, fetchFn? }) -> Promise<bank>   [browser use]
//     urlFor(midi) -> URL; decode(ArrayBuffer) -> Promise<{ rate, data }>. Notes that fail to
//     load are left out; rejects only when none loaded.
//
// Failure behaviour: a bad pitch or dur <= 0 throws RangeError (as renderTone does); a
// missing sample is null, never an exception, so a failed download is silent.

export const MAX_SHIFT = 1.5;       // semitones; whole-note targets are never more than 1 away
export const RMS_OF_GAIN = 0.32;    // steady RMS of renderTone's 'voice' per unit gain (SUNG.rmsOfGain)
// A real choir "oo" is peakier than 'voice' (crest about 4.5 against 3.1 from C4 up): held to
// a peak of `gain` it came out 3.1-3.6 dB quieter than the tone it replaces. So its peak may
// reach 1.5 x gain (never past 0.99); callers' gains are 0.5 x volume at most.
export const PEAK_OF_GAIN = 1.5;

export const SAMPLE_SETS = Object.freeze({
  oohs: Object.freeze({
    dir: 'vendor/samples/voice-oohs/',
    notes: Object.freeze(Array.from({ length: 17 }, (_, i) => 36 + 3 * i)),   // C2 .. C6
    steady: Object.freeze([0.35, 1.3]),
    loop: Object.freeze([0.5, 1.35]),
  }),
});

export function readWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
  if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new RangeError('readWav: not a RIFF/WAVE file');
  let fmt = null, data = null;
  // Walk the chunks: afconvert and other tools put extra ones (FLLR, LIST) before 'data'.
  for (let at = 12; at + 8 <= u8.length;) {
    const id = tag(at), size = view.getUint32(at + 4, true), body = at + 8;
    if (id === 'fmt ') fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    else if (id === 'data') data = { at: body, size: Math.min(size, u8.length - body) };
    at = body + size + (size & 1);
  }
  if (!fmt || !data) throw new RangeError('readWav: no fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16 || !(fmt.channels >= 1)) throw new RangeError(`readWav: only 16-bit PCM is read (format ${fmt.format}, ${fmt.bits} bits)`);
  const frames = Math.floor(data.size / (2 * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += view.getInt16(data.at + 2 * (i * fmt.channels + c), true);
    out[i] = s / fmt.channels / 32768;
  }
  return { rate: fmt.rate, data: out };
}

export function writeWav(data, rate) {
  const u8 = new Uint8Array(44 + 2 * data.length);
  const view = new DataView(u8.buffer);
  const put = (at, s) => { for (let i = 0; i < 4; i++) u8[at + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, 36 + 2 * data.length, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, 2 * rate, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, 2 * data.length, true);
  for (let i = 0; i < data.length; i++) view.setInt16(44 + 2 * i, Math.round(32767 * Math.max(-1, Math.min(1, data[i]))), true);
  return u8;
}

export function pickSample(bank, midi) {
  if (!bank || !bank.notes) return null;
  let best = null;
  for (const k of Object.keys(bank.notes)) {
    const key = Number(k);
    if (best === null || Math.abs(key - midi) < Math.abs(best - midi)) best = key;
  }
  return best !== null && Math.abs(best - midi) <= MAX_SHIFT ? { key: best, data: bank.notes[best] } : null;
}

// Cubic (Catmull-Rom) read between samples: smoother than linear for a 1-semitone shift,
// and cheap enough to run per note on the main thread.
function cubicAt(d, p) {
  const i = Math.floor(p), f = p - i;
  const a = d[Math.max(0, i - 1)], b = d[i], c = d[Math.min(d.length - 1, i + 1)], e = d[Math.min(d.length - 1, i + 2)];
  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - e + f * (3 * (b - c) + e - a)));
}

// Read `n` samples from src, stepping `step` source samples per output sample (cubic).
// The build script uses it to retune a take by a few cents.
export function resample(src, step, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = cubicAt(src, i * step);
  return out;
}

export function renderSample(options = {}) {
  const { bank, dur = 1, sampleRate = 48000, gain = 0.3, attack = 0.06, release = 0.2, set = SAMPLE_SETS.oohs } = options;
  const midi = options.midi ?? (options.hz > 0 ? 69 + 12 * Math.log2(options.hz / 440) : NaN);
  if (!Number.isFinite(midi) || !(midi > 0)) throw new RangeError('renderSample: needs a positive finite midi or hz');
  if (!(dur > 0)) throw new RangeError(`renderSample: dur must be > 0, got ${dur}`);
  const pick = pickSample(bank, midi);
  if (!pick) return null;
  const src = pick.data, rate = bank.rate;
  const step = 2 ** ((midi - pick.key) / 12) * rate / sampleRate;   // source samples per output sample
  const n = Math.max(1, Math.round(dur * sampleRate));
  const out = new Float32Array(n);
  // Loop region in source samples; a short file (a test bank) loops over its middle half.
  let l0 = Math.round(set.loop[0] * rate), l1 = Math.min(Math.round(set.loop[1] * rate), src.length - 3);
  if (!(l1 - l0 > 0.1 * rate)) { l0 = Math.floor(src.length / 4); l1 = Math.floor(3 * src.length / 4); }
  const span = l1 - l0, xf = Math.min(Math.round(0.08 * rate), Math.floor(span / 3));
  let p = 0;
  for (let i = 0; i < n; i++) {
    if (p >= l1) p -= span;
    const into = p - (l1 - xf);
    if (into > 0) {
      // Equal-power crossfade into the loop start: the choir's takes are not phase-aligned,
      // so a plain jump would click and a linear fade would dip in loudness.
      const w = (into / xf) * Math.PI / 2;
      out[i] = Math.cos(w) * cubicAt(src, p) + Math.sin(w) * cubicAt(src, p - span);
    } else out[i] = cubicAt(src, p);
    p += step;
  }
  // Envelope first, so the onset's own transient (softened by the attack) is what the peak
  // limit sees. Then loudness: the steady part's RMS scaled to match 'voice', never past
  // `gain`. Output index i reads source time i x step / rate, so the steady window maps
  // through step.
  const na = Math.min(n, Math.round(attack * sampleRate)), nr = Math.min(n, Math.round(release * sampleRate));
  for (let i = 0; i < na; i++) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / na);
  for (let i = Math.max(0, n - nr); i < n; i++) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / nr);
  let a = Math.round(Math.min(set.steady[0] * rate / step, n * 0.25)), b = Math.round(Math.min(set.steady[1] * rate / step, n - nr));
  if (b - a < 16) { a = 0; b = n; }
  let sum = 0, peak = 0;
  for (let i = a; i < b; i++) sum += out[i] * out[i];
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const rms = Math.sqrt(sum / (b - a));
  const k = rms > 0 ? Math.min(RMS_OF_GAIN * gain / rms, Math.min(PEAK_OF_GAIN * gain, 0.99) / peak) : 0;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

export async function loadSampleBank({ urlFor, notes, decode, fetchFn = globalThis.fetch }) {
  const got = await Promise.allSettled(notes.map(async (midi) => {
    const res = await fetchFn(urlFor(midi));
    if (!res.ok) throw new Error(`${res.status}`);
    return { midi, ...(await decode(await res.arrayBuffer())) };
  }));
  const ok = got.filter((g) => g.status === 'fulfilled').map((g) => g.value);
  if (!ok.length) throw new Error('loadSampleBank: no sample loaded');
  const bank = { rate: ok[0].rate, notes: {} };
  // decode() resamples to one rate; a file at another rate would play out of tune, so drop it.
  for (const s of ok) if (s.rate === bank.rate) bank.notes[s.midi] = s.data;
  return bank;
}
