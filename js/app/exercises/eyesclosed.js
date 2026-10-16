// eyesclosed.js — Eyes closed, #/practice/eyes-closed: hear a note with the band in view, then
// a curtain covers the picture and the singer sings the note blind; when the take ends the
// curtain lifts and the recorded line draws itself in over the band, then the verdict
// (docs/design/specs/2026-10-12-singing-trainer.md section 7.6; PLAN.md "Eyes-closed rounds").
// Skill learned with the picture can fade without it, so this measures the singing alone.
//
// The top half is PURE and imports in Node (tools/checks/eyesclosed.check.mjs). It reuses
// Match and hold's targets and Space rule (js/app/exercises/matchhold.js) without changing them.
//
// CONTRACT — pure
//   EYES_DEFAULTS, eyesConfig(config?) -> the numbers below, config.eyesClosed over the defaults
//       (config.js has no eyesClosed block yet: every number is a GUESS until the owner sings it)
//   createTakeWatch(cfg?) -> { push({ t, voiced }) -> { sungSec, quietSec, started, end }, reset() }
//       t in seconds (any origin, never backwards). end: null | 'cap' (singCapSec after the
//       first voiced reading) | 'silence' (silenceEndSec with no voice after singing) |
//       'nothing' (giveUpSec and no voice at all)
//   scoreTake(frames, targetMidi, config?) -> { sungSec, inSec, inPct, meanCents, dir, kind, star, points }
//       frames [{ t, midi, voiced }]. Each voiced reading counts for the time to the next one
//       (at most maxDtSec). inPct: % of voiced readings within verdict.inTuneCents (the same
//       rule as sessions.js NoteRec.in25, so the compare strip compares like with like).
//       meanCents: mean signed cents over readings within verdict.farCents, or null.
//       kind 'none' (under minSungSec sung) | 'in' (inPct >= inPct) | 'close' (|mean| <=
//       verdict.closeCents) | 'off'. star: not 'none' and inSec >= starInSec.
//       points [{ t (from the first frame), midi | null, kind }] for the reveal picture.
//   revealWords(score, config?) -> { kind, icon, head, line }   never a failure word
//   revealGeometry({ points, targetMidi, width, height, config? }) -> stage.js layout() + { xOf(t), dur }
//       The whole take fitted to the width, and the target ALWAYS in view (stage.showTake fits
//       the voice only: a blind take a few notes off would lose the band it is judged against).
//   lineShare(sessionsData) -> % in tune of the newest Match and hold take, or null
//   compareWords(linePct | null, blindPct | null) -> null | { line, blind, note }
//   EYES_KEY 'music-trainer.eyesclosed.v1' -> { notes, stars, rounds }
//   addNote(prev, { star }) -> { record, firstStar }   addRound(prev) -> record
//   createBlindRound(targetMidis) -> round
//       round.state() -> { phase, index, count, stars, targetMidi }
//       phase 'ready' | 'listen' | 'take' | 'ended' | 'reveal' | 'done'
//       start() ready->listen · toneEnded() listen->take · takeEnded() take->ended ·
//       reveal(star) ended->reveal · next() reveal->listen | done · skip() listen|take|ended->
//       next listen | done · replay() take|ended->listen · stop() -> done · again() done->ready.
//       A call that does not fit the phase changes nothing.
//
// CONTRACT — mountEyesClosed(view, { shell, micflow, settings, config?, micOptions?, storage?,
//                                    synth?, range?, sessions? }) -> screen      [browser]
//   shell needs: needHeadphones(), headphones(), calm(), setBusy()
//   range       { lowMidi, highMidi, home? } (js/app/range.js exerciseRange), as Match and hold
//   sessions    each round is filed as one take (sessions.take('eyesclosed')). NOTE: sessions.js
//               does not list 'eyesclosed' yet, so the take is written but dropped on reading
//               (the day still counts). A one-word change there; not this file's to make.
//   screen.start() -> Promise<boolean>, finishTake(), reveal(), next(), skip(), stop(), again(),
//          pause(), resume(), state() -> round.state() + { paused, curtain, score, results,
//          blindPct, linePct }, view (js/app/hud.js), destroy()
//   The microphone opens only from a press (Start, Resume) and is released on round done,
//   Stop, Esc, any sheet, a hidden page, pagehide and leaving. It is listened to only while
//   the curtain is down. No verdict, note name, number or line is shown or announced while
//   the curtain is down; the mic level bar stays (proof it is listening). The reveal is announced.
//   Events: 'mt:exercise' on document, detail { exercise: 'eyesclosed', event, ...state() }.
//       event: start | listen | blind (curtain down, listening) | ended (detail.why) |
//              reveal | revealed (line drawn, verdict up) | skip | paused | done
//
// Not built here: the Blind switch on Match and hold / Four-note patterns, the intro card.

import { createSynth, timbreFor } from '../../synth.js';
import { CONFIG } from '../config.js';
import { createPitchView } from '../hud.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { canChime, playChime, starSvg } from '../rewards.js';
import { confirmSheet, h, icon, sheetOpen, STORAGE_PREFIX } from '../shell.js';
import { displayNote, lanesFor, layout, verdict, voicePieces } from '../stage.js';
import { isLightColour } from '../aurora.js';
import { roundTargets, spaceActs } from './matchhold.js';

// ---------------------------------------------------------------- pure

