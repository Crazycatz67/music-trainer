// voicecheck.js — the voice check ("Sky portrait"): which notes and tunes are asked, how
// what was sung is scored, the voice-type comparison, every sentence of the result, the
// compare table and the saved record
// (docs/design/specs/2026-10-12-voice-check-and-songs.md sections 4 and 7; numbers in
// config.voiceCheck).
//
// PURE: imports in Node (tools/checks/voicecheck.check.mjs). No browser global is touched;
// storage is always passed in.
//
// Pitch numbers are MIDI notes (60 = C4); cents = 100 x (sung - asked), negative = low.
// Frames are js/pitch.js frames { t (seconds), midi, voiced }. A "note" in the words is one
// piano key, as everywhere in the app.
//
// CONTRACT
//   planNotes(range, cfg?) -> { midis: [10 whole notes], repeated }
//       range: a js/app/range.js entry. The notes sit at cfg.noteFractions of the way from the
//       comfortable low to the comfortable high, in that fixed order, so two portraits ask
//       the same thing. Never the same note twice running unless the comfortable range is one
//       note. repeated: some note is asked more than once (a small range). No usable range:
//       { midis: [], repeated: false }.
//   planTunes(range, easyMidi, cfg?) -> [{ degrees: [4], midis: [4] }]
//       cfg.tunes placed with figures.js placeFigure inside the comfortable range, starting
//       on the easy note when the tune then fits.
//   easyFrom(humMidis, range, cfg?) -> { midi, from: 'hummed' | 'range' } | null
//       The middle value of the hums, rounded to a whole note; with fewer than cfg.hums of
//       them, range.js homeNote(range).
//   humOf(frames, cfg?) -> midi | null      the longest steady stretch of at least cfg.humMs
//   createHeard(ms) -> { push(frame) -> { ms, progress, done }, reset() }
//       How much VOICE has been heard, whatever its pitch: the Sing window's ring. A gap of
//       more than 100 ms between two readings adds nothing. It cannot leak the verdict.
//   scoreNote(targetMidi, frames, cfg?) -> NoteScore
//       { midi, sungMidi | null, cents | null, on, octave: -1 | 0 | 1, steady, lockSec | null }
//       sungMidi: the middle value of the settled part (the readings after the first
//       coach.js onsetWindow of singing). on: within cfg.onTargetCents. octave: within
//       cfg.octaveCents of the note 12 lower (-1) or higher (1); such a note is never `on`.
//       steady: wobble and drift (coach.js analyse) inside cfg.steady*. lockSec: seconds from
//       the first sound to settling on the note, null when it never settled.
//       Fewer than cfg.minFrames voiced readings: sungMidi null, everything false.
//   scoreTune(midis, frames, { t0, noteSec? }, cfg?) -> TuneScore
//       { midis: [4], sung: [4 x (midi | null)], on: [4 x boolean], shape }
//       Note i is judged in [t0 + i x noteSec, + noteSec) with cfg.latencySec allowed for.
//   tuneSteps(midis, sung, cfg?) -> [{ want, got, ok }]   one per step between two notes;
//       want / got: 'up' | 'down' | 'same' | null (a note not heard). shape = every ok.
//   voiceType(range, cfg?) -> { names: [] | [a] | [a, b], overlap }
//       overlap: whole notes shared by the comfortable range and the best type. names is []
//       when the range is under cfg.typeMinNotes; two names when the second is within
//       cfg.typeTieNotes. Equal overlaps: the type whose middle is nearer comes first.
//   buildPortrait({ at, sec, range, easy, notes: [NoteScore (+ skipped?)], tunes: [TuneScore],
//                   repeated? }, cfg?) -> Portrait     the saved shape of spec section 7,
//       plus notes.unheard (asked, not skipped, nothing heard) and notes.repeated.
//   noteWords(score) -> "On target." | "A little low." | "Landed 3 notes low." | ...
//   tuneWords(score, cfg?) -> "3 of 4 on target. Shape right." | "... Shape not quite: ..."
//   dateWords(iso) -> "12 Oct 2026" ('' when unreadable)
//   portraitWords(portrait, { noteStyle? }) -> words     every sentence beside the picture:
//       { title, date, plate, label (the picture's aria-label), range: [3 lines], type,
//         typeInfo, can: [{ id, icon, before, strong, after, text, small }], extra: [lines],
//         honesty, thumb }
//   compareRows(earlier, tonight, { noteStyle? }) -> { rows: [{ id, label, a, b, grew, gain }],
//         anyGrew, rangeChanged, note, rangeNote }
//       grew only where tonight is ahead; gain is '' on every other row (rewards only go up).
//   markClear(rows, cfg?) -> rows + clear: 'gain' | 'loss' | 'same' (cfg.clear lines)
//   gainLook(row) -> 'gold' | 'muted' | ''   gold only for a clear gain (result screen + Progress)
//   lastFacts(checks, now) -> { last: "12 Oct 2026" | '', soon, ladder: "Not taken yet" | "Last: 12 Oct" }
//   rangeFresh(entry, now, cfg?) -> boolean     measured inside cfg.reuseRangeHours
//   VOICECHECK_KEY   'music-trainer.voicecheck.v1' -> { v: 1, checks: [Portrait] }, oldest
//       first, the newest cfg.keep kept. Never frames, never audio.
//   readPortraits(storage) -> { checks, ok }   never throws; ok false: something was saved
//       but could not be read (treated as empty). Entries that are not portraits are dropped.
//   savePortrait(storage, portrait, cfg?) -> { saved, checks }   saved false when the storage
//       refused (full, blocked, none): the portrait still stands for this visit.

