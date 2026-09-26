package com.openmausbot.companion.ui

import com.openmausbot.companion.core.AvatarCrop
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotOverviewGrant
import com.openmausbot.companion.core.BotOverviewGrantLevel
import com.openmausbot.companion.core.ConfigFlag
import com.openmausbot.companion.core.ConfigStatus
import com.openmausbot.companion.core.ModelSelection
import com.openmausbot.companion.core.Voice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * D2-04 / D2-05 / D2-06: what the profile sheet decides.
 *
 * Every expectation is read off `ios/App/AgentProfileView.swift` — the dirty
 * comparison at `:181-205`, the section gating at `:47-151`, and the load-time
 * correction in the view's `.task`. Nothing here is read back out of the Kotlin
 * it is testing.
 */
class ProfileRulesTest {

    @Test
    fun `an untouched form patches nothing`() {
        val bot = bot()
        val form = ProfileForm.of(bot)
        val patch = ProfileRules.patch(form, ProfileForm.of(bot), config = speaking())

        assertNull(patch.name)
        assertNull(patch.title)
        assertNull(patch.description)
        assertNull(patch.notifications)
        assertNull(patch.avatarCrop)
        assertNull(patch.voice)
        assertNull(patch.speakReplies)
        // The narrow contract owns avatarUrl; the form never sends one.
        assertNull(patch.avatarUrl)
    }

    @Test
    fun `only the changed fields travel, and they travel trimmed`() {
        val baseline = ProfileForm.of(bot())
        val form = baseline.copy(name = "  Scout II  ", notifications = false)
        val patch = ProfileRules.patch(form, baseline, config = speaking())

        assertEquals("Scout II", patch.name)
        assertEquals(false, patch.notifications)
        assertNull(patch.title)
        assertNull(patch.description)
    }

    @Test
    fun `a trailing space alone still counts as changed`() {
        // iOS compares `name == baseline.name` before trimming, so whitespace
        // makes the field dirty and sends a value identical to the baseline.
        // Mirrored deliberately rather than tidied.
        val baseline = ProfileForm.of(bot())
        val patch = ProfileRules.patch(baseline.copy(name = "Scout "), baseline, speaking())

        assertEquals("Scout", patch.name)
    }

    @Test
    fun `the server owns the length limits`() {
        val baseline = ProfileForm.of(bot())
        val long = "n".repeat(500)
        val patch = ProfileRules.patch(baseline.copy(name = long), baseline, speaking())

        assertEquals(long, patch.name, "100/200/4000 belong to the shared contract")
    }

    @Test
    fun `empty voice is a value, not an omission`() {
        // The server reads "" as "use the workspace default"; nil would mean the
        // voice is not part of this patch at all.
        val baseline = ProfileForm.of(bot().copy(voice = "voice-7"))
        val patch = ProfileRules.patch(baseline.copy(voice = ""), baseline, speaking())

        assertEquals("", patch.voice)
    }

    @Test
    fun `speak replies is saved off when the selection cannot speak`() {
        val baseline = ProfileForm.of(bot().copy(speakReplies = true))
        val form = baseline.copy(voice = "")
        // Key configured, no workspace default, no agent voice: nothing to speak.
        val patch = ProfileRules.patch(form, baseline, config = configuredWithoutDefault())

        assertEquals(false, patch.speakReplies)
    }

    @Test
    fun `speak replies is left as typed while the status is unknown`() {
        val baseline = ProfileForm.of(bot())
        val patch = ProfileRules.patch(baseline.copy(speakReplies = true), baseline, config = null)

        assertEquals(true, patch.speakReplies)
    }

    @Test
    fun `a stored speak replies nothing can voice is turned off on load`() {
        val form = ProfileForm.of(bot().copy(speakReplies = true))

        assertFalse(ProfileRules.applyLoadedConfig(form, configuredWithoutDefault()).speakReplies)
        assertTrue(ProfileRules.applyLoadedConfig(form, speaking()).speakReplies)
        assertTrue(ProfileRules.applyLoadedConfig(form, null).speakReplies, "unknown changes nothing")
    }

