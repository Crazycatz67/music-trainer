// synth.js — reference tones for the singer to match: plain, voice-like, and glides.
//
// Tones are rendered to a sample buffer first and then played, instead of being built from
// live OscillatorNodes. Why: the exact samples the singer hears are the samples the pitch
// lab and the Node checks feed to the detector, so "the reference is in tune and readable"
// is tested, not assumed. The rendering half touches no browser global and imports in Node;
// only createSynth() needs an AudioContext.
//
// CONTRACT
//   Tone options (shared by renderTone, pitchAt and synth.play):
//     midi          start pitch, MIDI float (69 = A4). Or give hz instead.
//     dur = 1       seconds
//     sampleRate = 48000   (synth.play always uses the AudioContext's own rate)
//     timbre = 'voice'     'oohs' | 'sung' | 'sine' | 'voice' | 'soft' | 'thin' | number[] of harmonic
//                          amplitudes (index 0 = fundamental). 'oohs' is a real recorded choir
//                          "oo" (FluidR3_GM, js/samples.js; the default reference since
//                          2026-10-15): renderSample with options.bank, else the bank loaded
//                          for timbreFor('oohs'); with neither, or for a glide or a vibrato,
//                          or a note more than 1.5 semitones from a sample, it renders 'voice'
//                          (pitchAt reads it as 'voice' too: a steady note). Its gain, attack
//                          and release mean the same; release defaults to 0.2. 'voice' is a few falling harmonics;
//                          'soft' is a mellow synth pad (few harmonics, a slow swell, three
//                          voices detuned around the pitch: the owner found 'voice' robotic,
//                          2026-10-15); 'thin' has a weak fundamental (a hard case for detectors).
//                          'sung' is a sung vowel made in code (see SUNG below; the default
//                          reference since 2026-10-15, Ricky's reference-sound report):
//                          harmonics shaped by vowel formants fixed in Hz, a late small
//                          vibrato, a seeded drift that averages to zero, a little breath.
//                          Scaled after rendering to the same loudness as the other
//                          timbres (RMS about SUNG.rmsOfGain x gain), never past `gain`.
//                          { envelope: [[hz, dB], ...] } is the singer's own tone colour
//                          ("My voice", js/app/ownvoicekey.js): the 'sung' renderer with each
//                          harmonic k read off the envelope at k x f0 (straight in log Hz,
//                          flat past the ends) in place of the vowel table, so the colour
//                          stays put at every pitch. Same vibrato, drift, breath, loudness.
//                          A missing or malformed envelope throws RangeError.
//     vowel = 'oo'  'sung' only: 'oo' | 'ah'
//     register      'sung' only: 'low' (tenor table) | 'high' (alto table); default from the
//                   note: below midi 57 is 'low'
//     seed = 1      'sung' only: drift and breath are seeded, so a render is repeatable
//     drift         'sung' only: { cents } smooth random wander, mean removed over the tone;
//                   default { cents: 4 }; null = none
//     breath        'sung' only: breath noise RMS as a fraction of the voice's peak; 0.015
//     gain = 0.3    peak amplitude, 0..1
//     attack        seconds of fade-in; default 0.06 for harmonic timbres (a soft, sung
//                   onset), 0.01 for 'sine'
//     release = 0.08  seconds of fade-out (never a click); 'soft' defaults to 0.15 / 0.35
//     chorus        { cents, mix }: two extra voices at +-cents, each at `mix` of the main
//                   one. Symmetric, so the heard pitch stays exact. 'soft' defaults to
//                   { cents: 6, mix: 0.25 }; others to none
//     glideTo       end pitch (midi) of a glide; null = steady
//     glideStart = 0, glideDur = dur - glideStart   the glide is a straight line in
//                   semitones between those times, steady before and after
//     vibrato       { rateHz, cents, delay = 0, ramp = 0 }: sine wobble of +-cents starting at
//                   delay, its depth growing over `ramp` seconds. 'sung' defaults to
//                   { rateHz: 5.2, cents: 12, delay: 0.45, ramp: 0.35 }; null = none
//
//   timbreFor(toneSetting, envelope?) -> the timbre for the Settings 'Reference tone' value
//                            ('oohs' | 'sung' | 'soft' | 'voice' | 'sine' | 'mine'; anything
//                            else -> 'sung'). 'oohs' starts loading the samples on its first
//                            call (browser only: fetch + decodeAudioData, cached) and is
//                            'voice' until they are in, or for good if they fail: silent.
//   useSampleBank(bank|null) -> sets (or clears) the 'oohs' bank directly (labs and checks)
//                            'mine' -> { envelope } (the singer's own tone colour), taken from
//                            `envelope` when given, else from the useOwnVoice source; 'sung'
//                            when there is none or it is not playable.
//                            With recordings (useOwnRecordings) 'mine' is { recordings, envelope? }:
//                            renderTone plays the singer's own recorded voice moved by PSOLA
//                            (js/psola.js, "My voice" v3); a note further than MAX_SHIFT from
//                            every take, a glide or a vibrato falls back to the envelope, else 'sung'.
//   useOwnRecordings(source) -> source: () => [{ rate, hz, data }] | null, asked at each
//                            timbreFor('mine') (js/app/ownvoice.js wires js/app/myvoice.js).
//   useOwnVoice(source)   -> source: () => envelope | null, asked at each timbreFor('mine')
//                            (shell.js reads the saved record, js/app/ownvoicekey.js). So a new
//                            capture, an erase or a restore is heard on the next note.
//   pitchAt(options, t)   -> the true midi pitch of that tone at t seconds (ground truth
//                            for the lab; glide, vibrato and drift included)
//   renderTone(options)   -> Float32Array, mono, -1..1
//   createSynth({ audioContext?, destination? }) -> synth          [browser only]
//     synth.ctx                       the AudioContext (created if not passed in)
//     synth.play(options + { when? }) -> { startTime, dur, ended: Promise, stop(fade = 0.05) }
//         when = AudioContext time to start (default: now). Resumes a suspended context,
//         which browsers only allow after a click or key press.
//     synth.playGlide(fromMidi, toMidi, dur, options?) -> same handle
//     synth.stopAll(fade = 0.05)
//
// Failure behaviour: a pitch that is not a positive finite frequency, or dur <= 0, throws
// RangeError before any sound is made.

