// tags.js — what a music file says about itself: title, artist, album and any words stored
// inside it. Read on this machine only; nothing here asks the network. Pure: imports in Node.
//
// WHY: the owner drops an mp3 and the app looks the words up by itself. The lookup needs a
// title and an artist, and a file's own tags are better than its name. Some files also carry
// their words; then nothing needs to be asked at all.
//
// READS ONLY WHAT IT NEEDS: a File is read in small slices (the tag header, then one frame at
// a time, bodies only of the frames wanted), so a 10 MB cover picture is stepped over, not
// loaded. The sound itself is never read.
//
// CONTRACT
//   readTags(source, { config? }) -> Promise<{ title, artist, album, lyrics, synced, format, version, warnings }>
//       source: File | Blob | ArrayBuffer | Uint8Array (anything with slice().arrayBuffer()).
//       title, artist, album: '' when absent; spaces tidied.
//       lyrics: plain words as stored, lines split by "\n" ('' when absent). May itself be
//               "[mm:ss.xx] line" text: words.js parseLrc reads both kinds.
//       synced: [{ t, text }] from a timed-words frame, t in seconds, in time order; [] when
//               absent or when its times are not in milliseconds.
//       format: 'id3v2' | 'id3v1' | 'mp4' | 'none';  version: e.g. '2.3', '2.4', '2.2', '1', ''.
//       warnings: short codes for what was stepped over ('tag-cut-short', 'frame-compressed',
//               'bad-frame', 'sylt-not-ms', 'tag-too-big', 'read-failed', 'name-too-long', ...).
//       title, artist, album are never longer than 200 letters (a longer one is cut).
//       NEVER throws and never rejects: a damaged file gives what could be read, else blanks.
//   readTagsFromBytes(bytes, opts?) -> the same, for bytes already in memory (still a Promise).
//
// HANDLED
//   ID3v2.2, v2.3, v2.4: TIT2 / TPE1 (else TPE2) / TALB / USLT / SYLT; text encodings 0 to 3
//     (Latin-1, UTF-16 with a byte-order mark, UTF-16BE, UTF-8); unsynchronisation over the
//     whole tag (v2.3) and per frame (v2.4); extended headers; v2.4 frames whose sizes were
//     written the v2.3 way (an old, common mistake); a v2.4 "data length" prefix.
//   ID3v1 / v1.1 at the end of the file: fills whatever v2 left blank.
//   MP4 / M4A: moov > udta > meta > ilst > ©nam, ©ART (else aART), ©alb, ©lyr.
// NOT HANDLED (said in warnings where seen): compressed or encrypted frames, SYLT timed in
//   MPEG frames, FLAC / Ogg / WAV tags, APE tags, a second ID3v2 tag after the first.

import { AUTOWORDS } from './autowords.config.js';

const T = AUTOWORDS.tags;
// A title, artist or album longer than this is not a name any more (a damaged or hostile
// tag: maxFrameBytes lets a megabyte through). It is cut, and 'name-too-long' is warned:
// the name is shown, stored, kept in the words cache and sent to the lyrics site (bugs.md 73).
const MAX_NAME_CHARS = 200;                                              // GUESS
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const blank = () => ({ title: '', artist: '', album: '', lyrics: '', synced: [], format: 'none', version: '', warnings: [] });

// ---------------------------------------------------------------- reading bytes

