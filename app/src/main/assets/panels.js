'use strict';

// The page's own panels:
//   - the info sheet for the selected satellite: names, catalogue details, orbit, live position,
//     pointing, the next pass and close approach, a star to keep it as a favourite, and Follow,
//     Passes and Align dish buttons; or for the Sun or Moon: where it is, rise and set, twilight,
//     phase and the next new and full Moon
//   - search, opened by MainActivity's search button (globe.openSearch); empty, it lists favourites
//   - the colour legend, with how old the orbital data is
// and the Android back button, which closes whichever panel (or sky view, the dish aligner, events or
// the time bar) is open: MainActivity sends it to globe.back() while Android.setOverlayOpen(true)
// says something is.

const SEARCH_RESULTS = 30;
const SHEET_REFRESH_MS = 1000;
/** A "never rises" or "always up" answer is worked out again after this long on the clock. */
const NEXT_PASS_RECHECK_MS = 10 * 60 * 1000;
/** Orbital data older than this is flagged in the legend: the phone has likely been offline. */
const STALE_DATA_MS = 2 * 24 * 60 * 60 * 1000;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

// ---- Info sheet ----

const sheet = {
    node: null,
    /** The satellite the sheet shows, so a new selection rebuilds it. */
    sat: null,
    passesOpen: false,
    outagesOpen: false,
    /** { sat, at (clock time), result (predictPasses with one pass) } for the next-pass line. */
    nextPass: null,
    /** { sat, at, result (shadowChanges) } for the shadow line. */
    shadow: null,
};

function updateSheet() {
    const shown = selected ?? selectedBody ?? selectedAircraft;
    if (shown !== sheet.sat) {
        sheet.node?.remove();
        sheet.node = null;
        sheet.sat = shown;
        sheet.passesOpen = false;
        sheet.outagesOpen = false;
        sheet.shadow = null;
        sheet.bodyTimes = null;
        if (shown) buildSheet(shown);
        overlaysChanged();
    }
    if (!sheet.node) return;
    sheet.node.querySelector('.follow').classList.toggle('on', following);
    refreshSheetLive();
}

function buildSheet(sat) {
    if (sat.kind) {
        buildBodySheet(sat);
        return;
    }
    if (sat.isAircraft) {
        buildAircraftSheet(sat);
        return;
    }
    const style = groupStyles[sat.group];
    const node = el('div', 'sheet');
    const header = el('div', 'sheet-header');
    const title = el('div', 'sheet-title');
    title.append(el('b', '', sat.name),
        el('div', 'sheet-sub', [sat.name !== sat.officialName ? sat.officialName : null, sat.objectId, `#${sat.id}`].filter(Boolean).join(' · ')));
    const star = el('button', 'sheet-close sheet-star');
    star.setAttribute('aria-label', 'Star');
    star.addEventListener('click', () => toggleFavourite(sat));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => select(null));
    header.append(title, star, close);

    const group = el('div', 'sheet-line');
    const swatch = el('span', 'swatch');
    swatch.style.background = style.css;
    group.append(swatch, document.createTextNode(style.label));
    const details = el('div', 'sheet-line sheet-details', 'Looking up catalogue details…');
    loadDetails(sat).then(text => { details.textContent = text || 'No catalogue details'; });

    const buttons = el('div', 'sheet-buttons');
    const follow = el('button', 'follow', 'Follow');
    follow.addEventListener('click', () => setFollowing(!following));
    const passes = el('button', 'passes-button', 'Passes');
    passes.addEventListener('click', () => togglePasses(sat));
    const align = el('button', 'align-button', 'Align dish');
    align.addEventListener('click', () => openDish(sat));
    buttons.append(follow, passes);
    // Sun outages only happen to satellites that stay put in the sky.
    if (isGeostationary(sat.satrec)) {
        const outages = el('button', 'outages-button', 'Sun outages');
        outages.addEventListener('click', () => toggleOutages(sat));
        buttons.append(outages);
    }
    buttons.append(align);

    const approach = el('button', 'sheet-line sheet-approach');
    approach.addEventListener('click', () => {
        const row = nextApproach(sat);
        if (row) showApproach(row);
    });
    node.append(header, group, details, el('div', 'sheet-line sheet-orbit', describeOrbit(sat.satrec)),
        el('div', 'sheet-line sheet-live'), el('div', 'sheet-line sheet-shadow'), el('div', 'sheet-line sheet-pointing'),
        el('div', 'sheet-line sheet-next'), approach, buttons, el('div', 'sheet-passes'), el('div', 'sheet-outages'));
    document.body.appendChild(node);
    sheet.node = node;
    refreshStar();
}

function refreshStar() {
    const star = sheet.node?.querySelector('.sheet-star');
    if (!star) return;
    const on = favourites.has(sheet.sat.id);
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('on', on);
    star.setAttribute('aria-label', on ? 'Unstar' : 'Star');
}

