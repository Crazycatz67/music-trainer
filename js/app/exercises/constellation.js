// constellation.js — Sing a constellation, #/practice/constellation (the picker) and
// #/practice/constellation/<id> (one figure): hear a short tune, then sing it one star at a
// time; each held note reels a line out from the last star and lights the next
// (docs/design/specs/2026-10-12-sing-a-constellation.md, slice 1 of section 15).
//
// Reused, not rewritten: the hold rule, ring and kindling star (js/app/holdring.js), the
// octave offer, hints and phase chips of Match and hold (js/app/exercises/matchhold.js), the
// star looks, sparks and answering chord (js/app/rewards.js), the read-out (js/app/hud.js)
// and its words (js/app/stage.js createReadout), the mic flow (js/app/micflow.js). The rules
// of a figure are js/app/figures.js (pure); the drawing is js/app/figurefield.js.
//
// THE MICROPHONE (owner rule 2026-10-12). Nothing here asks for it when the screen is
// shown. It is asked for only inside a press: "Hear the shape", "Light the open star",
// "Sing it again", "Carry on". It is released when a take ends, when the screen is left,
// when Pause is pressed, and (by the mic flow) when the page is hidden; after any of those
// only a press opens it again.
//
// CONTRACT — mountConstellation(view, { shell, micflow, settings, figureId?, config?,
//                                       micOptions?, storage?, synth?, range? }) -> screen
//   figureId    a figures.js id: that figure's screen. None: the picker. Unknown: the picker
//               and a toast "That constellation was not found."
//   shell needs: needHeadphones(), headphones(), calm(), setBusy()
//   micOptions  passed to micflow.request(): { stream } runs the screen with no microphone
//   synth       a js/synth.js synth (the lab passes a muted one); else made on the first press
//   range       { lowMidi, highMidi }; default config.matchhold.default* (E3 to B3)
//   storage     default window.localStorage; saved under figures.js SAVED_KEY
//   screen.start() -> Promise<boolean>   "Hear the shape": headphones, microphone, the tune,
//                                        then star by star by itself
//   screen.next(), skip(), replay(), replayShape(), useOctave(), pause(),
//   screen.resume(), lightOpen() -> Promise<boolean>, again() -> Promise<boolean>, hearIt()
//   screen.state() -> figures.js round.state() + { figure, home, targetMidi, midis, paused,
//                     hold: gate.state(), octaveOffer, firstTime, saved: boolean | null }
//                     (the picker: { phase: 'picker' })
//   screen.field  the figure field (js/app/figurefield.js)      screen.destroy()
//   Events: 'mt:exercise' on document, detail { exercise: 'constellation', event, ...state }.
//       event: start | shape | listen | tone (a reference tone really starts) | sing |
//              landed | skip | octave | open | done
//
// Not built here (slice 2): the dome, "in one breath", Blind, the star store. Settings'
// "Meter only" view is not offered on this screen: the field is the exercise.

import { createSynth } from '../../synth.js';
import { exercises } from '../../timeline.js';
import { CONFIG } from '../config.js';
import { createFigureField } from '../figurefield.js';
import {
  cardStateLine, createFigureRound, createThread, doneLine, fieldLabel, figureById, FIGURE_HINTS, FIGURES, litLine, nextFigure, nextSaved,
  overChip, placeFigure, plainLine, readSaved, SAVED_KEY, semitonesOf, singLine, thumbPoints, WORDS,
} from '../figures.js';
import { createHintGate, createHud } from '../hud.js';
import { createHoldGate, createRimRing, starShape } from '../holdring.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { answerPlan, canChime, chimePlan, LOOK_WORDS, playAnswer, playChime, soundGuard, spreadOf, starLook } from '../rewards.js';
import { confirmSheet, h, icon, sheetOpen, toast } from '../shell.js';
import { createReadout } from '../stage.js';
import { createOctaveGate, MATCH_HINTS, OCTAVE_WORDS, octaveOut, PHASE_CHIP, problemFor, spaceActs } from './matchhold.js';

const ROUTE = '#/practice/constellation';
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const el = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

function openStore(storage) {
  const store = storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  const read = () => { try { return readSaved(store ? store.getItem(SAVED_KEY) : ''); } catch { return {}; } };
  return {
    read,
    // false: nothing was kept (private mode, storage full or switched off).
    write(id, record) {
      if (!store) return false;
      try { store.setItem(SAVED_KEY, JSON.stringify({ ...read(), [id]: record })); return true; } catch { return false; }
    },
  };
}

