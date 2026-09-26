// The platform half of the gesture layer: real fingers in, TouchSamples out.
//
// It makes no decisions. Whether a tap is a double click, whether a drag is a
// scroll or a selection, where the cursor ends up — all of that lives in
// CompanionCore's GestureCore, which is testable without a simulator. This
// file exists to feed it and to drive its clock.
import CompanionCore
import SwiftUI
import UIKit

/// Drives `GestureCore` from UIKit and reports what it produces.
///
/// The core is a value type, so the coordinator owns the single mutable copy
/// and every callback goes through it.
struct BrowserTouchSurface: UIViewRepresentable {
    @Binding var mode: GestureMode
    let driving: Bool
    let frameWidth: Double
    let frameHeight: Double
    /// Intents the core produced, already in normalised remote coordinates.
    let onIntents: ([GestureIntent]) -> Void
    /// Local view state the SwiftUI side draws: zoom, pan and the cursor.
    let onViewState: (ViewTransform, RemotePoint) -> Void
    /// Handed back on creation so the screen can release held buttons when it
    /// leaves or the app backgrounds. Without a call site, `flush()` existed
    /// and never ran, and a drag interrupted that way left the button down on
    /// the remote with nothing to lift it.
    let onReady: (Coordinator) -> Void

    func makeUIView(context: Context) -> TouchSurfaceView {
        let view = TouchSurfaceView()
        view.coordinator = context.coordinator
        view.isMultipleTouchEnabled = true
        view.backgroundColor = .clear
        context.coordinator.attach(to: view)
        onReady(context.coordinator)
        return view
    }

    func updateUIView(_ view: TouchSurfaceView, context: Context) {
        context.coordinator.update(
            mode: mode, driving: driving,
            frameWidth: frameWidth, frameHeight: frameHeight,
            viewSize: view.bounds.size
        )
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onIntents: onIntents, onViewState: onViewState)
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private var core = GestureCore(
            mode: .direct,
            mapping: ViewportMapping(
                viewWidth: 1, viewHeight: 1, frameWidth: 1280, frameHeight: 720, transform: .identity
            )
        )
        private let onIntents: ([GestureIntent]) -> Void
        private let onViewState: (ViewTransform, RemotePoint) -> Void
        private var displayLink: CADisplayLink?
        /// The one finger the core is tracking. A second touch cancels it:
        /// two fingers mean zoom or pan, which the core does not see as touches.
        private var trackedTouch: ObjectIdentifier?
        private var startTime: CFTimeInterval = CACurrentMediaTime()

        init(
            onIntents: @escaping ([GestureIntent]) -> Void,
            onViewState: @escaping (ViewTransform, RemotePoint) -> Void
        ) {
            self.onIntents = onIntents
            self.onViewState = onViewState
        }

        deinit { displayLink?.invalidate() }

