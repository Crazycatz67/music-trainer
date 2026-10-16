// coachcard.js — the coach summary (spec section 8): turns the takes of a session into the
// two or three things worth fixing, in plain words, with the number behind each. Rule-based
// only: nothing is sent anywhere and no model writes any of it. Never a score.
//
// The top half is PURE and imports in Node (tools/checks/coachcard.check.mjs).
//
// CONTRACT — pure
//   measuresOf(takes) -> { notes, of, held, sungSec, tuneSec, tunePct, bias, off, drift, wobble, scoop, lock }
//       Pooled from the NoteRecs of js/app/sessions.js. Cents, negative = low. Any of the last
//       six is null when nothing could be measured.
//         tunePct  share of the time with a voice spent within 25 cents ("time in tune")
//         bias     average low/high, weighted by readings      drift   across a held note
//         off      how far a note's own middle sits from the target, EITHER way, weighted as
//                  bias is: 60 over then 60 under is bias 0 and off 60
//         wobble   spread either side on a held note            scoop   note start against the rest
//         lock     median seconds from the first sound to settling on the note
//       drift, wobble and scoop are the MEDIAN over notes: the cards speak of "long notes" and
//       "notes", so one bad note of five must not make the sentence (bugs.md 57).
//   usualOf(sessions, beforeId, config?) -> measures | null   the mean over the last
//       config.coach.usualSessions sessions before that one that had enough singing
//   summarise(takes, { usual?, config? }) -> Summary
//       { enough, clean, headline, fixes: [Fix], good, next, stars, minutes, measures, rows }
//       enough    false under config.coach.minSungSec of singing or minNotes notes: no tips
//       clean     enough, nothing over its threshold, and in tune at least config.coach.goodTunePct
//                 of the time sung. Under that with no fix to name: the plain count, and
//                 next is "listen to the note once more" (never "A clean session").
//       fixes     at most config.coach.maxFixes, biggest first; never an invented one
//       Fix       { id: 'beside' | 'bias' | 'drift' | 'wobble' | 'scoop' | 'lock',
//                   dir: 'low' | 'high' | null, value, severity (0..1), title, number, try, href }
//         beside  "the notes are landing beside the target" (design review 5, finding 1): time
//                 in tune under config.coach.besideTunePct, the notes' own middles off the
//                 target by config.coach.littleCents or more (or not measurable: nothing was
//                 near), and the average low/high inside the band (misses both ways cancel).
//                 A wide wobble centred on the note is not this: its middle is on the target.
//                 value is the time in tune, percent. Always the first card; the scoop and lock
//                 cards are not shown with it (they are side effects of hunting for the note).
//         bias    no card at config.coach.goodTunePct or more in tune (review 5, finding 2);
//                 "a little" only under config.coach.littleCents.
//       headline  its second sentence ("They sat low.") is about the FIRST card, or left out
//       good      "What went well" line; null only when not enough was sung. With nothing
//                 else to praise: the notes held, else the seconds sung, else the round finished.
//       next      the one thing to try next
//       rows      "All the numbers": [{ id, name, now, usual, word, info }];
//                 word: 'better' | 'about the same' | 'needs work' | ''
//   FIX_WORDS, HONESTY, NOT_ENOUGH, CENTS_NOTE   the exact words (spec section 8; review 5)
//   shapePath(fix, w?, h?) -> SVG path data: the average shape of the line for that problem
//
// CONTRACT — browser
//   mountCoach(view, { sessions, id, config? }) -> cleanup   the #/coach/<sessionId> screen;
//       no id: the newest session. Opens nothing: no microphone, no sound.
//   roundCoach(detail, { config? }) -> element | null   the short card under an exercise after
//       a round; detail is what sessions' onTake passes. Null for a take with no targets.
//   tipCard(sessions, { config? }) -> element   Today's "Last coach tip" card
//   watchRounds(view, { config? }) -> cleanup   shows roundCoach() on 'mt:take' (document
//       event, detail as above), removes it on the next 'mt:exercise' start
//
// Not built here: Listen back, the optional AI summary, the gold bloom on arriving.

import { noteName } from '../notes.js';
import { CONFIG } from './config.js';
import { h, icon } from './shell.js';

// ---------------------------------------------------------------- pure

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const have = (xs) => xs.filter((x) => Number.isFinite(x));

