package org.openmausbot.android.data

import org.json.JSONArray
import org.json.JSONObject

/** Tolerant accessors: the harness grows fields over time and a missing one
 *  must never fail a whole screen. */
fun JSONObject.str(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

fun JSONObject.bool(key: String, fallback: Boolean = false): Boolean =
    if (has(key) && !isNull(key)) optBoolean(key, fallback) else fallback

fun JSONObject.long(key: String): Long? =
    if (has(key) && !isNull(key)) optLong(key) else null

fun JSONObject.obj(key: String): JSONObject? =
    if (has(key) && !isNull(key)) optJSONObject(key) else null

fun JSONObject.arr(key: String): JSONArray? =
    if (has(key) && !isNull(key)) optJSONArray(key) else null

fun JSONArray.objects(): List<JSONObject> =
    (0 until length()).mapNotNull { optJSONObject(it) }

data class ModelSelection(
    val instanceId: String,
    val model: String,
    val effort: String? = null,
) {
    companion object {
        fun parse(json: JSONObject?): ModelSelection? {
            json ?: return null
            val instance = json.str("instanceId") ?: return null
            val model = json.str("model") ?: return null
            return ModelSelection(instance, model, json.str("effort"))
        }
    }
}

data class Task(
    val threadId: String,
    val title: String,
    val unread: Boolean,
    val busy: Boolean,
    val activity: String?,
    val pinned: Boolean,
    val updatedAt: Long?,
    val createdAt: Long?,
    val lastReadMessageId: String?,
    val modelSelection: ModelSelection?,
) {
    companion object {
        fun parse(json: JSONObject): Task = Task(
            threadId = json.str("threadId") ?: return skip(),
            title = json.str("title") ?: "",
            unread = json.bool("unread"),
            busy = json.bool("busy"),
            activity = json.str("activity"),
            pinned = json.bool("pinned"),
            updatedAt = json.long("updatedAt"),
            createdAt = json.long("createdAt"),
            lastReadMessageId = json.str("lastReadMessageId"),
            modelSelection = ModelSelection.parse(json.obj("modelSelection")),
        )

        private fun skip(): Nothing = throw SkipRecord()
    }

    class SkipRecord : RuntimeException()
}

data class Bot(
    val id: String,
    val name: String,
    val title: String,
    val description: String,
    val color: String,
    val avatarUrl: String?,
    val unread: Boolean,
    val pinned: Boolean,
    val hidden: Boolean,
    val busy: Boolean,
    val activity: String?,
    val threadId: String,
    val mainThreadId: String?,
    val tasks: List<Task>,
    val modelSelection: ModelSelection?,
    val notifications: Boolean,
    val section: String?,
    val speaking: Boolean,
) {
    val activeTask: Task? get() = tasks.firstOrNull { it.threadId == threadId } ?: tasks.firstOrNull()
    val subtitle: String
        get() = when {
            busy -> "正在工作"
            activity == "waiting-on-you" -> "等待你处理"
            activity == "parked.computer" -> "已暂停"
            activity == "dead" -> "无信号"
            activity == "no-signal" -> "无信号"
            else -> title.ifBlank { description }
        }

    companion object {
        fun parse(json: JSONObject): Bot? {
            val id = json.str("id") ?: return null
            return Bot(
                id = id,
                name = json.str("name") ?: "Bot",
                title = json.str("title") ?: "",
                description = json.str("description") ?: "",
                color = json.str("color") ?: "green",
                avatarUrl = json.str("avatarUrl"),
                unread = json.bool("unread"),
                pinned = json.bool("pinned"),
                hidden = json.bool("hidden"),
                busy = json.bool("busy"),
                activity = json.str("activity"),
                threadId = json.str("threadId") ?: "",
                mainThreadId = json.str("mainThreadId"),
                tasks = runCatching {
                    json.arr("tasks")?.objects()?.mapNotNull { t ->
                        runCatching { Task.parse(t) }.getOrNull()
                    } ?: emptyList()
                }.getOrDefault(emptyList()),
                modelSelection = ModelSelection.parse(json.obj("modelSelection")),
                notifications = json.bool("notifications", true),
                section = json.str("section"),
                speaking = json.bool("speakReplies"),
            )
        }
    }
}

data class Group(
    val id: String,
    val name: String,
    val title: String,
    val unread: Boolean,
    val threadId: String,
    val memberIds: List<String>,
) {
    val subtitle: String get() = title.ifBlank { "${memberIds.size} 个 Bot" }

    companion object {
        fun parse(json: JSONObject): Group? {
            val id = json.str("id") ?: return null
            return Group(
                id = id,
                name = json.str("name") ?: "房间",
                title = json.str("title") ?: "",
                unread = json.bool("unread"),
                threadId = json.str("threadId") ?: "",
                memberIds = json.arr("members")?.objects()?.mapNotNull { it.str("botId") ?: it.str("id") }
                    ?: emptyList(),
            )
        }
    }
}

data class Attachment(
    val kind: String,
    val path: String,
    val mime: String,
    val name: String?,
    val durationMs: Long?,
) {
    val isImage get() = kind == "image"
    val isAudio get() = kind == "audio"

    companion object {
        fun parse(json: JSONObject): Attachment? {
            val path = json.str("path") ?: return null
            return Attachment(
                kind = json.str("kind") ?: "file",
                path = path,
                mime = json.str("mime") ?: "application/octet-stream",
                name = json.str("name"),
                durationMs = json.long("durationMs"),
            )
        }
    }
}

data class ToolRow(
    val name: String,
    val label: String?,
    val ok: Boolean,
    val detail: String?,
)

data class Card(
    val title: String,
    val subtitle: String,
    val options: List<String>,
    val answered: String?,
    val answeredText: String?,
    val requestId: String?,
    val requestType: String?,
    val tool: String?,
    val allowKey: String?,
    val allowSession: Boolean,
    val expired: Boolean,
    val stopped: Boolean,
    val dismissed: Boolean,
    val held: String?,
) {
    val isApproval: Boolean
        get() = requestType == "permission" || tool != null || (requestId != null && options.any { looksLikeVerdict(it) })
    val isQuestion: Boolean
        get() = requestType == "question" || (!isApproval && requestId != null && options.isNotEmpty())
    val settled: Boolean get() = !answered.isNullOrBlank() || expired || stopped || dismissed
    val needsAnswer: Boolean get() = requestId != null && !settled

    companion object {
        private fun looksLikeVerdict(option: String): Boolean {
            val lower = option.lowercase()
            return lower == "allow" || lower == "deny" || lower == "reject" || lower.contains("allow once") ||
                lower.contains("always allow") || lower.contains("don't allow") || lower.contains("deny")
        }

        fun parse(json: JSONObject?): Card? {
            json ?: return null
            val title = json.str("title") ?: return null
            val options = json.arr("options")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
            } ?: emptyList()
            return Card(
                title = title,
                subtitle = json.str("subtitle") ?: "",
                options = options,
                answered = json.str("answered"),
                answeredText = json.str("answeredText"),
                requestId = json.str("requestId"),
                requestType = json.str("requestType"),
                tool = json.str("tool"),
                allowKey = json.str("allowKey"),
                allowSession = json.bool("allowSession"),
                expired = json.bool("expired"),
                stopped = json.bool("stopped"),
                dismissed = json.bool("dismissed"),
                held = json.str("held"),
            )
        }
    }
}

