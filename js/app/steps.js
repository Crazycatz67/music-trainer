// steps.js — Star steps (four-note patterns) and Leaps and scales: what to sing and how each
// note went (docs/design/specs/2026-10-15-patterns-intervals-scales.md, sections 2 to 5 and 9).
// THE LOGIC HALF: no DOM, no sound, no storage, runs in Node (tools/checks/steps.check.mjs).
// The screen (js/app/exercises/steps.js, slice SS3) plays the items, feeds the microphone's
// readings in and draws what this answers. "In one breath" (a later constellation mode) reuses
// judgeNote, so the note judge lives here and nowhere else.
//
// CONTRACT
//   range = { lowMidi, highMidi, home } as exerciseRange(readRange()) gives it ({} = none saved)
//   reading = { t, midi | null }   seconds on the item's own timeline clock, null = no pitch
//   note    = { t, dur, midi }     a timeline note
//
//   STEPS_DEFAULTS                 every number below; pass a copy with changes as `cfg`
//   timing(bpm, cfg?) -> { bpm, beat, noteDur, gap, leapNoteDur, leapRest }   seconds; bpm
//       clamped to cfg.minBpm..cfg.maxBpm (40..90), anything not a number -> cfg.bpm (60)
//   fitRange(range, cfg?) -> { lowMidi, highMidi, home, span, fitted }   no usable range ->
//       the defaults 52..59, home 52, fitted false. home is kept inside lowMidi..highMidi.
//   patternRound(range, { day, bpm }?, cfg?) -> round
//   leapRound(range, { bpm, big }?, cfg?) -> round     big: bigLeapsEarned(...) was true
//       round = { kind: 'star-steps' | 'leaps', range: fitRange(...), lines: [string],
//                 items: [item] }
//       item  = { kind: 'pattern' | 'leap' | 'scale', n (1-based of its kind), of, label,
//                 offsets, start, up (leap only), timeline, fits }
//       lines: the plain lines under the title (not fitted / narrow / scale left out).
//       Every note of every item lies in range.lowMidi..highMidi (fits true) unless the span
//       is under 2 semitones, where nothing can fit: the item is still made, fits false.
//   judgeNote(readings, note, cfg?) -> judged
//       judged = { verdict: 'in' | 'close' | 'off' | 'none', median (whole folded cents | null),
//                  dir: 'low' | 'high' | null, octave: -1 | 0 | 1 (most readings' octave
//                  from the target; 0 when none), n, voiced }
//   itemResult(item, judged[], { tryNo = 0 }?, cfg?) -> result
//       result = { kind, n, notes (verdicts), medians (sung notes' cents), inTune, star, retry,
//                  bias ('low' | 'high' | null), octave, line }
//       retry only on a first try (tryNo 0): pattern under 3 in tune, leap target not in tune.
//   roundResult(results, { kind, best }?, cfg?) -> summary   results = the LAST try of each item
//       summary = { kind, stars, of, notesIn, notesTotal, bias, lines, starWords,
//                   firstTime, newBest, bestLine, leaps, leapsInTune }
//   bigLeapsEarned(previous) -> boolean   previous = earlier leap summaries, newest last:
//       the last two both had every leap in tune (spec 3: the list grows to the octave)
//   STEPS_WORDS                    every line on screen (spec 9); Tony polishes wording here.
//
// Failure behaviour: no input throws for missing or odd readings (they count as not heard);
// a bad range falls back to the defaults. timeline.js throws only on a bad start note, which
// fitRange makes impossible.

import { exercises, createTimeline } from '../timeline.js';
import { foldCents } from './song/lineresults.js';
import { CONFIG } from './config.js';

