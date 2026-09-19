package com.openmausbot.companion.ui

import com.openmausbot.companion.core.ConfigFlag
import com.openmausbot.companion.core.ConfigStatus
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.ToolActivity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The call loop's decisions, read off `react()` in `ios/App/CallView.swift`. */
class CallRulesTest {
    private fun text(id: String, role: Message.Role = Message.Role.BOT, body: String = "Done.") =
        Message(id = id, role = role, kind = Message.Kind.TEXT, at = 1.0, text = body)

    private fun chip(id: String, spoken: String?) =
        Message(id = id, role = Message.Role.BOT, kind = Message.Kind.ACTIVITY, at = 1.0, tool = ToolActivity("read", spoken = spoken))

    private fun card(id: String, requestId: String, tool: String?) =
        Message(id = id, role = Message.Role.BOT, kind = Message.Kind.OPTIONS, at = 1.0, card = OptionCard("Allow?", "", listOf("Allow", "Deny"), requestId = requestId, tool = tool))

    private fun react(
        fresh: List<Message> = emptyList(),
        pendingCard: Message? = null,
        announced: Set<String> = emptySet(),
        phase: CallPhase = CallPhase.WORKING,
        busy: Boolean = false,
        speakerSpeaking: Boolean = false,
    ) = CallRules.react("Scout", fresh, pendingCard, announced, phase, busy, speakerSpeaking)

    @Test
    fun `a pending card is announced once, and never over the bot's own voice`() {
        val permission = card("m1", "req-1", tool = "bash")
        assertEquals(
            CallAction.Announce("Scout is asking for permission. Open the chat to answer it."),
            react(pendingCard = permission, phase = CallPhase.LISTENING),
        )
        assertEquals(
            CallAction.Announce("Scout has a question. Open the chat to answer it."),
            react(pendingCard = card("m2", "req-2", tool = null), phase = CallPhase.WORKING),
        )
        assertEquals(CallAction.None, react(pendingCard = permission, announced = setOf("req-1"), phase = CallPhase.LISTENING))
        assertEquals(CallAction.None, react(pendingCard = permission, phase = CallPhase.SPEAKING))
    }

    @Test
    fun `a reply is read, the newest one, and never the person's own words`() {
        assertEquals(CallAction.SayReply("Second."), react(fresh = listOf(text("a", body = "First."), text("b", body = "Second."))))
        assertEquals(CallAction.None, react(fresh = listOf(text("u", role = Message.Role.USER, body = "hi")), busy = false, phase = CallPhase.LISTENING))
        assertEquals(CallAction.Listen, react(fresh = listOf(text("e", body = "   ")), phase = CallPhase.WORKING))
    }

    @Test
    fun `a spoken chip is narrated only while waiting`() {
        assertEquals(CallAction.SayChip("Reading the logs"), react(fresh = listOf(chip("c", "Reading the logs")), phase = CallPhase.WORKING, busy = true))
        assertEquals(CallAction.None, react(fresh = listOf(chip("c", null)), phase = CallPhase.WORKING, busy = true))
        assertEquals(CallAction.StopListeningAndWork, react(fresh = listOf(chip("c", "Reading")), phase = CallPhase.LISTENING, busy = true))
    }

    @Test
    fun `busy closes the microphone, idle reopens it once the speaker is quiet`() {
        assertEquals(CallAction.StopListeningAndWork, react(phase = CallPhase.LISTENING, busy = true))
        assertEquals(CallAction.StopListeningAndWork, react(phase = CallPhase.SENDING, busy = true))
        assertEquals(CallAction.None, react(phase = CallPhase.WORKING, busy = true))
        assertEquals(CallAction.Listen, react(phase = CallPhase.WORKING, busy = false))
        assertEquals(CallAction.Listen, react(phase = CallPhase.SENDING, busy = false))
        assertEquals(CallAction.None, react(phase = CallPhase.WORKING, busy = false, speakerSpeaking = true))
        assertEquals(CallAction.None, react(phase = CallPhase.LISTENING, busy = false))
    }

    @Test
    fun `the phase line and the notes read as the Swift's`() {
        assertEquals("Listening…", CallRules.phaseText(CallPhase.LISTENING, "Scout"))
        assertEquals("Scout is working…", CallRules.phaseText(CallPhase.WORKING, "Scout"))
        assertEquals("Set up a voice in Settings → Voice to hear Scout.", CallRules.noVoiceNote("Scout"))
        assertEquals(850L, CallRules.ENDPOINT_GAP_MILLIS)
    }

    @Test
    fun `voice settings offer the key only under ElevenLabs`() {
        val ready = ConfigStatus(tts = ConfigFlag(configured = true))
        val system = ConfigStatus(tts = ConfigFlag(configured = true, provider = "system"))
        assertEquals("Ready", VoiceSettingsRules.statusText(ready))
        assertEquals("Not set up", VoiceSettingsRules.statusText(ConfigStatus(tts = ConfigFlag(configured = false))))
        assertNull(VoiceSettingsRules.statusText(null))
        assertTrue(VoiceSettingsRules.showsKeyField(ready))
        assertTrue(VoiceSettingsRules.showsKeyField(null))
        assertFalse(VoiceSettingsRules.showsKeyField(system))
        assertEquals("Replace key", VoiceSettingsRules.saveLabel(ready))
        assertEquals("Save key", VoiceSettingsRules.saveLabel(null))
        assertTrue(VoiceSettingsRules.canSave("sk", saving = false))
        assertFalse(VoiceSettingsRules.canSave("  ", saving = false))
        assertFalse(VoiceSettingsRules.canSave("sk", saving = true))
        assertTrue(VoiceSettingsRules.canRemove(ready, saving = false))
        assertFalse(VoiceSettingsRules.canRemove(null, saving = false))
    }
}
