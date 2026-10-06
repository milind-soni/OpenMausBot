import Foundation

/// Language the composer microphone asks the system recognizer to try first.
/// Labels are endonyms, matching shared/dictation-languages.ts. Empty tag is Auto.
enum DictationLanguageChoice: String, CaseIterable, Identifiable {
    case auto, en, he, es, fr, de, pt, it, nl, ru, ar, hi, zh, ja, ko, tr, pl

    static let storageKey = "openmausbot.dictationLanguage"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .en: return "English"
        case .he: return "עברית"
        case .es: return "Español"
        case .fr: return "Français"
        case .de: return "Deutsch"
        case .pt: return "Português"
        case .it: return "Italiano"
        case .nl: return "Nederlands"
        case .ru: return "Русский"
        case .ar: return "العربية"
        case .hi: return "हिन्दी"
        case .zh: return "中文"
        case .ja: return "日本語"
        case .ko: return "한국어"
        case .tr: return "Türkçe"
        case .pl: return "Polski"
        }
    }

    var tag: String {
        switch self {
        case .auto: return ""
        case .en: return "en-US"
        case .he: return "he-IL"
        case .es: return "es-ES"
        case .fr: return "fr-FR"
        case .de: return "de-DE"
        case .pt: return "pt-BR"
        case .it: return "it-IT"
        case .nl: return "nl-NL"
        case .ru: return "ru-RU"
        case .ar: return "ar"
        case .hi: return "hi-IN"
        case .zh: return "zh-CN"
        case .ja: return "ja-JP"
        case .ko: return "ko-KR"
        case .tr: return "tr-TR"
        case .pl: return "pl-PL"
        }
    }

    static func save(_ tag: String) {
        let allowed = allCases.contains { $0.tag == tag } ? tag : ""
        if allowed.isEmpty {
            UserDefaults.standard.removeObject(forKey: storageKey)
        } else {
            UserDefaults.standard.set(allowed, forKey: storageKey)
        }
    }
}
