package com.openmausbot.companion.core

import java.net.URI
import java.util.Base64
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** The one JSON configuration used for every sidecar payload. */
val CompanionJson = Json {
    ignoreUnknownKeys = true
}

@Serializable
data class SkillRequestCardData(
    val version: Int,
    val requestId: String,
    val botId: String,
    val threadId: String,
    val stagedId: String,
    val action: String,
    val name: String,
    val gist: String,
    /** Optional so approval cards persisted by older desktop builds still decode. */
    val source: String? = null,
    /** The exact, secret-scrubbed instructions the approval enables. */
    val preview: String? = null,
    val sha256: String? = null,
    val warnings: List<String> = emptyList(),
    val createdAt: Long,
) {
    /**
     * A current client echoes this hash only after it can show the complete proposal. Legacy or
     * malformed cards remain visible but deny-only.
     */
    val reviewedSha256: String?
        get() = sha256?.takeIf { hash ->
            !preview.isNullOrEmpty() && hash.length == 64 && hash.all { character ->
                character in '0'..'9' || character in 'a'..'f' || character in 'A'..'F'
            }
        }
}

@Serializable
data class OptionCard(
    val title: String,
    val subtitle: String,
    val options: List<String>,
    val answered: String? = null,
    val dismissed: Boolean? = null,
    val requestId: String? = null,
    val tool: String? = null,
    val held: String? = null,
    val allowKey: String? = null,
    /** Learned skills require a complete, hash-bound review before approval. */
    val skillRequest: SkillRequestCardData? = null,
) {
    val isPending: Boolean get() = requestId != null && answered == null && dismissed != true
    val isPermission: Boolean get() = tool != null

    fun responseBehavior(choice: String): String = responseBehavior(choice, isPermission)

    fun shouldRememberPermission(choice: String): Boolean =
        isPermission && allowKey != null && choice.trim().equals("Always allow", ignoreCase = true)

    companion object {
        fun responseBehavior(choice: String, isPermission: Boolean): String = when {
            !isPermission -> "answer"
            isRefusal(choice) -> "deny"
            else -> "allow"
        }

        fun isRefusal(choice: String): Boolean = choice.trim().lowercase() in
            setOf("deny", "cancel", "dismiss")
    }
}

@ConsistentCopyVisibility
data class NotificationTarget private constructor(
    val botId: String,
    val threadId: String,
) {
    fun requiresTaskSwitch(activeThreadId: String): Boolean = threadId != activeThreadId

    companion object {
        fun from(botId: String?, threadId: String?): NotificationTarget? {
            if (botId.isNullOrBlank() || threadId.isNullOrBlank()) return null
            return NotificationTarget(botId, threadId)
        }

        fun from(payload: Map<String, String>): NotificationTarget? =
            from(payload["botId"], payload["threadId"])
    }
}

@Serializable
data class ToolActivity(
    val name: String,
    val ok: Boolean? = null,
    val spoken: String? = null,
    val setup: Boolean? = null,
)

@Serializable
data class Sender(
    val botId: String,
    val name: String,
    val color: String,
)

@Serializable
data class Reaction(val emoji: String, val by: String)

@Serializable
data class CommChip(
    val groupId: String,
    val withBotId: String,
    val withName: String,
    val withColor: String,
)

@Serializable
data class Message(
    val id: String,
    val role: Role,
    val kind: Kind,
    val at: Double,
    val text: String? = null,
    val card: OptionCard? = null,
    val tool: ToolActivity? = null,
    val parentId: String? = null,
    val from: Sender? = null,
    val reactions: List<Reaction>? = null,
    val comm: CommChip? = null,
    val hasImage: Boolean? = null,
    val png: String? = null,
    val mime: String? = null,
    /**
     * A user line the engine took INTO the turn that was already running,
     * rather than one that started a turn of its own.
     */
    val steered: Boolean? = null,
    /**
     * The steer-queue entry this user line drained from. It is how a client
     * showing the held message knows which row to retire when the real line
     * finally lands.
     */
    val queueId: String? = null,
) {
    @Serializable(with = MessageKindSerializer::class)
    enum class Kind { TEXT, OPTIONS, ACTIVITY, SCREEN, UNKNOWN }

    @Serializable(with = MessageRoleSerializer::class)
    enum class Role { BOT, USER }
}

