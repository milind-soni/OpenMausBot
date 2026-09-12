package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A structured ask (Claude's `AskUserQuestion`) as the harness puts it on a
 * card, and the answer text the phone sends back for it.
 *
 * The expectations come from the desktop, not from the Kotlin under them:
 * `shared/ask-question.ts` builds this exact string and the model receives it
 * as its tool result, so an answer given on Android has to be
 * indistinguishable from one given on the Mac or in
 * `ios/Sources/CompanionCore/AskQuestion.swift`. If the three ever disagree,
 * this test is the one that says so.
 */
class AskQuestionTest {
    private val payload = """
        {
          "title": "Your bot has a question",
          "subtitle": "Which model should Hazelnut run on by default?",
          "options": ["Claude Opus 5", "Gemini"],
          "requestId": "req-1",
          "questionRequest": {
            "version": 1,
            "questions": [
              {
                "question": "Which model should Hazelnut run on by default?",
                "header": "Model",
                "multiSelect": false,
                "options": [
                  {"label": "Claude Opus 5", "description": "What the bot had before."},
                  {"label": "Gemini"}
                ]
              },
              {
                "question": "Which stores may it order from?",
                "header": "Stores",
                "multiSelect": true,
                "options": [{"label": "Instamart"}, {"label": "Blinkit"}]
              }
            ]
          }
        }
    """.trimIndent()

    private fun card(json: String = payload): OptionCard =
        CompanionJson.decodeFromString(OptionCard.serializer(), json)

    @Test
    fun `decodes the model's questions and their options`() {
        val card = card()
        assertEquals(2, card.questions.size)
        assertEquals("Model", card.questions[0].header)
        assertEquals("Claude Opus 5", card.questions[0].options[0].label)
        assertEquals("What the bot had before.", card.questions[0].options[0].detail)
        assertEquals(null, card.questions[0].options[1].detail)
        assertFalse(card.questions[0].allowsMultiple)
        assertTrue(card.questions[1].allowsMultiple)
    }

    @Test
    fun `a structured ask is a question, so only an answer settles it`() {
        val card = card()
        // `tool` is what tells a permission from a question, and the harness
        // leaves it off a structured ask precisely so no allow/deny is offered
        // for one. The broker rejects any behavior but "answer".
        assertFalse(card.isPermission)
        assertEquals("answer", OptionCard.responseBehavior("anything", card.isPermission))
    }

    @Test
    fun `an ordinary approval keeps the ordinary card`() {
        val approval = card(
            """{"title":"Approval needed","subtitle":"git push","options":["Allow","Deny"],
               "requestId":"req-2","tool":"Bash"}""",
        )
        assertTrue(approval.questions.isEmpty())
        assertTrue(approval.isPermission)
    }

    @Test
    fun `a question that offers no options still decodes`() {
        // Free text answers it, so a missing list must never fail the whole
        // transcript decode.
        val sparse = card(
            """{"title":"t","subtitle":"s","options":[],"requestId":"r",
               "questionRequest":{"questions":[{"question":"Which account?"}]}}""",
        )
        assertEquals(emptyList(), sparse.questions[0].options)
        assertEquals("Question 1", sparse.questions[0].tabLabel(1))
    }

    @Test
    fun `formats the answer the model will read`() {
        val answer = AskQuestionAnswer.format(
            card().questions,
            listOf(listOf("Claude Opus 5"), listOf("Instamart", "Blinkit")),
        )
        assertEquals(
            """
            The user answered your questions.

            Q: Which model should Hazelnut run on by default?
            A: Claude Opus 5

            Q: Which stores may it order from?
            A: Instamart, Blinkit
            """.trimIndent(),
            answer,
        )
    }

    @Test
    fun `omits an unanswered question rather than implying one`() {
        val questions = card().questions
        assertEquals(
            "The user answered your questions.\n\n" +
                "Q: Which model should Hazelnut run on by default?\nA: Gemini",
            AskQuestionAnswer.format(questions, listOf(listOf("Gemini"), listOf("   "))),
        )
        assertEquals(
            "",
            AskQuestionAnswer.format(questions, listOf(emptyList(), emptyList())),
            "nothing answered means nothing is sent",
        )
    }

    @Test
    fun `a settled card drops the model-facing lead-in`() {
        val answer = AskQuestionAnswer.format(card().questions, listOf(listOf("Gemini"), listOf("Instamart")))
        assertFalse(AskQuestionAnswer.withoutPreamble(answer).startsWith(AskQuestionAnswer.PREAMBLE))
        assertTrue(AskQuestionAnswer.withoutPreamble(answer).startsWith("Q: "))
        assertEquals("Tea", AskQuestionAnswer.withoutPreamble("Tea"))
    }

    @Test
    fun `an answered question keeps the words it was answered with`() {
        val settled = card(
            """{"title":"t","subtitle":"s","options":[],"requestId":"r","answered":"answer",
               "answeredText":"The user answered your questions.\n\nQ: Which model?\nA: Gemini",
               "questionRequest":{"version":1,"questions":[{"question":"Which model?","options":[]}]}}""",
        )
        assertFalse(settled.isPending)
        assertEquals(
            "Q: Which model?\nA: Gemini",
            AskQuestionAnswer.withoutPreamble(settled.answeredText!!),
        )
    }
}
