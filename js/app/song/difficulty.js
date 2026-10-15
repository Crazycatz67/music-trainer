// difficulty.js — how hard a song's tune is to sing: a rating per song and per level, the
// level a note belongs to, which levels are worth offering, and how the song sits in a saved
// voice range. Pure: no browser globals; imports in Node (tools/checks/difficulty.check.mjs).
//
// WHY: the owner wants a number on every song, levels per song (Easy judges the long notes
// only) and a sensible next song. Design: Ricky's research (docs/team-log/reports/
// 2026-10-14-ricky-song-difficulty.md) and Delilah's spec (docs/design/specs/
// 2026-10-14-song-difficulty.md, slice D1). Every number and word is in difficulty.config.js.
//
// A LEVEL IS A FILTER ON WHICH NOTES ARE JUDGED, never a change to the cent windows. The page
// builds `levelTargetAt = (t) => inSpans(judgedSpans(...), t) ? targetAt(t) : null` and feeds
// the judge AND the line stars from it (one wrapper, or stars and letter disagree).
//
// TIME is seconds, PITCH is MIDI (floats allowed), as in js/timeline.js.
//
// CONTRACT
//   input: a song from songFromChart (its .timeline is used: already tempo-scaled) or a
//     timeline ({ notes: [{ t, dur, midi, line?, golden?, lyric? }] }). Notes without a finite
//     t, dur > 0 and a finite midi are ignored. Lines come from note.line (UltraStar); without
//     line marks a rest of cfg.lineGapSec starts a new line. Nothing here mutates its input.
//   LEVELS = ['easy', 'normal', 'hard']; an unknown level throws RangeError.
//
//   levelNotes(input, level = 'hard', { cfg }) -> note[]   the judged notes, in time order
//       (the input's own note objects). Easy ⊆ Normal ⊆ Hard always holds. Per line, Easy
//       covers ≥ cfg.levels.easy.minCover and Normal ≥ cfg.levels.normal.minCover of the
//       line's singing time (sum of note lengths).
//   judgedSpans(input, level, { cfg }) -> [{ t, end }]   merged, sorted spans of judged notes.
//   inSpans(spans, t) -> boolean
//   lagScale(level, { cfg }) -> number   multiplier for LS.lagSec (Easy 1.5, others 1).
//   difficultyOf(input, { level = 'hard', range = null, cfg }) ->
//       null when the input has no notes, else
//       { rating, band, word, level, lines: [{ index, t, end, text, strain, parts }],
//         hardestLine, judgedShare, fit, personal }
//       rating: one decimal, ≥ 0; about 1.5 to 4.5 on the demos. A lower level's rating is
//         never above a higher level's (clamped: a sparser line can look "faster").
//       parts: { speed, leaps, span, breath, held, chroma } each 0..1; strain = weighted sum.
//       judgedShare: judged singing time / every note's singing time (0..1).
//       fit / personal: null without a range (see rangeFit).
//   hardestLine(lines, { cfg }) -> { index, t, end, text, strain, part, partWord } | null
//   bandOf(rating, { cfg }) -> { band: 1..4, word }   (null rating -> null)
//   levelsOffered(input, { cfg }) -> level ids, easiest first ([] when no notes; 'hard'
//       always present otherwise). A level is kept if it judges ≤ cfg.levels.offerMaxShare of
//       the singing time of the next KEPT level above it.
//   rangeFit(input, range, { rating?, cfg }) -> fit
//       range: a saved range { lowMidi, highMidi, comfortLow?, comfortHigh? } (range.js).
//       Measured after the app's own octave move (fitChartToRange, octaves only).
//       fit = { code: 'no-notes' | 'no-range' | 'easy' | 'fits' | 'just' | 'past',
//               words, title, shift, pastTop, pastBottom, margin, outsideShare, personal }
//       words: the exact spec 2.3 strings ('no-notes' -> null words).
//   fitWords(fit) -> string | null   the same words, for a fit computed elsewhere.
//   recommendNext(entries, { cfg }) -> entry | null
//       entries: [{ id, title, rating, best: 'S' | 'A' | ... | null (at the song's top
//       level), personal? }]. Never returns an entry already at cfg.next.doneLetter.
//       Prefers the easier song when two are equally far from the target.
//   lineStrains(input, { level, cfg }) -> the `lines` array above (exported for checks).

import { DIFFICULTY } from './difficulty.config.js';
import { keyOf, fitChartToRange } from './chartsong.js';

