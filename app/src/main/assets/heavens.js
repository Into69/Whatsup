'use strict';

// The sky beyond the satellites (layers.stars): the stars of stars.js behind the globe, turning with
// the sidereal clock; the Sun, a glowing disc in its true direction; and the Moon at its true
// distance and size, lit from the Sun's side, with its dark maria. Each has a label, and a marker on
// the ground where it is overhead. Tapping the Sun or Moon (here or in sky view) selects it, and
// panels.js shows its sheet: where it is, rise and set, phases. Sky view draws them too.

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

const SYNODIC_MONTH_DAYS = 29.530589;

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
        distanceKm: distance,
        globe,
        lit,
        elongation,
        /** Days since new Moon. */
        age: elongation / 360 * SYNODIC_MONTH_DAYS,
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

// ---- The Sun and Moon on the globe (custom WebGL layer) ----

/** The Sun's angular radius (radians) and the Moon's true radius (Earth radii). */
const SUN_ANGULAR_RADIUS = 0.2666 * Math.PI / 180;
const MOON_RADIUS = 1737.4 / EARTH_RADIUS_KM;
/** Smallest they are drawn (CSS px of radius), however far out the camera is. */
const SUN_MIN_RADIUS_PX = 7, MOON_MIN_RADIUS_PX = 8;
/** The Sun's disc as a share of its sprite; the rest is glow. */
const SUN_DISC_FRACTION = 0.3;
/** Rise and set: where the upper edge meets the horizon, with refraction (degrees). */
const HORIZON_ELEVATION = -0.833;
const CIVIL_TWILIGHT_ELEVATION = -6;

const BODY_VERTEX_SHADER = `
    uniform mat4 u_matrix;
    uniform vec3 u_camera;
    uniform vec3 u_pos;
    uniform float u_size;
    attribute float a_index;

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
        gl_Position = u_matrix * vec4(u_pos, 1.0);
        gl_Position.z = 0.0;
        gl_PointSize = u_size + a_index * 0.0;
        if (gl_Position.w <= 0.0 || hidden(u_pos)) gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    }`;

const BODY_FRAGMENT_SHADER = `
    precision mediump float;
    // 0 the Sun, 1 the Moon.
    uniform float u_kind;
    // The disc's radius as a share of the sprite's.
    uniform float u_disc;
    // The Moon: the Sun's direction in the sprite's frame (x right, y up, z towards the viewer), and
    // how far to turn the sprite so the Moon's north is up.
    uniform vec3 u_light;
    uniform float u_north;

    vec2 rotate(vec2 p, float angle) {
        float c = cos(angle), s = sin(angle);
        return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    }

    // 1 inside a soft-edged mare at c of radius r, 0 outside.
    float mare(vec2 q, vec2 c, float r) {
        return 1.0 - smoothstep(r * 0.6, r, length(q - c));
    }

    void main() {
        vec2 p = (gl_PointCoord - 0.5) * 2.0;
        p.y = -p.y;
        float r = length(p) / u_disc;
        if (u_kind < 0.5) {
            // The Sun: a disc darkening to its edge (limb darkening), in a glow.
            if (r < 1.0) {
                float limb = 0.55 + 0.45 * sqrt(1.0 - r * r);
                gl_FragColor = vec4(mix(vec3(1.0, 0.6, 0.25), vec3(1.0, 0.98, 0.92), limb), 1.0);
                return;
            }
            float glow = 0.6 * exp(-(r - 1.0) * 1.4) * (1.0 - length(p));
            if (glow <= 0.004) discard;
            gl_FragColor = vec4(vec3(1.0, 0.85, 0.55) * glow, glow);
            return;
        }
        if (r > 1.0) discard;
        // The Moon: a sphere facing the viewer, lit from the Sun, with the near side's maria
        // (positions as seen from Earth, north up, the Moon's east to the right).
        vec2 d = p / u_disc;
        vec3 n = vec3(d, sqrt(max(0.0, 1.0 - dot(d, d))));
        vec2 q = rotate(d, u_north);
        float dark = max(max(max(mare(q, vec2(-0.35, 0.45), 0.26), mare(q, vec2(0.18, 0.40), 0.17)),
                             max(mare(q, vec2(0.36, 0.12), 0.21), mare(q, vec2(0.72, 0.30), 0.12))),
                         max(max(mare(q, vec2(0.55, -0.15), 0.14), mare(q, vec2(0.35, -0.30), 0.10)),
                             max(max(mare(q, vec2(-0.15, -0.40), 0.16), mare(q, vec2(-0.45, -0.40), 0.10)),
                                 mare(q, vec2(-0.62, 0.05), 0.32))));
        // The bright young crater Tycho, in the south.
        float tycho = 1.0 - smoothstep(0.02, 0.06, length(q - vec2(-0.12, -0.72)));
        float albedo = 0.8 - 0.36 * dark + 0.2 * tycho;
        float facing = dot(n, u_light);
        // A slightly soft terminator, and earthshine on the dark side.
        float lit = smoothstep(-0.02, 0.1, facing) * (0.35 + 0.65 * max(facing, 0.0));
        vec3 color = vec3(0.94, 0.93, 0.89) * albedo * (lit + 0.06);
        float edge = 1.0 - smoothstep(0.96, 1.0, r);
        gl_FragColor = vec4(color * edge, edge);
    }`;

