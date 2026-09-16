package com.astra.companion.core

sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock
    data class Bullet(val indent: Int, val text: String) : MarkdownBlock
    data class Ordered(val indent: Int, val number: Int, val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class Code(val language: String?, val text: String) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data object Rule : MarkdownBlock
}

object Markdown {
    fun blocks(source: String): List<MarkdownBlock> {
        val blocks = mutableListOf<MarkdownBlock>()
        val paragraph = mutableListOf<String>()

        fun flushParagraph() {
            if (paragraph.isEmpty()) return
            blocks += MarkdownBlock.Paragraph(paragraph.joinToString(" "))
            paragraph.clear()
        }

        val lines = source
            .replace("\r\n", "\n")
            .replace("\r", "\n")
            .split('\n')
        var index = 0
        while (index < lines.size) {
            val line = lines[index++]
            val trimmed = line.trim()

            if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
                flushParagraph()
                val marker = trimmed.take(3)
                val language = trimmed.drop(3).trim().ifEmpty { null }
                val body = mutableListOf<String>()
                while (index < lines.size) {
                    val next = lines[index++]
                    if (next.trim().startsWith(marker)) break
                    body += next
                }
                blocks += MarkdownBlock.Code(language, body.joinToString("\n"))
                continue
            }

            if (trimmed.isEmpty()) {
                flushParagraph()
                continue
            }

            if (trimmed.length >= 3 && trimmed.first() in "-*_") {
                if (trimmed.all { it == trimmed.first() }) {
                    flushParagraph()
                    blocks += MarkdownBlock.Rule
                    continue
                }
            }

            heading(trimmed)?.let {
                flushParagraph()
                blocks += it
                continue
            }

            if (trimmed.startsWith('>')) {
                flushParagraph()
                blocks += MarkdownBlock.Quote(trimmed.drop(1).trim())
                continue
            }

            listItem(line)?.let {
                flushParagraph()
                blocks += it
                continue
            }

            paragraph += trimmed
        }
        flushParagraph()
        return blocks
    }

    private fun heading(trimmed: String): MarkdownBlock.Heading? {
        val hashes = trimmed.takeWhile { it == '#' }.length
        if (hashes !in 1..6) return null
        val rest = trimmed.drop(hashes)
        if (!rest.startsWith(' ')) return null
        return MarkdownBlock.Heading(hashes, rest.trim())
    }

    private fun listItem(line: String): MarkdownBlock? {
        val leading = line.takeWhile { it == ' ' || it == '\t' }.length
        val indent = (leading / 2).coerceAtMost(4)
        val trimmed = line.trim()

        listOf("- ", "* ", "+ ").firstOrNull(trimmed::startsWith)?.let {
            return MarkdownBlock.Bullet(indent, trimmed.drop(2))
        }

        val digits = trimmed.takeWhile(Char::isDigit)
        if (digits.isNotEmpty() && digits.length <= 9) {
            val rest = trimmed.drop(digits.length)
            if (rest.startsWith(". ") || rest.startsWith(") ")) {
                return MarkdownBlock.Ordered(indent, digits.toIntOrNull() ?: 1, rest.drop(2))
            }
        }
        return null
    }
}
