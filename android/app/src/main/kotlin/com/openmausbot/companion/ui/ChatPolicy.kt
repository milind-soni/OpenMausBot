package com.openmausbot.companion.ui

import com.openmausbot.companion.core.AttachedMessageContent
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatSummary
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.PendingApproval
import com.openmausbot.companion.core.Reaction
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.chat
import com.openmausbot.companion.core.TranscriptRow

/**
 * The decisions the chat and roster screens make that are worth testing without
 * a device. Everything here is pure; the composables call in, they do not
 * re-derive. The one deliberate exception is [ApprovalAnswers], which is a pair
 * of session calls rather than a decision, and is here for the same reason: so
 * the pair can be tested rather than trusted.
 */

/**
 * Turning a chat destination into a chat, honestly.
 *
 * A notification tap can arrive at a cold start, before the stream has said
 * hello and the fleet has been hydrated — and so can a navigation stack restored
 * after the process was killed. At that moment nothing exists, and treating "not
 * found" as "deleted" would bounce the reader straight back to the roster — the
 * tap would open nothing, which is the one thing the notification promised.
 *
 * `cursor` is the honest signal: `Session` commits `resetCursor` only after a
 * cold hydrate succeeds, and a fresh process starts with none.
 */
object ThreadResolution {
    sealed interface Result {
        data class Open(val chat: Chat) : Result

        /** Nothing has been hydrated yet — wait, do not conclude anything. */
        data object Waiting : Result

        /** The fleet is known and this thread is not in it. */
        data object Gone : Result
    }

    fun hydrated(state: CompanionState): Boolean =
        state.cursor != null || state.bots.isNotEmpty() || state.rooms.isNotEmpty()

    /** The chat behind a thread id, or null while it is unknown either way. */
    fun chatOrNull(state: CompanionState, threadId: String): Chat? =
        (resolve(state, threadId) as? Result.Open)?.chat

    /**
     * The chat a destination points at.
     *
     * An addressed chat resolves by its owner alone, so the screen follows the
     * bot: through a task switch, through a task being created, and through the
     * deletion of the very task that was open — where the desktop moves the bot
     * to another task and the phone has no business going home. Only an owner
     * that is really gone closes the chat.
     */
    fun resolve(state: CompanionState, destination: Destination.Conversation): Result =
        when (destination) {
            is Destination.Chat -> state.chat(destination.target)?.let(Result::Open)
                ?: unknown(state)
            is Destination.Thread -> resolve(state, destination.threadId)
        }

    fun resolve(state: CompanionState, threadId: String): Result {
        state.botForThread(threadId)?.let { return Result.Open(Chat.BotChat(it)) }
        state.roomForThread(threadId)?.let { return Result.Open(Chat.RoomChat(it)) }
        // A bot that switched task now answers to a different thread, and a
        // notification may name a task that is no longer the open one. The chat
        // follows the bot, not the thread it was opened on — so a thread that is
        // one of a bot's tasks still resolves to that bot, and the screen shows
        // whichever task the bot is in now.
        state.bots
            .firstOrNull { bot -> bot.tasks.orEmpty().any { it.threadId == threadId } }
            ?.let { return Result.Open(Chat.BotChat(it)) }
        // Channel tasks use the same owner-following navigation as bot tasks.
        // Session switches the room before opening a notification/search hit;
        // until then, resolving the owner keeps a stale destination from
        // looking deleted.
        state.rooms
            .firstOrNull { room -> room.tasks.orEmpty().any { it.threadId == threadId } }
            ?.let { return Result.Open(Chat.RoomChat(it)) }
        return unknown(state)
    }

    private fun unknown(state: CompanionState): Result =
        if (hydrated(state)) Result.Gone else Result.Waiting
}

/** A gap in time is worth marking; a timestamp on every message is just noise. */
object TranscriptLayout {
    /** iOS: `messages[i].at - messages[i - 1].at > 30 * 60 * 1000`. */
    const val GAP_MILLIS: Double = 30.0 * 60.0 * 1000.0

