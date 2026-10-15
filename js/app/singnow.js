// singnow.js — "Sing a song", a first working version of song mode on one standalone page
// (sing.html). It is the screens half over the song core: js/app/analyse/job.js (drop a
// file -> a kept song), js/app/song/* (store, phrases, words, player, recorder, align, mix,
// takes) and js/app/transport.js. The design it leans on is
// docs/design/specs/2026-10-12-song-mode.md sections 4, 5, 6, 8 and 9; where the two
// differ this file is the simpler one (one page, no library groups).
// THE SKY (docs/design/specs/2026-10-13-sing-page-sky.md): the aurora curtain under the
// owner's voice line (js/app/aurora.js; the Settings switch "Aurora on your voice line",
// calm motion and the guard all apply), a star for each line sung with the singer or close
// to them (the rule is song/lineresults.js; octave-folded, so an octave away counts), and
// after a run the end panel, the shooting star and one chime. While the microphone is
// judged nothing flies and nothing sounds: every one of those comes after release().
//
// WHAT WAITS FOR A PRESS (owner rule 2026-10-12). Loading the page opens no microphone,
// makes no AudioContext, plays nothing and fetches no model or runtime file.
//   - The AudioContext is made by the press that opens a song.
//   - The listening model is fetched by "Download ... and analyse" (jobs.go()); when every
//     model file is already in this browser's cache the drop itself starts the work, since
//     nothing is then downloaded.
//   - The microphone is asked for only by Sing, Record a take, or the same buttons pressed
//     again after a pause. It opens on that press; the song then waits for the count
//     (3, 2, 1: SONG.countIn.startSec) before it moves. This file has no getUserMedia call: the one call site stays
//     js/mic.js, reached through js/app/micflow.js (its sheets, chip and banners).
//   - Headphones must be confirmed first (the shell's own question, shell.needHeadphones()).
// WHAT LEAVES THIS MAC: only a song's title and artist, to lrclib.net, to find its words
//   (owner decision 2026-10-13). With "Look up words automatically" on (Settings; the
//   default, SONG.words.autoLookup; saved) that one request goes out by itself when a
//   dropped song has been analysed and has no words: song/autowords.js, first the words
//   stored in the file itself, then the search. A song from an earlier visit that has no
//   words and was never asked about is looked up the same way when it is opened (owner,
//   2026-10-13), from its stored title, artist and file name: still one request per song
//   ("nothing found" is remembered). The library says so in a notice before the
//   first lookup. With the switch off nothing is asked until "Look up the words" is pressed
//   in the Words sheet. Either way the song is singable at once: the lookup never opens a
//   sheet, and when it finds nothing the screen shows the cues with one quiet strip under
//   the words band (a title to correct: one more lookup per new title).
// WHAT RELEASES THE MICROPHONE, every track, at once: Pause, Esc, Stop, the song ending,
//   Space, K or Esc during the count (the song then never starts),
//   any sheet opening (words, settings, rename, confirm), the page hidden, the page left,
//   going back to My songs, and a take ending for any reason. A recording that is running
//   is ended first and what was sung is KEPT (the recorder writes it to the take store
//   while recording). Nothing turns the microphone back on by itself.
//
// CONTRACT
//   bootSingNow(root, hooks?) -> app
//     root   the element the screen is drawn into. The page must also hold the shell's
//            pieces (#view, #mic-chip, #headphones-chip, #settings-button), as sing.html does.
//     hooks  for the lab only (labs/singnow-lab.js); also read from window.__singnowHooks.
//            Nothing in sing.html sets any of them.
//       loadTools  async ({ onProgress }) -> tools     a stand-in for the listening model
//       cached     boolean: say whether "the model is already here" (with loadTools)
//       songDb, takeDb   IndexedDB names, so a lab never touches the owner's songs
//       storage    a localStorage stand-in (null: keep settings in memory only)
//       silent     true: everything plays into a gain of 0
//       onAudio    ({ ctx, player }) called once, when the first press makes the audio
//       saveFile   (ArrayBuffer, name) instead of the browser's download
//       fetch      the fetch the words lookups use (the pressed one and the automatic one)
//       query      stands in for the page's address query (a framed page has none)
//   app.state() -> { mode: 'library' | 'sing' | 'review' | 'tap', songId, status (the
//       player's), singing, recording, mic (micflow phase), audio (AudioContext state, null
//       before the first press), lamp, octave, lines, words, tools,
//       count: null | { kind: 'start' (after the press, the song waits; take: boolean) |
//                       'phrase' (the song runs, a phrase is coming), seconds, of },
//       guide, volume, music (0..1, the open song's sliders), mix (the quick setting they are at: 'singer' | 'music' | 'both' | null),
//       band: { cur, next, cued } (the words band),
//       autoWords (the switch), auto: null | { state: 'looking' | 'done', status, why,
//       searched, fromCache, source } (the open song's automatic lookup),
//       stageMs, auroraMs (the last frame's cost and the curtain's share), auroraCols,
//       auroraTier (the guard: 0 full, 1 wide columns, 2 off), lineDrawn, headDrawn, voiceKind,
//       ways: { noLine?, noGuide? } (the ways to sing on for the open song, grades spec 10),
//       stars: [{ i, level: 'with' | 'close' }] (the row as drawn),
//       end: null | { open, waiting (the shooting star is on its way), practice, best,
//                     with, close, sung, total, bestLine, practise } (the end panel),
//       loop: null | { start, end } (a line on repeat),
//       sky: { streaks, micAtStreak, chimes, lastChime: [MIDI] } }
//   A take's line results are saved with it: takes meta `lines` (lineresults.js summarise).
//   A new best is saved with the song: `bestLines: { with, total, takeId, at }`.
//   app.autos() -> { songId: the same shape }     every lookup of this visit
//   app.player / app.recorder / app.transport / app.micflow / app.store / app.takes / app.settings /
//   app.jobs       the live objects (player, recorder and transport are null until a song opens)
//   app.openSong(id), app.closeSong(), app.addFiles(files)   what the buttons call
//   Also on window.__singnow, for the lab and for looking at a problem in the console.
//   bootSingNow is now a thin wrapper (page-layout spec 3.4): its own shell + micflow +
//   createSongService (singnow-service.js) + mountSongs.
//   mountSongs(view, { shell, micflow, settings, storage, service, songId?, go?, hooks? }) -> app
//     go(hash)  inside the app (index.html #/songs): Sing in the library and "My songs" in a
//               song change the address instead, and the shell remounts (spec 3.1). Without
//               it (sing.html) both stay inside the screen, as before.
//     songId    open this song ready and silent; one not saved here leaves the library up
//               with a quiet line
//     one visit to the screen; app.destroy() leaves in the spec's 6-step order (take ended
//     and kept, sound ramped out and closed, timers, listeners and micflow hooks off, nodes
//     outside the view removed, the take's aurora samples handed to service.keepAurora)
//     and deletes window.__singnow.
//
//   ?models=local   (address of the page) reads the model from tools/.cache/models/ on this
//                   computer instead of the pinned public addresses: for test runs.
//
// TIME is seconds of song (the backing track's clock). PITCH is MIDI floats; cents are
// 100 * (sung - target). The target is the singer's curve moved by 12 notes per octave step
// of the Octave control (display and judging only: the sound is never changed).

import { CONFIG } from './config.js';
import { confirmSheet, createSettings, h, icon, initShell, openSheet, segmented, sheetOpen, switchRow, toast } from './shell.js';
import { createMicFlow } from './micflow.js';
import { displayNote, numberText, verdict } from './stage.js';
import { SONG } from './song/config.js';
import { createSongStore, idbSongBackend, titleFromFile, titleFromTags } from './song/songstore.js';
import { createTakeStore, idbBackend } from './song/takes.js';
import { createPlayer } from './song/player.js';
import { createRecorder } from './song/recorder.js';
import { alignFrames } from './song/align.js';
import { balanceGains, createMixPlayback, downloadWav, exportMix, EXPORT_WORDS, keepSongMix, MIX_PRESETS, MIX_PRESET_WORDS, presetOf, songMix } from './song/mix.js';
import { encodeWav } from './song/pcm.js';
import { beadTimes, countdownAt, countInAt, lampAt, phraseAt } from './song/phrases.js';
import { createLookup, fitOffset, lineSpans, makeWords, markerAt, nudgeAll, parseLrc, parseWords, splitLongLines, stampLine } from './song/words.js';
import { autoWords, createWordsCache, fitByLine, songKey } from './song/autowords.js';
import { readTags } from './song/tags.js';
import { createTransport, lineIndexAt } from './transport.js';
import { createJobs, fileKind, loadTools, toolsNeeded, STEP_WORDS } from './analyse/job.js';
import { MODELS, megabytes } from './analyse/models.js';
import { curveAt } from './analyse/curve.js';
import { auroraSprites, createCurtain, drawCurtain, follow, isLightColour, levelToLv, sharedGuard, trailK } from './aurora.js';
import { LEVEL_WORDS, LEVEL_RANK, addReading, better, endChimePlan, foldCents, headingWords, heardToEnd, newBest, newCounts, reasonWords, scoreLines, settle, summarise } from './song/lineresults.js';
import { canChime, playChime, starSvg } from './rewards.js';
import { bestAny, readBests, retryNudge, saveBests, updateBests } from './song/grades.js';
import { letterWords, takeResults, takeWords } from './song/resultsmodel.js';
import { medallionModel, mountMedallion, wholePercent } from './song/medallion.js';
import { resultsView } from './song/resultsview.js';
import { createSynth } from '../synth.js';
import { createSongService } from './singnow-service.js';

// ---------------------------------------------------------------- numbers and words
// Moved to singnow-words.js (pure, Node-safe); every name this file exported is re-exported.
import { LOOKUP_NOTICE, kindOf, clock, lengthWords, aboutLeft, rangeWords, nudgeWords, percent, guideWords, musicWords, MIX_ORDER, silentWords, gainsWords, keptGuide, bandMove, markerEnvelope, autoLine, balanceWords, starLabel, firstWords, CELEBRATE_ENDS,
  VIEW, OLD_GUIDE_GAINS, KEPT_BALANCES, BEAD_CFG, PREFS_KEY, MODEL_CACHE, OCTAVE_WORDS, AUTHORS_WORDS, KEPT_HERE, NO_WORDS_YET, TAKE_END_WORDS, START_WORDS, clamp, dateWords, firstAtOrAfter } from './singnow-words.js';
export { LOOKUP_NOTICE, kindOf, clock, lengthWords, aboutLeft, rangeWords, nudgeWords, percent, guideWords, musicWords, MIX_ORDER, silentWords, gainsWords, keptGuide, bandMove, markerEnvelope, autoLine, balanceWords, starLabel, firstWords, CELEBRATE_ENDS };

// ---------------------------------------------------------------- the page

export function bootSingNow(root, given = {}) {
  const hooks = { ...(window.__singnowHooks || {}), ...given };
  let storage = null;
  if ('storage' in hooks) storage = hooks.storage;
  else { try { storage = window.localStorage; } catch { /* private mode: this visit only */ } }

  // ---- the shell's pieces: settings sheet, headphones question, microphone flow.
  // sing.html owns them; inside the app (#/songs) the app does, and mounts the screen alone.
  const settings = createSettings({ storage });
  const shell = initShell({ settings, routes: {} });
  const micflow = createMicFlow({ shell, settings, chipEl: document.getElementById('mic-chip') });
  const service = createSongService({ storage, hooks });
  return mountSongs(root, { shell, micflow, settings, storage, service, hooks });
}

