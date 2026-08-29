package com.openmausbot.chief.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.util.Base64
import java.util.UUID

val WireJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

@Serializable
data class OptionCard(
    val title: String = "",
    val subtitle: String = "",
    val options: List<String> = emptyList(),
    val answered: String? = null,
    val dismissed: Boolean? = null,
    val requestId: String? = null,
    val tool: String? = null,
    val held: String? = null,
    val allowKey: String? = null,
) {
    val pending: Boolean get() = requestId != null && answered == null && dismissed != true
}

@Serializable
data class Sender(val botId: String = "", val name: String = "", val color: String = "orange")

@Serializable
data class ToolActivity(
    val name: String = "",
    val ok: Boolean? = null,
    val setup: Boolean? = null,
)

@Serializable
data class WorkerBatchCounts(
    val total: Int = 0,
    val queued: Int = 0,
    val running: Int = 0,
    val completed: Int = 0,
    val failed: Int = 0,
    val canceled: Int = 0,
)

@Serializable
data class WorkerBatchJob(
    val id: String = "",
    val label: String = "Worker",
    val status: String = "queued",
)

@Serializable
data class WorkerBatch(
    val id: String = "",
    val taskId: String = "",
    val label: String = "Parallel work",
    val status: String = "queued",
    val terminal: Boolean = false,
    val counts: WorkerBatchCounts = WorkerBatchCounts(),
    val jobs: List<WorkerBatchJob> = emptyList(),
    val createdAt: Double = 0.0,
    val updatedAt: Double = 0.0,
)

@Serializable
data class Message(
    val id: String,
    val role: String = "bot",
    val kind: String = "text",
    val at: Double = 0.0,
    val text: String? = null,
    val card: OptionCard? = null,
    val parentId: String? = null,
    val from: Sender? = null,
    val hasImage: Boolean? = null,
    val png: String? = null,
    val mime: String? = null,
    val tool: ToolActivity? = null,
    val workerBatch: WorkerBatch? = null,
)

@Serializable
data class ModelSelection(val instanceId: String = "", val model: String = "")

@Serializable
data class BotTask(val threadId: String, val title: String = "New task", val createdAt: Double = 0.0)

@Serializable
data class Bot(
    val id: String,
    val threadId: String,
    val name: String,
    val title: String = "",
    val description: String = "",
    val notifications: Boolean = true,
    val reportingMode: String = "all",
    val color: String = "orange",
    val avatarUrl: String? = null,
    val avatarCrop: String? = null,
    val unread: Boolean = false,
    val modelSelection: ModelSelection = ModelSelection(),
    val createdAt: Double = 0.0,
    val busy: Boolean? = null,
    val pinned: Boolean? = null,
    val hidden: Boolean? = null,
    val chiefOfStaff: Boolean? = null,
    val computer: String? = null,
    val cloudBackend: String? = null,
    val tasks: List<BotTask> = emptyList(),
    val messages: List<Message> = emptyList(),
    val activeLeafId: String? = null,
    val hasMore: Boolean? = null,
)

@Serializable
data class GroupResponder(val kind: String = "mentions", val botId: String? = null)

@Serializable
data class Room(
    val id: String,
    val threadId: String,
    val name: String,
    val memberIds: List<String> = emptyList(),
    val defaultResponder: GroupResponder = GroupResponder(),
    val bulletin: String = "",
    val unread: Boolean = false,
    val createdAt: Double = 0.0,
    val dm: Boolean? = null,
    val busyBotId: String? = null,
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean? = null,
)

@Serializable
data class Fleet(val bots: List<Bot> = emptyList(), val groups: List<Room> = emptyList())

@Serializable
data class ThreadPage(val messages: List<Message> = emptyList(), val hasMore: Boolean? = null)

@Serializable
data class RoutineSchedule(
    val type: String,
    val at: Double? = null,
    val time: String? = null,
    val weekdays: List<Int>? = null,
    val intervalMinutes: Int? = null,
)

