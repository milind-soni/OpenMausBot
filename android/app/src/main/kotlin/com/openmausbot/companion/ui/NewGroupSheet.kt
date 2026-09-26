package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.Room
import kotlinx.coroutines.launch

/**
 * Make a room from the phone — the port of `ios/App/NewGroupSheet.swift`.
 *
 * A name, and which bots are in it. The harness names it after the first member
 * if the name is left blank, which is what the desktop's dialog does too — one
 * rule, two screens. That rule lives in `:core`'s `Client.createRoom`, which
 * drops a blank name from the body; this screen hands the field over as typed and
 * does not second-guess it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NewGroupSheet(onCreated: (Room) -> Unit, onDismiss: () -> Unit) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val state by session.state.collectAsState()

    var name by remember { mutableStateOf("") }
    var members by remember { mutableStateOf(emptySet<String>()) }
    var creating by remember { mutableStateOf(false) }

    // Live: the fleet keeps arriving while the sheet is open, so a bot deleted
    // mid-pick leaves the list. Its id stays in `members`, as it does on iOS, and
    // is filtered out only when the request is built — so it comes back selected
    // if the bot does.
    val bots = remember(state) { NewGroupRules.selectable(state) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.CenterStart),
                ) {
                    Text(stringResource(R.string.mobile_cancel_77dfd213))
                }
                Text(
                    text = stringResource(R.string.mobile_new_group_f9850c0b),
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.align(Alignment.Center),
                )
                TextButton(
                    onClick = {
                        creating = true
                        scope.launch {
                            val ordered = NewGroupRules.members(bots, members)
                            val room = session.createRoom(name, ordered)
                            // A failure leaves the sheet open with the picks
                            // intact; `Session` raises the error dialog itself.
                            if (room != null) {
                                haptics.play(TactileAction.CREATE_GROUP_SUCCESS)
                                onCreated(room)
                            }
                            creating = false
                        }
                    },
                    enabled = NewGroupRules.canCreate(members, creating),
                    modifier = Modifier.align(Alignment.CenterEnd),
                ) {
                    Text(stringResource(R.string.mobile_create_6e157c5d))
                }
            }

            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.mobile_group_name_optional_0fd3a15c)) },
                singleLine = true,
                // A room's name is a label, not prose; iOS turns autocorrect off
                // here for the same reason.
                keyboardOptions = KeyboardOptions(
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Done,
                ),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            )

            Text(
                text = stringResource(R.string.mobile_bots_4ca88ea4),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = secondaryTint,
                modifier = Modifier.padding(horizontal = 20.dp),
            )

            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                items(bots, key = { it.id }) { bot ->
                    BotPickRow(
                        bot = bot,
                        selected = bot.id in members,
                        onToggle = {
                            members = if (bot.id in members) members - bot.id else members + bot.id
                            haptics.play(TactileAction.TOGGLE_GROUP_MEMBER)
                        },
                    )
                }
            }
        }
    }
}

@Composable
internal fun BotPickRow(bot: Bot, selected: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(value = selected, role = Role.Checkbox, onValueChange = { onToggle() })
            .padding(horizontal = 20.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A list of many, and a picker is not a place anything is happening.
        BotAvatar(bot = bot, size = 36.dp, state = MausState.IDLE, animated = false)

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = bot.name,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (bot.title.isNotEmpty()) {
                Text(
                    text = bot.title,
                    fontSize = 13.sp,
                    color = secondaryTint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        // The row itself carries the checked state to the reader; the mark is
        // the same tick and empty ring iOS draws.
        if (selected) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = Color(MausPalette.argb(bot.color)),
                modifier = Modifier.size(22.dp),
            )
        } else {
            Box(
                Modifier
                    .size(22.dp)
                    .border(2.dp, secondaryTint.copy(alpha = 0.4f), CircleShape),
            )
        }
    }
}

/**
 * Who a group can be made from, in what order, and when Create is live.
 *
 * The name is not a rule of this screen: `:core` decides that a blank one is
 * left out of the request so the harness can name the room after its first
 * member.
 */
internal object NewGroupRules {
    /** Roster order, hidden bots left out — the order the picker offers them in. */
    fun selectable(state: CompanionState): List<Bot> = state.bots.filter { it.hidden != true }

    /**
     * Members in the order the picker listed them rather than the order they were
     * tapped, so a room the harness has to name follows the list, not the taps.
     * Anything [bots] no longer offers is dropped on the way out.
     */
    fun members(bots: List<Bot>, selected: Set<String>): List<String> =
        bots.mapNotNull { bot -> bot.id.takeIf { it in selected } }

    /**
     * One bot is a room the harness will make; none is not, and neither is a
     * second press.
     *
     * Gated on the raw selection, as `NewGroupSheet.swift:67` is, not on what
     * [members] resolves it to: when a picked bot leaves the fleet mid-sheet both
     * ports keep Create lit and can send an empty member list. Mirrored rather
     * than quietly improved — the fix belongs to the source first.
     */
    fun canCreate(selected: Set<String>, creating: Boolean): Boolean =
        selected.isNotEmpty() && !creating
}