export const EYES_DEFAULTS = Object.freeze({
  notes: 3,               // spec 7.6: its own exercise, 3 notes
  curtainMs: 600,         // spec: the curtain wipes down / lifts over 600 ms
  calmFadeMs: 200,        // spec: calm motion, a 200 ms fade
  singCapSec: 6,          // spec: the take ends after 6 s of singing
  silenceEndSec: 3,       // spec: ...or 3 s of silence after singing
  giveUpSec: 12,          // GUESS. Nothing sung at all: the take ends (the microphone is not left listening)
  minSungSec: 0.4,        // GUESS. Less voice than this: "nothing heard", not a verdict
  maxDtSec: 0.1,          // a reading never counts for more than this (a dropped frame is not singing)
  revealDrawMs: 1200,     // spec: the line draws itself in over 1.2 s
  inPct: 60,              // GUESS. This share of readings in tune: "In tune"
  starInSec: 1.5,         // GUESS. In tune this long (any order): the note's star
  padSemis: 1.5,          // the reveal shows this much above and below the target and the line
  doneGapSec: 0.18,       // the soft two-note "done" sound (headphones only)
  doneNoteSec: 0.28,
});
export const eyesConfig = (config = CONFIG) => ({ ...EYES_DEFAULTS, ...((config && config.eyesClosed) || {}) });

export function createTakeWatch(cfg = EYES_DEFAULTS) {
  let t0 = null, first = null, lastVoiced = null, sung = 0, prevT = null, prevVoiced = false;
  return {
    push({ t, voiced }) {
      if (t0 === null) t0 = t;
      if (prevT !== null && prevVoiced) sung += Math.min(cfg.maxDtSec, Math.max(0, t - prevT));
      prevT = t; prevVoiced = !!voiced;
      if (voiced) { if (first === null) first = t; lastVoiced = t; }
      const end = first === null ? (t - t0 >= cfg.giveUpSec ? 'nothing' : null)
        : t - first >= cfg.singCapSec ? 'cap'
          : t - lastVoiced >= cfg.silenceEndSec ? 'silence' : null;
      return { sungSec: sung, quietSec: t - (lastVoiced ?? t0), started: first !== null, end };
    },
    reset() { t0 = null; first = null; lastVoiced = null; sung = 0; prevT = null; prevVoiced = false; },
  };
}

export function scoreTake(frames, targetMidi, config = CONFIG) {
  const E = eyesConfig(config), V = config.verdict;
  const list = Array.isArray(frames) ? frames : [];
  const t0 = list.length ? list[0].t : 0;
  let sungSec = 0, inSec = 0, nVoiced = 0, nIn = 0, sum = 0, n = 0;
  const points = [], allCents = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i], next = list[i + 1];
    const t = f.t - t0;
    if (!f.voiced || !Number.isFinite(f.midi)) { points.push({ t, midi: null, kind: null }); continue; }
    const dt = next ? Math.min(E.maxDtSec, Math.max(0, next.t - f.t)) : 0;
    const cents = 100 * (f.midi - targetMidi);
    nVoiced++; sungSec += dt; allCents.push(cents);
    if (Math.abs(cents) <= V.inTuneCents) { nIn++; inSec += dt; }
    if (Math.abs(cents) <= V.farCents) { sum += cents; n++; }
    points.push({ t, midi: f.midi, kind: verdict(cents, V).kind });
  }
  const meanCents = n ? sum / n : null;
  const inPct = nVoiced ? Math.round((100 * nIn) / nVoiced) : null;
  const lean = meanCents ?? (allCents.length ? allCents.sort((a, b) => a - b)[allCents.length >> 1] : 0);
  const kind = sungSec < E.minSungSec ? 'none' : inPct >= E.inPct ? 'in' : meanCents !== null && Math.abs(meanCents) <= V.closeCents ? 'close' : 'off';
  return { sungSec, inSec, inPct, meanCents, dir: lean < 0 ? 'low' : 'high', kind, star: kind !== 'none' && inSec >= E.starInSec, points };
}

const sec1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

export function revealWords(score, config = CONFIG) {
  if (!score || score.kind === 'none') {
    return { kind: 'none', icon: 'dots', head: 'Nothing heard that time', line: 'Sing a steady ‘ah’ while the curtain is down. Press Space when you’ve finished.' };
  }
  const m = score.meanCents;
  const avg = m === null ? 'mostly more than a note away'
    : Math.abs(Math.round(m)) === 0 ? 'right on the note on average'
      : `on average ${Math.abs(Math.round(m))} cents ${m < 0 ? 'low' : 'high'}`;
  const line = `In tune for ${sec1(score.inSec)} of ${sec1(score.sungSec)} seconds · ${avg}`;
  if (score.kind === 'in') return { kind: 'in', icon: 'tick', head: 'In tune', line };
  if (score.kind === 'close') return { kind: 'close', icon: 'wave', head: `Close: a little ${score.dir}`, line };
  return { kind: 'off', icon: score.dir === 'low' ? 'arrow-up' : 'arrow-down', head: score.dir === 'low' ? 'Below the note this time' : 'Above the note this time', line };
}

