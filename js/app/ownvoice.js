// ownvoice.js — the singer's own voice as the target tone. From a few seconds of one steady
// sung note it measures how strong each harmonic is, and hands js/synth.js that list as a
// `timbre`, so Match and hold can play its note "in your voice" at any pitch.
//
// Why: most poor singers match their own recorded voice better than a synth tone (Hutchins &
// Peretz 2012; docs/team-log/reports/2026-10-13-ricky-feature-ideas.md). What is kept is NOT a
// recording: only up to 12 numbers. Whether a harmonic copy sounds enough like "me" to carry
// the benefit is unproven (the study used recordings) and can only be judged by ear.
//
// The top half is PURE and imports in Node (tools/checks/ownvoice.check.mjs).
//
// CONTRACT — pure
//   windowSizeFor(sampleRate, cfg?) -> a power of two, about cfg.windowSec long (8192 at 48 kHz)
//   createCollector({ sampleRate, cfg? }) -> collector
//       collector.windowSize
//       collector.push(frame, samples) -> { voicedMs }
//           frame: a pitch frame { t, hz, midi, voiced } (js/pitch.js); samples: the newest
//           windowSize samples, -1..1, ending where the frame's own window ends. Unvoiced
//           frames are counted and otherwise ignored. A wrong length throws RangeError.
//       collector.voicedMs()   voiced sound heard so far (gaps over 100 ms are not counted)
//       collector.finish() -> result
//   estimateTimbre(signal, frames, sampleRate, cfg?) -> result
//       The same from a whole signal and its frames (js/pitch.js analyse()), where frame.t is
//       the CENTRE of the frame's window, in seconds from the start of the signal.
//   result, accepted: { ok: true, timbre, midi, hnrDb, frames, harmonics }
//       timbre     number[] of harmonic amplitudes, index 0 = the fundamental, the STRONGEST
//                  one = 1, three decimals, at most cfg.maxHarmonics, no trailing zeros. A
//                  harmonic lost in the noise is 0. Give it to synth.play({ timbre }).
//       midi       the middle pitch of the steady readings (where it was measured)
//       hnrDb      voice over the noise between its harmonics, dB
//       frames     steady readings used; harmonics: how many are above 0
//   result, refused: { ok: false, reason, words }       (nothing is stored)
//       reason: 'no-note' | 'clipped' | 'unsteady' | 'short' | 'low' | 'noisy'; words is the
//       plain sentence to show (REFUSALS).
//   OWNVOICE_KEY   'music-trainer.ownvoice.v1' -> { v: 1, timbre, midi, hnrDb, at }
//   readOwnVoice(storage) -> record | null      null for nothing saved, another version, or
//       anything that is not a playable timbre (never throws)
//   saveOwnVoice(storage, result, nowIso?) -> { saved, record }   record is null when the
//       result was refused; saved false when storage is full or blocked
//   clearOwnVoice(storage)
//   noteTimbre(noteSound, record, plain) -> record.timbre when noteSound is 'mine' and there
//       is a record, else `plain` (a js/synth.js timbre name)
//
// CONTRACT — mountOwnVoice(host, { micflow, shell, settings, storage?, config?, micOptions?,
//                                  synth, home?, onChange? }) -> part            [browser only]
//   The "Note sound: Plain / My voice" choice (settings.noteSound) and the "Teach it your
//   voice" step. `synth` is a function returning a js/synth.js synth (made on the first press);
//   `home` the note to sing (js/app/range.js homeNote), played first when given.
//   part.teach() -> Promise<result | null>   null: not started, or cancelled. Only ever call
//       it from the singer's own press: it asks for the microphone.
//   part.cancel(), part.busy() -> boolean, part.record() -> record | null, part.destroy()
//       record() follows storage: it is read again on any settings change (so "Erase my
//       data") and on 'mt:backup' { type: 'restored' }. A voice the browser would not save
//       stays for the visit.
//   part.state() -> { phase: 'idle' | 'asking' | 'tone' | 'capture', voicedMs, says, record }
//   The microphone: opened by teach() and released the moment listening ends (full bar,
//   timeout, Cancel, Esc, any sheet, the page hidden or left, destroy()), before the sums are
//   done. It is not read while the home note plays, as in Match and hold's listen phase.
//   Events: 'mt:ownvoice' on document, detail { event, reason?, harmonics? }.
//       event: start | tone | capture | saved | refused | cancel

