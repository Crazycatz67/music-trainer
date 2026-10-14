// pitch.js — pitch detection for a singing voice. Pure: no browser globals, imports in Node.
//
// Method: McLeod pitch method (MPM). The FFT autocorrelation comes from the vendored
// pitchy 4.1.0; the peak picking is done here (ported from pitchy, MIT) so the search can
// be limited to periods a voice can have. On top: a loudness gate, a clarity gate, voice
// range limits, and a small tracker that smooths the line and refuses octave glitches.
//
// CONTRACT
//   Pitch frame (project-wide): { t, hz, midi, clarity, voiced }
//     t        seconds, whatever clock the caller passes in (mic.js and analyse() pass the
//              time of the CENTRE of the analysed window)
//     hz, midi the pitch (midi float, 69 = A4); BOTH null when voiced is false
//     clarity  0..1, MPM's confidence (the height of the chosen peak); kept on unvoiced
//              frames too, so a caller can show "nearly" without being given a pitch
//     voiced   false = no trustworthy pitch. A pitch is never invented for such a frame.
//
//   createDetector({ windowSize = 2048, clarityMin = 0.85, minHz = 62, maxHz = 1100,
//                    minRms = 0.003, peakThreshold = 0.9 }) -> detector
//     detector.windowSize
//     detector.detect(samples, sampleRate, t = 0) -> frame
//         samples: Float32Array (any numeric array works) of EXACTLY windowSize samples in
//         -1..1; any other length throws RangeError (a caller bug, not a signal problem).
//         Unvoiced when: RMS below minRms (silence), any sample not finite, clarity below
//         clarityMin (noise, breath), or pitch outside minHz..maxHz. A constant offset in
//         the samples is removed first and does not count as loudness.
//         Also unvoiced: a note whose period is longer than HALF the window (below
//         2 x sampleRate / windowSize Hz: 47 Hz at 48 kHz, 94 Hz at 96 kHz with 2048).
//         windowFor(sampleRate) gives a window long enough for the whole voice range.
//     detector.lastRms   RMS of the last window (0..1, offset removed), for a level meter. Not in the frame
//                        because the frame shape is a project contract.
//
//   createTracker({ medianSize = 3, octaveTolerance = 1, jumpConfirm = 4, gapReset = 0.15 })
//       -> tracker
//     tracker.push(frame) -> frame   (a new object; the input is not changed)
//         Voiced output = median of the last medianSize accepted readings (so its pitch
//         lags the input by (medianSize - 1) / 2 frames).
//         A reading about 1, 1.58 or 2 octaves (12 / 19 / 24 semitones, each within
//         octaveTolerance) away from the current line is treated as a detector glitch: it
//         comes back UNVOICED, not corrected. If jumpConfirm such readings in a row agree
//         with each other, it was a real leap: the line moves there and is voiced again.
//         Unvoiced in -> unvoiced out. After gapReset seconds without a voiced reading the
//         history is dropped, so a new note is never judged against the previous one.
//     tracker.reset()
//
//   analyse(signal, sampleRate, { hop = 512, track = true, detector?, tracker? }) -> frame[]
//     Offline helper (labs, checks, after-the-take analysis): slides the window over a whole
//     signal. detector / tracker are option objects for the two factories above.
//
// The defaults for clarityMin and minRms are tuned on synthesised signals only (see
// labs/pitch-lab.html); they still need calibrating on a real voice and the owner's mic.

import { Autocorrelator } from '../vendor/pitchy-4.1.0/pitchy.js';
import { hzToMidi } from './notes.js';

export const DETECTOR_DEFAULTS = Object.freeze({
  windowSize: 2048,
  clarityMin: 0.85,
  // "About 65 Hz" in the plan is C2 (65.4 Hz). The floor sits half a semitone lower so a
  // C2 sung a little flat still reads instead of vanishing at the edge.
  minHz: 62,
  maxHz: 1100,
  minRms: 0.003,
  // MPM's constant k: how close to the highest peak the first acceptable peak must be.
  peakThreshold: 0.9,
});

export const TRACKER_DEFAULTS = Object.freeze({
  medianSize: 3,
  octaveTolerance: 1,
  jumpConfirm: 4,
  gapReset: 0.15,
});

// The smallest power-of-two window (never under the default) that holds two periods of
// minHz at this sample rate with a little room: 2048 up to 48 kHz, 4096 at 88.2 and 96 kHz,
// 8192 at 192 kHz. A power of two because the AnalyserNode in mic.js needs one.
export function windowFor(sampleRate, minHz = DETECTOR_DEFAULTS.minHz) {
  let size = DETECTOR_DEFAULTS.windowSize;
  if (!(sampleRate > 0) || !(minHz > 0)) return size;
  while (size < 32768 && size / 2 < sampleRate / minHz + 3) size *= 2;
  return size;
}

