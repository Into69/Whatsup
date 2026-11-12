'use strict';

// A newer version of the app, offered at the top of the globe: the app (MainActivity on Android,
// Host on a computer) looks for one on GitHub and calls globe.showUpdate() with the words to show.
// Update calls Android.installUpdate(), and the app downloads it with the progress panel at the
// bottom; Later puts it away until the app next offers it (the next day's check).

const update = { node: null };

/** `offer` is { title, detail, update, later }, in the app's own words. */
function showUpdate(offer) {
    hideUpdate();
    const node = el('div', 'update-offer');
    const text = el('div', 'update-text');
    text.append(el('b', '', offer.title), el('div', 'update-detail', offer.detail));
    const buttons = el('div', 'update-buttons');
    const later = el('button', '', offer.later);
    later.addEventListener('click', hideUpdate);
    const install = el('button', 'on', offer.update);
    install.addEventListener('click', () => {
        hideUpdate();
        window.Android?.installUpdate();
    });
    buttons.append(later, install);
    node.append(text, buttons);
    document.body.appendChild(node);
    update.node = node;
}

function hideUpdate() {
    update.node?.remove();
    update.node = null;
}

window.globe.showUpdate = showUpdate;
window.globe.hideUpdate = hideUpdate;
