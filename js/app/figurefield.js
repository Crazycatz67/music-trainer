// figurefield.js — the still star field of "Sing a constellation": one canvas that draws a
// figure's stars at their note heights, the singer's voice as a dot in the target star's
// column, and the thread a hold reels out from the last star
// (docs/design/specs/2026-10-12-sing-a-constellation.md sections 5, 5.1, 5.2, 5.3, 11).
// It takes the place of the scrolling pitch stage and does not scroll.
//
// It only DRAWS what it is told: where things go is js/app/figures.js (fieldLayout,
// threadPoints), the ring and the kindling star are js/app/holdring.js, the sparks are
// js/app/rewards.js. Browser only.
//
// CONTRACT — createFigureField(host, { config? }) -> field
//   field.el      <div class="stage figure-field">  (the stage's box, so its size, border and
//                 the paused dimming come from css/app.css)       field.canvas
//   field.set(patch)        any of:
//       name, degrees: [1..8], midis: [per star], closing: [[i, j]]
//       lit: [boolean], looks: [look | null], lines: [[cents] | null], solid: [boolean]
//       target: star index | null     the star being sung (ring, kindling star, voice column)
//       progress: 0..1                the hold ring's fill = the thread's length
//       thread: [cents | null]        the thread so far (figures.js createThread().values())
//       paused: boolean, calm: boolean, noteStyle: 'letters' | 'solfege', label: string
//       done: boolean                 true: the finishing moment (config constellation.finish):
//                                     lanes, note names and numbers fade, the closing lines
//                                     come, the stars swell in order, the name sets in gold
//                                     inside the field. Set while the loop is off (a figure
//                                     opened whole): the finished picture at once.
//       doneTail: string              the words after the name there ("is in your sky.")
//       clear: { x, y, w, h } | null  a box in field pixels that the tag and the edge chip
//                                     keep out of (the octave chip laid over the field)
//   field.voice(v | null)   v = { voiced, midi, kind: 'in' | 'close' | 'off', cents, tag, level? }
//                           one reading of the voice; null = nothing live (the dot goes).
//                           level (js/mic.js rms) sizes the aurora; without it the curtain
//                           has one middle height
//   The aurora (js/app/aurora.js; living-sky spec 6.3): the same curtain as the pitch stage,
//   on the voice's short tail, at most aurora.fieldCapPx tall, drawn under the stars. It
//   follows <html data-aurora> (the Settings switch); set({ aurora: boolean }) overrides.
//   field.land(index, { tier = 'note', look })   the star just lit: the thread settles into
//                           the constellation line and one burst is drawn (none under calm,
//                           none within rewards.burstMinGapMs of the last)
//   field.burst(index, { tier, look }) -> boolean   a burst alone (the figure's own reward)
//   field.light(index | null)   "Hear the shape": that star's outline brightens (eased)
//   field.start() / stop()  the animation loop; it also stops by itself while the tab is
//                           hidden or the field is off screen.      field.render()
//   field.debug() -> { running, width, height, pxPerNote, stars: [{ x, y, lit }], target,
//                      thread: { points, endFrac, endX } | null, dot: { x, y, kind, shown },
//                      tail, tether: 'close' | 'off' | null, out: 'high' | 'low' | null,
//                      tag (its words), tagShown (as drawn: "↑ 40 low"), sparks, bursts,
//                      closing: [0..1], lights: [0..1], chart: 0..1 (lanes, names, numbers),
//                      nameAlpha: 0..1, nameBox: { x, y, w, h } | null, sky: stars drawn,
//                      aurora: { cols, maxHeightPx, sprites: [index], k: 0..1 shown } }
//   field.destroy()
//
// Nothing here is larger than 48 x 48 px and changes quickly: the things that move are a dot,
// a thin tail, a thin thread, the ring and the star inside it (spec section 11). The sky
// behind (gradient, background stars) is still and is drawn once to an off-screen canvas;
// the finishing moment only fades (600 ms) and swells a star by 3 px (review 3, finding 1).

import { auroraSprites, createCurtain, drawCurtain, follow, levelToLv } from './aurora.js';
import { CONFIG } from './config.js';
import { fieldLayout, threadPoints } from './figures.js';
import { drawHoldRing, drawKindleStar, smoothTowards, starRadius, starShape } from './holdring.js';
import { burstAllowed, celebrationPlan, makeSparks, sparkAt } from './rewards.js';
import { h, ICONS } from './shell.js';
import { displayNote, numberText } from './stage.js';