/** Where the Sun and Moon were drawn last frame (CSS px): { x, y, r }, or null when not in view. */
const bodyOnScreen = { sun: null, moon: null };
/**
 * Which way to look for each when it is out of view but not behind the Earth: a screen direction
 * { dx, dy } (y down) for an indicator at the edge, else null.
 */
const bodyOffScreen = { sun: null, moon: null };
/** How far in from the screen's edge the indicators sit (CSS px). */
const BODY_POINTER_INSET = 26;

const BODIES = {
    sun: { kind: 'sun', name: 'Sun' },
    moon: { kind: 'moon', name: 'Moon' },
};

function normalize(v) {
    const length = Math.hypot(...v);
    return v.map(c => c / length);
}

const bodyLayer = {
    id: 'bodies',
    type: 'custom',
    renderingMode: '2d',

    onAdd(map, gl) {
        this.program = linkProgram(gl, BODY_VERTEX_SHADER, BODY_FRAGMENT_SHADER);
        const uniform = name => gl.getUniformLocation(this.program, name);
        this.u = {
            matrix: uniform('u_matrix'), camera: uniform('u_camera'), pos: uniform('u_pos'), size: uniform('u_size'),
            kind: uniform('u_kind'), disc: uniform('u_disc'), light: uniform('u_light'), north: uniform('u_north'),
        };
        this.a = { index: gl.getAttribLocation(this.program, 'a_index') };
        this.vao = gl.createVertexArray ? gl.createVertexArray() : null;
        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0]), gl.STATIC_DRAW);
        this.maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    },

    render(gl, args) {
        const data = args.defaultProjectionData;
        bodyOnScreen.sun = bodyOnScreen.moon = null;
        bodyOffScreen.sun = bodyOffScreen.moon = null;
        if (!layers.stars || args.shaderData.variantName !== 'globe' || data.projectionTransition <= 0.999) {
            placeBodyLabels();
            return;
        }
        const matrix = data.mainMatrix;
        const camera = cameraPosition(matrix);
        const canvas = map.getCanvas();
        const width = canvas.clientWidth, height = canvas.clientHeight;
        const ratio = window.devicePixelRatio || 1;
        const screen = p => {
            const c = transform(matrix, [...p, 1]);
            return c[3] > 0 ? [(c[0] / c[3] + 1) / 2 * width, (1 - c[1] / c[3]) / 2 * height] : null;
        };
        const distance = (a, b) => a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
        /** Screen angle (radians, anticlockwise from right) of a step from `from` along `towards`. */
        const screenAngle = (from, towards, length) => {
            const a = screen(from), b = screen(from.map((c, i) => c + towards[i] * length));
            return a && b ? Math.atan2(-(b[1] - a[1]), b[0] - a[0]) : 0;
        };
        /** A unit vector across the line of sight `view`, for measuring sizes on screen. */
        const across = view => {
            const c = cross(view, [0, 1, 0]);
            return Math.hypot(...c) < 1e-6 ? [1, 0, 0] : normalize(c);
        };

        if (this.vao) gl.bindVertexArray(this.vao);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.a.index);
        gl.vertexAttribPointer(this.a.index, 1, gl.FLOAT, false, 4, 0);
        gl.uniformMatrix4fv(this.u.matrix, false, matrix);
        gl.uniform3fv(this.u.camera, camera);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        /**
         * Draws one body; returns where it is on screen, or null if hidden or off screen (noting then
         * which way it is, for the edge indicator, unless the Earth is in the way).
         */
        const draw = (kind, pos, radiusPx, disc) => {
            if (occluded(pos, camera)) return null;
            const c = transform(matrix, [...pos, 1]);
            const centre = screen(pos);
            const inView = centre && centre[0] > -radiusPx && centre[1] > -radiusPx && centre[0] < width + radiusPx && centre[1] < height + radiusPx;
            if (!inView) {
                // Clip x and y (before dividing by w, which flips behind the camera) point the way
                // to it across the screen; scaled to pixels, y down.
                const dx = c[0] * width, dy = -c[1] * height;
                const length = Math.hypot(dx, dy);
                bodyOffScreen[kind === 0 ? 'sun' : 'moon'] = length > 1e-9 ? { dx: dx / length, dy: dy / length } : null;
            }
            if (!centre) return null;
            gl.uniform3fv(this.u.pos, pos);
            gl.uniform1f(this.u.size, Math.min(2 * radiusPx / disc * ratio, this.maxPointSize));
            gl.uniform1f(this.u.kind, kind);
            gl.uniform1f(this.u.disc, disc);
            gl.drawArrays(gl.POINTS, 0, 1);
            return inView ? { x: centre[0], y: centre[1], r: radiusPx } : null;
        };

        // The Sun, in effect at infinity like the stars: its true size there, or a little larger.
        const sunPos = camera.map((c, i) => c + sun[i] * STAR_DISTANCE);
        const sunEdge = sunPos.map((c, i) => c + across(sun)[i] * STAR_DISTANCE * Math.tan(SUN_ANGULAR_RADIUS));
        bodyOnScreen.sun = draw(0, sunPos, Math.max(SUN_MIN_RADIUS_PX, distance(screen(sunPos), screen(sunEdge))), SUN_DISC_FRACTION);

        // The Moon, where it really is: lit from the Sun's side, turned so its north is towards Earth's.
        const m = moon.globe;
        const view = normalize(camera.map((c, i) => c - m[i]));
        const moonEdge = m.map((c, i) => c + across(view)[i] * MOON_RADIUS);
        const moonRadius = Math.max(MOON_MIN_RADIUS_PX, distance(screen(m), screen(moonEdge)));
        const phaseAngle = Math.acos(Math.max(-1, Math.min(1, dot(sun, view))));
        const sunAcross = normalize(sun.map((c, i) => c - view[i] * dot(sun, view)));
        const sunAngle = screenAngle(m, sunAcross, MOON_RADIUS);
        gl.uniform3fv(this.u.light, [Math.sin(phaseAngle) * Math.cos(sunAngle), Math.sin(phaseAngle) * Math.sin(sunAngle), Math.cos(phaseAngle)]);
        const northAcross = normalize([0, 1, 0].map((c, i) => c - view[i] * view[1]));
        gl.uniform1f(this.u.north, Math.PI / 2 - screenAngle(m, northAcross, MOON_RADIUS));
        bodyOnScreen.moon = draw(1, m, moonRadius, 1);
        if (this.vao) gl.bindVertexArray(null);
        placeBodyLabels();
    },
};