// One way to ask for bytes, whether they sit in memory or in a File on disk.
function readerOf(source) {
  if (source instanceof Uint8Array) return memoryReader(source);
  if (source instanceof ArrayBuffer) return memoryReader(new Uint8Array(source));
  if (source && ArrayBuffer.isView(source)) return memoryReader(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  if (source && typeof source.slice === 'function' && Number.isFinite(source.size)) {
    return {
      size: source.size,
      async read(at, length) {
        const from = Math.max(0, Math.min(source.size, at)), to = Math.max(from, Math.min(source.size, at + length));
        if (to === from) return new Uint8Array(0);
        return new Uint8Array(await source.slice(from, to).arrayBuffer());
      },
    };
  }
  return null;
}
function memoryReader(bytes) {
  return {
    size: bytes.length,
    async read(at, length) {
      const from = Math.max(0, Math.min(bytes.length, at));
      return bytes.subarray(from, Math.max(from, Math.min(bytes.length, at + length)));
    },
  };
}

const ascii = (b, at, n) => { let s = ''; for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u24 = (b, at) => (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
const safe32 = (b, at) => ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);

// ---------------------------------------------------------------- text

const DECODERS = {};
function decode(bytes, label) {
  try {
    DECODERS[label] ||= new TextDecoder(label);
    return DECODERS[label].decode(bytes);
  } catch { return ''; }
}

// The four ID3 text encodings. 1 = UTF-16 with a byte-order mark (little-endian when the
// mark is missing: that is what the writers that forget it produce).
function decodeText(bytes, enc) {
  if ((enc === 1 || enc === 2) && bytes.length % 2) bytes = bytes.subarray(0, bytes.length - 1);
  if (enc === 1) {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decode(bytes.subarray(2), 'utf-16be');
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decode(bytes.subarray(2), 'utf-16le');
    return decode(bytes, 'utf-16le');
  }
  if (enc === 2) return decode(bytes, 'utf-16be');
  if (enc === 3) return decode(bytes, 'utf-8');
  return decode(bytes, 'latin1');
}

// Where the terminated string that begins at `at` stops: [end of text, start of what follows].
function terminated(bytes, at, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = at; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return [i, i + 2];
    return [bytes.length, bytes.length];
  }
  for (let i = at; i < bytes.length; i++) if (bytes[i] === 0) return [i, i + 1];
  return [bytes.length, bytes.length];
}

// (A cut-off file can end inside a letter: the mark the decoder leaves for it is dropped.)
const lyricText = (s) => String(s ?? '').replace(/[\0\ufffd]+$/g, '').replace(/\r\n?/g, '\n').replace(/\0/g, '\n').trim();
// A text frame may hold several values split by a zero (v2.4): the first is the main one.
const firstValue = (s) => tidy(String(s ?? '').split('\0').find((v) => tidy(v)) || '');

// Unsynchronisation: every FF 00 pair stands for one FF.
function resync(bytes) {
  let n = 0;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0) { n++; i++; }
  if (!n) return bytes;
  const out = new Uint8Array(bytes.length - n);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) { out[o++] = bytes[i]; if (bytes[i] === 0xff && bytes[i + 1] === 0) i++; }
  return out;
}

// ---------------------------------------------------------------- ID3v2

const WANTED = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'band', TP2: 'band', TALB: 'album', TAL: 'album', USLT: 'uslt', ULT: 'uslt', SYLT: 'sylt', SLT: 'sylt' };
const isFrameId = (id, n) => id.length === n && /^[A-Z0-9]+$/.test(id);

function readUslt(body) {
  if (body.length < 5) return '';
  const enc = body[0], [, after] = terminated(body, 4, enc);
  return lyricText(decodeText(body.subarray(after), enc));
}

// Timed words: text, a zero, four bytes of time, again and again. Only times in milliseconds
// are read; pieces are joined into lines at the line breaks the frame itself carries.
function readSylt(body, warnings) {
  if (body.length < 7) return [];
  const enc = body[0], stampKind = body[4];
  if (stampKind !== 2) { warnings.push('sylt-not-ms'); return []; }
  let at = terminated(body, 6, enc)[1];
  const pieces = [];
  while (at < body.length && pieces.length < T.maxSyncedPieces) {
    const [end, after] = terminated(body, at, enc);
    if (after + 4 > body.length) break;
    pieces.push({ raw: decodeText(body.subarray(at, end), enc), t: u32(body, after) / 1000 });
    at = after + 4;
  }
  const breaks = pieces.some((p) => /[\r\n]/.test(p.raw));
  const lines = [];
  let open = null;
  for (const p of pieces) {
    // With no line breaks anywhere each piece is a line of its own.
    const startsNew = !breaks || !open || /^[\r\n]/.test(p.raw);
    if (startsNew) { open = { t: p.t, text: '' }; lines.push(open); }
    open.text += p.raw.replace(/[\r\n]+/g, ' ');
    if (breaks && /[\r\n]\s*$/.test(p.raw)) open = null;
  }
  return lines.map((l) => ({ t: l.t, text: tidy(l.text) })).filter((l) => l.text && Number.isFinite(l.t)).sort((a, b) => a.t - b.t);
}