const SOLFEGE = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Ti', 'Do'];
const easeOut = (k) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 3;
const clamp01 = (k) => Math.min(1, Math.max(0, k));
const smooth = (k) => { const c = clamp01(k); return c * c * (3 - 2 * c); };
const HEX = /^#([0-9a-f]{6})$/i;
// A round glow of one token colour: opaque colour first, then its strength cut out with a
// second pass that only carries opacity. (A gradient from a colour to "transparent" runs
// through grey on the way, which showed as a dirty ring on Dawn.) stops: [[0..1, opacity]].
const opacityOnly = (a) => `color-mix(in srgb, black ${Math.round(a * 1000) / 10}%, transparent)`;
function glowSprite(colour, sizePx, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(2, Math.ceil(sizePx));
  const g = c.getContext('2d'), r = c.width / 2;
  g.fillStyle = colour;
  g.fillRect(0, 0, c.width, c.height);
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, a] of stops) grad.addColorStop(at, opacityOnly(a));
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}
const lightness = (c) => { const m = HEX.exec(c); if (!m) return null; const n = parseInt(m[1], 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
const hashOf = (text) => { let a = 2166136261; for (const ch of String(text)) { a ^= ch.codePointAt(0); a = Math.imul(a, 16777619); } return a >>> 0; };
const randomFrom = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export function createFigureField(host, { config = CONFIG } = {}) {
  const F = config.constellation, H = config.hold, R = config.rewards, AU = config.aurora;
  const X = F.finish, SKY = F.sky;
  // This field's own ring and kindling star: larger than the pitch stage's head ring, so
  // the 12 px hollow star sits clear inside it.
  const RING = F.ringRadiusPx || H.headRadiusPx;
  const KINDLE = { ...H.star, growPx: F.kindleGrowPx || H.star.growPx };
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Star figure.', tabindex: '0' });
  const root = h('div', { class: 'stage figure-field', dataset: { state: 'idle' } }, canvas);
  host.append(root);
  const ctx = canvas.getContext('2d');
  const speaker = new Path2D(ICONS.speaker);

  const st = {
    name: '', degrees: [], midis: [], closing: [], lit: [], looks: [], lines: [], solid: [],
    target: null, progress: 0, thread: [], paused: false, calm: false, noteStyle: 'letters', label: '', done: false,
    doneTail: '', clear: null, aurora: null,
  };
  // The aurora on the voice's tail. Its last columns are kept so they can ease out with the
  // dot when the voice stops, instead of being there one frame and gone the next.
  const curtain = createCurtain(AU, config.stage);
  let sprites = null, spritesCalm = null, auroraK = 0, lvNow = null, voiceT = null;
  let width = 0, height = 0, dpr = 1, tokens = null;
  let raf = 0, wanted = false, visible = true, dead = false, lastMs = 0;
  let voice = null, lastY = null, tail = [];
  let settle = null;                 // { line, atMs }: the thread turning into the settled line
  let ringGone = null;               // { index, atMs }: the full ring easing away after a landing
  let bursts = [], lastBurstMs = null, seed = 20261012;
  let lights = [], lightGoal = null, starShown = 0, starAtMs = 0;
  // The finishing moment runs on the clock, not on frames: doneAtMs is when the figure was
  // finished (-Infinity: shown whole at once), leftAtMs when "Sing it again" took it back.
  let doneAtMs = null, leftAtMs = -Infinity, left = { chart: 1, name: 0 }, fin = { chart: 1, name: 0, t: null };
  let busyUntilMs = 0;               // the loop outlives stop() until the moment has played out
  let mark = null, tagAlpha = 0, tagY = 0;     // the last dot and tag drawn, easing out; the tag's ease in
  let sky = null, skyDone = null, skyKey = '', skyCount = 0, haloSprite = null, haloKey = '';
  let dbg = {};

  function readTokens() {
    const cs = getComputedStyle(root);
    const g = (n) => cs.getPropertyValue(n).trim();
    tokens = {
      stage: g('--stage'), stageTop: g('--stage-top'), surface: g('--surface'), text: g('--text'), muted: g('--muted'),
      quiet: g('--quiet'), line: g('--line'), lineStrong: g('--line-strong'), accent: g('--accent'),
      good: g('--good'), close: g('--close'), off: g('--off'), target: g('--target'),
      gold: g('--gold'), goldFill: g('--gold-fill'), aGoldGlow: parseFloat(g('--a-gold-glow')) || 0.3,
      font: g('--font-ui') || 'system-ui',
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    };
    // Dawn is a paper sky: its marks are darker than the field, Dusk's are lighter.
    tokens.light = (lightness(tokens.stage) ?? (document.documentElement.dataset.tone === 'light' ? 1 : 0)) > 0.5;
    tokens.aurora = { good: g('--aurora-in') || tokens.good, close: g('--aurora-close') || tokens.close, off: g('--aurora-off') || tokens.off, core: g('--voice-core'), low: g('--aurora-low'), mid: g('--aurora-mid'), high: g('--aurora-high'), crown: g('--aurora-crown') };
    tokens.auroraPeak = parseFloat(g('--aurora-peak')) || 1;
    skyKey = ''; haloKey = '';
    buildSprites();
  }
  // Painted on a theme, size or calm change, never from inside a frame's drawing.
  function buildSprites() {
    spritesCalm = !!st.calm;
    sprites = tokens && tokens.aurora.low && tokens.aurora.crown ? auroraSprites({ colours: tokens.aurora, dpr, calm: spritesCalm, light: tokens.light }, AU) : null;
    // A cold first paint takes a few frames: a still picture is drawn again when it is done.
    const painted = sprites;
    if (painted && !painted.ready) painted.whenReady.then(() => { if (sprites === painted && !raf) render(); });
  }
  const auroraWanted = () => (st.aurora ?? document.documentElement.dataset.aurora !== 'off');

  // ---- the sky: the gradient, a soft depth behind the figure and the quiet stars. Still,
  // so it costs one drawImage a frame however long the microphone listens.
  function buildSky(L) {
    const key = [canvas.width, canvas.height, st.name, st.midis.join(',')].join('|');
    if (key === skyKey && sky) return;
    skyKey = key;
    const layer = () => {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [c, g];
    };
    const [a, ga] = layer(), [b, gb] = layer();
    const grad = ga.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, tokens.stageTop);
    grad.addColorStop(1, tokens.stage);
    ga.fillStyle = grad;
    ga.fillRect(0, 0, width, height);
    const cx = L.plotX + L.plotW / 2, cy = height / 2, reach = Math.max(width * 0.5, height * 0.8);
    const depth = tokens.light ? 0.05 : 0.1;
    ga.drawImage(glowSprite(tokens.light ? tokens.goldFill : tokens.accent, 256, [[0, depth], [0.5, depth * 0.45], [1, 0]]), cx - reach, cy - reach, 2 * reach, 2 * reach);
    const rnd = randomFrom(hashOf(st.name) ^ 20261012);
    const ink = tokens.light ? tokens.muted : tokens.text;
    const scatter = (g, count, minA, maxA, minR, maxR) => {
      let made = 0;
      for (let tries = 0; made < count && tries < count * 4; tries++) {
        const x = L.plotX + 6 + rnd() * Math.max(1, L.plotW - 12), y = 6 + rnd() * Math.max(1, height - 12);
        const r = minR + rnd() * (maxR - minR), alpha = minA + rnd() * (maxA - minA);
        if (L.x.some((sx, i) => Math.hypot(sx - x, L.y[i] - y) < SKY.clearPx)) continue;
        g.globalAlpha = alpha;
        g.fillStyle = ink;
        g.beginPath();
        g.arc(x, y, r, 0, 2 * Math.PI);
        g.fill();
        made++;
      }
      return made;
    };
    // Spec 1b: 1 to 1.5 px dots; Dusk 10 to 28 % of --text, Dawn about 12 % of --muted.
    skyCount = tokens.light ? scatter(ga, SKY.count, 0.14, 0.3, 0.6, 0.95) : scatter(ga, SKY.count, 0.12, 0.34, 0.5, 0.8);
    // The stars that come out when the figure is finished: a little brighter, a few larger.
    if (tokens.light) scatter(gb, SKY.doneCount, 0.18, 0.4, 0.6, 1.2); else scatter(gb, SKY.doneCount, 0.14, 0.42, 0.5, 1.1);
    sky = a; skyDone = b;
  }

  function buildHalo() {
    const key = `${dpr}|${tokens.goldFill}|${tokens.light}`;
    if (key === haloKey && haloSprite) return;
    haloKey = key;
    // On paper a wide faint glow reads as a smudge: Dawn's is warmer at the centre and
    // ends sooner. Dusk's runs the whole radius.
    const k = F.haloAlpha * (tokens.light ? 1.6 : 1.2);
    haloSprite = glowSprite(tokens.goldFill, 2 * F.haloRadiusPx * dpr, tokens.light ? [[0, k], [0.3, k * 0.5], [0.62, 0], [1, 0]] : [[0, k], [0.4, k * 0.42], [1, 0]]);
  }

  function halo(x, y, alpha, scale = 1) {
    if (!(alpha > 0.01) || !haloSprite) return;
    const r = F.haloRadiusPx * scale;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(haloSprite, x - r, y - r, 2 * r, 2 * r);
    ctx.restore();
  }

  // Where the finishing moment is now. chart: lanes, note names and star numbers (1 = shown).
  function finishAt(now) {
    if (doneAtMs !== null) {
      const t = now - doneAtMs;
      return st.calm
        ? { t, chart: 1 - smooth(t / X.calmFadeMs), name: smooth(t / X.calmFadeMs) }
        : { t, chart: 1 - smooth(t / X.chartFadeMs), name: smooth((t - X.nameDelayMs) / X.nameFadeMs) };
    }
    const k = smooth((now - leftAtMs) / (st.calm ? X.calmFadeMs : X.backMs));
    return { t: null, chart: left.chart + (1 - left.chart) * k, name: left.name * (1 - k) };
  }
  const finishLastsMs = () => (st.calm ? X.calmFadeMs : Math.max(
    X.nameDelayMs + X.nameFadeMs,
    X.closingDelayMs + Math.max(0, st.midis.length - 1) * X.swellStepMs + X.swellMs,
    X.closingDelayMs + st.closing.length * F.closingStepMs + F.closingFadeMs,
  )) + 80;

  function resize() {
    const r = root.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    const ratio = Math.min(config.stage.dprCap, window.devicePixelRatio || 1);
    if (ratio !== dpr) { dpr = ratio; if (tokens) buildSprites(); }
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    render();
  }

  const colourOf = (kind) => (kind === 'in' ? tokens.good : kind === 'close' ? tokens.close : tokens.off);
  const font = (weight, px) => `${weight} ${px}px ${tokens.font}`;

  function pill(text, x, y, colour, align = 'left', alpha = 1) {
    ctx.font = font(600, 14);
    const w = ctx.measureText(text).width + 16, hgt = 24;
    // Kept inside the field: a tag beside the last star would otherwise run off the edge.
    // 8 px clear of every edge (review 3, finding 2).
    let left = Math.min(width - w - 8, Math.max(8, align === 'center' ? x - w / 2 : x));
    y = Math.min(height - 8 - hgt / 2, Math.max(8 + hgt / 2, y));
    // The octave chip is laid over the field's corner: a tag or edge chip that would land
    // under it is drawn just clear of it instead: beside it when there is room (it stays
    // at its own height, off the star's ring), else below it.
    const c = st.clear;
    if (c && left < c.x + c.w + 6 && left + w > c.x - 6 && y - hgt / 2 < c.y + c.h + 6 && y + hgt / 2 > c.y - 6) {
      if (c.x + c.w + 8 + w <= width - 8) left = c.x + c.w + 8;
      else y = c.y + c.h / 2 < height / 2 ? c.y + c.h + 6 + hgt / 2 : c.y - 6 - hgt / 2;
    }
    ctx.globalAlpha = 0.92 * alpha;
    ctx.fillStyle = tokens.surface;
    ctx.beginPath();
    ctx.roundRect(left, y - hgt / 2, w, hgt, hgt / 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour || tokens.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, left + 8, y + 0.5);
    ctx.globalAlpha = 1;
  }

  function voiceDot(x, y, colour, inTune, alpha = 1) {
    ctx.save();
    if (inTune) {
      ctx.globalAlpha = 0.25 * alpha;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, F.dotRadiusPx + 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, F.dotRadiusPx, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  function path(points) {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  }

  function hollowStar(x, y, r, colour, alpha = 1) {
    const shape = starShape('held', H.star);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    shape.points.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * r, y + py * r) : ctx.moveTo(x + px * r, y + py * r)));
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colour;
    ctx.stroke();
    ctx.restore();
  }

  // An arrowhead or chevron at (x, y) pointing up (dir -1) or down (dir 1).
  function chevron(x, y, dir, size = 5) {
    ctx.beginPath();
    ctx.moveTo(x - size, y - dir * size);
    ctx.lineTo(x, y);
    ctx.lineTo(x + size, y - dir * size);
    ctx.stroke();
  }

  function drawLines(L, now) {
    const n = st.midis.length;
    const star = (i) => ({ x: L.x[i], y: L.y[i] });
    for (let i = 0; i < n - 1; i++) {
      const a = star(i), b = star(i + 1), rec = st.lines[i];
      const reeling = st.target === i + 1 && !st.lit[i + 1];
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Clamped at 0: a frame's own clock can read a moment BEFORE the landing that was
      // noted during it, and an opacity above 1 is ignored by the canvas, so the thread
      // was drawn for one frame at whatever opacity came before (a one-frame dip).
      const settling = settle && settle.line === i ? clamp01((now - settle.atMs) / F.settleMs) : 1;
      if (!rec || reeling || settling < 1 || !st.solid[i]) {
        // The dotted guide: the line not yet drawn, and what shows again when a thread goes
        // back. A line to or from a star still hollow keeps its waver but stays dotted.
        const pts = rec && !reeling ? threadPoints({ from: a, to: b, cents: rec, progress: 1, pxPerNote: L.pxPerNote }) : [a, b];
        ctx.globalAlpha = 0.6 * (rec && st.solid[i] ? 1 - settling : 1);
        ctx.strokeStyle = tokens.lineStrong;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([1, 6]);
        path(pts);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (rec && !reeling) {
        const pts = threadPoints({ from: a, to: b, cents: rec, progress: 1, pxPerNote: L.pxPerNote });
        if (settling < 1) {
          // The thick green thread thins and hands over to the constellation line.
          ctx.strokeStyle = tokens.good;
          ctx.globalAlpha = 0.22 * (1 - settling);     // its glow goes with it, not before it
          ctx.lineWidth = 11;
          path(pts);
          ctx.stroke();
          ctx.globalAlpha = 1 - settling;
          ctx.lineWidth = 5 - 3 * settling;
          path(pts);
          ctx.stroke();
        }
        if (st.solid[i]) {
          // A soft wide stroke under the line: the same trick as the thread's glow, no blur.
          ctx.globalAlpha = F.lineGlowAlpha * settling;
          ctx.strokeStyle = tokens.goldFill;
          ctx.lineWidth = F.lineGlowPx;
          path(pts);
          ctx.stroke();
          ctx.globalAlpha = settling;
          ctx.strokeStyle = tokens.gold;
          ctx.lineWidth = 2;
          path(pts);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    if (settle && now - settle.atMs >= F.settleMs) settle = null;
  }

  function drawClosing(L, now) {
    const shown = [];
    if (doneAtMs === null) { dbg.closing = shown; return; }
    st.closing.forEach(([i, j], k) => {
      // One after another; under calm motion they are simply there, with one short fade.
      const a = Math.min(1, Math.max(0, (now - doneAtMs - (st.calm ? 0 : X.closingDelayMs + k * F.closingStepMs)) / F.closingFadeMs));
      shown.push(a);
      if (!(a > 0) || !(i < L.x.length && j < L.x.length)) return;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.globalAlpha = F.lineGlowAlpha * a;
      ctx.strokeStyle = tokens.goldFill;
      ctx.lineWidth = F.lineGlowPx;
      ctx.beginPath();
      ctx.moveTo(L.x[i], L.y[i]);
      ctx.lineTo(L.x[j], L.y[j]);
      ctx.stroke();
      ctx.globalAlpha = 0.7 * a;
      ctx.strokeStyle = tokens.gold;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    });
    dbg.closing = shown;
  }

  function drawThread(L) {
    dbg.thread = null;
    const t = st.target;
    if (t === null || t < 1 || st.lit[t] || !(st.progress > 0.001)) return;
    const pts = threadPoints({ from: { x: L.x[t - 1], y: L.y[t - 1] }, to: { x: L.x[t], y: L.y[t] }, cents: st.thread, progress: st.progress, pxPerNote: L.pxPerNote });
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = tokens.good;
    // The soft glow of the in-tune line: a wider, faint copy under it (no blur to pay for).
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 11;
    path(pts);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 5;
    path(pts);
    ctx.stroke();
    ctx.restore();
    const end = pts[pts.length - 1];
    dbg.thread = { points: pts.length, endFrac: end.f, endX: end.x, endY: end.y, maxOff: Math.max(...pts.map((p) => Math.abs(p.y - (L.y[t - 1] + (L.y[t] - L.y[t - 1]) * p.f)))) };
  }

  function drawStars(L, now, dt) {
    const n = st.midis.length;
    ctx.font = font(500, 13);
    for (let i = 0; i < n; i++) {
      const x = L.x[i], y = L.y[i];
      const goal = lightGoal === i ? 1 : 0;
      lights[i] = Math.min(1, Math.max(0, (lights[i] || 0) + Math.sign(goal - (lights[i] || 0)) * (wanted ? dt / F.lightMs : 1)));
      if (Math.abs(goal - lights[i]) < 0.02) lights[i] = goal;
      const glow = lights[i];
      // Swelling (never under calm motion): while its note sounds, and once, in order,
      // when the figure is finished.
      let swell = 0;
      if (!st.calm) {
        swell = F.lightSwellPx * glow;
        if (fin.t !== null && st.lit[i]) {
          const k = (fin.t - X.closingDelayMs - i * X.swellStepMs) / X.swellMs;
          if (k > 0 && k < 1) swell = Math.max(swell, X.swellPx * Math.sin(Math.PI * k));
        }
      }
      let radius = (st.lit[i] ? F.litRadiusPx : F.starRadiusPx) + swell;
      if (st.lit[i]) {
        // Just lit: it grows out of the star that kindled in the ring, and its halo comes
        // with it (an eased 320 ms, not a jump from 14 to 15 px with a glow switched on).
        const landK = ringGone && ringGone.index === i ? smooth((now - ringGone.atMs) / F.settleMs) : 1;
        radius -= (1 - landK) * (F.litRadiusPx - starRadius(1, KINDLE));
        halo(x, y, landK, 1 + swell / F.litRadiusPx);
        // The kindling star's own glow hands over to the halo instead of going at once.
        drawKindleStar(ctx, {
          x, y, outer: radius, fill: tokens.goldFill, outline: tokens.gold, glow: tokens.goldFill,
          halo: st.calm ? 0 : Math.max(tokens.aGoldGlow * glow, tokens.aGoldGlow * H.star.haloOpacity * (1 - landK)), look: st.looks[i] || 'held', cfg: H.star,
        });
      } else {
        hollowStar(x, y, radius, tokens.lineStrong);
      }
      // Its note is sounding: the outline brightens, and a small speaker sits above it, so
      // the sign is a shape as well as a change of colour.
      if (glow > 0.01) {
        hollowStar(x, y, radius, tokens.text, glow);
        ctx.save();
        ctx.globalAlpha = glow;
        ctx.translate(x - 8, y - RING - 26);
        ctx.scale(16 / 24, 16 / 24);
        ctx.strokeStyle = tokens.text;
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(speaker);
        ctx.restore();
      }
      // Its number. Not on the star being sung (the ring marks it, and the voice's dot
      // would sit on the number: review 3, finding 4); gone with the lanes once finished.
      if (fin.chart > 0.01 && !(st.target === i && !st.lit[i])) {
        ctx.globalAlpha = fin.chart;
        ctx.fillStyle = tokens.muted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(st.noteStyle === 'solfege' ? SOLFEGE[(st.degrees[i] || 1) - 1] : String(i + 1), x, y + RING + 14);
        ctx.globalAlpha = 1;
      }
    }
    dbg.lights = lights.slice(0, n).map((v) => Number(v.toFixed(2)));
  }

  function drawRing(L, now) {
    const t = st.target;
    let goal = 0;
    if (t !== null && t < L.x.length) {
      const x = L.x[t], y = L.y[t];
      // Only a star that is lit lets its ring go: a fresh take on the same star starts whole.
      const gone = !st.lit[t] ? 0 : ringGone && ringGone.index === t ? clamp01((now - ringGone.atMs) / F.ringGoneMs) : 1;
      if (!st.lit[t]) {
        drawHoldRing(ctx, {
          x, y, radius: RING, progress: st.progress, track: tokens.target, fill: tokens.good,
          width: H.headWidthPx, trackOpacity: H.trackOpacity,
        });
      } else if (gone < 1) {
        // The full ring eases away, drawn here: drawHoldRing paints its fill at full
        // strength whatever the opacity around it, so the ring used to stay whole for
        // 320 ms and then go in one frame (the largest single-frame change on the field).
        ctx.save();
        ctx.globalAlpha = 1 - smooth(gone);
        ctx.strokeStyle = tokens.good;
        ctx.lineWidth = H.headWidthPx;
        ctx.beginPath();
        ctx.arc(x, y, RING, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
      }
      if (!st.lit[t]) {
        goal = st.progress > 0.001 ? starRadius(st.progress, KINDLE) : 0;
        starShown = smoothTowards(starShown, goal, now - starAtMs, H.star.smoothMs);
        if (starShown >= 0.5) {
          drawKindleStar(ctx, {
            // The glow is the fill gold in both themes: Dawn's outline gold is a dark amber,
            // and a dark glow on paper is a smudge.
            x, y, outer: starShown, fill: tokens.goldFill, outline: tokens.gold, glow: tokens.goldFill,
            halo: st.calm ? 0 : tokens.aGoldGlow * H.star.haloOpacity * st.progress, cfg: H.star,
          });
        }
      }
    }
    if (!goal) starShown = 0;
    starAtMs = now;
    dbg.star = Number(starShown.toFixed(2));
  }

  // The dot itself is always where the voice is, at once. Its tag eases in, and when the
  // voice stops or the star lands the dot and tag ease out where they were, instead of
  // being there on one frame and gone on the next (the field's largest quick change).
  // The curtain rises from the voice's tail, under the stars, the ring and the dot. The tail
  // is short here (tailMs), so it is full for fieldTrailFullMs and gone by the tail's end.
  function drawAurora(L, now, dt) {
    dbg.aurora = { cols: 0, maxHeightPx: 0, sprites: [], k: 0 };
    if (!sprites || !auroraWanted()) { auroraK = 0; return; }
    const t = st.target;
    const live = !!voice && voice.voiced && t !== null && t < L.x.length && !st.lit[t] && tail.length > 1;
    if (live) {
      const y = L.yOfMidi(voice.midi);
      if (y >= 10 && y <= height - 10) {
        curtain.build(tail, {
          now: tail[tail.length - 1].t, pxPerSec: F.tailPxPerSec, nowX: L.x[t], yOfMidi: L.yOfMidi, topY: 0, xMin: L.plotX,
          calm: !!st.calm, light: tokens.light, capPx: AU.fieldCapPx, peakCap: tokens.auroraPeak, swayT: now / 1000, shimmerT: now / 1000, snap: dpr,
          trailFullMs: AU.fieldTrailFullMs, trailEndMs: F.tailMs,
        });
        auroraK = 1;
      } else auroraK = Math.max(0, auroraK - (wanted ? dt / F.tagFadeMs : 1));
    } else auroraK = Math.max(0, auroraK - (wanted ? dt / F.tagFadeMs : 1));
    if (!(auroraK > 0)) return;
    const c = curtain.cols, shown = new Set();
    for (let i = 0; i < c.n; i++) if (c.a[i] > 0) shown.add(c.sprite[i]);
    dbg.aurora = { cols: drawCurtain(ctx, c, sprites, smooth(auroraK)), maxHeightPx: Number(c.maxH.toFixed(1)), sprites: [...shown].sort(), k: Number(auroraK.toFixed(2)) };
  }

  function drawVoice(L, now, dt) {
    const step = wanted ? dt / F.tagFadeMs : 1;
    if (voiceNow(L, now, step)) return;
    if (!mark) return;
    mark.alpha -= step;
    if (!(mark.alpha > 0)) { mark = null; tagAlpha = 0; return; }
    voiceDot(mark.x, mark.y, mark.colour, mark.inTune, smooth(mark.alpha));
    if (mark.text) pill(mark.text, mark.x + RING + 8, mark.tagY, tokens.text, 'left', smooth(Math.min(tagAlpha, mark.alpha)));
  }

  function voiceNow(L, now, step) {
    dbg.dot = { shown: false }; dbg.tether = null; dbg.out = null; dbg.tag = ''; dbg.tail = 0;
    const t = st.target;
    if (!voice || t === null || t >= L.x.length || st.lit[t]) return false;
    const x = L.x[t], ty = L.y[t];
    if (!voice.voiced) {
      // Listening: a hollow ring where the voice last was, with the one slow breathing loop.
      if (lastY === null) return false;
      if (lastY < 10 || lastY > height - 10) {
        // The voice was last out of the field: a bare ring on the border read as a stray
        // mark (review 3, finding 8). The word says it instead, at that edge.
        pill('Listening', x, lastY < 10 ? 18 : height - 18, tokens.quiet, 'center');
        dbg.dot = { shown: true, x, y: lastY, kind: 'listening', edge: true };
        return false;
      }
      ctx.save();
      ctx.globalAlpha = st.calm || !wanted ? 0.85 : 0.85 + 0.15 * Math.sin((now / 2400) * 2 * Math.PI);
      ctx.strokeStyle = tokens.quiet;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, Math.min(height - 10, Math.max(10, lastY)), F.dotRadiusPx, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
      dbg.dot = { shown: true, x, y: lastY, kind: 'listening' };
      return false;
    }
    const y = L.yOfMidi(voice.midi), colour = colourOf(voice.kind);
    lastY = y;
    if (y < 10 || y > height - 10) {
      // Out of the field: a chip pinned to that edge. The arrow is the way the voice should
      // move, never the way it is off.
      const high = y < 10;
      dbg.out = high ? 'high' : 'low';
      const text = `${high ? '↓' : '↑'} ${numberText(voice.cents, config.verdict)}`;
      pill(text, x, high ? 18 : height - 18, tokens.text, 'center');
      return false;
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // The tether: what is left between the voice and the star. None when in tune.
    const gap = ty - y, dir = Math.sign(gap), len = Math.abs(gap) - RING - 2;
    if (voice.kind !== 'in' && len > 4) {
      const y0 = y + dir * (F.dotRadiusPx + 2), y1 = ty - dir * (RING + 2);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 3;
      if (voice.kind === 'off') ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2.5;
      if (voice.kind === 'close') chevron(x, y1, dir, 6);
      else {
        const every = config.stage.chevronEveryPx, count = Math.max(1, Math.floor(Math.abs(y1 - y0) / every));
        for (let k = 1; k <= count; k++) chevron(x + 9, y0 + dir * (Math.abs(y1 - y0) * k) / (count + 1), dir, 4);
      }
      dbg.tether = voice.kind;
    } else if (voice.kind === 'close') {
      // Already at the ring: no room for a line. The arrow in the tag says which way to go
      // (a lone arrowhead beside the dot read as a kink in the tail: review 3, finding 4).
      dbg.tether = 'close';
    }
    // The tail: which way the voice is moving. Not under calm motion.
    if (!st.calm && tail.length > 1) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      let drawn = 0;
      for (let i = 1; i < tail.length; i++) {
        const a = tail[i - 1], b = tail[i];
        const ageA = now - a.ms, ageB = now - b.ms;
        if (ageA > F.tailMs) continue;
        const xa = x - Math.min(F.tailMaxPx, (ageA * F.tailPxPerSec) / 1000), xb = x - Math.min(F.tailMaxPx, (ageB * F.tailPxPerSec) / 1000);
        ctx.globalAlpha = 0.7 * (1 - ageA / F.tailMs);
        ctx.beginPath();
        ctx.moveTo(xa, a.y);
        ctx.lineTo(xb, b.y);
        ctx.stroke();
        drawn++;
      }
      dbg.tail = drawn;
    }
    ctx.restore();
    voiceDot(x, y, colour, voice.kind === 'in');
    // The tag carries the way to move as well as how far: "↑ 40 low", "↓ 30 high".
    const arrow = voice.kind !== 'in' && dir && /\b(low|high)$/.test(voice.tag || '') ? (dir > 0 ? '↓ ' : '↑ ') : '';
    // The tag follows the dot a moment behind (the dot itself never lags): at this scale a
    // wavering voice moves 20 px either way, and words that shake with it cannot be read.
    tagY = tagAlpha > 0 && wanted ? smoothTowards(tagY, y, step * F.tagFadeMs, F.tagFollowMs) : y;
    tagAlpha = voice.tag ? Math.min(1, tagAlpha + step) : 0;
    if (voice.tag) pill(arrow + voice.tag, x + RING + 8, tagY, tokens.text, 'left', smooth(tagAlpha));
    mark = { x, y, tagY, colour, inTune: voice.kind === 'in', text: voice.tag ? arrow + voice.tag : '', alpha: 1 };
    dbg.dot = { shown: true, x, y, kind: voice.kind };
    dbg.tag = voice.tag || '';
    dbg.tagShown = voice.tag ? arrow + voice.tag : '';
    return true;
  }

  function drawBursts(now) {
    bursts = bursts.filter((b) => now - b.t0 < R.burstMs + (b.rings - 1) * 150);
    let sparks = 0;
    for (const b of bursts) {
      const colour = tokens[b.colour] || tokens.good;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.lineWidth = 2;
      for (let i = 0; i < b.rings; i++) {
        const k = (now - b.t0 - i * 150) / R.burstMs;
        if (k < 0 || k >= 1) continue;
        // Eased in over its first tenth as well as out: a ring that is simply there on
        // one frame is the pop the eye catches.
        ctx.globalAlpha = F.burstRingAlpha * (1 - k) * Math.min(1, k / 0.1);
        ctx.beginPath();
        ctx.arc(b.x, b.y, RING + R.ringGrowPx * easeOut(k), 0, 2 * Math.PI);
        ctx.stroke();
      }
      const k = (now - b.t0) / R.burstMs;
      if (k < 1) {
        for (const s of b.sparks) {
          const p = sparkAt(s, k);
          ctx.globalAlpha = p.alpha;
          ctx.beginPath();
          ctx.arc(b.x + p.dx * R.sparkReachPx, b.y + p.dy * R.sparkReachPx, R.sparkSizePx * s.size, 0, 2 * Math.PI);
          ctx.fill();
          sparks++;
        }
      }
      ctx.restore();
    }
    dbg.sparks = sparks;
    dbg.bursts = bursts.length;
  }

  // A small light that runs along the singer's own lines, star to star, just ahead of the
  // swelling: the figure is drawn once more, by the line that made it. Not under calm.
  function drawGlint(L) {
    if (st.calm || fin.t === null) return;
    const u = (fin.t - X.closingDelayMs) / X.swellStepMs, n = st.midis.length;
    if (!(u > 0) || u >= n - 1) return;
    const i = Math.floor(u), f = u - i, a = { x: L.x[i], y: L.y[i] }, b = { x: L.x[i + 1], y: L.y[i + 1] };
    const pts = st.lines[i] && f > 0.02 ? threadPoints({ from: a, to: b, cents: st.lines[i], progress: f, pxPerNote: L.pxPerNote }) : null;
    const p = pts ? pts[pts.length - 1] : { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    // It rises and sets at the two ends, so it never appears or goes at once.
    const edge = Math.min(1, u / 0.5, (n - 1 - u) / 0.5);
    halo(p.x, p.y, 0.9 * edge, 0.42);
    ctx.save();
    ctx.globalAlpha = edge;
    ctx.fillStyle = tokens.light ? tokens.gold : tokens.text;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  // The finished figure's name, set in gold inside the field, with the words after it.
  function drawName(L) {
    dbg.nameAlpha = Number(fin.name.toFixed(2)); dbg.nameBox = null;
    if (!(fin.name > 0.005) || !st.name) return;
    const scale = tokens.rem / 16;
    let big = (height < 380 ? 22 : 28) * scale;
    const tail = st.doneTail || '';
    const measure = () => {
      const small = Math.min(16 * scale, big * 0.72);
      ctx.font = font(700, big);
      const wName = ctx.measureText(st.name).width;
      ctx.font = font(400, small);
      const wTail = tail ? ctx.measureText(tail).width : 0;
      return { small, wName, wTail, gap: tail ? big * 0.32 : 0 };
    };
    let m = measure();
    if (m.wName + m.gap + m.wTail > width - 32) { big = 18 * scale; m = measure(); }
    const total = m.wName + m.gap + m.wTail;
    const x0 = Math.min(width - total - 16, Math.max(16, L.plotX + L.plotW / 2 - total / 2));
    // Under the figure; over it when a star in the way sits lower than the words would.
    const edge = Math.max(22, 0.06 * height) + big * 0.1, near = F.litRadiusPx + 6;
    const inWay = (yc) => L.x.some((sx, i) => sx > x0 - near && sx < x0 + total + near && Math.abs(L.y[i] - yc) < near + big / 2);
    let yc = height - edge;
    if (inWay(yc) && !inWay(edge)) yc = edge;
    ctx.save();
    ctx.globalAlpha = fin.name;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const base = yc + big * 0.34;
    ctx.font = font(700, big);
    ctx.fillStyle = tokens.gold;
    ctx.fillText(st.name, x0, base);
    if (tail) {
      ctx.font = font(400, m.small);
      ctx.fillStyle = tokens.text;
      ctx.fillText(tail, x0 + m.wName + m.gap, base);
    }
    ctx.restore();
    dbg.nameBox = { x: Math.round(x0), y: Math.round(yc - big / 2), w: Math.round(total), h: Math.round(big) };
  }

  function render(ms = performance.now()) {
    if (dead) return;
    if (!tokens) readTokens();
    const dt = Math.min(100, Math.max(0, ms - lastMs));
    lastMs = ms;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dbg = { running: !!raf, width, height, target: st.target };
    if (!st.midis.length) {
      const plain = ctx.createLinearGradient(0, 0, 0, height);
      plain.addColorStop(0, tokens.stageTop);
      plain.addColorStop(1, tokens.stage);
      ctx.fillStyle = plain;
      ctx.fillRect(0, 0, width, height);
      return;
    }
    const L = fieldLayout({ width, height, midis: st.midis, gutter: config.stage.gutterPx, cfg: F });
    fin = finishAt(ms);
    buildSky(L);
    buildHalo();
    ctx.drawImage(sky, 0, 0, width, height);
    // More stars come out as the chart goes: the finished figure hangs in a fuller sky.
    if (fin.chart < 0.99) {
      ctx.globalAlpha = 1 - fin.chart;
      ctx.drawImage(skyDone, 0, 0, width, height);
      ctx.globalAlpha = 1;
    }
    dbg.pxPerNote = L.pxPerNote;
    dbg.stars = st.midis.map((_, i) => ({ x: L.x[i], y: L.y[i], lit: !!st.lit[i] }));
    dbg.chart = Number(fin.chart.toFixed(2));
    dbg.sky = skyCount;
    // One faint lane per pitch of the figure, named in the gutter: the chart under the sky,
    // at half the strength of the pitch stage's lanes, and gone once the figure is finished.
    if (fin.chart > 0.01) {
      ctx.font = font(500, 13);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const midi of L.lanes) {
        const y = Math.round(L.yOfMidi(midi)) + 0.5;
        ctx.globalAlpha = SKY.laneAlpha * fin.chart;
        ctx.strokeStyle = tokens.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(L.plotX, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.globalAlpha = fin.chart;
        ctx.fillStyle = tokens.quiet;
        ctx.fillText(displayNote(midi, st.noteStyle).text, L.plotX - 8, y);
      }
      ctx.globalAlpha = 1;
    }
    drawAurora(L, ms, dt);
    drawLines(L, ms);
    drawClosing(L, ms);
    drawThread(L);
    drawStars(L, ms, dt);
    drawGlint(L);
    drawRing(L, ms);
    drawVoice(L, ms, dt);
    drawBursts(ms);
    drawName(L);
  }

  // ---- the loop: runs only while wanted, the tab is showing and the field is on screen
  // (and, after stop(), for as long as the finishing moment or its undoing still plays)
  const busy = () => performance.now() < busyUntilMs;
  const loop = (ms) => {
    raf = 0;
    if (!(wanted || busy()) || document.hidden || !visible) return;
    render(ms);
    raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (raf || !(wanted || busy()) || document.hidden || !visible || dead) return;
    lastMs = performance.now();
    raf = requestAnimationFrame(loop);
  };
  const halt = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  // Shown again: the clock-driven moment may have ended unseen, so draw where it is now.
  const onVisibility = () => { if (document.hidden) halt(); else { kick(); if (!raf) render(); } };
  const onTheme = () => { readTokens(); render(); };
  document.addEventListener('visibilitychange', onVisibility);
  const onAurora = () => { if (!raf) render(); };
  document.addEventListener('mt:theme', onTheme);
  document.addEventListener('mt:aurora', onAurora);
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  const io = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) { kick(); if (!raf) render(); } else halt();
  });
  io.observe(root);
  resize();

  function burst(index, { tier = 'note', look = null } = {}) {
    const now = performance.now();
    if (dead || st.calm || !burstAllowed(lastBurstMs, now, R) || !dbg.stars || !dbg.stars[index]) return false;
    lastBurstMs = now;
    const plan = celebrationPlan(tier, 1, R, look);
    // Gold, the star's own colour, whatever the tier: green stays the word for "in tune",
    // and the pale ring was nearly invisible on Dawn (review 3, finding 10).
    bursts.push({ x: dbg.stars[index].x, y: dbg.stars[index].y, t0: now, sparks: makeSparks(plan.sparks, seed++), rings: plan.rings, colour: 'gold' });
    kick();
    return true;
  }

  return {
    el: root, canvas,
    set(patch = {}) {
      const before = st.target, wasDone = st.done;
      Object.assign(st, patch);
      if (tokens && !!st.calm !== spritesCalm) buildSprites();
      if ('paused' in patch) root.dataset.state = st.paused ? 'paused' : 'idle';
      if ('label' in patch && canvas.getAttribute('aria-label') !== st.label) canvas.setAttribute('aria-label', st.label);
      if ('target' in patch && st.target !== before) { tail = []; lastY = null; voice = null; starShown = 0; mark = null; tagAlpha = 0; auroraK = 0; curtain.cols.n = 0; }
      if ('done' in patch && !!st.done !== !!wasDone) {
        const now = performance.now();
        if (st.done) {
          // Finished while the field is live: the moment plays. Opened already whole (the
          // loop is off): the finished picture at once, nothing to watch.
          doneAtMs = wanted ? now : -Infinity;
          if (wanted) busyUntilMs = now + finishLastsMs();
        } else {
          left = { chart: fin.chart, name: fin.name };
          doneAtMs = null; leftAtMs = now;
          busyUntilMs = now + (st.calm ? X.calmFadeMs : X.backMs) + 80;
        }
        kick();
      }
      if (!raf) render();
    },
    voice(v) {
      voice = v;
      if (v && v.voiced && dbg.pxPerNote && st.midis.length) {
        const now = performance.now();
        const L = fieldLayout({ width, height, midis: st.midis, gutter: config.stage.gutterPx, cfg: F });
        // t, midi, kind, lv and grow are the aurora's (createCurtain's points): the curtain is
        // as tall as the reading was loud, and grows with this star's hold ring.
        const t = now / 1000;
        if (Number.isFinite(v.level)) lvNow = follow(lvNow, levelToLv(v.level, AU), voiceT === null ? 0 : t - voiceT, AU.lvSmoothMs);
        voiceT = t;
        tail.push({ ms: now, y: L.yOfMidi(v.midi), t, midi: v.midi, kind: v.kind, lv: Number.isFinite(v.level) ? lvNow : AU.calmLv, grow: st.progress });
        while (tail.length && now - tail[0].ms > F.tailMs) tail.shift();
      } else if (!v) { tail = []; lastY = null; }
      if (!raf) render();
    },
    land(index, { tier = 'note', look = null } = {}) {
      const now = performance.now();
      if (index > 0) settle = { line: index - 1, atMs: now };
      ringGone = { index, atMs: now };
      voice = null; tail = [];
      burst(index, { tier, look });
      kick();
    },
    burst,
    light(index) { lightGoal = index; if (!raf) render(); },
    start() { wanted = true; kick(); },
    stop() { wanted = false; if (!busy()) halt(); render(); },
    render,
    debug: () => ({ ...dbg, running: !!raf }),
    destroy() {
      dead = true;
      halt();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('mt:theme', onTheme);
      document.removeEventListener('mt:aurora', onAurora);
      root.remove();
    },
  };
}
