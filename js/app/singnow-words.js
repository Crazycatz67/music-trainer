// singnow-words.js — the Sing page's pure numbers and words: the view constants, the
// sentences it shows, and the small formatters (clock, percent, the slider words, the
// words-band moves). Moved out of singnow.js unchanged (card S1, slice 1) so the page file
// is smaller; singnow.js imports these back and re-exports every name it exported before,
// so no importer changed.
//
// Why a separate file: nothing here touches the DOM, audio or storage, so it imports in Node
// with no browser globals and the checks can reach it without booting the page.
//
// The names that were private to singnow.js (VIEW, the *_WORDS tables, clamp, ...) are
// exported in the list at the bottom, so every moved line stays byte-for-byte as it was.

import { displayNote, verdict } from './stage.js';
import { SONG } from './song/config.js';
import { LEVEL_WORDS, foldCents } from './song/lineresults.js';

// ---------------------------------------------------------------- numbers and words

const VIEW = Object.freeze({
  windowSec: 8,            // seconds of song across the stage (spec 5.2)
  nowFrac: 0.3,            // the now line, from the left
  padNotes: 3,             // notes shown above and below the song's range
  trailSec: 4,             // how much of the owner's own line is kept behind the now line
  // A pitch frame is the middle of a window that ended a moment ago, heard through the
  // microphone's own delay: the point is drawn this far behind "now".          GUESS
  voiceLagSec: 0.06,
  readoutMs: 160,          // the words beside the now line change no faster than this
  minTakeSec: 1,           // a shorter take is not kept                         GUESS
});
// What the old four-step control saved (0 to 3): read once, so a saved choice is kept.
const OLD_GUIDE_GAINS = Object.freeze([0, 0.25, 0.5, 1]);
const KEPT_BALANCES = 40;      // the balance is remembered for this many takes
// The count-in beads on the stage come only where the prompt says "Get ready": before a
// rest, never before a breath (phrases.js beadTimes has its own, shorter gap for the chart
// songs' click track).
const BEAD_CFG = Object.freeze({ ...SONG.phrases, beadGapSec: SONG.phrases.restSec });
const PREFS_KEY = 'music-trainer.singnow.v1';
const MODEL_CACHE = 'music-trainer-analyse-models-v1';     // separate.js fetchModelFile's default
const OCTAVE_WORDS = Object.freeze({
  '-1': 'You sing an octave below the singer. The song sounds the same.',
  0: 'You sing where the singer sings.',
  1: 'You sing an octave above the singer. The song sounds the same.',
});
const AUTHORS_WORDS = 'The words of a song belong to their authors. Here they are shown to you for singing, kept only in this browser on this Mac, and never put in this site’s code.';
export const LOOKUP_NOTICE = 'Looking up words sends the song’s title and artist to lrclib.net. Nothing else leaves this Mac: not the sound, not your voice.';
const KEPT_HERE = Object.freeze({
  true: 'Songs are read and kept in this browser only. To find the words, a song’s title and artist are sent to lrclib.net.',
  false: 'Nothing leaves this Mac. Songs are read and kept in this browser only.',
});
const NO_WORDS_YET = 'No words for this song yet. Check the title to look them up.';
const TAKE_END_WORDS = Object.freeze({
  hidden: 'You left this window, so recording stopped and the microphone turned off. Your take is kept.',
  left: 'You left this window, so recording stopped and the microphone turned off. Your take is kept.',
  'mic-off': 'The microphone went away, so recording stopped. Your take is kept.',
  limit: 'Takes stop at 15 minutes. This one is kept.',
  seek: 'The take ended at the jump. It is kept.',
  pause: 'The take ended at the pause. It is kept.',
});
const START_WORDS = Object.freeze({
  'no-microphone': 'The microphone did not turn on, so nothing is being recorded.',
  busy: 'A take is already being recorded.',
  'no-song': 'Open a song first.',
  stopped: 'Stopped before the recording began.',
  failed: 'Recording could not start. Try again.',
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// THE verdict of one reading on this page: 'in' | 'close' | 'off' against the singer with
// whole octaves taken out, 'free' while the singer rests (cents null). The voice line, its
// light, the readout's colour and the line stars all use it, so an octave under the singer
// is drawn and counted as the tune sung right (sky spec 1.3). The readout's WORDS still read
// the raw distance, so it can say "One octave lower than the singer".
export const kindOf = (cents) => (cents === null || !Number.isFinite(cents) ? 'free' : verdict(foldCents(cents)).kind);
export const clock = (sec) => { const s = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const lengthWords = (sec) => { const s = Math.max(0, Math.round(sec || 0)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
// Never a figure finer than 5 seconds (spec 4.2).
export const aboutLeft = (sec) => {
  if (!Number.isFinite(sec) || sec === null) return 'working out how long…';
  if (sec > 90) return `about ${Math.round(sec / 60)} minutes left`;
  return `about ${Math.max(5, Math.round(sec / 5) * 5)} seconds left`;
};
export const rangeWords = (range) => {
  if (!range) return 'No tune traced';
  const lo = displayNote(range.lowest), hi = displayNote(range.highest);
  return lo && hi ? `Runs ${lo.text} to ${hi.text}` : 'No tune traced';
};
export const nudgeWords = (ms) => (ms === 0 ? 'as recorded' : ms > 0 ? `${ms} ms later` : `${-ms} ms earlier`);
export const percent = (level) => Math.round(Math.min(1, Math.max(0, Number(level) || 0)) * 100);
// The singer's own voice under the backing, in words (the number is shown beside them).
export const guideWords = (level) => (percent(level) === 0 ? 'Off: true karaoke' : level <= 0.35 ? 'Quiet: helps you find the tune' : level <= 0.7 ? 'Clear: the singer beside the band' : 'Loud: the singer leads');
// The backing track's level in words. 0 is the owner's "acapella version": the singer alone,
// but only while the singer is heard: `singer` is what the Singer slider lets through (0 for a
// song with no separate singer), or Music at 0 would claim a voice that is not playing
// (design review 2026-10-14, finding 2). Called with one argument it keeps its old answer.
export const musicWords = (level, singer = 1) => (percent(level) === 0 ? (percent(singer) > 0 ? 'Off: only the singer is heard' : 'Off: nothing will play') : level < 0.5 ? 'Quiet' : level < 1 ? 'Clear' : 'Full');
// The quick buttons, left to right, under the Music and Singer sliders.
export const MIX_ORDER = Object.freeze(['music', 'both', 'singer']);
// Why nothing at all is heard, or '' when something is: Volume at 0, or Music at 0 with the
// singer off or absent. Volume's row says it, so a silent song is never a silent mystery.
export function silentWords({ music, singer, volume }, hasGuide = true) {
  if (percent(volume) === 0) return 'Nothing to hear: Volume is at 0';
  if (percent(music) > 0 || (hasGuide && percent(singer) > 0)) return '';
  return hasGuide ? 'Nothing to hear: Music and Singer are at 0' : 'Nothing to hear: Music is at 0 and this song has no separate singer';
}
export const gainsWords = (g) => `Song ${percent(g.backing)} % · My voice ${percent(g.voice)} %`;
// A saved level, whichever version saved it: `level` (0..1) wins, else the old step (0..3).
export function keptGuide(level, oldStep, fallback) {
  if (Number.isFinite(level)) return Math.min(1, Math.max(0, level));
  return Number.isInteger(oldStep) && OLD_GUIDE_GAINS[oldStep] !== undefined ? OLD_GUIDE_GAINS[oldStep] : fallback;
}
// Which row of the words band a new current line comes from. 'roll': the line that was
// waiting under it slides up and grows; 'fade': a cross-fade in place (a jump in the song,
// the first line, or calm motion); 'stay': nothing changed.
export const bandMove = (was, now, calm) => (was.cur === now.cur ? 'stay' : !calm && now.cur !== null && was.next === now.cur ? 'roll' : 'fade');
// How visible the marker under a line is: it eases in after the line starts and out before
// it ends, so its return to the left is never seen.
export const markerEnvelope = (t, line, fadeSec) => (!line || !(fadeSec > 0) ? 1 : Math.min(1, Math.max(0, Math.min((t - line.t) / fadeSec, (line.end - t) / fadeSec))));
// The quiet line under the sliders: what the automatic lookup did for the open song.
//   words: the song's words (or null); auto: this visit's lookup of it, { state, result }
//   (or null); on: the "Look up words automatically" switch.
//   -> { kind: 'credit' (words from LRCLIB or the file: say so, offer Change) |
//              'looking' | 'none' (no words: the sentence and a title to correct) | 'hidden', text }
// With the switch off a lookup that found nothing says nothing: that is the press-only page.
export function autoLine({ words = null, auto = null, on = true } = {}) {
  if (words) return words.credit && (words.route === 'lookup' || words.route === 'file') ? { kind: 'credit', text: words.credit } : { kind: 'hidden', text: '' };
  if (auto && auto.state === 'looking') return on || auto.pressed ? { kind: 'looking', text: 'Looking up the words…' } : { kind: 'hidden', text: '' };
  if (!on && !(auto && auto.pressed)) return { kind: 'hidden', text: '' };
  if (auto && auto.result && auto.result.status === 'none') return { kind: 'none', text: auto.result.say || NO_WORDS_YET };
  return { kind: 'none', text: NO_WORDS_YET };
}
export const balanceWords = (b) => (b <= 0.02 ? 'Only the song' : b < 0.45 ? 'Mostly the song' : b <= 0.55 ? 'Both at full' : b < 0.98 ? 'Mostly my voice' : 'Only my voice');
const dateWords = (iso) => { try { return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
// A line star's name, for its title and for a screen reader: never colour alone.
export const starLabel = (r, source = 'words') => `${source === 'words' ? 'Line' : 'Phrase'} ${r.i + 1} · ${clock(r.t)} · ${LEVEL_WORDS[r.level] || ''}`;
// The first words of a line for the end panel, cut with an ellipsis.
export const firstWords = (text, max = SONG.lineStars.wordsMaxLetters) => { const t = String(text || '').trim(); return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`; };
// A take that ended one of these ways may have its shooting star (sky spec 2.5); one ended
// by leaving the window or by the microphone going away may not.
export const CELEBRATE_ENDS = Object.freeze(['stop', 'ended', 'limit']);
// Index of the first entry of a rising list that is >= t.
function firstAtOrAfter(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

// Private to the Sing page before the move: exported only for singnow.js.
export { VIEW, OLD_GUIDE_GAINS, KEPT_BALANCES, BEAD_CFG, PREFS_KEY, MODEL_CACHE, OCTAVE_WORDS, AUTHORS_WORDS, KEPT_HERE, NO_WORDS_YET, TAKE_END_WORDS, START_WORDS, clamp, dateWords, firstAtOrAfter };