export function revealGeometry({ points = [], targetMidi, width, height, config = CONFIG }) {
  const E = eyesConfig(config), C = config.stage;
  const voiced = points.filter((p) => Number.isFinite(p.midi)).map((p) => p.midi);
  const low = Math.min(targetMidi, ...voiced) - E.padSemis, high = Math.max(targetMidi, ...voiced) + E.padSemis;
  const lanes = lanesFor({ wide: true, lowMidi: low, highMidi: high }, { ...C, widePadSemis: 0 });
  // Wider than the widest view: the target stays in the middle and the far ends are cut off.
  const fits = Math.ceil(high) - Math.floor(low) + 1 <= lanes;
  const dur = Math.max(0.5, points.length ? points[points.length - 1].t : 0);
  const plotW = Math.max(1, width - C.gutterPx);
  const L = layout({ width, height, lanes, centreMidi: fits ? (low + high) / 2 : targetMidi, nowFrac: 1, pxPerSec: plotW / dur, gutter: C.gutterPx });
  return { ...L, dur, xOf: (t) => L.plotX + t * L.pxPerSec };
}

export function lineShare(data) {
  const sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
  for (let i = sessions.length - 1; i >= 0; i--) {
    const takes = sessions[i].takes || [];
    for (let j = takes.length - 1; j >= 0; j--) {
      const t = takes[j];
      if (t.exercise !== 'matchhold') continue;
      let w = 0, s = 0;
      for (const nr of t.notes || []) if (Number.isFinite(nr.in25) && nr.sung > 0) { w += nr.sung; s += nr.in25 * nr.sung; }
      if (w > 0) return Math.round(s / w);
    }
  }
  return null;
}

export function compareWords(linePct, blindPct) {
  if (!Number.isFinite(linePct) || !Number.isFinite(blindPct)) return null;
  return {
    line: `With the line: ${linePct} % in tune`,
    blind: `Eyes closed: ${blindPct} % in tune`,
    // The spec's one line is for a gap; with none, it would explain something that is not there.
    note: blindPct >= linePct ? 'As good as with the line. Your ear is doing the work.' : 'The gap is normal. It shrinks with practice.',
  };
}

export const EYES_KEY = `${STORAGE_PREFIX}eyesclosed.v1`;
const cnt = (x) => (Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);
export function addNote(prev, { star = false } = {}) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const stars = cnt(p.stars);
  return { record: { notes: cnt(p.notes) + 1, stars: stars + (star ? 1 : 0), rounds: cnt(p.rounds) }, firstStar: !!star && stars === 0 };
}
export function addRound(prev) {
  const p = prev && typeof prev === 'object' ? prev : {};
  return { notes: cnt(p.notes), stars: cnt(p.stars), rounds: cnt(p.rounds) + 1 };
}

export function createBlindRound(targetMidis) {
  const count = targetMidis.length;
  let phase = 'ready', index = 0, stars = targetMidis.map(() => false);
  const state = () => ({ phase, index, count, stars: [...stars], targetMidi: targetMidis[index] });
  const advance = () => { if (index + 1 < count) { index++; phase = 'listen'; } else phase = 'done'; };
  return {
    state,
    start() { if (phase === 'ready' && count) phase = 'listen'; return state(); },
    toneEnded() { if (phase === 'listen') phase = 'take'; return state(); },
    takeEnded() { if (phase === 'take') phase = 'ended'; return state(); },
    reveal(star) { if (phase === 'ended') { stars[index] = !!star; phase = 'reveal'; } return state(); },
    next() { if (phase === 'reveal') advance(); return state(); },
    skip() { if (phase === 'listen' || phase === 'take' || phase === 'ended') advance(); return state(); },
    replay() { if (phase === 'take' || phase === 'ended') phase = 'listen'; return state(); },
    stop() { if (phase !== 'ready') phase = 'done'; return state(); },
    again() { if (phase === 'done') { phase = 'ready'; index = 0; stars = targetMidis.map(() => false); } return state(); },
  };
}

export const EYES_WORDS = Object.freeze({
  what: 'Hear a note, then close your eyes and sing it. Open them to see your line against the note.',
  curtain: 'Close your eyes and sing the note. Press Space when you’ve finished.',
  open: 'Done. Open your eyes.',
  listening: 'Eyes closed. The microphone is listening; the level bar shows it hears you.',
  micWhen: 'The microphone turns on when you press Start, and off when the round ends.',
});

const PHASE_CHIP = Object.freeze({
  ready: { word: 'Ready', icon: 'play' }, listen: { word: 'Listen', icon: 'speaker' },
  take: { word: 'Eyes closed', icon: 'mic' }, ended: { word: 'Done', icon: 'tick' },
  reveal: { word: 'Your line', icon: 'chart' }, paused: { word: 'Paused', icon: 'pause' }, done: { word: 'Round done', icon: 'star' },
});

// ---------------------------------------------------------------- browser: the screen

const SVG_NS = 'http://www.w3.org/2000/svg';
// A closed eye: the lid's curve and four lashes (shell.js ICONS has no eye, and that file is not
// this screen's to change). Drawn in currentColor like the other icons.
function closedEye(size = 96) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'ec-eye', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3 10c2.5 3.6 5.6 5.4 9 5.4s6.5-1.8 9-5.4M6.2 13.6l-1.5 2M10 15.2l-.5 2.4M14 15.2l.5 2.4M17.8 13.6l1.5 2');
  svg.append(path);
  return svg;
}

