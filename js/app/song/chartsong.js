// chartsong.js — a note chart standing in for a dropped song, so a demo song can be sung at
// once: no file of the owner's, no model download. Pure: no browser globals, no sound, no
// network; imports in Node (tools/checks/chartsong.check.mjs runs it on every demo chart).
//
// A dropped song reaches the Sing page as a record (songstore.js get), a pitch line
// (store.curve) and sound (store.audio: the backing, and the separated singer as a guide).
// A chart has notes and words but no sound. This file makes all three from the notes: the
// record and the pitch line (songFromChart), a list of tones to synthesise (guidePlan), and
// the buffers themselves when handed a synth (renderPlan).
//
// TIME is seconds from the start of the song, PITCH is MIDI floats (69 = A4), as everywhere.
//
// WHAT IS NEVER INVENTED: a freestyle or rap note (timeline.meta.unpitched) has words and
// no pitch. Its words are shown; it gets no target, no phrase, no guide tone.
//
// CONTRACT
//   songFromChart(timeline, { id?, title?, artist?, fileName?, tempoScale = 1, at = null }) -> song
//       timeline: js/timeline.js, as parseUltraStar or midiToTimeline gives it.
//       Throws TypeError when the timeline has no note with a time, a length and a pitch.
//       song = {
//         id          given, else 'demo:<timeline.file or title>' (the song store's demo ids)
//         kind        'chart'
//         title, artist, fileName, addedAt: null
//         duration    the end of the last note (sung or spoken) + CHART.tailSec
//         curve       a Curve (js/app/analyse/curve.js; engine 'chart'): one frame every
//                     CHART.curve.hopSec, each sung note a flat stretch at its midi, every
//                     rest unvoiced (midi null). curveAt, transposeCurve, curveRange and
//                     derivePhrases work on it unchanged. curveAt at the middle of a note at
//                     least 3 hops long is exactly the note's midi.
//         range       curveRange(curve)
//         phrases     [{ t, end }] in time order, never overlapping, covering every sung
//                     note. A new phrase starts at each of the chart's line breaks and after
//                     a rest of CHART.phrases.restSec inside a line. A timeline with no line
//                     marks (MIDI) is cut at every rest of SONG.phrases.gapSec instead.
//         words       null when the chart has no text, else the shape in words.js with
//                     route 'chart', timing 'word', offsetSec 0 and one line per chart line:
//                     { t, end, text, words: [{ t, end, text, syllables: [{ t, end, text }] }] }
//                     A "~" note lengthens the syllable before it. lineSpans() and
//                     markerAt() read it unchanged (they ignore `words`).
//         timeline    { title, artist?, bpm?, source?, notes } the notes the curve was made
//                     from: sorted, overlaps cut, each { t, dur, midi, lyric?, line?, golden? }
//         credit      the chart's #CREATOR (what the song store shows for a demo song)
//         credits     { creator, composer, lyricist, publicDomain, source, license,
//                       language }   each a string, '' when the chart does not say
//         counts      { sung, unpitched, golden, cut, dropped }   cut = notes shortened
//                     because the next began before they ended; dropped = notes left out
//                     (no pitch, no length, or a second note starting at the same moment)
//         tempoScale, bpm (the chart's, times tempoScale; null when it has none)
//         octave: 0, key: 0, guide: 0, lastSungAt: null, bestLines: null, chartId: null,
//         curveId: null, hasSinger: false, hasBacking: false, hasWords, bytes: 0
//       }
//       tempoScale: 1 = as written, 0.5 = half speed; held to CHART.tempo.min..max. Every
//       time in the song is the chart's time divided by it.
//   guidePlan(timeline, { octave = 0, tempoScale = 1 }) -> plan
//       plan = {
//         duration, octave, tempoScale,
//         key      { root: 0..11 (0 = C), mode: 'major' | 'minor' | null, from: 'profile' | 'last-note' }
//         guide    [{ t, dur, midi }]              one tone a sung note, the melody
//         backing  [{ t, dur, midi, gain, part: 'root' | 'fifth' }]   the drone under each phrase
//         clicks   [{ t, dur, hz, gain }]          the count before each phrase that has one
//                                                  on screen (phrases.js beadTimes)
//       }
//       octave is a whole number within +-CHART.maxOctaves; it moves the guide and the drone.
//       duration and every time match songFromChart with the same tempoScale.
//   renderPlan(plan, sampleRate, synth) -> {
//         duration, sampleRate,
//         backing  { channels: [Float32Array, Float32Array], sampleRate }   for player.load
//         guide    { samples: Float32Array, channels: [the same twice], sampleRate }   for
//                  player.setLayer('guide', { samples, sampleRate, at: 0, gain })
//         peak     { backing, guide }   0..1
//         skipped  tones the synth refused (too high for the sample rate)
//       }
//       synth = { renderTone } (js/synth.js). Both channels of a pair are ONE array: the
//       drone is the same in both ears. Throws RangeError for a sample rate that is not above
//       0, TypeError without synth.renderTone. A buffer that would pass full scale is
//       turned down as a whole.
//   fitChartToRange(song, range) -> { octave, shift, fits, fitsAfter, overLow, overHigh,
//                                     low, high, code, reason }
//       range = { lowMidi, highMidi } (js/app/range.js readRange / exerciseRange).
//       octave: the move within +-CHART.maxOctaves that leaves the fewest notes outside the
//       range; of equals, the smaller move, then the lower. shift = 12 * octave.
//       fits: it fits as written (null without a range). overLow / overHigh: whole notes
//       still outside after the move. code: 'fits' | 'moved' | 'closest' | 'no-range' |
//       'no-notes'; reason: the same in plain words.
//   keyOf(notes) -> the `key` above        chartLines(timeline) -> the `words.lines` above

