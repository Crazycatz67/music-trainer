// dome.js — draws the star dome with three.js (browser only). Decoration and record only:
// every name, state and focus ring lives in the HTML links that js/app/sky.js lays over this
// canvas, so nothing here is the only copy of anything.
//
// docs/design/specs/2026-10-12-sky-dome.md, slice 1 (the dome) and slice 2 ("Life"), made a
// planetarium on the owner's word (2026-10-12: "just the same basic design with a few
// specks"): thousands of stars from a catalogue, a Milky Way, a horizon with hills, glowing
// place figures, and a sky that answers the pointer, a press and (lab only) a voice.
//
// Two frames, kept apart on purpose:
//   the HORIZON frame  the viewer's own: the five places, their figures, the hills, the
//                      earned record, the voice band. js/app/skymap.js az / alt.
//   the STAR SPHERE    the catalogue stars, catalogue figures and the Milky Way. It takes ONE
//                      orientation (setSky), so a later module can turn it to a real date,
//                      time and place and navigation never moves.
//
// ---------------------------------------------------------------------------------------
// CONTRACT
//   createDome(canvas, { soft = false, after?, onLost?, onRestored? }) -> Promise<dome>
//     after = a promise to wait for before three.js is fetched (first paint), so the
//     675 KB library never delays the place links.
//     Rejects with a DomeUnavailable (err.name === 'DomeUnavailable', err.reason is
//     'no-webgl' | 'software' | 'load-failed') when the dome cannot draw. It asks the browser for the
//     context ITSELF before loading three.js, so a missing or software-only WebGL costs no
//     download and logs no console error: the caller just shows the plain links.
//     soft = true allows software-drawn WebGL (headless test runs only).
//   dome.resize(w, h)            CSS px; the pixel ratio is capped by the quality tier (2 at most)
//   dome.setCamera({ yaw, pitch, fov })   degrees, as js/app/skymap.js defines them
//   dome.setInside(into)         0 = home, full brightness .. 1 = inside a place, dimmed to
//                                --sky-dim. The dim is drawn in the frame, never CSS on the canvas.
//   dome.setTheme()              re-read the colour tokens (after data-theme changes)
//   dome.setCalm(bool)           Calm motion: no twinkle, no parallax, no pointer glow, no press ring
//   dome.setLit(placeId | null)  the place you are inside: its own figure (for Tonight the moon
//                                and its step stars, for Your Sky the record) keeps full
//                                strength while everything else dims. null = at home.
//   dome.setToday({ done, total } | null)   today's session: the moon is lit by done / total
//                                (full, with a gold rim, when all are done) and `total` step
//                                stars (8 at most) hang under it: done = lit gold, the next =
//                                hollow and slowly breathing (still in Calm motion), later =
//                                hollow. The lit edge eases to a new share. null (the start
//                                state) = a plain crescent and no step stars.
//   dome.setHover(placeId | null)  that figure lifts: lines turn --accent, stars grow 15 %
//   dome.setPointer([x, y, z] | null)   a unit sky direction (skymap.unproject().dir): stars
//                                within POINTER.deg of it brighten and grow, and the sky under
//                                it takes a faint wash of --accent (values: POINTER below)
//   dome.press([x, y, z])        a soft ring opens at that sky direction (450 ms) and the stars
//                                round it lift and settle with it
//   dome.setTwinkle(bool)        idle life on or off (eased); sky.js rests it after 30 s
//   dome.setQuality('full' | 'lean' | 'low')   skymap.QUALITY.tiers; every change is eased
//   dome.setStars(catalogue | null)   { stars: [{ ra, dec, mag, colour?, name? }],
//                                figures: [{ id, name, lines: [[a, b], ...] }], milkyWay?: { ra, dec } }
//                                (degrees; mag drives size and brightness; a, b index `stars`).
//                                null = the made-up default sky (skymap.proceduralStars()).
//   dome.setSky({ rotation } | { lst, latitude, north? } | null)   the star sphere's one
//                                orientation (skymap.skyRotation); null = identity.
//   dome.setVoice({ level, midi } | null)   level 0..1, midi a float: a soft band of
//                                brightness at the height that matches the pitch
//                                (skymap.noteAlt). No microphone code here: the caller feeds it.
//                                NOTE the spec forbids frames while the mic is live (section 9),
//                                and setMicLive(true) wins: this hook is lab-only until a lab
//                                shows that drawing costs the detector nothing.
//   dome.setEarned([{ id, lit, gold?, points: [[az, alt], ...] }])   the owner's own
//                                constellations, oldest first (skymap.earnedSky().items).
//                                lit false = hollow stars and a dotted line. The newest 2,000
//                                stars and 160 line pieces are drawn; totals are the caller's words.
//   dome.setMicLive(bool)        true = render() and snapshot() draw NOTHING and count `blocked`
//   dome.tick(dtMs) -> boolean   advance every ease; true = draw again next frame
//   dome.render() -> ms          draws ONE frame, returns the main-thread ms it took.
//                                Never draws by itself: sky.js decides when (on demand).
//   dome.snapshot(canvas2d)      copies the frame just drawn (the Calm-motion cross-fade)
//   dome.debug() -> { frames, blocked, drawCalls, triangles, points, lines, stars, starsShown,
//                     catalogueFigures, earned: { stars, lines }, pixelRatio, renderer, lost,
//                     dim, tier, twinkle, parallax, pointer, voice: { level, alt }, ring, micLive, maxPoint,
//                     today: { done, total } | null, moonLit (the share drawn now), kept (setLit's place),
//                     others (what is left of the other places' figures: 1 at home, 0 inside a place) }
//   The look's tunable numbers are the constants STAR, FIGURE, POINTER, PRESS, VOICE, SKY, MOON,
//   STEP, EARNED and EASE_MS below, with a note of which of them drive the flash number.
//   dome.destroy()
// Budget (spec section 12): at most 8 draw calls (6 here, 7 with catalogue figures), one
// texture (the moon, painted in code), no lights, shadows, post-processing or loaded assets.
// Departure, by the overseer's brief: several thousand stars, not the spec's 1,200.
// ---------------------------------------------------------------------------------------

import { PLACES, DOME, QUALITY, RECORD, STEPS, stepStars, skyVector, celestialVector, skyRotation, noteAlt, proceduralStars, MILKY_POLE } from './skymap.js';

const THREE_URL = new URL('../../vendor/three-0.161.0/three.module.min.js', import.meta.url).href;
const FIGURE_R = DOME.radius * 0.98;
const STAR_R = DOME.radius * 0.99;
const EARNED_LINES = 160;

// ---- THE LOOK: every number a designer tunes is here, by name (review 6) -----------------
// Structure is Cody's, values are Delilah's. Sizes are CSS px of the sprite unless they say
// degrees; alphas and amounts are 0..1; [rest, hovered] pairs are eased between.
//
// What drives each part of the lab's flash number (limit 0.15: the largest change of a
// 48 px cell inside 120 ms). If one goes over, make the CHANGE smaller or slower (its depth
// or its ease), not the thing dimmer:
//   twinkle        STAR.twinkleDepth, with STAR.lum* and STAR.halo* (bright haloed stars)
//   pointer        POINTER.lift, POINTER.grow, EASE_MS.pointer
//   hover          FIGURE.hoverGrow, FIGURE.starAlpha, FIGURE.lineAlpha, MOON.hoverScale, MOON.hoverAccent, EASE_MS.hover
//   press ring     PRESS.ringPx, PRESS.ringAlpha, PRESS.starLift, EASE_MS.ring
//   voice          VOICE.sky, VOICE.stars, EASE_MS.voiceUp / voiceDown
//   travel in/back MOON.lit, MOON.halo, skymap PLACES moonDeg (the moon grows as the view closes
//                  in and, as Tonight's own figure, no longer dims), SKY.milky, skymap TRAVEL
//   record         EARNED.*, EASE_MS.earned
//   today          MOON.lit, EASE_MS.today (ms for the lit edge to cross the WHOLE moon), STEP.*
const EASE_MS = { hover: 200, pointer: 200, voiceUp: 300, voiceDown: 400, twinkle: 800, parallax: 600, keep: 600, ring: 450, earned: 600, lit: 200, today: 2500 };
// Field stars (the catalogue). g = a star's brightness 0..1 on a gentle curve of magnitude.
// (Review 6, finding 3: the field read as dust. Larger cores, about 1,200 stars with a halo
// instead of about 500, and the brightest hundred or so carry four fine rays.)
const STAR = { coreBase: 1.8, coreGain: 4.6,            // core px = coreBase + coreGain * g
  haloFrom: 0.22, haloTo: 0.6, haloGrow: 4.5,           // stars with g past haloFrom grow a halo: sprite = core * (1 + haloGrow * halo)
  lumBase: 0.55, lumGain: 0.45, lumPow: 0.22,           // brightness = lumBase + lumGain * b ^ lumPow
  twinkleFrom: 0.16, twinkleShare: 0.17, twinkleDepth: 0.15,
  coreEdge: 0.45,                                       // the core is solid out to this share of its radius, then falls off
  glow: 0.6, glowPow: 2.2,                              // the halo's strength and fall-off inside the sprite
  rays: 0.55,                                           // four fine rays on the stars with the widest halos
  paleAlpha: 0.78 };                                    // Dawn: ink dots at this strength
