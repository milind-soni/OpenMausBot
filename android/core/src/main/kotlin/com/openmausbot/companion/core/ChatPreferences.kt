package com.openmausbot.companion.core

import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

/** How much of a bot's working activity the transcript shows. */
enum class ActivityDetail(val wireValue: String, val label: String, val caption: String) {
    FULL("full", "Full", "Every step a bot takes."),
    REDUCED("reduced", "Reduced", "Steps fold into one line. Failures always show."),
    HIDDEN("hidden", "Hidden", "No activity, only messages."),
    ;

    companion object {
        /**
         * What a phone starts with until the reader chooses: the phone should read
         * like a normal chat (Omkar, 2026-10-03), and the desktop likewise hides
         * tool calls until they are switched on. A stored choice wins.
         */
        val PHONE_DEFAULT: ActivityDetail = HIDDEN

        fun fromWire(value: String?): ActivityDetail =
            entries.firstOrNull { it.wireValue == value } ?: PHONE_DEFAULT
    }
}

/** One user-editable chip on the composer's quick-reply row. */
@Serializable
data class QuickReply(
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val prompt: String,
    val icon: String,
) {
    companion object {
        val DEFAULTS: List<QuickReply> = listOf(
            QuickReply("default.diff", "Show diff", "Show latest git diff", "diff"),
            QuickReply("default.tests", "Run tests", "Run all automated tests", "tests"),
            QuickReply("default.explain", "Explain steps", "Explain the changes in detail", "explain"),
            QuickReply("default.next", "What's next?", "What should we do next?", "next"),
        )

        val ICON_CHOICES: List<String> = listOf(
            "next", "diff", "tests", "explain", "build", "bug", "document", "terminal",
            "send", "search", "history", "list",
        )

        fun encode(replies: List<QuickReply>): String =
            runCatching { CompanionJson.encodeToString(replies) }.getOrDefault("")

        /**
         * An empty or corrupt store falls back to defaults. An encoded empty list is a deliberate
         * choice and remains empty.
         */
        fun decode(json: String): List<QuickReply> {
            if (json.isEmpty()) return DEFAULTS
            val decoded = runCatching {
                CompanionJson.decodeFromString<List<QuickReply>>(json)
            }.getOrElse { return DEFAULTS }
            val ids = decoded.map { it.id.trim() }
            if (ids.any(String::isEmpty) || ids.toSet().size != ids.size) return DEFAULTS
            return decoded
        }
    }
}

/** A transcript item: one message, consecutive activity, or completed narration. */
sealed interface TranscriptRow {
    val head: Message
    val id: String
    val at: Double get() = head.at
    val endAt: Double
    val role: Message.Role get() = head.role
    val kind: Message.Kind get() = head.kind
    val senderName: String? get() = head.from?.name

    /** Search and pagination anchors can land inside a folded row. */
    fun containsMessage(messageId: String): Boolean = when (this) {
        is Single -> message.id == messageId
        is ActivityRun -> items.any { it.id == messageId }
        is AssistantTurn -> items.any { it.id == messageId }
    }

    data class Single(val message: Message) : TranscriptRow {
        override val head: Message get() = message
        override val id: String get() = message.id
        override val endAt: Double get() = message.at
    }

    data class ActivityRun(val items: List<Message>) : TranscriptRow {
        init {
            require(items.isNotEmpty()) { "An activity run must contain at least one message." }
        }

        override val head: Message get() = items.first()
        override val id: String get() = "run.${head.id}"
        override val endAt: Double get() = items.last().at
        val running: Boolean get() = items.any { it.tool?.ok == null }
    }

    data class AssistantTurn(val turnId: String, val items: List<Message>, val elapsed: Double) : TranscriptRow {
        init {
            require(items.isNotEmpty()) { "A turn fold must contain narration." }
        }

        override val head: Message get() = items.first()
        override val id: String get() = "turn.$turnId"
        override val endAt: Double get() = items.last().at
        val label: String get() {
            if (elapsed < 1_000) return "Worked"
            val seconds = (elapsed / 1_000).toLong()
            val duration = if (seconds < 60) "${seconds}s"
                else "${seconds / 60}m ${(seconds % 60).toString().padStart(2, '0')}s"
            return "Worked for $duration"
        }
    }
}