import { CHART } from './chartsong.config.js';
import { SONG } from './config.js';
import { beadTimes } from './phrases.js';
import { makeWords } from './words.js';
import { curveRange, makeCurve } from '../analyse/curve.js';
import { fitTimeline } from '../range.js';

const tidy = (x) => Math.round(x * 1e6) / 1e6;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const speedOf = (s) => (isNum(s) && s > 0 ? clamp(s, CHART.tempo.min, CHART.tempo.max) : 1);
const octaveOf = (o) => (Number.isInteger(o) ? clamp(o, -CHART.maxOctaves, CHART.maxOctaves) : 0);

// ---------------------------------------------------------------- the notes

// The notes a curve can be made from: scaled to the speed, in time order, never two at once.
function prepare(timeline, tempoScale) {
  if (!timeline || !Array.isArray(timeline.notes)) throw new TypeError('chartsong: a timeline with notes is required');
  const speed = speedOf(tempoScale);
  const scale = (n) => ({ ...n, t: tidy(n.t / speed), dur: tidy(n.dur / speed) });
  const good = (n) => n && isNum(n.t) && n.t >= 0 && isNum(n.dur) && n.dur > 0;
  let dropped = 0, cut = 0;
  const sorted = [];
  for (const n of timeline.notes) {
    if (good(n) && isNum(n.midi)) sorted.push(scale(n)); else dropped++;
  }
  sorted.sort((a, b) => a.t - b.t);
  // One voice sings one note at a time: a note still sounding when the next begins is cut
  // there; of two that begin together the first written stays.
  const notes = [];
  for (const n of sorted) {
    const prev = notes[notes.length - 1];
    if (prev && n.t <= prev.t + 1e-9) { dropped++; continue; }
    if (prev && prev.t + prev.dur > n.t + 1e-9) { prev.dur = tidy(n.t - prev.t); cut++; }
    notes.push(n);
  }
  if (!notes.length) throw new TypeError('chartsong: the chart has no note with a time, a length and a pitch');
  const unpitched = ((timeline.meta && timeline.meta.unpitched) || []).filter(good).map(scale).sort((a, b) => a.t - b.t);
  const end = [...notes, ...unpitched].reduce((m, n) => Math.max(m, n.t + n.dur), 0);
  return { speed, notes, unpitched, duration: tidy(end + CHART.tailSec), counts: { sung: notes.length, unpitched: unpitched.length, golden: notes.filter((n) => n.golden).length, cut, dropped } };
}

function phrasesOf(notes) {
  const lined = notes.some((n) => Number.isInteger(n.line));
  const rest = lined ? CHART.phrases.restSec : SONG.phrases.gapSec;
  const out = [];
  let prev = null;
  for (const n of notes) {
    const open = out[out.length - 1];
    if (!open || (lined && n.line !== prev.line) || n.t - open.end >= rest - 1e-9) out.push({ t: n.t, end: tidy(n.t + n.dur) });
    else open.end = tidy(n.t + n.dur);
    prev = n;
  }
  return out;
}

