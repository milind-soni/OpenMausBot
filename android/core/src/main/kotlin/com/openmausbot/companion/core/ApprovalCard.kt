package com.openmausbot.companion.core

import kotlinx.serialization.Serializable

// How an approval card reads on a phone — the port of
// `ios/Sources/CompanionCore/ApprovalCard.swift`.
//
// The computer's subtitle for a held outbound action is the whole request:
// "Linear · Create linear comment" followed by the raw JSON arguments, once per
// call. That is the right record for the desktop and the audit log, and the
// wrong first thing to read on a phone. These helpers give the card a short
// headline and one summary line, keep the full text for a collapsed Details
// section, and turn the stored verdict ("allow") into words.

/** One app action an outbound card covers, in the order the subtitle lists them. */
@Serializable
data class OutboundCall(
    val app: String? = null,
    val label: String,
)

/** `card.outboundRequest`. [calls] is absent on cards from older computers; the subtitle is parsed instead. */
@Serializable
data class OutboundRequest(
    val tool: String? = null,
    val app: String? = null,
    val calls: List<OutboundCall>? = null,
)

/** `card.teamMemoryRequest`. Only its presence matters here: it makes "allow" read as "Remembered". */
@Serializable
data class TeamMemoryRequest(
    val section: String? = null,
    val entryId: String? = null,
    val kind: String? = null,
)

/** Which layout a card gets. */
enum class CardPresentation {
    /** "Send on your behalf?": headline names the app, one summary line, the request under Details. */
    OUTBOUND,

    /** A provider's or a teammate's permission ask: the title, the first line, the rest under Details. */
    APPROVAL,

    /**
     * Everything else — skill, routine, profile, model and team-setup proposals,
     * team memory, legacy questions — shows in full.
     */
    STANDARD,
}

/** What a settled card says happened. */
sealed interface CardOutcome {
    /** Whether the verdict let the request through, for the icon. */
    val isPositive: Boolean

    data object Allowed : CardOutcome { override val isPositive = true }
    data object Denied : CardOutcome { override val isPositive = false }

    /** The request behind the card went away before anyone answered. */
    data object Unavailable : CardOutcome { override val isPositive = false }
    data object Remembered : CardOutcome { override val isPositive = true }
    data object Skipped : CardOutcome { override val isPositive = false }

    /** A legacy question answered with words (`answeredText`; may be empty). */
    data class Answered(val text: String) : CardOutcome { override val isPositive = true }

    /** A proposal settled by one of its own options ("Confirm", "Cancel"). */
    data class Chose(val option: String, override val isPositive: Boolean) : CardOutcome

    /** A value this build does not know, shown as stored. */
    data class Other(val value: String) : CardOutcome { override val isPositive = false }
}

object ApprovalCards {
    /** The tools a teammate approval card carries (`server/peer-approval.ts`). */
    val PEER_APPROVAL_TOOLS = setOf("ask_bot", "delegate_bot", "post_to_room")

    /** Longest summary or preview line before it is cut with an ellipsis. */
    const val SUMMARY_LIMIT = 140

    /** At most this many distinct actions are named on the summary line. */
    const val SUMMARY_GROUPS = 3

    /**
     * The subtitle is `App · Label` then the arguments on the next line, per
     * call, calls separated by a blank line. JSON.stringify never writes a raw
     * newline, so the first line of each block is always its heading.
     */
    fun parseOutboundCalls(subtitle: String): List<OutboundCall> {
        val calls = mutableListOf<OutboundCall>()
        for (block in subtitle.split("\n\n")) {
            val heading = block.substringBefore('\n').trim()
            if (heading.isEmpty()) return emptyList()
            val separator = heading.indexOf(" · ")
            if (separator >= 0) {
                val app = heading.substring(0, separator).trim()
                val label = heading.substring(separator + " · ".length).trim()
                if (app.isEmpty() || label.isEmpty()) return emptyList()
                calls += OutboundCall(app, label)
            } else {
                calls += OutboundCall(null, heading)
            }
        }
        return calls
    }

    /** Each distinct action once, in first-seen order, "×N" when repeated. */
    fun collapse(calls: List<OutboundCall>, namingApps: Boolean): String {
        val counts = LinkedHashMap<OutboundCall, Int>()
        for (call in calls) counts[call] = (counts[call] ?: 0) + 1
        val parts = counts.entries.take(SUMMARY_GROUPS).map { (call, count) ->
            val name = if (namingApps) listOfNotNull(call.app, call.label).joinToString(" · ") else call.label
            if (count > 1) "$name ×$count" else name
        }
        val hidden = counts.size - parts.size
        val line = parts.joinToString(", ")
        return if (hidden > 0) "$line, +$hidden more" else line
    }

    /** The first non-empty line, trimmed, cut at [SUMMARY_LIMIT]. */
    fun firstLine(text: String): String {
        val line = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        if (line.length <= SUMMARY_LIMIT) return line
        return line.take(SUMMARY_LIMIT - 1).trim() + "…"
    }
}

