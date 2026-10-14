// grades.js — how a sung take is scored and graded: points per pitch reading, an accuracy,
// a letter, the sharp/flat chart, the combo of lines, personal bests and the rest nudge.
// Pure: imports in Node, no browser globals (storage is handed in).
// The octave fold and the line levels are the line stars' own (js/app/song/lineresults.js).
//
// THE RULES (owner's decisions, 2026-10-13; every number is in grades.config.js):
//   - Only PITCH is judged, never loudness: `level` is accepted and ignored on purpose.
//   - A reading is judged only while the song has a sung note AND the singer has a
//     trustworthy pitch. Silence, breath and noise are left out of every count: they never
//     cost anything. (So a take is graded on what WAS sung.)
//   - Because silence costs nothing, a letter also needs enough of the song to have been
//     sung: judge.minSongShare of its sung time. Under it the state is 'sangTooLittle'.
//     counts().skipped is NOT that figure (it also counts readings in the song's rests).
//   - The octave is folded away: singing an octave under the song is singing the note.
//   - Under the lowest letter there is no letter at all (state 'finding'). Never a D, never
//     a fail.
//
// UNITS. cents = 100 x (sung midi - target midi); negative = low, positive = high.
// accuracy and every share are PER CENT (0..100), except judge.minSongShare (a fraction).
// Times `at` are milliseconds (Date.now()) or an ISO string; seconds where the name says
// Sec or Seconds.
//
// WHAT THE SING PAGE MUST PASS (js/app/singnow.js, when a take ends). `lines` is the page's
// own list of lines { t, end } (words or phrases, the one it gives lineresults.js);
// `saved` is lineresults.js summarise(...):
//   const { counts, accuracy, cents } = judgeFrames(frames, targetAt)   // or a live judge
//   const lineLevels = saved.results.map((r) => r.level)
//   const { sungSeconds, songSungSeconds } = sungTimeOf(lines, saved.results)
//   const grade = gradeOf({ accuracy, judged: counts.judged, lineLevels, mods, sungSeconds, songSungSeconds })
//   const result = resultOf({ counts, accuracy, lineLevels, mods, at, sungSeconds, songSungSeconds })
// songSungSeconds must be the WHOLE song's lines even when the take stopped early. Leave
// the two numbers out and the "sang enough" rule is NOT applied (as `judged`): a page that
// shows a letter must pass them.
//
// CONTRACT   (config defaults to GRADES everywhere)
//   foldCents(cents) -> cents in -600..600 (the nearest octave of the target); it IS
//         lineresults.js foldCents, passed on, so the page has one octave rule
//   createJudge(config?) -> judge                      live use; add() is a few comparisons
//     judge.add(cents, { voiced = true, clarity?, level? }) -> 'great' | 'good' | 'ok' | 'miss' | null
//         cents: sung against the target, NOT folded yet; null or NaN when the song has no
//         note there or there is no pitch. null back = not judged (counted in `skipped`).
//     judge.counts() -> { great, good, ok, miss, judged, skipped }   (ids from judge.windows)
//     judge.accuracy() -> per cent, or null when nothing was judged
//     judge.cents() -> the folded cents of every judged reading, in order (for histogram)
//     judge.reset()
//   accuracyOf(counts, config?) -> per cent | null
//         100 x (300 great + 100 good + 50 ok) / (300 x judged)
//   judgeFrames(frames, targetAt, config?, { offsetSec = 0 }?) -> { counts, accuracy, cents }
//         A saved take: frames = pitch frames { t, midi, clarity, voiced } (takes.js
//         unpackFrames); targetAt(t + offsetSec) -> the song's midi there, or null / NaN, or
//         curveAt's { midi, voiced }. A reading is judged only where the song has a note at
//         t, against the NEAREST of the song's notes at t, t - lag and t + lag (lag =
//         judge.lagSec, or SONG.lineStars.lagSec): lineresults.js nearestCents, the line
//         stars' rule. The live judge.add() takes one cents value and has no such lag.
//   sungTimeOf(lines, results, config?) -> { sungSeconds, songSungSeconds }
//         lines: every line of the song { t, end }; results: lineresults.js results
//         { i, t, end, level }. songSungSeconds = the length of all the lines together;
//         sungSeconds = the length of the lines that were sung (level not lines.unsung),
//         each line once.
//   gradeOf({ accuracy, judged?, lineLevels = [], mods = {}, sungSeconds?, songSungSeconds? }, config?) ->
//       { letter: 'SS' | 'S' | 'A' | 'B' | 'C' | null, silver,
//         state: 'graded' | 'finding' | 'tooShort' | 'sangTooLittle',
//         nextLetter, pointsToNext, heldBack: null | 'line' | 'song' }
//         A letter marked topShare (SS, S) also needs sungSeconds / songSungSeconds to reach
//         judge.topSongShare; under it the take gets the next letter it does qualify for
//         and heldBack is 'song' ('line' when a line at the lowest level stops it too).
//         Without songSungSeconds that rule is off, as the "sang enough" rule is.
//         lineLevels: lineresults.js levels, 'with' | 'close' | 'finding' | 'none' (or null).
//         tooShort: accuracy is null, or judged is given and under judge.minJudged.
//         sangTooLittle: songSungSeconds is given and sungSeconds / songSungSeconds is under
//         judge.minSongShare (a missing sungSeconds counts as 0; a songSungSeconds that is
//         not a number above 0 gives no letter either).
//         nextLetter / pointsToNext: the letter above and the accuracy points still missing
//         (0 when only a line or the unsung part holds it back: heldBack); null / null at the top, for
//         tooShort and for sangTooLittle. silver is true only with a letter.
//   histogram(centsList, config?) -> { bins: [{ from, to, count, share }], under, over, n,
//         median, q1, q3, low, on, high }
//         q1 / q3: the quarter points of the cents (null when n is under 4).
//         bins of histogram.binCents from -rangeCents to +rangeCents ([from, to), the last
//         one closed); under / over = counts beyond them. low / on / high = share of
//         readings below -onCents, within it, above it. median is null when n is 0.
//   steadiness(frames, config?) -> { wobble, notes }
//         wobble: coach.js's wobble (cents; spread of a held note once a steady drift is
//         taken out), the median over the singer's held notes; null when none was held
//         long enough. Needs no target: the notes are read from the singer's own pitch.
//   comboOf(lineLevels, config?) -> { longest, current }
//         runs of lines at lines.combo ('with'); current = the run the list ends on.
//         A line that was not sung ('none', or null) neither adds to a run nor breaks it.
//   resultOf({ counts, accuracy, lineLevels?, mods?, at?, sungSeconds?, songSungSeconds?, takeId? }, config?) -> result
//         what a finished take is remembered as: { accuracy, letter, silver, state, judged,
//         combo, mods, at, takeId }. `counts` / `accuracy` from a judge or judgeFrames.
//         takeId: the take's id as a string, or null; a saved best reads back with it.
//   Personal bests (all pure; bests = { v: 1, songs: { [songId]: { [modKey]: result } } })
//     modKey(mods, config?) -> 'plain' or the switched-on SILVER mods joined with '+', in config
//         order ('noLine'); full-credit mods (noGuide, slower, keyDown) share 'plain'
//     better(a, b, config?) -> true when result a beats b: accuracy, then letter, then the
//         EARLIER date (a take that only ties does not replace the best). b missing -> true.
//     updateBests(bests, songId, result, config?) -> { bests, isBest, previous }
//         bests is a new object when isBest; a tooShort or sangTooLittle result is never
//         a best.
//     bestFor(bests, songId, mods, config?) -> result | null      that mod set only
//     bestAny(bests, songId, config?) -> { key, result } | null   the best over every mod set
//     emptyBests() -> bests
//     readBests(storage, config?) -> bests (+ ok: false when something saved was unreadable)
//     saveBests(storage, bests, config?) -> boolean
//         Never throw. Damaged text reads as empty, and is copied once to key + '.bad'
//         before it is written over.
//   retryNudge(history, config?) -> boolean
//         history: takes oldest first, { songId, line?: index | null, at, endAt? } (ms).
//         true when the newest take is retry number nudge.retries of the same song in a
//         row (whole song or any line of it: they count together), and again every
//         nudge.repeatEvery after. A pause over nudge.restGapSec between two takes, or
//         another song, starts the count again.
//   GRADE_WORDS: one plain sentence per letter, for 'finding', 'tooShort', 'sangTooLittle',
//         'silver', 'heldBack', 'heldBackSong' and 'rest' (the spec's final words, 11.1).