// One visit to the Songs screen (spec 3.4). Everything made here is undone by destroy():
// the app's micflow and service outlive the screen, so a listener or frame hook left
// behind would keep a dead screen drawing during the next exercise.
export function mountSongs(root, { shell, micflow, settings, storage, service, songId = null, go: goTo = null, hooks: given = {} }) {
  // goTo, not go: the model download below is a hoisted `function go()` in this scope and
  // would shadow the option (then Sing ran the download instead of opening the song).
  const hooks = { ...(window.__singnowHooks || {}), ...given };
  if (storage === undefined) storage = service.storage;
  const { takes, store, jobs, lookup, netFetch, wordsCache, modelBase, dropped, dropping, autos, prefs, mixFor, savePrefs, savePrefsSoon, flushPrefs } = service;
  // With the switch off nothing is asked: only the words inside the file itself are read.
  const noSearch = async () => ({ ok: false, reason: 'not-found' });
  const noCache = { get() {}, set() {} };
  let noticeGone = prefs.wordsNoticeSeen;
  // Every document/window listener goes through on(), so destroy() can take each one off.
  const offs = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); offs.push(() => target.removeEventListener(type, fn, opts)); };

  // ---- what the screen is showing
  let mode = 'library';
  // The open song's own Music, Singer and Volume (0..1 each; song/mix.js songMix).
  let levels = mixFor(null);
  let ctx = null, player = null, recorder = null, transport = null;
  let song = null, curve = null, phrases = [], spans = [], bandSpans = [], lines = [], phraseMidi = [], octave = 0, hasGuide = false;
  let singing = false, micStarting = false, opening = false, everPlayed = false;
  // While a start is under way: which sheet is its own way in ('sheet-phones' while the
  // headphones question is asked, 'sheet-mic' while the microphone opens), '' for none.
  let ownSheet = '';
  let review = null, tap = null, hold = null;
  // The count after a press, while the song waits: { at (performance.now), sec, take, timer, resolve }.
  let count = null, countShown = null;
  let trail = [], lastRead = null, readAt = 0;
  // The aurora under the voice line (sky spec 1): lvNow is the smoothed loudness the next
  // trail point carries, lane the note range drawStage last used (the free colour's hue).
  let lvNow = null, lvAt = 0, lane = { lo: 52, hi: 70 };
  let stageMs = 0, auroraMs = 0, auroraCols = 0, auroraTier = 0, lineDrawn = 0, headDrawn = false;
  // Line stars (sky spec 2; the rule is song/lineresults.js).
  //   counting  line index -> the counts of a line being sung right now
  //   stars     line index -> the best result of this visit (a star only ever goes up)
  //   run       what this run settled: a take (saved with it) or the practice since the
  //             last end panel (saved nowhere): { results: Map, take, lastT }
  //   end       the end panel: { sum, open, practice, best (new best), timer }
  const LS = SONG.lineStars;
  let counting = new Map(), stars = new Map(), run = null, end = null, hearUntil = null, loopNow = null;
  // Grades (spec 2026-10-13-grades-and-results.md): runs = this visit's runs that sang, for
  // the rest nudge (section 9), oldest first; layer = the open "Full results" dialog;
  // resting = the one-minute rest pill { until, timer, done }.
  const runs = [];
  let layer = null, resting = null;
  let outNode = null, synth = null;
  const sky = { streaks: 0, micAtStreak: null, chimes: 0, lastChime: null };
  let lamp = { state: '', text: '', at: 0 }, raf = 0, dragging = false;
  const dismissed = new Set();
  let toolsSince = null, cachedModels = null;

  const status = () => (player ? player.state().status : 'empty');
  const playing = () => status() === 'playing';
  const recActive = () => !!recorder && ['starting', 'recording'].includes(recorder.state().status);
  const duration = () => (song ? song.duration : 0);
  const songTime = () => (!player ? 0 : clamp(playing() ? player.heardTime() : player.time(), 0, duration()));
  const targetAt = (t) => { if (!curve) return null; const c = curveAt(curve, t); return c.voiced && Number.isFinite(c.midi) ? c.midi + 12 * octave : null; };

  // ================================================================ DOM

  const $lib = h('section', { class: 'sn-library', 'aria-labelledby': 'sn-lib-title' });
  const $sing = h('section', { class: 'sn-sing', hidden: true, 'aria-labelledby': 'sn-song-title' });
  const $recPill = h('div', { class: 'sn-rec-pill', hidden: true, role: 'status' }, h('span', { class: 'sn-rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'sn-rec-words' }, 'Recording'));
  root.append($lib, $sing, $recPill);

  // ---- library
  const $file = h('input', { type: 'file', accept: 'audio/*,video/*', multiple: true, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const $dropTitle = h('h2', { class: 'sn-drop-title' }, 'Drop a song here');
  const $keptHere = h('p', { class: 'reason' }, KEPT_HERE[prefs.autoWords]);
  const $drop = h('div', { class: 'sn-drop', role: 'button', tabindex: '0', 'aria-label': 'Drop a song here, or press to choose a file' },
    icon('music-note', 48), $dropTitle,
    h('p', null, 'or ', h('button', { class: 'btn btn-secondary', type: 'button', id: 'sn-choose', onclick: (e) => { e.stopPropagation(); $file.click(); } }, 'Choose a file')),
    h('p', { class: 'reason' }, 'Audio, or a video with sound. Several at once is fine.'),
    $keptHere);
  // Said once, in the open, before the first automatic lookup (never a sheet).
  const $wordsNote = h('div', { class: 'sn-words-note card', role: 'note', hidden: true },
    icon('info', 16), h('p', null, LOOKUP_NOTICE),
    h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-note-ok', onclick: () => { noticeGone = true; prefs.wordsNoticeSeen = true; savePrefs(); paintNotice(); } }, 'Got it'),
    h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-note-settings', onclick: () => shell.openSettings('words') }, 'Turn it off in Settings…'));
  function paintNotice() {
    $wordsNote.hidden = !prefs.autoWords || noticeGone;
    $keptHere.textContent = KEPT_HERE[prefs.autoWords];
  }
  const $need = h('div', { class: 'sn-need card', hidden: true });
  const $queue = h('ul', { class: 'sn-queue', 'aria-live': 'polite' });
  const $notice = h('p', { class: 'reason sn-notice', hidden: true });
  const $songs = h('ul', { class: 'sn-songs' });
  const $empty = h('p', { class: 'reason' }, 'No songs yet. Drop one above: your own file, any length up to 12 minutes.');
  $lib.append(h('h1', { id: 'sn-lib-title', tabindex: '-1' }, 'Sing a song'), $drop, $file, $wordsNote, $need, $notice, $queue, h('h2', null, 'My songs'), $empty, $songs);

  // ---- sing screen
  const $title = h('h1', { id: 'sn-song-title', tabindex: '-1' }, '');
  const $artist = h('span', { class: 'reason sn-artist' }, '');
  const $banners = h('div', { class: 'sn-banners' });
  const $lampIcon = h('span', { class: 'sn-lamp-icon', 'aria-hidden': 'true' });
  const $lampText = h('span', { class: 'sn-lamp-text' }, '');
  const $lamp = h('div', { class: 'sn-lamp', dataset: { state: 'idle' } }, $lampIcon, $lampText);
  const $live = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  const $canvas = h('canvas', { class: 'sn-canvas', 'aria-hidden': 'true' });
  const $readWord = h('strong', null, ''), $readNum = h('span', null, '');
  // By ear: a crescent moon stands where the verdict was (grades spec 10.2).
  const $readMoon = h('span', { class: 'sn-readout-moon', hidden: true, 'aria-hidden': 'true' }, icon('moon', 20));
  const $readout = h('div', { class: 'sn-readout', hidden: true }, $readMoon, $readWord, $readNum);
  const $countCap = h('span', { class: 'sn-count-cap' }, ''), $countNum = h('strong', { class: 'sn-count-num' }, ''), $countBeads = h('span', { class: 'sn-count-beads' });
  const $countWays = h('span', { class: 'sn-count-ways' }, '');
  const $count = h('div', { class: 'sn-count', 'aria-hidden': 'true' }, $countCap, $countNum, $countBeads, $countWays);
  // The end panel (line results), over the stage once a run has ended.
  const $end = h('section', { class: 'sn-end', role: 'region', 'aria-label': 'Line results', hidden: true });
  const $stagePic = h('div', { class: 'sn-stage-pic', role: 'img', 'aria-label': 'The singer’s tune scrolling past the now line, with your voice over it' }, $canvas);
  const $stage = h('div', { class: 'sn-stage' }, $stagePic, $readout, $count, $end);
  // The words band: four rows that take turns. The row holding the current line has the
  // class sn-line, the one waiting under it sn-next; the others are out of sight.
  const $rows = [0, 1, 2, 3].map(() => h('p', { class: 'sn-row', dataset: { role: 'idle' }, 'aria-hidden': 'true' }, ''));
  const $markFill = h('span', { class: 'sn-marker-fill' }), $markStar = h('span', { class: 'sn-marker-star', 'aria-hidden': 'true' }, '✦');
  const $marker = h('div', { class: 'sn-marker', 'aria-hidden': 'true' }, $markFill, $markStar);
  // The star that lands beside the words when a line settles (no flight, no sound).
  const $pop = h('span', { class: 'sn-line-pop', 'aria-hidden': 'true' });
  const $band = h('div', { class: 'sn-words' }, h('div', { class: 'sn-roll' }, $rows, $marker, $pop));
  const $holdText = h('span', null, 'Jumping ends this take.');
  const $hold = h('div', { class: 'sn-hold', hidden: true, role: 'alert' }, $holdText,
    h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-hold-end', onclick: () => agreeHold() }, 'End take and jump'),
    h('button', { class: 'btn btn-primary btn-small', type: 'button', id: 'sn-hold-keep', onclick: () => hideHold() }, 'Keep recording'));
  const $tNow = h('span', { class: 'sn-time' }, '0:00'), $tEnd = h('span', { class: 'sn-time' }, '0:00');
  const $blocks = h('div', { class: 'sn-scrub-blocks' }), $played = h('div', { class: 'sn-scrub-played' }), $takeBar = h('div', { class: 'sn-scrub-take', hidden: true }), $head = h('div', { class: 'sn-scrub-head' });
  // One star a line, under the track at the line's middle: the song's constellation.
  const $lineStars = h('div', { class: 'sn-line-stars', role: 'list', 'aria-label': 'Line stars' });
  const $scrub = h('div', { class: 'sn-scrub', role: 'slider', tabindex: '0', 'aria-label': 'Place in the song', 'aria-valuemin': '0' }, h('div', { class: 'sn-scrub-track' }, $blocks, $takeBar, $played), $head, $lineStars);
  const $loopWords = h('span', null, '');
  const $restWords = h('span', null, '');
  const $restSkip = h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-rest-skip', onclick: () => stopRest() }, 'Skip the rest');
  const $rest = h('div', { class: 'sn-rest', hidden: true, role: 'status' }, icon('moon', 16), $restWords, $restSkip);
  const $loop = h('div', { class: 'sn-loop', hidden: true, role: 'status' }, icon('replay', 16), $loopWords,
    h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-loop-stop', onclick: () => { if (transport) transport.clearLoop(); } }, 'Stop repeating'));

  const btn = (cls, id, label, onclick, ...kids) => h('button', { class: `btn ${cls}`, type: 'button', id, title: label, 'aria-label': label, onclick }, ...kids);
  const key = (k) => h('kbd', { class: 'keycap' }, k);
  const $primaryWord = h('span', null, 'Sing');
  const $primary = btn('btn-primary sn-primary', 'sn-primary', 'Sing', () => primary(), $primaryWord, ' ', key('Space'));
  const $listen = btn('btn-quiet', 'sn-listen', 'Listen without the microphone (P)', () => listen(), 'Listen');
  const $recordWord = h('span', null, 'Record a take');
  const $record = btn('btn-secondary sn-record', 'sn-record', 'Record a take (R)', () => recordPress(), h('span', { class: 'sn-rec-dot', 'aria-hidden': 'true' }), $recordWord, ' ', key('R'));
  const $transport = h('div', { class: 'sn-transport action-row' },
    btn('btn-quiet', 'sn-restart', 'Back to the start (Home)', () => jump((o) => transport.restart(o)), '⏮'),
    btn('btn-quiet', 'sn-prev', 'Previous phrase (up arrow)', () => jump((o) => transport.prevLine(o)), '◂ Phrase'),
    btn('btn-quiet', 'sn-replay', 'Replay this phrase (B)', () => jump((o) => transport.replayLine(o)), icon('replay', 16), ' Phrase'),
    btn('btn-quiet', 'sn-back5', 'Back 5 seconds (left arrow)', () => jump((o) => transport.skip(-SONG.transport.skipSec, o)), '−5 s ', key('←')),
    $primary, $listen,
    btn('btn-quiet', 'sn-fwd5', 'Forward 5 seconds (right arrow)', () => jump((o) => transport.skip(SONG.transport.skipSec, o)), key('→'), ' +5 s'),
    btn('btn-quiet', 'sn-nextp', 'Next phrase (down arrow)', () => jump((o) => transport.nextLine(o)), 'Phrase ▸'),
    h('span', { class: 'sn-gap' }), $record);
  const $primaryWhy = h('p', { class: 'reason sn-why' }, '');

  // sound and fit (sing mode)
  const $guideWords = h('span', { class: 'reason' }, '');
  // Real ranges, 0 to 100 in steps of 1 (an arrow key on a focused slider moves it by 1).
  const marks = (id, list, scale) => h('datalist', { id }, list.map((v) => h('option', { value: String(v * scale) })));
  // Music (the backing) and Singer (the separated voice) are two sliders that never move
  // each other, and 0 on either is silence for that sound, not "quiet" (player.js ease).
  const $music = h('input', { type: 'range', min: '0', max: '100', step: '1', id: 'sn-music', value: String(percent(levels.music)), oninput: (e) => setMusic(Number(e.target.value) / 100), onchange: () => flushPrefs() });
  const $musicWords = h('span', { class: 'reason' }, '');
  const $guide = h('input', { type: 'range', min: '0', max: '100', step: '1', id: 'sn-guide', list: 'sn-guide-marks', value: String(percent(levels.singer)), oninput: (e) => setGuide(Number(e.target.value) / 100), onchange: () => flushPrefs() });
  const $volume = h('input', { type: 'range', min: '0', max: '100', step: '1', id: 'sn-volume', value: String(percent(levels.volume)), oninput: (e) => setVolume(Number(e.target.value) / 100), onchange: () => flushPrefs() });
  const $volumeWords = h('span', { class: 'reason' }, '');
  // The three quick settings: each sets BOTH sliders. The one the sliders are at is ticked.
  // Their order follows the sliders above them: "Music only" under Music, "Singer only"
  // under Singer, "Both" between (not mix.js' key order; design review 2026-10-14, finding 6).
  const $mixMarks = h('div', { class: 'sn-marks sn-mix-marks', role: 'group', 'aria-label': 'Quick settings for Music and Singer' }, MIX_ORDER.map((name) =>
    h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: `sn-mix-${name}`, dataset: { mix: name }, onclick: () => setMixPreset(name) }, MIX_PRESET_WORDS[name])));
  const $octaveSlot = h('div', { class: 'sn-octave' }), $octaveWords = h('p', { class: 'reason' }, '');
  // Ways to sing (grades spec 10.1): one quiet button beside Octave; the sheet has the sentences.
  const $ways = btn('btn-quiet btn-small sn-ways-btn', 'sn-ways', 'Ways to sing (M)', () => openWays(), 'Ways to sing: Usual');
  // Always one line of words under it, so locking it never moves the row.
  const $waysWhy = h('p', { class: 'reason', id: 'sn-ways-why' }, '');
  const $wordsBtn = btn('btn-secondary', 'sn-words-btn', 'Words for this song', () => openWords(), 'Words…');
  const $auto = h('div', { class: 'sn-auto reason', hidden: true, 'aria-live': 'polite' });
  const $sound = h('div', { class: 'sn-sound' },
    h('div', { class: 'sn-mix' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Music'), $musicWords, $music),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Singer'), $guideWords, $guide),
      $mixMarks),
    h('label', { class: 'field sn-volume' }, h('span', { class: 'field-label' }, 'Volume'), $volumeWords, $volume),
    marks('sn-guide-marks', SONG.levels.guideMarks, 100),
    h('div', null, $octaveSlot, $octaveWords),
    h('div', { class: 'sn-ways' }, $ways, $waysWhy),
    h('div', { class: 'sn-sound-end' }, $wordsBtn), $auto);

  // review (after a take)
  // Balance keeps mix.js' own unit (0 = only the song, 1 = only my voice) in steps of 0.01.
  const $balance = h('input', { type: 'range', min: '0', max: '1', step: '0.01', id: 'sn-balance', list: 'sn-balance-marks', value: String(SONG.mix.balance), oninput: (e) => setBalance(Number(e.target.value)), onchange: () => keepBalance() });
  const $balanceWords = h('span', { class: 'reason' }, 'Both at full'), $balanceNum = h('span', { class: 'reason sn-balance-num' }, '');
  const $balanceMarks = h('div', { class: 'sn-marks' }, SONG.levels.balanceMarks.map((v) =>
    h('button', { class: 'btn btn-quiet btn-small', type: 'button', dataset: { balance: String(v) }, onclick: () => { setBalance(v); keepBalance(); } }, balanceWords(v))));
  const $nudgeWords = h('strong', { class: 'sn-nudge-words' }, 'as recorded');
  const $keepBar = h('div', { class: 'sn-keep', hidden: true }, h('strong', null, 'Keep this take?'),
    btn('btn-primary btn-small', 'sn-keep', 'Keep it', () => keepTake(), 'Keep it'),
    btn('btn-danger btn-small', 'sn-discard', 'Discard', () => discardTake(), 'Discard'),
    h('span', { class: 'reason' }, 'It is kept unless you discard it.'));
  const $reviewHead = h('p', { class: 'sn-review-head' }, '');
  const $mixWhy = h('p', { class: 'reason' }, '');
  const $resultsBtn = btn('btn-quiet', 'sn-results', 'Line results', () => openEnd(), 'Line results');
  const $saveMix = btn('btn-secondary', 'sn-save-mix', 'Save a mixed file', () => saveMixed(), 'Save a mixed file…');
  const $review = h('div', { class: 'sn-review', hidden: true }, $reviewHead, $keepBar,
    h('div', { class: 'sn-review-row' },
      h('div', { class: 'field sn-balance' }, h('label', { class: 'field-label', for: 'sn-balance' }, 'Balance: Song ↔ My voice'), $balance,
        marks('sn-balance-marks', SONG.levels.balanceMarks, 1), $balanceMarks, $balanceWords, $balanceNum),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Timing of my voice'),
        h('div', { class: 'action-row' },
          btn('btn-secondary btn-small', 'sn-nudge-early', 'My voice 5 ms earlier ([)', () => setNudge(-1), '− earlier'), $nudgeWords,
          btn('btn-secondary btn-small', 'sn-nudge-late', 'My voice 5 ms later (])', () => setNudge(1), 'later +')),
        h('span', { class: 'reason' }, 'If your voice sounds behind the song, press earlier. Bluetooth headphones usually need this.'))),
    h('div', { class: 'action-row' }, $saveMix,
      btn('btn-secondary', 'sn-save-voice', 'Save my voice only', () => saveVoice(), 'Save my voice only…'),
      btn('btn-quiet', 'sn-again', 'Sing it again', () => leaveReview(), 'Sing it again'),
      $resultsBtn),
    $mixWhy);

  // tap along (timing pasted words)
  const $tapWords = h('p', { class: 'reason' }, '');
  const $tapRow = h('div', { class: 'sn-tap action-row', hidden: true }, $tapWords,
    btn('btn-secondary btn-small', 'sn-tap-back', 'Back one line', () => tapBack(), '← Back one line'),
    btn('btn-secondary btn-small', 'sn-tap-done', 'Finish and keep what is timed', () => finishTap(), 'Done'));

  $sing.append(
    h('div', { class: 'title-row' }, btn('btn-quiet', 'sn-back', 'Back to My songs', () => (goTo ? goTo('#/songs') : closeSong()), icon('back', 16), ' My songs'), $title, $artist),
    $banners, $lamp, $live, $stage, $band, $hold,
    h('div', { class: 'sn-scrub-row' }, $tNow, $scrub, $tEnd), $loop, $rest,
    $transport, $primaryWhy, $tapRow, $sound, $review);
  const offBanners = micflow.mountBanners($banners);

  // A button pressed with the mouse must not keep the focus: Space would press it again
  // instead of being Sing / Pause (design-library lesson: blur buttons).
  $sing.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button'); if (b && e.detail > 0) b.blur(); });

  // ================================================================ library

  function addFiles(files) {
    const list = [...(files || [])];
    const songs = list.filter((f) => f && fileKind(f.name) === 'audio');
    if (list.length && !songs.length) { toast('That was a note chart. This page takes audio or a video with sound.'); return []; }
    if (!songs.length) { toast('That was not a file. Drag the song’s file from Finder.'); return []; }
    const ids = jobs.add(songs);
    // The file is kept by the page until its song is saved: its tags name the song and may
    // hold its words. Reading them asks nobody (tags.js) and never fails.
    ids.forEach((id, i) => dropped.set(id, { file: songs[i], tags: readTags(songs[i]) }));
    startIfReady();
    return ids;
  }
  // With the model already in this browser nothing is downloaded, so the drop is the press.
  async function startIfReady() {
    const st = jobs.state();
    if (st.tools === 'ready') { jobs.go(); return; }
    if (st.tools !== 'none') return;
    cachedModels = await modelsCached();
    if (cachedModels && jobs.state().needsGo) go();
    paintQueue();
  }
  async function modelsCached() {
    if (hooks.loadTools) return !!hooks.cached;
    try {
      const cache = await caches.open(MODEL_CACHE);
      for (const id of ['htdemucs', 'swiftf0']) for (const f of MODELS[id].files) if (!(await cache.match(modelBase(id) + f.name))) return false;
      return true;
    } catch { return false; }
  }
  async function go() {
    toolsSince = null;
    const res = await jobs.go();
    if (!res.ok) toast(res.words);
    paintQueue();
  }

  function toolsWords(p) {
    if (!p) return 'Getting the listening model ready…';
    if (p.stage === 'download') {
      const now = performance.now();
      if (!toolsSince || p.done < toolsSince.done) toolsSince = { at: now, done: p.done };
      const spent = (now - toolsSince.at) / 1000, got = p.done - toolsSince.done;
      const left = spent >= 3 && got > 0 ? ((p.total - p.done) / got) * spent : null;
      return `Getting the listening model: ${Math.round(p.done / 1e6)} of ${Math.round(p.total / 1e6)} MB · ${aboutLeft(left)}`;
    }
    if (p.stage === 'sessions') return `Getting the model ready: piece ${p.done + 1} of ${p.total}`;
    return 'Loading the listening engine…';
  }

  function paintQueue() {
    const st = jobs.state();
    const waiting = st.jobs.filter((j) => j.status === 'queued');
    // The one-time download, named with its size and where it comes from, before the press.
    const ask = st.needsGo && (st.tools === 'none' || st.tools === 'failed') && cachedModels === false;
    $need.hidden = !ask && st.tools !== 'loading';
    if (ask) {
      const need = toolsNeeded();
      $need.replaceChildren(
        h('h2', null, 'One download first'),
        h('p', null, need.words),
        h('p', { class: 'reason' }, `The model (${megabytes(MODELS.htdemucs.files.reduce((s, f) => s + f.bytes, 0))}) comes from Hugging Face and a small melody reader from GitHub; the engine that runs them comes from this site. After that it works offline. Only the model comes in: your songs are never sent anywhere.`),
        st.tools === 'failed' && h('p', { class: 'sn-error' }, 'The listening model did not download fully. Check the internet connection and try again.'),
        h('p', { class: 'reason' }, `Waiting: ${waiting.slice(0, 3).map((j) => j.name).join(', ')}${waiting.length > 3 ? ` and ${waiting.length - 3} more` : ''}`),
        h('div', { class: 'action-row' },
          h('button', { class: 'btn btn-primary', type: 'button', id: 'sn-go', onclick: () => { go(); } }, `Download ${megabytes(need.bytes)} and analyse`),
          h('button', { class: 'btn btn-quiet', type: 'button', id: 'sn-not-now', onclick: () => { jobs.cancel(); } }, 'Not now')));
    } else if (st.tools === 'loading') {
      $need.replaceChildren(h('h2', null, 'Getting ready'), h('p', { id: 'sn-tools-words' }, toolsWords(st.toolsProgress)),
        st.toolsProgress && st.toolsProgress.total ? h('progress', { max: String(st.toolsProgress.total), value: String(st.toolsProgress.done) }) : h('progress', null));
    }
    const rows = st.jobs.filter((j) => !dismissed.has(j.id) && j.status !== 'done' && j.status !== 'cancelled');
    $queue.replaceChildren(...rows.map((j) => {
      const failed = j.status === 'failed';
      const words = failed ? j.error.words : j.status === 'queued' ? (st.tools === 'ready' ? 'Waiting its turn' : 'Waiting') : STEP_WORDS[j.step] || j.step;
      return h('li', { class: 'sn-job card', dataset: { job: j.id, status: j.status, step: j.step } },
        h('strong', null, j.name),
        h('span', { class: failed ? 'sn-error' : 'sn-job-step' }, words),
        j.status === 'running' && h('progress', { max: '1', value: String(j.progress) }),
        j.status === 'running' && h('span', { class: 'reason sn-job-eta' }, aboutLeft(j.etaSec)),
        failed ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { dismissed.add(j.id); paintQueue(); } }, 'Dismiss')
          : h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => jobs.cancel(j.id) }, 'Cancel'));
    }));
  }
  const offJobs = jobs.on((e) => {
    if (e.type === 'state') { for (const j of e.state.jobs) if (j.status === 'failed' || j.status === 'cancelled') dropped.delete(j.id); paintQueue(); }
    else if (e.type === 'done') { toast('Added to My songs'); paintLibrary(); afterDrop(e); }
    else if (e.type === 'notice') { $notice.hidden = false; $notice.textContent = e.words; }
  });

  async function paintLibrary() {
    const got = await store.list({ sort: 'date' });
    const mine = got.groups.mine;
    const bests = readBests(storage);
    const rows = [];
    for (const e of mine) {
      const kept = e.takes ? await store.takesOf(e.id) : [];
      const top = bestAny(bests, e.id);
      rows.push(h('li', { class: 'sn-song card', dataset: { song: e.id } },
        h('div', { class: 'sn-song-main' },
          h('strong', { class: 'sn-song-title' }, e.title), e.artist && h('span', { class: 'sn-song-artist' }, e.artist),
          h('span', { class: 'reason' }, [lengthWords(e.duration), rangeWords(e.range), e.hasWords ? 'has words' : null, e.hasBacking ? null : 'its sound is missing: drop the file again'].filter(Boolean).join(' · ')),
          songBadge(bests, e.id)),
        h('div', { class: 'action-row' },
          h('button', { class: 'btn btn-primary', type: 'button', dataset: { act: 'sing' }, disabled: !e.hasBacking, onclick: () => (goTo ? goTo(`#/songs/${encodeURIComponent(e.id)}`) : openSong(e.id)) }, 'Sing'),
          h('button', { class: 'btn btn-quiet', type: 'button', dataset: { act: 'rename' }, onclick: () => renameSong(e) }, 'Rename'),
          h('button', { class: 'btn btn-quiet', type: 'button', dataset: { act: 'remove' }, onclick: () => removeSong(e) }, 'Remove')),
        kept.length ? h('ul', { class: 'sn-takes', 'aria-label': `Takes of ${e.title}` }, kept.map((t) => h('li', { class: 'sn-take', dataset: { take: t.id } },
          h('span', null, [`Take · ${dateWords(t.createdAt)} · ${lengthWords(t.seconds)}${t.finished === false ? ' · cut short' : ''}`, ...takeRowWords(t)].join(' · ')),
          top && top.result.takeId === t.id ? h('span', { class: 'sn-chip', dataset: { tone: top.result.silver ? 'silver' : 'gold', chip: 'best' } }, 'Best') : null,
          h('button', { class: 'btn btn-secondary btn-small', type: 'button', dataset: { act: 'play-take' }, onclick: () => openSong(e.id, { takeId: t.id }) }, icon('play', 16), ' Play'),
          h('button', { class: 'btn btn-quiet btn-small', type: 'button', dataset: { act: 'delete-take' }, onclick: () => deleteTake(t) }, 'Delete')))) : null));
    }
    $songs.replaceChildren(...rows);
    $empty.hidden = mine.length > 0;
    $empty.textContent = got.unavailable ? 'This browser’s storage cannot be opened (a private window?), so songs cannot be kept here.' : 'No songs yet. Drop one above: your own file, any length up to 12 minutes.';
    $drop.classList.toggle('is-small', mine.length > 0);
  }

  // My songs (grades spec 6.3): the song's best as a small medallion and its words; nothing
  // at all before the first letter (no empty ring). A second way's best on a quiet line.
  const MOD_WORDS = Object.freeze({ plain: 'With the pitch line', noLine: 'By ear', noGuide: 'No guide voice' });
  function songBadge(bests, songId) {
    const top = bestAny(bests, songId);
    if (!top || !top.result || !Number.isFinite(top.result.accuracy) || (!top.result.letter && top.result.state !== 'finding')) return null;
    const r = top.result, byEar = !!(r.mods && r.mods.noLine), said = letterWords(r);
    const badge = h('div', { class: 'sn-song-best', dataset: { state: r.state || 'graded' } });
    const words = r.letter ? `Best${byEar ? ' by ear' : ''}: ${said}` : said;
    // One label for the whole badge (review J8); the small medallion inside is not read again.
    badge.setAttribute('role', 'group');
    badge.setAttribute('aria-label', r.letter ? `Best for this song: ${r.letter}, ${wholePercent(r.accuracy)} percent${byEar ? ', by ear' : ''}.` : 'Best for this song: finding it.');
    mountMedallion(badge, medallionModel(r), { size: 40, calm: true });
    const mg = badge.querySelector('.mg');
    if (mg) { mg.removeAttribute('role'); mg.removeAttribute('aria-label'); mg.setAttribute('aria-hidden', 'true'); }
    badge.append(h('span', { class: r.letter ? 'sn-song-best-words' : 'sn-song-best-words reason' }, words));
    const others = Object.entries((bests && bests.songs && bests.songs[songId]) || {}).filter(([k, v]) => k !== top.key && v && v.letter);
    if (others.length) {
      const say = others.slice(0, 2).map(([k, v]) => `${k.split('+').map((m) => MOD_WORDS[m] || m).join(', ')}: ${letterWords(v)}`);
      badge.append(h('span', { class: 'reason sn-song-best-more' }, say.join(' · ') + (others.length > 2 ? ` and ${others.length - 2} more` : '')));
    }
    return badge;
  }
  // A take row's letter: "A · 78 %", "Finding it", "part of the song · 71 %", and its ways.
  function takeRowWords(t) {
    const w = takeWords(t && t.lines && t.lines.grade);
    return [w.words, ...w.chips.map((c) => c.toLowerCase())].filter(Boolean);
  }

  function renameSong(e) {
    const $t = h('input', { type: 'text', class: 'select', id: 'sn-rename-title', value: e.title }), $a = h('input', { type: 'text', class: 'select', id: 'sn-rename-artist', value: e.artist || '' });
    const sheet = openSheet({ title: 'Rename this song', body: [
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), $t),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Artist'), $a),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', id: 'sn-rename-save', onclick: async () => {
          const title = $t.value.trim();
          if (!title) { $t.focus(); return; }
          await store.update(e.id, { title, artist: $a.value.trim() });
          sheet.close();
          paintLibrary();
        } }, 'Save'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => sheet.close() }, 'Cancel')),
    ] });
  }
  async function removeSong(e) {
    const ok = await confirmSheet({ title: `Remove “${e.title}”?`, body: `The song${e.takes ? `, its ${e.takes === 1 ? 'take' : `${e.takes} takes`}` : ''} and its words are removed from this Mac. Your own file is not touched.`, yes: 'Remove', no: 'Keep it' });
    if (!ok) return;
    await store.remove(e.id);
    toast('Removed');
    paintLibrary();
  }
  async function deleteTake(t) {
    if (!(await confirmSheet({ title: 'Delete this take?', body: `Your take of ${dateWords(t.createdAt)} is removed from this Mac. This cannot be undone.`, yes: 'Delete', no: 'Keep it' }))) return;
    await takes.remove(t.id);
    toast('Take deleted');
    paintLibrary();
  }

  // ---- the words of a dropped song, found without a press (autowords.js)
  // The song is saved and singable before any of this starts, and stays so whatever comes
  // back: no sheet opens, and nothing here can fail the drop.
  async function afterDrop(e) {
    const d = dropped.get(e.job.id), id = e.songId;
    dropped.delete(e.job.id);
    if (!d || !id) return;
    dropping.add(id);
    try {
      const tags = await d.tags;
      const name = titleFromTags(tags, d.file.name);
      if (name && (await store.update(id, name))) paintLibrary();
      const entry = await store.get(id);
      if (!entry || entry.words) return;
      await findWords(id, { file: d.file, tags, phrases: entry.phrases || [], durationSec: entry.duration });
    } catch { /* the song is in My songs without words */ }
    finally { dropping.delete(id); }
  }
  // A song from an earlier visit, opened without words (owner 2026-10-13: automatic, no
  // "Look up" press). Once a visit per song (`tried`: a drop made with the switch off does
  // not count), and not while its own drop is still
  // asking (`dropping`); across visits "nothing found" is in the words cache, so the same
  // song is not asked about twice. The file is not here any more: the lookup goes by the
  // stored title and artist. A song still under the name its file gave it is read from the
  // file name, exactly as on its drop, so both ask under one key; a renamed or tagged one
  // goes by what is stored.
  function wordsOnOpen(entry) {
    const a = autos.get(entry.id);
    if (!prefs.autoWords || entry.words || entry.kind !== 'file' || dropping.has(entry.id) || (a && (a.tried || a.state === 'looking'))) return;
    const guess = titleFromFile(entry.fileName || '');
    const asNamed = !!entry.fileName && guess.title === entry.title && guess.artist === (entry.artist || '');
    findWords(entry.id, { ...(asNamed ? {} : { tags: { title: entry.title, artist: entry.artist || '' } }), fileName: entry.fileName || '', phrases: entry.phrases || [], durationSec: entry.duration }).catch(() => {});
  }
  // pressed: the owner asked from the title line (a corrected title), so the switch does
  // not matter. Otherwise the switch decides whether anything is asked.
  async function findWords(id, given, { pressed = false } = {}) {
    const a = autos.get(id) || { state: 'looking', result: null, asked: new Set(), pressed: false };
    autos.set(id, a);
    a.state = 'looking';
    a.pressed = a.pressed || pressed;
    const ask = pressed || prefs.autoWords;
    a.tried = a.tried || ask;      // a real lookup was allowed: opening the song starts no other
    if (ask && !prefs.wordsNoticeSeen) { prefs.wordsNoticeSeen = true; savePrefs(); }
    if (mode !== 'library') paint();
    const r = await autoWords({ ...given, ...(ask ? { fetch: netFetch, cache: wordsCache } : { lookup: noSearch, cache: noCache }) });
    a.state = 'done';
    // With the switch off the "search" was the stand-in above: nothing was asked.
    a.result = ask ? r : { ...r, searched: false };
    if (ask && r.asked && r.asked.title) a.asked.add(songKey(r.asked));
    if (r.words) {
      // Words the owner pasted in the meantime are theirs: the found ones do not replace them.
      const now = await store.get(id);
      if (now && !now.words && (await store.setWords(id, r.words)) && song && song.id === id) { song.words = r.words; refreshLines(); }
    }
    if (mode === 'library') paintLibrary(); else paint();
    return r;
  }
  // The title line under the sliders: one more lookup for a title not asked before.
  const askedBefore = (title) => { const a = song && autos.get(song.id); return !!a && a.asked.has(songKey({ title, artist: song.artist || '' })); };
  async function retryWords(title) {
    const t = String(title || '').trim();
    if (!song || !t || askedBefore(t)) return;
    const a = autos.get(song.id);
    if (a && a.state === 'looking') return;
    const id = song.id;
    const r = await findWords(id, { title: t, artist: song.artist || '', phrases, durationSec: song.duration }, { pressed: true });
    // The title that found the words is the song's name.
    if (r.words && song && song.id === id && t !== song.title && (await store.update(id, { title: t }))) { song.title = t; paint(); }
  }
  let autoShown = '';
  function paintAuto() {
    const a = song ? autos.get(song.id) : null;
    const line = mode === 'sing' && song ? autoLine({ words: song.words, auto: a, on: prefs.autoWords }) : { kind: 'hidden', text: '' };
    const sig = `${song ? song.id : ''}|${line.kind}|${line.text}|${a ? a.asked.size : 0}`;
    if (sig === autoShown) return;      // a redraw would take the title out from under the typing
    autoShown = sig;
    $auto.hidden = line.kind === 'hidden';
    $auto.dataset.kind = line.kind;
    // "No words" and "looking" sit right under the words band, where the words would be
    // (in sight at 1024 x 640 too); the credit stays the quiet line under Words….
    const strip = line.kind === 'none' || line.kind === 'looking';
    if (strip && $auto.parentNode !== $sing) $band.after($auto);
    else if (!strip && $auto.parentNode !== $sound) $sound.append($auto);
    if (line.kind === 'credit') {
      $auto.replaceChildren(h('span', null, line.text), h('span', { 'aria-hidden': 'true' }, ' · '),
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-auto-change', title: 'Change the words', 'aria-label': 'Change the words', onclick: () => openWords() }, 'Change'));
    } else if (line.kind === 'none') {
      const $t = h('input', { type: 'text', class: 'select', id: 'sn-auto-title', value: song.title, title: 'The song’s title, to look its words up again' });
      const $go = h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-auto-retry', onclick: () => retryWords($t.value) }, a && a.asked.size ? 'Look again' : 'Look up the words');
      const able = () => { $go.disabled = !$t.value.trim() || askedBefore($t.value.trim()); };
      $t.addEventListener('input', able);
      $t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$go.disabled) { e.preventDefault(); retryWords($t.value); } });
      able();
      $auto.replaceChildren(h('span', { class: 'sn-auto-say' }, line.text), h('label', { class: 'sn-auto-label', for: 'sn-auto-title' }, 'Song title'), $t, $go);
    } else $auto.replaceChildren(line.text);
  }

  // "Look up words automatically" joins the shell's Settings sheet when it opens (the
  // sheet is the shell's; this page adds its one part in the same turn, above "Your data").
  on(document, 'mt:sheet', () => {
    const body = document.querySelector('dialog.sheet-settings[open] .sheet-body, dialog.sheet-settings .sheet-body');
    if (!body || body.querySelector('#settings-words')) return;
    const part = h('section', { class: 'settings-part', id: 'settings-words' }, h('h3', { tabindex: '-1' }, 'Words'),
      switchRow({ label: 'Look up words automatically', value: prefs.autoWords,
        note: 'On: when you add a song, its title and artist are sent to lrclib.net to find the words. Off: nothing is sent until you press “Look up the words” yourself.',
        onChange: (v) => { prefs.autoWords = !!v; savePrefs(); paintNotice(); autoShown = ''; if (mode !== 'library') paint(); } }));
    const data = body.querySelector('#settings-data');
    if (data) data.before(part); else body.append(part);
  });

  // ---- the drop area: the whole page takes a drop while the library shows
  $drop.addEventListener('click', () => $file.click());
  $drop.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === $drop) { e.preventDefault(); $file.click(); } });
  $file.addEventListener('change', () => { addFiles($file.files); $file.value = ''; });
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const lit = (on) => { $drop.classList.toggle('is-over', on); $dropTitle.textContent = on ? 'Let go to add it' : 'Drop a song here'; };
  on(window, 'dragenter', (e) => { if (mode !== 'library' || !hasFiles(e)) return; dragDepth++; lit(true); });
  on(window, 'dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) lit(false); });
  // Without this the browser would open the dropped file in place of the page.
  on(window, 'dragover', (e) => { e.preventDefault(); });
  on(window, 'drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    lit(false);
    if (mode !== 'library') { toast('Go back to My songs to add another song.'); return; }
    addFiles(e.dataTransfer ? e.dataTransfer.files : []);
  });

  // ================================================================ opening a song

  // Made by the first press that needs sound, never on load.
  async function ensureAudio() {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      // Always one gain on the way out (0 when silent): leaving the screen ramps it down
      // before closing the context, so the song ends without a click (spec 3.4 step 2).
      const out = ctx.createGain();
      out.gain.value = hooks.silent ? 0 : 1;
      out.connect(ctx.destination);
      outNode = out;     // the page's one way out: the end chime goes through it too
      player = createPlayer({ audioContext: ctx, destination: out });
      player.setVolume(levels.volume);
      // Pause, however it came about, ends the listening: the microphone is released.
      player.on('pause', () => { hearUntil = null; closeOpenLines(); release(); paint(); });
      player.on('ended', () => {
        const practised = singing && mode === 'sing' && !!run && !run.take;
        closeOpenLines();
        // A take that runs to the end of the song ends BY the song's end. It is told so
        // before the microphone is released: released first, the recorder saw the
        // microphone go and kept the take as "the microphone went away" (with that toast).
        if (recActive()) Promise.resolve(recorder.stop('ended')).catch(() => {});
        release();
        if (mode === 'tap') finishTap();
        // Sing practice reached the end of the song: its line results (nothing is saved).
        else if (practised) endOfPractice();
        paint();
      });
      player.on('play', () => {
        everPlayed = true; trail = [];
        closeEnd({ focus: false });
        // A take is one run. Practice is one run from end panel to end panel, pauses included.
        const take = recActive(), judged = (singing || take) && mode === 'sing';
        if (!judged) run = null;
        else if (!run || take || run.take) run = { results: new Map(), take, lastT: -Infinity, frames: [], at: Date.now(), line: loopNow ? lineIndexAt(lines, loopNow.start + 0.01) : null };
        // By ear the row is empty for the whole run, earlier runs' stars too (spec 10.2).
        if (byEarRun()) paintStars();
        paint();
      });
      // A jump is the owner's own press: the prompt follows it at once (paintLamp).
      player.on('seek', () => { trail = []; closeOpenLines(); lamp.free = true; });
      player.on('loop', (d) => { loopNow = d && d.loop ? d.loop : null; paint(); });
      if (hooks.onAudio) hooks.onAudio({ ctx, player });
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  }

  async function openSong(id, { takeId = null } = {}) {
    if (opening) return false;
    opening = true;
    try {
      stopAll('stop');
      await ensureAudio();
      const [entry, audio, line] = [await store.get(id), await store.audio(id), await store.curve(id)];
      if (!entry || !audio || !audio.backing) { toast('This song could not be opened. Drop its file again.'); paintLibrary(); return false; }
      if (recorder) recorder.destroy();
      await player.load(audio.backing, { id });
      song = entry; curve = line; phrases = entry.phrases || []; octave = entry.octave || 0;
      hasGuide = !!audio.vocal;
      // This song's own three levels, before a sample of it is played.
      levels = mixFor(id);
      player.setVolume(levels.volume);
      player.setBackingGain(levels.music);
      if (hasGuide) player.setLayer('guide', { samples: audio.vocal.samples, sampleRate: audio.vocal.sampleRate, at: 0, gain: guideHeard() });
      // The height the count-in beads sit at: each phrase's first sung note.
      phraseMidi = phrases.map((p) => { if (!curve) return null; for (let i = firstAtOrAfter(curve.t, p.t); i < curve.t.length && curve.t[i] <= p.end; i++) if (curve.voiced[i]) return curve.midi[i]; return null; });
      recorder = createRecorder({ micflow, player, songId: id, store: takes, title: entry.title });
      recorder.subscribe(() => paint());
      recorder.onTake((take) => { onTake(take); });
      transport = createTransport({ player, recorder, lines: phrases, phrases });
      refreshLines();
      everPlayed = false; trail = []; lastRead = null; review = null; tap = null;
      counting = new Map(); stars = new Map(); run = null; loopNow = null; closeEnd({ focus: false }); end = null;
      lamp = { state: '', text: '', at: 0 };
      mode = 'sing';
      // A toast still up speaks of the library ("Added to My songs"): on this screen it
      // would lie over the Song volume slider for its 4 s (design review 2026-10-13, 11).
      const $toast = document.getElementById('toast');
      if ($toast) $toast.classList.remove('is-shown');
      buildScrub();
      paint();
      $title.focus({ preventScroll: true });
      wordsOnOpen(entry);
      if (takeId) {
        const take = await takes.load(takeId);
        if (take) enterReview(take, { fresh: false }); else toast('This take could not be read and has been removed.');
      }
      return true;
    } catch (err) {
      toast(err && err.name === 'DecodeError' ? err.message : 'This song could not be opened. Drop its file again.');
      return false;
    } finally { opening = false; }
  }

  function closeSong() {
    stopAll('left');
    closeEnd({ focus: false });
    if (review) leaveReview();
    tap = null; end = null; run = null;
    if (recorder) { recorder.destroy(); recorder = null; }
    transport = null;
    song = null; curve = null; phrases = []; spans = []; bandSpans = []; lines = [];
    mode = 'library';
    paint();
    paintLibrary();
  }

  // Lines are what "previous / next" step through: the words' timed lines when the song has
  // them, else its phrases.
  function refreshLines() {
    spans = song && song.words ? lineSpans(song.words, phrases, { duration: song.duration }) : [];
    // The band shows a very long line as two; stepping, tapping and the counts in the
    // Words sheet stay on the lines as they are stored.
    bandSpans = splitLongLines(spans);
    const was = lines;
    lines = spans.length ? spans : phrases;
    if (transport) transport.setLines(lines, phrases);
    // Other lines (words added, removed or re-timed): the stars of the old ones say nothing
    // about these.
    if (was.length !== lines.length || was.some((l, i) => l.t !== lines[i].t || l.end !== lines[i].end)) { counting = new Map(); stars = new Map(); run = null; paintStars(); }
  }

  // ================================================================ microphone and playing

  // Everything that listens goes off, at once and in this turn. A take that is running is
  // ended first and kept (the recorder has been writing it to the take store).
  function stopAll(why = 'stop') {
    // A mix still waiting to be saved is written now (closing the song, a hidden or closed page).
    flushPrefs();
    hideHold();
    endCount(false);
    if (recActive()) Promise.resolve(recorder.stop(why)).catch(() => {});
    if (playing()) player.pause(why);
    release();
  }
  function release() {
    singing = false;
    const phase = micflow.state().phase;
    if (phase === 'on' || phase === 'checking' || phase === 'waiting') { micflow.setListening(false); micflow.stop(); }
  }
  // A sheet covers the song: stop and release. Not while the start's own sheet is up (the
  // headphones question, then the microphone's question and level check): those are the
  // way in, not a way out. Any OTHER sheet opened while the microphone is still opening
  // (Settings, Words, the headphones chip) ends the start: it used to be let through, and
  // the song then played, or a take recorded, under that sheet (bugs.md 72).
  const startsOwnSheet = () => { const top = [...document.querySelectorAll('dialog[open]')].pop(); return micStarting && !!ownSheet && !!top && top.classList.contains(ownSheet); };
  on(document, 'mt:sheet', (e) => { if (e.detail && e.detail.open && !startsOwnSheet()) stopAll('stop'); });
  on(document, 'visibilitychange', () => { if (document.hidden) stopAll('hidden'); });
  on(window, 'pagehide', () => stopAll('left'));
  // The page is about to go (reload, close): end a running take now, while a write is
  // still kept (recorder.js), and release the microphone. No question is asked.
  on(window, 'beforeunload', () => stopAll('left'));
  const offMicState = micflow.subscribe(() => {
    // The microphone went away during the count (unplugged, refused, the page hidden):
    // the song must not start by itself afterwards.
    if (count && micflow.state().phase !== 'on') { endCount(false); release(); }
    if (mode !== 'library') paint();
  });

  // The count after the press: the microphone is already on, the song has not moved.
  // Resolves true when the count ran out, false when it was cancelled (stopAll: Space, K,
  // Esc, a sheet, the page hidden or left, the microphone lost). A timer ends it, not the
  // drawing loop, which a covered window does not run.
  function countIn({ take = false } = {}) {
    const sec = SONG.countIn.startSec;
    if (!(sec > 0)) return Promise.resolve(true);
    return new Promise((resolve) => {
      count = { at: performance.now(), sec, take, resolve, timer: setTimeout(() => endCount(true), sec * 1000) };
      paint();
    });
  }
  function endCount(ok) {
    if (!count) return;
    const c = count;
    count = null;
    clearTimeout(c.timer);
    c.resolve(ok);
  }

  const offMicFrame = micflow.onFrame((frame, level) => {
    if (!player || !playing() || !(singing || recActive())) return;
    const t = player.heardTime() - VIEW.voiceLagSec;
    const midi = frame.voiced && Number.isFinite(frame.midi) ? frame.midi : null;
    const target = midi === null ? null : targetAt(t);
    const cents = target === null ? null : 100 * (midi - target);
    // How loud the voice is, smoothed: the height of its light (a point without it is drawn
    // as an even band).
    const at = performance.now();
    if (Number.isFinite(level)) lvNow = follow(at - lvAt > 500 ? null : lvNow, levelToLv(level), Math.min(0.1, (at - lvAt) / 1000), AU.lvSmoothMs);
    lvAt = at;
    trail.push({ t, midi, kind: midi === null ? null : kindOf(cents), lv: lvNow ?? undefined, hue: midi === null ? 0 : clamp((midi - lane.lo) / (lane.hi - lane.lo), 0, 1) });
    while (trail.length && trail[0].t < t - VIEW.trailSec) trail.shift();
    lastRead = midi === null ? null : { midi, cents, at: performance.now() };
    // A practice run is scored from these when it ends (a take from its own saved frames).
    if (run && !run.take) run.frames.push({ t, midi, clarity: frame.clarity, voiced: !!frame.voiced });
    countReading(t, midi);
  });

  // ---- line stars: the counting (cheap: a few sums a reading; no DOM until a line settles)
  function countReading(t, midi) {
    if (!run || !lines.length) return;
    // The song went back by itself (a line on repeat wraps with no jump): what was being
    // counted is closed first, so each pass of the line is its own.
    if (t < run.lastT - 0.05) closeOpenLines();
    run.lastT = t;
    const at = lineIndexAt(lines, t), i = at >= 0 && t < lines[at].end ? at : -1;
    for (const k of counting.keys()) if (k !== i && (!lines[k] || t >= lines[k].end + LS.settleSec)) settleLine(k);
    if (i < 0) return;
    let c = counting.get(i);
    if (!c) counting.set(i, c = newCounts());
    addReading(c, { t, midi, targets: [targetAt(t), targetAt(t - LS.lagSec), targetAt(t + LS.lagSec)] });
  }
  function settleLine(k) {
    const c = counting.get(k);
    counting.delete(k);
    if (!c || !lines[k]) return;
    const r = settle(c, lines[k], k);
    if (run) run.results.set(k, better(run.results.get(k), r));
    const had = stars.get(k), kept = better(had, r);
    stars.set(k, kept);
    // By ear the landing star and the row's new stars wait for the end (spec 10.2).
    if (LEVEL_RANK[r.level] >= LEVEL_RANK.close) { if (!review && !byEarRun()) { putStar(kept); popStar(r); } }
  }
  // A jump, a pause, the end of the song: a line heard to its end is settled, one left in
  // the middle is not (sky spec 2.1).
  function closeOpenLines() {
    for (const k of [...counting.keys()]) { if (lines[k] && heardToEnd(counting.get(k), lines[k])) settleLine(k); else counting.delete(k); }
  }
  const lineSource = () => (spans.length ? 'words' : 'phrases');
  const lastSungMidi = () => { if (!curve) return null; for (let i = curve.t.length - 1; i >= 0; i--) if (curve.voiced[i] && Number.isFinite(curve.midi[i])) return curve.midi[i]; return null; };

  // ---- the star row under the scrub bar. One element a star, changed in place: a star
  // already there is never redrawn, so nothing blinks while a line is being sung.
  const starEls = new Map();
  let trackPx = 0, starSource = 'words';
  const byEarRun = () => byEarNow() && !!run;
  function putStar(r) {
    if (!(LEVEL_RANK[r.level] >= LEVEL_RANK.close)) return;
    const d = duration() || 1, small = trackPx > 0 && lines.length > 0 && trackPx / lines.length < LS.crowdPx;
    const px = (small ? LS.smallStarPx : LS.starPx)[r.level], label = starLabel(r, starSource);
    let el = starEls.get(r.i);
    if (el && el.dataset.level === r.level) return;
    if (!el) { el = h('span', { class: 'sn-star', role: 'listitem' }); starEls.set(r.i, el); $lineStars.append(el); }
    el.dataset.level = r.level;
    el.dataset.line = String(r.i);
    el.title = label;
    el.setAttribute('aria-label', label);
    el.style.left = `${(clamp((r.t + r.end) / 2 / d, 0, 1) * 100).toFixed(3)}%`;
    el.replaceChildren(starSvg('held', px));
  }
  function paintStars() {
    for (const el of starEls.values()) el.remove();
    starEls.clear();
    const sum = review ? review.lines : null;
    starSource = sum ? sum.source : lineSource();
    if (!sum && byEarRun()) return;      // a run by ear: the row is empty until it ends
    for (const r of sum ? sum.results : stars.values()) putStar(r);
  }
  // The scrub bar's width is read here (a resize, a new song), never while a line settles.
  const measureTrack = () => { trackPx = $scrub.clientWidth; };
  const sizer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const was = trackPx; measureTrack(); if (was !== trackPx) paintStars(); }) : null;
  if (sizer) sizer.observe($scrub);
  function popStar(r) {
    if (shell.calm() || !$pop.animate) return;
    $pop.dataset.level = r.level;
    $pop.replaceChildren(starSvg('held', LS.popPx));
    const total = LS.popInMs + LS.popHoldMs + LS.popOutMs;
    $pop.animate([
      { opacity: 0, transform: 'scale(.6)', offset: 0 },
      { opacity: 1, transform: 'scale(1)', offset: LS.popInMs / total, easing: 'linear' },
      { opacity: 1, transform: 'scale(1)', offset: (LS.popInMs + LS.popHoldMs) / total },
      { opacity: 0, transform: 'scale(1)', offset: 1 },
    ], { duration: total, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }

  // ---- the end panel (sky spec 2.4), the shooting star (2.5) and the chime (2.6). All of
  // it happens after the microphone has been released: every caller comes after release().
  const lineOf = (r) => { const i = lines.findIndex((l) => Math.abs(l.t - r.t) < 0.05); return i >= 0 ? i : lines[r.i] ? r.i : -1; };
  const wordsOf = (r, source) => { const i = lineOf(r); return source === 'words' && i >= 0 && spans[i] && spans[i].text ? `“${firstWords(spans[i].text)}”` : `Phrase ${r.i + 1}`; };
  function lineCard(title, r, source, extra) {
    return h('div', { class: 'sn-end-card', dataset: { level: r.level, line: String(r.i) } }, h('h3', null, title),
      h('p', { class: 'sn-end-line' }, LEVEL_RANK[r.level] >= LEVEL_RANK.close ? h('span', { class: 'sn-end-star', dataset: { level: r.level }, title: LEVEL_WORDS[r.level] }, starSvg('held', LS.starPx[r.level])) : null,
        h('strong', null, `${source === 'words' ? 'Line' : 'Phrase'} ${r.i + 1} · ${clock(r.t)}`)),
      h('p', { class: `sn-end-words reason${extra.say ? ' is-say' : ''}` }, extra.say || wordsOf(r, source)), extra.button || null);
  }
  // ---- the letter (grades spec 3, 4, 6). Scored once when a run ends, from that run's own
  // pitch frames: a take from its saved frames (the same call an older take gets when it is
  // opened later, so its letter never changes), practice from the frames heard live.
  const REVEAL = Object.freeze({ strikeMs: 1400, fillFromMs: 250, fillMs: 1150 });   // spec 4.3 (css/grades.css has the same three)
  const takeFramesOf = (take) => (!take || take.songStart === null || take.songStart === undefined ? [] : alignFrames(take.frames || [], take, { nudgeMs: take.nudgeMs || 0 }));
  // ---- ways to sing (spec 10). Kept per song in prefs.ways; a take remembers the ones it was
  // sung with (grade.mods). "No guide voice" is only a way when the song has a singer to take
  // out. "Slower" and "Lower key" are parked (no speed or pitch control in player.js yet).
  const WAYS = Object.freeze([
    Object.freeze({ id: 'noLine', name: 'By ear', line: 'Your pitch line and the In tune words are hidden while you sing. You see them when the take ends.', letter: 'silver' }),
    Object.freeze({ id: 'noGuide', name: 'No guide voice', line: 'The singer’s voice is taken out. You sing with the band alone.', letter: 'counts in full' }),
  ]);
  const WAYS_BUILT = Object.freeze({ noLine: true });
  const WAYS_LOCKED = 'You can change this when the song is stopped.';
  const waysOn = () => {
    const w = song ? prefs.ways[song.id] : null;
    const on = {};
    if (w && w.noLine === true) on.noLine = true;
    if (w && w.noGuide === true && hasGuide) on.noGuide = true;
    return on;
  };
  // While anything listens or plays, the way of singing cannot change under the run.
  const waysLocked = () => playing() || !!count || recActive() || micStarting;
  // The live picture hides the pitch: Sing mode, by ear, never in the review (spec 10.2).
  const byEarNow = () => mode === 'sing' && !review && !!waysOn().noLine;
  const waysWords = () => { const on = waysOn(); return WAYS.filter((w) => on[w.id]).map((w) => w.name); };
  function setWay(id, value) {
    if (!song || waysLocked()) return;
    const next = { ...(prefs.ways[song.id] || {}) };
    if (value) next[id] = true; else delete next[id];
    if (Object.keys(next).length) prefs.ways[song.id] = next; else delete prefs.ways[song.id];
    savePrefs();
    // A practice run is one way of singing: a change starts a new one (its letter is not mixed).
    if (run && !run.take) run = null;
    trail = [];
    setLevels({});      // the guide layer follows "No guide voice"
    paintStars();
  }
  function openWays() {
    if (!song || mode !== 'sing' || waysLocked()) return;
    const on = waysOn();
    const rows = WAYS.map((w) => {
      const cant = w.id === 'noGuide' && !hasGuide;
      const row = switchRow({ label: w.name, note: `${w.line} ${cant ? 'This song has no separate singer’s voice.' : `Your letter: ${w.letter}.`}`, value: !!on[w.id], onChange: (v) => setWay(w.id, v) });
      row.dataset.way = w.id;
      const sw = row.querySelector('.switch');
      if (sw) sw.disabled = cant || waysLocked();
      return row;
    });
    // Done or Esc gives the focus back to the button that opens the sheet, however it was
    // opened (key M left it on Sing; review J9). openSheet's own return runs first.
    const sheet = openSheet({ title: 'Ways to sing', className: 'sheet-ways', onClose: () => { if ($ways.isConnected && !$ways.disabled) $ways.focus({ preventScroll: true }); }, body: [
      h('p', { class: 'reason' }, 'Changes apply at once and are remembered for this song.'),
      ...rows,
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn btn-primary', type: 'button', dataset: { act: 'ways-done' }, onclick: () => sheet.close() }, 'Done')),
    ] });
  }
  function scoreRun({ frames, sum, take = null, practice = false, fresh = true, mods = null }) {
    const bests = readBests(storage);
    let rest = false;
    if (fresh) {
      runs.push({ songId: song.id, line: run && Number.isInteger(run.line) && run.line >= 0 ? run.line : null, at: (run && run.at) || Date.now(), endAt: Date.now() });
      if (runs.length > 60) runs.splice(0, runs.length - 60);
      rest = retryNudge(runs);
    }
    const scored = takeResults({
      frames, targetAt, lines, saved: sum, mods: mods || (fresh ? waysOn() : {}), at: Date.now(), takeId: take ? take.id : null,
      practice, rest, ways: WAYS_BUILT, bests, songId: song.id,
    });
    // Bests are kept per song and way of singing; never for practice or an older take.
    if (fresh && !practice) { const up = updateBests(bests, song.id, scored.result); if (up.isBest) saveBests(storage, up.bests); }
    return scored;
  }
  // An older take opened from My songs: scored the same way, and the result saved with it
  // the first time (in its `lines`, beside the line results).
  function scoreOld(take) {
    if (!take || !review || !review.lines) return null;
    const had = take.lines && take.lines.grade;
    const scored = scoreRun({ frames: takeFramesOf(take), sum: review.lines, take, fresh: false, mods: had ? had.mods || {} : {} });
    if (!had && review.frames.length) { take.lines = { ...review.lines, grade: scored.result }; review.lines = take.lines; takes.update(take.id, { lines: take.lines }); }
    return scored;
  }
  const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches;
  const kbd = (k) => h('kbd', { class: 'keycap' }, k);
  function paintEnd() {
    if (!end) { $end.hidden = true; return; }
    const sum = end.sum, head = headingWords(sum), byI = new Map(sum.results.map((r) => [r.i, r]));
    const best = sum.best === null ? null : byI.get(sum.best), prac = sum.practise === null ? null : byI.get(sum.practise);
    const sc = end.scored, running = end.reveal === 'run';
    const rest = !!sc && sc.advice.id === 'rest';
    // The coach's one line comes first in reading order; focus still lands on the heading,
    // which points back at it (spec 4.1).
    const $advice = sc ? h('p', { class: 'sn-end-advice', id: 'sn-end-advice', dataset: { id: sc.advice.id } }, icon(sc.advice.icon || 'wave', 20),
      h('span', null, h('strong', null, sc.advice.said), ` Next go: ${sc.advice.next}`)) : null;
    // Part of the song with too few lines for line stars: say what was sung, never "Too short
    // for line stars" beside "Part of the song" (review J2, spec 20).
    const $head = h('h2', { class: 'sn-end-head', id: 'sn-end-head', tabindex: '-1', 'aria-describedby': sc ? 'sn-end-advice' : null },
      sc && sc.grade.state === 'sangTooLittle' && !head.cards ? `You sang ${sum.sung} of ${sum.total} lines.` : head.text);
    const cards = [];
    const pi = prac ? lineOf(prac) : -1;
    if (head.cards && best) cards.push(lineCard('Your best line', best, sum.source, {
      button: review && lineOf(best) >= 0 ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-end-hear', onclick: () => hearLine(lineOf(best)) }, 'Hear it') : null }));
    if (head.cards && prac) cards.push(lineCard('A line to practise', prac, sum.source, { say: reasonWords(prac),
      button: pi >= 0 ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-end-practise', onclick: () => retryLine(pi) }, 'Retry this line', ' ', kbd('L')) : null }));
    else if (head.cards && best) cards.push(h('div', { class: 'sn-end-card' }, h('h3', null, 'A line to practise'), h('p', null, 'No line to practise. That was a clean run.')));
    // One "new best" chip: the letter's when there is one, else the line count's (spec 6.1).
    const chip = sc && sc.best.chip ? sc.best.chip : end.best ? { id: 'new', text: 'New best for this song', tone: 'gold' } : null;
    const next = sc && sc.best.next && sc.best.next.panel ? sc.best.next.text : '';
    const $grade = sc ? h('div', { class: 'sn-grade' }) : null;
    if ($grade) mountMedallion($grade, sc.medallion, { size: narrow() ? 72 : 96, reveal: running, calm: shell.calm() });
    end.medalPx = narrow() ? 72 : 96;
    $end.replaceChildren(...[
      $advice, $grade,
      h('div', { class: 'sn-end-main' }, $head,
        // The chip's and the best line's boxes are there from the first frame (no jump).
        h('p', { class: 'sn-end-chip-line' }, chip ? h('span', { class: chip.id === 'new' ? 'sn-end-best' : 'sn-chip', dataset: { tone: chip.tone || 'plain', chip: chip.id } }, chip.id === 'new' ? starSvg('held', 14) : null, chip.id === 'new' ? ` ${chip.text}` : chip.text) : null),
        sc ? h('p', { class: 'sn-best-line' }, sc.best.words, next ? h('span', { class: 'sn-best-next' }, `${sc.best.words ? ' ' : ''}${next}`) : null) : null),
      ...cards,
      h('div', { class: 'sn-end-actions action-row' },
        rest ? h('button', { class: 'btn btn-primary btn-small', type: 'button', id: 'sn-end-rest', onclick: () => startRest() }, 'Rest for a minute') : null,
        end.practice ? h('button', { class: `btn ${rest ? 'btn-secondary' : 'btn-primary'} btn-small`, type: 'button', id: 'sn-end-again', onclick: () => { closeEnd({ focus: false }); jump((o) => transport.restart(o)).then(() => sing()); } }, 'Sing it again') : null,
        end.practice ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-end-record', onclick: () => retrySong() }, 'Record a take', ' ', kbd('R'))
          : h('button', { class: `btn ${rest ? 'btn-secondary' : 'btn-primary'} btn-small`, type: 'button', id: 'sn-end-retry', onclick: () => retrySong() }, 'Retry song', ' ', kbd('R')),
        sc ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-end-full', onclick: () => openLayer() }, 'Full results', ' ', kbd('F')) : null,
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-end-close', onclick: () => closeEnd() }, 'Close')),
    ].filter(Boolean));
    $end.classList.toggle('has-grade', !!sc);
    $end.setAttribute('aria-label', sc ? 'Results' : 'Line results');
    $end.hidden = !end.open;
    $end.dataset.calm = shell.calm() ? 'on' : 'off';
    $end.dataset.reveal = running ? 'run' : 'done';
    $end.dataset.band = sc && sc.medallion.band ? 'on' : 'off';
    if (running && sc && !shell.calm()) countUp($end.querySelector('.mg-percent'), sc.medallion.percent);
  }
  // The panel's medallion follows the window across 900 px after it was mounted (72 / 96;
  // review J12). Remounted in its final state; during the reveal finishReveal does it.
  function fitMedal() {
    const $grade = end && end.open && end.scored && end.reveal === 'done' ? $end.querySelector('.sn-grade') : null;
    const px = narrow() ? 72 : 96;
    if (!$grade || end.medalPx === px) return;
    mountMedallion($grade, end.scored.medallion, { size: px, reveal: false, calm: true });
    end.medalPx = px;
  }
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(max-width: 899px)');
    if (mq.addEventListener) on(mq, 'change', fitMedal);
  }
  // The percent counts up with the ring (spec 4.3): its text only, once a frame.
  function countUp(el, to) {
    if (!el || !Number.isFinite(to)) return;
    const t0 = performance.now();
    el.textContent = '0 %';
    const step = () => {
      if (!end || end.reveal !== 'run' || !el.isConnected) { el.textContent = `${to} %`; return; }
      const k = clamp((performance.now() - t0 - REVEAL.fillFromMs) / REVEAL.fillMs, 0, 1), eased = 1 - (1 - k) ** 3;
      el.textContent = `${Math.floor(to * eased)} %`;
      if (k < 1) requestAnimationFrame(step); else el.textContent = `${to} %`;
    };
    requestAnimationFrame(step);
  }
  function openEnd() {
    if (!end && review && review.lines) end = { sum: review.lines, open: false, practice: false, best: false, timer: 0, scored: scoreOld(review.take), reveal: 'done', shower: false };
    if (!end) return;
    const was = end.open;
    end.open = true;
    paintEnd();
    paint();
    if (!was) { const $h = $end.querySelector('.sn-end-head'); if ($h) $h.focus({ preventScroll: true }); }
  }
  function closeEnd({ focus = true } = {}) {
    if (!end) return;
    if (end.reveal === 'run') finishReveal({ chime: false });
    clearTimeout(end.timer);
    end.timer = 0;
    const was = end.open;
    end.open = false;
    $end.hidden = true;
    if (was && focus) $primary.focus({ preventScroll: true });
  }
  // The results of a run that has just ended (spec 4.3). The panel opens AT ONCE. When the
  // run may celebrate (ended by Stop, the end or the time limit; microphone released; page
  // seen; no sheet) a shooting star flies to the medallion while its ring fills, and the
  // letter lands with the chime at 1.4 s. Calm motion: the final state, and the chime.
  function showEnd(sum, { practice = false, best = false, celebrate = false, scored = null } = {}) {
    if (end) clearTimeout(end.timer);
    // A new best with a letter, or by lines with the singer, fires the shower once (6.1).
    const shower = best || !!(scored && scored.best.shower);
    end = { sum, open: false, practice, best, timer: 0, scored, reveal: 'done', shower };
    const may = celebrate && micflow.state().phase !== 'on' && !document.hidden && !sheetOpen();
    if (!may || shell.calm() || !scored) { openEnd(); if (may) endChime(); return; }
    end.reveal = 'run';
    openEnd();
    // Star one goes to the medallion; a new best sends two more to the last two "with" stars.
    const withStars = sum.results.filter((r) => r.level === 'with');
    const more = shower ? withStars.slice(Math.max(0, withStars.length - (LS.shower - 1))) : [];
    const targets = [() => $end.querySelector('.mg-face'), ...more.map((r) => () => starEls.get(r.i))];
    targets.forEach((get, k) => setTimeout(() => { if (end && end.sum === sum && end.reveal === 'run') shootStar(get(), k, targets.length, REVEAL.strikeMs - k * LS.showerGapMs); }, k * LS.showerGapMs));
    end.timer = setTimeout(() => finishReveal({ chime: !document.hidden && !sheetOpen() }), REVEAL.strikeMs);
  }
  // The strike, or any key or press during the reveal: the final state at once, and the
  // chime once.
  function finishReveal({ chime = true } = {}) {
    if (!end || end.reveal !== 'run') return;
    clearTimeout(end.timer);
    end.timer = 0;
    end.reveal = 'done';
    for (const el of document.querySelectorAll('.sn-streak')) el.remove();
    $end.dataset.reveal = 'done';
    const mg = $end.querySelector('.mg');
    if (mg) mg.dataset.reveal = 'done';
    const pc = $end.querySelector('.mg-percent');
    if (pc && end.scored && end.scored.medallion.percentText) pc.textContent = end.scored.medallion.percentText;
    if (chime) endChime();
    fitMedal();
    swellStars();
    paint();
  }
  function shootStar(to, k, count, ms = LS.streakMs) {
    if (micflow.state().phase === 'on' || !to || !document.body.animate) return;
    const stage = $stage.getBoundingClientRect(), star = to.getBoundingClientRect();
    // Star one starts a third of the way along the stage's top, so it crosses to the medallion
    // (under 8 %) at an angle instead of dropping straight onto it (spec 20); a shower's
    // others start from places along the top edge.
    const x0 = stage.left + stage.width * (k === 0 ? 0.34 : 0.08 + k * 0.22), y0 = stage.top + stage.height * 0.12;
    const x1 = star.left + star.width / 2, y1 = star.top + star.height / 2;
    const angle = Math.atan2(y1 - y0, x1 - x0), len = Math.min(LS.streakLenPx, Math.hypot(x1 - x0, y1 - y0) * 0.6);
    const el = h('div', { class: 'sn-streak', 'aria-hidden': 'true', style: `width:${len.toFixed(0)}px` }, h('i', null));
    document.body.append(el);
    sky.streaks++;
    sky.micAtStreak = micflow.state().phase;
    const at = (x, y) => `translate(${(x - len).toFixed(1)}px, ${(y - 1).toFixed(1)}px) rotate(${angle.toFixed(4)}rad)`;
    const fly = Math.max(LS.streakInMs + 1, ms), total = fly + LS.tailMs;
    el.animate([
      { transform: at(x0, y0), opacity: 0, offset: 0 },
      { opacity: 1, offset: LS.streakInMs / total },
      { transform: at(x1, y1), opacity: 1, offset: fly / total, easing: 'linear' },
      { transform: at(x1, y1), opacity: 0, offset: 1 },
    ], { duration: total, easing: 'cubic-bezier(.45, 0, .25, 1)', fill: 'both' }).finished.then(() => el.remove(), () => el.remove());
  }
  function swellStars() {
    const els = [...starEls.values()].sort((a, b) => Number(a.dataset.line) - Number(b.dataset.line));
    const step = Math.min(LS.swellStepMs, LS.swellSpanMs / Math.max(1, els.length));
    els.forEach((el, k) => { if (el.animate) el.animate([{ transform: 'translate(-50%, -50%) scale(1)' }, { transform: 'translate(-50%, -50%) scale(1.35)' }, { transform: 'translate(-50%, -50%) scale(1)' }], { duration: LS.swellMs, delay: k * step, easing: 'cubic-bezier(.2, .8, .2, 1)' }); });
  }
  // One chime as the letter lands, on the last sung note, growing with the letter (spec
  // 4.4). Through the page's own way out (the lab's silent seam mutes it), never while the
  // song plays or the microphone is judged, and only with "Reward sounds" on and headphones
  // confirmed.
  function endChime() {
    if (!ctx || !outNode || playing() || !canChime({ enabled: settings.get('rewardSounds'), headphones: shell.headphones(), scoring: micflow.state().phase === 'on' })) return;
    if (!synth) synth = createSynth({ audioContext: ctx, destination: outNode });
    const plan = endChimePlan(lastSungMidi(), { best: !!(end && end.shower), grade: end && end.scored ? end.scored.grade : null });
    playChime(synth, plan, CONFIG.rewards.chimeGainFrac * levels.volume);
    sky.chimes++;
    sky.lastChime = plan.map((n) => n.midi);
  }
  function endOfPractice() {
    if (!run || run.take) return;
    const sum = summarise([...run.results.values()], { total: lines.length, source: lineSource() });
    const scored = scoreRun({ frames: run.frames, sum, practice: true });
    run = null;
    paintStars();      // by ear, the run's stars come in now, with the panel
    showEnd(sum, { practice: true, celebrate: true, scored });
  }

  // ---- retry (spec 6.2): R records the song again from the top, L sings the line to
  // practise on repeat; both start the count at once. A take not kept or discarded is kept.
  async function retrySong() {
    if (!transport || recActive() || count || micStarting) return;
    closeLayer({ focus: false });
    closeEnd({ focus: false });
    if (review) leaveReview();
    await jump((o) => transport.restart(o));
    record();
  }
  async function retryLine(i) {
    if (!transport || !lines[i] || recActive() || count || micStarting) return;
    closeLayer({ focus: false });
    await practiseLine(i);
    sing();
  }
  const practiseIndex = () => { if (!end || end.sum.practise === null) return -1; const r = end.sum.results.find((x) => x.i === end.sum.practise); return r ? lineOf(r) : -1; };

  // ---- the full results layer (spec 5; js/app/song/resultsview.js draws it)
  async function openLayer() {
    if (!end) openEnd();
    if (!end || !end.scored || layer) return;
    if (playing()) player.pause('stop');
    const bests = readBests(storage), top = bestAny(bests, song.id);
    const mine = await store.takesOf(song.id).catch(() => []);
    if (!end || layer) return;
    const pi = practiseIndex();
    // The bottom row's two line cards (spec 5.1), the panel's own cards with the layer's ids.
    const sum = end.sum, head = headingWords(sum), byI = new Map(sum.results.map((r) => [r.i, r]));
    const bestR = sum.best === null ? null : byI.get(sum.best), pracR = sum.practise === null ? null : byI.get(sum.practise);
    const lineCards = [];
    if (head.cards && bestR) lineCards.push(lineCard('Your best line', bestR, sum.source, {
      button: review && lineOf(bestR) >= 0 ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-results-hear', onclick: () => { closeLayer({ focus: false }); hearLine(lineOf(bestR)); } }, 'Hear it') : null }));
    if (head.cards && pracR) lineCards.push(lineCard('A line to practise', pracR, sum.source, { say: reasonWords(pracR),
      button: pi >= 0 ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-results-practise', onclick: () => retryLine(pi) }, 'Retry this line', ' ', kbd('L')) : null }));
    else if (head.cards && bestR) lineCards.push(h('div', { class: 'sn-end-card' }, h('h3', null, 'A line to practise'), h('p', null, 'No line to practise. That was a clean run.')));
    layer = resultsView({
      lineCards,
      title: song.title, when: review ? dateWords(review.take.createdAt) : '', scored: end.scored, practice: end.practice,
      keep: end.practice || !review ? null : review.fresh ? 'ask' : 'kept',
      retryLine: pi >= 0 ? { index: pi, label: `Retry ${lineSource() === 'words' ? 'line' : 'phrase'} ${pi + 1}` } : null,
      takes: (Array.isArray(mine) ? mine : []).map((t) => { const w = takeWords(t.lines && t.lines.grade); return { id: t.id, when: dateWords(t.createdAt), words: w.words, chips: w.chips, best: !!(top && top.result.takeId && top.result.takeId === t.id), current: !!review && review.take.id === t.id, gone: false }; }),
      calm: shell.calm(),
    }, {
      close: () => closeLayer(), retrySong: () => retrySong(), retryLine: () => { if (pi >= 0) retryLine(pi); },
      keep: async () => { await keepTake(); closeLayer({ focus: false }); openLayer(); },
      discard: async () => { closeLayer({ focus: false }); await discardTake(); },
      playTake: (id) => { closeLayer({ focus: false }); openSong(song.id, { takeId: id }); },
    });
    root.append(layer);
    const $h = layer.querySelector('.sn-results-head');
    if ($h) $h.focus({ preventScroll: true });
  }
  function closeLayer({ focus = true } = {}) {
    if (!layer) return;
    layer.remove();
    layer = null;
    const back = $end.querySelector('#sn-end-full');
    if (focus && back && !$end.hidden) back.focus({ preventScroll: true });
  }

  // ---- the rest (spec 9): a quiet pill beside the scrub row, its number once a second.
  function startRest() {
    closeLayer({ focus: false });
    stopRest();
    resting = { until: Date.now() + 60000, timer: setInterval(paintRest, 1000), done: 0 };
    paintRest();
  }
  function stopRest() { if (resting) { clearInterval(resting.timer); clearTimeout(resting.done); } resting = null; $rest.hidden = true; }
  function paintRest() {
    if (!resting) { $rest.hidden = true; return; }
    const left = Math.max(0, Math.ceil((resting.until - Date.now()) / 1000));
    $rest.hidden = false;
    if (left > 0) { $restWords.textContent = `Resting · ${clock(left)}`; $restSkip.hidden = false; return; }
    clearInterval(resting.timer);
    $restWords.textContent = 'Rested. Ready when you are.';
    $restSkip.hidden = true;
    if (!resting.done) resting.done = setTimeout(stopRest, 4000);
  }
  // "Hear it": the take's own line, from its first moment to its end (frame() stops it).
  async function hearLine(i) {
    if (!transport || !lines[i]) return;
    closeEnd({ focus: false });
    await transport.toLine(i, { exact: true });
    transport.play();
    hearUntil = lines[i].end;
  }
  // The line to practise: the take is kept and the line is put on repeat. "Retry this line"
  // (retryLine, key L) then starts the count at once (grades spec 6.2).
  async function practiseLine(i) {
    if (!transport || !lines[i]) return;
    closeEnd({ focus: false });
    if (review) leaveReview();
    if (playing()) player.pause('stop');
    await transport.toLine(i, { exact: true });
    transport.loopLine(i);
    everPlayed = false;
    paint();
    $primary.focus({ preventScroll: true });
  }

  async function needPhones() {
    const answer = await shell.needHeadphones();
    if (answer === 'on') return true;
    toast('Song mode needs headphones before the microphone turns on. Listen plays the song without it.');
    return false;
  }

  // Sing: headphones, then the microphone (from this press), then the count, then the music.
  async function sing() {
    if (micStarting || count || !transport || mode !== 'sing') return;
    micStarting = true;
    try {
      ownSheet = 'sheet-phones';
      if (!(await needPhones())) return;
      ownSheet = 'sheet-mic';
      if (!(await micflow.request())) return;
      micflow.setListening(true);
      singing = true;
    } finally { micStarting = false; ownSheet = ''; paint(); }
    if (playing()) return;
    // Cancelled: whatever cancelled it has released the microphone already.
    if (!(await countIn())) { paint(); return; }
    if (transport && mode === 'sing' && singing && !playing()) transport.play();
    paint();
  }
  function listen() {
    if (!transport || count) return;
    if (playing()) transport.pause(); else transport.play();
  }
  function primary() {
    if (!transport) return;
    if (mode === 'tap') { tapPress(); return; }
    if (count) { stopAll('stop'); paint(); return; }
    if (recActive()) { stopTake(); return; }
    if (playing()) { transport.pause(); return; }
    if (mode === 'review') { transport.play(); return; }
    sing();
  }
  function recordPress() { if (recActive()) stopTake(); else record(); }
  async function record() {
    if (micStarting || count || !transport || mode !== 'sing') return;
    let plan = null;
    micStarting = true;
    try {
      ownSheet = 'sheet-phones';
      if (!(await needPhones())) return;
      ownSheet = '';
      // From the phrase under the now line (or the next one, in a rest), a count-in early.
      const t = player.time();
      const i = lines.findIndex((l) => l.end > t);
      // Before the microphone: is there room to keep this take at all? (16-bit, one channel.)
      const room = await takes.wouldRemove(Math.round(Math.max(1, duration() - t) * ctx.sampleRate * 2));
      if (!room.fits && room.reason === 'pinned') { toast(room.words); return; }
      // A sheet opened, or the page was hidden, while the room was looked up: no start.
      if (sheetOpen() || document.hidden) return;
      const where = i >= 0 ? { line: i } : { from: t, exact: true };
      // The microphone opens on this press; the take itself starts when the count is over.
      if (playing()) player.pause('stop');
      ownSheet = 'sheet-mic';
      if (!(await micflow.request())) { toast(START_WORDS['no-microphone']); return; }
      micflow.setListening(true);
      // Show where the take will begin while the count runs.
      player.seek(transport.planTake(where).fromSec);
      plan = where;
    } finally { micStarting = false; ownSheet = ''; paint(); }
    if (!plan || !(await countIn({ take: true }))) { paint(); return; }
    if (!transport || mode !== 'sing') { release(); return; }
    micStarting = true;
    try {
      const res = await transport.startTake(plan);
      if (!res.ok) { toast(START_WORDS[res.reason] || START_WORDS.failed); release(); }
      else micflow.setListening(true);
    } finally { micStarting = false; paint(); }
  }
  // Stop and keep: the take ends by 'stop' (asked for first), and in the same turn the music
  // stops and the microphone is released, without waiting for the take to be written.
  function stopTake() {
    if (!transport) return;
    Promise.resolve(transport.stopTake('stop')).catch(() => {});
    if (playing()) player.pause('stop');
    release();
  }

  // A jump while a take is being recorded is held until the owner agrees (transport.js).
  async function jump(act) {
    if (!transport) return;
    const res = await act({});
    if (res && res.held) showHold(act);
  }
  function showHold(act) {
    hideHold();
    hold = { act, timer: setTimeout(hideHold, 6000) };
    $hold.hidden = false;
  }
  function hideHold() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
    $hold.hidden = true;
  }
  function agreeHold() {
    const act = hold && hold.act;
    hideHold();
    if (act) act({ endTake: true });
  }

  // The three levels go to the sound and, with a song open, into that song's kept mix.
  // In the take review the backing and the guide belong to Balance (mix.js): they are
  // left alone there and put back by leaveReview.
  function setLevels(next) {
    levels = songMix({ ...levels, ...next });
    if (song) { keepSongMix(prefs.mixes, song.id, levels); savePrefsSoon(); }
    if (player) {
      player.setVolume(levels.volume);
      if (!review) { player.setBackingGain(levels.music); if (hasGuide) player.setLayerGain('guide', guideHeard()); }
    }
    paint();
  }
  // "No guide voice" takes the singer out without moving the Singer level kept for the song.
  function guideHeard() { return waysOn().noGuide ? 0 : levels.singer; }
  const setMusic = (v) => setLevels({ music: clamp(Number(v) || 0, 0, 1) });
  const setGuide = (v) => setLevels({ singer: clamp(Number(v) || 0, 0, 1) });
  const setVolume = (v) => setLevels({ volume: clamp(Number(v) || 0, 0, 1) });
  // A quick button is one press, not a drag: its mix is saved at once.
  const setMixPreset = (name) => { if (MIX_PRESETS[name]) { setLevels(MIX_PRESETS[name]); flushPrefs(); } };
  function setOctave(v) {
    const next = clamp(Math.round(v), -1, 1);
    if (!song || next === octave) return;
    octave = next;
    song.octave = next;
    store.update(song.id, { octave: next });
    trail = [];
    counting = new Map();            // a line half counted against the old octave is dropped
    if (review) reviewFrames();      // the recorded line's colours are against the moved singer
    paint();
  }

  // ================================================================ takes and the review

  async function onTake(take) {
    hideHold();
    // The song was left while recording (back to My songs): the take is kept and listed there.
    if (!song || !take || take.songId !== song.id) { if (take) toast('Your take is kept. It is listed under the song.'); paintLibrary(); return; }
    if (playing()) player.pause('stop');
    release();
    if (!take) { paint(); return; }
    if (!(take.seconds >= VIEW.minTakeSec)) {
      if (take.saved && take.saved.ok) await takes.remove(take.id);
      toast('Nothing was sung, so no take was kept.');
      paint();
      return;
    }
    if (take.saved && !take.saved.ok) toast(take.saved.words);
    else if (take.saved && take.saved.words) toast(take.saved.words);
    else if (TAKE_END_WORDS[take.endedBy]) toast(TAKE_END_WORDS[take.endedBy]);
    // What the owner earned in this take is saved with it, as earned (a later timing nudge
    // takes no star away).
    closeOpenLines();
    const sum = summarise(run && run.take ? [...run.results.values()] : [], { total: lines.length, source: lineSource() });
    // The letter, from the take's own saved frames (spec 3.1); kept beside the line results
    // (takes.js keeps `lines` as given and no other new field).
    const scored = scoreRun({ frames: takeFramesOf(take), sum, take });
    run = null;
    take.lines = { ...sum, grade: scored.result };
    takes.update(take.id, { lines: take.lines });
    const best = newBest(sum, song.bestLines);
    if (best) { song.bestLines = { with: sum.with, total: sum.total, takeId: take.id, at: new Date().toISOString() }; store.update(song.id, { bestLines: song.bestLines }); }
    enterReview(take, { fresh: true });
    showEnd(take.lines, { best, celebrate: CELEBRATE_ENDS.includes(take.endedBy), scored });
  }

  function reviewFrames() {
    const t = review.take;
    const moved = t.songStart === null || t.songStart === undefined ? [] : alignFrames(t.frames || [], t, { nudgeMs: t.nudgeMs || 0 });
    // Each point's verdict is worked out here, once (and again when the octave or the timing
    // nudge changes), never per drawn frame.
    review.frames = moved.filter((f) => Number.isFinite(f.t)).map((f) => {
      const midi = f.voiced !== false && Number.isFinite(f.midi) ? f.midi : null, target = midi === null ? null : targetAt(f.t);
      return { t: f.t, midi, kind: midi === null ? null : kindOf(target === null ? null : 100 * (midi - target)) };
    });
    review.times = review.frames.map((f) => f.t);
  }
  function enterReview(take, { fresh }) {
    if (review) leaveReview();
    const kept = prefs.balances[take.id];
    review = { take, fresh, mix: null, balance: Number.isFinite(kept) ? clamp(kept, 0, 1) : SONG.mix.balance, frames: [], times: [] };
    mode = 'review';
    try {
      review.mix = createMixPlayback({ player, take, balance: review.balance });
      // In the review the owner is heard in the singer's place.
      if (hasGuide) player.setLayerGain('guide', 0);
      player.seek(Math.max(0, review.mix.state().at));
    } catch { review.mix = null; }
    reviewFrames();
    // An older take has no line results: it is scored once from its own line, by the same
    // rule, and that is saved.
    if (take.lines && take.lines.v === 1 && Array.isArray(take.lines.results)) review.lines = take.lines;
    else {
      review.lines = summarise(scoreLines({ lines, frames: review.frames, targetAt }), { total: lines.length, source: lineSource() });
      take.lines = review.lines;
      if (review.frames.length) takes.update(take.id, { lines: review.lines });
    }
    paintStars();
    $balance.value = String(review.balance);
    paint();
  }
  function leaveReview() {
    if (!review) return;
    if (playing()) player.pause('stop');
    // Leaving without choosing keeps the take.
    if (review.fresh) takes.update(review.take.id, { isNew: false });
    if (review.mix) review.mix.destroy();
    review = null;
    closeEnd({ focus: false });
    end = null;
    paintStars();      // back to this visit's own stars
    // Balance had the backing and the guide; they go back to this song's own sliders
    // (mix.destroy() left the backing at full).
    if (player) { player.setBackingGain(levels.music); if (hasGuide) player.setLayerGain('guide', guideHeard()); }
    mode = song ? 'sing' : 'library';
    paint();
  }
  function setBalance(b) {
    if (!review) return;
    review.balance = clamp(Number(b) || 0, 0, 1);
    if (Number($balance.value) !== review.balance) $balance.value = String(review.balance);
    if (review.mix) review.mix.setBalance(review.balance);
    paint();
  }
  // Remembered with the take (in this page's settings), when the slider is let go.
  function keepBalance() {
    if (!review) return;
    delete prefs.balances[review.take.id];
    prefs.balances[review.take.id] = review.balance;
    const ids = Object.keys(prefs.balances);
    for (const id of ids.slice(0, Math.max(0, ids.length - KEPT_BALANCES))) delete prefs.balances[id];
    savePrefs();
  }
  function setNudge(dir) {
    if (!review || !review.mix) return;
    const ms = review.mix.setNudge((review.take.nudgeMs || 0) + dir * SONG.align.nudge.step);
    review.take.nudgeMs = ms;
    takes.setNudge(review.take.id, ms);
    reviewFrames();
    paint();
  }
  async function keepTake() {
    if (!review) return;
    await takes.update(review.take.id, { isNew: false });
    review.fresh = false;
    toast('Take kept on this Mac');
    paint();
  }
  async function discardTake() {
    if (!review) return;
    if (!(await confirmSheet({ title: 'Discard this take?', body: 'It is removed from this Mac. This cannot be undone.', yes: 'Discard', no: 'Keep it' }))) return;
    const id = review.take.id;
    review.fresh = false;
    leaveReview();
    delete prefs.balances[id];
    savePrefs();
    await takes.remove(id);
    toast('Take discarded');
  }
  const save = (wav, name) => { if (hooks.saveFile) hooks.saveFile(wav, name); else downloadWav(wav, name); };
  function saveMixed() {
    if (!review) return;
    // Allowed because the backing is the owner's own file (mix.js refuses anything else).
    const res = exportMix({ backing: player.backing(), take: review.take, at: review.mix ? review.mix.state().at : null, balance: review.balance, ownFile: song.kind === 'file', title: song.title });
    if (!res.ok) { toast(res.words); return; }
    save(res.wav, res.name);
    toast(`Saved “${res.name}” (${megabytes(res.wav.byteLength)}): your voice and the song at the balance you set.`);
  }
  function saveVoice() {
    if (!review) return;
    const wav = encodeWav([review.take.samples], review.take.sampleRate);
    const name = `${song.title} - my voice.wav`;
    save(wav, name);
    toast(`Saved “${name}” (${megabytes(wav.byteLength)}).`);
  }

  // ================================================================ words

  const lineCount = (w) => (w ? w.lines.filter((l) => l.text).length : 0);
  async function keepWords(words) {
    await store.setWords(song.id, words);
    song.words = words;
    refreshLines();
    paint();
  }

  function openWords() {
    if (!song) return;
    const $body = h('div', { class: 'sn-words-sheet' });
    const sheet = openSheet({ title: `Words for ${song.title}`, className: 'sheet-words', body: $body });
    const authors = () => h('p', { class: 'reason sn-authors' }, AUTHORS_WORDS);
    const go = (view) => { $body.replaceChildren(...view().flat().filter(Boolean)); };

    const home = () => {
      const w = song.words, n = lineCount(w);
      const $shift = h('strong', null, '');
      const sayShift = () => { const s = Math.round((song.words.offsetSec || 0) * 10) / 10; $shift.textContent = s === 0 ? 'All lines: as they came' : `All lines: ${Math.abs(s)} seconds ${s > 0 ? 'later' : 'earlier'}`; };
      const shift = async (d) => { await keepWords(nudgeAll(song.words, d)); sayShift(); };
      if (w) sayShift();
      return [
        w && h('div', { class: 'card sn-words-have' },
          h('p', null, `This song has ${n} ${n === 1 ? 'line' : 'lines'}, ${spans.length === n ? 'timed line by line' : spans.length ? `${spans.length} of them timed` : 'not timed yet'}.${w.credit ? ` ${w.credit}.` : ''}`),
          spans.length ? h('div', { class: 'action-row' },
            h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-shift-early', onclick: () => shift(-0.1) }, '− 0.1 s earlier'), $shift,
            h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-shift-late', onclick: () => shift(0.1) }, '0.1 s later +')) : null,
          h('div', { class: 'action-row' },
            h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-retap', onclick: () => { sheet.close(); startTap(song.words); } }, 'Fix the timing'),
            h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-words-remove', onclick: async () => { await keepWords(null); toast('Words removed from this Mac'); go(home); } }, 'Remove the words'))),
        h('div', { class: 'sn-words-cards' },
          h('div', { class: 'card' }, h('h3', null, 'Paste the words'),
            h('p', null, 'Type or paste them, one sung line per row. They are matched to the singing by themselves when that can be done; “Fix the timing” is there when it cannot.'),
            h('button', { class: 'btn btn-secondary', type: 'button', id: 'sn-paste', onclick: () => go(paste) }, 'Paste the words')),
          h('div', { class: 'card' }, h('h3', null, 'Look them up'),
            h('p', null, prefs.autoWords ? 'Asks LRCLIB, a free lyrics site, again: for another version, or under another title. Sends the title and artist only.' : 'Asks LRCLIB, a free lyrics site, for words already timed line by line. Sends the title and artist only, and only when you press.'),
            h('button', { class: 'btn btn-secondary', type: 'button', id: 'sn-lookup', onclick: () => go(look) }, 'Look them up…'))),
        h('p', { class: 'reason' }, 'No words is fine too: “Your turn”, the rests and the tune are all a song needs.'),
        authors(),
      ];
    };

    const paste = () => {
      const $count = h('span', { class: 'reason' }, '');
      const $text = h('textarea', { class: 'select sn-paste-text', id: 'sn-paste-text', rows: '12', 'aria-label': 'The words, one sung line per row' });
      $text.value = song.words ? song.words.lines.filter((l) => l.text).map((l) => l.text).join('\n') : '';
      // Timed text in the "[mm:ss.xx] line" form keeps its times; plain rows are untimed.
      const read = () => { const lrc = parseLrc($text.value); return lrc.timed ? makeWords(lrc.lines, { route: 'typed' }) : makeWords(parseWords($text.value), { route: 'typed' }); };
      const count = () => { const n = lineCount(read()); $count.textContent = `${n} ${n === 1 ? 'line' : 'lines'}`; return n; };
      $text.addEventListener('input', count);
      count();
      return [
        h('p', null, 'One sung line per row.'), $text, $count,
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', id: 'sn-paste-keep', onclick: async () => {
            if (!count()) { $text.focus(); return; }
            let words = read(), said = 'Words kept with the times they came with.';
            if (words.timing !== 'line') {
              // No tapping asked for: the rows are dealt out to the sung stretches when that is settled enough.
              const fit = fitByLine({ lines: words.lines, phrases });
              if (fit.ok) { words = makeWords(fit.lines, { route: 'typed' }); said = 'Words kept and matched line by line to the singing.'; }
              else said = 'Words kept. They could not be matched to the singing by themselves: “Fix the timing” in Words does it by tapping along.';
            }
            await keepWords(words);
            sheet.close();
            toast(said);
          } }, 'Keep the words'),
          h('button', { class: 'btn btn-secondary', type: 'button', id: 'sn-paste-next', onclick: async () => {
            if (!count()) { $text.focus(); return; }
            const words = read();
            await keepWords(words);
            sheet.close();
            if (words.timing !== 'line') startTap(words); else toast('Words kept with the times they came with.');
          } }, 'Fix the timing: tap along'),
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => go(home) }, 'Back')),
        authors(),
      ];
    };

    const look = () => {
      const $t = h('input', { type: 'text', class: 'select', id: 'sn-look-title', value: song.title }), $a = h('input', { type: 'text', class: 'select', id: 'sn-look-artist', value: song.artist || '' });
      const $out = h('div', { class: 'sn-look-out', 'aria-live': 'polite' });
      const offline = navigator.onLine === false;
      const use = async (r, anyway = false) => {
        if (!r.timed) {
          const words = makeWords(r.lines.filter((l) => l.text).map((l) => ({ t: null, end: null, text: l.text })), { route: 'lookup', credit: 'Words found through LRCLIB' });
          await keepWords(words);
          $out.replaceChildren(h('p', null, 'These words are kept, but they have no timing. You can sing with the cues, or fix the timing by tapping along once.'),
            h('button', { class: 'btn btn-secondary', type: 'button', id: 'sn-look-tap', onclick: () => { sheet.close(); startTap(words); } }, 'Fix the timing'));
          return;
        }
        const fit = fitOffset(r.lines, phrases, { duration: song.duration, wordsDuration: r.duration });
        const words = makeWords(r.lines, { route: 'lookup', offsetSec: fit.offsetSec || 0, autoOffsetSec: fit.offsetSec || 0, credit: 'Words found through LRCLIB' });
        if (!fit.ok && !anyway) {
          $out.replaceChildren(h('p', { id: 'sn-look-differs' }, icon('info', 16), fit.why === 'count'
            ? ` These words look like a different version: ${fit.lines} timed lines for the ${fit.phrases} stretches the singer sings in your file.`
            : ' These words look like a different version: they do not line up with the singing in your file.'),
            h('div', { class: 'action-row' },
              h('button', { class: 'btn btn-primary', type: 'button', id: 'sn-look-tap', onclick: async () => { await keepWords(words); sheet.close(); startTap(words); } }, 'Fix the timing'),
              h('button', { class: 'btn btn-secondary', type: 'button', id: 'sn-look-anyway', onclick: () => use(r, true) }, 'Use them anyway')));
          return;
        }
        await keepWords(words);
        const s = Math.round((fit.offsetSec || 0) * 10) / 10;
        sheet.close();
        toast(s === 0 ? 'Words fitted as they came.' : `Words fitted: all lines moved ${Math.abs(s)} seconds ${s > 0 ? 'later' : 'earlier'} to meet the singer.`);
      };
      const ask = async () => {
        $out.replaceChildren(h('p', { class: 'reason' }, 'Asking…'));
        // One request, made by this press: title and artist only (words.js).
        const res = await lookup({ title: $t.value.trim(), artist: $a.value.trim(), duration: song.duration });
        if (!res.ok) { $out.replaceChildren(h('p', null, res.words)); return; }
        $out.replaceChildren(h('ul', { class: 'sn-look-list' }, res.results.map((r, i) => {
          const diff = r.lengthDiffSec;
          const note = r.sameLength ? 'same length as your file' : Number.isFinite(diff) ? `${Math.abs(Math.round(diff))} seconds ${diff > 0 ? 'longer' : 'shorter'} than your file: may be a different version` : '';
          return h('li', { class: 'card' },
            h('span', null, [r.title, r.artist, Number.isFinite(r.duration) ? clock(r.duration) : null, r.instrumental ? 'no words: instrumental' : r.timed ? 'timed line by line' : 'words only, not timed'].filter(Boolean).join(' · ')),
            note && h('span', { class: 'reason' }, note),
            !r.instrumental && h('button', { class: 'btn btn-secondary btn-small', type: 'button', dataset: { use: String(i) }, onclick: () => use(r) }, 'Use these words'));
        })), h('p', { class: 'reason' }, 'Words found through LRCLIB.'));
      };
      return [
        h('p', null, 'This asks LRCLIB, a free lyrics site, for this song’s words. ', h('strong', null, 'It sends the title and the artist, nothing else'), ': no sound, nothing about you or your voice.'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), $t),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Artist'), $a),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', id: 'sn-look-go', disabled: offline, onclick: ask }, 'Look up the words'),
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => go(home) }, 'Back')),
        offline && h('p', { class: 'reason' }, 'Needs the internet. Pasting works offline.'),
        $out, authors(),
      ];
    };
    go(home);
  }

  // ---- tap along: the song plays (no microphone); Space stamps each line's start
  function startTap(words) {
    if (!song || !words) return;
    stopAll('stop');
    if (review) leaveReview();
    const order = words.lines.map((l, i) => (l.text ? i : -1)).filter((i) => i >= 0);
    if (!order.length) return;
    tap = { words, order, k: 0 };
    mode = 'tap';
    player.seek(0);
    paint();
  }
  function tapPress() {
    if (!tap) return;
    if (!playing()) { transport.play(); return; }
    tap.words = stampLine(tap.words, tap.order[tap.k], player.heardTime(), phrases);
    tap.k++;
    if (tap.k >= tap.order.length) finishTap(); else paint();
  }
  function tapBack() {
    if (!tap || tap.k === 0) return;
    tap.k--;
    const l = tap.words.lines[tap.order[tap.k]];
    // Rewind to hear the way in to that line again.
    if (Number.isFinite(l.t)) player.seek(Math.max(0, l.t + (tap.words.offsetSec || 0) - SONG.transport.takeLeadSec));
    paint();
  }
  async function finishTap() {
    if (!tap) return;
    const t = tap;
    tap = null;
    mode = 'sing';
    if (playing()) player.pause('stop');
    const words = makeWords(t.words.lines, { route: t.words.route || 'typed', offsetSec: t.words.offsetSec || 0, credit: t.words.credit });
    await keepWords(words);
    player.seek(0);
    toast(`${t.k} of ${t.order.length} lines timed.${t.k < t.order.length ? ' Open Words to carry on.' : ''}`);
    paint();
  }

  // ================================================================ painting (on change)

  function buildScrub() {
    const d = duration() || 1;
    $blocks.replaceChildren(...phrases.map((p) => h('span', { class: 'sn-scrub-block', style: `left:${(p.t / d) * 100}%;width:${(Math.max(0.05, p.end - p.t) / d) * 100}%` })));
    $tEnd.textContent = clock(d);
    $scrub.setAttribute('aria-valuemax', String(Math.round(d)));
    measureTrack();
    paintStars();
  }
  let octaveShown = null;
  function paint() {
    $lib.hidden = mode !== 'library';
    $sing.hidden = mode === 'library';
    document.body.dataset.singnow = mode;
    const rec = recActive(), recording = !!recorder && recorder.state().status === 'recording';
    $recPill.hidden = !recording;
    $stage.classList.toggle('is-recording', recording);
    document.title = recording && song ? `● Recording · ${song.title}` : song ? `${song.title} · Sing a song` : 'Sing a song · Music trainer';
    if (mode === 'library') { cancelAnimationFrame(raf); raf = 0; paintAuto(); return; }
    if (!raf) raf = requestAnimationFrame(frame);
    $sing.dataset.mode = mode;
    $title.textContent = review ? `Your take · ${song.title}` : mode === 'tap' ? `Time the words · ${song.title}` : song.title;
    $artist.textContent = review ? `${dateWords(review.take.createdAt)} · ${lengthWords(review.take.seconds)}` : song.artist || '';

    const play = playing(), phase = micflow.state().phase;
    const word = mode === 'tap' ? (play ? 'This line starts now' : 'Start') : count ? 'Cancel' : rec ? 'Stop and keep' : play ? 'Pause' : mode === 'review' ? 'Play' : everPlayed ? 'Carry on singing' : 'Sing';
    $primaryWord.textContent = word;
    $primary.title = word;
    $primary.setAttribute('aria-label', word);
    $primary.classList.toggle('is-rec', rec);
    $listen.hidden = mode !== 'sing' || rec || play || !!count;
    $record.hidden = mode !== 'sing';
    $record.disabled = !!count;
    $recordWord.textContent = rec ? 'Stop and keep' : 'Record a take';
    $record.classList.toggle('is-rec', rec);
    $primaryWhy.textContent = mode !== 'sing' ? '' : count ? `The microphone is on. ${count.take ? 'Recording' : 'The song'} starts after the count. Space or Esc cancels and turns the microphone off.` : rec ? 'Recording: one straight run until you press Stop. The microphone is on.'
      : phase === 'on' ? 'The microphone is on. Pause or Esc turns it off.'
        : everPlayed ? 'The microphone is off. Sing turns it back on.' : 'Sing turns the microphone on (headphones first). Listen plays the song without it. Practice records nothing.';

    $sound.hidden = mode !== 'sing';
    $review.hidden = mode !== 'review';
    $tapRow.hidden = mode !== 'tap';
    // A slider follows its level (a quick button or a key moved it, or another song opened).
    for (const [el, v] of [[$music, levels.music], [$guide, levels.singer], [$volume, levels.volume]]) if (el.value !== String(percent(v))) el.value = String(percent(v));
    const noGuide = !!waysOn().noGuide;
    $guide.disabled = !hasGuide || noGuide;
    // The number and one word sit beside the label; the whole sentence is the slider's
    // spoken value and its tooltip, so the row keeps its height.
    const singerSays = !hasGuide ? 'This song has no separate singer’s voice.' : noGuide ? 'Off (Ways to sing): the singer’s voice is taken out.' : `${percent(levels.singer)} · ${guideWords(levels.singer)}`;
    $guideWords.textContent = !hasGuide ? 'None in this song' : noGuide ? 'Off (Ways to sing)' : `${percent(levels.singer)} · ${guideWords(levels.singer).split(':')[0]}`;
    $guide.title = singerSays; $guide.setAttribute('aria-valuetext', singerSays);
    const said = musicWords(levels.music, hasGuide ? levels.singer : 0);
    const musicSays = `${percent(levels.music)} · ${said}`;
    $musicWords.textContent = `${percent(levels.music)} · ${said.split(':')[0]}`;
    $music.title = musicSays; $music.setAttribute('aria-valuetext', musicSays);
    // Volume: its number, or why nothing is heard when the levels let nothing through.
    const silent = silentWords(levels, hasGuide);
    const volumeSays = `${percent(levels.volume)} of 100${silent ? ` · ${silent}` : ''}`;
    $volumeWords.textContent = silent ? silent.split(':')[0] : String(percent(levels.volume));
    $volume.title = volumeSays; $volume.setAttribute('aria-valuetext', volumeSays);
    const preset = presetOf(levels);
    for (const b of $mixMarks.children) {
      b.setAttribute('aria-pressed', String(b.dataset.mix === preset));
      // No separate singer: "Singer only" would be silence with no way to tell why.
      b.disabled = (!hasGuide || noGuide) && b.dataset.mix === 'singer';
    }
    // Ways to sing: what is on, in the button; locked while anything listens or plays.
    const ways = waysWords(), locked = waysLocked();
    const waysSays = `Ways to sing: ${ways.length ? ways.join(', ') : 'Usual'}`;
    if ($ways.textContent !== waysSays) { $ways.textContent = waysSays; $ways.title = `${waysSays} (M)`; $ways.setAttribute('aria-label', `${waysSays} (M)`); }
    $ways.dataset.silver = waysOn().noLine ? 'on' : 'off';
    $ways.disabled = locked;
    $waysWhy.textContent = locked ? WAYS_LOCKED : 'Kept for this song.';
    if (octaveShown !== `${song.id}:${octave}`) {
      octaveShown = `${song.id}:${octave}`;
      $octaveSlot.replaceChildren(segmented({ label: 'Octave', value: octave, onChange: (v) => setOctave(Number(v)),
        options: [{ value: -1, text: 'Down' }, { value: 0, text: 'As sung' }, { value: 1, text: 'Up' }] }));
    }
    $octaveWords.textContent = OCTAVE_WORDS[octave];

    if (review) {
      const t = review.take, at = review.mix ? review.mix.state().at : null;
      $keepBar.hidden = !review.fresh;
      $reviewHead.textContent = at === null ? EXPORT_WORDS['not-lined-up'] : `Your take from ${clock(Math.max(0, at))} to ${clock(Math.max(0, at) + t.seconds)}, with the song. Play to hear it.`;
      $balanceWords.textContent = balanceWords(review.balance);
      $balanceNum.textContent = gainsWords(balanceGains(review.balance));
      for (const b of $balanceMarks.children) b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.balance) - review.balance) < 0.005));
      $nudgeWords.textContent = `My voice: ${nudgeWords(t.nudgeMs || 0)}`;
      const own = song.kind === 'file';
      $saveMix.disabled = !own || at === null;
      $mixWhy.textContent = own ? 'A mixed file holds your voice and the song. It is made on this Mac from your own file and saved by the browser’s download.' : EXPORT_WORDS['not-own-file'] || '';
      $takeBar.hidden = at === null;
      if (at !== null) { const d = duration() || 1; $takeBar.style.left = `${(clamp(at, 0, d) / d) * 100}%`; $takeBar.style.width = `${(Math.min(t.seconds, d - Math.max(0, at)) / d) * 100}%`; }
    } else $takeBar.hidden = true;
    paintAuto();
    // The line on repeat (a loop has no other sign on this page).
    const li = loopNow ? lines.findIndex((l) => Math.abs(l.t - loopNow.start) < 0.05) : -1;
    $loop.hidden = !loopNow || mode !== 'sing';
    $loopWords.textContent = !loopNow ? '' : li >= 0 ? `${lineSource() === 'words' ? 'Line' : 'Phrase'} ${li + 1} on repeat` : 'A part of the song on repeat';
    $lineStars.hidden = mode === 'tap';
    $resultsBtn.hidden = !review || !review.lines || !!(end && end.open);
    $stage.classList.toggle('has-end', !!(end && end.open));
    if (end && end.open !== !$end.hidden) paintEnd();
    if (tap) $tapWords.textContent = `Line ${Math.min(tap.k + 1, tap.order.length)} of ${tap.order.length}. Press Space the moment the singer starts each line.`;
    // The band's rows exist only once drawn: do not wait for the next frame after a change.
    if (player && song) paintBand(songTime());
  }

  // ================================================================ painting (every frame)

  const colours = {};
  function readColours() {
    const css = getComputedStyle(document.documentElement);
    for (const k of ['stage', 'text', 'muted', 'quiet', 'line', 'line-strong', 'target', 'good', 'close', 'off', 'accent']) colours[k] = css.getPropertyValue(`--${k}`).trim() || 'gray';
    // The light of the voice (sky spec 1.1). A stylesheet without these simply has no curtain.
    for (const k of ['aurora-in', 'aurora-close', 'aurora-off', 'aurora-low', 'aurora-mid', 'aurora-high', 'aurora-crown', 'voice-core', 'gold', 'gold-fill']) colours[k] = css.getPropertyValue(`--${k}`).trim();
    auroraPeak = parseFloat(css.getPropertyValue('--aurora-peak')) || 1;
    buildSprites();
  }
  // ---- the aurora's textures. Painted here (the theme, the pixel ratio, calm motion
  // switched), never in the frame loop: the microphone may be judged there. Until they are
  // ready the curtain is simply absent; the line is there.
  const AU = CONFIG.aurora, SKY = SONG.skyStage;
  const curtain = createCurtain({ ...AU, ...SKY.curtain });
  let sprites = null, light = false, auroraPeak = 1, dprNow = Math.min(2, window.devicePixelRatio || 1);
  const glows = {};      // the soft round light under the head: one small canvas a verdict
  let auroraGain = document.documentElement.dataset.aurora !== 'off' ? 1 : 0, gainAt = 0, swayT = 0;
  function buildSprites() {
    light = isLightColour(colours.stage) ?? document.documentElement.dataset.theme === 'dawn';
    sprites = colours['aurora-low'] && colours['aurora-crown'] ? auroraSprites({
      colours: { good: colours['aurora-in'], close: colours['aurora-close'], off: colours['aurora-off'], low: colours['aurora-low'], mid: colours['aurora-mid'], high: colours['aurora-high'], crown: colours['aurora-crown'], core: colours['voice-core'] },
      dpr: dprNow, calm: shell.calm(), light,
    }) : null;
    const px = SKY.glowPx, ink = { in: colours['aurora-in'], close: colours['aurora-close'], off: colours['aurora-off'], free: colours['aurora-mid'] };
    for (const [kind, colour] of Object.entries(ink)) {
      const c = glows[kind] || (glows[kind] = document.createElement('canvas'));
      c.width = c.height = Math.round(px * dprNow);
      const q = c.getContext('2d');
      if (!colour) continue;
      const grad = q.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, c.width / 2);
      grad.addColorStop(0, colour);
      grad.addColorStop(1, 'transparent');
      q.globalAlpha = light ? 0.6 : 1;
      q.fillStyle = grad;
      q.fillRect(0, 0, c.width, c.height);
    }
  }
  readColours();
  on(document, 'mt:theme', () => requestAnimationFrame(readColours));
  on(document, 'mt:calm', () => buildSprites());
  const g = $canvas.getContext('2d');
  let cw = 0, ch = 0;
  function fitCanvas() {
    const w = $canvas.clientWidth, hgt = $canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (dpr !== dprNow) { dprNow = dpr; cw = -1; buildSprites(); }
    if (w === cw && hgt === ch) return;
    cw = w; ch = hgt;
    $canvas.width = Math.max(1, Math.round(w * dpr));
    $canvas.height = Math.max(1, Math.round(hgt * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const KIND_COLOUR = { in: 'good', close: 'close', off: 'off', free: 'accent' };

  function drawStage(t, nowMs = performance.now()) {
    fitCanvas();
    auroraCols = 0; auroraMs = 0; lineDrawn = 0; headDrawn = false;
    if (!cw || !ch) return;
    const r = song.range;
    let lo = Math.floor((r ? r.lowest : 55) + 12 * octave) - VIEW.padNotes, hi = Math.ceil((r ? r.highest : 67) + 12 * octave) + VIEW.padNotes;
    if (hi - lo < 14) { const add = Math.ceil((14 - (hi - lo)) / 2); lo -= add; hi += add; }
    lane = { lo, hi };
    const pps = cw / VIEW.windowSec, nowX = cw * VIEW.nowFrac;
    const x = (time) => nowX + (time - t) * pps;
    const y = (midi) => clamp(8 + ((hi - midi) / (hi - lo)) * (ch - 16), 5, ch - 5);
    const t0 = t - nowX / pps, t1 = t + (cw - nowX) / pps;

    g.globalAlpha = 1;
    g.fillStyle = colours.stage;
    g.fillRect(0, 0, cw, ch);

    // lanes: one faint line a note, every C named
    g.font = '500 12px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      g.globalAlpha = isC ? 0.5 : 0.22;
      g.fillStyle = colours.line;
      g.fillRect(0, Math.round(y(m)), cw, 1);
      if (isC) { g.globalAlpha = 0.8; g.fillStyle = colours.quiet; const n = displayNote(m, settings.get('noteNames')); if (n) g.fillText(n.text, 6, y(m) - 8); }
    }

    // phrases: a wash where the singer sings, a tick and a number where each begins
    const inside = phraseAt(phrases, t);
    for (let i = 0; i < phrases.length; i++) {
      const p = phrases[i];
      if (p.end < t0 || p.t > t1) continue;
      g.globalAlpha = i === inside ? 0.13 : 0.07;
      g.fillStyle = colours.target;
      g.fillRect(x(p.t), 0, (p.end - p.t) * pps, ch);
      g.globalAlpha = 0.7;
      g.fillRect(Math.round(x(p.t)), 0, 2, ch);
      g.fillStyle = colours.muted;
      g.fillText(String(i + 1), x(p.t) + 6, 12);
    }

    // the owner's voice: live while singing, the take's own line in the review
    const pts = review ? review.frames.slice(firstAtOrAfter(review.times, t0), firstAtOrAfter(review.times, Math.min(t, t1))) : trail;
    // By ear (grades spec 10.2): the light still rises with the voice's loudness, but every
    // point sits on the bottom lane in the free hues, so it says "heard" and nothing of pitch;
    // the voice line and its head are not drawn. The hue drifts with time, never with pitch.
    const byEar = byEarNow();
    const lightPts = byEar ? pts.map((p) => (p.midi === null ? p : { ...p, midi: lo, kind: 'free', hue: 0.5 + 0.45 * Math.sin(p.t * 0.6) })) : pts;

    // the curtain of light that rises from the voice line (js/app/aurora.js). Under the
    // singer's ribbon, so the tune stays on top of the owner's own light, and never ahead of
    // the now line. The Settings switch and the guard ease it away; the line stays.
    const gs = sharedGuard.state(nowMs), calm = shell.calm();
    const want = document.documentElement.dataset.aurora !== 'off' ? 1 : 0;
    if (auroraGain !== want) { const step = Math.min(100, Math.max(0, nowMs - gainAt)) / SKY.switchFadeMs; auroraGain = want > auroraGain ? Math.min(1, auroraGain + step) : Math.max(0, auroraGain - step); }
    gainAt = nowMs;
    const lightK = auroraGain * gs.gain;
    auroraTier = gs.tier;
    if (sprites && sprites.ready && lightK > 0 && lightPts.length) {
      const a0 = performance.now();
      // The light moves with the song: a paused picture (a pause, a stopped review) is still.
      if (playing()) swayT = nowMs / 1000;
      const n = curtain.build(lightPts, {
        now: t, pxPerSec: pps, nowX, yOfMidi: y, topY: 0, xMin: SKY.xMinPx, calm, light, colPx: gs.colPx, peakCap: auroraPeak,
        tall: clamp(ch / AU.tallRefPx, 1, AU.tallMax), capPx: SKY.capFrac * ch, swayT, shimmerT: swayT, snap: dprNow,
      });
      if (n) {
        g.save();
        g.beginPath(); g.rect(SKY.xMinPx, 0, Math.max(0, nowX + 4 - SKY.xMinPx), ch); g.clip();
        auroraCols = drawCurtain(g, curtain.cols, sprites, lightK);
        g.restore();
      }
      auroraMs = performance.now() - a0;
    }

    // the singer's ribbon: drawn only where sung, so the picture shows the rests
    if (curve && curve.t.length) {
      const path = new Path2D(), maxGap = (curve.hop || 0.02) * 2.5;
      let open = false, prev = -1;
      for (let i = Math.max(0, firstAtOrAfter(curve.t, t0) - 1); i < curve.t.length && curve.t[i] <= t1 + 0.1; i++) {
        if (!curve.voiced[i] || !Number.isFinite(curve.midi[i])) { open = false; continue; }
        const px = x(curve.t[i]), py = y(curve.midi[i] + 12 * octave);
        if (open && prev >= 0 && curve.t[i] - curve.t[prev] <= maxGap) path.lineTo(px, py); else { path.moveTo(px, py); path.lineTo(px + 0.01, py); }
        open = true; prev = i;
      }
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = colours.target;
      const stroke = (from, to, alpha, width) => { g.save(); g.beginPath(); g.rect(from, 0, to - from, ch); g.clip(); g.globalAlpha = alpha; g.lineWidth = width; g.stroke(path); g.restore(); };
      stroke(0, nowX, 0.35, 8);                 // already past: quieter
      stroke(nowX, cw, 0.12, 20);               // ahead: a soft halo, then the line
      stroke(nowX, cw, 0.92, 8);
    }

    // the count-in beads before each phrase: hollow until they cross the now line
    for (let i = 0; i < phrases.length; i++) {
      if (phrases[i].t < t0 || phrases[i].t - SONG.phrases.readySec - 1 > t1 || phraseMidi[i] === null || phraseMidi[i] === undefined) continue;
      const by = y(phraseMidi[i] + 12 * octave);
      for (const bt of beadTimes(phrases, i, { cfg: BEAD_CFG })) {
        g.globalAlpha = 0.9;
        g.beginPath();
        g.arc(x(bt), by, 6, 0, Math.PI * 2);
        g.lineWidth = 2;
        g.strokeStyle = colours.text;
        g.fillStyle = colours.text;
        if (bt <= t) g.fill(); else g.stroke();
      }
    }

    // the now line
    g.globalAlpha = 0.85;
    g.fillStyle = colours.text;
    g.fillRect(Math.round(nowX) - 1, 0, 2, ch);

    // the voice line: the verdict colour with a bright centre, fading with age so it never
    // stops dead at the end of the trail
    let last = null;
    g.lineCap = 'round';
    for (const p of byEar ? [] : pts) {
      if (p.midi === null) { last = null; continue; }
      const kind = p.kind || 'free';
      const px = x(p.t), py = y(p.midi);
      if (last && p.t - last.t < 0.15 && px > 0) {
        const k = trailK(t - p.t, SKY.lineFullMs, SKY.lineEndMs);
        if (k > 0.01) {
          g.beginPath(); g.moveTo(last.px, last.py); g.lineTo(px, py);
          g.globalAlpha = SKY.lineAlpha * k; g.lineWidth = SKY.lineWidthPx;
          g.strokeStyle = colours[KIND_COLOUR[kind]] || colours.accent;
          g.stroke();
          g.globalAlpha = SKY.coreAlpha * k; g.lineWidth = SKY.coreWidthPx;
          g.strokeStyle = colours['voice-core'] || colours.text;
          g.stroke();
          lineDrawn++;
        }
      }
      last = { t: p.t, px, py, kind };
    }
    // the head: a soft light under it (one small picture, no blur), the dot, a bright centre
    if (last && t - last.t < 0.25) {
      const headK = review ? SKY.reviewHeadAlpha : 1, glow = glows[last.kind];
      if (glow && lightK > 0) { g.globalAlpha = SKY.glowAlpha * lightK * headK; g.drawImage(glow, last.px - SKY.glowPx / 2, last.py - SKY.glowPx / 2, SKY.glowPx, SKY.glowPx); }
      headDrawn = true;
      g.globalAlpha = headK;
      g.fillStyle = colours.text;
      g.beginPath(); g.arc(last.px, last.py, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = colours[KIND_COLOUR[last.kind]] || colours.accent;
      g.beginPath(); g.arc(last.px, last.py, 4.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = colours['voice-core'] || colours.text;
      g.beginPath(); g.arc(last.px, last.py, 2, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  }

  const LAMP_ICON = { turn: 'music-note', rest: 'moon', ready: 'dots', count: 'dots', intro: 'moon', after: 'tick', paused: 'pause', idle: 'play', tap: 'music-note', none: 'dash', end: 'tick' };
  // ONE number on the screen (design review 2026-10-13, finding 7: the lamp said "Get
  // ready · 3" beside the card's "Sing in 2"). The count card has it; the prompt box has
  // carried none since the owner's 2026-10-13 note (lampFor). null = no count is showing.
  function countNow(t, play, now) {
    if (count) { const k = countInAt((now - count.at) / 1000, count.sec); return k.done ? null : { kind: 'start', take: count.take, cap: count.take ? 'Recording starts in' : 'The song starts in', ...k }; }
    if (play && mode === 'sing' && phrases.length) { const k = countdownAt(phrases, t); if (k) return { kind: 'phrase', take: false, cap: 'Sing in', ...k }; }
    return null;
  }
  // THE PROMPT BOX (the lamp). Owner 2026-10-13: it "keeps shifting around too much and
  // changing too fast ... flashing and distracting". So:
  //   - it carries no number. "Rest · 7 seconds", "Get ready · 3" and "Starting in 2" each
  //     changed the words every second; the one number on the screen is the count card's.
  //   - a gap under SONG.phrases.restSec (5 s) is a breath: the prompt stays on "Your turn".
  //   - while the song runs it changes at most once in SONG.prompt.holdMs (1 s), whatever
  //     the song does; only the owner's own press (Sing, Pause, a jump) shows at once.
  //   - its box is one size for every one of its sayings (css .sn-lamp), and new words
  //     ease in.
  function lampFor(t, play) {
    if (mode === 'tap') return { state: 'tap', text: play ? 'Tap Space as each line starts' : 'Press Start, then tap each line' };
    if (count) return { state: 'count', text: 'Get ready' };
    if (!play) {
      if (status() === 'ended') return { state: 'end', text: 'The end' };
      if (!everPlayed) return { state: 'idle', text: mode === 'review' ? 'Press Play to hear your take' : 'Press Sing when you are ready' };
      return { state: 'paused', text: 'Paused' };
    }
    if (!phrases.length) return { state: 'none', text: 'No tune to follow' };
    const l = lampAt(phrases, t);
    if (l.state === 'turn') return { state: 'turn', text: mode === 'review' ? 'Singing' : 'Your turn' };
    if (l.state === 'ready') return { state: 'ready', text: 'Get ready' };
    if (l.state === 'rest') return { state: 'rest', text: 'Rest' };
    if (l.state === 'intro') return { state: 'intro', text: 'Intro' };
    return { state: 'after', text: 'That was the last line' };
  }
  // `stamp` is the frame's own time (requestAnimationFrame's), so two changes are never
  // drawn in frames less than the hold apart.
  function paintLamp(t, play, stamp) {
    const want = lampFor(t, play);
    if (want.state === lamp.state && want.text === lamp.text) return;
    // What a press does shows at once: stopping, starting (the count), the end, tapping.
    const PRESSED = ['paused', 'idle', 'end', 'tap', ''];
    const pressed = lamp.free || want.state === 'count' || PRESSED.includes(want.state) || PRESSED.includes(lamp.state);
    if (!pressed && stamp - lamp.at < SONG.prompt.holdMs) return;
    if (want.state !== lamp.state) {
      $lamp.dataset.state = want.state;
      $lampIcon.replaceChildren(icon(LAMP_ICON[want.state] || 'dots', 20));
    }
    if (want.text !== lamp.text) {
      $lampText.textContent = want.text;
      $live.textContent = want.text;
      // New words ease in (never a hard swap); calm motion: they only change.
      if (!shell.calm() && $lampText.animate) for (const el of [$lampText, $lampIcon]) el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: SONG.prompt.easeMs, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
    lamp = { state: want.state, text: want.text, at: stamp, free: false };
  }

  let scrubSaid = -1;
  function paintScrub(t) {
    const d = duration() || 1, pct = `${(clamp(t / d, 0, 1) * 100).toFixed(2)}%`;
    $played.style.width = pct;
    $head.style.left = pct;
    const whole = Math.floor(t);
    if (whole !== scrubSaid) {
      scrubSaid = whole;
      $tNow.textContent = clock(t);
      $scrub.setAttribute('aria-valuenow', String(whole));
      $scrub.setAttribute('aria-valuetext', `${clock(t)} of ${clock(d)}`);
    }
  }
  // ---- the words band. Rows take turns: when a line begins, the row that was waiting under
  // the current one slides up and grows into its place while the old one leaves upward and
  // fades, and a new row fades in underneath. Nothing else on the screen moves: the rows
  // are laid over a box of fixed height (css/singnow.css .sn-roll).
  const band = { cur: null, next: null, curKey: null, nextKey: null };
  function setRow(el, role, text) {
    el.dataset.role = role;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('sn-line', role === 'cur');
    el.classList.toggle('sn-next', role === 'next' || role === 'in');
    el.classList.toggle('is-long', text.length > 44);
    el.classList.toggle('is-xlong', text.length > 64);
    el.classList.remove('is-cued', 'is-done', 'is-fresh');
    el.removeAttribute('aria-hidden');
  }
  // A row brought in: it takes its starting place unseen, then eases to where it belongs.
  function bring(role, text, from = role) {
    const el = $rows.filter((r) => r !== band.cur && r !== band.next).sort((p, q) => (p._left || 0) - (q._left || 0))[0];
    el.classList.add('is-snap', 'is-hidden');
    setRow(el, from, text);
    void el.offsetWidth;
    el.classList.remove('is-snap', 'is-hidden');
    // Fading in where another row is fading out: wait for it (css .is-fresh).
    if (from !== role) setRow(el, role, text); else el.classList.add('is-fresh');
    el._left = Infinity;
    return el;
  }
  function retire(el, slide) {
    if (!el) return;
    el._left = performance.now();
    el.classList.remove('sn-line', 'sn-next', 'is-cued');
    el.setAttribute('aria-hidden', 'true');
    if (slide) el.dataset.role = 'out'; else el.classList.add('is-hidden');
  }
  function showBand(cur, next, cued, done) {
    const curKey = cur ? `${cur.key}:${cur.text}` : null, nextKey = next ? `${next.key}:${next.text}` : null;
    const move = bandMove({ cur: band.curKey, next: band.nextKey }, { cur: curKey }, shell.calm());
    if (move !== 'stay') {
      retire(band.cur, move === 'roll');
      if (move === 'roll') { band.cur = band.next; band.next = null; band.nextKey = null; setRow(band.cur, 'cur', cur.text); }
      else band.cur = cur ? bring('cur', cur.text) : null;
      band.curKey = curKey;
    }
    if (nextKey !== band.nextKey) {
      retire(band.next, false);
      band.next = next ? bring('next', next.text, move === 'roll' ? 'in' : 'next') : null;
      band.nextKey = nextKey;
    }
    if (band.next) band.next.classList.toggle('is-cued', !!cued);
    if (band.cur) band.cur.classList.toggle('is-done', !!done);
  }
  function paintBand(t) {
    let cur = null, next = null, progress = 0, shown = true, cued = false, done = false, env = 1;
    if (tap) {
      const a = tap.words.lines[tap.order[tap.k]], b = tap.words.lines[tap.order[tap.k + 1]];
      cur = a && a.text ? { key: `t${tap.k}`, text: a.text } : null;
      next = b && b.text ? { key: `t${tap.k + 1}`, text: b.text } : null;
      shown = false;
    } else if (bandSpans.length) {
      const m = markerAt(bandSpans, t), at = m ? m.index : -1, after = bandSpans[at + 1];
      if (m) { cur = { key: `w${at}`, text: bandSpans[at].text }; progress = m.progress; done = m.resting; env = markerEnvelope(t, bandSpans[at], SONG.words.markerFadeSec); }
      else shown = false;
      // The line to come is always in sight; in its last moment before starting it is lit.
      if (after) { next = { key: `w${at + 1}`, text: after.text }; cued = after.t - t <= SONG.words.cueSec; }
    } else if (phrases.length) {
      const i = phraseAt(phrases, t), l = lampAt(phrases, t);
      const at = i >= 0 ? i : l.phrase;
      cur = { key: `p${at}`, text: at >= 0 ? `Phrase ${at + 1} of ${phrases.length}` : 'After the last phrase' };
      if (i >= 0) { progress = clamp((t - phrases[i].t) / Math.max(0.01, phrases[i].end - phrases[i].t), 0, 1); env = markerEnvelope(t, phrases[i], SONG.words.markerFadeSec); } else shown = false;
      if (song.words && lineCount(song.words)) next = { key: 'hint', text: 'These words are not timed yet. Open Words to tap along.' };
    }
    showBand(cur, next, cued, done);
    $marker.style.visibility = shown ? 'visible' : 'hidden';
    $marker.style.opacity = env.toFixed(2);
    const pct = `${(progress * 100).toFixed(2)}%`;
    $markFill.style.width = pct;
    $markStar.style.left = pct;
  }

  // ---- the count, large on the stage: after a press while the song waits ("The song
  // starts in 3"), and while it runs before a phrase that follows an intro or a rest
  // ("Sing in 3": only when that intro or rest is SONG.countIn.minGapSec, 6 s, or longer).
  // One bead per second fills as it passes; the prompt box says "Get ready", with no number.
  let countSaid = '', countAt = 0;
  function paintCount(c, stamp) {
    $count.classList.toggle('is-on', !!c);
    if (!c) { countShown = null; countSaid = ''; return; }
    // The ways this run is sung with, in the card's small line ("By ear · no guide voice").
    const ways = c.kind === 'start' ? waysWords().map((w, k) => (k ? w.toLowerCase() : w)).join(' · ') : '';
    if ($countWays.textContent !== ways) $countWays.textContent = ways;
    // state().count names what the card SHOWS: it is set only once this frame draws (or
    // already drew) these numbers, never before the hold below sends the frame away; it was
    // a frame ahead of the card (design review 2026-10-14, finding 5).
    const shown = { kind: c.kind, take: c.take, seconds: c.seconds, of: c.of };
    const said = `${c.kind}:${c.cap}:${c.seconds}:${c.of}`;
    if (said === countSaid) { countShown = shown; return; }
    // Within one count the number steps once a second by the clock; a frame that comes
    // early must not draw two steps less than the prompt's hold apart (it waits a frame).
    if (countSaid.startsWith(`${c.kind}:`) && stamp - countAt < SONG.prompt.holdMs) return;
    countShown = shown;
    countSaid = said;
    countAt = stamp;
    $count.dataset.kind = c.kind;
    $countCap.textContent = c.cap;
    $countNum.textContent = String(c.seconds);
    $countBeads.replaceChildren(...Array.from({ length: c.of }, (_, k) => h('i', { class: k < c.of - c.seconds ? 'is-full' : '' })));
    // The new number eases in (never a hard swap); calm motion: it only changes.
    if (!shell.calm() && $countNum.animate) $countNum.animate([{ opacity: 0.35, transform: 'scale(1.18)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }

  function paintReadout() {
    const now = performance.now();
    if (now - readAt < VIEW.readoutMs) return;
    readAt = now;
    const live = (singing || recActive()) && playing();
    if (!live) { $readout.hidden = true; return; }
    $readout.hidden = false;
    // By ear: no verdict, no note words, only the mode (spec 10.2).
    const byEar = byEarNow();
    $readMoon.hidden = !byEar;
    if (byEar) {
      $readout.dataset.kind = 'byear';
      if ($readWord.textContent !== 'By ear') $readWord.textContent = 'By ear';
      if ($readNum.textContent !== '') $readNum.textContent = '';
      return;
    }
    const fresh = lastRead && now - lastRead.at < 400;
    let word = 'Listening', num = 'sing with the ribbon', kind = 'listening';
    // Nothing to match while the singer rests: say so, whether or not the owner is singing.
    if (targetAt(songTime()) === null && !(fresh && lastRead.cents !== null)) { word = 'The singer rests'; num = 'nothing to match here'; kind = 'free'; }
    else if (fresh) {
      const c = lastRead.cents, v = verdict(c);
      // A whole octave away is the right note in another octave: say so, and how to fix it.
      const oct = Math.abs(Math.abs(c) - 1200) <= CONFIG.verdict.closeCents * 2 ? (c < 0 ? 'lower' : 'higher') : null;
      // The words read the raw distance; the colour is the page's one verdict (kindOf), so it
      // agrees with the line, its light and the stars.
      if (oct) { word = `One octave ${oct} than the singer`; num = octave === (oct === 'lower' ? -1 : 1) ? '' : `try Octave ${oct === 'lower' ? 'down' : 'up'}`; }
      else { word = v.word; num = numberText(c); }
      kind = kindOf(c);
    }
    $readout.dataset.kind = kind;
    if ($readWord.textContent !== word) $readWord.textContent = word;
    if ($readNum.textContent !== num) $readNum.textContent = num;
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!player || !song || mode === 'library') return;
    const play = playing(), t = songTime();
    // The canvas is measured BEFORE the stopwatch starts (bugs.md 75). Reading its size makes
    // the browser lay the page out there and then (the lamp, the words band and the count
    // were written after the last drawing), 1 to 2 ms on some frames. That is the page's
    // work, not the stage's: timed as drawing it made the stage look slow (p95 1.7 ms against
    // 0.5) and would have had the guard dim the light for a cost the light does not cause.
    fitCanvas();
    const s0 = performance.now();
    drawStage(t, s0);
    stageMs = performance.now() - s0;
    // Too slow while the microphone is judged: the guard widens the light's columns, then
    // turns it off for the visit (aurora.js). The line never goes.
    if (play && micflow.state().phase === 'on') sharedGuard.frame(stageMs, s0);
    // One reading of the clock and one count for this frame: the lamp and the card.
    const now = performance.now(), c = countNow(t, play, now);
    const stamp = Number.isFinite(ts) ? ts : now;
    paintLamp(t, play, stamp);
    paintScrub(t);
    paintBand(t);
    paintCount(c, stamp);
    paintReadout();
    // "Hear it" plays one line of the take and stops at its end.
    if (hearUntil !== null && play && t >= hearUntil) { hearUntil = null; player.pause('stop'); }
    if (!$recPill.hidden) $recPill.lastChild.textContent = `Recording · ${clock(recorder ? recorder.state().seconds : 0)}`;
  }

  // ================================================================ scrub bar and keys

  let scrubAt = 0;
  const scrubSec = (e) => { const r = $scrub.getBoundingClientRect(); return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * duration(); };
  $scrub.addEventListener('pointerdown', (e) => {
    if (e.button || !transport) return;
    dragging = true;
    try { $scrub.setPointerCapture(e.pointerId); } catch { /* a synthetic press has no pointer to capture */ }
    // Practising: the song follows the drag. During a take the jump is asked for once, on release.
    if (transport.mode() !== 'take') transport.seek(scrubSec(e));
  });
  $scrub.addEventListener('pointermove', (e) => {
    if (!dragging || !transport || transport.mode() === 'take') return;
    const now = performance.now();
    if (now - scrubAt < 40) return;
    scrubAt = now;
    transport.seek(scrubSec(e));
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    const sec = scrubSec(e);
    jump((o) => transport.seek(sec, o));
  };
  $scrub.addEventListener('pointerup', endDrag);
  $scrub.addEventListener('pointercancel', () => { dragging = false; });

  on(document, 'keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || sheetOpen()) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    // The shell's own number keys go to the app's tabs, which this page does not have.
    if (/^[0-9]$/.test(e.key) && !typing) e.preventDefault();
    if (mode === 'library' || !transport) return;
    // The shooting star is on its way: any key goes straight to the final state.
    if (end && end.reveal === 'run') { e.preventDefault(); finishReveal(); return; }
    // The results layer: Esc closes it; R and L still retry; every other key is its own.
    if (layer) {
      if (e.key === 'Escape') { e.preventDefault(); closeLayer(); }
      else if (!typing && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); retrySong(); }
      else if (!typing && (e.key === 'l' || e.key === 'L') && practiseIndex() >= 0) { e.preventDefault(); retryLine(practiseIndex()); }
      return;
    }
    if (e.key === 'Escape' && end && end.open) { e.preventDefault(); closeEnd(); paint(); return; }
    if (e.key === 'Escape') {
      // Esc stops everything that listens. A take that was running is kept.
      e.preventDefault();
      if (mode === 'tap') finishTap(); else stopAll('stop');
      paint();
      return;
    }
    if (typing) return;
    const onButton = !!el && !!el.closest('button, a, [role="radio"]');
    const onRadio = !!el && !!el.closest('[role="radio"]');
    const act = (fn) => { e.preventDefault(); fn(); };
    switch (e.key) {
      case ' ': if (!onButton) act(primary); break;
      case 'Enter': if (!onButton) act(() => jump((o) => transport.replayLine(o))); break;
      case 'ArrowLeft': if (!onRadio) act(() => jump((o) => transport.skip(e.shiftKey ? -SONG.transport.fineSkipSec : -SONG.transport.skipSec, o))); break;
      case 'ArrowRight': if (!onRadio) act(() => jump((o) => transport.skip(e.shiftKey ? SONG.transport.fineSkipSec : SONG.transport.skipSec, o))); break;
      case 'ArrowUp': if (!onRadio) act(() => (e.shiftKey ? setOctave(octave + 1) : jump((o) => transport.prevLine(o)))); break;
      case 'ArrowDown': if (!onRadio) act(() => (e.shiftKey ? setOctave(octave - 1) : jump((o) => transport.nextLine(o)))); break;
      case ',': act(() => jump((o) => transport.prevLine(o))); break;
      case '.': act(() => jump((o) => transport.nextLine(o))); break;
      case 'b': case 'B': act(() => jump((o) => transport.replayLine(o))); break;
      case 'Home': case '0': act(() => jump((o) => transport.restart(o))); break;
      case 'k': case 'K': act(() => { if (count) stopAll('stop'); else if (playing()) transport.pause(); paint(); }); break;
      case 'p': case 'P': if (mode === 'sing' && !recActive()) act(listen); break;
      // R: with the results or the take review showing, a new take from the top (spec 6.2);
      // otherwise Record a take / Stop and keep, as before. No retry key while singing.
      case 'r': case 'R': if (!recActive() && ((end && end.open) || mode === 'review')) act(retrySong); else if (mode === 'sing') act(recordPress); break;
      case 'l': case 'L': if (!recActive() && ((end && end.open) || mode === 'review') && practiseIndex() >= 0) act(() => retryLine(practiseIndex())); break;
      case 'm': case 'M': if (mode === 'sing') act(openWays); break;
      case 'f': case 'F': if (!recActive() && ((end && end.open) || (mode === 'review' && review && review.lines))) act(openLayer); break;
      case '[': act(() => (review ? setNudge(-1) : setGuide(levels.singer - SONG.levels.keyStep))); break;
      case ']': act(() => (review ? setNudge(1) : setGuide(levels.singer + SONG.levels.keyStep))); break;
      default:
        if (/^[1-9]$/.test(e.key)) jump((o) => transport.toTenth(Number(e.key), o));
    }
  }, true);

  on(document, 'pointerdown', () => { if (end && end.reveal === 'run') finishReveal(); }, true);

  // ================================================================ the handle

  const autoView = (a) => ({ state: a.state, status: a.result ? a.result.status : null, why: a.result ? a.result.why : null, searched: !!(a.result && a.result.searched), fromCache: !!(a.result && a.result.fromCache), source: a.result ? a.result.source : null });
  const app = {
    state: () => ({
      mode, songId: song ? song.id : null, status: status(), singing, recording: !!recorder && recorder.state().status === 'recording',
      mic: micflow.state().phase, audio: ctx ? ctx.state : null, lamp: lamp.text, lampState: lamp.state, octave,
      lines: lines.length, words: spans.length, tools: jobs.state().tools, time: songTime(), trail: trail.length,
      review: review ? { takeId: review.take.id, fresh: review.fresh, balance: review.balance, nudgeMs: review.take.nudgeMs || 0, at: review.mix ? review.mix.state().at : null, frames: review.frames.length } : null,
      tap: tap ? { k: tap.k, of: tap.order.length } : null,
      count: countShown ? { ...countShown } : null, guide: levels.singer, volume: levels.volume, music: levels.music, mix: presetOf(levels),
      band: { cur: band.cur ? band.cur.textContent : '', next: band.next ? band.next.textContent : '', cued: !!band.next && band.next.classList.contains('is-cued') },
      autoWords: prefs.autoWords, auto: song && autos.has(song.id) ? autoView(autos.get(song.id)) : null,
      // the stage's last frame: its cost, the curtain's share of it, columns drawn, the
      // guard's step (0 full, 1 wide columns, 2 off), voice line pieces drawn, the newest
      // point's verdict
      stageMs, auroraMs, auroraCols, auroraTier, lineDrawn, headDrawn, ways: song ? waysOn() : {}, voiceKind: trail.length ? trail[trail.length - 1].kind : null,
      // line stars: the row as drawn; the end panel; the line on repeat; the shooting star and chime
      stars: [...starEls].map(([i, el]) => ({ i, level: el.dataset.level })).sort((a, b) => a.i - b.i),
      end: end ? { open: end.open, waiting: end.reveal === 'run', reveal: end.reveal, practice: end.practice, best: end.best, with: end.sum.with, close: end.sum.close, sung: end.sum.sung, total: end.sum.total, bestLine: end.sum.best, practise: end.sum.practise,
        grade: end.scored ? { letter: end.scored.grade.letter, state: end.scored.grade.state, accuracy: end.scored.accuracy, advice: end.scored.advice.id, chip: end.scored.best.chip ? end.scored.best.chip.id : null, silver: end.scored.result.silver } : null } : null,
      layer: !!layer, rest: resting ? { left: Math.max(0, Math.ceil((resting.until - Date.now()) / 1000)) } : null, runs: runs.length,
      loop: loopNow ? { start: loopNow.start, end: loopNow.end } : null,
      sky: { ...sky },
    }),
    autos: () => Object.fromEntries([...autos].map(([id, a]) => [id, autoView(a)])),
    get player() { return player; }, get recorder() { return recorder; }, get transport() { return transport; }, get ctx() { return ctx; },
    micflow, store, takes, jobs, shell, settings,
    openSong, closeSong, addFiles, refresh: paintLibrary,
  };
  window.__singnow = app;

  // Sheets opened while the screen is up are its own (they are modal: nothing else can open
  // one under them), so leaving closes them.
  const ownDialogs = new Set();
  on(document, 'mt:sheet', (e) => {
    if (!e.detail || !e.detail.open) return;
    const top = [...document.querySelectorAll('dialog[open]')].pop();
    if (top) ownDialogs.add(top);
  });

  // The take's sky for the home's replay (spec 3.4 step 6): its pitched points, at most
  // 96, kept only when there were 3 s or more of pitched singing. Gaps longer than a
  // quarter second (a pause, a jump) do not count as singing.
  function auroraSamples() {
    let sung = 0;
    for (let i = 1; i < trail.length; i++) {
      if (trail[i].midi !== null && trail[i - 1].midi !== null) sung += Math.min(0.25, Math.max(0, trail[i].t - trail[i - 1].t));
    }
    const pitched = trail.filter((p) => p.midi !== null);
    if (sung < 3 || !pitched.length) return null;
    const n = Math.min(96, pitched.length);
    return Array.from({ length: n }, (_, k) => {
      const p = pitched[Math.floor((k * pitched.length) / n)];
      return { midi: p.midi, lv: p.lv ?? null, kind: p.kind };
    });
  }

  // Leaving the screen, in the order of spec 3.4. Asks nothing: a running take is ended
  // and kept (the take store belongs to the service, so its last write still lands).
  let destroyed = false;
  app.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    const samples = recActive() ? auroraSamples() : null;
    // 1. the take ends and is kept, the count-in is cancelled, the player pauses, the mic goes
    stopAll('left');
    // 2. sound out: a 120 ms ramp to 0, then the context closes (no click, no tail)
    if (ctx) {
      const c = ctx;
      try {
        const g = outNode.gain, now = c.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + 0.12);
      } catch { /* a closed context: nothing is sounding */ }
      setTimeout(() => { c.close().catch(() => {}); }, 130);
    }
    // 3. the stage loop and every timer (prefs were flushed by stopAll)
    cancelAnimationFrame(raf); raf = 0;
    stopRest();
    hideHold();
    if (end) { clearTimeout(end.timer); end.timer = 0; }
    flushPrefs();
    if (shell && typeof shell.setBusy === 'function') shell.setBusy(null);
    // 4. every listener and micflow hook: the app's micflow outlives the screen
    for (const off of offs.splice(0)) off();
    offMicState(); offMicFrame(); offJobs();
    if (typeof offBanners === 'function') offBanners();
    if (sizer) sizer.disconnect();
    // 5. what it put outside the view
    for (const el of document.querySelectorAll('.sn-streak')) el.remove();
    delete document.body.dataset.singnow;
    for (const dlg of ownDialogs) if (dlg.open) dlg.close('close');
    ownDialogs.clear();
    $lib.remove(); $sing.remove(); $recPill.remove();
    if (layer) layer.remove();
    // 6. the take's sky, memory only, for the home (slice 4)
    if (samples) service.keepAurora(samples);
    if (window.__singnow === app) delete window.__singnow;
  };

  paint();
  paintNotice();
  paintLibrary();
  // A reload or a link to a song that this browser does not keep is not an error: the
  // library stays up with one quiet line (spec 3.1).
  if (songId) {
    store.get(songId).then((entry) => {
      // Left again before the store answered: a destroyed screen must not load a song.
      if (destroyed) return;
      if (entry) return openSong(songId);
      $notice.textContent = 'That song is not saved in this browser.';
      $notice.hidden = false;
    }).catch(() => {});
  }
  return app;
}
