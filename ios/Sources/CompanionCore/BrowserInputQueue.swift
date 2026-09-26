import Foundation

/// One request in flight, with replaceable movement coalesced behind it.
///
/// Ported from `src/lib/browser-input-queue.ts`, which the desktop panel uses
/// for the same reason: every input awaits a round trip the server will not
/// acknowledge until the browser has actually applied it. Without coalescing,
/// one flick is sixty requests and the session wedges; without the ceiling, a
/// slow link banks minutes of input that arrives long after it meant anything.
///
/// An actor rather than a lock: the ordering guarantees below are the point,
/// and they are much easier to hold when only one task can be inside at a time.
public actor BrowserInputQueue {
    public typealias Send = @Sendable (BrowserInputBody) async throws -> Void

    /// A slow link cannot accumulate more than this. Reached, the queue halts
    /// rather than delivering input the person stopped meaning.
    public static let ceiling = 32

    private let send: Send
    private let onError: @Sendable (Error) -> Void
    private var pending: [BrowserInputBody] = []
    private var active: Task<Void, Never>?
    private var generation = 0
    private var stopped = false

    public init(send: @escaping Send, onError: @escaping @Sendable (Error) -> Void) {
        self.send = send
        self.onError = onError
    }

    public var depth: Int { pending.count }
    public var isStopped: Bool { stopped }

    public func enqueue(_ body: BrowserInputBody) {
        // A halted queue still accepts releases: refusing them is how a button
        // stays down on the remote after the link recovers.
        if stopped, !body.isRelease { return }

        if let last = pending.last, body.isMovement, replaces(last, with: body) {
            pending[pending.count - 1] = coalesce(last, into: body)
            pumpIfIdle()
            return
        }

        if pending.count >= Self.ceiling {
            // Drop replaceable travel first; it is the only thing whose loss
            // costs nothing.
            if body.isMovement { return }
            if let index = pending.firstIndex(where: { $0.isMovement }) {
                pending.remove(at: index)
            } else {
                halt(BrowserInputError.tooSlow)
                if !body.isRelease || pending.count >= Self.ceiling { return }
            }
        }

        pending.append(body)
        pumpIfIdle()
    }

    /// Wait for everything queued to reach the remote, dropping nothing.
    public func settle() async {
        pumpIfIdle()
        while let task = active {
            await task.value
            if pending.isEmpty { break }
            pumpIfIdle()
        }
    }

    /// Abandon queued travel, then let what is left finish.
    ///
    /// This is the hand-back path: the remote must end up holding nothing, but
    /// a cursor position from before the person let go is not worth waiting
    /// for. Use `settle()` where the queue's whole contents still matter.
    public func drain() async {
        pending.removeAll(where: \.isMovement)
        await settle()
    }

    /// Forget everything, including a halt. Used on reconnect: replaying input
    /// from before the drop would act on a page that has since moved on.
    public func clear() {
        generation += 1
        active?.cancel()
        active = nil
        pending.removeAll()
        stopped = false
    }

    /// Two movements coalesce only when they are the same kind of movement —
    /// a wheel must never absorb a pointer move.
    private func replaces(_ last: BrowserInputBody, with body: BrowserInputBody) -> Bool {
        last.isMovement
            && last.type == body.type
            && last.eventType == body.eventType
            && last.modifiers == body.modifiers
            && last.button == body.button
    }

    /// A replaced pointer move keeps only the newest position; wheels sum, so
    /// a coalesced flick scrolls as far as its parts would have.
    private func coalesce(_ last: BrowserInputBody, into body: BrowserInputBody) -> BrowserInputBody {
        guard body.eventType == "mouseWheel" else { return body }
        var merged = body
        merged.deltaX = min(max((last.deltaX ?? 0) + (body.deltaX ?? 0), -10_000), 10_000)
        merged.deltaY = min(max((last.deltaY ?? 0) + (body.deltaY ?? 0), -10_000), 10_000)
        return merged
    }

    private func halt(_ error: Error) {
        pending.removeAll { !$0.isRelease }
        guard !stopped else { return }
        stopped = true
        onError(error)
    }

    private func pumpIfIdle() {
        guard active == nil, !pending.isEmpty else { return }
        let current = generation
        active = Task { await self.pump(generation: current) }
    }

    private func pump(generation current: Int) async {
        while current == generation, !pending.isEmpty {
            let body = pending.removeFirst()
            do {
                try await send(body)
            } catch {
                if current == generation { halt(error) }
            }
        }
        // Only a pump from the current generation may clear the slot. A stale
        // one that does it unconditionally wipes the replacement `clear()`
        // just started, and then two pumps drain `pending` side by side.
        guard current == generation else { return }
        active = nil
        // Something may have arrived while the last send was in flight; the
        // queue must not park with work still in it.
        if !pending.isEmpty { pumpIfIdle() }
    }
}

public enum BrowserInputError: LocalizedError, Equatable {
    case tooSlow

    public var errorDescription: String? {
        switch self {
        case .tooSlow:
            return "Browser input stopped because the connection is too slow. Release control and reconnect before typing again."
        }
    }
}
