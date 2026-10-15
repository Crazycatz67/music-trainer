// songstore.js — the owner's songs on this machine (engine change E5 of
// docs/design/specs/2026-10-12-song-mode.md; record shape: its section 14).
//
// Nothing here talks to a network except loadDemoSongs(), which reads the bundled
// public-domain charts from this site's own songs/demo/ folder. A dropped song lives in the
// browser's IndexedDB for this site ('music-trainer.songs.v2'): never uploaded, never in the
// repo. The rules (groups, search, sort, fit, bad data) are PURE and run in Node against
// memorySongBackend(); idbSongBackend() is the thin browser half, built as takes.js is.
//
// WHAT IS KEPT FOR A DROPPED SONG, AND HOW BIG IT IS
//   backing   everything but the singer, as separated: two channels, 16-bit, 44.1 kHz
//             (10.6 MB a minute). Raw, not compressed: the take the owner records is lined
//             up with it to the sample, and a compressed file's first sample has no exact time.
//   vocal     the separated singer, as a GUIDE to sing along with: one channel, 16-bit,
//             22.05 kHz (2.6 MB a minute). The original mix is not kept: backing + guide
//             stands in for it.
//   curve     the singer's pitch line: three 32-bit numbers a frame (about 45 kB a minute).
//   record    title, artist, length, dates, range, phrases, words, settings: a few kB.
//   Together about 13.3 MB a minute: a 4-minute song is about 53 MB. A chart with no audio
//   is a few kB.
//
// NOTHING HERE IS CLEARED BY THE APP (spec 4.5): songs, words and pitch lines go only when
// the owner removes them. Only takes have a bound and a clean-up (takes.js: unprotected,
// oldest first). When the browser itself refuses a song (disk full, storage switched off),
// addSong() answers 'storage' and nothing is changed.
//
// CONTRACT   every method is async and none throws
//   createSongStore({ backend, takes?, demo?, now? }) -> store
//       takes: a take store (takes.js). demo: async () -> [timeline] (loadDemoSongs).
//   store.addSong({ title, artist?, duration, curve, phrases, range, backing, vocal?, fileName?, analysis? })
//       -> { ok: true, id, bytes } | { ok: false, reason: 'empty' | 'too-big' | 'storage', words }
//       analysis = { version: whole number >= 1, backing?: short word } (analyse/job.js); kept
//       on the record and on every entry as `analysis`; absent (no key) when not given or not valid
//       backing = { channels: [Float32Array, ...] (1 or 2), sampleRate }
//       vocal   = { channels: [Float32Array, ...], sampleRate } at any rate; stored as above
//       phrases = [{ t, end }] (phrases.js)
//   store.addChart(timeline, { fileName? }) -> the same shape (a chart without audio)
//   store.list({ search?, sort = 'date' | 'name' | 'fit' | 'difficulty', voice? }) ->
//       { groups: { mine: [entry], demo: [entry], charts: [entry] }, bytes, dropped, unavailable? }
//       entry = { id, kind: 'file' | 'demo' | 'chart', group, title, artist, duration, addedAt,
//                 fileName, bytes, curveId, hasSinger, hasBacking, hasWords, range, fit, takes,
//                 octave, key, guide, lastSungAt, bestLines, credit, chartId, rating }
//       rating: the song's difficulty at its top level (difficulty.js), one decimal; null for a
//         song with no written tune (a recording: rated from its traced curve later, slice D5)
//       search: words that must all appear in the title or artist (case and accents ignored)
//       sort: 'date' newest first (the default); 'name' A to Z; 'fit' best for `voice` first;
//         'difficulty' easiest first, songs with no rating last
//       voice = { lowMidi, highMidi }; fit = songFit(entry, voice), null without a voice
//       dropped = unreadable records that were removed
//   store.get(id) -> the entry plus { phrases, words, timeline? } | null
//   store.audio(id) -> { backing: { channels, sampleRate } | null,
//                        vocal: { samples, sampleRate } | null } | null
//       Sound found damaged is forgotten (the entry stops promising it); the song stays.
//   store.curve(id) -> Curve (js/app/analyse/curve.js) | null
//   store.update(id, { title?, artist?, octave?, key?, guide?, lastSungAt?, bestLines?, credit?, chartId? }) -> boolean
//       octave -1 | 0 | 1, key -6..6, guide 0..3 (whole numbers; a value outside is not stored)
//   store.setWords(id, words | null) -> boolean      words: the shape in words.js. The only
//       place words are kept.
//   store.remove(id, { withTakes = true }) -> boolean
//   store.takesOf(id) -> [take meta] newest first       store.takeGroups() ->
//       [{ songId, title, takes: [meta] }] (a take whose song is gone keeps its own title)
//   store.usage() -> { songs: { bytes, count }, charts: { bytes, count },
//                      takes: { bytes, maxBytes, count, nextToGo: meta | null } | null,
//                      largest: [{ what: 'song' | 'take', id, title, bytes }], words }
//   Demo songs are not stored: they cannot be changed, removed or given words (false).
//
//   Pure: songFit(entry, voice), fitRank(fit), matches(entry, search), cleanSong(raw),
//         packCurve(curve) / unpackCurve(buffer, facts), interleave16(channels) /
//         deinterleave16(buffer, n), titleFromFile(name), titleFromTags(tags, name),
//         loadDemoSongs({ fetchText, files?, base? }) -> Promise<[timeline]>
//   backend = { metas(), put(meta, parts: { name: ArrayBuffer }), part(id, name), setMeta(meta),
//               removePart(id, name), remove(id), clear() }     all async