function curveOf(notes, duration) {
  const hop = CHART.curve.hopSec, n = Math.ceil(duration / hop - 1e-9) + 1;
  const t = new Array(n), midi = new Array(n).fill(null), level = new Array(n).fill(0), voiced = new Array(n).fill(false);
  for (let i = 0; i < n; i++) t[i] = tidy(i * hop);
  const put = (i, m) => { if (i >= 0 && i < n) { midi[i] = m; level[i] = CHART.curve.level; voiced[i] = true; } };
  for (const note of notes) {
    // The frames whose centre lies in the note: from its start up to, not at, its end.
    const from = Math.ceil(note.t / hop - 1e-6), to = Math.ceil((note.t + note.dur) / hop - 1e-6) - 1;
    for (let i = from; i <= to; i++) put(i, note.midi);
    // A note shorter than a hop that lies between two frames still gets one.
    if (to < from) put(Math.round((note.t + note.dur / 2) / hop), note.midi);
  }
  return makeCurve({ t, midi, level, voiced, engine: 'chart' });
}

// ---------------------------------------------------------------- the words

const lineText = (words) => words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();

// Lines, words and syllables with their times, from notes that carry `lyric`. `groupOf`
// says which line a note is in.
function linesFrom(notes, groupOf) {
  const lines = [];
  let line = null, group, spaceBefore = false;
  for (const n of notes) {
    const g = groupOf(n);
    if (g === null) continue;
    if (!line || g !== group) { line = { t: n.t, end: n.t, text: '', words: [] }; lines.push(line); group = g; spaceBefore = true; }
    const raw = typeof n.lyric === 'string' ? n.lyric : '';
    const text = raw.replace(/~/g, '').trim(), end = tidy(n.t + n.dur);
    line.end = Math.max(line.end, end);
    const word = line.words[line.words.length - 1];
    if (!text) {
      // "~" (or nothing): the syllable before is held through this note.
      if (word) { word.end = end; word.syllables[word.syllables.length - 1].end = end; }
    } else if (!word || spaceBefore || /^\s/.test(raw)) {
      line.words.push({ t: n.t, end, text, syllables: [{ t: n.t, end, text }] });
    } else {
      word.text += text; word.end = end;
      word.syllables.push({ t: n.t, end, text });
    }
    spaceBefore = /\s$/.test(raw);
  }
  for (const l of lines) l.text = lineText(l.words);
  return lines.filter((l) => l.text);
}

export function chartLines(timeline, { tempoScale = 1 } = {}) {
  const p = prepare(timeline, tempoScale);
  return linesOf(p, phrasesOf(p.notes));
}

function linesOf(p, phrases) {
  const all = [...p.notes, ...p.unpitched].sort((a, b) => a.t - b.t);
  if (all.some((n) => Number.isInteger(n.line))) return linesFrom(all, (n) => (Number.isInteger(n.line) ? n.line : null));
  // No line marks (a MIDI file with words): a line is a phrase.
  return linesFrom(p.notes, (n) => { const i = phrases.findIndex((ph) => n.t >= ph.t - 1e-9 && n.t < ph.end); return i < 0 ? null : i; });
}

// ---------------------------------------------------------------- the song

const header = (timeline, tag) => {
  const h = timeline.meta && timeline.meta.headers;
  return h && typeof h[tag] === 'string' ? h[tag].trim() : '';
};

