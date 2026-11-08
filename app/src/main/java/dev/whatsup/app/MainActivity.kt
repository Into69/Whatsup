package dev.whatsup.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.location.Location
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.format.Formatter
import android.util.Log
import android.view.Surface
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.math.atan

/** Full-screen globe centred on the device's location. */
class MainActivity : ComponentActivity(), SensorEventListener {
    private lateinit var webView: WebView
    private lateinit var settings: Settings
    private lateinit var tracker: LocationTracker

    private var pageReady = false
    /** Read by the /data/ handler (aircraft) off the main thread too. */
    @Volatile
    private var lastLocation: Location? = null
    /** Whether the map is on screen: aircraft are only fetched then, never in the background. */
    @Volatile
    private var mapShown = false
    private val aircraftFeed = AircraftFeed()
    /** The location set by hand that lastLocation holds, or null while it is the phone's. */
    private var shownManualLocation: Place? = null
    /** The globe flies to the first fix only; later fixes just move the marker. */
    private var centredOnFix = false
    private var shownTileSetId: String? = null
    private val downloadTracker = DownloadTracker()
    private lateinit var elementSets: ElementSetRepository
    private lateinit var catalog: SatelliteCatalog
    private lateinit var conjunctions: ConjunctionFeed
    private lateinit var launches: LaunchFeed
    /** The page's close approaches (/data/conjunctions.json), once the user has asked for them. */
    @Volatile private var conjunctionData: ByteArray? = null
    private var shownElementSets: List<ElementSet> = emptyList()
    /**
     * The satellite list the page fetches from /data/satellites.json (see globe.loadSatellites()).
     * It is served rather than passed to evaluateJavascript() because it runs to megabytes.
     */
    @Volatile private var satelliteData = ByteArray(0)
    /**
     * The element sets satelliteData was built from, so an unchanged list isn't rebuilt or resent
     * (resending clears a selection). ElementSetRepository returns the same objects while nothing
     * has changed, so comparing the lists is cheap.
     */
    private var pushedElementSets: List<ElementSet>? = null
    private var loadJob: Job? = null
    /** The satellite list being built; a newer push cancels it so a slow, stale one can't land last. */
    private var pushJob: Job? = null
    private var shownLayers: String? = null
    private lateinit var downloadsPanel: LinearLayout
    /** Pending removal of the downloads panel after everything has finished. */
    private val clearDownloads = Runnable { downloadTracker.clearFinished() }

