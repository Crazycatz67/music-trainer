// tutorial-steps.js — the rules of the first-visit tour, with no screen. Pure: no browser globals,
// imports in Node (checks: tools/checks/tutorial.check.mjs). The screen is tutorial.js (T2).
// Spec: docs/design/specs/2026-10-15-tutorial.md. Every number and word: tutorial.config.js.
//
// Contract (what T2 relies on):
//   TOUR, TOUR_STEPS, TOUR_WORDS                re-exported from tutorial.config.js
//   initialTour(stored?) -> state                from the stored `music-trainer.tour.v1` value (or none)
//   toStored(state, t) -> { state, step, line, voice, pausedAt, lastChance }
//                                                what to save; a running tour saves as 'paused'
//                                                (a reload during the tour shows the pill, 4.3)
//   nextTour(state, event) -> state              never mutates; returns the SAME object when the
//                                                event means nothing here (T2 can test `===`)
//   stepOf(state) -> one of TOUR_STEPS;  shouldOffer(state) -> bool;  escMeans(state) -> 'back'|'skip'
//   carryOnRoute(state) -> hash;  countLabel(state) -> '3 of 7' or ''
//   readingMs(words, speechMs?) -> ms            words: string | string[] | count
//   pickVoice(voices) -> voice | null            localService === true and English only
//   holdMeter({ needMs, graceMs, drain, maxFrameMs? }) -> { frame(t, ok), skip(t), reset(), progress, done }
//   matchTarget(midis) -> midi                   hummed median + 2, clamped; keyMidi when empty
//   earOpen({ speakingUntil, noteUntil }, t) -> bool
//   dockCard(targetRect | null, { w, h }, { w, h }, { reading? }) -> { x, y, w, h, at, clear }
//
// state = { status: 'new'|'running'|'paused'|'declined'|'done', step: id, line, voice, links,
//           keyed, arrows, pausedAt, lastChance }
// Events (all plain objects with `type`):
//   start {links} · decline · replay {links} · skip · end · voice {on} · pause {t} · resume ·
//   visit {t, tzOffsetMin} · next · close · lineDone · woken · landed · useKey · micFailed ·
//   drag {px} · arrow · route {hash}
import { TOUR, TOUR_STEPS, TOUR_WORDS } from './tutorial.config.js';

export { TOUR, TOUR_STEPS, TOUR_WORDS };

const STEP = Object.fromEntries(TOUR_STEPS.map((s) => [s.id, s]));
const STATUSES = ['new', 'running', 'paused', 'declined', 'done'];

export function initialTour(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const status = STATUSES.includes(s.state) ? s.state : 'new';
  // A saved 'running' cannot happen (toStored writes 'paused'), but be safe: treat it as paused.
  return {
    status: status === 'running' ? 'paused' : status,
    step: STEP[s.step] && s.step !== 'invite' ? s.step : (status === 'new' ? 'invite' : 'wake'),
    line: Number.isInteger(s.line) && s.line >= 0 ? s.line : 0,
    voice: typeof s.voice === 'boolean' ? s.voice : TOUR.voiceDefault,
    links: false,
    keyed: false,
    arrows: 0,
    pausedAt: Number.isFinite(s.pausedAt) ? s.pausedAt : null,
    lastChance: s.lastChance === true,
  };
}

export function toStored(state, t) {
  const running = state.status === 'running';
  return {
    state: running ? 'paused' : state.status,
    step: state.step,
    line: state.line,
    voice: state.voice,
    pausedAt: running ? t : state.pausedAt,
    lastChance: state.lastChance,
  };
}

export function stepOf(state) { return STEP[state.step] || STEP.invite; }
export function shouldOffer(state) { return state.status === 'new'; }

export function countLabel(state) {
  const n = stepOf(state).n;
  return n > 0 ? TOUR_WORDS.stepOf(n, TOUR.counted) : '';
}

// Esc on an arrived visit step goes Back home (which then arrives as a route event); elsewhere it
// skips the tour (spec 10, check 10).
export function escMeans(state) {
  const s = stepOf(state);
  return state.status === 'running' && s.goes && state.line >= 1 ? 'back' : 'skip';
}

// Where Carry on takes you: the place a visit step had reached, else the step's own route.
export function carryOnRoute(state) {
  const s = stepOf(state);
  return s.goes && state.line >= 1 ? s.goes : s.at;
}

function routeOf(hash) {
  const h = String(hash || '').split('?')[0];
  return h === '' || h === '#' || h === '#/' ? '#/sky' : h;
}

