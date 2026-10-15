// tutorial.js — the first-visit tour on screen ("Your first night"): the layer, the card, the
// guide star, the spotlight, the pause pill and Settings › Tour. The rules (which step comes
// next, the meters, the voice pick, where the card docks) are pure in tutorial-steps.js; every
// number and word is in tutorial.config.js. Spec: docs/design/specs/2026-10-15-tutorial.md.
//
// CONTRACT
//   mountTour({ shell, micflow, settings, synth?, storage?, speech?, Utterance?, now?, wallNow? })
//     -> { start(), destroy(), state(), debug() }
//     shell     initShell's object: navigate, registerSettingsSection, calm()
//     micflow   createMicFlow's object: request(), stop(), onFrame(fn), state(), setListening(on)
//     settings  createSettings' object: toneVolume, tone, calm are read
//     synth     createSynth() result; made lazily on the first Play the note press if left out
//     storage   where `music-trainer.tour.v1` lives (default localStorage)
//     speech, Utterance   speechSynthesis and SpeechSynthesisUtterance (stubs in the lab)
//     now()     ms clock for meters and turn-taking (default performance.now)
//     wallNow() ms wall clock for the pause date (default Date.now)
//   start(): reads the stored state; offers the invitation (state 'new') 600 ms later on #/sky,
//            or shows the pill (paused). Never touches the mic or the speakers by itself.
//   destroy(): cancels speech, lets the mic go if the tour opened it, removes the layer and
//              every listener. The Settings section stays registered (the shell has no unregister).
//   The tour observes the page only: hashchange / mt:route / pointer / keys on document. It
//   never edits sky.js; places are found by `.sky-place[data-place]`.
//   On <body>: data-tour="<step id>" while the card is up (tutorial.css hides `.sky-first`).

import { h } from './shell.js';
import { noteName, centsBetween } from '../notes.js';
import {
  TOUR, TOUR_WORDS as W, initialTour, toStored, nextTour, stepOf, shouldOffer, escMeans,
  carryOnRoute, countLabel, readingMs, pickVoice, holdMeter, matchTarget, earOpen, dockCard,
} from './tutorial-steps.js';

// The config names the places by their tour words; the sky by its own ids (js/app/skymap.js).
const PLACE_IDS = Object.freeze({ tonight: 'today', ladder: 'practice', open: 'sing', lyre: 'songs', yours: 'progress' });
const SVG = 'http://www.w3.org/2000/svg';
const OFFER_DELAY_MS = 600;   // spec 5: after the sky's first frame
const TICK_MS = 50;           // meters and line timing; holdMeter clamps longer gaps
const LANE_PX = 160, LANE_SEMIS = 6;

function starSvg() {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '-48 -48 96 96');
  s.setAttribute('width', '96'); s.setAttribute('height', '96');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<circle class="tour-halo" r="46"/>'
    + '<path class="tour-core" d="M0 -14 L4 -4 L14 0 L4 4 L0 14 L-4 4 L-14 0 L-4 -4 Z"/>';
  return s;
}

