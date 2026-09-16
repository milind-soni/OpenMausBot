package com.astra.companion.ui

import com.astra.companion.core.QuickReply
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/**
 * The icon a quick reply is *chosen* with and the icon it is *drawn* with have to
 * be the same mark, or the editor is a lie: someone picks "terminal" and the
 * composer shows something else.
 *
 * That half is now the compiler's: [quickReplyGlyph] is one function, called by
 * the editor's chips and by the composer's, so there is no second table left to
 * drift — which is why this test no longer reads either file as text.
 *
 * What is left is the half no type can state: that every id
 * `QuickReply.ICON_CHOICES` offers reaches a branch of its own, instead of
 * falling quietly through to the placeholder dot.
 */
class QuickReplyGlyphParityTest {

    @Test
    fun `every icon a reply can carry has a mark of its own`() {
        for (choice in QuickReply.ICON_CHOICES) {
            assertNotEquals(
                PLACEHOLDER,
                quickReplyGlyph(choice),
                "\"$choice\" is offered in the editor but falls through to the placeholder",
            )
        }
    }

    @Test
    fun `no two choices are drawn with the same mark`() {
        // A grid of twelve chips is only a choice if the twelve look different.
        val marks = QuickReply.ICON_CHOICES.associateWith(::quickReplyGlyph)

        assertEquals(
            QuickReply.ICON_CHOICES.size,
            marks.values.toSet().size,
            "two icon choices share one mark: $marks",
        )
    }

    private companion object {
        /** What an id no branch names is drawn as — the `else` of the table. */
        val PLACEHOLDER = quickReplyGlyph("an id the table does not name")
    }
}
