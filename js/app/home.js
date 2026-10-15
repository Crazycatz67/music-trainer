// home.js — the star dome as the home of the app (browser): it mounts js/app/sky.js behind
// the screens, fills the five places with the real record, runs Tonight's Start, and keeps
// the sky in step with the address. docs/design/specs/2026-10-12-sky-dome.md sections 4, 7
// and 9 (slices 2 and 3); docs/design/specs/2026-10-12-living-sky.md section 9.
//
// index.html loads this file with a dynamic import() AFTER the first screen is drawn, so a
// failed load (this file, sky.js, dome.js or three.js) never blanks the page: the screens
// work without it and the page's own plain links stand in for the sky.
//
// Who decides what: the ADDRESS is the truth. js/app/shell.js shows the screen for it and
// fires 'mt:route'; this file only turns the sky to match (js/app/skyroutes.js moveFor).
// Nothing here opens the microphone or plays a sound.
//
// CONTRACT
//   homeFacts({ plan, data, today }) -> facts        PURE (tools/checks/skyroutes.check.mjs)
//       plan    daily.js dailyPlan() output;  data  sessions.read();  today  sessions.today()
//       facts   { planned (daily.js planState), today: { done, total } (the moon and its step
//                 stars), label (the main button), states: { [placeId]: line 3 of its label },
//                 stars (notes held in tune, ever), rounds (skymap.earnedSky input) }
//   mountHome(root, { shell, sessions, daily, plan, micflow, storage = null, gl = 'auto',
//                     startSetup = () => false }) -> home
//       root        an empty element BEFORE the page's other controls (Tab order: Start, the
//                   five places, then the corner cluster)
//       plan()      -> dailyPlan(...) now
//       startSetup() -> true when Start must lead to the setup path (first run)
//       gl          sky.js's switch: 'auto' | 'off' | 'soft'
//       onFrame     (t) => void, right after each dome frame (lab probes only)
//       home.sky    the sky.js controller;  home.refresh() re-reads the record
//       home.debug() -> { facts, moves: [the last 20 { to, move }], skyNow: skynow.js debug() }
//       home.destroy()
//   Sets <html data-sky="dome" | "links">: the page's CSS hides its own plain links once the
//   sky has taken over.
//   The dome draws nothing while a microphone track is live (micflow phases waiting,
//   checking, on), while a take is scored ('mt:busy') and while a sheet is open ('mt:sheet').
//   Failure: createSky cannot fail loudly (no WebGL, a narrow window, three.js missing: it
//   shows its plain column of the same five links); a throw from here is index.html's to catch.

import { planState } from './daily.js';
import { createSky } from './sky.js';
import { startSkyNow } from './skynow.js';
import { earnedSky, TRAVEL, travelMs } from './skymap.js';
import { parseRoute, sheetOpen } from './shell.js';
import { HOME_ROUTE, moveFor, placeOf } from './skyroutes.js';

const LADDER = ['range', 'matchhold', 'constellation'];   // the Ladder's exercises that exist
const LADDER_STARS = 6;                                   // one star per exercise, built or not
const MIC_LIVE = new Set(['waiting', 'checking', 'on']);
const FADE_MS = 200;
// The longest glide a press on Start may wait behind (further than this the sky fades
// through instead): the press's window is stretched by this much (daily.press).
const GLIDE_MAX_MS = travelMs(TRAVEL.throughDeg);

const nightOf = (day) => Math.round(Date.parse(`${day}T12:00:00Z`) / 86400000);

export function homeFacts({ plan = [], data = null, today = '' } = {}) {
  const sessions = (data && data.sessions) || [];
  const takes = sessions.flatMap((s) => s.takes.map((t) => ({ ...t, day: s.day })));
  const planned = planState(plan, takes.filter((t) => t.day === today));
  const done = planned.steps.filter((s) => s.done).length, total = planned.steps.length;
  const tried = LADDER.filter((id) => takes.some((t) => t.exercise === id)).length;
  const stars = takes.reduce((n, t) => n + (t.stars || 0), 0);
  // A round = one take's held notes, in the order sung; clean = every note of it was held.
  const rounds = takes.map((t, i) => ({
    id: `${t.at || t.day}-${i}`, night: nightOf(t.day), clean: t.of > 0 && t.stars === t.of,
    notes: (t.notes || []).filter((n) => n.held && Number.isFinite(n.midi)).map((n) => n.midi),
  })).filter((r) => r.notes.length);
  return {
    planned, label: planned.label, today: total ? { done, total } : null, stars, rounds,
    states: {
      today: !takes.length ? 'Press Start to light your first star.' : planned.allDone ? 'Done for today' : `${done} of ${total} steps done`,
      practice: `${tried} of ${LADDER_STARS} tried`,
      sing: 'Nothing to pass',
      songs: 'Sing along with your own songs',
      progress: stars === 0 ? 'Your first star is one held note away.' : stars === 1 ? '1 star (a note held in tune)' : `${stars} stars (notes held in tune)`,
    },
  };
}