    fun startsNewStretch(messages: List<Message>, index: Int): Boolean {
        if (index <= 0) return true
        if (index >= messages.size) return false
        return messages[index].at - messages[index - 1].at > GAP_MILLIS
    }

    /** Same rule after [TranscriptRow.ActivityRun] has folded several receipts. */
    fun startsNewRowStretch(rows: List<TranscriptRow>, index: Int): Boolean {
        if (index <= 0) return true
        if (index >= rows.size) return false
        return rows[index].at - rows[index - 1].endAt > GAP_MILLIS
    }

    /**
     * True when the next message is from someone else (or there is none), which is
     * where a run of bubbles gets its tail — one per run, like every messaging app,
     * rather than one per bubble. The port of `endsRun` in `ios/App/ChatView.swift`.
     *
     * The three ways a run breaks, in the Swift's order: the role changes, the
     * speaker's name changes, or the next row is not text — a card or a tool chip
     * between two texts breaks the run visually. What this message itself is is
     * deliberately not asked: only [TextBubble] draws a tail, so an activity chip
     * that is followed by more text costs the run nothing.
     */
    fun endsRun(messages: List<Message>, index: Int): Boolean {
        val next = messages.getOrNull(index + 1) ?: return true
        val current = messages.getOrNull(index) ?: return true
        if (current.role != next.role) return true
        if (current.from?.name != next.from?.name) return true
        return next.kind != Message.Kind.TEXT
    }

    /** A folded activity run is one non-text neighbour for bubble-tail purposes. */
    fun endsRowRun(rows: List<TranscriptRow>, index: Int): Boolean {
        val next = rows.getOrNull(index + 1) ?: return true
        val current = rows.getOrNull(index) ?: return true
        if (current.role != next.role) return true
        if (current.senderName != next.senderName) return true
        return next.kind != Message.Kind.TEXT
    }

    /** Which side the tail hangs from, or none while the run continues. */
    fun tail(message: Message, endsRun: Boolean): BubbleTail = when {
        !endsRun -> BubbleTail.NONE
        message.role == Message.Role.USER -> BubbleTail.TRAILING
        else -> BubbleTail.LEADING
    }
}

/**
 * Roster search. Local filtering always; the remote `GET /api/search` only past
 * two characters and after a 250ms quiet period (§10).
 */
object SearchPolicy {
    const val MIN_LENGTH: Int = 2
    const val DEBOUNCE_MILLIS: Long = 250L

    sealed interface Decision {
        /** Too short — drop any hits and stop showing the spinner. */
        data object Clear : Decision

        /** Long enough — spin, wait out the debounce, then ask the computer. */
        data class Remote(val query: String) : Decision
    }

    fun decide(raw: String): Decision =
        if (raw.trim().length >= MIN_LENGTH) Decision.Remote(raw) else Decision.Clear

    /** Local filter: name, role chip, preview — case-insensitive, like iOS. */
    fun matches(summary: ChatSummary, query: String): Boolean {
        if (query.isEmpty()) return true
        return summary.chat.name.contains(query, ignoreCase = true) ||
            summary.chat.subtitle.contains(query, ignoreCase = true) ||
            summary.preview.contains(query, ignoreCase = true)
    }

    fun filter(summaries: List<ChatSummary>, query: String): List<ChatSummary> =
        if (query.isEmpty()) summaries else summaries.filter { matches(it, query) }
}

/**
 * Everything the composer's + can do — the port of `plusActions` in
 * `ios/App/ChatView.swift`.
 *
 * One list, one door. The name pill stopped being a second one when it became
 * the way into an agent's profile, so every action lives here, including both
 * export formats. The computer and interrupt remain bot ideas; non-DM rooms
 * with a task list get the same task controls as an agent. Exporting is not a
 * bot idea — a room has a transcript like anything else.
 */
enum class ChatActionId {
    PHOTOS, FILES, NEW_TASK, TASKS, SETTINGS, WATCH_COMPUTER, SHARE_MARKDOWN, SHARE_JSON, INTERRUPT
}

