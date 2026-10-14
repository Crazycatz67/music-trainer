// job.js — one dropped file, from the file to a song in the song store, and the queue that
// does several one after another (docs/design/specs/2026-10-12-song-mode.md 4.2; the drop
// box draws what this file reports).
//
// A song goes: read the file -> separate the voice (HTDemucs) -> trace the melody (SwiftF0
// on the separated voice: measured, the project's own detector drops out in choruses) ->
// facts (length, range, phrases) -> saved. A chart (UltraStar .txt, MIDI) is read and saved
// at once and needs no model.
//
// NOTHING IS DOWNLOADED until jobs.go() is called, which a page calls only from the
// visitor's press, after showing toolsNeeded(). Importing this file fetches nothing. The
// file the owner dropped is decoded and analysed in this browser and never leaves it.
//
// The queue, the steps, the failures and analyseSong() are PURE (they run in Node with
// stand-in tools); decodeFile() and loadTools() are the browser half.
//
// CONTRACT
//   createJobs({ loadTools?, decode?, store?, config?, now? }) -> jobs
//       loadTools  async ({ onProgress }) -> tools (default: loadTools below)
//       decode     async (file) -> { left, right, sampleRate } (default: decodeFile)
//       store      a song store (songstore.js); without one the result comes in the event only
//   jobs.add(files) -> [id]      a File, or a list of them; they run in the order given
//   jobs.go() -> Promise<{ ok: true, backend, slow } | { ok: false, reason: 'tools', words }>
//       THE explicit press: fetches the model (once per browser) and starts the queue.
//       Safe to call again; after a failure it tries again.
//   jobs.cancel(id?)             one job, or with no id every job; a running one stops
//                                between two pieces of the separation
//   jobs.state() -> { tools: 'none' | 'loading' | 'ready' | 'failed', backend, slow,
//                     needsGo, toolsProgress, jobs: [job] }
//       needsGo: a song is waiting and go() has not been called
//       job = { id, name, kind: 'audio' | 'ultrastar' | 'midi', status, step, progress,
//               etaSec, error, songId, title }
//       status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
//       step:   'queued' | 'reading' | 'separating' | 'tracing' | 'saving' | 'done'
//               (STEP_WORDS has the plain words); progress 0..1 over the whole job
//       error:  null | { code, words }   code: 'unreadable' | 'too-long' | 'no-singing' |
//               'out-of-memory' | 'storage' | 'failed'   (JOB_WORDS)
//   jobs.on(fn) -> off           fn({ type, job?, ... }): 'state' on every change;
//       'done' { job, songId, saved, facts, analysis?, result? }; 'failed' { job }; 'notice' { code, words }
//       analysis (songs only, not charts) = { version, backing } as analyseSong gives it
//       notice codes: 'no-webgpu' (it will take minutes), 'pitch-fallback'
//   jobs.idle() -> Promise       settles when nothing is running and nothing can start
//   jobs.destroy()               cancels everything and lets the model go
//
//   Pure helpers:
//     toolsNeeded() -> { bytes, words }      what go() downloads the first time
//     estimateSec(durationSec, backend) -> seconds of work expected
//     fileKind(name) -> 'audio' | 'ultrastar' | 'midi'
//     analyseSong({ left, right, sampleRate }, tools, { signal?, onStep?, config? })
//         -> Promise<{ vocals: [L, R], backing: [L, R], curve, facts, stats, analysis }>
//         analysis = { version: ANALYSIS_VERSION, backing: 'residual' | 'stems' }
//         Rejects with a JobError (name 'JobError', .code as above, or 'cancelled').
//     tools = { separator: { separate(left, right, { signal, onProgress }) },
//               readPitch: async (mono, sampleRate) -> pitch frames, engine, backend, slow,
//               notice?, dispose? }
//     ANALYSIS_VERSION                   whole number, raised whenever the SAVED sound or
//         pitch line of a song would come out different (see the note at the constant)
//     needsReanalyse(song, current = ANALYSIS_VERSION) -> boolean
//         song: a song store entry or record. true only for a song made from the owner's
//         file (kind 'file') whose song.analysis.version is below `current`. A song with no
//         version was analysed before versions existed and counts as version 1. Charts,
//         demo songs, null and anything unreadable: false (nothing to analyse again).
//   Browser:
//     decodeFile(file, { sampleRate? }) -> Promise<{ left, right, sampleRate }>
//         Audio, or video with a sound track (a WebM with a video track decodes directly).
//     loadTools({ backend?, modelBase?, onProgress? }) -> Promise<tools>
//         modelBase: (id) -> folder URL (default: the pinned public revisions in models.js)
//     hasWebGPU() -> Promise<boolean>

