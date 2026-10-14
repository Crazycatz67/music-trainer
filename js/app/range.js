// range.js — the singer's range: how it is measured from pitch frames, how it is said in
// words, how it is saved, and what other screens ask of it
// (docs/design/specs/2026-10-12-singing-trainer.md section 7.2; thresholds in config.range).
//
// PURE: imports in Node (tools/checks/range.check.mjs). No browser global is touched;
// storage is always passed in.
//
// Pitch numbers are MIDI notes (60 = C4); a "note" here is a whole MIDI number. Frames are
// js/pitch.js frames { t (seconds), midi, voiced }.
//
// HOW A RANGE IS MEASURED. One end at a time (the frames of "slide down and hold", then the
// frames of "slide up and hold"):
//   1. A HOLD is a stretch of voice whose lowest and highest readings are no more than
//      2 x steadyCents apart. A dropout under gapMs does not end it; neither do readings off
//      the note that are over inside glitchMs (an octave slip of the detector, a squeak).
//   2. A note is REACHED when it carries touchMs of continuous voice. Inside one breath (no
//      silence of gapMs) the voice must hang together: it slides, and only the detector
//      jumps. Of the parts of a breath that a jump separates by more than bridgeSemis silent
//      notes, the one sung first counts, unless another carries slipFactor times its sound.
//      A hold in the others was never slid to (an octave slip that lasted, vocal fry, a
//      squeal) and is ignored. Notes sung one by one, with a breath between, all count
//      (bugs.md 41, 42).
//   3. The END is the lowest (highest) hold of at least pinMs. The EXTREME is the lowest
//      (highest) note reached at all, held or not.
//   4. A held START is not an end (bugs.md 44). When, AFTER a hold, the voice goes
//      passedSemis or more beyond it (touchMs of sound there), that hold was where the slide
//      began: it is not pinned, and with no later hold of pinMs the reason is 'moved-on'
//      ("hold a little longer"). What was touched BEFORE a hold does not count against it:
//      going past an easy note and coming back to hold it is how an end is found.
//   5. BACKGROUND is not voice. Frames may carry `level` (loudness, RMS). A reading quieter
//      than humRatio times the loudest hold of the step is a room hum that reads as a note
//      while nobody sings (bugs.md 41): it is treated as silence. Frames with no level, or a
//      step with no hold to compare with, are judged as before.
// The COMFORTABLE range is the measured one less comfortTrimSemis at each end.
//
// CONTRACT
//   createHoldWatch(cfg?) -> { push(frame) -> { midi, heldMs, t0, t1 }, reset() }
//       The steady stretch that ends at the newest frame: midi = its mean pitch (null when
//       there is none), heldMs = its length. A slide keeps it short; settling lets it grow.
//       A frame with a non-finite t is ignored.
//   steadyHolds(frames, cfg?) -> [{ t0, t1, durMs, midi, note }]   every hold of at least
//       coverMs, in time order. note = Math.round(midi).
//   reachedNotes(frames, cfg?) -> { low, high, ms: Map(note -> ms), groups: [{ low, high, total }] } | null
//       the reached notes that count (rule 2); groups: one per breath, the notes its voice
//       passed through
//   endFrom(frames, which, cfg?) -> { ok, reason, note, heldMs, extreme, covered, holds, ignored }
//       which 'low' | 'high'. ok false -> reason 'no-steady', note null.
//       covered { low, high } | null: notes held for coverMs (the ladder's bar).
//       ignored: holds outside the reached group.
//       reason 'moved-on': a hold was long enough but the voice went on past it (rule 4).
//       floor: the loudness under which a reading was background (0: none); backgroundMs:
//       how much of the step that was. Both are there to calibrate humRatio on a real room.
//   levelFloor(frames, cfg?) -> number   rule 5's loudness limit for these frames (0: none)
//   measureRange({ low, high }, cfg?) -> range
//       low, high: endFrom results, or plain notes. range = { ok, reason, lowMidi, highMidi,
//       notes, comfortLow, comfortHigh, extremeLow, extremeHigh, small }
//       reason: null | 'no-low' | 'no-high' | 'inverted' (highest under lowest). notes is the
//       distance in notes, as everywhere in the app ("2 notes low"): A2 to E4 is 19, the
//       spec's own example. small: fewer than smallNotes.
//   homeNote(range, cfg?) -> note | null   where exercises start: homeUpSemis above the
//       comfortable bottom, a quarter of the way up in a small range.
//   exerciseRange(saved, cfg?) -> { lowMidi, highMidi, home } | {}
//       What an exercise is given: the comfortable ends and the home note ({} when nothing
//       is saved, so the exercise falls back to its own defaults).
//   figureRange(saved, cfg?) -> { lowMidi, highMidi, prefer } | {}
//       The same for figures.js placeFigure, where `home` already means "keep this placing":
//       the home note goes in as `prefer`.
//   fitTimeline(timeline, { lowMidi, highMidi }, { octavesOnly? }) -> fit
//       fit = { fits, shift, fitsAfter, overLow, overHigh, low, high, span, reason }
//       fits: every pitched note is inside the range as written. shift: semitones to move
//       the whole timeline (+ up) so that it fits, 0 when it already does; the smallest move
//       that works, or for a timeline wider than the range the move that centres it.
//       octavesOnly: shift is a multiple of 12 (a song that cannot change key).
//       overLow / overHigh: notes still outside each end AFTER the shift.
//       reason: null | 'no-range' (fits null, shift 0) | 'no-notes' (fits true, shift 0).
//   octaveWords(notes) -> "about one and a half octaves" (notes: the distance, 12 to an octave)
//   dayWords(iso) -> "12 Oct" (local time; '' when unreadable)
//   rangeWords(range, { noteStyle? }) -> { line, comfort, small, low, high, comfortLow, comfortHigh }
//       line: "Your range today: A2 to E4, 19 notes, about one and a half octaves"
//       comfort: "Exercises will stay between B2 and D4."   small: the small-sample sentence or ''
//   rangeGrowth(prev, now) -> { wider, since, words }   words '' unless it grew:
//       "2 notes wider than on 28 Sep"
//   RANGE_KEY   'music-trainer.range.v1' -> { current: entry, history: [entry] }
//       entry = { at (ISO), lowMidi, highMidi, comfortLow, comfortHigh, extremeLow, extremeHigh }
//   toEntry(range, nowIso) -> entry
//   nextRangeRecord(prev, entry, cfg?) -> record   history oldest first, capped at historyMax
//   readRangeRecord(storage) -> record | null     readRange(storage) -> entry | null
//       Unreadable, missing or nonsense (an end outside savedMinMidi..savedMaxMidi, high
//       under low): null.
//   saveRange(storage, range, nowIso?) -> { record, growth, saved }   saved false when the
//       storage refused (full, blocked): the range still stands for this visit.

