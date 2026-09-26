package com.openmausbot.companion.ui

import androidx.compose.ui.res.stringResource

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.ActivityDetail
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What little the phone gets to configure — the port of
 * `ios/App/SettingsView.swift`.
 *
 * Almost nothing, on purpose: Phone settings, API keys and pairing all live
 * on the computer, because losing the phone must not mean losing the ability to
 * lock it out (§13). This is a status page with an unpair button.
 *
 * It is also the screen the unpaired home reaches, which is why both actions are
 * optional. `SettingsView(onConnect:)` in `ios/App/SettingsView.swift` does the
 * same thing: someone who answered "Not now" can still get to notifications
 * without first entering the connection flow they just declined, and the parts
 * that need a pairing — routines, unpairing, the address — are simply not there
 * to be pressed.
 */
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenRoutines: (() -> Unit)? = null,
    onOpenConnectedApps: (() -> Unit)? = null,
    /** Offered instead of the computer's details when there is no pairing. */
    onConnect: (() -> Unit)? = null,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connections by session.connections.collectAsState()
    val status by session.status.collectAsState()
    val notifications by environment.notifications.access.collectAsState()
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val haptics = rememberHaptics()

    var editingAddress by remember { mutableStateOf(false) }
    var addressText by remember { mutableStateOf("") }
    var addressError by remember { mutableStateOf<String?>(null) }
    val invalidAddressMessage = stringResource(R.string.mobile_settings_invalid_address)
    var showingFullAddress by remember { mutableStateOf(false) }
    var addressCopied by remember { mutableStateOf(false) }
    var reconnecting by remember { mutableStateOf(false) }
    var confirmingUnpair by remember { mutableStateOf(false) }
    var pendingComputerRemoval by remember { mutableStateOf<Connection?>(null) }
    var choosingActivity by remember { mutableStateOf(false) }
    var editingQuickReplies by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderBackButton(onBack)
            Text(stringResource(R.string.mobile_settings_c7f73bb5), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        }
        HorizontalDivider()

        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            SettingsSection(stringResource(R.string.mobile_computer_924645b3)) {
                val bound = connection
                if (bound != null) {
                    val address = SettingsPolicy.addressText(bound)
                    SettingsRow(stringResource(R.string.mobile_settings_name), bound.name)
                    AddressRow(
                        address = address,
                        expanded = showingFullAddress,
                        copied = addressCopied,
                        onToggle = { showingFullAddress = !showingFullAddress },
                        onCopy = {
                            scope.launch {
                                clipboard.setClipEntry(
                                    ClipEntry(ClipData.newPlainText(ADDRESS_CLIP_LABEL, address)),
                                )
                                addressCopied = true
                                delay(COPIED_LABEL_MILLIS)
                                addressCopied = false
                            }
                        },
                    )
                    // The stored address can simply go stale. Editing it here
                    // keeps the pairing and its token (§7).
                    SettingsButton(stringResource(R.string.mobile_edit_address_31fe67f4)) {
                        addressText = address
                        addressError = null
                        editingAddress = true
                    }
                } else if (onConnect != null) {
                    SettingsButton(stringResource(R.string.mobile_settings_connect_computer), onClick = onConnect)
                }
                SettingsRow(stringResource(R.string.mobile_settings_connection_label), localizedConnectionStatus(status))
                if (bound != null) {
                    SettingsButton(stringResource(R.string.mobile_settings_connect_another_computer)) {
                        haptics.play(TactileAction.CONNECT_ANOTHER_COMPUTER)
                        session.beginPairing()
                    }
                }
            }

            val otherComputers = connections.filter { it.id != connection?.id }
            if (otherComputers.isNotEmpty()) {
                SettingsSection(stringResource(R.string.mobile_settings_other_computers)) {
                    otherComputers.forEach { computer ->
                        SettingsButton(stringResource(R.string.mobile_settings_use_computer, computer.name)) {
                            haptics.play(TactileAction.SWITCH_COMPUTER)
                            session.switchComputer(computer.id)
                        }
                        SettingsButton(stringResource(R.string.mobile_settings_remove_computer, computer.name), destructive = true) {
                            pendingComputerRemoval = computer
                        }
                    }
                    Footnote(stringResource(R.string.mobile_settings_computers_paired_separately))
                }
            }

            if (connection != null) {
                SettingsSection(stringResource(R.string.mobile_settings_troubleshooting)) {
                    Footnote(localizedTroubleshootingText(status))
                    SettingsButton(
                        text = stringResource(R.string.mobile_settings_try_reconnecting),
                        enabled = !reconnecting,
                        trailing = {
                            if (reconnecting) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                )
                            }
                        },
                    ) {
                        scope.launch {
                            reconnecting = true
                            // Waits until the stream leaves connecting (or 10s),
                            // so the spinner means what it appears to mean.
                            session.refresh()
                            reconnecting = false
                        }
                    }
                }
            }

            SettingsSection(stringResource(R.string.mobile_settings_notifications_section)) {
                SettingsRow(
                    stringResource(R.string.mobile_settings_status_label),
                    localizedNotificationStatus(notifications),
                )
                SettingsButton(
                    text = localizedNotificationButton(notifications),
                    enabled = NotificationPermissionController.buttonEnabled(notifications),
                    onClick = environment.notifications::act,
                )
                Footnote(stringResource(R.string.mobile_settings_notifications_footer))
            }

            SettingsSection(stringResource(R.string.mobile_settings_background_connection)) {
                val alwaysOnEnabled by environment.alwaysOnEnabled.collectAsState()
                SettingsRow(
                    stringResource(R.string.mobile_settings_status_label),
                    stringResource(if (alwaysOnEnabled) R.string.mobile_settings_always_on else R.string.mobile_settings_only_while_open),
                )
                SettingsButton(
                    text = stringResource(if (alwaysOnEnabled) R.string.mobile_settings_turn_off else R.string.mobile_settings_turn_on),
                    onClick = environment.onToggleAlwaysOn,
                )
                Footnote(
                    if (alwaysOnEnabled) {
                        stringResource(R.string.mobile_settings_background_on_description)
                    } else {
                        stringResource(R.string.mobile_settings_background_off_description)
                    },
                )
            }

            SettingsSection(stringResource(R.string.mobile_settings_chat_section)) {
                SettingsRow(stringResource(R.string.mobile_settings_activity_label), localizedActivityLabel(activityDetail))
                SettingsButton(stringResource(R.string.mobile_settings_change_activity_detail)) { choosingActivity = true }
                SettingsButton(stringResource(R.string.mobile_quick_replies_c14223c4)) { editingQuickReplies = true }
                Footnote(localizedActivityCaption(activityDetail))
            }

            // Routine schedules live on the computer this phone is bound to.
            // With no binding there is nothing to schedule against, so the row
            // is absent rather than present and dead.
            if (onOpenRoutines != null || onOpenConnectedApps != null) {
                SettingsSection(stringResource(R.string.mobile_settings_workspace_section)) {
                    onOpenRoutines?.let { openRoutines ->
                        SettingsButton(
                            text = stringResource(R.string.mobile_threads_routines_65d7efcd),
                            icon = R.drawable.ic_schedule,
                            onClick = openRoutines,
                        )
                    }
                    onOpenConnectedApps?.let { openConnectedApps ->
                        SettingsButton(
                            text = stringResource(R.string.mobile_connected_apps_8ab72a8e),
                            onClick = openConnectedApps,
                        )
                    }
                    Footnote(stringResource(R.string.mobile_settings_workspace_footer))
                }
            }

            if (connection != null) {
                SettingsSection(null) {
                    SettingsButton(
                        text = stringResource(if (connections.size > 1) R.string.mobile_settings_remove_this_computer else R.string.mobile_settings_unpair_this_phone),
                        destructive = true,
                    ) { confirmingUnpair = true }
                    Footnote(stringResource(R.string.mobile_settings_unpair_footer))
                }
            }

            SettingsSection(stringResource(R.string.mobile_settings_not_here)) {
                Footnote(stringResource(R.string.mobile_settings_not_here_body))
            }
        }
    }

    if (editingAddress) {
        AlertDialog(
            onDismissRequest = { editingAddress = false },
            title = { Text(stringResource(R.string.mobile_edit_address_31fe67f4)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.mobile_settings_edit_address_message), fontSize = 14.sp)
                    OutlinedTextField(
                        value = addressText,
                        onValueChange = {
                            addressText = it
                            addressError = null
                        },
                        placeholder = { Text(stringResource(R.string.mobile_https_mac_example_or_192_168_1_42__e277eb2d)) },
                        singleLine = true,
                        isError = addressError != null,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    addressError?.let {
                        Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        // Session re-parses, re-dials and persists; the walk and
                        // promote semantics stay its job. The form only refuses
                        // what it can already tell is not an address.
                        if (session.updateAddress(addressText)) {
                            editingAddress = false
                        } else {
                            addressError = invalidAddressMessage
                        }
                    },
                ) { Text(stringResource(R.string.mobile_save_efc007a3)) }
            },
            dismissButton = {
                TextButton(onClick = { editingAddress = false }) { Text(stringResource(R.string.mobile_cancel_77dfd213)) }
            },
        )
    }

    if (confirmingUnpair) {
        AlertDialog(
            onDismissRequest = { confirmingUnpair = false },
            title = { Text(if (connections.size > 1) stringResource(R.string.mobile_remove_connection_name_e686927b, connection?.name.orEmpty()) else stringResource(R.string.mobile_settings_unpair_confirm_title)) },
            text = {
                Text(
                    if (connections.size > 1) {
                        stringResource(R.string.mobile_this_removes_the_saved_connection__45c7d71e)
                    } else {
                        stringResource(R.string.mobile_settings_unpair_confirm_message)
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingUnpair = false
                        // Local token and connection only. Revoking the device
                        // itself is Settings → Phone on the computer (§6).
                        session.signOut()
                    },
                ) {
                    // With another computer saved this removes one of them; the
                    // phone stays paired, so "Unpair" would be the wrong promise.
                    Text(
                        text = if (connections.size > 1) stringResource(R.string.mobile_remove_e963907d) else stringResource(R.string.mobile_unpair_9c293ad4),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingUnpair = false }) { Text(stringResource(R.string.mobile_cancel_77dfd213)) }
            },
        )
    }

    pendingComputerRemoval?.let { computer ->
        AlertDialog(
            onDismissRequest = { pendingComputerRemoval = null },
            title = { Text(stringResource(R.string.mobile_remove_computer_name_272e4835, computer.name)) },
            text = { Text(stringResource(R.string.mobile_this_removes_the_saved_connection__54db6818)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingComputerRemoval = null
                        session.forgetConnection(computer.id)
                    },
                ) { Text(stringResource(R.string.mobile_remove_e963907d), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingComputerRemoval = null }) { Text(stringResource(R.string.mobile_cancel_77dfd213)) }
            },
        )
    }

    if (choosingActivity) {
        AlertDialog(
            onDismissRequest = { choosingActivity = false },
            title = { Text(stringResource(R.string.mobile_activity_detail_049f3bdf)) },
            text = {
                // iOS draws a Picker (SettingsView.swift:67-78), which marks the
                // choice already in force; three plain buttons do not.
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ActivityDetail.entries.forEach { detail ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = MIN_TOUCH_TARGET)
                                .selectable(
                                    selected = detail == activityDetail,
                                    role = Role.RadioButton,
                                    onClick = {
                                        environment.chatPreferences.setActivityDetail(detail)
                                        choosingActivity = false
                                    },
                                )
                                .padding(vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = detail == activityDetail, onClick = null)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(localizedActivityLabel(detail), textAlign = TextAlign.Start)
                                Text(localizedActivityCaption(detail), fontSize = 12.sp, color = secondaryTint)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingActivity = false }) { Text(stringResource(R.string.mobile_cancel_77dfd213)) } },
        )
    }

    if (editingQuickReplies) {
        QuickRepliesEditor(
            preferences = environment.chatPreferences,
            onDismiss = { editingQuickReplies = false },
        )
    }
}

