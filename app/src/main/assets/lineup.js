'use strict';

// Lining the compass up on the Sun or Moon over the camera's picture. The view draws where the
// sensors say the body is (a ring, on its line of azimuth, over the horizon and its compass marks),
// and moves it sideways onto the real Sun or Moon: by itself in Auto, which finds the body in the
// picture as the brightest small blob at the height the sensors give; or by the user's finger in
// Manual. Set saves it.
// Only the heading moves: tilt comes from the accelerometer, which is good to a fraction of a degree,
// so a drag is turned into a change of azimuth alone (its part along the way the body moves as the
// heading turns), and the ring keeps the height the sensors give it. The change is added to the
// saved calibration (setCompassOffset, dish.js).
//
// Opened from the dish aligner (Calibrate on Sun / Moon) and the compass calibration sheet. Always
// for the real time, whatever time.js's clock says. Without a camera, the dish aligner falls back
// to aiming the phone at the body and tapping Set.

/** The ring drawn round the body, px: much bigger than the body itself, so the real one shows inside. */
const LINEUP_RING_PX = 18;
/** The fine steps' size, degrees. */
const LINEUP_STEP_DEGREES = 0.1;
const LINEUP_REFRESH_MS = 100;
const LINEUP_COLOR = '#6ee7ff';
const LINEUP_FOUND_COLOR = '#ffd166';
const LINEUP_MODE_KEY = 'lineup.mode';

// Auto: the body found in the picture, as the brightest small blob there, a few times a second.
/** Width the picture is shrunk to for the search, px; and how often it is searched. */
const LINEUP_SAMPLE_PX = 192, LINEUP_DETECT_MS = 150;
/** The brightest spot must be at least this bright (0–255), and this much brighter than the picture's average. */
const LINEUP_MIN_BRIGHTNESS = 150, LINEUP_MIN_CONTRAST = 60;
/** A blob bigger than this share of the picture is a bright cloud or sky, not the body. */
const LINEUP_MAX_BLOB_SHARE = 0.04;
/**
 * A blob further than this (degrees) above or below where the sensors put the body is something
 * else: the tilt is good to a fraction of a degree, so only the heading can be that far out.
 */
const LINEUP_MAX_TILT_MISS = 4;
/** Nor can the heading be out by more than this. */
const LINEUP_MAX_SHIFT = 45;
/** Each find moves the ring this share of the way, to steady it; within LINEUP_STEADY degrees for LINEUP_STEADY_MS is locked. */
const LINEUP_FOLLOW = 0.5, LINEUP_STEADY = 0.15, LINEUP_STEADY_MS = 1000;
/** A find older than this is lost. */
const LINEUP_LOST_MS = 600;

const lineUp = {
    node: null,
    canvas: null,
    video: null,
    /** 'sun' or 'moon'. */
    body: null,
    /** Degrees the user has slid the heading by, not saved yet. */
    shift: 0,
    /** Screen px the body moves for each degree of shift, from the last frame; null when it is off screen. */
    perDegree: null,
    /** The pointer being dragged: its id and last position. */
    drag: null,
    /** What to do instead when there is no camera, if anything. */
    fallback: null,
    /** Sky view's own camera, stopped while this one runs. */
    restartSkyCamera: false,
    refreshedAt: 0,
    /** 'auto' (found in the picture) or 'manual' (slid by hand); remembered. */
    mode: readLineUpMode(),
    /** Auto: where the body was last found on screen { x, y, at }, or null. */
    found: null,
    /** Auto: since when the finds have stayed within LINEUP_STEADY of the ring (ms), or 0. */
    steadySince: 0,
    detectedAt: 0,
    /** The shrunk picture searched. */
    sample: null,
};

function readLineUpMode() {
    try {
        return localStorage.getItem(LINEUP_MODE_KEY) === 'manual' ? 'manual' : 'auto';
    } catch {
        return 'auto';
    }
}

