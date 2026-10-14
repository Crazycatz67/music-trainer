// glide.js — the Glide warm-up and the Siren (spec docs/design/specs/2026-10-12-singing-trainer.md
// sections 7.1 and 7.4): their plans fitted to the saved range, how one pass is judged, and
// the words. PURE: imports in Node (tools/checks/glide.check.mjs). The screens are
// js/app/exercises/glide.js and js/app/exercises/siren.js; the path is drawn by stage.js.
//
// A glide is continuous but a timeline holds notes (contract), so each pass is written with
// js/timeline.js exercises.siren() as back-to-back semitone steps, up and back down, and the
// stage draws the smooth ribbon through them (stage.js ribbonFromTimeline).
//
// CONTRACT
//   RIBBON_DEFAULTS   { glide, siren } numbers below; every one is a first guess (tunable).
//       A screen reads config.glide / config.siren when config.js has them, else these.
//   ribbonPlan(kind, range?, cfg?, { fromPass = 0 }?) -> plan
//       kind 'glide' | 'siren'. range: js/app/range.js exerciseRange(saved) ({ lowMidi,
//       highMidi } or {}). cfg: RIBBON_DEFAULTS[kind]-shaped.
//       plan = { kind, low, high, fitted, timeline, ribbon, passes: [{ index, t0, t1 }], endSec }
//         low / high: whole notes, the path's lowest and highest centre. glide: a hill
//         cfg.spanSemis tall (narrower if the range is) in the middle of the range; siren: the
//         whole comfortable range (at least cfg.minSpanSemis). fitted false = no saved range,
//         cfg.defaultLow / defaultHigh were used. Times in seconds from the start of the
//         listening; the first pass starts at cfg.leadSec, passes are cfg.gapSec apart.
//         fromPass: plan only passes fromPass.. (Resume after a pause starts the next pass).
//   scorePass(frames, pass, ribbon, kind, cfg?, range?) -> score
//       frames [{ t, midi, voiced }] in the plan's clock (any order of arrival, sorted here).
//       score = { index, voicedShare, insideShare, aheadShare, coverShare, touched: [midi],
//                 breaks: [{ t, midi (the path there), near (the voice's last note) }],
//                 passed, why: null | 'sound' | 'path' | 'cover', whole }
//         voicedShare: seconds with a voice / the pass's length; insideShare: of those, inside
//         the path; aheadShare: of the voiced seconds, outside the path on the side it is
//         heading to (going too fast). coverShare (siren): share of the whole notes low..high
//         the voice passed through. breaks (siren): the sound cut out for cfg.breakGapMs or
//         jumped more than cfg.breakJumpSemis inside cfg.breakJumpMs. whole: siren covered
//         every note with no break.
//         glide passes with voicedShare >= cfg.minVoiced and insideShare >= cfg.minInside;
//         siren with coverShare >= cfg.minCover and voicedShare >= cfg.minVoiced.
//   passWords(score, kind, noteText?) -> { line, tip }    breakWords(breaks, noteText?) -> string
//   roundWords(scores, kind, total) -> string             WORDS
//   Failure: no frames -> every share 0, passed false, why 'sound'. Never throws on bad frames.

import { exercises } from '../timeline.js';
import { ribbonFromTimeline, ribbonMidiAt } from './stage.js';

export const RIBBON_DEFAULTS = Object.freeze({
  glide: Object.freeze({
    passes: 3,               // spec 7.1: 3 glides
    passSec: 8,              // low -> high -> low over 8 s
    gapSec: 2.5,             // a breath between glides (guess)
    leadSec: 2,              // the path is seen coming before the first glide starts (guess)
    spanSemis: 7,            // a fifth tall, the spec's "default span" (guess)
    defaultLow: 52,          // E3: no saved range yet (guess; a middle voice)
    halfSemis: 1.5,          // the band 3 semitones tall (spec 5.2)
    holdTopSec: 0.8,         // the top of the hill (guess)
    minVoiced: 0.7,          // spec 7.1 pass: sound for 70 % of the glide...
    minInside: 0.6,          // ...and inside the path 60 % of that time
    aheadTip: 0.25,          // "no rush" when this share of the sound runs ahead (guess)
    breakGapMs: 150,         // a dropout this long counts as the sound stopping (guess)
    breakJumpSemis: 3, breakJumpMs: 100,
    // Listening goes on this long after the last pass ends, so the round's result arrives
    // after the stage has eased its light away (aurora restAfterMs 250 + restOutMs 800): at
    // 0.4 s the end of the round landed in the middle of that fade, and the lab read 0.15 there.
    endGraceSec: 1.2,
  }),
  siren: Object.freeze({
    passes: 2,               // spec 7.4: twice
    passSec: 10,             // bottom -> top -> bottom over 10 s
    gapSec: 3,
    leadSec: 2,
    minSpanSemis: 5,         // a range narrower than this still gets a 5-note siren (guess)
    defaultLow: 50, defaultHigh: 64,   // D3 to E4: no saved range yet (guess)
    halfSemis: 1.5,
    holdTopSec: 0.6,
    minVoiced: 0.7,          // spec 7.4 pass: sound unbroken for 70 %...
    minCover: 0.8,           // ...and 80 % of the range covered
    aheadTip: 0.25,
    breakGapMs: 150,         // spec 7.4: "the sound cut out" (150 ms: shorter is the detector)
    breakJumpSemis: 3, breakJumpMs: 100,   // spec 7.4: "jumped more than 3 semitones inside 100 ms"
    endGraceSec: 1.2,
  }),
});