function refreshSheetLive() {
    const sat = sheet.sat;
    if (sheet.node && sat?.kind) {
        refreshBodySheet(sat.kind);
        return;
    }
    if (sheet.node && sat?.isAircraft) {
        refreshAircraftSheet(sat);
        return;
    }
    if (!sheet.node || !sat?.now) return;
    sheet.node.querySelector('.sheet-live').textContent = [
        `${Math.round(sat.now.altKm).toLocaleString()} km up`,
        `${Math.round(sat.now.speedKmS * 3600).toLocaleString()} km/h`,
        `${Math.abs(sat.now.lat).toFixed(1)}°${sat.now.lat >= 0 ? 'N' : 'S'} ${Math.abs(sat.now.lon).toFixed(1)}°${sat.now.lon >= 0 ? 'E' : 'W'}`,
    ].join(' · ');
    sheet.node.querySelector('.sheet-shadow').textContent = describeShadow(sat);
    sheet.node.querySelector('.sheet-pointing').textContent = describePointing(sat);
    sheet.node.querySelector('.sheet-next').textContent = describeNextPass(sat);
    const approach = nextApproach(sat);
    const approachNode = sheet.node.querySelector('.sheet-approach');
    approachNode.style.display = approach ? '' : 'none';
    if (approach) {
        const [id1, name1, id2, name2, tca, rangeKm] = approach;
        const other = id1 === sat.id ? (satellites.get(id2)?.name ?? name2) : (satellites.get(id1)?.name ?? name1);
        const when = tca > simNow() ? `in ${describeDuration(tca - simNow())}` : 'just now';
        approachNode.textContent = `⚠ Close approach: ${describeRange(rangeKm)} from ${other}, ${dayTime(tca)} (${when}). Tap to see it.`;
    }
}

/** The pass line: a countdown to the next pass, or how the one under way goes. */
function describeNextPass(sat) {
    if (!here) return '';
    const now = simNow();
    let cached = sheet.nextPass;
    const result = cached?.sat === sat ? cached.result : null;
    const pass = Array.isArray(result) ? result[0] : null;
    const valid = result && now >= cached.at && (pass ? now < pass.set.getTime() : now - cached.at < NEXT_PASS_RECHECK_MS);
    if (!valid) {
        try {
            cached = sheet.nextPass = { sat, at: now, result: predictPasses(sat, here[1], here[0], now, 1) };
        } catch (e) {
            console.error('Predicting the next pass failed', e);
            sheet.nextPass = null;
            return '';
        }
    }
    const next = cached.result;
    if (!Array.isArray(next)) return `Always above your horizon: ${Math.round(next.alwaysUp.el)}° up in the ${compass(next.alwaysUp.az)}.`;
    if (!next.length) return `Doesn't rise over ${MIN_PASS_ELEVATION}° here in the next ${PASS_DAYS} days.`;
    const p = next[0];
    const time = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (now < p.rise.getTime()) {
        return `Next pass in ${describeDuration(p.rise - now)}: rises ${time(p.rise)} in the ${compass(p.riseAz)}, ` +
            `up to ${Math.round(p.peakEl)}°, sets ${time(p.set)} in the ${compass(p.setAz)}${p.visible ? ' · ★ visible' : ''}` +
            describePassReach(sat, p);
    }
    const peak = now < p.peak.getTime() ? `peaks at ${Math.round(p.peakEl)}° in ${describeDuration(p.peak - now)}` : 'past its highest';
    let reach = describePassReach(sat, p);
    if (reach && p.reach) {
        reach = now < p.reach.start.getTime() ? reach
            : now < p.reach.end.getTime() ? ` · in terminal reach for ${describeDuration(p.reach.end - now)} more`
            : ' · past terminal reach';
    }
    return `Passing now: ${peak}, sets in ${describeDuration(p.set - now)} in the ${compass(p.setAz)}` + reach;
}

/** " · terminal reach 9:41–9:44 PM (3 min)", or " · out of terminal reach", for a terminal-limited satellite; else ''. */
function describePassReach(sat, p) {
    return terminalLimit(sat) ? ` · ${passReach(p)}` : '';
}

/** "terminal reach 9:41–9:44 PM (3 min)" while the pass is above the terminal's limit, or "out of terminal reach". */
function passReach(p) {
    if (!p.reach) return 'out of terminal reach';
    const time = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const minutes = Math.max(1, Math.round((p.reach.end - p.reach.start) / 60_000));
    return `terminal reach ${time(p.reach.start)}–${time(p.reach.end)} (${minutes} min)`;
}
timeListeners.push(() => {
    sheet.nextPass = null;
    refreshSheetLive();
});
// Another location: its passes, rise and set times and sun outages, not the old place's.
locationListeners.push(() => {
    sheet.nextPass = null;
    sheet.bodyTimes = null;
    if (sheet.outagesOpen && sheet.sat) findOutages(sheet.sat);
    refreshSheetLive();
});

/**
 * In sunlight or Earth's shadow, and when that next changes: "In sunlight · into Earth's shadow in
 * 12 min (9:42 PM) for 33 min". Kept until the next change, or for a while when there is none.
 */
function describeShadow(sat) {
    const now = simNow();
    let cached = sheet.shadow;
    const result = cached?.sat === sat ? cached.result : null;
    const valid = result && now >= cached.at && now < (result.changes[0] ?? cached.at + NEXT_PASS_RECHECK_MS);
    if (!valid) {
        try {
            cached = sheet.shadow = { sat, at: now, result: shadowChanges(sat, now) };
        } catch (e) {
            console.error('Working out shadow times failed', e);
            sheet.shadow = null;
            return '';
        }
    }
    const shadow = cached.result;
    if (!shadow) return '';
    const [change, after] = shadow.changes;
    const time = t => clockTime(t, now);
    const hours = Math.round((shadow.searchedTo - cached.at) / 3_600_000);
    if (!shadow.shadowed) {
        if (!change) return `☀ In sunlight · no eclipse in the next ${hours} h`;
        return `☀ In sunlight · into Earth's shadow in ${describeDuration(change - now)} (${time(change)})` +
            (after ? ` for ${describeDuration(after - change)}` : '');
    }
    if (!change) return `● In Earth's shadow for at least the next ${hours} h`;
    return `● In Earth's shadow · back in sunlight in ${describeDuration(change - now)} (${time(change)})`;
}
timeListeners.push(() => {
    sheet.shadow = null;
});

