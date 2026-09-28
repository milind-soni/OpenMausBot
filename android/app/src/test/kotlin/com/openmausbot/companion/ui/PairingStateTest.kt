package com.openmausbot.companion.ui

import androidx.compose.runtime.saveable.SaverScope
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.PairingInvite
import com.openmausbot.companion.core.PairingRouteError
import com.openmausbot.companion.discovery.DiscoveredService
import com.openmausbot.companion.discovery.toConnection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The pending pairing has to survive a rotation and must not survive the process,
 * and §6's "never persist the QR credential or code" has to hold literally: no
 * secret may reach a saved-state Bundle, because the system keeps those across a
 * process kill.
 *
 * A fresh [PairingSecretStore] in these tests stands for the store a restarted
 * process would get: empty.
 */
/**
 * Opening with nothing in flight — the ordinary case these tests describe.
 * `open` itself answers null while a redemption holds the slot, which is the
 * subject of [PairingSecretStoreTest] rather than of every other test here.
 */
private fun PairingSecretStore.openIdle(credential: String? = null): String =
    assertNotNull(open(credential), "the store refused to open a slot")

/**
 * The same, one level up: a [PendingPairing] can only be minted by the store, so
 * there is no way for these tests — or for production — to write one whose
 * handle belongs to a different computer.
 */
private fun PairingSecretStore.openingIdle(
    connection: Connection,
    fromScan: Boolean,
    credential: String? = null,
): PendingPairing = assertNotNull(
    PendingPairing.opening(this, connection, fromScan, credential),
    "the store refused to open a slot",
)

/**
 * A record whose store is gone — the shape saved instance state comes back in
 * after the system killed the process.
 */
private fun deadProcessPairing(
    connection: Connection,
    fromScan: Boolean,
    credential: String? = null,
): PendingPairing = PairingSecretStore().openingIdle(connection, fromScan, credential)

class PairingStateTest {
    private val scope = SaverScope { true }

    private val connection = Connection(
        id = "conn-1",
        name = "Kesley's Ubuntu",
        host = "192.168.1.42",
        port = 8810,
        hosts = listOf("192.168.1.42", "kes.tail1234.ts.net"),
    )

    private val credential = "omb_pair_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg"

    /** `Saver.save` is a member extension: both receivers have to be implicit. */
    private fun saved(pending: PendingPairing?): String? =
        with(PendingPairingSaver) { with(scope) { save(pending) } }

    private fun scanned(secrets: PairingSecretStore) =
        secrets.openingIdle(connection, fromScan = true, credential = credential)

    @Test
    fun `the saved form never contains the credential code or request id`() {
        val secrets = PairingSecretStore()
        val pending = scanned(secrets)
        secrets.setCode(pending.handle, "123456")
        val requestId = secrets.pairRequestId(pending.handle)!!

        val encoded = saved(pending)
        assertTrue(encoded != null && encoded.isNotEmpty())
        assertFalse(encoded!!.contains(credential), "the credential reached saved state: $encoded")
        assertFalse(encoded.contains("omb_pair_"), "a credential prefix reached saved state: $encoded")
        assertFalse(encoded.contains("123456"), "the six-digit code reached saved state: $encoded")
        assertFalse(encoded.contains(requestId), "the pair request id reached saved state: $encoded")
    }

    @Test
    fun `a rotation keeps the scanned credential`() {
        // Same process, so the same store answers for the restored handle.
        val secrets = PairingSecretStore()
        val pending = scanned(secrets)
        val restored = saved(pending)?.let(PendingPairingSaver::restore)

        assertEquals(pending, restored)
        assertEquals(credential, restored?.credential(secrets))
        assertFalse(restored!!.needsRescan(secrets))
    }

    @Test
    fun `a rotation keeps the typed six-digit code`() {
        val secrets = PairingSecretStore()
        val pending = secrets.openingIdle(connection, fromScan = false)
        secrets.setCode(pending.handle, "420691")

        val restored = saved(pending)?.let(PendingPairingSaver::restore)
        assertEquals("420691", secrets.code(restored?.handle))
    }

