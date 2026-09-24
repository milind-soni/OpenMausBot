package com.openmausbot.companion.ui

import androidx.compose.runtime.saveable.Saver
import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.PairingInvite
import java.util.UUID
import kotlinx.serialization.Serializable

/**
 * Pairing attempt state — the QR credential, six-digit code, and stable request
 * id — held in process memory and nowhere else.
 *
 * §6 is explicit: *never persist the QR credential or the code*. The request id
 * shares their process-only lifetime. Only the
 * long-lived device token is written down. Saved instance state does not count
 * as memory for this purpose — the system holds those Bundles across a
 * process kill, which is exactly how `rememberSaveable` survives one — so
 * nothing here may ever be handed to a `Saver`.
 *
 * The consequence is the behaviour we want anyway. A rotation keeps the same
 * process, so this store still holds the credential and the confirmation screen
 * carries on. A restore after the system killed the app gets a fresh, empty
 * store, so the credential is simply gone — which is the honest answer, because
 * `Session`'s spent-credential set died with the process too and nothing left
 * can say whether that token was already redeemed. Retrying one that may have
 * reached the computer can mint a second device record.
 *
 * One pending pairing at a time, so one slot — and the slot is what a second
 * invite must not be allowed to take. So the store, not the screen, owns
 * "an attempt is redeeming": [open] refuses while [beginAttempt] is standing,
 * and [clear] releases only the slot its own handle still owns. A caller with no
 * handle has no credential and no confirmation, so a refusal here is the whole
 * rule rather than a check something else can forget to make.
 */
internal class PairingSecretStore {
    private var handle: String? = null
    private var credential: String? = null
    private var code: String = ""
    private var pairRequestId: String? = null
    /** The handle of the attempt currently redeeming, if there is one. */
    private var attempting: String? = null

    /**
     * Begin a pending pairing and return its handle — a random, non-secret id
     * that is safe to put in saved state and means nothing without this store —
     * or null when the slot it would replace is being redeemed.
     *
     * That refusal is this side of the credential-lifecycle rule. A deep link
     * arriving during a commit must not take the slot: the attempt that finishes
     * would then release a QR the user never got to use, and they would have to
     * go back to the computer for a third one (§6). Returning null rather than
     * asking callers to check first is deliberate — the handle is the only route
     * to a credential, so a caller that cannot get one cannot open a
     * confirmation either, and there is no guard left for a screen to forget.
     */
    @Synchronized
    fun open(credential: String? = null): String? {
        if (isRedeeming()) return null
        val minted = UUID.randomUUID().toString()
        handle = minted
        this.credential = credential
        this.code = ""
        this.pairRequestId = UUID.randomUUID().toString()
        return minted
    }

    /**
     * Mark this slot's credential as being redeemed — the port of
     * `CompanionPairingSubmissionState.begin()` in
     * `ios/Sources/CompanionCore/Onboarding.swift`. It lives here rather than in
     * the screen because the thing that must not be replaced is the slot, and
     * this is the only object that can refuse to replace it.
     *
     * False when the caller does not own the slot, or when a redemption is
     * already running: a second submit must not overtake a request the computer
     * may already have persisted.
     */
    @Synchronized
    fun beginAttempt(handle: String?): Boolean {
        if (!owns(handle) || attempting != null) return false
        attempting = handle
        return true
    }

    /** The attempt is over, whatever its outcome. */
    @Synchronized
    fun endAttempt(handle: String?) {
        if (attempting == handle) attempting = null
    }

    /**
     * True while an attempt is redeeming the credential this slot still holds.
     *
     * Scoped to the current slot on purpose: once the attempt's own [clear] has
     * released it there is nothing left to protect, so a stranded [beginAttempt]
     * cannot lock this process out of pairing for good.
     */
    @Synchronized
    fun isRedeeming(): Boolean = attempting != null && attempting == handle

    /** True when this store is the one that minted [handle] and still holds it. */
    @Synchronized
    fun owns(handle: String?): Boolean = handle != null && handle == this.handle

    /** The scanned credential, or null once the process that scanned it is gone. */
    @Synchronized
    fun credential(handle: String?): String? = if (owns(handle)) credential else null

    @Synchronized
    fun code(handle: String?): String = if (owns(handle)) code else ""

    /** Stable for Retry, and absent from saved state alongside the one-time credential. */
    @Synchronized
    fun pairRequestId(handle: String?): String? = if (owns(handle)) pairRequestId else null

    @Synchronized
    fun setCode(handle: String?, value: String) {
        if (owns(handle)) code = value
    }

    /** A server rejection ends one logical code attempt without changing the chosen computer. */
    @Synchronized
    fun resetAttempt(handle: String?) {
        if (!owns(handle)) return
        code = ""
        pairRequestId = UUID.randomUUID().toString()
    }

