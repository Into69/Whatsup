'use strict';

// The page's own panels:
//   - the info sheet for the selected satellite: names, catalogue details, orbit, live position,
//     pointing, the next pass and close approach, a star to keep it as a favourite, and Follow,
//     Passes and Align dish buttons
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
    /** { sat, at (clock time), result (predictPasses with one pass) } for the next-pass line. */
    nextPass: null,
};

function updateSheet() {
    if (selected !== sheet.sat) {
        sheet.node?.remove();
        sheet.node = null;
        sheet.sat = selected;
        sheet.passesOpen = false;
        if (selected) buildSheet(selected);
        overlaysChanged();
    }
    if (!sheet.node) return;
    sheet.node.querySelector('.follow').classList.toggle('on', following);
    refreshSheetLive();
}

function buildSheet(sat) {
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
    const align = el('button', '', 'Align dish');
    align.addEventListener('click', () => openDish(sat));
    buttons.append(follow, passes, align);

    const approach = el('button', 'sheet-line sheet-approach');
    approach.addEventListener('click', () => {
        const row = nextApproach(sat);
        if (row) showApproach(row);
    });
    node.append(header, group, details, el('div', 'sheet-line sheet-orbit', describeOrbit(sat.satrec)),
        el('div', 'sheet-line sheet-live'), el('div', 'sheet-line sheet-pointing'), el('div', 'sheet-line sheet-next'),
        approach, buttons, el('div', 'sheet-passes'));
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
    if (!sheet.node || !sat?.now) return;
    const p = toGlobe(sat.now.lat, sat.now.lon, sat.now.altKm);
    sheet.node.querySelector('.sheet-live').textContent = [
        `${Math.round(sat.now.altKm).toLocaleString()} km up`,
        `${Math.round(sat.now.speedKmS * 3600).toLocaleString()} km/h`,
        `${Math.abs(sat.now.lat).toFixed(1)}°${sat.now.lat >= 0 ? 'N' : 'S'} ${Math.abs(sat.now.lon).toFixed(1)}°${sat.now.lon >= 0 ? 'E' : 'W'}`,
        inShadow(p, sun) ? "In Earth's shadow" : 'In sunlight',
    ].join(' · ');
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
            `up to ${Math.round(p.peakEl)}°, sets ${time(p.set)} in the ${compass(p.setAz)}${p.visible ? ' · ★ visible' : ''}`;
    }
    const peak = now < p.peak.getTime() ? `peaks at ${Math.round(p.peakEl)}° in ${describeDuration(p.peak - now)}` : 'past its highest';
    return `Passing now: ${peak}, sets in ${describeDuration(p.set - now)} in the ${compass(p.setAz)}`;
}
timeListeners.push(() => {
    sheet.nextPass = null;
    refreshSheetLive();
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
    ].join(' · ');
}
setInterval(refreshSheetLive, SHEET_REFRESH_MS);

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
            list.replaceChildren(...passRows(predictPasses(sat, here[1], here[0])));
        } catch (e) {
            console.error('Predicting passes failed', e);
            list.replaceChildren(el('div', 'sheet-line', "Couldn't work out passes for this satellite."));
        }
    }, 30);
}

function passRows(passes) {
    if (!Array.isArray(passes)) {
        const { az, el: elevation } = passes.alwaysUp;
        return [el('div', 'sheet-line', `Always above your horizon: ${Math.round(elevation)}° up in the ${compass(az)}.`)];
    }
    if (!passes.length) return [el('div', 'sheet-line', `No passes over ${MIN_PASS_ELEVATION}° in the next ${PASS_DAYS} days.`)];
    const day = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return [
        el('div', 'sheet-line sheet-hint', `Next ${PASS_DAYS} days over ${MIN_PASS_ELEVATION}°. ★ visible to the eye: sunlit, in a dark sky.`),
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

function searchRows(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return favouriteRows();
    const matches = [];
    for (const sat of satellites.values()) {
        const name = sat.name.toLowerCase(), official = sat.officialName.toLowerCase();
        // Names starting with the query rank first, then names containing it, then numbers.
        const rank = name.startsWith(q) || official.startsWith(q) ? 0
            : name.includes(q) || official.includes(q) ? 1
            : String(sat.id) === q || sat.objectId?.toLowerCase().startsWith(q) ? 2
            : -1;
        if (rank >= 0) matches.push([rank, sat]);
    }
    matches.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
    const rows = matches.slice(0, SEARCH_RESULTS).map(([, sat]) => searchRow(sat));
    if (!rows.length) rows.push(el('div', 'search-empty', 'No matches among the satellite groups shown. More can be turned on in Settings.'));
    else if (matches.length > SEARCH_RESULTS) rows.push(el('div', 'search-empty', `${matches.length - SEARCH_RESULTS} more; keep typing to narrow it down.`));
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

/** With nothing typed yet: the starred satellites, if any. */
function favouriteRows() {
    if (!favourites.size) return [el('div', 'search-empty', 'Tip: star a satellite (☆ in its info) to keep it labelled and listed here.')];
    const sats = [...favourites].map(id => satellites.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const hidden = favourites.size - sats.length;
    return [
        el('div', 'search-heading', '★ Starred'),
        ...sats.map(searchRow),
        ...(hidden ? [el('div', 'search-empty', `${hidden} more starred in satellite groups that are turned off.`)] : []),
    ];
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

function updateLegend() {
    const groups = Object.values(groupStyles).filter(g => g.count > 0);
    legend.style.display = groups.length && !sheet.node ? '' : 'none';
    legend.replaceChildren();
    if (!legendOpen) {
        // Closed: just the colours, as a hint of what opening it shows.
        const dots = el('div', 'legend-dots');
        for (const g of groups) {
            const swatch = el('span', 'swatch');
            swatch.style.background = g.css;
            dots.append(swatch);
        }
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
    if (groups.some(g => g.lowOrbit)) legend.append(el('div', 'legend-note', 'Low-orbit groups hide when zoomed far out.'));
    if (dataUpdatedAt) {
        const stale = Date.now() - dataUpdatedAt > STALE_DATA_MS;
        legend.append(el('div', 'legend-note' + (stale ? ' warning' : ''),
            `Orbital data from ${describeAge(dataUpdatedAt)}${stale ? ': offline? Positions drift as it ages.' : ''}`));
    }
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
    const open = !!(sheet.node || searchNode || sky.open || dish.open || events.node || timeBar.node);
    if (sheet.node) legend.style.display = 'none'; else updateLegend();
    if (open === overlayOpen) return;
    overlayOpen = open;
    window.Android?.setOverlayOpen(open);
}

/**
 * Closes the topmost panel: search, the dish aligner, events, sky view, the time bar, then the
 * passes list, then the selection.
 */
function back() {
    if (searchNode) closeSearch();
    else if (dish.open) closeDish();
    else if (events.node) closeEvents();
    else if (sky.open) closeSkyView();
    else if (timeBar.node) closeTimeBar();
    else if (sheet.passesOpen) togglePasses(sheet.sat);
    else if (selected) select(null);
}

window.globe.openSearch = openSearch;
window.globe.back = back;
window.globe.setFavourites = setFavourites;
window.globe.setDataAge = setDataAge;