export const WORDS = Object.freeze({
  safety: 'Stay comfortable. Stop if your throat feels tight or sore.',
  glide: Object.freeze({
    name: 'Glide warm-up', unit: 'glide', units: 'glides',
    what: 'Hum or lip-trill, sliding smoothly from low to high and back. Follow the dot along the path. 3 glides.',
  }),
  siren: Object.freeze({
    name: 'Siren', unit: 'siren', units: 'sirens',
    what: 'One long "oo" or "ng" slide from the bottom of your comfortable range to the top and back. Follow the dot. Twice.',
  }),
  micWhen: 'The microphone turns on when you press Start and off when the last pass ends. No reference tone, so no headphones needed.',
  waiting: 'Get ready: the path starts at the now line.',
  following: 'Follow the dot.',
  breathe: 'Breathe. The next one is coming.',
  paused: 'Paused. The microphone is off. Press Resume to carry on from the next one.',
  stopped: 'Stopped. The microphone is off. Press Start when you are ready.',
  noRange: 'Fitted to a middle voice. Find your range first and this fits your own voice.',
  fitted: 'Fitted to your comfortable range.',
  passed: 'With the path. Smooth.',
  nearly: 'Nearly. Keep the sound going the whole way.',
  nearlyPath: 'Nearly. Stay inside the path as the dot moves.',
  nearlyCover: 'Nearly. Let the slide reach all the way up and down.',
  steady: 'Keep one steady hum, like a slow siren.',
  noRush: "Follow the dot; there's no rush.",
  whole: 'Whole range, unbroken',
});

const isNote = (x) => Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function placeGlide(range, cfg) {
  const lo = isNote(range.lowMidi) ? Math.ceil(range.lowMidi) : null, hi = isNote(range.highMidi) ? Math.floor(range.highMidi) : null;
  if (lo === null || hi === null || hi < lo) return { low: cfg.defaultLow, high: cfg.defaultLow + cfg.spanSemis, fitted: false };
  const span = Math.max(1, Math.min(cfg.spanSemis, hi - lo));
  const low = clamp(Math.round((lo + hi) / 2 - span / 2), lo, Math.max(lo, hi - span));
  return { low, high: low + span, fitted: true };
}

function placeSiren(range, cfg) {
  const lo = isNote(range.lowMidi) ? Math.ceil(range.lowMidi) : null, hi = isNote(range.highMidi) ? Math.floor(range.highMidi) : null;
  if (lo === null || hi === null || hi < lo) return { low: cfg.defaultLow, high: cfg.defaultHigh, fitted: false };
  if (hi - lo >= cfg.minSpanSemis) return { low: lo, high: hi, fitted: true };
  // Too narrow to slide in: widen evenly around its middle.
  const low = Math.round((lo + hi) / 2 - cfg.minSpanSemis / 2);
  return { low, high: low + cfg.minSpanSemis, fitted: true };
}

export function ribbonPlan(kind, range = {}, cfg = RIBBON_DEFAULTS[kind], { fromPass = 0 } = {}) {
  if (kind !== 'glide' && kind !== 'siren') throw new TypeError(`ribbonPlan: kind must be 'glide' or 'siren', not ${kind}`);
  const where = kind === 'glide' ? placeGlide(range || {}, cfg) : placeSiren(range || {}, cfg);
  const span = where.high - where.low;
  // exercises.siren: span steps up, a held top, span steps down; stepDur fills the pass.
  const stepDur = Math.max(0.05, (cfg.passSec - cfg.holdTopSec) / (2 * span));
  const holdTop = cfg.passSec - 2 * span * stepDur;
  const passes = [], notes = [];
  let t = cfg.leadSec;
  for (let i = Math.max(0, fromPass); i < cfg.passes; i++) {
    const tl = exercises.siren(where.low, { span, stepDur, holdTop, leadIn: t });
    notes.push(...tl.notes);
    passes.push({ index: i, t0: t, t1: t + cfg.passSec });
    t += cfg.passSec + cfg.gapSec;
  }
  const timeline = { title: WORDS[kind].name, source: 'exercise', notes };
  const ribbon = ribbonFromTimeline(timeline, { half: cfg.halfSemis });
  const last = passes[passes.length - 1];
  return { kind, low: where.low, high: where.high, fitted: where.fitted, timeline, ribbon, passes, endSec: last ? last.t1 + cfg.endGraceSec : cfg.leadSec };
}

