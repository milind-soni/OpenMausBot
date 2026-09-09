package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Instance
import com.openmausbot.companion.core.ModelSelection

/** One row of the model picker. */
data class ModelChoice(val id: String, val label: String)

/**
 * The Model section of bot settings, as rules — the decision half of the
 * section `ios/App/AgentProfileView.swift` added in #699.
 *
 * The phone sees the catalog and the bot's current selection; provider
 * accounts and keys stay on the computer. What this decides is which rows the
 * pickers offer, what a provider change resets, and when "Apply model" is
 * allowed to send anything.
 */
object ModelRules {
    const val FOOTER: String =
        "Provider accounts and API keys stay on your computer. Default sends no reasoning " +
            "level and lets the provider decide."

    const val LOADING: String = "Loading models"
    const val NONE_AVAILABLE: String = "No model providers are available"
    const val CURRENT_PROVIDER_UNAVAILABLE: String = "Current provider (unavailable)"
    const val DEFAULT_EFFORT_LABEL: String = "Default"

    // Private for the reason ProfileRules gives: each is one arm of a
    // state-dependent choice, reached only through [note].
    private const val BUSY_NOTE: String = "Stop this bot before changing its model."
    private const val UNAVAILABLE_NOTE: String = "Choose an available provider to change this bot's model."

    /**
     * The providers the picker offers: the available ones, with the bot's
     * current provider in front when it has gone unavailable, so the picker can
     * still show what the bot is set to.
     */
    fun instanceChoices(instances: List<Instance>, saved: ModelSelection): List<Instance> {
        val available = instances.filter { it.snapshot.isAvailable }
        val current = instances.firstOrNull { it.instanceId == saved.instanceId }
        return if (current != null && !current.snapshot.isAvailable) listOf(current) + available else available
    }

    /** True when the selected provider is not in the catalog at all. */
    fun providerMissing(instances: List<Instance>, selectedInstanceId: String): Boolean =
        instances.none { it.instanceId == selectedInstanceId }

    /**
     * The models the picker offers for one provider: its default first, then
     * the listed options, then the current selection if the catalog does not
     * carry it — each id once.
     */
    fun modelChoices(instance: Instance?, selectedModelId: String): List<ModelChoice> {
        if (instance == null) {
            return if (selectedModelId.isEmpty()) emptyList() else listOf(ModelChoice(selectedModelId, selectedModelId))
        }
        val seen = mutableSetOf<String>()
        val out = mutableListOf<ModelChoice>()
        val default = instance.models.defaultModel
        if (default.isNotEmpty() && seen.add(default)) {
            val label = instance.models.options.firstOrNull { it.id == default }?.label ?: default
            out += ModelChoice(default, label)
        }
        for (option in instance.models.options) {
            if (seen.add(option.id)) out += ModelChoice(option.id, option.label)
        }
        if (selectedModelId.isNotEmpty() && seen.add(selectedModelId)) {
            out += ModelChoice(selectedModelId, selectedModelId)
        }
        return out
    }

    /** The reasoning levels a provider offers, blanks dropped, each once. */
    fun effortLevels(instance: Instance?): List<String> =
        (instance?.capabilities?.effortLevels ?: emptyList()).filter { it.isNotEmpty() }.distinct()

    /**
     * Whether "Apply model" may send: the catalog has loaded, the bot is idle,
     * the chosen provider is available and actually offers the chosen model and
     * effort, and the draft differs from what is saved.
     */
    fun canApply(
        loaded: Boolean,
        botBusy: Boolean?,
        instance: Instance?,
        draft: ModelSelection,
        saved: ModelSelection,
    ): Boolean {
        if (!loaded || botBusy == true || instance == null || !instance.snapshot.isAvailable) return false
        val modelOffered = draft.model == instance.models.defaultModel ||
            instance.models.options.any { it.id == draft.model }
        val effortOffered = draft.effort?.let { it in effortLevels(instance) } ?: true
        return modelOffered && effortOffered && draft != saved
    }

    /**
     * What choosing a provider selects: back on the saved provider, the saved
     * model and its effort (if that provider still offers it); on any other,
     * the provider's default model and the engine-default effort.
     */
    fun defaultsFor(instance: Instance, saved: ModelSelection): ModelSelection =
        if (instance.instanceId == saved.instanceId) {
            ModelSelection(
                instanceId = instance.instanceId,
                model = saved.model,
                effort = saved.effort?.takeIf { it in (instance.capabilities?.effortLevels ?: emptyList()) },
            )
        } else {
            ModelSelection(instanceId = instance.instanceId, model = instance.models.defaultModel, effort = null)
        }

    /** The line under the pickers, or null when nothing stands in the way. */
    fun note(botBusy: Boolean?, instance: Instance?): String? = when {
        botBusy == true -> BUSY_NOTE
        instance?.snapshot?.isAvailable != true -> UNAVAILABLE_NOTE
        else -> null
    }

    fun instanceLabel(instance: Instance): String {
        val name = instance.displayName?.trim()?.takeIf { it.isNotEmpty() } ?: instance.instanceId
        return if (instance.snapshot.isAvailable) name else "$name (Unavailable)"
    }

    fun effortLabel(effort: String): String = when (effort.lowercase()) {
        "xhigh" -> "X-High"
        else -> effort.replaceFirstChar { it.uppercase() }
    }
}