import { analyse, DEFAULTS as COACH } from '../coach.js';
import { createTimeline } from '../timeline.js';
import { CONFIG } from './config.js';
import { placeFigure } from './figures.js';
import { dayWords, homeNote, octaveWords, steadyHolds } from './range.js';
import { STORAGE_PREFIX } from './shell.js';
import { displayNote } from './stage.js';

const V = () => CONFIG.voiceCheck;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round1 = (x) => (isNum(x) ? Math.round(x * 10) / 10 : null);
const round2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function comfort(range) {
  if (!range || !isNum(range.lowMidi) || !isNum(range.highMidi) || range.highMidi < range.lowMidi) return null;
  const lo = isNum(range.comfortLow) ? range.comfortLow : range.lowMidi, hi = isNum(range.comfortHigh) ? range.comfortHigh : range.highMidi;
  return hi >= lo ? { lo: Math.round(lo), hi: Math.round(hi) } : { lo: Math.round(range.lowMidi), hi: Math.round(range.highMidi) };
}

// ---------------------------------------------------------------- what is asked

export function planNotes(range, cfg = V()) {
  const c = comfort(range);
  if (!c) return { midis: [], repeated: false };
  const midis = [];
  for (const f of cfg.noteFractions) {
    let midi = Math.round(c.lo + f * (c.hi - c.lo));
    // A small range rounds two fractions onto one note; twice running would sound like the
    // check had stuck.
    if (midis.length && midi === midis[midis.length - 1] && c.hi > c.lo) midi = midi + 1 <= c.hi ? midi + 1 : midi - 1;
    midis.push(midi);
  }
  return { midis, repeated: new Set(midis).size < midis.length };
}

export function planTunes(range, easyMidi, cfg = V()) {
  const c = comfort(range);
  if (!c) return [];
  return cfg.tunes.map((degrees) => {
    const placed = placeFigure({ degrees }, { lowMidi: c.lo, highMidi: c.hi, ...(isNum(easyMidi) ? { prefer: easyMidi } : {}) });
    return { degrees: [...degrees], midis: placed.midis };
  });
}

export function easyFrom(humMidis, range, cfg = V()) {
  const hums = (humMidis || []).filter(isNum);
  if (hums.length >= cfg.hums) return { midi: Math.round(median(hums)), from: 'hummed' };
  const home = homeNote(range);
  return home === null ? null : { midi: home, from: 'range' };
}

export function humOf(frames, cfg = V()) {
  const holds = steadyHolds(frames, { ...CONFIG.range, coverMs: cfg.humMs });
  let best = null;
  for (const hold of holds) if (!best || hold.durMs > best.durMs) best = hold;
  return best ? best.midi : null;
}

export function createHeard(ms) {
  let heardMs = 0, lastT = null;
  const state = () => ({ ms: heardMs, progress: ms > 0 ? Math.min(1, heardMs / ms) : 1, done: heardMs >= ms });
  return {
    push(frame) {
      if (!frame || !isNum(frame.t)) return state();
      const voiced = frame.voiced !== false && isNum(frame.midi);
      // Only the time between two readings that both carry a voice; a hole in the readings
      // (the tab stalled) is not singing.
      if (voiced && lastT !== null && frame.t > lastT && frame.t - lastT <= 0.1) heardMs += (frame.t - lastT) * 1000;
      lastT = voiced ? frame.t : null;
      return state();
    },
    reset() { heardMs = 0; lastT = null; },
  };
}