export function measuresOf(takes) {
  const scored = (takes || []).filter((t) => t && Array.isArray(t.notes) && t.notes.length);
  const notes = scored.flatMap((t) => t.notes);
  const sungSec = notes.reduce((s, n) => s + (n.sung || 0), 0);
  const tuneSec = notes.reduce((s, n) => s + (n.sung || 0) * ((n.in25 || 0) / 100), 0);
  const weighed = notes.filter((n) => Number.isFinite(n.mean) && n.w > 0);
  const w = weighed.reduce((s, n) => s + n.w, 0);
  return {
    notes: notes.length,
    of: scored.reduce((s, t) => s + (t.of || 0), 0),
    held: scored.reduce((s, t) => s + (t.stars || 0), 0),
    sungSec, tuneSec,
    tunePct: sungSec > 0 ? (100 * tuneSec) / sungSec : null,
    bias: w > 0 ? weighed.reduce((s, n) => s + n.mean * n.w, 0) / w : null,
    off: w > 0 ? weighed.reduce((s, n) => s + Math.abs(n.mean) * n.w, 0) / w : null,
    // Medians: four level notes and one that sinks 80 cents is not "long notes sink, 15 cents".
    drift: median(have(notes.map((n) => n.drift))),
    wobble: median(have(notes.map((n) => n.wobble))),
    scoop: median(have(notes.map((n) => n.scoop))),
    lock: median(have(notes.map((n) => n.lock))),
  };
}

const enoughFor = (m, C) => m.sungSec >= C.minSungSec && m.notes >= C.minNotes;

export function usualOf(sessions, beforeId, config = CONFIG) {
  const C = config.coach;
  const at = sessions.findIndex((s) => s.id === beforeId);
  const earlier = (at < 0 ? sessions : sessions.slice(0, at)).map((s) => measuresOf(s.takes)).filter((m) => enoughFor(m, C)).slice(-C.usualSessions);
  if (!earlier.length) return null;
  const out = { sessions: earlier.length };
  for (const k of ['tunePct', 'bias', 'drift', 'wobble', 'scoop', 'lock']) out[k] = mean(have(earlier.map((m) => m[k])));
  return out;
}

export const HONESTY = 'The coach reads pitch only. It cannot hear tone, breath or volume.';
export const NOT_ENOUGH = 'Not enough singing to give tips yet. Two or three more notes will do it.';
const CLEAN_NEXT = 'Nothing to fix today. Next: sing a new constellation.';
// Every number on the page is in cents, and a beginner has no size for one (review 5, finding 6).
export const CENTS_NOTE = '100 cents is one step to the next note. Inside 25 counts as in tune.';

const cents = (x) => { const n = Math.round(Math.abs(x)); return `${n} ${n === 1 ? 'cent' : 'cents'}`; };
const secs = (x) => `${(Math.round(x * 10) / 10).toFixed(1)} seconds`;

// Spec section 8, the table. No "flat", "sharp", "Hz" or "MIDI" (acceptance check 24), and
// every number has its unit in words (25).
export const FIX_WORDS = Object.freeze({
  beside: { title: 'The notes are landing beside the target', number: (v) => `In tune ${Math.round(v)} percent of the time you sang`, try: 'listen to the note twice, hum it quietly, then sing it.' },
  // titleBig: from config.coach.littleCents up, where "a little" would not be true.
  bias: {
    low: { title: 'You sing a little low', titleBig: 'You sing low', number: (v) => `${cents(v)} under, on average`, try: 'aim for the top edge of the band.' },
    high: { title: 'You sing a little high', titleBig: 'You sing high', number: (v) => `${cents(v)} over, on average`, try: 'aim for the bottom edge of the band.' },
  },
  drift: {
    low: { title: 'Long notes sink', number: (v) => `About ${cents(v)} lower by the end of a hold`, try: 'keep the air moving to the end.' },
    high: { title: 'Long notes creep up', number: (v) => `About ${cents(v)} higher by the end of a hold`, try: 'sing the end of the note a little quieter.' },
  },
  wobble: { title: 'Your held notes wobble', number: (v) => `They move about ${cents(v)} either side`, try: 'breathe in slowly, then hold one easy note as if blowing on hot soup.' },
  scoop: {
    low: { title: 'You slide up into notes', number: (v) => `You start about ${cents(v)} under`, try: 'listen, hum the note in your head, then start right on it.' },
    high: { title: 'You drop onto notes', number: (v) => `You start about ${cents(v)} over`, try: 'start the note quietly, then let it grow.' },
  },
  lock: { title: 'It takes a moment to find the note', number: (v) => `About ${secs(v)} to settle`, try: 'listen to the note once more before you sing.' },
});

