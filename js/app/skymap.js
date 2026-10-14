// skymap.js — the pure half of the star dome (docs/design/specs/2026-10-12-sky-dome.md).
// Where each place sits, how a sky point lands on the window, whether a place's label is
// "open" (following its figure) or "docked" (an edge marker), where markers dock, and how
// the camera answers drag, swipe and keys. No DOM and no three.js: imports in Node, so
// tools/checks/skymap.check.mjs can prove the "never a guessing game" rule without a browser.
//
// ---------------------------------------------------------------------------------------
// CONTRACT
// Units: angles in DEGREES everywhere. Window positions in CSS px, origin top left, y down.
// Time in MILLISECONDS on one clock per turner (performance.now() in the page).
//
//   az   degrees around you: 0 = Tonight's direction, positive = to the right.
//   alt  degrees above the horizon (0 = horizon, 90 = straight up).
//   skyVector(az, alt) -> [x, y, z] unit vector: x = cos(alt)sin(az), y = sin(alt),
//                         z = -cos(alt)cos(az)   (three.js axes: -z ahead, +y up, +x right)
//   cam  { yaw, pitch, fov }: looks along skyVector(yaw, pitch); fov is the VERTICAL field.
//        In three.js: rotation.order 'YXZ', rotation.y = -yaw, rotation.x = pitch (radians).
//   vp   { w, h } window size in CSS px.
//
//   PLACES            the five places, in Tab order. One row = one place (frozen data).
//   HOME, LIMITS, TURN, DOME, PILL    the numbers of spec sections 3, 5 and 6.
//   wrap180(deg)      -> (-180, 180]
//   hfov(fov, w, h)   -> horizontal field of view in degrees
//   project(az, alt, cam, vp) -> { x, y, front, depth }. front false = behind the camera
//                     plane; x and y are then meaningless (do not draw from them).
//   safeBox(vp)       -> { left, top, right, bottom }
//   domeFits(vp)      -> false under 900 px wide or 640 px tall (plain links instead)
//   pillSize(place, shape, vp) -> { w, h } an ESTIMATE for Node; the page passes real sizes
//   layout(cam, vp, { prev?, sizes? }) -> one entry per place, in PLACES order:
//       { id, shape: 'open' | 'docked', edge: null | 'left' | 'right' | 'top' | 'bottom',
//         arrow: null | 'left' | 'right' | 'up' | 'down' | 'around', behind, words,
//         x, y, w, h (the pill's box), ax, ay, front (the projected anchor), sep (degrees
//         between the camera's aim and the anchor) }
//     prev  = the previous layout() result: gives the 24 px hysteresis. Omit for a fresh view.
//     sizes = { [id]: { open: {w,h}, docked: {w,h}, behind: {w,h} } } measured pill sizes.
//     Invariants (checked over every yaw and pitch at five window sizes): every place is
//     open or docked; every box is inside the window; no two boxes overlap.
//   accessibleName(place, state, entry) -> "The Ladder, practice, 2 of 6 tried, to the left"
//   facing(entries, vp) -> id of the open place nearest the middle, or null
//   homeTurnMs(degrees) -> ms;  travelMs(degrees) -> ms;  travelEase(u, ms) -> 0..1: a glide
//       never turns faster than TRAVEL.maxDegS degrees a second at ANY moment, and speeds up
//       and slows down over TRAVEL.rampMs (review 6: a sweep is judged by its speed)
//   createTurner({ cam?, calm?, height? }) -> the camera state machine (see below)
//   unproject(x, y, cam, vp) -> { az, alt, dir: [x, y, z] }   the sky point under a window point
//   placeNear(az, alt, withinDeg = 7) -> id of the place whose figure is there, or null
//   noteAlt(midi, { lo, hi }) -> alt in [10, 62]: the voice band's height = the note (section 10.2)
//   earnedRange(midis) -> { lo, hi }   padded by 2 notes, at least 12 apart; no data = 45..69
//   earnedSky(rounds) -> { items: [{ id, lit, gold, cell: [az, alt], points: [[az, alt], ...] }],
//                          range, total, shown, grid: { cell, cols, rows, room } }
//       rounds = [{ id, night (whole number, larger = later), lit?, clean?, notes: [midi, ...] }]
//       the shape dome.setEarned() takes. Each round gets its own square cell of sky behind
//       you (oldest top left, newest last); inside it the notes run left to right as sung and
//       a higher note is a higher star. gold = clean (or, when `clean` is not given, the
//       newest night). total counts every note; shown = rounds placed (the newest `room`).
//   earnedGrid(n) -> { cell (degrees), cols, rows, room }
//   STEPS, stepStars(n, at?) -> [[az, alt], ...]   Tonight's step stars, an arc under the moon
//   ANCHOR_STARS      hand-placed bright stars of the made-up sky: [az, alt, mag, colour]
//   QUALITY, createGuard() -> { push(gapMs) -> new tier name or null, tier(), skip(), reset() }
//   STAR CATALOGUE (the shape dome.setStars() takes; a real-sky module can supply the same):
//       { stars: [{ ra, dec, mag, colour?, name? }], figures: [{ id, name, lines: [[a, b]] }],
//         milkyWay?: { ra, dec } (the band's pole) }
//       ra, dec in degrees on the celestial sphere; mag = visual magnitude (smaller = brighter);
//       colour = B-V colour index (-0.3 blue-white .. 1.8 orange-red), optional.
//   proceduralStars({ count?, seed?, anchors? }) -> a made-up catalogue of that shape (the
//       default sky): `count` seeded stars, then the hand-placed `anchors` (ANCHOR_STARS)
//   celestialVector(ra, dec) -> unit vector in the star sphere's own frame (= skyVector(-ra, dec):
//       with no rotation the celestial pole is the zenith, ra 0 is Tonight's direction and ra
//       grows to the LEFT, as it does in the real sky seen from inside; so every real
//       date, time and place is a pure rotation of this frame, never a mirror image)
//   skyRotation({ lst, latitude, north = 0 } | { rotation } | null) -> 9 numbers, row-major:
//       the matrix that turns a star-sphere vector into a dome vector. lst = local sidereal
//       time in DEGREES, latitude in degrees, north = the dome az that is compass north.
//       Places, labels and edge markers never use it: they belong to the viewer's horizon.
//   rotate(m, v) -> m x v
//
// Failure behaviour: nothing here throws on odd numbers. project() behind the camera says
// front:false; layout() with a tiny window still returns five boxes (they may then overlap:
// callers use domeFits() first and show plain links).
// ---------------------------------------------------------------------------------------

const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const HOME = Object.freeze({ yaw: 0, pitch: 20, fov: 60 });
export const DOME = Object.freeze({ radius: 100, near: 0.1, far: 300 });

