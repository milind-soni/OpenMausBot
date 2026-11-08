package org.openmausbot.android.data

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.openmausbot.android.e2e.E2EClient
import org.openmausbot.android.e2e.E2EConnection
import org.openmausbot.android.e2e.E2EDescriptor
import java.util.concurrent.atomic.AtomicBoolean

/** One process-wide state holder. The React app folds a single SSE stream into
 *  its store; this does the same with Compose snapshot state. */
object Repo {
    lateinit var store: DeviceStore
        private set
    lateinit var appContext: Context
        private set

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    var computers by mutableStateOf<List<PairedComputer>>(emptyList())
        private set
    var computer by mutableStateOf<PairedComputer?>(null)
        private set
    var connection by mutableStateOf(ConnectionState())
        private set
    var bots = mutableStateListOf<Bot>()
    var groups = mutableStateListOf<Group>()
    var config by mutableStateOf<JSONObject?>(null)
        private set
    var lastError by mutableStateOf<String?>(null)
        private set
    var openThreadId by mutableStateOf<String?>(null)

    private val messagesByThread = mutableStateMapOf<String, List<Message>>()
    private val moreByThread = mutableStateMapOf<String, Boolean>()
    private val loadingThreads = mutableStateMapOf<String, Boolean>()
    private var client: ApiClient? = null
    private var stream: ApiClient.Stream? = null
    @Volatile private var activeE2E: E2EConnection? = null
    private val connecting = AtomicBoolean(false)
    private val notifiedIds = mutableSetOf<String>()

    var onNotification: ((NotificationPayload) -> Unit)? = null
    var onSpeak: ((String) -> Unit)? = null

    data class NotificationPayload(
        val botId: String?,
        val threadId: String?,
        val title: String,
        val body: String,
    )

    fun init(context: Context) {
        if (::appContext.isInitialized) return
        appContext = context.applicationContext
        store = DeviceStore(appContext)
        computers = store.computers
    }

    // ---------------------------------------------------------------- pairing

    suspend fun pairWith(invite: PairingInvite): Result<PairedComputer> = withContext(Dispatchers.IO) {
        val credential = invite.token ?: invite.code
            ?: return@withContext Result.failure(ApiException(400, "这个邀请没有配对码"))
        val descriptor = invite.e2e
        val pairingToken = invite.token
        if (descriptor != null && pairingToken != null) {
            return@withContext pairE2E(invite, pairingToken, descriptor)
        }
        val candidates = (listOf(invite.baseUrl) + invite.endpoints).distinct()
        var lastError: Exception? = null
        for (base in candidates) {
            try {
                val api = ApiClient(base, null)
                val result = api.pair(credential, invite.serverName)
                val computer = PairedComputer(
                    id = result.deviceId,
                    serverName = result.serverName,
                    baseUrl = base,
                    token = result.token,
                    endpoints = (invite.endpoints + result.endpoints).filter { it != base }.distinct(),
                    lastUsedAt = System.currentTimeMillis(),
                    e2e = result.e2e ?: descriptor,
                )
                store.upsert(computer)
                store.selectedId = computer.id
                computers = store.computers
                return@withContext Result.success(computer)
            } catch (e: Exception) {
                lastError = e
            }
        }
        Result.failure(lastError ?: ApiException(500, "无法连接这台电脑"))
    }

