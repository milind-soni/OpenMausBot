// The language the app draws itself in.
//
// English is the source catalog: every key in `Localizable.xcstrings` *is* the
// English literal from the Swift, so a key a translation omits falls back to
// copy that reads correctly rather than to a key name. A partial pack is a
// usable pack, which is the same contract `docs/localization.md` sets for the
// renderer.
//
// Adding a language is one case here and one column in the catalog. Nothing
// else in the app has to know.
import Foundation
import SwiftUI

enum AppLanguage: String, CaseIterable, Identifiable {
    /// Whatever the phone is set to, which is also what an app with no
    /// language setting at all would do.
    case system
    case english = "en"
    case portugueseBrazil = "pt-BR"

    var id: String { rawValue }

    var label: LocalizedStringKey {
        switch self {
        case .system: "Follow the system"
        // A language names itself. Someone who cannot read the language the app
        // is currently in still has to be able to find their own in this list,
        // so these two are marked `shouldTranslate: false` in the catalog.
        case .english: "English"
        case .portugueseBrazil: "Português (Brasil)"
        }
    }

    /// `nil` follows the system: the environment keeps the locale SwiftUI
    /// already handed it, so no choice here means no behaviour change.
    var locale: Locale? {
        self == .system ? nil : Locale(identifier: rawValue)
    }

    static func resolved(_ stored: String) -> AppLanguage {
        AppLanguage(rawValue: stored) ?? .system
    }
}