@Composable
private fun SettingsSection(title: String?, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        title?.let {
            Text(
                text = localizedMobileCopy(it).uppercase(),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = secondaryTint,
            )
        }
        HorizontalDivider()
        content()
    }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(localizedMobileCopy(label), fontSize = 15.sp, color = secondaryTint)
        Text(
            text = value,
            fontSize = 15.sp,
            textAlign = TextAlign.End,
            modifier = Modifier
                .weight(1f)
                .padding(start = 12.dp),
        )
    }
}

/**
 * The address, short enough to read at a glance and long enough to copy — the
 * port of the connection details in `ios/App/SettingsView.swift:346-371`.
 */
@Composable
private fun AddressRow(
    address: String,
    expanded: Boolean,
    copied: Boolean,
    onToggle: () -> Unit,
    onCopy: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.mobile_address_d70f93df), fontSize = 15.sp, color = secondaryTint)
        if (expanded) {
            // Selectable, because the reason to show it in full is to take it away.
            SelectionContainer {
                Text(
                    text = address,
                    fontSize = 13.sp,
                    fontFamily = FontFamily.Monospace,
                    color = secondaryTint,
                )
            }
        } else {
            Text(
                text = shortenedAddress(address),
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                color = secondaryTint,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = onToggle) {
                Text(if (expanded) stringResource(R.string.mobile_hide_full_address_63c5e519) else stringResource(R.string.mobile_show_full_address_889be5c7))
            }
            TextButton(onClick = onCopy) {
                Text(if (copied) stringResource(R.string.mobile_copied_8e3df45a) else stringResource(R.string.mobile_copy_af74f7c5))
            }
        }
    }
}