import { analyse } from '../../coach.js';
import { GRADES } from './grades.config.js';
import { SONG } from './config.js';
import { foldCents, nearestCents } from './lineresults.js';

export { foldCents };

// The final words (spec 11.1). The page never prints "grade", "rank" or "score": it says
// "letter" and "percent". heldBackSong is NOT in the spec (it came with judge.topSongShare).
export const GRADE_WORDS = Object.freeze({
  SS: 'Right on the tune, nearly every note.',
  S: 'On the tune almost all the way.',
  A: 'With the tune most of the way.',
  B: 'More than half of it landed.',
  C: 'The tune is starting to land.',
  finding: 'Still finding this one. Every go helps.',
  tooShort: 'Too short for a letter. Sing a few more lines.',
  sangTooLittle: 'Sing at least half of the song for a letter.',
  silver: 'Silver: sung by ear, with your pitch line hidden.',
  heldBack: 'One line is still being found; land it for the next letter.',
  heldBackSong: 'Sing nearly all of the song for the next letter.',
  rest: 'That is a lot of goes in a row.',
});

// ---------------------------------------------------------------- judging

export function accuracyOf(counts, config = GRADES) {
  if (!counts || !(counts.judged > 0)) return null;
  const W = config.judge.windows;
  let points = 0;
  for (const w of W) points += w.points * (counts[w.id] || 0);
  // Multiplied before dividing so that a whole-number result (19 of 20 = 95) is exact and
  // sits on its cut-off, not a hair under it.
  return (100 * points) / (W[0].points * counts.judged);
}

