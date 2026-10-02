package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals

/** The "What I did" chip reads the digest row the computer writes after a turn. */
class TurnDigestTest {
    @Test
    fun splitsTheRowIntoLabelledSectionsAndDropsTheReply() {
        val digest = TurnDigest.parse(
            "[digest] · tools: memory_update ×2 (1 failed), shell ×3 · files: changed a.ts; added b.ts · " +
                "memory: updated MEMORY.md, created notes/x.md · reply: Done.",
        )
        assertEquals(
            listOf(
                TurnDigest.Section("tools", listOf("memory_update ×2 (1 failed)", "shell ×3")),
                TurnDigest.Section("files", listOf("changed a.ts", "added b.ts")),
                TurnDigest.Section("memory", listOf("updated MEMORY.md", "created notes/x.md")),
            ),
            digest.sections,
        )
        assertEquals(5, digest.toolCalls)
        assertEquals("What I did · 5 tools", digest.chipLabel)
    }

    @Test
    fun aRawShellCommandAsAToolNameStaysWhole() {
        val digest = TurnDigest.parse(
            "[digest] · tools: ls -la /tmp, ~/x | grep a ×1, git status ×2 +3 more (from tool previews) · reply: ok",
        )
        assertEquals(
            TurnDigest.Section(
                "tools",
                listOf("ls -la /tmp, ~/x | grep a ×1", "git status ×2", "+3 more", "from tool previews"),
            ),
            digest.sections.single(),
        )
        assertEquals(3, digest.toolCalls)
    }

    @Test
    fun aToolsPartThatDoesNotParseIsKeptAsOneLine() {
        val digest = TurnDigest.parse("[digest] · tools: something new")
        assertEquals(TurnDigest.Section("tools", listOf("something new")), digest.sections.single())
        assertEquals(0, digest.toolCalls)
        assertEquals("What I did", digest.chipLabel)
    }

    @Test
    fun unknownPartsArePlainAndOneToolIsSingular() {
        val digest = TurnDigest.parse("[digest] · tools: shell ×1 · +2 more memory changes · no tool calls")
        assertEquals(
            listOf(
                TurnDigest.Section("tools", listOf("shell ×1")),
                TurnDigest.Section(null, listOf("+2 more memory changes")),
            ),
            digest.sections,
        )
        assertEquals("What I did · 1 tool", digest.chipLabel)
    }

    @Test
    fun noWorkReceiptsHaveNoSectionsButRecordedChangesSurvive() {
        for (text in listOf(
            "[digest] · no tool calls · reply: Hello.",
            "[digest] · no tool activity observed in this turn · files: none changed · reply: Hello.",
            "[digest] · no tool calls · files: none changed · reply: Choose A · B · tools: examples only",
        )) {
            assertEquals(emptyList(), TurnDigest.parse(text).sections)
        }
        assertEquals(
            listOf(TurnDigest.Section("memory", listOf("updated MEMORY.md"))),
            TurnDigest.parse("[digest] · no tool calls · files: none changed · memory: updated MEMORY.md · reply: Choose A · B").sections,
        )
    }

    @Test
    fun anEmptyOrLegacyRowStillParses() {
        assertEquals(emptyList(), TurnDigest.parse(null).sections)
        assertEquals(emptyList(), TurnDigest.parse("[digest]").sections)
        assertEquals(listOf(TurnDigest.Section(null, listOf("Bash ×2"))), TurnDigest.parse("[digest] Bash ×2").sections)
    }
}
