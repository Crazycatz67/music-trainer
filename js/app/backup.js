// backup.js — "Backup and restore": everything the singer has built up, as one file.
//
// Why: all of it lives in ONE browser (localStorage and two IndexedDB databases). Clearing
// that browser's data, or moving to another Mac, would lose the practice record, the range,
// the constellations and the recordings. A backup is a file the singer keeps; restoring reads
// it back. Nothing here talks to a network, and nothing is executed from a file: a backup is
// read as data, checked field by field, and refused with a plain reason when anything is off.
//
// PURE where it can be: imports in Node (tools/checks/backup.check.mjs) and reaches storage
// only through what it is given.
//
// WHAT GOES IN
//   progress   every localStorage key that starts with 'music-trainer.' (found by prefix, so a
//              key added later, such as the Voice check's portraits, is carried with no change
//              here). A few kB to a few hundred kB. Always the default.
//   takes      the singer's own recordings (16-bit sound + pitch frames, about 5.8 MB a
//              minute). An option: they cannot be made again, but they are big.
//   songs      analysed songs with their sound (about 13.3 MB a minute). Left out by default:
//              the sound can be made again by dropping the file on the app again. NOT made
//              again: words typed for a song, which live in the song's record.
//
// THE FILE
//   Progress only: plain JSON, '.json', readable in any text editor.
//   With takes or songs: '.mtbackup' = the 10 bytes 'MTBACKUP1\n', a 4-byte little-endian
//   header length, the same JSON as the header, then the sound, end to end. Each piece of
//   sound is named in the header by { at, bytes, check }.
//   JSON = { app: 'music-trainer', kind: 'backup', v: 1, madeAt (ISO), check, body }
//   body = { include: { progress, takes, songs }, keys: { name: text }, takes: [...], songs: [...] }
//   check = a checksum of body (and one for each piece of sound). It catches a damaged or
//   hand-edited file. It is NOT a lock: anyone can work out a new one. So content is never
//   trusted either: key names must carry the prefix, records go through takes.js cleanMeta
//   and songstore.js cleanSong, and each screen still cleans what it reads, as it always did.
//
// CONTRACT   (async ones never throw for bad data or a failing storage: they answer ok false)
//   sizes({ storage, takes?, songs? }) -> { progress: { count, bytes }, takes: { count, bytes } | null,
//                                           songs: { count, bytes } | null }      nothing is loaded
//   snapshot({ storage, takes?, songs? }) -> current = { keys: { name: text }, takes: [meta] | null,
//                                           songs: [meta] | null, takesMax }      what is here now
//   collect({ storage, takes?, songs?, include?, now? }) -> backup
//       include = { progress = true, takes = false, songs = false }
//       takes: a take STORE (takes.js createTakeStore): list / load / save / remove / wouldRemove.
//       songs: a song BACKEND (songstore.js idbSongBackend): metas / part / put / remove. The
//              backend, not the store, because the store gives a new id to whatever it adds and
//              a take finds its song by id.
//       backup = { app, kind, v, madeAt, include, keys, takes: [{ meta, parts }], songs: [{ meta, parts }],
//                  skipped: [words] }      parts = { name: { bytes, check, data: ArrayBuffer | Blob } }
//   toFile(backup) -> { blob, name: 'music-trainer-backup-YYYY-MM-DD.json' | '.mtbackup', bytes }
//   fromFile(blob, { limits? }) -> { ok: true, backup } | { ok: false, reason, words }
//       reason: 'empty' | 'too-big' | 'not-backup' | 'damaged' | 'newer' | 'changed' | 'unknown'
//       Reads the header only; the sound stays in the file until restore() asks for it.
//   validate(backup, { limits? }) -> { ok: true } | { ok: false, reason, words }     pure
//   plan(backup, current, { mergers?, config? }) -> { ok, reason?, words?,
//         merge:   { add, update, leave, lines: [words], blocked: null },
//         replace: { add, update, leave, remove, lines: [words], blocked: null | words },
//         items: [{ what: 'key' | 'take' | 'song', id, label, merge, replace, text? }] }     pure
//       add = not here yet; update = here but changed by the restore; leave = untouched;
//       remove (replace only) = here, not in the backup, so it goes.
//   restore(backup, { storage, takes?, songs?, mode: 'merge' | 'replace', mergers?, config? }) ->
//       { ok: true, mode, keys: { add, update, leave, remove }, takes: {...} | null, songs: {...} | null, words, safety }
//     | { ok: false, reason, words, rolledBack: boolean, safety? }
//       reason: any of fromFile's, or 'storage' (no storage, full, blocked) | 'no-room' | 'busy'
//       merge   never deletes. Per key: sessions joined by id (and their takes by time), the
//               Voice check's portraits joined by date, the WIDER range kept, a finished
//               constellation kept over an unfinished one, the larger Match and hold counts,
//               the longer Long note best with its days joined, the newer own-voice record.
//               Any other key that is already here (settings, setup, a key this version does
//               not know) keeps THIS Mac's copy. A take or song already here is left alone.
//       replace all or nothing: what is here becomes what is in the backup. The old keys are
//               copied to memory first (`safety`, always handed back) and put back if a write
//               fails. Takes and songs: the backup's are written FIRST, and only when every
//               write worked are the ones not in the backup removed; a failure takes the new
//               ones out again. A kind the backup does not hold (takes, songs) is left as it is.
//       Nothing is written unless validate() passed and every piece of sound to be written
//       matched its checksum. mode other than the two throws RangeError (a caller's mistake).
//   sizeWords(bytes) -> '12 kB' | '5.8 MB'
//   mergers: { [key name]: (hereText, thereText, config) -> { text, said } } to add or replace a rule.

