// myvoice.js — "My voice" v3 recordings: up to three short held notes of the singer's own
// voice (low, middle, high of their range), kept in this browser's IndexedDB only, played
// back at any reference pitch by js/psola.js through js/synth.js timbreFor('mine').
//
// Why recordings and not only a tone-colour envelope (v2, ownvoicekey.js): only a real
// snippet carries a voice's breath, onset and wobble, so v2 still sounded like a synth.
// Owner, 2026-10-15: "anyone who records it" hears their own voice.
//
// Privacy: the samples never leave the browser. Erase deletes the database (DB_NAME belongs
// in shell.js SAVED_DATABASES). Backups do not carry it (opt-out by default).
//
// CONTRACT
//   DB_NAME = 'music-trainer.myvoice.v1'; MAX_RECORDINGS = 3
//   prepareRecording(data, rate, cfg?) -> { ok: true, rec } | { ok: false, reason, words }
//       data: Float32Array mono (-1..1) at `rate`. Checks the take (clipped, too quiet,
//       noisy, too short, wobbling), keeps its steadiest stretch (<= cfg.maxSec) and brings
//       it to about 24 kHz (whole-number decimation behind a low-pass).
//       rec = { rate, hz (median pitch), midi, data: Float32Array, at: ISO string }
//       reason: 'clipped' | 'quiet' | 'noisy' | 'short' | 'wobbly'; words: what to tell them.
//   keepRecordings(list, rec, max = MAX_RECORDINGS) -> new list: a take within
//       cfg.sameSemis of one already kept replaces it; else it is added; when full it
//       replaces the nearest. Sorted low to high.
//   createStitcher({ maxSamples }) -> { push(buf), longest(), segments() }: overlapping reads
//       of one AnalyserNode ring joined without repeats; a read that shares no samples with the
//       last one (missed frames) starts a new segment. Keeps the newest maxSamples in all.
//       longest() -> Float32Array | null. Pure.
//   openStore({ indexedDB?, onGone? }) -> { all(), add(rec), clear() }   [browser; Promises]
//       all() -> recs (Float32 data); add(rec) -> the kept list; clear() deletes them all.
//       onGone() is called when another caller deletes the database (Erase my data).
//   Recordings in memory for js/synth.js: current() -> recs | null (null until loaded or
//       when none); refresh() -> Promise; useRecordingsStore(store) for labs/checks.
//
// Failure behaviour: prepareRecording never throws on audio (it refuses with a reason);
// a store without IndexedDB resolves all() to [] and add() to the list it would keep.

import { analyse } from '../pitch.js';

export const DB_NAME = 'music-trainer.myvoice.v1';
export const MAX_RECORDINGS = 3;
export const RECORDING = Object.freeze({
  maxSec: 1.0,          // the steadiest stretch kept; PSOLA walks it back and forth for longer notes
  captureSec: 1.5,      // the newest held audio stitched together; the steadiest maxSec of it is kept
  minSec: 0.45,         // GUESS. shorter than this and a long note repeats too often
  targetRate: 24000,    // a sung "oo" has next to nothing above 10 kHz; half the size of 48 kHz
  clipLevel: 0.985, clipShare: 0.002,   // > 0.2 % of samples at full scale = clipped
  minRms: 0.01,         // GUESS. quieter than this the room noise is a large share
  minVoiced: 0.85,      // share of frames with a trustworthy pitch in the kept stretch
  maxWobble: 45,        // GUESS. cents, standard deviation in the kept stretch (vibrato is ~15-30)
  sameSemis: 2.5,       // a new take this close to a kept one replaces it
});

const WORDS = {
  clipped: 'That was too loud for the microphone. Sing a little softer, or move back a bit, and try again.',
  quiet: 'That was too quiet to keep. Sing a little louder, or come closer, and try again.',
  noisy: 'There was too much noise or breath in that. Hold one clear, steady note and try again.',
  short: 'That was too short to keep. Hold the note steady for a couple of seconds.',
  wobbly: 'The note moved around too much. Hold one steady note and try again.',
};
const refuse = (reason) => ({ ok: false, reason, words: WORDS[reason] });

