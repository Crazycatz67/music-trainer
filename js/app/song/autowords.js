// autowords.js — the words of a dropped song, found without the owner doing anything
// (owner decision 2026-10-13). Pure: imports in Node; the network and the clock are passed in.
//
// THE ORDER
//   1. words stored inside the file (tags.js);
//   2. one search at LRCLIB by title and artist;
//   3. every timed answer is laid against the singing found in the file (words.js fitOffset)
//      and the best fitting one is used;
//   4. when no single shift fits, or the words have no times: the lines are dealt out to
//      the sung phrases in order (fitByLine), and used only when that is settled enough;
//   5. otherwise there are no words. That is a final answer: the page shows the cues-only
//      screen and lets the owner correct the title.
//
// WHAT THE SEARCH SENDS: one GET to lrclib.net/api/search with `track_name` and (when known)
// `artist_name`, and the `Lrclib-Client` header that names this app. NOT the length, the file
// name, the album, a cookie or a referrer. The length is used on this machine only, to choose
// between answers. A song is asked about once: the answer, and "nothing found" too, is kept
// under the title and artist asked, so only an edited title asks again.
//
// CONTRACT
//   cleanTitle(text) -> string
//       Without "(Remastered 2009)", "[Official Video]", "feat. X" tails and the like.
//   cleanName(fileName) -> [{ title, artist }]      likeliest first; [] when nothing is left
//       "03 - Artist - Title (Live) [Official Video].mp3" -> Artist / Title first, then the
//       other readings of the same name. artist is '' when the name gives none.
//   identify({ tags?, fileName? }) -> { title, artist, from: 'tags' | 'name' }
//       The tags' title when there is one (artist from the tags, else from the name when the
//       name agrees on the title); otherwise the name's first reading. title '' = unknown.
//   songKey({ title, artist }) -> string            what "the same song" means to the cache
//   createSearch({ fetch?, sleep?, now?, base?, client?, config? }) -> search({ title, artist }) -> Promise
//         { ok: true, results: [{ title, artist, duration, timed, lines, instrumental }], retried }
//       | { ok: false, reason: 'need-title' | 'not-found' | 'no-answer' | 'bad-answer', retried }
//       Never throws. After a 503 (or 429) it waits as long as the answer's `retry-after`
//       says (seconds or a date; retryDefaultMs when it says nothing) and asks ONCE more;
//       a wait over retryMaxMs is not waited for. sleep(ms) -> Promise is the timer.
//   createWordsCache({ storage?, key?, max? }) -> { get(k), set(k, v) }
//       Answers live in memory for this page; only "nothing found" (the key, no words) is
//       written to `storage` (localStorage or the like), so it survives a reload.
//   rankWords({ results, phrases, durationSec }) -> [{ index, result, fit, score, lengthDiffSec }]
//       Every timed result with its fitOffset, best first: fitting ones first, then by how
//       far the matched share stands above chance, then nearest in length, then tightest.
//   pickWords({ results, phrases, durationSec }) -> { result, index, fit, why, ranked } | null
//       The best ranked result when it fits; null when none does. why = one plain sentence.
//   fitByLine({ lines, phrases, config? }) ->
//         { ok, reason, confidence, lines: [{ t, end: null, text }], placed, guessed: [index],
//           skippedPhrases, timed, meanCost, stableShare }
//       Lines in order onto phrases in order. One phrase may hold a few lines, one line may
//       run over a few phrases; a phrase may go without a line (a chorus sung once more) and,
//       at a higher price, a line without a phrase. Lines with times of their own are matched
//       by the gaps between them; lines without, by their length in syllables against the
//       phrase's length. `guessed` lines found no phrase and were put in the rest before.
//       ok false, and the lines still given: 'too-few' | 'count' (too many or too few lines
//       for the phrases) | 'loose' (confidence under the bar: several ways fit equally well,
//       or none fits well).
//   autoWords({ file?, tags?, fileName?, title?, artist?, phrases, durationSec,
//               lookup?, fetch?, sleep?, cache?, config? }) -> Promise
//         { status: 'found' | 'fitted' | 'none', words, source: 'file' | 'lrclib' | null,
//           why, say, asked: { title, artist, from }, searched, fromCache, fit, leftover }
//       words: the shape in words.js (makeWords), ready for songstore setWords; null for 'none'.
//       why:  'file-timed' | 'file-as-is' | 'file-by-line' | 'lrclib-fit' | 'lrclib-by-line' |
//             'no-title' | 'no-singing' | 'not-found' | 'no-answer' | 'bad-answer' |
//             'instrumental' | 'no-fit' | 'failed' (a fault in here; never seen in the checks)
//       say:  the plain sentence for `why` (AUTOWORDS_SAY).
//       title / artist given = the owner's own correction: used as they are (from 'edited').
//       searched: a request went out in this call. fromCache: the answer was already known.
//       leftover: for 'none' with why 'no-fit': words that were found but could not be
//                 timed ({ words (untimed), source }), should the page want to show them.
//       lookup: a ready search function (createSearch's shape; words.js createLookup's fits
//       too, without the retry). Otherwise one is built from fetch and sleep.
//       Never throws.

