'use strict';

// Events, in a panel opened by MainActivity's rocket button (globe.openEvents):
//   - upcoming launches, from Launch Library (MainActivity serves /data/launches.json, saved for an
//     hour); with layers.launches each launch pad gets a marker on the globe
//   - close approaches between objects in orbit, from CelesTrak's SOCRATES. That list is a 22 MB
//     download, so it is only fetched when the user asks (Android.loadConjunctions, which answers
//     through globe.conjunctionsLoaded). Picking one sets the clock to the moment of closest
//     approach and shows both objects.

const LAUNCH_REFRESH_MS = 60 * 60 * 1000;
/** Launch pads get a marker for launches within this many days, labelled within LAUNCH_LABEL_DAYS. */
const LAUNCH_MARKER_DAYS = 14, LAUNCH_LABEL_DAYS = 3;
const MAX_LAUNCH_ROWS = 30;
const MAX_APPROACH_ROWS = 60;
/** Approaches to show in a satellite's info: those within a week, closest first. */
const APPROACH_SHOWN_RANGE_KM = 5;

const events = {
    node: null,
    tab: 'launches',
    /** { updatedAt, launches: [...] } from MainActivity, or null before the first answer. */
    launches: null,
    launchesAt: 0,
    launchesFailed: false,
    /** { updatedAt, rows: [[id1, name1, id2, name2, tca, rangeKm, speedKmS, probability]] } or null. */
    conjunctions: null,
    /** 'none' (not asked for), 'loading', 'ready' or 'failed'. */
    conjunctionState: 'none',
    onlyShown: true,
};

function openEvents(tab) {
    if (tab) events.tab = tab;
    if (events.node) {
        renderEvents();
        return;
    }
    events.node = el('div', 'events');
    document.body.appendChild(events.node);
    if (Date.now() - events.launchesAt > LAUNCH_REFRESH_MS) loadLaunches();
    renderEvents();
    overlaysChanged();
}

function closeEvents() {
    events.node?.remove();
    events.node = null;
    overlaysChanged();
}

