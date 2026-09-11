package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat

/**
 * Separate contexts for an agent or a channel — the rules behind
 * `ios/App/TaskManagerView.swift`.
 *
 * Tasks are conversation navigation, not host configuration, which is why they
 * are a compact sheet rather than a screen.
 */
object TaskRules {
    const val UNTITLED = "Untitled thread"

    /** The line that tells a task apart from a routine. */
    const val CONTEXT_FOOTER =
        "A thread is one conversation and result. Each routine keeps its results in one thread."

    /** The agent's job, or what this sheet is for when it has none. */
    fun subtitle(bot: Bot): String = bot.title.ifEmpty { "Agent threads" }

    fun subtitle(chat: Chat): String = when (chat) {
        is Chat.BotChat -> subtitle(chat.bot)
        is Chat.RoomChat -> "Group threads"
    }

    /** Filter navigation only; full task state still resolves run logs and approvals. */
    fun tasks(bot: Bot): List<BotTask> = bot.tasks.orEmpty().filter { it.routineRunId == null }

    fun tasks(chat: Chat): List<BotTask> = when (chat) {
        is Chat.BotChat -> tasks(chat.bot)
        is Chat.RoomChat -> chat.room.tasks.orEmpty()
    }

    fun title(task: BotTask): String = task.title.ifEmpty { UNTITLED }

    fun isCurrent(task: BotTask, bot: Bot): Boolean = task.threadId == bot.threadId

    fun isCurrent(task: BotTask, chat: Chat): Boolean = task.threadId == chat.threadId

    /** New desktops expose independent task activity; older ones serialize the bot. */
    private fun independent(bot: Bot): Boolean = bot.tasks.orEmpty().any { it.busy != null }

    fun canCreate(bot: Bot): Boolean = independent(bot) || bot.busy != true

    fun canCreate(chat: Chat): Boolean = when (chat) {
        is Chat.BotChat -> canCreate(chat.bot)
        is Chat.RoomChat -> !chat.busy
    }

    /** The last task cannot go — a bot without one has nowhere to talk. */
    fun canDelete(task: BotTask, bot: Bot): Boolean =
        tasks(bot).size > 1 && tasks(bot).any {
            it.threadId == task.threadId && if (independent(bot)) it.busy != true else bot.busy != true
        }

    fun canDelete(task: BotTask, chat: Chat): Boolean = when (chat) {
        is Chat.BotChat -> canDelete(task, chat.bot)
        is Chat.RoomChat -> tasks(chat).size > 1 && !chat.busy && tasks(chat).any { it.threadId == task.threadId }
    }

    /** Already being on a task is not a switch; legacy desktops still serialize. */
    fun canSwitch(task: BotTask, bot: Bot): Boolean = canCreate(bot) && !isCurrent(task, bot)

    fun canSwitch(task: BotTask, chat: Chat): Boolean = canCreate(chat) && !isCurrent(task, chat)

    /** Renaming is allowed while busy: it touches the label, not the thread. */
    fun canRename(bot: Bot): Boolean = true

    fun canRename(chat: Chat): Boolean = true
}

/**
 * The title dialogs share the live task rules, including legacy busy gates.
 */
object TaskDialogRules {
    /** Live: [bot] is re-read from the stream on every frame. */
    fun createEnabled(bot: Bot): Boolean = TaskRules.canCreate(bot)
    fun createEnabled(chat: Chat): Boolean = TaskRules.canCreate(chat)

    /**
     * Renaming has no busy gate and no emptiness gate. iOS sends the field as
     * typed and the server labels an empty title as the untitled task — refusing
     * to submit it would be this screen inventing a rule the product does not
     * have.
     */
    fun renameEnabled(bot: Bot, title: String): Boolean = TaskRules.canRename(bot)
    fun renameEnabled(chat: Chat, title: String): Boolean = TaskRules.canRename(chat)

    /** Create trims, and an empty title means "let the harness name it". */
    fun createTitle(raw: String): String? = raw.trim().ifEmpty { null }

    /** Rename sends the field as typed, as iOS does. */
    fun renameTitle(raw: String): String = raw
}