    @Test
    fun `a restore into a new process has no credential and asks for a rescan`() {
        val pending = scanned(PairingSecretStore())
        val restarted = PairingSecretStore()

        val restored = saved(pending)?.let(PendingPairingSaver::restore)
        assertNull(restored?.credential(restarted))
        assertTrue(restored!!.needsRescan(restarted))
        // The computer is still shown, so the reader knows what was being paired.
        assertEquals(connection, restored.connection)
    }

    @Test
    fun `a restore into a new process has no six-digit code either`() {
        val secrets = PairingSecretStore()
        val pending = secrets.openingIdle(connection, fromScan = false)
        secrets.setCode(pending.handle, "420691")

        assertEquals("", PairingSecretStore().code(pending.handle))
    }

    @Test
    fun `a typed code survives the rotation after a process restart`() {
        val original = PairingSecretStore()
        val pending = original.openingIdle(connection, fromScan = false)

        // Process death: saved state comes back, the secrets do not.
        val restarted = PairingSecretStore()
        val restored = saved(pending)?.let(PendingPairingSaver::restore)!!
        assertFalse(restarted.owns(restored.handle))
        assertEquals("", restarted.code(restored.handle))

        // The screen rebinds an orphaned typed pairing before accepting input,
        // so the digits land somewhere the next rotation can find them.
        val rebound = restored.rebindingIfOrphaned(restarted)
        assertNotEquals(restored.handle, rebound.handle)
        assertTrue(restarted.owns(rebound.handle))
        restarted.setCode(rebound.handle, "420691")

        // Rotate: saved state round-trips again inside the same process.
        val afterRotation = saved(rebound)?.let(PendingPairingSaver::restore)!!
        assertEquals(rebound.handle, afterRotation.handle)
        assertEquals("420691", restarted.code(afterRotation.handle))
        // And rebinding is a no-op now that the store owns it.
        assertSame(afterRotation, afterRotation.rebindingIfOrphaned(restarted))
    }

    @Test
    fun `a scanned pairing is never rebound`() {
        val restarted = PairingSecretStore()
        val restored = saved(scanned(PairingSecretStore()))
            ?.let(PendingPairingSaver::restore)!!
        // Minting a slot cannot bring the credential back, so it stays orphaned.
        assertSame(restored, restored.rebindingIfOrphaned(restarted))
        assertTrue(restored.needsRescan(restarted))
    }

    @Test
    fun `a typed or discovered computer never needs a rescan`() {
        val secrets = PairingSecretStore()
        val manual = secrets.openingIdle(connection, fromScan = false)
        assertFalse(manual.needsRescan(secrets))
        assertFalse(manual.needsRescan(PairingSecretStore()))
    }

    @Test
    fun `an IPv6 address keeps its bracket form`() {
        val secrets = PairingSecretStore()
        val ipv6 = secrets.openingIdle(
            Connection(name = "fe80", host = "[fe80::1%eth0]", port = 8810),
            fromScan = false,
        )
        assertEquals(
            "[fe80::1%eth0]",
            saved(ipv6)?.let(PendingPairingSaver::restore)?.connection?.host,
        )
    }

    @Test
    fun `nothing pending saves nothing`() {
        assertNull(saved(null))
    }

    @Test
    fun `a corrupt saved value restores to nothing rather than crashing`() {
        assertNull(PendingPairingSaver.restore("not json"))
    }
}

class PairingSecretStoreTest {
    private val credential = "omb_pair_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg"

    @Test
    fun `a handle only answers in the store that minted it`() {
        val secrets = PairingSecretStore()
        val handle = secrets.openIdle(credential)
        assertEquals(credential, secrets.credential(handle))
        assertNull(PairingSecretStore().credential(handle))
    }

    @Test
    fun `a stale handle gets nothing`() {
        val secrets = PairingSecretStore()
        val first = secrets.openIdle(credential)
        val second = secrets.openIdle("omb_pair_second")
        assertNull(secrets.credential(first))
        assertEquals("omb_pair_second", secrets.credential(second))
    }

    @Test
    fun `opening a new pairing drops the previous code`() {
        val secrets = PairingSecretStore()
        val first = secrets.openIdle()
        secrets.setCode(first, "111111")
        val second = secrets.openIdle()
        assertEquals("", secrets.code(second))
    }