    @Test
    fun `provider switch clears stale voice from form and baseline`() {
        val stale = ProfileForm.of(
            bot().copy(voice = "elevenlabs-voice", speakReplies = true),
        )
        val fishWithoutDefault = ConfigStatus(
            tts = ConfigFlag(configured = true, ready = false, voice = "", provider = "fish"),
        )

        val (form, baseline) = ProfileRules.afterVoiceProviderSwitch(
            form = stale,
            baseline = stale,
            config = fishWithoutDefault,
        )

        assertEquals("", form.voice)
        assertEquals("", baseline.voice)
        assertFalse(form.speakReplies, "speech cannot stay enabled with no valid voice")
        assertTrue(
            baseline.speakReplies,
            "the unchanged server value remains the save baseline so Save persists the correction",
        )
    }

    @Test
    fun `saving needs a name that is more than whitespace`() {
        val form = ProfileForm.of(bot())

        assertTrue(ProfileRules.canSave(form, busy = false))
        assertFalse(ProfileRules.canSave(form, busy = true))
        assertFalse(ProfileRules.canSave(form.copy(name = "   "), busy = false))
    }

    @Test
    fun `generation needs a configured provider and something to ask for`() {
        val ready = ConfigStatus(imageGen = ConfigFlag(configured = true))
        val blocked = ConfigStatus(imageGen = ConfigFlag(configured = false))

        assertTrue(ProfileRules.canGenerate(busy = false, config = ready, prompt = "a fox"))
        assertFalse(ProfileRules.canGenerate(busy = true, config = ready, prompt = "a fox"))
        assertFalse(ProfileRules.canGenerate(busy = false, config = ready, prompt = "  "))
        assertFalse(ProfileRules.canGenerate(busy = false, config = blocked, prompt = "a fox"))
        assertFalse(ProfileRules.canGenerate(busy = false, config = null, prompt = "a fox"))
    }

    @Test
    fun `the art direction is trimmed and capped at 400`() {
        assertEquals("a fox", ProfileRules.generatePrompt("  a fox\n"))
        assertEquals(400, ProfileRules.generatePrompt("x".repeat(900)).length)
    }

    @Test
    fun `the generate footer says which computer holds the provider key`() {
        assertEquals(
            "Generation uses the shared image provider configured on your computer. " +
                "No provider key is sent to or stored on this phone.",
            ProfileRules.generateFooter(ConfigStatus(imageGen = ConfigFlag(configured = true))),
        )
        assertEquals(
            "To generate images, configure the shared image provider in OpenMausBot on your " +
                "computer. Provider keys cannot be added from a phone.",
            ProfileRules.generateFooter(null),
        )
    }

    @Test
    fun `what makes the chosen engine count as able to speak`() {
        assertFalse(ProfileRules.voiceConfigured(null))
        assertFalse(ProfileRules.voiceConfigured(ConfigStatus(tts = ConfigFlag(configured = false))))
        assertTrue(ProfileRules.voiceConfigured(ConfigStatus(tts = ConfigFlag(configured = true))))
        assertTrue(
            ProfileRules.voiceConfigured(
                ConfigStatus(tts = ConfigFlag(configured = false, apiKeyConfigured = true)),
            ),
            "the legacy key flag still answers for a desktop that only sends that one",
        )
        assertTrue(
            ProfileRules.voiceConfigured(
                ConfigStatus(tts = ConfigFlag(configured = true, provider = "system")),
            ),
            "under the built-in engine the same true means usable voices, and no key at all",
        )
    }

    @Test
    fun `the empty tag is only selectable when a workspace default exists`() {
        val withDefault = ProfileRules.voiceChoices(speaking(), voices(), voice = "")
        assertEquals("Workspace default", withDefault.first().label)
        assertTrue(withDefault.first().enabled)

        val without = ProfileRules.voiceChoices(configuredWithoutDefault(), voices(), voice = "")
        assertEquals("Choose an agent voice", without.first().label)
        assertFalse(without.first().enabled)
    }

    @Test
    fun `an agent voice the list does not carry keeps its own row`() {
        val choices = ProfileRules.voiceChoices(speaking(), voices(), voice = "retired-voice")

        assertEquals(
            listOf("", "retired-voice", "voice-1", "voice-2"),
            choices.map { it.id },
        )
        assertEquals("Current agent voice", choices[1].label)
        assertEquals("Warm", choices[2].detail)
        assertNull(choices[3].detail)
    }

