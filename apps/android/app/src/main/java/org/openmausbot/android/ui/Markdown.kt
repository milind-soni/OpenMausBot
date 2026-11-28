package org.openmausbot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Bot replies are markdown; a phone renders the subset the desktop does
 *  without pulling a full parser: paragraphs, headings, lists, quotes,
 *  fenced code, rules and tables. */
private sealed interface Block {
    data class Paragraph(val text: String) : Block
    data class Heading(val level: Int, val text: String) : Block
    data class Bullets(val items: List<String>) : Block
    data class Ordered(val items: List<String>) : Block
    data class Quote(val text: String) : Block
    data class Code(val language: String, val body: String) : Block
    data class Table(val rows: List<List<String>>) : Block
    data object Rule : Block
}

private fun parseBlocks(source: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val lines = source.replace("\r\n", "\n").split('\n')
    var index = 0
    val paragraph = StringBuilder()

    fun flush() {
        if (paragraph.isNotBlank()) blocks.add(Block.Paragraph(paragraph.toString().trim()))
        paragraph.setLength(0)
    }

    while (index < lines.size) {
        val line = lines[index]
        val trimmed = line.trim()
        when {
            trimmed.startsWith("```") -> {
                flush()
                val language = trimmed.removePrefix("```").trim()
                val body = StringBuilder()
                index++
                while (index < lines.size && !lines[index].trim().startsWith("```")) {
                    body.append(lines[index]).append('\n')
                    index++
                }
                blocks.add(Block.Code(language, body.toString().trimEnd('\n')))
            }
            trimmed.isEmpty() -> flush()
            trimmed.startsWith("#") -> {
                flush()
                val level = trimmed.takeWhile { it == '#' }.length.coerceIn(1, 6)
                blocks.add(Block.Heading(level, trimmed.drop(level).trim()))
            }
            trimmed == "---" || trimmed == "***" || trimmed == "___" -> {
                flush()
                blocks.add(Block.Rule)
            }
            trimmed.startsWith("> ") -> {
                flush()
                val quote = StringBuilder(trimmed.removePrefix("> "))
                index++
                while (index < lines.size && lines[index].trim().startsWith("> ")) {
                    quote.append('\n').append(lines[index].trim().removePrefix("> "))
                    index++
                }
                blocks.add(Block.Quote(quote.toString()))
                continue
            }
            trimmed.startsWith("|") && index + 1 < lines.size && lines[index + 1].contains("---") -> {
                flush()
                val rows = mutableListOf<List<String>>()
                rows.add(splitRow(trimmed))
                index++
                while (index < lines.size && lines[index].trim().startsWith("|")) {
                    val cells = splitRow(lines[index].trim())
                    if (cells.none { it.matches(Regex("^:?-{2,}:?$")) }) rows.add(cells)
                    index++
                }
                blocks.add(Block.Table(rows))
                continue
            }
            Regex("^[-*+] ").containsMatchIn(trimmed) -> {
                flush()
                val items = mutableListOf<String>()
                while (index < lines.size) {
                    val candidate = lines[index].trim()
                    val match = Regex("^[-*+] (.*)$").find(candidate)
                    if (match != null) {
                        items.add(match.groupValues[1])
                        index++
                    } else if (candidate.isEmpty() || items.isEmpty()) {
                        break
                    } else {
                        // A wrapped list item continues on the next line.
                        items[items.lastIndex] = items.last() + " " + candidate
                        index++
                    }
                }
                blocks.add(Block.Bullets(items))
                continue
            }
            Regex("^\\d+[.)] ").containsMatchIn(trimmed) -> {
                flush()
                val items = mutableListOf<String>()
                while (index < lines.size) {
                    val candidate = lines[index].trim()
                    val match = Regex("^\\d+[.)] (.*)$").find(candidate)
                    if (match != null) {
                        items.add(match.groupValues[1])
                        index++
                    } else if (candidate.isEmpty() || items.isEmpty()) {
                        break
                    } else {
                        items[items.lastIndex] = items.last() + " " + candidate
                        index++
                    }
                }
                blocks.add(Block.Ordered(items))
                continue
            }
            else -> {
                if (paragraph.isNotEmpty()) paragraph.append('\n')
                paragraph.append(trimmed)
            }
        }
        index++
    }
    flush()
    return blocks
}

private fun splitRow(line: String): List<String> = line
    .trim()
    .removePrefix("|")
    .removeSuffix("|")
    .split('|')
    .map { it.trim() }