export function songFromChart(timeline, { id, title, artist, fileName, tempoScale = 1, at = null } = {}) {
  const p = prepare(timeline, tempoScale);
  const phrases = phrasesOf(p.notes);
  const curve = curveOf(p.notes, p.duration);
  const lines = linesOf(p, phrases);
  const credit = header(timeline, 'CREATOR');
  let words = null;
  if (lines.length) {
    // makeWords keeps { t, end, text } only and names the timing by line; a chart knows
    // every word's time, so the words go back on and the timing says so.
    words = makeWords(lines, { route: 'chart', at, ...(credit ? { credit } : {}) });
    words.timing = 'word';
    words.lines = words.lines.map((l, i) => ({ ...l, words: lines[i].words }));
  }
  const name = (typeof title === 'string' && title.trim()) || timeline.title || 'Untitled';
  const kept = { title: name, notes: p.notes };
  const by = (typeof artist === 'string' && artist.trim()) || timeline.artist || '';
  if (by) kept.artist = by;
  if (isNum(timeline.bpm)) kept.bpm = timeline.bpm * p.speed;
  if (timeline.source) kept.source = timeline.source;
  return {
    id: typeof id === 'string' && id ? id : `demo:${timeline.file || name}`,
    kind: 'chart', title: name, artist: by,
    fileName: typeof fileName === 'string' ? fileName : (timeline.file ? `${timeline.file}.txt` : ''),
    addedAt: null, duration: p.duration,
    curve, range: curveRange(curve), phrases, words, timeline: kept,
    credit,
    credits: {
      creator: credit, composer: header(timeline, 'COMPOSER'), lyricist: header(timeline, 'LYRICIST'),
      publicDomain: header(timeline, 'PUBLICDOMAIN'), source: header(timeline, 'SOURCE'),
      license: header(timeline, 'LICENSE'), language: header(timeline, 'LANGUAGE'),
    },
    counts: p.counts, tempoScale: p.speed, bpm: kept.bpm ?? null,
    octave: 0, key: 0, guide: 0, lastSungAt: null, bestLines: null, chartId: null,
    curveId: null, hasSinger: false, hasBacking: false, hasWords: !!words, bytes: 0,
  };
}

// ---------------------------------------------------------------- the key

