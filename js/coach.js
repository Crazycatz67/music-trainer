// coach.js: turns a timeline plus the pitch frames a singer produced into per-note and
// session statistics and a ranked list of plain-words findings. Rule-based; data only.
// Pure: imports in Node, no browser globals.
//
// CONTRACT
//   analyse(timeline, frames, opts?) -> { notes: NoteStats[], session, findings }
//
//   Inputs
//     timeline  see js/timeline.js (seconds, MIDI numbers)
//     frames    pitch frames { t, hz, midi, clarity, voiced }, t in seconds on the same
//               clock as the timeline. A frame counts as sung only when voiced is true
//               and midi is a finite number; unvoiced frames are never given a pitch.
//     opts      any of DEFAULTS below (latency, foldOctaves, window sizes, thresholds)
//
//   Sign convention everywhere: cents = 100 x (sung midi - target midi).
//   Negative = flat (too low), positive = sharp (too high).
//   Frames are assumed evenly spaced, so "percentage of time" is a percentage of frames.
//
//   NoteStats (one per timeline note, same order). Fields are null when they cannot be
//   worked out (note not sung, or too short).
//     index, t, dur, midi, name   the target note ("C4" style name)
//     frames, voiced              frames inside [t, t + dur), and how many of them were sung
//     voicedPct                   100 x voiced / frames (null when no frames fell in the note)
//     sung                        voiced >= opts.minFrames; everything below needs this
//     meanCents, medianCents      average offset over the sung frames (the flat/sharp tendency)
//     meanAbsCents                average distance from the target, ignoring direction
//     within25, within50          % of sung frames within +-25 and +-50 cents
//     onsetDelay                  seconds from the note start to the first sung frame
//     lockTime                    seconds from the note start to the start of the first run of
//                                 back-to-back sung frames that stays within +-opts.lockCents
//                                 for opts.lockHold seconds; null if that never happens
//     scoopCents                  mean of the first opts.onsetWindow seconds of singing minus the
//                                 mean of the rest: negative = started low and slid up
//     wobble                      spread (standard deviation, cents) of the settled part, after
//                                 removing any steady drift so the two are not counted twice
//     drift                       cents the pitch moved across the settled part (line fit:
//                                 slope x length); only for notes settled for opts.minHold s
//   The "settled part" is the sung frames after the first opts.onsetWindow seconds of singing.
//
//   session
//     notes, notesSung, frames, voiced, voicedPct
//     meanCents, meanAbsCents, within25, within50   over every sung frame in every note
//     wobble, drift, scoopCents                      mean of the per-note values that exist
//     lockTime, onsetDelay                           median of the per-note values that exist
//     notesLocked                                    notes that have a lockTime
//     lowMeanCents, highMeanCents                    mean note offset in the lower and upper half
//                                                    of the sung range (null if range < 5 semitones)
//
//   findings: [ { id, kind: 'fix' | 'good', severity (0..1), value, text } ], most severe first.
//     no-lock counts only sung notes at least 2 x opts.lockHold long (shorter ones cannot show a lock).
//     ids: no-voice, quiet, flat, sharp, high-notes-flat, high-notes-sharp, drift-flat,
//          drift-sharp, wobble, scoop, overshoot, slow-lock, no-lock, hard-note, on-target
//
// The finding thresholds were chosen from reasoning, not from recordings of the owner.
// Treat them as starting values to calibrate against real sessions.

export const DEFAULTS = {
  latency: 0, // seconds the frames lag the timeline (mic + detector delay); subtracted from frame t
  foldOctaves: false, // true: judge the note name only, so singing an octave away still counts
  onsetWindow: 0.15, // seconds of singing treated as the note's start (scoop is measured here)
  lockCents: 50,
  lockHold: 0.1,
  minFrames: 3,
  minHold: 0.5,
  thresholds: {
    quietPct: 60, // below this share of sung frames, say the mic is not hearing enough
    biasCents: 10, // average flat/sharp worth mentioning
    registerCents: 15, // difference between high and low notes worth mentioning
    driftCents: 10,
    wobbleCents: 20,
    scoopCents: 20,
    slowLockSec: 0.4,
    hardNoteCents: 40,
    goodWithin50Pct: 80,
  },
};

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Kept local and tiny on purpose: js/notes.js is being built by someone else in parallel.
function noteName(midi) {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const pctWithin = (cents, limit) => (100 * cents.filter((c) => Math.abs(c) <= limit).length) / cents.length;

// Least-squares line through (t, cents). Returns the slope and the spread left over
// once the line is taken out.
function lineFit(pts) {
  const n = pts.length;
  const tBar = mean(pts.map((p) => p.t));
  const cBar = mean(pts.map((p) => p.cents));
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.t - tBar) ** 2;
    sxy += (p.t - tBar) * (p.cents - cBar);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let ss = 0;
  for (const p of pts) ss += (p.cents - cBar - slope * (p.t - tBar)) ** 2;
  return { slope, spread: Math.sqrt(ss / n) };
}

