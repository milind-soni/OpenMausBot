package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.SharedAttachmentKind
import com.openmausbot.companion.core.SharedAttachmentReference
import com.openmausbot.companion.core.SharedMessageComposer
import com.openmausbot.companion.sharing.LocalShareAttachment
import com.openmausbot.companion.sharing.ShareInbox
import com.openmausbot.companion.sharing.ShareItemLoader
import com.openmausbot.companion.sharing.SharePayload
import com.openmausbot.companion.sharing.SharePreparedDelivery
import com.openmausbot.companion.sharing.ShareSheetPhase
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/**
 * The Android surface of `ios/ShareExtension/ShareRootView.swift`.
 *
 * The trampoline has already copied shared bytes into app-private storage.
 * This screen chooses the computer and conversation, uploads those copies
 * with stable ids, and sends one composed message.
 */
@Composable
fun ShareSheet(
    pending: ShareInbox.PendingShare,
    onDismiss: () -> Unit,
) {
    // One composition tree per generation: a send from A cannot clean B's files,
    // and preview/instruction reset when a newer share arrives.
    key(pending.generation) {
        ShareSheetContent(pending = pending, onDismiss = onDismiss)
    }
}

@Composable
private fun ShareSheetContent(
    pending: ShareInbox.PendingShare,
    onDismiss: () -> Unit,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connections by session.connections.collectAsState()
    val active by session.connection.collectAsState()
    val scope = rememberCoroutineScope()
    val sheet = remember(pending.generation) { environment.shareInbox.sessionFor(pending.generation) }

    var phase by remember { mutableStateOf(sheet.phase) }
    var computers by remember { mutableStateOf(sheet.computers) }
    var destinations by remember { mutableStateOf(sheet.destinations) }
    var selectedComputerId by remember { mutableStateOf(sheet.selectedComputerId) }
    var selectedDestinationId by remember { mutableStateOf(sheet.selectedDestinationId) }
    var rememberedDestinationId by remember { mutableStateOf(sheet.rememberedDestinationId) }
    var instruction by remember { mutableStateOf(sheet.instruction) }
    var errorMessage by remember { mutableStateOf(sheet.errorMessage) }
    var preview by remember { mutableStateOf(sheet.preview) }
    var items by remember { mutableStateOf(sheet.items) }
    var pendingDelivery by remember { mutableStateOf(sheet.pendingDelivery) }
    var sendJob by remember { mutableStateOf<Job?>(null) }
    var choosingComputer by remember { mutableStateOf(false) }
    var choosingDestination by remember { mutableStateOf(false) }

    SideEffect {
        sheet.phase = phase
        sheet.computers = computers
        sheet.destinations = destinations
        sheet.selectedComputerId = selectedComputerId
        sheet.selectedDestinationId = selectedDestinationId
        sheet.rememberedDestinationId = rememberedDestinationId
        sheet.instruction = instruction
        sheet.errorMessage = errorMessage
        sheet.preview = preview
        sheet.items = items
        sheet.pendingDelivery = pendingDelivery
    }

    val selectedComputer = computers.firstOrNull { it.id == selectedComputerId }
    val selectedDestination = destinations.firstOrNull { it.id == selectedDestinationId }
    val ready = phase == ShareSheetPhase.READY
    val canEdit = ready && pendingDelivery == null
    val canSend = SharePolicy.canSend(ready, preview, selectedDestination, instruction)
    val canCancel = phase != ShareSheetPhase.SENT
    val imageWarning = SharePolicy.imageCompatibilityMessage(preview, selectedDestination)
    val instructionWarning = SharePolicy.instructionValidationMessage(instruction)

    fun fail(error: Throwable, preservePrepared: Boolean) {
        if (!preservePrepared) pendingDelivery = null
        errorMessage = SharePolicy.friendlyMessage(error, selectedComputer?.name)
        phase = ShareSheetPhase.FAILED
    }

    suspend fun connect(connectionId: String) {
        val connection = connections.firstOrNull { it.id == connectionId }
            ?: session.connection.value
            ?: throw ShareLoadException(SharePolicy.notPaired())
        computers = SharePolicy.computers(
            connections.ifEmpty { listOf(connection) },
            connection,
        )
        selectedComputerId = connection.id
        destinations = emptyList()
        selectedDestinationId = null
        val fleet = session.withPairedShareClient(connection.id) { client -> client.fleet(1) }
        val imageIds = if (preview.imageCount > 0) {
            try {
                session.withPairedShareClient(connection.id) { it.imageCapableInstanceIds() }
            } catch (error: Throwable) {
                if (SharePolicy.isImageSupportUnavailable(error)) {
                    throw ShareLoadException(SharePolicy.imageSupportUnavailable())
                }
                throw error
            }
        } else {
            emptySet()
        }
        val next = SharePolicy.destinations(fleet, imageIds)
        if (next.isEmpty()) throw ShareLoadException(SharePolicy.noDestinations())
        destinations = next
        val remembered = environment.chatPreferences.lastShareDestination(connection.id)
        rememberedDestinationId = remembered
        selectedDestinationId = SharePolicy.rememberedSelection(next, remembered)
        computers = SharePolicy.computers(
            connections.ifEmpty { listOf(connection) },
            session.connection.value?.takeIf { it.id == connection.id } ?: connection,
        )
    }

    suspend fun load() {
        phase = ShareSheetPhase.LOADING
        errorMessage = null
        destinations = emptyList()
        selectedDestinationId = null
        pendingDelivery = null
        instruction = ""
        preview = SharePolicy.SharePreview()
        items = null
        when (val payload = pending.payload) {
            is SharePayload.Failed -> throw ShareLoadException(payload.message)
            is SharePayload.Ready -> {
                items = payload.items
                preview = ShareItemLoader.preview(payload.items)
                val selected = active ?: throw ShareLoadException(SharePolicy.notPaired())
                connect(selected.id)
            }
        }
        phase = ShareSheetPhase.READY
    }

    LaunchedEffect(pending.generation) {
        if (sheet.bootstrapped) {
            // Recreation mid-send lost the Job; keep the prepared delivery for Retry.
            if (phase == ShareSheetPhase.SENDING) {
                phase = ShareSheetPhase.FAILED
                if (errorMessage == null) errorMessage = SharePolicy.generic()
            }
            return@LaunchedEffect
        }
        try {
            load()
            sheet.bootstrapped = true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            sheet.bootstrapped = true
            fail(error, preservePrepared = false)
        }
    }

    fun cancel() {
        if (!canCancel) return
        sendJob?.cancel()
        sendJob = null
        pendingDelivery = null
        val owned = items
        items = null
        ShareItemLoader.cleanUp(owned)
        onDismiss()
    }

    fun send() {
        if (sendJob != null || !canSend) return
        val ownedItems = items
        sendJob = scope.launch {
            val destination = selectedDestination ?: return@launch
            val computerId = selectedComputerId ?: return@launch
            if (imageWarning != null) {
                errorMessage = imageWarning
                sendJob = null
                return@launch
            }
            if (instructionWarning != null) {
                errorMessage = instructionWarning
                sendJob = null
                return@launch
            }
            phase = ShareSheetPhase.SENDING
            errorMessage = null
            try {
                withTimeout(90_000) {
                    val uploaded = mutableListOf<SharedAttachmentReference>()
                    if (ownedItems != null) {
                        for (attachment in ownedItems.attachments) {
                            val data = withContext(Dispatchers.IO) { attachment.file.readBytes() }
                            when (attachment.kind) {
                                LocalShareAttachment.Kind.IMAGE -> {
                                    val path = session.withPairedShareClient(computerId) { client ->
                                        client.uploadImage(data, attachment.mime, attachment.id)
                                    }
                                    uploaded += SharedAttachmentReference(
                                        path,
                                        SharedAttachmentKind.IMAGE,
                                        attachment.name,
                                    )
                                }
                                LocalShareAttachment.Kind.FILE -> {
                                    val uploadedFile = session.withPairedShareClient(computerId) { client ->
                                        client.uploadFile(data, attachment.name, attachment.mime, attachment.id)
                                    }
                                    uploaded += SharedAttachmentReference(
                                        uploadedFile.path,
                                        SharedAttachmentKind.FILE,
                                        uploadedFile.name,
                                    )
                                }
                            }
                        }
                    }
                    val message = SharedMessageComposer.compose(
                        instruction = instruction,
                        text = ownedItems?.text.orEmpty(),
                        urls = ownedItems?.urls.orEmpty(),
                        attachments = uploaded,
                    )
                    if (message.isEmpty()) throw ShareLoadException(SharePolicy.nothingSupported())
                    val delivery = SharePreparedDelivery(
                        text = message,
                        destination = destination,
                        sendId = pendingDelivery?.sendId ?: UUID.randomUUID().toString(),
                    )
                    pendingDelivery = delivery
                    session.withPairedShareClient(computerId) { client ->
                        client.send(delivery.text, delivery.destination.destination, delivery.sendId)
                    }
                }
                selectedComputerId?.let { id ->
                    selectedDestinationId?.let { environment.chatPreferences.setLastShareDestination(id, it) }
                }
                ShareItemLoader.cleanUp(ownedItems)
                if (items === ownedItems) items = null
                pendingDelivery = null
                phase = ShareSheetPhase.SENT
                delay(450)
                onDismiss()
            } catch (error: TimeoutCancellationException) {
                val preserve = pendingDelivery != null
                if (preserve) {
                    ShareItemLoader.cleanUp(ownedItems)
                    if (items === ownedItems) items = null
                }
                fail(ShareLoadException(SharePolicy.sendTimedOut()), preservePrepared = preserve)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                val preserve = pendingDelivery != null && SharePolicy.shouldPreservePreparedDelivery(error)
                if (preserve) {
                    ShareItemLoader.cleanUp(ownedItems)
                    if (items === ownedItems) items = null
                }
                fail(error, preservePrepared = preserve)
            } finally {
                sendJob = null
            }
        }
    }

    fun retry() {
        if (sendJob != null) return
        sendJob = scope.launch {
            errorMessage = null
            val delivery = pendingDelivery
            val computerId = selectedComputerId
            try {
                if (delivery != null && computerId != null) {
                    phase = ShareSheetPhase.SENDING
                    session.withPairedShareClient(computerId) { client ->
                        client.send(delivery.text, delivery.destination.destination, delivery.sendId)
                    }
                    computerId.let { id ->
                        selectedDestinationId?.let { environment.chatPreferences.setLastShareDestination(id, it) }
                    }
                    pendingDelivery = null
                    phase = ShareSheetPhase.SENT
                    delay(450)
                    onDismiss()
                } else if (items != null && computerId != null) {
                    phase = ShareSheetPhase.LOADING
                    connect(computerId)
                    phase = ShareSheetPhase.READY
                } else {
                    load()
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                fail(error, preservePrepared = pendingDelivery != null && SharePolicy.shouldPreservePreparedDelivery(error))
            } finally {
                sendJob = null
            }
        }
    }

    BackHandler(enabled = canCancel) { cancel() }

    Surface(modifier = Modifier.fillMaxSize().imePadding()) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                HeaderBackButton(onBack = { if (canCancel) cancel() })
                Column(modifier = Modifier.weight(1f)) {
                    Text("Send to OpenMausBot", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Text(headerSubtitle(phase), color = secondaryTint, fontSize = 13.sp)
                }
                if (phase == ShareSheetPhase.SENDING) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                }
            }
            HorizontalDivider()
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (!preview.isEmpty) {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text("SHARING", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = secondaryTint)
                            SharePolicy.previewChip(preview).forEach { label ->
                                Text(label, fontSize = 15.sp)
                            }
                            if (preview.ignoredCount > 0) {
                                Text(
                                    SharePolicy.ignoredCaption(preview.ignoredCount),
                                    color = MaterialTheme.colorScheme.tertiary,
                                    fontSize = 13.sp,
                                )
                            }
                        }
                    }
                }

                if (computers.isNotEmpty()) {
                    Text("COMPUTER", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = secondaryTint)
                    TextButton(
                        onClick = { choosingComputer = true },
                        enabled = (phase == ShareSheetPhase.READY || phase == ShareSheetPhase.FAILED) && computers.size > 1,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text(selectedComputer?.name ?: "Choose a computer", fontWeight = FontWeight.SemiBold)
                            selectedComputer?.routeLabel?.let { Text(it, color = secondaryTint, fontSize = 13.sp) }
                        }
                    }
                }

                if (destinations.isNotEmpty()) {
                    Text("SEND TO", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = secondaryTint)
                    TextButton(
                        onClick = { choosingDestination = true },
                        enabled = canEdit,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(
                                    selectedDestination?.name ?: "Choose a bot or channel",
                                    fontWeight = FontWeight.SemiBold,
                                )
                                if (selectedDestinationId != null && selectedDestinationId == rememberedDestinationId) {
                                    Text("LAST USED", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
                                }
                            }
                            selectedDestination?.subtitle?.let {
                                Text(it, color = secondaryTint, fontSize = 13.sp)
                            }
                        }
                    }
                }

                if (phase == ShareSheetPhase.READY || phase == ShareSheetPhase.SENDING) {
                    OutlinedTextField(
                        value = instruction,
                        onValueChange = {
                            instruction = it
                            pendingDelivery = null
                        },
                        label = { Text("Instruction (optional)") },
                        placeholder = { Text("For example: summarize this and list the next steps") },
                        enabled = canEdit,
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp) }
                if (imageWarning != null && imageWarning != errorMessage) {
                    Text(imageWarning, color = MaterialTheme.colorScheme.tertiary, fontSize = 14.sp)
                }
                if (instructionWarning != null && instructionWarning != errorMessage) {
                    Text(instructionWarning, color = MaterialTheme.colorScheme.tertiary, fontSize = 14.sp)
                }

                if (phase == ShareSheetPhase.LOADING && preview.isEmpty) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                        Text("Reading shared content", color = secondaryTint)
                    }
                }
            }
            HorizontalDivider()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                if (phase == ShareSheetPhase.FAILED) {
                    TextButton(onClick = ::retry) { Text(if (pendingDelivery != null) "Retry send" else "Try again") }
                }
                Button(
                    onClick = ::send,
                    enabled = canSend,
                ) { Text("Send") }
            }
        }
    }

    if (choosingComputer) {
        AlertDialog(
            onDismissRequest = { choosingComputer = false },
            title = { Text("Computer") },
            text = {
                Column {
                    computers.forEach { computer ->
                        TextButton(
                            onClick = {
                                choosingComputer = false
                                if (computer.id == selectedComputerId) return@TextButton
                                scope.launch {
                                    phase = ShareSheetPhase.LOADING
                                    pendingDelivery = null
                                    try {
                                        connect(computer.id)
                                        phase = ShareSheetPhase.READY
                                    } catch (error: CancellationException) {
                                        throw error
                                    } catch (error: Throwable) {
                                        fail(error, preservePrepared = false)
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(computer.name)
                                Text(computer.routeLabel, fontSize = 12.sp, color = secondaryTint)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingComputer = false }) { Text("Cancel") } },
        )
    }

    if (choosingDestination) {
        AlertDialog(
            onDismissRequest = { choosingDestination = false },
            title = { Text("Send to") },
            text = {
                Column {
                    destinations.forEach { destination ->
                        TextButton(
                            onClick = {
                                selectedDestinationId = destination.id
                                pendingDelivery = null
                                choosingDestination = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(destination.name)
                                Text(destination.subtitle, fontSize = 12.sp, color = secondaryTint)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingDestination = false }) { Text("Cancel") } },
        )
    }
}

private fun headerSubtitle(phase: ShareSheetPhase): String = when (phase) {
    ShareSheetPhase.LOADING -> "Preparing your share…"
    ShareSheetPhase.READY -> "Choose where this should go"
    ShareSheetPhase.SENDING -> "Sending securely…"
    ShareSheetPhase.SENT -> "Sent"
    ShareSheetPhase.FAILED -> "Needs your attention"
}
