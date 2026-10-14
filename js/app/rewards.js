// rewards.js — the reward layer: what a held note earns, how big it looks, what it sounds
// like and when it may sound (docs/design/STYLE.md section 6 "Rewards", spec 7.3 and 10.4).
//
// PROVENANCE. The pure helpers are copied from asl-recognizer/js/juice.js (scaleStep, climb,
// nextRun, rewardTier, celebrationPlan, glowLevel) and made calmer, as STYLE.md asks: the
// spark cap is 40 (72 there), a plain note is 12 sparks (30 there), and a longer run makes
// the chime climb but never makes the picture bigger. One scale for every sound (C major
// pentatonic), so any two chimes sound related and overlapping tails never clash.
//
// Rules that hold everywhere: rewards only go up (there is no "miss" plan, sound or colour
// in this file, by design); at most one burst per burstMinGapMs; a chime never plays while
// the microphone is judging a note, and never without confirmed headphones.
//
// The top half is PURE and imports in Node (tools/checks/rewards.check.mjs).
//
// CONTRACT — pure
//   PENTA, scaleStep(step, scale?) -> semitones above the root (wraps into octaves)
//   climb(run, cap?) -> 0..cap scale steps for `run` successes in a row
//   nextRun(prevCount, prevAtMs, nowMs, windowMs?) -> the run length after one more success
//   rewardTier({ firstTime, newBest }) -> 'note' | 'first' | 'best'   (best wins: it is rarer)
//   celebrationPlan(tier, run?, cfg?, look?) -> { tier, sparks, rings, colour, chip, run }
//       look ('steady' | 'held' | 'recovered') sets the spark count of a 'note' plan.
//       colour is a TOKEN name ('good' | 'accent' | 'gold'), never a colour value.
//       chip: null | 'First time' | 'New best'. sparks never exceeds cfg.sparkCap.
//   glowLevel(inRow, cfg?) -> 0..3 for the stage's edge glow
//   burstAllowed(lastMs, nowMs, cfg?) -> boolean
//   chimePlan(tier, run?, cfg?) -> [{ midi, at (s), dur (s) }]   1, 2 or 3 notes
//   canChime({ enabled, headphones, scoring }) -> boolean
//   spreadOf(centsList) -> median distance of the values from their own median, or null
//   starLook({ spread, drained }, cfg?) -> 'steady' | 'held' | 'recovered'
//       recovered: the ring drained and the note was still landed. steady: spread at most
//       cfg.steadySpreadCents and never drained. A look never changes the score: one star each.
//   LOOK_WORDS (the chip: "Held · steady" | "Held" | "Held · found it again")
//   starLabel(n, total, look | null) -> "Star 2 of 5: held steady" | "Star 2 of 5: not held yet"
//   answerPlan(targetMidi, inRow, cfg?) -> { voices: [{ midi, atMs, durMs }], endMs }
//       The answering chord: target +12, +19, +24, one more voice per note in a row, all an
//       octave lower while the top one is above cfg.maxTopMidi. Times are ms from the
//       landing; endMs (the last voice silent) never exceeds cfg.endWithinMs.
//   soundGuard({ sinceMs, endMs }, cfg?) -> { fade, waitMs }
//       sinceMs = time since the landing. How long the next reference tone (and so any
//       scoring) must still wait: guardMs of silence after the last voice; when the voices
//       are still sounding they fade over earlyFadeMs first (fade = true).
//   makeSparks(count, seed?) -> [{ angle, reach (0.55..1), size (0.7..1.3) }]  repeatable
//   sparkAt(spark, k) -> { dx, dy, alpha } for k = 0..1 of the burst, in units of the reach
//
// CONTRACT — browser
//   createRewardLayer(stage, { config?, calm? }) -> layer
//       Draws on the pitch stage through stage.addLayer (js/app/stage.js).
//       layer.burst({ x, y, midi?, tier = 'note', run = 1, look?, echoes = 0 }) -> plan | null
//           midi: anchor the burst to that pitch on the now line. Its place is worked out
//           again on every frame, so it stays on the note when the view moves (it used to
//           be left behind at the pixel where the note landed; review 2, finding 2).
//           echoes: extra faint rings, one per voice of the answering chord, stepMs apart
//           (the chord's visual twin: drawn with or without sound, part of the same burst).
//           pair: the second half of one celebration in two places (both ends of a range
//           grew): it is not held back by burstMinGapMs.
//           easeInMs (default 0: as before): the burst fades in over this long instead of
//           starting at full strength. For a burst on a still, dark picture, where 40 sparks
//           born in one spot read 0.17 on the range lab's flash number (limit 0.15).
//           x, y in the stage's CSS pixels. null when a burst was shown under
//           burstMinGapMs ago (nothing is drawn). Under calm motion the plan is returned
//           and nothing moves: no sparks, no expanding ring.
//       layer.setGlow(level)   0..3, the edge glow (eased in CSS)
//       layer.busy() -> boolean, layer.destroy()
//   playChime(synth, plan, gain) -> handles    synth from js/synth.js (round-done tiers)
//   playAnswer(synth, plan, toneGain, cfg?) -> handles   every play is tagged { tag: 'reward' }
//   starSvg(look?, sizePx?) -> <svg class="star-shape" data-look>   the tray and card star
//   flyStar({ from: { x, y }, to: element, look?, fromRadius?, calm, ms? }) -> Promise
//       THE star from inside the ring travels on a curved path to `to` (viewport pixels),
//       starting at the size it had there; under calm motion it resolves at once.

