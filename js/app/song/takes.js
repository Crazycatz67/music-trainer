// takes.js — the singer's recorded takes, kept on this machine only.
//
// Nothing in this file talks to a network: a take goes into the browser's own IndexedDB for
// this site and comes back out of it. It is never uploaded, never put in the repo.
//
// The rules (bound, clean-up, bad data) are PURE and run in Node against memoryBackend();
// idbBackend() is the thin browser half behind the same five-call interface.
//
// SIZE. Sound is stored 16-bit, one channel (2 bytes a sample: about 5.8 MB a minute at
// 48 kHz); pitch frames as three 32-bit numbers each. All takes together stay within
// `maxBytes` (config.takes.maxBytes). When a new take would go over, the OLDEST takes are
// removed first, and save() says which ones in `removed` and in `words`, so the screen can
// tell the owner. A single take bigger than the whole bound is refused, and nothing is removed.
// A take marked `pinned` ("Protect") is never removed to make room; when only pinned takes
// are left and there is still no room, save() answers 'storage'. wouldRemove(bytes) says
// BEFORE a recording what a take of that size would push out.
//
// A TAKE BEING RECORDED is written in pieces (append) and marked finished at the end
// (finish), so a closed tab or a crash keeps everything up to the last piece. list() shows
// such a take with `finished: false`, and load() joins its pieces.
// (The browser may also clear a site's storage when the disk is very full; that is outside
// this file and is why export exists.)
//
// CONTRACT
//   createTakeStore({ backend, maxBytes?, now? }) -> store        every method is async
//     store.save(take, { songId?, nudgeMs?, frames?, title? }) ->
//         { ok: true, id, bytes, removed: [meta], words: string | null }
//       | { ok: false, reason: 'too-big' | 'empty' | 'storage', words }
//         take = what js/app/song/recorder.js makes. frames default to take.frames.
//     store.list() -> { takes: [meta] (newest first), bytes, maxBytes, dropped }
//         meta = { id, songId, title, createdAt, seconds, sampleRate, songStart, nudgeMs,
//                  latency, endedBy, gaps, frameCount, bytes }
//         dropped = records that were not readable and have been removed.
//     store.load(id) -> take | null         null: no such take, or its data was damaged
//                                           (a damaged one is removed)
//     store.setNudge(id, ms) -> boolean
//     store.update(id, { title?, pinned?, isNew?, lines?, nudgeMs? }) -> boolean
//     store.wouldRemove(bytes) -> { fits, remove: [meta], words, reason: null | 'too-big' | 'pinned' }
//         words: what would be removed, or when it does not fit the sentence to show
//         (TAKE_WORDS.pinned: every kept take is protected; TAKE_WORDS['too-big']).
//     store.append(id, facts, samples, frames?) -> { ok: true, bytes, removed, words } | { ok: false, reason, words }
//         One more piece of take `id` (created by its first piece). facts = the take's
//         fields known so far (songId, title, createdAt, sampleRate, songStart, latency,
//         gaps, fromSec, octave, key); samples: Float32Array, the NEW sound only.
//     store.finish(id, facts?) -> the same shape; marks it finished and new (isNew)
//     meta also carries: pinned, isNew, finished, pieces, lines, fromSec, octave, key, and
//         kind: 'song' (default, also every take saved before 2026-10-15) | 'free' (a Free sing
//         take: songId null, js/app/freesing.js). Song lists leave 'free' takes out; they
//         still share maxBytes, the oldest-first rule, backup and load().
//     store.unfinished() -> [meta]   interrupted takes (finished false), newest first;
//         they are in list().takes too
//     store.remove(id) -> boolean
//     store.removeAll({ includingProtected = false }) -> number     how many were removed.
//         Protected (pinned) takes are KEPT unless includingProtected is true: "Protect"
//         must hold against "delete all" too. A screen's button says which it does.
//     store.appendNow(id, facts, samples, frames?, { finished = false }) -> boolean
//         The same piece as append(), but STARTED IN THIS TURN: for the moment the page is
//         going away (reload, close, leaving), when no later turn may ever run. It needs no
//         read first: the store remembers the facts of the take it is writing. true when the
//         write was handed to the browser. No room is made (nothing is removed) and the
//         bound is not checked: one last piece may go over it. `finished` marks the take
//         complete (endedBy from facts). With no new sound it only marks. Do not call it
//         while an append() of the same take is still running (the recorder does not).
//   Storage that cannot be opened or read (private window, damaged database): list() gives
//   an empty list with `unavailable: true`, save() gives reason 'storage', nothing throws.
//
//   backend = { metas() -> [raw], put(meta, body), body(id) -> { pcm: ArrayBuffer, frames:
//               ArrayBuffer } | undefined, setMeta(meta), remove(id), clear(),
//               putPiece(meta, n, body) }   all async. body(id + '#' + n) reads piece n;
//               writeNow(meta, n | null, body | null) -> boolean   NOT async: starts the write
//               in the calling turn (false when it cannot: the database is not open yet).
//               remove(id) removes its pieces too.
//   memoryBackend() -> backend (+ .raw for checks)      idbBackend({ name?, indexedDB? }) ->
//   backend (+ .destroy() deletes the database)
//   Pure: packFrames(frames) / unpackFrames(buffer), cleanMeta(raw), planRoom(metas, bytes, maxBytes)