import { CONFIG } from './config.js';
import { STORAGE_PREFIX } from './shell.js';
import { displayNote } from './stage.js';

const isNote = (v) => typeof v === 'number' && Number.isFinite(v);

function sung(frame, cfg) {
  return !!frame && frame.voiced !== false && isNote(frame.midi) && isNote(frame.t) && frame.midi >= cfg.minMidi && frame.midi <= cfg.maxMidi;
}

// ---------------------------------------------------------------- holds

export function createHoldWatch(cfg = CONFIG.range) {
  const spread = (2 * cfg.steadyCents) / 100;
  // run: the stretch itself, with its lowest, highest and summed pitch kept as it grows (a
  // long hold must not be re-read on every frame). odd: the newest readings that do not fit
  // it; they are a glitch until they have lasted glitchMs.
  let run = [], lo = 0, hi = 0, sum = 0, odd = [];
  // The stretch starts again from the readings in `list`: its longest ending that fits.
  const restart = (list) => {
    let l = Infinity, h = -Infinity, total = 0, i = list.length;
    while (i > 0) {
      const m = list[i - 1].midi, nl = Math.min(l, m), nh = Math.max(h, m);
      if (nh - nl > spread) break;
      l = nl; h = nh; total += m; i--;
    }
    run = list.slice(i); lo = l; hi = h; sum = total; odd = [];
  };
  const state = () => {
    if (!run.length) return { midi: null, heldMs: 0, t0: null, t1: null };
    const t0 = run[0].t, t1 = run[run.length - 1].t;
    // The mean, not the middle of lowest and highest: the last of the slide into the note is
    // part of the stretch and would pull a middle half a note off.
    return { midi: sum / run.length, heldMs: (t1 - t0) * 1000, t0, t1 };
  };
  return {
    push(frame) {
      if (!frame || !isNote(frame.t)) return state();
      const t = frame.t;
      // Silence, or readings that went missing, or readings that have not fitted for longer
      // than a dropout may last: the hold is over. What did not fit may start the next one.
      if (run.length && ((t - run[run.length - 1].t) * 1000 > cfg.gapMs || t < run[run.length - 1].t)) {
        restart(odd);
        if (run.length && (t - run[run.length - 1].t) * 1000 > cfg.gapMs) restart([]);
      }
      if (!sung(frame, cfg)) return state();
      const p = { t, midi: frame.midi };
      if (!run.length) { restart([p]); return state(); }
      if (Math.max(hi, p.midi) - Math.min(lo, p.midi) <= spread) {
        run.push(p);
        if (p.midi < lo) lo = p.midi;
        if (p.midi > hi) hi = p.midi;
        sum += p.midi;
        odd = [];
        return state();
      }
      // Off the note: an octave slip or a squeak if it is over inside glitchMs (the stretch
      // carries on as if it had been a dropout); the voice moving on if it lasts.
      odd.push(p);
      if ((t - odd[0].t) * 1000 >= cfg.glitchMs) restart(odd);
      return state();
    },
    reset() { restart([]); },
  };
}