    @Test
    fun `route retry keeps the request id and an authoritative retry replaces it`() {
        val secrets = PairingSecretStore()
        val handle = secrets.openIdle(credential)
        val first = secrets.pairRequestId(handle)
        assertEquals(first, secrets.pairRequestId(handle))

        secrets.setCode(handle, "123456")
        secrets.resetAttempt(handle)
        assertNotEquals(first, secrets.pairRequestId(handle))
        assertEquals("", secrets.code(handle))
    }

    @Test
    fun `clear wipes both secrets`() {
        val secrets = PairingSecretStore()
        val handle = secrets.openIdle(credential)
        secrets.setCode(handle, "123456")
        secrets.clear(handle)
        assertNull(secrets.credential(handle))
        assertEquals("", secrets.code(handle))
        assertNull(secrets.pairRequestId(handle))
    }

    @Test
    fun `a finished attempt cannot clear the slot a newer pairing owns`() {
        // The shape of the bug: a deep link opens a second slot while the first
        // attempt is still in flight, and the first attempt's cleanup runs last.
        // Scoping the clear to its own handle is what stops it from erasing a QR
        // credential the user had just scanned and never redeemed (§6).
        val secrets = PairingSecretStore()
        val finishing = secrets.openIdle(credential)
        val newer = secrets.openIdle("omb_pair_second")

        secrets.clear(finishing)

        assertEquals("omb_pair_second", secrets.credential(newer))
        assertTrue(secrets.owns(newer))
    }

    @Test
    fun `the attempt that owns the slot still releases it`() {
        val secrets = PairingSecretStore()
        val handle = secrets.openIdle(credential)
        secrets.clear(handle)
        assertFalse(secrets.owns(handle))
    }

    /**
     * The port of `testPairingSubmissionBlocksResetUntilTheAttemptSettles`
     * (`ios/Tests/CompanionCoreTests/OnboardingTests.swift:164-181`), against
     * the object the screen actually goes through. `PairingScreen` cannot build
     * a `PendingPairing` without a handle, and this is the only place a handle
     * comes from, so a refusal here is a refusal on screen.
     */
    @Test
    fun `no slot is opened for a deep link while the attempt is redeeming`() {
        val secrets = PairingSecretStore()
        val active = secrets.openIdle(credential)
        assertTrue(secrets.beginAttempt(active))
        assertTrue(secrets.isRedeeming())

        assertNull(
            secrets.open("omb_pair_arriving_during_the_commit"),
            "a deep link opened a credential slot while the first one was being redeemed",
        )
        // And the attempt still has the credential it is redeeming.
        assertEquals(credential, secrets.credential(active))
        assertTrue(secrets.owns(active))
    }

    @Test
    fun `an invite for a different computer is refused just the same`() {
        // The plausible narrower rule — "only protect the slot from a repeat of
        // the same computer or the same credential" — is the one that lets a
        // second QR through and then has it erased by the first attempt.
        val secrets = PairingSecretStore()
        val active = secrets.openIdle(credential)
        assertTrue(secrets.beginAttempt(active))

        assertNull(secrets.open("omb_pair_a_completely_different_credential"))
        assertNull(secrets.open(), "a typed computer got a slot during the commit")
    }

    @Test
    fun `a second submit cannot overtake the request in flight`() {
        val secrets = PairingSecretStore()
        val handle = secrets.openIdle(credential)
        assertTrue(secrets.beginAttempt(handle))
        assertFalse(secrets.beginAttempt(handle), "a second Connect overtook the in-flight request")
    }

    @Test
    fun `the slot reopens once the attempt settles`() {
        val secrets = PairingSecretStore()
        val active = secrets.openIdle(credential)
        assertTrue(secrets.beginAttempt(active))
        secrets.endAttempt(active)

        assertFalse(secrets.isRedeeming())
        val next = assertNotNull(secrets.open("omb_pair_second"), "retry and deep links never resumed")
        assertEquals("omb_pair_second", secrets.credential(next))
    }