// ---- Labels, markers where they are overhead, and tapping ----

const bodyLabels = {};
const bodyPointers = {};

function placeBodyLabels() {
    placeBodyPointers();
    for (const kind of ['sun', 'moon']) {
        let label = bodyLabels[kind];
        if (!label) {
            label = bodyLabels[kind] = document.createElement('div');
            label.className = 'body-label';
            document.getElementById('map').appendChild(label);
        }
        const at = bodyOnScreen[kind];
        label.style.display = at ? '' : 'none';
        if (!at) continue;
        label.textContent = kind === 'sun' ? 'Sun' : `Moon · ${Math.round(moon.lit * 100)}%`;
        label.style.transform = `translate(${at.x + at.r + 4}px, ${at.y - 8}px)`;
        label.classList.toggle('selected', selectedBody?.kind === kind);
    }
}

/** For a body out of view: a small ☀ or ☾ at the screen's edge, on the line towards it. Tap to select. */
function placeBodyPointers() {
    const canvas = map.getCanvas();
    const width = canvas.clientWidth, height = canvas.clientHeight;
    for (const kind of ['sun', 'moon']) {
        let pointer = bodyPointers[kind];
        if (!pointer) {
            pointer = bodyPointers[kind] = document.createElement('button');
            pointer.className = `body-pointer body-pointer-${kind}`;
            pointer.innerHTML = '<span class="body-pointer-arrow"></span><span class="body-pointer-icon"></span>';
            pointer.querySelector('.body-pointer-icon').textContent = kind === 'sun' ? '☀' : '☾';
            pointer.setAttribute('aria-label', kind === 'sun' ? 'Sun' : 'Moon');
            pointer.addEventListener('click', () => selectBody(BODIES[kind]));
            document.getElementById('map').appendChild(pointer);
        }
        const way = bodyOffScreen[kind];
        pointer.style.display = way ? '' : 'none';
        if (!way) continue;
        // From the middle of the screen along the direction, to the inset edge.
        const halfW = width / 2 - BODY_POINTER_INSET, halfH = height / 2 - BODY_POINTER_INSET;
        const reach = Math.min(way.dx ? halfW / Math.abs(way.dx) : Infinity, way.dy ? halfH / Math.abs(way.dy) : Infinity);
        const x = width / 2 + way.dx * reach, y = height / 2 + way.dy * reach;
        pointer.style.transform = `translate(${x}px, ${y}px)`;
        pointer.querySelector('.body-pointer-arrow').style.transform = `rotate(${Math.atan2(way.dy, way.dx)}rad)`;
        pointer.classList.toggle('selected', selectedBody?.kind === kind);
    }
}

