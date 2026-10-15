// singnow-service.js — the part of song mode that lives as long as the app, not one visit
// to the Songs screen (page-layout spec 3.4). The screen (mountSongs in singnow.js) is made
// and destroyed on every visit; what it must not lose when the person leaves sits here:
// the song and take stores (the recorder's last write lands after the screen is gone), the
// analysis queue (a song being analysed keeps going), the word lookup and its cache (a song
// is asked about once per page), and the prefs record.
//
// CONTRACT
//   createSongService({ storage, hooks }) -> service
//     storage  a localStorage-like object or null (prefs and the words cache kept in memory)
//     hooks    the singnow hooks (singnow.js CONTRACT): reads songDb, takeDb, loadTools,
//              fetch, query. Nothing else.
//   service.store, .takes, .jobs        the song store, take store, analysis queue
//   service.lookup, .netFetch, .wordsCache   the pressed lookup, the fetch the automatic
//              lookup uses, its cache
//   service.dropped   Map jobId -> { file, tags }   (a drop outlives the screen with its job)
//   service.dropping  Set songId                     (still naming / finding words)
//   service.autos     Map songId -> automatic-lookup state
//   service.prefs     the prefs record, already normalised (mixes, ways, balances,
//              guideLevel, volume, autoWords, wordsNoticeSeen). Mutate it, then save.
//   service.mixFor(songId | null) -> { music, singer, volume }
//   service.savePrefs()      write now (clears a waiting write)
//   service.savePrefsSoon()  write PREFS_SAVE_MS after the last call (slider drags)
//   service.flushPrefs()     write now only if a write is waiting
//   service.modelBase(id) -> URL of the model files (?models=local: the repo's cache)
//   service.keepAurora(samples | null), service.aurora()   the last take's aurora samples
//              (<= 96 { midi, lv, kind }, memory only), for the home's replay (slice 4)
//   service.storage   the storage it was given
// Never throws on construction: unreadable prefs fall back to the defaults.

import { SONG } from './song/config.js';
import { createSongStore, idbSongBackend } from './song/songstore.js';
import { createTakeStore, idbBackend } from './song/takes.js';
import { songMix } from './song/mix.js';
import { createLookup } from './song/words.js';
import { createWordsCache } from './song/autowords.js';
import { createJobs, loadTools } from './analyse/job.js';
import { MODELS } from './analyse/models.js';
import { keptGuide, PREFS_KEY, clamp } from './singnow-words.js';

// A slider being dragged changes the levels up to 60 times a second; writing the whole
// settings record each time is wasted work, so a drag asks for a save this long after the
// last move, and letting go, closing the song and leaving the screen write it at once.
const PREFS_SAVE_MS = 300;
const AURORA_MAX = 96;

export function createSongService({ storage = null, hooks = {} } = {}) {
  const query = new URLSearchParams(hooks.query ?? location.search);

  // ---- the stores and the analysis queue (nothing is fetched until jobs.go())
  const takes = createTakeStore({ backend: idbBackend({ name: hooks.takeDb }) });
  const store = createSongStore({ backend: idbSongBackend({ name: hooks.songDb }), takes });
  const localModels = query.get('models') === 'local';
  const modelBase = localModels ? (id) => new URL(`../../tools/.cache/models/${MODELS[id].dir}/`, import.meta.url).href : (id) => MODELS[id].base;
  const jobs = createJobs({ store, loadTools: hooks.loadTools || ((o) => loadTools({ ...o, modelBase })) });
  const lookup = createLookup(hooks.fetch ? { fetch: hooks.fetch } : {});
  // The automatic lookup (autowords.js). One cache for the page: a song is asked about once.
  const netFetch = hooks.fetch || ((...a) => window.fetch(...a));
  const wordsCache = createWordsCache({ storage });

  // guideLevel and volume are 0..1; balances is { takeId: 0..1 }, the newest KEPT_BALANCES.
  // autoWords: the "Look up words automatically" switch. wordsNoticeSeen: the notice about
  // it has been read (Got it) or a first lookup has gone out under it.
  const prefs = { volume: SONG.levels.volume, balances: {}, autoWords: SONG.words.autoLookup, wordsNoticeSeen: false };
  try { Object.assign(prefs, JSON.parse((storage && storage.getItem(PREFS_KEY)) || '{}')); } catch { /* keep the defaults */ }
  prefs.guideLevel = keptGuide(prefs.guideLevel, prefs.guide, SONG.levels.guide);
  delete prefs.guide;
  prefs.volume = clamp(Number.isFinite(Number(prefs.volume)) ? Number(prefs.volume) : SONG.levels.volume, 0, 1);
  if (!prefs.balances || typeof prefs.balances !== 'object') prefs.balances = {};
  // mixes is { songId: { music, singer, volume } }: the three sliders, kept for each song
  // (owner 2026-10-13). guideLevel and volume above are what the page kept before that,
  // one pair for every song: they are now only where a song with no mix of its own starts,
  // and the sliders no longer write them.
  if (!prefs.mixes || typeof prefs.mixes !== 'object' || Array.isArray(prefs.mixes)) prefs.mixes = {};
  // The ways to sing, per song: { [songId]: { noLine?, noGuide? } } (grades spec 10.1).
  if (!prefs.ways || typeof prefs.ways !== 'object' || Array.isArray(prefs.ways)) prefs.ways = {};
  prefs.autoWords = typeof prefs.autoWords === 'boolean' ? prefs.autoWords : SONG.words.autoLookup;
  prefs.wordsNoticeSeen = prefs.wordsNoticeSeen === true;
  const mixFor = (id) => songMix(id === null ? null : prefs.mixes[id], { music: SONG.levels.music, singer: prefs.guideLevel, volume: prefs.volume });

  // Any direct save clears the one waiting.
  let prefsTimer = 0;
  const savePrefs = () => { clearTimeout(prefsTimer); prefsTimer = 0; try { if (storage) storage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* full or blocked */ } };
  const savePrefsSoon = () => { clearTimeout(prefsTimer); prefsTimer = setTimeout(savePrefs, PREFS_SAVE_MS); };
  const flushPrefs = () => { if (prefsTimer) savePrefs(); };

  let aurora = null;

  return {
    storage, store, takes, jobs, lookup, netFetch, wordsCache, modelBase,
    dropped: new Map(),      // job id -> { file, tags: Promise } until its song is saved
    dropping: new Set(),     // song ids whose drop is still naming them and finding their words
    autos: new Map(),        // song id -> { state: 'looking' | 'done', result, asked: Set(songKey), pressed, tried }
    prefs, mixFor, savePrefs, savePrefsSoon, flushPrefs,
    keepAurora(samples) { aurora = Array.isArray(samples) ? samples.slice(-AURORA_MAX) : null; },
    aurora: () => aurora,
  };
}
