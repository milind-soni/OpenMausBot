package com.openmausbot.companion.ui

import com.openmausbot.companion.core.AvatarCrop
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotProfilePatch
import com.openmausbot.companion.core.BotOverviewGrant
import com.openmausbot.companion.core.BotOverviewGrantLevel
import com.openmausbot.companion.core.ConfigStatus
import com.openmausbot.companion.core.Voice
import com.openmausbot.companion.core.VoiceProvider

/**
 * The paired-safe agent profile, as rules — the decision half of
 * `ios/App/AgentProfileView.swift`.
 *
 * Identity, avatar, notifications and voice preferences, and nothing else: the
 * shared provider keys stay on the computer, so this form has no field that
 * could carry one.
 */
data class ProfileForm(
    val name: String,
    val title: String,
    val description: String,
    val notifications: Boolean,
    val crop: AvatarCrop,
    /** Empty is the server's "use the workspace default", not "no value". */
    val voice: String,
    val speakReplies: Boolean,
) {
    companion object {
        /** `ProfileFormSnapshot(bot:)`, and the initial value of every field. */
        fun of(bot: Bot): ProfileForm = ProfileForm(
            name = bot.name,
            title = bot.title,
            description = bot.description,
            notifications = bot.notifications,
            crop = bot.avatarCrop ?: AvatarCrop.MASCOT,
            voice = bot.voice ?: "",
            speakReplies = bot.speakReplies == true,
        )
    }
}

/** One row of the voice picker. */
data class VoiceChoice(
    val id: String,
    val label: String,
    val detail: String?,
    val enabled: Boolean,
)

/** One read-only row of the profile sheet's Connected apps section. */
data class ConnectorGrantRow(
    val service: String,
    val summary: String,
)

object ProfileRules {
    /** `String(prompt.trimming….prefix(400))` in `generateImage`. */
    const val GENERATE_PROMPT_LIMIT: Int = 400

    // Visibility here is a rule, not a habit. A string that is one *arm* of a
    // state-dependent choice is private, so the selector below it is the only
    // way to reach it: a screen cannot draw the wrong arm, because it cannot
    // name one. A string with no alternative — nothing to pick between — stays
    // public and is drawn directly. Adding a second arm to any of those means
    // making it private and giving it a selector, in the same edit.

    const val AVATAR_FOOTER: String =
        "PNG, JPEG, GIF, or WebP, up to 10 MB. Images are stored on your paired computer " +
            "and loaded with this phone's pairing token."

    // Grants are assigned per bot on the computer (the web grant editor);
    // the phone only reads the overview's summary back. The footer says so,
    // the way the closed voice states explain a repair this form cannot offer.
    const val CONNECTED_APPS: String = "Connected apps"

    const val CONNECTED_APPS_FOOTER: String =
        "Tool grants are assigned in OpenMausBot on your computer. This phone shows them read-only."

    private const val GRANTS_ALL: String = "All tools"

    private const val GRANTS_NONE: String = "No tools"

    /** The record exists but grants nothing — stronger than "no apps connected". */
    const val GRANTS_NONE_ANY: String = "No tools granted on any connected app."

    private const val GENERATE_READY_FOOTER: String =
        "Generation uses the shared image provider configured on your computer. No provider " +
            "key is sent to or stored on this phone."

    private const val GENERATE_BLOCKED_FOOTER: String =
        "To generate images, configure the shared image provider in OpenMausBot on your " +
            "computer. Provider keys cannot be added from a phone."

    // The ElevenLabs copy below is what iOS ships and is correct under that
    // engine, so it stays byte-identical. Each string that names the engine or
    // its credential has a built-in-provider twin, because under `provider:
    // "system"` there is no key and "not configured" means something else
    // entirely. The desktop is called "the computer" throughout, the way the
    // rest of this file already does.

    private const val TTS_UNCONFIGURED: String = "ElevenLabs is not configured"

    /**
     * The same slot under the built-in provider, where `configured = false`
     * means the computer reports no voices it can use — not that a key is
     * missing, because this engine has none to miss.
     */
    private const val SYSTEM_TTS_UNCONFIGURED: String = "Your computer's built-in voices are unavailable"

    // iOS ends this sentence with "never returned to iOS"; the platform word is
    // the only edit, for the same reason SettingsPolicy does not offer to open
    // iPhone Settings.
    private const val VOICE_UNCONFIGURED_FOOTER: String =
        "Add the shared ElevenLabs key in this agent's profile on the computer. The key is " +
            "never returned to this phone."

