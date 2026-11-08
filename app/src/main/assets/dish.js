'use strict';

// Dish aligner: a full-screen guide for pointing a dish (or antenna) at the selected satellite, from
// the phone's orientation sensors. The phone aims with its back (held up like a camera) or its top
// edge (laid on the dish arm, screen up). A scope shows where the satellite is from where the phone
// points; readouts say which way to turn, tilt and rotate.
//
// Tilt comes from the accelerometer and is good to a fraction of a degree. Heading comes from the
// magnetometer: it is corrected for declination (skyview.js), but metal nearby (the dish itself) bends
// it, so it can be calibrated on the Sun or Moon, or nudged by hand. The correction is saved.
//
// Always for the real time, whatever time.js's clock says: a dish is aligned now.

/** How far off (degrees) the scope's edge is; the scale is a square root, so the last few degrees are wide. */
const DISH_SCOPE_DEGREES = 20;
/** Within this many degrees counts as on target. */
const DISH_ON_TARGET = 1;
const DISH_CLOSE = 5;
const DISH_REFRESH_MS = 100;

const dish = {
    open: false,
    node: null,
    sat: null,
    /** 'back' (hold the phone up and look along its back) or 'top' (lay it on the arm, top edge forward). */
    aim: 'back',
    /**
     * Top edge only: how much higher the dish's beam looks than its arm (degrees), as for an offset
     * dish; kept while the app runs.
     */
    elevationOffset: 0,
    canvas: null,
    /** A calibration in progress: 'sun' or 'moon', waiting for the user to aim and tap Set. */
    calibrating: null,
    refreshedAt: 0,
};

function openDish(sat) {
    if (dish.open) closeDish();
    dish.open = true;
    dish.sat = sat;
    dish.calibrating = null;
    dish.node = buildDish(sat);
    document.body.appendChild(dish.node);
    wantOrientation('dish', true);
    // Full screen: the map's buttons would only get in the way.
    window.Android?.setMapButtonsHidden(true);
    compassStatusChanged();
    overlaysChanged();
    requestAnimationFrame(drawDish);
}

function closeDish() {
    if (!dish.open) return;
    dish.open = false;
    dish.node.remove();
    dish.node = null;
    wantOrientation('dish', false);
    window.Android?.setMapButtonsHidden(false);
    compassStatusChanged();
    overlaysChanged();
}