export const STEPS_DEFAULTS = Object.freeze({
  // Match and hold's defaults, a GUESS until the person finds their range (spec 3).
  lowMidi: 52, highMidi: 59,
  bpm: 60, minBpm: 40, maxBpm: 90,
  gap: 0.1,               // fixed at every tempo: > joinGapSec 0.05 keeps each note its own bar
  // Spec 3: original shapes, scale steps only. The two span-2 shapes are for narrow voices.
  patterns: Object.freeze([[0, 2, 4, 2], [4, 2, 0, 2], [0, 4, 2, 0], [0, 2, 4, 5]].map(Object.freeze)),
  narrowPatterns: Object.freeze([[0, 2, 0, 2], [2, 0, 2, 0]].map(Object.freeze)),
  narrowSpan: 4,          // span under this: only the narrow shapes
  walk: 4,                // patterns per round, each one semitone on
  leaps: Object.freeze([2, 4, 5, 7]),
  bigLeaps: Object.freeze([4, 5, 7, 12]),
  scale: Object.freeze([0, 2, 4, 5, 7, 5, 4, 2, 0]),
  scaleSpan: 7,
  // Judging (spec 5): the middle 70 % of a note, a hair late, octave-folded.
  edgeShare: 0.15,        // the first 15 % is where scoops happen; the last is the let-go
  lagSec: 0.1,            // songs lineStars.lagSec; GUESS for the owner's microphone
  minReadings: 8,
  minSungShare: 0.2,
  inTuneCents: CONFIG.verdict.inTuneCents,   // 25
  closeCents: CONFIG.verdict.closeCents,     // 50
  withShare: 0.7,
  closeShare: 0.4,
  biasCents: CONFIG.matchhold.biasCents,     // 8
  patternStar: 3,         // of 4 in tune
  scaleStar: 7,           // of 9 in tune
});

// ---- words (spec 9). Nothing here says fail, wrong or error, and no cents. ----------------

