package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.AskQuestion
import com.openmausbot.companion.core.AskQuestionAnswer
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Message
import kotlinx.coroutines.launch

/**
 * The question card: what the bot actually asked, and its own answers.
 *
 * A structured ask (Claude's `AskUserQuestion`) reaches the harness through
 * the permission channel, so before this it drew the ordinary card — a flat
 * row of buttons over "which model should this bot run on?". One tap could not
 * say WHICH question it answered, so a multi-question ask had nothing tappable
 * at all and the phone could only watch it time out.
 *
 * The desktop's `src/components/QuestionCard.tsx` and its Swift twin
 * `ios/App/Cards/QuestionCardView.swift`, in Compose: a tab per question, the
 * model's options with their glosses, an "Other" row for a reply it did not
 * think of, and one submit that sends every answer at once. The answer text is
 * built by [AskQuestionAnswer.format], so an answer given here is
 * byte-for-byte the one the Mac would have sent.
 */
@Composable
internal fun QuestionCardView(chat: Chat, message: Message, haptics: Haptics) {
    val card = message.card ?: return
    val questions = card.questions
    if (questions.isEmpty()) return

    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    // Per question: the option labels ticked, the free-text reply, and whether
    // "Other" is open. An open field with nothing in it is not an answer.
    val picked = remember(message.id) { mutableStateMapOf<Int, Set<String>>() }
    val custom = remember(message.id) { mutableStateMapOf<Int, String>() }
    val other = remember(message.id) { mutableStateMapOf<Int, Boolean>() }
    var active by remember(message.id) { mutableStateOf(0) }
    var answering by remember(message.id) { mutableStateOf(false) }
    // The harness settles the card, but only after a round trip. Holding the
    // sent answer closes the window where the buttons are still live.
    var sent by remember(message.id) { mutableStateOf<String?>(null) }

    fun answersFor(position: Int): List<String> {
        val chosen = picked[position].orEmpty().sorted().toMutableList()
        if (other[position] == true) {
            custom[position]?.trim()?.takeIf { it.isNotEmpty() }?.let(chosen::add)
        }
        return chosen
    }

    val index = active.coerceIn(0, questions.lastIndex)
    val current = questions[index]
    val answeredCount = questions.indices.count { answersFor(it).isNotEmpty() }
    val complete = answeredCount == questions.size
    val settled = card.answered != null || sent != null

    fun choose(label: String) {
        if (settled) return
        if (current.allowsMultiple) {
            val chosen = picked[index].orEmpty()
            picked[index] = if (label in chosen) chosen - label else chosen + label
            return
        }
        // Single-select is a radio group: picking replaces, and picking an
        // option means the free-text answer was not the one they wanted.
        picked[index] = setOf(label)
        other[index] = false
        // Move to the next question they still owe an answer to. The last one
        // stays put so the submit button is under the thumb that just chose.
        questions.indices
            .firstOrNull { it != index && answersFor(it).isEmpty() }
            ?.let { active = it }
    }

    fun toggleOther() {
        if (settled) return
        if (other[index] == true) {
            other[index] = false
            return
        }
        other[index] = true
        if (!current.allowsMultiple) picked[index] = emptySet()
    }

    fun send() {
        val requestId = card.requestId
        if (settled || !complete || requestId == null) return
        val answer = AskQuestionAnswer.format(questions, questions.indices.map(::answersFor))
        if (answer.isEmpty()) return
        sent = answer
        answering = true
        scope.launch {
            // A question only ever answers with text; the harness rejects an
            // allow/deny on one, so this never takes the permission path.
            session.answer(
                threadId = chat.threadId,
                requestId = requestId,
                choice = answer,
                isPermission = false,
            )
            answering = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(secondaryTint.copy(alpha = 0.13f), RoundedCornerShape(22.dp))
            .then(
                if (settled) {
                    Modifier
                } else {
                    Modifier.border(1.5.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(22.dp))
                },
            )
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${chat.name} has a question",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            if (questions.size > 1 && !settled) {
                Text("$answeredCount of ${questions.size}", fontSize = 12.sp, color = secondaryTint)
            }
        }

        if (questions.size > 1) {
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                questions.forEachIndexed { position, question ->
                    val chosen = position == index
                    Row(
                        modifier = Modifier
                            .background(
                                if (chosen) secondaryTint.copy(alpha = 0.22f) else Color.Transparent,
                                RoundedCornerShape(14.dp),
                            )
                            .clickable(enabled = !settled) {
                                haptics.play(TactileAction.CHOOSE_APPROVAL)
                                active = position
                            }
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (answersFor(position).isNotEmpty()) {
                            Icon(
                                imageVector = Icons.Filled.Check,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(12.dp),
                            )
                        }
                        Text(
                            question.tabLabel(position + 1),
                            fontSize = 13.sp,
                            fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (chosen) MaterialTheme.colorScheme.onSurface else secondaryTint,
                        )
                    }
                }
            }
        }

        SelectionContainer {
            Text(current.question, fontSize = 15.sp)
        }

        if (settled) {
            val answer = card.answeredText ?: sent
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = secondaryTint,
                    modifier = Modifier.size(16.dp),
                )
                SelectionContainer {
                    Text(
                        answer?.let(AskQuestionAnswer::withoutPreamble) ?: "Answered",
                        fontSize = 14.sp,
                        color = secondaryTint,
                    )
                }
            }
            return@Column
        }

        if (current.allowsMultiple) {
            Text("Choose all that apply", fontSize = 12.sp, color = secondaryTint)
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(secondaryTint.copy(alpha = 0.10f), RoundedCornerShape(14.dp)),
        ) {
            current.options.forEachIndexed { position, option ->
                if (position > 0) HorizontalDivider()
                ChoiceRow(
                    label = option.label,
                    detail = option.detail,
                    checked = option.label in picked[index].orEmpty(),
                    multi = current.allowsMultiple,
                    enabled = !answering,
                ) {
                    haptics.play(TactileAction.CHOOSE_APPROVAL)
                    choose(option.label)
                }
            }
            if (current.options.isNotEmpty()) HorizontalDivider()
            ChoiceRow(
                label = "Other",
                detail = null,
                checked = other[index] == true,
                multi = current.allowsMultiple,
                enabled = !answering,
            ) {
                haptics.play(TactileAction.CHOOSE_APPROVAL)
                toggleOther()
            }
            if (other[index] == true) {
                HorizontalDivider()
                OutlinedTextField(
                    value = custom[index].orEmpty(),
                    onValueChange = { custom[index] = it },
                    placeholder = { Text("Type your own answer") },
                    singleLine = false,
                    maxLines = 4,
                    enabled = !answering,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(10.dp),
                )
            }
        }

        Button(
            onClick = ::send,
            enabled = complete && !answering,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (questions.size > 1) "Submit answers" else "Submit answer")
        }
    }
}

