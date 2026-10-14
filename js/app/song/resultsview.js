// resultsview.js — the full results layer ("Full results", key F) of one sung take
// (docs/design/specs/2026-10-13-grades-and-results.md 5.1 to 5.5 and 6.4). It takes the data
// takeResults() worked out and returns the dialog element; it keeps no page state, saves
// nothing and plays nothing. Styled by css/grades.css (.sn-results*).
// Browser only (DOM). The words it prints all come from resultsmodel.js / medallion.js.
//
// CONTRACT
//   resultsView(data, on) -> HTMLElement   section.sn-results, role="dialog", aria-modal
//     data = {
//       title        the song's title
//       when         the take's date in words ('' for a practice run)
//       scored       resultsmodel.js takeResults(...) for this take
//       practice     boolean: a practice run (no Keep bar, no take list row for it)
//       keep         'ask' (the Keep bar) | 'kept' ("Kept") | null (nothing: practice)
//       retryLine    the line to practise as { index, label } (label 'Retry line 7') | null
//       takes        [{ id, when, words, chips: [text], best, current, gone }] newest first
//       lineCards    [HTMLElement] the page's "Your best line" and "A line to practise" cards
//                    (spec 5.1 bottom row; built by singnow.js lineCard, buttons wired there)
//       calm         boolean: no entrance motion
//     }
//     on = { close(), retrySong(), retryLine(), keep(), discard(), playTake(id) }  each optional
//   The page puts the element in the document, moves focus to its heading
//   (el.querySelector('.sn-results-head')) and closes it on Esc; Tab stays inside (here).

import { h, icon } from '../shell.js';
import { mountMedallion } from './medallion.js';
import { RESULT_WORDS } from './resultsmodel.js';
import { GRADE_WORDS } from './grades.js';
import { starSvg } from '../rewards.js';
import { HONESTY } from '../coachcard.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let serial = 0;
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

// The picture's geometry, in its own units (the SVG scales to the card's width): a far bar,
// a 12-unit gap, the 20 bars 10 wide with 2 between them, a gap, the other far bar.
const BAR = 10, GAP = 2, FAR_GAP = 12, PLOT_H = 104;
const binX = (i) => BAR + FAR_GAP + i * (BAR + GAP);

