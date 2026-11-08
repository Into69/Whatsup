'use strict';

// Compass calibration. Android calibrates the magnetometer itself as the phone is turned to face
// every way; waving it in a figure 8, turning the wrist as it goes, does that in a few seconds.
// This screen guides it: the motion animated, the accuracy Android reports (setCompassStatus, from
// onAccuracyChanged), the strength of the magnetic field (setMagneticField: the Earth's alone is
// FIELD_MIN_UT to FIELD_MAX_UT, so more or less means metal or a magnet nearby, which no waving
// fixes), and how many of the ways the phone can face it has been through so far.
//
// Opened from sky view (∞) and the dish aligner (Figure 8). While either is open and the accuracy
// drops to low or unreliable, a prompt offers it.

/** sin(22.5°): an axis component beyond this counts as pointing that way, for the direction bins. */
const CALIBRATION_AXIS = 0.38;
/** Share of the directions to face (two axes, 26 each) for the waving to count as done. */
const CALIBRATION_GOAL = 0.6;
const FIELD_MIN_UT = 22, FIELD_MAX_UT = 67;
/** Once dismissed, the prompt stays away this long unless the accuracy drops again. */
const CALIBRATION_SNOOZE_MS = 5 * 60_000;
const ACCURACY = [
    { name: 'Unreliable', css: '#ff6b6b' },
    { name: 'Low', css: '#ffb347' },
    { name: 'Medium', css: '#ffd166' },
    { name: 'High', css: '#7cf29c' },
];

const calibration = {
    node: null,
    prompt: null,
    /** The directions the phone's screen and top have faced, as "x,y,z" of -1/0/1 each. */
    faced: [new Set(), new Set()],
    /** The accuracy when the screen opened, to tell an improvement from one already high. */
    startStatus: 3,
    fieldUt: -1,
    snoozedAt: 0,
    snoozedStatus: 3,
    closeTimer: 0,
};

/** The figure 8 a phone traces, and a phone following it, turning as it goes. */
const FIGURE_8_SVG = `
<svg class="calibration-figure" viewBox="0 0 220 120" aria-hidden="true">
  <path id="figure8" d="M110,60 C140,10 200,10 200,60 C200,110 140,110 110,60 C80,10 20,10 20,60 C20,110 80,110 110,60 Z"
        fill="none" stroke="rgba(110,231,255,.45)" stroke-width="3" stroke-dasharray="6 6"/>
  <g>
    <rect x="-9" y="-16" width="18" height="32" rx="3" fill="#e8f6ff" stroke="#0b1622" stroke-width="1.5"/>
    <rect x="-6" y="-12" width="12" height="22" rx="1" fill="#4fc3f7"/>
    <animateMotion dur="3.2s" repeatCount="indefinite" rotate="auto"><mpath href="#figure8"/></animateMotion>
  </g>
</svg>`;

function openCalibration() {
    if (calibration.node) return;
    hideCalibrationPrompt();
    calibration.faced = [new Set(), new Set()];
    calibration.startStatus = orientation.status;
    const node = el('div', 'calibration');
    const header = el('div', 'sheet-header');
    const title = el('div', 'sheet-title');
    title.append(el('b', '', 'Calibrate the compass'));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeCalibration);
    header.append(title, close);
    const figure = el('div');
    figure.innerHTML = FIGURE_8_SVG;
    const meter = el('div', 'calibration-meter');
    meter.append(el('div'));
    const done = el('button', '', 'Done');
    done.addEventListener('click', closeCalibration);
    const buttons = el('div', 'sheet-buttons');
    buttons.append(done);
    node.append(header, figure,
        el('div', 'sheet-line', 'Hold the phone out and trace a big figure 8 in the air, turning your wrist so it faces every way: '
            + 'up, down, left, right, and screen down. Keep going for 10–20 seconds.'),
        el('div', 'sheet-line calibration-accuracy'),
        el('div', 'sheet-line calibration-field'),
        el('div', 'sheet-line sheet-hint calibration-coverage-label'), meter,
        el('div', 'sheet-line calibration-result'),
        buttons);
    document.body.appendChild(node);
    calibration.node = node;
    wantOrientation('calibration', true);
    refreshCalibration();
    overlaysChanged();
}

function closeCalibration() {
    if (!calibration.node) return;
    clearTimeout(calibration.closeTimer);
    calibration.node.remove();
    calibration.node = null;
    wantOrientation('calibration', false);
    // Calibrated or not, don't nag straight away.
    calibration.snoozedAt = Date.now();
    calibration.snoozedStatus = orientation.status;
    overlaysChanged();
}

/** From MainActivity, a few times a second while the sensors run: the field's strength in µT. */
function setMagneticField(ut) {
    calibration.fieldUt = ut;
    if (calibration.node) refreshCalibration();
}