    @Test
    fun `a listed agent voice does not get a duplicate row`() {
        val choices = ProfileRules.voiceChoices(speaking(), voices(), voice = "voice-2")

        assertEquals(listOf("", "voice-1", "voice-2"), choices.map { it.id })
    }

    @Test
    fun `speaking needs a key and something to speak with`() {
        assertFalse(ProfileRules.selectedVoiceCanSpeak(null, ""))
        assertFalse(ProfileRules.selectedVoiceCanSpeak(configuredWithoutDefault(), ""))
        assertTrue(ProfileRules.selectedVoiceCanSpeak(configuredWithoutDefault(), "voice-1"))
        assertTrue(ProfileRules.selectedVoiceCanSpeak(speaking(), ""))
        assertFalse(
            ProfileRules.selectedVoiceCanSpeak(
                ConfigStatus(tts = ConfigFlag(configured = false, voice = "shared")),
                "voice-1",
            ),
            "a default voice without a key still cannot speak",
        )
    }

    @Test
    fun `preview follows the same gate, plus busy`() {
        assertTrue(ProfileRules.canPreview(busy = false, config = speaking(), voice = ""))
        assertFalse(ProfileRules.canPreview(busy = true, config = speaking(), voice = ""))
        assertFalse(
            ProfileRules.canPreview(busy = false, config = configuredWithoutDefault(), voice = ""),
        )
    }

    @Test
    fun `the hint appears exactly when nothing can speak yet`() {
        assertEquals(
            "Pick a voice for this agent before enabling speech.",
            ProfileRules.pickAVoiceHint(configuredWithoutDefault(), ""),
        )
        assertNull(ProfileRules.pickAVoiceHint(configuredWithoutDefault(), "voice-1"))
        assertNull(ProfileRules.pickAVoiceHint(speaking(), ""))
    }

    @Test
    fun `each voice footer answers the state it belongs to`() {
        assertEquals(
            "Add the shared ElevenLabs key in this agent's profile on the computer. " +
                "The key is never returned to this phone.",
            ProfileRules.voiceCopy(null).footer,
        )
        assertEquals(
            "No workspace default voice is selected. Choose an agent-specific voice above; " +
                "synthesis still uses the shared ElevenLabs key on your computer.",
            ProfileRules.voiceCopy(configuredWithoutDefault()).footer,
        )
        assertEquals(
            "The voice choice belongs to this agent. Workspace default uses the shared voice " +
                "selected on your computer.",
            ProfileRules.voiceCopy(speaking()).footer,
        )
    }

    @Test
    fun `an absent provider leaves the ElevenLabs copy exactly as iOS ships it`() {
        // Spelled out rather than compared to the constants: this is the test
        // that must fail if the decode ever defaults to the built-in engine,
        // and comparing a constant to itself would survive that.
        val unconfigured = ConfigStatus(tts = ConfigFlag(configured = false))

        assertEquals(
            "ElevenLabs is not configured",
            ProfileRules.voiceCopy(unconfigured).unconfiguredNotice,
        )
        assertEquals(
            "Add the shared ElevenLabs key in this agent's profile on the computer. " +
                "The key is never returned to this phone.",
            ProfileRules.voiceCopy(unconfigured).footer,
        )
        assertEquals(
            "No workspace default voice is selected. Choose an agent-specific voice above; " +
                "synthesis still uses the shared ElevenLabs key on your computer.",
            ProfileRules.voiceCopy(configuredWithoutDefault()).footer,
        )
        assertEquals(
            "ElevenLabs is not configured",
            ProfileRules.voiceCopy(null).unconfiguredNotice,
            "an unloaded status says what it said before the field existed",
        )
        assertEquals(
            "ElevenLabs is not configured",
            ProfileRules.voiceCopy(
                ConfigStatus(tts = ConfigFlag(configured = false, provider = "azure")),
            ).unconfiguredNotice,
            "an unrecognised engine is not explained as the built-in one",
        )
    }