import { SONG } from './config.js';
import { AUTOWORDS } from './autowords.config.js';
import { fitOffset, lookupUrl, makeWords, parseLrc, parseWords } from './words.js';
import { readTags } from './tags.js';

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fold = (s) => tidy(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const round3 = (v) => Math.round(v * 1000) / 1000;

export const AUTOWORDS_SAY = Object.freeze({
  'file-timed': 'Words read from the file.',
  'file-as-is': 'Words read from the file, with the times stored in it.',
  'file-by-line': 'Words read from the file and matched line by line to the singing.',
  'lrclib-fit': 'Words found through LRCLIB.',
  'lrclib-by-line': 'Words found through LRCLIB and matched line by line to the singing.',
  'no-title': 'No words found: this file does not say what song it is. Type the title.',
  'no-singing': 'No words looked up: no singing was found in this file.',
  'not-found': 'No words found: check the title.',
  'no-answer': 'The lyrics site did not answer. The words will be looked for next time.',
  'bad-answer': 'The lyrics site answered with something this app cannot read.',
  instrumental: 'This song is listed as having no words.',
  failed: 'The words could not be looked up this time.',
  'no-fit': 'No words found that match this recording: check the title.',
});

const CREDIT = Object.freeze({ lrclib: 'Words found through LRCLIB', file: 'Words stored in the file' });

// ---------------------------------------------------------------- what song is this

// What shops, uploaders and rippers add to a title; none of it is in the song's name.
const JUNK = /\b(remaster(ed)?|official|video|audio|lyrics?|lyric video|hd|hq|4k|live|version|edit|mix|remix|explicit|clean|mono|stereo|bonus|visuali[sz]er|karaoke|instrumental|acoustic|demo|deluxe|single|album|soundtrack|ost|(19|20)\d\d)\b/i;
const FEAT = /^(feat\.?|ft\.?|featuring|with)\s/i;
// The 11 letters a video downloader leaves in brackets.
const isVideoId = (s) => /^[A-Za-z0-9_-]{11}$/.test(s) && /\d|[a-z].*[A-Z]|[A-Z].*[a-z]/.test(s);
const DASH = /\s+[-–—]\s+/;
const FILLER = /^(the|a|original|radio|studio|digital|music|full|new|stereo|mono|\d{4})$/i;
const onlyLabels = (part) => { const words = tidy(part).split(' ').filter(Boolean); return words.length > 0 && words.some((w) => JUNK.test(w)) && words.every((w) => JUNK.test(w) || FILLER.test(w)); };

function dropBrackets(s) {
  let out = s, before;
  do {
    before = out;
    out = out.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (whole, inner) => (JUNK.test(inner) || FEAT.test(inner.trim()) || isVideoId(inner.trim()) || !inner.trim() ? ' ' : whole));
  } while (out !== before);
  return out;
}

