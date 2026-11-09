'use strict';

// The settings page, built as SettingsActivity builds the Android one: location (Windows', or one
// set by hand), offline mode, map style (a grid of previews), satellites (a card per category,
// folding open to its groups), display layers, aircraft, alerts, and about. What to show comes from
// /data/settings.json (MainForm, SettingsPage.State); each change goes back at once (SettingsPage.Set).

const post = message => window.chrome.webview.postMessage(message);
const set = (key, value) => post({ call: 'set', key, value });
const content = document.getElementById('content');
let strings = {};

const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

/** The strings for switches are "Title\nDescription". */
const splitTitle = text => [text.split('\n')[0], text.split('\n').slice(1).join('\n')];

function maskIcon(name, className) {
    const icon = make('span', `icon ${className ?? ''}`);
    icon.style.maskImage = icon.style.webkitMaskImage = `url(/icons/${name}.svg)`;
    return icon;
}

function addSection(iconName, titleKey) {
    const header = make('div', 'section');
    header.append(maskIcon(iconName), make('span', '', strings[titleKey]));
    content.append(header);
}

function addCard(parent = content) {
    const card = make('div', 'card');
    parent.append(card);
    return card;
}

function addDivider(parent) {
    parent.append(make('div', 'divider'));
}

/** A row with title, description and switch; clicking anywhere on it flips the switch. */
function addSwitchRow(parent, title, description, checked, onChange, color) {
    const row = make('label', 'row');
    if (color) {
        const dot = make('span', 'dot');
        dot.style.background = color;
        row.append(dot);
    }
    const text = make('div', 'row-text');
    text.append(make('div', 'row-title', title));
    const subtitle = make('div', 'row-subtitle', description);
    if (description) text.append(subtitle);
    const toggle = make('span', 'switch');
    const input = make('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', title);
    input.addEventListener('change', () => onChange(input.checked));
    toggle.append(input, make('span'));
    row.append(text, toggle);
    parent.append(row);
    return { input, subtitle };
}

// ---- Sections ----

/** Windows' location, or one set by hand: typed as an address, latitude and longitude, or MGRS. */
function addLocation(state) {
    addSection('ic_my_location', 'section_location');
    const card = addCard();
    const result = make('div', 'note', state.location.place ?? '');
    const manual = addSwitchRow(card, strings.manual_location, state.location.source, state.location.useManual,
        on => set('useManualLocation', on));
    addDivider(card);
    const field = make('div', 'field');
    const input = make('input');
    input.type = 'text';
    input.placeholder = strings.manual_location_hint;
    input.spellcheck = false;
    const find = make('button', '', strings.manual_location_find);
    field.append(input, find);
    card.append(field, result);

    const search = () => {
        const text = input.value.trim();
        if (!text) return;
        result.textContent = strings.manual_location_looking;
        post({ call: 'findPlace', text });
    };
    find.addEventListener('click', search);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') search();
    });

    settingsPage.placeFound = answer => {
        result.textContent = answer.message;
        if (!answer.found) return;
        manual.input.checked = true;
        manual.subtitle.textContent = answer.source;
    };
    settingsPage.manualRefused = message => {
        manual.input.checked = false;
        result.textContent = message;
    };
    settingsPage.locationSource = text => {
        manual.subtitle.textContent = text;
    };
}

function addOffline(state) {
    addSection('ic_globe', 'section_data');
    const [title, description] = splitTitle(strings.offline_mode);
    addSwitchRow(addCard(), title, description, state.offlineMode, on => set('offlineMode', on));
}

function addMapStyles(state) {
    addSection('ic_map', 'section_map');
    const grid = make('div', 'tiles');
    const choices = [];
    for (const tileSet of state.tileSets) {
        const choice = make('button', 'tile');
        choice.classList.toggle('selected', tileSet.id === state.tileSet);
        const preview = make('img');
        preview.alt = '';
        preview.src = `/data/tile-preview/${tileSet.id}`;
        // No preview offline (or blocked): an empty panel, as the Android card without its picture.
        preview.addEventListener('error', () => preview.replaceWith(make('div', 'preview')));
        choice.append(preview, make('b', '', tileSet.name), make('small', '', tileSet.description));
        choice.addEventListener('click', () => {
            set('tileSet', tileSet.id);
            for (const other of choices) other.classList.toggle('selected', other === choice);
        });
        choices.push(choice);
        grid.append(choice);
    }
    content.append(grid);
}

function addSatellites(state) {
    addSection('ic_globe', 'section_satellites');
    for (const category of state.categories) addCategory(category);
}

