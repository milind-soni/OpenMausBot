package com.openmausbot.companion.ui

import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.audio.LiveCallSnapshot
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The bar's wording and clock, pinned to the spec's copy, the desktop's
 * `liveCallBarView` and its words (`src/locales/en.json`), and the shared
 * contract rulings.
 */
class LiveCallRulesTest {
    private val call = LiveCallState("c1", "b1", "t1", "desktop", "marin", 60_000.0, LiveCallStatus.LIVE)

    @Test
    fun elapsedCountsFromTheStart() {
        assertEquals("0:00", LiveCallRules.elapsed(60_000, 60_000))
        assertEquals("1:05", LiveCallRules.elapsed(1_000, 66_000))
        assertEquals("0:00", LiveCallRules.elapsed(90_000, 60_000), "a phone clock behind the computer's never shows a minus")
        assertEquals("1:00:07", LiveCallRules.elapsed(0, 3_607_000))
    }

    @Test
    fun theClockKeepsWesternDigitsWhateverTheDevicesLanguage() {
        val saved = Locale.getDefault()
        try {
            // Arabic formats %d with Arabic-Indic digits by default.
            Locale.setDefault(Locale.forLanguageTag("ar"))
            assertEquals("1:05", LiveCallRules.elapsed(1_000, 66_000))
            assertEquals("1:00:07", LiveCallRules.elapsed(0, 3_607_000))
        } finally {
            Locale.setDefault(saved)
        }
    }

    @Test
    fun theTitleReadsLiveWithTheBotAndTheClock() {
        assertEquals("Live with Ada · 1:05", LiveCallRules.title("Ada", "1:05"))
        // The bars draw it in two parts, so that a long name gives way and the clock does not.
        assertEquals("Live with Ada", LiveCallRules.liveWith("Ada"))
        assertEquals(" · 1:05", LiveCallRules.clockSuffix("1:05"))
    }

    /**
     * The remote bar's second line: where the call is, in the desktop's words
     * for the same bar ("Pepper is on a Live call from an iPhone",
     * `call.live.onPhone`) and the iPhone's.
     */
    @Test
    fun aRemoteBarSaysWhereTheCallIsFrom() {
        assertEquals("From your computer", LiveCallRules.fromDevice("desktop"))
        assertEquals("From an iPhone", LiveCallRules.fromDevice("ios"))
        assertEquals("From another phone", LiveCallRules.fromDevice("android"))
        assertEquals("From another device", LiveCallRules.fromDevice("fridge"))
    }

    @Test
    fun busyNamesTheDeviceOnTheLine() {
        assertEquals(
            "A Live call is already running from your computer. Hang up there first.",
            LiveCallRules.busyMessage(call),
        )
        assertEquals(
            "A Live call is already running from an iPhone. Hang up there first.",
            LiveCallRules.busyMessage(call.copy(client = "ios")),
        )
        assertEquals("another phone", LiveCallRules.clientLabel("android"))
        assertEquals("another device", LiveCallRules.clientLabel("fridge"))
    }

    /**
     * The desktop's `endNotice` (`src/lib/live-call-media.ts`) with its English
     * words (`src/locales/en.json`, `call.live.*`), for every `LiveEndReason`,
     * and OpenAI's own `session.closed` spellings mapped the way the harness
     * maps them (`CLOSE_REASONS`).
     */
    @Test
    fun endReasonsReadAsTheDesktopWordsThem() {
        val table = mapOf(
            "idle" to LiveCallRules.EndNotice("Call ended after a long silence.", dropped = false),
            "expired" to LiveCallRules.EndNotice("Call ended: it reached OpenAI's time limit.", dropped = false),
            "content" to LiveCallRules.EndNotice("OpenAI ended the call under its content rules.", dropped = false),
            "deleted" to LiveCallRules.EndNotice("Call ended: the chat was deleted.", dropped = false),
            "shutdown" to LiveCallRules.EndNotice("Call ended: OpenMausBot restarted.", dropped = false),
            "signed-out" to LiveCallRules.EndNotice("Call ended: you were signed out.", dropped = false),
            "remote-hangup" to LiveCallRules.EndNotice("Call dropped.", dropped = true),
            "connection-lost" to LiveCallRules.EndNotice("Call dropped.", dropped = true),
            "sideband-lost" to LiveCallRules.EndNotice("Call dropped.", dropped = true),
            "error" to LiveCallRules.EndNotice("Call dropped.", dropped = true),
            "hung-up" to LiveCallRules.EndNotice("Call ended.", dropped = false),
            // OpenAI's spellings, on the phone's own data channel.
            "remote_hangup" to LiveCallRules.EndNotice("Call dropped.", dropped = true),
            "connection_lost" to LiveCallRules.EndNotice("Call dropped.", dropped = true),
            "close_requested" to LiveCallRules.EndNotice("Call ended.", dropped = false),
            "something-new" to LiveCallRules.EndNotice("Call ended.", dropped = false),
        )
        table.forEach { (reason, notice) -> assertEquals(notice, LiveCallRules.endNotice(reason), reason) }
        assertEquals(LiveCallRules.EndNotice("Call ended.", dropped = false), LiveCallRules.endNotice(null))
        assertEquals("Call ended.", LiveCallRules.CALL_ENDED)
        assertEquals("Call dropped.", LiveCallRules.CALL_DROPPED)
        assertEquals("Call dropped: the audio could not connect.", LiveCallRules.AUDIO_TIMEOUT_MESSAGE)
    }

