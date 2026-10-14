// matchhold.js — Match and hold, #/practice/match: hear a note, sing it, hold it inside the
// band until the ring fills (docs/design/specs/2026-10-12-singing-trainer.md section 7.3,
// the shared exercise frame of section 7, headphones rule 10.4). The first complete
// "listen, sing, hold, reward" loop.
//
// The top half is PURE and imports in Node (tools/checks/matchhold.check.mjs).
//
// CONTRACT — pure
//   roundTargets({ lowMidi?, highMidi?, home?, count?, holdSec? }, config?) -> [Timeline]
//       One exercises.heldNote timeline (js/timeline.js) per note; the target is
//       timeline.notes[0].midi. Whole semitones inside lowMidi..highMidi, starting in the
//       middle, never the same note twice running (unless the range is one note wide).
//       home (a measured singer's home note, js/app/range.js): the round starts there
//       instead of in the middle. Not a note inside the range: ignored.
//   octaveOut(cents, tolCents?) -> 'lower' | 'higher' | null
//       cents from the target. 'lower' = the voice is on the same note one octave down.
//       (The rule itself is stage.js octaveSide: the stage draws such a voice as "close".)
//   createOctaveGate(afterMs?) -> { push(side | null, tMs) -> side | null, reset() }
//       When to offer "Use my octave": the same side for afterMs without a break
//       (config.verdict.holdMs + config.hold.octaveOfferExtraMs).
//   createRound(targetMidis) -> round
//       round.state() -> { phase, index, count, stars: [boolean], octaveSemis, targetMidi }
//       phase: 'ready' | 'listen' | 'sing' | 'result' | 'done'
//       round.start()      ready -> listen
//       round.toneEnded()  listen -> sing
//       round.replay()     sing -> listen (same note)
//       round.landed()     sing -> result, the note's star is earned
//       round.next()       result -> listen on the next note, or done after the last
//       round.skip()       listen | sing -> the next note's listen, or done. No star, no penalty.
//       round.stop()       anything but ready -> done
//       round.useOctave(dir)  'lower' | 'higher': every target moves an octave for the rest
//                          of the round
//       round.again()      done -> ready, stars and octave cleared
//       A call that does not fit the phase changes nothing. Each returns state().
//   problemFor({ voiced, octave, verdictKind, verdictDir, wobbly }) -> hint key | null
//   MATCH_HINTS            hint key -> the sentence (spec 7.3, exact words)
//   PHASE_CHIP             phase -> { word, icon, role }
//   spaceActs(e, { sheet }) -> boolean   may Space press the screen's main button for this
//       keydown? True only for a first (not repeated) plain Space, with no sheet open, whose
//       target is not itself a control or a text field. Pure: reads e.key, e.repeat, e.target.
//   resultWords({ held, total, meanCents }, config?) -> { line, bias, tip }
//       meanCents: mean distance from the target over the sung readings, or null.
//       Never a failure word: 0 held still reads "0 of 5 notes held" and gets a tip.
//   nextProgress(prev, held) -> { record: { rounds, bestHeld, lastAt? }, firstTime, newBest }
//       firstTime: the first round in which anything was held (an empty first round does
//       not use it up); newBest: more than an earlier round that held something.
//   PROGRESS_KEY           'music-trainer.matchhold.v1' (read later by Progress and Today)
//
// CONTRACT — mountMatchHold(view, { shell, micflow, settings, config?, micOptions?, storage?,
//                                   synth?, range?, holdMs?, autoNext?, sessions? }) -> screen
//   sessions    js/app/sessions.js createSessions(): each finished round's scored readings
//               are handed to it (sessions.take('matchhold')). Without it nothing is recorded.
//   shell needs: needHeadphones() -> Promise<'on' | 'none' | null>, headphones(), calm(), setBusy()
//   micOptions  passed to micflow.request(): { stream } runs the screen with no microphone
//   synth       a js/synth.js synth for the reference tone and chime (the lab passes a
//               silent one); made on the first press and closed again if not given
//   range       { lowMidi, highMidi, home? } comfortable range and home note (js/app/range.js
//               exerciseRange); default config.matchhold.default*
//   autoNext    "Keep going": the next note starts by itself config.matchhold.autoNextMs
//               after a landing
//   screen.start() -> Promise<boolean>   screen.next(), skip(), stop(), replay(), again(), useOctave()
//   screen.state() -> round.state() + { paused, hold: gate.state(), octaveOffer, result, glow,
//                    looks: ['steady' | 'held' | 'recovered' | null], starRadius, imagining }
//   screen.ownVoice   the "Note sound: Plain / My voice" part (js/app/ownvoice.js), shown
//                    under the buttons until the round starts
//   The imagine beat (settings.imagine, config.matchhold.imagineMs): after the note ends the
//       round stays in 'listen' for a silent beat with the cue "Hear it in your head", and
//       only then opens the ring. Nothing is judged in it, and the microphone is exactly as
//       it is while the note plays (open, not listened to). It follows "Hear it again" too:
//       a singer who asks for the note again has lost it, which is when the beat helps most,
//       and the screen then always does the same thing after a note.
//   screen.view   the pitch view (js/app/hud.js)   screen.destroy()
//   paused (Esc, any sheet, the page hidden or left; pause()): the microphone is released,
//       every track ended, the round is kept and the drawing loop rests; only a press on
//       Resume (resume()) asks for the microphone again
//   Events: 'mt:exercise' on document, detail { exercise: 'matchhold', event, ...state }.
//       event: start | listen | tone (the reference tone really starts; detail.sound is
//              'mine' or 'plain') | imagine (the silent beat begins) | sing | landed |
//              skip | octave | done
//
// Not built here (later items): the first-time intro card with its "Keep going" tick, Blind.

import { createSynth } from '../../synth.js';
import { exercises } from '../../timeline.js';
import { CONFIG } from '../config.js';
import { createHintGate, createPitchView } from '../hud.js';
import { createHoldGate, createRimRing, drawHoldRing, drawKindleStar, heldText, smoothTowards, starRadius } from '../holdring.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { mountOwnVoice, noteTimbre } from '../ownvoice.js';
import {
  answerPlan, canChime, chimePlan, createRewardLayer, flyStar, glowLevel, LOOK_WORDS, nextRun, playAnswer, playChime,
  rewardTier, soundGuard, spreadOf, starLabel, starLook, starSvg,
} from '../rewards.js';
import { confirmSheet, h, icon, sheetOpen, STORAGE_PREFIX } from '../shell.js';
import { OCTAVE_WORDS as STAGE_OCTAVE_WORDS, octaveSide } from '../stage.js';

// ---------------------------------------------------------------- pure

