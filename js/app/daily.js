// daily.js — Today and the guided daily session (spec section 4): one Start that walks
// through the exercises that exist, in the study-backed order of docs/PLAN.md (range check,
// then single-note matching, then short patterns), with Skip and Stop always there.
//
// The top half is PURE and imports in Node (tools/checks/sessions.check.mjs).
//
// CONTRACT — pure
//   STEP_INFO      exercise id -> { name, route, doneEvent }  (doneEvent: the 'mt:exercise'
//                  event that means "this step is finished")
//   dailyPlan({ range, figures, now?, config? }) -> [Step]
//       range    the saved range entry (js/app/range.js readRange) or null
//       figures  figures.js readSaved(...) output
//       Step     { id, name, route, sec }. 'range' is in the plan only when no range is saved
//                or it is older than config.daily.rangeMaxAgeDays; then Match and hold; then
//                one constellation: the first figure not finished yet, else the one sung
//                longest ago.
//   planState(plan, takesToday) -> { steps: [Step + { done }], next (index or -1), allDone,
//                                    label, minutes }
//       done: an exercise of that kind was finished today. label: "Start" | "Continue: <name>" |
//       "Do it again". minutes: the whole plan, rounded.
//   lengthWords(sec) -> "90 seconds" | "1 minute"
//
// CONTRACT — browser
//   createDaily({ sessions, navigate, plan, config? }) -> daily
//       plan() -> dailyPlan(...) at the time of the press
//       daily.begin(fromIndex?, { press }?)   from a press on Today: starts (or carries on)
//                                 today's session and goes to that step. Called straight from
//                                 the press it IS the press; called later (the home's glide)
//                                 it is handed the press made at the time, and a press spent
//                                 since then still opens the step, ready, with its own Start.
//       daily.press(extraMs = 0) -> press   call it INSIDE the press handler when the start
//                                 comes later (after a glide of at most extraMs). One press is
//                                 alive at a time; daily.spend(press) ends it early (Esc);
//                                 daily.pressLive(press) -> boolean.
//       THE ONE RULE (pressAfter / pressLive below, bugs.md 61): a press may start an
//       exercise only while the page it was made on is still in front of the person. It is
//       spent for good the moment the page is hidden or left, a sheet opens, the address
//       changes to anywhere but the step it leads to, Esc is pressed (anywhere, at any
//       moment of the wait: bugs.md 63), or config.daily.armMs + startAfterMs (+ extraMs)
//       pass. Every start that waits (a glide, a timer, a new screen) asks this
//       one rule again at the moment it would act.
//       daily.armed(exerciseId) -> boolean   true once, shortly after a press on Start or
//                                 Continue led to this step: the screen may start itself, since
//                                 the press was the person's own. Never true on a plain load,
//                                 and never after "Skip this step": someone skipping is
//                                 hesitating, so the next screen lands ready, not started
//                                 (design review 5).
//       daily.autoStart(exerciseId, start) -> cancel()   calls start() config.daily.startAfterMs
//                                 after the screen is drawn, when armed(exerciseId). Owner rule
//                                 (the microphone is on only when the owner turned it on): the
//                                 start is dropped for good if the press is spent by then (the
//                                 rule above): the press was for the screen the person could
//                                 see (bugs.md 52, 61).
//       Space, once the step is finished, presses Continue from anywhere on the page that
//       does not use Space itself (the exercise's own "Again" keeps Enter and its own focus).
//       daily.strip(exerciseId) -> element | null   the "Today · step 2 of 3" bar for that
//                                 exercise's screen; null when it is not the current step
//       daily.shown(routeName, param)   the router says what is on screen: anywhere else than
//                                 the step, takes stop being filed under the daily session
//       daily.next({ start = true }?), stopHere(), state() -> { index, count, stepDone, id } | null,
//       destroy()                 next({ start: false }) is Skip: it goes on without arming
//       The microphone is never opened here: each exercise opens it from its own start(), and
//       has released it by the time its doneEvent fires.
//   mountToday(view, { sessions, daily, plan, rangeCard, config? }) -> cleanup

import { CONFIG } from './config.js';
import { tipCard } from './coachcard.js';
import { FIGURES } from './figures.js';
import { streakWords } from './sessions.js';
import { banner, h, icon } from './shell.js';

