package com.openmausbot.companion.audio

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.openmausbot.companion.core.APIError
import com.openmausbot.companion.core.LiveCallStart
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import com.openmausbot.companion.ui.LiveCallRules
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/**
 * The state machine behind the call bar, with the WebRTC transport, the audio
 * route, the phone's remembered choices and the computer all faked. The rules
 * it pins come from the spec's error table, its lifecycle decisions and the
 * shared contract rulings; nothing here loads `org.webrtc`.
 *
 * Driven on a TestScope: the manager launches everything on its scope, so
 * `runCurrent()` after each action is the "let the main thread run" of a test,
 * and the manager's clock is the test's virtual clock.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveCallManagerTest {
    private val call = LiveCallState("c1", "b1", "t1", "android", "marin", 5_000.0, LiveCallStatus.CONNECTING)
    private val grant = MicrophoneAccess { it(true) }
    private val deny = MicrophoneAccess { it(false) }

    // ------------------------------------------------------------ going live

    @Test
    fun `start asks for the microphone, posts the offer and says Connecting until the computer and the channel are both ready`() = runTest {
        val f = Fixture(this)
        f.manager.start("b1", "t1", "Ada", grant)
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase)
        runCurrent()

        assertEquals(listOf(Triple("b1", "t1", FakeTransport.OFFER)), f.api.starts)
        assertEquals(FakeApi.ANSWER, f.transport.accepted)
        var state = f.manager.state.value
        assertEquals(LiveCallPhase.STARTING, state.phase, "answered, but the computer has not attached and the channel is closed")
        assertEquals("c1", state.callId)
        assertNull(state.liveSince)
        assertEquals(listOf(true), f.audio.begins)
        assertTrue(state.active)
        assertEquals(false, f.transport.muted, "the track starts unmuted")

        // The computer attaches its side first: still connecting, the channel is not open.
        advanceTimeBy(1_500)
        f.api.serverCall.value = call.copy(status = LiveCallStatus.LIVE)
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase)

        // The channel opens: live, and the clock counts from now, on this phone's clock.
        advanceTimeBy(500)
        requireNotNull(f.transport.listener).onChannelOpen()
        runCurrent()
        state = f.manager.state.value
        assertEquals(LiveCallPhase.LIVE, state.phase)
        assertEquals(currentTime, state.liveSince, "not the computer's startedAt (5000), not the 201")
        assertEquals("Ada", state.botName)
    }

    @Test
    fun `a channel that opens first still waits for the computer to attach`() = runTest {
        val f = Fixture(this)
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        requireNotNull(f.transport.listener).onChannelOpen()
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase)

        f.api.serverCall.value = call.copy(status = LiveCallStatus.CONNECTING)
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase, "connecting is not attached")

        f.api.serverCall.value = call.copy(status = LiveCallStatus.LIVE)
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
        assertEquals(currentTime, f.manager.state.value.liveSince)
    }

    @Test
    fun `a status this build does not know counts as attached`() = runTest {
        val f = Fixture(this)
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        requireNotNull(f.transport.listener).onChannelOpen()
        f.api.serverCall.value = call.copy(status = LiveCallStatus.UNKNOWN)
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase, "an unknown status is a call still running")
    }

    @Test
    fun `a 201 that says live counts as the computer's word`() = runTest {
        val f = Fixture(this)
        f.api.answer = { LiveCallStart.Started(call.copy(status = LiveCallStatus.LIVE), FakeApi.ANSWER) }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase)
        requireNotNull(f.transport.listener).onChannelOpen()
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
    }

    // ------------------------------------------------------------ the first call's disclosure

    @Test
    fun `a phone that never called owes the disclosure until Start call, then never again`() = runTest {
        val preferences = FakePreferences()
        val f = Fixture(this, preferences)
        assertTrue(f.manager.disclosureDue, "before this phone's first Live call")
        f.manager.acceptDisclosure()
        assertFalse(f.manager.disclosureDue)
        assertTrue(preferences.disclosureShown, "kept on this phone")
        assertFalse(Fixture(this, preferences).manager.disclosureDue, "a later launch does not ask again")
        assertFalse(Fixture(this, FakePreferences(disclosureShown = true)).manager.disclosureDue)
    }

    // ------------------------------------------------------------ failures and Try again

    @Test
    fun `a denied microphone ends the attempt with the settings hint, no Try again, and touches no media`() = runTest {
        val f = Fixture(this)
        f.manager.start("b1", "t1", "Ada", deny)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals(LiveCallRules.MIC_DENIED_MESSAGE, state.notice)
        assertFalse(state.canRetry, "a retry cannot help until the person changes the setting")
        assertEquals(0, f.transport.offers)
        assertTrue(f.audio.begins.isEmpty())
        assertTrue(f.api.starts.isEmpty())

        f.manager.retry(grant)
        runCurrent()
        assertTrue(f.api.starts.isEmpty(), "retry does nothing where Try again is not offered")
    }

    @Test
    fun `needsKey and a busy line end the attempt with the phone wording and no Try again`() = runTest {
        val f = Fixture(this)
        f.api.answer = { LiveCallStart.NeedsKey("Add an OpenAI API key to use Live calls.") }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        assertEquals(LiveCallRules.NEEDS_KEY_MESSAGE, f.manager.state.value.notice)
        assertFalse(f.manager.state.value.canRetry)
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends)
        assertTrue(f.api.ends.isEmpty(), "nothing was started on the computer")

        f.manager.dismiss()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)

        f.api.answer = { LiveCallStart.Busy(call.copy(client = "desktop"), "busy") }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals("A Live call is already running from your computer. Hang up there first.", f.manager.state.value.notice)
        assertFalse(f.manager.state.value.canRetry, "the other device has to hang up first")
    }

    @Test
    fun `a refusal from the computer shows its own words and offers Try again`() = runTest {
        val f = Fixture(this)
        f.api.answer = { throw APIError.Status(502, "OpenAI refused the call (HTTP 401).") }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        assertEquals("OpenAI refused the call (HTTP 401).", f.manager.state.value.notice)
        assertTrue(f.manager.state.value.canRetry)

        f.manager.dismiss()
        f.api.answer = { throw java.io.IOException() }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(LiveCallRules.START_FAILED_MESSAGE, f.manager.state.value.notice, "no words of its own: the generic line")
        assertTrue(f.manager.state.value.canRetry)
    }

    @Test
    fun `a transport that cannot build the offer shows the audio message, not its own words`() = runTest {
        val f = Fixture(this)
        f.transport.failOffer = IllegalStateException("createPeerConnection returned null")
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals(LiveCallRules.AUDIO_FAILED_MESSAGE, state.notice)
        assertTrue(state.canRetry)
        assertTrue(f.api.starts.isEmpty(), "no offer, nothing asked of the computer")
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends)
    }

    @Test
    fun `a rejected answer releases the call on the computer and offers Try again`() = runTest {
        val f = Fixture(this)
        f.transport.rejectAnswer = true
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals(LiveCallRules.AUDIO_FAILED_MESSAGE, state.notice)
        assertTrue(state.canRetry)
        assertEquals(listOf("c1"), f.api.ends)
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends)
    }

    @Test
    fun `start is ignored while a call is starting or running`() = runTest {
        val f = Fixture(this)
        f.manager.start("b1", "t1", "Ada", grant)
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(1, f.api.starts.size)
        f.manager.start("b2", "t2", "Bo", grant)
        runCurrent()
        assertEquals(1, f.api.starts.size)
        assertEquals("t1", f.manager.state.value.threadId)
    }

    @Test
    fun `retry starts again on the same chat`() = runTest {
        val f = Fixture(this)
        f.api.answer = { throw APIError.Status(502, "OpenAI refused the call (HTTP 500).") }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        f.api.answer = { LiveCallStart.Started(call, FakeApi.ANSWER) }
        f.manager.retry(grant)
        runCurrent()
        assertEquals(2, f.api.starts.size)
        assertEquals(Triple("b1", "t1", FakeTransport.OFFER), f.api.starts[1])
        assertEquals("c1", f.manager.state.value.callId)
        f.goLive()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
        f.manager.retry(grant)
        runCurrent()
        assertEquals(2, f.api.starts.size, "retry while live is a no-op")
    }

    // ------------------------------------------------------------ during the call

    @Test
    fun `captions come from the data channel`() = runTest {
        val f = Fixture(this).live()
        val listener = requireNotNull(f.transport.listener)
        listener.onMessage("""{"type":"session.input_transcript.delta","delta":"what time ","start_ms":1,"end_ms":2}""")
        listener.onMessage("""{"type":"session.input_transcript.delta","delta":"is it","start_ms":2,"end_ms":3}""")
        runCurrent()
        assertEquals("what time is it", f.manager.state.value.heard)
        assertEquals("", f.manager.state.value.caption)
        listener.onMessage("""{"type":"session.output_transcript.delta","delta":"It is noon.","start_ms":4,"end_ms":5}""")
        listener.onMessage("not json")
        runCurrent()
        assertEquals("It is noon.", f.manager.state.value.caption)
        assertEquals("", f.manager.state.value.heard)
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
    }

    @Test
    fun `speaker routes through the audio route and is remembered on this phone`() = runTest {
        val f = Fixture(this)
        f.manager.setSpeaker(false)
        assertTrue(f.audio.speakers.isEmpty(), "no call, no route to change")
        assertEquals(false, f.preferences.speaker, "kept on this phone, not only in memory")
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(listOf(false), f.audio.begins)
        f.goLive()
        f.manager.hangUp()
        runCurrent()
        assertEquals(false, f.manager.state.value.speaker, "the settings sheet still shows the earpiece after a hang-up")

        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(listOf(false, false), f.audio.begins)
        f.manager.setSpeaker(true)
        assertEquals(listOf(true), f.audio.speakers)
        assertTrue(f.manager.state.value.speaker)
        assertEquals(true, f.preferences.speaker)

        f.manager.setSpeaker(false)
        requireNotNull(f.transport.listener).onDropped()
        runCurrent()
        f.manager.dismiss()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        assertEquals(false, f.manager.state.value.speaker, "and after a dismissed notice")
    }

    @Test
    fun `the next launch starts from the speaker choice this phone remembered`() = runTest {
        val f = Fixture(this, FakePreferences(speaker = false))
        assertEquals(false, f.manager.state.value.speaker, "the settings sheet shows the remembered choice before any call")
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(listOf(false), f.audio.begins, "and the first call uses it")
    }

    @Test
    fun `a call that cannot take the audio from another call ends at once`() = runTest {
        val f = Fixture(this)
        f.audio.refuseFocus = true
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(LiveCallRules.FOCUS_LOST_MESSAGE, f.manager.state.value.notice)
        assertEquals(false, f.manager.state.value.holdsMedia)
    }

    @Test
    fun `losing the audio to another app ends the call`() = runTest {
        val f = Fixture(this).live()
        requireNotNull(f.audio.onFocusLost).invoke()
        runCurrent()
        assertEquals(LiveCallRules.FOCUS_LOST_MESSAGE, f.manager.state.value.notice)
        assertEquals(listOf("c1"), f.api.ends)
    }

    // ------------------------------------------------------------ hanging up

    @Test
    fun `mute flips the track, and hang up says Hanging up until the computer confirms the end`() = runTest {
        val f = Fixture(this).live()
        f.manager.setMuted(true)
        assertEquals(true, f.transport.muted)
        assertTrue(f.manager.state.value.muted)

        val answer = CompletableDeferred<Unit>()
        f.api.endGate = answer
        f.manager.hangUp()
        var state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDING, state.phase, "the bar says Hanging up… until the computer answers")
        assertEquals("c1", state.callId)
        assertEquals(1, f.transport.closeSent, "OpenAI is told at once")
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends, "the microphone and the audio route are free at once")
        runCurrent()
        assertEquals(listOf("c1"), f.api.ends)
        assertEquals(LiveCallPhase.ENDING, f.manager.state.value.phase)

        f.manager.hangUp()
        runCurrent()
        assertEquals(listOf("c1"), f.api.ends, "a second hang up does nothing")

        answer.complete(Unit)
        runCurrent()
        state = f.manager.state.value
        assertEquals(LiveCallPhase.IDLE, state.phase, "the computer answered: the bar goes")
        assertEquals("c1", state.callId, "the computer's ending echo of c1 still reads as this phone's")
        assertNull(state.notice)
    }

    @Test
    fun `the computer's ended frame confirms a hang-up too`() = runTest {
        val f = Fixture(this).live()
        f.api.endGate = CompletableDeferred()
        f.manager.hangUp()
        runCurrent()
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDING)
        runCurrent()
        assertEquals(LiveCallPhase.ENDING, f.manager.state.value.phase, "ending is not ended")
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "hung-up")
        runCurrent()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        assertNull(f.manager.state.value.notice, "a hang-up the person asked for needs no notice")
    }

    @Test
    fun `a hang-up the computer never answers stops saying Hanging up after 8 s`() = runTest {
        assertEquals(8_000L, LiveCallManager.END_TIMEOUT_MS)
        val f = Fixture(this).live()
        f.api.endGate = CompletableDeferred()
        f.manager.hangUp()
        runCurrent()
        advanceTimeBy(LiveCallManager.END_TIMEOUT_MS - 1)
        runCurrent()
        assertEquals(LiveCallPhase.ENDING, f.manager.state.value.phase)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        assertEquals("c1", f.manager.state.value.callId)
    }

    @Test
    fun `hanging up before the computer named the call leaves at once`() = runTest {
        val f = Fixture(this)
        val gate = CompletableDeferred<Unit>()
        f.api.gate = gate
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(1, f.api.starts.size, "the offer is on its way to the computer")

        f.manager.hangUp()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase, "nothing on the computer to wait for")
        assertEquals(1, f.transport.closes)

        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("c1"), f.api.ends, "the 201 landed on a phone that had given up")
        assertNull(f.transport.accepted)
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        assertEquals("c1", f.manager.state.value.callId)
    }

    @Test
    fun `hanging up while Connecting after the 201 says Hanging up too`() = runTest {
        val f = Fixture(this)
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals("c1", f.manager.state.value.callId)
        f.api.endGate = CompletableDeferred()
        f.manager.hangUp()
        assertEquals(LiveCallPhase.ENDING, f.manager.state.value.phase)
        runCurrent()
        assertEquals(listOf("c1"), f.api.ends)
    }

    @Test
    fun `hanging up while the offer is being built ends quietly`() = runTest {
        val f = Fixture(this)
        val gate = CompletableDeferred<Unit>()
        f.transport.offerGate = gate
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(1, f.transport.offers, "the offer is being built")

        f.manager.hangUp()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        assertEquals(1, f.transport.closes)

        // The closed transport's offer then fails, as the real one does.
        gate.complete(Unit)
        runCurrent()
        assertTrue(f.api.starts.isEmpty(), "nothing reached the computer")
        assertNull(f.transport.accepted)
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        assertNull(f.manager.state.value.notice, "the transport's own error is not shown")
    }

    @Test
    fun `a 409 naming this phone's own ending call says so, not another phone`() = runTest {
        val f = Fixture(this).live()
        f.manager.hangUp()
        runCurrent()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        // Tapped again while the computer still winds c1 down.
        f.api.answer = { LiveCallStart.Busy(call.copy(status = LiveCallStatus.ENDING), "busy") }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        assertEquals(LiveCallRules.LAST_CALL_ENDING, f.manager.state.value.notice)
        assertTrue(f.manager.state.value.canRetry, "in a moment it will work")
        assertEquals("c1", f.manager.state.value.callId, "its echo still reads as this phone's call")

        f.manager.retry(grant)
        runCurrent()
        assertEquals(LiveCallRules.LAST_CALL_ENDING, f.manager.state.value.notice, "and again on Try again")

        f.api.answer = { LiveCallStart.Busy(call.copy(callId = "c2", client = "ios", status = LiveCallStatus.LIVE), "busy") }
        f.manager.retry(grant)
        runCurrent()
        assertEquals("A Live call is already running from an iPhone. Hang up there first.", f.manager.state.value.notice)
        assertFalse(f.manager.state.value.canRetry)
    }

    // ------------------------------------------------------------ the computer ends it

    @Test
    fun `a server frame ending our call drops the media and says why`() = runTest {
        val f = Fixture(this).live()
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "sideband-lost")
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals("Call dropped.", state.notice)
        assertTrue(state.canRetry)
        assertEquals(1, f.transport.closeSent, "the harness cannot close OpenAI without its sideband; the phone does")
        assertEquals(1, f.transport.closes)
        assertTrue(f.api.ends.isEmpty(), "the computer already knows")
    }

    @Test
    fun `a call the computer ended because this phone was signed out offers no Try again`() = runTest {
        val f = Fixture(this).live()
        val unpaired = "The call has ended because the phone that started it was unpaired from this computer."
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "signed-out", error = unpaired)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals(unpaired, state.notice, "the computer's own words first")
        assertFalse(state.canRetry, "a new call would be refused the same way")
    }

    @Test
    fun `the computer's own error text wins over the generic reason`() = runTest {
        val f = Fixture(this).live()
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "error", error = "OpenAI closed the session.")
        runCurrent()
        assertEquals("OpenAI closed the session.", f.manager.state.value.notice)
    }

    @Test
    fun `frames about other calls are ignored`() = runTest {
        val f = Fixture(this).live()
        f.api.serverCall.value = LiveCallState("other", "b9", "t9", "desktop", "marin", 1.0, LiveCallStatus.ENDED, endReason = "hung-up")
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
        assertEquals(0, f.transport.closes)
    }

    @Test
    fun `a line that empties after the computer reported our call ends it, but a null before the first report does not`() = runTest {
        val f = Fixture(this)
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        requireNotNull(f.transport.listener).onChannelOpen()
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase, "the empty line from before the call is not news about it")

        f.api.serverCall.value = call.copy(status = LiveCallStatus.LIVE)
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
        f.api.serverCall.value = null
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        assertEquals(LiveCallRules.CALL_ENDED, f.manager.state.value.notice, "the desktop's and the iPhone's words for a call that is gone")
        assertEquals(1, f.transport.closes)
        assertTrue(f.api.ends.isEmpty())
    }

    @Test
    fun `session closed on the data channel ends the call with OpenAI's reason`() = runTest {
        val f = Fixture(this).live()
        requireNotNull(f.transport.listener).onMessage("""{"type":"session.closed","reason":"expired","session":{"id":"s"}}""")
        runCurrent()
        assertEquals("Call ended: it reached OpenAI's time limit.", f.manager.state.value.notice)
        assertEquals(listOf("c1"), f.api.ends)
    }

    @Test
    fun `the computer's reason replaces a plain Call ended that the data channel brought first`() = runTest {
        val f = Fixture(this).live()
        // The idle hang-up: OpenAI closes on the computer's request, and the
        // phone's channel says so before the computer's frame gets there.
        requireNotNull(f.transport.listener).onMessage("""{"type":"session.closed","reason":"close_requested"}""")
        runCurrent()
        assertEquals(LiveCallRules.CALL_ENDED, f.manager.state.value.notice)

        f.api.serverCall.value = LiveCallState("other", "b9", "t9", "desktop", "marin", 1.0, LiveCallStatus.ENDED, endReason = "idle")
        runCurrent()
        assertEquals(LiveCallRules.CALL_ENDED, f.manager.state.value.notice, "another call's reason is not ours")

        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "idle")
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals("Call ended after a long silence.", state.notice)
        assertFalse(state.canRetry, "an end that is not a drop: the phone button starts the next call")

        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "idle", error = "The call connection to OpenAI dropped.")
        runCurrent()
        assertEquals("Call ended after a long silence.", f.manager.state.value.notice, "only a plain Call ended is replaced")
    }

    @Test
    fun `the computer's error text replaces a plain Call ended`() = runTest {
        val f = Fixture(this).live()
        requireNotNull(f.transport.listener).onMessage("""{"type":"session.closed"}""")
        runCurrent()
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "sideband-lost", error = "The call connection to OpenAI dropped.")
        runCurrent()
        assertEquals("The call connection to OpenAI dropped.", f.manager.state.value.notice)
    }

    @Test
    fun `a drop the phone saw itself stays a drop`() = runTest {
        val f = Fixture(this).live()
        requireNotNull(f.transport.listener).onDropped()
        runCurrent()
        assertEquals(LiveCallRules.CALL_DROPPED, f.manager.state.value.notice)
        // The computer records the phone's own end request.
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "hung-up")
        runCurrent()
        assertEquals(LiveCallRules.CALL_DROPPED, f.manager.state.value.notice)
    }

    @Test
    fun `the transport dropping ends the call with Try again and tells the computer`() = runTest {
        val f = Fixture(this).live()
        requireNotNull(f.transport.listener).onDropped()
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        assertEquals("Call dropped.", f.manager.state.value.notice)
        assertTrue(f.manager.state.value.canRetry)
        assertEquals(1, f.transport.closeSent)
        assertEquals(listOf("c1"), f.api.ends)
    }

    @Test
    fun `a frame about our call that beats the 201 still counts`() = runTest {
        val f = Fixture(this)
        val gate = CompletableDeferred<Unit>()
        f.api.gate = gate
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        // A fast computer: the live frame lands before the 201 that names the call.
        f.api.serverCall.value = call.copy(status = LiveCallStatus.LIVE)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        requireNotNull(f.transport.listener).onChannelOpen()
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase, "the frame that came first still said attached")

        f.api.serverCall.value = null
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase, "the computer had reported the call, so no call now means it is gone")
        assertEquals(LiveCallRules.CALL_ENDED, f.manager.state.value.notice)
        assertTrue(f.api.ends.isEmpty())
    }

    @Test
    fun `an ended frame that beats the 201 ends the call before any audio`() = runTest {
        val f = Fixture(this)
        val gate = CompletableDeferred<Unit>()
        f.api.gate = gate
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = "idle")
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals("Call ended after a long silence.", state.notice)
        assertNull(f.transport.accepted, "no answer is applied to a call that is over")
        assertEquals(1, f.transport.closes)
        assertTrue(f.api.ends.isEmpty(), "the computer already knows")
    }

    @Test
    fun `a 201 that already reports the call ended never goes live`() = runTest {
        val f = Fixture(this)
        f.api.answer = {
            LiveCallStart.Started(
                call.copy(status = LiveCallStatus.ENDED, endReason = "sideband-lost", error = "The call could not connect to OpenAI."),
                FakeApi.ANSWER,
            )
        }
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals("The call could not connect to OpenAI.", state.notice)
        assertNull(f.transport.accepted)
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends)
        assertTrue(f.api.ends.isEmpty(), "the computer already ended it")
    }

    /**
     * Try again as on the desktop (`canRetry: notice.dropped`) and the spec:
     * only a dropped call and a failed start offer it. An end that is not a
     * drop offers only the cross, whatever words it carries.
     */
    @Test
    fun `Try again only after a drop or a failed start, as on the desktop`() = runTest {
        val words = "The computer's own words."
        for (reason in listOf("hung-up", "idle", "expired", "content", "deleted", "shutdown", "signed-out", "a-reason-from-a-newer-computer", null)) {
            for (error in listOf(null, words)) {
                val f = Fixture(this).live()
                f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = reason, error = error)
                runCurrent()
                assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
                assertFalse(f.manager.state.value.canRetry, "$reason, words: $error")
            }
        }
        for (reason in listOf("remote-hangup", "connection-lost", "sideband-lost", "error")) {
            for (error in listOf(null, words)) {
                val f = Fixture(this).live()
                f.api.serverCall.value = call.copy(status = LiveCallStatus.ENDED, endReason = reason, error = error)
                runCurrent()
                assertTrue(f.manager.state.value.canRetry, "$reason, words: $error")
            }
        }
    }

    @Test
    fun `the phone's own ends offer Try again only when they are drops`() = runTest {
        // OpenAI closing on the data channel: its own reason decides.
        for ((reason, dropped) in listOf("expired" to false, "close_requested" to false, "remote_hangup" to true, "connection_lost" to true)) {
            val f = Fixture(this).live()
            requireNotNull(f.transport.listener).onMessage("""{"type":"session.closed","reason":"$reason"}""")
            runCurrent()
            assertEquals(dropped, f.manager.state.value.canRetry, reason)
        }
        // The computer no longer reports the call: "Call ended.", not a drop.
        val gone = Fixture(this).live()
        gone.api.serverCall.value = null
        runCurrent()
        assertEquals(LiveCallRules.CALL_ENDED, gone.manager.state.value.notice)
        assertFalse(gone.manager.state.value.canRetry)
        // Another app took the audio: the call ended, it did not drop.
        val focus = Fixture(this).live()
        requireNotNull(focus.audio.onFocusLost).invoke()
        runCurrent()
        assertEquals(LiveCallRules.FOCUS_LOST_MESSAGE, focus.manager.state.value.notice)
        assertFalse(focus.manager.state.value.canRetry)
        // The transport dropping and audio that never connects are drops.
        val dropped = Fixture(this).live()
        requireNotNull(dropped.transport.listener).onDropped()
        runCurrent()
        assertTrue(dropped.manager.state.value.canRetry)
    }

    @Test
    fun `a 201 that already reports the call ended offers Try again only for a drop`() = runTest {
        for ((reason, retry) in listOf("sideband-lost" to true, "deleted" to false)) {
            val f = Fixture(this)
            f.api.answer = { LiveCallStart.Started(call.copy(status = LiveCallStatus.ENDED, endReason = reason), FakeApi.ANSWER) }
            f.manager.start("b1", "t1", "Ada", grant)
            runCurrent()
            assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
            assertEquals(retry, f.manager.state.value.canRetry, reason)
        }
    }

    // ------------------------------------------------------------ the audio deadline

    @Test
    fun `a call whose audio never connects drops after 20 s and tells the computer once`() = runTest {
        assertEquals(20_000L, LiveCallManager.MEDIA_CONNECT_TIMEOUT_MS)
        val f = Fixture(this).answered()
        advanceTimeBy(LiveCallManager.MEDIA_CONNECT_TIMEOUT_MS - 1)
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase, "not a moment early")
        assertTrue(f.api.ends.isEmpty())

        advanceTimeBy(1)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase, "the bar stays up with the reason and Try again")
        assertEquals("Call dropped: the audio could not connect.", state.notice)
        assertTrue(state.canRetry)
        assertEquals(1, f.transport.closeSent, "session.close on the data channel, as a drop sends it")
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends)
        assertEquals(listOf("c1"), f.api.ends)

        advanceTimeBy(10 * 60_000L)
        runCurrent()
        assertEquals(listOf("c1"), f.api.ends, "one end request, however long the phone waits after")
        f.manager.retry(grant)
        runCurrent()
        assertEquals(2, f.api.starts.size, "Try again starts a fresh call")
        f.goLive()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
    }

    @Test
    fun `a call whose audio connects in time is not dropped`() = runTest {
        val f = Fixture(this).answered()
        advanceTimeBy(LiveCallManager.MEDIA_CONNECT_TIMEOUT_MS - 1)
        requireNotNull(f.transport.listener).onConnected()
        runCurrent()
        advanceTimeBy(10 * 60_000L)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.STARTING, state.phase)
        assertNull(state.notice)
        assertEquals(0, f.transport.closes)
        assertTrue(f.api.ends.isEmpty())
    }

    @Test
    fun `a channel that opens in time counts as audio that connected`() = runTest {
        val f = Fixture(this).answered()
        advanceTimeBy(LiveCallManager.MEDIA_CONNECT_TIMEOUT_MS - 1)
        requireNotNull(f.transport.listener).onChannelOpen()
        runCurrent()
        advanceTimeBy(10 * 60_000L)
        runCurrent()
        assertNull(f.manager.state.value.notice)
        assertTrue(f.api.ends.isEmpty())
    }

    @Test
    fun `hanging up before the deadline leaves no late drop`() = runTest {
        val f = Fixture(this).answered()
        advanceTimeBy(5_000)
        f.manager.hangUp()
        runCurrent()
        advanceTimeBy(10 * 60_000L)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.IDLE, state.phase, "no \"Call dropped\" over a call the person hung up")
        assertNull(state.notice)
        assertEquals(listOf("c1"), f.api.ends, "the hang-up's end request, and no second one")
        assertEquals(1, f.transport.closeSent)
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends)
    }

    @Test
    fun `an earlier call's deadline and peer never reach a later call`() = runTest {
        val f = Fixture(this).answered()
        val first = f.transport
        advanceTimeBy(5_000)
        f.manager.hangUp()
        runCurrent()
        f.api.answer = { LiveCallStart.Started(call.copy(callId = "c2"), FakeApi.ANSWER) }
        f.answered()
        assertNotSame(first, f.transport, "a fresh transport for the second call")

        // The first call's peer, late: a connect, an open channel, a drop and a close, all about that call.
        val stale = requireNotNull(first.listener)
        stale.onConnected()
        stale.onChannelOpen()
        stale.onDropped()
        stale.onMessage("""{"type":"session.closed","reason":"expired","session":{"id":"s"}}""")
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase)
        assertEquals("c2", f.manager.state.value.callId)

        // 20 s: the first call's deadline, had it outlived the hang-up.
        advanceTimeBy(LiveCallManager.MEDIA_CONNECT_TIMEOUT_MS - 5_000)
        runCurrent()
        assertEquals(LiveCallPhase.STARTING, f.manager.state.value.phase)
        assertEquals(listOf("c1"), f.api.ends)

        // 25 s: the second call's own, 20 s after its answer; the stale connect did not clear it.
        advanceTimeBy(5_000)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals(LiveCallRules.AUDIO_TIMEOUT_MESSAGE, state.notice)
        assertEquals(listOf("c1", "c2"), f.api.ends)
    }

    // ------------------------------------------------------------ lifecycle, sign-out, another computer

    @Test
    fun `only the process lifecycle ends the call`() = runTest {
        val f = Fixture(this)
        val owner = TestOwner()
        owner.registry.addObserver(f.manager)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        f.live()

        // An Activity pause (a dialog, a rotation in progress) is not leaving the app.
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        assertEquals(LiveCallRules.CALL_ENDED, f.manager.state.value.notice)
        assertFalse(f.manager.state.value.canRetry, "leaving the app is not a drop")
        assertEquals(1, f.transport.closeSent)
        assertEquals(listOf("c1"), f.api.ends)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase, "coming back does not restart a call on its own")
    }

    @Test
    fun `a microphone answer for an attempt that already ended starts nothing`() = runTest {
        val f = Fixture(this)
        val answers = mutableListOf<(Boolean) -> Unit>()
        val sheet = MicrophoneAccess { answers += it }
        f.manager.start("b1", "t1", "Ada", sheet)
        // The system sheet is still up when the app leaves the foreground.
        f.manager.onStop(TestOwner())
        answers[0](true)
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase, "coming back does not restart a call on its own")
        assertEquals(LiveCallRules.CALL_ENDED, f.manager.state.value.notice)
        assertTrue(f.api.starts.isEmpty())

        // "Call ended." offers no Try again: the phone button starts anew.
        f.manager.dismiss()
        f.manager.start("b1", "t1", "Ada", sheet)
        answers[0](true)
        runCurrent()
        assertTrue(f.api.starts.isEmpty(), "only the attempt that asked may connect")
        answers[1](true)
        runCurrent()
        assertEquals(1, f.api.starts.size)
        assertEquals("c1", f.manager.state.value.callId)
    }

    @Test
    fun `losing the pairing hangs up at once and says why, without Try again`() = runTest {
        val f = Fixture(this).live()
        f.api.link.value = LiveCallLink(computerId = "computer-1", signedIn = false)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.ENDED, state.phase)
        assertEquals(LiveCallRules.SIGNED_OUT_MESSAGE, state.notice)
        assertFalse(state.canRetry, "a new call would be refused the same way")
        assertEquals(1, f.transport.closeSent, "OpenAI is told at once: the computer may no longer hear this phone")
        assertEquals(1, f.transport.closes)
        assertEquals(1, f.audio.ends)
        assertEquals(listOf("c1"), f.api.ends, "and the computer, in case it still does")
    }

    @Test
    fun `losing the pairing while the call starts hangs up too, and ends what the computer made`() = runTest {
        val f = Fixture(this)
        val gate = CompletableDeferred<Unit>()
        f.api.gate = gate
        f.manager.start("b1", "t1", "Ada", grant)
        runCurrent()
        f.api.link.value = LiveCallLink(computerId = null, signedIn = false)
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        assertEquals(LiveCallRules.SIGNED_OUT_MESSAGE, f.manager.state.value.notice)
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("c1"), f.api.ends)
        assertNull(f.transport.accepted)
    }

    @Test
    fun `switching to another computer drops this phone's call without a notice`() = runTest {
        val f = Fixture(this).live()
        f.api.link.value = LiveCallLink(computerId = "computer-2", signedIn = true)
        runCurrent()
        val state = f.manager.state.value
        assertEquals(LiveCallPhase.IDLE, state.phase, "a deliberate switch leaves no bar")
        assertNull(state.notice)
        assertNull(state.callId, "that id belongs to the other computer")
        assertEquals(1, f.transport.closeSent)
        assertEquals(1, f.audio.ends)
        assertTrue(f.api.ends.isEmpty(), "the new computer is not asked to end the old one's call")
    }

    @Test
    fun `a switch clears the notice the emptied line left first`() = runTest {
        val f = Fixture(this).live()
        // The switch resets the line before it names the new computer.
        f.api.serverCall.value = null
        runCurrent()
        assertEquals(LiveCallPhase.ENDED, f.manager.state.value.phase)
        f.api.link.value = LiveCallLink(computerId = "computer-2", signedIn = true)
        runCurrent()
        assertEquals(LiveCallPhase.IDLE, f.manager.state.value.phase)
        assertNull(f.manager.state.value.notice)
    }

    @Test
    fun `a reconnect to the same computer is not a switch`() = runTest {
        val f = Fixture(this).live()
        f.api.link.value = LiveCallLink(computerId = "computer-1", signedIn = true)
        runCurrent()
        assertEquals(LiveCallPhase.LIVE, f.manager.state.value.phase)
        assertEquals(0, f.transport.closes)
    }

    // ------------------------------------------------------------ fixtures

    /**
     * The manager runs on [TestScope.backgroundScope]: its collectors of the
     * computer's frames and of the pairing never complete, and `runTest`
     * would otherwise wait for them. The background scope shares the test
     * scheduler, so `runCurrent()` still drives the manager, and its clock is
     * the scheduler's.
     *
     * One transport is one call, as in production: [transport] is the one
     * the next call gets (so a test can set it up first), and a call after
     * that one gets a fresh transport, which [transport] then names.
     */
    private class Fixture(scope: TestScope, val preferences: FakePreferences = FakePreferences()) {
        val api = FakeApi()
        var transport = FakeTransport()
            private set
        val audio = FakeAudio()
        val manager = LiveCallManager(
            api = api,
            scope = scope.backgroundScope,
            transports = {
                if (transport.offers > 0) transport = FakeTransport()
                transport
            },
            audio = audio,
            preferences = preferences,
            clock = { scope.testScheduler.currentTime },
        )
        private val testScope = scope

        init {
            testScope.runCurrent()
        }

        /** Started and answered: the computer named the call, which is still connecting. */
        fun answered(): Fixture {
            manager.start("b1", "t1", "Ada", MicrophoneAccess { it(true) })
            testScope.runCurrent()
            check(manager.state.value.phase == LiveCallPhase.STARTING && manager.state.value.callId != null) {
                "fixture was not answered: ${manager.state.value}"
            }
            return this
        }

        /** The computer reports the call attached and the data channel opens. */
        fun goLive(): Fixture {
            val callId = checkNotNull(manager.state.value.callId) { "no call to go live: ${manager.state.value}" }
            api.serverCall.value = LiveCallState(callId, "b1", "t1", "android", "marin", 5_000.0, LiveCallStatus.LIVE)
            requireNotNull(transport.listener).onChannelOpen()
            testScope.runCurrent()
            check(manager.state.value.phase == LiveCallPhase.LIVE) { "fixture did not go live: ${manager.state.value}" }
            return this
        }

        fun live(): Fixture = answered().goLive()
    }

    private class FakePreferences(
        override var speaker: Boolean = true,
        override var disclosureShown: Boolean = false,
    ) : LiveCallPreferences

    private class FakeTransport : LiveCallTransport {
        var listener: LiveCallTransport.Listener? = null
        var accepted: String? = null
        var rejectAnswer = false
        var muted: Boolean? = null
        var offers = 0
        var closeSent = 0
        var closes = 0
        var offerGate: CompletableDeferred<Unit>? = null
        var failOffer: Exception? = null

        override suspend fun offer(listener: LiveCallTransport.Listener): String {
            offers += 1
            this.listener = listener
            offerGate?.await()
            // The transport's contract: closed while the offer was pending, it throws.
            if (closes > 0) throw IllegalStateException("transport closed")
            failOffer?.let { throw it }
            return OFFER
        }

        override suspend fun accept(answerSdp: String) {
            if (closes > 0) throw IllegalStateException("closed")
            if (rejectAnswer) throw IllegalStateException("setDescription failed: Failed to set remote answer sdp")
            accepted = answerSdp
        }

        override fun setMuted(muted: Boolean) {
            this.muted = muted
        }

        override fun sendClose() {
            closeSent += 1
        }

        override fun close() {
            closes += 1
        }

        companion object {
            const val OFFER = "v=0\r\noffer\r\n"
        }
    }

    private class FakeApi : LiveCallApi {
        val starts = mutableListOf<Triple<String, String, String>>()
        val ends = mutableListOf<String>()
        var gate: CompletableDeferred<Unit>? = null
        /** Holds the computer's answer to a hang-up until the test lets it go. */
        var endGate: CompletableDeferred<Unit>? = null
        var answer: () -> LiveCallStart = {
            LiveCallStart.Started(
                LiveCallState("c1", "b1", "t1", "android", "marin", 5_000.0, LiveCallStatus.CONNECTING),
                ANSWER,
            )
        }
        override val serverCall = MutableStateFlow<LiveCallState?>(null)
        override val link = MutableStateFlow(LiveCallLink(computerId = "computer-1", signedIn = true))

        override suspend fun start(botId: String, threadId: String, sdp: String): LiveCallStart {
            starts += Triple(botId, threadId, sdp)
            gate?.await()
            return answer()
        }

        override suspend fun end(callId: String) {
            ends += callId
            endGate?.await()
        }

        companion object {
            const val ANSWER = "v=0\r\nanswer\r\n"
        }
    }

    private class FakeAudio : LiveCallAudioRoute {
        val begins = mutableListOf<Boolean>()
        val speakers = mutableListOf<Boolean>()
        var ends = 0
        var onFocusLost: (() -> Unit)? = null
        /** Another call holds the audio: focus is refused as the call begins. */
        var refuseFocus = false

        override fun begin(speaker: Boolean, onFocusLost: () -> Unit) {
            begins += speaker
            this.onFocusLost = onFocusLost
            if (refuseFocus) onFocusLost()
        }

        override fun setSpeaker(speaker: Boolean) {
            speakers += speaker
        }

        override fun end() {
            ends += 1
        }
    }

    private class TestOwner : LifecycleOwner {
        val registry = LifecycleRegistry.createUnsafe(this)
        override val lifecycle: Lifecycle get() = registry
    }
}
