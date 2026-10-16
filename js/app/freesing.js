// freesing.js — the live pitch screen, #/sing: see the note you are on with nothing to pass
// or fail (docs/design/specs/2026-10-12-singing-trainer.md section 6).
//
// CONTRACT — pure (import in Node)
//   takeFacts(points, config?) -> { durSec, lowMidi, highMidi, steady: { midi, sec } | null } | null
//       points: [{ t, midi | null }] as stage.points() gives them. null when no note was
//       held long enough to count (blips shorter than stage.dotRunSec are ignored, so one
//       glitch cannot become "your highest note").
//       steady = the longest unbroken stretch that stayed on one note (nearest semitone).
//       A hole shorter than stage.maxJoinGapSec inside it does not break it.
//   factsText(facts, noteStyle?) -> "Lowest note A2 · Highest note D4 · Steadiest note: G3, held 2.1 seconds"
//   trimTake(points, keepSec) -> the last keepSec seconds, times starting at 0
//   packTake(points, hz) -> [[t, midi | null], ...] thinned to about hz points a second,
//       keeping every change between sound and silence
//   saveTake(storage, take, max) -> true | false (storage full, blocked or missing)
//       Stored under 'music-trainer.takes.v1' as a JSON list, newest last, at most `max`:
//       { id, savedAt (ISO), kind: 'free', targetMidi | null, cleanupWasOn, facts, points }.
//       NOTE for whoever builds Progress: this shape is a first version, not yet read by
//       anything. Since 2026-10-15 an entry may also carry audioId (the take's sound in the
//       take store, js/app/song/takes.js, kind 'free') and audioStartSec (where that sound
//       begins on the line, audioSpan below); older entries have neither: a line, no sound.
//   audioSpan(rec, lineZeroSec, cutSec) -> { startSec, endSec } | null
//       Where a recording sits on the line's own time (seconds, 0 = the first point kept).
//       rec = { songStart, sampleRate, length }: songStart is the microphone-clock time of
//       sample 0 (the recorder's "song" time is that clock here, freeClock below);
//       lineZeroSec: the microphone-clock time of the line's first point before trimming;
//       cutSec: what trimTake cut off the front. null when there is no usable sound.
//   playPlan(span, fromSec, durSec) -> { offsetSec, delaySec } | null
//       To play from line time fromSec: start offsetSec into the sound, after delaySec of
//       silence. null when no sound is left from fromSec to the end of the line.
//   playbackGain(samples, { peak = 0.7, maxGain = 8 }) -> number
//       One fixed gain for the whole take: its loudest sample lands at `peak` (a quiet
//       laptop-mic take is lifted, at most maxGain times; a loud one is brought under 1).
//
// CONTRACT — mountFreeSing(view, { shell, micflow, settings, config?, micOptions?, storage? }) -> screen
//   screen.start() -> Promise<boolean>, screen.stop(), screen.state() -> { mode, targetMidi, facts }
//   screen.destroy()    releases the microphone and every listener
//   mode: idle | starting | live | paused | lost | tone | review
//   paused (Esc, any sheet, the page hidden or left): the microphone is released, every
//       track ended, the take is kept and the drawing loop rests; only a press on Resume
//       asks for the microphone again
//   micOptions is passed to micflow.request(): { stream } runs the whole screen from a
//   synthesised stream with no microphone (the stage lab does this).
//   takes: a take store (takes.js); default the app's own (IndexedDB), null = record no sound.
//   SOUND (2026-10-15, owner: "whats the point in recording just your wavelength"): the same
//   press that starts listening also records the singer, through the song recorder
//   (js/app/song/recorder.js) on the microphone's own stream and clock: no second microphone
//   request. The sound is written to the take store while singing (kind 'free'), stops at
//   the first pause (the microphone is released there) and is only recorded when it fits
//   without pushing an older take out. The review plays it with a playhead over the line.
//   It is kept only by "Save this take"; starting again or leaving removes an unsaved one.
//   screen.state() also gives { sound: { seconds, bytes, startSec, endSec } | null, playing, cursor }.