export function roundTargets({ lowMidi, highMidi, home, count, holdSec } = {}, config = CONFIG) {
  const M = config.matchhold;
  const low = Math.round(lowMidi ?? M.defaultLowMidi), high = Math.max(low, Math.round(highMidi ?? M.defaultHighMidi));
  const n = count ?? M.notes;
  const mid = typeof home === 'number' && Number.isFinite(home) && home >= low && home <= high ? Math.round(home) : Math.round((low + high) / 2);
  const out = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    let midi = Math.min(high, Math.max(low, mid + M.pattern[i % M.pattern.length]));
    // A narrow range folds different steps onto one note; the same note twice running would
    // read as "nothing happened" after pressing Next.
    if (midi === prev && high > low) midi = midi + 1 <= high ? midi + 1 : midi - 1;
    out.push(exercises.heldNote(midi, { dur: holdSec ?? config.hold.holdMs / 1000 }));
    prev = midi;
  }
  return out;
}

export const octaveOut = (cents, tolCents = CONFIG.hold.octaveCents) => octaveSide(cents, tolCents);

export function createOctaveGate(afterMs = CONFIG.verdict.holdMs + CONFIG.hold.octaveOfferExtraMs) {
  let side = null, since = 0;
  return {
    push(now, tMs) {
      const s = now === 'lower' || now === 'higher' ? now : null;
      if (s !== side) { side = s; since = tMs; }
      return side && tMs - since >= afterMs ? side : null;
    },
    reset() { side = null; },
  };
}

export function createRound(targetMidis) {
  const count = targetMidis.length;
  let phase = 'ready', index = 0, stars = targetMidis.map(() => false), octaveSemis = 0;
  const state = () => ({ phase, index, count, stars: [...stars], octaveSemis, targetMidi: targetMidis[index] + octaveSemis });
  const advance = () => { if (index + 1 < count) { index++; phase = 'listen'; } else phase = 'done'; };
  return {
    state,
    start() { if (phase === 'ready' && count) phase = 'listen'; return state(); },
    toneEnded() { if (phase === 'listen') phase = 'sing'; return state(); },
    replay() { if (phase === 'sing') phase = 'listen'; return state(); },
    landed() { if (phase === 'sing') { stars[index] = true; phase = 'result'; } return state(); },
    next() { if (phase === 'result') advance(); return state(); },
    skip() { if (phase === 'listen' || phase === 'sing') advance(); return state(); },
    stop() { if (phase !== 'ready') phase = 'done'; return state(); },
    useOctave(dir) {
      if (phase !== 'done' && (dir === 'lower' || dir === 'higher')) octaveSemis += dir === 'lower' ? -12 : 12;
      return state();
    },
    again() { if (phase === 'done') { phase = 'ready'; index = 0; stars = targetMidis.map(() => false); octaveSemis = 0; } return state(); },
  };
}

// Space presses the main button from wherever focus lands on arrival (the heading, review 3
// finding 3: a shown key must work). It stays out of the way when the target has its own use
// for Space: a button or link (the browser presses it; acting here too would press twice or
// press the wrong one), a text field, a select, or anything with a control's role.
const OWN_SPACE_TAGS = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
const OWN_SPACE_ROLES = /^(button|link|checkbox|switch|radio|tab|option|menuitem|slider|textbox|combobox)$/;
export function spaceActs(e, { sheet = false } = {}) {
  if (!e || e.key !== ' ' || e.repeat || sheet) return false;
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target;
  if (!t || typeof t !== 'object') return true;
  if (t.isContentEditable || OWN_SPACE_TAGS.test(String(t.tagName || '').toUpperCase())) return false;
  const role = typeof t.getAttribute === 'function' ? t.getAttribute('role') : null;
  return !(role && OWN_SPACE_ROLES.test(role));
}

export const MATCH_HINTS = Object.freeze({
  under: 'You’re under it. Slide up slowly until the line enters the band.',
  over: 'You’re over it. Let the note sink down into the band.',
  wobble: 'Almost. Pick one steady ‘ah’ and keep the air moving.',
  'octave-lower': 'That’s the same note in a lower voice. Try the higher one, or press ‘Use my octave’.',
  'octave-higher': 'That’s the same note in a higher voice. Try the lower one, or press ‘Use my octave’.',
});

// One set of words for the stage chip here and the read-out's chip (stage.js).
export const OCTAVE_WORDS = STAGE_OCTAVE_WORDS;

export const PHASE_CHIP = Object.freeze({
  ready: { word: 'Ready', icon: 'play', role: 'quiet' },
  listen: { word: 'Listen', icon: 'speaker', role: 'quiet' },
  // The silent beat after the note: the cue is the whole instruction (no "Imagine" label
  // that needs explaining).
  imagine: { word: 'Hear it in your head', icon: 'music-note', role: 'quiet' },
  sing: { word: 'Sing', icon: 'mic', role: 'quiet' },
  result: { word: 'Held', icon: 'tick', role: 'good' },
  paused: { word: 'Paused', icon: 'pause', role: 'quiet' },
  done: { word: 'Round done', icon: 'star', role: 'quiet' },
});

// One problem at a time. The octave comes first (the other words would be wrong for it:
// "17 notes low" is no help to someone singing the right note an octave down); a wobble
// outranks "a little low" because the singer is already at the band.
export function problemFor({ voiced = false, octave = null, verdictKind = null, verdictDir = null, wobbly = false } = {}) {
  if (!voiced) return null;
  if (octave) return `octave-${octave}`;
  const side = verdictDir === 'low' ? 'under' : verdictDir === 'high' ? 'over' : null;
  if (verdictKind === 'off') return side;
  if (wobbly) return 'wobble';
  return verdictKind === 'close' ? side : null;
}

export function resultWords({ held, total, meanCents = null }, config = CONFIG) {
  const bias = !Number.isFinite(meanCents) ? null : meanCents < -config.matchhold.biasCents ? 'low' : meanCents > config.matchhold.biasCents ? 'high' : 'centred';
  const said = { low: 'You were mostly a little low', high: 'You were mostly a little high', centred: 'You were right on the notes' }[bias];
  const tip = bias === 'low' ? 'Tip: slide up into the band, then hold still.'
    : bias === 'high' ? 'Tip: let the note sink down into the band, then hold still.'
      : held < total ? 'Tip: pick one steady ‘ah’ and keep the air moving.'
        : 'Tip: start each note gently, right on the band.';
  return { line: [`${held} of ${total} notes held`, said].filter(Boolean).join(' · '), bias, tip };
}

export const PROGRESS_KEY = `${STORAGE_PREFIX}matchhold.v1`;

