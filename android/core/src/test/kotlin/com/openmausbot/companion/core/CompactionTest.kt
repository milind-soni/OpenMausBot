package com.openmausbot.companion.core

import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals

class CompactionTest {
    @Test
    fun chipUsesThePersonsNumberFormatLikeIos() {
        val previous = Locale.getDefault(Locale.Category.FORMAT)
        val compaction = Compaction(summary = "Earlier context", tokensBefore = 12345)
        try {
            for ((locale, tokens) in listOf(Locale.US to "12,345", Locale.GERMANY to "12.345")) {
                Locale.setDefault(Locale.Category.FORMAT, locale)
                assertEquals("Context compacted · $tokens tokens summarised", compaction.chipText)
            }
        } finally {
            Locale.setDefault(Locale.Category.FORMAT, previous)
        }
    }
}
