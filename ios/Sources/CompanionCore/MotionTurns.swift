// Turns to move, for a screen that can show more moving faces than it should
// draw at once.
//
// A busy bot's face is a 30 fps Canvas. Twenty working bots in comfortable
// Home were twenty of them, about 600 draws a second for faces that say the
// same thing: "working". The first `limit` faces to ask move; the rest hold a
// still frame, wait in the order they asked, and move up as soon as one
// ahead of them leaves the screen or stops working.
import Foundation

public struct MotionTurns<ID: Hashable> {
    public let limit: Int
    /// Everyone who asked and has not left, in the order they asked.
    public private(set) var queue: [ID] = []

    public init(limit: Int) {
        self.limit = max(0, limit)
    }

    /// Asking again keeps the place already held.
    public mutating func ask(_ id: ID) {
        guard !queue.contains(id) else { return }
        queue.append(id)
    }

    public mutating func leave(_ id: ID) {
        queue.removeAll { $0 == id }
    }

    /// Whether `id` is one of the first `limit` in the queue.
    public func moves(_ id: ID) -> Bool {
        guard let index = queue.firstIndex(of: id) else { return false }
        return index < limit
    }
}
