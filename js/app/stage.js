// stage.js — the pitch stage: one canvas component shared by every live view
// (docs/design/specs/2026-10-12-singing-trainer.md section 5).
//
// The file has two halves. The PURE half (everything above createStage) touches no browser
// global and imports in Node, so tools/checks/stage.check.mjs tests the rules themselves.
// createStage() is the browser half: it only draws what the pure half decided.
//
// CONTRACT — pure helpers
//   verdict(cents, cfg?) -> { kind, dir, word, icon, move }
//       cents: signed cents from the target (negative = low). kind 'in' | 'close' | 'off';
//       not a finite number -> kind 'listening'. dir 'low' | 'high'. move 'up' | 'down' |
//       null is the way the VOICE should move (STYLE.md section 3). No memory: the
//       instantaneous class.
//   createVerdictGate(cfg?) -> { push(cents | null, tMs) -> verdict, current(), reset() }
//       The verdict as shown: a change must be marginCents past the line and hold for
//       holdMs. null (unvoiced) returns 'listening' without forgetting the held verdict
//       unless the silence outlasts 2 * holdMs.
//   layout({ width, height, lanes, centreMidi, nowFrac, pxPerSec, gutter? }) -> geometry
//       { plotX, plotW, laneH, nowX, topMidi, bottomMidi, labelMode, secondsBefore,
//         secondsAfter, tooSmall, yOfMidi(m), xOfTime(t, now), labels() }
//       CSS pixels, y down. One lane per semitone, a note's line at the lane's middle.
//       labelMode 'naturals' (lane >= 18 px) | 'ceg' (>= 10 px) | 'c'.
//   lanesFor({ wide, lowMidi, highMidi }, cfg?) -> lanes shown (14, or range + 3 either side, <= 36)
//   markStep(dtSec, looping, fadeMs?) -> 0..1: how far the head tag and the out-of-view chip
//       ease in one render (1 = at once, for a still picture with no loop running)
//   stepCentre(centre, goal, dtSec, cfg?) -> new centre: eased, never faster than
//       recentreMaxSemisPerSec, so the view cannot jump.
//   centreGoal({ goal, focus, target, lanes }, cfg?) -> where the view should rest
//   segmentRuns(points, cfg?) -> [{ from, to, dot }]  index ranges of voiced runs. Runs
//       break at every unvoiced point and at every time gap over maxJoinGapSec: a gap is
//       never bridged. dot = shorter than dotRunSec.
//   voicePieces(points, cfg?) -> [{ from, to, dot, leap }]  the runs, cut again wherever two
//       neighbouring voiced points are more than leapSemis apart. leap = this piece is
//       joined to the one before it by the thin quiet connector (same run, no silence
//       between). The line is never drawn in a verdict colour across a leap.
//   roundCents, numberText(cents), displayNote(midi, style)
//       numberText: "12 cents low" · "On the note" · beyond verdict.farCents it counts in
//       notes: "2 notes low", "1 note high" (a beginner cannot use "1700 cents").
//   tagText(noteText, cents)   the head tag with NO target: "A3 ±0", "A3 −12"
//   targetTagText(cents)       the head tag WITH a target: the distance from the target and
//       no note name: "80 high", "12 low", "on it", "17 notes high". (A nearest-note
//       name beside a cents-from-target number read as a false statement: review 1, M1.)
//   createReadout(config?) -> { push(frame, { target?, level?, noteStyle? }) -> readout, reset() }
//       readout = { t, voiced, midi, level, hasTarget, target, note, against, cents,
//                   verdict (gated, for the words and the hint),
//                   kind (for the history point, the head dot and the needle: the gated
//                   kind, except that beyond verdict.farCents it is 'off' at once),
//                   noClearNoteMs, shown }
//       shown = what the words say: { listening, noteMidi, noteText, cents (rounded),
//               numberText, tagText, verdict }. It changes at most hud.readoutHz times a
//               second and is the ONLY source for the head tag, the HUD number and the
//               chip, which is why they cannot disagree.
//   octaveSide(cents, tolCents?) -> 'lower' | 'higher' | null: the voice is on the target's
//       note one octave away. OCTAVE_WORDS: side -> "Right note, one octave lower".
//       createReadout.push(frame, { octaveCents }) (a number turns it on): such a reading is
//       never "off": verdict { kind: 'close', octave: side, word: OCTAVE_WORDS[side] },
//       kind 'close', no number ("12 notes low" would call a right note wrong; review 2).
//   isViewJump(fromMidi, toMidi, cfg?) -> a target change this big is cross-faded, not slid
//   starField(seed, count) -> fixed dots for the Dusk sky
//   ribbonFromTimeline(timeline, { half = 1.5, joinGapSec = 0.05 }) -> ribbon
//       ribbon = { half, t0, t1, low, high, segments: [{ t0, t1, pts: [{ t, midi }], m }] }
//       The smooth path through a stepped timeline (glide, siren): one segment per run of
//       back-to-back notes, waypoints at each note's middle plus both ends. half: semitones
//       either side of the centre (1.5 = the spec's band 3 semitones tall). low / high are the
//       lowest and highest centre; the monotone curve never goes past them.
//   ribbonMidiAt(ribbon, t) -> midi | null   the centre at take time t (null between passes)
//   ribbonInside(cents, halfCents, wasIn?, marginCents?) -> boolean | null   with hysteresis
//   ribbonVerdict(inside, centreCents) -> verdict   kind 'in' "With the path" | 'close'
//       "Off the path" (with move and an arrow icon); never 'off'. RIBBON_WORDS.
//   createReadout.push(frame, { ribbon: { midi, half } }): the ribbon stands in for the target.
//       verdict / kind from ribbonVerdict; cents (and shown.cents) are measured from the
//       path's nearest EDGE (0 inside); shown.numberText "With the path" inside, else
//       "40 cents low"; readout.path = { inside, centreCents }.
//
// CONTRACT — createStage(host, { config? }) -> stage            [browser only]
//   stage.el, stage.canvas
//   stage.set({ state, target, nowFrac, pxPerSec, wide, range, calm, noteStyle, countIn, cursor,
//               octaveCents, freshTarget, labelClearTopPx, grid, voiceAlpha, nowLine, ribbon, ribbonMarks,
//               ribbonJudge, noteMarks, barLabels })
//       ribbon: null | ribbonFromTimeline(...) in the same clock as the frames pushed. Drawn
//           instead of a band (use target null with it): filled --target-halo, dotted centre,
//           a dot at the now line, and behind the dot a --good-wash fill where the voice was
//           inside and hatched --close-wash where it was outside. Readings inside a pass are
//           judged against it (createReadout's ribbon); between passes there is no target.
//           The view rests on the middle of the whole path. A new ribbon cross-fades over
//           targetFadeMs while the loop runs.
//       ribbonMarks: null | [{ t, midi }] small hollow diamonds on the path (siren breaks)
//       ribbonJudge: 'path' (default: Glide, Siren) | 'note': the ribbon's centre at a reading's
//           time is handed to the readout as a plain target (normal in 25 / close 50 / off gate,
//           normal voice-line styles) instead of "with the path". Pure: ribbonReading().
//       noteMarks: null | [{ t0, t1, midi, kind: 'in'|'close'|'off'|'none', dir: 'low'|'high'|null }]
//           restyles each judged bar (half = ribbon.half): in = solid --good + tick, close =
//           --close hatch + arrow, off = outline + arrow, none = dotted outline + three dots.
//           A bar's new look eases in over CONFIG.stage.noteMarkMs (300; calm motion too: a fade).
//           A new ribbon cross-fades with the old one, whose marks and labels fade out with it
//           where they were (Star steps' next item restarts the clock; a cut read 0.26).
//           Pure: NOTE_MARK_LOOKS, noteMarkLook(kind), markEase(sinceMs, nowMs, ms).
//       barLabels: false (default) | true | [syllable per bar]: note name above each bar
//           (--quiet, 11 px), syllable below ('la' when true); bars under
//           CONFIG.stage.barLabelMinPx (default 28) px wide get none, nor does anything above
//           labelClearTopPx. Pure: barLabelPlan(ribbon, { syllables, noteStyle, pxPerSec, minPx }).
//       nowLine: true (default) | false: the upright "now" line and its "now" pill are not
//           drawn (the voice check's ten notes and six tunes: nothing scrolls there, so a
//           now-line promises a moving reading that never comes; voice-check review C2).
//           Only the drawing changes: layout.nowX and everything placed by it stay.
//       grid: 'full' (default) | 'quiet': only the C lines and the C names, fainter, and a
//           denser star field (Find your range: a sky, not a chart; review 4, finding 6a).
//           The strengths are config.stage.quietGrid.
//       voiceAlpha: 0..1, how strongly the voice line is drawn (default 1; a result picture
//           dims it so that what was measured reads first)
//       octaveCents: null (off) | tolerance for the octave rule above
//       freshTarget: each new target is a new note. The old trail fades out over
//           freshHoldMs and the view waits that long before it slides; while it slides
//           (state 'tone') the new band is drawn where it will come to rest, so only thin
//           lane lines travel. Default false: the trail stays and the band rides its lane
//           (Free sing).
//       labelClearTopPx: no lane names in the top this many px (a chip sits there)
//       A target that changes by more than jumpFadeSemis while the loop runs never slides:
//       the old picture (lanes, band, trail) fades out where it was and the new one fades in
//       already centred, over targetFadeMs. The old trail is not drawn again after it.
//       wide + range { low, high } (midi): the wide view, the range plus 3 lanes either side
//       cursor: seconds from the start of the take (review only)
//       state: 'idle' | 'starting' | 'live' | 'paused' | 'lost' | 'tone' | 'countin' | 'review'
//       target: null | { midi, t0?, t1? }   (no times = a band across the whole width)
//   stage.push(frame, level = 0) -> readout     a pitch frame (js/pitch.js) while 'live';
//       ignored in every other state, so a paused or lost stage stays frozen.
//   stage.readout()        the last readout, or null
//   stage.points()         a copy of the history: [{ t, midi | null, kind }]
//   stage.showTake(points) review state: the whole take fitted to the width
//   stage.reset()          forget the history
//   stage.render()         draw once (the lab's still tiles)
//   stage.settle()         place the view on its goal at once (for a picture built in one
//                          go, where nothing was on screen that could be seen to jump)
//   stage.start() / stop() the animation loop; it also stops by itself while the tab is
//                          hidden or the stage is off screen
//   stage.recentre()       cross-fade to the view centred on the target and keep it there
//                          (a result card: the last band must not sit under the card)
//   stage.fit({ low, high } | null, { ms = 0 } = {})   show exactly low - widePadSemis to
//                          high + widePadSemis (midi), whatever was in view, and stay there:
//                          the result picture of Find your range, where no end may be out of
//                          view. While the loop runs the old view cross-fades to the new one
//                          over ms; ms 0 or a still picture: at once. null: back to the view
//                          that follows the voice. Not capped at lanesWideMax.
//   stage.addLayer(fn)     fn(ctx, geometry, tokens, view) is drawn above the head (reward
//                          layer). view = { from, k }: during a cross-fade `from` is the old
//                          picture's geometry and k its 0..1 progress; else from is null, k 1.
//   stage.onResume(fn), stage.destroy()
//   stage.hold(k | null)   k 0..1: the hold ring's fill for the reading just pushed; the aurora
//           grows with it. After the first call the stage stops timing holds itself, until
//           null or reset().
//   stage.debug() -> { centre, goal, runs, leaps, head, tag, out, running, state, width, height, fading }
//
// Not here yet (later build items): the reward layer and the edge glow. addLayer leaves room
// for them. debug().ribbon = { dot (the dot's midi or null), marks } while a ribbon is set.

import { nearestNote } from '../notes.js';
import { auroraSprites, createCurtain, drawCurtain, follow, isLightColour, levelToLv, sharedGuard } from './aurora.js';
import { CONFIG } from './config.js';
import { readRange } from './range.js';
import { h, icon } from './shell.js';

// ---------------------------------------------------------------- pure: verdicts

const LISTENING = Object.freeze({ kind: 'listening', dir: null, word: 'Listening', icon: 'dots', move: null });
const FREE = Object.freeze({ kind: 'free', dir: null, word: '', icon: null, move: null });

function describe(kind, dir) {
  if (kind === 'in') return { kind, dir, word: 'In tune', icon: 'tick', move: null };
  const move = dir === 'low' ? 'up' : 'down';
  if (kind === 'close') return { kind, dir, word: `Close: a little ${dir}`, icon: 'wave', move };
  return dir === 'low'
    ? { kind, dir, word: 'Too low: slide up', icon: 'arrow-up', move }
    : { kind, dir, word: 'Too high: come down', icon: 'arrow-down', move };
}

const RANK = ['in', 'close', 'off'];

export function verdict(cents, cfg = CONFIG.verdict) {
  if (!Number.isFinite(cents)) return LISTENING;
  const abs = Math.abs(cents);
  const kind = abs <= cfg.inTuneCents ? 'in' : abs <= cfg.closeCents ? 'close' : 'off';
  return describe(kind, cents < 0 ? 'low' : 'high');
}

export function createVerdictGate(cfg = CONFIG.verdict) {
  const lines = [cfg.inTuneCents, cfg.closeCents];
  let cur = null, pendingKey = null, pendingSince = 0, lastVoicedMs = -Infinity;
  // 'in' has one key whichever side of the note the voice is on: drifting from 3 cents low
  // to 3 cents high is not a change of verdict.
  const keyOf = (v) => (v.kind === 'in' ? 'in' : `${v.kind}:${v.dir}`);

  return {
    push(cents, tMs) {
      if (!Number.isFinite(cents)) return LISTENING;
      if (tMs - lastVoicedMs > 2 * cfg.holdMs) cur = null;   // a new note: judge it afresh
      lastVoicedMs = tMs;
      const dir = cents < 0 ? 'low' : 'high';
      if (!cur) {
        cur = verdict(cents, cfg);
        pendingKey = null;
        return cur;
      }
      // Hysteresis: to leave the current class the voice must pass the line by the margin.
      const abs = Math.abs(cents);
      let r = RANK.indexOf(cur.kind);
      while (r < 2 && abs > lines[r] + cfg.marginCents) r++;
      while (r > 0 && abs < lines[r - 1] - cfg.marginCents) r--;
      const cand = describe(RANK[r], dir);
      const key = keyOf(cand);
      if (key === keyOf(cur)) {
        pendingKey = null;
        cur = cand;                 // same verdict; keep the side up to date for 'in'
      } else if (key !== pendingKey) {
        pendingKey = key;
        pendingSince = tMs;
      } else if (tMs - pendingSince >= cfg.holdMs) {
        cur = cand;
        pendingKey = null;
      }
      return cur;
    },
    current: () => cur,
    reset() { cur = null; pendingKey = null; lastVoicedMs = -Infinity; },
  };
}

