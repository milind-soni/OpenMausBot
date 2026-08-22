// The cloud provider's noVNC viewer, kept inside the app without teaching
// OpenMausMobile how to speak VNC or retain the provider's session token.
// SFSafariViewController supplies a hardened browser, WebSocket support and
// its own visible origin; dismissing it discards our only reference to the
// freshly minted URL.
import SafariServices
import SwiftUI

struct CloudDesktopBrowser: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        configuration.barCollapsingEnabled = true
        let browser = SFSafariViewController(url: url, configuration: configuration)
        browser.dismissButtonStyle = .close
        browser.preferredControlTintColor = .systemBlue
        return browser
    }

    func updateUIViewController(_ browser: SFSafariViewController, context: Context) {}
}