@Serializable
data class Routine(
    val id: String,
    val name: String,
    val prompt: String,
    val botId: String,
    val runOn: String = "maus",
    val enabled: Boolean,
    val schedule: RoutineSchedule,
    val durationMinutes: Int = 30,
    val nextRunAt: Double? = null,
    val createdAt: Double = 0.0,
    val updatedAt: Double = 0.0,
)

@Serializable
data class RoutineRun(
    val id: String,
    val routineId: String,
    val routineName: String = "",
    val botId: String = "",
    val runOn: String = "maus",
    val scheduledFor: Double = 0.0,
    val status: String = "",
    val manual: Boolean = false,
    val output: String? = null,
    val error: String? = null,
    val startedAt: Double? = null,
    val finishedAt: Double? = null,
)

@Serializable data class RoutinesResponse(val routines: List<Routine> = emptyList(), val runs: List<RoutineRun> = emptyList())
@Serializable data class RoutineResponse(val routine: Routine)
@Serializable data class RoutineRunResponse(val run: RoutineRun)
@Serializable data class BotResponse(val bot: Bot)

@Serializable
data class PairedDevice(val id: String, val name: String, val createdAt: Double = 0.0, val lastSeenAt: Double = 0.0)

@Serializable
data class PairResponse(
    val token: String,
    val device: PairedDevice,
    val serverName: String,
    val hosts: List<String>? = null,
    val endpoints: List<CompanionEndpoint>? = null,
)

@Serializable
data class HealthIdentity(val app: String)

@Serializable
data class CompanionEndpoint(val url: String, val kind: String, val priority: Int) {
    fun validated(): CompanionEndpoint? {
        if (priority !in 0..1_000_000 || kind !in setOf("hosted", "tailnet", "lan", "bonjour")) return null
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        if (uri.userInfo != null || uri.query != null || uri.fragment != null || (uri.path.isNotEmpty() && uri.path != "/")) return null
        val host = uri.host?.trimEnd('.')?.lowercase().orEmpty()
        if (host.isEmpty() || uri.port !in -1..65535) return null
        val valid = when (kind) {
            "hosted" -> uri.scheme.equals("https", true)
            "tailnet" -> uri.scheme.equals("http", true) && host.endsWith(".ts.net")
            else -> uri.scheme.equals("http", true)
        }
        if (!valid) return null
        val port = if (uri.port == -1) null else uri.port
        val origin = URI(uri.scheme.lowercase(), null, host, port ?: -1, null, null, null).toString()
        return copy(url = origin)
    }
}

@Serializable
data class SavedConnection(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val origin: String,
    val endpoints: List<CompanionEndpoint> = emptyList(),
    val allowedKinds: Set<String> = emptySet(),
    val allowedLocalOrigins: Set<String> = emptySet(),
)

