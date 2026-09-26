package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.PairingInvite
import com.openmausbot.companion.core.PairingRouteError
import com.openmausbot.companion.core.ServerPairingRetryError
import com.openmausbot.companion.discovery.DiscoveredService
import com.openmausbot.companion.discovery.DiscoveryState
import com.openmausbot.companion.discovery.toConnection
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Pairing: scan the computer's QR, confirm its identity, and connect — the port
 * of `ios/App/PairingView.swift`.
 *
 * Three ways in, because discovery is allowed to fail. NSD finds the computer by
 * name when the network cooperates; when it does not — a guest network with
 * multicast off, a responder that could not take port 5353 — the address the
 * desktop panel prints is typed instead.
 *
 * Only the first of the three is on screen to begin with. The other two live
 * behind **Other ways to connect**, and opening that is what starts a browse and
 * what asks for the nearby-devices permission a browse needs — the port of
 * `.onChange(of: showingOtherWays)` in `ios/App/PairingView.swift`. This screen
 * used to browse from the moment it existed, so someone who only ever meant to
 * scan the QR code printed on their own computer paid for a local search they
 * never looked at, and met a permission dialog to make it work.
 *
 * A scan never pairs by itself. A scanned or deep-linked invite fills the form
 * and the user confirms the computer's name and address before anything is
 * redeemed (§6).
 */
