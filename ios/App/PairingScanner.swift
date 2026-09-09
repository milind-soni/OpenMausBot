// Native QR scanning for the one action where typing is needless friction.
//
// The scanner only recognizes QR codes and never pairs by itself. A valid
// payload is returned to PairingView, which shows the computer name and
// address for explicit confirmation. That mirrors T3 Code's production rule:
// an attacker-controlled deep link or QR may prefill a target, but it cannot
// silently authorize that target.
import AVFoundation
import SwiftUI
import UIKit
import VisionKit

struct PairingScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    /// Return nil to accept and close, or a human-readable validation error
    /// to keep scanning. The one-time credential never lives in this view.
    let validate: (String) -> LocalizedStringKey?

    @State private var cameraAuthorized = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    @State private var permissionResolved = AVCaptureDevice.authorizationStatus(for: .video) != .notDetermined
    @State private var validationError: LocalizedStringKey?

    var body: some View {
        NavigationStack {
            Group {
                if !permissionResolved {
                    ProgressView("Requesting camera access…")
                } else if !cameraAuthorized {
                    ContentUnavailableView {
                        Label("Camera access needed", systemImage: "camera.fill")
                    } description: {
                        Text("Allow camera access to scan the pairing QR code shown by OpenMausBot.")
                    } actions: {
                        Button("Open Settings") {
                            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                            UIApplication.shared.open(url)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else if !DataScannerViewController.isSupported || !DataScannerViewController.isAvailable {
                    ContentUnavailableView {
                        Label("Scanner unavailable", systemImage: "qrcode.viewfinder")
                    } description: {
                        Text("Use the Camera app to scan the QR code, or enter the address and code manually.")
                    }
                } else {
                    ZStack(alignment: .bottom) {
                        PairingQRScanner { payload in
                            if let error = validate(payload) {
                                validationError = error
                                return false
                            }
                            dismiss()
                            return true
                        }
                        .ignoresSafeArea(edges: .bottom)

                        VStack(spacing: 8) {
                            Text(validationError ?? "Point the camera at the QR code on your computer")
                                .font(.subheadline.weight(.medium))
                                .multilineTextAlignment(.center)
                                .foregroundStyle(validationError == nil ? Color.primary : Color.red)
                        }
                        .padding(.horizontal, 18)
                        .padding(.vertical, 14)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                        .padding()
                    }
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await resolveCameraPermission() }
            .onChange(of: scenePhase) { _, phase in
                // If access was granted in Settings, recover immediately when
                // the user returns instead of requiring the sheet to reopen.
                if phase == .active {
                    Task { await resolveCameraPermission() }
                }
            }
        }
    }

    private func resolveCameraPermission() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraAuthorized = true
            permissionResolved = true
        case .notDetermined:
            cameraAuthorized = await AVCaptureDevice.requestAccess(for: .video)
            permissionResolved = true
        case .denied, .restricted:
            cameraAuthorized = false
            permissionResolved = true
        @unknown default:
            cameraAuthorized = false
            permissionResolved = true
        }
    }
}

private struct PairingQRScanner: UIViewControllerRepresentable {
    let onPayload: (String) -> Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(onPayload: onPayload)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        DispatchQueue.main.async {
            try? controller.startScanning()
        }
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        context.coordinator.onPayload = onPayload
        if !controller.isScanning {
            try? controller.startScanning()
        }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onPayload: (String) -> Bool
        private var locked = false

        init(onPayload: @escaping (String) -> Bool) {
            self.onPayload = onPayload
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !locked else { return }
            guard let first = addedItems.first,
                  case let .barcode(barcode) = first,
                  let payload = barcode.payloadStringValue
            else { return }

            locked = true
            if !onPayload(payload) {
                // A camera reports the same QR on many consecutive frames.
                // Give the error time to be read before allowing a retry.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                    self?.locked = false
                }
            }
        }
    }
}
