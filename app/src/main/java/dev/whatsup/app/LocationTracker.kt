package dev.whatsup.app

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper

/**
 * Reports the device's location from GPS and the network provider, through the platform
 * LocationManager so the app needs no Google Play services. Callers must hold a location
 * permission before [start].
 */
class LocationTracker(context: Context, private val onLocation: (Location) -> Unit) : LocationListener {
    private val manager = context.getSystemService(LocationManager::class.java)
    private var running = false

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        running = true
        val providers = PROVIDERS.filter { it in manager.allProviders }
        providers.mapNotNull { manager.getLastKnownLocation(it) }
            .maxByOrNull { it.time }
            ?.let(onLocation)
        for (provider in providers) {
            manager.requestLocationUpdates(provider, MIN_INTERVAL_MS, MIN_DISTANCE_M, this, Looper.getMainLooper())
        }
    }

    fun stop() {
        if (!running) return
        running = false
        manager.removeUpdates(this)
    }

    override fun onLocationChanged(location: Location) = onLocation(location)

    // Pre-Android 11 LocationListener has no default bodies for these.
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}
    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

    private companion object {
        val PROVIDERS = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        const val MIN_INTERVAL_MS = 5_000L
        const val MIN_DISTANCE_M = 10f
    }
}
