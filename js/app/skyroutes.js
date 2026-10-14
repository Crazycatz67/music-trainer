// skyroutes.js — which place in the sky each screen belongs to, where its Back button leads,
// and how the sky should move when the address changes. PURE: imports in Node
// (tools/checks/skyroutes.check.mjs). docs/design/specs/2026-10-12-sky-dome.md sections 4, 7
// and 9; docs/design/specs/2026-10-12-living-sky.md section 9.
//
// The address is the truth: js/app/shell.js shows the screen for it, and js/app/home.js
// turns the sky to match. Nothing here knows about the DOM, three.js or the microphone.
//
// CONTRACT   (route = shell.js parseRoute() output: { name, param })
//   HOME_ROUTE              'sky': the dome itself, the site's first screen
//   placeOf(route) -> place id | null      the sky place a screen sits in front of
//                           (js/app/skymap.js PLACES ids); null for the sky and unknown routes
//   namesOf(route) -> { name, plain } | null    the strip's two names: the place's themed
//                           name and its plain words, always both
//   backOf(route) -> { hash, label, esc } | null    the strip's Back button; null on the sky.
//       An exercise goes back to The Ladder, everything else to the sky. esc = Esc presses
//       it: false where Esc is the screen's own Pause (Free sing, every exercise, setup's
//       range step), so one key never both pauses a take and leaves it.
//   NUMBER_ROUTES           keys 1 to 5 -> Tonight, The Ladder, The Open Sky, The Lyre, Your Sky
//   moveFor({ to, where, place }) -> 'none' | 'glide' | 'fade' | 'back'
//       to     the route now on screen
//       where  sky.where().state: 'home' | 'going' | 'place' | 'returning';  place: its place id
//       'glide'  from the sky to a place's own address: the camera travels in
//       'fade'   every other way into a place (a deep link, a number key from another place,
//                Back from an exercise): one new dim frame under a 200 ms cross-fade, no
//                camera move (spec section 7, "Other cases")
//       'back'   the address went to the sky while inside or on the way in: travel back
//       'none'   the sky already shows it

import { PLACES } from './skymap.js';

export const HOME_ROUTE = 'sky';

// setup and the coach notes are reached from Tonight (spec section 3).
const PLACE_OF = Object.freeze({ today: 'today', setup: 'today', coach: 'today', practice: 'practice', sing: 'sing', songs: 'songs', progress: 'progress' });
// Esc is these screens' own Pause.
const ESC_IS_THEIRS = new Set(['sing', 'setup']);

const byId = (id) => PLACES.find((pl) => pl.id === id) || null;

export function placeOf(route) {
  return (route && PLACE_OF[route.name]) || null;
}

export function namesOf(route) {
  const pl = byId(placeOf(route));
  return pl ? { name: pl.name, plain: pl.plain } : null;
}

export function backOf(route) {
  if (!placeOf(route)) return null;
  const exercise = route.name === 'practice' && !!route.param;
  if (exercise) return { hash: byId('practice').route, label: `Back to ${byId('practice').name}`, esc: false };
  return { hash: `#/${HOME_ROUTE}`, label: 'Back to the sky', esc: !ESC_IS_THEIRS.has(route.name) };
}

export const NUMBER_ROUTES = Object.freeze(PLACES.map((pl) => pl.route));

export function moveFor({ to, where = 'home', place = null } = {}) {
  const target = placeOf(to);
  if (!target) return where === 'place' || where === 'going' ? 'back' : 'none';
  if ((where === 'place' || where === 'going') && place === target) return 'none';
  // A place's own address (no exercise named) from the open sky is a journey; anything
  // else lands on a screen that may start listening at once, so it must not glide.
  const own = !to.param && byId(target).route === `#/${to.name}`;
  return where === 'home' && own ? 'glide' : 'fade';
}