function setLineUpMode(mode) {
    lineUp.mode = mode;
    lineUp.found = null;
    lineUp.steadySince = 0;
    try {
        localStorage.setItem(LINEUP_MODE_KEY, mode);
    } catch {
        // Not kept, then.
    }
    lineUp.node?.querySelectorAll('.lineup-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
}

function openLineUp(body, fallback = null) {
    if (lineUp.node) closeLineUp();
    closeCalibration();
    lineUp.body = body;
    lineUp.shift = 0;
    lineUp.perDegree = null;
    lineUp.drag = null;
    lineUp.fallback = fallback;
    lineUp.found = null;
    lineUp.steadySince = 0;
    const name = bodyName(body);

    const node = el('div', 'lineup');
    const canvas = el('canvas', 'lineup-sky');
    canvas.addEventListener('pointerdown', e => {
        lineUp.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
        const drag = lineUp.drag;
        if (drag?.id !== e.pointerId) return;
        // Sliding by hand takes over from auto.
        if (lineUp.mode === 'auto') setLineUpMode('manual');
        slideLineUp(e.clientX - drag.x, e.clientY - drag.y);
        drag.x = e.clientX;
        drag.y = e.clientY;
    });
    const endDrag = e => { if (lineUp.drag?.id === e.pointerId) lineUp.drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    const top = el('div', 'lineup-top');
    const title = el('div', 'sheet-title');
    title.append(el('b', '', `Line up on the ${name}`),
        el('div', 'sheet-sub lineup-how'));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeLineUp);
    top.append(title, close);

    const panel = el('div', 'lineup-panel');
    const mode = el('div', 'segmented lineup-mode');
    for (const [value, label] of [['auto', 'Auto'], ['manual', 'Manual']]) {
        const button = el('button', value === lineUp.mode ? 'on' : '', label);
        button.dataset.mode = value;
        button.addEventListener('click', () => setLineUpMode(value));
        mode.append(button);
    }
    const nudge = el('div', 'sheet-buttons');
    const step = (label, sign) => {
        const button = el('button', '', label);
        button.addEventListener('click', () => {
            if (lineUp.mode === 'auto') setLineUpMode('manual');
            nudgeLineUp(sign);
        });
        return button;
    };
    const reset = el('button', '', 'Reset');
    reset.addEventListener('click', () => { lineUp.shift = 0; });
    nudge.append(step(`◀ ${LINEUP_STEP_DEGREES}°`, -1), reset, step(`${LINEUP_STEP_DEGREES}° ▶`, 1));
    const finish = el('div', 'sheet-buttons');
    const cancel = el('button', '', 'Cancel');
    cancel.addEventListener('click', closeLineUp);
    const set = el('button', 'on lineup-set', 'Set');
    set.addEventListener('click', setLineUp);
    finish.append(cancel, set);
    panel.append(
        mode,
        el('div', 'sheet-line lineup-readout'),
        el('div', 'sheet-line sheet-hint lineup-hint', lineUpHint(body)),
        nudge, finish);

    node.append(canvas, top, panel);
    document.body.appendChild(node);
    lineUp.node = node;
    lineUp.canvas = canvas;
    // One camera at a time: sky view's comes back afterwards.
    lineUp.restartSkyCamera = !!sky.video;
    if (sky.video) stopCamera();
    startLineUpCamera();
    wantOrientation('lineup', true);
    window.Android?.setMapButtonsHidden(true);
    overlaysChanged();
    requestAnimationFrame(drawLineUp);
}

function closeLineUp() {
    if (!lineUp.node) return;
    stopLineUpCamera();
    lineUp.node.remove();
    lineUp.node = lineUp.canvas = null;
    lineUp.drag = null;
    wantOrientation('lineup', false);
    // The dish aligner, under it, keeps them hidden.
    window.Android?.setMapButtonsHidden(dish.open);
    if (lineUp.restartSkyCamera && sky.open) startCamera();
    lineUp.restartSkyCamera = false;
    overlaysChanged();
}

function bodyName(body) {
    return body === 'sun' ? 'Sun' : 'Moon';
}

function lineUpHint(body) {
    return (body === 'sun' ? "Don't look at the Sun itself: watch it on the screen. " : '')
        + 'Best with it near the middle of the picture, and away from metal. Only the heading moves: '
        + 'if the ring sits a little above or below the real one, line them up side to side, along the dashed line.';
}

async function startLineUpCamera() {
    const video = el('video', 'lineup-video');
    video.setAttribute('playsinline', '');
    video.muted = true;
    lineUp.video = video;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
            audio: false,
        });
        // Closed while waiting for permission.
        if (lineUp.video !== video) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        video.srcObject = stream;
        lineUp.node.prepend(video);
        await video.play();
    } catch (e) {
        console.error('No camera', e);
        if (lineUp.video !== video) return;
        stopLineUpCamera();
        noLineUpCamera();
    }
}