data class ChatAction(
    val id: ChatActionId,
    val title: String,
    /** The line under the title, which the sheet has room for. */
    val subtitle: String,
    val destructive: Boolean = false,
    val enabled: Boolean = true,
)

object ChatActions {
    /**
     * What the + opens, in the Swift's order.
     *
     * [hasPendingApproval] is deliberately without a default: it is read only by
     * the channel's "New task", and a call site that forgot it would offer a
     * fresh thread over the one question on screen that only a person can
     * answer.
     */
    fun sheet(chat: Chat, hasPendingApproval: Boolean, canAddAttachment: Boolean): List<ChatAction> {
        val bot = (chat as? Chat.BotChat)?.bot
        val out = mutableListOf<ChatAction>()
        // Attachments first, for a bot and a room alike — the order of iOS's
        // `plusActions`. [canAddAttachment] is false at the four-item cap and
        // while a send or an import is in flight.
        out += ChatAction(
            id = ChatActionId.PHOTOS,
            title = "Photo Library",
            subtitle = "Add a photo to this message",
            enabled = canAddAttachment,
        )
        out += ChatAction(
            id = ChatActionId.FILES,
            title = "Choose File",
            subtitle = "Add a document from Files",
            enabled = canAddAttachment,
        )
        if (bot != null) {
            out += ChatAction(
                id = ChatActionId.NEW_TASK,
                title = "New task",
                subtitle = "Start a fresh thread with ${bot.name}",
                enabled = bot.busy != true,
            )
            out += ChatAction(
                id = ChatActionId.TASKS,
                title = "Tasks",
                subtitle = "Switch, rename or remove one",
            )
            out += ChatAction(
                id = ChatActionId.SETTINGS,
                title = "Bot settings",
                subtitle = "Model, profile, voice and notifications",
            )
            out += ChatAction(
                id = ChatActionId.WATCH_COMPUTER,
                title = "Watch computer",
                subtitle = "Live view of what ${bot.name} is doing",
            )
        } else if (chat.supportsTasks) {
            out += ChatAction(
                id = ChatActionId.NEW_TASK,
                title = "New task",
                subtitle = "Start a fresh conversation in ${chat.name}",
                // iOS: `disabled: current.busy || hasPendingApproval`, on the room
                // branch only — a channel waiting on an answer does not get a
                // second thread started over it.
                enabled = !chat.busy && !hasPendingApproval,
            )
            out += ChatAction(
                id = ChatActionId.TASKS,
                title = "Tasks",
                subtitle = "Switch, rename or remove one",
            )
        }
        out += ChatAction(
            id = ChatActionId.SHARE_MARKDOWN,
            title = "Share transcript",
            subtitle = "This chat as Markdown",
        )
        out += ChatAction(
            id = ChatActionId.SHARE_JSON,
            title = "Share as JSON",
            subtitle = "Structured transcript data",
        )
        if (chat.busy && bot != null) {
            out += ChatAction(
                id = ChatActionId.INTERRUPT,
                title = "Interrupt",
                subtitle = "Stop the current turn",
                destructive = true,
            )
        }
        return out
    }
}

/**
 * How the roster arranges itself — the port of `ios/App/ChatListView.swift`.
 *
 * Messages-shaped: your groups across the top, every bot below, and a floating
 * bar at the bottom whose pill is Updates. Which chats are rows and which are
 * tiles is decided here rather than in the composable, because it is a rule and
 * not a layout.
 */
object RosterLayout {
    /**
     * What a search shows: every kind of chat the query matches. Only a search
     * asks — an unsearched roster is assembled section by section from the
     * fleet's own partition, so there is no list to filter there.
     */
    fun rows(summaries: List<ChatSummary>, query: String): List<ChatSummary> =
        SearchPolicy.filter(summaries, query)

    /**
     * Whether the unsearched roster has any row at all. Rooms live in the strip
     * and tiles are not rows, so "no bots yet" is about bots — which is also
     * what the empty state says.
     */
    fun listsAnyBot(summaries: List<ChatSummary>): Boolean =
        summaries.any { it.chat is Chat.BotChat }