    /**
     * Release the slot this handle owns.
     *
     * Scoped on purpose. The attempt that finishes is not necessarily the
     * attempt that owns the slot, and a global wipe would take the credential
     * of whichever pairing came after it — a QR the user had just scanned and
     * never got to redeem (§6).
     */
    @Synchronized
    fun clear(handle: String?) {
        if (!owns(handle)) return
        this.handle = null
        credential = null
        code = ""
        pairRequestId = null
    }
}

/** Process-wide instance: a class initialiser runs once per process. */
internal val PairingSecrets = PairingSecretStore()

/**
 * The computer the user is about to pair with, held while they confirm it.
 *
 * Deliberately carries **no secret**: a connection, whether it came from a scan,
 * and the [handle] that finds the secrets in [PairingSecretStore]. This is the
 * part that is safe to put in saved instance state.
 *
 * The constructor is private and there is no `copy`, so [opening] — which asks
 * the store for a slot and binds the handle it mints to *this* connection on the
 * spot — is the only way to write one down. That is deliberate: a record that
 * showed one computer while its handle handed out another computer's credential
 * would let the user confirm B and redeem A. Saved instance state comes back
 * through the generated serializer, which is the one other way in and carries
 * the connection and handle it saved together.
 */
@Serializable
internal class PendingPairing private constructor(
    val connection: Connection,
    /** True when this came from a QR or deep link rather than the list or a typed address. */
    val fromScan: Boolean,
    val handle: String,
) {
    override fun equals(other: Any?): Boolean =
        this === other ||
            (
                other is PendingPairing &&
                    connection == other.connection &&
                    fromScan == other.fromScan &&
                    handle == other.handle
                )

    override fun hashCode(): Int {
        var result = connection.hashCode()
        result = 31 * result + fromScan.hashCode()
        result = 31 * result + handle.hashCode()
        return result
    }

    /** No credential and no code here, and none may ever be added. */
    override fun toString(): String =
        "PendingPairing(connection=$connection, fromScan=$fromScan, handle=$handle)"

    companion object {
        /**
         * Open a slot for this computer and hold on to what it minted, or null
         * when the store refuses — which it does while the slot it would replace
         * is being redeemed (§6).
         */
        fun opening(
            secrets: PairingSecretStore,
            connection: Connection,
            fromScan: Boolean,
            credential: String? = null,
        ): PendingPairing? =
            secrets.open(credential)?.let { PendingPairing(connection, fromScan, it) }
    }
}

/** The scanned credential for this pairing, if this process is still the one holding it. */
internal fun PendingPairing.credential(secrets: PairingSecretStore = PairingSecrets): String? =
    secrets.credential(handle)

/**
 * True when a scanned pairing has outlived its credential and the user must
 * rescan rather than retry something that may already have been redeemed.
 */
internal fun PendingPairing.needsRescan(secrets: PairingSecretStore = PairingSecrets): Boolean =
    fromScan && secrets.credential(handle) == null

/**
 * A pending pairing restored into a store that never knew it — the shape of a
 * process restart, where saved state came back and the secrets did not.
 *
 * A typed or discovered computer is given a fresh slot, because there is nothing
 * to recover and the user is about to type six digits that have to be written
 * down somewhere the next rotation can find them. A scanned one is left alone:
 * minting a slot cannot bring the credential back, and it is the rescan case.
 */
internal fun PendingPairing.rebindingIfOrphaned(
    secrets: PairingSecretStore = PairingSecrets,
): PendingPairing {
    if (fromScan || secrets.owns(handle)) return this
    return PendingPairing.opening(secrets, connection, fromScan = false) ?: this
}

/**
 * The pairing screen's transaction on top of [PairingSecretStore]: open a slot
 * for a published invite and, only if that succeeded, take the invite out of
 * `Session`'s queue.
 *
 * Both halves happen or neither does, and that is the whole point. [consume] is
 * handed in rather than left to the caller because the interesting case is the
 * refusal: the store says no while the slot is being redeemed, and spending the
 * one-time invite anyway would make a QR the user just scanned disappear without
 * ever being shown or redeemed (§6). A caller that never learns the open
 * succeeded cannot spend it on its own.
 *
 * Returns what the screen should show. On a refusal that is [current], unchanged
 * — same computer, same handle, same credential — and the invite stays queued
 * for the moment the running attempt settles.
 */
internal fun PairingSecretStore.takeInvite(
    current: PendingPairing?,
    invite: PairingInvite,
    consume: () -> Unit,
): PendingPairing? {
    val opened = PendingPairing.opening(
        secrets = this,
        connection = invite.connection,
        fromScan = true,
        credential = invite.credential,
    ) ?: return current
    consume()
    return opened
}

/**
 * Release the slot this attempt claimed and, in the same step, take any invite
 * that is waiting for it.
 *
 * This is the other half of [takeInvite] and it exists because of one narrow
 * window. Between the screen claiming the slot and `Session` marking its own
 * attempt in flight, a deep link is still *published* rather than deferred: it
 * reaches the screen, [takeInvite] refuses it, and it stays in the queue. If
 * ending the attempt did not go looking for it, the invitation would sit there
 * unseen until the user left the pairing screen and came back — a one-time QR
 * that expires while it is on the phone (§6).
 *
 * Order is the rule: the attempt has to end *before* the open is tried, or the
 * store refuses its own release. Returns what the screen should show, which is
 * [current] when there was nothing waiting.
 */
