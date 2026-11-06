package dev.whatsup.app

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray

/**
 * Notifications shortly before passes: visible ISS passes, and every pass of a starred satellite,
 * each kind turned on in settings. The page works out the passes (passes.js) and hands them all over
 * each time the app opens; they are kept here and the kinds turned on are set as alarms. Alarms don't
 * survive a reboot and only cover the days the page predicted, so alerts stop if the app isn't
 * opened for a few days.
 *
 * These are inexact alarms (no special permission needed), so in deep sleep a notification can come
 * a few minutes late; hence the five minutes' warning.
 */
object PassAlerts {
    private const val CHANNEL = "passes"
    private const val PREFS = "passAlerts"
    private const val KEY_PASSES = "passes"
    /** Alarms are request codes 0 until this; more passes than this are dropped. */
    private const val MAX_ALARMS = 40
    const val KIND_ISS = "iss"
    const val KIND_FAVOURITE = "favourite"
    /** Alerts this close together for the same satellite are the same pass. */
    private const val SAME_PASS_MS = 20 * 60 * 1000L
    const val WARNING_MS = 5 * 60 * 1000L

    /** Keeps the passes (passes.js's alert list, as JSON) and sets alarms for them if alerts are on. */
    fun update(context: Context, passesJson: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_PASSES, passesJson).apply()
        reschedule(context)
    }

    /** Sets alarms for the kept passes when alerts are on, and cancels them all when off. */
    fun reschedule(context: Context) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        for (i in 0 until MAX_ALARMS) {
            // Look up only (no FLAG_UPDATE_CURRENT, which would also replace a set alarm's extras).
            PendingIntent.getBroadcast(
                context, i, Intent(context, PassAlertReceiver::class.java),
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
            )?.let {
                alarms.cancel(it)
                it.cancel()
            }
        }
        val settings = Settings(context)
        val kinds = buildSet {
            if (settings.passAlerts) add(KIND_ISS)
            if (settings.favouriteAlerts) add(KIND_FAVOURITE)
        }
        if (kinds.isEmpty()) return
        val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PASSES, null) ?: return
        val array = JSONArray(json)
        val now = System.currentTimeMillis()
        // Soonest first, so the alarms there are room for go to the nearest passes.
        val wanted = (0 until array.length()).map { array.getJSONObject(it) }
            .filter { it.optString("kind", KIND_ISS) in kinds && it.getLong("rise") - WARNING_MS > now }
        // A starred ISS has its passes twice; its visible ones already have an alert.
        val visibleIss = wanted.filter { it.optString("kind", KIND_ISS) == KIND_ISS }
        val passes = wanted
            .filterNot { pass ->
                pass.optString("kind") == KIND_FAVOURITE && visibleIss.any {
                    it.getString("name") == pass.getString("name") &&
                        kotlin.math.abs(it.getLong("rise") - pass.getLong("rise")) < SAME_PASS_MS
                }
            }
            .sortedBy { it.getLong("rise") }
            .take(MAX_ALARMS)
        passes.forEachIndexed { alarm, pass ->
            val at = pass.getLong("rise") - WARNING_MS
            val intent = Intent(context, PassAlertReceiver::class.java)
                .putExtra(EXTRA_KIND, pass.optString("kind", KIND_ISS))
                .putExtra(EXTRA_NAME, pass.getString("name"))
                .putExtra(EXTRA_RISE_DIRECTION, pass.getString("riseDirection"))
                .putExtra(EXTRA_PEAK_ELEVATION, pass.getInt("peakElevation"))
                .putExtra(EXTRA_SET_DIRECTION, pass.getString("setDirection"))
            val pending = PendingIntent.getBroadcast(
                context, alarm, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
        }
    }

    fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    internal fun notify(context: Context, intent: Intent) {
        if (!canNotify(context)) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.pass_channel), NotificationManager.IMPORTANCE_HIGH)
                .apply { description = context.getString(R.string.pass_channel_description) },
        )
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val visible = intent.getStringExtra(EXTRA_KIND) != KIND_FAVOURITE
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(
                context.getString(
                    if (visible) R.string.pass_alert_title else R.string.favourite_alert_title,
                    intent.getStringExtra(EXTRA_NAME),
                ),
            )
            .setContentText(
                context.getString(
                    if (visible) R.string.pass_alert_text else R.string.favourite_alert_text,
                    intent.getStringExtra(EXTRA_RISE_DIRECTION),
                    intent.getIntExtra(EXTRA_PEAK_ELEVATION, 0),
                    intent.getStringExtra(EXTRA_SET_DIRECTION),
                ),
            )
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(System.currentTimeMillis().toInt(), notification)
    }

    const val EXTRA_KIND = "kind"
    const val EXTRA_NAME = "name"
    const val EXTRA_RISE_DIRECTION = "riseDirection"
    const val EXTRA_PEAK_ELEVATION = "peakElevation"
    const val EXTRA_SET_DIRECTION = "setDirection"
}

class PassAlertReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = PassAlerts.notify(context, intent)
}
