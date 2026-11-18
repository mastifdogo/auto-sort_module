package app.ledger.importer

import android.os.Build
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** The server answered, but not with what was asked for. */
class ServerException(val status: Int, message: String) : IOException(message)

/** An organization (a set of books) this login can use. */
data class Org(val id: Long, val name: String, val role: String) {
    override fun toString() = name
}

/** An account a receipt can be put under. */
data class Account(val code: String, val name: String, val type: String, val currency: String) {
    override fun toString() = "$code  $name"
}

/**
 * Talks to Ledger: logs in with the saved username and password (again
 * whenever the session has run out), lists the accounts, and uploads a
 * receipt to the inbox of the Auto sort module (which the Import module is part of since Auto sort 0.17.0).
 */
class LedgerClient(private val prefs: Prefs) {

    private fun open(method: String, path: String, body: JSONObject?, withCookie: Boolean): HttpURLConnection {
        if (prefs.server.isEmpty()) throw IOException("Enter the server's address first")
        val c = URL(prefs.server + "/api/v1" + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10_000
        c.readTimeout = 60_000
        c.instanceFollowRedirects = false
        c.setRequestProperty("Accept", "application/json")
        if (withCookie && prefs.cookie.isNotEmpty()) c.setRequestProperty("Cookie", prefs.cookie)
        // Ledger only takes JSON. A POST with nothing to say still sends "{}":
        // left alone, Android marks it as a web form and Ledger refuses it.
        val send = body ?: if (method == "GET") null else JSONObject()
        if (send != null) {
            val bytes = send.toString().toByteArray(Charsets.UTF_8)
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.setFixedLengthStreamingMode(bytes.size)
            c.outputStream.use { it.write(bytes) }
        }
        return c
    }

    private fun read(c: HttpURLConnection): String {
        val status = c.responseCode
        val text = (if (status < 400) c.inputStream else c.errorStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        if (status in 200..299) return text
        val message = try {
            JSONObject(text).getJSONObject("error").getString("message")
        } catch (e: Exception) {
            "the server answered $status"
        }
        throw ServerException(status, message)
    }

    /** Logs in and keeps the session cookie. */
    fun login() {
        val c = open("POST", "/auth/login", JSONObject().put("username", prefs.username).put("password", prefs.password), false)
        try {
            read(c)
            val cookie = c.headerFields.entries
                .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                .flatMap { it.value }
                .firstOrNull { it.startsWith("ledger_session=") }
                ?: throw IOException("the server did not start a session; is this address a Ledger server?")
            prefs.cookie = cookie.substringBefore(';')
            prefs.sessionOrg = 0 // a new session starts in the login's usual organization, whichever that is
        } finally {
            c.disconnect()
        }
    }

    private fun once(method: String, path: String, body: JSONObject?): String {
        val c = open(method, path, body, true)
        try {
            return read(c)
        } finally {
            c.disconnect()
        }
    }

    /** Puts the session in an organization (0: leave it where it is). */
    private fun enter(org: Long) {
        if (org <= 0 || prefs.sessionOrg == org) return
        val me = JSONObject(once("POST", "/auth/organization", JSONObject().put("organization_id", org)))
        prefs.sessionOrg = me.getJSONObject("organization").getLong("id")
    }

    /**
     * One request in an organization's books, logging in first when there is
     * no session or it has run out. One at a time: the session is in one
     * organization at a time, and a receipt must not land in another's inbox.
     */
    private fun call(method: String, path: String, body: JSONObject? = null, org: Long = prefs.orgId): String = synchronized(LOCK) {
        if (prefs.cookie.isEmpty()) login()
        try {
            enter(org)
            return once(method, path, body)
        } catch (e: ServerException) {
            if (e.status != 401) throw e
        }
        login()
        enter(org)
        return once(method, path, body)
    }

    /**
     * Who is logged in, as a sentence for the settings screen. Also keeps the
     * organizations this login can use, and chooses the one receipts go to
     * if none was chosen yet (or the chosen one is no longer there).
     */
    fun whoAmI(): String {
        val me = JSONObject(call("GET", "/auth/me", org = 0))
        val keep = JSONArray()
        val list = me.optJSONArray("organizations") ?: JSONArray()
        for (i in 0 until list.length()) {
            val o = list.getJSONObject(i)
            if (o.optString("status", "ready") != "ready") continue
            keep.put(JSONObject().put("id", o.getLong("id")).put("name", o.getString("name")).put("role", o.optString("role")))
        }
        val now = me.getJSONObject("organization")
        if (keep.length() == 0) keep.put(JSONObject().put("id", now.getLong("id")).put("name", now.getString("name")).put("role", me.optString("role")))
        prefs.orgsJson = keep.toString()
        val known = orgs(prefs)
        if (known.none { it.id == prefs.orgId }) prefs.orgId = (known.firstOrNull { it.id == now.getLong("id") } ?: known.first()).id
        return me.getString("username")
    }

    /** The accounts of an organization a receipt can go under, saved for when there is no connection. */
    fun refreshAccounts(org: Long = prefs.orgId): List<Account> {
        val data = JSONObject(call("GET", "/accounts", org = org)).getJSONArray("data")
        val keep = JSONArray()
        for (i in 0 until data.length()) {
            val a = data.getJSONObject(i)
            if (!a.optBoolean("is_active", true) || a.optBoolean("hidden", false)) continue
            keep.put(JSONObject().put("code", a.getString("code")).put("name", a.getString("name")).put("type", a.getString("type")).put("currency", a.getString("currency")))
        }
        prefs.setAccountsJson(org, keep.toString())
        return accounts(prefs, org)
    }

    /** Sends one receipt to the inbox of its organization's Auto sort module, in pieces the server accepts. */
    fun upload(item: QueueItem, pdf: File) {
        val org = if (item.orgId > 0) item.orgId else prefs.orgId
        val base = "/m/${BuildConfig.MODULE_ID}/inbox"
        val started = JSONObject(
            call(
                "POST", base,
                JSONObject()
                    .put("name", item.name)
                    .put("size", pdf.length())
                    .put("content_type", "application/pdf")
                    .put("origin", "app")
                    .put("note", item.note)
                    .put("account_code", item.accountCode)
                    .put("device", "${Build.MANUFACTURER} ${Build.MODEL}".trim()),
                org,
            ),
        )
        val id = started.getLong("id")
        val chunkSize = started.getInt("chunk_size")
        pdf.inputStream().use { input ->
            val buf = ByteArray(chunkSize)
            var index = 0
            while (true) {
                var n = 0
                while (n < chunkSize) {
                    val r = input.read(buf, n, chunkSize - n)
                    if (r < 0) break
                    n += r
                }
                if (n == 0) break
                call("PUT", "$base/$id/chunks/$index", JSONObject().put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)), org)
                index++
                if (n < chunkSize) break
            }
        }
        call("POST", "$base/$id/complete", null, org)
    }

    companion object {
        private val LOCK = Any()

        /** The organizations this login can use, as the server last listed them. */
        fun orgs(prefs: Prefs): List<Org> {
            val out = ArrayList<Org>()
            try {
                val arr = JSONArray(prefs.orgsJson)
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    out.add(Org(o.getLong("id"), o.getString("name"), o.optString("role")))
                }
            } catch (e: Exception) {
                // nothing saved yet
            }
            return out
        }

        /** An organization's saved accounts: expenses first (where receipts usually go), then the rest by code. */
        fun accounts(prefs: Prefs, org: Long = prefs.orgId): List<Account> {
            val out = ArrayList<Account>()
            try {
                val arr = JSONArray(prefs.accountsJson(org))
                for (i in 0 until arr.length()) {
                    val a = arr.getJSONObject(i)
                    out.add(Account(a.getString("code"), a.getString("name"), a.getString("type"), a.getString("currency")))
                }
            } catch (e: Exception) {
                // nothing saved yet
            }
            return out.sortedWith(compareBy<Account> { if (it.type == "expense") 0 else 1 }.thenBy { it.code })
        }
    }
}
