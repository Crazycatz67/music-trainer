// takeglow.js — the last take as an aurora for the home sky's replay (PURE: no browser
// globals, so tools/checks/takeglow.check.mjs runs it in Node). Page-layout spec S4,
// living-sky spec section 7, sing-page-sky spec slice C.
//
// The dome never draws while a microphone is live, so a take's light is shown AFTERWARDS:
// the screen that ran the take hands its pitched points here (memory only, never stored),
// and the home replays them once on the next arrival on the sky.
//
// CONTRACT
//   GLOW                       the numbers (frozen): max 96 samples, 3 s of pitched singing,
//                              the shape (alt 6 + 16 x share, curtain 5..14 deg, az -50..+50)
//                              and the timing (8 s unroll, 20 s sway, 6 s fade; Calm 0.6/20/0.6 s)
//   glowSamples(points) -> [{ midi, lv, kind }] | null
//       points  [{ t (s), midi | null, kind?, lv? }] in time order (stage.points(), the Sing
//               page's trail). null when there were under GLOW.minSungSec of pitched singing:
//               only time between two pitched points counts, each gap capped at GLOW.gapSec
//               (a pause or a jump is not singing). Otherwise at most GLOW.max samples, evenly
//               picked from the pitched points; lv null when unknown; kind 'free' when missing.
//   glowWords(samples, { free = false, lines = null }) -> string   the live region's line, once:
//       free   "Your free singing, as an aurora."
//       lines  { with, of }: "Your last take, as an aurora: with the singer for 21 of 31 lines."
//       else   by the share of judged samples 'in': >= 60 % "mostly in tune", >= 30 % "partly
//              in tune", else "a first try"; no judged sample = the free words.
//   glowShape(samples) -> [{ az, alt, top, kind, lv }]   one column a sample, left to right:
//       az from -50 to +50 (degrees from the home view's centre), alt the lower edge (the
//       melody over the take's own range padded by 2 semitones), top = alt + 5..14 by lv.
//   glowAt(ms, { calm = false }) -> { reveal 0..1 (share unrolled), alpha 0..1, done }
//       ms since the replay began. Eased with --ease-in-out (cubic). done = it is over: never loops.
//   keepGlow(samples, meta = {}) -> boolean   the screen's hand-off: keeps { samples, meta, at }
//       as the last take and marks it waiting for one replay. null/empty clears nothing.
//   takeGlow() -> glow | null    the waiting glow, ONCE (the first return to the sky)
//   lastGlow() -> glow | null    the last kept glow, waiting or not ("Replay your aurora")
//   clearGlow()                  forget it (Erase my data; tests)
// ---------------------------------------------------------------------------------------

export const GLOW = Object.freeze({
  max: 96, minSungSec: 3, gapSec: 0.25,
  azFrom: -50, azTo: 50, altBase: 6, altSpan: 16, padSemis: 2, riseMin: 5, riseMax: 14, lvUnknown: 0.6,
  unrollMs: 8000, holdMs: 20000, fadeMs: 6000,
  calmInMs: 600, calmHoldMs: 20000, calmOutMs: 600,
  mostly: 0.6, partly: 0.3,
});

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const pitched = (p) => !!p && Number.isFinite(p.midi);

export function glowSamples(points) {
  if (!Array.isArray(points)) return null;
  let sung = 0;
  for (let i = 1; i < points.length; i++) {
    if (pitched(points[i]) && pitched(points[i - 1])) sung += Math.min(GLOW.gapSec, Math.max(0, points[i].t - points[i - 1].t));
  }
  const voiced = points.filter(pitched);
  // The small epsilon keeps a take of exactly 3 s (sampled at a frame rate) from failing on rounding.
  if (sung < GLOW.minSungSec - 1e-6 || !voiced.length) return null;
  const n = Math.min(GLOW.max, voiced.length);
  return Array.from({ length: n }, (_, k) => {
    const p = voiced[Math.floor((k * voiced.length) / n)];
    return { midi: p.midi, lv: Number.isFinite(p.lv) ? clamp01(p.lv) : null, kind: p.kind || 'free' };
  });
}

export function glowWords(samples, { free = false, lines = null } = {}) {
  const FREE = 'Your free singing, as an aurora.';
  if (free) return FREE;
  if (lines && Number.isFinite(lines.of) && lines.of > 0) return `Your last take, as an aurora: with the singer for ${lines.with} of ${lines.of} lines.`;
  const judged = (samples || []).filter((s) => s.kind === 'in' || s.kind === 'close' || s.kind === 'off');
  if (!judged.length) return FREE;
  const share = judged.filter((s) => s.kind === 'in').length / judged.length;
  const how = share >= GLOW.mostly ? 'mostly in tune' : share >= GLOW.partly ? 'partly in tune' : 'a first try';
  return `Your last take, as an aurora: ${how}.`;
}

export function glowShape(samples) {
  const list = (samples || []).filter(pitched);
  if (!list.length) return [];
  let lo = Infinity, hi = -Infinity;
  for (const s of list) { lo = Math.min(lo, s.midi); hi = Math.max(hi, s.midi); }
  lo -= GLOW.padSemis; hi += GLOW.padSemis;
  const n = list.length;
  return list.map((s, i) => {
    const az = n === 1 ? 0 : GLOW.azFrom + ((GLOW.azTo - GLOW.azFrom) * i) / (n - 1);
    const alt = GLOW.altBase + (GLOW.altSpan * (s.midi - lo)) / (hi - lo);
    const lv = s.lv === null || s.lv === undefined ? GLOW.lvUnknown : clamp01(s.lv);
    return { az, alt, top: alt + GLOW.riseMin + (GLOW.riseMax - GLOW.riseMin) * lv, kind: s.kind || 'free', lv };
  });
}

export function glowAt(ms, { calm = false } = {}) {
  const t = Math.max(0, Number(ms) || 0);
  if (calm) {
    // Calm motion: no unroll; the whole ribbon fades in, holds still, fades out.
    const { calmInMs: a, calmHoldMs: b, calmOutMs: c } = GLOW;
    if (t >= a + b + c) return { reveal: 1, alpha: 0, done: true };
    const alpha = t < a ? easeInOut(t / a) : t < a + b ? 1 : 1 - easeInOut((t - a - b) / c);
    return { reveal: 1, alpha, done: false };
  }
  const { unrollMs: u, holdMs: h, fadeMs: f } = GLOW;
  if (t >= u + h + f) return { reveal: 1, alpha: 0, done: true };
  const reveal = t < u ? easeInOut(t / u) : 1;
  const alpha = t < u + h ? 1 : 1 - easeInOut((t - u - h) / f);
  return { reveal, alpha, done: false };
}

// ---- the hand-off: memory only (a reload forgets it, by design: the samples are personal
// singing data and the spec keeps them out of storage).
let last = null, waiting = false;

export function keepGlow(samples, meta = {}) {
  if (!Array.isArray(samples) || !samples.length) return false;
  last = { samples: samples.slice(0, GLOW.max), meta: { ...meta }, at: Date.now() };
  waiting = true;
  return true;
}
export function takeGlow() {
  if (!waiting) return null;
  waiting = false;
  return last;
}
export const lastGlow = () => last;
export function clearGlow() { last = null; waiting = false; }