    /** Sends back presses to the page while it has a panel open (globe.back()). */
    private val closePanel = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = runJs("globe.back()")
    }
    private lateinit var sensors: SensorManager
    /** True while the page (sky view or the dish aligner) wants the phone's orientation. */
    private var orientationWanted = false
    private var lastOrientationAt = 0L

    /** The page's camera request (sky view), waiting on the user's answer to the app's own. */
    private var pendingCameraRequest: PermissionRequest? = null
    private val requestCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingCameraRequest ?: return@registerForActivityResult
        pendingCameraRequest = null
        if (granted) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
            Toast.makeText(this, R.string.camera_denied, Toast.LENGTH_LONG).show()
        }
    }

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted ->
        if (granted.values.any { it }) {
            if (settings.activeManualLocation == null) tracker.start()
        } else {
            Toast.makeText(this, R.string.location_denied, Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        settings = Settings(this)
        sensors = getSystemService(SensorManager::class.java)
        onBackPressedDispatcher.addCallback(this, closePanel)
        elementSets = ElementSetRepository(this, downloadTracker)
        catalog = SatelliteCatalog(this)
        conjunctions = ConjunctionFeed(this, downloadTracker)
        launches = LaunchFeed(this)
        tracker = LocationTracker(this) { location ->
            // A last fix can still arrive just after switching to a location set by hand.
            if (settings.activeManualLocation != null) return@LocationTracker
            lastLocation = location
            pushLocation()
            pushCompass()
        }

        val controls = findViewById<View>(R.id.controls)
        ViewCompat.setOnApplyWindowInsetsListener(controls) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            insets
        }
        downloadsPanel = findViewById(R.id.downloads)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { downloadTracker.downloads.collect(::showDownloads) }
        }
        val toggle = findViewById<View>(R.id.buttons_toggle)
        showButtons(toggle, !settings.buttonsHidden)
        toggle.setOnClickListener {
            settings.buttonsHidden = !settings.buttonsHidden
            showButtons(toggle, !settings.buttonsHidden)
        }
        findViewById<View>(R.id.settings_button).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        findViewById<View>(R.id.search_button).setOnClickListener { runJs("globe.openSearch()") }
        findViewById<View>(R.id.sky_button).setOnClickListener { runJs("globe.toggleSkyView()") }
        findViewById<View>(R.id.in_view_button).setOnClickListener { runJs("globe.openInView()") }
        findViewById<View>(R.id.time_button).setOnClickListener { runJs("globe.toggleTimeBar()") }
        findViewById<View>(R.id.events_button).setOnClickListener { runJs("globe.openEvents()") }
        findViewById<View>(R.id.recentre_button).setOnClickListener {
            if (lastLocation == null) {
                Toast.makeText(this, R.string.no_location_yet, Toast.LENGTH_SHORT).show()
            } else {
                runJs("globe.recentre()")
            }
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/data/") { path ->
                val data = when {
                    path == "satellites.json" -> satelliteData
                    path == "conjunctions.json" -> conjunctionData
                    // Off the main thread here; from the saved copy unless it is an hour old.
                    path == "launches.json" -> launches.load()
                    // globe.js asks for a tapped satellite's catalogue record; off the main thread here.
                    path.startsWith("satcat/") -> path.removePrefix("satcat/").toIntOrNull()?.let(catalog::lookup)
                    // Live aircraft around the location (aircraft.js polls it); off the main thread here.
                    path == "aircraft.json" -> aircraftData()
                    else -> null
                } ?: return@addPathHandler null
                WebResourceResponse("application/json", "utf-8", ByteArrayInputStream(data))
            }
            .build()
        webView = findViewById(R.id.globe)
        webView.settings.javaScriptEnabled = true
        // Sky view's camera background starts playing without a tap.
        webView.settings.mediaPlaybackRequiresUserGesture = false
        // The page is the app's own (served from its assets), so it may call back into the app.
        webView.addJavascriptInterface(Bridge(), "Android")
        webView.setBackgroundColor(getColor(R.color.space))
        webView.webChromeClient = object : WebChromeClient() {
            /** Sky view asks for the camera (getUserMedia); passed on as the app's own request. */
            override fun onPermissionRequest(request: PermissionRequest) = runOnUiThread {
                val video = PermissionRequest.RESOURCE_VIDEO_CAPTURE
                if (video !in request.resources || request.origin.host != WebViewAssetLoader.DEFAULT_DOMAIN) {
                    request.deny()
                } else if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(arrayOf(video))
                } else {
                    pendingCameraRequest?.deny()
                    pendingCameraRequest = request
                    requestCamera.launch(Manifest.permission.CAMERA)
                }
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            /** Only the app's own pages load here; links (e.g. in the map credits) open in the browser. */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (e: ActivityNotFoundException) {
                    Log.w(TAG, "No app to open ${request.url}", e)
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                // A (re)loaded page has no dish aligner open to have hidden them.
                findViewById<View>(R.id.map_controls).visibility = View.VISIBLE
                // A (re)loaded page has none of what was sent to the last one: tiles, layers,
                // satellites, nor a view of the location to keep.
                pushedElementSets = null
                shownTileSetId = null
                shownLayers = null
                centredOnFix = false
                pushTileSet()
                pushLayers()
                pushLocation()
                pushCompass()
                pushFavourites()
                backCameraFov()?.let { (long, short) -> runJs("globe.setCameraFov($long, $short)") }
                pushSatellites()
            }
        }
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/globe.html")
    }

    override fun onStart() {
        super.onStart()
        // Coming back from SettingsActivity passes through here too, so a location set by hand (or
        // turned off) there is picked up before anything else uses the location.
        applyLocationSource()
    }

    /**
     * Uses the location set by hand in SettingsActivity, if it is on, in place of the phone's (whose
     * tracking stops); otherwise the phone's. On a switch, the globe flies to the new one.
     */
    private fun applyLocationSource() {
        val manual = settings.activeManualLocation
        if (manual != null) {
            tracker.stop()
            if (manual == shownManualLocation) return
            shownManualLocation = manual
            lastLocation = Location(MANUAL_PROVIDER).apply {
                latitude = manual.position.lat
                longitude = manual.position.lon
            }
            centredOnFix = false
            pushLocation()
            pushCompass()
            return
        }
        if (shownManualLocation != null) {
            // Back to the phone's: forget the hand-set place (the page too, so nothing goes on using
            // it), before tracking starts and its first fix flies the globe there.
            shownManualLocation = null
            lastLocation = null
            centredOnFix = false
            if (pageReady) runJs("globe.clearLocation()")
            pushCompass()
        }
        startPhoneLocation()
    }

    /** Tracks the phone's location, asking for permission first if the app hasn't got it. */
    private fun startPhoneLocation() {
        val permissions = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (permissions.any { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) {
            tracker.start()
        } else {
            requestPermission.launch(permissions)
        }
    }

    override fun onResume() {
        super.onResume()
        mapShown = true
        webView.onResume()
        applyCacheMode()
        // Picks up a tile set, satellite groups or layers chosen in SettingsActivity (the location
        // was picked up in onStart).
        pushTileSet()
        pushLayers()
        loadSatellites()
        // Pass alerts may have been turned on or off in SettingsActivity.
        PassAlerts.reschedule(this)
        if (orientationWanted) startOrientation()
    }

    override fun onPause() {
        mapShown = false
        sensors.unregisterListener(this)
        webView.onPause()
        super.onPause()
    }

    override fun onStop() {
        tracker.stop()
        super.onStop()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    /** Folds the column of map buttons away under its toggle, or out again; the chevron points the way it will go. */
    private fun showButtons(toggle: View, shown: Boolean) {
        findViewById<View>(R.id.map_buttons).visibility = if (shown) View.VISIBLE else View.GONE
        toggle.rotation = if (shown) 180f else 0f
        toggle.contentDescription = getString(if (shown) R.string.hide_buttons else R.string.show_buttons)
    }

    private fun pushTileSet() {
        val tileSet = settings.tileSet
        if (!pageReady || tileSet.id == shownTileSetId) return
        shownTileSetId = tileSet.id
        runJs("globe.setTiles(${tileSet.toJson()})")
    }

    private fun pushLayers() {
        val json = settings.layersJson().toString()
        if (!pageReady || json == shownLayers) return
        shownLayers = json
        runJs("globe.setLayers($json)")
    }

    private fun pushLocation() {
        val location = lastLocation ?: return
        if (!pageReady) return
        val accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0
        runJs("globe.setLocation(${location.latitude}, ${location.longitude}, $accuracy, ${!centredOnFix})")
        centredOnFix = true
    }

    /** ElementSetRepository refetches groups older than it allows; newer ones come from its cache. */
    private fun loadSatellites() {
        val groups = settings.shownGroups
        loadJob?.cancel()
        elementSets.queue(groups)
        // Started only once it is loadJob: with nothing to fetch it can finish at once, and its
        // clean-up below must then see itself as the latest load.
        val job = lifecycleScope.launch(start = CoroutineStart.LAZY) {
            // shownGroups keeps SatelliteGroup's order, so a satellite in several goes to the first.
            try {
                shownElementSets = groups.flatMap { elementSets.get(it) }.distinctBy { it.noradId }
            } finally {
                // Done, or cancelled by a newer load (which clears the queue itself): nothing left
                // waiting, including any left by a load this one replaced.
                if (loadJob == coroutineContext[Job]) downloadTracker.unqueue()
            }
            pushSatellites()
            // How old the data is: old means the phone has been offline (the saved copies are used).
            val updatedAt = groups.map(elementSets::updatedAt).filter { it > 0 }.minOrNull() ?: 0L
            if (pageReady) runJs("globe.setDataAge($updatedAt)")
        }
        loadJob = job
        job.start()
    }

    /**
     * The magnetic declination here, so the page can turn compass headings (magnetic north) into
     * true ones, and the user's own calibration on top.
     */
    private fun pushCompass() {
        if (!pageReady) return
        val declination = lastLocation?.let {
            GeomagneticField(it.latitude.toFloat(), it.longitude.toFloat(), it.altitude.toFloat(), System.currentTimeMillis())
                .declination
        } ?: 0f
        runJs("globe.setCompass($declination, ${settings.compassOffset}, ${lastLocation != null})")
    }

    private fun pushFavourites() {
        if (pageReady) runJs("globe.setFavourites(${JSONArray(settings.favourites.toList())})")
    }

    /** The back camera's field of view in degrees across its sensor's long and short sides, if known. */
    private fun backCameraFov(): Pair<Double, Double>? = try {
        val manager = getSystemService(CameraManager::class.java)
        manager.cameraIdList.asSequence()
            .map(manager::getCameraCharacteristics)
            .firstOrNull { it.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
            ?.let { camera ->
                val size = camera.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
                val focal = camera.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
                if (size == null || focal == null || focal <= 0f) return@let null
                val fov = { mm: Float -> Math.toDegrees(2 * atan(mm / (2.0 * focal))) }
                fov(maxOf(size.width, size.height)) to fov(minOf(size.width, size.height))
            }
    } catch (e: Exception) {
        Log.w(TAG, "No camera field of view", e)
        null
    }

    /** The aircraft around the location, if the map is showing and there is a location; see AircraftFeed. */
    private fun aircraftData(): ByteArray {
        val location = lastLocation
        if (!mapShown || location == null || !settings.aircraftShown) return AircraftFeed.error("waiting")
        return aircraftFeed.load(location.latitude, location.longitude, settings.aircraftRadiusNm, settings.aircraftReceiver)
    }

    /**
     * Offline, map tiles come from the WebView's cache even when it holds them as stale; in offline
     * mode, only from there, never the network.
     */
    private fun applyCacheMode() {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val online = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        webView.settings.cacheMode = when {
            settings.offlineMode -> WebSettings.LOAD_CACHE_ONLY
            online -> WebSettings.LOAD_DEFAULT
            else -> WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
    }

    /** One row per download, with a progress bar; the panel goes once all have finished and been seen. */
    /**
     * The downloads as a queue at the bottom of the screen: how far through it is, the one under way
     * (or, at the end, the last), and what is waiting. It goes once all have finished and been seen.
     */
    private fun showDownloads(downloads: Map<String, Download>) {
        downloadsPanel.removeCallbacks(clearDownloads)
        downloadsPanel.visibility = if (downloads.isEmpty()) View.GONE else View.VISIBLE
        if (downloads.isEmpty()) return
        val all = downloads.values.toList()
        val waiting = all.filter { it.state == Download.State.QUEUED }
        val finished = all.count { !it.active }
        val failed = all.count { it.state == Download.State.FAILED }
        val current = all.firstOrNull { it.state == Download.State.RUNNING } ?: waiting.firstOrNull() ?: all.last()
        val done = all.none { it.active }

        downloadsPanel.findViewById<TextView>(R.id.download_summary).text = when {
            !done -> getString(R.string.downloads_running, minOf(finished + 1, all.size), all.size)
            failed > 0 -> getString(R.string.downloads_failed, failed, all.size)
            else -> getString(R.string.downloads_finished)
        }
        bindDownload(downloadsPanel.findViewById(R.id.download_current), current)
        val next = waiting.filter { it !== current }
        downloadsPanel.findViewById<TextView>(R.id.download_queue).apply {
            visibility = if (next.isEmpty()) View.GONE else View.VISIBLE
            val names = next.take(QUEUE_NAMES_SHOWN).joinToString(", ") { it.file }
            text = if (next.size > QUEUE_NAMES_SHOWN) {
                getString(R.string.downloads_next_more, names, next.size - QUEUE_NAMES_SHOWN)
            } else {
                getString(R.string.downloads_next, names)
            }
        }
        if (done) downloadsPanel.postDelayed(clearDownloads, DOWNLOADS_LINGER_MS)
    }

    private fun bindDownload(row: View, download: Download) {
        val size = { bytes: Long -> Formatter.formatShortFileSize(this, bytes) }
        val known = download.totalBytes > 0
        row.findViewById<TextView>(R.id.download_file).text = download.file
        row.findViewById<TextView>(R.id.download_status).text = when (download.state) {
            Download.State.QUEUED -> getString(R.string.download_queued)
            Download.State.RUNNING -> when {
                known -> getString(R.string.download_progress, size(download.bytesRead), size(download.totalBytes))
                download.bytesRead > 0 -> size(download.bytesRead)
                else -> getString(R.string.download_starting)
            }
            Download.State.DONE -> getString(R.string.download_done, size(download.bytesRead))
            Download.State.NOT_UPDATED -> getString(R.string.download_not_updated)
            Download.State.FAILED -> getString(R.string.download_failed)
        }
        val bar = row.findViewById<ProgressBar>(R.id.download_progress)
        bar.isIndeterminate = download.state == Download.State.RUNNING && !known
        bar.progress = when {
            download.state == Download.State.QUEUED -> 0
            download.state != Download.State.RUNNING -> bar.max
            known -> (download.bytesRead * bar.max / download.totalBytes).toInt()
            else -> 0
        }
    }

    private fun pushSatellites() {
        val sets = shownElementSets
        if (!pageReady || sets == pushedElementSets) return
        pushJob?.cancel()
        pushJob = lifecycleScope.launch {
            val json = withContext(Dispatchers.Default) {
                JSONObject()
                    .put("groups", JSONObject().apply {
                        for (group in SatelliteGroup.entries) {
                            put(group.key, group.styleJson(getString(group.title).substringBefore('\n')))
                        }
                    })
                    // CelesTrak's OMM CSV columns, the same for every query; each satellite is its values.
                    .put("columns", JSONArray(sets.firstOrNull()?.columns.orEmpty()))
                    .put("satellites", JSONArray().apply { for (set in sets) put(set.toJson()) })
                    .toString()
                    .toByteArray()
            }
            satelliteData = json
            pushedElementSets = sets
            runJs("globe.loadSatellites()")
        }
    }

    private fun runJs(script: String) = webView.evaluateJavascript(script, null)

    private fun startOrientation() {
        val rotation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) ?: return
        sensors.registerListener(this, rotation, SensorManager.SENSOR_DELAY_GAME)
        // Only for its accuracy (onAccuracyChanged), which says when the compass needs calibrating.
        sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)?.let {
            sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }
    }

    /**
     * The phone's orientation for sky view and the dish aligner, as a device-to-world rotation (east,
     * north, up, with north magnetic north; the page corrects for declination), and the sensor's own
     * estimate of its heading error.
     */
    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
        val now = SystemClock.uptimeMillis()
        if (now - lastOrientationAt < ORIENTATION_INTERVAL_MS) return
        lastOrientationAt = now
        val device = FloatArray(9)
        SensorManager.getRotationMatrixFromVector(device, event.values)
        // Turn the device's axes to the screen's, so x is right and y up as the user sees it.
        val (x, y) = when (screenRotation()) {
            Surface.ROTATION_90 -> SensorManager.AXIS_Y to SensorManager.AXIS_MINUS_X
            Surface.ROTATION_180 -> SensorManager.AXIS_MINUS_X to SensorManager.AXIS_MINUS_Y
            Surface.ROTATION_270 -> SensorManager.AXIS_MINUS_Y to SensorManager.AXIS_X
            else -> SensorManager.AXIS_X to SensorManager.AXIS_Y
        }
        val screen = FloatArray(9)
        SensorManager.remapCoordinateSystem(device, x, y, screen)
        // values[4], where the sensor gives it, is the estimated heading accuracy in radians.
        val headingError = event.values.getOrNull(4)?.takeIf { it > 0f }?.let { Math.toDegrees(it.toDouble()) } ?: -1.0
        runJs("globe.setOrientation([${screen.joinToString(",")}], $headingError)")
    }

    /** SensorManager.SENSOR_STATUS_*: 0 unreliable to 3 high; the page asks for a figure 8 when low. */
    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        if (sensor.type == Sensor.TYPE_MAGNETIC_FIELD && pageReady) runJs("globe.setCompassStatus($accuracy)")
    }

    /** Surface.ROTATION_*; Context.getDisplay() only exists from Android 11. */
    private fun screenRotation(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: Surface.ROTATION_0
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.rotation
        }

    /** Calls from the page. They arrive on a WebView thread, so each moves to the main thread. */
    private inner class Bridge {
        /** Whether the page has a panel open that the back button should close. */
        @JavascriptInterface
        fun setOverlayOpen(open: Boolean) = runOnUiThread { closePanel.isEnabled = open }

        /** Hides the column of map buttons while a full-screen page panel (the dish aligner) is open. */
        @JavascriptInterface
        fun setMapButtonsHidden(hidden: Boolean) = runOnUiThread {
            findViewById<View>(R.id.map_controls).visibility = if (hidden) View.GONE else View.VISIBLE
        }

        /** Whether the page wants the phone's orientation (sky view or the dish aligner is open). */
        @JavascriptInterface
        fun setOrientationUpdates(on: Boolean) = runOnUiThread {
            orientationWanted = on
            if (on) startOrientation() else sensors.unregisterListener(this@MainActivity)
        }

        /** Passes from passes.js (visible ISS passes and starred satellites' passes), for PassAlerts. */
        @JavascriptInterface
        fun setPassAlerts(json: String) = runOnUiThread { PassAlerts.update(this@MainActivity, json) }

        /** The catalogue numbers of the starred satellites, as a JSON array. */
        @JavascriptInterface
        fun setFavourites(json: String) = runOnUiThread {
            val array = JSONArray(json)
            settings.favourites = (0 until array.length()).map(array::getInt).toSet()
        }

        /** The user's compass calibration, in degrees added to headings. */
        @JavascriptInterface
        fun setCompassOffset(degrees: Double) = runOnUiThread {
            settings.compassOffset = degrees.toFloat()
            pushCompass()
        }

        /**
         * Fetches the close approaches (a large download, so only when asked) and tells the page
         * through globe.conjunctionsLoaded() whether /data/conjunctions.json now has them.
         */
        @JavascriptInterface
        fun loadConjunctions() = runOnUiThread {
            val shown = shownElementSets.mapTo(HashSet()) { it.noradId }
            val starred = settings.favourites
            lifecycleScope.launch {
                val data = withContext(Dispatchers.IO) { conjunctions.load(shown, starred) }
                conjunctionData = data
                runJs("globe.conjunctionsLoaded(${data != null})")
            }
        }
    }

    private companion object {
        const val TAG = "MainActivity"
        /** The provider name of a Location made from one set by hand. */
        const val MANUAL_PROVIDER = "manual"
        /** How long finished downloads stay on screen. */
        const val DOWNLOADS_LINGER_MS = 2500L
        /** Waiting downloads named in the queue line; the rest are counted. */
        const val QUEUE_NAMES_SHOWN = 3
        /** Sky view gets the phone's orientation at most this often (about 30 times a second). */
        const val ORIENTATION_INTERVAL_MS = 33L
    }
}
