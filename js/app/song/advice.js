// advice.js — the coach's one line after a sung take: one thing that was heard and one
// thing to do on the next go (docs/design/specs/2026-10-13-grades-and-results.md 5.6).
// Pure: imports in Node (tools/checks/advice.check.mjs), no DOM, no storage.
//
// Why its own file: grades.js holds fixed sentences per result; this is a CHOICE between
// measurements and its wording will move. A sentence is never saved with a take (old takes
// would keep old words): the line is worked out when the run ends and again when a take
// is opened.
//
// CONTRACT
//   adviceFor({ grade, hist, steady, saved, mods, rest, ways }, config = GRADES)
//       -> { id, said, next, text, icon }
//     grade   grades.js gradeOf(...)         state, letter, heldBack, nextLetter
//     hist    grades.js histogram(cents)     median (cents, negative = low), q1, q3
//     steady  grades.js steadiness(frames)   wobble (cents), notes
//     saved   lineresults.js summarise(...)  results[].level and results[].late (seconds)
//     mods    the take's ways                noLine
//     rest    grades.js retryNudge(history)  a boolean
//     ways    the page: { noLine: boolean }, true when "By ear" can be chosen in this build
//             (never name a control that is not there)
//     text is "{said} Next go: {next}". icon is 'moon' for the rest line, else 'wave'
//     (names of js/app/shell.js icons).
//   ONE thing only: the first row of ADVICE_ORDER that matches, nothing appended.
//   Never throws. A rule whose input is absent is skipped. With no grade at all it never
//   says "nothing to fix": it answers the tooShort row.
//   ADVICE_ORDER: the ids, first match first.   ADVICE_WORDS: { [id]: { said, next } }, the
//   words as written (low / high / heldBack carry {n}, {nextLetter}; see the variants there).
//
// ONE ADDITION TO THE SPEC'S TABLE (no new sentence): the `unsung` row also answers a take
// whose gold letter is held back by the unsung part of the song (grade.heldBack 'song',
// from judge.topSongShare, decided after 5.6 was written). Without it a 96 % A would be
// told "Nothing to fix in that one."

import { GRADES } from './grades.config.js';

export const ADVICE_ORDER = Object.freeze([
  'rest', 'tooShort', 'heldBack', 'low', 'high', 'unsung', 'late', 'scattered', 'wavering', 'tune', 'nearly',
  'cleanByEar', 'clean', 'cleanPlain',
]);

export const ADVICE_WORDS = Object.freeze({
  rest: Object.freeze({ said: 'That is a lot of goes in a row.', next: 'rest your voice for a minute, with a sip of water.' }),
  tooShort: Object.freeze({ said: 'That was a short one.', next: 'sing a few more lines and the coach can say more.' }),
  heldBack: Object.freeze({ said: 'Your percent is enough for {nextLetter}, but a line is still being found.', next: 'retry the line to practise (L).' }),
  low: Object.freeze({
    said: 'You sang a little low: {n} cents under, in the middle.', saidFar: 'You sang low: {n} cents under, in the middle.',
    next: 'aim for the top edge of the ribbon.',
  }),
  high: Object.freeze({
    said: 'You sang a little high: {n} cents over, in the middle.', saidFar: 'You sang high: {n} cents over, in the middle.',
    next: 'aim for the bottom edge of the ribbon.',
  }),
  unsung: Object.freeze({
    said: 'Some lines went by without you.', saidPart: 'That was part of the song.',
    next: 'sing it through once quietly, just to stay with it.',
  }),
  late: Object.freeze({ said: 'Several lines started late.', next: 'breathe in on the last count bead before each line.' }),
  scattered: Object.freeze({ said: 'Your notes landed either side of the tune.', next: 'turn the singer\'s voice up and copy the first note of each line.' }),
  wavering: Object.freeze({ said: 'Your long notes wavered.', next: 'breathe out slowly and evenly through each long note.' }),
  tune: Object.freeze({ said: 'The tune is not in your ear yet.', next: 'listen to the song once without singing (Listen), then try again.' }),
  nearly: Object.freeze({ said: 'You were close to the tune most of the time.', next: 'put the line to practise on repeat (L) until its star lands.' }),
  cleanByEar: Object.freeze({ said: 'Nothing to fix, and that was by ear.', next: 'enjoy it and sing it again.' }),
  clean: Object.freeze({ said: 'Nothing to fix in that one.', next: 'try it by ear (Ways to sing).' }),
  cleanPlain: Object.freeze({ said: 'Nothing to fix in that one.', next: 'enjoy it and sing it again.' }),
});

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// "A third or more": compared as counts so that 1 of 3 is a third whatever the rounding.
const shareReached = (part, whole, share) => whole > 0 && part + 1e-9 >= share * whole;