// The same note one octave away is a right note in another voice, not a miss (review 2).
export const OCTAVE_WORDS = Object.freeze({ lower: 'Right note, one octave lower', higher: 'Right note, one octave higher' });

export function octaveSide(cents, tolCents = CONFIG.hold.octaveCents) {
  if (!Number.isFinite(cents)) return null;
  if (Math.abs(cents + 1200) <= tolCents) return 'lower';
  if (Math.abs(cents - 1200) <= tolCents) return 'higher';
  return null;
}

const OCTAVE_VERDICT = Object.freeze({
  lower: Object.freeze({ kind: 'close', dir: 'low', word: OCTAVE_WORDS.lower, icon: 'octave', move: null, octave: 'lower' }),
  higher: Object.freeze({ kind: 'close', dir: 'high', word: OCTAVE_WORDS.higher, icon: 'octave', move: null, octave: 'higher' }),
});

export function isViewJump(fromMidi, toMidi, cfg = CONFIG.stage) {
  return Number.isFinite(fromMidi) && Number.isFinite(toMidi) && Math.abs(toMidi - fromMidi) > cfg.jumpFadeSemis;
}

// ---------------------------------------------------------------- pure: ribbons (glide, siren)
// A timeline cannot hold a glide (contract), so a glide or siren is written as back-to-back
// semitone steps and the ribbon is the smooth path through them. Monotone cubic (Fritsch and
// Carlson) and not a plain spline: a plain spline overshoots at the top of a hill, which would
// draw the path above the highest note the singer was asked for.

export const RIBBON_WORDS = Object.freeze({ in: 'With the path', off: 'Off the path', tagIn: 'on the path' });

export function ribbonFromTimeline(timeline, { half = 1.5, joinGapSec = 0.05 } = {}) {
  const notes = ((timeline && timeline.notes) || []).filter((n) => n && Number.isFinite(n.midi) && Number.isFinite(n.t) && n.dur > 0);
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && n.t - g.end <= joinGapSec) { g.notes.push(n); g.end = Math.max(g.end, n.t + n.dur); } else groups.push({ notes: [n], end: n.t + n.dur });
  }
  const segments = groups.map(({ notes: ns, end }) => {
    const pts = [{ t: ns[0].t, midi: ns[0].midi }, ...ns.map((n) => ({ t: n.t + n.dur / 2, midi: n.midi })), { t: end, midi: ns[ns.length - 1].midi }];
    return { t0: ns[0].t, t1: end, pts, m: monotoneSlopes(pts) };
  });
  const all = segments.flatMap((s) => s.pts.map((p) => p.midi));
  return {
    half, segments,
    t0: segments.length ? segments[0].t0 : 0, t1: segments.length ? segments[segments.length - 1].t1 : 0,
    low: all.length ? Math.min(...all) : null, high: all.length ? Math.max(...all) : null,
  };
}

function monotoneSlopes(pts) {
  const n = pts.length, d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { const dt = pts[i + 1].t - pts[i].t; d.push(dt > 0 ? (pts[i + 1].midi - pts[i].midi) / dt : 0); }
  if (n < 2) return m;
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return m;
}

// The path's centre (midi) at take time t (seconds), or null between and outside its passes.
export function ribbonMidiAt(ribbon, t) {
  if (!ribbon || !Number.isFinite(t)) return null;
  for (const s of ribbon.segments) {
    if (t < s.t0 || t > s.t1) continue;
    const p = s.pts;
    let lo = 0, hi = p.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid].t <= t) lo = mid; else hi = mid; }
    const a = p[lo], b = p[hi], h0 = b.t - a.t;
    if (!(h0 > 0)) return a.midi;
    const u = (t - a.t) / h0, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * a.midi + (u3 - 2 * u2 + u) * h0 * s.m[lo] + (-2 * u3 + 3 * u2) * b.midi + (u3 - u2) * h0 * s.m[hi];
  }
  return null;
}

// Inside the path or not, with a little hysteresis (marginCents) so a voice riding the edge
// does not flicker between the two colours. wasIn null = no memory.
export function ribbonInside(cents, halfCents, wasIn = null, marginCents = CONFIG.verdict.marginCents) {
  if (!Number.isFinite(cents)) return null;
  const a = Math.abs(cents);
  if (wasIn === true) return a <= halfCents + marginCents;
  if (wasIn === false) return a < halfCents - marginCents;
  return a <= halfCents;
}

// The warm-up's two gentle verdicts (spec 7.1): "With the path" (the good style) and
// "Off the path" (the close style, with the arrow the voice should move). Never 'off' (pink).
export function ribbonVerdict(inside, cents) {
  if (inside) return { kind: 'in', dir: null, word: RIBBON_WORDS.in, icon: 'tick', move: null, path: true };
  const dir = cents < 0 ? 'low' : 'high', move = dir === 'low' ? 'up' : 'down';
  return { kind: 'close', dir, word: RIBBON_WORDS.off, icon: move === 'up' ? 'arrow-up' : 'arrow-down', move, path: true };
}

// ---------------------------------------------------------------- pure: words and numbers

// One rounding for every place a cents number is shown. "+ 0" turns -0 into 0.
// ---------------------------------------------------------------- pure: note bars (Star steps)
// A ribbon of flat bars (one per note, ribbonFromTimeline with half 0.5) can be judged as
// notes instead of as a path: 'note' hands the bar's centre to the readout as an ordinary
// target, so a reading gets the normal gate (in 25 / close 50 / off) and the voice line the
// usual in / close / off styles. 'path' (the default) is Glide and Siren, unchanged.
export function ribbonReading(ribbon, t, judge = 'path') {
  const rm = ribbon ? ribbonMidiAt(ribbon, t) : null;
  if (rm === null) return { target: null, ribbon: null };
  return judge === 'note' ? { target: rm, ribbon: null } : { target: null, ribbon: { midi: rm, half: ribbon.half } };
}

// How a judged bar looks (STYLE 3, "target bar after the note"). fill: a token name or null;
// outline: 'solid' | 'dotted' | null; glyph drawn at the bar's right end.
export const NOTE_MARK_LOOKS = Object.freeze({
  in: Object.freeze({ fill: 'good', hatch: false, outline: null, glyph: 'tick' }),
  close: Object.freeze({ fill: 'close', hatch: true, outline: null, glyph: 'arrow' }),
  off: Object.freeze({ fill: null, hatch: false, outline: 'solid', glyph: 'arrow' }),
  none: Object.freeze({ fill: null, hatch: false, outline: 'dotted', glyph: 'dots' }),
});
export function noteMarkLook(kind) { return NOTE_MARK_LOOKS[kind] || null; }

// A bar's new look eases in (0..1) over ms since its verdict arrived; ms 0 (calm) is at once.
export function markEase(sinceMs, nowMs, ms = 200) {
  if (!(ms > 0)) return 1;
  return Math.min(1, Math.max(0, (nowMs - sinceMs) / ms));
}

// The labels over and under each bar: the note name above, a syllable below ('la' unless an
// array gives one per bar, e.g. the scale's '1 2 3 4 5 4 3 2 1'). show is false for a bar
// narrower than minPx at this speed, so labels never pile up at a very high tempo.
export function barLabelPlan(ribbon, { syllables = null, noteStyle = 'letters', pxPerSec = 120, minPx = 28 } = {}) {
  if (!ribbon || !ribbon.segments) return [];
  return ribbon.segments.map((s, i) => {
    const midi = Math.round(ribbonMidiAt(ribbon, (s.t0 + s.t1) / 2) ?? s.pts[0].midi);
    const widthPx = (s.t1 - s.t0) * pxPerSec;
    const syll = Array.isArray(syllables) ? String(syllables[i] ?? '') : 'la';
    return { t0: s.t0, t1: s.t1, midi, name: displayNote(midi, noteStyle).text, syll, widthPx, show: widthPx >= minPx };
  });
}

export const roundCents = (cents) => Math.round(cents) + 0;

export function numberText(cents, cfg = CONFIG.verdict) {
  if (!Number.isFinite(cents)) return '';
  const r = roundCents(cents);
  if (Math.abs(r) <= cfg.onNoteCents) return 'On the note';
  const dir = r < 0 ? 'low' : 'high';
  if (Math.abs(r) > cfg.farCents) {
    const notes = Math.round(Math.abs(r) / 100);
    return `${notes} ${notes === 1 ? 'note' : 'notes'} ${dir}`;
  }
  return `${Math.abs(r)} cents ${dir}`;
}

// The same words as the number line, shortened: the two can never say different things.
export function targetTagText(cents, cfg = CONFIG.verdict) {
  const text = numberText(cents, cfg);
  return text === 'On the note' ? 'on it' : text.replace(' cents ', ' ');
}

export function tagText(noteText, cents) {
  if (!Number.isFinite(cents)) return noteText;
  const r = roundCents(cents);
  // A real minus sign: a hyphen reads as a dash next to a note name.
  return `${noteText} ${r === 0 ? '±0' : r < 0 ? `−${-r}` : `+${r}`}`;
}

const SOLFEGE = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Ti' };

export function displayNote(midi, style = 'letters') {
  const n = nearestNote(midi);
  if (!n) return null;
  const letter = n.name[0], sharp = n.name[1] === '#';
  const base = (style === 'solfege' ? SOLFEGE[letter] : letter) + (sharp ? '♯' : '');
  return { base, octave: n.octave, text: `${base}${n.octave}`, midi: n.midi };
}

// ---------------------------------------------------------------- pure: geometry

const NATURALS = new Set([0, 2, 4, 5, 7, 9, 11]);
const CEG = new Set([0, 4, 7]);

export function lanesFor({ wide = false, lowMidi, highMidi } = {}, cfg = CONFIG.stage) {
  if (!wide || !Number.isFinite(lowMidi) || !Number.isFinite(highMidi)) return cfg.lanesNormal;
  const span = Math.ceil(highMidi) - Math.floor(lowMidi) + 1 + 2 * cfg.widePadSemis;
  return Math.min(cfg.lanesWideMax, Math.max(cfg.lanesNormal, span));
}

export function layout({
  width, height, lanes = CONFIG.stage.lanesNormal, centreMidi = 57,
  nowFrac = CONFIG.stage.nowFracFree, pxPerSec = CONFIG.stage.pxPerSecExercise,
  gutter = CONFIG.stage.gutterPx,
} = {}) {
  const plotX = gutter, plotW = Math.max(1, width - gutter);
  const laneH = height / lanes;
  const topMidi = centreMidi + lanes / 2, bottomMidi = centreMidi - lanes / 2;
  const nowX = plotX + plotW * nowFrac;
  const yOfMidi = (m) => (topMidi - m) * laneH;
  const labelMode = laneH >= 18 ? 'naturals' : laneH >= 10 ? 'ceg' : 'c';
  return {
    width, height, lanes, centreMidi, plotX, plotW, laneH, nowX, topMidi, bottomMidi,
    pxPerSec, labelMode,
    secondsBefore: (nowX - plotX) / pxPerSec,
    secondsAfter: (plotX + plotW - nowX) / pxPerSec,
    tooSmall: width < CONFIG.stage.minWidthPx || height < CONFIG.stage.minHeightPx,
    yOfMidi,
    xOfTime: (t, now) => nowX + (t - now) * pxPerSec,
    // Every lane line in view, with whether its name is written.
    labels() {
      const out = [];
      for (let m = Math.ceil(bottomMidi); m <= Math.floor(topMidi); m++) {
        const pc = ((m % 12) + 12) % 12;
        const named = labelMode === 'naturals' ? NATURALS.has(pc) : labelMode === 'ceg' ? CEG.has(pc) : pc === 0;
        out.push({ midi: m, y: yOfMidi(m), isC: pc === 0, named });
      }
      return out;
    },
  };
}

export function stepCentre(centre, goal, dtSec, cfg = CONFIG.stage) {
  if (!(dtSec > 0)) return centre;
  // An exponential approach that covers about 95 % of a step in recentreStepMs...
  const k = 1 - Math.exp(-dtSec / (cfg.recentreStepMs / 3000));
  let d = (goal - centre) * k;
  // ...but never faster than the cap, so a big leap is a calm slide and not a jump.
  const cap = cfg.recentreMaxSemisPerSec * dtSec;
  if (Math.abs(d) > cap) d = Math.sign(d) * cap;
  const next = centre + d;
  return Math.abs(goal - next) < 0.002 ? goal : next;
}

export function centreGoal({ goal, focus, target = null, lanes }, cfg = CONFIG.stage) {
  const half = (lanes * cfg.actionBandFrac) / 2;
  if (Number.isFinite(target)) {
    // The target owns the middle. Only when the voice is out of the action band does the
    // view lean toward it, and never so far that the target leaves the band.
    if (!Number.isFinite(focus) || Math.abs(focus - target) <= half) return Math.round(target);
    return Math.round(target + Math.sign(focus - target) * half);
  }
  if (!Number.isFinite(focus)) return goal;
  // Free singing: stay put while the voice is inside the band, so the lanes do not swim
  // with every wobble. Whole semitones keep the labels on steady pixels.
  return Math.abs(focus - goal) <= half ? goal : Math.round(focus);
}

export function segmentRuns(points, cfg = CONFIG.stage) {
  const runs = [];
  let from = -1;
  const close = (to) => {
    if (from < 0) return;
    runs.push({ from, to, dot: points[to].t - points[from].t < cfg.dotRunSec });
    from = -1;
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const voiced = p && Number.isFinite(p.midi);
    if (!voiced) { close(i - 1); continue; }
    if (from >= 0 && p.t - points[i - 1].t > cfg.maxJoinGapSec) close(i - 1);
    if (from < 0) from = i;
  }
  close(points.length - 1);
  return runs;
}

export function voicePieces(points, cfg = CONFIG.stage) {
  const pieces = [];
  for (const run of segmentRuns(points, cfg)) {
    let from = run.from, leap = false;
    for (let i = run.from + 1; i <= run.to + 1; i++) {
      if (i <= run.to && Math.abs(points[i].midi - points[i - 1].midi) <= cfg.leapSemis) continue;
      pieces.push({ from, to: i - 1, dot: points[i - 1].t - points[from].t < cfg.dotRunSec, leap });
      from = i;
      leap = true;
    }
  }
  return pieces;
}

