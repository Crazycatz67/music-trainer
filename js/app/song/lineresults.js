// lineresults.js — line stars: how each line of a song went, as one of three levels
// (docs/design/specs/2026-10-13-sing-page-sky.md section 2). THE LOGIC HALF: no DOM, no
// sound, runs in Node (tools/checks/lineresults.check.mjs). The Sing page
// (js/app/singnow.js) feeds it the microphone's readings and draws what it answers.
//
// THE RULE (spec 2.1). A line is { t, end } in seconds of song. Every reading whose time
// is inside the line AND where the singer is singing adds to three counts:
//   n  readings in the singer's sung time
//   v  of those, readings where the owner's voice has a pitch
//   g  of those, readings within closeCents of the singer, OCTAVE-FOLDED, taking the
//      nearest of the singer's note at t, t - lagSec and t + lagSec (people land a hair late)
// The share that decides is g / v: of the owner's PITCHED readings (consonants and breaths
// have no pitch; counting them would put the top level out of reach on real words).
// Nothing here is a grade and no share is ever shown: the page draws a star or nothing.
//
// CONTRACT (cfg = SONG.lineStars everywhere; cents are 100 * (sung - singer))
//   foldCents(cents) -> -600..600     the distance with whole octaves taken out: one octave
//                                     under the singer is 0. THE one octave rule of the page:
//                                     the light, the readout's colour and the stars all use it.
//   nearestCents(midi, targets) -> folded cents to the nearest of `targets` (MIDI or null), null if none
//   newCounts() -> counts             { n, v, g, cents: [], firstN, firstV, lastT }
//   addReading(counts, { t, midi | null, targets: [at t, at t - lag, at t + lag] }, cfg?) -> counts
//       targets[0] === null (the singer rests): nothing is counted.
//   lineResult({ n, v, g }, cfg?) -> 'with' | 'close' | 'finding' | 'none'
//   settle(counts, line, i, cfg?) -> result
//       result = { i, t, end, level, share, sung, median, late }
//         share  whole percent, g / v (0 when v is 0)      sung  whole percent, v / n
//         median whole cents, the middle folded distance of the pitched readings (null: none)
//         late   seconds (one decimal) from the singer's first note in the line to the
//                owner's first pitched reading (null: none)
//   heardToEnd(counts, line, cfg?) -> boolean   the readings reach the line's last nearEndSec
//       (a loop wraps at the line's end and a song ends on its last line: both count as sung through)
//   better(prev | null, next) -> result         the one to keep: a star only ever goes up
//   scoreLines({ lines, frames: [{ t, midi | null }], targetAt(t) -> MIDI | null }, cfg?) -> [result]
//       a whole take at once, by the same rule (an older take with no saved results).
//       Only lines the frames run through to the end are settled.
//   summarise(results, { total, source: 'words' | 'phrases' }) -> saved
//       saved = { v: 1, folded: true, source, total, sung, with, close, best, practise, results }
//       sung: lines not 'none'. best, practise: a line's index `i` (0-based, as results[].i) or null.
//   bestOf(results) -> result | null       highest share among sung lines (tie: the longer line)
//   practiseOf(results) -> result | null   lowest share among sung lines that are not 'with'
//   headingWords(saved) -> { text, cards }     the end panel's sentence; cards false: too short
//   reasonWords(result, cfg?) -> 'mostly a little low' | 'mostly a little high' | 'the start came late' | 'worth another go'
//   newBest(saved, bestLines | null, cfg?) -> boolean
//   endChimePlan(lastMidi | null, { best = false }, rewardsCfg?, cfg?) -> [{ midi, at, dur }]
//       the root and the fifth on the singer's last note, moved by octaves into the window
//   LEVEL_WORDS, LEVEL_RANK

import { CONFIG } from '../config.js';
import { SONG } from './config.js';

const S = SONG.lineStars;

export const LEVEL_WORDS = Object.freeze({ with: 'With the singer', close: 'Close', finding: 'Finding it', none: 'Not sung' });
export const LEVEL_RANK = Object.freeze({ none: 0, finding: 1, close: 2, with: 3 });

export const foldCents = (c) => ((((c % 1200) + 1800) % 1200) - 600) || 0;

export function nearestCents(midi, targets) {
  let best = null;
  for (const target of targets) {
    if (target === null || target === undefined || !Number.isFinite(target)) continue;
    const c = foldCents(100 * (midi - target));
    if (best === null || Math.abs(c) < Math.abs(best)) best = c;
  }
  return best;
}

export const newCounts = () => ({ n: 0, v: 0, g: 0, cents: [], firstN: null, firstV: null, lastT: null });

export function addReading(counts, { t, midi = null, targets = [] }, cfg = S) {
  if (targets[0] === null || targets[0] === undefined) return counts;
  counts.n++;
  if (counts.firstN === null) counts.firstN = t;
  counts.lastT = t;
  if (midi === null || !Number.isFinite(midi)) return counts;
  const c = nearestCents(midi, targets);
  if (c === null) return counts;
  counts.v++;
  if (counts.firstV === null) counts.firstV = t;
  // One "near enough" for the page: the verdict's own close line (50 cents) unless a test sets another.
  if (Math.abs(c) <= (cfg.closeCents ?? CONFIG.verdict.closeCents)) counts.g++;
  counts.cents.push(Math.round(c));
  return counts;
}