/** Where to point at the satellite from here: azimuth, elevation, skew and range. */
function describePointing(sat) {
    if (!here) return 'Pointing: waiting for your location…';
    const [lon, lat] = here;
    const look = pointingAt(sat.satrec, lat, lon);
    if (!look) return '';
    const skew = Math.abs(look.skew) < 0.05 ? '0.0°'
        : `${Math.abs(look.skew).toFixed(1)}° ${look.skew > 0 ? 'counter-clockwise' : 'clockwise'}`;
    return [
        `From here: Az ${look.az.toFixed(1)}° ${compass(look.az)}`,
        `El ${look.el.toFixed(1)}°${look.el < 0 ? ' (below the horizon)' : ''}`,
        `Skew ${skew}`,
        `${Math.round(look.rangeKm).toLocaleString()} km away`,
        describeTerminalReach(sat, look.el),
    ].filter(Boolean).join(' · ');
}

/**
 * For a satellite whose terminals have a scan limit (TERMINAL_LIMITS): whether a terminal laid flat
 * here can reach it now, and how far off boresight; else ''.
 */
function describeTerminalReach(sat, elevation) {
    const limit = terminalLimit(sat);
    if (!limit) return '';
    const reach = reachElevation(limit);
    if (elevation >= reach) return `Terminal: in reach, ${describeReach(sat, elevation)}`;
    return `Terminal: out of reach, ${describeReach(sat, elevation)} (needs ${reach}° up)`;
}
setInterval(refreshSheetLive, SHEET_REFRESH_MS);

// ---- The Sun and Moon's sheet ----

function buildBodySheet(body) {
    const node = el('div', 'sheet');
    const header = el('div', 'sheet-header');
    const title = el('div', 'sheet-title');
    title.append(el('b', '', body.kind === 'sun' ? '☀ Sun' : '☾ Moon'), el('div', 'sheet-sub body-sub'));
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => selectBody(null));
    header.append(title, close);
    const buttons = el('div', 'sheet-buttons');
    const follow = el('button', 'follow', 'Follow');
    follow.addEventListener('click', () => setFollowing(!following));
    buttons.append(follow);
    node.append(header,
        el('div', 'sheet-line body-where'), el('div', 'sheet-line sheet-pointing'),
        el('div', 'sheet-line body-now'), el('div', 'sheet-line body-day'), el('div', 'sheet-line sheet-hint body-extra'),
        buttons);
    document.body.appendChild(node);
    sheet.node = node;
}

