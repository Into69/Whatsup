'use strict';

// The planets, Mercury to Neptune, and Pluto, for sky view (layers.planets): their right ascension
// and declination (equinox of date) and brightness, from Paul Schlyter's orbital elements and
// perturbation terms ("How to compute planetary positions", stjarnhimlen.se): good to a minute or two
// of arc, far finer than a dot. Pluto, whose orbit elements drift too much, comes from his periodic
// series instead (good from 1800 to 2100). Uranus is barely seen by eye; Neptune and Pluto need a
// telescope, Pluto a big one, so they are marked where they are rather than as they look.

/**
 * Elements at d days from 1999 Dec 31.0 UT, each [value, change per day]: longitude of the ascending
 * node N, inclination i, argument of perihelion w, semi-major axis a (AU), eccentricity e, mean
 * anomaly M; then the brightness at 1 AU from the Sun and Earth, and how it fades with the phase
 * angle in degrees: [per degree, per degree cubed, per degree to the sixth].
 */
const PLANETS = [
    { name: 'Mercury', N: [48.3313, 3.24587e-5], i: [7.0047, 5.0e-8], w: [29.1241, 1.01444e-5], a: 0.387098, e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368], mag: -0.36, phase: [0.027, 0, 2.2e-13], color: [214, 204, 190] },
    { name: 'Venus', N: [76.6799, 2.4659e-5], i: [3.3946, 2.75e-8], w: [54.891, 1.38374e-5], a: 0.72333, e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244], mag: -4.34, phase: [0.013, 4.2e-7, 0], color: [255, 248, 222] },
    { name: 'Mars', N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: 1.523688, e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766], mag: -1.51, phase: [0.016, 0, 0], color: [255, 140, 90] },
    { name: 'Jupiter', N: [100.4542, 2.76854e-5], i: [1.303, -1.557e-7], w: [273.8777, 1.64505e-5], a: 5.20256, e: [0.048498, 4.469e-9], M: [19.895, 0.0830853001], mag: -9.25, phase: [0.014, 0, 0], color: [255, 228, 190] },
    { name: 'Saturn', N: [113.6634, 2.3898e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: 9.55475, e: [0.055546, -9.499e-9], M: [316.967, 0.0334442282], mag: -9.0, phase: [0.044, 0, 0], color: [240, 220, 160] },
    { name: 'Uranus', N: [74.0005, 1.3978e-5], i: [0.7733, 1.9e-8], w: [96.6612, 3.0565e-5], a: 19.18171, e: [0.047318, 7.45e-9], M: [142.5905, 0.011725806], mag: -7.15, phase: [0.001, 0, 0], color: [175, 230, 235] },
    { name: 'Neptune', N: [131.7806, 3.0173e-5], i: [1.77, -2.55e-7], w: [272.8461, -6.027e-6], a: 30.05826, e: [0.008606, 2.15e-9], M: [260.2471, 0.005995147], mag: -6.9, phase: [0.001, 0, 0], color: [130, 160, 255] },
    // Its position from the series in plutoAt(); a dwarf planet since 2006, shown with the planets.
    { name: 'Pluto', mag: -1.01, phase: [0, 0, 0], color: [215, 190, 165] },
];

/**
 * Pluto's heliocentric ecliptic longitude and latitude (radians, equinox of date) and distance (AU) at
 * d days from 1999 Dec 31.0, from Schlyter's series (equinox J2000, so precessed on to the date).
 */
function plutoAt(d) {
    const rad = Math.PI / 180;
    const S = (50.03 + 0.033459652 * d) * rad, P = (238.95 + 0.003968789 * d) * rad;
    const sin = Math.sin, cos = Math.cos;
    const longitude = 238.9508 + 0.00400703 * d
        - 19.799 * sin(P) + 19.848 * cos(P) + 0.897 * sin(2 * P) - 4.956 * cos(2 * P)
        + 0.61 * sin(3 * P) + 1.211 * cos(3 * P) - 0.341 * sin(4 * P) - 0.19 * cos(4 * P)
        + 0.128 * sin(5 * P) - 0.034 * cos(5 * P) - 0.038 * sin(6 * P) + 0.031 * cos(6 * P)
        + 0.02 * sin(S - P) - 0.01 * cos(S - P)
        // Precession from J2000 to the date.
        + 3.82394e-5 * d;
    const latitude = -3.9082
        - 5.453 * sin(P) - 14.975 * cos(P) + 3.527 * sin(2 * P) + 1.673 * cos(2 * P)
        - 1.051 * sin(3 * P) + 0.328 * cos(3 * P) + 0.179 * sin(4 * P) - 0.292 * cos(4 * P)
        + 0.019 * sin(5 * P) + 0.1 * cos(5 * P) - 0.031 * sin(6 * P) - 0.026 * cos(6 * P)
        + 0.011 * cos(S - P);
    const r = 40.72 + 6.68 * sin(P) + 6.9 * cos(P) - 1.18 * sin(2 * P) - 0.03 * cos(2 * P) + 0.15 * sin(3 * P) - 0.14 * cos(3 * P);
    return { longitude: longitude * rad, latitude: latitude * rad, r };
}

