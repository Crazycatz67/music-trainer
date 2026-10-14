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
//     timbre = 'voice'     'sine' | 'voice' | 'thin' | number[] of harmonic amplitudes
//                          (index 0 = fundamental). 'voice' is a few falling harmonics;
//                          'thin' has a weak fundamental (a hard case for pitch detectors).
//     gain = 0.3    peak amplitude, 0..1
//     attack        seconds of fade-in; default 0.06 for harmonic timbres (a soft, sung
//                   onset), 0.01 for 'sine'
//     release = 0.08  seconds of fade-out (never a click)
//     glideTo       end pitch (midi) of a glide; null = steady
//     glideStart = 0, glideDur = dur - glideStart   the glide is a straight line in
//                   semitones between those times, steady before and after
//     vibrato       { rateHz, cents, delay = 0 }: sine wobble of +-cents starting at delay
//
//   pitchAt(options, t)   -> the true midi pitch of that tone at t seconds (ground truth
//                            for the lab; glide and vibrato included)
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

export const TIMBRES = Object.freeze({
  sine: Object.freeze([1]),
  voice: Object.freeze([1, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05]),
  thin: Object.freeze([0.25, 1, 0.7, 0.5, 0.3, 0.2]),
});

function resolve(options = {}) {
  const midi = options.midi ?? hzToMidi(options.hz);
  if (!Number.isFinite(midi)) throw new RangeError(`synth: need a midi or hz pitch, got midi=${options.midi} hz=${options.hz}`);
  const dur = options.dur ?? 1;
  if (!(dur > 0)) throw new RangeError(`synth: dur must be > 0, got ${dur}`);
  const timbre = options.timbre ?? 'voice';
  const harmonics = Array.isArray(timbre) ? timbre : TIMBRES[timbre];
  if (!harmonics || !harmonics.length) throw new RangeError(`synth: unknown timbre ${timbre}`);
  const glideStart = options.glideStart ?? 0;
  return {
    midi, dur, harmonics,
    sampleRate: options.sampleRate ?? 48000,
    gain: options.gain ?? 0.3,
    attack: options.attack ?? (harmonics.length > 1 ? 0.06 : 0.01),
    release: options.release ?? 0.08,
    glideTo: options.glideTo ?? null,
    glideStart,
    glideDur: options.glideDur ?? Math.max(1e-6, dur - glideStart),
    vibrato: options.vibrato ?? null,
  };
}

function pitchOf(o, t) {
  let midi = o.midi;
  if (o.glideTo !== null) {
    const k = Math.min(1, Math.max(0, (t - o.glideStart) / o.glideDur));
    midi += (o.glideTo - o.midi) * k;
  }
  if (o.vibrato && t >= (o.vibrato.delay ?? 0)) {
    midi += (o.vibrato.cents / 100) * Math.sin(2 * Math.PI * o.vibrato.rateHz * (t - (o.vibrato.delay ?? 0)));
  }
  return midi;
}

export function pitchAt(options, t) {
  return pitchOf(resolve(options), t);
}

export function renderTone(options) {
  const o = resolve(options);
  const n = Math.max(1, Math.round(o.dur * o.sampleRate));
  const out = new Float32Array(n);

  // Drop harmonics that would pass Nyquist at the tone's highest moment: an aliased
  // harmonic folds back as an out-of-tune partial. Decided once for the whole tone, since
  // switching a harmonic off mid-glide would click.
  const topMidi = Math.max(o.midi, o.glideTo ?? o.midi) + (o.vibrato ? o.vibrato.cents / 100 : 0);
  const topHz = midiToHz(topMidi);
  const amps = o.harmonics.filter((_, i) => (i + 1) * topHz < 0.45 * o.sampleRate);
  if (!amps.length) throw new RangeError(`synth: ${topHz.toFixed(0)} Hz is too high for a ${o.sampleRate} Hz sample rate`);
  const norm = o.gain / amps.reduce((s, a) => s + Math.abs(a), 0);

  const attack = Math.min(o.attack, o.dur / 2), release = Math.min(o.release, o.dur / 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / o.sampleRate;
    let v = 0;
    for (let h = 0; h < amps.length; h++) v += amps[h] * Math.sin((h + 1) * phase);
    // Raised-cosine fades: no corner at either end, so no click.
    let env = 1;
    if (t < attack) env = 0.5 - 0.5 * Math.cos(Math.PI * t / attack);
    else if (t > o.dur - release) env = 0.5 - 0.5 * Math.cos(Math.PI * (o.dur - t) / release);
    out[i] = v * norm * env;
    // The phase is accumulated from the momentary frequency, which is what keeps glides
    // and vibrato continuous.
    phase += 2 * Math.PI * midiToHz(pitchOf(o, t)) / o.sampleRate;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }
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