// Longer than this is not a title: cut first, because the tidying below goes over the text
// once per bracket pair and per " - label" part (a 140 000 letter title took 4 s; bugs.md 73).
const MAX_TITLE_CHARS = 300;                                             // GUESS

export function cleanTitle(text) {
  let s = dropBrackets(String(text ?? '').slice(0, MAX_TITLE_CHARS).normalize('NFC'));
  s = s.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '');
  // "Title - Remastered 2009": a last part that is only a label.
  // Only when EVERY word of it is a label: "Live Forever" and "Video Games" are titles.
  for (let parts = s.split(DASH); parts.length > 1 && onlyLabels(parts[parts.length - 1]); parts = s.split(DASH)) s = parts.slice(0, -1).join(' - ');
  return tidy(s).replace(/^[-–—.\s]+|[-–—\s]+$/g, '');
}

export function cleanName(fileName) {
  let s = String(fileName ?? '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '');
  // Brackets first: a video id may hold underscores that must not become spaces.
  s = tidy(dropBrackets(s).replace(/_/g, ' '));
  // Track numbers: "03 - ", "03. ", "1-03 ", and a zero-led "03 ". A bare "99 " stays: it
  // may be the title ("99 Red Kites").
  s = s.replace(/^\d{1,2}[-.]\d{1,2}\s+(?=\S)/, '').replace(/^\d{1,3}\s*[-.)]+\s+(?=\S)/, '').replace(/^0\d{1,2}\s+(?=\S)/, '').replace(/^[-–—.\s]+/, '');
  s = cleanTitle(s);
  const parts = s.split(DASH).map((p) => cleanTitle(p)).filter(Boolean);
  if (!parts.length) return [];
  const list = parts.length === 1 ? [{ title: parts[0], artist: '' }]
    : parts.length === 2 ? [{ artist: parts[0], title: parts[1] }, { artist: parts[1], title: parts[0] }, { artist: '', title: parts[1] }]
    // "Artist - Album - Title" is the common three; "Artist - Title - Something" the other.
    : [{ artist: parts[0], title: parts[parts.length - 1] }, { artist: parts[0], title: parts[1] }, { artist: '', title: parts[parts.length - 1] }];
  const seen = new Set();
  return list.filter((c) => { const k = songKey(c); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function identify({ tags = null, fileName = '' } = {}) {
  const names = cleanName(fileName);
  const tagTitle = cleanTitle(tags && tags.title), tagArtist = tidy(String((tags && tags.artist) ?? '').slice(0, MAX_TITLE_CHARS)).replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '');
  if (tagTitle) {
    // A tag with a title and no artist: the name may still say who, when it means the same song.
    const same = names.find((c) => c.artist && fold(c.title) === fold(tagTitle));
    return { title: tagTitle, artist: tagArtist || (same ? same.artist : ''), from: 'tags' };
  }
  if (names.length) return { title: names[0].title, artist: names[0].artist || tagArtist, from: 'name' };
  return { title: '', artist: tagArtist, from: 'name' };
}

export const songKey = ({ title, artist } = {}) => `${fold(title)}|${fold(artist)}`;

// ---------------------------------------------------------------- the search

function readRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const synced = typeof rec.syncedLyrics === 'string' ? rec.syncedLyrics : '';
  const plain = typeof rec.plainLyrics === 'string' ? rec.plainLyrics : '';
  const parsed = synced ? parseLrc(synced) : { lines: parseWords(plain), timed: false };
  const instrumental = rec.instrumental === true;
  if (!parsed.lines.length && !instrumental) return null;
  return {
    title: typeof rec.trackName === 'string' ? rec.trackName : null, artist: typeof rec.artistName === 'string' ? rec.artistName : null,
    duration: Number.isFinite(rec.duration) ? rec.duration : null, timed: parsed.timed, lines: parsed.lines, instrumental,
  };
}

// "retry-after": seconds, or a date. null when it says nothing readable.
function retryAfterMs(res, now) {
  let raw = null;
  try { raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null; } catch { raw = null; }
  if (raw === null || raw === undefined || tidy(raw) === '') return null;
  if (/^\d+(\.\d+)?$/.test(tidy(raw))) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now());
}