    /** The strip is part of the roster, not of a search result. */
    fun showsGroups(query: String): Boolean = query.isEmpty()

    /**
     * The chats a pending approval is waiting in — what puts "Waiting on you" on a
     * row. [pending] is passed in because [CompanionState.pendingApprovals] walks
     * every thread's transcript and the screen already holds the answer.
     */
    fun waitingChats(state: CompanionState, pending: List<PendingApproval>): Set<String> =
        pending.mapNotNullTo(mutableSetOf()) {
            ThreadResolution.chatOrNull(state, it.threadId)?.id
        }

    /** The first two of these are the faces a group tile stacks. */
    fun memberBots(state: CompanionState, room: Room): List<Bot> =
        room.memberIds.mapNotNull { state.bot(it) }

    /** The header's second line: who this phone is paired with, and how it is doing. */
    fun headerSubtitle(connectionName: String?, status: Session.Status): String {
        val name = connectionName ?: NOT_PAIRED
        return when (status) {
            Session.Status.Live -> "$name · connected"
            Session.Status.Connecting -> "$name · connecting…"
            is Session.Status.Offline -> "$name · offline"
            Session.Status.Unauthorized -> "$name · unpaired"
            // The one branch that drops the name: unpaired has no computer to name.
            Session.Status.Unpaired -> NOT_PAIRED
        }
    }

    /**
     * A section heading. Uppercased by the invariant rules, which is what Swift's
     * `uppercased()` does — a reader in `tr-TR` must still read BOTS, not BOTS
     * spelled with a dotted capital.
     */
    fun sectionLabel(text: String): String = text.uppercase()

    private const val NOT_PAIRED = "Not paired"
}

/**
 * The floating bar's two faces: Updates beside the two round actions, or the
 * search field beside Cancel (`bottomBar` in `ios/App/ChatListView.swift`).
 *
 * Cancel takes the query with it, which is what returns the list to bots-only and
 * puts the groups strip back — so the two are one state, not two.
 */
data class RosterBar(val searchOpen: Boolean = false, val query: String = "") {
    fun openSearch(): RosterBar = copy(searchOpen = true)

    fun cancelSearch(): RosterBar = RosterBar(searchOpen = false, query = "")

    fun typed(text: String): RosterBar = copy(query = text)

    /** iOS clears the field without closing it; Cancel is what closes it. */
    fun clearQuery(): RosterBar = copy(query = "")
}

/** How much visual weight an approval option carries. */
enum class OptionEmphasis {
    /** The accented, filled button — anything that lets the bot continue. */
    PRIMARY,

    /** Quieter, for the refusal. */
    SECONDARY,
}

/**
 * Which option on an approval card means "go ahead", and when the phone may
 * offer a standing grant.
 *
 * [allowChoice] is deliberately not the literal string "Allow": `options` is
 * whatever the harness sent, and it only falls back to `["Allow", "Deny"]` when
 * the provider event named no choices of its own — a card is free to say "Yes",
 * "Approve", "Allow once". The conventional label wins when it is present.
 * (`CardView` in `ios/App/ChatView.swift`.)
 */
object ApprovalChoices {
    const val ALLOW = "Allow"

    /**
     * One definition of "the refusal", shared by the button tint, the choice the
     * standing grant answers with, and the behavior `Session.answer` puts on the
     * wire — so a card that pads its labels cannot be tinted as one thing and
     * answered as another. `OptionCard.isRefusal` is that definition
     * (`ios/App/UpdatesSheet.swift`'s `CardStyle` and `ios/App/ChatView.swift`
     * both delegate to it for exactly this reason).
     */
    fun isRefusal(option: String): Boolean = OptionCard.isRefusal(option)

    fun emphasis(option: String): OptionEmphasis =
        if (isRefusal(option)) OptionEmphasis.SECONDARY else OptionEmphasis.PRIMARY

    fun allowChoice(options: List<String>): String? =
        options.firstOrNull { it.equals(ALLOW, ignoreCase = true) }
            ?: options.firstOrNull { !isRefusal(it) }