// Small seeded generator (mulberry32) so the sky is the same on every load.
export function starField(seed = CONFIG.stage.starSeed, count = CONFIG.stage.starCount) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: rnd(), y: rnd() / 3, r: 0.6 + rnd() * 0.7, a: 0.20 + rnd() * 0.15,
  }));
}

// ---------------------------------------------------------------- pure: the readout

export function createReadout(config = CONFIG) {
  const gate = createVerdictGate(config.verdict);
  const minGap = 1 / config.hud.readoutHz;
  let shown = null, shownT = -Infinity, unvoicedSince = null, noisySince = null, pathIn = null;

  const listeningShown = () => ({
    listening: true, noteMidi: null, noteText: '–', cents: null, numberText: '', tagText: '', verdict: LISTENING,
  });

  return {
    push(frame, { target = null, level = 0, noteStyle = 'letters', octaveCents = null, ribbon = null } = {}) {
      const t = frame.t;
      const voiced = !!frame.voiced && Number.isFinite(frame.midi);
      // A ribbon (glide, siren) stands in for the target: its centre at this reading's time.
      const path = ribbon && Number.isFinite(ribbon.midi) && ribbon.half > 0 ? ribbon : null;
      if (path) target = path.midi; else pathIn = null;
      const hasTarget = Number.isFinite(target);
      const due = t - shownT >= minGap;

      if (!voiced) {
        if (unvoicedSince === null) unvoicedSince = t;
        // Sound with no pitch in it (breath, speech, a noisy room): timed so the HUD can
        // say so. Silence is not this.
        if (level > config.mic.silenceRms) { if (noisySince === null) noisySince = t; } else noisySince = null;
        const longEnough = (t - unvoicedSince) * 1000 >= config.verdict.holdMs;
        if ((!shown || (longEnough && due)) && !(shown && shown.listening)) {
          shown = listeningShown();
          shownT = t;
        }
        return {
          t, voiced: false, midi: null, level, hasTarget, target: hasTarget ? target : null,
          note: null, against: null, cents: null, verdict: LISTENING, kind: null,
          noClearNoteMs: noisySince === null ? 0 : (t - noisySince) * 1000, shown,
        };
      }

      unvoicedSince = null;
      noisySince = null;
      const note = nearestNote(frame.midi);
      if (path) {
        // Distance is measured from the path's EDGE: inside it nothing is wrong, so the
        // needle rests in the middle and the words say "With the path".
        const centreCents = 100 * (frame.midi - path.midi), halfCents = 100 * path.half;
        pathIn = ribbonInside(centreCents, halfCents, pathIn, config.verdict.marginCents);
        const edge = pathIn ? 0 : centreCents - Math.sign(centreCents) * halfCents;
        const v = ribbonVerdict(pathIn, centreCents);
        if (!shown || due) {
          const name = displayNote(frame.midi, noteStyle);
          shown = {
            listening: false, noteMidi: note.midi, noteText: name.text, noteBase: name.base, noteOctave: name.octave,
            cents: roundCents(edge), numberText: pathIn ? RIBBON_WORDS.in : numberText(edge, config.verdict),
            tagText: pathIn ? RIBBON_WORDS.tagIn : targetTagText(edge, config.verdict), verdict: v,
          };
          shownT = t;
        }
        return {
          t, voiced: true, midi: frame.midi, level, hasTarget: true, target: path.midi, note, against: path.midi,
          cents: edge, verdict: v, noClearNoteMs: 0, shown, kind: v.kind, path: { inside: pathIn, centreCents },
        };
      }
      const against = hasTarget ? target : note.midi;
      const cents = 100 * (frame.midi - against);
      const gated = hasTarget ? gate.push(cents, t * 1000) : FREE;
      const oct = hasTarget && octaveCents > 0 ? octaveSide(cents, octaveCents) : null;
      const v = oct ? OCTAVE_VERDICT[oct] : gated;
      if (!shown || due) {
        const name = displayNote(frame.midi, noteStyle);
        shown = {
          listening: false, noteMidi: note.midi, noteText: name.text, noteBase: name.base, noteOctave: name.octave,
          cents: roundCents(cents), numberText: oct ? '' : numberText(cents, config.verdict),
          tagText: oct ? `one octave ${oct}` : hasTarget ? targetTagText(cents, config.verdict) : tagText(name.text, cents), verdict: v,
        };
        shownT = t;
      }
      return {
        t, voiced: true, midi: frame.midi, level, hasTarget, target: hasTarget ? target : null,
        note, against, cents, verdict: v, noClearNoteMs: 0, shown,
        // The hold keeps the WORDS calm. A point this far away is not "in tune" for even
        // 120 ms, so the line, the head dot and the needle show "off" straight away.
        kind: oct ? 'close' : hasTarget && Math.abs(cents) > config.verdict.farCents ? 'off' : v.kind,
      };
    },
    reset() { gate.reset(); shown = null; shownT = -Infinity; unvoicedSince = null; noisySince = null; pathIn = null; },
  };
}

// ---------------------------------------------------------------- browser: the component

const CARD_WORDS = {
  idle: 'Press Start, then sing',
  starting: 'Turning on the microphone…',
  paused: 'Paused',
};

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// How far the head tag and the out-of-view chip move towards shown or hidden in one render:
// a share of markFadeMs while the loop runs, all the way (1) for a still picture.
export function markStep(dtSec, looping, fadeMs = CONFIG.stage.markFadeMs) {
  if (!looping || !(fadeMs > 0)) return 1;
  return Math.min(1, Math.max(0, dtSec) / (fadeMs / 1000)) || 0;
}

