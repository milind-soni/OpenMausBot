import Foundation

/// The update date and time shown on a thread row.
public enum ThreadStamp {
    /// Abbreviated date and short time in `timeZone`. The default is the
    /// operating system's zone and the reader's locale, so the same instant
    /// reads differently on a phone set to Tokyo and a Mac set to New York.
    public static func updated(
        _ at: Double,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> String {
        guard at > 0, at.isFinite else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        var style = Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)
        style.timeZone = timeZone
        return date.formatted(style)
    }
}