const ROWS = [
  ['tunePct', 'Time in tune', 'How much of your singing was within a quarter of a note of the target.'],
  ['bias', 'Average low or high', 'Where your notes sit against the target, on average.'],
  ['drift', 'Drift on held notes', 'How far a note moves between the start and the end of a hold.'],
  ['wobble', 'Wobble', 'How much a held note moves either side of its own middle.'],
  ['scoop', 'Start of the note', 'Where a note starts against where it settles.'],
  ['lock', 'Time to find the note', 'From your first sound to staying on the note.'],
];

function sayMeasure(id, v) {
  if (!Number.isFinite(v)) return 'not measured';
  if (id === 'tunePct') return `${Math.round(v)} percent`;
  if (id === 'lock') return secs(v);
  if (Math.round(Math.abs(v)) === 0) return '0 cents';
  if (id === 'wobble') return `${cents(v)} either side`;
  if (id === 'drift') return `${cents(v)} ${v < 0 ? 'lower' : 'higher'}`;
  return `${cents(v)} ${v < 0 ? 'under' : 'over'}`;
}

function compare(id, now, usual, problem, C) {
  if (!Number.isFinite(now)) return '';
  if (!Number.isFinite(usual)) return problem ? 'needs work' : '';
  const same = id === 'tunePct' ? C.samePct : id === 'lock' ? C.sameSec : C.sameCents;
  // Time in tune is better when bigger; the others are distances, better when smaller.
  const gain = id === 'tunePct' ? now - usual : Math.abs(usual) - Math.abs(now);
  if (gain > same) return 'better';
  return problem ? 'needs work' : 'about the same';
}

