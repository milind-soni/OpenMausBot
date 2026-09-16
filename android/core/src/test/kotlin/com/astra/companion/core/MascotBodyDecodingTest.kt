package com.astra.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The wire field that says which catalog body a bot wears — `Bot.mascotBody` in `Models.swift`. */
class MascotBodyDecodingTest {
    private val base = """
        {"id":"bot-1","threadId":"thread-1","name":"Scout","title":"","description":"",
         "notifications":true,"color":"blue","unread":false,"createdAt":1.0,
         "modelSelection":{"instanceId":"codex","model":"gpt-5"}
    """.trimIndent()

    @Test
    fun anOlderHarnessSendsNoBodyAndThatDecodesAsNull() {
        val bot = CompanionJson.decodeFromString<Bot>("$base}")
        assertNull(bot.mascotBody)
    }

    @Test
    fun theChosenBodyTravelsAsItsCatalogId() {
        val bot = CompanionJson.decodeFromString<Bot>("$base,\"mascotBody\":\"star\"}")
        assertEquals("star", bot.mascotBody)
    }
}
