// hud.js — the side read-out next to the pitch stage, and the stage + read-out pair that
// every live screen mounts (docs/design/specs/2026-10-12-singing-trainer.md section 5.3).
//
// CONTRACT
//   createHintGate(cfg?) -> { push(problem | null, success, tMs) -> hint key | null, reset() }
//       Pure. One hint at a time: shown only after the same problem lasted hintAfterMs,
//       kept at least hintKeepMs, hidden after hintClearAfterSuccesses successes in a row
//       (a success = the moment `success` turns true) or once the problem has been gone
//       for hintKeepMs.
//   HINTS            hint key -> the sentence
//   createHud(host, { config?, hints? }) -> { el, update(readout | null, level?), reset() }
//       readout is what stage.push() returns (js/app/stage.js). null = nothing live: the
//       ring shows "–" and the words are empty. The words come from readout.shown only,
//       so they change at most hud.readoutHz times a second and always match the head tag.
//       The needle follows the live cents and eases in CSS.
//   createPitchView(host, { config? }) -> view
//       view.el, view.stage (see stage.js), view.hud
//       view.set(patch)     stage.set plus { meterOnly: boolean }
//       view.push(frame, level = 0) -> readout     feeds the stage and the read-out
//       view.clear()        forget the take and empty the read-out
//       view.destroy()
//   Browser only, except createHintGate and HINTS.

import { CONFIG } from './config.js';
import { h, icon } from './shell.js';
import { createStage } from './stage.js';

export const HINTS = Object.freeze({
  low: 'Let your voice slide up slowly until the line sits inside the band.',
  high: 'Let your voice come down slowly until the line sits inside the band.',
  'no-clear-note': 'I hear sound but no clear note. Try a steady ‘ah’.',
});

export function createHintGate(cfg = CONFIG.hud) {
  let problem = null, since = 0, shown = null, shownAt = 0, successes = 0, wasSuccess = false, goneSince = null;
  return {
    push(key, success, tMs) {
      if (success && !wasSuccess) successes++;
      wasSuccess = !!success;
      if (key !== problem) { problem = key; since = tMs; }
      const kept = !shown || tMs - shownAt >= cfg.hintKeepMs;
      if (problem && problem !== shown && kept && tMs - since >= cfg.hintAfterMs) {
        shown = problem;
        shownAt = tMs;
        successes = 0;
        goneSince = null;
        return shown;
      }
      if (!shown) return null;
      if (problem === shown) goneSince = null;
      else if (goneSince === null) goneSince = tMs;
      if (kept && (successes >= cfg.hintClearAfterSuccesses || (goneSince !== null && tMs - goneSince >= cfg.hintKeepMs))) shown = null;
      return shown;
    },
    reset() { problem = null; shown = null; successes = 0; wasSuccess = false; goneSince = null; },
  };
}

// What a screen reader hears: shorter than the chip, and never more often than every 3 s.
const SPOKEN = { 'octave:lower': 'Right note, one octave lower', 'octave:higher': 'Right note, one octave higher', in: 'In tune', 'close:low': 'A little low', 'close:high': 'A little high', 'off:low': 'Too low', 'off:high': 'Too high' };

function createRing(host) {
  const base = h('span', { class: 'note-base' }, '–');
  const octave = h('sub', { class: 'note-octave' });
  const el = h('div', { class: 'note-ring is-quiet' }, h('span', { class: 'note-name' }, base, octave));
  host.append(el);
  let key = '';
  return {
    el,
    update(shown) {
      const live = !!shown && !shown.listening;
      const k = live ? shown.noteText : '';
      if (k === key) return;
      key = k;
      base.textContent = live ? shown.noteBase : '–';
      octave.textContent = live ? String(shown.noteOctave) : '';
      el.classList.toggle('is-quiet', !live);
      // "Sol♯3" at the full size is wider than the ring: long names get a smaller size.
      el.toggleAttribute('data-long', live && shown.noteBase.length > 2);
    },
  };
}

