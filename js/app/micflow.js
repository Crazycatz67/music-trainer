// micflow.js — everything between "something needs the microphone" and "frames are
// flowing": the states of docs/design/specs/2026-10-12-singing-trainer.md section 10
// (10.1 asking, 10.2 blocked or missing, 10.3 sound clean-up still on, 10.5 no or poor
// signal) as a small state machine, with its sheet, banners, top-bar chip and Settings part.
//
// The rules are PURE and import in Node (tools/checks/micflow.check.mjs); createMicFlow is
// the browser half and only shows what the rules decided.
//
// CONTRACT — pure
//   nextPhase(phase, event) -> phase        unknown event for a phase -> the same phase
//       phases: off | asking | waiting | checking | on | blocked | missing | failed |
//               unsupported | lost
//       events: ask, request, granted, check, continue, dismiss, ended, stop, and the error
//               phases themselves (blocked, missing, failed, unsupported)
//   classifyError(err) -> 'blocked' | 'missing' | 'unsupported' | 'failed'   (by err.name)
//   cleanupRows(applied) -> [{ key, name, state: 'off' | 'on' | 'unknown', ok }]
//       applied = mic.applied from js/mic.js. 'unknown' (the browser did not say) is NOT
//       treated as on: it is shown as "not reported" and raises no banner.
//   chipFor({ phase, problem, cleanupOn }) -> { word, icon, role, warning }
//   createSignalMonitor(cfg?) -> { push(tMs, level, voiced, peak = 0) -> problem | null, reset() }
//       problem: 'silence' | 'quiet' | 'loud' | 'noisy', one at a time in that priority,
//       each only after its own delay (config.mic). level is loudness (RMS); peak is the
//       largest sample of the window. 'loud' is judged on the peak alone (clipping); a
//       caller that passes no peak never gets 'loud'.
//   createEvery(periodMs) -> { due(tMs) -> boolean }   a throttle that survives a restarted clock
//   bannerFor({ phase, listening, problem, cleanupOn, cleanupAck }) -> key | null
//       'lost' | 'cleanup' | a signal problem. One banner at a time.
//
// CONTRACT — createMicFlow({ shell, settings, chipEl, config?, startMicImpl? }) -> flow
//   flow.request({ stream? }) -> Promise<boolean>   true once frames can flow. Must be
//       called from a press. The first time it shows the "Turn on your microphone" sheet
//       and the level check; later it opens the mic directly. With `stream` (a MediaStream
//       made by the page) no microphone is asked for and no sheet is shown.
//   flow.stop()                 release the microphone -> phase 'off'
//   flow.onFrame(fn) -> unsubscribe      fn(frame, level) for every pitch frame
//   flow.subscribe(fn) -> unsubscribe    fn(flow.state()) on every change
//   flow.state() -> { phase, problem, listening, cleanup: { rows, anyOn, ack }, banner, chip }
//   flow.setListening(on)       signal problems are only timed and shown while a screen
//                               says it is listening
//   flow.mountBanners(el, { signal = true }) -> unmount     the screen's banner slot (above
//       the stage). signal: false leaves the signal problems (silence, quiet, loud, noisy)
//       out of this slot: an exercise shows them in its own reserved line, because a banner
//       opening above the stage moves the band under the singer's eyes (review 2, finding 3).
//       state().banner still names them. SIGNAL_PROBLEMS lists the four keys.
//   flow.openLevelCheck()       "Test the mic"
//   flow.cleanupWasOn() -> boolean       for the note a take carries (spec 10.3)
//   flow.mic                    the js/mic.js object while open, else null
//   A microphone turned on from the Settings part is released when Settings closes, unless a
//       screen is listening to it by then or a screen that uses it is open (has an onFrame
//       listener): there it stays on, ready, until that screen stops or is left.
//   Hidden or left (visibilitychange to hidden, pagehide): the microphone is released as by
//       stop(), whichever sheet or screen had it open, and a request still waiting for the
//       browser's answer is dropped. Nothing opens it again by itself: a screen that wants
//       it back calls request() from a press (owner rule 2026-10-12, bugs.md 31).
//   Never asks for the microphone on load: nothing here runs until request() is called.

