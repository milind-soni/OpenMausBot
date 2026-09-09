import Foundation

/// An attachment encoded in a stored user prompt. Agents receive local paths,
/// but people should see a quiet attachment label rather than the transport
/// tag that carries that path.
public struct DisplayedMessageAttachment: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case image
        case file
    }

    public let kind: Kind
    /// The app-owned path written into the stored prompt. The phone sends it
    /// back only through the originating message's authenticated file route;
    /// it is never opened as a local URL on the phone.
    public let path: String
    public let name: String

    public init(kind: Kind, path: String, name: String) {
        self.kind = kind
        self.path = path
        self.name = name
    }
}

public struct AttachedMessageContent: Hashable, Sendable {
    public let text: String
    public let attachments: [DisplayedMessageAttachment]

    public init(text: String, attachments: [DisplayedMessageAttachment]) {
        self.text = text
        self.attachments = attachments
    }

    /// Splits only the exact, standalone tags OpenMausBot writes. An inline
    /// example in somebody's prose stays prose instead of disappearing.
    public static func parse(_ source: String) -> AttachedMessageContent {
        var attachments: [DisplayedMessageAttachment] = []
        var visible = ""
        var fence: Fence?
        var htmlBlock: HTMLBlock?
        var cursor = source.startIndex

        while cursor < source.endIndex {
            let newline = source[cursor...].firstIndex(of: "\n")
            let lineEnd = newline ?? source.endIndex
            let wholeLineEnd = newline.map { source.index(after: $0) } ?? source.endIndex
            var line = String(source[cursor..<lineEnd])
            if line.hasSuffix("\r") { line.removeLast() }

            var consumedTransportTag = false
            if let activeFence = fence {
                if let marker = fenceMarker(in: line),
                   marker.character == activeFence.character,
                   marker.length >= activeFence.length,
                   marker.remainder.allSatisfy({ $0 == " " || $0 == "\t" }) {
                    fence = nil
                }
            } else if let activeHTMLBlock = htmlBlock {
                switch activeHTMLBlock {
                case .untilBlank:
                    if line.allSatisfy({ $0 == " " || $0 == "\t" }) { htmlBlock = nil }
                case let .untilToken(closingToken):
                    if line.lowercased().contains(closingToken) { htmlBlock = nil }
                }
            } else if let marker = fenceMarker(in: line) {
                fence = Fence(character: marker.character, length: marker.length)
            } else if let attachment = attachmentTag(in: line) {
                attachments.append(attachment)
                consumedTransportTag = true
            } else if let openingHTMLBlock = htmlBlockStarting(in: line) {
                htmlBlock = openingHTMLBlock
            }

            if !consumedTransportTag {
                visible.append(contentsOf: source[cursor..<wholeLineEnd])
            }
            cursor = wholeLineEnd
        }

        return AttachedMessageContent(
            text: visible.trimmingCharacters(in: .whitespacesAndNewlines),
            attachments: attachments
        )
    }

    private struct Fence {
        let character: Character
        let length: Int
    }

    private enum HTMLBlock {
        case untilBlank
        case untilToken(String)
    }

    private static func htmlBlockStarting(in line: String) -> HTMLBlock? {
        let lowercased = line.lowercased()
        if let comment = lowercased.range(of: "<!--"),
           lowercased[comment.upperBound...].range(of: "-->") == nil {
            return .untilToken("-->")
        }

        guard let content = commonMarkContent(in: line) else { return nil }
        let lowerContent = content.lowercased()

        if matches(pastedTextStartExpression, in: line) {
            return lowerContent.contains("</pasted-text>") ? nil : .untilToken("</pasted-text>")
        }

        if let name = firstCapture(of: typeOneExpression, in: line)?.lowercased() {
            let closingToken = "</\(name)>"
            return lowercased.contains(closingToken) ? nil : .untilToken(closingToken)
        }

        if lowerContent.hasPrefix("<?") {
            return lowerContent.dropFirst(2).contains("?>") ? nil : .untilToken("?>")
        }
        if lowerContent.hasPrefix("<![cdata[") {
            return lowerContent.dropFirst(9).contains("]]>") ? nil : .untilToken("]]>")
        }
        if content.hasPrefix("<!"),
           let marker = content.dropFirst(2).unicodeScalars.first,
           (65...90).contains(marker.value) || (97...122).contains(marker.value) {
            return content.dropFirst(2).contains(">") ? nil : .untilToken(">")
        }

        if matches(typeSixExpression, in: line) || matches(typeSevenExpression, in: line) {
            return .untilBlank
        }
        return nil
    }

    private static func commonMarkContent(in line: String) -> Substring? {
        var index = line.startIndex
        var spaces = 0
        while index < line.endIndex, line[index] == " " {
            spaces += 1
            guard spaces <= 3 else { return nil }
            index = line.index(after: index)
        }
        return line[index...]
    }