@Composable
fun PairingScreen(onCancel: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val scope = rememberCoroutineScope()
    val pairingFailedMessage = stringResource(R.string.mobile_pairing_failed)
    val noAddressMessage = stringResource(R.string.mobile_pairing_no_address)
    val invalidAddressMessage = stringResource(R.string.mobile_pairing_invalid_address)
    val invalidQrMessage = stringResource(R.string.mobile_pairing_invalid_qr)
    // `PairingView.swift` fires `Haptics.selection()` on every one of these:
    // scanning, picking a discovered computer, taking a typed address, both
    // submits, and going back to the list.
    val haptics = rememberHaptics()

    val secrets = PairingSecrets

    var manualAddress by rememberSaveable { mutableStateOf("") }
    // Saved instance state holds the computer and a handle, never a secret. A
    // rotation keeps the same process, so PairingSecrets still has the scanned
    // credential and the typed digits; a restore after the system killed the app
    // gets an empty store, and the confirm step asks for a rescan rather than
    // replaying a token that may already have been redeemed (§6).
    var pending by rememberSaveable(stateSaver = PendingPairingSaver) {
        mutableStateOf<PendingPairing?>(null)
    }
    // A pending pairing restored after a process restart carries a handle this
    // store never minted, so writes to it would go nowhere and the next rotation
    // would find the code field empty again. Give a typed pairing a fresh slot
    // before it accepts input; a scanned one stays orphaned, which is the rescan
    // case.
    LaunchedEffect(pending?.handle) {
        val current = pending ?: return@LaunchedEffect
        val rebound = current.rebindingIfOrphaned(secrets)
        if (rebound !== current) pending = rebound
    }
    // Read back out of the process-scoped store, so a rotation does not lose the
    // digits and a process restart does.
    var code by remember(pending?.handle) { mutableStateOf(secrets.code(pending?.handle)) }
    // Presentational only: the spinner and the disabled buttons. Whether an
    // attempt is in flight is the secret store's answer, not this flag's —
    // `PairingSecrets` is the one object that can refuse to replace the slot.
    var pairing by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var showingScanner by remember { mutableStateOf(false) }
    // "Looking…" forever is not an answer. After a few seconds with nothing
    // found, say the thing that is almost always true.
    var searchedLongEnough by remember { mutableStateOf(false) }
    // Closed to begin with, so the QR path — the one the desktop points at — is
    // the whole screen until somebody asks for more.
    var showingOtherWays by rememberSaveable { mutableStateOf(false) }

    val permissionSnapshot by environment.permissions.snapshot.collectAsState()

    LaunchedEffect(showingOtherWays) {
        searchedLongEnough = false
        if (!showingOtherWays) return@LaunchedEffect
        // Nearby devices, and on API 37 the local network, are asked for here
        // and nowhere else in the app. This is the first moment the app has any
        // use for them, and the person has just said what that use is.
        val missing = environment.permissions.discoveryPermissions()
        if (missing.isNotEmpty()) environment.requestPermissions(missing)
        delay(8_000)
        searchedLongEnough = true
    }

    // The credential goes to the process-scoped store; only the handle is ever
    // held by composition state, and the handle is minted with the computer it
    // belongs to, so this screen never has two halves to line up.
    fun openPending(connection: Connection, fromScan: Boolean) {
        val opened = PendingPairing.opening(secrets, connection, fromScan) ?: return
        pending = opened
        code = ""
        failure = null
    }

    val invite by session.pairingInvite.collectAsState()
    // One key, and it is the invite. `takeInvite` refuses while a redemption
    // holds the slot, and what brings the refused invitation back is not a
    // second key on this effect but `endAttemptTaking` in submit's `finally` —
    // releasing the slot is the retry. Opening the confirmation and emptying
    // the queue are one transaction on the other side of the boundary, which is
    // what `accept(_:)` in `ios/App/PairingView.swift` expresses as
    // `guard submission.allowsNavigation`.
    LaunchedEffect(invite) {
        val accepted = invite ?: return@LaunchedEffect
        val next = secrets.takeInvite(pending, accepted, session::consumePairingInvite)
        if (next !== pending) {
            pending = next
            code = ""
            failure = null
        }
    }

    // Session raises pairing problems through actionError; on this screen they
    // belong next to the form rather than in a modal on top of it.
    val actionError by session.actionErrorFlow.collectAsState()
    LaunchedEffect(actionError) {
        val message = actionError ?: return@LaunchedEffect
        failure = message
        session.actionError = null
    }

    // Cold, and collected only while the panel is open: collecting is what
    // starts the browse, and cancelling the collection is what stops it. The key
    // is the panel, so closing it tears the browse down the way `.onDisappear`
    // does on iOS — and entering this screen starts nothing at all.
    val discovery by produceState<DiscoveryState>(DiscoveryState.Idle, showingOtherWays) {
        if (!showingOtherWays) {
            value = DiscoveryState.Idle
            return@produceState
        }
        environment.discovery.discover().collect { value = it }
    }

    if (showingScanner) {
        QrScannerScreen(
            onCancel = { showingScanner = false },
            validate = { payload ->
                if (PairingInvite.parse(payload) == null) {
                    invalidQrMessage
                } else {
                    // Session decides whether this invite may be accepted at all
                    // (already paired, credential already burned) and publishes
                    // it as `pairingInvite` for the confirm step above.
                    session.receivePairingURL(payload)
                    showingScanner = false
                    null
                }
            },
        )
        return
    }

    fun submit(connection: Connection, credential: String, cameFromScanner: Boolean) {
        val selectedHandle = pending?.handle
        val pairRequestId = secrets.pairRequestId(selectedHandle) ?: return
        // Claims the slot for this redemption. It refuses a second submit, and
        // from here the store will not open a slot for an arriving deep link,
        // so the credential being redeemed cannot be replaced under it.
        if (!secrets.beginAttempt(selectedHandle)) return
        pairing = true
        failure = null
        scope.launch {
            try {
                session.pair(connection, credential, pairRequestId)
                // Every cleanup below names the handle this attempt owns. The
                // slot may already belong to a newer invite, and erasing that
                // one would cost the user a trip back to the computer (§6).
                secrets.clear(selectedHandle)
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                failure = session.actionError ?: error.message ?: pairingFailedMessage
                session.actionError = null
                when (pairingFailureDisposition(error, cameFromScanner)) {
                    PairingFailureDisposition.RETAIN_ATTEMPT -> {
                        // Neither the credential nor its request id leaves memory: Retry is the
                        // same idempotent logical request, possibly recovering a lost response.
                    }
                    PairingFailureDisposition.DROP_SCANNED_ATTEMPT -> {
                        if (pending?.handle == selectedHandle) pending = null
                        secrets.clear(selectedHandle)
                    }
                    PairingFailureDisposition.RESET_TYPED_ATTEMPT -> {
                        if (pending?.handle == selectedHandle) code = ""
                        secrets.resetAttempt(selectedHandle)
                    }
                }
            } finally {
                // Releasing the slot is also the retry. An invite that landed in
                // the window before Session marked this attempt was published
                // rather than deferred, and refused above; this is where it is
                // finally taken, in the same step that frees the slot.
                val next = secrets.endAttemptTaking(
                    handle = selectedHandle,
                    current = pending,
                    invite = session.pairingInvite.value,
                    consume = session::consumePairingInvite,
                )
                if (next !== pending) {
                    pending = next
                    code = ""
                    failure = null
                }
                pairing = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.mobile_pair_with_a_computer_51716e03),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            // The way back out, which the first run needs and which iOS puts in
            // the same place. Refused while a redemption is in flight, because a
            // credential that may already have reached the computer must not be
            // abandoned halfway (§6) — the port of `.disabled(!allowsNavigation)`.
            TextButton(onClick = onCancel, enabled = !pairing) { Text(stringResource(R.string.mobile_not_now_e4571490)) }
        }

        val selected = pending
        if (selected != null) {
            CodeSection(
                confirmation = PairingConfirmation.of(selected, secrets),
                code = code,
                onCodeChange = { value ->
                    val normalized = value.uppercase(java.util.Locale.ROOT)
                        .filter { it in 'A'..'Z' || it in '0'..'9' }.take(12)
                    code = normalized
                    secrets.setCode(selected.handle, normalized)
                },
                pairing = pairing,
                onSubmit = { credential ->
                    haptics.play(HapticCue.SELECT)
                    submit(selected.connection, credential, selected.fromScan)
                },
                onCancel = {
                    haptics.play(HapticCue.SELECT)
                    pending = null
                    code = ""
                    secrets.clear(selected.handle)
                    failure = null
                },
            )
        } else {
            SetupSection(onScan = {
                haptics.play(HapticCue.SELECT)
                failure = null
                showingScanner = true
            })
            OtherWaysSection(
                expanded = showingOtherWays,
                onToggle = {
                    haptics.play(HapticCue.SELECT)
                    showingOtherWays = !showingOtherWays
                },
            ) {
                DiscoverySection(
                    discovery = discovery,
                    searchedLongEnough = searchedLongEnough,
                    onChoose = { service ->
                        haptics.play(HapticCue.SELECT)
                        failure = null
                        val connection = service.toConnection()
                        if (connection == null) {
                            failure = noAddressMessage
                        } else {
                            openPending(connection, fromScan = false)
                        }
                    },
                )
                // Next to the list it makes empty, and only once the search it
                // describes is the thing on screen.
                if (permissionSnapshot.discoveryNeedsRequest) {
                    Text(
                        text = stringResource(
                            R.string.mobile_discovery_permission_hint,
                            permissionSnapshot.missingDiscovery.joinToString(),
                        ),
                        fontSize = 13.sp,
                        color = secondaryTint,
                    )
                }
                ManualSection(
                    address = manualAddress,
                    onAddressChange = { manualAddress = it },
                    onContinue = {
                        haptics.play(HapticCue.SELECT)
                        failure = null
                        val connection = Connection.parse(manualAddress)
                        if (connection == null) {
                            failure = invalidAddressMessage
                        } else {
                            openPending(connection, fromScan = false)
                        }
                    },
                )
            }
        }

        failure?.let {
            Text(text = localizedMobileCopy(it), color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }
    }
}

/**
 * The QR code is the way in; this is everything else, folded away until asked
 * for. Opening it is a decision with a cost — a local search, and the permission
 * that search needs — so it is a decision the person makes, not one the screen
 * makes for them.
 */
@Composable
private fun OtherWaysSection(
    expanded: Boolean,
    onToggle: () -> Unit,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = onToggle, modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.mobile_other_ways_to_connect_d9e8585d),
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.Start,
                    fontWeight = FontWeight.SemiBold,
                )
                Icon(
                    imageVector = if (expanded) {
                        Icons.Filled.KeyboardArrowUp
                    } else {
                        Icons.Filled.KeyboardArrowDown
                    },
                    contentDescription = null,
                )
            }
        }
        if (expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(24.dp)) { content() }
        }
    }
}

