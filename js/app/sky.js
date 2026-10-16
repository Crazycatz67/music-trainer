// sky.js — the sky's controller (browser only): the camera, the three ways to turn it, the
// five place links in their two shapes, travel into a place and back, the Start button, the
// key hint, the live region, Calm motion, the modes in which the dome must not draw, the
// quality guard, and the plain-links fallback. docs/design/specs/2026-10-12-sky-dome.md.
//
// The links are the real thing; the dome behind them is decoration. Where a link sits comes
// from js/app/skymap.js (pure maths, no three.js), so the places are on screen and usable
// before three.js has loaded, and stay usable if the dome can never draw.
//
// ---------------------------------------------------------------------------------------
// CONTRACT
//   createSky(root, {
//     gl = 'auto',        'auto' | 'off' (plain links, three.js never loaded) | 'soft'
//                         (allow software WebGL: headless test runs only)
//     calm = null,        true | false | null. null follows <html data-calm="on"> and the
//                         Mac's reduced-motion setting, live.
//     states = {},        { [placeId]: 'state in words' }  (line 3 of a label)
//     hrefFor = (place) => place.route,
//     travel = false,     true = a press on a place (its link, or its figure on the dome)
//                         glides the camera into it and the link is NOT followed: the caller
//                         changes the address in onTravel and shows the place in onArrive.
//                         false = slice 1: the browser follows the link.
//     onTravel = null,    (place, event) => void. Called at the start of every press on a
//                         place. With travel off, event.preventDefault() keeps the page here.
//     onArrive = null,    (place) => void   the camera has landed; the dome has stopped drawing
//     onHome = null,      (place) => void   back at home; focus is on that place's link again
//     strip = true,       the slim "Back to the sky [Esc]" strip shown inside a place
//     escBack = true,     Esc travels back. false = the page owns Back (index.html: the
//                         address decides, and Esc is some screens' own Pause)
//     primary = null,     { label: 'Start', onPress(how) } the one main button, under Tonight
//                         while Tonight is in view; Space presses it whichever way you face
//     store = localStorage,   getItem / setItem, for "has turned the sky once" (first visit)
//     restAfterMs = 30000,    idle time after which the twinkle eases out and the sky rests
//     onFrame = null,     (t) => void   called right after each dome frame (lab probes only)
//     enabled = () => true   false = ignore the keys (a sheet is open)
//   }) -> sky
//   sky.ready            Promise<'dome' | 'links'>: resolves once it is known which
//   sky.mode()           'dome' | 'links';  sky.why() says why links ('' in dome mode):
//                        'off' | 'narrow' | 'no-webgl' | 'software' | 'load-failed' | 'context-lost'
//   sky.setCalm(v), sky.calm(), sky.setStates(states), sky.setPrimary(primary | null)
//   sky.travelTo(placeId) -> Promise<boolean>   true once landed (false: turned back, or links mode)
//   sky.travelBack() -> Promise<boolean>        also what Esc and the strip's button do
//   sky.openAt(placeId, { fade = false }?)   be inside a place at once: dim, still, facing
//                        it (the site opened on its address). fade = the old picture fades
//                        away over 200 ms on its own layer (from one place to another)
//   sky.where() -> { state: 'home' | 'going' | 'place' | 'returning', place: id | null }
//   sky.setCaptionAction({ label, onPress } | null)   the caption's one quiet button (bottom
//                        right, home only, never in links mode); null hides the caption
//   sky.replay(cols, words = '') -> boolean   plays takeglow.glowShape(...) cols ONCE on the
//                        dome and says `words` once in the live region. false (nothing shown,
//                        nothing said) in links mode, before the dome loads, away from home,
//                        with the mic live or a take being scored
//   sky.setFigure(on)    true (default) = inside a place its own figure stays lit; false =
//                        a STAGE screen: no figure line behind the controls (page-layout S4,
//                        spec 3.2). Applies to the next travel/openAt and, inside a place, at once
//   sky.setMicLive(bool) a microphone track is live: the dome draws NOTHING and no
//                        animation-frame callback stays registered (spec section 9)
//   sky.setBusy(bool)    a take is being scored: the same
//   sky.setVoice(v), sky.setEarned(list), sky.setStars(catalogue), sky.setSky(orientation),
//   sky.setToday({ done, total } | null)   today's steps: the moon's lit share and its step stars
//                        passed to the dome (see js/app/dome.js); kept if it has not loaded yet
//   sky.turner           the camera state machine (skymap.createTurner); after driving it
//                        directly, call sky.wake() so a frame is drawn
//   sky.wake()           draw on the next animation frame
//   sky.jump(cam)        set the camera and settle everything at once, with no fades (tests)
//   sky.entries()        the current layout (skymap.layout result)
//   sky.debug() -> { mode, why, calm, yaw, pitch, fov, into, where, place, frames, blocked,
//                    lastMs, p95Ms, fps, gapP95Ms, drawCalls, triangles, stars, starsShown,
//                    tier, renderer, pixelRatio, pending, moving, micLive, busy, dome }
//       frames = dome frames drawn. blocked = draw requests refused because the mic was
//       live or a take was being scored. pending = an animation-frame callback is registered (true while turning or
//       twinkling, false at rest, inside a place, and whenever the mic is live or a take is
//       scored). moving = something other than the idle twinkle is changing. lastMs / p95Ms =
//       main-thread ms of a whole sky frame (camera step + draw + label moves). tier = the
//       quality guard's step ('full' | 'lean' | 'low'). dome = dome.debug().
//   sky.feedGuard(gapMs), sky.resetQuality(), sky.idleFor(ms)   test hooks: a frame gap for the
//       guard; back to full quality; pretend the last input was ms ago
//   sky.destroy()
// Events: none. Failure behaviour: if the dome cannot start (no WebGL, software-only WebGL,
// three.js fails to load, the context is lost, the window is under 900 x 640) the same five
// links are shown as a plain column and a press follows the link. No error is shown or
// logged: nothing is broken for the person. The quality guard never says anything either.
// Tab order: the main button and the five places are the first things in `root`, in that
// order, with no positive tabindex. So they come first on the PAGE only if the page puts
// `root` before its other controls in the markup (checked 2026-10-12 with real Tab presses:
// the lab's "first Tab skips the dome" was the lab's own focus test leaving the browser's
// starting point on the last place, not this order).
// Not here (the shell's, next job): number keys 1 to 5, the corner cluster, the address.
// ---------------------------------------------------------------------------------------