export function steadyHolds(frames, cfg = CONFIG.range) {
  const watch = createHoldWatch(cfg), holds = [];
  let cur = null;
  const emit = () => {
    if (cur && cur.durMs >= cfg.coverMs) holds.push({ ...cur, note: Math.round(cur.midi) });
    cur = null;
  };
  for (const f of frames || []) {
    const s = watch.push(f);
    // The same stretch while its start has not moved: keep it at its longest.
    if (cur && s.t0 === cur.t0) { if (s.heldMs >= cur.durMs) cur = { t0: s.t0, t1: s.t1, durMs: s.heldMs, midi: s.midi }; continue; }
    emit();
    if (s.midi !== null) cur = { t0: s.t0, t1: s.t1, durMs: s.heldMs, midi: s.midi };
  }
  emit();
  return holds;
}

export function reachedNotes(frames, cfg = CONFIG.range) {
  // PIECES of continuous voice: no reading missing for gapMs, no jump of more than
  // glitchSemis between two readings. A voice slides; only the detector jumps. A piece
  // shorter than glitchMs is a glitch and adds nothing. BREATHS (pieces parted by silence)
  // each stand alone; inside one breath the pieces are parted by jumps only.
  const breaths = [];
  let piece = [], breath = [];
  const flush = (silence) => {
    if (piece.length > 1 && (piece[piece.length - 1].t - piece[0].t) * 1000 >= cfg.glitchMs) {
      const ms = new Map();
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < piece.length; i++) {
        const n = Math.round(piece[i].midi);
        if (n < lo) lo = n;
        if (n > hi) hi = n;
        if (i + 1 < piece.length) ms.set(n, (ms.get(n) || 0) + (piece[i + 1].t - piece[i].t) * 1000);
      }
      breath.push({ lo, hi, ms, total: (piece[piece.length - 1].t - piece[0].t) * 1000 });
    }
    piece = [];
    if (silence && breath.length) { breaths.push(breath); breath = []; }
  };
  for (const f of frames || []) {
    if (!sung(f, cfg)) continue;
    const last = piece[piece.length - 1];
    if (last) {
      if ((f.t - last.t) * 1000 > cfg.gapMs || f.t < last.t) flush(true);
      else if (Math.abs(f.midi - last.midi) > cfg.glitchSemis) flush(false);
    }
    piece.push(f);
  }
  flush(true);
  // In one breath, pieces more than bridgeSemis silent notes apart cannot both be the voice.
  // The one sung first stands, unless another carries slipFactor times its sound (the first
  // was then the slip: a note that starts on a wrong octave). The rest were never slid to.
  const groups = [];
  for (const pieces of breaths) {
    const clusters = [];
    for (const pc of pieces) {
      const near = clusters.filter((c) => pc.lo - c.hi <= cfg.bridgeSemis + 1 && c.lo - pc.hi <= cfg.bridgeSemis + 1);
      const into = near[0] || { lo: pc.lo, hi: pc.hi, total: 0, pieces: [] };
      if (!near.length) clusters.push(into);
      for (const c of [pc, ...near.slice(1)]) {
        into.lo = Math.min(into.lo, c.lo); into.hi = Math.max(into.hi, c.hi); into.total += c.total;
        into.pieces.push(...(c.pieces || [c]));
      }
      for (const c of near.slice(1)) clusters.splice(clusters.indexOf(c), 1);
    }
    let pick = clusters[0];
    for (const c of clusters) if (c !== pick && c.total >= cfg.slipFactor * clusters[0].total && c.total > pick.total) pick = c;
    groups.push(pick);
  }
  // A note is reached with touchMs of sound on it, in the pieces that count.
  const ms = new Map();
  for (const g of groups) for (const pc of g.pieces) for (const [n, v] of pc.ms) ms.set(n, (ms.get(n) || 0) + v);
  const notes = [...ms.keys()].filter((n) => ms.get(n) >= cfg.touchMs);
  if (!notes.length) return null;
  return { low: Math.min(...notes), high: Math.max(...notes), ms, groups: groups.map((g) => ({ low: g.lo, high: g.hi, total: g.total })) };
}