object MessageKindSerializer : KSerializer<Message.Kind> {
    override val descriptor = PrimitiveSerialDescriptor("Message.Kind", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Message.Kind = when (decoder.decodeString()) {
        "text" -> Message.Kind.TEXT
        "options" -> Message.Kind.OPTIONS
        "activity" -> Message.Kind.ACTIVITY
        "screen" -> Message.Kind.SCREEN
        else -> Message.Kind.UNKNOWN
    }

    override fun serialize(encoder: Encoder, value: Message.Kind) {
        encoder.encodeString(value.name.lowercase())
    }
}

object MessageRoleSerializer : KSerializer<Message.Role> {
    override val descriptor = PrimitiveSerialDescriptor("Message.Role", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Message.Role = when (decoder.decodeString()) {
        "user" -> Message.Role.USER
        else -> Message.Role.BOT
    }

    override fun serialize(encoder: Encoder, value: Message.Role) {
        encoder.encodeString(value.name.lowercase())
    }
}

@Serializable
data class ModelSelection(
    val instanceId: String,
    val model: String,
    /**
     * Optional reasoning effort passed through to engines that support it.
     * Older computers omit this field, which means the engine default — and a
     * null here is *omitted* on the wire, never sent as `null`, so an old
     * server's validator does not see a field it does not know.
     */
    val effort: String? = null,
)

@Serializable
data class BotTask(val threadId: String, val title: String, val createdAt: Double)

@Serializable
data class Bot(
    val id: String,
    val threadId: String,
    val name: String,
    val title: String,
    val description: String,
    val notifications: Boolean,
    val color: String,
    val unread: Boolean,
    val modelSelection: ModelSelection,
    val createdAt: Double,
    val avatarUrl: String? = null,
    val avatarCrop: AvatarCrop? = null,
    val busy: Boolean? = null,
    val pinned: Boolean? = null,
    val hidden: Boolean? = null,
    /** Desktop sidebar section. Missing or blank means the built-in Bots area. */
    val section: String? = null,
    val chiefOfStaff: Boolean? = null,
    /** ask, auto, full, or custom; null when paired to an older harness. */
    val approvalMode: String? = null,
    val autoApprove: Boolean? = null,
    val alwaysAllow: List<String>? = null,
    val computer: String? = null,
    val cloudBackend: String? = null,
    val speakReplies: Boolean? = null,
    val voice: String? = null,
    val mascotExpression: String? = null,
    /**
     * Which body from the mascot body catalog this bot wears. Absent (an older
     * harness included) means the shipped `cursor` silhouette.
     */
    val mascotBody: String? = null,
    val tasks: List<BotTask>? = null,
    val messages: List<Message>? = null,
    val activeLeafId: String? = null,
    val hasMore: Boolean? = null,
)

@Serializable(with = AvatarCropSerializer::class)
enum class AvatarCrop { MASCOT, CIRCLE, ROUNDED, SQUARE }

object AvatarCropSerializer : KSerializer<AvatarCrop> {
    override val descriptor = PrimitiveSerialDescriptor("AvatarCrop", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): AvatarCrop {
        val raw = decoder.decodeString()
        return AvatarCrop.entries.firstOrNull { it.name.lowercase() == raw }
            ?: AvatarCrop.MASCOT
    }

    override fun serialize(encoder: Encoder, value: AvatarCrop) {
        encoder.encodeString(value.name.lowercase())
    }
}

@Serializable
data class GroupResponder(val kind: String, val botId: String? = null)

@Serializable
data class Room(
    val id: String,
    val threadId: String,
    val name: String,
    val memberIds: List<String>,
    val defaultResponder: GroupResponder,
    val bulletin: String,
    val unread: Boolean,
    val createdAt: Double,
    val dm: Boolean? = null,
    /** Desktop sidebar section. Missing or blank means the built-in Channels area. */
    val section: String? = null,
    val busyBotId: String? = null,
    /** Independent user conversations in this channel. DMs omit this field. */
    val tasks: List<BotTask>? = null,
    val messages: List<Message>? = null,
    val hasMore: Boolean? = null,
)

@Serializable(with = FleetSerializer::class)
data class Fleet(val bots: List<Bot>, val groups: List<Room>)

object FleetSerializer : KSerializer<Fleet> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Fleet")

