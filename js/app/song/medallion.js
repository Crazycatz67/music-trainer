// medallion.js — the letter written in the sky: a ring that is the percent, a letter inside
// it and a crown of small stars above (docs/design/specs/2026-10-13-grades-and-results.md
// 4.2, words 11 and 11.1). Rank is carried three ways, never by colour alone: the letter,
// the count of crown stars, and how far round the ring goes.
//
// Two halves. medallionModel() is pure and checked in Node (tools/checks/medallion.check.mjs).
// mountMedallion() builds the DOM and inline SVG (no canvas) and is styled by css/grades.css;
// it touches `document` only when called and HAS NOT RUN IN A BROWSER YET.
//
// CONTRACT
//   medallionModel(result, config = GRADES) -> model
//     result: grades.js resultOf(...) or gradeOf(...) plus the percent:
//             { state, letter, silver, accuracy (per cent 0..100, unrounded), mods? }
//             Anything unreadable gives the tooShort model. Never throws.
//     model = {
//       state: 'graded' | 'finding' | 'tooShort' | 'sangTooLittle',
//       letter: 'SS' | 'S' | 'A' | 'B' | 'C' | null,
//       glyph: 'letter' | 'hollowStar' | 'dots' | 'none',   what sits inside the ring
//       glyphText: the letter, '...' or ''
//       tone: 'gold' | 'silver' | 'text' | 'muted'          the glyph's colour
//       silver: boolean                                     a letter earned by ear
//       ring: { fraction 0..1 (the UNROUNDED percent / 100), look: 'gold' | 'silver' |
//               'sweep' | 'sweepDim' | 'track', outer: boolean (SS: a second thin ring) }
//       crown: { count, look: 'gold' | 'silver', cuts: [percent] }
//               count comes from the LETTER (C 1 ... SS 5), never from the percent: a 97 %
//               take held at A has 3. cuts: the cut-off each of those stars lights at,
//               lowest first (for the reveal).
//       bloom: 0 | 0.5 | 1     the glow behind the letter (SS full, S half)
//       band: boolean          SS: the panel's aurora band grows (the page's job)
//       percent: whole number, rounded DOWN, or null (tooShort)
//       percentText: '78 %' | null
//       percentMuted: boolean  no letter: the percent is for the full layer only, in --muted
//       under: the words under the ring: '78 %' | 'Finding it' | 'Part of the song' |
//              'Too short for a letter'
//       underIsPercent: boolean
//       underTitle: the hover words of the percent, or null
//       label: the short spoken label: 'A, 78 percent' (+ ', by ear') | 'No letter yet:
//              finding it' | 'Part of the song' | 'Too short for a letter'
//       ringLabel: '78 percent' | null
//       title: the fixed sentence for this result (grades.js GRADE_WORDS)
//       spoken: label + '. ' + title   (the element's aria-label)
//       chip: null | { text: 'By ear', title, icon: 'moon' }   any take sung by ear, letter or not
//     }
//   mountMedallion(host, model, { calm = false, size = 96, reveal = false } = {}) -> element
//     Replaces what an earlier call left in `host` and returns the new div.mg (role="img").
//     size: the ring's width in px, one of MEDALLION_SIZES (40 has no crown, no words under it).
//     reveal: true starts in the ring-fills-then-letter-lands state (data-reveal="run"); the
//     page sets el.dataset.reveal = 'done' to jump to the end. calm: final state at once.
//     The count-up of the number and the shooting star are the page's; the box keeps its
//     height from the first frame (visibility, never display).
//   MEDALLION_SIZES, MEDALLION_WORDS

import { GRADES } from './grades.config.js';
import { GRADE_WORDS } from './grades.js';
import { icon } from '../shell.js';
import { starSvg } from '../rewards.js';

export const MEDALLION_SIZES = Object.freeze([40, 72, 96, 104, 120, 168]);

export const MEDALLION_WORDS = Object.freeze({
  finding: 'Finding it',
  sangTooLittle: 'Part of the song',
  tooShort: 'Too short for a letter',
  findingLabel: 'No letter yet: finding it',
  byEar: 'By ear',
  byEarLabel: ', by ear',
  percentTitle: 'How close your notes were to the singer\'s, across the whole take.',
});

const W = MEDALLION_WORDS;