import { createSynth, timbreFor } from '../synth.js';
import { CONFIG } from './config.js';
import { createPitchView } from './hud.js';
import { confirmSheet, h, icon, STORAGE_PREFIX, toast } from './shell.js';
import { displayNote, segmentRuns } from './stage.js';
import { createRecorder } from './song/recorder.js';
import { peakOf } from './song/pcm.js';
import { createTakeStore, idbBackend } from './song/takes.js';
import { glowSamples, keepGlow } from './takeglow.js';

// ---------------------------------------------------------------- pure

export function takeFacts(points, config = CONFIG) {
  const runs = segmentRuns(points, config.stage).filter((r) => !r.dot);
  if (!runs.length) return null;
  let low = Infinity, high = -Infinity, steady = null;
  // The steadiest note: the longest stretch on one note (nearest semitone). A hole in the
  // sound shorter than stage.maxJoinGapSec does not end it when the same note carries on
  // after it (bugs.md 40: a busy machine drops 10 ms of audio now and then); a breath or
  // another note does.
  let note = null, t0 = 0, t1 = 0;
  const close = () => {
    if (note !== null && (!steady || t1 - t0 > steady.sec)) steady = { midi: note, sec: t1 - t0 };
    note = null;
  };
  for (const run of runs) {
    for (let i = run.from; i <= run.to; i++) {
      const p = points[i], n = Math.round(p.midi);
      if (p.midi < low) low = p.midi;
      if (p.midi > high) high = p.midi;
      if (note !== null && (n !== note || p.t - t1 > config.stage.maxJoinGapSec)) close();
      if (note === null) { note = n; t0 = p.t; }
      t1 = p.t;
    }
  }
  close();
  return {
    durSec: points[points.length - 1].t - points[0].t,
    lowMidi: Math.round(low), highMidi: Math.round(high), steady,
  };
}

export function factsText(facts, noteStyle = 'letters') {
  if (!facts) return 'No clear note was heard in that take.';
  const name = (m) => displayNote(m, noteStyle).text;
  const parts = [`Lowest note ${name(facts.lowMidi)}`, `Highest note ${name(facts.highMidi)}`];
  if (facts.steady) parts.push(`Steadiest note: ${name(facts.steady.midi)}, held ${facts.steady.sec.toFixed(1)} seconds`);
  return parts.join(' · ');
}

export function trimTake(points, keepSec) {
  if (!points.length) return [];
  const end = points[points.length - 1].t;
  const kept = points.filter((p) => end - p.t <= keepSec);
  const t0 = kept[0].t;
  return kept.map((p) => ({ ...p, t: p.t - t0 }));
}

export function packTake(points, hz) {
  const out = [];
  let lastT = -Infinity, lastVoiced = null;
  for (const p of points) {
    const voiced = Number.isFinite(p.midi);
    // An edge between sound and silence is always kept: thinning must not move a gap.
    // The small allowance keeps 60-a-second input from landing on either side of the
    // spacing by rounding error (which would keep every third point instead of every second).
    if (voiced === lastVoiced && p.t - lastT < 1 / hz - 1e-6) continue;
    out.push([Math.round(p.t * 1000) / 1000, voiced ? Math.round(p.midi * 100) / 100 : null]);
    lastT = p.t;
    lastVoiced = voiced;
  }
  return out;
}

export const TAKES_KEY = `${STORAGE_PREFIX}takes.v1`;