function stopLineUpCamera() {
    const video = lineUp.video;
    lineUp.video = null;
    if (!video) return;
    video.srcObject?.getTracks().forEach(track => track.stop());
    video.remove();
}

/** No camera (none, or not allowed): say so, and offer the fallback if there is one. */
function noLineUpCamera() {
    const node = lineUp.node;
    if (!node) return;
    node.querySelector('.lineup-hint').textContent = `Lining up needs the camera, and it isn't available.`
        + (lineUp.fallback ? ` Aim the phone at the ${bodyName(lineUp.body)} instead, and tap Set when it points straight at it.` : '');
    node.querySelector('.lineup-hint').classList.add('warning');
    const set = node.querySelector('.lineup-set');
    if (lineUp.fallback) {
        set.textContent = 'Aim instead';
        set.onclick = e => {
            e.stopImmediatePropagation();
            const fallback = lineUp.fallback;
            closeLineUp();
            fallback();
        };
    } else {
        set.disabled = true;
    }
}

/** A drag of (dx, dy) px: its part along the way the body moves as the heading turns. */
function slideLineUp(dx, dy) {
    const v = lineUp.perDegree;
    if (!v) return;
    const length2 = v[0] * v[0] + v[1] * v[1];
    if (length2 < 1e-6) return;
    lineUp.shift = angleDifference(lineUp.shift + (dx * v[0] + dy * v[1]) / length2, 0);
}

/** One fine step, moving the ring left (-1) or right (+1) on screen. */
function nudgeLineUp(sign) {
    // A bigger heading moves the sky left, unless the phone is upside down.
    const right = lineUp.perDegree ? Math.sign(lineUp.perDegree[0]) || -1 : -1;
    lineUp.shift = angleDifference(lineUp.shift + sign * right * LINEUP_STEP_DEGREES, 0);
}

function setLineUp() {
    if (!lineUp.video?.videoWidth || !orientation.rotation) return;
    setCompassOffset(orientation.offset + lineUp.shift, lineUp.body);
    closeLineUp();
}

function signed(degrees) {
    return `${degrees >= 0 ? '+' : '−'}${Math.abs(degrees).toFixed(1)}°`;
}