import { SONG } from '../song/config.js';
import { songFacts } from '../song/phrases.js';
import { titleFromFile } from '../song/songstore.js';
import { buildCurve, resample, trackMpm, trackSwiftF0, SWIFTF0 } from './pitchcurve.js';
import { createSeparator, fetchModelFile, loadOrt, BACKING_DEFAULT } from './separate.js';
import { MODELS, modelBytes, megabytes } from './models.js';
import { parseUltraStar } from '../../ultrastar.js';
import { midiToTimeline } from '../../midi.js';

export const STEP_WORDS = Object.freeze({
  queued: 'Waiting',
  reading: 'Reading the file',
  separating: 'Separating the voice',
  tracing: 'Tracing the melody',
  saving: 'Saving',
  done: 'Done',
});

export const JOB_WORDS = Object.freeze({
  unreadable: 'This file could not be read as sound. Try an MP3, M4A, WAV, OGG, FLAC or a video with sound.',
  'too-long': 'This file is too long to work on here. Try one under 12 minutes.',
  'no-singing': 'No singing was found in this file.',
  'out-of-memory': 'This Mac ran out of memory working on this song. Close other tabs and try again, or try a shorter file.',
  storage: 'The song could not be saved in this browser (its storage is full or switched off).',
  tools: 'The listening model could not be loaded. Check the internet connection and try again.',
  failed: 'Something went wrong working on this song.',
});

export const NOTICE_WORDS = Object.freeze({
  'no-webgpu': '3D graphics are not available in this browser, so this will take minutes instead of seconds.',
  'pitch-fallback': 'The melody reader could not be loaded; a simpler one is used, which can miss loud choruses.',
});

// The version of what analyseSong saves. 1 = every song analysed up to 2026-10-13 (backing =
// the file minus the vocal stem, voice read by SwiftF0); songs saved before the number
// existed are 1 too. The 2026-10-13 backing measurement changed nothing in the saved sound,
// so it stayed 1: raising it makes the Sing page ask for every older song once more.
export const ANALYSIS_VERSION = 1;

export function needsReanalyse(song, current = ANALYSIS_VERSION) {
  if (!song || song.kind !== 'file') return false;
  const v = song.analysis && Number.isFinite(song.analysis.version) ? song.analysis.version : 1;
  return v < current;
}

const RUNTIME_BYTES = 41_215_724;   // the files in vendor/onnxruntime-web-1.30.0/ (two builds)