    override fun deserialize(decoder: Decoder): Fleet {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Fleet can only be decoded from JSON")
        val objectValue = input.decodeJsonElement().jsonObject

        fun <T> lossyArray(name: String, decode: (kotlinx.serialization.json.JsonElement) -> T): List<T> {
            val element = objectValue[name] ?: return emptyList()
            if (element is JsonNull) return emptyList()
            val array = element as? JsonArray
                ?: throw SerializationException("Fleet.$name must be an array")
            return array.mapNotNull { runCatching { decode(it) }.getOrNull() }
        }

        return Fleet(
            bots = lossyArray("bots") { input.json.decodeFromJsonElement(Bot.serializer(), it) },
            groups = lossyArray("groups") { input.json.decodeFromJsonElement(Room.serializer(), it) },
        )
    }

    override fun serialize(encoder: Encoder, value: Fleet) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Fleet can only be encoded as JSON")
        output.encodeJsonElement(buildJsonObject {
            put("bots", JsonArray(value.bots.map { output.json.encodeToJsonElement(Bot.serializer(), it) }))
            put("groups", JsonArray(value.groups.map { output.json.encodeToJsonElement(Room.serializer(), it) }))
        })
    }
}

@Serializable
data class ThreadPage(val messages: List<Message>, val hasMore: Boolean? = null)

@Serializable
data class SearchHit(
    val threadId: String,
    val messageId: String,
    val at: Double,
    val role: Message.Role,
    val kind: Message.Kind,
    val snippet: String,
    val matchStart: Int,
    val matchLength: Int,
    val botId: String? = null,
    val groupId: String? = null,
    val name: String,
    val task: String? = null,
    val onActivePath: Boolean,
) {
    val id: String get() = "$threadId:$messageId"
}

data class TranscriptExport(val data: ByteArray, val filename: String, val contentType: String)

@Serializable
data class PairedDevice(
    val id: String,
    val name: String,
    val createdAt: Double,
    val lastSeenAt: Double,
)

@Serializable(with = PairResponseSerializer::class)
data class PairResponse(
    val token: String,
    val device: PairedDevice,
    val serverName: String,
    val hosts: List<String>? = null,
    val endpoints: List<CompanionEndpoint>? = null,
)

/**
 * Pairing has already minted the durable token by the time this body arrives. Endpoint metadata
 * is therefore lossy per element: a future kind or malformed advisory route cannot discard the
 * usable token and legacy host fields beside it.
 */
object PairResponseSerializer : KSerializer<PairResponse> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): PairResponse {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("PairResponse must be decoded from JSON")
        val value = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("PairResponse must be a JSON object")
        val json = input.json
        val token = json.decodeFromJsonElement<String>(
            value["token"] ?: throw SerializationException("PairResponse.token is required"),
        )
        val device = json.decodeFromJsonElement<PairedDevice>(
            value["device"] ?: throw SerializationException("PairResponse.device is required"),
        )
        val serverName = json.decodeFromJsonElement<String>(
            value["serverName"] ?: throw SerializationException("PairResponse.serverName is required"),
        )
        val hosts = value["hosts"]?.takeUnless { it is JsonNull }?.let {
            json.decodeFromJsonElement<List<String>>(it)
        }
        val endpoints = when (val element = value["endpoints"]) {
            null -> null
            is JsonArray -> element.mapNotNull { candidate ->
                runCatching { json.decodeFromJsonElement<CompanionEndpoint>(candidate) }.getOrNull()
            }
            // The field is advisory and the token already exists. A malformed container is
            // discarded just like malformed entries, but is handled explicitly rather than
            // becoming an empty array through a nullable cast.
            else -> emptyList()
        }
        return PairResponse(token, device, serverName, hosts, endpoints)
    }

    override fun serialize(encoder: Encoder, value: PairResponse) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("PairResponse must be encoded as JSON")
        output.encodeJsonElement(buildJsonObject {
            put("token", value.token)
            put("device", output.json.encodeToJsonElement(value.device))
            put("serverName", value.serverName)
            value.hosts?.let { put("hosts", output.json.encodeToJsonElement(it)) }
            value.endpoints?.let { put("endpoints", output.json.encodeToJsonElement(it)) }
        })
    }
}

