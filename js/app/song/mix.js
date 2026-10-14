// mix.js — the take and the backing together: live (through the player) and as a WAV file.
//
// The mixing maths and the WAV gate are PURE (Node and browser); createMixPlayback and
// downloadWav are the thin browser half.
//
// THE EXPORT RULE. A mixed file contains the backing track. It may only be written when the
// backing is the owner's own audio file; the caller says so with `ownFile: true`. For
// anything else (a YouTube video, a track the app did not get from the owner's file) the
// export is refused with a reason and words, and no sound data is produced. The app never
// records or alters YouTube's audio, so there is nothing to mix in that case anyway.
// Nothing here uploads: the WAV is built in memory and handed to the browser's own download.
//
// CONTRACT — pure
//   balanceGains(balance) -> { backing, voice }      balance 0..1: 0 = backing only,
//       0.5 = both at full, 1 = voice only (each side fades only on its far half, so the
//       middle is not quieter than either end)
//   mixDown({ backing: { channels, sampleRate }, take: { samples, sampleRate }, at, balance = 0.5 })
//       -> { channels, sampleRate, peak, scaledBy }
//       The backing's length, channels and sample rate; the take's first sample at song time
//       `at` seconds (negative: its head is cut; past the end: its tail is cut). A take at
//       another sample rate is resampled. If the sum would clip, the whole mix is turned
//       down (scaledBy < 1) rather than clipped.
//   exportMix({ backing, take, at, balance, ownFile, title? }) ->
//       { ok: true, wav: ArrayBuffer, name, seconds, peak, scaledBy }
//     | { ok: false, reason: 'not-own-file' | 'no-backing' | 'no-take' | 'not-lined-up', words }
//   resample(samples, fromRate, toRate) -> Float32Array   straight-line, for the rare mismatch
//   EXPORT_WORDS
//
// CONTRACT — pure, the Sing page's own sliders (while singing, not the take review)
//   A song mix = { music, singer, volume }, each 0..1: the backing alone, the separated
//   singer alone, and everything together. They are independent: neither of the first two
//   changes the other, and 0 means that sound's gain is exactly 0 (player.js).
//   MIX_PRESETS = { singer: { music: 0, singer: 1 }, music: { music: 1, singer: 0 },
//                   both: { music: 1, singer: 1 } }      the three quick buttons
//   MIX_PRESET_WORDS = { singer: 'Singer only', music: 'Music only', both: 'Both' }
//   presetOf({ music, singer }) -> 'singer' | 'music' | 'both' | null (the sliders are elsewhere)
//   songMix(saved, defaults = SONG.levels) -> { music, singer, volume }
//       A saved mix made safe: each level clamped to 0..1; a missing or unreadable one is
//       the default's (defaults.music, defaults.singer ?? defaults.guide, defaults.volume).
//   keepSongMix(mixes, songId, mix, keep = SONG.levels.keptSongs) -> mixes
//       Writes the song's mix into the plain object `mixes` (changed in place), newest
//       last, and drops the oldest past `keep`. The object goes into the page's settings as
//       JSON, so what is read back after a reload is what songMix() is given.
//
// CONTRACT — browser
//   createMixPlayback({ player, take, calibrationMs = null, nudgeMs = take.nudgeMs, balance? }) -> mix
//       Puts the take on the player as the layer 'voice' at takeOffset(...).at and sets the
//       two volumes from the balance. Playing, pausing, seeking and looping stay the
//       player's. Throws if the take cannot be lined up (songStart null).
//     mix.setBalance(0..1) · mix.setNudge(ms) -> the clamped ms · mix.setCalibration(ms | null)
//     mix.state() -> { balance, nudgeMs, calibrationMs, at, delaySec, source }
//     mix.destroy()          removes the layer, backing back to full
//   downloadWav(wav, name)   starts the browser's download; call it from a press

import { SONG } from './config.js';
import { clampNudge, takeOffset } from './align.js';
import { encodeWav, peakOf } from './pcm.js';

export const EXPORT_WORDS = Object.freeze({
  'not-own-file': 'A mixed file can only be saved when the backing track is your own audio file. This song is not playing from a file of yours, so only your voice take is kept.',
  'no-backing': 'There is no backing track loaded to mix with.',
  'no-take': 'There is no recording to mix yet.',
  'not-lined-up': 'This take was recorded while the song was not playing, so it cannot be lined up with it.',
});

export function balanceGains(balance) {
  const b = Math.min(1, Math.max(0, Number.isFinite(balance) ? balance : SONG.mix.balance));
  return { backing: Math.min(1, 2 * (1 - b)), voice: Math.min(1, 2 * b) };
}

const level = (v, fallback) => (v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : fallback);

export const MIX_PRESETS = Object.freeze({
  singer: Object.freeze({ music: 0, singer: 1 }),
  music: Object.freeze({ music: 1, singer: 0 }),
  both: Object.freeze({ music: 1, singer: 1 }),
});
export const MIX_PRESET_WORDS = Object.freeze({ singer: 'Singer only', music: 'Music only', both: 'Both' });

