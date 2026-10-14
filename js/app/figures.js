// figures.js — Sing a constellation: the star figures and every rule about them that needs
// no browser (docs/design/specs/2026-10-12-sing-a-constellation.md sections 3, 4, 5, 5.3, 6).
// A figure is a short tune in scale degrees; its picture IS the tune (higher star = higher
// note, left to right = singing order).
//
// PURE: imports in Node (tools/checks/figures.check.mjs). No browser global is touched.
//
// CONTRACT
//   FIGURES                    the 12 starter figures, easiest first:
//                              { id, name, degrees: [1..8], closing: [[i, j]] } (frozen)
//   figureById(id) -> figure | null        nextFigure(id) -> the one after it | null
//   semitonesOf(figure) -> [semitones above the home note], major scale (1 = home = 0)
//   plainLine(figure) -> "5 notes · steps" | "· skips" | "· one big leap" | "· a full octave"
//   placeFigure(figure, { lowMidi, highMidi, home? }) -> { home, midis, fits, over }
//       An end that is not a finite note in 21..96 (or no range at all) uses the default.
//       home given (finite): that placing is kept and only measured; over then counts the
//       notes outside the range at either end.
//       prefer (finite; the singer's home note, js/app/range.js): the figure starts there
//       when it then fits the range, so figures share one key; when it does not fit,
//       prefer is ignored and the figure is placed as described next.
//       Whole MIDI notes. The figure sits in the middle of lowMidi..highMidi. Wider than the
//       range: it starts at the bottom and spills over the top; over = whole notes above
//       highMidi (0 when it fits). Nothing is ever refused.
//   fieldLayout({ width, height, midis, gutter?, cfg? }) -> layout
//       CSS pixels, y down. { plotX, plotW, pxPerNote, x: [per star], y: [per star],
//       yOfMidi(m), lanes: [the figure's own pitches, low to high] }
//       x[i] = plotX + (i + 0.5) * plotW / n. A higher note has a smaller y; equal notes
//       have equal y. pxPerNote = clamp(fillFrac * height / max(span, minSpanSemis), min, max).
//   createThread(points = 24) -> thread          the line a hold reels out (spec 5.3)
//       thread.push(progress, cents)   one in-tune reading at ring fill `progress` (0..1)
//       thread.trim(progress)          the ring drained to `progress`: what was stored
//                                      beyond it is gone
//       thread.values() -> [points × (median cents | null)]
//       thread.record() -> [points × number]   gaps filled from the reading before them;
//                                              the saved line. Rounded to 0.1 cents.
//       thread.reset()
//   threadPoints({ from, to, cents, progress = 1, pxPerNote }) -> [{ x, y, f }]
//       from, to: { x, y } of the two stars. The straight line between them plus, at each
//       stored point, how far the voice was from the target (cents, at the field's true
//       scale: +20 cents is 0.2 * pxPerNote ABOVE the line). f = fraction of the gap; the
//       first point is the `from` star itself, the last is at exactly f = progress.
//   createFigureRound(count, saved?) -> round        the take, star by star
//       saved: { lit: [boolean], looks: [look | null], lines: [[cents] | null] } to carry on.
//       Every star lit in `saved`: the round starts at 'done' (nothing left to sing).
//       round.state() -> { phase, mode, index, count, lit, looks, lines, open, solid,
//                          octaveSemis, complete }
//         phase  'ready' | 'shape' | 'listen' | 'sing' | 'result' | 'done'
//         mode   'run' (left to right) | 'open' (one skipped star, lit later)
//         lines[i] joins star i and star i + 1: the 24 cents values, or null (not drawn yet)
//         solid[i]  both of line i's stars are lit (otherwise it stays dotted)
//         open   indexes of the stars not lit
//       round.start()        ready -> shape (the whole tune is heard first)
//       round.shapeEnded()   shape -> listen on the first star not lit, or done if none
//       round.replayShape()  sing -> shape; shapeEnded() then returns to the SAME star
//       round.toneEnded()    listen -> sing
//       round.replay()       sing -> listen (same star)
//       round.landed({ look, line })  sing -> result; the star is lit, `line` (the thread's
//                            record, or null for the first star) is kept as lines[index - 1]
//       round.next()         result -> listen on the next star not lit, or done.
//                            In 'open' mode: always done.
//       round.skip()         listen | sing -> the same move, the star stays hollow
//       round.stop()         shape | listen | sing | result -> done
//       round.lightOpen()    done with a star open -> listen on one open star (mode 'open'):
//                            the first one after the star offered last time, else the first.
//                            Lit stars and lines are kept.
//       round.again()        done -> ready with every star hollow (a fresh take)
//       round.useOctave(dir) 'lower' | 'higher': the whole figure moves 12 notes
//       A call that does not fit the phase changes nothing. Each returns state().
//   nextSaved(prev, take, { id, home, nowIso }) -> { record, firstTime }
//       What is stored after a landing or at the end of a take. A figure that was once
//       completed is only replaced by another COMPLETE take (its stars are never taken
//       away); an unfinished figure keeps every star lit so far.
//       record: { id, home, stars: [look | null], lines, completedAt, lastSungAt, timesSung }
//   readSaved(text) -> { [id]: record }    never throws; anything unreadable is dropped
//   SAVED_KEY                  'music-trainer.constellations.v1'
//   Words (spec section 12, exact): singLine, litLine, doneLine, fieldLabel, cardStateLine,
//       overChip, WORDS, FIGURE_HINTS (under / over / low / high: this screen's hint sentences)
//   thumbPoints(figure, w, h, pad?) -> [{ x, y }]   the picker's small drawing

