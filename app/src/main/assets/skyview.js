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
    /** The latest corrected reading; `rotation` follows it smoothly (stepOrientation). */
    target: null,
    steppedAt: 0,
};

/**
 * How quickly the drawn orientation catches up with the sensor's: the time constant (s) for a still
 * hand, where the sensor's jitter is all there is to follow, shrinking as the turn grows past
 * SMOOTH_FAST_DEGREES so real movement isn't left behind.
 */
const SMOOTH_SECONDS = 0.15, SMOOTH_FAST_DEGREES = 3;

function wantOrientation(who, on) {
    const before = orientation.users.size > 0;
    if (on) orientation.users.add(who); else orientation.users.delete(who);
    const after = orientation.users.size > 0;
    if (after && !before) orientation.raw = orientation.rotation = orientation.target = null;
    if (after !== before) window.Android?.setOrientationUpdates(after);
}

/** Called with each new orientation (calibrate.js counts the directions the phone has faced). */
const orientationListeners = [];

/** From MainActivity: SensorManager's rotation matrix, remapped to the screen's orientation. */
function setOrientation(matrix, headingError = -1) {
    orientation.raw = matrix;
    orientation.headingError = headingError;
    correctOrientation();
    for (const listener of orientationListeners) listener(matrix);
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
    compassStatusChanged();
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
    orientation.target = [
        cos * r[0] + sin * r[3], cos * r[1] + sin * r[4], cos * r[2] + sin * r[5],
        -sin * r[0] + cos * r[3], -sin * r[1] + cos * r[4], -sin * r[2] + cos * r[5],
        r[6], r[7], r[8],
    ];
    if (!orientation.rotation) orientation.rotation = orientation.target;
}

/** Moves the drawn orientation on towards the sensor's; sky view and the dish aligner call it each frame. */
function stepOrientation() {
    const target = orientation.target;
    if (!target) return;
    const now = performance.now();
    const seconds = Math.min((now - orientation.steppedAt) / 1000, 0.25);
    orientation.steppedAt = now;
    if (!orientation.rotation || orientation.rotation === target) {
        orientation.rotation = target;
        return;
    }
    const from = matrixToQuaternion(orientation.rotation), to = matrixToQuaternion(target);
    const degrees = 2 * Math.acos(Math.min(1, Math.abs(from.reduce((sum, c, i) => sum + c * to[i], 0)))) * 180 / Math.PI;
    const tau = SMOOTH_SECONDS / (1 + degrees / SMOOTH_FAST_DEGREES);
    orientation.rotation = quaternionToMatrix(slerp(from, to, 1 - Math.exp(-seconds / tau)));
}

/** Unit quaternion [w, x, y, z] of a row-major rotation matrix. */
function matrixToQuaternion([m00, m01, m02, m10, m11, m12, m20, m21, m22]) {
    const trace = m00 + m11 + m22;
    let q;
    if (trace > 0) {
        const s = 2 * Math.sqrt(trace + 1);
        q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
    } else if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
    } else if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
    } else {
        const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
        q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
    }
    const length = Math.hypot(...q);
    return q.map(c => c / length);
}

function quaternionToMatrix([w, x, y, z]) {
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
}