export function presetOf(mix) {
  if (!mix) return null;
  for (const [name, p] of Object.entries(MIX_PRESETS)) if (mix.music === p.music && mix.singer === p.singer) return name;
  return null;
}

export function songMix(saved, defaults = SONG.levels) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const d = defaults || {};
  return {
    music: level(s.music, level(d.music, SONG.levels.music)),
    singer: level(s.singer, level(d.singer ?? d.guide, SONG.levels.guide)),
    volume: level(s.volume, level(d.volume, SONG.levels.volume)),
  };
}

export function keepSongMix(mixes, songId, mix, keep = SONG.levels.keptSongs) {
  if (!mixes || songId === null || songId === undefined) return mixes;
  // Deleted first, so the song written last is the last key: the oldest are the first.
  delete mixes[songId];
  mixes[songId] = songMix(mix);
  const ids = Object.keys(mixes);
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) delete mixes[id];
  return mixes;
}

export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const n = Math.max(0, Math.round(samples.length * toRate / fromRate)), out = new Float32Array(n);
  const k = fromRate / toRate, last = samples.length - 1;
  for (let i = 0; i < n; i++) {
    const x = i * k, a = Math.min(last, Math.floor(x)), f = x - a;
    out[i] = samples[a] + f * (samples[Math.min(last, a + 1)] - samples[a]);
  }
  return out;
}

export function mixDown({ backing, take, at, balance = SONG.mix.balance }) {
  const g = balanceGains(balance), rate = backing.sampleRate;
  const voice = resample(take.samples, take.sampleRate, rate);
  const n = backing.channels[0].length, first = Math.round(at * rate);
  const from = Math.max(0, -first), to = Math.min(voice.length, n - first);
  const channels = backing.channels.map((src) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = g.backing * src[i];
    for (let i = from; i < to; i++) out[first + i] += g.voice * voice[i];
    return out;
  });
  const peak = Math.max(...channels.map(peakOf));
  let scaledBy = 1;
  if (peak > 1) {
    scaledBy = 0.99 / peak;
    for (const c of channels) for (let i = 0; i < n; i++) c[i] *= scaledBy;
  }
  return { channels, sampleRate: rate, peak: peak * scaledBy, scaledBy };
}

const safeName = (s) => String(s || 'song').replace(/[^\p{L}\p{N} _.-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'song';

export function exportMix({ backing, take, at, balance = SONG.mix.balance, ownFile = false, title = '' } = {}) {
  const no = (reason) => ({ ok: false, reason, words: EXPORT_WORDS[reason] });
  // The gate comes first and looks at nothing else: no flag, no file.
  if (ownFile !== true) return no('not-own-file');
  if (!backing || !backing.channels || !backing.channels.length) return no('no-backing');
  if (!take || !take.samples || !take.samples.length) return no('no-take');
  if (!Number.isFinite(at)) return no('not-lined-up');
  const mixed = mixDown({ backing, take, at, balance });
  // WAV holds one or two channels; a file with more keeps its first two.
  const wav = encodeWav(mixed.channels.slice(0, 2), Math.round(mixed.sampleRate));
  return {
    ok: true, wav,
    name: `${safeName(title)} - my take.wav`,
    seconds: mixed.channels[0].length / mixed.sampleRate,
    peak: mixed.peak, scaledBy: mixed.scaledBy,
  };
}

// ---------------------------------------------------------------- browser

export function createMixPlayback({ player, take, calibrationMs = null, nudgeMs = take.nudgeMs, balance = SONG.mix.balance }) {
  let nudge = clampNudge(nudgeMs), cal = calibrationMs, bal = balance, where = null;
  function place() {
    where = takeOffset(take, { calibrationMs: cal, nudgeMs: nudge });
    if (where.at === null) throw new Error(EXPORT_WORDS['not-lined-up']);
    player.setLayer('voice', { samples: take.samples, sampleRate: take.sampleRate, at: where.at, gain: balanceGains(bal).voice });
  }
  function volumes() {
    const g = balanceGains(bal);
    player.setBackingGain(g.backing);
    player.setLayerGain('voice', g.voice);
  }
  place();
  volumes();
  return {
    setBalance(b) { bal = Math.min(1, Math.max(0, +b || 0)); volumes(); },
    setNudge(ms) { nudge = clampNudge(ms); place(); return nudge; },
    setCalibration(ms) { cal = Number.isFinite(ms) ? ms : null; place(); },
    state: () => ({ balance: bal, nudgeMs: nudge, calibrationMs: cal, at: where.at, delaySec: where.delaySec, source: where.source }),
    destroy() { player.removeLayer('voice'); player.setBackingGain(1); },
  };
}

export function downloadWav(wav, name) {
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Not at once: the download reads the URL after this turn.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
