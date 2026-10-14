// longnote.js — Long note: one comfortable note held as long and as steadily as is easy.
// How a hold is measured from pitch frames, how it is said in words, the rest rule, and the
// saved bests (owner approved 2026-10-13; numbers in config.longNote, every one a GUESS).
// Teacher advice, not study evidence: nothing here is ever a "fail", and the rest rule is
// there so that nobody pushes.
//
// PURE: imports in Node (tools/checks/longnote.check.mjs). No browser global is touched;
// storage is always passed in. Frames are js/pitch.js frames { t (seconds), midi, voiced }.
//
// HOW A HOLD IS MEASURED
//   1. A STEADY STRETCH is the rule of js/app/range.js createHoldWatch with this module's
//      numbers: voice whose lowest and highest readings are no more than 2 x bandCents apart
//      (so every reading is within bandCents of the stretch's own centre: the singer's note,
//      not a target), a dropout under gapMs bridged, readings off the note for less than
//      glitchMs ignored.
//   2. The HOLD is the longest steady stretch of the take, if it lasted minHoldSec.
//      seconds = time from its first reading to its last.
//   3. DRIFT (cents) = the middle reading of its last driftWindowSec less the middle reading
//      of its first driftWindowSec. Negative = it sank. null under 2 x driftWindowSec.
//   4. WOBBLE (cents) = js/coach.js analyse()'s `wobble` for the hold against its own centre:
//      the spread left once a steady drift is taken out, so the two are not counted twice.
//
// CONTRACT
//   watchConfig(cfg?) -> the createHoldWatch / steadyHolds numbers for this exercise
//   noteFor(range, cfg?) -> midi   the note offered: range.home (js/app/range.js
//       exerciseRange), else cfg.defaultMidi. Always a whole note.
//   createHoldMeter(cfg?) -> { push(frame) -> state, state(), reset() }     the live reading
//       state = { phase, sec, bestSec, midi, quietSec, why }
//       phase 'waiting' (no hold yet) | 'holding' | 'ended'
//       sec: the steady stretch that ends at the newest reading (0: none). bestSec: the
//       longest so far. midi: that stretch's centre | null. quietSec: seconds since the last
//       sung reading (since the first reading when nothing was sung).
//       why: null | 'silence' (endSilenceMs with no voice after a hold of minHoldSec) |
//       'cap' (maxHoldSec reached) | 'time' (listenSec since the first reading, in ANY phase:
//       the hard limit on one listening, for noise or a note that never settles). A stretch
//       under minHoldSec followed by silence is not an end: the meter goes back to 'waiting'.
//       After 'ended' nothing changes until reset().
//   measureHold(frames, cfg?) -> hold
//       hold = { ok, sec, t0, t1, midi, note, driftCents, wobbleCents, gaps, gapMs, frames }
//       ok false (nothing steady for minHoldSec): sec 0 and the rest null / 0 / [].
//       gaps / gapMs: dropouts bridged inside the hold, and their total length.
//       frames: the hold's own readings [{ t, midi }], t from 0 (for the practice record).
//   steadiness(hold, cfg?) -> { kind, dir, cents }
//       kind 'steady' | 'drifted' | 'wobbled' | 'short' (too short to tell).
//       dir 'down' | 'up' | null; cents: whole cents of the drift, or of the wobble.
//   breathLevel(sec, cfg?) -> 'short' | 'easy' | 'long'
//   secondsWords(sec) -> "12.4 seconds"
//   holdWords(hold, cfg?) -> { seconds, steady, breath, tip, kind, level }
//   restPlan(holdsInSet, cfg?) -> { restSec, setDone }
//   createSitting(cfg?) -> sitting        the rest rule; times are milliseconds handed in
//       sitting.state(nowMs) -> { phase, holds, sets, restLeftSec, restLeftMs, canStart }
//           phase 'ready' | 'sing' | 'rest' | 'done' (the set is over: the long rest)
//       sitting.start(nowMs) -> boolean   refused while singing or while a rest is running
//       sitting.held(nowMs)               sing -> rest, or done after holdsPerSet
//       sitting.cancel()                  sing -> where it was; nothing counted, no new rest
//   LONGNOTE_KEY   'music-trainer.longnote.v1' ->
//       { v: 1, best: { sec, at (ISO), day } | null, days: [{ day, sec, holds }] } oldest first
//   readRecord(storage) -> record         never throws; unreadable or nonsense: empty
//   nextRecord(prev, { sec, day, at }, cfg?) -> { record, firstTime, newBest, dayBest, today }
//       newBest: longer than an earlier best. dayBest: the longest of that day so far.
//       today = { day, sec, holds } after this hold.
//   saveHold(storage, { sec, at?, day? }, cfg?) -> nextRecord(...) + { saved }
//       saved false when the storage refused: the result still stands for this visit.
//   recentDays(record, today, n?) -> [{ day, sec | null }]   the last n calendar days, oldest first
//   bestWords(record, today) -> { today, ever }   "Best today: 12.4 seconds", "Your best: 14.0 seconds on 11 Oct"
//   dayLabelOf('YYYY-MM-DD') -> "12 Oct" ('' when unreadable)
//   WORDS          the screen's fixed sentences

