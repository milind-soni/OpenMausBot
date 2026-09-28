import Foundation

/// A bounded view of the newest reasoning, retaining absolute step numbers.
public struct ReasoningWindow {
    public struct Step: Identifiable {
        public let number: Int
        public let text: String
        public var id: Int { number }
    }

    public let steps: [Step]
    public let total: Int

    public init(_ reasoning: String, characterLimit: Int = 2_000) {
        let lines = reasoning.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        total = lines.count
        var window: [Step] = []
        var remaining = max(0, characterLimit)
        for (index, line) in lines.enumerated().reversed() {
            guard remaining > 0 else { break }
            if line.count > remaining {
                // A single unbroken paragraph must not bypass the render cap.
                if window.isEmpty {
                    window.append(Step(number: index + 1, text: "…" + line.suffix(remaining - 1)))
                }
                break
            }
            window.append(Step(number: index + 1, text: line))
            remaining -= line.count
        }
        steps = window.reversed()
    }
}