// ---------------------------------------------------------------- scoring

const voicedOf = (frames) => (frames || []).filter((f) => f && f.voiced !== false && isNum(f.midi) && isNum(f.t));

export function scoreNote(targetMidi, frames, cfg = V()) {
  const none = { midi: targetMidi, sungMidi: null, cents: null, on: false, octave: 0, steady: false, lockSec: null };
  const sung = voicedOf(frames);
  if (sung.length < cfg.minFrames) return none;
  // The settled part, as coach.js defines it; a note too short to have one is judged whole.
  const from = sung[0].t + COACH.onsetWindow;
  const settled = sung.filter((f) => f.t >= from);
  const part = settled.length >= cfg.minFrames ? settled : sung;
  const cents = 100 * (median(part.map((f) => f.midi)) - targetMidi);
  const on = Math.abs(cents) <= cfg.onTargetCents;
  const octave = Math.abs(cents + 1200) <= cfg.octaveCents ? -1 : Math.abs(cents - 1200) <= cfg.octaveCents ? 1 : 0;
  // Wobble, drift and the lock come from the coach, against the note really sung at
  // (an octave away is still one steady note) and against the note asked (settling on it).
  const t0 = frames[0].t, dur = Math.max(0.05, frames[frames.length - 1].t - t0 + 0.05);
  const stats = (midi) => analyse(createTimeline({ title: 'voice check', notes: [{ t: t0, dur, midi }] }), frames).notes[0];
  const own = stats(targetMidi + cents / 100), asked = stats(targetMidi);
  const steady = own.wobble !== null && own.wobble <= cfg.steadyWobbleCents && (own.drift === null || Math.abs(own.drift) <= cfg.steadyDriftCents);
  const lockSec = on && asked.lockTime !== null && asked.onsetDelay !== null ? round2(Math.max(0, asked.lockTime - asked.onsetDelay)) : null;
  return { midi: targetMidi, sungMidi: round2(targetMidi + cents / 100), cents: round1(cents), on, octave, steady, lockSec };
}

const way = (cents, dead) => (cents > dead ? 'up' : cents < -dead ? 'down' : 'same');

export function tuneSteps(midis, sung, cfg = V()) {
  const out = [];
  for (let i = 1; i < midis.length; i++) {
    const want = way(100 * (midis[i] - midis[i - 1]), 0);
    const got = isNum(sung[i]) && isNum(sung[i - 1]) ? way(100 * (sung[i] - sung[i - 1]), cfg.shapeDeadCents) : null;
    out.push({ want, got, ok: got === want });
  }
  return out;
}

export function scoreTune(midis, frames, { t0 = 0, noteSec } = {}, cfg = V()) {
  const dur = noteSec ?? cfg.tuneNoteSec;
  const timeline = createTimeline({ title: 'voice check tune', notes: midis.map((midi, i) => ({ t: t0 + i * dur, dur, midi })) });
  const stats = analyse(timeline, frames || [], { latency: cfg.latencySec, minFrames: cfg.minFrames }).notes;
  const sung = stats.map((n, i) => (n.sung ? round2(midis[i] + n.medianCents / 100) : null));
  const on = sung.map((m, i) => m !== null && Math.abs(100 * (m - midis[i])) <= cfg.onTargetCents);
  return { midis: [...midis], sung, on, shape: tuneSteps(midis, sung, cfg).every((s) => s.ok) };
}

// ---------------------------------------------------------------- the voice-type comparison

export function voiceType(range, cfg = V()) {
  const c = comfort(range);
  if (!c || range.highMidi - range.lowMidi < cfg.typeMinNotes) return { names: [], overlap: 0 };
  const mid = (c.lo + c.hi) / 2;
  const scored = cfg.types.map((t, i) => ({
    name: t.name, i, overlap: Math.max(0, Math.min(c.hi, t.high) - Math.max(c.lo, t.low) + 1), off: Math.abs((t.low + t.high) / 2 - mid),
  })).sort((a, b) => b.overlap - a.overlap || a.off - b.off || a.i - b.i);
  const [best, second] = scored;
  if (!best || best.overlap === 0) return { names: [], overlap: 0 };
  const tie = second && second.overlap > 0 && best.overlap - second.overlap <= cfg.typeTieNotes;
  return { names: tie ? [best.name, second.name] : [best.name], overlap: best.overlap };
}