import FFT from '../../vendor/fft.js-4.0.4/fft.js';
import { CONFIG } from './config.js';
import { OWNVOICE_KEY, OWNVOICE_VERSION, playableTimbre, readOwnVoice } from './ownvoicekey.js';
import { h, icon, segmented } from './shell.js';

// ---------------------------------------------------------------- pure

export const REFUSALS = Object.freeze({
  'no-note': 'I could not hear a note. Sing one steady ‘ah’ and try again.',
  clipped: 'That was too loud for the microphone. Move back a little and try again.',
  unsteady: 'The note moved about. Hold one steady ‘ah’ and try again.',
  short: 'That was too short. Hold the note until the bar is full.',
  low: 'That note is too low to take apart. Try a slightly higher one.',
  noisy: 'There was too much noise around your voice. Try a quieter room, or move closer.',
});

export function windowSizeFor(sampleRate, cfg = CONFIG.ownVoice) {
  let n = 2048;
  // 32768 is the largest window an AnalyserNode can give.
  while (n < sampleRate * cfg.windowSec && n < 32768) n *= 2;
  return n;
}

const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Two voiced readings further apart than this are not one stretch of voice (contract above).
const GAP_MS = 100;

export function createCollector({ sampleRate, cfg = CONFIG.ownVoice } = {}) {
  if (!(sampleRate > 0)) throw new RangeError(`ownvoice: need a sample rate, got ${sampleRate}`);
  const N = windowSizeFor(sampleRate, cfg), K = cfg.maxHarmonics, binHz = sampleRate / N;
  const fft = new FFT(N), spectrum = fft.createComplexArray(), windowed = new Array(N), power = new Float64Array(N / 2);
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const kept = [];             // one per voiced reading: { midi, clipped, low, sig, noise, hnr }
  let voicedMs = 0, lastVoicedT = null, pushed = 0;

  // One window taken apart. A harmonic's energy is summed over a band round k x f0 rather
  // than read at one bin: the sum does not depend on where between two bins the harmonic
  // falls (a single bin is up to 15 percent out), and it still holds the harmonic when the
  // note wavers a little. The noise under it is read from the quiet gaps between harmonics
  // and taken off, so room noise is not stored as part of the voice.
  function takeApart(samples, f0) {
    const perF0 = f0 / binHz;
    if (perF0 < cfg.minBinsPerF0) return null;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += samples[i];
    mean /= N;
    for (let i = 0; i < N; i++) windowed[i] = (samples[i] - mean) * hann[i];
    fft.realTransform(spectrum, windowed);
    for (let b = 0; b < N / 2; b++) power[b] = spectrum[2 * b] ** 2 + spectrum[2 * b + 1] ** 2;

    const top = Math.min(cfg.maxHz, 0.45 * sampleRate);
    const half = Math.max(cfg.minBandBins, cfg.bandFrac * perF0);
    const sig = new Float32Array(K), noise = new Float32Array(K);
    let sigSum = 0, noiseSum = 0;
    for (let k = 1; k <= K && k * f0 <= top; k++) {
      const c = k * perF0;
      const lo = Math.max(1, Math.round(c - half)), hi = Math.min(N / 2 - 1, Math.round(c + half));
      let e = 0;
      for (let b = lo; b <= hi; b++) e += power[b];
      const gap = [];
      for (const side of [-1, 1]) {
        const a = c + side * cfg.gapFrom * perF0, z = c + side * cfg.gapTo * perF0;
        for (let b = Math.max(1, Math.ceil(Math.min(a, z))); b <= Math.min(N / 2 - 1, Math.floor(Math.max(a, z))); b++) gap.push(power[b]);
      }
      // Noise power in one bin: its median is ln 2 of its mean, and the median does not
      // mind a stray whistle or the skirt of a strong neighbour.
      const perBin = median(gap) / Math.LN2, under = perBin * (hi - lo + 1);
      sig[k - 1] = Math.max(0, e - under);
      noise[k - 1] = under;
      sigSum += sig[k - 1];
      noiseSum += perBin * perF0;       // all the noise in this harmonic's stretch of the spectrum
    }
    return { sig, noise, hnr: sigSum / Math.max(noiseSum, 1e-30), total: sigSum };
  }

  function push(frame, samples) {
    if (!samples || samples.length !== N) throw new RangeError(`ownvoice: need ${N} samples, got ${samples ? samples.length : samples}`);
    pushed++;
    if (!frame || !frame.voiced || !(frame.hz > 0)) return { voicedMs };
    // Time is only counted between readings that follow one another: a breath is not voice.
    // A gap over GAP_MS adds nothing at all (it used to add 100 ms, so every breath or
    // dropout still filled the bar a little).
    const gapMs = lastVoicedT === null ? 0 : (frame.t - lastVoicedT) * 1000;
    if (gapMs > 0 && gapMs <= GAP_MS) voicedMs += gapMs;
    lastVoicedT = frame.t;
    let peak = 0;
    for (let i = 0; i < N; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    const parts = takeApart(samples, frame.hz);
    kept.push({ midi: frame.midi, clipped: peak >= cfg.clipPeak, low: !parts, ...(parts || {}) });
    return { voicedMs };
  }

  function finish() {
    const refuse = (reason) => ({ ok: false, reason, words: REFUSALS[reason] });
    if (!kept.length) return refuse('no-note');
    // Clipping first: a clipped note has harmonics the voice never made, and they would be
    // stored as the singer's own.
    if (kept.filter((f) => f.clipped).length / kept.length > cfg.clipShare) return refuse('clipped');
    const mid = median(kept.map((f) => f.midi));
    const steady = kept.filter((f) => Math.abs(f.midi - mid) * 100 <= cfg.steadyCents);
    if (steady.length / kept.length < cfg.minSteadyShare) return refuse('unsteady');
    if (steady.length < cfg.minSteadyFrames) return refuse('short');
    const usable = steady.filter((f) => !f.low);
    if (usable.length < cfg.minSteadyFrames) return refuse('low');
    const hnrDb = 10 * Math.log10(Math.max(median(usable.map((f) => f.hnr)), 1e-12));
    if (hnrDb < cfg.minHnrDb) return refuse('noisy');

    // Each reading's harmonics are put on that reading's own loudness first, so a note that
    // swells or fades does not smear the picture; then the middle value over the readings.
    const amps = [];
    for (let k = 0; k < cfg.maxHarmonics; k++) {
      const heard = median(usable.map((f) => f.sig[k])) >= cfg.harmonicMinSnr * median(usable.map((f) => f.noise[k]));
      amps.push(heard ? median(usable.map((f) => Math.sqrt(f.sig[k] / Math.max(f.total, 1e-30)))) : 0);
    }
    const max = Math.max(...amps);
    if (!(max > 0)) return refuse('noisy');
    const timbre = amps.map((a) => Math.round(cfg.round * a / max) / cfg.round);
    while (timbre.length > 1 && timbre[timbre.length - 1] === 0) timbre.pop();
    return {
      ok: true, timbre, midi: Math.round(mid * 100) / 100, hnrDb: Math.round(hnrDb * 10) / 10,
      frames: usable.length, harmonics: timbre.filter((a) => a > 0).length,
    };
  }

  return { windowSize: N, push, finish, voicedMs: () => voicedMs, pushed: () => pushed };
}

export function estimateTimbre(signal, frames, sampleRate, cfg = CONFIG.ownVoice) {
  const c = createCollector({ sampleRate, cfg }), N = c.windowSize;
  for (const frame of frames) {
    const from = Math.round(frame.t * sampleRate - N / 2);
    if (from < 0 || from + N > signal.length) continue;       // no whole window here
    c.push(frame, signal.subarray(from, from + N));
  }
  return c.finish();
}

// The key and the reader live in js/app/ownvoicekey.js (no imports), so Settings and the
// backup can read the record without the FFT or a circle through shell.js. Re-exported here
// so this file's contract is unchanged.
export { OWNVOICE_KEY, readOwnVoice };
const VERSION = OWNVOICE_VERSION;
const playable = playableTimbre;

export function saveOwnVoice(storage, result, nowIso = new Date().toISOString()) {
  if (!result || !result.ok || !playable(result.timbre)) return { saved: false, record: null };
  const record = { v: VERSION, timbre: [...result.timbre], midi: result.midi ?? null, hnrDb: result.hnrDb ?? null, at: nowIso };
  let saved = false;
  try { if (storage) { storage.setItem(OWNVOICE_KEY, JSON.stringify(record)); saved = true; } } catch { /* full or blocked: it still stands for this visit */ }
  return { saved, record };
}

export function clearOwnVoice(storage) {
  try { if (storage) storage.removeItem(OWNVOICE_KEY); } catch { /* nothing more to do */ }
}

export const noteTimbre = (noteSound, record, plain = 'voice') => (noteSound === 'mine' && record && playable(record.timbre) ? record.timbre : plain);

export const NO_VOICE_YET = 'teach it your voice first.';

// ---------------------------------------------------------------- browser: the choice and the teaching step

export function mountOwnVoice(host, {
  micflow, shell, settings, storage, config = CONFIG, micOptions, synth, home = null, onChange,
} = {}) {
  const O = config.ownVoice;
  const store = storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  let record = readOwnVoice(store);
  let phase = 'idle', seq = 0, dead = false, says = '', saysRole = '', tone = null, collector = null, tap = null, offFrame = null, timer = 0;
  let settle = null, barPct = -1, letting = false;

  const choiceSlot = h('div', { class: 'ov-choice' });
  const teachBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'aria-describedby': 'ov-says', onclick: () => teach() });
  const cancelBtn = h('button', { class: 'btn btn-quiet btn-small', type: 'button', hidden: true, onclick: () => cancel('Stopped. The microphone is off.') }, 'Cancel');
  const stepIcon = h('span', { class: 'ov-icon' }), stepWords = h('span');
  const fill = h('i');
  const bar = h('div', { class: 'level-bar ov-bar', role: 'progressbar', 'aria-label': 'Your voice heard so far', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const step = h('div', { class: 'ov-step', hidden: true }, h('p', { class: 'ov-words', role: 'status' }, stepIcon, stepWords), bar);
  const saysLine = h('p', { class: 'reason ov-says', id: 'ov-says', role: 'status' });
  const el = h('section', { class: 'ownvoice', 'aria-label': 'Note sound' },
    choiceSlot, h('div', { class: 'ov-actions' }, teachBtn, cancelBtn), step, saysLine);
  host.append(el);

  const emit = (event, more = {}) => document.dispatchEvent(new CustomEvent('mt:ownvoice', { detail: { event, ...more } }));
  const busy = () => phase !== 'idle';
  const told = () => { if (onChange) onChange(state()); };
  const state = () => ({ phase, voicedMs: collector ? collector.voicedMs() : 0, says, record });

  // The choice is built again whenever the record changes: shell.js segmented() fixes which
  // options are off when it is made.
  function paintChoice() {
    const value = settings.get('noteSound') === 'mine' && record ? 'mine' : 'plain';
    choiceSlot.replaceChildren(segmented({
      label: 'Note sound', value, onChange: (v) => settings.set('noteSound', v),
      options: [{ value: 'plain', text: 'Plain' }, { value: 'mine', text: 'My voice', disabled: !record, reason: NO_VOICE_YET }],
    }));
  }

  function paint() {
    const active = busy();
    teachBtn.replaceChildren(record ? 'Teach it again' : 'Teach it your voice');
    teachBtn.disabled = active;
    cancelBtn.hidden = !active;
    step.hidden = !active;
    el.dataset.phase = phase;
    const words = {
      asking: 'Waiting for the microphone.',
      tone: 'Listen to the note. The microphone waits until it ends.',
      capture: `The microphone is on. Sing ‘ah’ on ${home === null ? 'any comfortable note' : 'that note'} and hold it steady.`,
    }[phase] || '';
    if (stepWords.textContent !== words) {
      stepWords.textContent = words;
      stepIcon.replaceChildren(...(active ? [icon(phase === 'capture' ? 'mic' : phase === 'tone' ? 'speaker' : 'dots', 16)] : []));
    }
    bar.hidden = phase !== 'capture';
    const idle = says || (record
      ? `Your voice is saved as ${record.timbre.length} numbers, not a recording. It is used for the note you copy.`
      : 'About 4 seconds of one steady note. Only a few numbers are kept, never a recording.');
    if (saysLine.textContent !== idle) saysLine.textContent = idle;
    saysLine.dataset.role = saysRole;
  }

  function paintBar() {
    const pct = collector ? Math.round(100 * Math.min(1, collector.voicedMs() / O.captureMs)) : 0;
    if (pct === barPct) return;
    barPct = pct;
    fill.style.transform = `scaleX(${pct / 100})`;
    bar.setAttribute('aria-valuenow', String(pct));
  }

  // Everything that listens is let go, the microphone first. Safe to call in any phase.
  function release() {
    // Our own stop() must not be read as "the microphone stopped by itself" (the subscriber
    // below would cancel a capture that is just being finished).
    letting = true;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (offFrame) { offFrame(); offFrame = null; }
    if (tap) { try { tap.source.disconnect(); } catch { /* already gone with its context */ } tap = null; }
    if (tone) { tone.stop(); tone = null; }
    micflow.setListening(false);
    if (micflow.mic || micflow.state().phase === 'waiting' || micflow.state().phase === 'checking') micflow.stop();
    letting = false;
  }

  function end(result, words = '', role = '') {
    seq++;
    release();
    phase = 'idle';
    collector = null;
    barPct = -1;
    says = words; saysRole = role;
    paintChoice();
    paint();
    told();
    const done = settle;
    settle = null;
    if (done) done(result);
    // The press that began this is where the eyes are; the button is live again now.
    if (!dead && document.activeElement === cancelBtn) teachBtn.focus({ preventScroll: true });
  }

  function cancel(words = '') {
    if (!busy()) return;
    // Released before anyone is told: a listener to 'cancel' finds the microphone off.
    release();
    emit('cancel');
    end(null, words);
  }

  function finishCapture() {
    if (phase !== 'capture') return;
    const c = collector;
    // The microphone goes before the sums: nothing is open while the page thinks.
    release();
    const result = c.finish();
    if (!result.ok) { emit('refused', { reason: result.reason }); end(result, result.words, 'close'); return; }
    const { saved, record: rec } = saveOwnVoice(store, result);
    record = rec;
    unsaved = !saved;
    // Just taught, so it is switched on: the singer taught it in order to hear it.
    settings.set('noteSound', 'mine');
    emit('saved', { harmonics: result.harmonics });
    end(result, saved ? 'Saved. The note you copy now plays in your voice.' : 'Got it, for this visit: this browser would not save it.');
  }

  function capture(mine) {
    if (dead || mine !== seq) return;
    const mic = micflow.mic;
    if (!mic) { cancel('The microphone stopped. Press Teach to try again.'); return; }
    phase = 'capture';
    collector = createCollector({ sampleRate: mic.sampleRate, cfg: O });
    // Our own tap on the same stream: mic.js keeps a window sized for the pitch detector,
    // too short to tell a low voice's harmonics apart. Never connected to the speakers.
    const source = mic.ctx.createMediaStreamSource(mic.stream), analyser = mic.ctx.createAnalyser();
    analyser.fftSize = collector.windowSize;
    source.connect(analyser);
    tap = { source, analyser };
    const buffer = new Float32Array(collector.windowSize);
    const fromT = mic.ctx.currentTime + collector.windowSize / mic.sampleRate;
    offFrame = micflow.onFrame((frame) => {
      if (phase !== 'capture' || !collector) return;
      // Until one whole window has passed since listening began, the window still holds
      // sound from before it (the tail of the home note).
      if (mic.ctx.currentTime < fromT) return;
      analyser.getFloatTimeDomainData(buffer);
      collector.push(frame, buffer);
      paintBar();
      if (collector.voicedMs() >= O.captureMs) finishCapture();
    });
    timer = setTimeout(() => { timer = 0; finishCapture(); }, O.timeoutMs);
    micflow.setListening(true);
    emit('capture');
    paintBar();
    paint();
    told();
  }

  async function teach() {
    if (busy() || dead) return null;
    const mine = ++seq;
    phase = 'asking'; says = ''; saysRole = '';
    paint();
    told();
    emit('start');
    const waiting = new Promise((done) => { settle = done; });
    const stillMine = () => !dead && mine === seq;
    // The home note is a reference tone: the headphones question comes first, as before any
    // other (spec 10.4). With no home note nothing is played and nothing is asked.
    if (home !== null) {
      const phones = await shell.needHeadphones();
      if (!stillMine()) return waiting;
      if (!phones) { end(null, 'Say whether you are wearing headphones, then press Teach again.'); return waiting; }
    }
    const ok = await micflow.request(micOptions || {});
    if (!stillMine()) return waiting;
    if (!ok) { end(null, 'The microphone is not on yet.'); return waiting; }
    if (home === null) { capture(mine); return waiting; }
    let player = null;
    try { player = synth(); } catch { /* no sound here: sing without the note */ }
    if (!player) { capture(mine); return waiting; }
    phase = 'tone';
    micflow.setListening(false);
    paint();
    told();
    emit('tone');
    const plain = settings.get('tone') === 'sine' ? 'sine' : 'voice';
    tone = player.play({ midi: home, dur: O.toneSec, timbre: plain, gain: 0.5 * settings.get('toneVolume'), tag: 'tone' });
    tone.ended.then(() => new Promise((r) => setTimeout(r, O.toneTailMs))).then(() => {
      if (!stillMine() || phase !== 'tone') return;
      tone = null;
      capture(mine);
    });
    return waiting;
  }

  // ---- anything that takes the eyes off the page ends it, microphone released
  const onKey = (e) => { if (e.key === 'Escape' && (phase === 'tone' || phase === 'capture')) cancel('Stopped. The microphone is off.'); };
  // A sheet of our own asking (headphones, the microphone's first sheets) is not a reason.
  const onSheet = (e) => { if (e.detail.open && (phase === 'tone' || phase === 'capture')) cancel('Stopped. The microphone is off.'); };
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) cancel('Stopped. The microphone is off.'); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  const offState = micflow.subscribe((st) => {
    if (!letting && (phase === 'tone' || phase === 'capture') && (st.phase === 'lost' || st.phase === 'off')) cancel('The microphone stopped. Press Teach to try again.');
  });
  // The record is read again whenever the settings change ("Erase my data" tells every
  // setting) and after a restore, so an erased or replaced voice is never offered or played
  // from the copy read when this part was made. A voice the browser refused to save is kept
  // for the visit (finishCapture says so), so "nothing stored" does not take that one away.
  let unsaved = false;
  function reread() {
    if (busy()) return;
    const fresh = readOwnVoice(store);
    const next = fresh || (unsaved ? record : null);
    if (fresh) unsaved = false;
    if (JSON.stringify(next) === JSON.stringify(record)) return false;
    record = next;
    paintChoice();
    paint();
    told();
    return true;
  }
  const offSettings = settings.subscribe((k) => { if (!reread() && k === 'noteSound') { paintChoice(); told(); } });
  const onBackup = (e) => { if (e.detail && e.detail.type === 'restored') reread(); };
  document.addEventListener('mt:backup', onBackup);

  paintChoice();
  paint();

  return {
    el, teach, cancel, busy, state,
    record: () => record,
    destroy() {
      if (busy()) cancel();
      dead = true;
      seq++;
      offState(); offSettings();
      document.removeEventListener('mt:backup', onBackup);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      el.remove();
    },
  };
}
