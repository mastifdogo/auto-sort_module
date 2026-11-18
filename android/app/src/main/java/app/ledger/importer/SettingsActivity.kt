package app.ledger.importer

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import kotlin.concurrent.thread

/**
 * Where the server is and who logs in; the organization receipts go to;
 * sending by itself, and on which Wi-Fi; the app's version and updates.
 */
class SettingsActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var result: TextView
    private lateinit var wifi: EditText
    private lateinit var wifiHelp: TextView
    private lateinit var wifiAllow: MaterialButton
    private var orgs: List<Org> = emptyList()

    // Android gives a Wi-Fi's name only to apps allowed to use the phone's location.
    private val askLocation = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (Wifi.mayReadName(this)) readWifi() else wifiHelp.text = "Without that permission the app can't read the Wi-Fi's name. You can type it instead."
        showWifi()
    }
    private val askLocationWhenClosed = registerForActivityResult(ActivityResultContracts.RequestPermission()) { showWifi() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        prefs = Prefs(this)
        val server = findViewById<EditText>(R.id.server)
        val username = findViewById<EditText>(R.id.username)
        val password = findViewById<EditText>(R.id.password)
        result = findViewById(R.id.result)
        val save = findViewById<MaterialButton>(R.id.save)
        server.setText(prefs.server)
        username.setText(prefs.username)
        if (prefs.configured) password.hint = "(saved; type to replace)"

        save.setOnClickListener {
            var address = server.text.toString().trim().trimEnd('/')
            if (address.isNotEmpty() && !address.startsWith("http://") && !address.startsWith("https://")) address = "http://$address"
            if (address.isEmpty() || username.text.isBlank() || (password.text.isEmpty() && !prefs.configured)) {
                result.text = "Enter the server's address, your username and your password."
                return@setOnClickListener
            }
            if (address != prefs.server || username.text.toString().trim() != prefs.username) {
                // Another server or person: its organizations are other ones.
                prefs.orgId = 0
                prefs.orgsJson = "[]"
            }
            prefs.server = address
            prefs.username = username.text.toString()
            if (password.text.isNotEmpty()) prefs.password = password.text.toString()
            prefs.cookie = ""
            server.setText(address)
            save.isEnabled = false
            result.text = "Connecting…"
            thread {
                val text = try {
                    val client = LedgerClient(prefs)
                    client.login()
                    val who = client.whoAmI()
                    val n = client.refreshAccounts().size
                    val org = LedgerClient.orgs(prefs).firstOrNull { it.id == prefs.orgId }
                    "Connected as $who. Receipts go to ${org?.name ?: "Ledger"}: $n accounts to choose from." +
                        if (org?.role == "viewer") " You can only view there, so the server will refuse receipts: ask an admin for the bookkeeper role." else ""
                } catch (e: ServerException) {
                    "The server said: ${e.message}"
                } catch (e: Exception) {
                    "Can't reach $address (${e.message ?: e.javaClass.simpleName}). Check the address, and that this phone is on the same network or VPN as the server."
                }
                runOnUiThread {
                    save.isEnabled = true
                    result.text = text
                    showOrgs()
                }
            }
        }
        showOrgs()

        val auto = findViewById<MaterialSwitch>(R.id.auto)
        auto.isChecked = prefs.autoSend
        auto.setOnCheckedChangeListener { _, on ->
            prefs.autoSend = on
            Sender.schedule(this)
        }

        wifi = findViewById(R.id.wifi)
        wifiHelp = findViewById(R.id.wifi_help)
        wifiAllow = findViewById(R.id.wifi_allow)
        wifi.setText(prefs.homeWifi)
        wifi.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                prefs.homeWifi = s?.toString() ?: ""
                showWifi()
            }
        })
        findViewById<MaterialButton>(R.id.wifi_use).setOnClickListener {
            if (Wifi.mayReadName(this)) readWifi() else askForLocation()
        }
        showWifi()

        val version = findViewById<TextView>(R.id.version)
        version.text = "Ledger Import ${BuildConfig.VERSION_NAME}. It updates itself from the Auto sort module's releases."
        val check = findViewById<MaterialButton>(R.id.check)
        check.setOnClickListener {
            check.isEnabled = false
            version.text = "Looking for an update…"
            thread {
                val text = try {
                    val release = Updater.latest()
                    when {
                        release == null -> "Ledger Import ${BuildConfig.VERSION_NAME}. No release with the app was found."
                        !Updater.isNewer(release.version) -> "Ledger Import ${BuildConfig.VERSION_NAME} is the newest."
                        else -> {
                            Updater.install(applicationContext, release)
                            "Installing version ${release.version}… Android may ask you to confirm."
                        }
                    }
                } catch (e: Exception) {
                    "Couldn't check: ${e.message ?: e.javaClass.simpleName}"
                }
                runOnUiThread {
                    check.isEnabled = true
                    check.visibility = View.VISIBLE
                    version.text = text
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        showWifi() // back from Android's permission screens
    }

    override fun onPause() {
        super.onPause()
        Sender.schedule(this) // a changed Wi-Fi counts from now
    }

    /** With more than one organization: which one receipts go to. */
    private fun showOrgs() {
        orgs = LedgerClient.orgs(prefs)
        val label = findViewById<View>(R.id.org_label)
        val org = findViewById<Spinner>(R.id.org)
        val show = if (orgs.size > 1) View.VISIBLE else View.GONE
        label.visibility = show
        org.visibility = show
        if (orgs.size < 2) return
        org.onItemSelectedListener = null
        org.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, orgs)
        org.setSelection(orgs.indexOfFirst { it.id == prefs.orgId }.coerceAtLeast(0), false)
        org.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val chosen = orgs[position]
                if (chosen.id == prefs.orgId) return
                prefs.orgId = chosen.id
                result.text = "Receipts now go to ${chosen.name}."
                thread {
                    val text = try {
                        val n = LedgerClient(prefs).refreshAccounts(chosen.id).size
                        "Receipts now go to ${chosen.name}: $n accounts to choose from." +
                            if (chosen.role == "viewer") " You can only view there, so the server will refuse receipts: ask an admin for the bookkeeper role." else ""
                    } catch (e: Exception) {
                        "Receipts now go to ${chosen.name}. Its accounts are fetched when the server can next be reached."
                    }
                    runOnUiThread { if (prefs.orgId == chosen.id) result.text = text }
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
    }

    private fun askForLocation() {
        askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    /** Fills in the name of the Wi-Fi the phone is on now. */
    private fun readWifi() {
        wifiHelp.text = "Looking…"
        thread {
            val on = Wifi.connected(applicationContext)
            val name = if (on) Wifi.name(applicationContext) else ""
            runOnUiThread {
                if (name.isNotEmpty()) {
                    wifi.setText(name) // saved by the text listener
                } else {
                    wifiHelp.text = if (on) "Android didn't give the Wi-Fi's name: turn Location on and try again, or type the name."
                    else "This phone isn't on Wi-Fi now. Connect to the server's Wi-Fi and try again, or type its name."
                }
            }
        }
    }

    /** Says what the Wi-Fi setting does as it stands, and offers the permission still missing. */
    private fun showWifi() {
        val home = prefs.homeWifi
        wifiAllow.visibility = View.GONE
        when {
            home.isEmpty() -> wifiHelp.text = "Empty: receipts are sent on any connection that reaches the server. With a Wi-Fi's name they are sent by themselves only on that Wi-Fi; Send now always sends."
            !Wifi.mayReadName(this) -> {
                wifiHelp.text = "Receipts are sent by themselves on \"$home\". Android gives a Wi-Fi's name only to apps allowed to use the phone's location; until then the app tries on every Wi-Fi. It never reads where the phone is."
                wifiAllow.text = "Allow reading the Wi-Fi's name"
                wifiAllow.visibility = View.VISIBLE
                wifiAllow.setOnClickListener { askForLocation() }
            }
            !Wifi.mayReadNameWhenClosed(this) -> {
                wifiHelp.text = "Receipts are sent by themselves on \"$home\". While the app is closed Android hides the Wi-Fi's name, so it then tries on every Wi-Fi, unless location is allowed \"all the time\"."
                wifiAllow.text = "Allow while the app is closed"
                wifiAllow.visibility = View.VISIBLE
                wifiAllow.setOnClickListener {
                    if (Build.VERSION.SDK_INT >= 29) askLocationWhenClosed.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                }
            }
            else -> wifiHelp.text = "Receipts are sent by themselves only on \"$home\" (Location must be on for Android to give the Wi-Fi's name). Send now always sends."
        }
    }
}
