'use strict';

// Satellites drawn at their true altitude above the globe. MainActivity serves their orbital
// elements (CelesTrak OMM) at /data/satellites.json and calls globe.loadSatellites(); positions come
// from SGP4 (satellite.js) on the device. Names come from names.js where it has a friendlier one.
// Tapping a satellite selects it; panels.js shows the selection's details.
//
// Everything in orbit is a custom WebGL layer in the globe's own space, where the Earth is the
// unit sphere, so a point h km up sits at radius 1 + h / EARTH_RADIUS_KM.
//
// Featured satellites (the ISS) and the one the user tapped are "detailed", and show:
//   - a label (DOM) with name, altitude and speed
//   - their orbit path, one period ahead and a little behind, as dots at true altitude
//   - a dotted "altitude line" from the satellite straight down to the ground
//   - their ground track on the surface, as a dashed map line
// Every other satellite is a dot in its group's colour; there can be ~20,000 of them, so they are
// moved in batches. Zooming in grows them (low-orbit ones the most) into shapes for what they are:
// a satellite with solar panels, a space station, a CubeSat, a rocket body or debris (shapeOf).
// With a geostationary group shown, a faint ring marks the geostationary belt. Optionally, the
// selected satellite's coverage footprint, the big constellations' orbital planes, and the Moon.
// Starred satellites (favourites) keep a label. Everything is drawn for the globe's clock, simNow().
// Points in Earth's shadow are dimmed (sun.js), and low-orbit groups fade out when zoomed out, where
// they would only bury the globe.

/** The globe's sphere radius, matching MapLibre's. */
const EARTH_RADIUS_KM = 6371.0088;
const GEO_ALTITUDE_KM = 35786;
/** Orbit path dots per orbit, before adding more for eccentric orbits. */
const ORBIT_DOTS = 560;
/** Share of an orbit drawn behind the satellite. */
const PAST_FRACTION = 0.25;
const TETHER_DOTS = 40;
const BELT_DOTS = 720;
/** How often detailed satellites move, and the dots' batches are moved. */
const TICK_MS = 500;
/** How long it takes every dot to be moved once, a batch per tick. */
const DOT_REFRESH_MS = 5000;
const PATH_REFRESH_MS = 60_000;
/** How close, in CSS pixels, a tap must land to a satellite to select it. */
const TAP_RADIUS_PX = 24;
/** Width a label's text needs to the right of its satellite before it flips to the left. */
const LABEL_ROOM_PX = 250;
/** Low-orbit groups are hidden at this zoom and below, and fully shown from LOW_ORBIT_SHOWN_ZOOM. */
const LOW_ORBIT_HIDDEN_ZOOM = 0, LOW_ORBIT_SHOWN_ZOOM = 0.75;
/** How much of a point's opacity is left in Earth's shadow. */
const SHADOW_OPACITY = 0.3;
/** Groups whose satellites sit in the geostationary belt, which then gets its ring. */
const BELT_GROUPS = new Set(['geo', 'gpz']);

// Colours (r, g, b, a) and sizes (CSS px) of everything but the group dots.
const PATH_FUTURE = [1, 0.82, 0.4, 0.95], PATH_FUTURE_SIZE = 2.5;
const PATH_PAST = [1, 0.82, 0.4, 0.35], PATH_PAST_SIZE = 2;
const TETHER = [1, 1, 1, 0.8], TETHER_SIZE = 2;
const BELT = [0.43, 0.91, 1, 0.18], BELT_SIZE = 1.5;
const SELECTED = [1, 1, 1, 1], SELECTED_SIZE = 7;
/** Coverage footprint rings: where the satellite is on the horizon, and FOOTPRINT_HIGH_ELEVATION up. */
const FOOTPRINT = [0.31, 0.76, 0.97, 0.75], FOOTPRINT_HIGH = [0.31, 0.76, 0.97, 0.35], FOOTPRINT_SIZE = 2;
const FOOTPRINT_DOTS = 360, FOOTPRINT_HIGH_ELEVATION = 10;

/**
 * User terminals' reach, by group. A flat phased-array terminal steers its beam electronically, so
 * it can only reach satellites within maxOffBoresight of straight up, its scan cone: those at least
 * minEl = 90 - maxOffBoresight degrees above the horizon, with the terminal laid flat. The network
 * may set its own minimum elevation too (networkMinEl, from its filings); a satellite is in reach
 * above both. These show on the globe (footprint rings), in sky view (circles round overhead), in
 * the in-view list and in the satellite's sheet.
 *   - Amazon Leo: its terminals scan 55 degrees off boresight, and its FCC filing puts its minimum
 *     elevation at 35 degrees too.
 *   - Starlink: the Standard and Mini dishes see 110 degrees across; the network's FCC minimum is
 *     25 degrees (lower in places since 2026, for its lowest shells and far north).
 *   - OneWeb: flat panels (Intellian's) scan 70 degrees from zenith; its FCC filing sized the
 *     constellation so a satellite is always 55 degrees up or more.
 */
const TERMINAL_LIMITS = {
    'amazon-leo': { name: 'Amazon Leo', minEl: 35, maxOffBoresight: 55 },
    starlink: { name: 'Starlink', minEl: 35, maxOffBoresight: 55, networkMinEl: 25 },
    oneweb: { name: 'OneWeb', minEl: 20, maxOffBoresight: 70, networkMinEl: 55 },
};

/** The terminal limit for a satellite's group, or null if it has none. */
function terminalLimit(sat) {
    return TERMINAL_LIMITS[sat.group] ?? null;
}

