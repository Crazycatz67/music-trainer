// glide.js — Glide warm-up, #/practice/glide (spec section 7.1), and the screen it shares with
// the Siren (js/app/exercises/siren.js, spec 7.4). A ribbon (a path 3 semitones tall) comes in
// from the right; the singer hums or lip-trills along it, following the dot. Each pass that
// keeps the sound going and stays with the path earns a star. Warm-ups are gentle: only two
// verdicts ("With the path", "Off the path"), never the pink "off" style, never a "fail".
// The plans, the judging and the words are js/app/glide.js; the ribbon is drawn by stage.js.
//
// The microphone is on only while the passes are being sung (owner rule 2026-10-12): a press on
// Start (or Again, or Resume) opens it, and it is released when the last pass ends, after the
// plan's length plus a few seconds whatever happens (the frames may stop coming), on Stop, Esc,
// any sheet, a hidden page, pagehide and leaving. No reference tone is played, so no headphones.
//
// CONTRACT — mountRibbonScreen(view, { kind, shell, micflow, settings, config?, micOptions?,
//                                      range?, sessions?, decorate? }) -> screen
//   kind        'glide' | 'siren'
//   shell needs: calm(), setBusy()
//   config      CONFIG; config.glide / config.siren override RIBBON_DEFAULTS[kind] when present
//   micOptions  passed to micflow.request(): { stream } runs the screen with no microphone
//   range       js/app/range.js exerciseRange(saved): the path is fitted to it (else a default)
//   sessions    js/app/sessions.js createSessions(): a finished round is filed as
//               sessions.result(kind, { sec, facts: { passes, stars, voiced, inside, cover, breaks } })
//               (shares in whole percent). NOTE: sessions.js keeps only exercises it knows; until
//               'glide' and 'siren' are added to its EXERCISES set the record drops these.
//   decorate    (api) -> { onFrame?(frame, plan), onPlan?(plan), reset?() }   the Siren's ladder
//   screen.start() -> Promise<boolean>   Start / Again (a new round)
//   screen.stop()      ends the round: passes already sung keep their stars
//   screen.pause(), screen.resume() -> Promise   Resume carries on from the next unsung pass
//   screen.state() -> { kind, phase: 'ready' | 'sing' | 'done', paused, starting, plan: { low, high,
//                       fitted, passes }, scores: [score | null] (js/app/glide.js scorePass), stars,
//                       marks: [{ t, midi }], ended }
//   screen.view   the pitch view (js/app/hud.js)   screen.destroy()
//   Events: 'mt:exercise' on document, detail { exercise: kind, event, ...state() }.
//       event: start | sing | pass | done | paused | stopped
//
// Mount it through mountGlide(view, opts) (kind 'glide') or siren.js mountSiren.
// Not built here: the first-time intro card and its mini-animation, the "First" tier record
// (the Siren's whole-range chip is shown each time, not saved), the daily-session order.

import { CONFIG } from '../config.js';
import { createPitchView } from '../hud.js';
import { passWords, breakWords, RIBBON_DEFAULTS, ribbonPlan, roundWords, scorePass, WORDS } from '../glide.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { starSvg } from '../rewards.js';
import { h, icon, sheetOpen } from '../shell.js';
import { displayNote } from '../stage.js';
import { spaceActs } from './matchhold.js';

export const RIBBON_CHIP = Object.freeze({
  ready: { word: 'Ready', icon: 'play' },
  sing: { word: 'Sing', icon: 'mic' },
  done: { word: 'Round done', icon: 'star' },
  paused: { word: 'Paused', icon: 'pause' },
});

export function mountGlide(view, opts = {}) {
  return mountRibbonScreen(view, { ...opts, kind: 'glide' });
}