const meanLevel = (frames, t0, t1) => {
  let sum = 0, n = 0;
  for (const f of frames) if (f && f.t >= t0 && f.t <= t1 && isNote(f.level)) { sum += f.level; n++; }
  return n ? sum / n : null;
};

export function levelFloor(frames, cfg = CONFIG.range) {
  if (!(cfg.humRatio > 0) || !(frames || []).some((f) => f && isNote(f.level))) return 0;
  // Against the loudest HOLD, not the loudest reading: a cough or a knock on the desk is
  // loud and short, and must not turn a quiet singer into background.
  let ref = 0;
  for (const hd of steadyHolds(frames, cfg)) { const lv = meanLevel(frames, hd.t0, hd.t1); if (lv !== null && lv > ref) ref = lv; }
  return cfg.humRatio * ref;
}

export function endFrom(allFrames, which, cfg = CONFIG.range) {
  const floor = levelFloor(allFrames, cfg);
  let backgroundMs = 0, frames = allFrames || [];
  if (floor > 0) {
    frames = frames.map((f, i) => {
      if (!sung(f, cfg) || !isNote(f.level) || f.level >= floor) return f;
      const nx = allFrames[i + 1];
      if (nx && isNote(nx.t)) backgroundMs += Math.min(cfg.gapMs, Math.max(0, (nx.t - f.t) * 1000));
      return { ...f, voiced: false };
    });
  }
  const reached = reachedNotes(frames, cfg);
  const all = steadyHolds(frames, cfg);
  // A hold's middle can round to the neighbour of the note its readings rounded to.
  const inside = (hd) => !!reached && reached.groups.some((g) => hd.note >= g.low - 1 && hd.note <= g.high + 1);
  const holds = all.filter(inside), ignored = all.filter((hd) => !inside(hd));
  const covered = holds.length ? { low: Math.min(...holds.map((hd) => hd.note)), high: Math.max(...holds.map((hd) => hd.note)) } : null;
  const low = which === 'low';
  // Rule 4: sound on counted notes passedSemis or more beyond the hold, after it ended.
  const counted = (n) => !!reached && (reached.ms.get(n) || 0) >= cfg.touchMs && reached.groups.some((g) => n >= g.low && n <= g.high);
  const movedOn = (hd) => {
    let ms = 0;
    for (let i = 0; i + 1 < frames.length; i++) {
      const f = frames[i];
      if (!sung(f, cfg) || !(f.t > hd.t1)) continue;
      const n = Math.round(f.midi);
      if ((low ? n <= hd.note - cfg.passedSemis : n >= hd.note + cfg.passedSemis) && counted(n)) ms += Math.min(cfg.gapMs, Math.max(0, (frames[i + 1].t - f.t) * 1000));
      if (ms >= cfg.touchMs) return true;
    }
    return false;
  };
  const long = holds.filter((hd) => hd.durMs >= cfg.pinMs);
  const pins = cfg.passedSemis > 0 ? long.filter((hd) => !movedOn(hd)) : long;
  const extra = { covered, holds, ignored, floor, backgroundMs: Math.round(backgroundMs) };
  if (!pins.length) return { ok: false, reason: long.length ? 'moved-on' : 'no-steady', note: null, heldMs: 0, extreme: reached ? (low ? reached.low : reached.high) : null, ...extra };
  const pick = pins.reduce((a, b) => ((low ? b.note < a.note : b.note > a.note) ? b : a));
  const extreme = low ? Math.min(pick.note, reached.low) : Math.max(pick.note, reached.high);
  return { ok: true, reason: null, note: pick.note, heldMs: pick.durMs, extreme, ...extra };
}

