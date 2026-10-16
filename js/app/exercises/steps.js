// exercises/steps.js — Star steps (#/practice/star-steps, rung 6) and Leaps and scales
// (#/practice/leaps, rung 7) on one screen (docs/design/specs/2026-10-15-patterns-intervals-scales.md
// sections 2, 6 to 9). Each item (a four-note pattern, a leap, the scale) is heard once, its bars
// come round again after a count-in, and the singer sings them in time; every bar is judged as
// its window closes and takes its after-note look. The plans, the judge and every word are
// js/app/steps.js (pure); the bars are stage.js's ribbon with ribbonJudge 'note', noteMarks and
// barLabels; the round frame (mic, pause, keys) follows Glide's mountRibbonScreen.
//
// THE MICROPHONE (owner rule 2026-10-12). Showing the screen asks for nothing and plays nothing.
// One press on Start (or Again, Resume) asks once for the whole round; it is released when the
// round ends, on Stop, Esc, any sheet, a hidden page, pagehide and leaving (destroy). H ("Hear it")
// plays the item with the microphone off. Readings during the Listen copy of an item are never
// judged (no headphones needed for judging, as Match and hold).
//
// CONTRACT — mountStepsScreen(view, { kind, shell, micflow, settings, storage?, sessions?, range?,
//                                     config?, micOptions?, synth?, day? }) -> screen
//   kind      'star-steps' | 'leaps'   (mountStarSteps / mountLeaps set it)
//   shell     needHeadphones(), headphones(), calm(), setBusy()
//   storage   localStorage-like: BPM_KEY(kind) speed, BEST_KEY(kind) most stars in a round,
//             RECENT_KEY last two leap rounds { leaps, leapsInTune } (bigLeapsEarned)
//   sessions  createSessions(): a finished round is filed as sessions.result(kind, { sec, facts:
//             { items, stars, notesIn, notesTotal, bpm, verdicts } }), verdicts one letter per
//             note in order (i in, c close, o off, n not heard), items joined by '|'.
//   range     exerciseRange(readRange()) or {} (then the 52..59 defaults and the not-fitted line)
//   screen.start(), stop(), pause(), resume(), next(), again(), hear(), setBpm(n)
//   screen.state() -> { kind, phase: 'ready' | 'run' | 'item' | 'done', step: 'listen' | 'imagine'
//                       | 'countin' | 'sing' | null, paused, starting, index, tryNo, bpm,
//                       round, results, summary, marks }
//   Events: 'mt:exercise' on document, detail { exercise: kind, event, ...state() };
//       event: start | listen | sing | note | item | done | paused | stopped
//   screen.view   the pitch view (js/app/hud.js)   screen.destroy()
//
// Extras (spec 6.2, 6.3, 10), pure and exported for the checks:
//   listenLight(notes, listenAt, t, { calm, ms }) -> [{ i, k }] bars lit during Listen, k 0..1
//   stepsReward(moment, { inTune, star, firstTime, calm, enabled, headphones, config })
//       -> { ring, tier, rings, sparks, sound: null | 'item' | 'round' }
//       moment 'note' (a bar judged) | 'item' (an item's result) | 'round' (the round's result).
//       A note never sounds: the mic is judging the next bar. Sounds need rewardSounds on AND
//       headphones 'on' (canChime). Calm motion: no ring, no sparks (the bar marks still ease).

import { createSynth, timbreFor } from '../../synth.js';
import { CONFIG } from '../config.js';
import { createPitchView } from '../hud.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { answerPlan, canChime, celebrationPlan, createRewardLayer, playAnswer, starSvg } from '../rewards.js';
import { h, icon, sheetOpen } from '../shell.js';
import { displayNote, ribbonFromTimeline } from '../stage.js';
import { bigLeapsEarned, itemResult, judgeNote, leapRound, patternRound, roundResult, STEPS_DEFAULTS, STEPS_WORDS, timing } from '../steps.js';
import { spaceActs } from './matchhold.js';

export const BPM_KEY = (kind) => `mt.steps.bpm.${kind}`;
export const BEST_KEY = (kind) => `mt.steps.best.${kind}`;
export const RECENT_KEY = 'mt.steps.recent.leaps';

