// rangefinder.js — Find your range, #/practice/range: slide down to the lowest note that
// still feels easy and hold it, then up to the highest; the result in plain words, saved
// with its date (docs/design/specs/2026-10-12-singing-trainer.md section 7.2 and the shared
// exercise frame of section 7). How a range is measured is js/app/range.js.
//
// The top half is PURE and imports in Node (tools/checks/range.check.mjs).
//
// CONTRACT — pure
//   RANGE_WORDS            every sentence of the screen: steps { low, high }, ready, safety,
//                          hints { nothing, inverted }, need { low, high }, longer { low, high }
//                          (a start was held, not the end: bugs.md 44), pinned(which, name)
//   createRangeRound() -> round
//       round.state() -> { phase, low, high, hint }
//         phase 'ready' | 'low' | 'high' | 'result'; low, high: the pinned note or null;
//         hint: null | 'inverted' (the "highest" note was under the lowest: the step repeats)
//       round.start()          ready -> low
//       round.pin(which, note | null)   only for the step being sung
//       round.next()           low -> high (needs a pinned low); high -> result (needs a
//                              pinned high that is not under the low one, else the high end
//                              is cleared and hint = 'inverted')
//       round.tryAgain()       low | high: that end is cleared, the step stays
//       round.stop()           low | high -> ready, both ends cleared
//       round.again()          result -> ready, both ends cleared
//       A call that does not fit the phase changes nothing. Each returns state().
//   stepHint({ which, sungMs, end, inverted }) -> 'inverted' | 'nothing' | null
//       'nothing': nothing steady found after config.range.nothingAfterMs of singing
//   ladderFacts({ low, high }, { noteStyle?, final? }) -> { bar, lowFlag, highFlag, lowNote, highNote, lines }
//       low, high: range.js endFrom results (or null). bar { low, high } | null covers every
//       note held for coverMs; flags "Lowest A2" / "Highest E4" once pinned; lines are the
//       read-out's "Lowest so far: A2" ("Lowest: A2" with final, once the result is up).
//
// CONTRACT — mountRangeFinder(view, { shell, micflow, settings, config?, micOptions?, storage?,
//                                     embedded?, backHref?, onNext?, rowStart?, rowEnd?, now? }) -> screen
//   shell needs: calm(), setBusy(), openSettings()
//   micOptions  passed to micflow.request(): { stream } runs the screen with no microphone
//   embedded    inside the setup path: an h2 and no Back link; after Save the main button is
//               "Next" and calls onNext(entry). The heading row is kept for focus and for
//               screen readers but not shown (the setup path's lit dot already says it).
//   rowStart, rowEnd   elements put at the start and the end of the screen's ONE action row
//               (the setup path's Back and "Set up later"). They are the caller's: the
//               screen never changes them, and the caller takes them back before destroy().
//   The microphone: asked for only by start(), again() and resume(), each reached only from a
//   press. Released on pause (Esc, any sheet, the page hidden or left), on stop, when the
//   result is shown, and on destroy. Nothing here opens it again by itself.
//   screen.start() -> Promise<boolean>   next(), tryAgain(), stop(), pause(), resume() -> Promise,
//   save() -> boolean, again() -> Promise<boolean>
//   screen.confirmLeave() -> Promise<boolean>   true at once when no take is running; else the
//       screen's own "Leave?" question (for a caller that moves on without the shell's router)
//   screen.state() -> round.state() + { paused, hold: { midi, heldMs, progress }, ladder,
//                    hintKey, sungMs, reason, result | null }
//       reason: why the step's end is not pinned: null | 'no-steady' | 'moved-on'
//       result = { range, words, growth, saved, tier, first, grew: { low, high } }
//         first: nothing was saved before this measurement (the first ever: review 4, 6d)
//         grew: which ends are beyond the last saved range (both false when first)
//   FOR THE DRAWING (review 4, 6b): state().low / .high are the pinned ends (the horizons);
//       state().hold.midi is the note being held now (the line that follows before a pin);
//       the view is `view.dataset.phase` 'done' with the stage fitted to the range.
//   screen.view   the pitch view (js/app/hud.js)   screen.destroy()
//   Events: 'mt:exercise' on document, detail { exercise: 'range', event, ...state }.
//       event: start | step | pinned | paused | stop | result | saved
//   rangeSummaryCard(entry | null, { noteStyle? }) -> element    Today's "Your range" card
//
// Saved: range.js RANGE_KEY, { current, history } (history is for the Progress screen).

import { CONFIG } from '../config.js';
import { createPitchView } from '../hud.js';
import { createRimRing, drawHoldRing, starShape } from '../holdring.js';
import { createEvery, SIGNAL_PROBLEMS, WORDS as MIC_WORDS } from '../micflow.js';
import { createHoldWatch, dayWords, endFrom, measureRange, rangeGrowth, rangeWords, readRange, readRangeRecord, saveRange } from '../range.js';
import { createRewardLayer } from '../rewards.js';
import { confirmSheet, h, icon, sheetOpen } from '../shell.js';
import { displayNote, starField } from '../stage.js';
import { PHASE_CHIP, spaceActs } from './matchhold.js';

// ---------------------------------------------------------------- pure

const PIN_SEC = String(CONFIG.range.pinMs / 1000);

export const RANGE_WORDS = Object.freeze({
  steps: Object.freeze({
    low: 'Slide down to the lowest note that still feels easy, and hold it.',
    high: 'Now slide up to the highest note that still feels easy, and hold it.',
  }),
  ready: 'Two steps: your lowest easy note, then your highest. About one minute.',
  sky: 'This is your sky today',
  safety: 'Stay comfortable. Stop if your throat feels tight or sore.',
  hints: Object.freeze({
    nothing: 'I couldn’t find a steady note. Try a long, relaxed ‘ah’.',
    inverted: 'That was under your lowest note. Start from a comfortable note, slide up, then hold your highest easy one.',
  }),
  need: Object.freeze({
    low: `Hold your lowest easy note for ${PIN_SEC} seconds first.`,
    high: `Hold your highest easy note for ${PIN_SEC} seconds first.`,
  }),
  longer: Object.freeze({
    low: 'Hold your lowest note a little longer.',
    high: 'Hold your highest note a little longer.',
  }),
  pinned: (which, name) => (which === 'low'
    ? `Lowest ${name} is pinned. Go lower if it still feels easy, or go on.`
    : `Highest ${name} is pinned. Go higher if it still feels easy, or go on.`),
});

