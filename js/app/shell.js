// shell.js — the app around the screens: icons, small DOM helpers, saved settings, hash
// routes, sheets, toasts, the Settings sheet, theme and calm-motion switches
// (docs/design/specs/2026-10-12-singing-trainer.md section 3, docs/design/STYLE.md).
//
// Importing this file does nothing by itself (no browser global is touched until a function
// is called), so Node checks can import the pure parts and modules that import it.
//
// CONTRACT
//   h(tag, props?, ...children) -> element     props: class, dataset {}, on<event>, any
//                                              attribute; false/null/undefined are skipped
//   icon(name, size = 24) -> inline <svg>      names: ICONS keys; unknown name throws
//   parseRoute(hash, { home = 'today' }?) -> { name, param } | null
//                                              '#/practice/match' -> practice, 'match'
//                                              ('#/practice/constellation/hill' -> 'constellation/hill')
//                                              no address at all -> the home route
//   createSettings({ storage, defaults?, key? }) -> { get(k), all(), set(k, v),
//       subscribe(fn) -> unsubscribe, erase() }
//   eraseSavedDatabases({ indexedDB? }) -> Promise<names deleted>: the song and take databases
//       ("Erase my data"). Never throws; a database another tab holds open is still asked to go.
//       Saved as JSON under one key. Unreadable or missing storage falls back to the
//       defaults and keeps working in memory (nothing throws).
//   openSheet({ title, body, closable = true, onClose?, className? }) -> { el, body, close(value) }
//       A modal <dialog>: focus stays inside, Esc closes only when closable, focus returns
//       to the opener. Fires 'mt:sheet' on document ({ detail: { open } }).
//   confirmSheet({ title, body?, yes, no }) -> Promise<boolean>
//   toast(text)
//   banner({ role, iconName, text, detail?, buttons? }) -> element   role: good|close|error|accent
//   segmented({ label, options: [{ value, text, disabled?, reason? }], value, onChange }) -> element
//   switchRow({ label, note?, value, onChange }) -> element
//   initShell({ settings, routes, home = 'today', storage? }) -> shell
//       storage: what the Settings sheet reads the saved record from (backup, own voice);
//       left out, the browser's own.
//       routes: { <name>: (viewEl, { param, shell }) -> cleanup? }
//       home: the route an empty or unknown address leads to. 'sky' (index.html) makes the
//           star dome the home: the sky bar replaces the top bar and its tabs (the Back
//           link and the two names are painted from js/app/skyroutes.js), Esc presses Back
//           on a reading screen, and 1 to 5 are the five places. The default keeps the old
//           top bar's behaviour for the lab pages that still carry one.
//       shell.route() -> { name, param } | null   the screen now shown
//       shell.start()   draws the first screen; call once, after the rest is wired
//       shell.navigate(hash), shell.openSettings(sectionId?),
//       shell.registerSettingsSection(id, title, render(el) -> cleanup?),
//       shell.setBusy(guard | null)   guard() -> Promise<boolean>: asked before leaving the
//                                     screen while the mic is scoring; tabs dim meanwhile
//       shell.headphones() -> 'on' | 'none' | null (not asked this visit), shell.calm() -> boolean
//       shell.askHeadphones() -> Promise<'on' | 'none' | null>   the "Put on headphones"
//           sheet (spec 10.4); resolves with the answer as it stands when the sheet closes
//           (closing it without choosing keeps the old answer, null if there was none)
//       shell.needHeadphones() -> Promise<'on' | 'none' | null>  asks only if not yet
//           answered this visit: call it before the first reference tone
//   createLeaveAsker(go) -> leave(ask, wanted)   one leave question at a time (pure)
//   phonesChipFor(answer) -> { word, icon, role, label }   the headphones chip's three states (pure)
//   Events on document: 'mt:theme', 'mt:calm' ({ detail: { on } }), 'mt:aurora' ({ detail: { on } };
//   <html data-aurora="on|off"> carries the same, for the stage and the star field), 'mt:sheet',
//       'mt:headphones' ({ detail: { answer } }) when the headphones answer changes,
//       'mt:route' ({ detail: { route, from } }) once a screen has been drawn,
//       'mt:busy' ({ detail: { on } }) when setBusy sets or clears the scoring guard.

import { SETTINGS_DEFAULTS, SKIES, resolveSky } from './config.js';
import { readOwnVoice } from './ownvoicekey.js';
import { useOwnVoice } from '../synth.js';
import { HOME_ROUTE, NUMBER_ROUTES, backOf, namesOf, screenOwnsKey } from './skyroutes.js';
import { SONG } from './song/config.js';

// ---------------------------------------------------------------- DOM helpers and icons

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

