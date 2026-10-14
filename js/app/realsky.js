// The real sky: where the stars are for a date, a time and a place. Pure maths and tables:
// no DOM, no drawing, no network, so it imports in Node and the checks can run it
// (tools/checks/realsky.check.mjs). The formulas are Ricky's
// (docs/team-log/reports/2026-10-12-real-sky-research.md); the data files it reads are
// built by tools/build-stars.mjs into vendor/sky-data/.
//
// CONTRACT
//   Units    angles in DEGREES everywhere; time is `ms`, Unix milliseconds (Date.now());
//            latitude north-positive, longitude EAST-positive (New York is -74.006);
//            right ascension `ra` in degrees (0..360), not hours.
//   Azimuth  from north through east: 0 = north, 90 = east, 180 = south, 270 = west.
//   Vector   [east, up, -north]: three.js axes (+x right, +y up, -z ahead) for someone
//            facing NORTH. It equals skyVector(az, alt) in js/app/skymap.js when the dome's
//            azimuth 0 is north. For a dome that faces south pass { ahead: 'south' }.
//   Accuracy no precession, nutation, refraction or proper motion: positions are the J2000
//            catalogue ones. In 2026 that is within 0.2 degrees in altitude and 0.3 in
//            azimuth of a full ephemeris (the four reference rows in the check), which the
//            eye cannot see on a dome. Do not use it to point a telescope.
//
//   julianDate(ms) -> JD            daysSinceJ2000(ms) -> D
//   gmst(ms) -> Greenwich mean sidereal time, degrees 0..360
//   lst(ms, lon) -> local sidereal time, degrees 0..360
//   hourAngle(ra, ms, lon) -> degrees (-180, 180]; 0 = on the meridian, + = past it (west)
//   horizonVector(ra, dec, ms, lat, lon, opts?) -> [east, up, -north]
//   altAz(ra, dec, ms, lat, lon) -> { alt, az }
//   equatorialVector(ra, dec) -> [x, y, z]: the star sphere's own frame (x to RA 0, z to the
//            north celestial pole). Build the star geometry ONCE from these.
//   skyRotation(ms, lat, lon, opts?) -> { matrix, quaternion, lst }: the single rotation
//            that carries every equatorialVector to its [east, up, -north] for that moment
//            and place. `matrix` is 9 numbers row by row; `quaternion` is [x, y, z, w]
//            (three.js: `points.quaternion.fromArray(q)`).
//   rotate(matrix, v) -> [x, y, z]
//   aheadFor(lat) -> 'south' | 'north': which way the dome faces (living-sky spec 1, Compass)
//
//   sunPosition(ms) -> { ra, dec }      sunAltitude(ms, lat, lon) -> degrees
//   skyMoment(nowMs, lat, lon) -> { mode: 'now' | 'tonight' | 'no-night', tRef, sunAlt }
//
//   CITIES, cityById(id), guessCity(timeZone?) -> { city, lat, lon, tz, guessed, known }
//   tzOffsetMinutes(ms, tz), localParts(ms, tz), localToUtc(parts, tz), ninePmLocal(ms, tz)
//
//   STARTER              the twelve singable real figures, one per month (frozen data)
//   starterAt(ms, lat, lon) -> one row per STARTER figure: where it is at that moment
//   pickBestPlaced(rows) -> the row to call "tonight's", or null
//   tonightsConstellation(ms, place) -> { figure, at, alt, az, hourAngle, how, all }
//
//   makeSky(starsJson, figuresJson) -> { stars, names, figures, indexOfHip }
//   constellationsUp(sky, ms, lat, lon, opts?) -> the figures above the horizon, highest first
//
// FAILURE BEHAVIOUR: a time zone the runtime does not know gives offset 0 from
// tzOffsetMinutes (never a throw); guessCity then answers `known: false` with a place at
// 40 degrees north. makeSky throws on a file that is not the build script's shape, because
// a silently wrong sky is worse than no sky.

export const RAD = Math.PI / 180;

