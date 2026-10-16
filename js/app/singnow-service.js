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
//   service.setAutoWords(on)    the "Look up words automatically" switch: sets, saves, tells
//              every onPrefs listener (the open screen repaints its notice and words line)
//   service.onPrefs(fn) -> off  fn(prefs) after setAutoWords
//   service.watchMic(micflow) -> off   hold the analysis queue while that micflow's phase is
//              waiting, checking or on (spec 3.4: analysis and the pitch tracker share the
//              main thread). Once per micflow: a second call for the same one is a no-op.
//   service.held() -> boolean   the queue is holding now
//   service.readyCount() -> n   songs being got ready: queued + running + held
//   service.onReady(fn) -> off  fn(n) whenever readyCount may have changed (the Lyre's line 3,
//              skyroutes.js lyreLine)
//
//   createQueueHold({ jobs, dropped }) -> { hold(on), held(), parked(), lostSec() }   PURE
//       (no DOM; tools/checks/songservice.check.mjs). hold(true): every queued or running job
//       whose file is in `dropped` is cancelled and parked in queue order (its dropped entry
//       goes with it); a job that starts while held is parked behind them. hold(false): the
//       parked files are added back, first in line, in the same order, their dropped entries
//       re-keyed to the new job ids, and jobs.go() runs if the model is ready.
//       lostSec(): seconds of work thrown away by the last park (progress * etaSec of a
//       running job, roughly); the spec asks to report it when over about 30 s.
//   songsSettings({ storage, service }) -> render(el)   the Settings "Songs" part for
//       shell.registerSettingsSection('songs', 'Songs', ...). service: the service, a function
//       returning it (or null), or null; without one the switch reads and writes the prefs
//       key in storage directly, so it works before the first visit to Songs.
// Never throws on construction: unreadable prefs fall back to the defaults.

import { SONG } from './song/config.js';
import { createSongStore, idbSongBackend, loadDemoSongs } from './song/songstore.js';
import { createTakeStore, idbBackend } from './song/takes.js';
import { songMix } from './song/mix.js';
import { createLookup } from './song/words.js';
import { createWordsCache } from './song/autowords.js';
import { createJobs, loadTools } from './analyse/job.js';
import { MODELS } from './analyse/models.js';
import { keptGuide, PREFS_KEY, clamp } from './singnow-words.js';
import { switchRow } from './shell.js';

// A slider being dragged changes the levels up to 60 times a second; writing the whole
// settings record each time is wasted work, so a drag asks for a save this long after the
// last move, and letting go, closing the song and leaving the screen write it at once.
const PREFS_SAVE_MS = 300;
const AURORA_MAX = 96;
// The microphone phases during which a pitch tracker runs (or is about to): micflow.js.
const LIVE_MIC = new Set(['waiting', 'checking', 'on']);
const AUTO_WORDS_NOTE = 'On: when you add a song, its title and artist are sent to lrclib.net to find the words. Off: nothing is sent until you press “Look up the words” yourself.';

export function createQueueHold({ jobs, dropped }) {
  let isHeld = false, parking = false, lost = 0;
  const parked = [];
  const live = (j) => j.status === 'running' || j.status === 'queued';
  function park() {
    if (parking) return;
    parking = true;
    try {
      for (const j of jobs.state().jobs) {
        const d = live(j) && dropped.get(j.id);
        // Without its file a job cannot be put back, so it is left to run.
        if (!d) continue;
        if (j.status === 'running') lost += (Number(j.progress) || 0) * (Number(j.etaSec) || 0);
        parked.push(d);
        dropped.delete(j.id);
        jobs.cancel(j.id);
      }
    } finally { parking = false; }
  }
  // Catches a song dropped (or a queued one started) while the hold is on.
  jobs.on((e) => { if (isHeld && e.type === 'state') park(); });
  return {
    hold(on) {
      on = !!on;
      if (on === isHeld) return;
      isHeld = on;
      if (on) { lost = 0; park(); return; }
      const back = parked.splice(0);
      if (!back.length) return;
      const ids = jobs.add(back.map((d) => d.file));
      ids.forEach((id, i) => dropped.set(id, back[i]));
      if (jobs.state().tools === 'ready') jobs.go();
    },
    held: () => isHeld,
    parked: () => parked.length,
    lostSec: () => lost,
  };
}

