// aurora.js — the aurora voice line: a soft curtain of light that rises from the pitch line
// (docs/design/specs/2026-10-12-living-sky.md section 6). Shared by the scrolling stage
// (js/app/stage.js) and the constellation field (js/app/figurefield.js).
//
// The curtain adds no judgement: it takes the verdict each trail point already carries
// ('in' | 'close' | 'off' | 'free') and turns it into a SHAPE (tall with rays, low and smooth,
// short tufts). The colour only agrees with the line. The line, its dashes and the words are
// untouched and stay the reading; with the curtain off nothing is lost.
//
// It draws while the microphone is judged, so it is cheap on purpose: the textures (rays with
// soft tips, the bright lower edge, the fainter veil behind, the colour that climbs from the
// verdict colour through teal to violet) are painted once into sprites, and a frame is at most a few hundred drawImage calls of one
// narrow column each. No array, gradient or image data is made per frame.
//
// CONTRACT
// Pure (imports in Node):
//   SPRITE = { in: 0, close: 1, off: 2, free: 3 }   sprite index; free steps are 3 .. 3 + freeSteps - 1
//   levelToLv(rms, cfg?) -> 0..1          loudness (js/mic.js onLevel rms) on the spec's dB scale
//   follow(prev | null, target, dtSec, tauMs) -> number     one-pole smoothing; null starts at target
//   kindLook(kind, { calm?, light? }, cfg?) -> { id, sprite, factor, peak, rays, tufts } | null
//                                          null: no curtain (listening, silence, unknown)
//   curtainHeight(lv, factor, cfg?) -> CSS px          birthK(ageSec, cfg?) -> 0..1
//   trailK(ageSec, fullMs, endMs) -> 1..0              swayPx(tSec, cfg?) -> px
//   rayNoise(u, cfg?) -> 0..1             smooth, seeded, wraps at cfg.spriteWPx
//   tuftMask(u, cfg?) -> 0..1             the off texture: tuftOnPx on, tuftOffPx off, soft edges
//   isLightColour('#rrggbb') -> boolean | null         Dawn's stage is light, Dusk's dark
//   createCurtain(cfg?, stageCfg?) -> { cols, build(points, opts) -> n }
//       points: [{ t (seconds), midi | null, kind, lv?, grow?, hue? }] oldest first (lv, grow,
//               hue are 0..1; a point without lv counts as cfg.calmLv)
//       opts:   { now (s), pxPerSec, nowX (px of `now`), yOfMidi(midi) -> px, topY = 0,
//                 xMin = -Infinity (columns wholly left of it are not drawn),
//                 tAfter = -Infinity, tUpTo = Infinity (only points in (tAfter, tUpTo]),
//                 calm, light, colPx = cfg.colPx, capPx = Infinity, peakCap = 1,
//                 tall = 1 (every height times this, before capPx: a taller stage),
//                 outK = 1 (a fade the caller applies as alpha; see endFadeMs),
//                 swayT = 0 (s), shimmerT (s; left out: no shimmer), trailFullMs, trailEndMs,
//                 snap = 1 (device pixels per CSS px) }
//       cols:   { n, w, x, y, h, a, sx, sprite, maxH } typed arrays, REUSED by every build.
//               Column i is the sprite's strip [sx, sx + w) drawn at (x, y - h) sized w x h with
//               alpha a (0 = not drawn). y is the line; the curtain rises above it.
//       A stretch that ended before `now` fades out over cfg.endFadeMs (the light is the voice).
//       No curtain on a leap connector, across a gap, or on a run too short to be a line (a
//       dot): the same rules as stage.js voicePieces.
//   createAuroraGuard(cfg?) -> { frame(stageMs, nowMs), drop(nowMs), state(nowMs) -> { tier, colPx, gain }, reset() }
//       tier 0: colPx columns. 1: wideColPx columns. 2: off for the visit. A step fades out
//       over stepFadeMs and (tier 1) back in; never a cut. sharedGuard is the page's own.
// Browser:
//   auroraSprites({ colours: { good, close, off, low, mid, high, crown, core? }, dpr, calm, light }, cfg?)
//       good / close / off are the LIGHT of each verdict (--aurora-in and so on); core is the
//       hot colour at the foot of the curtain (--voice-core)
//       -> { canvases: [canvas], scale, srcH, key, paintMs, paintTotalMs, slices, ready, whenReady }
//       painted once per key, then cached. A cold first paint is spread over a few frames
//       (cfg.paintSliceMs each): the canvases are clear until painted, `ready` turns true and
//       `whenReady` resolves when the last is done. paintMs is the longest slice, the most one
//       frame was held; paintTotalMs the sum.
//   drawCurtain(g, cols, sprites, alpha = 1) -> columns drawn