import { SONG } from './config.js';
import { toFloat32, toInt16 } from './pcm.js';
import { WORD_ROUTES } from './words.js';
import { fitTimeline } from '../range.js';
import { resample } from '../analyse/pitchcurve.js';
import { parseUltraStar } from '../../ultrastar.js';
import { difficultyOf } from './difficulty.js';

const L = SONG.songs;

export const SONGSTORE_WORDS = Object.freeze({
  empty: 'There was nothing in this song to keep.',
  'too-big': 'This song is too long to keep here.',
  storage: 'The song could not be saved in this browser (its storage is full or switched off).',
});

export const CLEAR_ORDER_WORDS = 'Songs, words and protected takes are never cleared by the app. '
  + 'When takes reach their limit, takes you have not protected are cleared, oldest first, and you are told before.';

// ---------------------------------------------------------------- pure

const num = (v) => (Number.isFinite(v) ? v : null);
const text = (v, fallback = '') => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : fallback);
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const whole = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "Artist - Title.mp3" -> { artist, title }; anything else: the name without its ending.
export function titleFromFile(name) {
  const base = text(String(name ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_/g, ' '));
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length === 2 && parts[0] && parts[1]) return { artist: parts[0], title: parts[1] };
  return { artist: '', title: base || 'Untitled' };
}

// The song's name from the file's own tags (tags.js readTags), in place of the file-name
// guess. null when the tags carry no title: the guess then stands. A tag with a title and
// no artist keeps the name's artist only when the name means the same song.
export function titleFromTags(tags, name = '') {
  const title = text(tags && tags.title);
  if (!title) return null;
  const guess = titleFromFile(name);
  return { title, artist: text(tags.artist) || (fold(guess.title) === fold(title) ? guess.artist : '') };
}

export function interleave16(channels) {
  const n = channels[0].length, ch = channels.length;
  const packed = channels.map(toInt16), out = new Int16Array(n * ch);
  for (let c = 0; c < ch; c++) { const src = packed[c]; for (let i = 0; i < n; i++) out[i * ch + c] = src[i]; }
  return out.buffer;
}