async function readId3v2(reader, head, out) {
  const major = head[3], flags = head[5];
  if (major < 2 || major > 4 || head[6] & 0x80 || head[7] & 0x80 || head[8] & 0x80 || head[9] & 0x80) { out.warnings.push('bad-tag-header'); return; }
  out.format = 'id3v2'; out.version = `2.${major}`;
  let size = safe32(head, 6);
  if (10 + size > reader.size) { out.warnings.push('tag-cut-short'); size = Math.max(0, reader.size - 10); }
  const wholeUnsync = !!(flags & 0x80);
  let src = reader, at = 10, end = 10 + size;
  // v2.2 and v2.3 undo the unsynchronisation over the whole tag before any size means
  // anything, so the tag has to be in memory; v2.4 does it frame by frame.
  if (wholeUnsync && major < 4) {
    if (size > T.maxTagBytes) { out.warnings.push('tag-too-big'); return; }
    const fixed = resync(await reader.read(10, size));
    src = memoryReader(fixed); at = 0; end = fixed.length;
  }
  if (flags & 0x40 && major >= 3) {
    const x = await src.read(at, 4);
    if (x.length < 4) return;
    at += major === 3 ? 4 + u32(x, 0) : Math.max(4, safe32(x, 0));
  }
  const idLen = major === 2 ? 3 : 4, headLen = major === 2 ? 6 : 10;
  const found = { uslt: '', sylt: [] };
  for (let n = 0; n < T.maxFrames && at + headLen <= end; n++) {
    const h = await src.read(at, headLen);
    if (h.length < headLen || h[0] === 0) break;                 // padding: the frames are over
    const id = ascii(h, 0, idLen);
    if (!isFrameId(id, idLen)) { out.warnings.push('bad-frame'); break; }
    let len = major === 2 ? u24(h, 3) : major === 3 ? u32(h, 4) : safe32(h, 4);
    if (major === 4) {
      // Some writers put plain sizes in v2.4 frames. The two readings only differ from 128
      // bytes up; take the plain one when it, and not the proper one, lands on a frame.
      const plain = u32(h, 4);
      if (plain !== len && !(await landsOnFrame(src, at + 10 + len, end)) && (await landsOnFrame(src, at + 10 + plain, end))) len = plain;
    }
    const bodyAt = at + headLen;
    if (len <= 0 || bodyAt + len > end) {
      out.warnings.push(len <= 0 ? 'bad-frame' : 'tag-cut-short');
      // Half the words are still words; half a title would be searched for as another song.
      if (len <= 0 || (WANTED[id] !== 'uslt' && WANTED[id] !== 'sylt')) break;
      len = end - bodyAt;
    }
    at = bodyAt + len;
    const field = WANTED[id];
    if (!field) continue;
    if (len > T.maxFrameBytes) { out.warnings.push('frame-too-big'); continue; }
    const f2 = major >= 3 ? h[9] : 0;
    if (major === 3 ? f2 & 0xc0 : f2 & 0x0c) { out.warnings.push(major === 3 ? (f2 & 0x80 ? 'frame-compressed' : 'frame-encrypted') : (f2 & 0x08 ? 'frame-compressed' : 'frame-encrypted')); continue; }
    let body = await src.read(bodyAt, len);
    let skip = 0;
    if (major === 3 && f2 & 0x20) skip += 1;                      // a grouping byte
    if (major === 4 && f2 & 0x40) skip += 1;
    if (major === 4 && f2 & 0x01) skip += 4;                      // the "data length" prefix
    if (skip) body = body.subarray(Math.min(skip, body.length));
    if (major === 4 && (wholeUnsync || f2 & 0x02)) body = resync(body);
    if (!body.length) continue;
    if (field === 'uslt') { const text = readUslt(body); if (text.length > found.uslt.length) found.uslt = text; }
    else if (field === 'sylt') { const lines = readSylt(body, out.warnings); if (lines.length > found.sylt.length) found.sylt = lines; }
    else if (!found[field]) found[field] = firstValue(decodeText(body.subarray(1), body[0]));
  }
  out.title = found.title || ''; out.artist = found.artist || found.band || ''; out.album = found.album || '';
  out.lyrics = found.uslt; out.synced = found.sylt;
}

async function landsOnFrame(src, at, end) {
  if (at === end) return true;
  if (at + 4 > end) return false;
  const b = await src.read(at, 4);
  return b.length === 4 && (b[0] === 0 || isFrameId(ascii(b, 0, 4), 4));
}

// ---------------------------------------------------------------- ID3v1

async function readId3v1(reader, out) {
  if (reader.size < 128) return;
  const b = await reader.read(reader.size - 128, 128);
  if (b.length < 128 || ascii(b, 0, 3) !== 'TAG') return;
  const field = (at, n) => tidy(decode(b.subarray(at, at + n), 'latin1').split('\0')[0]);
  const got = { title: field(3, 30), artist: field(33, 30), album: field(63, 30) };
  let used = false;
  for (const k of ['title', 'artist', 'album']) if (!out[k] && got[k]) { out[k] = got[k]; used = true; }
  if (used && out.format === 'none') { out.format = 'id3v1'; out.version = '1'; }
}