// ---------------------------------------------------------------- the portrait

export function buildPortrait({ at, sec = 0, range, easy, notes = [], tunes = [], repeated = false, id = null } = {}, cfg = V()) {
  const each = notes.map((n) => ({
    midi: n.midi, sungMidi: n.sungMidi ?? null, cents: n.cents ?? null, on: !!n.on, octave: n.octave === -1 || n.octave === 1 ? n.octave : 0,
    steady: !!n.steady, lockSec: n.lockSec ?? null, ...(n.skipped ? { skipped: true } : {}),
  }));
  const sung = each.filter((n) => n.cents !== null);
  const locks = each.map((n) => n.lockSec).filter(isNum);
  const asked = each.map((n) => n.midi);
  const mid = asked.length ? (Math.min(...asked) + Math.max(...asked)) / 2 : 0;
  const tuneEach = tunes.map((t) => ({ midis: [...t.midis], sung: [...t.sung], on: t.on.map(Boolean), shape: !!t.shape }));
  const r = { lowMidi: range.lowMidi, highMidi: range.highMidi, comfortLow: range.comfortLow, comfortHigh: range.comfortHigh };
  return {
    id: id || `vc-${String(at).replace(/[^0-9]/g, '').slice(0, 14)}`, at, sec: Math.round(sec),
    range: r,
    easy: { midi: easy.midi, from: easy.from === 'hummed' ? 'hummed' : 'range' },
    type: voiceType(range, cfg),
    notes: {
      of: each.length, onTarget: each.filter((n) => n.on).length, octaveAway: each.filter((n) => n.octave !== 0).length,
      skipped: each.filter((n) => n.skipped).length, unheard: each.filter((n) => !n.skipped && n.cents === null).length,
      steady: each.filter((n) => n.steady).length,
      medianAbsCents: sung.length ? Math.round(median(sung.map((n) => Math.abs(n.cents)))) : null,
      medianCents: sung.length ? Math.round(median(sung.map((n) => n.cents))) : null,
      lockSec: locks.length >= cfg.minLockNotes ? round1(median(locks)) : null,
      lowHalfOn: each.filter((n) => n.on && n.midi < mid).length, highHalfOn: each.filter((n) => n.on && n.midi > mid).length,
      repeated: !!repeated, each,
    },
    tunes: {
      of: tuneEach.length, noteOf: tuneEach.reduce((s, t) => s + t.midis.length, 0),
      notesOnTarget: tuneEach.reduce((s, t) => s + t.on.filter(Boolean).length, 0), shapesRight: tuneEach.filter((t) => t.shape).length,
      each: tuneEach,
    },
  };
}

// ---------------------------------------------------------------- words (spec 4.4, 4.5, 4.7; exact)

export function noteWords(score) {
  if (!score || score.cents === null) return 'No note heard.';
  if (score.octave) return `Right note, one octave ${score.octave < 0 ? 'lower' : 'higher'}.`;
  const side = score.cents < 0 ? 'low' : 'high';
  if (score.on) return Math.abs(score.cents) < V().littleCents ? 'On target.' : `A little ${side}.`;
  return `Landed ${plural(Math.max(1, Math.round(Math.abs(score.cents) / 100)), 'note')} ${side}.`;
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];
const WENT = { up: 'went up', down: 'went down', same: 'stayed the same' };
const INSTEAD = { up: 'up', down: 'down', same: 'staying the same' };

export function tuneWords(score, cfg = V()) {
  const head = `${score.on.filter(Boolean).length} of ${score.midis.length} on target.`;
  if (score.shape) return `${head} Shape right.`;
  const steps = tuneSteps(score.midis, score.sung, cfg);
  const i = steps.findIndex((s) => !s.ok), s = steps[i];
  if (s.got === null) {
    const missing = score.sung[i] === null || score.sung[i] === undefined ? i : i + 1;
    return `${head} Shape not quite: the ${ORDINAL[missing]} note was not heard.`;
  }
  return `${head} Shape not quite: the ${ORDINAL[i + 1]} note ${WENT[s.got]} instead of ${INSTEAD[s.want]}.`;
}

