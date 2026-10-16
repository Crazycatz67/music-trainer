// difficulty-view.js — how a song's difficulty reads on screen: the "steps" glyph, the number
// and band word, and the range-fit line (Delilah's spec docs/design/specs/
// 2026-10-14-song-difficulty.md sections 2 and 6). The numbers come from difficulty.js; this
// file only turns them into words, labels and two small inline SVGs.
//
// WHY a separate file: singnow.js (rows and the song plate) is the first user, the results
// panel and the Next up line come later; one place keeps the words and labels identical.
// The models and SVG strings are pure (Node checks: tools/checks/difficulty-view.check.mjs);
// the two *El builders take the page's own `h` so nothing here touches `document` at import.
//
// CONTRACT
//   ratingView(rating, { cfg }) -> null (no rating: draw nothing, like "no letter yet") |
//       { number: '2.4', band: 1..4, word: 'Steady', label: 'Difficulty 2.4, steady.', title }
//   fitView(fit) -> null (no fit, or no notes: draw nothing) |
//       { code, icon: 'in' | 'edge' | 'empty' | 'out-top' | 'out-bottom' | 'out-both',
//         words, title, label, href: '#/practice/range' for 'no-range', else null }
//       fit: a difficulty.js rangeFit(...) result.
//   entryFit(entry, range) -> fit | null   a store list entry (no notes, only range.lowest /
//       range.highest) measured against a saved range; null without a saved range or without
//       a traced range (rows say nothing then: no nag in a list, spec 5). { link: true } (the
//       song plate): without a saved range, the 'no-range' fit (its quiet link) instead.
//   stepsSvg(band) -> '<svg …>'   four treads, `band` filled (currentColor), the rest outlined
//       in --line-strong. 16 px, aria-hidden.
//   fitSvg(icon) -> '<svg …>'   the fit-in / fit-out marks, currentColor, 16 px, aria-hidden.
//   ratingEl(h, view) / fitEl(h, view) -> element | null   span.dv-rating / span.dv-fit (an
//       <a> for the no-range link). Styles: css/singnow.css (.dv-*).
//   pickLevel({ offered, kept, asked }) -> level id   the level a song opens on (spec 4.2):
//       `asked` (Next up / "Try it on …") if offered; else `kept` (prefs.levels[id]) if offered;
//       a kept level no longer offered falls to the next harder offered one; first open: Normal
//       if offered, else Hard. Never Easy by default. offered [] -> 'hard'.
//   levelLine(level) -> 'Level: Normal. Every note except the quick runs.'   the D key's line.
//   noteLook(wasJudged, isJudged, k) -> { line, halo }   the stage's multipliers for a stretch of
//       the target line (spec 3.4): judged 1 / 1, not judged faint.alpha / 0 (no glow); k 0..1
//       blends from the old level's look to the new one (clamped; NaN reads as 1).
//   fadeK(sinceMs, nowMs, { calm }) -> 0..1   how far a level cross-fade has run (faint.fadeMs);
//       1 at once under calm (reduced motion) or a non-finite start.

import { DIFFICULTY } from './difficulty.config.js';
import { LEVELS, bandOf, rangeFit } from './difficulty.js';
import { keyAdvice } from './bestkey.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const RATING_TITLE = 'How hard the tune is to sing: speed, jumps, span and breath.';
export const RANGE_HREF = '#/practice/range';

export function ratingView(rating, { cfg = DIFFICULTY } = {}) {
  if (!isNum(rating)) return null;
  const b = bandOf(rating, { cfg });
  const number = rating.toFixed(1);
  return { number, band: b.band, word: b.word, label: `Difficulty ${number}, ${b.word.toLowerCase()}.`, title: RATING_TITLE };
}

export function fitView(fit) {
  if (!fit || !fit.words || fit.code === 'no-notes') return null;
  const icon = fit.code === 'no-range' ? 'empty'
    : fit.code === 'just' ? 'edge'
    : fit.code === 'past' ? (fit.pastTop && fit.pastBottom ? 'out-both' : fit.pastTop ? 'out-top' : 'out-bottom')
    : 'in';
  const title = fit.title || fit.words;
  return { code: fit.code, icon, words: fit.words, title, label: /[.!?]$/.test(title) ? title : `${title}.`, href: fit.code === 'no-range' ? RANGE_HREF : null };
}