export function createJudge(config = GRADES) {
  const J = config.judge, W = J.windows;
  let counts, list;
  const reset = () => {
    counts = { miss: 0, judged: 0, skipped: 0 };
    for (const w of W) counts[w.id] = 0;
    list = [];
  };
  reset();
  return {
    // `level` (loudness) is taken so the caller can pass a whole reading, and never read.
    add(cents, { voiced = true, clarity } = {}) {
      // Written as "not judged unless" so a missing or NaN number can never become a miss.
      if (!voiced || !Number.isFinite(cents) || (Number.isFinite(clarity) && clarity < J.minClarity)) {
        counts.skipped++;
        return null;
      }
      const c = foldCents(cents), abs = Math.abs(c);
      counts.judged++;
      list.push(c);
      for (const w of W) if (abs <= w.cents) { counts[w.id]++; return w.id; }
      counts.miss++;
      return 'miss';
    },
    counts: () => ({ ...counts }),
    accuracy: () => accuracyOf(counts, config),
    cents: () => list.slice(),
    reset,
  };
}

export function judgeFrames(frames, targetAt, config = GRADES, { offsetSec = 0 } = {}) {
  const judge = createJudge(config);
  const lag = config.judge.lagSec ?? SONG.lineStars.lagSec;
  const noteAt = (t) => {
    const got = targetAt(t + offsetSec);
    const midi = got && typeof got === 'object' ? (got.voiced === false ? null : got.midi) : got;
    return Number.isFinite(midi) ? midi : null;
  };
  for (const f of Array.isArray(frames) ? frames : []) {
    if (!f || !Number.isFinite(f.t)) continue;
    const target = noteAt(f.t);
    let cents = null;
    // Judged only where the song has a note NOW; the notes a moment either side can only
    // make the distance smaller (the line stars' rule and their function, so a line cannot
    // earn its star while its note changes are counted as far away).
    if (f.voiced && Number.isFinite(f.midi) && target !== null) {
      cents = nearestCents(f.midi, lag > 0 ? [target, noteAt(f.t - lag), noteAt(f.t + lag)] : [target]);
    }
    judge.add(cents, { voiced: !!f.voiced, clarity: f.clarity });
  }
  return { counts: judge.counts(), accuracy: judge.accuracy(), cents: judge.cents() };
}

// ---------------------------------------------------------------- the letter

const onMods = (mods, config) => Object.keys(config.mods).filter((k) => mods && mods[k]);

const lengthOf = (line) => (line && Number.isFinite(line.t) && Number.isFinite(line.end) ? Math.max(0, line.end - line.t) : 0);

export function sungTimeOf(lines, results, config = GRADES) {
  let songSungSeconds = 0, sungSeconds = 0;
  for (const line of Array.isArray(lines) ? lines : []) songSungSeconds += lengthOf(line);
  const seen = new Set();
  for (const r of Array.isArray(results) ? results : []) {
    // A line counts once, and only at a level lineresults.js gives a line that was sung.
    if (!r || seen.has(r.i) || !config.lines.levels.includes(r.level)) continue;
    seen.add(r.i);
    sungSeconds += lengthOf(r);
  }
  return { sungSeconds, songSungSeconds };
}