import { startMic } from '../mic.js';
import { CONFIG } from './config.js';
import { banner, h, icon, openSheet } from './shell.js';
import { displayNote } from './stage.js';

// ---------------------------------------------------------------- pure: the machine

const ERRORS = { blocked: 'blocked', missing: 'missing', failed: 'failed', unsupported: 'unsupported' };
const RETRY = { request: 'waiting', dismiss: 'off', stop: 'off' };
const TABLE = {
  off: { ask: 'asking', request: 'waiting' },
  asking: { request: 'waiting', dismiss: 'off' },
  // Dismissed while Chrome's own question is still up: the answer no longer matters, and
  // open() closes the microphone again if it arrives after this.
  waiting: { granted: 'on', check: 'checking', stop: 'off', dismiss: 'off', ...ERRORS },
  // Closing the level check does not close the microphone: it was already allowed.
  checking: { continue: 'on', dismiss: 'on', ended: 'lost', stop: 'off' },
  on: { check: 'checking', ended: 'lost', stop: 'off' },
  blocked: RETRY, missing: RETRY, failed: RETRY, unsupported: RETRY,
  lost: { request: 'waiting', stop: 'off' },
};

export const nextPhase = (phase, event) => (TABLE[phase] && TABLE[phase][event]) || phase;

export function classifyError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'blocked';
  // OverconstrainedError: the saved microphone is no longer there.
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotSupportedError') return 'unsupported';
  return 'failed';
}

const CLEANUP_NAMES = { echoCancellation: 'Echo cancelling', noiseSuppression: 'Noise removal', autoGainControl: 'Automatic volume' };

export function cleanupRows(applied) {
  return Object.entries(CLEANUP_NAMES).map(([key, name]) => {
    const v = applied ? applied[key] : null;
    // Chrome may report a mode string for echo cancellation: anything but a plain false
    // (or "not reported") means some clean-up is running.
    const state = v === false ? 'off' : v === null || v === undefined ? 'unknown' : 'on';
    return { key, name, state, ok: state !== 'on' };
  });
}

export function chipFor({ phase, problem = null, cleanupOn = false }) {
  if (phase === 'blocked') return { word: 'Mic blocked', icon: 'mic-off', role: 'error', warning: true };
  if (phase === 'on' || phase === 'checking') {
    if (cleanupOn) return { word: 'Check mic', icon: 'mic', role: 'close', warning: true };
    if (problem === 'silence') return { word: 'Mic on, no sound', icon: 'mic', role: 'close', warning: true };
    return { word: 'Mic on', icon: 'mic', role: 'good', warning: false };
  }
  return { word: 'Mic off', icon: 'mic-off', role: 'quiet', warning: false };
}

export function createSignalMonitor(cfg = CONFIG.mic) {
  const order = ['silence', 'quiet', 'loud', 'noisy'];
  const after = { silence: cfg.silenceAfterMs, quiet: cfg.quietAfterMs, loud: cfg.loudAfterMs, noisy: cfg.noisyAfterMs };
  let seen = {};
  const reset = () => { seen = Object.fromEntries(order.map((k) => [k, { since: null, lastTrue: -Infinity }])); };
  reset();
  return {
    push(tMs, level, voiced, peak = 0) {
      const is = {
        silence: level < cfg.silenceRms,
        quiet: level >= cfg.silenceRms && level < cfg.quietRms,
        loud: peak >= cfg.loudPeak,
        noisy: level >= cfg.quietRms && !voiced,
      };
      let problem = null;
      for (const k of order) {
        const s = seen[k];
        if (is[k]) {
          if (s.since === null) s.since = tMs;
          s.lastTrue = tMs;
        } else if (s.since !== null && tMs - s.lastTrue > cfg.problemReleaseMs) {
          s.since = null;     // really over; a short dip (a breath, one odd frame) is not
        }
        if (!problem && s.since !== null && tMs - s.since >= after[k]) problem = k;
      }
      return problem;
    },
    reset,
  };
}

