package com.openmausbot.companion.core

/** A chat is a bot or a room. They share a thread, which is what every message is keyed by. */
sealed class Chat {
    abstract val id: String
    abstract val threadId: String
    abstract val name: String
    abstract val subtitle: String
    abstract val unread: Boolean
    abstract val busy: Boolean
    abstract val color: String

    /** Older desktops omit room tasks, so don't expose routes they do not support. */
    val supportsTasks: Boolean
        get() = when (this) {
            is BotChat -> true
            is RoomChat -> room.dm != true && room.tasks != null
        }

    data class BotChat(val bot: Bot) : Chat() {
        override val id: String get() = bot.id
        override val threadId: String get() = bot.threadId
        override val name: String get() = bot.name
        override val subtitle: String get() = bot.title
        override val unread: Boolean get() = bot.unread
        override val busy: Boolean get() = bot.busy == true
        override val color: String get() = bot.color
    }

    data class RoomChat(val room: Room) : Chat() {
        override val id: String get() = room.id
        override val threadId: String get() = room.threadId
        override val name: String get() = room.name
        override val subtitle: String get() = "${room.memberIds.size} bots"
        override val unread: Boolean get() = room.unread
        override val busy: Boolean get() = room.busyBotId != null
        override val color: String get() = "blue"
    }
}

sealed interface ChatTarget {
    val threadId: String

    data class Bot(
        val botId: String,
        override val threadId: String,
    ) : ChatTarget

    data class Room(
        val roomId: String,
        override val threadId: String,
    ) : ChatTarget
}

val Chat.target: ChatTarget
    get() = when (this) {
        is Chat.BotChat -> ChatTarget.Bot(bot.id, threadId)
        is Chat.RoomChat -> ChatTarget.Room(room.id, threadId)
    }

fun CompanionState.chat(target: ChatTarget): Chat? = when (target) {
    is ChatTarget.Bot -> bot(target.botId)?.forTask(target.threadId)?.let(Chat::BotChat)
    is ChatTarget.Room -> rooms.firstOrNull { it.id == target.roomId }?.let { room ->
        when {
            room.threadId == target.threadId -> Chat.RoomChat(room)
            room.tasks.orEmpty().any { it.threadId == target.threadId } -> Chat.RoomChat(
                room.copy(threadId = target.threadId, busyBotId = null, unread = false, messages = null, hasMore = null),
            )
            else -> null
        }
    }
}

/**
 * A chat plus the two things a roster row shows that the record itself does not carry:
 * the preview line, and when the thread last moved.
 */
data class ChatSummary(
    val chat: Chat,
    val preview: String,
    val lastActivity: Double,
    val pinned: Boolean,
) {
    val id: String get() = chat.id
}

/**
 * Everything worth showing in the chat list: pinned first, then unread, then most
 * recently active. Hidden bots stay hidden. Rooms never pin.
 *
 * @param activity how much of a bot's working-out the reader has asked to see. The preview honours
 * it the same way the transcript does; `lastActivity` deliberately does not, because a thread that
 * just ran a tool has still moved and should still rise in the list.
 */
fun CompanionState.chatSummaries(
    activity: ActivityDetail = ActivityDetail.FULL,
): List<ChatSummary> {
    val chats = bots.filter { it.hidden != true }.map { Chat.BotChat(it) } +
        rooms.map { Chat.RoomChat(it) }
    return chats
        .map { chat ->
            val messages = visibleTranscript(chat.threadId)
            ChatSummary(
                chat = chat,
                preview = rosterPreview(messages, activity),
                lastActivity = messages.lastOrNull()?.at ?: 0.0,
                pinned = pinned(chat),
            )
        }
        .sortedWith(
            compareByDescending<ChatSummary> { it.pinned }
                .thenByDescending { it.chat.unread }
                .thenByDescending { it.lastActivity },
        )
}

private fun pinned(chat: Chat): Boolean = when (chat) {
    is Chat.BotChat -> chat.bot.pinned == true
    is Chat.RoomChat -> false
}
