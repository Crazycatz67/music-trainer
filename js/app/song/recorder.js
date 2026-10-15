// recorder.js — records the singer's microphone while the backing plays, and notes which
// moment of the song the first recorded sample belongs to, so the take can be lined up with
// the backing afterwards (js/app/song/align.js).
//
// The microphone is NOT opened here. The stream comes from the app's one microphone path,
// js/app/micflow.js (flow.request() from the owner's press, its sheets and banners, its
// release rules). This file only listens to that stream with a second node, in the PLAYER's
// audio context, so the take and the backing share one clock and no clock has to be converted.
//
// CAPTURE METHOD: an AudioWorklet (capture-worklet.js) copying raw samples, each chunk
// stamped with the context's frame number. Not MediaRecorder: that gives compressed sound
// whose first sample has no known time on the context's clock, plus codec padding, so the
// take could only be lined up by ear. The price: raw sound is bigger (stored 16-bit, about
// 5.8 MB a minute at 48 kHz) and the worklet is a second file.
//
// A TAKE is one unbroken stretch of the song. It ends when: Stop is pressed, the player is
// paused, the page is hidden or left, the microphone goes away, the player seeks, a loop is
// set or wraps round, the track ends, or config.recorder.maxSec is reached. Whatever was
// recorded up to then is kept. Ending always releases the microphone (micflow.stop()).
// Nothing starts a recording again by itself.
//
// A TAKE IS NEVER LOST (engine change E1, song-mode spec 7.5). Given a take store, the
// recorder writes the take into it WHILE recording: a piece every config.recorder
// .checkpointSec, one more in the same turn the page is hidden or left, and the rest when
// the take ends, when it is marked finished. At EVERY stop the piece gathered so far is
// written and the take marked finished in that very turn (store.appendNow): the stop may be
// the page going (reload, close, another address: heard through 'beforeunload'), and a page
// that is going runs no later turn, so nothing that waits can be trusted there. At most the last chunk still on its way from the audio thread is
// lost (about 0.1 s). A killed tab or a crash runs no code at all and therefore keeps
// everything up to the last piece (the store lists it with `finished: false`). Writing a
// piece joins the sound gathered so far on the main thread (about 10 ms for four minutes).
// When the store refuses (full of protected takes, storage off) the take still arrives
// through onTake with `saved.ok` false, so the screen can offer "Save as a file now".
//
// CONTRACT
//   createRecorder({ micflow, player, songId?, store?, title?, config?, workletUrl?, kind? }) -> recorder
//       kind: 'song' (default) | 'free'; written on every piece (takes.js meta.kind) and on the take.
//       store: a take store (takes.js). Without one nothing is written and the caller saves.
//   recorder.start({ stream?, play = true, fromSec? }) -> Promise<{ ok, reason? }>
//       fromSec: the place the owner chose to start from (kept on the take).
//       Call it from the owner's press. Asks micflow for the microphone (`stream`: a stream
//       the page made, as micflow.request takes; the lab's synthetic singer), starts
//       capturing, then starts the player unless it is already playing or play is false.
//       reason: 'busy' | 'no-song' | 'no-microphone' | 'stopped' | 'failed'
//   recorder.stop(reason = 'stop') -> Promise<take | null>     safe to call twice
//   recorder.state() -> { status, seconds, endedBy, songId }
//       status: 'idle' | 'starting' | 'recording' | 'saving'. Show "recording" for 'recording'.
//   recorder.subscribe(fn) -> off         fn(state()) on every change of status
//   recorder.onTake(fn) -> off            fn(take) once a take is complete
//   recorder.last                         the last take, or null
//   recorder.destroy()                    stops (the take so far is still delivered)
//   document event 'mt:recording', detail { on: boolean, status, reason }
//
//   take = { id, songId, createdAt (ISO), sampleRate, samples (Float32Array, mono),
//            seconds, songStart, latency: { input, output, base }, nudgeMs: 0, gaps,
//            endedBy, frames, cleanupOn, title, fromSec, saved }
//     saved       null without a store; else what the store answered for the finished take:
//                 { ok: true, id, bytes, removed, words } | { ok: false, reason, words }
//     songStart   the song time (seconds) the player was SCHEDULING when the first sample
//                 was captured; sample i belongs to songStart + i / sampleRate on that same
//                 raw scale. The input and output delays are not removed here: align.js does
//                 that. Negative when capture began before the music. null when the player
//                 never played during the take (it cannot be lined up).
//     latency     what the browser reported, seconds, null where it said nothing.
//     gaps        holes the audio thread left, filled with silence (0 on a healthy run).
//     endedBy     'stop' | 'pause' | 'hidden' | 'left' | 'mic-off' | 'seek' | 'loop' |
//                 'ended' | 'limit' | 'load' | 'destroy'
//     frames      the pitch frames micflow gave while recording, { t, hz, midi, clarity,
//                 voiced } with t in the same raw song time as songStart.
//
//   createCapture(ctx, { chunkFrames?, workletUrl? }) -> Promise<capture>     [browser]
//       capture.node            connect a source to it; it makes no sound
//       capture.setUntil(frame) stop by itself at that context frame
//       capture.stop() -> Promise<{ samples, firstFrame, gaps, reason }>
//       capture.done            the same promise, also settled when `until` is reached
//       capture.firstFrame()    frame of the first sample so far, or null
//       capture.snapshot()      { samples, gaps, firstFrame } gathered so far, at once
//   Pure: songStartOf(segment, firstFrame, sampleRate), framesToSong(frames, segment)