export function dateWords(iso) {
  const day = dayWords(iso);
  return day ? `${day} ${new Date(iso).getFullYear()}` : '';
}

const TYPE_TAIL = 'This usually changes with practice.';
export const TYPE_INFO = 'Voice types such as baritone or alto are named for trained voices. Range is the least reliable way to tell them apart, and a beginner’s range grows. So this is only a comparison, not a label.';
// The spec's own sentence (4.7). The coach card's says "The coach reads..."; this is not the coach.
export const HONESTY = 'This reads pitch only. It cannot hear tone, breath or volume.';
export const ON_TARGET_GLOSS = 'On target means closer to the right note than to the one next to it.';
export const DAY_NOTE = 'Voices move from day to day. A cold, the time of day or a short warm-up all shift these numbers.';

function typeLine(type) {
  const names = (type && type.names) || [];
  if (!names.length) return 'Too narrow today to compare with voice types. That is normal at the start.';
  if (names.length > 1) return `That overlaps about equally with ${names[0]} and ${names[1]}. ${TYPE_TAIL}`;
  return `That overlaps most with ${names[0]}. ${TYPE_TAIL}`;
}

const seconds = (s) => `${s.toFixed(1)} ${s === 1 ? 'second' : 'seconds'}`;

export function portraitWords(p, { noteStyle = 'letters' } = {}) {
  const name = (m) => displayNote(m, noteStyle).text;
  const span = p.range.highMidi - p.range.lowMidi;
  const date = dateWords(p.at);
  const N = p.notes, T = p.tunes;
  const can = [];
  const add = (id, icon, before, strong, after, small) => can.push({ id, icon, before, strong, after, text: `${before}${strong}${after}`, small });
  add('on', 'star', '', `${N.onTarget} of ${N.of}`, ' notes on target', ON_TARGET_GLOSS);
  if (N.medianAbsCents !== null) {
    const lean = N.medianCents < -V().leanCents ? ' Mostly a little low.' : N.medianCents > V().leanCents ? ' Mostly a little high.' : '';
    add('away', 'arrows', 'Usually ', plural(N.medianAbsCents, 'cent'), ' away', `100 cents is one step to the next note.${lean}`);
  }
  add('steady', 'level', '', `${N.steady} of ${N.of}`, ' notes held steady', 'Steady means the note did not wobble or slide.');
  if (N.lockSec !== null) add('lock', 'clock', 'About ', seconds(N.lockSec), ' to find a note', 'From your first sound to settling on the note.');
  else add('lock', 'clock', '', '', 'Not enough settled notes to time yet.', '');
  add('tunes', 'figure', '', `${T.notesOnTarget} of ${T.noteOf}`, ' tune notes on target', `${T.shapesRight} of ${T.of} tunes kept their shape (up and down in the right places).`);

  const extra = [];
  for (const [dir, word] of [[-1, 'lower'], [1, 'higher']]) {
    const n = N.each.filter((e) => e.octave === dir).length;
    if (n) extra.push(`${plural(n, 'note')} ${n === 1 ? 'was' : 'were'} the right note, one octave ${word}.`);
  }
  if (N.skipped) extra.push(`${plural(N.skipped, 'note')} ${N.skipped === 1 ? 'was' : 'were'} skipped.`);
  if (N.unheard) extra.push(`${plural(N.unheard, 'note')} ${N.unheard === 1 ? 'was' : 'were'} not heard.`);
  if (span >= V().strongestMinNotes && Math.abs(N.lowHalfOn - N.highHalfOn) >= V().strongestDiff) {
    extra.push(N.lowHalfOn > N.highHalfOn ? 'Strongest today: your lower notes. The top notes were the hardest.' : 'Strongest today: your higher notes. The low notes were the hardest.');
  }
  if (N.repeated) extra.push('Your range is small today, so some notes were asked twice.');

  const easy = `Your voice sits most easily around ${name(p.easy.midi)}${p.easy.from === 'hummed' ? '' : ', worked out from your range'}.`;
  const counts = `${can[0].text}, ${can[can.length - 1].text}.`;
  return {
    title: 'Your voice today', date, plate: `Sky portrait · ${date}`,
    range: [
      `Your comfortable range today: ${name(p.range.lowMidi)} to ${name(p.range.highMidi)}.`,
      `${plural(span, 'note')}, ${octaveWords(span)}.`,
      easy,
    ],
    type: typeLine(p.type), typeInfo: TYPE_INFO,
    can, extra, honesty: HONESTY,
    thumb: can[0].text,
    label: `Sky portrait, ${date}. Range ${name(p.range.lowMidi)} to ${name(p.range.highMidi)}. Home star ${name(p.easy.midi)}. ${counts}`,
  };
}

