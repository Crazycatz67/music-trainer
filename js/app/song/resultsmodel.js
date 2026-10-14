// resultsmodel.js — everything the results screens SAY and DRAW for one sung take, as plain
// data: the counts bar, the picture of low and high, the held-note word, the comparison
// with the singer's best, the longest run, a take row's words, and the small letter of an
// exercise round (docs/design/specs/2026-10-13-grades-and-results.md 5.3, 5.4, 6.1, 6.3, 7, 8).
// Pure: imports in Node (tools/checks/resultsmodel.check.mjs). No DOM, no storage, no
// screens: the page and the results layer draw what this answers. Nothing here is saved
// (a sentence saved with a take would keep its old wording).
//
// CONTRACT   (config defaults to GRADES; per cent are 0..100; cents negative = low)
//   takeResults({ frames, targetAt, offsetSec?, lines, saved, mods?, at?, takeId?, practice?,
//                 rest?, ways?, bests?, songId? }, config?) -> everything for one take, in one call:
//       { counts, accuracy, cents, grade, result, hist, steady, advice, medallion, picture,
//         countsBar, unsung, run, best }
//       frames: the take's pitch frames { t, midi, clarity, voiced }; targetAt(t) -> the
//       song's note; lines: the WHOLE song's lines { t, end }; saved: lineresults.js
//       summarise(...); bests: readBests(...) BEFORE this take is added (it is not changed
//       here: the page still calls updateBests and saveBests itself, and not for practice).
//       grade = gradeOf, result = resultOf, hist = histogram, steady = steadiness,
//       advice = advice.js adviceFor, medallion = medallion.js medallionModel; the rest below.
//   countsBar(counts, config?) -> null (nothing judged) | { segments: [{ id, word, share }], note }
//       the four judgements in order, share in WHOLE per cent that add to exactly 100
//       (largest remainder). Raw counts are never shown.
//   unsungWords(saved) -> '3 lines not sung. Silence never lowers the percent.' | null
//   picture(hist, steady, { state }?, config?) -> { title, empty, emptyText, bars, farLow,
//         farHigh, middle, spread, axis, caption: [sentence], word }
//       bars: hist.bins as [{ from, to, count, height 0..1, zone }]; farLow / farHigh the
//       same for readings beyond the range. height = count over the tallest bar's count
//       (the far bars included). zone 'good' | 'close' | 'off' by the bar's INNER edge
//       against the judge's first two windows (with 10-cent bars: six good, four close).
//       middle: { cents (whole), at 0..1 across the bars } | null.
//       spread: { from, to (cents), fromAt, toAt (0..1), half (whole cents) } | null (needs q1, q3).
//       word: 'very steady' | 'steady' | 'wavering' | null (steadyWord).
//       empty: true for a tooShort take or no readings: no bars, emptyText instead.
//   steadyWord(steady, config?) -> the held-note word, or null under steadiness.minNotes
//   bestLine({ result, grade?, bests?, songId?, practice? }, config?) ->
//         { words, chip: null | { id, text, tone }, next: null | { text, panel }, shower }
//       words: the comparison sentence(s) ('' when there is nothing to say). chip.id 'new' |
//       'first' | 'part' | 'practice'; tone 'gold' | 'silver' | 'accent' | null. next: the
//       next-letter sentence; panel false = the full layer only. shower: a new best WITH a
//       letter (never for practice). `bests` is the store BEFORE this take.
//   runWords(combo, config?) -> 'Longest run: 6 lines with the singer' | null (under results.minRunLines)
//   takeWords(result) -> { words, chips: [text] }   a take row: 'A · 78 %' | 'Finding it' |
//         'part of the song · 71 %' | '' ; chips 'By ear', 'No guide voice'
//   letterWords(result) -> 'A · 78 %' | 'Finding it' | ''
//   exerciseLetter({ counts, accuracy, notes, name?, best? }, config?) -> null | { grade,
//         medallion, words, bestWords }
//       A Match and hold round or a constellation: the same judgement with the "half of the
//       song" rules off. null under results.minExerciseNotes notes or when too short.
//       words 'This round: A · 82 %' (with name: 'Lyra · A · 81 %'); bestWords 'Your best:
//       B · 70 %' | null. NOTE: counts must come from a judge fed the round's readings
//       (grades.js createJudge); the saved session notes (in25) cannot give them.
//   JUDGE_WORDS, RESULT_WORDS: the fixed words.

