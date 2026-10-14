// portrait.js — the Sky portrait: the picture a finished voice check leaves behind, and its
// thumbnail (docs/design/specs/2026-10-12-voice-check-and-songs.md sections 4.6, 4.8, 4.9;
// sizes in config.voiceCheck.portrait). Height is pitch, as everywhere.
//
// The top half is PURE and imports in Node (tools/checks/voicecheck.check.mjs): where every
// mark goes. The bottom half only draws what the top half decided.
//
// CONTRACT — pure
//   MARK_SHAPES   the four states of a note, each a different SHAPE (never colour alone):
//                 star (on target) · ring-dot (missed: a ring at the note asked, joined to a
//                 dot where the voice went) · ring-8 (an octave away) · ring (not sung)
//   portraitLayout(portrait, width, height, { scale?, cfg? }) -> layout       CSS px, y down
//       portrait: a js/app/voicecheck.js Portrait. scale { low, high } (midi): the pitch
//       scale to draw on, for two portraits side by side; default the portrait's own range.
//       layout = { w, h, k (size against the full 960 px card), plot { x0, x1, top, bottom },
//         yOf(midi), horizons { low, high } (y), band { top, bottom },
//         dust: [{ x, y, r, a }]   seeded, the same every time, inside the band
//         home { x, y },
//         notes: [{ kind, x, y, y2?, dir? }]   left to right in the order sung. star: y is
//             the height really sung. Others: y is the note asked; ring-dot has y2, where the
//             voice went (kept on the card); ring-8 has dir -1 | 1.
//         figures: [{ points: [{ x, y, heard, on }], lines: [{ solid }] }]   six, at the
//             right; solid where the step went the right way, dotted where it did not }
//
// CONTRACT — browser
//   drawPortrait(ctx, layout, { colours, words?, t?, tonight?, dim? })
//       t: milliseconds into the finishing moment (default: finished). tonight: the newest
//       portrait's stars are gold; an earlier one's are plain. dim: 0..1 brightness.
//       words { plate, low, high }: the corner plate and the horizons' note names; left out
//       on a thumbnail.
//   mountPortrait(host, portrait, { words, calm?, play?, tonight?, dim?, scale?, thumb?, label?, config? })
//       -> { el (the canvas, role="img"), finished: Promise, redraw(), destroy() }
//       play: the finishing moment, once (about 2.5 s); calm: one 200 ms fade of the
//       finished picture instead. The canvas follows its host's width (16:9, at most 960 px).

import { CONFIG } from './config.js';
import { tuneSteps } from './voicecheck.js';

export const MARK_SHAPES = Object.freeze({
  star: 'filled star', 'ring-dot': 'hollow ring joined to a dot', 'ring-8': 'hollow ring with an 8 and an arrow', ring: 'hollow ring',
});

