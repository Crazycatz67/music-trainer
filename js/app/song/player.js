// player.js — plays a song's backing track (and, for playback, the singer's take beside it)
// on the Web Audio clock, and says exactly where in the song it is.
//
// The clock maths is PURE (createClock, imports in Node); createPlayer is the browser half.
// The file the owner chose is decoded in this browser and never leaves it: nothing here
// makes a network request.
//
// TIME: "song time" is seconds from the start of the backing track. Two song times matter:
//   player.time()       what is being handed to the sound card now (the scheduled position)
//   player.heardTime()  what is reaching the ears now = time() - the output delay the browser
//                       reports. A chart that follows the music should follow this one.
//
// CONTRACT — pure
//   createClock({ duration }) -> clock          every method takes the audio context's time
//     clock.play(ctxTime)                       from the current position
//     clock.pause(ctxTime)
//     clock.seek(songSec, ctxTime)              clamped to 0..duration
//     clock.setLoop({ start, end } | null, ctxTime)   keeps the current position; a position
//                                               at or past the loop's end goes to its start
//     clock.positionAt(ctxTime) -> song seconds
//     clock.segmentAt(ctxTime) -> { ctxStart, songStart, ctxEnd } | null
//         the unbroken stretch that contains ctxTime: song = songStart + (ctx - ctxStart)
//         until ctxEnd (the next loop wrap, or the end of the track). null while not playing.
//     clock.playing, clock.loop, clock.duration
//   fitLoop(loop, duration, minSec) -> { start, end } | null    orders, clamps, null if too short
//
// CONTRACT — createPlayer({ audioContext, destination?, config?, pauseWhenHidden = true }) -> player
//   player.load(source, { id? }) -> Promise<{ id, duration, sampleRate, channels }>
//       source: a File or Blob the owner chose, an ArrayBuffer, an AudioBuffer, or
//       { channels: [Float32Array, ...], sampleRate } (the lab's synthesised backing).
//       Replaces the song and removes every layer. Rejects with an Error named 'DecodeError'
//       (message is plain words) when the file is not sound the browser can read; the song
//       that was loaded before stays.
//   player.play() -> boolean        must come from a press (it makes sound). false if nothing
//                                   is loaded. At the end of the track it starts from 0.
//   player.pause(reason = 'pause')
//   player.seek(songSec)            while playing: carries on from there
//   player.setLoop(startSec, endSec) / player.clearLoop()
//   player.setVolume(0..1)          the whole output
//   player.setBackingGain(0..1)     the backing alone (the Music slider and the mixer's balance)
//       Every gain (these two and a layer's) eases in a straight line over
//       config.player.gainEaseSec while the song plays and is set at once while it does not.
//       0 IS ZERO: once the ease is over that sound's samples are exactly 0, not quiet.
//   player.taps() -> { backing: GainNode, layers: { name: GainNode } }   each sound after its
//       own gain and before the volume. For meters and tests (connect an AnalyserNode to
//       one); never change or disconnect them.
//   player.setLayer(name, { samples, sampleRate, at, gain = 1 })
//       a second sound on the song's timeline (the take): mono samples whose first sample
//       belongs at song time `at` (may be negative: the head is cut). Replaces a layer of the
//       same name; while playing it carries on in step. Throws if no song is loaded.
//   player.setLayerGain(name, 0..1) / player.removeLayer(name)
//   player.levels() -> { volume, backing, layers: { name: gain } }   the gains the audio
//       graph holds at this moment (they ease to a new value over config.player.gainEaseSec).
//       For tests. Read it while playing: a gain Chrome is not pulling sound through keeps
//       reporting its old value until sound flows again (measured in labs/singnow-lab).
//   player.time() / player.heardTime() / player.timeAt(ctxTime) -> song seconds
//   player.segmentAt(ctxTime)       as clock.segmentAt
//   player.latency() -> { output, base }   seconds, null when the browser does not say
//   player.backing() -> { id, channels: [Float32Array, ...], sampleRate, duration } | null
//   player.state() -> { status, position, duration, loop, volume, backingGain, layers, id }
//       status: 'empty' | 'ready' | 'playing' | 'paused' | 'ended'
//   player.on(type, fn) -> off      'play' { ctxTime, song } · 'pause' { song, reason } ·
//       'seek' { song } · 'loop' { loop } · 'ended' {} · 'load' {} · 'state' (state())
//   player.destroy()                stops, disconnects; closes nothing it did not create
//   player.ctx, player.output       the context and the node everything plays through
//
// Looping uses the buffer source's own loop points, so the wrap is on the exact sample and
// the backing and the take can never drift apart: both are buffers of the song's full length
// started with the same time and offset.
//
// Hidden or left: the player pauses (reason 'hidden' / 'left'). Nothing starts it again by
// itself.