export function mountRibbonScreen(view, {
  kind, shell, micflow, settings, config = CONFIG, micOptions, range = {}, sessions = null, decorate = null,
} = {}) {
  if (kind !== 'glide' && kind !== 'siren') throw new TypeError(`mountRibbonScreen: kind must be 'glide' or 'siren', not ${kind}`);
  const cfg = { ...RIBBON_DEFAULTS[kind], ...(config[kind] || {}) };
  const W = WORDS[kind];
  const smallMq = window.matchMedia('(max-width: 639px), (max-height: 519px)');
  const textEvery = createEvery(250);

  let dead = false, starting = false, paused = false, wantPause = false, phase = 'ready', why = '', said = '', ended = null;
  let plan = ribbonPlan(kind, range, cfg), frames = [], tOffset = 0, rebase = true, scores = new Array(cfg.passes).fill(null), marks = [];
  let lastT = 0, recSec = 0, limitId = null;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };

  // ---- the page
  const stepText = h('p', { class: 'ex-step' });
  const tray = h('ol', { class: 'star-tray' });
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, 'aria-describedby': `${kind}-why` });
  const primaryWhy = h('p', { class: 'reason rb-why', id: `${kind}-why` });
  const fitLine = h('p', { class: 'reason rb-fit' });
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const bannerSlot = h('div'), viewHost = h('div'), cardSlot = h('div', { class: 'rb-slot' });
  view.classList.add('exercise', 'ribbon-ex', `${kind}-ex`);
  view.append(
    h('div', { class: 'title-row ex-head' },
      h('a', { class: 'btn btn-quiet back', href: '#/practice' }, icon('back', 16), ' Back'),
      h('h1', { tabindex: '-1' }, W.name), stepText, tray),
    h('p', { class: 'reason' }, W.what, ' ', h('span', { class: 'rb-safety' }, WORDS.safety)),
    fitLine, bannerSlot, viewHost, underLine, cardSlot,
    h('div', { class: 'action-row' }, h('div', { class: 'action-main' }, primary, primaryWhy)));
  const pv = createPitchView(viewHost, { config });
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });
  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const phaseChip = h('div', { class: 'chip phase-chip', dataset: { role: 'quiet' }, 'aria-live': 'polite' }, chipIcon, chipWord);
  pv.stage.el.append(h('div', { class: 'stage-chips' }, phaseChip));
  // The round's result, in its own reserved place under the stage (as Long note's): over the
  // stage it would cover the path it describes.
  const card = h('section', { class: 'rb-card', 'aria-label': `Your ${W.units}`, dataset: { shown: 'no' } });
  cardSlot.append(card);

  const keycap = (k = 'Space') => h('kbd', { class: 'keycap' }, k);
  const noteStyle = () => settings.get('noteNames');
  const noteText = (m) => displayNote(m, noteStyle()).text;
  const stars = () => scores.filter((s) => s && s.passed).length;
  const snapshot = () => ({
    kind, phase, paused, starting, ended, scores: scores.slice(), stars: stars(), marks: marks.slice(),
    plan: { low: plan.low, high: plan.high, fitted: plan.fitted, passes: plan.passes.map((p) => ({ ...p })) },
  });
  const emit = (event) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: kind, event, ...snapshot() } }));
  const deco = decorate ? decorate({ stage: pv.stage, config, cfg, kind }) || {} : {};

  const viewPatch = (state) => ({
    state, noteStyle: noteStyle(), calm: shell.calm(),
    meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches,
    target: null, ribbon: plan.ribbon, ribbonMarks: marks.slice(), wide: true, range: { low: plan.low, high: plan.high },
    nowFrac: config.stage.nowFracTarget, labelClearTopPx: 40,
  });

  function paintTray() {
    tray.setAttribute('aria-label', `${stars()} of ${cfg.passes} stars`);
    while (tray.children.length < cfg.passes) tray.append(h('li', { class: 'tray-star' }));
    scores.forEach((s, i) => {
      const li = tray.children[i], on = !!(s && s.passed);
      li.setAttribute('aria-label', `${W.unit} ${i + 1} of ${cfg.passes}: ${s ? (on ? 'star' : 'no star') : 'not sung yet'}`);
      if (li.firstChild && li.hasAttribute('data-earned') === on) return;
      li.toggleAttribute('data-earned', on);
      li.replaceChildren(starSvg('held', config.rewards.trayStarPx), on ? icon('tick', 10) : '');
    });
  }

  // Which pass the take is in now, or the gap before the next: for the step and the words.
  function where() {
    for (const p of plan.passes) {
      if (lastT < p.t0) return { pass: p, before: true };
      if (lastT <= p.t1) return { pass: p, before: false };
    }
    return { pass: null, before: false };
  }

  let underKey = null;
  function paintUnder() {
    const banner = micflow.state().banner;
    const singing = phase === 'sing' && !paused && !starting;
    const problem = singing && SIGNAL_PROBLEMS.includes(banner) ? banner : null;
    let text = said || WORDS.micWhen;
    if (problem) text = MIC_WORDS[problem];
    else if (paused) text = WORDS.paused;
    else if (singing) {
      const w = where();
      const lastScore = [...scores].reverse().find(Boolean);
      text = !w.pass ? WORDS.following : !w.before ? WORDS.following
        : w.pass.index === plan.passes[0].index ? WORDS.waiting
          : (lastScore && passWords(lastScore, kind, noteText).tip) || WORDS.breathe;
    } else if (phase === 'done') text = said || '';
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
    const shown = paused ? 'paused' : phase;
    const chip = RIBBON_CHIP[shown];
    chipIcon.replaceChildren(icon(chip.icon, 16));
    chipWord.textContent = chip.word;
    const w = where();
    const n = phase === 'sing' && w.pass ? w.pass.index + 1 : Math.min(cfg.passes, scores.filter(Boolean).length + 1);
    stepText.textContent = phase === 'done' ? 'Round done' : `${W.unit[0].toUpperCase()}${W.unit.slice(1)} ${n} of ${cfg.passes}`;
    fitLine.textContent = plan.fitted ? `${WORDS.fitted} ${noteText(plan.low)} to ${noteText(plan.high)}.` : WORDS.noRange;
    const label = starting ? 'Starting…' : { ready: 'Start', sing: 'Stop', done: 'Again', paused: 'Resume' }[shown];
    primary.replaceChildren(label, starting ? '' : ' ', starting ? '' : keycap());
    primary.disabled = starting;
    // While singing the main button is the quiet kind: nothing bright under the eyes.
    primary.className = `btn ${shown === 'sing' ? 'btn-secondary' : 'btn-primary'}`;
    primaryWhy.textContent = starting ? 'Waiting for the microphone.' : why;
    // 'round-done', not 'done': app.css hides an exercise's action row on data-phase="done",
    // and here that row holds Again.
    view.dataset.phase = shown === 'done' ? 'round-done' : shown;
    paintTray();
    paintUnder();
  }

  function showCard() {
    const done = scores.filter(Boolean);
    if (!done.length) { card.dataset.shown = 'no'; return; }
    const allBreaks = done.flatMap((s) => s.breaks);
    const tips = done.map((s) => passWords(s, kind, noteText));
    const missed = done.find((s) => !s.passed);
    const tip = kind === 'siren' && allBreaks.length ? breakWords(allBreaks, noteText)
      : (tips.find((t) => t.tip) || {}).tip || (missed ? passWords(missed, kind, noteText).line : '');
    const whole = done.some((s) => s.whole);
    card.replaceChildren(
      h('div', { class: 'rb-main' },
        h('div', { class: 'done-stars', 'aria-hidden': 'true' }, scores.map((s) => h('span', { class: 'tray-star', 'data-earned': s && s.passed ? '' : null }, starSvg('held', config.rewards.trayStarPx)))),
        h('p', { class: 'rb-line' }, roundWords(scores, kind, cfg.passes)),
        whole && h('span', { class: 'chip', dataset: { role: 'gold' } }, icon('star', 16), WORDS.whole)),
      h('p', { class: 'reason rb-tip' }, tip || (missed ? '' : WORDS.passed)));
    card.dataset.shown = 'yes';
  }

  // ---- listening

  // Asks for the microphone. Only ever reached from a press (Start, Again, Resume).
  async function open() {
    starting = true; wantPause = false; why = ''; said = '';
    paint();
    const ok = await micflow.request(micOptions || {});
    starting = false;
    if (dead) return false;
    if (!ok) { why = 'The microphone is not on yet.'; paint(); return false; }
    if (wantPause || document.hidden) { wantPause = false; paused = true; micflow.stop(); return 'paused'; }
    return true;
  }

  function firstUnsung() { const i = scores.findIndex((s) => s === null); return i < 0 ? cfg.passes : i; }

  function listen() {
    paused = false;
    plan = ribbonPlan(kind, range, cfg, { fromPass: firstUnsung() });
    frames = []; rebase = true; lastT = 0;
    // Marks belong to the path they were left on; a new path (Resume) starts clean.
    marks = [];
    card.dataset.shown = 'no';
    pv.clear();
    if (deco.onPlan) deco.onPlan(plan);
    pv.set({ ...viewPatch('live'), voiceAlpha: 1 });
    pv.stage.start();
    micflow.setListening(true);
    // The hard limit on the wall clock as well as the frame clock: if the frames stop coming,
    // the microphone is still let go.
    clearTimeout(limitId);
    limitId = later(() => { limitId = null; if (phase === 'sing' && !paused && !starting) finish('time'); }, (plan.endSec + 3) * 1000);
    phase = 'sing';
    paint();
    emit('sing');
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  async function start() {
    if (starting || paused || phase === 'sing') return false;
    scores = new Array(cfg.passes).fill(null); marks = []; ended = null; recSec = 0;
    if (deco.reset) deco.reset();
    const got = await open();
    if (dead) return false;
    if (got === false) return false;
    emit('start');
    if (got === 'paused') { phase = 'sing'; enterPaused(); return true; }
    listen();
    return true;
  }

  function release() {
    clearTimeout(limitId);
    micflow.setListening(false);
    micflow.stop();
    pv.stage.hold(null);
    pv.hud.update(null, 0);
  }

  const REST_MS = ((config.aurora && config.aurora.cutFadeMs) || 600) + 150;

  function finish(how) {
    if (phase !== 'sing') return;
    // Passes whose end the take reached are judged now (Stop just after one ended).
    for (const p of plan.passes) if (!scores[p.index] && lastT >= p.t1) judge(p);
    phase = 'done'; paused = false; ended = how;
    // The picture stays: the path and the line as they were sung, still (no centre card over it).
    release();
    later(() => { if (phase !== 'sing') pv.stage.stop(); }, REST_MS);
    const done = scores.filter(Boolean);
    if (!done.length) {
      // Nothing sung to the end of a pass: back to the start, never a "fail".
      phase = 'ready';
      said = how === 'stop' ? WORDS.stopped : WORDS.nearly;
      paint();
      emit('stopped');
      return;
    }
    said = '';
    if (sessions) {
      const pct = (k) => Math.round(100 * done.reduce((a, s) => a + s[k], 0) / done.length);
      try {
        sessions.result(kind, { sec: Math.round(recSec * 10) / 10, facts: { passes: done.length, stars: stars(), voiced: pct('voicedShare'), inside: pct('insideShare'), cover: pct('coverShare'), breaks: done.reduce((a, s) => a + s.breaks.length, 0) } });
      } catch { /* the record is a nicety: the round itself is done */ }
    }
    showCard();
    paint();
    emit('done');
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  function judge(p) {
    const s = scorePass(frames, p, plan.ribbon, kind, cfg, kind === 'siren' ? { low: plan.low, high: plan.high } : null);
    scores[p.index] = s;
    recSec += p.t1 - p.t0;
    if (s.breaks.length) {
      marks.push(...s.breaks.map((b) => ({ t: b.t, midi: b.midi })));
      pv.stage.set({ ribbonMarks: marks.slice() });
    }
    paint();
    emit('pass');
  }

  function enterPaused() {
    paused = true;
    pv.set({ state: 'paused' });
    paint();
    emit('paused');
    later(() => { if (paused) pv.stage.stop(); }, REST_MS);
  }

  function pause() {
    if (starting) { wantPause = true; return; }
    if (paused || phase !== 'sing') return;
    const flow = micflow.state().phase;
    paused = true;
    clearTimeout(limitId);
    micflow.setListening(false);
    if (micflow.mic && flow !== 'lost' && flow !== 'checking') micflow.stop();
    // The pass being sung is not judged: Resume sings it again from its start.
    pv.set({ state: flow === 'lost' ? 'lost' : 'paused' });
    paint();
    emit('paused');
    later(() => { if (paused) pv.stage.stop(); }, REST_MS);
  }

  async function resume() {
    if (!paused || starting) return;
    const got = await open();
    if (dead) return;
    if (got !== true) { paint(); return; }
    if (firstUnsung() >= cfg.passes) { paused = false; phase = 'sing'; finish('end'); return; }
    listen();
  }

  function stop() {
    if (paused || starting || phase !== 'sing') return;
    finish('stop');
  }

  const offFrame = micflow.onFrame((frame, level) => {
    if (dead || paused || starting || phase !== 'sing') return;
    if (rebase) { tOffset = -frame.t; rebase = false; }
    const f = { ...frame, t: frame.t + tOffset };
    lastT = f.t;
    frames.push({ t: f.t, midi: f.voiced ? f.midi : null, voiced: !!f.voiced });
    pv.push(f, level);
    if (deco.onFrame) deco.onFrame(f, plan);
    for (const p of plan.passes) if (!scores[p.index] && f.t >= p.t1) judge(p);
    if (f.t >= plan.endSec) { finish('end'); return; }
    if (textEvery.due(performance.now())) { paintUnder(); const w = where(); if (w.pass) stepText.textContent = `${W.unit[0].toUpperCase()}${W.unit.slice(1)} ${w.pass.index + 1} of ${cfg.passes}`; }
  });
  const offState = micflow.subscribe((st) => {
    if (dead) return;
    const singing = phase === 'sing' && !paused && !starting;
    if (singing && (st.phase === 'lost' || st.phase === 'off')) pause();
    else paintUnder();
  });

  primary.addEventListener('click', () => {
    if (paused) resume();
    else if (phase === 'sing') stop();
    else start();
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
    else if (paused && !starting && micflow.mic) micflow.stop();
  };
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) pause(); };
  const onCalm = () => { pv.set({ calm: shell.calm(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  smallMq.addEventListener('change', onCalm);
  const offSettings = settings.subscribe((k) => {
    if (k === 'noteNames' || k === 'pitchView') { pv.set({ noteStyle: noteStyle(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); paint(); }
  });

  // Before Start the path is already there, coming in from the right: the singer sees the
  // shape before the microphone is asked for.
  if (deco.onPlan) deco.onPlan(plan);
  pv.set(viewPatch('idle'));
  paint();

  return {
    start, stop, pause, resume,
    state: snapshot,
    view: pv,
    destroy() {
      dead = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (starting || phase === 'sing') micflow.stop();
      shell.setBusy(null);
      delete view.dataset.phase;
      view.classList.remove('exercise', 'ribbon-ex', `${kind}-ex`);
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      smallMq.removeEventListener('change', onCalm);
      if (deco.destroy) deco.destroy();
      pv.destroy();
    },
  };
}
