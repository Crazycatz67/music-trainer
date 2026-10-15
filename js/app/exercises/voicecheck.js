// voicecheck.js — the voice check screen, #/practice/voice-check: range, easy note, ten
// notes and six short tunes sung back by ear, then the Sky portrait
// (docs/design/specs/2026-10-12-voice-check-and-songs.md section 4; the rules and every
// sentence of the result are js/app/voicecheck.js, the picture is js/app/portrait.js).
//
// Browser only. Built, not wired: nothing imports this yet (the route, the card on Practice
// and the section on Progress are the overseer's).
//
// CONTRACT — mountVoiceCheck(view, { shell, micflow, settings, config?, micOptions?, storage?,
//                                    synth?, sessions?, now? }) -> screen
//   shell needs: calm(), setBusy(), headphones(), openSettings() (the embedded range finder)
//   micOptions  passed to micflow.request(): { stream } runs the screen with no microphone
//   synth       a js/synth.js synth for the reference tones (the lab passes a silent one);
//               made on the first press and closed again if not given
//   sessions    js/app/sessions.js createSessions(): a FINISHED check is filed as one take
//               ('voicecheck'; stars = notes and tune notes on target). Without it, nothing.
//   now         () -> Date, for the saved date (the lab's clock)
//   The microphone: asked for only by start(), useRange(), resume() and the range step's own
//   buttons, each reached only from a press. Released on pause (Esc, any sheet, the page
//   hidden or left), when the portrait is shown, and on destroy. Showing the screen asks for
//   nothing. The same rules as matchhold.js.
//   EARS ONLY (spec 4.4): in the ten notes and the six tunes no reading is ever handed to the
//   stage, so no pitch line, verdict colour or target height can be on screen while the
//   singer sings; a curtain covers the stage, and its ring fills on sound alone.
//   screen.start()      arrival -> the range step (a range from the last 24 hours is offered
//                       for reuse; else Find your range is embedded and started)
//   screen.useRange() / measureAgain()    the reuse card's two buttons
//   screen.pause(), resume() -> Promise   resume restarts the CURRENT note or tune from Listen
//   screen.replay()     "Hear it again" (config.voiceCheck.hearAgainMax times a note)
//   screen.skip()       this note, this tune, or (once offered) the easy-note step
//   screen.again()      portrait -> a new check     screen.seeLast()   arrival -> the last portrait
//   screen.state() -> { phase, part, index, count, paused, curtain, heard (0..1), hums,
//                       replays, gapMs, words, range, easy, notes: [NoteScore], tunes: [TuneScore],
//                       result: Portrait | null, saved, compare }
//       phase 'arrival' | 'range' | 'easy' | 'notes' | 'tunes' | 'portrait'
//       part  null | 'listen' | 'sing' | 'set'
//       gapMs: how long after the last reference tone ended the Sing window opened
//       words: the sentence above the stage; '' while paused (the line under the stage speaks then)
//   The stage: its paused card's button reads "Carry on" here, and stage.set({ nowLine: false })
//   holds through the ten notes and the six tunes (review 2026-10-13, C1 and C2).
//   screen.stage  the pitch stage (js/app/stage.js)     screen.destroy()
//   Events: 'mt:exercise' on document, detail { exercise: 'voicecheck', event, ...state }.
//       event: start | step | listen | tone | sing | set | paused | resumed | stopped | done
//   Left before the end: no portrait and no take are saved; a range measured in step 1 is
//   kept (the range finder saved it).
//
// Not built here: the signal banners' "the Sing window restarts once" (4.10), the dome
// items of 4.9, picking two thumbnails on Progress.

import { createSynth, timbreFor } from '../../synth.js';
import { CONFIG } from '../config.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { mountPortrait } from '../portrait.js';
import { createHoldWatch, rangeWords, readRange } from '../range.js';
import { canChime, chimePlan, playChime, rewardTier } from '../rewards.js';
import { banner, h, icon, openSheet, sheetOpen, toast } from '../shell.js';
import { createStage, displayNote } from '../stage.js';
import {
  buildPortrait, compareRows, createHeard, dateWords, easyFrom, lastFacts, noteWords, ON_TARGET_GLOSS, planNotes, planTunes,
  portraitWords, rangeFresh, readPortraits, savePortrait, scoreNote, scoreTune, tuneWords,
} from '../voicecheck.js';
import { spaceActs } from './matchhold.js';
import { mountRangeFinder } from './rangefinder.js';

export const VC_WORDS = Object.freeze({
  title: 'Sky portrait (voice check)',
  chips: { range: 'Step 1 of 4 · Your range', easy: 'Step 2 of 4 · Your easy note', notes: 'Step 3 of 4 · Ten notes', tunes: 'Step 4 of 4 · Six short tunes' },
  arrival: {
    head: 'A picture of your voice today', about: 'About 4 minutes. Four short steps:',
    steps: [['Your range', 'about 1 minute'], ['Your easy note', '3 hums'], ['Ten notes', 'hear one, sing it'], ['Six short tunes', 'four notes each']],
    noGrade: 'No grade. It shows where you are today, so you can see it change.',
    start: 'Start the voice check',
    mic: 'The microphone turns on when you press. No headphones needed: each note stops before you sing.',
    soon: 'Voices change slowly. A month apart shows more than a day apart.',
  },
  easy: {
    ask: 'Hum a note that takes no effort, like a sigh. Hold it about 3 seconds.',
    nudge: 'Still listening. Any soft hum will do, low or high.',
  },
  listen: 'Listen', listenTune: 'Listen: four notes',
  sing: 'Sing it now, and hold it', singTune: 'Sing them back, one per dot',
  skipped: 'Skipped.', playing: 'Playing now',
  paused: 'Paused. The microphone is off. Press Carry on to turn it back on.',
  noMic: 'The microphone is not on yet. Press Carry on to try again.',
  leave: 'Stop the voice check? It only counts when it is finished, so that two portraits can be compared.',
  silent: 'I am not hearing a note. Check the microphone level in Setup, or carry on.',
  saved: 'Portrait saved',
  notSaved: 'This portrait could not be saved on this computer, so it will be gone when you close the page.',
  needSecond: 'Take a second portrait to compare.',
});

