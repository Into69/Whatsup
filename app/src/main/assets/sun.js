'use strict';

// The Sun: where it is, the night side of the globe, and which satellites are in Earth's shadow.
//
// Positions here are Earth-fixed and in the globe's own space (see toGlobe in satellites.js): x
// towards (0°N, 90°E), y towards the North Pole, z towards (0°N, 0°E).

/** Where the night shading is fully dark: the Sun 12° below the horizon (nautical twilight). */
const NIGHT_SUN_ELEVATION = -12;
const NIGHT_OPACITY = 0.62;

/**
 * Unit vector towards the Sun in inertial (ECI) coordinates, from the Astronomical Almanac's
 * low-precision formula (good to about 0.01°). satellite.js has sunPos(), but it mixes degrees and
 * radians in the mean anomaly, which puts the Sun up to ~2° out.
 */
function sunEci(date) {
    const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0; // days since J2000
    const rad = Math.PI / 180;
    const meanLongitude = 280.460 + 0.9856474 * n;
    const meanAnomaly = (357.528 + 0.9856003 * n) * rad;
    const longitude = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * rad;
    const obliquity = (23.439 - 0.0000004 * n) * rad;
    return [Math.cos(longitude), Math.cos(obliquity) * Math.sin(longitude), Math.sin(obliquity) * Math.sin(longitude)];
}

/** Unit vector towards the Sun in globe space at `date`. */
function sunDirection(date) {
    const [x, y, z] = sunEci(date);
    // Earth-fixed: turn the inertial vector back by the sidereal angle.
    const gmst = satellite.gstime(date);
    const ex = x * Math.cos(gmst) + y * Math.sin(gmst);
    const ey = -x * Math.sin(gmst) + y * Math.cos(gmst);
    // Globe space from Earth-fixed (x to 0°E, y to 90°E, z to the pole).
    return [ey, z, ex];
}

/** The Sun's elevation in degrees seen from (lat, lon), given sunDirection(). */
function sunElevation(sun, lat, lon) {
    const up = toGlobe(lat, lon, 0);
    return Math.asin(Math.max(-1, Math.min(1, dot(up, sun)))) * 180 / Math.PI;
}

/** True when a globe-space point is inside Earth's shadow (a cylinder; the penumbra is ignored). */
function inShadow(p, sun) {
    const along = dot(p, sun);
    if (along >= 0) return false;
    const off = [p[0] - along * sun[0], p[1] - along * sun[1], p[2] - along * sun[2]];
    return dot(off, off) < 1;
}

/** The Sun's direction at simNow(), refreshed once a minute and when the clock moves; the shaders and labels share it. */
let sun = sunDirection(new Date(simNow()));
function refreshSun() {
    sun = sunDirection(new Date(simNow()));
    map.triggerRepaint();
}
setInterval(refreshSun, 60_000);
timeListeners.push(refreshSun);

// ---- Night shading (custom WebGL layer: a sphere just above the surface, dark on the night side) ----

const NIGHT_VERTEX_SHADER = `
    uniform mat4 u_matrix;
    attribute vec3 a_pos;
    varying vec3 v_pos;

    void main() {
        v_pos = a_pos;
        gl_Position = u_matrix * vec4(a_pos * 1.0005, 1.0);
        gl_Position.z = 0.0;
    }`;

const NIGHT_FRAGMENT_SHADER = `
    precision mediump float;
    uniform vec3 u_sun;
    uniform vec3 u_camera;
    uniform float u_dark_elevation;
    uniform float u_opacity;
    varying vec3 v_pos;

    void main() {
        vec3 normal = normalize(v_pos);
        // The far side of the sphere, which the globe hides.
        if (dot(normal, u_camera - v_pos) < 0.0) discard;
        // Sine of the Sun's elevation here: 0 at the terminator, negative at night.
        float sunHeight = dot(normal, u_sun);
        // 0 in daylight, rising smoothly to 1 at u_dark_elevation (negative) and below. Written out:
        // smoothstep() is undefined when its first edge is above its second.
        float t = clamp(sunHeight / u_dark_elevation, 0.0, 1.0);
        float darkness = t * t * (3.0 - 2.0 * t) * u_opacity;
        if (darkness <= 0.0) discard;
        gl_FragColor = vec4(0.0, 0.01, 0.04, 1.0) * darkness;
    }`;

const nightLayer = {
    id: 'night',
    type: 'custom',
    renderingMode: '2d',

    onAdd(map, gl) {
        this.program = linkProgram(gl, NIGHT_VERTEX_SHADER, NIGHT_FRAGMENT_SHADER);
        const uniform = name => gl.getUniformLocation(this.program, name);
        this.u = {
            matrix: uniform('u_matrix'), sun: uniform('u_sun'), camera: uniform('u_camera'),
            darkElevation: uniform('u_dark_elevation'), opacity: uniform('u_opacity'),
        };
        this.a = { pos: gl.getAttribLocation(this.program, 'a_pos') };
        this.vao = gl.createVertexArray ? gl.createVertexArray() : null;

        // A latitude/longitude grid of triangles over the unit sphere.
        const rows = 48, cols = 96, positions = [];
        const at = (r, c) => toGlobe(90 - 180 * r / rows, -180 + 360 * c / cols, 0);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const a = at(r, c), b = at(r + 1, c), d = at(r, c + 1), e = at(r + 1, c + 1);
                positions.push(...a, ...b, ...d, ...d, ...b, ...e);
            }
        }
        this.count = positions.length / 3;
        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    },

    render(gl, args) {
        const data = args.defaultProjectionData;
        if (!layers.dayNight || args.shaderData.variantName !== 'globe' || data.projectionTransition <= 0.999) return;
        if (this.vao) gl.bindVertexArray(this.vao);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.a.pos);
        gl.vertexAttribPointer(this.a.pos, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(this.u.matrix, false, data.mainMatrix);
        gl.uniform3fv(this.u.sun, sun);
        gl.uniform3fv(this.u.camera, cameraPosition(data.mainMatrix));
        gl.uniform1f(this.u.darkElevation, Math.sin(NIGHT_SUN_ELEVATION * Math.PI / 180));
        gl.uniform1f(this.u.opacity, NIGHT_OPACITY);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        // MapLibre leaves back-face culling on from drawing the globe's tiles; the far side is
        // discarded in the fragment shader instead.
        gl.disable(gl.CULL_FACE);
        gl.drawArrays(gl.TRIANGLES, 0, this.count);
        if (this.vao) gl.bindVertexArray(null);
    },
};

// Over the map tiles, under everything else (globe.js puts new tiles below it).
loaded.then(() => map.addLayer(nightLayer, 'accuracy'));
layerListeners.push(() => map.triggerRepaint());