// "At most once every periodMs", on a clock that may start again (each microphone opening
// brings a new AudioContext whose time begins near 0): going backwards counts as due.
export function createEvery(periodMs) {
  let last = -Infinity;
  return {
    due(tMs) {
      if (!(tMs - last >= periodMs || tMs < last)) return false;
      last = tMs;
      return true;
    },
  };
}

export function bannerFor({ phase, listening = false, problem = null, cleanupOn = false, cleanupAck = false }) {
  if (phase === 'lost') return 'lost';
  if (phase !== 'on') return null;
  if (cleanupOn && !cleanupAck) return 'cleanup';
  return listening ? problem : null;
}

export const SIGNAL_PROBLEMS = Object.freeze(['silence', 'quiet', 'loud', 'noisy']);

export const WORDS = Object.freeze({
  askTitle: 'Turn on your microphone',
  askBody: 'The trainer listens to your voice to find the note. Sound stays on this computer. Nothing is recorded unless you press Save.',
  askWhere: 'Chrome will ask at the top left. Choose Allow.',
  waiting: 'Waiting for Chrome…',
  blockedTitle: 'The microphone is blocked for this page',
  blockedSteps: ['Click the icon at the left end of the address bar.', 'Set Microphone to Allow.', 'Press Try again.'],
  blockedMore: 'Still stuck? macOS: System Settings → Privacy & Security → Microphone → turn on Google Chrome.',
  missing: 'No microphone found. Plug one in or check that it isn’t switched off, then try again.',
  failed: 'The microphone didn’t start. Another app may be using it.',
  unsupported: 'This page cannot use the microphone here. Open it from localhost in Chrome.',
  lost: 'The microphone stopped.',
  cleanup: 'Chrome is still ‘cleaning up’ the microphone sound. That can bend or mute a sung note, so the pitch line may jump.',
  cleanupTip: 'The MacBook’s built-in microphone usually works. Some headsets and AirPods force clean-up on.',
  silence: 'I can’t hear anything. Is the right microphone chosen, and is it unmuted?',
  silenceMore: 'macOS: System Settings → Sound → Input, check the input level.',
  quiet: 'You’re very quiet. Sing a little louder or move closer.',
  loud: 'Too loud for the microphone. Move back a little.',
  noisy: 'There’s a lot of background noise. A quieter room, or closer to the mic, will help.',
});

// ---------------------------------------------------------------- browser: the flow

const rowEl = (r) => h('li', { class: 'cleanup-row', dataset: { state: r.state } },
  icon(r.state === 'on' ? 'warning' : r.state === 'off' ? 'tick' : 'info', 16),
  `${r.name}: ${r.state === 'unknown' ? 'not reported' : r.state}`);