export const LEVELS = DIFFICULTY.levels.order;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const c01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const squeeze = (x, p) => c01((x - p.from) / p.over);
const end = (n) => n.t + n.dur;
const sumDur = (notes) => notes.reduce((s, n) => s + n.dur, 0);

function checkLevel(level, cfg) {
  if (!cfg.levels.order.includes(level)) throw new RangeError(`unknown level "${level}"`);
}

function notesOf(input) {
  const tl = input && input.timeline && Array.isArray(input.timeline.notes) ? input.timeline : input;
  const notes = tl && Array.isArray(tl.notes) ? tl.notes : [];
  return notes.filter((n) => n && isNum(n.t) && isNum(n.dur) && n.dur > 0 && isNum(n.midi))
    .slice().sort((a, b) => a.t - b.t);
}

// [[note, ...], ...] in time order.
function linesOf(notes, cfg) {
  if (notes.some((n) => Number.isInteger(n.line))) {
    const by = new Map();
    let last = null;
    for (const n of notes) {
      // A stray note with no line mark joins the line before it.
      const k = Number.isInteger(n.line) ? n.line : last;
      last = k;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(n);
    }
    return [...by.values()].sort((a, b) => a[0].t - b[0].t);
  }
  const out = [];
  for (const n of notes) {
    const cur = out[out.length - 1];
    if (cur && n.t - Math.max(...cur.map(end)) < cfg.lineGapSec) cur.push(n);
    else out.push([n]);
  }
  return out;
}

// ---------------------------------------------------------------- levels

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Top a line's picked set up with its longest unpicked notes until `cover` of its singing time.
function topUp(line, picked, cover) {
  const need = cover * sumDur(line) - 1e-9;
  let have = sumDur([...picked]);
  const rest = line.filter((n) => !picked.has(n)).sort((a, b) => b.dur - a.dur || a.t - b.t);
  for (const n of rest) {
    if (have >= need) break;
    picked.add(n);
    have += n.dur;
  }
  return picked;
}

function pickEasy(line, L) {
  const long = Math.max(L.minSec, L.medianScale * median(line.map((n) => n.dur)));
  const longest = line.reduce((a, b) => (b.dur > a.dur ? b : a));
  const picked = new Set(line.filter((n) => n.dur >= long - 1e-9 || n.golden));
  picked.add(line[line.length - 1]).add(longest);
  return topUp(line, picked, L.minCover);
}

function pickNormal(line, L, easy) {
  const picked = new Set(line.filter((n) => n.dur >= L.minSec - 1e-9 || n.golden));
  // Easy's own picks (a short last note, a top-up) stay in, so Easy ⊆ Normal always.
  for (const n of easy) picked.add(n);
  return topUp(line, picked, L.minCover);
}

function judgedSet(notes, level, cfg) {
  if (level === 'hard') return new Set(notes);
  const out = new Set();
  for (const line of linesOf(notes, cfg)) {
    const easy = pickEasy(line, cfg.levels.easy);
    const pick = level === 'easy' ? easy : pickNormal(line, cfg.levels.normal, easy);
    for (const n of pick) out.add(n);
  }
  return out;
}

export function levelNotes(input, level = 'hard', { cfg = DIFFICULTY } = {}) {
  checkLevel(level, cfg);
  const notes = notesOf(input);
  const set = judgedSet(notes, level, cfg);
  return notes.filter((n) => set.has(n));
}

export function judgedSpans(input, level = 'hard', { cfg = DIFFICULTY } = {}) {
  const spans = [];
  for (const n of levelNotes(input, level, { cfg })) {
    const last = spans[spans.length - 1];
    if (last && n.t <= last.end + 1e-9) last.end = Math.max(last.end, end(n));
    else spans.push({ t: n.t, end: end(n) });
  }
  return spans;
}

export function inSpans(spans, t) {
  // Binary search: called once per microphone reading (~47 a second).
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t < spans[m].t) hi = m - 1;
    else if (t >= spans[m].end) lo = m + 1;
    else return true;
  }
  return false;
}

export function lagScale(level, { cfg = DIFFICULTY } = {}) {
  checkLevel(level, cfg);
  return cfg.levels[level].lagScale;
}

export function levelsOffered(input, { cfg = DIFFICULTY } = {}) {
  const notes = notesOf(input);
  if (!notes.length) return [];
  const kept = ['hard'];
  let above = sumDur(notes);
  for (const level of cfg.levels.order.slice(0, -1).reverse()) {
    const time = sumDur(levelNotes(input, level, { cfg }));
    if (time <= cfg.levels.offerMaxShare * above + 1e-9) { kept.unshift(level); above = time; }
  }
  return kept;
}