/** The rotation a share t of the way from quaternion a to b, the short way round. */
function slerp(a, b, t) {
    let cos = a.reduce((sum, c, i) => sum + c * b[i], 0);
    if (cos < 0) {
        b = b.map(c => -c);
        cos = -cos;
    }
    let wa = 1 - t, wb = t;
    if (cos < 0.9995) {
        const angle = Math.acos(cos), sin = Math.sin(angle);
        wa = Math.sin((1 - t) * angle) / sin;
        wb = Math.sin(t * angle) / sin;
    }
    const q = a.map((c, i) => wa * c + wb * b[i]);
    const length = Math.hypot(...q);
    return q.map(c => c / length);
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
    /** The planets: { name, dir, mag, color }. */
    planets: [],
    /** With layers.constellations: { name, dir, lines: [[dir, ...]] }, directions east/north/up. */
    constellations: [],
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
    const calibrate = document.createElement('button');
    calibrate.id = 'sky-calibrate';
    calibrate.className = 'sky-button';
    calibrate.textContent = '∞';
    calibrate.setAttribute('aria-label', 'Calibrate the compass');
    calibrate.addEventListener('click', openCalibration);
    document.body.append(sky.canvas, close, camera, calibrate);
    wantOrientation('sky', true);
    compassStatusChanged();
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
    document.getElementById('sky-calibrate').remove();
    wantOrientation('sky', false);
    compassStatusChanged();
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
    sky.planets = [];
    sky.constellations = [];
    if (!here) return;
    const [lon, lat] = here;
    for (const s of satellites.values()) {
        if (!s.now || !isDrawn(s)) continue;
        const p = toGlobe(s.now.lat, s.now.lon, s.now.altKm);
        const dir = skyDirection(p, lat, lon);
        if (dir[2] > 0) sky.visible.push({ sat: s, dir, sunlit: !inShadow(p, sun) });
    }
    const date = new Date(simNow());
    const gmst = satellite.gstime(date);
    const skyAt = (ra, dec) => skyDirection(eciToGlobe(raDecToEci(ra, dec), gmst).map(c => c * 1e6), lat, lon);
    if (layers.constellations) {
        for (const [name, [ra, dec], strokes] of CONSTELLATIONS) {
            const lines = strokes.map(flat => {
                const line = [];
                for (let i = 0; i < flat.length; i += 2) line.push(skyAt(flat[i], flat[i + 1]));
                return line;
            });
            // Any of it above the horizon.
            if (lines.some(line => line.some(dir => dir[2] > 0))) sky.constellations.push({ name, dir: skyAt(ra, dec), lines });
        }
    }
    if (!layers.stars) return;
    for (const [ra, dec, mag, bv, name] of STARS) {
        // Brightest first, so the rest are fainter still.
        if (mag > SKY_STAR_MAGNITUDE) break;
        const dir = skyAt(ra, dec);
        if (dir[2] < -0.05) continue;
        const [r, g, b] = starColor(bv).map(c => Math.round(c * 255));
        sky.stars.push({ dir, size: starSize(mag) / 2 + 0.3, color: `rgba(${r}, ${g}, ${b}, ${starAlpha(mag)})`, name });
    }
    for (const planet of planetsAt(date)) {
        const dir = skyAt(planet.ra, planet.dec);
        if (dir[2] > 0) sky.planets.push({ ...planet, dir });
    }
}

/** The sky without the camera, and the ground under the horizon, lighter by it and darker further down. */
const SKY_BACKGROUND = '#05070d';
const GROUND_NEAR = '#1b222b', GROUND_FAR = '#07090c';
/** How far above the horizon its faint glow reaches, px. */
const HORIZON_GLOW_PX = 60;
const CONSTELLATION_COLOR = 'rgba(140, 170, 255, 0.35)';
/** Which labels win where they would overlap (placeSkyLabels): the highest first. */
const LABEL_PRIORITY = {
    tracked: 100, body: 90, compass: 80, starred: 70, planet: 60, satellite: 50, aircraft: 45,
    geo: 30, star: 20, constellation: 10, degrees: 5,
};