@Composable
fun Markdown(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurface,
) {
    val blocks = remember(text) { parseBlocks(text) }
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    Column(modifier) {
        blocks.forEachIndexed { blockIndex, block ->
            when (block) {
                is Block.Paragraph -> Text(
                    inline(block.text, color),
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(top = if (blockIndex == 0) 0.dp else 8.dp),
                )
                is Block.Heading -> Text(
                    inline(block.text, color),
                    fontWeight = FontWeight.SemiBold,
                    fontSize = when (block.level) {
                        1 -> 22.sp
                        2 -> 19.sp
                        3 -> 17.sp
                        else -> 16.sp
                    },
                    modifier = Modifier.padding(top = if (blockIndex == 0) 0.dp else 12.dp, bottom = 2.dp),
                )
                is Block.Bullets -> Column(Modifier.padding(top = 4.dp)) {
                    block.items.forEach { item ->
                        Row(Modifier.padding(vertical = 2.dp)) {
                            Text("•  ", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(inline(item, color), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
                is Block.Ordered -> Column(Modifier.padding(top = 4.dp)) {
                    block.items.forEachIndexed { itemIndex, item ->
                        Row(Modifier.padding(vertical = 2.dp)) {
                            Text("${itemIndex + 1}.  ", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(inline(item, color), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
                is Block.Quote -> Row(Modifier.padding(vertical = 6.dp)) {
                    Column(
                        Modifier
                            .padding(end = 10.dp)
                            .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp))
                            .padding(start = 3.dp, top = 18.dp),
                    ) {}
                    Text(
                        inline(block.text, MaterialTheme.colorScheme.onSurfaceVariant),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                is Block.Code -> Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp)
                        .background(codeBackground, RoundedCornerShape(10.dp))
                        .padding(12.dp)
                        .horizontalScroll(rememberScrollState()),
                ) {
                    if (block.language.isNotBlank()) {
                        Text(
                            block.language,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 6.dp),
                        )
                    }
                    Text(
                        block.body,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        color = color,
                    )
                }
                is Block.Table -> Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp)
                        .background(codeBackground, RoundedCornerShape(10.dp))
                        .padding(10.dp)
                        .horizontalScroll(rememberScrollState()),
                ) {
                    block.rows.forEachIndexed { rowIndex, row ->
                        Row {
                            row.forEach { cell ->
                                Text(
                                    inline(cell, color),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = if (rowIndex == 0) FontWeight.SemiBold else FontWeight.Normal,
                                    modifier = Modifier.padding(end = 16.dp, top = 2.dp, bottom = 2.dp),
                                )
                            }
                        }
                    }
                }
                Block.Rule -> Text(
                    "──────────",
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
        }
    }
}

/** Inline emphasis, code and links. Links keep their accent colour; a
 *  long-press still selects and copies the address. */
private fun inline(source: String, base: Color): AnnotatedString = buildAnnotatedString {
    var index = 0
    val codeColor = base.copy(alpha = 0.92f)
    fun pushPlain(text: String) {
        append(text)
    }
    while (index < source.length) {
        val remaining = source.substring(index)
        val code = Regex("^`([^`]+)`").find(remaining)
        val bold = Regex("^\\*\\*([^*]+)\\*\\*").find(remaining)
            ?: Regex("^__([^_]+)__").find(remaining)
        val strike = Regex("^~~([^~]+)~~").find(remaining)
        val italic = Regex("^\\*([^*\\s][^*]*)\\*").find(remaining)
            ?: Regex("^_([^_\\s][^_]*)_").find(remaining)
        val link = Regex("^\\[([^\\]]+)]\\(([^)\\s]+)\\)").find(remaining)
        when {
            code != null -> {
                pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = codeColor))
                append(code.groupValues[1])
                pop()
                index += code.value.length
            }
            bold != null -> {
                pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                append(inline(bold.groupValues[1], base))
                pop()
                index += bold.value.length
            }
            strike != null -> {
                pushStyle(SpanStyle(textDecoration = TextDecoration.LineThrough))
                append(strike.groupValues[1])
                pop()
                index += strike.value.length
            }
            italic != null -> {
                pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                append(italic.groupValues[1])
                pop()
                index += italic.value.length
            }
            link != null -> {
                pushStyle(SpanStyle(color = Color(0xFF8FB8FF), textDecoration = TextDecoration.Underline))
                append(link.groupValues[1])
                pop()
                index += link.value.length
            }
            else -> {
                append(source[index])
                index++
            }
        }
    }
}
