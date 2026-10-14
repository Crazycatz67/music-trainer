// holdring.js — the hold ring of Match and hold: the rule that decides how full it is, and
// the two drawings of it (docs/design/specs/2026-10-12-singing-trainer.md section 7.3).
//
// PROVENANCE. The rule is a cut-down port of hologram-workshop/holdGate.js (itself from the
// ASL trainer's circle lock): a bad stretch only PAUSES the ring for a grace time, a fired
// hold must be released before another can start, a fresh hold gets no credit for the time
// before it began, and a stalled frame cannot pour charge in. New here (the spec asks for
// it): after the grace the ring DRAINS instead of resetting, so a wobble costs a little and
// not everything. The arc is asl-recognizer/js/handfx.js `holdArc`: a faint full track and
// a calm fill from 12 o'clock, clockwise, round caps.
//
// The top half is PURE and imports in Node (tools/checks/holdring.check.mjs).
//
// CONTRACT — pure
//   createHoldGate(options?) -> gate         options override CONFIG.hold (holdMs, graceMs,
//                                            drainRate, releaseMs, maxDtMs, stuckAfterMs, wobbleDips)
//   gate.push({ tMs, inTune, voiced = inTune, scoring = true, onLast = inTune }) -> s
//       tMs      the reading's time in ms. Not finite -> the reading is ignored. Time going
//                backwards counts as no time passing.
//       inTune   the shown verdict is "In tune" for this reading
//       voiced   a clear note was heard at all (only used for the release rule)
//       onLast   the voice is still on the note that LANDED last (only used for the release
//                rule). The release is from the old note, not the new one: someone who hums
//                along with the next reference tone has let the old note go and must not be
//                asked to stop first. The same note twice in a row does need a break.
//       scoring  false while the reference tone plays or the take is paused: the ring then
//                neither fills nor drains and the grace clock does not run, but the release
//                rule still watches.
//   s = { phase, heldMs, holdMs, progress, landed, needsRelease, sungMs, stuck, dips, wobbly, drained }
//       phase    'idle' | 'filling' | 'paused' (inside the grace, or not scoring with charge)
//                | 'draining' | 'landed' (exactly one reading) | 'held' (landed; waiting for next())
//       heldMs   charge in ms, 0..holdMs; progress = heldMs / holdMs
//       landed   true on the one reading the ring fills. Act on this only.
//       needsRelease  true after next() following a landing, until the voice has been off the
//                landed note or silent for releaseMs; the ring does not fill meanwhile.
//       sungMs   scoring time spent on this note; stuck = sungMs >= stuckAfterMs and not landed
//       dips     times the ring left "in tune" on this note after having charged; wobbly =
//                dips >= wobbleDips
//       drained  the ring lost fill at least once on this note (went past the grace)
//   gate.next()   the next note: charge, sungMs and dips start again; a release is needed
//                 first if the last note landed.
//   gate.reset()  forget everything (a new round)
//   gate.state()  the last s
//   heldText(heldMs, holdMs) -> "Held 1.4 of 3 seconds"
//   arcEnd(progress) -> end angle in radians for a fill starting at 12 o'clock, clockwise
//   easeOut(k), starRadius(progress, cfg?) -> px: the star kindling inside the ring; it is a
//       plain function of the ring's fill, so it pauses and shrinks with the ring
//   smoothTowards(shown, goal, dtMs, tauMs) -> the shown size after dtMs (no jitter)
//   starShape(look?, cfg?) -> { d, ring }   the four-point star as an SVG path in units of
//       its own radius (centre 0,0; a point straight up). look 'held' | 'steady' (four rays
//       at 45 degrees) | 'recovered' (ring = radius of the ring round it, else null).
//   Never throws from push().
//
// CONTRACT — browser
//   drawHoldRing(ctx, { x, y, radius, progress, track, fill, width, trackOpacity, thick = 1 })
//       Draws on a 2D canvas in CSS pixels. Colours are passed in (tokens), never written here.
//   drawKindleStar(ctx, { x, y, outer, fill, outline, glow, halo = 0, look = 'held' })
//       The gold star inside the ring. halo is an opacity (0 = none, as under calm motion).
//   createRimRing(noteRingEl) -> { set(progress, { landed?, star? }), remove() }
//       The same value on the rim of the HUD's note ring, as an SVG laid over its border.
//       The star sits ON the rim at 12 o'clock, where the fill starts and where it lands
//       (star: false hides it). It was behind the note name, where it read as a smudge
//       (review 2, finding 4).
//   rimStarRadius(progress, cfg?) -> px