    @Test
    fun `only the attempt that owns the slot can claim or release it`() {
        val secrets = PairingSecretStore()
        val stale = secrets.openIdle(credential)
        val current = secrets.openIdle("omb_pair_second")

        assertFalse(secrets.beginAttempt(stale), "a stale handle claimed the current slot")
        assertFalse(secrets.beginAttempt(null))

        assertTrue(secrets.beginAttempt(current))
        secrets.endAttempt(stale)
        assertTrue(secrets.isRedeeming(), "a stale handle released someone else's attempt")
        secrets.endAttempt(current)
        assertFalse(secrets.isRedeeming())
    }

    /**
     * A `beginAttempt` whose `endAttempt` never ran must not lock this process
     * out of pairing: once its own slot is released there is nothing left to
     * protect.
     */
    @Test
    fun `releasing the slot ends the protection with it`() {
        val secrets = PairingSecretStore()
        val abandoned = secrets.openIdle(credential)
        assertTrue(secrets.beginAttempt(abandoned))
        secrets.clear(abandoned)

        assertFalse(secrets.isRedeeming())
        assertNotNull(secrets.open("omb_pair_second"))
    }

    @Test
    fun `a null handle never matches`() {
        val secrets = PairingSecretStore()
        secrets.openIdle(credential)
        assertNull(secrets.credential(null))
        assertEquals("", secrets.code(null))
    }

    @Test
    fun `writing a code through a stale handle is ignored`() {
        val secrets = PairingSecretStore()
        val stale = secrets.openIdle()
        val current = secrets.openIdle()
        secrets.setCode(stale, "999999")
        assertEquals("", secrets.code(current))
    }

    @Test
    fun `a pairing with no credential has none to give`() {
        val secrets = PairingSecretStore()
        assertNull(secrets.credential(secrets.openIdle()))
    }
}

/**
 * The transaction `PairingScreen` runs when `Session` publishes an invite: open
 * a slot for it and, only if that succeeded, show the confirmation and empty the
 * queue. Both halves or neither.
 *
 * The half worth pinning is the refusal, and it is not hypothetical. Between
 * this screen claiming the slot and `Session.pair` marking its own attempt in
 * flight there is a real moment where a deep link is still published. Spending
 * the invite there would make a QR the user had just scanned vanish with nothing
 * shown and nothing redeemed; showing the new computer there would leave the
 * screen naming B while the handle still hands out A's credential (§6).
 */
class PairingInviteTransactionTest {
    private val active = Connection(id = "a", name = "Computer A", host = "192.168.1.42", port = 8810)
    private val other = Connection(id = "b", name = "Computer B", host = "192.168.1.99", port = 8810)
    private val activeCredential = "omb_pair_" + "a".repeat(43)
    private val arriving = "omb_pair_" + "b".repeat(43)

    /** A slot mid-redemption: what the screen looks like while Connect is spinning. */
    private fun redeeming(): Pair<PairingSecretStore, PendingPairing> {
        val secrets = PairingSecretStore()
        val pending = secrets.openingIdle(active, fromScan = true, credential = activeCredential)
        assertTrue(secrets.beginAttempt(pending.handle))
        return secrets to pending
    }

    private fun PairingSecretStore.assertRefuses(
        current: PendingPairing?,
        invite: PairingInvite,
    ) {
        var consumed = 0

        val next = takeInvite(current, invite) { consumed++ }

        assertSame(current, next, "the confirmation moved while the credential was being redeemed")
        assertEquals(0, consumed, "a one-time invite was spent on a refusal")
    }

    @Test
    fun `an invite for another computer changes nothing while the slot is redeeming`() {
        val (secrets, pending) = redeeming()

        secrets.assertRefuses(pending, PairingInvite(other, arriving))

        // The attempt still owns its slot, and the slot still holds its credential.
        assertTrue(secrets.owns(pending.handle), "the active slot was replaced")
        assertEquals(activeCredential, secrets.credential(pending.handle))
        assertEquals(active, pending.connection)
    }

    @Test
    fun `an invite for the same computer changes nothing either`() {
        val (secrets, pending) = redeeming()

        secrets.assertRefuses(pending, PairingInvite(active, arriving))

        assertTrue(secrets.owns(pending.handle))
        assertEquals(activeCredential, secrets.credential(pending.handle))
    }

