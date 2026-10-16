// "Since your first" on Progress (docs/design/specs/2026-10-15-best-key-and-progress-test.md
// section 4): the first Sky portrait beside a later one, with an honest reading of what changed.
// The reading is pure and lives in js/app/voicecheck.js (sinceFirst); this file only draws it.
//
// Contract
//   mountSinceFirst(view, { checks, storage, noteStyle?, config? }) -> { el, destroy() }
//       checks: readPortraits(storage).checks (oldest first, the first pinned at index 0).
//       Puts one .card.sf-card first in `view` (after its .title-row) and removes the shell's
//       "Nothing to show yet" card, which it replaces in every state (0, 1, 2+ portraits).
//       Never throws for bad portraits: one that fails to draw leaves its box empty.
//   bloomDue(checks, seenId, cfg?) -> id | null   (pure; section 4.4)
//       The newest portrait's id when it is the first one ever with a clear gain over the
//       first and that id is not seenId; else null.
//   SINCEFIRST_KEY: localStorage { v: 1, clearSeenId } so the "New best" bloom plays once.
// No sound here: arriving on a page is not a press (owner rule: sound follows a press).
import { CONFIG } from './config.js';
import { mountPortrait } from './portrait.js';
import { h, icon, STORAGE_PREFIX } from './shell.js';
import { dateWords, gainLook, NORMAL_DAY, portraitWords, sinceFirst } from './voicecheck.js';

export const SINCEFIRST_KEY = `${STORAGE_PREFIX}sincefirst.v1`;
const TAKE = '#/practice/voice-check';
const FADE_MS = 200;

const anyClear = (s) => s.rows.some((r) => r.clear === 'gain');

export function bloomDue(checks, seenId, cfg = CONFIG.voiceCheck) {
  if (!Array.isArray(checks) || checks.length < 2) return null;
  const newest = checks.at(-1);
  if (!newest || newest.id === seenId) return null;
  if (!anyClear(sinceFirst(checks, newest.id, cfg))) return null;
  // Only the first time a clear gain shows up: an earlier one already had its moment.
  for (const c of checks.slice(1, -1)) if (anyClear(sinceFirst(checks, c.id, cfg))) return null;
  return newest.id;
}

function readSeen(storage) {
  try { const raw = JSON.parse(storage.getItem(SINCEFIRST_KEY) || 'null'); return raw && typeof raw.clearSeenId === 'string' ? raw.clearSeenId : null; } catch { return null; }
}
function writeSeen(storage, id) {
  try { storage.setItem(SINCEFIRST_KEY, JSON.stringify({ v: 1, clearSeenId: id })); } catch { /* blocked: it may play again, never breaks */ }
}

// Calm mode or the system's reduced motion: no fades, no bloom (the chip still says it).
const still = () => (typeof document !== 'undefined' && document.documentElement.dataset.calm === 'on')
  || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

