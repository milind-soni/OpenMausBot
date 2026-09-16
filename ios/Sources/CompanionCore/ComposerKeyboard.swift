import Foundation

/// Identifies the edit proposed by the software keyboard's Return key in a
/// vertically growing SwiftUI TextField. `.submitLabel(.send)` changes the
/// key's artwork but does not make that field submit; iOS still proposes a
/// newline. Keeping the classifier outside the view makes that behavior
/// deterministic and testable without a simulator keyboard.
public enum ComposerKeyboard {
    public static func shouldSubmit(previousText: String, proposedText: String) -> Bool {
        let changes = proposedText.difference(from: previousText)
        var insertedLineBreaks = 0

        for change in changes {
            guard case let .insert(_, character, _) = change else { continue }
            guard isLineBreak(character) else { return false }
            insertedLineBreaks += 1
        }
        return insertedLineBreaks == 1
    }

    private static func isLineBreak(_ character: Character) -> Bool {
        // A bound CharacterSet.contains method reference misclassifies input in
        // optimized builds; keep the predicate as an explicit closure.
        !character.unicodeScalars.isEmpty
            && character.unicodeScalars.allSatisfy { CharacterSet.newlines.contains($0) }
    }
}
