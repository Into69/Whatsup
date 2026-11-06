package dev.whatsup.app

import android.content.Context
import androidx.annotation.StringRes
import org.json.JSONObject

/** Parts of the globe's drawing the user can turn off. [key] is the name globe.setLayers() takes. */
enum class DisplayLayer(val key: String, @StringRes val title: Int, val shownByDefault: Boolean = true) {
    ORBITS("orbits", R.string.layer_orbits),
    GROUND_TRACKS("groundTracks", R.string.layer_ground_tracks),
    ALTITUDE_LINES("altitudeLines", R.string.layer_altitude_lines),
    FOOTPRINTS("footprints", R.string.layer_footprints),
    PLANES("planes", R.string.layer_planes, shownByDefault = false),
    GEO_BELT("geoBelt", R.string.layer_geo_belt),
    LAUNCHES("launches", R.string.layer_launches),
    MY_LOCATION("myLocation", R.string.layer_my_location),
    DAY_NIGHT("dayNight", R.string.layer_day_night),
    STARS("stars", R.string.layer_stars),
}

/**
 * How SettingsActivity sorts the satellite groups into cards. Separate from SatelliteGroup's own
 * order, which decides which group a satellite in several belongs to.
 */
enum class SatelliteCategory(@StringRes val title: Int, val groups: List<SatelliteGroup>) {
    CREWED(R.string.category_crewed, listOf(SatelliteGroup.ISS, SatelliteGroup.STATIONS)),
    BROADBAND(
        R.string.category_broadband,
        listOf(SatelliteGroup.STARLINK, SatelliteGroup.ONEWEB, SatelliteGroup.AMAZON_LEO, SatelliteGroup.QIANFAN, SatelliteGroup.GUOWANG),
    ),
    COMMUNICATIONS(
        R.string.category_communications,
        listOf(SatelliteGroup.IRIDIUM, SatelliteGroup.GLOBALSTAR, SatelliteGroup.ORBCOMM, SatelliteGroup.OTHER_COMM, SatelliteGroup.X_COMM),
    ),
    EARTH(R.string.category_earth, listOf(SatelliteGroup.WEATHER, SatelliteGroup.PLANET, SatelliteGroup.SPIRE)),
    NAVIGATION(R.string.category_navigation, listOf(SatelliteGroup.GNSS)),
    RADIO(R.string.category_radio, listOf(SatelliteGroup.AMATEUR, SatelliteGroup.SATNOGS)),
    ORBITS(R.string.category_orbits, listOf(SatelliteGroup.GEO, SatelliteGroup.HEO, SatelliteGroup.MEO, SatelliteGroup.LEO)),
    TRACKING(R.string.category_tracking, listOf(SatelliteGroup.RECENT, SatelliteGroup.GPZ, SatelliteGroup.DEBRIS)),
    ;

    companion object {
        init {
            // Every group needs a card, once, or it could never be switched on or off.
            check(entries.flatMap { it.groups }.sorted() == SatelliteGroup.entries.sorted()) {
                "Each SatelliteGroup must be in exactly one SatelliteCategory"
            }
        }
    }
}

/** The user's choices, kept in SharedPreferences. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var tileSet: TileSet
        get() = TileSets.byId(prefs.getString(KEY_TILE_SET, null))
        set(value) = prefs.edit().putString(KEY_TILE_SET, value.id).apply()

    fun isShown(group: SatelliteGroup): Boolean = prefs.getBoolean(KEY_GROUP_PREFIX + group.key, group.shownByDefault)

    fun setShown(group: SatelliteGroup, shown: Boolean) =
        prefs.edit().putBoolean(KEY_GROUP_PREFIX + group.key, shown).apply()

    val shownGroups: List<SatelliteGroup>
        get() = SatelliteGroup.entries.filter(::isShown)

    fun isShown(layer: DisplayLayer): Boolean = prefs.getBoolean(KEY_LAYER_PREFIX + layer.key, layer.shownByDefault)

    fun setShown(layer: DisplayLayer, shown: Boolean) =
        prefs.edit().putBoolean(KEY_LAYER_PREFIX + layer.key, shown).apply()

    /** Notify of visible ISS passes; see PassAlerts. */
    var passAlerts: Boolean
        get() = prefs.getBoolean(KEY_PASS_ALERTS, false)
        set(value) = prefs.edit().putBoolean(KEY_PASS_ALERTS, value).apply()

    /** Notify of every pass of a starred satellite; see PassAlerts. */
    var favouriteAlerts: Boolean
        get() = prefs.getBoolean(KEY_FAVOURITE_ALERTS, false)
        set(value) = prefs.edit().putBoolean(KEY_FAVOURITE_ALERTS, value).apply()

    /** Catalogue numbers of the satellites the user has starred. */
    var favourites: Set<Int>
        get() = prefs.getString(KEY_FAVOURITES, "").orEmpty().split(',').mapNotNull { it.toIntOrNull() }.toSet()
        set(value) = prefs.edit().putString(KEY_FAVOURITES, value.joinToString(",")).apply()

    /**
     * Degrees added to compass headings, set by calibrating in the dish aligner (on top of the
     * magnetic declination, which is worked out from the location).
     */
    var compassOffset: Float
        get() = prefs.getFloat(KEY_COMPASS_OFFSET, 0f)
        set(value) = prefs.edit().putFloat(KEY_COMPASS_OFFSET, value).apply()

    /** The shape globe.setLayers() takes: each layer's key to whether it is shown. */
    fun layersJson(): JSONObject = JSONObject().apply {
        for (layer in DisplayLayer.entries) put(layer.key, isShown(layer))
    }

    private companion object {
        const val KEY_TILE_SET = "tileSet"
        const val KEY_GROUP_PREFIX = "showGroup."
        const val KEY_LAYER_PREFIX = "showLayer."
        const val KEY_PASS_ALERTS = "passAlerts"
        const val KEY_FAVOURITE_ALERTS = "favouriteAlerts"
        const val KEY_FAVOURITES = "favourites"
        const val KEY_COMPASS_OFFSET = "compassOffset"
    }
}