const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function createSearch({ fetch: fetchImpl = globalThis.fetch, sleep = realSleep, now = Date.now, base = SONG.words.lookupBase, client = SONG.words.client, config = AUTOWORDS.search } = {}) {
  async function once(url) {
    const stopper = new AbortController();
    const timer = setTimeout(() => stopper.abort(), config.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'GET', headers: { 'Lrclib-Client': client },
        // As in words.js: nothing of the owner's goes with the question, nothing is kept by the browser.
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: stopper.signal,
      });
      if (config.retryStatuses.includes(res.status)) return { again: true, waitMs: retryAfterMs(res, now) };
      if (res.status === 404) return { ok: false, reason: 'not-found' };
      if (!res.ok) return { ok: false, reason: res.status >= 500 || res.status === 408 ? 'no-answer' : 'bad-answer' };
      let body;
      try { body = await res.json(); } catch { return { ok: false, reason: 'bad-answer' }; }
      if (!Array.isArray(body)) body = body && typeof body === 'object' ? [body] : null;
      if (!body) return { ok: false, reason: 'bad-answer' };
      const results = body.slice(0, config.maxResults).map(readRecord).filter(Boolean);
      return results.length ? { ok: true, results } : { ok: false, reason: 'not-found' };
    } catch { return { ok: false, reason: 'no-answer' }; } finally { clearTimeout(timer); }
  }
  return async function search({ title, artist } = {}) {
    if (!tidy(title)) return { ok: false, reason: 'need-title', retried: false };
    const url = lookupUrl({ title, artist }, base);
    let res = await once(url), retried = false;
    if (res.again) {
      const wait = res.waitMs ?? config.retryDefaultMs;
      if (wait <= config.retryMaxMs) {
        try { await sleep(wait); } catch { /* a broken timer is no reason not to ask */ }
        retried = true;
        res = await once(url);
      }
    }
    if (res.again) res = { ok: false, reason: 'no-answer' };
    return { ...res, retried };
  };
}

export function createWordsCache({ storage = null, key = AUTOWORDS.cache.storageKey, max = AUTOWORDS.cache.maxNone } = {}) {
  const held = new Map();
  let none = [];
  try { const raw = storage && storage.getItem(key); const list = raw ? JSON.parse(raw) : []; if (Array.isArray(list)) none = list.filter((k) => typeof k === 'string').slice(-max); } catch { none = []; }
  const save = () => { try { if (storage) storage.setItem(key, JSON.stringify(none)); } catch { /* a full or closed store: memory still remembers */ } };
  return {
    get(k) { return held.get(k) || (none.includes(k) ? { ok: false, reason: 'not-found' } : undefined); },
    set(k, v) {
      held.set(k, v);
      const was = none.includes(k), is = !!v && v.ok === false && v.reason === 'not-found';
      if (is && !was) { none.push(k); none = none.slice(-max); save(); }
      if (!is && was) { none = none.filter((x) => x !== k); save(); }
    },
  };
}

// When no cache is passed: one for the page, so "asked once" holds by default.
const pageCache = new Map();
// Two calls for the same song at the same time share the one request.
const flying = new WeakMap();