import { CONFIG } from './config.js';
import { starShape } from './holdring.js';

// ---------------------------------------------------------------- pure

export const PENTA = Object.freeze([0, 2, 4, 7, 9]);

export function scaleStep(step, scale = PENTA) {
  const n = scale.length;
  const s = Math.round(step) || 0;
  return scale[((s % n) + n) % n] + 12 * Math.floor(s / n);
}

export function climb(run, cap = CONFIG.rewards.climbCap) {
  return Math.max(0, Math.min(cap, (Math.floor(run) || 1) - 1));
}

export function nextRun(prevCount, prevAtMs, nowMs, windowMs = CONFIG.rewards.runWindowMs) {
  return prevAtMs != null && nowMs - prevAtMs <= windowMs && prevCount > 0 ? prevCount + 1 : 1;
}

export function rewardTier({ firstTime = false, newBest = false } = {}) {
  return newBest ? 'best' : firstTime ? 'first' : 'note';
}

const TIER_LOOK = {
  note: { colour: 'good', chip: null },
  first: { colour: 'accent', chip: 'First time' },
  best: { colour: 'gold', chip: 'New best' },
};

export function celebrationPlan(tier = 'note', run = 1, cfg = CONFIG.rewards, look = null) {
  const t = TIER_LOOK[tier] ? tier : 'note';
  return {
    tier: t,
    // The size depends on the tier alone: a long run must not fill a stage that is
    // already moving. The run is heard (the chime climbs), not seen.
    sparks: Math.min(cfg.sparkCap, t === 'note' && look && cfg.lookSparks[look] ? cfg.lookSparks[look] : cfg.sparks[t]),
    rings: cfg.rings[t],
    ...TIER_LOOK[t],
    run: Math.max(1, Math.floor(run) || 1),
  };
}

export function glowLevel(inRow, cfg = CONFIG.rewards) {
  const n = Math.floor(inRow) || 0;
  return cfg.glowAfter.filter((need) => n >= need).length;
}

export function burstAllowed(lastMs, nowMs, cfg = CONFIG.rewards) {
  return lastMs == null || !(nowMs - lastMs < cfg.burstMinGapMs);
}

export function chimePlan(tier = 'note', run = 1, cfg = CONFIG.rewards) {
  const base = climb(run, cfg.climbCap);
  const count = tier === 'best' ? 3 : tier === 'first' ? 2 : 1;
  // Later notes step up the same scale, two steps at a time (a soft rising figure).
  return Array.from({ length: count }, (_, i) => ({
    midi: cfg.chimeRootMidi + scaleStep(base + 2 * i),
    at: i * cfg.chimeStepSec,
    dur: cfg.chimeNoteSec,
  }));
}

// The microphone must never be judging a note while a chime sounds, and without confirmed
// headphones the chime would reach the microphone through the speakers.
export function canChime({ enabled = true, headphones = null, scoring = false } = {}) {
  return !!enabled && headphones === 'on' && !scoring;
}