import { CONFIG } from './config.js';

const A = CONFIG.aurora;
const clamp01 = (k) => Math.min(1, Math.max(0, k));
const smooth01 = (k) => { const c = clamp01(k); return c * c * (3 - 2 * c); };
const mod = (v, m) => ((v % m) + m) % m;

export const SPRITE = Object.freeze({ in: 0, close: 1, off: 2, free: 3 });

// ---------------------------------------------------------------- pure: the numbers

export function levelToLv(level, cfg = A) {
  if (!(level > 0)) return 0;
  return clamp01((20 * Math.log10(level) - cfg.lvFloorDb) / (cfg.lvFullDb - cfg.lvFloorDb));
}

export function follow(prev, target, dtSec, tauMs) {
  if (prev === null || prev === undefined || !Number.isFinite(prev)) return target;
  if (!(dtSec > 0) || !(tauMs > 0)) return prev;
  return prev + (target - prev) * (1 - Math.exp((-dtSec * 1000) / tauMs));
}

const lookTables = new WeakMap();
function lookTable(calm, light, cfg) {
  let byCfg = lookTables.get(cfg);
  if (!byCfg) { byCfg = {}; lookTables.set(cfg, byCfg); }
  const key = `${calm ? 'c' : 'm'}${light ? 'l' : 'd'}`;
  if (!byCfg[key]) {
    const peaks = cfg.peak[light ? 'dawn' : 'dusk'], t = {};
    for (const id of Object.keys(cfg.looks)) {
      const l = cfg.looks[id];
      // Calm motion: the smooth sheet for every state (spec 6.6). Height still tells them apart.
      t[id] = Object.freeze({ id, sprite: SPRITE[id], factor: l.factor, peak: peaks[id], rays: !calm && l.rays, tufts: !calm && l.tufts });
    }
    byCfg[key] = Object.freeze(t);
  }
  return byCfg[key];
}

export function kindLook(kind, { calm = false, light = false } = {}, cfg = A) {
  return lookTable(calm, light, cfg)[kind] || null;
}

export const curtainHeight = (lv, factor, cfg = A) => (cfg.heightMinPx + cfg.heightSpanPx * clamp01(lv)) * factor;
export const birthK = (ageSec, cfg = A) => smooth01((ageSec * 1000) / cfg.birthMs);
export const trailK = (ageSec, fullMs = A.trailFullMs, endMs = A.trailEndMs) => 1 - smooth01((ageSec * 1000 - fullMs) / (endMs - fullMs));
export const swayPx = (tSec, cfg = A) => cfg.swayPx * Math.sin((2 * Math.PI * tSec) / cfg.swayPeriodSec);

export function isLightColour(colour) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(colour || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.5;
}

