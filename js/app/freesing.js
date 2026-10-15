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
//       anything.
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

import { createSynth, timbreFor } from '../synth.js';
import { CONFIG } from './config.js';
import { createPitchView } from './hud.js';
import { confirmSheet, h, icon, STORAGE_PREFIX, toast } from './shell.js';
import { displayNote, segmentRuns } from './stage.js';

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

const NOTE_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MIC_OFF_WHY = 'The microphone is off. Press Resume to turn it back on.';

// sessions: js/app/sessions.js createSessions(). A take that had singing in it is noted
// there as a finished exercise (no target, so plain facts only). Without it: not recorded.
export function mountFreeSing(view, { shell, micflow, settings, config = CONFIG, micOptions, storage, sessions = null } = {}) {
  const F = config.freesing;
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
    h('div', { class: 'title-row' }, h('a', { class: 'btn btn-quiet back', href: '#/today' }, icon('back', 16), ' Back'), h('h1', { tabindex: '-1' }, 'Free sing')),
    bannerSlot, viewHost, factsLine,
    h('div', { class: 'action-row' }, h('div', { class: 'action-main' }, primary, stopBtn, primaryWhy), aimBtn, aimLine, watchBtn, saveBtn, saveWhy),
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
    watchBtn.hidden = !reviewing;
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
    take = null; facts = null; lastT = null; tOffset = 0; rebase = true;
    saveWhy.textContent = '';
    setMode('live');
    pv.stage.start();
    micflow.setListening(true);
    shell.setBusy(guard);
    return true;
  }

  function stop() {
    if (!['live', 'paused', 'lost', 'tone'].includes(mode)) return;
    if (tone) tone.stop();
    micflow.stop();
    shell.setBusy(null);
    pv.stage.stop();
    const pts = trimTake(pv.stage.points(), F.keepTakeSec);
    facts = takeFacts(pts, config);
    take = facts ? pts : null;
    if (sessions && facts) {
      sessions.result('freesing', { sec: facts.durSec, facts: { lowMidi: facts.lowMidi, highMidi: facts.highMidi, steadyMidi: facts.steady ? facts.steady.midi : null, steadySec: facts.steady ? facts.steady.sec : null } });
    }
    mode = 'review';
    paint();
    if (take) {
      applyView();
      pv.stage.showTake(take);
    } else {
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
    }, F.maxSavedTakes);
    if (ok) { toast('Saved'); saveBtn.hidden = true; saveWhy.textContent = ''; } else saveWhy.textContent = 'Could not save: this browser’s storage is full or blocked.';
  });

  // ---- keys, pauses, settings
  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    // Esc pauses whatever is sounding: a reference note over a live take has the microphone
    // open too, and until 2026-10-12 the first Esc did nothing there.
    if (e.key === 'Escape') { endToneOverTake(); if (mode === 'live') { pause(); primary.focus(); } }
    if (mode === 'review' && take && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const t = e.target;
      // Arrow keys belong to a focused switch or slider first.
      if (t instanceof HTMLElement && (t.closest('[role="radiogroup"]') || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      e.preventDefault();
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
    state: () => ({ mode, targetMidi, facts }),
    setTarget,
    view: pv,
    destroy() {
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