    /**
     * The built-in engine's remedy is a different engine, not a credential.
     * Telling the user to add a key here would name a fix that changes
     * nothing; the computer's voice settings are where the engine is chosen,
     * and that control stays reachable in exactly this state.
     */
    private const val SYSTEM_VOICE_UNCONFIGURED_FOOTER: String =
        "Your computer's built-in voices need no key, and it reports none it can use. Switch " +
            "the voice engine in OpenMausBot on the computer to turn speech back on."

    private const val VOICE_NO_DEFAULT_FOOTER: String =
        "No workspace default voice is selected. Choose an agent-specific voice above; " +
            "synthesis still uses the shared ElevenLabs key on your computer."

    private const val FISH_TTS_UNCONFIGURED: String = "Fish Audio is not configured"

    private const val FISH_VOICE_UNCONFIGURED_FOOTER: String =
        "Add the shared Fish Audio API key in OpenMausBot on the computer. The key is " +
            "never returned to this phone."

    private const val FISH_VOICE_NO_DEFAULT_FOOTER: String =
        "No workspace default voice is selected. Choose an agent-specific voice above; " +
            "synthesis still uses Fish Audio on your computer."

    /** The same sentence with the clause that would be a lie replaced. */
    private const val SYSTEM_VOICE_NO_DEFAULT_FOOTER: String =
        "No workspace default voice is selected. Choose an agent-specific voice above; " +
            "synthesis still uses your computer's built-in voices."

    // Chatterbox's credential is a local server address, which is a setting
    // this form deliberately leaves on the computer: the picker can choose the
    // engine, but only the computer can point it at a server.
    private const val CHATTERBOX_TTS_UNCONFIGURED: String = "The Chatterbox server is not connected"

    private const val CHATTERBOX_VOICE_UNCONFIGURED_FOOTER: String =
        "Add the address of your Chatterbox server in OpenMausBot on the computer to turn " +
            "speech back on."

    private const val CHATTERBOX_VOICE_NO_DEFAULT_FOOTER: String =
        "No workspace default voice is selected. Choose an agent-specific voice above; " +
            "synthesis still uses your Chatterbox server."

    // The two below name no engine and no credential. They are true word for
    // word under both providers, so they have no twin to choose between — and
    // that is exactly why they stay public: there is no wrong arm to draw.

    private const val VOICE_READY_FOOTER: String =
        "The voice choice belongs to this agent. Workspace default uses the shared voice " +
            "selected on your computer."

    // Private because it is reached through [pickAVoiceHint], for the reason
    // given there: as a bare Boolean its selector was swappable with the
    // toggle's own predicate. PREVIEW_REFUSED below has no alternative arm and
    // no selector, so it stays public and is drawn directly.
    private const val PICK_A_VOICE: String =
        "Pick a voice for this agent before enabling speech."

    const val PREVIEW_REFUSED: String =
        "Pick an agent voice or configure a workspace default on your computer first."

    /**
     * Only the fields the sheet owns and the user changed.
     *
     * Dirtiness compares the field as typed; the value sent is trimmed. That is
     * how the Swift reads, and it means a trailing space submits a field whose
     * trimmed value is unchanged — mirrored rather than tidied.
     *
     * The 100/200/4000 server limits are deliberately not re-applied here: the
     * shared contract owns them, and a narrower client limit would silently
     * truncate a profile written on the desktop.
     */
    fun patch(form: ProfileForm, baseline: ProfileForm, config: ConfigStatus?): BotProfilePatch {
        val savedSpeakReplies = config
            ?.let { it.canSpeak(form.voice) && form.speakReplies }
            ?: form.speakReplies
        return BotProfilePatch(
            name = if (form.name == baseline.name) null else form.name.trim(),
            title = if (form.title == baseline.title) null else form.title.trim(),
            description = if (form.description == baseline.description) {
                null
            } else {
                form.description.trim()
            },
            notifications = if (form.notifications == baseline.notifications) {
                null
            } else {
                form.notifications
            },
            avatarCrop = if (form.crop == baseline.crop) null else form.crop,
            voice = if (form.voice == baseline.voice) null else form.voice,
            speakReplies = if (savedSpeakReplies == baseline.speakReplies) {
                null
            } else {
                savedSpeakReplies
            },
        )
    }

    fun canSave(form: ProfileForm, busy: Boolean): Boolean =
        !busy && form.name.trim().isNotEmpty()

    fun imageGenerationReady(config: ConfigStatus?): Boolean = config?.imageGen?.configured == true

    fun canGenerate(busy: Boolean, config: ConfigStatus?, prompt: String): Boolean =
        !busy && imageGenerationReady(config) && prompt.trim().isNotEmpty()

    fun generatePrompt(raw: String): String = raw.trim().take(GENERATE_PROMPT_LIMIT)

