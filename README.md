# WhatsUp

A satellite tracker on a 3D globe, centred on where you are, for Android and Windows.

**Android: [download the APK](release/whatsup.apk)** ([direct link](https://github.com/Into69/Whatsup/raw/main/release/whatsup.apk)). It is a debug build: allow installs from unknown sources to install it.

**Windows 10 and 11: [download WhatsUp.exe](release/WhatsUp.exe)** ([direct link](https://github.com/Into69/Whatsup/raw/main/release/WhatsUp.exe)). One file, nothing to install: run it from anywhere. It isn't signed, so Windows SmartScreen asks first ("More info", then "Run anyway"). It keeps its settings and downloads in `%LOCALAPPDATA%\WhatsUp`.

## What it does

- Satellites at their true altitude, from CelesTrak's orbital data, worked out on the phone with SGP4: the ISS, stations, GNSS, weather, geostationary, highly elliptical, Starlink, OneWeb and other constellations, debris and more, each group switchable in Settings.
- Orbit paths, ground tracks, coverage footprints, orbital planes, the geostationary belt, day and night, the stars and the Moon.
- Tap a satellite for its details, where to point at it from where you are (azimuth, elevation, skew), its next pass and any close approach.
- Sky view: hold the phone up to see what is overhead, over the camera if you like, with the ground shaded, the real skyline of hills and mountains (what they hide is marked, there and in the in-view list), the geostationary arc, the planets and, if you like, the constellations.
- Red night mode (the moon button) turns the whole app red, to keep your eyes dark-adapted outside.
- Dish aligner: a guide for pointing a dish at a satellite, with compass calibration on the Sun or Moon.
- Pass predictions and notifications for the ISS and starred satellites.
- Time travel from a day back to a week ahead; upcoming launches; close approaches between objects in orbit.
- In view: a list of everything above your horizon now (line of sight), starred first.
- Live aircraft from ADS-B within a radius you choose (5–250 NM), from adsb.lol, adsb.fi or your own receiver: on the globe, in sky view, in search and the in-view list, with where to look for each. Tap one for its airframe, route, the track it has flown and how long it has to go.

## On Windows

The same app: the globe, sky view and every panel are the Android app's own page (`app/src/main/assets`), shown in Microsoft Edge WebView2, with the Android code around it ported to C# in `windows/`. What differs:

- Sky view is pointed with the mouse: drag the sky to look around, scroll to zoom, or use the arrow keys. The camera, compass calibration and dish aligner are for a phone held up to the sky, so they are left out.
- Your location comes from Windows (Wi-Fi, network or GPS), when "Let desktop apps access your location" is on in Windows' privacy settings; otherwise set it by hand in Settings. Addresses are looked up with OpenStreetMap's Nominatim.
- Pass alerts are Windows notifications, scheduled ahead, so they come even with WhatsUp closed.
- Esc, or the mouse's back button, closes the topmost panel; Ctrl+F searches; F11 fills the screen.

## Building

Android needs JDK 17 and the Android SDK (`sdk.dir` in `local.properties`):

```
gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/whatsup.apk`.

Windows needs the .NET 10 SDK:

```
dotnet publish windows/WhatsUp.csproj -c Release -o windows/publish
dotnet test windows/tests
```

The exe is written to `windows/publish/WhatsUp.exe`. Running it with the environment variable `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` opens the page to Edge's DevTools (`edge://inspect`).

## Data and credits

Orbital data, satellite catalogue and close approaches (SOCRATES): [CelesTrak](https://celestrak.org). Launches: [The Space Devs' Launch Library 2](https://thespacedevs.com). Stars and constellations: Yale Bright Star Catalogue, via [d3-celestial](https://github.com/ofrohn/d3-celestial). Planets: [Paul Schlyter's orbital elements](https://stjarnhimlen.se/comp/ppcomp.html). Terrain: [Terrain Tiles on AWS Open Data](https://registry.opendata.aws/terrain-tiles/) (Mapzen), from SRTM, GMTED2010, ETOPO1, NED, EU-DEM and others ([full attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)). Orbit propagation: [satellite.js](https://github.com/shashwatak/satellite-js). Globe: [MapLibre GL JS](https://maplibre.org). Aircraft: [adsb.lol](https://adsb.lol) (ODbL) and [adsb.fi](https://adsb.fi) volunteer ADS-B networks; routes and airframes: [hexdb.io](https://hexdb.io). Map tiles: as credited on the map.