// The picker's drawing: a piece of sky across the top of the card, the same figure table
// in a 300 x 120 box (review 3, finding 5). The card is wider than the box, and an SVG
// draws what lies beside its viewBox, so the quiet stars are scattered well past both sides.
const THUMB = { w: 300, h: 120, pad: 28, skyFrom: -200, skyTo: 500, skyCount: 34 };
function thumb(figure, saved) {
  const pts = thumbPoints(figure, THUMB.w, THUMB.h, THUMB.pad), lit = (i) => !!(saved && saved.stars[i]);
  const svg = svgEl('svg', { viewBox: `0 0 ${THUMB.w} ${THUMB.h}`, class: 'figure-thumb', 'aria-hidden': 'true' });
  // Placed from the figure's own name: the same sky every visit, a different one per card.
  let seed = [...figure.id].reduce((a, ch) => Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < THUMB.skyCount; i++) {
    const x = THUMB.skyFrom + rnd() * (THUMB.skyTo - THUMB.skyFrom), y = 5 + rnd() * (THUMB.h - 10), r = 0.5 + rnd() * 0.5, o = 0.3 + rnd() * 0.7;
    if (pts.some((p) => Math.hypot(p.x - x, p.y - y) < 12)) continue;
    svg.append(svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(2), opacity: o.toFixed(2), class: 'is-sky' }));
  }
  // A lit star's soft halo: one gradient per drawing (its colours are tokens, in the CSS).
  const haloId = `figure-halo-${figure.id}`, grad = svgEl('radialGradient', { id: haloId });
  grad.append(svgEl('stop', { offset: '0', class: 'halo-in' }), svgEl('stop', { offset: '1', class: 'halo-out' }));
  svg.append(grad);
  const join = (a, b, cls) => svg.append(svgEl('line', { x1: pts[a].x, y1: pts[a].y, x2: pts[b].x, y2: pts[b].y, class: cls }));
  for (let i = 1; i < pts.length; i++) join(i - 1, i, lit(i - 1) && lit(i) ? 'is-drawn' : 'is-guide');
  if (saved && saved.completedAt) for (const [a, b] of figure.closing) join(a, b, 'is-closing');
  // Small enough that neighbours never touch: 5 px, 4 px in a figure of six notes or more.
  const d = starShape('held').d, r = pts.length >= 6 ? 4 : 5;
  pts.forEach((p, i) => {
    if (lit(i)) svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: r * 3, fill: `url(#${haloId})` }));
    svg.append(svgEl('path', { d, transform: `translate(${p.x} ${p.y}) scale(${r})`, class: lit(i) ? 'is-lit' : 'is-hollow', 'vector-effect': 'non-scaling-stroke' }));
  });
  return svg;
}

function mountPicker(view, { store, range, notFound }) {
  const saved = store.read();
  const done = (f) => !!(saved[f.id] && saved[f.id].completedAt);
  const first = FIGURES.find((f) => !done(f));
  const begun = first && saved[first.id] && saved[first.id].stars.some(Boolean);
  view.classList.add('constellation');
  view.append(
    h('div', { class: 'title-row' },
      h('a', { class: 'btn btn-quiet back', href: '#/practice' }, icon('back', 16), ' The Ladder'),
      h('h1', { tabindex: '-1' }, WORDS.name)),
    h('p', { class: 'reason' }, `${WORDS.plain}. ${WORDS.ready}`),
    // The one filled button: the first figure not yet in the sky. The order is advice.
    first && h('div', { class: 'action-row' },
      h('a', { class: 'btn btn-primary', href: `${ROUTE}/${first.id}`, dataset: { primary: '' } }, `${begun ? 'Continue' : 'Start'}: ${first.name}`)),
    h('ul', { class: 'figure-grid' }, FIGURES.map((f) => {
      // A figure already begun is judged where it was sung, as on its own screen (bugs.md 39).
      const was = saved[f.id] && saved[f.id].stars.some(Boolean) ? saved[f.id].home : null;
      const over = overChip(placeFigure(f, Number.isFinite(was) ? { ...range, home: was } : range).over);
      return h('li', null, h('a', { class: 'card card-link figure-card', href: `${ROUTE}/${f.id}`, dataset: { figure: f.id, state: done(f) ? 'complete' : saved[f.id] ? 'started' : 'new' } },
        thumb(f, saved[f.id]),
        h('div', { class: 'figure-card-text' },
          h('h2', null, f.name), h('p', null, plainLine(f)),
          h('p', { class: 'reason' }, cardStateLine(saved[f.id], f.degrees.length)),
          over && h('span', { class: 'chip chip-small' }, icon('info', 16), over))));
    })));
  if (notFound) toast(WORDS.notFound);
  return {
    state: () => ({ phase: 'picker' }),
    destroy() { view.classList.remove('constellation'); },
  };
}