import { CONFIG } from './config.js';

// ---------------------------------------------------------------- pure

export function createHoldGate(options = {}) {
  const o = { ...CONFIG.hold, ...options };
  let lastT, charge, badSince, wasIn, sungMs, dips, done, needsRelease, relSince, drained, last;

  const snapshot = (phase, landed = false) => (last = {
    phase, heldMs: charge, holdMs: o.holdMs, progress: Math.min(1, charge / o.holdMs), landed,
    needsRelease, sungMs, stuck: !done && sungMs >= o.stuckAfterMs, dips, wobbly: dips >= o.wobbleDips, drained,
  });
  function clearNote() { charge = 0; badSince = null; wasIn = false; sungMs = 0; dips = 0; done = false; relSince = null; drained = false; }
  function reset() { lastT = null; needsRelease = false; clearNote(); snapshot('idle'); }
  reset();

  return {
    reset,
    state: () => last,
    next() {
      const landedBefore = done;
      clearNote();
      needsRelease = landedBefore || needsRelease;
      return snapshot('idle');
    },
    push({ tMs, inTune = false, voiced = inTune, scoring = true, onLast = inTune } = {}) {
      if (!Number.isFinite(tMs)) return last;
      const now = lastT === null ? tMs : Math.max(lastT, tMs);
      const dt = lastT === null ? 0 : Math.min(o.maxDtMs, now - lastT);
      lastT = now;
      if (done) return snapshot('held');

      const on = !!inTune && !!voiced;
      if (needsRelease) {
        // Silence, or clearly somewhere else, for releaseMs: the last note has been let go.
        if (voiced && onLast) relSince = null;
        else {
          if (relSince === null) relSince = now;
          if (now - relSince >= o.releaseMs) { needsRelease = false; relSince = null; }
        }
      }
      if (!scoring) {
        // Frozen: the reference tone is playing or the take is paused. The grace starts
        // again afterwards, so the pause itself is never counted as a bad stretch.
        badSince = null;
        wasIn = false;
        return snapshot(charge > 0 ? 'paused' : 'idle');
      }
      sungMs += dt;

      if (on && !needsRelease) {
        // A fresh stretch gets no credit for the interval before it: the note was not in
        // tune during it (crediting it lands a hold one reading early).
        if (wasIn) charge = Math.min(o.holdMs, charge + dt);
        wasIn = true;
        badSince = null;
        if (charge >= o.holdMs) { done = true; return snapshot('landed', true); }
        return snapshot('filling');
      }
      if (wasIn && charge > 0) dips++;
      wasIn = false;
      if (!(charge > 0)) { badSince = null; return snapshot('idle'); }
      if (badSince === null) badSince = now;
      if (now - badSince < o.graceMs) return snapshot('paused');
      if (dt > 0) drained = true;
      charge = Math.max(0, charge - dt * o.drainRate);
      return snapshot(charge > 0 ? 'draining' : 'idle');
    },
  };
}

const oneDecimal = (n) => (Math.round(n * 10) / 10).toFixed(1);

export function heldText(heldMs, holdMs) {
  const total = holdMs / 1000;
  // Rounded down, so the count never reads "3.0 of 3" before the ring has landed.
  const held = Math.floor(Math.min(heldMs, holdMs) / 100 + 1e-9) / 10;
  return `Held ${oneDecimal(Math.max(0, held))} of ${Number.isInteger(total) ? total : oneDecimal(total)} seconds`;
}

export const arcEnd = (progress) => -Math.PI / 2 + 2 * Math.PI * Math.min(1, Math.max(0, progress));

export const easeOut = (k) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 3;

export function starRadius(progress, cfg = CONFIG.hold.star) {
  return cfg.baseRadiusPx + cfg.growPx * easeOut(progress);
}

export function rimStarRadius(progress, cfg = CONFIG.hold.star) {
  return cfg.hudBaseRadiusPx + cfg.hudGrowPx * easeOut(progress);
}

export function smoothTowards(shown, goal, dtMs, tauMs = CONFIG.hold.star.smoothMs) {
  if (!Number.isFinite(shown)) return goal;
  return goal + (shown - goal) * Math.exp(-Math.max(0, dtMs) / tauMs);
}

const r3 = (n) => Math.round(n * 1000) / 1000;

