package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.LiveSettings
import com.openmausbot.companion.core.LiveSettingsPatch
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The gear's sheet: voice, sound output, read typed replies, idle hang-up.
 * Every change is written to the computer as it is made — the settings are
 * the computer's, shared with the desktop and the iPhone; the sound output is
 * this phone's own. The OpenAI key is not here: phones can neither read nor
 * write it. The sheet opens by saying what a call sends to OpenAI.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveCallSettingsSheet(onDismiss: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val liveCalls = environment.liveCalls
    val scope = rememberCoroutineScope()
    val local by liveCalls.state.collectAsState()
    var settings by remember { mutableStateOf<LiveSettings?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val loaded = session.liveSettings()
        settings = loaded ?: LiveSettings()
        if (loaded == null) error = LOAD_FAILED
    }

    fun save(patch: LiveSettingsPatch) {
        scope.launch {
            saving = true
            try {
                settings = session.updateLiveSettings(patch)
                error = null
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                error = failure.message?.takeIf { it.isNotBlank() } ?: SAVE_FAILED
            } finally {
                saving = false
            }
        }
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        LiveCallSettingsForm(
            settings = settings,
            speaker = local.speaker,
            saving = saving,
            error = error,
            onDone = onDismiss,
            onVoice = { save(LiveSettingsPatch(voice = it)) },
            // Sound output is this phone's, not the computer's: no request.
            onSpeaker = liveCalls::setSpeaker,
            onReadTypedReplies = { save(LiveSettingsPatch(readTypedReplies = it)) },
            onIdleMinutes = { save(LiveSettingsPatch(idleMinutes = it)) },
        )
    }
}

/**
 * The sheet's content, kept apart from the sheet so a test can mount it without a bottom sheet.
 *
 * Done and the title stay put while the rows scroll: the voice list alone is
 * twenty-two rows, and Done should not be a scroll back to the top away.
 */
@Composable
internal fun LiveCallSettingsForm(
    settings: LiveSettings?,
    speaker: Boolean,
    saving: Boolean,
    error: String?,
    onDone: () -> Unit,
    onVoice: (String) -> Unit,
    onSpeaker: (Boolean) -> Unit,
    onReadTypedReplies: (Boolean) -> Unit,
    onIdleMinutes: (Int) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
            TextButton(onClick = onDone, modifier = Modifier.align(Alignment.CenterStart)) { Text("Done") }
            Text(
                text = "Live call settings",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.Center),
            )
        }
        Column(
            modifier = Modifier
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            // First, before any choice: what a call sends to OpenAI, and that the key stays home.
            Text(
                text = LiveCallRules.DISCLOSURE,
                fontSize = 13.sp,
                color = secondaryTint,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            if (settings == null) {
                Text(
                    text = "Loading…",
                    fontSize = 15.sp,
                    color = secondaryTint,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
                return@Column
            }
            // The route gives a connected headset the call over this choice (`LiveCallAudioRouting`).
            FormSection(header = "Sound output", footer = "A connected headset takes the call instead.") {
                ChoiceRow(label = "Speaker", selected = speaker, onSelect = { onSpeaker(true) })
                ChoiceRow(label = "Earpiece", selected = !speaker, onSelect = { onSpeaker(false) })
            }
            FormSection(header = "Voice", footer = LiveCallRules.VOICE_APPLIES_NEXT_CALL) {
                val current = settings.voice.ifBlank { LiveCallRules.VOICE_OPTIONS.first().id }
                LiveCallRules.VOICE_OPTIONS.forEach { option ->
                    ChoiceRow(
                        label = option.label,
                        selected = option.id == current,
                        enabled = !saving,
                        onSelect = { onVoice(option.id) },
                    )
                }
            }
            FormSection(header = "During a call", footer = LiveCallRules.TYPED_REPLIES_FOOTER) {
                SwitchRow(
                    label = "Read replies to typed messages",
                    checked = settings.readTypedReplies,
                    enabled = !saving,
                    onCheckedChange = onReadTypedReplies,
                )
            }
            FormSection(
                header = "Hang up after silence",
                footer = "Minutes without speech before the call ends on its own.",
            ) {
                LiveCallRules.idleChoices(settings.idleMinutes).forEach { minutes ->
                    ChoiceRow(
                        label = if (minutes == 1) "1 minute" else "$minutes minutes",
                        selected = minutes == settings.idleMinutes,
                        enabled = !saving,
                        onSelect = { onIdleMinutes(minutes) },
                    )
                }
            }
            error?.let {
                Text(
                    text = it,
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }
        }
    }
}

/** A radio row, as `SettingsScreen` draws the activity-detail picker: the whole line selects. */
@Composable
private fun ChoiceRow(label: String, selected: Boolean, enabled: Boolean = true, onSelect: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Text(text = label, fontSize = 15.sp)
    }
}

private const val LOAD_FAILED = "Could not read the Live settings from your computer."
private const val SAVE_FAILED = "Could not save that setting."

/**
 * Before this phone's first Live call: what a call sends to OpenAI (the
 * settings sheet's sentence), with Start call and Cancel. A phone has no Live
 * switch, so its first call is where Live is turned on.
 */
@Composable
internal fun LiveCallDisclosureDialog(onStart: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        text = { Text(LiveCallRules.DISCLOSURE) },
        confirmButton = { TextButton(onClick = onStart) { Text(LiveCallRules.START_CALL) } },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } },
    )
}
