// curve.js — the target a singer follows in song mode: the original singer's pitch as one
// continuous curve, with loudness. Pure: no browser globals, imports in Node.
//
// Why a curve and not notes: it is what the analysis produces most reliably, and it keeps
// slides and vibrato. Notes are DERIVED from it, only for scoring and for shifting the key.
//
// CONTRACT
//   Curve: { t[], midi[], level[], voiced[], hop, engine? }
//     t       seconds from the start of the audio, rising, one entry per frame (the CENTRE
//             of the analysed window)
//     midi    MIDI float (69 = A4) or null. null exactly when voiced is false (the project
//             rule: never a pitch for an unvoiced frame)
//     level   loudness of the vocal at that frame, RMS 0..1 (linear, not dB)
//     voiced  boolean
//     hop     seconds between frames (the median step of t)
//     Plain arrays, so a curve goes through JSON unchanged.
//
//   makeCurve({ t, midi, level, voiced, engine? }) -> Curve
//       Throws RangeError when the four arrays differ in length or t is not rising.
//       A voiced frame without a finite midi is stored unvoiced (midi null).
//   curveAt(curve, t) -> { midi, level, voiced }
//       The frame nearest t; unvoiced beyond half a hop outside the curve's ends. Pitch is
//       interpolated between two voiced neighbours, never across an unvoiced one.
//   transposeCurve(curve, semitones) -> Curve   (a new curve; levels and timing unchanged)
//   deriveNotes(curve, { minDur = 0.08, splitSemitones = 0.7, smooth = 0.12, maxGap = 0.06 })
//       -> [{ t, dur, midi, exact, level }]   sorted by t; fits the project timeline's notes
//       midi   nearest whole note of the note's median pitch; exact  that median as a float
//       A new note starts after an unvoiced gap longer than maxGap, or when the smoothed
//       pitch (median over `smooth` seconds, so vibrato does not split a note) has moved
//       splitSemitones from the running note. Pieces shorter than minDur are dropped.
//   curveToTimeline(curve, { title, artist?, source?, ...deriveNotes options }) -> timeline
//   curveRange(curve) -> { lowest, highest, low, high, median, voicedPct, voicedSeconds } | null
//       What a singer needs to know before trying the song. lowest/highest: the extremes
//       (1st and 99th percentile of the voiced frames, so one stray frame does not set
//       them); low/high: the band most of the song sits in (10th to 90th percentile);
//       all MIDI floats. null when nothing is voiced.
//   voicedStretches(curve, { maxGap = 0.15 }) -> [{ t, dur }] longest first
//       Unbroken singing: voiced frames with no hole longer than maxGap between them.
//   compareCurves(a, b) -> { both, within50, octaveApart, onlyA, onlyB }
//       Two readings of the same audio, compared at a's frame times. both = frames voiced
//       in both; within50 / octaveApart = % of those; onlyA / onlyB = % of the frames
//       voiced in either that only one of them calls voiced.
//   scoreCurve(curve, truthAt, { from = 0, to = last t, edge = 0.03, searchMs = 200 })
//       -> accuracy numbers against a known pitch (the lab's synthetic song)
//       truthAt(t) -> midi float, or null where nothing is sung.
//       Frames within `edge` seconds of a start or end of singing are left out of every
//       count: where exactly a faded note "begins" is a matter of definition.
//       Result (percentages 0..100, one decimal):
//         frames, truthVoiced, truthUnvoiced
//         within50, within25   % of truth-voiced frames that are voiced AND that close
//         octaveErrors         % of truth-voiced frames read 12 or 24 semitones off (+-1)
//         grossErrors          % read more than 50 cents off and not an octave
//         missed               % of truth-voiced frames reported unvoiced
//         falseVoiced          % of truth-unvoiced frames reported voiced
//         medianAbsCents       over voiced frames both sides agree on, octave errors left out
//         offsetMs             the time shift of the curve that fits the truth best
//                              (positive = the curve is late); searched over +-searchMs
//         within50Shifted      within50 after removing that shift

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round1 = (x) => Math.round(x * 10) / 10;

export function makeCurve({ t, midi, level, voiced, engine } = {}) {
  const n = t?.length;
  if (!(n >= 0) || midi?.length !== n || level?.length !== n || voiced?.length !== n) {
    throw new RangeError(`curve: t, midi, level and voiced must have one length, got ${t?.length}, ${midi?.length}, ${level?.length}, ${voiced?.length}`);
  }
  const out = { t: new Array(n), midi: new Array(n), level: new Array(n), voiced: new Array(n), hop: 0 };
  const steps = [];
  for (let i = 0; i < n; i++) {
    if (i && !(t[i] > t[i - 1])) throw new RangeError(`curve: t must rise, but t[${i}] = ${t[i]} after ${t[i - 1]}`);
    if (i) steps.push(t[i] - t[i - 1]);
    const on = !!voiced[i] && Number.isFinite(midi[i]);
    out.t[i] = t[i];
    out.midi[i] = on ? midi[i] : null;
    out.voiced[i] = on;
    out.level[i] = Number.isFinite(level[i]) ? level[i] : 0;
  }
  out.hop = steps.length ? median(steps) : 0;
  if (engine) out.engine = engine;
  return out;
}