// Original drawings on a 24 px grid, 2 px round strokes, currentColor (STYLE.md section 5).
export const ICONS = {
  tick: 'M5 12.5l4.5 4.5L19 7.5',
  wave: 'M4 9c2.5-3 5.5-3 8 0s5.5 3 8 0M4 15c2.5-3 5.5-3 8 0s5.5 3 8 0',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  dash: 'M6 12h12',
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  'mic-off': 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6M4 3l16 18',
  headphones: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z',
  speaker: 'M4 10v4h3l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14M16 5v14',
  replay: 'M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z',
  chart: 'M4 20V4M4 20h16M8 16l4-5 3 3 5-7',
  gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM10.3 3h3.4l.5 2.5 2 1.2 2.4-.9 1.7 3-1.9 1.7v2.3l1.9 1.7-1.7 3-2.4-.9-2 1.2-.5 2.5h-3.4l-.5-2.5-2-1.2-2.4.9-1.7-3 1.9-1.7v-2.3L3.7 8.8l1.7-3 2.4.9 2-1.2z',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  'music-note': 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  flame: 'M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 0-6 1-9z',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 24) {
  if (!ICONS[name]) throw new RangeError(`icon: no icon named ${name}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': name === 'dots' ? 3 : 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', class: `icon icon-${name}`,
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------- pure: routes, settings

const ROUTES = new Set(['today', 'practice', 'sing', 'coach', 'progress', 'songs', 'setup', HOME_ROUTE]);

export function parseRoute(hash, { home = 'today' } = {}) {
  const text = String(hash || '').replace(/^#\/?/, '');
  if (!text) return { name: home, param: null };
  const [name, ...rest] = text.split('/');
  if (!ROUTES.has(name)) return null;
  let param = null;
  // A broken percent-escape in a hand-typed address must not crash the router.
  try { param = rest.length ? decodeURIComponent(rest.join('/')) || null : null; } catch { param = null; }
  return { name, param };
}

export const STORAGE_PREFIX = 'music-trainer.';

// Reference tone 'mine' ("My voice"): every screen asks timbreFor (js/synth.js), which asks
// this at each note. Read fresh each time, so a new capture, "Erase everything" or a restore
// is heard on the next note with no events to wire. A few hundred bytes of JSON: cheap.
useOwnVoice(() => {
  try { const r = readOwnVoice(globalThis.localStorage); return r ? r.envelope : null; } catch { return null; }
});

export function createSettings({ storage, defaults = SETTINGS_DEFAULTS, key = `${STORAGE_PREFIX}settings.v1` } = {}) {
  let values = { ...defaults };
  try {
    const saved = JSON.parse((storage && storage.getItem(key)) || 'null');
    // Only keys we know: a stale or hand-edited entry cannot plant a setting.
    if (saved && typeof saved === 'object') for (const k of Object.keys(defaults)) if (k in saved) values[k] = saved[k];
    // 'voice', 'soft' and then the sung "oo" were the default and every save writes all
    // values, so a saved one that was never picked in Settings moves once to the default, now
    // the real recorded "oo" (owner, 2026-10-15). 'sine' stays; so does anything picked
    // (toneChosen).
    if (saved && typeof saved === 'object' && ['voice', 'soft', 'sung'].includes(saved.tone) && !saved.toneChosen && 'toneChosen' in defaults && defaults.tone === 'oohs') values.tone = 'oohs';
    // "Note sound: My voice" was Match and hold's alone (noteSound); it is now the Reference tone
    // 'mine' in every exercise (owner, 2026-10-15). Moved once: noteSound is no longer a
    // setting, so the next save drops it.
    if (saved && typeof saved === 'object' && saved.noteSound === 'mine' && !('noteSound' in defaults) && 'tone' in defaults) { values.tone = 'mine'; if ('toneChosen' in defaults) values.toneChosen = true; }
  } catch { /* unreadable: start from the defaults */ }
  const subs = new Set();
  const save = () => { try { if (storage) storage.setItem(key, JSON.stringify(values)); } catch { /* full or blocked: keep going in memory */ } };
  const tell = (k) => { for (const fn of [...subs]) fn(k, values[k]); };
  return {
    get: (k) => values[k],
    all: () => ({ ...values }),
    set(k, v) {
      if (!(k in defaults)) throw new RangeError(`settings: unknown setting ${k}`);
      if (values[k] === v) return;
      values[k] = v;
      save();
      tell(k);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    erase() {
      try {
        if (storage) for (let i = storage.length - 1; i >= 0; i--) {
          const name = storage.key(i);
          if (name && name.startsWith(STORAGE_PREFIX)) storage.removeItem(name);
        }
      } catch { /* nothing more to do */ }
      values = { ...defaults };
      for (const k of Object.keys(defaults)) tell(k);
    },
  };
}

// The browser databases "Erase my data" also removes (settings.erase covers localStorage only).
// Both open their databases with onversionchange -> close, so a delete here is not blocked by us.
// My voice's recordings: the name is myvoice.js DB_NAME, written out so every page does not load
// the voice engine (tools/checks/stage.check.mjs keeps the two equal).
export const SAVED_DATABASES = Object.freeze([SONG.takes.dbName, SONG.songs.dbName, 'music-trainer.myvoice.v1']);
export async function eraseSavedDatabases({ indexedDB: idb = globalThis.indexedDB } = {}) {
  if (!idb) return [];
  const gone = await Promise.all(SAVED_DATABASES.map((name) => new Promise((ok) => {
    try {
      const req = idb.deleteDatabase(name);
      req.onsuccess = () => ok(name);
      req.onerror = () => ok(null);
      req.onblocked = () => ok(name);            // queued: it goes once the other tab lets go
    } catch { ok(null); }
  })));
  return gone.filter(Boolean);
}

// ---------------------------------------------------------------- sheets, toasts, banners

let openSheets = 0;
export const sheetOpen = () => openSheets > 0;
let sheetSeq = 0;

export function openSheet({ title, body, closable = true, onClose, className = '' } = {}) {
  const opener = document.activeElement;
  const id = `sheet-title-${++sheetSeq}`;
  const bodyEl = h('div', { class: 'sheet-body' }, body);
  const closeBtn = closable && h('button', {
    class: 'icon-button', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close('close'),
  }, icon('close'));
  const dlg = h('dialog', { class: `sheet ${className}`.trim(), 'aria-labelledby': id },
    h('header', { class: 'sheet-head' }, h('h2', { id }, title), closeBtn), bodyEl);
  // Esc on a sheet that must be answered (a confirm) does nothing instead of dismissing it.
  dlg.addEventListener('cancel', (e) => { if (!closable) e.preventDefault(); });
  dlg.addEventListener('close', () => {
    openSheets--;
    dlg.remove();
    document.dispatchEvent(new CustomEvent('mt:sheet', { detail: { open: sheetOpen() } }));
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    if (onClose) onClose(dlg.returnValue);
  });
  document.body.append(dlg);
  openSheets++;
  dlg.showModal();
  document.dispatchEvent(new CustomEvent('mt:sheet', { detail: { open: true } }));
  return {
    el: dlg, body: bodyEl,
    setTitle(text) { dlg.querySelector('h2').textContent = text; },
    close(value = 'close') { if (dlg.open) dlg.close(value); },
  };
}

export function confirmSheet({ title, body, yes, no }) {
  return new Promise((done) => {
    const sheet = openSheet({
      title, closable: false, className: 'sheet-confirm',
      onClose: (value) => done(value === 'yes'),
      body: [
        body && h('p', null, body),
        h('div', { class: 'sheet-actions' },
          // The safe answer holds the focus, so a stray Space or Enter keeps things as they are.
          h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, onclick: () => sheet.close('no') }, no),
          h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => sheet.close('yes') }, yes)),
      ],
    });
  });
}

let toastTimer = 0;
export function toast(text) {
  let box = document.getElementById('toast');
  if (!box) {
    box = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  clearTimeout(toastTimer);
  box.textContent = text;
  box.classList.add('is-shown');
  toastTimer = setTimeout(() => box.classList.remove('is-shown'), 4000);
}

const BANNER_ICON = { good: 'tick', close: 'warning', error: 'warning', accent: 'info' };

export function banner({ role = 'close', iconName, text, detail, buttons = [] }) {
  return h('div', { class: 'banner', dataset: { role }, role: 'status' },
    h('span', { class: 'banner-icon' }, icon(iconName || BANNER_ICON[role] || 'info')),
    h('div', { class: 'banner-text' }, h('p', null, text), detail),
    buttons.length ? h('div', { class: 'banner-actions' }, buttons) : null);
}

// ---------------------------------------------------------------- form parts

export function segmented({ label, options, value, onChange }) {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const usable = () => options.filter((o) => !o.disabled);
  const paint = () => {
    group.style.setProperty('--n', options.length);
    group.style.setProperty('--i', Math.max(0, options.findIndex((o) => o.value === value)));
    for (const b of group.children) {
      const on = b.dataset.value === String(value);
      b.setAttribute('aria-checked', on);
      b.tabIndex = on ? 0 : -1;
    }
  };
  const choose = (v, focus) => {
    value = v;
    paint();
    if (focus) group.querySelector('[aria-checked="true"]').focus();
    onChange(v);
  };
  for (const o of options) {
    group.append(h('button', {
      type: 'button', role: 'radio', class: 'segment', dataset: { value: String(o.value) },
      'aria-disabled': o.disabled ? 'true' : null, title: o.disabled ? o.reason : null,
      onclick: () => { if (!o.disabled) choose(o.value, false); },
    }, icon('tick', 16), o.text));
  }
  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const list = usable(), at = list.findIndex((o) => o.value === value);
    choose(list[(at + step + list.length) % list.length].value, true);
  });
  paint();
  const reasons = options.filter((o) => o.disabled && o.reason).map((o) => h('p', { class: 'reason' }, `${o.text}: ${o.reason}`));
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), group, reasons);
}

// Settings > Look > Sky (page-layout spec 4.2): a radio group of swatches. Each swatch's picture
// is a little element carrying that sky's data-theme, so its colours come from tokens.css like
// the real page (no colour is written here). Arrow keys only move the focus and Space or Enter
// picks: every pick is a 400 ms cross-fade of the whole window, so arrowing through five skies
// must not set off five of them.
export function skyPicker({ value, onChange }) {
  const group = h('div', { class: 'sky-swatches', role: 'radiogroup', 'aria-label': 'Sky' });
  const picture = (sky) => sky.tone
    ? h('span', { class: 'sky-swatch-sky theme-scope', dataset: { theme: sky.id }, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
    : h('span', { class: 'sky-swatch-sky sky-swatch-half', 'aria-hidden': 'true' },
      h('span', { class: 'theme-scope', dataset: { theme: 'dusk' } }, h('i'), h('i')),
      h('span', { class: 'theme-scope', dataset: { theme: 'dawn' } }, h('i')));
  const paint = () => {
    const known = SKIES.some((s) => s.id === value) ? value : 'system';
    for (const b of group.children) {
      const on = b.dataset.value === known;
      b.setAttribute('aria-checked', on);
      b.tabIndex = on ? 0 : -1;
    }
  };
  for (const sky of SKIES) {
    const lineId = `sky-line-${sky.id}`;
    group.append(h('button', {
      type: 'button', role: 'radio', class: 'sky-swatch', dataset: { value: sky.id }, title: sky.line, 'aria-describedby': lineId,
      onclick: () => { if (value === sky.id) return; value = sky.id; paint(); onChange(sky.id); },
    }, picture(sky), h('span', { class: 'sky-swatch-name' }, sky.name),
    h('span', { class: 'sky-swatch-chosen' }, icon('tick', 16), 'Chosen'),
    h('span', { id: lineId, hidden: true }, sky.line)));
  }
  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const list = [...group.children], at = list.indexOf(document.activeElement);
    const next = list[((at < 0 ? 0 : at) + step + list.length) % list.length];
    for (const b of list) b.tabIndex = b === next ? 0 : -1;
    next.focus();
  });
  group.addEventListener('focusout', (e) => { if (!group.contains(e.relatedTarget)) paint(); });
  paint();
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Sky'), group);
}

export function switchRow({ label, note, value, onChange }) {
  const word = h('span', { class: 'switch-word' });
  const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label }, h('span', { class: 'switch-thumb' }));
  const paint = () => { btn.setAttribute('aria-checked', !!value); word.textContent = value ? 'On' : 'Off'; };
  btn.addEventListener('click', () => { value = !value; paint(); onChange(value); });
  paint();
  return h('div', { class: 'field field-row' },
    h('div', null, h('span', { class: 'field-label' }, label), note && h('p', { class: 'reason' }, note)),
    h('div', { class: 'switch-wrap' }, word, btn));
}

// ---------------------------------------------------------------- placeholder screens
// Honest stand-ins for the routes that later build items fill in. They use the spec's own
// "empty" words where it gives them, and never show a dead control without a reason.

const card = (title, ...kids) => h('section', { class: 'card' }, h('h2', null, title), ...kids);
const linkCard = (href, title, line, chip) => h('a', { class: 'card card-link', href },
  h('div', null, h('h2', null, title, chip && h('span', { class: 'chip chip-small' }, chip)), h('p', null, line)), icon('chevron'));

export const SESSION_STEPS = [
  ['Glide warm-up', '45 seconds'], ['Match and hold', '90 seconds'], ['Siren', '45 seconds'],
  ['Sing a constellation', '90 seconds'], ['Eyes closed', '30 seconds'],
];

export const placeholderScreens = {
  // ctx.rangeCard: the "Your range" card as an element (index.html builds it from what is
  // saved); without it the card says "Not measured yet".
  today(view, ctx) {
    view.append(
      h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Today'),
        h('p', { class: 'streak' }, icon('flame', 20), 'Start a streak today')),
      h('div', { class: 'today-grid' },
        h('section', { class: 'card card-session' },
          h('h2', null, 'Today’s session'),
          h('ol', { class: 'path is-preview' }, SESSION_STEPS.map(([name, len], i) => h('li', null,
            h('span', { class: 'path-dot', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 'path-name' }, name), h('span', { class: 'path-len' }, len)))),
          h('div', { class: 'action-row' },
            // Until the daily session exists the main button leads to the one exercise that
            // is built. The steps above are a preview.
            h('a', { class: 'btn btn-primary', href: '#/practice/match', dataset: { primary: '' }, 'aria-describedby': 'today-why' }, 'Start: Match and hold'),
            h('p', { class: 'reason', id: 'today-why' }, 'About 90 seconds. The other four exercises come next.'))),
        h('div', { class: 'today-side' },
          (ctx && ctx.rangeCard) || card('Your range', h('p', null, 'Not measured yet')),
          card('Last coach tip', h('p', null, 'Your first tips appear after a session.'))),
        h('div', { class: 'shortcuts' },
          linkCard('#/sing', 'Free sing', 'See your note live'),
          linkCard('#/practice', 'Practice', 'Pick one exercise'),
          linkCard('#/songs', 'Songs', 'Sing along'))));
  },
  practice(view) {
    const what = [
      'Slide your voice up and down to wake it up.', 'Find your lowest and highest comfortable notes.',
      'Hear a note, sing it, hold it steady.', 'Follow one long curve up and back down.',
      'Short tunes, one note at a time.', 'Four notes in time, walking up your range.',
      'Jump from one note to another, then climb a scale.', 'Match a note without watching the line.',
    ];
    // Patterns and leaps got rungs of their own, with the scrolling bars (spec 2026-10-15
    // patterns-intervals-scales section 1); Eyes closed tests it all blind, so it is the top rung.
    const names = ['Glide warm-up', 'Find your range', 'Match and hold', 'Siren', 'Sing a constellation', 'Star steps', 'Leaps and scales', 'Eyes closed'];
    const built = {
      'Glide warm-up': ['#/practice/glide', '3 glides, about 30 seconds.'],
      'Siren': ['#/practice/siren', '2 sirens, about 25 seconds.'],
      'Find your range': ['#/practice/range', 'Two steps, about one minute. Exercises then fit your voice.'],
      'Match and hold': ['#/practice/match', '5 notes, about 90 seconds.'],
      'Sing a constellation': ['#/practice/constellation', '12 star figures to draw with your voice.'],
      'Star steps': ['#/practice/star-steps', '4 patterns, about a minute.'],
      'Leaps and scales': ['#/practice/leaps', '4 leaps and 1 scale, about a minute.'],
      'Eyes closed': ['#/practice/eyes-closed', '3 notes, about 30 seconds.'],
    };
    view.append(
      h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Practice')),
      h('div', { class: 'card-grid' },
        linkCard('#/sing', 'Free sing', 'See your note live, with nothing to pass or fail.'),
        linkCard('#/practice/voice-check', 'Voice check', 'Ten notes and six short tunes, then a Sky portrait of your voice to keep.'),
        linkCard('#/practice/long-note', 'Long note', 'One comfortable note, held as long as is easy.'),
        names.map((name, i) => (built[name]
          ? linkCard(built[name][0], `${i + 1}. ${name}`, `${what[i]} ${built[name][1]}`)
          : h('section', { class: 'card card-waiting' },
            h('h2', null, `${i + 1}. ${name}`), h('p', null, what[i]), h('p', { class: 'reason' }, 'Not built yet.'))))));
  },
  songs(view) {
    // Song mode lives on its own page for now (sing.html); leaving this page releases the
    // microphone by itself.
    view.append(h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Songs')),
      card('Sing along with songs', h('p', null, 'Drop in a song file, sing it karaoke style, record a take and hear it back.'),
        h('div', { class: 'action-row' }, h('a', { class: 'btn btn-primary', href: './sing.html', dataset: { primary: '' } }, 'Open Sing a song'))));
  },
  progress(view) {
    view.append(h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Progress')),
      card('Nothing to show yet', h('p', null, 'Your stars, streak and range appear here after your first session.')));
  },
  coach(view) {
    view.append(h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Coach notes')),
      card('No coach notes yet', h('p', null, 'Your first tips appear after a session.'), h('p', null, h('a', { class: 'link', href: '#/today' }, 'Back to Today'))));
  },
  setup(view) {
    view.append(h('div', { class: 'title-row' }, h('h1', { tabindex: '-1' }, 'Set up')),
      card('Set-up comes with Find your range', h('p', null, 'For now, Free sing turns the microphone on when you press Start.'),
        h('p', null, h('a', { class: 'link', href: '#/sing' }, 'Go to Free sing'))));
  },
  // The sky is drawn by js/app/home.js behind the (empty) view; if that never loads, the
  // page's own plain links stand in (index.html, #plain-places).
  [HOME_ROUTE]() {},
};

// ---------------------------------------------------------------- the shell

const TAB_OF = { today: 'today', setup: 'today', coach: 'today', practice: 'practice', sing: 'practice', songs: 'songs', progress: 'progress' };
const TAB_KEYS = ['today', 'practice', 'songs', 'progress'];
const TITLES = { today: 'Today', practice: 'Practice', sing: 'Free sing', songs: 'Songs', progress: 'Progress', coach: 'Coach notes', setup: 'Set up', [HOME_ROUTE]: 'The sky' };

// Asks the "leave this screen?" question at most once at a time. A second address change
// while the question is still up (Back pressed twice) used to open a second sheet on top of
// the first; the one left behind then sat over the next screen and moved the page again
// when it was answered. Now the open question simply learns the newest destination.
//   leave(ask, wanted)   ask() -> Promise<boolean>; go(wanted) runs once, on a yes.
export function createLeaveAsker(go) {
  let pending = null;
  return function leave(ask, wanted) {
    if (pending) { pending.wanted = wanted; return; }
    const mine = (pending = { wanted });
    let answer;
    try { answer = Promise.resolve(ask()); } catch (err) { answer = Promise.reject(err); }
    answer.then(
      (ok) => { pending = null; if (ok) go(mine.wanted); },
      (err) => { pending = null; console.error(err); },
    );
  };
}

// The headphones chip. Before the question has been answered it must not claim an answer
// ("No headphones" on first load was one nobody gave).
//   phonesChipFor(null | 'on' | 'none') -> { word, icon | null, role, label }   (pure)
export function phonesChipFor(answer) {
  if (answer === 'on') return { word: 'Headphones on', icon: 'tick', role: 'good', label: 'Headphones on. Change your answer' };
  if (answer === 'none') return { word: 'No headphones', icon: 'dash', role: 'quiet', label: 'No headphones. Change your answer' };
  return { word: 'Headphones?', icon: null, role: 'unasked', label: 'Headphones? Say whether you are wearing them' };
}

export function initShell({ settings, routes, home = 'today', storage = null }) {
  const doc = document.documentElement;
  const view = document.getElementById('view');
  const lightMq = window.matchMedia('(prefers-color-scheme: light)');
  const contrastMq = window.matchMedia('(prefers-contrast: more)');
  const calmMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sections = new Map();
  let headphones = null, guard = null, current = null, currentHash = '', cleanup = null, passOnce = false, firstRender = true;

  // ---- theme and calm motion
  const calm = () => settings.get('calm') ?? calmMq.matches;
  // The pre-paint script in index.html set data-theme and data-tone already, so the first call
  // only confirms them. A later change of sky (Settings, or the Mac switching dark and light)
  // must not flash the whole window (STYLE: no full-screen colour change), so it cross-fades.
  let themeShown = false;
  function applyTheme() {
    const { theme, tone } = resolveSky(settings.get('theme'), { light: lightMq.matches, moreContrast: contrastMq.matches });
    const swap = () => {
      doc.dataset.theme = theme;
      doc.dataset.tone = tone;
      document.dispatchEvent(new CustomEvent('mt:theme', { detail: { theme, tone } }));
    };
    const same = doc.dataset.theme === theme && doc.dataset.tone === tone;
    // Layout S5: no cross-fade while the microphone is live. The view transition freezes the
    // page into a snapshot for 400 ms, so the voice line would stop moving under the singer.
    if (same || !themeShown || micLive()) swap(); else crossFade(swap);
    themeShown = true;
  }
  // Spec 4.3: a 400 ms cross-fade inside a view transition where the browser has one (Chrome
  // 111+); otherwise main#view fades out over 200 ms, the sky swaps, and it fades back. Calm
  // motion keeps the fade: a fade is the calm form, a cut would be the flash.
  function crossFade(swap) {
    const ease = getComputedStyle(doc).getPropertyValue('--ease').trim() || 'ease';
    if (typeof document.startViewTransition === 'function') {
      const vt = document.startViewTransition(swap);
      vt.ready.then(() => {
        for (const a of document.getAnimations()) {
          if (String(a.effect && a.effect.pseudoElement).startsWith('::view-transition')) a.effect.updateTiming({ duration: 400, easing: ease });
        }
      }).catch(() => { /* skipped (page hidden): the swap still ran */ });
      return;
    }
    if (!view || !view.animate) { swap(); return; }
    view.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: ease, fill: 'forwards' }).finished
      .then(() => { swap(); return view.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: ease }).finished; })
      .then(() => { for (const a of view.getAnimations()) a.cancel(); }, () => swap());
  }
  // Whether the microphone is open. micflow is made after the shell (it takes the shell), so the
  // shell reads the mic chip micflow paints: role 'good' or 'close' is phase on or checking
  // (micflow.chipFor); 'quiet' is off and 'error' is blocked.
  function micLive() {
    const chip = document.getElementById('mic-chip');
    return !!chip && (chip.dataset.role === 'good' || chip.dataset.role === 'close');
  }
  function applyCalm() {
    doc.dataset.calm = calm() ? 'on' : 'off';
    document.dispatchEvent(new CustomEvent('mt:calm', { detail: { on: calm() } }));
  }
  // Constellation lines (living-sky 2.3 rule 4). On the page, like the aurora: skynow.js reads
  // data-sky-lines when the home sky starts (it loads after the shell) and follows the event.
  const skyLines = () => (['all', 'tonight', 'off'].includes(settings.get('skyLines')) ? settings.get('skyLines') : 'all');
  function applySkyLines() {
    const mode = skyLines();
    doc.dataset.skyLines = mode;
    document.dispatchEvent(new CustomEvent('mt:skylines', { detail: { mode } }));
  }
  // The aurora on the voice line (living-sky spec 6.6). On the page, like calm motion, so the
  // stage and the star field follow it without each screen passing it down.
  function applyAurora() {
    const on = settings.get('aurora') !== false;
    doc.dataset.aurora = on ? 'on' : 'off';
    document.dispatchEvent(new CustomEvent('mt:aurora', { detail: { on } }));
  }
  lightMq.addEventListener('change', applyTheme);
  contrastMq.addEventListener('change', applyTheme);
  calmMq.addEventListener('change', applyCalm);
  settings.subscribe((k) => { if (k === 'theme') applyTheme(); if (k === 'calm') applyCalm(); if (k === 'aurora') applyAurora(); if (k === 'skyLines') applySkyLines(); });
  applyTheme();
  applyCalm();
  applyAurora();
  applySkyLines();

  // ---- headphones chip and sheet (the answer lasts for the visit)
  const phonesChip = document.getElementById('headphones-chip');
  function paintPhones() {
    const p = phonesChipFor(headphones);
    phonesChip.replaceChildren(...[icon('headphones', 16), p.icon && icon(p.icon, 16), h('span', null, p.word)].filter(Boolean));
    phonesChip.dataset.role = p.role;
    phonesChip.dataset.answer = headphones || 'unasked';
    // In a narrow window the chip shows its icons only; the words stay here.
    phonesChip.setAttribute('aria-label', p.label);
    phonesChip.title = p.label;
  }
  // Chrome cannot tell whether headphones are on, so the app asks (spec 10.4). One sheet
  // at a time: a second caller waits for the same answer.
  let phonesAsk = null;
  function askHeadphones() {
    if (phonesAsk) return phonesAsk;
    phonesAsk = new Promise((done) => {
      const answer = (v) => {
        if (headphones !== v) {
          headphones = v;
          paintPhones();
          document.dispatchEvent(new CustomEvent('mt:headphones', { detail: { answer: v } }));
        }
        sheet.close();
      };
      const sheet = openSheet({
        title: 'Put on headphones', className: 'sheet-phones',
        onClose: () => { phonesAsk = null; done(headphones); },
        body: [
          h('div', { class: 'sheet-figure' }, icon('headphones', 48)),
          h('p', null, 'When a note or a song plays out loud, the microphone hears it and the pitch line follows the speaker instead of you.'),
          headphones && h('p', { class: 'reason' }, `Your answer now: ${headphones === 'on' ? 'Headphones on' : 'No headphones'}.`),
          h('div', { class: 'sheet-actions' },
            h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, onclick: () => answer('on') }, 'I’m wearing headphones ', h('kbd', { class: 'keycap' }, 'Space')),
            h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => answer('none') }, 'I don’t have any')),
          h('p', { class: 'reason' }, 'Without headphones each note plays first, then it’s your turn, and reward sounds stay off.'),
        ],
      });
    });
    return phonesAsk;
  }
  phonesChip.addEventListener('click', () => { askHeadphones(); });
  paintPhones();

  // ---- settings sheet
  function openSettings(sectionId) {
    // Backup and restore (backuppanel.js). Loaded only when Settings opens, with the take
    // and song stores, so the pages that never open it do not pay for them.
    const backupHost = h('div', { class: 'backup-host' });
    let saved = storage;
    try { saved = saved || window.localStorage; } catch { /* private mode: nothing to back up from */ }
    Promise.all([import('./backuppanel.js'), import('./song/takes.js'), import('./song/songstore.js')])
      .then(([{ mountBackup }, { createTakeStore, idbBackend }, { idbSongBackend }]) => {
        mountBackup(backupHost, { storage: saved, takes: createTakeStore({ backend: idbBackend() }), songs: idbSongBackend() });
      }).catch(() => { /* the rest of Settings works without it */ });
    const ownVoice = readOwnVoice(saved);
    const cleanups = [];
    const part = (id, title, ...kids) => h('section', { class: 'settings-part', id: `settings-${id}` }, h('h3', { tabindex: '-1' }, title), ...kids);
    const mic = h('div');
    const micSection = sections.get('mic');
    if (micSection) { const c = micSection.render(mic); if (c) cleanups.push(c); } else mic.append(h('p', { class: 'reason' }, 'The microphone is not set up on this page.'));
    // Sections other screens registered (Songs: the words switch), above "Your data".
    const registered = [...sections].filter(([id]) => id !== 'mic').map(([id, sec]) => {
      const box = h('div');
      const c = sec.render(box);
      if (typeof c === 'function') cleanups.push(c);
      return part(id, sec.title, box);
    });
    const volumeWords = h('p', { class: 'reason' });
    const sayVolume = () => { volumeWords.textContent = `Volume: ${Math.round(settings.get('toneVolume') * 100)} percent`; };
    sayVolume();
    const sheet = openSheet({
      title: 'Settings', className: 'sheet-settings',
      onClose: () => { for (const c of cleanups) c(); },
      body: [
        part('mic', 'Microphone', mic),
        part('theme', 'Look',
          skyPicker({ value: settings.get('theme'), onChange: (v) => settings.set('theme', v) }),
          switchRow({ label: 'Calm motion', note: 'Fewer moving effects. Starts on when your Mac asks for reduced motion.',
            value: calm(), onChange: (v) => settings.set('calm', v) }),
          segmented({ label: 'Constellation lines', value: skyLines(), onChange: (v) => settings.set('skyLines', v),
            options: [{ value: 'all', text: 'All' }, { value: 'tonight', text: 'Tonight’s only' }, { value: 'off', text: 'Off' }] }),
          h('p', { class: 'reason' }, 'The faint lines between the real stars on the home sky. Tonight’s only keeps the one constellation picked for tonight.'),
          switchRow({ label: 'Aurora on your voice line', note: 'A soft light above your line. It is tall when you are in tune.',
            value: settings.get('aurora') !== false, onChange: (v) => settings.set('aurora', v) }),
          segmented({ label: 'Pitch view', value: settings.get('pitchView'), onChange: (v) => settings.set('pitchView', v),
            options: [{ value: 'line', text: 'Scrolling line' }, { value: 'meter', text: 'Meter only' }] }),
          segmented({ label: 'Note names', value: settings.get('noteNames'), onChange: (v) => settings.set('noteNames', v),
            options: [{ value: 'letters', text: 'C D E' }, { value: 'solfege', text: 'Do Re Mi' }] })),
        // The share-alike licences ask for this credit wherever the data is shown (living-sky
        // spec section 1); the sky's own settings (city, constellation lines) will join it here.
        part('sky', 'Sky',
          h('p', { class: 'reason' }, 'Star data: HYG database (CC BY-SA 4.0). Constellation lines: Stellarium (CC BY-SA).'),
          // FluidR3_GM is MIT upstream and CC BY 3.0 on the mirror: credit where the sound is
          // chosen as well as in vendor/samples/voice-oohs/CREDITS.md.
          h('p', { class: 'reason settings-credit-samples' }, 'Voice samples: FluidR3_GM (Frank Wen), via midi-js-soundfonts.')),
        part('sound', 'Sound',
          // "My voice" (tone 'mine', every exercise) once a voice is taught; until then 'mine'
          // plays the sung "oo" (timbreFor), so that is what is shown as picked.
          segmented({ label: 'Reference tone', value: settings.get('tone') === 'mine' && !ownVoice ? 'sung' : settings.get('tone'), onChange: (v) => { settings.set('toneChosen', true); settings.set('tone', v); },
            options: [{ value: 'oohs', text: 'Real voice (oohs)' }, { value: 'sung', text: 'Sung "oo"' }, { value: 'soft', text: 'Soft synth' }, { value: 'voice', text: 'Voice-like' }, { value: 'sine', text: 'Plain' },
              ...(ownVoice ? [{ value: 'mine', text: 'My voice' }] : [])] }),
          ownVoice ? null : h('p', { class: 'reason settings-myvoice' }, 'My voice: sing one "oo" for a few seconds in Match and hold ("Teach it your voice"), and every exercise can play its notes in your own tone colour. Your tone colour and up to 3 short recordings stay in this browser only.'),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Reference tone volume'),
            h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(settings.get('toneVolume')),
              oninput: (e) => { settings.set('toneVolume', Number(e.target.value)); sayVolume(); } }), volumeWords),
          switchRow({ label: 'Pause to imagine the note', note: 'A short silent moment after the note, to hear it in your head.',
            value: settings.get('imagine') !== false, onChange: (v) => settings.set('imagine', v) }),
          switchRow({ label: 'Reward sounds', note: 'A soft answer when a note lands. Only with headphones on, and never while the microphone is judging a note.',
            value: settings.get('rewardSounds'), onChange: (v) => settings.set('rewardSounds', v) })),
        ...registered,
        part('data', 'Your data',
          h('p', { class: 'reason' }, 'Settings, songs and saved takes are kept in this browser only.'),
          backupHost,
          h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
            if (await confirmSheet({ title: 'Erase everything saved here?', body: 'Your settings, songs and saved takes on this computer will be removed. This cannot be undone.', yes: 'Erase', no: 'Keep my data' })) {
              settings.erase();
              await eraseSavedDatabases();
              sheet.close();
              toast('Erased');
            }
          } }, 'Erase my data')),
      ],
    });
    if (sectionId) {
      const target = sheet.body.querySelector(`#settings-${sectionId} h3`);
      if (target) { target.scrollIntoView({ block: 'start' }); target.focus(); }
    }
    return sheet;
  }
  document.getElementById('settings-button').addEventListener('click', () => openSettings());

  // ---- the sky bar (home: 'sky'): Back and the place's two names, in place of the tabs
  const skyHome = home === HOME_ROUTE;
  const homeHash = `#/${home}`;
  function paintBar(route) {
    const back = document.getElementById('sky-back'), names = document.getElementById('sky-names');
    if (!back || !names) return;                  // a lab page with the old top bar
    const to = backOf(route), words = namesOf(route);
    back.hidden = !to;
    names.hidden = !words;
    if (to) {
      back.href = to.hash;
      // (replaceChildren would print a bare `false` as text: only real nodes go in.)
      back.replaceChildren(...[icon('back', 20), h('span', null, to.label), to.esc && h('kbd', { class: 'keycap' }, 'Esc')].filter(Boolean));
    }
    if (words) names.replaceChildren(h('span', { class: 'sky-strip-name' }, words.name), h('span', { class: 'sky-strip-plain' }, words.plain));
  }

  // ---- routes
  const keyOf = (r) => (r ? `${r.name}/${r.param ?? ''}` : '');
  function show(route) {
    if (cleanup) { try { cleanup(); } catch (err) { console.error(err); } }
    cleanup = null;
    const from = current;
    current = route;
    currentHash = location.hash;
    view.replaceChildren();
    view.dataset.route = route.name;
    // The page's CSS follows the screen from here (css/home.css hides the view on the sky):
    // set before the screen is drawn, or its heading could not take the focus below.
    doc.dataset.route = route.name;
    const draw = routes[route.name] || placeholderScreens[route.name];
    cleanup = draw(view, { param: route.param, shell }) || null;
    for (const tab of document.querySelectorAll('[data-tab]')) {
      if (tab.dataset.tab === TAB_OF[route.name]) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    document.title = `${TITLES[route.name]} · Music trainer`;
    // After a change of place, focus goes to the screen's name so a keyboard or screen
    // reader starts from the top of the new screen. Not on first load: that would steal
    // the page's natural starting point.
    const h1 = view.querySelector('h1');
    if (!firstRender && h1) h1.focus({ preventScroll: true });
    firstRender = false;
    window.scrollTo(0, 0);
    paintBar(route);
    // The sky (js/app/home.js) follows the screen from here.
    document.dispatchEvent(new CustomEvent('mt:route', { detail: { route, from } }));
  }
  function onHash() {
    const route = parseRoute(location.hash, { home });
    if (!route) { location.replace(homeHash); return; }
    if (current && keyOf(route) === keyOf(current)) return;
    if (guard && current && !passOnce) {
      // Put the address back first: the screen has not changed until the person agrees.
      const wanted = location.hash;
      history.replaceState(null, '', currentHash || homeHash);
      leave(guard, wanted);
      return;
    }
    passOnce = false;
    show(route);
  }
  const leave = createLeaveAsker((wanted) => { passOnce = true; location.hash = wanted; });
  window.addEventListener('hashchange', onHash);

  // ---- keys that work everywhere (spec section 12)
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || sheetOpen()) return;
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === ' ' && (t === document.body || t === view || (t instanceof HTMLElement && t.tagName === 'CANVAS'))) {
      const primary = view.querySelector('[data-primary]:not([disabled])');
      if (primary) { e.preventDefault(); primary.click(); }
      return;
    }
    // While the mic is scoring only Space and Esc do anything.
    if (typing || guard) return;
    if (skyHome && e.key === 'Escape') {
      // Esc is Back only where the bar shows its keycap (never where it is the screen's Pause).
      const back = backOf(current);
      if (back && back.esc) { e.preventDefault(); location.hash = back.hash; }
      return;
    }
    // An open song's digits are its own (jump to a tenth): the places stand aside (spec 3.3).
    if (screenOwnsKey(current, e.key)) return;
    const jumps = skyHome ? NUMBER_ROUTES : TAB_KEYS.map((k) => `#/${k}`);
    const n = e.key.length === 1 ? '123456789'.indexOf(e.key) : -1;
    if (n >= 0 && n < jumps.length) location.hash = jumps[n];
  });

  const shell = {
    view,
    navigate(hash) { location.hash = hash; },
    openSettings,
    registerSettingsSection(id, title, render) { sections.set(id, { title, render }); },
    setBusy(fn) {
      guard = fn || null;
      doc.classList.toggle('is-scoring', !!guard);
      document.dispatchEvent(new CustomEvent('mt:busy', { detail: { on: !!guard } }));
    },
    route: () => current,
    headphones: () => headphones,
    askHeadphones,
    needHeadphones: () => (headphones ? Promise.resolve(headphones) : askHeadphones()),
    calm,
    // Separate from initShell so the caller can finish wiring (the mic flow needs the
    // shell) before the first screen is drawn.
    start() { onHash(); },
  };
  // The static top bar names its icons; one drawing of each lives in ICONS.
  for (const slot of document.querySelectorAll('[data-icon]')) slot.replaceWith(icon(slot.dataset.icon, Number(slot.dataset.size) || 20));
  return shell;
}