export function gradeOf({ accuracy, judged = null, lineLevels = [], mods = {}, sungSeconds = null, songSungSeconds = null } = {}, config = GRADES) {
  const none = { letter: null, silver: false, state: 'tooShort', nextLetter: null, pointsToNext: null, heldBack: null };
  if (!Number.isFinite(accuracy) || (judged !== null && !(judged >= config.judge.minJudged))) return none;
  let share = null;
  if (songSungSeconds !== null && songSungSeconds !== undefined) {
    // Written as "no letter unless" so a missing or NaN number can never open the gate.
    share = (Number.isFinite(sungSeconds) ? sungSeconds : 0) / songSungSeconds;
    if (!(songSungSeconds > 0) || !(share >= config.judge.minSongShare)) return { ...none, state: 'sangTooLittle' };
  }
  const L = config.letters;
  const lowLine = Array.isArray(lineLevels) && lineLevels.includes(config.lines.lowest);
  // "Not enough of the song" is also written as "unless": only a share that reaches the
  // number opens a gold letter. No share at all (an exercise) leaves the rule off.
  const partSong = share !== null && Number.isFinite(config.judge.topSongShare) && !(share >= config.judge.topSongShare);
  const lineStops = (g) => !!g.noLowestLine && lowLine, songStops = (g) => !!g.topShare && partSong;
  const open = (g) => accuracy >= g.min && !lineStops(g) && !songStops(g);
  const at = L.findIndex(open);                       // -1: under the last letter
  const above = at === -1 ? L.length - 1 : at - 1;    // the letter to aim for next
  const out = { ...none, state: at === -1 ? 'finding' : 'graded' };
  if (at !== -1) {
    out.letter = L[at].letter;
    out.silver = onMods(mods, config).some((k) => config.mods[k].silver);
  }
  if (above >= 0) {
    out.nextLetter = L[above].letter;
    out.pointsToNext = Math.max(0, L[above].min - accuracy);
    // The accuracy is there already: something else keeps the next letter away. The line is
    // named first when both do (it is the one the page can offer a retry for).
    if (out.pointsToNext === 0) out.heldBack = lineStops(L[above]) ? 'line' : 'song';
  }
  return out;
}

