// notes.js — note maths. Pure: no browser globals, imports in Node.
//
// CONTRACT (project-wide pitch numbers, see docs/team-log/AGENT-BRIEF.md)
//   Pitch is a MIDI note number as a float: 69 = A4 = 440 Hz, 60 = C4 (middle C).
//   Cents are relative to a target: cents = 100 * (midiSung - midiTarget).
//   Positive = sharp, negative = flat.
//
//   hzToMidi(hz)                -> midi float, or null when hz is not a positive finite number
//   midiToHz(midi)              -> hz, or null when midi is not finite
//   centsBetween(midi, target)  -> signed cents, or null when either side is not finite
//   centsBetweenHz(hz, target)  -> the same from two frequencies
//   noteName(midi, { flats })   -> 'C4', 'F#3' ('Gb3' with flats) for the NEAREST semitone;
//                                  null for non-finite input
//   nameToMidi('C#4' | 'Db4')   -> integer midi, or null when the text is not a note name
//   nearestNote(midi, { flats })-> { midi (integer), name, pitchClass 0..11, octave, cents }
//                                  cents in [-50, 50): how far the input is from that note
//
// null in -> null out everywhere, so an unvoiced pitch frame ({ hz: null, midi: null })
// can be passed straight through without the caller inventing a pitch.

export const A4_HZ = 440;
export const A4_MIDI = 69;

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function hzToMidi(hz) {
  if (!isNum(hz) || hz <= 0) return null;
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

export function midiToHz(midi) {
  if (!isNum(midi)) return null;
  return A4_HZ * 2 ** ((midi - A4_MIDI) / 12);
}

export function centsBetween(midi, targetMidi) {
  if (!isNum(midi) || !isNum(targetMidi)) return null;
  return 100 * (midi - targetMidi);
}

export function centsBetweenHz(hz, targetHz) {
  return centsBetween(hzToMidi(hz), hzToMidi(targetHz));
}

export function nearestNote(midi, { flats = false } = {}) {
  if (!isNum(midi)) return null;
  // floor(x + 0.5), not Math.round: Math.round(-0.3) is -0, which prints as 0 but fails
  // strict equality checks against 0.
  const nearest = Math.floor(midi + 0.5);
  const pitchClass = ((nearest % 12) + 12) % 12;
  // MIDI octave numbering where 60 is C4 (the convention the timeline and songs use).
  const octave = Math.floor(nearest / 12) - 1;
  return {
    midi: nearest,
    name: (flats ? FLAT_NAMES : SHARP_NAMES)[pitchClass] + octave,
    pitchClass,
    octave,
    cents: 100 * (midi - nearest),
  };
}

export function noteName(midi, opts) {
  const n = nearestNote(midi, opts);
  return n ? n.name : null;
}

export function nameToMidi(name) {
  if (typeof name !== 'string') return null;
  // Accept ASCII and the real sharp/flat signs: charts and people write both.
  const m = /^\s*([A-Ga-g])([#b♯♭]{0,2})(-?\d+)\s*$/.exec(name);
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === '#' || ch === '♯' ? 1 : -1;
  // Not wrapped: B#3 is C4 and Cb4 is B3, which falls out of plain addition.
  return (Number(m[3]) + 1) * 12 + pc;
}