const unvoiced = (t, clarity) => ({ t, hz: null, midi: null, clarity, voiced: false });

export function createDetector(options = {}) {
  const o = { ...DETECTOR_DEFAULTS, ...options };
  const keys = new Int32Array(o.windowSize);
  const correlator = Autocorrelator.forFloat32Array(o.windowSize);
  const nsdf = new Float32Array(o.windowSize);
  const centred = new Float32Array(o.windowSize);

  // MPM peak picking (McLeod & Wyvill, "A Smarter Way to Find Pitch"), after pitchy's
  // findPitch but searching only lags up to the longest period a voice can have. Why not
  // call pitchy's findPitch: it searches every lag up to the window length, and out there
  // the NSDF is estimated from a handful of samples and swings to nearly 1 on pure noise
  // (measured: 0.99 at lag ~2045 for white noise). That fake peak becomes "the highest
  // peak", so a real but slightly noisy note below 90% of it is passed over and lost.
  // Returns { lag (samples, fractional), height (NSDF value at the peak) } or null.
  function findPeak(samples, sampleRate) {
    // +2: one lag past the longest period so its peak can be seen as a peak and refined.
    // Never past half the window: beyond that the two halves being compared no longer
    // cover the middle of the window, so a click or a clipped wave there drops out of the
    // sum and the NSDF swings to 1.0 on nothing (measured: a 7-a-second click train read
    // as C#2 at clarity 1.0 at 96 kHz, and 65 Hz read as F#2 at 192 kHz). A note whose
    // period is longer than half the window is therefore unvoiced, not guessed; the
    // caller should use a longer window at a high sample rate (mic.js does).
    const maxLag = Math.min(Math.floor(o.windowSize / 2), Math.ceil(sampleRate / o.minHz) + 2);
    correlator.autocorrelate(samples, nsdf);
    // m'(tau) from the paper, updated step by step (same recurrence as pitchy's _nsdf).
    let m = 2 * nsdf[0];
    let tau = 0;
    for (; tau <= maxLag && m > 0; tau++) {
      nsdf[tau] = (2 * nsdf[tau]) / m;
      m -= samples[tau] * samples[tau] + samples[o.windowSize - tau - 1] * samples[o.windowSize - tau - 1];
    }
    for (; tau <= maxLag; tau++) nsdf[tau] = 0;

    // Key maxima: the highest point between each upward and the next downward zero crossing.
    let nKeys = 0, top = -Infinity, searching = false, best = -1;
    for (let i = 1; i < maxLag; i++) {
      if (nsdf[i - 1] <= 0 && nsdf[i] > 0) { searching = true; best = i; }
      else if (nsdf[i - 1] > 0 && nsdf[i] <= 0) {
        if (searching) { keys[nKeys++] = best; top = Math.max(top, nsdf[best]); }
        searching = false;
      } else if (searching && nsdf[i] > nsdf[best]) best = i;
    }
    // A lobe still open at the end of the range counts only if it has already turned
    // down: otherwise its top lies beyond the range and is not ours to report.
    if (searching && best < maxLag - 1) { keys[nKeys++] = best; top = Math.max(top, nsdf[best]); }
    if (!nKeys) return null;

    // The FIRST key maximum close to the highest one: later ones are the same note at
    // two, three... periods, and picking those is how a reading drops an octave.
    let pick = keys[0];
    for (let k = 0; k < nKeys; k++) { if (nsdf[keys[k]] >= o.peakThreshold * top) { pick = keys[k]; break; } }

    // Parabola through the peak and its neighbours: sub-sample lag, which is what gets a
    // high note (a period of only ~45 samples) within a few cents.
    const y0 = nsdf[pick - 1], y1 = nsdf[pick], y2 = nsdf[pick + 1];
    const curve = y0 - 2 * y1 + y2;
    const shift = curve < 0 ? (0.5 * (y0 - y2)) / curve : 0;
    return { lag: pick + shift, height: y1 - 0.25 * (y0 - y2) * shift };
  }

  const detector = {
    windowSize: o.windowSize,
    lastRms: 0,
    detect(samples, sampleRate, t = 0) {
      if (!samples || samples.length !== o.windowSize) {
        throw new RangeError(`pitch.detect: need ${o.windowSize} samples, got ${samples ? samples.length : samples}`);
      }
      // Take the average out first. A microphone with a constant offset never crosses
      // zero, MPM then finds no peak at all, and a clearly sung note reads as silence
      // (measured: a 0.2 offset turned a clean A3 into an unvoiced frame).
      let mean = 0;
      for (let i = 0; i < samples.length; i++) mean += samples[i];
      mean /= samples.length;
      let sum = 0;
      for (let i = 0; i < samples.length; i++) { const v = samples[i] - mean; centred[i] = v; sum += v * v; }
      const rms = Math.sqrt(sum / samples.length);
      // A NaN or Infinity anywhere makes the sum non-finite; such a window (a glitching
      // device, a bad buffer) must not reach the FFT and come back as a pitch.
      if (!Number.isFinite(rms)) { detector.lastRms = 0; return unvoiced(t, 0); }
      detector.lastRms = rms;
      // Loudness is gated here, not with pitchy's minVolumeDecibels: that setter converts
      // dB with 10^(dB/10), which is not an amplitude ratio, so its numbers mislead.
      if (rms < o.minRms) return unvoiced(t, 0);

      const peak = findPeak(centred, sampleRate);
      if (!peak) return unvoiced(t, 0);
      const hz = sampleRate / peak.lag;
      const clarity = Math.min(1, Math.max(0, peak.height));
      if (!Number.isFinite(hz) || hz < o.minHz || hz > o.maxHz || clarity < o.clarityMin) {
        return unvoiced(t, clarity);
      }
      return { t, hz, midi: hzToMidi(hz), clarity, voiced: true };
    },
  };
  return detector;
}