/** Non-secret connection snapshot returned by GET /api/companion/endpoints. */
@Serializable(with = CompanionConnectionMetadataSerializer::class)
data class CompanionConnectionMetadata(
    val serverName: String,
    val hosts: List<String>? = null,
    val endpoints: List<CompanionEndpoint>,
)

/**
 * Refresh metadata also drops malformed individual routes, but unlike PairResponse it is a
 * replacement snapshot. With no usable route the whole response is rejected so callers retain
 * their last known-good connection.
 */
object CompanionConnectionMetadataSerializer : KSerializer<CompanionConnectionMetadata> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): CompanionConnectionMetadata {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Companion connection metadata must be JSON")
        val value = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("Companion connection metadata must be a JSON object")
        val json = input.json
        val serverName = json.decodeFromJsonElement<String>(
            value["serverName"]
                ?: throw SerializationException("Companion connection metadata needs serverName"),
        )
        val hosts = value["hosts"]?.takeUnless { it is JsonNull }?.let {
            json.decodeFromJsonElement<List<String>>(it)
        }
        val decoded = (value["endpoints"] as? JsonArray).orEmpty().mapNotNull { element ->
            runCatching { json.decodeFromJsonElement<CompanionEndpoint>(element) }.getOrNull()
        }
        val endpoints = decoded.withIndex()
            .sortedWith(compareBy<IndexedValue<CompanionEndpoint>> { it.value.priority }.thenBy { it.index })
            .map { it.value }
            .distinctBy { it.url }
            .take(8)
        if (endpoints.isEmpty()) {
            throw SerializationException(
                "Companion endpoint metadata must contain at least one valid route.",
            )
        }
        return CompanionConnectionMetadata(serverName, hosts, endpoints)
    }

    override fun serialize(encoder: Encoder, value: CompanionConnectionMetadata) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Companion connection metadata must be JSON")
        output.encodeJsonElement(buildJsonObject {
            put("serverName", value.serverName)
            value.hosts?.let { put("hosts", output.json.encodeToJsonElement(it)) }
            put("endpoints", output.json.encodeToJsonElement(value.endpoints))
        })
    }
}

@Serializable(with = CloudDesktopSessionSerializer::class)
data class CloudDesktopSession(val url: URI)

object CloudDesktopSessionSerializer : KSerializer<CloudDesktopSession> {
    @Serializable
    private data class Wire(@SerialName("joinUrl") val joinUrl: String)

    override val descriptor: SerialDescriptor = Wire.serializer().descriptor

    override fun deserialize(decoder: Decoder): CloudDesktopSession {
        val raw = Wire.serializer().deserialize(decoder).joinUrl
        val parsed = runCatching { URI(raw) }.getOrNull()
        if (parsed == null || !parsed.scheme.equals("https", ignoreCase = true) || parsed.host.isNullOrEmpty()) {
            throw SerializationException("Cloud desktop URL must be HTTPS with a host")
        }
        return CloudDesktopSession(parsed)
    }

    override fun serialize(encoder: Encoder, value: CloudDesktopSession) {
        Wire.serializer().serialize(encoder, Wire(value.url.toASCIIString()))
    }
}

@Serializable
data class ProviderSnapshot(
    val state: String,
    val reason: String? = null,
    val authenticated: Boolean? = null,
    val version: String? = null,
) {
    val isAvailable: Boolean get() = state == "available"
}

@Serializable
data class ModelOption(val id: String, val label: String)

@Serializable
data class ModelCatalog(
    @SerialName("default") val defaultModel: String,
    val options: List<ModelOption>,
)

@Serializable
data class Instance(
    val instanceId: String,
    val driverKind: String,
    val displayName: String? = null,
    val snapshot: ProviderSnapshot,
    val models: ModelCatalog,
    /** Older computers omit capabilities; omission is intentionally not permission. */
    val capabilities: InstanceCapabilities? = null,
) {
    val id: String get() = instanceId
}