export const LIMITS = Object.freeze({
  pitchMin: 8, pitchMax: 74,
  rubberDeg: 6,        // how far past a limit a drag may pull
  rubberGain: 0.3,     // share of the hand's movement that gets through past a limit
  springMs: 320,
});

export const TURN = Object.freeze({
  dragStartPx: 5,          // less is a click and does nothing
  coastWindowMs: 80, coastMaxDegS: 240, coastTauS: 0.3, coastStopDegS: 2,
  tapMs: 200, holdAfterMs: 250, rampMs: 150,
  yawTapDeg: 15, pitchTapDeg: 10, yawRateDegS: 70, pitchRateDegS: 45,
  // Calm motion: holding a key repeats steps. The gap is longer than the 200 ms cross-fade
  // so each cut finishes before the next begins (nothing flashes).
  calmRepeatMs: 320,
  homeBaseMs: 300, homeMsPerDeg: 3.5, homeMaxMs: 900,
});

export const PILL = Object.freeze({
  margin: 12,          // markers sit this far from the window edge; open labels never closer
  gap: 8,              // between any two pills
  dockTop: 64,         // top-docked markers sit under the corner cluster's row
  dockBottom: 56,      // bottom-docked ones sit above the key hint
  hintClear: 40,       // open labels keep clear of the key hint line
  hysteresis: 24,      // a docked place opens only this far inside the safe box
  // The "behind you" marker docks low on its side edge, this far above the safe box's
  // bottom. At mid height (where it used to sit) it now lands on The Lyre or The Ladder,
  // which share the home view; down here there is only the ground.
  behindRise: 28,
});

// label: where the open label sits from the projected anchor. at 'below' = centred, top
// edge d px under it; 'right' = left edge d px to the right, vertically centred;
// 'left' = right edge d px to the left. `under` (degrees, 'below' only) measures d from the
// sky point that far below the anchor instead: what hangs under a figure (Tonight's step
// stars, the record's grid) is sized in degrees, so a px gap alone would be wrong at one
// window height or the other. `aside` (degrees, 'left' and 'right') does the same sideways:
// d is measured from the sky point that far to the label's side of the anchor, so a
// caption clears its figure's own stars at every window size.
//
// Review 6 (2026-10-12): a place nobody can see from home is a guessing game with arrows, so
// The Ladder, The Lyre and The Open Sky sit INSIDE the home view (85.5 x 60 degrees at every
// window size) and only Your Sky stays behind you. The Open Sky's anchor is the lower edge
// of its figure (alt 40, not the review's 42): at 1024 x 640 an anchor at 42 lands 96 px
// from the top, inside the 112 px a label needs to open, and the place would dock as a
// marker on top of its own figure.
const place = (row) => Object.freeze({ ...row, face: Object.freeze(row.face), label: Object.freeze(row.label),
  stars: Object.freeze((row.stars || []).map((s) => Object.freeze(s))), lines: Object.freeze((row.lines || []).map((l) => Object.freeze(l))) });
const chain = (n) => Array.from({ length: n - 1 }, (_, i) => [i, i + 1]);

// Tonight's centrepiece (review 6, finding 5): the moon is lit by the share of today's steps
// done, and one small star per step hangs in a shallow arc under it. Sized in degrees so the
// arc keeps its place under the moon at every window size. dome.setToday() draws them.
export const STEPS = Object.freeze({
  max: 8,              // step stars the dome keeps room for
  total: 5,            // the daily session's steps when nobody has said otherwise
  dropDeg: 6.3,        // the lowest star of the arc sits this far under the moon's centre
  sagDeg: 0.9,         // the arc's ends are this much higher than its middle
  spanDeg: 9,          // from the first star to the last, side to side
});
// Where step i of n sits: [az, alt]. One step sits straight under the moon.
export function stepStars(n = STEPS.total, at = { az: 0, alt: 22 }) {
  const count = clamp(Math.round(n) || 0, 0, STEPS.max);
  return Array.from({ length: count }, (_, i) => {
    const u = count > 1 ? i / (count - 1) * 2 - 1 : 0;      // -1 .. 1 across the arc
    return [at.az + u * STEPS.spanDeg / 2 / Math.cos(at.alt * RAD), at.alt - STEPS.dropDeg + STEPS.sagDeg * u * u];
  });
}

export const PLACES = Object.freeze([
  place({ id: 'today', name: 'Tonight', plain: 'Today’s five minutes', route: '#/today', az: 0, alt: 22,
    face: { yaw: 0, pitch: 20 }, label: { at: 'below', d: 14, under: STEPS.dropDeg + 1.2 }, figure: 'moon', moonDeg: 8 }),
  place({ id: 'practice', name: 'The Ladder', plain: 'Practice', route: '#/practice', az: -30, alt: 22,
    face: { yaw: -30, pitch: 20 }, label: { at: 'right', d: 22, aside: 4 }, figure: 'stars',
    // A real ladder: two rails and three rungs. Still one star per exercise, climbing rung
    // by rung from the horizon (left then right; the order is the exercise order).
    stars: [[-33, 10], [-27, 10], [-33, 20], [-27, 20], [-33, 30], [-27, 30]],
    lines: [[0, 2], [2, 4], [1, 3], [3, 5], [0, 1], [2, 3], [4, 5]] }),
  place({ id: 'sing', name: 'The Open Sky', plain: 'Free sing', route: '#/sing', az: 0, alt: 40,
    face: { yaw: 0, pitch: 34 }, label: { at: 'below', d: 48 }, figure: 'stars',
    // A wide open wave across the top of the home view.
    stars: [[-24, 40], [-8, 45], [8, 40], [24, 45]], lines: chain(4) }),
  place({ id: 'songs', name: 'The Lyre', plain: 'Songs', route: '#/songs', az: 30, alt: 22,
    face: { yaw: 30, pitch: 20 }, label: { at: 'left', d: 22, aside: 7.5 }, figure: 'stars',
    // A lyre: two horns that flare out above the crossbar, two arms that run down from the
    // crossbar's ends to a flat base, and one string down the middle, PARALLEL to the arms.
    // (First drawn it read as a kite; with two strings meeting at one base star, as a fan:
    // strings that converge to a point are a fan's ribs. A lyre's strings never meet, and
    // its silhouette is the horns standing past the crossbar.)
    // 0, 1 horn tips · 2, 3 crossbar ends · 4, 5 base corners · 6, 7 the string's ends.
    stars: [[24.5, 31], [35.5, 31], [26, 26.5], [34, 26.5], [28, 14], [32, 14], [30, 26.5], [30, 14]],
    lines: [[0, 2], [1, 3], [2, 6], [6, 3], [2, 4], [3, 5], [4, 7], [7, 5], [6, 7]] }),
  place({ id: 'progress', name: 'Your Sky', plain: 'Progress', route: '#/progress', az: 180, alt: 30,
    face: { yaw: 180, pitch: 30 }, label: { at: 'below', d: 8, under: 19 }, figure: 'none' }),
]);

