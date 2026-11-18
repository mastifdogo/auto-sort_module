package app.ledger.importer

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One scanned receipt waiting on the phone, or already sent. */
data class QueueItem(
    val id: String,
    val name: String,
    val accountCode: String,
    val accountName: String,
    val note: String,
    val createdAt: Long,
    val sentAt: Long,
    val error: String,
    /** The organization it goes to (0: the one chosen in Settings when it is sent). */
    val orgId: Long = 0,
    val orgName: String = "",
) {
    val sent: Boolean get() = sentAt > 0
}

/**
 * Receipts kept on the phone: each is a PDF and a small file describing it,
 * in the app's own storage. A receipt stays here until the server has taken
 * it; sent ones are remembered for a week, without their PDF.
 */
class Queue(context: Context) {
    // Every method takes LOCK: the screens and the background sender each have their own Queue.
    private val dir = File(context.applicationContext.filesDir, "queue").apply { mkdirs() }

    fun pdf(id: String) = File(dir, "$id.pdf")
    private fun meta(id: String) = File(dir, "$id.json")

    /** Takes a scanned PDF into the queue. */
    fun add(source: File, name: String, accountCode: String, accountName: String, note: String, orgId: Long, orgName: String): QueueItem = synchronized(LOCK) {
        val id = UUID.randomUUID().toString()
        source.copyTo(pdf(id), overwrite = true)
        val item = QueueItem(id, name, accountCode, accountName, note, System.currentTimeMillis(), 0, "", orgId, orgName)
        write(item)
        item
    }

    fun write(item: QueueItem) = synchronized(LOCK) {
        val o = JSONObject()
            .put("id", item.id).put("name", item.name).put("account_code", item.accountCode).put("account_name", item.accountName)
            .put("note", item.note).put("created_at", item.createdAt).put("sent_at", item.sentAt).put("error", item.error)
            .put("org_id", item.orgId).put("org_name", item.orgName)
        val tmp = File(dir, "${item.id}.json.tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(meta(item.id))
        Unit
    }

    private fun read(f: File): QueueItem {
        val o = JSONObject(f.readText())
        return QueueItem(
            o.getString("id"), o.getString("name"), o.optString("account_code"), o.optString("account_name"),
            o.optString("note"), o.getLong("created_at"), o.optLong("sent_at"), o.optString("error"),
            o.optLong("org_id"), o.optString("org_name"),
        )
    }

    /** One receipt as it is now, or null if it is gone. */
    fun get(id: String): QueueItem? = synchronized(LOCK) {
        try {
            if (meta(id).exists()) read(meta(id)) else null
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Changes a receipt that still waits on the phone. Returns why it could
     * not be changed, or "" when it was.
     */
    fun change(id: String, name: String, accountCode: String, accountName: String, note: String, orgId: Long, orgName: String): String = synchronized(LOCK) {
        val item = get(id) ?: return "This receipt is no longer on the phone."
        if (item.sent) return "This receipt has already been sent. Change it in Ledger."
        if (Sender.sending == id) return "This receipt is being sent right now. Change it in Ledger."
        write(item.copy(name = name, accountCode = accountCode, accountName = accountName, note = note, orgId = orgId, orgName = orgName, error = ""))
        ""
    }

    fun all(): List<QueueItem> = synchronized(LOCK) {
        val weekAgo = System.currentTimeMillis() - 7L * 24 * 3600 * 1000
        val out = ArrayList<QueueItem>()
        for (f in dir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()) {
            try {
                val item = read(f)
                if (item.sent && item.sentAt < weekAgo) remove(item.id) else out.add(item)
            } catch (e: Exception) {
                // a half-written file: leave it
            }
        }
        out.sortedByDescending { it.createdAt }
    }

    fun pending(): List<QueueItem> = all().filter { !it.sent && pdf(it.id).exists() }.sortedBy { it.createdAt }

    fun markSent(item: QueueItem) = synchronized(LOCK) {
        write(item.copy(sentAt = System.currentTimeMillis(), error = ""))
        pdf(item.id).delete()
        Unit
    }

    /** Deletes a receipt. A waiting one that is being sent right now stays: returns false. */
    fun remove(id: String): Boolean = synchronized(LOCK) {
        if (Sender.sending == id) return false
        pdf(id).delete()
        meta(id).delete()
        true
    }

    companion object {
        val LOCK = Any()
    }
}