function drawSky() {
    if (!sky.open) return;
    requestAnimationFrame(drawSky);
    stepOrientation();
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
    const camera = !!sky.video?.videoWidth;
    if (camera) ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = camera ? 'rgba(0, 0, 0, 0.2)' : SKY_BACKGROUND;
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
    /** Every label, drawn last by placeSkyLabels so the most important get the room. */
    const labels = [];

    // The constellations and stars first, so the ground hides those that have set.
    if (layers.constellations) drawConstellations(ctx, project, labels);
    for (const star of sky.stars) {
        const point = project(star.dir);
        if (!onScreen(point)) continue;
        ctx.fillStyle = star.color;
        ctx.beginPath();
        ctx.arc(point[0], point[1], star.size, 0, 2 * Math.PI);
        ctx.fill();
        if (star.name && star.dir[2] > 0) {
            labels.push({ text: star.name, x: point[0], y: point[1] + 14, priority: LABEL_PRIORITY.star, size: 11, color: 'rgba(255, 255, 255, 0.6)' });
        }
    }
    drawGround(ctx, width, height, focal, camera);
    drawHorizon(ctx, project, labels);

    const [lon, lat] = here;
    drawGeoArc(ctx, project, lat, lon, labels);

    const sunPoint = project(skyDirection(sun.map(c => c * 1e6), lat, lon));
    if (sunPoint) {
        const radius = bodyRadius(focal, SUN_RADIUS_DEGREES * Math.PI / 180, SKY_SUN_RADIUS_PX);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(sunPoint[0], sunPoint[1], radius, 0, 2 * Math.PI);
        ctx.fill();
        markSmall(ctx, sunPoint, radius, '#ffd166');
        labels.push({ text: 'Sun', x: sunPoint[0], y: sunPoint[1] - Math.max(radius, SMALL_BODY_RING_PX) - 6, priority: LABEL_PRIORITY.body });
        sky.drawn.push({ body: BODIES.sun, x: sunPoint[0], y: sunPoint[1] });
    }
    if (layers.stars) {
        drawPlanets(ctx, project, onScreen, labels);
        drawMoon(ctx, project, lat, lon, focal, labels);
    }

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
        // A dark rim, so the dot stays crisp over a bright sky or the camera.
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (style.featured || isSelected || starred || FRIENDLY_NAMES[s.id]) {
            labels.push({
                text: (starred ? '★ ' : '') + s.name, x: point[0], y: point[1] - 10, alt: point[1] + 20,
                priority: isSelected ? LABEL_PRIORITY.tracked : starred ? LABEL_PRIORITY.starred : LABEL_PRIORITY.satellite,
                // Kept on screen even when the satellite is near an edge.
                clamp: true, color: sunlit ? '#fff' : 'rgba(255, 255, 255, 0.65)',
            });
        }
        sky.drawn.push({ sat: s, x: point[0], y: point[1] });
    }

    drawAircraft(ctx, project, onScreen, lat, lon, labels);
    placeSkyLabels(ctx, labels, width);

    const target = trackedTarget(lat, lon);
    if (target) drawTracking(ctx, width, height, project, target);
}

/**
 * The ground below the horizon, so it is plain which way is down, and a faint glow along the horizon.
 * The horizon is a great circle, so on screen it is a straight line, and the ground the part of the
 * screen on its far side from the sky. Over the camera, only a light tint.
 */
function drawGround(ctx, width, height, focal, camera) {
    const [ux, uy, uz] = worldToDevice([0, 0, 1]);
    const cx = width / 2, cy = height / 2;
    // How far up the line of sight through a screen point goes ([(x - cx) / f, -(y - cy) / f, -1] in
    // the phone's frame, dotted with up): below the horizon where it is negative.
    const up = (x, y) => (ux * (x - cx) - uy * (y - cy)) / focal - uz;
    // The screen's corners on the ground's side, and where its edges cross the horizon.
    const corners = [[0, 0], [width, 0], [width, height], [0, height]];
    const ground = [];
    corners.forEach((p, i) => {
        const q = corners[(i + 1) % 4];
        const a = up(...p), b = up(...q);
        if (a < 0) ground.push(p);
        if ((a < 0) !== (b < 0)) {
            const t = a / (a - b);
            ground.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
        }
    });
    // Which way up rises fastest across the screen, and the horizon's nearest point to the middle.
    const gx = ux / focal, gy = -uy / focal, g2 = gx * gx + gy * gy;
    const level = g2 > 1e-12;
    const g = Math.sqrt(g2), k = level ? -up(cx, cy) / g2 : 0;
    const hx = cx + k * gx, hy = cy + k * gy;

    if (!camera && level) {
        const glow = ctx.createLinearGradient(hx, hy, hx + gx / g * HORIZON_GLOW_PX, hy + gy / g * HORIZON_GLOW_PX);
        glow.addColorStop(0, 'rgba(110, 231, 255, 0.12)');
        glow.addColorStop(1, 'rgba(110, 231, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, height);
    }
    if (ground.length < 3) return;
    ctx.beginPath();
    ground.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    if (camera) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    } else if (level) {
        const reach = Math.max(width, height);
        const shade = ctx.createLinearGradient(hx, hy, hx - gx / g * reach, hy - gy / g * reach);
        shade.addColorStop(0, GROUND_NEAR);
        shade.addColorStop(1, GROUND_FAR);
        ctx.fillStyle = shade;
    } else {
        // Looking straight down.
        ctx.fillStyle = GROUND_FAR;
    }
    ctx.fill();
}

