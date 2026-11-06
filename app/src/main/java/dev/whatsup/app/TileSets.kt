package dev.whatsup.app

import org.json.JSONArray
import org.json.JSONObject

/** A raster tile source the globe can draw. Every one listed here needs no API key. */
data class TileSet(
    val id: String,
    val name: String,
    val description: String,
    val urls: List<String>,
    val attribution: String,
    val maxZoom: Int,
    val tileSize: Int = 256,
) {
    /** The shape globe.js's setTiles() takes. */
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("tiles", JSONArray(urls))
        .put("attribution", attribution)
        .put("maxzoom", maxZoom)
        .put("tileSize", tileSize)
}

object TileSets {
    val all = listOf(
        TileSet(
            id = "esri-imagery",
            name = "Satellite",
            description = "Esri World Imagery",
            urls = listOf("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"),
            attribution = "Imagery &copy; Esri, Maxar, Earthstar Geographics",
            maxZoom = 19,
        ),
        TileSet(
            id = "osm",
            name = "OpenStreetMap",
            description = "Standard OSM street map",
            urls = listOf("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
            attribution = "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
            maxZoom = 19,
        ),
        TileSet(
            id = "opentopomap",
            name = "Topographic",
            description = "OpenTopoMap contours and relief",
            urls = listOf("https://tile.opentopomap.org/{z}/{x}/{y}.png"),
            attribution = "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)",
            maxZoom = 17,
        ),
        TileSet(
            id = "esri-street",
            name = "Esri Streets",
            description = "Esri World Street Map",
            urls = listOf("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"),
            attribution = "&copy; Esri",
            maxZoom = 19,
        ),
        // Google's own tile servers, by the user's choice. Google's terms only allow its maps through
        // its paid Maps APIs, so these may be blocked at any time, and shouldn't ship in a published app.
        googleTileSet("google-hybrid", "Google Hybrid", "Google satellite imagery with roads and labels", "y"),
        googleTileSet("google-roads", "Google Roads", "Google road map", "m"),
        googleTileSet("google-terrain", "Google Terrain", "Google terrain and relief", "p"),
    )

    val default = all.first()

    /** A Google map layer (lyrs=): its four servers mt0 to mt3 share the load. */
    private fun googleTileSet(id: String, name: String, description: String, layer: String) = TileSet(
        id = id,
        name = name,
        description = description,
        urls = (0..3).map { "https://mt$it.google.com/vt/lyrs=$layer&x={x}&y={y}&z={z}" },
        attribution = "Map data &copy; Google",
        maxZoom = 20,
    )

    /** A saved choice that is no longer offered (such as the CARTO maps, since dropped) falls back to the default. */
    fun byId(id: String?): TileSet = all.firstOrNull { it.id == id } ?: default
}