    /** A pairing token is also a valid PSK, so the QR's redemption can happen
     *  inside the encrypted session; the device token is used afterwards. */
    private suspend fun pairE2E(
        invite: PairingInvite,
        pairingToken: String,
        descriptor: E2EDescriptor,
    ): Result<PairedComputer> {
        return try {
            val candidates = (listOf(invite.baseUrl) + invite.endpoints).distinct()
            val connection = E2EClient(descriptor, pairingToken, candidates).connect()
            try {
                val api = ApiClient(
                    connection.baseUrl,
                    null,
                    connection.headerName,
                    connection.headerValue,
                )
                val result = api.pair(pairingToken, invite.serverName)
                val computer = PairedComputer(
                    id = result.deviceId,
                    serverName = result.serverName,
                    baseUrl = invite.baseUrl,
                    token = result.token,
                    endpoints = (invite.endpoints + result.endpoints)
                        .filter { it != invite.baseUrl }
                        .distinct(),
                    lastUsedAt = System.currentTimeMillis(),
                    e2e = result.e2e ?: descriptor,
                )
                store.upsert(computer)
                store.selectedId = computer.id
                computers = store.computers
                Result.success(computer)
            } finally {
                connection.close()
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun pairWithCode(baseUrl: String, code: String, name: String?): Result<PairedComputer> =
        pairWith(PairingInvite(baseUrl, null, code, name ?: PairingInvite.hostOf(baseUrl), emptyList(), null))

    fun forget(computerId: String) {
        store.remove(computerId)
        computers = store.computers
        if (computer?.id == computerId) disconnect()
    }

    fun select(computerId: String) {
        val target = store.computers.firstOrNull { it.id == computerId } ?: return
        disconnect()
        store.selectedId = target.id
        connect(target)
    }

    // ------------------------------------------------------------ connection

    fun connect(saved: PairedComputer? = null) {
        val target = saved ?: store.computers.firstOrNull { it.id == store.selectedId }
            ?: store.computers.firstOrNull()
        if (target == null) {
            connection = ConnectionState(ConnectionState.Phase.IDLE)
            return
        }
        if (connecting.get()) return
        connecting.set(true)
        computer = target
        connection = ConnectionState(ConnectionState.Phase.CONNECTING, "正在连接 ${target.serverName}…", target.serverName)
        lastError = null
        val descriptor = target.e2e
        scope.launch {
            var established: E2EConnection? = null
            try {
                val api = if (descriptor != null) {
                    connection = connection.copy(detail = "正在建立端到端加密…")
                    val live = withContext(Dispatchers.IO) {
                        E2EClient(
                            descriptor = descriptor,
                            credential = target.token,
                            origins = (listOf(target.baseUrl) + target.endpoints).distinct(),
                        ).connect()
                    }
                    established = live
                    activeE2E = live
                    ApiClient(live.baseUrl, target.token, live.headerName, live.headerValue)
                } else {
                    ApiClient(target.baseUrl, target.token)
                }
                client = api
                val health = withContext(Dispatchers.IO) { api.health() }
                connection = connection.copy(
                    phase = ConnectionState.Phase.CONNECTING,
                    detail = health.optString("name", target.serverName),
                )
                refreshAll()
                startStream(api, target.lastCursor)
                val live = established
                if (live != null) {
                    scope.launch {
                        val ended = runCatching {
                            withContext(Dispatchers.IO) { live.session.closed.get() }
                        }.isSuccess
                        if (!ended) return@launch
                        if (activeE2E !== live || computer?.id != target.id) return@launch
                        delay(1_500)
                        if (activeE2E !== live || computer?.id != target.id) return@launch
                        disconnect()
                        connect(target)
                    }
                }
            } catch (e: Exception) {
                established?.close()
                activeE2E = null
                client = null
                connection = ConnectionState(ConnectionState.Phase.ERROR, e.message ?: "Could not reach the computer")
                lastError = e.message
            } finally {
                connecting.set(false)
            }
        }
    }

    private fun startStream(api: ApiClient, cursor: String?) {
        stream?.close()
        val next = api.stream(cursor)
        stream = next
        scope.launch(Dispatchers.IO) {
            next.run(
                onFrame = { frame -> scope.launch { handleFrame(frame) } },
                onCursor = { id -> computer?.let { store.cursor(it.id, id) } },
                onOpen = {
                    connection = ConnectionState(
                        ConnectionState.Phase.ONLINE,
                        "",
                        computer?.serverName ?: "",
                    )
                },
            )
        }
    }

    fun disconnect() {
        stream?.close()
        stream = null
        activeE2E?.close()
        activeE2E = null
        client = null
        computer = null
        bots.clear()
        groups.clear()
        messagesByThread.clear()
        moreByThread.clear()
        connection = ConnectionState()
    }

    suspend fun refreshAll() = withContext(Dispatchers.IO) {
        val api = client ?: return@withContext
        val answer = api.get("/api/bots?messages=50")
        val parsedBots = answer.arr("bots")?.objects()?.mapNotNull { Bot.parse(it) } ?: emptyList()
        val parsedGroups = answer.arr("groups")?.objects()?.mapNotNull { Group.parse(it) } ?: emptyList()
        val configAnswer = runCatching { api.get("/api/config") }.getOrNull()
        withContext(Dispatchers.Main) {
            bots.clear()
            bots.addAll(parsedBots.sortedWith(compareByDescending<Bot> { it.pinned }.thenBy { it.name }))
            groups.clear()
            groups.addAll(parsedGroups)
            config = configAnswer
        }
        if (parsedBots.isEmpty() && parsedGroups.isEmpty() && answer.has("error")) {
            throw ApiException(401, answer.optString("error"))
        }
    }

    // ----------------------------------------------------------------- frames

    private fun handleFrame(frame: JSONObject) {
        when (frame.optString("kind")) {
            "hello" -> {
                val resumed = frame.optBoolean("resumed")
                connection = connection.copy(phase = ConnectionState.Phase.ONLINE)
                // A hello that could not replay the gap means the phone may
                // have missed messages: hydrate everything visible once.
                if (!resumed) scope.launch { runCatching { refreshAll(); openThreadId?.let { loadThread(it, force = true) } } }
            }
            "bot" -> frame.obj("bot")?.let { json ->
                Bot.parse(json)?.let(::upsertBot)
            }
            "bots.order" -> {
                val order = frame.arr("botIds")?.let { arr ->
                    (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotBlank) }
                } ?: return
                val byId = bots.associateBy { it.id }
                val sorted = order.mapNotNull { byId[it] } + bots.filterNot { it.id in order }
                bots.clear()
                bots.addAll(sorted)
            }
            "group" -> frame.obj("group")?.let { json ->
                Group.parse(json)?.let { group ->
                    val index = groups.indexOfFirst { it.id == group.id }
                    if (index >= 0) groups[index] = group else groups.add(group)
                }
            }
            "group.deleted" -> {
                val id = frame.str("groupId") ?: return
                groups.removeAll { it.id == id }
            }
            "message" -> {
                val threadId = frame.str("threadId") ?: return
                val message = frame.obj("message")?.let { Message.parse(it) } ?: return
                appendMessage(threadId, message)
                maybeNotify(message, threadId)
            }
            "message.patch" -> {
                val threadId = frame.str("threadId") ?: return
                val message = frame.obj("message")?.let { Message.parse(it) } ?: return
                patchMessage(threadId, message)
            }
            "thread" -> {
                val threadId = frame.str("threadId") ?: return
                if (threadId == openThreadId) markRead(threadId)
            }
            "notify" -> {
                val notification = frame.obj("notification") ?: return
                val id = notification.str("id") ?: notification.str("createdAt")
                if (id != null && !notifiedIds.add(id)) return
                onNotification?.invoke(
                    NotificationPayload(
                        botId = notification.str("botId"),
                        threadId = notification.str("threadId"),
                        title = notification.str("title") ?: "OpenMausBot",
                        body = notification.str("body") ?: notification.str("text") ?: "",
                    )
                )
            }
            "config" -> scope.launch { runCatching { client?.get("/api/config")?.let { config = it } } }
        }
    }

    private fun upsertBot(bot: Bot) {
        val index = bots.indexOfFirst { it.id == bot.id }
        if (index >= 0) {
            bots[index] = bot
        } else {
            bots.add(bot)
        }
        // Keep the pinned-first order stable without dropping a live frame.
        bots.sortWith(compareByDescending<Bot> { it.pinned }.thenBy { it.name })
    }

    private fun appendMessage(threadId: String, message: Message) {
        val existing = messagesByThread[threadId].orEmpty()
        val withoutOptimistic = if (message.isUser) {
            existing.filterNot { it.pending && it.text == message.text }
        } else {
            existing
        }
        val index = withoutOptimistic.indexOfFirst { it.id == message.id }
        val next = when {
            index >= 0 -> withoutOptimistic.toMutableList().also { it[index] = message }
            else -> (withoutOptimistic + message).toMutableList()
        }
        messagesByThread[threadId] = next.sortedBy { it.createdAt }
        // A settled bot line for a thread we are looking at is read.
        if (threadId == openThreadId && !message.isUser) markReadLocally(threadId, message.id)
    }

    private fun patchMessage(threadId: String, message: Message) {
        val existing = messagesByThread[threadId].orEmpty()
        val index = existing.indexOfFirst { it.id == message.id }
        messagesByThread[threadId] = if (index >= 0) {
            existing.toMutableList().also { it[index] = message }
        } else {
            existing + message
        }
    }

    private fun maybeNotify(message: Message, threadId: String) {
        if (!message.isBot || message.kind != "text") return
        if (threadId == openThreadId && AppForeground.isForeground) return
        val bot = bots.firstOrNull { it.id == threadBotId(threadId) } ?: return
        if (!bot.notifications) return
        val text = message.text.takeIf { it.isNotBlank() } ?: return
        onNotification?.invoke(
            NotificationPayload(bot.id, threadId, bot.name, text.take(220))
        )
    }

    private fun threadBotId(threadId: String): String? =
        bots.firstOrNull { bot -> bot.tasks.any { it.threadId == threadId } }?.id

    // ------------------------------------------------------------ transcripts

    fun messages(threadId: String): List<Message> = messagesByThread[threadId].orEmpty()
    fun hasMore(threadId: String): Boolean = moreByThread[threadId] ?: true
    fun isLoading(threadId: String): Boolean = loadingThreads[threadId] ?: false

    suspend fun loadThread(threadId: String, force: Boolean = false) {
        if (threadId.isBlank()) return
        if (!force && messagesByThread[threadId]?.isNotEmpty() == true) return
        loadingThreads[threadId] = true
        try {
            withContext(Dispatchers.IO) {
                val api = client ?: return@withContext
                val answer = api.get("/api/threads/$threadId/messages?limit=50")
                val json = when {
                    answer.has("messages") -> answer.arr("messages")
                    else -> null
                }
                val messages = (json?.objects() ?: emptyList()).mapNotNull { Message.parse(it) }
                moreByThread[threadId] = answer.bool("hasMore", answer.bool("more", false)) ||
                    answer.str("before") != null
                withContext(Dispatchers.Main) {
                    val optimistic = messagesByThread[threadId].orEmpty().filter { it.pending }
                    messagesByThread[threadId] = (messages + optimistic).distinctBy { it.id }.sortedBy { it.createdAt }
                    moreByThread[threadId] = answer.bool("hasMore", answer.bool("more", messages.size >= 50))
                }
            }
        } catch (e: Exception) {
            lastError = e.message
        } finally {
            loadingThreads[threadId] = false
        }
    }

    suspend fun loadOlder(threadId: String) {
        val current = messagesByThread[threadId].orEmpty()
        val oldest = current.firstOrNull { !it.pending } ?: return
        loadingThreads[threadId] = true
        try {
            withContext(Dispatchers.IO) {
                val api = client ?: return@withContext
                val answer = api.get("/api/threads/$threadId/messages?before=${oldest.id}&limit=50")
                val messages = answer.arr("messages")?.objects()?.mapNotNull { Message.parse(it) } ?: emptyList()
                withContext(Dispatchers.Main) {
                    messagesByThread[threadId] = (messages + messagesByThread[threadId].orEmpty())
                        .distinctBy { it.id }.sortedBy { it.createdAt }
                    moreByThread[threadId] = messages.isNotEmpty()
                }
            }
        } catch (e: Exception) {
            lastError = e.message
        } finally {
            loadingThreads[threadId] = false
        }
    }

    fun openThread(threadId: String) {
        openThreadId = threadId
        scope.launch {
            loadThread(threadId, force = true)
            markRead(threadId)
        }
    }

    fun markRead(threadId: String) {
        val botId = threadBotId(threadId)
        markReadLocally(threadId, null)
        if (botId == null) return
        scope.launch(Dispatchers.IO) {
            runCatching {
                client?.post("/api/bots/$botId/read", JSONObject().put("threadId", threadId))
            }
        }
    }

    private fun markReadLocally(threadId: String, messageId: String?) {
        val bot = bots.firstOrNull { b -> b.tasks.any { it.threadId == threadId } } ?: return
        val updated = bot.copy(
            unread = false,
            tasks = bot.tasks.map { task ->
                if (task.threadId == threadId) task.copy(unread = false, lastReadMessageId = messageId ?: task.lastReadMessageId)
                else task
            },
        )
        upsertBot(updated)
    }

    // ---------------------------------------------------------------- actions

    fun send(botId: String, threadId: String, text: String, attachments: List<Attachment> = emptyList()) {
        val api = client ?: return
        val trimmed = text.trim()
        if (trimmed.isEmpty() && attachments.isEmpty()) return
        val optimisticId = "pending-" + java.util.UUID.randomUUID()
        val optimistic = Message(
            id = optimisticId,
            role = "user",
            kind = "text",
            text = trimmed,
            createdAt = System.currentTimeMillis(),
            card = null,
            tool = null,
            attachments = attachments,
            turnId = null,
            queueId = null,
            fromName = null,
            fromColor = null,
            editedAt = null,
            pending = true,
        )
        messagesByThread[threadId] = messagesByThread[threadId].orEmpty() + optimistic
        scope.launch(Dispatchers.IO) {
            try {
                val body = JSONObject().apply {
                    put("threadId", threadId)
                    put("text", trimmed)
                    put("clientId", optimisticId)
                    if (attachments.isNotEmpty()) {
                        put("attachments", JSONArray().apply {
                            attachments.forEach { attachment ->
                                put(JSONObject().put("kind", attachment.kind).put("path", attachment.path).put("mime", attachment.mime))
                            }
                        })
                    }
                }
                api.post("/api/bots/$botId/messages", body)
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    lastError = e.message
                    messagesByThread[threadId] = messagesByThread[threadId].orEmpty().map {
                        if (it.id == optimisticId) it.copy(pending = false, failed = true) else it
                    }
                }
            }
        }
    }

    fun interrupt(botId: String, threadId: String) {
        scope.launch(Dispatchers.IO) {
            runCatching {
                client?.post("/api/bots/$botId/interrupt", JSONObject().put("threadId", threadId))
            }
        }
    }

    /** The harness takes one verdict per pending request: `allow`, `deny`, or
     *  `answer` with the words a question needs. It is addressed by thread, so
     *  a room and a bot chat answer through the same door. */
    fun respondCard(botId: String, threadId: String, message: Message, answer: String) {
        val card = message.card ?: return
        val requestId = card.requestId ?: return
        val lower = answer.lowercase()
        val behavior = when {
            lower == "allow" || lower == "always allow" || lower.contains("allow once") -> "allow"
            lower == "deny" || lower == "reject" || lower.contains("don't allow") || lower.contains("deny") -> "deny"
            else -> "answer"
        }
        scope.launch(Dispatchers.IO) {
            try {
                val body = JSONObject().apply {
                    put("requestId", requestId)
                    put("behavior", behavior)
                    if (behavior == "answer") put("message", answer)
                }
                client?.post("/api/threads/$threadId/respond", body)
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { lastError = e.message }
            }
        }
    }

    fun alwaysAllow(botId: String, threadId: String, card: Card) {
        val requestId = card.requestId ?: return
        scope.launch(Dispatchers.IO) {
            runCatching {
                client?.post(
                    "/api/bots/$botId/always-allow",
                    JSONObject().put("threadId", threadId).put("requestId", requestId),
                )
            }
        }
    }

    fun deleteQueued(botId: String, threadId: String, queueId: String) {
        scope.launch(Dispatchers.IO) {
            runCatching { client?.delete("/api/bots/$botId/queue/$queueId") }
        }
    }

    fun createBot(name: String): String? {
        val api = client ?: return null
        var createdId: String? = null
        runCatching {
            val answer = api.post("/api/bots", JSONObject().put("name", name))
            createdId = answer.optJSONObject("bot")?.optString("id")
        }.onFailure { lastError = it.message }
        scope.launch { runCatching { refreshAll() } }
        return createdId
    }

    fun patchBot(botId: String, fields: JSONObject) {
        scope.launch(Dispatchers.IO) {
            try {
                val answer = client?.patch("/api/bots/$botId", fields)
                answer?.optJSONObject("bot")?.let { Bot.parse(it) }?.let { withContext(Dispatchers.Main) { upsertBot(it) } }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { lastError = e.message }
            }
        }
    }

    fun setModel(botId: String, instanceId: String, model: String, effort: String?) {
        scope.launch(Dispatchers.IO) {
            try {
                val selection = JSONObject().put("instanceId", instanceId).put("model", model)
                effort?.let { selection.put("effort", it) }
                client?.patch("/api/bots/$botId/model", JSONObject().put("modelSelection", selection))
                withContext(Dispatchers.Main) { runCatching { refreshAll() } }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { lastError = e.message }
            }
        }
    }

    fun sendToGroup(groupId: String, threadId: String, text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        scope.launch(Dispatchers.IO) {
            try {
                client?.post(
                    "/api/groups/$groupId/messages",
                    JSONObject().put("threadId", threadId).put("text", trimmed),
                )
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { lastError = e.message }
            }
        }
    }

    suspend fun uploadImage(bytes: ByteArray, mime: String, filename: String): Result<Attachment> =
        withContext(Dispatchers.IO) {
            runCatching {
                val answer = client!!.uploadImage(bytes, mime, filename)
                val url = answer.optString("url").takeIf { it.isNotBlank() }
                    ?: answer.optString("path").takeIf { it.isNotBlank() }
                    ?: throw ApiException(500, "上传未返回附件")
                Attachment(kind = "image", path = url, mime = mime, name = filename, durationMs = null)
            }
        }

    /** Attachments sit behind the device token, so the image is read through
     *  the same authenticated client rather than a bare URL. */
    suspend fun imageBytes(path: String): ByteArray? = withContext(Dispatchers.IO) {
        runCatching { client?.bytes(if (path.startsWith("/")) path else "/api/attachments/$path") }.getOrNull()
    }

    fun imageUrl(path: String): String = when {
        path.startsWith("http://") || path.startsWith("https://") -> path
        path.startsWith("/") -> (computer?.baseUrl ?: "") + path
        else -> (computer?.baseUrl ?: "") + "/api/attachments/" + path
    }

    fun clearError() {
        lastError = null
    }
}

/** Tracks whether any activity is resumed, so a notification is only raised
 *  when the person is not already looking at the chat. */
object AppForeground {
    @Volatile var isForeground: Boolean = false
}