export function saveTake(storage, take, max = CONFIG.freesing.maxSavedTakes) {
  try {
    const list = JSON.parse(storage.getItem(TAKES_KEY) || '[]');
    const next = [...(Array.isArray(list) ? list : []), take].slice(-max);
    storage.setItem(TAKES_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- browser: the screen

export function audioSpan(rec, lineZeroSec, cutSec) {
  if (!rec || !Number.isFinite(rec.songStart) || !(rec.sampleRate > 0) || !(rec.length > 0)) return null;
  if (!Number.isFinite(lineZeroSec) || !Number.isFinite(cutSec)) return null;
  const startSec = rec.songStart - lineZeroSec - cutSec;
  return { startSec, endSec: startSec + rec.length / rec.sampleRate };
}

export function playPlan(span, fromSec, durSec) {
  if (!span) return null;
  const from = Math.max(0, fromSec);
  if (span.endSec <= from || span.startSec >= durSec) return null;
  return { offsetSec: Math.max(0, from - span.startSec), delaySec: Math.max(0, span.startSec - from) };
}

export function playbackGain(samples, { peak = 0.7, maxGain = 8 } = {}) {
  const top = peakOf(samples);
  return top > 0 ? Math.min(maxGain, peak / top) : 1;
}

// The song recorder wants a player for its clock. Free sing has no music: this stand-in is
// always "playing", its song time is the microphone context's own time, and it never ends
// (the recorder's maxSec still applies). One clock for the pitch frames and the sound means
// the line and the sound line up with no conversion.
function freeClock(ctx) {
  return {
    ctx,
    state: () => ({ duration: Infinity, status: 'playing', loop: false }),
    segmentAt: () => ({ songStart: 0, ctxStart: 0, ctxEnd: Infinity }),
    latency: () => ({ output: null, base: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : null }),
    on: () => () => {},
    play() {},
  };
}

const NOTE_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MIC_OFF_WHY = 'The microphone is off. Press Resume to turn it back on.';

// sessions: js/app/sessions.js createSessions(). A take that had singing in it is noted
// there as a finished exercise (no target, so plain facts only). Without it: not recorded.
export function mountFreeSing(view, { shell, micflow, settings, config = CONFIG, micOptions, storage, sessions = null, takes } = {}) {
  const F = config.freesing;
  let takeStore = takes;
  const soundStore = () => {
    if (takeStore === undefined) { try { takeStore = createTakeStore({ backend: idbBackend() }); } catch { takeStore = null; } }
    return takeStore;
  };
  // rec: the recorder of this take. sound: its finished recording { id, samples, sampleRate,
  // seconds, bytes, span, gain, kept }. play: what is sounding { ctx, src, t0, from }.
  let rec = null, soundRec = null, got = null, waiting = false, sound = null, soundWhy = '', play = null, playCtx = null, lineZero = null;
  const store = storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  const smallMq = window.matchMedia('(max-width: 639px), (max-height: 519px)');
  let mode = 'idle', targetMidi = null, facts = null, take = null, synth = null, tone = null;
  let tOffset = 0, lastT = null, rebase = true, octave = F.pickerStartOctave, cursor = null, sweep = 0, guardPaused = false, toneFrom = null;

  // ---- the page
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' } });
  const primaryWhy = h('p', { class: 'reason', id: 'sing-why' });
  const stopBtn = h('button', { class: 'btn btn-secondary', type: 'button', hidden: true, onclick: () => stop() }, 'Stop');
  const aimBtn = h('button', { class: 'btn btn-secondary', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'aim-panel' }, 'Aim for a note');
  const watchBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true }, icon('play', 16), ' Watch it again');
  const saveBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true }, 'Save this take');
  const saveWhy = h('p', { class: 'reason' });
  const playBtn = h('button', { class: 'btn btn-secondary free-play', type: 'button', hidden: true, 'aria-pressed': 'false' });
  const soundLine = h('p', { class: 'reason sound-line' });
  const factsLine = h('p', { class: 'facts', 'aria-live': 'polite' });
  const aimLine = h('p', { class: 'reason aim-line' });
  const strip = h('div', { class: 'note-strip', role: 'group', 'aria-label': 'Notes in this octave' });
  const lower = h('button', { class: 'btn btn-secondary btn-small', type: 'button' }, 'Lower notes');
  const higher = h('button', { class: 'btn btn-secondary btn-small', type: 'button' }, 'Higher notes');
  const playIt = h('button', { class: 'btn btn-secondary btn-small', type: 'button' }, icon('speaker', 16), ' Play it');
  const playWhy = h('p', { class: 'reason' });
  const clearBtn = h('button', { class: 'btn btn-quiet btn-small', type: 'button' }, 'Clear');
  const aimPanel = h('section', { class: 'card aim-panel', id: 'aim-panel', hidden: true, 'aria-label': 'Aim for a note' },
    // One row, so the panel stays above the fold at 1440 x 800; it wraps under about 1100 px.
    h('div', { class: 'aim-row' }, lower, strip, higher, playIt, clearBtn, playWhy));
  const bannerSlot = h('div');
  const viewHost = h('div');
  view.append(
    h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Free sing')),
    bannerSlot, viewHost, factsLine,
    h('div', { class: 'action-row' }, h('div', { class: 'action-main' }, primary, stopBtn, primaryWhy), aimBtn, aimLine, playBtn, watchBtn, saveBtn, saveWhy, soundLine),
    aimPanel);
  const pv = createPitchView(viewHost, { config });
  const unmountBanners = micflow.mountBanners(bannerSlot);

  const noteStyle = () => settings.get('noteNames');
  const keycap = () => h('kbd', { class: 'keycap' }, 'Space');
  const stageState = () => ({ idle: 'idle', starting: 'starting', live: 'live', paused: 'paused', lost: 'lost', tone: 'tone', review: 'review' })[mode];

  function paint() {
    const labels = { idle: 'Start', starting: 'Starting…', live: 'Stop', paused: 'Resume', lost: 'Stop', tone: 'Listen…', review: 'Start again' };
    const off = mode === 'starting' || mode === 'tone';
    primary.replaceChildren(labels[mode], off ? '' : ' ', off ? '' : keycap());
    primary.disabled = off;
    primaryWhy.textContent = mode === 'starting' ? 'Waiting for the microphone.' : mode === 'tone' ? 'The note is playing. The microphone waits until it ends.'
      : mode === 'paused' && !micflow.mic ? MIC_OFF_WHY : '';
    stopBtn.hidden = mode !== 'paused';
    const reviewing = mode === 'review' && !!take;
    saveBtn.hidden = !reviewing;
    saveBtn.disabled = waiting;                    // the sound's id is not known yet
    playBtn.hidden = !reviewing || !sound;
    watchBtn.hidden = !reviewing || !!sound;
    playBtn.replaceChildren(icon(play ? 'pause' : 'play', 16), play ? ' Pause' : ' Play');
    playBtn.setAttribute('aria-pressed', play ? 'true' : 'false');
    // Said quietly: a take with no sound (an old one, no room, or the recorder could not run).
    soundLine.textContent = !reviewing ? '' : sound ? (sound.span.endSec < facts.durSec - 1 ? 'The sound stops where you paused.' : '')
      : waiting ? 'Getting the sound ready…' : soundWhy || 'This take has no sound, only the line.';
    factsLine.textContent = mode === 'review' ? factsText(facts, noteStyle()) : '';
    aimLine.textContent = targetMidi === null ? '' : `Aiming for ${displayNote(targetMidi, noteStyle()).text}`;
    view.dataset.mode = mode;
  }

  function applyView(extra = {}) {
    pv.set({
      state: stageState(), noteStyle: noteStyle(), calm: shell.calm(),
      meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches,
      target: targetMidi === null ? null : { midi: targetMidi },
      nowFrac: config.stage.nowFracFree, ...extra,
    });
  }
  function setMode(next) {
    mode = next;
    paint();
    applyView();
  }

  // ---- the take
  const guard = async () => {
    const wasLive = mode === 'live';
    guardPaused = wasLive;
    const leave = await confirmSheet({ title: 'Stop this take? It won’t be saved.', yes: 'Stop', no: 'Keep singing' });
    // The sheet paused the take; "Keep singing" should mean exactly that.
    if (!leave && guardPaused && mode === 'paused') resume();
    guardPaused = false;
    return leave;
  };

  async function start() {
    if (mode !== 'idle' && mode !== 'review') return false;
    stopSweep();
    setMode('starting');
    const ok = await micflow.request(micOptions || {});
    if (mode !== 'starting') return false;       // left or destroyed while waiting
    if (!ok) { setMode('idle'); return false; }
    pv.clear();
    take = null; facts = null; lastT = null; tOffset = 0; rebase = true; lineZero = null;
    stopPlay(); dropSound();
    saveWhy.textContent = '';
    setMode('live');
    pv.stage.start();
    micflow.setListening(true);
    shell.setBusy(guard);
    startSound();
    return true;
  }

  // ---- the sound: recorded beside the line from the same press (see the contract)
  async function startSound() {
    const store = soundStore(), mic = micflow.mic;
    soundWhy = '';
    if (!store || !mic || !mic.ctx) return;
    const r = createRecorder({ micflow, player: freeClock(mic.ctx), store, title: 'Free sing', kind: 'free' });
    rec = soundRec = r;
    waiting = true;
    let settle;
    const drop = (why = '') => { if (rec === r) rec = null; soundWhy = why; r.destroy(); settle(null); };
    new Promise((done) => {
      settle = done;
      r.onTake(done);
      r.subscribe((st) => { if (st.status === 'idle' && !r.last) done(null); });
    }).then((t) => gotSound(t, r));
    // Never push an older take (a song's) out for a Free sing: record only when a full-length
    // take fits as things are.
    const room = await store.wouldRemove(Math.round(F.keepTakeSec * mic.ctx.sampleRate * 2));
    // Only while this same microphone is still on: the recorder asks micflow, and asked with
    // the microphone off that would open it again.
    if (rec !== r || micflow.mic !== mic || micflow.state().phase !== 'on' || !['live', 'tone'].includes(mode)) { drop(); return; }
    if (!room.fits || room.remove.length) { drop('No sound recorded: the space for takes is full.'); return; }
    const res = await r.start({ play: false });
    if (!res.ok) drop();
  }
  // The recording can end before the review (the first pause releases the microphone):
  // keep it until there is a line to place it on.
  function gotSound(t, r) {
    if (r !== soundRec) { if (t && t.saved && t.saved.ok) soundStore().remove(t.id); return; }
    waiting = false;
    got = t && t.saved && t.saved.ok ? t : null;
    placeSound();
  }
  function placeSound() {
    if (!got || mode !== 'review' || !take) { paint(); return; }
    const t = got;
    got = null;
    const span = audioSpan({ songStart: t.songStart, sampleRate: t.sampleRate, length: t.samples.length }, lineZero, take.cut || 0);
    if (!span || !playPlan(span, 0, facts.durSec)) { soundStore().remove(t.id); paint(); return; }
    sound = { id: t.id, samples: t.samples, sampleRate: t.sampleRate, seconds: t.seconds, bytes: t.saved.bytes, span, gain: playbackGain(t.samples), kept: false };
    paint();
  }
  // Starting again or leaving: an unsaved sound goes (only "Save this take" keeps it).
  function dropSound() {
    const r = rec;
    soundRec = null; rec = null; waiting = false;
    if (r) r.destroy();                           // its take arrives later and is removed (gotSound)
    if (got) soundStore().remove(got.id);
    if (sound && !sound.kept) soundStore().remove(sound.id);
    sound = null; got = null;
  }
  function stopPlay() {
    if (!play) return;
    const p = play;
    play = null;
    try { p.src.stop(); } catch { /* not started */ }
    p.src.disconnect();
    stopSweep();
    paint();
  }
  function startPlay() {
    if (!sound || play || mode !== 'review' || !take) return;
    stopSweep();
    let from = cursor !== null && cursor < facts.durSec - 0.25 ? cursor : 0;
    let plan = playPlan(sound.span, from, facts.durSec);
    if (!plan) { from = 0; plan = playPlan(sound.span, 0, facts.durSec); }
    // Made on this press (sound only after a user action) and kept for the next one.
    playCtx = playCtx && playCtx.state !== 'closed' ? playCtx : new AudioContext();
    if (playCtx.state === 'suspended') playCtx.resume().catch(() => {});
    const buf = playCtx.createBuffer(1, sound.samples.length, sound.sampleRate);
    buf.copyToChannel(sound.samples, 0);
    const src = playCtx.createBufferSource(), gain = playCtx.createGain();
    src.buffer = buf;
    gain.gain.value = sound.gain;
    src.connect(gain).connect(playCtx.destination);
    const t0 = playCtx.currentTime + 0.05;
    src.start(t0 + plan.delaySec, plan.offsetSec);
    play = { ctx: playCtx, src, t0, from };
    paint();
    // The playhead follows the sound's own clock, so the two cannot drift apart.
    const step = () => {
      if (!play) return;
      const sec = from + Math.max(0, playCtx.currentTime - t0);
      setCursor(sec);
      if (sec >= facts.durSec) { stopPlay(); return; }
      sweep = requestAnimationFrame(step);
    };
    sweep = requestAnimationFrame(step);
  }
  playBtn.addEventListener('click', () => (play ? stopPlay() : startPlay()));

  function stop() {
    if (!['live', 'paused', 'lost', 'tone'].includes(mode)) return;
    if (tone) tone.stop();
    if (rec) { rec.stop('stop'); rec = null; }      // releases the microphone in this turn too
    micflow.stop();
    shell.setBusy(null);
    pv.stage.stop();
    const all = pv.stage.points();
    // The home replays this as an aurora on the next return (page-layout S4); under 3 s of
    // pitched singing glowSamples says null and nothing is kept.
    keepGlow(glowSamples(all), { free: true });
    const pts = trimTake(all, F.keepTakeSec);
    facts = takeFacts(pts, config);
    take = facts ? pts : null;
    // What trimming cut off the front, so the sound can be placed on the kept line.
    if (take) take.cut = all[all.length - 1].t - pts[pts.length - 1].t;
    if (sessions && facts) {
      sessions.result('freesing', { sec: facts.durSec, facts: { lowMidi: facts.lowMidi, highMidi: facts.highMidi, steadyMidi: facts.steady ? facts.steady.midi : null, steadySec: facts.steady ? facts.steady.sec : null } });
    }
    mode = 'review';
    paint();
    if (take) {
      applyView();
      pv.stage.showTake(take);
      placeSound();
    } else {
      dropSound();
      // Nothing to review: say so and offer the start again, rather than an empty chart.
      mode = 'idle';
      pv.clear();
      applyView();
      factsLine.textContent = factsText(null);
      primary.replaceChildren('Start ', keycap());
      view.dataset.mode = mode;
    }
    primary.focus();
  }

  // Paused means the microphone is off (owner rule 2026-10-12): Esc, any sheet, the page
  // hidden or left all release it, every track ended, as Find your range does. Until
  // 2026-10-12 Esc and a sheet only stopped the listening and left the microphone open
  // behind a screen that said "Paused". The take is kept; Resume opens it again.
  // The drawing loop rests too, after the curtain of light has eased out (stopped at once,
  // it went in one frame): a paused picture is one still frame.
  // One sheet needs the microphone: the mic flow's own level check ('checking'), which the
  // singer opened with "Test the mic". Released at once, that sheet stood open with a dead
  // level bar. The take still pauses, and the microphone goes when the sheet closes (onSheet).
  let restTimer = 0;
  const REST_MS = ((config.aurora && config.aurora.cutFadeMs) || 600) + 150;
  const rest = () => {
    clearTimeout(restTimer);
    restTimer = setTimeout(() => { if (mode === 'paused') pv.stage.stop(); }, REST_MS);
  };
  function pause() {
    if (mode !== 'live') return;
    micflow.setListening(false);
    if (micflow.mic && micflow.state().phase !== 'checking') micflow.stop();
    setMode('paused');
    rest();
  }
  // Only ever reached from a press (the button, Space, the paused card, "Keep singing"),
  // so it may open the microphone again.
  async function resume() {
    if (mode !== 'paused') return;
    clearTimeout(restTimer);
    if (!micflow.mic) {
      setMode('starting');
      const ok = await micflow.request(micOptions || {});
      if (mode !== 'starting') return;           // left or destroyed while waiting
      if (!ok) { setMode('paused'); rest(); return; }
      rebase = true;                             // a reopened microphone starts its clock again
    }
    micflow.setListening(true);
    setMode('live');
    pv.stage.start();
  }

  const offFrame = micflow.onFrame((frame, level) => {
    if (mode !== 'live') return;
    // Each time the microphone is opened its clock starts again; a take must not run
    // backwards, so later readings are shifted to follow the last one (with a visible gap).
    if (rebase) { tOffset = lastT === null ? -frame.t : lastT + 0.5 - frame.t; rebase = false; }
    if (lineZero === null) lineZero = frame.t;   // the microphone-clock time of line time 0
    const t = frame.t + tOffset;
    lastT = t;
    pv.push({ ...frame, t }, level);
  });
  const offState = micflow.subscribe((s) => {
    if (s.phase === 'lost' && (mode === 'live' || mode === 'paused')) setMode('lost');
    else if (mode === 'paused') paint();         // "The microphone is off" follows the microphone
    else if (s.phase === 'on' && mode === 'lost') { rebase = true; micflow.setListening(true); setMode('live'); pv.stage.start(); }
  });

  primary.addEventListener('click', () => {
    if (mode === 'idle' || mode === 'review') start();
    else if (mode === 'paused') resume();
    else stop();
  });
  pv.stage.onResume(resume);

  // ---- aim for a note
  function paintStrip() {
    const base = (octave + 1) * 12;
    strip.replaceChildren(...NOTE_OFFSETS.map((o) => {
      const midi = base + o, inRange = midi >= F.pickerLowMidi && midi <= F.pickerHighMidi;
      const name = displayNote(midi, noteStyle());
      return h('button', {
        class: 'note-key', type: 'button', 'aria-pressed': String(midi === targetMidi), disabled: !inRange,
        onclick: () => setTarget(midi),
        // The octave digit at the full text size ("La3", as the gutter writes it): as a
        // subscript it measured under 8 px.
      }, name.text);
    }));
    lower.disabled = base - 1 < F.pickerLowMidi;
    higher.disabled = base + 12 > F.pickerHighMidi;
    playIt.disabled = targetMidi === null;
    clearBtn.disabled = targetMidi === null;
    playWhy.textContent = targetMidi === null ? 'Pick a note first.' : '';
  }
  function setTarget(midi) {
    targetMidi = midi;
    paintStrip();
    paint();
    if (mode === 'review' && take) return;        // the take on show keeps its own colours
    applyView();
  }
  aimBtn.addEventListener('click', () => {
    aimPanel.hidden = !aimPanel.hidden;
    aimBtn.setAttribute('aria-expanded', String(!aimPanel.hidden));
    if (aimPanel.hidden) return;
    paintStrip();
    // In a short window the panel opens below the fold: bring it into view, calmly.
    aimPanel.scrollIntoView({ block: 'nearest', behavior: shell.calm() ? 'auto' : 'smooth' });
  });
  lower.addEventListener('click', () => { octave--; paintStrip(); });
  higher.addEventListener('click', () => { octave++; paintStrip(); });
  clearBtn.addEventListener('click', () => setTarget(null));
  playIt.addEventListener('click', () => {
    if (targetMidi === null || tone) return;
    const before = mode;
    if (!['idle', 'live', 'review'].includes(before)) return;
    toneFrom = before;
    synth = synth || createSynth();
    // The microphone is not scored while the note sounds (spec 10.4): without headphones
    // it would hear the speaker and the line would follow the tone, not the singer.
    if (before === 'live') micflow.setListening(false);
    mode = 'tone';
    paint();
    if (before === 'review') pv.stage.set({ state: 'tone', target: { midi: targetMidi } }); else applyView();
    pv.stage.start();
    tone = synth.play({ midi: targetMidi, dur: F.toneSec, timbre: timbreFor(settings.get('tone')), gain: 0.5 * settings.get('toneVolume') });
    tone.ended.then(() => new Promise((r) => setTimeout(r, F.toneTailMs))).then(() => {
      tone = null;
      if (mode !== 'tone') return;
      mode = before;
      paint();
      if (before === 'live') { micflow.setListening(true); applyView(); return; }
      pv.stage.stop();
      if (before === 'review' && take) pv.stage.showTake(take); else applyView();
    });
  });

  // ---- review: scrub, watch again, save
  function setCursor(sec) {
    if (mode !== 'review' || !take) return;
    cursor = Math.max(0, Math.min(facts.durSec, sec));
    pv.stage.set({ cursor });
  }
  function stopSweep() { if (sweep) cancelAnimationFrame(sweep); sweep = 0; }
  pv.stage.el.addEventListener('mousemove', (e) => {
    if (mode !== 'review' || !take || sweep) return;
    const r = pv.stage.el.getBoundingClientRect(), plotW = r.width - config.stage.gutterPx;
    setCursor(((e.clientX - r.left - config.stage.gutterPx) / plotW) * facts.durSec);
  });
  watchBtn.addEventListener('click', () => {
    stopPlay();
    stopSweep();
    const t0 = performance.now();
    const step = (ms) => {
      const sec = (ms - t0) / 1000;
      setCursor(sec);
      sweep = sec < facts.durSec && mode === 'review' ? requestAnimationFrame(step) : 0;
    };
    sweep = requestAnimationFrame(step);
  });
  saveBtn.addEventListener('click', () => {
    if (!take) return;
    const ok = !!store && saveTake(store, {
      id: `free-${Date.now()}`, savedAt: new Date().toISOString(), kind: 'free', targetMidi,
      cleanupWasOn: micflow.cleanupWasOn(), facts, points: packTake(take, F.playbackHz),
      audioId: sound ? sound.id : null, audioStartSec: sound ? Number(sound.span.startSec.toFixed(3)) : null,
    }, F.maxSavedTakes);
    if (ok && sound) sound.kept = true;
    if (ok) { toast('Saved'); saveBtn.hidden = true; saveWhy.textContent = ''; } else saveWhy.textContent = 'Could not save: this browser’s storage is full or blocked.';
  });

  // ---- keys, pauses, settings
  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    // Esc pauses whatever is sounding: a reference note over a live take has the microphone
    // open too, and until 2026-10-12 the first Esc did nothing there.
    if (e.key === 'Escape') stopPlay();          // the review's playback stops too
    if (e.key === 'Escape') { endToneOverTake(); if (mode === 'live') { pause(); primary.focus(); } }
    if (mode === 'review' && take && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const t = e.target;
      // Arrow keys belong to a focused switch or slider first.
      if (t instanceof HTMLElement && (t.closest('[role="radiogroup"]') || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      e.preventDefault();
      stopPlay();
      stopSweep();
      setCursor((cursor ?? 0) + (e.key === 'ArrowRight' ? 1 : -1));
    }
  };
  // A reference note over a live take: end it now, or its ending would switch listening
  // back on behind a sheet, or with no microphone.
  const endToneOverTake = () => { if (mode === 'tone' && toneFrom === 'live') { if (tone) tone.stop(); mode = 'live'; } };
  // Was the microphone still open when the first sheet came up (the level check keeps it)?
  // Sheets stack, and one closing over another fires 'open' again: only the first counts.
  let sheetUp = false, micOverSheet = false;
  const onSheet = (e) => {
    if (e.detail.open) { endToneOverTake(); pause(); if (!sheetUp) micOverSheet = !!micflow.mic; sheetUp = true; return; }
    sheetUp = false;
    // The level check is over: paused means the microphone is off. Not when the singer turned
    // it on in that sheet (Settings > Turn on microphone): that press asked for it (bugs.md 80).
    if (mode === 'paused' && micflow.mic && micOverSheet) micflow.stop();
    micOverSheet = false;
  };
  // Hidden or left: the take waits, paused, and only a press on Resume opens the
  // microphone again (bugs.md 31).
  const onHidden = (e) => {
    if (e.type === 'visibilitychange' && !document.hidden) return;
    stopPlay();
    endToneOverTake();
    pause();
  };
  const onCalm = () => applyView();
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  smallMq.addEventListener('change', onCalm);
  const offSettings = settings.subscribe((k) => {
    if (k === 'noteNames' || k === 'pitchView') { paint(); if (!aimPanel.hidden) paintStrip(); if (mode !== 'review' || !take) applyView(); else pv.set({ noteStyle: noteStyle(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); }
  });

  setMode('idle');

  return {
    start, stop,
    state: () => ({
      mode, targetMidi, facts, playing: !!play, cursor,
      sound: sound ? { seconds: sound.seconds, bytes: sound.bytes, startSec: sound.span.startSec, endSec: sound.span.endSec } : null,
    }),
    setTarget,
    view: pv,
    destroy() {
      stopPlay();
      dropSound();
      if (playCtx) playCtx.close().catch(() => {});
      stopSweep();
      clearTimeout(restTimer);
      if (tone) tone.stop();
      if (mode !== 'idle' && mode !== 'review') micflow.stop();
      mode = 'idle';
      // The shell reuses this element for the next screen: leave nothing of ours on it.
      delete view.dataset.mode;
      shell.setBusy(null);
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      smallMq.removeEventListener('change', onCalm);
      if (synth) synth.ctx.close().catch(() => {});
      pv.destroy();
    },
  };
}
