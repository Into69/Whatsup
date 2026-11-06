'use strict';

// The sky beyond the satellites (layers.stars): the stars of stars.js behind the globe, turning with
// the sidereal clock, and the Moon at its true distance (drawn by satellites.js's orbit layer; sky
// view draws both too).

/** How far out the stars are drawn from the camera, in Earth radii: in effect at infinity. */
const STAR_DISTANCE = 500;
/** Faintest star drawn on the globe. */
const GLOBE_STAR_MAGNITUDE = 5.5;

/** Inertial unit vector from right ascension and declination in degrees. */
function raDecToEci(ra, dec) {
    const a = ra * Math.PI / 180, d = dec * Math.PI / 180;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** An inertial vector turned to the globe's space at sidereal angle `gmst` (as sunDirection() does). */
function eciToGlobe([x, y, z], gmst) {
    const ex = x * Math.cos(gmst) + y * Math.sin(gmst);
    const ey = -x * Math.sin(gmst) + y * Math.cos(gmst);
    return [ey, z, ex];
}

/** A rough star colour from its B-V colour index: blue-white hot stars to orange cool ones. */
function starColor(bv) {
    const stops = [[-0.4, [0.62, 0.72, 1]], [0.4, [1, 1, 1]], [1.0, [1, 0.88, 0.68]], [1.8, [1, 0.7, 0.45]]];
    if (bv <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        const [b, color] = stops[i];
        if (bv <= b) {
            const [a, previous] = stops[i - 1];
            const t = (bv - a) / (b - a);
            return previous.map((c, k) => c + (color[k] - c) * t);
        }
    }
    return stops[stops.length - 1][1];
}

/** CSS pixels across a star of this magnitude, and how bright it is drawn. */
function starSize(mag) {
    return Math.max(1, 3.4 - 0.5 * mag);
}

function starAlpha(mag) {
    return Math.max(0.3, Math.min(1, 1.15 - 0.16 * mag));
}

// ---- The Moon ----

/**
 * The Moon's geocentric position in km (inertial, equator and equinox of date) and its ecliptic
 * longitude, from the main terms of Meeus' series (Astronomical Algorithms, ch. 47): good to about a
 * tenth of a degree, plenty for a dot and for calibrating a compass.
 */
function moonEci(date) {
    const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
    const rad = Math.PI / 180;
    const L = 218.3164477 + 13.17639648 * n;
    const D = (297.8501921 + 12.19074912 * n) * rad;
    const M = (357.5291092 + 0.98560028 * n) * rad;
    const Mm = (134.9633964 + 13.06499295 * n) * rad;
    const F = (93.2720950 + 13.22935024 * n) * rad;
    const sin = Math.sin, cos = Math.cos;
    const longitude = (L
        + 6.2888 * sin(Mm) + 1.2740 * sin(2 * D - Mm) + 0.6583 * sin(2 * D) + 0.2136 * sin(2 * Mm)
        - 0.1851 * sin(M) - 0.1143 * sin(2 * F) + 0.0588 * sin(2 * D - 2 * Mm) + 0.0572 * sin(2 * D - M - Mm)
        + 0.0533 * sin(2 * D + Mm) + 0.0458 * sin(2 * D - M) + 0.0409 * sin(Mm - M) - 0.0347 * sin(D)
        - 0.0304 * sin(M + Mm)) * rad;
    const latitude = (5.1282 * sin(F) + 0.2806 * sin(Mm + F) + 0.2777 * sin(Mm - F) + 0.1732 * sin(2 * D - F)
        + 0.0554 * sin(2 * D - Mm + F) + 0.0463 * sin(2 * D - Mm - F) + 0.0326 * sin(2 * D + Mm - F)) * rad;
    const distance = 385000.56 - 20905.355 * cos(Mm) - 3699.111 * cos(2 * D - Mm) - 2955.968 * cos(2 * D)
        - 569.925 * cos(2 * Mm) + 48.888 * cos(M);
    const obliquity = (23.439 - 0.0000004 * n) * rad;
    const x = cos(latitude) * cos(longitude);
    const y = cos(obliquity) * cos(latitude) * sin(longitude) - sin(obliquity) * sin(latitude);
    const z = sin(obliquity) * cos(latitude) * sin(longitude) + cos(obliquity) * sin(latitude);
    return { eci: [x * distance, y * distance, z * distance], longitude, distance };
}

/** The Sun's ecliptic longitude in radians (the same formula as sunEci()). */
function sunLongitude(date) {
    const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
    const rad = Math.PI / 180;
    const meanAnomaly = (357.528 + 0.9856003 * n) * rad;
    return (280.460 + 0.9856474 * n + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * rad;
}

/**
 * The Moon at `date`: { lat, lon, altKm } below it, its globe-space position, the lit fraction of its
 * disc (0 new to 1 full), whether it is waxing, and the phase's name.
 */
function moonAt(date) {
    const { eci, longitude, distance } = moonEci(date);
    const globe = eciToGlobe(eci, satellite.gstime(date)).map(c => c / EARTH_RADIUS_KM);
    const r = Math.hypot(...globe);
    // Elongation: how far round from the Sun it is, eastwards (0 new, 180° full).
    const elongation = ((longitude - sunLongitude(date)) * 180 / Math.PI % 360 + 360) % 360;
    const lit = (1 - Math.cos(elongation * Math.PI / 180)) / 2;
    const names = ['New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    return {
        lat: Math.asin(globe[1] / r) * 180 / Math.PI,
        lon: Math.atan2(globe[0], globe[2]) * 180 / Math.PI,
        altKm: distance - EARTH_RADIUS_KM,
        globe,
        lit,
        waxing: elongation < 180,
        phase: names[Math.round(elongation / 45) % 8],
    };
}

/** The Moon at simNow(), refreshed once a minute and when the clock moves. */
let moon = moonAt(new Date(simNow()));
function refreshMoon() {
    moon = moonAt(new Date(simNow()));
    orbitLayer.dirty = true;
}
setInterval(refreshMoon, 60_000);
timeListeners.push(refreshMoon);

// ---- Stars on the globe (custom WebGL layer) ----

const STAR_VERTEX_SHADER = `
    uniform mat4 u_matrix;
    uniform vec3 u_camera;
    uniform float u_gmst;
    uniform float u_pixel_ratio;
    attribute vec3 a_dir;
    attribute vec4 a_color;
    attribute float a_size;
    varying vec4 v_color;

    // As satellites.js's: the Earth (unit sphere) in the way from the camera to p.
    bool hidden(vec3 p) {
        vec3 d = p - u_camera;
        float a = dot(d, d);
        float b = 2.0 * dot(u_camera, d);
        float c = dot(u_camera, u_camera) - 1.0;
        float disc = b * b - 4.0 * a * c;
        if (disc <= 0.0) return false;
        float t = (-b - sqrt(disc)) / (2.0 * a);
        return t > 0.0 && t < 1.0;
    }

    void main() {
        // Inertial to Earth-fixed (turned back by the sidereal angle), then to globe space.
        float c = cos(u_gmst), s = sin(u_gmst);
        vec3 fixedDir = vec3(a_dir.x * c + a_dir.y * s, -a_dir.x * s + a_dir.y * c, a_dir.z);
        vec3 p = u_camera + vec3(fixedDir.y, fixedDir.z, fixedDir.x) * ${STAR_DISTANCE.toFixed(1)};
        gl_Position = u_matrix * vec4(p, 1.0);
        gl_Position.z = 0.0;
        gl_PointSize = a_size * u_pixel_ratio;
        v_color = a_color;
        if (gl_Position.w <= 0.0 || hidden(p)) {
            v_color.a = 0.0;
            gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
        }
    }`;

const STAR_FRAGMENT_SHADER = `
    precision mediump float;
    varying vec4 v_color;

    void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (v_color.a <= 0.0 || r > 1.0) discard;
        // A soft edge, so small stars twinkle less as the globe turns.
        float a = v_color.a * (1.0 - r * r);
        gl_FragColor = vec4(v_color.rgb * a, a);
    }`;

const starLayer = {
    id: 'stars',
    type: 'custom',
    renderingMode: '2d',

    onAdd(map, gl) {
        this.program = linkProgram(gl, STAR_VERTEX_SHADER, STAR_FRAGMENT_SHADER);
        const uniform = name => gl.getUniformLocation(this.program, name);
        this.u = { matrix: uniform('u_matrix'), camera: uniform('u_camera'), gmst: uniform('u_gmst'), pixelRatio: uniform('u_pixel_ratio') };
        this.a = { dir: gl.getAttribLocation(this.program, 'a_dir'), color: gl.getAttribLocation(this.program, 'a_color'), size: gl.getAttribLocation(this.program, 'a_size') };
        this.vao = gl.createVertexArray ? gl.createVertexArray() : null;
        const data = [];
        for (const [ra, dec, mag, bv] of STARS) {
            if (mag > GLOBE_STAR_MAGNITUDE) continue;
            data.push(...raDecToEci(ra, dec), ...starColor(bv), starAlpha(mag), starSize(mag));
        }
        this.count = data.length / 8;
        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    },

    render(gl, args) {
        const data = args.defaultProjectionData;
        if (!layers.stars || args.shaderData.variantName !== 'globe' || data.projectionTransition <= 0.999) return;
        const stride = 8 * 4;
        if (this.vao) gl.bindVertexArray(this.vao);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.a.dir);
        gl.vertexAttribPointer(this.a.dir, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this.a.color);
        gl.vertexAttribPointer(this.a.color, 4, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(this.a.size);
        gl.vertexAttribPointer(this.a.size, 1, gl.FLOAT, false, stride, 28);
        gl.uniformMatrix4fv(this.u.matrix, false, data.mainMatrix);
        gl.uniform3fv(this.u.camera, cameraPosition(data.mainMatrix));
        gl.uniform1f(this.u.gmst, satellite.gstime(new Date(simNow())));
        gl.uniform1f(this.u.pixelRatio, window.devicePixelRatio || 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.POINTS, 0, this.count);
        if (this.vao) gl.bindVertexArray(null);
    },
};

// Under the map tiles and night shading, which cover the Earth's disc anyway.
loaded.then(() => map.addLayer(starLayer, 'night'));
layerListeners.push(() => map.triggerRepaint());
