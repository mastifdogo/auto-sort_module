package app.ledger.importer

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.speech.RecognizerIntent
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.ImageView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * After a scan: which organization and account, a note (typed or spoken),
 * and off it goes. Also opened from the list for a receipt that still waits
 * on the phone, to change any of that before it is sent.
 */
class ReceiptActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var note: EditText
    private lateinit var account: Spinner
    private var accounts: List<Account> = emptyList()
    private var shownOrg = -1L

    // The phone's own speech-to-text: what was said is added to the note.
    private val speech = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val said = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
        if (result.resultCode == RESULT_OK && !said.isNullOrEmpty()) {
            val now = note.text.toString().trim()
            note.setText(if (now.isEmpty()) said else "$now $said")
            note.setSelection(note.text.length)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_receipt)
        prefs = Prefs(this)
        val queue = Queue(this)
        val editing = intent.getStringExtra(ITEM)
        val item = editing?.let { queue.get(it) }
        val pdf = if (editing != null) queue.pdf(editing) else File(cacheDir, "scan.pdf")
        if (!pdf.exists() || (editing != null && (item == null || item.sent))) {
            finish()
            return
        }
        val pages = preview(pdf) ?: intent.getIntExtra(PAGES, 1)
        val size = "$pages page${if (pages == 1) "" else "s"} (${pdf.length() / 1024} KB)"
        findViewById<TextView>(R.id.summary).text = if (item == null) "Scanned $size" else "Waiting on this phone: $size"
        if (item != null) title = "Change the receipt"

        // The organization: the one from Settings, unless another is chosen for this receipt.
        val orgs = LedgerClient.orgs(prefs)
        val org = findViewById<Spinner>(R.id.org)
        val startOrg = item?.orgId?.takeIf { id -> id > 0 && orgs.any { it.id == id } } ?: prefs.orgId
        account = findViewById(R.id.account)
        if (orgs.size > 1) {
            findViewById<View>(R.id.org_label).visibility = View.VISIBLE
            org.visibility = View.VISIBLE
            org.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, orgs)
            org.setSelection(orgs.indexOfFirst { it.id == startOrg }.coerceAtLeast(0))
            org.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    if (orgs[position].id != shownOrg) showAccounts(orgs[position].id, prefs.lastAccount, "")
                }

                override fun onNothingSelected(parent: AdapterView<*>?) {}
            }
        }
        showAccounts(startOrg, item?.accountCode ?: prefs.lastAccount, item?.accountName ?: "")

        note = findViewById(R.id.note)
        note.setText(item?.note ?: "")
        val name = findViewById<EditText>(R.id.name)
        name.setText(item?.name ?: "Receipt ${SimpleDateFormat("yyyy-MM-dd HHmm", Locale.US).format(Date())}.pdf")

        findViewById<MaterialButton>(R.id.speak).setOnClickListener {
            val ask = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "Say the note")
            try {
                speech.launch(ask)
            } catch (e: ActivityNotFoundException) {
                toast("This phone has no speech-to-text installed; type the note instead.")
            }
        }

        val save = findViewById<MaterialButton>(R.id.save)
        if (item != null) save.text = "Save changes"
        save.setOnClickListener {
            val chosen = account.selectedItem as Account
            val accountName = if (chosen.code.isEmpty()) "" else chosen.name
            val to = if (orgs.size > 1) org.selectedItem as Org else orgs.firstOrNull()
            var fileName = name.text.toString().trim().replace(Regex("[\\u0000-\\u001f/\\\\]"), "-")
            if (fileName.isEmpty()) fileName = "Receipt.pdf"
            if (!fileName.lowercase(Locale.US).endsWith(".pdf")) fileName += ".pdf"
            val text = note.text.toString().trim()
            if (item == null) {
                queue.add(pdf, fileName, chosen.code, accountName, text, to?.id ?: 0, to?.name ?: "")
                pdf.delete()
                prefs.lastAccount = chosen.code
                toast(
                    when {
                        !prefs.autoSend -> "Saved on this phone. Send it from the list."
                        prefs.homeWifi.isNotEmpty() -> "Saved. It is sent when the phone is on the Wi-Fi \"${prefs.homeWifi}\"."
                        else -> "Saved. It is sent as soon as the server can be reached."
                    },
                )
            } else {
                val problem = queue.change(item.id, fileName, chosen.code, accountName, text, to?.id ?: 0, to?.name ?: "")
                toast(problem.ifEmpty { "Changed." })
            }
            Sender.schedule(this)
            finish()
        }

        val discard = findViewById<MaterialButton>(R.id.discard)
        if (item == null) {
            discard.setOnClickListener {
                pdf.delete()
                finish()
            }
        } else {
            discard.text = "Delete this receipt"
            discard.setOnClickListener {
                AlertDialog.Builder(this).setMessage("Delete this receipt from the phone? It has not been sent.")
                    .setPositiveButton("Delete") { _, _ ->
                        if (!queue.remove(item.id)) toast("This receipt is being sent right now.")
                        finish()
                    }
                    .setNegativeButton("Keep", null).show()
            }
        }
    }

    /**
     * Fills the account list with an organization's accounts and selects one
     * by code. With no list saved for it yet, asks the server.
     */
    private fun showAccounts(org: Long, select: String, selectName: String) {
        shownOrg = org
        val known = LedgerClient.accounts(prefs, org)
        val list = ArrayList<Account>()
        list.add(Account("", "No account (decide in Ledger)", "", ""))
        list.addAll(known)
        // The account a waiting receipt already has stays choosable, even if the saved list no longer has it.
        if (select.isNotEmpty() && selectName.isNotEmpty() && known.none { it.code == select }) list.add(Account(select, selectName, "", ""))
        accounts = list
        account.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, accounts)
        account.setSelection(accounts.indexOfFirst { it.code == select }.coerceAtLeast(0))
        if (known.isEmpty() && prefs.configured) thread {
            try {
                val fresh = LedgerClient(prefs).refreshAccounts(org)
                runOnUiThread { if (shownOrg == org && fresh.isNotEmpty() && !isFinishing) showAccounts(org, select, selectName) }
            } catch (e: Exception) {
                // not connected: the receipt can go without an account
            }
        }
    }

    /** Shows the first page, so it is clear which receipt this is. Returns the number of pages. */
    private fun preview(pdf: File): Int? {
        try {
            ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                PdfRenderer(fd).use { renderer ->
                    if (renderer.pageCount < 1) return null
                    renderer.openPage(0).use { page ->
                        val width = 900
                        val height = (width.toLong() * page.height / page.width).toInt().coerceIn(1, 2400)
                        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        bitmap.eraseColor(Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        val view = findViewById<ImageView>(R.id.preview)
                        view.setImageBitmap(bitmap)
                        view.visibility = View.VISIBLE
                    }
                    return renderer.pageCount
                }
            }
        } catch (e: Exception) {
            return null // no picture, then
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    companion object {
        const val PAGES = "pages"

        /** The id of a waiting receipt to change, instead of a new scan. */
        const val ITEM = "item"
    }
}