internal enum class PairingFailureDisposition {
    RETAIN_ATTEMPT,
    DROP_SCANNED_ATTEMPT,
    RESET_TYPED_ATTEMPT,
}

/** Route ambiguity and retryable server refusals keep the same logical request alive. */
internal fun pairingFailureDisposition(
    error: Throwable,
    cameFromScanner: Boolean,
): PairingFailureDisposition = when {
    error is PairingRouteError || error is ServerPairingRetryError -> PairingFailureDisposition.RETAIN_ATTEMPT
    cameFromScanner -> PairingFailureDisposition.DROP_SCANNED_ATTEMPT
    else -> PairingFailureDisposition.RESET_TYPED_ATTEMPT
}

@Composable
private fun SetupSection(onScan: () -> Unit) {
    SectionCard(title = stringResource(R.string.mobile_on_your_computer_9a621537)) {
        Text(stringResource(R.string.mobile_open_openmausbot_settings_phone_38cfc5bb), fontSize = 15.sp)
        Text(stringResource(R.string.mobile_choose_set_up_a_phone_8fd474a9), fontSize = 15.sp)
        Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.mobile_scan_qr_code_04e3f103))
        }
        Text(
            text = stringResource(R.string.mobile_pair_scanner_hint),
            fontSize = 13.sp,
            color = secondaryTint,
        )
    }
}