// ---------------------------------------------------------------- the chart

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The value a fraction `p` of the way through the sorted list, between neighbours.
function quantile(sorted, p) {
  const at = (sorted.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function histogram(centsList, config = GRADES) {
  const H = config.histogram, count = Math.round((2 * H.rangeCents) / H.binCents);
  const xs = (Array.isArray(centsList) ? centsList : []).filter(Number.isFinite);
  const bins = [];
  for (let i = 0; i < count; i++) bins.push({ from: -H.rangeCents + i * H.binCents, to: -H.rangeCents + (i + 1) * H.binCents, count: 0, share: 0 });
  let under = 0, over = 0, low = 0, high = 0;
  for (const c of xs) {
    if (c < -H.onCents) low++; else if (c > H.onCents) high++;
    if (c < -H.rangeCents) under++;
    else if (c > H.rangeCents) over++;
    // The top edge belongs to the last bin: +100 is still inside the judged window.
    else bins[Math.min(count - 1, Math.floor((c + H.rangeCents) / H.binCents))].count++;
  }
  const n = xs.length, pct = (k) => (n ? (100 * k) / n : 0);
  for (const b of bins) b.share = pct(b.count);
  // Quarter points need a few readings to mean anything: under 4 there are none.
  const sorted = n >= 4 ? xs.slice().sort((a, b) => a - b) : null;
  return {
    bins, under, over, n, median: median(xs), q1: sorted ? quantile(sorted, 0.25) : null, q3: sorted ? quantile(sorted, 0.75) : null,
    low: pct(low), on: pct(n - low - high), high: pct(high),
  };
}

// The singer's held notes, read from their own pitch (a song's curve is another singer's
// voice with its own vibrato, so it cannot say which stretch was meant as one note).
function heldNotes(frames, S) {
  const notes = [];
  let run = null;
  const close = () => {
    if (run && run.last - run.t >= S.minHoldSec) notes.push({ t: run.t, dur: run.last - run.t + 1e-6, midi: run.sum / run.n });
    run = null;
  };
  for (const f of frames) {
    if (!f || !f.voiced || !Number.isFinite(f.midi) || !Number.isFinite(f.t)) { close(); continue; }
    if (run && (f.t - run.last > S.maxGapSec || f.t <= run.last || Math.abs(100 * (f.midi - run.sum / run.n)) > S.splitCents)) close();
    if (!run) run = { t: f.t, last: f.t, sum: 0, n: 0 };
    run.last = f.t; run.sum += f.midi; run.n++;
  }
  close();
  return notes;
}

export function steadiness(frames, config = GRADES) {
  const list = Array.isArray(frames) ? frames : [];
  const notes = heldNotes(list, config.steadiness);
  if (!notes.length) return { wobble: null, notes: 0 };
  // coach.js owns the definition of wobble; this only tells it where the notes are.
  const wobbles = analyse({ title: 'take', notes }, list).notes.map((n) => n.wobble).filter((w) => w !== null);
  return { wobble: median(wobbles), notes: wobbles.length };
}

export function comboOf(lineLevels, config = GRADES) {
  let longest = 0, current = 0;
  for (const level of Array.isArray(lineLevels) ? lineLevels : []) {
    if (level === null || level === undefined || level === config.lines.unsung) continue;
    current = level === config.lines.combo ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return { longest, current };
}

// ---------------------------------------------------------------- personal bests

const timeOf = (at) => (typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN);

function cleanMods(mods, config) {
  const out = {};
  // A mod may carry its amount (slower: 0.75, keyDown: 2); anything else is just "on".
  for (const k of onMods(mods, config)) out[k] = typeof mods[k] === 'number' && Number.isFinite(mods[k]) ? mods[k] : true;
  return out;
}

function cleanResult(r, config) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.accuracy) || r.accuracy < 0 || r.accuracy > 100) return null;
  // Said outright: with a real accuracy and no letter it would otherwise be kept as 'finding'.
  if (r.state === 'tooShort' || r.state === 'sangTooLittle') return null;
  const letter = config.letters.some((g) => g.letter === r.letter) ? r.letter : null;
  const mods = cleanMods(r.mods, config);
  const whole = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  return {
    accuracy: r.accuracy,
    letter,
    silver: letter !== null && Object.keys(mods).some((k) => config.mods[k].silver),
    state: letter === null ? 'finding' : 'graded',
    judged: whole(r.judged),
    combo: whole(r.combo),
    mods,
    at: Number.isFinite(timeOf(r.at)) ? r.at : null,
    // Which take holds this result, so a "Best" chip can sit on its row. Only ever an id.
    takeId: typeof r.takeId === 'string' && r.takeId ? r.takeId : null,
  };
}

export function resultOf({ counts, accuracy, lineLevels = [], mods = {}, at = null, sungSeconds = null, songSungSeconds = null, takeId = null } = {}, config = GRADES) {
  const judged = counts ? counts.judged : null;
  const grade = gradeOf({ accuracy, judged, lineLevels, mods, sungSeconds, songSungSeconds }, config);
  return {
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    letter: grade.letter, silver: grade.silver, state: grade.state,
    judged, combo: comboOf(lineLevels, config).longest, mods: cleanMods(mods, config), at,
    takeId: typeof takeId === 'string' && takeId ? takeId : null,
  };
}

// Only a way that changes the letter (silver: "By ear") gets its own best. The full-credit
// ways (No guide voice; Slower and Lower key when they exist) share the usual best: their
// letter means the same thing (grades spec 10.1 and 20).
export function modKey(mods, config = GRADES) {
  return onMods(mods, config).filter((k) => config.mods[k].silver).join('+') || 'plain';
}

const rankOf = (letter, config) => {
  const i = config.letters.findIndex((g) => g.letter === letter);
  return i === -1 ? config.letters.length : i;       // no letter ranks under every letter
};

export function better(a, b, config = GRADES) {
  if (!a || !Number.isFinite(a.accuracy)) return false;
  if (!b || !Number.isFinite(b.accuracy)) return true;
  if (a.accuracy !== b.accuracy) return a.accuracy > b.accuracy;
  const ra = rankOf(a.letter, config), rb = rankOf(b.letter, config);
  if (ra !== rb) return ra < rb;
  const ta = timeOf(a.at), tb = timeOf(b.at);
  return Number.isFinite(ta) && (!Number.isFinite(tb) || ta < tb);
}