export function deinterleave16(buffer, ch) {
  const all = new Int16Array(buffer), n = Math.floor(all.length / ch);
  return Array.from({ length: ch }, (_, c) => {
    const one = new Int16Array(n);
    for (let i = 0; i < n; i++) one[i] = all[i * ch + c];
    return toFloat32(one);
  });
}

// Three numbers a frame: time, pitch (NaN = nothing sung there), loudness.
export function packCurve(curve) {
  const n = curve && Array.isArray(curve.t) ? curve.t.length : 0;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[3 * i] = curve.t[i];
    out[3 * i + 1] = curve.voiced[i] && Number.isFinite(curve.midi[i]) ? curve.midi[i] : NaN;
    out[3 * i + 2] = Number.isFinite(curve.level[i]) ? curve.level[i] : 0;
  }
  return out.buffer;
}

export function unpackCurve(buffer, { hop = null, engine } = {}) {
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 12) return null;
  const a = new Float32Array(buffer), n = a.length / 3;
  const curve = { t: new Array(n), midi: new Array(n), level: new Array(n), voiced: new Array(n), hop };
  for (let i = 0; i < n; i++) {
    const voiced = Number.isFinite(a[3 * i + 1]);
    curve.t[i] = a[3 * i];
    // The project rule: an unvoiced frame never gets a pitch.
    curve.midi[i] = voiced ? a[3 * i + 1] : null;
    curve.level[i] = a[3 * i + 2];
    curve.voiced[i] = voiced;
  }
  if (engine) curve.engine = engine;
  return curve;
}

function cleanRange(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.lowest) || !Number.isFinite(r.highest) || r.highest < r.lowest) return null;
  return { lowest: r.lowest, highest: r.highest, low: num(r.low) ?? r.lowest, high: num(r.high) ?? r.highest, median: num(r.median) };
}
function cleanPart(p, need) {
  if (!p || typeof p !== 'object' || !(Number.isFinite(p.bytes) && p.bytes > 0)) return null;
  for (const key of need) if (!(Number.isFinite(p[key]) && p[key] > 0)) return null;
  return { ...p };
}
// How a song's sound was made (analyse/job.js: { version, backing }), so a later analyser can
// tell which songs to offer again (needsReanalyse). The store does not judge the backing's
// name, only that it is a short word: a new kind added in separate.js needs no change here.
// Anything else is dropped, and a song without it reads as version 1 there.
function cleanAnalysis(a) {
  if (!a || typeof a !== 'object' || !(Number.isInteger(a.version) && a.version >= 1)) return null;
  const backing = text(a.backing);
  return { version: a.version, ...(backing && backing.length <= 32 ? { backing } : {}) };
}
function cleanWords(w) {
  if (!w || typeof w !== 'object' || !Array.isArray(w.lines)) return null;
  const lines = w.lines.filter((l) => l && typeof l.text === 'string').map((l) => ({ t: num(l.t), end: num(l.end), text: l.text }));
  if (!lines.length) return null;
  const out = {
    route: WORD_ROUTES.includes(w.route) ? w.route : 'typed', timing: ['word', 'line', 'none'].includes(w.timing) ? w.timing : 'none',
    lines, offsetSec: num(w.offsetSec) ?? 0, at: isDate(w.at) ? w.at : null,
  };
  if (Number.isFinite(w.autoOffsetSec)) out.autoOffsetSec = w.autoOffsetSec;
  if (typeof w.credit === 'string' && w.credit) out.credit = w.credit;
  return out;
}

