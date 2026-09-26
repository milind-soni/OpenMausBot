package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.CompanionState
import kotlinx.coroutines.launch

/**
 * The Android control for iOS's NewSectionSheet. Android uses explicit checkbox
 * rows instead of iOS's dwell-and-drag grid, so TalkBack and keyboard users get
 * the same complete organizer action.
 *
 * The server currently exposes only the narrow, atomic assign route. Typing an
 * existing name adds/moves the selected bots into it; it cannot rename, delete,
 * unfile bots, or order sections because none of those operations has a paired
 * API yet.
 *
 * Filing several sections in a row is a flow, not a one-shot dialog: a save
 * clears the selection and leaves the sheet open, exactly as
 * `ios/App/NewSectionSheet.swift:546-572` does.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NewSectionSheet(onDismiss: () -> Unit) {
    val session = LocalCompanion.current.session
    val state by session.state.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var name by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf(emptySet<String>()) }
    var saving by remember { mutableStateOf(false) }
    var lastCreated by remember { mutableStateOf<String?>(null) }
    val bots = remember(state) { SectionRules.selectable(state) }

    val trimmed = name.trim()
    val joinsExisting = remember(state, trimmed) { SectionRules.joinsExistingSection(state, trimmed) }
    val chiefConflict = remember(bots, selected, trimmed) {
        SectionRules.hasChiefConflict(bots, selected, trimmed)
    }
    val pinnedSelection = remember(bots, selected) { SectionRules.hasPinnedSelection(bots, selected) }

    // Three ways out of a Material sheet — the button, the scrim or the back
    // gesture, and the drag — and one rule for all three, because a save already
    // on the wire is not something a swipe can take back.
    //
    // The gate is remembered rather than written inline: the sheet's state is
    // keyed on this lambda, so a fresh one per recomposition would rebuild the
    // sheet under the finger. It reads `saving` live through the state it closes
    // over, so remembering it costs nothing.
    val dismissGate = remember {
        { value: SheetValue -> value != SheetValue.Hidden || SectionRules.canDismiss(saving) }
    }
    val sheetState = rememberModalBottomSheetState(confirmValueChange = dismissGate)

    ModalBottomSheet(
        onDismissRequest = { if (SectionRules.canDismiss(saving)) onDismiss() },
        sheetState = sheetState,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                TextButton(
                    onClick = onDismiss,
                    enabled = SectionRules.canDismiss(saving),
                    modifier = Modifier.align(Alignment.CenterStart),
                ) {
                    // Once something has been filed, leaving is finishing.
                    Text(if (lastCreated == null) stringResource(R.string.mobile_cancel_77dfd213) else stringResource(R.string.mobile_done_e9b450d1))
                }
                Text(
                    text = stringResource(R.string.mobile_organize_bots_08f4197e),
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.align(Alignment.Center),
                )
                TextButton(
                    enabled = SectionRules.canSave(name, selected, saving, chiefConflict),
                    onClick = {
                        saving = true
                        val section = trimmed
                        scope.launch {
                            val saved = session.assignSection(section, SectionRules.ids(bots, selected))
                            if (saved != null) {
                                haptics.play(HapticCue.SUCCESS)
                                lastCreated = section
                                selected = emptySet()
                                name = ""
                            }
                            saving = false
                        }
                    },
                    modifier = Modifier.align(Alignment.CenterEnd),
                ) {
                    Text(stringResource(R.string.mobile_save_efc007a3))
                }
            }

            lastCreated?.let { section ->
                SectionNote(
                    text = stringResource(R.string.mobile_section_ready, section),
                    // Android files by checkbox, so there is nothing to swipe together.
                    detail = stringResource(R.string.mobile_section_add_more_bots),
                    container = MaterialTheme.colorScheme.secondaryContainer,
                    content = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }

            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.mobile_section_name_75e2b3c1)) },
                isError = trimmed.length > SectionRules.MAX_NAME_LENGTH,
                supportingText = {
                    Row(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = if (joinsExisting) stringResource(R.string.mobile_adds_to_existing_section_731f1f94) else stringResource(R.string.mobile_creates_a_new_section_9da73eb0),
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = "${trimmed.length}/${SectionRules.MAX_NAME_LENGTH}",
                            fontSize = 13.sp,
                            color = if (trimmed.length > SectionRules.MAX_NAME_LENGTH) {
                                MaterialTheme.colorScheme.error
                            } else {
                                secondaryTint
                            },
                        )
                    }
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            )

            if (chiefConflict) {
                SectionNote(
                    text = stringResource(R.string.mobile_section_chief_conflict),
                    container = MaterialTheme.colorScheme.tertiaryContainer,
                    content = MaterialTheme.colorScheme.onTertiaryContainer,
                )
            }
            if (pinnedSelection) {
                Text(
                    text = stringResource(R.string.mobile_section_pinned_stays),
                    fontSize = 13.sp,
                    color = secondaryTint,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }

            Text(
                text = stringResource(R.string.mobile_bots_4ca88ea4),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = secondaryTint,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            // Only a fleet that can exceed the limit is told about it.
            if (bots.size > SectionRules.MAX_BOTS) {
                Text(
                    text = if (selected.size == SectionRules.MAX_BOTS) {
                        stringResource(R.string.mobile_section_at_limit)
                    } else {
                        stringResource(R.string.mobile_section_under_limit)
                    },
                    fontSize = 12.sp,
                    color = secondaryTint,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                items(bots, key = { it.id }) { bot ->
                    BotPickRow(
                        bot = bot,
                        selected = bot.id in selected,
                        onToggle = {
                            val next = SectionRules.toggle(selected, bot.id)
                            // A refused mark is silent, like iOS's `SectionSelection`:
                            // the limit line above is what explains it.
                            if (next !== selected) {
                                selected = next
                                haptics.play(HapticCue.SELECT)
                            }
                        },
                    )
                }
            }
        }
    }
}

/** One boxed line of advice, in the shape iOS gives its section warnings. */
@Composable
private fun SectionNote(
    text: String,
    container: Color,
    content: Color,
    detail: String? = null,
) {
    Surface(
        color = container,
        contentColor = content,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(text = text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            detail?.let { Text(text = it, fontSize = 12.sp) }
        }
    }
}