data class PairingInvite(val connection: SavedConnection, val credential: String) {
    companion object {
        private val qrToken = Regex("^omb_pair_[A-Za-z0-9_-]{43}$")
        private val code = Regex("^\\d{6}$")
        private const val MAX_INVITE_LENGTH = 16_384

        fun parse(raw: String): PairingInvite? {
            if (raw.length !in 1..MAX_INVITE_LENGTH) return null
            val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
            if (!uri.scheme.equals("openmausbot", true)
                || !uri.host.equals("pair", true)
                || uri.port != -1
                || uri.userInfo != null
                || uri.path.isNotEmpty()
                || uri.fragment != null
            ) return null
            val values = linkedMapOf<String, String>()
            val query = uri.rawQuery ?: return null
            val decoded = runCatching {
                query.split('&').map { part ->
                    val pair = part.split('=', limit = 2)
                    require(pair.size == 2)
                    java.net.URLDecoder.decode(pair[0], "UTF-8") to java.net.URLDecoder.decode(pair[1], "UTF-8")
                }
            }.getOrNull() ?: return null
            for ((key, value) in decoded) if (values.put(key, value) != null) return null
            val credential = values["token"]?.takeIf(qrToken::matches)
                ?: values["code"]?.takeIf(code::matches)
                ?: return null
            val address = values["address"] ?: return null
            val direct = parseAddress(address) ?: return null
            val endpoints = if (values.containsKey("endpoints")) {
                decodeEndpoints(values.getValue("endpoints")) ?: return null
            } else {
                listOf(direct)
            }
            val preferred = endpoints.minByOrNull { it.priority } ?: return null
            val name = values["name"]?.filter { !it.isISOControl() }?.trim()?.take(80).orEmpty()
                .ifEmpty { URI(preferred.url).host }
            // Scanning the QR approves the exact bounded endpoint set encoded
            // in it. Preserve every validated route so the app can recover
            // from DNS/LAN changes without broadening access to arbitrary
            // local origins.
            val kinds = endpoints.mapTo(linkedSetOf()) { it.kind }
            if (preferred.kind == "tailnet") kinds += "hosted"
            val locals = endpoints
                .filter { it.kind in setOf("lan", "bonjour") }
                .mapTo(linkedSetOf()) { it.url }
            return PairingInvite(
                SavedConnection(name = name, origin = preferred.url, endpoints = endpoints, allowedKinds = kinds, allowedLocalOrigins = locals),
                credential,
            )
        }

        fun manual(address: String, codeValue: String): PairingInvite? {
            if (!code.matches(codeValue)) return null
            val endpoint = parseAddress(address) ?: return null
            val kinds = if (endpoint.kind == "tailnet") setOf("tailnet", "hosted") else setOf(endpoint.kind, "hosted")
            val locals = if (endpoint.kind in setOf("lan", "bonjour")) setOf(endpoint.url) else emptySet()
            return PairingInvite(
                SavedConnection(name = URI(endpoint.url).host, origin = endpoint.url, endpoints = listOf(endpoint), allowedKinds = kinds, allowedLocalOrigins = locals),
                codeValue,
            )
        }

        private fun parseAddress(raw: String): CompanionEndpoint? {
            val trimmed = raw.trim().trimEnd('/')
            val value = if (trimmed.startsWith("http://", true) || trimmed.startsWith("https://", true)) {
                trimmed
            } else {
                val hostWithPort = when {
                    trimmed.startsWith("[") -> trimmed
                    trimmed.count { it == ':' } > 1 -> "[$trimmed]:8810"
                    ':' in trimmed -> trimmed
                    else -> "$trimmed:8810"
                }
                "http://$hostWithPort"
            }
            val uri = runCatching { URI(value) }.getOrNull() ?: return null
            val host = uri.host?.lowercase()?.trimEnd('.') ?: return null
            val kind = when {
                uri.scheme.equals("https", true) -> "hosted"
                host.endsWith(".ts.net") -> "tailnet"
                host.endsWith(".local") -> "bonjour"
                else -> "lan"
            }
            return CompanionEndpoint(value, kind, 0).validated()
        }

        private fun decodeEndpoints(encoded: String): List<CompanionEndpoint>? {
            if (encoded.length !in 1..8192 || encoded.any { !it.isLetterOrDigit() && it !in "-_" }) return null
            val bytes = runCatching { Base64.getUrlDecoder().decode(encoded) }.getOrNull() ?: return null
            val decoded = runCatching { WireJson.decodeFromString<List<CompanionEndpoint>>(bytes.decodeToString()) }.getOrNull() ?: return null
            return decoded.mapNotNull { it.validated() }.distinctBy { it.url }.sortedBy { it.priority }.take(8).ifEmpty { null }
        }
    }
}

@Serializable data class ApiErrorBody(val error: String? = null)
@Serializable data class ComputerScreenFrame(val png: String, val format: String = "jpeg")
@Serializable
data class NotificationPayload(
    val kind: String = "",
    val botId: String = "",
    val botName: String = "",
    val threadId: String = "",
    val title: String = "",
    val body: String = "",
    /** Optional stable event id supplied by newer desktop builds. */
    val id: String? = null,
)

/** Bounded, visible-only metadata copied from a Google Messages notification. */
@Serializable
data class NotificationMirrorPayload(
    val id: String,
    val packageName: String,
    val postedAt: Long,
    val title: String,
    val text: String,
    val conversationTitle: String? = null,
    val sender: String? = null,
)