export function nextProgress(prev, held, nowIso) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const rounds = Number.isFinite(p.rounds) ? p.rounds : 0, best = Number.isFinite(p.bestHeld) ? p.bestHeld : 0;
  return {
    record: { rounds: rounds + 1, bestHeld: Math.max(best, held), ...(nowIso ? { lastAt: nowIso } : {}) },
    // "First time" is the first round in which anything was held. It used to be the first
    // round whatever happened, so Start then Stop used it up and the first real success
    // said "New best" (bugs.md 28). A best of nothing cannot be beaten, only begun.
    firstTime: best === 0 && held > 0,
    newBest: best > 0 && held > best,
  };
}

// ---------------------------------------------------------------- browser: the screen

export function mountMatchHold(view, {
  shell, micflow, settings, config = CONFIG, micOptions, storage, synth: givenSynth = null, range = {}, holdMs, autoNext = false,
  sessions = null,
} = {}) {
  // The round's scored readings, for the practice record and the coach (js/app/sessions.js).
  let rec = null, recHeld = 0;
  const M = config.matchhold, H = config.hold, R = config.rewards;
  const store = storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  const smallMq = window.matchMedia('(max-width: 639px), (max-height: 519px)');
  const holdTotalMs = holdMs ?? H.holdMs;
  const timelines = roundTargets({ ...range, holdSec: holdTotalMs / 1000 }, config);
  const round = createRound(timelines.map((tl) => tl.notes[0].midi));
  const gate = createHoldGate({ ...H, holdMs: holdTotalMs });
  const hints = createHintGate(config.hud);
  const octaveGate = createOctaveGate(config.verdict.holdMs + H.octaveOfferExtraMs);
  // The stage is under 380 px tall exactly when the window is under 720 (app.css .stage).
  const shortMq = window.matchMedia('(max-height: 719px)');
  const textEvery = createEvery(1000 / H.textHz);

  let synth = givenSynth, tone = null, seq = 0, dead = false, starting = false, paused = false, reopening = false, why = '', waitWhy = '', underKey = null;
  let tOffset = 0, lastT = null, rebase = true;
  let landedAtMs = null, landedMidi = null, head = null, headMidi = null, stageShift = 0, stageRebase = false, lastStageT = null, wasLost = false;
  const band = { k: 0, on: false, midi: null, atMs: 0 };
  const pendingStars = new Set();
  let looks = [], inCents = [], starShown = 0, starAtMs = 0, gold = null, goldFor = null;
  // The last reward sound: when it began (performance.now) and how long it lasts. The next
  // reference tone waits for it to be silent (rewards.js soundGuard).
  let rewardAtMs = null, rewardEndMs = null, rewardHandles = [];
  // No reference tone may start before this (performance.now). Kept across calls: Skip or a
  // pause and resume inside the wait must not let the next tone start early.
  let quietUntilMs = 0;
  let run = 0, lastLandMs = null, inRow = 0, glow = 0, sumCents = 0, nCents = 0;
  let octaveOffer = null, hintKey = null, result = null;
  // The silent beat between the note and the ring (the round is still in 'listen').
  let imagining = false;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };

  // ---- the page
  const stepText = h('p', { class: 'ex-step' });
  const tray = h('ol', { class: 'star-tray' });
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, 'aria-describedby': 'match-why' });
  const primaryWhy = h('p', { class: 'reason', id: 'match-why' });
  const hearBtn = h('button', { class: 'btn btn-secondary', type: 'button', hidden: true, onclick: () => replay() },
    icon('replay', 16), ' Hear it again ', h('kbd', { class: 'keycap' }, 'R'));
  const octaveBtn = h('button', { class: 'btn btn-secondary octave-btn', type: 'button', hidden: true, onclick: () => useOctave() }, 'Use my octave');
  const skipBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true, onclick: () => skip() }, 'Skip');
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const bannerSlot = h('div'), viewHost = h('div'), cardSlot = h('div', { class: 'done-slot' });
  // Under the buttons, so that hiding it when the round starts moves nothing above it.
  const voiceSlot = h('div', { class: 'ov-slot' });
  view.classList.add('exercise');
  view.append(
    h('div', { class: 'title-row ex-head' },
      h('a', { class: 'btn btn-quiet back', href: '#/practice' }, icon('back', 16), ' Back'),
      h('h1', { tabindex: '-1' }, 'Match and hold'), stepText, tray),
    h('p', { class: 'reason' }, `Hear a note, then sing it and hold it inside the band for ${holdTotalMs / 1000} seconds.`),
    bannerSlot, viewHost, underLine, cardSlot,
    h('div', { class: 'action-row' }, hearBtn, octaveBtn, h('div', { class: 'action-main' }, primary, primaryWhy), skipBtn),
    voiceSlot);
  // The view slides to each new note more slowly than elsewhere (see config.matchhold).
  const pv = createPitchView(viewHost, { config: { ...config, stage: { ...config.stage, recentreMaxSemisPerSec: M.recentreMaxSemisPerSec } } });
  // Signal problems go in the reserved line under the stage (paintUnder): a banner opening
  // here moved the stage 96 px under the singer's eyes and the buttons off the screen.
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });

  // On the stage: the phase word (top left), the octave chip beside it, the round-done card.
  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const phaseChip = h('div', { class: 'chip phase-chip', 'aria-live': 'polite' }, chipIcon, chipWord);
  const octaveChip = h('div', { class: 'chip octave-chip', dataset: { role: 'close' }, hidden: true },
    h('span', { class: 'octave-dots', 'aria-hidden': 'true' }, h('i'), h('i')), h('span'));
  const doneCard = h('section', { class: 'done-card', hidden: true, 'aria-label': 'Round done' });
  pv.stage.el.append(h('div', { class: 'stage-chips' }, phaseChip, octaveChip), doneCard);

  // In the read-out: the same ring value on the rim of the note ring, the count in words,
  // and this exercise's own hints in place of the general ones.
  const rims = [...pv.el.querySelectorAll('.note-ring')].map((el) => createRimRing(el));
  const heldLine = h('p', { class: 'hud-held' });
  pv.hud.el.querySelector('.hud-ring').append(heldLine);
  const hintLine = h('p', { class: 'hud-hint ex-hint' });
  pv.hud.el.querySelector('.hud-hint').after(hintLine);

  const layer = createRewardLayer(pv.stage, { config, calm: () => shell.calm() });

  // The ring round the head dot and the held band, above everything else on the stage.
  function drawHeldBand(ctx, G, tokens, a) {
    if (!(a > 0)) return;
    const half = config.verdict.inTuneCents / 100, top = G.yOfMidi(band.midi + half);
    ctx.save();
    ctx.globalAlpha = tokens.aGoodWash * a;
    ctx.fillStyle = tokens.good;
    ctx.beginPath();
    ctx.roundRect(G.plotX, top, G.plotW, 2 * half * G.laneH, 6);
    ctx.fill();
    // The tick: "held" never rests on the colour alone. Beside the head tag, where the
    // eyes are (at the band's far end it was 500 px away; review 2, 11).
    ctx.font = `600 14px ${tokens.font}`;
    const tag = pv.stage.debug().tag || 'on it';
    const tx = G.nowX + 12 + ctx.measureText(tag).width + 16 + 12, ty = G.yOfMidi(band.midi);
    ctx.globalAlpha = a;
    ctx.strokeStyle = tokens.good;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(tx, ty); ctx.lineTo(tx + 5, ty + 5); ctx.lineTo(tx + 14, ty - 6);
    ctx.stroke();
    ctx.restore();
  }

  pv.stage.addLayer((ctx, L, tokens, view) => {
    if (dead) return;
    const s = round.state(), g = gate.state(), now = performance.now();
    // The held band turns green and, on the next note, lets go again. A wide area, so both
    // ways are eased: never a snap. It lets go faster (bandClearMs), so it has gone before
    // the view slides to the next note.
    const dt = Math.min(100, Math.max(0, now - band.atMs));
    band.atMs = now;
    band.k = Math.min(1, Math.max(0, band.k + (band.on ? dt / R.bandFillMs : -dt / R.bandClearMs)));
    if (band.k > 0 && band.midi !== null) {
      const from = view && view.from;
      // While the stage cross-fades to another view the band belongs to the old picture:
      // letting go, it stays there; still held (the round-done recentre), it fades across.
      if (from && !band.on) drawHeldBand(ctx, from, tokens, band.k);
      else if (from) { drawHeldBand(ctx, from, tokens, band.k * (1 - view.k)); drawHeldBand(ctx, L, tokens, band.k * view.k); }
      else drawHeldBand(ctx, L, tokens, band.k);
    }
    if (s.phase !== 'sing' && s.phase !== 'result') return;
    const y = headMidi === null ? null : L.yOfMidi(headMidi);
    head = y === null ? null : { x: L.nowX, y };
    if (y === null || y < 0 || y > ctx.canvas.clientHeight) return;
    let thick = 1;
    if (landedAtMs !== null) {
      const since = now - landedAtMs;
      if (since <= H.thickenMs) thick = H.thickenBy;
      // Moving: after the thickening the ring hands off to the burst's expanding ring.
      // Calm motion: a still ring for the same 600 ms, and nothing expands.
      else if (!shell.calm() || since > R.burstMs) return;
    }
    drawHoldRing(ctx, {
      x: L.nowX, y, radius: H.headRadiusPx, progress: g.progress, track: tokens.target, fill: tokens.good,
      width: H.headWidthPx, trackOpacity: H.trackOpacity, thick,
    });
    drawStar(ctx, L.nowX, y, g.progress, tokens, now);
  });

  // The star kindling inside the ring: a plain function of the ring's fill, shown through
  // a short smoothing so it cannot jitter. Under calm motion it has no halo.
  function drawStar(ctx, x, y, progress, tokens, now) {
    if (goldFor !== tokens) {
      const cs = getComputedStyle(pv.stage.el), v = (n) => cs.getPropertyValue(n).trim();
      gold = { fill: v('--gold-fill'), line: v('--gold'), glowOpacity: parseFloat(v('--a-gold-glow')) || 0.3 };
      goldFor = tokens;
    }
    const goal = progress > 0.001 ? starRadius(progress, H.star) : 0;
    starShown = smoothTowards(starShown, goal, now - starAtMs, H.star.smoothMs);
    starAtMs = now;
    if (starShown < 0.5 || pendingStars.size) return;      // while it flies it is not here too
    drawKindleStar(ctx, {
      x, y, outer: starShown, fill: gold.fill, outline: gold.line, glow: gold.line,
      halo: shell.calm() ? 0 : gold.glowOpacity * H.star.haloOpacity * progress, cfg: H.star,
    });
  }

  const keycap = (k = 'Space') => h('kbd', { class: 'keycap' }, k);
  const snapshot = () => ({ ...round.state(), paused, hold: gate.state(), octaveOffer, result, glow, looks: [...looks], starRadius: starShown, imagining });
  const emit = (event, more) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: 'matchhold', event, ...snapshot(), ...more } }));

  // "Note sound: Plain / My voice" and "Teach it your voice". Its teaching step opens the
  // microphone by itself, so the round cannot start while it runs (and the other way round).
  const ownVoice = mountOwnVoice(voiceSlot, {
    micflow, shell, settings, storage: store, config, micOptions,
    // The measured home note when there is one; with no range saved no note is played and
    // any comfortable note will do (only the harmonics are kept, not the pitch).
    home: typeof range.home === 'number' && Number.isFinite(range.home) ? Math.round(range.home) : null,
    synth: () => { synth = synth || createSynth(); return synth; },
    onChange: () => { if (!dead) paint(); },
  });

  function paintTray() {
    const s = round.state(), earned = s.stars.filter(Boolean).length;
    tray.setAttribute('aria-label', `${earned} of ${s.count} stars`);
    // Only what changed is touched, so an earned star fades in once and never again.
    while (tray.children.length < s.count) tray.append(h('li', { class: 'tray-star' }));
    s.stars.forEach((on, i) => {
      const li = tray.children[i];
      const shown = on && !pendingStars.has(i);  // filled when its flying star arrives
      const look = shown ? looks[i] || 'held' : '';
      // The look is always said in words too: here, and on the stage chip when it lands.
      li.setAttribute('aria-label', starLabel(i + 1, s.count, on ? looks[i] || 'held' : null));
      if (li.dataset.look === look && li.firstChild) return;
      li.dataset.look = look;
      li.toggleAttribute('data-earned', shown);
      li.replaceChildren(starSvg(look || 'held', R.trayStarPx), shown ? icon('tick', 10) : '');
    });
  }

  function paintHold(force = false) {
    const g = gate.state(), s = round.state();
    const showing = s.phase === 'sing' || s.phase === 'result';
    for (const rim of rims) rim.set(showing ? g.progress : 0, { landed: s.phase === 'result', star: !pendingStars.size });
    if (!force && !textEvery.due(performance.now())) return;
    const text = showing ? heldText(g.heldMs, g.holdMs) : '';
    if (heldLine.textContent !== text) heldLine.textContent = text;
  }

  function paintHint(key) {
    if (key === hintKey) return;
    hintKey = key;
    hintLine.textContent = key ? MATCH_HINTS[key] : '';
    hintLine.classList.toggle('is-shown', !!key);
  }

  function paint() {
    const s = round.state(), g = gate.state();
    const phase = paused ? 'paused' : s.phase === 'listen' && imagining ? 'imagine' : s.phase;
    const chip = PHASE_CHIP[phase];
    chipIcon.replaceChildren(icon(chip.icon, 16));
    chipWord.textContent = phase === 'result' ? LOOK_WORDS[looks[s.index]] || chip.word : chip.word;
    phaseChip.dataset.role = chip.role;
    stepText.textContent = s.phase === 'done' ? 'Round done' : `Note ${s.index + 1} of ${s.count}`;
    octaveChip.hidden = !(octaveOffer && s.phase === 'sing');
    octaveChip.lastChild.textContent = octaveOffer ? OCTAVE_WORDS[octaveOffer] : '';
    octaveBtn.hidden = octaveChip.hidden;

    const last = s.index + 1 === s.count;
    const busy = starting || reopening;
    const teaching = ownVoice.busy();
    const label = busy ? 'Starting…' : { ready: 'Start', listen: 'Listening…', imagine: 'Imagine it…', sing: 'Stop', result: last ? 'Finish' : 'Next', paused: 'Resume', done: '' }[phase];
    const off = busy || teaching || phase === 'listen' || phase === 'imagine';
    primary.replaceChildren(label, off ? '' : ' ', off ? '' : keycap());
    // Hidden AND off when the round is done: Space must reach the card's own button.
    primary.disabled = off || phase === 'done';
    primary.hidden = phase === 'done';
    // While singing the main button is the quiet kind: nothing bright under the eyes.
    primary.className = `btn ${phase === 'sing' ? 'btn-secondary' : 'btn-primary'}`;
    primaryWhy.textContent = busy ? waitWhy : phase === 'listen' ? 'The note is playing. The microphone waits until it ends.'
      : phase === 'imagine' ? 'Hear the note in your head. Then it’s your turn.'
      : teaching ? 'Teaching your voice. Start when it has finished.'
      : phase === 'paused' && !micflow.mic && micflow.state().phase !== 'lost' ? 'The microphone is off. Press Resume to turn it back on.' : why;
    hearBtn.hidden = !(s.phase === 'sing' && !paused);
    skipBtn.hidden = !(s.phase === 'listen' || s.phase === 'sing') || paused;
    skipBtn.textContent = g.stuck ? 'Skip this note (you can come back)' : 'Skip';
    paintUnder();
    // Only before the round: once it starts, the stage is the one thing to look at.
    voiceSlot.hidden = s.phase !== 'ready';
    view.dataset.phase = phase;
    paintTray();
    paintHold(true);
  }

  // The one reserved line under the stage. A signal problem (no sound, too quiet, too loud,
  // noise) takes it over while it lasts: icon, sentence, one quiet button. Its height is
  // fixed in app.css, so nothing on the page moves when it changes.
  function paintUnder() {
    const s = round.state(), phones = shell.headphones();
    const banner = micflow.state().banner;
    const problem = SIGNAL_PROBLEMS.includes(banner) ? banner : null;
    const text = problem ? MIC_WORDS[problem] : [
      phones === 'none' ? 'No headphones: the note plays first, then it’s your turn.' : '',
      s.octaveSemis ? `Using your octave: targets are one octave ${s.octaveSemis < 0 ? 'lower' : 'higher'} for this round.` : '',
    ].filter(Boolean).join(' ');
    const key = `${problem || ''}|${text}`;
    if (key === underKey) return;          // untouched while unchanged: its button keeps focus
    underKey = key;
    underLine.dataset.role = problem ? 'close' : '';
    if (!problem) { underLine.replaceChildren(text); return; }
    underLine.replaceChildren(...[
      icon(problem === 'silence' ? 'mic-off' : 'warning', 16), h('span', null, text),
      problem === 'silence' && h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => micflow.openLevelCheck() }, 'Test the mic'),
    ].filter(Boolean));
  }

  const viewPatch = (state) => ({
    state, noteStyle: settings.get('noteNames'), calm: shell.calm(),
    meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches,
    target: { midi: round.state().targetMidi }, nowFrac: config.stage.nowFracTarget,
    // An octave away is drawn as "close", never "off"; each target is a new note (the old
    // trail fades before the view slides); the phase chip owns the top left corner.
    octaveCents: H.octaveCents, freshTarget: true, labelClearTopPx: 40,
  });

  // ---- the round
  const guard = async () => {
    const wasSinging = (round.state().phase === 'sing' || round.state().phase === 'result') && !paused;
    const leave = await confirmSheet({ title: 'Leave this round? Any notes you held are kept.', yes: 'Leave', no: 'Keep singing' });
    // The sheet paused the round; "Keep singing" should mean exactly that.
    if (!leave && wasSinging && paused) resume();
    return leave;
  };

  async function start() {
    if (round.state().phase !== 'ready' || starting || ownVoice.busy()) return false;
    starting = true; why = ''; waitWhy = 'Waiting for your headphones answer.';
    paint();
    const fail = (text) => { starting = false; why = text; paint(); return false; };
    // Before the first reference tone of a visit (spec 10.4): the answer decides whether a
    // reward chime may sound at all.
    const phones = await shell.needHeadphones();
    if (dead) return false;
    if (!phones) return fail('Say whether you are wearing headphones, then press Start.');
    waitWhy = 'Waiting for the microphone.';
    paint();
    const ok = await micflow.request(micOptions || {});
    if (dead) return false;
    if (!ok) return fail('The microphone is not on yet.');
    try { synth = synth || createSynth(); } catch { return fail('This browser could not start sound.'); }
    starting = false;
    pv.clear();
    gate.reset();
    lastT = null; tOffset = 0; rebase = true; lastStageT = null; stageShift = 0; pendingStars.clear(); looks = []; run = 0; lastLandMs = null; inRow = 0; sumCents = 0; nCents = 0; result = null;
    setGlow(0);
    round.start();
    rec = sessions ? sessions.take('matchhold') : null;
    recHeld = 0;
    shell.setBusy(guard);
    emit('start');
    listen(true);
    return true;
  }

  // landedMidi is kept: the release rule needs to know which note was held last.
  function clearNote() {
    landedAtMs = null; headMidi = null; head = null; band.on = false; inCents = []; starShown = 0;
    octaveOffer = null;
    hints.reset();
    octaveGate.reset();
    paintHint(null);
  }

  // The reference tone. The microphone is not scored while it sounds: without headphones it
  // would hear the speaker, and the line would follow the tone instead of the singer.
  function listen(fresh) {
    const mine = ++seq;
    if (tone) tone.stop();
    imagining = false;
    micflow.setListening(false);
    if (fresh) { gate.next(); clearNote(); }
    paused = false;
    pv.set(viewPatch('tone'));
    pv.stage.start();
    paint();
    emit('listen');
    // A reward sound must be silent for guardMs before the tone (and so before any
    // scoring). Next pressed early: the voices fade out first.
    const nowMs = performance.now();
    if (rewardAtMs !== null) {
      const guardNow = soundGuard({ sinceMs: nowMs - rewardAtMs, endMs: rewardEndMs }, R.answer);
      if (guardNow.fade) for (const hd of rewardHandles) hd.stop(R.answer.earlyFadeMs / 1000);
      quietUntilMs = Math.max(quietUntilMs, nowMs + guardNow.waitMs);
      rewardAtMs = null; rewardHandles = [];
    }
    const waitMs = quietUntilMs - nowMs;
    const play = () => {
      if (dead || mine !== seq) return;
      // The target note only: "My voice" is the singer's own harmonics at the target's
      // pitch; rewards and every other screen keep the plain tones.
      const plain = settings.get('tone') === 'sine' ? 'sine' : 'voice';
      const timbre = noteTimbre(settings.get('noteSound'), ownVoice.record(), plain);
      emit('tone', { sound: timbre === plain ? 'plain' : 'mine' });
      tone = synth.play({ midi: round.state().targetMidi, dur: M.toneSec, timbre, gain: 0.5 * settings.get('toneVolume'), tag: 'tone' });
      const open = () => {
        if (dead || mine !== seq) return;
        imagining = false;
        round.toneEnded();
        sing();
      };
      tone.ended.then(() => new Promise((r) => setTimeout(r, M.toneTailMs))).then(() => {
        if (dead || mine !== seq) return;
        tone = null;
        if (settings.get('imagine') === false || !(M.imagineMs > 0)) { open(); return; }
        // Listen, imagine, then sing. The round stays in 'listen': the microphone is as it
        // was while the note played (open, not listened to), and nothing reaches the ring.
        imagining = true;
        paint();
        emit('imagine');
        later(open, M.imagineMs);
      });
    };
    if (waitMs > 0) later(play, waitMs); else play();
  }

  function sing() {
    // The microphone stopped while the note played (or before it), or was released because
    // the page was hidden (bugs.md 31): wait, paused. This runs from a timer, so it must not
    // open the microphone itself; Resume does, from a press.
    if (!micflow.mic) { pause(); if (micflow.state().phase === 'lost') pv.set({ state: 'lost' }); return; }
    paused = false;
    stageRebase = true;
    pv.set(viewPatch('live'));
    pv.stage.start();
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

  function setGlow(level) { glow = level; layer.setGlow(level); }

  function onLanded() {
    const s = round.state(), index = s.index, now = performance.now();
    looks[index] = starLook({ spread: spreadOf(inCents), drained: gate.state().drained }, R);
    landedMidi = s.targetMidi;
    landedAtMs = now;
    band.on = true; band.midi = landedMidi;
    if (rec) { rec.landed(index); recHeld++; }
    round.landed();
    // Scoring stops first; only then may a chime sound (never while a note is being judged).
    micflow.setListening(false);
    run = nextRun(run, lastLandMs, now, R.runWindowMs);
    lastLandMs = now;
    inRow++;
    setGlow(glowLevel(inRow, R));
    paintHint(null);
    octaveOffer = null;
    const at = head ? { ...head } : null, atMidi = headMidi, calm = shell.calm();
    const box = pv.stage.canvas.getBoundingClientRect();
    const flies = !calm && !!at && box.width > 0;
    if (flies) pendingStars.add(index);
    paint();
    emit('landed');
    // The thickened ring hands off to the burst.
    const answer = answerPlan(landedMidi, inRow, R.answer);
    later(() => { if (at) layer.burst({ x: at.x, y: at.y, midi: atMidi, tier: 'note', run, look: looks[index], echoes: answer.voices.length }); }, H.thickenMs);
    if (flies) {
      flyStar({ from: { x: box.left + at.x, y: box.top + at.y }, to: tray.children[index], look: looks[index], fromRadius: Math.max(4, starShown), ms: R.starFlightMs })
        .then(() => { pendingStars.delete(index); if (!dead) paintTray(); });
    }
    if (canChime({ enabled: settings.get('rewardSounds'), headphones: shell.headphones(), scoring: false })) {
      // The sky answers in the singer's own note (rewards-ideas spec 5 C).
      rewardHandles = playAnswer(synth, answer, 0.5 * settings.get('toneVolume'), R.answer);
      rewardAtMs = now; rewardEndMs = answer.endMs;
    }
    primary.focus({ preventScroll: true });
    if (autoNext) later(() => { if (round.state().phase === 'result' && round.state().index === index) next(); }, M.autoNextMs);
  }

  function afterAdvance() {
    if (round.state().phase === 'done') finish(); else listen(true);
  }
  function next() {
    if (round.state().phase !== 'result' || paused) return;
    round.next();
    afterAdvance();
  }
  function skip() {
    const p = round.state().phase;
    if (p !== 'listen' && p !== 'sing') return;
    // A skipped note earns nothing and costs nothing: the glow eases back, no other sign.
    inRow = 0;
    setGlow(0);
    round.skip();
    emit('skip');
    afterAdvance();
  }
  function stop() {
    if (round.state().phase === 'ready' || round.state().phase === 'done') return;
    round.stop();
    finish();
  }

  function useOctave() {
    if (!octaveOffer || round.state().phase !== 'sing') return;
    round.useOctave(octaveOffer);
    octaveOffer = null;
    hints.reset();
    octaveGate.reset();
    paintHint(null);
    // An octave is a view jump: the stage cross-fades to the new centre (no slide) and
    // drops the old trail, which was drawn against the note the round no longer uses.
    pv.set({ target: { midi: round.state().targetMidi } });
    paint();
    emit('octave');
  }

  function finish() {
    seq++;
    imagining = false;
    if (tone) { tone.stop(); tone = null; }
    micflow.stop();
    shell.setBusy(null);
    paused = false;
    const s = round.state(), held = s.stars.filter(Boolean).length;
    let prev = null;
    try { prev = JSON.parse((store && store.getItem(PROGRESS_KEY)) || 'null'); } catch { /* unreadable: counts as a first round */ }
    const prog = nextProgress(prev, held, new Date().toISOString());
    try { if (store) store.setItem(PROGRESS_KEY, JSON.stringify(prog.record)); } catch { /* full or blocked: the round still ends */ }
    const tier = rewardTier(prog);
    const words = resultWords({ held, total: s.count, meanCents: nCents ? sumCents / nCents : null }, config);
    result = { held, total: s.count, tier, ...words, record: prog.record };
    setGlow(0);
    // The microphone is off now: the read-out must not go on saying "In tune".
    pv.hud.update(null, 0);
    // The last band goes back to the middle, clear of the card.
    pv.stage.recentre();
    paint();
    showDone();
    // After the card: the coach's few words go under it. (A round left in the middle is
    // filed by destroy(), with no card: the screen has gone.)
    if (rec) { rec.end(); rec = null; }
    emit('done');
    if (tier === 'note') { later(() => pv.stage.stop(), R.burstMs + 200); return; }
    // The round's own celebration, behind the card. It waits its turn: never two bursts
    // inside burstMinGapMs.
    const wait = lastLandMs === null ? 0 : Math.max(0, R.burstMinGapMs - (performance.now() - lastLandMs)) + 20;
    later(() => {
      const box = pv.stage.canvas.getBoundingClientRect();
      layer.burst({ x: box.width / 2, y: box.height * 0.4, tier, run: 1 });
      if (canChime({ enabled: settings.get('rewardSounds'), headphones: shell.headphones(), scoring: false }) && synth) {
        const plan = chimePlan(tier, 1, R);
        rewardHandles = playChime(synth, plan, R.chimeGainFrac * 0.5 * settings.get('toneVolume'));
        rewardAtMs = performance.now(); rewardEndMs = 20 + 1000 * Math.max(...plan.map((n) => n.at + n.dur));
      }
      later(() => pv.stage.stop(), R.burstMs + 400);
    }, wait);
  }

  function showDone() {
    const r = result;
    const againBtn = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, onclick: () => again() }, 'Again ', keycap());
    const tierChip = r.tier === 'note' ? null
      : h('span', { class: 'chip', dataset: { role: r.tier === 'best' ? 'gold' : 'accent' } }, icon('star', 16), r.tier === 'best' ? 'New best' : 'First time');
    doneCard.replaceChildren(
      h('div', { class: 'done-top' },
        h('div', { class: 'done-stars', role: 'img', 'aria-label': `${r.held} of ${r.total} stars` },
          round.state().stars.map((on, i) => h('span', { class: 'tray-star', 'data-earned': on || null, dataset: { look: on ? looks[i] || 'held' : '' } },
            starSvg(on ? looks[i] || 'held' : 'held', R.trayStarPx), on ? icon('tick', 12) : null))),
        tierChip),
      h('p', { class: 'done-line' }, r.line),
      h('p', { class: 'reason' }, r.tip),
      h('div', { class: 'action-row' }, againBtn, h('a', { class: 'btn btn-quiet', href: '#/practice' }, 'Back to Practice')));
    doneCard.dataset.tier = r.tier;
    placeDone();
    doneCard.hidden = false;
    againBtn.focus({ preventScroll: true });
  }

  // On a short stage the card would cover nearly half of the take: it goes under the stage
  // instead, where the (now empty) action row was (review 2, finding 6).
  function placeDone() {
    const below = shortMq.matches, host = below ? cardSlot : pv.stage.el;
    doneCard.classList.toggle('is-below', below);
    view.classList.toggle('done-below', below);
    if (doneCard.parentNode !== host) host.append(doneCard);
  }

  async function again() {
    if (round.state().phase !== 'done') return false;
    // The finished round's timers (its celebration and chime, "stop drawing") must not fire
    // inside the new round: the chime would sound over the next note, and the stage would
    // stop drawing while the singer is being scored.
    for (const id of timers) clearTimeout(id);
    timers.clear();
    pv.stage.stop();
    doneCard.hidden = true;
    round.again();
    clearNote();
    landedMidi = null; band.k = 0; band.midi = null; looks = [];
    result = null;
    pv.clear();
    pv.set(viewPatch('idle'));
    paint();
    return start();
  }

  // Paused means the microphone is off (owner rule 2026-10-12): Esc, any sheet, the page
  // hidden or left all release it, every track ended, as Find your range does. Until
  // 2026-10-12 Esc and a sheet only stopped the listening and left the microphone open
  // behind a screen that said "Paused". The round is kept; Resume opens it again.
  // The drawing loop rests too, after the curtain of light has eased out (stopped at once,
  // it went in one frame): a paused picture is one still frame.
  // One sheet needs the microphone: the mic flow's own level check ('checking'), which the
  // singer opened with "Test the mic". Released at once, that sheet stood open with a dead
  // level bar. The round still pauses, and the microphone goes when the sheet closes (onSheet).
  // A held note with "Next" showing ('result') pauses too: the microphone is open there,
  // waiting for the next note, and until 2026-10-12 nothing but a hidden page released it.
  const REST_MS = ((config.aurora && config.aurora.cutFadeMs) || 600) + 150;
  function pause() {
    const p = round.state().phase;
    if (paused || (p !== 'sing' && p !== 'listen' && p !== 'result')) return;
    if (p === 'listen') { seq++; if (tone) { tone.stop(); tone = null; } imagining = false; round.toneEnded(); }
    paused = true;
    micflow.setListening(false);
    // Lost (unplugged) has nothing open and keeps its Reconnect banner.
    const flow = micflow.state().phase;
    if (micflow.mic && flow !== 'lost' && flow !== 'checking') micflow.stop();
    pv.set({ state: 'paused' });
    paint();
    later(() => { if (paused) pv.stage.stop(); }, REST_MS);
  }
  // Only ever reached from a press (the button, Space, the paused card, "Keep singing"), so
  // it may open the microphone again.
  async function resume() {
    if (!paused || reopening) return;
    const s0 = round.state();
    // Paused on the last held note: the round ends; no microphone is needed.
    if (s0.phase === 'result' && s0.index + 1 === s0.count) { paused = false; pv.set({ state: 'live' }); next(); return; }
    if (!micflow.mic) {
      reopening = true; waitWhy = 'Waiting for the microphone.';
      paint();
      const ok = await micflow.request(micOptions || {});
      reopening = false;
      if (dead) return;
      if (!ok || !paused) { paint(); return; }
    }
    // Paused on a held note: on to the next one, as Next would.
    if (round.state().phase === 'result') { paused = false; next(); return; }
    // The note plays again: after a break nobody remembers the pitch.
    round.replay();
    listen(false);
  }

  const offFrame = micflow.onFrame((frame, level) => {
    const s = round.state();
    if (dead || (s.phase !== 'sing' && s.phase !== 'listen' && s.phase !== 'result')) return;
    // Each time the microphone is opened its clock starts again; the take must not run
    // backwards, so later readings follow the last one (with a visible gap).
    if (rebase) { tOffset = lastT === null ? -frame.t : lastT + 0.5 - frame.t; rebase = false; }
    const t = frame.t + tOffset;
    lastT = t;
    const onLast = frame.voiced && landedMidi !== null && Math.abs(frame.midi - landedMidi) * 100 <= config.verdict.closeCents;
    if (s.phase !== 'sing' || paused) {
      // Not scored. Only the release rule watches (has the last note been let go?).
      gate.push({ tMs: t * 1000, inTune: false, voiced: frame.voiced, scoring: false, onLast });
      return;
    }
    // The stage's own clock skips the time the reference tone took: the line shows a short
    // gap there instead of leaping a whole tone's length sideways in one frame. The ring's
    // clock (t) is never bent.
    if (stageRebase) { stageShift = lastStageT === null ? 0 : lastStageT + 0.2 - t; stageRebase = false; }
    lastStageT = t + stageShift;
    if (rec) rec.frame(s.index, s.targetMidi, { t, midi: frame.midi, voiced: frame.voiced });
    const r = pv.push({ ...frame, t: lastStageT }, level);
    if (!r) return;
    if (r.voiced) headMidi = r.midi;
    const inTune = r.voiced && r.verdict.kind === 'in' && r.kind === 'in';
    const g = gate.push({ tMs: t * 1000, inTune, voiced: r.voiced, scoring: true, onLast });
    pv.stage.hold(g.progress);          // the aurora grows with the ring, not with a clock of its own
    if (r.voiced && Math.abs(r.cents) <= config.verdict.farCents) { sumCents += r.cents; nCents++; }
    if (inTune) inCents.push(r.cents);
    const octave = r.voiced ? octaveOut(r.cents, H.octaveCents) : null;
    const problem = problemFor({ voiced: r.voiced, octave, verdictKind: r.verdict.kind, verdictDir: r.verdict.dir, wobbly: g.wobbly });
    // The octave has its own, much shorter wait (the general hints take hintAfterMs).
    const gated = hints.push(octave ? null : problem, inTune, t * 1000);
    // Once offered, "Use my octave" stays for the rest of the note: a button that comes
    // and goes with every wobble cannot be pressed.
    const offer = octaveGate.push(octave, t * 1000) || octaveOffer;
    paintHint(octave ? (offer === octave ? problem : null) : gated);
    const stuckChanged = g.stuck !== (skipBtn.textContent !== 'Skip');
    if (offer !== octaveOffer || stuckChanged) { octaveOffer = offer; paint(); }
    if (g.landed) onLanded(); else paintHold();
  });
  const offState = micflow.subscribe((st) => {
    const p = round.state().phase;
    paintUnder();
    // Noted in every phase: lost while a note is "Held" (or between rounds), the reopened
    // microphone's clock still starts again, and the ring's clock must follow it.
    if (st.phase === 'lost') { wasLost = true; if (p === 'sing' || p === 'listen') { pause(); pv.set({ state: 'lost' }); } }
    // A reopened microphone starts its clock again.
    // Released in the middle of a round (the page was hidden): the same holds when it reopens.
    else if (st.phase === 'off' && (p === 'sing' || p === 'listen' || p === 'result')) wasLost = true;
    else if (st.phase === 'on' && wasLost) { wasLost = false; rebase = true; }
    if (paused) paint();                   // "The microphone is off" follows the microphone
  });

  primary.addEventListener('click', () => {
    const p = round.state().phase;
    if (paused) resume();
    else if (p === 'ready') start();
    else if (p === 'sing') stop();
    else if (p === 'result') next();
  });
  pv.stage.onResume(resume);

  // ---- keys, pauses, settings
  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // Space from the heading (where focus lands on arrival) presses the main button.
    if (spaceActs(e, { sheet: sheetOpen() })) {
      // The button that shows the key now: the main one, or the done card's own once that is up.
      const shown = [...view.querySelectorAll('[data-primary]:not([disabled])')].find((b) => !b.closest('[hidden]'));
      // Always: with the button off, Space scrolled the page instead (review 4, finding 8).
      e.preventDefault();
      if (shown) shown.click();
      return;
    }
    if (e.key === 'Escape' && !paused) { pause(); if (paused) primary.focus(); }
    if ((e.key === 'r' || e.key === 'R') && !e.repeat) replay();
  };
  const onSheet = (e) => {
    if (e.detail.open) pause();
    // The level check is over: paused means the microphone is off. Not while Resume is
    // opening it (its own sheets close on the way).
    else if (paused && !reopening && micflow.mic) micflow.stop();
  };
  // Hidden or left: the round waits, paused, and only a press on Resume opens the
  // microphone again (bugs.md 31).
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) pause(); };
  const onCalm = () => { pv.set({ calm: shell.calm(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); };
  const onPhones = () => paint();
  const onShort = () => { if (!doneCard.hidden) placeDone(); };
  shortMq.addEventListener('change', onShort);
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  document.addEventListener('mt:headphones', onPhones);
  smallMq.addEventListener('change', onCalm);
  const offSettings = settings.subscribe((k) => {
    if (k === 'noteNames' || k === 'pitchView') pv.set({ noteStyle: settings.get('noteNames'), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches });
  });

  pv.set(viewPatch('idle'));
  // Place the view on the first note now: left for the first press, it would jump a lane.
  pv.stage.settle();
  paint();

  return {
    start, next, skip, stop, replay, again, useOctave, pause, resume,
    state: snapshot,
    view: pv,
    ownVoice,
    destroy() {
      // First, while the screen is still whole: a teaching step in the middle lets go of
      // the microphone itself.
      ownVoice.destroy();
      dead = true;
      seq++;
      // Left in the middle (Stop here, Skip this step, Back): what was held is still filed
      // in the practice record, where it used to vanish with the day's streak (bugs.md 58).
      // Nothing held: nothing filed, so a round opened and left is not a day sung.
      if (rec && recHeld > 0) rec.end();
      rec = null;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (tone) tone.stop();
      const p = round.state().phase;
      // `starting`: Start is still waiting for the microphone; without this it would open
      // after the screen has gone and stay on with nothing using it.
      if (starting || (p !== 'ready' && p !== 'done')) micflow.stop();
      shell.setBusy(null);
      // The shell reuses this element for the next screen: leave nothing of ours on it.
      delete view.dataset.phase;
      view.classList.remove('exercise', 'done-below');
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      document.removeEventListener('mt:headphones', onPhones);
      smallMq.removeEventListener('change', onCalm);
      shortMq.removeEventListener('change', onShort);
      layer.destroy();
      for (const rim of rims) rim.remove();
      if (synth && !givenSynth) synth.ctx.close().catch(() => {});
      pv.destroy();
    },
  };
}