import { SONG } from './config.js';
import { toFloat32, toInt16 } from './pcm.js';
import { midiToHz } from '../../notes.js';

export const TAKE_WORDS = Object.freeze({
  'too-big': 'This take is too long to keep here. Save it as a file instead.',
  empty: 'There was nothing recorded to keep.',
  storage: 'The take could not be saved in this browser (its storage is full or switched off). Save it as a file instead.',
  pinned: 'No room: every kept take is protected. Remove one to record.',
});

// ---------------------------------------------------------------- pure

// Three numbers a frame: time, pitch (NaN = no trustworthy pitch), clarity.
export function packFrames(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const out = new Float32Array(list.length * 3);
  list.forEach((f, i) => {
    out[3 * i] = f.t;
    out[3 * i + 1] = f.voiced && Number.isFinite(f.midi) ? f.midi : NaN;
    out[3 * i + 2] = Number.isFinite(f.clarity) ? f.clarity : 0;
  });
  return out.buffer;
}

export function unpackFrames(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength % 12) return [];
  const a = new Float32Array(buffer), out = [];
  for (let i = 0; i < a.length; i += 3) {
    const voiced = Number.isFinite(a[i + 1]);
    // An unvoiced frame never gets an invented pitch (the project's pitch-frame contract).
    out.push({ t: a[i], hz: voiced ? midiToHz(a[i + 1]) : null, midi: voiced ? a[i + 1] : null, clarity: a[i + 2], voiced });
  }
  return out;
}

const num = (v) => (Number.isFinite(v) ? v : null);

export function cleanMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!(Number.isFinite(raw.sampleRate) && raw.sampleRate >= 3000 && raw.sampleRate <= 768000)) return null;
  if (!(Number.isFinite(raw.bytes) && raw.bytes > 0)) return null;
  // "take#3" is the key of a piece, never a take's own id.
  if (raw.id.includes('#')) return null;
  if (typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt))) return null;
  const l = raw.latency && typeof raw.latency === 'object' ? raw.latency : {};
  return {
    id: raw.id,
    songId: raw.songId == null ? null : String(raw.songId),
    title: typeof raw.title === 'string' ? raw.title : '',
    createdAt: raw.createdAt,
    seconds: num(raw.seconds) ?? 0,
    sampleRate: raw.sampleRate,
    songStart: num(raw.songStart),
    nudgeMs: num(raw.nudgeMs) ?? 0,
    latency: { input: num(l.input), output: num(l.output), base: num(l.base) },
    endedBy: typeof raw.endedBy === 'string' ? raw.endedBy : null,
    gaps: num(raw.gaps) ?? 0,
    frameCount: num(raw.frameCount) ?? 0,
    bytes: raw.bytes,
    pinned: raw.pinned === true,
    isNew: raw.isNew === true,
    finished: raw.finished !== false,
    pieces: Number.isInteger(raw.pieces) && raw.pieces > 0 ? raw.pieces : 0,
    lines: raw.lines && typeof raw.lines === 'object' ? raw.lines : null,
    fromSec: num(raw.fromSec), octave: num(raw.octave) ?? 0, key: num(raw.key) ?? 0,
    kind: raw.kind === 'free' ? 'free' : 'song',
  };
}

