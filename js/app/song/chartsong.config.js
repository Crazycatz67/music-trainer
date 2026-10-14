// chartsong.config.js — the numbers of chartsong.js (a note chart standing in for a dropped
// song). Pure. Kept apart from js/app/song/config.js because that file was being changed by
// another job while this was built; the overseer may fold it in as SONG.chart later.
//
// EVERY value marked GUESS is unheard and unsung: nothing here has been played through the
// owner's headphones or sung against. Tune after the first real demo song.

export const CHART = Object.freeze({
  curve: Object.freeze({
    // Seconds between frames of the target line built from the notes. The analysis of a
    // dropped song gives 0.016 s (SwiftF0) or 0.01 s (the fallback); a chart's notes are
    // flat, so nothing finer is needed. A step between two touching notes is drawn over
    // one hop.
    hopSec: 0.01,                                                        // GUESS
    // The loudness written into every sung frame (a dropped song has the singer's real
    // loudness, about 0.05 to 0.3). A chart has no loudness: one steady value.
    level: 0.2,                                                          // GUESS
  }),
  phrases: Object.freeze({
    // A chart's own line breaks start a phrase. Inside one line, a rest at least this long
    // starts a new phrase too: a line that holds two sung stretches with a long wait
    // between them would otherwise show "Your turn" through the wait.
    restSec: 2,                                                          // GUESS (SONG.phrases.restSec: the lamp's own "Rest")
  }),
  // The song is this much longer than its last note, so the last note's ring and the last
  // line's result are not cut off by the end of the track.
  tailSec: 1.5,                                                          // GUESS
  // Octaves the page may move a chart by (the song store keeps -1, 0 or 1).
  maxOctaves: 1,
  // Speeds a chart may be played at: 1 = as written, 0.5 = half speed.
  tempo: Object.freeze({ min: 0.5, max: 1.5 }),                          // GUESS
  guide: Object.freeze({
    // The guide voice: one tone a note, in the synth's 'voice' timbre.
    timbre: 'voice',
    gain: 0.3,                                                           // GUESS
    // A note is sounded for this share of its length, so two notes on the same pitch are
    // heard as two.
    lengthShare: 0.94,                                                   // GUESS
    attackSec: 0.03,                                                     // GUESS
    releaseSec: 0.06,                                                    // GUESS
  }),
  backing: Object.freeze({
    // A soft drone under each phrase: the key's home note and the fifth above it, found
    // from the notes (chartsong.js keyOf). It gives the ear a floor to tune against; it
    // is not an accompaniment.
    timbre: 'sine',
    rootGain: 0.07,                                                      // GUESS
    fifthGain: 0.045,                                                    // GUESS
    fifthSemis: 7,
    // The drone starts this long before its phrase (never before the phrase before ends),
    // so the home note is in the ear before the first word.
    leadSec: 1.5,                                                        // GUESS
    attackSec: 0.4,                                                      // GUESS
    releaseSec: 0.5,                                                     // GUESS
    // The drone's home note is the highest one at least this far under the song's lowest
    // note, and never under floorMidi (a laptop's speakers and small earphones lose it).
    underSemis: 5,                                                       // GUESS
    floorMidi: 43,                                                       // GUESS (G2, 98 Hz)
  }),
  clicks: Object.freeze({
    // The count before a phrase, heard: one click on each second the screen counts
    // (phrases.js beadTimes: 3, 2, 1 seconds before the phrase, after an intro or a rest).
    hz: 1000,
    lenSec: 0.03,
    gain: 0.25,                                                          // GUESS
  }),
  // Key finding (Krumhansl and Kessler's probe-tone profiles, 1982): how well the time
  // spent on each of the 12 notes matches a major and a minor key on each of them.
  key: Object.freeze({
    major: Object.freeze([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
    minor: Object.freeze([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
    // Fewer different notes than this say nothing about a key: the home note is then the
    // song's last note.
    minPitchClasses: 3,                                                  // GUESS
  }),
});
