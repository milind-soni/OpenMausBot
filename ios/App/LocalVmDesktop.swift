// A live connection to a bot's Local VM desktop: RFB over the sidecar's
// relayed WebSocket, and the pointer the trackpad moves.
//
// The protocol is RFBClient in CompanionCore; this owns the socket, turns the
// framebuffer into a picture, and keeps a cursor of its own, because the
// phone drives a pointer relatively, like a laptop trackpad, rather than
// tapping where it wants to click.
import CompanionCore
import CoreGraphics
import Foundation

@MainActor
final class LocalVmDesktop: ObservableObject {
    enum Phase: Equatable {
        case connecting
        case live
        case failed(String)
    }

    @Published private(set) var phase = Phase.connecting
    @Published private(set) var image: CGImage?
    /// Where the pointer is, in desktop pixels.
    @Published private(set) var cursor = CGPoint.zero
    @Published private(set) var desktopSize = CGSize.zero

    private let request: URLRequest
    private let rfb: RFBClient
    private var socket: URLSessionWebSocketTask?
    private var receiving: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?
    private var buttons: RFBButtons = []

    init(request: URLRequest, password: String?) {
        self.request = request
        rfb = RFBClient(password: password)
    }

    func start() {
        guard socket == nil else { return }
        let socket = URLSession.shared.webSocketTask(with: request)
        // A Local VM framebuffer arrives as one multi-megabyte update.
        socket.maximumMessageSize = 64 << 20
        self.socket = socket
        socket.resume()
        receiving = Task { [weak self] in await self?.receiveLoop(socket) }
        // A still desktop sends nothing, and an idle socket is one the
        // network is free to drop.
        keepAlive = Task { [weak socket] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                socket?.sendPing { _ in }
            }
        }
    }

    func stop() {
        receiving?.cancel()
        keepAlive?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    // MARK: - Input

    /// Move the pointer by a trackpad delta, already scaled to desktop pixels.
    func move(by delta: CGSize) {
        guard phase == .live else { return }
        cursor.x = min(max(0, cursor.x + delta.width), max(0, desktopSize.width - 1))
        cursor.y = min(max(0, cursor.y + delta.height), max(0, desktopSize.height - 1))
        sendPointer()
    }

    func click(_ button: RFBButtons = .left) {
        guard phase == .live else { return }
        rfb.pointer(x: Int(cursor.x), y: Int(cursor.y), buttons: buttons.union(button))
        rfb.pointer(x: Int(cursor.x), y: Int(cursor.y), buttons: buttons)
        flush()
    }

    /// Press or release the left button where the pointer is, for dragging.
    func setDragging(_ dragging: Bool) {
        guard phase == .live else { return }
        if dragging { buttons.insert(.left) } else { buttons.remove(.left) }
        sendPointer()
    }

    /// One wheel notch per call; positive `notches` scrolls down.
    func scroll(notches: Int) {
        guard phase == .live, notches != 0 else { return }
        let wheel: RFBButtons = notches > 0 ? .scrollDown : .scrollUp
        for _ in 0 ..< min(abs(notches), 10) {
            rfb.pointer(x: Int(cursor.x), y: Int(cursor.y), buttons: buttons.union(wheel))
            rfb.pointer(x: Int(cursor.x), y: Int(cursor.y), buttons: buttons)
        }
        flush()
    }

    func type(_ text: String) {
        guard phase == .live else { return }
        for character in text {
            if let keysym = RFBKey.keysym(for: character) { rfb.tap(keysym) }
        }
        flush()
    }

    /// Press `keys` in order and release them in reverse, as a chord.
    func press(_ keys: [UInt32]) {
        guard phase == .live else { return }
        for key in keys { rfb.key(key, down: true) }
        for key in keys.reversed() { rfb.key(key, down: false) }
        flush()
    }

    // MARK: - Socket

    private func sendPointer() {
        rfb.pointer(x: Int(cursor.x), y: Int(cursor.y), buttons: buttons)
        flush()
    }

    private func flush() {
        let data = rfb.takeOutgoing()
        guard !data.isEmpty, let socket else { return }
        socket.send(.data(data)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in self?.fail(error) }
        }
    }

    private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                let data: Data
                switch message {
                case let .data(bytes): data = bytes
                case let .string(text): data = Data(text.utf8)
                @unknown default: continue
                }
                try handle(rfb.receive(data))
                flush()
            }
        } catch {
            if !Task.isCancelled { fail(error) }
        }
    }

    private func handle(_ events: [RFBEvent]) {
        var redraw = false
        for event in events {
            switch event {
            case let .connected(width, height, _):
                desktopSize = CGSize(width: width, height: height)
                cursor = CGPoint(x: width / 2, y: height / 2)
                phase = .live
            case let .updated(resized):
                if resized {
                    desktopSize = CGSize(width: rfb.width, height: rfb.height)
                    cursor.x = min(cursor.x, max(0, desktopSize.width - 1))
                    cursor.y = min(cursor.y, max(0, desktopSize.height - 1))
                }
                redraw = true
            case .bell, .clipboard:
                break
            }
        }
        if redraw { image = Self.picture(rfb.framebuffer, width: rfb.width, height: rfb.height) }
    }

    private func fail(_ error: Error) {
        guard phase != .failed(error.localizedDescription) else { return }
        phase = .failed(error.localizedDescription)
        stop()
    }

    /// BGRX, little-endian 32-bit: exactly what the RFB client asked for.
    private static func picture(_ pixels: [UInt8], width: Int, height: Int) -> CGImage? {
        guard width > 0, height > 0, let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        )
    }
}
