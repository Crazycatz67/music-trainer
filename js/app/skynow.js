// skynow.js — the real sky on the home dome: tonight's stars over the owner's city.
// docs/design/specs/2026-10-12-living-sky.md Part 1, sections 1 and 4.2.
//
// It joins three things that were built apart: the data (vendor/sky-data/, HYG stars and
// Stellarium figures), the maths (js/app/realsky.js) and the dome (sky.setStars /
// sky.setSky, which until now nobody called, so the home showed the made-up sky).
// The pure half imports in Node (tools/checks/skynow.check.mjs); startSkyNow is browser
// glue and is the only part that fetches or keeps a timer.
//
// CONTRACT
//   SKY_KEY = 'music-trainer.sky.v1'   the picker's record (spec 4.3): { cityId } | { lat, lon },
//                                       plus `confirmed`. Read only here; nothing writes it yet.
//   MILKY_WAY = { ra: 192.86, dec: 27.13 }   the north galactic pole (J2000), the band's pole
//   toCatalogue(starsJson, figuresJson, { lines = true, only = null }?) -> the dome's STAR CATALOGUE (skymap.js):
//       { stars: [{ ra, dec, mag, colour, name? }], figures: [{ id, name, lines }], milkyWay }
//       lines: false or 'off' gives figures: [] (stars and Milky Way only). lines: 'tonight'
//       keeps only the figure whose id (IAU code, e.g. 'Lyr') is `only`; none when only is null.
//   linesMode(v) -> 'all' | 'tonight' | 'off'   the Settings value skyLines, or the old boolean
//   tonightsCon(ms, place, tz) -> IAU code of tonight's constellation (realsky) | null
//       Star order and indexes are the file's, so figure lines index `stars` unchanged.
//       Throws (via realsky.makeSky) on a file of the wrong shape.
//   placeFor(saved, guess) -> { lat, lon, name|null, guessed, known }
//       saved: the parsed SKY_KEY record or null; guess: realsky.guessCity() output.
//       A saved city or saved numbers win; anything unreadable falls back to the guess.
//   orientationFor(nowMs, place) -> { mode, tRef, lst, latitude, north, ahead }
//       mode / tRef as realsky.skyMoment (now | tonight | no-night); `lst` in degrees at tRef;
//       `north` = the dome azimuth of compass north (180 when the dome faces south, which is
//       every place at latitude 0 or north; 0 in the south). { lst, latitude, north } is what
//       dome.setSky takes (skymap.skyRotation), so the dome's own maths does the turning.
//   startSkyNow(sky, { storage?, now?, timeZone?, atHome?, lines = LINES, loadJson?, starsUrl?, figuresUrl? })
//       -> { loaded: Promise<boolean>, debug() -> { state, mode, tRef, place, stars, figures,
//            lines, tonight, error }, setLines(mode), stop() }
//       lines: true | false | 'all' | 'tonight' | 'off'. The page's data-sky-lines (shell.js,
//       Settings > Look) wins when it is set, and its 'mt:skylines' event { mode } changes the
//       lines live; setLines does the same for a caller. 'tonight' follows the night rollover.
//       Fetches both files once. Until they land, and for ever if either fails, the dome keeps
//       the made-up sky: no error is shown, `loaded` resolves false and debug().error says why.
//       In mode 'now' the sky is turned once a minute while the page is visible and atHome();
//       when the tab comes back the moment is worked out afresh.
// The five places, Tonight's moon and the owner's earned shapes are drawn in the viewer's
// frame (dome az/alt), not on the star sphere, so turning the sky never moves them.

import { makeSky, guessCity, cityById, skyMoment, lst as siderealTime, aheadFor, tonightsConstellation } from './realsky.js';

export const SKY_KEY = 'music-trainer.sky.v1';
export const MILKY_WAY = Object.freeze({ ra: 192.86, dec: 27.13 });
// Spec section 1: "advanced once a minute while home is showing".
export const TURN_MS = 60000;
// The real constellation lines are ON now that the dome has the spec's clearings (section 2.3
// rule 2, dome.js clearings(): lines fade out round the five places, Your Sky and every place
// label; checked in skynow.check.mjs for London and Sydney). Drawn without them,
// 660 grey lines run straight through The Ladder and The Lyre and the places stop reading as
// places. The spec's own fallback for a busy sky is fewer lines (rule 4).
export const LINES = true;

export function toCatalogue(starsJson, figuresJson, { lines = true, only = null } = {}) {
  const sky = makeSky(starsJson, figuresJson);
  const stars = sky.stars.map(([ra, dec, mag, colour], i) => {
    const s = { ra, dec, mag, colour: Number.isFinite(colour) ? colour : null };
    const name = sky.names.get(i);
    if (name) s.name = name;
    return s;
  });
  const mode = linesMode(lines);
  const keep = mode === 'off' ? [] : mode === 'tonight' ? sky.figures.filter((f) => f.id === only) : sky.figures;
  const figures = keep.map((f) => ({ id: f.id, name: f.name, lines: f.lines }));
  return { stars, figures, milkyWay: MILKY_WAY };
}

