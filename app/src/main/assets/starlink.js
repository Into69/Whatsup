'use strict';

// The user's own Starlink dish in sky view (Settings: Read my Starlink dish). The app reads it over
// its local API (StarlinkDish) and serves /data/starlink.json, polled here while sky view is open:
// - its obstruction map, the sky as the dish has seen it, painted over the sky: red where its signal
//   was blocked, faint green where it was clear;
// - where the dish's face points (its boresight), and where Starlink wants it to point if that is
//   elsewhere, with a line between;
// - its reach: the cone round where it really points (TERMINAL_LIMITS, satellites.js), which the
//   terminal cone drawn round the zenith only guesses at for a dish lying flat.

const STARLINK_POLL_MS = 5000;
/** A map cell under this SNR (0 to 1) is drawn as obstructed; as StarlinkDish.OBSTRUCTED_SNR. */
const STARLINK_OBSTRUCTED_SNR = 0.5;
/** One byte per cell: SNR 0 to 1 as 0 to 200; no data as 255 (StarlinkDish). */
const STARLINK_SNR_SCALE = 200, STARLINK_NO_DATA = 255;
const STARLINK_DISH_COLOR = '#ffffff';
const STARLINK_OBSTRUCTED_COLOR = 'rgba(255, 80, 80, 0.45)', STARLINK_CLEAR_COLOR = 'rgba(124, 242, 156, 0.12)';
/** Pointing within this many degrees of where Starlink wants counts as aligned. */
const STARLINK_ALIGNED_DEGREES = 1;

const starlink = {
    /** The last answer from /data/starlink.json: { at, dish, map, error, mapError }. */
    data: null,
    requestedAt: 0,
    loading: false,
    /** The map's cells with data, as directions: { obstructed: [dir], clear: [dir] }, and each cell's size (radians). */
    cells: null,
    cellRadians: 0,
    /** The map (its snr text) and dish heading the cells were worked out from. */
    cellsFrom: null,
};

/** From drawSky, each frame: asks for the dish's state every STARLINK_POLL_MS while sky view is open. */
function pollStarlink() {
    if (!layers.starlinkDish) {
        starlink.data = null;
        return;
    }
    const now = Date.now();
    if (starlink.loading || now - starlink.requestedAt < STARLINK_POLL_MS) return;
    starlink.loading = true;
    starlink.requestedAt = now;
    fetch('/data/starlink.json')
        .then(response => response.json())
        .then(data => {
            starlink.data = data;
            mapStarlinkCells();
        })
        .catch(e => { starlink.data = { error: e.message }; })
        .finally(() => { starlink.loading = false; });
}

/**
 * The map's cells as directions, worked out again only when the map changes. The map is centred on
 * the zenith, north up and east right, its edge edgeThetaDeg from the zenith. A map in the dish's own
 * frame is taken as turned with the dish: its top where the dish faces.
 */
function mapStarlinkCells() {
    const map = starlink.data?.map;
    const boresight = starlink.data?.dish?.alignment?.boresight;
    const turn = map?.frame === 'dish' ? boresight?.az ?? 0 : 0;
    const from = map ? `${map.snr.length}:${map.snr.slice(0, 64)}:${map.snr.slice(-64)}:${turn}` : null;
    if (from === starlink.cellsFrom) return;
    starlink.cellsFrom = from;
    starlink.cells = null;
    if (!map) return;
    const bytes = Uint8Array.from(atob(map.snr), c => c.charCodeAt(0));
    const { rows, cols, edgeThetaDeg } = map;
    const obstructed = [], clear = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const value = bytes[r * cols + c];
            if (value === STARLINK_NO_DATA) continue;
            const x = (c + 0.5) / cols * 2 - 1, y = 1 - (r + 0.5) / rows * 2;
            const out = Math.hypot(x, y);
            if (out > 1) continue;
            const az = Math.atan2(x, y) * 180 / Math.PI + turn;
            const dir = direction(az, 90 - out * edgeThetaDeg);
            (value < STARLINK_OBSTRUCTED_SNR * STARLINK_SNR_SCALE ? obstructed : clear).push(dir);
        }
    }
    starlink.cells = { obstructed, clear };
    starlink.cellRadians = edgeThetaDeg * 2 / Math.max(rows, cols) * Math.PI / 180;
}

