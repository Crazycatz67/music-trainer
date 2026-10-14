// timeline.js: the one note format shared by exercises and songs, plus the built-in
// exercise generators. Pure: no browser globals, imports in Node.
//
// CONTRACT (from docs/team-log/AGENT-BRIEF.md)
//   Timeline: { title, artist?, bpm?, source?, notes: [ { t, dur, midi, lyric?, hand?, finger? } ] }
//   - t and dur are seconds (t >= 0, dur > 0); midi is a MIDI note number (60 = C4, floats allowed).
//   - notes are sorted by t (ties allowed, so piano chords fit later).
//   - Extra fields on the timeline or on a note are allowed and are carried through every
//     function here untouched (the loaders use `meta`, `line`, `golden`).
//
// API
//   validateTimeline(tl)            -> string[]   problems in plain words; [] means valid. Never throws.
//   createTimeline(fields)          -> Timeline   copies, sorts notes by t, throws TypeError if invalid.
//   transpose(tl, semitones)        -> Timeline   new timeline, every midi shifted.
//   slice(tl, t0, t1, opts?)        -> Timeline   notes that overlap [t0, t1).
//        opts.clip   (default true)  trim notes to the window edges
//        opts.rebase (default false) shift times so the window starts at 0
//   range(tl)                       -> { low, high, span } | null   (null when there are no notes)
//   duration(tl)                    -> seconds, end of the last-ending note (0 when empty)
//   exercises.heldNote / siren / fourNote / intervals / majorScale (startMidi, opts?) -> Timeline
//
// Nothing here mutates its input.

// Times are built by adding fractions; rounding to a microsecond keeps 0.1 + 0.2 style
// fuzz out of equality checks and saved files without losing anything audible.
const tidy = (x) => Math.round(x * 1e6) / 1e6;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function validateTimeline(tl) {
  const errors = [];
  if (!tl || typeof tl !== 'object') return ['timeline is not an object'];
  if (typeof tl.title !== 'string' || tl.title.trim() === '') errors.push('title must be a non-empty string');
  if (tl.artist !== undefined && typeof tl.artist !== 'string') errors.push('artist must be a string');
  if (tl.bpm !== undefined && !(isNum(tl.bpm) && tl.bpm > 0)) errors.push('bpm must be a number above 0');
  if (!Array.isArray(tl.notes)) {
    errors.push('notes must be an array');
    return errors;
  }
  let prevT = -Infinity;
  for (let i = 0; i < tl.notes.length; i++) {
    const n = tl.notes[i];
    if (!n || typeof n !== 'object') {
      errors.push(`note ${i} is not an object`);
      continue;
    }
    if (!(isNum(n.t) && n.t >= 0)) errors.push(`note ${i}: t must be a number of seconds, 0 or more`);
    if (!(isNum(n.dur) && n.dur > 0)) errors.push(`note ${i}: dur must be a number of seconds above 0`);
    if (!isNum(n.midi)) errors.push(`note ${i}: midi must be a number`);
    if (n.lyric !== undefined && typeof n.lyric !== 'string') errors.push(`note ${i}: lyric must be a string`);
    if (isNum(n.t)) {
      if (n.t < prevT) errors.push(`note ${i}: notes must be sorted by t`);
      prevT = n.t;
    }
  }
  return errors;
}

export function createTimeline(fields = {}) {
  const { notes, ...rest } = fields;
  const tl = { title: 'Untitled', ...rest };
  // Optional fields that are present but undefined would fail a strict deep-equal against
  // a timeline that simply lacks them, so drop them.
  for (const k of Object.keys(tl)) if (tl[k] === undefined) delete tl[k];
  const copied = Array.isArray(notes) ? notes.map((n) => (n && typeof n === 'object' ? { ...n } : n)) : notes ?? [];
  if (Array.isArray(copied)) {
    // Array.prototype.sort is stable, so chord notes that share a t keep their given order.
    copied.sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0));
  }
  tl.notes = copied;
  const errors = validateTimeline(tl);
  if (errors.length) throw new TypeError(`Invalid timeline: ${errors.join('; ')}`);
  return tl;
}

export function transpose(tl, semitones) {
  if (!isNum(semitones)) throw new TypeError('transpose: semitones must be a number');
  return { ...tl, notes: tl.notes.map((n) => ({ ...n, midi: n.midi + semitones })) };
}

export function slice(tl, t0, t1, { clip = true, rebase = false } = {}) {
  if (!(isNum(t0) && isNum(t1) && t1 > t0)) throw new TypeError('slice: need numbers with t1 > t0');
  const notes = [];
  for (const n of tl.notes) {
    const end = n.t + n.dur;
    if (end <= t0 || n.t >= t1) continue;
    let t = n.t;
    let dur = n.dur;
    if (clip) {
      t = Math.max(n.t, t0);
      dur = Math.min(end, t1) - t;
    }
    if (rebase) t -= t0;
    notes.push({ ...n, t: tidy(t), dur: tidy(dur) });
  }
  return { ...tl, notes };
}