export function createRangeRound() {
  let phase = 'ready', low = null, high = null, hint = null;
  const state = () => ({ phase, low, high, hint });
  const clear = () => { low = null; high = null; hint = null; };
  return {
    state,
    start() { if (phase === 'ready') { clear(); phase = 'low'; } return state(); },
    pin(which, note) {
      const v = typeof note === 'number' && Number.isFinite(note) ? Math.round(note) : null;
      if (which === phase && phase === 'low') low = v;
      else if (which === phase && phase === 'high') { high = v; if (v !== null) hint = null; }
      return state();
    },
    next() {
      if (phase === 'low' && low !== null) { phase = 'high'; high = null; hint = null; }
      else if (phase === 'high' && high !== null) {
        if (high < low) { high = null; hint = 'inverted'; } else { phase = 'result'; hint = null; }
      }
      return state();
    },
    tryAgain() { if (phase === 'low') low = null; else if (phase === 'high') { high = null; hint = null; } return state(); },
    stop() { if (phase === 'low' || phase === 'high') { phase = 'ready'; clear(); } return state(); },
    again() { if (phase === 'result') { phase = 'ready'; clear(); } return state(); },
  };
}

export function stepHint({ sungMs = 0, end = null, inverted = false } = {}, cfg = CONFIG.range) {
  if (inverted) return 'inverted';
  const found = !!end && (end.ok || !!end.covered);
  return !found && sungMs >= cfg.nothingAfterMs ? 'nothing' : null;
}

export function ladderFacts({ low = null, high = null } = {}, { noteStyle = 'letters', final = false } = {}) {
  const sofar = final ? '' : ' so far';
  const name = (m) => displayNote(m, noteStyle).text;
  const notes = [];
  for (const end of [low, high]) {
    if (!end) continue;
    if (end.covered) notes.push(end.covered.low, end.covered.high);
    if (end.ok) notes.push(end.note);
  }
  const lowNote = low && low.ok ? low.note : null, highNote = high && high.ok ? high.note : null;
  return {
    bar: notes.length ? { low: Math.min(...notes), high: Math.max(...notes) } : null,
    lowFlag: lowNote === null ? '' : `Lowest ${name(lowNote)}`, highFlag: highNote === null ? '' : `Highest ${name(highNote)}`,
    lowNote, highNote,
    lines: [lowNote === null ? null : `Lowest${sofar}: ${name(lowNote)}`, highNote === null ? null : `Highest${sofar}: ${name(highNote)}`].filter(Boolean),
  };
}

// ---------------------------------------------------------------- browser: Today's card

export function rangeSummaryCard(entry, { noteStyle = 'letters' } = {}) {
  if (!entry) {
    return h('section', { class: 'card range-summary' }, h('h2', null, 'Your range'), h('p', null, 'Not measured yet'),
      h('p', null, h('a', { class: 'link', href: '#/practice/range' }, 'Find my range')));
  }
  const w = rangeWords(entry, { noteStyle }), notes = entry.highMidi - entry.lowMidi, day = dayWords(entry.at);
  return h('section', { class: 'card range-summary' }, h('h2', null, 'Your range'),
    rangeBar(entry, w),
    // One note at both ends is said as that: "0 notes" would read as a fault (bugs.md 47).
    h('p', null, `${notes === 0 ? 'One note' : `${notes} ${notes === 1 ? 'note' : 'notes'}`}${day ? ` · measured ${day}` : ''}`),
    h('p', null, h('a', { class: 'link', href: '#/practice/range' }, 'Measure again')));
}

// The whole range with the comfortable part marked inside it. Decoration: the sentences
// beside it say the same in words.
function rangeBar(range, words) {
  const span = Math.max(1, range.highMidi - range.lowMidi);
  const left = ((range.comfortLow - range.lowMidi) / span) * 100, width = Math.max(4, ((range.comfortHigh - range.comfortLow) / span) * 100);
  const w = Math.min(100 - left, width);
  return h('div', { class: 'range-bar', 'aria-hidden': 'true' },
    h('span', null, words.low),
    h('div', { class: 'range-bar-track' }, h('i', { style: `left:${left}%;width:${w}%` }),
      // The comfortable part's ends, named under the bar (review 4, finding 14).
      words.comfortLow ? h('span', { class: 'range-bar-tick', style: `left:${left}%` }, words.comfortLow) : null,
      words.comfortHigh && words.comfortHigh !== words.comfortLow ? h('span', { class: 'range-bar-tick', style: `left:${left + w}%` }, words.comfortHigh) : null),
    h('span', null, words.high));
}

// ---------------------------------------------------------------- browser: the screen