import { hzToMidi, midiToHz } from './notes.js';
import { SAMPLE_SETS, renderSample, loadSampleBank } from './samples.js';
import { renderRecorded } from './psola.js';

export const TIMBRES = Object.freeze({
  sine: Object.freeze([1]),
  voice: Object.freeze([1, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05]),
  soft: Object.freeze([1, 0.28, 0.08, 0.03]),
  thin: Object.freeze([0.25, 1, 0.7, 0.5, 0.3, 0.2]),
});

// Per-timbre defaults for the envelope and the chorus (an option given always wins).
const SHAPES = Object.freeze({
  soft: Object.freeze({ attack: 0.15, release: 0.35, chorus: Object.freeze({ cents: 6, mix: 0.25 }) }),
});

// Vowel formant tables for 'sung': [centre Hz, level dB, bandwidth Hz] for F1..F5, from the
// Csound manual's formant appendix (tenor for low notes, alto for high). Fixed in Hz, not
// in harmonics, so the vowel stays the same vowel whatever the note: a voice, not a
// chipmunk, when the pitch moves.
export const VOWELS = Object.freeze({
  oo: Object.freeze({
    low: [[350, 0, 40], [600, -20, 60], [2700, -17, 100], [2900, -14, 120], [3300, -26, 120]],
    high: [[325, 0, 50], [700, -12, 60], [2530, -30, 170], [3500, -40, 180], [4950, -64, 200]],
  }),
  ah: Object.freeze({
    low: [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130], [3250, -22, 140]],
    high: [[800, 0, 80], [1150, -4, 90], [2800, -20, 120], [3500, -36, 130], [4950, -60, 140]],
  }),
});

