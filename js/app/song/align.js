// align.js — lining the singer's take up with the backing. Pure (Node and browser).
//
// THE PROBLEM. The player schedules song time s at context time T. The singer hears it
// `output delay` later, sings with what they hear, and the sound reaches the recorder
// `input delay` after that. So a sample the recorder stamped with raw song time s was really
// sung to song time s - (output delay + input delay). The take's `songStart` is on the raw
// scale (js/app/song/recorder.js); this file moves it.
//
//   where the take belongs = songStart - delay + nudge
//
// THE DELAY comes from, in order of trust:
//   1. a calibration the owner did (below), in milliseconds;
//   2. what the browser reports: AudioContext.outputLatency and the microphone track's
//      `latency` setting. Either may be missing (then it counts as 0 and `source` says so),
//      and neither knows about Bluetooth headphones properly;
//   3. nothing: delay 0.
// THE NUDGE is the owner's own correction in milliseconds on top (positive = the voice plays
// later), kept with the take.
//
// CALIBRATION METHOD (for a later screen): "clap along". The player plays a short click
// track (clickPlan, renderClicks) in the headphones; the owner claps, or says a short "ta",
// on every click; the recorder records it like a take. detectOnsets finds the claps,
// calibrate pairs each with its click and takes the MEDIAN gap. That gap is the round-trip
// delay as the singer experiences it, headphones and Bluetooth included.
//   - It also contains the person's own habit: people clap a little early (commonly 20 to
//     50 ms) to a steady click. So the result is a starting point and the nudge stays.
//   - A loopback beep (play a beep, hear it through the microphone) would be exact, but it
//     only works when the microphone can hear the speakers, that is WITHOUT headphones, and
//     song mode needs headphones. estimateLag below can measure it; nothing relies on it.
//
// CONTRACT
//   clampNudge(ms, cfg?) -> ms                    to the range and whole steps of config
//   reportedDelay(latency) -> { seconds, input, output }     input/output: true when the
//       browser gave that number. latency = take.latency ({ input, output } seconds or null).
//   takeOffset(take, { calibrationMs = null, nudgeMs = take.nudgeMs }) ->
//       { at, delaySec, nudgeMs, source: 'calibrated' | 'reported' | 'partly-reported' | 'none' }
//       at = the song time (seconds) the take's first sample belongs to; null when
//       take.songStart is null.
//   alignFrames(frames, take, opts) -> frames with t moved the same way
//   clickPlan(cfg?) -> { times: [seconds], duration }
//   renderClicks(times, { sampleRate, duration, hz, lenSec, gain }) -> Float32Array
//   detectOnsets(samples, sampleRate, cfg?) -> [seconds]      sudden rises in loudness
//   calibrate(clickTimes, onsetTimes, cfg?) ->
//       { ok, delayMs, spreadMs, used, of, reason: null | 'too-few' | 'scattered' }
//       clickTimes and onsetTimes on the same raw song scale (onset = take.songStart + its
//       time in the take). delayMs is the median; spreadMs the median distance from it.
//   estimateLag(reference, signal, sampleRate, { minLagMs = -500, maxLagMs = 500 }) ->
//       { lagSec, score }    signal(t + lagSec) is most like reference(t). score 0..1
//       (1 = the same sound). Found on the loudness outline first, then to the sample.

import { SONG } from './config.js';

const A = SONG.align;

export function clampNudge(ms, cfg = A.nudge) {
  const v = Number.isFinite(ms) ? ms : 0;
  return Math.min(cfg.max, Math.max(cfg.min, Math.round(v / cfg.step) * cfg.step));
}

export function reportedDelay(latency) {
  const l = latency || {};
  const input = Number.isFinite(l.input) && l.input >= 0, output = Number.isFinite(l.output) && l.output >= 0;
  return { seconds: (input ? l.input : 0) + (output ? l.output : 0), input, output };
}

export function takeOffset(take, { calibrationMs = null, nudgeMs = take.nudgeMs } = {}) {
  const nudge = Number.isFinite(nudgeMs) ? nudgeMs : 0;
  let delaySec, source;
  if (Number.isFinite(calibrationMs)) { delaySec = calibrationMs / 1000; source = 'calibrated'; }
  else {
    const r = reportedDelay(take.latency);
    delaySec = r.seconds;
    source = r.input && r.output ? 'reported' : r.input || r.output ? 'partly-reported' : 'none';
  }
  return {
    at: Number.isFinite(take.songStart) ? take.songStart - delaySec + nudge / 1000 : null,
    delaySec, nudgeMs: nudge, source,
  };
}

export function alignFrames(frames, take, opts) {
  const o = takeOffset(take, opts);
  const shift = -o.delaySec + o.nudgeMs / 1000;
  return (frames || []).map((f) => ({ ...f, t: f.t + shift }));
}

// ---------------------------------------------------------------- calibration

export function clickPlan(cfg = A.clicks) {
  const gap = 60 / cfg.bpm;
  const times = Array.from({ length: cfg.count }, (_, i) => cfg.leadSec + i * gap);
  return { times, duration: times[times.length - 1] + gap };
}