/** The horizon with a tick every 5° (longer every 15°), the compass points, and circles 30° and 60° up. */
function drawHorizon(ctx, project, labels) {
    ctx.strokeStyle = 'rgba(110, 231, 255, 0.55)';
    ctx.lineWidth = 1.5;
    traceCurve(ctx, 0, 360, 3, az => project(direction(az, 0)));
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let az = 0; az < 360; az += 5) {
        const from = project(direction(az, 0)), to = project(direction(az, az % 15 ? 0.6 : 1.5));
        if (!from || !to) continue;
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    for (const elevation of [30, 60]) traceCurve(ctx, 0, 360, 3, az => project(direction(az, elevation)));

    // Under the horizon, clear of the ticks.
    for (let az = 0; az < 360; az += 15) {
        const point = project(direction(az, 0));
        if (!point) continue;
        if (az % 45 === 0) {
            labels.push({ text: compass(az), x: point[0], y: point[1] + 17, priority: LABEL_PRIORITY.compass, weight: 600, color: 'rgba(255, 255, 255, 0.9)' });
        } else {
            labels.push({ text: `${az}°`, x: point[0], y: point[1] + 15, priority: LABEL_PRIORITY.degrees, size: 10, color: 'rgba(110, 231, 255, 0.6)' });
        }
    }
    const zenith = project([0, 0, 1]);
    if (zenith) labels.push({ text: 'Overhead', x: zenith[0], y: zenith[1] - 8, priority: LABEL_PRIORITY.compass, color: 'rgba(255, 255, 255, 0.85)' });
}

/** The constellations' stick figures (layers.constellations), faintly, and their names. */
function drawConstellations(ctx, project, labels) {
    ctx.strokeStyle = CONSTELLATION_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const { lines } of sky.constellations) {
        for (const line of lines) {
            let previous = null;
            for (const dir of line) {
                // A straight line on screen is the great circle between the stars, as it should be.
                const point = dir[2] > -0.02 ? project(dir) : null;
                if (point && previous) {
                    ctx.moveTo(previous[0], previous[1]);
                    ctx.lineTo(point[0], point[1]);
                }
                previous = point;
            }
        }
    }
    ctx.stroke();
    for (const { name, dir } of sky.constellations) {
        const point = dir[2] > 0 ? project(dir) : null;
        if (point) labels.push({ text: name.toUpperCase(), x: point[0], y: point[1], priority: LABEL_PRIORITY.constellation, size: 10, color: 'rgba(160, 185, 255, 0.6)' });
    }
}

