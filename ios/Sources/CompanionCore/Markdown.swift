// Markdown, split into blocks.
//
// The desktop renders bot replies with react-markdown + GFM. The phone draws
// the same blocks a chat bubble needs: paragraphs, lists, task items,
// headings, fences, quotes, rules, and tables. Inline emphasis stays with
// Foundation. Anything this does not recognise stays text, which is the
// failure mode that loses nothing.
import Foundation

public enum MarkdownTableAlignment: Equatable, Sendable {
    case leading, trailing, center
}

public struct MarkdownTable: Equatable, Sendable {
    public var headers: [String]
    public var alignments: [MarkdownTableAlignment]
    public var rows: [[String]]
}

public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    /// `indent` is nesting depth, 0 for a top-level item.
    case bullet(indent: Int, text: String)
    case ordered(indent: Int, number: Int, text: String)
    /// `number` is set for `1.` and `1)` and nil for a bullet task.
    case task(indent: Int, number: Int?, checked: Bool, text: String)
    case heading(level: Int, text: String)
    /// A fenced block. `language` is whatever followed the opening fence.
    case code(language: String?, text: String)
    case quote(String)
    case rule
    case table(MarkdownTable)
}

public enum Markdown {
    /// Split into blocks. Never throws and never drops input: an unparseable
    /// line ends up in a paragraph, which is what the reader wanted anyway.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        /// Marker indents of lists that are still open, outermost first.
        var listIndents: [Int] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            // GFM: a single newline inside a paragraph is a soft break, which
            // renders as a space. The desktop does not enable `breaks`, so
            // neither does this — the two should wrap the same way.
            blocks.append(.paragraph(paragraph.joined(separator: " ")))
            paragraph.removeAll()
        }

        // Normalise the line endings before splitting, because
        // `CharacterSet.newlines` contains \r and \n *separately* and
        // `components(separatedBy:)` breaks on each of them: "a\r\nb" comes
        // back as ["a", "", "b"], one phantom empty line per CRLF. That empty
        // line is not cosmetic — it calls `flushParagraph`, so a paragraph
        // written across several lines arrives as one paragraph per line, and
        // a fenced block gains a blank line between every line of code. Tool
        // output and pasted text reach chat bubbles with CRLF intact, so this
        // is a path real messages take.
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var lines = normalised.components(separatedBy: "\n")[...]
        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                closeLists(line, indents: &listIndents)
                let marker = String(trimmed.prefix(3))
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                while let next = lines.first {
                    lines = lines.dropFirst()
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix(marker) { break }
                    body.append(next)
                }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                listIndents.removeAll()
                continue
            }

            if trimmed.count >= 3, "-*_".contains(trimmed.first!),
               trimmed.allSatisfy({ $0 == trimmed.first! }) {
                flushParagraph()
                closeLists(line, indents: &listIndents)
                blocks.append(.rule)
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                closeLists(line, indents: &listIndents)
                blocks.append(heading)
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                closeLists(line, indents: &listIndents)
                blocks.append(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
                continue
            }

            let leading = leadingCount(line)
            while let inner = listIndents.last, leading <= inner {
                listIndents.removeLast()
            }
            if let inner = listIndents.last, leading > inner {
                if let item = listItem(line) {
                    flushParagraph()
                    listIndents.append(leading)
                    blocks.append(item)
                } else {
                    paragraph.append(trimmed)
                }
                continue
            }

            if let table = takeTable(line, rest: &lines) {
                flushParagraph()
                blocks.append(.table(table))
                continue
            }

            if let item = listItem(line) {
                flushParagraph()
                listIndents.append(leading)
                blocks.append(item)
                continue
            }

            paragraph.append(trimmed)
        }
        flushParagraph()
        return blocks
    }

    private static func leadingCount(_ line: String) -> Int {
        line.prefix(while: { $0 == " " || $0 == "\t" }).count
    }

    /// Pop list markers this line is not inside. A blank line clears the stack
    /// on its own. A nested quote or fence must not.
    private static func closeLists(_ line: String, indents: inout [Int]) {
        let leading = leadingCount(line)
        while let inner = indents.last, leading <= inner {
            indents.removeLast()
        }
    }

    private static func heading(_ trimmed: String) -> MarkdownBlock? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = String(trimmed.dropFirst(hashes))
        // "#hashtag" is not a heading; ATX requires the space
        guard rest.hasPrefix(" ") else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> MarkdownBlock? {
        let leading = leadingCount(line)
        let indent = min(leading / 2, 4)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            let text = String(trimmed.dropFirst(2))
            if let task = taskMark(text) {
                return .task(indent: indent, number: nil, checked: task.checked, text: task.text)
            }
            return .bullet(indent: indent, text: text)
        }

        let digits = trimmed.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count <= 9 {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                let text = String(rest.dropFirst(2))
                let number = Int(digits) ?? 1
                if let task = taskMark(text) {
                    return .task(indent: indent, number: number, checked: task.checked, text: task.text)
                }
                return .ordered(indent: indent, number: number, text: text)
            }
        }
        return nil
    }

    /// `[ ]`, `[x]`, or `[X]`, either alone or followed by whitespace.
    private static func taskMark(_ text: String) -> (checked: Bool, text: String)? {
        guard text.hasPrefix("["), let close = text.firstIndex(of: "]") else { return nil }
        let inside = text[text.index(after: text.startIndex)..<close]
        guard inside == " " || inside == "x" || inside == "X" else { return nil }
        let after = text[text.index(after: close)...]
        if after.isEmpty {
            return (inside != " ", "")
        }
        guard after.first == " " || after.first == "\t" else { return nil }
        return (inside != " ", String(after.drop(while: { $0 == " " || $0 == "\t" })))
    }

    private static func takeTable(_ line: String, rest: inout ArraySlice<String>) -> MarkdownTable? {
        guard isRowCandidate(line), !oddBackticks(line) else { return nil }
        let next = rest.first ?? ""
        if let welded = weld(line), !isDelimiterRow(next) {
            var table = welded
            while let body = rest.first, isBodyRow(body) {
                rest = rest.dropFirst()
                appendRow(cells(body), to: &table)
            }
            return table
        }
        guard isDelimiterRow(next) else { return nil }
        rest = rest.dropFirst()
        var headers = cells(line)
        guard !headers.isEmpty else { return nil }
        var alignments = fittedAlignments(cells(next), count: headers.count)
        var rows: [[String]] = []
        var table = MarkdownTable(headers: headers, alignments: alignments, rows: rows)
        while let body = rest.first, isBodyRow(body) {
            rest = rest.dropFirst()
            appendRow(cells(body), to: &table)
        }
        headers = table.headers
        alignments = table.alignments
        rows = table.rows
        return MarkdownTable(headers: headers, alignments: alignments, rows: rows)
    }

    private static func isRowCandidate(_ line: String) -> Bool {
        let leading = line.prefix(while: { $0 == " " })
        guard line.prefix(while: { $0 == " " || $0 == "\t" }).allSatisfy({ $0 == " " }) else { return false }
        guard leading.count <= 3 else { return false }
        guard line.contains("|") else { return false }
        guard listItem(line) == nil else { return false }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix(">") || trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { return false }
        if heading(trimmed) != nil { return false }
        if trimmed.count >= 3, "-*_".contains(trimmed.first!), trimmed.allSatisfy({ $0 == trimmed.first! }) {
            return false
        }
        return !cells(line).isEmpty
    }

    private static func isBodyRow(_ line: String) -> Bool {
        isRowCandidate(line) && !oddBackticks(line)
    }

    private static func isDelimiterRow(_ line: String) -> Bool {
        guard isRowCandidate(line) else { return false }
        let parts = cells(line)
        guard !parts.isEmpty else { return false }
        return parts.allSatisfy(isDelimiterCell)
    }

    private static func isDelimiterCell(_ cell: String) -> Bool {
        var rest = Substring(cell)
        if rest.first == ":" { rest = rest.dropFirst() }
        let dashes = rest.prefix(while: { $0 == "-" })
        guard !dashes.isEmpty else { return false }
        rest = rest.dropFirst(dashes.count)
        if rest.first == ":" { rest = rest.dropFirst() }
        return rest.isEmpty
    }

    private static func alignment(_ cell: String) -> MarkdownTableAlignment {
        let left = cell.hasPrefix(":")
        let right = cell.hasSuffix(":")
        if left && right { return .center }
        if right { return .trailing }
        return .leading
    }

    private static func fittedAlignments(_ supplied: [String], count: Int) -> [MarkdownTableAlignment] {
        (0..<count).map { index in
            guard index < supplied.count else { return .leading }
            return alignment(supplied[index])
        }
    }

    private static func appendRow(_ row: [String], to table: inout MarkdownTable) {
        var row = row
        if row.count > table.headers.count {
            let extra = row.count - table.headers.count
            table.headers.append(contentsOf: Array(repeating: "", count: extra))
            table.alignments.append(contentsOf: Array(repeating: .leading, count: extra))
            for index in table.rows.indices {
                table.rows[index].append(contentsOf: Array(repeating: "", count: extra))
            }
        }
        while row.count < table.headers.count {
            row.append("")
        }
        table.rows.append(row)
    }

    /// A one-line table. Nil when the line is not the welded shape.
    private static func weld(_ line: String) -> MarkdownTable? {
        let indent = line.prefix(while: { $0 == " " }).count
        guard indent <= 3, line.dropFirst(indent).hasPrefix("|") else { return nil }
        guard !line.contains("`"), !line.contains("\\") else { return nil }
        guard !isDelimiterRow(line) else { return nil }
        guard let range = delimiterRun(in: line) else { return nil }
        let header = String(line[..<range.lowerBound])
        let run = String(line[range])
        let body = String(line[range.upperBound...])
        let headers = cells(header)
        guard headers.count >= 2, header.trimmingCharacters(in: .whitespaces).hasSuffix("|") else { return nil }
        let trimmedBody = body.trimmingCharacters(in: .whitespaces)
        guard trimmedBody.isEmpty || trimmedBody.hasPrefix("|") else { return nil }
        let delimiter = cells(run)
        guard delimiter.count >= 1, delimiter.allSatisfy(isDelimiterCell) else { return nil }

        var table = MarkdownTable(
            headers: headers,
            alignments: fittedAlignments(delimiter, count: headers.count),
            rows: []
        )
        var chunk: [String] = []
        var boundary = false
        for value in cells(body) {
            if boundary {
                boundary = false
                if value.isEmpty { continue }
            }
            chunk.append(value)
            if chunk.count == headers.count {
                table.rows.append(chunk)
                chunk = []
                boundary = true
            }
        }
        if !chunk.isEmpty {
            while chunk.count < headers.count { chunk.append("") }
            table.rows.append(chunk)
        }
        return table
    }

    /// Split a row on pipes that are not escaped and not inside a code span.
    /// One empty cell created by an outer pipe on each edge is dropped.
    static func cells(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var parts: [String] = []
        var current = ""
        var escaped = false
        var inCode = false
        for character in trimmed {
            if escaped {
                if character == "|" {
                    current.append("|")
                } else {
                    current.append("\\")
                    current.append(character)
                }
                escaped = false
                continue
            }
            if character == "\\" {
                escaped = true
                continue
            }
            if character == "`" {
                inCode.toggle()
                current.append(character)
                continue
            }
            if character == "|" && !inCode {
                parts.append(current)
                current = ""
                continue
            }
            current.append(character)
        }
        if escaped { current.append("\\") }
        parts.append(current)
        if trimmed.hasPrefix("|"), parts.first?.trimmingCharacters(in: .whitespaces).isEmpty == true {
            parts.removeFirst()
        }
        if trimmed.hasSuffix("|"), parts.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
            parts.removeLast()
        }
        return parts.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// The first run of `| --- | --- |` style cells in a line.
    private static func delimiterRun(in line: String) -> Range<String.Index>? {
        var index = line.startIndex
        while let pipe = line[index...].firstIndex(of: "|") {
            var cursor = line.index(after: pipe)
            var cells = 0
            var end = cursor
            while cursor < line.endIndex {
                var look = cursor
                while look < line.endIndex, line[look] == " " { look = line.index(after: look) }
                if look < line.endIndex, line[look] == ":" { look = line.index(after: look) }
                let dashes = look
                while look < line.endIndex, line[look] == "-" { look = line.index(after: look) }
                guard look != dashes else { break }
                if look < line.endIndex, line[look] == ":" { look = line.index(after: look) }
                while look < line.endIndex, line[look] == " " { look = line.index(after: look) }
                guard look < line.endIndex, line[look] == "|" else { break }
                cells += 1
                end = line.index(after: look)
                cursor = end
            }
            if cells >= 1 {
                return pipe..<end
            }
            index = line.index(after: pipe)
        }
        return nil
    }

    /// A paragraph whose whole text is a delimiter row, after the same edge
    /// drop table cells use. A delimiter line buried in other words is not.
    static func delimiterParagraph(_ text: String) -> Bool {
        guard text.contains("|") else { return false }
        let parts = cells(text)
        return !parts.isEmpty && parts.allSatisfy(isDelimiterCell)
    }

    private static func oddBackticks(_ line: String) -> Bool {
        var count = 0
        var escaped = false
        for character in line {
            if escaped {
                escaped = false
                continue
            }
            if character == "\\" {
                escaped = true
                continue
            }
            if character == "`" { count += 1 }
        }
        return count % 2 == 1
    }
}