// ---------------------------------------------------------------- MP4

// The boxes directly inside [from, to): { type, bodyAt, end }. Stops at the first box whose
// size makes no sense rather than guessing on.
async function boxes(reader, from, to, warnings) {
  const list = [];
  let at = from;
  while (at + 8 <= to && list.length < T.maxBoxes) {
    const h = await reader.read(at, 16);
    if (h.length < 8) break;
    let size = u32(h, 0), headLen = 8;
    if (size === 1) {
      if (h.length < 16) break;
      const high = u32(h, 8);
      if (high > 0x1fffff) { warnings.push('bad-box'); break; }   // past what a number holds exactly
      size = high * 2 ** 32 + u32(h, 12); headLen = 16;
    } else if (size === 0) size = to - at;                        // "to the end"
    if (size < headLen || at + size > to) { warnings.push(size < headLen ? 'bad-box' : 'box-cut-short'); break; }
    list.push({ type: decode(h.subarray(4, 8), 'latin1'), bodyAt: at + headLen, end: at + size });
    at += size;
  }
  return list;
}

const MP4_WANTED = { '©nam': 'title', '©ART': 'artist', aART: 'band', '©alb': 'album', '©lyr': 'lyrics' };

async function readMp4(reader, out) {
  out.format = 'mp4';
  const inside = async (parent, type, from = parent.bodyAt) => (await boxes(reader, from, parent.end, out.warnings)).find((b) => b.type === type);
  const moov = await inside({ bodyAt: 0, end: reader.size }, 'moov');
  if (!moov) { out.warnings.push('no-moov'); return; }
  const udta = await inside(moov, 'udta');
  const meta = udta && await inside(udta, 'meta');
  if (!meta) return;
  // "meta" normally starts with four bytes of version and flags; QuickTime's own writer
  // leaves them out. Try the normal reading first.
  const ilst = (await inside(meta, 'ilst', meta.bodyAt + 4)) || (await inside(meta, 'ilst'));
  if (!ilst) return;
  const found = {};
  for (const item of await boxes(reader, ilst.bodyAt, ilst.end, out.warnings)) {
    const field = MP4_WANTED[item.type];
    if (!field || found[field]) continue;
    const data = (await boxes(reader, item.bodyAt, item.end, out.warnings)).find((b) => b.type === 'data');
    if (!data || data.end - data.bodyAt < 8) continue;
    const len = data.end - data.bodyAt - 8;
    if (len > T.maxFrameBytes) { out.warnings.push('frame-too-big'); continue; }
    const head = await reader.read(data.bodyAt, 8), kind = u32(head, 0) & 0xffffff;
    if (kind !== 1 && kind !== 2) continue;                       // 1 = UTF-8, 2 = UTF-16BE; else not text
    const value = decode(await reader.read(data.bodyAt + 8, len), kind === 2 ? 'utf-16be' : 'utf-8');
    found[field] = field === 'lyrics' ? lyricText(value) : tidy(value);
  }
  out.title = found.title || ''; out.artist = found.artist || found.band || ''; out.album = found.album || '';
  out.lyrics = found.lyrics || '';
}

// ---------------------------------------------------------------- the one entry

export async function readTags(source, _opts = {}) {
  const out = blank();
  try {
    const reader = readerOf(source);
    if (!reader) { out.warnings.push('not-a-file'); return out; }
    const head = await reader.read(0, 12);
    if (head.length >= 10 && ascii(head, 0, 3) === 'ID3') await readId3v2(reader, head, out);
    else if (head.length >= 8 && ascii(head, 4, 4) === 'ftyp') await readMp4(reader, out);
    // The old tag at the end is only fetched when something is still missing.
    if (out.format !== 'mp4' && (!out.title || !out.artist || !out.album)) await readId3v1(reader, out);
  } catch {
    // A damaged file or a read the browser refused: keep what was read before it.
    out.warnings.push('read-failed');
  }
  for (const field of ['title', 'artist', 'album']) {
    if (out[field].length > MAX_NAME_CHARS) { out[field] = tidy(out[field].slice(0, MAX_NAME_CHARS)); if (!out.warnings.includes('name-too-long')) out.warnings.push('name-too-long'); }
  }
  return out;
}

export const readTagsFromBytes = (bytes, opts) => readTags(bytes, opts);
