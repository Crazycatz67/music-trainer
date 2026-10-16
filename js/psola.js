// psola.js — "My voice" v3: the singer's own recorded "oo", moved to any reference pitch by
// TD-PSOLA (time-domain pitch-synchronous overlap-add).
//
// Why PSOLA and not plain resampling: resampling moves the vowel's resonances (formants) with
// the pitch, so four semitones up already sounds like a smaller person ("chipmunk"). PSOLA
// cuts the recording into one-period grains centred on its glottal peaks and lays them down
// closer together (higher) or further apart (lower). Each grain still carries the singer's own
// vocal-tract response, so the vowel colour stays where it was and only the pitch moves
// (Ricky's real-samples report, plan F; owner: "as accurate as possible and not robotic").
//
// What keeps it alive: the new grain spacing is the recording's own local period divided by
// one ratio, so the singer's wobble, vibrato and jitter are moved as a whole contour, never
// flattened to a steady pitch. Long notes walk back and forth over the (already steadiest)
// recording instead of jumping from its end to its start: consecutive grains are always
// neighbours in the recording, so there is no loop seam to hide.
//
// Pure: no browser globals, so the Node checks judge the very samples the singer hears.
//
// CONTRACT
//   MAX_SHIFT = 4            semitones a recording may be moved; further is refused (null),
//                            because PSOLA turns buzzy/hoarse past about ±4-6 (report (c)).
//   contourOf(data, rate) -> { hop, hz: Float64Array }  hz per hop of `hop` samples (frame
//                            centre at i*hop + window/2), 0 where js/pitch.js finds no pitch.
//   pitchMarks(data, rate, contour?) -> Int32Array of sample indices, one per glottal period,
//                            each on the period's strongest peak (the recording's dominant
//                            polarity). [] when nothing in it is voiced.
//   psolaShift(data, rate, marks, { ratio, n }) -> Float32Array of n samples at `rate`:
//                            pitch x ratio (contour kept), duration n (any length; the
//                            recording is walked back and forth). ratio in [0.5, 2].
//   renderRecorded(options) -> Float32Array mono at options.sampleRate, or null (no recording
//                            within maxShift: the caller falls back). Options:
//     recordings   [{ rate, hz, data: Float32Array }]  hz = the take's median pitch
//     midi | hz    target pitch (the take's median lands on it); dur = 1; sampleRate = 48000
//     gain = 0.3   loudness as js/samples.js renderSample (steady RMS = RMS_OF_GAIN x gain,
//                  peak never past PEAK_OF_GAIN x gain, 0.99 at most)
//     attack = 0.08, release = 0.25   raised-cosine fades: a soft sung onset and let-go
//     maxShift = MAX_SHIFT
//   nearestRecording(recordings, midi) -> { rec, semis } | null (semis = target - take)
//
// Failure behaviour: a bad pitch, dur <= 0 or ratio outside [0.5, 2] throws RangeError (as
// renderTone does); a recording too far away, empty or unvoiced gives null, never an exception.

import { analyse } from './pitch.js';
import { resample, RMS_OF_GAIN, PEAK_OF_GAIN } from './samples.js';

export const MAX_SHIFT = 4;
const HOP = 128;

const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);

export function contourOf(data, rate) {
  const frames = analyse(data, rate, { hop: HOP });
  return { hop: HOP, hz: Float64Array.from(frames, (f) => (f.voiced && f.hz > 0 ? f.hz : 0)) };
}

// The period (samples) around sample i, from the contour; unvoiced frames borrow the
// nearest voiced one so a breath in the middle does not break the chain of marks.
function periodFinder(contour, rate, windowSize = 2048) {
  const { hop, hz } = contour;
  const filled = Float64Array.from(hz);
  let last = 0;
  for (let i = 0; i < filled.length; i++) if (filled[i] > 0) last = filled[i]; else filled[i] = last;
  last = 0;
  for (let i = filled.length - 1; i >= 0; i--) if (filled[i] > 0) last = filled[i]; else filled[i] = last;
  return (i) => {
    const f = Math.min(filled.length - 1, Math.max(0, Math.round((i - windowSize / 2) / hop)));
    return filled[f] > 0 ? rate / filled[f] : 0;
  };
}

export function pitchMarks(data, rate, contour = contourOf(data, rate)) {
  const periodAt = periodFinder(contour, rate);
  if (!(periodAt(data.length >> 1) > 0)) return new Int32Array(0);
  // Glottal closures give each period one sharp extreme; in a given take it is consistently
  // either the top or the bottom, so the marks follow whichever is larger overall.
  let hi = 0, lo = 0;
  for (let i = 0; i < data.length; i++) { if (data[i] > hi) hi = data[i]; if (data[i] < lo) lo = data[i]; }
  const s = hi >= -lo ? 1 : -1;
  const marks = [];
  let p = periodAt(0), best = -1;
  for (let i = 0; i < Math.min(data.length, Math.ceil(p)); i++) if (best < 0 || s * data[i] > s * data[best]) best = i;
  let m = best;
  while (m >= 0 && m < data.length) {
    marks.push(m);
    p = periodAt(m);
    const guess = m + p, half = 0.2 * p;
    const a = Math.ceil(guess - half), b = Math.floor(guess + half);
    if (b >= data.length) break;
    // The strongest peak near one period on, gently pulled toward the expected spot so a
    // strong second harmonic cannot drag a mark half a period away.
    let pick = -1, score = -Infinity;
    for (let j = a; j <= b; j++) {
      const d = (j - guess) / half;
      const v = s * data[j] - 0.3 * Math.abs(hi - lo) * d * d;
      if (v > score) { score = v; pick = j; }
    }
    m = pick;
  }
  return Int32Array.from(marks);
}

