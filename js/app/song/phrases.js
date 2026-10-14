// phrases.js — when the singer sings and when they rest, read from the pitch curve alone
// (docs/design/specs/2026-10-12-song-mode.md sections 5.3 and 5.4). Pure: imports in Node.
//
// Everything a song needs to be followed with no words at all comes from here: the "your
// turn" lamp, the rests, the count-in before each phrase, and where a jump should land.
//
// TIME is seconds from the start of the song's audio. A phrase = { t, end }.
//
// CONTRACT
//   derivePhrases(curve, cfg?) -> [{ t, end }] in time order
//       Unbroken singing: voiced frames with no hole longer than gapSec. A stretch shorter
//       than minSec joins the phrase before it, or else the one after it, when that one is
//       within joinSec; otherwise it is dropped (a cough, a stray reading).
//   restsOf(phrases, duration) -> [{ t, end }]     every gap, the intro and the ending too
//   songFacts(curve, { duration }) -> { duration, range, phrases, rests, sungSec, sungShare }
//       range = curveRange(curve): { lowest, highest (the extremes), low, high (the band
//       most of the song sits in), median, ... } in MIDI floats, or null when nothing is sung.
//   phraseAt(phrases, t) -> index of the phrase that contains t, else -1
//   nextPhrase(phrases, t) -> index of the first phrase starting after t, else -1
//   lampAt(phrases, t, { duration?, cfg? }) -> { state, phrase, seconds, breathe }
//       state  'turn'   inside a phrase, or in a breath (a gap under restSec: breathe true)
//              'rest'   in a gap of restSec or more, more than readySec before the next phrase
//              'ready'  the last readySec of such a gap (the whole of a shorter one)
//              'intro'  before the first phrase, more than readySec before it
//              'after'  after the last phrase
//       phrase  the current phrase's index, or the next one's (-1 after the last)
//       seconds whole seconds until the next phrase (rest, ready, intro), else null
//       The screen adds "Paused" and the rule that the prompt never changes twice within
//       SONG.prompt.holdMs. restSec is 5 (owner 2026-10-13): a gap under it changes nothing.
//   beadTimes(phrases, index, { bpm?, cfg? }) -> [seconds]   rising; the count-in before
//       phrase `index`: readySec, ..., 2, 1 seconds before its start, as many as fit in the
//       gap before it; none before a gap under cfg.beadGapSec (2 s: the chart songs' click
//       track counts on it; the Sing page passes its own, restSec). With a bpm: one beat apart, the last a beat
//       before the entry, four when four beats fit.
//   countdownAt(phrases, t, { sec?, minGapSec? }) -> { phrase, left, seconds, of } | null
//       The spoken-out count before a phrase ("Sing in 3, 2, 1"): not null only in the last
//       `sec` seconds before a phrase whose intro or rest is at least minGapSec long.
//       left = seconds to the phrase's start (a float), seconds = the number to show (whole,
//       never under 1), of = how many numbers this gap has room for (a 2.4 s rest: 2).
//   countInAt(elapsedSec, totalSec?) -> { seconds, left, of, done }
//       The count after pressing Sing, before the song moves: 3, 2, 1, then done.
//   leadIn(phrases, t, { exact = false, cfg? }) -> seconds   where the music should start
//       so that there is a count-in before t: readySec earlier, or at the end of the phrase
//       before when that is nearer; t itself when `exact`. Never below 0.

import { SONG } from './config.js';
import { curveRange, voicedStretches } from '../analyse/curve.js';

const P = SONG.phrases;

export function derivePhrases(curve, cfg = P) {
  if (!curve || !Array.isArray(curve.t) || !curve.t.length) return [];
  const raw = voicedStretches(curve, { maxGap: cfg.gapSec }).map((s) => ({ t: s.t, end: s.t + s.dur })).sort((a, b) => a.t - b.t);
  const out = [];
  let carry = null;         // a short stretch waiting to join the phrase after it
  for (const s of raw) {
    const piece = carry && s.t - carry.end <= cfg.joinSec ? { t: carry.t, end: s.end } : s;
    carry = null;
    if (piece.end - piece.t >= cfg.minSec) { out.push(piece); continue; }
    const before = out[out.length - 1];
    if (before && piece.t - before.end <= cfg.joinSec) before.end = piece.end;
    else carry = piece;
  }
  return out;
}