// Rounded DOWN: "84 %" must never show as 85 and then be seen to miss S.
export const wholePercent = (accuracy) => (Number.isFinite(accuracy) ? Math.max(0, Math.min(100, Math.floor(accuracy + 1e-9))) : null);

export function medallionModel(result, config = GRADES) {
  const r = result && typeof result === 'object' ? result : {};
  const letters = (config && config.letters) || GRADES.letters;
  const at = letters.findIndex((g) => g.letter === r.letter);
  const accuracy = Number.isFinite(r.accuracy) ? Math.max(0, Math.min(100, r.accuracy)) : null;
  const byEar = !!(r.mods && r.mods.noLine);
  // The state is read back from what can be shown: a letter needs a percent, and a state
  // this file does not know is the quietest one.
  let state = ['graded', 'finding', 'sangTooLittle', 'tooShort'].includes(r.state) ? r.state : 'tooShort';
  if (state === 'graded' && (at === -1 || accuracy === null)) state = 'tooShort';
  if (state !== 'tooShort' && accuracy === null) state = 'tooShort';

  const percent = state === 'tooShort' ? null : wholePercent(accuracy);
  const percentText = percent === null ? null : `${percent} %`;
  const chip = byEar && state !== 'tooShort' ? { text: W.byEar, title: GRADE_WORDS.silver, icon: 'moon' } : null;
  const base = {
    state, letter: null, glyph: 'none', glyphText: '', tone: 'muted', silver: false,
    ring: { fraction: percent === null ? 0 : accuracy / 100, look: 'track', outer: false },
    crown: { count: 0, look: 'gold', cuts: [] }, bloom: 0, band: false,
    percent, percentText, percentMuted: true, under: W.tooShort, underIsPercent: false, underTitle: null,
    label: W.tooShort, ringLabel: percent === null ? null : `${percent} percent`, title: GRADE_WORDS.tooShort, spoken: '', chip,
  };
  const done = (m) => ({ ...m, spoken: `${m.label}. ${m.title}` });

  if (state === 'tooShort') return done(base);
  if (state === 'sangTooLittle') {
    return done({ ...base, glyph: 'dots', glyphText: '...', ring: { ...base.ring, look: 'sweepDim' }, under: W.sangTooLittle, label: W.sangTooLittle, title: GRADE_WORDS.sangTooLittle });
  }
  if (state === 'finding') {
    // Nothing greyed, crossed or empty: the hollow star is gold and the ring lights as far
    // as the singer got. No silver without a letter (the chip alone says "By ear").
    return done({
      ...base, glyph: 'hollowStar', tone: 'gold', ring: { ...base.ring, look: 'sweep' }, under: W.finding,
      label: W.findingLabel + (byEar ? W.byEarLabel : ''), title: GRADE_WORDS.finding,
    });
  }
  const letter = letters[at].letter, silver = !!r.silver;
  // The two letters at the top are the gold ones; the rest are ink on the aurora sweep.
  const top = at < 2;
  const count = letters.length - at;
  return done({
    ...base, letter, glyph: 'letter', glyphText: letter, silver,
    tone: top ? (silver ? 'silver' : 'gold') : 'text',
    ring: { ...base.ring, look: top ? (silver ? 'silver' : 'gold') : 'sweep', outer: at === 0 },
    crown: { count, look: silver ? 'silver' : 'gold', cuts: letters.slice(at).map((g) => g.min).reverse() },
    bloom: at === 0 ? 1 : at === 1 ? 0.5 : 0, band: at === 0,
    percentMuted: false, under: percentText, underIsPercent: true, underTitle: W.percentTitle,
    label: `${letter}, ${percent} percent${silver || byEar ? W.byEarLabel : ''}`,
    title: GRADE_WORDS[letter] || '',
  });
}

// ---------------------------------------------------------------- the element (browser only)

