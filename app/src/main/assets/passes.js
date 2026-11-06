'use strict';

// Pass predictions: when a satellite rises over the user's horizon, how high it climbs, where it
// sets, and whether it can be seen by eye (lit by the Sun while the user's sky is dark). Also when it
// goes into and out of Earth's shadow, and for geostationary satellites, when the Sun passes behind
// them (sun outages).
//
// Visible ISS passes and starred satellites' passes also go to MainActivity (Android.setPassAlerts)
// for pass notifications.

/** How far ahead passes are predicted. */
const PASS_DAYS = 3;
/** Passes that peak lower than this are skipped: trees and buildings hide them. */
const MIN_PASS_ELEVATION = 10;
/** The sky is dark enough to see satellites once the Sun is this far below the horizon. */
const DARK_SUN_ELEVATION = -6;
const MAX_PASSES = 20;
const VISIBILITY_STEP_MS = 10_000;
/** Visible ISS passes to hand to MainActivity for notifications, and how often to refresh them. */
const ALERT_SATELLITE_ID = 25544;
const ALERT_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Starred satellites get alerts for their passes, up to this many satellites. */
const MAX_FAVOURITE_ALERTS = 10;

/** Azimuth and elevation (degrees) of the satellite from `observer`, or null if SGP4 fails. */
function lookAt(satrec, date, observer) {
    const pv = propagate(satrec, date);
    if (!pv) return null;
    const gmst = satellite.gstime(date);
    const look = satellite.ecfToLookAngles(observer, satellite.eciToEcf(pv.position, gmst));
    return { az: look.azimuth * 180 / Math.PI, el: look.elevation * 180 / Math.PI, eci: pv.position, gmst };
}

/**
 * Where to point a dish or antenna at a satellite from (lat, lon), now: azimuth and elevation
 * (degrees), range (km), and skew, or null if SGP4 fails.
 *
 * Skew is how far the satellite's own "vertical" (Earth's axis, which a geostationary satellite's
 * linear polarisation is lined up with) looks turned from the observer's vertical, seen looking at
 * the satellite: positive counter-clockwise. That is the usual LNB skew for a geostationary satellite
 * (positive for one east of you, in the northern hemisphere); for others it holds only at that moment.
 */
function pointingAt(satrec, lat, lon, date = new Date(simNow())) {
    const pv = propagate(satrec, date);
    if (!pv) return null;
    const look = satellite.ecfToLookAngles(observerAt(lat, lon), satellite.eciToEcf(pv.position, satellite.gstime(date)));
    const az = look.azimuth, el = look.elevation, phi = lat * Math.PI / 180;
    // In east, north, up: the line of sight, the observer's up, and Earth's axis.
    const d = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
    const across = v => { const k = dot(v, d); return v.map((c, i) => c - k * d[i]); };
    const up = across([0, 0, 1]), axis = across([0, Math.cos(phi), Math.sin(phi)]);
    // Turning about the line of sight looks clockwise from behind, so the sign flips.
    let skew = -Math.atan2(dot(d, cross(up, axis)), dot(up, axis)) * 180 / Math.PI;
    // Polarisation is a line, not an arrow: south of the equator the axis points away from "up".
    if (skew > 90) skew -= 180; else if (skew <= -90) skew += 180;
    return { az: az * 180 / Math.PI, el: el * 180 / Math.PI, rangeKm: look.rangeSat, skew };
}

function observerAt(lat, lon) {
    return { latitude: lat * Math.PI / 180, longitude: lon * Math.PI / 180, height: 0 };
}

/**
 * Upcoming passes of `sat` over (lat, lon): { rise, set, peak (Dates), riseAz, peakAz, setAz,
 * peakEl, visible }, soonest first. Instead { alwaysUp: { az, el } } for a satellite that never sets
 * here (geostationary ones in view), or [] for one that never rises.
 */
function predictPasses(sat, lat, lon, start = simNow(), maxPasses = MAX_PASSES) {
    const observer = observerAt(lat, lon);
    const satrec = sat.satrec;
    const periodS = 2 * Math.PI / satrec.no * 60;
    // Fine enough not to step over a short low-orbit pass; coarser for slow, high orbits.
    const stepS = Math.min(60, Math.max(15, periodS / 300));
    const end = start + PASS_DAYS * 86_400_000;
    const el = t => lookAt(satrec, new Date(t), observer)?.el ?? -90;

    /** The moment el crosses 0 between a (below or above) and b (the other), to about a second. */
    const crossing = (a, b) => {
        const rising = el(a) < 0;
        for (let i = 0; i < 12 && b - a > 1000; i++) {
            const mid = (a + b) / 2;
            if ((el(mid) < 0) === rising) a = mid; else b = mid;
        }
        return (a + b) / 2;
    };

    const passes = [];
    let t = start;
    let previous = el(t);
    let riseAt = previous > 0 ? start : null;
    let sawSet = false;
    while ((t += stepS * 1000) <= end && passes.length < maxPasses) {
        const current = el(t);
        if (previous <= 0 && current > 0) {
            riseAt = crossing(t - stepS * 1000, t);
        } else if (previous > 0 && current <= 0 && riseAt !== null) {
            sawSet = true;
            const pass = describePass(satrec, observer, lat, lon, riseAt, crossing(t - stepS * 1000, t));
            if (pass && pass.peakEl >= MIN_PASS_ELEVATION) passes.push(pass);
            riseAt = null;
        }
        previous = current;
    }
    if (!passes.length && !sawSet && riseAt === start) {
        const look = lookAt(satrec, new Date(start), observer);
        if (look) return { alwaysUp: { az: look.az, el: look.el } };
    }
    return passes;
}