export class JobError extends Error {
  constructor(code, cause) {
    super(JOB_WORDS[code] || code);
    this.name = 'JobError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------- pure

export function toolsNeeded() {
  const bytes = modelBytes('htdemucs') + modelBytes('swiftf0') + RUNTIME_BYTES;
  return {
    bytes,
    words: `The first song needs the listening model: ${megabytes(bytes)}, downloaded once and kept in this browser. Your song is not sent anywhere.`,
  };
}

export function estimateSec(durationSec, backend, config = SONG.pipeline) {
  const per = backend === 'webgpu' ? config.estimate.webgpu : config.estimate.wasm;
  return Math.max(1, Math.round(durationSec * per));
}

export function fileKind(name) {
  const n = String(name ?? '').toLowerCase();
  if (/\.txt$/.test(n)) return 'ultrastar';
  if (/\.(mid|midi|kar)$/.test(n)) return 'midi';
  return 'audio';
}

// Browsers and the GPU say "no memory" in many ways.
function isMemoryError(err) {
  const msg = String((err && err.message) || err);
  return /out of memory|allocation failed|failed to allocate|invalid typed array length|array buffer allocation|bad_alloc|device (was )?lost|OOM/i.test(msg);
}
function asJobError(err) {
  if (err instanceof JobError) return err;
  if (err && (err.name === 'AbortError' || err.code === 'cancelled')) return new JobError('cancelled', err);
  if (isMemoryError(err)) return new JobError('out-of-memory', err);
  return new JobError('failed', err);
}

export async function analyseSong({ left, right, sampleRate }, tools, { signal = null, onStep = () => {}, config = SONG.pipeline } = {}) {
  const stopped = () => { if (signal && signal.aborted) throw new JobError('cancelled'); };
  try {
    if (!left || !left.length || !(sampleRate > 0)) throw new JobError('unreadable');
    const duration = left.length / sampleRate;
    if (duration > config.maxSec) throw new JobError('too-long');
    stopped();
    onStep('separating', 0);
    const { vocals, backing, stats } = await tools.separator.separate(left, right || left, {
      signal, onProgress: (p) => onStep('separating', p.total ? Math.min(1, p.done / p.total) : 0),
    });
    stopped();
    onStep('tracing', 0);
    const [a, b] = vocals;
    const voice = b && b !== a ? Float32Array.from(a, (v, i) => (v + b[i]) / 2) : a;
    const frames = await tools.readPitch(voice, sampleRate);
    stopped();
    const { curve } = buildCurve(frames, voice, sampleRate, { engine: tools.engine });
    const facts = songFacts(curve, { duration });
    if (!facts.range || facts.sungSec < config.minSingingSec) throw new JobError('no-singing');
    // What the separator says it built; a stand-in that says nothing built the default.
    const analysis = { version: ANALYSIS_VERSION, backing: (stats && stats.backing) || BACKING_DEFAULT };
    return { vocals, backing, curve, facts, stats: stats || null, analysis };
  } catch (err) {
    // An aborted separation rejects with the signal's own reason.
    if (signal && signal.aborted) throw new JobError('cancelled', err);
    throw asJobError(err);
  }
}

// ---------------------------------------------------------------- browser

export async function decodeFile(file, { sampleRate = SONG.pipeline.sampleRate } = {}) {
  try {
    // An offline context at the model's rate: the browser resamples while decoding, and no
    // sound device is touched.
    const decoder = new OfflineAudioContext(2, 2, sampleRate);
    const audio = await decoder.decodeAudioData(await file.arrayBuffer());
    if (!(audio.length > 0)) throw new Error('no sound in the file');
    const left = audio.getChannelData(0);
    return { left, right: audio.numberOfChannels > 1 ? audio.getChannelData(1) : left, sampleRate: audio.sampleRate };
  } catch (err) {
    throw isMemoryError(err) ? new JobError('out-of-memory', err) : new JobError('unreadable', err);
  }
}

export async function hasWebGPU() {
  try { return !!(globalThis.navigator && navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; }
}

export async function loadTools({ backend = 'auto', modelBase = (id) => MODELS[id].base, onProgress = () => {} } = {}) {
  const separator = await createSeparator({ backend, modelBase: modelBase('htdemucs'), onProgress });
  let engine = 'swiftf0', notice = null, readPitch;
  try {
    const ort = await loadOrt('wasm');
    const file = MODELS.swiftf0.files[0];
    const { data } = await fetchModelFile(modelBase('swiftf0') + file.name, file);
    const session = await ort.InferenceSession.create(new Uint8Array(data), { executionProviders: ['wasm'], logSeverityLevel: 3 });
    readPitch = (mono, rate) => trackSwiftF0(resample(mono, rate, SWIFTF0.sampleRate), { ort, session });
  } catch {
    // Without the small pitch model the song can still be traced, less well.
    engine = 'mpm';
    notice = 'pitch-fallback';
    readPitch = async (mono, rate) => trackMpm(mono, rate);
  }
  const used = separator.info.backend;
  return { separator, readPitch, engine, backend: used, slow: used !== 'webgpu', notice, info: separator.info, dispose: () => separator.dispose() };
}

// ---------------------------------------------------------------- the queue

// Share of a song's work each step takes, for one progress number per job.
const SHARE = { reading: 0.05, separating: 0.8, tracing: 0.1, saving: 0.05 };
const BEFORE = { reading: 0, separating: 0.05, tracing: 0.85, saving: 0.95, done: 1 };

export function createJobs({ loadTools: load = loadTools, decode = decodeFile, store = null, config = SONG.pipeline, now = () => Date.now() } = {}) {
  const subs = new Set(), list = [], waiters = [];
  let tools = null, toolsState = 'none', toolsProgress = null, loading = null, running = null, pumping = false, wentOnce = false, seq = 0, destroyed = false;

  const view = (j) => ({ id: j.id, name: j.name, kind: j.kind, status: j.status, step: j.step, progress: j.progress, etaSec: j.etaSec, error: j.error, songId: j.songId, title: j.title });
  const state = () => ({
    tools: toolsState, backend: tools ? tools.backend : null, slow: tools ? !!tools.slow : null, toolsProgress,
    needsGo: !wentOnce && list.some((j) => j.status === 'queued' && j.kind === 'audio'),
    jobs: list.map(view),
  });
  const emit = (event) => { for (const fn of [...subs]) { try { fn(event); } catch { /* a listener's own trouble */ } } };
  const changed = () => emit({ type: 'state', state: state() });
  const canStart = (j) => j.status === 'queued' && (j.kind !== 'audio' || toolsState === 'ready');

  function step(j, name, part = 0) {
    j.step = name;
    j.progress = Math.min(1, Math.round((BEFORE[name] + (SHARE[name] || 0) * part) * 1000) / 1000);
    if (j.kind === 'audio' && j.duration && tools) {
      // Before any piece is done: the measured rate. After: how the pieces have really gone.
      const spent = (now() - j.startedAt) / 1000;
      j.etaSec = name === 'done' ? 0 : j.progress > 0.12 ? Math.max(1, Math.round((spent / j.progress) * (1 - j.progress))) : estimateSec(j.duration, tools.backend, config);
    }
    changed();
  }
  function fail(j, err) {
    const e = asJobError(err);
    if (e.code === 'cancelled') { j.status = 'cancelled'; j.error = null; } else { j.status = 'failed'; j.error = { code: e.code, words: e.message }; }
    j.etaSec = null;
    changed();
    if (j.status === 'failed') emit({ type: 'failed', job: view(j) });
  }

  async function runChart(j) {
    step(j, 'reading');
    let timeline;
    try {
      timeline = j.kind === 'ultrastar' ? parseUltraStar(await j.file.text()) : midiToTimeline(await j.file.arrayBuffer(), { title: titleFromFile(j.name).title });
    } catch (err) { throw new JobError('unreadable', err); }
    step(j, 'saving');
    const saved = store ? await store.addChart(timeline, { fileName: j.name }) : { ok: true, id: null };
    if (!saved.ok) throw new JobError(saved.reason === 'empty' ? 'unreadable' : 'storage');
    return { saved, songId: saved.id, facts: null, result: store ? undefined : { timeline } };
  }
  async function runSong(j) {
    step(j, 'reading');
    const sound = await decode(j.file);
    if (j.stopper.signal.aborted) throw new JobError('cancelled');
    j.duration = sound.left.length / sound.sampleRate;
    const out = await analyseSong(sound, tools, { signal: j.stopper.signal, config, onStep: (name, part) => step(j, name, part) });
    step(j, 'saving');
    const facts = { ...titleFromFile(j.name), duration: out.facts.duration, curve: out.curve, phrases: out.facts.phrases, range: out.facts.range, fileName: j.name };
    // `analysis` rides along for the store to keep.
    const full = { ...facts, analysis: out.analysis, backing: { channels: out.backing, sampleRate: sound.sampleRate }, vocal: { channels: out.vocals, sampleRate: sound.sampleRate } };
    const saved = store ? await store.addSong(full) : { ok: true, id: null };
    if (!saved.ok) throw new JobError(saved.reason === 'too-big' ? 'out-of-memory' : saved.reason === 'empty' ? 'no-singing' : 'storage');
    return { saved, songId: saved.id, facts: out.facts, analysis: out.analysis, result: store ? undefined : { ...full, stats: out.stats } };
  }

  async function pump() {
    if (pumping || destroyed) return;
    pumping = true;
    try {
      for (let j = list.find(canStart); j && !destroyed; j = list.find(canStart)) {
        running = j;
        j.status = 'running';
        j.startedAt = now();
        j.stopper = new AbortController();
        j.title = titleFromFile(j.name).title;
        try {
          const done = j.kind === 'audio' ? await runSong(j) : await runChart(j);
          if (j.stopper.signal.aborted) throw new JobError('cancelled');
          j.status = 'done';
          j.songId = done.songId;
          step(j, 'done');
          emit({ type: 'done', job: view(j), ...done });
        } catch (err) {
          fail(j, j.stopper.signal.aborted ? new JobError('cancelled', err) : err);
        }
        j.file = null;        // let the dropped file's bytes go
        running = null;
      }
    } finally {
      pumping = false;
      if (!list.some(canStart)) for (const w of waiters.splice(0)) w();
    }
  }

  return {
    add(files) {
      const given = files && typeof files.length === 'number' && !(typeof files.arrayBuffer === 'function') ? [...files] : [files];
      const ids = [];
      for (const file of given) {
        if (!file) continue;
        const name = String(file.name || 'Untitled');
        const j = { id: `job-${++seq}`, name, kind: fileKind(name), file, status: 'queued', step: 'queued', progress: 0, etaSec: null, error: null, songId: null, title: titleFromFile(name).title };
        list.push(j);
        ids.push(j.id);
      }
      changed();
      pump();
      return ids;
    },
    go() {
      wentOnce = true;
      if (toolsState === 'ready') { pump(); return Promise.resolve({ ok: true, backend: tools.backend, slow: !!tools.slow }); }
      if (!loading) {
        toolsState = 'loading';
        changed();
        loading = Promise.resolve()
          .then(() => load({ onProgress: (p) => { toolsProgress = p; changed(); } }))
          .then((got) => {
            if (destroyed) { if (got.dispose) got.dispose(); return { ok: false, reason: 'tools', words: JOB_WORDS.tools }; }
            tools = got;
            toolsState = 'ready';
            toolsProgress = null;
            changed();
            if (tools.slow) emit({ type: 'notice', code: 'no-webgpu', words: NOTICE_WORDS['no-webgpu'] });
            if (tools.notice) emit({ type: 'notice', code: tools.notice, words: NOTICE_WORDS[tools.notice] });
            pump();
            return { ok: true, backend: tools.backend, slow: !!tools.slow };
          }, (err) => {
            toolsState = 'failed';
            toolsProgress = null;
            changed();
            for (const w of waiters.splice(0)) w();
            return { ok: false, reason: 'tools', words: JOB_WORDS.tools, error: err };
          })
          .finally(() => { loading = null; });
      }
      return loading;
    },
    cancel(id) {
      for (const j of list) {
        if (id !== undefined && j.id !== id) continue;
        if (j.status === 'queued') { j.status = 'cancelled'; j.file = null; }
        else if (j.status === 'running' && j.stopper) j.stopper.abort();
      }
      changed();
      if (!running && !list.some(canStart)) for (const w of waiters.splice(0)) w();
    },
    state,
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    idle() {
      if (!pumping && !list.some(canStart) && !loading) return Promise.resolve();
      return new Promise((r) => waiters.push(r));
    },
    destroy() {
      if (destroyed) return;
      this.cancel();
      destroyed = true;
      subs.clear();
      if (tools && tools.dispose) { try { tools.dispose(); } catch { /* already gone */ } }
      tools = null;
    },
  };
}
