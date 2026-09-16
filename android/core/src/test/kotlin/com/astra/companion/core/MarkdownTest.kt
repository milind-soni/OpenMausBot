package com.astra.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarkdownTest {
    @Test
    fun plainTextIsOneParagraph() {
        assertEquals(listOf(MarkdownBlock.Paragraph("just a reply")), Markdown.blocks("just a reply"))
    }

    @Test
    fun emptyInputProducesNothing() {
        assertEquals(emptyList(), Markdown.blocks(""))
        assertEquals(emptyList(), Markdown.blocks("\n\n  \n"))
    }

    @Test
    fun softBreaksBecomeSpaces() {
        assertEquals(
            listOf(MarkdownBlock.Paragraph("one line and its continuation")),
            Markdown.blocks("one line\nand its continuation"),
        )
    }

    @Test
    fun blankLineSeparatesParagraphs() {
        assertEquals(
            listOf(MarkdownBlock.Paragraph("first"), MarkdownBlock.Paragraph("second")),
            Markdown.blocks("first\n\nsecond"),
        )
    }

    @Test
    fun headingLevels() {
        assertEquals(listOf(MarkdownBlock.Heading(1, "Title")), Markdown.blocks("# Title"))
        assertEquals(listOf(MarkdownBlock.Heading(3, "Deeper")), Markdown.blocks("### Deeper"))
    }

    @Test
    fun hashWithoutSpaceIsNotAHeading() {
        assertEquals(listOf(MarkdownBlock.Paragraph("#hashtag")), Markdown.blocks("#hashtag"))
        assertEquals(listOf(MarkdownBlock.Paragraph("####### seven")), Markdown.blocks("####### seven"))
    }

    @Test
    fun bulletMarkers() {
        assertEquals(
            listOf(
                MarkdownBlock.Bullet(0, "one"),
                MarkdownBlock.Bullet(0, "two"),
                MarkdownBlock.Bullet(0, "three"),
            ),
            Markdown.blocks("- one\n* two\n+ three"),
        )
    }

    @Test
    fun nestedBulletsCountIndent() {
        assertEquals(
            listOf(
                MarkdownBlock.Bullet(0, "top"),
                MarkdownBlock.Bullet(1, "nested"),
                MarkdownBlock.Bullet(2, "deeper"),
            ),
            Markdown.blocks("- top\n  - nested\n    - deeper"),
        )
    }

    @Test
    fun orderedListsKeepTheirNumbers() {
        assertEquals(
            listOf(
                MarkdownBlock.Ordered(0, 1, "first"),
                MarkdownBlock.Ordered(0, 2, "second"),
                MarkdownBlock.Ordered(0, 10, "tenth"),
            ),
            Markdown.blocks("1. first\n2. second\n10) tenth"),
        )
    }

    @Test
    fun numberWithoutDelimiterIsProse() {
        assertEquals(listOf(MarkdownBlock.Paragraph("2026 was the year")), Markdown.blocks("2026 was the year"))
        assertEquals(listOf(MarkdownBlock.Paragraph("3.14 is pi")), Markdown.blocks("3.14 is pi"))
    }

    @Test
    fun inlineSyntaxSurvivesTheSplit() {
        assertEquals(
            listOf(MarkdownBlock.Bullet(0, "**bold** and `code` and [link](https://x.test)")),
            Markdown.blocks("- **bold** and `code` and [link](https://x.test)"),
        )
    }

    @Test
    fun fencedCodeKeepsLanguageAndWhitespace() {
        assertEquals(
            listOf(MarkdownBlock.Code("swift", "let x = 1\n    indented")),
            Markdown.blocks("```swift\nlet x = 1\n    indented\n```"),
        )
    }

    @Test
    fun fenceWithoutLanguage() {
        assertEquals(listOf(MarkdownBlock.Code(null, "plain")), Markdown.blocks("```\nplain\n```"))
    }

    @Test
    fun unclosedFenceRunsToTheEnd() {
        assertEquals(
            listOf(MarkdownBlock.Paragraph("here:"), MarkdownBlock.Code("py", "print(1)")),
            Markdown.blocks("here:\n```py\nprint(1)"),
        )
    }

    @Test
    fun fenceContentIsNotReparsed() {
        assertEquals(
            listOf(MarkdownBlock.Code(null, "# not a heading\n- not a bullet")),
            Markdown.blocks("```\n# not a heading\n- not a bullet\n```"),
        )
    }

    @Test
    fun quote() {
        assertEquals(listOf(MarkdownBlock.Quote("quoted")), Markdown.blocks("> quoted"))
    }

    @Test
    fun horizontalRules() {
        assertEquals(listOf(MarkdownBlock.Rule), Markdown.blocks("---"))
        assertEquals(listOf(MarkdownBlock.Rule), Markdown.blocks("***"))
        assertEquals(listOf(MarkdownBlock.Rule), Markdown.blocks("___"))
    }

    @Test
    fun ruleNeedsThreeAndNothingElse() {
        assertEquals(listOf(MarkdownBlock.Paragraph("--")), Markdown.blocks("--"))
        assertEquals(listOf(MarkdownBlock.Paragraph("-- dashes --")), Markdown.blocks("-- dashes --"))
    }

    @Test
    fun crlfDoesNotCreatePhantomBlocks() {
        assertEquals(
            listOf(MarkdownBlock.Paragraph("one two")),
            Markdown.blocks("one\r\ntwo"),
        )
        assertEquals(
            listOf(MarkdownBlock.Code(null, "one\ntwo")),
            Markdown.blocks("```\r\none\r\ntwo\r\n```"),
        )
    }

    @Test
    fun partialInputAlwaysRendersSomething() {
        listOf("#", "# ", "# Head", "- ", "- it", "**bo", "```", "```sw\nlet", "[link](htt").forEach {
            assertTrue(Markdown.blocks(it).isNotEmpty(), "dropped everything for $it")
        }
    }

    @Test
    fun noPrefixOfAReplyLosesCharacters() {
        val reply = "# Result\n\nRan **two** checks:\n\n- `pnpm test` passed\n- `pnpm lint` passed\n\n```sh\npnpm test\n```\n\n> nothing else to report"
        for (length in 1..reply.length) {
            val partial = reply.take(length)
            val rendered = Markdown.blocks(partial).joinToString(separator = "", transform = ::text)
            val sent = partial.filter { !it.isWhitespace() && it !in "#->`*_" }
            val shown = rendered.filter { !it.isWhitespace() && it !in "#->`*_" }
            assertEquals(sent, shown, "lost content at $length characters")
        }
    }

    private fun text(block: MarkdownBlock): String = when (block) {
        is MarkdownBlock.Paragraph -> block.text
        is MarkdownBlock.Bullet -> block.text
        is MarkdownBlock.Ordered -> block.number.toString() + block.text
        is MarkdownBlock.Heading -> block.text
        is MarkdownBlock.Code -> block.language.orEmpty() + block.text
        is MarkdownBlock.Quote -> block.text
        MarkdownBlock.Rule -> ""
    }
}
