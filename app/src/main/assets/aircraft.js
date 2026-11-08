'use strict';

// Live aircraft from ADS-B (layers.aircraft). MainActivity serves those within the user's chosen
// radius at /data/aircraft.json (AircraftFeed: the user's receiver, adsb.lol or adsb.fi), polled
// every AIRCRAFT_POLL_MS while the layer is on. Between updates each aircraft is moved on along its
// track at its ground speed, so the icons glide rather than jump.
//
// On the globe they are a symbol layer: a plane icon turned to its track and coloured by altitude
// (11 km up is next to nothing at globe scale, so they sit on the surface), with a dashed ring
// marking the radius, and callsigns once zoomed in. Tapping one selects it (selectedAircraft) and
// panels.js shows its sheet, with its route and track (flight.js). Sky view, the in-view list and
// search include them too.
//
// ADS-B is live, so with the clock moved off now (time travel) the aircraft are hidden.

const AIRCRAFT_POLL_MS = 10_000;
const AIRCRAFT_MOVE_MS = 1000;
/** Positions older than this are dropped, and no aircraft is moved on further than this. */
const AIRCRAFT_STALE_S = 60;
/** How far the clock may be from now and still count as live. */
const AIRCRAFT_LIVE_MS = 60_000;
/** Callsign labels on the globe from this (visual) zoom in, at most this many. */
const AIRCRAFT_LABEL_ZOOM = 7, AIRCRAFT_MAX_LABELS = 60;
const FEET_KM = 0.0003048, KNOT_KMH = 1.852, NM_KM = 1.852;
/** Altitude colours: on the ground, then up to each ceiling in feet. */
const AIRCRAFT_BANDS = [
    { label: 'On the ground', css: '#9e9e9e' },
    { label: 'Below 5,000 ft', below: 5000, css: '#7cf29c' },
    { label: 'Below 15,000 ft', below: 15000, css: '#4fc3f7' },
    { label: 'Below 30,000 ft', below: 30000, css: '#ffd166' },
    { label: '30,000 ft and up', below: Infinity, css: '#ff8a65' },
];
const EMERGENCY_SQUAWKS = { 7500: 'hijack', 7600: 'radio failure', 7700: 'emergency' };

/** Aircraft by ICAO hex code; the same object stays while it is reported, so a selection holds. */
const aircraft = new Map();
const air = {
    /** When the last answer was made (ms), its source, centre [lon, lat] and radius. */
    at: 0, source: '', centre: null, radiusNm: 0,
    /** Why there are none: "offline", "unavailable", "waiting", or '' with data. */
    error: '',
    fetching: false,
    labels: new Map(),
};

function aircraftLive() {
    return layers.aircraft && Math.abs(simNow() - Date.now()) < AIRCRAFT_LIVE_MS;
}

function pollAircraft() {
    if (!aircraftLive()) {
        if (aircraft.size || air.centre) clearAircraft();
        return;
    }
    if (air.fetching || !here) return;
    air.fetching = true;
    fetch('/data/aircraft.json')
        .then(response => response.json())
        .then(setAircraft)
        .catch(e => {
            console.error('Loading aircraft failed', e);
            air.error = 'unavailable';
            updateLegend();
        })
        .finally(() => { air.fetching = false; });
}
setInterval(pollAircraft, AIRCRAFT_POLL_MS);
layerListeners.push(() => setTimeout(pollAircraft));
timeListeners.push(() => { if (!aircraftLive()) clearAircraft(); else pollAircraft(); });
locationListeners.push(() => setTimeout(pollAircraft));

/** `data` is AircraftFeed's JSON. */
function setAircraft(data) {
    if (!aircraftLive()) return;
    // Waiting (map paused, no location yet): keep what there is, ring and all, until it goes stale.
    const waiting = data.error === 'waiting';
    if (data.error) {
        air.error = data.error;
        if (!waiting) {
            aircraft.clear();
            air.centre = null;
        }
    } else {
        air.error = '';
        air.at = data.at;
        air.source = data.source;
        air.centre = [data.lon, data.lat];
        air.radiusNm = data.radiusNm;
        const seen = new Set();
        const oldest = Date.now() - AIRCRAFT_STALE_S * 1000;
        for (const [hex, callsign, registration, type, description, lat, lon, altitudeFt, onGround, speedKt, track, rateFpm, squawk, positionAt] of data.aircraft) {
            // Times are on this phone's clock (AircraftFeed); one not heard from in a minute is gone.
            if (positionAt < oldest) continue;
            seen.add(hex);
            let a = aircraft.get(hex);
            if (!a) {
                a = { hex, isAircraft: true };
                aircraft.set(hex, a);
            }
            Object.assign(a, { callsign, registration, type, description, lat, lon, altitudeFt, onGround, speedKt, track, rateFpm, squawk, positionAt });
            a.name = callsign || registration || hex.toUpperCase();
        }
        if (selectedAircraft) noteFlightPosition(selectedAircraft);
        for (const hex of [...aircraft.keys()]) if (!seen.has(hex)) aircraft.delete(hex);
    }
    if (selectedAircraft && !aircraft.has(selectedAircraft.hex)) selectAircraft(null);
    if (!waiting) {
        loaded.then(() => {
            map.getSource('aircraft-range').setData(air.centre
                ? accuracyCircle(air.centre[1], air.centre[0], air.radiusNm * NM_KM * 1000) : emptyFeatures());
        });
    }
    moveAircraft();
    updateLegend();
}

