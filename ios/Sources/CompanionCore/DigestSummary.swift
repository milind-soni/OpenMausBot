// The harness's receipt of a settled turn, read back into parts.
//
// After every turn the computer appends one `digest` message whose text is
// renderDigest's single paragraph (server/digest.ts):
//
//   [digest] · tools: shell ×3, memory_update ×2 (1 failed) · files: changed
//   a.ts; added b.ts · memory: updated MEMORY.md · reply: Done.
//
// As a bubble that is a log line under every reply; dropped entirely, the
// one place the phone says what a turn touched is gone. So it becomes a
// small chip, and this is what the chip opens. The wire carries only the
// text, so the parse is by the renderer's own separators, and anything it
// does not recognise is kept as a plain line rather than lost.
import Foundation

public struct DigestSummary: Hashable, Identifiable, Sendable {
    public struct Line: Hashable, Sendable {
        /// "Tools", "Files", "Memory"; nil for a part with no known label.
        public var label: String?
        /// The part as written, minus its label.
        public var value: String
        /// The same value split into one entry per tool, path group, or
        /// memory change, for a list that reads down rather than across.
        public var items: [String]
    }

    public let lines: [Line]
    /// Calls counted from the tools part's "×N" marks; 0 when it has none.
    public let toolCalls: Int

    public var isEmpty: Bool { lines.isEmpty }

    /// Identity is content: a sheet presented from one is its own item.
    public var id: Self { self }

    /// "What I did", with the call count when there was one to count.
    public var chipLabel: String {
        switch toolCalls {
        case 0: "What I did"
        case 1: "What I did · 1 tool call"
        default: "What I did · \(toolCalls) tool calls"
        }
    }

    /// The sheet's contents as one plain block, for copying.
    public var plainText: String {
        lines.map { line in
            guard let label = line.label else { return line.value }
            return "\(label)\n" + line.items.map { "• \($0)" }.joined(separator: "\n")
        }.joined(separator: "\n\n")
    }

    public init(text: String) {
        var lines: [Line] = []
        var calls = 0
        for raw in text.components(separatedBy: " · ") {
            var part = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if part.hasPrefix("[digest]") {
                part = String(part.dropFirst("[digest]".count)).trimmingCharacters(in: .whitespaces)
            }
            guard !part.isEmpty else { continue }
            // The reply is the bubble just above the chip; repeating its
            // first sentence here says nothing new.
            if part.hasPrefix("reply:") { continue }
            // A turn that touched nothing gets no chip: these are the
            // renderer saying so, and a chip under every plain chat reply
            // that opens onto "no tool calls" is the noise this replaces.
            if Self.nothingDone.contains(part) { continue }
            if let value = Self.value(of: part, label: "tools:") {
                calls += Self.callCount(value)
                lines.append(Line(label: "Tools", value: value, items: Self.tools(value)))
            } else if let value = Self.value(of: part, label: "files:") {
                if value == "none changed" { continue }
                lines.append(Line(label: "Files", value: value, items: Self.split(value, by: "; ")))
            } else if let value = Self.value(of: part, label: "memory:") {
                lines.append(Line(label: "Memory", value: value, items: Self.split(value, by: ", ")))
            } else {
                lines.append(Line(label: nil, value: part, items: [part]))
            }
        }
        self.lines = lines
        self.toolCalls = calls
    }

    private static let nothingDone: Set<String> = [
        "no tool calls",
        "no tool activity observed in this turn",
    ]

    private static func value(of part: String, label: String) -> String? {
        guard part.hasPrefix(label) else { return nil }
        let value = part.dropFirst(label.count).trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }

    private static func split(_ value: String, by separator: String) -> [String] {
        value.components(separatedBy: separator)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// One entry per tool. Tool names can be raw shell commands with commas
    /// of their own, so the split is only at a comma that follows a count —
    /// "name ×N" or "name ×N (M failed)" — which is how every entry ends.
    private static func tools(_ value: String) -> [String] {
        let entries = value.replacingOccurrences(
            of: #"(×\d+(?: \(\d+ failed\))?), "#,
            with: "$1\u{1F}",
            options: .regularExpression
        )
        return split(entries, by: "\u{1F}")
    }

    private static func callCount(_ value: String) -> Int {
        guard let regex = try? NSRegularExpression(pattern: #"×(\d+)"#) else { return 0 }
        let range = NSRange(value.startIndex..., in: value)
        return regex.matches(in: value, range: range).reduce(0) { sum, match in
            guard let r = Range(match.range(at: 1), in: value) else { return sum }
            return sum + (Int(value[r]) ?? 0)
        }
    }
}
