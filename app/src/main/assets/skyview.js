'use strict';

// Sky view: hold the phone up and see what is overhead in that direction. MainActivity reads the
// rotation sensor while it is open (Android.setOrientationUpdates) and sends the phone's orientation
// through globe.setOrientation(); this draws the horizon, compass points, the geostationary arc, the
// Sun, Moon and stars, and every satellite above the horizon, as seen looking out of the back of the
// phone; over the camera's picture if the user turns it on.
//
// The orientation is shared with the dish aligner (dish.js). The sensor's north is magnetic north, so
// headings are turned by the declination here (from MainActivity) and the user's own calibration.

/** Field of view across the screen's shorter side, without the camera. */
const SKY_FOV_DEGREES = 70;
/** The camera's field of view across its long side when the phone doesn't say. */
const DEFAULT_CAMERA_FOV = 66;
const SKY_TAP_RADIUS_PX = 30;
const SKY_TRACK_COLOR = '#6ee7ff';
const GEO_ARC_COLOR = 'rgba(110, 231, 255, 0.75)';
/** The Sun's and Moon's radius in sky view, enlarged; see bodyRadius(). Smaller ones get a ring this size. */
const SKY_SUN_RADIUS_PX = 10, SKY_MOON_RADIUS_PX = 11, SMALL_BODY_RING_PX = 9;
/** Faintest star drawn in sky view. */
const SKY_STAR_MAGNITUDE = 4.5;

// ---- Orientation (shared with dish.js) ----

const orientation = {
    /** Device-to-world rotation (row-major 3x3, world = east, true north, up), or null before the first reading. */
    rotation: null,
    /** The sensor's own, magnetic north, reading. */
    raw: null,
    /** The sensor's estimate of its heading error in degrees, or -1 when it doesn't give one. */
    headingError: -1,
    /** SensorManager.SENSOR_STATUS_* of the magnetometer: 0 unreliable, 1 low, 2 medium, 3 high. */
    status: 3,
    /** Magnetic declination here (east positive), and the user's calibration, both added to headings. */
    declination: 0,
    offset: 0,
    /** Whether the declination is from a real location. */
    located: false,
    /** Who wants readings ('sky', 'dish'); MainActivity reads the sensor while anyone does. */
    users: new Set(),
};

function wantOrientation(who, on) {
    const before = orientation.users.size > 0;
    if (on) orientation.users.add(who); else orientation.users.delete(who);
    const after = orientation.users.size > 0;
    if (after && !before) orientation.raw = orientation.rotation = null;
    if (after !== before) window.Android?.setOrientationUpdates(after);
}

/** From MainActivity: SensorManager's rotation matrix, remapped to the screen's orientation. */
function setOrientation(matrix, headingError = -1) {
    orientation.raw = matrix;
    orientation.headingError = headingError;
    correctOrientation();
}

/** From MainActivity: the declination at the user's location and the saved calibration. */
function setCompass(declination, offset, located) {
    orientation.declination = declination;
    orientation.offset = offset;
    orientation.located = located;
    correctOrientation();
}

function setCompassStatus(status) {
    orientation.status = status;
}

/** Degrees added to the sensor's headings to make them true ones. */
function headingCorrection() {
    return orientation.declination + orientation.offset;
}

/** The raw rotation turned about the vertical by headingCorrection(), so north is true north. */
function correctOrientation() {
    const r = orientation.raw;
    if (!r) return;
    const c = headingCorrection() * Math.PI / 180;
    const cos = Math.cos(c), sin = Math.sin(c);
    // World vectors turned so azimuths grow by c: east' = east cos c + north sin c, and so on.
    orientation.rotation = [
        cos * r[0] + sin * r[3], cos * r[1] + sin * r[4], cos * r[2] + sin * r[5],
        -sin * r[0] + cos * r[3], -sin * r[1] + cos * r[4], -sin * r[2] + cos * r[5],
        r[6], r[7], r[8],
    ];
}

/** Device coordinates (x right, y up the screen, z out of the screen) of a world (east, north, up) vector. */
function worldToDevice([e, n, u]) {
    const r = orientation.rotation;
    return [r[0] * e + r[3] * n + r[6] * u, r[1] * e + r[4] * n + r[7] * u, r[2] * e + r[5] * n + r[8] * u];
}