export function cleanSong(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  if (raw.kind !== 'file' && raw.kind !== 'chart') return null;
  if (!isDate(raw.addedAt) || !(Number.isFinite(raw.duration) && raw.duration > 0)) return null;
  const parts = raw.parts && typeof raw.parts === 'object' ? raw.parts : {};
  const kept = {};
  const backing = cleanPart(parts.backing, ['sampleRate', 'channels']);
  const vocal = cleanPart(parts.vocal, ['sampleRate']);
  const curve = cleanPart(parts.curve, []);
  if (backing) kept.backing = backing;
  if (vocal) kept.vocal = vocal;
  if (curve) kept.curve = curve;
  const timeline = raw.kind === 'chart' && raw.timeline && Array.isArray(raw.timeline.notes) && raw.timeline.notes.length ? raw.timeline : null;
  // A song with no pitch line and a chart with no notes have nothing to sing.
  if (raw.kind === 'file' ? !curve : !timeline) return null;
  // Only an analysed song has one; the key is absent otherwise (records stay as they were).
  const analysis = raw.kind === 'file' ? cleanAnalysis(raw.analysis) : null;
  return {
    id: raw.id, kind: raw.kind,
    title: text(raw.title) || 'Untitled', artist: text(raw.artist),
    duration: raw.duration, addedAt: raw.addedAt, fileName: text(raw.fileName),
    curveId: curve ? raw.id : null, hasSinger: !!vocal,
    range: cleanRange(raw.range),
    phrases: Array.isArray(raw.phrases) ? raw.phrases.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.end) && p.end > p.t).map((p) => ({ t: p.t, end: p.end })) : [],
    words: cleanWords(raw.words),
    octave: whole(raw.octave, -1, 1) ?? 0, key: whole(raw.key, -6, 6) ?? 0, guide: whole(raw.guide, 0, 3) ?? 0,
    lastSungAt: isDate(raw.lastSungAt) ? raw.lastSungAt : null,
    bestLines: raw.bestLines && typeof raw.bestLines === 'object' ? raw.bestLines : null,
    credit: text(raw.credit), chartId: typeof raw.chartId === 'string' ? raw.chartId : null,
    parts: kept,
    ...(timeline ? { timeline } : {}),
    ...(analysis ? { analysis } : {}),
    bytes: Object.values(kept).reduce((s, p) => s + p.bytes, 0) + (timeline ? JSON.stringify(timeline).length : 0),
  };
}

// How a song sits in a voice. A recording cannot change key (until E3), so it may only be
// sung an octave up or down; a chart can move by any number of notes.
export function songFit(entry, voice) {
  if (!voice || !Number.isFinite(voice.lowMidi) || !Number.isFinite(voice.highMidi)) return null;
  if (!entry || !entry.range) return null;
  const notes = [{ t: 0, dur: 1, midi: Math.round(entry.range.lowest) }, { t: 1, dur: 1, midi: Math.round(entry.range.highest) }];
  return fitTimeline({ notes }, voice, { octavesOnly: entry.kind === 'file' });
}

// Smaller is better: fits as it is; fits after a move (the smaller the move the better);
// does not fit (the fewer notes outside the better); unknown last.
export function fitRank(fit) {
  if (!fit || fit.reason === 'no-range') return 1e6;
  if (fit.fits) return 0;
  if (fit.fitsAfter) return 100 + Math.abs(fit.shift);
  return 1000 + fit.overLow + fit.overHigh;
}

export function matches(entry, search) {
  const want = fold(search).split(/\s+/).filter(Boolean);
  if (!want.length) return true;
  const hay = fold(`${entry.title} ${entry.artist}`);
  return want.every((w) => hay.includes(w));
}

export async function loadDemoSongs({ fetchText, files = L.demoFiles, base = '../songs/demo/' } = {}) {
  const out = [];
  for (const name of files) {
    try {
      out.push({ ...parseUltraStar(await fetchText(`${base}${name}.txt`)), file: name });
    } catch { /* one unreadable chart does not empty the group */ }
  }
  return out;
}

function timelineFacts(timeline) {
  const sorted = timeline.notes.map((n) => n.midi).filter(Number.isFinite).sort((a, b) => a - b);
  const end = timeline.notes.reduce((m, n) => Math.max(m, n.t + n.dur), 0);
  return {
    duration: end,
    range: sorted.length ? { lowest: sorted[0], highest: sorted[sorted.length - 1], low: sorted[Math.floor(sorted.length * 0.1)], high: sorted[Math.floor(sorted.length * 0.9)], median: sorted[sorted.length >> 1] } : null,
  };
}