/** Notes which way the phone's screen and top face, in 26 directions each. */
function noteCalibrationPose(matrix) {
    if (!calibration.node) return;
    // Device-to-world, row-major: the device's y (top) and z (out of the screen) axes are its columns.
    const axes = [[matrix[1], matrix[4], matrix[7]], [matrix[2], matrix[5], matrix[8]]];
    axes.forEach((axis, i) => {
        const key = axis.map(c => (c > CALIBRATION_AXIS ? 1 : c < -CALIBRATION_AXIS ? -1 : 0));
        if (key.some(Boolean)) calibration.faced[i].add(key.join(','));
    });
    refreshCalibration();
}
orientationListeners.push(noteCalibrationPose);

/** How much of the waving is done, 0 to 1 (CALIBRATION_GOAL counts as all). */
function calibrationCoverage() {
    const faced = calibration.faced[0].size + calibration.faced[1].size;
    return Math.min(faced / (2 * 26) / CALIBRATION_GOAL, 1);
}

function refreshCalibration() {
    const node = calibration.node;
    if (!node) return;
    const status = ACCURACY[orientation.status] ?? { name: 'Unknown', css: '#9e9e9e' };
    const accuracy = node.querySelector('.calibration-accuracy');
    accuracy.replaceChildren(document.createTextNode('Compass accuracy: '));
    const chip = el('b', '', status.name);
    chip.style.background = status.css;
    accuracy.append(chip);
    if (orientation.headingError >= 0) accuracy.append(document.createTextNode(` · about ±${Math.round(orientation.headingError)}°`));

    const field = node.querySelector('.calibration-field');
    const ut = calibration.fieldUt;
    const disturbed = ut >= 0 && (ut < FIELD_MIN_UT || ut > FIELD_MAX_UT);
    field.textContent = ut < 0 ? 'Magnetic field: waiting for the sensor…'
        : `Magnetic field ${Math.round(ut)} µT: ` + (disturbed
            ? `${ut > FIELD_MAX_UT ? 'too strong' : 'too weak'}. Metal, a magnet (a case clasp, a mount), a speaker or a car is near; move away from it first.`
            : `normal for the Earth (${FIELD_MIN_UT}–${FIELD_MAX_UT} µT).`);
    field.classList.toggle('warning', disturbed);

    const coverage = calibrationCoverage();
    node.querySelector('.calibration-meter div').style.width = `${Math.round(coverage * 100)}%`;
    node.querySelector('.calibration-coverage-label').textContent = coverage >= 1
        ? 'Every way covered.' : `Ways faced so far: ${Math.round(coverage * 100)}%`;

    const result = node.querySelector('.calibration-result');
    const improved = orientation.status === 3 && (calibration.startStatus < 3 || coverage >= 1);
    result.className = 'sheet-line calibration-result' + (improved ? ' calibration-done' : '');
    result.textContent = improved ? 'Calibrated ✓'
        : coverage >= 1 ? 'Done waving. If the accuracy stays low, move away from metal and go again; some phones report it slowly, or not at all.'
        : '';
    if (improved && !calibration.closeTimer) calibration.closeTimer = setTimeout(() => {
        calibration.closeTimer = 0;
        closeCalibration();
    }, 2000);
}

/**
 * The accuracy changed: in sky view or the dish aligner, offer calibration when it is low (unless
 * just dismissed at the same or a better accuracy); otherwise take the offer away.
 */
function compassStatusChanged() {
    document.getElementById('sky-calibrate')?.classList.toggle('warning', orientation.status <= 1);
    refreshCalibration();
    const inUse = sky.open || dish.open;
    const snoozed = Date.now() - calibration.snoozedAt < CALIBRATION_SNOOZE_MS && orientation.status >= calibration.snoozedStatus;
    if (!inUse || orientation.status > 1 || calibration.node || snoozed) {
        hideCalibrationPrompt();
        return;
    }
    if (calibration.prompt) return;
    const prompt = el('div', 'calibration-prompt');
    const go = el('button', '', 'Calibrate');
    go.addEventListener('click', openCalibration);
    const later = el('button', '', 'Later');
    later.addEventListener('click', () => {
        calibration.snoozedAt = Date.now();
        calibration.snoozedStatus = orientation.status;
        hideCalibrationPrompt();
    });
    prompt.append(el('span', '', `Compass accuracy ${ACCURACY[orientation.status].name.toLowerCase()}`), go, later);
    document.body.appendChild(prompt);
    calibration.prompt = prompt;
}

function hideCalibrationPrompt() {
    calibration.prompt?.remove();
    calibration.prompt = null;
}

window.globe.setMagneticField = setMagneticField;
window.globe.openCalibration = openCalibration;
