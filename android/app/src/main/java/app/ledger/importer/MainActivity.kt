package app.ledger.importer

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import java.io.File
import kotlin.concurrent.thread

/** The receipts on this phone, and the way to scan another. */
class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var queue: Queue
    private lateinit var status: TextView
    private lateinit var send: MaterialButton
    private lateinit var update: MaterialButton
    private lateinit var list: ListView
    private lateinit var empty: TextView
    private var items: List<QueueItem> = emptyList()
    private var sending = false

    // The scanner finds the receipt's edges by itself, takes the picture and hands back a PDF.
    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode != RESULT_OK) return@registerForActivityResult
        val pdf = GmsDocumentScanningResult.fromActivityResultIntent(result.data)?.pdf ?: return@registerForActivityResult
        try {
            val scan = File(cacheDir, "scan.pdf")
            contentResolver.openInputStream(pdf.uri)!!.use { input -> scan.outputStream().use { input.copyTo(it) } }
            startActivity(Intent(this, ReceiptActivity::class.java).putExtra(ReceiptActivity.PAGES, pdf.pageCount))
        } catch (e: Exception) {
            toast("Couldn't keep the scan: ${e.message}")
        }
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        queue = Queue(this)
        status = findViewById(R.id.status)
        send = findViewById(R.id.send)
        update = findViewById(R.id.update)
        list = findViewById(R.id.list)
        empty = findViewById(R.id.empty)

        findViewById<MaterialButton>(R.id.scan).setOnClickListener { scan() }
        findViewById<MaterialButton>(R.id.settings).setOnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
        send.setOnClickListener { sendNow() }
        // A waiting receipt opens to be changed; a sent one only says what it was.
        list.setOnItemClickListener { _, _, position, _ ->
            val item = items[position]
            if (item.sent || !queue.pdf(item.id).exists()) describe(item)
            else startActivity(Intent(this, ReceiptActivity::class.java).putExtra(ReceiptActivity.ITEM, item.id))
        }

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (!prefs.configured) startActivity(Intent(this, SettingsActivity::class.java))
        lookForUpdate()
    }

    override fun onResume() {
        super.onResume()
        refresh()
        Sender.schedule(this)
        // The organizations and the list of accounts, fresh for the next receipt, whenever the server can be reached.
        if (prefs.configured) thread {
            try {
                val client = LedgerClient(prefs)
                client.whoAmI()
                client.refreshAccounts()
            } catch (e: Exception) {
                // not connected: the saved list is used
            }
        }
    }

    private fun scan() {
        val options = GmsDocumentScannerOptions.Builder()
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
            .setGalleryImportAllowed(true)
            .setPageLimit(20)
            .build()
        GmsDocumentScanning.getClient(options).getStartScanIntent(this)
            .addOnSuccessListener { sender -> scanLauncher.launch(IntentSenderRequest.Builder(sender).build()) }
            .addOnFailureListener { e -> toast("The scanner couldn't start (it needs Google Play services): ${e.message}") }
    }

    private fun refresh() {
        items = queue.all()
        val waiting = items.count { !it.sent }
        val orgs = LedgerClient.orgs(prefs)
        val severalOrgs = orgs.size > 1
        val who = "${prefs.username} at ${prefs.server}" + (orgs.firstOrNull { it.id == prefs.orgId }?.takeIf { severalOrgs }?.let { ", for ${it.name}" } ?: "")
        status.text = when {
            !prefs.configured -> "Not set up yet: open Settings and enter your Ledger server."
            waiting == 0 -> "$who\nEverything has been sent."
            else -> "$who\n$waiting receipt${if (waiting == 1) "" else "s"} waiting on this phone" + when {
                !prefs.autoSend -> ". Tap one to change it."
                prefs.homeWifi.isNotEmpty() -> "; sent by itself on the Wi-Fi \"${prefs.homeWifi}\". Tap one to change it."
                else -> "; sent by itself when the server can be reached. Tap one to change it."
            }
        }
        send.isEnabled = waiting > 0 && !sending
        send.text = if (sending) "Sending…" else if (waiting > 0) "Send now ($waiting)" else "Send now"
        empty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        list.adapter = object : ArrayAdapter<QueueItem>(this, android.R.layout.simple_list_item_2, android.R.id.text1, items) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val v = super.getView(position, convertView, parent)
                val item = items[position]
                v.findViewById<TextView>(android.R.id.text1).text = (if (item.sent) "✓ " else "⏳ ") + item.name
                val whenText = DateUtils.getRelativeTimeSpanString(if (item.sent) item.sentAt else item.createdAt)
                v.findViewById<TextView>(android.R.id.text2).text = listOf(
                    if (item.sent) "Sent $whenText" else "Waiting since $whenText",
                    item.orgName.takeIf { severalOrgs && it.isNotEmpty() },
                    item.accountCode.takeIf { it.isNotEmpty() }?.let { "$it ${item.accountName}" },
                    item.note.takeIf { it.isNotEmpty() },
                    item.error.takeIf { it.isNotEmpty() }?.let { "Not sent: $it" },
                ).filterNotNull().joinToString(" · ")
                return v
            }
        }
    }

    private fun describe(item: QueueItem) {
        val b = AlertDialog.Builder(this).setTitle(item.name).setMessage(
            listOf(
                if (item.sent) "Sent to Ledger." else "Waiting on this phone.",
                item.orgName.takeIf { it.isNotEmpty() }?.let { "Organization: $it" },
                if (item.accountCode.isEmpty()) "No account chosen." else "Account: ${item.accountCode} ${item.accountName}",
                item.note.takeIf { it.isNotEmpty() }?.let { "Note: $it" },
                item.error.takeIf { it.isNotEmpty() }?.let { "Last try: $it" },
            ).filterNotNull().joinToString("\n\n"),
        ).setPositiveButton("Close", null)
        b.setNegativeButton(if (item.sent) "Remove from list" else "Delete (not sent)") { _, _ ->
            if (!queue.remove(item.id)) toast("This receipt is being sent right now.")
            refresh()
        }
        b.show()
    }

    private fun sendNow() {
        if (sending) return
        sending = true
        refresh()
        thread {
            val (sent, problem) = Sender.sendAll(applicationContext)
            runOnUiThread {
                sending = false
                refresh()
                toast(
                    when {
                        problem.isNotEmpty() && sent > 0 -> "Sent $sent. Then: $problem"
                        problem.isNotEmpty() -> problem
                        else -> "Sent $sent receipt${if (sent == 1) "" else "s"}."
                    },
                )
            }
        }
    }

    /** A newer app is offered at the top; one tap installs it. */
    private fun lookForUpdate() {
        thread {
            try {
                val release = Updater.latest() ?: return@thread
                if (!Updater.isNewer(release.version)) return@thread
                runOnUiThread {
                    update.text = "Update to version ${release.version}"
                    update.visibility = View.VISIBLE
                    update.setOnClickListener {
                        update.isEnabled = false
                        update.text = "Downloading the update…"
                        thread {
                            try {
                                Updater.install(applicationContext, release)
                            } catch (e: Exception) {
                                runOnUiThread {
                                    update.isEnabled = true
                                    update.text = "Update to version ${release.version}"
                                    toast("The update didn't install: ${e.message}")
                                }
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                // not connected
            }
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}
