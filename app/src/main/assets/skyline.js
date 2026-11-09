'use strict';

// The terrain's skyline round the user (layers.skyline), from MainActivity's Skyline at
// /data/skyline/<lat>,<lon>: for each half degree of azimuth, how high the hills and mountains reach
// above the horizontal and how far off that ridge is. Sky view draws it as a silhouette (over the
// camera, as a line to check the compass against); anything below it and beyond the ridge is hidden
// by the terrain, which sky view and the in-view list say.
//
// Asked for only once sky view or the in-view list is opened, as the terrain round a new place is
// a download; again when the user moves SKYLINE_MOVE_KM.

const SKYLINE_MOVE_KM = 0.3;
/** After a failure, how long before asking again (it may have been offline). */
const SKYLINE_RETRY_MS = 60_000;
const SKYLINE_FILL = '#1a222c';
const SKYLINE_RIDGE = 'rgba(160, 185, 210, 0.55)';

const skyline = {
    /** { lat, lon, groundM, step, angles, distancesKm } for where it was worked out, or null. */
    profile: null,
    /** Where the last request was for, and when, while one is out or after it failed. */
    asked: null,
    askedAt: 0,
    loading: false,
    /** "offline" or "unavailable" when the last request failed. */
    error: null,
};

/** Fetches the skyline here, unless the one there is (or is coming) is still close enough. */
function loadSkyline() {
    if (!layers.skyline || !here) return;
    const [lon, lat] = here;
    const near = place => place && haversineKm(place.lat, place.lon, lat, lon) < SKYLINE_MOVE_KM;
    if (skyline.loading || near(skyline.profile)) return;
    if (near(skyline.asked) && Date.now() - skyline.askedAt < SKYLINE_RETRY_MS) return;
    skyline.asked = { lat, lon };
    skyline.askedAt = Date.now();
    skyline.loading = true;
    fetch(`/data/skyline/${lat.toFixed(4)},${lon.toFixed(4)}`)
        .then(response => response.json())
        .catch(() => ({ error: 'unavailable' }))
        .then(data => {
            skyline.loading = false;
            skyline.error = data.error ?? null;
            if (!data.error) skyline.profile = data;
            if (inView.node) refreshInView();
        });
}

/** Where the skyline is at an azimuth: { el (degrees), km }, or null without one. */
function skylineAt(az) {
    const p = skyline.profile;
    if (!p || !layers.skyline) return null;
    const n = p.angles.length;
    const f = (((az % 360) + 360) % 360) / p.step;
    const i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
    return { el: p.angles[i] * (1 - t) + p.angles[j] * t, km: Math.min(p.distancesKm[i], p.distancesKm[j]) };
}

/** Whether the terrain hides something at (az, el) and rangeKm away: below the ridge and beyond it. */
function behindTerrain(az, el, rangeKm = Infinity) {
    const ridge = skylineAt(az);
    return !!ridge && el < ridge.el && rangeKm > ridge.km;
}

/**
 * The skyline in sky view: filled down to the horizon in the dark, a line over the camera (where
 * it should sit on the real ridge, if the compass is right) and the ridge itself picked out.
 */
function drawSkyline(ctx, project, camera) {
    const p = skyline.profile;
    if (!p || !layers.skyline) return;
    const n = p.angles.length;
    // Runs of the ridge in front of the phone, each closed along the horizon below it.
    const runs = [];
    let run = [];
    for (let i = 0; i <= n; i++) {
        const az = i * p.step;
        const top = project(direction(az, Math.max(p.angles[i % n], 0)));
        const bottom = project(direction(az, 0));
        if (top && bottom) {
            run.push([top, bottom]);
        } else if (run.length) {
            runs.push(run);
            run = [];
        }
    }
    if (run.length) runs.push(run);
    ctx.save();
    if (!camera) {
        ctx.fillStyle = SKYLINE_FILL;
        for (const points of runs) {
            if (points.length < 2) continue;
            ctx.beginPath();
            points.forEach(([top], k) => (k ? ctx.lineTo(top[0], top[1]) : ctx.moveTo(top[0], top[1])));
            for (let k = points.length - 1; k >= 0; k--) ctx.lineTo(points[k][1][0], points[k][1][1]);
            ctx.closePath();
            ctx.fill();
        }
    }
    ctx.strokeStyle = camera ? 'rgba(255, 255, 255, 0.6)' : SKYLINE_RIDGE;
    ctx.lineWidth = camera ? 1.5 : 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const points of runs) {
        points.forEach(([top], k) => (k ? ctx.lineTo(top[0], top[1]) : ctx.moveTo(top[0], top[1])));
    }
    ctx.stroke();
    ctx.restore();
}

/** A line for the in-view list's title on the terrain's part in it. */
function describeSkyline() {
    if (!layers.skyline) return '';
    if (skyline.profile) return '';
    if (skyline.loading) return 'Getting the terrain round here…';
    if (skyline.error === 'offline') return 'Terrain not downloaded here (offline mode): hills aren\'t allowed for.';
    if (skyline.error) return 'Couldn\'t get the terrain round here: hills aren\'t allowed for.';
    return '';
}

locationListeners.push(() => {
    if (sky.open || inView.node) loadSkyline();
});
layerListeners.push(() => {
    if (layers.skyline && (sky.open || inView.node)) loadSkyline();
});