/**
 * The small, phone-safe part of an engine's capabilities. Missing capabilities
 * or effort levels mean the engine offers no reasoning control.
 */
@Serializable
data class InstanceCapabilities(
    val images: Boolean? = null,
    val effortLevels: List<String>? = null,
    /**
     * The engine can take a message into a turn that is already running.
     * Engines without it hold mid-turn sends until the turn settles, which is
     * a different promise and deserves different words in the composer.
     */
    val queueing: Boolean? = null,
)

@Serializable
data class InstanceList(val instances: List<Instance>)

/** Which engine actually speaks. `VoiceProvider` in `server/tts/index.ts`. */
enum class VoiceProvider { ELEVENLABS, SYSTEM }

@Serializable
data class ConfigFlag(
    val configured: Boolean,
    val apiKeyConfigured: Boolean? = null,
    val ready: Boolean? = null,
    val voice: String? = null,
    /**
     * The voice engine, absent on desktops older than the built-in provider.
     * Read it through `ConfigStatus.voiceProvider`, which applies the
     * server's own fallback; nothing should compare this string directly.
     */
    val provider: String? = null,
)

@Serializable
data class Profile(val name: String, val email: String)

@Serializable
data class ConfigStatus(
    val composio: ConfigFlag? = null,
    val box: ConfigFlag? = null,
    val tts: ConfigFlag? = null,
    val imageGen: ConfigFlag? = null,
    val profile: Profile? = null,
) {
    /**
     * "This engine can speak", not "a key is on file" — under the built-in
     * provider `providerConfigured` in `server/tts/index.ts` reports whether
     * the computer has usable voices, and no credential exists at all. The
     * flag stays provider-neutral; only the reason behind it changes.
     */
    val isTTSConfigured: Boolean
        get() = tts?.configured == true || tts?.apiKeyConfigured == true

    val hasWorkspaceDefaultVoice: Boolean
        get() = !tts?.voice.isNullOrBlank()

    fun canSpeak(agentVoice: String?): Boolean =
        isTTSConfigured && (!agentVoice.isNullOrBlank() || hasWorkspaceDefaultVoice)

    /**
     * `voiceProvider(cfg)` in `server/tts/index.ts`: only the exact string
     * "system" selects the built-in engine. A missing field — an older
     * desktop that predates the choice — and a provider this build has never
     * heard of both fall back to ElevenLabs, which is the server's own rule
     * and keeps an unrecognised engine from being explained with copy
     * written for a different one.
     */
    val voiceProvider: VoiceProvider
        get() = if (tts?.provider == "system") VoiceProvider.SYSTEM else VoiceProvider.ELEVENLABS
}

object ConnectedAppsRules {
    const val MAX_ACCOUNT_ALIAS_LENGTH = 64
    const val MAX_ACCOUNTS_PER_CONNECTOR = 5
    const val PRIMARY_ACCOUNT_LABEL = "Primary account"

    val firstAccountAlias: String? = null

    fun additionalAccountAlias(input: String): String? =
        trimmedAlias(input)?.take(MAX_ACCOUNT_ALIAS_LENGTH)

    fun canAddAnotherAccount(accounts: List<ConnectorAccount>): Boolean =
        accounts.size < MAX_ACCOUNTS_PER_CONNECTOR

    internal fun trimmedAlias(input: String?): String? =
        input?.trim { it.isWhitespace() }?.takeIf { it.isNotEmpty() }
}

@Serializable
data class ConnectorCard(
    val slug: String,
    val label: String,
    val blurb: String,
    val logo: String? = null,
    val domain: String? = null,
) {
    val id: String get() = slug
}

@Serializable
data class ConnectorAccount(
    val id: String,
    val alias: String? = null,
    val status: String,
) {
    val displayName: String
        get() = ConnectedAppsRules.trimmedAlias(alias) ?: ConnectedAppsRules.PRIMARY_ACCOUNT_LABEL

    val isActive: Boolean
        get() = status.trim { it.isWhitespace() }.uppercase() == "ACTIVE"
}