function buildDish(sat) {
    const node = el('div', 'dish');
    const header = el('div', 'sheet-header');
    const title = el('div', 'sheet-title');
    title.append(el('b', '', `Align on ${sat.name}`), el('div', 'sheet-sub', 'Pointing from your location, now'));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close dish aligner');
    close.addEventListener('click', closeDish);
    header.append(title, close);

    const aim = el('div', 'segmented');
    for (const [value, label] of [['back', 'Back of phone'], ['top', 'Top edge']]) {
        const button = el('button', value === dish.aim ? 'on' : '', label);
        button.addEventListener('click', () => {
            dish.aim = value;
            aim.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === button));
            dish.node.querySelector('.dish-how').textContent = aimHint();
            offset.style.display = value === 'top' ? '' : 'none';
        });
        aim.append(button);
    }

    // Top edge: the beam's offset above the arm, typed or stepped.
    const offset = el('div', 'dish-offset');
    offset.style.display = dish.aim === 'top' ? '' : 'none';
    const offsetInput = el('input');
    offsetInput.type = 'number';
    offsetInput.inputMode = 'decimal';
    offsetInput.step = '0.1';
    offsetInput.min = '-90';
    offsetInput.max = '90';
    offsetInput.value = dish.elevationOffset;
    const setOffset = degrees => {
        dish.elevationOffset = Math.max(-90, Math.min(90, Math.round(degrees * 10) / 10));
        offsetInput.value = dish.elevationOffset;
    };
    offsetInput.addEventListener('input', () => {
        const value = parseFloat(offsetInput.value);
        if (Number.isFinite(value)) dish.elevationOffset = Math.max(-90, Math.min(90, value));
    });
    offsetInput.addEventListener('change', () => setOffset(parseFloat(offsetInput.value) || 0));
    const step = (label, change) => {
        const button = el('button', '', label);
        button.addEventListener('click', () => setOffset(dish.elevationOffset + change));
        return button;
    };
    const offsetRow = el('div', 'dish-offset-row');
    offsetRow.append(el('span', 'dish-offset-label', 'Elevation offset'), step('−1', -1), offsetInput, el('span', '', '°'), step('+1', 1));
    offset.append(offsetRow, el('div', 'sheet-hint',
        'An offset dish looks this much higher than its arm (often 17–28°; see its spec sheet). 0 for a dish that looks along its arm.'));

    dish.canvas = el('canvas', 'dish-scope');
    const calibrate = el('div', 'sheet-buttons');
    const sunButton = el('button', 'calibrate-sun', 'Calibrate on Sun');
    sunButton.addEventListener('click', () => startCalibration('sun'));
    const moonButton = el('button', 'calibrate-moon', 'Calibrate on Moon');
    moonButton.addEventListener('click', () => startCalibration('moon'));
    const figure8 = el('button', '', 'Figure 8');
    figure8.addEventListener('click', openCalibration);
    calibrate.append(sunButton, moonButton, figure8);
    const nudge = el('div', 'sheet-buttons');
    for (const [label, change] of [['−1°', -1], ['−0.1°', -0.1], ['+0.1°', 0.1], ['+1°', 1]]) {
        const button = el('button', '', label);
        button.addEventListener('click', () => setCompassOffset(orientation.offset + change));
        nudge.append(button);
    }
    const reset = el('button', '', 'Reset');
    reset.addEventListener('click', () => setCompassOffset(0));
    nudge.append(reset);

    node.append(
        header,
        el('div', 'sheet-line dish-target'),
        aim,
        el('div', 'sheet-line sheet-hint dish-how', aimHint()),
        offset,
        dish.canvas,
        el('div', 'dish-steps'),
        el('div', 'sheet-line dish-phone'),
        el('div', 'dish-section', 'Compass'),
        el('div', 'sheet-line dish-compass'),
        el('div', 'sheet-line sheet-hint dish-calibration'),
        calibrate,
        nudge,
    );
    return node;
}

function aimHint() {
    return dish.aim === 'back'
        ? 'Hold the phone up and aim its back at the satellite, like taking a photo of it.'
        : 'Lay the phone on the dish arm, screen up, its top edge pointing out along the arm, the way the dish looks.';
}

/** Saves a new compass calibration (degrees added to headings) through MainActivity. */
function setCompassOffset(degrees) {
    const rounded = Math.round(((degrees + 540) % 360 - 180) * 10) / 10;
    orientation.offset = rounded;
    correctOrientation();
    window.Android?.setCompassOffset(rounded);
}

/**
 * Where the phone points, as azimuth, elevation and roll (degrees), by the aim chosen. Laid on the
 * arm, that is the dish's beam: the top edge's direction tilted up towards the screen side by the
 * elevation offset (about the phone's own left-right axis, so it holds however the arm is turned).
 */
function phonePointing() {
    let forward, reference;
    if (dish.aim === 'back') {
        forward = deviceToWorld([0, 0, -1]);
        reference = deviceToWorld([0, 1, 0]);
    } else {
        const o = dish.elevationOffset * Math.PI / 180;
        forward = deviceToWorld([0, Math.cos(o), Math.sin(o)]);
        reference = deviceToWorld([0, -Math.sin(o), Math.cos(o)]);
    }
    const [az, el] = azEl(forward);
    // Roll: how far the phone's "up" is turned from the vertical about the line it points along,
    // counter-clockwise looking along it (as skew is).
    const d = forward.map(c => c / Math.hypot(...forward));
    const across = v => { const k = dot(v, d); return v.map((c, i) => c - k * d[i]); };
    const up = across([0, 0, 1]), ref = across(reference);
    const roll = -Math.atan2(dot(d, cross(up, ref)), dot(up, ref)) * 180 / Math.PI;
    return { az, el, roll };
}

