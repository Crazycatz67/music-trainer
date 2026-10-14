// midi.js: standard MIDI file -> timeline. Pure: imports in Node, no browser globals.
//
// CONTRACT
//   parseMidi(data) -> {
//     format,            0 or 1 (format 2 throws: its tracks are separate songs)
//     ticksPerBeat,      ticks per quarter note, or null for SMPTE-timed files
//     tempos,            [ { tick, t, bpm } ] sorted by tick; always starts at tick 0
//     duration,          seconds, end of the last note in any track
//     songName,          the name written in the first track ("" when there is none)
//     tracks: [ { index, name, channels, isDrums, hasLyrics,
//                 notes: [ { t, dur, midi, velocity, channel, lyric? } ] } ]   notes sorted by t
//   }
//     data is an ArrayBuffer or any typed-array view (a Node Buffer works).
//     A format 0 file keeps every part in one track, so it is split by channel: each
//     channel becomes its own entry in `tracks` and can be picked like a format 1 track.
//     Seconds honour every tempo change, wherever in the file it is written.
//   rankMelodyTracks(parsed) -> [ { index, name, score, noteCount } ]  best first; drum and
//     empty tracks are left out.
//   pickMelodyTrack(parsed)  -> index of the most melody-like track, or -1 if none has notes.
//   midiToTimeline(dataOrParsed, opts?) -> Timeline (see js/timeline.js), source 'midi',
//     bpm = the first tempo, meta = { track, trackName, tracks: [ { index, name, noteCount } ] }
//       opts.track  index into parsed.tracks (default: pickMelodyTrack)
//       opts.mono   (default true) reduce to one note at a time for singing: of notes that
//                   start together the highest is kept, and a note is cut short when the
//                   next one starts. Pass false to keep chords (piano, later).
//       opts.title  overrides the title (default: the song name from the file, else "Untitled")
//   Throws Error('MIDI: ...') for a file that is not MIDI, is cut short, is format 2, or
//   (midiToTimeline) has no notes in the chosen track.

import { createTimeline } from './timeline.js';

const tidy = (x) => Math.round(x * 1e6) / 1e6;

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // A typed-array view may sit inside a larger buffer (Node Buffers usually do).
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('MIDI: expected an ArrayBuffer or a typed array');
}

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.pos = pos;
    this.end = end;
  }
  need(n) {
    if (this.pos + n > this.end) throw new Error('MIDI: the file is cut short');
  }
  u8() {
    this.need(1);
    return this.b[this.pos++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return this.u8() * 0x1000000 + ((this.u8() << 16) | (this.u8() << 8) | this.u8());
  }
  ascii(n) {
    this.need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.pos++]);
    return s;
  }
  // Variable-length quantity: 7 bits per byte, top bit set on all but the last.
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('MIDI: a length field is damaged');
  }
  text(n) {
    this.need(n);
    const slice = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    // TextDecoder exists in Node and browsers. Old files use Latin-1, so fall back to it
    // when the bytes are not valid UTF-8 rather than showing replacement marks.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch {
      return new TextDecoder('latin1').decode(slice);
    }
  }
}

// One MTrk chunk -> raw events in ticks.
function readTrack(r, tempoEvents) {
  let tick = 0;
  let status = 0;
  let name = '';
  const notes = []; // { tick, endTick, midi, velocity, channel }
  const lyrics = []; // { tick, text }
  const open = new Map(); // channel * 128 + pitch -> stack of notes still sounding

  const noteOff = (channel, pitch) => {
    const list = open.get(channel * 128 + pitch);
    // Oldest first: when the same pitch is struck twice before a release, the first
    // release belongs to the first strike.
    const n = list?.shift();
    if (n) n.endTick = tick;
  };

  while (r.pos < r.end) {
    tick += r.vlq();
    let b = r.u8();
    if (b === 0xff) {
      const type = r.u8();
      const len = r.vlq();
      if (type === 0x51 && len === 3) {
        tempoEvents.push({ tick, usPerBeat: (r.u8() << 16) | (r.u8() << 8) | r.u8() });
      } else if (type === 0x03) {
        const s = r.text(len);
        if (!name) name = s.trim();
      } else if (type === 0x05) {
        lyrics.push({ tick, text: r.text(len) });
      } else if (type === 0x2f) {
        r.need(len);
        r.pos += len;
        break;
      } else {
        r.need(len);
        r.pos += len;
      }
      // Meta and sysex events cancel running status.
      status = 0;
      continue;
    }
    if (b === 0xf0 || b === 0xf7) {
      const len = r.vlq();
      r.need(len);
      r.pos += len;
      status = 0;
      continue;
    }
    let d1;
    if (b & 0x80) {
      status = b;
      d1 = r.u8();
    } else {
      // Running status: this byte is already the first data byte of a repeat of the
      // previous channel message.
      if (!status) throw new Error('MIDI: a track has data with no command before it');
      d1 = b;
    }
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    if (kind === 0xc0 || kind === 0xd0) continue; // one data byte, nothing we need
    const d2 = r.u8();
    if (kind === 0x90 && d2 > 0) {
      const n = { tick, endTick: null, midi: d1, velocity: d2, channel };
      notes.push(n);
      const key = channel * 128 + d1;
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(n);
    } else if (kind === 0x80 || kind === 0x90) {
      // A note-on with velocity 0 is the usual shorthand for note-off.
      noteOff(channel, d1);
    }
  }
  // A note that is never released ends with its track.
  for (const n of notes) if (n.endTick === null) n.endTick = tick;
  return { name, notes, lyrics };
}