export function entryFit(entry, range, { link = false, cfg = DIFFICULTY } = {}) {
  const r = entry && entry.range;
  if (!r || !isNum(r.lowest) || !isNum(r.highest)) return null;
  if (!range || !isNum(range.lowMidi) || !isNum(range.highMidi)) return link ? rangeFit({ notes: [{ t: 0, dur: 1, midi: r.lowest }] }, null, { cfg }) : null;
  // The list record keeps only the tune's two ends; they are all the fit's words depend on
  // (outsideShare, which only feeds the personal number, is then an estimate).
  const fit = rangeFit({ notes: [{ t: 0, dur: 1, midi: r.lowest }, { t: 1, dur: 1, midi: r.highest }] }, range, { rating: isNum(entry.rating) ? entry.rating : null, cfg });
  // The row names the octave move when one is needed (best-key spec 3.2 a): rangeFit describes
  // the song after its best move, which the song only gets once it is opened or Use it is pressed.
  const a = keyAdvice(entry, range, { current: isNum(entry.octave) ? entry.octave : 0, kind: entry.kind === 'file' ? 'file' : 'chart', cfg });
  if (a.code === 'move' || (a.code === 'fits' && a.current !== 0)) return { ...fit, words: a.row, title: a.title || a.row };
  return fit;
}