// Index of the last frame at or before t (-1 when t is before the first frame).
function indexAt(curve, t) {
  let lo = 0, hi = curve.t.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (curve.t[mid] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

export function curveAt(curve, t) {
  const n = curve.t.length, off = { midi: null, level: 0, voiced: false };
  if (!n || t < curve.t[0] - curve.hop / 2 || t > curve.t[n - 1] + curve.hop / 2) return off;
  const a = Math.max(0, indexAt(curve, t)), b = Math.min(n - 1, a + 1);
  const span = curve.t[b] - curve.t[a];
  const k = span > 0 ? Math.min(1, Math.max(0, (t - curve.t[a]) / span)) : 0;
  const near = k < 0.5 ? a : b;
  if (!curve.voiced[near]) return { midi: null, level: curve.level[near], voiced: false };
  const both = curve.voiced[a] && curve.voiced[b];
  return {
    midi: both ? curve.midi[a] + (curve.midi[b] - curve.midi[a]) * k : curve.midi[near],
    level: curve.level[a] + (curve.level[b] - curve.level[a]) * k,
    voiced: true,
  };
}

export function transposeCurve(curve, semitones) {
  if (!Number.isFinite(semitones)) throw new RangeError(`curve: transpose needs a number of semitones, got ${semitones}`);
  return { ...curve, t: [...curve.t], level: [...curve.level], voiced: [...curve.voiced], midi: curve.midi.map((m) => (m === null ? null : m + semitones)) };
}

export function deriveNotes(curve, { minDur = 0.08, splitSemitones = 0.7, smooth = 0.12, maxGap = 0.06 } = {}) {
  const n = curve.t.length, notes = [];
  const half = Math.max(0, Math.round(smooth / 2 / (curve.hop || 1)));
  // Median of the voiced pitches around a frame: a vibrato of half a semitone each way
  // averages out, a step to the next note does not.
  const smoothed = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!curve.voiced[i]) continue;
    const near = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (curve.voiced[j]) near.push(curve.midi[j]);
    smoothed[i] = median(near);
  }
  let open = null;
  const close = () => {
    if (!open) return;
    const end = curve.t[open.last] + curve.hop / 2, start = curve.t[open.first] - curve.hop / 2;
    if (end - start >= minDur) {
      const exact = median(open.pitches);
      notes.push({ t: Math.max(0, start), dur: end - Math.max(0, start), midi: Math.round(exact), exact, level: median(open.levels) });
    }
    open = null;
  };
  for (let i = 0; i < n; i++) {
    if (!curve.voiced[i]) {
      if (open && curve.t[i] - curve.t[open.last] > maxGap) close();
      continue;
    }
    if (open && (curve.t[i] - curve.t[open.last] > maxGap + curve.hop || Math.abs(smoothed[i] - median(open.pitches)) >= splitSemitones)) close();
    open ??= { first: i, last: i, pitches: [], levels: [] };
    open.last = i;
    open.pitches.push(smoothed[i]);
    open.levels.push(curve.level[i]);
  }
  close();
  return notes;
}

export function curveToTimeline(curve, { title = 'Untitled', artist, source, ...noteOptions } = {}) {
  const timeline = { title, notes: deriveNotes(curve, noteOptions).map(({ t, dur, midi }) => ({ t, dur, midi })) };
  if (artist) timeline.artist = artist;
  if (source) timeline.source = source;
  return timeline;
}

export function curveRange(curve) {
  const sung = curve.midi.filter((m) => m !== null).sort((a, b) => a - b);
  if (!sung.length) return null;
  const at = (q) => sung[Math.min(sung.length - 1, Math.floor(q * sung.length))];
  return {
    lowest: at(0.01), highest: at(0.99), low: at(0.1), high: at(0.9), median: at(0.5),
    voicedPct: round1((100 * sung.length) / curve.t.length), voicedSeconds: round1(sung.length * curve.hop),
  };
}