const SVG_NS = 'http://www.w3.org/2000/svg';
let serial = 0;

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
function div(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

// The star drawing keeps a wide empty margin (its viewBox is 3.4 across for a star 2
// across), so "14 px of star" is a 24 px box.
const starBox = (px) => Math.round(px * 1.7);

export function mountMedallion(host, model, { calm = false, size = 96, reveal = false } = {}) {
  const px = MEDALLION_SIZES.includes(size) ? size : 96;
  const small = px <= 40;
  const stroke = small ? 2 : 3, r = px / 2 - stroke / 2, c = px / 2;
  const root = div('div', 'mg');
  Object.assign(root.dataset, {
    state: model.state, tone: model.tone, ring: model.ring.look, size: String(px), letter: model.letter || '',
    crown: model.crown.look, bloom: String(model.bloom), calm: calm ? 'on' : 'off',
    reveal: reveal && !calm ? 'run' : 'done',
  });
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', model.spoken);
  root.title = model.title;
  root.style.setProperty('--mg-size', `${px}px`);

  // The crown's line is always there (its height is part of the box) and only ever holds
  // the stars the LETTER has earned.
  if (!small) {
    const crown = div('div', 'mg-crown');
    crown.setAttribute('aria-hidden', 'true');
    model.crown.cuts.forEach((cut) => {
      const star = starSvg('held', starBox(14));
      star.classList.add('mg-crown-star');
      // Where along the ring's fill this star lights: its cut-off over the take's percent.
      star.style.setProperty('--mg-cut', String(model.ring.fraction > 0 ? Math.min(1, cut / (100 * model.ring.fraction)) : 1));
      crown.append(star);
    });
    root.append(crown);
  }

  const face = div('div', 'mg-face');
  face.setAttribute('aria-hidden', 'true');
  if (model.bloom > 0) face.append(div('div', 'mg-bloom'));
  const svg = svgEl('svg', { class: 'mg-ring', viewBox: `0 0 ${px} ${px}`, width: px, height: px });
  const sweepId = `mg-sweep-${++serial}`;
  if (model.ring.look === 'sweep' || model.ring.look === 'sweepDim') {
    const grad = svgEl('linearGradient', { id: sweepId, x1: 0, y1: 0, x2: 1, y2: 1 });
    // The stops take their colours from css/grades.css (tokens only).
    ['low', 'mid', 'high'].forEach((name, i) => grad.append(svgEl('stop', { class: `mg-stop-${name}`, offset: i / 2 })));
    const defs = svgEl('defs', {});
    defs.append(grad);
    svg.append(defs);
  }
  svg.append(svgEl('circle', { class: 'mg-track', cx: c, cy: c, r, fill: 'none', 'stroke-width': stroke }));
  if (model.ring.outer) svg.append(svgEl('circle', { class: 'mg-outer', cx: c, cy: c, r: px / 2 + 6, fill: 'none', 'stroke-width': 1 }));
  if (model.ring.look !== 'track' && model.ring.fraction > 0) {
    // pathLength 100 makes the dash numbers per cent: lit for `len`, then a gap longer than
    // the rest. Starts at 12 o'clock, clockwise.
    const len = 100 * model.ring.fraction;
    const lit = svgEl('circle', {
      class: 'mg-lit', cx: c, cy: c, r, fill: 'none', 'stroke-width': stroke, pathLength: 100,
      'stroke-dasharray': `${len} 200`, 'stroke-linecap': len >= 100 ? 'butt' : 'round', transform: `rotate(-90 ${c} ${c})`,
    });
    if (model.ring.look === 'sweep' || model.ring.look === 'sweepDim') lit.setAttribute('stroke', `url(#${sweepId})`);
    lit.style.setProperty('--mg-len', String(len));
    svg.append(lit);
  }
  face.append(svg);
  if (model.glyph === 'letter') face.append(div('span', 'mg-letter', model.glyphText));
  else if (model.glyph === 'dots') face.append(div('span', 'mg-letter mg-dots', model.glyphText));
  else if (model.glyph === 'hollowStar') {
    const star = starSvg('held', starBox(Math.max(12, Math.round((28 * px) / 96))));
    star.classList.add('mg-hollow');
    face.append(star);
  }
  root.append(face);

  if (!small) {
    const under = div('p', model.underIsPercent ? 'mg-under mg-percent' : 'mg-under', model.under);
    if (model.underTitle) under.title = model.underTitle;
    root.append(under);
    // The chip's line is kept when empty so a by-ear take is not taller than a usual one.
    const chipLine = div('p', 'mg-chip-line');
    if (model.chip) {
      const chip = div('span', 'mg-chip');
      chip.title = model.chip.title;
      chip.append(icon(model.chip.icon, 14), document.createTextNode(model.chip.text));
      chipLine.append(chip);
    }
    root.append(chipLine);
  }

  for (const old of host.querySelectorAll(':scope > .mg')) old.remove();
  host.append(root);
  return root;
}
