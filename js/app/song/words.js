// words.js — a song's words and when each line is sung
// (docs/design/specs/2026-10-12-song-mode.md section 9). Pure: imports in Node.
//
// WHERE WORDS COME FROM, in the order the owner is offered them:
//   1. typed or pasted by the owner (parseWords), then timed by tapping along (stampLine);
//   2. pasted timed text in the common "[mm:ss.xx] line" form (parseLrc);
//   3. looked up at LRCLIB by the owner's press in the Words sheet (createLookup);
//   4. found without a press when a song is dropped (autowords.js: first the words stored
//      inside the file, then one search at LRCLIB). Owner decision 2026-10-13: this is ON
//      unless the owner turns off "Look up words automatically" in Settings; with it off,
//      nothing is asked until the press in 3. The page says so before the first lookup.
// This file never stores words. The caller keeps them with the song record in this browser
// (songstore.js setWords) and nowhere else. The repo, its fixtures and its test records hold
// invented placeholder lines only.
//
// WHAT THE LOOKUP SENDS (pressed or automatic): one GET to lrclib.net/api/search with the
// title and the artist, and the `Lrclib-Client` header that names this app. Not the length,
// not the file name, no cookie, no referrer. One request at a time; 8 s time-out. The
// pressed lookup here retries nothing by itself; the automatic one asks once more after a
// "come back later" answer (autowords.js createSearch).
//
// THE SHAPE (the spec's):
//   words = { route: 'lookup' | 'file' | 'typed' | 'chart' | 'heard' | 'none', timing: 'word' | 'line' | 'none',
//             lines: [{ t, end, text }], offsetSec, autoOffsetSec?, credit?, at }
//   route says where the words came from: 'lookup' LRCLIB (pressed or automatic), 'file'
//   stored inside the dropped file (tags.js), 'typed' pasted or typed, 'chart' a note chart.
//   WORD_ROUTES lists them; a route outside it is stored as 'typed' (songstore.js).
//   t is seconds from the start of the audio AS SUPPLIED (null = not timed yet); a line is
//   shown at t + offsetSec. `end` is filled by lineSpans(); null until then.
//
// CONTRACT
//   parseWords(text) -> [{ t: null, end: null, text }]
//       One entry per non-empty row; spaces tidied; time stamps and headings alone in square
//       brackets ("[Chorus]") are dropped.
//   parseLrc(text) -> { lines: [{ t, end: null, text }], meta: { title, artist, length, offsetMs }, timed }
//       Stamps "[mm:ss]", "[mm:ss.x]", "[mm:ss.xx]", "[mm:ss.xxx]", "[mm:ss:xx]"; several
//       stamps on one row give several lines; "<mm:ss.xx>" word stamps are removed;
//       "[offset:+250]" moves every line 0.25 s EARLIER (the format's own rule). Sorted by t.
//       A stamped row with no text is kept (text ''): it marks where singing stops.
//       timed: false when no row carried a stamp (lines then come from parseWords).
//   makeWords(lines, { route, offsetSec = 0, autoOffsetSec?, credit?, at? }) -> words
//       timing is 'line' when every line with text has a time, else 'none'.
//   createLookup({ fetch?, base?, client?, timeoutMs? }) -> lookup({ title, artist, duration? }) -> Promise
//         { ok: true, results: [{ title, artist, duration, timed, lines, instrumental,
//                                 lengthDiffSec, sameLength }] }      at most 5, best first
//       | { ok: false, reason, words }
//       reason: 'need-title' | 'busy' (another lookup is running) | 'not-found' |
//               'no-answer' (network error, time-out, server error, told to slow down) |
//               'bad-answer' (not what the service documents)
//       Never throws. `duration` (the file's length) is NOT sent: it only orders the answers
//       (timed first, then nearest in length) and fills lengthDiffSec = theirs - the file's
//       (null when either is unknown); sameLength = within 2 s.
//   lookupUrl({ title, artist }, base?) -> string     the exact address asked
//   fitOffset(lines, phrases, { duration?, wordsDuration?, config? }) ->
//         { ok, reason, offsetSec, share, matched, lines: n, medianErr, drift, chance,
//           why, confidence: 'ok' | 'low', countRatio, phrases }
//       phrases = [{ t, end }] from the analysis (phrases.js). offsetSec = the one shift
//       (within +-fitMaxShiftSec) that puts the most line starts within fitTolSec of a phrase
//       start; share = matched / lines at that shift. ok false, with the best shift still
//       given so "Use them anyway" works:
//         'too-few'  under fitMinLines timed lines or phrases
//         'differs'  (confidence 'low': show "These words look like a different version")
//                    why 'count': under fitMinCountRatio timed lines per sung phrase;
//                    why 'share' | 'length' | 'drift': share under fitMinShare, or the two lengths differ by over
//                    fitMaxLengthDiffSec, or the lines slip against the singing over the
//                    song by more than fitMaxDrift (another speed)
//       chance = the share a typical wrong shift reaches (how much `share` is worth).
//       Lines with no text are ignored.
//   stampLine(words, index, tapSec, phrases, { reactionSec?, snapSec? }) -> words
//       One tap: the line starts at tapSec - reactionSec, moved onto the nearest phrase start
//       when one is within snapSec. Stored so that t + offsetSec is that moment.
//   tapsToLines(words, taps, phrases, opts?) -> { words, timed, left }
//       The n-th tap is the n-th line with text. Taps are sorted; one closer than
//       tapMinGapSec to the tap before it is dropped. Lines beyond the last tap stay untimed.
//   nudgeLine(words, index, deltaSec) -> words     one line moves; it cannot pass a neighbour
//   nudgeAll(words, deltaSec) -> words             offsetSec moves; clamped to +-60 s
//   lineSpans(words, phrases, { duration? }) -> [{ i, t, end, text, inRest }]
//       Timed lines with text, in time order, on the SHOWN clock (t + offsetSec). i = the
//       line's index in words.lines. end = the next line's start or the end of its phrase,
//       whichever is first. inRest: the start falls where the analysis found no singing.
//   markerAt(spans, t) -> { index, progress, resting } | null
//       index into spans. progress 0..1 runs at an even pace from the line's start to its
//       end. Between a line's end and the next line: that line, progress 1, resting true.
//       null before the first line.
//   splitLongLines(spans, { maxLetters? }) -> spans
//       For the screen only (stored words are not touched): a span whose text is longer than
//       maxLetters (config splitOverLetters) becomes two, and each half again while it is
//       still too long. The break follows the comma, full stop or dash nearest the middle when
//       one lies in the middle 40 %, else the space nearest the middle; a text with no
//       space is left whole. The time is shared by letters: the second half starts at
//       t + (end - t) * (letters of the first half / letters of both). Both halves keep
//       `i` and `inRest`; `part` is 1, 2, ... in order. Shorter spans come back as they are.
//   LOOKUP_WORDS: the plain words for each refusal.
//   WORD_ROUTES: the routes listed above, for whatever stores or reads `route`.