    @Test
    fun `a screen with nothing pending still may not spend an invite the store refuses`() {
        val (secrets, _) = redeeming()

        secrets.assertRefuses(null, PairingInvite(other, arriving))
    }

    @Test
    fun `the invite is taken exactly once when the attempt has settled`() {
        val (secrets, pending) = redeeming()
        secrets.endAttempt(pending.handle)
        var consumed = 0

        val next = assertNotNull(secrets.takeInvite(pending, PairingInvite(other, arriving)) { consumed++ })

        assertEquals(1, consumed, "the queue was not emptied exactly once")
        assertNotEquals(pending.handle, next.handle, "the new invite reused the previous slot's handle")
        // The record names the computer whose credential its handle hands out.
        assertEquals(other, next.connection)
        assertEquals(arriving, secrets.credential(next.handle))
        assertTrue(next.fromScan)
    }

    /**
     * The window this pass could not close: between the screen claiming the slot
     * and `Session` marking its own attempt in flight, a deep link is published
     * rather than deferred. It reaches the screen, is refused, and stays in the
     * queue. Releasing the slot is what has to go back for it — otherwise a
     * one-time QR sits unseen until the user leaves the screen and returns.
     */
    @Test
    fun `releasing the slot takes the invite that was refused while it was held`() {
        val (secrets, pending) = redeeming()
        val arrivedDuringTheWindow = PairingInvite(other, arriving)
        secrets.assertRefuses(pending, arrivedDuringTheWindow)
        var consumed = 0

        val next = assertNotNull(
            secrets.endAttemptTaking(pending.handle, pending, arrivedDuringTheWindow) { consumed++ },
        )

        assertEquals(1, consumed, "the invitation was not taken out of the queue")
        assertEquals(other, next.connection)
        assertEquals(arriving, secrets.credential(next.handle))
        assertNotEquals(pending.handle, next.handle)
        assertFalse(secrets.isRedeeming(), "the slot was not released")
    }

    @Test
    fun `an attempt that dropped its pairing still picks the invitation up`() {
        val (secrets, pending) = redeeming()
        var consumed = 0

        // What an authoritative QR failure leaves behind: no confirmation on
        // screen, and an invitation that arrived while it was failing.
        val next = assertNotNull(
            secrets.endAttemptTaking(pending.handle, null, PairingInvite(other, arriving)) { consumed++ },
        )

        assertEquals(1, consumed)
        assertEquals(other, next.connection)
    }

    @Test
    fun `releasing the slot with nothing waiting changes nothing but the slot`() {
        val (secrets, pending) = redeeming()
        var consumed = 0

        val next = secrets.endAttemptTaking(pending.handle, pending, invite = null) { consumed++ }

        assertSame(pending, next)
        assertEquals(0, consumed)
        assertFalse(secrets.isRedeeming())
        // Released for real: the next invitation opens a slot again.
        assertNotNull(secrets.open("omb_pair_later"))
    }

    @Test
    fun `a taken invite leaves nothing of the pairing it replaced`() {
        val (secrets, pending) = redeeming()
        secrets.setCode(pending.handle, "123456")
        secrets.endAttempt(pending.handle)

        val next = assertNotNull(secrets.takeInvite(pending, PairingInvite(other, arriving)) {})

        assertNull(secrets.credential(pending.handle), "the previous credential is still reachable")
        assertEquals("", secrets.code(next.handle))
    }
}

class PairingFailureDispositionTest {
    @Test
    fun `route failure retains either kind of in-memory attempt`() {
        val error = PairingRouteError(listOf("https://mac.example"))
        assertEquals(
            PairingFailureDisposition.RETAIN_ATTEMPT,
            pairingFailureDisposition(error, cameFromScanner = true),
        )
        assertEquals(
            PairingFailureDisposition.RETAIN_ATTEMPT,
            pairingFailureDisposition(error, cameFromScanner = false),
        )
    }