/** Where on the ground the body is overhead. */
function bodySubpoint(kind) {
    if (kind === 'moon') return { lat: moon.lat, lon: moon.lon };
    return { lat: Math.asin(sun[1]) * 180 / Math.PI, lon: Math.atan2(sun[0], sun[2]) * 180 / Math.PI };
}

const subpointMarkers = {};

function placeSubpoints() {
    for (const kind of ['sun', 'moon']) {
        if (!layers.stars) {
            subpointMarkers[kind]?.remove();
            delete subpointMarkers[kind];
            continue;
        }
        const { lat, lon } = bodySubpoint(kind);
        if (!subpointMarkers[kind]) {
            const node = document.createElement('div');
            node.className = `subpoint subpoint-${kind}`;
            node.addEventListener('click', e => {
                e.stopPropagation();
                selectBody(BODIES[kind]);
            });
            subpointMarkers[kind] = new maplibregl.Marker({ element: node }).setLngLat([lon, lat]).addTo(map);
        } else {
            subpointMarkers[kind].setLngLat([lon, lat]);
        }
    }
}

/** The Sun or Moon drawn at CSS pixel (x, y), if either is. */
function bodyAt(x, y) {
    for (const kind of ['moon', 'sun']) {
        const at = bodyOnScreen[kind];
        if (at && Math.hypot(at.x - x, at.y - y) < Math.max(at.r + 6, TAP_RADIUS_PX)) return BODIES[kind];
    }
    return null;
}