// ---------------------------------------------------------------- strain

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const pc = (midi) => ((Math.round(midi) % 12) + 12) % 12;

function inKeyTest(allNotes) {
  const key = keyOf(allNotes);
  // A key found from the last note has no mode: read it as major (the commoner case).
  const scale = new Set(SCALES[key.mode || 'major'].map((s) => (s + key.root) % 12));
  return (n) => scale.has(pc(n.midi));
}

function partsOf(line, inKey, P) {
  const t0 = line[0].t, t1 = Math.max(...line.map(end)), len = t1 - t0;
  const leaps = [];
  for (let i = 1; i < line.length; i++) leaps.push(Math.abs(line[i].midi - line[i - 1].midi));
  const meanExcess = leaps.length ? leaps.reduce((s, d) => s + Math.max(0, d - P.leaps.freeSemis), 0) / leaps.length : 0;
  const maxLeap = leaps.length ? Math.max(...leaps) : 0;
  const midis = line.map((n) => n.midi);
  return {
    speed: len > 0 ? squeeze(line.length / len, P.speed) : 0,
    leaps: P.leaps.meanShare * c01(meanExcess / P.leaps.meanOver)
      + P.leaps.maxShare * (leaps.length ? c01((maxLeap - P.leaps.maxFrom) / P.leaps.maxOver) : 0),
    span: squeeze(Math.max(...midis) - Math.min(...midis), P.span),
    breath: squeeze(len, P.breath),
    held: squeeze(Math.max(...line.map((n) => n.dur)), P.held),
    chroma: squeeze(line.filter((n) => !inKey(n)).length / line.length, P.chroma),
  };
}

const lineText = (line) => line.map((n) => (typeof n.lyric === 'string' ? n.lyric : '')).join('').replace(/\s+/g, ' ').trim();

export function lineStrains(input, { level = 'hard', cfg = DIFFICULTY } = {}) {
  checkLevel(level, cfg);
  const all = notesOf(input);
  if (!all.length) return [];
  const inKey = inKeyTest(all);
  const judged = judgedSet(all, level, cfg);
  const P = cfg.parts;
  // Lines are cut on every note, then thinned, so line indexes are the same on every level.
  return linesOf(all, cfg).map((full, index) => {
    const line = full.filter((n) => judged.has(n));
    const base = { index, t: full[0].t, end: Math.max(...full.map(end)), text: lineText(full) };
    if (!line.length) return { ...base, strain: 0, parts: null };
    const parts = partsOf(line, inKey, P);
    const strain = Object.keys(P).reduce((s, k) => s + P[k].weight * parts[k], 0);
    return { ...base, strain, parts };
  });
}

function ratingOf(lines, cfg) {
  const R = cfg.rating;
  const strains = lines.map((l) => l.strain).sort((a, b) => b - a);
  if (!strains.length) return 0;
  let num = 0, den = 0;
  strains.forEach((s, i) => { const w = R.decay ** i; num += w * s; den += w; });
  const bonus = 1 + R.lengthBonus * Math.log2(Math.max(1, lines.length / R.lengthRefLines));
  return Math.round((num / den) * bonus * R.scale * 10) / 10;
}

export function hardestLine(lines, { cfg = DIFFICULTY } = {}) {
  const top = (lines || []).filter((l) => l.parts).reduce((a, b) => (!a || b.strain > a.strain ? b : a), null);
  if (!top) return null;
  const part = Object.keys(cfg.parts).reduce((a, k) => (cfg.parts[k].weight * top.parts[k] > cfg.parts[a].weight * top.parts[a] ? k : a));
  return { index: top.index, t: top.t, end: top.end, text: top.text, strain: top.strain, part, partWord: cfg.partWords[part] };
}

export function bandOf(rating, { cfg = DIFFICULTY } = {}) {
  if (!isNum(rating)) return null;
  const b = cfg.bands.find((x) => rating < x.below - 1e-9) || cfg.bands[cfg.bands.length - 1];
  return { band: b.band, word: b.word };
}