import { PLACES, HOME, layout, domeFits, showsStateLine, accessibleName, facing, createTurner, unproject, placeNear, createGuard } from './skymap.js';
import { createDome } from './dome.js';

const HINT_DOME = 'Drag or arrow keys turn the sky · Tab picks a place · Enter goes there · Home faces Tonight';
const HINT_LINKS = 'Tab picks a place · Enter goes there';
const FIRST_LINE = 'Drag the sky to look around';
const STORE_KEY = 'music-trainer.sky.v1';
const SWITCH_MS = 120;        // a pill fades out, changes shape and place, fades in
const FACING_STILL_MS = 400;
const FADE_MS = 200;          // places out at the start of a travel, in at the end of the way back
const TWINKLE_GAP_MS = 28;    // idle twinkle is drawn at about 30 frames a second
const TWINKLE_OUT_MS = 900;   // the twinkle's own ease (800 ms in the dome) plus a frame or two
const START_GAP = 8;          // px between Tonight's label and the Start button
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}
function icon(cls, d) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ class: cls, viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
function defaultStore() { try { return window.localStorage; } catch { return null; } }

export function createSky(root, { gl = 'auto', calm = null, states = {}, hrefFor = (pl) => pl.route, travel = false, onTravel = null, onArrive = null, onHome = null,
  strip = true, escBack = true, primary = null, store = defaultStore(), restAfterMs = 30000, onFrame = null, enabled = () => true } = {}) {
  const now = () => performance.now();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let calmChoice = calm;
  const isCalm = () => (calmChoice ?? (document.documentElement.dataset.calm === 'on' || reduced.matches));

  // Storage can be missing or refuse (private windows): the first-visit line then simply
  // shows each visit, and nothing breaks.
  const turnedBefore = () => { try { return !!JSON.parse(store?.getItem(STORE_KEY) || '{}').turned; } catch { return false; } };
  const saveTurned = () => { try { store?.setItem(STORE_KEY, JSON.stringify({ turned: true })); } catch { /* not saved: shown again next visit */ } };

  // ---- the page ----------------------------------------------------------------------
  root.classList.add('sky');
  const canvas = el('canvas', { id: 'sky', class: 'sky-canvas', 'aria-hidden': 'true' });
  const fade = el('canvas', { class: 'sky-fade', 'aria-hidden': 'true' });
  const veil = el('div', { class: 'sky-veil', 'aria-hidden': 'true' });
  const nav = el('nav', { class: 'sky-places', 'aria-label': 'Places in the sky' });
  const first = el('p', { class: 'sky-first' }, FIRST_LINE);
  const hint = el('p', { class: 'sky-hint' });
  const live = el('p', { class: 'visually-hidden sky-live', 'aria-live': 'polite' });
  // The sky caption (living-sky 4.1): bottom right, one quiet action at most. Hidden by CSS
  // in links mode and away from home, so it never sits over a screen's controls.
  const captionBtn = el('button', { class: 'btn btn-secondary btn-small sky-caption-action', type: 'button' });
  const caption = el('div', { class: 'sky-caption', hidden: '' }, captionBtn);
  let captionPress = null;
  captionBtn.addEventListener('click', (e) => captionPress?.(e));
  const startLabel = el('span', { class: 'sky-start-label' });
  // First in the Tab order (Start, then the five places), as spec section 7 lists it.
  const startBtn = el('button', { class: 'btn btn-primary sky-start', type: 'button', hidden: '' }, startLabel, el('kbd', { class: 'keycap' }, 'Space'));
  const stripName = el('span', { class: 'sky-strip-name' }), stripPlain = el('span', { class: 'sky-strip-plain' });
  const stripTitle = el('h1', { class: 'sky-strip-title', tabindex: '-1' }, stripName, stripPlain);
  const backBtn = el('button', { class: 'btn btn-secondary btn-small sky-back', type: 'button' }, '‹ Back to the sky', el('kbd', { class: 'keycap' }, 'Esc'));
  const stripEl = el('header', { class: 'sky-strip' }, backBtn, stripTitle);
  nav.append(startBtn);

  const pills = PLACES.map((pl) => {
    const state = el('span', { class: 'sky-state' });
    const link = el('a', { class: 'sky-place', href: hrefFor(pl), 'data-place': pl.id, 'data-shape': 'open' },
      el('span', { class: 'sky-arrow', 'aria-hidden': 'true' },
        icon('sky-arrow-straight', 'M19 12H5M11 6l-6 6 6 6'),               // points left; CSS turns it
        icon('sky-arrow-around', 'M8 20h6a5 5 0 0 0 0-10H5M9 6l-4 4 4 4')),  // a turn-around arrow
      el('span', { class: 'sky-words' },
        el('span', { class: 'sky-name' }, pl.name),
        el('span', { class: 'sky-plain' }, pl.plain, el('span', { class: 'sky-behind' }, ' · behind you')),
        state));
    nav.append(link);
    return { pl, link, state, key: '', phase: 'idle', timer: 0, target: null, transform: '' };
  });
  const todayPill = pills.find((p) => p.pl.id === 'today');
  root.append(canvas, fade, veil, nav, first, hint, caption, live);
  if (strip) root.append(stripEl);

  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  // ---- state -------------------------------------------------------------------------
  let vp = { w: root.clientWidth || window.innerWidth, h: root.clientHeight || window.innerHeight };
  const turner = createTurner({ cam: HOME, calm: isCalm(), height: vp.h });
  const guard = createGuard();
  let dome = null, domeAsked = false, domeFailed = '';
  let mode = 'links', why = '';
  let entries = null, sizes = null, todayOpen = null, startSize = { w: 0, h: 0 };
  let raf = 0, destroyed = false, lastFrameAt = 0, lastRafAt = 0, lastDrawAt = 0, chained = false, active = false, stale = false;
  const costs = [], gaps = [];
  let hoverId = null, focusId = null, overId = null, pointerAt = null, pressedOn = null;
  let facingId = 'today', facingTimer = 0;
  let stateWords = { ...states };
  let main = primary;
  let where = 'home', placeId = null, awayTimer = 0, stripTimer = 0, settle = null;
  let micLive = false, scoring = false, refused = 0;
  let figure = true;                   // false on stage screens: their place figure is not lit
  const litFor = (id) => (figure ? id : null);
  let lastInputAt = now(), twinkleOffAt = 0, twinkleOn = false;
  // What the dome is given before it has loaded is kept and handed over when it arrives.
  const held = {};

  const touch = () => { lastInputAt = now(); };
  const setText = () => { for (const p of pills) p.state.textContent = stateWords[p.pl.id] || ''; };
  const blockedNow = () => micLive || scoring;

  // ---- pills -------------------------------------------------------------------------
  const keyOf = (e) => `${e.shape}|${e.edge}|${e.behind}`;

  function showStart() {
    const shown = !!main && (mode === 'links' || (todayPill.link.dataset.shape === 'open' && todayPill.key !== ''));
    startBtn.hidden = !main;
    startBtn.toggleAttribute('data-shown', shown);
  }
  function dress(p, e) {
    p.link.dataset.shape = e.shape;
    if (e.edge) p.link.dataset.edge = e.edge; else delete p.link.dataset.edge;
    if (e.arrow) p.link.dataset.arrow = e.arrow; else delete p.link.dataset.arrow;
    p.link.toggleAttribute('data-behind', !!e.behind);
    p.link.setAttribute('aria-label', accessibleName(p.pl, stateWords[p.pl.id], e));
    // The state line leaves a docked marker but stays in the tooltip and the spoken name.
    p.link.title = e.shape === 'open' && showsStateLine(vp) ? '' : (stateWords[p.pl.id] || '');
    p.key = keyOf(e);
    if (p === todayPill) showStart();
  }
  function moveTo(p, e) {
    // Tonight's open box holds its label AND the Start button under it; each is centred in it.
    const roomy = p === todayPill && e.shape === 'open' && main && todayOpen;
    const x = roomy ? e.x + (e.w - todayOpen.w) / 2 : e.x;
    const t = `translate(${Math.round(x)}px, ${Math.round(e.y)}px)`;
    if (t !== p.transform) {
      p.transform = t; p.link.style.transform = t;
      if (roomy) startBtn.style.transform = `translate(${Math.round(e.x + (e.w - startSize.w) / 2)}px, ${Math.round(e.y + todayOpen.h + START_GAP)}px)`;
    }
  }
  // Put a pill straight into its target shape and place, with no slide from where it was.
  function settlePill(p) {
    clearTimeout(p.timer);
    p.phase = 'idle';
    p.link.dataset.snap = '';
    if (p === todayPill) startBtn.dataset.snap = '';
    p.transform = '';
    dress(p, p.target);
    moveTo(p, p.target);
    void p.link.offsetWidth;           // make the jump land before transitions come back
    delete p.link.dataset.snap;
    delete p.link.dataset.fade;
    if (p === todayPill) { void startBtn.offsetWidth; delete startBtn.dataset.snap; delete startBtn.dataset.fade; }
  }
  function switchPill(p) {
    p.phase = 'out';
    p.link.dataset.fade = 'out';
    if (p === todayPill) startBtn.dataset.fade = 'out';     // the button leaves and returns with its label
    p.timer = setTimeout(() => settlePill(p), SWITCH_MS);
  }

  // Measure each pill in each of its shapes (one burst of forced layout, at start and on
  // resize only), so the maths works on real sizes and can keep pills from touching.
  function measure() {
    sizes = {};
    for (const p of pills) {
      const keep = { shape: p.link.dataset.shape, edge: p.link.dataset.edge, arrow: p.link.dataset.arrow, behind: p.link.hasAttribute('data-behind') };
      const read = (shape, behind) => {
        p.link.dataset.shape = shape;
        if (shape === 'docked') { p.link.dataset.edge = 'left'; p.link.dataset.arrow = behind ? 'around' : 'left'; } else { delete p.link.dataset.edge; delete p.link.dataset.arrow; }
        p.link.toggleAttribute('data-behind', behind);
        return { w: p.link.offsetWidth, h: p.link.offsetHeight };
      };
      sizes[p.pl.id] = { open: read('open', false), docked: read('docked', false), behind: read('docked', true) };
      p.link.dataset.shape = keep.shape;
      if (keep.edge) p.link.dataset.edge = keep.edge; else delete p.link.dataset.edge;
      if (keep.arrow) p.link.dataset.arrow = keep.arrow; else delete p.link.dataset.arrow;
      p.link.toggleAttribute('data-behind', keep.behind);
    }
    todayOpen = sizes.today.open;
    if (main) {
      // The layout is told Tonight's label is taller by the button, so nothing else is
      // ever placed over the button.
      startSize = { w: startBtn.offsetWidth, h: startBtn.offsetHeight };
      sizes.today = { ...sizes.today, open: { w: Math.max(todayOpen.w, startSize.w), h: todayOpen.h + START_GAP + startSize.h } };
    }
  }

  function placePills(cam, { instant = false, cut = false } = {}) {
    entries = layout(cam, vp, { prev: entries, sizes });
    entries.forEach((e, i) => {
      const p = pills[i];
      const before = p.target;
      p.target = e;
      if (instant || !p.key) { settlePill(p); return; }
      if (p.phase === 'out') return;                 // it picks up the newest target when it fades back in
      // A Calm-motion cut moves an open label a long way at once: fade it across like a
      // shape change, so nothing jumps.
      const leap = cut && before && Math.hypot(e.x - before.x, e.y - before.y) > 24;
      if (keyOf(e) !== p.key || leap) switchPill(p); else moveTo(p, e);
    });
    const f = facing(entries, vp);
    clearTimeout(facingTimer);
    if (f && f !== facingId) {
      // Said only once the sky has been still for a moment, never while it is sweeping.
      facingTimer = setTimeout(() => { facingId = f; live.textContent = `Facing ${PLACES.find((pl) => pl.id === f).name}`; }, FACING_STILL_MS);
    }
  }

  // ---- drawing (on demand; nothing is registered at rest) ----------------------------
  let shownCam = { ...HOME }, shownInto = 0;
  function crossFadeFrom(oldCam, oldInto) {
    // Calm motion: the sky cuts and the old picture fades away over 200 ms on its own
    // layer. (Never CSS opacity on the dome canvas itself: spec section 9.)
    dome.setCamera(oldCam);
    dome.setInside(oldInto);
    dome.snapshot(fade);
    fade.dataset.on = 'hold';
    void fade.offsetWidth;
    fade.dataset.on = 'out';
  }

  // The sky point under the pointer changes when the camera turns under a still hand.
  function aimPointer(cam) {
    if (!dome) return;
    if (!pointerAt || where !== 'home') { dome.setPointer(null); return; }
    dome.setPointer(unproject(pointerAt.x, pointerAt.y, cam, vp).dir);
  }

  function draw(t, { instant = false } = {}) {
    const t0 = now();
    const s = turner.step(t);
    const dt = lastFrameAt ? t - lastFrameAt : 0;
    lastFrameAt = t;
    let busy = false;
    if (mode === 'dome') {
      if (dome) {
        if (blockedNow()) {
          // Asked to draw with the mic live or a take being scored: refused and counted;
          // the picture is brought up to date by one frame when that ends.
          refused++;
          stale = true;
        } else {
          if (s.cut && !instant) crossFadeFrom(shownCam, shownInto);
          dome.setCamera(s);
          dome.setInside(s.light);
          aimPointer(s);
          busy = dome.tick(instant ? 1e6 : dt);
          dome.render();
          lastDrawAt = t;
          onFrame?.(t);
        }
      }
      if (where === 'home') placePills(s, { instant, cut: s.cut });
      shownCam = { yaw: s.yaw, pitch: s.pitch, fov: s.fov }; shownInto = s.light;
      // Settling draws (start-up, resize, jump) are left out: they include one-off work
      // such as shader compiling and would hide what a turning frame costs.
      if (dome && !instant && !blockedNow()) { costs.push(now() - t0); if (costs.length > 600) costs.shift(); }
      if (where === 'going' && !s.moving && s.into >= 1) arrive();
      else if (where === 'returning' && !s.moving && s.into <= 0) atHome();
    }
    return s.moving || busy;
  }

  // Idle life: at home, in full quality, not in Calm motion, and only for a while after
  // the last input. Then the twinkle eases out and the sky rests on a still frame.
  function twinkleWanted(t) {
    return where === 'home' && !isCalm() && guard.tier() === 'full' && t - lastInputAt < restAfterMs;
  }

  function frame(rafT) {
    raf = 0;
    if (destroyed || document.hidden || blockedNow()) { chained = false; return; }
    const t = now();
    if (chained && lastRafAt) {
      const gap = rafT - lastRafAt;
      // Frame-to-frame gaps only count while the sky was already moving, so the pause
      // before a turn begins is not mistaken for a slow frame.
      // The quality guard judges the same frames: a hiccup while the sky only twinkles
      // (other work on the page) must not cost the visit its stars.
      if (active) { gaps.push(gap); if (gaps.length > 600) gaps.shift(); stepQuality(guard.push(gap)); } else guard.skip();
    }
    lastRafAt = rafT;
    const want = twinkleWanted(t);
    if (want !== twinkleOn) { twinkleOn = want; dome?.setTwinkle(want); if (!want) twinkleOffAt = t; }
    // A replay aurora (dome.setReplay) rides the same slow chain; it ends by itself.
    const alive = twinkleOn || t - twinkleOffAt < TWINKLE_OUT_MS || !!dome?.glowing();
    // Nothing but twinkle (or the aurora) to show: every other frame is enough (about 30 a second).
    if (!active && !stale && t - lastDrawAt < TWINKLE_GAP_MS) { if (alive) wake(true); else chained = false; return; }
    stale = false;
    active = draw(t);
    if (active || (alive && where === 'home')) wake(true); else chained = false;
  }
  // fromFrame = the next link of a running chain; anything else is a fresh start, whose
  // first gap is a pause and not a slow frame.
  function wake(fromFrame = false) {
    if (destroyed || mode !== 'dome') return;
    if (blockedNow()) { refused++; stale = true; return; }
    if (where === 'place') return;                     // still: the last frame stays (section 9)
    if (!fromFrame) { active = true; if (!raf) { chained = false; guard.skip(); } }
    else chained = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stepQuality(name) {
    if (!name) return;
    dome?.setQuality(name);
    stale = true;
  }
  function halt() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    chained = false;
    turner.releaseKeys();
  }
  function release() {
    if (blockedNow() || mode !== 'dome') return;
    // One frame, now that it is allowed (unless nothing changed meanwhile).
    if (stale && dome) { stale = false; lastFrameAt = 0; draw(now(), { instant: true }); }
    if (where !== 'place') wake();
  }

  // ---- travel ------------------------------------------------------------------------
  const linkOf = (id) => pills.find((p) => p.pl.id === id)?.link;
  function finish(ok) { const s = settle; settle = null; s?.(ok); }
  function showStrip(pl) {
    stripName.textContent = pl.name; stripPlain.textContent = pl.plain;
    stripEl.dataset.on = '';
  }

  function travelTo(id) {
    const pl = PLACES.find((p) => p.id === id);
    if (!pl || mode !== 'dome' || blockedNow() || where === 'place' || (where === 'going' && placeId === id)) return Promise.resolve(false);
    finish(false);
    clearTimeout(awayTimer); clearTimeout(stripTimer);
    where = 'going'; placeId = id;
    root.dataset.where = where;
    root.dataset.away = '';                 // the places and the hint fade out in the first 200 ms
    hoverId = overId = pointerAt = null;
    dome?.setHover(null);
    dome?.setLit(litFor(id), true);         // this place's own figure stays lit while the rest dims
    dome?.setReplay(null);                  // the aurora fades as the camera leaves (600 ms)
    const ms = turner.travelTo(pl.face, now());
    // The strip fades in over the last 200 ms.
    stripTimer = setTimeout(() => showStrip(pl), Math.max(0, ms - FADE_MS));
    const done = new Promise((r) => { settle = r; });
    wake();
    return done;
  }
  function arrive() {
    const pl = PLACES.find((p) => p.id === placeId);
    where = 'place';
    root.dataset.where = where;
    nav.inert = true;                        // the faded places must not take Tab or a click
    clearTimeout(stripTimer);
    showStrip(pl);
    if (strip) stripTitle.focus({ preventScroll: true });
    onArrive?.(pl);
    finish(true);
  }
  function travelBack() {
    if (where !== 'going' && where !== 'place') return Promise.resolve(false);
    finish(false);
    clearTimeout(stripTimer); clearTimeout(awayTimer);
    where = 'returning';
    root.dataset.where = where;
    delete stripEl.dataset.on;
    nav.inert = false;
    touch();
    const ms = turner.travelBack(now());
    // The places come back where they belong for the wide view, and fade in at the end.
    placePills({ ...turner.cam(), fov: HOME.fov }, { instant: true });
    awayTimer = setTimeout(() => { delete root.dataset.away; }, Math.max(0, ms - FADE_MS));
    const done = new Promise((r) => { settle = r; });
    wake();
    return done;
  }
  function atHome() {
    const pl = PLACES.find((p) => p.id === placeId);
    where = 'home';
    root.dataset.where = where;
    clearTimeout(awayTimer);
    delete root.dataset.away;
    dome?.setLit(null);
    // Focus returns to the place that was left, unless the person has already moved it on.
    if (!document.activeElement || document.activeElement === document.body || stripEl.contains(document.activeElement)) linkOf(placeId)?.focus({ preventScroll: true });
    placeId = null;
    onHome?.(pl);
    finish(true);
    wake();
  }
  function openAt(id, { fade: soft = false } = {}) {
    const pl = PLACES.find((p) => p.id === id);
    if (!pl || mode !== 'dome') return;
    finish(false);
    clearTimeout(awayTimer); clearTimeout(stripTimer);
    // Never with the mic live: the snapshot would be refused and the layer would show nothing.
    if (soft && dome && !blockedNow() && !document.hidden) crossFadeFrom(shownCam, shownInto);
    turner.jump({ ...pl.face, into: 1 });
    where = 'place'; placeId = id;
    root.dataset.where = where; root.dataset.away = '';
    nav.inert = true;
    showStrip(pl);
    dome?.setLit(litFor(id), true);
    dome?.setReplay(null, { cut: true });    // the picture is replaced at once (or cross-faded) anyway
    draw(now(), { instant: true });
  }
  function press(pl, e) {
    onTravel?.(pl, e);
    if (!travel || mode !== 'dome') return;
    // A press with a modifier key is the browser's own (new tab, new window): left alone.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    travelTo(pl.id);
  }

  // ---- modes -------------------------------------------------------------------------

  function setMode(next, reason = '') {
    mode = next; why = next === 'links' ? reason : '';
    root.dataset.mode = mode;
    hint.textContent = mode === 'dome' ? HINT_DOME : HINT_LINKS;
    first.hidden = mode !== 'dome' || turnedBefore();
    if (mode === 'links') {
      resolveReady('links');             // settled (a later change of mode does not un-settle it)
      halt();
      // The plain links have no "inside": every place is a link that is followed.
      finish(false);
      where = 'home'; placeId = null;
      root.dataset.where = where; delete root.dataset.away; delete stripEl.dataset.on;
      nav.inert = false;
      turner.jump(turner.cam());
      for (const p of pills) {
        clearTimeout(p.timer);
        p.phase = 'idle'; p.key = ''; p.transform = ''; p.target = null;
        p.link.style.transform = '';
        dress(p, { shape: 'open', edge: null, arrow: null, behind: false, words: '' });
        delete p.link.dataset.fade;
      }
      startBtn.style.transform = ''; delete startBtn.dataset.fade;
      showStart();
      entries = null;
    } else {
      measure();
      draw(now(), { instant: true });
      wake();
    }
  }

  function startDome() {
    if (domeAsked) return;
    domeAsked = true;
    // three.js is fetched only after the places have painted, so it never delays them.
    const painted = new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 300); });
    createDome(canvas, { soft: gl === 'soft', after: painted,
      onLost: () => setMode('links', 'context-lost'),
      onRestored: () => { if (domeFits(vp)) { setMode('dome'); wake(); } },
    }).then((d) => {
      if (destroyed) { d.destroy(); return; }
      dome = d;
      dome.setCalm(isCalm());
      dome.setMicLive(micLive);
      dome.setQuality(guard.tier());
      dome.setTwinkle(twinkleOn);
      if ('stars' in held) dome.setStars(held.stars);
      if ('sky' in held) dome.setSky(held.sky);
      if ('earned' in held) dome.setEarned(held.earned);
      if ('voice' in held) dome.setVoice(held.voice);
      if ('today' in held) dome.setToday(held.today);
      dome.setLit(where === 'home' ? null : litFor(placeId), where !== 'home');
      dome.resize(vp.w, vp.h);
      if (mode === 'dome') { draw(now(), { instant: true }); wake(); }
      root.dataset.loaded = '';          // the veil over the canvas fades away (600 ms)
      resolveReady(mode);
    }, (err) => {
      if (err?.name !== 'DomeUnavailable') throw err;
      domeFailed = err.reason;
      setMode('links', err.reason);
      resolveReady('links');
    });
  }

  function chooseMode() {
    if (gl === 'off') return setMode('links', 'off');
    if (!domeFits(vp)) return setMode('links', 'narrow');
    if (domeFailed) return setMode('links', domeFailed);
    if (dome?.debug().lost) return setMode('links', 'context-lost');
    setMode('dome');
    startDome();
    return undefined;
  }

  // ---- input -------------------------------------------------------------------------
  const OURS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home']);
  const typing = (t) => t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const onControl = (t) => t instanceof Element && !!t.closest('a[href], button, summary, [role="button"], [tabindex]:not([tabindex="-1"])');

  // The first turn retires the first-visit line for good.
  function turned() {
    touch();
    if (first.hidden || first.dataset.gone != null) return;
    first.dataset.gone = '';
    saveTurned();
  }

  function onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || typing(e.target) || !enabled()) return;
    if (e.key === 'Escape' && travel && escBack && (where === 'going' || where === 'place')) { e.preventDefault(); travelBack(); return; }
    if (e.key === ' ' && main && where === 'home' && !onControl(e.target)) {
      // Space is the main button whichever way the sky faces (and in the plain links too).
      e.preventDefault();
      if (!e.repeat) main.onPress?.('space');
      return;
    }
    if (mode !== 'dome' || !OURS.has(e.key) || blockedNow() || where !== 'home') return;
    e.preventDefault();                  // arrows and Home must not scroll the page
    if (e.repeat) return;
    if (turner.keyDown(e.key, now())) turned();
    wake();
  }
  function onKeyUp(e) {
    if (!OURS.has(e.key)) return;
    turner.keyUp(e.key, now());
    wake();
  }
  function onBlur() { turner.releaseKeys(); wake(); }

  function over(e) {
    const r = canvas.getBoundingClientRect();
    pointerAt = { x: e.clientX - r.left, y: e.clientY - r.top };
    const sky0 = unproject(pointerAt.x, pointerAt.y, turner.cam(), vp);
    return { ...sky0, place: placeNear(sky0.az, sky0.alt) };
  }
  function setOver(id) {
    if (id === overId) return;
    overId = id;
    if (id) root.dataset.over = id; else delete root.dataset.over;
    showHover();
  }

  let pointerId = null;
  function onPointerDown(e) {
    if (mode !== 'dome' || e.button !== 0 || pointerId !== null || where !== 'home' || blockedNow()) return;
    pointerId = e.pointerId;
    // Capture so the drag survives leaving the window. It can fail for a pointer that is
    // already gone; the drag then simply ends at the next pointerup we do see.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    turner.dragStart(e.clientX, e.clientY, now());
    root.dataset.drag = 'armed';
    const at = over(e);
    pressedOn = at.place;
    touch();
    dome?.press(at.dir);                 // the press ring: the sky answers the finger
    wake();
  }
  function onPointerMove(e) {
    if (mode !== 'dome' || where !== 'home' || blockedNow()) return;
    if (e.pointerId === pointerId) {
      if (turner.dragMove(e.clientX, e.clientY, now())) { root.dataset.drag = 'on'; pressedOn = null; setOver(null); turned(); }
      over(e);
      wake();
      return;
    }
    if (pointerId !== null) return;
    // Hovering: stars near the pointer brighten, and a figure under it lifts.
    setOver(over(e).place);
    touch();
    wake();
  }
  function onPointerLeave() {
    if (pointerId !== null) return;
    pointerAt = null;
    setOver(null);
    wake();
  }
  // Also bound to pointercancel and lostpointercapture: a drag whose pointerup never
  // arrives (released outside the window, a system gesture) must not stay stuck.
  function onPointerEnd(e) {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    delete root.dataset.drag;
    const { wasDrag } = turner.dragEnd(now());
    // A press and release on a figure (no drag between) opens its place, like its link.
    if (e.type === 'pointerup' && !wasDrag && travel && pressedOn && over(e).place === pressedOn) {
      const pl = PLACES.find((p) => p.id === pressedOn);
      onTravel?.(pl, e);
      travelTo(pl.id);
    }
    pressedOn = null;
    wake();
  }
  function onWheel(e) {
    // ctrlKey is how a trackpad pinch arrives: leave it to the browser's own zoom.
    if (mode !== 'dome' || e.ctrlKey) return;
    // Inside a place the sky is a backdrop: the page under the pointer scrolls as usual.
    if (where === 'place') return;
    e.preventDefault();
    if (where !== 'home' || blockedNow()) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.h : 1;
    turner.wheel(e.deltaX * unit, e.deltaY * unit);
    turned();
    wake();
  }

  function showHover() { touch(); dome?.setHover(hoverId ?? focusId ?? overId); wake(); }
  for (const p of pills) {
    p.link.addEventListener('pointerenter', () => { hoverId = p.pl.id; showHover(); });
    p.link.addEventListener('pointerleave', () => { if (hoverId === p.pl.id) hoverId = null; showHover(); });
    p.link.addEventListener('focus', () => { focusId = p.pl.id; showHover(); });
    p.link.addEventListener('blur', () => { if (focusId === p.pl.id) focusId = null; showHover(); });
    p.link.addEventListener('click', (e) => press(p.pl, e));
  }
  startBtn.addEventListener('click', () => main?.onPress?.('button'));
  backBtn.addEventListener('click', () => travelBack());

  function onResize() {
    const next = { w: root.clientWidth || window.innerWidth, h: root.clientHeight || window.innerHeight };
    if (next.w === vp.w && next.h === vp.h) return;
    vp = next;
    turner.setHeight(vp.h);
    dome?.resize(vp.w, vp.h);
    entries = null;
    chooseMode();
  }
  function onVisible() { if (!document.hidden && mode === 'dome') { lastRafAt = 0; touch(); wake(); } }
  function onCalmChange() {
    turner.setCalm(isCalm());
    dome?.setCalm(isCalm());
    root.toggleAttribute('data-calm', isCalm());
    wake();
  }
  // Theme and the app's Calm switch are attributes on <html>.
  const watcher = new MutationObserver(() => { dome?.setTheme(); stale = true; onCalmChange(); if (where === 'place') release(); });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('lostpointercapture', onPointerEnd);
  root.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisible);
  reduced.addEventListener('change', onCalmChange);
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-calm'] });

  setText();
  startLabel.textContent = main?.label || 'Start';
  startBtn.hidden = !main;
  root.dataset.where = where;
  root.toggleAttribute('data-calm', isCalm());
  chooseMode();
  // Web fonts are not used, but the system font can still settle after first layout.
  document.fonts?.ready.then(() => { if (!destroyed && mode === 'dome') { measure(); draw(now(), { instant: true }); } });

  const p95 = (list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  };
  const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : null);
  const relay = (key, call) => (value) => { held[key] = value; if (dome) { call(value); stale = true; wake(); if (where === 'place') release(); } };
  const resettle = () => { if (mode === 'dome') { measure(); entries = null; draw(now(), { instant: true }); } else setMode('links', why); };

  return {
    ready,
    turner,
    wake: () => wake(),
    mode: () => mode,
    why: () => why,
    calm: isCalm,
    setCalm(v) { calmChoice = v; onCalmChange(); },
    setStates(next) { stateWords = { ...next }; setText(); resettle(); },
    setPrimary(next) { main = next || null; startLabel.textContent = main?.label || 'Start'; showStart(); resettle(); },
    travelTo, travelBack, openAt,
    where: () => ({ state: where, place: placeId }),
    setFigure(on) {
      figure = on !== false;
      if (!dome || where === 'home' || where === 'returning') return;
      dome.setLit(litFor(placeId), true);
      // Inside a place the sky is still (wake() returns early), so the change needs its own frame.
      if (where === 'place') { if (blockedNow()) stale = true; else draw(now(), { instant: true }); }
      else wake();
    },
    setCaptionAction(a) {
      captionPress = a?.onPress || null;
      captionBtn.textContent = a?.label || '';
      caption.hidden = !a;
    },
    // Only at home in dome mode and never with the mic live or a take being scored: the
    // caller keeps the glow (takeglow.lastGlow) for the caption's "Replay" when this says no.
    replay(cols, words = '') {
      if (destroyed || mode !== 'dome' || !dome || where !== 'home' || blockedNow() || !cols?.length) return false;
      dome.setReplay({ cols, calm: isCalm() });
      if (words) live.textContent = words;
      wake();
      return true;
    },
    setMicLive(on) { micLive = !!on; dome?.setMicLive(micLive); if (blockedNow()) halt(); else release(); },
    setBusy(on) { scoring = !!on; if (blockedNow()) halt(); else release(); },
    setVoice: relay('voice', (v) => dome.setVoice(v)),
    setEarned: relay('earned', (v) => dome.setEarned(v)),
    setToday: relay('today', (v) => dome.setToday(v)),
    setStars: relay('stars', (v) => dome.setStars(v)),
    setSky: relay('sky', (v) => dome.setSky(v)),
    jump(cam) { turner.jump(cam); if (mode === 'dome') draw(now(), { instant: true }); },
    entries: () => entries,
    resetStats() { costs.length = 0; gaps.length = 0; },
    feedGuard(gapMs) {
      stepQuality(guard.push(gapMs));
      // Not wake(): a fresh wake breaks the guard's run (a pause is not a slow frame),
      // which would swallow the very gaps a test is feeding it.
      if (!raf && !destroyed && mode === 'dome' && !blockedNow() && where !== 'place') { active = true; chained = false; raf = requestAnimationFrame(frame); }
    },
    resetQuality() { guard.reset(); dome?.setQuality('full'); stale = true; wake(); },
    idleFor(ms) { lastInputAt = now() - ms; },
    snapshot(target) { dome?.snapshot(target); },
    debug() {
      const d = dome?.debug();
      const cam = turner.cam();
      const gap = median(gaps);
      return { mode, why, calm: isCalm(), yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov, into: shownInto, where, place: placeId,
        frames: d?.frames ?? 0, blocked: refused + (d?.blocked ?? 0),
        lastMs: costs.length ? costs[costs.length - 1] : null, p95Ms: p95(costs), fps: gap ? 1000 / gap : null, gapP95Ms: p95(gaps),
        drawCalls: d?.drawCalls ?? 0, triangles: d?.triangles ?? 0, stars: d?.stars ?? 0, starsShown: d?.starsShown ?? 0, tier: guard.tier(), renderer: d?.renderer ?? null,
        pixelRatio: d?.pixelRatio ?? null, pending: raf !== 0, moving: active && raf !== 0, micLive, busy: scoring, samples: costs.length, dome: d ?? null };
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(facingTimer); clearTimeout(awayTimer); clearTimeout(stripTimer);
      for (const p of pills) clearTimeout(p.timer);
      finish(false);
      watcher.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
      reduced.removeEventListener('change', onCalmChange);
      root.removeEventListener('wheel', onWheel);
      dome?.destroy();
      root.replaceChildren();
      root.classList.remove('sky');
      for (const k of ['mode', 'where', 'away', 'over', 'drag', 'loaded']) delete root.dataset[k];
    },
  };
}
