#if DEBUG
import Foundation

/// Offline UI fixture: intercept every request so this preview cannot dial a computer.
final class VoicePreviewProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard request.httpMethod == "GET",
              request.url?.path == "/api/attachments/preview-voice-note.mp3",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer voice-fixture-token",
              let url = Bundle.main.url(forResource: "VoiceNotePreview", withExtension: "mp3"),
              let data = try? Data(contentsOf: url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "audio/mpeg"
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