function dayOf(ms, tzOffsetMin = 0) {
  return Math.floor((ms - tzOffsetMin * 60000) / TOUR.dayMs);
}

function go(state, step) {
  // A fresh step starts on its first line, with the look counters cleared.
  return { ...state, step, line: 0, arrows: 0 };
}

function after(state) {
  switch (state.step) {
    case 'landed': return go(state, state.links ? 'places' : 'look'); // links mode: no dome to drag
    case 'look': return go(state, 'places');
    case 'places': return go(state, 'ladder');
    case 'ladder': return go(state, 'lyre');
    case 'lyre': return go(state, 'end');
    case 'end': return { ...state, status: 'done' };
    default: return state;
  }
}

export function nextTour(state, event) {
  const e = event || {};
  const st = state.status;
  switch (e.type) {
    case 'voice': return state.voice === !!e.on ? state : { ...state, voice: !!e.on };
    case 'start':
      if (st !== 'new') return state;
      return { ...go(state, 'wake'), status: 'running', links: !!e.links, keyed: false };
    case 'decline': return st === 'new' ? { ...state, status: 'declined' } : state;
    case 'replay': // Settings › Tour: starts at step 1, the invitation skipped (spec 9)
      return { ...go(state, 'wake'), status: 'running', links: !!e.links, keyed: false,
        pausedAt: null, lastChance: false };
    case 'skip':
      if (st === 'new') return { ...state, status: 'declined' };
      return st === 'running' || st === 'paused' ? { ...state, status: 'done' } : state;
    case 'end': return st === 'running' || st === 'paused' ? { ...state, status: 'done' } : state;
    case 'pause': return st === 'running' ? { ...state, status: 'paused', pausedAt: e.t ?? null } : state;
    case 'resume': return st === 'paused' ? { ...state, status: 'running', lastChance: false } : state;
    case 'visit': {
      if (st === 'running') return { ...state, status: 'paused', pausedAt: e.t ?? null };
      if (st !== 'paused' || state.pausedAt == null || !Number.isFinite(e.t)) return state;
      if (dayOf(e.t, e.tzOffsetMin) <= dayOf(state.pausedAt, e.tzOffsetMin)) return state;
      // A later day: the pill once more, then the tour counts as ended (no nagging).
      return state.lastChance ? { ...state, status: 'done' } : { ...state, lastChance: true };
    }
    default: break;
  }
  if (st !== 'running') return state;

  const s = stepOf(state);
  switch (e.type) {
    case 'useKey': case 'micFailed':
      return s.mic && !state.keyed ? { ...state, keyed: true } : state;
    case 'woken': return state.step === 'wake' ? go(state, 'land') : state;
    case 'landed': return state.step === 'land' ? go(state, 'landed') : state;
    case 'next': return s.mic ? state : after(state);
    case 'close': return state.step === 'end' ? { ...state, status: 'done' } : state;
    case 'lineDone':
      if (state.step === 'landed') return after(state);
      if (state.step === 'places') {
        return state.line < s.lines.length - 1 ? { ...state, line: state.line + 1 } : after(state);
      }
      // Visit steps: only the arrival line moves on by itself; the last one waits for home.
      if (s.goes && state.line === 1) return { ...state, line: 2 };
      return state;
    case 'drag':
      return state.step === 'look' && e.px >= TOUR.lookDragPx ? after(state) : state;
    case 'arrow': {
      if (state.step !== 'look') return state;
      const arrows = state.arrows + 1;
      return arrows >= TOUR.lookArrows ? after(state) : { ...state, arrows };
    }
    case 'route': {
      const r = routeOf(e.hash);
      if (s.goes) {
        if (r === s.goes) return state.line === 0 ? { ...state, line: 1 } : state;
        if (r === s.at) return state.line >= 1 ? after(state) : state;
      } else if (r === s.at) return state;
      // Somewhere the step did not ask for: the card shrinks to the pill (4.3).
      return { ...state, status: 'paused', pausedAt: e.t ?? state.pausedAt };
    }
    default: return state;
  }
}

function wordCount(words) {
  if (typeof words === 'number') return Math.max(0, words);
  const text = Array.isArray(words) ? words.join(' ') : String(words || '');
  return text.split(/\s+/).filter(Boolean).length;
}

export function readingMs(words, speechMs) {
  const r = TOUR.reading;
  const base = Math.max(r.minMs, r.perWordMs * wordCount(words));
  return Number.isFinite(speechMs) ? Math.max(base, speechMs + r.afterSpeechMs) : base;
}