function renderEvents() {
    const node = events.node;
    if (!node) return;
    const header = el('div', 'sheet-header');
    const tabs = el('div', 'segmented');
    for (const [tab, label] of [['launches', 'Launches'], ['approaches', 'Close approaches']]) {
        const button = el('button', tab === events.tab ? 'on' : '', label);
        button.addEventListener('click', () => {
            events.tab = tab;
            renderEvents();
        });
        tabs.append(button);
    }
    const close = el('button', 'sheet-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeEvents);
    header.append(tabs, close);
    const body = el('div', 'events-body');
    body.append(...(events.tab === 'launches' ? launchRows() : approachRows()));
    node.replaceChildren(header, body);
}

// ---- Launches ----

function loadLaunches() {
    events.launchesAt = Date.now();
    fetch('/data/launches.json')
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then(data => {
            events.launches = data;
            events.launchesFailed = false;
            placeLaunchMarkers();
            renderEvents();
        })
        .catch(e => {
            console.error('Loading launches failed', e);
            events.launchesFailed = true;
            renderEvents();
        });
}

/** "T−2 d 4 h", "T−3 h 12 min", "T−12 min", or "T+5 min" once launched. */
function countdown(at) {
    const ms = at - Date.now();
    const sign = ms >= 0 ? 'T−' : 'T+';
    return sign + describeDuration(Math.abs(ms));
}

/** "2 d 4 h", "3 h 12 min", "12 min" or "40 s". */
function describeDuration(ms) {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return `${Math.floor(ms / 1000)} s`;
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function dayTime(ms) {
    const date = new Date(ms);
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' +
        date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function launchRows() {
    if (!events.launches) {
        return [el('div', 'search-empty', events.launchesFailed ? "Couldn't load launches. Check the connection and try again." : 'Loading launches…')];
    }
    const launches = events.launches.launches.filter(l => l.net > Date.now() - 6 * 60 * 60 * 1000).slice(0, MAX_LAUNCH_ROWS);
    if (!launches.length) return [el('div', 'search-empty', 'No upcoming launches listed.')];
    const rows = launches.map(launch => {
        const row = el('button', 'event-row');
        const when = el('span', 'event-when');
        when.dataset.net = launch.net;
        when.dataset.status = launch.status ? ` · ${launch.status}` : '';
        when.textContent = launchWhen(when);
        row.append(
            el('b', '', launch.name),
            when,
            el('span', 'event-sub', [launch.provider, launch.orbit && `to ${launch.orbit}`, launch.pad, launch.location].filter(Boolean).join(' · ')),
        );
        if (launch.mission) row.append(el('span', 'event-sub', launch.mission.length > 180 ? launch.mission.slice(0, 177) + '…' : launch.mission));
        row.addEventListener('click', () => {
            closeEvents();
            if (Number.isFinite(launch.lat)) map.flyTo({ center: [launch.lon, launch.lat], zoom: 5, duration: 2000 });
        });
        return row;
    });
    rows.push(el('div', 'legend-note', `From Launch Library 2 (The Space Devs), ${describeAge(events.launches.updatedAt)}. Times can slip.`));
    return rows;
}

/** A launch row's time line, from the launch time kept on its node. */
function launchWhen(node) {
    const net = Number(node.dataset.net);
    return `${dayTime(net)} · ${countdown(net)}${node.dataset.status}`;
}

/** One marker per launch pad with a launch coming, showing the next. */
const launchMarkers = [];

function placeLaunchMarkers() {
    for (const marker of launchMarkers) marker.remove();
    launchMarkers.length = 0;
    if (!layers.launches || !events.launches) return;
    const byPad = new Map();
    for (const launch of events.launches.launches) {
        if (!Number.isFinite(launch.lat) || launch.net < Date.now() - 60 * 60 * 1000) continue;
        const key = `${launch.lat.toFixed(3)},${launch.lon.toFixed(3)}`;
        if (!byPad.has(key) || launch.net < byPad.get(key).net) byPad.set(key, launch);
    }
    for (const launch of byPad.values()) {
        if (launch.net > Date.now() + LAUNCH_MARKER_DAYS * 86_400_000) continue;
        // Named only when soon, so the globe isn't buried in labels for launches weeks off.
        const soon = launch.net < Date.now() + LAUNCH_LABEL_DAYS * 86_400_000;
        const node = el('div', 'launch-marker' + (soon ? '' : ' later'));
        node.append(el('span', 'launch-icon', '🚀'), el('span', 'launch-text'));
        // The rocket, without the mission after "|".
        node.dataset.name = launch.name.split('|')[0].trim();
        node.dataset.net = launch.net;
        node.querySelector('.launch-text').textContent = `${node.dataset.name} ${countdown(launch.net)}`;
        node.addEventListener('click', e => {
            e.stopPropagation();
            openEvents('launches');
        });
        launchMarkers.push(new maplibregl.Marker({ element: node }).setLngLat([launch.lon, launch.lat]).addTo(map));
    }
}

// Countdowns on the markers and in the open list, once a second.
setInterval(() => {
    for (const marker of launchMarkers) {
        const node = marker.getElement();
        node.querySelector('.launch-text').textContent = `${node.dataset.name} ${countdown(Number(node.dataset.net))}`;
    }
    if (events.node && events.tab === 'launches') {
        events.node.querySelectorAll('.event-when').forEach(when => { when.textContent = launchWhen(when); });
    }
    if (Date.now() - events.launchesAt > LAUNCH_REFRESH_MS && layers.launches) loadLaunches();
}, 1000);

layerListeners.push(() => {
    if (layers.launches && !events.launchesAt) loadLaunches(); else placeLaunchMarkers();
});

// ---- Close approaches ----

function loadConjunctions() {
    events.conjunctionState = 'loading';
    renderEvents();
    window.Android?.loadConjunctions();
}

/** From MainActivity, once the download (or the saved copy) has been read. */
function conjunctionsLoaded(ok) {
    if (!ok) {
        events.conjunctionState = 'failed';
        renderEvents();
        return;
    }
    fetch('/data/conjunctions.json')
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then(data => {
            events.conjunctions = data;
            events.conjunctionState = 'ready';
            renderEvents();
            notifySatelliteListeners();
        })
        .catch(e => {
            console.error('Reading close approaches failed', e);
            events.conjunctionState = 'failed';
            renderEvents();
        });
}

/** "16 m" or "1.2 km". */
function describeRange(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function approachRows() {
    const intro = 'Close approaches predicted by CelesTrak\'s SOCRATES for the next week, closest first.';
    if (events.conjunctionState === 'none' || events.conjunctionState === 'failed') {
        const button = el('button', 'event-action', events.conjunctionState === 'failed' ? 'Try again' : 'Download (about 22 MB)');
        button.addEventListener('click', loadConjunctions);
        return [
            el('div', 'search-empty', intro + ' The list is a 22 MB download, refreshed at most twice a day, so it is only fetched when you ask.'),
            ...(events.conjunctionState === 'failed' ? [el('div', 'search-empty warning', "Couldn't download the close approaches.")] : []),
            button,
        ];
    }
    if (events.conjunctionState === 'loading') return [el('div', 'search-empty', 'Downloading and sorting… Progress shows at the top of the screen.')];

    const filter = el('label', 'event-filter');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = events.onlyShown;
    box.addEventListener('change', () => {
        events.onlyShown = box.checked;
        renderEvents();
    });
    filter.append(box, document.createTextNode(' Only satellites in the groups shown'));
    const now = Date.now();
    const rows = events.conjunctions.rows
        .filter(([id1, , id2, , tca]) => tca > now - 60 * 60 * 1000 &&
            (!events.onlyShown || satellites.has(id1) || satellites.has(id2)))
        .slice(0, MAX_APPROACH_ROWS)
        .map(approachRow);
    if (!rows.length) rows.push(el('div', 'search-empty', 'None among the satellites shown. Untick the box to see all.'));
    return [filter, ...rows,
        el('div', 'legend-note', `From CelesTrak SOCRATES, ${describeAge(events.conjunctions.updatedAt)}. Tap one to go to that moment.`)];
}

function approachRow(row) {
    const [id1, name1, id2, name2, tca, rangeKm, speedKmS, probability] = row;
    const button = el('button', 'event-row');
    const star = id => favourites.has(id) ? '★ ' : '';
    button.append(
        el('b', '', `${star(id1)}${satellites.get(id1)?.name ?? name1} × ${star(id2)}${satellites.get(id2)?.name ?? name2}`),
        el('span', 'event-when', `${describeRange(rangeKm)} apart at ${speedKmS.toFixed(1)} km/s · ${dayTime(tca)} (${tca > Date.now() ? 'in ' + describeDuration(tca - Date.now()) : 'just past'})`),
    );
    if (probability >= 1e-6) {
        button.append(el('span', 'event-sub', `Collision chance up to 1 in ${Math.round(1 / probability).toLocaleString()}`));
    }
    button.addEventListener('click', () => showApproach(row));
    return button;
}

/**
 * Goes to a close approach: the clock to its moment, the camera to where it happens, and both
 * objects selected (the second as the selection's partner), if their groups are shown.
 */
function showApproach([id1, name1, id2, name2, tca]) {
    const a = satellites.get(id1), b = satellites.get(id2);
    if (!a && !b) {
        alertInEvents(`Neither ${name1} nor ${name2} is in the satellite groups shown. Turn on their group (Debris, perhaps) in Settings.`);
        return;
    }
    closeEvents();
    setTimeOffset(tca - Date.now());
    showTimeBar();
    select(a ?? b);
    partner = a && b ? b : null;
    tick();
    notifySatelliteListeners();
    const sat = a ?? b;
    if (sat.now) map.flyTo({ center: [sat.now.lon, sat.now.lat], zoom: Math.max(map.getZoom(), 3), duration: 2000 });
}

function alertInEvents(message) {
    const body = events.node?.querySelector('.events-body');
    if (!body) return;
    body.querySelector('.events-alert')?.remove();
    body.prepend(el('div', 'search-empty warning events-alert', message));
    body.scrollTop = 0;
}

/** The selected satellite's next close approach within APPROACH_SHOWN_RANGE_KM, if the list is loaded. */
function nextApproach(sat) {
    if (!events.conjunctions) return null;
    const now = simNow() - 60 * 60 * 1000;
    let best = null;
    for (const row of events.conjunctions.rows) {
        const [id1, , id2, , tca, rangeKm] = row;
        if ((id1 !== sat.id && id2 !== sat.id) || tca < now || rangeKm > APPROACH_SHOWN_RANGE_KM) continue;
        if (!best || tca < best[4]) best = row;
    }
    return best;
}

/** "3 h ago", for when a list was fetched. */
function describeAge(at) {
    if (!at) return 'when last fetched';
    const ms = Date.now() - at;
    return ms < 60_000 ? 'just now' : `${describeDuration(ms)} ago`;
}

// The launch list, once the page is up, if launches are shown.
loaded.then(() => {
    if (layers.launches && !events.launchesAt) loadLaunches();
});

window.globe.openEvents = () => openEvents();
window.globe.conjunctionsLoaded = conjunctionsLoaded;