/** The lowest elevation (degrees) a terminal can use a satellite at: above its cone and the network's minimum. */
function reachElevation(limit) {
    return Math.max(limit.minEl, limit.networkMinEl ?? -90);
}

/**
 * For a satellite with a terminal limit, at `elevation`: "22° off boresight" when in reach, else why
 * not, "below the terminal's cone" or "below the network's minimum"; '' for one without a limit.
 */
function describeReach(sat, elevation) {
    const limit = terminalLimit(sat);
    if (!limit) return '';
    if (elevation >= reachElevation(limit)) return `${Math.round(90 - elevation)}° off boresight`;
    return elevation < limit.minEl ? "below the terminal's cone" : "below the network's minimum";
}

/** Groups whose orbital planes are drawn (layers.planes): near-circular constellations. */
const PLANE_GROUPS = new Set(['starlink', 'oneweb', 'amazon-leo', 'qianfan', 'guowang', 'iridium', 'globalstar', 'orbcomm', 'gnss', 'planet', 'spire']);
const PLANE_DOTS = 120, MAX_PLANES = 400, PLANE_ALPHA = 0.18, PLANE_SIZE = 1.2;
/** Satellites share a drawn plane when their inclination, node and altitude round to the same. */
const PLANE_INCLINATION_STEP = 1, PLANE_NODE_STEP = 2, PLANE_ALTITUDE_STEP_KM = 30;

/**
 * id -> { id, name, officialName, objectId, group, satrec, now: {lat, lon, altKm, speedKmS}, path,
 * pathAt, label, details }. name is the friendly name if names.js has one, else officialName.
 */
const satellites = new Map();
/** Group key -> { color: [r, g, b, a], css: '#rrggbb', size, featured, lowOrbit, label, count }. */
let groupStyles = {};
/** Called after setSatellites() and on every change of selection or following. */
const satelliteListeners = [];
/** True while the camera tracks the selected satellite. */
let following = false;
/** Featured satellites, which are always detailed. */
let featured = [];
/** All the others, moved a batch at a time from dotCursor. */
let dots = [];
let dotCursor = 0;
let selected = null;
/** The Sun or Moon when selected instead of a satellite (heavens.js's BODIES), else null. */
let selectedBody = null;
/** The aircraft selected instead (aircraft.js), or null. */
let selectedAircraft = null;
/** The other satellite of a close approach the user picked (events.js), shown with the selection. */
let partner = null;
/** Catalogue numbers of the satellites the user has starred; panels.js keeps it. */
const favourites = new Set();
let showBelt = false;
/** Orbital planes (layers.planes) as { color, xyz: Float32Array of globe-space points }. */
let planes = [];
let planesAt = 0;
/** From the last frame drawn on the globe, for placing labels and hit-testing taps; null off the globe. */
let lastMatrix = null, lastCamera = null;

function loadSatellites() {
    fetch('/data/satellites.json')
        .then(response => response.json())
        .then(setSatellites)
        .catch(e => console.error('Loading satellites failed', e));
}

/**
 * `data` is { groups: { key: { color: '#rrggbb', size, featured } }, columns: [OMM CSV column names],
 * satellites: [[group, ...values in column order]] }.
 */
function setSatellites(data) {
    for (const sat of satellites.values()) sat.label?.remove();
    satellites.clear();
    groupStyles = {};
    for (const [key, { color, size, featured, lowOrbit, label }] of Object.entries(data.groups)) {
        const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
        groupStyles[key] = { color: [...rgb, 0.9], css: color, size, featured, lowOrbit, label, count: 0 };
    }
    for (const [group, ...values] of data.satellites) {
        const omm = {};
        data.columns.forEach((column, i) => { omm[column] = values[i]; });
        const id = Number(omm.NORAD_CAT_ID);
        satellites.set(id, {
            id, group,
            name: FRIENDLY_NAMES[id] ?? omm.OBJECT_NAME,
            officialName: omm.OBJECT_NAME,
            objectId: omm.OBJECT_ID,
            satrec: satellite.json2satrec(omm),
            now: null, path: [], pathAt: 0, label: null, details: null,
        });
    }
    for (const sat of satellites.values()) sat.shape = shapeOf(sat);
    const all = [...satellites.values()];
    for (const sat of all) groupStyles[sat.group].count++;
    featured = all.filter(sat => groupStyles[sat.group]?.featured);
    dots = all.filter(sat => !groupStyles[sat.group]?.featured);
    dotCursor = 0;
    selected = selected && satellites.get(selected.id) || null;
    partner = partner && satellites.get(partner.id) || null;
    if (!selected && !selectedAircraft && !selectedBody) following = false;
    planesAt = 0;
    showBelt = all.some(sat => BELT_GROUPS.has(sat.group));
    // Place every dot now rather than over the first few seconds of batches.
    const date = new Date(simNow());
    for (const sat of dots) sat.now = positionAt(sat.satrec, date);
    tick();
    notifySatelliteListeners();
}

function notifySatelliteListeners() {
    for (const listener of satelliteListeners) listener();
}

/**
 * Whether a satellite is drawn: every one, or with layers.favouritesOnly just the starred ones (and
 * whatever is selected, so a search or tap still shows it).
 */
function isDrawn(sat) {
    return !layers.favouritesOnly || favourites.has(sat.id) || sat === selected || sat === partner;
}

function detailed() {
    const list = featured.filter(isDrawn);
    for (const sat of [selected, partner]) if (sat && !list.includes(sat)) list.push(sat);
    return list;
}

