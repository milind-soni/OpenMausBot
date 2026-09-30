//
//  SwipeBackBridge.swift
//  OpenMausCompanion
//
//  The system's edge-swipe back gesture does not belong to SwiftUI: it is the
//  interactivePopGestureRecognizer on the UIKit navigation controller that
//  hosts every NavigationStack, and it is wired to that controller's
//  navigation bar. Hiding the bar — which ChatView does to draw its own
//  header — drops the recognizer's delegate, and a swipe from the left edge
//  stops doing anything on exactly the screen people spend their day on.
//
//  The gesture itself is fine; only the wiring went away. This bridge rides
//  along inside ChatView, finds the hosting navigation controller at the
//  moment the screen appears, and answers the one question UIKit asks of a
//  gesture delegate — "should this begin?" — the way the system would if the
//  bar were visible: yes whenever there is something to pop back to. The
//  custom Back button, push transitions, and screens deeper in the stack are
//  untouched.
//

import SwiftUI
import ObjectiveC

struct SwipeBackBridge: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Host {
        Host()
    }

    func updateUIViewController(_ controller: Host, context: Context) {}

    /// A clear, non-interacting controller whose only job is to be embedded
    /// in the stack so it can reach the controller that owns the gesture.
    final class Host: UIViewController {
        override func loadView() {
            let view = UIView()
            view.backgroundColor = .clear
            view.isUserInteractionEnabled = false
            self.view = view
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            SwipeBackArm.arm(from: self)
        }
    }
}

private enum SwipeBackArm {
    private static var key: UInt8 = 0

    static func arm(from controller: UIViewController) {
        guard let navigation = controller.navigationController,
              let recognizer = navigation.interactivePopGestureRecognizer
        else { return }
        // The delegate must outlive this screen: it keeps answering for the
        // recognizer after the chat pops, including "no" at the root. Parking
        // it on the navigation controller also makes re-arming idempotent —
        // this screen appears again on every visit, and the language switch
        // rebuilds the whole stack with a fresh controller.
        var delegate = objc_getAssociatedObject(navigation, &key) as? PopDelegate
        if delegate == nil {
            delegate = PopDelegate(navigation: navigation)
            objc_setAssociatedObject(navigation, &key, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
        recognizer.delegate = delegate
        recognizer.isEnabled = true
    }
}

/// Refusing to begin at the root is load-bearing. Letting the recognizer
/// start with nothing left to pop is the classic way this workaround freezes
/// a navigation stack, so the answer is strictly tied to the stack depth.
private final class PopDelegate: NSObject, UIGestureRecognizerDelegate {
    private weak var navigation: UINavigationController?

    init(navigation: UINavigationController) {
        self.navigation = navigation
        super.init()
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        (navigation?.viewControllers.count ?? 1) > 1
    }
}
