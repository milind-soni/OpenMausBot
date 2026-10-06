// How an approval card reads on a phone.
//
// The computer's subtitle for a held outbound action is the whole request:
// "Linear · Create linear comment" followed by the raw JSON arguments, once
// per call. That is the right record for the desktop and the audit log, and
// the wrong first thing to read on a phone. These helpers give the card a
// short headline and one summary line, keep the full text for a collapsed
// Details section, and turn the stored verdict ("allow") into words.
import Foundation

/// One app action an outbound card covers, in the order the subtitle lists
/// them.
public struct OutboundCall: Codable, Hashable, Sendable {
    public var app: String?
    public var label: String

    public init(app: String?, label: String) {
        self.app = app
        self.label = label
    }
}

/// `card.outboundRequest`. `calls` is absent on cards from older computers;
/// the subtitle is parsed instead.
public struct OutboundRequest: Codable, Hashable, Sendable {
    public var tool: String?
    public var app: String?
    public var calls: [OutboundCall]?

    public init(tool: String? = nil, app: String? = nil, calls: [OutboundCall]? = nil) {
        self.tool = tool
        self.app = app
        self.calls = calls
    }
}

/// `card.teamMemoryRequest`. Only its presence matters here: it is what
/// makes "allow" read as "Remembered".
public struct TeamMemoryRequest: Codable, Hashable, Sendable {
    public var section: String?
    public var entryId: String?
    public var kind: String?

    public init(section: String? = nil, entryId: String? = nil, kind: String? = nil) {
        self.section = section
        self.entryId = entryId
        self.kind = kind
    }
}

extension OptionCard {
    /// Which layout a card gets.
    public enum Presentation: Hashable, Sendable {
        /// "Send on your behalf?": headline names the app, one summary line,
        /// the request itself under Details.
        case outbound
        /// A provider's or a teammate's permission ask: the title, the first
        /// line of what it wants, the rest under Details.
        case approval
        /// Everything else — skill, routine, profile, model and team-setup
        /// proposals, team memory, legacy questions — shows in full.
        case standard
    }

    /// What a settled card says happened.
    public enum Outcome: Hashable, Sendable {
        case allowed
        case denied
        /// The request behind the card went away before anyone answered.
        case unavailable
        case remembered
        case skipped
        /// A legacy question answered with words (`answeredText`; may be empty).
        case answered(String)
        /// A proposal settled by one of its own options ("Confirm", "Cancel").
        case chose(String, positive: Bool)
        /// A value this build does not know, shown as stored.
        case other(String)

        /// Whether the verdict let the request through, for the icon.
        public var isPositive: Bool {
            switch self {
            case .allowed, .remembered, .answered: return true
            case let .chose(_, positive): return positive
            case .denied, .unavailable, .skipped, .other: return false
            }
        }
    }

    /// The tools a teammate approval card carries (`server/peer-approval.ts`).
    static let peerApprovalTools: Set<String> = ["ask_bot", "delegate_bot", "post_to_room"]

    /// Longest summary or preview line before it is cut with an ellipsis.
    static let summaryLimit = 140

    /// At most this many distinct actions are named on the summary line.
    static let summaryGroups = 3

    public var presentation: Presentation {
        if outboundRequest != nil { return .outbound }
        if teamMemoryRequest != nil || skillRequest != nil || requestType == "question" { return .standard }
        if requestType == "permission" { return .approval }
        if let tool, Self.peerApprovalTools.contains(tool) { return .approval }
        // A permission card from a computer older than `requestType`: it has
        // a tool and offers "Allow". No proposal offers that word.
        if tool != nil, options.contains(where: { $0.caseInsensitiveCompare("Allow") == .orderedSame }) {
            return .approval
        }
        return .standard
    }

    /// The calls an outbound card covers: the computer's own list when it
    /// sent one, else read back from the subtitle. Empty when neither works.
    public var outboundCalls: [OutboundCall] {
        guard outboundRequest != nil else { return [] }
        if let calls = outboundRequest?.calls, !calls.isEmpty { return calls }
        return Self.parseOutboundCalls(subtitle)
    }