/** A category's header and, while it is open, a row per group. Opened at first if anything in it is on. */
function addCategory(category) {
    const card = addCard();
    const header = make('div', 'row');
    const dots = make('div', 'dots');
    for (const group of category.groups.slice(0, 5)) {
        const dot = make('span', 'dot');
        dot.style.background = group.color;
        dots.append(dot);
    }
    const text = make('div', 'row-text');
    const summary = make('div', 'row-subtitle');
    text.append(make('div', 'category-title', category.title), summary);
    const all = make('button', 'all', strings.all);
    all.title = (strings.category_toggle_description ?? '').replace('%1$s', category.title);
    header.append(dots, text);
    if (category.groups.length > 1) header.append(all);
    header.append(maskIcon('ic_expand', 'chevron'));
    card.append(header);

    const rows = make('div');
    card.append(rows);
    const switches = category.groups.map(group => {
        addDivider(rows);
        const [title, description] = splitTitle(group.title);
        return addSwitchRow(rows, title, description, group.shown, on => {
            group.shown = on;
            set(`group.${group.key}`, on);
            updateSummary();
        }, group.color).input;
    });

    function updateSummary() {
        const on = category.groups.filter(g => g.shown).length;
        summary.textContent = on === 0 ? strings.category_summary_none
            : on === category.groups.length ? strings.category_summary_all
            : strings.category_summary.replace('%1$d', on).replace('%2$d', category.groups.length);
    }

    // Everything on unless it already is; then everything off.
    all.addEventListener('click', e => {
        e.stopPropagation();
        const on = !category.groups.every(g => g.shown);
        switches.forEach((input, i) => {
            if (input.checked === on) return;
            input.checked = on;
            input.dispatchEvent(new Event('change'));
        });
    });

    let open = category.groups.some(g => g.shown);
    const showOpen = () => {
        rows.hidden = !open;
        card.classList.toggle('open', open);
    };
    header.addEventListener('click', () => {
        open = !open;
        showOpen();
    });
    showOpen();
    updateSummary();
}

function addDisplay(state) {
    addSection('ic_layers', 'section_display');
    const card = addCard();
    state.layers.forEach((layer, i) => {
        if (i > 0) addDivider(card);
        const [title, description] = splitTitle(layer.title);
        addSwitchRow(card, title, description, layer.shown, on => set(`layer.${layer.key}`, on));
    });
}

/** Live aircraft: on or off, how far around the location, and optionally the user's own receiver. */
function addAircraft(state) {
    addSection('ic_aircraft', 'section_aircraft');
    const card = addCard();
    const [title, description] = splitTitle(strings.aircraft_shown);
    addSwitchRow(card, title, description, state.aircraft.shown, on => set('aircraftShown', on));
    addDivider(card);

    const radius = make('div', 'label');
    const slider = make('input');
    slider.type = 'range';
    // In steps of 5 NM.
    slider.min = state.aircraft.minNm;
    slider.max = state.aircraft.maxNm;
    slider.step = 5;
    slider.value = state.aircraft.radiusNm;
    const show = nm => {
        radius.textContent = strings.aircraft_radius.replace('%1$d', nm).replace('%2$d', Math.round(nm * 1.852));
    };
    show(state.aircraft.radiusNm);
    slider.addEventListener('input', () => show(+slider.value));
    slider.addEventListener('change', () => set('aircraftRadiusNm', +slider.value));
    card.append(radius, slider, make('div', 'note', strings.aircraft_radius_note));
    addDivider(card);

    const field = make('div', 'field');
    const receiver = make('input');
    receiver.type = 'text';
    receiver.spellcheck = false;
    receiver.placeholder = strings.aircraft_receiver_hint;
    receiver.value = state.aircraft.receiver;
    receiver.addEventListener('input', () => set('aircraftReceiver', receiver.value));
    field.append(receiver);
    card.append(make('div', 'label', strings.aircraft_receiver), field, make('div', 'note', strings.aircraft_receiver_note));
}

function addAlerts(state) {
    addSection('ic_bell', 'section_alerts');
    const card = addCard();
    const message = make('div', 'note');
    const [title, description] = splitTitle(strings.pass_alerts);
    const iss = addSwitchRow(card, title, description, state.passAlerts, on => set('passAlerts', on));
    addDivider(card);
    const [favouriteTitle, favouriteDescription] = splitTitle(strings.favourite_alerts);
    const favourite = addSwitchRow(card, favouriteTitle, favouriteDescription, state.favouriteAlerts, on => set('favouriteAlerts', on));
    card.append(message);
    // Windows won't show the app's notifications: both go back off, and say why.
    settingsPage.alertsRefused = text => {
        iss.input.checked = favourite.input.checked = false;
        message.textContent = text;
    };
}

function addAbout(state) {
    addSection('ic_info', 'section_about');
    addCard().append(make('div', 'about',
        `${strings.about_version.replace('%1$s', `${state.version} for Windows`)}\n\n${strings.about_text}`));
}

// ---- The page ----

const settingsPage = {
    setNight(on) {
        document.documentElement.classList.toggle('night', on);
    },
};
window.settingsPage = settingsPage;

const close = () => post({ call: 'close' });
document.getElementById('back').addEventListener('click', close);
window.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
});
window.addEventListener('mouseup', e => {
    if (e.button === 3) close();
});

(async () => {
    const [state, loaded] = await Promise.all([
        fetch('/data/settings.json').then(r => r.json()),
        fetch('/strings.json').then(r => r.json()),
    ]);
    strings = loaded;
    document.getElementById('title').textContent = strings.settings;
    document.getElementById('back').title = `${strings.back} (Esc)`;
    settingsPage.setNight(state.nightVision);
    addLocation(state);
    addOffline(state);
    addMapStyles(state);
    addSatellites(state);
    addDisplay(state);
    addAircraft(state);
    addAlerts(state);
    addAbout(state);
})();