const svg = (body) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${body}</svg>`;

// Treads 3 px wide with a 1 px gap, heights 4 / 7 / 10 / 13, standing on y = 15. An outline is
// inset by half its 1.5 px stroke so it is the same size as a filled tread.
export function stepsSvg(band) {
  const n = Math.max(0, Math.min(4, Math.round(band) || 0));
  return svg([4, 7, 10, 13].map((ht, i) => (i < n
    ? `<rect x="${i * 4}" y="${15 - ht}" width="3" height="${ht}" rx="1" fill="currentColor"/>`
    : `<rect x="${i * 4 + 0.75}" y="${15 - ht + 0.75}" width="1.5" height="${ht - 1.5}" rx="0.5" fill="none" style="stroke:var(--line-strong)" stroke-width="1.5"/>`)).join(''));
}

// A "[" standing upright is the saved range; the dot is the song. Inside = fits, touching the
// cap = just fits, outside = reaches past; an empty ring = no range saved yet.
const BRACKET = (top, bottom) => `<path d="M11 ${top} H5 V${bottom} H11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const DOT = (cy, filled = true) => (filled ? `<circle cx="9" cy="${cy}" r="2" fill="currentColor"/>` : `<circle cx="9" cy="${cy}" r="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/>`);
const FIT_SVG = Object.freeze({
  in: BRACKET(2, 14) + DOT(8),
  edge: BRACKET(2, 14) + DOT(4.75),
  empty: BRACKET(2, 14) + DOT(8, false),
  'out-top': BRACKET(6.5, 14) + DOT(2.5),
  'out-bottom': BRACKET(2, 9.5) + DOT(13.5),
  'out-both': BRACKET(6, 10) + DOT(2.5) + DOT(13.5),
});
export function fitSvg(icon) {
  if (!FIT_SVG[icon]) throw new RangeError(`fitSvg: no fit icon named ${icon}`);
  return svg(FIT_SVG[icon]);
}

// The SVG strings are fixed shapes built above from numbers only, never from song data, so
// innerHTML here cannot carry anything a song file wrote.
function mark(h, cls, html) {
  const el = h('span', { class: cls, 'aria-hidden': 'true' });
  el.innerHTML = html;
  return el;
}

export function ratingEl(h, view) {
  if (!view) return null;
  return h('span', { class: 'dv-rating', role: 'img', 'aria-label': view.label, title: view.title, dataset: { band: String(view.band) } },
    mark(h, 'dv-steps', stepsSvg(view.band)),
    h('span', { class: 'dv-num', 'aria-hidden': 'true' }, view.number),
    h('span', { class: 'dv-word', 'aria-hidden': 'true' }, view.word));
}

export function fitEl(h, view) {
  if (!view) return null;
  const inner = [mark(h, 'dv-fit-icon', fitSvg(view.icon)), h('span', null, view.words)];
  return view.href
    ? h('a', { class: 'dv-fit dv-fit-link', href: view.href, title: view.title, dataset: { fit: view.code } }, ...inner)
    : h('span', { class: 'dv-fit', title: view.title, 'aria-label': view.label, role: 'img', dataset: { fit: view.code } }, ...inner);
}

export function pickLevel({ offered = [], kept = null, asked = null } = {}) {
  if (!offered.length) return 'hard';
  if (offered.includes(asked)) return asked;
  if (offered.includes(kept)) return kept;
  const k = LEVELS.indexOf(kept);
  if (k >= 0) return offered.find((l) => LEVELS.indexOf(l) > k) || 'hard';
  return offered.includes('normal') ? 'normal' : 'hard';
}

export function levelLine(level, { cfg = DIFFICULTY } = {}) {
  const L = cfg.levels[level];
  return L ? `Level: ${L.label}. ${L.description}` : '';
}

// ---- after the level switch (spec 3.3 - 3.5). Pure: singnow.js wires them.
// levelCard(level, offered) -> 'Easy · long notes only' | ''   the count card's first words,
//     only when the song offers more than one level.
export function levelCard(level, offered = [], { cfg = DIFFICULTY } = {}) {
  const L = cfg.levels[level];
  return L && offered.length > 1 ? L.card : '';
}

// bestsId(songId, level) -> the key bests are kept under. Hard keeps the bare song id: every
// best saved before levels existed judged every note, which is Hard. Easy and Normal get their
// own ids, so a best never compares across levels (spec 3.5) and grades.js stays unchanged.
export function bestsId(songId, level) {
  return level === 'hard' || !LEVELS.includes(level) ? String(songId) : `${songId}@${level}`;
}

// badgeLevel(tops, offered) -> { level, result, others: [{ level, result }] } | null
//   tops: { easy, normal, hard } each a best result or null. The badge shows the highest level
//   cleared (a letter); with no letter anywhere, the highest "Finding it" (spec 3.1).
export function badgeLevel(tops = {}, offered = []) {
  const has = (l, f) => tops[l] && f(tops[l]);
  const down = [...offered].reverse();
  const level = down.find((l) => has(l, (r) => !!r.letter)) || down.find((l) => has(l, (r) => r.state === 'finding'));
  if (!level) return null;
  return { level, result: tops[level], others: down.filter((l) => l !== level && has(l, (r) => !!r.letter)).map((l) => ({ level: l, result: tops[l] })) };
}

// nextStep({ result, level, offered, tops, next, practice }) -> the results panel's one next
//   step (spec 3.5 table, first match), or null for no button:
//   { kind: 'level', level, label: 'Try it on Easy' } | { kind: 'song', id, level, title, label }.
//   next: recommendNext's pick { id, title, level? } or null. Titles cut at 22 characters.
export function nextStep({ result = null, level = 'hard', offered = [], tops = {}, next = null, practice = false } = {}, { cfg = DIFFICULTY } = {}) {
  if (!result || practice || result.tooShort || result.sangTooLittle || ['tooShort', 'sangTooLittle'].includes(result.state)) return null;
  const i = offered.indexOf(level), say = (l) => `Try it on ${cfg.levels[l].label}`;
  const struggling = result.state === 'finding' || result.letter === 'C';
  if (struggling && i > 0) return { kind: 'level', level: offered[i - 1], label: say(offered[i - 1]) };
  const top = ['SS', 'S', 'A'].includes(result.letter), atS = (r) => !!r && ['SS', 'S'].includes(r.letter);
  const up = i >= 0 ? offered.slice(i + 1).find((l) => !atS(tops[l])) : undefined;
  if (top && up) return { kind: 'level', level: up, label: say(up) };
  if (!result.letter || !next) return null;
  const t = String(next.title || '');
  return { kind: 'song', id: next.id, level: next.level || null, title: t, label: `Next up: ${t.length > 22 ? `${t.slice(0, 21)}…` : t}` };
}

// Spec 3.4: unjudged notes stay drawn, fainter and without halo. A level change cross-fades,
// so `k` blends the old look into the new one stretch by stretch.
export function noteLook(wasJudged, isJudged, k = 1, { cfg = DIFFICULTY } = {}) {
  const t = Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 1;
  const line = (on) => (on ? 1 : cfg.faint.alpha), halo = (on) => (on ? 1 : 0);
  return {
    line: line(wasJudged) + (line(isJudged) - line(wasJudged)) * t,
    halo: halo(wasJudged) + (halo(isJudged) - halo(wasJudged)) * t,
  };
}
export function fadeK(sinceMs, nowMs, { calm = false, cfg = DIFFICULTY } = {}) {
  if (calm || !(cfg.faint.fadeMs > 0) || !Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) return 1;
  return Math.min(1, Math.max(0, (nowMs - sinceMs) / cfg.faint.fadeMs));
}
