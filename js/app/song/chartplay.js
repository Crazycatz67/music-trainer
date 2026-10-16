// chartplay.js — open a charted song (a bundled demo song, or a chart the owner analysed) on
// the Sing page as if it were a dropped song (bug 84). A chart has notes and words but no
// sound, so the Sing page refused it and the level switch (which needs a chart) could not be
// reached. chartsong.js already makes the record, the pitch line and the buffers from the
// notes; this file hands them over in the shapes openSong reads from the song store
// (store.get, store.audio, store.curve), so nothing downstream has to know.
//
// Pure: no browser globals, no network; the synth is handed in. Imports in Node.
//
// CONTRACT
//   isChart(entry) -> boolean   the entry (store.list / store.get) carries a written tune:
//       kind 'demo' or 'chart'. A list entry has no timeline yet; store.get adds it.
//   chartOpen(entry, { sampleRate, synth, guideTimbre }) -> { song, curve, audio }
//       guideTimbre: the melody's timbre (the singer's Reference tone, timbreFor); default
//       CHART.guide.timbre. Only the vocal changes; the drone and the clicks do not.
//       entry: store.get(id) of a demo or chart (with `timeline`). synth = { renderTone }
//       (js/synth.js). Throws TypeError without a timeline with sung notes or without a
//       synth, RangeError for a sample rate not above 0 (chartsong.js).
//       song  the entry with duration, phrases, words, hasWords and timeline from
//             songFromChart (its own id, kind, title, octave, key... are kept); hasBacking
//             and hasSinger true: it now has both.
//       curve the chart's pitch line (Curve, engine 'chart'), the ribbon and the targets.
//       audio { backing: { channels, sampleRate }, vocal: { samples, sampleRate } } as
//             store.audio gives: the backing is a soft drone under each phrase and the count
//             clicks; the vocal (heard as the Guide voice) is the melody, one tone a note.
//       Rendered at octave 0 and as written (tempo 1): like a dropped song's sound, the
//       octave and key the singer picks move the targets, not the music.
//   easiestFirst(entries) -> a new array: rating low to high, unrated last, then by title.

import { guidePlan, renderPlan, songFromChart } from './chartsong.js';

export const isChart = (entry) => !!entry && (entry.kind === 'demo' || entry.kind === 'chart');

export function chartOpen(entry, { sampleRate, synth, guideTimbre } = {}) {
  if (!entry || !entry.timeline) throw new TypeError('chartplay: a demo or chart entry with its timeline is required (store.get)');
  const made = songFromChart(entry.timeline, { id: entry.id, title: entry.title, artist: entry.artist, fileName: entry.fileName });
  const sound = renderPlan(guidePlan(entry.timeline), sampleRate, synth, { guideTimbre });
  const song = {
    ...entry,
    duration: made.duration, phrases: made.phrases, words: entry.words || made.words,
    hasWords: !!(entry.words || made.words), timeline: made.timeline,
    hasBacking: true, hasSinger: true,
  };
  return {
    song,
    curve: made.curve,
    audio: { backing: sound.backing, vocal: { samples: sound.guide.samples, sampleRate: sound.sampleRate } },
  };
}

const rated = (e) => Number.isFinite(e && e.rating);
export function easiestFirst(entries) {
  return [...(entries || [])].sort((a, b) => (rated(b) - rated(a)) || (rated(a) ? a.rating - b.rating : 0)
    || String(a.title || '').localeCompare(String(b.title || '')));
}
