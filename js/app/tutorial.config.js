// tutorial.config.js — every number and word of the first-visit tour ("Your first night"), in one
// place. Pure: imports in Node. The rules live in tutorial-steps.js; the screen (T2) in
// tutorial.js. Spec: docs/design/specs/2026-10-15-tutorial.md (sections 3, 4.2, 6, 9, 13).
//
// Values marked GUESS are first values from the spec, not yet tried with a real voice in a real
// room. Retune here, nowhere else; the page takes its words from here too (wording polish: Tony).

const f = Object.freeze;

export const TOUR = f({
  storageKey: 'music-trainer.tour.v1',
  // Owner decisions 1 and 3 (spec section 12), taken as the defaults: the guide reads aloud
  // unless switched off, and the tour is offered once, never started by itself.
  voiceDefault: true,
  counted: 7, // step 0 (the invitation) is not counted: "3 of 7"

  // Step 1: waking the guide star. About 1 s of humming in total; a breath only pauses it and
  // after the grace it drains at half speed, so nothing resets to zero on a breath.
  wake: f({ needMs: 1000, graceMs: 250, drain: 0.5 }),     // needMs spec; drain spec ("half speed")
  // Step 2: landing on the line. Grace and drain as Match and hold (config.hold), band looser.
  land: f({ needMs: 1000, graceMs: 250, drain: 2 }),       // drain 2 as config.hold.drainRate
  bandCents: 50,                                           // GUESS (looser than Match and hold)
  // Frame gaps longer than this give no credit (a stalled tab must not land the note).
  maxFrameMs: 100,                                         // GUESS
  keyRiseMs: 1200,          // stand-in: the star rises onto the line over 1.2 s while Space is held
  noteMs: 1200,             // Play the note: the target sounds this long

  // Match target: the hummed note + 2 semitones (slide up a little), clamped; A3 for the key path.
  target: f({ upSemis: 2, minMidi: 45, maxMidi: 72, keyMidi: 57 }),

  // Turn-taking (6.1): the ear stays shut while the guide speaks or the note plays, and after.
  earAfterSpeechMs: 250,
  earAfterNoteMs: 150,

  // Reading time (6.2): max(3000 ms, 260 ms per word), or the utterance + 600 ms if longer.
  reading: f({ minMs: 3000, perWordMs: 260, afterSpeechMs: 600 }),

  // Silence on steps 1 and 2: the hint after 8 s, the key path becomes the primary after 20 s.
  hintAfterMs: 8000,
  keyPrimaryAfterMs: 20000,

  // Step 3: a drag this long on the sky, or this many arrow presses.
  lookDragPx: 60,
  lookArrows: 2,

  // The guide voice (6.3): local English voices only; these accents preferred after the default.
  voice: f({ langPrefix: 'en', prefer: f(['en-GB', 'en-US']), rate: 1, pitch: 1 }),

  // Card docking (4.2), in CSS px. 16 = --s4, 32 = --s6.
  dock: f({
    clearPx: 16,          // the card keeps this far from the spotlit target
    bottomPx: 32,         // --s6 above the bottom edge
    sidePx: 16,           // --s4 each side when narrow
    maxW: 440,
    topPx: 64,            // GUESS: the top strip's height; the card docks just under it
    narrowBelow: 760,     // links mode: full width, docked bottom
    gutterFrom: 1100,     // reading screens this wide: bottom right, in the gutter
  }),

  // The pill shows once more on a later day, then the tour counts as ended (4.3).
  dayMs: 86400000,
});

// The steps in order (section 3). `at` is the route the step starts on; `goes` the route a
// visit step waits for; `lines` the card's line(s): steps 4 to 6 show one line at a time.
// The spoken guide reads exactly these words, nothing else.
export const TOUR_STEPS = f([
  f({ id: 'invite', n: 0, at: '#/sky', title: 'Your first night',
    lines: f(['A two-minute tour of the sky. You can skip it any time.']),
    buttons: f(['Start the tour', 'Not now']), toggle: 'Read it aloud' }),
  f({ id: 'wake', n: 1, at: '#/sky', title: 'Wake the guide star', mic: true,
    lines: f(['Hum any note, soft and easy. The star is listening.']),
    small: 'The mic is on only for this step and the next. Nothing is recorded.',
    buttons: f(['Turn on my mic', 'Use a key instead']), keyButton: 'Hold to hum' }),
  f({ id: 'land', n: 2, at: '#/sky', title: 'Sing it onto the line', mic: true,
    lines: f(['Press Play the note, then slide your voice until the star sits on the line. Hold it.']),
    buttons: f(['Play the note', 'Use a key instead']), keyButton: 'Hold to sing' }),
  f({ id: 'landed', n: 2, at: '#/sky', title: 'In tune!', target: 'mic-chip',
    lines: f(['That is the whole idea: hear a note, find it, hold it. Your mic is off again.']),
    buttons: f(['Next']) }),
  f({ id: 'look', n: 3, at: '#/sky', title: 'Look around', domeOnly: true,
    lines: f(['Drag the sky, or use the arrow keys. Home turns you back to Tonight.']),
    buttons: f(['Next']) }),
  f({ id: 'places', n: 4, at: '#/sky', title: 'The places',
    lines: f([
      'Tonight: five minutes of practice a day.',
      'The Ladder: exercises, one skill each.',
      'The Open Sky: sing anything, nothing to pass.',
      'The Lyre: sing along with songs.',
      'Your Sky: your progress, behind you.',
      'Keys 1 to 5 jump straight to a place.',
    ]),
    places: f(['tonight', 'ladder', 'open', 'lyre', 'yours', null]),
    buttons: f(['Next']) }),
  f({ id: 'ladder', n: 5, at: '#/sky', goes: '#/practice', title: 'Visit The Ladder',
    lines: f([
      'Press 2, or click The Ladder.',
      'Each exercise trains one skill. Match and hold is a good first one.',
      'Press Esc, or Back to the sky, to come home.',
    ]),
    buttons: f(['Next']) }),
  f({ id: 'lyre', n: 6, at: '#/sky', goes: '#/songs', title: 'Visit The Lyre',
    lines: f([
      'Press 4, or click The Lyre.',
      'Sing along with songs here. Demo songs are ready, and you can add your own.',
      'Press Esc to come home.',
    ]),
    buttons: f(['Next']) }),
  f({ id: 'end', n: 7, at: '#/sky', title: 'That is the sky',
    lines: f(["Tonight's five minutes start here whenever you are ready."]),
    small: 'Replay the tour any time: Settings › Tour.',
    buttons: f(['Start tonight', 'Close']) }),
]);

// Every other word the tour shows (section 13).
export const TOUR_WORDS = f({
  next: 'Next',
  skip: 'Skip tour',
  useKey: 'Use a key instead',
  stepOf: (n, of) => `${n} of ${of}`,
  listening: 'Listening',
  speaking: 'Guide speaking',
  hint: "I can't hear you yet. Try a long, soft 'mmm'.",
  noMic: 'No microphone right now. Hold Space or the button to hum instead.',
  humming: (name) => `You are humming ${name}`,
  higher: 'higher',
  lower: 'lower',
  paused: (n, of) => `Tour paused · step ${n} of ${of}`,
  carryOn: 'Carry on',
  endTour: 'End tour',
  settingsTitle: 'Tour',
  again: 'Take the tour again',
  readAloud: 'Read the tour aloud',
  noVoice: 'This computer has no offline voice for the tour, so it shows words only.',
});
