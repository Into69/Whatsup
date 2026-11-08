# WhatsUp

An Android satellite tracker on a 3D globe, centred on where you are.

**[Download the APK](release/whatsup.apk)** ([direct link](https://github.com/Into69/Whatsup/raw/main/release/whatsup.apk)). It is a debug build: allow installs from unknown sources to install it.

## What it does

- Satellites at their true altitude, from CelesTrak's orbital data, worked out on the phone with SGP4: the ISS, stations, GNSS, weather, geostationary, highly elliptical, Starlink, OneWeb and other constellations, debris and more, each group switchable in Settings.
- Orbit paths, ground tracks, coverage footprints, orbital planes, the geostationary belt, day and night, the stars and the Moon.
- Tap a satellite for its details, where to point at it from where you are (azimuth, elevation, skew), its next pass and any close approach.
- Sky view: hold the phone up to see what is overhead, over the camera if you like, with the geostationary arc marked.
- Dish aligner: a guide for pointing a dish at a satellite, with compass calibration on the Sun or Moon.
- Pass predictions and notifications for the ISS and starred satellites.
- Time travel from a day back to a week ahead; upcoming launches; close approaches between objects in orbit.
- In view: a list of everything above your horizon now (line of sight), starred first.
- Live aircraft from ADS-B within a radius you choose (5–250 NM), from adsb.lol, adsb.fi or your own receiver: on the globe, in sky view, in search and the in-view list, with where to look for each.

## Building

Needs JDK 17 and the Android SDK (`sdk.dir` in `local.properties`):

```
gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/whatsup.apk`.

## Data and credits

Orbital data, satellite catalogue and close approaches (SOCRATES): [CelesTrak](https://celestrak.org). Launches: [The Space Devs' Launch Library 2](https://thespacedevs.com). Stars: Yale Bright Star Catalogue, via [d3-celestial](https://github.com/ofrohn/d3-celestial). Orbit propagation: [satellite.js](https://github.com/shashwatak/satellite-js). Globe: [MapLibre GL JS](https://maplibre.org). Aircraft: [adsb.lol](https://adsb.lol) (ODbL) and [adsb.fi](https://adsb.fi) volunteer ADS-B networks. Map tiles: as credited on the map.
