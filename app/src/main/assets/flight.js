'use strict';

// The selected aircraft's flight (aircraft.js selects): its route and airframe (hexdb.io) and the
// track flown on this leg (adsb.lol), from MainActivity's FlightInfo at /data/flight/<kind>/<key>,
// then the positions reported while it stays selected.
//
// On the globe: the track flown, coloured by altitude like the icons; and, when the route fits
// where the aircraft is, a dashed great circle on to the destination and the airports marked. The
// sheet gives the airframe, where from and to, how far is flown and left, and a rough arrival time.
//
// Routes come from a database of schedules keyed by callsign, so one can be out of date, or be
// another flight's that used the callsign. A route that would take the aircraft far out of its way
// to be where it is now isn't drawn, and the sheet says so.

/** A route fits if flying via where the aircraft is adds less than this to the leg (km, or share). */
const ROUTE_DETOUR_KM = 60, ROUTE_DETOUR_SHARE = 0.03;
/** ...or if the track flown starts within this of the leg's first airport. */
const ROUTE_ORIGIN_KM = 30;
/** Points further apart in time than this aren't joined: the aircraft was out of coverage. */
const TRACK_GAP_MS = 10 * 60_000;
/** A track older than this is fetched again when the aircraft is selected again. */
const TRACK_REFETCH_MS = 2 * 60_000;
const ROUTE_STEPS = 96;

const flightView = { markers: [], markersKey: '' };

/** Fetches what isn't known yet about `a`'s flight, filling the map and sheet as each part arrives. */
function loadFlight(a) {
    const now = Date.now();
    if (!a.flight) a.flight = { route: undefined, airframe: undefined, track: undefined, trackAt: 0, trail: [] };
    const f = a.flight;
    const get = (kind, key, field) => {
        f[field] = undefined;
        fetch(`/data/flight/${kind}/${encodeURIComponent(key)}`)
            .then(response => response.json())
            .catch(() => ({ error: 'unavailable' }))
            .then(data => {
                f[field] = data.error ? null : data;
                f[field + 'Error'] = data.error;
                if (a === selectedAircraft) {
                    drawFlight();
                    refreshSheetLive();
                }
            });
    };
    if (f.route === undefined) {
        if (a.callsign) get('route', a.callsign, 'route'); else f.route = null;
    }
    if (f.airframe === undefined) get('airframe', a.hex, 'airframe');
    if (f.track === undefined || now - f.trackAt > TRACK_REFETCH_MS) {
        f.trackAt = now;
        // Positions noted before this fetch are in the trace now.
        f.trail = [];
        get('track', a.hex, 'track');
    }
}

/** A new report for the selected aircraft: kept, to carry the track on past the trace. */
function noteFlightPosition(a) {
    const trail = a.flight?.trail;
    if (!trail) return;
    const last = trail[trail.length - 1];
    if (last && last[0] >= a.positionAt) return;
    trail.push([a.positionAt, a.lat, a.lon, a.onGround ? -1 : a.altitudeFt]);
}

/** The track as [time, lat, lon, altitude ft (-1 on the ground, null unknown)], oldest first, up to now. */
function flightPoints(a) {
    const traced = a.flight?.track?.points ?? [];
    const lastTraced = traced.length ? traced[traced.length - 1][0] : -Infinity;
    const points = [...traced, ...(a.flight?.trail ?? []).filter(p => p[0] > lastTraced)];
    const now = aircraftNow(a);
    points.push([Date.now(), now.lat, now.lon, a.onGround ? -1 : a.altitudeFt]);
    return points;
}

/** The route's leg the aircraft is on, as { from, to, legKm, flownKm, leftKm, fits }, or null. */
function routeLeg(a) {
    const airports = a.flight?.route?.airports?.filter(p => p.lat != null && p.lon != null);
    if (!airports || airports.length < 2) return null;
    const now = aircraftNow(a);
    let best = null;
    for (let i = 0; i + 1 < airports.length; i++) {
        const from = airports[i], to = airports[i + 1];
        const legKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
        const flownKm = haversineKm(from.lat, from.lon, now.lat, now.lon);
        const leftKm = haversineKm(now.lat, now.lon, to.lat, to.lon);
        // Zero on the great circle between them; grows the further out of the way it is.
        const detourKm = flownKm + leftKm - legKm;
        if (!best || detourKm < best.detourKm) best = { from, to, legKm, flownKm, leftKm, detourKm };
    }
    // Fits if it's on the way, or the track flown starts at the leg's airport (an indirect routing).
    const start = a.flight.track?.points?.[0];
    best.fits = best.detourKm < Math.max(ROUTE_DETOUR_KM, best.legKm * ROUTE_DETOUR_SHARE)
        || (!!start && haversineKm(start[1], start[2], best.from.lat, best.from.lon) < ROUTE_ORIGIN_KM);
    return best;
}

/** Points along the great circle from one [lat, lon] to another, longitudes unwrapped for the map. */
function greatCircle(lat1, lon1, lat2, lon2, steps = ROUTE_STEPS) {
    const rad = Math.PI / 180;
    const v = (lat, lon) => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
    const p = v(lat1, lon1), q = v(lat2, lon2);
    const angle = Math.acos(Math.min(Math.max(dot(p, q), -1), 1));
    const line = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const [a, b] = angle < 1e-9 ? [1 - t, t] : [Math.sin((1 - t) * angle) / Math.sin(angle), Math.sin(t * angle) / Math.sin(angle)];
        const x = a * p[0] + b * q[0], y = a * p[1] + b * q[1], z = a * p[2] + b * q[2];
        line.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad]);
    }
    return unwrap(line);
}

