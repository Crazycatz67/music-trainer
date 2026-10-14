// transport.js — the music controls of song mode
// (docs/design/specs/2026-10-12-song-mode.md section 6). THIS IS THE LOGIC HALF: which
// place a control goes to, and what a jump does to a take. It has no DOM and runs in Node
// with a stand-in player; the scrub bar and the keys are drawn on top of it by the screens.
//
// THE RULE FOR TAKES (spec 6.3; settled by the design):
//   Listening and practising: jump, loop, replay and scrub freely. Nothing is recorded, and
//   a jump does not touch the microphone flow (the recorder is simply not running).
//   A take is ONE STRAIGHT RUN from a chosen place. While a take is being recorded every
//   jump is HELD: the call answers { ok: false, held: true } and nothing moves, so a slip
//   of a key cannot end five minutes of singing. The screen then asks; when the owner
//   agrees it calls the same control with { endTake: true }: the take is ended cleanly
//   (recorder.stop('seek'), what was sung is kept and saved), then the jump happens.
//   Loops are refused during a take ({ ok: false, reason: 'take' }).
//
// TIME is seconds of song. LINES are what "previous line / next line" step through:
// [{ t, end }] in time order: the words' line spans (words.js lineSpans) when the song has
// timed words, else its phrases (phrases.js).
//
// CONTRACT
//   createTransport({ player, recorder?, lines?, phrases?, config? }) -> transport
//       player    js/app/song/player.js (uses time, seek, play, pause, setLoop, clearLoop, state)
//       recorder  js/app/song/recorder.js (optional: without one there are no takes)
//   transport.setLines(lines, phrases?)      phrases: for the count-in before a line
//   transport.mode() -> 'take' | 'free'      'take' while the recorder is starting or recording
//   transport.lineIndex() -> the line being sung or last begun, -1 before the first
//   Jumps: each returns Promise<{ ok: true, to, line?, endedTake } | { ok: false, held: true, kind }>
//     transport.seek(sec, o?)                anywhere (clamped to the song)
//     transport.skip(deltaSec?, o?)          default +5; pass -5, 1, -1 (config.skipSec / fineSkipSec)
//     transport.toLine(index, o?)            a line's start
//     transport.prevLine(o?)                 within prevGraceSec of a line's start: the line
//                                            before; later: this line's start
//     transport.nextLine(o?)
//     transport.replayLine(o?)               this line's start again
//     transport.restart(o?)                  0
//     transport.toTenth(n, o?)               n tenths of the song (1..9)
//     o = { endTake = false, exact = false }
//       A line jump made while the song is playing lands a count-in early (phrases.js
//       leadIn: 3 s before, or at the end of the phrase before); `exact`, or paused: on the
//       line's first moment.
//   Loops: return { ok: true, loop } | { ok: false, reason: 'take' | 'no-line' }
//     transport.loopLine(index = this line)  transport.loopRange(a, b)  transport.clearLoop()
//   transport.play() / transport.pause() / transport.toggle()
//   transport.startTake({ line?, from?, exact = false, stream?, play = true }) ->
//       Promise<{ ok, fromSec, line, reason? }>
//       Call it from the owner's press. Clears any loop, moves to the count-in before the
//       chosen line (default: this line; `from`: any time), then starts the recorder, which
//       starts the music. reason: the recorder's ('busy', 'no-microphone', ...), or 'no-recorder'.
//   transport.planTake({ line?, from?, exact? }) -> { fromSec, line, start }
//       Where startTake with the same options would begin, without moving or starting
//       anything: the screen shows that place during its count before the take.
//   transport.stopTake(reason = 'stop') -> Promise<take | null>
//   transport.on(fn) -> off      fn({ type: 'jump', kind, to, line, endedTake } |
//                                   { type: 'held', kind } | { type: 'loop', loop } | { type: 'take', on, fromSec? })
//   Pure: lineIndexAt(lines, t), prevTarget(lines, t, graceSec), clampTime(t, duration)

import { SONG } from './song/config.js';
import { leadIn } from './song/phrases.js';

// The last line that has begun at t; -1 before the first.
export function lineIndexAt(lines, t) {
  let lo = 0, hi = (lines ? lines.length : 0) - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= t + 1e-9) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}

// Which line "previous" means at time t: the music-player habit.
export function prevTarget(lines, t, graceSec) {
  const i = lineIndexAt(lines, t);
  if (i < 0) return -1;
  return t - lines[i].t <= graceSec ? i - 1 : i;
}

export const clampTime = (t, duration) => Math.min(Math.max(0, Number.isFinite(t) ? t : 0), Math.max(0, duration || 0));

