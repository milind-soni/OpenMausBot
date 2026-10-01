package com.openmausbot.companion.core

/**
 * The turn digest the computer appends after every reply, read back into the
 * sections the "What I did" sheet lists. The row is one paragraph built by
 * `renderDigest` in `server/digest.ts`:
 *
 *     [digest] · tools: shell ×3, memory_update ×2 (1 failed) · files: changed a.ts · reply: Done.
 *
 * The reply part is dropped — it is the message right above the chip. A part
 * with a label this build does not know is kept as plain text rather than lost.
 */
data class TurnDigest(val sections: List<Section>, val toolCalls: Int) {
    /** [label] is null for a part with no known label; [items] are its lines. */
    data class Section(val label: String?, val items: List<String>)

    /** The chip's words: the count only when there were tool calls to count. */
    val chipLabel: String
        get() = when (toolCalls) {
            0 -> CHIP_TITLE
            1 -> "$CHIP_TITLE · 1 tool"
            else -> "$CHIP_TITLE · $toolCalls tools"
        }

    companion object {
        const val CHIP_TITLE = "What I did"

        private const val SEPARATOR = " · "
        private const val PREFIX = "[digest]"
        private val LABELS = listOf("tools", "files", "memory")

        /** `name ×N` with an optional `(k failed)`; lazy, so a name may hold ", ". */
        private val TOOL = Regex("""(?:^|, )((.+?) ×(\d+)(?: \(\d+ failed\))?)(?=, |$)""")
        private val TOOL_NOTES = listOf(" (from tool previews)")
        private val MORE = Regex(""" \+\d+ more$""")

        fun parse(text: String?): TurnDigest {
            val parts = text.orEmpty().trim().removePrefix(PREFIX).split(SEPARATOR)
                .map { it.trim() }
                .filter { it.isNotEmpty() && it != PREFIX }
            var toolCalls = 0
            val sections = parts.mapNotNull { part ->
                if (part.startsWith("reply:")) return@mapNotNull null
                val label = LABELS.firstOrNull { part.startsWith("$it: ") }
                    ?: return@mapNotNull Section(null, listOf(part))
                val body = part.removePrefix("$label: ")
                when (label) {
                    "tools" -> {
                        val (items, calls) = tools(body)
                        toolCalls += calls
                        Section(label, items)
                    }
                    "files" -> Section(label, body.split("; ").filter { it.isNotBlank() })
                    else -> Section(label, body.split(", ").filter { it.isNotBlank() })
                }
            }
            return TurnDigest(sections, toolCalls)
        }

        /**
         * One line per tool, and the total call count. A raw shell command as a
         * tool name can hold anything, so a body that does not read as a tool
         * list stays one line rather than being split in the wrong place.
         */
        private fun tools(body: String): Pair<List<String>, Int> {
            var rest = body
            val notes = mutableListOf<String>()
            TOOL_NOTES.forEach { note ->
                if (rest.endsWith(note)) {
                    rest = rest.removeSuffix(note)
                    notes += note.trim().removeSurrounding("(", ")")
                }
            }
            MORE.find(rest)?.let { more ->
                rest = rest.removeRange(more.range)
                notes.add(0, more.value.trim())
            }
            val matches = TOOL.findAll(rest).toList()
            val parsed = matches.isNotEmpty() && matches.joinToString("") { it.value } == rest
            if (!parsed) return listOf(body) to 0
            val items = matches.map { it.groupValues[1] } + notes
            return items to matches.sumOf { it.groupValues[3].toInt() }
        }
    }
}