    @Test
    fun `the built-in provider is never explained as a missing key`() {
        val noVoices = ConfigStatus(tts = ConfigFlag(configured = false, provider = "system"))
        assertEquals(
            "Your computer's built-in voices are unavailable",
            ProfileRules.voiceCopy(noVoices).unconfiguredNotice,
        )
        assertEquals(
            "Your computer's built-in voices need no key, and it reports none it can use. " +
                "Switch the voice engine in OpenMausBot on the computer to turn speech back on.",
            ProfileRules.voiceCopy(noVoices).footer,
        )

        val noDefault =
            ConfigStatus(tts = ConfigFlag(configured = true, voice = "   ", provider = "system"))
        assertEquals(
            "No workspace default voice is selected. Choose an agent-specific voice above; " +
                "synthesis still uses your computer's built-in voices.",
            ProfileRules.voiceCopy(noDefault).footer,
        )

        val ready =
            ConfigStatus(tts = ConfigFlag(configured = true, voice = "Albert", provider = "system"))
        assertEquals(
            ProfileRules.voiceCopy(speaking()).footer,
            ProfileRules.voiceCopy(ready).footer,
            "this sentence names no engine, so both providers share it",
        )
        assertNull(
            ProfileRules.voiceCopy(ready).unconfiguredNotice,
            "a section that can speak has no notice, and so draws the picker",
        )

        // What the screen can actually be handed under this engine, rather than
        // the constants behind it: the strings are private precisely so that
        // these three calls are the only way to reach them.
        listOf(
            ProfileRules.voiceCopy(noVoices).unconfiguredNotice.orEmpty(),
            ProfileRules.voiceCopy(noVoices).footer,
            ProfileRules.voiceCopy(noDefault).footer,
        ).forEach {
            assertFalse(it.contains("ElevenLabs"), "the built-in engine's copy names no brand: $it")
        }
    }

    @Test
    fun `the provider-neutral sentences are shared, not duplicated`() {
        // Nothing about an engine or a credential appears in these, so a
        // provider-specific twin would be a second string to keep in sync for
        // no reason. Pinned so a future edit cannot quietly make one of them
        // provider-specific while the selector still hands it to both.
        listOf(
            ProfileRules.voiceCopy(speaking()).footer,
            ProfileRules.pickAVoiceHint(configuredWithoutDefault(), "").orEmpty(),
            ProfileRules.PREVIEW_REFUSED,
        ).forEach { assertFalse(it.contains("ElevenLabs"), "provider-neutral copy names no engine: $it") }

        val system =
            ConfigStatus(tts = ConfigFlag(configured = true, voice = "Albert", provider = "system"))
        val elevenlabs = ConfigStatus(tts = ConfigFlag(configured = true, voice = "shared-voice"))
        assertEquals(ProfileRules.voiceCopy(elevenlabs).footer, ProfileRules.voiceCopy(system).footer)
    }

    @Test
    fun `the engine picker lists what the desktop lists, in its order`() {
        val choices = ProfileRules.providerChoices()

        assertEquals(
            listOf("ElevenLabs", "Fish Audio", "Built-in Mac voices", "Chatterbox (local)"),
            choices.map { it.label },
        )
        assertEquals(
            listOf("elevenlabs", "fish", "system", "chatterbox"),
            choices.map { it.id },
            "the ids are the wire strings, so the selection round-trips through the config write",
        )
        assertTrue(choices.all { it.enabled }, "the phone cannot know the host's platform, so it offers every engine")
    }

    @Test
    fun `fish audio setup stays on the computer`() {
        val unconfigured = ConfigStatus(tts = ConfigFlag(configured = false, provider = "fish"))
        assertEquals(
            "Fish Audio is not configured",
            ProfileRules.voiceCopy(unconfigured).unconfiguredNotice,
        )
        assertEquals(
            "Add the shared Fish Audio API key in OpenMausBot on the computer. " +
                "The key is never returned to this phone.",
            ProfileRules.voiceCopy(unconfigured).footer,
        )

        val noDefault = ConfigStatus(tts = ConfigFlag(configured = true, voice = "", provider = "fish"))
        assertEquals(
            "No workspace default voice is selected. Choose an agent-specific voice above; " +
                "synthesis still uses Fish Audio on your computer.",
            ProfileRules.voiceCopy(noDefault).footer,
        )
    }

