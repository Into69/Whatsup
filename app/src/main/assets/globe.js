'use strict';

// The globe page. MainActivity drives it through window.globe:
//   setTiles(tileSet)                       swap the raster tiles (TileSet.toJson())
//   setLocation(lat, lon, accuracyM, centre) move the "you" marker, flying there when centre is true
//   clearLocation()                         forget the location (a hand-set one turned off)
//   recentre()                              fly back to the last location
//   setLayers(layers)                       show or hide parts of the drawing (Settings.layersJson())
// and the other scripts add their own (see each one's last lines).

/** Share of the screen's shorter side that the whole globe should fill. */
const GLOBE_FILL = 0.9;

// ---- The globe's clock ----
// Everything drawn is for simNow(), which time.js's slider can move away from the real time. Pass
// alerts are always for real time.

/** How far the globe's clock is from the real one, in ms. */
let timeOffsetMs = 0;
/** Called when the offset changes, to redraw everything for the new time. */
const timeListeners = [];

function simNow() {
    return Date.now() + timeOffsetMs;
}

function setTimeOffset(ms) {
    timeOffsetMs = ms;
    for (const listener of timeListeners) listener();
}

/**
 * The zoom at which the whole globe fits the screen when centred on `lat`. MapLibre scales the
 * globe by 1/cos(lat) so a zoom level shows the same ground scale as Web Mercator, so the globe
 * would otherwise grow toward the poles.
 */
function fitZoom(lat) {
    const side = Math.min(window.innerWidth, window.innerHeight);
    const cos = Math.max(Math.cos(lat * Math.PI / 180), 0.1);
    return Math.log2(GLOBE_FILL * side * Math.PI * cos / 512);
}

/**
 * The zoom as it looks: what map.getZoom() would be for a globe this size on screen if it were
 * centred on the equator. MapLibre lowers the zoom number towards the poles while the globe stays the
 * same size (see fitZoom), so anything that depends on how big things look (low-orbit groups fading
 * in, satellites growing) goes by this instead.
 */
function visualZoom() {
    const cos = Math.max(Math.cos(map.getCenter().lat * Math.PI / 180), 0.01);
    return map.getZoom() - Math.log2(cos);
}

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        projection: { type: 'globe' },
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
        sources: {},
        // The globe's colour until tiles load.
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1a2e' } }],
    },
    center: [0, 20],
    zoom: fitZoom(20),
    attributionControl: false,
});
// Map.setMinZoom() refuses anything below -2, which only just fits the geostationary belt on a phone;
// highly elliptical orbits reach 27 Earth radii, so lower the transform's limit directly.
map.transform.setMinZoom(-4);

// Bottom left, clear of the Android recentre button in the bottom-right corner.
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

// MapLibre opens the credits whenever they change (the first tiles, a new tile set) until the map is
// dragged. Keep them folded to the ⓘ button unless the user has just tapped it to open them.
{
    const credits = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    let tappedAt = 0;
    credits.addEventListener('click', () => { tappedAt = Date.now(); }, true);
    const fold = () => {
        if (credits.classList.contains('maplibregl-compact-show') && Date.now() - tappedAt > 500) {
            credits.classList.remove('maplibregl-compact-show');
        }
    };
    new MutationObserver(fold).observe(credits, { attributes: true, attributeFilter: ['class'] });
    fold();
}

const loaded = new Promise(resolve => map.once('load', () => {
    map.addSource('accuracy', { type: 'geojson', data: emptyFeatures() });
    map.addLayer({
        id: 'accuracy',
        type: 'fill',
        source: 'accuracy',
        paint: { 'fill-color': '#4fc3f7', 'fill-opacity': 0.15, 'fill-outline-color': '#4fc3f7' },
    });
    resolve();
}));

/** Below this zoom the location dot is drawn small. */
const SMALL_MARKER_ZOOM = 0.5;

let marker = null;
let here = null;

/** Which parts of the drawing are shown; setLayers() changes them and tells layerListeners. */
const layers = {
    orbits: true, groundTracks: true, altitudeLines: true, footprints: true, planes: false, geoBelt: true,
    launches: true, myLocation: true, dayNight: true, stars: true, trueScale: false, favouritesOnly: false,
    aircraft: false,
};
const layerListeners = [applyLocationLayer];

function setLayers(changes) {
    Object.assign(layers, changes);
    for (const listener of layerListeners) listener();
}

function applyLocationLayer() {
    if (marker) marker.getElement().style.display = layers.myLocation ? '' : 'none';
    loaded.then(() => map.setLayoutProperty('accuracy', 'visibility', layers.myLocation ? 'visible' : 'none'));
}

function setTiles(tileSet) {
    loaded.then(() => {
        if (map.getLayer('tiles')) map.removeLayer('tiles');
        if (map.getSource('tiles')) map.removeSource('tiles');
        map.addSource('tiles', {
            type: 'raster',
            tiles: tileSet.tiles,
            tileSize: tileSet.tileSize,
            maxzoom: tileSet.maxzoom,
            attribution: tileSet.attribution,
        });
        // Under sun.js's night shading once it's there, else under everything drawn over the map.
        map.addLayer({ id: 'tiles', type: 'raster', source: 'tiles' }, map.getLayer('night') ? 'night' : 'accuracy');
    });
}

/** Called when the location moves more than LOCATION_MOVE_KM, or is cleared: for what depends on it. */
const locationListeners = [];
const LOCATION_MOVE_KM = 1;

function setLocation(lat, lon, accuracyM, centre) {
    const moved = !here || haversineKm(here[1], here[0], lat, lon) > LOCATION_MOVE_KM;
    here = [lon, lat];
    if (moved) for (const listener of locationListeners) listener();
    if (!marker) {
        const el = document.createElement('div');
        el.className = 'you';
        marker = new maplibregl.Marker({ element: el }).setLngLat(here).addTo(map);
        applyLocationLayer();
        sizeLocationMarker();
    } else {
        marker.setLngLat(here);
    }
    loaded.then(() => map.getSource('accuracy').setData(accuracyCircle(lat, lon, accuracyM)));
    if (centre) recentre();
}

/** Zoomed far out the full-size dot would dwarf the Earth, so it shrinks to a small, still point. */
function sizeLocationMarker() {
    marker?.getElement().classList.toggle('you-small', visualZoom() < SMALL_MARKER_ZOOM);
}
// On any move: panning towards a pole changes the zoom number too.
map.on('move', sizeLocationMarker);

function recentre() {
    if (!here) return;
    map.flyTo({ center: here, zoom: fitZoom(here[1]), bearing: 0, pitch: 0, duration: 2500 });
}

function emptyFeatures() {
    return { type: 'FeatureCollection', features: [] };
}

/** A polygon approximating a circle of radiusM metres around the point. */
function accuracyCircle(lat, lon, radiusM) {
    if (!(radiusM > 0)) return emptyFeatures();
    const steps = 64;
    const dLat = radiusM / 111320;
    const dLon = dLat / Math.max(Math.cos(lat * Math.PI / 180), 0.01);
    const ring = [];
    for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * 2 * Math.PI;
        ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

/** No location: a hand-set one turned off, until the phone's first fix. */
function clearLocation() {
    here = null;
    marker?.remove();
    marker = null;
    loaded.then(() => map.getSource('accuracy').setData(emptyFeatures()));
    for (const listener of locationListeners) listener();
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

window.globe = { setTiles, setLocation, clearLocation, recentre, setLayers };
