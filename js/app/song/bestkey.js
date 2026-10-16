// The "best key for you" advice: which octave of a song suits the singer's saved range best,
// and plain words for it (spec docs/design/specs/2026-10-15-best-key-and-progress-test.md, 3.1
// and 3.4). Pure: no DOM, no storage, imports in Node.
//
// Contract (consumed by singnow.js line B and difficulty-view.js rows):
//   keyAdvice(input, range, { current = 0, kind = 'chart' | 'file', cfg }) ->
//     { code, best, current, now, at, semis, words, title, use, row }
//   input   a song ({ timeline: { notes } }), a timeline ({ notes }) or a record with only
//           range { lowest, highest } (a recording); notes { t, dur, midi } (s, s, MIDI)
//   range   { lowMidi, highMidi, comfortLow?, comfortHigh? } (MIDI) or null
//   current the octave the song is sung at now (-1..1, the store's `octave`)
//   code    'no-range' | 'no-notes' | 'fits' | 'move' | 'closest' | 'too-wide'
//   best    the octave that suits the singer best (-maxOctaves..maxOctaves); 0 when no range/notes
//   now/at  measures at `current` / at `best`, with NO further move (rangeFit moves on its own):
//           { code, shift, pastTop, pastBottom, margin, outsideShare } as rangeFit's fields
//   semis   whole semitones from `best` that would fit everything (closest only), else null
//   words   line B text for the octave in use (buttons are the caller's); null for no-notes
//   title   the longer sentence for title / screen reader, or null
//   use     the octave to offer on a "Use it" button, or null (only for code 'move')
//   row     the song-row phrase (no buttons on rows)
// Rule: fewest notes past the range; then least singing time outside the comfortable band;
// then the smaller move; then the lower. `fits` = current has 0 notes past (best may still
// differ: the caller auto-moves an unset song to `best`, it does not nag a song the singer set).
// `move` = current reaches past and best reaches past less. Never throws on odd input.
import { DIFFICULTY } from './difficulty.config.js';
import { fitWords } from './difficulty.js';
import { fitTimeline } from '../range.js';

export const BESTKEY = {
  maxOctaves: 1, // as CHART.maxOctaves: the Octave control is Down / As sung / Up
  keyMax: 5, // GUESS (spec 3.1): past this a "N notes lower" suggestion is not offered
};

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sumDur = (notes) => notes.reduce((s, n) => s + n.dur, 0);
const EPS = 1e-9;

function notesOf(input) {
  const tl = input && input.timeline && Array.isArray(input.timeline.notes) ? input.timeline : input;
  let notes = tl && Array.isArray(tl.notes) ? tl.notes : [];
  // A recording (or a list record) keeps only its traced ends: the words depend on those alone;
  // the comfort share is then an estimate, as entryFit's.
  const r = input && input.range;
  if (!notes.length && r && isNum(r.lowest) && isNum(r.highest)) notes = [{ t: 0, dur: 1, midi: r.lowest }, { t: 1, dur: 1, midi: r.highest }];
  return notes.filter((n) => n && isNum(n.t) && isNum(n.dur) && n.dur > 0 && isNum(n.midi));
}

// rangeFit's measure, at a given shift and with no octave search of its own: rangeFit
// describes the song after the app's best move, which is exactly what this file must compare.
function measure(notes, range, shift, F) {
  const lo = Math.min(...notes.map((n) => n.midi)) + shift, hi = Math.max(...notes.map((n) => n.midi)) + shift;
  const pastTop = Math.ceil(Math.max(0, hi - range.highMidi) - EPS) || 0; // never -0
  const pastBottom = Math.ceil(Math.max(0, range.lowMidi - lo) - EPS) || 0;
  const cLo = isNum(range.comfortLow) ? range.comfortLow : range.lowMidi;
  const cHi = isNum(range.comfortHigh) ? range.comfortHigh : range.highMidi;
  const margin = (cHi - cLo) - (hi - lo);
  const outsideShare = sumDur(notes.filter((n) => n.midi + shift > cHi || n.midi + shift < cLo)) / sumDur(notes);
  let code;
  if (pastTop || pastBottom) code = 'past';
  else if (margin >= F.easyMargin) code = 'easy';
  else if (margin >= F.fitsMargin) code = 'fits';
  else code = 'just';
  return { code, shift, pastTop, pastBottom, margin, outsideShare, cost: pastTop + pastBottom };
}