export function difficultyOf(input, { level = 'hard', range = null, cfg = DIFFICULTY } = {}) {
  checkLevel(level, cfg);
  const all = notesOf(input);
  if (!all.length) return null;
  const lines = lineStrains(input, { level, cfg });
  let rating = ratingOf(lines, cfg);
  // Thinning a line can raise its notes-per-second or its leaps; a level must never read
  // harder than the one above it, so clamp to the next level up.
  const i = cfg.levels.order.indexOf(level);
  if (i < cfg.levels.order.length - 1) {
    rating = Math.min(rating, difficultyOf(input, { level: cfg.levels.order[i + 1], cfg }).rating);
  }
  const { band, word } = bandOf(rating, { cfg });
  const judgedShare = sumDur(levelNotes(input, level, { cfg })) / sumDur(all);
  const fit = range ? rangeFit(input, range, { rating, cfg }) : null;
  return {
    rating, band, word, level, lines, hardestLine: hardestLine(lines, { cfg }), judgedShare,
    fit, personal: fit ? fit.personal : null,
  };
}

// ---------------------------------------------------------------- range fit

export function rangeFit(input, range, { rating = null, cfg = DIFFICULTY } = {}) {
  const F = cfg.fit;
  const notes = notesOf(input);
  const base = { shift: 0, pastTop: 0, pastBottom: 0, margin: null, outsideShare: 0, personal: rating };
  if (!notes.length) return { ...base, code: 'no-notes', words: null, title: null };
  if (!range || !isNum(range.lowMidi) || !isNum(range.highMidi)) {
    return { ...base, code: 'no-range', words: F.words.noRange, title: F.words.noRange };
  }
  // Describe what the singer will actually sing: after the app's own octave move.
  const { shift } = fitChartToRange({ timeline: { notes } }, range);
  const lo = Math.min(...notes.map((n) => n.midi)) + shift, hi = Math.max(...notes.map((n) => n.midi)) + shift;
  const pastTop = Math.ceil(Math.max(0, hi - range.highMidi) - 1e-9);
  const pastBottom = Math.ceil(Math.max(0, range.lowMidi - lo) - 1e-9);
  const cLo = isNum(range.comfortLow) ? range.comfortLow : range.lowMidi;
  const cHi = isNum(range.comfortHigh) ? range.comfortHigh : range.highMidi;
  const margin = (cHi - cLo) - (hi - lo);
  const outside = sumDur(notes.filter((n) => n.midi + shift > cHi || n.midi + shift < cLo)) / sumDur(notes);
  const personal = isNum(rating)
    ? Math.round((rating + F.personal.top * pastTop + F.personal.bottom * pastBottom + F.personal.outside * outside) * 10) / 10
    : null;
  let code;
  if (pastTop || pastBottom) code = 'past';
  else if (margin >= F.easyMargin) code = 'easy';
  else if (margin >= F.fitsMargin) code = 'fits';
  else code = 'just';
  const fit = { code, shift, pastTop, pastBottom, margin, outsideShare: outside, personal };
  return { ...fit, words: fitWords(fit, { cfg }), title: fitTitle(fit, { cfg }) };
}

// "Reaches N notes past your range": N is the farther end, so the number is the worst stretch.
const pastN = (fit) => Math.max(fit.pastTop, fit.pastBottom);

export function fitWords(fit, { cfg = DIFFICULTY } = {}) {
  if (!fit || fit.code === 'no-notes') return null;
  if (fit.code === 'past') { const n = pastN(fit); return `Reaches ${n} ${n === 1 ? 'note' : 'notes'} past your range`; }
  return cfg.fit.words[fit.code === 'no-range' ? 'noRange' : fit.code] || null;
}

function fitTitle(fit, { cfg }) {
  const words = fitWords(fit, { cfg });
  if (fit.code !== 'past') return words;
  const where = fit.pastTop && fit.pastBottom ? 'at both ends' : fit.pastTop ? 'at the top' : 'at the bottom';
  return `${words}, ${where}.`;
}

// ---------------------------------------------------------------- next song

export function recommendNext(entries, { cfg = DIFFICULTY } = {}) {
  const N = cfg.next;
  const list = (entries || []).filter((e) => e && isNum(e.rating));
  const good = list.filter((e) => N.goodLetters.includes(e.best)).map((e) => e.rating);
  const target = good.length ? Math.max(...good) + N.step : N.start;
  const cost = (e) => { const d = e.rating - target; return d >= 0 ? N.upCost * d : -d; };
  const fit = (e) => (isNum(e.personal) ? e.personal - e.rating : 0);
  let best = null;
  for (const e of list) {
    if (e.best === N.doneLetter) continue;
    if (!best) { best = e; continue; }
    // Cost, then the easier song, then the better personal fit, then the title.
    const k = cost(e) - cost(best) || e.rating - best.rating || fit(e) - fit(best)
      || String(e.title || '').localeCompare(String(best.title || ''));
    if (k < -1e-9) best = e;
  }
  return best;
}