export function summarise(takes, { usual = null, config = CONFIG } = {}) {
  const C = config.coach, m = measuresOf(takes);
  const enough = enoughFor(m, C);
  const stars = (takes || []).reduce((s, t) => s + ((t && t.stars) || 0), 0);
  const minutes = Math.max(1, Math.round((takes || []).reduce((s, t) => s + ((t && t.sec) || 0), 0) / 60));
  const fixes = [];
  const add = (id, value, limit, scale, signed) => {
    if (!Number.isFinite(value) || Math.abs(value) < limit) return;
    const dir = signed ? (value < 0 ? 'low' : 'high') : null;
    const words = signed ? FIX_WORDS[id][dir] : FIX_WORDS[id];
    const title = words.titleBig && Math.abs(value) >= C.littleCents ? words.titleBig : words.title;
    fixes.push({
      id, dir, value, severity: Math.min(1, Math.abs(value) / scale), title, number: words.number(value), try: words.try,
      // The one exercise where a single note is held against a band, so each of these shows.
      href: '#/practice/match',
    });
  };
  // Misses both ways cancel in the average: no low/high card comes up, and the real news
  // ("you are not on the note yet") went unsaid behind a detail about note starts. Not when
  // the average itself sits outside the band: then "You sing low" is the news.
  // (off is null when no note had readings near its target: that is "beside" too.)
  const beside = enough && m.tunePct !== null && m.tunePct < C.besideTunePct
    && !(Math.abs(m.bias ?? 0) >= C.littleCents) && !(m.off !== null && m.off < C.littleCents);
  if (enough) {
    // In tune most of the time: an average inside the band is not worth a card (the lab's
    // drifter, 96 percent in tune, was told "You sing a little low, 10 cents under").
    if (!(m.tunePct >= C.goodTunePct)) add('bias', m.bias, C.biasCents, C.severity.bias, true);
    add('drift', m.drift, C.driftCents, C.severity.drift, true);
    add('wobble', m.wobble, C.wobbleCents, C.severity.wobble, false);
    add('scoop', m.scoop, C.scoopCents, C.severity.scoop, true);
    add('lock', m.lock, C.slowLockSec, C.severity.lock, false);
  }
  // Stable sort: equal severities keep the order above.
  fixes.sort((a, b) => b.severity - a.severity);
  // The rows of "All the numbers" keep every measure over its limit, shown as a card or not.
  const problems = new Set(fixes.map((f) => f.id));
  let cards = fixes;
  if (beside) {
    const W = FIX_WORDS.beside;
    problems.add('tunePct');
    cards = [{ id: 'beside', dir: null, value: m.tunePct, severity: 1, title: W.title, number: W.number(m.tunePct), try: W.try, href: '#/practice/match' },
      ...fixes.filter((f) => f.id !== 'scoop' && f.id !== 'lock')];
  }
  const shown = cards.slice(0, C.maxFixes);
  // Seldom in tune is never "a clean session" (bugs.md 51): a singer a note and a half under
  // the target all through has no tuning number at all (nothing was near the target), so no
  // measure is over its limit. They get the plain count and the one thing that helps then.
  const far = enough && !(m.tunePct >= C.goodTunePct);
  const clean = enough && !shown.length && !far;

  let headline = NOT_ENOUGH;
  if (clean) headline = 'A clean session';
  else if (enough) {
    headline = m.held > 0 ? `You held ${m.held} of ${m.of} ${m.of === 1 ? 'note' : 'notes'} in tune.` : `You sang ${m.of} ${m.of === 1 ? 'note' : 'notes'}.`;
    // About the first card only: a headline that named a problem with no card under it sent
    // the reader looking for it. "Most misses" only when something was missed: with every
    // note held it would contradict itself.
    if (shown.length && shown[0].id === 'bias') {
      const side = `${Math.abs(m.bias) >= C.littleCents ? '' : 'a little '}${m.bias < 0 ? 'low' : 'high'}`;
      headline += m.held > 0 && m.held >= m.of ? ` They sat ${side}.` : ` Most misses were ${side}.`;
    }
  }

  const well = [];
  if (enough) {
    if (m.tunePct !== null && m.tunePct >= C.goodTunePct) well.push(`in tune for ${Math.round(m.tunePct)} percent of your singing`);
    const notes = (takes || []).flatMap((t) => (t && t.notes) || []);
    const steady = [...new Set(notes.filter((n) => n.held && Number.isFinite(n.wobble) && n.wobble < C.wobbleCents / 2 && Math.abs(n.mean ?? 99) < C.biasCents).map((n) => noteName(n.midi)))].slice(0, 2);
    if (steady.length) well.push(`steady on ${steady.join(' and ')}`);
    if (usual && Number.isFinite(usual.lock) && Number.isFinite(m.lock) && usual.lock - m.lock > C.sameSec) well.push('quicker to find the note than usual');
    if (m.drift !== null && !problems.has('drift')) well.push('long notes stayed level');
    if (m.scoop !== null && !problems.has('scoop')) well.push('clean starts');
    // Always one true kind line: three fault cards with no kind word is where this screen
    // stopped being kind (review 5, finding 2).
    if (!well.length) {
      const sec = Math.round(m.sungSec);
      well.push(m.held > 0 ? `you held ${m.held} ${m.held === 1 ? 'note' : 'notes'}` : sec > 0 ? `you sang for ${sec} ${sec === 1 ? 'second' : 'seconds'}` : 'you finished the round');
    }
  }

  const rows = ROWS.map(([id, name, info]) => ({
    id, name, info, now: sayMeasure(id, m[id]),
    usual: usual ? sayMeasure(id, usual[id]) : 'first session',
    word: enough ? compare(id, m[id], usual ? usual[id] : null, problems.has(id), C) : '',
  }));

  return {
    enough, clean, headline, fixes: shown, stars, minutes, measures: m, rows,
    good: well.length ? `What went well: ${well.slice(0, 2).join(' · ')}` : null,
    next: shown.length ? `Try: ${shown[0].try}` : clean ? CLEAN_NEXT : far ? `Try: ${FIX_WORDS.lock.try}` : null,
  };
}

// The tiny picture: the band, and the average shape of the line for that problem, drawn
// from its number (the readings themselves are not kept). 50 cents is a quarter of the height.
export function shapePath(fix, w = 160, ht = 64) {
  const mid = ht / 2, perCent = ht / 4 / 50, lim = ht / 2 - 6;
  const y = (c) => (mid - Math.max(-lim, Math.min(lim, c * perCent))).toFixed(1);
  const pts = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    let c = 0;
    if (fix.id === 'bias') c = fix.value;
    // Off the band, above then below (review 5): the same miss whatever the number.
    else if (fix.id === 'beside') c = 60 * Math.tanh((0.5 - k) * 14);
    else if (fix.id === 'drift') c = fix.value * k;
    else if (fix.id === 'wobble') c = fix.value * 1.4 * Math.sin(k * Math.PI * 6);
    else if (fix.id === 'scoop') c = fix.value * 2 * Math.exp(-k * 9);
    // Hunting, then settled: the longer the wait, the further along the line it calms.
    else if (fix.id === 'lock') c = 70 * Math.cos(k * Math.PI * 5) * Math.max(0, 1 - k / Math.min(0.9, 0.3 + fix.value / 3));
    pts.push(`${i ? 'L' : 'M'}${(8 + k * (w - 16)).toFixed(1)} ${y(c)}`);
  }
  return pts.join(' ');
}

