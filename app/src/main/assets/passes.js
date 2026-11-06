'use strict';

// Pass predictions: when a satellite rises over the user's horizon, how high it climbs, where it
// sets, and whether it can be seen by eye (lit by the Sun while the user's sky is dark). Also when it
// goes into and out of Earth's shadow, and when it crosses the face of the Sun or Moon (transits).
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

// ---- Sun and Moon transits ----
//
// A satellite crosses the Sun (or Moon) for an observer on the line from the Sun through the
// satellite. Where that line meets the ground races along a narrow track, a few km wide: the
// transit's centre line. Seen from the centre line the satellite crosses the middle of the disc;
// off it, nearer an edge, until it misses.

/** How far ahead transits are searched for, and how close their centre line must come to the user. */
const TRANSIT_DAYS = 7;
const TRANSIT_SEARCH_KM = 150;
const TRANSIT_STEP_MS = 10_000;
/** Below this the Sun or Moon is too low, dim and blurred to watch a transit against. */
const TRANSIT_MIN_ELEVATION = 5;
/** Seconds either side of the transit for which its track is drawn. */
const TRANSIT_PATH_S = 25;
const SUN_RADIUS_DEGREES = 0.2666;
const MOON_RADIUS_KM = 1737.4;

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

/** Unit vector from globe-space point p towards the source. */
function towardsSource(source, p) {
    return source.dir ?? unit(source.pos.map((c, i) => c - p[i]));
}

/** The source's angular radius in radians, seen from globe-space point p. */
function sourceRadius(source, p) {
    if (source.dir) return SUN_RADIUS_DEGREES * Math.PI / 180;
    return Math.asin(MOON_RADIUS_KM / (Math.hypot(...source.pos.map((c, i) => c - p[i])) * EARTH_RADIUS_KM));
}

/** Where the line from the source through the satellite at s meets the ground, or null if it misses. */
function transitPoint(s, source) {
    const d = towardsSource(source, s).map(c => -c);
    const b = dot(s, d), c = dot(s, s) - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const along = -b - Math.sqrt(disc);
    return along > 0 ? s.map((x, i) => x + along * d[i]) : null;
}

/** Great-circle distance in km between two points on (or above) the unit sphere. */
function groundKm(a, b) {
    return Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * EARTH_RADIUS_KM;
}

function globeLatLon(p) {
    const r = Math.hypot(...p);
    return [Math.asin(p[1] / r) * 180 / Math.PI, Math.atan2(p[0], p[2]) * 180 / Math.PI];
}