@Serializable
data class ConnectorStatus(
    val connected: Boolean,
    val pending: Boolean? = null,
    val status: String? = null,
    val accounts: List<ConnectorAccount>? = null,
)

@Serializable
data class ConnectorCatalog(
    val configured: Boolean,
    val mode: String? = null,
    val source: String? = null,
    val cards: List<ConnectorCard>,
)

@Serializable
data class ConnectorStatuses(
    val configured: Boolean,
    val services: Map<String, ConnectorStatus>,
    /**
     * "ok", "unavailable", or absent on a desktop that predates the field.
     * Read it through `isAuthoritative`; nothing should compare it directly.
     */
    val credentialStore: String? = null,
) {
    /**
     * Whether `services` is an inventory or an admission of ignorance.
     *
     * `server/index.ts` answers an unreadable Composio credential store with
     * an empty map *and* `credentialStore: "unavailable"`, because not being
     * able to read the store means we do not know what is connected — which
     * is not the same as knowing nothing is. An empty map that arrives this
     * way must never be shown as "nothing is connected"; every account may
     * still be live on the computer.
     *
     * Only that exact string withdraws the claim. "ok" is authoritative, and
     * so is a missing field: a desktop old enough not to send it would
     * otherwise have every answer treated as unknowable.
     */
    val isAuthoritative: Boolean
        get() = credentialStore != "unavailable"
}

@Serializable(with = BotProfilePatchSerializer::class)
data class BotProfilePatch(
    val name: String? = null,
    val title: String? = null,
    val description: String? = null,
    val notifications: Boolean? = null,
    val avatarUrl: AvatarURL? = null,
    val avatarCrop: AvatarCrop? = null,
    val voice: String? = null,
    val speakReplies: Boolean? = null,
) {
    sealed interface AvatarURL {
        data class Set(val path: String) : AvatarURL
        data object Clear : AvatarURL
    }
}

object BotProfilePatchSerializer : KSerializer<BotProfilePatch> {
    private val fieldNames = setOf(
        "name",
        "title",
        "description",
        "notifications",
        "avatarUrl",
        "avatarCrop",
        "voice",
        "speakReplies",
    )

    override val descriptor = buildClassSerialDescriptor("BotProfilePatch") {
        element<String>("name", isOptional = true)
        element<String>("title", isOptional = true)
        element<String>("description", isOptional = true)
        element<Boolean>("notifications", isOptional = true)
        element<JsonElement>("avatarUrl", isOptional = true)
        element<String>("avatarCrop", isOptional = true)
        element<String>("voice", isOptional = true)
        element<Boolean>("speakReplies", isOptional = true)
    }

    override fun serialize(encoder: Encoder, value: BotProfilePatch) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("BotProfilePatch can only be encoded as JSON")
        output.encodeJsonElement(buildJsonObject {
            value.name?.let { put("name", it) }
            value.title?.let { put("title", it) }
            value.description?.let { put("description", it) }
            value.notifications?.let { put("notifications", it) }
            when (val avatarUrl = value.avatarUrl) {
                is BotProfilePatch.AvatarURL.Set -> put("avatarUrl", avatarUrl.path)
                BotProfilePatch.AvatarURL.Clear -> put("avatarUrl", JsonNull)
                null -> Unit
            }
            value.avatarCrop?.let { put("avatarCrop", it.name.lowercase()) }
            value.voice?.let { put("voice", it) }
            value.speakReplies?.let { put("speakReplies", it) }
        })
    }

    override fun deserialize(decoder: Decoder): BotProfilePatch {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("BotProfilePatch can only be decoded from JSON")
        val value = input.decodeJsonElement().jsonObject
        val unknown = value.keys - fieldNames
        if (unknown.isNotEmpty()) {
            throw SerializationException("Unsupported profile field: ${unknown.first()}")
        }

        fun string(name: String): String? {
            val element = value[name] ?: return null
            if (element is JsonNull) throw SerializationException("$name must be a string")
            val primitive = element as? JsonPrimitive
                ?: throw SerializationException("$name must be a string")
            if (!primitive.isString) throw SerializationException("$name must be a string")
            return primitive.content
        }

        fun boolean(name: String): Boolean? {
            val element = value[name] ?: return null
            val primitive = element as? JsonPrimitive
                ?: throw SerializationException("$name must be true or false")
            return primitive.booleanOrNull
                ?: throw SerializationException("$name must be true or false")
        }

        val avatarUrl = when (val element = value["avatarUrl"]) {
            null -> null
            JsonNull -> BotProfilePatch.AvatarURL.Clear
            else -> BotProfilePatch.AvatarURL.Set(string("avatarUrl")!!)
        }
        val crop = string("avatarCrop")?.let { raw ->
            AvatarCrop.entries.firstOrNull { it.name.lowercase() == raw }
                ?: AvatarCrop.MASCOT
        }
        return BotProfilePatch(
            name = string("name"),
            title = string("title"),
            description = string("description"),
            notifications = boolean("notifications"),
            avatarUrl = avatarUrl,
            avatarCrop = crop,
            voice = string("voice"),
            speakReplies = boolean("speakReplies"),
        )
    }
}