/** Sky view's drawing of the dish: its map, reach, and where it points. */
function drawStarlink(ctx, project, focal, width, height, labels) {
    pollStarlink();
    const data = starlink.data;
    if (!layers.starlinkDish || !data || data.error === 'off') return;
    if (starlink.cells) drawStarlinkMap(ctx, project, focal, width, height);

    const alignment = data.dish?.alignment;
    const boresight = alignment?.boresight && direction(alignment.boresight.az, alignment.boresight.el);
    const desired = alignment?.desired && direction(alignment.desired.az, alignment.desired.el);
    if (boresight) drawStarlinkReach(ctx, project, boresight, labels);
    if (desired && boresight && angleBetween(desired, boresight) >= STARLINK_ALIGNED_DEGREES) {
        const a = project(boresight), b = project(desired);
        ctx.save();
        ctx.strokeStyle = STARLINK_DISH_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        if (a && b) {
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        if (b) {
            ctx.beginPath();
            ctx.arc(b[0], b[1], 7, 0, 2 * Math.PI);
            ctx.stroke();
            labels.push({ text: 'Starlink wants it here', x: b[0], y: b[1] + 20, priority: LABEL_PRIORITY.dish, size: 12 });
        }
        ctx.restore();
    }
    if (boresight) {
        const p = project(boresight);
        if (p) {
            ctx.save();
            ctx.fillStyle = STARLINK_DISH_COLOR;
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
            const off = desired ? angleBetween(desired, boresight) : 0;
            labels.push({
                text: desired ? (off < STARLINK_ALIGNED_DEGREES ? 'Your dish ✓ aligned' : `Your dish · ${off.toFixed(1)}° off`) : 'Your dish',
                x: p[0], y: p[1] - 16, priority: LABEL_PRIORITY.dish,
            });
        }
    }
    const status = describeStarlinkProblem(data);
    if (status) {
        const tape = headingTapeBox(width, height);
        ctx.save();
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffb347';
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 4;
        ctx.fillText(status, width / 2, tape.top - TAPE_READING_PX - 10, width - 32);
        ctx.restore();
    }
}

/** What is wrong, in a few words, if anything: no dish, or its alerts. */
function describeStarlinkProblem(data) {
    if (data.error) return `Starlink dish: ${data.error}`;
    const alerts = Object.keys(data.dish?.alerts ?? {});
    const names = {
        obstructed: 'obstructed', motorsStuck: 'motors stuck', mastNotNearVertical: 'mast not near vertical',
        thermalThrottle: 'too hot', thermalShutdown: 'too hot, off', movingTooFast: 'moving too fast',
    };
    const shown = alerts.map(key => names[key]).filter(Boolean);
    if (data.dish?.stowed) shown.unshift('stowed');
    return shown.length ? `Starlink dish: ${shown.join(', ')}` : null;
}

/** The cells as small squares, the clear ones faint, the obstructed red. */
function drawStarlinkMap(ctx, project, focal, width, height) {
    const size = Math.max(2, focal * Math.tan(starlink.cellRadians) * 1.05);
    const half = size / 2;
    ctx.save();
    for (const [cells, color] of [[starlink.cells.clear, STARLINK_CLEAR_COLOR], [starlink.cells.obstructed, STARLINK_OBSTRUCTED_COLOR]]) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const dir of cells) {
            const p = project(dir);
            if (!p || p[0] < -size || p[1] < -size || p[0] > width + size || p[1] > height + size) continue;
            ctx.rect(p[0] - half, p[1] - half, size, size);
        }
        ctx.fill();
    }
    ctx.restore();
}

/** The dish's scan cone round where it points: TERMINAL_LIMITS.starlink's angle off boresight. */
function drawStarlinkReach(ctx, project, boresight, labels) {
    const radius = TERMINAL_LIMITS.starlink.maxOffBoresight * Math.PI / 180;
    // Two directions square to the boresight and each other.
    const helper = Math.abs(boresight[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const e1 = unit(cross(boresight, helper));
    const e2 = cross(boresight, e1);
    const at = t => {
        const a = t * Math.PI / 180;
        const dir = boresight.map((c, i) => Math.cos(radius) * c + Math.sin(radius) * (Math.cos(a) * e1[i] + Math.sin(a) * e2[i]));
        // Only the part above the horizon.
        return dir[2] > 0 ? project(dir) : null;
    };
    ctx.save();
    ctx.strokeStyle = groupStyles.starlink?.css ?? STARLINK_DISH_COLOR;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 5]);
    traceCurve(ctx, 0, 360, 2, at);
    ctx.restore();
    const spots = [];
    for (let t = 0; t < 360; t += 20) {
        const p = at(t);
        if (p) spots.push([p[0], p[1] - 10]);
    }
    if (spots.length) {
        labels.push({
            text: `Your dish's reach (±${TERMINAL_LIMITS.starlink.maxOffBoresight}°)`, x: 0, y: 0, spots,
            priority: LABEL_PRIORITY.dish - 1, size: 11, color: groupStyles.starlink?.css,
        });
    }
}
