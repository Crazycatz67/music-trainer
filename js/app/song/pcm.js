// pcm.js — raw sound as numbers: 16-bit packing, WAV files, joining chunks. Pure (Node and
// browser); used by the recorder, the take store and the mixer.
//
// CONTRACT
//   toInt16(float32) -> Int16Array        -1..1 -> -32767..32767, clipped, rounded
//   toFloat32(int16) -> Float32Array      the way back (error under 1/32767 per sample)
//   joinChunks(chunks) -> { samples: Float32Array, gaps }
//       chunks = [{ frame, samples }] in arrival order, `frame` = the audio context's frame
//       number of the chunk's first sample. A hole between two chunks (the audio thread
//       skipped) is filled with silence, so sample i is always frame chunks[0].frame + i and
//       the take stays lined up after a glitch. gaps = how many holes were filled. A chunk
//       that overlaps what is already there is cut to its new part.
//   encodeWav(channels, sampleRate) -> ArrayBuffer    16-bit PCM, 1 or 2 channels
//       channels = [Float32Array, ...] of equal length. Throws RangeError for 0 or > 2
//       channels, unequal lengths, or a sample rate that is not a positive whole number.
//   parseWav(arrayBuffer) -> { sampleRate, channels: [Float32Array, ...] }
//       reads what encodeWav writes (16-bit PCM). Throws RangeError for anything else.
//   peakOf(samples) -> number             largest absolute sample
//   rmsOf(samples, from = 0, to = length) -> number

export function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i];
    // NaN (a broken sample) becomes silence rather than a full-scale click.
    out[i] = v >= 1 ? 32767 : v <= -1 ? -32767 : Number.isFinite(v) ? Math.round(v * 32767) : 0;
  }
  return out;
}

export function toFloat32(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32767;
  return out;
}

export function joinChunks(chunks) {
  if (!chunks.length) return { samples: new Float32Array(0), gaps: 0 };
  const first = chunks[0].frame;
  let end = first, gaps = 0;
  for (const c of chunks) {
    if (c.frame > end) gaps++;
    end = Math.max(end, c.frame + c.samples.length);
  }
  const samples = new Float32Array(end - first);
  let at = first;
  for (const c of chunks) {
    const skip = Math.max(0, at - c.frame);
    if (skip < c.samples.length) samples.set(skip ? c.samples.subarray(skip) : c.samples, Math.max(at, c.frame) - first);
    at = Math.max(at, c.frame + c.samples.length);
  }
  return { samples, gaps };
}

export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) throw new RangeError('encodeWav: 1 or 2 channels');
  const n = channels[0].length;
  if (channels.some((c) => c.length !== n)) throw new RangeError('encodeWav: channels differ in length');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`encodeWav: bad sample rate ${sampleRate}`);
  const ch = channels.length, bytes = n * ch * 2;
  const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, bytes, true);
  const packed = channels.map(toInt16);
  let at = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { v.setInt16(at, packed[c][i], true); at += 2; }
  return buf;
}

export function parseWav(buf) {
  const v = new DataView(buf);
  const text = (at) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
  if (buf.byteLength < 44 || text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new RangeError('parseWav: not a WAV file');
  let at = 12, fmt = null;
  while (at + 8 <= buf.byteLength) {
    const id = text(at), size = v.getUint32(at + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(at + 8, true), ch: v.getUint16(at + 10, true), sampleRate: v.getUint32(at + 12, true), bits: v.getUint16(at + 22, true) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.ch < 1) throw new RangeError('parseWav: only 16-bit PCM is read');
      const n = Math.floor(Math.min(size, buf.byteLength - at - 8) / (2 * fmt.ch));
      const channels = Array.from({ length: fmt.ch }, () => new Float32Array(n));
      let p = at + 8;
      for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) { channels[c][i] = v.getInt16(p, true) / 32767; p += 2; }
      return { sampleRate: fmt.sampleRate, channels };
    }
    at += 8 + size + (size % 2);
  }
  throw new RangeError('parseWav: no sound data in the file');
}

export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  return peak;
}

export function rmsOf(samples, from = 0, to = samples.length) {
  const a = Math.max(0, from), b = Math.min(samples.length, to);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}