function noteStats(note, index, frames, o) {
  const out = {
    index,
    t: note.t,
    dur: note.dur,
    midi: note.midi,
    name: noteName(note.midi),
    frames: 0,
    voiced: 0,
    voicedPct: null,
    sung: false,
    meanCents: null,
    medianCents: null,
    meanAbsCents: null,
    within25: null,
    within50: null,
    onsetDelay: null,
    lockTime: null,
    scoopCents: null,
    wobble: null,
    drift: null,
  };
  const end = note.t + note.dur;
  const pts = []; // sung frames: { t, cents }
  let run = null; // start time of the current in-tune run
  for (const f of frames) {
    const t = f.t - o.latency;
    // Written as "not inside" on purpose: a frame whose time is missing or NaN fails both
    // comparisons, and must fall outside every note instead of inside all of them.
    if (!(t >= note.t && t < end)) continue;
    out.frames++;
    if (!(f.voiced && Number.isFinite(f.midi))) {
      run = null; // a gap in the voice breaks a lock-on run
      continue;
    }
    let cents = 100 * (f.midi - note.midi);
    if (o.foldOctaves) cents -= 1200 * Math.round(cents / 1200);
    pts.push({ t, cents });
    if (Math.abs(cents) <= o.lockCents) {
      if (run === null) run = t;
      if (out.lockTime === null && t - run >= o.lockHold) out.lockTime = run - note.t;
    } else {
      run = null;
    }
  }
  out.voiced = pts.length;
  if (out.frames) out.voicedPct = (100 * out.voiced) / out.frames;
  out.cents = pts.map((p) => p.cents);
  if (pts.length < o.minFrames) {
    // Too little to judge: a lock found on a couple of stray frames would mislead.
    out.lockTime = null;
    return out;
  }
  out.sung = true;
  out.meanCents = mean(out.cents);
  out.medianCents = median(out.cents);
  out.meanAbsCents = mean(out.cents.map(Math.abs));
  out.within25 = pctWithin(out.cents, 25);
  out.within50 = pctWithin(out.cents, 50);
  out.onsetDelay = pts[0].t - note.t;

  const onsetEnd = pts[0].t + o.onsetWindow;
  const onset = pts.filter((p) => p.t < onsetEnd);
  const settled = pts.filter((p) => p.t >= onsetEnd);
  if (settled.length >= o.minFrames) {
    out.scoopCents = mean(onset.map((p) => p.cents)) - mean(settled.map((p) => p.cents));
    const fit = lineFit(settled);
    out.wobble = fit.spread;
    const span = settled[settled.length - 1].t - settled[0].t;
    if (span >= o.minHold) out.drift = fit.slope * span;
  }
  return out;
}

const present = (xs) => xs.filter((x) => x !== null);
const r0 = (x) => Math.round(Math.abs(x));
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function buildFindings(notes, s, T, lockHold) {
  if (!s.notesSung) {
    return [
      {
        id: 'no-voice',
        kind: 'fix',
        severity: 1,
        value: s.voicedPct ?? 0,
        text: 'No clear singing was picked up. Check the microphone, then sing a steady "ah" a little louder.',
      },
    ];
  }
  const out = [];
  const add = (id, severity, value, text, kind = 'fix') => out.push({ id, kind, severity: clamp01(severity), value, text });

  if (s.voicedPct < T.quietPct) {
    add('quiet', (T.quietPct - s.voicedPct) / T.quietPct, s.voicedPct, `A clear note was heard only ${Math.round(s.voicedPct)}% of the time. Sing a little louder, hold each note for its full length, or move closer to the microphone.`);
  }

  if (Math.abs(s.meanCents) >= T.biasCents) {
    const flat = s.meanCents < 0;
    add(flat ? 'flat' : 'sharp', Math.abs(s.meanCents) / 50, s.meanCents, `On average you sang about ${r0(s.meanCents)} cents ${flat ? 'flat (too low)' : 'sharp (too high)'}. A semitone is 100 cents. Aim slightly ${flat ? 'higher' : 'lower'}.`);
  }

  if (s.highMeanCents !== null && s.lowMeanCents !== null) {
    const diff = s.highMeanCents - s.lowMeanCents;
    if (Math.abs(diff) >= T.registerCents) {
      const flat = diff < 0;
      add(flat ? 'high-notes-flat' : 'high-notes-sharp', Math.abs(diff) / 50, diff, `Your higher notes came out ${r0(diff)} cents ${flat ? 'flatter' : 'sharper'} than your lower notes. ${flat ? 'Give the high notes more breath and think of landing on top of them.' : 'Ease off on the high notes instead of pushing.'}`);
    }
  }

  if (s.drift !== null && Math.abs(s.drift) >= T.driftCents) {
    const flat = s.drift < 0;
    add(flat ? 'drift-flat' : 'drift-sharp', Math.abs(s.drift) / 40, s.drift, `On held notes your pitch ${flat ? 'sinks' : 'creeps up'} by about ${r0(s.drift)} cents. ${flat ? 'Keep the breath steady right to the end of the note.' : 'Relax as you hold the note instead of pushing harder.'}`);
  }

  if (s.wobble !== null && s.wobble >= T.wobbleCents) {
    add('wobble', s.wobble / 50, s.wobble, `Your held notes waver by about ${r0(s.wobble)} cents either side. Try a slow, steady breath out on one comfortable note.`);
  }

  if (s.scoopCents !== null && Math.abs(s.scoopCents) >= T.scoopCents) {
    const low = s.scoopCents < 0;
    add(low ? 'scoop' : 'overshoot', Math.abs(s.scoopCents) / 60, s.scoopCents, low ? `You start notes about ${r0(s.scoopCents)} cents low and slide up to them. Hear the note in your head before you sing it.` : `You start notes about ${r0(s.scoopCents)} cents high and settle down onto them. Start more gently.`);
  }

  // Only notes long enough to arrive on AND hold for lockHold can show a lock. On shorter
  // ones (a fast run, a siren step) a lock is decided by frame rounding, so they are left
  // out of this count rather than held against a singer who was on pitch throughout.
  const holdable = notes.filter((n) => n.sung && n.dur >= 2 * lockHold);
  const held = holdable.filter((n) => n.lockTime !== null).length;
  if (held * 2 < holdable.length) {
    add('no-lock', 0.9 * (1 - held / holdable.length), held, `You settled on the target for ${held} of ${holdable.length} notes. Slow down and match one note at a time.`);
  } else if (s.lockTime !== null && s.lockTime >= T.slowLockSec) {
    add('slow-lock', s.lockTime / 1.2, s.lockTime, `It takes you about ${s.lockTime.toFixed(1)} seconds to settle on a note. Listen to the reference tone a moment longer before you sing.`);
  }

  if (s.notesSung >= 3) {
    let worst = null;
    for (const n of notes) if (n.sung && (!worst || Math.abs(n.meanCents) > Math.abs(worst.meanCents))) worst = n;
    if (worst && Math.abs(worst.meanCents) >= T.hardNoteCents) {
      add('hard-note', 0.8 * (Math.abs(worst.meanCents) / 100), worst.index, `The hardest note was ${worst.name} (note ${worst.index + 1}): about ${r0(worst.meanCents)} cents ${worst.meanCents < 0 ? 'flat' : 'sharp'}.`);
    }
  }

  if (s.within50 >= T.goodWithin50Pct) {
    // Always last: praise should not push a fixable problem down the list.
    add('on-target', 0.05, s.within50, `You were within half a semitone of the target ${Math.round(s.within50)}% of the time you were singing.`, 'good');
  }

  // Array.prototype.sort is stable, so equal severities keep the order above.
  return out.sort((a, b) => b.severity - a.severity);
}

