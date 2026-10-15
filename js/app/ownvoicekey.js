// ownvoicekey.js — where the singer's own-voice record is kept, and how it is read back.
//
// Why a module of its own, with NO imports: Settings (shell.js) needs to know whether a voice
// is saved, and backup.js needs to read it. Taking these from ownvoice.js pulled in the FFT
// and made a circle (ownvoice.js imports shell.js, which imported ownvoice.js). Nothing here
// may import anything, so any module can use it at any point while the app loads.
//
// What is kept is the voice's tone colour only, never a recording (owner, 2026-10-15): a
// spectral envelope, dB at ENVELOPE_HZ.length fixed frequencies. Kept by Hz rather than by
// harmonic number so the colour stays put at every pitch (a voice's resonances do not move
// with the note); js/synth.js samples it at k x f0 for any note.
//
// CONTRACT
//   OWNVOICE_KEY   'music-trainer.ownvoice.v1' -> { v: 2, envelope, midi, hnrDb, at }
//       The key keeps its old name (backup.js and "Erase everything", which removes it by the
//       shell.js STORAGE_PREFIX, already know it); the record inside says its version.
//       envelope   [[hz, dB], ...] at ENVELOPE_HZ, dB relative to the strongest point (0),
//                  one decimal, never below ENVELOPE_FLOOR_DB
//   OWNVOICE_VERSION  2;  ENVELOPE_HZ  20 fixed Hz, 100..5000, evenly spaced in log Hz
//   OWNVOICE_MAX_STORED  16 (the longest v1 harmonic list accepted)
//   playableTimbre(t) -> boolean      1..16 finite numbers in 0..1, at least one above 0 (v1)
//   playableEnvelope(e) -> boolean    2..32 [hz, dB] pairs, hz rising in 20..24000, dB finite
//                                     in -100..20, at least one point above the floor
//   envelopeFromHarmonics(amps, f0Hz) -> envelope    amps: harmonic amplitudes, index 0 = f0
//       Each harmonic k sits at k x f0 Hz; between them dB is straight in log Hz; below f0 it
//       holds the fundamental's level; above the last harmonic it falls 12 dB an octave (a
//       voice's natural roll-off). A harmonic of 0 (lost in the noise) counts as the floor.
//   readOwnVoice(storage) -> { v: 2, envelope, midi | null, hnrDb | null, at | null } | null
//       null for nothing saved, an unknown version, or anything unplayable. A v1 record
//       (harmonic amplitudes at `midi`) is CONVERTED on read, not asked for again: its midi
//       says where the harmonics sat in Hz. A v1 record with no midi reads as nothing.
//       Never throws.

export const OWNVOICE_KEY = 'music-trainer.ownvoice.v1';
export const OWNVOICE_VERSION = 2;
export const OWNVOICE_MAX_STORED = 16;
export const ENVELOPE_FLOOR_DB = -60;
export const ENVELOPE_HZ = Object.freeze(Array.from({ length: 20 }, (_, i) => Math.round(100 * 50 ** (i / 19))));

const num = (x) => typeof x === 'number' && Number.isFinite(x);

export const playableTimbre = (t) => Array.isArray(t) && t.length >= 1 && t.length <= OWNVOICE_MAX_STORED
  && t.every((a) => num(a) && a >= 0 && a <= 1) && t.some((a) => a > 0);

export const playableEnvelope = (e) => Array.isArray(e) && e.length >= 2 && e.length <= 32
  && e.every((p, i) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]) && p[0] >= 20 && p[0] <= 24000
    && p[1] >= -100 && p[1] <= 20 && (i === 0 || p[0] > e[i - 1][0]))
  && e.some((p) => p[1] > ENVELOPE_FLOOR_DB);

export function envelopeFromHarmonics(amps, f0Hz) {
  const top = Math.max(...amps);
  const dB = amps.map((a) => Math.max(ENVELOPE_FLOOR_DB, 20 * Math.log10(Math.max(a / top, 1e-3))));
  const last = dB.length - 1, lastHz = (last + 1) * f0Hz;
  const at = (hz) => {
    if (hz <= f0Hz) return dB[0];
    if (hz >= lastHz) return dB[last] - 12 * Math.log2(hz / lastHz);
    const k = hz / f0Hz - 1, i = Math.floor(k);           // between harmonics i+1 and i+2
    const w = Math.log2(hz / ((i + 1) * f0Hz)) / Math.log2((i + 2) / (i + 1));
    return dB[i] + (dB[i + 1] - dB[i]) * w;
  };
  return ENVELOPE_HZ.map((hz) => [hz, Math.round(10 * Math.max(ENVELOPE_FLOOR_DB, at(hz))) / 10]);
}

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
const extra = (raw) => ({
  midi: num(raw.midi) ? raw.midi : null, hnrDb: num(raw.hnrDb) ? raw.hnrDb : null, at: typeof raw.at === 'string' ? raw.at : null,
});

export function readOwnVoice(storage) {
  let raw = null;
  try { raw = JSON.parse((storage && storage.getItem(OWNVOICE_KEY)) || 'null'); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v === OWNVOICE_VERSION && playableEnvelope(raw.envelope)) {
    return { v: OWNVOICE_VERSION, envelope: raw.envelope.map(([hz, db]) => [hz, db]), ...extra(raw) };
  }
  // The first "My voice" (2026-10-13) kept harmonic amplitudes at the taught note: placed in Hz
  // by that note, they give the same colour, so the singer need not teach it again.
  if (raw.v === 1 && playableTimbre(raw.timbre) && num(raw.midi) && raw.midi > 20 && raw.midi < 110) {
    return { v: OWNVOICE_VERSION, envelope: envelopeFromHarmonics(raw.timbre, midiHz(raw.midi)), ...extra(raw) };
  }
  // Another version, or hand-edited into something the synth would choke on: as if not taught.
  return null;
}