export function range(tl) {
  if (!tl.notes.length) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const n of tl.notes) {
    if (n.midi < low) low = n.midi;
    if (n.midi > high) high = n.midi;
  }
  return { low, high, span: high - low };
}

export function duration(tl) {
  let end = 0;
  for (const n of tl.notes) end = Math.max(end, n.t + n.dur);
  return tidy(end);
}

// ---- Exercises ---------------------------------------------------------------------------

function needStart(startMidi, name) {
  if (!isNum(startMidi)) throw new TypeError(`${name}: startMidi must be a MIDI note number`);
}

// Lays notes end to end: each item is { midi, dur, gapAfter }.
function sequence(title, items, leadIn) {
  let t = leadIn;
  const notes = [];
  for (const it of items) {
    notes.push({ t: tidy(t), dur: it.dur, midi: it.midi });
    t += it.dur + (it.gapAfter ?? 0);
  }
  return createTimeline({ title, source: 'exercise', notes });
}

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

export const exercises = {
  // One long note to match and hold.
  heldNote(startMidi, { dur = 4, leadIn = 0 } = {}) {
    needStart(startMidi, 'heldNote');
    return sequence('Held note', [{ midi: startMidi, dur }], leadIn);
  },

  // A siren is a continuous glide, but a timeline holds discrete notes, so this gives the
  // glide's waypoints: back-to-back semitone steps up `span` semitones and down again.
  // Screens can draw a smooth line through them; the coach scores each step as a short note.
  siren(startMidi, { span = 7, stepDur = 0.3, holdTop = 0.6, leadIn = 0 } = {}) {
    needStart(startMidi, 'siren');
    if (!(Number.isInteger(span) && span >= 1)) throw new TypeError('siren: span must be a whole number of semitones, 1 or more');
    const items = [];
    for (let s = 0; s < span; s++) items.push({ midi: startMidi + s, dur: stepDur });
    items.push({ midi: startMidi + span, dur: holdTop });
    for (let s = span - 1; s >= 0; s--) items.push({ midi: startMidi + s, dur: stepDur });
    return sequence('Siren', items, leadIn);
  },

  // Four-note pattern (default do-re-mi-re). `repeats` plays it again, each time moved by
  // `shift` semitones, which is how a warm-up walks a pattern up through the range.
  fourNote(startMidi, { pattern = [0, 2, 4, 2], noteDur = 0.6, gap = 0.1, repeats = 1, shift = 1, rest = 0.8, leadIn = 0 } = {}) {
    needStart(startMidi, 'fourNote');
    if (!Array.isArray(pattern) || pattern.length === 0 || !pattern.every(isNum)) throw new TypeError('fourNote: pattern must be a list of semitone offsets');
    const items = [];
    for (let r = 0; r < repeats; r++) {
      pattern.forEach((off, i) => {
        const last = i === pattern.length - 1;
        items.push({ midi: startMidi + r * shift + off, dur: noteDur, gapAfter: last ? rest : gap });
      });
    }
    return sequence('Four-note pattern', items, leadIn);
  },

  // Root then target for each interval, with a rest between pairs so each jump starts fresh.
  intervals(startMidi, { intervals = [2, 4, 5, 7, 12], noteDur = 1, gap = 0.2, rest = 0.8, leadIn = 0 } = {}) {
    needStart(startMidi, 'intervals');
    if (!Array.isArray(intervals) || intervals.length === 0 || !intervals.every(isNum)) throw new TypeError('intervals: intervals must be a list of semitone sizes');
    const items = [];
    for (const iv of intervals) {
      items.push({ midi: startMidi, dur: noteDur, gapAfter: gap });
      items.push({ midi: startMidi + iv, dur: noteDur, gapAfter: rest });
    }
    return sequence('Intervals', items, leadIn);
  },

  // Major scale up, and back down unless descend is false. The top note is played once.
  majorScale(startMidi, { octaves = 1, noteDur = 0.5, gap = 0, descend = true, leadIn = 0 } = {}) {
    needStart(startMidi, 'majorScale');
    if (!(Number.isInteger(octaves) && octaves >= 1)) throw new TypeError('majorScale: octaves must be a whole number, 1 or more');
    const up = [];
    for (let o = 0; o < octaves; o++) for (const s of MAJOR_STEPS) up.push(startMidi + 12 * o + s);
    up.push(startMidi + 12 * octaves);
    const all = descend ? up.concat(up.slice(0, -1).reverse()) : up;
    return sequence('Major scale', all.map((midi) => ({ midi, dur: noteDur, gapAfter: gap })), leadIn);
  },
};
