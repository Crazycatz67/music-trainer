// pitchcurve.js — from a vocal recording (ideally the separated vocal stem) to a Curve.
// Pure: no browser globals at import time, imports in Node. The one engine that needs a
// model (SwiftF0) is handed its onnxruntime session by the caller.
//
// Two steps, kept apart so each can be measured on its own:
//   1. an ENGINE reads raw pitch frames (the project's pitch frame shape)
//   2. POST-PROCESSING, the same for every engine: loudness per frame, a loudness gate,
//      octave-jump repair, gap bridging, and dropping voiced blips
//
// CONTRACT
//   trackMpm(signal, sampleRate, { hopSeconds = 0.01, detector?, tracker = false }) -> frame[]
//       The project's own detector (js/pitch.js) over the whole signal. `tracker` true or an
//       options object adds its live smoother; off by default because offline repair below
//       can look both ways in time and the live smoother turns octave glitches into holes.
//   resample(signal, fromRate, toRate) -> Float32Array     windowed-sinc, mono
//   SWIFTF0 = { sampleRate: 16000, hop: 256, fmin: 46.875, fmax: 2093.75, confidenceMin: 0.5 }
//   trackSwiftF0(signal16k, { ort, session, fmin = 62, fmax = 1100, confidenceMin = 0.5 })
//       -> Promise<frame[]>   one frame per 16 ms; t = frame number x 0.016 s
//       signal16k MUST be 16 kHz mono (use resample). ort is the onnxruntime-web module
//       (for its Tensor), session an InferenceSession on the SwiftF0 model.onnx.
//       Frames whose 16 ms of audio peak under 0.001 are unvoiced (the model answers
//       digital silence with random voiced frames; upstream does the same).
//   frameLevels(signal, sampleRate, times, { window = 0.03 }) -> number[]   RMS 0..1 around each time
//   POST_DEFAULTS, and the single steps, each returning how many frames it changed:
//     gateByLevel(a, { relDb = -30, absFloor = 0.002 })     voiced -> unvoiced under the floor,
//         which is relDb below the loud level (95th percentile of the voiced frames)
//     repairOctaves(a, { maxGlitch = 0.12, near = 0.1, tolerance = 1 })
//         a short voiced run sitting an octave, two octaves or an octave and a fifth from
//         what is sung right before AND after it is moved back; a real leap (the line stays
//         there) is never touched
//     bridgeGaps(a, { maxGap = 0.06, maxJump = 1.5, levelKeep = 0.3 })
//         an unvoiced hole no longer than maxGap between two close pitches is filled with a
//         straight line, unless the loudness in the hole drops under levelKeep of its edges
//         (then it is a real break between two notes)
//     dropBlips(a, { minVoiced = 0.05 })   voiced runs shorter than that become unvoiced
//     where a = { t[], midi[], level[], voiced[] } and is changed in place
//   buildCurve(frames, signal, sampleRate, options?) -> { curve, stats }
//       frames -> levels -> the four steps in the order above -> Curve (see curve.js).
//       options: any POST_DEFAULTS key, plus engine (a label kept on the curve), and
//       steps: { gate, octaves, bridge, blips } booleans to switch single steps off.
//       stats: { frames, voicedIn, voicedOut, gated, octaveFixed, bridged, blipsDropped }
//
// Every threshold here is a first guess tuned on the lab's synthetic song only.

import { analyse, windowFor } from '../../pitch.js';
import { hzToMidi } from '../../notes.js';
import { makeCurve } from './curve.js';

export const POST_DEFAULTS = Object.freeze({
  window: 0.03,
  relDb: -30, absFloor: 0.002,
  maxGlitch: 0.12, near: 0.1, tolerance: 1,
  maxGap: 0.06, maxJump: 1.5, levelKeep: 0.3,
  minVoiced: 0.05,
});

export const SWIFTF0 = Object.freeze({
  sampleRate: 16000, hop: 256, fmin: 46.875, fmax: 2093.75, confidenceMin: 0.5,
  // From upstream core.py: the model sees 11 frames back and 10 ahead, and long audio is
  // run in windows of 1875 frames (30 s) with that much context on each side.
  leftFrames: 11, lookaheadFrames: 10, windowFrames: 1875, silencePeak: 1e-3,
});

export function trackMpm(signal, sampleRate, { hopSeconds = 0.01, detector = {}, tracker = false } = {}) {
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  return analyse(signal, sampleRate, {
    hop, track: !!tracker,
    detector: { windowSize: windowFor(sampleRate), ...detector },
    tracker: tracker === true ? undefined : tracker || undefined,
  });
}