// ---------------------------------------------------------------- the range

const noteOf = (end) => (isNote(end) ? Math.round(end) : end && end.ok !== false && isNote(end.note) ? end.note : null);
const extremeOf = (end, fallback) => (end && typeof end === 'object' && isNote(end.extreme) ? end.extreme : fallback);

export function measureRange({ low, high } = {}, cfg = CONFIG.range) {
  const lo = noteOf(low), hi = noteOf(high);
  const none = { ok: false, lowMidi: lo, highMidi: hi, notes: 0, comfortLow: null, comfortHigh: null, extremeLow: null, extremeHigh: null, small: false };
  if (lo === null) return { ...none, reason: 'no-low' };
  if (hi === null) return { ...none, reason: 'no-high' };
  if (hi < lo) return { ...none, reason: 'inverted' };
  const span = hi - lo;
  // The spec's 2 notes off each end, but a small range keeps comfortMinSpanSemis of itself.
  const trim = Math.max(0, Math.min(cfg.comfortTrimSemis, Math.floor((span - cfg.comfortMinSpanSemis) / 2)));
  return {
    ok: true, reason: null, lowMidi: lo, highMidi: hi, notes: span,
    comfortLow: lo + trim, comfortHigh: hi - trim,
    extremeLow: Math.min(lo, extremeOf(low, lo)), extremeHigh: Math.max(hi, extremeOf(high, hi)),
    small: span < cfg.smallNotes,
  };
}

const comfortEnds = (r) => {
  if (!r || !isNote(r.lowMidi) || !isNote(r.highMidi) || r.highMidi < r.lowMidi) return null;
  const lo = isNote(r.comfortLow) ? r.comfortLow : r.lowMidi, hi = isNote(r.comfortHigh) ? r.comfortHigh : r.highMidi;
  return hi >= lo ? { lo, hi } : { lo: r.lowMidi, hi: r.highMidi };
};

export function homeNote(range, cfg = CONFIG.range) {
  const c = comfortEnds(range);
  if (!c) return null;
  return c.lo + Math.min(cfg.homeUpSemis, Math.floor((c.hi - c.lo) / 4));
}