async function askOnce(cache, key, search, asked) {
  const known = cache.get(key);
  if (known) return { answer: known, searched: false, fromCache: true };
  let inFlight = flying.get(cache);
  if (!inFlight) { inFlight = new Map(); flying.set(cache, inFlight); }
  if (inFlight.has(key)) return { answer: await inFlight.get(key), searched: false, fromCache: true };
  const going = (async () => {
    let answer;
    try { answer = await search({ title: asked.title, artist: asked.artist }); } catch { answer = { ok: false, reason: 'no-answer' }; }
    if (!answer || typeof answer !== 'object') answer = { ok: false, reason: 'bad-answer' };
    // "The site did not answer" is not knowledge about the song: it is asked again next time.
    if (answer.ok || answer.reason === 'not-found') cache.set(key, answer.ok ? { ok: true, results: answer.results } : { ok: false, reason: 'not-found' });
    return answer;
  })();
  inFlight.set(key, going);
  try { return { answer: await going, searched: true, fromCache: false }; } finally { inFlight.delete(key); }
}

// ---------------------------------------------------------------- choosing between answers

const sungLines = (lines) => (lines || []).filter((l) => l && typeof l.text === 'string' && tidy(l.text));
const lengthDiff = (r, durationSec) => (r && Number.isFinite(r.duration) && Number.isFinite(durationSec) ? r.duration - durationSec : null);

export function rankWords({ results = [], phrases = [], durationSec = null, config = AUTOWORDS.pick } = {}) {
  const list = [];
  (results || []).forEach((result, index) => {
    if (!result || !result.timed || result.instrumental || !sungLines(result.lines).length) return;
    const fit = fitOffset(result.lines, phrases, { duration: durationSec, wordsDuration: result.duration });
    list.push({ index, result, fit, score: round3((fit.share || 0) - (fit.chance || 0)), lengthDiffSec: lengthDiff(result, durationSec) });
  });
  // Scores closer than tieMargin count as equal, so the nearer length can decide.
  const band = (x) => Math.round(x.score / config.tieMargin);
  const far = (x) => (x.lengthDiffSec === null ? 1e6 : Math.abs(x.lengthDiffSec));
  return list.sort((a, b) => (b.fit.ok ? 1 : 0) - (a.fit.ok ? 1 : 0) || band(b) - band(a) || far(a) - far(b)
    || (a.fit.medianErr ?? 9) - (b.fit.medianErr ?? 9) || a.index - b.index);
}

export function pickWords({ results = [], phrases = [], durationSec = null, config = AUTOWORDS.pick } = {}) {
  const ranked = rankWords({ results, phrases, durationSec, config });
  const best = ranked[0];
  if (!best || !best.fit.ok) return null;
  const s = Math.round(best.fit.offsetSec * 10) / 10;
  const moved = s === 0 ? 'as they came' : `moved ${Math.abs(s)} s ${s > 0 ? 'later' : 'earlier'}`;
  const why = `${best.fit.matched} of ${best.fit.lines} lines meet the singing ${moved}; best of ${ranked.length} timed ${ranked.length === 1 ? 'version' : 'versions'}.`;
  return { result: best.result, index: best.index, fit: best.fit, why, ranked };
}

// ---------------------------------------------------------------- line by line

