'use strict';

// The Windows app's part of the globe page, loaded by bridge.js. On a phone these are Android views
// over the WebView (MainActivity); nothing can be drawn over a WebView2, so here they are HTML:
//   - the column of map buttons at the top right, in the same order, with the same icons
//   - the downloads panel, and short messages (Android's toasts)
//   - red night mode, as a filter over the whole page
//   - the back key: Esc or the mouse's back button close the topmost panel (globe.back())
//   - sky view's orientation: there is no sensor to hold up, so the view is dragged round with the
//     mouse, zoomed with the wheel or turned with the arrow keys, and sent to the page as the
//     sensor's would be (globe.setOrientation)
// MainForm calls desktop.start() once the page has loaded, then the others as things change.

const desktop = (() => {
    let strings = {};
    /** Whether the page has a panel open for Esc to close (Android.setOverlayOpen). */
    let overlayOpen = false;

    const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    // ---- The map buttons ----

    /**
     * [string for its tooltip, icon, the panel it opens (data-opens, so a click on it while that
     * panel is open only closes it: see panels.js), what it does]. MainActivity's order.
     */
    const BUTTONS = [
        ['search', 'ic_search', 'search', () => globe.toggleSearch()],
        ['in_view', 'ic_in_view', 'inView', () => globe.toggleInView()],
        ['sky_view', 'ic_sky', null, () => { globe.closePanels(); globe.toggleSkyView(); }],
        ['time_travel', 'ic_time', 'time', () => { globe.closePanels('time'); globe.toggleTimeBar(); }],
        ['events', 'ic_event', 'events', () => globe.toggleEvents()],
        ['recentre', 'ic_my_location', null, () => whatsupHost.post('recentre')],
        ['night_vision_off', 'ic_night', null, () => whatsupHost.post('toggleNight')],
        ['settings', 'ic_settings', null, () => whatsupHost.post('openSettings')],
    ];

    const controls = make('div', 'desktop-controls');
    const toggle = make('button', 'desktop-button desktop-toggle');
    const column = make('div', 'desktop-buttons');
    const buttons = {};
    toggle.append(icon('ic_expand'));
    controls.append(toggle, column);
    for (const [name, iconName, opens, action] of BUTTONS) {
        const button = make('button', 'desktop-button');
        button.append(icon(iconName));
        if (opens) button.dataset.opens = opens;
        button.addEventListener('click', action);
        buttons[name] = button;
        column.append(button);
    }

    function icon(name) {
        const img = make('img');
        img.src = `/icons/${name}.svg`;
        img.alt = '';
        return img;
    }

    /** Folds the column away under its toggle, or out again; the chevron points the way it will go. */
    function showButtons(shown) {
        column.hidden = !shown;
        toggle.classList.toggle('open', shown);
        toggle.title = strings[shown ? 'hide_buttons' : 'show_buttons'] ?? '';
    }

    toggle.addEventListener('click', () => {
        const shown = column.hidden;
        showButtons(shown);
        whatsupHost.post('setButtonsHidden', !shown);
    });

    // ---- Downloads and messages ----

    const downloads = make('div', 'desktop-downloads');
    downloads.hidden = true;
    const downloadSummary = make('div', 'desktop-download-summary');
    const downloadRow = make('div', 'desktop-download-row');
    const downloadFile = make('span', 'desktop-download-file');
    const downloadStatus = make('span', 'desktop-download-status');
    const downloadBar = make('div', 'desktop-download-bar');
    const downloadFill = make('div');
    const downloadQueue = make('div', 'desktop-download-queue');
    downloadRow.append(downloadFile, downloadStatus);
    downloadBar.append(downloadFill);
    downloads.append(downloadSummary, downloadRow, downloadBar, downloadQueue);

    /** From MainForm.ShowDownloads: { summary, file, status, progress (0 to 1, or -1 not known), queue }, or null. */
    function showDownloads(state) {
        downloads.hidden = !state;
        if (!state) return;
        downloadSummary.textContent = state.summary;
        downloadFile.textContent = state.file;
        downloadStatus.textContent = state.status;
        downloadBar.classList.toggle('indeterminate', state.progress < 0);
        downloadFill.style.width = `${Math.max(0, state.progress) * 100}%`;
        downloadQueue.textContent = state.queue;
        downloadQueue.hidden = !state.queue;
    }

    const toastNode = make('div', 'desktop-toast');
    toastNode.hidden = true;
    let toastTimer = 0;

    function toast(text, ms = Math.max(3500, text.length * 60)) {
        toastNode.textContent = text;
        toastNode.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastNode.hidden = true; }, ms);
    }

    // ---- Red night mode ----

    /** Like Android's NightVision: the page in greys, then multiplied by red (desktop.css). */
    function setNight(on) {
        document.documentElement.classList.toggle('night', on);
        buttons.night_vision_off.title = strings[on ? 'night_vision_on' : 'night_vision_off'] ?? '';
    }

    // ---- The back key ----

    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && overlayOpen) {
            e.preventDefault();
            globe.back();
        } else if (e.key === 'F11') {
            e.preventDefault();
            whatsupHost.post('fullScreen');
        } else if (e.key === 'f' && e.ctrlKey && !e.altKey) {
            e.preventDefault();
            globe.closePanels('search');
            globe.toggleSearch();
        } else if (look.wanted) {
            lookKey(e);
        }
    });
    // The mouse's back button.
    window.addEventListener('mouseup', e => {
        if (e.button === 3 && overlayOpen) {
            e.preventDefault();
            globe.back();
        }
    });

    // ---- Sky view, pointed with the mouse ----

    /** Where sky view looks: azimuth and elevation in degrees, and its field of view. */
    const look = { az: 180, el: 30, fov: SKY_FOV_DEGREES, wanted: false };
    /** A drag in progress: where the pointer was, and how far it has gone. */
    let drag = null;
    /** A drag just ended: its click (which ends it) is not a click on the sky. */
    let swallowClick = false;
    let saveTimer = 0;

    function lookable(target) {
        return target instanceof HTMLCanvasElement && (target.id === 'sky' || target.classList.contains('dish-scope'));
    }

    /**
     * The device-to-world rotation a phone would report looking out of its back at the look's
     * azimuth and elevation, held level: x to the right, y up the screen, z out of it (behind the
     * view). Row-major, world east, north, up: as SensorManager's, remapped (MainActivity).
     */
    function sendLook() {
        const a = look.az * Math.PI / 180, h = look.el * Math.PI / 180;
        const forward = [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
        const right = [Math.cos(a), -Math.sin(a), 0];
        const z = forward.map(c => -c);
        const up = [z[1] * right[2] - z[2] * right[1], z[2] * right[0] - z[0] * right[2], z[0] * right[1] - z[1] * right[0]];
        globe.setOrientation([right[0], up[0], z[0], right[1], up[1], z[1], right[2], up[2], z[2]]);
        sky.fov = look.fov;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => whatsupHost.post('setSkyLook', [look.az, look.el, look.fov].map(n => n.toFixed(1)).join(',')), 500);
    }

    function turn(dAz, dEl) {
        look.az = ((look.az + dAz) % 360 + 360) % 360;
        look.el = Math.max(-45, Math.min(90, look.el + dEl));
        sendLook();
    }

    function zoom(factor) {
        look.fov = Math.max(10, Math.min(120, look.fov * factor));
        sendLook();
    }

    /** Degrees the view turns for a pixel dragged: the sky follows the pointer. */
    function degreesPerPixel(canvas) {
        return look.fov / Math.min(canvas.clientWidth, canvas.clientHeight);
    }

    // On the window, while capturing: ahead of panels.js's click listener on the document and the canvas's own.
    window.addEventListener('pointerdown', e => {
        if (!look.wanted || e.button !== 0 || !lookable(e.target)) return;
        drag = { x: e.clientX, y: e.clientY, moved: 0, target: e.target };
        e.target.setPointerCapture(e.pointerId);
    }, true);
    window.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        const scale = degreesPerPixel(drag.target);
        turn(-dx * scale, dy * scale);
    }, true);
    const endDrag = () => {
        if (drag?.moved > 4) swallowClick = true;
        drag = null;
    };
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
    window.addEventListener('click', e => {
        if (!swallowClick) return;
        swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
    }, true);
    window.addEventListener('wheel', e => {
        if (!look.wanted || !lookable(e.target)) return;
        e.preventDefault();
        zoom(Math.exp(e.deltaY * 0.001));
    }, { passive: false });

    function lookKey(e) {
        if (e.target.closest?.('input, textarea, select') || e.ctrlKey || e.altKey || e.metaKey) return;
        const step = e.shiftKey ? 1 : 5;
        const keys = {
            ArrowLeft: () => turn(-step, 0), ArrowRight: () => turn(step, 0),
            ArrowUp: () => turn(0, step), ArrowDown: () => turn(0, -step),
            '+': () => zoom(1 / 1.2), '=': () => zoom(1 / 1.2), '-': () => zoom(1.2),
        };
        if (!keys[e.key]) return;
        e.preventDefault();
        keys[e.key]();
    }

    /** Sky view (or the dish aligner) has opened or closed (Android.setOrientationUpdates). */
    function orientationWanted(on) {
        look.wanted = on;
        if (!on) return;
        // Straight away, as the page has just forgotten the last orientation.
        sendLook();
        if (sky.open) toast(LOOK_HINT, 5000);
    }

    const LOOK_HINT = 'Drag the sky to look around · scroll to zoom · arrow keys to turn';

    whatsupHost.onAndroid((call, args) => {
        if (call === 'setOverlayOpen') overlayOpen = args[0];
        else if (call === 'setMapButtonsHidden') controls.hidden = args[0];
        else if (call === 'setOrientationUpdates') orientationWanted(args[0]);
    });

    document.body.append(controls, downloads, toastNode);

    /** From MainForm once the page has loaded: { buttonsHidden, skyLook: "az,el,fov" or "" }. */
    async function start(state) {
        const [az, el, fov] = state.skyLook.split(',').map(Number);
        if (Number.isFinite(az) && Number.isFinite(el)) Object.assign(look, { az, el });
        if (fov >= 10 && fov <= 120) look.fov = fov;
        try {
            strings = await (await fetch('/strings.json')).json();
        } catch (e) {
            console.warn('No strings', e);
        }
        for (const [name] of BUTTONS) buttons[name].title = strings[name]?.split('\n')[0] ?? '';
        showButtons(!state.buttonsHidden);
        setNight(document.documentElement.classList.contains('night'));
    }

    return { start, showDownloads, toast, setNight };
})();
