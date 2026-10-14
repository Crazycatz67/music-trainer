// grades.config.js — every number of the song grades (js/app/song/grades.js), in one place.
// Pure: imports in Node.
//
// Kept apart from js/app/song/config.js because the Sing page files were being tested when
// this was written; the overseer may fold it in as SONG.grades later.
//
// EVERY value marked GUESS is untested on the owner's voice. The owner's decision (2026-10-13)
// is that the cut-offs are tuned on the first real takes: change them here, nowhere else.
// Cents are 100 x (sung - target) after the octave fold; accuracy and shares are per cent.

export const GRADES = Object.freeze({
  storageKey: 'music-trainer.grades.v1',

  judge: Object.freeze({
    // A reading this near the target (octave folded) earns these points; farther is a miss.
    // Nearest first. `id` names the count in judge.counts().
    // Owner, 2026-10-14: "it cant be too harsh ... there needs to be some give on the
    // scoring". So the windows are wider than osu!'s and the points fall in thirds (full,
    // two thirds, one third) instead of 1, 1/3, 1/6 (was 25 / 50 / 100 cents at 300 / 100 / 50).
    windows: Object.freeze([
      Object.freeze({ id: 'great', cents: 35, points: 300 }),            // GUESS
      Object.freeze({ id: 'good', cents: 60, points: 200 }),             // GUESS
      Object.freeze({ id: 'ok', cents: 100, points: 100 }),              // GUESS
    ]),
    // A reading under this clarity is noise or breath and is not judged at all. The same
    // number as the detector's own gate (js/pitch.js clarityMin), so today it changes
    // nothing; raise it if breathy readings turn out to cost points.
    minClarity: 0.85,                                                    // GUESS
    // Fewer judged readings than this is not a take to grade (about 2 s of singing at the
    // microphone's 47 readings a second).
    minJudged: 100,                                                      // GUESS
    // The least part of the song's sung time the singer must have sung before any letter is
    // given: a FRACTION, 0..1 (0.5 = half). Under it the state is 'sangTooLittle'. Without
    // it, three good lines and silence for the rest would earn a letter (silence is never
    // judged, so it never costs accuracy).
    minSongShare: 0.5,                                                   // GUESS
    // The gold letters mean most of the song (overseer's decision, 2026-10-13, spec 18.6):
    // a letter marked `topShare` below also needs this FRACTION of the song's sung time to
    // have been sung. Under it the best letter is the first one without the mark (A), and
    // gradeOf says heldBack 'song'. Like minSongShare it is applied only when the page
    // passes the two sung-time numbers (the exercises do not).
    topSongShare: 0.9,                                                   // GUESS
    // judgeFrames also tries the song's note this long before and after each reading and
    // keeps the nearest (people land a hair late). null = the line stars' own number
    // (SONG.lineStars.lagSec), so the stars and the letter cannot drift apart.
    lagSec: null,
  }),

  // Best first. `min` is accuracy in per cent, reached or passed. `noLowestLine`: refused
  // while any line of the take is at lines.lowest (the take then gets the next letter it
  // does qualify for). SS and S both carry it (decided 2026-10-13): a take with a line still
  // being found is at most an A. Under the last entry there is NO letter: the state is
  // 'finding'. `topShare`: also refused while under judge.topSongShare of the song was sung.
  letters: Object.freeze([
    Object.freeze({ letter: 'SS', min: 95, noLowestLine: true, topShare: true }),    // GUESS
    // Owner, 2026-10-14: "s is 90 plus and 95 plus is ss" (was 85).
    Object.freeze({ letter: 'S', min: 90, noLowestLine: true, topShare: true }),     // GUESS
    Object.freeze({ letter: 'A', min: 70, noLowestLine: false, topShare: false }),   // GUESS
    Object.freeze({ letter: 'B', min: 55, noLowestLine: false, topShare: false }),   // GUESS
    Object.freeze({ letter: 'C', min: 40, noLowestLine: false, topShare: false }),   // GUESS
  ]),

  lines: Object.freeze({
    // The line levels exactly as js/app/song/lineresults.js names them (lineResult(), keys
    // of LEVEL_RANK), best first; grades.check.mjs compares the two.
    levels: Object.freeze(['with', 'close', 'finding']),
    lowest: 'finding',
    combo: 'with',           // a run of lines at this level is the combo
    unsung: 'none',          // a line that was not sung: no part in the combo or the sung time
  }),

  // The ways a take can be sung. `silver`: the grade is shown in silver. None of them changes
  // the points. The order here is the order in a personal best's key.
  mods: Object.freeze({
    noLine: Object.freeze({ silver: true }),
    slower: Object.freeze({ silver: false }),
    keyDown: Object.freeze({ silver: false }),
    noGuide: Object.freeze({ silver: false }),
  }),

  histogram: Object.freeze({
    binCents: 10,                                                        // GUESS
    rangeCents: 100,         // bins run from -rangeCents to +rangeCents, plus one each side  GUESS
    onCents: 35,             // "on the note" for the low / on / high shares: the In tune window  GUESS
  }),

  steadiness: Object.freeze({
    // A held note, read from the singer's own pitch: readings in a row that stay this near
    // the note's running average, with no hole longer than maxGapSec.
    splitCents: 150,                                                     // GUESS
    maxGapSec: 0.08,                                                     // GUESS
    minHoldSec: 0.4,         // shorter than this is not a held note      GUESS
    // The held-note word on the results layer (spec 3.3): wobble under veryCents "very
    // steady", under steadyCents "steady", else "wavering". steadyCents is coach.js
    // thresholds.wobbleCents, where its own tip starts (resultsmodel.check compares them).
    veryCents: 10,                                                       // GUESS
    steadyCents: 20,                                                     // GUESS
    minNotes: 3,             // fewer held notes: no word                 GUESS
  }),

  // The coach's one line after a take (js/app/song/advice.js, spec 5.6).
  advice: Object.freeze({
    // The same two numbers as SONG.lineStars (advice.check compares them): a line card and
    // the coach's line must not disagree about "a little low" or "late".
    lowHighCents: 15,        // the middle this far off: "a little low / high"   GUESS
    lateSec: 0.4,            // a line started this late                         GUESS
    lowCents: 25,            // from here the words drop "a little"              GUESS
    unsungShare: 1 / 3,      // this share of the lines the run passed, unsung   GUESS
    lateShare: 1 / 3,        // this share of the sung lines, late               GUESS
    wideHalfCents: 50,       // half the middle spread over this: "either side of the tune"  GUESS
    wobbleCents: 20,         // held notes waver from here (coach.js wobbleCents)            GUESS
    minHeldNotes: 3,                                                     // GUESS
  }),

  // The results screens' own small numbers (js/app/song/resultsmodel.js).
  results: Object.freeze({
    onNoteCents: 5,          // a middle this near 0 reads "on the note"         GUESS
    nearPoints: 5,           // the panel says "2 % from A" only this near       GUESS
    minRunLines: 3,          // "Longest run" is shown from this many lines      GUESS
    minExerciseNotes: 3,     // an exercise round with fewer notes gets no letter
    takeRows: 5,             // rows of "Your takes of this song" before "Show all"  GUESS
  }),

  nudge: Object.freeze({
    retries: 5,              // owner's decision: a rest is suggested after this many retries in a row
    // Then again every this many more, so it is not said after every take.
    repeatEvery: 5,                                                      // GUESS
    // A pause this long between the end of one take and the start of the next is a rest.
    restGapSec: 120,                                                     // GUESS
    // A song retry and a line retry of the same song are ONE run of retries (spec 18.5): the
    // voice does not rest when the line changes.
    // Only takes started within this long of the newest one count as "in a row".
    windowSec: 30 * 60,                                                  // GUESS
  }),
});