const SUNG = Object.freeze({
  attack: 0.08, release: 0.2,
  vibrato: Object.freeze({ rateHz: 5.2, cents: 12, delay: 0.45, ramp: 0.35 }),
  drift: Object.freeze({ cents: 4 }),
  breath: 0.015,
  lowBelow: 57,       // register split: below A3 the tenor table
  topHz: 5000,        // no harmonics above this (they cost time and an "oo" has none to speak of)
  block: 256,         // samples between harmonic-amplitude updates (they follow the pitch)
  driftKnotSec: 0.3,  // drift wanders through a new random point this often
  // Loudness: the steady RMS of 'voice' and 'soft' is about 0.32 x gain. Scaling 'sung' to its
  // peak instead made it about 6 dB louder than the tone the owner had, so match the RMS.
  rmsOfGain: 0.32,
});

// Real "oo" samples, loaded once per page on the first timbreFor('oohs'). Decoded with an
// OfflineAudioContext at the files' own rate: it needs no user gesture, plays nothing, and
// gives the same numbers the Node checks read from the WAVs.
let oohsBank = null, oohsLoad = null;
export function useSampleBank(bank) { oohsBank = bank ?? null; }
function wantOohs() {
  if (oohsBank || oohsLoad || typeof fetch !== 'function' || typeof OfflineAudioContext === 'undefined') return;
  const set = SAMPLE_SETS.oohs;
  const decoder = new OfflineAudioContext(1, 1, 22050);
  oohsLoad = loadSampleBank({
    notes: set.notes,
    urlFor: (midi) => new URL(`../${set.dir}${midi}.wav`, import.meta.url),
    decode: (bytes) => decoder.decodeAudioData(bytes).then((b) => ({ rate: b.sampleRate, data: b.getChannelData(0) })),
  }).then((bank) => { oohsBank = bank; }, () => { /* stays 'voice' for this page: no retry storm */ });
}

let ownSource = () => null;
export function useOwnVoice(source) { ownSource = typeof source === 'function' ? source : () => null; }
let ownRecordings = () => null;
export function useOwnRecordings(source) { ownRecordings = typeof source === 'function' ? source : () => null; }
export function timbreFor(tone, envelope) {
  if (tone === 'mine') {
    let e = envelope;
    if (e === undefined) { try { e = ownSource(); } catch { e = null; } }
    let recordings = null;
    try { recordings = ownRecordings(); } catch { recordings = null; }
    // v3: the singer's own recorded voice first; the envelope rides along as its fallback.
    if (Array.isArray(recordings) && recordings.length) return envelopeOk(e) ? { recordings, envelope: e } : { recordings };
    // Without a record "My voice" falls back to the sung "oo", the default.
    return envelopeOk(e) ? { envelope: e } : 'sung';
  }
  if (tone === 'oohs') { wantOohs(); return oohsBank ? 'oohs' : 'voice'; }
  return tone === 'sine' || tone === 'voice' || tone === 'soft' ? tone : 'sung';
}