function createMeter(host, config) {
  const range = config.hud.meterRangeCents;
  const pct = (cents) => `${50 + (cents / range) * 50}%`;
  const zone = (cls, from, to) => h('i', { class: `meter-zone ${cls}`, style: `left:${pct(from)};width:${((to - from) / range) * 50}%` });
  const needle = h('i', { class: 'meter-needle' });
  const caption = h('p', { class: 'meter-caption' });
  const el = h('div', { class: 'meter is-idle' },
    h('div', { class: 'meter-track' },
      zone('zone-close', -config.verdict.closeCents, -config.verdict.inTuneCents),
      zone('zone-good', -config.verdict.inTuneCents, config.verdict.inTuneCents),
      zone('zone-close', config.verdict.inTuneCents, config.verdict.closeCents),
      h('i', { class: 'meter-centre' }), needle),
    h('div', { class: 'meter-ends' }, h('span', null, 'low'), h('span', null, 'high')), caption);
  host.append(el);
  let cap = null;
  return {
    el,
    update(r) {
      const live = !!r && r.voiced;
      const s = r && r.shown;
      // The needle is hidden whenever the ring shows "–": a needle resting at the centre
      // would say "on the note" to someone who is not singing.
      // ...and for the right note an octave away: a dot parked at the "low" end would call
      // it wrong (review 2, finding 1).
      el.classList.toggle('is-idle', !s || s.listening || !!(s.verdict && s.verdict.octave));
      // With nothing live at all the needle rests in the middle, not where the last take left it.
      if (!r) needle.style.transform = '';
      if (live) {
        const c = Math.max(-range, Math.min(range, r.cents));
        // Moved with a transform so the 120 ms ease costs no layout.
        needle.style.transform = `translateX(${(c / range) * 50}cqw)`;
        el.dataset.kind = r.kind;
        // Beyond the scale the needle parks at the end and that end's word turns bold. No
        // arrow: it would point away from where the voice should go.
        el.dataset.parked = Math.abs(r.cents) > range ? (r.cents < 0 ? 'low' : 'high') : '';
      }
      const text = !s || s.listening ? '' : r.hasTarget ? 'Against your target note' : `Against the nearest note (${s.noteText})`;
      if (text !== cap) { cap = text; caption.textContent = text; }
    },
  };
}

