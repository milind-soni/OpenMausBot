// Markdown, split into blocks.
//
// The desktop renders bot replies with react-markdown + GFM. The phone draws
// the same blocks a chat bubble needs: paragraphs, lists, task items,
// headings, fences, quotes, rules, and tables. Inline emphasis stays with
// Foundation. Anything this does not recognise stays text, which is the
// failure mode that loses nothing.
import Foundation

public enum MarkdownTableAlignment: Hashable, Sendable {
    case leading, trailing, center
}

public struct MarkdownTable: Hashable, Sendable {
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
    final class CachedBlocks: NSObject {
        let blocks: [MarkdownBlock]
        init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
    }

    // Settled text only: finished replies, previews, spoken text. Large
    // replies are not retained indefinitely; NSCache also releases them under
    // pressure. A reply that is still streaming never goes in here — its text
    // is new on almost every update, and one-use prefixes would push out the
    // messages above it in the transcript.
    static let blockCache: NSCache<NSString, CachedBlocks> = {
        let cache = NSCache<NSString, CachedBlocks>()
        cache.countLimit = 128
        cache.totalCostLimit = 1_048_576
        return cache
    }()

    /// The live bubble's last few texts, so a redraw caused by something else
    /// (another bot, a keystroke) is a lookup. Small and separate from
    /// `blockCache` on purpose: each new streaming prefix evicts an older one
    /// of its own kind, never a settled message.
    static let liveBlockCache: NSCache<NSString, CachedBlocks> = {
        let cache = NSCache<NSString, CachedBlocks>()
        cache.countLimit = 4
        cache.totalCostLimit = 1_048_576
        return cache
    }()

    /// Where each streaming reply's settled blocks end. See `parse`.
    static let settledPrefixes = SettledPrefixes()

