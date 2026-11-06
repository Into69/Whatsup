package dev.whatsup.app

import android.content.Context
import android.location.Address
import android.location.Geocoder
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/** A location found from what the user typed: where it is, a name for it, and how it was read. */
data class Place(val position: LatLon, val label: String, val source: Source) {
    enum class Source { COORDINATES, MGRS, ADDRESS }
}

/**
 * Turns what the user typed into a place: latitude and longitude, MGRS, or else an address looked up
 * with the platform Geocoder (Google's on most phones; it needs a connection, and no API key).
 */
object Places {
    private const val TAG = "Places"
    /** How long typed coordinates wait for a place name before going without one. */
    private const val NAME_TIMEOUT_MS = 3_000L

    /** The place, or null if the text is neither coordinates nor an address the Geocoder knows. */
    suspend fun find(context: Context, text: String): Place? {
        val query = text.trim()
        if (query.isEmpty()) return null
        // Typed coordinates need no network; a name for them is only a nicety, so not waited on long.
        suspend fun named(position: LatLon) = withTimeoutOrNull(NAME_TIMEOUT_MS) { nameFor(context, position) }
        Coordinates.parseLatLon(query)?.let { return Place(it, named(it) ?: it.format(), Place.Source.COORDINATES) }
        Coordinates.parseMgrs(query)?.let { return Place(it, named(it) ?: it.format(), Place.Source.MGRS) }
        val address = lookUp(context) { geocoder, done ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                geocoder.getFromLocationName(query, 1, listener(done))
            } else {
                @Suppress("DEPRECATION")
                done(geocoder.getFromLocationName(query, 1))
            }
        } ?: return null
        return Place(LatLon(address.latitude, address.longitude), describe(address), Place.Source.ADDRESS)
    }

    /** A short name for a position ("Edmonton, Alberta"), if the Geocoder has one. */
    private suspend fun nameFor(context: Context, position: LatLon): String? = lookUp(context) { geocoder, done ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            geocoder.getFromLocation(position.lat, position.lon, 1, listener(done))
        } else {
            @Suppress("DEPRECATION")
            done(geocoder.getFromLocation(position.lat, position.lon, 1))
        }
    }?.let { address ->
        listOfNotNull(address.locality ?: address.subAdminArea, address.adminArea, address.countryName)
            .distinct().joinToString(", ").ifEmpty { null }
    }

    private fun describe(address: Address): String =
        address.getAddressLine(0)
            ?: listOfNotNull(address.featureName, address.locality, address.adminArea, address.countryName).distinct().joinToString(", ")

    /** Runs a Geocoder request off the main thread; null if there is no Geocoder, no answer or an error. */
    private suspend fun lookUp(
        context: Context,
        request: (Geocoder, (List<Address>?) -> Unit) -> Unit,
    ): Address? = withContext(Dispatchers.IO) {
        if (Http.offline || !Geocoder.isPresent()) return@withContext null
        try {
            suspendCancellableCoroutine { continuation ->
                request(Geocoder(context)) { addresses ->
                    if (continuation.isActive) continuation.resume(addresses?.firstOrNull())
                }
            }
        } catch (e: CancellationException) {
            // Not a failure: the lookup was given up (timed out, or the screen closed).
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Geocoder failed", e)
            null
        }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun listener(done: (List<Address>?) -> Unit) = object : Geocoder.GeocodeListener {
        override fun onGeocode(addresses: MutableList<Address>) = done(addresses)
        override fun onError(errorMessage: String?) {
            Log.w(TAG, "Geocoder: $errorMessage")
            done(null)
        }
    }
}