// Place figures (The Ladder, The Lyre, The Open Sky).
// (Review 6, finding 2: a 56 px sprite whose core stays about 10 px; the extra size is glow.)
const FIGURE = { starPx: 56, hoverGrow: 0.2, starAlpha: [0.9, 1.4], lineAlpha: [0.62, 1.5],   // an alpha past 1 widens the glow (hover); the core cannot go past full
  lineHalf: 1.05, lineTrim: 2.0,
  accentRest: 0.3, accentRestPale: 0.7,                 // share of --accent in a resting figure, so it is not a field star (Dusk, Dawn)
  core: [0.22, 0.12],                                   // the solid core's soft edge, as shares of the sprite's radius (outer, inner)
  haloPow: 1.8, halo: 0.9, rays: 0.8,                   // the halo's fall-off and strength; the four rays' strength
  lineCore: 0.9, lineGlow: 0.6, haloPale: 0.7,
  othersInside: 0 };                                    // what is left of the other places' figures while you are inside one        // Dawn draws ink, not light: halos at haloPale
// (Finding 6: both could only be found by comparing two pictures. The pointer now also lays
// a faint wash of --accent on the sky itself, washDeg wide.)
const POINTER = { deg: 7, lift: 0.75, grow: 0.5, wash: 0.05, washDeg: 9 };      // stars within deg of the pointer brighten by lift and grow by grow
const PRESS = { ringPx: [18, 96], ringAlpha: 0.5, band: [0.8, 0.92], fill: 0.05, starDeg: 9, starLift: 0.6 };   // the ring opens ringPx[0] -> [1]; its band's inner soft edge; a faint fill inside it; stars within starDeg lift too
const VOICE = { sky: 0.07, stars: 0.65 };
// Colour (finding 4). afterglow = --accent where Tonight is; warm = a low band of --gold on
// the horizon [strength, how fast it falls with height]; milkyWarm = --gold along the Milky
// Way's middle. The Pale values are Dawn's: there the warm band is the coming sunrise.
const SKY = { horizonGlow: 0.16, afterglow: 0.17, warm: [0.11, 15], warmPale: [0.4, 7], milky: 0.17, milkyAccent: 0.45, milkyWarm: 0.3, milkyPale: 0.6,
  hillRim: 0.16 };                                      // the far ridge's crest catches this much of the afterglow
// The moon (Tonight). lit = the bright part; dark = the unlit disc (earthshine); halo = two
// soft rings [reach px of 128, strength]; rim = the gold ring of a finished day.
// Dawn (the Pale values) is ink on a light sky, so the lit part is the LIGHTEST thing there
// (--sky-moonlit, near white) and the unlit part is a soft shade of --gold; a thin --gold
// edge holds the disc. (Before, Dawn's lit part was dark ink and read as the shadow.)
// seas = the faint darker patches on the lit face [x, y, r as shares of the disc, strength].
const MOON = { lit: 0.86, dark: 0.09, halo: [[80, 0.2], [127, 0.09]], rimPx: 3.5, rim: 0.95, hoverScale: 0.1, hoverAccent: 0.5, hoverAccentPale: 0.25,
  litPale: 1, darkPale: 0.68, facePale: 0.3, haloPale: [[76, 0.7], [124, 0.3]], edgePale: 0.55, edgePx: 1.2,
  seas: [[-0.42, -0.3, 0.3, 0.1], [-0.05, -0.48, 0.24, 0.08], [-0.5, 0.28, 0.22, 0.09], [0.22, 0.1, 0.34, 0.08], [0.02, 0.52, 0.2, 0.07], [0.5, -0.36, 0.18, 0.07]],
  limb: 0.16 };                                         // the lit face darkens this much towards its edge, so it reads as a ball
// Tonight's step stars: done = lit gold; next = hollow and breathing; later = hollow, faint.
const STEP = { px: 38, doneAlpha: 1, nextAlpha: 0.95, laterAlpha: 0.6, breatheS: 3.6, breatheGrow: 0.16, breatheDim: 0.25 };
// Your Sky: gold = a clean round.
const EARNED = { starPx: 34, goldAlpha: 1, plainAlpha: 0.85, goldLine: 0.85, plainLine: 0.5, lineHalf: 0.6 };
const glsl = (n) => Number(n).toFixed(4);
export const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export class DomeUnavailable extends Error {
  constructor(reason, detail = '') {
    super(`the dome cannot draw (${reason}${detail ? `: ${detail}` : ''})`);
    this.name = 'DomeUnavailable';
    this.reason = reason;
  }
}

