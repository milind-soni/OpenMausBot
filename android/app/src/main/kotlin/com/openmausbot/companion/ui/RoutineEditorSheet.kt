package com.openmausbot.companion.ui

import androidx.compose.ui.res.stringResource

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TimePickerDialog
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Routine
import com.openmausbot.companion.core.RoutineRunAvailability
import com.openmausbot.companion.core.RoutineRunLocation
import com.openmausbot.companion.core.RoutineSchedule
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.launch

/**
 * Making or editing one routine — the port of `RoutineEditorView` in
 * `ios/App/TasksRoutinesView.swift`.
 *
 * Every field is `rememberSaveable`, so an orientation change neither closes the
 * sheet nor discards the draft — the same thing SwiftUI view state gives the
 * Swift for free. The caller composes this under `key(target.stateKey)`, which
 * is what scopes those saved fields to one routine: a different routine opened
 * later at the same call site gets its own slots rather than inheriting a draft.
 *
 * The work, the agent, how long it may take, where it runs, and when. Cloud VM
 * is offered only when the paired computer reports both a Box credential and an
 * available Box agent, and an existing cloud routine keeps that choice while its
 * VM is unavailable rather than being silently moved back to the computer.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun RoutineEditorSheet(
    target: RoutineEditorTarget,
    onSaved: () -> Unit,
    onDismiss: () -> Unit,
) {
    val session = LocalCompanion.current.session
    val state by session.state.collectAsState()
    val scope = rememberCoroutineScope()

    val opened = remember { target }
    val seed = opened.seed
    val zone = remember { ZoneId.systemDefault() }

    var name by rememberSaveable { mutableStateOf(seed?.name ?: "") }
    var prompt by rememberSaveable { mutableStateOf(seed?.prompt ?: "") }
    var agent by rememberSaveable(stateSaver = AgentChoiceSaver) {
        mutableStateOf(AgentChoice(seed?.botId ?: ""))
    }
    var runOn by rememberSaveable(stateSaver = RunLocationSaver) {
        mutableStateOf(seed?.runLocation ?: RoutineRunLocation.MAUS)
    }
    var kind by rememberSaveable(stateSaver = ScheduleKindSaver) {
        mutableStateOf(seed?.schedule?.type ?: RoutineSchedule.Kind.DAILY)
    }
    var once by rememberSaveable(stateSaver = OnceDraftSaver) {
        mutableStateOf(
            OnceDraft(
                seed?.schedule?.at?.toLong()
                    ?: (System.currentTimeMillis() + RoutineRules.ONCE_DEFAULT_OFFSET_MILLIS),
            ),
        )
    }
    var dailyMinuteOfDay by rememberSaveable {
        val start = RoutineRules.parseTime(seed?.schedule?.time, LocalTime.now(zone))
        mutableIntStateOf(start.hour * 60 + start.minute)
    }
    var weekdays by rememberSaveable(stateSaver = WeekdaysSaver) {
        mutableStateOf(seed?.schedule?.weekdays?.toSet() ?: RoutineRules.DEFAULT_WEEKDAYS)
    }
    var intervalMinutesText by rememberSaveable {
        mutableStateOf(
            (seed?.schedule?.everyMinutes ?: RoutineRules.DEFAULT_INTERVAL).toString(),
        )
    }
    var intervalUsesCustom by rememberSaveable {
        mutableStateOf(
            seed?.schedule?.everyMinutes?.let { it !in RoutineRules.INTERVAL_PRESETS } ?: false,
        )
    }
    var intervalMenuExpanded by remember { mutableStateOf(false) }
    var intervalAnchor by rememberSaveable(stateSaver = OnceDraftSaver) {
        mutableStateOf(
            OnceDraft(
                seed?.schedule?.anchorAt
                    ?: RoutineRules.defaultIntervalAnchor(
                        nowMillis = System.currentTimeMillis(),
                        everyMinutes = seed?.schedule?.everyMinutes ?: RoutineRules.DEFAULT_INTERVAL,
                    ),
            ),
        )
    }
    val legacyDurationMinutes = seed?.durationMinutes ?: RoutineRules.LEGACY_DURATION_MINUTES
    var timeoutMinutes by rememberSaveable { mutableStateOf(seed?.timeoutMinutes) }
    var newIntervalTimeoutApplied by rememberSaveable { mutableStateOf(seed != null) }
    var advancedExpanded by rememberSaveable {
        mutableStateOf(
            seed?.timeoutMinutes?.let { it != RoutineRules.DEFAULT_INTERVAL_TIMEOUT } ?: false,
        )
    }
    var saving by remember { mutableStateOf(false) }
    var availability by remember { mutableStateOf<RoutineRunAvailability?>(null) }
    var availabilityLoaded by remember { mutableStateOf(false) }
    var pickingDate by rememberSaveable { mutableStateOf(false) }
    var pickingTime by rememberSaveable { mutableStateOf(false) }

    val bots = remember(state) { state.bots.filter { it.hidden != true } }

    // `onAppear`, not a subscription: the first agent is a default applied once.
    // The effect itself re-runs after an Activity recreation, so what makes it a
    // once is [AgentChoice.applied], which is saved — a later fleet frame and a
    // restored form both leave a deliberate "Choose an agent" alone.
    LaunchedEffect(Unit) {
        agent = agent.withDefault(session.state.value.bots.firstOrNull { it.hidden != true }?.id)
    }
    LaunchedEffect(Unit) {
        availability = session.loadRoutineRunAvailability()
        availabilityLoaded = true
    }

    val cloudSelectable = RoutineRules.cloudSelectable(availability, runOn)
    val intervalMinutes = RoutineRules.intervalMinutes(intervalMinutesText)
    val canSave = RoutineRules.canSave(
        saving = saving,
        kind = kind,
        name = name,
        prompt = prompt,
        botId = agent.botId,
        weekdays = weekdays,
        everyMinutes = intervalMinutes,
    )

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.CenterStart)) {
                    Text(stringResource(R.string.mobile_cancel_77dfd213))
                }
                Text(
                    text = if (opened.routineId == null) stringResource(R.string.mobile_new_routine_32809dc6) else stringResource(R.string.mobile_edit_routine_6e36897b),
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.align(Alignment.Center),
                )
                TextButton(
                    onClick = {
                        scope.launch {
                            if (kind == RoutineSchedule.Kind.UNKNOWN) {
                                session.actionError = RoutineRules.UNSUPPORTED_SCHEDULE_ERROR
                                return@launch
                            }
                            saving = true
                            val schedule = RoutineRules.schedule(
                                kind = kind,
                                onceAtMillis = if (kind == RoutineSchedule.Kind.INTERVAL) {
                                    intervalAnchor.millis.toDouble()
                                } else {
                                    once.millis.toDouble()
                                },
                                hour = dailyMinuteOfDay / 60,
                                minute = dailyMinuteOfDay % 60,
                                weekdays = weekdays,
                                everyMinutes = intervalMinutes ?: RoutineRules.DEFAULT_INTERVAL,
                            )
                            val saved = session.saveRoutine(
                                RoutineRules.input(
                                    name = name,
                                    prompt = prompt,
                                    botId = agent.botId,
                                    runOn = runOn,
                                    enabled = opened.enabled,
                                    schedule = schedule,
                                    durationMinutes = legacyDurationMinutes,
                                    timeoutMinutes = timeoutMinutes,
                                ),
                                opened.routineId,
                            )
                            if (saved != null) {
                                onSaved()
                                onDismiss()
                            }
                            saving = false
                        }
                    },
                    enabled = canSave,
                    modifier = Modifier.align(Alignment.CenterEnd),
                ) {
                    Text(stringResource(R.string.mobile_save_efc007a3))
                }
            }

            FormSection(header = "Work") {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.mobile_routine_name_9a8a0dda)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                AgentPicker(
                    bots = bots,
                    selected = agent.botId,
                    onSelect = { agent = agent.choose(it) },
                )

                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = { Text(stringResource(R.string.mobile_what_should_the_agent_do_b9526063)) },
                    minLines = 4,
                    maxLines = 10,
                    modifier = Modifier.fillMaxWidth(),
                )

            }

            FormSection(
                header = "Where does it run?",
                footer = RoutineRules.locationFooter(runOn, availability),
            ) {
                RadioRow(
                    label = RoutineRules.locationLabel(RoutineRunLocation.MAUS),
                    painter = R.drawable.ic_display,
                    selected = runOn == RoutineRunLocation.MAUS,
                    enabled = true,
                    onSelect = { runOn = RoutineRunLocation.MAUS },
                )
                RadioRow(
                    label = RoutineRules.locationLabel(RoutineRunLocation.CLOUD),
                    painter = R.drawable.ic_cloud,
                    selected = runOn == RoutineRunLocation.CLOUD,
                    enabled = cloudSelectable,
                    onSelect = { runOn = RoutineRunLocation.CLOUD },
                )
                if (!availabilityLoaded) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                        )
                        Text(localizedMobileCopy(RoutineRules.CHECKING_CLOUD), fontSize = 13.sp, color = secondaryTint)
                    }
                } else if (availability == null) {
                    IconNote(
                        text = RoutineRules.CLOUD_STATUS_UNAVAILABLE,
                        icon = Icons.Filled.Warning,
                    )
                }
            }

            FormSection(
                header = "Schedule",
                footer = if (kind == RoutineSchedule.Kind.INTERVAL) {
                    RoutineRules.INTERVAL_SCHEDULE_FOOTER
                } else {
                    RoutineRules.SCHEDULE_FOOTER
                },
            ) {
                if (kind == RoutineSchedule.Kind.UNKNOWN) {
                    RadioRow(
                        label = stringResource(R.string.mobile_newer_schedule_c56a41aa),
                        selected = true,
                        enabled = false,
                        onSelect = {},
                    )
                }
                RadioRow(
                    label = stringResource(R.string.mobile_one_time_6fea9e4d),
                    selected = kind == RoutineSchedule.Kind.ONCE,
                    onSelect = { kind = RoutineSchedule.Kind.ONCE },
                )
                RadioRow(
                    label = stringResource(R.string.mobile_selected_days_7890ff6e),
                    selected = kind == RoutineSchedule.Kind.DAILY,
                    onSelect = { kind = RoutineSchedule.Kind.DAILY },
                )
                RadioRow(
                    label = stringResource(R.string.mobile_every_x_minutes_000b5c3a),
                    selected = kind == RoutineSchedule.Kind.INTERVAL,
                    onSelect = {
                        kind = RoutineSchedule.Kind.INTERVAL
                        timeoutMinutes = RoutineRules.intervalTimeoutOnFirstSelection(
                            current = timeoutMinutes,
                            defaultAlreadyApplied = newIntervalTimeoutApplied,
                        )
                        newIntervalTimeoutApplied = true
                    },
                )

                when (kind) {
                    RoutineSchedule.Kind.ONCE -> {
                        ValueRow(
                            label = stringResource(R.string.mobile_run_b1b39260),
                            value = RelativeStamp.dateAndTime(once.millis.toDouble(), zone),
                            onClick = { pickingDate = true },
                        )
                    }
                    RoutineSchedule.Kind.DAILY -> {
                        ValueRow(
                            label = stringResource(R.string.mobile_time_6c82e6dd),
                            value = RoutineRules.timeText(
                                dailyMinuteOfDay / 60,
                                dailyMinuteOfDay % 60,
                            ),
                            onClick = { pickingTime = true },
                        )
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            RoutineRules.DAY_LETTERS.forEachIndexed { day, letter ->
                                DayToggle(
                                    letter = letter,
                                    name = localizedMobileCopy(RoutineRules.DAY_NAMES[day]),
                                    on = day in weekdays,
                                    onToggle = { on ->
                                        weekdays = if (on) weekdays + day else weekdays - day
                                    },
                                )
                            }
                        }
                    }
                    RoutineSchedule.Kind.INTERVAL -> {
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(2.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(
                                stringResource(R.string.mobile_runs_every_dd679464),
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(vertical = 12.dp),
                            )
                            Box {
                                TextButton(
                                    onClick = { intervalMenuExpanded = true },
                                    modifier = Modifier.localizedSemantics(contentDescription = {
                                        if (intervalUsesCustom) {
                                            stringResource(R.string.mobile_a11y_choose_custom_repeat_interval)
                                        } else {
                                            stringResource(R.string.mobile_a11y_repeat_interval, intervalMinutesText)
                                        }
                                    }),
                                ) {
                                    Text(
                                        if (intervalUsesCustom) stringResource(R.string.mobile_custom_081ae3fd) else intervalMinutesText,
                                        style = MaterialTheme.typography.bodyLarge,
                                    )
                                    ExposedDropdownMenuDefaults.TrailingIcon(
                                        expanded = intervalMenuExpanded,
                                    )
                                }
                                DropdownMenu(
                                    expanded = intervalMenuExpanded,
                                    onDismissRequest = { intervalMenuExpanded = false },
                                ) {
                                    RoutineRules.INTERVAL_PRESETS.forEach { minutes ->
                                        DropdownMenuItem(
                                            text = { Text(minutes.toString()) },
                                            onClick = {
                                                intervalMenuExpanded = false
                                                intervalUsesCustom = false
                                                intervalMinutesText = minutes.toString()
                                            },
                                        )
                                    }
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.mobile_custom_081ae3fd)) },
                                        onClick = {
                                            intervalMenuExpanded = false
                                            if (!intervalUsesCustom) intervalMinutesText = ""
                                            intervalUsesCustom = true
                                        },
                                    )
                                }
                            }
                            Text(
                                stringResource(R.string.mobile_minutes_starting_288a3d24),
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(vertical = 12.dp),
                            )
                            TextButton(
                                onClick = { pickingDate = true },
                                modifier = Modifier.localizedSemantics(contentDescription = {
                                    stringResource(R.string.mobile_a11y_change_interval_start)
                                }),
                            ) {
                                Text(
                                    RelativeStamp.dateAndTime(
                                        intervalAnchor.millis.toDouble(),
                                        zone,
                                    ),
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                            }
                            Text(
                                ".",
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(vertical = 12.dp),
                            )
                        }
                        if (intervalUsesCustom) {
                            OutlinedTextField(
                                value = intervalMinutesText,
                                onValueChange = { value ->
                                    if (value.length <= 4 && value.all(Char::isDigit)) {
                                        intervalMinutesText = value
                                    }
                                },
                                label = { Text(stringResource(R.string.mobile_custom_interval_1eea7679)) },
                                suffix = { Text(stringResource(R.string.mobile_minutes_be2e2bb6)) },
                                supportingText = { Text(stringResource(R.string.mobile_from_5_minutes_to_24_hours_a6bafa40)) },
                                isError = intervalMinutes == null,
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                    RoutineSchedule.Kind.UNKNOWN -> IconNote(
                        text = RoutineRules.UNKNOWN_SCHEDULE_NOTE,
                        icon = Icons.Filled.Warning,
                    )
                }
            }

            FormSection(
                header = null,
                footer = if (advancedExpanded) {
                    "Optional. This only stops a stuck run; it does not control how often the routine starts."
                } else {
                    null
                },
            ) {
                ValueRow(
                    label = stringResource(R.string.mobile_advanced_4d064726),
                    value = if (advancedExpanded) {
                        "Hide"
                    } else {
                        timeoutMinutes?.let {
                            stringResource(R.string.mobile_timeout_minutes_limit, it)
                        } ?: stringResource(R.string.mobile_no_limit_10850b93)
                    },
                    onClick = { advancedExpanded = !advancedExpanded },
                )
                if (advancedExpanded) {
                    TimeoutPicker(value = timeoutMinutes, onSelect = { timeoutMinutes = it })
                }
            }
        }
    }

    if (pickingDate) {
        val editingIntervalAnchor = kind == RoutineSchedule.Kind.INTERVAL
        val draft = if (editingIntervalAnchor) intervalAnchor else once
        val today = remember { LocalDate.now(zone) }
        val opensOn = remember(draft) { draft.date(zone) }
        val datePickerState = rememberDatePickerState(
            initialSelectedDateMillis = opensOn
                .atStartOfDay(ZoneOffset.UTC)
                .toInstant()
                .toEpochMilli(),
            selectableDates = remember(today, editingIntervalAnchor) {
                object : SelectableDates {
                    override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                        editingIntervalAnchor || !Instant.ofEpochMilli(utcTimeMillis)
                            .atZone(ZoneOffset.UTC)
                            .toLocalDate()
                            .isBefore(today)

                    override fun isSelectableYear(year: Int): Boolean =
                        editingIntervalAnchor || year >= today.year
                }
            },
        )
        DatePickerDialog(
            // Dismissing by scrim or back is a cancel: the staged half goes,
            // the committed instant does not.
            onDismissRequest = {
                pickingDate = false
                if (editingIntervalAnchor) {
                    intervalAnchor = intervalAnchor.discard()
                } else {
                    once = once.discard()
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val picked = datePickerState.selectedDateMillis
                        // Staged, not written. `Date()...` bounds the instant the
                        // user confirms, and they have not confirmed one yet.
                        if (picked != null) {
                            val date = Instant.ofEpochMilli(picked)
                                .atZone(ZoneOffset.UTC)
                                .toLocalDate()
                            if (editingIntervalAnchor) {
                                intervalAnchor = intervalAnchor.stage(date)
                            } else {
                                once = once.stage(date)
                            }
                        }
                        pickingDate = false
                        // The instant is a day and a time; Material picks them in
                        // two dialogs, so the time follows the day.
                        pickingTime = true
                    },
                ) { Text(stringResource(R.string.mobile_next_bc981983)) }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        pickingDate = false
                        if (editingIntervalAnchor) {
                            intervalAnchor = intervalAnchor.discard()
                        } else {
                            once = once.discard()
                        }
                    },
                ) { Text(stringResource(R.string.mobile_cancel_77dfd213)) }
            },
        ) {
            DatePicker(state = datePickerState)
        }
    }

    if (pickingTime) {
        val editingIntervalAnchor = kind == RoutineSchedule.Kind.INTERVAL
        val draft = if (editingIntervalAnchor) intervalAnchor else once
        val bounded = kind == RoutineSchedule.Kind.ONCE
        val day = remember(draft) { draft.date(zone) }
        val start = remember(bounded, draft, dailyMinuteOfDay) {
            if (bounded) {
                RoutineRules.onceTimeStart(
                    date = day,
                    time = draft.time(zone),
                    now = Instant.now(),
                    zone = zone,
                )
            } else if (editingIntervalAnchor) {
                draft.time(zone)
            } else {
                LocalTime.of(dailyMinuteOfDay / 60, dailyMinuteOfDay % 60)
            }
        }
        val timeState = rememberTimePickerState(
            initialHour = start.hour,
            initialMinute = start.minute,
            is24Hour = DateFormat.is24HourFormat(LocalContext.current),
        )
        val cancel = {
            pickingTime = false
            if (editingIntervalAnchor) {
                intervalAnchor = intervalAnchor.discard()
            } else {
                once = once.discard()
            }
        }
        // The Material dialog rather than an AlertDialog with a TimePicker in
        // its text slot: the clock face is wider than a platform-default alert,
        // which would clip it on a narrow phone.
        TimePickerDialog(
            onDismissRequest = cancel,
            confirmButton = {
                // The rest of `in: Date()...`. The candidate instant is compared
                // against a clock read on each move of the hands, so a minute
                // that passes while the dialog is open stops being selectable —
                // as it would on a bounded picker. Nothing gates Save.
                val selectable = !bounded || RoutineRules.onceInstantSelectable(
                    date = day,
                    hour = timeState.hour,
                    minute = timeState.minute,
                    now = Instant.now(),
                    zone = zone,
                )
                TextButton(
                    enabled = selectable,
                    onClick = {
                        pickingTime = false
                        if (editingIntervalAnchor) {
                            intervalAnchor = intervalAnchor.confirm(
                                timeState.hour,
                                timeState.minute,
                                zone,
                            )
                        } else if (bounded) {
                            once = once.confirm(timeState.hour, timeState.minute, zone)
                        } else {
                            // "Selected days" never opens the date dialog, so
                            // there is no staged day; dropping one is only
                            // insurance against leaving a half-choice behind.
                            once = once.discard()
                            dailyMinuteOfDay = timeState.hour * 60 + timeState.minute
                        }
                    },
                ) { Text(stringResource(R.string.mobile_ok_9ce3bd42)) }
            },
            dismissButton = {
                TextButton(onClick = cancel) { Text(stringResource(R.string.mobile_cancel_77dfd213)) }
            },
            title = {
                Text(
                    when (kind) {
                        RoutineSchedule.Kind.INTERVAL -> stringResource(R.string.mobile_alignment_time_ca919bd7)
                        RoutineSchedule.Kind.ONCE -> stringResource(R.string.mobile_run_b1b39260)
                        else -> stringResource(R.string.mobile_time_6c82e6dd)
                    },
                )
            },
        ) {
            TimePicker(state = timeState)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeoutPicker(value: Int?, onSelect: (Int?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = value?.let {
                stringResource(R.string.mobile_minutes_minutes_29dd88a9, it)
            } ?: stringResource(R.string.mobile_no_limit_10850b93),
            onValueChange = {},
            readOnly = true,
            label = { Text(stringResource(R.string.mobile_stop_if_still_running_after_45efb175)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth()
                .localizedSemantics(contentDescription = {
                    stringResource(R.string.mobile_a11y_routine_timeout)
                }),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.mobile_no_limit_10850b93)) },
                onClick = {
                    expanded = false
                    onSelect(null)
                },
            )
            RoutineRules.TIMEOUT_OPTIONS.forEach { minutes ->
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.mobile_minutes_minutes_29dd88a9, minutes)) },
                    onClick = {
                        expanded = false
                        onSelect(minutes)
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentPicker(
    bots: List<com.openmausbot.companion.core.Bot>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val label = bots.firstOrNull { it.id == selected }?.name
        ?: stringResource(R.string.mobile_choose_an_agent_faaaf2b4)
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = label,
            onValueChange = {},
            readOnly = true,
            label = { Text(stringResource(R.string.mobile_agent_5ce2e6f4)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.mobile_choose_an_agent_faaaf2b4)) },
                onClick = {
                    expanded = false
                    onSelect("")
                },
            )
            bots.forEach { bot ->
                DropdownMenuItem(
                    text = { Text(bot.name) },
                    onClick = {
                        expanded = false
                        onSelect(bot.id)
                    },
                )
            }
        }
    }
}

/** A `Picker(.inline)` row: one choice of several, hit at 48 dp. */
@Composable
private fun RadioRow(
    label: String,
    selected: Boolean,
    enabled: Boolean = true,
    painter: Int? = null,
    onSelect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = onSelect,
            ),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        painter?.let {
            Icon(
                painter = painterResource(it),
                contentDescription = null,
                tint = if (enabled) secondaryTint else secondaryTint.copy(alpha = 0.5f),
                modifier = Modifier.size(20.dp),
            )
        }
        Text(
            text = label,
            fontSize = 15.sp,
            color = if (enabled) {
                MaterialTheme.colorScheme.onSurface
            } else {
                secondaryTint.copy(alpha = 0.5f)
            },
        )
    }
}