// The Settings row stores 'all' | 'tonight' | 'off'; older callers pass a boolean. Anything
// else is 'all', the spec's default (living-sky 2.3 rule 4).
export function linesMode(v) {
  if (v === false || v === 'off') return 'off';
  return v === 'tonight' ? 'tonight' : 'all';
}

// Tonight's constellation as the figures file names it. realsky's STARTER rows carry the IAU
// code (`con`), which is the figures file's `id`. Judged at 9 pm local on the evening `ms`
// belongs to, so it only changes at the night rollover.
export function tonightsCon(ms, place, tz) {
  try {
    const t = tonightsConstellation(ms, { lat: place.lat, lon: place.lon, tz });
    return t.figure ? t.figure.con : null;
  } catch { return null; }
}

const okLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const okLon = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

export function placeFor(saved, guess) {
  if (saved && typeof saved === 'object') {
    const c = saved.cityId ? cityById(saved.cityId) : null;
    if (c) return { lat: c.lat, lon: c.lon, name: c.name, guessed: false, known: true };
    if (okLat(saved.lat) && okLon(saved.lon)) return { lat: saved.lat, lon: saved.lon, name: null, guessed: false, known: true };
  }
  return { lat: guess.lat, lon: guess.lon, name: guess.city ? guess.city.name : null, guessed: true, known: !!guess.known };
}

export function orientationFor(nowMs, place) {
  const { mode, tRef } = skyMoment(nowMs, place.lat, place.lon);
  const ahead = aheadFor(place.lat);
  return { mode, tRef, lst: siderealTime(tRef, place.lon), latitude: place.lat, north: ahead === 'south' ? 180 : 0, ahead };
}

function readSaved(storage) {
  try { const raw = storage && storage.getItem(SKY_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

const fetchJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });

export function startSkyNow(sky, {
  storage = null, now = () => Date.now(), timeZone, atHome = () => true, lines = LINES, loadJson = fetchJson,
  starsUrl = new URL('../../vendor/sky-data/stars.json', import.meta.url).href,
  figuresUrl = new URL('../../vendor/sky-data/figures.json', import.meta.url).href,
} = {}) {
  let state = 'loading', error = null, stopped = false, timer = null, view = null, counts = { stars: 0, figures: 0 };
  let place = null, data = null, shownKey = null, tonight = null;
  const pageLines = () => (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset.skyLines) || null;
  let mode = linesMode(pageLines() || lines);

  // The lines on the dome for the current mode. Only rebuilds when what is shown would change
  // (a new mode, or 'tonight' passing the night rollover): setStars rebuilds the whole field.
  function showLines() {
    if (stopped || !data) return;
    if (mode === 'tonight') {
      const saved = readSaved(storage), guess = guessCity(timeZone);
      const city = saved && saved.cityId ? cityById(saved.cityId) : null;
      tonight = tonightsCon(now(), placeFor(saved, guess), (city && city.tz) || guess.tz);
    }
    const key = mode === 'tonight' ? `tonight:${tonight}` : mode;
    if (key === shownKey) return;
    const cat = toCatalogue(data[0], data[1], { lines: mode, only: tonight });
    counts = { stars: cat.stars.length, figures: cat.figures.length };
    sky.setStars(cat);
    shownKey = key;
  }
  function setLines(v) {
    mode = linesMode(v);
    if (state === 'real') { showLines(); turn(); }
  }
  const onLines = (e) => setLines(e && e.detail ? e.detail.mode : undefined);

  // Turn the sky to the moment for this place. Only called once the real stars are on the
  // dome: the made-up sky's anchors are placed for an unturned sphere.
  function turn() {
    if (stopped || state !== 'real') return;
    place = placeFor(readSaved(storage), guessCity(timeZone));
    view = orientationFor(now(), place);
    sky.setSky({ lst: view.lst, latitude: view.latitude, north: view.north });
  }
  function tick() {
    if (stopped || state !== 'real' || !view || view.mode !== 'now') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!atHome()) return;
    if (mode === 'tonight') showLines();
    turn();
  }
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    if (mode === 'tonight' && state === 'real') showLines();
    turn();
  };

  const loaded = Promise.all([loadJson(starsUrl), loadJson(figuresUrl)]).then(([s, f]) => {
    if (stopped) return false;
    data = [s, f];
    showLines();
    state = 'real';
    turn();
    timer = setInterval(tick, TURN_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
      document.addEventListener('mt:skylines', onLines);
    }
    return true;
  }).catch((e) => {
    // A missing or broken file keeps the made-up sky. Nothing on screen says so: the home
    // works the same either way, and a lab reads debug().error.
    state = 'procedural';
    error = String(e && e.message || e);
    return false;
  });

  return {
    loaded,
    debug: () => ({ state, mode: view ? view.mode : null, tRef: view ? view.tRef : null, place, ...counts, lines: mode, tonight, error }),
    setLines,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
        document.removeEventListener('mt:skylines', onLines);
      }
    },
  };
}