const newId = (prefix, now) => `${prefix}-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createSongStore({ backend, takes = null, demo = null, now = () => new Date() } = {}) {
  if (!backend) throw new TypeError('createSongStore: a backend is required');
  let demoList = null;

  async function read() {
    const raws = await backend.metas();
    const metas = [], bad = [];
    for (const raw of Array.isArray(raws) ? raws : []) {
      const m = cleanSong(raw);
      if (m) metas.push(m);
      else bad.push(raw && typeof raw === 'object' ? raw.id : undefined);
    }
    for (const id of bad) { try { if (id !== undefined && id !== null) await backend.remove(id); } catch { /* listed again next time */ } }
    return { metas, dropped: bad.length };
  }
  async function demos() {
    if (!demo) return [];
    if (!demoList) {
      try {
        demoList = (await demo()).map((tl) => {
          const facts = timelineFacts(tl);
          return {
            id: `demo:${tl.file || tl.title}`, kind: 'demo', title: tl.title, artist: tl.artist || '',
            duration: facts.duration, range: facts.range, addedAt: null, fileName: tl.file ? `${tl.file}.txt` : '',
            curveId: null, hasSinger: false, parts: {}, bytes: 0, phrases: [], words: null, timeline: tl,
            octave: 0, key: 0, guide: 0, lastSungAt: null, bestLines: null, chartId: null,
            credit: (tl.meta && tl.meta.headers && tl.meta.headers.CREATOR) || '',
          };
        });
      } catch { demoList = []; }
    }
    return demoList;
  }
  async function takeList() {
    if (!takes) return null;
    try { return await takes.list(); } catch { return null; }
  }
  const GROUP = { file: 'mine', demo: 'demo', chart: 'charts' };
  function entryOf(m, counts, voice) {
    const e = {
      id: m.id, kind: m.kind, group: GROUP[m.kind], title: m.title, artist: m.artist, duration: m.duration,
      addedAt: m.addedAt, fileName: m.fileName, bytes: m.bytes, curveId: m.curveId,
      hasSinger: m.hasSinger, hasBacking: !!m.parts.backing,
      hasWords: !!m.words || !!(m.timeline && m.timeline.notes.some((n) => n.lyric)),
      range: m.range, takes: counts.get(m.id) || 0,
      octave: m.octave, key: m.key, guide: m.guide, lastSungAt: m.lastSungAt, bestLines: m.bestLines,
      credit: m.credit, chartId: m.chartId, rating: ratingOf(m),
      ...(m.analysis ? { analysis: { ...m.analysis } } : {}),
    };
    e.fit = songFit(e, voice);
    return e;
  }
  // A tune never changes once stored, so each is rated once (18 demos on every list() otherwise).
  const ratings = new WeakMap();
  function ratingOf(m) {
    if (!m.timeline) return null;
    if (!ratings.has(m.timeline)) {
      let r = null;
      try { const d = difficultyOf(m.timeline); r = d ? d.rating : null; } catch { /* unrated, not unlisted */ }
      ratings.set(m.timeline, r);
    }
    return ratings.get(m.timeline);
  }
  const kept = (id) => typeof id === 'string' && !id.startsWith('demo:');
  async function find(id) {
    if (!kept(id)) return (await demos()).find((m) => m.id === id) || null;
    return (await read()).metas.find((m) => m.id === id) || null;
  }
  // The stored record of a song the owner may change, or null.
  const own = async (id) => (kept(id) ? find(id) : null);
  const no = (reason) => ({ ok: false, reason, words: SONGSTORE_WORDS[reason] });
  async function add(raw, parts) {
    const meta = cleanSong(raw);
    if (!meta) return no('empty');
    try {
      await backend.put(meta, parts);
      return { ok: true, id: meta.id, bytes: meta.bytes };
    } catch {
      return no('storage');
    }
  }

  return {
    async addSong({ title, artist = '', duration, curve, phrases = [], range = null, backing = null, vocal = null, fileName = '', analysis = null } = {}) {
      const packed = curve ? packCurve(curve) : new ArrayBuffer(0);
      if (!packed.byteLength || !(duration > 0)) return no('empty');
      const parts = { curve: packed }, facts = { curve: { bytes: packed.byteLength, hop: num(curve.hop), engine: text(curve.engine) } };
      try {
        if (backing && backing.channels && backing.channels.length && backing.channels[0].length) {
          const two = backing.channels.slice(0, 2);
          parts.backing = interleave16(two);
          facts.backing = { bytes: parts.backing.byteLength, sampleRate: backing.sampleRate, channels: two.length };
        }
        if (vocal && vocal.channels && vocal.channels.length && vocal.channels[0].length) {
          // One channel at half the rate: a guide to sing with, not the record itself.
          const [a, b] = vocal.channels;
          const mono = b && b !== a ? Float32Array.from(a, (v, i) => (v + b[i]) / 2) : a;
          const rate = Math.min(L.vocalRate, vocal.sampleRate);
          parts.vocal = toInt16(rate === vocal.sampleRate ? mono : resample(mono, vocal.sampleRate, rate)).buffer;
          facts.vocal = { bytes: parts.vocal.byteLength, sampleRate: rate };
        }
      } catch {
        // The sound was too big to repack in memory: say so rather than keep half a song.
        return no('too-big');
      }
      return add({ id: newId('song', now), kind: 'file', title, artist, duration, addedAt: now().toISOString(), fileName, range, phrases, analysis, parts: facts }, parts);
    },
    async addChart(timeline, { fileName = '' } = {}) {
      if (!timeline || !Array.isArray(timeline.notes) || !timeline.notes.length) return no('empty');
      const facts = timelineFacts(timeline);
      return add({ id: newId('chart', now), kind: 'chart', title: timeline.title, artist: timeline.artist, duration: facts.duration, addedAt: now().toISOString(), fileName, range: facts.range, timeline, parts: {} }, {});
    },
    async list({ search = '', sort = 'date', voice = null } = {}) {
      const groups = { mine: [], demo: [], charts: [] };
      let dropped = 0, unavailable = false, metas = [];
      try { ({ metas, dropped } = await read()); } catch { unavailable = true; }
      const tk = await takeList(), counts = new Map();
      for (const t of tk ? tk.takes : []) counts.set(t.songId, (counts.get(t.songId) || 0) + 1);
      for (const m of [...metas, ...(await demos())]) {
        const e = entryOf(m, counts, voice);
        if (matches(e, search)) groups[e.group].push(e);
      }
      const byName = (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.artist.localeCompare(b.artist, 'en', { sensitivity: 'base' });
      const order = sort === 'name' ? byName
        : sort === 'fit' ? (a, b) => fitRank(a.fit) - fitRank(b.fit) || byName(a, b)
        : sort === 'difficulty' ? (a, b) => (a.rating ?? Infinity) - (b.rating ?? Infinity) || byName(a, b)
          // Newest first; demo songs have no date and keep their alphabetical order.
          : (a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0) || byName(a, b);
      for (const g of Object.values(groups)) g.sort(order);
      const out = { groups, bytes: metas.reduce((s, m) => s + m.bytes, 0), dropped };
      if (unavailable) out.unavailable = true;
      return out;
    },
    async get(id) {
      try {
        const m = await find(id);
        if (!m) return null;
        const tk = await takeList();
        const counts = new Map([[m.id, tk ? tk.takes.filter((t) => t.songId === m.id).length : 0]]);
        return { ...entryOf(m, counts, null), phrases: m.phrases, words: m.words, ...(m.timeline ? { timeline: m.timeline } : {}) };
      } catch { return null; }
    },
    async audio(id) {
      try {
        const m = await own(id);
        if (!m) return null;
        const out = { backing: null, vocal: null }, lost = [];
        if (m.parts.backing) {
          const buf = await backend.part(id, 'backing'), ch = m.parts.backing.channels;
          if (buf instanceof ArrayBuffer && buf.byteLength > 0 && buf.byteLength % (2 * ch) === 0) out.backing = { channels: deinterleave16(buf, ch), sampleRate: m.parts.backing.sampleRate };
          else lost.push('backing');
        }
        if (m.parts.vocal) {
          const buf = await backend.part(id, 'vocal');
          if (buf instanceof ArrayBuffer && buf.byteLength > 0 && buf.byteLength % 2 === 0) out.vocal = { samples: toFloat32(new Int16Array(buf)), sampleRate: m.parts.vocal.sampleRate };
          else lost.push('vocal');
        }
        if (lost.length) {
          const parts = { ...m.parts };
          for (const p of lost) { delete parts[p]; await backend.removePart(id, p); }
          await backend.setMeta({ ...m, parts });
        }
        return out;
      } catch { return null; }
    },
    async curve(id) {
      try {
        const m = await own(id);
        if (!m || !m.parts.curve) return null;
        return unpackCurve(await backend.part(id, 'curve'), m.parts.curve);
      } catch { return null; }
    },
    async update(id, patch = {}) {
      try {
        const m = await own(id);
        if (!m) return false;
        const next = { ...m };
        if (patch.title !== undefined) next.title = text(patch.title) || m.title;
        if (patch.artist !== undefined) next.artist = text(patch.artist);
        if (patch.octave !== undefined) next.octave = whole(patch.octave, -1, 1) ?? m.octave;
        if (patch.key !== undefined) next.key = whole(patch.key, -6, 6) ?? m.key;
        if (patch.guide !== undefined) next.guide = whole(patch.guide, 0, 3) ?? m.guide;
        for (const k of ['lastSungAt', 'bestLines', 'credit', 'chartId']) if (patch[k] !== undefined) next[k] = patch[k];
        await backend.setMeta(next);
        return true;
      } catch { return false; }
    },
    async setWords(id, words) {
      try {
        const m = await own(id);
        if (!m) return false;
        await backend.setMeta({ ...m, words: words ? cleanWords(words) : null });
        return true;
      } catch { return false; }
    },
    async remove(id, { withTakes = true } = {}) {
      try {
        const m = await own(id);
        if (!m) return false;
        await backend.remove(id);
        if (withTakes && takes) for (const t of (await takes.list()).takes) if (t.songId === id) await takes.remove(t.id);
        return true;
      } catch { return false; }
    },
    async takesOf(id) {
      const tk = await takeList();
      return tk ? tk.takes.filter((t) => t.songId === id) : [];
    },
    async takeGroups() {
      const tk = await takeList();
      if (!tk || !tk.takes.length) return [];
      let metas = [];
      try { ({ metas } = await read()); } catch { /* titles then come from the takes */ }
      const titles = new Map([...metas, ...(await demos())].map((m) => [m.id, m.title]));
      const groups = new Map();
      for (const t of tk.takes) {
        if (!groups.has(t.songId)) groups.set(t.songId, { songId: t.songId, title: titles.get(t.songId) || t.title || 'A song no longer here', takes: [] });
        groups.get(t.songId).takes.push(t);
      }
      return [...groups.values()];
    },
    async usage() {
      let metas = [];
      try { ({ metas } = await read()); } catch { /* shown as empty */ }
      const tk = await takeList();
      const sum = (kind) => { const of = metas.filter((m) => m.kind === kind); return { bytes: of.reduce((s, m) => s + m.bytes, 0), count: of.length }; };
      const next = tk ? [...tk.takes].filter((t) => !t.pinned).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] || null : null;
      const largest = [
        ...metas.map((m) => ({ what: 'song', id: m.id, title: m.title, bytes: m.bytes })),
        ...(tk ? tk.takes.map((t) => ({ what: 'take', id: t.id, title: t.title, bytes: t.bytes })) : []),
      ].sort((a, b) => b.bytes - a.bytes);
      return {
        songs: sum('file'), charts: sum('chart'),
        takes: tk ? { bytes: tk.bytes, maxBytes: tk.maxBytes, count: tk.takes.length, nextToGo: next } : null,
        largest, words: CLEAR_ORDER_WORDS,
      };
    },
  };
}

// ---------------------------------------------------------------- backends

export function memorySongBackend() {
  const meta = new Map(), parts = new Map();
  return {
    raw: { meta, parts },
    async metas() { return [...meta.values()].map((m) => structuredClone(m)); },
    async put(m, p) { meta.set(m.id, structuredClone(m)); for (const [name, buf] of Object.entries(p)) parts.set(`${m.id}/${name}`, buf.slice(0)); },
    async part(id, name) { return parts.get(`${id}/${name}`); },
    async setMeta(m) { meta.set(m.id, structuredClone(m)); },
    async removePart(id, name) { parts.delete(`${id}/${name}`); },
    async remove(id) { meta.delete(id); for (const key of [...parts.keys()]) if (key.startsWith(`${id}/`)) parts.delete(key); },
    async clear() { meta.clear(); parts.clear(); },
  };
}

export function idbSongBackend({ name = L.dbName, indexedDB: idb = globalThis.indexedDB } = {}) {
  let opening = null;
  const wait = (req) => new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });
  function open() {
    if (!idb) return Promise.reject(new Error('no IndexedDB here'));
    if (!opening) {
      opening = new Promise((ok, fail) => {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => {
          // The facts and the sound apart, so listing the songs never reads the sound.
          req.result.createObjectStore('meta', { keyPath: 'id' });
          req.result.createObjectStore('parts');        // key: "<song id>/<part name>"
        };
        req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = null; }; ok(req.result); };
        req.onerror = () => fail(req.error);
        req.onblocked = () => fail(new Error('the song database is busy in another tab'));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  }
  async function tx(mode, work) {
    const db = await open();
    return new Promise((ok, fail) => {
      const t = db.transaction(['meta', 'parts'], mode);
      let result;
      t.oncomplete = () => ok(result);
      t.onerror = () => fail(t.error);
      t.onabort = () => fail(t.error || new Error('the storage refused the change'));
      Promise.resolve(work(t.objectStore('meta'), t.objectStore('parts'))).then((r) => { result = r; }, (err) => { try { t.abort(); } catch { /* done */ } fail(err); });
    });
  }
  const span = (id) => IDBKeyRange.bound(`${id}/`, `${id}/￿`);
  return {
    metas: () => tx('readonly', (meta) => wait(meta.getAll())),
    put: (m, p) => tx('readwrite', (meta, parts) => { meta.put(m); for (const [part, buf] of Object.entries(p)) parts.put(buf, `${m.id}/${part}`); }),
    part: (id, part) => tx('readonly', (meta, parts) => wait(parts.get(`${id}/${part}`))),
    setMeta: (m) => tx('readwrite', (meta) => { meta.put(m); }),
    removePart: (id, part) => tx('readwrite', (meta, parts) => { parts.delete(`${id}/${part}`); }),
    remove: (id) => tx('readwrite', (meta, parts) => { meta.delete(id); parts.delete(span(id)); }),
    clear: () => tx('readwrite', (meta, parts) => { meta.clear(); parts.clear(); }),
    async destroy() {
      if (opening) { try { (await opening).close(); } catch { /* never opened */ } }
      opening = null;
      await wait(idb.deleteDatabase(name));
    },
  };
}