export function createMicFlow({ shell, settings, chipEl, config = CONFIG, startMicImpl = startMic }) {
  const monitor = createSignalMonitor(config.mic);
  const frameSubs = new Set(), stateSubs = new Set(), bannerHosts = new Map();
  // This flow's own frame listeners (the level check, the Settings part's level bar), so
  // screenTakesFrames() can tell a screen that uses the microphone from them.
  const ownFrameSubs = new Set();
  const ownFrame = (fn) => { ownFrameSubs.add(fn); const off = flow.onFrame(fn); return () => { ownFrameSubs.delete(fn); off(); }; };
  const screenTakesFrames = () => [...frameSubs].some((fn) => !ownFrameSubs.has(fn));
  let phase = 'off', mic = null, rows = cleanupRows(null), cleanupAck = false, listening = false, problem = null;
  let level = 0, peak = 0, sheet = null, pending = null, ownStream = true, everCleanupOn = false;
  const chipLevel = createEvery(1000 / config.hud.chipLevelHz);

  const anyOn = () => rows.some((r) => !r.ok);
  const state = () => {
    const base = { phase, problem, listening, cleanupOn: anyOn(), cleanupAck };
    return { phase, problem, listening, cleanup: { rows, anyOn: anyOn(), ack: cleanupAck }, banner: bannerFor(base), chip: chipFor(base) };
  };
  const settle = (ok) => { const p = pending; pending = null; if (p) p(ok); };
  function go(event) {
    const next = nextPhase(phase, event);
    if (next === phase) return;
    phase = next;
    changed();
  }

  // ---- chip
  const bars = h('span', { class: 'mic-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  let chipKey = '';
  function paintChip() {
    const c = chipFor({ phase, problem, cleanupOn: anyOn() });
    if (c.word === chipKey) return;
    chipKey = c.word;
    chipEl.dataset.role = c.role;
    // In a narrow window the chip shows its icons only; the words stay here.
    chipEl.setAttribute('aria-label', `Microphone: ${c.word}. Open its settings`);
    chipEl.title = c.word;
    // filter: replaceChildren(null) would write the word "null" into the chip.
    chipEl.replaceChildren(...[icon(c.icon, 16), c.warning && icon('warning', 16), h('span', null, c.word), c.word === 'Mic on' && bars].filter(Boolean));
  }

  // ---- banners
  function buildBanner(key) {
    const btn = (text, fn) => h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: fn }, text);
    if (key === 'lost') return banner({ role: 'error', iconName: 'mic-off', text: WORDS.lost, buttons: [btn('Reconnect', () => flow.request())] });
    if (key === 'cleanup') {
      const a = mic ? mic.applied : {};
      return banner({
        role: 'close', text: WORDS.cleanup,
        detail: [
          h('ul', { class: 'cleanup-rows' }, rows.map(rowEl)),
          h('p', { class: 'reason' }, WORDS.cleanupTip),
          h('p', { class: 'reason' }, `Microphone: ${a.label || 'not named'}${mic ? ` · Sample rate: ${mic.sampleRate.toLocaleString('en-GB')} per second` : ''}`),
        ],
        buttons: [btn('Try another microphone', () => shell.openSettings('mic')), btn('Continue anyway', () => { cleanupAck = true; changed(); })],
      });
    }
    if (key === 'silence') {
      return banner({
        role: 'close', iconName: 'mic-off', text: WORDS.silence, detail: h('p', { class: 'reason' }, WORDS.silenceMore),
        buttons: [btn('Choose microphone', () => shell.openSettings('mic')), btn('Test the mic', () => flow.openLevelCheck())],
      });
    }
    return banner({ role: 'close', text: WORDS[key] });
  }
  function paintBanners() {
    const shown = bannerFor({ phase, listening, problem, cleanupOn: anyOn(), cleanupAck });
    for (const [host, opts] of bannerHosts) {
      const key = !opts.signal && SIGNAL_PROBLEMS.includes(shown) ? null : shown;
      if ((host.dataset.banner || '') === (key || '')) continue;
      host.dataset.banner = key || '';
      // The old banner eases shut before it is removed; the new one eases open (app.css).
      for (const old of host.children) {
        old.classList.add('is-leaving');
        setTimeout(() => old.remove(), 340);
      }
      if (key) {
        const wrap = h('div', { class: 'banner-wrap' }, h('div', { class: 'banner-clip' }, buildBanner(key)));
        host.append(wrap);
      }
    }
  }

  // ---- the sheet (10.1, 10.2)
  let stopCheck = null;
  function sheetParts() {
    const primary = (text, fn, extra = {}) => h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, onclick: fn, ...extra }, text);
    const quiet = (text, fn) => h('button', { class: 'btn btn-quiet', type: 'button', onclick: fn }, text);
    const again = () => open({});
    if (phase === 'asking' || phase === 'waiting') {
      const waiting = phase === 'waiting';
      return { title: WORDS.askTitle, body: [
        h('p', null, WORDS.askBody),
        // Where Chrome's own question appears: a small window with a card under the left
        // end of its address bar. The caption carries the meaning; the picture is decoration.
        h('div', { class: 'ask-diagram', 'aria-hidden': 'true' },
          h('span', { class: 'ask-dots' }, h('i'), h('i'), h('i')), h('span', { class: 'ask-bar' }), h('span', { class: 'ask-box' }, 'Allow')),
        h('p', { class: 'ask-hint', id: 'ask-why' }, WORDS.askWhere),
        h('div', { class: 'sheet-actions' },
          waiting
            ? h('button', { class: 'btn btn-primary', type: 'button', disabled: true, 'aria-describedby': 'ask-why' }, WORDS.waiting)
            : primary(['Turn on microphone ', h('kbd', { class: 'keycap' }, 'Space')], again),
          !waiting && quiet('Not now', () => sheet.close())),
      ] };
    }
    if (phase === 'checking') return levelCheckParts(primary, quiet);
    if (phase === 'blocked') {
      return { title: WORDS.blockedTitle, icon: 'mic-off', body: [
        h('ol', { class: 'steps' }, WORDS.blockedSteps.map((s) => h('li', null, s))),
        h('div', { class: 'sheet-actions' }, primary('Try again', again)),
        h('p', { class: 'reason' }, WORDS.blockedMore),
      ] };
    }
    const text = phase === 'missing' ? WORDS.missing : phase === 'unsupported' ? WORDS.unsupported : WORDS.failed;
    return { title: phase === 'missing' ? 'No microphone found' : 'The microphone didn’t start', body: [
      h('p', null, text),
      h('div', { class: 'sheet-actions' }, primary('Try again', again),
        phase === 'failed' && h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { sheet.close(); shell.openSettings('mic'); } }, 'Choose another microphone')),
    ] };
  }

  function levelCheckParts(primary, quiet) {
    const fill = h('i');
    const heard = h('p', { class: 'heard', 'aria-live': 'polite' }, 'Waiting to hear a note…');
    const cont = primary(['Continue ', h('kbd', { class: 'keycap' }, 'Space')], () => sheet.close(), { disabled: true, 'aria-describedby': 'heard-why' });
    heard.id = 'heard-why';
    let run = 0, done = false, lastLv = -1;
    stopCheck = ownFrame((frame, lv) => {
      const pct = Math.round(100 * Math.min(1, Math.sqrt(lv / config.mic.levelFullScaleRms)));
      if (pct !== lastLv) { lastLv = pct; fill.style.transform = `scaleX(${pct / 100})`; }
      if (done) return;
      // A handful of voiced readings in a row, so one stray blip is not announced as a note.
      run = frame.voiced ? run + 1 : 0;
      if (run < 6) return;
      done = true;
      heard.replaceChildren(icon('tick', 20), `I can hear you: ${displayNote(frame.midi, settings.get('noteNames')).text}.`);
      heard.classList.add('is-heard');
      cont.disabled = false;
      cont.focus();
    });
    return { title: 'Say ‘ah’', body: [
      h('p', null, 'Sing or say a steady ‘ah’ for a moment.'),
      h('div', { class: 'level level-big' }, h('span', { class: 'level-label' }, 'Mic level'), h('div', { class: 'level-bar' }, fill)),
      heard,
      h('div', { class: 'sheet-actions' }, cont, quiet('Continue without the check', () => sheet.close())),
    ] };
  }

  function paintSheet() {
    const wants = ['asking', 'waiting', 'checking', 'blocked', 'missing', 'failed', 'unsupported'].includes(phase);
    if (!wants) { if (sheet) sheet.close(); return; }
    // 'waiting' only keeps a sheet that is already open: a returning singer whose
    // microphone opens at once should not see a sheet blink past.
    if (!sheet && phase === 'waiting') return;
    if (stopCheck) { stopCheck(); stopCheck = null; }
    const parts = sheetParts();
    if (!sheet) {
      sheet = openSheet({ title: parts.title, className: 'sheet-mic', body: parts.body, onClose: () => {
        sheet = null;
        if (stopCheck) { stopCheck(); stopCheck = null; }
        const wasChecking = phase === 'checking';
        if (wasChecking) settings.set('micIntroDone', true);
        go('dismiss');
        settle(wasChecking || phase === 'on');
      } });
      return;
    }
    sheet.setTitle(parts.title);
    sheet.body.replaceChildren(...parts.body.flat().filter(Boolean));
    const focus = sheet.body.querySelector('[autofocus]:not([disabled])');
    if (focus) focus.focus();
  }
  let sheetPhase = '';
  function changed() {
    paintChip();
    paintBanners();
    if (phase !== sheetPhase) { sheetPhase = phase; paintSheet(); }
    for (const fn of [...stateSubs]) fn(state());
  }

  // ---- opening and closing the microphone
  async function open({ stream } = {}) {
    if (phase === 'waiting') return;
    go('request');
    ownStream = !stream;
    try {
      const started = await startMicImpl({
        stream,
        deviceId: stream ? undefined : settings.get('micDeviceId') || undefined,
        onLevel: (rms, pk = 0) => { level = rms; peak = pk; },
        onFrame: (frame) => {
          if (listening) {
            const p = monitor.push(frame.t * 1000, level, frame.voiced, peak);
            if (p !== problem) { problem = p; changed(); }
          }
          if (chipLevel.due(frame.t * 1000)) {
            bars.style.setProperty('--lv', Math.min(1, Math.sqrt(level / config.mic.levelFullScaleRms)).toFixed(2));
          }
          for (const fn of [...frameSubs]) fn(frame, level);
        },
        onEnd: () => { mic = null; problem = null; go('ended'); },
      });
      // Stopped (or dismissed) while Chrome's question was still up: do not keep it open.
      if (phase !== 'waiting') { started.stop(); return; }
      mic = started;
      rows = cleanupRows(mic.applied);
      cleanupAck = false;
      if (anyOn()) everCleanupOn = true;
      monitor.reset();
      problem = null;
      if (sheet) go('check');
      else { go('granted'); settle(true); }
    } catch (err) {
      if (err && err.name === 'OverconstrainedError' && settings.get('micDeviceId')) {
        // The remembered microphone is gone: forget it and fall back to the default one.
        settings.set('micDeviceId', null);
        phase = 'off';
        return open({ stream });
      }
      if (phase !== 'waiting') return;
      go(classifyError(err));
      // An error always needs words and a way forward, sheet or not.
      if (!sheet) paintSheet();
    }
  }

  // ---- the Settings part
  function renderSettings(el) {
    const picker = h('select', { class: 'select', 'aria-label': 'Which microphone' });
    const pickerWhy = h('p', { class: 'reason' });
    const fill = h('i');
    const list = h('ul', { class: 'cleanup-rows' });
    const info = h('p', { class: 'reason' });
    const action = h('button', { class: 'btn btn-secondary', type: 'button' });
    // Turned on from here, to look at the level and the clean-up rows: it goes off again when
    // Settings closes, unless a screen has started listening to it meanwhile. Left on, it
    // stayed live on every route with no button anywhere to turn it off (bugs.md 31).
    let openedHere = false;
    action.addEventListener('click', () => {
      if (phase === 'on') { flow.openLevelCheck(); return; }
      openedHere = true;
      flow.request();
    });
    picker.addEventListener('change', async () => {
      settings.set('micDeviceId', picker.value || null);
      if (phase === 'on' && ownStream) { flow.stop(); await flow.request(); }
    });
    async function fillPicker() {
      let devices = [];
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* none to list */ }
      // Chrome hides microphone names until the page has been allowed to use one.
      const named = devices.filter((d) => d.label);
      picker.replaceChildren(h('option', { value: '' }, 'Default microphone'), ...named.map((d) => h('option', { value: d.deviceId }, d.label)));
      picker.value = named.some((d) => d.deviceId === settings.get('micDeviceId')) ? settings.get('micDeviceId') : '';
      picker.disabled = !named.length;
      pickerWhy.textContent = named.length ? '' : 'Turn on the microphone once to see the list.';
    }
    const paint = () => {
      list.replaceChildren(...(mic ? rows.map(rowEl) : []));
      info.textContent = mic
        ? `Microphone: ${mic.applied.label || 'not named'} · Sample rate: ${mic.sampleRate.toLocaleString('en-GB')} per second`
        : 'The microphone is off. Sound clean-up is checked when it turns on.';
      action.textContent = phase === 'on' ? 'Test the mic' : 'Turn on microphone';
      fillPicker();
    };
    const offState = flow.subscribe(paint);
    let lastLv = -1;
    const offFrame = ownFrame((_, lv) => {
      const pct = Math.round(100 * Math.min(1, Math.sqrt(lv / config.mic.levelFullScaleRms)));
      if (pct !== lastLv) { lastLv = pct; fill.style.transform = `scaleX(${pct / 100})`; }
    });
    el.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Which microphone'), picker, pickerWhy),
      h('div', { class: 'level' }, h('span', { class: 'level-label' }, 'Mic level'), h('div', { class: 'level-bar' }, fill)),
      list, info, action);
    paint();
    // Kept on when the screen under Settings uses the microphone (it takes frames, as Match and
    // hold does before Start): the singer turned it on to be ready for that screen, and closing
    // Settings turned it straight off again (owner, 2026-10-15, bugs.md 80). That screen's
    // Stop, leaving it, or the page hidden releases it. Elsewhere (the sky) it goes, as before.
    return () => { offState(); offFrame(); if (openedHere && mic && !listening && !screenTakesFrames()) flow.stop(); };
  }

  const flow = {
    get mic() { return mic; },
    state,
    request({ stream } = {}) {
      if (phase === 'on') return Promise.resolve(true);
      if (pending) return new Promise((done) => { const prev = pending; pending = (ok) => { prev(ok); done(ok); }; });
      return new Promise((done) => {
        pending = done;
        if (stream || settings.get('micIntroDone') || phase === 'lost') open({ stream });
        else if (phase === 'off') go('ask');
        else paintSheet();          // an error phase: show its words again
      });
    },
    stop() {
      if (mic) mic.stop();
      mic = null;
      problem = null;
      listening = false;
      go('stop');
      settle(false);
    },
    onFrame(fn) { frameSubs.add(fn); return () => frameSubs.delete(fn); },
    subscribe(fn) { stateSubs.add(fn); return () => stateSubs.delete(fn); },
    setListening(on) {
      if (listening === !!on) return;
      listening = !!on;
      monitor.reset();
      problem = null;
      changed();
    },
    mountBanners(el, { signal = true } = {}) {
      el.classList.add('banner-slot');
      bannerHosts.set(el, { signal });
      paintBanners();
      return () => { bannerHosts.delete(el); el.replaceChildren(); delete el.dataset.banner; };
    },
    openLevelCheck() { if (phase === 'on') go('check'); },
    cleanupWasOn: () => everCleanupOn,
  };

  // The microphone is on only while the owner is looking at the page (owner rule
  // 2026-10-12, bugs.md 31): hidden or left, every track ends and the context closes, as
  // on Stop. 'lost' has nothing open and keeps its Reconnect banner.
  const releaseWhenAway = (e) => {
    if (e.type === 'visibilitychange' && !document.hidden) return;
    if (mic || phase === 'waiting' || phase === 'checking') flow.stop();
  };
  document.addEventListener('visibilitychange', releaseWhenAway);
  window.addEventListener('pagehide', releaseWhenAway);

  chipEl.addEventListener('click', () => shell.openSettings('mic'));
  shell.registerSettingsSection('mic', 'Microphone', renderSettings);
  paintChip();
  return flow;
}