export function createStage(host, { config = CONFIG, guard = sharedGuard } = {}) {
  const C = config.stage, AU = config.aurora;
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Live pitch line.', tabindex: '0' });
  const cardText = h('p', { class: 'stage-card-text' });
  const cardIcon = h('div', { class: 'stage-card-icon' });
  const resume = h('button', { class: 'btn btn-secondary', type: 'button', hidden: true },
    'Resume ', h('kbd', { class: 'keycap' }, 'Space'));
  const card = h('div', { class: 'stage-card', 'aria-live': 'polite' }, cardIcon, cardText, resume);
  const caption = h('div', { class: 'stage-caption' });
  const root = h('div', { class: 'stage', dataset: { state: 'idle' } }, canvas, card, caption);
  host.append(root);

  const ctx = canvas.getContext('2d');
  // The voice line is drawn on its own layer so its old end can be faded as one piece.
  const lineCanvas = document.createElement('canvas');
  const lctx = lineCanvas.getContext('2d');
  const stars = starField(C.starSeed, C.starCount);
  const Q = C.quietGrid || { lineK: 0.4, nameK: 0.6, starFactor: 3 };
  // The quiet grid's sky: the same stars first, so switching does not move them.
  const manyStars = starField(C.starSeed, Math.round(C.starCount * Q.starFactor));
  const layers = [];
  const readout = createReadout(config);

  const st = {
    state: 'idle', target: null, nowFrac: C.nowFracFree, pxPerSec: C.pxPerSecExercise,
    wide: false, range: null, calm: false, noteStyle: 'letters', countIn: null, cursor: null,
    octaveCents: null, freshTarget: false, labelClearTopPx: 0, grid: 'full', voiceAlpha: 1, nowLine: true,
    aurora: null, auroraRange: null, ribbon: null, ribbonMarks: null,
    ribbonJudge: 'path', noteMarks: null, barLabels: false,
  };
  let points = [], take = null, last = null, lastVoiced = null;
  // The aurora (js/app/aurora.js). Each trail point keeps the loudness, hold growth and hue it
  // was sung at; the curtain is built from them every frame into one reused column list.
  const curtain = createCurtain(AU, C);
  const auroraTimes = new Float32Array(600), frameTimes = new Float32Array(600);
  let sprites = null, light = false, savedRange = null, timeAt = 0, timeCount = 0;
  let lvNow = null, hueNow = null, inSince = null, pushT = null, holdK = null;
  let auroraGain = null, auroraMs = 0, auroraCols = 0, auroraTier = 0, voicedAtMs = -Infinity, auroraGhost = null, restGain = null;
  // The loop came to rest on a paused (or lost) picture: still frames keep the curtain's rest
  // strength where the pause left it, until the loop next stops or the trail is reset.
  let restHeld = false;
  // A long slide of the view (config.aurora.slideHoldSemis): slideOut while the curtain is
  // away for it, slideGain its strength (0 to 1), curtainLit whether the last frame drew any.
  let slideOut = false, slideGain = null, curtainLit = false;
  // A jump in the readings' clock (push) or reset(): the trail before it, kept for the curtain alone,
  // which eases out where it stood: { pts, now, parts, sinceMs }. The live curtain
  // starts after curtainFromT.
  // litParts: what the last frame drew of the curtain, piece by piece ({ L, k, fromT, upTo };
  // k is every strength but the switch and the guard). A curtain left behind eases out from
  // exactly that, so a trail dropped in the middle of a cross-fade (two layouts, a stepped-back
  // voiceAlpha) does not change brightness in the frame it is dropped.
  let auroraLeft = null, curtainFromT = -Infinity, litParts = [];
  let haloSprites = null, lastSparks = 0;
  let centre = 57, goal = 57, snapNext = true;
  let width = 0, height = 0, dpr = 1, tokens = null;
  let raf = 0, wanted = false, visible = true, lastRenderMs = 0, toneStartMs = 0, labelAtMs = -Infinity;
  let onResume = null, prevTarget = null, targetSinceMs = -Infinity;
  // A ribbon that changes while the loop runs fades like a band: the old one out, the new one in.
  let prevRibbon = null, ribbonSinceMs = -Infinity, ribbonDot = null;
  // The outgoing ribbon's marks and labels, and the clock it was last drawn at (ribbonNow).
  let prevMarks = null, prevLabels = false, prevNow = 0, ribbonNow = 0;
  // A change of picture in progress: { sinceMs, ms, fromCentre, cutT }.
  //   fromCentre  a number: the old picture is drawn where it was (centred there) and fades
  //               out while the new one fades in. null: the view has not moved.
  //   cutT        a time: points up to it belong to the old picture only, and are never
  //               drawn again once it has gone (hideT). null: every point is in both.
  let move = null, hideT = -Infinity, holdUntilMs = 0, pinTarget = false;
  // stage.fit(): { low, high } while the view is fitted to a range, else null. shownLanes is
  // what the last picture used, so a fit can fade from it.
  let fitTo = null, shownLanes = C.lanesNormal;
  // A fresh target's slide in progress: { from } = the centre it left. Both bands are drawn
  // at rest (the old one where it was, the new one where it will be) while the lanes travel:
  // a full-width band sliding and fading in at once measured 0.18 on the flash number.
  let travel = null;

  function readTokens() {
    const cs = getComputedStyle(root);
    const g = (n) => cs.getPropertyValue(n).trim();
    const num = (n) => parseFloat(g(n)) || 0;
    tokens = {
      stage: g('--stage'), stageTop: g('--stage-top'), surface: g('--surface'), text: g('--text'),
      quiet: g('--quiet'), line: g('--line'), lineStrong: g('--line-strong'), accent: g('--accent'),
      good: g('--good'), close: g('--close'), off: g('--off'), target: g('--target'),
      aTargetWash: num('--a-target-wash'), aTargetHalo: num('--a-target-halo'), aGoodWash: num('--a-good-wash'),
      starOpacity: num('--star-opacity'), font: g('--font-ui') || 'system-ui',
      auroraLow: g('--aurora-low'), auroraMid: g('--aurora-mid'), auroraHigh: g('--aurora-high'),
      auroraCrown: g('--aurora-crown'), auroraPeak: num('--aurora-peak') || 1,
    };
    // The light of each verdict and the ribbon's core. A page without them (an older lab)
    // falls back to the verdict colours and the text colour.
    tokens.auroraIn = g('--aurora-in') || tokens.good;
    tokens.auroraClose = g('--aurora-close') || tokens.close;
    tokens.auroraOff = g('--aurora-off') || tokens.off;
    tokens.core = g('--voice-core') || tokens.text;
    haloSprites = null;
    light = isLightColour(tokens.stage) ?? tokens.starOpacity === 0;
    buildSprites();
  }

  // Painted here (first picture, a theme change, calm motion switched), never from the
  // drawing loop: the microphone may be live there. A page without the aurora tokens (an
  // older lab's own stylesheet) simply has no curtain.
  function buildSprites() {
    sprites = tokens && tokens.auroraLow && tokens.auroraCrown ? auroraSprites({
      colours: { good: tokens.auroraIn, close: tokens.auroraClose, off: tokens.auroraOff, core: tokens.core, low: tokens.auroraLow, mid: tokens.auroraMid, high: tokens.auroraHigh, crown: tokens.auroraCrown },
      dpr, calm: !!st.calm, light,
    }, AU) : null;
    // A cold first paint takes a few frames: a still picture is drawn again when it is done.
    const painted = sprites;
    if (painted && !painted.ready) painted.whenReady.then(() => { if (sprites === painted && !raf) render(); });
  }
  // The Settings switch reaches every stage through the page (shell.js sets data-aurora);
  // stage.set({ aurora }) overrides it for a lab.
  const auroraWanted = () => (st.aurora ?? document.documentElement.dataset.aurora !== 'off');
  const readSavedRange = () => { try { savedRange = readRange(window.localStorage); } catch { savedRange = null; } };

  function resize() {
    const r = root.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    const ratio = Math.min(C.dprCap, window.devicePixelRatio || 1);
    if (ratio !== dpr) { dpr = ratio; if (tokens) buildSprites(); }
    for (const c of [canvas, lineCanvas]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    render();
  }

  const colourOf = (kind) => (kind === 'in' ? tokens.good : kind === 'close' ? tokens.close : kind === 'off' ? tokens.off : tokens.accent);
  // The same verdict as light: what the glow, the halo and the curtain are made of.
  const glowOf = (kind) => (kind === 'in' ? tokens.auroraIn : kind === 'close' ? tokens.auroraClose : kind === 'off' ? tokens.auroraOff : tokens.accent);
  const font = (weight, px) => `${weight} ${px}px ${tokens.font}`;

  function pill(g, text, x, y, { align = 'left', alpha = 0.92, weight = 600, px = 14, colour, opacity = 1 } = {}) {
    g.font = font(weight, px);
    const w = g.measureText(text).width + 16, hgt = px + 10;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    g.globalAlpha = alpha * opacity;
    g.fillStyle = tokens.surface;
    g.beginPath();
    g.roundRect(left, y - hgt / 2, w, hgt, hgt / 2);
    g.fill();
    g.globalAlpha = opacity;
    g.fillStyle = colour || tokens.text;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(text, left + 8, y + 0.5);
    g.globalAlpha = 1;
    return { left, w, h: hgt };
  }

  // ---- layers 1-3: sky, lanes, target
  function drawSky(L) {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, tokens.stageTop);
    sky.addColorStop(1, tokens.stage);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);
    if (tokens.starOpacity > 0) {
      ctx.fillStyle = tokens.text;
      for (const s of st.grid === 'quiet' ? manyStars : stars) {
        ctx.globalAlpha = s.a * tokens.starOpacity;
        ctx.beginPath();
        ctx.arc(L.plotX + s.x * L.plotW, s.y * height, s.r, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawLanes(L, activeLane, tg, a = 1) {
    if (!(a > 0)) return;
    const targetLane = tg ? Math.round(tg.midi) : null;
    if (activeLane !== null && !st.target) {
      // Free singing: "which note am I on" is answered by place as well as by name.
      ctx.globalAlpha = C.laneTintOpacity * a;
      ctx.fillStyle = tokens.accent;
      ctx.fillRect(L.plotX, L.yOfMidi(activeLane + 0.5), L.plotW, L.laneH);
    }
    ctx.globalAlpha = a;
    // A chip may sit in the top corner: a name half under it reads as a fault (review 2, 14).
    const clearTop = Math.max(9, st.labelClearTopPx || 0);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const quiet = st.grid === 'quiet';
    for (const lane of L.labels()) {
      if (quiet && !lane.isC) continue;
      const y = Math.round(lane.y) + 0.5;
      ctx.globalAlpha = quiet ? a * Q.lineK : a;
      ctx.strokeStyle = lane.isC ? tokens.lineStrong : tokens.line;
      ctx.lineWidth = lane.isC ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(L.plotX, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      const special = lane.midi === targetLane || lane.midi === activeLane;
      // A name half off the top or bottom edge reads as a glitch: leave it out.
      if ((!lane.named && !special) || y < clearTop || y > height - 9) continue;
      if (quiet) ctx.globalAlpha = a * Q.nameK;
      ctx.font = font(special ? 600 : 500, 13);
      ctx.fillStyle = lane.midi === targetLane ? tokens.target : lane.midi === activeLane ? tokens.text : tokens.quiet;
      ctx.fillText(displayNote(lane.midi, st.noteStyle).text, L.plotX - 8, y);
    }
    ctx.globalAlpha = 1;
  }

  // A target that changes while the loop runs is cross-faded: a band the full width of the
  // stage must not appear or vanish in one frame (measured in labs/matchhold-lab.html: the
  // new band arriving at once read 0.2 on the flash number). A still picture (no loop) is
  // drawn complete, as before.
  // L0 and mk: the old picture's geometry and the progress of a view cross-fade (see `move`).
  function drawTarget(L, now, nowMs, L0 = null, mk = 1) {
    // `wanted`, not `raf`: raf is 0 while the loop's own render runs.
    const k = wanted && C.targetFadeMs > 0 ? Math.min(1, Math.max(0, (nowMs - targetSinceMs) / C.targetFadeMs)) : 1;
    if (travel) {
      const at = (c) => layout({ width, height, lanes: L.lanes, centreMidi: c, nowFrac: st.nowFrac, pxPerSec: st.pxPerSec, gutter: C.gutterPx });
      if (k < 1 && prevTarget) drawBand(at(travel.from), now, nowMs, prevTarget, 1 - k);
      drawBand(at(Math.round(st.target.midi)), now, nowMs, st.target, k);
    } else if (L0 && k >= 1) {
      // The same target seen from two places (recentre): it fades between them.
      drawBand(L0, now, nowMs, st.target, 1 - mk);
      drawBand(L, now, nowMs, st.target, mk);
    } else {
      if (k < 1 && prevTarget) drawBand(L0 || L, now, nowMs, prevTarget, 1 - k);
      drawBand(L, now, nowMs, st.target, k);
    }
    ctx.globalAlpha = 1;
  }

  function drawBand(L, now, nowMs, tg, a) {
    if (!tg || !Number.isFinite(tg.midi) || !(a > 0)) return;
    const x0 = Number.isFinite(tg.t0) ? Math.max(L.plotX, L.xOfTime(tg.t0, now)) : L.plotX;
    const x1 = Number.isFinite(tg.t1) ? Math.min(width, L.xOfTime(tg.t1, now)) : width;
    if (x1 <= x0) return;
    const inTune = config.verdict.inTuneCents / 100, close = config.verdict.closeCents / 100;
    const band = (semis, r) => {
      ctx.beginPath();
      ctx.roundRect(x0, L.yOfMidi(tg.midi + semis), x1 - x0, 2 * semis * L.laneH, r);
    };
    ctx.fillStyle = tokens.target;
    ctx.globalAlpha = tokens.aTargetHalo * a;
    band(close, 8);
    ctx.fill();
    // The band swells once while its reference tone plays; under calm motion it simply
    // sits a little brighter for the length of the tone.
    let wash = tokens.aTargetWash;
    if (st.state === 'tone') {
      const k = st.calm ? 0.5 : Math.sin(Math.PI * Math.min(1, (nowMs - toneStartMs) / C.toneGlowMs));
      wash += (0.40 - tokens.aTargetWash) * k;
    }
    ctx.globalAlpha = wash * a;
    band(inTune, 6);
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = tokens.target;
    ctx.lineWidth = 1.5;
    band(inTune, 6);
    ctx.stroke();
    ctx.lineWidth = 1;
    const y = Math.round(L.yOfMidi(tg.midi)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();

    let lx = x0 + 10;
    if (st.state === 'tone') {      // a small speaker at the band's left end
      ctx.fillStyle = tokens.target;
      ctx.beginPath();
      ctx.moveTo(lx, y - 3); ctx.lineTo(lx + 4, y - 3); ctx.lineTo(lx + 9, y - 7);
      ctx.lineTo(lx + 9, y + 7); ctx.lineTo(lx + 4, y + 3); ctx.lineTo(lx, y + 3);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(lx + 10, y, 5, -Math.PI / 3, Math.PI / 3);
      ctx.stroke();
      lx += 24;
    }
    ctx.font = font(600, 13);
    ctx.fillStyle = tokens.target;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(displayNote(tg.midi, st.noteStyle).text, lx, L.yOfMidi(tg.midi + inTune) - 3);
  }

  // ---- the ribbon (glide, siren; spec 5.2 layer 3): a smooth band 2 * half semitones tall,
  // filled --target-halo, with a dotted centre line and a dot that travels along it at the
  // now line. Behind the dot it fills --good-wash where the voice was inside and hatched
  // --close-wash where it was outside (spec 7.1); unvoiced stretches stay plain.
  function drawRibbons(L, now, nowMs, pts) {
    const k = wanted && C.targetFadeMs > 0 ? Math.min(1, Math.max(0, (nowMs - ribbonSinceMs) / C.targetFadeMs)) : 1;
    if (k < 1 && prevRibbon) {
      // A clock that went back (a new item from 0) would move the old picture off the stage
      // in one frame: it fades out where it was instead.
      const at = Math.max(now, prevNow);
      drawRibbon(L, at, prevRibbon, 1 - k, null, null);
      if (prevMarks) drawNoteMarks(L, at, nowMs, prevRibbon.half, prevMarks, 1 - k, false);
      if (prevLabels) drawBarLabels(L, at, prevRibbon, 1 - k, prevLabels);
    } else if (k >= 1) { prevRibbon = null; prevMarks = null; prevLabels = false; }
    ribbonNow = now;
    ribbonDot = st.ribbon ? ribbonMidiAt(st.ribbon, now) : null;
    if (st.ribbon) drawRibbon(L, now, st.ribbon, k, pts, st.ribbonMarks);
    if (st.ribbon && st.noteMarks) drawNoteMarks(L, now, nowMs, st.ribbon.half, st.noteMarks, k);
    if (st.ribbon && st.barLabels) drawBarLabels(L, now, st.ribbon, k);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  function drawRibbon(L, now, rb, a, pts, marks) {
    if (!rb || !(a > 0)) return;
    const half = rb.half;
    const tLeft = now - (L.nowX - L.plotX) / L.pxPerSec, tRight = now + (width - L.nowX) / L.pxPerSec;
    const step = 3 / L.pxPerSec;           // a sample every 3 px: smooth at any speed
    for (const seg of rb.segments) {
      const a0 = Math.max(seg.t0, tLeft), a1 = Math.min(seg.t1, tRight);
      if (a1 <= a0) continue;
      const ts = [];
      for (let t = a0; t < a1; t += step) ts.push(t);
      ts.push(a1);
      const xs = ts.map((t) => L.xOfTime(t, now)), ms = ts.map((t) => ribbonMidiAt(rb, t));
      const outline = () => {
        ctx.beginPath();
        for (let i = 0; i < ts.length; i++) ctx[i ? 'lineTo' : 'moveTo'](xs[i], L.yOfMidi(ms[i] + half));
        for (let i = ts.length - 1; i >= 0; i--) ctx.lineTo(xs[i], L.yOfMidi(ms[i] - half));
        ctx.closePath();
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.plotX, 0, width - L.plotX, height);
      ctx.clip();
      outline();
      ctx.fillStyle = tokens.target;
      ctx.globalAlpha = tokens.aTargetHalo * a;
      ctx.fill();
      if (pts && pts.length) {
        ctx.save();
        outline();
        ctx.clip();
        fillBehind(L, now, pts, Math.max(a0, seg.t0), Math.min(a1, now), a);
        ctx.restore();
      }
      // Faint edges, so "inside" has a line to be inside of on a pale (Dawn) sky.
      ctx.globalAlpha = 0.35 * a;
      ctx.strokeStyle = tokens.target;
      ctx.lineWidth = 1;
      for (const sgn of [1, -1]) {
        ctx.beginPath();
        for (let i = 0; i < ts.length; i++) ctx[i ? 'lineTo' : 'moveTo'](xs[i], L.yOfMidi(ms[i] + sgn * half));
        ctx.stroke();
      }
      ctx.globalAlpha = a;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      for (let i = 0; i < ts.length; i++) ctx[i ? 'lineTo' : 'moveTo'](xs[i], L.yOfMidi(ms[i]));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    // Break markers (siren): small hollow diamonds left on the path.
    if (marks) {
      ctx.globalAlpha = a;
      ctx.strokeStyle = tokens.text;
      ctx.lineWidth = 1.5;
      for (const mk of marks) {
        const x = L.xOfTime(mk.t, now);
        if (x < L.plotX || x > width || !Number.isFinite(mk.midi)) continue;
        const y = L.yOfMidi(mk.midi), r = 6;
        ctx.beginPath();
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.stroke();
      }
    }
    // The dot to follow, at the now line, only while the path is passing it.
    const dm = ribbonMidiAt(rb, now);
    if (dm !== null) {
      const y = L.yOfMidi(dm);
      ctx.globalAlpha = a;
      ctx.fillStyle = tokens.target;
      ctx.strokeStyle = tokens.stage;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(L.nowX, y, 6, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- judged note bars (Star steps; spec patterns 6.2): each mark restyles its bar. A mark's
  // look eases in over noteMarkMs from when its kind first arrived (keyed by bar), so a verdict
  // never pops; calm draws it at once. The map is pruned to the marks still given.
  const markSince = new Map();
  // eased false: an outgoing ribbon's marks, drawn as they were (alpha a only; markSince untouched).
  function drawNoteMarks(L, now, nowMs, half, marks, a, eased = true) {
    const ms = C.noteMarkMs ?? 200;
    const seen = new Set();
    for (const mk of marks) {
      const look = noteMarkLook(mk && mk.kind);
      if (!look || !Number.isFinite(mk.midi) || !(mk.t1 > mk.t0)) continue;
      const key = `${mk.t0}|${mk.midi}`;
      let rec = { since: -Infinity };
      if (eased) {
        seen.add(key);
        rec = markSince.get(key);
        if (!rec || rec.kind !== mk.kind) { rec = { kind: mk.kind, since: nowMs }; markSince.set(key, rec); }
      }
      const x0 = L.xOfTime(mk.t0, now), x1 = L.xOfTime(mk.t1, now);
      if (x1 < L.plotX || x0 > width) continue;
      const k = a * markEase(rec.since, nowMs, ms);
      const yT = L.yOfMidi(mk.midi + half), yB = L.yOfMidi(mk.midi - half);
      const x = Math.max(x0, L.plotX), w = x1 - x, h = yB - yT;
      if (!(w > 0)) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.plotX, 0, width - L.plotX, height);
      ctx.clip();
      if (look.fill) {
        ctx.globalAlpha = (look.hatch ? 0.45 : 0.85) * k;
        ctx.fillStyle = tokens[look.fill];
        ctx.fillRect(x, yT, w, h);
      }
      if (look.hatch) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, yT, w, h);
        ctx.clip();
        ctx.globalAlpha = 0.8 * k;
        ctx.strokeStyle = tokens.close;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // Anchored to the time axis like fillBehind's hatching: it travels, never shimmers.
        const off = ((L.xOfTime(0, now) % 8) + 8) % 8;
        for (let hx = Math.floor((x - h - off) / 8) * 8 + off; hx < x + w; hx += 8) { ctx.moveTo(hx, yB); ctx.lineTo(hx + h, yT); }
        ctx.stroke();
        ctx.restore();
      }
      if (look.outline) {
        ctx.globalAlpha = k;
        ctx.strokeStyle = look.outline === 'dotted' ? tokens.quiet : tokens.off;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(look.outline === 'dotted' ? [2, 4] : []);
        ctx.strokeRect(x0 + 0.75, yT + 0.75, x1 - x0 - 1.5, h - 1.5);
        ctx.setLineDash([]);
      }
      // The glyph at the bar's right end: tick, an arrow toward the note (dir 'low' = sung
      // low, so the arrow points up), or three dots for a note not sung.
      const gx = x1 - 10, gy = (yT + yB) / 2;
      if (gx > L.plotX) {
        ctx.globalAlpha = k;
        ctx.strokeStyle = ctx.fillStyle = look.glyph === 'tick' ? tokens.text : look.glyph === 'dots' ? tokens.quiet : tokens[mk.kind === 'close' ? 'close' : 'off'];
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (look.glyph === 'tick') { ctx.moveTo(gx - 4, gy); ctx.lineTo(gx - 1, gy + 3); ctx.lineTo(gx + 4, gy - 3); ctx.stroke(); }
        else if (look.glyph === 'arrow' && (mk.dir === 'low' || mk.dir === 'high')) {
          const s = mk.dir === 'low' ? -1 : 1;           // canvas y grows down: up = -1
          ctx.moveTo(gx, gy - 4 * s); ctx.lineTo(gx, gy + 4 * s);
          ctx.moveTo(gx - 3, gy + s); ctx.lineTo(gx, gy + 4 * s); ctx.lineTo(gx + 3, gy + s);
          ctx.stroke();
        } else if (look.glyph === 'dots') for (const dx of [-5, 0, 5]) { ctx.beginPath(); ctx.arc(gx + dx, gy, 1.5, 0, 2 * Math.PI); ctx.fill(); }
      }
      ctx.restore();
    }
    if (eased) for (const key of markSince.keys()) if (!seen.has(key)) markSince.delete(key);
    ctx.globalAlpha = 1;
  }

  // ---- bar labels: the note name above each bar (small, quiet), the syllable under it.
  // barLabels: true ('la' on every bar) or an array of syllables, one per bar.
  function drawBarLabels(L, now, rb, a, labels = st.barLabels) {
    const plan = barLabelPlan(rb, {
      syllables: Array.isArray(labels) ? labels : null, noteStyle: st.noteStyle,
      pxPerSec: L.pxPerSec, minPx: C.barLabelMinPx ?? 28,
    });
    const clearTop = Math.max(0, st.labelClearTopPx || 0);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    for (const b of plan) {
      if (!b.show) continue;
      const x0 = L.xOfTime(b.t0, now), x1 = L.xOfTime(b.t1, now), cx = (x0 + x1) / 2;
      if (x1 < L.plotX || x0 > width || cx < L.plotX) continue;
      const yT = L.yOfMidi(b.midi + rb.half), yB = L.yOfMidi(b.midi - rb.half);
      if (yT - 5 - 11 >= clearTop) {
        ctx.font = font(500, 11);
        ctx.fillStyle = tokens.quiet;
        ctx.textBaseline = 'bottom';
        ctx.fillText(b.name, cx, yT - 5);
      }
      if (b.syll && yB + 4 >= clearTop) {
        ctx.font = font(500, 13);
        ctx.fillStyle = tokens.text;
        ctx.textBaseline = 'top';
        ctx.fillText(b.syll, cx, yB + 4);
      }
    }
    ctx.restore();
  }

  // Runs of the same kind are filled as one slice: in = wash, close = hatched wash.
  function fillBehind(L, now, pts, t0, t1, a) {
    if (!(t1 > t0)) return;
    let runKind = null, runX0 = 0;
    const flush = (x1) => {
      if (runKind === 'in') {
        ctx.globalAlpha = tokens.aGoodWash * a;
        ctx.fillStyle = light ? tokens.auroraIn : tokens.good;   // Dawn: tokens.good reads as a grey slab
        ctx.fillRect(runX0, 0, x1 - runX0, height);
      } else if (runKind === 'close') {
        ctx.globalAlpha = 0.5 * tokens.aGoodWash * a;
        ctx.fillStyle = tokens.close;
        ctx.fillRect(runX0, 0, x1 - runX0, height);
        ctx.save();
        ctx.beginPath();
        ctx.rect(runX0, 0, x1 - runX0, height);
        ctx.clip();
        ctx.globalAlpha = 0.6 * a;
        ctx.strokeStyle = tokens.close;
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Hatching, anchored to the time axis so it travels with the take, never shimmers.
        const off = ((L.xOfTime(0, now) % 8) + 8) % 8;
        for (let x = Math.floor((runX0 - height - off) / 8) * 8 + off; x < x1; x += 8) { ctx.moveTo(x, height); ctx.lineTo(x + height, 0); }
        ctx.stroke();
        ctx.restore();
      }
    };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.t < t0 || p.t > t1) continue;
      const kind = p.midi === null ? null : p.kind === 'in' ? 'in' : 'close';
      const x = L.xOfTime(p.t, now);
      if (kind !== runKind) { flush(x); runKind = kind; runX0 = x; }
    }
    flush(L.xOfTime(t1, now));
  }

  // ---- the aurora: under the target band and the voice line, clipped to the plot (never over
  // the note names). It takes the same points and the same strength as the line drawn after
  // it, so it fades with every fade the line has (voiceAlpha, a fresh target, a fit).
  function drawAurora(L, now, alpha, tAfter, tUpTo, nowMs, colPx, from = points) {
    if (!L || !(alpha > 0)) return;
    const n = curtain.build(from, {
      now, pxPerSec: L.pxPerSec, nowX: L.nowX, yOfMidi: L.yOfMidi, topY: 0, xMin: L.plotX, tAfter: from === points ? Math.max(tAfter, curtainFromT) : tAfter, tUpTo,
      calm: !!st.calm, light, colPx, peakCap: tokens.auroraPeak, tall: Math.min(AU.tallMax, Math.max(1, height / AU.tallRefPx)), outK: slideGain ?? 1, swayT: nowMs / 1000, shimmerT: nowMs / 1000, snap: dpr,
    });
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.plotX, 0, L.plotW, height);
    ctx.clip();
    if (n) auroraCols += drawCurtain(ctx, curtain.cols, sprites, alpha);
    drawRibbonLight(L, from, now, alpha, from === points ? Math.max(tAfter, curtainFromT) : tAfter, tUpTo);
    ctx.restore();
  }

  // The old trail of a fresh target eases out where it was: its ribbon and curtain keep the
  // view they were sung in while the lanes travel on (so does the old band, see `travel`).
  // Light fading in place reads far lower on the flash number than light fading as it slides.
  function ghostL(L, lanes) {
    if (!auroraGhost || !Number.isFinite(auroraGhost.centre) || !lanes) return L;
    return layout({ width, height, lanes, centreMidi: auroraGhost.centre, nowFrac: st.nowFrac, pxPerSec: st.pxPerSec, gutter: C.gutterPx });
  }

  // ---- the voice ribbon
  // The voice is a ribbon of light (config.aurora.ribbon), in two parts.
  //   The line (drawVoice, always): the exact pitch, as it always was (solid in tune, thin
  //     when close, dashes when off). Never painted over: the light lays a crisp bright rim along its upper edge.
  //   The light (drawRibbonLight, with the curtain): a band that rises from the line into the
  //     curtain, with a tight glow and a wide halo, as wide and bright as the voice was loud.
  //     It is the curtain's bright foot: it takes the curtain's points, strength and every one
  //     of its fades (rest, a fresh target, a long slide, a dropped trail, the guard, the
  //     switch) and, like the curtain, lasts trailEndMs. Under it the line stays as the record.
  // Everything about it is a function of the trail's own time, never of the clock: a still
  // picture drawn twice is the same.
  const RB = AU.ribbon, HD = AU.head, SP = AU.sparks;
  let rbX = new Float32Array(1024), rbY = new Float32Array(1024), rbH = new Float32Array(1024), rbH0 = new Float32Array(1024), rbT = new Float32Array(1024);
  const sm01 = (k) => { const c = Math.min(1, Math.max(0, k)); return c * c * (3 - 2 * c); };

  // One run's geometry into the scratch arrays: x, y, half-width and light (0..1) per reading.
  function ribbonRun(pts, from, to, L, now, closeK) {
    const n = to - from + 1;
    if (n > rbX.length) {
      const size = 2 ** Math.ceil(Math.log2(n));
      rbX = new Float32Array(size); rbY = new Float32Array(size); rbH = new Float32Array(size); rbH0 = new Float32Array(size); rbT = new Float32Array(size);
    }
    const calm = !!st.calm, kx = (2 * Math.PI) / RB.shimmerPx, wt = (2 * Math.PI) / RB.shimmerSec;
    const fullMs = calm ? AU.calmTrailFullMs : AU.trailFullMs, endMs = calm ? AU.calmTrailEndMs : AU.trailEndMs;
    for (let i = 0; i < n; i++) {
      const p = pts[from + i], look = RB.looks[p.kind] || RB.looks.free, x = L.xOfTime(p.t, now);
      let hw = look.half + look.halfLv * (calm ? AU.calmLv : p.lv ?? AU.calmLv);
      if (!calm && look.shimmer) hw *= 1 + RB.shimmer * look.shimmer * Math.sin(x * kx + now * wt);
      rbX[i] = x;
      rbY[i] = L.yOfMidi(p.midi);
      rbH0[i] = hw;
      rbT[i] = 1 - sm01(((now - p.t) * 1000 - fullMs) / (endMs - fullMs));     // the curtain's own trail
    }
    const w = RB.smoothPts, tip = RB.tipPts;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - w), hi = Math.min(n - 1, i + w);
      let sum = 0;
      for (let j = lo; j <= hi; j++) sum += rbH0[j];
      // Rounded off at both ends, except at the head: there the comet's head closes it. When
      // the voice leaves, the end rounds off as closeK goes 0..1 (endEaseMs), not in one frame:
      // the last tipPts readings are the brightest part of the line, right behind the head.
      rbT[i] *= Math.min(sm01((i + 0.5) / tip), closeK > 0 ? 1 - closeK * (1 - sm01((n - i - 0.5) / tip)) : 1);
      rbH[i] = (sum / (hi - lo + 1)) * rbT[i];
    }
  }

  // A filled band a..b of the run. It rises (rbH * k + add) above the line and reaches at
  // most `under` below it: the light stands on the line, as the curtain does.
  function ribbonFill(g, a, b, k, add, under) {
    g.beginPath();
    g.moveTo(rbX[a], rbY[a] - rbH[a] * k - add * rbT[a]);
    for (let i = a + 1; i <= b; i++) g.lineTo(rbX[i], rbY[i] - rbH[i] * k - add * rbT[i]);
    for (let i = b; i >= a; i--) g.lineTo(rbX[i], rbY[i] + under * rbT[i]);
    g.closePath();
    g.fill();
  }

  function drawRibbonLight(L, from, now, alpha, tAfter, tUpTo) {
    const maxAge = (st.calm ? AU.calmTrailEndMs : AU.trailEndMs) / 1000 + 0.5;
    let i0 = from.length;
    while (i0 > 0 && now - from[i0 - 1].t <= maxAge) i0--;
    const win = [];
    for (let i = i0; i < from.length; i++) { const p = from[i]; if (p.t > tAfter && p.t <= tUpTo) win.push(p); }
    if (win.length < 2) return;
    const th = light ? RB.dawn : RB.dusk, out = slideGain ?? 1, g = ctx;
    for (const run of voicePieces(win, C)) {
      if (run.leap && !(run.to > run.from)) continue;
      if (run.dot) continue;
      // A stretch counts as left once maxJoinGapSec has passed with no reading. Everything
      // that follows is counted from that moment, so nothing steps on the frame it happens
      // (it was 12 % of the light and the whole tip at once: the stage's largest change,
      // docs/team-log/reports/2026-10-13-debbie-voice-stop-flicker.md).
      const leftMs = Math.max(0, (now - win[run.to].t - C.maxJoinGapSec) * 1000);
      // A stretch the voice has left gives up its light over endFadeMs; with a long slide's
      // fade it shows the lower of the two, never their product (as the curtain does).
      const endRaw = 1 - leftMs / AU.endFadeMs;
      if (!(endRaw > 0)) continue;
      const runA = alpha * (out > 0 && out < 1 ? Math.min(1, endRaw / out) : endRaw);
      ribbonRun(win, run.from, run.to, L, now, AU.endEaseMs > 0 ? Math.min(1, leftMs / AU.endEaseMs) : leftMs > 0 ? 1 : 0);
      let a = run.from, prevKind = null;
      for (let i = run.from + 1; i <= run.to + 1; i++) {
        if (i <= run.to && win[i].kind === win[a].kind) continue;
        const kind = win[a].kind, ia = a - run.from, ib = Math.min(i, run.to) - run.from, look = RB.looks[kind] || RB.looks.free;
        if (kind !== 'off' && ib > ia) {
          // The colour changes over colourBlendMs along the ribbon, as the line's does.
          let glow = glowOf(kind), band = th.band === 'light' ? glow : colourOf(kind);
          const span = rbX[ib] - rbX[ia];
          if (prevKind && prevKind !== kind && prevKind !== 'off' && span > 1) {
            const stop = Math.min(1, (C.colourBlendMs / 1000) * L.pxPerSec / span);
            glow = g.createLinearGradient(rbX[ia], 0, rbX[ib], 0);
            glow.addColorStop(0, glowOf(prevKind));
            glow.addColorStop(stop, glowOf(kind));
            if (th.band === 'light') band = glow;
          }
          g.fillStyle = glow;
          g.globalAlpha = th.haloA * look.glow * runA;
          ribbonFill(g, ia, ib, th.haloK, th.haloPx, RB.underPx);
          g.globalAlpha = th.glowA * look.glow * runA;
          ribbonFill(g, ia, ib, th.glowK, th.glowPx, RB.underPx);
          g.fillStyle = band;
          g.globalAlpha = th.bandA * runA;
          ribbonFill(g, ia, ib, RB.bandK, 0, Math.min(RB.underPx, look.thin));
          // The crisp rim: a bright edge where the light stands on the line. It follows the
          // exact pitch (the line's upper edge) and is the sharpest thing in the glow.
          if (look.core > 0 && th.coreA > 0) {
            g.fillStyle = tokens.core;
            g.globalAlpha = th.coreA * look.core * runA;
            g.beginPath();
            g.moveTo(rbX[ia], rbY[ia] - look.thin - look.coreW * rbT[ia]);
            for (let j = ia + 1; j <= ib; j++) g.lineTo(rbX[j], rbY[j] - look.thin - look.coreW * rbT[j]);
            for (let j = ib; j >= ia; j--) g.lineTo(rbX[j], rbY[j] - look.thin + 0.5 * rbT[j]);
            g.closePath();
            g.fill();
          }
        }
        prevKind = kind;
        a = i;
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- layer 4: the voice line
  function strokeKind(g, pts, L, now, kind, prevKind) {
    const xs = pts.map((p) => L.xOfTime(p.t, now)), ys = pts.map((p) => L.yOfMidi(p.midi));
    const path = () => {
      g.beginPath();
      g.moveTo(xs[0], ys[0]);
      for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], ys[i]);
    };
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.setLineDash([]);
    const colour = colourOf(kind);
    const span = xs[xs.length - 1] - xs[0];
    if (prevKind && prevKind !== kind && span > 1) {
      // The colour changes over colourBlendMs along the line, never as a hard step.
      const grad = g.createLinearGradient(xs[0], 0, xs[xs.length - 1], 0);
      grad.addColorStop(0, colourOf(prevKind));
      grad.addColorStop(Math.min(1, (C.colourBlendMs / 1000) * L.pxPerSec / span), colour);
      g.strokeStyle = grad;
    } else {
      g.strokeStyle = colour;
    }
    g.lineWidth = kind === 'in' ? 5 : kind === 'free' ? 4 : 3;
    if (kind === 'off') {
      g.setLineDash([8, 5]);
      g.lineCap = 'butt';
      // Tie the dash phase to time, not to the first point still on screen, so the dashes
      // travel with the line instead of crawling along it.
      g.lineDashOffset = (pts[0].t * L.pxPerSec) % 13;
    }
    path();
    g.stroke();
    g.setLineDash([]);

    if (kind === 'off' && st.target) {
      // Chevrons point the way the voice should move. Their places are fixed in time too.
      const step = C.chevronEveryPx / L.pxPerSec;
      g.strokeStyle = colour;
      g.lineWidth = 2;
      g.lineCap = 'round';
      let i = 0;
      for (let k = Math.ceil(pts[0].t / step); k * step <= pts[pts.length - 1].t; k++) {
        const t = k * step;
        while (i < pts.length - 2 && pts[i + 1].t < t) i++;
        const a = pts[i], b = pts[i + 1] || a;
        const midi = b.t > a.t ? a.midi + (b.midi - a.midi) * (t - a.t) / (b.t - a.t) : a.midi;
        const up = st.target.midi > midi ? -1 : 1;     // canvas y grows downward
        const x = L.xOfTime(t, now), y = L.yOfMidi(midi) + up * 9;
        g.beginPath();
        g.moveTo(x - 4, y - up * 4);
        g.lineTo(x, y);
        g.lineTo(x + 4, y - up * 4);
        g.stroke();
      }
    }
  }

  // Sparks shed behind the head (config.aurora.sparks): one for every everyMs of the trail
  // that was in tune or free, each rising slowly, twinkling and fading. A spark's place and
  // age come from the trail's time alone, so there is nothing to start, stop or clear.
  const sparkRnd = (j, salt) => { const v = Math.sin(j * 127.1 + salt * 311.7) * 43758.5453; return v - Math.floor(v); };
  function drawSparks(g, pts, L, now) {
    if (st.calm || st.state === 'review' || pts.length < 2) return 0;
    const every = SP.everyMs / 1000, life = SP.lifeMs / 1000, peak = light ? SP.alpha.dawn : SP.alpha.dusk;
    let i = pts.length - 1, n = 0;
    for (let j = Math.floor(now / every); j * every > now - life; j--) {
      const tj = j * every;
      while (i > 0 && pts[i].t > tj) i--;
      const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)];
      if (p.t > tj || q.t < tj || q.t - p.t > C.maxJoinGapSec || !Number.isFinite(p.midi) || !Number.isFinite(q.midi)) continue;
      if (p.kind !== 'in' && p.kind !== 'free') continue;
      const age = now - tj, k = age / life, r1 = sparkRnd(j, 1), r2 = sparkRnd(j, 2), r3 = sparkRnd(j, 3);
      const alpha = peak * sm01((age * 1000) / SP.inMs) * (1 - sm01((k - SP.holdK) / (1 - SP.holdK)))
        * (0.72 + 0.28 * Math.sin(2 * Math.PI * (age * SP.twinkleHz + r3)));
      if (!(alpha > 0.01)) continue;
      const x = L.xOfTime(tj, now) + (r2 - 0.5) * SP.driftPx * k;
      const y = L.yOfMidi(p.midi) - (SP.riseMinPx + (SP.riseMaxPx - SP.riseMinPx) * r1) * (1 - (1 - k) * (1 - k));
      const r = SP.minPx + (SP.maxPx - SP.minPx) * r2, long = r * 2.6, thin = r * 0.42;
      g.globalAlpha = alpha * 0.3;
      g.fillStyle = glowOf(p.kind);
      g.beginPath();
      g.arc(x, y, r * 2.4, 0, 2 * Math.PI);
      g.fill();
      // A four-point glint. On Dawn it is the verdict's light (white would not show).
      g.globalAlpha = alpha;
      g.fillStyle = light ? glowOf(p.kind) : tokens.core;
      g.beginPath();
      g.moveTo(x, y - long); g.lineTo(x + thin, y - thin); g.lineTo(x + long, y); g.lineTo(x + thin, y + thin);
      g.lineTo(x, y + long); g.lineTo(x - thin, y + thin); g.lineTo(x - long, y); g.lineTo(x - thin, y - thin);
      g.closePath();
      g.fill();
      n++;
    }
    g.globalAlpha = 1;
    return n;
  }

  function drawVoice(L, pts, now, alpha = 1) {
    if (!(alpha > 0)) return 0;
    if (!pts.length) { lastLeaps = 0; lastSparks = 0; return 0; }
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, width, height);
    const runs = voicePieces(pts, C);
    let nRuns = 0, nLeaps = 0;
    for (const run of runs) {
      if (run.leap) {
        nLeaps++;
        const a = pts[run.from - 1], b = pts[run.from];
        lctx.globalAlpha = C.leapOpacity;
        lctx.strokeStyle = tokens.quiet;
        lctx.lineWidth = C.leapWidthPx;
        lctx.lineCap = 'butt';
        lctx.setLineDash([]);
        lctx.beginPath();
        lctx.moveTo(L.xOfTime(a.t, now), L.yOfMidi(a.midi));
        lctx.lineTo(L.xOfTime(b.t, now), L.yOfMidi(b.midi));
        lctx.stroke();
        lctx.globalAlpha = 1;
      } else nRuns++;
      if (run.dot) {
        const p = pts[run.from];
        lctx.fillStyle = colourOf(p.kind);
        lctx.beginPath();
        lctx.arc(L.xOfTime(p.t, now), L.yOfMidi(p.midi), 2.5, 0, 2 * Math.PI);
        lctx.fill();
        continue;
      }
      // One stroke per stretch of the same verdict; neighbours share their boundary point.
      let a = run.from, prevKind = null;
      for (let i = run.from + 1; i <= run.to + 1; i++) {
        if (i <= run.to && pts[i].kind === pts[a].kind) continue;
        strokeKind(lctx, pts.slice(a, Math.min(i, run.to) + 1), L, now, pts[a].kind, prevKind);
        prevKind = pts[a].kind;
        a = i;
      }
    }
    lastSparks = drawSparks(lctx, pts, L, now);
    if (st.state !== 'review') {
      // Fade the oldest part to fadeMinOpacity. Done in strips with globalAlpha so no
      // colour value has to be written here (the tokens file owns every colour).
      // Each strip is clipped first: without a clip, 'destination-in' would also erase
      // everything outside the strip being painted.
      const fadeW = (L.nowX - L.plotX) * C.fadeOldestFrac, strips = 16;
      lctx.globalCompositeOperation = 'destination-in';
      lctx.fillStyle = tokens.text;
      for (let s = 0; s < strips; s++) {
        const x0 = s === 0 ? 0 : Math.round(L.plotX + (fadeW * s) / strips);
        const x1 = Math.round(L.plotX + (fadeW * (s + 1)) / strips);
        lctx.save();
        lctx.beginPath();
        lctx.rect(x0, 0, x1 - x0, height);
        lctx.clip();
        lctx.globalAlpha = C.fadeMinOpacity + (1 - C.fadeMinOpacity) * (s / strips);
        lctx.fillRect(x0, 0, x1 - x0, height);
        lctx.restore();
      }
      lctx.globalAlpha = 1;
      lctx.globalCompositeOperation = 'source-over';
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.plotX, 0, L.plotW, height);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.drawImage(lineCanvas, 0, 0, width, height);
    ctx.restore();
    lastLeaps = nLeaps;
    return nRuns;
  }

  // ---- layer 5: head, tag, out-of-view chip
  // The tag and the out-of-view chip are boxes of text that would otherwise pop in and out
  // at once (the lab's flash number caught exactly that on a leap), so they ease instead.
  // A still picture (no loop running) shows them settled.
  const tagMark = { a: 0, text: '', y: 0 }, outMark = { a: 0, text: '', up: true };
  function fade(mark, on, dt) {
    // `wanted`, not `raf`: raf is 0 while the loop's own render runs, which made every
    // looped frame count as a still picture and the marks snap.
    const step = markStep(dt, wanted, C.markFadeMs);
    mark.a = on ? Math.min(1, mark.a + step) : Math.max(0, mark.a - step);
  }

  // The halo round the head (config.aurora.head): soft light in the verdict's colour, sized by
  // the loudness. It eases in with the voice and out when the voice stops, cross-fades from one
  // verdict to the next, and after a jump fades out where it was while it fades in where the
  // voice now is: light never moves across the stage in one frame.
  const HALO_KINDS = ['in', 'close', 'off', 'free'];
  function haloSprite(colour) {
    const c = document.createElement('canvas'), S = 96;
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = colour;
    // Soft all the way out with no colour written here: many faint discs, most of them small.
    const n = 48;
    g.globalAlpha = 0.06;
    for (let i = 1; i <= n; i++) {
      g.beginPath();
      g.arc(S / 2, S / 2, (S / 2) * (i / n) ** 1.7, 0, 2 * Math.PI);
      g.fill();
    }
    return c;
  }
  const haloMix = { in: 0, close: 0, off: 0, free: 0 };
  let haloY = null, haloK = 0, haloGhost = null, haloLv = null;
  function haloAt(L, y, k) {
    if (!(k > 0.004)) return;
    const peak = (light ? HD.alpha.dawn : HD.alpha.dusk) * (slideGain ?? 1);
    const lv = st.calm ? AU.calmLv : haloLv ?? AU.calmLv;
    for (const kind of HALO_KINDS) {
      const mix = haloMix[kind];
      if (!(mix > 0.004)) continue;
      const r = (HD.radiusPx + HD.radiusLvPx * lv) * HD.share[kind];
      ctx.globalAlpha = Math.min(1, peak * k * mix);
      ctx.drawImage(haloSprites[kind], L.nowX - r, y - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
  }
  function drawHalo(L, y, kind, dt) {
    if (!haloSprites) haloSprites = Object.fromEntries(HALO_KINDS.map((k) => [k, haloSprite(glowOf(k))]));
    const step = markStep(dt, wanted, HD.fadeMs);
    if (y !== null) {
      if (haloY !== null && Math.abs(y - haloY) > HD.jumpPx && haloK > 0) {
        // Keep the brighter of the two leftovers; the new place starts dark.
        if (!haloGhost || haloK > haloGhost.k) haloGhost = { y: haloY, k: haloK };
        haloK = 0;
      }
      haloY = y;
      haloLv = lvNow;
      haloK = Math.min(1, haloK + markStep(dt, wanted, HD.fadeInMs || HD.fadeMs));
    } else haloK = Math.max(0, haloK - step);
    for (const k of HALO_KINDS) haloMix[k] = kind === null ? haloMix[k] : k === kind ? Math.min(1, haloMix[k] + step) : Math.max(0, haloMix[k] - step);
    if (haloGhost) {
      haloGhost.k = Math.max(0, haloGhost.k - step);
      if (haloGhost.k > 0) haloAt(L, haloGhost.y, sm01(haloGhost.k)); else haloGhost = null;
    }
    if (haloY !== null) haloAt(L, haloY, sm01(haloK));
  }

  function drawHead(L, now, dt) {
    const shown = last && last.shown;
    let head = 'none', wantTag = false, wantOut = false, haloDone = false;
    if (last && last.voiced) {
      const y = L.yOfMidi(last.midi);
      if (y < 0 || y > height) {
        head = 'out';
        wantOut = true;
        outMark.up = y < 0;
        // No arrow: the chip's place (top or bottom edge) carries the direction, and an arrow
        // here would point the opposite way to the verdict's "come down" (review 1, m2).
        outMark.text = `You are ${outMark.up ? 'up' : 'down'} here: ${displayNote(last.midi, st.noteStyle).text}`;
      } else {
        head = 'voiced';
        drawHalo(L, y, last.kind, dt);
        haloDone = true;
        // The exact dot, as before, with a bright core: the place to aim with.
        ctx.fillStyle = colourOf(last.kind);
        ctx.strokeStyle = tokens.stage;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(L.nowX, y, HD.dotPx, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = tokens.core;
        ctx.beginPath();
        ctx.arc(L.nowX, y, HD.corePx, 0, 2 * Math.PI);
        ctx.fill();
        if (shown && !shown.listening) {
          wantTag = true;
          tagMark.text = shown.tagText;
          tagMark.y = Math.min(height - 16, Math.max(16, y));
        }
      }
    } else if (st.state === 'live' || st.state === 'paused' || st.state === 'lost') {
      // Silent: a hollow ring where the voice last was, settling to a fainter state.
      head = 'silent';
      const midi = lastVoiced ? lastVoiced.midi : centre;
      const since = lastVoiced ? (now - lastVoiced.t) * 1000 : C.silentFadeMs;
      const k = Math.min(1, Math.max(0, since / C.silentFadeMs));
      ctx.globalAlpha = 1 - (1 - C.silentOpacity) * k;
      ctx.strokeStyle = tokens.quiet;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(L.nowX, Math.min(height - 8, Math.max(8, L.yOfMidi(midi))), 5, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (!haloDone) drawHalo(L, null, null, dt);
    fade(tagMark, wantTag, dt);
    fade(outMark, wantOut, dt);
    if (tagMark.a > 0.01) pill(ctx, tagMark.text, L.nowX + 12, tagMark.y, { opacity: tagMark.a });
    if (outMark.a > 0.01) pill(ctx, outMark.text, L.nowX, outMark.up ? 20 : height - 44, { align: 'center', alpha: 1, opacity: outMark.a });
    return head;
  }

  function drawNowLine(L) {
    ctx.strokeStyle = tokens.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(L.nowX, 0);
    ctx.lineTo(L.nowX, height);
    ctx.stroke();
    pill(ctx, 'now', L.nowX, height - 13, { align: 'center', alpha: 1, weight: 500, px: 13, colour: tokens.quiet });
  }

  function geometry(nowMs) {
    if (st.state === 'review' && take && take.length) {
      const t0 = take[0].t, t1 = take[take.length - 1].t, dur = Math.max(0.5, t1 - t0);
      const voiced = take.filter((p) => Number.isFinite(p.midi)).map((p) => p.midi);
      const low = voiced.length ? Math.min(...voiced) : centre, high = voiced.length ? Math.max(...voiced) : centre;
      const lanes = lanesFor({ wide: true, lowMidi: low, highMidi: high }, C);
      const plotW = Math.max(1, width - C.gutterPx);
      return {
        L: layout({ width, height, lanes, centreMidi: Math.round((low + high) / 2), nowFrac: 1, pxPerSec: plotW / dur, gutter: C.gutterPx }),
        pts: take, now: t1, t0,
      };
    }
    const now = points.length ? points[points.length - 1].t : 0;
    if (fitTo) {
      // Fitted: nothing follows the voice, and every lane of the range is in the picture.
      const lanes = Math.max(C.lanesNormal, fitTo.high - fitTo.low + 1 + 2 * C.widePadSemis);
      centre = goal = (fitTo.low + fitTo.high) / 2;
      snapNext = false;
      slideOut = false;
      const L = layout({ width, height, lanes, centreMidi: centre, nowFrac: st.nowFrac, pxPerSec: st.pxPerSec, gutter: C.gutterPx });
      let from = points.length;
      while (from > 0 && now - points[from - 1].t <= L.secondsBefore + 0.5) from--;
      return { L, pts: points.slice(from), now, t0: now, lanes };
    }
    const lanes = st.wide && st.range ? lanesFor({ wide: true, lowMidi: st.range.low, highMidi: st.range.high }, C) : C.lanesNormal;

    // Where should the view rest? The target, or the middle of the recent voice.
    let lo = Infinity, hi = -Infinity;
    // The old picture's trail must not pull the new view towards where the voice was.
    const since = Math.max(hideT, move && move.cutT !== null ? move.cutT : -Infinity);
    for (let i = points.length - 1; i >= 0 && !pinTarget && points[i].t > since && now - points[i].t <= C.freeCentreWindowSec; i--) {
      const m = points[i].midi;
      if (Number.isFinite(m)) { if (m < lo) lo = m; if (m > hi) hi = m; }
    }
    // An octave away is the right note in another voice: the view does not lean after it
    // (it could not bring it into view anyway, and the band would slide for nothing).
    const octaveOut = !!(st.octaveCents && last && last.voiced && last.verdict.octave);
    const focus = hi >= lo && !octaveOut ? (lo + hi) / 2 : null;
    // A ribbon owns the middle as a band does: the middle of its whole path, so the view
    // rests still while the path climbs and falls through it.
    const anchor = st.target ? st.target.midi : st.ribbon && Number.isFinite(st.ribbon.low) ? (st.ribbon.low + st.ribbon.high) / 2 : null;
    goal = centreGoal({ goal, focus, target: anchor, lanes }, C);
    const dt = Math.min(0.1, Math.max(0, (nowMs - lastRenderMs) / 1000));
    // The first picture after a reset is placed, not moved: nothing was on screen to jump.
    // holdUntilMs: a fresh target waits for the old trail to fade before the view slides.
    // A sliding view carries the whole curtain with it, and that much light crossing the
    // lanes was the stage's largest change (labs/stage-lab.html, the leap: 0.21 on the flash
    // number, 0.15 with no curtain). The slide starts at full speed, so nothing can ease the
    // curtain away in time: a long slide waits slideOutMs while the curtain eases out, and
    // the curtain eases back once the view rests. Short slides, a view without a lit curtain
    // and a still picture are untouched.
    const sliding = wanted && !snapNext && (st.state === 'live' || st.state === 'tone');
    const far = Math.abs(goal - centre);
    if (!sliding || far < 0.05) slideOut = false;
    // Not for a fresh target: its old curtain is already easing out by itself (auroraGhost),
    // and its slide is timed against the reference tone (travel).
    else if (curtainLit && !travel && !auroraGhost && far >= AU.slideHoldSemis) slideOut = true;
    const waits = slideOut && (slideGain ?? 1) > 0;
    centre = snapNext ? goal : (st.state === 'live' || st.state === 'tone') && nowMs >= holdUntilMs && !waits ? stepCentre(centre, goal, dt, C) : centre;
    snapNext = false;
    if (travel && (!st.target || centre === Math.round(st.target.midi))) travel = null;

    const L = layout({ width, height, lanes, centreMidi: centre, nowFrac: st.nowFrac, pxPerSec: st.pxPerSec, gutter: C.gutterPx });
    let from = points.length;
    while (from > 0 && now - points[from - 1].t <= L.secondsBefore + 0.5) from--;
    return { L, pts: points.slice(from), now, t0: now, lanes };
  }

  let lastRuns = 0, lastLeaps = 0, headState = 'none';
  function render(nowMs = performance.now()) {
    if (!width || !height) return;
    const t0Ms = performance.now();
    if (!tokens) readTokens();
    const frameDt = Math.min(0.1, Math.max(0, (nowMs - lastRenderMs) / 1000));
    if (move && nowMs - move.sinceMs >= move.ms) {
      if (move.cutT !== null) hideT = Math.max(hideT, move.cutT);
      move = null;
    }
    const { L, pts, now, t0, lanes } = geometry(nowMs);
    shownLanes = lanes;
    lastRenderMs = nowMs;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    const activeLane = st.state !== 'review' && last && last.voiced ? last.note.midi : null;
    const review = st.state === 'review';
    const mk = move && !review ? Math.min(1, Math.max(0, (nowMs - move.sinceMs) / move.ms)) : 1;
    const L0 = move && !review && move.fromCentre !== null
      ? layout({ width, height, lanes: move.fromLanes || lanes, centreMidi: move.fromCentre, nowFrac: st.nowFrac, pxPerSec: st.pxPerSec, gutter: C.gutterPx }) : null;
    drawSky(L);
    if (L0) drawLanes(L0, null, move.cutT !== null ? prevTarget : st.target, 1 - mk);
    drawLanes(L, activeLane, st.target, L0 ? mk : 1);
    const va = Math.min(1, Math.max(0, st.voiceAlpha));
    // The curtain goes down before the band, the line and the tags, so all of them stay on
    // top of the light (spec 6.5). Its cost is timed: this runs while the microphone is judged.
    const gs = guard.state(nowMs);
    // The light is the voice: with no voiced reading for restAfterMs (a result held on screen,
    // a pause, the reference tone) the curtain eases away, and eases back with the voice. So
    // a fresh target, which clears the old trail quickly, never finds a bright curtain to cut.
    const singing = !wanted || performance.now() - voicedAtMs <= AU.restAfterMs;
    // Not on a picture resting after a pause (bugs.md 71): Resume draws one still frame before
    // its loop starts, and that frame put a curtain the pause had eased away back at full.
    restGain = restGain === null || (!wanted && !restHeld) ? 1 : !wanted ? restGain : singing
      ? Math.min(1, restGain + (frameDt * 1000) / (AU.restInMs || AU.stepFadeMs)) : Math.max(0, restGain - (frameDt * 1000) / (AU.restOutMs || AU.stepFadeMs));
    const want = auroraWanted() && !!sprites && !review ? 1 : 0;
    // The switch fades like a guard step; a still picture (no loop) is simply drawn settled.
    auroraGain = auroraGain === null || !wanted ? want : want > auroraGain
      ? Math.min(want, auroraGain + (frameDt * 1000) / AU.stepFadeMs) : Math.max(want, auroraGain - (frameDt * 1000) / AU.stepFadeMs);
    auroraCols = 0;
    auroraTier = gs.tier;
    // Linear, like the other curtain gains: an eased ramp peaks 1.5 times steeper, and the
    // steepest 120 ms is what the flash number reads.
    slideGain = slideGain === null || !wanted ? 1 : slideOut
      ? Math.max(0, slideGain - (frameDt * 1000) / AU.slideOutMs) : Math.min(1, slideGain + (frameDt * 1000) / AU.slideInMs);
    const base = auroraGain * gs.gain, ag = base * slideGain, sv = slideGain * restGain;
    const tA = performance.now();
    const parts = [];
    const lit = (La, k, tAfter, tUpTo) => {
      if (!La || !(k > 0)) return;
      parts.push({ L: La, k, fromT: Math.max(tAfter, curtainFromT), upTo: tUpTo });
      drawAurora(La, now, base * k, tAfter, tUpTo, nowMs, gs.colPx);
    };
    if (ag > 0 && sprites && !review) {
      if (move && move.cutT === null) {
        // hideT here too: a trail already faded out for a fresh target gets no light again
        // (measured in labs/aurora-lab.html: it added 0.04 to the flash number).
        lit(L0, sv * (1 - mk) * (move.fromAlpha ?? va), hideT, Infinity);
        lit(L, sv * mk * va, hideT, Infinity);
      } else {
        const cut = move ? move.cutT : -Infinity;
        // A fresh target clears the old line in freshHoldMs. The old curtain is far more
        // light than the line, so it eases out over cutFadeMs instead, riding its own lane
        // while the view slides (measured: the quick cut was the stage's largest change).
        const gk = auroraGhost && !(move && L0) ? 1 - (performance.now() - auroraGhost.sinceMs) / AU.cutFadeMs : 0;
        // (the slower of the two fades, not both at once)
        if (gk > 0) lit(ghostL(L, lanes), slideGain * Math.min(gk, restGain) * va, auroraGhost.fromT, auroraGhost.cutT);
        else if (move) lit(L0 || L, sv * (1 - mk) * va, hideT, cut);
        if (auroraGhost && !(gk > 0) && !move) auroraGhost = null;
        lit(L, sv * va, Math.max(cut, hideT), Infinity);
      }
    }
    curtainLit = auroraCols > 0;
    litParts = curtainLit ? parts : [];
    if (auroraLeft) {
      const k = wanted && !review ? 1 - (performance.now() - auroraLeft.sinceMs) / AU.cutFadeMs : 0;
      if (k > 0) { if (sprites) for (const p of auroraLeft.parts) drawAurora(p.L, auroraLeft.now, base * p.k * k, p.fromT, p.upTo, nowMs, gs.colPx, auroraLeft.pts); }
      else auroraLeft = null;
    }
    auroraMs = performance.now() - tA;
    if (move && move.lanesOnly) drawTarget(L, now, nowMs); else drawTarget(L, now, nowMs, L0, mk);
    drawRibbons(L, now, nowMs, pts);
    if (review) lastRuns = drawVoice(L, pts, now);
    else if (move && move.cutT === null) {
      // A fit that dims the line: the old picture keeps the strength it had, so the line
      // eases down with the fade instead of dropping in one frame.
      // hideT here too: a trail already faded out for a fresh target stays gone (it came
      // back for the length of a lanes-only cross-fade).
      const kept = hideT === -Infinity ? pts : pts.filter((p) => p.t > hideT);
      drawVoice(L0, kept, now, (1 - mk) * (move.fromAlpha ?? va));
      lastRuns = drawVoice(L, kept, now, mk * va);
    } else {
      const cut = move ? move.cutT : -Infinity;
      if (move) drawVoice(L0 || L, pts.filter((p) => p.t <= cut && p.t > hideT), now, (1 - mk) * va);
      const limit = Math.max(cut, hideT);
      lastRuns = drawVoice(L, limit === -Infinity ? pts : pts.filter((p) => p.t > limit), now, va);
    }
    if (st.state === 'review') {
      headState = 'none';
      if (Number.isFinite(st.cursor)) {
        const t = t0 + st.cursor, x = L.xOfTime(t, now);
        ctx.strokeStyle = tokens.lineStrong;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        const p = nearestPoint(pts, t);
        if (p) {
          ctx.fillStyle = colourOf(p.kind);
          ctx.beginPath();
          ctx.arc(x, L.yOfMidi(p.midi), 5, 0, 2 * Math.PI);
          ctx.fill();
          const text = displayNote(p.midi, st.noteStyle).text;
          pill(ctx, text, x + (x > width - 90 ? -12 : 12), Math.max(16, L.yOfMidi(p.midi) - 18), { align: x > width - 90 ? 'right' : 'left' });
        }
      }
    } else {
      headState = drawHead(L, now, frameDt);
      for (const fn of layers) fn(ctx, L, tokens, { from: L0, k: mk });
      // Only an explicit false hides it: a caller that never heard of the option, or passes
      // undefined, keeps the line.
      if (st.nowLine !== false) drawNowLine(L);
    }
    if (nowMs - labelAtMs >= config.hud.announceEveryMs) {
      labelAtMs = nowMs;
      canvas.setAttribute('aria-label', describeForLabel());
    }
    // Only looped frames count: a still picture's time says nothing about the live cost.
    if (wanted) {
      const frameMs = performance.now() - t0Ms;
      auroraTimes[timeAt] = auroraMs;
      frameTimes[timeAt] = frameMs;
      timeAt = (timeAt + 1) % frameTimes.length;
      timeCount = Math.min(frameTimes.length, timeCount + 1);
      if (st.state === 'live') guard.frame(frameMs, nowMs);
    }
  }

  function nearestPoint(pts, t) {
    let best = null, bestD = 0.1;       // nothing further than 100 ms counts as "at" the cursor
    for (const p of pts) {
      if (!Number.isFinite(p.midi)) continue;
      const d = Math.abs(p.t - t);
      if (d <= bestD) { best = p; bestD = d; }
    }
    return best;
  }

  function describeForLabel() {
    const parts = [st.state === 'review' ? 'Your take.' : 'Live pitch line.'];
    if (st.target) parts.push(`Target ${displayNote(st.target.midi, st.noteStyle).text}.`);
    else if (st.ribbon) parts.push('A path to follow with your voice.');
    const s = last && last.shown;
    if (st.state === 'live' && s && !s.listening) {
      parts.push(s.verdict && s.verdict.octave ? `You are on ${s.noteText}. ${s.verdict.word}.`
        : s.numberText === 'On the note' ? `You are on ${s.noteText}.` : `You are on ${s.noteText}, ${s.numberText}.`);
    } else if (st.state === 'live') parts.push('Listening.');
    else if (CARD_WORDS[st.state]) parts.push(`${CARD_WORDS[st.state]}.`);
    return parts.join(' ');
  }

  // ---- the centre card and caption (DOM, so the words are real text and Resume is a button)
  function syncCard() {
    root.dataset.state = st.state;
    root.classList.toggle('is-calm', !!st.calm);
    cardIcon.replaceChildren();
    resume.hidden = st.state !== 'paused';
    let words = CARD_WORDS[st.state] || '';
    if (st.state === 'starting') cardIcon.append(icon('mic', 32));
    if (st.state === 'countin' && st.countIn !== null) {
      // A fresh element per number, so each one runs its own fade in and out.
      // The disc keeps the target band from running through the digit (review 1, m8).
      cardIcon.append(h('span', { class: 'stage-count-disc', 'aria-hidden': 'true' },
        h('span', { class: 'stage-count-label' }, 'Sing in'), h('span', { class: 'stage-count' }, String(st.countIn))));
      words = `Sing in ${st.countIn}`;
    }
    cardText.textContent = words;
    cardText.classList.toggle('visually-hidden', st.state === 'countin');
    card.classList.toggle('is-shown', !!words);
    const dur = take && take.length ? take[take.length - 1].t - take[0].t : 0;
    const cap = st.state === 'tone' ? 'Listen…' : st.state === 'review' ? `Your take · ${fmtClock(dur)}` : '';
    caption.textContent = cap;
    caption.classList.toggle('is-shown', !!cap);
  }

  // ---- the loop: runs only while wanted, the tab is showing and the stage is on screen
  const loop = (ms) => {
    raf = 0;
    if (!wanted || document.hidden || !visible) return;
    render(ms);
    raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (raf || !wanted || document.hidden || !visible) return;
    lastRenderMs = performance.now();
    raf = requestAnimationFrame(loop);
  };
  const halt = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const onVisibility = () => (document.hidden ? halt() : kick());
  const onTheme = () => { readTokens(); render(); };
  const onAurora = () => { kick(); if (!raf) render(); };
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('mt:theme', onTheme);
  document.addEventListener('mt:aurora', onAurora);
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  const io = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) kick(); else halt();
  });
  io.observe(root);
  resume.addEventListener('click', () => { if (onResume) onResume(); });

  syncCard();
  resize();

  return {
    el: root, canvas,
    set(patch = {}) {
      const before = st.state, targetBefore = st.target, calmBefore = !!st.calm, ribbonBefore = st.ribbon;
      const marksBefore = st.noteMarks, labelsBefore = st.barLabels;
      let jumped = false;
      Object.assign(st, patch);
      if (!!st.calm !== calmBefore && tokens) buildSprites();
      // The saved range may have been measured since the last take: read it as singing starts.
      if (st.state === 'live' && before !== 'live') readSavedRange();
      if ('target' in patch && (targetBefore ? targetBefore.midi : null) !== (st.target ? st.target.midi : null)) {
        prevTarget = wanted ? targetBefore : null;
        targetSinceMs = performance.now();
        pinTarget = false;
        const jump = !!targetBefore && !!st.target && isViewJump(targetBefore.midi, st.target.midi, C);
        if (wanted && targetBefore && st.target && (jump || st.freshTarget)) {
          if (move && move.cutT !== null) hideT = Math.max(hideT, move.cutT);
          const cutT = points.length ? points[points.length - 1].t : -Infinity;
          if (jump) {
            // Too far to slide calmly (an octave took 4 s): the old picture fades out where
            // it is and the new one fades in already centred (review 2, finding 2).
            move = { sinceMs: targetSinceMs, ms: C.targetFadeMs, fromCentre: centre, cutT };
            snapNext = true;
            jumped = true;
          } else {
            move = { sinceMs: targetSinceMs, ms: C.freshHoldMs, fromCentre: null, cutT };
            // The old trail's curtain is a broad light, not a thin line: it takes longer to go.
            auroraGhost = { fromT: hideT, cutT, sinceMs: targetSinceMs, centre };
            holdUntilMs = targetSinceMs + C.freshHoldMs;
            travel = st.state === 'tone' ? { from: centre } : null;
          }
          // The head belongs to the old note; the tag and chip ease out by themselves.
          last = null; lastVoiced = null;
        }
      }
      if (jumped || !st.target) travel = null;
      if (travel && st.state !== 'tone') {
        // The slide was cut short (paused, or the tone ended first). The voice line is
        // drawn against the lanes, so the lanes go to the band now: a cross-fade, no slide.
        const to = Math.round(st.target.midi);
        // As recentre() and fit(): an old trail still fading out is not handed to the new fade.
        if (move && move.cutT !== null) hideT = Math.max(hideT, move.cutT);
        if (wanted && Math.abs(centre - to) > 0.01) move = { sinceMs: performance.now(), ms: C.targetFadeMs, fromCentre: centre, cutT: null, lanesOnly: true };
        centre = goal = to;
        travel = null;
      }
      if (st.state === 'tone' && before !== 'tone') toneStartMs = performance.now();
      if ('ribbon' in patch && patch.ribbon !== ribbonBefore) {
        prevRibbon = wanted ? ribbonBefore : null;
        prevMarks = prevRibbon && Array.isArray(marksBefore) && marksBefore.length ? marksBefore : null;
        prevLabels = prevRibbon ? labelsBefore : false;
        prevNow = ribbonNow;
        ribbonSinceMs = performance.now();
        readout.reset();
      }
      if ('target' in patch) readout.reset();
      syncCard();
      labelAtMs = -Infinity;
      if (!raf) render();
    },
    push(frame, level = 0) {
      if (st.state !== 'live') return last;
      const on = ribbonReading(st.ribbon, frame.t, st.ribbonJudge);
      last = readout.push(frame, {
        target: st.target ? st.target.midi : on.target, level, noteStyle: st.noteStyle, octaveCents: st.octaveCents,
        ribbon: on.ribbon,
      });
      if (last.voiced) { lastVoiced = { t: last.t, midi: last.midi }; voicedAtMs = performance.now(); }
      const dt = pushT === null ? 0 : frame.t - pushT;
      // The clock jumped (an exercise reopened the microphone and left a gap): the whole trail
      // moves that far along in one frame. The line is thin; the lit curtain leaving the head
      // at once was the range finder's largest change (labs/range-lab.html: 0.17 and 0.23 on
      // the flash number, 0.08 and 0.10 with no curtain). So the old curtain stays where it
      // stood and eases out over cutFadeMs, and the new one grows from the new readings.
      if (dt > AU.gapSec && points.length) {
        auroraLeft = wanted && curtainLit && litParts.length
          ? { pts: points.slice(), now: pushT, parts: litParts, sinceMs: performance.now() } : null;
        curtainFromT = pushT;
      }
      pushT = frame.t;
      lvNow = follow(lvNow, levelToLv(level, AU), dt, AU.lvSmoothMs);
      let grow = 0;
      if (last.voiced) {
        // In tune without a break: the curtain grows as the hold ring fills. An exercise with
        // a ring says how full it is (stage.hold); without one the stage times the same thing.
        if (holdK !== null) grow = holdK;
        else if (last.kind === 'in') { if (inSince === null) inSince = frame.t; grow = Math.min(1, ((frame.t - inSince) * 1000) / config.hold.holdMs); } else inSince = null;
        const r = st.auroraRange || savedRange;
        const lo = r && Number.isFinite(r.low) ? r.low : AU.freeLowMidi, hi = r && Number.isFinite(r.high) && r.high > lo ? r.high : Math.max(lo + 1, AU.freeHighMidi);
        hueNow = follow(hueNow, Math.min(1, Math.max(0, (last.midi - lo) / (hi - lo))), dt, AU.hueSmoothMs);
      } else { inSince = null; hueNow = null; }
      points.push({ t: frame.t, midi: last.voiced ? last.midi : null, kind: last.voiced ? last.kind : null, lv: lvNow, grow, hue: hueNow ?? 0.5 });
      // Keep a little more than is promised so a take can be cut cleanly to historySec.
      while (points.length && frame.t - points[0].t > C.historySec + 1) points.shift();
      return last;
    },
    // The hold ring's fill for the reading just pushed, so the curtain grows with the real
    // hold (wobble forgiveness, the release rule) and not with a second clock.
    hold(k) {
      holdK = Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : null;
      const p = points[points.length - 1];
      if (p && holdK !== null && p.midi !== null) p.grow = holdK;
    },
    readout: () => last,
    // The contract's three fields only: what the aurora keeps per point is its own business.
    points: () => points.map((p) => ({ t: p.t, midi: p.midi, kind: p.kind })),
    showTake(pts) {
      take = pts.map((p) => ({ ...p }));
      st.state = 'review';
      st.cursor = null;
      syncCard();
      render();
    },
    reset() {
      // The same for a trail dropped while the loop runs (Stop in the range finder, calm
      // motion: 0.21 to 0.23 on the flash number, 0.15 with this): the line goes at once, the
      // light eases out.
      // (A second reset with nothing new to drop leaves the first one's curtain easing out.)
      if (!wanted) auroraLeft = null;
      else if (curtainLit && points.length && litParts.length) auroraLeft = { pts: points, now: points[points.length - 1].t, parts: litParts, sinceMs: performance.now() };
      curtainFromT = -Infinity;
      points = []; take = null; last = null; lastVoiced = null; snapNext = true;
      tagMark.a = 0; outMark.a = 0;
      move = null; hideT = -Infinity; holdUntilMs = 0; pinTarget = false; travel = null; fitTo = null; auroraGhost = null; restGain = null; slideGain = null; slideOut = false; curtainLit = false;
      lvNow = null; hueNow = null; inSince = null; pushT = null; holdK = null; litParts = [];
      haloGhost = null;                  // the halo itself eases out where it was (drawHalo)
      restHeld = false;
      readout.reset();
      if (!raf) render();
    },
    render,
    settle() { snapNext = true; if (!raf) render(); },
    recentre() {
      if (!st.target || st.state === 'review') return;
      const to = Math.round(st.target.midi);
      pinTarget = true;
      travel = null;
      if (Math.abs(centre - to) < 0.01) return;
      if (move && move.cutT !== null) hideT = Math.max(hideT, move.cutT);
      move = wanted ? { sinceMs: performance.now(), ms: C.targetFadeMs, fromCentre: centre, cutT: null } : null;
      centre = goal = to;
      if (!raf) render();
    },
    fit(range, { ms = 0 } = {}) {
      const to = range && Number.isFinite(range.low) && Number.isFinite(range.high) && range.high >= range.low
        ? { low: Math.floor(range.low), high: Math.ceil(range.high) } : null;
      if (st.state === 'review' || (!to && !fitTo)) return;
      if (move && move.cutT !== null) hideT = Math.max(hideT, move.cutT);
      // fromAlpha: the caller sets voiceAlpha just after; the old picture fades from full.
      move = wanted && ms > 0 ? { sinceMs: performance.now(), ms, fromCentre: centre, fromLanes: shownLanes, fromAlpha: st.voiceAlpha, cutT: null } : null;
      fitTo = to;
      travel = null;
      if (!to) snapNext = true;
      if (!raf) render();
    },
    start() { wanted = true; kick(); },
    // A curtain still easing out would be left half lit on the resting picture.
    stop() { wanted = false; restHeld = st.state === 'paused' || st.state === 'lost'; halt(); if (auroraLeft) { auroraLeft = null; render(); } },
    addLayer(fn) { layers.push(fn); },
    onResume(fn) { onResume = fn; },
    // tag and out are the words on the canvas right now ('' while hidden), so a lab can
    // read them without reading pixels.
    debug: () => ({
      centre, goal, runs: lastRuns, leaps: lastLeaps, head: headState, running: !!raf, state: st.state, width, height,
      tag: tagMark.a > 0.01 ? tagMark.text : '', out: outMark.a > 0.01 ? outMark.text : '', fading: !!move,
      fit: fitTo ? { ...fitTo } : null, lanes: shownLanes, ribbon: st.ribbon ? { dot: ribbonDot, marks: (st.ribbonMarks || []).length, judge: st.ribbonJudge, noteMarks: (st.noteMarks || []).length, labels: !!st.barLabels } : null, grid: st.grid, voiceAlpha: st.voiceAlpha, nowLine: st.nowLine !== false,
      // The curtain's last frame: milliseconds spent on it, columns drawn, the guard's step.
      auroraMs, auroraCols, auroraTier, sparks: lastSparks, halo: Number(haloK.toFixed(2)),
    }),
    // The slower numbers, for a lab (debug() is read on every pitch frame, so it stays cheap):
    // 95th percentiles over the last 600 looped frames, and what the curtain looks like now.
    auroraStats() {
      const p95 = (buf) => { const a = Array.from(buf.subarray(0, timeCount)).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0; };
      const c = curtain.cols, shown = new Set();
      let maxA = 0, minX = Infinity, tall = 0;
      for (let i = 0; i < c.n; i++) if (c.a[i] > 0) { shown.add(c.sprite[i]); if (c.a[i] > maxA) maxA = c.a[i]; if (c.x[i] < minX) minX = c.x[i]; if (c.h[i] > tall) tall = c.h[i]; }
      return {
        frames: timeCount, auroraP95Ms: p95(auroraTimes), frameP95Ms: p95(frameTimes), cols: auroraCols, tier: auroraTier,
        on: auroraWanted() && !!sprites, gain: auroraGain ?? 0, calm: !!st.calm, light, sprites: [...shown].sort(), maxAlpha: maxA, maxHeightPx: tall,
        minX: Number.isFinite(minX) ? minX : null, colPx: c.w, paintMs: sprites ? sprites.paintMs : 0,
        paintTotalMs: sprites ? sprites.paintTotalMs : 0, paintSlices: sprites ? sprites.slices : 0, spritesReady: !!sprites && sprites.ready,
      };
    },
    // Resolves once the sprites are painted (a cold first paint takes a few frames): a lab
    // that reads a still picture's pixels waits for this.
    auroraReady: () => { if (!tokens) readTokens(); return sprites ? sprites.whenReady.then(() => true) : Promise.resolve(false); },
    // Forget the timings (a lab comparing two runs starts each from nothing).
    auroraClear() { timeAt = 0; timeCount = 0; },
    destroy() {
      halt();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('mt:theme', onTheme);
      document.removeEventListener('mt:aurora', onAurora);
      root.remove();
    },
  };
}