export function renderClicks(times, { sampleRate = 48000, duration, hz = A.clicks.hz, lenSec = A.clicks.lenSec, gain = A.clicks.gain } = {}) {
  const total = Math.round((duration ?? (times[times.length - 1] + 1)) * sampleRate);
  const out = new Float32Array(total);
  const n = Math.round(lenSec * sampleRate);
  for (const t of times) {
    const first = Math.round(t * sampleRate);
    for (let i = 0; i < n && first + i < total; i++) {
      // A sharp start and a fast fade: easy to clap to, and its start is one clear sample.
      out[first + i] += gain * Math.sin(2 * Math.PI * hz * i / sampleRate) * Math.exp(-6 * i / n);
    }
  }
  return out;
}

export function detectOnsets(samples, sampleRate, cfg = A) {
  const hop = Math.max(1, Math.round(sampleRate / 1000));          // 1 ms
  const n = Math.floor(samples.length / hop);
  if (n < 40) return [];
  const env = new Float32Array(n);
  let top = 0;
  for (let k = 0; k < n; k++) {
    let peak = 0;
    for (let i = k * hop, e = i + hop; i < e; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    env[k] = peak;
    if (peak > top) top = peak;
  }
  if (!(top > 0)) return [];
  const floor = cfg.onsetFloor * top, out = [];
  let k = 0;
  while (k < n) {
    if (env[k] >= floor) {
      // The level just before: 30 to 5 ms back.
      let before = 0, count = 0;
      for (let j = Math.max(0, k - 30); j < k - 4; j++) { before += env[j]; count++; }
      before = count ? before / count : 0;
      if (env[k] >= cfg.onsetRise * before) {
        // To the sample: the first one, a little back from here, that reaches a quarter of
        // what the next 10 ms reach.
        let local = 0;
        for (let i = k * hop, e = Math.min(samples.length, i + 10 * hop); i < e; i++) { const a = Math.abs(samples[i]); if (a > local) local = a; }
        let at = k * hop;
        for (let i = Math.max(0, (k - 3) * hop); i < (k + 1) * hop; i++) { if (Math.abs(samples[i]) >= 0.25 * local) { at = i; break; } }
        out.push(at / sampleRate);
        k += Math.max(1, Math.round(cfg.onsetGapMs));
        continue;
      }
    }
    k++;
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function calibrate(clickTimes, onsetTimes, cfg = A) {
  const gaps = [];
  for (const c of clickTimes) {
    // The clap nearest this click inside the window; a clap is used once.
    let best = null;
    for (const o of onsetTimes) {
      const d = (o - c) * 1000;
      if (d < -cfg.pairBeforeMs || d > cfg.pairAfterMs) continue;
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
    if (best !== null) gaps.push(best);
  }
  const base = { used: gaps.length, of: clickTimes.length };
  if (gaps.length < cfg.minClaps) return { ok: false, delayMs: null, spreadMs: null, ...base, reason: 'too-few' };
  const mid = median(gaps), spread = median(gaps.map((g) => Math.abs(g - mid)));
  if (spread > cfg.maxSpreadMs) return { ok: false, delayMs: mid, spreadMs: spread, ...base, reason: 'scattered' };
  return { ok: true, delayMs: mid, spreadMs: spread, ...base, reason: null };
}

export const CALIBRATE_WORDS = Object.freeze({
  'too-few': 'Not enough claps were heard. Clap once on every click, close to the microphone.',
  scattered: 'The claps were too uneven to measure from. Try again, clapping right on each click.',
});

// ---------------------------------------------------------------- measuring a lag

// Normalised likeness of signal (moved back by `lag` samples) and reference, on their overlap.
function likeness(ref, sig, lag, step = 1) {
  const from = Math.max(0, -lag), to = Math.min(ref.length, sig.length - lag);
  let ab = 0, aa = 0, bb = 0;
  for (let i = from; i < to; i += step) { const a = ref[i], b = sig[i + lag]; ab += a * b; aa += a * a; bb += b * b; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

export function estimateLag(reference, signal, sampleRate, { minLagMs = -500, maxLagMs = 500 } = {}) {
  // 1. The loudness outline in 4 ms blocks: cheap, and blind to which cycle of a note it is.
  const block = Math.max(1, Math.round(sampleRate * 0.004));
  const outline = (x) => {
    const n = Math.floor(x.length / block), env = new Float32Array(n);
    let mean = 0;
    for (let k = 0; k < n; k++) { let s = 0; for (let i = k * block, e = i + block; i < e; i++) s += Math.abs(x[i]); env[k] = s / block; mean += env[k]; }
    mean /= n || 1;
    for (let k = 0; k < n; k++) env[k] -= mean;
    return env;
  };
  const er = outline(reference), es = outline(signal);
  const lo = Math.floor(minLagMs / 1000 * sampleRate / block), hi = Math.ceil(maxLagMs / 1000 * sampleRate / block);
  let coarse = 0, bestC = -Infinity;
  for (let lag = lo; lag <= hi; lag++) { const s = likeness(er, es, lag); if (s > bestC) { bestC = s; coarse = lag; } }
  // 2. To the sample, on the sound itself, two blocks either side of that.
  let best = coarse * block, bestS = -Infinity;
  for (let lag = (coarse - 2) * block; lag <= (coarse + 2) * block; lag++) { const s = likeness(reference, signal, lag); if (s > bestS) { bestS = s; best = lag; } }
  return { lagSec: best / sampleRate, score: Math.max(0, bestS) };
}