// About how many syllables: groups of vowels in each word, at least one a word. Writing
// without vowels as letters (Chinese, Japanese, Korean...) counts one a character.
export function syllables(text) {
  let n = 0;
  for (const word of fold(text).split(/[^\p{L}\p{N}']+/u)) {
    if (!word) continue;
    const groups = word.match(/[aeiouyаеиоуыэюя]+/g);
    if (groups) n += groups.length;
    else if (/[぀-ヿ㐀-鿿가-힯]/.test(word)) n += [...word].length;
    else n += 1;
  }
  return Math.max(1, n);
}

export function fitByLine({ lines = [], phrases = [], config = AUTOWORDS.byLine } = {}) {
  const C = config;
  let L = (lines || []).map((l, index) => ({ index, t: l && Number.isFinite(l.t) ? l.t : null, text: tidy(l && l.text) })).filter((l) => l.text);
  const timed = L.length > 0 && L.every((l) => l.t !== null);
  if (timed) L = [...L].sort((a, b) => a.t - b.t);
  const P = (phrases || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.end) && p.end > p.t).map((p) => ({ t: p.t, end: p.end })).sort((a, b) => a.t - b.t);
  const n = L.length, m = P.length;
  const refuse = (reason) => ({ ok: false, reason, confidence: 0, lines: L.map((l) => ({ t: l.t, end: null, text: l.text })), placed: 0, guessed: [], skippedPhrases: m, timed, meanCost: null, stableShare: 0 });
  if (n < C.minLines || m < C.minLines) return refuse('too-few');
  if (n / m < C.minCountRatio || n / m > C.maxCountRatio) return refuse('count');

  const size = L.map((l) => syllables(l.text));
  const dur = P.map((p) => p.end - p.t);
  const sizeSum = [0], durSum = [0];
  for (const s of size) sizeSum.push(sizeSum[sizeSum.length - 1] + s);
  for (const d of dur) durSum.push(durSum[durSum.length - 1] + d);
  // Syllables a second over the whole song: what a line "should" take.
  const rate = sizeSum[n] / durSum[m];
  const sizeWeight = timed ? C.timedSizeWeight : 1;

  // Lines i..i+a-1 sung over phrases j..j+b-1.
  function match(i, a, j, b) {
    const want = (sizeSum[i + a] - sizeSum[i]) / rate, got = durSum[j + b] - durSum[j];
    let cost = sizeWeight * Math.min(C.sizeCap, Math.abs(Math.log(want / got))) + (a + b - 2) * C.groupCost;
    if (timed && i + a < n && j + b < m) {
      const slip = ((L[i + a].t - L[i].t) - (P[j + b].t - P[j].t)) / C.gapTolSec;
      cost += Math.min(C.gapCap, slip * slip);
    }
    return cost;
  }
  // A phrase that follows the one before it within a breath is in the middle of a section.
  // Leaving off or picking up the words there costs extra: a chorus sung once more is left
  // out whole, not from its third line to the third line of the next.
  const midSection = (j) => j > 0 && j < m && P[j].t - P[j - 1].end < C.sectionGapSec;
  // Every step out of (i lines, j phrases used; s = the phrase before went without a line):
  // [lines taken, phrases taken, cost, s after].
  function steps(i, j, s) {
    const out = [];
    if (j < m) out.push([0, 1, C.skipPhraseCost + (!s && midSection(j) ? C.cutCost : 0), 1]);
    if (i < n) out.push([1, 0, C.skipLineCost, s]);
    if (i < n && j < m) {
      const cut = s && midSection(j) ? C.cutCost : 0;
      for (let a = 1; a <= C.maxLinesPerPhrase && i + a <= n; a++) out.push([a, 1, cut + match(i, a, j, 1), 0]);
      for (let b = 2; b <= C.maxPhrasesPerLine && j + b <= m; b++) out.push([1, b, cut + match(i, 1, j, b), 0]);
    }
    return out;
  }
  const grid = () => Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const fwd = [grid(), grid()], back = [grid(), grid()];
  const from = [0, 1].map(() => Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null)));
  fwd[0][0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) for (let s = 0; s < 2; s++) {
    const here = fwd[s][i][j];
    if (here === Infinity) continue;
    for (const [a, b, c, s2] of steps(i, j, s)) if (here + c < fwd[s2][i + a][j + b]) { fwd[s2][i + a][j + b] = here + c; from[s2][i + a][j + b] = [i, j, s, a, b]; }
  }
  back[0][n][m] = 0; back[1][n][m] = 0;
  // head[i][j]: the cheapest whole way in which line i begins a match at phrase j.
  const head = grid();
  for (let i = n; i >= 0; i--) for (let j = m; j >= 0; j--) for (let s = 0; s < 2; s++) {
    for (const [a, b, c, s2] of steps(i, j, s)) {
      const rest = c + back[s2][i + a][j + b];
      if (rest < back[s][i][j]) back[s][i][j] = rest;
      if (a > 0 && b > 0 && fwd[s][i][j] + rest < head[i][j]) head[i][j] = fwd[s][i][j] + rest;
    }
  }
  const endS = fwd[0][n][m] <= fwd[1][n][m] ? 0 : 1, total = fwd[endS][n][m];

  // Walk the best way back and read off who sits where.
  const out = L.map((l) => ({ t: null, end: null, text: l.text }));
  const groups = [], lost = [];
  let skippedPhrases = 0;
  for (let i = n, j = m, s = endS; i > 0 || j > 0;) {
    const [pi, pj, ps, a, b] = from[s][i][j];
    if (a > 0 && b > 0) groups.push({ i: pi, a, j: pj, b });
    else if (a > 0) lost.push({ i: pi, j: pj });
    else skippedPhrases++;
    i = pi; j = pj; s = ps;
  }
  let placed = 0, stable = 0;
  for (const g of groups) {
    const p = P[g.j];
    for (let k = 0; k < g.a; k++) {
      // Several lines in one phrase: by their own times when they have them, else by length.
      const into = timed ? L[g.i + k].t - L[g.i].t : ((sizeSum[g.i + k] - sizeSum[g.i]) / (sizeSum[g.i + g.a] - sizeSum[g.i])) * dur[g.j];
      out[g.i + k].t = k === 0 ? p.t : Math.min(p.t + into, p.end - 0.1 * (g.a - k));
    }
    placed += g.a;
    let other = Infinity;
    for (let j = 0; j <= m; j++) if (j !== g.j && head[g.i][j] < other) other = head[g.i][j];
    if (other - total >= C.stableMargin) stable += g.a;
  }
  // A line with no phrase waits in the rest before the phrase it would have come to.
  const guessed = [];
  for (const { i, j } of lost) { out[i].t = j > 0 ? P[j - 1].end : Math.max(0, P[0].t - 2); guessed.push(L[i].index); }
  for (let i = 1; i < n; i++) if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 0.05;
  for (const l of out) l.t = round3(l.t);

  const meanCost = total / n, stableShare = placed ? stable / placed : 0;
  const confidence = round3((placed / n) * (1 - C.stableWeight + C.stableWeight * stableShare) / (1 + meanCost));
  const ok = confidence >= (timed ? C.minConfidence : C.minConfidenceUntimed);
  return {
    ok, reason: ok ? null : 'loose', confidence, lines: out, placed, guessed: guessed.sort((a, b) => a - b), skippedPhrases, timed,
    meanCost: round3(meanCost), stableShare: round3(stableShare),
  };
}