// Small seeded generator (mulberry32): the dust must be the same picture on every draw.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function portraitLayout(p, w, h, { scale = null, cfg = CONFIG.voiceCheck.portrait } = {}) {
  const k = w / cfg.maxWidthPx;
  const x0 = Math.max(4, 48 * k), x1 = w - Math.max(3, 14 * k), top = Math.max(6, 40 * k), bottom = h - Math.max(6, 40 * k);
  const lo = (scale ? scale.low : p.range.lowMidi) - cfg.padSemis, hi = (scale ? scale.high : p.range.highMidi) + cfg.padSemis;
  const yOf = (m) => top + ((hi - m) / (hi - lo)) * (bottom - top);
  const keep = (y) => Math.min(bottom - 2, Math.max(top + 2, y));
  const band = { top: yOf(p.range.comfortHigh), bottom: yOf(p.range.comfortLow) };
  const rnd = seeded(cfg.dustSeed);
  const dust = Array.from({ length: cfg.dust }, () => ({
    x: x0 + rnd() * (x1 - x0), y: band.top + rnd() * (band.bottom - band.top), r: (0.6 + rnd() * 0.9) * Math.max(0.6, k), a: 0.25 + rnd() * 0.45,
  }));
  // The ten notes take the left three fifths, after the home star's own column.
  const nx0 = x0 + (x1 - x0) * 0.07, nx1 = x0 + (x1 - x0) * 0.6;
  const each = p.notes.each, col = (nx1 - nx0) / Math.max(1, each.length);
  const notes = each.map((n, i) => {
    const x = nx0 + (i + 0.5) * col;
    if (n.on && n.sungMidi !== null) return { kind: 'star', x, y: yOf(n.sungMidi) };
    if (n.octave) return { kind: 'ring-8', x, y: yOf(n.midi), dir: n.octave };
    if (n.sungMidi === null) return { kind: 'ring', x, y: yOf(n.midi) };
    return { kind: 'ring-dot', x, y: yOf(n.midi), y2: keep(yOf(n.sungMidi)) };
  });
  const fx0 = x0 + (x1 - x0) * 0.64, fw = (x1 - fx0) / Math.max(1, p.tunes.each.length);
  const figures = p.tunes.each.map((t, i) => ({
    points: t.midis.map((m, j) => ({ x: fx0 + i * fw + fw * (0.14 + 0.24 * j), y: keep(yOf(t.sung[j] ?? m)), heard: t.sung[j] !== null && t.sung[j] !== undefined, on: !!t.on[j] })),
    lines: tuneSteps(t.midis, t.sung).map((s) => ({ solid: s.ok })),
  }));
  return {
    w, h, k, plot: { x0, x1, top, bottom }, yOf, horizons: { low: yOf(p.range.lowMidi), high: yOf(p.range.highMidi) }, band, dust,
    home: { x: x0 + (x1 - x0) * 0.03, y: yOf(p.easy.midi) }, notes, figures, split: (nx1 + fx0) / 2,
  };
}

// ---------------------------------------------------------------- browser: drawing

function starPath(ctx, x, y, outer) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? outer * 0.45 : outer, a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx[i ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a));
  }
  ctx.closePath();
}

const ease = (x) => { const c = Math.min(1, Math.max(0, x)); return 1 - (1 - c) ** 3; };