/** World (east, north, up) coordinates of a device vector. */
function deviceToWorld([x, y, z]) {
    const r = orientation.rotation;
    return [r[0] * x + r[1] * y + r[2] * z, r[3] * x + r[4] * y + r[5] * z, r[6] * x + r[7] * y + r[8] * z];
}

/** Azimuth and elevation in degrees of an east/north/up direction. */
function azEl([e, n, u]) {
    const length = Math.hypot(e, n, u);
    return [(Math.atan2(e, n) * 180 / Math.PI + 360) % 360, Math.asin(u / length) * 180 / Math.PI];
}

/** The east/north/up unit vector for an azimuth and elevation in degrees. */
function direction(az, el) {
    const a = az * Math.PI / 180, h = el * Math.PI / 180;
    return [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
}

// ---- Sky view ----

const sky = {
    open: false,
    canvas: null,
    video: null,
    /** The camera's field of view (degrees) across its long and short sides, from MainActivity. */
    cameraFov: null,
    /** Satellites above the horizon: { sat, dir: [east, north, up] unit vector, sunlit }. */
    visible: [],
    /** Stars above the horizon: { dir, size, color, name }. */
    stars: [],
    visibleAt: 0,
    /** Where each satellite was drawn in the last frame, for taps. */
    drawn: [],
};

function openSkyView() {
    if (sky.open) return;
    sky.open = true;
    sky.canvas = document.createElement('canvas');
    sky.canvas.id = 'sky';
    sky.canvas.addEventListener('click', e => {
        const hit = sky.drawn.find(d => Math.hypot(d.x - e.offsetX, d.y - e.offsetY) < SKY_TAP_RADIUS_PX);
        if (hit?.body) selectBody(hit.body);
        else if (hit?.aircraft) selectAircraft(hit.aircraft);
        else if (hit) select(hit.sat);
    });
    const close = document.createElement('button');
    close.id = 'sky-close';
    close.className = 'sky-button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close sky view');
    close.addEventListener('click', closeSkyView);
    const camera = document.createElement('button');
    camera.id = 'sky-camera';
    camera.className = 'sky-button';
    camera.textContent = '📷';
    camera.setAttribute('aria-label', 'Camera');
    camera.addEventListener('click', toggleCamera);
    document.body.append(sky.canvas, close, camera);
    wantOrientation('sky', true);
    overlaysChanged();
    requestAnimationFrame(drawSky);
}

function closeSkyView() {
    if (!sky.open) return;
    sky.open = false;
    stopCamera();
    sky.canvas.remove();
    document.getElementById('sky-close').remove();
    document.getElementById('sky-camera').remove();
    wantOrientation('sky', false);
    overlaysChanged();
}

function toggleSkyView() {
    if (sky.open) closeSkyView(); else openSkyView();
}

// ---- Camera background ----

function toggleCamera() {
    if (sky.video) stopCamera(); else startCamera();
}

async function startCamera() {
    const video = document.createElement('video');
    video.id = 'sky-video';
    video.setAttribute('playsinline', '');
    video.muted = true;
    sky.video = video;
    document.getElementById('sky-camera')?.classList.add('on');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
            audio: false,
        });
        // Closed, or turned off again, while waiting for permission.
        if (sky.video !== video) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        video.srcObject = stream;
        document.body.appendChild(video);
        await video.play();
    } catch (e) {
        console.error('No camera', e);
        if (sky.video === video) stopCamera();
    }
}

function stopCamera() {
    const video = sky.video;
    sky.video = null;
    document.getElementById('sky-camera')?.classList.remove('on');
    if (!video) return;
    video.srcObject?.getTracks().forEach(track => track.stop());
    video.remove();
}

function setCameraFov(long, short) {
    sky.cameraFov = [long, short];
}

/**
 * Pixels on screen per unit of tan(angle) off the middle: from the camera's field of view while it
 * is on, so the drawing lines up with its picture (shown with object-fit: cover), else a fixed view.
 */