// Which of the kept takes must go, oldest first, so that `bytes` more fit inside maxBytes.
// Protected (pinned) takes are never chosen. When only protected takes are left and there
// is still no room: { fits: false, remove: [], reason: 'pinned' }.
export function planRoom(metas, bytes, maxBytes) {
  if (bytes > maxBytes) return { fits: false, remove: [] };
  let total = metas.reduce((s, m) => s + m.bytes, 0) + bytes;
  const oldest = metas.filter((m) => !m.pinned).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const remove = [];
  while (total > maxBytes && oldest.length) { const m = oldest.shift(); remove.push(m); total -= m.bytes; }
  return total > maxBytes ? { fits: false, remove: [], reason: 'pinned' } : { fits: true, remove };
}

export function removedWords(removed) {
  if (!removed.length) return null;
  const when = (m) => new Date(m.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return removed.length === 1
    ? `To make room, your oldest take (${when(removed[0])}) was removed.`
    : `To make room, your ${removed.length} oldest takes were removed (the newest of them from ${when(removed[removed.length - 1])}).`;
}

export function createTakeStore({ backend, maxBytes = SONG.takes.maxBytes } = {}) {
  if (!backend) throw new TypeError('createTakeStore: a backend is required');
  // The facts of each take being recorded, as last written: appendNow() cannot read first.
  const liveMeta = new Map();

  // Every readable record, and the ids of the ones that are not.
  async function read() {
    const raws = await backend.metas();
    const metas = [], bad = [];
    for (const raw of Array.isArray(raws) ? raws : []) {
      const m = cleanMeta(raw);
      if (m) metas.push(m);
      else bad.push(raw && typeof raw === 'object' ? raw.id : undefined);
    }
    for (const id of bad) { try { if (id !== undefined && id !== null) await backend.remove(id); } catch { /* still listed next time */ } }
    return { metas, dropped: bad.length };
  }

  // The pieces of a take written while it was recorded, as one body.
  async function joinPieces(meta) {
    const parts = [];
    for (let n = 0; n < meta.pieces; n++) {
      const piece = await backend.body(`${meta.id}#${n}`);
      // A missing piece would shift everything after it against the song: stop there.
      if (!piece || !(piece.pcm instanceof ArrayBuffer)) break;
      parts.push(piece);
    }
    const join = (key) => {
      const out = new Uint8Array(parts.reduce((sum, p) => sum + (p[key] instanceof ArrayBuffer ? p[key].byteLength : 0), 0));
      let at = 0;
      for (const p of parts) if (p[key] instanceof ArrayBuffer) { out.set(new Uint8Array(p[key]), at); at += p[key].byteLength; }
      return out.buffer;
    };
    return parts.length ? { pcm: join('pcm'), frames: join('frames') } : undefined;
  }

  return {
    maxBytes,
    async list() {
      try {
        const { metas, dropped } = await read();
        metas.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return { takes: metas, bytes: metas.reduce((s, m) => s + m.bytes, 0), maxBytes, dropped };
      } catch {
        return { takes: [], bytes: 0, maxBytes, dropped: 0, unavailable: true };
      }
    },
    async save(take, { songId = take && take.songId, nudgeMs = take && take.nudgeMs, frames = take && take.frames, title = '' } = {}) {
      const no = (reason) => ({ ok: false, reason, words: TAKE_WORDS[reason] });
      if (!take || !take.samples || !take.samples.length || !(take.sampleRate > 0)) return no('empty');
      const pcm = toInt16(take.samples).buffer, packed = packFrames(frames);
      const bytes = pcm.byteLength + packed.byteLength;
      try {
        const { metas } = await read();
        const plan = planRoom(metas.filter((m) => m.id !== take.id), bytes, maxBytes);
        if (!plan.fits) return no(plan.reason === 'pinned' ? 'storage' : 'too-big');
        // Written whole: any pieces of the same take from an interrupted recording go.
        if (metas.some((m) => m.id === take.id)) await backend.remove(take.id);
        for (const m of plan.remove) await backend.remove(m.id);
        const meta = cleanMeta({
          pinned: take.pinned, isNew: take.isNew, lines: take.lines, fromSec: take.fromSec, octave: take.octave, key: take.key, kind: take.kind,
          id: take.id || `take-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          songId, title,
          createdAt: take.createdAt || new Date().toISOString(),
          seconds: take.samples.length / take.sampleRate,
          sampleRate: take.sampleRate, songStart: take.songStart, nudgeMs,
          latency: take.latency, endedBy: take.endedBy, gaps: take.gaps,
          frameCount: packed.byteLength / 12, bytes,
        });
        await backend.put(meta, { pcm, frames: packed });
        return { ok: true, id: meta.id, bytes, removed: plan.remove, words: removedWords(plan.remove) };
      } catch {
        return no('storage');
      }
    },
    async load(id) {
      try {
        const { metas } = await read();
        const meta = metas.find((m) => m.id === id);
        if (!meta) return null;
        const body = meta.pieces ? await joinPieces(meta) : await backend.body(id);
        const ok = body && body.pcm instanceof ArrayBuffer && body.pcm.byteLength > 0 && body.pcm.byteLength % 2 === 0;
        if (!ok) { await backend.remove(id); return null; }
        const samples = toFloat32(new Int16Array(body.pcm));
        return {
          pinned: meta.pinned, isNew: meta.isNew, finished: meta.finished, lines: meta.lines, fromSec: meta.fromSec, octave: meta.octave, key: meta.key,
          id: meta.id, songId: meta.songId, title: meta.title, createdAt: meta.createdAt,
          sampleRate: meta.sampleRate, samples, seconds: samples.length / meta.sampleRate,
          songStart: meta.songStart, latency: meta.latency, nudgeMs: meta.nudgeMs,
          gaps: meta.gaps, endedBy: meta.endedBy, frames: unpackFrames(body.frames), kind: meta.kind,
        };
      } catch {
        return null;
      }
    },
    async update(id, patch = {}) {
      try {
        const { metas } = await read();
        const meta = metas.find((m) => m.id === id);
        if (!meta) return false;
        const next = { ...meta };
        if (typeof patch.title === 'string') next.title = patch.title;
        if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
        if (typeof patch.isNew === 'boolean') next.isNew = patch.isNew;
        if (patch.lines !== undefined) next.lines = patch.lines;
        if (Number.isFinite(patch.nudgeMs)) next.nudgeMs = patch.nudgeMs;
        await backend.setMeta(next);
        return true;
      } catch { return false; }
    },
    // Takes whose recording was cut short (a closed tab, a crash), newest first.
    async unfinished() {
      try {
        const { metas } = await read();
        return metas.filter((m) => !m.finished).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      } catch { return []; }
    },
    async wouldRemove(bytes) {
      try {
        const { metas } = await read();
        const plan = planRoom(metas, Math.max(0, bytes || 0), maxBytes);
        const reason = plan.fits ? null : plan.reason || 'too-big';
        return { fits: plan.fits, remove: plan.remove, words: plan.fits ? removedWords(plan.remove) : TAKE_WORDS[reason], reason };
      } catch {
        return { fits: false, remove: [], words: null, reason: 'storage' };
      }
    },
    async append(id, facts, samples, frames = []) {
      const no = (reason) => ({ ok: false, reason, words: TAKE_WORDS[reason] });
      if (!id || !samples || !samples.length || !facts || !(facts.sampleRate > 0)) return no('empty');
      const pcm = toInt16(samples).buffer, packed = packFrames(frames);
      try {
        const { metas } = await read();
        const old = metas.find((m) => m.id === id);
        const bytes = (old ? old.bytes : 0) + pcm.byteLength + packed.byteLength;
        const plan = planRoom(metas.filter((m) => m.id !== id), bytes, maxBytes);
        if (!plan.fits) return no(plan.reason === 'pinned' ? 'storage' : 'too-big');
        for (const m of plan.remove) await backend.remove(m.id);
        const n = old ? old.pieces : 0;
        const meta = cleanMeta({
          ...(old || {}), ...facts, id,
          createdAt: (old && old.createdAt) || facts.createdAt || new Date().toISOString(),
          seconds: (old ? old.seconds : 0) + samples.length / facts.sampleRate,
          frameCount: (old ? old.frameCount : 0) + packed.byteLength / 12,
          // A take already marked finished by appendNow() (the page was going, then lived
          // long enough to hand over its last chunk) stays finished.
          endedBy: old && old.finished ? old.endedBy : null, finished: !!(old && old.finished), pieces: n + 1, bytes,
        });
        await backend.putPiece(meta, n, { pcm, frames: packed });
        liveMeta.set(id, meta);
        return { ok: true, id, bytes, removed: plan.remove, words: removedWords(plan.remove) };
      } catch {
        return no('storage');
      }
    },
    appendNow(id, facts, samples, frames = [], { finished = false } = {}) {
      try {
        if (typeof backend.writeNow !== 'function' || !id || !facts || !(facts.sampleRate > 0)) return false;
        const old = liveMeta.get(id) || null, has = !!(samples && samples.length);
        if (!has && !old) return false;
        const pcm = has ? toInt16(samples).buffer : null, packed = has ? packFrames(frames) : null;
        const n = old ? old.pieces : 0;
        const meta = cleanMeta({
          ...(old || {}), ...facts, id,
          createdAt: (old && old.createdAt) || facts.createdAt || new Date().toISOString(),
          seconds: (old ? old.seconds : 0) + (has ? samples.length / facts.sampleRate : 0),
          frameCount: (old ? old.frameCount : 0) + (has ? packed.byteLength / 12 : 0),
          endedBy: finished ? facts.endedBy || null : null, finished: !!finished, ...(finished ? { isNew: true } : {}),
          pieces: n + (has ? 1 : 0), bytes: (old ? old.bytes : 0) + (has ? pcm.byteLength + packed.byteLength : 0),
        });
        if (!meta || !backend.writeNow(meta, has ? n : null, has ? { pcm, frames: packed } : null)) return false;
        liveMeta.set(id, meta);
        return true;
      } catch { return false; }
    },
    async finish(id, facts = {}) {
      try {
        const { metas } = await read();
        const old = metas.find((m) => m.id === id);
        if (!old) return { ok: false, reason: 'empty', words: TAKE_WORDS.empty };
        const meta = cleanMeta({ ...old, ...facts, id, createdAt: old.createdAt, seconds: old.seconds, frameCount: old.frameCount, pieces: old.pieces, bytes: old.bytes, finished: true, isNew: true });
        await backend.setMeta(meta);
        liveMeta.delete(id);
        return { ok: true, id, bytes: meta.bytes, removed: [], words: null };
      } catch {
        return { ok: false, reason: 'storage', words: TAKE_WORDS.storage };
      }
    },
    async setNudge(id, ms) {
      try {
        const { metas } = await read();
        const meta = metas.find((m) => m.id === id);
        if (!meta || !Number.isFinite(ms)) return false;
        await backend.setMeta({ ...meta, nudgeMs: ms });
        return true;
      } catch { return false; }
    },
    async remove(id) {
      try {
        const { metas } = await read();
        if (!metas.some((m) => m.id === id)) return false;
        await backend.remove(id);
        return true;
      } catch { return false; }
    },
    async removeAll({ includingProtected = false } = {}) {
      try {
        const raws = await backend.metas();
        if (!includingProtected) {
          // "Protect" holds against "delete all" too: only the unprotected ones go.
          const go = (Array.isArray(raws) ? raws : []).filter((m) => m && typeof m.id === 'string' && m.pinned !== true);
          for (const m of go) await backend.remove(m.id);
          return go.length;
        }
        await backend.clear();
        liveMeta.clear();
        return Array.isArray(raws) ? raws.length : 0;
      } catch {
        if (!includingProtected) return 0;
        // A database too damaged to read can still be thrown away whole.
        try { if (backend.destroy) await backend.destroy(); } catch { /* nothing more to try */ }
        return 0;
      }
    },
  };
}

// ---------------------------------------------------------------- backends

export function memoryBackend() {
  const meta = new Map(), bodies = new Map();
  return {
    raw: { meta, bodies },
    async metas() { return [...meta.values()]; },
    async put(m, body) { meta.set(m.id, { ...m }); bodies.set(m.id, { pcm: body.pcm.slice(0), frames: body.frames.slice(0) }); },
    async body(id) { return bodies.get(id); },
    async setMeta(m) { meta.set(m.id, { ...m }); },
    async putPiece(m, n, body) { meta.set(m.id, { ...m }); bodies.set(`${m.id}#${n}`, { pcm: body.pcm.slice(0), frames: body.frames.slice(0) }); },
    writeNow(m, n, body) { meta.set(m.id, { ...m }); if (body) bodies.set(`${m.id}#${n}`, { pcm: body.pcm.slice(0), frames: body.frames.slice(0) }); return true; },
    async remove(id) { meta.delete(id); for (const key of [...bodies.keys()]) if (key === id || key.startsWith(`${id}#`)) bodies.delete(key); },
    async clear() { meta.clear(); bodies.clear(); },
  };
}

export function idbBackend({ name = SONG.takes.dbName, indexedDB: idb = globalThis.indexedDB } = {}) {
  let opening = null, openDb = null;
  const wait = (req) => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });
  function open() {
    if (!idb) return Promise.reject(new Error('no IndexedDB here'));
    if (!opening) {
      opening = new Promise((ok, no) => {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => {
          // The small facts and the sound apart, so listing takes never reads the sound.
          req.result.createObjectStore('meta', { keyPath: 'id' });
          req.result.createObjectStore('body', { keyPath: 'id' });
        };
        req.onsuccess = () => {
          // Another tab wants to change or delete the database: let it.
          req.result.onversionchange = () => { req.result.close(); opening = null; openDb = null; };
          openDb = req.result;
          ok(req.result);
        };
        req.onerror = () => no(req.error);
        req.onblocked = () => no(new Error('the takes database is busy in another tab'));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  }
  async function tx(mode, work) {
    const db = await open();
    return new Promise((ok, no) => {
      const t = db.transaction(['meta', 'body'], mode);
      let result;
      t.oncomplete = () => ok(result);
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error || new Error('the storage refused the change'));
      Promise.resolve(work(t.objectStore('meta'), t.objectStore('body'))).then((r) => { result = r; }, (err) => { try { t.abort(); } catch { /* done */ } no(err); });
    });
  }
  return {
    metas: () => tx('readonly', (meta) => wait(meta.getAll())),
    put: (m, body) => tx('readwrite', (meta, bodies) => { meta.put(m); bodies.put({ id: m.id, pcm: body.pcm, frames: body.frames }); }),
    body: (id) => tx('readonly', (meta, bodies) => wait(bodies.get(id))),
    setMeta: (m) => tx('readwrite', (meta) => { meta.put(m); }),
    putPiece: (m, n, body) => tx('readwrite', (meta, bodies) => { meta.put(m); bodies.put({ id: `${m.id}#${n}`, pcm: body.pcm, frames: body.frames }); }),
    // For a page that is going away: the transaction is opened and filled in THIS turn, on
    // the connection already open, and asked to commit at once. A browser finishes a
    // transaction that was started before the page went; it runs no later turn of ours.
    writeNow(m, n, body) {
      if (!openDb) return false;
      try {
        const t = openDb.transaction(['meta', 'body'], 'readwrite');
        t.objectStore('meta').put(m);
        if (body) t.objectStore('body').put({ id: `${m.id}#${n}`, pcm: body.pcm, frames: body.frames });
        if (typeof t.commit === 'function') t.commit();
        return true;
      } catch { return false; }
    },
    remove: (id) => tx('readwrite', (meta, bodies) => { meta.delete(id); bodies.delete(id); bodies.delete(IDBKeyRange.bound(`${id}#`, `${id}#\uffff`)); }),
    clear: () => tx('readwrite', (meta, bodies) => { meta.clear(); bodies.clear(); }),
    async destroy() {
      if (opening) { try { (await opening).close(); } catch { /* never opened */ } }
      opening = null;
      await wait(idb.deleteDatabase(name));
    },
  };
}