export function drawPortrait(ctx, L, { colours: C, words = null, t = Infinity, tonight = true, dim = 1, cfg = CONFIG.voiceCheck.portrait } = {}) {
  const { w, h, plot } = L, k = Math.max(0.3, L.k);
  const small = !words || w < 320;
  // Marks shrink more slowly than the card, so a half-width card (Compare) still reads.
  const mk = Math.max(0.42, k ** 0.6);
  // Under 520 px the picture keeps its note names, captions and plate; the side labels go
  // (the words beside the picture say them). No letter is drawn under 13 px.
  const roomy = !small && w >= 520;
  const labelPx = Math.max(13, 13 * k), font = `${labelPx}px ${C.font}`;
  const pale = !C.stageTop || C.stageTop === C.stage;   // Dawn: a flat, light sky
  // When each part of the finishing moment begins (ms): horizons, band, the ten stars one by
  // one, the six figures, the home star, the date.
  const tBand = cfg.horizonMs, tStars = tBand + cfg.bandMs, tFigs = tStars + L.notes.length * cfg.landGapMs + 120;
  const tHome = tFigs + L.figures.length * 110 + 100, tPlate = Math.min(cfg.finishMs - 200, tHome + 200);
  const at = (from, ms) => ease((t - from) / ms);
  const glow = (colour, px) => { ctx.shadowColor = colour; ctx.shadowBlur = px; };
  const noGlow = () => { ctx.shadowBlur = 0; };
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, C.stageTop || C.stage); sky.addColorStop(1, C.stage);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // The bright band: where the voice sits. A soft river of light with feathered edges (thin
  // strips, strongest in the middle), tinted with the accent, and its dust inside it.
  const bandK = at(tBand, cfg.bandMs);
  const bTop = L.band.top, bH = Math.max(1, L.band.bottom - L.band.top), feather = Math.min(bH * 0.5, 44 * mk);
  // One pixel row at a time (whole pixels, so no seams), from edge to edge of the card.
  const rowH = small ? 2 : 1, y0 = Math.floor(bTop - feather * 0.5), y1 = Math.ceil(bTop + bH + feather * 0.5);
  for (let y = y0; y < y1; y += rowH) {
    const edge = Math.min(y + rowH / 2 - y0, y1 - y - rowH / 2), f = Math.min(1, edge / (1.5 * feather)), bell = f * f * (3 - 2 * f);
    ctx.globalAlpha = (pale ? 0.13 : 0.17) * bell * bandK; ctx.fillStyle = C.accent;
    ctx.fillRect(0, y, w, rowH);
    ctx.globalAlpha = (pale ? 0.03 : 0.05) * bell * bandK; ctx.fillStyle = C.text;
    ctx.fillRect(0, y, w, rowH);
  }
  ctx.fillStyle = pale ? C.accent : C.text;
  if (!small && !pale) glow(C.accent, 6 * mk);
  for (const d of L.dust) { ctx.globalAlpha = Math.min(1, d.a * (pale ? 0.75 : 1.15)) * bandK; ctx.beginPath(); ctx.arc(d.x, d.y, d.r * (pale ? 1.1 : 1.25), 0, 2 * Math.PI); ctx.fill(); }
  noGlow();

  // The two horizons, drawn in from the left, each with its note name.
  const hk = at(0, cfg.horizonMs);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = C.lineStrong; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  for (const y of [L.horizons.high, L.horizons.low]) { ctx.beginPath(); ctx.moveTo(plot.x0, y); ctx.lineTo(plot.x0 + (plot.x1 - plot.x0) * hk, y); ctx.stroke(); }
  // A quiet divider between the ten notes and the six tunes.
  if (!small && L.figures.length) { ctx.globalAlpha = 0.55 * hk; ctx.setLineDash([1, 6]); ctx.beginPath(); ctx.moveTo(L.split, L.horizons.high + 6 * k); ctx.lineTo(L.split, L.horizons.low - 6 * k); ctx.stroke(); }
  ctx.setLineDash([]);
  if (!small) {
    ctx.globalAlpha = hk;
    ctx.fillStyle = C.muted; ctx.font = font; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(words.high, Math.max(4, 8 * k), L.horizons.high); ctx.fillText(words.low, Math.max(4, 8 * k), L.horizons.low);
    if (roomy) {
      // Close under the date plate, "top note" goes under its line instead of over it.
      const under = L.horizons.high - labelPx - 6 < Math.max(6, 12 * k) + Math.max(13, 14 * k) + 4;
      ctx.textAlign = 'right'; ctx.textBaseline = under ? 'top' : 'bottom';
      ctx.fillText('top note', plot.x1, L.horizons.high + (under ? 5 : -4));
      ctx.textBaseline = 'bottom'; ctx.fillText('lowest note', plot.x1, L.horizons.low - 4);
    }
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    const capY = Math.min(h - labelPx - 3, plot.bottom + 8 * k);
    ctx.fillText(roomy ? 'ten notes, in the order sung' : 'ten notes', L.notes.length ? L.notes[0].x - 10 * k : plot.x0, capY);
    if (L.figures.length) ctx.fillText(roomy ? 'six short tunes' : 'six tunes', L.split + 10 * k, capY);
  }

  const star = (x, y, r, gold, lit = true) => {
    starPath(ctx, x, y, r);
    if (lit && !small && (gold || !pale)) glow(gold ? C.gold : C.text, (pale ? 0.9 : 1.6) * r);
    ctx.fillStyle = gold ? C.goldFill : C.text; ctx.fill();
    noGlow();
    if (gold) { ctx.strokeStyle = C.gold; ctx.lineWidth = Math.max(1, 1.5 * mk); ctx.stroke(); }
  };
  const ring = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.strokeStyle = C.text; ctx.lineWidth = Math.max(1, 1.75 * mk); ctx.stroke(); };
  const R = { star: Math.max(3, (cfg.starPx / 2 + 3.5) * mk), ring: Math.max(2.2, (cfg.ringPx + 0.5) * mk), dot: Math.max(1.4, (cfg.dotPx / 2 + 0.5) * mk) };

  // The thread: the ten notes joined in the order sung, at the heights the voice really
  // went, so the night reads as one constellation. Faint; it grows as the stars land.
  const heard = L.notes.map((n, i) => ({ i, x: n.x, y: n.kind === 'star' ? n.y : n.kind === 'ring-dot' ? n.y2 : null })).filter((q) => q.y !== null);
  if (!small && heard.length > 1) {
    ctx.strokeStyle = tonight ? C.gold : C.text; ctx.lineWidth = Math.max(0.75, 1 * mk);
    for (let j = 1; j < heard.length; j++) {
      const p0 = heard[j - 1], p1 = heard[j], a = at(tStars + p1.i * cfg.landGapMs, 220);
      if (!(a > 0)) continue;
      ctx.globalAlpha = (pale ? 0.3 : 0.26) * a;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p0.x + (p1.x - p0.x) * a, p0.y + (p1.y - p0.y) * a); ctx.stroke();
    }
  }

  L.notes.forEach((n, i) => {
    const a = at(tStars + i * cfg.landGapMs, 220);
    if (!(a > 0)) return;
    ctx.globalAlpha = a;
    if (n.kind === 'star') { star(n.x, n.y, R.star * (0.6 + 0.4 * a), tonight); return; }
    ring(n.x, n.y, R.ring);
    if (n.kind === 'ring-dot') {
      ctx.setLineDash([2, 3]); ctx.lineWidth = Math.max(1, 1.25 * mk); ctx.strokeStyle = C.text;
      const s = Math.sign(n.y2 - n.y) || 1;
      if (Math.abs(n.y2 - n.y) > R.ring + R.dot) { ctx.beginPath(); ctx.moveTo(n.x, n.y + s * R.ring); ctx.lineTo(n.x, n.y2 - s * R.dot); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(n.x, n.y2, R.dot, 0, 2 * Math.PI); ctx.fillStyle = C.text; ctx.fill();
    } else if (n.kind === 'ring-8') {
      // "8" and an arrow: the right note, an octave that way. Up is higher.
      const s = n.dir > 0 ? -1 : 1, ax = n.x, ay = n.y + s * (R.ring + 3 * mk), len = Math.max(6, 10 * mk), wing = Math.max(2.5, 3.5 * mk);
      ctx.strokeStyle = C.text; ctx.lineWidth = Math.max(1, 1.75 * mk);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax, ay + s * len);
      ctx.moveTo(ax - wing, ay + s * (len - wing)); ctx.lineTo(ax, ay + s * len); ctx.lineTo(ax + wing, ay + s * (len - wing)); ctx.stroke();
      if (!small) { ctx.fillStyle = C.text; ctx.font = `600 ${labelPx}px ${C.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('8', n.x + R.ring + 4 * mk, n.y); }
    }
  });

  L.figures.forEach((f, i) => {
    const a = at(tFigs + i * 110, 260);
    if (!(a > 0)) return;
    ctx.globalAlpha = a;
    // Each little figure is drawn a touch narrower than its column, so six of them read as
    // six figures and not one zigzag.
    const cx = f.points.reduce((sum, pt) => sum + pt.x, 0) / Math.max(1, f.points.length);
    const pts = f.points.map((pt) => ({ ...pt, x: cx + (pt.x - cx) * 0.74 }));
    ctx.strokeStyle = C.text; ctx.lineWidth = Math.max(0.9, 1.3 * mk);
    f.lines.forEach((line, j) => {
      const p0 = pts[j], p1 = pts[j + 1];
      ctx.setLineDash(line.solid ? [] : [1.5, 3.5]);
      ctx.globalAlpha = a * (line.solid ? 0.7 : 1);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p0.x + (p1.x - p0.x) * a, p0.y + (p1.y - p0.y) * a); ctx.stroke();
    });
    ctx.setLineDash([]); ctx.globalAlpha = a;
    for (const pt of pts) {
      if (pt.on) star(pt.x, pt.y, Math.max(2.4, 5.5 * mk), tonight, false);
      else if (pt.heard) { ctx.beginPath(); ctx.arc(pt.x, pt.y, R.dot, 0, 2 * Math.PI); ctx.fillStyle = C.text; ctx.fill(); }
      else ring(pt.x, pt.y, Math.max(1.8, 3.5 * mk));
    }
  });

  // The home star: the easy note. Always gold, with a halo; it swells in last.
  const ha = at(tHome, 300);
  if (ha > 0) {
    const r = Math.max(3.5, (cfg.homePx / 2 + 4.5) * mk) * (0.5 + 0.5 * ha);
    ctx.fillStyle = C.gold;
    for (const [m, al] of [[2.6, 0.1], [1.9, 0.16], [1.35, 0.2]]) { ctx.globalAlpha = al * ha; ctx.beginPath(); ctx.arc(L.home.x, L.home.y, r * m, 0, 2 * Math.PI); ctx.fill(); }
    ctx.globalAlpha = ha;
    star(L.home.x, L.home.y, r, true);
    if (roomy) { ctx.fillStyle = C.muted; ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('home star', Math.max(4, L.home.x - r), L.home.y + r * 1.9 + 2); }
  }
  if (!small) {
    ctx.globalAlpha = at(tPlate, 200);
    ctx.fillStyle = C.muted; ctx.font = `${Math.max(13, 14 * k)}px ${C.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(words.plate, plot.x1, Math.max(6, 12 * k));
  }
  // An earlier portrait stands back: the page colour laid over it.
  if (dim < 1) { ctx.globalAlpha = 1 - dim; ctx.fillStyle = C.stage; ctx.fillRect(0, 0, w, h); }
  ctx.restore();
}

// Every colour is a token (css/tokens.css): no raw colour value lives in this file.
function coloursOf(el) {
  const cs = getComputedStyle(el), v = (n) => cs.getPropertyValue(n).trim();
  return {
    stage: v('--stage'), stageTop: v('--stage-top') || v('--stage'), text: v('--text'), muted: v('--muted'),
    lineStrong: v('--line-strong'), accent: v('--accent'), gold: v('--gold'), goldFill: v('--gold-fill'), font: v('--font-ui') || 'system-ui, sans-serif',
  };
}

export function mountPortrait(host, portrait, {
  words = null, calm = false, play = false, tonight = true, dim = 1, scale = null, thumb = false, label = '', config = CONFIG,
} = {}) {
  const P = config.voiceCheck.portrait;
  const canvas = document.createElement('canvas');
  canvas.className = thumb ? 'portrait portrait-thumb' : 'portrait';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label || (words && words.label) || 'Sky portrait');
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  let raf = 0, dead = false, startedAt = null, done = !play || calm, finish = () => {};
  const finished = new Promise((r) => { finish = r; });

  function draw(t = Infinity) {
    const cssW = thumb ? P.thumbW : Math.min(P.maxWidthPx, Math.max(160, Math.round(host.clientWidth || P.maxWidthPx)));
    const cssH = thumb ? P.thumbH : Math.round((cssW * 9) / 16);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPortrait(ctx, portraitLayout(portrait, cssW, cssH, { scale, cfg: P }), { colours: coloursOf(canvas), words: thumb ? null : words, t, tonight, dim, cfg: P });
    canvas.dataset.drawn = t === Infinity || t >= P.finishMs ? 'done' : 'playing';
  }
  function frame(now) {
    if (dead) return;
    if (startedAt === null) startedAt = now;
    const t = now - startedAt;
    draw(t);
    if (t < P.finishMs) raf = requestAnimationFrame(frame); else { done = true; finish(); }
  }
  // A window made wider or narrower, or the theme changed: the finished picture again.
  const ro = typeof ResizeObserver === 'function' && !thumb ? new ResizeObserver(() => { if (done && !dead) draw(); }) : null;
  if (ro) ro.observe(host);

  if (play && !calm) raf = requestAnimationFrame(frame);
  else {
    draw();
    // Calm motion: one fade of the finished picture (the class is in css/voicecheck.css).
    if (play) canvas.classList.add('portrait-fade');
    finish();
  }
  return {
    el: canvas, finished, redraw: () => { if (done) draw(); },
    destroy() { dead = true; cancelAnimationFrame(raf); if (ro) ro.disconnect(); finish(); canvas.remove(); },
  };
}