function histogramFigure(pic) {
  const fig = h('figure', { class: 'sn-hist' }, h('h3', { class: 'sn-results-sub' }, pic.title));
  if (pic.empty) { fig.append(h('p', { class: 'reason' }, pic.emptyText)); return fig; }
  const n = pic.bars.length, width = binX(n) - GAP + FAR_GAP + BAR;
  const plot = svg('svg', { class: 'sn-hist-plot', viewBox: `0 0 ${width} ${PLOT_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const hatch = `sn-hatch-${++serial}`;
  const defs = svg('defs');
  const pat = svg('pattern', { id: hatch, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(svg('rect', { class: 'sn-hist-hatch', width: 2, height: 4 }));
  defs.append(pat);
  plot.append(defs);
  const barEl = (x, b) => {
    if (!b || !(b.count > 0)) return null;
    // A bar with any count is at least 2 units tall; an empty one shows nothing.
    const ht = Math.max(2, b.height * (PLOT_H - 2));
    const r = svg('rect', { class: `sn-hist-bar is-${b.zone}`, x, y: PLOT_H - ht, width: BAR, height: ht, rx: 2 });
    if (b.zone === 'close') r.setAttribute('fill', `url(#${hatch})`);
    return r;
  };
  for (const el of [barEl(0, pic.farLow), ...pic.bars.map((b, i) => barEl(binX(i), b)), barEl(binX(n) - GAP + FAR_GAP, pic.farHigh)]) if (el) plot.append(el);
  // The singer's note: in the gap between the two middle bars, never across a bar.
  const mid = binX(n / 2) - GAP / 2;
  plot.append(svg('line', { class: 'sn-hist-centre', x1: mid, x2: mid, y1: 0, y2: PLOT_H }));
  const span = binX(n) - GAP - binX(0);
  if (pic.middle) {
    const x = binX(0) + pic.middle.at * span;
    plot.append(svg('line', { class: 'sn-hist-middle', x1: x, x2: x, y1: 0, y2: PLOT_H }));
  }
  const at = (frac) => `${((binX(0) + frac * span) / width * 100).toFixed(2)}%`;
  const axis = h('div', { class: 'sn-hist-axis', 'aria-hidden': 'true' },
    h('span', { class: 'is-low' }, pic.axis.low),
    h('span', { class: 'is-tick', style: `left:${at(0)}` }, pic.axis.keyLow),
    h('span', { class: 'is-on', style: `left:${at(0.5)}` }, pic.axis.on),
    h('span', { class: 'is-tick', style: `left:${at(1)}` }, pic.axis.keyHigh),
    h('span', { class: 'is-high' }, pic.axis.high),
    pic.middle ? h('span', { class: 'sn-hist-tri', style: `left:${at(pic.middle.at)}` }) : null);
  fig.append(h('div', { class: 'sn-hist-box' }, plot), axis,
    h('figcaption', null, pic.caption.join(' ')));
  return fig;
}

function countsBlock(bar, unsung) {
  if (!bar) return null;
  const how = h('p', { class: 'reason sn-counts-how', hidden: true }, RESULT_WORDS.how);
  // Shapes, never arrows: an arrow means "move this way" (STYLE; spec 20).
  const icons = { great: 'tick', good: 'wave', ok: 'dots', miss: 'dash' };
  return h('div', { class: 'sn-counts' },
    h('ul', { class: 'sn-counts-words' }, bar.segments.map((s) => h('li', { dataset: { id: s.id } }, icon(icons[s.id] || 'wave', 14), ` ${s.word} ${s.share} %`))),
    h('div', { class: 'sn-counts-row' },
      h('div', { class: 'sn-counts-bar', role: 'img', 'aria-label': bar.segments.map((s) => `${s.word} ${s.share} percent`).join(', ') },
        bar.segments.filter((s) => s.share > 0).map((s) => h('span', { dataset: { id: s.id }, style: `flex-grow:${s.share}` }))),
      h('span', { class: 'reason' }, bar.note)),
    unsung ? h('p', { class: 'reason' }, unsung) : null,
    h('button', { class: 'btn btn-quiet btn-small', type: 'button', 'aria-expanded': 'false', onclick: (e) => { how.hidden = !how.hidden; e.currentTarget.setAttribute('aria-expanded', String(!how.hidden)); } }, RESULT_WORDS.howButton),
    how);
}

function takesBlock(takes, on) {
  if (!takes || !takes.length) return null;
  const rows = takes.map((t) => h('li', { class: 'sn-results-take', dataset: { take: t.id }, 'aria-current': t.current ? 'true' : null },
    t.best ? h('span', { class: 'sn-results-take-star', title: 'Best' }, starSvg('held', 14)) : h('span', { class: 'sn-results-take-star' }),
    h('span', null, t.when), h('strong', null, t.words || ''),
    ...t.chips.map((c) => h('span', { class: 'sn-results-chip' }, c)),
    t.current ? h('span', { class: 'reason' }, 'this take') : t.gone ? h('span', { class: 'reason' }, 'sound no longer kept')
      : h('button', { class: 'btn btn-quiet btn-small', type: 'button', 'aria-label': `Play the take from ${t.when}`, onclick: () => on.playTake && on.playTake(t.id) }, icon('play', 14), ' Play')));
  const MAX = 5;
  const list = h('ul', { class: 'sn-results-takes', id: `sn-results-takes-${++serial}` }, rows.slice(0, MAX));
  const more = rows.length > MAX ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: (e) => { list.replaceChildren(...rows); e.currentTarget.remove(); } }, `Show all ${rows.length}`) : null;
  // At 1024 px and under the list folds to one button that opens it in place (spec 5.2).
  // Both are always built; css/grades.css shows the one that fits, so a resize needs no repaint.
  const earlier = takes.filter((t) => !t.current).length;
  const card = h('div', { class: 'sn-results-card sn-results-takes-card', dataset: { fold: earlier > 0 ? 'closed' : 'none' } });
  const fold = earlier > 0 ? h('button', { class: 'btn btn-quiet btn-small sn-results-fold', type: 'button', 'aria-expanded': 'false', 'aria-controls': list.id,
    onclick: (e) => { const open = card.dataset.fold !== 'open'; card.dataset.fold = open ? 'open' : 'closed'; e.currentTarget.setAttribute('aria-expanded', String(open)); } }, `Earlier takes (${earlier})`) : null;
  card.append(...[h('h3', { class: 'sn-results-sub' }, 'Your takes of this song'), fold, list, more].filter(Boolean));
  return card;
}