import { GRADES } from './grades.config.js';
import { GRADE_WORDS, bestAny, bestFor, gradeOf, histogram, judgeFrames, resultOf, steadiness, sungTimeOf, updateBests } from './grades.js';
import { adviceFor } from './advice.js';
import { medallionModel, wholePercent } from './medallion.js';

// The engine's ids are code names: the id of the last one is never printed.
export const JUDGE_WORDS = Object.freeze({ great: 'In tune', good: 'Close', ok: 'Nearby', miss: 'Elsewhere' });

export const RESULT_WORDS = Object.freeze({
  countsNote: 'of the time you sang',
  howButton: 'How the percent is worked out',
  how: 'In tune counts in full. Close counts a third. Nearby counts a sixth. Notes an octave away count as the note.',
  unsungOne: '1 line not sung. Silence never lowers the percent.',
  unsungMany: '{n} lines not sung. Silence never lowers the percent.',
  pictureTitle: 'Where your notes landed',
  pictureEmpty: 'Not enough singing for this picture yet.',
  axisLow: 'low', axisOn: 'on the note', axisHigh: 'high', axisKeyLow: 'one key low', axisKeyHigh: 'one key high',
  farLow: 'far low', farHigh: 'far high',
  middleOn: 'Your middle: on the note.',
  middleLow: 'Your middle: {n} cents low.',
  middleHigh: 'Your middle: {n} cents high.',
  half: 'Half your notes landed within {half} cents of it.',
  held: 'Held notes: {word}.',
  verySteady: 'very steady', steady: 'steady', wavering: 'wavering',
  run: 'Longest run: {n} lines with the singer',
  tooShort: 'Too short for a letter. Sing a few more lines.',
  part: 'Sing at least half of the song for a letter.',
  best: 'Your best{way}: {best}.',
  firstLetter: 'Your first letter for this song.',
  firstByEar: 'Your first letter by ear.',
  was: 'Your best{way} was {best}.',
  level: 'Level with your best{way}: {best}.',
  stays: 'Your best{way} stays {best}.',
  closer: 'Closer than last time.',
  byEarWay: ' by ear',
  chipNew: 'New best for this song', chipFirst: 'First letter', chipPart: 'Part of the song', chipPractice: 'Practice run · not saved',
  from: '{n} % from {letter}.',
  finding: 'Finding it',
  partRow: 'part of the song · {percent}',
  byEar: 'By ear', noGuide: 'No guide voice',
  round: 'This round: {best}',
  yourBest: 'Your best: {best}',
});

const R = RESULT_WORDS;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------- the counts