    @Test
    fun liveCallWordsSayComputerNotMac() {
        val words = listOf(
            LiveCallRules.NEEDS_KEY_MESSAGE,
            LiveCallRules.LAST_CALL_ENDING,
            LiveCallRules.SIGNED_OUT_MESSAGE,
            LiveCallRules.DISCLOSURE,
            LiveCallRules.TYPED_REPLIES_FOOTER,
            LiveCallRules.clientLabel("desktop"),
            LiveCallRules.busyMessage(call),
        ) + listOf("idle", "expired", "content", "deleted", "shutdown", "error", null).map { LiveCallRules.endNotice(it).text }
        words.forEach { assertFalse(Regex("\\bMac\\b").containsMatchIn(it), "\"Mac\" in: $it") }
        assertEquals("Set up Live calls on your computer first.", LiveCallRules.NEEDS_KEY_MESSAGE)
        assertEquals("Your last call is still ending on your computer. Try again in a moment.", LiveCallRules.LAST_CALL_ENDING)
    }

    @Test
    fun losingThePairingReadsAsTheSignedOutEndReason() {
        assertEquals(LiveCallRules.endNotice("signed-out").text, LiveCallRules.SIGNED_OUT_MESSAGE)
    }

    @Test
    fun theTypedRepliesLineSaysWhatTurningItOffKeepsFromOpenAI() {
        assertEquals(
            "When this is off, messages you type during a call and the bot's answers to them are not sent to OpenAI.",
            LiveCallRules.TYPED_REPLIES_FOOTER,
        )
    }

    @Test
    fun idleChoicesAreTheSharedListAndKeepTheDesktopsValueVisible() {
        assertEquals(listOf(1, 2, 3, 5, 10, 15, 30, 60), LiveCallRules.IDLE_PRESETS, "the same minutes on every client")
        assertEquals(listOf(1, 2, 3, 5, 7, 10, 15, 30, 60), LiveCallRules.idleChoices(7))
        assertEquals(LiveCallRules.IDLE_PRESETS, LiveCallRules.idleChoices(5))
        assertEquals(LiveCallRules.IDLE_PRESETS, LiveCallRules.idleChoices(0), "out of range is not a choice")
    }

    @Test
    fun voicesMatchTheDesktopList() {
        assertEquals(22, LiveCallRules.VOICE_OPTIONS.size)
        assertEquals("marin", LiveCallRules.VOICE_OPTIONS.first().id)
        assertEquals("Marin (default)", LiveCallRules.voiceLabel(""))
        assertEquals("Cedar", LiveCallRules.voiceLabel("cedar"))
        assertEquals("nova", LiveCallRules.voiceLabel("nova"), "a voice the list lacks is shown by id, not hidden")
    }

    @Test
    fun thisPhonesCallWinsTheBarAndItsClockCountsFromGoingLive() {
        val local = LiveCallSnapshot(
            phase = LiveCallPhase.LIVE, botId = "b1", threadId = "t1", botName = "Ada", callId = "c9",
            liveSince = 1_000, caption = "Hello there", heard = "hi", muted = true,
        )
        assertEquals(
            LiveCallBarModel.Local("Live with Ada", "Hello there", "hi", muted = true, speaker = true, phase = LiveCallPhase.LIVE, clock = "1:05"),
            LiveCallRules.barModel(local, call, "t1", "Ada", 66_000),
            "from liveSince on this phone's clock, not the computer's startedAt",
        )
    }

    @Test
    fun hangingUpSaysSoUntilTheComputerConfirms() {
        val ending = LiveCallSnapshot(phase = LiveCallPhase.ENDING, botId = "b1", threadId = "t1", botName = "Ada", callId = "c9")
        val bar = LiveCallRules.barModel(ending, call.copy(callId = "c9", status = LiveCallStatus.ENDING), "t1", "Ada", 0)
        assertEquals("Hanging up…", (bar as LiveCallBarModel.Local).title)
        assertEquals(LiveCallPhase.ENDING, bar.phase)
    }