    private static func matches(_ expression: NSRegularExpression, in line: String) -> Bool {
        expression.firstMatch(
            in: line,
            range: NSRange(line.startIndex..<line.endIndex, in: line)
        ) != nil
    }

    private static func firstCapture(of expression: NSRegularExpression, in line: String) -> String? {
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = expression.firstMatch(in: line, range: range),
              let capture = Range(match.range(at: 1), in: line)
        else { return nil }
        return String(line[capture])
    }

    private static let commonMarkBlockTags = [
        "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
        "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
        "footer", "form", "frame", "frameset", "h[1-6]", "head", "header", "hr", "html", "iframe", "legend",
        "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p",
        "param", "search", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title",
        "tr", "track", "ul",
    ].joined(separator: "|")

    private static let pastedTextStartExpression = try! NSRegularExpression(
        pattern: #"^ {0,3}<pasted-text(?:[\t >]|$)"#,
        options: .caseInsensitive
    )
    private static let typeOneExpression = try! NSRegularExpression(
        pattern: #"^ {0,3}<(script|pre|style|textarea)(?:[\t ]|>|$)"#,
        options: .caseInsensitive
    )
    private static let typeSixExpression = try! NSRegularExpression(
        pattern: #"^ {0,3}</?(?:"# + commonMarkBlockTags + #")(?:[\t ]|/?>|$)"#,
        options: .caseInsensitive
    )
    private static let typeSevenExpression = try! NSRegularExpression(
        pattern: #"^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[\t ]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[\t ]*=[\t ]*(?:[^\s\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*[\t ]*/?>|</[A-Za-z][A-Za-z0-9-]*[\t ]*>)[\t ]*$"#
    )

    private static func fenceMarker(in line: String) -> (character: Character, length: Int, remainder: Substring)? {
        var index = line.startIndex
        var leadingSpaces = 0
        while index < line.endIndex, line[index] == " ", leadingSpaces < 4 {
            leadingSpaces += 1
            index = line.index(after: index)
        }
        guard leadingSpaces <= 3, index < line.endIndex else { return nil }
        let marker = line[index]
        guard marker == "`" || marker == "~" else { return nil }
        var end = index
        var length = 0
        while end < line.endIndex, line[end] == marker {
            length += 1
            end = line.index(after: end)
        }
        guard length >= 3 else { return nil }
        return (marker, length, line[end...])
    }

    private static func attachmentTag(in line: String) -> DisplayedMessageAttachment? {
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = tagExpression.firstMatch(in: line, range: range),
              let kindRange = Range(match.range(at: 1), in: line),
              let pathRange = Range(match.range(at: 2), in: line)
        else { return nil }

        let kind: DisplayedMessageAttachment.Kind = line[kindRange] == "image" ? .image : .file
        let path = decodeAttribute(String(line[pathRange]))
        let providedName: String?
        if match.range(at: 3).location != NSNotFound,
           let nameRange = Range(match.range(at: 3), in: line) {
            providedName = decodeAttribute(String(line[nameRange]))
        } else {
            providedName = nil
        }
        return DisplayedMessageAttachment(
            kind: kind,
            path: path,
            name: displayName(providedName: providedName, path: path, kind: kind)
        )
    }

    private static let tagExpression = try! NSRegularExpression(
        pattern: #"^<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*/>[\t ]*$"#
    )

    private static func decodeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&#9;", with: "\t")
            .replacingOccurrences(of: "&#10;", with: "\n")
            .replacingOccurrences(of: "&#13;", with: "\r")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func displayName(
        providedName: String?,
        path: String,
        kind: DisplayedMessageAttachment.Kind
    ) -> String {
        func basename(_ source: String?) -> String? {
            guard let source else { return nil }
            let value = source.trimmingCharacters(in: .whitespacesAndNewlines)
                .components(separatedBy: CharacterSet(charactersIn: "/\\"))
                .last(where: { !$0.isEmpty })?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let value, !value.isEmpty, value != ".", value != ".." else { return nil }
            return value
        }

        // `name` is presentation metadata from stored chat text, not a path.
        // Basename it just like the fallback so a crafted value can never look
        // like (or later become) a directory traversal.
        let value = basename(providedName) ?? basename(path) ?? (kind == .image ? "Image" : "File")
        let oneLine = value.unicodeScalars.map { scalar in
            let code = scalar.value
            let isBidiControl = (0x202A...0x202E).contains(code) || (0x2066...0x2069).contains(code)
            return CharacterSet.controlCharacters.contains(scalar) || isBidiControl ? " " : String(scalar)
        }.joined()
        return String(oneLine.prefix(180))
    }
}