const median = (list) => {
  const a = [...list].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function spreadOf(cents) {
  const list = (cents || []).filter(Number.isFinite);
  if (!list.length) return null;
  const mid = median(list);
  return median(list.map((c) => Math.abs(c - mid)));
}

export function starLook({ spread = null, drained = false } = {}, cfg = CONFIG.rewards) {
  if (drained) return 'recovered';
  return Number.isFinite(spread) && spread <= cfg.steadySpreadCents ? 'steady' : 'held';
}

export const LOOK_WORDS = Object.freeze({ steady: 'Held · steady', held: 'Held', recovered: 'Held · found it again' });
const LOOK_SPOKEN = { steady: 'held steady', held: 'held', recovered: 'held, found it again' };

export function starLabel(n, total, look) {
  return `Star ${n} of ${total}: ${look ? LOOK_SPOKEN[look] || 'held' : 'not held yet'}`;
}

export function answerPlan(targetMidi, inRow = 1, cfg = CONFIG.rewards.answer) {
  const count = Math.max(1, Math.min(cfg.semis.length, Math.floor(inRow) || 1));
  let midis = cfg.semis.slice(0, count).map((s) => targetMidi + s);
  while (Math.max(...midis) > cfg.maxTopMidi) midis = midis.map((m) => m - 12);
  // Every voice is a fade in and a fade out and nothing else, cut shorter if the last one
  // would otherwise still be sounding at endWithinMs.
  const lastAt = cfg.firstMs + (count - 1) * cfg.stepMs;
  const durMs = Math.min(cfg.fadeInMs + cfg.fadeOutMs, cfg.endWithinMs - lastAt);
  const voices = midis.map((midi, i) => ({ midi, atMs: cfg.firstMs + i * cfg.stepMs, durMs }));
  return { voices, endMs: lastAt + durMs };
}

export function soundGuard({ sinceMs, endMs }, cfg = CONFIG.rewards.answer) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(endMs)) return { fade: false, waitMs: 0 };
  if (sinceMs >= endMs) return { fade: false, waitMs: Math.max(0, endMs + cfg.guardMs - sinceMs) };
  // Still sounding. Fading now can end it sooner than letting it run out, never later.
  const stopAt = Math.min(endMs, sinceMs + cfg.earlyFadeMs);
  return { fade: true, waitMs: stopAt + cfg.guardMs - sinceMs };
}

export function makeSparks(count, seed = 1) {
  let s = (Math.floor(seed) >>> 0) || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const n = Math.max(0, Math.floor(count) || 0);
  return Array.from({ length: n }, (_, i) => ({
    // Evenly round the circle with a little scatter, so a small burst still looks whole.
    angle: ((i + rnd() * 0.7) / n) * 2 * Math.PI,
    reach: 0.55 + 0.45 * rnd(),
    size: 0.7 + 0.6 * rnd(),
  }));
}

const easeOut = (k) => 1 - (1 - k) ** 3;

export function sparkAt(spark, k) {
  const c = Math.min(1, Math.max(0, k));
  const d = spark.reach * easeOut(c);
  return { dx: Math.cos(spark.angle) * d + 0, dy: Math.sin(spark.angle) * d + 0, alpha: 1 - c };
}

// ---------------------------------------------------------------- browser

