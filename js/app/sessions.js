// sessions.js — the practice record: what was sung, on which day. Every exercise hands its
// scored readings (or, with no target, its plain facts) here; Today, the daily session and
// the coach summary read it back. PURE: imports in Node (tools/checks/sessions.check.mjs),
// and reaches storage only through the { getItem, setItem } it is given.
//
// CONTRACT
//   SESSIONS_KEY   'music-trainer.sessions.v1' -> { v: 1, days: [day], sessions: [Session] }
//   day            'YYYY-MM-DD', local time; a day starts at config.sessions.dayStartsHour.
//   Session        { id, day, at (ISO), kind: 'daily' | 'practice', takes: [Take] }, oldest first.
//                  One 'daily' session per press of Start on Today; everything else sung that
//                  day shares one 'practice' session (id 'p-<day>').
//   Take           { exercise, at (ISO), sec, of, stars, notes: [NoteRec], facts? }
//                  exercise: 'matchhold' | 'constellation' | 'freesing' | 'range' | 'voicecheck' |
//                  'longnote' (of = holds in the set, stars = the same: no hold is a miss)
//                  (voicecheck: of = notes and tune notes sung, stars = those on target)
//                  sec: seconds of scored listening. of / stars: notes tried / held to the end.
//                  facts: plain results of an exercise with no target (free sing, range).
//   NoteRec        one try at one target. Cents follow js/coach.js: negative = low.
//                  { midi, held, sec, sung (seconds with a voice), in25 (% of sung readings within
//                    25 cents, any distance counted), w (readings near the target: the weight of
//                    the next four), mean, scoop, wobble, drift (cents, or null),
//                    lock (seconds from the first sound to settling, or null) }
//                  mean, scoop, wobble and drift use only readings within config.sessions.nearCents
//                  of the target (octave folded), so hunting for a note does not read as "low";
//                  they are null (and w is 0) when fewer than config.sessions.nearShare of the
//                  note's sung readings were that near.
//
//   dayKey(date, config?) -> day            addDays(day, n) -> day
//   createTake({ exercise, config?, at? }) -> take
//       take.frame(key, targetMidi, { t, midi, voiced })   one SCORED reading; t in seconds, never
//                              backwards. key names the target (its index in the round): a new
//                              key, a moved target or a break starts a new NoteRec.
//       take.landed(key)       that target was held to the end
//       take.end({ facts?, sec? }) -> Take | null (nothing sung, nothing to say). Runs coach.js
//                              analyse(); the readings themselves are dropped, never saved.
//   readStore(storage, config?) -> { days, sessions, ok }   never throws. ok is false when
//                              something was saved but could not be read (it is treated as empty).
//   withTake(data, take, { now, sessionId?, config? }) -> { data, session }   pure
//   writeStore(storage, data, config?) -> boolean   trims to the sizes in config.sessions first
//   streakOf(days, today) -> { count, state: 'zero' | 'on' | 'broken' }
//   streakWords(streak) -> string            (spec section 4; never a guilt line)
//   createSessions({ storage, now?, config?, onTake? }) -> sessions
//       sessions.take(exercise) -> take, whose end() also saves and calls onTake
//       sessions.result(exercise, { sec?, facts })   an exercise with no target
//       sessions.beginDaily(id?) -> id, endDaily(), current() -> id | null
//       sessions.read() -> { days, sessions, ok }, session(id), latest(), today() -> day
//       sessions.streak() -> streakOf(...)
//       With no storage (private mode) the record lives in memory for the visit.
//   Failure: unreadable text is copied once to SESSIONS_KEY + '.bad' before anything is
//   written over it. A full or blocked storage: end() still returns the Take; saved is false.

import { analyse } from '../coach.js';
import { CONFIG } from './config.js';
import { STORAGE_PREFIX } from './shell.js';