export function mountRangeFinder(view, {
  shell, micflow, settings, config = CONFIG, micOptions, storage, embedded = false, backHref = '#/practice', onNext = null,
  rowStart = [], rowEnd = [],
  now = () => new Date().toISOString(),
  // js/app/sessions.js createSessions(): a saved measurement is noted there as a finished
  // exercise (sessions.result('range', ...)). Without it nothing is recorded.
  sessions = null,
} = {}) {
  const R = config.range, H = config.hold;
  const store = storage !== undefined ? storage : (() => { try { return window.localStorage; } catch { return null; } })();
  const smallMq = window.matchMedia('(max-width: 639px), (max-height: 519px)');
  const round = createRangeRound();
  const watch = createHoldWatch(R);
  const textEvery = createEvery(1000 / R.textHz);
  // Frames older than this fall out of a step (two minutes: the analysis stays a few ms).
  const KEEP_SEC = 120;

  let dead = false, starting = false, paused = false, reopening = false, why = '', underKey = null;
  let frames = { low: [], high: [] }, ends = { low: null, high: null };
  let tOffset = 0, lastT = null, rebase = true, sungMs = 0, hold = { midi: null, heldMs: 0, progress: 0 };
  let hintKey = null, result = null, facts = ladderFacts(ends), wasLong = false;
  // What the picture shows now (review 4, 6b to 6d): the two horizons. Each end has a line
  // (k: its strength), a veil over what lies beyond it and a flag (w: both come with the pin),
  // and the note it sits on. Everything eases in AND out, so each remembers what it last
  // showed while it fades. band: the comfortable range at the result. first: when the first
  // measurement's two stars were lit (ms), else null. ys: where the lines were last drawn.
  const HZ = R.horizon;
  const shown = {
    atMs: 0, band: 0, bandEnds: null, first: null, starX: 0, ys: { low: null, high: null }, ring: { k: 0, midi: null, progress: 0, y: 0 }, extra: null, extraFor: null, pics: [],
    end: { low: { k: 0, w: 0, note: null, text: '', solid: false }, high: { k: 0, w: 0, note: null, text: '', solid: false } },
  };
  const skyStars = starField(HZ.starSeed, HZ.starCount);
  let starPath = null;
  const FADE_MS = 200;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms); timers.add(id); return id; };
  const noteStyle = () => settings.get('noteNames');

  // ---- the page
  const stepText = h('p', { class: 'ex-step' });
  const doLine = h('p', { class: 'range-do', role: 'status' });
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, 'aria-describedby': 'range-why' });
  const primaryWhy = h('p', { class: 'reason', id: 'range-why' });
  const tryBtn = h('button', { class: 'btn btn-secondary', type: 'button', hidden: true, onclick: () => tryAgain() }, icon('replay', 16), ' Try again');
  const stopBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true, onclick: () => stop() }, 'Stop');
  const underLine = h('p', { class: 'reason ex-under', role: 'status' });
  const bannerSlot = h('div'), viewHost = h('div'), cardSlot = h('div', { class: 'done-slot' });
  view.classList.add('exercise', 'rangefinder');
  view.append(
    h('div', { class: `title-row ex-head${embedded ? ' visually-hidden' : ''}` },
      embedded ? null : h('a', { class: 'btn btn-quiet back', href: backHref }, icon('back', 16), ' Back'),
      h(embedded ? 'h2' : 'h1', { tabindex: '-1' }, 'Find your range'), stepText),
    doLine, bannerSlot, viewHost, underLine, cardSlot,
    // Try again comes AFTER the main button: arriving before it, it pushed the button 138 px
    // sideways at the moment the person reached for it (review 4, finding 7).
    h('div', { class: 'action-row' }, ...rowStart, h('div', { class: 'action-main' }, primary, primaryWhy), tryBtn, stopBtn, ...rowEnd));
  const pv = createPitchView(viewHost, { config });
  // Signal problems go in the reserved line under the stage, as in Match and hold: a banner
  // opening above the stage would move the lanes under the singer's eyes.
  const unmountBanners = micflow.mountBanners(bannerSlot, { signal: false });

  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const phaseChip = h('div', { class: 'chip phase-chip', 'aria-live': 'polite' }, chipIcon, chipWord);
  const card = h('section', { class: 'done-card range-card', hidden: true, 'aria-label': 'Your range' });
  pv.stage.el.append(h('div', { class: 'stage-chips' }, phaseChip));
  // The card is always UNDER the stage: over it, it covered the "Lowest" flag, the very
  // thing it reports (review 4, finding 4).
  card.classList.add('is-below');
  view.classList.add('done-below');
  cardSlot.append(card);

  const rims = [...pv.el.querySelectorAll('.note-ring')].map((el) => createRimRing(el));
  const linesEl = h('p', { class: 'hud-held range-lines' });
  pv.hud.el.querySelector('.hud-ring').append(linesEl);

  // The two horizons, and the ring round the head. Drawn before the reward layer is added,
  // so a burst is never under the veil.
  const approach = (v, goal, dt, ms) => (v < goal ? Math.min(goal, v + dt / ms) : Math.max(goal, v - dt / ms));
  const easeBack = (k) => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;      // a small overshoot, then rest
  pv.stage.addLayer((ctx, L, tokens) => {
    if (dead) return;
    // The first frame after the loop was stopped gets no time: a stale clock used to take
    // half of a fade in one frame (the lab read 0.10 when "Measure again" cleared the picture).
    const nowMs = performance.now(), since = nowMs - shown.atMs, dt = since > 250 ? 0 : Math.max(0, since);
    shown.atMs = nowMs;
    if (shown.extraFor !== tokens) {
      // The colours the stage does not carry, and the accent as numbers (a gradient to
      // "transparent" would pass through grey).
      const cs = getComputedStyle(pv.stage.el), g = (n) => cs.getPropertyValue(n).trim();
      ctx.fillStyle = tokens.accent;
      const hex = /^#([0-9a-f]{6})$/i.exec(ctx.fillStyle), n = hex ? parseInt(hex[1], 16) : 0x4aa8ff;
      shown.extra = { bg: g('--bg'), gold: g('--gold'), goldFill: g('--gold-fill'), muted: g('--muted'), rgb: `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}` };
      shown.extraFor = tokens;
    }
    const X = shown.extra, calm = shell.calm();
    const inMs = calm ? HZ.calmMs : HZ.inMs, outMs = calm ? HZ.calmMs : HZ.outMs;
    const height = ctx.canvas.clientHeight, x0 = L.plotX, x1 = L.plotX + L.plotW;
    const s = round.state(), singing = (s.phase === 'low' || s.phase === 'high') && !paused;
    for (const which of ['low', 'high']) {
      const e = shown.end[which], pin = which === 'low' ? facts.lowNote : facts.highNote;
      // Before the pin: a dashed line under (over) the note being held, at part strength.
      const forming = pin === null && singing && s.phase === which && hold.midi !== null && hold.progress >= HZ.formingFrom;
      const goal = pin !== null ? pin : forming ? Math.round(hold.midi) : null;
      // A line never slides to another note: the old place fades out and the new one in (below).
      if (goal !== null) { e.note = goal; e.solid = pin !== null; }
      if (pin !== null) e.text = which === 'low' ? facts.lowFlag : facts.highFlag;
      const kGoal = pin !== null ? 1 : forming ? HZ.formingK : 0;
      e.k = approach(e.k, kGoal, dt, e.k < kGoal ? inMs : outMs);
      e.w = approach(e.w, pin !== null ? 1 : 0, dt, pin !== null ? inMs : outMs);
      if (e.k === 0 && goal === null) e.note = null;
    }
    const lo = shown.end.low, hi = shown.end.high;
    const res = s.phase === 'result' && result ? result : null;
    if (res) shown.bandEnds = { low: res.range.comfortLow, high: res.range.comfortHigh, lowText: res.words.comfortLow, highText: res.words.comfortHigh };
    shown.band = approach(shown.band, res ? 1 : 0, dt, calm ? HZ.calmMs : HZ.bandMs);
    shown.starX = x0 + L.plotW * HZ.firstStarXFrac;
    // Nothing here ever moves in one step, and no bright line travels: when the view changes
    // at once (the result's fit, "Measure again", calm motion) or a line goes to another
    // note, the picture as it was fades out where it was while the new one fades in. Each
    // picture is a view (top lane, lane height) with the ends and the band as they were.
    const cur = { top: L.topMidi, lane: L.laneH, low: { ...lo }, high: { ...hi }, band: shown.band, bandEnds: shown.bandEnds };
    const pics = shown.pics, last = pics[pics.length - 1];
    // A line may drift with the view this far in one frame; faster than that it would cross
    // a hand's width of stage in a blink, so it fades instead.
    const drift = dt > 0 ? Math.max(0.5, (HZ.driftPxPerSec * dt) / 1000) : 2;
    const moved = !!last && ['low', 'high'].some((which) => {
      const e = cur[which], o = last[which];
      if (!(e.k > 0) || e.note === null || !(o.k > 0) || o.note === null) return false;
      return o.note !== e.note || Math.abs((cur.top - e.note) * cur.lane - (last.top - e.note) * last.lane) > drift;
    });
    if (!last) pics.push({ ...cur, a: 1 });
    // A view still on its way (several steps in a row): the new picture waits, unseen, until
    // the view rests; it is not started again at every step.
    else if (moved && last.a < 0.25) { Object.assign(last, cur); last.a = 0; }
    else if (moved) { pics.push({ ...cur, a: 0 }); if (pics.length > 3) pics.shift(); } else Object.assign(last, cur);
    pics.forEach((pic, i) => { pic.a = approach(pic.a, i === pics.length - 1 ? 1 : 0, dt, HZ.jumpMs); });
    for (let i = pics.length - 2; i >= 0; i--) if (!(pics[i].a > 0)) pics.splice(i, 1);

    // One whole picture of the horizons for a view (top lane, lane height), at strength A.
    // P: the two ends and the band as they are now, or as they were when the view jumped.
    const picture = (v, A, P, live) => {
      const lo = P.low, hi = P.high;
      const yOf = (m) => (v.top - m) * v.lane;
      const ys = { low: lo.note === null ? null : yOf(lo.note - 0.5), high: hi.note === null ? null : yOf(hi.note + 0.5) };
      // 1. Beyond each horizon the stage is veiled with the page's own colour.
      ctx.fillStyle = X.bg;
      if (lo.w > 0 && ys.low !== null && ys.low < height) { ctx.globalAlpha = A * HZ.washK * lo.w; ctx.fillRect(x0, ys.low, L.plotW, height - ys.low); }
      if (hi.w > 0 && ys.high !== null && ys.high > 0) { ctx.globalAlpha = A * HZ.washK * hi.w; ctx.fillRect(x0, 0, L.plotW, ys.high); }
      // 2. A glow rises from each horizon into the sky.
      ctx.globalAlpha = 1;
      for (const [e, y, dir] of [[lo, ys.low, -1], [hi, ys.high, 1]]) {
        if (!(e.w > 0) || y === null) continue;
        const glow = ctx.createLinearGradient(0, y, 0, y + dir * HZ.risePx);
        glow.addColorStop(0, `rgba(${X.rgb}, ${(A * HZ.riseK * e.w).toFixed(3)})`);
        glow.addColorStop(1, `rgba(${X.rgb}, 0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(x0, Math.min(y, y + dir * HZ.risePx), L.plotW, HZ.risePx);
      }
      // 3. Between the two: the singer's own sky, lit with stars once both ends are pinned.
      const sky = Math.min(lo.w, hi.w);
      if (sky > 0 && ys.low !== null && ys.high !== null) {
        const dawn = !(tokens.starOpacity > 0);
        ctx.fillStyle = dawn ? X.muted : tokens.text;
        for (const st of skyStars) {
          const y = st.y * 3 * height;
          if (y < ys.high + 4 || y > ys.low - 4) continue;
          ctx.globalAlpha = A * Math.min(1, st.a * HZ.starK * (dawn ? HZ.dawnStarK : 1)) * sky;
          ctx.beginPath();
          ctx.arc(x0 + st.x * L.plotW, y, st.r * (dawn ? 1.2 : 1), 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      // 4. The result: the comfortable range is a brighter band inside the sky, named at its edges.
      if (P.band > 0 && P.bandEnds) {
        const b = P.bandEnds, top = yOf(b.high + 0.5), bottom = yOf(b.low - 0.5);
        ctx.globalAlpha = A * HZ.bandK * P.band;
        ctx.fillStyle = tokens.accent;
        ctx.fillRect(x0, top, L.plotW, bottom - top);
        ctx.globalAlpha = A * 0.5 * P.band;
        ctx.strokeStyle = tokens.accent;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(top) + 0.5); ctx.lineTo(x1, Math.round(top) + 0.5);
        ctx.moveTo(x0, Math.round(bottom) - 0.5); ctx.lineTo(x1, Math.round(bottom) - 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = A * P.band;
        ctx.fillStyle = tokens.text;
        ctx.font = `600 12px ${tokens.font}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        if (bottom - top >= 40 && b.lowText !== b.highText) {
          ctx.fillText(b.highText, x0 + 10, top + 11);
          ctx.fillText(b.lowText, x0 + 10, bottom - 11);
        } else ctx.fillText(b.lowText === b.highText ? b.lowText : `${b.lowText} to ${b.highText}`, x0 + 10, (top + bottom) / 2);
      }
      // 5. The lines and their flags. "Lowest" points down and sits under its line, "Highest"
      // points up and sits over its line: the two differ by shape, place and word. A line
      // that is out of view leaves its flag waiting at the edge it left by.
      ctx.font = `600 ${HZ.fontPx}px ${tokens.font}`;
      ctx.textBaseline = 'middle';
      for (const which of ['low', 'high']) {
        const e = P[which], y = ys[which], dir = which === 'low' ? 1 : -1;
        if (!(e.k > 0) || y === null) continue;
        const ly = Math.round(y);
        if (ly > -6 && ly < height + 6) {
          ctx.save();
          ctx.globalAlpha = A * e.k;
          ctx.strokeStyle = tokens.accent;
          ctx.lineWidth = HZ.linePx;
          if (!e.solid) ctx.setLineDash([8, 6]);
          ctx.shadowColor = tokens.accent;
          ctx.shadowBlur = HZ.glowPx * e.w;
          ctx.beginPath();
          ctx.moveTo(x0, ly); ctx.lineTo(x1, ly);
          ctx.stroke();
          ctx.restore();
        }
        if (!(e.w > 0) || !e.text) continue;
        // Beyond the line where there is room, else just inside it; never off the stage.
        let ty = y + dir * 16;
        if (ty > height - 12 || ty < 12) ty = y - dir * 16;
        ty = Math.min(height - 12, Math.max(12, ty));
        const tw = ctx.measureText(e.text).width, tx = x1 - 12 - tw, px = tx - 8 - HZ.flagPx, half = HZ.flagPx / 2;
        ctx.globalAlpha = A * e.w;
        ctx.fillStyle = tokens.accent;
        ctx.beginPath();
        ctx.moveTo(px, ty - half * dir); ctx.lineTo(px + HZ.flagPx, ty - half * dir); ctx.lineTo(px + half, ty + half * dir);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = tokens.text;
        ctx.textAlign = 'left';
        ctx.fillText(e.text, tx, ty + 0.5);
      }
      // 6. The first measurement ever: a gold star lights on each horizon, the ground first.
      if (live && shown.first !== null && res) {
        if (!starPath) starPath = new Path2D(starShape('held').d);
        [['low', 0], ['high', HZ.firstStarGapMs]].forEach(([which, wait]) => {
          const t = nowMs - shown.first - (calm ? 0 : wait), y = ys[which];
          if (t <= 0 || y === null) return;
          const k = Math.min(1, t / (calm ? HZ.calmMs : HZ.firstStarInMs)), size = HZ.firstStarPx * (calm ? 1 : easeBack(k));
          ctx.save();
          ctx.translate(shown.starX, Math.round(y));
          ctx.scale(size, size);
          ctx.globalAlpha = A * Math.min(1, k * 1.5);
          ctx.shadowColor = X.goldFill;
          ctx.shadowBlur = 14 * k;
          ctx.fillStyle = X.goldFill;
          ctx.fill(starPath);
          ctx.shadowBlur = 0;
          ctx.strokeStyle = X.gold;
          ctx.lineWidth = 1.2 / size;
          ctx.lineJoin = 'round';
          ctx.stroke(starPath);
          ctx.restore();
        });
      }
      return ys;
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, L.plotW, height);
    ctx.clip();
    let ys = shown.ys;
    pics.forEach((pic, i) => { const y = picture(pic, pic.a, pic, i === pics.length - 1); if (i === pics.length - 1) ys = y; });
    shown.ys = ys;
    ctx.restore();
    // For labs: where the pinned lines are drawn (CSS px from the stage's top), once fully in.
    const mark = (key, e, y) => { const v = e.w >= 1 && pics[pics.length - 1].a >= 1 && y !== null && y >= 0 && y <= height ? String(Math.round(y)) : ''; if ((pv.stage.el.dataset[key] || '') !== v) { if (v) pv.stage.el.dataset[key] = v; else delete pv.stage.el.dataset[key]; } };
    mark('groundY', lo, ys.low);
    mark('skyY', hi, ys.high);
    // The ring round the head. On the held note itself, not on the newest reading: a squeak
    // or an octave slip moves the head for a few frames, and the ring must not jump after it.
    // It fades out where it was (it used to vanish in one frame when the result came up).
    const ring = shown.ring, ringOn = singing && hold.midi !== null && hold.progress > 0;
    // ...where it was on the STAGE: the view may change under it (the result's fit).
    if (ringOn) { ring.midi = hold.midi; ring.progress = hold.progress; ring.y = L.yOfMidi(hold.midi); }
    ring.k = approach(ring.k, ringOn ? 1 : 0, dt, ringOn ? HZ.ringInMs : HZ.ringOutMs);
    if (!(ring.k > 0) || ring.midi === null) return;
    const y = ring.y;
    if (y < 0 || y > height) return;
    if (ring.k >= 1) {
      drawHoldRing(ctx, {
        x: L.nowX, y, radius: H.headRadiusPx, progress: ring.progress, track: tokens.target, fill: tokens.good,
        width: H.headWidthPx, trackOpacity: H.trackOpacity, thick: 1,
      });
      return;
    }
    // Fading: the same two arcs at part strength (drawHoldRing draws its fill at full).
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = H.headWidthPx;
    ctx.strokeStyle = tokens.target;
    ctx.globalAlpha = H.trackOpacity * ring.k;
    ctx.beginPath();
    ctx.arc(L.nowX, y, H.headRadiusPx, 0, 2 * Math.PI);
    ctx.stroke();
    if (ring.progress > 0.001) {
      ctx.strokeStyle = tokens.good;
      ctx.globalAlpha = ring.k;
      ctx.beginPath();
      ctx.arc(L.nowX, y, H.headRadiusPx, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, ring.progress));
      ctx.stroke();
    }
    ctx.restore();
  });

  const layer = createRewardLayer(pv.stage, { config, calm: () => shell.calm() });

  const keycap = (k = 'Space') => h('kbd', { class: 'keycap' }, k);
  const reasonNow = () => { const p = round.state().phase, e = ends[p]; return e && !e.ok ? e.reason : null; };
  const snapshot = () => ({ ...round.state(), paused, hold: { ...hold }, ladder: facts, hintKey, sungMs: Math.round(sungMs), reason: reasonNow(), result });
  const emit = (event) => document.dispatchEvent(new CustomEvent('mt:exercise', { detail: { exercise: 'range', event, ...snapshot() } }));

  function paintUnder() {
    const banner = micflow.state().banner;
    const problem = SIGNAL_PROBLEMS.includes(banner) && !paused ? banner : null;
    // One sentence at a time: the microphone first, then this step's hint, else the safety line.
    const text = problem ? MIC_WORDS[problem] : hintKey ? RANGE_WORDS.hints[hintKey] : round.state().phase === 'result' ? '' : RANGE_WORDS.safety;
    const key = `${problem || ''}|${text}`;
    if (key === underKey) return;          // untouched while unchanged: its button keeps focus
    underKey = key;
    underLine.dataset.role = problem || hintKey ? 'close' : '';
    if (!problem && !hintKey) { underLine.replaceChildren(text); return; }
    underLine.replaceChildren(...[
      icon(problem === 'silence' ? 'mic-off' : problem ? 'warning' : 'info', 16), h('span', null, text),
      // Opening Settings pauses the take and releases the microphone; its own button tests it.
      problem === 'silence' && h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => shell.openSettings('mic') }, 'Test the mic'),
    ].filter(Boolean));
  }

  function paintLadder() {
    facts = ladderFacts(ends, { noteStyle: noteStyle(), final: round.state().phase === 'result' });
    const text = facts.lines.join('\n');
    if (linesEl.textContent !== text) linesEl.textContent = text;
  }

  function paint() {
    const s = round.state(), singing = s.phase === 'low' || s.phase === 'high';
    const phase = paused ? 'paused' : s.phase;
    // "Round done" is Match and hold's word: there is no round here (review 4, finding 11).
    const chip = s.phase === 'result' ? { ...PHASE_CHIP.done, word: 'Measured', icon: 'tick' } : PHASE_CHIP[paused ? 'paused' : singing ? 'sing' : 'ready'];
    chipIcon.replaceChildren(icon(chip.icon, 16));
    chipWord.textContent = chip.word;
    phaseChip.dataset.role = chip.role;
    // Embedded, the setup path's own title row counts the parts.
    stepText.textContent = embedded ? '' : s.phase === 'low' ? 'Step 1 of 2' : s.phase === 'high' ? 'Step 2 of 2' : '';
    const say = singing ? RANGE_WORDS.steps[s.phase] : s.phase === 'ready' ? RANGE_WORDS.ready : RANGE_WORDS.sky;
    if (doLine.textContent !== say) doLine.textContent = say;

    const pinned = singing ? s[s.phase] : null;
    const busy = starting || reopening;
    const label = busy ? 'Starting…' : { ready: 'Start', low: 'Next: your highest note', high: 'Show my range', paused: 'Resume', result: '' }[phase];
    const off = busy || (singing && !paused && pinned === null);
    primary.replaceChildren(label, off ? '' : ' ', off ? '' : keycap());
    // Hidden AND off once the result is up: Space must reach the card's own button.
    primary.disabled = off || s.phase === 'result';
    primary.hidden = s.phase === 'result';
    // While singing the main button is the quiet kind: nothing bright under the eyes.
    primary.className = `btn ${singing && !paused ? 'btn-secondary' : 'btn-primary'}`;
    primaryWhy.textContent = busy ? 'Waiting for the microphone.'
      : paused ? (micflow.state().phase === 'lost' ? '' : 'The microphone is off. Press Resume to turn it back on.')
        : singing ? (pinned === null ? RANGE_WORDS[reasonNow() === 'moved-on' ? 'longer' : 'need'][s.phase] : RANGE_WORDS.pinned(s.phase, displayNote(pinned, noteStyle()).text))
          : why;
    tryBtn.hidden = !(singing && !paused && pinned !== null);
    stopBtn.hidden = !singing;
    view.dataset.phase = s.phase === 'result' ? 'done' : phase;
    paintLadder();
    paintUnder();
    paintRing();
  }

  function paintRing() {
    const s = round.state(), singing = (s.phase === 'low' || s.phase === 'high') && !paused;
    for (const rim of rims) rim.set(singing ? hold.progress : 0, { landed: singing && hold.progress >= 1, star: false });
  }

  const viewPatch = (state) => ({
    state, noteStyle: noteStyle(), calm: shell.calm(),
    meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches,
    // No target: the wide view, with the voice's head left of the ladder; the phase chip
    // owns the top left corner.
    target: null, wide: true, range: { low: R.viewLowMidi, high: R.viewHighMidi }, nowFrac: R.nowFrac,
    // 52: the chip's bottom edge is 44 px down, and at 40 a C5 showed as a sliver under it.
    labelClearTopPx: 52, grid: R.grid || 'full', voiceAlpha: 1,
  });

  // The sky does not scroll while it is measured (review 4, 6b): the whole wide view, C2 to
  // C6, stays put, so a pinned horizon stays where it was pinned and the voice moves in a
  // still sky. (A view that follows the voice carried the bright lines across the stage.)
  // stage.reset() drops a fit, so this follows every pv.clear().
  const skyView = () => pv.stage.fit({ low: R.viewLowMidi + config.stage.widePadSemis, high: R.viewHighMidi - config.stage.widePadSemis }, { ms: 0 });

  // ---- the take
  const guard = async () => {
    const wasSinging = !paused;
    // The sheet pauses the take, which releases the microphone; "Keep singing" is a press,
    // so it may turn it back on.
    const leave = await confirmSheet({ title: 'Leave? This measurement won’t be kept.', yes: 'Leave', no: 'Keep singing' });
    if (!leave && wasSinging && paused) resume();
    return leave;
  };

  function clearStep(which) {
    frames[which] = [];
    ends[which] = null;
    watch.reset();
    hold = { midi: null, heldMs: 0, progress: 0 };
    sungMs = 0;
    wasLong = false;
    hintKey = round.state().hint;
  }

  function beginStep() {
    paused = false;
    rebase = true;
    watch.reset();
    hold = { midi: null, heldMs: 0, progress: 0 };
    // The loop first, then the picture (bugs.md 71): with the loop resting, set() draws one
    // still frame, and a still frame shows the curtain of light at full strength. After a
    // pause that had eased it part of the way out, Resume put it back in that one frame.
    pv.stage.start();
    pv.set(viewPatch('live'));
    micflow.setListening(true);
    paint();
    emit('step');
    if (!primary.disabled) primary.focus({ preventScroll: true });
  }

  async function start() {
    if (round.state().phase !== 'ready' || starting) return false;
    starting = true; why = '';
    paint();
    const ok = await micflow.request(micOptions || {});
    if (dead) return false;
    starting = false;
    if (!ok) { why = 'The microphone is not on yet.'; paint(); return false; }
    frames = { low: [], high: [] }; ends = { low: null, high: null };
    lastT = null; tOffset = 0; result = null; hintKey = null; sungMs = 0;
    pv.clear();
    skyView();
    round.start();
    shell.setBusy(guard);
    emit('start');
    beginStep();
    return true;
  }

  // One look at the whole step: where its end is now, what the ladder covers, which hint.
  function analyse() {
    const s = round.state(), which = s.phase;
    if (which !== 'low' && which !== 'high') return;
    const end = endFrom(frames[which], which, R), before = s[which], reasonBefore = reasonNow();
    ends[which] = end;
    round.pin(which, end.ok ? end.note : null);
    const after = round.state()[which];
    const hint = stepHint({ sungMs, end, inverted: round.state().hint === 'inverted' }, R);
    const changed = after !== before || hint !== hintKey || reasonNow() !== reasonBefore;
    hintKey = hint;
    if (after !== before && after !== null) emit('pinned');
    if (changed) paint(); else { paintLadder(); paintUnder(); }
  }

  function next() {
    const before = round.state();
    if ((before.phase !== 'low' && before.phase !== 'high') || paused) return;
    const s = round.next();
    if (s.phase === 'result') { finish(); return; }
    if (s.phase === before.phase && s.hint !== 'inverted') return;       // nothing pinned yet
    // On to the high step, or the high step again after a mis-step: it starts empty.
    clearStep('high');
    beginStep();
  }

  function tryAgain() {
    const which = round.state().phase;
    if ((which !== 'low' && which !== 'high') || paused) return;
    round.tryAgain();
    clearStep(which);
    paint();
  }

  function release() {
    micflow.stop();
    shell.setBusy(null);
  }

  function stop() {
    const p = round.state().phase;
    if (p !== 'low' && p !== 'high') return;
    round.stop();
    release();
    paused = false;
    frames = { low: [], high: [] }; ends = { low: null, high: null }; hintKey = null;
    hold = { midi: null, heldMs: 0, progress: 0 };
    pv.clear();
    skyView();
    pv.set(viewPatch('idle'));
    // The horizons fade out, then the picture rests.
    later(() => { if (round.state().phase === 'ready') pv.stage.stop(); }, Math.max(2 * FADE_MS, HZ.outMs + 150));
    paint();
    emit('stop');
    primary.focus({ preventScroll: true });
  }

  function finish() {
    release();
    paused = false;
    hold = { midi: null, heldMs: 0, progress: 0 };
    const range = measureRange({ low: ends.low, high: ends.high }, R);
    const prev = readRange(store);
    const growth = rangeGrowth(prev, range);
    // "New best" is wider than every saved measurement, not only the last one: a small
    // sample followed by a usual one was a "New best" every time (bugs.md 47).
    const record = readRangeRecord(store);
    const widest = record ? Math.max(...record.history.map((e) => e.highMidi - e.lowMidi)) : null;
    result = {
      range, words: rangeWords(range, { noteStyle: noteStyle() }), growth, saved: false, stored: false, tier: widest !== null && range.notes > widest ? 'best' : 'note',
      first: !prev, grew: { low: !!prev && range.lowMidi < prev.lowMidi, high: !!prev && range.highMidi > prev.highMidi },
    };
    // The whole range in the picture, whatever was sung last (it used to stay on the last
    // note, with the low end off the bottom), and the voice line steps back.
    // A cross-fade under calm motion too: it is a fade, not a slide, and from the still sky
    // (C2 to C6) a cut to the range moved the whole voice line in one frame (0.15 in the lab).
    pv.stage.fit({ low: range.lowMidi, high: range.highMidi }, { ms: R.resultFitMs });
    pv.set({ voiceAlpha: R.resultVoiceAlpha });
    // The microphone is off now: the read-out must not go on naming a note.
    pv.hud.update(null, 0);
    paint();
    showResult();
    emit('result');
    // The horizons and the band finish easing, then the picture rests.
    later(() => pv.stage.stop(), 900);
  }

  function showResult() {
    const r = result, w = r.words;
    const saveBtn = r.saved
      ? (embedded
        ? h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, onclick: () => { if (onNext) onNext(r.entry); } }, 'Next ', keycap())
        : h('a', { class: 'btn btn-primary', href: backHref, dataset: { primary: '' } }, 'Back to Practice'))
      : h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, onclick: () => save() }, 'Save ', keycap());
    card.replaceChildren(...[
      h('div', { class: 'done-top' },
        r.saved ? h('span', { class: 'chip', dataset: { role: 'good' } }, icon('tick', 16), r.stored ? 'Saved' : 'Kept for this visit') : null,
        r.tier === 'best' ? h('span', { class: 'chip', dataset: { role: 'gold' } }, icon('star', 16), 'New best') : null),
      h('p', { class: 'done-line' }, `${w.line}.`),
      // The first one ever is its own small event (review 4, 6d); the stars light on the stage.
      r.saved && r.first ? h('p', { class: 'range-first' }, icon('star', 16), ' Your first measurement. Every exercise now stays inside it.') : null,
      rangeBar(r.range, w),
      h('p', { class: 'reason' }, [w.comfort, w.small, r.growth.words ? `${r.growth.words}.` : '',
        r.saved && !r.stored ? 'This browser would not save it.' : ''].filter(Boolean).join(' ')),
      // The lent buttons (setup's Back and "Set up later") move to the card's row: the
      // screen's own row is not shown under a result, and a new singer could not back out
      // of one without saving (bugs.md 49). again() takes them back.
      h('div', { class: 'action-row' }, ...rowStart, saveBtn,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => again() }, 'Measure again'), ...rowEnd)].filter(Boolean));
    card.dataset.tier = r.tier;
    card.dataset.first = r.first ? 'yes' : 'no';
    card.hidden = false;
    saveBtn.focus({ preventScroll: true });
    // Under the stage the card can be below the bottom of the window (setup at 1024 x 640):
    // the press then seemed to do nothing (review 4, finding 1).
    // In a short or narrow window the card rides the bottom edge (css/app.css), where it would
    // lie over the foot of the stage: the page moves up by that much, so the picture and the
    // card are both whole and the card covers nothing it reports.
    const box = card.getBoundingClientRect(), stageBox = pv.stage.el.getBoundingClientRect();
    const over = Math.max(0, stageBox.bottom + 8 - box.top), under = Math.max(0, box.bottom - window.innerHeight);
    if (over > 0 || under > 0) window.scrollBy({ top: over + under, behavior: shell.calm() ? 'auto' : 'smooth' });
    else if (box.top < 0) card.scrollIntoView({ block: 'nearest', behavior: shell.calm() ? 'auto' : 'smooth' });
  }

  function save() {
    if (round.state().phase !== 'result' || !result || result.saved) return false;
    const out = saveRange(store, result.range, now());
    result = { ...result, saved: true, stored: out.saved, entry: out.record.current };
    showResult();
    if (sessions) sessions.result('range', { sec: sungMs / 1000, facts: { lowMidi: result.range.lowMidi, highMidi: result.range.highMidi } });
    emit('saved');
    if (result.first) {
      // The first measurement ever: a gold star lights on each horizon, the ground first,
      // each with one soft ring (review 4, 6d). Calm motion: the two stars simply appear.
      for (const id of timers) clearTimeout(id);
      timers.clear();
      pv.stage.start();
      shown.first = performance.now();
      const ring = (which, pair) => { const y = shown.ys[which]; if (y !== null) layer.burst({ x: shown.starX, y: Math.round(y), tier: 'first', run: 1, pair, easeInMs: R.burstEaseInMs }); };
      ring('low', false);
      later(() => ring('high', true), HZ.firstStarGapMs);
      later(() => pv.stage.stop(), HZ.firstStarGapMs + config.rewards.burstMs + 600);
    } else if (result.tier === 'best' && (result.grew.low || result.grew.high)) {
      // A wider range than last time: the Best-tier burst, behind the card. finish() asked
      // the picture to rest 900 ms after the result; Save inside that time must not have
      // the burst stopped half way (bugs.md 43).
      for (const id of timers) clearTimeout(id);
      timers.clear();
      pv.stage.start();
      // On the end that grew, not in the middle of the stage tied to nothing; both ends,
      // 200 ms apart, when both grew (review 4, finding 15).
      const ends2 = [result.grew.low ? result.range.lowMidi : null, result.grew.high ? result.range.highMidi : null].filter((m) => m !== null);
      const box = pv.stage.canvas.getBoundingClientRect();
      const at = (midi, pair) => layer.burst({ x: box.width / 2, y: box.height * 0.3, midi, tier: 'best', run: 1, pair, easeInMs: R.burstEaseInMs });
      at(ends2.length ? ends2[0] : null, false);
      if (ends2.length > 1) later(() => at(ends2[1], true), 200);
      later(() => pv.stage.stop(), config.rewards.burstMs + 600);
    }
    return true;
  }

  async function again() {
    if (round.state().phase !== 'result') return false;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    // Not pv.stage.stop() here: pressed soon after the result, the curtain of light is still
    // easing away, and a stopped stage drops it with the trail in one frame (bugs.md 61;
    // labs/range-lab.html, calm motion: 0.12 to 0.16 on the flash number, 0.19 pressed at
    // once). The loop runs on, so the stage eases it out, and rests by itself if the
    // microphone does not come.
    later(() => { if (round.state().phase === 'ready') pv.stage.stop(); }, ((config.aurora && config.aurora.cutFadeMs) || 600) + 150);
    card.hidden = true;
    const row = primary.closest('.action-row');
    if (row) { row.prepend(...rowStart); row.append(...rowEnd); }
    round.again();
    result = null;
    shown.first = null;
    ends = { low: null, high: null };
    pv.clear();
    skyView();
    pv.set(viewPatch('idle'));
    paint();
    return start();
  }

  // Pause always lets the microphone go (owner rule 2026-10-12): Esc, any sheet, the page
  // hidden or left. What was sung so far in the step is kept.
  const REST_MS = 750;
  function pause() {
    const p = round.state().phase;
    if (paused || (p !== 'low' && p !== 'high')) return;
    paused = true;
    const lost = micflow.state().phase === 'lost';
    if (!lost) micflow.stop();
    watch.reset();
    hold = { midi: null, heldMs: 0, progress: 0 };
    pv.set({ state: lost ? 'lost' : 'paused' });
    paint();
    emit('paused');
    // The drawing loop rests too, once the line has eased out (stopped at once, it went in
    // one frame): a paused picture is one still frame, not 60 a second of the same one.
    later(() => { if (paused) pv.stage.stop(); }, REST_MS);
  }
  // Only ever reached from a press: the button, Space, the stage's paused card, "Keep singing".
  async function resume() {
    if (!paused || reopening) return;
    reopening = true;
    paint();
    const ok = await micflow.request(micOptions || {});
    reopening = false;
    if (dead) return;
    if (!ok || !paused) { paint(); return; }
    beginStep();
  }

  const offFrame = micflow.onFrame((frame, level) => {
    const which = round.state().phase;
    if (dead || paused || (which !== 'low' && which !== 'high')) return;
    // Each time the microphone is opened its clock starts again: later readings follow the
    // last one, after a gap long enough that no hold can bridge the pause.
    if (rebase) { tOffset = lastT === null ? -frame.t : lastT + 0.5 - frame.t; rebase = false; }
    const t = frame.t + tOffset;
    if (lastT !== null && frame.voiced) sungMs += Math.min(100, Math.max(0, (t - lastT) * 1000));
    lastT = t;
    const list = frames[which];
    // The loudness goes with each reading: range.js tells a room hum from the voice by it.
    list.push({ t, midi: frame.voiced ? frame.midi : null, voiced: !!frame.voiced, level });
    while (list.length && t - list[0].t > KEEP_SEC) list.shift();
    pv.push({ ...frame, t }, level);
    // The ring must not fill on what the last look at the step called background.
    const floor = ends[which] ? ends[which].floor : 0;
    const s = watch.push({ t, midi: frame.midi, voiced: frame.voiced && !(level < floor) });
    // The ring fills while the held note would be this step's end: at or beyond the pin.
    const pinned = round.state()[which], note = s.midi === null ? null : Math.round(s.midi);
    const counts = note !== null && (pinned === null || (which === 'low' ? note <= pinned : note >= pinned));
    hold = { midi: s.midi, heldMs: s.heldMs, progress: counts ? Math.min(1, s.heldMs / R.pinMs) : 0 };
    paintRing();
    const long = s.heldMs >= R.pinMs;
    if (textEvery.due(t * 1000) || long !== wasLong) analyse();
    wasLong = long;
  });
  const offState = micflow.subscribe((st) => {
    const p = round.state().phase, singing = p === 'low' || p === 'high';
    // Lost (unplugged) or released because the page was hidden: the take waits, paused.
    if (singing && !paused && (st.phase === 'lost' || st.phase === 'off')) pause();
    else if (singing) paintUnder();
    if (paused) paint();
  });

  primary.addEventListener('click', () => {
    const p = round.state().phase;
    if (paused) resume();
    else if (p === 'ready') start();
    else if (p === 'low' || p === 'high') next();
  });
  pv.stage.onResume(resume);

  // ---- keys, pauses, settings
  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (spaceActs(e, { sheet: sheetOpen() })) {
      // Always: with the button off, Space scrolled the page instead (review 4, finding 8).
      e.preventDefault();
      const shownBtn = [...view.querySelectorAll('[data-primary]:not([disabled])')].find((b) => !b.closest('[hidden]'));
      if (shownBtn) shownBtn.click();
      return;
    }
    if (e.key === 'Escape' && !paused && !sheetOpen()) { pause(); if (paused) primary.focus(); }
  };
  const onSheet = (e) => { if (e.detail.open) pause(); };
  const onHidden = (e) => { if (e.type === 'pagehide' || document.hidden) pause(); };
  const onCalm = () => { pv.set({ calm: shell.calm(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches }); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  document.addEventListener('mt:calm', onCalm);
  smallMq.addEventListener('change', onCalm);
  const offSettings = settings.subscribe((k) => {
    if (k !== 'noteNames' && k !== 'pitchView') return;
    pv.set({ noteStyle: noteStyle(), meterOnly: settings.get('pitchView') === 'meter' || smallMq.matches });
    if (result) { result = { ...result, words: rangeWords(result.range, { noteStyle: noteStyle() }) }; showResult(); }
    paint();
  });

  pv.set(viewPatch('idle'));
  skyView();
  pv.stage.settle();
  paint();

  return {
    start, next, tryAgain, stop, pause, resume, save, again,
    confirmLeave: async () => { const p = round.state().phase; return p === 'low' || p === 'high' ? guard() : true; },
    state: snapshot,
    view: pv,
    destroy() {
      dead = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      const p = round.state().phase;
      // `starting` / `reopening`: a request is still waiting for the microphone; without this
      // it would open after the screen has gone and stay on with nothing using it.
      if (starting || reopening || p === 'low' || p === 'high') micflow.stop();
      shell.setBusy(null);
      // The shell reuses this element for the next screen: leave nothing of ours on it.
      delete view.dataset.phase;
      view.classList.remove('exercise', 'rangefinder', 'done-below');
      offFrame(); offState(); offSettings(); unmountBanners();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('mt:calm', onCalm);
      smallMq.removeEventListener('change', onCalm);
      layer.destroy();
      for (const rim of rims) rim.remove();
      pv.destroy();
    },
  };
}