// The five small pictures beside the counts. Original line drawings on the app's 24 px
// grid (2 px round strokes), kept here until they join shell.js ICONS.
const VC_ICONS = {
  arrows: 'M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4',
  level: 'M3 12h18M7 8v8M17 8v8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  figure: 'M4 17l5-8 5 5 6-9M4 17h.01M9 9h.01M14 14h.01M20 5h.01',
};
function vcIcon(name, size = 16) {
  if (!VC_ICONS[name]) return icon(name, size);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'icon', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', VC_ICONS[name]);
  svg.append(path);
  return svg;
}

// What the arrival card shows, dimmed: a made-up portrait, never the singer's own.
function samplePortrait() {
  const range = { lowMidi: 45, highMidi: 64, comfortLow: 47, comfortHigh: 62 };
  const offs = [10, -15, 0, 20, -330, 5, -10, 0, 15, -5];
  const notes = planNotes(range).midis.map((m, i) => ({ midi: m, sungMidi: m + offs[i] / 100, cents: offs[i], on: Math.abs(offs[i]) <= 50, octave: 0, steady: true, lockSec: 0.6 }));
  const tunes = planTunes(range, 50).map((t, i) => ({ midis: t.midis, sung: t.midis.map((m, j) => (i === 4 && j === 2 ? m + 2 : m)), on: t.midis.map((m, j) => !(i === 4 && j === 2)), shape: i !== 4 }));
  return buildPortrait({ at: '2026-01-01T12:00:00.000Z', range, easy: { midi: 50, from: 'hummed' }, notes, tunes });
}

