package dev.whatsup.app

import org.json.JSONArray
import org.json.JSONObject

/** A raster tile source the globe can draw. Every one listed here is free and needs no API key. */
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
        TileSet(
            id = "carto-dark",
            name = "Dark",
            description = "CARTO Dark Matter",
            urls = listOf("a", "b", "c", "d").map { "https://$it.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png" },
            attribution = "&copy; OpenStreetMap contributors &copy; CARTO",
            maxZoom = 20,
        ),
        TileSet(
            id = "carto-light",
            name = "Light",
            description = "CARTO Positron",
            urls = listOf("a", "b", "c", "d").map { "https://$it.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png" },
            attribution = "&copy; OpenStreetMap contributors &copy; CARTO",
            maxZoom = 20,
        ),
    )

    val default = all.first()

    fun byId(id: String?): TileSet = all.firstOrNull { it.id == id } ?: default
}