export const SESSIONS_KEY = `${STORAGE_PREFIX}sessions.v1`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXERCISES = new Set(['matchhold', 'constellation', 'freesing', 'range', 'voicecheck', 'longnote', 'eyesclosed', 'glide', 'siren', 'star-steps', 'leaps']);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function dayKey(date = new Date(), config = CONFIG) {
  const d = new Date(date.getTime() - config.sessions.dayStartsHour * 3600e3);
  return ymd(d);
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  // Noon: a daylight-saving change cannot push the sum into the neighbouring day.
  return ymd(new Date(y, m - 1, d + n, 12));
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------- one exercise's take

export function createTake({ exercise, config = CONFIG, at = null } = {}) {
  const S = config.sessions, C = config.coach;
  const segs = [];   // { key, midi, t0, tLast }
  const frames = []; // { t, midi, voiced, seg }
  const landed = new Set();
  let cur = null, ended = false;

  function build({ facts = null, sec = null } = {}) {
    const gaps = [];
    for (let i = 1; i < frames.length; i++) if (frames[i].seg === frames[i - 1].seg) gaps.push(frames[i].t - frames[i - 1].t);
    const dt = median(gaps) || 0.02;
    const notes = segs.map((s, i) => {
      const next = segs[i + 1];
      // A note ends where its last reading does, and never runs into the next one.
      return { t: s.t0, dur: Math.max(dt, Math.min(s.tLast - s.t0 + dt, next ? next.t0 - s.t0 : Infinity)), midi: s.midi };
    });
    const timeline = { title: exercise, notes };
    const opts = { foldOctaves: true, lockCents: C.lockCents, lockHold: C.lockHoldSec, onsetWindow: C.onsetWindowSec, minHold: C.minHoldSec };
    // Twice: every voiced reading for "how long, how much in tune, how quick to settle",
    // then only the readings near the target for the tuning numbers.
    const near = frames.map((f) => {
      if (!f.voiced) return f;
      let cents = 100 * (f.midi - segs[f.seg].midi);
      cents -= 1200 * Math.round(cents / 1200);
      return Math.abs(cents) <= S.nearCents ? f : { t: f.t, midi: null, voiced: false };
    });
    const all = notes.length ? analyse(timeline, frames, opts).notes : [];
    const close = notes.length ? analyse(timeline, near, opts).notes : [];
    const recs = all.slice(0, S.maxNotesPerTake).map((a, i) => {
      const b = close[i];
      // Mostly far from the target: the few readings that passed near it are crossings, not
      // a held note, and a line fitted through them reads as "long notes creep up" (bugs.md 55).
      const settled = b.voiced >= a.voiced * S.nearShare;
      return {
        midi: segs[i].midi, held: landed.has(segs[i].key), sec: round2(notes[i].dur), sung: round2(a.voiced * dt),
        in25: a.sung ? Math.round(a.within25) : null, w: b.sung && settled ? b.voiced : 0,
        mean: settled ? round1(b.meanCents) : null, scoop: settled ? round1(b.scoopCents) : null,
        wobble: settled ? round1(b.wobble) : null, drift: settled ? round1(b.drift) : null,
        lock: a.lockTime !== null && a.onsetDelay !== null ? round2(Math.max(0, a.lockTime - a.onsetDelay)) : null,
      };
    });
    const keys = new Set(segs.map((s) => s.key));
    if (!recs.length && !facts) return null;
    const take = {
      exercise, at: at || new Date().toISOString(), sec: round2(sec ?? frames.length * dt) ?? 0,
      of: keys.size, stars: [...keys].filter((k) => landed.has(k)).length, notes: recs,
    };
    if (facts) take.facts = facts;
    return take;
  }

  return {
    frame(key, targetMidi, f) {
      if (ended || !f || !Number.isFinite(f.t) || !Number.isFinite(targetMidi)) return;
      if (frames.length >= S.maxFramesPerTake) return;
      if (frames.length && f.t < frames[frames.length - 1].t) return;
      if (!cur || cur.key !== key || cur.midi !== targetMidi || f.t - cur.tLast > S.segmentGapSec) {
        cur = { key, midi: targetMidi, t0: f.t, tLast: f.t };
        segs.push(cur);
      }
      cur.tLast = f.t;
      const voiced = !!f.voiced && Number.isFinite(f.midi);
      frames.push({ t: f.t, midi: voiced ? f.midi : null, voiced, seg: segs.length - 1 });
    },
    landed(key) { landed.add(key); },
    end(extra) {
      if (ended) return null;
      ended = true;
      return build(extra);
    },
  };
}

// ---------------------------------------------------------------- the saved record

const num = (x) => (Number.isFinite(x) ? x : null);
const count = (x) => (Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);

function cleanNote(n) {
  if (!n || typeof n !== 'object' || !Number.isFinite(n.midi)) return null;
  return {
    midi: n.midi, held: n.held === true, sec: num(n.sec) ?? 0, sung: num(n.sung) ?? 0, in25: num(n.in25), w: count(n.w),
    mean: num(n.mean), scoop: num(n.scoop), wobble: num(n.wobble), drift: num(n.drift), lock: num(n.lock),
  };
}

function cleanTake(t, S) {
  if (!t || typeof t !== 'object' || !EXERCISES.has(t.exercise)) return null;
  const out = {
    exercise: t.exercise, at: typeof t.at === 'string' ? t.at : '', sec: num(t.sec) ?? 0, of: count(t.of), stars: count(t.stars),
    notes: (Array.isArray(t.notes) ? t.notes : []).map(cleanNote).filter(Boolean).slice(0, S.maxNotesPerTake),
  };
  if (t.facts && typeof t.facts === 'object' && !Array.isArray(t.facts)) {
    const facts = {};
    for (const [k, v] of Object.entries(t.facts).slice(0, 8)) if (Number.isFinite(v)) facts[k] = v;
    out.facts = facts;
  }
  return out;
}

function cleanSession(s, S) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || s.id.length > 40) return null;
  if (typeof s.day !== 'string' || !DAY_RE.test(s.day)) return null;
  return {
    id: s.id, day: s.day, at: typeof s.at === 'string' ? s.at : '', kind: s.kind === 'daily' ? 'daily' : 'practice',
    takes: (Array.isArray(s.takes) ? s.takes : []).map((t) => cleanTake(t, S)).filter(Boolean).slice(-S.maxTakesPerSession),
  };
}