    /**
     * What "Always allow this tool" answers with once the grant is written, or
     * null when the card offered nothing that means "go ahead" — in which case
     * the button is not shown, as `ios/App/ChatView.swift` does not show it.
     *
     * One of the card's own options, never a string invented here, for a
     * permission card as much as for a question: a permission answer is
     * classified by `OptionCard.responseBehavior`, under which every offered
     * option but the refusal already means allow, so a fabricated label would
     * only be a label the harness never named.
     */
    fun alwaysAllowChoice(card: OptionCard): String? =
        if (!card.isPending || card.allowKey == null) null else allowChoice(card.options)

    /**
     * "Always allow this tool" needs a key the card itself carried and a bot to
     * hang it on — the phone never invents a grant, and rooms never show one
     * (§12).
     */
    fun showsAlwaysAllow(card: OptionCard, chat: Chat): Boolean =
        chat is Chat.BotChat && alwaysAllowChoice(card) != null
}

/**
 * The two ways a card can be answered, and the reason they are two.
 *
 * A card's own options go through [choose], which lets `Session` decide whether
 * the option is also the standing grant the provider offered: on a permission
 * card carrying a key, "Always allow" is, and nothing else is
 * (`ios/App/Session.swift`).
 *
 * The separate "Always allow this tool" button goes through [grant], which
 * writes the grant itself and then answers with `rememberingPermission = false`.
 * That flag is the whole point: [allowChoice] can legitimately land on the
 * card's own "Always allow", and without it one tap would record the same grant
 * twice (`ios/App/ChatView.swift`).
 */
object ApprovalAnswers {
    suspend fun choose(session: Session, chat: Chat, card: OptionCard, choice: String) {
        session.answer(chat, card, choice)
    }

    suspend fun grant(session: Session, chat: Chat.BotChat, card: OptionCard, choice: String) {
        session.alwaysAllow(chat.bot, card)
        session.answer(chat, card, choice, rememberingPermission = false)
    }
}

/**
 * What a search hit shows about who said it — `ios/App/ChatListView.swift` puts a
 * person glyph on a user hit and a speech bubble on a bot one, so two hits with
 * the same words are still told apart.
 */
object SearchHitRole {
    fun isFromUser(role: Message.Role): Boolean = role == Message.Role.USER

    /** The glyph carries meaning, so it carries a description too. */
    fun contentDescription(role: Message.Role, name: String): String =
        if (isFromUser(role)) "Your message" else "Message from $name"
}

/**
 * What a message offers the clipboard.
 *
 * Selection covers the settled bubbles, but a gesture can only belong to one
 * owner: where text selection claims the long press, the reactions menu does
 * not open, and where the menu opens, selection did not start. A Copy action in
 * that menu makes the outcome the same either way, which is the point — the
 * reader wants the command, the URL or the approval detail, not a particular
 * gesture.
 */
object MessageActions {
    /** The text worth putting on the clipboard, or null when there is none. */
    fun copyableText(message: Message): String? = when (message.kind) {
        Message.Kind.TEXT, Message.Kind.UNKNOWN -> message.text
            ?.let { AttachedMessageContent.parse(it) }
            ?.text
            ?.takeIf { it.isNotBlank() }
        // An approval card is worth copying for what it is asking to do.
        Message.Kind.OPTIONS -> message.card
            ?.let { card -> listOf(card.title, card.subtitle).filter { it.isNotBlank() } }
            ?.takeIf { it.isNotEmpty() }
            ?.joinToString("\n\n")
        // A tool chip is context, and a screenshot is pixels.
        Message.Kind.ACTIVITY, Message.Kind.SCREEN -> null
    }

    /**
     * Original user text can be retried only when it has no uploaded payload.
     * Retrying an attachment message would either leak its computer-local path
     * or silently resend a message without the file.
     */
    fun editableText(message: Message): String? {
        if (message.role != Message.Role.USER || message.kind != Message.Kind.TEXT) return null
        val raw = message.text ?: return null
        if (AttachedMessageContent.parse(raw).attachments.isNotEmpty()) return null
        return raw
    }
}

