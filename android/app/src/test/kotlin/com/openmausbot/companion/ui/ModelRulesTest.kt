package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Instance
import com.openmausbot.companion.core.InstanceCapabilities
import com.openmausbot.companion.core.ModelCatalog
import com.openmausbot.companion.core.ModelOption
import com.openmausbot.companion.core.ModelSelection
import com.openmausbot.companion.core.ProviderSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What the Model section decides. Every expectation is read off the section
 * `ios/App/AgentProfileView.swift` gained in #699 — `instanceChoices`,
 * `selectedModelChoices`, `effortLevels`, `canApplyModel`, `selectDefaults`.
 */
class ModelRulesTest {
    private val codex = instance("codex", default = "gpt-5", options = listOf("gpt-5" to "GPT-5", "gpt-5-mini" to "GPT-5 mini"), efforts = listOf("low", "medium", "high", ""))
    private val claude = instance("claude", default = "opus", options = listOf("opus" to "Opus", "sonnet" to "Sonnet"))
    private val gone = instance("gemini", default = "pro", options = listOf("pro" to "Pro"), available = false)
    private val saved = ModelSelection("codex", "gpt-5", effort = "medium")

    @Test
    fun `available providers are offered, and an unavailable current one leads`() {
        assertEquals(listOf(codex, claude), ModelRules.instanceChoices(listOf(codex, claude, gone), saved))
        assertEquals(
            listOf(gone, codex, claude),
            ModelRules.instanceChoices(listOf(codex, claude, gone), ModelSelection("gemini", "pro")),
        )
        assertTrue(ModelRules.providerMissing(listOf(codex), "ollama"))
        assertFalse(ModelRules.providerMissing(listOf(codex), "codex"))
    }

    @Test
    fun `model rows are the default first, then the options, then a stray selection, each once`() {
        assertEquals(
            listOf(ModelChoice("gpt-5", "GPT-5"), ModelChoice("gpt-5-mini", "GPT-5 mini"), ModelChoice("gpt-4", "gpt-4")),
            ModelRules.modelChoices(codex, "gpt-4"),
        )
        assertEquals(listOf(ModelChoice("gpt-5", "GPT-5"), ModelChoice("gpt-5-mini", "GPT-5 mini")), ModelRules.modelChoices(codex, "gpt-5"))
        assertEquals(listOf(ModelChoice("x", "x")), ModelRules.modelChoices(null, "x"))
        assertEquals(emptyList(), ModelRules.modelChoices(null, ""))
    }

    @Test
    fun `effort levels drop blanks and duplicates, and are empty without capabilities`() {
        assertEquals(listOf("low", "medium", "high"), ModelRules.effortLevels(codex))
        assertEquals(emptyList(), ModelRules.effortLevels(claude))
        assertEquals(emptyList(), ModelRules.effortLevels(null))
    }

    @Test
    fun `apply needs a loaded catalog, an idle bot, an available provider, an offered model, and a change`() {
        val changed = saved.copy(effort = "high")
        assertTrue(ModelRules.canApply(loaded = true, botBusy = false, instance = codex, draft = changed, saved = saved))
        assertTrue(ModelRules.canApply(loaded = true, botBusy = null, instance = codex, draft = changed, saved = saved))
        assertFalse(ModelRules.canApply(loaded = false, botBusy = false, instance = codex, draft = changed, saved = saved))
        assertFalse(ModelRules.canApply(loaded = true, botBusy = true, instance = codex, draft = changed, saved = saved))
        assertFalse(ModelRules.canApply(loaded = true, botBusy = false, instance = null, draft = changed, saved = saved))
        assertFalse(ModelRules.canApply(loaded = true, botBusy = false, instance = gone, draft = ModelSelection("gemini", "pro"), saved = saved))
        assertFalse(ModelRules.canApply(loaded = true, botBusy = false, instance = codex, draft = saved, saved = saved))
        assertFalse(ModelRules.canApply(loaded = true, botBusy = false, instance = codex, draft = saved.copy(model = "gpt-4"), saved = saved))
        assertFalse(ModelRules.canApply(loaded = true, botBusy = false, instance = codex, draft = saved.copy(effort = "max"), saved = saved))
        // Default effort is always offered.
        assertTrue(ModelRules.canApply(loaded = true, botBusy = false, instance = codex, draft = saved.copy(effort = null), saved = saved))
    }

    @Test
    fun `choosing a provider restores the saved model on the saved provider and defaults elsewhere`() {
        assertEquals(saved, ModelRules.defaultsFor(codex, saved))
        assertEquals(ModelSelection("claude", "opus", null), ModelRules.defaultsFor(claude, saved))
        // A saved effort the provider no longer offers is dropped.
        val trimmed = instance("codex", default = "gpt-5", options = listOf("gpt-5" to "GPT-5"), efforts = listOf("low"))
        assertNull(ModelRules.defaultsFor(trimmed, saved).effort)
    }

    @Test
    fun `the note names the one thing in the way`() {
        assertEquals("Stop this bot before changing its model.", ModelRules.note(botBusy = true, instance = codex))
        assertEquals("Choose an available provider to change this bot's model.", ModelRules.note(botBusy = false, instance = gone))
        assertEquals("Choose an available provider to change this bot's model.", ModelRules.note(botBusy = false, instance = null))
        assertNull(ModelRules.note(botBusy = false, instance = codex))
    }

    @Test
    fun `labels read as the Swift renders them`() {
        assertEquals("codex", ModelRules.instanceLabel(codex))
        assertEquals("Gemini (Unavailable)", ModelRules.instanceLabel(gone.copy(displayName = " Gemini ")))
        assertEquals("gemini (Unavailable)", ModelRules.instanceLabel(gone.copy(displayName = "  ")))
        assertEquals("X-High", ModelRules.effortLabel("xhigh"))
        assertEquals("Medium", ModelRules.effortLabel("medium"))
    }

    private fun instance(
        id: String,
        default: String,
        options: List<Pair<String, String>>,
        efforts: List<String>? = null,
        available: Boolean = true,
    ) = Instance(
        instanceId = id,
        driverKind = id,
        snapshot = ProviderSnapshot(state = if (available) "available" else "unavailable"),
        models = ModelCatalog(defaultModel = default, options = options.map { ModelOption(it.first, it.second) }),
        capabilities = efforts?.let { InstanceCapabilities(effortLevels = it) },
    )
}