    @Test
    fun `authoritative failure drops qr but only resets a typed code`() {
        val error = IllegalStateException("pairing rejected")
        assertEquals(
            PairingFailureDisposition.DROP_SCANNED_ATTEMPT,
            pairingFailureDisposition(error, cameFromScanner = true),
        )
        assertEquals(
            PairingFailureDisposition.RESET_TYPED_ATTEMPT,
            pairingFailureDisposition(error, cameFromScanner = false),
        )
    }
}

/**
 * The confirmation, read against `confirmationView(for:)` in
 * `ios/App/PairingView.swift`.
 *
 * The expectations here come from the Swift, not from the Kotlin they check.
 * Two things are load-bearing there:
 *
 *  - `Text(connection.name)` and `Text(connection.pairingConsentOrigin)`
 *    sit **above** `if let credential = scannedCredential`, so both are on
 *    screen before confirming a scan *and* before typing six digits.
 *  - the scanned branch reads: "Confirm this computer to establish an
 *    authenticated companion connection. Use a trusted Wi-Fi network or a
 *    tailnet; OpenMausBot does not encrypt local Wi-Fi traffic." Authenticated
 *    and encrypted are different claims, and only one of them is true of the
 *    local network.
 */
class PairingConfirmationTest {
    private val connection = Connection(
        id = "conn-1",
        name = "Kesley's Ubuntu",
        host = "192.168.1.42",
        port = 8810,
    )

    private val credential = "omb_pair_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg"

    private fun scanned(secrets: PairingSecretStore) =
        secrets.openingIdle(connection, fromScan = true, credential = credential)

    private fun typed(secrets: PairingSecretStore) =
        secrets.openingIdle(connection, fromScan = false)

    @Test
    fun `a scanned computer is confirmed by name and address`() {
        val secrets = PairingSecretStore()
        val confirmation = PairingConfirmation.of(scanned(secrets), secrets)

        assertEquals("Kesley's Ubuntu", confirmation.name)
        assertEquals("http://192.168.1.42:8810", confirmation.address)
        assertEquals(
            PairingConfirmation.Step.Confirm(credential),
            confirmation.step,
        )
    }

    @Test
    fun `a discovered or typed computer shows the same name and address`() {
        // The gap this pass closes: the six-digit path used to show the name as a
        // section title and never repeat the address.
        val secrets = PairingSecretStore()
        val confirmation = PairingConfirmation.of(typed(secrets), secrets)

        assertEquals("Kesley's Ubuntu", confirmation.name)
        assertEquals("http://192.168.1.42:8810", confirmation.address)
        assertEquals(PairingConfirmation.Step.EnterCode, confirmation.step)
    }

    @Test
    fun `a scan that outlived its credential still names the computer and address`() {
        val restarted = PairingSecretStore()
        val restored = deadProcessPairing(connection, fromScan = true, credential = credential)
        val confirmation = PairingConfirmation.of(restored, restarted)

        assertEquals(PairingConfirmation.Step.Rescan, confirmation.step)
        assertEquals("Kesley's Ubuntu", confirmation.name)
        assertEquals("http://192.168.1.42:8810", confirmation.address)
    }

    @Test
    fun `no step of the confirmation is reachable without a name and an address`() {
        val secrets = PairingSecretStore()
        val every = listOf(
            PairingConfirmation.of(scanned(secrets), secrets),
            PairingConfirmation.of(typed(PairingSecretStore()), PairingSecretStore()),
            PairingConfirmation.of(
                deadProcessPairing(connection, fromScan = true, credential = credential),
                PairingSecretStore(),
            ),
        )
        assertEquals(
            listOf(
                PairingConfirmation.Step.Confirm(credential),
                PairingConfirmation.Step.EnterCode,
                PairingConfirmation.Step.Rescan,
            ),
            every.map { it.step },
            "the three steps of confirmationView(for:) are not all covered",
        )
        for (confirmation in every) {
            assertTrue(confirmation.name.isNotBlank(), "a step with no name: ${confirmation.step}")
            assertEquals(
                connection.pairingConsentOrigin,
                confirmation.address,
                "a step without a display authority: ${confirmation.step}",
            )
            assertTrue(confirmation.notice.isNotBlank(), "a step with no notice: ${confirmation.step}")
        }
    }