// ---------------------------------------------------------------- browser

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

// Drawn here, on the shell's 24 px grid with its 2 px round strokes: the shell has no
// sloping line, hooked arrow or clock, and they are used nowhere else.
const OWN_ICONS = {
  slope: 'M4 8l16 8', 'slope-up': 'M4 16l16-8',
  hook: 'M4 18c4 0 6-3 6-8h10M16 6l4 4-4 4', 'hook-down': 'M4 6c4 0 6 3 6 8h10M16 10l4 4-4 4',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  // The target line with a note above it and one below.
  beside: 'M4 12h16M7.5 5a1.5 1.5 0 1 0 .01 0M16.5 16a1.5 1.5 0 1 0 .01 0',
};
function fixIcon(fix) {
  // A low singer is pointed up, towards the note (spec: "arrow up / down").
  if (fix.id === 'bias') return icon(fix.dir === 'low' ? 'arrow-up' : 'arrow-down', 20);
  if (fix.id === 'wobble') return icon('wave', 20);
  const name = fix.id === 'beside' ? 'beside' : fix.id === 'drift' ? (fix.dir === 'low' ? 'slope' : 'slope-up') : fix.id === 'scoop' ? (fix.dir === 'low' ? 'hook' : 'hook-down') : 'clock';
  return svg('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `icon icon-${name}` },
    svg('path', { d: OWN_ICONS[name] }));
}

function picture(fix) {
  return svg('svg', { viewBox: '0 0 160 64', width: 160, height: 64, class: 'coach-pic', 'aria-hidden': 'true' },
    svg('rect', { x: 0, y: 24, width: 160, height: 16, rx: 4, class: 'coach-pic-band' }),
    svg('path', { d: 'M0 32H160', class: 'coach-pic-mid' }),
    svg('path', { d: shapePath(fix), class: 'coach-pic-line' }));
}

function fixCard(fix) {
  return h('section', { class: 'card coach-fix', dataset: { fix: fix.id, dir: fix.dir || '' } },
    h('h2', null, fixIcon(fix), h('span', null, fix.title)),
    picture(fix),
    h('p', { class: 'coach-number' }, fix.number),
    h('p', { class: 'coach-try' }, `Try: ${fix.try}`),
    h('a', { class: 'btn btn-secondary btn-small', href: fix.href }, 'Practise this'));
}

const WORD_ICON = { better: 'tick', 'about the same': 'dash', 'needs work': 'arrow-up' };