data class Message(
    val id: String,
    val role: String,
    val kind: String,
    val text: String,
    val createdAt: Long,
    val card: Card?,
    val tool: ToolRow?,
    val attachments: List<Attachment>,
    val turnId: String?,
    val queueId: String?,
    val fromName: String?,
    val fromColor: String?,
    val editedAt: Long?,
    val pending: Boolean = false,
    val failed: Boolean = false,
) {
    val isUser get() = role == "user"
    val isBot get() = role == "bot"

    companion object {
        fun parse(json: JSONObject, pending: Boolean = false): Message? {
            val id = json.str("id") ?: return null
            val attachments = runCatching {
                json.arr("attachments")?.objects()?.mapNotNull { Attachment.parse(it) } ?: emptyList()
            }.getOrDefault(emptyList())
            val tool = json.obj("tool")?.let { t ->
                ToolRow(
                    name = t.str("name") ?: "",
                    label = t.str("label"),
                    ok = t.bool("ok", true),
                    detail = t.str("detail") ?: t.str("summary") ?: t.str("target"),
                )
            }
            val from = json.obj("from")
            return Message(
                id = id,
                role = json.str("role") ?: "bot",
                kind = json.str("kind") ?: "text",
                text = json.str("text") ?: "",
                createdAt = json.long("createdAt") ?: System.currentTimeMillis(),
                card = Card.parse(json.obj("card")),
                tool = tool,
                attachments = attachments,
                turnId = json.str("turnId"),
                queueId = json.str("queueId"),
                fromName = from?.str("name"),
                fromColor = from?.str("color"),
                editedAt = json.long("editedAt"),
                pending = pending,
            )
        }
    }
}

data class ConnectionState(
    val phase: Phase = Phase.IDLE,
    val detail: String = "",
    val serverName: String = "",
) {
    enum class Phase { IDLE, CONNECTING, ONLINE, OFFLINE, ERROR }
}

data class PairedComputer(
    val id: String,
    val serverName: String,
    val baseUrl: String,
    val token: String,
    /** Legacy comma-free URL list kept for older builds and display. New
     *  pairings also persist `endpointRoutes`, which carries kind/priority. */
    val endpoints: List<String> = emptyList(),
    val lastCursor: String? = null,
    val lastUsedAt: Long = 0,
    val hosts: List<String> = emptyList(),
    val endpointRoutes: List<CompanionEndpoint> = emptyList(),
    val activeEndpoint: CompanionEndpoint? = null,
    /** `null` is the compatibility policy for connections saved before route
     *  consent existed. New pairings always persist a non-nil set. */
    val allowedRouteKinds: Set<EndpointKind>? = null,
    val allowedLocalRouteUrls: Set<String>? = null,
    val secretPublicKey: String? = null,
    val companionDeviceId: String? = null,
)

/** The sidecar-owned endpoint snapshot; no account or pairing credential. */
data class ConnectionMetadata(
    val serverName: String,
    val hosts: List<String>? = null,
    val endpoints: List<CompanionEndpoint> = emptyList(),
)
