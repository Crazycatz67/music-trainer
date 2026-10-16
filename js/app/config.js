// config.js — every tunable number the screens use, in one place. Pure: imports in Node.
//
// CONTRACT
//   CONFIG             frozen tree of thresholds, grouped by the module that reads them.
//                      Units are in the key name: Cents, Ms, Sec, Px, Rms and Peak (0..1, as
//                      js/mic.js onLevel reports them), Frac (0..1 of a length).
//   SETTINGS_DEFAULTS  what the Settings sheet starts from (saved per browser by shell.js).
//
// Where a value comes from the design spec (docs/design/specs/2026-10-12-singing-trainer.md
// or docs/design/STYLE.md) the section is named. Values marked GUESS were chosen on
// synthesised signals only and must be re-measured on the owner's voice and microphone
// before anyone trusts the behaviour they gate.

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const CONFIG = deepFreeze({
  // STYLE.md section 3.
  verdict: {
    inTuneCents: 25,
    closeCents: 50,
    // A new verdict must hold this long, and be this far past the line, before it shows:
    // without both, a voice resting on a boundary makes the chip and line colour flicker.
    holdMs: 120,
    marginCents: 5,
    onNoteCents: 5,          // spec 5.3: "On the note" within this
    // Spec 5.2 and 5.3 (review 1): further than this from the target a point is drawn
    // "off" at once, whatever the hold says, and the words count in notes, not cents.
    farCents: 100,
  },

  // Spec 5.1 and 5.2.
  stage: {
    gutterPx: 52,
    lanesNormal: 14,
    lanesWideMax: 36,
    widePadSemis: 3,
    pxPerSecExercise: 120,
    pxPerSecSong: 160,
    nowFracFree: 0.7,
    nowFracTarget: 0.35,
    minWidthPx: 480,
    minHeightPx: 300,
    dprCap: 2,
    recentreStepMs: 320,
    // The spec allows up to 12. Measured in labs/stage-lab.html: at 12 the target band and
    // line slide out of a 48 px cell inside 120 ms on a leap, which the flash number reads
    // as a 0.21 brightness change on Dawn (0.18 Dusk). At 6 the same slide is calmer.
    recentreMaxSemisPerSec: 6,
    actionBandFrac: 0.6,     // the voice should stay in the middle 60 % of the height
    freeCentreWindowSec: 2,
    dotRunSec: 0.06,         // a voiced run shorter than this is a dot, not a line
    // Two readings further apart than this are not joined even if both are voiced: frames
    // were dropped in between (hidden tab, stall) and the pitch there is unknown.
    maxJoinGapSec: 0.12,
    // Spec 5.2 (review 1): two neighbouring readings further apart than this are a leap
    // (or an octave slip of the detector). The piece between them is a thin quiet
    // connector, never a verdict-coloured line: nobody sang the notes in between.
    leapSemis: 3,
    leapWidthPx: 1.5,
    leapOpacity: 0.35,
    fadeOldestFrac: 0.2,
    fadeMinOpacity: 0.35,
    colourBlendMs: 80,
    silentFadeMs: 600,
    markFadeMs: 200,         // the head tag and the out-of-view chip ease in and out
    silentOpacity: 0.4,
    chevronEveryPx: 56,
    laneTintOpacity: 0.06,
    starCount: 40,
    starSeed: 20261012,
    // grid: 'quiet' (Find your range): the C lines and names at these shares of their usual
    // strength, and this many times the stars. Review 4, finding 6a; Delilah tunes them.
    quietGrid: { lineK: 0.4, nameK: 0.6, starFactor: 3 },
    historySec: 60,          // spec 6: free sing keeps the last 60 s
    pausedOpacity: 0.6,
    toneGlowMs: 900,         // one .22 -> .40 -> .22 swell per reference tone
    // A target changed while drawing fades over this (never a full-width snap). At 200 ms
    // the new band read 0.19 on Dawn in labs/matchhold-lab.html; at 320 ms it is calmer.
    targetFadeMs: 320,
    // A judged note bar's new look (Star steps) eases in over this, calm motion too (spec 10:
    // a fade, never a pop). The in-tune fill read 0.24 on one 48 px cell at once (steps lab).
    noteMarkMs: 300,
    // Review 2: a target further away than this never slides (an octave at 3 semitones a
    // second took 4 s, and the ring filled on a moving picture); it cross-fades instead.
    jumpFadeSemis: 5,
    // A fresh target (stage.set freshTarget): the old trail fades out over this, and only
    // then does the view slide, so no thick line travels. Never under 120 ms.
    freshHoldMs: 200,
  },

  // Spec 5.3.
  hud: {
    meterRangeCents: 60,
    // The head tag (spec: at most 8 a second) and the HUD number (at most 4 a second) are
    // driven from ONE clock at the slower rate, so the two can never show different numbers
    // (acceptance check 11).
    readoutHz: 4,
    needleMs: 120,
    announceEveryMs: 3000,
    hintAfterMs: 2500,
    hintKeepMs: 3000,
    hintClearAfterSuccesses: 2,
    chipLevelHz: 10,
  },

  // Spec 10.5. Times are from the spec; the three levels are GUESSES.
  mic: {
    silenceRms: 0.003,       // same as the detector's loudness gate (js/pitch.js minRms)
    quietRms: 0.012,
    // "Too loud" means the input clipped, and only the peak shows that: a sung note at a
    // healthy loudness (RMS 0.2) can clip on its peaks, and a full-scale sine (RMS 0.707)
    // does not. js/mic.js onLevel(rms, peak) gives the largest sample of each window.
    loudPeak: 0.98,
    silenceAfterMs: 3000,
    quietAfterMs: 4000,
    loudAfterMs: 1000,
    noisyAfterMs: 5000,
    // A dip shorter than this does not restart a problem's timer or clear its banner
    // (breaths between notes must not make the banner come and go).
    problemReleaseMs: 600,
    levelFullScaleRms: 0.25, // the level bar is full at this loudness (GUESS)
  },

  // Spec 6.
  freesing: {
    keepTakeSec: 60,
    steadyWithinCents: 50,   // "steadiest note": longest stretch staying this close to one note
    pickerLowMidi: 36,       // C2..C6 until Find your range has measured the singer
    pickerHighMidi: 84,
    pickerStartOctave: 3,
    toneSec: 1.5,
    toneTailMs: 150,         // the room is still ringing just after the tone ends
    maxSavedTakes: 20,
    playbackHz: 30,          // how often a saved point is kept (frames are thinned to this)
  },

  // Spec 7.3, the hold ring. Times are the spec's; all are first values until the owner
  // has held real notes against them.
  hold: {
    holdMs: 3000,            // spec: 3 seconds (first week 2: pass holdMs to the exercise)
    graceMs: 250,            // out of tune or silent this long only pauses the ring
    drainRate: 2,            // after the grace the ring empties this many times faster than it fills
    // After a landing the ring will not fill again until the voice has been off the note or
    // silent this long: one long breath must not land two notes in a row.
    releaseMs: 250,
    // A stalled tab must not pour seconds of hold into the ring in one reading.
    maxDtMs: 100,
    stuckAfterMs: 20000,     // spec: no success after 20 s -> the Skip button says more
    wobbleDips: 3,           // in and out of the band this often on one note -> the "steady ah" hint
    octaveCents: 50,         // spec: within this of the note 12 semitones away
    // "Use my octave" is offered after the verdict's own hold plus this much steady
    // octave-out singing (review 2: the hint's 2.5 s left a right note looking wrong).
    octaveOfferExtraMs: 600,
    headRadiusPx: 14,        // spec: a 28 px ring around the head dot
    headWidthPx: 3,
    rimWidthPx: 8,
    trackOpacity: 0.18,
    thickenMs: 120,
    thickenBy: 1.5,
    textHz: 4,               // "Held 1.4 of 3 seconds" changes at most this often (as hud.readoutHz)
    // The star that kindles inside the ring (rewards-ideas spec, section 5 A). Its largest
    // radius (1 + 9 = 10 px) stays inside the ring's inner edge (14 - 1.5 = 12.5 px).
    star: {
      baseRadiusPx: 1,
      growPx: 9,
      innerFrac: 0.38,
      haloScale: 2.2,
      haloOpacity: 0.6,
      smoothMs: 80,          // time constant of the shown size, so it cannot jitter
      // The read-out's copy sits on the rim at 12 o'clock: 2 px growing to 10 (review 2).
      hudBaseRadiusPx: 2,
      hudGrowPx: 8,
      // "steady": four rays at 45 degrees, this fraction of a point. 0.55 could not be told
      // from "held" at tray size; 0.72 is Delilah's trial (review 2, finding 5).
      rayFrac: 0.72,
      ringScale: 1.5,        // "found it again": a ring at this multiple of the radius
      ringWidthPx: 1.5,
    },
  },

  // STYLE.md section 6, "Rewards". Caps are the spec's, lower than the ASL trainer's.
  rewards: {
    sparkCap: 40,
    sparks: { note: 12, first: 24, best: 40 },
    rings: { note: 1, first: 2, best: 2 },
    burstMs: 600,            // --d-reveal: the expanding ring and the sparks
    burstMinGapMs: 1500,     // at most one burst per 1.5 s
    ringGrowPx: 26,
    sparkReachPx: 44,
    sparkSizePx: 2,
    bandFillMs: 320,         // the held band turns green over this long (a wide area: never under 120 ms)
    // ...and lets go this fast on the next note, inside stage.freshHoldMs, so it has gone
    // before the view starts to slide.
    bandClearMs: 200,
    trayStarPx: 28,          // review 2: 24 px was too small to tell the three shapes apart
    starFlightMs: 600,
    climbCap: 4,
    runWindowMs: 30000,
    glowAfter: [2, 4, 6],    // notes in tune in a row for edge-glow levels 1, 2, 3
    chimeRootMidi: 72,       // C5, C major pentatonic above it
    chimeNoteSec: 0.45,
    chimeStepSec: 0.14,
    // Always quieter than the reference tone: this fraction of the tone's own gain.
    chimeGainFrac: 0.35,
    // Rewards-ideas spec, section 5 B: the three star looks.
    steadySpreadCents: 8,
    lookSparks: { steady: 12, held: 8, recovered: 8 },
    // Section 5 C: the answering chord, headphones only. Times are from the landing.
    answer: {
      semis: [12, 19, 24],   // one more voice per note in a row
      maxTopMidi: 96,
      firstMs: 120,
      stepMs: 70,
      fadeInMs: 30,
      fadeOutMs: 600,
      endWithinMs: 900,
      guardMs: 150,          // silence before the next reference tone or any scoring
      earlyFadeMs: 80,       // Next pressed early: the voices fade over this first
      gainFrac: 0.35,        // of the reference tone's level, all voices together
      echoOpacity: 0.45,
    },
  },

  // Spec 7.3, Match and hold.
  matchhold: {
    notes: 5,
    toneSec: 1.5,
    toneTailMs: 150,
    autoNextMs: 1200,        // "Keep going": the next note starts by itself after this
    // Until Find your range has measured the singer, targets stay inside E3..B3: the middle
    // of a low voice and the bottom of a high one, which "Use my octave" lifts in one press.
    // GUESS, not measured on anyone.
    defaultLowMidi: 52,
    defaultHighMidi: 59,
    // Semitones from the middle of the range, in order: start mid-range, small steps first.
    pattern: [0, 2, -1, 3, -3],
    biasCents: 8,            // mean distance beyond which the result line says "mostly a little low/high"
    // Each new note re-centres the view while a held band, its green fill and a thick
    // in-tune line are all on screen. At the stage's own 6 semitones a second that slide
    // measured 0.21 to 0.23 on the flash number in labs/matchhold-lab.html (limit 0.2).
    recentreMaxSemisPerSec: 3,
    // "Listen, imagine, then sing": a silent beat between the end of the note and the ring
    // opening, with the cue "Hear it in your head" (Pfordresher & Halpern 2013: vivid inner
    // hearing tracks accuracy; a correlation). Nothing is judged in it. GUESS: nobody has
    // tried a length yet. Settings: "Pause to imagine the note".
    imagineMs: 1200,
  },

  // The singer's own voice as the target tone (js/app/ownvoice.js). Hutchins & Peretz 2012:
  // most poor singers match their own recorded voice better than a synth tone. Every number
  // is a GUESS from synthesised notes: no real voice or microphone has been through it.
  ownVoice: {
    captureMs: 4000,         // GUESS. This much steady voice fills the bar ("about 4 s")
    timeoutMs: 12000,        // GUESS. Listening stops by itself after this, whatever was heard
    toneSec: 1.5,            // GUESS. The home note is played this long first, when there is one
    toneTailMs: 150,         // as matchhold.toneTailMs: the tone has gone before any listening
    windowSec: 0.17,         // GUESS. Analysed window (8192 samples at 48 kHz): about 6 Hz a bin
    maxHarmonics: 12,        // GUESS ("about 12"): above these a sung vowel has little left
    maxHz: 8000,             // GUESS. Harmonics above this are left out (hiss, not voice)
    bandFrac: 0.2,           // GUESS. A harmonic's energy is summed this share of f0 either side
    minBandBins: 3,          // ...and never fewer bins than this (the window's own smear)
    gapFrom: 0.35,           // GUESS. The noise floor is read between harmonics, from here...
    gapTo: 0.65,             // ...to here (shares of f0 above each harmonic)
    minBinsPerF0: 8,         // GUESS. A note lower than this many bins cannot be taken apart
    steadyCents: 60,         // GUESS. Readings further than this from the middle pitch are left out
    minSteadyFrames: 20,     // GUESS. Fewer steady readings than this: "hold it longer"
    minSteadyShare: 0.6,     // GUESS. Fewer of the voiced readings steady than this: "it moved about"
    clipPeak: 0.98,          // GUESS. A sample this large counts as clipped...
    clipShare: 0.05,         // GUESS. ...and this share of clipped readings refuses the capture
    minHnrDb: 8,             // GUESS. Voice under this many dB above the noise between its harmonics: refused
    harmonicMinSnr: 2,       // GUESS. A harmonic under this many times the noise under it is stored as 0
    round: 1000,             // stored to three decimals: small JSON
  },

  // Spec 7.2, Find your range (js/app/range.js, js/app/exercises/rangefinder.js). The times
  // marked "spec" are the spec's; every other value is a GUESS from synthesised frames and
  // must be re-measured on the owner's voice before the saved range is trusted.
  range: {
    viewLowMidi: 36,         // spec: the wide view is C2 to C6 at first
    viewHighMidi: 84,
    minMidi: 28,             // readings outside E1..C7 are not a singing voice
    maxMidi: 96,
    // GUESS. A held note's lowest and highest readings are at most twice this apart. A
    // beginner's "steady" note drifts, and vibrato is wide: at 50 a 60-cent vibrato never
    // pinned. A slide still cannot pass: at one note a second it is "held" for 1.5 s at most.
    steadyCents: 75,
    coverMs: 1000,           // spec: the ladder covers a note held steadily this long
    pinMs: 1500,             // spec: a lowest / highest note is pinned after this long
    gapMs: 150,              // GUESS. A dropout shorter than this does not end a hold
    // An octave slip of the detector or a squeak: this far from the hold, for less than this.
    glitchSemis: 3,          // as stage.leapSemis: nobody slides this far between two readings
    glitchMs: 120,           // GUESS
    touchMs: 150,            // GUESS. A note counts as reached after this much sound on it
    // The range must hang together: a held note with more than this many silent notes
    // between it and the rest was never slid to (an octave slip that lasted). GUESS.
    bridgeSemis: 3,
    // ...and inside one breath the part sung first is the voice, unless another part carries
    // this many times its sound (a note that starts on a wrong octave). GUESS.
    slipFactor: 3,
    // A hold is where the slide STARTED, not an end, when the voice afterwards goes this many
    // notes beyond it (bugs.md 44). GUESS; 0 turns the rule off.
    passedSemis: 3,
    // A reading quieter than this share of the step's loudest held note is the room, not the
    // voice (a mains hum reads as a clear, steady note). GUESS, never tried on a real room:
    // 0.1 is 20 dB down, and a voice's lowest note is perhaps 10 dB under its middle. 0: off.
    humRatio: 0.1,
    comfortTrimSemis: 2,     // spec: the comfortable range drops 2 notes from each end
    comfortMinSpanSemis: 4,  // GUESS. ...but never trims a small range down to nothing
    smallNotes: 5,           // spec: under 5 notes is "a small sample"
    // The home note: this far above the comfortable bottom (less in a small range), so tunes
    // that climb from it have room. GUESS.
    homeUpSemis: 3,
    nothingAfterMs: 20000,   // spec: nothing steady in 20 s -> the "long, relaxed ah" hint
    grid: 'quiet',           // review 4, 6a: 'full' gives the lined chart back
    resultFitMs: 600,        // review 4, 4: the view eases to the whole range (at once when calm)
    resultVoiceAlpha: 0.35,  // ...and the voice line steps back
    burstEaseInMs: 150,      // the New best burst fades in: the picture under it is still and dark
    nowFrac: 0.6,            // the voice's head stays left of the two flags at the right edge
    // Review 4, 6b to 6d: the two horizons (the singer's lowest and highest notes are the
    // bottom and top of their own sky). Visual values only; every change is an eased fade.
    horizon: {
      linePx: 2,             // the horizon line, in the accent colour
      glowPx: 8,             // its soft glow once pinned
      inMs: 400,             // a pinned line, its veil and its flag ease in over this
      outMs: 300,            // "Try again" and Stop: they ease out over this
      calmMs: 400,           // calm motion: a fade both ways, never a jump (at 200 the lab read 0.275)
      driftPxPerSec: 60,     // a line follows a slowly drifting view; when the view moves faster than
      jumpMs: 600,           // this, or the line goes to another note, it cross-fades over jumpMs
      ringInMs: 160,         // the ring round the head eases in...
      ringOutMs: 500,        // the ring round the head fades out over this when the step ends
      formingK: 0.35,        // before the pin: a dashed line at this strength under the held note
      formingFrom: 0.15,     // ...once the ring is this full (a slide passing through draws no line)
      washK: 0.55,           // outside the sky: the page colour laid over the stage at this strength
      riseK: 0.16,           // the glow rising from each horizon into the sky...
      risePx: 72,            // ...over this many pixels
      flagPx: 14,            // the pennant beside "Lowest A2" (down for lowest, up for highest)
      fontPx: 14,
      starSeed: 20261013,    // the stars between the two horizons (lit when both are pinned)
      starCount: 110,
      starK: 2.2,            // ...this many times the usual star's strength
      dawnStarK: 0.5,        // Dawn has no star field: these are quiet dots at this share
      bandK: 0.14,           // the result: the comfortable range, a brighter band inside the sky
      bandMs: 400,
      firstStarPx: 10,       // the first measurement: a gold star lights on each horizon...
      firstStarInMs: 360,
      firstStarGapMs: 250,   // ...the ground first, the top this long after
      firstStarXFrac: 0.3,   // where along the horizon (left of the now line and of the flags)
    },
    savedMinMidi: 35,        // B1 and C♯6: the ends of what the detector hears (62 to 1100 Hz)
    savedMaxMidi: 85,
    historyMax: 60,          // saved measurements kept for Progress
    textHz: 4,               // the ladder's words change at most this often (as hud.readoutHz)
  },

  // The setup path (js/app/setup.js).
  setup: {
    hearMs: 4000,            // review 4, finding 10: step 1 waits this long for a sound
  },

  // Sing a constellation (docs/design/specs/2026-10-12-sing-a-constellation.md). Every value
  // is a GUESS from the paper spec: nobody has sung against them yet (owner look-list, 16).
  constellation: {
    holdMs: 1500,            // GUESS. Per star; the owner's choice 17.1 (Match and hold uses 3 s)
    toneSec: 1,              // GUESS. Each star's own note before it is sung
    toneTailMs: 150,         // as matchhold: the room still rings just after the tone
    shapeNoteSec: 0.6,       // GUESS. "Hear the shape": each note of the tune
    shapeGapSec: 0.1,        // GUESS
    autoNextMs: 900,         // GUESS. After a landing the next star's note plays by itself
    tailMs: 700,             // GUESS. How much of the voice's path trails the dot
    tailPxPerSec: 60,
    tailMaxPx: 42,
    linePoints: 24,          // heights kept per drawn line (the saved handwriting)
    // The field, spec section 5: the figure fills this share of the height, inside these
    // limits of pixels per note; the span is never counted as less than minSpanSemis.
    // Review 3, finding 1a: the paper guesses (0.6, 48, 9, 10) drew a small chart. The Hill is
    // now about 300 px tall at 1440 x 800 and 25 cents is 19 px, so the handwriting shows.
    fillFrac: 0.66,
    pxPerNoteMin: 18,
    pxPerNoteMax: 80,
    minSpanSemis: 4,
    starRadiusPx: 12,
    litRadiusPx: 15,
    dotRadiusPx: 6,
    ringRadiusPx: 19,        // the hold ring here: clear of the 12 px hollow star inside it
    kindleGrowPx: 13,        // the star kindling in that ring ends at 14 px, one short of lit
    // The sky (finding 1b). All of it is still: drawn once to an off-screen canvas.
    sky: {
      count: 60,             // quiet background stars, placed from the figure's name
      doneCount: 70,         // more of them come out when the figure is finished
      clearPx: 24,           // none this close to a figure star
      laneAlpha: 0.5,        // lane lines at half their old strength
    },
    haloRadiusPx: 38,        // a lit star's soft halo ...
    haloAlpha: 0.25,         // ... this strong at its centre, nothing at its edge
    lineGlowPx: 6,           // the soft stroke under a settled line
    lineGlowAlpha: 0.18,
    tagFadeMs: 200,          // the voice's tag eases in; dot and tag ease out when the voice stops
    tagFollowMs: 140,        // the tag glides after the dot (the dot never lags)
    ringGoneMs: 600,         // the full ring eases away after a landing
    burstRingAlpha: 0.7,     // the landing ring at its strongest
    lightSwellPx: 3,         // a star swells this much while its note sounds (none under calm)
    // The finishing moment (finding 1c). Nothing in it is larger than a star or quicker
    // than 200 ms; under calm motion it is one cross-fade of calmFadeMs, with no swelling.
    finish: {
      chartFadeMs: 600,      // lanes, note names and star numbers go
      closingDelayMs: 200,   // then the closing lines, and the stars swell in order
      swellStepMs: 250,
      swellMs: 500,
      swellPx: 3,
      nameDelayMs: 900,      // then the name sets in gold inside the field
      nameFadeMs: 600,
      backMs: 320,           // "Sing it again": the lanes and names come back
      calmFadeMs: 600,       // one slow cross-fade (at 200 ms the gold name read as a blink: lab 0.114)
    },
    settleMs: 320,           // the green thread becomes the gold line over this
    lightMs: 200,            // a star's outline brightens for its note in "Hear the shape"
    closingFadeMs: 200,
    closingStepMs: 250,
    // The tune played back when a figure is finished (headphones only): quieter than a
    // reference tone, by this share of its level. GUESS.
    softGainFrac: 0.5,
    // Held through into the same note again for this long: "take a breath" is said. GUESS.
    sameNoteHintMs: 700,
  },

  // The practice record (js/app/sessions.js). The sizes keep the saved text well inside
  // localStorage's few megabytes whatever happens; none of them is a judgement of singing.
  sessions: {
    dayStartsHour: 4,        // singing after midnight still belongs to the evening before
    segmentGapSec: 0.5,      // a break this long in a note's readings starts a new try at it
    // Tuning numbers use readings this close to the target (verdict.farCents, the rule of
    // the round's own result line): hunting for a note far away is not "singing low".
    nearCents: 100,
    // A note gets tuning numbers only when at least this share of its sung readings were that
    // near: fewer are crossings on the way past, not a note held. GUESS.
    nearShare: 0.5,
    maxFramesPerTake: 20000, // about 5 minutes of readings held in memory during one exercise
    maxNotesPerTake: 24,
    maxTakesPerSession: 8,
    maxSessions: 40,
    maxDays: 400,            // days sung, kept for the streak after their sessions are dropped
    maxBytes: 300000,        // oldest sessions go first when the saved text is longer than this
  },

  // Coach summary (spec section 8; js/app/coachcard.js). Every threshold is a GUESS taken from
  // js/coach.js's own first guesses: none has been set against the owner's real sessions.
  coach: {
    // Spec: "under about 20 s voiced; tunable". Lower, because one whole Match and hold
    // round is 5 notes x 2 s = 10 s in tune: at 20 no single round could ever get a tip.
    minSungSec: 8,
    minNotes: 3,
    maxFixes: 3,
    // Average low/high worth a card. Was 10: well inside the 25-cent "in tune" band the
    // same page uses, so it nagged a singer who was in tune (design review 5, finding 2).
    biasCents: 20,
    littleCents: 25,         // "a little low" under this; "You sing low" from here up (the in-tune band)
    // Time in tune under this, with the average inside the band: the "notes are landing
    // beside the target" card. GUESS (review 5, finding 1), to tune on real sessions.
    besideTunePct: 40,
    driftCents: 10,          // movement across a held note
    wobbleCents: 20,         // spread either side on a held note
    scoopCents: 20,          // start of a note against the rest of it
    slowLockSec: 0.5,        // from the first sound to settling within lockCents
    lockCents: 50,
    lockHoldSec: 0.1,
    onsetWindowSec: 0.15,
    minHoldSec: 0.5,
    // What each measure is divided by to rank the cards (1 = as bad as it gets), as coach.js does.
    severity: { bias: 50, drift: 40, wobble: 50, scoop: 60, lock: 1.2 },
    goodTunePct: 60,         // "what went well" may name the share of time in tune from here up
    usualSessions: 7,        // spec: "your usual (last 7 sessions)"
    // Against your usual, a change smaller than this is "about the same".
    sameCents: 5,
    sameSec: 0.15,
    samePct: 8,
  },

  // Today and the guided daily session (spec section 4; js/app/daily.js).
  daily: {
    rangeMaxAgeDays: 30,     // GUESS: the session measures the range again when it is older than this
    // Shown lengths, seconds. Spec section 4 for Match and hold; the others are GUESSES.
    stepSec: { range: 60, matchhold: 90, constellation: 90 },
    armMs: 1500,             // a press on Start or Continue may start the next exercise this long after it
    // The exercise then starts this long after its screen is drawn. Measured in
    // labs/coach-lab.html (flash number, limit 0.15): 0 ms 0.174, 120 ms 0.102, 300 ms 0.089.
    startAfterMs: 300,
  },

  // The voice check and its portrait (docs/design/specs/2026-10-12-voice-check-and-songs.md
  // section 4; js/app/voicecheck.js, js/app/portrait.js, js/app/exercises/voicecheck.js).
  // Nobody has taken one with a real voice yet: every GUESS is the spec's own first value.
  voiceCheck: {
    keep: 36,                // spec 7: 36 portraits are kept: the first (pinned) and the newest 35
    // "Since your first" (2026-10-15 spec 4.2): a change counts as clear only at least this big.
    // GUESS, the designer's judgement, not a study: a gain of 1 of 10 sits inside a normal
    // day's wobble. Recalibrate once the owner has 5+ portraits. Units: notes, of 10, cents,
    // of 10, seconds, of 24, of 6.
    clear: { range: 2, on: 2, away: 8, steady: 2, lock: 0.3, tunes: 3, shapes: 2 },
    reuseRangeHours: 24,     // spec 4.1: a range measured this recently may be used again
    soonDays: 7,             // spec 4.2: under this, "Voices change slowly" is shown
    // Step 2, your easy note (spec 4.3).
    hums: 3,
    humMs: 1500,             // GUESS. A hum counts once it has been steady this long
    humEndMs: 3000,          // ...and is taken as finished at this length (the words ask for 3 s)
    humNudgeMs: 10000,       // spec: nothing steady yet -> "Still listening"
    humSkipMs: 20000,        // spec: ...and now "Skip this step" is offered
    // Step 3, ten notes (spec 4.4). The order is fixed so that two portraits compare like
    // with like: fractions of the way from the comfortable low to the comfortable high.
    noteFractions: [0.5, 0.1, 0.8, 0.3, 1.0, 0.0, 0.6, 0.2, 0.9, 0.4],
    listenSec: 1.5,          // spec: the reference tone
    gapMs: 150,              // spec: the microphone reads from this long after the tone ends
    singMaxSec: 5,           // spec: the Sing window closes by itself
    heardMs: 2000,           // GUESS. The ring fills on this much voice, whatever its pitch
    setMs: 1200,             // spec: the star is shown this long before the next note
    liftMs: 600,             // spec: the curtain lifts over this (calm motion: calmFadeMs)
    calmFadeMs: 200,
    hearAgainMax: 2,         // spec: "Hear it again" at most twice a note
    silentRunSheet: 3,       // spec 4.10: nothing sung on this many notes running -> the sheet
    onTargetCents: 50,       // spec: the Seattle protocol's line (Ricky rec. 4)
    littleCents: 25,         // spec: 25 to 50 is on target and "a little low / high"
    octaveCents: 50,         // spec: this near the note 12 up or down is "octave away"
    steadyWobbleCents: 25,   // GUESS
    steadyDriftCents: 30,    // GUESS
    leanCents: 10,           // spec 4.7: "Mostly a little low" past this
    minLockNotes: 3,         // spec 4.7: fewer settled notes than this are not timed
    minFrames: 3,            // as js/coach.js: fewer readings than this are not a sung note
    // Step 4, six short tunes (spec 4.5): scale steps of a major scale, steps first.
    tunes: [[1, 2, 3, 1], [3, 2, 1, 2], [1, 3, 2, 1], [1, 3, 5, 3], [5, 3, 1, 3], [1, 2, 3, 5]],
    tuneNoteSec: 0.6,        // GUESS
    shapeDeadCents: 30,      // GUESS. A step smaller than this counts as "the same note"
    // GUESS. How far the readings lag the dots (microphone + detector); js/coach.js `latency`.
    // Never measured on the owner's machine.
    latencySec: 0.1,
    // The voice-type comparison (spec 4.7). GUESS: commonly quoted textbook ranges, the
    // designer's pick, NOT from Ricky's report; Ricky is to confirm them. MIDI notes.
    types: [
      { name: 'bass', low: 40, high: 64 },            // E2 to E4
      { name: 'baritone', low: 45, high: 69 },        // A2 to A4
      { name: 'tenor', low: 48, high: 72 },           // C3 to C5
      { name: 'alto', low: 53, high: 77 },            // F3 to F5
      { name: 'mezzo-soprano', low: 57, high: 81 },   // A3 to A5
      { name: 'soprano', low: 60, high: 84 },         // C4 to C6
    ],
    typeMinNotes: 10,        // GUESS. A narrower range is not compared at all
    typeTieNotes: 2,         // spec: a second type this close in overlap is named too
    strongestMinNotes: 5,    // spec 4.7: "Strongest today" needs a range this wide...
    strongestDiff: 2,        // ...and the two halves this many notes apart
    // The picture (spec 4.6). Sizes in CSS px at the full 960 px card; all GUESSES by eye
    // on synthetic portraits only.
    portrait: {
      maxWidthPx: 960,
      padSemis: 1.5,         // sky shown beyond each horizon
      dust: 60, dustSeed: 20261012,
      starPx: 12, homePx: 15, dotPx: 6, ringPx: 6, figurePx: 56,
      thumbW: 160, thumbH: 90,
      finishMs: 2500,        // spec: the finishing moment, once
      horizonMs: 600, bandMs: 320, landGapMs: 90,
      earlierK: 0.7,         // spec 4.8: the earlier portrait at this brightness
    },
  },

  // Long note (js/app/longnote.js, js/app/exercises/longnote.js; owner approved 2026-10-13).
  // One comfortable note, held as long and as steadily as is easy. Teacher advice, not study
  // evidence, and nobody has sung against it yet: EVERY number here is a GUESS.
  longNote: {
    defaultMidi: 55,         // GUESS. G3, the middle of matchhold's default range, until a range is saved
    toneSec: 1.5,            // GUESS. "Hear the note" plays this long (as matchhold.toneSec)
    // The hold itself (the rule is range.js createHoldWatch, with these numbers).
    bandCents: 80,           // GUESS. One note: every reading within this of the hold's own centre
    gapMs: 250,              // GUESS. A dropout shorter than this is bridged, not a break
    glitchMs: 120,           // GUESS. Readings off the note for less than this are a detector slip
    minMidi: 28,             // GUESS. As range.minMidi / maxMidi: outside E1..C7 is not a voice
    maxMidi: 96,             // GUESS
    startMs: 300,            // GUESS. This much steady voice: the hold has begun
    endSilenceMs: 1200,      // GUESS. Silent this long after a hold: the breath is over
    minHoldSec: 1,           // GUESS. Shorter than this is not counted (and not held against anyone)
    maxHoldSec: 40,          // GUESS. The listening ends here by itself: nobody should push past it
    waitHintSec: 6,          // GUESS. Nothing heard yet: the "whenever you are ready" line
    giveUpSec: 20,           // GUESS. Still nothing: the microphone is let go (as range.nothingAfterMs)
    // The hard limit on one listening, whatever is heard (owner rule 2026-10-12: the microphone
    // is not left open). maxHoldSec only ends a steady note and giveUpSec only silence, so a TV
    // or a note that never settles kept it open until Stop. giveUpSec + maxHoldSec: a note
    // begun just before giving up still has its whole length.
    listenSec: 60,           // GUESS
    // The words.
    driftWindowSec: 1,       // GUESS. Drift = the last second against the first second
    driftCents: 15,          // GUESS. Under this the note "stayed"
    wobbleCents: 20,         // GUESS. As js/coach.js thresholds.wobbleCents
    breathSec: [5, 12],      // GUESS. Under 5 s "a short breath", under 12 s "a comfortable breath", else "a long breath"
    ringSec: 15,             // GUESS. The ring is full at this many seconds
    // The rest rule.
    restSec: 8,              // GUESS. Rest this long after each hold before the next
    holdsPerSet: 5,          // GUESS. After this many holds the set ends, gently
    setRestSec: 60,          // GUESS. ...and the next set waits this long
    keepDays: 400,           // GUESS. Days of "best that day" kept (as sessions.maxDays)
    recentDays: 7,           // GUESS. The row of days shown beside the result
    textHz: 4,               // GUESS. "Held 7.2 seconds" changes at most this often (as hud.readoutHz)
  },

  // The aurora voice line (docs/design/specs/2026-10-12-living-sky.md sections 6.2, 6.3, 6.6,
  // 6.7; js/app/aurora.js). A curtain of light above the pitch line. Sizes and speeds are the
  // paper spec's; the brightness, the rays and the colours up the curtain were set by eye on
  // 2026-10-12 (the spec's alphas were too faint to see). Nobody has sung under it yet.
  aurora: {
    // 6.2. factor: share of the full height; rays / tufts: the texture. The shape carries the
    // verdict: only "in" and "free" are tall and rayed, only "off" is broken into tufts.
    looks: {
      in: { factor: 1, rays: true, tufts: false },
      close: { factor: 0.55, rays: false, tufts: false },
      off: { factor: 0.35, rays: false, tufts: true },
      free: { factor: 1, rays: true, tufts: false },
    },
    // Peak alpha at the bright edge, per theme. Never above the theme's --aurora-peak token.
    peak: {
      dusk: { in: 1, close: 0.8, off: 0.7, free: 1 },
      dawn: { in: 0.95, close: 0.75, off: 0.65, free: 0.95 },
    },
    holdGrow: 0.35,          // in tune: the factor grows from 1 to 1 + this as a hold fills
    // 6.3. Loudness: lv 0 at lvFloorDb under full scale, 1 at lvFullDb under (GUESS).
    lvFloorDb: -50,
    lvFullDb: -20,
    lvSmoothMs: 150,
    heightMinPx: 44,         // h = (heightMinPx + heightSpanPx * lv) * factor
    heightSpanPx: 64,
    // On a stage taller than tallRefPx every height grows with it, up to tallMax times: the
    // app's stage is 400 to 520 px on a laptop, the labs' is 330 (set by eye, 2026-10-12).
    tallRefPx: 330,
    tallMax: 1.4,
    heightSmoothCols: 5,     // heights are averaged over this many columns: a verdict change slopes
    drawMinPx: 10,           // a column shorter than this is not drawn
    alphaBase: 0.7,          // alpha = peak * (alphaBase + (1 - alphaBase) * lv)
    hueSmoothMs: 400,        // free singing: how fast the hue follows the pitch
    freeSteps: 5,            // ready-made sprites from low through mid to high
    // Free hue without a saved range. The spec says "the visible lanes", but the view follows
    // the voice, so every note would sit mid-range and the hue would never change. GUESS.
    freeLowMidi: 45,
    freeHighMidi: 72,
    birthMs: 360,            // a column grows out of the line: height and alpha, never a pop
    trailFullMs: 1200,        // full for this long ...
    trailEndMs: 2500,        // ... gone by this
    // The light is the voice: a stretch the voice has left (a leap, a breath) loses its
    // curtain and its ribbon's glow over endFadeMs; the plain line stays as the record.
    endFadeMs: 1000,
    // The frame a stretch stops (no reading for stage.maxJoinGapSec) its ribbon rounds its
    // end off over this, linearly, instead of in that one frame. 0 = the end rounds off at once.
    endEaseMs: 600,
    restOutMs: 800,          // the stage eases the light away over this once the voice has rested ...
    restInMs: 1000,          // ... and blooms back this slowly when the voice returns (it is more light now)
    restAfterMs: 250,        // no voiced reading for this long: the stage eases the curtain away (stepFadeMs)
    cutFadeMs: 1200,         // a fresh target: the old trail's curtain eases out over this (the line takes stage.freshHoldMs)
    gapSec: 0.15,            // readings this far apart: the clock jumped, the old curtain eases out in place
    // A view that has slideHoldSemis or more to slide (a leap; the lanes follow the voice)
    // would carry the lit curtain across the lanes at full speed. It waits slideOutMs while
    // the curtain eases out, slides, and the curtain eases back over slideInMs at rest.
    // labs/stage-lab.html, the leap (flash number): 0.212 / 0.208 before, 0.150 / 0.169 with
    // this, which is what the slide reads with no curtain at all.
    slideHoldSemis: 4,
    slideOutMs: 600,
    slideInMs: 600,
    swayPx: 6,               // rays drift sideways by swayPx * sin(2 pi t / swayPeriodSec)
    swayPeriodSec: 7,
    fieldCapPx: 60,          // Sing a constellation: never reaches the next star's label
    fieldTrailFullMs: 250,   // ... and its tail is only constellation.tailMs long
    // 6.4. The sprites.
    colPx: 3,
    spriteWPx: 260,          // 20 tuft periods, so the pattern wraps
    spriteHPx: 96,
    paintSliceMs: 8,         // a cold first paint is spread over frames, about this long each
    // Colour up a tall curtain: the body colour to bodyTo, --aurora-crown by crownAt, then
    // --aurora-high at the tips. (Close and off keep their verdict colour all the way up.)
    bodyTo: 0.16,
    crownAt: 0.42,
    // Brightness up one ray: bodyLevel * (1 - x) ^ falloffPow, plus the bright lower edge that
    // hugs the line, edgeLevel * exp(-x / edgeDepth). x is 0 at the line, 1 at the ray's tip.
    falloffPow: 0.7,
    bodyLevel: 0.92,
    edgeLevel: 0.38,
    edgeDepth: 0.15,
    // The hot base: the colour turns towards --voice-core where the curtain leaves the ribbon,
    // so the two read as one piece of light. hotLevel * exp(-x / hotDepth); close and off get
    // a share of it (in tune is the brightest thing on the stage). Set by eye, 2026-10-12.
    hotLevel: 0.5,
    hotLevelDawn: 0.6,
    hotDepth: 0.1,
    hotClose: 0.5,
    hotOff: 0.3,
    edgeRayShare: 0.35,      // how much of the rays shows in the lower edge (it is nearly unbroken)
    rayDepth: 0.78,          // rays: (1 - rayDepth) + rayDepth * noise
    rayDepthDawn: 0.35,      // softer on the pale stage
    rayMinPx: 10,            // ray features are between this and about twice this wide
    rayTopMin: 0.6,         // each ray ends between this share of the height and the full height
    rayTopMinPx: 16,         // ... and the heights change over features this wide or wider
    sheetTopMin: 0.72,       // close: the smooth sheet's top rolls between this and full height
    calmTop: 0.85,           // calm motion: one flat top
    // The veil: a second, fainter curtain behind, taller and broader, further up the colours.
    veilLevel: 0.42,
    veilPow: 0.9,
    veilShift: 0.4,
    veilTopMin: 0.7,
    veilMinPx: 34,
    // Shimmer: a slow wave of brightness along the ribbon (never under calm motion). It only
    // dims, by at most shimmerDepth; a crest is shimmerPx long and passes in shimmerPeriodSec.
    shimmerDepth: 0.22,
    shimmerPx: 64,
    shimmerPeriodSec: 6,
    raySeed: 20261014,
    smoothLevel: 0.85,       // "close" (and every state under calm motion): a flat sheet
    tuftOnPx: 8,             // as the off line's dashes ([8, 5]), and in step with them
    tuftOffPx: 5,
    tuftSoftPx: 2,
    // 6.6. Calm motion: no sway, no rays, no growth with loudness or the hold.
    calmLv: 0.5,
    calmLevel: 0.62,         // the calm sheet is softer than "close": it is one flat slab of light
    calmTrailFullMs: 400,    // full for this long, then a slope down to calmTrailEndMs
    calmTrailEndMs: 1200,
    // 6.7. The guard: the curtain must never cost the detector a frame.
    budgetMs: 0.6,           // what the curtain may add to a stage frame (95th percentile)
    slowFrameMs: 6,
    slowFrames: 30,          // this many slow stage frames in a row: step down
    wideColPx: 6,            // first step: wider columns. Second step: off for the visit
    stepFadeMs: 600,         // a step, and the Settings switch, fade; never a cut
    maxCols: 512,

    // The voice ribbon (stage.js): light that stands on the pitch line and rises into the
    // curtain. It reaches (half + halfLv * loudness) * bandK above the line and underPx below,
    // is rounded off where a stretch starts or stops (tipPts readings) and lasts as long as
    // the curtain (trailEndMs). The line under it is the exact pitch, with a crisp core.
    // Shape carries the verdict: in tune is the full band, close a thin one, off has none
    // (thin dashes and tufts). All set by eye on 2026-10-12; nobody has sung under it yet.
    ribbon: {
      looks: {
        // thin: half the plain line's width; core / coreW: the crisp bright rim the light
        // lays along the line's upper edge (the line itself is never painted over).
        in: { half: 3.2, halfLv: 2.6, thin: 2.5, glow: 1, core: 1, coreW: 1.75, shimmer: 1 },
        close: { half: 1.6, halfLv: 0.9, thin: 1.5, glow: 0.6, core: 0, coreW: 0, shimmer: 0 },
        off: { half: 1.5, halfLv: 0, thin: 1.5, glow: 0, core: 0, coreW: 0, shimmer: 0 },
        free: { half: 2.8, halfLv: 2.6, thin: 2, glow: 1, core: 1, coreW: 1.5, shimmer: 1 },
      },
      // Round the band: a tight glow and a wide halo, each (half * K + Px) above the line.
      // band: which colour it is. Dusk: the verdict colour, with a bright core in the line.
      // Dawn (light cannot be brighter than a pale sky): the verdict's light as the band, and
      // the line's own dark ink is the core.
      dusk: { haloK: 2.6, haloPx: 9, haloA: 0.13, glowK: 1.7, glowPx: 3, glowA: 0.24, bandA: 0.62, coreA: 0.95, band: 'verdict' },
      dawn: { haloK: 2.6, haloPx: 8, haloA: 0.26, glowK: 1.7, glowPx: 3, glowA: 0.55, bandA: 0.95, coreA: 0, band: 'light' },
      bandK: 2,              // the band rises this many half-widths above the line
      underPx: 3,            // and nothing of the light reaches further than this below it
      smoothPts: 3,          // widths are averaged over this many readings each side
      tipPts: 28,            // a stretch grows to its width over this many readings at each end
      shimmer: 0.14,         // the width breathes by this share, in a wave shimmerPx long ...
      shimmerPx: 150,
      shimmerSec: 3.6,       // ... that takes this long to pass (never under calm motion)
    },
    // The head at "now": a soft halo with the exact dot and a bright core inside it.
    head: {
      radiusPx: 18,          // halo radius = (radiusPx + radiusLvPx * loudness) * the look's share
      radiusLvPx: 12,
      share: { in: 1, close: 0.72, off: 0.55, free: 1 },
      alpha: { dusk: 0.48, dawn: 0.7 },
      dotPx: 5.5,
      corePx: 2.6,
      fadeInMs: 800,         // the halo blooms in this slowly when the voice starts ...
      fadeMs: 700,           // the halo eases in and out, and between verdict colours, over this
      jumpPx: 14,            // a move this far in one reading: the halo fades over, it never jumps
    },
    // Sparks shed behind the head while in tune or singing freely (never under calm motion).
    // One every everyMs of the trail; each rises slowly, twinkles and is gone by lifeMs.
    sparks: {
      everyMs: 230,
      lifeMs: 1700,
      inMs: 260,
      holdK: 0.35,           // full until this share of its life, then it fades
      riseMinPx: 10,
      riseMaxPx: 34,
      driftPx: 8,
      minPx: 1.3,
      maxPx: 2.4,
      twinkleHz: 0.7,
      alpha: { dusk: 0.95, dawn: 0.85 },
    },
  },
});