export function exerciseRange(saved, cfg = CONFIG.range) {
  const c = comfortEnds(saved);
  if (!c) return {};
  return { lowMidi: c.lo, highMidi: c.hi, home: homeNote(saved, cfg) };
}

export function figureRange(saved, cfg = CONFIG.range) {
  const { home, ...ends } = exerciseRange(saved, cfg);
  return home === undefined ? {} : { ...ends, prefer: home };
}

export function fitTimeline(timeline, range, { octavesOnly = false } = {}) {
  const midis = ((timeline && timeline.notes) || []).map((n) => n && n.midi).filter(isNote);
  const none = { fits: true, shift: 0, fitsAfter: true, overLow: 0, overHigh: 0, low: null, high: null, span: 0, reason: 'no-notes' };
  if (!midis.length) return none;
  const lo = Math.min(...midis), hi = Math.max(...midis);
  const facts = { low: lo, high: hi, span: hi - lo };
  const r = range && typeof range === 'object' ? range : {};
  if (!isNote(r.lowMidi) || !isNote(r.highMidi) || r.highMidi < r.lowMidi) return { ...none, ...facts, fits: null, fitsAfter: null, reason: 'no-range' };
  const under = (s) => Math.max(0, r.lowMidi - (lo + s)), over = (s) => Math.max(0, hi + s - r.highMidi);
  const fits = under(0) === 0 && over(0) === 0;
  let shift = 0;
  if (!fits && octavesOnly) {
    // The octave that leaves the fewest notes outside; of equals, the smallest move.
    let best = Infinity;
    for (let k = -5; k <= 5; k++) {
      const cost = under(12 * k) + over(12 * k);
      if (cost < best || (cost === best && Math.abs(12 * k) < Math.abs(shift))) { best = cost; shift = 12 * k; }
    }
  } else if (!fits) {
    shift = hi - lo <= r.highMidi - r.lowMidi
      ? (lo < r.lowMidi ? r.lowMidi - lo : r.highMidi - hi)
      : Math.round((r.lowMidi + r.highMidi) / 2 - (lo + hi) / 2);
    shift = Math.ceil(Math.abs(shift)) * Math.sign(shift) || 0; // whole notes, and enough of them (never -0)
  }
  const overLow = Math.ceil(under(shift)), overHigh = Math.ceil(over(shift));
  return { fits, shift, fitsAfter: overLow === 0 && overHigh === 0, overLow, overHigh, ...facts, reason: null };
}

// ---------------------------------------------------------------- words

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];