export function resample(signal, fromRate, toRate) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError(`resample: rates must be > 0, got ${fromRate} -> ${toRate}`);
  if (fromRate === toRate) return Float32Array.from(signal);
  const ratio = fromRate / toRate;
  // Going down, the cut-off must sit under the NEW Nyquist or everything above it folds
  // back into the voice range as false tones.
  const cutoff = Math.min(1, 1 / ratio) * 0.92;
  const half = Math.ceil(12 / cutoff);
  const n = Math.floor(signal.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const centre = i * ratio, first = Math.ceil(centre - half), last = Math.floor(centre + half);
    let sum = 0, norm = 0;
    for (let j = first; j <= last; j++) {
      const x = j - centre, a = Math.PI * x * cutoff;
      const w = (a === 0 ? 1 : Math.sin(a) / a) * (0.5 + 0.5 * Math.cos((Math.PI * x) / half));
      norm += w;
      if (j >= 0 && j < signal.length) sum += signal[j] * w;
    }
    out[i] = norm ? sum / norm : 0;
  }
  return out;
}

export async function trackSwiftF0(signal16k, { ort, session, fmin = 62, fmax = 1100, confidenceMin = SWIFTF0.confidenceMin } = {}) {
  if (!ort || !session) throw new TypeError('trackSwiftF0: needs { ort, session }');
  const S = SWIFTF0, n = Math.max(1, Math.floor(signal16k.length / S.hop));
  const lo = new ort.Tensor('float32', Float32Array.of(Math.max(S.fmin, fmin)), []);
  const hi = new ort.Tensor('float32', Float32Array.of(Math.min(S.fmax, fmax)), []);
  const frames = [];
  for (let start = 0; start < n; start += S.windowFrames) {
    const end = Math.min(start + S.windowFrames, n), left = Math.max(0, start - S.leftFrames);
    const slice = signal16k.subarray(left * S.hop, end < n ? (end + S.lookaheadFrames) * S.hop : signal16k.length);
    const audio = new ort.Tensor('float32', Float32Array.from(slice), [1, slice.length]);
    const out = await session.run({ audio, fmin: lo, fmax: hi });
    const pitch = out.pitch.data, confidence = out.confidence.data;
    for (let f = start; f < end && f - left < pitch.length; f++) {
      const k = f - left;
      let peak = 0;
      for (let s = f * S.hop, e = Math.min(signal16k.length, s + S.hop); s < e; s++) peak = Math.max(peak, Math.abs(signal16k[s]));
      const clarity = peak < S.silencePeak ? 0 : confidence[k];
      const hz = pitch[k], voiced = clarity >= confidenceMin && hz > 0 && Number.isFinite(hz);
      frames.push({ t: (f * S.hop) / S.sampleRate, hz: voiced ? hz : null, midi: voiced ? hzToMidi(hz) : null, clarity, voiced });
    }
  }
  return frames;
}

export function frameLevels(signal, sampleRate, times, { window = POST_DEFAULTS.window } = {}) {
  const half = Math.max(1, Math.round((window * sampleRate) / 2));
  // Running sum of squares: one pass over the audio however many frames are asked for.
  const sums = new Float64Array(signal.length + 1);
  for (let i = 0; i < signal.length; i++) sums[i + 1] = sums[i] + signal[i] * signal[i];
  return Array.from(times, (t) => {
    const c = Math.round(t * sampleRate);
    const a = Math.min(signal.length, Math.max(0, c - half)), b = Math.min(signal.length, Math.max(0, c + half));
    return b > a ? Math.sqrt((sums[b] - sums[a]) / (b - a)) : 0;
  });
}