// ---------------------------------------------------------------- compare (spec 4.8)

export function compareRows(a, b, { noteStyle = 'letters' } = {}) {
  const name = (m) => displayNote(m, noteStyle).text;
  const rows = [];
  // more: how much tonight is ahead (<= 0 or null: not ahead). gain: the words for it.
  const row = (id, label, av, bv, more = null, gain = () => '') => {
    const grew = isNum(more) && more > 0;
    // more rides along so sinceFirst can tell a clear change from a normal day's wobble.
    rows.push({ id, label, a: av, b: bv, grew, gain: grew ? gain(more) : '', more: isNum(more) ? more : null });
  };
  const spanOf = (p) => p.range.highMidi - p.range.lowMidi;
  const rangeText = (p) => `${name(p.range.lowMidi)} to ${name(p.range.highMidi)} (${plural(spanOf(p), 'note')})`;
  const count = (n, of) => `${n} of ${of}`;
  const cents = (p) => (p.notes.medianAbsCents === null ? 'not sung' : plural(p.notes.medianAbsCents, 'cent'));
  const lock = (p) => (p.notes.lockSec === null ? 'not timed' : seconds(p.notes.lockSec));
  const both = (x, y) => (isNum(x) && isNum(y) ? y - x : null);
  const moreOf = (n) => `${n} more`;
  row('range', 'Range', rangeText(a), rangeText(b), spanOf(b) - spanOf(a), (n) => `${plural(n, 'note')} wider`);
  row('easy', 'Easy note', name(a.easy.midi), name(b.easy.midi));
  row('on', 'Notes on target', count(a.notes.onTarget, a.notes.of), count(b.notes.onTarget, b.notes.of), b.notes.onTarget - a.notes.onTarget, moreOf);
  row('away', 'Usually away by', cents(a), cents(b), both(b.notes.medianAbsCents, a.notes.medianAbsCents), (n) => `${plural(n, 'cent')} closer`);
  row('steady', 'Held steady', count(a.notes.steady, a.notes.of), count(b.notes.steady, b.notes.of), b.notes.steady - a.notes.steady, moreOf);
  const quicker = both(b.notes.lockSec, a.notes.lockSec);
  row('lock', 'Time to find a note', lock(a), lock(b), quicker === null ? null : round1(quicker), (n) => `${seconds(n)} quicker`);
  row('tunes', 'Tune notes on target', count(a.tunes.notesOnTarget, a.tunes.noteOf), count(b.tunes.notesOnTarget, b.tunes.noteOf), b.tunes.notesOnTarget - a.tunes.notesOnTarget, moreOf);
  row('shapes', 'Tunes with the right shape', count(a.tunes.shapesRight, a.tunes.of), count(b.tunes.shapesRight, b.tunes.of), b.tunes.shapesRight - a.tunes.shapesRight, moreOf);
  const same = (k) => a.range[k] === b.range[k];
  const rangeChanged = !(same('comfortLow') && same('comfortHigh'));
  return {
    rows, anyGrew: rows.some((r) => r.grew), rangeChanged, note: DAY_NOTE,
    rangeNote: rangeChanged ? 'The ten notes moved with your range, so the two nights sang slightly different notes.' : '',
    heads: [dateWords(a.at), dateWords(b.at)],
  };
}

// ---------------------------------------------------------------- since your first (2026-10-15 spec 4.2)

// Lower-case names for the headline; 'away' reads as what it means, not as its row label.
const CLEAR_NAMES = { range: 'range', on: 'notes on target', away: 'how close you sing', steady: 'holding notes steady', lock: 'finding a note', tunes: 'tune notes on target', shapes: 'tune shapes' };
const ways = (n) => `${n} ${n === 1 ? 'way' : 'ways'}`;

