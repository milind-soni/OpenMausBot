// Small shims so the app runs on iOS 16.
//
// The oldest iPhones that people still carry — the X, the 8, the 7 — stop at
// iOS 16 and can never move past it. Three SwiftUI things we lean on landed in
// 17, and ActivityKit landed in 16.1/16.2, so each one is bridged here rather
// than sprinkling `#available` through every view.
import AVFoundation
import SwiftUI

extension View {
    /// `onChange(of:_:)` with the iOS 17 two-value closure, back-ported.
    ///
    /// Call sites only ever read the new value, so the shim hands that over
    /// and nothing else. On 16 this is the old single-value `onChange`, which
    /// fires on exactly the same edges.
    @ViewBuilder
    func onValueChange<V: Equatable>(
        of value: V,
        initial: Bool = false,
        perform action: @escaping (V) -> Void
    ) -> some View {
        if #available(iOS 17.0, *) {
            onChange(of: value, initial: initial) { _, newValue in action(newValue) }
        } else if initial {
            onChange(of: value) { newValue in action(newValue) }
                .onAppear { action(value) }
        } else {
            onChange(of: value) { newValue in action(newValue) }
        }
    }
}

/// `ContentUnavailableView` for iOS 16.
///
/// The 17 version is used where it exists, so on current phones this is the
/// system layout, spacing and colour. On 16 it is a plain centred stack, which
/// is what the system view looks like anyway.
struct EmptyStateView<Actions: View>: View {
    let title: String
    let systemImage: String
    var description: Text?
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        if #available(iOS 17.0, *) {
            ContentUnavailableView {
                Label(title, systemImage: systemImage)
            } description: {
                description
            } actions: {
                actions()
            }
        } else {
            VStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 44, weight: .regular))
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                description?
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                actions()
                    .padding(.top, 4)
            }
            .padding(24)
            .frame(maxWidth: .infinity)
        }
    }
}

extension EmptyStateView where Actions == EmptyView {
    init(_ title: String, systemImage: String, description: Text? = nil) {
        self.init(title: title, systemImage: systemImage, description: description) { EmptyView() }
    }

    /// The stand-in for `ContentUnavailableView.search(text:)`.
    static func search(text: String) -> EmptyStateView<EmptyView> {
        EmptyStateView<EmptyView>(
            String(localized: "No Results"),
            systemImage: "magnifyingglass",
            description: Text("No results for “\(text)”.")
        )
    }
}

enum MicrophonePermission {
    /// `AVAudioApplication.requestRecordPermission()` arrived in iOS 17; the
    /// session-based call it replaced still works below that.
    static func request() async -> Bool {
        if #available(iOS 17.0, *) {
            return await AVAudioApplication.requestRecordPermission()
        }
        return await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
    }
}

/// The three `sensoryFeedback` kinds the app uses, so call sites stay
/// declarative on iOS 16 too.
enum FeedbackKind {
    case selection, warning, success

    fileprivate func play() {
        switch self {
        case .selection:
            UISelectionFeedbackGenerator().selectionChanged()
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
    }
}

extension View {
    /// `sensoryFeedback(_:trigger:)` back-ported.
    ///
    /// Same contract: the haptic fires when `trigger` changes. Below 17 the
    /// generators are driven by hand, which is what the modifier does anyway.
    @ViewBuilder
    func feedback<T: Equatable>(_ kind: FeedbackKind, trigger: T) -> some View {
        if #available(iOS 17.0, *) {
            switch kind {
            case .selection: sensoryFeedback(.selection, trigger: trigger)
            case .warning: sensoryFeedback(.warning, trigger: trigger)
            case .success: sensoryFeedback(.success, trigger: trigger)
            }
        } else {
            onValueChange(of: trigger) { _ in kind.play() }
        }
    }
}

extension View {
    /// `selectionDisabled(_:)` back-ported.
    ///
    /// It marks a List row as not selectable, which iOS 16 has no equivalent
    /// for. There the row stays selectable and the screen's own guards decide
    /// what a tap does, which is the pre-17 behaviour the app already had.
    @ViewBuilder
    func rowSelectionDisabled(_ disabled: Bool = true) -> some View {
        if #available(iOS 17.0, *) {
            selectionDisabled(disabled)
        } else {
            self
        }
    }
}

extension View {
    /// The sheet's material background and rounded corners are iOS 16.4.
    /// Below that the sheet keeps the system's own chrome, which is the same
    /// shape, just opaque.
    @ViewBuilder
    func sheetChromeCompat() -> some View {
        if #available(iOS 16.4, *) {
            presentationBackground(.thinMaterial)
                .presentationCornerRadius(28)
        } else {
            self
        }
    }

    /// The repeating pulse on a symbol is iOS 17. Below that the symbol simply
    /// sits still; it marks activity that the surrounding view already states
    /// in words.
    @ViewBuilder
    func pulseCompat(isActive: Bool) -> some View {
        if #available(iOS 17.0, *) {
            symbolEffect(.pulse, options: .repeating, isActive: isActive)
        } else {
            self
        }
    }
}

extension View {
    /// `defaultScrollAnchor(_:)` is iOS 17. Below that the scroll view starts
    /// at the top and the screens that need the bottom scroll there
    /// themselves once content lands.
    @ViewBuilder
    func scrollAnchorCompat(_ anchor: UnitPoint) -> some View {
        if #available(iOS 17.0, *) {
            defaultScrollAnchor(anchor)
        } else {
            self
        }
    }
}

/// `onChange` when the call site needs the old value too.
///
/// iOS 16's `onChange` hands over only the new one, so the previous value is
/// kept here and replayed in the iOS 17 order.
private struct OnValueChangePair<V: Equatable>: ViewModifier {
    let value: V
    let action: (V, V) -> Void
    @State private var previous: V?

    func body(content: Content) -> some View {
        content
            .onAppear { if previous == nil { previous = value } }
            .onValueChange(of: value) { newValue in
                let old = previous ?? newValue
                previous = newValue
                action(old, newValue)
            }
    }
}

extension View {
    func onValueChangePair<V: Equatable>(
        of value: V,
        perform action: @escaping (V, V) -> Void
    ) -> some View {
        modifier(OnValueChangePair(value: value, action: action))
    }

    /// `scrollClipDisabled()` is iOS 17. Below it the scroll view clips its
    /// content to its bounds, which costs a shadow spilling past the edge.
    @ViewBuilder
    func scrollClipDisabledCompat() -> some View {
        if #available(iOS 17.0, *) {
            scrollClipDisabled()
        } else {
            self
        }
    }

    /// Hardware-keyboard Return handling, which is `onKeyPress` on iOS 17.
    /// There is no pre-17 equivalent for a SwiftUI text field, so on 16 a
    /// hardware Return just inserts a newline like the software one.
    @ViewBuilder
    func onHardwareReturn(_ action: @escaping () -> Void) -> some View {
        if #available(iOS 17.0, *) {
            onKeyPress(.return, phases: .down) { press in
                if press.modifiers.contains(.shift) { return .ignored }
                action()
                return .handled
            }
        } else {
            self
        }
    }
}