/** Geodetic position of a satellite at `date`, or null if SGP4 fails (e.g. a decayed orbit). */
function positionAt(satrec, date) {
    const pv = propagate(satrec, date);
    return pv && { ...geodetic(pv.position, satellite.gstime(date)), speedKmS: Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) };
}

/** Inertial (ECI) position and velocity at `date`, or null if SGP4 fails. */
function propagate(satrec, date) {
    const pv = satellite.propagate(satrec, date);
    return pv && pv.position && typeof pv.position !== 'boolean' ? pv : null;
}

/** An inertial position as latitude, longitude and altitude, with the Earth turned to sidereal angle `gmst`. */
function geodetic(eci, gmst) {
    const geo = satellite.eciToGeodetic(eci, gmst);
    return { lat: satellite.degreesLat(geo.latitude), lon: satellite.degreesLong(geo.longitude), altKm: geo.height };
}

function tick() {
    const now = simNow();
    const date = new Date(now);
    let pathsChanged = false;
    for (const sat of detailed()) {
        sat.now = positionAt(sat.satrec, date);
        if (now - sat.pathAt > PATH_REFRESH_MS) {
            sat.pathAt = now;
            sat.path = orbitPath(sat.satrec, now);
            pathsChanged = true;
        }
    }
    const batch = Math.ceil(dots.length * TICK_MS / DOT_REFRESH_MS);
    for (let i = 0; i < batch && dots.length; i++) {
        const sat = dots[dotCursor];
        if (sat !== selected) sat.now = positionAt(sat.satrec, date);
        dotCursor = (dotCursor + 1) % dots.length;
    }
    if (pathsChanged) loaded.then(updateGroundTracks);
    if (layers.planes && Math.abs(now - planesAt) > PATH_REFRESH_MS) {
        planesAt = now;
        planes = orbitalPlanes(now);
    }
    // Following the Sun or Moon keeps where it is overhead in the middle.
    const followed = selected?.now ?? (selectedAircraft && aircraftNow(selectedAircraft))
        ?? (selectedBody && bodySubpoint(selectedBody.kind));
    if (following && followed) {
        map.easeTo({ center: [followed.lon, followed.lat], duration: TICK_MS, easing: t => t });
    }
    orbitLayer.dirty = true;
    map.triggerRepaint();
}
setInterval(tick, TICK_MS);

// A new time on the clock: everything moves there at once, not over a round of batches.
timeListeners.push(() => {
    const date = new Date(simNow());
    for (const sat of dots) sat.now = positionAt(sat.satrec, date);
    for (const sat of detailed()) sat.pathAt = 0;
    planesAt = 0;
    tick();
});

/**
 * One ring per orbital plane of the PLANE_GROUPS shown, at `now`. A plane turns slowly (its node
 * drifts with the Earth's bulge), so each satellite's node is moved on from its elements' epoch.
 */
function orbitalPlanes(now) {
    const gmst = satellite.gstime(new Date(now));
    const julian = now / 86_400_000 + 2440587.5;
    const found = new Map();
    for (const sat of satellites.values()) {
        if (!PLANE_GROUPS.has(sat.group)) continue;
        const r = sat.satrec;
        if (r.ecco > 0.05) continue;
        const node = r.nodeo + r.nodedot * (julian - r.jdsatepoch) * 1440;
        const radiusKm = Math.cbrt(398600.4418 / (r.no / 60) ** 2);
        const key = [
            sat.group,
            Math.round(r.inclo * 180 / Math.PI / PLANE_INCLINATION_STEP),
            Math.round((((node * 180 / Math.PI) % 360) + 360) % 360 / PLANE_NODE_STEP),
            Math.round(radiusKm / PLANE_ALTITUDE_STEP_KM),
        ].join('|');
        if (!found.has(key)) found.set(key, { group: sat.group, inclination: r.inclo, node, radiusKm });
        if (found.size >= MAX_PLANES) break;
    }
    return [...found.values()].map(({ group, inclination, node, radiusKm }) => {
        const [red, green, blue] = groupStyles[group].color;
        const xyz = new Float32Array(PLANE_DOTS * 3);
        const r = radiusKm / EARTH_RADIUS_KM;
        const cosNode = Math.cos(node), sinNode = Math.sin(node), cosInc = Math.cos(inclination), sinInc = Math.sin(inclination);
        for (let i = 0; i < PLANE_DOTS; i++) {
            const u = i / PLANE_DOTS * 2 * Math.PI;
            // Inertial, then turned with the Earth to Earth-fixed, then globe space (see sun.js).
            const x = r * (cosNode * Math.cos(u) - sinNode * Math.sin(u) * cosInc);
            const y = r * (sinNode * Math.cos(u) + cosNode * Math.sin(u) * cosInc);
            const z = r * Math.sin(u) * sinInc;
            const ex = x * Math.cos(gmst) + y * Math.sin(gmst);
            const ey = -x * Math.sin(gmst) + y * Math.cos(gmst);
            xyz.set([ey, z, ex], i * 3);
        }
        return { color: [red, green, blue, PLANE_ALPHA], xyz };
    });
}

/**
 * Points round where a satellite at (lat, lon, altKm) is `elevation` degrees above the horizon: the
 * edge of the ground it can see (and be seen from).
 */