function skyFocal(width, height) {
    const video = sky.video;
    if (video?.videoWidth) {
        const fovLong = (sky.cameraFov?.[0] ?? DEFAULT_CAMERA_FOV) * Math.PI / 180;
        const vw = video.videoWidth, vh = video.videoHeight;
        // A 16:9 picture from a 4:3 sensor is cropped top and bottom; its long side is the sensor's.
        const videoFocal = Math.max(vw, vh) / 2 / Math.tan(fovLong / 2);
        return videoFocal * Math.max(width / vw, height / vh);
    }
    return Math.min(width, height) / 2 / Math.tan(SKY_FOV_DEGREES / 2 * Math.PI / 180);
}

// ---- What is up ----

/** Direction from the user to a globe-space point, as an east/north/up unit vector. */
function skyDirection(p, lat, lon) {
    const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
    const o = toGlobe(lat, lon, 0);
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const east = [Math.cos(lambda), 0, -Math.sin(lambda)];
    const north = [-Math.sin(phi) * Math.sin(lambda), Math.cos(phi), -Math.sin(phi) * Math.cos(lambda)];
    const up = o;
    const e = dot(d, east), n = dot(d, north), u = dot(d, up);
    const length = Math.hypot(e, n, u);
    return [e / length, n / length, u / length];
}

/** Which satellites and stars are above the horizon; refreshed with the positions, not every frame. */
function updateVisible() {
    sky.visibleAt = Date.now();
    sky.visible = [];
    sky.stars = [];
    if (!here) return;
    const [lon, lat] = here;
    for (const s of satellites.values()) {
        if (!s.now || !isDrawn(s)) continue;
        const p = toGlobe(s.now.lat, s.now.lon, s.now.altKm);
        const dir = skyDirection(p, lat, lon);
        if (dir[2] > 0) sky.visible.push({ sat: s, dir, sunlit: !inShadow(p, sun) });
    }
    if (!layers.stars) return;
    const gmst = satellite.gstime(new Date(simNow()));
    for (const [ra, dec, mag, bv, name] of STARS) {
        // Brightest first, so the rest are fainter still.
        if (mag > SKY_STAR_MAGNITUDE) break;
        const far = eciToGlobe(raDecToEci(ra, dec), gmst).map(c => c * 1e6);
        const dir = skyDirection(far, lat, lon);
        if (dir[2] < -0.05) continue;
        const [r, g, b] = starColor(bv).map(c => Math.round(c * 255));
        sky.stars.push({ dir, size: starSize(mag) / 2 + 0.3, color: `rgba(${r}, ${g}, ${b}, ${starAlpha(mag)})`, name });
    }
}