export function mountVoiceCheck(view, {
  shell, micflow, settings, config = CONFIG, micOptions, storage, synth: givenSynth = null, sessions = null, now = () => new Date(),
} = {}) {
  const V = config.voiceCheck;
  const store = storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  const noteStyle = () => settings.get('noteNames');
  const nameOf = (m) => displayNote(Math.round(m), noteStyle()).text;
  const ringEvery = createEvery(1000 / 30);

  let phase = 'arrival', part = null, index = 0, paused = false, pausedPart = null, starting = false, reopening = false, stopAsked = false, dead = false;
  let synth = givenSynth, tone = null, seq = 0, why = '';
  let range = null, easy = null, plan = [], repeated = false, tunePlan = [];
  let rf = null, hums = [], noteScores = [], tuneScores = [], replays = 0, silentRun = 0;
  let frames = [], heard = null, heardK = 0, singT0 = null, toneEndMs = null, gapMs = null, pulseAt = -1, setAtMs = 0;
  // The easy-note step: the hold being hummed now, the stretch already counted, when the
  // step last got anywhere (for "Still listening" and "Skip this step").
  let watch = null, pendingHum = null, countedT0 = null, lastVoicedT = null, easySince = null, easyNudged = false, easySkip = false;
  // Each time the microphone is opened its clock starts again; readings filed in the
  // practice record must not run backwards (as matchhold.js).
  let tOffset = 0, lastT = null, rebase = true, wasOff = false;
  let rec = null, startedAt = null, words = '', result = null, saved = null, compare = null, shownPortraits = [];
  // Element.replaceChildren writes a null child as the word "null": leave the gaps out.
  const fill = (el, ...kids) => el.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };
  const clearTimers = () => { for (const id of timers) clearTimeout(id); timers.clear(); };

  // ---- the page
  const stepChip = h('div', { class: 'chip phase-chip vc-step', hidden: true });
  const heading = h('h1', { tabindex: '-1' }, VC_WORDS.title);
  const arrival = h('section', { class: 'vc-arrival' });
  const rangeHost = h('div', { class: 'vc-range', hidden: true });
  const wordsLine = h('p', { class: 'vc-words', role: 'status' });
  const bannerSlot = h('div'), stageHost = h('div', { class: 'vc-stage' });
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const countText = h('p', { class: 'ex-step' });
  const dots = h('ol', { class: 'vc-dots' });
  const hearWhy = h('span', { class: 'visually-hidden', id: 'vc-hear-why' });
  const hearBtn = h('button', { class: 'btn btn-secondary vc-hear', type: 'button', hidden: true, 'aria-describedby': 'vc-hear-why', onclick: () => replay() });
  const skipBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true, onclick: () => skip() });
  const pauseBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { pause(); if (paused) carryBtn.focus(); } }, 'Pause ', h('kbd', { class: 'keycap' }, 'Esc'));
  const carryBtn = h('button', { class: 'btn btn-primary', type: 'button', hidden: true, dataset: { primary: '' }, onclick: () => resume() });
  const body = h('div', { class: 'vc-body', hidden: true },
    wordsLine, bannerSlot, stageHost, underLine,
    h('div', { class: 'vc-count' }, countText, dots),
    h('div', { class: 'action-row' }, hearBtn, hearWhy, skipBtn, h('div', { class: 'action-main' }, pauseBtn, carryBtn)));
  const resultBox = h('section', { class: 'vc-result', hidden: true });
  view.classList.add('exercise', 'voice-check');
  view.append(
    h('div', { class: 'title-row ex-head' },
      h('a', { class: 'btn btn-quiet back', href: '#/practice' }, icon('back', 16), ' The Ladder'), heading, stepChip),
    arrival, rangeHost, body, resultBox);

  const stage = createStage(stageHost, { config });
  // One action, one name (review C1; spec 4.10 says "Carry on"): the stage's own paused card
  // says "Resume" on the other screens. Its button is the same press as the row's, so here
  // it carries the same words. Only the words are touched; the stage still shows and hides it.
  const stageCarry = stage.el.querySelector('.stage-card button');
  if (stageCarry && stageCarry.firstChild) stageCarry.firstChild.nodeValue = 'Carry on ';
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });

  // The curtain: what stands between the eye and the answer while a note is sung.
  const ringFill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const ringSvg = (() => {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), track = document.createElementNS(NS, 'circle');
    svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('class', 'vc-ring'); svg.setAttribute('aria-hidden', 'true');
    for (const c of [track, ringFill]) { c.setAttribute('cx', 32); c.setAttribute('cy', 32); c.setAttribute('r', 26); c.setAttribute('pathLength', 100); }
    track.setAttribute('class', 'vc-ring-track'); ringFill.setAttribute('class', 'vc-ring-fill');
    svg.append(track, ringFill);
    return svg;
  })();
  const pulses = h('div', { class: 'vc-pulses', 'aria-hidden': 'true' });
  // The line above the stage is the one read out (role status); this is the same sentence
  // again for the eye, so it is kept from a screen reader (review C5).
  const curtainWords = h('p', { class: 'vc-curtain-words', 'aria-hidden': 'true' });
  const curtain = h('div', { class: 'vc-curtain', hidden: true }, pulses, ringSvg, curtainWords);
  stage.el.append(curtain);

  // On the stage, under the curtain: the singer's two horizons and every star set so far.
  let ink = null, inkFor = null;
  stage.addLayer((ctx, L, tokens) => {
    if (dead || !range || phase === 'arrival' || phase === 'range' || phase === 'portrait') return;
    if (inkFor !== tokens) {
      const cs = getComputedStyle(stage.el), v = (n) => cs.getPropertyValue(n).trim();
      ink = { text: v('--text'), muted: v('--muted'), line: v('--line-strong'), gold: v('--gold'), goldFill: v('--gold-fill'), font: v('--font-ui') || 'system-ui' };
      inkFor = tokens;
    }
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = ink.line; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
    ctx.font = `12px ${ink.font}`; ctx.fillStyle = ink.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    for (const [midi, label] of [[range.highMidi, 'your top note'], [range.lowMidi, 'your lowest note']]) {
      const y = L.yOfMidi(midi);
      ctx.beginPath(); ctx.moveTo(L.plotX, y); ctx.lineTo(L.plotX + L.plotW, y); ctx.stroke();
      ctx.fillText(label, L.plotX + L.plotW - 8, y - 4);
    }
    ctx.setLineDash([]);
    const fresh = Math.min(1, (performance.now() - setAtMs) / (shell.calm() ? V.calmFadeMs : V.liftMs));
    const star = (x, y, r) => {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.45 : r, a = -Math.PI / 2 + (i * Math.PI) / 5; ctx[i ? 'lineTo' : 'moveTo'](x + rr * Math.cos(a), y + rr * Math.sin(a)); }
      ctx.closePath(); ctx.fillStyle = ink.goldFill; ctx.fill(); ctx.strokeStyle = ink.gold; ctx.lineWidth = 1.5; ctx.stroke();
    };
    const ringAt = (x, y, r = 6) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.strokeStyle = ink.text; ctx.lineWidth = 1.5; ctx.stroke(); };
    const dot = (x, y) => { ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fillStyle = ink.text; ctx.fill(); };
    if (phase === 'notes') {
      noteScores.forEach((s, i) => {
        if (!s) return;
        const x = L.plotX + ((i + 0.5) * L.plotW) / plan.length, y = L.yOfMidi(s.midi);
        ctx.globalAlpha = i === index && part === 'set' ? fresh : 1;
        // Filled against hollow carries it, as on the portrait: never the colour alone.
        if (s.on) { star(x, L.yOfMidi(s.sungMidi), 8); return; }
        ringAt(x, y);
        if (s.octave) { ctx.fillStyle = ink.text; ctx.font = `600 11px ${ink.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s.octave < 0 ? '8 ↓' : '8 ↑', x + 10, y); return; }
        if (s.sungMidi === null) return;
        const y2 = Math.min(ctx.canvas.clientHeight - 6, Math.max(6, L.yOfMidi(s.sungMidi)));
        ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.strokeStyle = ink.text;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y2); ctx.stroke(); ctx.setLineDash([]);
        dot(x, y2);
      });
    } else if (phase === 'tunes' && part === 'set' && tuneScores[index]) {
      const t = tuneScores[index], cx = L.plotX + L.plotW / 2;
      ctx.globalAlpha = fresh;
      const pts = t.midis.map((m, j) => ({ x: cx + (j - 1.5) * 48, y: L.yOfMidi(t.sung[j] ?? m), heard: t.sung[j] !== null, on: t.on[j] }));
      ctx.strokeStyle = ink.text; ctx.lineWidth = 1.2;
      ctx.beginPath(); pts.forEach((p, j) => ctx[j ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.stroke();
      for (const p of pts) { if (p.on) star(p.x, p.y, 7); else if (p.heard) dot(p.x, p.y); else ringAt(p.x, p.y, 4); }
    }
    ctx.restore();
  });

  const count = () => (phase === 'easy' ? V.hums : phase === 'notes' ? plan.length : phase === 'tunes' ? tunePlan.length : 0);
  const curtainOn = () => (phase === 'notes' || phase === 'tunes') && (part === 'listen' || part === 'sing') && !paused;
  const snapshot = () => ({
    phase, part, index, count: count(), paused, curtain: curtainOn(), heard: heardK, hums: hums.length, replays, gapMs, words,
    range: range ? { ...range } : null, easy: easy ? { ...easy } : null, notes: noteScores.map((s) => ({ ...s })), tunes: tuneScores.map((t) => ({ ...t })),
    result, saved, compare,
  });
  const emit = (event) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: 'voicecheck', event, ...snapshot() } }));
  const say = (text) => { words = text; if (wordsLine.textContent !== text) wordsLine.textContent = text; if (curtainWords.textContent !== text) curtainWords.textContent = text; };

  function paintArrival() {
    const facts = lastFacts(readPortraits(store).checks, now());
    const A = VC_WORDS.arrival;
    const sample = h('div', { class: 'vc-sample', 'aria-hidden': 'true' });
    const startBtn = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, onclick: () => start() }, `${A.start} `, h('kbd', { class: 'keycap' }, 'Space'));
    arrival.replaceChildren(sample,
      h('div', { class: 'vc-arrival-text' },
        h('h2', null, A.head), h('p', null, A.about),
        h('ol', { class: 'vc-steps' }, A.steps.map(([name, how]) => h('li', null, h('span', null, name), h('span', { class: 'reason' }, how)))),
        h('p', null, A.noGrade),
        h('div', { class: 'action-row' }, startBtn),
        h('p', { class: 'reason' }, A.mic),
        facts.last ? h('p', { class: 'reason vc-last' }, `Last portrait: ${facts.last} `, h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => seeLast() }, 'See it')) : null,
        facts.soon ? h('p', { class: 'reason vc-soon' }, A.soon) : null));
    for (const p of shownPortraits.splice(0)) p.destroy();
    shownPortraits.push(mountPortrait(sample, samplePortrait(), { calm: true, tonight: false, label: 'A sample portrait' }));
  }

  function paintDots() {
    const n = count();
    while (dots.children.length > n) dots.lastChild.remove();
    while (dots.children.length < n) dots.append(h('li', { class: 'vc-dot' }));
    const done = phase === 'easy' ? hums.length : phase === 'notes' ? noteScores.filter(Boolean).length : tuneScores.filter(Boolean).length;
    [...dots.children].forEach((li, i) => { li.dataset.state = i < done ? 'done' : i === done && !paused ? 'now' : ''; });
    const unit = phase === 'easy' ? 'Hum' : phase === 'notes' ? 'Note' : 'Tune';
    countText.textContent = n ? `${unit} ${Math.min(n, done + 1)} of ${n}` : '';
    dots.setAttribute('aria-label', countText.textContent);
  }

  function paintUnder() {
    const problem = SIGNAL_PROBLEMS.includes(micflow.state().banner) ? micflow.state().banner : null;
    const text = paused ? (why || VC_WORDS.paused) : problem ? MIC_WORDS[problem] : phase === 'notes' || phase === 'tunes' ? ON_TARGET_GLOSS : '';
    underLine.dataset.role = problem && !paused ? 'close' : '';
    if (underLine.textContent !== text) underLine.textContent = text;
  }

  function paint() {
    const running = phase === 'easy' || phase === 'notes' || phase === 'tunes';
    view.dataset.phase = paused ? 'paused' : phase;
    view.dataset.part = part || '';
    arrival.hidden = phase !== 'arrival';
    rangeHost.hidden = phase !== 'range';
    body.hidden = !running;
    resultBox.hidden = phase !== 'portrait';
    stepChip.hidden = !VC_WORDS.chips[phase];
    stepChip.textContent = VC_WORDS.chips[phase] || '';
    if (!running) return;
    curtain.hidden = !(phase === 'notes' || phase === 'tunes');
    curtain.dataset.open = curtainOn() ? 'no' : 'yes';
    curtain.dataset.part = part || '';
    ringSvg.style.visibility = phase === 'notes' && part === 'sing' ? 'visible' : 'hidden';
    const busy = starting || reopening;
    pauseBtn.hidden = paused || busy;
    carryBtn.hidden = !(paused || busy);
    carryBtn.disabled = busy;
    carryBtn.replaceChildren(busy ? 'Getting the microphone…' : 'Carry on ', busy ? '' : h('kbd', { class: 'keycap' }, 'Space'));
    const turn = (phase === 'notes' || phase === 'tunes') && (part === 'listen' || part === 'sing') && !paused;
    hearBtn.hidden = !turn;
    const used = replays >= V.hearAgainMax;
    hearBtn.disabled = part !== 'sing' || used;
    // A greyed button says why on its own face (review C6), as "Heard 3 times" does: while
    // the note plays it reads "Playing now", with no keycap, because R does nothing then.
    const playing = part !== 'sing';
    hearBtn.dataset.why = used ? 'used' : playing ? 'playing' : '';
    hearBtn.replaceChildren(...(used ? [`Heard ${V.hearAgainMax + 1} times`] : playing ? [icon('replay', 16), ` ${VC_WORDS.playing}`] : [icon('replay', 16), ' Hear it again ', h('kbd', { class: 'keycap' }, 'R')]));
    hearWhy.textContent = used ? `Each ${phase === 'tunes' ? 'tune' : 'note'} can be heard ${V.hearAgainMax + 1} times.` : playing ? 'You can hear it again when it has finished.' : '';
    skipBtn.hidden = !(turn || (phase === 'easy' && easySkip && !paused));
    skipBtn.replaceChildren(phase === 'easy' ? 'Skip this step' : phase === 'tunes' ? 'Skip this tune ' : 'Skip this note ', phase === 'easy' ? '' : h('kbd', { class: 'keycap' }, 'S'));
    paintDots();
    paintUnder();
  }

  const setRing = (k) => { heardK = k; ringFill.style.strokeDasharray = `${(100 * k).toFixed(1)} 100`; };
  function setPulses(n, lit) {
    while (pulses.children.length > n) pulses.lastChild.remove();
    while (pulses.children.length < n) pulses.append(h('i'));
    [...pulses.children].forEach((el, i) => el.toggleAttribute('data-on', i === lit));
    pulseAt = lit;
  }

  // The singer's whole range, both horizons in view, from a clean stage. stage.reset() drops
  // a fit, so the fit follows it.
  const skyView = () => { stage.reset(); stage.fit({ low: range.lowMidi, high: range.highMidi }, { ms: 0 }); };
  // No now-line in the ten notes and the six tunes: nothing scrolls there, and a line marked
  // "now" promises a moving reading that never comes (review C2). The easy note keeps it.
  const stagePatch = (state) => ({ state, target: null, grid: 'quiet', noteStyle: noteStyle(), calm: shell.calm(), labelClearTopPx: 40, nowLine: phase !== 'notes' && phase !== 'tunes' });

  // ---- step 1: the range
  function start() {
    if (phase !== 'arrival' || dead) return false;
    phase = 'range';
    startedAt = now();
    emit('start');
    const savedRange = readRange(store);
    if (rangeFresh(savedRange, now(), V)) {
      const w = rangeWords(savedRange, { noteStyle: noteStyle() });
      const use = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, onclick: () => useRange() }, 'Use it ', h('kbd', { class: 'keycap' }, 'Space'));
      rangeHost.replaceChildren(h('section', { class: 'card vc-reuse' },
        h('h2', null, `Your range from today: ${w.low} to ${w.high}`),
        h('p', { class: 'reason' }, 'The microphone turns on when you press.'),
        h('div', { class: 'action-row' }, use, h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => measureAgain() }, 'Measure again'))));
      paint();
      use.focus({ preventScroll: true });
    } else {
      paint();
      measureAgain();
    }
    return true;
  }

  // Reached only from a press (Start, or "Measure again"), so the range finder may open the
  // microphone straight away.
  function measureAgain() {
    if (phase !== 'range' || rf) return;
    rangeHost.replaceChildren();
    rf = mountRangeFinder(rangeHost, {
      shell, micflow, settings, storage: store, micOptions, embedded: true, config, sessions,
      onNext: (entry) => { const r = entry || readRange(store); rf.destroy(); rf = null; rangeHost.replaceChildren(); beginEasy(r); },
    });
    rf.start();
  }
  function useRange() {
    if (phase !== 'range' || rf) return;
    rangeHost.replaceChildren();
    beginEasy(readRange(store));
  }

  // ---- step 2: the easy note
  async function openMic() {
    starting = true; why = '';
    paint();
    const ok = await micflow.request(micOptions || {});
    starting = false;
    if (dead) return false;
    if (ok && !synth) { try { synth = createSynth(); } catch { /* no sound: the check still shows its words */ } }
    return ok;
  }

  // A question that must be answered: -> 'yes' | 'no' | 'esc'. Esc is not an answer. Chrome
  // lets a second Esc (or the first, on a page not yet pressed) close any dialog, and
  // confirmSheet reads that as "no", which here means "carry on" and opened the microphone
  // from an Esc (bugs.md 65). Closed by Esc, the check stays paused with the microphone off.
  // The same markup as confirmSheet, so it looks and tabs the same.
  const ask = ({ title, yes, no }) => new Promise((done) => {
    const sheet = openSheet({
      title, closable: false, className: 'sheet-confirm',
      onClose: (value) => done(value === 'yes' || value === 'no' ? value : 'esc'),
      body: [h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, onclick: () => sheet.close('no') }, no),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => sheet.close('yes') }, yes))],
    });
  });

  const guard = async () => {
    const wasRunning = !paused;
    const answer = await ask({ title: VC_WORDS.leave, yes: 'Stop', no: 'Keep going' });
    // The sheet paused the check; "Keep going" should mean exactly that.
    if (answer === 'no' && wasRunning && paused) resume();
    if (answer === 'yes') emit('stopped');
    return answer === 'yes';
  };

  async function beginEasy(r) {
    if (!r) { phase = 'arrival'; paint(); return; }
    range = r;
    phase = 'easy'; part = 'sing'; index = 0; hums = []; easy = null; noteScores = []; tuneScores = [];
    stage.set(stagePatch('idle'));
    skyView();
    stage.settle();
    say(VC_WORDS.easy.ask);
    shell.setBusy(guard);
    emit('step');
    const ok = await openMic();
    if (dead) return;
    if (!ok) { paused = true; pausedPart = 'sing'; why = VC_WORDS.noMic; stage.set({ state: 'paused' }); paint(); return; }
    // Paused while the microphone was still being opened (Esc, a sheet, a leave question):
    // paused means off, so it is let go the moment it arrives, and Carry on asks for it
    // again from a press (bugs.md 64). The level check keeps it until its sheet closes.
    if (paused) { if (micflow.mic && micflow.state().phase !== 'checking') micflow.stop(); paint(); return; }
    rec = sessions ? sessions.take('voicecheck') : null;
    startEasy();
  }

  function startEasy() {
    watch = createHoldWatch({ ...config.range, coverMs: V.humMs });
    pendingHum = null; countedT0 = null; lastVoicedT = null; easySince = null; easyNudged = false;
    part = 'sing';
    stage.set(stagePatch('live'));
    stage.start();
    micflow.setListening(true);
    paint();
    heading.focus({ preventScroll: true });
  }

  function easyFrame(frame, level, t) {
    stage.push({ ...frame, t }, level);
    if (easySince === null) easySince = t;
    const voiced = frame.voiced && Number.isFinite(frame.midi);
    const s = watch.push({ t, midi: frame.midi, voiced });
    if (voiced) lastVoicedT = t;
    if (s.midi !== null && s.t0 !== countedT0 && s.heldMs >= V.humMs) pendingHum = { t0: s.t0, midi: s.midi, ms: s.heldMs };
    // A hum is taken when it is long enough or the voice stops; one long hum is one hum.
    const over = pendingHum && (pendingHum.ms >= V.humEndMs || (!voiced && lastVoicedT !== null && (t - lastVoicedT) * 1000 > config.range.gapMs));
    if (over) {
      hums.push(pendingHum.midi);
      countedT0 = pendingHum.t0; pendingHum = null; easySince = t; easyNudged = false;
      say(`Got it: ${nameOf(hums[hums.length - 1])}.`);
      paint();
      if (hums.length >= V.hums) finishEasy(false);
      return;
    }
    const waited = (t - easySince) * 1000;
    if (!easyNudged && waited >= V.humNudgeMs) { easyNudged = true; say(VC_WORDS.easy.nudge); }
    if (!easySkip && waited >= V.humSkipMs) { easySkip = true; paint(); }
  }

  function finishEasy(skipped) {
    easy = easyFrom(skipped ? [] : hums, range, V);
    part = 'set';
    micflow.setListening(false);
    stage.set(stagePatch('idle'));
    say(`Your voice sits most easily around ${nameOf(easy.midi)}.`);
    paint();
    emit('set');
    later(beginNotes, V.setMs);
  }

  // ---- steps 3 and 4: hear it, sing it back, see where it landed
  function beginNotes() {
    const p = planNotes(range, V);
    plan = p.midis; repeated = p.repeated;
    tunePlan = planTunes(range, easy.midi, V);
    phase = 'notes'; index = 0; replays = 0; silentRun = 0;
    // The last hum must not stay under the curtain of note 1 (review C3). A reset on a running
    // stage drops the line but lets its light ease out for over a second; on a resting stage
    // nothing is left. listen() starts it again.
    stage.stop();
    skyView();
    emit('step');
    listen();
  }
  function beginTunes() {
    phase = 'tunes'; index = 0; replays = 0;
    emit('step');
    listen();
  }

  // The reference tones. Nothing is read from the microphone while they sound, and the Sing
  // window opens config.voiceCheck.gapMs after the last one has ended.
  function listen() {
    const mine = ++seq;
    if (tone) tone.stop();
    part = 'listen';
    micflow.setListening(false);
    setRing(0);
    const midis = phase === 'tunes' ? tunePlan[index].midis : [plan[index]];
    const dur = phase === 'tunes' ? V.tuneNoteSec : V.listenSec;
    // One ring for a note, four for a tune, all at ONE height: where they sit says nothing.
    setPulses(midis.length, -1);
    say(phase === 'tunes' ? VC_WORDS.listenTune : VC_WORDS.listen);
    stage.set(stagePatch('idle'));
    stage.start();
    paint();
    emit('listen');
    let i = 0;
    const next = () => {
      if (dead || mine !== seq) return;
      if (i >= midis.length) {
        tone = null; toneEndMs = performance.now();
        setPulses(midis.length, -1);
        later(() => { if (mine === seq) sing(); }, V.gapMs);
        return;
      }
      setPulses(midis.length, i);
      emit('tone');
      if (!synth) { i++; later(next, dur * 1000); return; }
      tone = synth.play({ midi: midis[i], dur, timbre: timbreFor(settings.get('tone')), gain: 0.5 * settings.get('toneVolume'), tag: 'tone' });
      i++;
      tone.ended.then(next);
    };
    next();
  }

  function sing() {
    // The microphone went while the note played: wait, paused. This runs from a timer, so it
    // must not open the microphone itself; Carry on does, from a press.
    if (!micflow.mic) { pause(true); return; }
    part = 'sing';
    frames = []; singT0 = null;
    heard = createHeard(V.heardMs);
    gapMs = toneEndMs === null ? null : performance.now() - toneEndMs;
    say(phase === 'tunes' ? VC_WORDS.singTune : VC_WORDS.sing);
    micflow.setListening(true);
    paint();
    emit('sing');
  }

  function turnFrame(frame, t) {
    if (singT0 === null) singT0 = t;
    const f = { t, midi: frame.voiced && Number.isFinite(frame.midi) ? frame.midi : null, voiced: !!frame.voiced && Number.isFinite(frame.midi) };
    frames.push(f);
    const since = t - singT0;
    if (phase === 'notes') {
      if (rec) rec.frame(`n${index}`, plan[index], f);
      const s = heard.push(f);
      if (s.done || ringEvery.due(performance.now())) setRing(s.progress);
      if (s.done || since >= V.singMaxSec) setScore(false);
      return;
    }
    const midis = tunePlan[index].midis;
    const j = Math.min(midis.length - 1, Math.max(0, Math.floor((since - V.latencySec) / V.tuneNoteSec)));
    if (rec) rec.frame(`t${index}-${j}`, midis[j], f);
    const lit = Math.min(midis.length - 1, Math.floor(since / V.tuneNoteSec));
    if (lit !== pulseAt) setPulses(midis.length, lit);
    if (since >= midis.length * V.tuneNoteSec + V.latencySec) setScore(false);
  }

  // The curtain lifts on what was really sung.
  function setScore(skipped) {
    part = 'set';
    micflow.setListening(false);
    setAtMs = performance.now();
    if (phase === 'notes') {
      const s = skipped ? { ...scoreNote(plan[index], [], V), skipped: true } : scoreNote(plan[index], frames, V);
      noteScores[index] = s;
      if (s.on && rec) rec.landed(`n${index}`);
      silentRun = !skipped && s.cents === null ? silentRun + 1 : 0;
      say(skipped ? VC_WORDS.skipped : noteWords(s));
    } else {
      const midis = tunePlan[index].midis;
      const s = scoreTune(midis, skipped ? [] : frames, { t0: singT0 ?? 0, noteSec: V.tuneNoteSec }, V);
      tuneScores[index] = s;
      if (rec) s.on.forEach((on, j) => { if (on) rec.landed(`t${index}-${j}`); });
      say(skipped ? VC_WORDS.skipped : tuneWords(s, V));
    }
    frames = [];
    paint();
    emit('set');
    if (silentRun >= V.silentRunSheet) { silentRun = 0; askSilent(); return; }
    later(advance, V.setMs);
  }

  function advance() {
    replays = 0;
    const last = index + 1 >= count();
    if (!last) { index++; listen(); return; }
    if (phase === 'notes') beginTunes(); else finish();
  }

  async function askSilent() {
    // The sheet pauses the check (onSheet) with this note already set: Carry on moves on.
    const answer = await ask({ title: VC_WORDS.silent, yes: 'Open setup', no: 'Carry on' });
    if (dead) return;
    if (answer === 'yes') { location.hash = '#/setup'; return; }
    // Closed by Esc: still paused, the microphone off; the Carry on button is on the page.
    if (answer === 'no') resume();
  }

  function replay() {
    if (part !== 'sing' || paused || replays >= V.hearAgainMax || (phase !== 'notes' && phase !== 'tunes')) return;
    replays++;
    listen();
  }

  function skip() {
    if (paused) return;
    if (phase === 'easy' && easySkip && part === 'sing') { finishEasy(true); return; }
    if ((phase !== 'notes' && phase !== 'tunes') || (part !== 'listen' && part !== 'sing')) return;
    seq++;
    clearTimers();
    if (tone) { tone.stop(); tone = null; }
    setScore(true);
  }

  // ---- pauses. Paused means the microphone is off (owner rule 2026-10-12): Esc, any sheet,
  // the page hidden or left all release it, every track ended. The check is kept; Carry on
  // opens it again and restarts the current note or tune from Listen, because after a break
  // nobody remembers the pitch.
  const REST_MS = ((config.aurora && config.aurora.cutFadeMs) || 600) + 150;
  function pause(lost = false) {
    // Asked to pause while Carry on is still waiting for the microphone: resume() honours it
    // when the microphone arrives (bugs.md 64), instead of running on behind a sheet.
    if (reopening && !dead) { stopAsked = true; return; }
    if (paused || dead || (phase !== 'easy' && phase !== 'notes' && phase !== 'tunes')) return;
    seq++;
    clearTimers();
    if (tone) { tone.stop(); tone = null; }
    paused = true; pausedPart = part; why = '';
    // "Listen" or "Sing it now" is no longer true (review C4). The line under the stage says
    // "Paused. The microphone is off…"; Carry on writes the sentence again from Listen.
    say('');
    micflow.setListening(false);
    // Lost (unplugged) has nothing open and keeps its Reconnect banner; the level check
    // ("Test the mic") needs the microphone until its sheet closes (onSheet).
    const flow = micflow.state().phase;
    if (micflow.mic && flow !== 'lost' && flow !== 'checking') micflow.stop();
    stage.set({ state: lost || flow === 'lost' ? 'lost' : 'paused' });
    paint();
    emit('paused');
    later(() => { if (paused) stage.stop(); }, REST_MS);
  }

  // Only ever reached from a press (the button, Space, the stage's own button, "Keep going",
  // "Carry on" in the sheet), so it may open the microphone again.
  async function resume() {
    if (!paused || reopening || dead) return;
    const setLast = pausedPart === 'set' && phase === 'tunes' && index + 1 >= tunePlan.length;
    // Paused on the last tune's result: the check ends; no microphone is needed.
    if (!setLast && !micflow.mic) {
      reopening = true; stopAsked = false;
      paint();
      const ok = await micflow.request(micOptions || {});
      reopening = false;
      if (dead) return;
      if (!ok || !paused) { why = ok ? '' : VC_WORDS.noMic; paint(); return; }
      if (stopAsked) { stopAsked = false; if (micflow.mic && micflow.state().phase !== 'checking') micflow.stop(); paint(); return; }
      if (!synth) { try { synth = createSynth(); } catch { /* as openMic */ } }
    }
    paused = false; why = '';
    if (!rec && sessions) rec = sessions.take('voicecheck');
    emit('resumed');
    // The pause blanked the sentence; each way on says its own again.
    if (phase === 'easy') { if (pausedPart === 'set') finishEasy(hums.length < V.hums); else { say(VC_WORDS.easy.ask); startEasy(); } return; }
    stage.set(stagePatch('idle'));
    stage.start();
    if (pausedPart === 'set') advance(); else listen();
  }

  // ---- the portrait
  function finish() {
    seq++;
    clearTimers();
    // First: releasing the microphone must not read as "lost in the middle of a tune".
    phase = 'portrait'; part = null; paused = false;
    micflow.stop();
    shell.setBusy(null);
    stage.stop();
    const at = now();
    const earlier = readPortraits(store).checks;
    const made = buildPortrait({ at: at.toISOString(), sec: startedAt ? (at.getTime() - startedAt.getTime()) / 1000 : 0, range, easy, notes: noteScores, tunes: tuneScores, repeated }, V);
    const out = savePortrait(store, made, V);
    result = out.portrait; saved = out.saved;
    if (rec) { rec.end(); rec = null; }
    showResult(result, earlier, { fresh: true });
    if (saved) toast(VC_WORDS.saved);
    emit('done');
  }

  function wordsCard(p) {
    const w = portraitWords(p, { noteStyle: noteStyle() });
    const info = h('button', { class: 'btn btn-quiet btn-small vc-info', type: 'button', 'aria-label': 'About voice types', onclick: () => openSheet({ title: 'About voice types', body: [h('p', null, w.typeInfo)] }) }, icon('info', 16));
    return h('section', { class: 'card vc-words-card' },
      h('div', { class: 'title-row' }, h('h2', null, w.title), h('span', { class: 'chip' }, w.date)),
      h('div', { class: 'vc-range-block' }, w.range.map((line) => h('p', null, line)), h('p', { class: 'vc-type' }, w.type, ' ', info)),
      h('h3', null, 'What you can do today'),
      h('ul', { class: 'vc-can' }, w.can.map((c) => h('li', { dataset: { id: c.id } }, vcIcon(c.icon, 16),
        h('div', null, h('p', { class: 'vc-can-line' }, c.before, c.strong ? h('strong', null, c.strong) : null, c.after), c.small ? h('p', { class: 'reason' }, c.small) : null)))),
      w.extra.length ? h('div', { class: 'vc-extra' }, w.extra.map((line) => h('p', null, line))) : null,
      h('p', { class: 'vc-honesty' }, w.honesty));
  }

  function showResult(p, earlier, { fresh = false } = {}) {
    for (const old of shownPortraits.splice(0)) old.destroy();
    const w = portraitWords(p, { noteStyle: noteStyle() });
    const horizons = (q) => ({ plate: portraitWords(q, { noteStyle: noteStyle() }).plate, low: nameOf(q.range.lowMidi), high: nameOf(q.range.highMidi), label: portraitWords(q, { noteStyle: noteStyle() }).label });
    const tonightBox = h('div', { class: 'vc-tonight' });
    const compareBox = h('div', { class: 'vc-compare', hidden: true });
    let mode = earlier.length ? 'compare' : 'tonight', against = earlier.length ? earlier[earlier.length - 1] : null;

    function paintCompare() {
      for (const old of shownPortraits.splice(0)) old.destroy();
      compareBox.hidden = mode !== 'compare'; tonightBox.hidden = mode !== 'tonight';
      if (mode === 'tonight') {
        const pic = h('div', { class: 'vc-picture' });
        tonightBox.replaceChildren(pic, wordsCard(p));
        shownPortraits.push(mountPortrait(pic, p, { words: horizons(p), calm: shell.calm(), play: fresh, tonight: true, config }));
        fresh = false;
        return;
      }
      const c = compareRows(against, p, { noteStyle: noteStyle() });
      compare = { against: against.id, anyGrew: c.anyGrew, grew: c.rows.filter((r) => r.grew).map((r) => r.id) };
      // One scale for both, so the horizons can be compared by eye.
      const scale = { low: Math.min(against.range.lowMidi, p.range.lowMidi), high: Math.max(against.range.highMidi, p.range.highMidi) };
      const left = h('div', { class: 'vc-picture' }), right = h('div', { class: 'vc-picture' });
      const pick = h('select', { class: 'vc-pick', 'aria-label': 'Compare with', onchange: (e) => { against = earlier.find((q) => q.id === e.target.value) || against; paintCompare(); } },
        earlier.map((q, i) => h('option', { value: q.id, selected: q.id === against.id || null }, `${dateWords(q.at)}${i === 0 && earlier.length > 1 ? ' (your first)' : i === earlier.length - 1 ? ' (the one before)' : ''}`)));
      fill(compareBox,
        h('div', { class: 'vc-pair' }, h('div', null, h('label', { class: 'reason vc-pair-head' }, 'Compare with ', pick), left), h('div', null, h('p', { class: 'reason vc-pair-head' }, `Tonight · ${c.heads[1]}`), right)),
        h('table', { class: 'vc-table' },
          h('thead', null, h('tr', null, h('th', null, ''), h('th', null, c.heads[0]), h('th', null, c.heads[1]), h('th', null, h('span', { class: 'visually-hidden' }, 'What grew')))),
          h('tbody', null, c.rows.map((r) => h('tr', { dataset: { id: r.id, grew: r.grew ? 'yes' : 'no' } },
            h('th', { scope: 'row' }, r.label), h('td', null, r.a), h('td', null, r.b),
            // Rewards only go up: a row that is the same or behind gets nothing here at all.
            h('td', { class: 'vc-gain' }, r.grew ? [icon('star', 16), ' ', r.gain] : null))))),
        h('p', { class: 'reason' }, c.note),
        c.rangeNote ? h('p', { class: 'reason' }, c.rangeNote) : null);
      shownPortraits.push(
        mountPortrait(left, against, { words: horizons(against), calm: true, tonight: false, dim: V.portrait.earlierK, scale, config }),
        mountPortrait(right, p, { words: horizons(p), calm: shell.calm(), play: fresh, tonight: true, scale, config }));
      if (fresh && c.anyGrew) bestChip.hidden = false;
      fresh = false;
    }

    const bestChip = h('span', { class: 'chip', dataset: { role: 'gold' }, hidden: true }, icon('star', 16), 'New best');
    const modeBtn = (id, label) => h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'aria-pressed': String(mode === id), dataset: { mode: id },
      onclick: () => { mode = id; for (const b of switcher.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); paintCompare(); } }, label);
    const switcher = h('div', { class: 'vc-switch', role: 'group', 'aria-label': 'Show' }, modeBtn('tonight', 'Tonight'), modeBtn('compare', 'Compare'));
    const againBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => again() }, 'Take it again');
    fill(resultBox,
      h('div', { class: 'title-row' }, earlier.length ? switcher : h('p', { class: 'reason' }, VC_WORDS.needSecond), bestChip),
      saved === false && result === p ? banner({ role: 'error', iconName: 'warning', text: VC_WORDS.notSaved }) : null,
      tonightBox, compareBox,
      h('div', { class: 'action-row' },
        h('a', { class: 'btn btn-primary', href: '#/songs', dataset: { primary: '' } }, 'Find songs for this voice'), againBtn,
        h('a', { class: 'btn btn-quiet', href: '#/progress' }, 'See all portraits')));
    resultBox.setAttribute('aria-label', w.label);
    const first = fresh && !earlier.length;
    paint();
    paintCompare();
    // The celebration is the picture; a chord answers only when headphones are already
    // confirmed (nothing is being scored now: the microphone is off).
    const tier = rewardTier({ firstTime: first, newBest: !bestChip.hidden });
    if (synth && tier !== 'note' && canChime({ enabled: settings.get('rewardSounds'), headphones: shell.headphones(), scoring: false })) {
      playChime(synth, chimePlan(tier, 1, config.rewards), config.rewards.chimeGainFrac * 0.5 * settings.get('toneVolume'));
    }
    heading.focus({ preventScroll: true });
  }

  function seeLast() {
    const all = readPortraits(store).checks;
    if (phase !== 'arrival' || !all.length) return;
    phase = 'portrait';
    showResult(all[all.length - 1], all.slice(0, -1));
  }

  function again() {
    if (phase !== 'portrait') return false;
    for (const old of shownPortraits.splice(0)) old.destroy();
    resultBox.replaceChildren();
    result = null; saved = null; compare = null; range = null; easy = null; hums = []; noteScores = []; tuneScores = []; easySkip = false;
    phase = 'arrival';
    return start();
  }

  // ---- frames, the microphone's state, keys
  const offFrame = micflow.onFrame((frame, level) => {
    if (dead || paused || (phase !== 'easy' && phase !== 'notes' && phase !== 'tunes') || part !== 'sing') return;
    if (rebase) { tOffset = lastT === null ? -frame.t : lastT + 0.5 - frame.t; rebase = false; }
    const t = frame.t + tOffset;
    lastT = t;
    if (phase === 'easy') easyFrame(frame, level, t); else turnFrame(frame, t);
  });
  const offState = micflow.subscribe((st) => {
    const running = phase === 'easy' || phase === 'notes' || phase === 'tunes';
    if (running) paintUnder();
    if (st.phase === 'lost') { wasOff = true; if (running) pause(true); }
    // Released in the middle (the page was hidden): the check waits, paused.
    else if (st.phase === 'off' && running) { wasOff = true; if (!paused && !starting && !reopening) pause(); }
    else if (st.phase === 'on' && wasOff) { wasOff = false; rebase = true; }
  });
  stage.onResume(resume);

  const onKey = (e) => {
    // The embedded range finder has its own keys while it is up.
    if (rf || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (spaceActs(e, { sheet: sheetOpen() })) {
      const shown = [...view.querySelectorAll('button[data-primary]:not([disabled])')].find((b) => !b.closest('[hidden]'));
      // Always: with no button to press, Space scrolled the page instead (review 4, finding 8).
      e.preventDefault();
      if (shown) shown.click();
      return;
    }
    if (sheetOpen() || e.repeat) return;
    if (e.key === 'Escape' && (!paused || reopening)) { pause(); if (paused) carryBtn.focus(); }
    if (e.key === 'r' || e.key === 'R') replay();
    if (e.key === 's' || e.key === 'S') skip();
  };
  const onSheet = (e) => {
    if (rf) return;
    if (e.detail.open) pause();
    // The level check is over: paused means the microphone is off.
    else if (paused && !reopening && micflow.mic) micflow.stop();
  };
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) pause(); };
  const onCalm = () => { stage.set({ calm: shell.calm() }); };
  // Heard first (capture): the shell's own Space, heard on the way up, presses the FIRST
  // main button in the view, which here is the arrival's hidden Start, and marks the key
  // as used; with focus on the page or the stage, "Carry on Space" and "Use it Space" then
  // did nothing (bugs.md 66). This handler marks Space as used, so the shell leaves it.
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  const offSettings = settings.subscribe((k) => { if (k === 'noteNames') stage.set({ noteStyle: noteStyle() }); });

  paintArrival();
  paint();

  return {
    start, useRange, measureAgain, pause, resume, replay, skip, again, seeLast,
    state: snapshot,
    stage,
    destroy() {
      dead = true;
      seq++;
      clearTimers();
      if (tone) tone.stop();
      // Left before the end: nothing is filed (the take is simply dropped) and no portrait
      // is saved. A range measured in step 1 was saved by the range finder itself.
      rec = null;
      if (rf) { rf.destroy(); rf = null; }
      const running = phase === 'easy' || phase === 'notes' || phase === 'tunes';
      // `starting`: still waiting for the microphone; without this it would open after the
      // screen has gone and stay on with nothing using it.
      if (starting || reopening || running) micflow.stop();
      shell.setBusy(null);
      delete view.dataset.phase; delete view.dataset.part;
      view.classList.remove('exercise', 'voice-check');
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      for (const p of shownPortraits.splice(0)) p.destroy();
      if (synth && !givenSynth) synth.ctx.close().catch(() => {});
      stage.destroy();
    },
  };
}