function footprintRing(lat, lon, altKm, elevation) {
    const e = elevation * Math.PI / 180;
    const reach = Math.acos(EARTH_RADIUS_KM * Math.cos(e) / (EARTH_RADIUS_KM + altKm)) - e;
    if (!(reach > 0)) return [];
    const phi = lat * Math.PI / 180;
    const ring = [];
    for (let i = 0; i < FOOTPRINT_DOTS; i++) {
        const bearing = i / FOOTPRINT_DOTS * 2 * Math.PI;
        const lat2 = Math.asin(Math.sin(phi) * Math.cos(reach) + Math.cos(phi) * Math.sin(reach) * Math.cos(bearing));
        const lon2 = lon * Math.PI / 180 +
            Math.atan2(Math.sin(bearing) * Math.sin(reach) * Math.cos(phi), Math.cos(reach) - Math.sin(phi) * Math.sin(lat2));
        ring.push([lat2 * 180 / Math.PI, lon2 * 180 / Math.PI]);
    }
    return ring;
}

/**
 * Points around the orbit, each with two positions:
 *   - lat, lon, altKm: the orbit as a fixed ellipse in space, placed with the Earth turned as it is
 *     now, so it closes and passes through the satellite. (Placing each point with the Earth turned
 *     as it is at that point's time instead traces a smeared, open curve.)
 *   - groundLat, groundLon: what is below the satellite at that point's time, for the ground track.
 */
function orbitPath(satrec, now) {
    // satrec.no is the mean motion in radians per minute.
    const periodS = 2 * Math.PI / satrec.no * 60;
    // Dots are evenly spaced in time, and an eccentric orbit races through perigee, so it needs more
    // of them there to stay a line.
    const step = periodS / (ORBIT_DOTS * (1 + 3 * satrec.ecco));
    const gmstNow = satellite.gstime(new Date(now));
    const path = [];
    for (let t = -periodS * PAST_FRACTION; t <= periodS; t += step) {
        const date = new Date(now + t * 1000);
        const pv = propagate(satrec, date);
        if (!pv) continue;
        const ground = geodetic(pv.position, satellite.gstime(date));
        path.push({ ...geodetic(pv.position, gmstNow), groundLat: ground.lat, groundLon: ground.lon, past: t < 0 });
    }
    return path;
}

/** A point in the globe's space: the unit sphere, raised by altKm. */
function toGlobe(lat, lon, altKm) {
    const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
    const r = 1 + altKm / EARTH_RADIUS_KM;
    return [Math.cos(phi) * Math.sin(lambda) * r, Math.sin(phi) * r, Math.cos(phi) * Math.cos(lambda) * r];
}

// ---- Selection ----

/** A tap on the globe selects what is under it; on what is already selected, or on nothing, it closes the info sheet. */
map.on('click', e => {
    const body = bodyAt(e.point.x, e.point.y);
    if (body) {
        selectBody(body === selectedBody ? null : body);
        return;
    }
    const hit = satelliteAt(e.point.x, e.point.y);
    // An aircraft under the tap wins over a satellite further from it.
    const plane = aircraftAt(e.point.x, e.point.y);
    const satPoint = hit && screenPoint(hit);
    if (plane && (!satPoint || plane.distance < Math.hypot(satPoint[0] - e.point.x, satPoint[1] - e.point.y))) {
        selectAircraft(plane.a === selectedAircraft ? null : plane.a);
        return;
    }
    if (hit && hit === selected) select(null);
    else if (hit !== selected || selectedBody || selectedAircraft) select(hit);
});

/** Selects `sat` (null to clear), stopping any following, and drops a close approach's partner. */
function select(sat) {
    for (const old of [selected, partner]) {
        if (old && !featured.includes(old)) {
            old.path = [];
            old.pathAt = 0;
        }
    }
    selected = sat;
    selectedBody = null;
    if (selectedAircraft) {
        selectedAircraft = null;
        moveAircraft();
    }
    partner = null;
    following = false;
    loaded.then(updateGroundTracks);
    tick();
    notifySatelliteListeners();
}

/** Keeps the camera on the selected satellite until turned off or the user drags the map. */
function setFollowing(on) {
    following = on && !!(selected || selectedBody || selectedAircraft);
    if (following) tick();
    notifySatelliteListeners();
}

map.on('dragstart', () => {
    if (following) setFollowing(false);
});

/**
 * Flies to a satellite, zoomed out enough to see it at its altitude: a satellite 35,786 km up
 * needs the globe far smaller on screen than one 400 km up.
 */
function flyToSatellite(sat) {
    if (!sat.now) return;
    const zoom = fitZoom(sat.now.lat) - Math.log2(1 + sat.now.altKm / EARTH_RADIUS_KM) * 1.3;
    map.flyTo({ center: [sat.now.lon, sat.now.lat], zoom: Math.min(map.getZoom(), zoom), duration: 2000 });
}

/** The visible satellite drawn nearest to the CSS pixel (x, y), within TAP_RADIUS_PX. */
function satelliteAt(x, y) {
    let best = null, bestDistance = TAP_RADIUS_PX;
    const lowOrbitShown = lowOrbitFade() > 0;
    for (const sat of satellites.values()) {
        if (!lowOrbitShown && groupStyles[sat.group].lowOrbit) continue;
        if (!isDrawn(sat)) continue;
        const point = screenPoint(sat);
        if (!point) continue;
        const distance = Math.hypot(point[0] - x, point[1] - y);
        if (distance < bestDistance) { best = sat; bestDistance = distance; }
    }
    return best;
}

