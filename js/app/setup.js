// setup.js — the first-run setup path, #/setup: four steps on one card, one visible at a
// time (docs/design/specs/2026-10-12-singing-trainer.md section 4, "First run"):
// 1 Microphone -> 2 Headphones -> 3 Find your range -> 4 First notes (the first test is not
// built yet: until it is, step 4 only leads to Match and hold; review 4, finding 9).
//
// The top part is PURE and imports in Node (tools/checks/range.check.mjs).
//
// CONTRACT — pure
//   SETUP_STEPS            [{ id: 'mic' | 'phones' | 'range' | 'test', name }]
//   SETUP_WORDS            the sentences of steps 1 and 4: listening, heard, silent, micOff,
//                          test { title, line, quiet }
//   SETUP_KEY              'music-trainer.setup.v1' -> { laterAt?, doneAt? } (ISO dates)
//   setupStart(storage) -> boolean   should Today be replaced by the setup path? True on a
//       first run: no saved range, and setup neither finished nor put off with "Later".
//       Storage that cannot be read counts as a first run (the caller remembers "Later" for
//       the visit).
//
// CONTRACT — mountSetup(view, { shell, micflow, settings, storage?, micOptions?, onLeave?, config? }) -> screen
//   shell needs: askHeadphones(), headphones(), navigate(), calm(), setBusy(), openSettings()
//   onLeave(kind)   'later' | 'done': called before the screen sends the person on
//   The microphone: step 1 asks for it from its button only. It then LISTENS for up to
//   config.setup.hearMs, showing the level, and lets the microphone go as soon as it has
//   heard something or the time is up (a muted or wrong microphone used to pass on the
//   permission alone). Step 3 is the Find your range screen with its own rules. Leaving a
//   step releases whatever that step had open.
//   Space presses the main button on steps 1, 2 and 4 from anywhere that is not itself a
//   control (it shows the key); on step 3 the range screen's own button has it.
//   Step 3 has ONE action row: Back and "Set up later" sit in the range screen's row.
//   In the middle of a take, Back and "Set up later" ask the range screen's leave question
//   first, and nothing is recorded if the answer is "Keep singing" (bugs.md 45).
//   screen.state() -> { step (0..3), id, micOk, mic, phones, saved }
//       mic: 'idle' | 'asking' | 'listening' | 'heard' | 'silent'
//   screen.act()    the main button's press     screen.go(i), next(), back(), later()
//       back() and later() -> Promise (they may ask)
//   screen.range    step 3's Find your range screen, else null     screen.destroy()

import { CONFIG } from './config.js';
import { spaceActs } from './exercises/matchhold.js';
import { mountRangeFinder } from './exercises/rangefinder.js';
import { readRange } from './range.js';
import { starSvg } from './rewards.js';
import { h, icon, sheetOpen, STORAGE_PREFIX } from './shell.js';

export const SETUP_STEPS = Object.freeze([
  Object.freeze({ id: 'mic', name: 'Microphone' }), Object.freeze({ id: 'phones', name: 'Headphones' }),
  Object.freeze({ id: 'range', name: 'Find your range' }), Object.freeze({ id: 'test', name: 'First notes' }),
]);

export const SETUP_WORDS = Object.freeze({
  listening: 'Listening… say ‘ah’.',
  heard: 'I can hear you.',
  heardMore: 'The microphone is off again until you press Start in an exercise.',
  silent: 'I can’t hear anything yet. Say ‘ah’.',
  micOff: 'The microphone is not on yet. Press the button to try again.',
  test: Object.freeze({
    title: 'Your first notes',
    line: 'Sing five notes and hold each one steady. About 90 seconds.',
    quiet: 'Your range is saved. Every exercise now stays inside it.',
    quietNoRange: 'You can measure your range later from Today.',
  }),
});

export const SETUP_KEY = `${STORAGE_PREFIX}setup.v1`;