import { SONG } from './config.js';

const W = SONG.words;

// Every place a song's words can come from (the `route` above).
export const WORD_ROUTES = Object.freeze(['lookup', 'file', 'typed', 'chart', 'heard', 'none']);

export const LOOKUP_WORDS = Object.freeze({
  'need-title': 'Type the song’s name first.',
  busy: 'Still looking up the last one.',
  'not-found': 'No words found. Check the spelling, or paste the words.',
  'no-answer': 'The lyrics site did not answer. Try again in a minute, or paste the words.',
  'bad-answer': 'The lyrics site answered with something this app cannot read. Paste the words instead.',
});

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_STAMP = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const stampSeconds = (m, s, f) => Number(m) * 60 + Number(s) + (f ? Number(f) / 10 ** f.length : 0);
const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- reading text

export function parseWords(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = tidy(raw.replace(STAMP, '').replace(WORD_STAMP, ''));
    if (!line || /^\[[^\]]*\]$/.test(line)) continue;
    out.push({ t: null, end: null, text: line });
  }
  return out;
}

export function parseLrc(text) {
  const meta = { title: null, artist: null, length: null, offsetMs: 0 };
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const tag = /^\s*\[([a-z#]+):(.*)\]\s*$/i.exec(raw);
    if (tag) {
      const key = tag[1].toLowerCase(), value = tag[2].trim();
      if (key === 'ti') meta.title = value;
      else if (key === 'ar') meta.artist = value;
      else if (key === 'length') meta.length = value;
      else if (key === 'offset' && Number.isFinite(Number(value))) meta.offsetMs = Number(value);
      continue;
    }
    const stamps = [...raw.matchAll(STAMP)].map((m) => stampSeconds(m[1], m[2], m[3]));
    if (!stamps.length) continue;
    const words = tidy(raw.replace(STAMP, '').replace(WORD_STAMP, ''));
    for (const t of stamps) lines.push({ t, end: null, text: words });
  }
  if (!lines.length) return { lines: parseWords(text), meta, timed: false };
  const shift = meta.offsetMs / 1000;
  for (const l of lines) l.t = Math.max(0, l.t - shift);
  lines.sort((a, b) => a.t - b.t);
  return { lines, meta, timed: true };
}

export function makeWords(lines, { route = 'typed', offsetSec = 0, autoOffsetSec, credit, at = new Date().toISOString() } = {}) {
  const list = (lines || []).filter((l) => l && typeof l.text === 'string').map((l) => ({ t: Number.isFinite(l.t) ? l.t : null, end: Number.isFinite(l.end) ? l.end : null, text: l.text }));
  const sung = list.filter((l) => tidy(l.text));
  const words = { route, timing: sung.length && sung.every((l) => l.t !== null) ? 'line' : 'none', lines: list, offsetSec: Number.isFinite(offsetSec) ? offsetSec : 0, at };
  if (Number.isFinite(autoOffsetSec)) words.autoOffsetSec = autoOffsetSec;
  if (credit) words.credit = credit;
  return words;
}

// ---------------------------------------------------------------- lookup

export function lookupUrl({ title, artist } = {}, base = W.lookupBase) {
  const q = new URLSearchParams();
  q.set('track_name', tidy(title));
  if (tidy(artist)) q.set('artist_name', tidy(artist));
  return `${base}/api/search?${q}`;
}

function readRecord(rec, fileDuration) {
  if (!rec || typeof rec !== 'object') return null;
  const synced = typeof rec.syncedLyrics === 'string' ? rec.syncedLyrics : '';
  const plain = typeof rec.plainLyrics === 'string' ? rec.plainLyrics : '';
  const parsed = synced ? parseLrc(synced) : { lines: parseWords(plain), timed: false };
  const instrumental = rec.instrumental === true;
  if (!parsed.lines.length && !instrumental) return null;
  const duration = Number.isFinite(rec.duration) ? rec.duration : null;
  const diff = duration !== null && Number.isFinite(fileDuration) ? Math.round(duration - fileDuration) || 0 : null;   // never -0
  return {
    title: typeof rec.trackName === 'string' ? rec.trackName : null,
    artist: typeof rec.artistName === 'string' ? rec.artistName : null,
    duration, timed: parsed.timed, lines: parsed.lines, instrumental,
    lengthDiffSec: diff, sameLength: diff !== null && Math.abs(diff) <= 2,
  };
}

export function createLookup({ fetch: fetchImpl = globalThis.fetch, base = W.lookupBase, client = W.client, timeoutMs = W.lookupTimeoutMs } = {}) {
  let busy = false;
  const no = (reason) => ({ ok: false, reason, words: LOOKUP_WORDS[reason] });
  return async function lookup({ title, artist, duration } = {}) {
    if (!tidy(title)) return no('need-title');
    if (busy) return no('busy');
    busy = true;
    const stopper = new AbortController();
    const timer = setTimeout(() => stopper.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(lookupUrl({ title, artist }, base), {
          method: 'GET',
          headers: { 'Lrclib-Client': client },
          // Nothing of the owner's goes with the question, and the browser does not keep the
          // answer either: the song record on this machine is the only place words are stored.
          credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: stopper.signal,
        });
      } catch { return no('no-answer'); }
      if (res.status === 404) return no('not-found');
      if (!res.ok) return no(res.status >= 500 || res.status === 429 || res.status === 408 ? 'no-answer' : 'bad-answer');
      let body;
      try { body = await res.json(); } catch { return no('bad-answer'); }
      if (!Array.isArray(body)) body = body && typeof body === 'object' ? [body] : null;
      if (!body) return no('bad-answer');
      const results = body.map((r) => readRecord(r, duration)).filter(Boolean);
      if (!results.length) return no('not-found');
      const far = (r) => (r.lengthDiffSec === null ? 1e6 : Math.abs(r.lengthDiffSec));
      results.sort((a, b) => (b.timed ? 1 : 0) - (a.timed ? 1 : 0) || far(a) - far(b));
      return { ok: true, results: results.slice(0, W.lookupMaxResults) };
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
}

// ---------------------------------------------------------------- fitting looked-up times

// The signed way from x to the nearest value of the sorted list.
function nearest(sorted, x) {
  if (!sorted.length) return Infinity;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
  const a = sorted[lo] - x, b = lo > 0 ? sorted[lo - 1] - x : Infinity;
  return Math.abs(a) < Math.abs(b) ? a : b;
}
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const phraseStarts = (phrases) => (phrases || []).filter((p) => p && Number.isFinite(p.t)).map((p) => p.t).sort((a, b) => a - b);

export function fitOffset(lines, phrases, { duration = null, wordsDuration = null, config = W } = {}) {
  const starts = (lines || []).filter((l) => l && Number.isFinite(l.t) && tidy(l.text)).map((l) => l.t).sort((a, b) => a - b);
  const sung = phraseStarts(phrases);
  const n = starts.length;
  if (n < config.fitMinLines || sung.length < config.fitMinLines) {
    return { ok: false, reason: 'too-few', offsetSec: 0, share: 0, matched: 0, lines: n, medianErr: null, drift: 0, chance: 0 };
  }
  const tol = config.fitTolSec;
  let best = -1, bestOffset = 0;
  const all = [];
  const steps = Math.round(config.fitMaxShiftSec / config.fitStepSec);
  for (let k = -steps; k <= steps; k++) {
    const offset = k * config.fitStepSec;
    let hits = 0;
    for (const t of starts) if (Math.abs(nearest(sung, t + offset)) <= tol) hits++;
    all.push(hits);
    // Of equal scores the smaller move: words that already fit are left where they are.
    if (hits > best || (hits === best && Math.abs(offset) < Math.abs(bestOffset) - 1e-9)) { best = hits; bestOffset = offset; }
  }
  // The best score holds over a stretch of shifts: settle on what the matched lines say.
  const pairs = () => starts.map((t) => ({ t, miss: nearest(sung, t + bestOffset) })).filter((p) => Math.abs(p.miss) <= tol);
  bestOffset += median(pairs().map((p) => p.miss));
  const matched = pairs();

  // Slip over the song: the straight line through (time, miss) of the matched lines.
  let drift = 0;
  if (matched.length >= 3) {
    const mt = matched.reduce((s, p) => s + p.t, 0) / matched.length, mm = matched.reduce((s, p) => s + p.miss, 0) / matched.length;
    let top = 0, under = 0;
    for (const p of matched) { top += (p.t - mt) * (p.miss - mm); under += (p.t - mt) ** 2; }
    drift = under > 0 ? top / under : 0;
  }
  const share = matched.length / n;
  const lengthsDiffer = Number.isFinite(duration) && Number.isFinite(wordsDuration) && Math.abs(duration - wordsDuration) > config.fitMaxLengthDiffSec;
  // Far fewer lines than sung phrases: a few lines always find a phrase to sit on, so the
  // share alone says nothing then (4 lines against 14 phrases matched 4 of 4).
  const countRatio = n / sung.length, tooFewLines = countRatio < (config.fitMinCountRatio ?? 0);
  const why = tooFewLines ? 'count' : share < config.fitMinShare ? 'share' : lengthsDiffer ? 'length' : Math.abs(drift) > config.fitMaxDrift ? 'drift' : null;
  const ok = why === null;
  return {
    ok, reason: ok ? null : 'differs', why, confidence: ok ? 'ok' : 'low', countRatio: round3(countRatio), phrases: sung.length,
    offsetSec: round3(bestOffset), share: round3(share), matched: matched.length, lines: n,
    medianErr: round3(median(matched.map((p) => Math.abs(p.miss)))),
    drift: Math.round(drift * 10000) / 10000, chance: round3(median(all) / n),
  };
}

// ---------------------------------------------------------------- timing by hand

const copy = (words, lines, extra = {}) => makeWords(lines, { ...words, ...extra });

export function stampLine(words, index, tapSec, phrases, { reactionSec = W.tapReactionSec, snapSec = W.tapSnapSec } = {}) {
  const lines = words.lines.map((l) => ({ ...l }));
  if (!lines[index] || !Number.isFinite(tapSec)) return copy(words, lines);
  let at = Math.max(0, tapSec - reactionSec);
  const miss = nearest(phraseStarts(phrases), at);
  if (Math.abs(miss) <= snapSec) at += miss;
  lines[index].t = round3(at - (words.offsetSec || 0));
  lines[index].end = null;
  return copy(words, lines);
}

export function tapsToLines(words, taps, phrases, opts = {}) {
  const sorted = (taps || []).filter(Number.isFinite).sort((a, b) => a - b);
  const kept = [];
  for (const t of sorted) if (!kept.length || t - kept[kept.length - 1] >= W.tapMinGapSec) kept.push(t);
  let out = copy(words, words.lines.map((l) => ({ ...l, t: null, end: null })));
  const sung = out.lines.map((l, i) => (tidy(l.text) ? i : -1)).filter((i) => i >= 0);
  const timed = Math.min(kept.length, sung.length);
  for (let k = 0; k < timed; k++) out = stampLine(out, sung[k], kept[k], phrases, opts);
  return { words: out, timed, left: sung.length - timed };
}

export function nudgeLine(words, index, deltaSec) {
  const lines = words.lines.map((l) => ({ ...l }));
  const line = lines[index];
  if (!line || !Number.isFinite(line.t) || !Number.isFinite(deltaSec)) return copy(words, lines);
  let low = -(words.offsetSec || 0), high = Infinity;
  for (let i = index - 1; i >= 0; i--) if (Number.isFinite(lines[i].t)) { low = lines[i].t + W.lineGapSec; break; }
  for (let i = index + 1; i < lines.length; i++) if (Number.isFinite(lines[i].t)) { high = lines[i].t - W.lineGapSec; break; }
  line.t = round3(Math.max(low, Math.min(high, line.t + deltaSec)));
  line.end = null;
  return copy(words, lines);
}

export function nudgeAll(words, deltaSec) {
  const next = Math.max(-60, Math.min(60, (words.offsetSec || 0) + (Number.isFinite(deltaSec) ? deltaSec : 0)));
  return copy(words, words.lines, { offsetSec: round3(next) });
}

// ---------------------------------------------------------------- the marker

export function lineSpans(words, phrases, { duration = null } = {}) {
  if (!words || !Array.isArray(words.lines)) return [];
  const shift = words.offsetSec || 0;
  const timed = words.lines.map((l, i) => ({ i, t: Number.isFinite(l.t) ? Math.max(0, l.t + shift) : null, text: tidy(l.text) }))
    .filter((l) => l.t !== null).sort((a, b) => a.t - b.t);
  const sung = (phrases || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.end));
  const spans = [];
  timed.forEach((line, k) => {
    if (!line.text) return;         // an empty stamped line only ends the one before
    const next = k + 1 < timed.length ? timed[k + 1].t : Math.min(duration ?? Infinity, line.t + W.maxLineSec);
    // Where this line's singing stops: the end of the last phrase that begins before the
    // next line does and is still going after this line began.
    let sungEnd = null;
    for (const p of sung) if (p.t < next - 1e-6 && p.end > line.t + 1e-6) sungEnd = Math.max(sungEnd ?? -Infinity, p.end);
    const end = sungEnd === null ? next : Math.min(next, sungEnd);
    const inRest = sung.length > 0 && !sung.some((p) => line.t >= p.t - W.tapSnapSec && line.t <= p.end);
    spans.push({ i: line.i, t: line.t, end: Math.max(end, line.t + 0.05), text: line.text, inRest });
  });
  return spans;
}

export function markerAt(spans, t) {
  if (!spans || !spans.length || !Number.isFinite(t) || t < spans[0].t) return null;
  let lo = 0, hi = spans.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid].t <= t) lo = mid; else hi = mid - 1; }
  const s = spans[lo];
  return { index: lo, progress: Math.min(1, Math.max(0, (t - s.t) / (s.end - s.t))), resting: t >= s.end };
}