/** Where a satellite is drawn, in CSS pixels, or null when it is off the globe view or behind the Earth. */
function screenPoint(sat) {
    if (!sat.now || !lastMatrix) return null;
    const p = toGlobe(sat.now.lat, sat.now.lon, sat.now.altKm);
    const clip = transform(lastMatrix, [...p, 1]);
    if (clip[3] <= 0 || occluded(p, lastCamera)) return null;
    const canvas = map.getCanvas();
    return [(clip[0] / clip[3] + 1) / 2 * canvas.clientWidth, (1 - clip[1] / clip[3]) / 2 * canvas.clientHeight];
}

// ---- Labels (DOM) ----

/** Satellites with a label on screen. */
const labelled = new Set();

function placeLabels() {
    const shown = new Set(detailed());
    // Starred satellites keep a label, unless their group is hidden at this zoom.
    const lowOrbitShown = lowOrbitFade() > 0;
    for (const id of favourites) {
        const sat = satellites.get(id);
        if (sat?.now && (lowOrbitShown || !groupStyles[sat.group].lowOrbit)) shown.add(sat);
    }
    for (const sat of labelled) {
        if (!shown.has(sat)) {
            sat.label.remove();
            sat.label = null;
            labelled.delete(sat);
        }
    }
    for (const sat of shown) {
        if (!sat.label) {
            sat.label = createLabel(sat);
            labelled.add(sat);
        }
        const point = screenPoint(sat);
        if (!point) {
            sat.label.style.display = 'none';
            continue;
        }
        sat.label.style.display = '';
        // Near the right edge the text goes on the satellite's left, so it stays on screen. The
        // label's icon sits on the satellite either way (24px wide, centred by the CSS margin).
        const flip = point[0] > map.getCanvas().clientWidth - LABEL_ROOM_PX;
        sat.label.classList.toggle('sat-flipped', flip);
        sat.label.style.transform = `translate(${point[0]}px, ${point[1]}px)` + (flip ? ' translateX(-100%) translateX(24px)' : '');
        sat.label.querySelector('.sat-motion').textContent =
            `${Math.round(sat.now.altKm).toLocaleString()} km · ${Math.round(sat.now.speedKmS * 3600).toLocaleString()} km/h`;
    }
}

function createLabel(sat) {
    const label = document.createElement('div');
    label.className = featured.includes(sat) ? 'sat' : 'sat sat-selected';
    label.innerHTML = '<div class="sat-icon"></div><div class="sat-text"><b></b><div class="sat-motion"></div></div>';
    label.querySelector('b').textContent = (favourites.has(sat.id) ? '★ ' : '') + sat.name;
    document.getElementById('map').appendChild(label);
    return label;
}

// ---- Ground tracks (an ordinary map layer on the surface) ----

function updateGroundTracks() {
    const features = [];
    for (const sat of detailed()) {
        // Split where the track crosses the antimeridian, or the line would wrap the long way round.
        let line = [];
        for (const { groundLat: lat, groundLon: lon, past } of sat.path) {
            if (past) continue;
            if (line.length && Math.abs(lon - line[line.length - 1][0]) > 180) {
                if (line.length > 1) features.push(lineFeature(line));
                line = [];
            }
            line.push([lon, lat]);
        }
        if (line.length > 1) features.push(lineFeature(line));
    }
    map.getSource('ground-tracks').setData({ type: 'FeatureCollection', features });
}

function lineFeature(coordinates) {
    return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} };
}

loaded.then(() => {
    map.addSource('ground-tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'ground-tracks',
        type: 'line',
        source: 'ground-tracks',
        paint: { 'line-color': '#ffd166', 'line-opacity': 0.55, 'line-width': 1.5, 'line-dasharray': [2, 3] },
    });
    map.addLayer(orbitLayer);
    updateGroundTracks();
    applySatelliteLayers();
});

layerListeners.push(() => loaded.then(applySatelliteLayers));

function applySatelliteLayers() {
    map.setLayoutProperty('ground-tracks', 'visibility', layers.groundTracks ? 'visible' : 'none');
    orbitLayer.dirty = true;
    map.triggerRepaint();
}

// ---- Orbits in 3D (custom WebGL layer) ----

const VERTEX_SHADER = `
    uniform mat4 u_matrix;
    uniform vec3 u_camera;
    uniform float u_pixel_ratio;
    uniform vec3 u_sun;
    uniform float u_shadow_opacity;
    attribute vec3 a_pos;
    attribute vec4 a_color;
    uniform float u_zoom_scale;
    uniform float u_max_size;
    attribute float a_size;
    attribute float a_shape;
    attribute float a_grow;
    varying vec4 v_color;
    varying float v_shape;
    varying float v_pixels;

    // True when the Earth (unit sphere) blocks the line of sight from the camera to p.
    bool hidden(vec3 p) {
        vec3 d = p - u_camera;
        float a = dot(d, d);
        float b = 2.0 * dot(u_camera, d);
        float c = dot(u_camera, u_camera) - 1.0;
        float disc = b * b - 4.0 * a * c;
        if (disc <= 0.0) return false;
        float t = (-b - sqrt(disc)) / (2.0 * a);
        return t > 0.0 && t < 1.0;
    }

    void main() {
        gl_Position = u_matrix * vec4(a_pos, 1.0);
        // Keep every point inside the depth range; visibility is decided by hidden() instead.
        gl_Position.z = 0.0;
        gl_PointSize = min(a_size * (1.0 + (u_zoom_scale - 1.0) * a_grow), u_max_size) * u_pixel_ratio;
        v_pixels = gl_PointSize;
        v_shape = a_shape;
        v_color = a_color;
        // In Earth's shadow: behind the Earth from the Sun, within a cylinder of the Earth's radius.
        float along = dot(a_pos, u_sun);
        if (along < 0.0 && length(a_pos - along * u_sun) < 1.0) v_color.a *= u_shadow_opacity;
        // Behind the camera (GEO and beyond are far enough out to pass it) or behind the Earth.
        if (gl_Position.w <= 0.0 || hidden(a_pos)) {
            v_color.a = 0.0;
            gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
        }
    }`;