export function lineResult(counts, cfg = S) {
  const { n = 0, v = 0, g = 0 } = counts || {};
  if (n < cfg.minReadings || v / n < cfg.minSungShare) return 'none';
  if (g / v >= cfg.withShare && v / n >= cfg.withSungShare) return 'with';
  if (g / v >= cfg.closeShare) return 'close';
  return 'finding';
}

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b), m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

export function settle(counts, line, i, cfg = S) {
  return {
    i, t: line.t, end: line.end, level: lineResult(counts, cfg),
    share: counts.v ? Math.round((100 * counts.g) / counts.v) : 0,
    sung: counts.n ? Math.round((100 * counts.v) / counts.n) : 0,
    median: median(counts.cents),
    late: counts.firstV === null || counts.firstN === null ? null : Math.round((counts.firstV - counts.firstN) * 10) / 10,
  };
}

export const heardToEnd = (counts, line, cfg = S) => !!counts && counts.lastT !== null && counts.lastT >= line.end - cfg.nearEndSec;

export function better(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const a = LEVEL_RANK[prev.level] ?? 0, b = LEVEL_RANK[next.level] ?? 0;
  return b > a || (b === a && next.share > prev.share) ? next : prev;
}

export function scoreLines({ lines = [], frames = [], targetAt }, cfg = S) {
  const out = [];
  let k = 0;
  const lastT = frames.length ? frames[frames.length - 1].t : -Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], counts = newCounts();
    while (k < frames.length && frames[k].t < line.t) k++;
    let j = k;
    for (; j < frames.length && frames[j].t < line.end; j++) {
      const f = frames[j];
      addReading(counts, { t: f.t, midi: f.midi, targets: [targetAt(f.t), targetAt(f.t - cfg.lagSec), targetAt(f.t + cfg.lagSec)] }, cfg);
    }
    // Lines may overlap by a hair: the next one starts its own search from this one's start.
    if (j > k && lastT >= line.end - cfg.nearEndSec && frames[k].t <= line.t + cfg.nearEndSec + cfg.lagSec) out.push(settle(counts, line, i, cfg));
  }
  return out;
}

const sungOnes = (results) => (results || []).filter((r) => r && r.level !== 'none');

export function bestOf(results) {
  let best = null;
  for (const r of sungOnes(results)) if (!best || r.share > best.share || (r.share === best.share && r.end - r.t > best.end - best.t)) best = r;
  return best;
}

export function practiseOf(results) {
  let low = null;
  for (const r of sungOnes(results)) if (r.level !== 'with' && (!low || r.share < low.share)) low = r;
  return low;
}

export function summarise(results, { total = 0, source = 'phrases' } = {}) {
  const list = [...(results || [])].sort((a, b) => a.i - b.i);
  const sung = sungOnes(list), best = bestOf(list), practise = practiseOf(list);
  return {
    v: 1, folded: true, source, total, sung: sung.length,
    with: sung.filter((r) => r.level === 'with').length, close: sung.filter((r) => r.level === 'close').length,
    best: best ? best.i : null, practise: practise ? practise.i : null, results: list,
  };
}

export function headingWords(saved, cfg = S) {
  const s = saved || { sung: 0, with: 0, close: 0, total: 0, results: [] };
  if (s.sung < cfg.minLinesForPanel) return { text: 'Too short for line stars. Sing a few more lines.', cards: false };
  const whole = s.total > 0 && s.results.length >= s.total, n = whole ? s.total : s.sung;
  if (!s.with && s.close) return { text: `You were close to the singer on ${s.close} of ${whole ? `${n} lines` : `the ${n} lines you sang`}.`, cards: true };
  if (!s.with) return { text: 'No stars this time. The first runs are for learning the tune.', cards: true };
  return { text: whole ? `You were with the singer for ${s.with} of ${n} lines.` : `You were with the singer for ${s.with} of the ${n} lines you sang.`, cards: true };
}

export function reasonWords(r, cfg = S) {
  if (r && Number.isFinite(r.median) && r.median <= -cfg.lowHighCents) return 'mostly a little low';
  if (r && Number.isFinite(r.median) && r.median >= cfg.lowHighCents) return 'mostly a little high';
  if (r && Number.isFinite(r.late) && r.late > cfg.lateSec) return 'the start came late';
  return 'worth another go';
}

export const newBest = (saved, bestLines, cfg = S) => !!saved && saved.with >= cfg.minBest && saved.with > ((bestLines && Number(bestLines.with)) || 0);

export function endChimePlan(lastMidi, { best = false } = {}, rewards = CONFIG.rewards, cfg = S) {
  let root = Number.isFinite(lastMidi) ? Math.round(lastMidi) : rewards.chimeRootMidi;
  if (Number.isFinite(lastMidi)) {
    while (root < cfg.chimeLoMidi) root += 12;
    while (root > cfg.chimeHiMidi) root -= 12;
  }
  // Root and fifth only (no third): it sits on a major and on a minor song alike.
  return [0, 7, ...(best ? [12] : [])].map((step, k) => ({ midi: root + step, at: k * rewards.chimeStepSec, dur: rewards.chimeNoteSec }));
}