function drawLineUp() {
    if (!lineUp.node) return;
    requestAnimationFrame(drawLineUp);
    stepOrientation();
    const canvas = lineUp.canvas;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const camera = !!lineUp.video?.videoWidth;
    if (!camera) {
        ctx.fillStyle = SKY_BACKGROUND;
        ctx.fillRect(0, 0, width, height);
    }
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const message = !here ? 'Waiting for your location…'
        : !orientation.rotation ? 'Waiting for the compass…'
        : !camera && lineUp.video ? 'Starting the camera…'
        : null;
    const readout = lineUp.node.querySelector('.lineup-readout');
    // Set needs the picture; without a camera the button is the fallback's, if there is one.
    lineUp.node.querySelector('.lineup-set').disabled = lineUp.video || !lineUp.fallback ? !!message || !camera : false;
    if (message) {
        ctx.fillStyle = '#fff';
        ctx.fillText(message, width / 2, height / 2, width - 32);
        readout.textContent = '';
        lineUp.perDegree = null;
        return;
    }

    const rotation = turnHeading(orientation.rotation, lineUp.shift);
    const focal = skyFocal(width, height, lineUp.video);
    const projectWith = r => dir => {
        const [e, n, u] = dir;
        const x = r[0] * e + r[3] * n + r[6] * u, y = r[1] * e + r[4] * n + r[7] * u, z = r[2] * e + r[5] * n + r[8] * u;
        if (z > -0.05) return null;
        return [width / 2 + focal * x / -z, height / 2 - focal * y / -z];
    };
    const project = projectWith(rotation);

    drawLineUpHorizon(ctx, project);
    const [az, elevation] = bodyAzEl(lineUp.body);
    // Its line of azimuth, from below the horizon to the zenith: where it is, whatever the tilt.
    ctx.save();
    ctx.strokeStyle = 'rgba(110, 231, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    strokePath(ctx, project, h => direction(az, h), -10, 90, 1);
    ctx.restore();

    const dir = direction(az, elevation);
    const point = project(dir);
    const nudged = projectWith(turnHeading(rotation, 0.5))(dir);
    lineUp.perDegree = point && nudged ? [(nudged[0] - point[0]) / 0.5, (nudged[1] - point[1]) / 0.5] : null;
    const name = bodyName(lineUp.body);
    const now = Date.now();
    const auto = lineUp.mode === 'auto' && camera;
    if (auto && point && lineUp.perDegree && now - lineUp.detectedAt >= LINEUP_DETECT_MS) {
        lineUp.detectedAt = now;
        followBody(point, focal, width, height, now);
    }
    if (lineUp.found && now - lineUp.found.at > LINEUP_LOST_MS) {
        lineUp.found = null;
        lineUp.steadySince = 0;
    }
    const found = auto ? lineUp.found : null;
    if (found) drawLineUpFound(ctx, found);

    const onScreen = point && point[0] > 0 && point[1] > 0 && point[0] < width && point[1] < height;
    if (onScreen) drawLineUpRing(ctx, point, focal, name);
    else drawLineUpArrow(ctx, width, height, worldToDeviceWith(rotation, dir), name);

    if (now - lineUp.refreshedAt < LINEUP_REFRESH_MS) return;
    lineUp.refreshedAt = now;
    const locked = found && lineUp.steadySince && now - lineUp.steadySince >= LINEUP_STEADY_MS;
    lineUp.node.querySelector('.lineup-how').textContent = !auto
        ? `Slide left or right until the ring sits on the real ${name}.`
        : `Keep the ${name} in the picture: the ring follows it.`;
    const status = !auto ? '' : locked ? ` Found the ${name} ✓ Tap Set.` : found ? ` Found the ${name}, steadying…`
        : ` Looking for the ${name}… If it isn't found (cloud, a brighter light), switch to Manual.`;
    readout.textContent = `${name}: Az ${az.toFixed(1)}° · El ${elevation.toFixed(1)}°. `
        + (onScreen || found ? `Calibration ${signed(orientation.offset)} → ${signed(angleDifference(orientation.offset + lineUp.shift, 0))}.`
            : `Turn the camera towards the ${name}.`)
        + status;
    readout.classList.toggle('lineup-locked', !!locked);
}

/**
 * Auto: finds the body in the picture and moves the ring part of the way onto it, sideways only.
 * Of the bright blobs, the one at the height the sensors give wins; one too far above or below,
 * or needing too big a turn, is something else.
 */