const FRAGMENT_SHADER = `
    precision mediump float;
    varying vec4 v_color;
    varying float v_shape;
    varying float v_pixels;
    // Device pixels; below this a shape is a smudge, so a dot reads better.
    const float MIN_SHAPE_PIXELS = 14.0;
    const vec3 PANEL_BLUE = vec3(0.16, 0.3, 0.75);

    // Each shape, in point coordinates from the centre (-0.5 to 0.5, y down): 0 outside, 1 body,
    // 2 solar panel (or other detail).
    bool box(vec2 p, vec2 centre, vec2 halfSize) {
        vec2 d = abs(p - centre);
        return d.x <= halfSize.x && d.y <= halfSize.y;
    }

    vec2 rotate(vec2 p, float angle) {
        float c = cos(angle), s = sin(angle);
        return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    }

    // A box of a body with a solar panel either side.
    float satellitePart(vec2 p) {
        if (box(p, vec2(0.0), vec2(0.13))) return 1.0;
        if (abs(p.y) < 0.025 && abs(p.x) < 0.2) return 1.0;
        if (abs(p.x) > 0.19 && abs(p.x) < 0.47 && abs(p.y) < 0.11) return 2.0;
        return 0.0;
    }

    // A long truss with modules across the middle and pairs of tall solar arrays at each end.
    float stationPart(vec2 p) {
        if (abs(p.x) < 0.47 && abs(p.y) < 0.03) return 1.0;
        if (abs(p.x) < 0.07 && abs(p.y) < 0.24) return 1.0;
        if (abs(p.x) < 0.18 && abs(p.y - 0.12) < 0.04) return 1.0;
        float x = abs(p.x);
        if (((x > 0.25 && x < 0.33) || (x > 0.37 && x < 0.45)) && abs(p.y) > 0.05 && abs(p.y) < 0.36) return 2.0;
        return 0.0;
    }

    // A spent stage: a cylinder with a pointed top and an engine bell.
    float rocketPart(vec2 p) {
        if (abs(p.x) < 0.12 && p.y > -0.22 && p.y < 0.28) return 1.0;
        if (p.y <= -0.22 && length(vec2(p.x, (p.y + 0.22) * 0.6)) < 0.12) return 1.0;
        if (p.y >= 0.28 && p.y < 0.42 && abs(p.x) < 0.06 + (p.y - 0.28) * 0.6) return 2.0;
        return 0.0;
    }

    // Jagged shards.
    float debrisPart(vec2 p) {
        if (box(rotate(p, 0.5), vec2(-0.04, 0.0), vec2(0.32, 0.1))) return 1.0;
        if (box(rotate(p, -0.9), vec2(0.12, 0.08), vec2(0.2, 0.09))) return 1.0;
        if (box(rotate(p, 1.2), vec2(0.0, -0.2), vec2(0.08, 0.06))) return 2.0;
        if (length(p - vec2(-0.2, 0.22)) < 0.09) return 1.0;
        if (length(p - vec2(0.27, -0.22)) < 0.07) return 1.0;
        return 0.0;
    }

    // A small cube with its seams showing, and short panels.
    float cubesatPart(vec2 p) {
        if (box(p, vec2(0.0), vec2(0.17))) return abs(p.x) < 0.015 || abs(p.y) < 0.015 ? 2.0 : 1.0;
        if (abs(p.x) > 0.17 && abs(p.x) < 0.44 && abs(p.y) < 0.15) return 2.0;
        return 0.0;
    }

    float part(float kind, vec2 p) {
        if (kind < 1.5) return satellitePart(p);
        if (kind < 2.5) return stationPart(p);
        if (kind < 3.5) return rocketPart(p);
        if (kind < 4.5) return debrisPart(p);
        return cubesatPart(p);
    }

    void main() {
        if (v_color.a <= 0.0) discard;
        vec2 p = gl_PointCoord - 0.5;
        float kind = floor(v_shape);
        // Plain dots for paths and the like, and for anything too small for its shape to show.
        if (kind < 0.5 || v_pixels < MIN_SHAPE_PIXELS) {
            if (length(p) > 0.5) discard;
            gl_FragColor = vec4(v_color.rgb * v_color.a, v_color.a);
            return;
        }
        vec2 q = rotate(p, fract(v_shape) * 6.2832);
        float at = part(kind, q);
        if (at == 0.0) {
            // A dark rim, so the shape stands out against the map.
            if (part(kind, q * 1.15) == 0.0) discard;
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.55 * v_color.a);
            return;
        }
        vec3 rgb = at > 1.5 ? mix(v_color.rgb, PANEL_BLUE, 0.55) : v_color.rgb;
        gl_FragColor = vec4(rgb * v_color.a, v_color.a);
    }`;

/** Floats per vertex: position (3), colour (4), size (1), shape (1), growth with zoom (1). */
const VERTEX_FLOATS = 10;

/**
 * Point shapes (the fragment shader's part()); a fraction added to one turns it by that much of a
 * full turn. Satellites become their shape once zoomed in far enough for it to be made out.
 */