function clearAircraft() {
    aircraft.clear();
    air.centre = null;
    if (selectedAircraft) selectAircraft(null);
    loaded.then(() => {
        map.getSource('aircraft-range').setData(emptyFeatures());
        map.getSource('aircraft').setData(emptyFeatures());
    });
    for (const label of air.labels.values()) label.remove();
    air.labels.clear();
    updateLegend();
}

/**
 * Where the aircraft is now: its last reported position moved on along its track at its ground
 * speed (for at most AIRCRAFT_STALE_S), as { lat, lon, altKm }.
 */
function aircraftNow(a, t = Date.now()) {
    const seconds = Math.min(Math.max((t - a.positionAt) / 1000, 0), AIRCRAFT_STALE_S);
    let { lat, lon } = a;
    if (!a.onGround && a.speedKt > 0 && a.track != null) {
        const km = a.speedKt * KNOT_KMH / 3600 * seconds;
        const track = a.track * Math.PI / 180;
        lat += km * Math.cos(track) / 111.32;
        lon += km * Math.sin(track) / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
    }
    return { lat, lon, altKm: (a.altitudeFt ?? 0) * FEET_KM };
}

function aircraftBand(a) {
    if (a.onGround) return 0;
    const ft = a.altitudeFt ?? 0;
    return AIRCRAFT_BANDS.findIndex(band => band.below > ft);
}

/**
 * Moves every icon on to now; with a selection, its icon is white and drawn on top. Aircraft not
 * heard from for AIRCRAFT_STALE_S go, from everything (list, sky view, search, sheet), not just
 * the map.
 */
function moveAircraft() {
    const now = Date.now();
    for (const [hex, a] of aircraft) {
        if ((now - a.positionAt) / 1000 > AIRCRAFT_STALE_S) aircraft.delete(hex);
    }
    if (selectedAircraft && !aircraft.has(selectedAircraft.hex)) {
        selectedAircraft = null;
        following = false;
        notifySatelliteListeners();
    }
    const features = [];
    for (const a of aircraft.values()) {
        const { lat, lon } = aircraftNow(a, now);
        const isSelected = a === selectedAircraft;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                hex: a.hex,
                icon: isSelected ? 'aircraft-selected' : `aircraft-${aircraftBand(a)}`,
                track: a.track ?? 0,
                sort: isSelected ? 1e6 : a.altitudeFt ?? 0,
            },
        });
    }
    loaded.then(() => map.getSource('aircraft').setData({ type: 'FeatureCollection', features }));
    drawFlight();
}
setInterval(() => { if (aircraft.size) moveAircraft(); }, AIRCRAFT_MOVE_MS);

/** A plane icon, nose up, in `css`, with a dark outline so it shows on any map. */
function aircraftIcon(css) {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.scale(size / 24, size / 24);
    const plane = new Path2D('M12,2C12.8,2 13.3,2.9 13.3,4L13.3,9L21.5,13.6L21.5,15.6L13.3,13L13.3,18.2L15.8,20L15.8,21.6L12,20.5L8.2,21.6L8.2,20L10.7,18.2L10.7,13L2.5,15.6L2.5,13.6L10.7,9L10.7,4C10.7,2.9 11.2,2 12,2Z');
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.stroke(plane);
    ctx.fillStyle = css;
    ctx.fill(plane);
    return ctx.getImageData(0, 0, size, size);
}