/** Each planet at `date`: { name, ra (deg), dec (deg), mag, color [r, g, b] }. */
function planetsAt(date) {
    const d = date.getTime() / 86_400_000 + 2440587.5 - 2451543.5;
    const rad = Math.PI / 180;
    const at = ([value, rate]) => value + rate * d;
    const solve = (M, e) => {
        // Kepler's equation, by Newton's method from a good first guess.
        let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
        for (let k = 0; k < 5; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        return E;
    };

    // The Sun as seen from Earth, so Earth from the Sun is the opposite.
    const sunE = 0.016709 - 1.151e-9 * d, sunW = (282.9404 + 4.70935e-5 * d) * rad;
    const sunAnomaly = solve((356.047 + 0.9856002585 * d) * rad, sunE);
    const sunX = Math.cos(sunAnomaly) - sunE, sunY = Math.sqrt(1 - sunE * sunE) * Math.sin(sunAnomaly);
    const sunDistance = Math.hypot(sunX, sunY), sunLongitude = Math.atan2(sunY, sunX) + sunW;
    const xs = sunDistance * Math.cos(sunLongitude), ys = sunDistance * Math.sin(sunLongitude);
    const obliquity = (23.4393 - 3.563e-7 * d) * rad;
    const meanAnomaly = name => at(PLANETS.find(p => p.name === name).M);
    const jupiterM = meanAnomaly('Jupiter'), saturnM = meanAnomaly('Saturn'), uranusM = meanAnomaly('Uranus');

    return PLANETS.map(p => {
        // Heliocentric ecliptic longitude and latitude, and distance from the Sun.
        let longitude, latitude, r;
        if (p.name === 'Pluto') {
            ({ longitude, latitude, r } = plutoAt(d));
        } else {
            const N = at(p.N) * rad, i = at(p.i) * rad, w = at(p.w) * rad, e = at(p.e);
            const E = solve(at(p.M) * rad, e);
            const xv = p.a * (Math.cos(E) - e), yv = p.a * Math.sqrt(1 - e * e) * Math.sin(E);
            const v = Math.atan2(yv, xv);
            r = Math.hypot(xv, yv);
            longitude = Math.atan2(
                Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i),
                Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i));
            latitude = Math.asin(Math.sin(v + w) * Math.sin(i));
        }
        // Jupiter, Saturn and Uranus pull on each other enough to see.
        const sin = degrees => Math.sin(degrees * rad), cos = degrees => Math.cos(degrees * rad);
        const [mj, ms, mu] = [jupiterM, saturnM, uranusM];
        if (p.name === 'Uranus') {
            longitude += (0.04 * sin(ms - 2 * mu + 6) + 0.035 * sin(ms - 3 * mu + 33) - 0.015 * sin(mj - mu + 20)) * rad;
        } else if (p.name === 'Jupiter') {
            longitude += (-0.332 * sin(2 * mj - 5 * ms - 67.6) - 0.056 * sin(2 * mj - 2 * ms + 21) + 0.042 * sin(3 * mj - 5 * ms + 21)
                - 0.036 * sin(mj - 2 * ms) + 0.022 * cos(mj - ms) + 0.023 * sin(2 * mj - 3 * ms + 52) - 0.016 * sin(mj - 5 * ms - 69)) * rad;
        } else if (p.name === 'Saturn') {
            longitude += (0.812 * sin(2 * mj - 5 * ms - 67.6) - 0.229 * cos(2 * mj - 4 * ms - 2) + 0.119 * sin(mj - 2 * ms - 3)
                + 0.046 * sin(2 * mj - 6 * ms - 69) + 0.014 * sin(mj - 3 * ms + 32)) * rad;
            latitude += (-0.02 * cos(2 * mj - 4 * ms - 2) + 0.018 * sin(2 * mj - 6 * ms - 49)) * rad;
        }
        // Geocentric ecliptic, then equatorial.
        const xg = r * Math.cos(longitude) * Math.cos(latitude) + xs;
        const yg = r * Math.sin(longitude) * Math.cos(latitude) + ys;
        const zg = r * Math.sin(latitude);
        const ye = yg * Math.cos(obliquity) - zg * Math.sin(obliquity);
        const ze = yg * Math.sin(obliquity) + zg * Math.cos(obliquity);
        const distance = Math.hypot(xg, yg, zg);
        // The phase angle, Sun-planet-Earth, which dims the inner planets.
        const phase = Math.acos(Math.max(-1, Math.min(1, (r * r + distance * distance - sunDistance * sunDistance) / (2 * r * distance)))) / rad;
        return {
            name: p.name,
            ra: (Math.atan2(ye, xg) / rad + 360) % 360,
            dec: Math.atan2(ze, Math.hypot(xg, ye)) / rad,
            mag: p.mag + 5 * Math.log10(r * distance) + p.phase[0] * phase + p.phase[1] * phase ** 3 + p.phase[2] * phase ** 6,
            color: p.color,
        };
    });
}