// markClear(rows, cfg) -> compareRows rows, each with clear: 'gain' | 'loss' | 'same'
//   against cfg.clear (a row with no line, like the easy note, is always 'same').
// gainLook(row) -> 'gold' | 'muted' | ''   how a view shows the row's gain words:
//   gold (star) only for a clear gain; a smaller gain is muted "(within a normal day)";
//   the same or behind shows nothing. One rule for the result screen and Progress, so a
//   +1 never earns a star tonight and then reads as "a normal day" on Progress.
export function markClear(rows, cfg = V()) {
  const line = (cfg && cfg.clear) || {};
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const at = line[r.id];
    const clear = !isNum(at) || !isNum(r.more) ? 'same' : r.more >= at - 1e-9 ? 'gain' : r.more <= -at + 1e-9 ? 'loss' : 'same';
    return { ...r, clear };
  });
}
export const gainLook = (r) => (r && r.clear === 'gain' ? 'gold' : r && r.grew && r.gain ? 'muted' : '');
export const NORMAL_DAY = '(within a normal day)';

// sinceFirst(checks, pickId?, cfg) -> { first, other, rows, headline, trail, rangeNote, note }
//   checks: oldest first as readPortraits gives them (checks[0] is the pinned first).
//   other: the portrait with id pickId among the later ones, else the newest; null under 2.
//   rows: compareRows rows plus clear: 'gain' | 'loss' | 'same' against cfg.clear; a gain
//     below the line keeps its words but is 'same' (the view words it muted, no star).
//   trail: notes on target per portrait, oldest to newest, as a plain sentence.
// Pure; never throws on an empty or short list.
export function sinceFirst(checks, pickId = null, cfg = V(), { noteStyle = 'letters' } = {}) {
  const list = Array.isArray(checks) ? checks.filter(Boolean) : [];
  const first = list[0] || null;
  const later = list.slice(1);
  const other = later.find((c) => c.id === pickId) || later.at(-1) || null;
  const of = first ? first.notes.of : 0;
  const trail = list.length > 1 ? `Your portraits: ${list.map((c) => c.notes.onTarget).join(' · ')} of ${of} notes on target (oldest to newest)` : '';
  if (!first || !other) return { first, other: null, rows: [], headline: '', trail, rangeNote: '', note: DAY_NOTE };
  const c = compareRows(first, other, { noteStyle });
  const rows = markClear(c.rows, cfg);
  const gains = rows.filter((r) => r.clear === 'gain'), losses = rows.filter((r) => r.clear === 'loss');
  const names = gains.slice(0, 2).map((r) => CLEAR_NAMES[r.id]);
  let headline;
  if (gains.length && losses.length) headline = `Better in ${ways(gains.length)}, lower in ${losses.length}. Voices move from day to day.`;
  else if (gains.length === 1) headline = `Clearly better at ${names[0]}.`;
  else if (gains.length) headline = `Clearly better in ${ways(gains.length)}: ${names.join(' and ')}.`;
  else if (losses.length) headline = `Lower than your first in ${ways(losses.length)} tonight. A tired or cold voice does that; try again another day.`;
  else headline = 'About the same as your first. Changes this small are normal from day to day.';
  return { first, other, rows, headline, trail, rangeNote: c.rangeNote, note: c.note, heads: c.heads };
}

// The first portrait is the starting point of "Since your first", so it is never the one
// dropped: the oldest by date stays (a backup merge may hand them over in any order), then
// the newest keep - 1 of the rest in their saved order.
export function keepWithFirst(checks, keep) {
  if (!Array.isArray(checks) || checks.length <= 1) return Array.isArray(checks) ? checks.slice() : [];
  let i0 = 0;
  checks.forEach((c, i) => { if (c.at < checks[i0].at) i0 = i; });
  const rest = checks.filter((_, i) => i !== i0);
  return [checks[i0], ...(keep > 1 ? rest.slice(-(keep - 1)) : [])];
}

export function lastFacts(checks, now = new Date()) {
  const last = checks && checks.length ? checks[checks.length - 1] : null;
  if (!last) return { last: '', soon: false, ladder: 'Not taken yet' };
  const ageMs = now.getTime() - new Date(last.at).getTime();
  return { last: dateWords(last.at), soon: ageMs >= 0 && ageMs < V().soonDays * 864e5, ladder: `Last: ${dayWords(last.at)}` };
}

export function rangeFresh(entry, now = new Date(), cfg = V()) {
  if (!entry || typeof entry.at !== 'string') return false;
  const ageMs = now.getTime() - new Date(entry.at).getTime();
  return ageMs >= 0 && ageMs < cfg.reuseRangeHours * 3600e3;
}

