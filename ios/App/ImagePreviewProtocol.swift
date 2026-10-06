#if DEBUG
import Foundation
import UIKit

/// Offline UI fixture: intercept every request so this preview cannot dial a computer.
final class ImagePreviewProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                body.append(contentsOf: bytes.prefix(count))
            }
        }
        let payload = (try? JSONSerialization.jsonObject(with: body)) as? [String: String]
        if request.httpMethod == "POST",
           request.url?.path.hasPrefix("/api/threads/preview-images/messages/") == true,
           request.url?.lastPathComponent == "file",
           request.value(forHTTPHeaderField: "Authorization") == "Bearer image-fixture-token",
           let path = payload?["path"],
           let shape = Self.shapeImage(path) {
            respond(with: shape, filename: (path as NSString).lastPathComponent)
            return
        }
        guard request.httpMethod == "POST",
              request.url?.path == "/api/threads/preview-gmail/messages/preview-gmail-reply/file",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer image-fixture-token",
              payload?["path"] == "/fixture/screenshot.png",
              let url = Bundle.main.url(forResource: "ImagePreview", withExtension: "png"),
              let data = try? Data(contentsOf: url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "image/png", "Content-Disposition": "attachment; filename=screenshot.png"
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func respond(with data: Data, filename: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "image/png", "Content-Disposition": "attachment; filename=\(filename)"
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    /// The image-shapes chat asks for `/fixture/shape/<width>x<height>/<name>.png`
    /// and gets a picture of exactly that size, framed and labelled at every
    /// corner — so a screenshot shows at a glance whether the whole image is
    /// on screen or a crop of it.
    private static func shapeImage(_ path: String) -> Data? {
        let parts = path.split(separator: "/")
        guard parts.count == 4, parts[0] == "fixture", parts[1] == "shape" else { return nil }
        let size = parts[2].split(separator: "x").compactMap { Int($0) }
        guard size.count == 2, (1...4_000).contains(size[0]), (1...4_000).contains(size[1]) else { return nil }
        let width = CGFloat(size[0]), height = CGFloat(size[1])
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.pngData { context in
            let cg = context.cgContext
            let colors = [UIColor.systemIndigo.cgColor, UIColor.systemTeal.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: width, y: height), options: [])
            }
            let edge = min(width, height)
            let border = max(4, edge * 0.03)
            cg.setStrokeColor(UIColor.systemRed.cgColor)
            cg.setLineWidth(border)
            cg.stroke(CGRect(x: 0, y: 0, width: width, height: height).insetBy(dx: border / 2, dy: border / 2))
            let mark = max(12, edge * 0.12)
            cg.setFillColor(UIColor.systemYellow.cgColor)
            for corner in [CGPoint(x: 0, y: 0), CGPoint(x: width - mark, y: 0),
                           CGPoint(x: 0, y: height - mark), CGPoint(x: width - mark, y: height - mark)] {
                cg.fill(CGRect(origin: corner, size: CGSize(width: mark, height: mark)))
            }
            let label = "\(size[0]) × \(size[1])" as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: max(12, min(edge * 0.28, width * 0.1)), weight: .bold),
                .foregroundColor: UIColor.white,
            ]
            let text = label.size(withAttributes: attributes)
            label.draw(at: CGPoint(x: (width - text.width) / 2, y: (height - text.height) / 2), withAttributes: attributes)
        }
    }
}
#endif