export const DIRECTION_WORDS = Object.freeze({ left: 'to the left', right: 'to the right', top: 'above', bottom: 'below', behind: 'behind you' });

// ---- angles and projection -----------------------------------------------------------

export function wrap180(deg) {
  const r = ((deg + 180) % 360 + 360) % 360 - 180;
  return r === -180 ? 180 : r;
}

export function hfov(fov, w, h) {
  return 2 * Math.atan(Math.tan(fov * RAD / 2) * (w / h)) / RAD;
}

export function skyVector(az, alt) {
  const c = Math.cos(alt * RAD);
  return [c * Math.sin(az * RAD), Math.sin(alt * RAD), -c * Math.cos(az * RAD)];
}

// Degrees between two sky directions (great circle).
export function separation(az1, alt1, az2, alt2) {
  const a = skyVector(az1, alt1), b = skyVector(az2, alt2);
  return Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) / RAD;
}

export function project(az, alt, cam, vp) {
  // Work in the camera's own azimuth, so yaw needs no wrapping and cannot jump at ±180.
  const d = (az - cam.yaw) * RAD, a = alt * RAD, p = cam.pitch * RAD;
  const ca = Math.cos(a), sa = Math.sin(a), cp = Math.cos(p), sp = Math.sin(p);
  const right = ca * Math.sin(d);
  const up = sa * cp - ca * Math.cos(d) * sp;
  const depth = sa * sp + ca * Math.cos(d) * cp;
  const f = (vp.h / 2) / Math.tan(cam.fov * RAD / 2);
  const front = depth > 1e-6;
  return { x: vp.w / 2 + f * right / (front ? depth : 1e-6), y: vp.h / 2 - f * up / (front ? depth : 1e-6), front, depth };
}

export function safeBox(vp) {
  const side = vp.w < 1100 ? 96 : 120;
  return { left: side, top: 88, right: vp.w - side, bottom: vp.h - 96 };
}

export function domeFits(vp) {
  return vp.w >= 900 && vp.h >= 640;
}

// Between 900 and 1099 px wide the open label drops its third (state) line.
export function showsStateLine(vp) {
  return vp.w >= 1100;
}

// ---- open or docked ------------------------------------------------------------------

function inSafeBox(p, vp, inset) {
  const b = safeBox(vp);
  return p.front && p.x >= b.left + inset && p.x <= b.right - inset && p.y >= b.top + inset && p.y <= b.bottom - inset;
}

export function isOpen(pl, cam, vp, wasOpen = false) {
  // Leaving is judged at the line and arriving 24 px inside it, so a place on the line
  // cannot flicker between its two shapes.
  return inSafeBox(project(pl.az, pl.alt, cam, vp), vp, wasOpen ? 0 : PILL.hysteresis);
}

// Where an out-of-view place docks (spec section 5 table). `along` is the marker's centre
// along its edge: a y for left/right, an x for top/bottom.
export function dockFor(pl, cam, vp) {
  const dAz = wrap180(pl.az - cam.yaw), dAlt = pl.alt - cam.pitch;
  const halfH = hfov(cam.fov, vp.w, vp.h) / 2, halfV = cam.fov / 2;
  const b = safeBox(vp);
  const midX = (b.left + b.right) / 2, midY = (b.top + b.bottom) / 2;
  if (Math.abs(dAz) > 135) {
    return { edge: dAz > 0 ? 'right' : 'left', along: b.bottom - PILL.behindRise, arrow: 'around', behind: true };
  }
  if (Math.abs(dAz) / halfH >= Math.abs(dAlt) / halfV) {
    const along = midY - clamp(dAlt / halfV, -1, 1) * (b.bottom - b.top) / 2;
    return dAz < 0 ? { edge: 'left', along, arrow: 'left', behind: false } : { edge: 'right', along, arrow: 'right', behind: false };
  }
  const along = midX + clamp(dAz / halfH, -1, 1) * (b.right - b.left) / 2;
  return dAlt > 0 ? { edge: 'top', along, arrow: 'up', behind: false } : { edge: 'bottom', along, arrow: 'down', behind: false };
}

// Size guesses for Node (system-ui at the STYLE.md sizes, measured once in Chrome and
// rounded up). The page measures the real pills and passes them to layout().
export function pillSize(pl, shape, vp = { w: 1440, h: 800 }) {
  const longest = Math.max(pl.name.length * 11.5, pl.plain.length * 7.6);
  if (shape === 'open') return { w: Math.ceil(Math.max(longest, 190) + 24), h: showsStateLine(vp) ? 84 : 64 };
  const text = shape === 'behind' ? Math.max(pl.name.length * 9.2, (pl.plain.length + 13) * 7.6) : Math.max(pl.name.length * 9.2, pl.plain.length * 7.6);
  return { w: Math.ceil(text + 24 + 28), h: 48 };
}

const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// Slide a box along one axis to the nearest spot that touches nothing already placed.
// Nearest first, both ways, so a marker moves as little as possible.
function settle(box, axis, lo, hi, placed) {
  const free = (b) => placed.every((p) => !overlaps(b, p, PILL.gap));
  const start = clamp(box[axis], lo, Math.max(lo, hi));
  const at = (v) => ({ ...box, [axis]: v });
  if (free(at(start))) return at(start);
  for (let step = 4; step <= hi - lo + 4; step += 4) {
    for (const v of [start + step, start - step]) {
      if (v >= lo && v <= hi && free(at(v))) return at(v);
    }
  }
  return null;
}