/**
 * The one line a roster row shows under a chat's name.
 *
 * Folded by the same rule as the transcript, and for the same reason: a reader who has turned
 * activity off has said they do not want to see tool calls, and the roster is where they see the
 * most of them — one per chat, on the screen they spend the most time on. Reading the preview off
 * the raw last message made "Hidden" mean "hidden in one place".
 */
fun rosterPreview(messages: List<Message>, detail: ActivityDetail): String =
    // The digest chip follows every reply; the reply is what the row should say.
    when (val last = transcriptRows(messages, detail).lastOrNull { it.kind != Message.Kind.DIGEST }) {
        null -> ""
        is TranscriptRow.Single -> previewText(last.message)
        is TranscriptRow.ActivityRun ->
            "${if (last.running) "Running" else "Ran"} ${last.items.size} steps"
        is TranscriptRow.AssistantTurn -> last.label
    }

/** What a single message reads as in a roster row. */
internal fun previewText(message: Message): String = when (message.kind) {
    Message.Kind.TEXT -> message.webhookContent?.task
        ?: message.text?.takeIf { it.isNotEmpty() }
        // A bot that only sent a file says so by its name.
        ?: message.attachedFiles.firstOrNull()?.name.orEmpty()
    // a pending card's question is the preview, in its short form; the roster
    // row already says "waiting on you" beside it
    Message.Kind.OPTIONS -> {
        val card = message.card
        when {
            card == null -> ""
            card.isPending -> card.previewLine
            else -> card.headline
        }
    }
    Message.Kind.ACTIVITY -> message.tool?.label.orEmpty()
    Message.Kind.SCREEN -> "Screenshot"
    Message.Kind.DIGEST -> ""
    Message.Kind.COMPACTION -> message.compaction?.chipText ?: message.text.orEmpty()
    Message.Kind.ROUTINE_RUN -> message.routineRunPreview
    Message.Kind.UNKNOWN -> message.text.orEmpty()
}

/**
 * Rows the harness writes about a turn rather than in it: tool chips and, since
 * Phase 0, the digest and compaction receipts. Hidden together, because a reader
 * who turned activity off does not want the summary of exactly those calls either.
 * Port of `isActivityReceipt` in `ChatPreferences.swift`. A routine-run card is
 * not one: it is the run's result, and it stays whatever the setting.
 */
/**
 * A status row the server writes while a turn runs ("notice: Qwen hit a rate
 * limit and is retrying"). Port of `isStatusNotice` in `ChatPreferences.swift`:
 * it tells the reader what the bot is doing, so it is never hidden or folded.
 */
fun isStatusNotice(message: Message): Boolean =
    message.kind == Message.Kind.ACTIVITY && message.tool?.name?.startsWith("notice:") == true

/**
 * A turn that failed is stored as an activity row named "error: <what went wrong>"
 * (shared/failed-turn.ts on the computer). The cause without that marker; null for any
 * other row. Port of `failedTurnCause` in `ChatPreferences.swift`: the chip and the
 * roster preview both read it here, so neither shows the marker.
 */
fun failedTurnCause(name: String): String? =
    if (name.startsWith("error:")) name.removePrefix("error:").trim() else null

/**
 * A failed turn's row. Like a status notice it is never hidden: it is the only sign the
 * bot did not answer, and desktop always shows it too.
 */
fun isFailedTurn(message: Message): Boolean =
    message.kind == Message.Kind.ACTIVITY && message.tool?.let { failedTurnCause(it.name) } != null

/** What the chip and the roster say: a failed turn's cause, or the step. */
val ToolActivity.label: String get() = failedTurnCause(name) ?: name

fun isActivityReceipt(message: Message): Boolean = when (message.kind) {
    Message.Kind.ACTIVITY, Message.Kind.DIGEST, Message.Kind.COMPACTION -> true
    else -> false
}

/** The messages a bot has written so far in the turn it is still working on. Port of iOS `LiveNarration`. */
data class LiveNarration(
    /** Rows the transcript leaves out while the turn runs. */
    val hiddenIds: Set<String>,
    /** The newest of them: the one grey status line shown instead. */
    val latest: String?,
) {
    companion object {
        val NONE = LiveNarration(emptySet(), null)
    }
}

