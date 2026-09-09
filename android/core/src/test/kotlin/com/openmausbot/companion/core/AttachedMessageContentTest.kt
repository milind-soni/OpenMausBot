package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AttachedMessageContentTest {
    @Test
    fun splitsSharedImagesAndNamedFilesFromVisibleText() {
        val parsed = AttachedMessageContent.parse(
            """Please review these.

<attached-image path="/tmp/photo.png" />

<attached-file path="/tmp/4ad3.pdf" name="Project &amp; notes.pdf" />""",
        )

        assertEquals("Please review these.", parsed.text)
        assertEquals(
            listOf(
                DisplayedMessageAttachment(DisplayedMessageAttachment.Kind.IMAGE, "photo.png", "/tmp/photo.png"),
                DisplayedMessageAttachment(DisplayedMessageAttachment.Kind.FILE, "Project & notes.pdf", "/tmp/4ad3.pdf"),
            ),
            parsed.attachments,
        )
    }

    @Test
    fun fallsBackToBasenameForOlderFileTags() {
        val parsed = AttachedMessageContent.parse(
            """<attached-file path="C:\Users\Maus\brief.docx" />""",
        )
        assertEquals("", parsed.text)
        assertEquals("brief.docx", parsed.attachments.single().name)
        assertEquals("C:\\Users\\Maus\\brief.docx", parsed.attachments.single().path)
    }

    @Test
    fun leavesInlineExamplesAndUnrelatedTagsVisible() {
        val source = "Example: <attached-file path=\"/tmp/demo.pdf\" />\n<pasted-text>hello</pasted-text>"
        val parsed = AttachedMessageContent.parse(source)
        assertEquals(source, parsed.text)
        assertTrue(parsed.attachments.isEmpty())
    }

    @Test
    fun leavesFencedAndIndentedAttachmentExamplesVisible() {
        val source = """```xml
<attached-file path="/tmp/fenced.pdf" />
```
    <attached-image path="/tmp/spaces.png" />
${'\t'}<attached-file path="/tmp/tab.md" />
<attached-file path="/tmp/real.md" />"""
        val parsed = AttachedMessageContent.parse(source)

        assertEquals(listOf("/tmp/real.md"), parsed.attachments.map { it.path })
        assertTrue("""<attached-file path="/tmp/fenced.pdf" />""" in parsed.text)
        assertTrue("""<attached-image path="/tmp/spaces.png" />""" in parsed.text)
        assertTrue("""<attached-file path="/tmp/tab.md" />""" in parsed.text)
    }

    @Test
    fun unclosedStreamingFenceKeepsTransportLookingLinesLiteral() {
        val source = """Before
~~~
<attached-file path="/tmp/not-transport.md" />"""
        val parsed = AttachedMessageContent.parse(source)

        assertEquals(source, parsed.text)
        assertTrue(parsed.attachments.isEmpty())
    }

    @Test
    fun leavesAttachmentExamplesInsideHtmlContextsVisible() {
        val source = """<!--
<attached-file path="/tmp/comment.md" />
-->
<div class="example">
<attached-image path="/tmp/div.png" />
</div>

<pasted-text>
<attached-file path="/tmp/paste.pdf" />
</pasted-text>
<attached-file path="/tmp/real.md" />"""
        val parsed = AttachedMessageContent.parse(source)

        assertEquals(listOf("/tmp/real.md"), parsed.attachments.map { it.path })
        assertTrue("""<attached-file path="/tmp/comment.md" />""" in parsed.text)
        assertTrue("""<attached-image path="/tmp/div.png" />""" in parsed.text)
        assertTrue("""<attached-file path="/tmp/paste.pdf" />""" in parsed.text)
    }

    @Test
    fun keepsPreBlocksThroughClosingTagAcrossBlankLines() {
        val source = """<pre class="example">
<attached-file path="/tmp/in-pre.md" />

</pre>
<attached-file path="/tmp/real.md" />"""
        val parsed = AttachedMessageContent.parse(source)

        assertEquals(listOf("/tmp/real.md"), parsed.attachments.map { it.path })
        assertTrue("""<attached-file path="/tmp/in-pre.md" />""" in parsed.text)
    }

    @Test
    fun keepsTableAndNestedSectionBlocksThroughBlankLine() {
        val source = """<table>
<attached-file path="/tmp/in-table.csv" />
</table>

<section aria-label="example">
<div>
<attached-image path="/tmp/in-nested-div.png" />
</div>
</section>
<attached-file path="/tmp/still-html.md" />

<attached-file path="/tmp/real.md" />"""
        val parsed = AttachedMessageContent.parse(source)

        assertEquals(listOf("/tmp/real.md"), parsed.attachments.map { it.path })
        assertTrue("""<attached-file path="/tmp/in-table.csv" />""" in parsed.text)
        assertTrue("""<attached-image path="/tmp/in-nested-div.png" />""" in parsed.text)
        assertTrue("""<attached-file path="/tmp/still-html.md" />""" in parsed.text)
    }

    @Test
    fun keepsSpecialAndGenericHtmlBlocksLiteral() {
        val source = """<?example
<attached-file path="/tmp/in-pi.md" />
?>
<![CDATA[
<attached-file path="/tmp/in-cdata.md" />
]]>
<!example
<attached-file path="/tmp/in-declaration.md" />
>
<widget data-name="example">
<attached-file path="/tmp/in-generic.md" />
</widget>

<attached-file path="/tmp/real.md" />"""
        val parsed = AttachedMessageContent.parse(source)

        assertEquals(listOf("/tmp/real.md"), parsed.attachments.map { it.path })
        for (name in listOf("in-pi.md", "in-cdata.md", "in-declaration.md", "in-generic.md")) {
            assertTrue(name in parsed.text)
        }
    }

    @Test
    fun boundsAndFlattensUntrustedDisplayNames() {
        val longName = "\u202E" + "a".repeat(200) + "&#10;.pdf"
        val parsed = AttachedMessageContent.parse(
            """<attached-file path="/tmp/file.pdf" name="$longName" />""",
        )
        val name = parsed.attachments.single().name
        assertTrue(name.toByteArray(Charsets.UTF_8).size <= 180)
        assertFalse('\n' in name)
        assertFalse('\u202E' in name)
    }

    @Test
    fun boundsUnicodeDisplayNamesWithoutSplittingSurrogatePairs() {
        val parsed = AttachedMessageContent.parse(
            """<attached-file path="/tmp/file.md" name="${"📄".repeat(100)}.md" />""",
        )
        val name = parsed.attachments.single().name

        assertTrue(name.toByteArray(Charsets.UTF_8).size <= 180)
        assertFalse(name.indices.any { index ->
            val value = name[index]
            (Character.isHighSurrogate(value) &&
                (index + 1 >= name.length || !Character.isLowSurrogate(name[index + 1]))) ||
                (Character.isLowSurrogate(value) &&
                    (index == 0 || !Character.isHighSurrogate(name[index - 1])))
        })
    }

    @Test
    fun preservesDecodedImageNameAndPathForAuthenticatedPreview() {
        val parsed = AttachedMessageContent.parse(
            """<attached-image path="/tmp/a&amp;b.png" name="Holiday photo.png" />""",
        )

        assertEquals("Holiday photo.png", parsed.attachments.single().name)
        assertEquals("/tmp/a&b.png", parsed.attachments.single().path)
    }

    @Test
    fun reducesProvidedNamesToSafeBasenames() {
        val parsed = AttachedMessageContent.parse(
            """<attached-file path="/tmp/id.pdf" name="../private/Project.pdf" />""",
        )

        assertEquals("Project.pdf", parsed.attachments.single().name)
    }
}