    @Test
    fun `a computer that never told us its name is headed by its address`() {
        val secrets = PairingSecretStore()
        val nameless = secrets.openingIdle(connection.copy(name = "  "), fromScan = false)
        val confirmation = PairingConfirmation.of(nameless, secrets)
        assertEquals("http://192.168.1.42:8810", confirmation.name)
        assertEquals("http://192.168.1.42:8810", confirmation.address)
    }

    @Test
    fun `an IPv6 computer keeps its brackets in the address`() {
        val secrets = PairingSecretStore()
        val ipv6 = secrets.openingIdle(
            Connection(name = "fe80", host = "[fe80::1]", port = 8810),
            fromScan = false,
        )
        assertEquals("http://[fe80::1]:8810", PairingConfirmation.of(ipv6, secrets).address)
    }

    @Test
    fun `a hosted scan shows the complete HTTPS authority and HTTPS notice`() {
        val secrets = PairingSecretStore()
        val hosted = requireNotNull(Connection.parse("https://mac.example:9443")).copy(name = "Hosted Mac")
        val pending = secrets.openingIdle(hosted, fromScan = true, credential = credential)

        val confirmation = PairingConfirmation.of(pending, secrets)

        assertEquals("https://mac.example:9443", confirmation.address)
        assertTrue(confirmation.notice.contains("authenticated HTTPS companion connection"))
        assertFalse(confirmation.notice.contains("does not encrypt"))
    }

    @Test
    fun `the scanned notice says authenticated and says the local network is not encrypted`() {
        val notice = PairingCopy.CONFIRM_SCAN
        // The clauses of the Swift line, each carrying its own claim.
        assertTrue(notice.contains("authenticated companion connection"), notice)
        assertTrue(notice.contains("trusted Wi-Fi"), notice)
        assertTrue(notice.contains("tailnet"), notice)
        assertTrue(notice.contains("does not encrypt local Wi-Fi traffic"), notice)
        // And it still asks the question a scan must never answer for the user.
        assertTrue(notice.contains("Only continue if this is the computer"), notice)
    }

    @Test
    fun `the scanned notice no longer talks about what the phone gains instead`() {
        // The copy this replaces listed the phone's new powers and left the
        // transport unmentioned, which is the half that matters on a shared LAN.
        val notice = PairingCopy.CONFIRM_SCAN
        assertFalse(notice.contains("answer approvals"), notice)
        assertFalse(notice.contains("send work"), notice)
    }

    @Test
    fun `manual pairing asks for the desktop or server code`() {
        val notice = PairingCopy.ENTER_CODE
        assertTrue(notice.contains("pairing code"), notice)
        assertTrue(notice.contains("computer or server"), notice)
    }

    @Test
    fun `a QR or deep link without an address never becomes a pending pairing`() {
        assertNull(PairingInvite.parse("openmausbot://pair?token=$credential"))
        // The control: with one, the invite carries a host and a port.
        val invite = PairingInvite.parse(
            "openmausbot://pair?address=192.168.1.42:8810&name=Kesley%27s%20Ubuntu&token=$credential",
        )
        assertEquals("192.168.1.42", invite?.connection?.host)
        assertEquals(8810, invite?.connection?.port)
    }

    @Test
    fun `a typed address that is not one never becomes a pending pairing`() {
        assertNull(Connection.parse(""))
        assertNull(Connection.parse("   "))
        assertNull(Connection.parse("http://"))
        assertNull(Connection.parse("192.168.1.42:not-a-port"))
        assertEquals(8810, Connection.parse("192.168.1.42")?.port)
    }

    @Test
    fun `a discovered service that answered without an address is refused`() {
        assertNull(DiscoveredService(name = "Kesley's Ubuntu", host = null, port = 8810).toConnection())
        assertNull(DiscoveredService(name = "Kesley's Ubuntu", host = "192.168.1.42", port = null).toConnection())
        // The control: a resolved one carries both, so the confirmation can open.
        val resolved = DiscoveredService(name = "Kesley's Ubuntu", host = "192.168.1.42", port = 8810)
            .toConnection()
        assertEquals("192.168.1.42", resolved?.host)
        assertEquals(8810, resolved?.port)
    }
}