function tempoMap(tempoEvents, division) {
  // SMPTE timing (top bit set): ticks are a fixed fraction of a second and tempo is ignored.
  if (division & 0x8000) {
    const fpsCode = 256 - (division >> 8);
    const fps = fpsCode === 29 ? 29.97 : fpsCode;
    const perSec = fps * (division & 0xff);
    return { toSec: (tick) => tick / perSec, tempos: [{ tick: 0, t: 0, bpm: 120 }], ticksPerBeat: null };
  }
  if (!division) throw new Error('MIDI: the header has no timing resolution');
  const events = tempoEvents.slice().sort((a, b) => a.tick - b.tick);
  // 120 bpm is the standard's default until the file says otherwise.
  if (!events.length || events[0].tick > 0) events.unshift({ tick: 0, usPerBeat: 500000 });
  const segs = [];
  let t = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (i > 0) t += ((e.tick - events[i - 1].tick) * events[i - 1].usPerBeat) / division / 1e6;
    // Two tempos on the same tick: the later one wins.
    if (segs.length && segs[segs.length - 1].tick === e.tick) segs.pop();
    segs.push({ tick: e.tick, t, usPerBeat: e.usPerBeat });
  }
  const toSec = (tick) => {
    let s = segs[0];
    for (const seg of segs) {
      if (seg.tick > tick) break;
      s = seg;
    }
    return s.t + ((tick - s.tick) * s.usPerBeat) / division / 1e6;
  };
  const tempos = segs.map((s) => ({ tick: s.tick, t: tidy(s.t), bpm: tidy(60e6 / s.usPerBeat) }));
  return { toSec, tempos, ticksPerBeat: division };
}

export function parseMidi(data) {
  const bytes = toBytes(data);
  const r = new Reader(bytes);
  if (bytes.length < 14 || r.ascii(4) !== 'MThd') throw new Error('MIDI: this is not a MIDI file');
  const headerLen = r.u32();
  const format = r.u16();
  r.u16(); // track count: the chunks themselves are the truth
  const division = r.u16();
  r.need(headerLen - 6);
  r.pos += headerLen - 6;
  if (format > 1) throw new Error('MIDI: format 2 files (separate patterns) are not supported');

  const tempoEvents = [];
  const rawTracks = [];
  while (r.pos + 8 <= bytes.length) {
    const id = r.ascii(4);
    const len = r.u32();
    r.need(len);
    if (id === 'MTrk') rawTracks.push(readTrack(new Reader(bytes, r.pos, r.pos + len), tempoEvents));
    r.pos += len; // unknown chunk types are skipped, as the standard asks
  }
  if (!rawTracks.length) throw new Error('MIDI: the file has no tracks');

  const { toSec, tempos, ticksPerBeat } = tempoMap(tempoEvents, division);

  // Format 0 holds all parts in one track; split it by channel so a melody can be chosen.
  let parts = rawTracks;
  if (format === 0) {
    const src = rawTracks[0];
    const chans = [...new Set(src.notes.map((n) => n.channel))].sort((a, b) => a - b);
    if (chans.length > 1) {
      parts = chans.map((ch) => ({
        name: `${src.name || 'Track'} (channel ${ch + 1})`,
        notes: src.notes.filter((n) => n.channel === ch),
        lyrics: src.lyrics,
      }));
    }
  }

  let duration = 0;
  const tracks = parts.map((p, index) => {
    const lyricAt = new Map(p.lyrics.map((l) => [l.tick, l.text]));
    const notes = [];
    for (const n of p.notes) {
      if (n.endTick <= n.tick) continue; // zero-length notes cannot be sung or drawn
      const t = toSec(n.tick);
      const out = { t: tidy(t), dur: tidy(toSec(n.endTick) - t), midi: n.midi, velocity: n.velocity, channel: n.channel };
      // Karaoke files put each syllable on the tick of the note that carries it.
      if (lyricAt.has(n.tick)) {
        out.lyric = lyricAt.get(n.tick);
        lyricAt.delete(n.tick); // one syllable per onset, even under a chord
      }
      notes.push(out);
      duration = Math.max(duration, out.t + out.dur);
    }
    notes.sort((a, b) => a.t - b.t || a.midi - b.midi);
    const channels = [...new Set(notes.map((n) => n.channel))].sort((a, b) => a - b);
    return {
      index,
      name: p.name,
      channels,
      // Channel 10 (index 9) is percussion by General MIDI convention: its note numbers
      // are drum sounds, not pitches.
      isDrums: channels.length > 0 && channels.every((c) => c === 9),
      hasLyrics: notes.some((n) => n.lyric !== undefined),
      notes,
    };
  });

  return { format, ticksPerBeat, tempos, duration: tidy(duration), tracks, songName: rawTracks[0].name };
}