function drawSky() {
    if (!sky.open) return;
    requestAnimationFrame(drawSky);
    const canvas = sky.canvas;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // Over the camera, only a light tint so the drawing stands out.
    if (sky.video?.videoWidth) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    } else {
        ctx.fillStyle = '#05070d';
    }
    ctx.fillRect(0, 0, width, height);
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    sky.drawn = [];

    const message = !here ? 'Waiting for your location…'
        : !orientation.rotation ? 'Waiting for the compass… If this stays, the phone may have no rotation sensor.'
        : null;
    if (message) {
        ctx.fillStyle = '#fff';
        ctx.fillText(message, width / 2, height / 2, width - 32);
        return;
    }
    if (Date.now() - sky.visibleAt > TICK_MS) updateVisible();

    const focal = skyFocal(width, height);
    /** Screen position of an east/north/up direction, or null if it is behind the phone. */
    const project = dir => {
        const [x, y, z] = worldToDevice(dir);
        // The camera looks out of the back of the phone, along -z.
        if (z > -0.05) return null;
        return [width / 2 + focal * x / -z, height / 2 - focal * y / -z];
    };
    const onScreen = point => point && point[0] > -20 && point[1] > -20 && point[0] < width + 20 && point[1] < height + 20;

    // Stars first, under everything else.
    for (const star of sky.stars) {
        const point = project(star.dir);
        if (!onScreen(point)) continue;
        ctx.fillStyle = star.color;
        ctx.beginPath();
        ctx.arc(point[0], point[1], star.size, 0, 2 * Math.PI);
        ctx.fill();
        if (star.name) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.font = '11px system-ui, sans-serif';
            ctx.fillText(star.name, point[0], point[1] + 14);
            ctx.font = '13px system-ui, sans-serif';
        }
    }

    // The horizon, and faint circles 30° and 60° up.
    ctx.strokeStyle = 'rgba(110, 231, 255, 0.5)';
    ctx.lineWidth = 1.5;
    traceCurve(ctx, 0, 360, 3, az => project(direction(az, 0)));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    for (const el of [30, 60]) traceCurve(ctx, 0, 360, 3, az => project(direction(az, el)));

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((label, i) => {
        const point = project(direction(i * 45, 0));
        if (point) ctx.fillText(label, point[0], point[1] - 8);
    });
    const zenith = project([0, 0, 1]);
    if (zenith) ctx.fillText('Overhead', zenith[0], zenith[1] - 8);

    const [lon, lat] = here;
    drawGeoArc(ctx, project, lat, lon);

    const sunPoint = project(skyDirection(sun.map(c => c * 1e6), lat, lon));
    if (sunPoint) {
        const radius = bodyRadius(focal, SUN_RADIUS_DEGREES * Math.PI / 180, SKY_SUN_RADIUS_PX);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(sunPoint[0], sunPoint[1], radius, 0, 2 * Math.PI);
        ctx.fill();
        markSmall(ctx, sunPoint, radius, '#ffd166');
        ctx.fillText('Sun', sunPoint[0], sunPoint[1] - Math.max(radius, SMALL_BODY_RING_PX) - 6);
        sky.drawn.push({ body: BODIES.sun, x: sunPoint[0], y: sunPoint[1] });
    }
    if (layers.stars) drawMoon(ctx, project, lat, lon, focal);

    for (const { sat: s, dir, sunlit } of sky.visible) {
        const point = project(dir);
        if (!onScreen(point)) continue;
        const style = groupStyles[s.group];
        const isSelected = s === selected;
        const starred = favourites.has(s.id);
        ctx.globalAlpha = sunlit ? 1 : SHADOW_OPACITY + 0.2;
        ctx.fillStyle = isSelected ? '#fff' : style.css;
        ctx.beginPath();
        ctx.arc(point[0], point[1], isSelected ? 6 : style.featured || starred ? 5 : 3, 0, 2 * Math.PI);
        ctx.fill();
        if (style.featured || isSelected || starred || FRIENDLY_NAMES[s.id]) {
            ctx.fillStyle = '#fff';
            const name = (starred ? '★ ' : '') + s.name;
            // Kept on screen even when the satellite is near an edge.
            const half = ctx.measureText(name).width / 2 + 4;
            ctx.fillText(name, Math.min(Math.max(point[0], half), width - half), point[1] - 10);
        }
        ctx.globalAlpha = 1;
        sky.drawn.push({ sat: s, x: point[0], y: point[1] });
    }

    drawAircraft(ctx, width, project, onScreen, lat, lon);

    const target = trackedTarget(lat, lon);
    if (target) drawTracking(ctx, width, height, project, target);
}

/** Aircraft above the horizon, as small planes in their altitude colour, labelled once 5° up. */
function drawAircraft(ctx, width, project, onScreen, lat, lon) {
    for (const { a, az, el: elevation } of aircraftInView(lat, lon)) {
        const point = project(direction(az, elevation));
        if (!onScreen(point)) continue;
        const isSelected = a === selectedAircraft;
        ctx.fillStyle = isSelected ? '#fff' : AIRCRAFT_BANDS[aircraftBand(a)].css;
        ctx.font = `${isSelected ? 20 : 15}px system-ui, sans-serif`;
        ctx.fillText('✈', point[0], point[1] + 5);
        ctx.font = '13px system-ui, sans-serif';
        if (isSelected || elevation >= 5) {
            ctx.fillStyle = '#fff';
            const name = `${a.name} · ${describeAltitude(a)}`;
            const half = ctx.measureText(name).width / 2 + 4;
            ctx.fillText(name, Math.min(Math.max(point[0], half), width - half), point[1] - 12);
        }
        sky.drawn.push({ aircraft: a, x: point[0], y: point[1] });
    }
}

