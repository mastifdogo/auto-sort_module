package app.ledger.importer

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import androidx.annotation.RequiresApi
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Which Wi-Fi the phone is on, to send receipts by themselves only on the
 * Wi-Fi the server is on. Android gives a Wi-Fi's name only to apps allowed
 * to use the phone's location, with Location turned on; while the app is
 * closed, only when that is allowed "all the time".
 */
object Wifi {
    /** Is the phone connected to a Wi-Fi network at all? */
    fun connected(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        @Suppress("DEPRECATION")
        return cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
    }

    fun mayReadName(context: Context) =
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    fun mayReadNameWhenClosed(context: Context) =
        Build.VERSION.SDK_INT < 29 || context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED

    /**
     * The name of the Wi-Fi the phone is on, or "" when it is on none or
     * Android won't say. Waits up to two seconds: not for the main thread.
     */
    fun name(context: Context): String {
        if (!mayReadName(context)) return ""
        var name = ""
        try {
            if (Build.VERSION.SDK_INT >= 31) name = fromNetwork(context)
            if (name.isEmpty()) {
                val wm = context.applicationContext.getSystemService(WifiManager::class.java)
                @Suppress("DEPRECATION")
                name = clean(wm?.connectionInfo?.ssid)
            }
        } catch (e: Exception) {
            // not allowed after all
        }
        return name
    }

    /**
     * May receipts be sent by themselves now? Without a home Wi-Fi: always.
     * With one: only on it. When the phone is on a Wi-Fi whose name Android
     * won't give, it is tried anyway: reaching the server settles it.
     */
    fun homeNow(context: Context, home: String): Boolean {
        if (home.isEmpty()) return true
        if (!connected(context)) return false
        val now = name(context)
        return now.isEmpty() || now == home
    }

    // From Android 12 the name comes with the network, to those who ask for it by callback.
    @RequiresApi(31)
    private fun fromNetwork(context: Context): String {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return ""
        val found = CountDownLatch(1)
        var name = ""
        val callback = object : ConnectivityManager.NetworkCallback(FLAG_INCLUDE_LOCATION_INFO) {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val info = caps.transportInfo as? WifiInfo ?: return
                name = clean(info.ssid)
                found.countDown()
            }
        }
        try {
            cm.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), callback)
            found.await(2, TimeUnit.SECONDS)
        } finally {
            try {
                cm.unregisterNetworkCallback(callback)
            } catch (e: Exception) {
                // was never registered
            }
        }
        return name
    }

    private fun clean(ssid: String?): String {
        if (ssid.isNullOrEmpty() || ssid == "<unknown ssid>") return ""
        return if (ssid.length >= 2 && ssid.startsWith("\"") && ssid.endsWith("\"")) ssid.substring(1, ssid.length - 1) else ssid
    }
}