export function restsOf(phrases, duration) {
  const out = [];
  let at = 0;
  for (const p of phrases) { if (p.t > at) out.push({ t: at, end: p.t }); at = Math.max(at, p.end); }
  if (Number.isFinite(duration) && duration > at) out.push({ t: at, end: duration });
  return out;
}

export function songFacts(curve, { duration, cfg = P } = {}) {
  const phrases = derivePhrases(curve, cfg);
  const length = Number.isFinite(duration) ? duration : (curve && curve.t.length ? curve.t[curve.t.length - 1] : 0);
  const sungSec = phrases.reduce((s, p) => s + (p.end - p.t), 0);
  return {
    duration: length, range: phrases.length ? curveRange(curve) : null, phrases, rests: restsOf(phrases, length),
    sungSec: Math.round(sungSec * 100) / 100, sungShare: length > 0 ? Math.round((sungSec / length) * 1000) / 1000 : 0,
  };
}

export function phraseAt(phrases, t) {
  for (let i = 0; i < phrases.length; i++) { if (t < phrases[i].t) return -1; if (t < phrases[i].end) return i; }
  return -1;
}

export function nextPhrase(phrases, t) {
  for (let i = 0; i < phrases.length; i++) if (phrases[i].t > t) return i;
  return -1;
}

export function lampAt(phrases, t, { cfg = P } = {}) {
  const here = phraseAt(phrases, t);
  if (here >= 0) return { state: 'turn', phrase: here, seconds: null, breathe: false };
  const next = nextPhrase(phrases, t);
  if (next < 0) return { state: 'after', phrase: -1, seconds: null, breathe: false };
  const left = phrases[next].t - t, seconds = Math.max(1, Math.ceil(left - 1e-9));
  if (next === 0) return { state: left <= cfg.readySec ? 'ready' : 'intro', phrase: 0, seconds, breathe: false };
  const gap = phrases[next].t - phrases[next - 1].end;
  if (gap < cfg.restSec) return { state: 'turn', phrase: next, seconds: null, breathe: true };
  return { state: left <= cfg.readySec ? 'ready' : 'rest', phrase: next, seconds, breathe: false };
}

export function beadTimes(phrases, index, { bpm = null, cfg = P } = {}) {
  const p = phrases[index];
  if (!p) return [];
  const room = index === 0 ? p.t : p.t - phrases[index - 1].end;
  if (index > 0 && room < (cfg.beadGapSec ?? cfg.restSec)) return [];
  const step = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : 1;
  const most = Number.isFinite(bpm) && bpm > 0 ? (room >= 4 * step ? 4 : 3) : Math.round(cfg.readySec);
  const out = [];
  for (let k = most; k >= 1; k--) if (k * step <= room + 1e-9) out.push(Math.round((p.t - k * step) * 1000) / 1000);
  return out;
}

export function countdownAt(phrases, t, { sec = SONG.countIn.phraseSec, minGapSec = SONG.countIn.minGapSec } = {}) {
  if (!phrases || !phrases.length || !(sec > 0) || phraseAt(phrases, t) >= 0) return null;
  const next = nextPhrase(phrases, t);
  if (next < 0) return null;
  const gap = next === 0 ? phrases[0].t : phrases[next].t - phrases[next - 1].end;
  const left = phrases[next].t - t;
  if (gap < minGapSec || left > sec) return null;
  // A rest shorter than the count has fewer numbers; it never opens on one it has no room for.
  const of = Math.max(1, Math.min(Math.round(sec), Math.floor(gap + 1e-9)));
  return { phrase: next, left, seconds: Math.min(of, Math.max(1, Math.ceil(left - 1e-9))), of };
}

export function countInAt(elapsedSec, totalSec = SONG.countIn.startSec) {
  const left = Math.max(0, totalSec - Math.max(0, elapsedSec || 0)), done = !(left > 0);
  return { seconds: done ? 0 : Math.max(1, Math.ceil(left - 1e-9)), left, of: Math.max(1, Math.round(totalSec)), done };
}

export function leadIn(phrases, t, { exact = false, cfg = P } = {}) {
  if (exact || !Number.isFinite(t)) return Math.max(0, t || 0);
  let from = t - cfg.readySec;
  // The end of the phrase before, when that is nearer: no need to replay the line before.
  for (const p of phrases || []) if (p.end <= t + 1e-9 && p.end > from) from = p.end;
  return Math.max(0, Math.min(t, from));
}