export function mountTour({
  shell, micflow, settings, synth = null,
  storage = globalThis.localStorage,
  speech = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  now = () => performance.now(),
  wallNow = () => Date.now(),
}) {
  let st = initialTour(readStored());
  let shown = false;              // the invitation has been offered on this page
  let destroyed = false;
  let voiceObj = null;
  let speakingUntil = -Infinity, noteUntil = -Infinity, utter = null;
  let micOpen = false, asking = false, lastVoicedAt = 0, stepShownAt = 0, lineShownAt = 0;
  let meter = null, keyHeld = false, keyPos = 0, lastKeyT = null, starY = 0;
  let hummed = [], target = TOUR.target.keyMidi, heardName = null;
  let drag = null, tick = 0, offerTimer = 0, lastDock = null;
  const offs = [];

  // ---- DOM
  const layer = h('div', { class: 'tour', hidden: true });
  const dim = h('div', { class: 'tour-dim', 'aria-hidden': 'true' });
  const star = h('div', { class: 'tour-star', 'data-state': 'asleep', 'aria-hidden': 'true' });
  star.append(starSvg(), h('span', { class: 'tour-star-name' }));
  const lane = h('div', { class: 'tour-lane', hidden: true, 'aria-hidden': 'true' },
    h('div', { class: 'tour-band' }), h('div', { class: 'tour-line' }), h('span', { class: 'tour-line-name' }),
    h('span', { class: 'tour-lane-edge' }));
  const live = h('div', { class: 'tour-live', 'aria-live': 'polite' });
  const card = h('section', { class: 'tour-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tour-title' });
  const pill = h('div', { class: 'tour-pill', hidden: true });
  layer.append(dim, star, lane, card, pill, live);
  document.body.append(layer);

  function readStored() {
    try { return JSON.parse(storage.getItem(TOUR.storageKey) || 'null'); } catch { return null; }
  }
  function save() {
    try { storage.setItem(TOUR.storageKey, JSON.stringify(toStored(st, wallNow()))); } catch { /* private mode: the tour still runs */ }
  }

  // ---- speech (6.3): local English voices only; one utterance per line; never into the mic
  function findVoice() { voiceObj = speech && speech.getVoices ? pickVoice(speech.getVoices()) : null; }
  function hush() {
    if (speech && speech.cancel) speech.cancel();
    if (utter) { utter = null; speakingUntil = now(); }
  }
  function say(text) {
    hush();
    if (!st.voice || !voiceObj || !Utterance || !speech) return;
    const u = new Utterance(text);
    u.voice = voiceObj; u.lang = voiceObj.lang; u.rate = TOUR.voice.rate; u.pitch = TOUR.voice.pitch;
    u.volume = Math.max(0, Math.min(1, settings.get('toneVolume') ?? 0.6));
    const done = () => { if (utter === u) { utter = null; speakingUntil = now(); paint(); } };
    u.onend = done; u.onerror = done;
    utter = u; speakingUntil = Infinity;
    speech.speak(u);
  }
  const speaking = () => speakingUntil === Infinity;

  // ---- events into the rules
  function send(event) {
    const before = st;
    st = nextTour(st, event);
    if (st === before) return false;
    const stepChanged = before.step !== st.step || before.status !== st.status;
    const lineChanged = before.line !== st.line;
    if (st.status !== 'running') leaveRunning();
    save();
    if (stepChanged) enterStep();
    else if (lineChanged) enterLine();
    paint();
    return true;
  }

  function leaveRunning() {
    hush();
    stopMic();
    keyHeld = false;
    clearInterval(tick); tick = 0;
  }

  function stopMic() {
    if (micOpen) { micOpen = false; micflow.setListening(false); micflow.stop(); }
  }

  function enterStep() {
    if (st.status !== 'running') return;
    stepShownAt = now();
    lastVoicedAt = stepShownAt;
    keyPos = 0; lastKeyT = null;
    if (st.step === 'wake') { meter = holdMeter(TOUR.wake); hummed = []; heardName = null; }
    else if (st.step === 'land') { meter = holdMeter(TOUR.land); target = matchTarget(st.keyed ? [] : hummed); }
    else meter = null;
    if (st.step === 'landed') stopMic();   // spec 2b: the mic goes off at the landing
    if (!tick) tick = setInterval(onTick, TICK_MS);
    // "Next on arrival takes you back itself": a step that starts elsewhere brings you there.
    const s = stepOf(st), r = routeNow();
    if (r !== s.at && r !== s.goes) shell.navigate(s.at);
    enterLine(true);
  }

  function enterLine(focus = false) {
    lineShownAt = now();
    const s = stepOf(st);
    const text = s.lines[st.line] || s.lines[0];
    live.textContent = text;
    say(st.line === 0 ? `${s.title}. ${text}` : text);
    render();
    if (focus) { const t = card.querySelector('h2'); if (t) t.focus({ preventScroll: true }); }
  }

  // ---- the tick: line timing, hints, key holds
  function onTick() {
    if (destroyed || st.status !== 'running' || document.hidden) return;
    const t = now();
    const s = stepOf(st);
    const auto = st.step === 'landed' || st.step === 'places' || (s.goes && st.line === 1);
    if (auto) {
      const words = s.lines[st.line] || '';
      const ready = t - lineShownAt >= readingMs(words) && !speaking() && t - speakingUntil >= TOUR.reading.afterSpeechMs;
      // A line never leaves while focus or the pointer is on the card's buttons (6.2).
      const busy = card.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON' || card.matches(':hover');
      if (ready && !busy) send({ type: 'lineDone' });
      return;
    }
    // Mic lost mid-step: the stand-in appears; the waking progress is kept (spec 5).
    if (s.mic && micOpen && micflow.state().phase !== 'on') { micOpen = false; micflow.setListening(false); send({ type: 'micFailed' }); return; }
    if (s.mic && st.keyed && meter) {
      if (!earOpen({ speakingUntil, noteUntil }, t)) { meter.skip(t); paint(); return; }
      const dt = lastKeyT == null ? 0 : Math.min(TOUR.maxFrameMs, t - lastKeyT);
      lastKeyT = t;
      if (st.step === 'land') {
        // Stand-in: the star rises onto the line over keyRiseMs while held and sinks gently after.
        keyPos = Math.max(0, Math.min(1, keyPos + (keyHeld ? 1 : -0.5) * dt / TOUR.keyRiseMs));
        meter.frame(t, keyPos >= 1);
        starY = (1 - keyPos) * -3;
      } else meter.frame(t, keyHeld);
      progress();
    }
    if (s.mic) paintStatus();
  }

  // ---- mic frames (only while the tour opened the mic)
  const offFrame = micflow.onFrame((frame) => {
    if (!micOpen || st.status !== 'running' || !meter) return;
    const t = now();
    if (!earOpen({ speakingUntil, noteUntil }, t)) { meter.skip(t); return; }
    const voiced = !!(frame && frame.voiced && Number.isFinite(frame.midi));
    if (voiced) lastVoicedAt = t;
    if (st.step === 'wake') {
      if (voiced) { hummed.push(frame.midi); heardName = noteName(frame.midi); }
      meter.frame(t, voiced);
    } else if (st.step === 'land') {
      const cents = voiced ? centsBetween(frame.midi, target) : null;
      if (voiced) starY = Math.max(-LANE_SEMIS, Math.min(LANE_SEMIS, cents / 100));
      meter.frame(t, voiced && Math.abs(cents) <= TOUR.bandCents);
    }
    progress();
  });
  offs.push(offFrame);

  function progress() {
    if (!meter) return;
    if (meter.done && st.step === 'wake') { send({ type: 'woken' }); return; }
    if (meter.done && st.step === 'land') { send({ type: 'landed' }); return; }
    paint();
  }

  async function turnOnMic() {
    hush();
    asking = true;
    let ok = false;
    try { ok = await micflow.request(); } catch { ok = false; }
    asking = false;
    if (destroyed || st.status !== 'running' || !stepOf(st).mic) { if (ok) micflow.stop(); return; }
    if (ok) { micOpen = true; micflow.setListening(true); lastVoicedAt = now(); paint(); }
    else send({ type: 'micFailed' });
  }

  function playNote() {
    try {
      if (!synth) return;
      hush();
      const dur = TOUR.noteMs / 1000;
      synth.play({ midi: target, dur, timbre: settings.get('tone') === 'sine' ? 'sine' : 'voice', gain: 0.5 * (settings.get('toneVolume') ?? 0.6) });
      noteUntil = now() + TOUR.noteMs;
    } catch (err) { console.warn('tour: the note could not play', err); }
  }

  // ---- input observed on the page (no sky.js edit)
  function onKey(e) {
    if (st.status !== 'running' && !(st.status === 'new' && shown)) return;
    if (document.querySelector('dialog[open]')) return;  // a sheet (Settings, the mic sheet) has the keys
    const onButton = e.target && e.target.tagName === 'BUTTON';
    if (e.key === 'Escape' && e.type === 'keydown') {
      if (st.status === 'new') { decline(); return; }
      if (escMeans(st) === 'skip') { send({ type: 'skip' }); }
      return;   // 'back': the shell's own Esc goes Back; the route event moves the tour on
    }
    if (e.key === ' ' && !onButton && !e.repeat) {
      if (e.type === 'keydown' && st.status === 'new') { e.preventDefault(); begin(); return; }
      if (e.type === 'keydown' && st.step === 'end') { e.preventDefault(); startTonight(); return; }
      if (stepOf(st).mic) {
        e.preventDefault();
        if (!st.keyed && e.type === 'keydown') send({ type: 'useKey' });
        keyHeld = e.type === 'keydown';
      }
      return;
    }
    if (e.type === 'keydown' && st.step === 'look' && e.key.startsWith('Arrow')) send({ type: 'arrow' });
  }
  function onPointerDown(e) {
    if (st.status === 'running' && st.step === 'look' && !layer.contains(e.target)) drag = { x: e.clientX, y: e.clientY };
  }
  function onPointerMove(e) {
    if (!drag) return;
    const px = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (px >= TOUR.lookDragPx) { drag = null; send({ type: 'drag', px }); }
  }
  const onPointerUp = () => { drag = null; };
  function onRoute() {
    if (st.status === 'running') send({ type: 'route', hash: location.hash, t: wallNow() });
    paint();
  }
  function onSheet(e) {
    // Opening Settings mid-tour pauses it; the mic's own sheet (we asked for it) does not.
    if (e.detail && e.detail.open && !asking && st.status === 'running') send({ type: 'pause', t: wallNow() });
  }
  function onVisibility() {
    if (document.hidden) { hush(); keyHeld = false; layer.dataset.hidden = 'on'; return; }
    delete layer.dataset.hidden;
    if (st.status === 'running') { micOpen = micOpen && micflow.state().phase === 'on'; enterLine(); }
  }
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); offs.push(() => target.removeEventListener(type, fn, opts)); };
  listen(document, 'keydown', onKey);
  listen(document, 'keyup', onKey);
  listen(document, 'pointerdown', onPointerDown, true);
  listen(document, 'pointermove', onPointerMove, true);
  listen(document, 'pointerup', onPointerUp, true);
  listen(window, 'hashchange', onRoute);
  listen(document, 'mt:route', () => paint());
  listen(document, 'mt:sheet', onSheet);
  listen(document, 'visibilitychange', onVisibility);
  listen(window, 'resize', () => paint());
  if (speech && speech.addEventListener) listen(speech, 'voiceschanged', () => { findVoice(); render(); });
  findVoice();

  // ---- actions
  const routeNow = () => { const r = (location.hash || '').split('?')[0]; return r === '' || r === '#' || r === '#/' ? '#/sky' : r; };
  const links = () => window.innerWidth < TOUR.dock.narrowBelow;
  function begin() {
    // This press is the user action Chrome needs before speech; the first speak() is inside it.
    send({ type: 'start', links: links() });
  }
  function decline() { send({ type: 'decline' }); }
  function startTonight() { send({ type: 'next' }); shell.navigate('#/today'); }
  function replay() {
    st = nextTour(st, { type: 'replay', links: links() });
    save();
    enterStep(); paint();
  }

  // ---- drawing
  function button(label, onClick, { primary = false, hold = false } = {}) {
    const b = h('button', { class: primary ? 'btn btn-primary' : 'btn btn-quiet', type: 'button' }, label);
    if (hold) {
      const down = (e) => { e.preventDefault(); if (!st.keyed) send({ type: 'useKey' }); keyHeld = true; };
      const up = () => { keyHeld = false; };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up); b.addEventListener('pointercancel', up);
    } else b.addEventListener('click', onClick);
    return b;
  }

  function voiceToggle() {
    if (!voiceObj) return null;   // no local English voice: the toggle is not shown (5)
    const b = h('button', { class: 'btn btn-quiet tour-voice', type: 'button', 'aria-pressed': String(st.voice) },
      st.voice ? 'Read it aloud: on' : 'Read it aloud: off');
    b.addEventListener('click', () => { send({ type: 'voice', on: !st.voice }); if (!st.voice) hush(); render(); });
    return b;
  }

  function statusLine() {
    const s = stepOf(st);
    if (!s.mic || st.status !== 'running') return '';
    const t = now();
    if (asking) return '';
    if (speaking() || !earOpen({ speakingUntil, noteUntil }, t)) return W.speaking;
    if (st.keyed) return micOpen ? '' : (st.step === 'wake' && meter && meter.progress === 0 ? W.noMic : '');
    if (!micOpen) return '';
    if (t - lastVoicedAt >= TOUR.hintAfterMs) return W.hint;
    return W.listening;
  }
  function paintStatus() {
    const el = card.querySelector('.tour-status');
    if (el) el.textContent = statusLine();
  }

  function render() {
    card.replaceChildren();
    if (st.status === 'new' && shown) {
      const s = stepOf({ step: 'invite' });
      card.append(
        h('div', { class: 'tour-top' }, voiceToggle()),
        h('h2', { id: 'tour-title', tabindex: '-1' }, s.title),
        h('p', { class: 'tour-line' }, s.lines[0]),
        h('div', { class: 'tour-buttons' },
          button(s.buttons[0], begin, { primary: true }), button(s.buttons[1], decline)));
      return;
    }
    if (st.status !== 'running') return;
    const s = stepOf(st);
    const dots = h('span', { class: 'tour-dots', 'aria-hidden': 'true' });
    for (let i = 1; i <= TOUR.counted; i++) dots.append(h('span', { class: i <= s.n ? 'on' : '' }));
    const kids = [h('div', { class: 'tour-top' }, dots, h('span', { class: 'tour-count' }, countLabel(st)), voiceToggle()),
      h('h2', { id: 'tour-title', tabindex: '-1' }, s.title),
      h('p', { class: 'tour-line' }, s.lines[st.line] || s.lines[0])];
    if (s.small) kids.push(h('p', { class: 'tour-small' }, s.small));
    if (s.mic) kids.push(h('p', { class: 'tour-status', role: 'status' }, statusLine()));
    const row = h('div', { class: 'tour-buttons' });
    const silentLong = now() - lastVoicedAt >= TOUR.keyPrimaryAfterMs;
    if (s.mic) {
      if (st.keyed) row.append(button(s.keyButton, null, { primary: true, hold: true }));
      else if (!micOpen) row.append(button(s.buttons[0] === 'Play the note' ? 'Turn on my mic' : s.buttons[0], turnOnMic, { primary: true }));
      if (st.step === 'land') row.append(button('Play the note', playNote, { primary: micOpen && !st.keyed }));
      if (!st.keyed) row.append(button(W.useKey, () => send({ type: 'useKey' }), { primary: silentLong && micOpen }));
    } else if (st.step === 'end') {
      row.append(button(s.buttons[0], startTonight, { primary: true }), button(s.buttons[1], () => send({ type: 'close' })));
    } else row.append(button(W.next, () => send({ type: 'next' }), { primary: true }));
    if (st.step !== 'end') row.append(button(W.skip, () => send({ type: 'skip' })));
    kids.push(row);
    card.append(...kids);
  }

  function targetEl() {
    const s = stepOf(st);
    if (st.status !== 'running') return null;
    if (st.step === 'landed') return document.getElementById('mic-chip');
    if (st.step === 'places') {
      const id = PLACE_IDS[s.places[st.line]];
      return id ? document.querySelector(`.sky-place[data-place="${id}"]`) : null;
    }
    if (s.goes) {
      if (st.line === 0) return document.querySelector(`.sky-place[data-place="${st.step === 'ladder' ? 'practice' : 'songs'}"]`);
      return document.querySelector('main#view .card, main#view .sn-song');
    }
    if (st.step === 'end') return document.querySelector('.sky-place[data-place="today"]');
    return null;
  }

  // Cheap repaint: positions and the star's look; render() rebuilds the card's contents.
  function paint() {
    if (destroyed) return;
    const up = (st.status === 'new' && shown) || st.status === 'running';
    layer.hidden = !(up || st.status === 'paused');
    card.hidden = !up;
    if (up) document.body.dataset.tour = st.status === 'new' ? 'invite' : st.step;
    else delete document.body.dataset.tour;
    layer.dataset.calm = shell.calm && shell.calm() ? 'on' : 'off';

    // The pill (4.3)
    pill.hidden = st.status !== 'paused';
    if (!pill.hidden && !pill.childElementCount) {
      pill.append(h('span', null, `✧ ${W.paused(stepOf(st).n || 1, TOUR.counted)}`),
        button(W.carryOn, () => { const r = carryOnRoute(st); send({ type: 'resume' }); if (routeNow() !== r) shell.navigate(r); }, { primary: true }),
        button(W.endTour, () => send({ type: 'end' })));
    } else if (pill.hidden) pill.replaceChildren();
    if (!up) { dim.hidden = true; star.hidden = true; lane.hidden = true; return; }

    const view = { w: window.innerWidth, h: window.innerHeight };
    const tEl = st.status === 'running' ? targetEl() : null;
    const tr = tEl && tEl.getBoundingClientRect();
    const rect = tr && tr.width > 0 && tr.height > 0 ? { x: tr.left, y: tr.top, w: tr.width, h: tr.height } : null;
    const size = { w: Math.min(TOUR.dock.maxW, card.offsetWidth || TOUR.dock.maxW), h: card.offsetHeight || 200 };
    const reading = routeNow() !== '#/sky';
    const at = dockCard(rect, size, view, { reading });
    card.style.left = `${at.x}px`; card.style.top = `${at.y}px`;
    card.style.width = view.w < TOUR.dock.narrowBelow ? `${at.w}px` : '';
    card.dataset.dock = at.at;
    lastDock = { card: at, target: rect };

    // Spotlight: the rest dims through a soft radial mask centred on the target.
    dim.hidden = !rect;
    if (rect) {
      dim.style.setProperty('--tx', `${rect.x + rect.w / 2}px`);
      dim.style.setProperty('--ty', `${rect.y + rect.h / 2}px`);
      dim.style.setProperty('--tr', `${Math.hypot(rect.w, rect.h) / 2 + 48}px`);
    }

    // The guide star: home above Tonight on steps 1 and 2, then beside what is explained.
    const s = stepOf(st);
    star.hidden = st.status !== 'running' || links() && !s.mic;
    if (!star.hidden) {
      const today = document.querySelector('.sky-place[data-place="today"]');
      const tb = today && today.getBoundingClientRect();
      let x = view.w / 2, y = tb && tb.height ? tb.top - 120 : view.h * 0.4;
      if (rect && !s.mic) { x = rect.x - 24 - 48; y = rect.y + rect.h / 2; }
      star.style.transform = `translate(${Math.round(x - 48)}px, ${Math.round(y - 48 + (st.step === 'land' ? starY * (LANE_PX / 2 / LANE_SEMIS) * -1 : 0))}px)`;
      const p = meter ? meter.progress : 0;
      star.dataset.state = st.step === 'wake' ? (p > 0 ? 'waking' : 'asleep') : 'awake';
      star.style.setProperty('--wake', String(st.step === 'wake' ? p : 1));
      star.querySelector('.tour-star-name').textContent = st.step === 'land' && heardName ? W.humming(heardName) : '';
      lane.hidden = st.step !== 'land';
      if (!lane.hidden) {
        lane.style.transform = `translate(${Math.round(x + 40)}px, ${Math.round(y - LANE_PX / 2)}px)`;
        lane.querySelector('.tour-line-name').textContent = noteName(target) || '';
        const inBand = Math.abs(starY * 100) <= TOUR.bandCents;
        lane.dataset.in = inBand ? 'on' : 'off';
        lane.querySelector('.tour-lane-edge').textContent = Math.abs(starY) >= LANE_SEMIS ? (starY < 0 ? W.higher : W.lower) : '';
        lane.style.setProperty('--hold', String(meter ? meter.progress : 0));
      }
    } else lane.hidden = true;
  }

  // ---- Settings › Tour (9)
  shell.registerSettingsSection('tour', W.settingsTitle, (el) => {
    findVoice();
    const again = h('button', { class: 'btn btn-secondary', type: 'button' }, W.again);
    again.addEventListener('click', () => {
      const dlg = el.closest('dialog');
      if (dlg && dlg.open) dlg.close('close');
      replay();
    });
    let row;
    if (voiceObj) {
      const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': W.readAloud, 'aria-checked': String(st.voice) },
        h('span', { class: 'switch-thumb' }));
      sw.addEventListener('click', () => { send({ type: 'voice', on: !st.voice }); sw.setAttribute('aria-checked', String(st.voice)); });
      row = h('div', { class: 'field field-row' }, h('span', { class: 'field-label' }, W.readAloud), h('div', { class: 'switch-wrap' }, sw));
    } else row = h('p', { class: 'reason' }, W.noVoice);
    el.append(again, row);
  });

  return {
    start() {
      if (destroyed) return;
      send({ type: 'visit', t: wallNow(), tzOffsetMin: new Date(wallNow()).getTimezoneOffset() });
      if (shouldOffer(st)) {
        offerTimer = setTimeout(() => {
          if (destroyed || !shouldOffer(st) || routeNow() !== '#/sky') return;
          shown = true; render(); paint();
          const t = card.querySelector('h2'); if (t) t.focus({ preventScroll: true });
        }, OFFER_DELAY_MS);
      }
      paint();
    },
    destroy() {
      if (destroyed) return;
      leaveRunning();
      destroyed = true;
      clearTimeout(offerTimer);
      for (const off of offs) off();
      layer.remove();
      delete document.body.dataset.tour;
    },
    state: () => ({ ...st }),
    debug: () => ({ ...st, shown, micOpen, asking, target, progress: meter ? meter.progress : null,
      speaking: speaking(), earOpen: earOpen({ speakingUntil, noteUntil }, now()), dock: lastDock, voice: voiceObj && voiceObj.name }),
  };
}