import { CONFIG } from './config.js';
import { STORAGE_PREFIX } from './shell.js';
import { readStore, writeStore, SESSIONS_KEY } from './sessions.js';
import { RANGE_KEY, readRangeRecord } from './range.js';
import { SAVED_KEY } from './figures.js';
import { LONGNOTE_KEY, readRecord as readLongNote } from './longnote.js';
import { OWNVOICE_KEY, readOwnVoice } from './ownvoicekey.js';
import { cleanMeta, packFrames, unpackFrames } from './song/takes.js';
import { cleanSong } from './song/songstore.js';
import { toFloat32, toInt16 } from './song/pcm.js';

export const BACKUP_VERSION = 1;
const APP = 'music-trainer', KIND = 'backup', MAGIC = 'MTBACKUP1\n';
const SONG_PARTS = ['backing', 'vocal', 'curve'], TAKE_PARTS = ['pcm', 'frames'];

// What a file may hold before it is refused unread. localStorage itself holds about 5 MB,
// so a header far past that is not one of ours.
export const LIMITS = Object.freeze({
  fileBytes: 4 * 1024 ** 3,
  headerBytes: 24 * 1024 * 1024,
  keys: 400, keyNameChars: 120, keyChars: 6 * 1024 * 1024,
  takes: 2000, songs: 2000,
});

export const BACKUP_WORDS = Object.freeze({
  empty: 'That file is empty.',
  'too-big': 'That file is too big to be a backup from this app.',
  'not-backup': 'That is not a backup made by this app.',
  damaged: 'The backup file is damaged: part of it is missing or cannot be read.',
  newer: 'This backup was made by a newer version of the app. Update the app, then try again.',
  changed: 'The file was changed after it was saved, so it cannot be trusted.',
  unknown: 'The file holds something this version of the app does not know.',
  storage: 'This browser would not save it (its storage is full or switched off).',
  'no-room': 'There is not enough room for the recordings in the backup next to the ones here.',
  busy: 'Something else changed the saved data at the same moment. Try again.',
  songsNote: 'Songs are left out unless you ask: a song can be made again by dropping its file on the app. Words you typed for a song are kept with the song, so include songs to keep those.',
});

const KEY_LABELS = Object.freeze({
  'sessions.v1': 'Practice record', 'range.v1': 'Your range', 'constellations.v1': 'Constellations',
  'matchhold.v1': 'Match and hold', 'settings.v1': 'Settings', 'setup.v1': 'Setup',
  'takes.v1': 'Free sing takes', 'voicecheck.v1': 'Voice check portraits',
  'longnote.v1': 'Long note bests', 'ownvoice.v1': 'Your voice (note sound)',
});
const labelOf = (key) => KEY_LABELS[key.slice(STORAGE_PREFIX.length)] || `Other saved data (${key.slice(STORAGE_PREFIX.length)})`;

const no = (reason, extra = '') => ({ ok: false, reason, words: BACKUP_WORDS[reason] + (extra ? ` ${extra}` : '') });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const utf8 = (text) => new TextEncoder().encode(text);

export function sizeWords(bytes) {
  if (!(bytes >= 1024)) return `${Math.max(0, Math.round(bytes || 0))} bytes`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} kB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// FNV-1a, 32 bits: small, the same in Node and the browser, and needs no secure context
// (crypto.subtle is missing on a plain http address that is not localhost).
function fnvBytes(buffer) {
  const a = new Uint8Array(buffer);
  let hash = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) hash = Math.imul(hash ^ a[i], 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
const fnvText = (text) => fnvBytes(utf8(text).buffer);
const dataOf = async (part) => (part.data instanceof ArrayBuffer ? part.data : part.data.arrayBuffer());

// ---------------------------------------------------------------- what is here now

function readKeys(storage) {
  const out = {};
  if (!storage) return out;
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i);
    if (typeof name !== 'string' || !name.startsWith(STORAGE_PREFIX)) continue;
    const text = storage.getItem(name);
    if (typeof text === 'string') out[name] = text;
  }
  return out;
}

async function songMetas(songs) {
  if (!songs) return null;
  try { return (await songs.metas()).map(cleanSong).filter(Boolean); } catch { return null; }
}
async function takeMetas(takes) {
  if (!takes) return null;
  try { const l = await takes.list(); return l.unavailable ? null : l.takes; } catch { return null; }
}

export async function snapshot({ storage = null, takes = null, songs = null } = {}) {
  let keys = {};
  try { keys = readKeys(storage); } catch { keys = {}; }
  return { keys, takes: await takeMetas(takes), songs: await songMetas(songs), takesMax: takes ? takes.maxBytes ?? null : null };
}

export async function sizes(where = {}) {
  const now = await snapshot(where);
  const sum = (list) => (list ? { count: list.length, bytes: list.reduce((s, m) => s + m.bytes, 0) } : null);
  const names = Object.keys(now.keys);
  return {
    progress: { count: names.length, bytes: names.reduce((s, k) => s + utf8(k).length + utf8(now.keys[k]).length, 0) },
    takes: sum(now.takes), songs: sum(now.songs),
  };
}

// ---------------------------------------------------------------- collect