function refreshBodySheet(kind) {
    const node = sheet.node;
    const text = (selector, value) => { node.querySelector(selector).textContent = value; };
    const now = simNow();
    const { lat, lon } = bodySubpoint(kind);
    const overhead = `Overhead at ${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
    if (kind === 'sun') {
        const au = sunDistanceAu(new Date(now));
        text('.body-sub', 'Our star');
        text('.body-where', `${overhead} · ${(au * 149.5979).toFixed(1)} million km away (${au.toFixed(4)} AU)`);
    } else {
        text('.body-sub', `${moon.phase} · ${Math.round(moon.lit * 100)}% lit · ${moon.age.toFixed(1)} days old`);
        text('.body-where', `${overhead} · ${Math.round(moon.distanceKm).toLocaleString()} km away (light takes ${(moon.distanceKm / 299792.458).toFixed(2)} s)`);
    }
    if (!here) {
        text('.sheet-pointing', 'Rise and set need your location.');
        return;
    }
    const [az, elevation] = bodyLook(kind, now, here[1], here[0]);
    text('.sheet-pointing', `From here: Az ${az.toFixed(1)}° ${compass(az)} · El ${elevation.toFixed(1)}°${elevation < HORIZON_ELEVATION ? ' (below the horizon)' : ''}`);

    let times = sheet.bodyTimes;
    if (!times || times.kind !== kind || now < times.at || now >= times.until) {
        try {
            times = sheet.bodyTimes = bodyTimes(kind, now, here[1], here[0]);
        } catch (e) {
            console.error('Working out rise and set failed', e);
            return;
        }
    }
    text('.body-now', times.now(now));
    text('.body-day', times.day);
    text('.body-extra', times.extra);
}

/** How far back the Sun's and Moon's sheet looks for the rise of the day or pass under way. */
const BODY_LOOK_BACK_HOURS = 22;

/** "4:54 PM", with the day when it isn't the same day as `now`. */
function clockTime(t, now) {
    const time = new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (new Date(t).toDateString() === new Date(now).toDateString()) return time;
    return new Date(t).toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time;
}

/**
 * The sheet's rise, set and phase lines for the Sun or Moon from (lat, lon) at `now`, kept until the
 * next event: { now(t) (a line with countdowns), day, extra, at, until }.
 */
function bodyTimes(kind, now, lat, lon) {
    // From well before now, to find the rise of a day already under way: a winter full Moon can be
    // up for 18 hours or more.
    const events = bodyEvents(kind, now - BODY_LOOK_BACK_HOURS * 3_600_000, BODY_LOOK_BACK_HOURS + 30, lat, lon);
    const after = type => events.find(e => e.type === type && e.t > now);
    const before = type => events.filter(e => e.type === type && e.t <= now).pop();
    const up = bodyLook(kind, now, lat, lon)[1] > HORIZON_ELEVATION;
    const nextRise = after('rise'), nextSet = after('set'), nextPeak = after('peak');
    const upcoming = events.filter(e => e.t > now).map(e => e.t);
    const until = Math.min(now + 10 * 60_000, ...upcoming);
    const at = t => clockTime(t, now);

    let nowLine;
    if (!nextRise && !nextSet) {
        const always = up
            ? (kind === 'sun' ? 'Up all day (midnight Sun)' : 'Up all day')
            : (kind === 'sun' ? 'Below the horizon all day (polar night)' : 'Below the horizon all day');
        nowLine = () => always;
    } else if (up) {
        nowLine = t => [
            `Up now`,
            nextPeak && nextPeak.t < (nextSet?.t ?? Infinity) ? `highest ${Math.round(nextPeak.el)}° in the ${compass(nextPeak.az)} in ${describeDuration(nextPeak.t - t)}` : null,
            nextSet ? `sets in ${describeDuration(nextSet.t - t)} (${at(nextSet.t)}) in the ${compass(nextSet.az)}` : null,
        ].filter(Boolean).join(' · ');
    } else {
        nowLine = t => `Rises in ${describeDuration(nextRise.t - t)} (${at(nextRise.t)}) in the ${compass(nextRise.az)}`;
    }

    // The day (the Sun's) or pass (the Moon's) under way, else the next one.
    const rise = up ? before('rise') : nextRise;
    const set = events.find(e => e.type === 'set' && e.t > (rise?.t ?? now));
    const peak = events.find(e => e.type === 'peak' && e.t > (rise?.t ?? now - 12 * 3_600_000) && e.t < (set?.t ?? Infinity));
    const word = kind === 'sun' ? ['Sunrise', 'Sunset'] : ['Moonrise', 'Moonset'];
    const day = [
        rise && `${word[0]} ${at(rise.t)} ${compass(rise.az)}`,
        peak && `${kind === 'sun' ? 'Noon' : 'Highest'} ${at(peak.t)} at ${Math.round(peak.el)}°`,
        set && `${word[1]} ${at(set.t)} ${compass(set.az)}`,
        kind === 'sun' && rise && set && `${describeDuration(set.t - rise.t)} of daylight`,
    ].filter(Boolean).join(' · ');

    let extra;
    if (kind === 'sun') {
        const twilight = bodyEvents('sun', now, 30, lat, lon, CIVIL_TWILIGHT_ELEVATION);
        const dawn = twilight.find(e => e.type === 'rise'), dusk = twilight.find(e => e.type === 'set');
        extra = dawn || dusk
            ? 'Civil twilight: ' + [dawn && `dawn ${at(dawn.t)}`, dusk && `dusk ${at(dusk.t)}`].filter(Boolean).join(' · ') +
              '. Satellites show best in the dark after dusk and before dawn.'
            : 'No civil twilight in the next day here.';
    } else {
        const phases = [[0, 'New Moon'], [90, 'First quarter'], [180, 'Full Moon'], [270, 'Last quarter']]
            .map(([elongation, label]) => [nextMoonPhase(elongation, now), label])
            .filter(([t]) => t)
            .sort((a, b) => a[0] - b[0])
            .slice(0, 2);
        extra = phases.map(([t, label]) => `${label} ${dayTime(t)}`).join(' · ');
    }
    return { kind, at: now, until, now: nowLine, day, extra };
}
timeListeners.push(() => {
    sheet.bodyTimes = null;
});

/** "Low Earth orbit · 415 × 422 km · 92.9 min · 51.6°" from the SGP4 record. */
function describeOrbit(satrec) {
    const MU = 398600.4418, RADIUS = 6378.137;
    const n = satrec.no / 60; // radians per second
    const a = Math.cbrt(MU / (n * n));
    const perigee = a * (1 - satrec.ecco) - RADIUS, apogee = a * (1 + satrec.ecco) - RADIUS;
    const periodMin = 2 * Math.PI / satrec.no;
    const kind = satrec.ecco >= 0.25 ? 'Highly elliptical orbit'
        : Math.abs(periodMin - 1436) < 30 ? (satrec.inclo * 180 / Math.PI < 1 ? 'Geostationary orbit' : 'Geosynchronous orbit')
        : apogee < 2000 ? 'Low Earth orbit'
        : 'Medium Earth orbit';
    const period = periodMin < 120 ? `${periodMin.toFixed(1)} min` : `${(periodMin / 60).toFixed(1)} h`;
    const km = x => Math.round(x).toLocaleString();
    return `${kind} · ${km(perigee)} × ${km(apogee)} km · ${period} · ${(satrec.inclo * 180 / Math.PI).toFixed(1)}° inclination`;
}

function togglePasses(sat) {
    const list = sheet.node.querySelector('.sheet-passes');
    sheet.passesOpen = !sheet.passesOpen;
    sheet.node.querySelector('.passes-button').classList.toggle('on', sheet.passesOpen);
    list.replaceChildren();
    if (!sheet.passesOpen) return;
    if (!here) {
        list.append(el('div', 'sheet-line', 'Passes need your location.'));
        return;
    }
    list.append(el('div', 'sheet-line', 'Working out passes…'));
    // Let the message paint before the few hundred milliseconds of calculation.
    setTimeout(() => {
        if (sheet.sat !== sat || !sheet.passesOpen) return;
        try {
            list.replaceChildren(...passRows(predictPasses(sat, here[1], here[0]), sat));
        } catch (e) {
            console.error('Predicting passes failed', e);
            list.replaceChildren(el('div', 'sheet-line', "Couldn't work out passes for this satellite."));
        }
    }, 30);
}

// ---- Sun outages (geostationary satellites; passes.js) ----

/** The dish the outage windows are for; kept while the app runs. */
const outageDish = { diameterM: 0.6, band: 'Ku' };
/** Days searched per chunk, so the app stays responsive and shows progress. */
const OUTAGE_CHUNK_DAYS = 30;

function toggleOutages(sat) {
    sheet.outagesOpen = !sheet.outagesOpen;
    sheet.node.querySelector('.outages-button').classList.toggle('on', sheet.outagesOpen);
    sheet.node.querySelector('.sheet-outages').replaceChildren();
    if (sheet.outagesOpen) findOutages(sat);
}

/** Searches the year ahead a chunk at a time, then lists the outage days. */
function findOutages(sat) {
    const list = sheet.node.querySelector('.sheet-outages');
    const run = sheet.outageRun = (sheet.outageRun ?? 0) + 1;
    if (!here) {
        list.replaceChildren(el('div', 'sheet-line', 'Sun outages need your location.'));
        return;
    }
    const [lon, lat] = here;
    const from = simNow();
    const angle = outageAngle(outageDish.diameterM, outageDish.band);
    const status = el('div', 'sheet-line', `Looking for when the Sun passes behind ${sat.name} from here…`);
    list.replaceChildren(outageDishPicker(sat), status);
    let search, chunk = 0;
    const found = [];
    const next = () => {
        if (sheet.sat !== sat || !sheet.outagesOpen || run !== sheet.outageRun) return;
        try {
            if (!search) {
                search = prepareSunOutages(sat, lat, lon, from);
                if (search.neverUp) {
                    list.replaceChildren(el('div', 'sheet-line', `${sat.name} is always below your horizon, so it has no sun outages here.`));
                    return;
                }
            }
            const start = from + chunk * OUTAGE_CHUNK_DAYS * 86_400_000;
            if (start >= from + OUTAGE_DAYS * 86_400_000) {
                list.replaceChildren(outageDishPicker(sat), ...outageRows(sat, found, angle));
                return;
            }
            const end = Math.min(start + OUTAGE_CHUNK_DAYS * 86_400_000, from + OUTAGE_DAYS * 86_400_000);
            found.push(...search.search(start, end, angle));
        } catch (e) {
            console.error('Finding sun outages failed', e);
            list.replaceChildren(el('div', 'sheet-line', "Couldn't work out sun outages for this satellite."));
            return;
        }
        chunk++;
        status.textContent = `Looking for when the Sun passes behind ${sat.name} from here… ` +
            `${Math.min(chunk * OUTAGE_CHUNK_DAYS, OUTAGE_DAYS)} of ${OUTAGE_DAYS} days` + (found.length ? ` (${found.length} found)` : '');
        setTimeout(next, 0);
    };
    // Let the message paint first.
    setTimeout(next, 30);
}

/** Dish size and band, which set how wide the outage is; changing either searches again. */
function outageDishPicker(sat) {
    const node = el('div', 'outage-dish');
    const sizes = el('div', 'segmented');
    for (const diameterM of DISH_SIZES_M) {
        const button = el('button', diameterM === outageDish.diameterM ? 'on' : '', diameterM < 1 ? `${diameterM * 100} cm` : `${diameterM} m`);
        button.addEventListener('click', () => {
            outageDish.diameterM = diameterM;
            findOutages(sat);
        });
        sizes.append(button);
    }
    const bands = el('div', 'segmented');
    for (const band of Object.keys(BAND_WAVELENGTHS_M)) {
        const button = el('button', band === outageDish.band ? 'on' : '', `${band} band`);
        button.addEventListener('click', () => {
            outageDish.band = band;
            findOutages(sat);
        });
        bands.append(button);
    }
    node.append(sizes, bands);
    return node;
}

function outageRows(sat, days, angle) {
    const dish = `${outageDish.diameterM < 1 ? `${outageDish.diameterM * 100} cm` : `${outageDish.diameterM} m`} ${outageDish.band}-band dish`;
    const hint = el('div', 'sheet-line sheet-hint',
        `When the Sun passes behind ${sat.name} as seen from here, in the next ${OUTAGE_DAYS} days. A dish aimed at it then also ` +
        `points at the Sun, whose noise drowns the signal: an outage, for a ${dish} while the Sun is within ${angle.toFixed(1)}° ` +
        `(its beam is ${dishBeamwidth(outageDish.diameterM, outageDish.band).toFixed(1)}° wide). Assumes the satellite stays in its slot. ` +
        'Tap a day to see it in sky view. Never look at the Sun without a proper solar filter.');
    if (!days.length) {
        return [el('div', 'sheet-line', `The Sun doesn't pass within ${angle.toFixed(1)}° of ${sat.name} from here in the next ${OUTAGE_DAYS} days.`), hint];
    }
    const day = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const time = (t, seconds) => new Date(t).toLocaleTimeString(undefined, seconds
        ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    const span = ([start, end], seconds) => `${time(start, seconds)}–${time(end, seconds)} (${describeDuration(end - start)})`;
    // A season is a run of days in a row: "Outages 3–8 Mar".
    const seasons = [];
    for (const d of days) {
        const last = seasons[seasons.length - 1];
        if (last && d.t - last[last.length - 1].t < 3 * 86_400_000) last.push(d); else seasons.push([d]);
    }
    const rows = [hint];
    for (const season of seasons) {
        const first = new Date(season[0].t), last = new Date(season[season.length - 1].t);
        const short = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        rows.push(el('div', 'search-heading', `Outages ${short(first)}${season.length > 1 ? ` – ${short(last)}` : ''} (${season.length} day${season.length > 1 ? 's' : ''})`));
        for (const d of season) {
            const row = el('button', 'pass transit' + (d.behind ? ' visible' : ''));
            row.append(
                el('span', 'pass-when', `${day(d.t)} · closest ${time(d.t, true)}, ${d.separation.toFixed(2)}° off`),
                el('span', 'pass-seen', d.behind ? `☀ Sun behind it ${span(d.behind, true)}` : `Sun's edge passes ${(d.separation - SUN_RADIUS_DEGREES).toFixed(2)}° off it`),
                el('span', 'pass-what', `Outage for your dish ${span(d.outage, false)} · Sun ${Math.round(d.sunElevation)}° up`),
            );
            row.addEventListener('click', () => {
                setTimeOffset(d.t - Date.now());
                showTimeBar();
            });
            rows.push(row);
        }
    }
    return rows;
}