/** Reactions, grouped for display. `by == "user"` is yours. */
data class ReactionGroup(val emoji: String, val count: Int, val mine: Boolean)

object Reactions {
    val CHOICES: List<String> = listOf("👍", "❤️", "😂", "🎉", "👀")

    fun group(reactions: List<Reaction>): List<ReactionGroup> =
        reactions.groupBy { it.emoji }
            .map { (emoji, all) -> ReactionGroup(emoji, all.size, all.any { it.by == "user" }) }
            .sortedBy { it.emoji }
}

/** The five commands, by what selecting one does rather than by its label. */
enum class SlashCommandId { COMPUTER, TASKS, DIFF, RETRY, STEER }

/**
 * What a command *is*, which is not always a message.
 *
 * iOS carries a `command: String` on every item and then switches on the id
 * before deciding whether to send it, which leaves `/computer` holding a string
 * that must never reach the wire. Modelling the outcome instead makes that
 * impossible: only [Send] carries a prompt, so there is nothing to send by
 * accident.
 */
sealed interface SlashEffect {
    data object OpenComputer : SlashEffect

    data object OpenTasks : SlashEffect

    /** Sent immediately, exactly as typing it would have been. */
    data class Send(val prompt: String) : SlashEffect
}

data class SlashCommand(
    val id: SlashCommandId,
    /** The literal command, which is also what the card reads. */
    val title: String,
    val description: String,
    val effect: SlashEffect,
)

/**
 * The slash-command HUD — the port of `CommandSkillHUDView` in
 * `ios/App/Composer/CommandSkillHUDView.swift` and the composer that drives it.
 *
 * Local, and deliberately so: these five are the phone's own shortcuts into
 * navigation it already has and prompts the bot already understands. There is no
 * skills endpoint behind them and there must not be one — a HUD that had to ask
 * the computer what it could offer would be empty in exactly the situation the
 * shortcuts exist for.
 */
object SlashCommands {
    val ALL: List<SlashCommand> = listOf(
        SlashCommand(
            id = SlashCommandId.COMPUTER,
            title = "/computer",
            description = "Open live screen & desktop controls",
            effect = SlashEffect.OpenComputer,
        ),
        SlashCommand(
            id = SlashCommandId.TASKS,
            title = "/tasks",
            description = "View and manage bot task threads",
            effect = SlashEffect.OpenTasks,
        ),
        SlashCommand(
            id = SlashCommandId.DIFF,
            title = "/diff",
            description = "Inspect latest git changes and patches",
            effect = SlashEffect.Send("Show git diff and list modified files"),
        ),
        SlashCommand(
            id = SlashCommandId.RETRY,
            title = "/retry",
            description = "Retry the last turn with fresh context",
            effect = SlashEffect.Send("Please retry the last turn"),
        ),
        SlashCommand(
            id = SlashCommandId.STEER,
            title = "/steer",
            description = "Steer and redirect active execution",
            effect = SlashEffect.Send("Pause and explain your current plan"),
        ),
    )

    /** What is left once the computer-only shortcut is gone. */
    val IN_ROOM: List<SlashCommand> = ALL.filterNot { it.id == SlashCommandId.COMPUTER }

    /** Older sidecars omit room tasks and cannot accept the task routes. */
    val IN_LEGACY_ROOM: List<SlashCommand> = IN_ROOM.filterNot { it.id == SlashCommandId.TASKS }

    /**
     * The computer is bot-only. A non-DM room exposes tasks when the paired
     * desktop advertises them through a non-null task list.
     *
     * Both answers are constants, so the composer can ask on every recomposition
     * without allocating a list per streamed token.
     */
    fun forChat(chat: Chat): List<SlashCommand> = when (chat) {
        is Chat.BotChat -> ALL
        is Chat.RoomChat -> if (chat.supportsTasks) IN_ROOM else IN_LEGACY_ROOM
    }

