package com.openmausbot.companion.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openmausbot.companion.R
import com.openmausbot.companion.avatar.AvatarImagePicker
import com.openmausbot.companion.avatar.AvatarImageRules
import com.openmausbot.companion.avatar.PreparedAvatar
import com.openmausbot.companion.core.AvatarCrop
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotProfilePatch
import com.openmausbot.companion.core.ConfigStatus
import com.openmausbot.companion.core.Instance
import com.openmausbot.companion.core.ModelSelection
import com.openmausbot.companion.core.Voice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The paired-safe subset of bot settings — the port of
 * `ios/App/AgentProfileView.swift`.
 *
 * The model, identity, avatar, notifications and the renderer-neutral voice
 * choice. Shared provider keys stay on the computer: this sheet sees the model
 * catalog and configured / not configured, and offers no field that could
 * carry a key.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AgentProfileSheet(bot: Bot, onDismiss: () -> Unit, onOpenOverview: (String) -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val player = environment.voicePreview

    // The record the sheet was opened on, so the form has an origin even after
    // the fleet drops the agent; `current` is what every action is applied to.
    val opened = remember { bot }
    val current = state.bot(opened.id) ?: opened

    var form by rememberSaveable(stateSaver = ProfileFormSaver) {
        mutableStateOf(ProfileForm.of(opened))
    }
    var baseline by rememberSaveable(stateSaver = ProfileFormSaver) {
        mutableStateOf(ProfileForm.of(opened))
    }
    var prompt by rememberSaveable { mutableStateOf("") }
    var voices by remember { mutableStateOf<List<Voice>>(emptyList()) }
    var config by remember { mutableStateOf<ConfigStatus?>(null) }
    var busy by remember { mutableStateOf(false) }

    // The Model section. The draft survives rotation; the catalog is reloaded.
    var instances by remember { mutableStateOf<List<Instance>>(emptyList()) }
    var modelsLoaded by remember { mutableStateOf(false) }
    var savedModel by remember { mutableStateOf(opened.modelSelection) }
    var selectedInstanceId by rememberSaveable { mutableStateOf(opened.modelSelection.instanceId) }
    var selectedModelId by rememberSaveable { mutableStateOf(opened.modelSelection.model) }
    // "" is the engine default; the picker has no null row.
    var selectedEffort by rememberSaveable { mutableStateOf(opened.modelSelection.effort.orEmpty()) }
    val selectedInstance = instances.firstOrNull { it.instanceId == selectedInstanceId }
    val modelDraft = ModelSelection(selectedInstanceId, selectedModelId, selectedEffort.ifEmpty { null })

    fun liveBot(): Bot = session.state.value.bot(opened.id) ?: opened

    fun showModel(selection: ModelSelection) {
        selectedInstanceId = selection.instanceId
        selectedModelId = selection.model
        selectedEffort = selection.effort.orEmpty()
    }

    LaunchedEffect(Unit) {
        val loaded = coroutineScope {
            val status = async { session.configStatus() }
            val options = async { session.voiceOptions() }
            val catalog = async { session.modelInstances() }
            Triple(status.await(), options.await(), catalog.await())
        }
        config = loaded.first
        voices = loaded.second
        instances = loaded.third
        modelsLoaded = true
        // A stored "speak replies" that nothing can speak is turned off before
        // the toggle is ever drawn.
        form = ProfileRules.applyLoadedConfig(form, loaded.first)
    }

    // One preview at a time, and none that outlives this sheet.
    DisposableEffect(lifecycleOwner) {
        player.bind(lifecycleOwner)
        onDispose { player.unbind(lifecycleOwner) }
    }
    LaunchedEffect(Unit) {
        player.playbackErrors.collect { session.actionError = it }
    }

    val pickImage = rememberLauncherForActivityResult(
        remember { AvatarImagePicker.contract() },
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            try {
                when (val prepared = AvatarImagePicker.read(context.contentResolver, uri)) {
                    is PreparedAvatar.Rejected -> session.actionError = prepared.message
                    is PreparedAvatar.Ready -> {
                        val intended = AvatarImageRules.intendedUploadCrop(form.crop)
                        val updated = session.uploadAvatar(
                            data = prepared.data,
                            mime = prepared.mime,
                            forBot = liveBot(),
                            crop = intended,
                        )
                        if (updated != null) {
                            val crop = updated.avatarCrop ?: intended
                            form = form.copy(crop = crop)
                            baseline = baseline.copy(crop = crop)
                        }
                    }
                }
            } finally {
                busy = false
            }
        }
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Box {
            Column(
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                    TextButton(
                        onClick = onDismiss,
                        modifier = Modifier.align(Alignment.CenterStart),
                    ) {
                        Text("Done")
                    }
                    Text(
                        text = "Bot settings",
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.align(Alignment.Center),
                    )
                }

                FormSection(header = null) {
                    ActionRow(
                        text = "What this bot does",
                        icon = Icons.Filled.Info,
                        onClick = { onOpenOverview(bot.id) },
                    )
                }

                FormSection(header = "Model", footer = ModelRules.FOOTER) {
                    val instanceChoices = ModelRules.instanceChoices(instances, savedModel)
                    if (!modelsLoaded) {
                        Row(
                            modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH_TARGET),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(ModelRules.LOADING, fontSize = 15.sp, modifier = Modifier.weight(1f))
                            CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        }
                    } else if (instanceChoices.isEmpty()) {
                        IconNote(text = ModelRules.NONE_AVAILABLE, icon = Icons.Filled.Warning)
                    } else {
                        val providerRows = buildList {
                            if (ModelRules.providerMissing(instances, selectedInstanceId)) {
                                add(
                                    VoiceChoice(
                                        id = selectedInstanceId,
                                        label = ModelRules.CURRENT_PROVIDER_UNAVAILABLE,
                                        detail = null,
                                        enabled = false,
                                    ),
                                )
                            }
                            instanceChoices.forEach {
                                add(
                                    VoiceChoice(
                                        id = it.instanceId,
                                        label = ModelRules.instanceLabel(it),
                                        detail = null,
                                        enabled = it.snapshot.isAvailable,
                                    ),
                                )
                            }
                        }
                        ChoicePicker(
                            label = "Provider",
                            choices = providerRows,
                            selected = selectedInstanceId,
                            onSelect = { id ->
                                val instance = instances.firstOrNull { it.instanceId == id }
                                if (instance != null) showModel(ModelRules.defaultsFor(instance, savedModel))
                            },
                        )
                        ChoicePicker(
                            label = "Model",
                            choices = ModelRules.modelChoices(selectedInstance, selectedModelId).map {
                                VoiceChoice(id = it.id, label = it.label, detail = null, enabled = true)
                            },
                            selected = selectedModelId,
                            enabled = selectedInstance?.snapshot?.isAvailable == true,
                            onSelect = { selectedModelId = it },
                        )
                        val effortLevels = ModelRules.effortLevels(selectedInstance)
                        if (effortLevels.isNotEmpty()) {
                            ChoicePicker(
                                label = "Reasoning effort",
                                choices = buildList {
                                    add(VoiceChoice(id = "", label = ModelRules.DEFAULT_EFFORT_LABEL, detail = null, enabled = true))
                                    effortLevels.forEach {
                                        add(VoiceChoice(id = it, label = ModelRules.effortLabel(it), detail = null, enabled = true))
                                    }
                                },
                                selected = selectedEffort,
                                onSelect = { selectedEffort = it },
                            )
                        }
                        ModelRules.note(current.busy, selectedInstance)?.let { note ->
                            IconNote(text = note, icon = Icons.Filled.Info)
                        }
                        ActionRow(
                            text = "Apply model",
                            icon = Icons.Filled.Check,
                            enabled = !busy && ModelRules.canApply(
                                loaded = modelsLoaded,
                                botBusy = current.busy,
                                instance = selectedInstance,
                                draft = modelDraft,
                                saved = savedModel,
                            ),
                            onClick = {
                                scope.launch {
                                    busy = true
                                    try {
                                        val updated = session.updateModel(modelDraft, liveBot())
                                        if (updated != null) {
                                            savedModel = updated.modelSelection
                                            showModel(updated.modelSelection)
                                        }
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                        )
                    }
                }

                FormSection(header = "Avatar", footer = ProfileRules.AVATAR_FOOTER) {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        BotAvatar(
                            bot = current,
                            size = 112.dp,
                            state = MausState.HAPPY,
                            contentDescription = "${current.name} avatar",
                        )
                    }

                    SingleChoiceSegmentedButtonRow(
                        modifier = Modifier.fillMaxWidth().height(MIN_TOUCH_TARGET),
                    ) {
                        AvatarCrop.entries.forEachIndexed { index, option ->
                            SegmentedButton(
                                selected = form.crop == option,
                                onClick = { form = form.copy(crop = option) },
                                shape = SegmentedButtonDefaults.itemShape(
                                    index = index,
                                    count = AvatarCrop.entries.size,
                                ),
                            ) {
                                Text(ProfileRules.cropLabel(option))
                            }
                        }
                    }

                    ActionRow(
                        text = "Upload image",
                        icon = Icons.Filled.AddCircle,
                        enabled = !busy,
                        onClick = { pickImage.launch(AvatarImagePicker.request()) },
                    )

                    if (current.avatarUrl != null) {
                        ActionRow(
                            text = "Use mascot",
                            icon = Icons.Filled.Delete,
                            enabled = !busy,
                            destructive = true,
                            onClick = {
                                scope.launch {
                                    busy = true
                                    try {
                                        val updated = session.updateProfile(
                                            BotProfilePatch(
                                                avatarUrl = BotProfilePatch.AvatarURL.Clear,
                                                avatarCrop = AvatarCrop.MASCOT,
                                            ),
                                            liveBot(),
                                        )
                                        if (updated != null) {
                                            val crop = updated.avatarCrop ?: AvatarCrop.MASCOT
                                            form = form.copy(crop = crop)
                                            baseline = baseline.copy(crop = crop)
                                        }
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                        )
                    }
                }

                FormSection(
                    header = "Generate an avatar",
                    footer = ProfileRules.generateFooter(config),
                ) {
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        label = { Text("Art direction") },
                        minLines = 2,
                        maxLines = 5,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    ActionRow(
                        text = "Generate on computer",
                        painter = R.drawable.ic_sparkles,
                        enabled = ProfileRules.canGenerate(busy, config, prompt),
                        onClick = {
                            scope.launch {
                                busy = true
                                try {
                                    val intended = AvatarImageRules.intendedUploadCrop(form.crop)
                                    val generated = session.generateAvatar(
                                        ProfileRules.generatePrompt(prompt),
                                        liveBot(),
                                    ) ?: return@launch
                                    // Generation picks a safe crop server-side;
                                    // the selector is the user's explicit choice,
                                    // so persist it against the returned
                                    // attachment rather than leaving the two out
                                    // of sync.
                                    val updated = session.updateProfile(
                                        BotProfilePatch(avatarCrop = intended),
                                        generated,
                                    )
                                    val crop = if (updated != null) {
                                        updated.avatarCrop ?: intended
                                    } else {
                                        // Generation itself succeeded: reflect its
                                        // authoritative fallback rather than
                                        // claiming the requested crop was saved.
                                        generated.avatarCrop ?: AvatarCrop.MASCOT
                                    }
                                    form = form.copy(crop = crop)
                                    baseline = baseline.copy(crop = crop)
                                } finally {
                                    busy = false
                                }
                            }
                        },
                    )
                }

                FormSection(header = "Identity") {
                    OutlinedTextField(
                        value = form.name,
                        onValueChange = { form = form.copy(name = it) },
                        label = { Text("Name") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Words,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = form.title,
                        onValueChange = { form = form.copy(title = it) },
                        label = { Text("Title") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = form.description,
                        onValueChange = { form = form.copy(description = it) },
                        label = { Text("What this agent does") },
                        minLines = 3,
                        maxLines = 8,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    SwitchRow(
                        label = "Agent notifications",
                        checked = form.notifications,
                        onCheckedChange = { form = form.copy(notifications = it) },
                    )
                }

                VoiceSection(config = config) {
                    ChoicePicker(
                        label = "Voice",
                        choices = ProfileRules.voiceChoices(config, voices, form.voice),
                        selected = form.voice,
                        onSelect = { form = form.copy(voice = it) },
                    )
                    SwitchRow(
                        label = "Speak replies",
                        checked = form.speakReplies,
                        enabled = ProfileRules.selectedVoiceCanSpeak(config, form.voice),
                        onCheckedChange = { form = form.copy(speakReplies = it) },
                    )
                    ActionRow(
                        text = "Preview voice",
                        painter = R.drawable.ic_volume_up,
                        enabled = ProfileRules.canPreview(busy, config, form.voice),
                        onClick = {
                            scope.launch {
                                if (!ProfileRules.selectedVoiceCanSpeak(config, form.voice)) {
                                    session.actionError = ProfileRules.PREVIEW_REFUSED
                                    return@launch
                                }
                                busy = true
                                try {
                                    val data = session.previewVoice(form.voice, liveBot())
                                        ?: return@launch
                                    // `rememberCoroutineScope` dispatches on
                                    // main, and starting a preview reaches
                                    // MediaPlayer.prepare(), which blocks
                                    // until the source is decodable. The
                                    // controller serialises every transition
                                    // on its own lock and its callbacks are
                                    // delivered on the main Looper, so it is
                                    // safe to start from a worker; the result
                                    // lands back on main to be reported.
                                    val failure = withContext(Dispatchers.IO) {
                                        player.play(data)
                                    }
                                    failure?.let { session.actionError = it }
                                } finally {
                                    busy = false
                                }
                            }
                        },
                    )
                    ProfileRules.pickAVoiceHint(config, form.voice)?.let { hint ->
                        IconNote(text = hint, icon = Icons.Filled.Info)
                    }
                }

                FormSection(header = null) {
                    ActionRow(
                        text = "Save profile changes",
                        enabled = ProfileRules.canSave(form, busy),
                        onClick = {
                            scope.launch {
                                busy = true
                                val updated = session.updateProfile(
                                    ProfileRules.patch(form, baseline, config),
                                    liveBot(),
                                )
                                if (updated != null) {
                                    form = ProfileForm.of(updated)
                                    baseline = ProfileForm.of(updated)
                                }
                                busy = false
                            }
                        },
                    )
                }
            }

            if (busy) {
                Box(
                    modifier = Modifier.matchParentSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(44.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
/** A SwiftUI `Picker` as Material draws one: a read-only field that opens a menu. */
@Composable
internal fun ChoicePicker(
    label: String,
    choices: List<VoiceChoice>,
    selected: String,
    onSelect: (String) -> Unit,
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = choices.firstOrNull { it.id == selected }?.label.orEmpty()
    ExposedDropdownMenuBox(
        expanded = expanded && enabled,
        onExpandedChange = { if (enabled) expanded = it },
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = selectedLabel,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            choices.forEach { choice ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(choice.label)
                            choice.detail?.let {
                                Text(it, fontSize = 13.sp, color = secondaryTint)
                            }
                        }
                    },
                    enabled = choice.enabled,
                    onClick = {
                        expanded = false
                        onSelect(choice.id)
                    },
                )
            }
        }
    }
}

/**
 * The Voice section: its words, and which of them stand in for the picker.
 *
 * Both come from one [ProfileRules.voiceCopy] call, so the branch and the
 * sentence explaining it cannot disagree. This exists as its own composable
 * because the defect it guards lives in the composition rather than in any
 * value a rule returns — the screen once drew a correct sentence in the wrong
 * slot with the whole suite green — and, like `DataTableCard`, the assertion
 * has to be over what is mounted. `VoiceSectionWiringTest` mounts exactly this.
 */
@Composable
internal fun VoiceSection(config: ConfigStatus?, canSpeak: @Composable () -> Unit) {
    val copy = ProfileRules.voiceCopy(config)
    FormSection(header = "Voice", footer = copy.footer) {
        if (copy.unconfiguredNotice != null) {
            IconNote(text = copy.unconfiguredNotice, painter = R.drawable.ic_volume_off)
        } else {
            canSpeak()
        }
    }
}

/**
 * A SwiftUI `Form` section, as Material draws one: a quiet heading, a rule, the
 * rows, and the explanatory line underneath.
 */
@Composable
internal fun FormSection(
    header: String?,
    footer: String? = null,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier.padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        header?.let {
            Text(
                text = it.uppercase(),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = secondaryTint,
            )
        }
        HorizontalDivider()
        content()
        footer?.let { Text(text = it, fontSize = 13.sp, color = secondaryTint) }
    }
}

/** A `Button` row of a Form: full width, left aligned, hit at 48 dp. */
@Composable
internal fun ActionRow(
    text: String,
    enabled: Boolean = true,
    destructive: Boolean = false,
    icon: ImageVector? = null,
    painter: Int? = null,
    onClick: () -> Unit,
) {
    val tint = when {
        !enabled -> secondaryTint.copy(alpha = 0.5f)
        destructive -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.primary
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            icon != null -> Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(20.dp),
            )
            painter != null -> Icon(
                painter = painterResource(painter),
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(20.dp),
            )
        }
        Text(text = text, fontSize = 15.sp, color = tint)
    }
}

/** A `Toggle` row: the whole line switches, and it is 48 dp tall. */
@Composable
internal fun SwitchRow(
    label: String,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontSize = 15.sp,
            color = if (enabled) Color.Unspecified else secondaryTint.copy(alpha = 0.5f),
            modifier = Modifier.weight(1f),
        )
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

/** SwiftUI's `Label(_, systemImage:)` in its quiet, informational form. */
@Composable
internal fun IconNote(
    text: String,
    icon: ImageVector? = null,
    painter: Int? = null,
    tint: Color = Color.Unspecified,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val resolved = if (tint == Color.Unspecified) secondaryTint else tint
        when {
            icon != null -> Icon(
                imageVector = icon,
                contentDescription = null,
                tint = resolved,
                modifier = Modifier.size(18.dp),
            )
            painter != null -> Icon(
                painter = painterResource(painter),
                contentDescription = null,
                tint = resolved,
                modifier = Modifier.size(18.dp),
            )
        }
        Text(text = text, fontSize = 13.sp, color = resolved)
    }
}

/** Rotation must not throw away a half-typed profile. */
private val ProfileFormSaver = listSaver<ProfileForm, Any>(
    save = {
        listOf(
            it.name,
            it.title,
            it.description,
            it.notifications,
            it.crop.name,
            it.voice,
            it.speakReplies,
        )
    },
    restore = {
        ProfileForm(
            name = it[0] as String,
            title = it[1] as String,
            description = it[2] as String,
            notifications = it[3] as Boolean,
            crop = AvatarCrop.valueOf(it[4] as String),
            voice = it[5] as String,
            speakReplies = it[6] as Boolean,
        )
    },
)