// ---------------------------------------------------------------- the whole way

const untimed = (lines) => sungLines(lines).map((l) => ({ t: null, end: null, text: tidy(l.text) }));

function embeddedLines(tags) {
  if (!tags) return null;
  if (Array.isArray(tags.synced) && tags.synced.length) return { timed: true, lines: tags.synced.map((l) => ({ t: l.t, end: null, text: tidy(l.text) })) };
  if (typeof tags.lyrics === 'string' && tags.lyrics.trim()) {
    const lrc = parseLrc(tags.lyrics);
    if (sungLines(lrc.lines).length) return { timed: lrc.timed, lines: lrc.lines };
  }
  return null;
}

export async function autoWords({ file = null, tags = null, fileName = null, title = null, artist = null, phrases = [], durationSec = null,
  lookup = null, fetch: fetchImpl, sleep, cache = pageCache, config = AUTOWORDS } = {}) {
  let asked = { title: '', artist: '', from: 'name' };
  const done = (status, why, extra = {}) => ({ status, words: null, source: null, why, say: AUTOWORDS_SAY[why], asked, searched: false, fromCache: false, fit: null, leftover: null, ...extra });
  try {
    if (!tags && file) tags = await readTags(file);
    const name = fileName ?? (file && typeof file.name === 'string' ? file.name : '');
    asked = tidy(title) ? { title: tidy(title), artist: tidy(artist), from: 'edited' } : identify({ tags, fileName: name });
    const byLine = (lines) => fitByLine({ lines, phrases, config: config.byLine });
    let leftover = null;

    // 1. Words inside the file. Its own times were written for this very sound, so they are
    // kept even when the singing found does not agree with them.
    const own = embeddedLines(tags);
    if (own && own.timed) {
      const fit = fitOffset(own.lines, phrases, { duration: durationSec });
      if (fit.ok) return done('found', 'file-timed', { source: 'file', fit, words: makeWords(own.lines, { route: 'file', offsetSec: fit.offsetSec, autoOffsetSec: fit.offsetSec, credit: CREDIT.file }) });
      return done('found', 'file-as-is', { source: 'file', fit, words: makeWords(own.lines, { route: 'file', credit: CREDIT.file }) });
    }
    if (own) {
      const fit = byLine(own.lines);
      if (fit.ok) return done('fitted', 'file-by-line', { source: 'file', fit, words: makeWords(fit.lines, { route: 'file', credit: CREDIT.file }) });
      leftover = { words: makeWords(untimed(own.lines), { route: 'file', credit: CREDIT.file }), source: 'file' };
    }

    // 2. The one search. Without singing to lay the answers against none could be checked.
    if (!asked.title) return done('none', leftover ? 'no-fit' : 'no-title', { leftover });
    if ((phrases || []).length < SONG.words.fitMinLines) return done('none', 'no-singing', { leftover });
    const search = lookup || createSearch({ ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(sleep ? { sleep } : {}), config: config.search });
    const { answer, searched, fromCache } = await askOnce(cache || pageCache, songKey(asked), search, asked);
    const met = { searched, fromCache };
    if (!answer.ok) {
      const why = ['not-found', 'no-answer', 'bad-answer'].includes(answer.reason) ? answer.reason : 'no-answer';
      return done('none', leftover && why === 'not-found' ? 'no-fit' : why, { ...met, leftover });
    }
    const results = (answer.results || []).filter(Boolean);
    const withWords = results.filter((r) => !r.instrumental && sungLines(r.lines).length);
    if (!withWords.length) return done('none', results.some((r) => r.instrumental) ? 'instrumental' : 'not-found', { ...met, leftover });

    // 3. One shift for the whole song.
    const pick = pickWords({ results, phrases, durationSec, config: config.pick });
    if (pick) {
      return done('found', 'lrclib-fit', { ...met, source: 'lrclib', fit: { ...pick.fit, why: pick.why, index: pick.index },
        words: makeWords(pick.result.lines, { route: 'lookup', offsetSec: pick.fit.offsetSec, autoOffsetSec: pick.fit.offsetSec, credit: CREDIT.lrclib }) });
    }

    // 4. Line by line: the timed answers in their ranked order, then the untimed ones
    // nearest in length. The most settled one that passes is used.
    const far = (r) => { const d = lengthDiff(r, durationSec); return d === null ? 1e6 : Math.abs(d); };
    const tries = [...rankWords({ results, phrases, durationSec, config: config.pick }).map((x) => x.result),
      ...withWords.filter((r) => !r.timed).sort((a, b) => far(a) - far(b))].slice(0, config.byLine.maxTries);
    let best = null;
    for (const r of tries) { const fit = byLine(r.lines); if (fit.ok && (!best || fit.confidence > best.fit.confidence)) best = { fit, r }; }
    if (best) return done('fitted', 'lrclib-by-line', { ...met, source: 'lrclib', fit: best.fit, words: makeWords(best.fit.lines, { route: 'lookup', credit: CREDIT.lrclib }) });

    // 5. Words exist but none could be timed.
    if (!leftover && tries.length) leftover = { words: makeWords(untimed(tries[0].lines), { route: 'lookup', credit: CREDIT.lrclib }), source: 'lrclib' };
    return done('none', 'no-fit', { ...met, leftover });
  } catch {
    // Nothing above should throw; if it does, the song still opens, without words.
    return done('none', 'failed');
  }
}