// ---------------------------------------------------------------- pure

export const STEP_INFO = Object.freeze({
  range: { name: 'Find your range', route: '#/practice/range', doneEvent: 'saved' },
  matchhold: { name: 'Match and hold', route: '#/practice/match', doneEvent: 'done' },
  constellation: { name: 'Sing a constellation', route: '#/practice/constellation', doneEvent: 'done' },
});

function pickFigure(figures) {
  const saved = figures || {};
  const open = FIGURES.find((f) => !(saved[f.id] && saved[f.id].completedAt));
  if (open) return open;
  // Every figure is finished: the one sung longest ago comes round again.
  return FIGURES.slice().sort((a, b) => String(saved[a.id].lastSungAt || '').localeCompare(String(saved[b.id].lastSungAt || '')))[0];
}

export function dailyPlan({ range = null, figures = null, now = new Date(), config = CONFIG } = {}) {
  const D = config.daily;
  const step = (id, extra = {}) => ({ id, name: STEP_INFO[id].name, route: STEP_INFO[id].route, sec: D.stepSec[id], ...extra });
  const out = [];
  const at = range && typeof range.at === 'string' ? new Date(range.at).getTime() : NaN;
  // A range with no readable date counts as old: measuring again costs a minute.
  const old = !Number.isFinite(at) || now.getTime() - at > D.rangeMaxAgeDays * 86400e3;
  if (!range || old) out.push(step('range'));
  out.push(step('matchhold'));
  const figure = pickFigure(figures);
  out.push(step('constellation', { route: `${STEP_INFO.constellation.route}/${figure.id}`, figure: figure.id }));
  return out;
}

export function lengthWords(sec) {
  if (sec % 60 === 0) return `${sec / 60} ${sec === 60 ? 'minute' : 'minutes'}`;
  return `${sec} seconds`;
}

export function planState(plan, takesToday = []) {
  const sung = new Set(takesToday.map((t) => t.exercise));
  const steps = plan.map((s) => ({ ...s, done: sung.has(s.id) }));
  const next = steps.findIndex((s) => !s.done);
  const any = steps.some((s) => s.done);
  return {
    steps, next, allDone: next < 0,
    label: next < 0 ? 'Do it again' : any ? `Continue: ${steps[next].name}` : 'Start',
    minutes: Math.max(1, Math.round(plan.reduce((s, p) => s + p.sec, 0) / 60)),
  };
}

// An authorising press (a press on Start or Continue that may start the next exercise, and
// so open the microphone, a little later). Pure: the browser part below feeds it events.
//   newPress(now, windowMs, from) -> press { at, until, from, expect, spent }
//       from     the address the press was made on;  expect  the one it leads to (set later)
//       spent    null | 'hidden' | 'sheet' | 'route' | 'late' | 'cancelled' | 'used'
//   pressAfter(press, event) -> press    event: { type: 'hidden' } | { type: 'sheet' } |
//       { type: 'route', hash } | { type: 'cancel' } | { type: 'use' } | { type: 'expect', hash }
//       Once spent, a press stays spent with its first reason: nothing brings it back.
//   pressLive(press, now) -> boolean
export function newPress(now, windowMs, from = null) {
  const ok = Number.isFinite(now) && Number.isFinite(windowMs) && windowMs > 0;
  return { at: now, until: ok ? now + windowMs : -Infinity, from, expect: null, spent: ok ? null : 'late' };
}
export function pressAfter(press, event) {
  if (!press || press.spent || !event) return press;
  const spend = (why) => ({ ...press, spent: why });
  switch (event.type) {
    case 'hidden': return spend('hidden');
    case 'sheet': return spend('sheet');
    case 'cancel': return spend('cancelled');
    case 'use': return spend('used');
    case 'expect': return { ...press, expect: event.hash };
    case 'route': return event.hash === press.from || (press.expect !== null && event.hash === press.expect) ? press : spend('route');
    default: return press;
  }
}
export function pressLive(press, now) {
  return !!press && !press.spent && Number.isFinite(now) && now >= press.at && now <= press.until;
}

// ---------------------------------------------------------------- browser

const keycap = () => h('kbd', { class: 'keycap' }, 'Space');

