// ultrastar.js: UltraStar `.txt` song chart -> timeline. Pure: imports in Node.
// Format reference: https://usdx.eu/format/
//
// CONTRACT
//   parseUltraStar(text, opts?) -> Timeline (see js/timeline.js), with
//     title, artist?      from #TITLE / #ARTIST ("Untitled" when the title is missing)
//     bpm                 the file's #BPM number as written (see "Timing" below)
//     source              'ultrastar'
//     notes[]             the sung notes only (`:` normal and `*` golden), sorted by t:
//                           { t, dur, midi, lyric, line, golden? }
//                           lyric  the syllable exactly as written; a leading or trailing
//                                  space marks a word boundary, "~" continues a syllable
//                           line   0-based lyric line (phrase) the note belongs to
//                           golden true on `*` notes only
//     meta                { gapMs, lines, youtubeId?, video?, audio?, headers, unpitched[], warnings[] }
//                           youtubeId  11-character id found in #VIDEO / #VIDEOURL, when present
//                           headers    every header, upper-case tag -> raw string value
//                           unpitched  freestyle and rap notes { t, dur, lyric, line, kind }
//                                      (kind: 'freestyle' | 'rap' | 'rapgolden'); kept out of
//                                      `notes` because their pitch is not meant to be matched,
//                                      but screens still need their words
//                           warnings   plain-words notes about lines that were skipped
//   opts.player (default 1): which singer to keep in a duet file (P1 / P2 markers).
//   Throws Error('UltraStar: ...') when the text has no usable #BPM or no sung notes.
//   youtubeIdFrom(value) -> string | null   is exported for the import screen.
//
// Timing: one UltraStar beat lasts 60 / (BPM x 4) seconds, and #GAP is the time in
// milliseconds from the start of the audio to beat 0. Pitch 0 is C4 (MIDI 60).

import { createTimeline } from './timeline.js';

const KINDS = { ':': 'normal', '*': 'golden', F: 'freestyle', R: 'rap', G: 'rapgolden' };

// Many charts are written with a decimal comma ("#BPM:272,5").
function toNumber(raw) {
  const x = Number(String(raw).trim().replace(',', '.'));
  return Number.isFinite(x) ? x : NaN;
}

export function youtubeIdFrom(value) {
  if (typeof value !== 'string') return null;
  // Covers the usdb.animux convention ("v=ID,co=..." or "a=ID") and pasted links
  // (watch?v=ID, youtu.be/ID, /embed/ID). A plain file name such as "song.mp4" gives null.
  const m =
    value.match(/(?:^|[?&,\s])[va]=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/) ||
    value.match(/(?:youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return m ? m[1] : null;
}

const tidy = (x) => Math.round(x * 1e6) / 1e6;

export function parseUltraStar(text, { player = 1 } = {}) {
  if (typeof text !== 'string') throw new TypeError('UltraStar: expected the file contents as a string');
  const headers = {};
  const warnings = [];
  const raw = []; // { kind, beat, len, pitch, lyric, line }
  let line = 0;
  let lineHasNotes = false;
  let relOffset = 0; // only moves in #RELATIVE:YES files
  let currentPlayer = null; // null until a P marker is seen: solo files keep everything
  let ended = false;

  // Only the line ending is stripped: leading and trailing spaces inside a note's text
  // are word boundaries and must survive.
  const rows = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  for (let i = 0; i < rows.length && !ended; i++) {
    const row = rows[i];
    if (row.trim() === '') continue;
    const head = row.trimStart();
    const c = head[0];

    if (c === '#') {
      const colon = head.indexOf(':');
      if (colon < 0) {
        warnings.push(`line ${i + 1}: header without a colon, skipped`);
        continue;
      }
      headers[head.slice(1, colon).trim().toUpperCase()] = head.slice(colon + 1).trim();
      continue;
    }

    if (c === 'E') {
      ended = true;
      continue;
    }

    if (c === 'P') {
      const m = head.match(/^P\s*(\d)/);
      if (m) {
        currentPlayer = Number(m[1]);
        // Each singer's part starts its own beat count and its own lines.
        relOffset = 0;
        continue;
      }
    }

    if (c === '-') {
      const m = head.match(/^-\s*(-?\d+)(?:\s+(-?\d+))?/);
      if (!m) {
        warnings.push(`line ${i + 1}: line break without a beat, skipped`);
        continue;
      }
      if (/^(yes|true)$/i.test(headers.RELATIVE ?? '')) relOffset += Number(m[2] ?? m[1]);
      if (lineHasNotes) line++;
      lineHasNotes = false;
      continue;
    }

    if (c in KINDS) {
      // After the pitch comes exactly one separator space; everything after it is the text.
      const m = head.match(/^[:*FRG]\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s(.*))?$/);
      if (!m) {
        warnings.push(`line ${i + 1}: could not read note "${head.slice(0, 30)}", skipped`);
        continue;
      }
      // Duet marker 3 means "both singers".
      if (currentPlayer !== null && currentPlayer !== player && currentPlayer !== 3) continue;
      const len = Number(m[2]);
      if (len < 1) {
        warnings.push(`line ${i + 1}: note with no length, skipped`);
        continue;
      }
      raw.push({ kind: KINDS[c], beat: Number(m[1]) + relOffset, len, pitch: Number(m[3]), lyric: m[4] ?? '', line });
      lineHasNotes = true;
      continue;
    }

    warnings.push(`line ${i + 1}: not a header, note or line break, skipped`);
  }

  const bpm = toNumber(headers.BPM);
  if (!(bpm > 0)) throw new Error('UltraStar: the file has no usable #BPM line');
  let gapMs = headers.GAP === undefined ? 0 : toNumber(headers.GAP);
  if (!Number.isFinite(gapMs)) {
    warnings.push('#GAP is not a number; using 0');
    gapMs = 0;
  }
  const beatSec = 60 / (bpm * 4);
  const gapSec = gapMs / 1000;

  const notes = [];
  const unpitched = [];
  for (const r of raw) {
    const t = tidy(gapSec + r.beat * beatSec);
    const dur = tidy(r.len * beatSec);
    if (t < 0) {
      warnings.push(`note at beat ${r.beat} starts before the audio, skipped`);
      continue;
    }
    if (r.kind === 'normal' || r.kind === 'golden') {
      const n = { t, dur, midi: 60 + r.pitch, lyric: r.lyric, line: r.line };
      if (r.kind === 'golden') n.golden = true;
      notes.push(n);
    } else {
      unpitched.push({ t, dur, lyric: r.lyric, line: r.line, kind: r.kind });
    }
  }
  if (!notes.length) throw new Error('UltraStar: the file has no sung notes');
  unpitched.sort((a, b) => a.t - b.t);

  const video = headers.VIDEO || undefined;
  const audio = headers.AUDIO || headers.MP3 || undefined;
  const youtubeId = youtubeIdFrom(headers.VIDEO) ?? youtubeIdFrom(headers.VIDEOURL) ?? youtubeIdFrom(headers.AUDIOURL);

  const meta = { gapMs, lines: lineHasNotes ? line + 1 : line, headers, unpitched, warnings };
  if (youtubeId) meta.youtubeId = youtubeId;
  if (video) meta.video = video;
  if (audio) meta.audio = audio;

  return createTimeline({
    title: headers.TITLE || 'Untitled',
    artist: headers.ARTIST || undefined,
    bpm,
    source: 'ultrastar',
    notes,
    meta,
  });
}
