// longnote.js — Long note, #/practice/long-note: hold one comfortable note for as long and
// as steadily as is easy, see how long it lasted and how steady it was, rest, and over days
// see it grow (owner approved 2026-10-13). The measuring, the words, the rest rule and the
// saved bests are js/app/longnote.js; this file is the screen. Teacher advice, not study
// evidence: nothing here is a "fail", nothing celebrates loudly, and the rest is not optional.
//
// The microphone is on only while a note is being listened for (owner rule 2026-10-12): a
// press on Start (or Again, or Resume) opens it, and it is released when the note ends, when
// nothing is heard for config.longNote.giveUpSec, after config.longNote.listenSec of listening
// whatever is heard (the hard limit: noise or a note that never settles ends nothing else), on
// Stop, Esc, any sheet, a hidden page, pagehide and leaving. The rest is taken with the
// microphone off. "Hear the note" plays only from its own press and never while the
// microphone is open, so no headphones are needed.
//
// CONTRACT — mountLongNote(view, { shell, micflow, settings, storage?, sessions?, config?,
//                                  micOptions?, synth?, range?, now? }) -> screen
//   shell needs: calm(), setBusy()
//   storage     where the bests are kept (default window.localStorage; js/app/longnote.js LONGNOTE_KEY)
//   sessions    js/app/sessions.js createSessions(): each set's holds are filed as one take
//               (sessions.take('longnote'): one note per hold, target = the hold's own
//               centre, facts { bestSec, holds, steady }). Without it nothing is filed.
//   micOptions  passed to micflow.request(): { stream } runs the screen with no microphone
//   synth       a js/synth.js synth for "Hear the note" (the lab passes a silent one); made
//               on the first press of that button and closed again if not given
//   range       { home? } from js/app/range.js exerciseRange(saved): the note offered
//   now         () -> milliseconds, for the rest count (default performance.now)
//   screen.start() -> Promise<boolean>   Start / Again: refused while a rest is running
//   screen.stop()      ends the listening: a note long enough to count is kept
//   screen.hear()      plays the offered note (not while the microphone is open)
//   screen.pause(), screen.resume() -> Promise
//   screen.state() -> { phase, paused, starting, holds, sets, restLeftSec, canStart, note,
//                       meter: createHoldMeter().state(), shownSec, result, record }
//       phase 'ready' | 'sing' | 'rest' | 'done' (js/app/longnote.js createSitting)
//       result (the last hold) = { sec, midi, note, driftCents, wobbleCents, gaps, gapMs,
//           words: { seconds, steady, breath, tip, kind, level }, tier: 'best' | 'first' |
//           'day' | 'note', ended: 'silence' | 'cap' | 'time' | 'stop' | 'pause', holds, setDone,
//           today: { day, sec, holds }, saved }
//   screen.view   the pitch view (js/app/hud.js)   screen.destroy()
//   paused (Esc, a sheet, the page hidden or left, with no note long enough to keep): the
//       microphone is released and the drawing loop rests; only a press on Resume asks again.
//       A note already config.longNote.minHoldSec long is kept instead: the pause ends it.
//   Events: 'mt:exercise' on document, detail { exercise: 'longnote', event, ...state() }.
//       event: start | sing | holding | held | nothing | rested | done (a set ended) | paused
//
// Not built here: a first-time intro card, a picture of the days on Progress.

import { createSynth } from '../../synth.js';
import { CONFIG } from '../config.js';
import { createPitchView } from '../hud.js';
import { createRimRing, drawHoldRing } from '../holdring.js';
import {
  bestWords, createHoldMeter, createSitting, dayLabelOf, holdWords, measureHold, noteFor, readRecord, recentDays, saveHold, secondsWords, WORDS,
} from '../longnote.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { dayKey } from '../sessions.js';
import { h, icon, sheetOpen } from '../shell.js';
import { displayNote } from '../stage.js';
import { spaceActs } from './matchhold.js';