    /**
     * Typing a `/` is the other way in — and typing anything else is the way
     * out, which is why this is the whole answer and not just "should it open".
     */
    fun opensOnDraft(draft: String): Boolean = draft.startsWith("/")

    /**
     * The HUD state a chat opens with, given the draft it opens with.
     *
     * Mount is not a special case, and that is the whole point. iOS keeps
     * `draft` and `showCommandHUD` together in one `ChatView` for as long as the
     * chat is on screen, so presenting Computer over it cannot separate them.
     * Android takes `ChatScreen` out of composition for that push and restores
     * the draft from the holder on the way back, and rebuilds it from the typed
     * snapshot after the process was recreated — so the panel has to be derived
     * from the text rather than assumed shut, or the chat comes back with `/dif`
     * in the field and nothing above it.
     *
     * Named apart from [opensOnDraft] only so the entry path is something a test
     * can hold: the rule is deliberately the same one.
     */
    fun openOnEntry(restoredDraft: String): Boolean = opensOnDraft(restoredDraft)

    /**
     * Filtered by what is after the `/`, over the title *and* the description —
     * so `/git` finds `/diff` by what it does, not only by what it is called. A
     * lone `/` filters nothing.
     */
    fun matching(commands: List<SlashCommand>, draft: String): List<SlashCommand> {
        if (!draft.startsWith("/") || draft.length <= 1) return commands
        val query = draft.drop(1).lowercase()
        return commands.filter {
            it.title.lowercase().contains(query) || it.description.lowercase().contains(query)
        }
    }

    /**
     * Closing the HUD takes back the `/` it opened on and nothing else. A draft
     * of `/dif` is four characters someone typed; deleting three of them because
     * a panel closed would be the panel editing the message.
     */
    fun draftAfterClose(draft: String): String = if (draft == "/") "" else draft
}

/** One of the four standing prompts under an empty composer. */
data class PredictiveChip(val title: String, val prompt: String, val icon: String? = null)

/**
 * The port of `PredictiveActionChipsView` in
 * `ios/App/Composer/PredictiveActionChipsView.swift`: four things worth asking
 * at the start of a turn, each sent the moment it is tapped.
 */
object PredictiveChips {
    val ALL: List<PredictiveChip> = listOf(
        PredictiveChip("Show diff", "Show latest git diff", "diff"),
        PredictiveChip("Run tests", "Run all automated tests", "tests"),
        PredictiveChip("Explain steps", "Explain the changes in detail", "explain"),
        PredictiveChip("What's next?", "What should we do next?", "next"),
    )
}

/** What sits above the composer pill, if anything. */
enum class ComposerAccessory { HUD, CHIPS, NONE }

object ComposerAccessories {
    /** iOS: `messages.contains { $0.card?.isPending == true }`. */
    fun hasPendingApproval(messages: List<Message>): Boolean =
        messages.any { it.card?.isPending == true }

    /**
     * The HUD wins when it is open; otherwise the chips, but only on an empty
     * draft, only while the bot is idle, and only with nothing waiting to be
     * approved. All three matter: a chip sends immediately, so offering one
     * beside half a sentence would throw the sentence away, offering one to a
     * busy bot earns a 409, and offering one over a pending approval buries the
     * question the screen exists to ask.
     *
     * [hasQuickReplies] carries no default for the same reason [PredictiveChipsRow]
     * no longer does: the reader can empty the row, and a call site that forgot
     * to say so would put chips back over an emptied composer.
     */
    fun accessory(
        hudOpen: Boolean,
        draft: String,
        busy: Boolean,
        pendingApproval: Boolean,
        hasQuickReplies: Boolean,
        /** A pending attachment is half a message too; a chip would send without it. */
        hasAttachments: Boolean,
    ): ComposerAccessory = when {
        hudOpen -> ComposerAccessory.HUD
        draft.isEmpty() && !hasAttachments && !busy && !pendingApproval && hasQuickReplies -> ComposerAccessory.CHIPS
        else -> ComposerAccessory.NONE
    }
}