loaded.then(() => {
    AIRCRAFT_BANDS.forEach((band, i) => map.addImage(`aircraft-${i}`, aircraftIcon(band.css), { pixelRatio: 2 }));
    map.addImage('aircraft-selected', aircraftIcon('#ffffff'), { pixelRatio: 2 });
    // Under the satellites' layer, which draws everything in orbit.
    const before = map.getLayer('orbits') ? 'orbits' : undefined;
    map.addSource('aircraft-range', { type: 'geojson', data: emptyFeatures() });
    map.addLayer({
        id: 'aircraft-range', type: 'line', source: 'aircraft-range',
        paint: { 'line-color': '#ffd166', 'line-opacity': 0.45, 'line-width': 1.2, 'line-dasharray': [3, 3] },
    }, before);
    map.addSource('aircraft', { type: 'geojson', data: emptyFeatures() });
    map.addLayer({
        id: 'aircraft', type: 'symbol', source: 'aircraft',
        layout: {
            'icon-image': ['get', 'icon'],
            'icon-rotate': ['get', 'track'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-sort-key': ['get', 'sort'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.3, 5, 0.6, 9, 1],
        },
    }, before);
});

/** The aircraft drawn nearest the CSS pixel (x, y), within TAP_RADIUS_PX: { a, distance }, or null. */
function aircraftAt(x, y) {
    if (!aircraft.size || !map.getLayer('aircraft')) return null;
    const r = TAP_RADIUS_PX;
    let best = null;
    for (const feature of map.queryRenderedFeatures([[x - r, y - r], [x + r, y + r]], { layers: ['aircraft'] })) {
        const a = aircraft.get(feature.properties.hex);
        if (!a) continue;
        const now = aircraftNow(a);
        const point = map.project([now.lon, now.lat]);
        const distance = Math.hypot(point.x - x, point.y - y);
        if (!best || distance < best.distance) best = { a, distance };
    }
    return best;
}

/** Selects an aircraft (null to clear), in place of any satellite, Sun or Moon. */
function selectAircraft(a) {
    if (selected) select(null);
    selectedBody = null;
    selectedAircraft = a;
    following = false;
    if (a) loadFlight(a);
    moveAircraft();
    notifySatelliteListeners();
}

/**
 * A row for the in-view list and search: swatch, "✈ name", then `subtitle`. Tapping it closes
 * `close` (the panel it is in) and selects the aircraft, flying to it unless in sky view.
 */
function aircraftRow(a, subtitle, close, subtitleClass = 'search-sub') {
    const row = el('button', 'search-result');
    const swatch = el('span', 'swatch');
    swatch.style.background = AIRCRAFT_BANDS[aircraftBand(a)].css;
    row.append(swatch, el('span', '', `✈ ${a.name}`), el('span', subtitleClass, subtitle));
    row.addEventListener('click', () => {
        close();
        selectAircraft(a);
        if (!sky.open) flyToAircraft(a);
    });
    return row;
}

function flyToAircraft(a) {
    const { lat, lon } = aircraftNow(a);
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8), duration: 2000 });
}

/** Where to look for the aircraft from (lat, lon): { az, el, rangeKm, groundKm }. */
function aircraftLook(a, lat, lon) {
    const now = aircraftNow(a);
    const target = satellite.geodeticToEcf({ latitude: now.lat * Math.PI / 180, longitude: now.lon * Math.PI / 180, height: now.altKm });
    const look = satellite.ecfToLookAngles(observerAt(lat, lon), target);
    return {
        az: (look.azimuth * 180 / Math.PI + 360) % 360,
        el: look.elevation * 180 / Math.PI,
        rangeKm: look.rangeSat,
        groundKm: haversineKm(lat, lon, now.lat, now.lon),
    };
}

/** Every aircraft above the horizon from (lat, lon): { a, az, el, rangeKm }, highest first. */
function aircraftInView(lat, lon) {
    if (!aircraftLive()) return [];
    const up = [];
    for (const a of aircraft.values()) {
        const look = aircraftLook(a, lat, lon);
        if (look.el > 0) up.push({ a, ...look });
    }
    return up.sort((p, q) => q.el - p.el);
}

/** "FL350" above 18,000 ft, else feet; "on the ground". */
function describeAltitude(a) {
    if (a.onGround) return 'on the ground';
    if (a.altitudeFt == null) return 'altitude unknown';
    return a.altitudeFt >= 18000 ? `FL${Math.round(a.altitudeFt / 100)}` : `${Math.round(a.altitudeFt).toLocaleString()} ft`;
}

// ---- Callsigns on the globe, once zoomed in ----