const empty = (ok = true) => ({ days: [], sessions: [], ok });

function clean(raw, S) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.map((s) => cleanSession(s, S)).filter(Boolean).slice(-S.maxSessions);
  const days = new Set((Array.isArray(raw.days) ? raw.days : []).filter((d) => typeof d === 'string' && DAY_RE.test(d)));
  for (const s of sessions) if (s.takes.length) days.add(s.day);
  return { days: [...days].sort().slice(-S.maxDays), sessions, ok: true };
}

export function readStore(storage, config = CONFIG) {
  let text = null;
  try { text = storage ? storage.getItem(SESSIONS_KEY) : null; } catch { return empty(false); }
  if (text === null || text === undefined || text === '') return empty();
  let raw = null;
  try { raw = JSON.parse(text); } catch { return empty(false); }
  return clean(raw, config.sessions) || empty(false);
}

export function withTake(data, take, { now = new Date(), sessionId = null, config = CONFIG } = {}) {
  const S = config.sessions, day = dayKey(now, config);
  const sessions = data.sessions.map((s) => ({ ...s, takes: [...s.takes] }));
  const id = sessionId || `p-${day}`;
  let session = sessions.find((s) => s.id === id);
  if (!session) {
    session = { id, day, at: now.toISOString(), kind: sessionId ? 'daily' : 'practice', takes: [] };
    sessions.push(session);
  }
  session.takes.push(take);
  // The newest takes are the ones the coach is asked about.
  session.takes = session.takes.slice(-S.maxTakesPerSession);
  const days = [...new Set([...data.days, session.day])].sort().slice(-S.maxDays);
  return { data: { days, sessions: sessions.slice(-S.maxSessions), ok: data.ok }, session };
}