import { analyse } from '../coach.js';
import { CONFIG } from './config.js';
import { createHoldWatch, dayWords, steadyHolds } from './range.js';
import { addDays, dayKey } from './sessions.js';
import { STORAGE_PREFIX } from './shell.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function watchConfig(cfg = CONFIG.longNote) {
  return { steadyCents: cfg.bandCents, gapMs: cfg.gapMs, glitchMs: cfg.glitchMs, minMidi: cfg.minMidi, maxMidi: cfg.maxMidi, coverMs: cfg.minHoldSec * 1000 };
}

const sung = (f, cfg) => !!f && f.voiced !== false && isNum(f.midi) && isNum(f.t) && f.midi >= cfg.minMidi && f.midi <= cfg.maxMidi;

export function noteFor(range, cfg = CONFIG.longNote) {
  const home = range && isNum(range.home) ? range.home : cfg.defaultMidi;
  return Math.round(home);
}

// ---------------------------------------------------------------- the live reading

export function createHoldMeter(cfg = CONFIG.longNote) {
  const watch = createHoldWatch(watchConfig(cfg));
  let phase = 'waiting', sec = 0, bestSec = 0, midi = null, firstT = null, lastSungT = null, lastT = null, why = null;
  const state = () => ({
    phase, sec, bestSec, midi, why,
    quietSec: lastT === null ? 0 : Math.max(0, lastT - (lastSungT ?? firstT)),
  });
  return {
    state,
    push(frame) {
      if (phase === 'ended' || !frame || !isNum(frame.t)) return state();
      const s = watch.push(frame);
      if (firstT === null) firstT = frame.t;
      lastT = frame.t;
      if (sung(frame, cfg)) lastSungT = frame.t;
      sec = s.midi === null ? 0 : s.heldMs / 1000;
      midi = s.midi;
      if (sec > bestSec) bestSec = sec;
      if (phase === 'waiting' && sec * 1000 >= cfg.startMs) phase = 'holding';
      // Before the others: voiced noise is never silence and never steady, so only this ends it.
      if (isNum(cfg.listenSec) && frame.t - firstT >= cfg.listenSec) { phase = 'ended'; why = 'time'; }
      else if (phase === 'holding') {
        if (bestSec >= cfg.maxHoldSec) { phase = 'ended'; why = 'cap'; }
        else if (lastSungT !== null && (frame.t - lastSungT) * 1000 >= cfg.endSilenceMs) {
          if (bestSec >= cfg.minHoldSec) { phase = 'ended'; why = 'silence'; }
          // A cough, a false start: not a hold, and not the end of the listening either.
          else { phase = 'waiting'; bestSec = 0; }
        }
      }
      return state();
    },
    reset() { watch.reset(); phase = 'waiting'; sec = 0; bestSec = 0; midi = null; firstT = null; lastSungT = null; lastT = null; why = null; },
  };
}