export function mountEyesClosed(view, {
  shell, micflow, settings, config = CONFIG, micOptions, storage, synth: givenSynth = null, range = {}, sessions = null,
} = {}) {
  const E = eyesConfig(config), M = config.matchhold, R = config.rewards;
  const store = storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  const smallMq = window.matchMedia('(max-width: 639px), (max-height: 519px)');
  const targets = roundTargets({ ...range, count: E.notes }, config).map((tl) => tl.notes[0].midi);
  const round = createBlindRound(targets);
  const watch = createTakeWatch(E);
  const levelEvery = createEvery(1000 / 30);

  let synth = givenSynth, tone = null, seq = 0, dead = false, starting = false, reopening = false, paused = false;
  let why = '', waitWhy = '', underKey = null, curtain = 'up', curtainText = EYES_WORDS.curtain;
  let frames = [], tOffset = 0, rebase = true, score = null, results = [], backstop = null, drawId = 0;
  let rec = null, recT = 0, recAny = false, linePct = null;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };
  const calm = () => !!shell.calm() || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const curtainMs = () => (calm() ? E.calmFadeMs : E.curtainMs);

  // ---- the page
  const stepText = h('p', { class: 'ex-step' });
  const tray = h('ol', { class: 'star-tray' });
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, 'aria-describedby': 'eyes-why' });
  const primaryWhy = h('p', { class: 'reason', id: 'eyes-why' });
  const skipBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true, onclick: () => skip() }, 'Skip');
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const bannerSlot = h('div'), viewHost = h('div');
  const card = h('section', { class: 'ec-card', 'aria-label': 'Your blind note', dataset: { shown: 'no' } });
  const compare = h('div', { class: 'ec-compare', dataset: { shown: 'no' } });
  // The reveal is announced; nothing is while the curtain is down.
  const spoken = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  view.classList.add('exercise', 'eyes-closed');
  view.append(
    h('div', { class: 'title-row ex-head' },
      h('h1', { tabindex: '-1' }, 'Eyes closed'), stepText, tray),
    h('p', { class: 'reason' }, EYES_WORDS.what),
    bannerSlot, viewHost, underLine, h('div', { class: 'ec-slot' }, card, compare), spoken,
    h('div', { class: 'action-row' }, skipBtn, h('div', { class: 'action-main' }, primary, primaryWhy)));
  const pv = createPitchView(viewHost, { config: { ...config, stage: { ...config.stage, recentreMaxSemisPerSec: M.recentreMaxSemisPerSec } } });
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });
  const main = pv.el.querySelector('.pitch-main');
  const hudParts = [...pv.hud.el.children].filter((el) => !el.classList.contains('level'));

  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const phaseChip = h('div', { class: 'chip phase-chip', dataset: { role: 'quiet' } }, chipIcon, chipWord);
  pv.stage.el.append(h('div', { class: 'stage-chips' }, phaseChip));
  // The reveal picture: its own canvas over the stage, so the fitted view can always include
  // the target and the line can be drawn in from the left (stage.showTake can do neither).
  const plate = h('canvas', { class: 'ec-plate', dataset: { shown: 'no' }, 'aria-hidden': 'true' });
  pv.stage.el.append(plate);
  // The curtain covers the stage (and the meter-only view) as one piece.
  const curtainWords = h('p', { class: 'ec-curtain-text' });
  const curtainEl = h('div', { class: 'ec-curtain', dataset: { state: 'up' } }, closedEye(), curtainWords);
  main.append(curtainEl);

  const keycap = (k = 'Space') => h('kbd', { class: 'keycap' }, k);
  const blindPct = () => {
    let w = 0, s = 0;
    for (const r of results) if (r && r.inPct !== null && r.sungSec > 0) { w += r.sungSec; s += r.inPct * r.sungSec; }
    return w > 0 ? Math.round(s / w) : null;
  };
  const snapshot = () => ({ ...round.state(), paused, curtain, score, results: [...results], blindPct: blindPct(), linePct });
  const emit = (event, more) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: 'eyesclosed', event, ...snapshot(), ...more } }));

  function paintTray() {
    const s = round.state();
    tray.setAttribute('aria-label', `${s.stars.filter(Boolean).length} of ${s.count} stars`);
    while (tray.children.length < s.count) tray.append(h('li', { class: 'tray-star' }));
    s.stars.forEach((on, i) => {
      const li = tray.children[i];
      if (li.hasAttribute('data-earned') === on && li.firstChild) return;
      li.toggleAttribute('data-earned', on);
      li.dataset.look = on ? 'held' : '';
      li.setAttribute('aria-label', `Star ${i + 1} of ${s.count}${on ? ': in tune' : ''}`);
      li.replaceChildren(starSvg('held', R.trayStarPx), on ? icon('tick', 10) : '');
    });
  }

  function paint() {
    const s = round.state();
    const phase = paused ? 'paused' : s.phase;
    const chip = PHASE_CHIP[phase];
    chipIcon.replaceChildren(icon(chip.icon, 16));
    chipWord.textContent = chip.word;
    stepText.textContent = s.phase === 'done' ? 'Round done' : `Note ${s.index + 1} of ${s.count}`;
    const busy = starting || reopening;
    const last = s.index + 1 === s.count;
    const label = busy ? 'Starting…' : { ready: 'Start', listen: 'Listening…', take: 'Done', ended: 'Show me', reveal: last ? 'Finish' : 'Next', paused: 'Resume', done: '' }[phase];
    const off = busy || phase === 'listen';
    primary.replaceChildren(label, off ? '' : ' ', off ? '' : keycap());
    primary.disabled = off || phase === 'done';
    primary.hidden = phase === 'done';
    // Nothing bright under closed eyes, or while singing.
    primary.className = `btn ${phase === 'take' ? 'btn-secondary' : 'btn-primary'}`;
    primaryWhy.textContent = busy ? waitWhy : phase === 'listen' ? 'The note is playing. The curtain comes down when it ends.'
      : phase === 'paused' && !micflow.mic && micflow.state().phase !== 'lost' ? 'The microphone is off. Press Resume to turn it back on.' : why;
    skipBtn.hidden = !['listen', 'take', 'ended'].includes(s.phase) || paused;
    curtainWords.textContent = curtainText;
    paintUnder();
    view.dataset.phase = phase === 'done' ? 'round-done' : phase;
    paintTray();
  }

  function paintUnder() {
    const s = round.state(), banner = micflow.state().banner;
    const problem = SIGNAL_PROBLEMS.includes(banner) && s.phase === 'take' && !paused ? banner : null;
    const text = problem ? MIC_WORDS[problem]
      : paused ? 'Paused. The microphone is off; Resume plays the note again.'
        : s.phase === 'take' ? EYES_WORDS.listening
          : s.phase === 'ready' ? EYES_WORDS.micWhen
            : shell.headphones() === 'none' && s.phase === 'listen' ? 'No headphones: the note plays first, then the curtain comes down.' : '';
    const key = `${problem || ''}|${text}`;
    if (key === underKey) return;
    underKey = key;
    underLine.dataset.role = problem ? 'close' : '';
    if (!problem) { underLine.replaceChildren(text); return; }
    underLine.replaceChildren(icon(problem === 'silence' ? 'mic-off' : 'warning', 16), h('span', null, text));
  }

  const viewPatch = (state) => ({
    state, noteStyle: settings.get('noteNames'), calm: shell.calm(),
    meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches,
    target: { midi: round.state().targetMidi }, nowFrac: config.stage.nowFracTarget, freshTarget: true, labelClearTopPx: 40,
  });

  // ---- the curtain
  function setCurtain(state) {
    curtain = state;
    curtainEl.style.setProperty('--ec-ms', `${curtainMs()}ms`);
    curtainEl.dataset.state = state;
    const down = state === 'down';
    view.classList.toggle('ec-blind', down);
    // Out of the reading order too: a screen reader must not find the note under the curtain.
    for (const el of [pv.stage.el, ...hudParts]) el.toggleAttribute('inert', down);
    for (const el of hudParts) el.setAttribute('aria-hidden', down ? 'true' : 'false');
  }

  // ---- the reveal picture
  let tokens = null;
  function readTokens() {
    const cs = getComputedStyle(pv.stage.el), g = (n) => cs.getPropertyValue(n).trim();
    tokens = {
      stage: g('--stage'), stageTop: g('--stage-top') || g('--stage'), line: g('--line'), lineStrong: g('--line-strong'), quiet: g('--quiet'),
      target: g('--target'), wash: parseFloat(g('--a-target-wash')) || 0.18, good: g('--good'), close: g('--close'), off: g('--off'),
      font: g('--font-ui') || 'system-ui',
    };
    tokens.light = isLightColour(tokens.stage) ?? false;
  }
  function drawPlate(k) {
    const box = pv.stage.el.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width)), height = Math.max(1, Math.round(box.height));
    const dpr = window.devicePixelRatio || 1;
    if (plate.width !== Math.round(width * dpr) || plate.height !== Math.round(height * dpr)) { plate.width = Math.round(width * dpr); plate.height = Math.round(height * dpr); }
    if (!tokens) readTokens();
    const ctx = plate.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const T = tokens, sc = score, target = round.state().targetMidi;
    const G = revealGeometry({ points: sc ? sc.points : [], targetMidi: target, width, height, config });
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, T.stageTop); grad.addColorStop(1, T.stage);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.font = `500 12px ${T.font}`;
    ctx.textBaseline = 'middle';
    for (const lab of G.labels()) {
      ctx.strokeStyle = lab.isC ? T.lineStrong : T.line;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(G.plotX, Math.round(lab.y) + 0.5); ctx.lineTo(width, Math.round(lab.y) + 0.5); ctx.stroke();
      // As the live stage: right-aligned at its gutter, none under the "Your line" chip or cut at the bottom.
      if (lab.named && G.laneH >= 10 && lab.y >= 40 && lab.y <= height - 12) {
        ctx.fillStyle = T.quiet; ctx.textAlign = 'right';
        ctx.fillText(displayNote(lab.midi, settings.get('noteNames')).text, G.plotX - 8, lab.y);
        ctx.textAlign = 'left';
      }
    }
    // The band: the in-tune width around the target, as on the live stage.
    const half = config.verdict.inTuneCents / 100, top = G.yOfMidi(target + half), bh = 2 * half * G.laneH;
    ctx.globalAlpha = T.wash; ctx.fillStyle = T.target; ctx.fillRect(G.plotX, top, G.plotW, bh);
    ctx.globalAlpha = 0.7; ctx.strokeStyle = T.target; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(G.plotX, top); ctx.lineTo(width, top); ctx.moveTo(G.plotX, top + bh); ctx.lineTo(width, top + bh); ctx.stroke();
    ctx.globalAlpha = 1;
    // "Nothing heard" draws no line: stray readings under minSungSec would contradict the card.
    if (!sc || sc.kind === 'none' || !(k > 0)) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, G.plotX + G.plotW * Math.min(1, k), height); ctx.clip();
    const col = (kind) => (kind === 'in' ? T.good : kind === 'close' ? T.close : T.off);
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const pts = sc.points;
    for (const piece of voicePieces(pts, config.stage)) {
      if (piece.dot || piece.to === piece.from) {
        const p = pts[piece.from];
        ctx.shadowBlur = 0; ctx.fillStyle = col(p.kind); ctx.beginPath(); ctx.arc(G.xOf(p.t), G.yOfMidi(p.midi), 3, 0, 2 * Math.PI); ctx.fill();
        continue;
      }
      // One stroke per stretch of one verdict, neighbours sharing their boundary point.
      let a = piece.from;
      for (let i = piece.from + 1; i <= piece.to + 1; i++) {
        if (i <= piece.to && pts[i].kind === pts[a].kind) continue;
        const end = Math.min(i, piece.to);
        // STYLE: in tune is the 5 px line with a soft glow (the glow in Dusk only).
        const inTune = pts[a].kind === 'in';
        ctx.strokeStyle = col(pts[a].kind);
        ctx.lineWidth = inTune ? 5 : 3;
        ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = inTune && !T.light ? 6 : 0;
        ctx.beginPath();
        for (let j = a; j <= end; j++) { const x = G.xOf(pts[j].t), y = G.yOfMidi(pts[j].midi); if (j === a) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.stroke();
        a = i;
      }
    }
    ctx.restore();
  }
  // Drawn in from the left over revealDrawMs; under calm motion the whole line with a fade.
  function drawIn(done) {
    const mine = ++drawId;
    if (calm()) { drawPlate(1); plate.dataset.k = '1'; done(); return; }
    const t0 = performance.now();
    const step = () => {
      if (dead || mine !== drawId) return;
      const k = Math.min(1, (performance.now() - t0) / E.revealDrawMs);
      drawPlate(k);
      plate.dataset.k = k.toFixed(3);
      if (k < 1) requestAnimationFrame(step); else done();
    };
    step();
  }
  function hidePlate() { drawId++; plate.dataset.shown = 'no'; plate.dataset.k = '0'; }

  // ---- the round
  const guard = async () => {
    const leave = await confirmSheet({ title: 'Leave this round? Notes already shown are kept.', yes: 'Leave', no: 'Keep going' });
    return leave;
  };

  async function start() {
    if (round.state().phase !== 'ready' || starting) return false;
    starting = true; why = ''; waitWhy = 'Waiting for your headphones answer.';
    paint();
    const fail = (text) => { starting = false; why = text; paint(); return false; };
    const phones = await shell.needHeadphones();
    if (dead) return false;
    if (!phones) return fail('Say whether you are wearing headphones, then press Start.');
    waitWhy = 'Waiting for the microphone.';
    paint();
    const ok = await micflow.request(micOptions || {});
    if (dead) return false;
    if (!ok) return fail('The microphone is not on yet.');
    try { synth = synth || createSynth(); } catch { micflow.stop(); return fail('This browser could not start sound.'); }
    starting = false;
    results = []; score = null; recT = 0; recAny = false;
    try { linePct = sessions ? lineShare(sessions.read()) : null; } catch { linePct = null; }
    round.start();
    rec = sessions ? sessions.take('eyesclosed') : null;
    shell.setBusy(guard);
    emit('start');
    listen();
    return true;
  }

  // Listen: the band in view, the note plays. The microphone is open but not listened to.
  function listen() {
    const mine = ++seq;
    if (tone) { tone.stop(); tone = null; }
    clearTimeout(backstop);
    micflow.setListening(false);
    paused = false;
    curtainText = EYES_WORDS.curtain;
    setCurtain('up');
    hidePlate();
    card.dataset.shown = 'no';
    compare.dataset.shown = results.some(Boolean) && linePct !== null ? 'yes' : 'no';
    score = null;
    pv.clear();
    pv.set(viewPatch('tone'));
    pv.stage.start();
    paint();
    emit('listen');
    const plain = timbreFor(settings.get('tone'));
    tone = synth.play({ midi: round.state().targetMidi, dur: M.toneSec, timbre: plain, gain: 0.5 * settings.get('toneVolume'), tag: 'tone' });
    tone.ended.then(() => new Promise((r) => setTimeout(r, M.toneTailMs))).then(() => {
      if (dead || mine !== seq) return;
      tone = null;
      round.toneEnded();
      blind();
    });
  }

  // The curtain comes down and the take begins.
  function blind() {
    if (!micflow.mic) { pause(); return; }
    frames = []; watch.reset(); rebase = true;
    setCurtain('down');
    // Nothing moves under the curtain: the stage rests once it is covered.
    later(() => { if (curtain === 'down') pv.stage.stop(); }, curtainMs() + 50);
    micflow.setListening(true);
    // On the wall clock as well: if frames stop coming, the take still ends.
    clearTimeout(backstop);
    const mine = seq;
    backstop = later(() => { if (mine === seq && round.state().phase === 'take' && !paused) endTake('time'); }, (E.giveUpSec + E.singCapSec + 1) * 1000);
    paint();
    emit('blind');
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  function endTake(whyEnded) {
    if (round.state().phase !== 'take') return;
    clearTimeout(backstop);
    micflow.setListening(false);
    round.takeEnded();
    score = scoreTake(frames, round.state().targetMidi, config);
    // Under the curtain: the picture is ready before it lifts, so the lift shows it directly.
    plate.dataset.shown = 'yes';
    drawPlate(0);
    emit('ended', { why: whyEnded });
    if (whyEnded === 'space') { reveal(); return; }
    const phones = shell.headphones();
    if (canChime({ enabled: settings.get('rewardSounds') !== false, headphones: phones, scoring: false }) && synth) {
      const root = R.chimeRootMidi;
      playChime(synth, [{ midi: root + 7, at: 0, dur: E.doneNoteSec }, { midi: root, at: E.doneGapSec, dur: E.doneNoteSec }], R.chimeGainFrac * 0.5 * settings.get('toneVolume'));
      const mine = seq;
      later(() => { if (mine === seq && round.state().phase === 'ended' && !paused) reveal(); }, (E.doneGapSec + E.doneNoteSec) * 1000 + 250);
      paint();
      return;
    }
    // No sound may play: the words change, and the singer opens their eyes and presses.
    curtainText = EYES_WORDS.open;
    paint();
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  function finishTake() {
    if (round.state().phase === 'take' && !paused) endTake('space');
  }

  function reveal() {
    const s0 = round.state();
    if (s0.phase !== 'ended' || paused) return;
    const sc = score, idx = s0.index;
    round.reveal(sc.star);
    results[idx] = { inPct: sc.inPct, sungSec: sc.sungSec, inSec: sc.inSec, meanCents: sc.meanCents, kind: sc.kind, star: sc.star };
    if (rec && sc.kind !== 'none') {
      for (const f of frames) rec.frame(idx, s0.targetMidi, { t: recT + f.t, midi: f.voiced ? f.midi : null, voiced: !!f.voiced });
      if (sc.star) rec.landed(idx);
      recT += (frames.length ? frames[frames.length - 1].t : 0) + 1;
      recAny = true;
    }
    let first = false;
    try {
      const prev = JSON.parse((store && store.getItem(EYES_KEY)) || 'null');
      const out = addNote(prev, { star: sc.star });
      first = out.firstStar;
      if (store) store.setItem(EYES_KEY, JSON.stringify(out.record));
    } catch { /* unreadable or full: the note is still shown */ }
    setCurtain('up');
    paint();
    emit('reveal');
    const words = revealWords(sc, config);
    const mine = seq;
    later(() => drawIn(() => {
      if (dead || mine !== seq) return;
      showCard(words, sc, first);
      spoken.textContent = `${words.head}. ${words.line}.`;
      emit('revealed');
    }), curtainMs());
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  function showCard(words, sc, first) {
    const tier = !sc.star ? null : first ? { word: 'First blind star', role: 'accent' } : { word: 'Star', role: 'gold' };
    card.replaceChildren(
      h('p', { class: 'ec-head', dataset: { kind: words.kind } },
        icon(words.icon, 24), words.kind === 'close' ? icon(sc.dir === 'low' ? 'arrow-up' : 'arrow-down', 16) : '', h('span', null, words.head),
        tier && h('span', { class: 'chip', dataset: { role: tier.role } }, icon('star', 16), tier.word)),
      h('p', { class: 'ec-line' }, words.line));
    card.dataset.kind = words.kind;
    card.dataset.shown = 'yes';
    const cw = compareWords(linePct, blindPct());
    if (cw) {
      const bar = (label, pct, kind) => {
        const fill = h('i');
        fill.style.setProperty('--k', String(Math.max(0, Math.min(100, pct)) / 100));
        return h('div', { class: 'ec-bar', dataset: { kind } }, h('span', null, label), h('span', { class: 'ec-track' }, fill));
      };
      compare.replaceChildren(bar(cw.line, linePct, 'line'), bar(cw.blind, blindPct(), 'blind'), h('p', { class: 'reason' }, cw.note));
      compare.dataset.shown = 'yes';
    }
  }

  function next() {
    if (round.state().phase !== 'reveal' || paused) return;
    round.next();
    if (round.state().phase === 'done') finish(); else listen();
  }
  function skip() {
    if (!['listen', 'take', 'ended'].includes(round.state().phase) || paused) return;
    seq++;
    if (tone) { tone.stop(); tone = null; }
    clearTimeout(backstop);
    micflow.setListening(false);
    round.skip();
    emit('skip');
    if (round.state().phase === 'done') finish(); else listen();
  }
  function stop() {
    const p = round.state().phase;
    if (p === 'ready' || p === 'done') return;
    round.stop();
    finish();
  }

  function finish() {
    seq++;
    clearTimeout(backstop);
    if (tone) { tone.stop(); tone = null; }
    micflow.setListening(false);
    micflow.stop();
    shell.setBusy(null);
    paused = false;
    setCurtain('up');
    try {
      const prev = JSON.parse((store && store.getItem(EYES_KEY)) || 'null');
      if (store) store.setItem(EYES_KEY, JSON.stringify(addRound(prev)));
    } catch { /* the round still ends */ }
    if (rec) { if (recAny) rec.end(); rec = null; }
    pv.hud.update(null, 0);
    const s = round.state(), held = s.stars.filter(Boolean).length, shown = results.filter(Boolean).length;
    const againBtn = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, onclick: () => again() }, 'Again ', keycap());
    card.replaceChildren(
      h('p', { class: 'ec-head', dataset: { kind: 'done' } }, icon('star', 24), h('span', null, `${held} of ${s.count} notes in tune with your eyes closed`)),
      h('p', { class: 'ec-line' }, shown ? 'Singing without the picture is a separate skill. It grows a little every time.' : 'No notes were shown this round.'),
      h('div', { class: 'action-row' }, againBtn, h('a', { class: 'btn btn-quiet', href: '#/practice' }, 'Back to Practice')));
    card.dataset.kind = 'done';
    card.dataset.shown = 'yes';
    paint();
    emit('done');
    later(() => pv.stage.stop(), curtainMs() + 200);
    againBtn.focus({ preventScroll: true });
  }

  async function again() {
    if (round.state().phase !== 'done') return false;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    round.again();
    hidePlate();
    card.dataset.shown = 'no';
    compare.dataset.shown = 'no';
    results = []; score = null;
    pv.clear();
    pv.set(viewPatch('idle'));
    paint();
    return start();
  }

  // Paused means the microphone is off (owner rule 2026-10-12). A take in progress is dropped
  // (a take cut in half would be judged on half a note) and the note plays again on Resume.
  function pause() {
    const p = round.state().phase;
    if (paused || !['listen', 'take', 'ended', 'reveal'].includes(p)) return;
    seq++;
    if (tone) { tone.stop(); tone = null; }
    clearTimeout(backstop);
    if (p === 'take' || p === 'ended') { round.replay(); frames = []; hidePlate(); }
    paused = true;
    micflow.setListening(false);
    const flow = micflow.state().phase;
    if (micflow.mic && flow !== 'lost' && flow !== 'checking') micflow.stop();
    if (p !== 'reveal') setCurtain('up');
    pv.set({ state: flow === 'lost' ? 'lost' : 'paused' });
    paint();
    emit('paused');
    later(() => { if (paused) pv.stage.stop(); }, curtainMs() + 150);
  }
  // Only ever reached from a press, so it may open the microphone again.
  async function resume() {
    if (!paused || reopening) return;
    const s0 = round.state();
    if (s0.phase === 'reveal' && s0.index + 1 === s0.count) { paused = false; next(); return; }
    if (!micflow.mic) {
      reopening = true; waitWhy = 'Waiting for the microphone.';
      paint();
      const ok = await micflow.request(micOptions || {});
      reopening = false;
      if (dead) return;
      if (!ok || !paused) { paint(); return; }
    }
    paused = false;
    if (round.state().phase === 'reveal') { next(); return; }
    listen();
  }

  const offFrame = micflow.onFrame((frame, level) => {
    if (dead || paused || round.state().phase !== 'take') return;
    if (rebase) { tOffset = -frame.t; rebase = false; }
    const f = { t: frame.t + tOffset, midi: frame.voiced ? frame.midi : null, voiced: !!frame.voiced };
    frames.push(f);
    // The level bar only: hud.update(null, level) clears the note, meter, number and chip.
    if (levelEvery.due(performance.now())) pv.hud.update(null, level);
    const w = watch.push(f);
    if (w.end) endTake(w.end);
  });
  const offState = micflow.subscribe((st) => {
    if (dead) return;
    const p = round.state().phase;
    if ((st.phase === 'lost' || st.phase === 'off') && ['listen', 'take', 'ended'].includes(p) && !paused && !starting && !reopening) pause();
    paintUnder();
    if (paused) paint();
  });

  primary.addEventListener('click', () => {
    const p = round.state().phase;
    if (paused) resume();
    else if (p === 'ready') start();
    else if (p === 'take') finishTake();
    else if (p === 'ended') reveal();
    else if (p === 'reveal') next();
  });
  pv.stage.onResume(resume);

  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (spaceActs(e, { sheet: sheetOpen() })) {
      const shown = [...view.querySelectorAll('[data-primary]:not([disabled])')].find((b) => !b.closest('[hidden]'));
      e.preventDefault();
      if (shown) shown.click();
      return;
    }
    if (e.key === 'Escape' && !paused) { pause(); if (paused) primary.focus(); }
  };
  const onSheet = (e) => {
    if (e.detail.open) pause();
    else if (paused && !reopening && micflow.mic) micflow.stop();
  };
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) pause(); };
  const onCalm = () => { pv.set({ calm: shell.calm(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); };
  const onTheme = () => { tokens = null; if (plate.dataset.shown === 'yes' && drawId) drawPlate(Number(plate.dataset.k) || 0); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  document.addEventListener('mt:theme', onTheme);
  smallMq.addEventListener('change', onCalm);
  const offSettings = settings.subscribe((k) => {
    if (k === 'noteNames' || k === 'pitchView') pv.set({ noteStyle: settings.get('noteNames'), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches });
  });

  pv.set(viewPatch('idle'));
  pv.stage.settle();
  paint();

  return {
    start, finishTake, reveal, next, skip, stop, again, pause, resume,
    state: snapshot,
    view: pv,
    destroy() {
      dead = true;
      seq++;
      if (rec && recAny) rec.end();
      rec = null;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (tone) tone.stop();
      const p = round.state().phase;
      if (starting || reopening || (p !== 'ready' && p !== 'done')) micflow.stop();
      shell.setBusy(null);
      delete view.dataset.phase;
      view.classList.remove('exercise', 'eyes-closed', 'ec-blind');
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      document.removeEventListener('mt:theme', onTheme);
      smallMq.removeEventListener('change', onCalm);
      if (synth && !givenSynth) synth.ctx.close().catch(() => {});
      pv.destroy();
    },
  };
}