import { SONG } from './config.js';

// ---------------------------------------------------------------- pure

export function fitLoop(loop, duration, minSec = SONG.player.minLoopSec) {
  if (!loop || !Number.isFinite(loop.start) || !Number.isFinite(loop.end)) return null;
  const start = Math.min(duration, Math.max(0, Math.min(loop.start, loop.end)));
  const end = Math.min(duration, Math.max(0, Math.max(loop.start, loop.end)));
  return end - start >= minSec ? { start, end } : null;
}

export function createClock({ duration }) {
  if (!(duration > 0)) throw new RangeError(`createClock: duration must be > 0, got ${duration}`);
  let playing = false, offset = 0, startedAt = 0, loop = null;
  const clamp = (s) => Math.min(duration, Math.max(0, Number.isFinite(s) ? s : 0));

  function positionAt(ctxTime) {
    if (!playing) return offset;
    const raw = offset + Math.max(0, ctxTime - startedAt);
    if (loop && offset < loop.end) {
      if (raw < loop.end) return raw;
      return loop.start + ((raw - loop.end) % (loop.end - loop.start));
    }
    return Math.min(raw, duration);
  }
  // Take the position as the new anchor, so a change of loop or a pause starts from it.
  function anchor(ctxTime) {
    offset = positionAt(ctxTime);
    startedAt = ctxTime;
    if (loop && offset >= loop.end) offset = loop.start;
  }

  return {
    duration,
    get playing() { return playing; },
    get loop() { return loop; },
    play(ctxTime) { if (offset >= duration) offset = 0; anchor(ctxTime); playing = true; },
    pause(ctxTime) { anchor(ctxTime); playing = false; },
    seek(songSec, ctxTime) { offset = clamp(songSec); startedAt = ctxTime; if (loop && offset >= loop.end) offset = loop.start; },
    setLoop(next, ctxTime) { anchor(ctxTime); loop = fitLoop(next, duration); if (loop && offset >= loop.end) offset = loop.start; },
    positionAt,
    segmentAt(ctxTime) {
      if (!playing) return null;
      if (loop && offset < loop.end) {
        const len = loop.end - loop.start, firstEnd = startedAt + (loop.end - offset);
        if (ctxTime < firstEnd) return { ctxStart: startedAt, songStart: offset, ctxEnd: firstEnd };
        const k = Math.floor((ctxTime - firstEnd) / len);
        return { ctxStart: firstEnd + k * len, songStart: loop.start, ctxEnd: firstEnd + (k + 1) * len };
      }
      return { ctxStart: startedAt, songStart: offset, ctxEnd: startedAt + (duration - offset) };
    },
  };
}

// ---------------------------------------------------------------- browser

const isAudioBuffer = (x) => x && typeof x.getChannelData === 'function' && typeof x.numberOfChannels === 'number';