    /// The subtitle is `App · Label` then the arguments on the next line, per
    /// call, calls separated by a blank line. JSON.stringify never writes a
    /// raw newline, so the first line of each block is always its heading.
    static func parseOutboundCalls(_ subtitle: String) -> [OutboundCall] {
        let blocks = subtitle.components(separatedBy: "\n\n")
        var calls: [OutboundCall] = []
        for block in blocks {
            let heading = (block.components(separatedBy: "\n").first ?? "")
                .trimmingCharacters(in: .whitespaces)
            guard !heading.isEmpty else { return [] }
            if let range = heading.range(of: " · ") {
                let app = String(heading[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
                let label = String(heading[range.upperBound...]).trimmingCharacters(in: .whitespaces)
                guard !app.isEmpty, !label.isEmpty else { return [] }
                calls.append(OutboundCall(app: app, label: label))
            } else {
                calls.append(OutboundCall(app: nil, label: heading))
            }
        }
        return calls
    }

    /// The one app an outbound card sends to, or nil when it names several,
    /// names none, or could not be read.
    public var outboundApp: String? {
        let calls = outboundCalls
        guard !calls.isEmpty, calls.allSatisfy({ $0.app != nil }) else { return nil }
        let apps = Set(calls.compactMap(\.app))
        return apps.count == 1 ? apps.first : nil
    }

    /// The bold first line, in English. The app draws the localized form of
    /// the same rule; Walkie and other plain-text surfaces read this one.
    public var headline: String {
        guard presentation == .outbound else { return title }
        if let app = outboundApp { return "Send to \(app)?" }
        return "Send on your behalf?"
    }

    /// The line under the headline. Outbound: each action once, with a count
    /// when it repeats. Approval: the first line of the request. Standard
    /// cards keep their whole subtitle.
    public var summaryLine: String {
        switch presentation {
        case .outbound:
            return Self.collapse(outboundCalls, namingApps: outboundApp == nil)
        case .approval:
            return Self.firstLine(of: subtitle)
        case .standard:
            return subtitle
        }
    }

    /// Whether Details would show anything the summary does not.
    public var hasDetails: Bool {
        let full = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !full.isEmpty else { return false }
        switch presentation {
        case .outbound: return true
        case .approval: return full != summaryLine
        case .standard: return false
        }
    }

    /// One short line for the roster row, the Needs-you pill, the island,
    /// Live Activities and widgets. Never the raw request.
    public var previewLine: String {
        switch presentation {
        case .outbound:
            let calls = outboundCalls
            guard !calls.isEmpty else { return headline }
            if let app = outboundApp { return "\(app) · \(Self.collapse(calls, namingApps: false))" }
            return Self.collapse(calls, namingApps: true)
        case .approval, .standard:
            let line = Self.firstLine(of: subtitle)
            return line.isEmpty ? title : line
        }
    }

    /// The card as one spoken sentence.
    public var spokenLine: String {
        let rest = presentation == .standard ? subtitle : summaryLine
        return [headline, rest].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// An answered permission or outbound card has done its job: the bot's
    /// next message says what happened, and the card's request and verdict
    /// are clutter on a phone. Proposals keep their settled card.
    public var leavesTranscriptWhenSettled: Bool {
        !isPending && presentation != .standard
    }

    /// The "why this asked" note is for deciding. Once the card is settled
    /// it has done its job; an outbound card's headline already says it. A
    /// free-text note written after the decision (an error, no catalog key)
    /// on a proposal still explains what happened, so that one stays.
    public var showsHeldNote: Bool {
        guard let held, !held.isEmpty else { return false }
        if presentation == .outbound { return false }
        if isPending { return true }
        return presentation == .standard && heldCode == nil
    }

    /// What a settled card says happened, or nil while nothing was decided.
    /// `expired` is separate: it has its own line.
    public var outcome: Outcome? {
        guard let answered else { return nil }
        let value = answered.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "unavailable": return .unavailable
        case "answer": return .answered(answeredText ?? "")
        default: break
        }
        let positive: Bool
        if ["allow", "allowed", "approve", "approved"].contains(value) {
            positive = true
        } else if ["deny", "denied", "reject", "rejected"].contains(value) {
            positive = false
        } else if let option = options.first(where: { $0.caseInsensitiveCompare(answered) == .orderedSame }) {
            // An older store kept the button's own text.
            positive = !Self.isRefusal(option)
        } else {
            return .other(answered)
        }
        if teamMemoryRequest != nil || tool == "propose_team_memory" { return positive ? .remembered : .skipped }
        if presentation == .standard {
            // A proposal reads as the option it was settled with.
            let chosen = positive
                ? options.first { !Self.isRefusal($0) }
                : options.first { Self.isRefusal($0) }
            let plain = positive ? "Allow" : "Deny"
            if let chosen, chosen.caseInsensitiveCompare(plain) != .orderedSame {
                return .chose(chosen, positive: positive)
            }
        }
        return positive ? .allowed : .denied
    }

    /// Each distinct action once, in first-seen order, "×N" when repeated.
    static func collapse(_ calls: [OutboundCall], namingApps: Bool) -> String {
        var order: [OutboundCall] = []
        var counts: [OutboundCall: Int] = [:]
        for call in calls {
            if counts[call] == nil { order.append(call) }
            counts[call, default: 0] += 1
        }
        let parts = order.prefix(summaryGroups).map { call -> String in
            let name = namingApps ? [call.app, call.label].compactMap { $0 }.joined(separator: " · ") : call.label
            let count = counts[call] ?? 1
            return count > 1 ? "\(name) ×\(count)" : name
        }
        let hidden = order.count - parts.count
        let line = parts.joined(separator: ", ")
        return hidden > 0 ? "\(line), +\(hidden) more" : line
    }

    /// The first non-empty line, trimmed, cut at `summaryLimit`.
    static func firstLine(of text: String) -> String {
        let line = text.components(separatedBy: .newlines)
            .lazy
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        guard line.count > summaryLimit else { return line }
        return String(line.prefix(summaryLimit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
