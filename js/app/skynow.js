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
//   toCatalogue(starsJson, figuresJson, { lines = true }?) -> the dome's STAR CATALOGUE (skymap.js):
//       { stars: [{ ra, dec, mag, colour, name? }], figures: [{ id, name, lines }], milkyWay }
//       lines: false gives figures: [] (stars and Milky Way only).
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
//            error }, stop() }
//       Fetches both files once. Until they land, and for ever if either fails, the dome keeps
//       the made-up sky: no error is shown, `loaded` resolves false and debug().error says why.
//       In mode 'now' the sky is turned once a minute while the page is visible and atHome();
//       when the tab comes back the moment is worked out afresh.
// The five places, Tonight's moon and the owner's earned shapes are drawn in the viewer's
// frame (dome az/alt), not on the star sphere, so turning the sky never moves them.

import { makeSky, guessCity, cityById, skyMoment, lst as siderealTime, aheadFor } from './realsky.js';

export const SKY_KEY = 'music-trainer.sky.v1';
export const MILKY_WAY = Object.freeze({ ra: 192.86, dec: 27.13 });
// Spec section 1: "advanced once a minute while home is showing".
export const TURN_MS = 60000;
// The real constellation lines stay OFF until the dome has the spec's clearings (section 2.3
// rule 2: lines fade out round the five places and the earned shapes). Drawn without them,
// 660 grey lines run straight through The Ladder and The Lyre and the places stop reading as
// places. The spec's own fallback for a busy sky is fewer lines (rule 4).
export const LINES = false;

export function toCatalogue(starsJson, figuresJson, { lines = true } = {}) {
  const sky = makeSky(starsJson, figuresJson);
  const stars = sky.stars.map(([ra, dec, mag, colour], i) => {
    const s = { ra, dec, mag, colour: Number.isFinite(colour) ? colour : null };
    const name = sky.names.get(i);
    if (name) s.name = name;
    return s;
  });
  const figures = !lines ? [] : sky.figures.map((f) => ({ id: f.id, name: f.name, lines: f.lines }));
  return { stars, figures, milkyWay: MILKY_WAY };
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
  let place = null;

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
    turn();
  }
  const onVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') turn(); };

  const loaded = Promise.all([loadJson(starsUrl), loadJson(figuresUrl)]).then(([s, f]) => {
    if (stopped) return false;
    const cat = toCatalogue(s, f, { lines });
    counts = { stars: cat.stars.length, figures: cat.figures.length };
    sky.setStars(cat);
    state = 'real';
    turn();
    timer = setInterval(tick, TURN_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
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
    debug: () => ({ state, mode: view ? view.mode : null, tRef: view ? view.tRef : null, place, ...counts, error }),
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