const mod360 = (x) => ((x % 360) + 360) % 360;
const wrap180 = (x) => { const m = mod360(x); return m > 180 ? m - 360 : m; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- the clock

export function julianDate(ms) { return ms / 86400000 + 2440587.5; }

export function daysSinceJ2000(ms) { return julianDate(ms) - 2451545; }

// The linear part of the IAU 1982 expression. The term it drops grows as T squared and is
// 0.00003 degrees in 2026.
export function gmst(ms) { return mod360(280.46061837 + 360.98564736629 * daysSinceJ2000(ms)); }

export function lst(ms, lon) { return mod360(gmst(ms) + lon); }

export function hourAngle(ra, ms, lon) { return wrap180(lst(ms, lon) - ra); }

// ---------------------------------------------------------------- one star

// `opts.ahead: 'south'` turns the answer half a turn about the vertical, for a dome whose
// straight-ahead (-z) is south. The default is Ricky's frame, north ahead.
export function horizonVector(ra, dec, ms, lat, lon, opts) {
  const h = (lst(ms, lon) - ra) * RAD, d = dec * RAD, p = lat * RAD;
  const cd = Math.cos(d), sd = Math.sin(d), cp = Math.cos(p), sp = Math.sin(p), ch = Math.cos(h);
  const east = -cd * Math.sin(h);
  const north = sd * cp - cd * sp * ch;
  const up = sp * sd + cp * cd * ch;
  return opts && opts.ahead === 'south' ? [-east, up, north] : [east, up, -north];
}

export function altAz(ra, dec, ms, lat, lon) {
  const [east, up, minusNorth] = horizonVector(ra, dec, ms, lat, lon);
  return { alt: Math.asin(clamp(up, -1, 1)) / RAD, az: mod360(Math.atan2(east, -minusNorth) / RAD) };
}

// ---------------------------------------------------------------- the whole sphere

export function equatorialVector(ra, dec) {
  const c = Math.cos(dec * RAD);
  return [c * Math.cos(ra * RAD), c * Math.sin(ra * RAD), Math.sin(dec * RAD)];
}

// horizonVector written as a matrix on equatorialVector. With L the local sidereal time and
// p the latitude, expanding cos(L - ra) and sin(L - ra) in Ricky's three lines gives
//   east  = -sinL x + cosL y
//   up    =  cosp cosL x + cosp sinL y + sinp z
//   north = -sinp cosL x - sinp sinL y + cosp z
// The rows (east, up, -north) are orthonormal with determinant +1, so it is a pure rotation:
// the dome sets it on one object and never touches 8,920 positions again.
export function skyRotation(ms, lat, lon, opts) {
  const L = lst(ms, lon);
  const cl = Math.cos(L * RAD), sl = Math.sin(L * RAD), cp = Math.cos(lat * RAD), sp = Math.sin(lat * RAD);
  const s = opts && opts.ahead === 'south' ? -1 : 1;
  const matrix = [
    -sl * s, cl * s, 0,
    cp * cl, cp * sl, sp,
    sp * cl * s, sp * sl * s, -cp * s,
  ];
  return { matrix, quaternion: quaternionOf(matrix), lst: L };
}

export function rotate(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// Rotation matrix -> [x, y, z, w]. The branch on the largest diagonal term keeps the
// division away from zero for every turn, including a half turn.
function quaternionOf(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const tr = a + e + i;
  if (tr > 0) { const s = 2 * Math.sqrt(tr + 1); return [(h - f) / s, (c - g) / s, (d - b) / s, s / 4]; }
  if (a > e && a > i) { const s = 2 * Math.sqrt(1 + a - e - i); return [s / 4, (b + d) / s, (c + g) / s, (h - f) / s]; }
  if (e > i) { const s = 2 * Math.sqrt(1 + e - a - i); return [(b + d) / s, s / 4, (f + h) / s, (c - g) / s]; }
  const s = 2 * Math.sqrt(1 + i - a - e);
  return [(c + g) / s, (f + h) / s, s / 4, (d - b) / s];
}

// The seasons' constellations cross the southern sky for a northern watcher and the
// northern sky for a southern one, so the dome faces that way (spec: the equator counts
// as north).
export function aheadFor(lat) { return lat >= 0 ? 'south' : 'north'; }

// ---------------------------------------------------------------- the Sun, and daytime

// The Astronomical Almanac's low-precision Sun (its "Low precision formulas for the Sun's
// coordinates" page). The Almanac gives it as good to 0.01 degrees from 1950 to 2050; the
// check holds it to 0.02 degrees against a worked example from Meeus and to the dates of the
// equinoxes and solstices. Sunrise and twilight times from it are right to well under a
// minute, before refraction (which lifts the Sun about 0.6 degrees at the horizon; it does
// not matter for the -6 and -12 degree lines used below).
export function sunPosition(ms) {
  const D = daysSinceJ2000(ms);
  const g = (357.528 + 0.9856003 * D) * RAD;
  const lambda = (280.460 + 0.9856474 * D + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * D) * RAD;
  return {
    ra: mod360(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / RAD),
    dec: Math.asin(Math.sin(eps) * Math.sin(lambda)) / RAD,
  };
}

export function sunAltitude(ms, lat, lon) {
  const s = sunPosition(ms);
  return altAz(s.ra, s.dec, ms, lat, lon).alt;
}

export const MOMENT = Object.freeze({ darkNowAlt: -6, nightAlt: -12, stepMs: 600000, steps: 144 });

// Which moment the dome draws (living-sky spec, section 1):
//   'now'       the Sun is more than 6 degrees down: draw this very moment
//   'tonight'   otherwise the first moment in the next 24 hours it is more than 12 down
//               (the caption says "your sky tonight at 19:40")
//   'no-night'  it never gets that far down (far north in summer): the Sun's lowest moment
// `sunAlt` is the Sun's altitude at tRef. tRef is exact to the 10-minute step.
export function skyMoment(nowMs, lat, lon) {
  const now = sunAltitude(nowMs, lat, lon);
  if (now < MOMENT.darkNowAlt) return { mode: 'now', tRef: nowMs, sunAlt: now };
  let low = { tRef: nowMs, sunAlt: now };
  for (let k = 1; k <= MOMENT.steps; k += 1) {
    const t = nowMs + k * MOMENT.stepMs;
    const alt = sunAltitude(t, lat, lon);
    if (alt < MOMENT.nightAlt) return { mode: 'tonight', tRef: t, sunAlt: alt };
    if (alt < low.sunAlt) low = { tRef: t, sunAlt: alt };
  }
  return { mode: 'no-night', ...low };
}

// ---------------------------------------------------------------- cities and local time

// Coordinates are city centres to 0.01 degrees (a kilometre: the sky does not change over
// that). Order matters twice: it is the picker's order (west to east within a region), and
// where two cities share a time zone the FIRST is the guess for that zone.
const city = (id, name, lat, lon, tz) => Object.freeze({ id, name, lat, lon, tz });
export const CITIES = Object.freeze([
  city('reykjavik', 'Reykjavík', 64.15, -21.94, 'Atlantic/Reykjavik'),
  city('lisbon', 'Lisbon', 38.72, -9.14, 'Europe/Lisbon'),
  city('dublin', 'Dublin', 53.35, -6.26, 'Europe/Dublin'),
  city('london', 'London', 51.51, -0.13, 'Europe/London'),
  city('madrid', 'Madrid', 40.42, -3.70, 'Europe/Madrid'),
  city('paris', 'Paris', 48.86, 2.35, 'Europe/Paris'),
  city('amsterdam', 'Amsterdam', 52.37, 4.90, 'Europe/Amsterdam'),
  city('berlin', 'Berlin', 52.52, 13.40, 'Europe/Berlin'),
  city('rome', 'Rome', 41.90, 12.50, 'Europe/Rome'),
  city('stockholm', 'Stockholm', 59.33, 18.07, 'Europe/Stockholm'),
  city('athens', 'Athens', 37.98, 23.73, 'Europe/Athens'),
  city('istanbul', 'Istanbul', 41.01, 28.98, 'Europe/Istanbul'),
  city('moscow', 'Moscow', 55.76, 37.62, 'Europe/Moscow'),
  city('cairo', 'Cairo', 30.04, 31.24, 'Africa/Cairo'),
  city('lagos', 'Lagos', 6.52, 3.38, 'Africa/Lagos'),
  city('nairobi', 'Nairobi', -1.29, 36.82, 'Africa/Nairobi'),
  city('johannesburg', 'Johannesburg', -26.20, 28.05, 'Africa/Johannesburg'),
  city('dubai', 'Dubai', 25.20, 55.27, 'Asia/Dubai'),
  city('karachi', 'Karachi', 24.86, 67.00, 'Asia/Karachi'),
  city('delhi', 'Delhi', 28.61, 77.21, 'Asia/Kolkata'),
  city('mumbai', 'Mumbai', 19.08, 72.88, 'Asia/Kolkata'),
  city('dhaka', 'Dhaka', 23.81, 90.41, 'Asia/Dhaka'),
  city('bangkok', 'Bangkok', 13.76, 100.50, 'Asia/Bangkok'),
  city('singapore', 'Singapore', 1.35, 103.82, 'Asia/Singapore'),
  city('jakarta', 'Jakarta', -6.21, 106.85, 'Asia/Jakarta'),
  city('hong-kong', 'Hong Kong', 22.32, 114.17, 'Asia/Hong_Kong'),
  city('beijing', 'Beijing', 39.90, 116.41, 'Asia/Shanghai'),
  city('shanghai', 'Shanghai', 31.23, 121.47, 'Asia/Shanghai'),
  city('seoul', 'Seoul', 37.57, 126.98, 'Asia/Seoul'),
  city('tokyo', 'Tokyo', 35.68, 139.65, 'Asia/Tokyo'),
  city('perth', 'Perth', -31.95, 115.86, 'Australia/Perth'),
  city('melbourne', 'Melbourne', -37.81, 144.96, 'Australia/Melbourne'),
  city('sydney', 'Sydney', -33.87, 151.21, 'Australia/Sydney'),
  city('auckland', 'Auckland', -36.85, 174.76, 'Pacific/Auckland'),
  city('honolulu', 'Honolulu', 21.31, -157.86, 'Pacific/Honolulu'),
  city('anchorage', 'Anchorage', 61.22, -149.90, 'America/Anchorage'),
  city('vancouver', 'Vancouver', 49.28, -123.12, 'America/Vancouver'),
  city('los-angeles', 'Los Angeles', 34.05, -118.24, 'America/Los_Angeles'),
  city('denver', 'Denver', 39.74, -104.99, 'America/Denver'),
  city('mexico-city', 'Mexico City', 19.43, -99.13, 'America/Mexico_City'),
  city('chicago', 'Chicago', 41.88, -87.63, 'America/Chicago'),
  city('toronto', 'Toronto', 43.65, -79.38, 'America/Toronto'),
  city('new-york', 'New York', 40.71, -74.01, 'America/New_York'),
  city('bogota', 'Bogotá', 4.71, -74.07, 'America/Bogota'),
  city('lima', 'Lima', -12.05, -77.04, 'America/Lima'),
  city('santiago', 'Santiago', -33.45, -70.67, 'America/Santiago'),
  city('buenos-aires', 'Buenos Aires', -34.60, -58.38, 'America/Argentina/Buenos_Aires'),
  city('sao-paulo', 'São Paulo', -23.55, -46.63, 'America/Sao_Paulo'),
]);

// Older names that browsers still report for the same zone.
const TZ_ALIASES = Object.freeze({
  'Asia/Calcutta': 'Asia/Kolkata',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'Asia/Saigon': 'Asia/Bangkok',
  'Asia/Ho_Chi_Minh': 'Asia/Bangkok',
  'Europe/Belfast': 'Europe/London',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Harbin': 'Asia/Shanghai',
  'Australia/Canberra': 'Australia/Sydney',
  'Australia/NSW': 'Australia/Sydney',
  'Australia/Victoria': 'Australia/Melbourne',
  'US/Eastern': 'America/New_York',
  'US/Central': 'America/Chicago',
  'US/Mountain': 'America/Denver',
  'US/Pacific': 'America/Los_Angeles',
  'US/Hawaii': 'Pacific/Honolulu',
  'US/Alaska': 'America/Anchorage',
  'GB': 'Europe/London',
  'Japan': 'Asia/Tokyo',
  'Singapore': 'Asia/Singapore',
});

export function cityById(id) { return CITIES.find((c) => c.id === id) || null; }

// The sky shown when nothing better is known (spec 4.1: "Showing the sky from 40° north").
export const FALLBACK_LAT = 40;

// The owner's likely city, from the computer's time zone alone: nothing is sent anywhere
// and no permission is asked. `known: false` means the zone is not in the table; the place
// is then 40 degrees north at the longitude the zone's clock implies, so the Sun at least
// sets at about the right time on the clock.
export function guessCity(timeZone) {
  let tz = timeZone;
  if (tz === undefined) {
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = ''; }
  }
  tz = TZ_ALIASES[tz] || tz || '';
  const found = CITIES.find((c) => c.tz === tz);
  if (found) return { city: found, lat: found.lat, lon: found.lon, tz: found.tz, guessed: true, known: true };
  // January, so daylight saving does not push a northern zone an extra 15 degrees east.
  const lon = clamp(tzOffsetMinutes(Date.UTC(2026, 0, 15), tz) / 4, -180, 180);
  return { city: null, lat: FALLBACK_LAT, lon, tz: tz || 'UTC', guessed: true, known: false };
}

const formatters = new Map();
function formatterFor(tz) {
  if (!formatters.has(tz)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch (e) { f = null; } // an unknown zone: treated as UTC below
    formatters.set(tz, f);
  }
  return formatters.get(tz);
}

// The wall clock in a zone: { y, m (1..12), d, h, min }.
export function localParts(ms, tz) {
  const f = formatterFor(tz);
  if (!f) { const u = new Date(ms); return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), min: u.getUTCMinutes() }; }
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute };
}

