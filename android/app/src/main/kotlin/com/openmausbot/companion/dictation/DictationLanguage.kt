package com.openmausbot.companion.dictation

import android.content.Context

/**
 * Language the composer microphone asks the system recognizer to try first.
 * Labels are endonyms, matching shared/dictation-languages.ts. Empty tag is Auto.
 */
internal object DictationLanguage {
    const val PREFS = "openmausbot-dictation"
    const val KEY = "language"

    data class Choice(val label: String, val tag: String)

    val choices: List<Choice> = listOf(
        Choice("Auto", ""),
        Choice("English", "en-US"),
        Choice("עברית", "he-IL"),
        Choice("Español", "es-ES"),
        Choice("Français", "fr-FR"),
        Choice("Deutsch", "de-DE"),
        Choice("Português", "pt-BR"),
        Choice("Italiano", "it-IT"),
        Choice("Nederlands", "nl-NL"),
        Choice("Русский", "ru-RU"),
        Choice("العربية", "ar"),
        Choice("हिन्दी", "hi-IN"),
        Choice("中文", "zh-CN"),
        Choice("日本語", "ja-JP"),
        Choice("한국어", "ko-KR"),
        Choice("Türkçe", "tr-TR"),
        Choice("Polski", "pl-PL"),
    )

    fun savedTag(context: Context): String {
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "").orEmpty()
        return if (choices.any { it.tag == stored }) stored else ""
    }

    fun save(context: Context, tag: String) {
        val allowed = if (choices.any { it.tag == tag }) tag else ""
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (allowed.isEmpty()) editor.remove(KEY) else editor.putString(KEY, allowed)
        editor.apply()
    }
}
