// ownvoicekey.js — where the singer's own-voice record is kept, and how it is read back.
//
// Why a module of its own, with NO imports: Settings (shell.js) needs to know whether a voice
// is saved, and backup.js needs to read it. Taking these from ownvoice.js pulled in the FFT
// and made a circle (ownvoice.js imports shell.js, which imported ownvoice.js). Nothing here
// may import anything, so any module can use it at any point while the app loads.
//
// CONTRACT
//   OWNVOICE_KEY   'music-trainer.ownvoice.v1' -> { v: 1, timbre, midi, hnrDb, at }
//       Written out, not built from shell.js STORAGE_PREFIX (see above). "Erase everything"
//       removes it by that prefix.
//   OWNVOICE_VERSION  1;  OWNVOICE_MAX_STORED  16 (the longest timbre list accepted)
//   playableTimbre(t) -> boolean   1..16 finite numbers in 0..1, at least one above 0
//   readOwnVoice(storage) -> { v, timbre, midi | null, hnrDb | null, at | null } | null
//       null for nothing saved, another version, or anything that is not a playable timbre.
//       Never throws.

export const OWNVOICE_KEY = 'music-trainer.ownvoice.v1';
export const OWNVOICE_VERSION = 1;
export const OWNVOICE_MAX_STORED = 16;

export const playableTimbre = (t) => Array.isArray(t) && t.length >= 1 && t.length <= OWNVOICE_MAX_STORED
  && t.every((a) => typeof a === 'number' && Number.isFinite(a) && a >= 0 && a <= 1) && t.some((a) => a > 0);

export function readOwnVoice(storage) {
  let raw = null;
  try { raw = JSON.parse((storage && storage.getItem(OWNVOICE_KEY)) || 'null'); } catch { return null; }
  // Another version, or hand-edited into something the synth would choke on: as if not taught.
  if (!raw || typeof raw !== 'object' || raw.v !== OWNVOICE_VERSION || !playableTimbre(raw.timbre)) return null;
  return {
    v: OWNVOICE_VERSION, timbre: [...raw.timbre], midi: Number.isFinite(raw.midi) ? raw.midi : null,
    hnrDb: Number.isFinite(raw.hnrDb) ? raw.hnrDb : null, at: typeof raw.at === 'string' ? raw.at : null,
  };
}