export function createHud(host, { config = CONFIG, hints: words = null } = {}) {
  // A screen with no band (Sing a constellation) gives its own low / high sentences.
  const hintWords = { ...HINTS, ...(words && { low: words.low || HINTS.low, high: words.high || HINTS.high }) };
  const ringHost = h('div', { class: 'hud-ring' }), meterHost = h('div', { class: 'hud-meter' });
  const number = h('p', { class: 'hud-number' });
  const chipIcon = h('span', { class: 'chip-icon' }), chipWord = h('span');
  const chip = h('div', { class: 'chip verdict-chip is-empty' }, chipIcon, chipWord);
  const hint = h('p', { class: 'hud-hint' });
  const levelFill = h('i');
  const live = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  // Four slots in a fixed order, so in the narrow row layout the parts keep their places
  // when the words change length; the row wraps only between slots.
  const el = h('aside', { class: 'hud', 'aria-label': 'Pitch read-out' },
    ringHost, h('div', { class: 'hud-slot' }, meterHost, number), h('div', { class: 'hud-slot' }, chip, hint),
    h('div', { class: 'level' }, h('span', { class: 'level-label' }, 'Mic level'), h('div', { class: 'level-bar' }, levelFill)),
    live);
  host.append(el);
  const ring = createRing(ringHost), meter = createMeter(meterHost, config), hints = createHintGate(config.hud);
  let lastNumber = null, lastChip = null, lastHint = null, lastSpoken = '', spokenAtMs = -Infinity, lastLevel = -1;

  function paintChip(v) {
    const key = !v || v.kind === 'free' ? '' : v.octave ? `octave:${v.octave}` : v.kind === 'listening' || v.kind === 'in' ? v.kind : `${v.kind}:${v.dir}`;
    if (key === lastChip) return;
    lastChip = key;
    chip.classList.toggle('is-empty', !key);
    chip.dataset.kind = v ? v.kind : '';
    chipIcon.replaceChildren();
    chipWord.textContent = key ? v.word : '';
    if (!key) return;
    // An octave away: the close style with the two-dot octave mark, and no arrow.
    if (v.octave) { chipIcon.append(h('span', { class: 'octave-dots', 'aria-hidden': 'true' }, h('i'), h('i'))); return; }
    chipIcon.append(icon(v.icon, 16));
    // "Close" is a wave PLUS the way to move, so the direction never rests on colour.
    if (v.kind === 'close') chipIcon.append(icon(v.move === 'up' ? 'arrow-up' : 'arrow-down', 16));
  }

  return {
    el,
    update(r, level = r ? r.level : 0) {
      const s = r && r.shown;
      ring.update(s);
      meter.update(r);
      const text = s && !s.listening ? s.numberText : '';
      if (text !== lastNumber) { lastNumber = text; number.textContent = text; }
      paintChip(s ? s.verdict : null);

      const tMs = r ? r.t * 1000 : 0;
      const v = r && r.voiced ? r.verdict : null;
      const problem = !r ? null
        : r.noClearNoteMs > 0 ? 'no-clear-note'
          : v && (v.kind === 'close' || v.kind === 'off') ? v.dir : null;
      const key = r ? hints.push(problem, !!v && v.kind === 'in', tMs) : null;
      if (key !== lastHint) { lastHint = key; hint.textContent = key ? hintWords[key] : ''; hint.classList.toggle('is-shown', !!key); }

      const spoken = s && s.verdict && s.verdict.kind !== 'free' && s.verdict.kind !== 'listening'
        ? SPOKEN[s.verdict.octave ? `octave:${s.verdict.octave}` : s.verdict.kind === 'in' ? 'in' : `${s.verdict.kind}:${s.verdict.dir}`] : '';
      if (spoken && spoken !== lastSpoken && tMs - spokenAtMs >= config.hud.announceEveryMs) {
        lastSpoken = spoken;
        spokenAtMs = tMs;
        live.textContent = spoken;
      }

      // Square root: a quiet voice still moves the bar visibly, which is the bar's job
      // (it proves the app hears something even when no pitch is found).
      const lv = Math.round(100 * Math.min(1, Math.sqrt(Math.max(0, level) / config.mic.levelFullScaleRms)));
      if (lv !== lastLevel) { lastLevel = lv; levelFill.style.transform = `scaleX(${lv / 100})`; }
    },
    reset() {
      hints.reset();
      lastSpoken = '';
      spokenAtMs = -Infinity;
      this.update(null, 0);
    },
    // The meter-only view shows its own ring and big meter in the stage's place.
    mirror(hostEl) {
      const r2 = createRing(hostEl), m2 = createMeter(hostEl, config);
      m2.el.classList.add('meter-big');
      return (r) => { r2.update(r && r.shown); m2.update(r); };
    },
  };
}

export function createPitchView(host, { config = CONFIG } = {}) {
  const main = h('div', { class: 'pitch-main' });
  const meterOnly = h('div', { class: 'meter-only' });
  const el = h('div', { class: 'pitch-view', dataset: { view: 'line' } }, main);
  host.append(el);
  const stage = createStage(main, { config });
  main.append(meterOnly);
  const hud = createHud(el, { config });
  const mirror = hud.mirror(meterOnly);

  return {
    el, stage, hud,
    set(patch = {}) {
      const { meterOnly: only, ...rest } = patch;
      if (only !== undefined) el.dataset.view = only ? 'meter' : 'line';
      stage.set(rest);
      // Outside 'live' the read-out has nothing true to say.
      if (rest.state && rest.state !== 'live' && rest.state !== 'paused' && rest.state !== 'lost') { hud.update(null, 0); mirror(null); }
    },
    push(frame, level = 0) {
      const r = stage.push(frame, level);
      if (r && stage.debug().state === 'live') { hud.update(r, level); mirror(r); }
      return r;
    },
    clear() { stage.reset(); hud.reset(); mirror(null); },
    destroy() { stage.destroy(); el.remove(); },
  };
}