// ---------------------------------------------------------------- one hold, measured

const noHold = () => ({ ok: false, sec: 0, t0: null, t1: null, midi: null, note: null, driftCents: null, wobbleCents: null, gaps: 0, gapMs: 0, frames: [] });

export function measureHold(frames, cfg = CONFIG.longNote) {
  const W = watchConfig(cfg);
  const holds = steadyHolds(frames, W);
  if (!holds.length) return noHold();
  const best = holds.reduce((a, b) => (b.durMs > a.durMs ? b : a));
  const spread = (2 * cfg.bandCents) / 100;
  // The hold's own readings. A detector slip inside it (bridged, never part of the stretch)
  // is far from its centre and stays out, so it cannot read as wobble.
  const own = (frames || []).filter((f) => sung(f, cfg) && f.t >= best.t0 && f.t <= best.t1 && Math.abs(f.midi - best.midi) <= spread);
  if (own.length < 2) return noHold();
  const steps = [];
  for (let i = 1; i < own.length; i++) steps.push(own[i].t - own[i - 1].t);
  const dt = median(steps) || 0.02;
  let gaps = 0, gapMs = 0;
  for (const s of steps) if (s > 2.5 * dt) { gaps++; gapMs += (s - dt) * 1000; }
  const sec = best.durMs / 1000;

  let driftCents = null;
  const w = cfg.driftWindowSec;
  if (sec >= 2 * w) {
    const first = median(own.filter((f) => f.t < best.t0 + w).map((f) => f.midi));
    const last = median(own.filter((f) => f.t > best.t1 - w).map((f) => f.midi));
    if (first !== null && last !== null) driftCents = round1(100 * (last - first));
  }
  const note = analyse({ title: 'long note', notes: [{ t: best.t0, dur: sec + dt, midi: best.midi }] }, own).notes[0];
  return {
    ok: true, sec: round2(sec), t0: best.t0, t1: best.t1, midi: best.midi, note: best.note,
    driftCents, wobbleCents: isNum(note.wobble) ? round1(note.wobble) : null,
    gaps, gapMs: Math.round(gapMs), frames: own.map((f) => ({ t: round2(f.t - best.t0), midi: f.midi })),
  };
}

// ---------------------------------------------------------------- words

export function steadiness(hold, cfg = CONFIG.longNote) {
  const d = hold && isNum(hold.driftCents) ? hold.driftCents : null, w = hold && isNum(hold.wobbleCents) ? hold.wobbleCents : null;
  if (d === null && w === null) return { kind: 'short', dir: null, cents: null };
  const drifted = d !== null && Math.abs(d) >= cfg.driftCents, wobbled = w !== null && w >= cfg.wobbleCents;
  // Both: the one further past its own line is the one to say.
  if (drifted && (!wobbled || Math.abs(d) / cfg.driftCents >= w / cfg.wobbleCents)) return { kind: 'drifted', dir: d < 0 ? 'down' : 'up', cents: Math.round(Math.abs(d)) };
  if (wobbled) return { kind: 'wobbled', dir: null, cents: Math.round(w) };
  // Under two windows long there is no first and last second to compare.
  if (d === null) return { kind: 'short', dir: null, cents: null };
  return { kind: 'steady', dir: null, cents: Math.round(Math.abs(d)) };
}

export function breathLevel(sec, cfg = CONFIG.longNote) {
  const [a, b] = cfg.breathSec;
  return !(sec >= a) ? 'short' : sec < b ? 'easy' : 'long';
}

export const secondsWords = (sec) => `${(isNum(sec) ? Math.max(0, sec) : 0).toFixed(1)} seconds`;