// Small seeded generator (mulberry32): the same seed gives the same drift and breath, so
// Node checks and the lab judge exactly the samples the singer hears.
function seeded(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth zero-mean wander for 'sung': cosine-eased steps between random knots. The mean over
// the whole tone is subtracted, so the tone's average pitch is the target exactly.
function makeDrift(cents, dur, rand) {
  const knots = Array.from({ length: Math.ceil(dur / SUNG.driftKnotSec) + 2 }, () => 2 * rand() - 1);
  const raw = (t) => {
    const x = t / SUNG.driftKnotSec, j = Math.floor(x), f = 0.5 - 0.5 * Math.cos(Math.PI * (x - j));
    return knots[j] + (knots[j + 1] - knots[j]) * f;
  };
  let mean = 0;
  const N = 512;
  for (let i = 0; i < N; i++) mean += raw(((i + 0.5) / N) * dur) / N;
  return (t) => (cents / 100) * (raw(Math.min(dur, Math.max(0, t))) - mean);
}

function resolve(options = {}) {
  const midi = options.midi ?? hzToMidi(options.hz);
  if (!Number.isFinite(midi)) throw new RangeError(`synth: need a midi or hz pitch, got midi=${options.midi} hz=${options.hz}`);
  const dur = options.dur ?? 1;
  if (!(dur > 0)) throw new RangeError(`synth: dur must be > 0, got ${dur}`);
  // 'oohs' resolves as 'voice': its fallback, and the same steady pitch for pitchAt.
  let timbre = options.timbre === 'oohs' ? 'voice' : options.timbre ?? 'voice';
  // { recordings }: out of PSOLA's reach (or a glide), so the envelope, else the sung "oo".
  if (timbre && typeof timbre === 'object' && !Array.isArray(timbre) && timbre.recordings) timbre = envelopeOk(timbre.envelope) ? { envelope: timbre.envelope } : 'sung';
  // { envelope }: the singer's own tone colour ("My voice"), played by the sung renderer.
  const own = timbre && typeof timbre === 'object' && !Array.isArray(timbre) ? timbre : null;
  if (own && !envelopeOk(own.envelope)) throw new RangeError('synth: an own-voice timbre needs an envelope of [hz, dB] pairs');
  const sung = timbre === 'sung' || own !== null;
  const harmonics = sung ? [1] : Array.isArray(timbre) ? timbre : TIMBRES[timbre];
  if (!harmonics || !harmonics.length) throw new RangeError(`synth: unknown timbre ${timbre}`);
  const glideStart = options.glideStart ?? 0;
  const shape = sung ? SUNG : (typeof timbre === 'string' && SHAPES[timbre]) || {};
  const pick = (k) => (options[k] !== undefined ? options[k] : shape[k] ?? null);
  let formants = null, envelope = null, drift = null, rand = null;
  if (own) {
    envelope = { lx: Float64Array.from(own.envelope, (p) => Math.log2(p[0])), db: Float64Array.from(own.envelope, (p) => p[1]) };
  } else if (sung) {
    const vowel = VOWELS[options.vowel ?? 'oo'];
    if (!vowel) throw new RangeError(`synth: unknown vowel ${options.vowel}`);
    const register = options.register ?? (midi < SUNG.lowBelow ? 'low' : 'high');
    formants = vowel[register];
    if (!formants) throw new RangeError(`synth: unknown register ${options.register}`);
  }
  if (sung) {
    rand = seeded(options.seed ?? 1);
    const d = pick('drift');
    if (d && d.cents) drift = makeDrift(d.cents, dur, rand);
  }
  return {
    midi, dur, harmonics, sung, formants, envelope, drift, rand,
    breath: sung ? (pick('breath') ?? 0) : 0,
    sampleRate: options.sampleRate ?? 48000,
    gain: options.gain ?? 0.3,
    attack: options.attack ?? shape.attack ?? (harmonics.length > 1 ? 0.06 : 0.01),
    release: options.release ?? shape.release ?? 0.08,
    chorus: options.chorus ?? shape.chorus ?? null,
    glideTo: options.glideTo ?? null,
    glideStart,
    glideDur: options.glideDur ?? Math.max(1e-6, dur - glideStart),
    vibrato: sung ? pick('vibrato') : options.vibrato ?? null,
  };
}

function pitchOf(o, t) {
  let midi = o.midi;
  if (o.glideTo !== null) {
    const k = Math.min(1, Math.max(0, (t - o.glideStart) / o.glideDur));
    midi += (o.glideTo - o.midi) * k;
  }
  if (o.vibrato && t >= (o.vibrato.delay ?? 0)) {
    const since = t - (o.vibrato.delay ?? 0);
    const depth = o.vibrato.ramp ? Math.min(1, since / o.vibrato.ramp) : 1;
    midi += depth * (o.vibrato.cents / 100) * Math.sin(2 * Math.PI * o.vibrato.rateHz * since);
  }
  if (o.drift) midi += o.drift(t);
  return midi;
}

export function pitchAt(options, t) {
  return pitchOf(resolve(options), t);
}

export function renderTone(options) {
  const t = options && options.timbre;
  if (t && typeof t === 'object' && !Array.isArray(t) && t.recordings && options.glideTo == null && !options.vibrato) {
    const real = renderRecorded({ ...options, recordings: t.recordings });
    if (real) return real;
  }
  if (options && options.timbre === 'oohs' && options.glideTo == null && !options.vibrato) {
    const bank = options.bank ?? oohsBank;
    const real = bank ? renderSample({ ...options, bank, release: options.release ?? 0.2, attack: options.attack ?? 0.06 }) : null;
    if (real) return real;
  }
  const o = resolve(options);
  if (o.sung) return renderSung(o);
  const n = Math.max(1, Math.round(o.dur * o.sampleRate));
  const out = new Float32Array(n);

  // Drop harmonics that would pass Nyquist at the tone's highest moment: an aliased
  // harmonic folds back as an out-of-tune partial. Decided once for the whole tone, since
  // switching a harmonic off mid-glide would click.
  const topMidi = Math.max(o.midi, o.glideTo ?? o.midi) + (o.vibrato ? o.vibrato.cents / 100 : 0) + (o.chorus ? o.chorus.cents / 100 : 0);
  const topHz = midiToHz(topMidi);
  const amps = o.harmonics.filter((_, i) => (i + 1) * topHz < 0.45 * o.sampleRate);
  if (!amps.length) throw new RangeError(`synth: ${topHz.toFixed(0)} Hz is too high for a ${o.sampleRate} Hz sample rate`);
  // Chorus: the main voice plus one a few cents up and one down (ratios, so glides keep them).
  const voices = o.chorus && o.chorus.mix > 0
    ? [[1, 1], [2 ** (o.chorus.cents / 1200), o.chorus.mix], [2 ** (-o.chorus.cents / 1200), o.chorus.mix]]
    : [[1, 1]];
  const phases = voices.map(() => 0);
  const norm = o.gain / (amps.reduce((s, a) => s + Math.abs(a), 0) * voices.reduce((s, v) => s + v[1], 0));

  const attack = Math.min(o.attack, o.dur / 2), release = Math.min(o.release, o.dur / 2);
  for (let i = 0; i < n; i++) {
    const t = i / o.sampleRate;
    let v = 0;
    for (let k = 0; k < voices.length; k++) {
      for (let h = 0; h < amps.length; h++) v += voices[k][1] * amps[h] * Math.sin((h + 1) * phases[k]);
    }
    // Raised-cosine fades: no corner at either end, so no click.
    let env = 1;
    if (t < attack) env = 0.5 - 0.5 * Math.cos(Math.PI * t / attack);
    else if (t > o.dur - release) env = 0.5 - 0.5 * Math.cos(Math.PI * (o.dur - t) / release);
    out[i] = v * norm * env;
    // The phase is accumulated from the momentary frequency, which is what keeps glides
    // and vibrato continuous.
    const step = 2 * Math.PI * midiToHz(pitchOf(o, t)) / o.sampleRate;
    for (let k = 0; k < voices.length; k++) {
      phases[k] += step * voices[k][0];
      if (phases[k] > 2 * Math.PI) phases[k] -= 2 * Math.PI;
    }
  }
  return out;
}

// Spectral envelope of a vowel at f Hz (linear): the formants' resonance curves summed, with a
// -40 dB floor so no harmonic vanishes outright.
function vowelEnvelope(formants, f) {
  let a = 0;
  for (const [fc, db, bw] of formants) a += 10 ** (db / 20) / Math.sqrt(1 + ((f - fc) / (bw / 2)) ** 2);
  return Math.max(a, 0.01);
}

// The singer's envelope at f Hz (linear): dB straight in log Hz between its points, held flat
// past either end. Unlike a vowel table it already holds the voice's own source slope.
function ownEnvelope(e, f) {
  const x = Math.log2(f), n = e.lx.length;
  if (x <= e.lx[0]) return 10 ** (e.db[0] / 20);
  if (x >= e.lx[n - 1]) return 10 ** (e.db[n - 1] / 20);
  let i = 1;
  while (e.lx[i] < x) i++;
  const w = (x - e.lx[i - 1]) / (e.lx[i] - e.lx[i - 1]);
  return 10 ** ((e.db[i - 1] + (e.db[i] - e.db[i - 1]) * w) / 20);
}

const envelopeOk = (e) => Array.isArray(e) && e.length >= 2
  && e.every((p, i) => Array.isArray(p) && p[0] > 0 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && (i === 0 || p[0] > e[i - 1][0]));

// Harmonic amplitudes of a sung vowel at fundamental f0: a source falling 6 dB an octave
// (glottal -12, lip radiation +6) times the vowel envelope, faded out between 0.8 and 1 x
// SUNG.topHz (and well below Nyquist) so a harmonic never pops in or out as the pitch moves.
function sungAmps(o, f0, count, amps) {
  const top = Math.min(SUNG.topHz, 0.45 * o.sampleRate);
  let max = 0;
  for (let k = 1; k <= count; k++) {
    const f = k * f0;
    const fade = f >= top ? 0 : f <= 0.8 * top ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (f - 0.8 * top) / (0.2 * top));
    amps[k - 1] = fade * (o.envelope ? ownEnvelope(o.envelope, f) : vowelEnvelope(o.formants, f) / k);
    if (amps[k - 1] > max) max = amps[k - 1];
  }
  // Keep the fundamental at least half the strongest harmonic. A sung "oo" has a strong
  // fundamental anyway; on low notes the table alone would put F1 on the 4th harmonic,
  // and the MPM detector can slip an octave on a weak fundamental (the 'thin' case).
  amps[0] = Math.max(amps[0], 0.5 * max);
}