internal fun PairingSecretStore.endAttemptTaking(
    handle: String?,
    current: PendingPairing?,
    invite: PairingInvite?,
    consume: () -> Unit,
): PendingPairing? {
    endAttempt(handle)
    if (invite == null) return current
    return takeInvite(current, invite, consume)
}

/**
 * Through saved instance state. `Connection` is already `@Serializable` for the
 * connection store, so one encoding serves both and there is no second shape of
 * the record to keep in step. Nothing secret passes through here.
 */
internal val PendingPairingSaver: Saver<PendingPairing?, String> = Saver(
    save = { pending ->
        pending?.let { CompanionJson.encodeToString(PendingPairing.serializer(), it) }
    },
    restore = { encoded ->
        runCatching { CompanionJson.decodeFromString(PendingPairing.serializer(), encoded) }
            .getOrNull()
    },
)

/**
 * What the confirmation says about a [PendingPairing], worked out before any of
 * it is drawn so the wording itself can be pinned by a test.
 *
 * The port of `confirmationView(for:)` in `ios/App/PairingView.swift`. There the
 * name and display authority sit *above* the branch, so they are on screen whether the
 * user is confirming a scan or about to type the six digits the desktop shows.
 * That placement is §6 substance, not layout: a scan never pairs by itself, and
 * what the user is confirming is which computer, at which address.
 */
internal data class PairingConfirmation(
    val name: String,
    /** Complete normalized origin, without any path, query or credential. */
    val address: String,
    val usesHttps: Boolean,
    val step: Step,
) {
    sealed interface Step {
        /** A scan whose one-time credential is still in this process: one tap pairs. */
        data class Confirm(val credential: String) : Step

        /** A discovered or typed computer: six digits, read off the desktop. */
        data object EnterCode : Step

        /** The process died between the scan and the confirmation; §6 forbids the retry. */
        data object Rescan : Step
    }

    val notice: String
        get() = when (step) {
            is Step.Confirm -> if (usesHttps) PairingCopy.CONFIRM_HTTPS else PairingCopy.CONFIRM_SCAN
            Step.EnterCode -> PairingCopy.ENTER_CODE
            Step.Rescan -> PairingCopy.RESCAN
        }

    companion object {
        fun of(
            pending: PendingPairing,
            secrets: PairingSecretStore = PairingSecrets,
        ): PairingConfirmation {
            val connection = pending.connection
            val address = connection.pairingConsentOrigin
            return PairingConfirmation(
                // A discovered service is named by whatever it advertised, so a
                // blank name is possible in a way `Connection.parse` and
                // `PairingInvite.parse` are not. The address is then the honest
                // heading, and the confirmation never opens without one.
                name = connection.name.ifBlank { address },
                address = address,
                usesHttps = connection.activeEndpoint?.isSecure == true,
                step = when {
                    pending.needsRescan(secrets) -> Step.Rescan
                    else -> pending.credential(secrets)?.let(Step::Confirm) ?: Step.EnterCode
                },
            )
        }
    }
}

/**
 * The confirmation's wording, in one place because this is the part §6 cares
 * about: what pairing authenticates, and what it does not encrypt.
 */
internal object PairingCopy {
    const val CONFIRM_HTTPS: String =
        "Only continue if this is the computer whose QR code you just scanned. " +
            "Confirming establishes an authenticated HTTPS companion connection."

    /**
     * Mirrors `ios/App/PairingView.swift`, which says of a scanned computer:
     * "Confirm this computer to establish an authenticated companion connection.
     * Use a trusted Wi-Fi network or a tailnet; OpenMausBot does not encrypt
     * local Wi-Fi traffic."
     *
     * The pairing handshake authenticates the phone to the computer; the session
     * that follows is plain HTTP on the local network. Those are different
     * claims and the user is the one who has to choose the network, so both are
     * said out loud.
     */
    const val CONFIRM_SCAN: String =
        "Only continue if this is the computer whose QR code you just scanned. " +
            "Confirming establishes an authenticated companion connection. Use a " +
            "trusted Wi-Fi network or a tailnet; OpenMausBot does not encrypt " +
            "local Wi-Fi traffic."

    /** Both the desktop companion and headless server show pairing codes. */
    const val ENTER_CODE: String = "Enter the pairing code shown on your computer or server:"

    /**
     * No iOS counterpart: SwiftUI's `@State` dies with the process, so iOS never
     * restores a half-finished scan. Android's saved state does, and the answer
     * §6 demands is a new QR rather than a replay.
     */
    const val RESCAN: String =
        "This app restarted before the pairing finished. That one-time code is " +
            "never reused, because it may already have been redeemed. Start pairing " +
            "again on your computer and scan the new QR code."
}