/** Initial bearing in degrees from globe point a to b. */
function bearing(a, b) {
    const [lat1, lon1] = globeLatLon(a), [lat2, lon2] = globeLatLon(b);
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Angle in degrees between two directions. */
function angleBetween(a, b) {
    return Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180 / Math.PI;
}

/**
 * Transits of `sat` across the Sun and Moon whose centre line passes within TRANSIT_SEARCH_KM of
 * (lat, lon) in the next TRANSIT_DAYS from `from`, soonest first (see describeTransit).
 */
function findTransits(sat, lat, lon, from = simNow()) {
    const observer = toGlobe(lat, lon, 0);
    const end = from + TRANSIT_DAYS * 86_400_000;
    // High orbits' tracks move slowly enough for a coarser step.
    const periodMs = 2 * Math.PI / sat.satrec.no * 60_000;
    const step = periodMs < 3 * 3_600_000 ? TRANSIT_STEP_MS : 6 * TRANSIT_STEP_MS;
    const minElevation = TRANSIT_MIN_ELEVATION * Math.PI / 180;
    const found = [];
    for (const kind of ['sun', 'moon']) {
        /** How far from the user the centre line is at time t, or null when there is none. */
        const offset = t => {
            const date = new Date(t);
            const s = satelliteGlobe(sat.satrec, date);
            const p = s && transitPoint(s, transitSource(kind, date));
            return p ? groundKm(p, observer) : null;
        };
        // The last three samples, for spotting the centre line at its closest to the user.
        let recent = [];
        for (let t = from; t <= end;) {
            const date = new Date(t);
            const pv = propagate(sat.satrec, date);
            if (!pv) {
                recent = [];
                t += step;
                continue;
            }
            // A track is only ever within sight of the satellite (it stands over its own track at
            // TRANSIT_MIN_ELEVATION or more), so while the satellite is far from the user, skip ahead
            // by the least time it could take to come within reach: most of each orbit.
            const { x, y, z } = pv.position;
            const r = Math.hypot(x, y, z);
            const gmst = satellite.gstime(date);
            const below = [-x * Math.sin(gmst) + y * Math.cos(gmst), z, x * Math.cos(gmst) + y * Math.sin(gmst)];
            const away = groundKm(below, observer);
            const reachKm = (Math.acos(Math.min(1, EARTH_RADIUS_KM * Math.cos(minElevation) / r)) - minElevation) * EARTH_RADIUS_KM +
                TRANSIT_SEARCH_KM + 100;
            if (away > reachKm) {
                // Its ground track moves no faster than its speed scaled down to the ground, plus the Earth's turning.
                const v = pv.velocity;
                const groundSpeed = Math.hypot(v.x, v.y, v.z) * EARTH_RADIUS_KM / r + 0.5;
                t += Math.max(step, (away - reachKm) / groundSpeed * 1000);
                recent = [];
                continue;
            }
            recent.push([t, offset(t)]);
            if (recent.length > 3) recent.shift();
            const [[t0, d0] = [], [, d1] = [], [t2, d2] = []] = recent;
            // The centre line at its closest to the user (it sweeps by at several km/s, so a coarse
            // step can land well off it): narrow it down.
            if (recent.length === 3 && d0 !== null && d1 !== null && d2 !== null && d1 <= d0 && d1 <= d2 && d1 < TRANSIT_SEARCH_KM + 1000) {
                let a = t0, b = t2;
                const g = (Math.sqrt(5) - 1) / 2;
                for (let i = 0; i < 40 && b - a > 20; i++) {
                    const c = b - g * (b - a), d = a + g * (b - a);
                    if ((offset(c) ?? Infinity) < (offset(d) ?? Infinity)) b = d; else a = c;
                }
                const transit = describeTransit(sat, kind, (a + b) / 2, observer);
                if (transit && transit.centreKm <= TRANSIT_SEARCH_KM) found.push(transit);
            }
            t += step;
        }
    }
    return found.sort((a, b) => a.t - b.t);
}

/**
 * A transit whose centre line is closest to the observer at t: { kind, t (closest to the disc's middle
 * from here), centreKm and centreBearing (the centre line from here), halfWidthKm (how far either side
 * of it the disc is crossed at all), visibleHere, separation and radius (degrees), durationS, az, el,
 * rangeKm, sourceElevation, centre ([lat, lon]), path (transitPath) }; null if the Sun or Moon is too low.
 */
function describeTransit(sat, kind, t, observer) {
    const date = new Date(t);
    const source = transitSource(kind, date);
    const s = satelliteGlobe(sat.satrec, date);
    const centre = s && transitPoint(s, source);
    if (!centre) return null;
    const toSource = towardsSource(source, observer);
    const sourceElevation = Math.asin(dot(unit(observer), toSource)) * 180 / Math.PI;
    if (sourceElevation < TRANSIT_MIN_ELEVATION) return null;
    const radius = sourceRadius(source, observer) * 180 / Math.PI;
    // From here, when the satellite is closest to the disc's middle, and how close.
    let separation = Infinity, closest = t;
    for (let dt = -3000; dt <= 3000; dt += 25) {
        const at = new Date(t + dt);
        const s2 = satelliteGlobe(sat.satrec, at);
        if (!s2) continue;
        const gap = angleBetween(s2.map((c, i) => c - observer[i]), towardsSource(transitSource(kind, at), observer));
        if (gap < separation) { separation = gap; closest = t + dt; }
    }
    const atClosest = satelliteGlobe(sat.satrec, new Date(closest)) ?? s;
    const rangeKm = Math.hypot(...atClosest.map((c, i) => c - observer[i])) * EARTH_RADIUS_KM;
    // How fast it crosses the sky, for how long it is in front of the disc.
    const before = satelliteGlobe(sat.satrec, new Date(closest - 500)), after = satelliteGlobe(sat.satrec, new Date(closest + 500));
    const rate = before && after ? angleBetween(before.map((c, i) => c - observer[i]), after.map((c, i) => c - observer[i])) : 0;
    const durationS = separation < radius && rate > 0 ? 2 * Math.sqrt(radius * radius - separation * separation) / rate : 0;
    // Across the track: the disc's radius at the satellite's distance, spread out on the ground by the
    // Sun's or Moon's low angle.
    const halfWidthKm = rangeKm * Math.tan(radius * Math.PI / 180) / Math.sin(sourceElevation * Math.PI / 180);
    const [lat, lon] = globeLatLon(observer);
    const [az, el] = azEl(skyDirection(atClosest, lat, lon));
    return {
        kind, t: closest,
        centreKm: groundKm(centre, observer),
        centreBearing: bearing(observer, centre),
        halfWidthKm,
        visibleHere: separation < radius,
        separation, radius, durationS, az, el, rangeKm, sourceElevation,
        centre: globeLatLon(centre),
        path: transitPath(sat, kind, t),
    };
}

/**
 * The transit's track on the ground around t, for drawing: { centre, left, right } lists of globe
 * points: the centre line, and the edges of the band from which the disc is crossed at all.
 */
function transitPath(sat, kind, t) {
    const centre = [], left = [], right = [];
    for (let dt = -TRANSIT_PATH_S * 1000; dt <= TRANSIT_PATH_S * 1000; dt += 200) {
        const date = new Date(t + dt);
        const source = transitSource(kind, date);
        const s = satelliteGlobe(sat.satrec, date);
        const p = s && transitPoint(s, source);
        if (!p) continue;
        const elevation = Math.asin(dot(unit(p), towardsSource(source, p)));
        if (elevation <= 0) continue;
        const previous = centre[centre.length - 1];
        centre.push(p);
        if (!previous) continue;
        const across = unit(cross(unit(p), p.map((c, i) => c - previous[i])));
        const half = Math.hypot(...s.map((c, i) => c - p[i])) * Math.tan(sourceRadius(source, p)) / Math.sin(elevation);
        left.push(unit(p.map((c, i) => c + across[i] * half)));
        right.push(unit(p.map((c, i) => c - across[i] * half)));
    }
    return { centre, left, right };
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