/** What sky view is guiding the user to: the selected satellite, Sun or Moon, as { name, dir }. */
function trackedTarget(lat, lon) {
    if (selected?.now) return { name: selected.name, dir: skyDirection(toGlobe(selected.now.lat, selected.now.lon, selected.now.altKm), lat, lon) };
    if (selectedAircraft) {
        const { az, el: elevation } = aircraftLook(selectedAircraft, lat, lon);
        return { name: selectedAircraft.name, dir: direction(az, elevation) };
    }
    if (selectedBody?.kind === 'sun') return { name: 'Sun', dir: skyDirection(sun.map(c => c * 1e6), lat, lon) };
    if (selectedBody?.kind === 'moon') return { name: 'Moon', dir: skyDirection(moon.globe, lat, lon) };
    return null;
}

/**
 * The geostationary arc: where in the sky the satellites over the equator sit, from this location,
 * with their longitudes marked. A dish for a geostationary satellite points somewhere along it.
 */
function drawGeoArc(ctx, project, lat, lon) {
    const at = satLon => {
        const dir = skyDirection(toGlobe(0, satLon, GEO_ALTITUDE_KM), lat, lon);
        return dir[2] > 0 ? project(dir) : null;
    };
    ctx.save();
    ctx.strokeStyle = GEO_ARC_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    traceCurve(ctx, lon - 90, lon + 90, 1, at);
    ctx.setLineDash([]);
    ctx.fillStyle = GEO_ARC_COLOR;
    ctx.font = '11px system-ui, sans-serif';
    let labelled = false;
    for (let satLon = Math.ceil((lon - 90) / 10) * 10; satLon <= lon + 90; satLon += 10) {
        const point = at(satLon);
        if (!point) continue;
        ctx.beginPath();
        ctx.arc(point[0], point[1], 2, 0, 2 * Math.PI);
        ctx.fill();
        const wrapped = ((satLon + 540) % 360) - 180;
        ctx.fillText(wrapped === 0 ? '0°' : `${Math.abs(wrapped)}°${wrapped > 0 ? 'E' : 'W'}`, point[0], point[1] + 14);
        // Name the arc once, by the first longitude in view.
        if (!labelled) {
            ctx.fillText('Geostationary arc', point[0], point[1] - 8);
            labelled = true;
        }
    }
    ctx.restore();
}

/**
 * How big to draw the Sun or Moon (angular radius in radians): at their true size over the camera's
 * picture, so they sit on the real ones, or when the user wants true scale; else `enlarged` px, so
 * they are easy to see and tap.
 */
function bodyRadius(focal, angularRadius, enlarged) {
    if (!layers.trueScale && !sky.video?.videoWidth) return enlarged;
    return Math.max(1, focal * Math.tan(angularRadius));
}