// Minutes the zone's clock is ahead of UTC at that moment (London in summer: 60).
export function tzOffsetMinutes(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

// A wall-clock time in a zone -> Unix ms. Two passes, because the offset at the first guess
// can be the wrong side of a daylight-saving change.
export function localToUtc({ y, m, d, h = 0, min = 0 }, tz) {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const first = wall - tzOffsetMinutes(wall, tz) * 60000;
  return wall - tzOffsetMinutes(first, tz) * 60000;
}

// Before this hour the owner is still in last night, so "tonight" is the evening that has
// already begun (1 am on the 13th belongs to the night of the 12th).
export const NIGHT_ROLLOVER_HOUR = 4;

// 21:00 on the evening `ms` belongs to, as Unix ms.
export function ninePmLocal(ms, tz) {
  const p = localParts(ms - NIGHT_ROLLOVER_HOUR * 3600000, tz);
  return localToUtc({ y: p.y, m: p.m, d: p.d, h: 21, min: 0 }, tz);
}

// ---------------------------------------------------------------- the starter twelve

// Ricky's starter list: the month each figure is best placed at about 9 pm from mid-northern
// latitudes. Each star is [hip, raDeg, decDeg]. The positions are copied from
// vendor/sky-data/stars.json so that "tonight's constellation" needs no 300 kB file (Home
// can name it before, or without, the dome); the check ties every row back to that file.
// Star order is Ricky's list, not a singing order: js/app/figures.js owns the sung path.
// What his list did not say, found while resolving it against the catalogue:
//   - Auriga's Elnath is catalogued in Taurus (Beta Tauri), shared by the two figures.
//   - The Square's Alpheratz is catalogued in Andromeda.
//   - "Gienah" in HYG is Gamma Corvi; the Cygnus star is there as Aljanah (Epsilon Cygni).
//   - Delta and Zeta Lyrae are doubles; the brighter of each is used (Delta-2, Zeta-1).
const fig = (id, name, con, month, stars) => Object.freeze({ id, name, con, month, stars: Object.freeze(stars.map((s) => Object.freeze(s))) });
export const STARTER = Object.freeze([
  fig('orion', 'Orion', 'Ori', 1, [[27989, 88.793, 7.407], [25336, 81.283, 6.35], [25930, 83.002, -0.299], [26311, 84.053, -1.202], [26727, 85.19, -1.943], [27366, 86.939, -9.67], [24436, 78.634, -8.202]]),
  fig('auriga', 'Auriga', 'Aur', 2, [[24608, 79.172, 45.998], [28360, 89.882, 44.947], [28380, 89.93, 37.213], [25428, 81.573, 28.607], [23015, 74.248, 33.166]]),
  fig('gemini', 'Gemini', 'Gem', 3, [[36850, 113.65, 31.888], [37826, 116.329, 28.026], [31681, 99.428, 16.399]]),
  fig('sickle', 'Leo’s Sickle', 'Leo', 4, [[49669, 152.093, 11.967], [49583, 151.833, 16.763], [50583, 154.993, 19.841], [50335, 154.173, 23.417], [48455, 148.191, 26.007], [47908, 146.463, 23.774]]),
  fig('big-dipper', 'Big Dipper', 'UMa', 5, [[54061, 165.932, 61.751], [53910, 165.46, 56.382], [58001, 178.458, 53.695], [59774, 183.856, 57.033], [62956, 193.507, 55.96], [65378, 200.981, 54.925], [67301, 206.885, 49.313]]),
  fig('bootes', 'Boötes', 'Boo', 6, [[69673, 213.915, 19.182], [72105, 221.247, 27.074], [71075, 218.02, 38.308], [73555, 225.487, 40.391], [74666, 228.876, 33.315]]),
  fig('corona-borealis', 'Corona Borealis', 'CrB', 7, [[76127, 233.232, 31.359], [75695, 231.957, 29.106], [76267, 233.672, 26.715], [76952, 235.686, 26.296], [77512, 237.399, 26.068], [78159, 239.397, 26.878], [78493, 240.361, 29.851]]),
  fig('lyra', 'Lyra', 'Lyr', 8, [[91262, 279.235, 38.784], [92420, 282.52, 33.363], [93194, 284.736, 32.69], [92791, 283.626, 36.899], [91971, 281.193, 37.605]]),
  fig('cygnus', 'Cygnus', 'Cyg', 9, [[102098, 310.358, 45.28], [100453, 305.557, 40.257], [95947, 292.68, 27.96], [102488, 311.553, 33.97], [97165, 296.244, 45.131]]),
  fig('pegasus-square', 'Pegasus Square', 'Peg', 10, [[113963, 346.19, 15.205], [113881, 345.944, 28.083], [677, 2.097, 29.09], [1067, 3.309, 15.184]]),
  fig('cassiopeia', 'Cassiopeia', 'Cas', 11, [[746, 2.293, 59.15], [3179, 10.127, 56.537], [4427, 14.177, 60.717], [6686, 21.453, 60.235], [8886, 28.599, 63.67]]),
  fig('aries', 'Aries', 'Ari', 12, [[9884, 31.793, 23.462], [8903, 28.66, 20.808], [8832, 28.383, 19.294]]),
]);

// The middle of a set of sky positions: the direction of the summed unit vectors. (Averaging
// right ascensions breaks across 0 / 360, which the Pegasus Square straddles.)
export function centreOf(positions) {
  let x = 0, y = 0, z = 0;
  for (const [ra, dec] of positions) { const v = equatorialVector(ra, dec); x += v[0]; y += v[1]; z += v[2]; }
  const r = Math.hypot(x, y, z) || 1;
  return { ra: mod360(Math.atan2(y, x) / RAD), dec: Math.asin(clamp(z / r, -1, 1)) / RAD };
}

const STARTER_CENTRES = STARTER.map((f) => centreOf(f.stars.map((s) => [s[1], s[2]])));

// A figure is "up" for singing when every one of its stars clears the murk near the horizon
// (spec 3.2 rule 1).
export const UP_ALT = 15;

// Where each starter figure is at one moment: { figure, alt, az, hourAngle, lowest, up }.
// `alt` / `az` are the figure's centre; `lowest` is its lowest star's altitude.
export function starterAt(ms, lat, lon) {
  return STARTER.map((figure, k) => {
    const c = STARTER_CENTRES[k];
    const { alt, az } = altAz(c.ra, c.dec, ms, lat, lon);
    let lowest = 90;
    for (const s of figure.stars) lowest = Math.min(lowest, altAz(s[1], s[2], ms, lat, lon).alt);
    return { figure, alt, az, hourAngle: hourAngle(c.ra, ms, lon), lowest, up: lowest >= UP_ALT };
  });
}

// "Best placed" is the astronomer's phrase for nearest the meridian: the figure is then as
// high as it ever gets from that place. Picking the highest instead would give a northern
// city the same two or three high-declination figures (the Dipper, Cassiopeia, Cygnus) for
// most of the year; nearest-the-meridian walks through all twelve as the months turn.
//   1. among the figures that are `up`: the smallest |hour angle|   (how: 'best-placed')
//   2. none up: the highest centre, if above the horizon            (how: 'highest')
//   3. nothing above the horizon: null
export function pickBestPlaced(rows) {
  const up = rows.filter((r) => r.up);
  if (up.length) return { ...up.reduce((a, b) => (Math.abs(b.hourAngle) < Math.abs(a.hourAngle) ? b : a)), how: 'best-placed' };
  const high = rows.reduce((a, b) => (b.alt > a.alt ? b : a));
  return high.alt > 0 ? { ...high, how: 'highest' } : null;
}

// Tonight's constellation for a place { lat, lon, tz } (a CITIES row or guessCity's answer),
// judged at 9 pm local time on the evening `ms` belongs to, so the answer is the same all
// day. `figure` is null when none of the twelve is above the horizon then (far south).
// `all` is every starter row at that moment, for the "Up tonight" / "Below your horizon"
// lines on the cards.
export function tonightsConstellation(ms, place) {
  const at = ninePmLocal(ms, place.tz);
  const all = starterAt(at, place.lat, place.lon);
  const best = pickBestPlaced(all);
  if (!best) return { figure: null, at, alt: null, az: null, hourAngle: null, how: null, all };
  return { figure: best.figure, at, alt: best.alt, az: best.az, hourAngle: best.hourAngle, how: best.how, all };
}

// ---------------------------------------------------------------- the data files

// Wraps the two files from vendor/sky-data/ (already parsed) for the functions below and for
// the dome. Nothing is copied: `stars` is the file's own row list.
//   stars      [[raDeg, decDeg, mag, colourIndex|null, hip], ...] brightest first
//   names      Map starIndex -> proper name
//   indexOfHip Map hip -> starIndex
//   figures    [{ id, name, english, lines, thinLines, stars: [starIndex...], centre: { ra, dec } }]
export function makeSky(starsJson, figuresJson) {
  if (!starsJson || !Array.isArray(starsJson.stars) || !figuresJson || !Array.isArray(figuresJson.figures)) {
    throw new Error('makeSky: expected the parsed vendor/sky-data/stars.json and figures.json');
  }
  const stars = starsJson.stars;
  const indexOfHip = new Map();
  stars.forEach((s, i) => { if (s[4]) indexOfHip.set(s[4], i); });
  const figures = figuresJson.figures.map((f) => {
    const thinLines = f.thinLines || [];
    const own = [...new Set([...f.lines, ...thinLines].flat())];
    for (const i of own) {
      if (!Number.isInteger(i) || i < 0 || i >= stars.length) throw new Error(`makeSky: figure ${f.id} points at star ${i}, which is not in stars.json`);
    }
    return { id: f.id, name: f.name, english: f.english, lines: f.lines, thinLines, stars: own, centre: centreOf(own.map((i) => stars[i])) };
  });
  return { stars, names: new Map(starsJson.names || []), figures, indexOfHip };
}

// The constellations above the horizon at a moment, highest first. One row each:
//   { id, name, english, alt, az, top, bottom, fractionUp }
// `alt` / `az` are the figure's centre; `top` and `bottom` are its highest and lowest stars;
// `fractionUp` is the share of its stars above `minAlt`. A figure is listed when its centre
// OR any of its stars is above `minAlt` (default 0, the horizon), so a big one that is half
// risen (Hydra, Eridanus) is not missed; pass `whole: true` for only those entirely up.
export function constellationsUp(sky, ms, lat, lon, opts = {}) {
  const minAlt = opts.minAlt === undefined ? 0 : opts.minAlt;
  const out = [];
  for (const f of sky.figures) {
    const { alt, az } = altAz(f.centre.ra, f.centre.dec, ms, lat, lon);
    let top = -90, bottom = 90, n = 0;
    for (const i of f.stars) {
      const a = altAz(sky.stars[i][0], sky.stars[i][1], ms, lat, lon).alt;
      if (a > top) top = a;
      if (a < bottom) bottom = a;
      if (a > minAlt) n += 1;
    }
    const fractionUp = f.stars.length ? n / f.stars.length : 0;
    if (opts.whole ? fractionUp < 1 : (alt <= minAlt && n === 0)) continue;
    out.push({ id: f.id, name: f.name, english: f.english, alt, az, top, bottom, fractionUp });
  }
  return out.sort((a, b) => b.alt - a.alt);
}