import { SONG } from './config.js';
import { joinChunks } from './pcm.js';

// ---------------------------------------------------------------- pure

// segment = player.segmentAt(...): song = songStart + (ctxTime - ctxStart) on that stretch.
export function songStartOf(segment, firstFrame, sampleRate) {
  if (!segment || !Number.isFinite(firstFrame)) return null;
  return segment.songStart + (firstFrame / sampleRate - segment.ctxStart);
}

// frames carry t on the context's clock; give them the take's raw song time instead.
export function framesToSong(frames, segment) {
  if (!segment) return [];
  return frames.map((f) => ({ ...f, t: segment.songStart + (f.t - segment.ctxStart) }));
}

const PAUSE_REASONS = { hidden: 'hidden', left: 'left', load: 'load', destroy: 'destroy' };

// ---------------------------------------------------------------- browser

const modules = new WeakMap();      // one addModule per audio context

export async function createCapture(ctx, { chunkFrames = SONG.recorder.chunkFrames, workletUrl } = {}) {
  if (!ctx.audioWorklet) throw new DOMException('This browser cannot record here (no AudioWorklet).', 'NotSupportedError');
  const url = workletUrl ?? new URL('./capture-worklet.js', import.meta.url).href;
  if (!modules.has(ctx)) modules.set(ctx, ctx.audioWorklet.addModule(url));
  try { await modules.get(ctx); } catch (err) { modules.delete(ctx); throw err; }

  const node = new AudioWorkletNode(ctx, 'song-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', processorOptions: { chunkFrames } });
  const chunks = [];
  let settle, settled = false, asked = false;
  const done = new Promise((r) => { settle = r; });
  const finish = (reason) => {
    if (settled) return;
    settled = true;
    node.port.onmessage = null;
    try { node.disconnect(); } catch { /* not connected */ }
    const { samples, gaps } = joinChunks(chunks);
    settle({ samples, gaps, firstFrame: chunks.length ? chunks[0].frame : null, reason });
  };
  node.port.onmessage = (e) => {
    if (e.data.type === 'chunk') chunks.push({ frame: e.data.frame, samples: e.data.samples });
    else if (e.data.type === 'done') finish(asked ? 'stop' : e.data.reason);
  };
  return {
    node, done,
    firstFrame: () => (chunks.length ? chunks[0].frame : null),
    snapshot: () => ({ ...joinChunks(chunks), firstFrame: chunks.length ? chunks[0].frame : null }),
    setUntil(frame) { node.port.postMessage({ type: 'until', frame: Math.round(frame) }); },
    stop() {
      if (!asked && !settled) {
        asked = true;
        node.port.postMessage({ type: 'stop' });
        // The answer comes from the audio thread. If the context is suspended or closed it
        // never comes: keep what has arrived.
        setTimeout(() => finish('stop'), 300);
      }
      return done;
    },
  };
}