// The bottom row of 5.1: the two line cards and the takes, equal width.
function bottomRow(cards, takes) {
  const kids = [...(Array.isArray(cards) ? cards : []).filter(Boolean), takes].filter(Boolean);
  return kids.length ? h('div', { class: 'sn-results-bottom', dataset: { cards: String(kids.length) } }, kids) : null;
}

export function resultsView(data, on = {}) {
  const s = data.scored, m = s.medallion;
  const byEar = !!(s.result && s.result.mods && s.result.mods.noLine);
  const head = h('h2', { class: 'sn-results-head', id: 'sn-results-head', tabindex: '-1', title: data.title },
    ['Results', data.title, data.when, byEar ? 'By ear' : null].filter(Boolean).join(' · '));
  const advice = h('p', { class: 'sn-results-advice', id: 'sn-results-advice' }, icon(s.advice.icon || 'wave', 20),
    h('span', null, h('strong', null, s.advice.said), ` Next go: ${s.advice.next}`));
  const medal = h('div', { class: 'sn-results-medal' });
  mountMedallion(medal, m, { size: 168, calm: true });
  const left = h('div', { class: 'sn-results-left' }, medal,
    // The percent of a take with no letter is shown only here, quietly (owner choice 3).
    !m.letter && m.percentText ? h('p', { class: 'reason sn-results-quiet' }, m.percentText) : null,
    // sangTooLittle says its sentence once, in the best line (review J3).
    m.letter ? h('p', { class: 'reason' }, GRADE_WORDS[m.letter] || '') : null,
    s.best.words ? h('p', { class: 'sn-best-line' }, s.best.words) : null,
    s.best.chip ? h('p', { class: 'sn-chip', dataset: { tone: s.best.chip.tone || 'plain', chip: s.best.chip.id } }, s.best.chip.text) : null,
    s.best.next ? h('p', { class: 'reason' }, s.best.next.text) : null,
    s.run ? h('p', null, s.run) : null);
  const right = h('div', { class: 'sn-results-right' }, histogramFigure(s.picture), countsBlock(s.countsBar, s.unsung));
  const keep = data.keep === 'ask'
    ? h('div', { class: 'sn-results-keep' }, h('span', null, 'Keep this take?'),
      h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-results-keep', onclick: () => on.keep && on.keep() }, 'Keep it'),
      h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-results-discard', onclick: () => on.discard && on.discard() }, 'Discard'))
    : data.keep === 'kept' ? h('span', { class: 'reason' }, 'Kept') : null;
  const kbd = (k) => h('kbd', { class: 'keycap' }, k);
  const actions = h('div', { class: 'sn-results-actions action-row' },
    h('button', { class: `btn ${s.grade.state === 'tooShort' || s.advice.id !== 'rest' ? 'btn-primary' : 'btn-secondary'} btn-small`, type: 'button', id: 'sn-results-retry', onclick: () => on.retrySong && on.retrySong() }, data.practice ? 'Record a take' : 'Retry song', ' ', kbd('R')),
    data.retryLine ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', id: 'sn-results-retry-line', onclick: () => on.retryLine && on.retryLine() }, data.retryLine.label, ' ', kbd('L')) : null,
    h('span', { class: 'sn-gap' }), keep,
    h('button', { class: 'btn btn-quiet btn-small', type: 'button', id: 'sn-results-close', onclick: () => on.close && on.close() }, 'Close'));
  const card = h('div', { class: 'sn-results-card-main' }, head, advice,
    h('p', { class: 'reason sn-results-honesty' }, HONESTY),
    h('div', { class: 'sn-results-grid' }, left, right),
    bottomRow(data.lineCards, takesBlock(data.takes, on)), actions);
  const el = h('section', { class: 'sn-results', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sn-results-head', 'aria-describedby': 'sn-results-advice', dataset: { calm: data.calm ? 'on' : 'off', state: s.grade.state } }, card);
  // Tab stays inside the layer.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const all = [...el.querySelectorAll('button:not([disabled]), [tabindex="0"], a[href]')].filter((b) => b.offsetParent !== null);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === head)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  return el;
}