export function layout(cam, vp, { prev = null, sizes = null } = {}) {
  const sizeOf = (pl, shape) => sizes?.[pl.id]?.[shape] || pillSize(pl, shape, vp);
  const was = (id) => !!prev && prev.find((e) => e.id === id)?.shape === 'open';
  const m = PILL.margin;

  const entries = PLACES.map((pl) => {
    const p = project(pl.az, pl.alt, cam, vp);
    const base = { id: pl.id, ax: p.x, ay: p.y, front: p.front, sep: separation(cam.yaw, cam.pitch, pl.az, pl.alt) };
    if (isOpen(pl, cam, vp, was(pl.id))) {
      const s = sizeOf(pl, 'open');
      const side = pl.label.at === 'right' ? 1 : pl.label.at === 'left' ? -1 : 0;
      const beside = side && pl.label.aside ? project(pl.az + side * pl.label.aside / Math.cos(pl.alt * RAD), pl.alt, cam, vp) : p;
      const from = beside.front ? beside.x : p.x;
      const x = side > 0 ? from + pl.label.d : side < 0 ? from - pl.label.d - s.w : p.x - s.w / 2;
      const hang = pl.label.under ? project(pl.az, pl.alt - pl.label.under, cam, vp) : p;
      const y = pl.label.at === 'below' ? (hang.front ? hang.y : p.y) + pl.label.d : p.y - s.h / 2;
      return { ...base, shape: 'open', edge: null, arrow: null, behind: false, words: '',
        x: clamp(x, m, Math.max(m, vp.w - m - s.w)), y: clamp(y, m, Math.max(m, vp.h - PILL.hintClear - s.h)), w: s.w, h: s.h };
    }
    const d = dockFor(pl, cam, vp);
    const s = sizeOf(pl, d.behind ? 'behind' : 'docked');
    const side = d.edge === 'left' || d.edge === 'right';
    const x = d.edge === 'left' ? m : d.edge === 'right' ? vp.w - m - s.w : d.along - s.w / 2;
    const y = d.edge === 'top' ? PILL.dockTop : d.edge === 'bottom' ? vp.h - PILL.dockBottom - s.h : d.along - s.h / 2;
    return { ...base, shape: 'docked', edge: d.edge, arrow: d.arrow, behind: d.behind,
      words: DIRECTION_WORDS[d.behind ? 'behind' : d.edge], axis: side ? 'y' : 'x', x, y, w: s.w, h: s.h };
  });

  // Open labels keep their spot (they belong to a figure). Markers go nearest-in-angle
  // first: the nearer one keeps its spot and the other is pushed along the edge.
  const order = entries.map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.shape === b.e.shape ? (a.e.shape === 'open' ? a.i - b.i : a.e.sep - b.e.sep || a.i - b.i) : a.e.shape === 'open' ? -1 : 1));
  const placed = [];
  for (const { e } of order) {
    const loY = e.shape === 'open' ? m : PILL.dockTop, hiY = vp.h - (e.shape === 'open' ? PILL.hintClear : PILL.dockBottom) - e.h;
    const loX = m, hiX = vp.w - m - e.w;
    const axis = e.shape === 'open' ? 'y' : e.axis;
    const [lo, hi] = axis === 'y' ? [loY, hiY] : [loX, hiX];
    // The other axis is a last resort (a very small window): better a marker slightly off
    // its edge than one on top of another.
    const spot = settle(e, axis, lo, hi, placed) || settle(e, axis === 'y' ? 'x' : 'y', axis === 'y' ? loX : loY, axis === 'y' ? hiX : hiY, placed);
    if (spot) { e.x = spot.x; e.y = spot.y; } else { e.x = clamp(e.x, loX, Math.max(loX, hiX)); e.y = clamp(e.y, loY, Math.max(loY, hiY)); }
    delete e.axis;
    placed.push(e);
  }
  return entries;
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// The link's spoken name: its three lines plus the direction word when it is out of view.
export function accessibleName(pl, state, entry) {
  return [pl.name, lowerFirst(pl.plain), state || '', entry?.words || ''].filter(Boolean).join(', ');
}

// The open place nearest the middle of the window ("Facing The Ladder"), or null.
export function facing(entries, vp) {
  let best = null, bestD = Infinity;
  for (const e of entries) {
    if (e.shape !== 'open') continue;
    const d = Math.hypot(e.ax - vp.w / 2, e.ay - vp.h / 2);
    if (d < bestD) { bestD = d; best = e.id; }
  }
  return best;
}

// ---- easing and timing ---------------------------------------------------------------

// A CSS cubic-bezier as a function, so key taps ease exactly like the tokens (--ease,
// --ease-in-out) that the pills use.
export function cubicBezier(x1, y1, x2, y2) {
  const bez = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (bez(mid, x1, x2) < x) lo = mid; else hi = mid; }
    return bez((lo + hi) / 2, y1, y2);
  };
}
export const EASE = cubicBezier(0.2, 0.8, 0.2, 1);
export const EASE_IN_OUT = cubicBezier(0.45, 0, 0.25, 1);

export function homeTurnMs(degrees) {
  return clamp(TURN.homeBaseMs + TURN.homeMsPerDeg * Math.abs(degrees), TURN.homeBaseMs, TURN.homeMaxMs);
}

export const clampPitch = (p) => clamp(p, LIMITS.pitchMin, LIMITS.pitchMax);

// What a drag shows when the hand has pulled to `raw` degrees: past a limit only 30 % gets
// through, for at most 6 degrees.
export function rubberPitch(raw) {
  if (raw > LIMITS.pitchMax) return LIMITS.pitchMax + Math.min(LIMITS.rubberDeg, (raw - LIMITS.pitchMax) * LIMITS.rubberGain);
  if (raw < LIMITS.pitchMin) return LIMITS.pitchMin - Math.min(LIMITS.rubberDeg, (LIMITS.pitchMin - raw) * LIMITS.rubberGain);
  return raw;
}

// ---- travel, pointer, the record, the quality guard, the star catalogue ----------------

// Travel comfort (review 6): a wide sweep is judged by its SPEED, not as a flash (64 degrees
// in 630 ms was about 100 degrees a second on average, and 250 at its fastest: the old
// curve's middle was steep). Now the camera speeds up over rampMs, turns at a steady
// maxDegS at most, and slows over rampMs: the FASTEST moment is capped, not the average.
// A short hop still takes baseMs, so closing in on a place never feels like a snap.
// throughDeg: a turn longer than this is not swept at all. At 60 degrees a second the half
// turn to Your Sky took 3.3 s of sky sliding past; now the camera cuts to face the place under
// the 200 ms cross-fade Calm motion already uses, and only the closing-in is a glide.
export const TRAVEL = Object.freeze({ fov: 34, baseMs: 500, rampMs: 260, maxDegS: 60, backMs: 500, fadeMs: 200, calmMs: 200, throughDeg: 90 });

export function travelMs(degrees) {
  return Math.max(TRAVEL.baseMs, Math.abs(degrees) / TRAVEL.maxDegS * 1000 + TRAVEL.rampMs);
}

// The glide's curve for a move of `ms`: progress 0..1 for time 0..1. Speed rises in a
// straight line over the ramp, holds, and falls the same way (two ramps meeting in the
// middle for a short move).
export function travelEase(u, ms) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const r = Math.min(0.5, TRAVEL.rampMs / Math.max(1, ms));
  if (u < r) return u * u / (2 * r * (1 - r));
  if (u > 1 - r) return 1 - (1 - u) * (1 - u) / (2 * r * (1 - r));
  return (u - r / 2) / (1 - r);
}

// The inverse of project(): which sky point is under a window point.
export function unproject(x, y, cam, vp) {
  const f = (vp.h / 2) / Math.tan(cam.fov * RAD / 2);
  const r = (x - vp.w / 2) / f, u = (vp.h / 2 - y) / f;
  const yw = cam.yaw * RAD, p = cam.pitch * RAD;
  const fwd = skyVector(cam.yaw, cam.pitch);
  const right = [Math.cos(yw), 0, Math.sin(yw)];
  const up = [-Math.sin(p) * Math.sin(yw), Math.cos(p), Math.sin(p) * Math.cos(yw)];
  const v = [0, 1, 2].map((i) => fwd[i] + r * right[i] + u * up[i]);
  const len = Math.hypot(v[0], v[1], v[2]);
  const dir = v.map((c) => c / len);
  return { az: wrap180(Math.atan2(dir[0], -dir[2]) / RAD), alt: Math.asin(clamp(dir[1], -1, 1)) / RAD, dir };
}