/** Signed difference a - b in degrees, wrapped to -180..180. */
function angleDifference(a, b) {
    return ((a - b) % 360 + 540) % 360 - 180;
}

/** First tap: aim at the body. Second tap (now "Set"): take the calibration. */
function startCalibration(body) {
    if (dish.calibrating === body) finishCalibration(); else dish.calibrating = body;
}

/** Sun or Moon now (real time): its azimuth and elevation from here. */
function bodyAzEl(body) {
    const [lon, lat] = here;
    const date = new Date();
    const p = body === 'sun' ? sunDirection(date).map(c => c * 1e6) : moonAt(date).globe;
    return azEl(skyDirection(p, lat, lon));
}

function finishCalibration() {
    if (!here || !orientation.rotation) return;
    const [az] = bodyAzEl(dish.calibrating);
    const phone = phonePointing();
    // The phone, as corrected now, reads phone.az while pointing at the body's true azimuth.
    setCompassOffset(orientation.offset + angleDifference(az, phone.az));
    dish.calibrating = null;
}

function drawDish() {
    if (!dish.open) return;
    requestAnimationFrame(drawDish);
    const now = Date.now();
    if (now - dish.refreshedAt < DISH_REFRESH_MS) return;
    dish.refreshedAt = now;
    const node = dish.node;
    const text = (selector, value) => { node.querySelector(selector).textContent = value; };

    if (!here) {
        text('.dish-target', 'Waiting for your location…');
        return;
    }
    const [lon, lat] = here;
    const target = pointingAt(dish.sat.satrec, lat, lon, new Date());
    if (!target) {
        text('.dish-target', "Couldn't work out where this satellite is.");
        return;
    }
    const magnetic = (target.az - orientation.declination + 360) % 360;
    const skewText = Math.abs(target.skew) < 0.05 ? '0.0°' : `${Math.abs(target.skew).toFixed(1)}° ${target.skew > 0 ? '↺' : '↻'}`;
    text('.dish-target',
        `Point: Az ${target.az.toFixed(1)}° true (${magnetic.toFixed(1)}° magnetic) · El ${target.el.toFixed(1)}°` +
        `${target.el < 0 ? ' (below the horizon)' : ''} · Skew ${skewText}`);

    // Calibration buttons: only for a body above the horizon.
    for (const body of ['sun', 'moon']) {
        const button = node.querySelector(`.calibrate-${body}`);
        const [, el] = bodyAzEl(body);
        const name = body === 'sun' ? 'Sun' : 'Moon';
        button.disabled = el < 2;
        button.classList.toggle('on', dish.calibrating === body);
        button.textContent = dish.calibrating === body ? `Set: aimed at the ${name}` : `Calibrate on ${name}`;
    }
    const calibrationHint = dish.calibrating === 'sun'
        ? "Aim at the Sun without looking at it: turn until the phone's shadow is as small as it gets, then tap Set."
        : dish.calibrating === 'moon'
            ? 'Aim at the Moon (sky view\'s camera helps line it up), then tap Set.'
            : `Headings are corrected by the declination here (${Math.abs(orientation.declination).toFixed(1)}°${orientation.declination >= 0 ? 'E' : 'W'}` +
              `${orientation.located ? '' : ', without a location yet'}) and your calibration (${orientation.offset >= 0 ? '+' : ''}${orientation.offset.toFixed(1)}°). ` +
              'Metal, like the dish itself, bends the compass: calibrate a few metres from it.';
    text('.dish-calibration', calibrationHint);
    const accuracy = ['unreliable', 'low', 'medium', 'high'][orientation.status] ?? 'unknown';
    text('.dish-compass', `Accuracy ${accuracy}` +
        (orientation.headingError >= 0 ? `, about ±${Math.round(orientation.headingError)}°` : '') +
        (orientation.status <= 1 ? '. Tap Figure 8 to calibrate it.' : ''));
    node.querySelector('.dish-compass').classList.toggle('warning', orientation.status <= 1);

    if (!orientation.rotation) {
        text('.dish-phone', 'Waiting for the compass…');
        return;
    }
    const phone = phonePointing();
    const what = dish.aim === 'top' && dish.elevationOffset ? `Dish (arm + ${dish.elevationOffset.toFixed(1)}°)` : 'Phone';
    text('.dish-phone', `${what}: Az ${phone.az.toFixed(1)}° · El ${phone.el.toFixed(1)}° · Roll ${phone.roll.toFixed(1)}°`);

    const dAz = angleDifference(target.az, phone.az);
    const dEl = target.el - phone.el;
    const dSkew = angleDifference(target.skew, phone.roll);
    const steps = node.querySelector('.dish-steps');
    steps.replaceChildren(
        step(dAz, 'Turn right', 'Turn left', 'Heading on target'),
        step(dEl, 'Tilt up', 'Tilt down', 'Elevation on target'),
        step(dSkew, 'Rotate ↺', 'Rotate ↻', 'Skew on target'),
    );
    if (dish.calibrating) {
        // Tapping the scope also sets the calibration.
        dish.canvas.onclick = finishCalibration;
    } else {
        dish.canvas.onclick = null;
    }
    drawScope(dAz * Math.cos(target.el * Math.PI / 180), dEl);
}

