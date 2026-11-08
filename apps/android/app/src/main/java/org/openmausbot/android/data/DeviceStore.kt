package org.openmausbot.android.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/** Saved pairing trust. The device token is a revocable bearer credential and
 *  lives in app-private storage, never in the transcript or in a backup. */
class DeviceStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("openmausbot", Context.MODE_PRIVATE)

    var computers: List<PairedComputer>
        get() = readComputers()
        private set(value) = writeComputers(value)

    var selectedId: String?
        get() = prefs.getString(KEY_SELECTED, null)
        set(value) {
            prefs.edit().putString(KEY_SELECTED, value).apply()
        }

    var notifyWhileClosed: Boolean
        get() = prefs.getBoolean(KEY_NOTIFY, true)
        set(value) {
            prefs.edit().putBoolean(KEY_NOTIFY, value).apply()
        }

    var speakReplies: Boolean
        get() = prefs.getBoolean(KEY_SPEAK, false)
        set(value) {
            prefs.edit().putBoolean(KEY_SPEAK, value).apply()
        }

    var darkTheme: Boolean?
        get() = if (prefs.contains(KEY_DARK)) prefs.getBoolean(KEY_DARK, true) else null
        set(value) {
            prefs.edit().apply {
                if (value == null) remove(KEY_DARK) else putBoolean(KEY_DARK, value)
            }.apply()
        }

    fun upsert(computer: PairedComputer) {
        val next = readComputers().filterNot { it.id == computer.id } + computer
        writeComputers(next)
    }

    fun remove(id: String) {
        writeComputers(readComputers().filterNot { it.id == id })
        if (selectedId == id) selectedId = null
    }

    fun cursor(id: String, cursor: String?) {
        val current = readComputers().firstOrNull { it.id == id } ?: return
        writeComputers(
            readComputers().map { if (it.id == id) current.copy(lastCursor = cursor) else it }
        )
    }

    private fun readComputers(): List<PairedComputer> {
        val raw = prefs.getString(KEY_COMPUTERS, null) ?: return emptyList()
        return runCatching {
            JSONArray(raw).let { array ->
                (0 until array.length()).mapNotNull { index ->
                    val json = array.optJSONObject(index) ?: return@mapNotNull null
                    val base = json.optString("baseUrl").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    val token = json.optString("token").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    PairedComputer(
                        id = json.optString("id", base),
                        serverName = json.optString("serverName", PairingInvite.hostOf(base)),
                        baseUrl = base,
                        token = token,
                        endpoints = json.optJSONArray("endpoints")?.let { endpoints ->
                            (0 until endpoints.length()).mapNotNull { endpoints.optString(it).takeIf(String::isNotBlank) }
                        } ?: emptyList(),
                        lastCursor = json.optString("lastCursor").takeIf { it.isNotBlank() },
                        lastUsedAt = json.optLong("lastUsedAt"),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun writeComputers(computers: List<PairedComputer>) {
        val array = JSONArray()
        computers.forEach { computer ->
            array.put(
                JSONObject().apply {
                    put("id", computer.id)
                    put("serverName", computer.serverName)
                    put("baseUrl", computer.baseUrl)
                    put("token", computer.token)
                    put("endpoints", JSONArray(computer.endpoints))
                    put("lastCursor", computer.lastCursor ?: "")
                    put("lastUsedAt", computer.lastUsedAt)
                }
            )
        }
        prefs.edit().putString(KEY_COMPUTERS, array.toString()).apply()
    }

    private companion object {
        const val KEY_COMPUTERS = "computers"
        const val KEY_SELECTED = "selectedComputer"
        const val KEY_NOTIFY = "notifyWhileClosed"
        const val KEY_SPEAK = "speakReplies"
        const val KEY_DARK = "darkTheme"
    }
}