// Each rule answers the `said` sentence to use, or null when it does not apply (or its
// input is absent). Kept as a table so the order is ADVICE_ORDER and nothing else.
function rules({ grade, hist, steady, saved, mods, rest, ways }, A) {
  const g = grade && typeof grade === 'object' ? grade : null;
  const median = hist ? num(hist.median) : null;
  const results = saved && Array.isArray(saved.results) ? saved.results.filter((r) => r && typeof r === 'object') : [];
  const sung = results.filter((r) => r.level && r.level !== 'none');
  const W = ADVICE_WORDS;
  const off = (words, n) => (n >= A.lowCents ? words.saidFar : words.said).replace('{n}', String(Math.round(n)));
  return {
    rest: () => (rest === true ? W.rest.said : null),
    tooShort: () => (g && g.state === 'tooShort' ? W.tooShort.said : null),
    heldBack: () => (g && g.heldBack === 'line' && g.nextLetter ? W.heldBack.said.replace('{nextLetter}', String(g.nextLetter)) : null),
    low: () => (median !== null && median <= -A.lowHighCents ? off(W.low, -median) : null),
    high: () => (median !== null && median >= A.lowHighCents ? off(W.high, median) : null),
    unsung: () => {
      if (g && g.state === 'sangTooLittle') return W.unsung.saidPart;
      if (g && g.heldBack === 'song') return W.unsung.said;
      return shareReached(results.length - sung.length, results.length, A.unsungShare) ? W.unsung.said : null;
    },
    late: () => (shareReached(sung.filter((r) => num(r.late) !== null && r.late > A.lateSec).length, sung.length, A.lateShare) ? W.late.said : null),
    scattered: () => {
      const q1 = hist ? num(hist.q1) : null, q3 = hist ? num(hist.q3) : null;
      return q1 !== null && q3 !== null && (q3 - q1) / 2 > A.wideHalfCents ? W.scattered.said : null;
    },
    wavering: () => (steady && num(steady.wobble) !== null && steady.wobble >= A.wobbleCents && num(steady.notes) >= A.minHeldNotes ? W.wavering.said : null),
    tune: () => (g && (g.letter === 'C' || g.state === 'finding') ? W.tune.said : null),
    nearly: () => (g && g.letter === 'B' ? W.nearly.said : null),
    // "Nothing to fix" is a claim about a judged take: with no letter there is none to make.
    cleanByEar: () => (g && g.letter && mods && mods.noLine ? W.cleanByEar.said : null),
    clean: () => (g && g.letter && ways && ways.noLine === true ? W.clean.said : null),
    cleanPlain: () => (g && g.letter ? W.cleanPlain.said : null),
  };
}

const line = (id, said) => {
  const next = ADVICE_WORDS[id].next;
  return { id, said, next, text: `${said} Next go: ${next}`, icon: id === 'rest' ? 'moon' : 'wave' };
};

export function adviceFor(input, config = GRADES) {
  try {
    const A = (config && config.advice) || GRADES.advice;
    const table = rules(input && typeof input === 'object' ? input : {}, A);
    for (const id of ADVICE_ORDER) {
      const said = table[id]();
      if (said) return line(id, said);
    }
  } catch { /* a damaged take must still get a line: the short one below */ }
  return line('tooShort', ADVICE_WORDS.tooShort.said);
}