export function setupStart(storage) {
  if (readRange(storage)) return false;
  try {
    const s = JSON.parse((storage && storage.getItem(SETUP_KEY)) || 'null');
    return !(s && typeof s === 'object' && (s.laterAt || s.doneAt));
  } catch { return true; }
}

// ---------------------------------------------------------------- browser

// sessions (js/app/sessions.js) is passed on to the range step, so the first measurement
// counts as a day of practice.
export function mountSetup(view, { shell, micflow, settings, storage, micOptions, onLeave = null, config = CONFIG, sessions = null } = {}) {
  const store = storage !== undefined ? storage : (() => { try { return window.localStorage; } catch { return null; } })();
  const hearMs = (config.setup && config.setup.hearMs) || 4000;
  // mic: 'idle' | 'asking' (waiting for the browser) | 'listening' | 'heard' | 'silent'
  let step = 0, mic = 'idle', micWhy = '', dead = false, range = null, saved = !!readRange(store), stopListening = null;
  const micOk = () => mic === 'heard';
  const busy = () => mic === 'asking' || mic === 'listening';

  // Four stars on one line (review 4, 6e): outline = to do, ringed = now, filled with a tick =
  // done. The states are CSS (css/range.css) on each li's data-state; the tick is always
  // there and shown only when done.
  const dots = h('ol', { class: 'setup-dots' }, SETUP_STEPS.map((s, i) => h('li', null,
    h('span', { class: 'setup-star', 'aria-hidden': 'true' }, starSvg('held', 24), icon('tick', 12)),
    h('span', { class: 'path-name' }, s.name),
    h('span', { class: 'visually-hidden step-state' }))));
  const count = h('p', { class: 'ex-step', role: 'status' });
  const body = h('div', { class: 'setup-step' });
  const backBtn = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => back() }, icon('back', 16), ' Back');
  const primary = h('button', { class: 'btn btn-primary', type: 'button', dataset: { primary: '' }, onclick: () => act() });
  const whyLine = h('p', { class: 'reason', role: 'status' });
  // Step 1 only, after a test that heard nothing: the person may know better than the test.
  const anywayBtn = h('button', { class: 'btn btn-secondary', type: 'button', hidden: true, onclick: () => next() }, 'Next anyway');
  const laterBtn = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => later() }, 'Set up later');
  const actionRow = h('div', { class: 'action-row' }, backBtn, h('div', { class: 'action-main' }, primary, whyLine), anywayBtn, laterBtn);
  // Step 1's level bar (the same parts as the microphone sheet's). Where it sits is CSS.
  const levelFill = h('div', { class: 'level-fill' });
  const levelBox = h('div', { class: 'level setup-level', hidden: true }, h('span', { class: 'level-label' }, 'Mic level'), h('div', { class: 'level-bar' }, levelFill));
  view.classList.add('setup');
  view.append(
    h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Set up'), count),
    h('section', { class: 'card setup-card' }, dots, body, actionRow));

  const remember = (patch) => {
    try {
      if (!store) return;
      const was = JSON.parse(store.getItem(SETUP_KEY) || 'null');
      store.setItem(SETUP_KEY, JSON.stringify({ ...(was && typeof was === 'object' ? was : {}), ...patch }));
    } catch { /* blocked or full: the caller keeps it for the visit */ }
  };
  const keycap = () => h('kbd', { class: 'keycap' }, 'Space');
  const phonesWords = () => ({ on: 'Headphones on', none: 'No headphones' }[shell.headphones()] || '');

  function endListening() {
    if (stopListening) { stopListening(); stopListening = null; }
    levelBox.hidden = true;
  }

  function leaveStep() {
    // Whatever the step had open goes with it: the range screen releases the microphone.
    if (range) {
      // Back and "Set up later" were lent to the range screen's row: they come home first.
      actionRow.prepend(backBtn);
      actionRow.append(laterBtn);
      range.destroy(); range = null;
    }
    endListening();
    if (busy()) { micflow.stop(); mic = 'idle'; }
  }

  function paint() {
    const id = SETUP_STEPS[step].id;
    view.dataset.step = id;
    // Step 3's two parts are counted here: its own heading row is not shown (review 4, 1).
    const part = id === 'range' && range ? { low: ' · part 1 of 2', high: ' · part 2 of 2' }[range.state().phase] || '' : '';
    count.textContent = `Step ${step + 1} of ${SETUP_STEPS.length}${part}`;
    [...dots.children].forEach((li, i) => {
      li.dataset.state = i < step ? 'done' : i === step ? 'now' : 'todo';
      li.querySelector('.step-state').textContent = i < step ? ' (done)' : '';
      if (i === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    backBtn.hidden = step === 0;
    let label = 'Next', why = '';
    if (id === 'mic') {
      label = mic === 'asking' ? 'Starting…' : mic === 'listening' ? 'Listening…' : micOk() ? 'Next' : mic === 'silent' ? 'Test again' : 'Turn on microphone';
      why = mic === 'listening' ? SETUP_WORDS.listening : micOk() ? `${SETUP_WORDS.heard} ${SETUP_WORDS.heardMore}` : mic === 'silent' ? SETUP_WORDS.silent : micWhy;
    } else if (id === 'phones') {
      label = shell.headphones() ? 'Next' : 'Answer';
      why = shell.headphones() ? `Your answer: ${phonesWords()}. You can change it from the top bar.` : '';
    } else if (id === 'test') label = 'Start: Match and hold';
    // Step 3 has its own main button (the range screen's) and its own row; this row steps
    // aside whole, so that Space reaches that button and there is one row of buttons.
    const own = id === 'range';
    actionRow.hidden = own;
    primary.hidden = own;
    primary.disabled = own || busy();
    const noKey = busy() || own;
    primary.replaceChildren(label, noKey ? '' : ' ', noKey ? '' : keycap());
    whyLine.replaceChildren(...(id === 'mic' && micOk() ? [icon('tick', 16), ' '] : []), why);
    anywayBtn.hidden = !(id === 'mic' && mic === 'silent');
    // Two names for two different things; step 4's simply goes on (review 4, finding 17).
    laterBtn.textContent = id === 'test' ? 'Go to Today' : id === 'range' && saved ? 'Skip this step' : 'Set up later';
  }

  function draw() {
    leaveStep();
    const id = SETUP_STEPS[step].id;
    const title = (text) => h('h2', { tabindex: '-1' }, `${step + 1}. ${text}`);
    if (id === 'mic') {
      body.replaceChildren(title('Microphone'),
        h('p', null, 'The app listens to your voice to show which note you are singing. Your voice stays on this computer.'),
        h('p', { class: 'reason' }, 'Pressing the button turns the microphone on for a short test. It goes off again when the test ends.'),
        levelBox);
    } else if (id === 'phones') {
      body.replaceChildren(title('Headphones'),
        h('p', null, 'When a note plays out loud, the microphone hears it and the pitch line follows the speaker instead of you. Headphones stop that.'),
        h('p', { class: 'reason' }, 'Without headphones each note plays first, then it’s your turn.'));
    } else if (id === 'range') {
      const host = h('div', { class: 'setup-range' });
      body.replaceChildren(host);
      range = mountRangeFinder(host, {
        shell, micflow, settings, storage: store, micOptions, embedded: true, config, sessions,
        rowStart: [backBtn], rowEnd: [laterBtn],
        onNext: () => { saved = true; next(); },
      });
    } else {
      body.replaceChildren(title(SETUP_WORDS.test.title),
        h('p', null, SETUP_WORDS.test.line),
        h('p', { class: 'reason' }, saved ? SETUP_WORDS.test.quiet : SETUP_WORDS.test.quietNoRange));
    }
    paint();
  }

  // Step 1: the microphone is open; wait for sound, show the level, then let it go.
  function listen() {
    return new Promise((resolve) => {
      const full = config.mic.levelFullScaleRms;
      let done = false;
      const finish = (heard) => { if (done) return; done = true; clearTimeout(timer); off(); stopListening = null; resolve(heard); };
      const off = micflow.onFrame((frame, level = 0) => {
        levelFill.style.width = `${Math.round(100 * Math.min(1, Math.sqrt(level / full)))}%`;
        // A voice, or anything clearly louder than a silent input: the microphone hears.
        if (frame.voiced || level >= config.mic.quietRms) finish(true);
      });
      const timer = setTimeout(() => finish(false), hearMs);
      stopListening = () => finish(false);
    });
  }

  async function act() {
    const id = SETUP_STEPS[step].id;
    if (id === 'mic' && !micOk()) {
      if (busy()) return;
      mic = 'asking'; micWhy = '';
      paint();
      const ok = await micflow.request(micOptions || {});
      if (dead || mic !== 'asking') { if (ok && !dead && mic === 'idle') micflow.stop(); return; }
      if (!ok) { mic = 'idle'; micWhy = SETUP_WORDS.micOff; paint(); return; }
      mic = 'listening';
      levelFill.style.width = '0%';
      levelBox.hidden = false;
      paint();
      const heard = await listen();
      if (dead || mic !== 'listening') return;
      // It was only a test: off again at once. The exercises ask for it themselves.
      micflow.stop();
      levelBox.hidden = true;
      mic = heard ? 'heard' : 'silent';
      paint();
      return;
    }
    if (id === 'phones' && !shell.headphones()) { await shell.askHeadphones(); if (!dead) paint(); return; }
    if (id === 'test') { finish('done', '#/practice/match'); return; }
    if (id !== 'range') next();
  }

  function go(i) {
    const n = Math.max(0, Math.min(SETUP_STEPS.length - 1, Math.round(i)));
    if (n === step || dead) return;
    step = n;
    // A test that heard nothing is not carried along: coming back starts it fresh.
    if (mic === 'silent') mic = 'idle';
    draw();
    const head = body.querySelector('h2');
    if (head) head.focus({ preventScroll: true });
  }
  const next = () => go(step + 1);
  // A take in the middle of step 3 is asked about before it is dropped (bugs.md 45).
  const mayLeave = async () => !range || range.confirmLeave();
  async function back() { if (await mayLeave() && !dead) go(step - 1); }

  function finish(kind, hash) {
    remember(kind === 'done' ? { doneAt: new Date().toISOString() } : { laterAt: new Date().toISOString() });
    if (onLeave) onLeave(kind);
    shell.navigate(hash);
  }
  async function later() {
    const id = SETUP_STEPS[step].id;
    if (id === 'range' && saved) { if (await mayLeave() && !dead) next(); return; }
    // Asked BEFORE anything is recorded: "Keep singing" used to leave setup marked as put off.
    if (!(await mayLeave()) || dead) return;
    leaveStep();
    finish(id === 'test' ? 'done' : 'later', '#/today');
  }

  const onPhones = () => { if (!dead) paint(); };
  const onRange = (e) => { if (!dead && e.detail && e.detail.exercise === 'range') paint(); };
  // The main button shows a Space key, so Space must press it from wherever focus is (it
  // lands on the heading). Off, it still swallows the key: Space must not scroll the page.
  const onKey = (e) => {
    if (dead || primary.hidden || !spaceActs(e, { sheet: sheetOpen() })) return;
    e.preventDefault();
    if (!primary.disabled) act();
  };
  document.addEventListener('mt:headphones', onPhones);
  document.addEventListener('mt:exercise', onRange);
  document.addEventListener('keydown', onKey);
  draw();

  return {
    act, go, next, back, later,
    get range() { return range; },
    state: () => ({ step, id: SETUP_STEPS[step].id, micOk: micOk(), mic, phones: shell.headphones(), saved }),
    destroy() {
      leaveStep();
      dead = true;
      document.removeEventListener('mt:headphones', onPhones);
      document.removeEventListener('mt:exercise', onRange);
      document.removeEventListener('keydown', onKey);
      delete view.dataset.step;
      view.classList.remove('setup');
    },
  };
}
