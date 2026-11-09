package dev.whatsup.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.DataInputStream
import java.util.zip.GZIPInputStream
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/** Skyline.compute against made-up terrain whose skyline is known, and sampling real tiles. */
class SkylineTest {
    private fun metresBetween(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = Math.PI / 180
        val a = sin((lat2 - lat1) * r / 2).let { it * it } + cos(lat1 * r) * cos(lat2 * r) * sin((lon2 - lon1) * r / 2).let { it * it }
        return 2 * 6_371_000.0 * asin(sqrt(a))
    }

    @Test
    fun flatGroundDipsJustBelowTheHorizontal() {
        val profile = Skyline.compute(53.5, -113.5) { _, _, _ -> 0.0 }!!
        // An eye 1.7 m up sees the ground meet the sky sqrt(2h(1 - k)/R) below the horizontal.
        val dip = -Math.toDegrees(sqrt(2 * Skyline.EYE_HEIGHT_M * 0.87 / 6_371_000.0))
        val angles = profile.getJSONArray("angles")
        assertEquals((360 / Skyline.STEP_DEGREES).toInt(), angles.length())
        for (i in 0 until angles.length()) assertEquals(dip, angles.getDouble(i), 0.01)
    }

    @Test
    fun aHillToTheNorth() {
        // A 3,000 m hill 20 km across at its foot, 50 km due north; flat everywhere else.
        val peakLat = 53.5 + 50_000 / 111_195.0
        val profile = Skyline.compute(53.5, -113.5) { lat, lon, _ ->
            max(0.0, 3000 * (1 - metresBetween(lat, lon, peakLat, -113.5) / 20_000))
        }!!
        val drop = 50_000.0 * 50_000.0 * 0.87 / (2 * 6_371_000.0)
        val expected = Math.toDegrees(atan((3000 - Skyline.EYE_HEIGHT_M - drop) / 50_000))
        assertEquals(expected, profile.getJSONArray("angles").getDouble(0), 0.1)
        assertEquals(50.0, profile.getJSONArray("distancesKm").getDouble(0), 1.0)
        // Due south, nothing but the flat.
        val south = (180 / Skyline.STEP_DEGREES).toInt()
        assertEquals(0.0, profile.getJSONArray("angles").getDouble(south), 0.05)
    }

    /**
     * Real terrarium tiles (zoom 12) in the test resources, as the ARGB pixels Bitmap.getPixels
     * gives (big-endian ints, gzipped; there is no PNG decoder in unit tests).
     */
    private fun realTile(z: Int, x: Int, y: Int): ShortArray? {
        val stream = javaClass.classLoader!!.getResourceAsStream("terrarium-$z-$x-$y.argb.gz") ?: return null
        val pixels = DataInputStream(GZIPInputStream(stream)).use { input -> IntArray(256 * 256) { input.readInt() } }
        return Skyline.terrarium(pixels)
    }

    @Test
    fun realTerrain() {
        // Banff's town centre is 1,383 m up; Everest's summit, 8,849 m, a little lower in data this coarse.
        assertEquals(1383.0, Skyline.sample(51.1784, -115.5708, 12, ::realTile)!!, 30.0)
        assertEquals(8780.0, Skyline.sample(27.9881, 86.9250, 12, ::realTile)!!, 120.0)
        // A tile that isn't there.
        assertNull(Skyline.sample(0.0, 0.0, 12, ::realTile))
    }

    @Test
    fun noGroundHereNoSkyline() {
        assertNull(Skyline.compute(0.0, 0.0) { _, _, _ -> null })
    }
}