// Which place's figure a sky point is on: within `withinDeg` of its anchor or one of its stars.
export function placeNear(az, alt, withinDeg = 7) {
  let best = null, bestSep = withinDeg;
  for (const pl of PLACES) {
    if (pl.figure === 'none') continue;
    // The moon's step stars are part of Tonight: a press on one opens it too.
    for (const [a, b] of [[pl.az, pl.alt], ...pl.stars, ...(pl.figure === 'moon' ? stepStars(STEPS.total, pl) : [])]) {
      const sep = separation(az, alt, a, b);
      if (sep <= bestSep) { bestSep = sep; best = pl.id; }
    }
  }
  return best;
}

// lo .. altSpan: the voice band's height-by-note scale (noteAlt). The rest lays out Your Sky
// (review 6, finding 7): every round gets its own patch of sky, a square cell of cellDeg, in
// a block azSpan wide centred behind you between altFrom and altTo. More rounds than cells:
// the cells shrink (never under cellMinDeg), then only the newest rounds are placed.
export const RECORD = Object.freeze({ lo: 45, hi: 69, pad: 2, minSpan: 12, altMin: 10, altSpan: 52, maxStars: 2000,
  // altFrom 23 (was 13): facing Your Sky, the markers of the places behind you stack up the
  // right edge, 160 px tall and up to 272 px wide; at 1024 x 640 they lay over the lowest
  // row's end patches. The block now starts above them (two rows of 14 degree patches; a
  // third row, with smaller patches, from the eleventh round on).
  azMid: 180, azSpan: 70, altFrom: 23, altTo: 55, cellDeg: 14, cellMinDeg: 7,
  fill: 0.62,          // share of its cell a round's figure may span, so neighbours never touch
  minNotes: 7,         // a round spanning fewer notes than this is not stretched to fill its cell
  nudgeDeg: 0.5 });

export function noteAlt(midi, { lo = RECORD.lo, hi = RECORD.hi } = {}) {
  return RECORD.altMin + RECORD.altSpan * clamp((midi - lo) / Math.max(1e-9, hi - lo), 0, 1);
}

export function earnedRange(midis) {
  const ok = (midis || []).filter(Number.isFinite);
  if (!ok.length) return { lo: RECORD.lo, hi: RECORD.hi };
  let lo = Math.min(...ok) - RECORD.pad, hi = Math.max(...ok) + RECORD.pad;
  const short = RECORD.minSpan - (hi - lo);
  if (short > 0) { lo -= short / 2; hi += short / 2; }
  return { lo, hi };
}