// ---------------------------------------------------------------- long lines

// Where to break `text` in two: the index of the space to break at, or -1.
function breakAt(text) {
  const mid = text.length / 2;
  let space = -1, mark = -1;
  for (let k = 1; k < text.length - 1; k++) {
    if (text[k] !== ' ') continue;
    if (space < 0 || Math.abs(k - mid) < Math.abs(space - mid)) space = k;
    // After punctuation or a dash: where a singer breathes.
    const pause = /[,;:.!?…–—-]/.test(text[k - 1]);
    if (pause && Math.abs(k - mid) <= 0.2 * text.length && (mark < 0 || Math.abs(k - mid) < Math.abs(mark - mid))) mark = k;
  }
  return mark >= 0 ? mark : space;
}

export function splitLongLines(spans, { maxLetters = W.splitOverLetters } = {}) {
  if (!Array.isArray(spans) || !(maxLetters > 0)) return spans || [];
  const out = [];
  const add = (s) => {
    const k = s.text.length > maxLetters ? breakAt(s.text) : -1;
    if (k < 0) { out.push(s); return; }
    const a = s.text.slice(0, k).trim(), b = s.text.slice(k + 1).trim();
    const at = s.t + (s.end - s.t) * (a.length / (a.length + b.length));
    add({ ...s, text: a, end: at });
    add({ ...s, text: b, t: at });
  };
  for (const s of spans) {
    const from = out.length;
    add(s);
    if (out.length - from > 1) for (let k = from; k < out.length; k++) out[k] = { ...out[k], part: k - from + 1 };
  }
  return out;
}