const SHAPE_DOT = 0, SHAPE_SATELLITE = 1, SHAPE_STATION = 2, SHAPE_ROCKET = 3, SHAPE_DEBRIS = 4, SHAPE_CUBESAT = 5;
/** Groups made up mostly of CubeSats. */
const CUBESAT_GROUPS = new Set(['amateur', 'satnogs', 'planet', 'spire']);
/** How much bigger satellites get per zoom level past ZOOM_GROWTH_FROM, and the most they reach (CSS px). */
const ZOOM_GROWTH = 1.2, ZOOM_GROWTH_FROM = 1, MAX_POINT_SIZE = 48;
/** How much satellites out of low orbit grow, compared with low-orbit ones. */
const HIGH_ORBIT_GROWTH = 0.4;

/** A satellite's shape: by its name for rocket bodies and debris, else by its group. */
function shapeOf(sat) {
    // A turn from the catalogue number, so neighbours don't all face the same way.
    const turn = (sat.id * 0.6180339887) % 1 * 0.999;
    if (/\bR\/B\b/.test(sat.officialName)) return SHAPE_ROCKET + turn;
    if (/\bDEB\b/.test(sat.officialName) || sat.group === 'debris') return SHAPE_DEBRIS + turn;
    if (sat.group === 'stations') return SHAPE_STATION;
    if (CUBESAT_GROUPS.has(sat.group)) return SHAPE_CUBESAT + turn;
    return SHAPE_SATELLITE + turn;
}

/** How many times its base size satellites are drawn at the current zoom, for those that grow fully. */
function zoomScale() {
    return 1 + Math.max(0, visualZoom() - ZOOM_GROWTH_FROM) * ZOOM_GROWTH;
}

const orbitLayer = {
    id: 'orbits',
    type: 'custom',
    renderingMode: '2d',
    dirty: true,
    count: 0,
    /** Reused between uploads; grows as needed. */
    vertices: new Float32Array(VERTEX_FLOATS * 4096),

    onAdd(map, gl) {
        this.program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
        this.buffer = gl.createBuffer();
        this.vao = gl.createVertexArray ? gl.createVertexArray() : null;
        const uniform = name => gl.getUniformLocation(this.program, name);
        const attribute = name => gl.getAttribLocation(this.program, name);
        this.u = {
            matrix: uniform('u_matrix'), camera: uniform('u_camera'), pixelRatio: uniform('u_pixel_ratio'),
            sun: uniform('u_sun'), shadowOpacity: uniform('u_shadow_opacity'),
            zoomScale: uniform('u_zoom_scale'), maxSize: uniform('u_max_size'),
        };
        this.a = {
            pos: attribute('a_pos'), color: attribute('a_color'), size: attribute('a_size'),
            shape: attribute('a_shape'), grow: attribute('a_grow'),
        };
    },

    render(gl, args) {
        const data = args.defaultProjectionData;
        // Orbits are only drawn on the full globe; MapLibre flattens to Mercator when zoomed far in,
        // where anything hundreds of km up is off screen anyway.
        const onGlobe = args.shaderData.variantName === 'globe' && data.projectionTransition > 0.999;
        lastMatrix = onGlobe ? data.mainMatrix : null;
        lastCamera = onGlobe ? cameraPosition(data.mainMatrix) : null;
        placeLabels();
        if (!onGlobe) return;

        if (this.dirty) this.upload(gl);
        if (!this.count) return;

        const stride = VERTEX_FLOATS * 4;
        if (this.vao) gl.bindVertexArray(this.vao);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.a.pos);
        gl.vertexAttribPointer(this.a.pos, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this.a.color);
        gl.vertexAttribPointer(this.a.color, 4, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(this.a.size);
        gl.vertexAttribPointer(this.a.size, 1, gl.FLOAT, false, stride, 28);
        gl.enableVertexAttribArray(this.a.shape);
        gl.vertexAttribPointer(this.a.shape, 1, gl.FLOAT, false, stride, 32);
        gl.enableVertexAttribArray(this.a.grow);
        gl.vertexAttribPointer(this.a.grow, 1, gl.FLOAT, false, stride, 36);
        gl.uniform1f(this.u.zoomScale, zoomScale());
        gl.uniform1f(this.u.maxSize, MAX_POINT_SIZE);
        gl.uniformMatrix4fv(this.u.matrix, false, data.mainMatrix);
        gl.uniform3fv(this.u.camera, lastCamera);
        gl.uniform1f(this.u.pixelRatio, window.devicePixelRatio || 1);
        gl.uniform3fv(this.u.sun, sun);
        gl.uniform1f(this.u.shadowOpacity, layers.dayNight ? SHADOW_OPACITY : 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.POINTS, 0, this.count);
        if (this.vao) gl.bindVertexArray(null);
    },

    upload(gl) {
        this.dirty = false;
        this.count = 0;
        // Drawn in order, so later points land on top: belt, paths, dots, then the selection.
        if (showBelt && layers.geoBelt) {
            for (let i = 0; i < BELT_DOTS; i++) this.point(0, i * 360 / BELT_DOTS - 180, GEO_ALTITUDE_KM, BELT, BELT_SIZE);
        }
        for (const sat of detailed()) {
            if (layers.orbits) {
                for (const p of sat.path) {
                    if (p.past) this.point(p.lat, p.lon, p.altKm, PATH_PAST, PATH_PAST_SIZE);
                    else this.point(p.lat, p.lon, p.altKm, PATH_FUTURE, PATH_FUTURE_SIZE);
                }
            }
            if (layers.altitudeLines && sat.now) {
                for (let i = 0; i < TETHER_DOTS; i++) {
                    this.point(sat.now.lat, sat.now.lon, sat.now.altKm * i / TETHER_DOTS, TETHER, TETHER_SIZE);
                }
            }
        }
        if (layers.footprints && selected?.now) {
            const { lat, lon, altKm } = selected.now;
            for (const [la, lo] of footprintRing(lat, lon, altKm, 0)) this.point(la, lo, 1, FOOTPRINT, FOOTPRINT_SIZE);
            for (const [la, lo] of footprintRing(lat, lon, altKm, FOOTPRINT_HIGH_ELEVATION)) this.point(la, lo, 1, FOOTPRINT_HIGH, FOOTPRINT_SIZE);
            // Where a terminal can reach it: the satellite inside the terminal's scan cone.
            // and, fainter, the network's own minimum elevation where it has one.
            const limit = terminalLimit(selected);
            if (limit) {
                const rgb = groupStyles[selected.group].color.slice(0, 3);
                for (const [la, lo] of footprintRing(lat, lon, altKm, limit.minEl)) this.point(la, lo, 1, [...rgb, 0.9], FOOTPRINT_SIZE + 0.5);
                if (limit.networkMinEl !== undefined) {
                    for (const [la, lo] of footprintRing(lat, lon, altKm, limit.networkMinEl)) this.point(la, lo, 1, [...rgb, 0.4], FOOTPRINT_SIZE);
                }
            }
        }
        if (layers.planes) {
            for (const { color, xyz } of planes) {
                for (let i = 0; i < xyz.length; i += 3) this.pointAt(xyz[i], xyz[i + 1], xyz[i + 2], color, PLANE_SIZE);
            }
        }
        // Featured satellites are drawn by their label's icon.
        const fade = lowOrbitFade();
        this.fade = fade;
        for (const sat of dots) {
            if (!sat.now || sat === selected || !isDrawn(sat)) continue;
            const style = groupStyles[sat.group];
            if (!style.lowOrbit) {
                this.point(sat.now.lat, sat.now.lon, sat.now.altKm, style.color, style.size, sat.shape, HIGH_ORBIT_GROWTH);
            } else if (fade > 0) {
                const [r, g, b, a] = style.color;
                this.point(sat.now.lat, sat.now.lon, sat.now.altKm, [r, g, b, a * fade], style.size, sat.shape, 1);
            }
        }
        for (const sat of [selected, partner]) {
            if (sat?.now) this.point(sat.now.lat, sat.now.lon, sat.now.altKm, SELECTED, SELECTED_SIZE, sat.shape, 1);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.subarray(0, this.count * VERTEX_FLOATS), gl.DYNAMIC_DRAW);
    },

    /** Appends one point (see toGlobe) to `vertices`. */
    point(lat, lon, altKm, color, size, shape = SHAPE_DOT, grow = 0) {
        const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
        const r = 1 + altKm / EARTH_RADIUS_KM;
        const cosPhi = Math.cos(phi);
        this.pointAt(cosPhi * Math.sin(lambda) * r, Math.sin(phi) * r, cosPhi * Math.cos(lambda) * r, color, size, shape, grow);
    },

    /** Appends one point already in globe space. */
    pointAt(x, y, z, color, size, shape = SHAPE_DOT, grow = 0) {
        let v = this.vertices;
        let i = this.count * VERTEX_FLOATS;
        if (i + VERTEX_FLOATS > v.length) {
            this.vertices = new Float32Array(v.length * 2);
            this.vertices.set(v);
            v = this.vertices;
        }
        v[i++] = x;
        v[i++] = y;
        v[i++] = z;
        v[i++] = color[0];
        v[i++] = color[1];
        v[i++] = color[2];
        v[i++] = color[3];
        v[i++] = size;
        v[i++] = shape;
        v[i] = grow;
        this.count++;
    },
};

