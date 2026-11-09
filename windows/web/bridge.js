'use strict';

// Run by the Windows app (MainForm) in the globe page before the page's own scripts: window.Android,
// which the page calls as it would MainActivity's Bridge on a phone, posting each call to the app.
// desktop.js, loaded once the page is parsed, hears them too (whatsupHost.onAndroid) and handles
// those that are only the page's business on a computer: the map buttons, the back key, sky view's
// orientation (from the mouse here, not a sensor).
(() => {
    const post = (call, ...args) => window.chrome.webview.postMessage({ call, args });
    const listeners = [];
    const calls = [
        'setOverlayOpen', 'setMapButtonsHidden', 'setOrientationUpdates', 'setPassAlerts', 'setFavourites',
        'setCompassOffset', 'loadConjunctions',
    ];
    window.Android = Object.fromEntries(calls.map(call => [call, (...args) => {
        post(call, ...args);
        for (const listener of listeners) listener(call, args);
    }]));
    window.whatsupHost = { post, onAndroid: listener => listeners.push(listener) };

    document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('link');
        style.rel = 'stylesheet';
        style.href = '/desktop/desktop.css';
        const script = document.createElement('script');
        script.src = '/desktop/desktop.js';
        document.head.append(style, script);
    });
})();