        func attach(to view: TouchSurfaceView) {
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch))
            pinch.delegate = self
            view.addGestureRecognizer(pinch)

            let twoFinger = UIPanGestureRecognizer(target: self, action: #selector(handleTwoFingerPan))
            twoFinger.minimumNumberOfTouches = 2
            twoFinger.maximumNumberOfTouches = 2
            twoFinger.delegate = self
            view.addGestureRecognizer(twoFinger)

            // The core has no clock; a long press only becomes observable when
            // something tells it time moved, and momentum only decays then.
            let link = CADisplayLink(target: self, selector: #selector(step))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }

        func update(mode: GestureMode, driving: Bool, frameWidth: Double, frameHeight: Double, viewSize: CGSize) {
            core.mode = mode
            core.driving = driving
            guard viewSize.width > 0, viewSize.height > 0 else { return }
            core.mapping = ViewportMapping(
                viewWidth: Double(viewSize.width),
                viewHeight: Double(viewSize.height),
                frameWidth: max(frameWidth, 1),
                frameHeight: max(frameHeight, 1),
                transform: core.transform
            )
        }

        /// Releases whatever the remote is holding. Called when the view goes
        /// away or control is handed back.
        func flush() {
            emit(core.flush())
        }

        private var now: Double { CACurrentMediaTime() - startTime }

        private func emit(_ intents: [GestureIntent]) {
            if !intents.isEmpty { onIntents(intents) }
            onViewState(core.transform, core.cursor)
        }

        @objc private func step() {
            emit(core.tick(at: now))
        }

        @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
            guard recognizer.numberOfTouches == 2 else { return }
            let centre = recognizer.location(in: recognizer.view)
            core.pinch(scale: Double(recognizer.scale), centreX: Double(centre.x), centreY: Double(centre.y))
            recognizer.scale = 1
            emit([])
        }

        @objc private func handleTwoFingerPan(_ recognizer: UIPanGestureRecognizer) {
            let translation = recognizer.translation(in: recognizer.view)
            recognizer.setTranslation(.zero, in: recognizer.view)

            switch core.mode {
            case .direct:
                // Direct mode is a touchscreen: two fingers move your view of
                // the page, and one finger moves the page.
                core.pan(dx: Double(translation.x), dy: Double(translation.y))
                emit([])
            case .trackpad:
                // Trackpad mode is a laptop: two fingers scroll the content.
                guard core.driving, core.mapping.viewWidth > 0, core.mapping.viewHeight > 0 else { return }
                emit([.scroll(
                    dx: -Double(translation.x) / core.mapping.viewWidth,
                    dy: -Double(translation.y) / core.mapping.viewHeight
                )])
            }
        }

        // MARK: - Raw touches

        func touchesBegan(_ touches: Set<UITouch>, in view: UIView) {
            // A second finger means the gesture recognizers have it; the core
            // must let go of the first rather than track half a pinch.
            if trackedTouch != nil || touches.count > 1 {
                emit(core.flush())
                trackedTouch = nil
                return
            }
            guard let touch = touches.first else { return }
            trackedTouch = ObjectIdentifier(touch)
            emit(core.handle(sample(touch, .began, in: view)))
        }

        func touchesMoved(_ touches: Set<UITouch>, in view: UIView) {
            guard let touch = tracked(in: touches) else { return }
            emit(core.handle(sample(touch, .moved, in: view)))
        }

        func touchesEnded(_ touches: Set<UITouch>, in view: UIView) {
            guard let touch = tracked(in: touches) else { return }
            trackedTouch = nil
            emit(core.handle(sample(touch, .ended, in: view)))
        }

        func touchesCancelled(_ touches: Set<UITouch>, in view: UIView) {
            guard let touch = tracked(in: touches) else { return }
            trackedTouch = nil
            emit(core.handle(sample(touch, .cancelled, in: view)))
        }

        private func tracked(in touches: Set<UITouch>) -> UITouch? {
            touches.first { ObjectIdentifier($0) == trackedTouch }
        }

        private func sample(_ touch: UITouch, _ phase: TouchPhase, in view: UIView) -> TouchSample {
            let point = touch.location(in: view)
            return TouchSample(
                id: abs(ObjectIdentifier(touch).hashValue % 100_000),
                phase: phase,
                x: Double(point.x),
                y: Double(point.y),
                t: now
            )
        }

        // Pinch and two-finger pan are one continuous gesture to the person,
        // so they must be allowed to run together.
        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }
}

/// A plain view that forwards raw touches. Subclassing is the only way to see
/// them without a recognizer deciding first what they mean.
final class TouchSurfaceView: UIView {
    weak var coordinator: BrowserTouchSurface.Coordinator?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        coordinator?.touchesBegan(touches, in: self)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        coordinator?.touchesMoved(touches, in: self)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        coordinator?.touchesEnded(touches, in: self)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        coordinator?.touchesCancelled(touches, in: self)
    }
}
