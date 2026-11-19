'use strict';

// The user's own OneWeb terminal (Settings: Read my OneWeb terminal; Hughes HL1120). The app reads
// its local API (OneWebTerminal) and serves /data/oneweb.json, polled here while the app is open:
// every ONEWEB_POLL_MS in sky view, less often otherwise, so the signal map keeps growing.
//
// In sky view:
// - the satellite the terminal is using, ringed, with its signal (SINR), and the ones it may hand
//   over to next; matched to WhatsUp's OneWeb satellites by number (ONEWEB-0123 for 123);
// - where the antenna points, if the terminal says;
// - a signal map of the sky, built here: each reading notes the SINR at the place of the satellite in
//   use (from its orbit), and a lost link a bad reading where the satellite was. Directions that keep
//   coming out poor are where something is in the way, as Starlink's obstruction map shows. It is
//   kept in this device's storage, and starts again when cleared in Settings.

const ONEWEB_POLL_MS = 5000, ONEWEB_BACKGROUND_POLL_MS = 15000;
/** The signal map: cells across the sky out to the horizon, zenith in the middle, north up (as Starlink's). */
const ONEWEB_MAP_CELLS = 61;
/** Each cell averages its last this many readings, so it follows a change (a tree cut, a dish moved). */
const ONEWEB_MAP_MEMORY = 30;
/** SINR (dB) at or under which a cell is drawn as poor, and from which it is good; amber between. */
const ONEWEB_POOR_SINR = 0, ONEWEB_GOOD_SINR = 6;
/** A lost link counts as a reading this poor, where the satellite in use was. */
const ONEWEB_LOST_SINR = -10;
const ONEWEB_MAP_KEY = 'oneweb.map';
const ONEWEB_SAVE_MS = 30_000;
const ONEWEB_RING_COLOR = '#ffffff';

const oneweb = {
    /** The last answer from /data/oneweb.json: { at, terminal, errors, error }. */
    data: null,
    requestedAt: 0,
    loading: false,
    /** OneWeb satellites by their number (ONEWEB-0123 is 123), rebuilt when the satellites change. */
    byNumber: null,
    /** The satellite in use at the last reading, for a lost link. */
    lastInUse: null,
    /** The signal map: { since (ms), cells: { index: [mean SINR, readings] } }. */
    map: null,
    savedAt: 0,
    dirty: false,
};

satelliteListeners.push(() => { oneweb.byNumber = null; });

/** The OneWeb satellite with this number, if WhatsUp has it. */
function onewebSatellite(number) {
    if (!oneweb.byNumber) {
        oneweb.byNumber = new Map();
        for (const sat of satellites.values()) {
            const match = sat.group === 'oneweb' && /ONEWEB-0*(\d+)/i.exec(sat.officialName ?? '');
            if (match) oneweb.byNumber.set(Number(match[1]), sat);
        }
    }
    return oneweb.byNumber.get(Number(number)) ?? null;
}

function pollOneWeb() {
    setTimeout(pollOneWeb, 1000);
    if (!layers.onewebTerminal || document.hidden) {
        if (!layers.onewebTerminal) oneweb.data = null;
        return;
    }
    const now = Date.now();
    if (oneweb.loading || now - oneweb.requestedAt < (sky.open ? ONEWEB_POLL_MS : ONEWEB_BACKGROUND_POLL_MS)) return;
    oneweb.loading = true;
    oneweb.requestedAt = now;
    fetch('/data/oneweb.json')
        .then(response => response.json())
        .then(data => {
            oneweb.data = data;
            noteOneWebReading(data);
        })
        .catch(e => { oneweb.data = { error: e.message }; })
        .finally(() => { oneweb.loading = false; });
}
setTimeout(pollOneWeb, 1000);

// ---- The signal map ----