// Skies: the Settings > Look choices (page-layout spec, section 4.2). A sky is a tone (dark or
// light) plus its surfaces; the colours live in css/tokens.css, never here. Saved values from
// before skies ('system', 'dusk', 'dawn') keep their meaning; anything unknown follows the Mac.
// index.html's pre-paint script repeats resolveSky() in plain ES5 (it runs before modules);
// tools/checks/themes.check.mjs holds the two to the same answers.
export const SKIES = Object.freeze([
  Object.freeze({ id: 'system', name: 'Follow my Mac', tone: null, line: 'Dusk or Dawn, as your Mac is set' }),
  Object.freeze({ id: 'dusk', name: 'Dusk', tone: 'dark', line: 'Dark blue night' }),
  Object.freeze({ id: 'dawn', name: 'Dawn', tone: 'light', line: 'Light morning' }),
  Object.freeze({ id: 'nebula', name: 'Nebula', tone: 'dark', line: 'Violet night' }),
  Object.freeze({ id: 'midnight', name: 'Midnight', tone: 'dark', line: 'Black, strongest contrast' }),
]);

// pick: the saved theme setting. light / moreContrast: the Mac's prefers-color-scheme: light
// and prefers-contrast: more. Returns the sky to paint and its tone, always one of SKIES.
// "Follow my Mac" in dark mode with more contrast is Midnight; in light mode it is Dawn.
export function resolveSky(pick, { light = false, moreContrast = false } = {}) {
  const chosen = SKIES.find((s) => s.id === pick && s.tone);
  const theme = chosen ? chosen.id : light ? 'dawn' : moreContrast ? 'midnight' : 'dusk';
  return { theme, tone: SKIES.find((s) => s.id === theme).tone };
}

export const SETTINGS_DEFAULTS = Object.freeze({
  theme: 'system',           // 'system' | a SKIES id: 'dusk' | 'dawn' | 'nebula' | 'midnight'
  calm: null,                // null = follow the system's reduced-motion setting
  pitchView: 'line',         // 'line' | 'meter'
  rewardSounds: true,
  tone: 'oohs',              // 'oohs' | 'sung' | 'soft' | 'voice' | 'sine' | 'mine' (timbreFor in
                             // js/synth.js; 'oohs' = real recorded "oo" samples, 'voice' until they
                             // load; 'mine' = the singer's own tone colour, 'sung' until one is saved)
  toneChosen: false,         // true once the singer picks a Reference tone in Settings
  toneVolume: 0.6,
  noteNames: 'letters',      // 'letters' | 'solfege'
  micDeviceId: null,
  micIntroDone: false,
  aurora: true,              // the curtain of light above the voice line (living-sky spec 6.6)
  skyLines: 'all',          // 'all' | 'tonight' | 'off': the real constellation lines on the home sky (living-sky 2.3 rule 4)
  imagine: true,             // "Pause to imagine the note": the silent beat before the ring opens
});