export function createDaily({ sessions, navigate, plan, config = CONFIG } = {}) {
  // run: { id, day, steps, index, stepDone }. Kept after a wander elsewhere so Continue on
  // Today carries on in the same session.
  let run = null, armedFor = null, stripEl = null;

  // The one press that may still start something (see THE ONE RULE above). `cur.id` is what
  // callers hold; the state behind it only ever moves through pressAfter().
  let cur = null;
  const win = typeof window !== 'undefined' ? window : null;   // (a Node check has a document only)
  const hashNow = () => { try { return location.hash; } catch { return null; } };
  const tell = (event) => { if (cur) cur.state = pressAfter(cur.state, event); };
  const blocked = () => document.hidden || !!document.querySelector('dialog[open]');
  function press(extraMs = 0) {
    const id = {};
    cur = { id, state: newPress(performance.now(), config.daily.armMs + config.daily.startAfterMs + Math.max(0, extraMs || 0), hashNow()) };
    if (document.hidden) tell({ type: 'hidden' }); else if (blocked()) tell({ type: 'sheet' });
    return id;
  }
  // THE guard: every deferred start asks here, at the moment it would act.
  function live(id) {
    if (!cur || !id || cur.id !== id) return false;
    if (document.hidden) tell({ type: 'hidden' }); else if (blocked()) tell({ type: 'sheet' });
    return pressLive(cur.state, performance.now());
  }
  const spend = (id) => { if (cur && cur.id === id) tell({ type: 'cancel' }); };
  const onHidden = () => { if (document.hidden) tell({ type: 'hidden' }); };
  const onPageHide = () => tell({ type: 'hidden' });
  const onSheet = (e) => { if (!e.detail || e.detail.open !== false) tell({ type: 'sheet' }); };
  const onHash = () => tell({ type: 'route', hash: hashNow() });
  document.addEventListener('visibilitychange', onHidden);
  win?.addEventListener('pagehide', onPageHide);
  document.addEventListener('mt:sheet', onSheet);
  win?.addEventListener('hashchange', onHash);

  const step = () => (run ? run.steps[run.index] : null);

  function paintStrip() {
    if (!stripEl || !run) return;
    const s = step(), last = run.index === run.steps.length - 1;
    const nextName = last ? 'Coach notes' : run.steps[run.index + 1].name;
    const go = run.stepDone
      // Made only when the step is finished: Space presses the first main button on the
      // screen, and until then that is the exercise's own.
      ? h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '', daily: 'continue' }, onclick: () => next() }, 'Continue ', keycap())
      : h('button', { class: 'btn btn-quiet', type: 'button', dataset: { daily: 'skip' }, onclick: () => next({ start: false }) }, 'Skip this step');
    stripEl.dataset.done = run.stepDone ? 'yes' : 'no';
    stripEl.replaceChildren(
      h('p', { class: 'daily-where' }, `Today · step ${run.index + 1} of ${run.steps.length}`),
      h('div', { class: 'daily-bar', role: 'img', 'aria-label': `Step ${run.index + 1} of ${run.steps.length}: ${s.name}` },
        run.steps.map((_, i) => h('span', { dataset: { state: i < run.index || (i === run.index && run.stepDone) ? 'done' : i === run.index ? 'now' : 'todo' } }))),
      h('p', { class: 'daily-next' }, `Next: ${nextName}`),
      go,
      h('button', { class: 'btn btn-quiet', type: 'button', dataset: { daily: 'stop' }, onclick: () => stopHere() }, 'Stop here'));
    if (run.stepDone) go.focus({ preventScroll: true });
  }

  // Armed = "the live press `armedBy` leads to this exercise's screen".
  let armedBy = null;
  function arm(id, by) { armedFor = id; armedBy = by; }

  // Nothing changes until the new screen is really shown (shown() below): leaving in the
  // middle of a take asks first, and "Keep singing" must leave the session where it was.
  // `by`: the press that asked (null: this call is itself the press). A spent press still
  // goes to the step, but arms nothing: the screen lands ready, with its own Start.
  function goTo(index, start = true, by = null) {
    run.want = index;
    run.ending = false;
    if (start && !by) by = press();
    if (start && live(by)) { tell({ type: 'expect', hash: run.steps[index].route }); arm(run.steps[index].id, by); }
    else { armedFor = armedBy = null; if (by) spend(by); }
    navigate(run.steps[index].route);
  }

  function begin(fromIndex = null, { press: by = null } = {}) {
    const today = sessions.today(), steps = plan();
    // A new day, or nothing begun yet: a new session. Otherwise the one begun earlier today.
    if (!run || run.day !== today) run = { id: sessions.beginDaily(), day: today, steps, index: 0, stepDone: false, want: null, ending: false };
    else run.steps = steps;
    goTo(Math.max(0, Math.min(steps.length - 1, fromIndex ?? 0)), true, by);
  }

  function finish() {
    run.ending = true;
    run.want = null;
    const session = sessions.session(run.id);
    navigate(session && session.takes.length ? `#/coach/${run.id}` : '#/today');
  }

  function next({ start = true } = {}) {
    if (!run) return;
    if (run.index + 1 < run.steps.length) goTo(run.index + 1, start); else finish();
  }
  function stopHere() { if (run) finish(); }

  function onExercise(e) {
    const d = e.detail || {}, s = step();
    if (!s || d.exercise !== s.id || !stripEl || !stripEl.isConnected) return;
    if (d.event === STEP_INFO[s.id].doneEvent) run.stepDone = true;
    else if (d.event === 'start') run.stepDone = false;
    else return;
    paintStrip();
  }
  document.addEventListener('mt:exercise', onExercise);

  // The bar says "Continue [Space]", and so does the exercise's own main button ("Again",
  // "Back to Practice"), which comes first on the page: Space pressed that one, and a
  // finished step began again or the session was left (bugs.md 53). In the session, Space
  // on a finished step is Continue. Heard first (capture), and the others are not told.
  const OWN_SPACE = 'button, a, input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"], [role="option"], [role="menuitem"], [role="slider"], [role="textbox"], [role="combobox"]';
  function onKey(e) {
    // Esc is an explicit "no" to whatever a press is still waiting to start (bugs.md 63):
    // heard here, first, whatever the screen makes of the key itself (its Pause, Back, or
    // nothing at all on a screen that has not started).
    if (e.key === 'Escape') { tell({ type: 'cancel' }); return; }
    if (!run || !run.stepDone || !stripEl || !stripEl.isConnected) return;
    if (e.key !== ' ' || e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest(OWN_SPACE)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    next();
  }
  document.addEventListener('keydown', onKey, true);

  // -> the press that leads here, or null. True once.
  function armedPress(id) {
    const by = armedFor === id && live(armedBy) ? armedBy : null;
    armedFor = armedBy = null;
    return by;
  }
  const armed = (id) => !!armedPress(id);

  return {
    begin, next, stopHere, armed, press, spend, pressLive: live,
    pressState: (id) => (cur && cur.id === id ? { ...cur.state } : null),
    autoStart(id, start) {
      const by = armedPress(id);
      if (!by) return () => {};
      // Hidden even for a moment of the wait drops the start for good: a page that comes
      // back is not the page the press was made on, and the microphone must not open on it.
      // The press says so itself (live), whatever spent it and whenever.
      const timer = setTimeout(() => {
        if (!live(by)) return;
        tell({ type: 'use' });
        start();
      }, config.daily.startAfterMs);
      return () => { clearTimeout(timer); spend(by); };
    },
    strip(id) {
      const s = step();
      if (!s || s.id !== id) return null;
      stripEl = h('aside', { class: 'daily-strip', 'aria-label': 'Today’s session', dataset: { step: String(run.index + 1) } });
      paintStrip();
      return stripEl;
    },
    shown(name, param) {
      if (!run) return;
      const here = `#/${name}${param ? `/${param}` : ''}`;
      stripEl = null;
      if (run.ending && (name === 'coach' || name === 'today')) { run = null; sessions.endDaily(); return; }
      run.ending = false;
      if (run.want !== null && here === run.steps[run.want].route) { run.index = run.want; run.stepDone = false; }
      run.want = null;
      // Free practice in the middle of a session is not part of it.
      if (here === step().route) sessions.beginDaily(run.id); else sessions.endDaily();
    },
    state: () => (run ? { index: run.index, count: run.steps.length, stepDone: run.stepDone, id: run.id } : null),
    destroy() {
      document.removeEventListener('mt:exercise', onExercise); document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onHidden); win?.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('mt:sheet', onSheet); win?.removeEventListener('hashchange', onHash);
      cur = null;
    },
  };
}

