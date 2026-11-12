# WhatsUp

A satellite tracker on a 3D globe, centred on where you are, for Android, Windows and Linux.

**Android: [download the APK](https://github.com/Into69/Whatsup/releases/latest/download/whatsup.apk)**. It is a debug build: allow installs from unknown sources to install it.

**Windows 10 and 11: [download WhatsUp.exe](https://github.com/Into69/Whatsup/releases/latest/download/WhatsUp.exe)**. One file, nothing to install: run it from anywhere. It isn't signed, so Windows SmartScreen asks first ("More info", then "Run anyway"). It keeps its settings and downloads in `%LOCALAPPDATA%\WhatsUp`.

**Linux (64-bit Intel/AMD): [download WhatsUp-linux-x64.tar.gz](https://github.com/Into69/Whatsup/releases/latest/download/WhatsUp-linux-x64.tar.gz)**. Unpack it and run `whatsup/whatsup`, or `whatsup/install.sh` to put it in your app menu (`install.sh --remove` takes it out again). It needs WebKitGTK, which most desktops already have; if not: `sudo apt install libwebkit2gtk-4.1-0` (Debian, Ubuntu), `sudo dnf install webkit2gtk4.1` (Fedora) or `sudo pacman -S webkit2gtk-4.1` (Arch). It keeps its settings in `~/.local/share/whatsup` and its downloads in `~/.cache/whatsup`.

All three are attached to each [release](https://github.com/Into69/Whatsup/releases); the links above always fetch the newest. Once installed, WhatsUp looks for a newer release once a day (Settings › About, where you can also check now or turn it off) and offers it: Update downloads it, with the same progress bar as the data downloads, and installs it. On Android the system asks first, and the first time to allow WhatsUp to install apps; on Windows and Linux it replaces itself and restarts.

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

## On Windows and Linux

The same app: the globe, sky view and every panel are the Android app's own page (`app/src/main/assets`), with the Android code around it ported to C# (`desktop/`, shared by both) and shown in the system's web view: Microsoft Edge WebView2 on Windows (`windows/`), WebKitGTK on Linux (`linux/`). What differs from the phone:

- Sky view is pointed with the mouse: drag the sky to look around, scroll to zoom, or use the arrow keys. The camera, compass calibration and dish aligner are for a phone held up to the sky, so they are left out.
- Your location comes from the system: on Windows (Wi-Fi, network or GPS) when "Let desktop apps access your location" is on in its privacy settings; on Linux from GeoClue, where the desktop has it running. Otherwise set it by hand in Settings. Addresses are looked up with OpenStreetMap's Nominatim.
- Pass alerts are the system's notifications, scheduled ahead so they come even with WhatsUp closed: on Windows, scheduled notifications; on Linux, systemd user timers, which last until the computer restarts (each time WhatsUp opens it sets the next three days' again).
- Esc, or the mouse's back button, closes the topmost panel; Ctrl+F searches; F11 fills the screen.
- On Linux under WSL (Windows' Linux), WhatsUp draws with Mesa's software renderer, as WSL's GPU driver leaves the globe black. If the globe stays black on another Linux machine, start it with `LIBGL_ALWAYS_SOFTWARE=1 whatsup` to do the same.

## Building

Android needs JDK 17 and the Android SDK (`sdk.dir` in `local.properties`):

```
gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/whatsup.apk`.

Each release needs a new `versionName` (and `versionCode`) in `app/build.gradle.kts`, tagged `v<versionName>`: the apps offer an update when the latest release's tag is newer than their own version, so files replaced in an existing release reach no one.

Windows and Linux need the .NET 10 SDK, on any system:

```
dotnet test desktop/tests
dotnet publish windows/WhatsUp.csproj -c Release -o windows/publish
dotnet publish linux/WhatsUp.Linux.csproj -c Release -o linux/publish
```

The Windows exe is written to `windows/publish/WhatsUp.exe`. Running it with the environment variable `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` opens the page to Edge's DevTools (`edge://inspect`). On Linux (or WSL), `sh linux/build-package.sh` then packs `linux/publish/whatsup` into `release/WhatsUp-linux-x64.tar.gz`. GitHub builds both desktop apps itself and attaches them to each release as it is published (`.github/workflows/desktop.yml`); to rebuild them for an existing release, run the workflow by hand from the Actions tab. A Linux debug build run with `WHATSUP_TEST_PORT=9334` takes test commands on that port (`linux/TestHook.cs`).

## Data and credits

Orbital data, satellite catalogue and close approaches (SOCRATES): [CelesTrak](https://celestrak.org). Launches: [The Space Devs' Launch Library 2](https://thespacedevs.com). Stars and constellations: Yale Bright Star Catalogue, via [d3-celestial](https://github.com/ofrohn/d3-celestial). Planets: [Paul Schlyter's orbital elements](https://stjarnhimlen.se/comp/ppcomp.html). Terrain: [Terrain Tiles on AWS Open Data](https://registry.opendata.aws/terrain-tiles/) (Mapzen), from SRTM, GMTED2010, ETOPO1, NED, EU-DEM and others ([full attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)). Orbit propagation: [satellite.js](https://github.com/shashwatak/satellite-js). Globe: [MapLibre GL JS](https://maplibre.org). Aircraft: [adsb.lol](https://adsb.lol) (ODbL) and [adsb.fi](https://adsb.fi) volunteer ADS-B networks; routes and airframes: [hexdb.io](https://hexdb.io). Map tiles: as credited on the map.