// Whole-number decimation behind a windowed-sinc low-pass (cut at 0.45 of the new rate):
// plain sample dropping would fold the voice's top into audible whistles.
function decimate(data, factor) {
  if (factor <= 1) return Float32Array.from(data);
  const taps = 8 * factor + 1, h = new Float64Array(taps), fc = 0.45 / factor, mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    h[i] = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1)));
    sum += h[i];
  }
  const n = Math.floor(data.length / factor), out = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    let acc = 0;
    const c = o * factor;
    for (let i = 0; i < taps; i++) { const j = c + i - mid; if (j >= 0 && j < data.length) acc += h[i] * data[j]; }
    out[o] = acc / sum;
  }
  return out;
}

export function prepareRecording(data, rate, cfg = RECORDING, nowIso = new Date().toISOString()) {
  if (!data || !data.length || !(rate > 0)) return refuse('short');
  let clipped = 0, sq = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a >= cfg.clipLevel) clipped++; sq += a * a; }
  if (clipped > cfg.clipShare * data.length) return refuse('clipped');
  if (Math.sqrt(sq / data.length) < cfg.minRms) return refuse('quiet');
  const factor = Math.max(1, Math.round(rate / cfg.targetRate));
  const x = decimate(data, factor), r = rate / factor;
  const hop = 128, frames = analyse(x, r, { hop });
  if (!frames.length) return refuse('short');
  const win = Math.max(1, Math.floor((Math.min(cfg.maxSec, x.length / r) * r - 2048) / hop) + 1);
  // Slide a window over the frames: the stretch with the most voiced frames, then the least
  // pitch spread, is the steadiest part of the hold.
  let best = null;
  for (let s = 0; s + win <= frames.length; s++) {
    const m = [];
    for (let i = s; i < s + win; i++) if (frames[i].voiced) m.push(frames[i].midi);
    const voiced = m.length / win;
    if (voiced < cfg.minVoiced) continue;
    const mean = m.reduce((a, b) => a + b, 0) / m.length;
    const sd = 100 * Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / m.length);
    if (!best || sd < best.sd) best = { s, sd, m };
  }
  if (!best) return refuse(x.length / r < cfg.minSec ? 'short' : 'noisy');
  const start = best.s * hop, end = Math.min(x.length, (best.s + win - 1) * hop + 2048);
  if ((end - start) / r < cfg.minSec) return refuse('short');
  if (best.sd > cfg.maxWobble) return refuse('wobbly');
  const sorted = best.m.slice().sort((a, b) => a - b), midi = sorted[sorted.length >> 1];
  return { ok: true, rec: { rate: r, midi, hz: 440 * 2 ** ((midi - 69) / 12), data: x.slice(start, end), at: nowIso } };
}

// A take longer than one AnalyserNode holds (32768 samples, ~0.7 s) with no worklet and no
// second getUserMedia: read the same analyser on every frame and keep only what is new. The
// reads come from one ring, so the samples already kept appear again, bit for bit, in the next
// read; where the last TAIL kept samples end in it is where the new audio starts. Searching
// from the end finds the smallest step (a repeating signal stays seamless either way). No
// match means frames were missed (a gap): a new segment starts, never a spliced click.
const TAIL = 64;
export function createStitcher({ maxSamples }) {
  const segs = [];
  let cur = null;
  function matchEnd(buf) {
    const t = cur.tail, last = t[TAIL - 1];
    for (let p = buf.length; p >= TAIL; p--) {
      if (buf[p - 1] !== last) continue;
      let i = TAIL - 2;
      while (i >= 0 && buf[p - TAIL + i] === t[i]) i--;
      if (i < 0) return p;
    }
    return -1;
  }
  function append(part) {
    if (!part.length) return;
    cur.chunks.push(Float32Array.from(part));
    cur.n += part.length;
    const t = new Float32Array(TAIL), src = cur.chunks;
    // the tail spans chunks when the newest one is shorter than TAIL
    for (let i = TAIL - 1, c = src.length - 1, j = src[c].length - 1; i >= 0 && c >= 0; i--) {
      t[i] = src[c][j];
      if (--j < 0 && --c >= 0) j = src[c].length - 1;
    }
    cur.tail = t;
    // rolling: only the newest maxSamples are worth keeping (prepareRecording's cost grows with length)
    let total = segs.reduce((a, s) => a + s.n, 0);
    while (total > maxSamples && segs.length) {
      const s = segs[0], over = total - maxSamples, first = s.chunks[0];
      if (first.length <= over) { s.chunks.shift(); s.n -= first.length; total -= first.length; }
      else { s.chunks[0] = first.subarray(over); s.n -= over; total -= over; }
      if (!s.n) segs.shift();
    }
  }
  return {
    push(buf) {
      if (!buf || buf.length < TAIL) return;
      const p = cur && cur.n >= TAIL ? matchEnd(buf) : -1;
      if (p < 0) { cur = { chunks: [], n: 0, tail: null }; segs.push(cur); append(buf); }
      else append(buf.subarray(p));
    },
    // The longest segment, oldest sample first; null before the first push.
    longest() {
      let best = null;
      for (const s of segs) if (s.n && (!best || s.n > best.n)) best = s;
      if (!best) return null;
      const out = new Float32Array(best.n);
      let o = 0;
      for (const c of best.chunks) { out.set(c, o); o += c.length; }
      return out;
    },
    segments: () => segs.filter((s) => s.n).length,
  };
}

