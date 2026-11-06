'use strict';

// In view: every satellite above the user's horizon on the globe's clock, so with a direct line of
// sight, whether or not it could be seen by eye. Opened by MainActivity's button (globe.openInView),
// highest first and kept up to date while open; tapping one selects it. With only starred
// satellites shown (layers.favouritesOnly), only those are listed.
//
// Az, El and range are exact, as in the selected satellite's sheet (pointingAt, WGS84).

const IN_VIEW_ROWS = 200;
const IN_VIEW_REFRESH_MS = 2000;
/**
 * sin(-10°): how far below the horizon a satellite's globe position may be and still be checked
 * exactly; that position is a few seconds old, which for a low orbit can be a few degrees.
 */
const IN_VIEW_MARGIN = -0.17;

const inView = { node: null, title: null, list: null, input: null, timer: 0 };

function openInView() {
    if (inView.node) return;
    // They open in the same place.
    closeSearch();
    if (events.node) closeEvents();
    inView.node = el('div', 'search');
    inView.title = el('div', 'search-heading in-view-title');
    const row = el('div', 'search-row');
    inView.input = el('input');
    inView.input.type = 'search';
    inView.input.placeholder = 'Filter: name, number or designator';
    inView.input.addEventListener('input', refreshInView);
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close in view');
    close.addEventListener('click', closeInView);
    row.append(inView.input, close);
    inView.list = el('div', 'search-results');
    inView.node.append(inView.title, row, inView.list);
    document.body.appendChild(inView.node);
    refreshInView();
    inView.timer = setInterval(refreshInView, IN_VIEW_REFRESH_MS);
    overlaysChanged();
}

function closeInView() {
    if (!inView.node) return;
    clearInterval(inView.timer);
    inView.node.remove();
    inView.node = null;
    overlaysChanged();
}

/**
 * Every drawn satellite above the horizon at (lat, lon): { sat, az, el, rangeKm }, highest first.
 * The globe's positions (spherical Earth, moved every few seconds) pick out those near or above the
 * horizon; each of those is then worked out exactly (pointingAt), so one just set isn't listed.
 */
function satellitesInView(lat, lon) {
    const date = new Date(simNow());
    const up = [];
    for (const sat of satellites.values()) {
        if (!sat.now || !isDrawn(sat)) continue;
        const [, , u] = skyDirection(toGlobe(sat.now.lat, sat.now.lon, sat.now.altKm), lat, lon);
        if (u < IN_VIEW_MARGIN) continue;
        const look = pointingAt(sat.satrec, lat, lon, date);
        if (look && look.el > 0) up.push({ sat, az: (look.az + 360) % 360, el: look.el, rangeKm: look.rangeKm });
    }
    return up.sort((a, b) => b.el - a.el);
}

function refreshInView() {
    if (!inView.node) return;
    if (!here) {
        inView.title.textContent = 'Waiting for your location';
        inView.list.replaceChildren();
        return;
    }
    const all = satellitesInView(here[1], here[0]);
    const q = inView.input.value.trim().toLowerCase();
    const shown = q
        ? all.filter(({ sat }) => sat.name.toLowerCase().includes(q) || sat.officialName.toLowerCase().includes(q)
            || String(sat.id).startsWith(q) || sat.objectId?.toLowerCase().startsWith(q))
        : all;
    const at = Math.abs(simNow() - Date.now()) > 60_000
        ? ` at ${new Date(simNow()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        : '';
    inView.title.textContent = `${all.length.toLocaleString()} in line of sight${at}`
        + (layers.favouritesOnly ? ' (starred only)' : '');
    const rows = shown.slice(0, IN_VIEW_ROWS).map(inViewRow);
    if (shown.length > IN_VIEW_ROWS) rows.push(el('div', 'search-empty', `${shown.length - IN_VIEW_ROWS} more, lower down; filter to find one.`));
    if (!shown.length) {
        rows.push(el('div', 'search-empty', q ? 'None in view match.'
            : 'Nothing above the horizon among the satellites shown. More groups can be turned on in Settings.'));
    }
    inView.list.replaceChildren(...rows);
}

function inViewRow({ sat, az, el: elevation, rangeKm }) {
    const row = el('button', 'search-result');
    const swatch = el('span', 'swatch');
    swatch.style.background = groupStyles[sat.group].css;
    row.append(swatch, el('span', '', (favourites.has(sat.id) ? '★ ' : '') + sat.name),
        el('span', 'search-sub in-view-look',
            `${compass(az)} ${Math.round(az)}° · El ${elevation.toFixed(1)}° · ${Math.round(rangeKm).toLocaleString()} km`));
    row.addEventListener('click', () => {
        closeInView();
        select(sat);
        // In sky view, the view points the way to it instead.
        if (!sky.open) flyToSatellite(sat);
    });
    return row;
}

window.globe.openInView = openInView;