/** Request limits mirror `createSidebarSectionSchema` in the companion server. */
internal object SectionRules {
    const val MAX_BOTS = 100
    const val MAX_NAME_LENGTH = 60

    /** `ios/App/NewSectionSheet.swift:477-487`. */
    const val CHIEF_CONFLICT =
        "A section can have one Chief. Go back and choose one Chief, or use a section without one."

    /** `ios/App/NewSectionSheet.swift:492-499` — why a pinned bot appears not to move. */
    const val PINNED_STAY = "Pinned bots stay in Pinned until you unpin them."

    const val AT_LIMIT = "100 selected — that’s the section limit."
    const val UNDER_LIMIT = "Choose up to 100 bots for one section."

    fun selectable(state: CompanionState): List<Bot> = state.bots.filter { it.hidden != true }

    /** Stable fleet order is deterministic when a server validates a Chief conflict. */
    fun ids(bots: List<Bot>, selected: Set<String>): List<String> =
        bots.mapNotNull { it.id.takeIf(selected::contains) }.take(MAX_BOTS)

    /**
     * The mark, or the same set back when the limit refuses it. Identity is the
     * answer the caller acts on, so a refusal cannot be mistaken for a change.
     */
    fun toggle(selected: Set<String>, id: String): Set<String> = when {
        id in selected -> selected - id
        selected.size >= MAX_BOTS -> selected
        else -> selected + id
    }

    /**
     * Every heading already in use, from bots and channels alike (iOS `:44-48`).
     *
     * The bots are the selectable ones, as iOS's `existingSections` reads its own
     * filtered `bots` (`:36-37`): a heading only a hidden bot carries is not one
     * this sheet can show, so calling it existing would promise the typist a
     * section they will not find.
     */
    fun existingSections(state: CompanionState): Set<String> =
        (selectable(state).mapNotNull { normalized(it.section) } + state.rooms.mapNotNull { normalized(it.section) })
            .toSet()

    fun joinsExistingSection(state: CompanionState, name: String): Boolean =
        normalized(name)?.let { it in existingSections(state) } == true

    /**
     * Sections allow one coordinator. Moving two Chiefs together, or moving one
     * beside a different incumbent, must never silently remove a role
     * (`ios/App/NewSectionSheet.swift:60-69`).
     */
    fun hasChiefConflict(bots: List<Bot>, selected: Set<String>, name: String): Boolean {
        val selectedChiefs = bots.filter { it.id in selected && it.chiefOfStaff == true }.map(Bot::id)
        // No name yet means no destination: an unfiled Chief is not an incumbent
        // of "nothing", so `null == null` must not count as a match here.
        val incumbents = normalized(name)?.let { destination ->
            bots.filter { it.chiefOfStaff == true && normalized(it.section) == destination }.map(Bot::id)
        }.orEmpty()
        return (selectedChiefs + incumbents).toSet().size > 1
    }

    fun hasPinnedSelection(bots: List<Bot>, selected: Set<String>): Boolean =
        bots.any { it.id in selected && it.pinned == true && it.chiefOfStaff != true }

    /**
     * Leaving is allowed until a save is in flight: `assignSection` cannot be
     * called back once it is on the wire, and a sheet swiped away mid-request
     * leaves the reader unsure whether the section was made
     * (`ios/App/NewSectionSheet.swift:99`).
     */
    fun canDismiss(saving: Boolean): Boolean = !saving

    fun canSave(name: String, selected: Set<String>, saving: Boolean, chiefConflict: Boolean): Boolean =
        !saving &&
            name.trim().length in 1..MAX_NAME_LENGTH &&
            selected.size in 1..MAX_BOTS &&
            !chiefConflict

    private fun normalized(section: String?): String? = section?.trim()?.takeIf(String::isNotEmpty)
}