    @Test
    fun `chatterbox is never explained as a missing key`() {
        val noServer = ConfigStatus(tts = ConfigFlag(configured = false, provider = "chatterbox"))
        assertEquals(
            "The Chatterbox server is not connected",
            ProfileRules.voiceCopy(noServer).unconfiguredNotice,
        )
        assertEquals(
            "Add the address of your Chatterbox server in OpenMausBot on the computer to turn " +
                "speech back on.",
            ProfileRules.voiceCopy(noServer).footer,
        )

        val noDefault =
            ConfigStatus(tts = ConfigFlag(configured = true, voice = "", provider = "chatterbox"))
        assertEquals(
            "No workspace default voice is selected. Choose an agent-specific voice above; " +
                "synthesis still uses your Chatterbox server.",
            ProfileRules.voiceCopy(noDefault).footer,
        )
    }

    @Test
    fun `the shape selector offers the four crops in the Swift's order`() {
        assertEquals(
            listOf("Mascot", "Circle", "Rounded", "Square"),
            AvatarCrop.entries.map(ProfileRules::cropLabel),
        )
    }

    @Test
    fun `the form starts from the bot the sheet was opened on`() {
        val form = ProfileForm.of(
            bot().copy(
                avatarCrop = AvatarCrop.ROUNDED,
                voice = "voice-2",
                speakReplies = true,
            ),
        )

        assertEquals("Scout", form.name)
        assertEquals(AvatarCrop.ROUNDED, form.crop)
        assertEquals("voice-2", form.voice)
        assertTrue(form.speakReplies)
    }

    @Test
    fun `a bot with no crop and no voice starts on mascot and the empty tag`() {
        val form = ProfileForm.of(bot())

        assertEquals(AvatarCrop.MASCOT, form.crop)
        assertEquals("", form.voice)
        assertFalse(form.speakReplies)
    }

    @Test
    fun `connector grants render one read-only row per service in the server's order`() {
        val rows = ProfileRules.connectorGrantRows(
            listOf(
                BotOverviewGrant("gmail", BotOverviewGrantLevel.All, toolCount = 0),
                BotOverviewGrant("google_calendar", BotOverviewGrantLevel.Partial, toolCount = 2),
                BotOverviewGrant("notion", BotOverviewGrantLevel.None, toolCount = 0),
                BotOverviewGrant("linear", BotOverviewGrantLevel.Partial, toolCount = 1),
            ),
        )

        assertEquals(
            listOf(
                ConnectorGrantRow("Gmail", "All tools"),
                ConnectorGrantRow("Google calendar", "2 tools"),
                ConnectorGrantRow("Notion", "No tools"),
                ConnectorGrantRow("Linear", "1 tool"),
            ),
            rows,
        )
    }

    @Test
    fun `absent grants have no rows for the sheet to draw`() {
        assertEquals(emptyList<ConnectorGrantRow>(), ProfileRules.connectorGrantRows(null))
        // An empty list is the explicit no-tools record; its no-tools line
        // belongs to the sheet, and the rules hand it no rows to draw.
        assertEquals(emptyList<ConnectorGrantRow>(), ProfileRules.connectorGrantRows(emptyList()))
    }

    @Test
    fun `a partial grant reads its tool count verbatim`() {
        assertEquals(
            listOf(ConnectorGrantRow("Github", "0 tools")),
            ProfileRules.connectorGrantRows(
                listOf(BotOverviewGrant("github", BotOverviewGrantLevel.Partial, toolCount = 0)),
            ),
        )
    }

    private fun voices() = listOf(
        Voice(id = "voice-1", label = "Aria", description = "Warm"),
        Voice(id = "voice-2", label = "Bex", description = null),
    )

    /** Key configured and a workspace default selected. */
    private fun speaking() =
        ConfigStatus(tts = ConfigFlag(configured = true, voice = "shared-voice"))

    /** Key configured, workspace default blank — the state that blocks speech. */
    private fun configuredWithoutDefault() =
        ConfigStatus(tts = ConfigFlag(configured = true, voice = "   "))

    private fun bot() = Bot(
        id = "bot-1",
        threadId = "task-1",
        name = "Scout",
        title = "research",
        description = "Finds things",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance-1", "model-1"),
        createdAt = 0.0,
    )
}