function loadOneWebMap() {
    if (oneweb.map && oneweb.map.since >= (layers.onewebMapClearedAt ?? 0)) return oneweb.map;
    let map = null;
    try {
        map = JSON.parse(localStorage.getItem(ONEWEB_MAP_KEY) ?? 'null');
    } catch {
        map = null;
    }
    // Cleared in Settings since it was started: begin again.
    if (!map?.cells || map.since < (layers.onewebMapClearedAt ?? 0)) map = { since: Date.now(), cells: {} };
    oneweb.map = map;
    return map;
}

function saveOneWebMap(force = false) {
    if (!oneweb.dirty || (!force && Date.now() - oneweb.savedAt < ONEWEB_SAVE_MS)) return;
    oneweb.savedAt = Date.now();
    oneweb.dirty = false;
    try {
        localStorage.setItem(ONEWEB_MAP_KEY, JSON.stringify(oneweb.map));
    } catch {
        // Not kept, then: it still builds for now.
    }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) saveOneWebMap(true); });

/** The map cell for a direction above the horizon. */
function onewebCell(az, el) {
    const out = (90 - el) / 90, a = az * Math.PI / 180;
    const x = out * Math.sin(a), y = out * Math.cos(a);
    const col = Math.min(ONEWEB_MAP_CELLS - 1, Math.floor((x + 1) / 2 * ONEWEB_MAP_CELLS));
    const row = Math.min(ONEWEB_MAP_CELLS - 1, Math.floor((1 - y) / 2 * ONEWEB_MAP_CELLS));
    return row * ONEWEB_MAP_CELLS + col;
}

/** The direction (east, north, up) of a map cell's middle. */
function onewebCellDirection(index) {
    const row = Math.floor(index / ONEWEB_MAP_CELLS), col = index % ONEWEB_MAP_CELLS;
    const x = (col + 0.5) / ONEWEB_MAP_CELLS * 2 - 1, y = 1 - (row + 0.5) / ONEWEB_MAP_CELLS * 2;
    const out = Math.min(1, Math.hypot(x, y));
    return direction(Math.atan2(x, y) * 180 / Math.PI, 90 - out * 90);
}

/** Notes a reading in the map: the SINR where the satellite in use is now, or a lost link where it was. */
function noteOneWebReading(data) {
    const t = data?.terminal;
    if (!t || !here) return;
    const [lon, lat] = here;
    const now = new Date();
    const inUse = t.satellite > 0 ? onewebSatellite(t.satellite) : null;
    let sat = inUse, sinr = t.sinr;
    if (!inUse && oneweb.lastInUse && !(t.satellite > 0)) {
        // The link dropped: a bad reading where the satellite it was on is now (if still up).
        sat = oneweb.lastInUse;
        sinr = ONEWEB_LOST_SINR;
    }
    oneweb.lastInUse = inUse;
    if (!sat || typeof sinr !== 'number') return;
    const look = pointingAt(sat.satrec, lat, lon, now);
    if (!look || look.el <= 0) return;
    const map = loadOneWebMap();
    const cell = onewebCell(look.az, look.el);
    const [mean, count] = map.cells[cell] ?? [0, 0];
    const n = Math.min(count + 1, ONEWEB_MAP_MEMORY);
    map.cells[cell] = [Math.round((mean + (sinr - mean) / n) * 100) / 100, n];
    oneweb.dirty = true;
    saveOneWebMap();
}

/** How a mean SINR is drawn: poor red, middling amber, good faint green. */
function onewebCellColor(sinr) {
    if (sinr <= ONEWEB_POOR_SINR) return 'rgba(255, 80, 80, 0.45)';
    if (sinr < ONEWEB_GOOD_SINR) return 'rgba(255, 179, 71, 0.35)';
    return 'rgba(124, 242, 156, 0.18)';
}

// ---- Sky view ----

