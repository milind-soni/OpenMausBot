// Driving a bot's Local VM from the phone: the live desktop on top, a
// trackpad beneath it, and a keyboard on demand.
//
// The pointer moves relatively, like a laptop trackpad, rather than jumping
// to wherever a finger lands on the picture: the desktop is drawn at a
// fraction of its size, and a fingertip covers several of its controls at
// once. One finger moves, a tap clicks, two fingers tapping right-click, a
// hold then a move drags, and two fingers moving scroll.
import CompanionCore
import SwiftUI
import UIKit

struct LocalVmControlView: View {
    let botName: String
    @ObservedObject var desktop: LocalVmDesktop
    let handBack: () -> Void

    @State private var typing = false

    var body: some View {
        VStack(spacing: 14) {
            header
            screen
                .frame(maxHeight: .infinity)
            Trackpad(desktop: desktop)
                .frame(height: 230)
                .overlay {
                    VStack(spacing: 6) {
                        Capsule().fill(Color.white.opacity(0.35)).frame(width: 36, height: 4)
                        Text("Trackpad")
                            .font(.system(size: 15, weight: .semibold))
                        Text("Swipe to move · Tap to click · Hold to drag")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.white.opacity(0.6))
                    }
                    .foregroundStyle(Color.white.opacity(0.85))
                    .allowsHitTesting(false)
                }
                .accessibilityElement()
                .accessibilityLabel("Trackpad")
                .accessibilityHint("Swipe to move the pointer, tap to click, hold to drag")
            // Holds first responder while typing; invisible.
            KeyCatcher(active: $typing, desktop: desktop)
                .frame(width: 1, height: 1)
                .opacity(0.01)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button("Hand Back", action: handBack)
                .font(.system(size: 16, weight: .medium))
                .padding(.horizontal, 16)
                .frame(height: 44)
                .glassCapsule()
                .accessibilityHint("Gives the computer back to the bot")

            Spacer(minLength: 4)
            VStack(spacing: 2) {
                Text(botName)
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(1)
                Text("Local VM")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)

            HStack(spacing: 0) {
                Button {
                    typing.toggle()
                } label: {
                    Image(systemName: typing ? "keyboard.chevron.compact.down" : "keyboard")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(typing ? "Hide keyboard" : "Show keyboard")

                Menu {
                    Button("Escape") { desktop.press([RFBKey.escape]) }
                    Button("Tab") { desktop.press([RFBKey.tab]) }
                    Button("Right click") { desktop.click(.right) }
                    Button("Copy (Ctrl+C)") { desktop.press([RFBKey.control, 0x63]) }
                    Button("Paste (Ctrl+V)") { desktop.press([RFBKey.control, 0x76]) }
                    Button("Select all (Ctrl+A)") { desktop.press([RFBKey.control, 0x61]) }
                    Button("Ctrl+Alt+Del") { desktop.press([RFBKey.control, RFBKey.alt, RFBKey.delete]) }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("More keys")
            }
            .padding(.horizontal, 4)
            .glassCapsule()
        }
        .foregroundStyle(Color.primary)
    }

    private var screen: some View {
        GeometryReader { proxy in
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.white.opacity(0.06))
                switch desktop.phase {
                case .connecting:
                    ProgressView("Connecting to the Local VM…")
                        .tint(.white)
                case let .failed(reason):
                    VStack(spacing: 8) {
                        Image(systemName: "display.trianglebadge.exclamationmark")
                            .font(.system(size: 26))
                        Text("The desktop disconnected")
                            .font(.system(size: 15, weight: .semibold))
                        Text(verbatim: reason)
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(24)
                case .live:
                    if let image = desktop.image {
                        let fitted = fit(desktop.desktopSize, in: proxy.size)
                        Image(decorative: image, scale: 1)
                            .resizable()
                            .interpolation(.medium)
                            .frame(width: fitted.width, height: fitted.height)
                            .overlay(alignment: .topLeading) {
                                pointer
                                    .position(
                                        x: desktop.cursor.x / max(desktop.desktopSize.width, 1) * fitted.width,
                                        y: desktop.cursor.y / max(desktop.desktopSize.height, 1) * fitted.height
                                    )
                            }
                            .accessibilityLabel("\(botName)'s Local VM")
                    } else {
                        ProgressView().tint(.white)
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }

    /// A ring rather than an arrow: it says where a click will land without
    /// pretending to be the desktop's own cursor.
    private var pointer: some View {
        ZStack {
            Circle().strokeBorder(Color.white, lineWidth: 2).frame(width: 22, height: 22)
            Circle().fill(Color.white).frame(width: 5, height: 5)
        }
        .shadow(color: .black.opacity(0.6), radius: 2)
        .allowsHitTesting(false)
    }

    private func fit(_ size: CGSize, in bounds: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return .zero }
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }
}

/// The trackpad's gestures, in UIKit, where one- and two-finger pans and taps
/// and a hold-to-drag can coexist with explicit priorities.
private struct Trackpad: UIViewRepresentable {
    let desktop: LocalVmDesktop

    func makeCoordinator() -> Coordinator { Coordinator(desktop: desktop) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = UIColor.white.withAlphaComponent(0.1)
        view.layer.cornerRadius = 22
        view.layer.cornerCurve = .continuous
        view.layer.borderWidth = 0.5
        view.layer.borderColor = UIColor.white.withAlphaComponent(0.15).cgColor
        let coordinator = context.coordinator

        let move = UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.move(_:)))
        move.maximumNumberOfTouches = 1
        let scroll = UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.scroll(_:)))
        scroll.minimumNumberOfTouches = 2
        scroll.maximumNumberOfTouches = 2
        let click = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.click(_:)))
        let rightClick = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.rightClick(_:)))
        rightClick.numberOfTouchesRequired = 2
        let drag = UILongPressGestureRecognizer(target: coordinator, action: #selector(Coordinator.drag(_:)))
        drag.minimumPressDuration = 0.35
        drag.allowableMovement = 8

        // Holding still long enough is a drag, so a pan only moves once the
        // hold has failed.
        move.require(toFail: drag)
        for recognizer in [move, scroll, click, rightClick, drag] {
            recognizer.delegate = coordinator
            view.addGestureRecognizer(recognizer)
        }
        coordinator.trackpad = view
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let desktop: LocalVmDesktop
        weak var trackpad: UIView?
        private var lastMove = CGPoint.zero
        private var lastDrag = CGPoint.zero
        private var scrollCarry: CGFloat = 0

        init(desktop: LocalVmDesktop) { self.desktop = desktop }

        /// Desktop pixels per trackpad point: the pad spans the desktop's
        /// width in about one and a half swipes.
        @MainActor private var speed: CGFloat {
            let width = max(trackpad?.bounds.width ?? 1, 1)
            return max(desktop.desktopSize.width / width * 0.75, 1)
        }

        @MainActor @objc func move(_ recognizer: UIPanGestureRecognizer) {
            let point = recognizer.translation(in: recognizer.view)
            if recognizer.state == .began { lastMove = .zero }
            let delta = CGSize(width: (point.x - lastMove.x) * speed, height: (point.y - lastMove.y) * speed)
            lastMove = point
            desktop.move(by: delta)
        }

        @MainActor @objc func scroll(_ recognizer: UIPanGestureRecognizer) {
            if recognizer.state == .began { scrollCarry = 0 }
            let velocity = recognizer.translation(in: recognizer.view).y
            recognizer.setTranslation(.zero, in: recognizer.view)
            // Natural scrolling: fingers up moves the content up (wheel down).
            scrollCarry -= velocity
            let notch: CGFloat = 18
            let notches = Int(scrollCarry / notch)
            if notches != 0 {
                scrollCarry -= CGFloat(notches) * notch
                desktop.scroll(notches: notches)
            }
        }

        @MainActor @objc func click(_ recognizer: UITapGestureRecognizer) {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            desktop.click(.left)
        }

        @MainActor @objc func rightClick(_ recognizer: UITapGestureRecognizer) {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            desktop.click(.right)
        }

        @MainActor @objc func drag(_ recognizer: UILongPressGestureRecognizer) {
            let point = recognizer.location(in: recognizer.view)
            switch recognizer.state {
            case .began:
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                lastDrag = point
                desktop.setDragging(true)
            case .changed:
                desktop.move(by: CGSize(width: (point.x - lastDrag.x) * speed, height: (point.y - lastDrag.y) * speed))
                lastDrag = point
            default:
                desktop.setDragging(false)
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { false }
    }
}

/// An invisible first responder that turns the system keyboard into key
/// events: typed characters, Return, and Backspace.
private struct KeyCatcher: UIViewRepresentable {
    @Binding var active: Bool
    let desktop: LocalVmDesktop

    func makeUIView(context: Context) -> KeyInputView {
        let view = KeyInputView()
        view.desktop = desktop
        view.onResign = { context.coordinator.resigned() }
        return view
    }

    func updateUIView(_ view: KeyInputView, context: Context) {
        context.coordinator.binding = $active
        if active, !view.isFirstResponder { view.becomeFirstResponder() }
        if !active, view.isFirstResponder { view.resignFirstResponder() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(binding: $active) }

    final class Coordinator {
        var binding: Binding<Bool>
        init(binding: Binding<Bool>) { self.binding = binding }
        func resigned() { if binding.wrappedValue { binding.wrappedValue = false } }
    }

    final class KeyInputView: UIView, UIKeyInput {
        weak var desktop: LocalVmDesktop?
        var onResign: (() -> Void)?

        override var canBecomeFirstResponder: Bool { true }
        var hasText: Bool { true }
        var autocorrectionType: UITextAutocorrectionType = .no
        var autocapitalizationType: UITextAutocapitalizationType = .none
        var smartQuotesType: UITextSmartQuotesType = .no
        var smartDashesType: UITextSmartDashesType = .no
        var spellCheckingType: UITextSpellCheckingType = .no
        var keyboardType: UIKeyboardType = .asciiCapable

        func insertText(_ text: String) {
            MainActor.assumeIsolated { desktop?.type(text) }
        }

        func deleteBackward() {
            MainActor.assumeIsolated { desktop?.press([RFBKey.backspace]) }
        }

        override func resignFirstResponder() -> Bool {
            let resigned = super.resignFirstResponder()
            if resigned { onResign?() }
            return resigned
        }
    }
}