export async function collect({ storage = null, takes = null, songs = null, include = {}, now = () => new Date() } = {}) {
  const want = { progress: include.progress !== false, takes: include.takes === true && !!takes, songs: include.songs === true && !!songs };
  const backup = {
    app: APP, kind: KIND, v: BACKUP_VERSION, madeAt: now().toISOString(), include: want,
    keys: {}, takes: [], songs: [], skipped: [],
  };
  if (want.progress) { try { backup.keys = readKeys(storage); } catch { backup.skipped.push('The saved progress could not be read.'); } }
  const part = (buffer) => ({ bytes: buffer.byteLength, check: fnvBytes(buffer), data: buffer });
  if (want.takes) {
    for (const meta of (await takeMetas(takes)) || []) {
      // load() joins a take written in pieces, so the copy is whole whatever its history.
      const take = await takes.load(meta.id).catch(() => null);
      if (!take || !take.samples || !take.samples.length) { backup.skipped.push(`A recording (${meta.title || meta.id}) could not be read and is not in the backup.`); continue; }
      const pcm = toInt16(take.samples).buffer, frames = packFrames(take.frames);
      const clean = cleanMeta({ ...meta, finished: true, pieces: 0, seconds: take.samples.length / meta.sampleRate, frameCount: frames.byteLength / 12, bytes: pcm.byteLength + frames.byteLength });
      if (clean) backup.takes.push({ meta: clean, parts: { pcm: part(pcm), frames: part(frames) } });
    }
  }
  if (want.songs) {
    for (const meta of (await songMetas(songs)) || []) {
      const parts = {};
      let whole = true;
      for (const name of Object.keys(meta.parts)) {
        const buffer = await songs.part(meta.id, name).catch(() => null);
        if (buffer instanceof ArrayBuffer && buffer.byteLength === meta.parts[name].bytes) parts[name] = part(buffer);
        else whole = false;
      }
      if (whole) backup.songs.push({ meta, parts });
      else backup.skipped.push(`A song (${meta.title}) has damaged sound and is not in the backup.`);
    }
  }
  return backup;
}

// ---------------------------------------------------------------- the file

// The body as it is written: sound is named by place and size, never held in the JSON.
function bodyOf(backup) {
  let at = 0;
  const listed = (items) => items.map(({ meta, parts }) => {
    const out = {};
    for (const [name, p] of Object.entries(parts)) { out[name] = { at, bytes: p.bytes, check: p.check }; at += p.bytes; }
    return { meta, parts: out };
  });
  const keys = {};
  for (const name of Object.keys(backup.keys).sort()) keys[name] = backup.keys[name];
  return { body: { include: { ...backup.include }, keys, takes: listed(backup.takes), songs: listed(backup.songs) }, soundBytes: at };
}

export function toFile(backup) {
  const { body, soundBytes } = bodyOf(backup);
  const header = { app: APP, kind: KIND, v: backup.v, madeAt: backup.madeAt, check: fnvText(JSON.stringify(body)), body };
  const day = isDate(backup.madeAt) ? backup.madeAt.slice(0, 10) : 'undated';
  if (!soundBytes) {
    // Indented: a progress-only backup is small, and the singer can open it and read it.
    const blob = new Blob([JSON.stringify(header, null, 1)], { type: 'application/json' });
    return { blob, name: `${APP}-backup-${day}.json`, bytes: blob.size };
  }
  const text = utf8(JSON.stringify(header)), length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, text.length, true);
  const sound = [...backup.takes, ...backup.songs].flatMap(({ parts }) => Object.values(parts).map((p) => p.data));
  const blob = new Blob([MAGIC, length, text, ...sound], { type: 'application/octet-stream' });
  return { blob, name: `${APP}-backup-${day}.mtbackup`, bytes: blob.size };
}

const TOP = ['app', 'kind', 'v', 'madeAt', 'check', 'body'], BODY = ['include', 'keys', 'takes', 'songs'];
const onlyKnown = (obj, known) => Object.keys(obj).find((k) => !known.includes(k)) ?? null;

function checkItems(list, max, clean, names, what) {
  if (!Array.isArray(list) || list.length > max) return no('damaged');
  const seen = new Set();
  for (const item of list) {
    if (!isObj(item) || !isObj(item.parts) || onlyKnown(item, ['meta', 'parts'])) return no('damaged');
    const meta = clean(item.meta);
    if (!meta || seen.has(meta.id)) return no('damaged', `(a ${what} in it is not readable)`);
    seen.add(meta.id);
    const stray = onlyKnown(item.parts, names);
    if (stray) return no('unknown', `(${stray})`);
    let bytes = 0;
    for (const p of Object.values(item.parts)) {
      if (!isObj(p) || !(Number.isSafeInteger(p.bytes) && p.bytes >= 0) || typeof p.check !== 'string') return no('damaged');
      bytes += p.bytes;
    }
    if (what === 'recording') {
      const { pcm, frames } = item.parts;
      // The sizes the take store itself insists on: whole 16-bit samples, whole frames.
      if (!pcm || !frames || !pcm.bytes || pcm.bytes % 2 || frames.bytes % 12 || bytes !== meta.bytes) return no('damaged', '(a recording in it has the wrong size)');
    } else {
      const promised = Object.keys(meta.parts);
      if (promised.length !== Object.keys(item.parts).length || promised.some((n) => !item.parts[n] || item.parts[n].bytes !== meta.parts[n].bytes)) return no('damaged', '(a song in it has the wrong size)');
    }
  }
  return { ok: true };
}

