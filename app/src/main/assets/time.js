'use strict';

// Time travel: a bar (MainActivity's clock button, globe.toggleTimeBar) that sets the globe's clock
// (globe.js's simNow) from a day back to a week ahead (further, to a year, when a sun outage is
// picked): satellites, orbits, the Sun and night side,
// the stars and Moon, sky view and pass predictions all follow it. It can also run the clock faster.
// While the clock is off the real time and the bar is closed, a pill at the top says so.

const TIME_BEHIND_MS = 24 * 60 * 60 * 1000;
/** The slider's reach ahead: a week, as far as SOCRATES' close approaches go. */
const TIME_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How far ahead the clock can go at all: a year and a day, for the sun outages a GEO satellite's
 * sheet can jump to. Beyond the slider's week the slider sits at its end, and the buttons and play
 * carry on from wherever the clock is.
 */
const TIME_LIMIT_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** The slider runs -SLIDER_STEPS..SLIDER_STEPS, cubed, so it is fine near now and coarse far off. */
const SLIDER_STEPS = 1000;
const TIME_SPEEDS = [1, 10, 100, 1000];
/** While playing fast, how often the satellites are moved on. */
const PLAY_REFRESH_MS = 200;

const timeBar = {
    node: null,
    pill: null,
    speed: 1,
    playedAt: 0,
    /** Whether play()'s animation loop is running. */
    playing: false,
};

function toggleTimeBar() {
    if (timeBar.node) closeTimeBar(); else showTimeBar();
}

function showTimeBar() {
    if (timeBar.node) return;
    const node = el('div', 'timebar');
    const header = el('div', 'sheet-header');
    const title = el('div', 'sheet-title');
    title.append(el('b', 'time-now'), el('div', 'sheet-sub time-offset'));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close time travel');
    close.addEventListener('click', closeTimeBar);
    header.append(title, close);

    const slider = el('input', 'time-slider');
    slider.type = 'range';
    slider.min = -SLIDER_STEPS;
    slider.max = SLIDER_STEPS;
    slider.step = 1;
    let pending = null;
    slider.addEventListener('input', () => {
        // One clock change per frame, however fast the slider moves.
        if (pending === null) {
            requestAnimationFrame(() => {
                setTimeOffset(sliderToOffset(pending));
                pending = null;
                refreshTimeBar(false);
            });
        }
        pending = Number(slider.value);
    });

    const buttons = el('div', 'sheet-buttons');
    for (const [label, ms] of [['−1 h', -3600_000], ['−10 min', -600_000], ['Now', 0], ['+10 min', 600_000], ['+1 h', 3600_000]]) {
        const button = el('button', '', label);
        button.addEventListener('click', () => {
            setTimeOffset(ms === 0 ? 0 : clampOffset(timeOffsetMs + ms));
            if (ms === 0) setSpeed(1);
            refreshTimeBar(true);
        });
        buttons.append(button);
    }
    const speed = el('button', 'time-speed');
    speed.addEventListener('click', () => setSpeed(TIME_SPEEDS[(TIME_SPEEDS.indexOf(timeBar.speed) + 1) % TIME_SPEEDS.length]));
    buttons.append(speed);

    node.append(header, slider, buttons);
    document.body.appendChild(node);
    timeBar.node = node;
    refreshTimeBar(true);
    overlaysChanged();
}

function closeTimeBar() {
    timeBar.node?.remove();
    timeBar.node = null;
    refreshTimeBar(false);
    overlaysChanged();
}

function clampOffset(ms) {
    return Math.max(-TIME_BEHIND_MS, Math.min(TIME_LIMIT_AHEAD_MS, ms));
}

function sliderToOffset(value) {
    const t = value / SLIDER_STEPS;
    return Math.round(t ** 3 * (t < 0 ? TIME_BEHIND_MS : TIME_AHEAD_MS));
}

function offsetToSlider(ms) {
    const t = Math.max(-1, Math.min(1, ms / (ms < 0 ? TIME_BEHIND_MS : TIME_AHEAD_MS)));
    return Math.round(Math.cbrt(t) * SLIDER_STEPS);
}

/** "+3 h 20 min", "−45 min" or "Live". */
function describeOffset(ms) {
    if (Math.abs(ms) < 30_000) return timeBar.speed === 1 ? 'Live' : 'Now';
    return (ms > 0 ? '+' : '−') + describeDuration(Math.abs(ms));
}

/** Updates the bar's text (and slider, unless the user is dragging it) and the reminder pill. */
function refreshTimeBar(moveSlider) {
    const node = timeBar.node;
    if (node) {
        const now = new Date(simNow());
        node.querySelector('.time-now').textContent =
            now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' +
            now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        node.querySelector('.time-offset').textContent =
            describeOffset(timeOffsetMs) + (timeBar.speed > 1 ? ` · running ×${timeBar.speed}` : '');
        node.querySelector('.time-speed').textContent = `▶ ×${timeBar.speed}`;
        if (moveSlider) node.querySelector('.time-slider').value = offsetToSlider(timeOffsetMs);
    }
    // Away from now with the bar closed: a reminder, and the way back.
    const away = !node && (Math.abs(timeOffsetMs) >= 30_000 || timeBar.speed > 1);
    if (away && !timeBar.pill) {
        timeBar.pill = el('button', 'time-pill');
        timeBar.pill.addEventListener('click', showTimeBar);
        document.body.appendChild(timeBar.pill);
    } else if (!away && timeBar.pill) {
        timeBar.pill.remove();
        timeBar.pill = null;
    }
    if (timeBar.pill) timeBar.pill.textContent = `⏱ ${describeOffset(timeOffsetMs)}${timeBar.speed > 1 ? ` ×${timeBar.speed}` : ''} · tap for time`;
}

function setSpeed(speed) {
    timeBar.speed = speed;
    timeBar.playedAt = performance.now();
    // One loop however often the speed changes; it stops itself at ×1.
    if (speed > 1 && !timeBar.playing) {
        timeBar.playing = true;
        requestAnimationFrame(play);
    }
    refreshTimeBar(true);
}

/** Runs the clock at timeBar.speed: the offset grows by (speed - 1) times the real time passing. */
function play() {
    if (timeBar.speed === 1) {
        timeBar.playing = false;
        return;
    }
    requestAnimationFrame(play);
    const now = performance.now();
    const elapsed = now - timeBar.playedAt;
    if (elapsed < PLAY_REFRESH_MS) return;
    timeBar.playedAt = now;
    const next = clampOffset(timeOffsetMs + elapsed * (timeBar.speed - 1));
    setTimeOffset(next);
    if (next === TIME_LIMIT_AHEAD_MS) setSpeed(1);
    refreshTimeBar(true);
}

// The bar's clock ticks with the real one.
setInterval(() => {
    if (timeBar.node) refreshTimeBar(false);
}, 1000);
timeListeners.push(() => refreshTimeBar(false));

window.globe.toggleTimeBar = toggleTimeBar;