// ---------------------------------------------------------------- saved

export const VOICECHECK_KEY = `${STORAGE_PREFIX}voicecheck.v1`;

const note = (v) => (isNum(v) && v >= 21 && v <= 108 ? v : null);
const count = (v) => (isNum(v) && v >= 0 ? Math.round(v) : 0);
const numOrNull = (v) => (isNum(v) ? v : null);

// Field by field, so nothing that is not a portrait's own fact (frames above all) can ride
// into storage on an object that was handed in.
function cleanPortrait(p) {
  if (!p || typeof p !== 'object' || typeof p.at !== 'string' || !dayWords(p.at)) return null;
  const r = p.range || {}, lo = note(r.lowMidi), hi = note(r.highMidi);
  if (lo === null || hi === null || hi < lo || !p.easy || note(p.easy.midi) === null || !p.notes || !p.tunes) return null;
  const N = p.notes, T = p.tunes;
  const each = (Array.isArray(N.each) ? N.each : []).slice(0, 20).filter((e) => e && note(e.midi) !== null).map((e) => ({
    midi: e.midi, sungMidi: numOrNull(e.sungMidi), cents: numOrNull(e.cents), on: e.on === true,
    octave: e.octave === -1 || e.octave === 1 ? e.octave : 0, steady: e.steady === true, lockSec: numOrNull(e.lockSec),
    ...(e.skipped === true ? { skipped: true } : {}),
  }));
  const tunes = (Array.isArray(T.each) ? T.each : []).slice(0, 12).filter((t) => t && Array.isArray(t.midis) && Array.isArray(t.sung) && Array.isArray(t.on)).map((t) => ({
    midis: t.midis.slice(0, 8).map((m) => note(m) ?? 60), sung: t.sung.slice(0, 8).map(numOrNull), on: t.on.slice(0, 8).map((x) => x === true), shape: t.shape === true,
  }));
  const names = (p.type && Array.isArray(p.type.names) ? p.type.names : []).filter((n) => typeof n === 'string' && n.length < 24).slice(0, 2);
  return {
    id: typeof p.id === 'string' && p.id.length <= 40 ? p.id : `vc-${p.at.replace(/[^0-9]/g, '').slice(0, 14)}`, at: p.at, sec: count(p.sec),
    range: { lowMidi: lo, highMidi: hi, comfortLow: note(r.comfortLow) ?? lo, comfortHigh: note(r.comfortHigh) ?? hi },
    easy: { midi: p.easy.midi, from: p.easy.from === 'hummed' ? 'hummed' : 'range' },
    type: { names, overlap: count(p.type && p.type.overlap) },
    notes: {
      of: count(N.of), onTarget: count(N.onTarget), octaveAway: count(N.octaveAway), skipped: count(N.skipped), unheard: count(N.unheard),
      steady: count(N.steady), medianAbsCents: numOrNull(N.medianAbsCents), medianCents: numOrNull(N.medianCents), lockSec: numOrNull(N.lockSec),
      lowHalfOn: count(N.lowHalfOn), highHalfOn: count(N.highHalfOn), repeated: N.repeated === true, each,
    },
    tunes: { of: count(T.of), noteOf: count(T.noteOf), notesOnTarget: count(T.notesOnTarget), shapesRight: count(T.shapesRight), each: tunes },
  };
}

export function readPortraits(storage) {
  let text = null;
  try { text = storage ? storage.getItem(VOICECHECK_KEY) : null; } catch { return { checks: [], ok: false }; }
  if (text === null || text === undefined) return { checks: [], ok: true };
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.checks)) return { checks: [], ok: false };
    return { checks: keepWithFirst(raw.checks.map(cleanPortrait).filter(Boolean), V().keep), ok: true };
  } catch { return { checks: [], ok: false }; }
}

export function savePortrait(storage, portrait, cfg = V()) {
  const clean = cleanPortrait(portrait);
  if (!clean) throw new RangeError('savePortrait: not a portrait');
  const checks = keepWithFirst([...readPortraits(storage).checks.filter((c) => c.id !== clean.id), clean], cfg.keep);
  let saved = false;
  try { if (storage) { storage.setItem(VOICECHECK_KEY, JSON.stringify({ v: 1, checks })); saved = true; } } catch { /* full or blocked: it still stands for this visit */ }
  return { saved, checks, portrait: clean };
}