@Composable
private fun DiscoverySection(
    discovery: DiscoveryState,
    searchedLongEnough: Boolean,
    onChoose: (DiscoveredService) -> Unit,
) {
    val active = discovery as? DiscoveryState.Active
    SectionCard(title = stringResource(R.string.mobile_on_this_network_4c9f524a)) {
        val problem = active?.failure
        when {
            problem != null -> Text(localizedMobileCopy(problem), fontSize = 13.sp, color = secondaryTint)

            active == null || active.found.isEmpty() -> {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.mobile_looking_5e65f10e), color = secondaryTint, fontSize = 15.sp)
                }
                if (searchedLongEnough) {
                    // NSD is multicast: it does not cross subnets, and guest
                    // networks usually block it between clients even within one.
                    // Different Wi-Fi on the two devices is by far the most
                    // common reason this list stays empty.
                    Text(
                        text = stringResource(R.string.mobile_pair_discovery_empty),
                        fontSize = 13.sp,
                        color = secondaryTint,
                    )
                    // The honest answer when a network refuses to cooperate.
                    Text(
                        text = stringResource(R.string.mobile_pair_tailscale_hint),
                        fontSize = 13.sp,
                        color = secondaryTint,
                    )
                }
            }

            else -> Unit
        }

        active?.found?.forEach { service ->
            TextButton(
                onClick = { onChoose(service) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(service.name, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Start)
            }
        }
    }
}

@Composable
private fun ManualSection(
    address: String,
    onAddressChange: (String) -> Unit,
    onContinue: () -> Unit,
) {
    SectionCard(title = stringResource(R.string.mobile_or_enter_the_address_f74dcf1c)) {
        OutlinedTextField(
            value = address,
            onValueChange = onAddressChange,
            placeholder = { Text(stringResource(R.string.mobile_https_mac_example_or_192_168_1_42__e277eb2d)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = onContinue,
            enabled = address.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.mobile_continue_2e026239))
        }
        Text(
            text = stringResource(R.string.mobile_pair_manual_address_hint),
            fontSize = 13.sp,
            color = secondaryTint,
        )
    }
}

@Composable
private fun CodeSection(
    confirmation: PairingConfirmation,
    code: String,
    onCodeChange: (String) -> Unit,
    pairing: Boolean,
    onSubmit: (String) -> Unit,
    onCancel: () -> Unit,
) {
    SectionCard(title = stringResource(R.string.mobile_confirm_computer_d778cfbd)) {
        // Name and address sit above the branch, as they do in `PairingView.swift`:
        // the user is confirming which computer at which address, and that is the
        // same question whether the credential came from a QR code or the six
        // digits are about to be typed.
        Text(confirmation.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.mobile_address_d70f93df), color = secondaryTint, fontSize = 15.sp)
            Spacer(Modifier.weight(1f))
            Text(confirmation.address, fontSize = 15.sp, fontFamily = FontFamily.Monospace)
        }
        Text(localizedMobileCopy(confirmation.notice), fontSize = 13.sp, color = secondaryTint)

        when (val step = confirmation.step) {
            is PairingConfirmation.Step.Confirm -> Button(
                onClick = { onSubmit(step.credential) },
                enabled = !pairing,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (pairing) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(stringResource(R.string.mobile_pair_with_this_computer_8420e8b3))
                }
            }

            PairingConfirmation.Step.EnterCode -> {
                OutlinedTextField(
                    value = code,
                    onValueChange = onCodeChange,
                    placeholder = { Text(stringResource(R.string.mobile_pairing_code_placeholder)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                    textStyle = MaterialTheme.typography.headlineSmall.copy(
                        fontFamily = FontFamily.Monospace,
                        textAlign = TextAlign.Center,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onSubmit(code) },
                    enabled = PairingInvite.isPairingCode(code) && !pairing,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (pairing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text(stringResource(R.string.mobile_connect_b65463cb))
                    }
                }
            }

            // The app was restarted between the scan and the confirmation. The
            // token may already have reached the computer, and §6 is absolute
            // about never sending one twice, so there is nothing to retry here —
            // only the computer's name and address, and the way back.
            PairingConfirmation.Step.Rescan -> Unit
        }

        OutlinedButton(onClick = onCancel, enabled = !pairing, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.mobile_choose_a_different_computer_9e2a62ed))
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            text = title.uppercase(),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = secondaryTint,
        )
        HorizontalDivider()
        Spacer(Modifier.height(2.dp))
        content()
    }
}