/** Longitudes made continuous, so a line crossing the antimeridian doesn't go the long way round. */
function unwrap(line) {
    for (let i = 1; i < line.length; i++) {
        while (line[i][0] - line[i - 1][0] > 180) line[i][0] -= 360;
        while (line[i][0] - line[i - 1][0] < -180) line[i][0] += 360;
    }
    return line;
}

function altitudeBand(altitudeFt) {
    if (altitudeFt === -1) return 0;
    return AIRCRAFT_BANDS.findIndex(band => band.below > (altitudeFt ?? 0));
}

/** The selected aircraft's track and route on the map, or nothing without one. */
function drawFlight() {
    const a = selectedAircraft;
    const track = [], route = [];
    let airports = [];
    if (a?.flight) {
        // The track, split where the colour changes or there is a gap in coverage.
        let line = [], band = -1, previous = null;
        const finish = () => {
            if (line.length > 1) track.push(colouredLine(unwrap(line), AIRCRAFT_BANDS[band].css));
        };
        for (const [time, lat, lon, altitudeFt] of flightPoints(a)) {
            const b = altitudeFt == null && previous ? band : altitudeBand(altitudeFt);
            const gap = previous && time - previous[0] > TRACK_GAP_MS;
            if (gap || (previous && b !== band)) {
                finish();
                // A change of colour carries on from the last point; a gap starts afresh.
                line = gap ? [] : [line[line.length - 1]];
            }
            line.push([lon, lat]);
            band = b;
            previous = [time];
        }
        finish();

        const leg = routeLeg(a);
        if (leg?.fits) {
            const now = aircraftNow(a);
            route.push(colouredLine(greatCircle(now.lat, now.lon, leg.to.lat, leg.to.lon), '#ffffff'));
            airports = a.flight.route.airports.filter(p => p.lat != null);
        }
    }
    loaded.then(() => {
        map.getSource('flight-track').setData({ type: 'FeatureCollection', features: track });
        map.getSource('flight-route').setData({ type: 'FeatureCollection', features: route });
    });
    placeAirports(airports);
}

function colouredLine(coordinates, color) {
    return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { color } };
}

/** Markers for the route's airports, made again only when they change. */
function placeAirports(airports) {
    const key = airports.map(p => p.icao).join('-');
    if (key === flightView.markersKey) return;
    flightView.markersKey = key;
    for (const marker of flightView.markers) marker.remove();
    flightView.markers = airports.map(p => {
        const node = el('div', 'airport-marker', p.iata || p.icao);
        node.title = p.name;
        return new maplibregl.Marker({ element: node }).setLngLat([p.lon, p.lat]).addTo(map);
    });
}

loaded.then(() => {
    const before = map.getLayer('aircraft') ? 'aircraft' : undefined;
    map.addSource('flight-track', { type: 'geojson', data: emptyFeatures() });
    map.addLayer({
        id: 'flight-track', type: 'line', source: 'flight-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.9 },
    }, before);
    map.addSource('flight-route', { type: 'geojson', data: emptyFeatures() });
    map.addLayer({
        id: 'flight-route', type: 'line', source: 'flight-route',
        paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.6, 'line-dasharray': [2, 3] },
    }, before);
});

// ---- The sheet's flight lines (aircraft.js builds the sheet) ----

function airportName(p) {
    return `${p.iata || p.icao} ${p.name || ''}`.trim();
}

function clock(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The airframe, route, progress and track lines, as text (empty to hide). */
function describeFlight(a) {
    const f = a.flight ?? {};
    const airframe = f.airframe
        ? [[f.airframe.manufacturer, f.airframe.model].filter(Boolean).join(' '), f.airframe.owner].filter(Boolean).join(' · ')
        : '';

    let route = '', progress = '';
    const codes = f.route?.airports?.map(p => p.iata || p.icao).join(' → ');
    if (!a.callsign) route = 'Route: no callsign to look it up by.';
    else if (f.route === undefined) route = 'Route: looking it up…';
    else if (!f.route) route = f.routeError === 'none' ? `Route: none known for ${a.callsign}.` : 'Route: couldn\'t look it up.';
    else {
        const leg = routeLeg(a);
        if (!leg) route = `Route ${codes}`;
        else if (!leg.fits) {
            route = `Listed route ${codes} doesn't fit where it is, so it's probably out of date or another flight's.`;
        } else {
            const stops = f.route.airports.length > 2 ? ` (${codes})` : '';
            route = `${airportName(leg.from)} → ${airportName(leg.to)}${stops}`;
            if (a.onGround && leg.flownKm < 5) progress = `On the ground at ${leg.from.iata || leg.from.icao}`;
            else if (a.onGround && leg.leftKm < 5) progress = `On the ground at ${leg.to.iata || leg.to.icao}`;
            else {
                progress = `${Math.round(leg.flownKm).toLocaleString()} km flown · ${Math.round(leg.leftKm).toLocaleString()} km to go`;
                if (!a.onGround && a.speedKt > 60) {
                    const ms = leg.leftKm / (a.speedKt * KNOT_KMH) * 3600_000;
                    progress += ` · about ${describeDuration(ms)} more at this speed (≈ ${clock(Date.now() + ms)})`;
                }
            }
        }
    }

    const points = f.track?.points;
    const track = f.track === undefined ? 'Track: loading…'
        : points?.length ? `Track since ${clock(points[0][0])} (adsb.lol)`
        : 'No track from adsb.lol; drawing it from now on.';
    const source = f.route ? ' · Route from hexdb.io\'s schedules: may be out of date.' : '';
    return { airframe, route, progress, track: track + source };
}