    /// Split into blocks. Never throws and never drops input: an unparseable
    /// line ends up in a paragraph, which is what the reader wanted anyway.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        parse(source, streaming: false).blocks
    }

    /// The same blocks as `blocks(_:)`. Pass `streaming: true` for a reply
    /// that is still arriving: its text is not kept as a whole, only the part
    /// no later text can change, so the next update parses just what came
    /// after that.
    public static func blocks(_ source: String, streaming: Bool) -> [MarkdownBlock] {
        parse(source, streaming: streaming).blocks
    }

    struct Parsed {
        let blocks: [MarkdownBlock]
        /// UTF-8 bytes that went through the line parser on this call: 0 on a
        /// cache hit, otherwise what followed the longest settled prefix.
        let parsedUTF8: Int
    }

    /// A reply streams in 50 ms batches, so the live bubble asks for the
    /// blocks of a slightly longer text every time. Parsing all of it again
    /// is quadratic over the reply. Instead, while parsing, note the last line
    /// where nothing was left open — no paragraph being gathered, no list
    /// whose next item could nest, no fence (a fence swallows lines whole, so
    /// the loop never stands on one inside it), and every line the parser
    /// has looked at, including a table's one-line lookahead, already ended
    /// in a line break. The blocks before that line cannot change whatever
    /// arrives next, and the rest parses exactly as it would have in the
    /// whole text. The next update that starts with the same bytes picks up
    /// from there.
    static func parse(_ source: String, streaming: Bool) -> Parsed {
        let key = source as NSString
        if let cached = blockCache.object(forKey: key) { return Parsed(blocks: cached.blocks, parsedUTF8: 0) }
        if streaming, let cached = liveBlockCache.object(forKey: key) {
            return Parsed(blocks: cached.blocks, parsedUTF8: 0)
        }

        let start = settledPrefixes.longest(prefixOf: source)
        let base = start?.resume ?? 0
        let tail = base == 0 ? source : String(decoding: source.utf8.dropFirst(base), as: UTF8.self)
        let lines = splitLines(tail)
        let parsed = parseLines(lines)
        var blocks = start?.blocks ?? []
        let settledCount = blocks.count
        blocks.append(contentsOf: parsed.blocks)

        if streaming {
            if let point = settledPoint(parsed, lines: lines, tail: tail),
               base + point.keyEnd <= SettledPrefixes.maxKeyBytes {
                let entry = SettledPrefixes.Entry(
                    key: String(decoding: source.utf8.prefix(base + point.keyEnd), as: UTF8.self),
                    resume: base + point.resume,
                    blocks: Array(blocks.prefix(settledCount + point.blocks))
                )
                settledPrefixes.remember(entry, replacing: start)
            } else if let start {
                settledPrefixes.touch(start)
            }
        }

        let bytes = source.utf8.count
        if bytes <= 65_536 {
            let cache = streaming ? liveBlockCache : blockCache
            cache.setObject(CachedBlocks(blocks), forKey: key, cost: bytes * 4 + blocks.count * 32)
        }
        return Parsed(blocks: blocks, parsedUTF8: tail.utf8.count)
    }

    /// The whole text through the line parser, no caches. What `blocks`
    /// must always agree with; tests compare against it.
    static func blocksFromScratch(_ source: String) -> [MarkdownBlock] {
        parseLines(splitLines(source)).blocks
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
    private static func splitLines(_ source: String) -> [String] {
        source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
    }

    struct LineParse {
        var blocks: [MarkdownBlock] = []
        /// Lines the loop reached with no paragraph and no list open, and
        /// how many blocks were done by then. Line 0 is never listed.
        var clean: [(line: Int, blocks: Int)] = []
    }

    /// The last clean line that is safe to resume from, as UTF-8 offsets into
    /// `tail`: `resume` is where that line starts and `keyEnd` is just past
    /// its line break. The line itself must be complete, because the parser
    /// may already have peeked at it (a table looks one line ahead), and its
    /// break must contain "\n": a lone "\r" at the end of a key could still
    /// turn out to be the start of "\r\n", or, before a combining mark, not a
    /// break at all. Nil when no line qualifies or the bytes do not line up
    /// with the split lines, which never costs more than a full parse.
    private static func settledPoint(
        _ parse: LineParse,
        lines: [String],
        tail: String
    ) -> (resume: Int, keyEnd: Int, blocks: Int)? {
        let complete = lines.count - 1
        guard let furthest = parse.clean.last(where: { $0.line < complete }) else { return nil }
        let utf8 = tail.utf8
        var cursor = utf8.startIndex
        var offset = 0
        var starts: [Int] = []
        var endsInNewline: [Bool] = []
        starts.reserveCapacity(furthest.line + 2)
        endsInNewline.reserveCapacity(furthest.line + 1)
        for index in 0...furthest.line {
            starts.append(offset)
            let length = lines[index].utf8.count
            guard let end = utf8.index(cursor, offsetBy: length, limitedBy: utf8.endIndex),
                  end < utf8.endIndex else { return nil }
            // The split lines are the source with only the breaks rewritten,
            // so each line's bytes are followed by "\n", "\r\n" or a lone "\r".
            cursor = utf8.index(after: end)
            var breakLength = 1
            switch utf8[end] {
            case 0x0A:
                endsInNewline.append(true)
            case 0x0D:
                if cursor < utf8.endIndex, utf8[cursor] == 0x0A {
                    cursor = utf8.index(after: cursor)
                    breakLength = 2
                }
                endsInNewline.append(breakLength == 2)
            default:
                return nil
            }
            offset += length + breakLength
        }
        starts.append(offset)
        for candidate in parse.clean.reversed() where candidate.line < complete && endsInNewline[candidate.line] {
            return (starts[candidate.line], starts[candidate.line + 1], candidate.blocks)
        }
        return nil
    }

    private static func parseLines(_ all: [String]) -> LineParse {
        var result = LineParse()
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

        var lines = all[...]
        while let line = lines.first {
            // The only state carried from line to line is `paragraph` and
            // `listIndents`; with both empty, what follows parses the same
            // with or without the lines before it.
            if lines.startIndex > 0, paragraph.isEmpty, listIndents.isEmpty {
                result.clean.append((lines.startIndex, blocks.count))
            }
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
        result.blocks = blocks
        return result
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

/// The settled start of each reply that is still streaming: the source up to
/// the last line `Markdown.parse` found safe to resume from, and the blocks
/// before it. One entry per live reply — each new one replaces the entry it
/// grew from — so a stream never fills this with its own prefixes, and the
/// settled messages in `Markdown.blockCache` are never what makes room.
final class SettledPrefixes: @unchecked Sendable {
    final class Entry {
        /// The source through the end of the last line the parser looked at.
        /// A later text continues from `resume` only if it starts with all of
        /// these bytes.
        let key: String
        let keyUTF8: Int
        /// UTF-8 offset where parsing picks up: the start of that last line.
        let resume: Int
        let blocks: [MarkdownBlock]

        init(key: String, resume: Int, blocks: [MarkdownBlock]) {
            self.key = key
            self.keyUTF8 = key.utf8.count
            self.resume = resume
            self.blocks = blocks
        }
    }

    /// A bubble streams one reply; a handful at once is the most a screen
    /// shows. Keys past a megabyte are not kept.
    static let countLimit = 16
    static let byteLimit = 8 * 1_048_576
    static let maxKeyBytes = 1_048_576

    private let lock = NSLock()
    /// Most recently used first.
    private var entries: [Entry] = []

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    /// The entry with the longest key that `source` starts with, byte for
    /// byte. Comparing bytes rather than `String ==` matters: Swift compares
    /// strings by canonical equivalence, and "e" + U+0301 is not the "é" the
    /// parser saw.
    func longest(prefixOf source: String) -> Entry? {
        lock.lock()
        let snapshot = entries
        lock.unlock()
        let available = source.utf8.count
        var best: Entry?
        for entry in snapshot where entry.keyUTF8 <= available && entry.keyUTF8 > (best?.keyUTF8 ?? 0) {
            if Self.hasPrefix(source, entry.key, count: entry.keyUTF8) { best = entry }
        }
        return best
    }

    /// Keep `entry` in front. The entry it grew from goes, and so does any
    /// other whose key it extends: an older checkpoint of the same reply.
    func remember(_ entry: Entry, replacing old: Entry?) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll { existing in
            existing === old
                || (existing.keyUTF8 <= entry.keyUTF8 && Self.hasPrefix(entry.key, existing.key, count: existing.keyUTF8))
        }
        entries.insert(entry, at: 0)
        var bytes = entries.reduce(0) { $0 + $1.keyUTF8 }
        while entries.count > Self.countLimit || (bytes > Self.byteLimit && entries.count > 1) {
            bytes -= entries.removeLast().keyUTF8
        }
    }

    /// Move a reply that is still streaming to the front, so other replies
    /// age out first.
    func touch(_ entry: Entry) {
        lock.lock()
        defer { lock.unlock() }
        guard let index = entries.firstIndex(where: { $0 === entry }), index > 0 else { return }
        entries.insert(entries.remove(at: index), at: 0)
    }

    func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll()
    }

    private static func hasPrefix(_ source: String, _ prefix: String, count: Int) -> Bool {
        guard count > 0 else { return true }
        let fast = source.utf8.withContiguousStorageIfAvailable { whole in
            prefix.utf8.withContiguousStorageIfAvailable { start in
                whole.count >= count && start.count == count
                    && memcmp(whole.baseAddress!, start.baseAddress!, count) == 0
            }
        }
        if let fast, let result = fast { return result }
        return source.utf8.starts(with: prefix.utf8)
    }
}