/**
 * The details of one pass, or null if SGP4 fails on it (an orbit decaying as it re-enters can stop
 * propagating partway through).
 */
function describePass(satrec, observer, lat, lon, rise, set) {
    // The peak, by golden-section search between rise and set (elevation has one maximum).
    let a = rise, b = set;
    const ratio = (Math.sqrt(5) - 1) / 2;
    const el = t => lookAt(satrec, new Date(t), observer)?.el ?? -90;
    for (let i = 0; i < 30 && b - a > 1000; i++) {
        const c = b - ratio * (b - a), d = a + ratio * (b - a);
        if (el(c) > el(d)) b = d; else a = c;
    }
    const peak = (a + b) / 2;
    const peakLook = lookAt(satrec, new Date(peak), observer);
    const riseLook = lookAt(satrec, new Date(rise), observer);
    const setLook = lookAt(satrec, new Date(set), observer);
    if (!peakLook || !riseLook || !setLook) return null;

    // The part that can be seen by eye: the satellite in sunlight while the user's sky is dark. It is
    // often only part of the pass, e.g. a satellite climbing out of Earth's shadow low in the east
    // before dawn, so it gets its own times and height.
    let seen = null;
    for (let t = rise; t <= set; t += VISIBILITY_STEP_MS) {
        const date = new Date(t);
        const sunNow = sunDirection(date);
        const look = lookAt(satrec, date, observer);
        if (!look) continue;
        const p = geodetic(look.eci, look.gmst);
        if (sunElevation(sunNow, lat, lon) >= DARK_SUN_ELEVATION || inShadow(toGlobe(p.lat, p.lon, p.altKm), sunNow)) continue;
        seen ??= { start: t, startAz: look.az, peakEl: -90 };
        seen.end = t;
        seen.endAz = look.az;
        seen.peakEl = Math.max(seen.peakEl, look.el);
    }
    // Lit only while too low to see over trees and buildings counts as not visible.
    const visible = !!seen && seen.peakEl >= MIN_PASS_ELEVATION;
    return {
        rise: new Date(rise), set: new Date(set), peak: new Date(peak),
        riseAz: riseLook.az,
        setAz: setLook.az,
        peakAz: peakLook.az,
        peakEl: peakLook.el,
        visible,
        // When visible: { start, end (Dates), startAz, endAz, peakEl } of the part that can be seen.
        seen: visible ? { ...seen, start: new Date(seen.start), end: new Date(seen.end) } : null,
    };
}

/** Compass point for an azimuth in degrees, e.g. 315 -> "NW". */
function compass(az) {
    const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return points[Math.round(((az % 360) + 360) % 360 / 22.5) % 16];
}

// ---- Earth's shadow ----

/**
 * When the satellite next goes into and comes out of Earth's shadow, from `from` (ms): { shadowed
 * (now), changes: [times of the next two changes], searchedTo }. Over a couple of its orbits, at
 * most two days: geostationary satellites only see eclipses for a few weeks around each equinox.
 */
function shadowChanges(sat, from) {
    const periodMs = 2 * Math.PI / sat.satrec.no * 60_000;
    const step = Math.min(Math.max(periodMs / 300, 10_000), 120_000);
    const end = from + Math.min(Math.max(2.2 * periodMs, 3 * 3_600_000), 48 * 3_600_000);
    const shadowed = t => {
        const date = new Date(t);
        const s = satelliteGlobe(sat.satrec, date);
        return s ? inShadow(s, sunDirection(date)) : null;
    };
    const start = shadowed(from);
    if (start === null) return null;
    const changes = [];
    let t0 = from, s0 = start;
    for (let t1 = from + step; t1 <= end && changes.length < 2; t1 += step) {
        const s1 = shadowed(t1);
        if (s1 === null) break;
        if (s1 !== s0) {
            let a = t0, b = t1;
            while (b - a > 1000) {
                const mid = (a + b) / 2;
                if (shadowed(mid) === s0) a = mid; else b = mid;
            }
            changes.push((a + b) / 2);
        }
        t0 = t1;
        s0 = s1;
    }
    return { shadowed: start, changes, searchedTo: end };
}