export function createRecorder({ micflow, player, songId = null, store = null, title = '', config = SONG, workletUrl, kind = 'song' } = {}) {
  if (!micflow || !player) throw new TypeError('createRecorder: micflow and player are required');
  const ctx = player.ctx, R = config.recorder;
  const subs = new Set(), takeSubs = new Set();
  let status = 'idle', endedBy = null, last = null, run = null, destroyed = false, startedAt = 0, cancelStart = null;

  const state = () => ({
    status, endedBy, songId,
    seconds: status === 'recording' ? Math.max(0, ctx.currentTime - startedAt) : last ? last.seconds : 0,
  });
  function setStatus(next, reason = null) {
    if (status === next) return;
    const wasOn = status === 'recording';
    status = next;
    for (const fn of [...subs]) fn(state());
    if (wasOn !== (next === 'recording')) {
      document.dispatchEvent(new CustomEvent('mt:recording', { detail: { on: next === 'recording', status: next, reason } }));
    }
  }

  // Which stretch of the song the take belongs to: taken once, from the first moment the
  // player is playing while we capture.
  function pin(r, ctxTime) {
    if (r.segment || r.stopping) return;
    const seg = player.segmentAt(ctxTime);
    if (!seg) return;
    r.segment = seg;
    // End on the exact sample where the song time stops being one straight line: the loop's
    // wrap, or the end of the track. Never later than the length limit.
    r.capture.setUntil(Math.min(seg.ctxEnd, startedAt + R.maxSec) * ctx.sampleRate);
  }

  const latencyOf = (r) => ({
    input: r.mic && r.mic.latency && Number.isFinite(r.mic.latency.input) ? r.mic.latency.input : null,
    ...player.latency(),
  });
  // Hand the store whatever has been gathered since the last piece. Called on a timer, in
  // the turn the page goes away, and at the end. Pieces are written one after another.
  // The page is going: write what is left and mark the take finished, all in this turn.
  // Only when no piece is still being written (the store's rule); otherwise the usual way.
  function flushNow(r, reason) {
    if (!store || r.storeFailed || r.pending || typeof store.appendNow !== 'function') return false;
    const snap = r.capture.snapshot();
    const fresh = snap.samples.subarray(r.sent);
    const facts = {
      kind, songId, title, createdAt: r.createdAt, sampleRate: ctx.sampleRate, fromSec: r.fromSec, endedBy: reason,
      songStart: songStartOf(r.segment, snap.firstFrame, ctx.sampleRate), latency: latencyOf(r), gaps: snap.gaps,
    };
    const ok = store.appendNow(r.id, facts, fresh.slice(), framesToSong(r.frames.slice(r.framesSent), r.segment), { finished: true });
    if (ok) { r.sent = snap.samples.length; r.framesSent = r.frames.length; }
    return ok;
  }
  function flush(r, got = null) {
    if (!store || r.storeFailed) return;
    const snap = got || r.capture.snapshot();
    // Before the music has started there is no song time to give the frames: wait.
    if (!r.segment && !got) return;
    const fresh = snap.samples.subarray(r.sent);
    if (!fresh.length) return;
    const frames = framesToSong(r.frames.slice(r.framesSent), r.segment);
    r.sent = snap.samples.length;
    r.framesSent = r.frames.length;
    const facts = {
      kind, songId, title, createdAt: r.createdAt, sampleRate: ctx.sampleRate, fromSec: r.fromSec,
      songStart: songStartOf(r.segment, snap.firstFrame, ctx.sampleRate), latency: latencyOf(r), gaps: snap.gaps,
    };
    // A copy: the piece must not change if the caller's array is reused.
    const piece = fresh.slice();
    r.pending = (r.pending || 0) + 1;
    r.writing = r.writing.then(() => store.append(r.id, facts, piece, frames)).then((res) => { if (!res.ok) r.storeFailed = res; }, () => { r.storeFailed = { ok: false, reason: 'storage', words: null }; }).finally(() => { r.pending--; });
  }

  function stop(reason = 'stop') {
    const r = run;
    if (!r) {
      // Stopped while the microphone was still being asked for: drop the start.
      if (status === 'starting' && cancelStart) { cancelStart(); micflow.stop(); }
      return Promise.resolve(null);
    }
    if (r.stopping) return r.stopping;
    endedBy = reason;
    for (const off of r.offs) off();
    r.offs = [];
    clearInterval(r.timer);
    const latency = latencyOf(r);
    // In this same turn, before anything is awaited: a page that is going away may never
    // run another turn, and what is handed to the store now is what survives.
    // Whatever the reason: when a page goes, the first thing the recorder hears may be the
    // microphone ending or the player pausing, not 'pagehide' (measured in the sing-now lab:
    // a frame navigated away ended its take by 'mic-off'). So every stop writes at once.
    if (r.capture && !flushNow(r, reason)) flush(r);
    const cleanupOn = typeof micflow.cleanupWasOn === 'function' ? !!micflow.cleanupWasOn() : false;
    // Release first, in this same turn: by the time a hidden page's handler returns, no node
    // of ours is reading the microphone and micflow has ended its tracks.
    try { r.source.disconnect(); } catch { /* already */ }
    micflow.stop();
    setStatus('saving', reason);
    r.stopping = (r.capture ? r.capture.stop() : Promise.resolve({ samples: new Float32Array(0), gaps: 0, firstFrame: null }))
      .then(async (got) => {
        const take = {
          id: r.id,
          kind, songId, title, fromSec: r.fromSec, saved: null,
          createdAt: r.createdAt,
          sampleRate: ctx.sampleRate,
          samples: got.samples,
          seconds: got.samples.length / ctx.sampleRate,
          songStart: songStartOf(r.segment, got.firstFrame, ctx.sampleRate),
          latency, nudgeMs: 0, gaps: got.gaps, endedBy: reason,
          frames: framesToSong(r.frames, r.segment),
          cleanupOn,
        };
        if (store) {
          const facts = { kind, songId, title, sampleRate: take.sampleRate, fromSec: take.fromSec, songStart: take.songStart, latency, gaps: take.gaps, endedBy: reason };
          try {
            if (take.samples.length) {
              flush(r, got);
              await r.writing;
              // The pieces went in: mark it finished. If one was refused, try it whole once
              // (room may have been made); the answer either way goes with the take.
              take.saved = r.storeFailed ? await store.save(take, { title }) : await store.finish(r.id, facts);
              if (!take.saved.ok) await store.remove(r.id);
            } else {
              await r.writing;
              await store.remove(r.id);
            }
          } catch {
            take.saved = { ok: false, reason: 'storage', words: null };
          }
        }
        run = null;
        // A take with no sound in it (stopped before the first chunk) is not a take.
        last = take.samples.length ? take : null;
        setStatus('idle', reason);
        if (last) for (const fn of [...takeSubs]) fn(last);
        return last;
      });
    return r.stopping;
  }

  async function start({ stream, play = true, fromSec = null } = {}) {
    if (destroyed || status !== 'idle') return { ok: false, reason: 'busy' };
    if (!player.state().duration) return { ok: false, reason: 'no-song' };
    endedBy = null;
    setStatus('starting');
    let cancelled = false;
    // Hidden or left while the browser's own microphone question is up: micflow drops the
    // request; make sure we do not carry on after it.
    const away = (e) => { if (e.type !== 'visibilitychange' || document.hidden) cancelled = true; };
    cancelStart = () => { cancelled = true; };
    document.addEventListener('visibilitychange', away);
    window.addEventListener('pagehide', away);
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const ok = await micflow.request(stream ? { stream } : {});
      if (!ok || !micflow.mic) { setStatus('idle'); return { ok: false, reason: 'no-microphone' }; }
      const capture = await createCapture(ctx, { chunkFrames: R.chunkFrames, workletUrl });
      if (cancelled || destroyed || !micflow.mic) {
        capture.stop();
        micflow.stop();
        setStatus('idle');
        return { ok: false, reason: 'stopped' };
      }
      const r = {
        source: ctx.createMediaStreamSource(micflow.mic.stream), capture, mic: micflow.mic,
        offs: [], segment: null, frames: [], delta: null, stopping: null,
        id: `take-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(), fromSec: Number.isFinite(fromSec) ? fromSec : null,
        sent: 0, framesSent: 0, writing: Promise.resolve(), storeFailed: null, timer: null,
      };
      if (store) r.timer = setInterval(() => { if (run === r && !r.stopping) flush(r); }, R.checkpointSec * 1000);
      r.source.connect(capture.node);
      run = r;
      startedAt = ctx.currentTime;

      const micCtx = r.mic.ctx;
      r.offs.push(
        player.on('play', (d) => pin(r, d.ctxTime)),
        player.on('pause', (d) => stop(PAUSE_REASONS[d.reason] || 'pause')),
        player.on('seek', () => stop('seek')),
        player.on('loop', () => stop('loop')),
        player.on('ended', () => stop('ended')),
        player.on('load', () => stop('load')),
        micflow.subscribe((s) => { if (s.phase !== 'on' && s.phase !== 'checking') stop('mic-off'); }),
        micflow.onFrame((frame) => {
          // The pitch reader runs in micflow's own audio context: move its time onto ours.
          // Smoothed, because both clocks tick in steps of a few milliseconds.
          const d = micCtx && micCtx !== ctx ? ctx.currentTime - micCtx.currentTime : 0;
          r.delta = r.delta === null ? d : r.delta + 0.05 * (d - r.delta);
          r.frames.push({ t: frame.t + r.delta, hz: frame.hz, midi: frame.midi, clarity: frame.clarity, voiced: frame.voiced });
        }),
      );
      const hid = (e) => { if (e.type !== 'visibilitychange' || document.hidden) stop(e.type === 'visibilitychange' ? 'hidden' : 'left'); };
      // capture: true so this hears it before micflow and the player do, and the take says
      // 'hidden' or 'left' rather than 'mic-off' or 'pause'.
      document.addEventListener('visibilitychange', hid, true);
      window.addEventListener('pagehide', hid, true);
      // 'beforeunload' is the one that counts when the page really goes (reload, close,
      // another address): it comes first, while the page is still whole. Measured in the
      // sing-now lab (Chrome, a page with live audio): a write started in 'beforeunload' is
      // kept, one started in 'pagehide' or 'unload' is not. No question is put to the
      // owner; if the leaving is called off after all, the take has simply ended here.
      window.addEventListener('beforeunload', hid, true);
      r.offs.push(() => { document.removeEventListener('visibilitychange', hid, true); window.removeEventListener('pagehide', hid, true); window.removeEventListener('beforeunload', hid, true); });

      // The worklet ended by itself: the loop wrapped, the track ended, or the limit.
      capture.done.then((got) => {
        if (run !== r || r.stopping) return;
        const seg = r.segment;
        const limit = !seg || startedAt + R.maxSec < seg.ctxEnd;
        stop(got.reason !== 'until' ? 'stop' : limit ? 'limit' : player.state().loop ? 'loop' : 'ended');
      });
      capture.setUntil((startedAt + R.maxSec) * ctx.sampleRate);

      setStatus('recording');
      if (player.state().status === 'playing') pin(r, ctx.currentTime);
      else if (play) player.play();
      return { ok: true };
    } catch (err) {
      micflow.stop();
      if (run) clearInterval(run.timer);
      run = null;
      setStatus('idle');
      return { ok: false, reason: 'failed', error: err };
    } finally {
      cancelStart = null;
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('pagehide', away);
    }
  }

  return {
    start, stop, state,
    get last() { return last; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    onTake(fn) { takeSubs.add(fn); return () => takeSubs.delete(fn); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop('destroy');
    },
  };
}