const hash01 = (n) => {
  let t = (n | 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Every colour ends the same way: pulled towards the page colour by uDim (inside a place),
// so the dim is part of the drawn frame.
const COMMON = 'uniform float uDim; uniform vec3 uBg;';

const SKY_VERT = `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = `
${COMMON}
uniform vec3 uZenith, uHorizon, uAccent, uMilkyCol, uMilkyPole, uWarm, uPointer;
uniform mat3 uToStars;
uniform float uGlow, uMilky, uVoiceAmt, uVoiceY, uRipple, uWarmAmt, uWarmFall, uMilkyWarm, uPointerAmt;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  // The glow hugs the horizon: most of the change happens in the first 30 degrees.
  vec3 col = mix(uHorizon, uZenith, 1.0 - pow(1.0 - up, 2.4));
  // A thin bright layer right at the horizon, and the last light where Tonight is.
  float ahead = 0.5 - 0.5 * d.z / max(1e-4, length(d.xz));
  col += uGlow * (uHorizon * ${glsl(SKY.horizonGlow)} * exp(-up * 10.0) + uAccent * ${glsl(SKY.afterglow)} * exp(-up * 4.2) * ahead * ahead * ahead);
  // A low warm band: the last of the sunset under Tonight (Dusk), the coming sunrise (Dawn).
  // Mixed in, not added, so it tints a pale sky as well as a dark one.
  col = mix(col, uWarm, uWarmAmt * exp(-up * uWarmFall) * (0.3 + 0.7 * ahead * ahead));
  // The Milky Way belongs to the star sphere: its band is found in that frame.
  vec3 s = uToStars * d;
  float lat = dot(s, uMilkyPole);
  float band = exp(-lat * lat / 0.026);
  if (band > 0.002 && d.y > -0.03) {
    // Fine-grained and uneven, with a dark lane of dust along its middle: a river of
    // far-off stars, not a cloud.
    float clouds = smoothstep(0.30, 0.78, fbm(s * 9.0));
    float dust = smoothstep(0.40, 0.66, fbm(s * 14.0 + 7.3)) * exp(-lat * lat / 0.006);
    float m = band * (0.22 + 0.78 * clouds) * (1.0 - 0.8 * dust) * smoothstep(-0.02, 0.22, d.y);
    // Warmer along its middle, cooler at its edges: one river, two colours.
    col = mix(col, mix(uMilkyCol, uWarm, uMilkyWarm * exp(-lat * lat / 0.007)), m * uMilky);
  }
  // The voice band: a soft ring of light at one height, with a slow ripple round it.
  float dy = d.y - uVoiceY;
  float vb = exp(-dy * dy / 0.006) * (0.7 + 0.3 * sin(atan(d.x, -d.z) * 3.0 - uRipple));
  col = mix(col, uAccent, ${glsl(VOICE.sky)} * uVoiceAmt * vb);
  // The pointer: a faint wash of the accent on the sky under it (eased with the stars' lift).
  col = mix(col, uAccent, ${glsl(POINTER.wash)} * uPointerAmt * smoothstep(${Math.cos(POINTER.washDeg * Math.PI / 180).toFixed(5)}, 1.0, dot(d, uPointer)));
  col = mix(uBg, col, uDim);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  // A grain of noise under one colour step, so the long gradient does not band.
  gl_FragColor.rgb += (hash(vec3(gl_FragCoord.xy, 3.0)) - 0.5) / 255.0;
}`;

// Stars: one buffer, a size and brightness each. Everything alive about them (twinkle,
// the pointer, the voice, depth, the quality guard's fade) is a uniform, so a frame costs
// the main thread a handful of numbers whatever the star count.
const STAR_VERT = `
attribute vec4 aStar;    // size px, brightness, twinkle phase (below 0 = never twinkles), rank 0 (brightest) .. 1
attribute vec4 aTint;    // colour temperature r g b, share of the sprite that is the core
attribute vec2 aDepth;   // shell depth (0 = on the dome), twinkle period in seconds
uniform float uScale, uMaxPoint, uTime, uTwinkle, uParallax, uKeep, uPointerAmt, uPressAmt, uVoiceAmt, uVoiceY, uRipple, uTemp, uAlpha, uDim, uLiftCap;
uniform vec3 uLook, uPointer, uPress, uInk;
varying vec4 vCol;
varying float vCore;
void main() {
  // Depth: nearer shells are seen from a little behind the centre, so they slide against
  // the far ones as the view turns. The far shell (depth 0) stays locked to the figures.
  vec3 w = (modelMatrix * vec4(position, 1.0)).xyz + uLook * (aDepth.x * uParallax * ${DOME.radius.toFixed(1)});
  vec3 d = normalize(w);
  float lift = uPointerAmt * ${glsl(POINTER.lift)} * smoothstep(${Math.cos(POINTER.deg * Math.PI / 180).toFixed(5)}, 1.0, dot(d, uPointer));
  // A press lifts the stars round it for as long as its ring lives.
  lift += uPressAmt * ${glsl(PRESS.starLift)} * smoothstep(${Math.cos(PRESS.starDeg * Math.PI / 180).toFixed(5)}, 1.0, dot(d, uPress));
  float dy = d.y - uVoiceY;
  lift += uVoiceAmt * ${glsl(VOICE.stars)} * exp(-dy * dy / 0.006) * (0.7 + 0.3 * sin(atan(d.x, -d.z) * 3.0 - uRipple));
  float tw = aStar.z < 0.0 ? 0.0 : sin(6.2831853 * (uTime / aDepth.y + aStar.z));
  float lum = aStar.y * (1.0 + lift) * (1.0 + ${glsl(STAR.twinkleDepth)} * uTwinkle * tw) * (1.0 - smoothstep(uKeep, uKeep + 0.08, aStar.w));
  // Light can lift past full strength only as far as uLiftCap (ink on a pale sky cannot).
  vCol = vec4(mix(vec3(1.0), aTint.rgb, uTemp) * uInk, min(uLiftCap, lum) * uAlpha * uDim);
  vCore = aTint.a;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  gl_PointSize = min(uMaxPoint, aStar.x * uScale * (1.0 + ${glsl(POINTER.grow)} * lift));
}`;
const STAR_FRAG = `
varying vec4 vCol;
varying float vCore;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  // A tight core, and for the bright ones a wide soft glow that reaches zero at the edge.
  vec2 q = gl_PointCoord - 0.5;
  float fade = max(0.0, 1.0 - d);
  float core = smoothstep(vCore, vCore * ${glsl(STAR.coreEdge)}, d);
  float wide = 1.0 - vCore;
  float glow = wide * ${glsl(STAR.glow)} * pow(fade, ${glsl(STAR.glowPow)});
  // Rays only where the halo is wide (the brightest stars): a jewel, not a cross on every dot.
  float rays = smoothstep(0.62, 0.8, wide) * ${glsl(STAR.rays)} * fade * (exp(-abs(q.x) * 46.0 - abs(q.y) * 6.0) + exp(-abs(q.y) * 46.0 - abs(q.x) * 6.0));
  gl_FragColor = vec4(vCol.rgb, min(1.0, vCol.a * (core + glow + rays)));
  #include <colorspace_fragment>
}`;

// Figure and earned stars. look 0 = lit star with a halo and four faint rays, 1 = hollow
// (not yet lit), 2 = the press ring. aKeep 1 = this star belongs to the place you are inside:
// it keeps its full strength while the rest of the sky dims round it (review 6, finding 2).
const POINT_VERT = `
attribute float aSize;
attribute vec4 aTint;
attribute float aLook;
attribute float aKeep;
uniform float uScale, uMaxPoint, uDim, uOthers;
varying vec4 vTint;
varying float vLook;
void main() {
  vTint = vec4(aTint.rgb, aTint.a * mix(uDim * uOthers, 1.0, aKeep));
  vLook = aLook;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = min(uMaxPoint, aSize * uScale);
}`;
const POINT_FRAG = `
uniform float uHalo;
varying vec4 vTint;
varying float vLook;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q) * 2.0;
  float fade = max(0.0, 1.0 - d);
  float halo = pow(fade, ${glsl(FIGURE.haloPow)}) * ${glsl(FIGURE.halo)} * uHalo;
  float rays = (exp(-abs(q.x) * 40.0 - abs(q.y) * 7.0) + exp(-abs(q.y) * 40.0 - abs(q.x) * 7.0)) * ${glsl(FIGURE.rays)} * fade * uHalo;
  float lit = smoothstep(${glsl(FIGURE.core[0])}, ${glsl(FIGURE.core[1])}, d) + halo + rays;
  float hollow = smoothstep(0.40, 0.33, d) * smoothstep(0.19, 0.26, d) + halo * 0.35;
  float ring = smoothstep(1.0, 0.92, d) * (smoothstep(${glsl(PRESS.band[0])}, ${glsl(PRESS.band[1])}, d) + ${glsl(PRESS.fill)});
  float a = vLook < 0.5 ? lit : vLook < 1.5 ? hollow : ring;
  gl_FragColor = vec4(vTint.rgb, min(1.0, vTint.a * a));
  #include <colorspace_fragment>
}`;

// Lines are thin strips of triangles, not GL lines: those are 1 px whatever is asked (spec
// section 14), and a strip can carry a soft glow across its width.
const LINE_VERT = `
attribute vec4 aCol;
attribute vec3 aLine;    // across (-1 .. 1), along (dome units), dotted (0 or 1)
attribute float aKeep;   // 1 = a line of the place you are inside: not dimmed
uniform float uDim, uOthers;
varying vec4 vCol;
varying vec3 vLine;
void main() {
  vCol = vec4(aCol.rgb, aCol.a * mix(uDim * uOthers, 1.0, aKeep));
  vLine = aLine;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const LINE_FRAG = `
uniform float uHalo;
varying vec4 vCol;
varying vec3 vLine;
void main() {
  float a = abs(vLine.x);
  float core = smoothstep(0.30, 0.10, a);
  float glow = pow(1.0 - a, 2.2) * ${glsl(FIGURE.lineGlow)} * uHalo;
  float f = fract(vLine.y / 1.9);
  float dash = mix(1.0, smoothstep(0.0, 0.12, f) * smoothstep(0.62, 0.50, f), vLine.z);
  gl_FragColor = vec4(vCol.rgb, min(1.0, vCol.a * (core * ${glsl(FIGURE.lineCore)} + glow)) * dash);
  #include <colorspace_fragment>
}`;

const GROUND_VERT = `
attribute vec3 aShade;
varying vec3 vShade;
varying float vUp;
void main() { vShade = aShade; vUp = position.y / ${DOME.radius.toFixed(1)}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GROUND_FRAG = `
${COMMON}
uniform vec3 uGround, uHorizon, uRim;
varying vec3 vShade;
varying float vUp;
void main() {
  // vShade.x = how much of the horizon's colour this ridge keeps at its crest (far hills
  // are hazier); it sinks into the ground colour just below. The haze keeps the step from
  // sky to hill small, so the horizon sliding through the view never reads as a flash.
  vec3 hill = mix(uGround, uHorizon, vShade.x * smoothstep(-0.16, 0.05, vUp));
  // The crest of each ridge catches a little of the sky's last light (more on the far one).
  hill = mix(hill, uRim, ${glsl(SKY.hillRim)} * vShade.x * smoothstep(-0.03, 0.05, vUp));
  gl_FragColor = vec4(mix(uBg, hill, uDim), 1.0);
  #include <colorspace_fragment>
}`;

export async function createDome(canvas, { soft = false, after = null, onLost = null, onRestored = null } = {}) {
  // Ask for the context ourselves, with the spec's attributes. powerPreference 'default':
  // asking for high performance can wake the hotter graphics chip on a two-chip Mac.
  // failIfMajorPerformanceCaveat: software-drawn WebGL would eat the main thread, so it
  // gets the plain links instead (unless a test run asks for it).
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false,
      powerPreference: 'default', failIfMajorPerformanceCaveat: !soft, preserveDrawingBuffer: false });
  } catch { gl = null; }
  if (!gl) throw new DomeUnavailable('no-webgl');
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  // Measured 2026-10-12 in Chrome 154: failIfMajorPerformanceCaveat still hands out a
  // SwiftShader context (20 frames a second here), so the renderer's name is checked too.
  if (!soft && SOFTWARE.test(rendererName)) throw new DomeUnavailable('software', rendererName);
  // Sprites larger than this are cut off square by the GPU, so sizes are capped under it.
  const maxPoint = Math.max(8, Number(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1]) || 64);

  let THREE;
  await after;
  try { THREE = await import(THREE_URL); }
  catch (err) { throw new DomeUnavailable('load-failed', String(err?.message || err)); }

  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: false, powerPreference: 'default' });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, DOME.near, DOME.far);
  camera.rotation.order = 'YXZ';

  const at = (az, alt, r) => { const v = skyVector(az, alt); return [v[0] * r, v[1] * r, v[2] * r]; };
  // Everything is painted back to front by renderOrder with the depth test off: a dome seen
  // from its centre has a fixed order, and this keeps the order ours, not the sorter's.
  // (`transparent` on every material, the solid ones too: three draws all solid things
  // first, which would put the hills under the stars.)
  const flat = { transparent: true, depthTest: false, depthWrite: false };
  const colours = {};
  const mixInto = (out, a, b, t) => out.copy(a).lerp(b, t);
  const scratch = new THREE.Color(), scratch2 = new THREE.Color();
  let frames = 0, blocked = 0, lost = false, micLive = false, calm = false;
  let pixelRatio = 1, size = { w: 1, h: 1 }, tier = 'full', pale = false, skyDim = 0.35, inside = 0;

  // Shared by every material: the dim, and the sizes that follow the window and the zoom.
  const U = {
    dim: { value: 1 }, others: { value: 1 }, bg: { value: new THREE.Color() }, scale: { value: 1 }, maxPoint: { value: maxPoint }, halo: { value: 1 },
    voiceAmt: { value: 0 }, voiceY: { value: 0.5 }, ripple: { value: 0 },
    pointer: { value: new THREE.Vector3(0, 1, 0) }, pointerAmt: { value: 0 },
  };

  // 1. The sky: the upper part of a sphere; gradient, horizon glow, Milky Way and voice
  // band are all worked out per pixel from the direction, so the mesh can stay coarse.
  const skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, ...flat,
    uniforms: { uDim: U.dim, uBg: U.bg, uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() },
      uMilkyCol: { value: new THREE.Color() }, uMilkyPole: { value: new THREE.Vector3(0, 1, 0) }, uToStars: { value: new THREE.Matrix3() },
      uGlow: { value: 1 }, uMilky: { value: 0.2 }, uVoiceAmt: U.voiceAmt, uVoiceY: U.voiceY, uRipple: U.ripple,
      uWarm: { value: new THREE.Color() }, uWarmAmt: { value: 0 }, uWarmFall: { value: 15 }, uMilkyWarm: { value: 0 }, uPointer: U.pointer, uPointerAmt: U.pointerAmt } });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(DOME.radius, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), skyMat);
  sky.renderOrder = 0;

  // 2. The star sphere: catalogue stars (and catalogue figures, when a catalogue has any).
  // A plain Object3D, not a Group: three sorts a Group's children as one block after
  // everything outside it, and the stars must be drawn before the hills.
  const starSphere = new THREE.Object3D();
  starSphere.matrixAutoUpdate = false;
  const starMat = new THREE.ShaderMaterial({ vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, ...flat,
    uniforms: { uScale: U.scale, uMaxPoint: U.maxPoint, uDim: U.dim, uTime: { value: 0 }, uTwinkle: { value: 0 }, uParallax: { value: 0 }, uKeep: { value: 1.1 },
      uPointerAmt: { value: 0 }, uPressAmt: { value: 0 }, uPress: { value: new THREE.Vector3(0, 1, 0) }, uVoiceAmt: U.voiceAmt, uVoiceY: U.voiceY, uRipple: U.ripple, uTemp: { value: 1 }, uAlpha: { value: 1 }, uLiftCap: { value: 1 },
      uLook: { value: new THREE.Vector3(0, 0, -1) }, uPointer: U.pointer, uInk: { value: new THREE.Color() } } });
  const lineMat = () => new THREE.ShaderMaterial({ vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, side: THREE.DoubleSide, ...flat, uniforms: { uDim: U.dim, uOthers: U.others, uHalo: U.halo } });
  let stars = null, starCount = 0, catFigures = null, catFigureCount = 0, catalogueLines = [];

  // A strip of two triangles from p to q on the dome, `half` dome units to each side.
  function strip(out, p, q, half, dotted) {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], len = Math.hypot(d[0], d[1], d[2]) || 1;
    const s = [p[1] * d[2] - p[2] * d[1], p[2] * d[0] - p[0] * d[2], p[0] * d[1] - p[1] * d[0]];
    const sl = (Math.hypot(s[0], s[1], s[2]) || 1) / half;
    for (const [e, along] of [[p, 0], [q, len]]) for (const side of [-1, 1]) {
      out.pos.push(e[0] + side * s[0] / sl, e[1] + side * s[1] / sl, e[2] + side * s[2] / sl);
      out.line.push(side, along, dotted ? 1 : 0);
    }
  }
  const quadIndex = (pieces) => { const idx = []; for (let i = 0; i < pieces; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2); return idx; };
  // Stop a line short of each star so it never runs through one.
  const trimmed = (p, q, by) => { const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) || 1, t = Math.min(0.3, by / len); return [p.map((v, i) => v + (q[i] - v) * t), q.map((v, i) => v + (p[i] - v) * t)]; };

  function setStars(catalogue) {
    const cat = catalogue && Array.isArray(catalogue.stars) ? catalogue : proceduralStars();
    const list = cat.stars.filter((s) => s && Number.isFinite(s.ra) && Number.isFinite(s.dec) && Number.isFinite(s.mag));
    // Brightest first, so the quality guard can thin the sky from the faint end.
    const order = list.map((_, i) => i).sort((a, b) => list[a].mag - list[b].mag);
    const n = order.length;
    const pos = new Float32Array(n * 3), aStar = new Float32Array(n * 4), aTint = new Float32Array(n * 4), aDepth = new Float32Array(n * 2);
    order.forEach((src, i) => {
      const s = list[src], v = celestialVector(s.ra, s.dec);
      pos.set([v[0] * STAR_R, v[1] * STAR_R, v[2] * STAR_R], i * 3);
      // Magnitude to light: each magnitude is 2.512 times; the eye (and a screen) sees far
      // less than that, so brightness and size follow gentle powers of it.
      const b = Math.min(1, 10 ** (-0.4 * (s.mag + 1.2))), g = b ** 0.3, glow = smooth(STAR.haloFrom, STAR.haloTo, g);
      const core = STAR.coreBase + STAR.coreGain * g;
      const h = hash01(src * 2 + 1), h2 = hash01(src * 2 + 2);
      // Twinkle: the brighter half of what the eye picks out, one star in six of those.
      const twinkles = g > STAR.twinkleFrom && h < STAR.twinkleShare;
      aStar.set([core * (1 + STAR.haloGrow * glow), STAR.lumBase + STAR.lumGain * b ** STAR.lumPow, twinkles ? h2 : -1, n > 1 ? i / (n - 1) : 0], i * 4);
      // B-V colour index to a tint: blue-white, white, orange. These are multipliers on the
      // --text token, not colours of their own.
      const bv = Number.isFinite(s.colour) ? s.colour : 0.6, c = Math.min(1, Math.max(0, (bv + 0.3) / 2.1));
      const cool = smooth(0.0, 0.42, c), warm = smooth(0.42, 1.0, c);
      aTint.set([0.66 + 0.34 * cool, 0.78 + 0.22 * cool - 0.22 * warm, 1.0 - 0.06 * cool - 0.44 * warm, 1 / (1 + STAR.haloGrow * glow)], i * 4);
      aDepth.set([h2 < 0.6 ? 0 : h2 < 0.87 ? 0.05 : 0.1, 3 + 4 * hash01(src * 2 + 3)], i * 2);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aStar', new THREE.BufferAttribute(aStar, 4));
    geo.setAttribute('aTint', new THREE.BufferAttribute(aTint, 4));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 2));
    if (stars) { starSphere.remove(stars); stars.geometry.dispose(); }
    stars = new THREE.Points(geo, starMat);
    stars.frustumCulled = false;
    stars.renderOrder = 1;
    starSphere.add(stars);
    starCount = n;

    // Catalogue figures (real constellations, later): quiet lines that turn with the stars.
    if (catFigures) { starSphere.remove(catFigures); catFigures.geometry.dispose(); catFigures.material.dispose(); catFigures = null; }
    const out = { pos: [], line: [] };
    catalogueLines = [];
    for (const fig of cat.figures || []) for (const [a, b] of fig.lines || []) {
      const sa = cat.stars[a], sb = cat.stars[b];
      if (!sa || !sb) continue;
      const [p, q] = trimmed(celestialVector(sa.ra, sa.dec).map((v) => v * FIGURE_R), celestialVector(sb.ra, sb.dec).map((v) => v * FIGURE_R), 1.2);
      strip(out, p, q, 0.5, false);
      catalogueLines.push(fig.id);
    }
    catFigureCount = (cat.figures || []).length;
    if (catalogueLines.length) {
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out.pos), 3));
      g2.setAttribute('aLine', new THREE.BufferAttribute(new Float32Array(out.line), 3));
      g2.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(catalogueLines.length * 16), 4));
      g2.setAttribute('aKeep', new THREE.BufferAttribute(new Float32Array(catalogueLines.length * 4), 1));
      g2.setIndex(quadIndex(catalogueLines.length));
      catFigures = new THREE.Mesh(g2, lineMat());
      catFigures.frustumCulled = false;
      catFigures.renderOrder = 2;
      starSphere.add(catFigures);
    }
    const pole = cat.milkyWay && Number.isFinite(cat.milkyWay.ra) && Number.isFinite(cat.milkyWay.dec) ? cat.milkyWay : MILKY_POLE;
    skyMat.uniforms.uMilkyPole.value.set(...celestialVector(pole.ra, pole.dec));
    if (colours.text) paintCatalogue();
  }

  function setSky(skyState) {
    const m = skyRotation(skyState);
    starSphere.matrix.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
    starSphere.matrixWorldNeedsUpdate = true;
    // The sky shader goes the other way (dome direction to star sphere): the transpose.
    skyMat.uniforms.uToStars.value.set(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]);
  }

  // 3. The horizon: two ridges of low hills, the far one hazier, so "up" is always obvious
  // and the camera never looks into nothing.
  const SEG = 240, ground = (() => {
    const pos = [], shade = [], idx = [];
    const ridge = (height, haze, r) => {
      const base = pos.length / 3;
      for (let i = 0; i <= SEG; i++) {
        const az = (i / SEG) * 360;
        pos.push(...at(az, height(az * Math.PI / 180, i % SEG), r), ...at(az, -80, r));
        shade.push(haze, 0, 0, haze, 0, 0);
        if (i < SEG) idx.push(base + i * 2, base + i * 2 + 1, base + i * 2 + 2, base + i * 2 + 1, base + i * 2 + 3, base + i * 2 + 2);
      }
    };
    ridge((a) => Math.max(0.9, 2.7 + 1.5 * Math.sin(2 * a + 0.4) + 0.9 * Math.sin(5 * a + 1.3) + 0.5 * Math.sin(11 * a + 2.1)), 0.62, DOME.radius * 0.986);
    // The near ridge carries a broken tree line: small seeded bumps, never a hard spike.
    ridge((a, i) => Math.max(0.4, 1.3 + 0.8 * Math.sin(3 * a + 2.0) + 0.5 * Math.sin(7 * a + 0.5) + 0.3 * Math.sin(17 * a + 1.1)
      + (hash01(Math.floor(i / 2) * 7 + 5) > 0.62 ? 0.25 + 0.45 * hash01(Math.floor(i / 2) * 11 + 9) : 0)), 0.3, DOME.radius * 0.984);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aShade', new THREE.BufferAttribute(new Float32Array(shade), 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, side: THREE.DoubleSide, forceSinglePass: true, ...flat,
      uniforms: { uDim: U.dim, uBg: U.bg, uGround: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uRim: { value: new THREE.Color() } } }));
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    return mesh;
  })();

  // 4 and 5. The horizon-frame figures: the five places, then the earned record, in one
  // buffer of line strips and one of stars, with a note of whose stretch is whose.
  const spans = {}, figLines = { pos: [], line: [] }, figStarPos = [];
  for (const pl of PLACES) {
    spans[pl.id] = { line0: figLines.pos.length / 12, star0: figStarPos.length / 3 };
    for (const [a, b] of pl.lines) {
      const [p, q] = trimmed(at(pl.stars[a][0], pl.stars[a][1], FIGURE_R), at(pl.stars[b][0], pl.stars[b][1], FIGURE_R), FIGURE.lineTrim);
      strip(figLines, p, q, FIGURE.lineHalf, false);
    }
    for (const [az, alt] of pl.stars) figStarPos.push(...at(az, alt, FIGURE_R));
    spans[pl.id].line1 = figLines.pos.length / 12;
    spans[pl.id].star1 = figStarPos.length / 3;
  }
  // Then Tonight's step stars (room for STEPS.max), the press ring, and the earned record.
  const FIG_LINES = figLines.pos.length / 12, FIG_STARS = figStarPos.length / 3, STEP0 = FIG_STARS, RING = STEP0 + STEPS.max, EARNED0 = RING + 1;
  const LINE_CAP = FIG_LINES + EARNED_LINES, POINT_CAP = EARNED0 + RECORD.maxStars;

  const lineGeo = new THREE.BufferGeometry();
  const linePos = new Float32Array(LINE_CAP * 12), lineLine = new Float32Array(LINE_CAP * 12), lineCol = new Float32Array(LINE_CAP * 16);
  linePos.set(figLines.pos); lineLine.set(figLines.line);
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute('aLine', new THREE.BufferAttribute(lineLine, 3));
  lineGeo.setAttribute('aCol', new THREE.BufferAttribute(lineCol, 4));
  lineGeo.setAttribute('aKeep', new THREE.BufferAttribute(new Float32Array(LINE_CAP * 4), 1));
  lineGeo.setIndex(quadIndex(LINE_CAP));
  lineGeo.setDrawRange(0, FIG_LINES * 6);
  const lines = new THREE.Mesh(lineGeo, lineMat());
  lines.renderOrder = 4;
  lines.frustumCulled = false;

  const figGeo = new THREE.BufferGeometry();
  const figPos = new Float32Array(POINT_CAP * 3), figSize = new Float32Array(POINT_CAP), figTint = new Float32Array(POINT_CAP * 4), figLook = new Float32Array(POINT_CAP);
  figPos.set(figStarPos);
  figLook[RING] = 2;
  figGeo.setAttribute('position', new THREE.BufferAttribute(figPos, 3));
  figGeo.setAttribute('aSize', new THREE.BufferAttribute(figSize, 1));
  figGeo.setAttribute('aTint', new THREE.BufferAttribute(figTint, 4));
  figGeo.setAttribute('aLook', new THREE.BufferAttribute(figLook, 1));
  figGeo.setAttribute('aKeep', new THREE.BufferAttribute(new Float32Array(POINT_CAP), 1));
  figGeo.setDrawRange(0, EARNED0);
  const figStars = new THREE.Points(figGeo, new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, ...flat,
    uniforms: { uScale: U.scale, uMaxPoint: U.maxPoint, uDim: U.dim, uOthers: U.others, uHalo: U.halo } }));
  figStars.renderOrder = 5;
  figStars.frustumCulled = false;

  // 6. The moon: Tonight's centrepiece. Its lit share is the share of today's steps done
  // (review 6, finding 5), painted on a small 2D canvas in the theme's own colours (no image
  // files) and painted again whenever the share or the theme changes.
  const moonPlace = PLACES.find((p) => p.figure === 'moon');
  const moonCanvas = document.createElement('canvas');
  moonCanvas.width = moonCanvas.height = 256;
  const MOON_DISC = 54;                 // px radius of the disc inside the 256 px texture
  const PLAIN_SHARE = 0.27;             // nobody has said how today is going: a waxing crescent
  let today = null, moonShown = -1;
  function paintMoon(share) {
    const g = moonCanvas.getContext('2d'), c = 128, R = MOON_DISC;
    // Token colours at part strength (the tokens are the only source of colour here).
    const ink = (col, a) => `color-mix(in srgb, ${col.getStyle()} ${Math.round(a * 1000) / 10}%, transparent)`;
    const bodyInk = (a) => ink(colours.moon, a);
    g.clearRect(0, 0, 256, 256);
    g.shadowBlur = 0; g.globalAlpha = 1;
    // A halo that falls away quickly, then slowly; and the dark side, just showing.
    const litInk = (al) => ink(pale ? colours.moonlit : colours.moon, al), shadeInk = (al) => ink(pale ? colours.gold : colours.moon, al);
    for (const [reach, strength] of pale ? MOON.haloPale : MOON.halo) {
      const halo = g.createRadialGradient(c, c, R * 0.8, c, c, reach);
      // Many small stops on a smooth curve: two or three stops left visible rings.
      for (let t = 0; t <= 1.0001; t += 0.125) halo.addColorStop(Math.min(1, t), litInk(strength * (1 - t) ** 2.2));
      g.fillStyle = halo; g.fillRect(0, 0, 256, 256);
    }
    g.fillStyle = shadeInk(pale ? MOON.darkPale : MOON.dark);
    g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();
    // The lit part: the left limb, closed by the terminator, which is half an ellipse.
    // It bows to the left for a crescent and to the right once past half.
    const k = Math.min(1, Math.max(0, share));
    if (k > 0.004) {
      const litPath = () => {
        g.beginPath();
        g.arc(c, c, R, -Math.PI / 2, Math.PI / 2, true);
        g.ellipse(c, c, Math.max(0.01, R * Math.abs(1 - 2 * k)), R, 0, Math.PI / 2, -Math.PI / 2, k > 0.5);
        g.closePath();
      };
      g.fillStyle = litInk(pale ? MOON.litPale : MOON.lit); g.shadowColor = litInk(1); g.shadowBlur = 6;
      litPath(); g.fill();
      g.shadowBlur = 0;
      // Its face: a little darker towards the edge and a few faint seas, so it is a ball
      // and not a sticker. Drawn only inside the lit part, in the shade's own colour.
      g.save(); litPath(); g.clip();
      const limb = g.createRadialGradient(c - R * 0.2, c - R * 0.15, R * 0.35, c, c, R);
      const tone = (al) => pale ? shadeInk(al * MOON.facePale) : ink(colours.bg, Math.min(1, al * 1.8));      // Dusk shades towards the page's own dark
      limb.addColorStop(0, tone(0)); limb.addColorStop(1, tone(MOON.limb));
      g.fillStyle = limb; g.fillRect(0, 0, 256, 256);
      for (const [x, y, r, strength] of MOON.seas) {
        const sea = g.createRadialGradient(c + x * R, c + y * R, 0, c + x * R, c + y * R, r * R);
        sea.addColorStop(0, tone(strength)); sea.addColorStop(0.6, tone(strength * 0.7)); sea.addColorStop(1, tone(0));
        g.fillStyle = sea; g.fillRect(0, 0, 256, 256);
      }
      g.restore();
    }
    if (pale) {
      // Ink on a light sky: a thin edge holds the whole disc, lit part and shade alike.
      g.strokeStyle = shadeInk(MOON.edgePale); g.lineWidth = MOON.edgePx;
      g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.stroke();
    }
    if (today && k >= 1) {
      // Every step done: the gold rim. A second sign beside the count in the label's words.
      g.strokeStyle = ink(colours.gold, MOON.rim); g.lineWidth = MOON.rimPx;
      g.beginPath(); g.arc(c, c, R + MOON.rimPx / 2 + 1, 0, Math.PI * 2); g.stroke();
    }
    moonShown = share;
    moonTex.needsUpdate = true;
  }
  const moonTex = new THREE.CanvasTexture(moonCanvas);
  moonTex.colorSpace = THREE.SRGBColorSpace;
  const moonSize = 2 * FIGURE_R * Math.tan((moonPlace.moonDeg / 2) * Math.PI / 180) * (128 / MOON_DISC);
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(moonSize, moonSize), new THREE.MeshBasicMaterial({ map: moonTex, ...flat }));
  moon.position.set(...at(moonPlace.az, moonPlace.alt, FIGURE_R));
  moon.lookAt(0, 0, 0);
  moon.renderOrder = 6;

  scene.add(sky, starSphere, ground, lines, figStars, moon);

  // ---- eases: everything alive moves towards a goal, a little each frame -------------
  const hover = Object.fromEntries(PLACES.map((p) => [p.id, { now: 0, goal: 0 }]));
  // keep: 1 for the place you are inside (its figure is not dimmed), 0 for the rest.
  const keep = Object.fromEntries(PLACES.map((p) => [p.id, { now: 0, goal: 0 }]));
  const ease = { today: { now: PLAIN_SHARE, goal: PLAIN_SHARE }, pointer: { now: 0, goal: 0 }, voice: { now: 0, goal: 0 }, twinkle: { now: 0, goal: 0 }, parallax: { now: 0, goal: 0 }, keep: { now: 1.1, goal: 1.1 }, earned: { now: 0, goal: 0 } };
  let twinkleWanted = false, pointerWanted = false, ring = null, voiceAltGoal = null, voiceAlt = 30, time = 0;
  const towards = (e, dtMs, ms) => {
    if (e.now === e.goal) return false;
    const step = Math.max(0, dtMs) / ms;
    e.now = e.goal > e.now ? Math.min(e.goal, e.now + step) : Math.max(e.goal, e.now - step);
    return true;
  };
  function goals() {
    const t = QUALITY.tiers[tier];
    ease.twinkle.goal = twinkleWanted && !calm ? t.twinkle : 0;
    ease.parallax.goal = calm ? 0 : t.parallax;
    // 1.1 = every star (the fade edge sits past the faintest); less thins from the faint end.
    ease.keep.goal = t.keep >= 1 ? 1.1 : t.keep;
    ease.pointer.goal = pointerWanted && !calm ? t.pointer : 0;
  }

  let earnedStars = 0, earnedLines = 0, earnedMeta = [], earnedLineMeta = [];

  function paintFigures() {
    const tint = figGeo.attributes.aTint, sz = figGeo.attributes.aSize, lc = lineGeo.attributes.aCol, pk = figGeo.attributes.aKeep, lk = lineGeo.attributes.aKeep;
    // At rest a figure carries a share of the accent, so it is plainly not a field star.
    mixInto(scratch2, colours.figure, colours.accent, pale ? FIGURE.accentRestPale : FIGURE.accentRest);
    const lerp = ([from, to], t) => from + (to - from) * t;
    for (const pl of PLACES) {
      const s = spans[pl.id], t = hover[pl.id].now, k = keep[pl.id].now;
      mixInto(scratch, scratch2, colours.accent, t);
      // Hover lifts it the rest of the way: full accent, brighter lines, larger stars.
      for (let i = s.line0 * 4; i < s.line1 * 4; i++) { lc.setXYZW(i, scratch.r, scratch.g, scratch.b, lerp(FIGURE.lineAlpha, t)); lk.setX(i, k); }
      for (let i = s.star0; i < s.star1; i++) { tint.setXYZW(i, scratch.r, scratch.g, scratch.b, lerp(FIGURE.starAlpha, t)); sz.setX(i, FIGURE.starPx * (1 + FIGURE.hoverGrow * t)); pk.setX(i, k); }
      // The moon's texture is already in the theme's colours: the material only tints it.
      if (pl.figure === 'moon') { moon.material.color.setRGB(1, 1, 1).lerp(colours.accent, t * (pale ? MOON.hoverAccentPale : MOON.hoverAccent)); moon.scale.setScalar(1 + MOON.hoverScale * t); }
    }
    lc.needsUpdate = tint.needsUpdate = sz.needsUpdate = pk.needsUpdate = lk.needsUpdate = true;
  }
  // Tonight's step stars: one per step of today's session, in an arc under the moon.
  function paintSteps() {
    const tint = figGeo.attributes.aTint, sz = figGeo.attributes.aSize, pk = figGeo.attributes.aKeep;
    const n = today ? today.total : 0, hoverT = hover[moonPlace.id].now;
    // The next step breathes slowly on the twinkle's clock, so it is still whenever the
    // twinkle is (Calm motion, a resting sky, a lowered quality tier).
    const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * time / STEP.breatheS);
    mixInto(scratch, colours.figure, colours.accent, Math.max(pale ? FIGURE.accentRestPale : FIGURE.accentRest, hoverT));
    for (let i = 0; i < STEPS.max; i++) {
      const at = STEP0 + i, done = i < (today?.done ?? 0), next = !!today && i === today.done;
      const c = done ? colours.gold : scratch;
      const alpha = i >= n ? 0 : done ? STEP.doneAlpha : next ? STEP.nextAlpha * (1 - STEP.breatheDim * (1 - breath)) : STEP.laterAlpha;
      tint.setXYZW(at, c.r, c.g, c.b, alpha);
      sz.setX(at, i >= n ? 0 : STEP.px * (next ? 1 + STEP.breatheGrow * breath : 1));
      figLook[at] = done ? 0 : 1;
      pk.setX(at, keep[moonPlace.id].now);
    }
    tint.needsUpdate = sz.needsUpdate = pk.needsUpdate = figGeo.attributes.aLook.needsUpdate = true;
  }
  function setToday(next) {
    const ok = next && Number.isFinite(next.done) && Number.isFinite(next.total) && next.total >= 1;
    const before = today;
    today = ok ? { total: Math.min(STEPS.max, Math.round(next.total)), done: 0 } : null;
    if (today) today.done = Math.min(today.total, Math.max(0, Math.round(next.done)));
    // The lit edge glides to its new place (EASE_MS.today for the whole moon): a share of
    // the brightest thing in the sky must never change in one frame.
    ease.today.goal = today ? today.done / today.total : PLAIN_SHARE;
    if (today && today.total !== before?.total) {
      stepStars(today.total, moonPlace).forEach(([az, alt], i) => figPos.set(at(az, alt, FIGURE_R), (STEP0 + i) * 3));
      figGeo.attributes.position.needsUpdate = true;
    }
    paintSteps();
  }
  function paintRing() {
    const tint = figGeo.attributes.aTint, sz = figGeo.attributes.aSize;
    // Opens quickly, then slows, fading all the way: a ripple, never a blink.
    const u = ring ? ring.u : 1, open = 1 - (1 - u) ** 3;
    sz.setX(RING, PRESS.ringPx[0] + (PRESS.ringPx[1] - PRESS.ringPx[0]) * open);
    tint.setXYZW(RING, colours.accent.r, colours.accent.g, colours.accent.b, ring ? PRESS.ringAlpha * Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - u) * 2 : 0);
    // The stars round the press lift and settle with the ring.
    starMat.uniforms.uPressAmt.value = ring ? Math.sin(Math.PI * u) : 0;
    tint.needsUpdate = sz.needsUpdate = true;
  }
  function paintEarned() {
    const tint = figGeo.attributes.aTint, sz = figGeo.attributes.aSize, lc = lineGeo.attributes.aCol, pk = figGeo.attributes.aKeep, lk = lineGeo.attributes.aKeep;
    // The record is Your Sky's own figure: inside Your Sky it stays lit.
    const a = ease.earned.now, k = keep.progress?.now ?? 0;
    for (let i = 0; i < earnedStars; i++) {
      const c = earnedMeta[i] ? colours.gold : colours.figure;
      tint.setXYZW(EARNED0 + i, c.r, c.g, c.b, (earnedMeta[i] ? EARNED.goldAlpha : EARNED.plainAlpha) * a);
      sz.setX(EARNED0 + i, EARNED.starPx);
      pk.setX(EARNED0 + i, k);
    }
    for (let i = 0; i < earnedLines; i++) {
      const c = earnedLineMeta[i] ? colours.gold : colours.figure;
      for (let v = 0; v < 4; v++) { lc.setXYZW((FIG_LINES + i) * 4 + v, c.r, c.g, c.b, (earnedLineMeta[i] ? EARNED.goldLine : EARNED.plainLine) * a); lk.setX((FIG_LINES + i) * 4 + v, k); }
    }
    lc.needsUpdate = tint.needsUpdate = sz.needsUpdate = pk.needsUpdate = lk.needsUpdate = true;
  }
  function paintCatalogue() {
    if (!catFigures) return;
    const lc = catFigures.geometry.attributes.aCol;
    for (let i = 0; i < lc.count; i++) lc.setXYZW(i, colours.figure.r, colours.figure.g, colours.figure.b, 0.3);
    lc.needsUpdate = true;
  }

  function setEarned(list) {
    const items = Array.isArray(list) ? list.filter((it) => it && Array.isArray(it.points)) : [];
    // Newest last in, newest kept: walk from the end until the buffers are full.
    const kept = [];
    let nStars = 0;
    for (let i = items.length - 1; i >= 0 && nStars + items[i].points.length <= RECORD.maxStars; i--) { kept.unshift(items[i]); nStars += items[i].points.length; }
    const out = { pos: [], line: [] };
    earnedMeta = []; earnedLineMeta = [];
    let s = 0;
    for (const it of kept) {
      const pts = it.points.map(([az, alt]) => at(az, alt, FIGURE_R));
      pts.forEach((p) => { figPos.set(p, (EARNED0 + s) * 3); figLook[EARNED0 + s] = it.lit === false ? 1 : 0; earnedMeta[s] = !!it.gold; s++; });
    }
    // Lines go to the newest constellations first (at most EARNED_LINES pieces in all).
    for (let i = kept.length - 1; i >= 0; i--) {
      const pts = kept[i].points.map(([az, alt]) => at(az, alt, FIGURE_R));
      if (earnedLineMeta.length + pts.length - 1 > EARNED_LINES) break;
      for (let k = 0; k + 1 < pts.length; k++) {
        const [p, q] = trimmed(pts[k], pts[k + 1], 1.0);
        strip(out, p, q, EARNED.lineHalf, kept[i].lit === false);
        earnedLineMeta.push(!!kept[i].gold);
      }
    }
    earnedStars = s; earnedLines = earnedLineMeta.length;
    linePos.set(out.pos, FIG_LINES * 12); lineLine.set(out.line, FIG_LINES * 12);
    lineGeo.attributes.position.needsUpdate = lineGeo.attributes.aLine.needsUpdate = true;
    figGeo.attributes.position.needsUpdate = figGeo.attributes.aLook.needsUpdate = true;
    lineGeo.setDrawRange(0, (FIG_LINES + earnedLines) * 6);
    figGeo.setDrawRange(0, EARNED0 + earnedStars);
    // New stars arrive by fading in, never by popping.
    ease.earned.now = 0; ease.earned.goal = earnedStars ? 1 : 0;
    paintEarned();
  }

  function setTheme() {
    const css = getComputedStyle(canvas);
    // Colours come from the tokens only (no raw values in code). If css/sky.css is missing,
    // the nearest app token stands in, so the dome is plain but never unstyled.
    const read = (name, standIn) => new THREE.Color((css.getPropertyValue(name) || '').trim() || (css.getPropertyValue(standIn) || '').trim() || 'gray');
    colours.zenith = read('--sky-zenith', '--stage');
    colours.horizon = read('--sky-horizon', '--stage-top');
    colours.ground = read('--sky-ground', '--bg');
    colours.text = read('--text', '--text');
    colours.accent = read('--accent', '--text');
    colours.gold = read('--gold', '--text');
    colours.bg = read('--bg', '--sky-ground');
    colours.moonlit = read('--sky-moonlit', '--text');
    skyDim = Math.min(1, Math.max(0, parseFloat(css.getPropertyValue('--sky-dim')) || 0.35));
    // On a pale (Dawn) sky light has nothing to add to: stars are plain ink dots at half
    // strength, drawn over the sky, not added to it.
    pale = colours.zenith.getHSL({}).l > 0.5;
    colours.figure = colours.text;
    colours.moon = pale ? colours.gold : colours.text;       // the gold rim and (Dawn) the shade use this; Dawn's lit part is colours.moonlit
    const blend = pale ? THREE.NormalBlending : THREE.AdditiveBlending;
    for (const m of [starMat, lines.material, figStars.material, moon.material, catFigures?.material]) if (m) { m.blending = blend; m.needsUpdate = true; }
    U.halo.value = pale ? FIGURE.haloPale : 1;
    U.bg.value.copy(colours.bg);
    starMat.uniforms.uInk.value.copy(colours.text);
    starMat.uniforms.uTemp.value = pale ? 0 : 1;
    starMat.uniforms.uAlpha.value = pale ? STAR.paleAlpha : 1;
    skyMat.uniforms.uZenith.value.copy(colours.zenith);
    skyMat.uniforms.uHorizon.value.copy(colours.horizon);
    skyMat.uniforms.uAccent.value.copy(colours.accent);
    skyMat.uniforms.uGlow.value = pale ? 0 : 1;
    const warm = pale ? SKY.warmPale : SKY.warm;
    skyMat.uniforms.uWarm.value.copy(colours.gold);
    skyMat.uniforms.uWarmAmt.value = warm[0];
    skyMat.uniforms.uWarmFall.value = warm[1];
    skyMat.uniforms.uMilkyWarm.value = pale ? 0 : SKY.milkyWarm;
    starMat.uniforms.uLiftCap.value = pale ? 1 : 1.5;
    mixInto(ground.material.uniforms.uRim.value, colours.accent, colours.gold, 0.35);
    // Dusk: a pale river of light. Dawn: only a warm stain of the horizon's colour.
    mixInto(skyMat.uniforms.uMilkyCol.value, pale ? colours.horizon : colours.text, colours.accent, pale ? 0 : SKY.milkyAccent);
    // (Kept faint: at 0.15 its bright clouds, pushed outwards by the zoom of a travel,
    // changed a 48 px cell by 0.153 in 120 ms, over the 0.15 flash limit.)
    skyMat.uniforms.uMilky.value = pale ? SKY.milkyPale : SKY.milky;
    ground.material.uniforms.uGround.value.copy(colours.ground);
    ground.material.uniforms.uHorizon.value.copy(colours.horizon);
    renderer.setClearColor(colours.ground, 1);
    applyDim();
    paintMoon(ease.today.now);
    paintFigures(); paintSteps(); paintRing(); paintEarned(); paintCatalogue();
  }
  function applyDim() {
    U.dim.value = 1 - (1 - skyDim) * inside;
    // On the way into a place the OTHER places' figures (and the moon, unless Tonight is
    // the place) leave with their labels, over the same 200 ms: a lit figure swept across
    // the window by the turning camera put four or five bright lines through one spot in
    // under half a second (8 opposing brightness changes a second in one 48 px cell,
    // labs/sky-lab.html "flash-travel"). They come back as you return.
    let kept = 0;
    for (const k of Object.values(keep)) kept = Math.max(kept, k.now);
    U.others.value = 1 - kept * (1 - FIGURE.othersInside);
    const rest = U.dim.value * U.others.value;
    moon.material.opacity = rest + (1 - rest) * keep[moonPlace.id].now;
    // Inside a place the clear colour (seen under the hills) dims with everything else.
    renderer.setClearColor(scratch.copy(colours.bg).lerp(colours.ground, U.dim.value), 1);
  }
  function applySize() {
    pixelRatio = Math.min(QUALITY.tiers[tier].pixelRatio, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(size.w, size.h, false);   // false: CSS sizes the canvas, not three
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
    applyScale();
  }
  // Sprites keep their size in CSS px and grow with the zoom when travelling into a place.
  function applyScale() { U.scale.value = pixelRatio * Math.tan(Math.PI / 6) / Math.tan(camera.fov * Math.PI / 360); }

  const onContextLost = (e) => { e.preventDefault(); lost = true; onLost?.(); };
  const onContextRestored = () => { lost = false; onRestored?.(); };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  setStars(null);
  setSky(null);
  setTheme();
  goals();
  ease.parallax.now = ease.parallax.goal;

  return {
    resize(w, h) { size = { w: Math.max(1, w), h: Math.max(1, h) }; applySize(); },
    setCamera(cam) {
      camera.rotation.y = -cam.yaw * Math.PI / 180;
      camera.rotation.x = cam.pitch * Math.PI / 180;
      if (camera.fov !== cam.fov) { camera.fov = cam.fov; camera.updateProjectionMatrix(); applyScale(); }
      starMat.uniforms.uLook.value.set(...skyVector(cam.yaw, cam.pitch));
    },
    setInside(into) { inside = Math.min(1, Math.max(0, into || 0)); applyDim(); },
    setTheme,
    setCalm(on) { calm = !!on; goals(); if (calm) { ring = null; paintRing(); } },
    setHover(id) { for (const pl of PLACES) hover[pl.id].goal = pl.id === id ? 1 : 0; },
    setLit(id) { for (const pl of PLACES) keep[pl.id].goal = pl.id === id ? 1 : 0; },
    setToday,
    setPointer(dir) {
      pointerWanted = Array.isArray(dir);
      if (pointerWanted) starMat.uniforms.uPointer.value.set(dir[0], dir[1], dir[2]);
      goals();
    },
    press(dir) {
      if (calm || !Array.isArray(dir)) return;
      figPos.set([dir[0] * FIGURE_R, dir[1] * FIGURE_R, dir[2] * FIGURE_R], RING * 3);
      figGeo.attributes.position.needsUpdate = true;
      starMat.uniforms.uPress.value.set(dir[0], dir[1], dir[2]);
      ring = { u: 0 };
      paintRing();
    },
    setTwinkle(on) { twinkleWanted = !!on; goals(); },
    setQuality(name) {
      if (!QUALITY.tiers[name] || name === tier) return;
      tier = name;
      goals();
      applySize();
    },
    setStars,
    setSky,
    setVoice(v) {
      const on = v && Number.isFinite(v.level) && Number.isFinite(v.midi) && v.level > 0;
      ease.voice.goal = on ? Math.min(1, v.level) : 0;
      if (on) {
        voiceAltGoal = noteAlt(v.midi);
        if (ease.voice.now === 0) voiceAlt = voiceAltGoal;      // a fresh note starts at its own height
      }
    },
    setEarned,
    setMicLive(on) { micLive = !!on; },
    tick(dtMs) {
      const dt = Math.max(0, Math.min(100, dtMs));
      let busy = false, figures = false;
      for (const h of Object.values(hover)) if (towards(h, dtMs, EASE_MS.hover)) { figures = true; busy = busy || h.now !== h.goal; }
      let lit = false;
      for (const k of Object.values(keep)) if (towards(k, dtMs, EASE_MS.lit)) { lit = true; busy = busy || k.now !== k.goal; }
      if (lit) { applyDim(); paintEarned(); }
      if (figures || lit) { paintFigures(); paintSteps(); }
      if (towards(ease.today, dtMs, EASE_MS.today)) busy = busy || ease.today.now !== ease.today.goal;
      if (ease.today.now !== moonShown) paintMoon(ease.today.now);
      for (const key of ['pointer', 'twinkle', 'parallax', 'keep']) if (towards(ease[key], dtMs, EASE_MS[key])) busy = busy || ease[key].now !== ease[key].goal;
      if (towards(ease.earned, dtMs, EASE_MS.earned)) { paintEarned(); busy = busy || ease.earned.now !== ease.earned.goal; }
      towards(ease.voice, dtMs, ease.voice.goal > ease.voice.now ? EASE_MS.voiceUp : EASE_MS.voiceDown);
      if (ease.voice.now > 0 || ease.voice.goal > 0) {
        // The band glides to a new note (a 250 ms time constant) so a jump in pitch never
        // jumps the light.
        if (voiceAltGoal != null) voiceAlt += (voiceAltGoal - voiceAlt) * (1 - Math.exp(-dt / 250));
        if (!calm) U.ripple.value = (U.ripple.value + dt * 0.0015) % (Math.PI * 2);
        busy = true;
      }
      if (ring) { ring.u += dt / EASE_MS.ring; if (ring.u >= 1) ring = null; paintRing(); busy = busy || !!ring; }
      if (ease.twinkle.now > 0) {
        time += dt / 1000;
        if (today && today.done < today.total) paintSteps();      // the next step's slow breath
      }
      starMat.uniforms.uTime.value = time;
      starMat.uniforms.uTwinkle.value = ease.twinkle.now;
      starMat.uniforms.uParallax.value = ease.parallax.now;
      starMat.uniforms.uKeep.value = ease.keep.now;
      starMat.uniforms.uPointerAmt.value = ease.pointer.now;
      U.pointerAmt.value = ease.pointer.now;
      U.voiceAmt.value = ease.voice.now;
      U.voiceY.value = Math.sin(voiceAlt * Math.PI / 180);
      return busy;
    },
    render() {
      if (lost) return 0;
      // Section 9: with a microphone live the dome does not draw, whoever asks.
      if (micLive) { blocked++; return 0; }
      const t0 = performance.now();
      renderer.render(scene, camera);
      frames++;
      return performance.now() - t0;
    },
    snapshot(target) {
      if (lost || micLive) return;
      const g = target.getContext('2d');
      if (target.width !== canvas.width || target.height !== canvas.height) { target.width = canvas.width; target.height = canvas.height; }
      // Must run in the same task as the render: the drawing buffer is not kept afterwards.
      renderer.render(scene, camera);
      g.drawImage(canvas, 0, 0);
    },
    debug: () => ({ frames, blocked, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      points: renderer.info.render.points, lines: renderer.info.render.lines, stars: starCount,
      starsShown: Math.round(starCount * Math.min(1, ease.keep.now)), catalogueFigures: catFigureCount, earned: { stars: earnedStars, lines: earnedLines },
      pixelRatio, renderer: rendererName, lost, dim: U.dim.value, tier, twinkle: ease.twinkle.now, parallax: ease.parallax.now, pointer: ease.pointer.now,
      voice: { level: ease.voice.now, alt: voiceAlt }, ring: ring ? ring.u : null, micLive, maxPoint,
      today: today ? { ...today } : null, moonLit: ease.today.now, others: U.others.value, kept: PLACES.find((pl) => keep[pl.id].goal === 1)?.id ?? null }),
    destroy() {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      for (const o of [sky, stars, catFigures, ground, lines, figStars, moon]) if (o) { o.geometry.dispose(); o.material.dispose(); }
      moonTex.dispose();
      renderer.dispose();
    },
  };
}