// Remote voices are never used: the text would leave the computer ("Sound stays on this
// computer"). The system default if it qualifies, else the first en-GB / en-US, else any local
// English voice; null means "show words only".
export function pickVoice(voices) {
  const v = TOUR.voice;
  const ok = (Array.isArray(voices) ? voices : []).filter((x) => x && x.localService === true
    && String(x.lang || '').toLowerCase().startsWith(v.langPrefix));
  const norm = (lang) => String(lang || '').replace('_', '-').toLowerCase();
  return ok.find((x) => x.default)
    || ok.find((x) => v.prefer.some((p) => norm(x.lang) === p.toLowerCase()))
    || ok[0] || null;
}

// Fills while `ok` frames arrive; a gap up to graceMs only pauses it, after that it drains at
// `drain` times the fill speed. Frame gaps are clamped and the first frame gives no credit, so a
// stalled tab cannot fill it. Once done it stays done until reset().
export function holdMeter({ needMs, graceMs, drain, maxFrameMs = TOUR.maxFrameMs }) {
  let held = 0, gap = 0, lastT = null, done = false;
  const out = () => ({ progress: Math.min(1, held / needMs), done });
  return {
    frame(t, ok) {
      const dt = lastT == null ? 0 : Math.min(maxFrameMs, Math.max(0, t - lastT));
      lastT = t;
      if (done) return out();
      if (ok) {
        gap = 0;
        held += dt;
        if (held >= needMs) done = true;
      } else {
        const before = gap;
        gap += dt;
        const over = gap - Math.max(before, graceMs);
        if (over > 0) held = Math.max(0, held - over * drain);
      }
      return out();
    },
    // An ignored frame (the guide speaking, 6.1): time passes, nothing fills or drains.
    skip(t) { lastT = t; return out(); },
    reset() { held = 0; gap = 0; lastT = null; done = false; },
    get progress() { return Math.min(1, held / needMs); },
    get done() { return done; },
  };
}

export function matchTarget(midis) {
  const c = TOUR.target;
  const m = (Array.isArray(midis) ? midis : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!m.length) return c.keyMidi;
  const mid = m.length >> 1;
  const median = m.length % 2 ? m[mid] : (m[mid - 1] + m[mid]) / 2;
  return Math.min(c.maxMidi, Math.max(c.minMidi, Math.round(median) + c.upSemis));
}

// The ear is shut while the guide speaks or the note plays and a little after (the mic has echo
// cancellation off, so the speakers reach it). Pass Infinity while a sound is still going.
export function earOpen({ speakingUntil, noteUntil } = {}, t) {
  const s = Number.isFinite(speakingUntil) || speakingUntil === Infinity ? speakingUntil : -Infinity;
  const n = Number.isFinite(noteUntil) || noteUntil === Infinity ? noteUntil : -Infinity;
  return t >= s + TOUR.earAfterSpeechMs && t >= n + TOUR.earAfterNoteMs;
}

function overlap(a, b, pad) {
  const w = Math.min(a.x + a.w, b.x + b.w + pad) - Math.max(a.x, b.x - pad);
  const h = Math.min(a.y + a.h, b.y + b.h + pad) - Math.max(a.y, b.y - pad);
  return w > 0 && h > 0 ? w * h : 0;
}

// Bottom centre (or bottom right in the gutter on wide reading screens); if the spotlit target
// would meet it (plus clearPx), top centre under the strip. If both meet, the smaller overlap
// wins and `clear` is false so the lab can see it.
export function dockCard(target, card, view, { reading = false } = {}) {
  const d = TOUR.dock;
  const narrow = view.w < d.narrowBelow;
  const w = narrow ? Math.max(0, view.w - 2 * d.sidePx) : Math.min(card.w, d.maxW, view.w - 2 * d.sidePx);
  const h = Math.min(card.h, view.h);
  let x;
  if (narrow) x = d.sidePx;
  else if (reading && view.w >= d.gutterFrom) x = view.w - w - d.bottomPx;
  else x = Math.round((view.w - w) / 2);
  const bottom = { x, y: Math.max(0, view.h - h - d.bottomPx), w, h, at: 'bottom' };
  const top = { x, y: Math.min(d.topPx, Math.max(0, view.h - h)), w, h, at: 'top' };
  const ok = (r) => r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0;
  if (!ok(target)) return { ...bottom, clear: true };
  const ob = overlap(bottom, target, d.clearPx);
  if (!ob) return { ...bottom, clear: true };
  const ot = overlap(top, target, d.clearPx);
  if (!ot) return { ...top, clear: true };
  return { ...(ot < ob ? top : bottom), clear: false };
}