export const LONG_CHIP = Object.freeze({
  ready: { word: 'Ready', icon: 'play' },
  listening: { word: 'Listening', icon: 'mic' },
  holding: { word: 'Holding', icon: 'mic' },
  rest: { word: 'Rest', icon: 'dash' },
  done: { word: 'Set done', icon: 'star' },
  paused: { word: 'Paused', icon: 'pause' },
});
// Never the colour alone: each kind of result has its own drawing beside the words.
const STEADY_ICON = Object.freeze({ steady: 'tick', wobbled: 'wave', short: 'dots', down: 'arrow-down', up: 'arrow-up' });
const TIER_CHIP = Object.freeze({
  best: { word: 'New best', role: 'gold' }, first: { word: 'First long note', role: 'accent' }, day: { word: 'Best today', role: 'gold' },
});

export function mountLongNote(view, {
  shell, micflow, settings, config = CONFIG, micOptions, storage, synth: givenSynth = null, range = {}, sessions = null,
  now = () => performance.now(),
} = {}) {
  const L = config.longNote, H = config.hold;
  const store = storage ?? (() => { try { return window.localStorage; } catch { return null; } })();
  const smallMq = window.matchMedia('(max-width: 639px), (max-height: 519px)');
  const sitting = createSitting(L), meter = createHoldMeter(L);
  const textEvery = createEvery(1000 / L.textHz);
  const note = noteFor(range, L);
  const today = () => (sessions ? sessions.today() : dayKey(new Date(), config));

  let synth = givenSynth, tone = null, dead = false, starting = false, paused = false, wantPause = false, why = '', said = '';
  let frames = [], tOffset = 0, rebase = true, headMidi = null, shownSec = 0, wasHolding = false, wasQuietLong = false;
  let result = null, record = readRecord(store, L), restShown = -1, listenId = null;
  // The set's holds, for the practice record (js/app/sessions.js).
  let rec = null, recT = 0, recHolds = 0, recBest = 0, recSteady = 0;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };

  // ---- the page
  const stepText = h('p', { class: 'ex-step' });
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, 'aria-describedby': 'long-why' });
  const primaryWhy = h('p', { class: 'reason ln-why', id: 'long-why' });
  const hearBtn = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => hear() });
  const bestLine = h('p', { class: 'reason ln-best' });
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const bannerSlot = h('div'), viewHost = h('div'), cardSlot = h('div', { class: 'ln-slot' });
  view.classList.add('exercise', 'long-note');
  view.append(
    h('div', { class: 'title-row ex-head' },
      h('a', { class: 'btn btn-quiet back', href: '#/practice' }, icon('back', 16), ' Back'),
      h('h1', { tabindex: '-1' }, 'Long note'), stepText, bestLine),
    h('p', { class: 'reason' }, WORDS.what, ' ', h('span', { class: 'ln-safety' }, WORDS.safety)),
    bannerSlot, viewHost, underLine, cardSlot,
    h('div', { class: 'action-row' }, hearBtn, h('div', { class: 'action-main' }, primary, primaryWhy)));
  const pv = createPitchView(viewHost, { config });
  // Signal problems go in the reserved line under the stage, as in Match and hold: a banner
  // opening here would move the stage under the singer's eyes.
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });

  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const phaseChip = h('div', { class: 'chip phase-chip', dataset: { role: 'quiet' }, 'aria-live': 'polite' }, chipIcon, chipWord);
  // The result of the last hold, in its own reserved place under the stage: over the stage
  // it covered the very line it describes (the spec's "never covering the take"), and its
  // place is kept so nothing moves when it comes and goes. It fades (a wide area: never a
  // jump) and is not shown while the next note is being sung.
  const card = h('section', { class: 'ln-card', 'aria-label': 'Your long note', dataset: { shown: 'no' } });
  cardSlot.append(card);
  pv.stage.el.append(h('div', { class: 'stage-chips' }, phaseChip));

  const rims = [...pv.el.querySelectorAll('.note-ring')].map((el) => createRimRing(el));
  const heldLine = h('p', { class: 'hud-held' });
  pv.hud.el.querySelector('.hud-ring').append(heldLine);

  // The ring round the head of the voice line: full at config.longNote.ringSec.
  const ringK = () => Math.min(1, shownSec / L.ringSec);
  pv.stage.addLayer((ctx, G, tokens) => {
    if (dead || paused || sitting.state().phase !== 'sing' || headMidi === null) return;
    const y = G.yOfMidi(headMidi);
    if (!(y >= 0 && y <= ctx.canvas.clientHeight)) return;
    drawHoldRing(ctx, { x: G.nowX, y, radius: H.headRadiusPx, progress: ringK(), track: tokens.target, fill: tokens.good, width: H.headWidthPx, trackOpacity: H.trackOpacity });
  });

  const secs = (n) => (n === 1 ? '1 second' : `${n} seconds`);
  const keycap = (k = 'Space') => h('kbd', { class: 'keycap' }, k);
  const noteStyle = () => settings.get('noteNames');
  const snapshot = () => ({
    ...sitting.state(now()), paused, starting, note, meter: meter.state(), shownSec, result, record,
  });
  const emit = (event) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: 'longnote', event, ...snapshot() } }));

  function paintHold(force = false) {
    const singing = sitting.state().phase === 'sing' && !paused;
    for (const rim of rims) rim.set(singing ? ringK() : 0, { landed: false, star: false });
    if (!force && !textEvery.due(performance.now())) return;
    const text = singing && shownSec > 0 ? `Held ${secondsWords(shownSec)}` : '';
    if (heldLine.textContent !== text) heldLine.textContent = text;
  }

  // The one reserved line under the stage: a signal problem while it lasts, else what to do now.
  let underKey = null;
  function paintUnder(s) {
    const banner = micflow.state().banner;
    const problem = s.phase === 'sing' && !paused && SIGNAL_PROBLEMS.includes(banner) ? banner : null;
    const m = meter.state();
    const text = problem ? MIC_WORDS[problem]
      : paused ? WORDS.paused
        : s.phase === 'sing' ? (m.phase === 'holding' ? WORDS.holding : m.quietSec >= L.waitHintSec ? WORDS.ready : WORDS.waiting)
          : s.phase === 'done' ? WORDS.setDone
            : s.phase === 'rest' ? (said || WORDS.rest)
              : said || WORDS.micWhen;
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

  function paint() {
    const s = sitting.state(now());
    const phase = paused ? 'paused' : s.phase;
    const chip = LONG_CHIP[phase === 'sing' ? (meter.state().phase === 'holding' ? 'holding' : 'listening') : phase];
    chipIcon.replaceChildren(icon(chip.icon, 16));
    chipWord.textContent = chip.word;
    stepText.textContent = phase === 'done' ? 'Set done' : `Hold ${Math.min(L.holdsPerSet, s.holds + (s.phase === 'sing' ? 1 : 0)) || 1} of ${L.holdsPerSet}`;
    const b = bestWords(record, today());
    bestLine.textContent = [b.today, b.ever].filter(Boolean).join(' · ');

    const resting = (s.phase === 'rest' || s.phase === 'done') && s.restLeftSec > 0;
    const label = starting ? 'Starting…' : { ready: 'Start', sing: 'Stop', rest: 'Again', done: 'Again', paused: 'Resume' }[phase];
    const off = starting || resting;
    primary.replaceChildren(label, off ? '' : ' ', off ? '' : keycap());
    primary.disabled = off;
    // While singing the main button is the quiet kind: nothing bright under the eyes.
    primary.className = `btn ${phase === 'sing' ? 'btn-secondary' : 'btn-primary'}`;
    // A control that is off always says why, in words beside it.
    primaryWhy.textContent = starting ? 'Waiting for the microphone.'
      : resting ? (s.phase === 'done' ? `Rest your voice. The next set can start in ${secs(s.restLeftSec)}.` : `Rest first. Again in ${secs(s.restLeftSec)}.`)
        : why;
    restShown = s.restLeftSec;

    const playing = !!tone;
    hearBtn.hidden = phase === 'sing' || phase === 'paused' || starting;
    hearBtn.disabled = playing;
    hearBtn.replaceChildren(icon('speaker', 16), playing ? ' Playing…' : ` Hear a note to start on (${displayNote(note, noteStyle()).text})`);
    paintUnder(s);
    // 'set-done', not 'done': app.css hides an exercise's action row on data-phase="done",
    // and here that row holds Again and its rest count.
    view.dataset.phase = phase === 'done' ? 'set-done' : phase;
    paintHold(true);
  }

  function showCard() {
    const r = result;
    if (!r) return;
    const tier = TIER_CHIP[r.tier] || null;
    const days = recentDays(record, today(), L.recentDays);
    const top = Math.max(1, ...days.map((d) => d.sec || 0));
    const daysEl = h('div', {
      class: 'ln-days', role: 'img',
      'aria-label': `Longest note each day, last ${days.length} days: ${days.map((d) => `${dayLabelOf(d.day)} ${d.sec ? secondsWords(d.sec) : 'none'}`).join(', ')}`,
    }, days.map((d) => {
      const bar = h('i', { class: 'ln-bar', 'data-sung': d.sec ? '' : null });
      bar.style.setProperty('--k', String(d.sec ? Math.max(0.08, d.sec / top) : 0));
      return h('span', { class: 'ln-day', 'data-today': d.day === today() ? '' : null }, bar, h('span', null, dayLabelOf(d.day).split(' ')[0]));
    }));
    card.replaceChildren(
      h('div', { class: 'ln-main' },
        h('p', { class: 'ln-seconds' }, r.words.seconds),
        h('p', { class: 'ln-steady', dataset: { kind: r.words.kind } },
          icon(STEADY_ICON[r.words.kind === 'drifted' ? (r.driftCents < 0 ? 'down' : 'up') : r.words.kind], 16), h('span', null, `${r.words.steady} · ${r.words.breath}`)),
        tier && h('span', { class: 'chip', dataset: { role: tier.role } }, icon('star', 16), tier.word)),
      h('p', { class: 'reason ln-tip' }, r.ended === 'cap' ? WORDS.cap : r.words.tip),
      h('div', { class: 'ln-days-wrap' }, h('p', { class: 'reason' }, `Last ${days.length} days`), daysEl));
    card.dataset.tier = r.tier;
    card.dataset.shown = 'yes';
  }

  const viewPatch = (state) => ({
    state, noteStyle: noteStyle(), calm: shell.calm(),
    meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches,
    // No target: any comfortable note is the right one, so nothing is "off" here.
    target: null, nowFrac: config.stage.nowFracFree, labelClearTopPx: 40,
  });

  // ---- one hold

  // Asks for the microphone. Only ever reached from a press (Start, Again, Resume).
  // -> true | false (not given) | 'paused' (a pause arrived while it was opening: let go again)
  async function open() {
    starting = true; wantPause = false; why = ''; said = '';
    // The reference note never sounds into an open microphone.
    if (tone) { tone.stop(); tone = null; }
    paint();
    await fadeLine();
    if (dead) return false;
    const ok = await micflow.request(micOptions || {});
    starting = false;
    if (dead) return false;
    if (!ok) { why = 'The microphone is not on yet.'; pv.stage.set({ voiceAlpha: 1 }); restStage(); return false; }
    // paused first: the microphone going off must not be read as "lost while singing".
    if (wantPause || document.hidden) { wantPause = false; paused = true; micflow.stop(); pv.stage.set({ voiceAlpha: 1 }); return 'paused'; }
    return true;
  }

  // The last note's line leaves over LINE_FADE_MS before the next one starts, so the old
  // picture is never taken away in one frame (the lab reads 0.03 to 0.07 here on its flash
  // number, limit 0.15; it was not measured without the fade).
  const LINE_FADE_MS = 240;
  function fadeLine() {
    if (!pv.stage.points().length) return Promise.resolve();
    pv.stage.start();
    const t0 = performance.now();
    return new Promise((done) => {
      const step = () => {
        if (dead) { done(); return; }
        const k = Math.min(1, (performance.now() - t0) / LINE_FADE_MS);
        pv.stage.set({ voiceAlpha: 1 - k });
        if (k < 1) requestAnimationFrame(step); else done();
      };
      step();
    });
  }

  function listen() {
    paused = false;
    frames = []; meter.reset(); headMidi = null; shownSec = 0; rebase = true; wasHolding = false; wasQuietLong = false;
    card.dataset.shown = 'no';
    pv.clear();
    pv.set({ ...viewPatch('live'), voiceAlpha: 1 });
    pv.stage.start();
    micflow.setListening(true);
    // The hard limit, on the wall clock as well as in the meter (frame time): if the frames
    // stop coming, the microphone is still let go. Each listening (Start, Again, Resume) has its own.
    clearTimeout(listenId);
    if (Number.isFinite(L.listenSec)) listenId = later(() => { listenId = null; timeUp(); }, L.listenSec * 1000);
    paint();
    emit('sing');
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  async function start() {
    if (starting || paused || !sitting.start(now())) return false;
    // A new set (the first, or the one after the long rest) is a new take in the record.
    if (sitting.state().holds === 0) { endTake(); rec = sessions ? sessions.take('longnote') : null; recT = 0; recHolds = 0; recBest = 0; recSteady = 0; }
    const got = await open();
    if (dead) return false;
    if (got === false) { sitting.cancel(); paint(); return false; }
    emit('start');
    if (got === 'paused') { enterPaused(); return true; }
    listen();
    return true;
  }

  function endTake() {
    if (rec && recHolds > 0) rec.end({ facts: { bestSec: recBest, holds: recHolds, steady: recSteady } });
    rec = null;
  }

  const REST_MS = ((config.aurora && config.aurora.cutFadeMs) || 600) + 150;

  let restId = null;
  function restStage() {
    pv.stage.hold(null);
    pv.hud.update(null, 0);
    for (const rim of rims) rim.set(0, { landed: false, star: false });
    clearTimeout(restId);
    restId = later(() => { if (sitting.state().phase !== 'sing') pv.stage.stop(); }, REST_MS);
  }

  // The note is over (silence, the cap, Stop, or a pause after it was long enough to keep).
  function finishHold(ended) {
    const hold = measureHold(frames, L);
    if (!hold.ok) { nothingHeard(ended === 'time' ? WORDS.time : WORDS.nothing); return; }
    // The sitting moves on first: the microphone going off must not read as "lost while singing".
    const s = sitting.held(now());
    paused = false;
    clearTimeout(listenId);
    micflow.setListening(false);
    micflow.stop();
    const saved = saveHold(store, { sec: hold.sec, at: new Date().toISOString(), day: today() }, L);
    record = saved.record;
    const words = holdWords(hold, L);
    if (rec) {
      for (const f of hold.frames) rec.frame(recHolds, hold.midi, { t: recT + f.t, midi: f.midi, voiced: true });
      rec.landed(recHolds);
      recT += hold.sec + 1;
      recHolds++;
      recBest = Math.max(recBest, hold.sec);
      if (words.kind === 'steady') recSteady++;
    }
    const { frames: _own, ok: _ok, ...facts } = hold;
    result = {
      ...facts, words, ended, holds: s.holds, setDone: s.phase === 'done', today: saved.today, saved: saved.saved,
      // Quiet rewards only: a chip and a gold edge. "Best today" needs an earlier note today to beat.
      tier: saved.newBest ? 'best' : saved.firstTime ? 'first' : saved.dayBest && saved.today.holds > 1 ? 'day' : 'note',
    };
    said = '';
    // The picture: the line as it was sung, still. The curtain of light eases out first
    // (stopped at once it went in one frame: 0.21 on the lab's flash number), then the
    // drawing loop rests. The microphone is off, so the read-out rests too.
    restStage();
    showCard();
    paint();
    tick();
    emit('held');
    if (result.setDone) { endTake(); emit('done'); }
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  // config.longNote.listenSec of listening: a note long enough to count is kept, else nothing
  // is counted and the words say why the microphone went off.
  function timeUp() {
    if (dead || paused || starting || sitting.state().phase !== 'sing') return;
    if (meter.state().bestSec >= L.minHoldSec) finishHold('time');
    else nothingHeard(WORDS.time);
  }

  // Nothing long enough to count: no result, no rest owed, and never a miss.
  function nothingHeard(text) {
    sitting.cancel();
    paused = false;
    clearTimeout(listenId);
    micflow.setListening(false);
    micflow.stop();
    said = text;
    restStage();
    if (result) card.dataset.shown = 'yes';
    paint();
    emit('nothing');
  }

  // Paused means the microphone is off (owner rule 2026-10-12): Esc, any sheet, the page
  // hidden or left all release it, every track ended, as Match and hold does. A note already
  // long enough to count is kept: the pause simply ends it. Otherwise the screen waits, the
  // drawing loop rests once the curtain of light has eased out, and only Resume opens the
  // microphone again. One sheet needs the microphone: the mic flow's own level check
  // ('checking'), opened with "Test the mic"; it is released when that sheet closes (onSheet).
  function enterPaused() {
    paused = true;
    pv.set({ state: 'paused' });
    paint();
    emit('paused');
    later(() => { if (paused) pv.stage.stop(); }, REST_MS);
  }
  function pause() {
    // Still opening: it is let go the moment it arrives (open()).
    if (starting) { wantPause = true; return; }
    if (paused || sitting.state().phase !== 'sing') return;
    const flow = micflow.state().phase;
    if (flow !== 'checking' && flow !== 'lost' && meter.state().bestSec >= L.minHoldSec) { finishHold('pause'); return; }
    paused = true;
    clearTimeout(listenId);
    micflow.setListening(false);
    // Lost (unplugged) has nothing open and keeps its Reconnect banner.
    if (micflow.mic && flow !== 'lost' && flow !== 'checking') micflow.stop();
    pv.set({ state: flow === 'lost' ? 'lost' : 'paused' });
    paint();
    emit('paused');
    later(() => { if (paused) pv.stage.stop(); }, REST_MS);
  }
  // Only ever reached from a press (the button, Space, the stage's own Resume), so it may
  // open the microphone again.
  async function resume() {
    if (!paused || starting) return;
    const got = await open();
    if (dead) return;
    if (got !== true) { paint(); return; }
    listen();
  }

  const offFrame = micflow.onFrame((frame, level) => {
    if (dead || paused || starting || sitting.state().phase !== 'sing') return;
    // Each time the microphone is opened its clock starts again; each hold starts at 0.
    if (rebase) { tOffset = -frame.t; rebase = false; }
    const f = { ...frame, t: frame.t + tOffset };
    frames.push({ t: f.t, midi: f.midi, voiced: f.voiced });
    const r = pv.push(f, level);
    if (r && r.voiced) headMidi = r.midi;
    const m = meter.push(f);
    // The stretch being sung now; between two stretches, the longest so far.
    shownSec = m.sec > 0 ? m.sec : m.bestSec;
    pv.stage.hold(ringK());            // the curtain of light grows with the ring
    if (m.phase === 'ended') { if (m.why === 'time') timeUp(); else finishHold(m.why); return; }
    if (m.phase !== 'holding' && m.quietSec >= L.giveUpSec) { nothingHeard(WORDS.nothing); return; }
    const holding = m.phase === 'holding', quietLong = m.quietSec >= L.waitHintSec;
    if (holding !== wasHolding || quietLong !== wasQuietLong) {
      wasHolding = holding; wasQuietLong = quietLong;
      paint();
      if (holding) emit('holding');
    } else paintHold();
  });
  const offState = micflow.subscribe((st) => {
    if (dead) return;
    const singing = sitting.state().phase === 'sing' && !paused && !starting;
    // Unplugged, or released by the mic flow itself (a hidden page): the note ends or waits.
    if (singing && (st.phase === 'lost' || st.phase === 'off')) pause();
    else paintUnder(sitting.state(now()));
    if (paused) paint();
  });

  function stop() {
    if (paused || starting || sitting.state().phase !== 'sing') return;
    if (meter.state().bestSec >= L.minHoldSec) finishHold('stop');
    else nothingHeard('Stopped. The microphone is off. Press Start when you are ready.');
  }

  async function hear() {
    if (dead || tone || starting || paused || sitting.state().phase === 'sing') return;
    try { synth = synth || createSynth(); } catch { why = 'This browser could not start sound.'; paint(); return; }
    const mine = synth.play({ midi: note, dur: L.toneSec, timbre: settings.get('tone') === 'sine' ? 'sine' : 'voice', gain: 0.5 * settings.get('toneVolume'), tag: 'tone' });
    tone = mine;
    paint();
    mine.ended.then(() => { if (tone === mine) { tone = null; if (!dead) paint(); } });
  }

  // The rest count: the words change once a second, and Again comes back by itself.
  function tick() {
    const s = sitting.state(now());
    if (s.phase !== 'rest' && s.phase !== 'done') return;
    if (s.restLeftSec !== restShown) {
      paint();
      if (s.restLeftSec === 0) emit('rested');
    }
    // Woken just after the number next changes, so Again is back the moment the rest is over.
    if (s.restLeftMs > 0) later(tick, (s.restLeftMs % 1000 || 1000) + 15);
  }

  primary.addEventListener('click', () => {
    if (paused) resume();
    else if (sitting.state().phase === 'sing') stop();
    else start();
  });
  pv.stage.onResume(resume);

  // ---- keys, pauses, settings
  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // Space from the heading (where focus lands on arrival) presses the main button.
    if (spaceActs(e, { sheet: sheetOpen() })) {
      const shown = [...view.querySelectorAll('[data-primary]:not([disabled])')].find((b) => !b.closest('[hidden]'));
      // Always: with the button off (the rest), Space must not scroll the page instead.
      e.preventDefault();
      if (shown) shown.click();
      return;
    }
    if (e.key === 'Escape' && !paused) { pause(); if (paused) primary.focus(); }
  };
  const onSheet = (e) => {
    if (e.detail.open) pause();
    // The level check is over: paused means the microphone is off. Not while Resume is
    // opening it (its own sheets close on the way).
    else if (paused && !starting && micflow.mic) micflow.stop();
  };
  // Hidden or left: the microphone goes, and only a press opens it again.
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

  pv.set(viewPatch('idle'));
  paint();

  return {
    start, stop, hear, pause, resume,
    state: snapshot,
    view: pv,
    destroy() {
      dead = true;
      // Left in the middle of a set: the notes already held are still filed.
      endTake();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (tone) tone.stop();
      // `starting`: the microphone is still opening; without this it would arrive after the
      // screen has gone and stay on with nothing using it.
      if (starting || sitting.state().phase === 'sing') micflow.stop();
      shell.setBusy(null);
      // The shell reuses this element for the next screen: leave nothing of ours on it.
      delete view.dataset.phase;
      view.classList.remove('exercise', 'long-note');
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      smallMq.removeEventListener('change', onCalm);
      for (const rim of rims) rim.remove();
      if (synth && !givenSynth) synth.ctx.close().catch(() => {});
      pv.destroy();
    },
  };
}