    fun generateFooter(config: ConfigStatus?): String =
        if (imageGenerationReady(config)) GENERATE_READY_FOOTER else GENERATE_BLOCKED_FOOTER

    /** `config?.canSpeak(agentVoice:) == true` — false while the status is unknown. */
    fun selectedVoiceCanSpeak(config: ConfigStatus?, voice: String): Boolean =
        config?.canSpeak(voice) == true

    fun canPreview(busy: Boolean, config: ConfigStatus?, voice: String): Boolean =
        !busy && selectedVoiceCanSpeak(config, voice)

    /**
     * Whether the chosen engine can speak at all: the shared key under
     * ElevenLabs, a usable voice on the computer under the built-in provider.
     *
     * This picks the section's *contents*, not its existence. The Voice
     * section is drawn in every state — here, and in `AgentProfileView.swift`,
     * where `Section` is likewise unconditional — and this decides whether it
     * holds the picker or the muted-speaker notice, and which of the three
     * footer sentences explains it. Neither cause is repairable from the
     * phone, which is why the closed state explains rather than offers.
     */
    fun voiceConfigured(config: ConfigStatus?): Boolean = config?.isTTSConfigured == true

    /**
     * Which engine's words to use. An unloaded status is ElevenLabs for the
     * same reason a missing `provider` is: that is what the server falls back
     * to, so the phone says nothing new while it does not yet know.
     */
    private fun provider(config: ConfigStatus?): VoiceProvider =
        config?.voiceProvider ?: VoiceProvider.ELEVENLABS

    private fun ttsUnconfiguredLabel(config: ConfigStatus?): String = when (provider(config)) {
        VoiceProvider.ELEVENLABS -> TTS_UNCONFIGURED
        VoiceProvider.FISH -> FISH_TTS_UNCONFIGURED
        VoiceProvider.SYSTEM -> SYSTEM_TTS_UNCONFIGURED
        VoiceProvider.CHATTERBOX -> CHATTERBOX_TTS_UNCONFIGURED
    }

    private fun voiceFooter(config: ConfigStatus?): String = when {
        !voiceConfigured(config) -> when (provider(config)) {
            VoiceProvider.ELEVENLABS -> VOICE_UNCONFIGURED_FOOTER
            VoiceProvider.FISH -> FISH_VOICE_UNCONFIGURED_FOOTER
            VoiceProvider.SYSTEM -> SYSTEM_VOICE_UNCONFIGURED_FOOTER
            VoiceProvider.CHATTERBOX -> CHATTERBOX_VOICE_UNCONFIGURED_FOOTER
        }
        config?.hasWorkspaceDefaultVoice != true -> when (provider(config)) {
            VoiceProvider.ELEVENLABS -> VOICE_NO_DEFAULT_FOOTER
            VoiceProvider.FISH -> FISH_VOICE_NO_DEFAULT_FOOTER
            VoiceProvider.SYSTEM -> SYSTEM_VOICE_NO_DEFAULT_FOOTER
            VoiceProvider.CHATTERBOX -> CHATTERBOX_VOICE_NO_DEFAULT_FOOTER
        }
        else -> VOICE_READY_FOOTER
    }

    /**
     * Everything the voice section says, decided once.
     *
     * The footer and the notice describe the same state, so they are answered
     * together rather than by two calls the screen has to pair correctly. Two
     * public selectors of the same shape — `(ConfigStatus?) -> String` — are
     * interchangeable to the compiler, and swapping them put the wrong
     * sentence in the footer with the suite still green. One entry point
     * leaves no wrong selector to pick.
     */
    data class VoiceCopy(
        /** The explanatory line under the section, in every state. */
        val footer: String,
        /**
         * The line that stands in place of the picker, or null when the
         * section can speak. Null is also the branch: whether the picker is
         * drawn and which words explain it are one decision, not two that
         * could drift apart.
         */
        val unconfiguredNotice: String?,
    )

    fun voiceCopy(config: ConfigStatus?): VoiceCopy = VoiceCopy(
        footer = voiceFooter(config),
        unconfiguredNotice = if (voiceConfigured(config)) null else ttsUnconfiguredLabel(config),
    )

    /**
     * The hint under the toggle, or null when something can already speak.
     *
     * It hands back the sentence rather than a flag so that it cannot be
     * confused with [selectedVoiceCanSpeak]. Both once read
     * `(ConfigStatus?, String) -> Boolean`, both are wired into this same
     * section — the toggle's `enabled` and this hint's visibility — and
     * swapping the two call sites compiled and stayed green: the toggle would
     * enable itself exactly when nothing could speak, and the hint would
     * appear only once it was needless. Returning `String?` makes that swap a
     * type error rather than a silent inversion.
     */
    fun pickAVoiceHint(config: ConfigStatus?, voice: String): String? =
        if (config?.hasWorkspaceDefaultVoice != true && voice.isEmpty()) PICK_A_VOICE else null