@Composable
private fun SettingsButton(
    text: String,
    enabled: Boolean = true,
    destructive: Boolean = false,
    icon: Int? = null,
    /** Drawn at the end of the row — a progress indicator while one is running. */
    trailing: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    val tint = if (destructive) {
        MaterialTheme.colorScheme.error
    } else {
        MaterialTheme.colorScheme.primary
    }
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH_TARGET),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            icon?.let {
                Icon(
                    painter = painterResource(it),
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(20.dp),
                )
            }
            Text(
                text = localizedMobileCopy(text),
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Start,
                color = tint,
            )
            trailing?.invoke()
        }
    }
}

@Composable
private fun Footnote(text: String) {
    Text(text = localizedMobileCopy(text), fontSize = 13.sp, color = secondaryTint)
}

@Composable
private fun localizedConnectionStatus(status: Session.Status): String = when (status) {
    Session.Status.Live -> stringResource(R.string.mobile_settings_connected_status)
    Session.Status.Connecting -> stringResource(R.string.mobile_settings_connecting_status)
    Session.Status.Unpaired -> stringResource(R.string.mobile_settings_not_paired_status)
    Session.Status.Unauthorized -> stringResource(R.string.mobile_settings_unpaired_on_computer_status)
    is Session.Status.Offline -> status.message
}