const listNotes = (ns) => (ns.length === 1 ? `${ns[0]}` : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

export const STEPS_WORDS = Object.freeze({
  chips: Object.freeze({ listen: 'Listen', imagine: 'Hear it in your head', countIn: (k) => `Sing in ${k}`, sing: 'Sing', paused: 'Paused' }),
  progress: Object.freeze({
    pattern: (n, of) => `Pattern ${n} of ${of}`,
    leap: (n, of) => `Leap ${n} of ${of}`,
    scale: () => 'The scale',
  }),
  again: 'Once more, same notes.',
  notFitted: 'Not fitted to your voice yet.',
  findRange: 'Find your range',
  narrow: 'Your measured range is narrow, so the steps stay small.',
  noScale: 'The scale is left out today: it needs a little more range than you measured.',
  inTune: (k, of) => `${k} of ${of} in tune.`,
  nothing: 'Nothing heard on that one.',
  // subject: "Note 3" / "Notes 2 and 4" / "The top note"; plural picks was/were.
  detail: (subject, plural, what) => `${subject} ${plural ? 'were' : 'was'} ${what}.`,
  what: Object.freeze({
    close: (dir) => `a little ${dir}`,
    off: (dir) => (dir === 'low' ? 'too low: go up' : 'too high: come down'),
    none: () => 'not heard',
  }),
  notes: (ns) => { const l = [].concat(ns); return l.length === 1 ? `Note ${l[0]}` : `Notes ${listNotes(l)}`; },
  topNote: 'The top note',
  landed: 'The jump landed.',
  landedNear: (dir) => `The jump landed a little ${dir}.`,
  short: (up) => `The jump fell short: aim ${up ? 'higher' : 'lower'}.`,
  // Not in spec 9 (it only names falling short): an overshoot needs its own plain words.
  past: (up) => `The jump went past the note: aim ${up ? 'lower' : 'higher'}.`,
  octave: (dir) => `You sang it an octave ${dir === 'low' ? 'lower' : 'higher'}. That counts.`,
  roundDone: 'Round done',
  roundNotes: (k, of) => `${k} of ${of} notes in tune.`,
  bias: Object.freeze({ low: 'Mostly a little low.', high: 'Mostly a little high.', none: 'On the note most of the time.' }),
  stars: (k) => `${k} ${k === 1 ? 'star' : 'stars'}`,
  newBest: (k, was) => `New best: ${STEPS_WORDS.stars(k)} (was ${was}).`,
  starWord: (label, k, of) => `${label}: ${k} of ${of} in tune`,
});

// ---- plans ---------------------------------------------------------------------------------

const isMidi = (m) => Number.isFinite(m);

export function timing(bpm, cfg = STEPS_DEFAULTS) {
  const b = Number.isFinite(bpm) ? Math.min(cfg.maxBpm, Math.max(cfg.minBpm, bpm)) : cfg.bpm;
  const beat = 60 / b;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // One beat per note (spec 4); leaps get two beats a note and a beat's rest after the pair.
  return { bpm: b, beat: r3(beat), noteDur: r3(beat - cfg.gap), gap: cfg.gap, leapNoteDur: r3(2 * beat - cfg.gap), leapRest: r3(beat + cfg.gap) };
}

export function fitRange(range, cfg = STEPS_DEFAULTS) {
  const r = range && typeof range === 'object' ? range : {};
  const ok = isMidi(r.lowMidi) && isMidi(r.highMidi) && r.highMidi >= r.lowMidi;
  const lowMidi = ok ? Math.round(r.lowMidi) : cfg.lowMidi;
  const highMidi = ok ? Math.round(r.highMidi) : cfg.highMidi;
  const home0 = ok && isMidi(r.home) ? Math.round(r.home) : lowMidi;
  const home = Math.min(highMidi, Math.max(lowMidi, home0));
  return { lowMidi, highMidi, home, span: highMidi - lowMidi, fitted: ok };
}

const spanOf = (offs) => Math.max(...offs) - Math.min(...offs);
const notesFit = (tl, r) => tl.notes.every((n) => n.midi >= r.lowMidi && n.midi <= r.highMidi);

// Whole days since 1970 from 'YYYY-MM-DD' (sessions.dayKey), so the shape moves on by one
// each day. Anything else -> day 0 (the first shape).
function dayNumber(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : 0;
}

function titleLines(r, cfg) {
  const lines = [];
  if (!r.fitted) lines.push(STEPS_WORDS.notFitted);
  return lines;
}

export function patternRound(range, { day, bpm } = {}, cfg = STEPS_DEFAULTS) {
  const r = fitRange(range, cfg);
  const tm = timing(bpm, cfg);
  const narrow = r.span < cfg.narrowSpan;
  const pool = narrow ? cfg.narrowPatterns : cfg.patterns;
  const offsets = [...pool[((dayNumber(day) % pool.length) + pool.length) % pool.length]];
  const p = spanOf(offsets);
  const top = r.highMidi - p;   // highest start whose pattern still fits
  // Walk up from home; if the last pattern would pass the top, walk down instead (spec 3).
  // Either walk is then held inside the range: a narrow voice repeats the highest start that fits.
  // A home too high for the shape walks down from the highest start that fits.
  const up = r.home + (cfg.walk - 1) <= top;
  const base = up ? r.home : Math.min(r.home, top);
  const items = [];
  for (let i = 0; i < cfg.walk; i++) {
    const want = up ? base + i : base - i;
    const start = Math.max(r.lowMidi, Math.min(top, want));
    const timeline = exercises.fourNote(start, { pattern: offsets, noteDur: tm.noteDur, gap: tm.gap, rest: 0 });
    items.push({ kind: 'pattern', n: i + 1, of: cfg.walk, label: STEPS_WORDS.progress.pattern(i + 1, cfg.walk), offsets, start, timeline, fits: notesFit(timeline, r) });
  }
  const lines = titleLines(r, cfg);
  if (r.fitted && narrow) lines.push(STEPS_WORDS.narrow);
  return { kind: 'star-steps', range: r, timing: tm, lines, items };
}

export function leapRound(range, { bpm, big = false } = {}, cfg = STEPS_DEFAULTS) {
  const r = fitRange(range, cfg);
  const tm = timing(bpm, cfg);
  // Each leap goes up from home if it fits, else down, else it is dropped (spec 3).
  const place = (size) => (r.home + size <= r.highMidi ? size : r.home - size >= r.lowMidi ? -size : null);
  const fitAll = (list) => list.map(place);
  // The octave list only when every leap of it fits; otherwise the usual list.
  let sizes = big ? fitAll(cfg.bigLeaps) : null;
  if (!sizes || sizes.some((s) => s === null)) sizes = fitAll(cfg.leaps);
  let kept = sizes.filter((s) => s !== null);
  // The smallest leap is always kept, even when nothing fits (a span under 2).
  if (!kept.length) kept = [cfg.leaps[0]];
  const items = kept.map((iv, i) => {
    const timeline = exercises.intervals(r.home, { intervals: [iv], noteDur: tm.leapNoteDur, gap: tm.gap, rest: tm.leapRest });
    return { kind: 'leap', n: i + 1, of: kept.length, label: STEPS_WORDS.progress.leap(i + 1, kept.length), offsets: [0, iv], start: r.home, up: iv > 0, timeline, fits: notesFit(timeline, r) };
  });
  const lines = titleLines(r, cfg);
  const scaleTop = cfg.scale.reduce((a, b) => Math.max(a, b), 0);
  if (r.span >= cfg.scaleSpan) {
    const start = Math.min(r.home, r.highMidi - scaleTop);
    // fourNote takes any list of offsets: one pass, no repeats, is the 5-note scale up and back.
    const tl = exercises.fourNote(start, { pattern: [...cfg.scale], noteDur: tm.noteDur, gap: tm.gap, rest: 0 });
    const timeline = createTimeline({ ...tl, title: 'Scale' });
    items.push({ kind: 'scale', n: 1, of: 1, label: STEPS_WORDS.progress.scale(), offsets: [...cfg.scale], start, timeline, fits: notesFit(timeline, r) });
  } else if (r.fitted) {
    lines.push(STEPS_WORDS.noScale);
  }
  return { kind: 'leaps', range: r, timing: tm, lines, items };
}

// ---- judging -------------------------------------------------------------------------------

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function judgeNote(readings, note, cfg = STEPS_DEFAULTS) {
  const none = (n = 0, voiced = 0) => ({ verdict: 'none', median: null, dir: null, octave: 0, n, voiced });
  if (!note || !isMidi(note.midi) || !Number.isFinite(note.t) || !(note.dur > 0)) return none();
  const a = note.t + cfg.edgeShare * note.dur + cfg.lagSec;
  const b = note.t + note.dur - cfg.edgeShare * note.dur + cfg.lagSec;
  const inWin = (Array.isArray(readings) ? readings : []).filter((x) => x && Number.isFinite(x.t) && x.t >= a && x.t <= b);
  const raw = inWin.filter((x) => isMidi(x.midi)).map((x) => 100 * (x.midi - note.midi));
  const n = inWin.length, voiced = raw.length;
  if (n < cfg.minReadings || voiced / n < cfg.minSungShare) return none(n, voiced);
  const folded = raw.map(foldCents);
  const med = median(folded);
  const within = folded.filter((c) => Math.abs(c) <= cfg.closeCents).length / voiced;
  const octave = Math.sign(Math.round(median(raw.map((c, i) => (c - folded[i]) / 1200))));
  const verdict = Math.abs(med) <= cfg.inTuneCents && within >= cfg.withShare ? 'in'
    : Math.abs(med) <= cfg.closeCents || within >= cfg.closeShare ? 'close' : 'off';
  return { verdict, median: Math.round(med), dir: med < 0 ? 'low' : med > 0 ? 'high' : null, octave, n, voiced };
}

// ---- item and round results ----------------------------------------------------------------

const biasOf = (meds, cfg) => {
  if (!meds.length) return null;
  const m = meds.reduce((s, x) => s + x, 0) / meds.length;
  return m < -cfg.biasCents ? 'low' : m > cfg.biasCents ? 'high' : null;
};

// One sentence about the notes that missed: the off ones first (they matter most), then the
// close ones, then the unheard; within that, the biggest group sharing a direction.
function missDetail(item, judged) {
  for (const kind of ['off', 'close', 'none']) {
    const groups = new Map();
    judged.forEach((j, i) => {
      if (j.verdict !== kind) return;
      const key = kind === 'none' ? 'none' : j.dir || 'low';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i + 1);
    });
    if (!groups.size) continue;
    const [dir, ns] = [...groups.entries()].sort((x, y) => y[1].length - x[1].length || x[1][0] - y[1][0])[0];
    const topIdx = item.kind === 'scale' ? item.offsets.indexOf(Math.max(...item.offsets)) + 1 : 0;
    const subject = ns.length === 1 && ns[0] === topIdx ? STEPS_WORDS.topNote : STEPS_WORDS.notes(ns);
    return STEPS_WORDS.detail(subject, ns.length > 1, STEPS_WORDS.what[kind](dir));
  }
  return '';
}