// Notes that start within this many seconds of each other count as one chord.
const CHORD_EPS = 0.03;

const MELODY_NAME = /melod|vocal|voice|vox|lead|sing|lyric|solo/i;
const BACKING_NAME = /bass|drum|perc|pad|chord|accomp|rhythm|string|guitar|piano|organ|harmon|backing/i;

export function rankMelodyTracks(parsed) {
  const out = [];
  for (const tr of parsed.tracks) {
    const n = tr.notes.length;
    if (!n || tr.isDrums) continue;
    // A melody is one note at a time: count the notes that end before the next begins.
    let solo = n === 1 ? 1 : 0;
    for (let i = 0; i + 1 < n; i++) {
      const a = tr.notes[i];
      const b = tr.notes[i + 1];
      if (b.t - a.t > CHORD_EPS && b.t >= a.t + a.dur - CHORD_EPS) solo++;
    }
    const mono = n === 1 ? 1 : solo / (n - 1);
    // C3 to C6 covers what people sing; bass lines and sparkle parts fall outside it.
    const inVoice = tr.notes.filter((x) => x.midi >= 48 && x.midi <= 84).length / n;
    const mean = tr.notes.reduce((s, x) => s + x.midi, 0) / n;
    const height = Math.min(1, Math.max(0, (mean - 48) / 36));
    // Very short tracks (a count-in, a single effect) should not win on purity alone.
    const enough = Math.min(1, n / 16);
    let score = mono + 0.5 * inVoice + 0.5 * enough + 0.2 * height;
    if (tr.hasLyrics) score += 0.5;
    if (MELODY_NAME.test(tr.name)) score += 0.5;
    else if (BACKING_NAME.test(tr.name)) score -= 0.5;
    out.push({ index: tr.index, name: tr.name, score: tidy(score), noteCount: n });
  }
  // Array.prototype.sort is stable, so equal scores keep file order.
  return out.sort((a, b) => b.score - a.score);
}

export function pickMelodyTrack(parsed) {
  const ranked = rankMelodyTracks(parsed);
  return ranked.length ? ranked[0].index : -1;
}

function skyline(notes) {
  const out = [];
  for (const n of notes) {
    const prev = out[out.length - 1];
    if (prev && n.t - prev.t <= CHORD_EPS) {
      // Same chord: the top note is the tune.
      if (n.midi > prev.midi) out[out.length - 1] = { ...n, t: prev.t, lyric: n.lyric ?? prev.lyric };
      continue;
    }
    if (prev && prev.t + prev.dur > n.t) prev.dur = tidy(n.t - prev.t);
    out.push({ ...n });
  }
  return out;
}

export function midiToTimeline(dataOrParsed, { track, mono = true, title } = {}) {
  const parsed = dataOrParsed && Array.isArray(dataOrParsed.tracks) ? dataOrParsed : parseMidi(dataOrParsed);
  const index = track ?? pickMelodyTrack(parsed);
  const tr = parsed.tracks[index];
  if (!tr || !tr.notes.length) throw new Error('MIDI: the chosen track has no notes');
  const picked = mono ? skyline(tr.notes) : tr.notes;
  const notes = picked.map((n) => {
    const out = { t: n.t, dur: n.dur, midi: n.midi };
    if (n.lyric !== undefined) out.lyric = n.lyric;
    return out;
  });
  return createTimeline({
    title: title || parsed.songName || 'Untitled',
    bpm: parsed.tempos[0].bpm,
    source: 'midi',
    notes,
    meta: {
      track: index,
      trackName: tr.name,
      tracks: parsed.tracks.map((x) => ({ index: x.index, name: x.name, noteCount: x.notes.length })),
    },
  });
}
