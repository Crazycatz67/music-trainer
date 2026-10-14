// autowords.config.js — the numbers of the automatic words lookup (tags.js, autowords.js).
// Pure.
//
// Kept apart from config.js because that file was being edited by another builder while this
// was written; the overseer may fold it in as SONG.autoWords later.
//
// Every value marked GUESS is untested on the owner's own files.

export const AUTOWORDS = Object.freeze({
  tags: Object.freeze({
    // A v2.3 tag that is unsynchronised as a whole must be held in memory to be read. Over
    // this it is left unread (such tags are rare, and one this big is nearly all picture).
    maxTagBytes: 8 * 1024 * 1024,                                        // GUESS
    // A title or a song's words larger than this is not text any more.
    maxFrameBytes: 1024 * 1024,                                          // GUESS
    // Stop walking a tag that never ends (a damaged size field).
    maxFrames: 2000,                                                     // GUESS
    maxBoxes: 5000,                                                      // GUESS
    maxSyncedPieces: 20000,                                              // GUESS
  }),
  search: Object.freeze({
    // LRCLIB's search answers with at most 20 records; every one of them is tried.
    maxResults: 20,                                                      // GUESS
    timeoutMs: 8000,                                                     // GUESS (the same as the lookup the owner presses)
    // "Come back later" (503, or 429): asked once more, after as long as the answer says.
    retryStatuses: Object.freeze([503, 429]),
    retryDefaultMs: 2000,                                                // GUESS: when the answer names no wait
    // An answer that asks for a longer wait than this is not waited for: the song opens
    // without words and the next opening asks again.
    retryMaxMs: 15000,                                                   // GUESS
  }),
  pick: Object.freeze({
    // Of two sets of words that both fit: the one whose share of matched lines stands
    // further above what a wrong shift reaches. Closer than this and the nearer length wins.
    tieMargin: 0.05,                                                     // GUESS
  }),
  byLine: Object.freeze({
    minLines: 4,                                                         // GUESS: fewer lines or phrases is not tried
    // Lines per sung phrase outside this band is another version, not a breath apart.
    minCountRatio: 0.4,                                                  // GUESS
    maxCountRatio: 2.5,                                                  // GUESS
    // One phrase may hold this many lines, one line may run over this many phrases.
    maxLinesPerPhrase: 3,                                                // GUESS
    maxPhrasesPerLine: 3,                                                // GUESS
    // Costs, all in the same unit: 1 = "a line twice as long as its phrase says".
    groupCost: 0.35,         // each extra line in a phrase, or phrase under a line      GUESS
    skipPhraseCost: 0.9,     // a sung phrase with no line (a hum, a chorus sung once more)  GUESS
    skipLineCost: 1.4,       // a line nobody sings                                      GUESS
    sizeCap: 1.5,            // a length mismatch never costs more than this             GUESS
    // Lines with times of their own: their gaps say more than their lengths do.
    timedSizeWeight: 0.3,                                                // GUESS
    // Timed lines: the gap to the next line against the gap to the next phrase. Within
    // gapTolSec costs nothing much; a break in the pattern costs at most gapCap.
    gapTolSec: 1,                                                        // GUESS
    gapCap: 1.5,                                                         // GUESS
    // A rest this long between two phrases is taken for the end of a section; words may
    // be left off or picked up there for nothing, in the middle of a section for cutCost.
    sectionGapSec: 2,                                                    // GUESS
    cutCost: 0.6,                                                        // GUESS
    // A line is "settled" when moving it to any other phrase costs at least this much more.
    stableMargin: 0.15,                                                  // GUESS
    // How much the unsettled lines count against the fit. Not all of it: two times a
    // chorus is sung are a toss-up for its lines, and either is right.
    stableWeight: 0.5,                                                   // GUESS
    // Under this the fit is not used. confidence = placed share
    // x (1 - stableWeight x unsettled share) / (1 + mean cost per line).
    // Set from made-up songs only (300 runs each, phrase starts shaken by 0.2 s): right
    // fits of timed words scored 0.66 and up (0.66 = a chorus sung once more), another
    // song's timed words 0.60 and under.
    minConfidence: 0.63,                                                 // GUESS
    // Words with no times of their own have only line lengths to go by, and a wrong fit
    // can look good: on the same made-up songs wrong fits reached 0.77 (another song,
    // an extra chorus) and 0.88 (one phrase missed), right ones began at 0.78. So the bar
    // is high, and on real singing (held notes, runs) most untimed words will be refused.
    minConfidenceUntimed: 0.85,                                          // GUESS
    // How many of the looked-up records are tried line by line when none fits by one shift.
    maxTries: 3,                                                         // GUESS
  }),
  cache: Object.freeze({
    // The browser key under which the "asked, nothing found" list is kept (titles asked, no words).
    storageKey: 'music-trainer.autowords.none.v1',
    maxNone: 500,                                                        // GUESS
  }),
});