export function voicedStretches(curve, { maxGap = 0.15 } = {}) {
  const out = [];
  let first = -1, last = -1;
  const close = () => { if (first >= 0) out.push({ t: curve.t[first], dur: curve.t[last] - curve.t[first] + curve.hop }); first = -1; };
  for (let i = 0; i < curve.t.length; i++) {
    if (!curve.voiced[i]) continue;
    if (first >= 0 && curve.t[i] - curve.t[last] > maxGap + curve.hop) close();
    if (first < 0) first = i;
    last = i;
  }
  close();
  return out.sort((a, b) => b.dur - a.dur);
}

export function compareCurves(a, b) {
  let both = 0, w50 = 0, octave = 0, onlyA = 0, onlyB = 0;
  for (let i = 0; i < a.t.length; i++) {
    const other = curveAt(b, a.t[i]);
    if (a.voiced[i] && other.voiced) {
      both++;
      const d = a.midi[i] - other.midi;
      if (Math.abs(d) <= 0.5) w50++; else if (isOctave(d)) octave++;
    } else if (a.voiced[i]) onlyA++; else if (other.voiced) onlyB++;
  }
  const pct = (x, y) => (y ? round1((100 * x) / y) : 0), any = both + onlyA + onlyB;
  return { both, within50: pct(w50, both), octaveApart: pct(octave, both), onlyA: pct(onlyA, any), onlyB: pct(onlyB, any) };
}

const OCTAVES = [12, 24];
const isOctave = (semitones) => OCTAVES.some((o) => Math.abs(Math.abs(semitones) - o) <= 1);

export function scoreCurve(curve, truthAt, { from = 0, to, edge = 0.03, searchMs = 200 } = {}) {
  const n = curve.t.length;
  const end = to ?? (n ? curve.t[n - 1] : 0);
  // "Near an edge" = the truth changes between sung and silent within `edge` seconds.
  const steady = (t) => {
    const here = truthAt(t) === null;
    return (truthAt(t - edge) === null) === here && (truthAt(t + edge) === null) === here;
  };
  const tally = (shift) => {
    const c = { frames: 0, truthVoiced: 0, truthUnvoiced: 0, w50: 0, w25: 0, octave: 0, gross: 0, missed: 0, falseVoiced: 0, abs: [], cost: 0, both: 0 };
    for (let i = 0; i < n; i++) {
      const t = curve.t[i] - shift;
      if (t < from || t > end || !steady(t)) continue;
      const truth = truthAt(t);
      c.frames++;
      if (truth === null) { c.truthUnvoiced++; if (curve.voiced[i]) c.falseVoiced++; continue; }
      c.truthVoiced++;
      if (!curve.voiced[i]) { c.missed++; continue; }
      const d = curve.midi[i] - truth, cents = Math.abs(d) * 100;
      if (cents <= 50) c.w50++;
      if (cents <= 25) c.w25++;
      if (cents > 50) { if (isOctave(d)) c.octave++; else c.gross++; }
      if (!isOctave(d)) c.abs.push(cents);
      c.cost += Math.min(cents, 100); c.both++;
    }
    return c;
  };
  const base = tally(0);
  // The best shift is the one with the smallest average error (each frame capped at 100
  // cents) where both sides sing: on a slide or a vibrato a curve that is early or late
  // reads sharp or flat, so the error is smallest at the true shift. Not "most frames within
  // 25 cents": that count is flat over a range of shifts and names its edge, not its middle.
  const mean = (c) => (c.both ? c.cost / c.both : Infinity);
  let best = { shift: 0, mean: mean(base), w25: base.w25, w50: base.w50, truthVoiced: base.truthVoiced };
  for (let ms = -searchMs; ms <= searchMs; ms += 2) {
    if (!ms) continue;
    const c = tally(ms / 1000);
    // A shift must still compare most of the frames, or it could "win" by sliding off them.
    if (c.both >= base.both * 0.8 && mean(c) < best.mean - 1e-9) best = { shift: ms / 1000, mean: mean(c), w25: c.w25, w50: c.w50, truthVoiced: c.truthVoiced };
  }
  const pct = (a, b) => (b ? round1((100 * a) / b) : 0);
  return {
    frames: base.frames, truthVoiced: base.truthVoiced, truthUnvoiced: base.truthUnvoiced,
    within50: pct(base.w50, base.truthVoiced), within25: pct(base.w25, base.truthVoiced),
    octaveErrors: pct(base.octave, base.truthVoiced), grossErrors: pct(base.gross, base.truthVoiced),
    missed: pct(base.missed, base.truthVoiced), falseVoiced: pct(base.falseVoiced, base.truthUnvoiced),
    medianAbsCents: base.abs.length ? round1(median(base.abs)) : null,
    offsetMs: Math.round(best.shift * 1000),
    within50Shifted: pct(best.w50, best.truthVoiced), within25Shifted: pct(best.w25, best.truthVoiced),
  };
}