function followBody(point, focal, width, height, now) {
    const v = lineUp.perDegree;
    const length2 = v[0] * v[0] + v[1] * v[1];
    if (length2 < 1e-6) return;
    const pxPerDegree = focal * Math.PI / 180;
    let best = null;
    for (const blob of brightBlobs(lineUp.video, width, height)) {
        const dx = blob.x - point[0], dy = blob.y - point[1];
        // Degrees of heading to move the ring onto it, and how far it would still be off.
        const along = (dx * v[0] + dy * v[1]) / length2;
        const tiltMiss = Math.hypot(dx - along * v[0], dy - along * v[1]) / pxPerDegree;
        if (tiltMiss > LINEUP_MAX_TILT_MISS || Math.abs(angleDifference(lineUp.shift + along, 0)) > LINEUP_MAX_SHIFT) continue;
        if (!best || tiltMiss < best.tiltMiss) best = { ...blob, along, tiltMiss };
    }
    if (!best) return;
    lineUp.found = { x: best.x, y: best.y, at: now };
    lineUp.shift = angleDifference(lineUp.shift + best.along * LINEUP_FOLLOW, 0);
    if (Math.abs(best.along) > LINEUP_STEADY) lineUp.steadySince = 0;
    else if (!lineUp.steadySince) lineUp.steadySince = now;
}

/**
 * The bright blobs in the camera's picture, in screen px { x, y }: the spots near the brightest one's
 * brightness, joined up, none touching the edge (cut off, its middle is unknown) or too big.
 */
function brightBlobs(video, width, height) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const sw = LINEUP_SAMPLE_PX, sh = Math.max(1, Math.round(sw * vh / vw));
    const sample = lineUp.sample ??= document.createElement('canvas');
    if (sample.width !== sw || sample.height !== sh) {
        sample.width = sw;
        sample.height = sh;
    }
    const g = sample.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, sw, sh);
    const pixels = g.getImageData(0, 0, sw, sh).data;
    const count = sw * sh;
    const light = new Float32Array(count);
    let max = 0, sum = 0;
    for (let i = 0; i < count; i++) {
        const l = 0.299 * pixels[4 * i] + 0.587 * pixels[4 * i + 1] + 0.114 * pixels[4 * i + 2];
        light[i] = l;
        sum += l;
        if (l > max) max = l;
    }
    const mean = sum / count;
    if (max < LINEUP_MIN_BRIGHTNESS || max - mean < LINEUP_MIN_CONTRAST) return [];
    const threshold = Math.max(max - 30, mean + (max - mean) * 0.7);

    // The picture is shown with object-fit: cover, scaled up and centred.
    const scale = Math.max(width / vw, height / vh) * vw / sw;
    const left = (width - sw * scale) / 2, top = (height - sh * scale) / 2;
    const seen = new Uint8Array(count);
    const blobs = [];
    const stack = [];
    for (let start = 0; start < count && blobs.length < 30; start++) {
        if (seen[start] || light[start] < threshold) continue;
        let area = 0, weight = 0, sx = 0, sy = 0, edge = false;
        seen[start] = 1;
        stack.push(start);
        while (stack.length) {
            const i = stack.pop();
            const x = i % sw, y = (i - x) / sw;
            const w = light[i] - threshold + 1;
            area++;
            weight += w;
            sx += (x + 0.5) * w;
            sy += (y + 0.5) * w;
            if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1) edge = true;
            for (const j of [x > 0 ? i - 1 : -1, x < sw - 1 ? i + 1 : -1, y > 0 ? i - sw : -1, y < sh - 1 ? i + sw : -1]) {
                if (j >= 0 && !seen[j] && light[j] >= threshold) {
                    seen[j] = 1;
                    stack.push(j);
                }
            }
        }
        if (edge || area > count * LINEUP_MAX_BLOB_SHARE) continue;
        blobs.push({ x: left + sx / weight * scale, y: top + sy / weight * scale });
    }
    return blobs;
}

/** Where the body was found: a small cross, in another colour from the ring. */
function drawLineUpFound(ctx, { x, y }) {
    ctx.save();
    for (const [color, width] of [['rgba(0, 0, 0, 0.6)', 4], [LINEUP_FOUND_COLOR, 2]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            ctx.moveTo(x + dx * 5, y + dy * 5);
            ctx.lineTo(x + dx * 11, y + dy * 11);
        }
        ctx.stroke();
    }
    ctx.restore();
}

