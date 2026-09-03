package com.openmausbot.companion.core

data class PendingApproval(val threadId: String, val message: Message)

/**
 * A derived sidebar heading, not a persisted resource. The desktop stores
 * membership on every bot/channel; section order itself is not synchronized.
 */
data class SidebarSection(
    val name: String,
    val chiefs: List<Bot>,
    val bots: List<Bot>,
    val channels: List<Room>,
) {
    val id: String get() = name
}

data class CompanionState(
    val bots: List<Bot> = emptyList(),
    val rooms: List<Room> = emptyList(),
    val messages: Map<String, List<Message>> = emptyMap(),
    val hasMore: Map<String, Boolean> = emptyMap(),
    val cursor: String? = null,
    val notifications: List<NotificationFrame> = emptyList(),
    val streaming: Map<String, String> = emptyMap(),
    val reasoning: Map<String, String> = emptyMap(),
    val screens: Map<String, ScreenFrame> = emptyMap(),
    /**
     * Mid-turn sends the harness is holding until the current turn settles,
     * by thread. They are deliberately NOT in [messages]: appending one now
     * would make it the active leaf, and the rest of the running turn would
     * hang off a line the model never saw. So the harness keeps them and this
     * is the phone's copy, shown as a row above the chat bar. Identified by
     * the harness's queueId, never by text.
     */
    val pendingQueued: Map<String, List<QueuedSend>> = emptyMap(),
    /**
     * queueIds whose drain frame beat the POST's own continuation. A short,
     * bounded tombstone list, so a slow response cannot re-add a row for a
     * message that is already in the transcript.
     */
    val drainedQueueIds: List<String> = emptyList(),
) {
    fun transcript(threadId: String): List<Message> = messages[threadId].orEmpty()

    fun visibleTranscript(threadId: String): List<Message> {
        val all = transcript(threadId)
        val leafId = botForThread(threadId)?.activeLeafId ?: return all
        val byId = all.associateBy(Message::id)
        var current = byId[leafId] ?: return all
        val visible = mutableListOf<Message>()
        val visited = mutableSetOf<String>()
        while (visited.add(current.id)) {
            visible += current
            val parentId = current.parentId ?: break
            current = byId[parentId] ?: break
        }
        return visible.asReversed()
    }

    fun bot(id: String): Bot? = bots.firstOrNull { it.id == id }
    fun botForThread(threadId: String): Bot? = bots.firstOrNull { it.threadId == threadId }
    fun roomForThread(threadId: String): Room? = rooms.firstOrNull { it.threadId == threadId }
    fun roomOwningTask(threadId: String): Room? = rooms.firstOrNull {
        it.threadId == threadId || it.tasks.orEmpty().any { task -> task.threadId == threadId }
    }

    /**
     * User-named headings in the desktop's natural order: ordinary bots,
     * Chiefs, then channels. A manual section ordering is not a server feature,
     * so this client does not make a local order look shared.
     */
    val sidebarSections: List<SidebarSection>
        get() {
            val visibleBots = bots.filter { it.hidden != true }
            val visibleChannels = rooms.filter { it.dm != true }
            val sectionChiefs = visibleBots.filter {
                it.chiefOfStaff == true && sectionName(it.section) != null
            }
            val sectionBots = visibleBots.filter {
                it.chiefOfStaff != true && !isSidebarPinned(it) && sectionName(it.section) != null
            }
            val names = buildList {
                (sectionBots.map(Bot::section) + sectionChiefs.map(Bot::section) +
                    visibleChannels.map(Room::section)).forEach { raw ->
                    sectionName(raw)?.takeIf { it !in this }?.let(::add)
                }
            }
            return names.map { name ->
                SidebarSection(
                    name = name,
                    chiefs = sectionChiefs.filter { sectionName(it.section) == name },
                    bots = sectionBots.filter { sectionName(it.section) == name },
                    channels = visibleChannels.filter { sectionName(it.section) == name },
                )
            }
        }

    val unsectionedChief: Bot?
        get() = bots.firstOrNull {
            it.hidden != true && it.chiefOfStaff == true && sectionName(it.section) == null
        }

    val unsectionedBots: List<Bot>
        get() = bots.filter {
            it.hidden != true && it.chiefOfStaff != true && !isSidebarPinned(it) &&
                sectionName(it.section) == null
        }

    /** Pinned is a virtual bucket; unpinning returns the bot to its saved section. */
    val pinnedBots: List<Bot>
        get() = bots.filter { it.hidden != true && isSidebarPinned(it) }

    val unsectionedChannels: List<Room>
        get() = rooms.filter { it.dm != true && sectionName(it.section) == null }

    val botChats: List<Room>
        get() = rooms.filter { it.dm == true }

    val pendingApprovals: List<PendingApproval>
        get() = (bots.map(Bot::threadId) + rooms.map(Room::threadId))
            .flatMap { threadId ->
                visibleTranscript(threadId)
                    .filter { it.card?.isPending == true }
                    .map { PendingApproval(threadId, it) }
            }
            .sortedByDescending { it.message.at }

    val unreadCount: Int
        get() = bots.count { it.unread && it.hidden != true } + rooms.count(Room::unread)

    fun hydrate(fleet: Fleet): CompanionState {
        val hydratedMessages = buildMap {
            fleet.bots.forEach { put(it.threadId, it.messages.orEmpty()) }
            fleet.groups.forEach { put(it.threadId, it.messages.orEmpty()) }
        }
        val hydratedHasMore = buildMap {
            fleet.bots.forEach { put(it.threadId, it.hasMore ?: false) }
            fleet.groups.forEach { put(it.threadId, it.hasMore ?: false) }
        }
        // A hydrate can be the first thing this window sees after a turn
        // settled behind its back, so rows it still holds may already have
        // drained into these transcripts.
        return copy(
            bots = fleet.bots,
            rooms = fleet.groups,
            messages = hydratedMessages,
            hasMore = hydratedHasMore,
        ).reconcileAllQueued()
    }

    fun prepend(page: ThreadPage, threadId: String): CompanionState {
        val existing = messages[threadId].orEmpty()
        val known = existing.mapTo(mutableSetOf(), Message::id)
        return copy(
            messages = messages + (threadId to (page.messages.filterNot { it.id in known } + existing)),
            hasMore = hasMore + (threadId to (page.hasMore ?: false)),
        )
    }

    fun merge(page: ThreadPage, threadId: String): CompanionState {
        val byId = transcript(threadId).associateByTo(linkedMapOf(), Message::id)
        page.messages.forEach { byId[it.id] = it }
        val merged = byId.values.sortedWith(compareBy<Message> { it.at }.thenBy { it.id })
        return copy(
            messages = messages + (threadId to merged),
            hasMore = page.hasMore?.let { hasMore + (threadId to it) } ?: hasMore,
        ).reconcileQueued(threadId)
    }

    fun versions(message: Message, threadId: String): List<Message> {
        if (message.role != Message.Role.USER || message.kind != Message.Kind.TEXT) return emptyList()
        return transcript(threadId)
            .filter {
                it.role == Message.Role.USER && it.kind == Message.Kind.TEXT && it.parentId == message.parentId
            }
            .sortedWith(compareBy<Message> { it.at }.thenBy { it.id })
    }

    fun apply(streamFrame: StreamFrame): CompanionState = apply(streamFrame.frame)

    fun apply(frame: Frame): CompanionState = when (frame) {
        is Frame.Hello -> this

        is Frame.Message -> {
            var result = copy(
                messages = append(messages, frame.threadId, frame.message),
                bots = bots.map {
                    if (
                        it.threadId == frame.threadId &&
                        frame.message.parentId == it.activeLeafId
                    ) {
                        it.copy(activeLeafId = frame.message.id)
                    } else {
                        it
                    }
                },
            )
            if (frame.message.role == Message.Role.BOT && frame.message.kind == Message.Kind.TEXT) {
                result = result.clearStream(frame.threadId)
            }
            frame.message.queueId?.let { result = result.retireQueued(it, frame.threadId) }
            result
        }

        is Frame.MessagePatch -> {
            val existing = transcript(frame.threadId)
            val index = existing.indexOfFirst { it.id == frame.message.id }
            val patched = if (index >= 0) {
                existing.toMutableList().also { it[index] = frame.message }
            } else {
                append(messages, frame.threadId, frame.message).getValue(frame.threadId)
            }
            copy(messages = messages + (frame.threadId to patched))
        }

        is Frame.Thread -> copy(
            bots = bots.map {
                if (it.threadId == frame.threadId) it.copy(activeLeafId = frame.activeLeafId) else it
            },
        ).clearStream(frame.threadId)

        is Frame.Bot -> applyBot(frame.bot)
        is Frame.BotDeleted -> deleteBot(frame.botId)
        is Frame.Room -> applyRoom(frame.room)
        is Frame.RoomDeleted -> deleteRoom(frame.groupId)

        is Frame.Notify -> copy(notifications = (notifications + frame.notification).takeLast(100))
        is Frame.Runtime -> applyRuntime(frame.event)
        is Frame.Screen -> copy(screens = screens + (frame.botId to ScreenFrame(frame.png, frame.mime)))

        is Frame.Computer, Frame.Config, is Frame.Unknown -> this
    }

    fun clearScreen(botId: String): CompanionState = copy(screens = screens - botId)

    fun clearStream(threadId: String): CompanionState = copy(
        streaming = streaming - threadId,
        reasoning = reasoning - threadId,
    )

    // MARK: - Held mid-turn sends

    /**
     * Remember a message the harness said it is holding.
     *
     * The drain frame can arrive before the POST that created the entry has
     * even returned — the harness settles a turn on its own clock. When it
     * already has, the words are in the transcript and adding a row for them
     * would show the message twice, so the tombstone wins and is spent.
     */
    fun rememberQueued(send: QueuedSend, threadId: String): CompanionState {
        if (send.queueId in drainedQueueIds) {
            return copy(drainedQueueIds = drainedQueueIds - send.queueId)
        }
        val waiting = pendingQueued[threadId].orEmpty()
        if (waiting.any { it.queueId == send.queueId }) return this
        return copy(pendingQueued = pendingQueued + (threadId to (waiting + send)))
    }

    /**
     * Drop a row with no tombstone — the entry is gone from the harness too,
     * so nothing can arrive later to be matched against it.
     */
    fun forgetQueued(queueId: String, threadId: String): CompanionState {
        val waiting = pendingQueued[threadId] ?: return this
        val rest = waiting.filterNot { it.queueId == queueId }
        return copy(
            pendingQueued = if (rest.isEmpty()) {
                pendingQueued - threadId
            } else {
                pendingQueued + (threadId to rest)
            },
        )
    }

    /** Drop a row because its line landed, and leave a tombstone behind. */
    private fun retireQueued(queueId: String, threadId: String): CompanionState {
        val tombstones = (drainedQueueIds + queueId).takeLast(MAX_DRAINED_QUEUE_IDS)
        return forgetQueued(queueId, threadId).copy(drainedQueueIds = tombstones)
    }

    /**
     * Reconcile rows against a transcript that arrived whole — a hydrate, a
     * page fetch, or a bot frame carrying its own messages. A window that was
     * backgrounded through the drain never saw the message frame, and its
     * rows have to go.
     */
    private fun reconcileQueued(threadId: String): CompanionState {
        if (!pendingQueued.containsKey(threadId)) return this
        val landed = transcript(threadId).mapNotNull(Message::queueId).toSet()
        if (landed.isEmpty()) return this
        return landed.fold(this) { state, queueId -> state.retireQueued(queueId, threadId) }
    }

    private fun reconcileAllQueued(): CompanionState =
        pendingQueued.keys.toList().fold(this) { state, threadId -> state.reconcileQueued(threadId) }

    fun resetCursor(cursor: String): CompanionState = copy(cursor = cursor)

    fun advance(seq: Int?): CompanionState {
        val current = cursor ?: return this
        if (seq == null || ':' !in current) return this
        return copy(cursor = "${current.substringBefore(':')}:$seq")
    }

    private fun applyBot(bot: Bot): CompanionState {
        val index = bots.indexOfFirst { it.id == bot.id }
        if (index < 0) {
            val nextMessages = if (messages.containsKey(bot.threadId)) {
                messages
            } else {
                messages + (bot.threadId to bot.messages.orEmpty())
            }
            return copy(bots = bots + bot, messages = nextMessages)
        }

        val previous = bots[index]
        if (bot.messages == null) {
            val merged = bot.copy(
                messages = previous.messages,
                activeLeafId = bot.activeLeafId ?: previous.activeLeafId,
            )
            val next = copy(bots = bots.replacing(index, merged))
            // A turn can end without a settled reply — an engine that dies
            // mid-sentence reports the failure as activity, not text — and
            // the half-written answer would otherwise sit in the buffer
            // streaming for ever.
            return if (bot.busy != true) next.clearStream(bot.threadId) else next
        }

        var result = copy(
            bots = bots.replacing(index, bot.copy(messages = bot.messages)),
            messages = messages + (bot.threadId to bot.messages),
            hasMore = hasMore + (bot.threadId to (bot.hasMore ?: false)),
        ).clearStream(previous.threadId)
        if (previous.threadId != bot.threadId) result = result.clearStream(bot.threadId)
        // A replacement bypasses `append`, which is what normally retires a
        // row. Without this the held message stays above the chat bar for
        // ever, long after its line has landed.
        return result.reconcileQueued(bot.threadId)
    }

    private fun deleteBot(botId: String): CompanionState {
        val bot = bots.firstOrNull { it.id == botId } ?: return this
        return copy(
            bots = bots.filterNot { it.id == botId },
            messages = messages - bot.threadId,
            hasMore = hasMore - bot.threadId,
            streaming = streaming - bot.threadId,
            reasoning = reasoning - bot.threadId,
            screens = screens - botId,
        )
    }

    private fun applyRoom(room: Room): CompanionState {
        val index = rooms.indexOfFirst { it.id == room.id }
        if (index < 0) {
            val nextMessages = if (messages.containsKey(room.threadId)) {
                messages
            } else {
                messages + (room.threadId to room.messages.orEmpty())
            }
            return copy(rooms = rooms + room, messages = nextMessages)
        }
        val previous = rooms[index]
        // Metadata-only room frames preserve the active transcript. A task
        // switch carries a replacement transcript and is authoritative.
        if (room.messages == null) {
            return copy(rooms = rooms.replacing(index, room.copy(messages = previous.messages)))
        }
        var result = copy(
            rooms = rooms.replacing(index, room.copy(messages = room.messages)),
            messages = messages + (room.threadId to room.messages),
            hasMore = hasMore + (room.threadId to (room.hasMore ?: false)),
        ).clearStream(previous.threadId)
        if (previous.threadId != room.threadId) result = result.clearStream(room.threadId)
        return result
    }

    private fun deleteRoom(groupId: String): CompanionState {
        val room = rooms.firstOrNull { it.id == groupId } ?: return this
        return copy(
            rooms = rooms.filterNot { it.id == groupId },
            messages = messages - room.threadId,
            hasMore = hasMore - room.threadId,
            streaming = streaming - room.threadId,
            reasoning = reasoning - room.threadId,
        )
    }

    private fun applyRuntime(event: RuntimeEvent): CompanionState {
        return when (event.type) {
            "content.delta" -> {
                val delta = event.delta
                if (delta.isNullOrEmpty()) {
                    this
                } else {
                    when (event.streamKind) {
                        "assistant_text" -> copy(
                            streaming = streaming + (event.threadId to (streaming[event.threadId].orEmpty() + delta)),
                        )
                        "reasoning_text" -> copy(
                            reasoning = reasoning + (event.threadId to (reasoning[event.threadId].orEmpty() + delta)),
                        )
                        else -> this
                    }
                }
            }
            "turn.completed", "turn.failed", "turn.aborted" -> clearStream(event.threadId)
            else -> this
        }
    }

    private companion object {
        fun sectionName(raw: String?): String? = raw?.trim()?.takeIf(String::isNotEmpty)

        fun isSidebarPinned(bot: Bot): Boolean = bot.pinned == true && bot.chiefOfStaff != true

        fun append(
            messages: Map<String, List<Message>>,
            threadId: String,
            message: Message,
        ): Map<String, List<Message>> {
            val thread = messages[threadId].orEmpty()
            val index = thread.indexOfFirst { it.id == message.id }
            val next = if (index >= 0) thread.replacing(index, message) else thread + message
            return messages + (threadId to next)
        }

        fun <T> List<T>.replacing(index: Int, value: T): List<T> =
            toMutableList().also { it[index] = value }

        /**
         * How many tombstones to keep. One per queued send that drained while
         * its own POST was still in flight — a handful at the very most, but
         * other clients queue into the same thread, so it is bounded.
         */
        const val MAX_DRAINED_QUEUE_IDS = 64
    }

}