export function starShape(look = 'held', cfg = CONFIG.hold.star) {
  // Eight corners for the plain star (point, valley, ...). "steady" lifts each diagonal
  // valley into a short ray with a small valley either side of it.
  const pts = [];
  const at = (deg, r) => pts.push([r3(r * Math.sin((deg * Math.PI) / 180)), r3(-r * Math.cos((deg * Math.PI) / 180))]);
  for (let i = 0; i < 4; i++) {
    const a = i * 90;
    at(a, 1);
    // Deep, narrow valleys beside each ray: at 24 px the shallower ones (0.8 at 17 degrees)
    // left rays 2 to 3 px long and "steady" read as "held" (review 2, finding 5).
    if (look === 'steady') { at(a + 31, cfg.innerFrac * 0.6); at(a + 45, cfg.rayFrac); at(a + 59, cfg.innerFrac * 0.6); } else at(a + 45, cfg.innerFrac);
  }
  return { d: `M${pts.map((p) => p.join(' ')).join('L')}Z`, points: pts, ring: look === 'recovered' ? cfg.ringScale : null };
}

// ---------------------------------------------------------------- browser: the drawings

export function drawKindleStar(ctx, { x, y, outer, fill, outline, glow, halo = 0, look = 'held', cfg = CONFIG.hold.star }) {
  if (!(outer > 0)) return;
  ctx.save();
  if (halo > 0.005) {
    // A soft halo from a few discs: no colour is written here, only the token passed in.
    ctx.fillStyle = glow;
    for (let i = 3; i >= 1; i--) {
      ctx.globalAlpha = halo / 3;
      ctx.beginPath();
      ctx.arc(x, y, (outer * cfg.haloScale * i) / 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  const shape = starShape(look, cfg);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  shape.points.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * outer, y + py * outer) : ctx.moveTo(x + px * outer, y + py * outer)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = outline;
  ctx.stroke();
  if (shape.ring) {
    ctx.lineWidth = cfg.ringWidthPx;
    ctx.beginPath();
    ctx.arc(x, y, outer * shape.ring, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawHoldRing(ctx, { x, y, radius, progress, track, fill, width, trackOpacity = CONFIG.hold.trackOpacity, thick = 1 }) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = track;
  ctx.globalAlpha = trackOpacity;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.stroke();
  if (progress > 0.001) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = fill;
    ctx.lineWidth = width * thick;
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2, arcEnd(progress));
    ctx.stroke();
  }
  ctx.restore();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createRimRing(noteRingEl) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'hold-rim');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  // pathLength 100 makes the dash maths a plain percentage, whatever size the ring is drawn.
  const circle = (cls) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of Object.entries({ cx: 50, cy: 50, r: 47.3, pathLength: 100, class: cls })) c.setAttribute(k, v);
    svg.append(c);
    return c;
  };
  circle('hold-rim-track');
  const fill = circle('hold-rim-fill');
  // The star: its own small SVG whose units are CSS pixels, centred on the rim's stroke at
  // 12 o'clock by app.css, above the rim. (Inside the ring's 100-unit box its size would
  // change with the ring's.)
  const starSvg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ class: 'hold-rim-star', viewBox: '-12 -12 24 24', width: 24, height: 24, 'aria-hidden': 'true' })) starSvg.setAttribute(k, v);
  const star = document.createElementNS(SVG_NS, 'path');
  star.setAttribute('d', starShape('held').d);
  star.setAttribute('vector-effect', 'non-scaling-stroke');
  starSvg.append(star);
  noteRingEl.classList.add('has-hold-rim');
  noteRingEl.append(svg, starSvg);
  let shown = -1;
  return {
    set(progress, { landed = false, star: showStar = true } = {}) {
      const r = showStar && progress > 0.001 ? rimStarRadius(progress) : 0;
      star.style.transform = `scale(${r.toFixed(2)})`;
      const pct = Math.round(1000 * Math.min(1, Math.max(0, progress))) / 10;
      if (pct !== shown) {
        shown = pct;
        fill.style.strokeDasharray = `${pct} 100`;
        // A zero-length dash with round caps would still paint a dot at 12 o'clock.
        fill.style.visibility = pct > 0.1 ? 'visible' : 'hidden';
      }
      svg.classList.toggle('is-landed', landed);
    },
    remove() { svg.remove(); starSvg.remove(); noteRingEl.classList.remove('has-hold-rim'); },
  };
}
