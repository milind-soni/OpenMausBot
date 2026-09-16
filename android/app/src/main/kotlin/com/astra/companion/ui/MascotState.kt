package com.astra.companion.ui

import com.astra.companion.core.Bot
import com.astra.companion.core.Chat
import com.astra.companion.core.CompanionState
import com.astra.companion.core.Message

/**
 * Which face a bot wears — the desktop's `stateForBot`, ported from
 * `ios/App/MascotState.swift`.
 *
 * A pinned expression wins; then what the bot is doing right now; then a guess
 * from its role. Same rules, same order, so a bot looks the same on the phone as
 * on the laptop.
 */

/** The desktop's legacy names, kept so an older bot record still resolves. */
private val legacy: Map<String, AstraState> = mapOf(
    "deadpan" to AstraState.IDLE,
    "friendly" to AstraState.HAPPY,
    "focused" to AstraState.WORKING,
    "thinking" to AstraState.THINKING,
    "excited" to AstraState.EXCITED,
    "sleepy" to AstraState.DROWSY,
    "surprised" to AstraState.SURPRISED,
    "skeptical" to AstraState.SUSPICIOUS,
    "worried" to AstraState.SCARED,
    "mischievous" to AstraState.PLAYFUL,
)

private val byId: Map<String, AstraState> = AstraState.entries.associateBy(AstraState::id)

/**
 * A face a bot's description argues for, and the words that argue for it. Whole
 * words only: a "codebase" bot is not a coder, and "qa" must not match "aqua".
 */
private class RoleFace(val state: AstraState, words: List<String>) {
    private val patterns = words.map { Regex("\\b${Regex.escape(it)}\\b") }

    fun matches(profile: String): Boolean = patterns.any { it.containsMatchIn(profile) }
}

/** In order: the first that matches wins, as on the desktop. */
private val roleFaces: List<RoleFace> = listOf(
    RoleFace(
        AstraState.WORKING,
        listOf("code", "coding", "developer", "development", "engineer", "engineering", "build", "debug", "program", "software"),
    ),
    RoleFace(
        AstraState.SEARCHING,
        listOf("research", "researcher", "search", "investigate", "strategy", "strategist", "study", "learn", "knowledge"),
    ),
    RoleFace(
        AstraState.EXCITED,
        listOf("marketing", "growth", "launch", "campaign", "social", "sales", "outreach", "brand"),
    ),
    RoleFace(
        AstraState.DROWSY,
        listOf("overnight", "night", "background", "async", "queue", "batch", "long-running"),
    ),
    RoleFace(
        AstraState.RADAR,
        listOf("monitor", "monitoring", "incident", "alert", "watch", "status", "uptime"),
    ),
    RoleFace(
        AstraState.SUSPICIOUS,
        listOf("review", "reviewer", "audit", "critic", "critique", "quality", "qa", "test", "legal"),
    ),
    RoleFace(
        AstraState.SCARED,
        listOf("security", "secure", "compliance", "risk", "privacy", "finance", "financial"),
    ),
    RoleFace(
        AstraState.PLAYFUL,
        listOf("design", "designer", "creative", "brainstorm", "art", "illustration", "music", "story"),
    ),
    RoleFace(
        AstraState.HAPPY,
        listOf("support", "help", "success", "onboarding", "coach", "teacher", "guide", "welcome"),
    ),
)

/** Resolves any stored value — current, legacy or junk — to a real state. */
internal fun AstraState.Companion.normalize(value: String?): AstraState? {
    if (value.isNullOrEmpty()) return null
    return byId[value] ?: legacy[value]
}

internal fun AstraState.Companion.forBot(bot: Bot, last: Message?): AstraState {
    normalize(bot.mascotExpression)?.let { return it }

    if (last?.kind == Message.Kind.ACTIVITY && last.tool?.ok == false) return AstraState.ALERTING
    if (bot.busy == true) return AstraState.WORKING
    if (bot.unread) return AstraState.NOTIFYING
    if (last?.kind == Message.Kind.OPTIONS) return AstraState.CURIOUS

    val profile = "${bot.name} ${bot.title} ${bot.description}".lowercase()
    for (role in roleFaces) {
        if (role.matches(profile)) return role.state
    }
    return AstraState.IDLE
}

/**
 * The face for a chat as a whole: a bot's own, a room's is "happy" — which is what
 * the desktop draws for room avatars.
 */
internal fun AstraState.Companion.forChat(chat: Chat, state: CompanionState): AstraState =
    forChat(chat, state.visibleTranscript(chat.threadId).lastOrNull())

/** The same, for a caller that already walked the chat's visible transcript. */
internal fun AstraState.Companion.forChat(chat: Chat, last: Message?): AstraState = when (chat) {
    is Chat.BotChat -> forBot(chat.bot, last)
    is Chat.RoomChat -> AstraState.HAPPY
}