export function analyse(timeline, frames, opts = {}) {
  if (!timeline || !Array.isArray(timeline.notes)) throw new TypeError('coach: timeline must have a notes array');
  if (!Array.isArray(frames)) throw new TypeError('coach: frames must be an array');
  const o = { ...DEFAULTS, ...opts, thresholds: { ...DEFAULTS.thresholds, ...(opts.thresholds ?? {}) } };
  // A latency that is not a number would turn every frame time into NaN.
  if (!Number.isFinite(o.latency)) o.latency = 0;

  const notes = timeline.notes.map((n, i) => noteStats(n, i, frames, o));
  const allCents = notes.flatMap((n) => n.cents);
  // The raw per-frame values were only needed to pool the session numbers.
  for (const n of notes) delete n.cents;

  const sungNotes = notes.filter((n) => n.sung);
  const totalFrames = notes.reduce((s, n) => s + n.frames, 0);
  const session = {
    notes: notes.length,
    notesSung: sungNotes.length,
    frames: totalFrames,
    voiced: allCents.length,
    voicedPct: totalFrames ? (100 * allCents.length) / totalFrames : null,
    meanCents: mean(allCents),
    meanAbsCents: mean(allCents.map(Math.abs)),
    within25: allCents.length ? pctWithin(allCents, 25) : null,
    within50: allCents.length ? pctWithin(allCents, 50) : null,
    wobble: mean(present(sungNotes.map((n) => n.wobble))),
    drift: mean(present(sungNotes.map((n) => n.drift))),
    scoopCents: mean(present(sungNotes.map((n) => n.scoopCents))),
    lockTime: median(present(sungNotes.map((n) => n.lockTime))),
    onsetDelay: median(present(sungNotes.map((n) => n.onsetDelay))),
    notesLocked: sungNotes.filter((n) => n.lockTime !== null).length,
    lowMeanCents: null,
    highMeanCents: null,
  };

  if (sungNotes.length >= 2) {
    const lo = Math.min(...sungNotes.map((n) => n.midi));
    const hi = Math.max(...sungNotes.map((n) => n.midi));
    // Under a fourth or so there is no real "high" and "low" to compare.
    if (hi - lo >= 5) {
      const mid = (lo + hi) / 2;
      session.lowMeanCents = mean(sungNotes.filter((n) => n.midi < mid).map((n) => n.meanCents));
      session.highMeanCents = mean(sungNotes.filter((n) => n.midi > mid).map((n) => n.meanCents));
    }
  }

  return { notes, session, findings: buildFindings(notes, session, o.thresholds, o.lockHold) };
}