/** A faint ring round a body drawn too small to find easily. */
function markSmall(ctx, point, radius, color) {
    if (radius >= SMALL_BODY_RING_PX - 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(point[0], point[1], SMALL_BODY_RING_PX, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
}

/** The Moon, with its phase: lit on the side towards the Sun. */
function drawMoon(ctx, project, lat, lon, focal) {
    const dir = skyDirection(moon.globe, lat, lon);
    const point = project(dir);
    if (!point) return;
    const radius = bodyRadius(focal, sourceRadius(transitSource('moon', new Date(simNow())), toGlobe(lat, lon, 0)), SKY_MOON_RADIUS_PX);
    // Which way the Sun is from the Moon across the screen: a nudge towards it, projected.
    const toSun = skyDirection(sun.map(c => c * 1e6), lat, lon);
    const k = dot(toSun, dir);
    const nudge = toSun.map((c, i) => dir[i] + 0.02 * (c - k * dir[i]));
    const towards = project(nudge);
    const angle = towards ? Math.atan2(towards[1] - point[1], towards[0] - point[0]) : 0;
    ctx.save();
    ctx.translate(point[0], point[1]);
    ctx.rotate(angle);
    // Dark disc, the lit half facing the Sun (+x), then the terminator's ellipse adding or taking light.
    ctx.fillStyle = '#2a2d33';
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#e8e6dc';
    ctx.beginPath();
    ctx.arc(0, 0, radius, -Math.PI / 2, Math.PI / 2);
    ctx.fill();
    ctx.fillStyle = moon.lit > 0.5 ? '#e8e6dc' : '#2a2d33';
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * Math.abs(1 - 2 * moon.lit), radius, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    markSmall(ctx, point, radius, '#e8e6dc');
    ctx.fillStyle = '#fff';
    ctx.fillText(`Moon · ${Math.round(moon.lit * 100)}%`, point[0], point[1] - Math.max(radius, SMALL_BODY_RING_PX) - 6);
    sky.drawn.push({ body: BODIES.moon, x: point[0], y: point[1] });
}

/**
 * Keeps the selected satellite (or Sun or Moon) findable: a ring round it when it is in view,
 * otherwise an arrow at the screen's edge pointing the way to turn, and a line at the top saying
 * where to look.
 */
function drawTracking(ctx, width, height, project, { name, dir }) {
    const [az, el] = azEl(dir);
    const point = project(dir);
    // The status line sits level with the close button, below the status bar.
    const pillTop = (document.getElementById('sky-close')?.offsetTop ?? 24) + 5;
    // Keep clear of the status line above and the info sheet below.
    const top = pillTop + 36, bottom = height - (sheet.node?.offsetHeight ?? 0) - 24;
    const onScreen = point && point[0] > 24 && point[0] < width - 24 && point[1] > top && point[1] < bottom;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
    ctx.strokeStyle = SKY_TRACK_COLOR;

    if (onScreen) {
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.6 + 0.4 * pulse;
        ctx.beginPath();
        ctx.arc(point[0], point[1], 14 + 4 * pulse, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.globalAlpha = 1;
    } else {
        // Which way round to turn: the satellite's direction across the screen, up being up.
        const [x, y] = worldToDevice(dir);
        const angle = Math.hypot(x, y) < 1e-6 ? Math.PI / 2 : Math.atan2(-y, x);
        const cx = width / 2, cy = (top + bottom) / 2;
        const dx = Math.cos(angle), dy = Math.sin(angle);
        // Where the ray from the middle meets the inset edge.
        const reach = Math.min(
            dx ? (width / 2 - 32) / Math.abs(dx) : Infinity,
            dy ? ((bottom - top) / 2 - 8) / Math.abs(dy) : Infinity);
        ctx.save();
        ctx.translate(cx + dx * reach, cy + dy * reach);
        ctx.rotate(angle);
        ctx.fillStyle = SKY_TRACK_COLOR;
        ctx.globalAlpha = 0.7 + 0.3 * pulse;
        ctx.beginPath();
        ctx.moveTo(16, 0);
        ctx.lineTo(-10, -13);
        ctx.lineTo(-4, 0);
        ctx.lineTo(-10, 13);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    const where = el < 0
        ? `below the horizon (${Math.round(el)}°), towards ${compass(az)}`
        : `${compass(az)} ${Math.round(az)}°, ${Math.round(el)}° up`;
    const text = `${name}: ${where}`;
    ctx.font = '600 14px system-ui, sans-serif';
    const w = Math.min(ctx.measureText(text).width + 24, width - 120);
    ctx.fillStyle = 'rgba(10, 14, 22, 0.85)';
    ctx.beginPath();
    ctx.roundRect(width / 2 - w / 2, pillTop, w, 30, 15);
    ctx.fill();
    ctx.strokeStyle = SKY_TRACK_COLOR;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(text, width / 2, pillTop + 20, w - 16);
}

/** Strokes the curve through at(v) for v from `from` to `to`, breaking where it goes behind the phone. */
function traceCurve(ctx, from, to, step, at) {
    ctx.beginPath();
    let drawing = false;
    for (let v = from; v <= to; v += step) {
        const point = at(v);
        if (!point) { drawing = false; continue; }
        if (drawing) ctx.lineTo(point[0], point[1]); else ctx.moveTo(point[0], point[1]);
        drawing = true;
    }
    ctx.stroke();
}

window.globe.toggleSkyView = toggleSkyView;
window.globe.setOrientation = setOrientation;
window.globe.setCompass = setCompass;
window.globe.setCompassStatus = setCompassStatus;
window.globe.setCameraFov = setCameraFov;
