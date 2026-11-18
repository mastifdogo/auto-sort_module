package app.ledger.importer

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The app updates itself from the Auto sort module's releases on GitHub
 * (BuildConfig.RELEASES_REPO; until app 0.21.1 it was the Import module's,
 * which is merged into Auto sort). Every release carries the app, signed with
 * the same key, so Android accepts it over the installed one. The app has its
 * own version, apart from the module's: the release workflow writes it in the
 * label of the app's file ("Ledger Import app 0.22.0"), and that is what is
 * compared with the installed app. The first update asks once; after that
 * Android 12 and newer install updates without asking.
 */
object Updater {
    data class Release(val version: String, val url: String)

    /** The newest release that has the app, or null if there is none to be found. */
    fun latest(): Release? {
        val c = URL("https://api.github.com/repos/${BuildConfig.RELEASES_REPO}/releases/latest").openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 10_000
            c.readTimeout = 20_000
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("User-Agent", "ledger-import-app")
            if (c.responseCode != 200) return null
            val o = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val assets = o.getJSONArray("assets")
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.getString("name") == BuildConfig.APK_NAME) return Release(appVersionOf(a.optString("label", "")) ?: "0.0.0", a.getString("browser_download_url"))
            }
            return null
        } finally {
            c.disconnect()
        }
    }

    /** The app's version in a release file's label ("Ledger Import app 0.22.0"), or null when it doesn't say. */
    fun appVersionOf(label: String): String? = Regex("""(\d+\.\d+\.\d+)""").find(label)?.value

    /** Whether version (x.y.z) is newer than this app. */
    fun isNewer(version: String): Boolean {
        val a = version.split(".").map { it.toIntOrNull() ?: 0 }
        val b = BuildConfig.VERSION_NAME.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** Downloads the release's app and hands it to Android to install over this one. */
    fun install(context: Context, release: Release) {
        val apk = File(context.cacheDir, "update.apk")
        val c = URL(release.url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 15_000
            c.readTimeout = 60_000
            c.setRequestProperty("User-Agent", "ledger-import-app")
            if (c.responseCode != 200) throw java.io.IOException("the download answered ${c.responseCode}")
            c.inputStream.use { input -> apk.outputStream().use { input.copyTo(it) } }
        } finally {
            c.disconnect()
        }
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("ledger-import", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            val done = PendingIntent.getBroadcast(context, sessionId, Intent(context, InstallReceiver::class.java).setPackage(context.packageName), flags)
            session.commit(done.intentSender)
        }
        apk.delete()
    }

    /** At most once a day, in the background: install a newer app if there is one. */
    fun checkQuietly(context: Context) {
        val prefs = Prefs(context)
        val now = System.currentTimeMillis()
        if (now - prefs.lastUpdateCheck < 24L * 3600 * 1000) return
        prefs.lastUpdateCheck = now
        val release = latest() ?: return
        if (isNewer(release.version)) install(context, release)
    }
}

/** Hears from Android how an update went; when Android wants the person to confirm, it asks them. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) != PackageInstaller.STATUS_PENDING_USER_ACTION) return
        @Suppress("DEPRECATION")
        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(confirm) // works while the app is open
        } catch (e: Exception) {
            // in the background: the notification below is the way in
        }
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("updates", "App updates", NotificationManager.IMPORTANCE_DEFAULT))
        val tap = PendingIntent.getActivity(context, 1, confirm, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        try {
            nm.notify(
                1,
                NotificationCompat.Builder(context, "updates")
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("Ledger Import has an update")
                    .setContentText("Tap to install it.")
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build(),
            )
        } catch (e: SecurityException) {
            // notifications aren't allowed: the app offers the update when it is opened
        }
    }
}