export const emptyBests = () => ({ v: 1, songs: {} });

const songsOf = (bests) => (bests && bests.songs && typeof bests.songs === 'object' && !Array.isArray(bests.songs) ? bests.songs : {});
const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

export function bestFor(bests, songId, mods, config = GRADES) {
  return own(own(songsOf(bests), String(songId)), modKey(mods, config)) || null;
}

export function bestAny(bests, songId, config = GRADES) {
  const sets = own(songsOf(bests), String(songId));
  let top = null;
  for (const key of Object.keys(sets || {})) if (!top || better(sets[key], top.result, config)) top = { key, result: sets[key] };
  return top;
}

export function updateBests(bests, songId, result, config = GRADES) {
  const base = { v: 1, songs: songsOf(bests) };
  const next = cleanResult(result, config);
  if (next === null || songId === null || songId === undefined || songId === '') return { bests: base, isBest: false, previous: null };
  const id = String(songId), key = modKey(next.mods, config);
  const previous = own(own(base.songs, id), key) || null;
  if (!better(next, previous, config)) return { bests: base, isBest: false, previous };
  return { bests: { v: 1, songs: { ...base.songs, [id]: { ...own(base.songs, id), [key]: next } } }, isBest: true, previous };
}

function cleanBests(raw, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
  if (!raw.songs || typeof raw.songs !== 'object' || Array.isArray(raw.songs)) return null;
  const out = emptyBests();
  for (const id of Object.keys(raw.songs)) {
    const sets = raw.songs[id];
    if (!sets || typeof sets !== 'object' || Array.isArray(sets)) continue;
    const kept = {};
    for (const key of Object.keys(sets)) {
      const r = cleanResult(sets[key], config);
      // The key is worked out again from the result, so a hand-edited key cannot put a
      // hidden-line best in the plain column. A best saved under an older key (before
      // "No guide voice" shared the usual best) moves to its key now; the better one stays.
      const k = r ? modKey(r.mods, config) : null;
      if (r && (!kept[k] || better(r, kept[k], config))) kept[k] = r;
    }
    if (Object.keys(kept).length) out.songs[id] = kept;
  }
  return out;
}

export function readBests(storage, config = GRADES) {
  const bad = () => ({ ...emptyBests(), ok: false });
  let text = null;
  try { text = storage ? storage.getItem(config.storageKey) : null; } catch { return bad(); }
  if (text === null || text === undefined || text === '') return { ...emptyBests(), ok: true };
  let raw = null;
  try { raw = JSON.parse(text); } catch { return bad(); }
  const clean = cleanBests(raw, config);
  return clean ? { ...clean, ok: true } : bad();
}

export function saveBests(storage, bests, config = GRADES) {
  if (!storage) return false;
  try {
    // What is there and cannot be read is kept once, beside it, before it is written over.
    const old = storage.getItem(config.storageKey);
    if (old && !readBests(storage, config).ok && storage.getItem(`${config.storageKey}.bad`) === null) {
      storage.setItem(`${config.storageKey}.bad`, old);
    }
  } catch { /* the copy is a kindness; the save below still gets its try */ }
  try {
    storage.setItem(config.storageKey, JSON.stringify({ v: 1, songs: cleanBests({ v: 1, songs: songsOf(bests) }, config).songs }));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- the rest nudge

export function retryNudge(history, config = GRADES) {
  const N = config.nudge;
  const list = (Array.isArray(history) ? history : []).filter((h) => h && Number.isFinite(timeOf(h.at)));
  if (!list.length) return false;
  const newest = list[list.length - 1];
  let run = 1;
  for (let i = list.length - 2; i >= 0; i--) {
    const h = list[i], after = list[i + 1];
    // The song only: take, line, take, line is one run of retries for the voice (spec 18.5).
    if (h.songId !== newest.songId) break;
    if (timeOf(newest.at) - timeOf(h.at) > N.windowSec * 1000) break;
    // The pause is counted from the END of a take when it is known: a whole song lasts
    // longer than any rest gap.
    const ended = Number.isFinite(timeOf(h.endAt)) ? timeOf(h.endAt) : timeOf(h.at);
    if (timeOf(after.at) - ended > N.restGapSec * 1000) break;
    run++;
  }
  const retries = run - 1;
  return retries >= N.retries && (retries - N.retries) % Math.max(1, N.repeatEvery) === 0;
}
