// config.js — the numbers of the song engine (js/app/song/*), in one place. Pure.
//
// Kept apart from js/app/config.js because the engine was built while other branches were
// changing that file; the overseer may fold this in as CONFIG.song later.
//
// Every value marked GUESS is untested on the owner's own voice, headphones and microphone.

export const SONG = Object.freeze({
  player: Object.freeze({
    // A source is started this far ahead of "now", so the audio thread always gets it before
    // its start time and the start is on the exact sample asked for.
    leadSec: 0.03,
    // Volume and layer changes ease over this long: an instant gain step clicks.
    gainEaseSec: 0.02,
    // A loop shorter than this would buzz like a note.
    minLoopSec: 0.25,
  }),
  recorder: Object.freeze({
    // Samples the audio thread gathers before posting them to the page (about 43 ms at 48 kHz).
    chunkFrames: 2048,
    // A take ends by itself after this long, so a forgotten recording cannot fill the memory.
    maxSec: 15 * 60,
    // With a take store: the take so far is written to it this often while recording, so a
    // closed window or a crash loses at most this much (a page that is closing cannot be
    // trusted to finish a write it starts then).
    checkpointSec: 10,
  }),
  align: Object.freeze({
    // The nudge the owner can set by hand, in milliseconds. Positive = the voice plays later.
    nudge: Object.freeze({ min: -500, max: 500, step: 5 }),            // GUESS
    // Calibration: claps (or a short "ta") on each click of a click track.
    clicks: Object.freeze({ count: 8, bpm: 80, leadSec: 1.5, hz: 1000, lenSec: 0.03, gain: 0.5 }),
    // A clap counts for a click when it lands between this far before it and this far after
    // (round-trip delay through wired or built-in sound is 20 to 150 ms; Bluetooth up to 350).
    pairBeforeMs: 120,                                                   // GUESS
    pairAfterMs: 450,                                                    // GUESS
    minClaps: 5,                                                         // GUESS: of 8
    maxSpreadMs: 35,                                                     // GUESS: claps scattered wider than this are not a measurement
    // Onsets: the loudness must rise this many times over the level just before it, and reach
    // this share of the loudest moment of the take; then nothing counts for the gap after.
    onsetRise: 4,                                                        // GUESS
    onsetFloor: 0.2,                                                     // GUESS
    onsetGapMs: 250,
  }),
  mix: Object.freeze({
    balance: 0.5,            // 0 = backing only, 1 = voice only, 0.5 = both at full
  }),
  takes: Object.freeze({
    dbName: 'music-trainer.takes.v1',
    // All takes together may use this much of the browser's storage. A four-minute take at
    // 48 kHz is about 23 MB (16-bit, one channel), so this is about ten of them.
    maxBytes: 250 * 1024 * 1024,                                         // GUESS
  }),
  pipeline: Object.freeze({
    sampleRate: 44100,       // what the separation model takes; files are decoded straight to it
    // Longer files are refused: memory grows with length (measured: about 800 MB at the peak
    // for a 2 min 39 s song).
    maxSec: 12 * 60,                                                     // GUESS
    // Under this much singing in the whole file there is nothing to follow.
    minSingingSec: 3,                                                    // GUESS
    // Seconds of work per second of song, for the first estimate. WebGPU: measured on the
    // owner's Mac (27 s for 159 s). WebAssembly: not measured, only known to be "minutes".
    estimate: Object.freeze({ webgpu: 0.17, wasm: 3 }),                  // wasm: GUESS
  }),
  phrases: Object.freeze({
    // (song-mode spec 5.3) A breath under gapSec does not end a phrase; a phrase is at least
    // minSec long (a shorter one joins a neighbour within joinSec, or is dropped).
    gapSec: 0.6,                                                         // GUESS
    minSec: 0.5,                                                         // GUESS
    joinSec: 1,                                                          // GUESS
    // A gap this long is a "Rest"; shorter is a breath and changes nothing on the screen.
    // Was 2: on the owner's real songs the prompt then changed at every short gap ("keeps
    // shifting around too much and changing too fast", 2026-10-13). 5 = the owner's "about 5 s".
    restSec: 5,                                                          // GUESS
    // beadTimes: count-in beads (and the chart songs' count-in clicks, chartsong.js) come
    // before a gap this long. It keeps the 2 s restSec had, so the click track of a chart
    // song is as it was; the Sing page's stage passes restSec instead (singnow.js).
    beadGapSec: 2,
    readySec: 3,             // "Get ready" for the last seconds of a rest; also the count-in
  }),
  // The counts the owner asked for (2026-10-13: "a timer like 3 seconds before you start
  // singing"). All three are first guesses, untried on the owner.
  countIn: Object.freeze({
    // Sing, Carry on singing and Record a take: the microphone opens on the press, then
    // this many seconds are counted (3, 2, 1) before the song moves. 0 = no count.
    startSec: 3,                                                         // GUESS
    // While the song runs: the last seconds before a phrase are counted ("Sing in 3, 2, 1")
    // when the intro or the rest before it is at least minGapSec long. A shorter gap is a
    // breath and gets no count.
    phraseSec: 3,                                                        // GUESS
    // Was 2: a count before every short rest was the "flashing and distracting" part
    // (owner 2026-10-13). A rest from phrases.restSec up to this gets "Rest" and "Get
    // ready" in the prompt, and no count.
    minGapSec: 6,                                                        // GUESS
  }),
  // The prompt box over the stage ("Your turn", "Rest", "Get ready") and the count card.
  prompt: Object.freeze({
    // While the song runs neither changes its words or its number twice within this long.
    // A press (Sing, Pause, a jump the owner asked for) still shows at once.
    holdMs: 1000,
    // New words ease in over this long; the colours ease in the stylesheet.
    easeMs: 240,
  }),
  // The sliders of the sing page. Levels are 0..1 (shown as 0 to 100).
  levels: Object.freeze({
    volume: 1,               // everything together
    music: 1,                // the backing track alone
    guide: 0.25,             // the singer's own voice under the backing ("Quiet")   GUESS
    // Music, Singer and Volume are kept for each song (owner 2026-10-13); the oldest
    // song's are dropped past this many.
    keptSongs: 300,
    keyStep: 0.05,           // the [ and ] keys; the arrow keys on a slider move it by 0.01
    // Quick marks: places the slider shows a tick at (and, for Balance, a button for).
    guideMarks: Object.freeze([0, 0.25, 0.5, 1]),
    balanceMarks: Object.freeze([0, 0.5, 1]),
  }),
  songs: Object.freeze({
    dbName: 'music-trainer.songs.v2',
    // Stored sound: the backing as it came out (stereo, 16-bit); the separated singer as a
    // guide only (one channel, half the rate). About 13.3 MB a minute together.
    vocalRate: 22050,
    demoFiles: Object.freeze(['aloha-oe', 'alouette', 'amazing-grace', 'auld-lang-syne', 'brahms-lullaby',
      'drunken-sailor', 'gaudeamus-igitur', 'happy-birthday', 'hava-nagila', 'home-sweet-home',
      'joy-to-the-world', 'my-bonnie', 'ode-to-joy', 'pokarekare-ana', 'red-river-valley',
      'skye-boat-song', 'the-first-noel', 'twinkle-twinkle']),
  }),
  words: Object.freeze({
    lookupBase: 'https://lrclib.net',
    client: 'music-trainer (local singing practice tool)',
    lookupTimeoutMs: 8000,
    // "Look up words automatically" (Settings on the Sing page) starts like this. Owner
    // decision 2026-10-13: on. Off = nothing is asked until the press in the Words sheet.
    autoLookup: true,
    lookupMaxResults: 5,
    // A line longer than this is shown as two (words.js splitLongLines): the words band
    // holds two rows of 22 px, about 170 letters, and cuts what is over (design review
    // 2026-10-13, finding 10).
    splitOverLetters: 170,
    // fitOffset (song-mode spec section 9): how far a looked-up line may sit from the start
    // of a sung stretch and still count, how far all lines may be shifted, and when the
    // words are said not to line up.
    fitTolSec: 0.5,                                                      // GUESS
    fitMaxShiftSec: 5,                                                   // GUESS
    fitStepSec: 0.02,
    fitMinLines: 4,
    fitMinShare: 0.6,                                                    // GUESS
    // Looked-up words with fewer timed lines than this share of the sung phrases (4 lines
    // for 14 phrases) are another version or a fragment, however well those few sit.
    fitMinCountRatio: 0.5,                                               // GUESS
    fitMaxLengthDiffSec: 15,
    fitMaxDrift: 0.006,      // seconds of slip per second of song: more is another speed  GUESS
    tapReactionSec: 0.15,    // a tap comes this long after the ear heard the line start  GUESS
    tapSnapSec: 0.4,         // a tap this near a phrase start is moved onto it
    tapMinGapSec: 0.15,      // two taps closer than this are one tap (a bouncing key)
    lineGapSec: 0.05,        // a nudged line keeps at least this far from its neighbours
    maxLineSec: 12,          // a last line with no phrase under it is shown for this long
    // The words band: the next line is lit this long before it starts (the lead-in cue),
    // and the marker under a line eases in and out over markerFadeSec, so its return to
    // the left for the next line is never seen.
    cueSec: 1,                                                           // GUESS
    markerFadeSec: 0.25,                                                 // GUESS
  }),
  transport: Object.freeze({
    skipSec: 5,
    fineSkipSec: 1,
    // "Previous line" within this long of a line's start goes to the line before; later, to
    // this line's start (the music-player habit).
    prevGraceSec: 2,
    // A take from a chosen line starts this long before it, so the singer hears the way in.
    takeLeadSec: 3,
  }),
  // The aurora curtain under the owner's voice line on the song stage
  // (docs/design/specs/2026-10-13-sing-page-sky.md section 1). The curtain itself is
  // js/app/aurora.js with CONFIG.aurora; these are the Sing page's own numbers.
  skyStage: Object.freeze({
    xMinPx: 40,              // keeps the light off the note names at the left     GUESS
    capFrac: 0.45,           // a loud note never fills more of the stage than this GUESS
    lineWidthPx: 3,          // the voice line in the verdict colour ...            GUESS (by eye)
    lineAlpha: 0.95,
    coreWidthPx: 1.25,       // ... and its centre in --voice-core                  GUESS (by eye)
    coreAlpha: 0.9,
    lineFullMs: 2000,        // the line is whole for this long, gone by lineEndMs (VIEW.trailSec)
    lineEndMs: 4000,
    glowPx: 48,              // the soft round light under the head                 GUESS (by eye)
    glowAlpha: 0.5,          //                                                     GUESS (by eye)
    reviewHeadAlpha: 0.7,    // the head over a recorded line (song-mode 8.2)
    switchFadeMs: 600,       // the Settings switch eases the light away (the guard's own fade)
    // The curtain on a SONG (Delilah, review 2026-10-13; seen in a scratch copy of the page,
    // NOT read by singnow.js until its curtain is made as
    // createCurtain({ ...CONFIG.aurora, ...SONG.skyStage.curtain })). The exercises' numbers
    // suit one long held note: a note the voice has left loses its light in 1 s and a new one
    // takes 360 ms to grow. A song changes note about twice a second, so there the curtain
    // was always being born or dying: thin, dim rays. Here a sung note keeps its light for
    // the whole trail, the trail is longer, and a quiet voice still gives a full curtain.
    // No extra work per column; columns drawn 74 -> about 83 in the lab's song (curtain 0.2 ms).
    curtain: Object.freeze({
      endFadeMs: 3500,       // CONFIG.aurora 1000: the light stays until the trail takes it
      birthMs: 200,          // 360
      trailFullMs: 1800,     // 1200
      trailEndMs: 3500,      // 2500 (the voice line itself is gone by lineEndMs, 4000)
      alphaBase: 0.85,       // 0.7
      heightMinPx: 56,       // 44
    }),
  }),
  // Line stars, the end panel, the shooting star and the end chime (the same spec,
  // section 2). Every number marked GUESS is unmeasured: tune after the first real take.
  lineStars: Object.freeze({
    minReadings: 8,          // fewer readings in the singer's sung time: "Not sung"  GUESS
    minSungShare: 0.2,       // the owner had a pitch in under this share: "Not sung" GUESS
    withShare: 0.7,          // of the pitched readings on target: "With the singer"  GUESS
    withSungShare: 0.4,      // ... and pitched in at least this share (two lucky notes earn nothing) GUESS
    closeShare: 0.4,         // "Close" (owner 2026-10-13: it earns a small hollow star) GUESS
    lagSec: 0.1,             // the singer's note a moment before and after counts too GUESS
    settleSec: 0.1,          // a line is settled this long after its end
    nearEndSec: 0.25,        // readings this near a line's end count as sung through (a loop, the song's end) GUESS
    fly: false,              // no flying star while the microphone is judged (slice D, gated)
    starPx: Object.freeze({ with: 14, close: 10 }),
    smallStarPx: Object.freeze({ with: 8, close: 6 }),
    crowdPx: 16,             // under this much track per line the stars are the small ones
    popPx: 34,               // the star that lands beside the words (the drawing has a wide margin: about 20 px of star; css .sn-line-pop is the same box)
    popInMs: 320, popHoldMs: 900, popOutMs: 320,                          // hold: GUESS
    calmFadeMs: 200,
    lowHighCents: 15,        // "mostly a little low / high"                          GUESS
    lateSec: 0.4,            // "the start came late"                                 GUESS
    minLinesForPanel: 3,     // fewer sung lines: "Too short for line stars"
    minBest: 3,              // a new best needs at least this many lines with the singer
    wordsMaxLetters: 28,
    streakMs: 1600, tailMs: 600, streakInMs: 180, streakLenPx: 290,
    shower: 3,               // a new best: this many shooting stars (owner 2026-10-13) ...
    showerGapMs: 250,        // ... this far apart                                    GUESS
    swellMs: 320, swellStepMs: 60, swellSpanMs: 1200,
    chimeLoMidi: 67,         // the end chime sits in G4 to F#5                       GUESS
    chimeHiMidi: 78,
  }),
});