// ---- Sun outages (geostationary satellites) ----
//
// A geostationary satellite stays put in the user's sky, and on a few days around each equinox the
// Sun passes behind it. A dish aimed at the satellite is then aimed at the Sun too, whose noise
// drowns the signal for some minutes each day: a sun outage. How long depends on the dish's beam:
// the bigger the dish and the higher the frequency, the narrower the beam and the shorter the outage.
//
// Propagating a geostationary satellite's elements a year ahead drifts badly (they leave out the
// operator's station-keeping), so the satellite is taken to stay in its slot: its path across the
// sky over one sidereal day from now, repeated. Station-kept, that is a point; an old inclined
// satellite traces a small figure 8 each day.

const OUTAGE_DAYS = 365;
const OUTAGE_STEP_MS = 10 * 60_000;
const SIDEREAL_DAY_MS = 86_164_091;
const SUN_RADIUS_DEGREES = 0.2666;
const MOON_RADIUS_KM = 1737.4;
/** Dish diameters offered (m), and the bands' wavelengths (m): Ku about 11.7 GHz, C about 4 GHz. */
const DISH_SIZES_M = [0.6, 0.9, 1.2, 2.4];
const BAND_WAVELENGTHS_M = { Ku: 0.0256, C: 0.075 };

/** Geostationary or geosynchronous: once round a sidereal day, near circular. */
function isGeostationary(satrec) {
    return Math.abs(2 * Math.PI / satrec.no - 1436.1) < 30 && satrec.ecco < 0.1;
}

/** A dish's half-power beamwidth in degrees: about 70 wavelengths over its diameter. */
function dishBeamwidth(diameterM, band) {
    return 70 * BAND_WAVELENGTHS_M[band] / diameterM;
}

/** How far off the satellite the Sun's middle can be and still cause an outage (degrees). */
function outageAngle(diameterM, band) {
    return dishBeamwidth(diameterM, band) / 2 + SUN_RADIUS_DEGREES;
}

function unit(v) {
    const length = Math.hypot(...v);
    return v.map(c => c / length);
}

/** Globe-space position of the satellite at `date`, or null if SGP4 fails. */
function satelliteGlobe(satrec, date) {
    const pv = propagate(satrec, date);
    if (!pv) return null;
    const g = geodetic(pv.position, satellite.gstime(date));
    return toGlobe(g.lat, g.lon, g.altKm);
}

/** The Sun (a direction, at infinity) or the Moon (a position) at `date`, in globe space. */
function transitSource(kind, date) {
    return kind === 'sun' ? { dir: sunDirection(date) } : { pos: moonAt(date).globe };
}

/** The source's angular radius in radians, seen from globe-space point p. */
function sourceRadius(source, p) {
    if (source.dir) return SUN_RADIUS_DEGREES * Math.PI / 180;
    return Math.asin(MOON_RADIUS_KM / (Math.hypot(...source.pos.map((c, i) => c - p[i])) * EARTH_RADIUS_KM));
}

/** Angle in degrees between two directions. */
function angleBetween(a, b) {
    return Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180 / Math.PI;
}

/**
 * Prepares a sun outage search for a geostationary satellite seen from (lat, lon), with its path
 * across the sky taken from `from` (ms). Returns { neverUp } when it is always below the horizon,
 * else { search(start, end, angle) } giving the days between start and end (ms) when the Sun's
 * middle comes within `angle` degrees of it: [{ t (closest), separation (degrees), sunElevation,
 * behind: [start, end] or null (the Sun's disc behind the satellite), outage: [start, end] }].
 */