function placeAircraftLabels() {
    const wanted = new Map();
    if (aircraft.size && visualZoom() >= AIRCRAFT_LABEL_ZOOM) {
        const canvas = map.getCanvas();
        for (const a of aircraft.values()) {
            if (wanted.size >= AIRCRAFT_MAX_LABELS) break;
            const now = aircraftNow(a);
            const point = map.project([now.lon, now.lat]);
            if (point.x < 0 || point.y < 0 || point.x > canvas.clientWidth || point.y > canvas.clientHeight) continue;
            wanted.set(a.hex, { a, point });
        }
    }
    for (const [hex, label] of air.labels) {
        if (!wanted.has(hex)) {
            label.remove();
            air.labels.delete(hex);
        }
    }
    for (const [hex, { a, point }] of wanted) {
        let label = air.labels.get(hex);
        if (!label) {
            label = el('div', 'aircraft-label');
            document.getElementById('map').appendChild(label);
            air.labels.set(hex, label);
        }
        label.textContent = `${a.name} · ${describeAltitude(a)}`;
        label.classList.toggle('selected', a === selectedAircraft);
        label.style.transform = `translate(${point.x + 12}px, ${point.y - 8}px)`;
    }
}
map.on('render', placeAircraftLabels);

// ---- Sheet (panels.js builds the frame) ----

function buildAircraftSheet(a) {
    const node = el('div', 'sheet');
    const header = el('div', 'sheet-header');
    const title = el('div', 'sheet-title');
    title.append(el('b', '', `✈ ${a.name}`), el('div', 'sheet-sub aircraft-sub'));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => selectAircraft(null));
    header.append(title, close);
    const buttons = el('div', 'sheet-buttons');
    const follow = el('button', 'follow', 'Follow');
    follow.addEventListener('click', () => setFollowing(!following));
    buttons.append(follow);
    node.append(header, el('div', 'sheet-line aircraft-airframe'), el('div', 'sheet-line aircraft-route'),
        el('div', 'sheet-line aircraft-progress'), el('div', 'sheet-line aircraft-live'), el('div', 'sheet-line aircraft-squawk'),
        el('div', 'sheet-line sheet-pointing'), el('div', 'sheet-line sheet-hint aircraft-age'),
        el('div', 'sheet-line sheet-hint aircraft-track'), buttons);
    document.body.appendChild(node);
    sheet.node = node;
}

function refreshAircraftSheet(a) {
    const node = sheet.node;
    const text = (selector, value) => { node.querySelector(selector).textContent = value; };
    text('.aircraft-sub', [a.description || a.type, a.registration, `ICAO ${a.hex.toUpperCase()}`].filter(Boolean).join(' · '));
    const climb = a.rateFpm == null || Math.abs(a.rateFpm) < 200 ? 'level'
        : `${a.rateFpm > 0 ? 'climbing' : 'descending'} ${Math.abs(Math.round(a.rateFpm / 100) * 100).toLocaleString()} ft/min`;
    const altitude = a.onGround || a.altitudeFt == null ? describeAltitude(a)
        : `${Math.round(a.altitudeFt).toLocaleString()} ft (${Math.round(a.altitudeFt * 0.3048).toLocaleString()} m)`;
    text('.aircraft-live', [
        altitude,
        a.speedKt != null ? `${Math.round(a.speedKt)} kt (${Math.round(a.speedKt * KNOT_KMH)} km/h)` : null,
        a.track != null ? `heading ${Math.round(a.track)}° ${compass(a.track)}` : null,
        a.onGround ? null : climb,
    ].filter(Boolean).join(' · '));
    const emergency = EMERGENCY_SQUAWKS[a.squawk];
    const squawk = node.querySelector('.aircraft-squawk');
    squawk.textContent = a.squawk ? `Squawk ${a.squawk}${emergency ? ` ⚠ ${emergency}` : ''}` : '';
    squawk.classList.toggle('warning', !!emergency);
    if (here) {
        const look = aircraftLook(a, here[1], here[0]);
        text('.sheet-pointing', `From here: Az ${look.az.toFixed(1)}° ${compass(look.az)} · El ${look.el.toFixed(1)}°`
            + `${look.el < 0 ? ' (below the horizon)' : ''} · ${look.rangeKm.toFixed(1)} km away (${look.groundKm.toFixed(1)} km over the ground)`);
    } else {
        text('.sheet-pointing', 'Pointing: waiting for your location…');
    }
    const flight = describeFlight(a);
    for (const part of ['airframe', 'route', 'progress', 'track']) {
        const line = node.querySelector(`.aircraft-${part}`);
        line.textContent = flight[part];
        line.style.display = flight[part] ? '' : 'none';
    }
    const age = Math.max(0, Math.round((Date.now() - a.positionAt) / 1000));
    text('.aircraft-age', `Position ${age} s old, moved on from there · ${air.source === 'receiver' ? 'your receiver' : air.source}`);
}