export function mountSinceFirst(view, { checks = [], storage = null, noteStyle = 'letters', config = CONFIG } = {}) {
  const V = config.voiceCheck;
  const shown = [];
  let timer = 0;
  const el = h('section', { class: 'card sf-card', 'aria-labelledby': 'sf-title' });
  const title = h('h2', { id: 'sf-title' }, 'Since your first portrait');
  const titleRow = view.querySelector('.title-row');
  if (titleRow) titleRow.after(el); else view.prepend(el);
  const empty = [...view.querySelectorAll('.card')].find((c) => c !== el && /Nothing to show yet/.test(c.textContent));
  if (empty) empty.remove();
  const label = (p) => portraitWords(p, { noteStyle }).label;
  const draw = (host, p, opts) => { try { shown.push(mountPortrait(host, p, { calm: true, label: label(p), config, ...opts })); } catch { /* one bad portrait must not take the card */ } };
  const destroy = () => { clearTimeout(timer); for (const s of shown.splice(0)) s.destroy(); };

  if (!checks.length) {
    el.append(title, h('p', null, 'No portrait yet. It takes about 4 minutes.'),
      h('div', { class: 'action-row' }, h('a', { class: 'btn btn-primary', href: TAKE }, 'Take the voice check')));
    el.dataset.state = 'none';
    return { el, destroy };
  }
  if (checks.length === 1) {
    const pic = h('div', { class: 'sf-one' });
    el.append(title, h('p', null, 'Your first portrait is your starting point. Take another in a few weeks to see the change.'), pic,
      h('div', { class: 'action-row' }, h('a', { class: 'btn btn-secondary', href: TAKE }, 'Take the voice check')));
    el.dataset.state = 'one';
    draw(pic, checks[0], { thumb: true });
    return { el, destroy };
  }

  el.dataset.state = 'compare';
  const first = checks[0], later = checks.slice(1).reverse();
  let pickId = later[0].id;
  const pick = h('select', { class: 'vc-pick', id: 'sf-pick', onchange: (e) => { pickId = e.target.value; repaint(); } },
    later.map((q, i) => h('option', { value: q.id }, `${dateWords(q.at)}${i === 0 ? ' (newest)' : ''}`)));
  const headline = h('p', { class: 'sf-headline' });
  const body = h('div', { class: 'sf-body' });
  const chip = h('span', { class: 'chip sf-chip', dataset: { role: 'gold' }, hidden: true }, icon('star', 16), 'New best');
  el.append(
    h('div', { class: 'title-row sf-head' }, title, chip, h('label', { class: 'reason vc-pair-head', for: 'sf-pick' }, 'Compare with ', pick)),
    headline, body,
    h('div', { class: 'action-row' }, h('a', { class: 'btn btn-secondary', href: TAKE }, 'Take the voice check')));

  function paint() {
    for (const s of shown.splice(0)) s.destroy();
    const s = sinceFirst(checks, pickId, V, { noteStyle });
    const other = s.other;
    headline.textContent = s.headline;
    const scale = { low: Math.min(first.range.lowMidi, other.range.lowMidi), high: Math.max(first.range.highMidi, other.range.highMidi) };
    const left = h('div', { class: 'vc-picture' }), right = h('div', { class: 'vc-picture' });
    // Said on the element so a lab can see both pictures share one scale (spec check 15).
    body.dataset.scale = `${scale.low}-${scale.high}`;
    body.replaceChildren(
      h('div', { class: 'vc-pair sf-pair' },
        h('div', null, h('p', { class: 'reason vc-pair-head' }, `${s.heads[0]} (your first)`), left),
        h('div', null, h('p', { class: 'reason vc-pair-head' }, `${s.heads[1]}${other === checks.at(-1) ? ' (newest)' : ''}`), right)),
      h('table', { class: 'vc-table sf-table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, s.heads[0]), h('th', null, s.heads[1]), h('th', null, h('span', { class: 'visually-hidden' }, 'What changed')))),
        h('tbody', null, s.rows.map((r) => h('tr', { dataset: { id: r.id, clear: r.clear } },
          h('th', { scope: 'row' }, r.label), h('td', null, r.a), h('td', null, r.b),
          // Gold and its star only for a clear gain; a small one is said quietly; a loss
          // shows nothing but its two numbers (spec 4.1).
          gainLook(r) === 'gold' ? h('td', { class: 'vc-gain' }, icon('star', 16), ' ', r.gain)
            : gainLook(r) === 'muted' ? h('td', { class: 'sf-small' }, `${r.gain} ${NORMAL_DAY}`) : h('td', null))))),
      h('p', { class: 'sf-trail' }, s.trail),
      s.rangeNote ? h('p', { class: 'reason' }, s.rangeNote) : null,
      h('p', { class: 'reason' }, s.note));
    // In the page before drawing: a canvas reads its colours from the document (bugs.md 67).
    draw(left, first, { dim: V.portrait.earlierK, scale, tonight: false });
    draw(right, other, { scale, tonight: true });
  }
  function repaint() {
    clearTimeout(timer);
    if (still()) { paint(); return; }
    body.classList.add('sf-fading');
    timer = setTimeout(() => { paint(); body.classList.remove('sf-fading'); }, FADE_MS);
  }
  paint();

  // The Best tier, once (section 4.4): a slow gold glow behind this card only; nothing moves.
  const due = storage ? bloomDue(checks, readSeen(storage), V) : null;
  if (due) {
    writeSeen(storage, due);
    chip.hidden = false;
    if (!still()) { el.classList.add('best'); el.append(h('div', { class: 'sf-bloom', 'aria-hidden': 'true' })); }
  }
  return { el, destroy };
}