export function mountConstellation(view, {
  shell, micflow, settings, figureId = null, config = CONFIG, micOptions, storage, synth: givenSynth = null, range = {},
  // js/app/sessions.js createSessions(): each finished take's scored readings are handed to
  // it (sessions.take('constellation')). Without it nothing is recorded.
  sessions = null,
} = {}) {
  let rec = null, recHeld = 0;
  const store = openStore(storage);
  const figure = figureId ? figureById(figureId) : null;
  if (!figure) return mountPicker(view, { store, range, notFound: !!figureId });

  const C = config.constellation, H = config.hold, R = config.rewards;
  const semis = semitonesOf(figure), count = semis.length;
  const fresh = placeFigure(figure, range);
  let savedRec = store.read()[figure.id] || null;
  // Stars lit on another night come back; so does a finished figure, whole, with its lines.
  const kept = savedRec && savedRec.stars.some(Boolean) ? savedRec : null;
  const round = createFigureRound(count, kept && { lit: kept.stars.map(Boolean), looks: kept.stars, lines: kept.lines });
  // Where it was sung is where it stays (an octave chosen then is part of `home`).
  const home = kept && Number.isFinite(kept.home) ? kept.home : fresh.home;
  // The "past your range" chip speaks of where the figure really sits: a half-sung figure
  // keeps its old home, which today's range may no longer hold (bugs.md 39).
  const place = home === fresh.home ? fresh : placeFigure(figure, { ...range, home });
  const gate = createHoldGate({ ...H, holdMs: C.holdMs });
  const thread = createThread(C.linePoints);
  const readout = createReadout(config);
  const hints = createHintGate(config.hud);
  const octaveGate = createOctaveGate(config.verdict.holdMs + H.octaveOfferExtraMs);
  const textEvery = createEvery(1000 / H.textHz);

  let synth = givenSynth, tones = [], seq = 0, dead = false, starting = false, paused = false, reopening = false, playing = false;
  let why = '', waitWhy = '', underKey = null, shapeThen = null;
  let tOffset = 0, lastT = null, rebase = true, wasLost = false;
  let landedMidi = null, lastLandMs = null, inRow = 0, inCents = [], sameSince = null;
  // The last reward sound and the earliest moment a reference tone may follow it
  // (rewards.js soundGuard), kept across Skip and pauses: as in Match and hold.
  let rewardAtMs = null, rewardEndMs = null, rewardHandles = [], quietUntilMs = 0;
  let octaveOffer = null, hintKey = null, firstTime = false, savedOk = null, saidAtMs = -Infinity;
  // What save() gave when the LAST star landed (bugs.md 32): finish() uses it instead of
  // saving again, so a whole figure is kept at once and still counted once.
  let wholeOut = null;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };

  const midis = () => semis.map((s) => home + s + round.state().octaveSemis);
  const targetMidi = () => midis()[round.state().index];
  const timbre = () => (settings.get('tone') === 'sine' ? 'sine' : 'voice');
  const toneGain = () => 0.5 * settings.get('toneVolume');

  // ---- the page
  const keycap = (k = 'Space') => h('kbd', { class: 'keycap' }, k);
  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const phaseChip = h('div', { class: 'chip phase-chip', 'aria-live': 'polite' }, chipIcon, chipWord);
  const octaveChip = h('div', { class: 'chip octave-chip', dataset: { role: 'close' }, hidden: true },
    h('span', { class: 'octave-dots', 'aria-hidden': 'true' }, h('i'), h('i')), h('span'));
  const over = overChip(place.over);
  const nameEl = h('h1', { tabindex: '-1', class: 'figure-name' }, figure.name);
  const statusLine = h('p', { class: 'figure-status' });
  const said = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, 'aria-describedby': 'figure-why' });
  const primaryWhy = h('p', { class: 'reason', id: 'figure-why' });
  const hearBtn = h('button', { class: 'btn btn-secondary', type: 'button', hidden: true, onclick: () => replay() }, icon('replay', 16), ` ${WORDS.hearAgain} `, keycap('R'));
  const shapeBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true, onclick: () => replayShape() }, `${WORDS.hearShape} `, keycap('Shift R'));
  const octaveBtn = h('button', { class: 'btn btn-secondary octave-btn', type: 'button', hidden: true, onclick: () => useOctave() }, 'Use my octave');
  const skipBtn = h('button', { class: 'btn btn-quiet skip-btn', type: 'button', hidden: true, onclick: () => skip() }, WORDS.skip);
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const bannerSlot = h('div'), main = h('div', { class: 'pitch-main' }), pitchView = h('div', { class: 'pitch-view' }, main);
  const doneRow = h('section', { class: 'figure-done', hidden: true, 'aria-label': 'Figure done' });
  view.classList.add('exercise', 'constellation');
  view.append(
    h('div', { class: 'title-row ex-head' },
      h('a', { class: 'btn btn-quiet back', href: ROUTE }, icon('back', 16), ' Constellations'),
      nameEl, h('p', { class: 'ex-step' }, plainLine(figure)),
      // In the title row, not on the field: there it covered the "8 notes high" chip
      // pinned to the field's top edge (review 3, finding 2; spec section 5).
      phaseChip,
      over && h('span', { class: 'chip chip-small' }, icon('info', 16), over)),
    h('p', { class: 'reason' }, WORDS.ready),
    bannerSlot, pitchView, statusLine, underLine, doneRow, said,
    h('div', { class: 'action-row' }, hearBtn, shapeBtn, octaveBtn, h('div', { class: 'action-main' }, primary, primaryWhy), skipBtn));
  const field = createFigureField(main, { config });
  const fieldChips = h('div', { class: 'stage-chips' }, octaveChip);
  field.el.append(fieldChips);
  const hud = createHud(pitchView, { config, hints: FIGURE_HINTS });
  // Signal problems go in the reserved line under the field, never in a banner that would
  // push the field down under the singer's eyes (as Match and hold).
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });
  const rims = [...hud.el.querySelectorAll('.note-ring')].map((el) => createRimRing(el));
  const hintLine = h('p', { class: 'hud-hint ex-hint' });
  hud.el.querySelector('.hud-hint').after(hintLine);

  const snapshot = () => ({
    ...round.state(), figure: figure.id, home: home + round.state().octaveSemis, targetMidi: targetMidi(), midis: midis(),
    paused, hold: gate.state(), octaveOffer, firstTime, saved: savedOk,
  });
  const emit = (event) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: 'constellation', event, ...snapshot() } }));

  function fieldState() {
    const s = round.state(), singing = s.phase === 'listen' || s.phase === 'sing' || s.phase === 'result';
    return {
      name: figure.name, degrees: figure.degrees, midis: midis(), closing: figure.closing,
      lit: s.lit, looks: s.looks, lines: s.lines, solid: s.solid, target: singing ? s.index : null,
      calm: shell.calm(), noteStyle: settings.get('noteNames'), paused, done: s.phase === 'done' && s.complete,
      // The words the field sets beside the gold name: the done line without the name.
      doneTail: doneLine(figure.name, count, count).replace(figure.name, '').trim(),
      // The octave chip lies over the field's corner: the field keeps its own tag and edge
      // chip out from under it.
      clear: chipBox(),
      label: fieldLabel(figure.name, s),
    };
  }

  function chipBox() {
    if (octaveChip.hidden) return null;
    const c = fieldChips.getBoundingClientRect(), f = field.el.getBoundingClientRect();
    return c.width ? { x: c.left - f.left, y: c.top - f.top, w: c.width, h: c.height } : null;
  }

  // Landings are said politely, and never more often than the read-out's own limit.
  function announce(text) {
    const now = performance.now();
    if (now - saidAtMs < config.hud.announceEveryMs) return;
    saidAtMs = now;
    said.textContent = text;
  }

  function statusText() {
    const s = round.state(), g = gate.state(), lit = s.lit.filter(Boolean).length;
    if (paused) return WORDS.paused;
    if (s.phase === 'ready') return lit ? doneLine(figure.name, lit, count) : '';
    if (s.phase === 'shape') return 'Listen to the whole shape.';
    if (s.phase === 'listen') return `Star ${s.index + 1} of ${count} · Listen`;
    if (s.phase === 'sing') return singLine(s.index, count, g.heldMs, g.holdMs);
    if (s.phase === 'result') return litLine(s.index, count, s.looks[s.index]);
    return doneLine(figure.name, lit, count);
  }

  function paintHold(force = false) {
    const g = gate.state(), s = round.state();
    const showing = s.phase === 'sing' || s.phase === 'result';
    for (const rim of rims) rim.set(showing ? g.progress : 0, { landed: s.phase === 'result' });
    if (!force && !textEvery.due(performance.now())) return;
    const text = statusText();
    if (statusLine.textContent !== text) statusLine.textContent = text;
  }

  function paintHint(key) {
    if (key === hintKey) return;
    hintKey = key;
    hintLine.textContent = key === 'same' ? WORDS.sameNote : key ? FIGURE_HINTS[key] || MATCH_HINTS[key] : '';
    hintLine.classList.toggle('is-shown', !!key);
  }

  // The one reserved line under the field (as Match and hold): a signal problem takes it
  // over while it lasts; its height is fixed, so nothing on the page moves.
  function paintUnder() {
    const s = round.state(), phones = shell.headphones();
    const banner = micflow.state().banner;
    const problem = SIGNAL_PROBLEMS.includes(banner) ? banner : null;
    const text = problem ? MIC_WORDS[problem] : [
      phones === 'none' ? 'No headphones: each note plays first, then it’s your turn.' : '',
      s.octaveSemis ? `Using your octave: the whole figure is one octave ${s.octaveSemis < 0 ? 'lower' : 'higher'}.` : '',
    ].filter(Boolean).join(' ');
    const key = `${problem || ''}|${text}`;
    if (key === underKey) return;
    underKey = key;
    underLine.dataset.role = problem ? 'close' : '';
    if (!problem) { underLine.replaceChildren(text); return; }
    underLine.replaceChildren(...[
      icon(problem === 'silence' ? 'mic-off' : 'warning', 16), h('span', null, text),
      problem === 'silence' && h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => micflow.openLevelCheck() }, 'Test the mic'),
    ].filter(Boolean));
  }

  function paint() {
    const s = round.state(), g = gate.state();
    const phase = paused ? 'paused' : s.phase;
    const chip = phase === 'shape' ? PHASE_CHIP.listen : phase === 'done' ? { word: 'Done', icon: 'star', role: s.complete ? 'gold' : 'quiet' } : PHASE_CHIP[phase];
    chipIcon.replaceChildren(icon(chip.icon, 16));
    chipWord.textContent = phase === 'result' ? LOOK_WORDS[s.looks[s.index]] || chip.word : chip.word;
    phaseChip.dataset.role = chip.role;
    octaveChip.hidden = !(octaveOffer && s.phase === 'sing' && !paused);
    octaveChip.lastChild.textContent = octaveOffer ? OCTAVE_WORDS[octaveOffer] : '';
    octaveBtn.hidden = octaveChip.hidden;

    const busy = starting || reopening;
    const sounding = phase === 'shape' || phase === 'listen';
    const last = s.mode === 'open' || !s.open.some((i) => i > s.index);
    const label = busy ? 'Starting…' : { ready: WORDS.hearShape, shape: 'Listening…', listen: 'Listening…', sing: 'Pause', result: last ? 'Finish' : 'Next star', paused: 'Carry on', done: '' }[phase];
    const off = busy || sounding;
    primary.replaceChildren(label, off ? '' : ' ', off ? '' : keycap(phase === 'sing' ? 'Esc' : 'Space'));
    // Hidden AND off when the figure is done: Space must reach the done row's own button.
    primary.disabled = off || phase === 'done';
    primary.hidden = phase === 'done';
    // While singing the main button is the quiet kind: nothing bright under the eyes.
    primary.className = `btn ${phase === 'sing' ? 'btn-secondary' : 'btn-primary'}`;
    primaryWhy.textContent = busy ? waitWhy
      : phase === 'shape' ? 'The shape is playing. The microphone waits until it ends.'
        : phase === 'listen' ? 'The note is playing. The microphone waits until it ends.'
          : phase === 'paused' && !micflow.mic && micflow.state().phase !== 'lost' ? 'The microphone is off. Press Carry on to turn it back on.' : why;
    hearBtn.hidden = !(s.phase === 'sing' && !paused);
    shapeBtn.hidden = hearBtn.hidden;
    skipBtn.hidden = !(s.phase === 'listen' || s.phase === 'sing') || paused;
    skipBtn.textContent = g.stuck ? WORDS.skipStuck : WORDS.skip;
    nameEl.toggleAttribute('data-complete', s.complete && s.phase === 'done');
    paintUnder();
    view.dataset.phase = phase;
    field.set(fieldState());
    paintHold(true);
  }

  // ---- sound
  function stopTones() { for (const t of tones) t.stop(); tones = []; }

  // A reward sound must be silent for guardMs before any reference tone (and so before any
  // scoring). Returns how long the tone still has to wait.
  function quietWait() {
    const nowMs = performance.now();
    if (rewardAtMs !== null) {
      const guardNow = soundGuard({ sinceMs: nowMs - rewardAtMs, endMs: rewardEndMs }, R.answer);
      if (guardNow.fade) for (const hd of rewardHandles) hd.stop(R.answer.earlyFadeMs / 1000);
      quietUntilMs = Math.max(quietUntilMs, nowMs + guardNow.waitMs);
      rewardAtMs = null; rewardHandles = [];
    }
    return Math.max(0, quietUntilMs - nowMs);
  }

  // Plays notes one after another and lights each one's star while it sounds; then() runs
  // when the last has ended and the room has stopped ringing. list: [{ index, dur, gap }].
  function playNotes(list, { tag = 'tone', gain = toneGain(), then, event = null } = {}) {
    const mine = ++seq;
    stopTones();
    const go = () => {
      if (dead || mine !== seq) return;
      if (event) emit(event);
      const all = midis();
      let at = synth.ctx.currentTime + 0.03, ms = 30;
      for (const n of list) {
        tones.push(synth.play({ midi: all[n.index], dur: n.dur, when: at, timbre: timbre(), gain, tag }));
        later(() => { if (mine === seq) field.light(n.index); }, ms);
        at += n.dur + (n.gap || 0);
        ms += 1000 * (n.dur + (n.gap || 0));
      }
      later(() => {
        if (mine !== seq) return;
        tones = [];
        field.light(null);
        if (then) then();
      }, ms + C.toneTailMs);
    };
    const wait = quietWait();
    if (wait > 0) later(go, wait); else go();
  }

  // "Hear the shape": the whole tune (js/timeline.js fourNote takes any pattern length).
  function playShape(then, opts = {}) {
    const tl = exercises.fourNote(home, { pattern: semis, noteDur: C.shapeNoteSec, gap: C.shapeGapSec });
    playNotes(tl.notes.map((n, i) => ({ index: i, dur: n.dur, gap: C.shapeGapSec })), { ...opts, then });
  }

  // ---- the take
  const guard = async () => {
    const wasSinging = (round.state().phase === 'sing' || round.state().phase === 'result') && !paused;
    const leave = await confirmSheet({ title: 'Stop this take? The stars you lit are kept.', yes: 'Leave', no: 'Keep singing' });
    // The sheet paused the take; "Keep singing" should mean exactly that.
    if (!leave && wasSinging && paused) resume();
    return leave;
  };

  // Every way into singing goes through here, from a press: the headphones answer, then the
  // microphone, then sound.
  async function open(failWord) {
    starting = true; why = ''; waitWhy = 'Waiting for your headphones answer.';
    paint();
    const fail = (text) => { starting = false; why = text; paint(); return false; };
    const phones = await shell.needHeadphones();
    if (dead) return false;
    if (!phones) return fail(`Say whether you are wearing headphones, then press ${failWord}.`);
    waitWhy = 'Waiting for the microphone.';
    paint();
    const ok = await micflow.request(micOptions || {});
    if (dead) return false;
    if (!ok) return fail('The microphone is not on yet.');
    try { synth = synth || createSynth(); } catch { return fail('This browser could not start sound.'); }
    starting = false;
    return true;
  }

  function beginTake() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    playing = false;
    hideDone();
    gate.reset();
    readout.reset();
    lastT = null; tOffset = 0; rebase = true; inRow = 0; lastLandMs = null; landedMidi = null; firstTime = false; wholeOut = null;
    rec = sessions ? sessions.take('constellation') : null;
    recHeld = 0;
    shell.setBusy(guard);
    field.start();
  }

  async function start() {
    if (round.state().phase !== 'ready' || starting) return false;
    if (!(await open(WORDS.hearShape))) return false;
    beginTake();
    round.start();
    emit('start');
    shape(() => { round.shapeEnded(); afterAdvance(); });
    return true;
  }

  function shape(then) {
    shapeThen = then;
    micflow.setListening(false);
    paused = false;
    paint();
    emit('shape');
    playShape(then, { event: 'tone' });
  }

  function clearNote() {
    inCents = []; octaveOffer = null; sameSince = null;
    thread.reset();
    hints.reset();
    octaveGate.reset();
    readout.reset();
    paintHint(null);
    field.set({ progress: 0, thread: [] });
    field.voice(null);
  }

  // The star's own note. The microphone is not scored while it sounds: without headphones
  // it would hear the speaker. `lead`: the star before an open one plays first, so the step
  // between the two is heard.
  function listen(fresh, lead = null) {
    micflow.setListening(false);
    if (fresh) { gate.next(); clearNote(); }
    paused = false;
    hud.update(null, 0);
    paint();
    emit('listen');
    const index = round.state().index;
    const list = lead === null ? [] : [{ index: lead, dur: C.toneSec, gap: C.shapeGapSec }];
    playNotes([...list, { index, dur: C.toneSec }], { event: 'tone', then: () => { round.toneEnded(); sing(); } });
  }

  function sing() {
    // The microphone went while the note played, or was released because the page was
    // hidden: wait, paused. This runs from a timer, so it must not open the microphone
    // itself; Carry on does, from a press.
    if (!micflow.mic) { pause(); return; }
    paused = false;
    micflow.setListening(true);
    paint();
    emit('sing');
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  function replay() {
    if (round.state().phase !== 'sing' || paused) return;
    round.replay();
    listen(false);
  }

  function replayShape() {
    if (round.state().phase !== 'sing' || paused) return;
    round.replayShape();
    shape(() => { round.shapeEnded(); listen(false); });
  }

  function save() {
    const out = nextSaved(savedRec, round.state(), { id: figure.id, home: home + round.state().octaveSemis, nowIso: new Date().toISOString() });
    savedRec = out.record;
    savedOk = store.write(figure.id, out.record);
    return out;
  }

  function onLanded() {
    const s = round.state(), index = s.index, now = performance.now();
    const look = starLook({ spread: spreadOf(inCents), drained: gate.state().drained }, R);
    landedMidi = targetMidi();
    if (rec) { rec.landed(index); recHeld++; }
    round.landed({ look, line: index > 0 ? thread.record() : null });
    // Scoring stops first; only then may the answer sound (never while a note is judged).
    micflow.setListening(false);
    lastLandMs = now;
    inRow++;
    octaveOffer = null;
    paintHint(null);
    // Kept at once: the stars lit so far are still there another night, and so is the last
    // star when the screen is left before "done" (bugs.md 32). A finished figure is still
    // written once: finish() takes this result instead of saving again.
    const landedOut = save();
    wholeOut = round.state().complete ? landedOut : null;
    paint();
    field.land(index, { look });
    announce(litLine(index, count, look));
    emit('landed');
    if (canChime({ enabled: settings.get('rewardSounds'), headphones: shell.headphones(), scoring: false })) {
      const answer = answerPlan(landedMidi, inRow, R.answer);
      rewardHandles = playAnswer(synth, answer, toneGain(), R.answer);
      rewardAtMs = now; rewardEndMs = answer.endMs;
    }
    primary.focus({ preventScroll: true });
    later(() => { if (round.state().phase === 'result' && round.state().index === index) next(); }, C.autoNextMs);
  }

  function afterAdvance() {
    if (round.state().phase === 'done') finish(); else listen(true);
  }
  function next() {
    // Paused while the result shows (a sheet, Esc, the page hidden): the next star's note
    // waits for Carry on (bugs.md 33).
    if (round.state().phase !== 'result' || paused) return;
    round.next();
    afterAdvance();
  }
  function skip() {
    const p = round.state().phase;
    if ((p !== 'listen' && p !== 'sing') || paused) return;
    // A skipped star stays hollow and costs nothing: no word, no sound, no colour.
    inRow = 0;
    seq++;
    stopTones();
    field.light(null);
    round.skip();
    emit('skip');
    afterAdvance();
  }

  function useOctave() {
    if (!octaveOffer || round.state().phase !== 'sing') return;
    round.useOctave(octaveOffer);
    octaveOffer = null;
    hints.reset();
    octaveGate.reset();
    readout.reset();
    paintHint(null);
    // The whole figure moves 12 notes: the picture is the same, only its note names change.
    paint();
    emit('octave');
  }

  function finish() {
    seq++;
    stopTones();
    micflow.stop();
    shell.setBusy(null);
    paused = false;
    const s = round.state();
    const out = wholeOut || save();
    wholeOut = null;
    firstTime = out.firstTime;
    // The microphone is off now: the read-out must not go on saying "In tune".
    hud.update(null, 0);
    field.voice(null);
    paint();
    showDone();
    announce(doneLine(figure.name, s.lit.filter(Boolean).length, count));
    // After the row of buttons: the coach's few words go under it.
    if (rec) { rec.end(); rec = null; }
    emit('done');
    if (!s.complete) { later(() => field.stop(), R.burstMs + 400); return; }
    // The figure's own moment waits its turn: never two bursts inside burstMinGapMs.
    const wait = lastLandMs === null ? 0 : Math.max(0, R.burstMinGapMs - (performance.now() - lastLandMs)) + 20;
    later(() => {
      const chime = canChime({ enabled: settings.get('rewardSounds'), headphones: shell.headphones(), scoring: false }) && synth;
      let afterMs = 0;
      if (firstTime) {
        field.burst(count - 1, { tier: 'first' });
        if (chime) {
          const plan = chimePlan('first', 1, R);
          rewardHandles = playChime(synth, plan, R.chimeGainFrac * toneGain());
          rewardAtMs = performance.now(); rewardEndMs = 20 + 1000 * Math.max(...plan.map((n) => n.at + n.dur));
          afterMs = rewardEndMs;
        }
      }
      // With headphones the tune plays back once, softly, as the stars pulse in order.
      const stopAfter = (ms) => later(() => { playing = false; field.stop(); if (!doneRow.hidden) paintDone(); }, ms);
      if (chime) { playing = true; later(() => playShape(() => stopAfter(200), { tag: 'playback', gain: C.softGainFrac * toneGain() }), afterMs); } else stopAfter(R.burstMs + figure.closing.length * C.closingStepMs + 400);
    }, wait);
  }

  // "Hear it": the tune again with the microphone closed. Only ever from a press.
  function hearIt() {
    if (round.state().phase !== 'done' || playing || starting) return;
    try { synth = synth || createSynth(); } catch { return; }
    playing = true;
    field.start();
    paintDone();
    playShape(() => { playing = false; field.stop(); paintDone(); }, { tag: 'playback' });
  }

  let hearItBtn = null;
  // Emptied as well as hidden: Space presses the first [data-primary] on the screen, and a
  // button left behind in a hidden row would take the press meant for "Carry on".
  function hideDone() { doneRow.hidden = true; doneRow.replaceChildren(); hearItBtn = null; }
  function paintDone() { if (hearItBtn) hearItBtn.disabled = playing || starting; }

  function showDone() {
    const s = round.state(), lit = s.lit.filter(Boolean).length, nextFig = nextFigure(figure.id);
    hearItBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => hearIt() }, icon('speaker', 16), ` ${WORDS.hearIt}`);
    const back = (cls) => h('a', { class: `btn ${cls}`, href: '#/practice', ...(cls === 'btn-primary' ? { 'data-primary': '' } : {}) }, WORDS.back);
    const buttons = s.complete
      ? [
        nextFig ? h('a', { class: 'btn btn-primary', href: `${ROUTE}/${nextFig.id}`, 'data-primary': '' }, `Next: ${nextFig.name} `, keycap()) : back('btn-primary'),
        hearItBtn,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => again() }, WORDS.singAgain),
        nextFig && back('btn-quiet'),
      ]
      : [
        h('button', { class: 'btn btn-primary', type: 'button', 'data-primary': '', 'aria-describedby': 'figure-done-why', onclick: () => lightOpen() }, `${WORDS.lightOpen} `, keycap()),
        hearItBtn, back('btn-quiet'),
      ];
    // A whole figure: its name and sentence are set in gold inside the field, so the row
    // keeps its own copy for screen readers only and is not a card (review 3, finding 1c).
    doneRow.toggleAttribute('data-complete', s.complete);
    doneRow.replaceChildren(
      h('div', { class: 'figure-done-words' },
        h('p', { class: s.complete ? 'done-line visually-hidden' : 'done-line' }, doneLine(figure.name, lit, count)),
        firstTime && h('span', { class: 'chip', dataset: { role: 'accent' } }, icon('star', 16), 'First time'),
        h('p', { class: 'reason', id: 'figure-done-why' }, savedOk === false ? WORDS.cannotSave : why)),
      h('div', { class: 'figure-done-actions' }, buttons.filter(Boolean)));
    doneRow.hidden = false;
    paintDone();
  }

  async function lightOpen() {
    const s = round.state();
    if (s.phase !== 'done' || !s.open.length || starting) return false;
    seq++;
    stopTones();
    // "Hear it" was playing: it has just been cut, so it is over (bugs.md 36). Without this
    // a press given up at the headphones or microphone question left "Hear it" off for good.
    if (playing) { playing = false; field.stop(); field.light(null); }
    paintDone();
    if (!(await open(WORDS.lightOpen))) { showDone(); return false; }
    beginTake();
    const now = round.lightOpen();
    emit('open');
    listen(true, now.index > 0 ? now.index - 1 : null);
    return true;
  }

  async function again() {
    if (round.state().phase !== 'done' || starting) return false;
    seq++;
    stopTones();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    field.stop();
    field.light(null);
    hideDone();
    round.again();
    clearNote();
    paint();
    return start();
  }

  // Paused means the microphone is off (owner rule 2026-10-12): Pause, Esc, any sheet, the
  // page hidden or left all release it, every track ended. Until 2026-10-12 a pause caused
  // by a sheet kept it open behind a screen that said "Paused". The take is kept; Carry on
  // opens it again.
  // One sheet needs the microphone: the mic flow's own level check ('checking'), which the
  // singer opened with "Test the mic". Released at once, that sheet stood open with a dead
  // level bar. The take still pauses, and the microphone goes when the sheet closes (onSheet).
  // The drawing loop rests too, once the dot and the lit star have eased away: a paused
  // picture is one still frame, not 60 a second of the same one.
  const REST_MS = 750;
  const rest = () => later(() => { if (paused && !reopening) field.stop(); }, REST_MS);
  function pause() {
    const p = round.state().phase;
    if (paused || (p !== 'sing' && p !== 'listen' && p !== 'shape' && p !== 'result')) return;
    seq++;
    stopTones();
    field.light(null);
    if (p === 'listen') round.toneEnded();
    paused = true;
    micflow.setListening(false);
    // Lost (unplugged) has nothing open and keeps its Reconnect banner.
    const flow = micflow.state().phase;
    if (micflow.mic && flow !== 'lost' && flow !== 'checking') micflow.stop();
    // Nothing is being heard now: the read-out goes back to its dash and the dot leaves
    // the field, instead of the last reading standing there (review 3, finding 7).
    hud.update(null, 0);
    field.voice(null);
    paint();
    rest();
  }

  // Only ever reached from a press (the button, Space, "Keep singing"), so it may open the
  // microphone again.
  async function resume() {
    if (!paused || reopening) return;
    field.start();
    const s0 = round.state();
    // Paused on a result with nothing left to sing: the take ends; no microphone is needed.
    if (s0.phase === 'result' && (s0.mode === 'open' || !s0.open.some((i) => i > s0.index))) { paused = false; next(); return; }
    if (!micflow.mic) {
      reopening = true; waitWhy = 'Waiting for the microphone.';
      paint();
      const ok = await micflow.request(micOptions || {});
      reopening = false;
      if (dead) return;
      if (!ok || !paused) { paint(); if (paused) rest(); return; }
    }
    if (round.state().phase === 'shape') { shape(shapeThen); return; }
    if (round.state().phase === 'result') { paused = false; next(); return; }
    // The note plays again: after a break nobody remembers the pitch.
    round.replay();
    listen(false);
  }

  const offFrame = micflow.onFrame((frame, level) => {
    const s = round.state();
    if (dead || (s.phase !== 'sing' && s.phase !== 'listen' && s.phase !== 'result' && s.phase !== 'shape')) return;
    // Each time the microphone is opened its clock starts again; the take must not run
    // backwards, so later readings follow the last one.
    if (rebase) { tOffset = lastT === null ? -frame.t : lastT + 0.5 - frame.t; rebase = false; }
    const t = frame.t + tOffset;
    lastT = t;
    const onLast = frame.voiced && landedMidi !== null && Math.abs(frame.midi - landedMidi) * 100 <= config.verdict.closeCents;
    if (s.phase !== 'sing' || paused) {
      // Not scored. Only the release rule watches (has the last note been let go?).
      gate.push({ tMs: t * 1000, inTune: false, voiced: frame.voiced, scoring: false, onLast });
      return;
    }
    const target = targetMidi();
    if (rec) rec.frame(s.index, target, { t, midi: frame.midi, voiced: frame.voiced });
    const r = readout.push({ ...frame, t }, { target, level, noteStyle: settings.get('noteNames'), octaveCents: H.octaveCents });
    hud.update(r, level);
    const inTune = r.voiced && r.verdict.kind === 'in' && r.kind === 'in';
    const before = gate.state().progress;
    const g = gate.push({ tMs: t * 1000, inTune, voiced: r.voiced, scoring: true, onLast });
    // The thread is the singer's own line: where the voice was, at each part of the hold.
    if (inTune && !g.needsRelease) { inCents.push(r.cents); thread.push(g.progress, r.cents); } else if (g.progress < before) thread.trim(g.progress);
    field.set({ progress: g.progress, thread: thread.values() });
    field.voice({ voiced: r.voiced, midi: r.midi, kind: r.kind, cents: r.cents, tag: r.shown && !r.shown.listening ? r.shown.tagText : '', level });
    const octave = r.voiced ? octaveOut(r.cents, H.octaveCents) : null;
    const problem = problemFor({ voiced: r.voiced, octave, verdictKind: r.verdict.kind, verdictDir: r.verdict.dir, wobbly: g.wobbly });
    const gated = hints.push(octave ? null : problem, inTune, t * 1000);
    const offer = octaveGate.push(octave, t * 1000) || octaveOffer;
    // The same note twice (The Steps): held straight through, the ring waits for a breath.
    if (g.needsRelease && r.voiced && onLast) { if (sameSince === null) sameSince = t; } else if (!g.needsRelease) sameSince = null;
    const same = sameSince !== null && (t - sameSince) * 1000 >= C.sameNoteHintMs;
    paintHint(same ? 'same' : octave ? (offer === octave ? problem : null) : gated);
    const stuckChanged = g.stuck !== (skipBtn.textContent !== WORDS.skip);
    if (offer !== octaveOffer || stuckChanged) { octaveOffer = offer; paint(); }
    if (g.landed) onLanded(); else paintHold();
  });
  const offState = micflow.subscribe((st) => {
    const p = round.state().phase;
    paintUnder();
    const live = p === 'sing' || p === 'listen' || p === 'shape';
    if (st.phase === 'lost') { wasLost = true; if (live) pause(); }
    // Released in the middle of a take (hidden, or Pause): its clock starts again when it reopens.
    else if (st.phase === 'off' && (live || p === 'result')) wasLost = true;
    else if (st.phase === 'on' && wasLost) { wasLost = false; rebase = true; }
    if (paused) paint();                   // "The microphone is off" follows the microphone
  });

  primary.addEventListener('click', () => {
    const p = round.state().phase;
    if (paused) resume();
    else if (p === 'ready') start();
    else if (p === 'sing') pause();
    else if (p === 'result') next();
  });

  // ---- keys, pauses, settings
  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // Space from the heading (where focus lands on arrival) presses the main button
    // (review 3, finding 3). Off while a tone plays: nothing happens.
    if (spaceActs(e, { sheet: sheetOpen() })) {
      // The button that shows the key now: the main one, or the done row's own once that is up.
      const shown = [...view.querySelectorAll('[data-primary]:not([disabled])')].find((b) => !b.closest('[hidden]'));
      // Always: with the button off, Space scrolled the page instead (review 4, finding 8).
      e.preventDefault();
      if (shown) shown.click();
      return;
    }
    if (e.key === 'Escape' && !paused) { pause(); if (paused) primary.focus(); }
    if ((e.key === 'r' || e.key === 'R') && !e.repeat) { if (e.shiftKey) replayShape(); else replay(); }
  };
  const onSheet = (e) => {
    if (e.detail.open) pause();
    // The level check is over: paused means the microphone is off. Not while Carry on is
    // opening it (its own sheets close on the way).
    else if (paused && !reopening && micflow.mic) micflow.stop();
  };
  // Hidden or left: the take waits, paused, and only a press on Carry on opens it again.
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) pause(); };
  const onCalm = () => field.set({ calm: shell.calm() });
  const onPhones = () => paintUnder();
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  document.addEventListener('mt:headphones', onPhones);
  const offSettings = settings.subscribe((k) => { if (k === 'noteNames') field.set({ noteStyle: settings.get('noteNames') }); });

  paint();
  // A figure already in the sky opens whole, with its own buttons (Hear it, Sing it again).
  if (round.state().phase === 'done') showDone();

  return {
    start, next, skip, replay, replayShape, useOctave, pause, resume, lightOpen, again, hearIt,
    state: snapshot,
    field,
    destroy() {
      dead = true;
      seq++;
      // Left in the middle (Stop here, Skip this step, Back): what was held is still filed
      // in the practice record, where it used to vanish with the day's streak (bugs.md 58).
      // Nothing held: nothing filed, so a round opened and left is not a day sung.
      if (rec && recHeld > 0) rec.end();
      rec = null;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      stopTones();
      for (const hd of rewardHandles) hd.stop(0.05);
      const p = round.state().phase;
      // `starting`: a press is still waiting for the microphone; without this it would open
      // after the screen has gone and stay on with nothing using it.
      if (starting || reopening || (p !== 'ready' && p !== 'done')) micflow.stop();
      shell.setBusy(null);
      // The shell reuses this element for the next screen: leave nothing of ours on it.
      delete view.dataset.phase;
      view.classList.remove('exercise', 'constellation');
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      document.removeEventListener('mt:headphones', onPhones);
      for (const rim of rims) rim.remove();
      if (synth && !givenSynth) synth.ctx.close().catch(() => {});
      field.destroy();
    },
  };
}