/** The planets, sized by brightness, each with a soft glow in its colour. */
function drawPlanets(ctx, project, onScreen, labels) {
    for (const { name, dir, mag, color: [r, g, b] } of sky.planets) {
        const point = project(dir);
        if (!onScreen(point)) continue;
        const [x, y] = point;
        const radius = Math.max(1.8, 3.4 - 0.45 * mag);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.5);
        glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.45)`);
        glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, radius * 3.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
        labels.push({ text: name, x, y: y - radius - 7, alt: y + radius + 15, priority: LABEL_PRIORITY.planet, color: `rgb(${r}, ${g}, ${b})` });
    }
}

/** Aircraft above the horizon, as small planes in their altitude colour, labelled once 5° up. */
function drawAircraft(ctx, project, onScreen, lat, lon, labels) {
    for (const { a, az, el: elevation } of aircraftInView(lat, lon)) {
        const point = project(direction(az, elevation));
        if (!onScreen(point)) continue;
        const isSelected = a === selectedAircraft;
        ctx.font = `${isSelected ? 20 : 15}px system-ui, sans-serif`;
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.strokeText('✈', point[0], point[1] + 5);
        ctx.fillStyle = isSelected ? '#fff' : AIRCRAFT_BANDS[aircraftBand(a)].css;
        ctx.fillText('✈', point[0], point[1] + 5);
        if (isSelected || elevation >= 5) {
            labels.push({
                text: `${a.name} · ${describeAltitude(a)}`, x: point[0], y: point[1] - 12, alt: point[1] + 24,
                priority: isSelected ? LABEL_PRIORITY.tracked : LABEL_PRIORITY.aircraft, clamp: true,
            });
        }
        sky.drawn.push({ aircraft: a, x: point[0], y: point[1] });
    }
    ctx.font = '13px system-ui, sans-serif';
}

/**
 * Draws the labels, the most important first, each where it covers none already drawn: at its
 * place, or its second place (alt) if it has one; failing both it is left out, unless it is the
 * tracked one's. Outlined in black, to read over the camera's picture as well as the dark.
 * A label is { text, x, y, priority, alt?, size? (px), weight?, color?, clamp? (kept on screen) }.
 */
function placeSkyLabels(ctx, labels, width) {
    labels.sort((a, b) => b.priority - a.priority);
    const placed = [];
    const free = box => !placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]);
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    for (const label of labels) {
        const size = label.size ?? 13;
        ctx.font = `${label.weight ?? 400} ${size}px system-ui, sans-serif`;
        const half = ctx.measureText(label.text).width / 2 + 2;
        const x = label.clamp ? Math.min(Math.max(label.x, half + 2), width - half - 2) : label.x;
        const box = y => [x - half, y - size, x + half, y + size * 0.35];
        let y = [label.y, label.alt].find(y => y != null && free(box(y)));
        if (y == null) {
            if (label.priority < LABEL_PRIORITY.tracked) continue;
            y = label.y;
        }
        placed.push(box(y));
        ctx.strokeText(label.text, x, y);
        ctx.fillStyle = label.color ?? '#fff';
        ctx.fillText(label.text, x, y);
    }
    ctx.font = '13px system-ui, sans-serif';
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
function drawGeoArc(ctx, project, lat, lon, labels) {
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
    let labelled = false;
    for (let satLon = Math.ceil((lon - 90) / 10) * 10; satLon <= lon + 90; satLon += 10) {
        const point = at(satLon);
        if (!point) continue;
        ctx.beginPath();
        ctx.arc(point[0], point[1], 2, 0, 2 * Math.PI);
        ctx.fill();
        const wrapped = ((satLon + 540) % 360) - 180;
        const text = wrapped === 0 ? '0°' : `${Math.abs(wrapped)}°${wrapped > 0 ? 'E' : 'W'}`;
        labels.push({ text, x: point[0], y: point[1] + 14, priority: LABEL_PRIORITY.geo, size: 11, color: GEO_ARC_COLOR });
        // Name the arc once, by the first longitude in view.
        if (!labelled) {
            labels.push({ text: 'Geostationary arc', x: point[0], y: point[1] - 8, priority: LABEL_PRIORITY.geo, size: 11, color: GEO_ARC_COLOR });
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
function drawMoon(ctx, project, lat, lon, focal, labels) {
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
    labels.push({ text: `Moon · ${Math.round(moon.lit * 100)}%`, x: point[0], y: point[1] - Math.max(radius, SMALL_BODY_RING_PX) - 6, priority: LABEL_PRIORITY.body });
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