/** One readout: which way and how far, coloured by how close. */
function step(delta, positive, negative, done) {
    const size = Math.abs(delta);
    const row = el('div', 'dish-step ' + (size < DISH_ON_TARGET ? 'good' : size < DISH_CLOSE ? 'close' : ''));
    row.textContent = size < DISH_ON_TARGET ? `✓ ${done} (${delta.toFixed(1)}°)` : `${delta > 0 ? positive : negative} ${size.toFixed(1)}°`;
    return row;
}

/** The scope: crosshair where the phone points, and the satellite x degrees right and y degrees up of it. */
function drawScope(x, y) {
    const canvas = dish.canvas;
    const ratio = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    if (canvas.width !== size * ratio) {
        canvas.width = canvas.height = size * ratio;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2, radius = size / 2 - 6;
    const scale = degrees => radius * Math.sqrt(Math.min(degrees, DISH_SCOPE_DEGREES) / DISH_SCOPE_DEGREES);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    for (const ring of [1, 5, 10, DISH_SCOPE_DEGREES]) {
        ctx.beginPath();
        ctx.arc(c, c, scale(ring), 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillText(`${ring}°`, c + scale(ring) * 0.71 + 2, c - scale(ring) * 0.71 - 2);
    }
    ctx.beginPath();
    ctx.moveTo(c - radius, c);
    ctx.lineTo(c + radius, c);
    ctx.moveTo(c, c - radius);
    ctx.lineTo(c, c + radius);
    ctx.stroke();

    const off = Math.hypot(x, y);
    const shown = scale(off);
    const angle = Math.atan2(-y, x);
    const px = c + Math.cos(angle) * shown, py = c + Math.sin(angle) * shown;
    const color = off < DISH_ON_TARGET ? '#7cf29c' : off < DISH_CLOSE ? '#ffd166' : SKY_TRACK_COLOR;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, off < DISH_ON_TARGET ? 10 : 7, 0, 2 * Math.PI);
    ctx.fill();
    if (off >= DISH_SCOPE_DEGREES) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(`${Math.round(off)}° off`, c, c + radius - 12);
    }
}

window.globe.openDish = () => selected && openDish(selected);