@Serializable
data class Voice(
    val id: String,
    val label: String,
    val description: String? = null,
)

@Serializable
data class RoutineSchedule(
    val type: Kind,
    val at: Double? = null,
    val time: String? = null,
    val weekdays: List<Int>? = null,
    val everyMinutes: Int? = null,
    val anchorAt: Long? = null,
) {
    @Serializable(with = RoutineScheduleKindSerializer::class)
    enum class Kind { ONCE, DAILY, INTERVAL, UNKNOWN }

    companion object {
        fun once(atMillis: Double): RoutineSchedule = RoutineSchedule(Kind.ONCE, at = atMillis)

        fun daily(time: String, weekdays: List<Int>): RoutineSchedule =
            RoutineSchedule(Kind.DAILY, time = time, weekdays = weekdays)

        fun interval(everyMinutes: Int, anchorAtMillis: Long): RoutineSchedule =
            RoutineSchedule(
                Kind.INTERVAL,
                everyMinutes = everyMinutes,
                anchorAt = anchorAtMillis,
            )
    }
}

object RoutineScheduleKindSerializer : KSerializer<RoutineSchedule.Kind> {
    override val descriptor = PrimitiveSerialDescriptor("RoutineSchedule.Kind", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): RoutineSchedule.Kind = when (decoder.decodeString()) {
        "once" -> RoutineSchedule.Kind.ONCE
        "daily" -> RoutineSchedule.Kind.DAILY
        "interval" -> RoutineSchedule.Kind.INTERVAL
        else -> RoutineSchedule.Kind.UNKNOWN
    }

    override fun serialize(encoder: Encoder, value: RoutineSchedule.Kind) {
        encoder.encodeString(value.name.lowercase())
    }
}

@Serializable
data class Routine(
    val id: String,
    val name: String,
    val prompt: String,
    val botId: String,
    val runOn: String,
    val enabled: Boolean,
    val schedule: RoutineSchedule,
    /** Legacy calendar/display length retained for older desktop compatibility. */
    val durationMinutes: Int,
    /** Optional execution guard. Missing means the routine has no time limit. */
    val timeoutMinutes: Int? = null,
    val nextRunAt: Double? = null,
    val createdAt: Double,
    val updatedAt: Double,
) {
    val runLocation: RoutineRunLocation
        get() = RoutineRunLocation.entries.firstOrNull { it.wireValue == runOn }
            ?: RoutineRunLocation.MAUS

    fun canToggle(atMillis: Double = System.currentTimeMillis().toDouble()): Boolean = when (schedule.type) {
        RoutineSchedule.Kind.DAILY -> true
        RoutineSchedule.Kind.INTERVAL ->
            (schedule.everyMinutes ?: 0) in 5..1_440 && schedule.anchorAt != null
        RoutineSchedule.Kind.ONCE -> (schedule.at ?: Double.NEGATIVE_INFINITY) > atMillis
        RoutineSchedule.Kind.UNKNOWN -> false
    }
}