const octaveWord = (o) => (o < 0 ? 'an octave down' : 'an octave up');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const notesWord = (n) => `${n} ${n === 1 ? 'note' : 'notes'}`;
const where = (m) => (m.pastTop && m.pastBottom ? 'at both ends' : m.pastTop ? 'at the top' : 'at the bottom');
const pastWords = (m, cfg) => fitWords(m, { cfg });

// The one-line notice after the app moved an unset song for the singer (spec 3.4).
export function movedWords(octave) {
  return `Moved ${octaveWord(octave)} for you, because that fits your voice.`;
}

export function keyAdvice(input, range, { current = 0, kind = 'chart', cfg = DIFFICULTY, key = BESTKEY } = {}) {
  const F = cfg.fit;
  const cur = isNum(current) ? Math.max(-key.maxOctaves, Math.min(key.maxOctaves, Math.round(current))) : 0;
  const empty = { best: 0, current: cur, now: null, at: null, semis: null, use: null };
  const notes = notesOf(input);
  if (!notes.length) return { ...empty, code: 'no-notes', words: null, title: null, row: null };
  if (!range || !isNum(range.lowMidi) || !isNum(range.highMidi) || range.highMidi < range.lowMidi) {
    return { ...empty, code: 'no-range', words: F.words.noRange, title: F.words.noRange, row: F.words.noRange };
  }
  // The smaller move first, then the lower: a strict "better" keeps the first of equals.
  const order = [0];
  for (let k = 1; k <= key.maxOctaves; k++) order.push(-k, k);
  let best = 0, bm = null;
  for (const k of order) {
    const m = measure(notes, range, 12 * k, F);
    if (!bm || m.cost < bm.cost || (m.cost === bm.cost && m.outsideShare < bm.outsideShare - EPS)) { best = k; bm = m; }
  }
  const now = measure(notes, range, 12 * cur, F), at = bm;
  const base = { best, current: cur, now, at, semis: null, use: null };

  if (now.cost === 0) {
    if (cur === 0) {
      const w = pastWords(now, cfg);
      return { ...base, code: 'fits', words: w, title: w, row: w };
    }
    const w = `Fits your voice, ${octaveWord(cur)}`;
    const title = kind === 'file'
      ? `You sing an octave ${cur < 0 ? 'below' : 'above'} the singer; the song sounds the same.`
      : `The guide plays an octave ${cur < 0 ? 'lower' : 'higher'}.`;
    return { ...base, code: 'fits', words: w, title, row: w };
  }
  if (best !== cur && at.cost < now.cost) {
    // "fits it" only when it truly does; a move that only comes nearer says so (not in the
    // spec's table, which assumes the better octave fits: see the K1 card decision).
    const fitsThere = at.cost === 0;
    const verb = fitsThere ? 'fits it' : 'comes closer';
    const w = `${pastWords(now, cfg)} · ${cap(octaveWord(best))} ${verb}`;
    return {
      ...base, code: 'move', use: best, words: w,
      title: `Use it: sing this song ${octaveWord(best)}.`,
      row: `${pastWords(now, cfg)} (${verb === 'fits it' ? 'fits' : 'closer'} ${octaveWord(best)})`,
    };
  }
  // Nothing better in reach: describe the octave in use.
  const span = Math.max(...notes.map((n) => n.midi)) - Math.min(...notes.map((n) => n.midi));
  const room = range.highMidi - range.lowMidi;
  if (span > room + EPS) {
    const w = `Spans ${Math.ceil(span - EPS)} notes; your range is ${Math.floor(room + EPS)} · this is the closest octave`;
    return { ...base, code: 'too-wide', words: w, title: 'No key fits all of it. Sing what you can; the rest still counts as practice.', row: pastWords(now, cfg) };
  }
  const moved = { notes: notes.map((n) => ({ midi: n.midi + 12 * cur })) };
  const f = fitTimeline(moved, range);
  const semis = f.fitsAfter && f.shift !== 0 && Math.abs(f.shift) <= key.keyMax ? f.shift : null;
  const head = `${pastWords(now, cfg)}, ${where(now)}`;
  if (semis == null) {
    return { ...base, code: 'closest', words: `${head} · this is the closest octave`, title: null, row: pastWords(now, cfg) };
  }
  return {
    ...base, code: 'closest', semis,
    words: `${head} · ${notesWord(Math.abs(semis))} ${semis < 0 ? 'lower' : 'higher'} it would fit all of it`,
    title: kind === 'file'
      ? "Changing a recording's key needs a sound tool the app does not have yet."
      : 'A key control for songs like this is planned.',
    row: pastWords(now, cfg),
  };
}