export function scorePass(frames, pass, ribbon, kind, cfg = RIBBON_DEFAULTS[kind], range = null) {
  const half = ribbon ? ribbon.half : cfg.halfSemis;
  const len = Math.max(1e-6, pass.t1 - pass.t0);
  const fs = (Array.isArray(frames) ? frames : [])
    .filter((f) => f && Number.isFinite(f.t) && f.t >= pass.t0 && f.t <= pass.t1)
    .sort((a, b) => a.t - b.t);
  let voicedSec = 0, insideSec = 0, aheadSec = 0;
  const touched = new Set(), breaks = [];
  let lastVoiced = null, quietFrom = null;
  const addBreak = (t, near) => {
    const prev = breaks[breaks.length - 1];
    if (prev && t - prev.t < 0.3) return;          // one stumble, one marker
    const m = ribbonMidiAt(ribbon, t);
    breaks.push({ t, midi: m === null ? near : m, near: Math.round(near) });
  };
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i];
    const next = fs[i + 1];
    // Each reading stands for the time until the next, capped so a stalled stream is not sound.
    const dt = Math.min(0.1, Math.max(0, (next ? next.t : f.t + 0.02) - f.t));
    const voiced = !!f.voiced && Number.isFinite(f.midi);
    if (!voiced) { if (lastVoiced && quietFrom === null) quietFrom = f.t; continue; }
    if (quietFrom !== null && lastVoiced && (f.t - quietFrom) * 1000 >= cfg.breakGapMs) addBreak(quietFrom, lastVoiced.midi);
    else if (lastVoiced && quietFrom === null && f.t - lastVoiced.t <= cfg.breakJumpMs / 1000 && Math.abs(f.midi - lastVoiced.midi) > cfg.breakJumpSemis) addBreak(f.t, lastVoiced.midi);
    quietFrom = null;
    voicedSec += dt;
    touched.add(Math.round(f.midi));
    const c = ribbonMidiAt(ribbon, f.t);
    if (c !== null) {
      const off = f.midi - c;
      if (Math.abs(off) <= half) insideSec += dt;
      else {
        // Ahead: outside on the side the path is heading (climbing and above, or falling and below).
        const slope = (ribbonMidiAt(ribbon, Math.min(pass.t1, f.t + 0.05)) ?? c) - (ribbonMidiAt(ribbon, Math.max(pass.t0, f.t - 0.05)) ?? c);
        if (Math.abs(slope) > 1e-3 && Math.sign(slope) === Math.sign(off)) aheadSec += dt;
      }
    }
    lastVoiced = { t: f.t, midi: f.midi };
  }
  const voicedShare = Math.min(1, voicedSec / len), insideShare = voicedSec > 0 ? insideSec / voicedSec : 0;
  const lo = range && isNote(range.low) ? range.low : ribbon && isNote(ribbon.low) ? Math.round(ribbon.low) : null;
  const hi = range && isNote(range.high) ? range.high : ribbon && isNote(ribbon.high) ? Math.round(ribbon.high) : null;
  let coverShare = 0;
  if (lo !== null && hi !== null && hi >= lo) {
    let n = 0;
    for (let m = lo; m <= hi; m++) if (touched.has(m)) n++;
    coverShare = n / (hi - lo + 1);
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  let why = null;
  if (kind === 'siren') why = voicedShare < cfg.minVoiced ? 'sound' : coverShare < cfg.minCover ? 'cover' : null;
  else why = voicedShare < cfg.minVoiced ? 'sound' : insideShare < cfg.minInside ? 'path' : null;
  return {
    index: pass.index, voicedShare: r3(voicedShare), insideShare: r3(insideShare), aheadShare: r3(voicedSec > 0 ? aheadSec / voicedSec : 0),
    coverShare: r3(coverShare), touched: [...touched].sort((a, b) => a - b), breaks: kind === 'siren' ? breaks : [],
    passed: why === null, why, whole: kind === 'siren' && coverShare >= 1 && breaks.length === 0 && why === null,
  };
}

const COUNT = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];
const listJoin = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// noteText(midi) -> the note's name in the singer's chosen style (stage.js displayNote).
export function breakWords(breaks, noteText = (m) => String(m)) {
  const n = (breaks || []).length;
  if (!n) return '';
  const near = [...new Set(breaks.map((b) => noteText(b.near)))].slice(0, 3);
  if (n === 1) return `One break near ${near[0]}. That's normal; slide through it more slowly.`;
  return `${COUNT[n] || n} breaks, near ${listJoin(near)}. That's normal; slide through them more slowly.`;
}

export function passWords(score, kind, noteText) {
  const tip = score.breaks && score.breaks.length ? breakWords(score.breaks, noteText)
    : score.aheadShare >= RIBBON_DEFAULTS[kind].aheadTip ? WORDS.noRush
      : score.why === 'sound' ? WORDS.steady : '';
  const line = score.passed ? WORDS.passed : score.why === 'sound' ? WORDS.nearly : score.why === 'cover' ? WORDS.nearlyCover : WORDS.nearlyPath;
  return { line, tip };
}

export function roundWords(scores, kind, total) {
  const w = WORDS[kind];
  const done = scores.filter(Boolean), stars = done.filter((s) => s.passed).length;
  return `${stars} of ${total} ${total === 1 ? w.unit : w.units} with the path`;
}