function correlation(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

const pc = (midi) => ((Math.round(midi) % 12) + 12) % 12;

export function keyOf(notes) {
  const sung = (notes || []).filter((n) => n && isNum(n.midi) && isNum(n.dur) && n.dur > 0);
  if (!sung.length) return { root: 0, mode: null, from: 'last-note' };
  const time = new Array(12).fill(0);
  for (const n of sung) time[pc(n.midi)] += n.dur;
  // Too few different notes fit many keys equally: a tune most often ends on its home note.
  if (time.filter((v) => v > 0).length < CHART.key.minPitchClasses) return { root: pc(sung[sung.length - 1].midi), mode: null, from: 'last-note' };
  let best = { root: 0, mode: 'major', r: -Infinity };
  for (const mode of ['major', 'minor']) {
    for (let root = 0; root < 12; root++) {
      const r = correlation(time, CHART.key[mode].map((_, i) => CHART.key[mode][(i - root + 12) % 12]));
      if (r > best.r + 1e-12) best = { root, mode, r };
    }
  }
  return { root: best.root, mode: best.mode, from: 'profile' };
}

// ---------------------------------------------------------------- the tones

export function guidePlan(timeline, { octave = 0, tempoScale = 1 } = {}) {
  const p = prepare(timeline, tempoScale);
  const phrases = phrasesOf(p.notes), up = 12 * octaveOf(octave);
  const G = CHART.guide, B = CHART.backing, C = CHART.clicks;
  const key = keyOf(p.notes);
  const guide = p.notes.map((n) => ({ t: n.t, dur: tidy(n.dur * G.lengthShare), midi: n.midi + up }));

  // The home note under the tune: the highest one far enough below its lowest note.
  const lowest = Math.min(...p.notes.map((n) => n.midi)) + up;
  let root = Math.floor(lowest - B.underSemis);
  while (pc(root) !== key.root) root--;
  while (root < B.floorMidi) root += 12;
  const backing = [];
  phrases.forEach((ph, i) => {
    const t = tidy(Math.max(i ? phrases[i - 1].end : 0, ph.t - B.leadSec)), dur = tidy(ph.end - t);
    backing.push({ t, dur, midi: root, gain: B.rootGain, part: 'root' }, { t, dur, midi: root + B.fifthSemis, gain: B.fifthGain, part: 'fifth' });
  });

  const clicks = [];
  phrases.forEach((_, i) => { for (const t of beadTimes(phrases, i)) if (t >= 0) clicks.push({ t, dur: C.lenSec, hz: C.hz, gain: C.gain }); });
  return { duration: p.duration, octave: octaveOf(octave), tempoScale: p.speed, key, guide, backing, clicks };
}

export function renderPlan(plan, sampleRate, synth) {
  if (!(isNum(sampleRate) && sampleRate > 0)) throw new RangeError(`chartsong: the sample rate must be above 0, got ${sampleRate}`);
  if (!synth || typeof synth.renderTone !== 'function') throw new TypeError('chartsong: renderPlan needs the synth ({ renderTone } of js/synth.js)');
  if (!plan || !(isNum(plan.duration) && plan.duration > 0)) throw new TypeError('chartsong: renderPlan needs a plan from guidePlan');
  const n = Math.ceil(plan.duration * sampleRate);
  const backing = new Float32Array(n), guide = new Float32Array(n);
  let skipped = 0;
  const mix = (into, e, tone) => {
    if (!(isNum(e.t) && isNum(e.dur) && e.dur > 0)) { skipped++; return; }
    let samples;
    // The synth refuses a pitch too high for the sample rate: that tone is left out
    // rather than the whole song.
    try { samples = synth.renderTone({ ...tone, dur: e.dur, sampleRate }); } catch (err) { if (err instanceof RangeError) { skipped++; return; } throw err; }
    const at = Math.round(e.t * sampleRate);
    for (let i = Math.max(0, -at); i < samples.length && at + i < n; i++) into[at + i] += samples[i];
  };
  const G = CHART.guide, B = CHART.backing;
  for (const e of plan.guide || []) mix(guide, e, { midi: e.midi, timbre: G.timbre, gain: G.gain, attack: G.attackSec, release: G.releaseSec });
  for (const e of plan.backing || []) mix(backing, e, { midi: e.midi, timbre: B.timbre, gain: e.gain, attack: B.attackSec, release: B.releaseSec });
  for (const e of plan.clicks || []) mix(backing, e, { hz: e.hz, timbre: 'sine', gain: e.gain, attack: 0.002, release: e.dur / 2 });
  const level = (buf) => {
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    if (peak > 1) { for (let i = 0; i < buf.length; i++) buf[i] /= peak; peak = 1; }
    return peak;
  };
  const peak = { backing: level(backing), guide: level(guide) };
  return {
    duration: n / sampleRate, sampleRate,
    backing: { channels: [backing, backing], sampleRate },
    guide: { samples: guide, channels: [guide, guide], sampleRate },
    peak, skipped,
  };
}

// ---------------------------------------------------------------- the singer's range

const MOVE_WORDS = { '-1': 'An octave lower', 0: 'As written', 1: 'An octave higher' };
const notesWords = (n) => (n === 1 ? '1 note' : `${n} notes`);

export function fitChartToRange(song, range) {
  const timeline = song && song.timeline && Array.isArray(song.timeline.notes) && song.timeline.notes.length
    ? song.timeline
    // A record without its notes (one read back from the store's list): its two ends.
    : { notes: song && song.range && isNum(song.range.lowest) && isNum(song.range.highest) ? [{ t: 0, dur: 1, midi: song.range.lowest }, { t: 1, dur: 1, midi: song.range.highest }] : [] };
  // fitTimeline reads the notes' ends and refuses a range that is not one; its own octave
  // search goes five octaves either way, more than a chart may be moved here.
  const facts = fitTimeline(timeline, range, { octavesOnly: true });
  const base = { octave: 0, shift: 0, fits: facts.fits, fitsAfter: facts.fits, overLow: 0, overHigh: 0, low: facts.low, high: facts.high };
  if (facts.reason === 'no-notes') return { ...base, fits: null, fitsAfter: null, code: 'no-notes', reason: 'This song has no notes to fit.' };
  if (facts.reason === 'no-range') return { ...base, code: 'no-range', reason: 'No saved range yet: the song is left as written.' };
  if (facts.fits) return { ...base, code: 'fits', reason: 'It fits your range as written.' };
  const under = (s) => Math.ceil(Math.max(0, range.lowMidi - (facts.low + s))), over = (s) => Math.ceil(Math.max(0, facts.high + s - range.highMidi));
  // The smaller move first, then the lower: a strict "better" keeps the first of equals.
  const order = [0];
  for (let k = 1; k <= CHART.maxOctaves; k++) order.push(-k, k);
  let octave = 0, cost = Infinity;
  for (const k of order) { const c = under(12 * k) + over(12 * k); if (c < cost) { cost = c; octave = k; } }
  const shift = 12 * octave, overLow = under(shift), overHigh = over(shift), move = MOVE_WORDS[octave] || `${Math.abs(octave)} octaves ${octave < 0 ? 'lower' : 'higher'}`;
  const out = { ...base, octave, shift, fitsAfter: cost === 0, overLow, overHigh };
  if (cost === 0) return { ...out, code: 'moved', reason: `${move} fits your range.` };
  const left = [overHigh ? `${notesWords(overHigh)} above` : '', overLow ? `${notesWords(overLow)} below` : ''].filter(Boolean).join(' and ');
  return { ...out, code: 'closest', reason: `${move} is the closest: it still reaches ${left} your range.` };
}