import { CONFIG } from './config.js';
import { heldText } from './holdring.js';

const MAJOR = Object.freeze([0, 2, 4, 5, 7, 9, 11, 12]);

const fig = (id, name, degrees, closing = []) => Object.freeze({ id, name, degrees: Object.freeze(degrees), closing: Object.freeze(closing.map((c) => Object.freeze(c))) });

// Original tunes made only from scale steps (spec section 4). Never a tune from a real song.
export const FIGURES = Object.freeze([
  fig('slope', 'The Slope', [1, 2, 3]),
  fig('hook', 'The Hook', [1, 2, 3, 2]),
  fig('hill', 'The Hill', [1, 2, 3, 2, 1]),
  fig('ripple', 'The Ripple', [1, 2, 1, 2, 1, 2]),
  fig('steps', 'The Steps', [1, 1, 2, 2, 3, 3]),
  fig('ridge', 'The Ridge', [1, 2, 3, 4, 5]),
  fig('peak', 'The Peak', [1, 3, 5, 3, 1]),
  fig('cassiopeia', 'Cassiopeia', [3, 1, 2, 1, 3]),
  fig('arrow', 'The Arrow', [1, 5, 4, 3, 2]),
  fig('dipper', 'The Dipper', [5, 4, 3, 1, 1, 3], [[2, 5]]),
  fig('crown', 'The Crown', [5, 3, 2, 1, 2, 3, 5]),
  fig('spire', 'The Spire', [1, 3, 5, 8, 5, 3, 1]),
]);

export const figureById = (id) => FIGURES.find((f) => f.id === id) || null;

export function nextFigure(id) {
  const i = FIGURES.findIndex((f) => f.id === id);
  return i >= 0 && i + 1 < FIGURES.length ? FIGURES[i + 1] : null;
}

export const semitonesOf = (figure) => figure.degrees.map((d) => MAJOR[d - 1]);

export function plainLine(figure) {
  const semis = semitonesOf(figure);
  let leap = 0;
  for (let i = 1; i < semis.length; i++) leap = Math.max(leap, Math.abs(semis[i] - semis[i - 1]));
  const what = figure.degrees.includes(8) ? 'a full octave' : leap >= 7 ? 'one big leap' : leap >= 3 ? 'skips' : 'steps';
  return `${semis.length} notes · ${what}`;
}

// An end of the range that is not a real singable note (null, NaN, Infinity, outside the
// piano's 21..96) falls back to the default: `null` used to place the figure at MIDI 0, and
// NaN made NaN notes that the synth then threw on (bugs.md 38).
const rangeEnd = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 21 && v <= 96 ? v : fallback);

export function placeFigure(figure, range) {
  const r = range && typeof range === 'object' ? range : {};
  const semis = semitonesOf(figure);
  const lo = Math.round(rangeEnd(r.lowMidi, CONFIG.matchhold.defaultLowMidi));
  const hi = Math.max(lo, Math.round(rangeEnd(r.highMidi, CONFIG.matchhold.defaultHighMidi)));
  const min = Math.min(...semis), max = Math.max(...semis);
  const room = (hi - lo) - (max - min);
  // `home` given (a figure half sung on another day keeps its place): report how THAT
  // placing sits in the range, instead of choosing one.
  const prefer = typeof r.prefer === 'number' && Number.isFinite(r.prefer) ? Math.round(r.prefer) : null;
  const onPrefer = prefer !== null && prefer + min >= lo && prefer + max <= hi;
  const home = Number.isFinite(r.home) ? Math.round(r.home) : onPrefer ? prefer : room >= 0 ? lo + Math.round(room / 2) - min : lo - min;
  const midis = semis.map((s) => home + s);
  // A given home can sit under the range as well as over it; a chosen one never does.
  const over = Math.max(0, Math.max(...midis) - hi, lo - Math.min(...midis));
  return { home, midis, fits: over === 0, over };
}

