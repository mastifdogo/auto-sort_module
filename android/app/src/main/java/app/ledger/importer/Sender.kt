package app.ledger.importer

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Sending what waits in the queue, by hand or by itself when the phone is connected. */
object Sender {
    private val lock = Any()

    /** The receipt being uploaded at this moment ("" for none): it can't be changed or deleted meanwhile. */
    @Volatile
    var sending = ""
        private set

    /**
     * Sends every waiting receipt, oldest first. Returns how many were sent
     * and, if it stopped, why. A receipt the server refuses for good (too
     * large, not allowed) keeps its reason and the rest still go.
     */
    fun sendAll(context: Context): Pair<Int, String> = synchronized(lock) {
        val prefs = Prefs(context)
        if (!prefs.configured) return 0 to "Set up the server first"
        val queue = Queue(context)
        val client = LedgerClient(prefs)
        var sent = 0
        var problem = ""
        for (waiting in queue.pending()) {
            // As it is now: it may have been changed or deleted since the list was read.
            val item = synchronized(Queue.LOCK) {
                val now = queue.get(waiting.id)?.takeIf { !it.sent && queue.pdf(it.id).exists() }
                sending = now?.id ?: ""
                now
            } ?: continue
            try {
                client.upload(item, queue.pdf(item.id))
                queue.markSent(item)
                sent++
            } catch (e: ServerException) {
                queue.write(item.copy(error = e.message ?: "refused"))
                problem = e.message ?: "refused"
                if (e.status == 401 || e.status == 403 || e.status >= 500) break // nothing will get through now
            } catch (e: Exception) {
                problem = "Can't reach the server (${e.message ?: e.javaClass.simpleName})"
                break
            } finally {
                sending = ""
            }
        }
        sent to problem
    }

    /** Asks Android to send the queue as soon as there is a connection, and to look again every so often. */
    fun schedule(context: Context) {
        val wm = WorkManager.getInstance(context)
        if (!Prefs(context).autoSend) {
            wm.cancelUniqueWork(NOW)
            wm.cancelUniqueWork(REGULAR)
            wm.cancelAllWorkByTag(ON_WIFI)
            return
        }
        val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        wm.enqueueUniqueWork(
            NOW, ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<SendWorker>().setConstraints(online).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build(),
        )
        wm.enqueueUniquePeriodicWork(
            REGULAR, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SendWorker>(30, TimeUnit.MINUTES).setConstraints(online).build(),
        )
    }

    /**
     * With a home Wi-Fi set and receipts waiting: looks again a few minutes
     * after the phone is next on Wi-Fi, so they go soon after coming home.
     * Android holds this back while the phone is on mobile data only.
     */
    fun waitForWifi(context: Context): Unit = synchronized(lock) {
        val wm = WorkManager.getInstance(context)
        val waiting = try {
            wm.getWorkInfosByTag(ON_WIFI).get().any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }
        } catch (e: Exception) {
            false
        }
        if (waiting) return
        val wifi = Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build()
        wm.enqueue(OneTimeWorkRequestBuilder<SendWorker>().setConstraints(wifi).setInitialDelay(5, TimeUnit.MINUTES).addTag(ON_WIFI).build())
        Unit
    }

    private const val NOW = "send-now"
    private const val REGULAR = "send-regularly"
    private const val ON_WIFI = "send-on-wifi"
}

class SendWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        val queue = Queue(applicationContext)
        // With a home Wi-Fi set, only on that Wi-Fi ("Send now" sends anywhere).
        if (prefs.autoSend && queue.pending().isNotEmpty() && Wifi.homeNow(applicationContext, prefs.homeWifi)) {
            Sender.sendAll(applicationContext)
        }
        // Once a day, see whether there is a newer app.
        try {
            Updater.checkQuietly(applicationContext)
        } catch (e: Exception) {
            // next time
        }
        if (!prefs.autoSend || queue.pending().isEmpty()) return Result.success()
        if (prefs.homeWifi.isNotEmpty()) {
            Sender.waitForWifi(applicationContext)
            return Result.success()
        }
        // The phone is on a network but the server wasn't reached (away from home): try again later.
        return if (runAttemptCount < 8) Result.retry() else Result.success()
    }
}
