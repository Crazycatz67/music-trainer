// difficulty.config.js — every number and word of the song difficulty (js/app/song/difficulty.js),
// in one place. Pure: imports in Node.
//
// From Ricky's research (docs/team-log/reports/2026-10-14-ricky-song-difficulty.md) and
// Delilah's spec (docs/design/specs/2026-10-14-song-difficulty.md, sections 2 and 4).
// EVERY value marked GUESS is tuned on the 18 demo charts only, not on imported songs or the
// owner's voice. Retune here, nowhere else; the page must take its words from here too.
//
// Levels change WHICH notes are judged, never how closely: the 35 / 60 / 100 cent windows in
// grades.config.js are not read or touched by anything here.

export const DIFFICULTY = Object.freeze({
  // Per-line parts. Each part is squeezed to 0..1 by c01((x - from) / over); the line's strain
  // is the weighted sum (weights add up to 1, so a strain is 0..1 too).
  parts: Object.freeze({
    speed: Object.freeze({ weight: 0.35, from: 1, over: 3 }),           // GUESS notes per second
    leaps: Object.freeze({
      weight: 0.30,                                                      // GUESS
      // Steps of up to `freeSemis` count as no leap: a scale is not a jump.
      freeSemis: 2, meanOver: 3, meanShare: 0.6,                         // GUESS
      maxFrom: 4, maxOver: 8, maxShare: 0.4,                             // GUESS
    }),
    span: Object.freeze({ weight: 0.15, from: 4, over: 10 }),           // GUESS semitones
    breath: Object.freeze({ weight: 0.10, from: 4, over: 8 }),          // GUESS seconds per line
    held: Object.freeze({ weight: 0.05, from: 1.5, over: 3 }),          // GUESS longest note, s
    // Ricky: the key finder calls Aloha Oe C minor with 25 % out of key, probably wrongly,
    // so chromatic notes keep only a small weight.
    chroma: Object.freeze({ weight: 0.05, from: 0, over: 0.3 }),        // GUESS share of notes
  }),

  // Words for the part that dominates the hardest line (spec 3, "hardest line").
  partWords: Object.freeze({
    speed: 'fast words', leaps: 'big jumps', span: 'wide line',
    breath: 'long breath', held: 'long held notes', chroma: 'notes outside the key',
  }),

  rating: Object.freeze({
    // osu!-style: hardest lines count most. A weighted MEAN (not osu!'s sum) keeps the scale
    // steady across song lengths; the length bonus gives long songs a little back.
    decay: 0.8,                                                          // GUESS
    lengthBonus: 0.08, lengthRefLines: 8,                                // GUESS
    scale: 10,
  }),

  // Without line marks (a MIDI chart), a rest this long starts a new line. Same as
  // SONG.phrases.gapSec today; kept here so this file stays self-contained.
  lineGapSec: 0.6,                                                       // GUESS

  // Rating -> band. Bands are deliberately not Easy / Normal / Hard (spec 2.2).
  bands: Object.freeze([
    Object.freeze({ band: 1, below: 2.0, word: 'Gentle' }),              // GUESS cut-offs
    Object.freeze({ band: 2, below: 3.0, word: 'Steady' }),
    Object.freeze({ band: 3, below: 4.0, word: 'Steep' }),
    Object.freeze({ band: 4, below: Infinity, word: 'Very steep' }),
  ]),

  levels: Object.freeze({
    order: Object.freeze(['easy', 'normal', 'hard']),
    easy: Object.freeze({
      label: 'Easy',
      description: 'Long notes only, with a little more time to land each one.',
      card: 'Easy · long notes only',
      // A note is "long" at max(minSec, medianScale x the line's median note length); the
      // line's last and longest notes and golden notes are always in.
      minSec: 0.6, medianScale: 1.5,                                     // GUESS
      // Ricky's prototype without a floor judged only 28 % of Twinkle: top up per line.
      minCover: 0.5,                                                     // GUESS share of the line's singing time
      // Owner-approved (spec 4.5): Easy alone gets more timing slack. Multiplies the judge and
      // line-star lag (LS.lagSec); the cents windows are not touched.
      lagScale: 1.5,                                                     // GUESS
    }),
    normal: Object.freeze({
      label: 'Normal',
      description: 'Every note except the quick runs.',
      card: 'Normal · no quick runs',
      minSec: 0.25,                                                      // GUESS shorter = a fast run
      minCover: 0.8,                                                     // GUESS
      lagScale: 1,
    }),
    hard: Object.freeze({
      label: 'Hard',
      description: 'Every note, as the singer sings it.',
      card: 'Hard · every note',
      lagScale: 1,
    }),
    // A level is offered only if it judges at most this share of the singing time of the next
    // offered level above it (Ricky: "at least 10 % less"). Owner, 2026-10-14: when Normal is
    // almost Hard, the switch shows "Easy | Hard".
    offerMaxShare: 0.9,                                                  // GUESS
  }),

  fit: Object.freeze({
    // margin = comfort span - song span, after the app's own octave move (Ricky step 5).
    easyMargin: 7, fitsMargin: 2,                                        // GUESS semitones
    words: Object.freeze({
      easy: 'Fits your voice easily',
      fits: 'Fits your voice',
      just: 'Just fits',
      noRange: 'Find your range to see if it fits',
    }),
    // Personal rating = rating + top x semis past the top + bottom x semis past the bottom
    // + outside x share of singing time outside the comfort ends. Used only to order Next up.
    personal: Object.freeze({ top: 0.5, bottom: 0.3, outside: 1.5 }),   // GUESS
  }),

  next: Object.freeze({
    // Target = hardest song with a best of A or better at its top level + step; none yet: start.
    step: 0.4, start: 1.5,                                               // GUESS
    goodLetters: Object.freeze(['S', 'A']),
    doneLetter: 'S',
    // osu!'s rule: a song this much harder costs `upCost` x as much as one as much easier.
    upCost: 2,                                                           // GUESS
  }),
});