const linkCard = (href, title, line, chip) => h('a', { class: 'card card-link', href },
  h('div', null, h('h2', null, title, chip && h('span', { class: 'chip chip-small' }, chip)), h('p', null, line)), icon('chevron'));

export function mountToday(view, { sessions, daily, plan, rangeCard = null, config = CONFIG } = {}) {
  const data = sessions.read(), today = sessions.today();
  const todays = data.sessions.filter((s) => s.day === today);
  const state = planState(plan(), todays.flatMap((s) => s.takes));
  const streak = sessions.streak();
  const stars = todays.reduce((n, s) => n + s.takes.reduce((k, t) => k + t.stars, 0), 0);
  // The newest of today's sessions that the coach has something to read in.
  const coached = todays.slice().reverse().find((s) => s.takes.some((t) => t.notes.length));

  const path = h('ol', { class: 'path path-live' },
    state.steps.map((s, i) => {
      const kind = s.done ? 'done' : i === state.next ? 'next' : 'todo';
      return h('li', { dataset: { state: kind } },
        h('button', { class: 'path-step', type: 'button', 'aria-label': `${s.name}, ${lengthWords(s.sec)}${s.done ? ', done today' : ''}. Start from here`, onclick: () => daily.begin(i) },
          h('span', { class: 'path-dot', 'aria-hidden': 'true' }, s.done ? icon('tick', 16) : String(i + 1)),
          h('span', { class: 'path-name' }, s.name), h('span', { class: 'path-len' }, lengthWords(s.sec))));
    }),
    h('li', { dataset: { state: 'coach' } }, h('span', { class: 'path-step' },
      h('span', { class: 'path-dot path-ring', 'aria-hidden': 'true' }), h('span', { class: 'path-name' }, 'Coach notes'), h('span', { class: 'path-len' }, 'at the end'))));

  const start = h('button', {
    class: `btn ${state.allDone ? 'btn-secondary' : 'btn-primary'}`, type: 'button', 'aria-describedby': 'today-why',
    dataset: state.allDone ? { daily: 'start' } : { primary: '', daily: 'start' },
    onclick: () => daily.begin(state.allDone ? 0 : state.next),
  }, `${state.label} `, !state.allDone && keycap());
  const notes = state.allDone && coached
    ? h('a', { class: 'btn btn-primary', href: `#/coach/${coached.id}`, dataset: { primary: '' } }, 'See coach notes ', keycap()) : null;

  // Through h(): it drops what is not there (append() would write "false" on the page).
  view.append(...h('div', null,
    h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Today'),
      h('p', { class: 'streak', dataset: { state: streak.state } }, icon('flame', 20), streakWords(streak))),
    !data.ok && banner({ role: 'close', iconName: 'warning', text: 'Could not read your saved progress. You can still practise; nothing new will be lost.' }),
    h('div', { class: 'today-grid' },
      h('section', { class: 'card card-session', dataset: { state: state.allDone ? 'done' : state.next > 0 || state.steps.some((s) => s.done) ? 'part' : 'new' } },
        h('h2', null, state.allDone ? 'Done for today' : 'Today’s session',
          state.allDone && stars > 0 && h('span', { class: 'chip chip-small', dataset: { role: 'gold' } }, icon('star', 12), `${stars} ${stars === 1 ? 'star' : 'stars'}`)),
        path,
        h('div', { class: 'action-row' }, notes, start,
          h('p', { class: 'reason', id: 'today-why' }, `About ${state.minutes} minutes. Start turns the microphone on. You can skip any step.`))),
      h('div', { class: 'today-side' },
        rangeCard || h('section', { class: 'card' }, h('h2', null, 'Your range'), h('p', null, 'Not measured yet')),
        tipCard(sessions, { config })),
      h('div', { class: 'shortcuts' },
        linkCard('#/sing', 'Free sing', 'See your note live'),
        linkCard('#/practice', 'Practice', 'Pick one exercise'),
        linkCard('#/songs', 'Songs', 'Sing along')))).childNodes);
  return null;
}