@Serializable
data class RoutineRun(
    val id: String,
    val routineId: String,
    val routineName: String,
    val prompt: String? = null,
    /** Legacy calendar/display length snapshot. */
    val durationMinutes: Int? = null,
    /** Optional execution-guard snapshot. */
    val timeoutMinutes: Int? = null,
    val botId: String,
    val runOn: String,
    val scheduledFor: Double,
    val status: String,
    val manual: Boolean,
    val triggerSource: String? = null,
    val threadId: String? = null,
    val startedAt: Double? = null,
    val finishedAt: Double? = null,
    val output: String? = null,
    val error: String? = null,
    val createdAt: Double,
    val seenAt: Double? = null,
)

@Serializable
data class RoutineInput(
    val name: String,
    val prompt: String,
    val botId: String,
    val runOn: String = "maus",
    val enabled: Boolean? = null,
    val schedule: RoutineSchedule,
    /** Still required by older paired desktops; it is not the execution timeout. */
    val durationMinutes: Int = 30,
    /** A value replaces the stored limit; null leaves it unchanged on PATCH. */
    val timeoutMinutes: Int? = null,
    /** Interpreted by CompanionClient as an explicit JSON null. */
    @kotlinx.serialization.Transient val clearTimeout: Boolean = false,
)

@Serializable
enum class RoutineRunLocation(val wireValue: String) {
    @SerialName("maus")
    MAUS("maus"),

    @SerialName("cloud")
    CLOUD("cloud"),
}

data class RoutineRunAvailability(
    val cloudConfigured: Boolean,
    val cloudInstanceAvailable: Boolean,
) {
    constructor(config: ConfigStatus?, instances: List<Instance>) : this(
        cloudConfigured = config?.box?.configured == true,
        cloudInstanceAvailable = instances.any {
            it.driverKind == "boxAgent" && it.snapshot.isAvailable
        },
    )

    val cloudReady: Boolean get() = cloudConfigured && cloudInstanceAvailable

    fun canSelect(location: RoutineRunLocation, preserving: RoutineRunLocation): Boolean =
        location == RoutineRunLocation.MAUS || cloudReady || preserving == RoutineRunLocation.CLOUD
}

@Serializable
data class APIErrorBody(val error: String)

data class ScreenFrame(val png: String, val mime: String) {
    val data: ByteArray?
        get() = try {
            Base64.getDecoder().decode(png)
        } catch (_: IllegalArgumentException) {
            null
        }
}

@Serializable
data class CreatedBot(val bot: Bot)

@Serializable
data class CreatedRoom(val group: Room)

@Serializable
internal data class SearchResponse(val hits: List<SearchHit>)

@Serializable
internal data class MessageResponse(val message: Message)

@Serializable
internal data class ActiveBranchResponse(val activeLeafId: String)

@Serializable
internal data class BotResponse(val bot: Bot)

@Serializable
internal data class RoomResponse(val group: Room)

/** The narrow sidebar organizer route returns just the affected bots. */
@Serializable
internal data class SidebarSectionResponse(val section: String, val bots: List<Bot>)

@Serializable
internal data class VoiceListResponse(val voices: List<Voice>, val error: String? = null)

@Serializable
internal data class AttachmentResponse(val path: String, val mime: String, val bytes: Int)

@Serializable
internal data class FileUploadResponse(val path: String, val name: String, val mime: String, val bytes: Int)

@Serializable
internal data class GeneratedAvatarResponse(val avatarUrl: String, val bot: Bot)

@Serializable
data class RoutinesResponse(val routines: List<Routine>, val runs: List<RoutineRun>)

@Serializable
internal data class RoutineResponse(val routine: Routine)

@Serializable
internal data class RoutineRunResponse(val run: RoutineRun)

@Serializable
internal data class ConnectorAuthorizationResponse(val url: String)

@Serializable
data class BotOverviewWho(val name: String, val title: String, val blurb: String, val soulLead: String)

@Serializable
data class BotOverviewRecent(val at: Double, val summary: String)

@Serializable
data class BotOverview(
    val who: BotOverviewWho,
    val does: List<String> = emptyList(),
    val reaches: List<String> = emptyList(),
    val wont: List<String> = emptyList(),
    val recent: List<BotOverviewRecent> = emptyList(),
)