export function itemResult(item, judged, { tryNo = 0 } = {}, cfg = STEPS_DEFAULTS) {
  const js = Array.isArray(judged) ? judged : [];
  const notes = js.map((j) => j.verdict);
  const inTune = notes.filter((v) => v === 'in').length;
  const sung = js.filter((j) => j.verdict !== 'none');
  const medians = sung.map((j) => j.median);
  const bias = biasOf(medians, cfg);
  const oct = sung.find((j) => j.octave && (j.verdict === 'in' || j.verdict === 'close'));
  const octave = oct ? oct.octave : 0;
  let star, retry = false, line;
  if (!sung.length) line = STEPS_WORDS.nothing;
  if (item.kind === 'leap') {
    const root = js[0] || {}, target = js[1] || {};
    star = target.verdict === 'in' && root.verdict !== 'off';
    retry = target.verdict !== 'in';
    if (!line) {
      if (target.verdict === 'in') line = STEPS_WORDS.landed;
      else if (target.verdict === 'close') line = STEPS_WORDS.landedNear(target.dir || 'low');
      else if (target.verdict === 'off') line = (target.dir === 'low') === item.up ? STEPS_WORDS.short(item.up) : STEPS_WORDS.past(item.up);
      else line = STEPS_WORDS.detail(STEPS_WORDS.notes([2]), false, STEPS_WORDS.what.none());
    }
  } else {
    const need = item.kind === 'scale' ? cfg.scaleStar : cfg.patternStar;
    star = inTune >= need;
    retry = item.kind === 'pattern' && inTune < need;
    if (!line) line = [STEPS_WORDS.inTune(inTune, js.length), inTune < js.length ? missDetail(item, js) : ''].filter(Boolean).join(' ');
  }
  // At most one retry per item (spec 2.7): the first try and one more, then it moves on.
  return { kind: item.kind, n: item.n, notes, medians, inTune, star, retry: retry && tryNo === 0, bias, octave, line };
}