// Median of the most recent ODD number of values: with an even count the two middle values
// would have to be averaged, and half-way between two notes is a pitch nobody sang.
function recentMedian(values) {
  const n = values.length % 2 ? values.length : values.length - 1;
  const sorted = values.slice(values.length - n).sort((a, b) => a - b);
  return sorted[(n - 1) / 2];
}

// MPM's typical mistakes land on a harmonic or sub-harmonic of the true note: x2 or /2
// (12 semitones), x3 or /3 (19.02), x4 or /4 (24).
const GLITCH_INTERVALS = [12, 12 * Math.log2(3), 24];

export function createTracker(options = {}) {
  const o = { ...TRACKER_DEFAULTS, ...options };
  let history = [];   // accepted midi readings, newest last, at most medianSize
  let pending = [];   // suspected-glitch readings waiting to be confirmed as a real leap
  let lastVoicedT = null;

  const isGlitchInterval = (semitones) => {
    const d = Math.abs(semitones);
    return GLITCH_INTERVALS.some((g) => Math.abs(d - g) <= o.octaveTolerance);
  };
  const voicedAt = (frame, midi) => ({
    t: frame.t, hz: 440 * 2 ** ((midi - 69) / 12), midi, clarity: frame.clarity, voiced: true,
  });

  return {
    reset() { history = []; pending = []; lastVoicedT = null; },
    push(frame) {
      if (!frame.voiced || !Number.isFinite(frame.midi)) {
        if (lastVoicedT !== null && frame.t - lastVoicedT > o.gapReset) { history = []; pending = []; }
        return unvoiced(frame.t, frame.clarity);
      }
      // Also catches a caller that skipped the unvoiced frames between two notes.
      if (lastVoicedT !== null && frame.t - lastVoicedT > o.gapReset) { history = []; pending = []; }
      lastVoicedT = frame.t;

      if (history.length && isGlitchInterval(frame.midi - recentMedian(history))) {
        // Readings that disagree with each other are separate glitches, not one leap.
        if (pending.length && Math.abs(frame.midi - recentMedian(pending)) > o.octaveTolerance) pending = [];
        pending.push(frame.midi);
        if (pending.length < o.jumpConfirm) return unvoiced(frame.t, frame.clarity);
        history = pending.slice(-o.medianSize);
        pending = [];
        return voicedAt(frame, recentMedian(history));
      }

      pending = [];
      history.push(frame.midi);
      if (history.length > o.medianSize) history.shift();
      return voicedAt(frame, recentMedian(history));
    },
  };
}

export function analyse(signal, sampleRate, { hop = 512, track = true, detector, tracker } = {}) {
  if (!(hop >= 1)) throw new RangeError(`pitch.analyse: hop must be >= 1, got ${hop}`);
  const det = createDetector(detector);
  const trk = track ? createTracker(tracker) : null;
  const size = det.windowSize;
  const frames = [];
  for (let start = 0; start + size <= signal.length; start += hop) {
    const raw = det.detect(signal.subarray(start, start + size), sampleRate, (start + size / 2) / sampleRate);
    frames.push(trk ? trk.push(raw) : raw);
  }
  return frames;
}