export function keepRecordings(list, rec, max = MAX_RECORDINGS, cfg = RECORDING) {
  const kept = (list || []).slice();
  let near = -1;
  kept.forEach((k, i) => { if (near < 0 || Math.abs(k.midi - rec.midi) < Math.abs(kept[near].midi - rec.midi)) near = i; });
  if (near >= 0 && (Math.abs(kept[near].midi - rec.midi) <= cfg.sameSemis || kept.length >= max)) kept[near] = rec;
  else kept.push(rec);
  return kept.sort((a, b) => a.midi - b.midi);
}

// ------------------------------------------------------------------ IndexedDB (browser)
// One object store, one record per take; samples as 16-bit (half the bytes of Float32).
const STORE = 'takes';
const toStored = (r, id) => ({ id, rate: r.rate, midi: r.midi, hz: r.hz, at: r.at, pcm: Int16Array.from(r.data, (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)))) });
const fromStored = (s) => ({ rate: s.rate, midi: s.midi, hz: s.hz, at: s.at, data: Float32Array.from(s.pcm, (v) => v / 32767) });

export function openStore({ indexedDB: idb = globalThis.indexedDB, onGone = () => {} } = {}) {
  let db = null;
  const open = () => db || (db = new Promise((ok, fail) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    // Erase (indexedDB.deleteDatabase) waits for every open connection: let go when asked,
    // and open afresh on the next use.
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); db = null; onGone(); }; ok(req.result); };
    req.onerror = () => fail(req.error);
  }));
  const run = (mode, fn) => open().then((d) => new Promise((ok, fail) => {
    const tx = d.transaction(STORE, mode), st = tx.objectStore(STORE);
    let value;
    fn(st, (v) => { value = v; });
    tx.oncomplete = () => ok(value);
    tx.onerror = () => fail(tx.error);
  }));
  const all = () => (idb ? run('readonly', (st, put) => { const q = st.getAll(); q.onsuccess = () => put(q.result.map(fromStored)); }) : Promise.resolve([]));
  return {
    all,
    async add(rec) {
      const kept = keepRecordings(await all(), rec);
      if (idb) await run('readwrite', (st) => { st.clear(); kept.forEach((r, i) => st.put(toStored(r, i))); });
      return kept;
    },
    clear: () => (idb ? run('readwrite', (st) => st.clear()) : Promise.resolve()),
  };
}

// ------------------------------------------------------------------ in memory, for synth.js
let store = null, cache = null, loading = null;
// Erase my data deletes the database from shell.js: the next note must stop being the
// singer's voice at once, not on the next page load.
const defaultStore = () => openStore({ onGone: () => { cache = null; } });
export function useRecordingsStore(s) { store = s; cache = null; loading = null; }
export function current() { return cache && cache.length ? cache : null; }
export function refresh() {
  if (!store) store = defaultStore();
  loading = store.all().then((recs) => { cache = recs; return current(); }, () => { cache = null; return null; });
  return loading;
}
export async function addRecording(rec) { if (!store) store = defaultStore(); cache = await store.add(rec); return cache; }
export async function eraseRecordings() { cache = null; if (!store) store = defaultStore(); await store.clear(); cache = null; }
