import Foundation

/// Hand stream frames to the UI actor in ordered batches, at most one per
/// window, so that a busy fleet costs the phone a few state publishes a
/// second rather than one per tool call.
///
/// Every frame rides the window, not only tokens: with five bots working,
/// tool steps alone arrive about sixteen times a second, and each one used
/// to force a publish and a full Home render of its own. Only what someone
/// is waiting on closes the window early (`closesBatchWindow`): an ask, a
/// notification, an error, a stopped turn, the Live call's line. Hello is
/// always a batch of its own, delivered after everything before it.
///
/// Batches are pulled, not pushed. A consumer still busy with the last batch
/// gets everything that arrived meanwhile as one batch when it asks again,
/// so a phone that falls behind folds its backlog in one publish instead of
/// replaying it window by window — which is how a hydrate, or a slower
/// phone, used to leave the app minutes behind the computer.
///
/// A window that reaches `maximumCount` frames closes without waiting out
/// its time. No frame is discarded or reordered while the stream runs: the
/// last folded sequence remains the replay cursor. Cancelling drops what has
/// not been handed over yet, so a reconnect replays it rather than skipping
/// it.
public func eventBatches(
    _ events: AsyncThrowingStream<StreamFrame, Error>,
    intervalNanoseconds: UInt64 = 50_000_000,
    maximumCount: Int = 100
) -> StreamBatches {
    precondition(maximumCount > 0)
    let buffer = EventBatchBuffer(interval: intervalNanoseconds, maximumCount: maximumCount)
    let reader = Task {
        do {
            for try await frame in events {
                try Task.checkCancellation()
                await buffer.append(frame)
            }
            if Task.isCancelled { await buffer.cancel() } else { await buffer.finish() }
        } catch {
            // Our own cancellation is not the transport failing: nothing
            // pending is handed over, and nothing is thrown.
            if Task.isCancelled { await buffer.cancel() } else { await buffer.finish(throwing: error) }
        }
    }
    return StreamBatches(pump: BatchPump(buffer: buffer, reader: reader))
}

/// The batches of one stream, for a single consumer.
public struct StreamBatches: AsyncSequence, Sendable {
    public typealias Element = [StreamFrame]

    let pump: BatchPump

    public func makeAsyncIterator() -> Iterator {
        Iterator(pump: pump)
    }

    public struct Iterator: AsyncIteratorProtocol {
        let pump: BatchPump

        public mutating func next() async throws -> [StreamFrame]? {
            if Task.isCancelled {
                pump.cancel()
                return nil
            }
            return try await withTaskCancellationHandler {
                try await pump.buffer.next()
            } onCancel: { [pump] in
                pump.cancel()
            }
        }
    }
}

/// Owns the task reading the source. A consumer that stops iterating — it
/// returned, or its task was cancelled — closes the source with it, the way
/// dropping an `AsyncThrowingStream` would.
final class BatchPump: Sendable {
    let buffer: EventBatchBuffer
    private let reader: Task<Void, Never>

    init(buffer: EventBatchBuffer, reader: Task<Void, Never>) {
        self.buffer = buffer
        self.reader = reader
    }

    func cancel() {
        reader.cancel()
        Task { [buffer] in await buffer.cancel() }
    }

    deinit { cancel() }
}

extension Frame {
    /// A frame someone is waiting on. It closes the current window instead
    /// of riding it; everything else (tokens, tool steps, settled replies,
    /// bot and room updates) waits at most one window.
    var closesBatchWindow: Bool {
        switch self {
        case .notify, .liveCall:
            return true
        case let .message(_, message), let .messagePatch(_, message):
            // a new approval, question or secret request
            return message.card?.isPending == true || message.secret?.isPending == true
        case let .runtime(event):
            return ["request.opened", "request.resolved", "runtime.error", "turn.failed", "turn.aborted"]
                .contains(event.type)
        default:
            return false
        }
    }
}

actor EventBatchBuffer {
    let interval: UInt64
    let maximumCount: Int
    /// Frames inside the open window.
    private var pending: [StreamFrame] = []
    /// Closed windows the consumer has not taken yet. Consecutive windows
    /// merge into one batch; a hello never merges with anything.
    private var ready: [[StreamFrame]] = []
    private var waiter: CheckedContinuation<[StreamFrame]?, Error>?
    private var timer: Task<Void, Never>?
    private var generation = 0
    /// No more input: the source finished, failed or was cancelled.
    private var ended = false
    /// The source's error, thrown once every batch before it is taken.
    private var failure: Error?

    init(interval: UInt64, maximumCount: Int) {
        self.interval = interval
        self.maximumCount = maximumCount
    }

    func append(_ frame: StreamFrame) {
        guard !ended else { return }
        if case .hello = frame.frame {
            closeWindow()
            ready.append([frame])
            deliver()
            return
        }
        pending.append(frame)
        if frame.frame.closesBatchWindow || pending.count >= maximumCount {
            closeWindow()
            deliver()
            return
        }
        guard timer == nil else { return }
        let expected = generation
        timer = Task { [weak self, interval] in
            do { try await Task.sleep(nanoseconds: interval) } catch { return }
            await self?.windowElapsed(expected)
        }
    }

    /// The next batch, waiting for one when none is ready. Nil once the
    /// source has finished (or the stream was cancelled) and every batch
    /// has been taken; a source failure is thrown in its place.
    func next() async throws -> [StreamFrame]? {
        if !ready.isEmpty { return ready.removeFirst() }
        if ended {
            if let failure {
                self.failure = nil
                throw failure
            }
            return nil
        }
        precondition(waiter == nil, "one consumer at a time")
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }

    func finish(throwing error: Error? = nil) {
        guard !ended else { return }
        closeWindow()
        ended = true
        failure = error
        deliver()
    }

    func cancel() {
        ended = true
        failure = nil
        timer?.cancel()
        timer = nil
        pending.removeAll()
        ready.removeAll()
        waiter?.resume(returning: nil)
        waiter = nil
    }

    private func windowElapsed(_ expected: Int) {
        guard expected == generation else { return }
        closeWindow()
        deliver()
    }

    /// Move the open window to the consumer's queue, merging it into a
    /// batch the consumer has not taken yet.
    private func closeWindow() {
        timer?.cancel()
        timer = nil
        generation &+= 1
        guard !pending.isEmpty else { return }
        if let last = ready.last, !Self.isHello(last) {
            ready[ready.count - 1].append(contentsOf: pending)
            pending.removeAll(keepingCapacity: true)
        } else {
            ready.append(pending)
            pending = []
        }
    }

    /// Hand a waiting consumer the next batch, or the end of the stream.
    private func deliver() {
        guard let waiter else { return }
        if !ready.isEmpty {
            self.waiter = nil
            waiter.resume(returning: ready.removeFirst())
        } else if ended {
            self.waiter = nil
            if let failure {
                self.failure = nil
                waiter.resume(throwing: failure)
            } else {
                waiter.resume(returning: nil)
            }
        }
    }

    private static func isHello(_ batch: [StreamFrame]) -> Bool {
        guard batch.count == 1, case .hello = batch[0].frame else { return false }
        return true
    }
}