/** One option row. The whole row is the target, not the 16 dp glyph on it. */
@Composable
private fun ChoiceRow(
    label: String,
    detail: String?,
    checked: Boolean,
    multi: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Marker(checked = checked, multi = multi)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            if (!detail.isNullOrEmpty()) {
                Text(detail, fontSize = 13.sp, color = secondaryTint)
            }
        }
    }
}

/** What the tabs and the answer share, kept here so a test can reach it. */
internal object QuestionCardRules {
    /** A structured ask draws the question card; everything else the ordinary one. */
    fun drawsQuestionCard(message: Message): Boolean =
        message.kind == Message.Kind.OPTIONS && message.card?.questions?.isNotEmpty() == true

    /** The tab labels, in order, exactly as the card shows them. */
    fun tabLabels(questions: List<AskQuestion>): List<String> =
        questions.mapIndexed { index, question -> question.tabLabel(index + 1) }
}

/**
 * The radio dot / checkbox tick, drawn rather than taken from the icon set:
 * the app bundles material-icons-core only, and pulling in the extended pack
 * for four glyphs would cost more than the twelve lines below.
 */
@Composable
private fun Marker(checked: Boolean, multi: Boolean) {
    val accent = MaterialTheme.colorScheme.primary
    val shape = if (multi) RoundedCornerShape(5.dp) else CircleShape
    Box(
        modifier = Modifier
            .size(20.dp)
            .then(
                if (checked) {
                    Modifier.background(accent, shape)
                } else {
                    Modifier.border(1.5.dp, secondaryTint, shape)
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (!checked) return@Box
        if (multi) {
            Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.size(14.dp),
            )
        } else {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(MaterialTheme.colorScheme.onPrimary, CircleShape),
            )
        }
    }
}