    /**
     * The picker's rows, in the Swift's order: the empty tag first — usable only
     * when a workspace default actually exists — then the agent's current voice
     * if the list does not carry it, then the listed voices.
     */
    fun voiceChoices(config: ConfigStatus?, voices: List<Voice>, voice: String): List<VoiceChoice> {
        val out = mutableListOf<VoiceChoice>()
        out += if (config?.hasWorkspaceDefaultVoice == true) {
            VoiceChoice(id = "", label = "Workspace default", detail = null, enabled = true)
        } else {
            VoiceChoice(id = "", label = "Choose an agent voice", detail = null, enabled = false)
        }
        if (voice.isNotEmpty() && voices.none { it.id == voice }) {
            out += VoiceChoice(id = voice, label = "Current agent voice", detail = null, enabled = true)
        }
        voices.forEach { out += VoiceChoice(id = it.id, label = it.label, detail = it.description, enabled = true) }
        return out
    }

    /**
     * The engine picker's rows, in the desktop's order. Every engine stays
     * selectable: whether the computer can actually speak with one is the
     * server's answer, reported as `configured` — the phone cannot know the
     * host's platform, so it offers every engine the API defines and lets the
     * status explain one that cannot run there.
     */
    fun providerChoices(): List<VoiceChoice> = listOf(
        VoiceChoice(VoiceProvider.ELEVENLABS.wire, "ElevenLabs", null, enabled = true),
        VoiceChoice(VoiceProvider.FISH.wire, "Fish Audio", null, enabled = true),
        VoiceChoice(VoiceProvider.SYSTEM.wire, "Built-in Mac voices", null, enabled = true),
        VoiceChoice(VoiceProvider.CHATTERBOX.wire, "Chatterbox (local)", null, enabled = true),
    )

    /**
     * What the loaded status does to the form: a stored `speakReplies` that
     * nothing can speak is turned off before the user ever sees the toggle.
     */
    fun applyLoadedConfig(form: ProfileForm, config: ConfigStatus?): ProfileForm =
        if (config != null && !config.canSpeak(form.voice)) form.copy(speakReplies = false) else form

    /**
     * Voice ids belong to one provider. The server clears every bot voice on
     * a successful switch, so an open sheet must clear both its draft and its
     * dirty-comparison baseline before the new catalog is rendered.
     */
    fun afterVoiceProviderSwitch(
        form: ProfileForm,
        baseline: ProfileForm,
        config: ConfigStatus,
    ): Pair<ProfileForm, ProfileForm> {
        val cleared = applyLoadedConfig(form.copy(voice = ""), config)
        return cleared to baseline.copy(voice = "")
    }

    fun cropLabel(crop: AvatarCrop): String = when (crop) {
        AvatarCrop.MASCOT -> "Mascot"
        AvatarCrop.CIRCLE -> "Circle"
        AvatarCrop.ROUNDED -> "Rounded"
        AvatarCrop.SQUARE -> "Square"
    }

    /**
     * The Connected apps section's rows, in the server's order. An unknown
     * level decodes as partial, so every entry that survives decode has a
     * row; an empty list is the explicit no-tools record, and the sheet
     * gives it [GRANTS_NONE_ANY] rather than drawing nothing.
     */
    fun connectorGrantRows(grants: List<BotOverviewGrant>?): List<ConnectorGrantRow> =
        grants?.map { grant ->
            ConnectorGrantRow(
                service = serviceLabel(grant.slug),
                summary = when (grant.level) {
                    BotOverviewGrantLevel.All -> GRANTS_ALL
                    BotOverviewGrantLevel.None -> GRANTS_NONE
                    BotOverviewGrantLevel.Partial ->
                        grant.toolCount.toString() + " tool" + if (grant.toolCount == 1) "" else "s"
                },
            )
        } ?: emptyList()

    /**
     * The summary names services by slug ("gmail", "google_calendar"); the
     * row shows the same name with separators spaced and the first letter
     * raised, and nothing stronger: the catalog's display labels stay on the
     * computer, and this section must not invent its own.
     */
    private fun serviceLabel(slug: String): String {
        val spaced = slug.replace('_', ' ').replace('-', ' ').trim()
        return if (spaced.isEmpty()) slug else spaced.replaceFirstChar { it.uppercase() }
    }
}