export function writeStore(storage, data, config = CONFIG) {
  if (!storage) return false;
  const S = config.sessions;
  let sessions = data.sessions.slice(-S.maxSessions);
  const text = () => JSON.stringify({ v: 1, days: data.days.slice(-S.maxDays), sessions });
  let out = text();
  // Oldest first, but never the newest: that is the one just sung.
  while (out.length > S.maxBytes && sessions.length > 1) { sessions = sessions.slice(1); out = text(); }
  try { storage.setItem(SESSIONS_KEY, out); return true; } catch { /* full or blocked: try once more, smaller */ }
  if (sessions.length <= 1) return false;
  sessions = sessions.slice(Math.ceil(sessions.length / 2));
  try { storage.setItem(SESSIONS_KEY, text()); return true; } catch { return false; }
}

// ---------------------------------------------------------------- streak

export function streakOf(days, today) {
  const set = new Set(days);
  if (!set.size) return { count: 0, state: 'zero' };
  // Yesterday's run is still alive until today ends.
  let day = set.has(today) ? today : addDays(today, -1);
  if (!set.has(day)) return { count: 0, state: 'broken' };
  let n = 0;
  while (set.has(day)) { n++; day = addDays(day, -1); }
  return { count: n, state: 'on' };
}

export function streakWords(streak) {
  if (!streak || streak.state === 'zero') return 'Start a streak today';
  if (streak.state === 'broken') return 'New streak starts today';
  return streak.count === 1 ? '1 day so far' : `${streak.count} days in a row`;
}

// ---------------------------------------------------------------- the store the app uses

export function createSessions({ storage = null, now = () => new Date(), config = CONFIG, onTake = null } = {}) {
  let memory = empty(), daily = null, movedBad = false, inMemory = !storage;

  function read() {
    if (inMemory) return memory;
    const data = readStore(storage, config);
    // Unreadable: the app carries on from empty, and keeps what was there in case it can be
    // mended by hand. Once: a second bad read must not replace the first copy.
    if (!data.ok && !movedBad) {
      movedBad = true;
      try {
        const text = storage.getItem(SESSIONS_KEY);
        if (typeof text === 'string' && storage.getItem(`${SESSIONS_KEY}.bad`) === null) storage.setItem(`${SESSIONS_KEY}.bad`, text.slice(0, config.sessions.maxBytes));
      } catch { /* nothing more can be done */ }
    }
    return data;
  }

  function add(take) {
    if (!take) return null;
    const out = withTake(read(), take, { now: now(), sessionId: daily, config });
    const saved = storage ? writeStore(storage, out.data, config) : false;
    // Storage full or blocked: the rest of the visit is kept here, so Today and the coach
    // still see what was just sung. Once a save works again the saved text is the record:
    // left in memory, every later save was built on the old copy and wrote over the take
    // before it (bugs.md 54).
    if (!saved) { memory = out.data; inMemory = true; } else if (storage) inMemory = false;
    const detail = { take, session: out.session, saved };
    if (onTake) onTake(detail);
    return detail;
  }

  return {
    read,
    today: () => dayKey(now(), config),
    streak() { return streakOf(read().days, dayKey(now(), config)); },
    session(id) { return read().sessions.find((s) => s.id === id) || null; },
    latest() { const all = read().sessions; return all[all.length - 1] || null; },
    take(exercise) {
      const take = createTake({ exercise, config, at: now().toISOString() });
      return { frame: take.frame, landed: take.landed, end(extra) { const rec = take.end(extra); add(rec); return rec; } };
    },
    result(exercise, { sec = 0, facts = {} } = {}) {
      const rec = createTake({ exercise, config, at: now().toISOString() }).end({ facts, sec });
      return add(rec);
    },
    // id: carry on filing takes under a daily session begun earlier in this visit.
    beginDaily(id = null) {
      const t = now();
      daily = id || `d-${dayKey(t, config)}-${t.getTime().toString(36)}`;
      return daily;
    },
    endDaily() { daily = null; },
    current: () => daily,
  };
}