// The shape and sizes of a backup held in memory (made by collect() or read by fromFile()).
export function validate(backup, { limits = LIMITS } = {}) {
  if (!isObj(backup) || backup.app !== APP || backup.kind !== KIND) return no('not-backup');
  if (!Number.isInteger(backup.v) || backup.v < 1) return no('not-backup');
  if (backup.v > BACKUP_VERSION) return no('newer');
  if (!isDate(backup.madeAt)) return no('damaged');
  const inc = backup.include;
  if (!isObj(inc) || onlyKnown(inc, ['progress', 'takes', 'songs']) || Object.values(inc).some((v) => typeof v !== 'boolean')) return no('damaged');
  if (!isObj(backup.keys)) return no('damaged');
  const names = Object.keys(backup.keys);
  if (names.length > limits.keys) return no('too-big');
  let chars = 0;
  for (const name of names) {
    // The prefix is the fence: a file can never plant or overwrite a key that is not the app's.
    if (!name.startsWith(STORAGE_PREFIX) || name.length <= STORAGE_PREFIX.length || name.length > limits.keyNameChars) return no('unknown', `(a saved item called “${name.slice(0, 40)}”)`);
    if (typeof backup.keys[name] !== 'string') return no('damaged');
    chars += backup.keys[name].length;
  }
  if (chars > limits.keyChars) return no('too-big');
  const takes = checkItems(backup.takes, limits.takes, cleanMeta, TAKE_PARTS, 'recording');
  if (!takes.ok) return takes;
  return checkItems(backup.songs, limits.songs, cleanSong, SONG_PARTS, 'song');
}