export function createRewardLayer(stage, { config = CONFIG, calm = () => false } = {}) {
  const R = config.rewards;
  let bursts = [], lastBurstMs = null, dead = false, seed = 20261012;
  const colourOf = (name, tokens) => tokens[name] || getComputedStyle(stage.el).getPropertyValue(`--${name}`).trim() || tokens.good;

  stage.addLayer((ctx, L, tokens) => {
    if (dead || !bursts.length) return;
    const now = performance.now();
    bursts = bursts.filter((b) => now - b.t0 < R.burstMs + (b.rings - 1) * b.gapMs);
    for (const b of bursts) {
      const colour = colourOf(b.plan.colour, tokens);
      const bx = Number.isFinite(b.midi) ? L.nowX : b.x, by = Number.isFinite(b.midi) ? L.yOfMidi(b.midi) : b.y;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.lineWidth = 2;
      const inK = b.easeInMs > 0 ? Math.min(1, (now - b.t0) / b.easeInMs) : 1;
      for (let i = 0; i < b.rings; i++) {
        const k = (now - b.t0 - i * b.gapMs) / R.burstMs;
        if (k < 0 || k >= 1) continue;
        // The echo rings (one per voice of the answering chord) are fainter than the first.
        ctx.globalAlpha = (i >= b.plan.rings ? R.answer.echoOpacity : 0.9) * (1 - k) * (i === 0 ? inK : 1);
        ctx.beginPath();
        ctx.arc(bx, by, config.hold.headRadiusPx + R.ringGrowPx * easeOut(k), 0, 2 * Math.PI);
        ctx.stroke();
      }
      const k = (now - b.t0) / R.burstMs;
      if (k < 1) {
        for (const s of b.sparks) {
          const p = sparkAt(s, k);
          ctx.globalAlpha = p.alpha * inK;
          ctx.beginPath();
          ctx.arc(bx + p.dx * R.sparkReachPx, by + p.dy * R.sparkReachPx, R.sparkSizePx * s.size, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  });

  return {
    burst({ x, y, midi = null, tier = 'note', run = 1, look = null, echoes = 0, pair = false, easeInMs = 0 } = {}) {
      const now = performance.now();
      if (dead || (!pair && !burstAllowed(lastBurstMs, now, R))) return null;
      lastBurstMs = now;
      const plan = celebrationPlan(tier, run, R, look);
      if (!calm()) {
        bursts.push({
          x, y, midi, easeInMs, t0: now, plan, sparks: makeSparks(plan.sparks, seed++),
          rings: plan.rings + Math.max(0, echoes), gapMs: echoes > 0 ? R.answer.stepMs : 150,
        });
      }
      return plan;
    },
    setGlow(level) { stage.el.dataset.glow = String(Math.max(0, Math.min(3, Math.floor(level) || 0))); },
    busy: () => bursts.length > 0,
    destroy() { dead = true; bursts = []; delete stage.el.dataset.glow; },
  };
}

export function playChime(synth, plan, gain) {
  const t0 = synth.ctx.currentTime + 0.02;
  return plan.map((n) => synth.play({
    midi: n.midi, dur: n.dur, when: t0 + n.at, timbre: 'sine', gain, attack: 0.02, release: Math.min(0.3, n.dur * 0.7), tag: 'reward',
  }));
}

export function playAnswer(synth, plan, toneGain, cfg = CONFIG.rewards.answer) {
  const t0 = synth.ctx.currentTime;
  const gain = (cfg.gainFrac * toneGain) / plan.voices.length;
  return plan.voices.map((v) => synth.play({
    midi: v.midi, dur: v.durMs / 1000, when: t0 + v.atMs / 1000, timbre: 'sine', gain,
    attack: cfg.fadeInMs / 1000, release: Math.min(cfg.fadeOutMs, v.durMs - cfg.fadeInMs) / 1000, tag: 'reward',
  }));
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function starSvg(look = 'held', sizePx = 24) {
  const shape = starShape(look);
  const svg = document.createElementNS(SVG_NS, 'svg');
  // Room for the "found it again" ring on every look, so the three sit on one baseline.
  for (const [k, v] of Object.entries({ viewBox: '-1.7 -1.7 3.4 3.4', width: sizePx, height: sizePx, class: 'star-shape', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.dataset.look = look;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', shape.d);
  svg.append(path);
  if (shape.ring) {
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('r', shape.ring);
    svg.append(ring);
  }
  return svg;
}

export function flyStar({ from, to, look = 'held', fromRadius = 10, calm = false, ms = CONFIG.rewards.starFlightMs }) {
  if (calm || !to || typeof to.getBoundingClientRect !== 'function') return Promise.resolve();
  const r = to.getBoundingClientRect();
  const end = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const size = Math.max(16, r.width);
  const svg = starSvg(look, size);
  svg.classList.add('flying-star');
  document.body.append(svg);
  // A curve, not a straight line: the middle of the path is lifted above both ends. The
  // star is fixed at the viewport's corner, so the path is in viewport pixels.
  const lift = Math.min(from.y, end.y) - 48;
  svg.style.offsetPath = `path('M ${from.x} ${from.y} Q ${(from.x + end.x) / 2} ${lift} ${end.x} ${end.y}')`;
  // It leaves at the size the star had inside the ring: it is that star, not a second one.
  const startScale = (fromRadius * 3.4) / size;
  const anim = svg.animate([{ offsetDistance: '0%', scale: startScale }, { offsetDistance: '100%', scale: 1 }],
    { duration: ms, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
  const gone = () => svg.remove();
  return anim.finished.then(gone, gone);
}