export const WORDS = Object.freeze({
  what: 'Sing one comfortable note and hold it for as long as is easy. Any note that feels good will do.',
  safety: 'Stay comfortable. Stop if your throat feels tight or sore.',
  micWhen: 'The microphone turns on when you press Start, and off again when the note ends.',
  waiting: 'Listening. Breathe in low and slow, then one easy ‘ah’.',
  ready: 'Whenever you are ready: one easy ‘ah’ on any comfortable note.',
  holding: 'Keep it easy. Let the note end before the air runs out.',
  nothing: 'No steady note was heard that time, and that is fine. The microphone is off. Press Start when you are ready.',
  paused: 'Paused. The microphone is off. Press Resume to turn it back on.',
  cap: 'That is a long note. Let it go and breathe.',
  // No number in it: the limit is config.longNote.listenSec, and the words must not go stale.
  time: 'The microphone only listens for a while each time, so it is off now. No steady note was heard: a TV or music nearby can cover it. Press Start when you are ready.',
  rest: 'Rest. Breathe normally.',
  setDone: 'That is enough long notes for now. A voice grows with rest, not with pushing.',
  breath: Object.freeze({ short: 'A short breath', easy: 'A comfortable breath', long: 'A long breath' }),
  steady: Object.freeze({ steady: 'Steady', wobbled: 'Wobbled a little', short: 'Too short to tell how steady' }),
  tip: Object.freeze({
    steady: 'Tip: stop while it still feels easy.',
    down: 'Tip: keep the air moving right to the end of the note.',
    up: 'Tip: let the note rest where it is. No need to push as the air runs low.',
    wobbled: 'Tip: a softer, easier ‘ah’ is steadier than a loud one.',
    short: 'Tip: breathe in low and slow, then let the note out gently.',
  }),
});

export function holdWords(hold, cfg = CONFIG.longNote) {
  const s = steadiness(hold, cfg), level = breathLevel(hold ? hold.sec : 0, cfg);
  const steady = s.kind === 'drifted' ? `Drifted ${s.dir} ${s.cents} cents` : WORDS.steady[s.kind];
  const tip = s.kind === 'drifted' ? WORDS.tip[s.dir] : WORDS.tip[s.kind];
  return { seconds: secondsWords(hold ? hold.sec : 0), steady, breath: WORDS.breath[level], tip, kind: s.kind, level };
}

// ---------------------------------------------------------------- the rest rule

export function restPlan(holdsInSet, cfg = CONFIG.longNote) {
  const setDone = holdsInSet >= cfg.holdsPerSet;
  return { restSec: setDone ? cfg.setRestSec : cfg.restSec, setDone };
}

export function createSitting(cfg = CONFIG.longNote) {
  let phase = 'ready', holds = 0, sets = 0, restUntilMs = 0, before = 'ready';
  const state = (nowMs = 0) => {
    const restLeftMs = phase === 'rest' || phase === 'done' ? Math.max(0, restUntilMs - nowMs) : 0;
    // Whole seconds, rounded up: the count reads "1 seconds" until the rest is really over.
    return { phase, holds, sets, restLeftSec: Math.ceil(restLeftMs / 1000), restLeftMs, canStart: phase !== 'sing' && restLeftMs === 0 };
  };
  return {
    state,
    start(nowMs) {
      if (!state(nowMs).canStart) return false;
      // The long rest is over: a new set.
      if (phase === 'done') holds = 0;
      before = phase === 'done' ? 'ready' : phase;
      phase = 'sing';
      return true;
    },
    held(nowMs) {
      if (phase !== 'sing') return state(nowMs);
      holds++;
      const plan = restPlan(holds, cfg);
      phase = plan.setDone ? 'done' : 'rest';
      if (plan.setDone) sets++;
      restUntilMs = nowMs + plan.restSec * 1000;
      return state(nowMs);
    },
    // Nothing was held: the sitting is where it was, and a rest already taken is not asked for again.
    cancel() { if (phase === 'sing') phase = before; },
  };
}