@Composable
private fun localizedTroubleshootingText(status: Session.Status): String = when (status) {
    Session.Status.Live -> stringResource(R.string.mobile_settings_troubleshooting_live)
    Session.Status.Connecting -> stringResource(R.string.mobile_settings_troubleshooting_connecting)
    Session.Status.Unauthorized -> stringResource(R.string.mobile_settings_troubleshooting_unpaired)
    Session.Status.Unpaired -> stringResource(R.string.mobile_settings_troubleshooting_not_paired)
    is Session.Status.Offline -> status.message
}

@Composable
private fun localizedNotificationStatus(access: NotificationAccess): String = when (access) {
    NotificationAccess.GRANTED -> stringResource(R.string.mobile_settings_notifications_allowed)
    NotificationAccess.ASKABLE -> stringResource(R.string.mobile_settings_notifications_not_allowed)
    NotificationAccess.BLOCKED -> stringResource(R.string.mobile_settings_notifications_disabled)
}

@Composable
private fun localizedNotificationButton(access: NotificationAccess): String = when (access) {
    NotificationAccess.GRANTED -> stringResource(R.string.mobile_settings_notifications_on)
    NotificationAccess.ASKABLE -> stringResource(R.string.mobile_settings_enable_notifications)
    NotificationAccess.BLOCKED -> stringResource(R.string.mobile_settings_open_notification_settings)
}

@Composable
private fun localizedActivityLabel(detail: ActivityDetail): String = when (detail) {
    ActivityDetail.FULL -> stringResource(R.string.mobile_activity_full)
    ActivityDetail.REDUCED -> stringResource(R.string.mobile_activity_reduced)
    ActivityDetail.HIDDEN -> stringResource(R.string.mobile_activity_hidden)
}

@Composable
private fun localizedActivityCaption(detail: ActivityDetail): String = when (detail) {
    ActivityDetail.FULL -> stringResource(R.string.mobile_activity_full_caption)
    ActivityDetail.REDUCED -> stringResource(R.string.mobile_activity_reduced_caption)
    ActivityDetail.HIDDEN -> stringResource(R.string.mobile_activity_hidden_caption)
}

private const val ADDRESS_CLIP_LABEL = "OpenMausMobile computer address"

/** Long enough for "Copied" to be read, short enough not to linger (iOS `:363-367`). */
private const val COPIED_LABEL_MILLIS = 2_000L

/**
 * What the Troubleshooting section says before offering to reconnect — the port
 * of `ConnectionSecurityView.troubleshootingText` (`ios/App/SettingsView.swift:445-458`).
 */
internal fun troubleshootingText(status: Session.Status): String = when (status) {
    Session.Status.Live -> "This computer is connected and responding normally."
    Session.Status.Connecting -> "OpenMausBot is trying the saved connection automatically."
    Session.Status.Unauthorized -> "This phone was removed from the computer. Pair it again to reconnect."
    Session.Status.Unpaired -> "This phone is not paired with a computer."
    is Session.Status.Offline -> status.message
}

/**
 * The address with its middle taken out, so a long tailnet name still shows the
 * host and the port it ends in — `shortened` in `ios/App/SettingsView.swift:460-464`.
 */
internal fun shortenedAddress(address: String): String {
    if (address.length <= 14) return address
    val leading = minOf(20, maxOf(8, address.length - 8))
    return address.take(leading) + "…" + address.takeLast(6)
}