function worldToDeviceWith(r, [e, n, u]) {
    return [r[0] * e + r[3] * n + r[6] * u, r[1] * e + r[4] * n + r[7] * u, r[2] * e + r[5] * n + r[8] * u];
}

/** Strokes the projected path of at(t) for t from `from` to `to`, broken where it goes behind the phone. */
function strokePath(ctx, project, at, from, to, step) {
    ctx.beginPath();
    let drawing = false;
    for (let t = from; t <= to + 1e-9; t += step) {
        const p = project(at(t));
        if (!p) {
            drawing = false;
            continue;
        }
        if (drawing) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
        drawing = true;
    }
    ctx.stroke();
}

/** The horizon, with a mark every 10° of azimuth and the compass points, to see the heading slide. */
function drawLineUpHorizon(ctx, project) {
    ctx.save();
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.5;
    strokePath(ctx, project, a => direction(a, 0), 0, 360, 2);
    ctx.fillStyle = '#fff';
    const points = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let a = 0; a < 360; a += 5) {
        const base = project(direction(a, 0));
        const tip = project(direction(a, a % 10 ? 0.7 : 1.5));
        if (!base || !tip) continue;
        ctx.beginPath();
        ctx.moveTo(base[0], base[1]);
        ctx.lineTo(tip[0], tip[1]);
        ctx.stroke();
        const label = points[a] ?? (a % 30 ? null : `${a}°`);
        if (!label) continue;
        const at = project(direction(a, -2.5));
        if (!at) continue;
        ctx.font = points[a] ? 'bold 14px system-ui, sans-serif' : '12px system-ui, sans-serif';
        ctx.fillText(label, at[0], at[1] + 5);
    }
    ctx.restore();
}

/** The ring round where the body should be, with its true size inside and its name over it. */
function drawLineUpRing(ctx, point, focal, name) {
    const [x, y] = point;
    const radius = lineUp.body === 'sun' ? SUN_RADIUS_DEGREES * Math.PI / 180
        : sourceRadius(transitSource('moon', new Date()), toGlobe(here[1], here[0], 0));
    const size = focal * Math.tan(radius);
    ctx.save();
    // Dark under light, to show over a bright sky or a dark one.
    for (const [color, width] of [['rgba(0, 0, 0, 0.6)', 4], [LINEUP_COLOR, 2]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(x, y, LINEUP_RING_PX, 0, 2 * Math.PI);
        // Marks in from the ring, stopping short of the body.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            ctx.moveTo(x + dx * LINEUP_RING_PX, y + dy * LINEUP_RING_PX);
            ctx.lineTo(x + dx * (LINEUP_RING_PX - 7), y + dy * (LINEUP_RING_PX - 7));
        }
        ctx.stroke();
    }
    if (size > 2) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, Math.min(size, LINEUP_RING_PX - 8), 0, 2 * Math.PI);
        ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillText(name, x, y - LINEUP_RING_PX - 8);
    ctx.restore();
}

/** Off screen: an arrow from the middle towards it, near the edge. */
function drawLineUpArrow(ctx, width, height, [x, y, z], name) {
    // On screen, x is right and y down; behind the phone, the way round is the way it is.
    let dx = x, dy = -y;
    if (Math.hypot(dx, dy) < 1e-6) dx = 1;
    const angle = Math.atan2(dy, dx);
    const reach = Math.min(width, height) * 0.32;
    const cx = width / 2 + Math.cos(angle) * reach, cy = height / 2 + Math.sin(angle) * reach;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = LINEUP_COLOR;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-10, -12);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-10, 12);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillText(z > 0 ? `The ${name} is behind you` : name, width / 2 + Math.cos(angle) * (reach - 34), height / 2 + Math.sin(angle) * (reach - 34) + 5);
    ctx.restore();
}

window.globe.openLineUp = openLineUp;