export function roundResult(results, { kind, best = null } = {}, cfg = STEPS_DEFAULTS) {
  const rs = Array.isArray(results) ? results : [];
  const stars = rs.filter((r) => r.star).length;
  const notesIn = rs.reduce((s, r) => s + r.inTune, 0);
  const notesTotal = rs.reduce((s, r) => s + r.notes.length, 0);
  // Spec 5: the mean of the sung notes' medians, over the whole round.
  const bias = biasOf(rs.flatMap((r) => r.medians || []), cfg);
  const lines = [STEPS_WORDS.roundNotes(notesIn, notesTotal), STEPS_WORDS.bias[bias || 'none']];
  const labelOf = (r) => (r.kind === 'scale' ? 'The scale' : `${r.kind === 'leap' ? 'Leap' : 'Pattern'} ${r.n}`);
  const starWords = rs.map((r) => STEPS_WORDS.starWord(labelOf(r), r.inTune, r.notes.length));
  const firstTime = !Number.isFinite(best);
  const newBest = !firstTime && stars > best;
  const leapRs = rs.filter((r) => r.kind === 'leap');
  return {
    kind, stars, of: rs.length, notesIn, notesTotal, bias, lines, starWords, firstTime, newBest,
    bestLine: newBest ? STEPS_WORDS.newBest(stars, best) : '',
    leaps: leapRs.length, leapsInTune: leapRs.filter((r) => r.notes[1] === 'in').length,
  };
}

export function bigLeapsEarned(previous) {
  const last = (Array.isArray(previous) ? previous : []).slice(-2);
  return last.length === 2 && last.every((s) => s && s.leaps >= 4 && s.leapsInTune === s.leaps);
}