    @Test
    fun aCallFromAnotherDeviceShowsAsRemoteOnItsChatOnly() {
        assertEquals(
            LiveCallBarModel.Remote("Live with Ada", "1:05", "From your computer", "c1"),
            LiveCallRules.barModel(LiveCallSnapshot(), call, "t1", "Ada", 125_000),
        )
        assertEquals(LiveCallBarModel.Hidden, LiveCallRules.barModel(LiveCallSnapshot(), call, "other", "Bo", 125_000))
        assertEquals(
            LiveCallBarModel.Hidden,
            LiveCallRules.barModel(LiveCallSnapshot(), call.copy(status = LiveCallStatus.ENDED), "t1", "Ada", 125_000),
        )
        assertEquals(LiveCallBarModel.Hidden, LiveCallRules.barModel(LiveCallSnapshot(), null, "t1", "Ada", 125_000))
    }

    @Test
    fun thePhoneButtonHidesWheneverACallCouldNotStart() {
        val idle = LiveCallSnapshot()
        assertTrue(LiveCallRules.offersCall(idle, null))
        assertTrue(LiveCallRules.offersCall(idle, call.copy(status = LiveCallStatus.ENDED)), "an ended call frees the line")
        assertFalse(LiveCallRules.offersCall(idle, call), "another device is on the line: it has to hang up first")
        assertFalse(LiveCallRules.offersCall(idle, call.copy(status = LiveCallStatus.ENDING)), "the line is still winding down")
        assertFalse(LiveCallRules.offersCall(idle, call.copy(status = LiveCallStatus.UNKNOWN)))
        listOf(LiveCallPhase.STARTING, LiveCallPhase.LIVE, LiveCallPhase.ENDING).forEach { phase ->
            assertFalse(LiveCallRules.offersCall(LiveCallSnapshot(phase = phase, threadId = "t1"), null), "$phase: the bar has the controls")
        }
        assertTrue(
            LiveCallRules.offersCall(LiveCallSnapshot(phase = LiveCallPhase.ENDED, threadId = "t1", notice = "Call ended."), null),
            "after a call ends, a new one starts from the button too",
        )
    }

    @Test
    fun aCallThatIsEndingOnTheComputerShowsNoRemoteBar() {
        assertEquals(
            LiveCallBarModel.Hidden,
            LiveCallRules.barModel(LiveCallSnapshot(), call.copy(status = LiveCallStatus.ENDING), "t1", "Ada", 125_000),
            "a hang-up is briefly still ending on the computer after its own bar has gone",
        )
    }

    @Test
    fun aCallWithAStatusThisBuildDoesNotKnowStillShowsItsRemoteBar() {
        assertEquals(
            LiveCallBarModel.Remote("Live with Ada", "1:05", "From your computer", "c1"),
            LiveCallRules.barModel(LiveCallSnapshot(), call.copy(status = LiveCallStatus.UNKNOWN), "t1", "Ada", 125_000),
        )
    }

    @Test
    fun thisPhonesOwnCallIsNeverRemoteWhileTheMacWindsItDown() {
        // A hang-up or a dismiss leaves IDLE with the call's id; the Mac reports the call until OpenAI confirms the close.
        val hungUp = LiveCallSnapshot(callId = "c1")
        val ours = call.copy(client = "android")
        assertEquals(LiveCallBarModel.Hidden, LiveCallRules.barModel(hungUp, ours, "t1", "Ada", 125_000))
        assertEquals(
            LiveCallBarModel.Hidden,
            LiveCallRules.barModel(hungUp, ours.copy(status = LiveCallStatus.ENDING), "t1", "Ada", 125_000),
            "the Mac's `ending` echo of this phone's hang-up is not a call on another phone",
        )
        assertEquals(
            LiveCallBarModel.Remote("Live with Ada", "1:05", "From another phone", "c2"),
            LiveCallRules.barModel(hungUp, ours.copy(callId = "c2"), "t1", "Ada", 125_000),
            "a different call on the same chat is still another device's",
        )
    }

    @Test
    fun anEndedLocalCallKeepsTheBarWithItsNoticeAndStartingSaysConnecting() {
        val ended = LiveCallSnapshot(phase = LiveCallPhase.ENDED, botId = "b1", threadId = "t1", botName = "Ada", notice = "Call dropped.")
        val bar = LiveCallRules.barModel(ended, null, "t1", "Ada", 0) as LiveCallBarModel.Local
        assertEquals("Call dropped.", bar.title)
        assertEquals(LiveCallPhase.ENDED, bar.phase)
        assertTrue(bar.canRetry)
        val refused = ended.copy(notice = LiveCallRules.NEEDS_KEY_MESSAGE, canRetry = false)
        assertFalse((LiveCallRules.barModel(refused, null, "t1", "Ada", 0) as LiveCallBarModel.Local).canRetry, "no Try again where it cannot help")
        assertEquals(LiveCallBarModel.Hidden, LiveCallRules.barModel(ended, null, "other", "Bo", 0))
        val starting = LiveCallSnapshot(phase = LiveCallPhase.STARTING, botId = "b1", threadId = "t1", botName = "Ada")
        assertEquals("Connecting…", (LiveCallRules.barModel(starting, null, "t1", "Ada", 0) as LiveCallBarModel.Local).title)
    }
}
