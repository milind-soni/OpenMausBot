// The two decisions Walkie mode makes that are worth testing without a
// microphone: when a sent turn has produced something to say back, and how
// a Markdown reply should sound.
//
// Walkie is hold-to-talk: you speak, the words go to one bot, and its answer
// is read aloud once the turn settles. Speaking a half-written answer would
// mean reading it twice, so the reply waits for the bot to stop — except a
// question card, which is the bot stopping *for you* and should be heard now.
import Foundation

public enum Walkie {
    /// What to say back after a turn, or nil while there is nothing yet.
    ///
    /// `baseline` is every message id the thread already had when you spoke;
    /// anything the bot added since is the reply. Your own words and tool
    /// activity are never read out.
    public static func settledReply(transcript: [Message], baseline: Set<String>, busy: Bool) -> String? {
        let fresh = transcript.filter { $0.role == .bot && !baseline.contains($0.id) }
        if busy {
            return fresh.last(where: { $0.kind == .options }).flatMap(spoken(_:))
        }
        let parts = fresh.compactMap(spoken(_:))
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    private static func spoken(_ message: Message) -> String? {
        switch message.kind {
        case .text, .unknown:
            let text = message.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return text.isEmpty ? nil : text
        case .options:
            guard let card = message.card else { return nil }
            let line = [card.title, card.subtitle].filter { !$0.isEmpty }.joined(separator: " ")
            return line.isEmpty ? nil : line
        case .secret:
            return "It needs a credential from you. Open the chat to enter it."
        case .activity, .screen, .digest:
            return nil
        }
    }

    /// Markdown as it should sound: no symbols read aloud, links by their
    /// words, code blocks skipped, and a long answer cut at a sentence with a
    /// pointer to the chat rather than a minute of speech.
    public static func speakable(_ markdown: String, limit: Int = 600) -> String {
        var text = replace(#"(?s)```.*?```"#, in: markdown, with: "\nCode omitted.\n")
        text = replace(#"!?\[([^\]]*)\]\([^)]*\)"#, in: text, with: "$1")
        text = replace(#"https?://\S+"#, in: text, with: "a link")

        let spoken = Markdown.blocks(text).compactMap(utterance)
        let joined = replace(#"\s+"#, in: spoken.joined(separator: " "), with: " ")
        return truncated(joined, limit: limit)
    }

    private static func utterance(_ block: MarkdownBlock) -> String? {
        switch block {
        case let .table(table):
            let lines = ([table.headers] + table.rows).compactMap { row -> String? in
                let words = row.map { plain($0) }.filter { !$0.isEmpty }
                return words.isEmpty ? nil : sentence(words.joined(separator: ", "))
            }
            return lines.isEmpty ? nil : lines.joined(separator: " ")
        case let .paragraph(text):
            guard !Markdown.delimiterParagraph(text) else { return nil }
            return sentence(piped(plain(text)))
        case let .heading(_, text), let .bullet(_, text), let .quote(text), let .ordered(_, _, text):
            return sentence(piped(plain(text)))
        case let .task(_, _, _, text):
            return sentence(piped(plain(text)))
        case .code:
            return "Code omitted."
        case .rule:
            return nil
        }
    }

    /// Emphasis and code ticks, without touching pipes. List markers are
    /// already gone: the splitter consumed them.
    private static func plain(_ text: String) -> String {
        var line = text.replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "~~", with: "")
            .replacingOccurrences(of: "`", with: "")
        line = replace(#"(?<!\w)[*_](.+?)[*_](?!\w)"#, in: line, with: "$1")
        return line.trimmingCharacters(in: .whitespaces)
    }

    /// Join pipe cells the way a table row is spoken. A line with no pipe is
    /// unchanged.
    private static func piped(_ text: String) -> String {
        guard text.contains("|") else { return text }
        let words = Markdown.cells(text).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return words.joined(separator: ", ")
    }

    private static func sentence(_ text: String) -> String? {
        var line = text.trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: ",")))
        guard !line.isEmpty else { return nil }
        if let last = line.last, !".!?:;".contains(last) { line += "." }
        return line
    }

    /// Split speakable text into utterances the computer will synthesize.
    /// The harness refuses anything over 500 characters, and a shorter first
    /// piece starts speaking sooner, so pieces break at sentences — or at
    /// words, for a sentence that is too long by itself.
    public static func utterances(_ text: String, limit: Int = 320) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        var sentences: [String] = []
        trimmed.enumerateSubstrings(in: trimmed.startIndex..., options: .bySentences) { sentence, _, _, _ in
            let clean = sentence?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !clean.isEmpty { sentences.append(clean) }
        }
        if sentences.isEmpty { sentences = [trimmed] }

        var out: [String] = []
        var current = ""
        for piece in sentences.flatMap({ wrapped($0, limit: limit) }) {
            if current.isEmpty {
                current = piece
            } else if current.count + 1 + piece.count <= limit {
                current += " " + piece
            } else {
                out.append(current)
                current = piece
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    private static func wrapped(_ sentence: String, limit: Int) -> [String] {
        guard sentence.count > limit else { return [sentence] }
        var lines: [String] = []
        var line = ""
        for word in sentence.split(separator: " ").map(String.init) {
            var word = word
            while word.count > limit {
                if !line.isEmpty { lines.append(line); line = "" }
                lines.append(String(word.prefix(limit)))
                word = String(word.dropFirst(limit))
            }
            if line.isEmpty {
                line = word
            } else if line.count + 1 + word.count <= limit {
                line += " " + word
            } else {
                lines.append(line)
                line = word
            }
        }
        if !line.isEmpty { lines.append(line) }
        return lines
    }

    private static func truncated(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        let head = String(text.prefix(limit))
        let sentenceEnd = head.lastIndex { ".!?".contains($0) }
        let cut: String
        if let sentenceEnd, head.distance(from: head.startIndex, to: sentenceEnd) > limit / 3 {
            cut = String(head[...sentenceEnd])
        } else if let space = head.lastIndex(of: " ") {
            cut = String(head[..<space]) + "…"
        } else {
            cut = head + "…"
        }
        return cut + " The rest is in the chat."
    }

    private static func replace(_ pattern: String, in text: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }
}