function passRows(passes, sat) {
    if (!Array.isArray(passes)) {
        const { az, el: elevation } = passes.alwaysUp;
        return [el('div', 'sheet-line', `Always above your horizon: ${Math.round(elevation)}° up in the ${compass(az)}.`)];
    }
    if (!passes.length) return [el('div', 'sheet-line', `No passes over ${MIN_PASS_ELEVATION}° in the next ${PASS_DAYS} days.`)];
    const day = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return [
        el('div', 'sheet-line sheet-hint', `Next ${PASS_DAYS} days over ${MIN_PASS_ELEVATION}°. ★ visible to the eye: sunlit, in a dark sky.`
            + (terminalLimit(sat) ? ` Terminal reach: while over ${reachElevation(terminalLimit(sat))}°, for a terminal laid flat.` : '')),
        ...passes.map(p => {
            const minutes = Math.max(1, Math.round((p.set - p.rise) / 60_000));
            const row = el('div', 'pass' + (p.visible ? ' visible' : ''));
            row.append(
                el('span', 'pass-when', `${p.visible ? '★ ' : ''}${day(p.rise)} ${time(p.rise)}`),
                el('span', 'pass-what',
                    `${compass(p.riseAz)} → ${Math.round(p.peakEl)}° ${compass(p.peakAz)} → ${compass(p.setAz)} · ${minutes} min`),
            );
            if (p.visible) {
                const { start, end, startAz, endAz, peakEl } = p.seen;
                row.append(el('span', 'pass-seen',
                    `Visible ${time(start)}–${time(end)}, ${compass(startAz)} to ${compass(endAz)}, up to ${Math.round(peakEl)}°`));
            }
            if (terminalLimit(sat)) {
                const reach = passReach(p);
                row.append(el('span', 'pass-reach', reach[0].toUpperCase() + reach.slice(1)));
            }
            return row;
        }),
    ];
}