function renderSung(o) {
  const n = Math.max(1, Math.round(o.dur * o.sampleRate));
  const out = new Float32Array(n);
  const lowHz = midiToHz(Math.min(o.midi, o.glideTo ?? o.midi) - 1);
  if (midiToHz(Math.max(o.midi, o.glideTo ?? o.midi)) >= 0.45 * o.sampleRate) {
    throw new RangeError(`synth: ${o.midi} is too high for a ${o.sampleRate} Hz sample rate`);
  }
  const count = Math.max(1, Math.floor(Math.min(SUNG.topHz, 0.45 * o.sampleRate) / lowHz));
  let prev = new Float64Array(count), next = new Float64Array(count);
  sungAmps(o, midiToHz(pitchOf(o, 0)), count, prev);
  // An own voice can be bright (strong harmonics near 3 kHz). With every harmonic in sine
  // phase they pile into one sharp peak a period, the `gain` cap wins and a low note came out
  // about 4 dB quieter than the other timbres. Schroeder phases (pi k^2 / N) spread the peak;
  // the ear hears the same colour and the pitch is unchanged. The vowel table keeps sine
  // phase so the sung "oo" renders exactly as before.
  const spread = o.envelope ? { sin: new Float64Array(count), cos: new Float64Array(count) } : null;
  if (spread) for (let k = 0; k < count; k++) { const p = Math.PI * (k + 1) * (k + 1) / count; spread.sin[k] = Math.sin(p); spread.cos[k] = Math.cos(p); }
  let phase = 0, peak = 0;
  for (let b = 0; b < n; b += SUNG.block) {
    // Amplitudes follow the pitch block by block (formants stay put in Hz), eased linearly
    // across each block so there is no step.
    const end = Math.min(n, b + SUNG.block);
    sungAmps(o, midiToHz(pitchOf(o, end / o.sampleRate)), count, next);
    for (let i = b; i < end; i++) {
      const w = (i - b) / SUNG.block;
      // sin(k x) for every k by the Chebyshev recurrence: one sin and one cos per sample.
      const s1 = Math.sin(phase), c1 = Math.cos(phase), c2 = 2 * c1;
      let sPrev = 0, s = s1, v = 0;
      if (spread) {
        // cos(k x) by the same recurrence, so each harmonic can start at its own phase.
        let cPrev = 1, c = c1;
        for (let k = 0; k < count; k++) {
          v += (prev[k] + (next[k] - prev[k]) * w) * (s * spread.cos[k] + c * spread.sin[k]);
          const sNext = c2 * s - sPrev; sPrev = s; s = sNext;
          const cNext = c2 * c - cPrev; cPrev = c; c = cNext;
        }
      } else {
        for (let k = 0; k < count; k++) {
          v += (prev[k] + (next[k] - prev[k]) * w) * s;
          const sNext = c2 * s - sPrev; sPrev = s; s = sNext;
        }
      }
      out[i] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      phase += 2 * Math.PI * midiToHz(pitchOf(o, i / o.sampleRate)) / o.sampleRate;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
    [prev, next] = [next, prev];
  }
  // Breath: seeded white noise band-passed to roughly 300 Hz-3 kHz by two one-pole filters,
  // scaled to `breath` x the voice's peak in RMS.
  if (o.breath > 0 && peak > 0) {
    const noise = new Float32Array(n);
    const aHi = 1 - Math.exp(-2 * Math.PI * 3000 / o.sampleRate), aLo = 1 - Math.exp(-2 * Math.PI * 300 / o.sampleRate);
    let hi = 0, lo = 0, sq = 0;
    for (let i = 0; i < n; i++) {
      hi += aHi * ((2 * o.rand() - 1) - hi);
      lo += aLo * (hi - lo);
      noise[i] = hi - lo;
      sq += noise[i] * noise[i];
    }
    const k = sq > 0 ? (o.breath * peak) / Math.sqrt(sq / n) : 0;
    for (let i = 0; i < n; i++) out[i] += k * noise[i];
  }
  let sq = 0;
  for (let i = 0; i < n; i++) sq += out[i] * out[i];
  const rms = Math.sqrt(sq / n);
  // Raised-cosine fades (no click), then scale to the shared loudness, capped at `gain`.
  const attack = Math.min(o.attack, o.dur / 2), release = Math.min(o.release, o.dur / 2);
  let top = 0;
  for (let i = 0; i < n; i++) {
    const t = i / o.sampleRate;
    if (t < attack) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * t / attack);
    else if (t > o.dur - release) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * (o.dur - t) / release);
    if (Math.abs(out[i]) > top) top = Math.abs(out[i]);
  }
  if (top > 0) { const g = Math.min(o.gain / top, (SUNG.rmsOfGain * o.gain) / rms); for (let i = 0; i < n; i++) out[i] *= g; }
  return out;
}