export function countsBar(counts, config = GRADES) {
  if (!counts || !(counts.judged > 0)) return null;
  const ids = [...config.judge.windows.map((w) => w.id), 'miss'];
  const raw = ids.map((id) => (100 * Math.max(0, counts[id] || 0)) / counts.judged);
  const share = raw.map(Math.floor);
  // Largest remainder: the whole percents must add to exactly 100, and the one-point
  // top-ups go to the shares that lost most by rounding down (earlier judgement on a tie).
  const order = raw.map((v, i) => [v - share[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0, left = 100 - share.reduce((a, b) => a + b, 0); k < order.length && left > 0; k++, left--) share[order[k][1]]++;
  return { segments: ids.map((id, i) => ({ id, word: JUDGE_WORDS[id] || id, share: share[i] })), note: R.countsNote };
}

export function unsungWords(saved) {
  const results = saved && Array.isArray(saved.results) ? saved.results : [];
  const n = results.filter((r) => r && r.level === 'none').length;
  return n === 0 ? null : n === 1 ? R.unsungOne : fill(R.unsungMany, { n });
}

// ---------------------------------------------------------------- the picture of low and high

export function steadyWord(steady, config = GRADES) {
  const S = config.steadiness, wobble = steady ? num(steady.wobble) : null;
  if (wobble === null || !(steady.notes >= S.minNotes)) return null;
  return wobble < S.veryCents ? R.verySteady : wobble < S.steadyCents ? R.steady : R.wavering;
}

export function picture(hist, steady, { state = null } = {}, config = GRADES) {
  const H = config.histogram, W = config.judge.windows;
  const word = steadyWord(steady, config);
  const out = {
    title: R.pictureTitle, empty: true, emptyText: R.pictureEmpty, bars: [], farLow: null, farHigh: null, middle: null, spread: null,
    axis: { low: R.axisLow, on: R.axisOn, high: R.axisHigh, keyLow: R.axisKeyLow, keyHigh: R.axisKeyHigh, farLow: R.farLow, farHigh: R.farHigh },
    caption: [], word,
  };
  if (!hist || !(hist.n > 0) || !Array.isArray(hist.bins) || state === 'tooShort') return out;
  const tallest = Math.max(1, hist.under || 0, hist.over || 0, ...hist.bins.map((b) => b.count));
  // By the bar's inner edge: the bar from 20 to 30 straddles "In tune" (25) and is drawn as
  // In tune (the picture is a shape; the exact shares are in the counts).
  const zone = (b) => {
    const inner = Math.min(Math.abs(b.from), Math.abs(b.to));
    return inner < W[0].cents ? 'good' : inner < W[1].cents ? 'close' : 'off';
  };
  const along = (cents) => Math.max(0, Math.min(1, (cents + H.rangeCents) / (2 * H.rangeCents)));
  out.empty = false;
  out.emptyText = null;
  out.bars = hist.bins.map((b) => ({ from: b.from, to: b.to, count: b.count, height: b.count / tallest, zone: zone(b) }));
  out.farLow = { count: hist.under || 0, height: (hist.under || 0) / tallest, zone: 'off' };
  out.farHigh = { count: hist.over || 0, height: (hist.over || 0) / tallest, zone: 'off' };
  const median = num(hist.median);
  if (median !== null) {
    const cents = Math.round(median) || 0;
    out.middle = { cents, at: along(cents) };
    // "low" and "high", never flat or sharp; the number is given without a sign.
    out.caption.push(Math.abs(median) <= config.results.onNoteCents ? R.middleOn : fill(median < 0 ? R.middleLow : R.middleHigh, { n: Math.abs(cents) }));
  }
  const q1 = num(hist.q1), q3 = num(hist.q3);
  if (q1 !== null && q3 !== null) {
    const half = Math.round((q3 - q1) / 2);
    out.spread = { from: q1, to: q3, fromAt: along(q1), toAt: along(q3), half };
    out.caption.push(fill(R.half, { half }));
  }
  if (word) out.caption.push(fill(R.held, { word }));
  return out;
}

// ---------------------------------------------------------------- the comparison with the best

export const letterWords = (result) => {
  if (!result || !Number.isFinite(result.accuracy)) return '';
  if (result.letter) return `${result.letter} · ${wholePercent(result.accuracy)} %`;
  return result.state === 'finding' || !result.state ? R.finding : '';
};

function nextLine(grade, config) {
  if (!grade || !grade.nextLetter || grade.state === 'tooShort' || grade.state === 'sangTooLittle') return null;
  if (grade.heldBack === 'line') return { text: GRADE_WORDS.heldBack, panel: true };
  if (grade.heldBack === 'song') return { text: GRADE_WORDS.heldBackSong, panel: true };
  const points = num(grade.pointsToNext);
  if (points === null || points <= 0) return null;
  // Rounded UP, so it is never "0 % from".
  return { text: fill(R.from, { n: Math.max(1, Math.ceil(points - 1e-9)), letter: grade.nextLetter }), panel: points <= config.results.nearPoints };
}

export function bestLine({ result, grade = null, bests = null, songId = null, practice = false } = {}, config = GRADES) {
  const none = { words: '', chip: null, next: null, shower: false };
  if (!result || typeof result !== 'object') return { ...none, words: R.tooShort };
  const mods = result.mods || {}, byEar = !!mods.noLine;
  const way = byEar ? R.byEarWay : '';
  const previous = bestFor(bests, songId, mods, config);
  // A best with no letter has a percent the singer was never shown: it is not quoted.
  const quoted = previous && previous.letter ? letterWords(previous) : '';
  const yourBest = quoted ? fill(R.best, { way, best: quoted }) : '';
  const next = nextLine(grade, config);
  const tone = byEar ? 'silver' : 'gold';

  if (result.state === 'tooShort' || !Number.isFinite(result.accuracy)) return { ...none, words: R.tooShort };
  if (result.state === 'sangTooLittle') return { ...none, words: [R.part, yourBest].filter(Boolean).join(' '), chip: { id: 'part', text: R.chipPart, tone: null } };
  if (practice) return { ...none, words: yourBest, chip: { id: 'practice', text: R.chipPractice, tone: null }, next };

  const isBest = updateBests(bests, songId, result, config).isBest;
  if (result.letter) {
    if (!quoted) {
      // The first letter this way. Said as "by ear" only when the usual way has one already.
      const other = bestAny(bests, songId, config);
      const first = byEar && other && other.result && other.result.letter ? R.firstByEar : R.firstLetter;
      return { words: first, chip: { id: 'first', text: R.chipFirst, tone: 'accent' }, next, shower: isBest };
    }
    if (isBest) return { words: fill(R.was, { way, best: quoted }), chip: { id: 'new', text: R.chipNew, tone }, next, shower: true };
    const level = previous.letter === result.letter && wholePercent(previous.accuracy) === wholePercent(result.accuracy);
    return { ...none, words: fill(level ? R.level : R.stays, { way, best: quoted }), next };
  }
  // "Finding it": never a chip, never the shower.
  if (quoted) return { ...none, words: fill(R.stays, { way, best: quoted }), next };
  return { ...none, words: previous && isBest ? R.closer : '', next };
}

export function runWords(combo, config = GRADES) {
  return Number.isFinite(combo) && combo >= config.results.minRunLines ? fill(R.run, { n: Math.floor(combo) }) : null;
}

export function takeWords(result) {
  const chips = [];
  const mods = (result && result.mods) || {};
  if (mods.noLine) chips.push(R.byEar);
  if (mods.noGuide) chips.push(R.noGuide);
  if (!result || !Number.isFinite(result.accuracy) || result.state === 'tooShort') return { words: '', chips };
  if (result.state === 'sangTooLittle') return { words: fill(R.partRow, { percent: `${wholePercent(result.accuracy)} %` }), chips };
  return { words: letterWords(result), chips };
}

// ---------------------------------------------------------------- an exercise round

export function exerciseLetter({ counts, accuracy, notes = 0, name = null, best = null } = {}, config = GRADES) {
  if (!(notes >= config.results.minExerciseNotes)) return null;
  // No sung-time numbers: the "half of the song" and "most of the song" rules are off.
  const grade = gradeOf({ accuracy, judged: counts ? counts.judged : null }, config);
  if (grade.state === 'tooShort') return null;
  const result = { ...grade, accuracy };
  const said = letterWords(result);
  return {
    grade, medallion: medallionModel(result, config),
    words: name ? `${name} · ${said}` : fill(R.round, { best: said }),
    bestWords: best && letterWords(best) ? fill(R.yourBest, { best: letterWords(best) }) : null,
  };
}

// ---------------------------------------------------------------- one take, one call

export function takeResults({
  frames = [], targetAt, offsetSec = 0, lines = [], saved = null, mods = {}, at = null, takeId = null, practice = false,
  rest = false, ways = {}, bests = null, songId = null,
} = {}, config = GRADES) {
  const { counts, accuracy, cents } = judgeFrames(frames, typeof targetAt === 'function' ? targetAt : () => null, config, { offsetSec });
  const results = saved && Array.isArray(saved.results) ? saved.results : [];
  const lineLevels = results.map((r) => (r ? r.level : null));
  const { sungSeconds, songSungSeconds } = sungTimeOf(lines, results, config);
  const grade = gradeOf({ accuracy, judged: counts.judged, lineLevels, mods, sungSeconds, songSungSeconds }, config);
  const result = resultOf({ counts, accuracy, lineLevels, mods, at, sungSeconds, songSungSeconds, takeId }, config);
  const hist = histogram(cents, config), steady = steadiness(frames, config);
  return {
    counts, accuracy, cents, grade, result, hist, steady,
    advice: adviceFor({ grade, hist, steady, saved, mods, rest, ways }, config),
    medallion: medallionModel(result, config),
    picture: picture(hist, steady, { state: grade.state }, config),
    // A too-short take shows no counts either (spec 5.5).
    countsBar: grade.state === 'tooShort' ? null : countsBar(counts, config),
    unsung: unsungWords(saved),
    run: runWords(result.combo, config),
    best: bestLine({ result, grade, bests, songId, practice }, config),
  };
}