const medianOf = (values) => {
  const s = [...values].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const hopOf = (t) => (t.length > 1 ? medianOf(t.slice(1, 400).map((v, i) => v - t[i])) : 0);

export function gateByLevel(a, { relDb = POST_DEFAULTS.relDb, absFloor = POST_DEFAULTS.absFloor } = {}) {
  const loudList = a.level.filter((_, i) => a.voiced[i]).sort((x, y) => x - y);
  if (!loudList.length) return 0;
  const loud = loudList[Math.min(loudList.length - 1, Math.floor(loudList.length * 0.95))];
  const floor = Math.max(absFloor, loud * 10 ** (relDb / 20));
  let changed = 0;
  for (let i = 0; i < a.t.length; i++) {
    if (a.voiced[i] && a.level[i] < floor) { a.voiced[i] = false; a.midi[i] = null; changed++; }
  }
  return changed;
}

// Voiced runs: neighbours in time (no hole) whose pitch moves less than `step` semitones
// from one frame to the next. A detector glitch is a run of its own.
function runsOf(a, hop, step = 3) {
  const runs = [];
  let run = null;
  for (let i = 0; i < a.t.length; i++) {
    if (!a.voiced[i]) { run = null; continue; }
    if (run && a.t[i] - a.t[run.last] <= hop * 1.5 && Math.abs(a.midi[i] - a.midi[run.last]) < step) run.last = i;
    else runs.push(run = { first: i, last: i });
  }
  return runs;
}

// What a detector confuses a note with: its 2nd, 3rd and 4th harmonic or sub-harmonic.
const GLITCH_STEPS = [12, 12 * Math.log2(3), 24];

export function repairOctaves(a, { maxGlitch = POST_DEFAULTS.maxGlitch, near = POST_DEFAULTS.near, tolerance = POST_DEFAULTS.tolerance } = {}) {
  const hop = hopOf(a.t), runs = runsOf(a, hop);
  const dur = (r) => a.t[r.last] - a.t[r.first] + hop;
  const edge = (r, atEnd) => {
    const idx = [];
    for (let k = 0; k < 3; k++) { const i = atEnd ? r.last - k : r.first + k; if (i >= r.first && i <= r.last) idx.push(a.midi[i]); }
    return medianOf(idx);
  };
  const glitchStep = (d) => {
    const step = GLITCH_STEPS.find((g) => Math.abs(Math.abs(d) - g) <= tolerance);
    return step ? Math.sign(d) * step : 0;
  };
  let changed = 0;
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    if (dur(r) > maxGlitch) continue;
    const before = k > 0 && a.t[r.first] - a.t[runs[k - 1].last] <= near + hop ? runs[k - 1] : null;
    const after = k + 1 < runs.length && a.t[runs[k + 1].first] - a.t[r.last] <= near + hop ? runs[k + 1] : null;
    if (!before && !after) continue;
    const own = medianOf(Array.from({ length: r.last - r.first + 1 }, (_, i) => a.midi[r.first + i]));
    const steps = [before && glitchStep(own - edge(before, true)), after && glitchStep(own - edge(after, false))].filter((s) => s !== null && s !== false);
    // Both sides must say "an octave off, the same way". With one side only (the start or
    // end of a phrase) that side must be clearly the longer one, or a short pickup note an
    // octave below the tune would be "repaired" into it.
    if (!steps.length || steps.some((s) => s === 0 || s !== steps[0])) continue;
    const longest = Math.max(before ? dur(before) : 0, after ? dur(after) : 0);
    if (longest < dur(r) * (steps.length === 2 ? 1 : 2)) continue;
    for (let i = r.first; i <= r.last; i++) { a.midi[i] -= steps[0]; changed++; }
  }
  return changed;
}

export function bridgeGaps(a, { maxGap = POST_DEFAULTS.maxGap, maxJump = POST_DEFAULTS.maxJump, levelKeep = POST_DEFAULTS.levelKeep } = {}) {
  const hop = hopOf(a.t);
  let changed = 0, last = -1;
  for (let i = 0; i < a.t.length; i++) {
    if (!a.voiced[i]) continue;
    if (last >= 0 && i - last > 1 && a.t[i] - a.t[last] <= maxGap + hop * 1.5 && Math.abs(a.midi[i] - a.midi[last]) <= maxJump) {
      let quietest = Infinity;
      for (let j = last + 1; j < i; j++) quietest = Math.min(quietest, a.level[j]);
      if (quietest >= levelKeep * Math.min(a.level[last], a.level[i])) {
        for (let j = last + 1; j < i; j++) {
          const k = (a.t[j] - a.t[last]) / (a.t[i] - a.t[last]);
          a.midi[j] = a.midi[last] + (a.midi[i] - a.midi[last]) * k;
          a.voiced[j] = true;
          changed++;
        }
      }
    }
    last = i;
  }
  return changed;
}

export function dropBlips(a, { minVoiced = POST_DEFAULTS.minVoiced } = {}) {
  const hop = hopOf(a.t);
  let changed = 0, first = -1;
  for (let i = 0; i <= a.t.length; i++) {
    const on = i < a.t.length && a.voiced[i] && (first < 0 || a.t[i] - a.t[i - 1] <= hop * 1.5);
    if (on) { if (first < 0) first = i; continue; }
    if (first >= 0 && a.t[i - 1] - a.t[first] + hop < minVoiced) {
      for (let j = first; j < i; j++) { a.voiced[j] = false; a.midi[j] = null; changed++; }
    }
    first = i < a.t.length && a.voiced[i] ? i : -1;
  }
  return changed;
}

export function buildCurve(frames, signal, sampleRate, options = {}) {
  const o = { ...POST_DEFAULTS, ...options }, steps = { gate: true, octaves: true, bridge: true, blips: true, ...options.steps };
  const t = frames.map((f) => f.t);
  const a = {
    t,
    midi: frames.map((f) => (f.voiced && Number.isFinite(f.midi) ? f.midi : null)),
    voiced: frames.map((f) => !!f.voiced && Number.isFinite(f.midi)),
    level: frameLevels(signal, sampleRate, t, o),
  };
  const stats = { frames: t.length, voicedIn: a.voiced.filter(Boolean).length, gated: 0, octaveFixed: 0, bridged: 0, blipsDropped: 0 };
  if (steps.gate) stats.gated = gateByLevel(a, o);
  if (steps.octaves) stats.octaveFixed = repairOctaves(a, o);
  if (steps.bridge) stats.bridged = bridgeGaps(a, o);
  if (steps.blips) stats.blipsDropped = dropBlips(a, o);
  stats.voicedOut = a.voiced.filter(Boolean).length;
  return { curve: makeCurve({ ...a, engine: options.engine }), stats };
}
