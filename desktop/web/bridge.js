'use strict';

// Run by the desktop app (MainForm on Windows, MainWindow on Linux) in the globe page before the
// page's own scripts: window.Android, which the page calls as it would MainActivity's Bridge on a
// phone, posting each call to the app (Host.OnGlobeMessage) through the web view's channel: WebView2's
// on Windows, WebKitGTK's on Linux.
// desktop.js, loaded once the page is parsed, hears them too (whatsupHost.onAndroid) and handles
// those that are only the page's business on a computer: the map buttons, the back key, sky view's
// orientation (from the mouse here, not a sensor).
(() => {
    const channel = window.chrome?.webview ?? window.webkit.messageHandlers.whatsup;
    const post = (call, ...args) => channel.postMessage({ call, args });
    const listeners = [];
    const calls = [
        'setOverlayOpen', 'setMapButtonsHidden', 'setOrientationUpdates', 'setPassAlerts', 'setFavourites',
        'setCompassOffset', 'loadConjunctions', 'installUpdate',
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