/** How much of the low-orbit groups shows at the current zoom: 0 hidden, 1 fully shown. */
function lowOrbitFade() {
    const t = (visualZoom() - LOW_ORBIT_HIDDEN_ZOOM) / (LOW_ORBIT_SHOWN_ZOOM - LOW_ORBIT_HIDDEN_ZOOM);
    return Math.max(0, Math.min(1, t));
}

// Zooming, or panning towards a pole, changes the fade between ticks; redraw when it does.
map.on('move', () => {
    if (lowOrbitFade() !== orbitLayer.fade) {
        orbitLayer.dirty = true;
        map.triggerRepaint();
    }
});

// ---- Geometry ----

/** Same test as the shader's hidden(). */
function occluded(p, c) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const a = dot(d, d), b = 2 * dot(c, d), cc = dot(c, c) - 1;
    const disc = b * b - 4 * a * cc;
    if (disc <= 0) return false;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t > 0 && t < 1;
}

/**
 * The camera's position in globe space. A perspective camera's centre is the one point the
 * view-projection matrix sends to clip w = 0 with x = y = 0, so it is inverse(M) · (0, 0, 1, 0).
 */
function cameraPosition(m) {
    const c = transform(invert(m), [0, 0, 1, 0]);
    return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Column-major 4x4 matrix times a vec4. */
function transform(m, v) {
    const out = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
        out[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3];
    }
    return out;
}

/** Inverse of a column-major 4x4 matrix (cofactor expansion, as in gl-matrix). */
function invert(a) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    return [
        (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
        (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
        (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
        (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
        (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
        (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
        (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
        (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ];
}

function linkProgram(gl, vertexSource, fragmentSource) {
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
}

window.globe.setSatellites = setSatellites;
window.globe.loadSatellites = loadSatellites;
