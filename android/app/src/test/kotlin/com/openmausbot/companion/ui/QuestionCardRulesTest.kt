package com.openmausbot.companion.ui

import com.openmausbot.companion.core.AskQuestion
import com.openmausbot.companion.core.AskQuestionOption
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.QuestionRequestCardData
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Which card a transcript row draws.
 *
 * The mistake this guards is the one the desktop shipped: a structured ask
 * routed to the approval card, offering Deny / Always allow / Allow once over
 * a question that has no such answer.
 */
class QuestionCardRulesTest {
    private fun message(card: OptionCard?): Message = Message(
        id = "m-1",
        role = Message.Role.BOT,
        kind = Message.Kind.OPTIONS,
        at = 1.0,
        card = card,
    )

    private val questions = listOf(
        AskQuestion(
            question = "Which model?",
            header = "Model",
            options = listOf(AskQuestionOption("Opus"), AskQuestionOption("Gemini")),
        ),
        AskQuestion(question = "Which style?", options = listOf(AskQuestionOption("Terse"))),
    )

    private fun card(questionRequest: QuestionRequestCardData?, tool: String? = null) = OptionCard(
        title = "t",
        subtitle = "s",
        options = emptyList(),
        requestId = "req-1",
        tool = tool,
        questionRequest = questionRequest,
    )

    @Test
    fun `a structured ask draws the question card`() {
        assertTrue(
            QuestionCardRules.drawsQuestionCard(
                message(card(QuestionRequestCardData(questions = questions))),
            ),
        )
    }

    @Test
    fun `an approval keeps the ordinary card`() {
        assertFalse(QuestionCardRules.drawsQuestionCard(message(card(null, tool = "Bash"))))
        assertFalse(QuestionCardRules.drawsQuestionCard(message(null)))
        assertFalse(
            QuestionCardRules.drawsQuestionCard(message(card(QuestionRequestCardData(questions = emptyList())))),
            "a payload with no questions has nothing to draw",
        )
    }

    @Test
    fun `tabs fall back to a number only where the model named nothing`() {
        assertEquals(listOf("Model", "Question 2"), QuestionCardRules.tabLabels(questions))
    }
}