// Rays: a few whole waves across the sprite, so the pattern wraps and no feature is narrower
// than minPx. Phases and strengths are seeded: the same curtain on every load. Three patterns
// are kept: 'ray' (the fine rays), 'top' (how tall each ray stands) and 'veil' (the broad
// curtain behind).
const noiseTables = new WeakMap();
function noiseTable(cfg, which = 'ray') {
  let byCfg = noiseTables.get(cfg);
  if (!byCfg) { byCfg = {}; noiseTables.set(cfg, byCfg); }
  if (byCfg[which]) return byCfg[which];
  const W = cfg.spriteWPx;
  const minPx = which === 'top' ? cfg.rayTopMinPx : which === 'veil' ? cfg.veilMinPx : cfg.rayMinPx;
  let s = (cfg.raySeed + (which === 'top' ? 7919 : which === 'veil' ? 104729 : 0)) >>> 0;
  const rnd = () => {                       // mulberry32, as stage.js starField
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // A wave of k cycles has features W / (2k) wide: from about twice minPx down to minPx.
  const kMax = Math.max(2, Math.floor(W / (2 * minPx))), kMin = Math.max(1, Math.ceil(kMax / 2));
  const waves = [];
  for (let k = kMin; k <= kMax; k++) waves.push({ k, phase: rnd() * 2 * Math.PI, amp: 0.5 + rnd() * 0.5 });
  const table = new Float32Array(W);
  let lo = Infinity, hi = -Infinity;
  for (let u = 0; u < W; u++) {
    let v = 0;
    for (const w of waves) v += w.amp * Math.sin((2 * Math.PI * w.k * u) / W + w.phase);
    table[u] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (let u = 0; u < W; u++) table[u] = (table[u] - lo) / (hi - lo || 1);
  byCfg[which] = table;
  return table;
}

function softNoise(u, which, cfg = A) {
  const table = noiseTable(cfg, which), W = cfg.spriteWPx;
  const x = mod(u, W), i = Math.floor(x), f = x - i;
  return clamp01(table[i] + (table[(i + 1) % W] - table[i]) * f);
}

export const rayNoise = (u, cfg = A) => softNoise(u, 'ray', cfg);

// The off texture. u is pixels of time (t * pxPerSec), the same axis the off line's dashes
// use (stage.js: lineDashOffset = t0 * pxPerSec mod 13), so a tuft stands on every dash.
export function tuftMask(u, cfg = A) {
  const P = cfg.tuftOnPx + cfg.tuftOffPx, half = cfg.tuftSoftPx / 2;
  const x = mod(u, P);
  const edge = (d) => (half > 0 ? clamp01(0.5 + d / (2 * half)) : d >= 0 ? 1 : 0);
  // Rising at 0 (and at P, which is the next 0), falling at tuftOnPx.
  return Math.max(Math.min(edge(x), edge(cfg.tuftOnPx - x)), edge(x - P)) || 0;
}

// ---------------------------------------------------------------- pure: the columns

export function createCurtain(cfg = A, stageCfg = CONFIG.stage) {
  const N = cfg.maxCols;
  const cols = {
    n: 0, w: cfg.colPx, maxH: 0,
    x: new Float32Array(N), y: new Float32Array(N), h: new Float32Array(N), a: new Float32Array(N),
    sx: new Float32Array(N), sprite: new Uint8Array(N),
  };
  // Scratch, also reused: the unsmoothed height and alpha, and each column's birth and fade.
  const h0 = new Float32Array(N), a0 = new Float32Array(N), born = new Float32Array(N), env = new Float32Array(N);
  const halfWin = Math.max(0, Math.floor((cfg.heightSmoothCols - 1) / 2));

  function build(points, o) {
    const now = o.now, pps = o.pxPerSec, colPx = o.colPx || cfg.colPx, snap = o.snap || 1;
    const calm = !!o.calm, table = lookTable(calm, !!o.light, cfg);
    const tAfter = o.tAfter ?? -Infinity, tUpTo = o.tUpTo ?? Infinity;
    // Calm motion's trail is short (calmTrailEndMs), so it starts to fade sooner too: an end
    // that is a slope, never a wall.
    const fullMs = calm ? Math.min(cfg.calmTrailFullMs, o.trailFullMs ?? Infinity) : o.trailFullMs ?? cfg.trailFullMs;
    const endMs = Math.max(fullMs + 1, calm ? Math.min(cfg.calmTrailEndMs, o.trailEndMs ?? Infinity) : o.trailEndMs ?? cfg.trailEndMs);
    const maxAge = endMs / 1000, colSec = colPx / pps;
    const tall = o.calm ? 1 : o.tall ?? 1;                // calm motion: one height per verdict
    const topY = o.topY ?? 0, xMin = o.xMin ?? -Infinity, capPx = o.capPx ?? Infinity, peakCap = o.peakCap ?? 1;
    // Columns stand at fixed times, so the pattern travels with the line and never crawls.
    // One shared whole-pixel offset keeps neighbours edge to edge (no seams between them).
    const off = Math.round((o.nowX - now * pps) * snap) / snap;
    const sway = calm ? 0 : Math.round(swayPx(o.swayT || 0, cfg) * snap) / snap;
    const W = cfg.spriteWPx, steps = cfg.freeSteps;
    // Shimmer: a slow wave of brightness that travels along the ribbon. It is tied to the
    // screen, not to the line, so a place on the stage brightens and dims over seconds. It
    // only ever dims (the crest is the look's own peak). None under calm motion.
    const shimOn = !calm && Number.isFinite(o.shimmerT) && cfg.shimmerDepth > 0;
    const shimK = (2 * Math.PI) / cfg.shimmerPx, shimAt = shimOn ? (2 * Math.PI * o.shimmerT) / cfg.shimmerPeriodSec : 0;
    let n = 0, maxH = 0;
    cols.w = colPx;

    const emit = (a, b) => {
      const ta = points[a].t, tb = points[b].t;
      if (tb - ta < stageCfg.dotRunSec) return;           // a dot is not a line: no curtain
      // A stretch the voice has left (a leap, a breath) gives up its light over endFadeMs.
      // o.outK: a fade the caller is already applying as alpha (the stage's long-slide fade).
      // The two never multiply: the stretch shows the lower of them, so it fades at one speed.
      const endRaw = now > tb && cfg.endFadeMs > 0 ? 1 - ((now - tb) * 1000) / cfg.endFadeMs : 1;
      if (!(endRaw > 0)) return;
      const outK = o.outK ?? 1, endK = outK > 0 && outK < 1 ? Math.min(1, endRaw / outK) : endRaw;
      const n0 = n;
      let m = a, prevStep = -1;
      for (let k = Math.ceil(ta / colSec - 0.5); n < N; k++) {
        const t = (k + 0.5) * colSec;
        if (t > tb) break;
        const age = now - t;
        if (t < ta || age > maxAge) continue;
        if (age < 0) break;
        while (m < b - 1 && points[m + 1].t <= t) m++;
        const p = points[m], q = points[Math.min(b, m + 1)];
        const f = q.t > p.t ? clamp01((t - p.t) / (q.t - p.t)) : 0;
        const src = f < 0.5 ? p : q, look = table[src.kind];
        if (!look) continue;
        const lv = calm ? cfg.calmLv : (p.lv ?? cfg.calmLv) + ((q.lv ?? cfg.calmLv) - (p.lv ?? cfg.calmLv)) * f;
        const grow = calm || look.id !== 'in' ? 0 : (p.grow || 0) + ((q.grow || 0) - (p.grow || 0)) * f;
        h0[n] = curtainHeight(lv, look.factor * (1 + cfg.holdGrow * clamp01(grow)), cfg) * tall;
        a0[n] = Math.min(look.peak, peakCap) * (cfg.alphaBase + (1 - cfg.alphaBase) * clamp01(lv));
        // The same soft edge at both ends of a stretch as at the head: where the voice stopped
        // or leapt, the curtain tapers instead of ending in a full-height wall that then
        // slides through the picture. (Not in the spec; it made no difference to any lab's
        // flash number, it only looks softer.)
        born[n] = birthK(Math.min(age, tb - t, t - ta), cfg);
        env[n] = born[n] * trailK(age, fullMs, endMs) * endK;
        cols.x[n] = off + k * colPx;
        cols.y[n] = o.yOfMidi(p.midi + (q.midi - p.midi) * f);
        if (look.id === 'free') {
          let step = Math.round(clamp01(src.hue ?? 0.5) * (steps - 1));
          // Neighbouring columns never differ by more than one step of hue.
          if (prevStep >= 0) step = Math.min(prevStep + 1, Math.max(prevStep - 1, step));
          prevStep = step;
          cols.sprite[n] = SPRITE.free + step;
        } else {
          prevStep = -1;
          cols.sprite[n] = look.sprite;
        }
        // Rays drift; tufts stay in step with the dashes.
        cols.sx[n] = mod(k * colPx + (look.rays ? sway : 0), W);
        n++;
      }
      // Average over neighbours so a change of verdict slopes instead of stepping.
      for (let i = n0; i < n; i++) {
        const from = Math.max(n0, i - halfWin), to = Math.min(n - 1, i + halfWin);
        let hs = 0, as = 0;
        for (let j = from; j <= to; j++) { hs += h0[j]; as += a0[j]; }
        const count = to - from + 1;
        const hh = Math.min((hs / count) * born[i], capPx, cols.y[i] - topY);
        const shown = hh >= cfg.drawMinPx && cols.x[i] + colPx > xMin;
        cols.h[i] = shown ? hh : 0;
        cols.a[i] = !shown ? 0 : shimOn
          ? (as / count) * env[i] * (1 - cfg.shimmerDepth * (0.5 - 0.5 * Math.cos(cols.x[i] * shimK - shimAt)))
          : (as / count) * env[i];
        if (shown && hh > maxH) maxH = hh;
      }
    };

    // Start a little before the oldest column that can still show, so a piece cut by the
    // window is not mistaken for a dot.
    let i = points.length;
    const tMin = now - maxAge - 4 * stageCfg.maxJoinGapSec;
    while (i > 0 && points[i - 1].t >= tMin) i--;
    let a = -1;
    for (let j = i; j <= points.length; j++) {
      const p = j < points.length ? points[j] : null;
      const ok = !!p && Number.isFinite(p.midi) && p.t > tAfter && p.t <= tUpTo;
      const joined = ok && a >= 0 && p.t - points[j - 1].t <= stageCfg.maxJoinGapSec
        && Math.abs(p.midi - points[j - 1].midi) <= stageCfg.leapSemis;
      if (a >= 0 && !joined) { emit(a, j - 1); a = -1; }
      if (ok && a < 0) a = j;
    }
    cols.n = n;
    cols.maxH = maxH;
    return n;
  }

  return { cols, build };
}

// ---------------------------------------------------------------- pure: the guard

export function createAuroraGuard(cfg = A) {
  let tier = 0, slow = 0, step = null;
  const out = { tier: 0, colPx: cfg.colPx, gain: 1 };
  const trip = (nowMs) => { step = { atMs: nowMs, to: tier + 1 }; slow = 0; };
  return {
    // One stage frame's time. Counted only while no step is fading.
    frame(stageMs, nowMs) {
      if (tier >= 2 || step) return;
      slow = stageMs > cfg.slowFrameMs ? slow + 1 : 0;
      if (slow >= cfg.slowFrames) trip(nowMs);
    },
    // A microphone reading was dropped: step down at once.
    drop(nowMs) { if (tier < 2 && !step) trip(nowMs); },
    state(nowMs) {
      let gain = tier >= 2 ? 0 : 1;
      if (step) {
        const k = (nowMs - step.atMs) / cfg.stepFadeMs;
        if (k < 1) gain = 1 - Math.max(0, k);
        else {
          tier = step.to;
          if (tier >= 2 || k >= 2) { step = null; gain = tier >= 2 ? 0 : 1; } else gain = k - 1;
        }
      }
      out.tier = tier;
      out.colPx = tier >= 1 ? cfg.wideColPx : cfg.colPx;
      out.gain = gain;
      return out;
    },
    reset() { tier = 0; slow = 0; step = null; },
  };
}

// "Off for the rest of the visit": one guard for the page, whichever screen is showing.
export const sharedGuard = createAuroraGuard(A);

// ---------------------------------------------------------------- browser: the sprites

// A colour token as numbers. The browser resolves it (any CSS colour works). Done once per
// paint, never in the drawing loop.
let inkCtx = null;
function rgbOf(colour) {
  if (!inkCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    inkCtx = c.getContext('2d', { willReadFrequently: true });
  }
  inkCtx.clearRect(0, 0, 1, 1);
  inkCtx.fillStyle = colour;
  inkCtx.fillRect(0, 0, 1, 1);
  const d = inkCtx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
const mixRgb = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

// One sprite, pixel by pixel, painted once. Row 0 is the top of the curtain (v = 1), the last
// row is the voice line (v = 0). Two curtains are painted into it:
//   the front one: a bright lower edge on the line, a body that thins upward, and (rays) a
//     ragged top, each ray ending at its own height with a soft tip;
//   a veil behind it: fainter, taller, broader, and further along the colour ramp, for depth.
// The colour climbs with height: ink.body at the line, ink.crown in the middle, ink.top at
// the tips. ink = { body, crown, top } as [r, g, b]; for close and off all three are the
// verdict colour, so the curtain never says anything different from the line.
function spriteCanvas(scale, cfg) {
  // Wider than the pattern by one wide column, so a strip that starts near the right edge
  // needs no second draw to wrap.
  const c = document.createElement('canvas');
  // Full sharpness across (the tufts and rays have edges); one row per CSS pixel up, since up
  // the curtain everything is a soft slope and the sprite is stretched to the height anyway.
  c.width = Math.round((cfg.spriteWPx + cfg.wideColPx + 2) * scale);
  c.height = cfg.spriteHPx;
  return c;
}

function paintSprite(c, ink, texture, rayDepth, scale, cfg, hotLevel = 0) {
  const wPx = c.width, hPx = c.height, W = cfg.spriteWPx;
  const g = c.getContext('2d');
  const img = g.createImageData(wPx, hPx), px = img.data;

  // Up one ray (x from 0 at the line to 1 at its tip), as tables: no pow or exp per pixel.
  const N = 256, body = new Float32Array(N + 1), edge = new Float32Array(N + 1), veil = new Float32Array(N + 1), hotT = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    body[i] = (1 - x) ** cfg.falloffPow;
    edge[i] = Math.exp(-x / cfg.edgeDepth) * (1 - x);
    veil[i] = (1 - x) ** cfg.veilPow;
    hotT[i] = Math.exp(-x / cfg.hotDepth);
  }
  // The colour of each row, for the front curtain and for the veil.
  const ramp = (v) => (v <= cfg.bodyTo ? ink.body
    : v < cfg.crownAt ? mixRgb(ink.body, ink.crown, smooth01((v - cfg.bodyTo) / (cfg.crownAt - cfg.bodyTo)))
      : mixRgb(ink.crown, ink.top, smooth01((v - cfg.crownAt) / (1 - cfg.crownAt))));
  const front = new Float32Array(hPx * 3), back = new Float32Array(hPx * 3);
  for (let r = 0; r < hPx; r++) {
    const v = 1 - (r + 0.5) / hPx;
    front.set(ramp(v), r * 3);
    back.set(ramp(Math.min(1, v + cfg.veilShift)), r * 3);
  }

  for (let xPx = 0; xPx < wPx; xPx++) {
    const u = (xPx + 0.5) / scale;
    let top = 1, ray = 1, edgeRay = 1, mask = 1, veilTop = 1, veilLevel = cfg.veilLevel;
    if (texture === 'rays') {
      const n = rayNoise(u, cfg), t = softNoise(u, 'top', cfg);
      // A bright ray is also a tall one, as in the sky.
      top = cfg.rayTopMin + (1 - cfg.rayTopMin) * (0.6 * t + 0.4 * n);
      ray = 1 - rayDepth + rayDepth * n;
      edgeRay = 1 - rayDepth * cfg.edgeRayShare * (1 - n);     // the lower edge is nearly unbroken
      veilTop = cfg.veilTopMin + (1 - cfg.veilTopMin) * softNoise(u, 'veil', cfg);
      veilLevel *= 0.55 + 0.45 * softNoise(u + W / 2, 'veil', cfg);
    } else if (texture === 'sheet') {
      // Close: one smooth sheet, no rays; only its top rolls gently.
      top = cfg.sheetTopMin + (1 - cfg.sheetTopMin) * softNoise(u, 'veil', cfg);
      ray = cfg.smoothLevel;
      veilLevel *= 0.6;
    } else if (texture === 'tufts') {
      mask = tuftMask(u, cfg);
      veilLevel = 0;
    } else {
      // Calm motion: flat across, for every state. Still two curtains and the full colour.
      top = cfg.calmTop;
      ray = cfg.calmLevel ?? cfg.smoothLevel;
    }
    for (let r = 0; r < hPx; r++) {
      const v = 1 - (r + 0.5) / hPx;
      const x = v / top, xv = v / veilTop;
      let aF = 0, aV = 0, hk = 0;
      if (x < 1) { const i = (x * N) | 0; aF = Math.min(1, mask * (cfg.bodyLevel * ray * body[i] + cfg.edgeLevel * edgeRay * edge[i])); hk = hotLevel * hotT[i] * edgeRay; }
      if (xv < 1 && veilLevel > 0) aV = veilLevel * veil[(xv * N) | 0] * (1 - aF);
      const a = aF + aV;
      if (!(a > 0)) continue;
      const o = (r * wPx + xPx) * 4, f = r * 3;
      // The hot base: towards ink.hot where the curtain leaves the ribbon.
      px[o] = ((front[f] + (ink.hot[0] - front[f]) * hk) * aF + back[f] * aV) / a;
      px[o + 1] = ((front[f + 1] + (ink.hot[1] - front[f + 1]) * hk) * aF + back[f + 1] * aV) / a;
      px[o + 2] = ((front[f + 2] + (ink.hot[2] - front[f + 2]) * hk) * aF + back[f + 2] * aV) / a;
      px[o + 3] = Math.min(255, a * 255);
    }
  }
  g.putImageData(img, 0, 0);
}

const spriteCache = new Map();

export function auroraSprites({ colours, dpr = 1, calm = false, light = false }, cfg = A) {
  const scale = Math.max(1, Math.min(CONFIG.stage.dprCap, dpr || 1));
  const key = [colours.good, colours.close, colours.off, colours.low, colours.mid, colours.high, colours.crown, colours.core || '', scale, calm ? 1 : 0, light ? 1 : 0].join('|');
  let set = spriteCache.get(key);
  if (set) return set;
  const began = performance.now();
  const table = lookTable(calm, light, cfg), depth = light ? cfg.rayDepthDawn : cfg.rayDepth;
  const texture = (l) => (l.tufts ? 'tufts' : l.rays ? 'rays' : calm ? 'smooth' : 'sheet');
  const good = rgbOf(colours.good), close = rgbOf(colours.close), off = rgbOf(colours.off);
  const low = rgbOf(colours.low), mid = rgbOf(colours.mid), high = rgbOf(colours.high), crown = rgbOf(colours.crown);
  const hues = [low, mixRgb(low, mid, 0.5), mid, mixRgb(mid, high, 0.5), high];
  const hot = colours.core ? rgbOf(colours.core) : crown, hotLevel = light ? cfg.hotLevelDawn : cfg.hotLevel;
  const jobs = [
    [{ body: good, crown, top: high, hot }, texture(table.in), hotLevel],
    [{ body: close, crown: close, top: close, hot }, texture(table.close), hotLevel * cfg.hotClose],
    [{ body: off, crown: off, top: off, hot }, texture(table.off), hotLevel * cfg.hotOff],
  ];
  for (let i = 0; i < cfg.freeSteps; i++) {
    const at = cfg.freeSteps > 1 ? (i / (cfg.freeSteps - 1)) * (hues.length - 1) : 2;
    jobs.push([{ body: hues[Math.round(at)], crown, top: high, hot }, texture(table.free), hotLevel]);
  }
  // Every canvas exists at once (clear until painted), so the drawing loop never has to ask.
  // The painting is cut into slices of about paintSliceMs, one a frame: a page's first paint
  // runs cold and measured 33 to 45 ms in one piece at pixel ratio 2 (3 to 5 ms once warm,
  // which fits one slice, so a theme or calm change is still painted at once).
  let done;
  set = { canvases: jobs.map(() => spriteCanvas(scale, cfg)), scale, srcH: cfg.spriteHPx, key, paintMs: 0, paintTotalMs: 0, slices: 0, ready: false, whenReady: new Promise((r) => { done = r; }) };
  let next = 0;
  const slice = () => {
    // The first slice is charged for reading the colours too (cold, that is most of it).
    const t0 = next ? performance.now() : began;
    do { paintSprite(set.canvases[next], jobs[next][0], jobs[next][1], depth, scale, cfg, jobs[next][2]); next++; }
    while (next < jobs.length && performance.now() - t0 < cfg.paintSliceMs);
    const ms = performance.now() - t0;
    set.paintMs = Math.max(set.paintMs, ms);
    set.paintTotalMs += ms;
    set.slices++;
    if (next < jobs.length) requestAnimationFrame(slice); else { set.ready = true; done(set); }
  };
  slice();
  // Two themes, calm or not, one or two pixel ratios: a handful. Keep the newest few.
  if (spriteCache.size >= 6) spriteCache.delete(spriteCache.keys().next().value);
  spriteCache.set(key, set);
  return set;
}

export function drawCurtain(g, cols, sprites, alpha = 1) {
  if (!(alpha > 0) || !cols.n) return 0;
  const { n, w, x, y, h, a, sx, sprite } = cols, s = sprites.scale, H = sprites.srcH, canvases = sprites.canvases;
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (!(a[i] > 0)) continue;
    g.globalAlpha = a[i] * alpha;
    g.drawImage(canvases[sprite[i]], sx[i] * s, 0, w * s, H, x[i], y[i] - h[i], w, h[i]);
    drawn++;
  }
  g.globalAlpha = 1;
  return drawn;
}
