// One background routine run, as the conversation that asked for it sees it.
//
// The computer upserts a single `routine.run` message per run into the
// source thread and patches it as the run moves from queued to its result
// (shared/routine-run.ts). The run itself happens in a separate execution
// thread that the thread list hides; this card is where its answer lands.
// Before this existed the phone drew only the message's one-line fallback,
// so a routine that wrote a whole report read as "Routine “X” completed".
import Foundation

public struct RoutineRunCard: Codable, Hashable, Sendable {
    public enum Status: String, Sendable {
        case queued, running, waiting, completed, failed, cancelled, missed
    }

    public enum Tone: Sendable {
        case neutral, active, attention, danger
    }

    public var runId: String
    public var routineId: String
    public var routineName: String
    public var scheduledFor: Double?
    /// Kept as the raw string: a status added on the computer after this
    /// build shipped must still decode, and still read as something.
    public var status: String
    public var deferredAt: Double?
    public var goalStatus: String?
    public var executionThreadId: String?
    /// What the run said, already redacted and capped by the computer.
    public var summary: String?
    public var error: String?

    public init(
        runId: String, routineId: String, routineName: String, status: String,
        scheduledFor: Double? = nil, deferredAt: Double? = nil, goalStatus: String? = nil,
        executionThreadId: String? = nil, summary: String? = nil, error: String? = nil
    ) {
        self.runId = runId
        self.routineId = routineId
        self.routineName = routineName
        self.status = status
        self.scheduledFor = scheduledFor
        self.deferredAt = deferredAt
        self.goalStatus = goalStatus
        self.executionThreadId = executionThreadId
        self.summary = summary
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case runId, routineId, routineName, scheduledFor, status, deferredAt
        case goalStatus, executionThreadId, summary, error
    }

    /// Field by field and forgiving: a card is a decoration on a message the
    /// phone can already draw from its text, so one odd field must cost that
    /// field, never the message — and a failed message decode costs the
    /// whole thread page it arrived in.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runId = (try? c.decodeIfPresent(String.self, forKey: .runId)) ?? ""
        routineId = (try? c.decodeIfPresent(String.self, forKey: .routineId)) ?? ""
        routineName = (try? c.decodeIfPresent(String.self, forKey: .routineName)) ?? ""
        scheduledFor = try? c.decodeIfPresent(Double.self, forKey: .scheduledFor)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
        deferredAt = try? c.decodeIfPresent(Double.self, forKey: .deferredAt)
        goalStatus = try? c.decodeIfPresent(String.self, forKey: .goalStatus)
        executionThreadId = try? c.decodeIfPresent(String.self, forKey: .executionThreadId)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }

    public var knownStatus: Status? { Status(rawValue: status) }

    /// Still moving: the card will be patched again.
    public var isInFlight: Bool {
        goalStatus == nil && (knownStatus == .queued || knownStatus == .running)
    }

    public var isDeferred: Bool { knownStatus == .queued && deferredAt != nil }

    /// The computer's own wording (routineRunFallbackText), so the card, the
    /// roster and the desktop describe a run the same way. A room goal's
    /// outcome is the more exact fact and wins over the run's status.
    public var stateText: String {
        switch goalStatus {
        case "needs-input": return "needs your input"
        case "blocked": return "was blocked"
        case "limit-reached": return "reached its limit"
        case "stopped": return "was stopped"
        case "failed": return "failed"
        default: break
        }
        switch knownStatus {
        case .waiting: return "needs your attention"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "was cancelled"
        case .missed: return "was missed"
        case .queued: return deferredAt != nil ? "deferred: target busy" : "queued"
        case .running: return "running"
        case nil: return status
        }
    }

    /// The state as a label rather than the tail of a sentence.
    public var stateLabel: String {
        let text = stateText
        guard let first = text.first else { return "" }
        return first.uppercased() + text.dropFirst()
    }

    public var tone: Tone {
        switch goalStatus {
        case "needs-input", "limit-reached", "paused": return .attention
        case "blocked", "failed": return .danger
        case "completed", "stopped": return .neutral
        default: break
        }
        switch knownStatus {
        case .running: return .active
        case .waiting: return .attention
        case .queued: return deferredAt != nil ? .attention : .neutral
        case .failed, .missed: return .danger
        case .completed, .cancelled, nil: return .neutral
        }
    }

    /// "Routine “Inbox sweep” completed", the sentence every surface opens with.
    public var headline: String {
        let name = routineName.isEmpty ? "Routine" : "Routine “\(routineName)”"
        let state = stateText
        return state.isEmpty ? name : "\(name) \(state)"
    }

    /// One line for a roster row, Updates, or Walkie: the headline, then the
    /// first thing the run actually said — which is why anyone set it up.
    public var previewLine: String {
        guard let first = summary?
            .split(whereSeparator: \.isNewline)
            .lazy
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty })
        else { return headline }
        return "\(headline): \(first)"
    }
}

public extension CompanionState {
    /// Where a routine card's "Open run" goes, or nil when this phone cannot
    /// go there. The execution thread is looked up among every bot's tasks —
    /// not `visibleTasks`, which hides run threads on purpose — so opening
    /// one never puts it back in the thread list. A run whose thread was
    /// deleted, or lives somewhere the phone has no route to, gets no button
    /// rather than a dead one.
    func routineExecutionRef(for card: RoutineRunCard) -> ThreadRef? {
        guard let threadId = card.executionThreadId, !threadId.isEmpty,
              let owner = bots.first(where: { $0.tasks?.contains { $0.threadId == threadId } == true })
        else { return nil }
        return ThreadRef(botId: owner.id, threadId: threadId, title: card.routineName)
    }
}