export function mountHome(root, { shell, sessions, daily, plan, micflow, storage = null, gl = 'auto', startSetup = () => false, onFrame = null } = {}) {
  const doc = document.documentElement;
  let facts = homeFacts({ plan: plan(), data: sessions.read(), today: sessions.today() });
  let busy = false, destroyed = false, pendingStart = null;
  const moves = [];
  const atHome = () => (shell.route() || {}).name === HOME_ROUTE;

  // Start glides to the step's place first and begins on landing, so the screen (which may
  // open the microphone 300 ms after it is drawn) never appears while the dome is moving.
  // The press is taken HERE, while the person is pressing (daily.press), and handed on: if
  // the page is hidden, a sheet opens, the address changes or too long passes before the
  // glide lands, daily.begin still opens the step but starts nothing (bugs.md 61: the glide
  // froze on a hidden page, finished on return, and the microphone opened with no new press).
  function pressStart() {
    if (pendingStart) return;
    const setup = startSetup();
    const st = facts.planned, index = st.allDone ? 0 : st.next;
    const step = st.steps[index];
    const press = daily.press(GLIDE_MAX_MS);
    const act = () => { if (setup) shell.navigate('#/setup'); else daily.begin(index, { press }); };
    const target = setup ? 'today' : placeOf(parseRoute(step ? step.route : ''));
    if (!target || sky.mode() !== 'dome' || sky.where().state !== 'home') { act(); return; }
    const mine = (pendingStart = { press });
    sky.travelTo(target).then((ok) => {
      if (pendingStart === mine) pendingStart = null;
      if (destroyed || !ok || !atHome()) { daily.spend(press); return; }   // turned back with Esc, or went elsewhere
      act();
      // Nothing came of it (no step to begin): never strand the person in an empty place.
      setTimeout(() => { if (!destroyed && atHome() && sky.where().state === 'place') sky.travelBack(); }, 0);
    });
  }

  const sky = createSky(root, {
    gl, travel: true, strip: false, escBack: false, store: storage || undefined,
    states: facts.states, primary: { label: facts.label, onPress: pressStart },
    enabled: () => !sheetOpen(), onFrame,
    // The address changes at the start of the journey, so the browser's Back works at once.
    onTravel: (pl, e) => { if (sky.mode() === 'dome' && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) shell.navigate(pl.route); },
    onArrive: () => { if (!atHome()) shell.view.querySelector('h1')?.focus({ preventScroll: true }); },
  });

  // The real stars over the owner's city (living-sky spec Part 1). This file already loads
  // after the first screen is drawn, and the fetch never blocks: a failed or slow load keeps
  // the made-up sky. Started now so the data usually lands before three.js has drawn a frame.
  let saved = storage;
  try { saved = saved || window.localStorage; } catch { saved = null; }
  const skyNow = startSkyNow(sky, { storage: saved, atHome });

  function refresh() {
    facts = homeFacts({ plan: plan(), data: sessions.read(), today: sessions.today() });
    sky.setStates(facts.states);
    sky.setPrimary({ label: facts.label, onPress: pressStart });
    sky.setToday(facts.today);
    sky.setEarned(earnedSky(facts.rounds).items);
  }

  function follow(route) {
    const { state, place } = sky.where();
    const move = sky.mode() === 'dome' ? moveFor({ to: route, where: state, place }) : 'none';
    moves.push({ to: `${route.name}${route.param ? `/${route.param}` : ''}`, move });
    if (moves.length > 20) moves.shift();
    if (move === 'glide') sky.travelTo(placeOf(route));
    else if (move === 'back') sky.travelBack();
    else if (move === 'fade') {
      sky.openAt(placeOf(route), { fade: true });
      // The screen fades in with the backdrop (spec section 7, "Other cases").
      shell.view.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
    }
  }

  const onRoute = (e) => {
    const { route } = e.detail;
    // The record may have grown while away: the places say so on the way home.
    if (route.name === HOME_ROUTE) refresh();
    follow(route);
  };
  const quiet = () => sky.setBusy(busy || sheetOpen());
  const onBusy = (e) => { busy = !!e.detail.on; quiet(); };
  const onSheet = () => quiet();
  const onTake = () => refresh();
  // The window crossed the dome's smallest size: the sky swapped between dome and plain
  // links and forgot where it was, so put it back behind the screen that is showing.
  const onMode = () => {
    doc.dataset.sky = sky.mode();
    const route = shell.route();
    if (route && placeOf(route) && sky.mode() === 'dome' && sky.where().state === 'home') sky.openAt(placeOf(route));
  };
  // A Start glide has no address of its own yet: Esc turns it round here (the shell's Esc
  // only knows screens). The press itself is spent by daily.js on ANY Esc, glide or not
  // (bugs.md 63); spending it here too keeps this file right on its own.
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || sheetOpen() || !atHome()) return;
    if (sky.where().state === 'going') { if (pendingStart) daily.spend(pendingStart.press); pendingStart = null; sky.travelBack(); }
  };
  document.addEventListener('mt:route', onRoute);
  document.addEventListener('mt:busy', onBusy);
  document.addEventListener('mt:sheet', onSheet);
  document.addEventListener('mt:take', onTake);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onMode);
  const unmic = micflow ? micflow.subscribe((s) => sky.setMicLive(MIC_LIVE.has(s.phase))) : () => {};
  if (micflow) sky.setMicLive(MIC_LIVE.has(micflow.state().phase));

  refresh();
  // Also: opened on a screen's own address, the dome starts dim and still, facing its place.
  onMode();
  sky.ready.then(() => { if (!destroyed) onMode(); });

  return {
    sky, refresh,
    debug: () => ({ facts, moves: [...moves], skyNow: skyNow.debug() }),
    destroy() {
      destroyed = true;
      document.removeEventListener('mt:route', onRoute);
      document.removeEventListener('mt:busy', onBusy);
      document.removeEventListener('mt:sheet', onSheet);
      document.removeEventListener('mt:take', onTake);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMode);
      unmic();
      skyNow.stop();
      sky.destroy();
      delete doc.dataset.sky;
    },
  };
}
