'use strict';

// Lining the compass up on the Sun or Moon over the camera's picture. The view draws where the
// sensors say the body is (a ring, on its line of azimuth, over the horizon and its compass marks);
// the user slides the drawing sideways until the ring sits on the real Sun or Moon, and taps Set.
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
};

function openLineUp(body, fallback = null) {
    if (lineUp.node) closeLineUp();
    closeCalibration();
    lineUp.body = body;
    lineUp.shift = 0;
    lineUp.perDegree = null;
    lineUp.drag = null;
    lineUp.fallback = fallback;
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
        el('div', 'sheet-sub', `Slide left or right until the ring sits on the real ${name}.`));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeLineUp);
    top.append(title, close);

    const panel = el('div', 'lineup-panel');
    const nudge = el('div', 'sheet-buttons');
    const step = (label, sign) => {
        const button = el('button', '', label);
        button.addEventListener('click', () => nudgeLineUp(sign));
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
    setCompassOffset(orientation.offset + lineUp.shift);
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
    const onScreen = point && point[0] > 0 && point[1] > 0 && point[0] < width && point[1] < height;
    if (onScreen) drawLineUpRing(ctx, point, focal, name);
    else drawLineUpArrow(ctx, width, height, worldToDeviceWith(rotation, dir), name);

    const now = Date.now();
    if (now - lineUp.refreshedAt < LINEUP_REFRESH_MS) return;
    lineUp.refreshedAt = now;
    readout.textContent = `${name}: Az ${az.toFixed(1)}° · El ${elevation.toFixed(1)}°. `
        + (onScreen ? `Calibration ${signed(orientation.offset)} → ${signed(angleDifference(orientation.offset + lineUp.shift, 0))}`
            : `Turn the camera towards the ${name}.`);
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