export function createTransport({ player, recorder = null, lines: firstLines = [], phrases: firstPhrases = null, config = SONG.transport } = {}) {
  if (!player) throw new TypeError('createTransport: a player is required');
  const subs = new Set();
  let lines = firstLines || [], phrases = firstPhrases || firstLines || [];
  // After a jump to a line's count-in the clock is still BEFORE that line: remember which
  // line was meant, so "next" and "previous" count from it and not from the line before.
  let aimed = null;       // { index, until }
  const emit = (event) => { for (const fn of [...subs]) { try { fn(event); } catch { /* a listener's own trouble */ } } };
  const duration = () => player.state().duration || 0;
  const playing = () => player.state().status === 'playing';
  const mode = () => (recorder && ['starting', 'recording'].includes(recorder.state().status) ? 'take' : 'free');

  function lineIndex() {
    const t = player.time();
    if (aimed && t < aimed.until && t >= aimed.from - 0.05) return aimed.index;
    aimed = null;
    return lineIndexAt(lines, t);
  }

  async function jump(kind, to, line, { endTake = false } = {}) {
    let endedTake = false;
    if (mode() === 'take') {
      if (!endTake) { emit({ type: 'held', kind }); return { ok: false, held: true, kind }; }
      // End the take first, on its own terms: everything sung up to here is kept.
      await recorder.stop('seek');
      endedTake = true;
    }
    const target = clampTime(to, duration());
    player.seek(target);
    const out = { ok: true, to: target, line, endedTake };
    emit({ type: 'jump', kind, ...out });
    return out;
  }
  function lineJump(kind, index, o = {}) {
    if (!lines.length) return jump(kind, kind === 'next' ? duration() : 0, -1, o);
    const i = Math.min(lines.length - 1, Math.max(0, index));
    const start = lines[i].t;
    const to = playing() && !o.exact ? leadIn(phrases, start) : start;
    return jump(kind, to, i, o).then((res) => { if (res.ok) aimed = to < start ? { index: i, from: to, until: start } : null; return res; });
  }
  const free = (kind, to, o) => { aimed = null; return jump(kind, to, undefined, o); };

  const transport = {
    setLines(next, nextPhrases = null) { lines = next || []; phrases = nextPhrases || lines; aimed = null; },
    mode, lineIndex,
    seek: (sec, o) => free('seek', sec, o),
    skip: (delta = config.skipSec, o) => free('skip', player.time() + delta, o),
    toLine: (index, o) => lineJump('line', index, o),
    prevLine(o) {
      const t = player.time();
      const i = aimed && t < aimed.until ? aimed.index - 1 : prevTarget(lines, t, config.prevGraceSec);
      return i < 0 ? free('prev', 0, o) : lineJump('prev', i, o);
    },
    nextLine: (o) => lineJump('next', lineIndex() + 1, o),
    replayLine: (o) => lineJump('replay', Math.max(0, lineIndex()), o),
    restart: (o) => free('restart', 0, o),
    toTenth: (n, o) => free('tenth', (duration() * Math.min(9, Math.max(1, Math.round(n)))) / 10, o),

    loopLine(index = lineIndex()) {
      if (mode() === 'take') return { ok: false, reason: 'take' };
      const line = lines[index];
      if (!line) return { ok: false, reason: 'no-line' };
      return transport.loopRange(line.t, line.end);
    },
    loopRange(a, b) {
      if (mode() === 'take') return { ok: false, reason: 'take' };
      player.setLoop(a, b);
      const loop = player.state().loop;
      emit({ type: 'loop', loop });
      return loop ? { ok: true, loop } : { ok: false, reason: 'no-line' };
    },
    clearLoop() {
      if (mode() === 'take') return { ok: false, reason: 'take' };
      player.clearLoop();
      emit({ type: 'loop', loop: null });
      return { ok: true, loop: null };
    },
    play: () => player.play(),
    pause: () => player.pause(),
    toggle: () => (playing() ? (player.pause(), false) : player.play()),

    planTake({ line = null, from = null, exact = false } = {}) {
      const i = Number.isFinite(from) ? lineIndexAt(lines, from) : (line ?? Math.max(0, lineIndex()));
      const start = Number.isFinite(from) ? from : (lines[i] ? lines[i].t : player.time());
      return { fromSec: clampTime(exact ? start : leadIn(phrases, start), duration()), line: i, start };
    },
    async startTake({ line = null, from = null, exact = false, stream, play = true } = {}) {
      if (!recorder) return { ok: false, reason: 'no-recorder', fromSec: null, line: -1 };
      if (mode() === 'take') return { ok: false, reason: 'busy', fromSec: null, line: -1 };
      // A take is one straight run: no loop, and the music is stopped until the recorder
      // is listening, so the first note is never missed.
      if (playing()) player.pause();
      if (player.state().loop) player.clearLoop();
      const { fromSec, line: i, start } = transport.planTake({ line, from, exact });
      player.seek(fromSec);
      aimed = fromSec < start ? { index: i, from: fromSec, until: start } : null;
      const res = await recorder.start({ ...(stream ? { stream } : {}), play, fromSec });
      if (res.ok) emit({ type: 'take', on: true, fromSec });
      return { ...res, fromSec, line: i };
    },
    async stopTake(reason = 'stop') {
      if (!recorder) return null;
      const take = await recorder.stop(reason);
      emit({ type: 'take', on: false });
      return take;
    },
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  return transport;
}