// Linear read; grains land at fractional positions so the new spacing carries no rounding
// jitter (half a sample at 24 kHz would be 0.4 % of a 200 Hz period).
const at = (d, p) => { const i = Math.floor(p), f = p - i; return i < 0 || i + 1 >= d.length ? 0 : d[i] + f * (d[i + 1] - d[i]); };

export function psolaShift(data, rate, marks, { ratio, n }) {
  if (!(ratio >= 0.5 && ratio <= 2)) throw new RangeError(`psolaShift: ratio must be in [0.5, 2], got ${ratio}`);
  const out = new Float32Array(n);
  if (marks.length < 4 || n <= 0) return out;
  const lo = 1, hi = marks.length - 2;          // marks with a neighbour on both sides
  let k = lo, dir = 1;
  let ts = 0;                                   // synthesis mark (output samples, fractional)
  let ta = marks[lo];                           // analysis time it stands for
  while (ts < n + (marks[k + 1] - marks[k])) {
    // The analysis mark nearest the analysis time, stepping only to neighbours: the walk
    // turns round at either end instead of jumping, so there is no loop seam.
    while (dir > 0 && k < hi && Math.abs(marks[k + 1] - ta) < Math.abs(marks[k] - ta)) k++;
    while (dir < 0 && k > lo && Math.abs(marks[k - 1] - ta) < Math.abs(marks[k] - ta)) k--;
    const m = marks[k], L = m - marks[k - 1], R = marks[k + 1] - m;
    // Matched (asymmetric) Hann halves: each reaches zero exactly at the neighbouring mark,
    // so adjacent grains cross-fade over one whole period with no step.
    const base = Math.floor(ts), frac = ts - base;
    for (let j = -L + 1; j < R; j++) {
      const o = base + j;
      if (o < 0 || o >= n) continue;
      const q = j - frac;                       // grain time relative to its mark
      if (q <= -L || q >= R) continue;
      const w = q < 0 ? 0.5 + 0.5 * Math.cos(Math.PI * q / L) : 0.5 + 0.5 * Math.cos(Math.PI * q / R);
      out[o] += w * at(data, m + q);
    }
    const step = (dir > 0 ? R : L) / ratio;     // the recording's own local period, moved
    ts += step;
    ta += dir * step;
    if (ta >= marks[hi]) { ta = 2 * marks[hi] - ta; dir = -1; }
    else if (ta <= marks[lo]) { ta = 2 * marks[lo] - ta; dir = 1; }
  }
  return out;
}

export function nearestRecording(recordings, midi) {
  let best = null;
  for (const rec of recordings || []) {
    if (!rec || !(rec.hz > 0) || !rec.data || !rec.data.length || !(rec.rate > 0)) continue;
    const semis = midi - midiOf(rec.hz);
    if (!best || Math.abs(semis) < Math.abs(best.semis)) best = { rec, semis };
  }
  return best;
}

const markCache = new WeakMap();   // keyed by the recording's samples: found once per take

export function renderRecorded(options = {}) {
  const { recordings, dur = 1, sampleRate = 48000, gain = 0.3, attack = 0.08, release = 0.25, maxShift = MAX_SHIFT } = options;
  const midi = options.midi ?? (options.hz > 0 ? midiOf(options.hz) : NaN);
  if (!Number.isFinite(midi) || !(midi > 0)) throw new RangeError('renderRecorded: needs a positive finite midi or hz');
  if (!(dur > 0)) throw new RangeError(`renderRecorded: dur must be > 0, got ${dur}`);
  const near = nearestRecording(recordings, midi);
  if (!near || Math.abs(near.semis) > maxShift) return null;
  const { rec } = near;
  let marks = markCache.get(rec.data);
  if (!marks) { marks = pitchMarks(rec.data, rec.rate); markCache.set(rec.data, marks); }
  if (marks.length < 4) return null;
  const n = Math.max(1, Math.round(dur * sampleRate));
  const step = rec.rate / sampleRate;
  const shifted = psolaShift(rec.data, rec.rate, marks, { ratio: 2 ** (near.semis / 12), n: Math.ceil(n * step) + 4 });
  const out = step === 1 ? shifted.subarray(0, n) : resample(shifted, step, n);
  const na = Math.min(n, Math.round(attack * sampleRate)), nr = Math.min(n, Math.round(release * sampleRate));
  for (let i = 0; i < na; i++) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / na);
  for (let i = Math.max(0, n - nr); i < n; i++) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / nr);
  // Loudness as renderSample: the steady middle matched to 'voice', the peak capped.
  let a = na, b = n - nr;
  if (b - a < 16) { a = 0; b = n; }
  let sum = 0, peak = 0;
  for (let i = a; i < b; i++) sum += out[i] * out[i];
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const rms = Math.sqrt(sum / (b - a));
  const k = rms > 0 ? Math.min(RMS_OF_GAIN * gain / rms, Math.min(PEAK_OF_GAIN * gain, 0.99) / peak) : 0;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}