const TITLES = Object.freeze({
  'star-steps': { name: 'Star steps', what: 'Four notes in time, walking up your range.' },
  leaps: { name: 'Leaps and scales', what: 'Jump from one note to another, then climb a scale.' },
});
const LEAD_SEC = 1.0;          // the Listen bars scroll in from the right before the first note
const END_PAD_SEC = 0.3;       // after the last sing window closes, before the item's result

// Note-tier rings at the voice head carry no sparks here (spec 6.3: notes come in tempo, a
// spark shower per bar would fill a moving stage). Only the First tier sheds sparks.
const fxRewards = (config) => ({ ...config.rewards, sparks: { ...config.rewards.sparks, note: 0 }, lookSparks: {} });

export function listenLight(notes, listenAt, t, { calm = false, ms = 200 } = {}) {
  const sec = Math.max(0.001, ms / 1000), lit = [];
  notes.forEach((n, i) => {
    const a = listenAt + n.t, b = a + n.dur;
    // Calm motion: a static outline for the note's length (no swell). Otherwise ease in from
    // the note's start and out after its end, so neighbouring bars hand over, never blink.
    let k = calm ? (t >= a && t < b ? 1 : 0) : t < a ? 0 : t < b ? Math.min(1, (t - a) / sec) : Math.max(0, 1 - (t - b) / sec);
    if (k <= 0) return;
    if (!calm) k = k * k * (3 - 2 * k);
    lit.push({ i, k });
  });
  return lit;
}

export function stepsReward(moment, {
  inTune = false, star = false, firstTime = false, calm = false, enabled = true, headphones = null, config = CONFIG,
} = {}) {
  const none = { ring: false, tier: null, rings: 0, sparks: 0, sound: null };
  const tier = moment === 'note' ? (inTune ? 'note' : null) : moment === 'round' && firstTime ? 'first' : null;
  const plan = tier ? celebrationPlan(tier, 1, fxRewards(config)) : null;
  // The mic is off (round) or between items (item) here: nothing is being judged.
  const ok = canChime({ enabled, headphones, scoring: false });
  const sound = moment === 'item' && star && ok ? 'item' : moment === 'round' && ok ? 'round' : null;
  if (!plan || calm) return { ...none, sound };
  return { ring: true, tier, rings: plan.rings, sparks: plan.sparks, sound };
}

const LIGHT_MS = 200;           // the constellation's lightMs: the Listen outline eases in and out
const LETTER = { in: 'i', close: 'c', off: 'o', none: 'n' };
const SQUARE = { in: ['tick', 'In tune'], close: ['wave', 'Close'], off: ['dash', 'Off'], none: ['dots', 'Not heard'] };

export function mountStarSteps(view, opts = {}) { return mountStepsScreen(view, { ...opts, kind: 'star-steps' }); }
export function mountLeaps(view, opts = {}) { return mountStepsScreen(view, { ...opts, kind: 'leaps' }); }