export function octaveWords(notes) {
  const halves = Math.round(Math.max(0, notes) / 6);
  if (halves === 0) return 'less than half an octave';
  if (halves === 1) return 'about half an octave';
  const whole = Math.floor(halves / 2), half = halves % 2 === 1;
  const n = NUMBER_WORDS[whole] || String(whole);
  if (half) return `about ${n} and a half octaves`;
  return `about ${n} ${whole === 1 ? 'octave' : 'octaves'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayWords(iso) {
  // Only what the app itself writes (toISOString): Chrome's Date reads a year out of almost
  // any text with a digit in it, and that showed as "measured 1 Jan" (bugs.md 47).
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : '';
}

export function rangeWords(range, { noteStyle = 'letters' } = {}) {
  const name = (m) => (isNote(m) ? displayNote(m, noteStyle).text : '');
  const c = comfortEnds(range);
  if (!c) return { line: '', comfort: '', small: '', low: '', high: '', comfortLow: '', comfortHigh: '' };
  const notes = range.highMidi - range.lowMidi;
  const low = name(range.lowMidi), high = name(range.highMidi), comfortLow = name(c.lo), comfortHigh = name(c.hi);
  return {
    // One note held at both ends is said as that: "C4 to C4, 0 notes" would read as a fault.
    line: notes === 0 ? `Your range today: one note, ${low}` : `Your range today: ${low} to ${high}, ${notes} ${notes === 1 ? 'note' : 'notes'}, ${octaveWords(notes)}`,
    comfort: c.lo === c.hi ? `Exercises will stay on ${comfortLow}.` : `Exercises will stay between ${comfortLow} and ${comfortHigh}.`,
    small: notes < CONFIG.range.smallNotes ? 'That’s a small sample; measure again when warmed up.' : '',
    low, high, comfortLow, comfortHigh,
  };
}

export function rangeGrowth(prev, now) {
  const a = comfortEnds(prev), b = comfortEnds(now);
  if (!a || !b) return { wider: 0, since: null, words: '' };
  const wider = (now.highMidi - now.lowMidi) - (prev.highMidi - prev.lowMidi);
  const day = dayWords(prev.at);
  return { wider, since: prev.at || null, words: wider > 0 ? `${wider} ${wider === 1 ? 'note' : 'notes'} wider than ${day ? `on ${day}` : 'last time'}` : '' };
}

// ---------------------------------------------------------------- saved

export const RANGE_KEY = `${STORAGE_PREFIX}range.v1`;

// What a measurement can give: the detector (js/pitch.js) hears 62 to 1100 Hz. A saved end
// outside that (damaged or hand-edited storage) gave targets nobody could be heard singing
// (bugs.md 46), so such an entry counts as not measured.
const whole = (v, cfg = CONFIG.range) => (isNote(v) && v >= cfg.savedMinMidi && v <= cfg.savedMaxMidi ? Math.round(v) : null);

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const lo = whole(e.lowMidi), hi = whole(e.highMidi);
  if (lo === null || hi === null || hi < lo) return null;
  // The comfortable ends are recomputed unless they sit inside the range, in order.
  const cl = whole(e.comfortLow), ch = whole(e.comfortHigh);
  const fresh = measureRange({ low: lo, high: hi });
  const ok = cl !== null && ch !== null && cl >= lo && ch <= hi && cl <= ch;
  // A note only touched may lie beyond what can be held and saved as an end.
  const far = (v) => (isNote(v) && v >= 21 && v <= 108 ? Math.round(v) : null);
  const xl = far(e.extremeLow), xh = far(e.extremeHigh);
  return {
    at: typeof e.at === 'string' ? e.at : null, lowMidi: lo, highMidi: hi,
    comfortLow: ok ? cl : fresh.comfortLow, comfortHigh: ok ? ch : fresh.comfortHigh,
    extremeLow: xl !== null && xl <= lo ? xl : lo, extremeHigh: xh !== null && xh >= hi ? xh : hi,
  };
}

export function toEntry(range, nowIso = null) {
  return cleanEntry({ ...range, at: nowIso });
}

export function nextRangeRecord(prev, entry, cfg = CONFIG.range) {
  const history = prev && Array.isArray(prev.history) ? prev.history.map(cleanEntry).filter(Boolean) : [];
  return { current: entry, history: [...history, entry].slice(-cfg.historyMax) };
}

export function readRangeRecord(storage) {
  let raw = null;
  try { raw = JSON.parse((storage && storage.getItem(RANGE_KEY)) || 'null'); } catch { return null; }
  const current = cleanEntry(raw && raw.current);
  if (!current) return null;
  const history = Array.isArray(raw.history) ? raw.history.map(cleanEntry).filter(Boolean) : [];
  return { current, history: history.length ? history : [current] };
}

export const readRange = (storage) => { const r = readRangeRecord(storage); return r ? r.current : null; };

export function saveRange(storage, range, nowIso = new Date().toISOString()) {
  const entry = toEntry(range, nowIso);
  if (!entry) throw new RangeError('saveRange: not a measured range');
  const prev = readRangeRecord(storage);
  const record = nextRangeRecord(prev, entry);
  let saved = false;
  try { if (storage) { storage.setItem(RANGE_KEY, JSON.stringify(record)); saved = true; } } catch { /* full or blocked: the range still stands for this visit */ }
  return { record, growth: rangeGrowth(prev && prev.current, entry), saved };
}
