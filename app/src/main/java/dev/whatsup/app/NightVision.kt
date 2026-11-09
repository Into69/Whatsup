package dev.whatsup.app

import android.app.Activity
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.view.View

/**
 * Red night mode: the whole window, the page included, drawn in shades of red by its brightness,
 * as red light leaves the eyes dark-adapted for looking at the sky. Done as a colour filter on the
 * window's layer, so nothing has to know about it. The system bars are the system's and stay as they are.
 */
object NightVision {
    private val RED = ColorMatrixColorFilter(
        ColorMatrix(
            floatArrayOf(
                0.30f, 0.59f, 0.11f, 0f, 0f,
                0f, 0f, 0f, 0f, 0f,
                0f, 0f, 0f, 0f, 0f,
                0f, 0f, 0f, 1f, 0f,
            ),
        ),
    )

    fun apply(activity: Activity, on: Boolean) {
        val window = activity.window.decorView
        if (on) {
            window.setLayerType(View.LAYER_TYPE_HARDWARE, Paint().apply { colorFilter = RED })
        } else {
            window.setLayerType(View.LAYER_TYPE_NONE, null)
        }
    }
}