function readAutoWords(storage) {
  try {
    const v = JSON.parse((storage && storage.getItem(PREFS_KEY)) || '{}').autoWords;
    return typeof v === 'boolean' ? v : SONG.words.autoLookup;
  } catch { return SONG.words.autoLookup; }
}
function writeAutoWords(storage, on) {
  try {
    const rec = JSON.parse((storage && storage.getItem(PREFS_KEY)) || '{}') || {};
    rec.autoWords = !!on;
    if (storage) storage.setItem(PREFS_KEY, JSON.stringify(rec));
  } catch { /* unreadable, full or blocked: the switch still shows the choice this visit */ }
}

export function songsSettings({ storage = null, service = null } = {}) {
  const svc = () => (typeof service === 'function' ? service() : service) || null;
  return (el) => {
    const s = svc();
    el.append(switchRow({ label: 'Look up words automatically', value: s ? s.prefs.autoWords : readAutoWords(storage), note: AUTO_WORDS_NOTE,
      onChange: (v) => { const now = svc(); if (now) now.setAutoWords(v); else writeAutoWords(storage, v); } }));
  };
}

export function createSongService({ storage = null, hooks = {} } = {}) {
  const query = new URLSearchParams(hooks.query ?? location.search);

  // ---- the stores and the analysis queue (nothing is fetched until jobs.go())
  const takes = createTakeStore({ backend: idbBackend({ name: hooks.takeDb }) });
  // The bundled public-domain charts (songs/demo) are the Demo songs group (bug 84): read
  // from this site's own folder the first time the list is painted, never stored. A lab may
  // hand in its own (hooks.demo, async () -> [timeline]) or none (hooks.demo === null).
  const demoBase = new URL('../../songs/demo/', import.meta.url).href;
  const demo = hooks.demo !== undefined ? hooks.demo
    : () => loadDemoSongs({ base: demoBase, fetchText: async (url) => { const r = await window.fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); } });
  const store = createSongStore({ backend: idbSongBackend({ name: hooks.songDb }), takes, demo });
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

  const prefsFns = new Set();
  const setAutoWords = (on) => { prefs.autoWords = !!on; savePrefs(); for (const fn of [...prefsFns]) fn(prefs); };

  const dropped = new Map();
  const hold = createQueueHold({ jobs, dropped });
  const readyFns = new Set();
  const readyCount = () => jobs.state().jobs.filter((j) => j.status === 'running' || j.status === 'queued').length + hold.parked();
  const tellReady = () => { const n = readyCount(); for (const fn of [...readyFns]) fn(n); };
  jobs.on((e) => { if (e.type === 'state') tellReady(); });
  const watched = new Map();
  function watchMic(micflow) {
    if (!micflow || typeof micflow.subscribe !== 'function') return () => {};
    if (watched.has(micflow)) return watched.get(micflow);
    const look = (st) => { hold.hold(LIVE_MIC.has(st && st.phase)); tellReady(); };
    const offSub = micflow.subscribe(look);
    if (typeof micflow.state === 'function') look(micflow.state());
    const off = () => { offSub(); watched.delete(micflow); hold.hold(false); tellReady(); };
    watched.set(micflow, off);
    return off;
  }

  return {
    storage, store, takes, jobs, lookup, netFetch, wordsCache, modelBase,
    dropped,                 // job id -> { file, tags: Promise } until its song is saved
    dropping: new Set(),     // song ids whose drop is still naming them and finding their words
    autos: new Map(),        // song id -> { state: 'looking' | 'done', result, asked: Set(songKey), pressed, tried }
    prefs, mixFor, savePrefs, savePrefsSoon, flushPrefs,
    setAutoWords, onPrefs(fn) { prefsFns.add(fn); return () => prefsFns.delete(fn); },
    watchMic, held: () => hold.held(), readyCount,
    onReady(fn) { readyFns.add(fn); return () => readyFns.delete(fn); },
    keepAurora(samples) { aurora = Array.isArray(samples) ? samples.slice(-AURORA_MAX) : null; },
    aurora: () => aurora,
  };
}