/**
 * At Hidden, a working bot's in-between messages ("Let me check the logs") are
 * one grey status line rather than a pile of bubbles (Omkar, 2026-10-03).
 *
 * Only the turn answering the latest message, only while the bot works, and only
 * until the server marks the turn's final reply: then the turn folds into its
 * "Worked for" row as at every other level. A turn that ends without that mark (an
 * older desktop, a crash) is no longer busy, so its messages show as bubbles and
 * nothing it said is lost.
 */
fun liveNarration(messages: List<Message>, busy: Boolean, detail: ActivityDetail): LiveNarration {
    if (!busy || detail != ActivityDetail.HIDDEN) return LiveNarration.NONE
    val lastUser = messages.indexOfLast { it.role == Message.Role.USER }
    val said = messages.drop(lastUser + 1)
        .filter { it.role == Message.Role.BOT && it.kind == Message.Kind.TEXT && !it.turnId.isNullOrEmpty() }
    val turn = said.lastOrNull()?.turnId ?: return LiveNarration.NONE
    val narration = said.filter { it.turnId == turn }
    if (narration.any { it.turnTerminal == true }) return LiveNarration.NONE
    return LiveNarration(narration.map { it.id }.toSet(), narration.lastOrNull()?.text)
}

/**
 * Fold a transcript to the selected activity detail. Failed steps are never folded in reduced
 * mode; hidden mode removes tool activity, failed steps included, but never a status notice
 * or a failed turn ([isFailedTurn]).
 */
fun transcriptRows(messages: List<Message>, detail: ActivityDetail): List<TranscriptRow> {
    // Only a server completion marker makes narration foldable. Legacy and
    // unfinished turns stay visible, matching desktop and iOS.
    val narration = mutableMapOf<String, MutableList<Message>>()
    val startedAt = mutableMapOf<String, Double>()
    var lastUserAt: Double? = null
    val folds = mutableMapOf<String, TranscriptRow.AssistantTurn>()
    val hiddenIds = mutableSetOf<String>()
    for (message in messages) {
        if (message.role == Message.Role.USER) lastUserAt = message.at
        val turnId = message.turnId?.takeIf { it.isNotEmpty() } ?: continue
        if (message.role != Message.Role.BOT || message.kind != Message.Kind.TEXT) continue
        if (message.turnTerminal == true) {
            val items = narration.remove(turnId)?.takeIf { it.isNotEmpty() } ?: continue
            folds[items.first().id] = TranscriptRow.AssistantTurn(
                turnId, items.toList(), (message.at - (startedAt[turnId] ?: items.first().at)).coerceAtLeast(0.0),
            )
            hiddenIds.addAll(items.map { it.id })
        } else {
            if (turnId !in narration) startedAt[turnId] = lastUserAt ?: message.at
            narration.getOrPut(turnId) { mutableListOf() }.add(message)
        }
    }
    return buildList {
        val run = mutableListOf<Message>()
        fun flush() {
            when (run.size) {
                0 -> Unit
                1 -> add(TranscriptRow.Single(run.single()))
                else -> add(TranscriptRow.ActivityRun(run.toList()))
            }
            run.clear()
        }

        messages.forEach { message ->
            // Match iOS: a receipt with no recorded work should not leave a
            // chip or an empty row after every ordinary conversational reply.
            if (message.kind == Message.Kind.DIGEST && TurnDigest.parse(message.text).sections.isEmpty()) return@forEach
            val turn = folds[message.id]
            if (turn != null) {
                flush()
                add(turn)
            } else if (message.id in hiddenIds ||
                (detail != ActivityDetail.FULL && message.card?.leavesTranscriptWhenSettled == true) ||
                (detail == ActivityDetail.HIDDEN && isActivityReceipt(message) && !isStatusNotice(message) && !isFailedTurn(message))) {
                // The reversible turn fold owns narration; Hidden owns tools.
            } else if (detail != ActivityDetail.REDUCED || message.kind != Message.Kind.ACTIVITY) {
                // The digest lands here too: its own row, never a step in a run.
                flush()
                add(TranscriptRow.Single(message))
            } else if (message.tool?.ok == false || isStatusNotice(message)) {
                flush()
                add(TranscriptRow.Single(message))
            } else {
                run += message
            }
        }
        flush()
    }
}