export function fieldLayout({ width, height, midis, gutter = CONFIG.stage.gutterPx, cfg = CONFIG.constellation }) {
  const n = midis.length;
  const min = Math.min(...midis), max = Math.max(...midis);
  const pxPerNote = Math.min(cfg.pxPerNoteMax, Math.max(cfg.pxPerNoteMin, (cfg.fillFrac * height) / Math.max(max - min, cfg.minSpanSemis)));
  const mid = (min + max) / 2;
  const yOfMidi = (m) => height / 2 - (m - mid) * pxPerNote;
  const plotX = gutter, plotW = Math.max(1, width - gutter);
  return {
    plotX, plotW, pxPerNote, yOfMidi,
    x: midis.map((_, i) => plotX + ((i + 0.5) * plotW) / n),
    y: midis.map(yOfMidi),
    lanes: [...new Set(midis)].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------- the thread

const median = (list) => {
  const a = [...list].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function createThread(points = CONFIG.constellation.linePoints) {
  let buckets = Array.from({ length: points }, () => []);
  const values = () => buckets.map((b) => (b.length ? median(b) : null));
  return {
    push(progress, cents) {
      if (!Number.isFinite(progress) || !Number.isFinite(cents)) return;
      buckets[Math.min(points - 1, Math.max(0, Math.floor(progress * points)))].push(cents);
    },
    // A slice of the hold that starts at or beyond the ring's fill has been un-held.
    trim(progress) {
      const keep = Math.max(0, Math.ceil(Math.min(1, Math.max(0, progress)) * points - 1e-9));
      for (let k = keep; k < points; k++) if (buckets[k].length) buckets[k] = [];
    },
    values,
    record() {
      const v = values();
      // A slice with no reading (a slow frame) takes the height beside it: never a hole.
      let lastKnown = v.find((c) => c !== null) ?? 0;
      return v.map((c) => { if (c !== null) lastKnown = c; return Math.round(lastKnown * 10) / 10; });
    },
    reset() { buckets = Array.from({ length: points }, () => []); },
  };
}

export function threadPoints({ from, to, cents = [], progress = 1, pxPerNote }) {
  const p = Math.min(1, Math.max(0, progress)), n = cents.length;
  const at = (f, c) => ({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f - (c / 100) * pxPerNote, f });
  // Both ends rest on their stars: the waver lives between them.
  const out = [at(0, 0)];
  if (!(p > 0)) return out;
  let lastC = 0;
  for (let k = 0; k < n; k++) {
    const f = (k + 0.5) / n;
    if (f > p) break;
    if (Number.isFinite(cents[k])) lastC = cents[k];
    out.push(at(f, lastC));
  }
  out.push(at(p, p >= 1 ? 0 : lastC));
  return out;
}

// ---------------------------------------------------------------- the take

export function createFigureRound(count, saved = null) {
  const fresh = () => Array.from({ length: count }, () => null);
  const took = (list, map) => Array.from({ length: count }, (_, i) => map(list && list[i]));
  let lit = took(saved && saved.lit, (v) => v === true);
  let looks = took(saved && saved.looks, (v) => (typeof v === 'string' ? v : null));
  let lines = Array.from({ length: Math.max(0, count - 1) }, (_, i) => {
    const l = saved && saved.lines && saved.lines[i];
    return Array.isArray(l) ? [...l] : null;
  });
  // A figure that comes back whole has nothing left to sing: it rests at 'done' (Hear it,
  // Sing it again) until again() starts a fresh take.
  let phase = count > 0 && lit.every(Boolean) ? 'done' : 'ready', mode = 'run', index = 0, octaveSemis = 0, backTo = null;
  // The open star offered last: the next offer starts after it, so a star skipped again does
  // not hide the open stars behind it (bugs.md 35).
  let offered = -1;

  const firstOpen = (from = 0) => { for (let i = from; i < count; i++) if (!lit[i]) return i; return -1; };
  const state = () => ({
    phase, mode, index, count, lit: [...lit], looks: [...looks], lines: lines.map((l) => (l ? [...l] : null)),
    open: lit.map((on, i) => (on ? -1 : i)).filter((i) => i >= 0),
    solid: lines.map((_, i) => lit[i] && lit[i + 1]),
    octaveSemis, complete: count > 0 && lit.every(Boolean),
  });
  const goTo = (i) => { if (i >= 0) { index = i; phase = 'listen'; } else phase = 'done'; };
  // Left to right, past stars already lit; a single open star ends its own small take.
  const advance = () => goTo(mode === 'open' ? -1 : firstOpen(index + 1));

  return {
    state,
    start() { if (phase === 'ready' && count) { phase = 'shape'; backTo = null; mode = 'run'; offered = -1; } return state(); },
    shapeEnded() {
      if (phase !== 'shape') return state();
      if (backTo !== null) { index = backTo; backTo = null; phase = 'listen'; } else goTo(firstOpen(0));
      return state();
    },
    replayShape() { if (phase === 'sing') { backTo = index; phase = 'shape'; } return state(); },
    toneEnded() { if (phase === 'listen') phase = 'sing'; return state(); },
    replay() { if (phase === 'sing') phase = 'listen'; return state(); },
    landed({ look = 'held', line = null } = {}) {
      if (phase !== 'sing') return state();
      lit[index] = true;
      looks[index] = look;
      if (index > 0) lines[index - 1] = Array.isArray(line) ? [...line] : null;
      phase = 'result';
      return state();
    },
    next() { if (phase === 'result') advance(); return state(); },
    skip() { if (phase === 'listen' || phase === 'sing') advance(); return state(); },
    stop() { if (phase !== 'ready' && phase !== 'done') phase = 'done'; return state(); },
    lightOpen() {
      const later = firstOpen(offered + 1), i = later >= 0 ? later : firstOpen(0);
      if (phase === 'done' && i >= 0) { mode = 'open'; index = i; offered = i; phase = 'listen'; }
      return state();
    },
    again() {
      if (phase === 'done') { phase = 'ready'; mode = 'run'; index = 0; offered = -1; lit = fresh().map(() => false); looks = fresh(); lines = lines.map(() => null); }
      return state();
    },
    useOctave(dir) {
      if (phase !== 'done' && (dir === 'lower' || dir === 'higher')) octaveSemis += dir === 'lower' ? -12 : 12;
      return state();
    },
  };
}

// ---------------------------------------------------------------- saving

export const SAVED_KEY = 'music-trainer.constellations.v1';

const LOOK_SAID = { steady: 'held steady', held: 'held', recovered: 'held, found it again' };
// What a stored record may hold (bugs.md 34). A home note outside these is not a note anyone
// sings (the synth throws on it and the take hangs with the microphone on): it is dropped and
// the figure is placed afresh. A line is the in-tune waver of one hold: a few cents a point.
const SAVED_LIMITS = Object.freeze({ homeMin: 21, homeMax: 96, lineMaxPoints: 96, lineMaxCents: 100, timesMax: 99999 });
const savedLine = (l) => (Array.isArray(l) && l.length > 0 && l.length <= SAVED_LIMITS.lineMaxPoints
  && l.every((c) => Number.isFinite(c) && Math.abs(c) <= SAVED_LIMITS.lineMaxCents) ? l : null);

export function readSaved(text) {
  let all = null;
  try { all = JSON.parse(text || 'null'); } catch { all = null; }
  const out = {};
  if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
  for (const f of FIGURES) {
    const r = all[f.id];
    if (!r || typeof r !== 'object' || !Array.isArray(r.stars)) continue;
    const n = f.degrees.length;
    out[f.id] = {
      id: f.id,
      home: Number.isFinite(r.home) && r.home >= SAVED_LIMITS.homeMin && r.home <= SAVED_LIMITS.homeMax ? Math.round(r.home) : null,
      stars: Array.from({ length: n }, (_, i) => (typeof r.stars[i] === 'string' ? (Object.hasOwn(LOOK_SAID, r.stars[i]) ? r.stars[i] : 'held') : null)),
      lines: Array.from({ length: n - 1 }, (_, i) => savedLine(Array.isArray(r.lines) ? r.lines[i] : null)),
      completedAt: typeof r.completedAt === 'string' ? r.completedAt : null,
      lastSungAt: typeof r.lastSungAt === 'string' ? r.lastSungAt : null,
      timesSung: Math.max(typeof r.completedAt === 'string' ? 1 : 0, Number.isFinite(r.timesSung) ? Math.min(SAVED_LIMITS.timesMax, Math.round(r.timesSung)) : 0),
    };
  }
  return out;
}

export function nextSaved(prev, take, { id, home, nowIso = null } = {}) {
  const was = prev && typeof prev === 'object' ? prev : null;
  const wasDone = !!(was && was.completedAt);
  const stars = take.lit.map((on, i) => (on ? take.looks[i] || 'held' : null));
  if (take.complete) {
    return {
      record: { id, home, stars, lines: take.lines, completedAt: nowIso, lastSungAt: nowIso, timesSung: (was ? was.timesSung || 0 : 0) + 1 },
      firstTime: !wasDone,
    };
  }
  // Once in the sky a figure stays whole: an unfinished fresh take is not written over it.
  if (wasDone) return { record: { ...was, lastSungAt: nowIso ?? was.lastSungAt }, firstTime: false };
  return { record: { id, home, stars, lines: take.lines, completedAt: null, lastSungAt: nowIso, timesSung: 0 }, firstTime: false };
}

// ---------------------------------------------------------------- words

// Hints for this screen: there is no band here, the target is a star and the voice is a dot
// (review 3, finding 6). `under` / `over` replace Match and hold's sentences; `low` / `high`
// are given to the HUD. Keys not listed here keep Match and hold's words.
export const FIGURE_HINTS = Object.freeze({
  under: 'You’re under it. Slide up slowly until your dot sits on the star.',
  over: 'You’re over it. Let the note sink down until your dot sits on the star.',
  low: 'Let your voice slide up slowly until your dot reaches the star.',
  high: 'Let your voice come down slowly until your dot reaches the star.',
});

export const WORDS = Object.freeze({
  name: 'Sing a constellation',
  plain: 'Short tunes, one note at a time',
  ready: 'Each star is a note. Higher star, higher note.',
  hearShape: 'Hear the shape',
  hearAgain: 'Hear it again',
  skip: 'Skip this star',
  skipStuck: 'Skip this star for now: you can light it later',
  lightOpen: 'Light the open star',
  hearIt: 'Hear it',
  singAgain: 'Sing it again',
  back: 'Back to The Ladder',
  paused: 'Paused. Press Space to carry on.',
  sameNote: 'Same note again: take a breath, then sing.',
  notFound: 'That constellation was not found.',
  cannotSave: 'This sky cannot be saved in this browser.',
});

const COUNT_WORD = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];

export const singLine = (i, n, heldMs, holdMs) => `Star ${i + 1} of ${n} · ${heldText(heldMs, holdMs)}`;
export const litLine = (i, n, look) => `Star ${i + 1} of ${n} lit · ${LOOK_SAID[look] || 'held'}`;

export function doneLine(name, lit, count) {
  if (lit >= count) return `${name} is in your sky.`;
  const open = count - lit;
  return `${name}: ${lit} of ${count} stars lit. ${COUNT_WORD[open] || open} ${open === 1 ? 'is' : 'are'} still open.`;
}

export function fieldLabel(name, { lit, looks, index, phase, count }) {
  const singing = phase === 'listen' || phase === 'sing';
  const passed = (i) => (phase === 'done' || phase === 'result' || (singing && i < index));
  const parts = lit.map((on, i) => `${i + 1} ${on ? `lit, ${LOOK_SAID[looks[i]] || 'held'}` : singing && i === index ? 'being sung' : passed(i) ? 'open' : 'not yet lit'}`);
  return `${name}, ${count} stars: ${parts.join('; ')}.`;
}

export function cardStateLine(saved, count) {
  if (!saved) return 'Not sung yet';
  if (saved.completedAt) return `In your sky · sung ${saved.timesSung} ${saved.timesSung === 1 ? 'time' : 'times'}`;
  const lit = saved.stars.filter(Boolean).length;
  return lit ? `${lit} of ${count} stars lit` : 'Not sung yet';
}

export const overChip = (over) => (over > 0 ? `Reaches ${over} ${over === 1 ? 'note' : 'notes'} past your range` : '');

export function thumbPoints(figure, w = 96, h = 64, pad = 10) {
  const semis = semitonesOf(figure), n = semis.length;
  const min = Math.min(...semis), max = Math.max(...semis), span = Math.max(1, max - min);
  return semis.map((s, i) => ({
    x: Math.round((pad + ((i + 0.5) * (w - 2 * pad)) / n) * 10) / 10,
    y: Math.round((h - pad - ((s - min) / span) * (h - 2 * pad)) * 10) / 10,
  }));
}