val OptionCard.presentation: CardPresentation
    get() = when {
        outboundRequest != null -> CardPresentation.OUTBOUND
        teamMemoryRequest != null || skillRequest != null || requestType == "question" -> CardPresentation.STANDARD
        requestType == "permission" -> CardPresentation.APPROVAL
        tool != null && tool in ApprovalCards.PEER_APPROVAL_TOOLS -> CardPresentation.APPROVAL
        // A permission card from a computer older than `requestType`: it has a
        // tool and offers "Allow". No proposal offers that word.
        tool != null && options.any { it.equals("Allow", ignoreCase = true) } -> CardPresentation.APPROVAL
        else -> CardPresentation.STANDARD
    }

/** The calls an outbound card covers: the computer's own list, else read back from the subtitle. */
val OptionCard.outboundCalls: List<OutboundCall>
    get() {
        val request = outboundRequest ?: return emptyList()
        request.calls?.takeIf { it.isNotEmpty() }?.let { return it }
        return ApprovalCards.parseOutboundCalls(subtitle)
    }

/** The one app an outbound card sends to, or null when it names several, none, or could not be read. */
val OptionCard.outboundApp: String?
    get() {
        val calls = outboundCalls
        if (calls.isEmpty() || calls.any { it.app == null }) return null
        return calls.mapNotNull { it.app }.toSet().singleOrNull()
    }

/** The bold first line, in English. The app draws the localized form of the same rule. */
val OptionCard.headline: String
    get() {
        if (presentation != CardPresentation.OUTBOUND) return title
        return outboundApp?.let { "Send to $it?" } ?: "Send on your behalf?"
    }

/** The line under the headline. Standard cards keep their whole subtitle. */
val OptionCard.summaryLine: String
    get() = when (presentation) {
        CardPresentation.OUTBOUND -> ApprovalCards.collapse(outboundCalls, namingApps = outboundApp == null)
        CardPresentation.APPROVAL -> ApprovalCards.firstLine(subtitle)
        CardPresentation.STANDARD -> subtitle
    }

/** Whether Details would show anything the summary does not. */
val OptionCard.hasDetails: Boolean
    get() {
        val full = subtitle.trim()
        if (full.isEmpty()) return false
        return when (presentation) {
            CardPresentation.OUTBOUND -> true
            CardPresentation.APPROVAL -> full != summaryLine
            CardPresentation.STANDARD -> false
        }
    }

/** One short line for the roster row and the Needs-you pill. Never the raw request. */
val OptionCard.previewLine: String
    get() = when (presentation) {
        CardPresentation.OUTBOUND -> {
            val calls = outboundCalls
            val app = outboundApp
            when {
                calls.isEmpty() -> headline
                app != null -> "$app · ${ApprovalCards.collapse(calls, namingApps = false)}"
                else -> ApprovalCards.collapse(calls, namingApps = true)
            }
        }
        else -> ApprovalCards.firstLine(subtitle).ifEmpty { title }
    }

/**
 * An answered permission or outbound card has done its job: the bot's next
 * message says what happened, and the card's request and verdict are clutter
 * on a phone. Proposals keep their settled card.
 */
val OptionCard.leavesTranscriptWhenSettled: Boolean
    get() = !isPending && presentation != CardPresentation.STANDARD

/**
 * The "why this asked" note is for deciding. Once the card is settled it has
 * done its job; an outbound card's headline already says it. A free-text note
 * written after the decision (an error, no catalog key) on a proposal still
 * explains what happened, so that one stays.
 */
val OptionCard.showsHeldNote: Boolean
    get() = when {
        held.isNullOrEmpty() -> false
        presentation == CardPresentation.OUTBOUND -> false
        isPending -> true
        else -> presentation == CardPresentation.STANDARD && heldCode == null
    }

/** What a settled card says happened, or null while nothing was decided. `expired` has its own line. */
val OptionCard.outcome: CardOutcome?
    get() {
        val stored = answered ?: return null
        val value = stored.trim().lowercase()
        when (value) {
            "unavailable" -> return CardOutcome.Unavailable
            "answer" -> return CardOutcome.Answered(answeredText.orEmpty())
        }
        val positive = when {
            value in setOf("allow", "allowed", "approve", "approved") -> true
            value in setOf("deny", "denied", "reject", "rejected") -> false
            else -> {
                // An older store kept the button's own text.
                val option = options.firstOrNull { it.equals(stored, ignoreCase = true) }
                    ?: return CardOutcome.Other(stored)
                !OptionCard.isRefusal(option)
            }
        }
        if (teamMemoryRequest != null || tool == "propose_team_memory") {
            return if (positive) CardOutcome.Remembered else CardOutcome.Skipped
        }
        if (presentation == CardPresentation.STANDARD) {
            // A proposal reads as the option it was settled with.
            val chosen = if (positive) options.firstOrNull { !OptionCard.isRefusal(it) }
                else options.firstOrNull { OptionCard.isRefusal(it) }
            val plain = if (positive) "Allow" else "Deny"
            if (chosen != null && !chosen.equals(plain, ignoreCase = true)) {
                return CardOutcome.Chose(chosen, positive)
            }
        }
        return if (positive) CardOutcome.Allowed else CardOutcome.Denied
    }