function prepareSunOutages(sat, lat, lon, from) {
    // The satellite's direction over one sidereal day, a minute apart.
    const path = [];
    for (let m = 0; m <= Math.ceil(SIDEREAL_DAY_MS / 60_000); m++) {
        const s = satelliteGlobe(sat.satrec, new Date(from + m * 60_000));
        path.push(s ? skyDirection(s, lat, lon) : null);
    }
    if (!path.some(d => d && d[2] > 0)) return { neverUp: true };
    const satDir = t => {
        const minutes = (((t - from) % SIDEREAL_DAY_MS) + SIDEREAL_DAY_MS) % SIDEREAL_DAY_MS / 60_000;
        const i = Math.floor(minutes), f = minutes - i;
        const a = path[i], b = path[i + 1] ?? a;
        if (!a || !b) return a ?? b;
        return unit(a.map((c, k) => c + (b[k] - c) * f));
    };
    const sunDir = t => skyDirection(sunDirection(new Date(t)).map(c => c * 1e6), lat, lon);
    const separation = t => {
        const s = satDir(t);
        return s ? angleBetween(s, sunDir(t)) : 180;
    };
    /** When the separation crosses `level`, going from t (inside) in direction `way` (+1 or -1). */
    const edge = (t, level, way) => {
        let inside = t, outside = t;
        for (let i = 0; i < 240; i++) {
            outside += way * 30_000;
            if (separation(outside) > level) break;
            inside = outside;
        }
        while (Math.abs(outside - inside) > 500) {
            const mid = (inside + outside) / 2;
            if (separation(mid) > level) outside = mid; else inside = mid;
        }
        return (inside + outside) / 2;
    };

    function search(start, end, angle) {
        const days = [];
        // The Sun crosses the sky at about 0.25° a minute: a coarse step can land up to 1.25° off its closest.
        let t0 = start, s0 = separation(t0), t1 = start + OUTAGE_STEP_MS, s1 = separation(t1);
        for (let t2 = t1 + OUTAGE_STEP_MS; t2 <= end; t2 += OUTAGE_STEP_MS) {
            const s2 = separation(t2);
            if (s1 <= s0 && s1 <= s2 && s1 < angle + 2) {
                let a = t0, b = t2;
                const g = (Math.sqrt(5) - 1) / 2;
                for (let i = 0; i < 40 && b - a > 200; i++) {
                    const c = b - g * (b - a), d = a + g * (b - a);
                    if (separation(c) < separation(d)) b = d; else a = c;
                }
                const t = (a + b) / 2;
                const closest = separation(t);
                const sunElevation = azEl(sunDir(t))[1];
                if (closest < angle && sunElevation > 0) {
                    days.push({
                        t, separation: closest, sunElevation,
                        behind: closest < SUN_RADIUS_DEGREES ? [edge(t, SUN_RADIUS_DEGREES, -1), edge(t, SUN_RADIUS_DEGREES, 1)] : null,
                        outage: [edge(t, angle, -1), edge(t, angle, 1)],
                    });
                }
            }
            t0 = t1; s0 = s1; t1 = t2; s1 = s2;
        }
        return days;
    }
    return { search };
}

// ---- Pass alerts ----

let alertsAt = 0;
/** Bumped by each refresh, so a slower earlier one that is still running stops. */
let alertsRun = 0;

/**
 * Sends MainActivity the passes it may notify of (which kinds it does is up to the user's settings):
 * visible ISS passes, and every pass of each starred satellite. Always for real time, whatever the
 * globe's clock says. The predictions take a while each, so they run one satellite at a time.
 */
function refreshPassAlerts() {
    if (!window.Android || !here || !satellites.size) return;
    alertsAt = Date.now();
    const run = ++alertsRun;
    const [lon, lat] = here;
    const alerts = [];
    const jobs = [];
    const iss = satellites.get(ALERT_SATELLITE_ID);
    if (iss) jobs.push([iss, 'iss']);
    for (const id of [...favourites].slice(0, MAX_FAVOURITE_ALERTS)) {
        const sat = satellites.get(id);
        if (sat) jobs.push([sat, 'favourite']);
    }
    const next = () => {
        if (run !== alertsRun) return;
        const job = jobs.shift();
        if (!job) {
            window.Android.setPassAlerts(JSON.stringify(alerts));
            return;
        }
        const [sat, kind] = job;
        try {
            const passes = predictPasses(sat, lat, lon, Date.now());
            if (Array.isArray(passes)) {
                if (kind === 'iss') {
                    // Timed and described by the part of the pass that can be seen, not the whole pass.
                    for (const p of passes.filter(p => p.visible)) {
                        alerts.push({
                            kind, name: sat.name, rise: p.seen.start.getTime(), riseDirection: compass(p.seen.startAz),
                            peakElevation: Math.round(p.seen.peakEl), setDirection: compass(p.seen.endAz),
                        });
                    }
                } else {
                    for (const p of passes) {
                        alerts.push({
                            kind, name: sat.name, rise: p.rise.getTime(), riseDirection: compass(p.riseAz),
                            peakElevation: Math.round(p.peakEl), setDirection: compass(p.setAz),
                        });
                    }
                }
            }
        } catch (e) {
            // Skip this one; the rest still get their alerts, and it is tried again next refresh.
            console.error(`Predicting passes of ${sat.name} failed`, e);
        }
        setTimeout(next, 0);
    };
    next();
}

// After the satellites arrive (and with them the ISS), once a location is known, and every few hours.
// A new location (as when one is set by hand) has other passes: the old alerts are for elsewhere.
locationListeners.push(refreshPassAlerts);
satelliteListeners.push(() => {
    if (!alertsAt) refreshPassAlerts();
});
setInterval(() => {
    if (Date.now() - alertsAt > ALERT_REFRESH_MS) refreshPassAlerts();
}, 60_000);