export function createPlayer({ audioContext, destination, config = SONG, pauseWhenHidden = true } = {}) {
  if (!audioContext) throw new TypeError('createPlayer: audioContext is required (one clock for playing and recording)');
  const ctx = audioContext, P = config.player;
  const output = ctx.createGain();
  output.connect(destination ?? ctx.destination);
  const backingGainNode = ctx.createGain();
  backingGainNode.connect(output);

  const subs = new Map();
  const layers = new Map();          // name -> { buffer, gainNode, source, gain }
  let buffer = null, clock = null, source = null, id = null, ended = false, volume = 1, backingGain = 1, destroyed = false;

  const emit = (type, detail = {}) => { for (const fn of [...(subs.get(type) || [])]) fn(detail); };
  const status = () => (!buffer ? 'empty' : clock.playing ? 'playing' : ended ? 'ended' : clock.positionAt(ctx.currentTime) > 0 ? 'paused' : 'ready');
  const state = () => ({
    status: status(), id,
    position: clock ? clock.positionAt(ctx.currentTime) : 0,
    duration: buffer ? buffer.duration : 0,
    loop: clock ? clock.loop : null,
    volume, backingGain,
    layers: [...layers.keys()],
  });
  const changed = () => emit('state', state());
  // A start time a little ahead, on a whole frame of the context: then the time the clock
  // remembers is the time the sound card really starts on.
  const soon = () => Math.ceil((ctx.currentTime + P.leadSec) * ctx.sampleRate) / ctx.sampleRate;
  // A gain goes to its new value in a straight line over gainEaseSec and then IS that
  // value: at 0 the node gives samples of exactly zero (owner 2026-10-13: "i want to mute
  // it completely"). The curve this replaced (setTargetAtTime) only ever approaches its
  // target, so "off" was very quiet, not silent. With nothing playing there is no step to
  // click, so the value is set at once: a song opened with a slider at 0 starts silent
  // from its first sample.
  const ease = (param, value) => {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    if (!clock || !clock.playing) { param.value = value; return; }
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + P.gainEaseSec);
  };

  function startSource(buf, into, when) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const loop = clock.loop;
    if (loop) { s.loop = true; s.loopStart = loop.start; s.loopEnd = loop.end; }
    s.connect(into);
    // The clock is asked for the position at `when`, so a source started later than the
    // others (a layer swapped in mid-song) still lands on the same sample of the song.
    // On a whole sample of this buffer: a start between two samples makes the browser
    // blend neighbours for the whole play, which dulls the sound a little.
    const offset = Math.round(clock.positionAt(when) * buf.sampleRate) / buf.sampleRate;
    s.start(when, Math.min(offset, Math.max(0, buf.duration - 1 / buf.sampleRate)));
    return s;
  }
  function stopSource(s) {
    if (!s) return;
    s.onended = null;
    try { s.stop(); } catch { /* never started */ }
    s.disconnect();
  }
  function stopAll() {
    stopSource(source);
    source = null;
    for (const l of layers.values()) { stopSource(l.source); l.source = null; }
  }
  function startAll(when) {
    source = startSource(buffer, backingGainNode, when);
    const mine = source;
    source.onended = () => {
      if (source !== mine) return;
      // The track ran to its end by itself.
      stopAll();
      clock.pause(ctx.currentTime);
      clock.seek(buffer.duration, ctx.currentTime);
      ended = true;
      emit('ended');
      changed();
    };
    for (const l of layers.values()) l.source = startSource(l.buffer, l.gainNode, when);
  }
  // Start again from where the clock says, after a seek or a change of loop.
  function restart() {
    if (!clock.playing) return;
    stopAll();
    const when = soon();
    clock.seek(clock.positionAt(ctx.currentTime), when);
    startAll(when);
    emit('play', { ctxTime: when, song: clock.positionAt(when) });
  }

  async function decode(src) {
    if (isAudioBuffer(src)) return src;
    if (src && Array.isArray(src.channels)) {
      const b = ctx.createBuffer(src.channels.length, src.channels[0].length, src.sampleRate);
      src.channels.forEach((c, i) => b.copyToChannel(c, i));
      return b;
    }
    try {
      const bytes = src instanceof ArrayBuffer ? src : await src.arrayBuffer();
      // slice: decodeAudioData takes the buffer away from the caller, who may still want it.
      return await ctx.decodeAudioData(bytes.slice(0));
    } catch (err) {
      const e = new Error('This file could not be read as sound. Try an MP3, M4A, WAV, OGG or FLAC file.');
      e.name = 'DecodeError';
      e.cause = err;
      throw e;
    }
  }

  const player = {
    ctx, output,
    async load(src, { id: songId = null } = {}) {
      const next = await decode(src);
      if (destroyed) return null;
      if (!(next.duration > 0)) { const e = new Error('This file has no sound in it.'); e.name = 'DecodeError'; throw e; }
      if (clock && clock.playing) player.pause('load');
      for (const name of [...layers.keys()]) player.removeLayer(name);
      buffer = next;
      clock = createClock({ duration: buffer.duration });
      id = songId;
      ended = false;
      emit('load');
      changed();
      return { id, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
    },
    play() {
      if (!buffer || destroyed) return false;
      if (clock.playing) return true;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      ended = false;
      const when = soon();
      clock.play(when);
      startAll(when);
      emit('play', { ctxTime: when, song: clock.positionAt(when) });
      changed();
      return true;
    },
    pause(reason = 'pause') {
      if (!clock || !clock.playing) return;
      stopAll();
      clock.pause(ctx.currentTime);
      emit('pause', { song: clock.positionAt(ctx.currentTime), reason });
      changed();
    },
    seek(songSec) {
      if (!clock) return;
      ended = false;
      clock.seek(songSec, ctx.currentTime);
      emit('seek', { song: clock.positionAt(ctx.currentTime) });
      restart();
      changed();
    },
    setLoop(startSec, endSec) {
      if (!clock) return;
      clock.setLoop({ start: startSec, end: endSec }, ctx.currentTime);
      emit('loop', { loop: clock.loop });
      restart();
      changed();
    },
    clearLoop() {
      if (!clock || !clock.loop) return;
      clock.setLoop(null, ctx.currentTime);
      emit('loop', { loop: null });
      restart();
      changed();
    },
    taps: () => ({ backing: backingGainNode, layers: Object.fromEntries([...layers].map(([name, l]) => [name, l.gainNode])) }),
    levels: () => ({ volume: output.gain.value, backing: backingGainNode.gain.value, layers: Object.fromEntries([...layers].map(([name, l]) => [name, l.gainNode.gain.value])) }),
    setVolume(v) { volume = Math.min(1, Math.max(0, +v || 0)); ease(output.gain, volume); changed(); },
    setBackingGain(v) { backingGain = Math.min(1, Math.max(0, +v || 0)); ease(backingGainNode.gain, backingGain); changed(); },
    setLayer(name, { samples, sampleRate, at = 0, gain = 1 }) {
      if (!buffer) throw new Error('setLayer: load a song first');
      const old = layers.get(name);
      // A buffer of the song's whole length with the take written at its place: then the
      // layer starts, seeks and loops with exactly the numbers the backing uses.
      const total = Math.max(1, Math.round(buffer.duration * sampleRate));
      const buf = ctx.createBuffer(1, total, sampleRate);
      const data = buf.getChannelData(0);
      const first = Math.round(at * sampleRate);
      const from = Math.max(0, -first), to = Math.min(samples.length, total - first);
      if (to > from) data.set(samples.subarray(from, to), first + from);
      const gainNode = old ? old.gainNode : ctx.createGain();
      if (!old) { gainNode.gain.value = gain; gainNode.connect(output); }
      const layer = { buffer: buf, gainNode, source: null, gain: old ? old.gain : gain };
      if (old) stopSource(old.source);
      layers.set(name, layer);
      if (clock.playing) layer.source = startSource(buf, gainNode, soon());
      changed();
    },
    setLayerGain(name, v) {
      const l = layers.get(name);
      if (!l) return;
      l.gain = Math.min(1, Math.max(0, +v || 0));
      ease(l.gainNode.gain, l.gain);
    },
    removeLayer(name) {
      const l = layers.get(name);
      if (!l) return;
      stopSource(l.source);
      l.gainNode.disconnect();
      layers.delete(name);
      changed();
    },
    time: () => (clock ? clock.positionAt(ctx.currentTime) : 0),
    heardTime: () => (clock ? Math.max(0, clock.positionAt(ctx.currentTime - (player.latency().output || 0))) : 0),
    timeAt: (ctxTime) => (clock ? clock.positionAt(ctxTime) : 0),
    segmentAt: (ctxTime) => (clock ? clock.segmentAt(ctxTime) : null),
    latency: () => ({
      output: Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0 ? ctx.outputLatency : null,
      base: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : null,
    }),
    backing() {
      if (!buffer) return null;
      return {
        id, sampleRate: buffer.sampleRate, duration: buffer.duration,
        channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
      };
    },
    state,
    on(type, fn) {
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(fn);
      return () => subs.get(type).delete(fn);
    },
    destroy() {
      if (destroyed) return;
      if (clock && clock.playing) player.pause('destroy');
      destroyed = true;
      stopAll();
      for (const l of layers.values()) l.gainNode.disconnect();
      layers.clear();
      backingGainNode.disconnect();
      output.disconnect();
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('pagehide', away);
      subs.clear();
    },
  };

  const away = (e) => {
    if (e.type === 'visibilitychange' && !document.hidden) return;
    player.pause(e.type === 'pagehide' ? 'left' : 'hidden');
  };
  if (pauseWhenHidden) {
    document.addEventListener('visibilitychange', away);
    window.addEventListener('pagehide', away);
  }
  return player;
}