/** Selects the Sun or Moon (null to clear), in place of any satellite. */
function selectBody(body) {
    if (selected) select(null);
    selectedBody = body;
    following = false;
    notifySatelliteListeners();
    map.triggerRepaint();
}

// ---- Rise, set and phases ----

/** Azimuth and elevation (degrees) of the Sun or Moon from (lat, lon) at time t (ms). */
function bodyLook(kind, t, lat, lon) {
    const date = new Date(t);
    const p = kind === 'sun' ? sunDirection(date).map(c => c * 1e6) : moonAt(date).globe;
    return azEl(skyDirection(p, lat, lon));
}

/**
 * The body's risings and settings across `elevation`, and its highest points, from `from` for
 * `hours`, in time order: [{ type: 'rise' | 'set' | 'peak', t, az, el }].
 */
function bodyEvents(kind, from, hours, lat, lon, elevation = HORIZON_ELEVATION) {
    const STEP = 10 * 60_000;
    const el = t => bodyLook(kind, t, lat, lon)[1];
    const events = [];
    let t0 = from, e0 = el(t0), slope0 = null;
    for (let t1 = from + STEP; t1 <= from + hours * 3_600_000; t1 += STEP) {
        const e1 = el(t1);
        if ((e0 < elevation) !== (e1 < elevation)) {
            // Bisected to about a second.
            const rising = e0 < elevation;
            let a = t0, b = t1;
            while (b - a > 1000) {
                const mid = (a + b) / 2;
                if ((el(mid) < elevation) === rising) a = mid; else b = mid;
            }
            const t = (a + b) / 2;
            events.push({ type: rising ? 'rise' : 'set', t, az: bodyLook(kind, t, lat, lon)[0], el: elevation });
        }
        const slope1 = e1 - e0;
        if (slope0 !== null && slope0 > 0 && slope1 <= 0) {
            // Highest somewhere in the last two steps: golden-section search for it.
            let a = t0 - STEP, b = t1;
            const g = (Math.sqrt(5) - 1) / 2;
            for (let i = 0; i < 25 && b - a > 1000; i++) {
                const c = b - g * (b - a), d = a + g * (b - a);
                if (el(c) > el(d)) b = d; else a = c;
            }
            const t = (a + b) / 2;
            const [az, peak] = bodyLook(kind, t, lat, lon);
            events.push({ type: 'peak', t, az, el: peak });
        }
        t0 = t1;
        e0 = e1;
        slope0 = slope1;
    }
    return events.sort((a, b) => a.t - b.t);
}

/** When the Moon next reaches `elongation` degrees from the Sun (0 new, 180 full) after `from` (ms). */
function nextMoonPhase(elongation, from) {
    const STEP = 6 * 3_600_000;
    const off = t => ((moonAt(new Date(t)).elongation - elongation + 540) % 360) - 180;
    let t0 = from, f0 = off(t0);
    for (let t1 = from + STEP; t1 < from + 32 * 86_400_000; t1 += STEP) {
        const f1 = off(t1);
        if (f0 < 0 && f1 >= 0 && f1 - f0 < 90) {
            let a = t0, b = t1;
            while (b - a > 30_000) {
                const mid = (a + b) / 2;
                if (off(mid) < 0) a = mid; else b = mid;
            }
            return (a + b) / 2;
        }
        t0 = t1;
        f0 = f1;
    }
    return null;
}

/** The Sun's distance in AU at `date` (Astronomical Almanac). */
function sunDistanceAu(date) {
    const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
    const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
    return 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
}

// Over everything else: the Moon can pass in front of the Earth and the satellites.
loaded.then(() => {
    map.addLayer(bodyLayer);
    placeSubpoints();
});
layerListeners.push(() => loaded.then(placeSubpoints));
timeListeners.push(() => loaded.then(placeSubpoints));
setInterval(() => loaded.then(placeSubpoints), 60_000);