export function createSynth({ audioContext, destination } = {}) {
  const ctx = audioContext ?? new AudioContext();
  const out = destination ?? ctx.destination;
  const live = new Set();

  function play(options = {}) {
    const samples = renderTone({ ...options, sampleRate: ctx.sampleRate });
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // A gain node per tone only so that stop() can fade this tone out without a click.
    const fader = ctx.createGain();
    source.connect(fader).connect(out);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const startTime = Math.max(options.when ?? 0, ctx.currentTime);
    source.start(startTime);

    let stopped = false;
    const handle = {
      startTime,
      dur: buffer.duration,
      ended: new Promise((done) => { source.onended = () => { live.delete(handle); fader.disconnect(); done(); }; }),
      stop(fade = 0.05) {
        if (stopped) return;
        stopped = true;
        const now = ctx.currentTime;
        fader.gain.setValueAtTime(1, now);
        fader.gain.linearRampToValueAtTime(0, now + fade);
        source.stop(now + fade + 0.01);
      },
    };
    live.add(handle);
    return handle;
  }

  return {
    ctx,
    play,
    playGlide: (fromMidi, toMidi, dur, options = {}) => play({ ...options, midi: fromMidi, glideTo: toMidi, dur }),
    stopAll(fade = 0.05) { for (const h of [...live]) h.stop(fade); },
  };
}
