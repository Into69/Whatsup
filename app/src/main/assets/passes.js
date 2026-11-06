'use strict';

// Pass predictions: when a satellite rises over the user's horizon, how high it climbs, where it
// sets, and whether it can be seen by eye (lit by the Sun while the user's sky is dark).
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
satelliteListeners.push(() => {
    if (!alertsAt) refreshPassAlerts();
});
setInterval(() => {
    if (Date.now() - alertsAt > ALERT_REFRESH_MS) refreshPassAlerts();
}, 60_000);