export async function fromFile(blob, { limits = LIMITS } = {}) {
  try {
    if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') return no('not-backup');
    if (blob.size === 0) return no('empty');
    if (blob.size > limits.fileBytes) return no('too-big');
    const head = new Uint8Array(await blob.slice(0, MAGIC.length + 4).arrayBuffer());
    const packed = MAGIC.split('').every((c, i) => head[i] === c.charCodeAt(0));
    let text = '', soundAt = 0;
    if (packed) {
      if (head.length < MAGIC.length + 4) return no('damaged');
      const length = new DataView(head.buffer).getUint32(MAGIC.length, true);
      if (length > limits.headerBytes) return no('too-big');
      soundAt = MAGIC.length + 4 + length;
      if (soundAt > blob.size) return no('damaged');
      text = await blob.slice(MAGIC.length + 4, soundAt).text();
    } else {
      if (blob.size > limits.headerBytes) return no('too-big');
      text = await blob.text();
    }
    let raw = null;
    // JSON.parse only: a file is data, and nothing in it is ever run.
    try { raw = JSON.parse(text); } catch {
      // Ours but cut short (a download that stopped) reads differently from somebody else's file.
      return no(packed || /^\s*\{\s*"app"\s*:\s*"music-trainer"/.test(text) ? 'damaged' : 'not-backup');
    }
    if (!isObj(raw) || raw.app !== APP || raw.kind !== KIND) return no('not-backup');
    if (!Number.isInteger(raw.v) || raw.v < 1) return no('not-backup');
    // Before anything else: a newer file may rightly hold things this version would call unknown.
    if (raw.v > BACKUP_VERSION) return no('newer');
    const strayTop = onlyKnown(raw, TOP);
    if (strayTop) return no('unknown', `(${strayTop.slice(0, 40)})`);
    if (!isObj(raw.body) || typeof raw.check !== 'string') return no('damaged');
    const strayBody = onlyKnown(raw.body, BODY);
    if (strayBody) return no('unknown', `(${strayBody.slice(0, 40)})`);
    if (fnvText(JSON.stringify(raw.body)) !== raw.check) return no('changed');
    const b = raw.body;
    const backup = { app: APP, kind: KIND, v: raw.v, madeAt: raw.madeAt, include: b.include, keys: b.keys, takes: b.takes, songs: b.songs, skipped: [] };
    const fine = validate(backup, { limits });
    if (!fine.ok) return fine;
    // Every piece of sound must sit inside the file, end to end, with nothing over.
    let at = 0;
    const lazy = (items, clean) => items.map((item) => {
      const parts = {};
      for (const [name, p] of Object.entries(item.parts)) {
        if (p.at !== at) throw new RangeError('sound out of place');
        parts[name] = { bytes: p.bytes, check: p.check, data: blob.slice(soundAt + at, soundAt + at + p.bytes) };
        at += p.bytes;
      }
      return { meta: clean(item.meta), parts };
    });
    try { backup.takes = lazy(b.takes, cleanMeta); backup.songs = lazy(b.songs, cleanSong); } catch { return no('damaged'); }
    if ((packed ? blob.size - soundAt : 0) !== at) return no('damaged');
    backup.keys = { ...b.keys };
    backup.include = { progress: b.include.progress === true, takes: b.include.takes === true, songs: b.include.songs === true };
    return { ok: true, backup };
  } catch {
    return no('damaged');
  }
}

// ---------------------------------------------------------------- merge rules, one per key

const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const one = (key, text) => ({ getItem: (k) => (k === key ? text : null) });
// Two dated lists as one, oldest first; an entry with the same date is the same entry, and
// this Mac's copy of it is the one kept.
function joinByDate(here, there, dateOf = (e) => e && e.at) {
  const seen = new Map();
  for (const e of [...there, ...here]) { const d = dateOf(e); if (isDate(d)) seen.set(d, e); }
  const out = [...seen.values()].sort((a, b) => Date.parse(dateOf(a)) - Date.parse(dateOf(b)));
  return { list: out, added: out.length - here.filter((e) => isDate(dateOf(e))).length };
}
const kept = (text) => ({ text, said: 'the copy here is kept' });

const MERGERS = Object.freeze({
  [SESSIONS_KEY](hereText, thereText, config) {
    const here = readStore(one(SESSIONS_KEY, hereText), config), there = readStore(one(SESSIONS_KEY, thereText), config);
    if (!there.ok) return kept(hereText);
    const byId = new Map(here.sessions.map((s) => [s.id, s]));
    let added = 0, grown = 0;
    for (const s of there.sessions) {
      const mine = byId.get(s.id);
      if (!mine) { byId.set(s.id, s); added++; continue; }
      const takes = joinByDate(mine.takes, s.takes, (t) => t && `${t.at}`).list;
      if (takes.length > mine.takes.length) { byId.set(s.id, { ...mine, takes: takes.slice(-config.sessions.maxTakesPerSession) }); grown++; }
    }
    const sessions = [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const days = [...new Set([...here.days, ...there.days])].sort();
    if (!added && !grown && days.length === here.days.length && here.ok) return kept(hereText);
    let text = hereText;
    // sessions.js writes it, so its own sizes hold (the oldest sessions go first past them).
    writeStore({ setItem: (k, v) => { text = v; } }, { days, sessions }, config);
    const said = [added && `${plural(added, 'session')} added`, grown && `${plural(grown, 'session')} joined`, days.length > here.days.length && `${plural(days.length - here.days.length, 'day')} added to the streak record`].filter(Boolean).join(', ');
    return { text, said: said || 'the copy here is kept' };
  },
  [RANGE_KEY](hereText, thereText, config) {
    const here = readRangeRecord(one(RANGE_KEY, hereText)), there = readRangeRecord(one(RANGE_KEY, thereText));
    if (!there) return kept(hereText);
    if (!here) return { text: thereText, said: 'the range in the backup is used' };
    const width = (r) => r.highMidi - r.lowMidi;
    // The wider range wins; the same width keeps this Mac's (it is at least as new to the singer).
    const wider = width(there.current) > width(here.current);
    const history = joinByDate(here.history, there.history);
    if (!wider && !history.added) return kept(hereText);
    const record = { current: wider ? there.current : here.current, history: history.list.slice(-config.range.historyMax) };
    return { text: JSON.stringify(record), said: wider ? 'the wider range from the backup is used' : `the range here is kept (it is as wide or wider), ${plural(history.added, 'earlier measurement')} added` };
  },
  [SAVED_KEY](hereText, thereText) {
    const here = parse(hereText), there = parse(thereText);
    if (!isObj(there)) return kept(hereText);
    if (!isObj(here)) return { text: thereText, said: 'the constellations in the backup are used' };
    const score = (r) => (isObj(r) ? (isDate(r.completedAt) ? 1000 : 0) + (Array.isArray(r.stars) ? r.stars.filter((s) => typeof s === 'string').length : 0) : -1);
    const out = { ...here };
    let better = 0, added = 0;
    for (const [id, r] of Object.entries(there)) {
      if (!isObj(r)) continue;
      if (!Object.hasOwn(here, id)) { out[id] = r; added++; continue; }
      const mine = here[id], times = Math.max(Number(mine && mine.timesSung) || 0, Number(r.timesSung) || 0);
      // A figure once whole stays whole: finished beats unfinished, then more stars lit.
      if (score(r) > score(mine)) { out[id] = { ...r, timesSung: times }; better++; }
      else if (isObj(mine) && times > (Number(mine.timesSung) || 0)) { out[id] = { ...mine, timesSung: times }; better++; }
    }
    if (!better && !added) return kept(hereText);
    return { text: JSON.stringify(out), said: [added && `${plural(added, 'figure')} added`, better && `${plural(better, 'figure')} further along in the backup`].filter(Boolean).join(', ') };
  },
  [`${STORAGE_PREFIX}matchhold.v1`](hereText, thereText) {
    const here = parse(hereText), there = parse(thereText);
    if (!isObj(there)) return kept(hereText);
    if (!isObj(here)) return { text: thereText, said: 'the counts in the backup are used' };
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const out = { ...here, rounds: Math.max(n(here.rounds), n(there.rounds)), bestHeld: Math.max(n(here.bestHeld), n(there.bestHeld)) };
    const last = [here.lastAt, there.lastAt].filter(isDate).sort((a, b) => Date.parse(a) - Date.parse(b)).pop();
    if (last) out.lastAt = last;
    if (out.rounds === n(here.rounds) && out.bestHeld === n(here.bestHeld) && out.lastAt === here.lastAt) return kept(hereText);
    return { text: JSON.stringify(out), said: 'the larger counts are kept' };
  },
  // The Voice check (js/app/voicecheck.js): { v: 1, checks: [Portrait] }, each dated by `at`.
  [`${STORAGE_PREFIX}voicecheck.v1`](hereText, thereText) {
    const here = parse(hereText), there = parse(thereText);
    if (!isObj(there) || !Array.isArray(there.checks)) return kept(hereText);
    if (!isObj(here) || !Array.isArray(here.checks)) return { text: thereText, said: 'the portraits in the backup are used' };
    const joined = joinByDate(here.checks, there.checks);
    if (!joined.added) return kept(hereText);
    return { text: JSON.stringify({ ...here, checks: joined.list }), said: `${plural(joined.added, 'portrait')} added` };
  },
  // Long note (js/app/longnote.js): { v: 1, best, days: [{ day, sec, holds }] }. The longer
  // best wins (the same length keeps this Mac's); the days are joined, and a day on both
  // sides keeps its longer note and its larger count (the two may be the same holds, so
  // they are not added up).
  [LONGNOTE_KEY](hereText, thereText, config) {
    const cfg = (config && config.longNote) || CONFIG.longNote;
    const there = readLongNote(one(LONGNOTE_KEY, thereText), cfg);
    if (!there.best && !there.days.length) return kept(hereText);
    const here = readLongNote(one(LONGNOTE_KEY, hereText), cfg);
    if (!here.best && !here.days.length) return { text: thereText, said: 'the long notes in the backup are used' };
    const byDay = new Map(here.days.map((d) => [d.day, d]));
    let added = 0, longer = 0;
    for (const d of there.days) {
      const mine = byDay.get(d.day);
      if (!mine) { byDay.set(d.day, d); added++; continue; }
      if (d.sec > mine.sec || d.holds > mine.holds) {
        if (d.sec > mine.sec) longer++;
        byDay.set(d.day, { day: d.day, sec: Math.max(d.sec, mine.sec), holds: Math.max(d.holds, mine.holds) });
      }
    }
    const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-cfg.keepDays);
    const betterBest = !!there.best && (!here.best || there.best.sec > here.best.sec);
    const out = { v: 1, best: betterBest ? there.best : here.best, days };
    if (JSON.stringify(out) === JSON.stringify(here)) return kept(hereText);
    const said = [betterBest && 'the longer best from the backup is used', added && `${plural(added, 'day')} added`, longer && `${plural(longer, 'day')} with a longer note in the backup`].filter(Boolean).join(', ');
    return { text: JSON.stringify(out), said: said || 'the days are joined' };
  },
  // The own-voice note sound (js/app/ownvoicekey.js): one record, dated by `at`. The newer
  // teaching wins (a voice changes; the latest is the one the singer chose); the same date or
  // an undated backup keeps this Mac's.
  [OWNVOICE_KEY](hereText, thereText) {
    const there = readOwnVoice(one(OWNVOICE_KEY, thereText));
    if (!there) return kept(hereText);
    const here = readOwnVoice(one(OWNVOICE_KEY, hereText));
    if (!here) return { text: thereText, said: 'the voice in the backup is used' };
    const t = (r) => (isDate(r.at) ? Date.parse(r.at) : -Infinity);
    if (t(there) > t(here)) return { text: thereText, said: 'the newer voice from the backup is used' };
    return { text: hereText, said: 'the voice here is kept (it is as new or newer)' };
  },
  [`${STORAGE_PREFIX}takes.v1`](hereText, thereText) {
    const here = parse(hereText), there = parse(thereText);
    if (!Array.isArray(there)) return kept(hereText);
    if (!Array.isArray(here)) return { text: thereText, said: 'the takes in the backup are used' };
    const joined = joinByDate(here, there);
    if (!joined.added) return kept(hereText);
    return { text: JSON.stringify(joined.list.slice(-CONFIG.freesing.maxSavedTakes)), said: `${plural(joined.added, 'take')} added` };
  },
});

// ---------------------------------------------------------------- plan

const sameTake = (a, b) => a.createdAt === b.createdAt && a.bytes === b.bytes;
const sameSong = (a, b) => a.addedAt === b.addedAt && a.bytes === b.bytes;

function planItems(what, inBackup, here, same) {
  const mine = new Map(here.map((m) => [m.id, m]));
  const items = inBackup.map(({ meta }) => {
    const old = mine.get(meta.id);
    const label = meta.title || (what === 'take' ? 'A recording' : 'A song');
    if (!old) return { what, id: meta.id, label, bytes: meta.bytes, merge: 'add', replace: 'add' };
    // The same id and not the same thing: merge keeps this Mac's, replace takes the backup's.
    return { what, id: meta.id, label, bytes: meta.bytes, merge: 'leave', replace: same(old, meta) ? 'leave' : 'update' };
  });
  const ids = new Set(inBackup.map((t) => t.meta.id));
  for (const m of here) if (!ids.has(m.id)) items.push({ what, id: m.id, label: m.title || '', bytes: m.bytes, merge: 'leave', replace: 'remove', onlyHere: true });
  return items;
}

export function plan(backup, current, { mergers = {}, config = CONFIG } = {}) {
  const fine = validate(backup);
  if (!fine.ok) return fine;
  const rules = { ...MERGERS, ...mergers };
  const here = (current && current.keys) || {};
  const items = [];
  const count = () => ({ add: 0, update: 0, leave: 0, remove: 0, lines: [], blocked: null });
  const merge = count(), replace = count();
  const date = new Date(backup.madeAt).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (backup.include.progress) {
    for (const name of [...new Set([...Object.keys(backup.keys), ...Object.keys(here)])].sort()) {
      const label = labelOf(name), there = backup.keys[name], mine = here[name];
      if (there === undefined) {
        items.push({ what: 'key', id: name, label, merge: 'leave', replace: 'remove' });
        replace.lines.push(`${label}: removed (it is not in the backup).`);
        continue;
      }
      if (mine === undefined) {
        items.push({ what: 'key', id: name, label, merge: 'add', replace: 'add', text: there });
        merge.lines.push(`${label}: added from the backup.`);
        replace.lines.push(`${label}: added from the backup.`);
        continue;
      }
      if (mine === there) { items.push({ what: 'key', id: name, label, merge: 'leave', replace: 'leave' }); continue; }
      let out = kept(mine);
      // A rule that throws on odd data must not stop a restore: this Mac's copy stands.
      try { if (rules[name]) out = rules[name](mine, there, config); } catch { out = kept(mine); }
      const changed = typeof out.text === 'string' && out.text !== mine;
      items.push({ what: 'key', id: name, label, merge: changed ? 'update' : 'leave', replace: 'update', text: changed ? out.text : undefined });
      merge.lines.push(`${label}: ${out.said}.`);
      replace.lines.push(`${label}: replaced with the backup’s copy.`);
    }
  } else {
    const line = 'Progress and settings are not in this backup; what is here stays.';
    merge.lines.push(line); replace.lines.push(line);
  }

  const sound = (what, word, words, included, inBackup, hereList, same) => {
    if (!included) {
      if (hereList && hereList.length) { const line = `Your ${words} are not in this backup; the ${plural(hereList.length, word)} here ${hereList.length === 1 ? 'stays' : 'stay'}.`; merge.lines.push(line); replace.lines.push(line); }
      return [];
    }
    if (!hereList) {
      const line = `The backup holds ${plural(inBackup.length, word)}, but ${words} cannot be restored from this page.`;
      merge.lines.push(line); replace.lines.push(line);
      return [];
    }
    return planItems(what, inBackup, hereList, same);
  };
  const takeItems = sound('take', 'recording', 'recordings', backup.include.takes, backup.takes, current && current.takes, sameTake);
  const songItems = sound('song', 'song', 'songs', backup.include.songs, backup.songs, current && current.songs, sameSong);

  // Takes share one bound (takes.js maxBytes). Restoring never pushes out a take that is here.
  if (takeItems.length) {
    const max = current.takesMax ?? Infinity;
    let used = current.takes.reduce((s, m) => s + m.bytes, 0);
    const swap = takeItems.filter((i) => i.replace === 'add' || i.replace === 'update').reduce((s, i) => s + i.bytes, 0);
    // Replace writes the new ones BEFORE the old ones go, so both must fit for a moment.
    if (used + swap > max) replace.blocked = `${BACKUP_WORDS['no-room']} Replace needs ${sizeWords(used + swap)} for a moment and there is ${sizeWords(max)}. Remove some recordings first, or use Merge.`;
    let left = 0;
    for (const i of takeItems) {
      if (i.merge !== 'add') continue;
      if (used + i.bytes > max) { i.merge = 'leave'; i.noRoom = true; left++; } else used += i.bytes;
    }
    if (left) merge.lines.push(`${plural(left, 'recording')} in the backup will be left out: there is no room next to the ones here.`);
  }
  for (const [list, word] of [[takeItems, 'recording'], [songItems, 'song']]) {
    if (!list.length) continue;
    const n = (mode, kind) => list.filter((i) => i[mode] === kind).length;
    const bytes = (mode, kind) => sizeWords(list.filter((i) => i[mode] === kind).reduce((s, i) => s + i.bytes, 0));
    if (n('merge', 'add')) merge.lines.push(`${plural(n('merge', 'add'), word)} added (${bytes('merge', 'add')}).`);
    const stay = list.filter((i) => i.merge === 'leave' && !i.noRoom && !i.onlyHere).length;
    if (stay) merge.lines.push(`${plural(stay, word)} already here: left as ${stay === 1 ? 'it is' : 'they are'}.`);
    if (n('replace', 'add')) replace.lines.push(`${plural(n('replace', 'add'), word)} added (${bytes('replace', 'add')}).`);
    if (n('replace', 'update')) replace.lines.push(`${plural(n('replace', 'update'), word)} replaced with the backup’s copy.`);
    if (n('replace', 'remove')) replace.lines.push(`${plural(n('replace', 'remove'), word)} here removed (not in the backup, ${bytes('replace', 'remove')}).`);
    items.push(...list);
  }

  for (const i of items) { merge[i.merge]++; replace[i.replace]++; }
  if (!merge.add && !merge.update) merge.lines.unshift('Nothing would change: everything in the backup is already here, or is no newer.');
  if (!replace.add && !replace.update && !replace.remove) replace.lines.unshift('Nothing would change: what is here is the same as the backup.');
  return { ok: true, madeAt: backup.madeAt, madeWords: `Saved on ${date}.`, merge, replace, items };
}

// ---------------------------------------------------------------- restore

// What is here becomes `old` again. true when it did.
function putBack(storage, old) {
  try {
    for (const name of Object.keys(readKeys(storage))) if (!Object.hasOwn(old, name)) storage.removeItem(name);
    for (const [name, text] of Object.entries(old)) if (storage.getItem(name) !== text) storage.setItem(name, text);
    return true;
  } catch { return false; }
}

export async function restore(backup, { storage = null, takes = null, songs = null, mode, mergers = {}, config = CONFIG } = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new RangeError(`restore: mode must be 'merge' or 'replace', not ${mode}`);
  const fine = validate(backup);
  if (!fine.ok) return { ...fine, rolledBack: true };
  if (backup.include.progress && !storage) return { ...no('storage'), rolledBack: true };
  let current = null, p = null;
  try {
    current = await snapshot({ storage, takes, songs });
    p = plan(backup, current, { mergers, config });
  } catch { return { ...no('storage'), rolledBack: true }; }
  if (!p.ok) return { ...p, rolledBack: true };
  if (mode === 'replace' && p.replace.blocked) return { ok: false, reason: 'no-room', words: p.replace.blocked, rolledBack: true };
  const todo = (what, kinds) => p.items.filter((i) => i.what === what && kinds.includes(i[mode]));
  const safety = { ...backup, madeAt: new Date().toISOString(), include: { progress: true, takes: false, songs: false }, keys: { ...current.keys }, takes: [], songs: [], skipped: [] };

  // 1. Read and check every piece of sound that will be written, before anything is.
  const inBackup = { take: new Map(backup.takes.map((t) => [t.meta.id, t])), song: new Map(backup.songs.map((s) => [s.meta.id, s])) };
  const sound = new Map();
  try {
    for (const i of [...todo('take', ['add', 'update']), ...todo('song', ['add', 'update'])]) {
      const parts = {};
      for (const [name, part] of Object.entries(inBackup[i.what].get(i.id).parts)) {
        const buffer = await dataOf(part);
        if (buffer.byteLength !== part.bytes || fnvBytes(buffer) !== part.check) return { ...no('damaged', '(some of the sound in it does not match what was saved)'), rolledBack: true, safety };
        parts[name] = buffer;
      }
      sound.set(`${i.what}:${i.id}`, parts);
    }
  } catch { return { ...no('damaged'), rolledBack: true, safety }; }

  // 2. Sound first (it is the part that can run out of room), remembering how to undo it.
  const undo = [];
  const back = async () => { let ok = true; for (const fn of undo.reverse()) { try { await fn(); } catch { ok = false; } } return ok; };
  try {
    for (const i of todo('take', ['add', 'update'])) {
      const { meta } = inBackup.take.get(i.id), parts = sound.get(`take:${i.id}`);
      const room = await takes.wouldRemove(meta.bytes - (i[mode] === 'update' ? current.takes.find((m) => m.id === i.id).bytes : 0));
      if (!room.fits || room.remove.length) throw new Error('no-room');
      if (i[mode] === 'update') { const old = await takes.load(i.id); if (old) undo.push(() => takes.save(old, { title: old.title })); }
      const saved = await takes.save({ ...meta, samples: toFloat32(new Int16Array(parts.pcm)), frames: unpackFrames(parts.frames) }, { title: meta.title });
      if (!saved.ok) throw new Error(saved.reason);
      if (i[mode] === 'add') undo.push(() => takes.remove(i.id));
    }
    for (const i of todo('song', ['add', 'update'])) {
      const { meta } = inBackup.song.get(i.id);
      if (i[mode] === 'update') {
        const old = current.songs.find((m) => m.id === i.id), oldParts = {};
        for (const name of Object.keys(old.parts)) { const b = await songs.part(i.id, name); if (b instanceof ArrayBuffer) oldParts[name] = b; }
        undo.push(async () => { await songs.remove(i.id); await songs.put(old, oldParts); });
      } else undo.push(() => songs.remove(i.id));
      await songs.put(meta, sound.get(`song:${i.id}`));
    }
  } catch (err) {
    const rolledBack = await back();
    return { ...no(err && err.message === 'no-room' ? 'no-room' : 'storage'), rolledBack, safety };
  }

  // 3. The keys, with the old ones in hand.
  const keyItems = p.items.filter((i) => i.what === 'key');
  try {
    // Something else (another tab) wrote in between: what was planned is no longer what would happen.
    const now = readKeys(storage);
    if (backup.include.progress && (Object.keys(now).length !== Object.keys(current.keys).length || Object.keys(now).some((k) => now[k] !== current.keys[k]))) {
      const rolledBack = await back();
      return { ...no('busy'), rolledBack, safety };
    }
    if (mode === 'replace') for (const i of keyItems) if (i.replace === 'remove') storage.removeItem(i.id);
    for (const i of keyItems) {
      if (mode === 'replace' ? i.replace === 'add' || i.replace === 'update' : i.merge === 'add' || i.merge === 'update') storage.setItem(i.id, mode === 'replace' ? backup.keys[i.id] : i.text);
    }
  } catch {
    const keysBack = putBack(storage, current.keys), soundBack = await back();
    return { ...no('storage'), rolledBack: keysBack && soundBack, safety };
  }

  // 4. Replace only, and only now that everything new is in: what the backup does not hold goes.
  let stuck = 0;
  if (mode === 'replace') {
    for (const i of todo('take', ['remove'])) { try { if (!(await takes.remove(i.id))) stuck++; } catch { stuck++; } }
    for (const i of todo('song', ['remove'])) { try { await songs.remove(i.id); } catch { stuck++; } }
  }
  const tally = (what) => { const c = { add: 0, update: 0, leave: 0, remove: 0 }; for (const i of p.items) if (i.what === what) c[i[mode]]++; return c; };
  const said = (c, word) => [c.add && `${plural(c.add, word)} added`, c.update && `${plural(c.update, word)} updated`, c.remove && `${plural(c.remove, word)} removed`].filter(Boolean);
  const keys = tally('key'), t = current.takes && backup.include.takes ? tally('take') : null, s = current.songs && backup.include.songs ? tally('song') : null;
  const parts = [...said(keys, 'saved item'), ...(t ? said(t, 'recording') : []), ...(s ? said(s, 'song') : [])];
  const words = (parts.length ? `Restored: ${parts.join(', ')}.` : 'Nothing needed to change: it was all here already.')
    + (stuck ? ` ${plural(stuck, 'old item')} could not be removed and ${stuck === 1 ? 'is' : 'are'} still here.` : '');
  return { ok: true, mode, keys, takes: t, songs: s, words, safety };
}