/**
 * The satellite's catalogue record as a line of text, e.g. "China · Payload · Launched 29 Apr 2021 ·
 * Operational", or '' if there is none. Only a successful lookup is kept, so one made offline is
 * tried again next time.
 */
function loadDetails(sat) {
    if (!sat.details) {
        const lookup = fetch(`/data/satcat/${sat.id}`)
            .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
            .then(([record] = []) => record ? describe(record) : '');
        sat.details = lookup;
        lookup.catch(() => {
            if (sat.details === lookup) sat.details = null;
        });
    }
    return sat.details.catch(() => '');
}

function describe(record) {
    const launched = record.LAUNCH_DATE &&
        new Date(record.LAUNCH_DATE + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    return [
        OWNERS[record.OWNER] ?? record.OWNER,
        OBJECT_TYPES[record.OBJECT_TYPE] ?? record.OBJECT_TYPE,
        launched && `Launched ${launched}`,
        OPS_STATUSES[record.OPS_STATUS_CODE],
    ].filter(Boolean).join(' · ');
}

satelliteListeners.push(updateSheet);

// ---- Search ----

let searchNode = null;

function openSearch() {
    if (searchNode) {
        searchNode.querySelector('input').focus();
        return;
    }
    // The lists open in the same place.
    if (inView.node) closeInView();
    if (events.node) closeEvents();
    searchNode = el('div', 'search');
    const row = el('div', 'search-row');
    const input = el('input');
    input.type = 'search';
    input.placeholder = `Search ${satellites.size.toLocaleString()} satellites: name, number or designator`;
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close search');
    close.addEventListener('click', closeSearch);
    row.append(input, close);
    const results = el('div', 'search-results');
    input.addEventListener('input', () => results.replaceChildren(...searchRows(input.value)));
    // The starred satellites to start with.
    results.replaceChildren(...searchRows(''));
    searchNode.append(row, results);
    document.body.appendChild(searchNode);
    input.focus();
    overlaysChanged();
}

function closeSearch() {
    searchNode?.remove();
    searchNode = null;
    overlaysChanged();
}

/**
 * The starred satellites first, narrowed to those matching as the user types; then, from two
 * characters, the other satellites that match.
 */
function searchRows(query) {
    const q = query.trim().toLowerCase();
    /** How well a satellite matches: names starting with the query, then containing it, then numbers; -1 not at all. */
    const rank = sat => {
        if (!q) return 0;
        const name = sat.name.toLowerCase(), official = sat.officialName.toLowerCase();
        return name.startsWith(q) || official.startsWith(q) ? 0
            : name.includes(q) || official.includes(q) ? 1
            : String(sat.id).startsWith(q) || sat.objectId?.toLowerCase().startsWith(q) ? 2
            : -1;
    };
    const byRank = (a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name);
    const rows = [];

    const starred = [...favourites].map(id => satellites.get(id)).filter(Boolean)
        .map(sat => [rank(sat), sat]).filter(([r]) => r >= 0).sort(byRank);
    if (starred.length) rows.push(el('div', 'search-heading', '★ Starred'), ...starred.map(([, sat]) => searchRow(sat)));
    if (!q) {
        if (!favourites.size) rows.push(el('div', 'search-empty', 'Tip: star a satellite (☆ in its info) to keep it labelled and listed here.'));
        const hidden = [...favourites].filter(id => !satellites.has(id)).length;
        if (hidden) rows.push(el('div', 'search-empty', `${hidden} more starred in satellite groups that are turned off.`));
        return rows;
    }
    if (q.length < 2) {
        rows.push(el('div', 'search-empty', 'Keep typing to search all satellites.'));
        return rows;
    }

    if (aircraftLive()) {
        const planes = [...aircraft.values()].filter(a => [a.callsign, a.registration, a.hex, a.type]
            .some(v => v?.toLowerCase().startsWith(q))).sort((a, b) => a.name.localeCompare(b.name));
        if (planes.length) {
            rows.push(el('div', 'search-heading search-heading-all', '✈ Aircraft'),
                ...planes.slice(0, SEARCH_RESULTS).map(a =>
                    aircraftRow(a, [a.type, a.registration, describeAltitude(a)].filter(Boolean).join(' · '), closeSearch)));
        }
    }

    const matches = [];
    for (const sat of satellites.values()) {
        if (favourites.has(sat.id)) continue;
        const r = rank(sat);
        if (r >= 0) matches.push([r, sat]);
    }
    matches.sort(byRank);
    if (matches.length) {
        if (rows.some(row => row.classList.contains('search-heading'))) rows.push(el('div', 'search-heading search-heading-all', 'All satellites'));
        rows.push(...matches.slice(0, SEARCH_RESULTS).map(([, sat]) => searchRow(sat)));
        if (matches.length > SEARCH_RESULTS) rows.push(el('div', 'search-empty', `${matches.length - SEARCH_RESULTS} more; keep typing to narrow it down.`));
    }
    if (!rows.length) rows.push(el('div', 'search-empty', 'No matches among the satellite groups shown. More can be turned on in Settings.'));
    return rows;
}

function searchRow(sat) {
    const row = el('button', 'search-result');
    const swatch = el('span', 'swatch');
    swatch.style.background = groupStyles[sat.group].css;
    row.append(swatch, el('span', '', (favourites.has(sat.id) ? '★ ' : '') + sat.name),
        el('span', 'search-sub', sat.name !== sat.officialName ? sat.officialName : sat.objectId ?? ''));
    row.addEventListener('click', () => {
        closeSearch();
        select(sat);
        // In sky view, the view points the way to it instead.
        if (!sky.open) flyToSatellite(sat);
    });
    return row;
}

// ---- Favourites ----

/** From MainActivity at start: the starred catalogue numbers. */
function setFavourites(ids) {
    favourites.clear();
    for (const id of ids) favourites.add(id);
    favouritesChanged();
}

function toggleFavourite(sat) {
    if (favourites.has(sat.id)) favourites.delete(sat.id); else favourites.add(sat.id);
    window.Android?.setFavourites(JSON.stringify([...favourites]));
    favouritesChanged();
    // Starred satellites' passes can be alerted.
    refreshPassAlerts();
}

function favouritesChanged() {
    // Labels are rebuilt with or without their star.
    for (const sat of labelled) {
        sat.label.remove();
        sat.label = null;
    }
    labelled.clear();
    refreshStar();
    map.triggerRepaint();
}

// ---- Legend ----

let legendOpen = false;
/** When the orbital data was last fetched or confirmed current (MainActivity), or 0 if unknown. */
let dataUpdatedAt = 0;
const legend = el('div', 'legend');
document.body.appendChild(legend);
legend.addEventListener('click', () => {
    legendOpen = !legendOpen;
    updateLegend();
});

function closeLegend() {
    legendOpen = false;
    updateLegend();
}

function updateLegend() {
    const groups = Object.values(groupStyles).filter(g => g.count > 0);
    legend.style.display = (groups.length || layers.aircraft) && !sheet.node ? '' : 'none';
    legend.replaceChildren();
    if (!legendOpen) {
        // Closed: just the colours, as a hint of what opening it shows.
        const dots = el('div', 'legend-dots');
        for (const g of groups) {
            const swatch = el('span', 'swatch');
            swatch.style.background = g.css;
            dots.append(swatch);
        }
        if (layers.aircraft) dots.append(el('span', 'legend-plane', '✈'));
        legend.append(dots);
        return;
    }
    for (const g of groups) {
        const row = el('div', 'legend-row');
        const swatch = el('span', 'swatch');
        swatch.style.background = g.css;
        row.append(swatch, el('span', '', g.label), el('span', 'legend-count', g.count.toLocaleString()));
        legend.append(row);
    }
    if (layers.aircraft) legend.append(...aircraftLegend());
    if (layers.favouritesOnly) legend.append(el('div', 'legend-note', 'Only starred satellites are shown (Settings).'));
    if (groups.some(g => g.lowOrbit)) legend.append(el('div', 'legend-note', 'Low-orbit groups hide when zoomed far out.'));
    if (dataUpdatedAt) {
        const stale = Date.now() - dataUpdatedAt > STALE_DATA_MS;
        legend.append(el('div', 'legend-note' + (stale ? ' warning' : ''),
            `Orbital data from ${describeAge(dataUpdatedAt)}${stale ? ': offline? Positions drift as it ages.' : ''}`));
    }
}

/** The legend's aircraft part: how many, from where, and the altitude colours. */
function aircraftLegend() {
    const status = !aircraftLive() ? 'Aircraft are live only: hidden while time travelling.'
        : air.error === 'offline' ? 'Aircraft: none in offline mode.'
        : air.error === 'unavailable' ? 'Aircraft: no answer from the ADS-B networks; trying again.'
        : !air.centre ? 'Aircraft: waiting for the first update…'
        : `${aircraft.size.toLocaleString()} within ${air.radiusNm} NM, from ${air.source === 'receiver' ? 'your receiver' : air.source}`;
    const nodes = [el('div', 'legend-row legend-heading', '✈ Aircraft by altitude')];
    for (const band of AIRCRAFT_BANDS) {
        const row = el('div', 'legend-row');
        const swatch = el('span', 'swatch');
        swatch.style.background = band.css;
        row.append(swatch, el('span', '', band.label));
        nodes.push(row);
    }
    nodes.push(el('div', 'legend-note' + (air.error && air.error !== 'waiting' ? ' warning' : ''), status));
    return nodes;
}

function setDataAge(at) {
    dataUpdatedAt = at;
    updateLegend();
    // Closed, the legend only shows colours: a stale warning still shows as a mark on it.
    legend.classList.toggle('stale', !!at && Date.now() - at > STALE_DATA_MS);
}
satelliteListeners.push(updateLegend);

// ---- Back button ----

/** Whether any panel is open, as last told to MainActivity. */
let overlayOpen = false;

function overlaysChanged() {
    const open = !!(sheet.node || searchNode || inView.node || calibration.node || sky.open || dish.open || events.node || timeBar.node);
    if (sheet.node) legend.style.display = 'none'; else updateLegend();
    if (open === overlayOpen) return;
    overlayOpen = open;
    window.Android?.setOverlayOpen(open);
}

/**
 * Closes the topmost panel: compass calibration, search, in view, the dish aligner, events, sky view, the time bar, the open
 * legend, then the passes list, then the selection.
 */
function back() {
    if (calibration.node) closeCalibration();
    else if (searchNode) closeSearch();
    else if (inView.node) closeInView();
    else if (dish.open) closeDish();
    else if (events.node) closeEvents();
    else if (sky.open) closeSkyView();
    else if (timeBar.node) closeTimeBar();
    else if (legendOpen) closeLegend();
    else if (sheet.outagesOpen) toggleOutages(sheet.sat);
    else if (sheet.passesOpen) togglePasses(sheet.sat);
    else if (selected) select(null);
    else if (selectedAircraft) selectAircraft(null);
    else if (selectedBody) selectBody(null);
}

// ---- Closing by tapping elsewhere, or the button again ----
//
// The same everywhere: a panel's own button closes it again; a tap anywhere outside it closes it
// (a tap on the globe or the sky doing nothing else, so it doesn't select what was under it); the
// back button closes the topmost (back()). Selecting what is already selected closes its sheet.
// Sky view and the dish aligner fill the screen, so they close by their button, × or back.

/** The panels a tap anywhere else closes, as [name, node, close]. */
function dismissablePanels() {
    return [
        ['calibration', calibration.node, closeCalibration], ['search', searchNode, closeSearch],
        ['inView', inView.node, closeInView], ['events', events.node, closeEvents],
        ['time', timeBar.node, closeTimeBar], ['legend', legendOpen ? legend : null, closeLegend],
    ].filter(([, node]) => node);
}

/** Closes the panels a tap elsewhere would, all but `except` (a name from dismissablePanels). */
function closePanels(except) {
    for (const [name, , close] of dismissablePanels()) if (name !== except) close();
}

/**
 * A tap outside the open panels closes them. On the globe or the sky that is all it does; on other
 * controls it goes on to them too, except on the button that opened a panel just closed (marked
 * data-opens="<name>"), which would only open it again. Caught on its way down (capture), before
 * MapLibre, sky view or the button see it.
 */
document.addEventListener('click', e => {
    const open = dismissablePanels();
    if (!open.length || open.some(([, node]) => node.contains(e.target))) return;
    for (const [, , close] of open) close();
    const opener = e.target.closest?.('[data-opens]')?.dataset.opens;
    if (e.target === sky.canvas || e.target.closest?.('.maplibregl-canvas-container') || open.some(([name]) => name === opener)) {
        e.stopPropagation();
    }
}, true);

/** For MainActivity's buttons: each opens its panel, closing the others as a tap elsewhere would, or closes it if open. */
function toggleSearch() {
    if (searchNode) closeSearch();
    else {
        closePanels('search');
        openSearch();
    }
}

function toggleInView() {
    if (inView.node) closeInView();
    else {
        closePanels('inView');
        openInView();
    }
}

function toggleEvents() {
    if (events.node) closeEvents();
    else {
        closePanels('events');
        openEvents();
    }
}

window.globe.openSearch = openSearch;
window.globe.toggleSearch = toggleSearch;
window.globe.toggleInView = toggleInView;
window.globe.toggleEvents = toggleEvents;
window.globe.closePanels = closePanels;
window.globe.back = back;
window.globe.setFavourites = setFavourites;
window.globe.setDataAge = setDataAge;