function numbersTable(rows) {
  return h('details', { class: 'coach-all' },
    h('summary', null, 'All the numbers'),
    h('table', { class: 'coach-table' },
      h('thead', null, h('tr', null, ['Measure', 'This session', 'Your usual', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map((r) => h('tr', { dataset: { row: r.id } },
        h('th', { scope: 'row' }, r.name, h('span', { class: 'reason' }, r.info)),
        h('td', null, r.now), h('td', null, r.usual),
        h('td', null, r.word ? h('span', { class: 'coach-word' }, icon(WORD_ICON[r.word], 16), r.word) : ''))))));
}

const honesty = () => h('p', { class: 'reason coach-honesty' }, icon('info', 16), HONESTY);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayText(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

export function mountCoach(view, { sessions, id = null, config = CONFIG } = {}) {
  const all = sessions.read().sessions;
  const session = (id && all.find((s) => s.id === id)) || (!id && all[all.length - 1]) || null;
  const head = (...extra) => h('div', { class: 'title-row' },
    h('h1', { tabindex: '-1' }, 'Coach notes'), ...extra);
  if (!session) {
    view.append(head(), h('section', { class: 'card' },
      h('h2', null, id ? 'Those notes are not here' : 'No coach notes yet'),
      h('p', null, id ? 'They may have been made in another browser, or erased.' : 'Your first tips appear after a session.'),
      h('p', null, h('a', { class: 'btn btn-primary', href: '#/today', dataset: { primary: '' } }, 'Back to Today'))));
    return null;
  }
  const sum = summarise(session.takes, { usual: usualOf(all, session.id, config), config });
  const root = h('div', { class: 'coach', dataset: { state: !sum.enough ? 'little' : sum.clean ? 'clean' : 'fixes', session: session.id } });
  view.append(
    head(h('p', { class: 'coach-when' }, `${dayText(session.day)} · about ${sum.minutes} ${sum.minutes === 1 ? 'minute' : 'minutes'}`),
      sum.stars > 0 && h('span', { class: 'chip coach-stars', dataset: { role: 'gold' } }, icon('star', 16), `${sum.stars} ${sum.stars === 1 ? 'star' : 'stars'}`)),
    root);
  if (!sum.enough) {
    root.append(h('section', { class: 'card' }, h('p', { class: 'coach-headline' }, sum.headline),
      h('p', null, h('a', { class: 'btn btn-primary', href: '#/practice', dataset: { primary: '' } }, 'Back to practice'))), honesty());
    return null;
  }
  // Through h(): it drops what is not there (append() would write "null" on the page).
  root.append(...h('div', null,
    h('p', { class: 'coach-headline' }, sum.headline),
    sum.fixes.length ? h('div', { class: 'coach-fixes', dataset: { count: String(sum.fixes.length) } }, sum.fixes.map(fixCard))
      : h('section', { class: 'card' }, h('p', null, sum.next)),
    sum.good && h('p', { class: 'coach-good' }, sum.good),
    h('div', { class: 'action-row coach-foot' }, numbersTable(sum.rows),
      h('a', { class: 'btn btn-primary', href: '#/today', dataset: { primary: '' } }, 'Done ', h('kbd', { class: 'keycap' }, 'Space'))),
    h('p', { class: 'reason coach-cents' }, CENTS_NOTE),
    honesty()).childNodes);
  return null;
}

export function roundCoach(detail, { config = CONFIG } = {}) {
  const take = detail && detail.take;
  // Free sing and the range check have no target: there is nothing to coach, and "not
  // enough singing" under them would read as a complaint.
  if (!take || !take.notes.length) return null;
  const sum = summarise([take], { config });
  const fix = sum.fixes[0];
  return h('section', { class: 'card coach-round', 'aria-label': 'Coach', dataset: { state: !sum.enough ? 'little' : sum.clean ? 'clean' : 'fixes' } },
    h('h2', null, 'Coach'),
    !sum.enough ? h('p', null, NOT_ENOUGH)
      : fix ? [h('p', { class: 'coach-round-title' }, fixIcon(fix), h('span', null, `${fix.title}. ${fix.number}.`)), h('p', { class: 'coach-try' }, `Try: ${fix.try}`)]
        : h('p', null, sum.next),
    sum.enough && h('a', { class: 'btn btn-quiet btn-small', href: `#/coach/${detail.session.id}` }, 'Coach notes', icon('chevron', 16)));
}

// One listener for the whole app: a filed round ('mt:take') puts the coach's few words at
// the end of the screen, before the daily session's bar; the next round's start takes them
// away again. A change of screen empties the view, card included.
export function watchRounds(view, { config = CONFIG } = {}) {
  const clear = () => { for (const el of view.querySelectorAll('.coach-round')) el.remove(); };
  const onTake = (e) => {
    clear();
    const card = roundCoach(e.detail, { config });
    if (!card) return;
    const strip = view.querySelector('.daily-strip');
    if (strip) strip.before(card); else view.append(card);
  };
  const onExercise = (e) => { if (e.detail && e.detail.event === 'start') clear(); };
  document.addEventListener('mt:take', onTake);
  document.addEventListener('mt:exercise', onExercise);
  return () => { document.removeEventListener('mt:take', onTake); document.removeEventListener('mt:exercise', onExercise); };
}

export function tipCard(sessions, { config = CONFIG } = {}) {
  const all = sessions.read().sessions;
  // The newest session that has a tip: yesterday's one thing to try, or today's once sung.
  for (let i = all.length - 1; i >= 0; i--) {
    const sum = summarise(all[i].takes, { usual: usualOf(all, all[i].id, config), config });
    if (!sum.enough || !sum.next) continue;
    const fix = sum.fixes[0];
    return h('section', { class: 'card coach-tip', dataset: { session: all[i].id } },
      h('h2', null, 'Last coach tip'),
      h('p', { class: 'coach-tip-line' }, fix ? `${fix.title}. ${sum.next}` : sum.next),
      h('p', { class: 'reason' }, `From ${dayText(all[i].day)}`),
      h('a', { class: 'btn btn-secondary btn-small', href: `#/coach/${all[i].id}` }, 'Open'));
  }
  return h('section', { class: 'card coach-tip' }, h('h2', null, 'Last coach tip'), h('p', null, 'Your first tips appear after a session.'));
}