/** Sky view's drawing of the terminal: its signal map, the satellite in use and the next ones, where it points. */
function drawOneWeb(ctx, project, focal, width, height, labels) {
    const data = oneweb.data;
    if (!layers.onewebTerminal) return;
    drawOneWebMap(ctx, project, focal, width, height);
    if (!data || data.error === 'off') return;
    const t = data.terminal;
    const [lon, lat] = here;
    // Where WhatsUp draws a satellite now (sky view's time), to ring it in place.
    const at = sat => sat?.now ? skyDirection(toGlobe(sat.now.lat, sat.now.lon, sat.now.altKm), lat, lon) : null;
    const color = groupStyles.oneweb?.css ?? ONEWEB_RING_COLOR;
    let problem = data.error ? `OneWeb terminal: ${data.error}` : null;

    for (const number of (t?.candidates ?? []).slice(0, 6)) {
        if (number === t.satellite) continue;
        const dir = at(onewebSatellite(number));
        const p = dir && dir[2] > 0 ? project(dir) : null;
        if (!p) continue;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(p[0], p[1], 10, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
        labels.push({ text: 'next', x: p[0], y: p[1] + 22, priority: LABEL_PRIORITY.terminal, size: 10, color });
    }

    if (t?.satellite > 0) {
        const sat = onewebSatellite(t.satellite);
        const dir = at(sat);
        if (!dir || dir[2] <= 0) {
            problem ??= `OneWeb terminal: on satellite ${t.satellite}, not found overhead among WhatsUp's OneWeb satellites`;
        } else {
            const p = project(dir);
            if (p) {
                ctx.save();
                for (const [stroke, lineWidth] of [['rgba(0, 0, 0, 0.6)', 5], [ONEWEB_RING_COLOR, 2.5]]) {
                    ctx.strokeStyle = stroke;
                    ctx.lineWidth = lineWidth;
                    ctx.beginPath();
                    ctx.arc(p[0], p[1], 14, 0, 2 * Math.PI);
                    ctx.stroke();
                }
                ctx.restore();
                const sinr = typeof t.sinr === 'number' ? ` · SINR ${t.sinr.toFixed(1)} dB` : '';
                labels.push({ text: `Your terminal's satellite${sinr}`, x: p[0], y: p[1] - 22, priority: LABEL_PRIORITY.dish });
            }
        }
    } else if (t) {
        problem ??= 'OneWeb terminal: not on a satellite';
    }

    if (t?.pointing) {
        const p = project(direction(t.pointing.az, t.pointing.el));
        if (p) {
            ctx.save();
            ctx.fillStyle = color;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p[0], p[1] - 8);
            ctx.lineTo(p[0] + 8, p[1]);
            ctx.lineTo(p[0], p[1] + 8);
            ctx.lineTo(p[0] - 8, p[1]);
            ctx.closePath();
            ctx.stroke();
            ctx.fill();
            ctx.restore();
            labels.push({ text: 'Your antenna points here', x: p[0], y: p[1] + 20, priority: LABEL_PRIORITY.dish - 1, size: 11 });
        }
    }

    if (problem) {
        const tape = headingTapeBox(width, height);
        // Above Starlink's line, if that has one too.
        const y = tape.top - TAPE_READING_PX - 10 - (starlink.data && describeStarlinkProblem(starlink.data) ? 18 : 0);
        ctx.save();
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffb347';
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 4;
        ctx.fillText(problem, width / 2, y, width - 32);
        ctx.restore();
    }
}

/** The signal map's cells as small squares, coloured by their mean SINR. */
function drawOneWebMap(ctx, project, focal, width, height) {
    const map = loadOneWebMap();
    const cells = Object.entries(map.cells);
    if (!cells.length) return;
    const size = Math.max(2, focal * Math.tan(Math.PI / ONEWEB_MAP_CELLS) * 1.05);
    const half = size / 2;
    const byColor = new Map();
    for (const [index, [sinr]] of cells) {
        const color = onewebCellColor(sinr);
        if (!byColor.has(color)) byColor.set(color, []);
        byColor.get(color).push(Number(index));
    }
    ctx.save();
    for (const [color, indexes] of byColor) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const index of indexes) {
            const p = project(onewebCellDirection(index));
            if (!p || p[0] < -size || p[1] < -size || p[0] > width + size || p[1] > height + size) continue;
            ctx.rect(p[0] - half, p[1] - half, size, size);
        }
        ctx.fill();
    }
    ctx.restore();
}