// ---------------------------------------------------------------- the saved bests

export const LONGNOTE_KEY = `${STORAGE_PREFIX}longnote.v1`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const emptyRecord = () => ({ v: 1, best: null, days: [] });

function cleanRecord(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyRecord();
  const seen = new Set();
  const days = (Array.isArray(raw.days) ? raw.days : [])
    .filter((d) => d && typeof d === 'object' && typeof d.day === 'string' && DAY_RE.test(d.day) && isNum(d.sec) && d.sec > 0 && d.sec <= 600)
    .map((d) => ({ day: d.day, sec: round2(d.sec), holds: isNum(d.holds) && d.holds >= 1 ? Math.round(d.holds) : 1 }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .filter((d) => (seen.has(d.day) ? false : seen.add(d.day)))
    .slice(-cfg.keepDays);
  const b = raw.best;
  const best = b && typeof b === 'object' && isNum(b.sec) && b.sec > 0 && b.sec <= 600
    ? { sec: round2(b.sec), at: typeof b.at === 'string' ? b.at : '', day: typeof b.day === 'string' && DAY_RE.test(b.day) ? b.day : '' } : null;
  return { v: 1, best, days };
}

export function readRecord(storage, cfg = CONFIG.longNote) {
  try { return cleanRecord(JSON.parse((storage && storage.getItem(LONGNOTE_KEY)) || 'null'), cfg); } catch { return emptyRecord(); }
}

export function nextRecord(prev, { sec, day, at = '' } = {}, cfg = CONFIG.longNote) {
  const p = cleanRecord(prev, cfg);
  if (!isNum(sec) || !(sec > 0) || typeof day !== 'string' || !DAY_RE.test(day)) {
    return { record: p, firstTime: false, newBest: false, dayBest: false, today: p.days.find((d) => d.day === day) || null };
  }
  const s = round2(sec);
  const old = p.days.find((d) => d.day === day) || null;
  const today = { day, sec: Math.max(s, old ? old.sec : 0), holds: (old ? old.holds : 0) + 1 };
  const days = [...p.days.filter((d) => d.day !== day), today].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-cfg.keepDays);
  const beats = !p.best || s > p.best.sec;
  return {
    record: { v: 1, best: beats ? { sec: s, at, day } : p.best, days },
    // A best of nothing cannot be beaten, only begun (as matchhold.js nextProgress).
    firstTime: !p.best, newBest: !!p.best && beats, dayBest: !old || s > old.sec, today,
  };
}

export function saveHold(storage, { sec, at = new Date().toISOString(), day = null } = {}, cfg = CONFIG.longNote) {
  const out = nextRecord(readRecord(storage, cfg), { sec, at, day: day || dayKey(new Date(at)) }, cfg);
  let saved = false;
  try { if (storage) { storage.setItem(LONGNOTE_KEY, JSON.stringify(out.record)); saved = true; } } catch { /* full or blocked: the result still stands */ }
  return { ...out, saved };
}

export function recentDays(record, today, n = CONFIG.longNote.recentDays) {
  const by = new Map(((record && record.days) || []).map((d) => [d.day, d.sec]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const day = addDays(today, -i); out.push({ day, sec: by.has(day) ? by.get(day) : null }); }
  return out;
}

// 'YYYY-MM-DD' -> "12 Oct" (noon: the local day, whatever the time zone).
const dayLabel = (day) => (DAY_RE.test(day || '') ? dayWords(`${day}T12:00:00`) : '');

export function bestWords(record, today) {
  const t = ((record && record.days) || []).find((d) => d.day === today) || null, b = record && record.best;
  return {
    today: t ? `Best today: ${secondsWords(t.sec)}` : '',
    ever: b ? `Your best: ${secondsWords(b.sec)}${b.day && b.day !== today && dayLabel(b.day) ? ` on ${dayLabel(b.day)}` : ''}` : '',
  };
}

export const dayLabelOf = dayLabel;
