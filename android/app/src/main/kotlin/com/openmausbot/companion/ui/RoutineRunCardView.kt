package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.RoutineRunTone
import com.openmausbot.companion.core.TurnDigest

/** How many lines of a routine's report show before "Show report". */
private const val REPORT_LINES = 6

/**
 * One routine run in the thread that created the routine: its name, where it
 * got to, the report it produced, and the way into the run's own thread. Port
 * of `RoutineRunCard.tsx`. [openRun] is null when the phone cannot find that
 * thread, and then there is no button rather than one that fails.
 */
@Composable
internal fun RoutineRunCardView(message: Message, openRun: (() -> Unit)?) {
    val run = message.routineRun
    // A card from a computer that sent the kind without the data: the
    // computer's own sentence is still the whole story.
    if (run == null) {
        message.text?.takeIf { it.isNotBlank() }?.let {
            Text(it, fontSize = 15.sp, color = secondaryTint, modifier = Modifier.padding(start = 4.dp))
        }
        return
    }
    val tint = when (run.tone) {
        RoutineRunTone.ERROR -> MaterialTheme.colorScheme.error
        RoutineRunTone.ATTENTION -> Color(MausPalette.argb("orange"))
        RoutineRunTone.ACTIVE -> MaterialTheme.colorScheme.primary
        RoutineRunTone.NEUTRAL -> secondaryTint
    }
    val haptics = rememberHaptics()
    var expanded by remember(message.id) { mutableStateOf(false) }
    var overflows by remember(message.id, run.summary) { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .widthIn(max = 520.dp)
            .fillMaxWidth()
            .background(secondaryTint.copy(alpha = 0.10f), RoundedCornerShape(18.dp))
            .border(1.dp, secondaryTint.copy(alpha = 0.18f), RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = run.headline },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    run.routineName.ifBlank { "Routine" },
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (run.tone == RoutineRunTone.ACTIVE) {
                        CircularProgressIndicator(modifier = Modifier.size(11.dp), strokeWidth = 1.5.dp, color = tint)
                    }
                    Text(
                        run.stateWording.replaceFirstChar { it.uppercase() },
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = tint,
                    )
                }
            }
            if (openRun != null) {
                Row(
                    modifier = Modifier
                        .heightIn(min = MIN_TOUCH_TARGET)
                        .clickable(role = Role.Button) {
                            haptics.play(TactileAction.OPEN_THREAD_CHIP)
                            openRun()
                        }
                        .padding(horizontal = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(run.openLabel, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = tint)
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = tint,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }

        run.summary?.takeIf { it.isNotBlank() }?.let { summary ->
            SelectionContainer {
                Text(
                    summary.trim(),
                    fontSize = 14.sp,
                    maxLines = if (expanded) Int.MAX_VALUE else REPORT_LINES,
                    overflow = TextOverflow.Ellipsis,
                    onTextLayout = { if (!expanded) overflows = it.hasVisualOverflow },
                )
            }
            if (overflows || expanded) {
                Text(
                    if (expanded) "Show less" else "Show report",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .heightIn(min = MIN_TOUCH_TARGET)
                        .clickable(role = Role.Button) {
                            haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                            expanded = !expanded
                        }
                        .padding(vertical = 12.dp),
                )
            }
        }

        run.error?.takeIf { it.isNotBlank() }?.let { error ->
            SelectionContainer {
                Text(error.trim(), fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/**
 * The turn digest as a quiet outlined chip under the reply, and on tap the
 * sections it lists. The row's raw text is a log line for the model's next
 * turn; the chip is how a person gets at it without reading one.
 */
@Composable
internal fun TurnDigestChip(message: Message) {
    val digest = remember(message.text) { TurnDigest.parse(message.text) }
    var open by remember(message.id) { mutableStateOf(false) }
    val haptics = rememberHaptics()
    Row(
        modifier = Modifier
            .padding(start = 4.dp)
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button) {
                haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                open = true
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .border(1.dp, secondaryTint.copy(alpha = 0.35f), RoundedCornerShape(14.dp))
                .padding(horizontal = 10.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(6.dp).background(secondaryTint, CircleShape),
            )
            Text(digest.chipLabel, fontSize = 12.sp, color = secondaryTint, maxLines = 1)
        }
    }
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text(TurnDigest.CHIP_TITLE) },
            text = {
                Column(
                    modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (digest.sections.isEmpty()) {
                        Text("Nothing was recorded for this turn.", fontSize = 14.sp, color = secondaryTint)
                    }
                    digest.sections.forEach { section ->
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            section.label?.let {
                                Text(
                                    it.replaceFirstChar { c -> c.uppercase() },
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = secondaryTint,
                                )
                            }
                            SelectionContainer {
                                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    section.items.forEach { item -> Text(item, fontSize = 14.sp) }
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { open = false }) { Text("Done") } },
        )
    }
}