export function mountStepsScreen(view, {
  kind, shell, micflow, settings, storage = null, sessions = null, range = {}, config = CONFIG,
  micOptions, synth: givenSynth = null, day = null,
} = {}) {
  if (!TITLES[kind]) throw new TypeError(`mountStepsScreen: kind must be 'star-steps' or 'leaps', not ${kind}`);
  const T = TITLES[kind], W = STEPS_WORDS;
  const M = { toneTailMs: 150, imagineMs: 1200, autoNextMs: 1200, ...(config.matchhold || {}) };
  const smallMq = window.matchMedia('(max-width: 639px), (max-height: 519px)');
  const textEvery = createEvery(250);
  const read = (k) => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
  const write = (k, v) => { try { if (storage) storage.setItem(k, v); } catch { /* private mode: kept for this visit only */ } };
  const readJson = (k, d) => { try { return JSON.parse(read(k)) ?? d; } catch { return d; } };

  let dead = false, starting = false, paused = false, wantPause = false;
  let phase = 'ready', step = null, why = '', said = '';
  let bpm = timing(Number(read(BPM_KEY(kind))) || STEPS_DEFAULTS.bpm).bpm;
  let round = null, index = 0, tryNo = 0, results = [], summary = null, lay = null;
  let judged = [], readings = [], marks = [], tOffset = 0, rebase = true, lastT = 0, inRow = 0, recSec = 0;
  let synth = givenSynth, scheduled = [], limitId = null, nextId = null, octaveSaid = false, resumeNext = false;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };
  const drop = (id) => { if (id) { clearTimeout(id); timers.delete(id); } return null; };

  function plan() {
    if (kind === 'star-steps') return patternRound(range, { day: day || new Date().toISOString().slice(0, 10), bpm });
    return leapRound(range, { bpm, big: bigLeapsEarned(readJson(RECENT_KEY, [])) });
  }
  round = plan();

  // ---- the page
  const stepText = h('p', { class: 'ex-step' });
  const tray = h('ol', { class: 'star-tray' });
  const speedOut = h('output', { class: 'st-speed-out', for: `${kind}-speed` });
  const speed = h('input', { type: 'range', id: `${kind}-speed`, class: 'st-speed-input', min: String(STEPS_DEFAULTS.minBpm), max: String(STEPS_DEFAULTS.maxBpm), step: '1', value: String(bpm) });
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, 'aria-describedby': `${kind}-why` });
  const primaryWhy = h('p', { class: 'reason rb-why', id: `${kind}-why` });
  const fitLine = h('p', { class: 'reason rb-fit' });
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const bannerSlot = h('div'), viewHost = h('div', { class: 'st-stage' });
  const squares = h('ol', { class: 'st-squares' });
  const itemLine = h('p', { class: 'st-line', role: 'status' });
  const againBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Again ', h('kbd', { class: 'keycap' }, 'R'));
  const strip = h('section', { class: 'st-strip', 'aria-label': 'How that went', dataset: { shown: 'no' } },
    squares, h('div', { class: 'st-strip-main' }, itemLine, h('div', { class: 'st-strip-btns' }, againBtn)));
  view.classList.add('exercise', 'steps-ex', `${kind}-ex`);
  view.append(
    h('div', { class: 'title-row ex-head' },
      h('h1', { tabindex: '-1' }, T.name), stepText,
      h('div', { class: 'st-speed' }, h('label', { for: `${kind}-speed` }, 'Speed'), speed, speedOut),
      tray),
    h('p', { class: 'reason' }, T.what),
    fitLine, bannerSlot, viewHost, underLine, strip,
    h('div', { class: 'action-row' }, h('div', { class: 'action-main' }, primary, primaryWhy)));
  const pv = createPitchView(viewHost, { config });
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });
  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const phaseChip = h('div', { class: 'chip phase-chip', dataset: { role: 'quiet' }, 'aria-live': 'polite' }, chipIcon, chipWord);
  pv.stage.el.append(h('div', { class: 'stage-chips' }, phaseChip));
  // Rewards draw on the stage above the head (rewards.js); calm motion draws none of them.
  const layer = createRewardLayer(pv.stage, { config: { ...config, rewards: fxRewards(config) }, calm: () => shell.calm() });
  let rewardHandles = [], headMidi = null;
  // Listen light (spec 6.2): the bar sounding at the now line takes an --accent outline. The
  // stage's own clock is the last pushed reading's t, which is lastT, so the bar lines up.
  pv.stage.addLayer((ctx, L, tokens) => {
    if (!lay || phase !== 'run' || paused || step === 'sing') return;
    const lit = listenLight(lay.notes, lay.listenAt, lastT, { calm: shell.calm(), ms: LIGHT_MS });
    if (!lit.length) return;
    const half = lay.ribbon.half;
    ctx.save();
    ctx.strokeStyle = tokens.accent || getComputedStyle(pv.stage.el).getPropertyValue('--accent').trim() || '#9ab8ff';
    ctx.lineWidth = 2;
    for (const { i, k } of lit) {
      const n = lay.notes[i], x0 = L.xOfTime(lay.listenAt + n.t, lastT), x1 = L.xOfTime(lay.listenAt + n.t + n.dur, lastT);
      ctx.globalAlpha = k;
      ctx.beginPath();
      ctx.roundRect(x0, L.yOfMidi(n.midi + half), x1 - x0, 2 * half * L.laneH, Math.min(6, half * L.laneH));
      ctx.stroke();
    }
    ctx.restore();
  });

  const keycap = (k = 'Space') => h('kbd', { class: 'keycap' }, k);
  const noteStyle = () => settings.get('noteNames');
  const noteText = (m) => displayNote(m, noteStyle()).text;
  const item = () => round.items[Math.min(index, round.items.length - 1)];
  const running = () => phase === 'run' && !paused && !starting;
  const snapshot = () => ({
    kind, phase, step, paused, starting, index, tryNo, bpm, round, results: results.slice(),
    summary, marks: marks.slice(),
  });
  const emit = (event) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: kind, event, ...snapshot() } }));

  // One item's own clock: Listen copy, tail (+ imagine), count-in of 3 beats, Sing copy. Both
  // copies are bars of the same ribbon, so the singer sees the shape come round again.
  function layoutItem(it) {
    const t = timing(bpm);
    const notes = it.timeline.notes;
    const last = notes[notes.length - 1];
    const dur = last.t + last.dur;
    const imagine = settings.get('imagine') === false ? 0 : M.imagineMs / 1000;
    const listenAt = LEAD_SEC;
    const countAt = listenAt + dur + M.toneTailMs / 1000 + imagine;
    const singAt = countAt + 3 * t.beat;
    const shift = (at) => notes.map((n) => ({ ...n, t: n.t + at }));
    const ribbon = ribbonFromTimeline({ notes: [...shift(listenAt), ...shift(singAt)] }, { half: 0.5, joinGapSec: 0.05 });
    const syl = it.kind === 'scale' ? [1, 2, 3, 4, 5, 4, 3, 2, 1].slice(0, notes.length).map(String) : notes.map(() => 'la');
    const lows = notes.map((n) => n.midi);
    return {
      notes, dur, listenAt, imagineAt: listenAt + dur + M.toneTailMs / 1000, countAt, singAt, beat: t.beat,
      endAt: singAt + dur + STEPS_DEFAULTS.lagSec + END_PAD_SEC, ribbon, labels: [...syl, ...syl],
      low: Math.min(...lows) - 2, high: Math.max(...lows) + 2,
    };
  }

  const viewPatch = (state) => ({
    state, noteStyle: noteStyle(), calm: shell.calm(),
    meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches,
    target: null, ribbon: lay.ribbon, ribbonJudge: 'note', noteMarks: marks.slice(), barLabels: lay.labels,
    wide: true, range: { low: lay.low, high: lay.high }, freshTarget: true,
    nowFrac: config.stage.nowFracTarget, pxPerSec: config.stage.pxPerSecExercise, labelClearTopPx: 40,
  });

  // ---- painting
  function paintTray() {
    const items = round.items;
    tray.setAttribute('aria-label', `${results.filter((r) => r && r.star).length} of ${items.length} stars`);
    while (tray.children.length > items.length) tray.lastChild.remove();
    while (tray.children.length < items.length) tray.append(h('li', { class: 'tray-star' }));
    items.forEach((it, i) => {
      const r = results[i], li = tray.children[i], on = !!(r && r.star);
      li.setAttribute('aria-label', `${it.label}: ${r ? (on ? 'star' : 'no star') : 'not sung yet'}`);
      if (li.firstChild && li.hasAttribute('data-earned') === on) return;
      li.toggleAttribute('data-earned', on);
      li.replaceChildren(starSvg('held', config.rewards.trayStarPx), on ? icon('tick', 10) : '');
    });
  }

  function chip() {
    if (paused) return [W.chips.paused, 'pause'];
    if (phase === 'done') return [W.roundDone, 'star'];
    if (phase !== 'run') return ['Ready', 'play'];
    if (step === 'listen') return [W.chips.listen, 'speaker'];
    if (step === 'imagine') return [W.chips.imagine, 'speaker'];
    if (step === 'countin') return [W.chips.countIn(Math.max(1, Math.ceil((lay.singAt - lastT) / lay.beat))), 'mic'];
    return [W.chips.sing, 'mic'];
  }

  function paintUnder() {
    const banner = micflow.state().banner;
    const problem = running() && step === 'sing' && SIGNAL_PROBLEMS.includes(banner) ? banner : null;
    underLine.dataset.role = problem ? 'close' : '';
    if (problem) {
      underLine.replaceChildren(icon(problem === 'silence' ? 'mic-off' : 'warning', 16), h('span', null, MIC_WORDS[problem]));
      return;
    }
    const text = paused ? 'Paused. The microphone is off.' : said || (phase === 'ready' ? 'The microphone turns on when you press Start.' : '');
    if (underLine.textContent !== text) underLine.replaceChildren(text);
  }

  function paint() {
    const [word, ic] = chip();
    chipIcon.replaceChildren(icon(ic, 16));
    chipWord.textContent = word;
    const it = item();
    stepText.textContent = phase === 'done' ? W.roundDone : tryNo > 0 && phase === 'run' ? `${it.label}. ${W.again}` : it.label;
    const lines = round.lines.filter((l) => l !== W.notFitted);
    fitLine.replaceChildren(...(round.range.fitted
      ? [`Fitted to your range: ${noteText(round.range.lowMidi)} to ${noteText(round.range.highMidi)}.`, ...lines.map((l) => ` ${l}`)]
      : [`${W.notFitted} `, h('a', { href: '#/practice/range' }, W.findRange), ...lines.map((l) => ` ${l}`)]));
    const shown = paused ? 'paused' : phase;
    const label = starting ? 'Starting…' : { ready: 'Start', run: 'Stop', item: 'Next', done: 'Again', paused: 'Resume' }[shown];
    primary.replaceChildren(label, starting ? '' : ' ', starting ? '' : keycap());
    primary.disabled = starting;
    primary.className = `btn ${shown === 'run' ? 'btn-secondary' : 'btn-primary'}`;
    primaryWhy.textContent = starting ? 'Asking for the microphone…' : why;
    // 'round-done', not 'done': app.css hides an exercise's action row on data-phase="done".
    view.dataset.phase = shown === 'done' ? 'round-done' : shown;
    // The speed applies to the next round: locked from Start until the round is over (spec 4).
    const locked = phase === 'run' || phase === 'item' || paused || starting;
    speed.disabled = locked;
    speed.setAttribute('aria-disabled', String(locked));
    speed.value = String(bpm);
    speedOut.textContent = `${bpm} beats a minute`;
    againBtn.hidden = phase !== 'item';
    paintTray();
    paintUnder();
  }

  function setGlow(run) {
    // Spec 6.3: edge glow after 2 / 4 / 6 notes in tune in a row; off in calm motion.
    const level = shell.calm() ? 0 : run >= 6 ? 3 : run >= 4 ? 2 : run >= 2 ? 1 : 0;
    viewHost.dataset.glow = String(level);
  }

  function showStrip(res) {
    squares.replaceChildren(...res.notes.map((v, i) => {
      const [ic, word] = SQUARE[v];
      return h('li', { class: 'st-square', dataset: { v }, 'aria-label': `Note ${i + 1}: ${word}` }, icon(ic, 16));
    }));
    const extra = res.retry ? ` ${W.again}` : '';
    const oct = res.octave && !octaveSaid ? ` ${W.octave(res.octave < 0 ? 'low' : 'high')}` : '';
    if (oct) octaveSaid = true;
    itemLine.textContent = `${res.line}${oct}${extra}`;
    strip.dataset.shown = 'yes';
    strip.dataset.mode = 'item';
  }

  function showResult() {
    const s = summary;
    squares.replaceChildren(...round.items.map((it, i) => {
      const r = results[i], on = !!(r && r.star);
      return h('li', { class: 'tray-star', 'data-earned': on ? '' : null, 'aria-label': s.starWords[i] || `${it.label}: not sung` }, starSvg('held', config.rewards.trayStarPx));
    }));
    itemLine.replaceChildren(
      h('strong', { class: 'st-done' }, W.roundDone), ' ', s.lines.join(' '),
      s.newBest ? h('span', { class: 'chip', dataset: { role: 'gold' } }, icon('star', 16), 'New best') : '',
      s.bestLine ? ` ${s.bestLine}` : '',
      s.firstTime ? h('span', { class: 'chip', dataset: { role: 'accent' } }, icon('star', 16), 'First time') : '');
    strip.dataset.shown = 'yes';
    strip.dataset.mode = 'round';
    strip.toggleAttribute('data-best', !!s.newBest);
  }

  // ---- sound
  function ensureSynth() { synth = synth || createSynth(); return synth; }
  function playItem(it, atSec) {
    const s = ensureSynth();
    const timbre = timbreFor(settings.get('tone'));
    const base = s.ctx.currentTime + atSec;
    return it.timeline.notes.map((n) => s.play({ midi: n.midi, dur: n.dur, timbre, gain: 0.5 * settings.get('toneVolume'), tag: 'tone', when: base + n.t }));
  }
  function hush() { for (const t of [...scheduled, ...rewardHandles]) { try { t.stop(0.05); } catch { /* already over */ } } scheduled = []; rewardHandles = []; }
  function rewardSound(midi, count) {
    try {
      for (const t of rewardHandles) t.stop(0.05);
      rewardHandles = playAnswer(ensureSynth(), answerPlan(midi, count, config.rewards.answer), 0.5 * settings.get('toneVolume'), config.rewards.answer);
    } catch { rewardHandles = []; /* no sound: the star still shows */ }
  }

  // ---- the round
  async function open() {
    starting = true; wantPause = false; why = ''; said = '';
    paint();
    const fail = (text) => { starting = false; why = text; paint(); return false; };
    // Before the first reference tone of a visit (spec 10.4 of the main spec): the answer decides
    // whether reward sounds may play at all, as in Match and hold.
    const phones = shell.needHeadphones ? await shell.needHeadphones() : 'none';
    if (dead) return false;
    if (!phones) return fail('Say whether you are wearing headphones, then press Start.');
    const ok = await micflow.request(micOptions || {});
    if (dead) return false;
    if (!ok) return fail('The microphone is not on yet.');
    try { ensureSynth(); } catch { micflow.stop(); return fail('This browser could not start sound.'); }
    starting = false;
    if (wantPause || document.hidden) { wantPause = false; paused = true; micflow.stop(); return 'paused'; }
    return true;
  }

  function beginItem() {
    nextId = drop(nextId);
    paused = false;
    lay = layoutItem(item());
    judged = new Array(lay.notes.length).fill(null); readings = []; marks = [];
    rebase = true; lastT = 0; step = 'listen'; headMidi = null;
    hush();
    strip.dataset.shown = 'no';
    pv.clear();
    pv.set({ ...viewPatch('live'), voiceAlpha: 1 });
    pv.stage.start();
    micflow.setListening(true);
    shell.setBusy(guard);
    limitId = drop(limitId);
    limitId = later(() => { limitId = null; if (running()) endItem(); }, (lay.endAt + 3) * 1000);
    phase = 'run';
    paint();
    emit('listen');
  }

  async function start() {
    if (starting || paused || phase === 'run') return false;
    round = plan(); index = 0; tryNo = 0; results = []; summary = null; recSec = 0; inRow = 0; octaveSaid = false;
    strip.removeAttribute('data-best');
    const got = await open();
    if (dead || got === false) return false;
    emit('start');
    if (got === 'paused') { phase = 'run'; lay = layoutItem(item()); enterPaused(); return true; }
    beginItem();
    return true;
  }

  function judgeDue(force) {
    for (let i = 0; i < lay.notes.length; i++) {
      if (judged[i]) continue;
      const n = lay.notes[i];
      if (!force && lastT - lay.singAt < n.t + n.dur + STEPS_DEFAULTS.lagSec) continue;
      const j = judgeNote(readings, n);
      judged[i] = j;
      marks.push({ t0: lay.singAt + n.t, t1: lay.singAt + n.t + n.dur, midi: n.midi, kind: j.verdict, dir: j.dir });
      inRow = j.verdict === 'in' ? inRow + 1 : 0;
      setGlow(inRow);
      // One ring at the voice head, no sparks, no sound (the mic is judging the next bar).
      if (stepsReward('note', { inTune: j.verdict === 'in', calm: shell.calm(), config }).ring) {
        layer.burst({ midi: Number.isFinite(headMidi) ? headMidi : n.midi, tier: 'note' });
      }
      pv.stage.set({ noteMarks: marks.slice() });
      emit('note');
    }
  }

  function endItem() {
    if (phase !== 'run') return;
    judgeDue(true);
    hush();
    limitId = drop(limitId);
    recSec += lay.dur;
    const res = itemResult(item(), judged, { tryNo });
    results[index] = res;
    phase = 'item'; step = null;
    // Between items nothing is judged; the answering chord still needs headphones (canChime).
    const fx = stepsReward('item', { star: !!res.star, enabled: settings.get('rewardSounds'), headphones: shell.headphones(), config });
    if (fx.sound) rewardSound(lay.notes[lay.notes.length - 1].midi, inRow);
    showStrip(res);
    paint();
    emit('item');
    if (!primary.disabled) primary.focus({ preventScroll: true });
    nextId = later(() => { nextId = null; if (phase === 'item' && !paused) next(); }, M.autoNextMs);
  }

  function next() {
    if (phase !== 'item' || paused) return;
    const res = results[index];
    if (res && res.retry && tryNo === 0) tryNo = 1;
    else { index += 1; tryNo = 0; }
    if (index >= round.items.length) { finish('end'); return; }
    beginItem();
  }

  function again() {
    if (phase !== 'item' || paused) return;
    tryNo = Math.max(tryNo, 1);
    beginItem();
  }

  function release() {
    hush();
    limitId = drop(limitId); nextId = drop(nextId);
    micflow.setListening(false);
    micflow.stop();
    shell.setBusy(null);
    pv.stage.hold(null);
    pv.hud.update(null, 0);
  }

  function finish(how) {
    if (phase !== 'run' && phase !== 'item') return;
    if (phase === 'run' && how === 'end') endItem();
    release();
    setGlow(0);
    step = null; paused = false;
    const done = results.filter(Boolean);
    // Let a First-time burst finish before the stage stops drawing (cap: a hidden tab has no rAF).
    const stopAt = performance.now() + 2500;
    const stopQuiet = () => { if (phase === 'run') return; if (layer.busy() && performance.now() < stopAt) later(stopQuiet, 100); else pv.stage.stop(); };
    later(stopQuiet, 750);
    if (!done.length) {
      phase = 'ready';
      said = 'Stopped. Press Start when you are ready.';
      strip.dataset.shown = 'no';
      paint();
      emit('stopped');
      return;
    }
    const bestWas = Number(read(BEST_KEY(kind)));
    summary = roundResult(done, { kind, best: Number.isFinite(bestWas) && read(BEST_KEY(kind)) !== null ? bestWas : null });
    if (summary.newBest || read(BEST_KEY(kind)) === null) write(BEST_KEY(kind), String(Math.max(summary.stars, Number.isFinite(bestWas) ? bestWas : 0)));
    if (kind === 'leaps') write(RECENT_KEY, JSON.stringify([...readJson(RECENT_KEY, []), { leaps: summary.leaps, leapsInTune: summary.leapsInTune }].slice(-2)));
    if (sessions) {
      try {
        sessions.result(kind, { sec: Math.round(recSec * 10) / 10, facts: {
          items: done.length, stars: summary.stars, notesIn: summary.notesIn, notesTotal: summary.notesTotal, bpm,
          verdicts: done.map((r) => r.notes.map((v) => LETTER[v]).join('')).join('|'),
        } });
      } catch { /* the record is a nicety: the round itself is done */ }
    }
    phase = 'done'; said = '';
    showResult();
    const lastMidi = round.items[round.items.length - 1].timeline.notes.slice(-1)[0].midi;
    const fx = stepsReward('round', {
      firstTime: !!summary.firstTime, calm: shell.calm(), enabled: settings.get('rewardSounds'), headphones: shell.headphones(), config,
    });
    if (fx.ring) layer.burst({ midi: lastMidi, tier: fx.tier, pair: true });
    if (fx.sound) rewardSound(lastMidi, config.rewards.answer.semis.length);
    paint();
    emit('done');
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  function enterPaused() {
    paused = true;
    pv.set({ state: 'paused' });
    paint();
    emit('paused');
    later(() => { if (paused) pv.stage.stop(); }, 750);
  }

  function pause() {
    if (starting) { wantPause = true; return; }
    if (paused || (phase !== 'run' && phase !== 'item')) return;
    const flow = micflow.state().phase;
    hush();
    limitId = drop(limitId); nextId = drop(nextId);
    micflow.setListening(false);
    if (micflow.mic && flow !== 'lost' && flow !== 'checking') micflow.stop();
    shell.setBusy(null);
    // An item cut short is not judged: Resume plays it again from Listen. A finished item's
    // result stands and Resume goes on to the next.
    if (phase === 'item') resumeNext = true;
    phase = 'run'; step = null;
    pv.set({ state: flow === 'lost' ? 'lost' : 'paused' });
    enterPaused();
  }

  async function resume() {
    if (!paused || starting) return;
    const got = await open();
    if (dead || got !== true) { paint(); return; }
    paused = false;
    if (resumeNext) {
      resumeNext = false;
      const res = results[index];
      if (res && res.retry && tryNo === 0) tryNo = 1; else { index += 1; tryNo = 0; }
      if (index >= round.items.length) { phase = 'item'; finish('end'); return; }
    }
    beginItem();
  }

  function stop() {
    if (starting || paused) return;
    if (phase === 'run' || phase === 'item') finish('stop');
  }

  // H: hear the item with the microphone off (ready, item result).
  function hear() {
    if (starting || paused || phase === 'run') return;
    try { hush(); scheduled = playItem(phase === 'item' ? item() : round.items[0], 0.05); } catch { why = 'This browser could not start sound.'; paint(); }
  }

  function setBpm(v) {
    if (phase === 'run' || phase === 'item' || paused || starting) return;
    bpm = timing(v).bpm;
    write(BPM_KEY(kind), String(bpm));
    round = plan(); lay = layoutItem(item());
    pv.set(viewPatch('idle'));
    paint();
  }

  const guard = async () => true;

  const offFrame = micflow.onFrame((frame, level) => {
    if (dead || !running()) return;
    if (rebase) {
      tOffset = -frame.t; rebase = false;
      // The Listen copy plays on this item's clock: its first bar reaches the now line as it sounds.
      try { scheduled = playItem(item(), lay.listenAt); } catch { /* no sound: the bars still teach the shape */ }
    }
    const t = frame.t + tOffset;
    lastT = t;
    const before = step;
    step = t < lay.imagineAt ? 'listen' : t < lay.countAt ? 'imagine' : t < lay.singAt ? 'countin' : 'sing';
    if (step === 'sing') {
      readings.push({ t: t - lay.singAt, midi: frame.voiced ? frame.midi : null });
      headMidi = frame.voiced ? frame.midi : null;
      pv.push({ ...frame, t }, level);
      judgeDue(false);
    } else {
      // Before the Sing copy the voice is not drawn or judged (the tone may be in the mic):
      // the bars still scroll on the frame clock.
      pv.push({ ...frame, t, voiced: false, midi: null }, level);
    }
    if (step !== before) { paint(); if (step === 'sing') emit('sing'); }
    else if (step === 'countin' || textEvery.due(performance.now())) paint();
    if (t >= lay.endAt) endItem();
  });
  const offState = micflow.subscribe((st) => {
    if (dead) return;
    if (running() && (st.phase === 'lost' || st.phase === 'off')) pause();
    else paintUnder();
  });

  primary.addEventListener('click', () => {
    if (paused) resume();
    else if (phase === 'run') stop();
    else if (phase === 'item') next();
    else start();
  });
  againBtn.addEventListener('click', again);
  speed.addEventListener('input', () => setBpm(Number(speed.value)));
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
    if (e.key === 'Escape' && !paused && (phase === 'run' || phase === 'item')) { e.preventDefault(); pause(); primary.focus(); return; }
    if (sheetOpen()) return;
    const k = e.key.toLowerCase();
    if (k === 'r' && phase === 'item') { e.preventDefault(); again(); return; }
    if (k === 'h') { e.preventDefault(); hear(); return; }
    if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
      e.preventDefault();
      setBpm(bpm + (e.key === '[' || e.key === '{' ? -1 : 1) * (e.shiftKey ? 5 : 1));
    }
  };
  const onSheet = (e) => {
    if (e.detail.open) pause();
    else if (paused && !starting && micflow.mic) micflow.stop();
  };
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) pause(); };
  const onCalm = () => { pv.set({ calm: shell.calm(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); setGlow(inRow); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  smallMq.addEventListener('change', onCalm);
  const offSettings = settings.subscribe((k) => {
    if (k === 'noteNames' || k === 'pitchView') { pv.set({ noteStyle: noteStyle(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); paint(); }
  });

  // Ready: the first item's bars are already drawn, parked to the right of the now line.
  lay = layoutItem(item());
  pv.set(viewPatch('idle'));
  setGlow(0);
  paint();

  return {
    start, stop, pause, resume, next, again, hear, setBpm,
    state: snapshot,
    view: pv,
    destroy() {
      dead = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      hush();
      if (starting || phase === 'run' || phase === 'item') micflow.stop();
      micflow.setListening(false);
      shell.setBusy(null);
      delete view.dataset.phase;
      view.classList.remove('exercise', 'steps-ex', `${kind}-ex`);
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      smallMq.removeEventListener('change', onCalm);
      hush();
      layer.destroy();
      pv.destroy();
      if (synth && !givenSynth) synth.ctx.close().catch(() => {});
    },
  };
}