// A small seeded hash to [0, 1): the same star always gets the same nudge.
function hash01(n) {
  let t = (n | 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// How many cells of what size hold n rounds.
export function earnedGrid(n) {
  const wide = RECORD.azSpan, tall = RECORD.altTo - RECORD.altFrom;
  const fit = (c) => Math.floor(wide / c + 1e-9) * Math.floor(tall / c + 1e-9);
  let cell = RECORD.cellDeg;
  while (cell > RECORD.cellMinDeg && fit(cell) < n) cell = Math.max(RECORD.cellMinDeg, cell - 0.5);
  const cols = Math.floor(wide / cell + 1e-9), rows = Math.floor(tall / cell + 1e-9);
  return { cell, cols, rows, room: cols * rows };
}

export function earnedSky(rounds) {
  const good = (rounds || []).filter((r) => r && Array.isArray(r.notes) && r.notes.some(Number.isFinite));
  const range = earnedRange(good.flatMap((r) => r.notes));
  const newest = good.reduce((m, r) => Math.max(m, r.night), -Infinity);
  // Oldest first (a stable sort: rounds of one night keep the order they were sung in).
  const byAge = good.map((r, i) => ({ r, i })).sort((a, b) => a.r.night - b.r.night || a.i - b.i);
  const grid = earnedGrid(byAge.length);
  const shown = byAge.slice(-grid.room);
  const usedRows = Math.ceil(shown.length / grid.cols), altMid = (RECORD.altFrom + RECORD.altTo) / 2;
  let total = 0;
  for (const r of good) total += r.notes.filter(Number.isFinite).length;
  // Read like a page: the oldest round top left, the newest last.
  const items = shown.map(({ r, i: ri }, k) => {
    const notes = r.notes.filter(Number.isFinite);
    const col = k % grid.cols, row = Math.floor(k / grid.cols);
    const cAz = RECORD.azMid + (col - (grid.cols - 1) / 2) * grid.cell, cAlt = altMid + ((usedRows - 1) / 2 - row) * grid.cell;
    const lo = Math.min(...notes), hi = Math.max(...notes), mid = (lo + hi) / 2;
    const reach = grid.cell * RECORD.fill, perNote = reach / Math.max(hi - lo, RECORD.minNotes);
    // Inside its cell a round runs left to right in the order sung and a higher note is a
    // higher star, plus a small seeded nudge so equal notes do not hide each other.
    const points = notes.map((m, i) => {
      const along = notes.length > 1 ? i / (notes.length - 1) - 0.5 : 0;
      const alt = cAlt + (m - mid) * perNote + (hash01(ri * 131 + i * 7 + 3) - 0.5) * RECORD.nudgeDeg;
      return [cAz + along * reach / Math.cos(cAlt * RAD), alt];
    });
    // Gold = a clean round. A caller that does not say (no `clean`) gets the old rule: the
    // newest night's rounds are gold.
    return { id: r.id, lit: r.lit !== false, gold: r.clean === true || (r.clean == null && r.night === newest), cell: [cAz, cAlt], points };
  });
  return { items, range, total, shown: items.length, grid };
}

// The quality guard (spec section 12): three frames in a row over 24 ms step the quality
// down for the visit. It only ever steps down, and it says nothing to the person.
export const QUALITY = Object.freeze({
  overMs: 24, run: 3, graceFrames: 20,
  tiers: Object.freeze({
    full: Object.freeze({ pixelRatio: 2, twinkle: 1, parallax: 1, keep: 1, pointer: 1 }),
    lean: Object.freeze({ pixelRatio: 1.5, twinkle: 0, parallax: 0, keep: 1, pointer: 1 }),
    low: Object.freeze({ pixelRatio: 1, twinkle: 0, parallax: 0, keep: 0.25, pointer: 0 }),
  }),
});
export function createGuard() {
  const order = Object.keys(QUALITY.tiers);
  let at = 0, run = 0, grace = 0;
  return {
    tier: () => order[at],
    // A pause (tab hidden, the sky at rest) breaks a run: the gap after it is not a slow frame.
    skip() { run = 0; },
    reset() { at = 0; run = 0; grace = 0; },
    push(gapMs) {
      // After a step the next few frames carry its one-off cost (a resize): not judged.
      if (grace > 0) { grace--; run = 0; return null; }
      run = gapMs > QUALITY.overMs ? run + 1 : 0;
      if (run < QUALITY.run || at >= order.length - 1) return null;
      at++; run = 0; grace = QUALITY.graceFrames;
      return order[at];
    },
  };
}

export const celestialVector = (ra, dec) => skyVector(-ra, dec);
export const rotate = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

// Where a star is in the dome for a sidereal time and latitude (the standard hour-angle
// formulas; azimuth counted from north through east, then turned so `north` is its dome az).
function horizonOf(ra, dec, lst, latitude, north) {
  const H = (lst - ra) * RAD, d = dec * RAD, lat = latitude * RAD;
  const sinAlt = Math.sin(d) * Math.sin(lat) + Math.cos(d) * Math.cos(lat) * Math.cos(H);
  const az = Math.atan2(-Math.cos(d) * Math.sin(H), Math.sin(d) * Math.cos(lat) - Math.cos(d) * Math.sin(lat) * Math.cos(H));
  return skyVector(az / RAD + north, Math.asin(clamp(sinAlt, -1, 1)) / RAD);
}

export function skyRotation(sky) {
  if (!sky) return [...IDENTITY];
  if (Array.isArray(sky.rotation) && sky.rotation.length === 9 && sky.rotation.every(Number.isFinite)) return [...sky.rotation];
  if (!Number.isFinite(sky.lst) || !Number.isFinite(sky.latitude)) return [...IDENTITY];
  // The matrix's columns are where the star sphere's three axes land in the dome.
  const north = sky.north ?? 0;
  const basis = [[270, 0], [0, 90], [180, 0]];     // ra, dec of the +x, +y, +z axes (see celestialVector)
  const cols = basis.map(([ra, dec]) => horizonOf(ra, dec, sky.lst, sky.latitude, north));
  return [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
}

// The default sky: a made-up catalogue in the same shape a real one will have. Brightness
// follows the real sky's spread (about 2.8 times as many stars per magnitude fainter), and
// a third of the stars crowd towards one great circle, which is the Milky Way's band.
export const MILKY_POLE = Object.freeze({ ra: 152, dec: 38 });
// Hand-placed bright stars, two or three near each place, so every part of the made-up sky
// has a jewel: [az, alt, magnitude, B-V colour] as seen with the star sphere unturned. Each
// is at least 5 degrees from every figure star, so none can be mistaken for part of a figure.
export const ANCHOR_STARS = Object.freeze([
  [-41, 33, -0.4, 0.1], [-40, 14, 0.4, 1.2], [-17, 34, 0.5, 0.3],        // The Ladder
  [41, 25, -0.6, 0.0], [20, 38, 0.3, 1.4], [38, 9, 0.5, 0.6],            // The Lyre
  [-34, 51, 0.2, 0.9], [14, 53, -0.2, -0.1], [33, 45, 0.5, 0.4],         // The Open Sky
  [-13, 30, 0.1, 0.2], [12, 31, 0.4, 1.1],                               // Tonight
  [150, 63, 0.0, 0.3], [212, 62, 0.3, 1.3], [128, 24, 0.2, -0.1], [233, 20, -0.3, 0.7],   // round Your Sky
].map((row) => Object.freeze(row)));
export function proceduralStars({ count = 9000, seed = 20261012, anchors = ANCHOR_STARS } = {}) {
  let a = seed;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const pole = celestialVector(MILKY_POLE.ra, MILKY_POLE.dec);
  // Two directions at right angles to the pole: the band's own plane.
  const ux = (() => { const v = [pole[1], -pole[0], 0]; const l = Math.hypot(...v); return v.map((c) => c / l); })();
  const uy = [pole[1] * ux[2] - pole[2] * ux[1], pole[2] * ux[0] - pole[0] * ux[2], pole[0] * ux[1] - pole[1] * ux[0]];
  // SLOPE under the real sky's 0.4: about half as many again of the bright stars, because a
  // screen needs more jewels than the eye does (review 6, finding 3).
  const BRIGHT = -1.2, FAINT = 6.5, SLOPE = 0.36, floor = 10 ** (SLOPE * (BRIGHT - FAINT));
  const stars = [];
  for (let i = 0; i < count; i++) {
    let v;
    const inBand = rnd() < 0.4;
    if (inBand) {
      const lon = rnd() * 2 * Math.PI, lat = gauss() * 6 * RAD;
      v = [0, 1, 2].map((k) => Math.cos(lat) * (Math.cos(lon) * ux[k] + Math.sin(lon) * uy[k]) + Math.sin(lat) * pole[k]);
    } else {
      const y = rnd() * 2 - 1, lon = rnd() * 2 * Math.PI, c = Math.sqrt(1 - y * y);
      v = [c * Math.sin(lon), y, -c * Math.cos(lon)];
    }
    let mag = FAINT + Math.log10(floor + rnd() * (1 - floor)) / SLOPE;
    if (inBand) mag = Math.min(FAINT, mag + 0.6);               // the band is mostly faint stars
    const dec = Math.asin(clamp(v[1], -1, 1)) / RAD, ra = ((-Math.atan2(v[0], -v[2]) / RAD) + 360) % 360;
    // Most stars are near white; a few are clearly blue-white or orange.
    const colour = clamp(0.55 + gauss() * 0.45, -0.3, 1.8);
    stars.push({ ra, dec, mag, colour });
  }
  // The anchors come last, so the seeded stars before them are the same whatever is anchored.
  for (const [az, alt, mag, colour] of anchors || []) stars.push({ ra: ((-az % 360) + 360) % 360, dec: alt, mag, colour });
  return { stars, figures: [], milkyWay: { ...MILKY_POLE } };
}

// ---- the turner: one camera, three ways to move it -----------------------------------
//
// createTurner({ cam = HOME, calm = false, height = 800 }) ->
//   cam()                       -> { yaw, pitch, fov } now
//   setHeight(px), setCalm(bool), jump({ yaw?, pitch? })   (jump clamps pitch; no motion)
//   dragStart(x, y, t), dragMove(x, y, t) -> true once the 5 px threshold is passed,
//   dragEnd(t) -> { wasDrag }   (wasDrag true = swallow the click that follows)
//   wheel(dx, dy)               two-finger swipe, already in px
//   keyDown(key, t) -> true if the key is ours ('ArrowLeft' | 'ArrowRight' | 'ArrowUp' |
//                      'ArrowDown' | 'Home'); auto-repeat presses of a held key are ignored
//   keyUp(key, t), releaseKeys()
//   travelTo({ yaw, pitch }, t) -> ms   glide to face a place and close in (fov 60 -> 34);
//   travelBack(t) -> ms         widen out again WITHOUT turning (from mid-move too: Esc).
//       While travelling or inside a place (into > 0) drag, swipe and keys do nothing.
//   jump({ yaw?, pitch?, into? })   into 1 = already inside a place (opening on its address)
//   step(t) -> { yaw, pitch, fov, into, light, moving, cut }
//       moving = call step again next frame. cut = the camera jumped this step (Calm
//       motion): cross-fade, do not glide. into = 0 at home .. 1 inside a place: the field
//       of view follows it. light = the same journey on a gentler curve (three parts plain
//       time to one part eased), for the dome's brightness: on the camera's own curve the moon's patch of
//       sky changed faster than the flash limit (measured 0.19 against 0.15).
// Invariants: yaw is always in (-180, 180]. pitch is in [8, 74] except while a drag pulls
// past a limit or springs back from it, when it stays within 6 degrees of the limit.
// Nothing moves unless an input caused it (no idle drift).
export function createTurner({ cam = HOME, calm = false, height = 800 } = {}) {
  let yaw = wrap180(cam.yaw), pitch = clampPitch(cam.pitch);
  const wide = cam.fov ?? HOME.fov;
  let fov = wide, into = 0, light = 0;
  let travel = null;          // { y0, p0, dy, dp, i0, di, t0, ms }
  let h = height, isCalm = !!calm;
  let drag = null;            // { x, y, active, raw, samples: [{ t, yaw, pitch }], turned }
  let vel = null;             // { yaw, pitch } degrees a second, while coasting
  let tween = null;           // { dy, dp, t0, ms, ease, done (0..1 eased), spring }
  const rate = { yaw: 0, pitch: 0 };
  const keys = new Map();     // key -> { t0, steps }
  let lastT = null, cut = false;

  const k = () => wide / h;   // degrees per px: the star under the pointer stays under it
  const locked = () => !!travel || into > 0;
  const fovAt = (i) => wide + (TRAVEL.fov - wide) * i;
  const stopMotion = () => { vel = null; tween = null; };

  // Tweens add their progress each step (they do not own the camera), so a held key's
  // steady turn and a tap's ease can overlap without fighting.
  function startTween(dy, dp, ms, ease, t, spring = false) {
    const left = tween ? { y: tween.dy * (1 - tween.done), p: tween.dp * (1 - tween.done) } : { y: 0, p: 0 };
    // A fresh tap carries on from where the last one was heading, so quick taps add up;
    // the pitch goal is clamped so no chain of taps can leave the limits.
    const goalP = spring ? pitch + dp : clampPitch(pitch + left.p + dp);
    const turn = spring ? dy : left.y + dy;
    tween = { dy: turn, dp: goalP - pitch, goalYaw: wrap180(yaw + turn), goalPitch: goalP, t0: t, ms, ease, done: 0, spring };
  }

  const STEPS = { ArrowLeft: [-TURN.yawTapDeg, 0], ArrowRight: [TURN.yawTapDeg, 0], ArrowUp: [0, TURN.pitchTapDeg], ArrowDown: [0, -TURN.pitchTapDeg] };

  function cutBy(dy, dp) {
    yaw = wrap180(yaw + dy);
    pitch = clampPitch(pitch + dp);
    cut = true;
  }

  return {
    cam: () => ({ yaw, pitch, fov }),
    setHeight(px) { if (px > 0) h = px; },
    setCalm(on) {
      isCalm = !!on;
      if (isCalm) { stopMotion(); rate.yaw = rate.pitch = 0; if (!drag) pitch = clampPitch(pitch); }
    },
    jump(to) {
      stopMotion(); rate.yaw = rate.pitch = 0;
      travel = null;
      into = Number.isFinite(to?.into) ? clamp(to.into, 0, 1) : 0;
      light = into;
      fov = fovAt(into);
      if (Number.isFinite(to?.yaw)) yaw = wrap180(to.yaw);
      if (Number.isFinite(to?.pitch)) pitch = clampPitch(to.pitch);
    },

    travelTo(face, t) {
      stopMotion(); rate.yaw = rate.pitch = 0; keys.clear(); drag = null;
      pitch = clampPitch(pitch);
      const dy = wrap180(face.yaw - yaw), dp = clampPitch(face.pitch) - pitch;
      if (isCalm) { yaw = wrap180(yaw + dy); pitch += dp; into = light = 1; fov = fovAt(1); travel = null; cut = true; return TRAVEL.calmMs; }
      if (Math.max(Math.abs(dy), Math.abs(dp)) > TRAVEL.throughDeg) {
        // Fade-through: face the place at once (sky.js covers the cut with a cross-fade of
        // the old picture), then close in as on any short hop.
        yaw = wrap180(yaw + dy); pitch += dp; cut = true;
        travel = { y0: yaw, p0: pitch, dy: 0, dp: 0, i0: into, di: 1 - into, l0: light, dl: 1 - light, t0: t, ms: TRAVEL.baseMs };
        return TRAVEL.baseMs;
      }
      const ms = travelMs(Math.max(Math.abs(dy), Math.abs(dp)));
      travel = { y0: yaw, p0: pitch, dy, dp, i0: into, di: 1 - into, l0: light, dl: 1 - light, t0: t, ms };
      return ms;
    },
    travelBack(t) {
      if (isCalm) { travel = null; if (into !== 0) cut = true; into = light = 0; fov = fovAt(0); return TRAVEL.calmMs; }
      // Turned round part way: the way back takes its share of the time, never under 200 ms.
      const ms = Math.max(TRAVEL.fadeMs, TRAVEL.backMs * into);
      travel = { y0: yaw, p0: pitch, dy: 0, dp: 0, i0: into, di: -into, l0: light, dl: -light, t0: t, ms };
      return ms;
    },

    dragStart(x, y, t) {
      if (locked()) return;
      stopMotion();
      pitch = clampPitch(pitch);
      drag = { x, y, active: false, raw: pitch, samples: [], turned: 0 };
    },
    dragMove(x, y, t) {
      if (!drag) return false;
      if (!drag.active) {
        if (Math.hypot(x - drag.x, y - drag.y) < TURN.dragStartPx) return false;
        // Count from here, not from the press: otherwise the sky would jump 5 px at once.
        drag.active = true; drag.x = x; drag.y = y;
        drag.samples.push({ t, yaw: 0, pitch });
        return true;
      }
      const dx = x - drag.x, dy = y - drag.y;
      drag.x = x; drag.y = y;
      yaw = wrap180(yaw - dx * k());
      drag.turned -= dx * k();
      // The hand's own pull is kept (raw) and only shown through the rubber band, but not
      // so far past that coming back has a dead stretch.
      const slack = LIMITS.rubberDeg / LIMITS.rubberGain;
      drag.raw = clamp(drag.raw + dy * k(), LIMITS.pitchMin - slack, LIMITS.pitchMax + slack);
      pitch = isCalm ? clampPitch(drag.raw) : rubberPitch(drag.raw);
      if (isCalm) drag.raw = pitch;
      drag.samples.push({ t, yaw: drag.turned, pitch });
      while (drag.samples.length > 2 && t - drag.samples[1].t > TURN.coastWindowMs) drag.samples.shift();
      return true;
    },
    dragEnd(t) {
      if (!drag) return { wasDrag: false };
      const d = drag;
      drag = null;
      if (!d.active) return { wasDrag: false };
      if (isCalm) { pitch = clampPitch(pitch); return { wasDrag: true }; }
      const over = pitch !== clampPitch(pitch);
      // Speed = the average over the last 80 ms before letting go. A hand that stopped
      // first has no samples in that window, so the sky stays where it was put.
      const recent = d.samples.filter((s) => t - s.t <= TURN.coastWindowMs);
      const last = d.samples[d.samples.length - 1];
      if (recent.length >= 2) {
        const first = recent[0];
        const secs = Math.max(0.016, (t - first.t) / 1000);
        let vy = (last.yaw - first.yaw) / secs, vp = over ? 0 : (last.pitch - first.pitch) / secs;
        const speed = Math.hypot(vy, vp);
        if (speed > TURN.coastMaxDegS) { vy *= TURN.coastMaxDegS / speed; vp *= TURN.coastMaxDegS / speed; }
        if (Math.hypot(vy, vp) >= TURN.coastStopDegS) vel = { yaw: vy, pitch: vp };
      }
      if (over) startTween(0, clampPitch(pitch) - pitch, LIMITS.springMs, EASE, t, true);
      return { wasDrag: true };
    },

    wheel(dx, dy) {
      if (drag?.active || locked()) return;
      stopMotion();
      yaw = wrap180(yaw + dx * k());
      pitch = clampPitch(pitch - dy * k());
    },

    keyDown(key, t) {
      if (locked()) return false;
      // The hand on the sky wins: a key pressed mid-drag is ours (no page scroll) but does
      // nothing, so two inputs never pull the camera at once.
      if (drag?.active) return key === 'Home' || key in STEPS;
      if (key === 'Home') {
        const dy = wrap180(HOME.yaw - yaw), dp = HOME.pitch - clampPitch(pitch);
        vel = null;
        if (isCalm) { tween = null; if (dy || dp) cutBy(dy, dp); return true; }
        tween = null;
        pitch = clampPitch(pitch);
        startTween(dy, dp, homeTurnMs(Math.max(Math.abs(dy), Math.abs(dp))), EASE_IN_OUT, t);
        return true;
      }
      const s = STEPS[key];
      if (!s) return false;
      if (keys.has(key)) return true;
      keys.set(key, { t0: t, steps: 1 });
      vel = null;
      if (isCalm) { tween = null; cutBy(s[0], s[1]); return true; }
      startTween(s[0], s[1], TURN.tapMs, EASE, t);
      return true;
    },
    keyUp(key) { keys.delete(key); },
    releaseKeys() { keys.clear(); },

    step(t) {
      // A long gap (a hidden tab, a stall) must not turn into one huge leap.
      const dt = lastT == null ? 0 : clamp((t - lastT) / 1000, 0, 0.1);
      lastT = t;

      if (travel) {
        const u = clamp((t - travel.t0) / travel.ms, 0, 1), e = travelEase(u, travel.ms);
        yaw = wrap180(travel.y0 + travel.dy * e);
        pitch = travel.p0 + travel.dp * e;
        into = clamp(travel.i0 + travel.di * e, 0, 1);
        light = clamp(travel.l0 + travel.dl * (3 * u + e) / 4, 0, 1);
        fov = fovAt(into);
        if (u >= 1) travel = null;
      }

      if (tween) {
        const u = clamp((t - tween.t0) / tween.ms, 0, 1), e = tween.ease(u);
        yaw = wrap180(yaw + tween.dy * (e - tween.done));
        pitch += tween.dp * (e - tween.done);
        tween.done = e;
        if (u >= 1) {
          // Land exactly on the goal (summed steps drift by a rounding error), unless
          // something else is turning the sky at the same moment.
          if (rate.pitch === 0 && !vel?.pitch) pitch = tween.goalPitch;
          if (rate.yaw === 0 && !vel && tween.dy !== 0) yaw = tween.goalYaw;
          tween = null;
        }
      }

      const heldFor = (key) => (keys.has(key) ? t - keys.get(key).t0 : -1);
      if (isCalm) {
        for (const [key, st] of keys) {
          // The press itself was step 1; the next comes after the hold delay, then one per gap.
          const due = t - st.t0 < TURN.holdAfterMs ? 1 : 2 + Math.floor((t - st.t0 - TURN.holdAfterMs) / TURN.calmRepeatMs);
          if (due > st.steps) { st.steps++; cutBy(STEPS[key][0], STEPS[key][1]); }
        }
      } else if (drag?.active) {
        rate.yaw = rate.pitch = 0;
      } else {
        const want = (plus, minus, top) => ((heldFor(plus) > TURN.holdAfterMs ? 1 : 0) - (heldFor(minus) > TURN.holdAfterMs ? 1 : 0)) * top;
        const ramp = (now, target, top) => {
          const most = top / (TURN.rampMs / 1000) * dt;
          return now + clamp(target - now, -most, most);
        };
        rate.yaw = ramp(rate.yaw, want('ArrowRight', 'ArrowLeft', TURN.yawRateDegS), TURN.yawRateDegS);
        rate.pitch = ramp(rate.pitch, want('ArrowUp', 'ArrowDown', TURN.pitchRateDegS), TURN.pitchRateDegS);
        yaw = wrap180(yaw + rate.yaw * dt);
        pitch += rate.pitch * dt;
      }

      if (vel) {
        yaw = wrap180(yaw + vel.yaw * dt);
        pitch += vel.pitch * dt;
        if (pitch !== clampPitch(pitch)) vel.pitch = 0;   // coasting stops at a limit, it does not bounce
        const decay = Math.exp(-dt / TURN.coastTauS);
        vel.yaw *= decay; vel.pitch *= decay;
        if (Math.hypot(vel.yaw, vel.pitch) < TURN.coastStopDegS) vel = null;
      }

      // Only a drag (and the spring back from one) may be past a limit.
      if (!drag?.active && !tween?.spring) {
        if (pitch !== clampPitch(pitch)) { pitch = clampPitch(pitch); rate.pitch = 0; }
      }

      const moving = !!travel || !!tween || !!vel || rate.yaw !== 0 || rate.pitch !== 0 || keys.size > 0;
      const out = { yaw, pitch, fov, into, light, moving, cut };
      cut = false;
      return out;
    },
  };
}