/** A labelled value that opens a picker — SwiftUI's `DatePicker` row. */
@Composable
private fun ValueRow(label: String, value: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 15.sp, color = secondaryTint, modifier = Modifier.weight(1f))
        Text(value, fontSize = 15.sp, color = MaterialTheme.colorScheme.primary)
    }
}

/**
 * One day of the week. A 48 dp circle rather than a Material chip: seven chips
 * do not fit a narrow phone at a hittable size, and the letter alone is what the
 * Swift shows. The day's full name is what a screen reader gets.
 */
@Composable
private fun DayToggle(letter: String, name: String, on: Boolean, onToggle: (Boolean) -> Unit) {
    Box(
        modifier = Modifier
            .size(MIN_TOUCH_TARGET)
            .clip(CircleShape)
            .background(
                if (on) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.surfaceContainerHighest
                },
            )
            .toggleable(value = on, role = Role.Checkbox, onValueChange = onToggle)
            .semantics { contentDescription = name },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = letter,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (on) {
                MaterialTheme.colorScheme.onPrimary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}

/**
 * The staged half travels too: rotating with the time dialog open must not
 * forget which day it is bounding.
 */
private val OnceDraftSaver = listSaver<OnceDraft, String>(
    save = { listOf(it.millis.toString(), it.stagedDate?.toEpochDay()?.toString() ?: "") },
    restore = {
        OnceDraft(
            millis = it[0].toLong(),
            stagedDate = it[1].toLongOrNull()?.let(LocalDate::ofEpochDay),
        )
    },
)

/**
 * Internal rather than private so the test can round-trip the very saver the
 * sheet uses: "survives a recreation" is a claim about this representation.
 */
internal val AgentChoiceSaver = listSaver<AgentChoice, String>(
    save = { listOf(it.botId, it.applied.toString()) },
    restore = { AgentChoice(botId = it[0], applied = it[1].toBooleanStrict()) },
)

private val WeekdaysSaver = listSaver<Set<Int>, Int>(
    save = { it.sorted() },
    restore = { it.toSet() },
)

private val RunLocationSaver = listSaver<RoutineRunLocation, String>(
    save = { listOf(it.wireValue) },
    restore = {
        RoutineRunLocation.entries.firstOrNull { entry -> entry.wireValue == it.first() }
            ?: RoutineRunLocation.MAUS
    },
)

private val ScheduleKindSaver = listSaver<RoutineSchedule.Kind, String>(
    save = { listOf(it.name) },
    restore = { RoutineSchedule.Kind.valueOf(it.first()) },
)